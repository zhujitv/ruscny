import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const mocks = vi.hoisted(() => {
  const transaction = {
    $queryRaw: vi.fn(),
    emailVerificationToken: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    userPasswordResetToken: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    adminPasswordResetToken: { updateMany: vi.fn() },
    user: { update: vi.fn(), updateMany: vi.fn() },
    userDevice: { updateMany: vi.fn(), upsert: vi.fn() },
  };
  return {
    transaction,
    verifyPassword: vi.fn(),
    hashPassword: vi.fn(),
    sendVerification: vi.fn(),
    sendPasswordReset: vi.fn(),
    disconnectSubject: vi.fn(),
    prisma: {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
      user: { findUnique: vi.fn(), updateMany: vi.fn() },
      userDevice: { findUnique: vi.fn(), updateMany: vi.fn() },
      emailVerificationToken: { updateMany: vi.fn() },
      userPasswordResetToken: { updateMany: vi.fn() },
      glossaryTerm: { createMany: vi.fn() },
      systemSetting: { findUnique: vi.fn() },
    },
  };
});

vi.mock('../src/db.js', () => ({ prisma: mocks.prisma }));
vi.mock('../src/services/passwords.js', () => ({
  verifyPassword: mocks.verifyPassword,
  hashPassword: mocks.hashPassword,
}));
vi.mock('../src/services/account-emails.js', () => ({
  emailHint: (email: string) => `hidden:${email}`,
  emailVerificationTokenHash: (token: string) => `verify:${token}`,
  userPasswordResetTokenHash: (token: string) => `reset:${token}`,
  sendAccountVerificationEmail: mocks.sendVerification,
  sendAccountPasswordResetEmail: mocks.sendPasswordReset,
}));
vi.mock('../src/realtime-hub.js', () => ({
  realtimeHub: () => ({
    disconnectDevice: vi.fn(),
    disconnectSubject: mocks.disconnectSubject,
    disconnectParticipant: vi.fn(),
    emitToConversation: vi.fn(),
    emitToSubject: vi.fn(),
    isSubjectOnline: async () => false,
    isReady: () => true,
  }),
}));
vi.mock('../src/services/audio-assets.js', () => ({
  playableAudioUrl: (value: string | null) => value,
}));

import { AppError } from '../src/errors.js';
import { registerAuthRoutes } from '../src/routes/auth.js';

let app: FastifyInstance | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof mocks.transaction) => unknown) => callback(mocks.transaction),
  );
  mocks.prisma.systemSetting.findUnique.mockResolvedValue(null);
  mocks.verifyPassword.mockResolvedValue({ valid: true, needsUpgrade: false });
  mocks.hashPassword.mockResolvedValue('v2:replacement-hash');
  mocks.transaction.emailVerificationToken.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.userPasswordResetToken.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.adminPasswordResetToken.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.user.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.userDevice.updateMany.mockResolvedValue({ count: 2 });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function createApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  instance.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof AppError) {
      await reply.code(error.statusCode).send({ ok: false, code: error.code });
      return;
    }
    if (error instanceof ZodError) {
      await reply.code(400).send({ ok: false, code: 'VALIDATION_ERROR' });
      return;
    }
    throw error;
  });
  await registerAuthRoutes(instance);
  return instance;
}

describe('email account verification and password recovery', () => {
  it('blocks a correct password until the email is verified', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      id: 'user-a',
      role: 'USER',
      status: 'ACTIVE',
      displayName: 'Alice',
      email: 'alice@example.test',
      emailVerifiedAt: null,
      passwordHash: 'v2:current-hash',
    });
    app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'alice@example.test',
        password: 'password-123',
        deviceId: 'device-alice-a',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('EMAIL_NOT_VERIFIED');
    expect(mocks.transaction.userDevice.upsert).not.toHaveBeenCalled();
  });

  it('consumes an activation token once and marks the account verified', async () => {
    mocks.transaction.emailVerificationToken.findUnique.mockResolvedValue({
      id: 'verification-a',
      userId: 'user-a',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mocks.transaction.$queryRaw.mockResolvedValue([{
      id: 'user-a',
      status: 'ACTIVE',
      email: 'alice@example.test',
      emailVerifiedAt: null,
    }]);
    app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/verify',
      payload: { token: 'a'.repeat(32) },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.transaction.emailVerificationToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: `verify:${'a'.repeat(32)}` },
      select: expect.any(Object),
    });
    expect(mocks.transaction.user.update).toHaveBeenCalledWith({
      where: { id: 'user-a' },
      data: { emailVerifiedAt: expect.any(Date) },
    });
  });

  it('keeps forgot-password responses identical while emailing only an eligible account', async () => {
    app = await createApp();
    mocks.prisma.user.findUnique.mockResolvedValueOnce(null);
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/forgot',
      payload: { email: 'missing@example.test' },
    });

    mocks.prisma.user.findUnique.mockResolvedValueOnce({ id: 'user-a' });
    mocks.transaction.$queryRaw.mockResolvedValueOnce([{
      id: 'user-a',
      status: 'ACTIVE',
      email: 'alice@example.test',
      displayName: 'Alice',
      emailVerifiedAt: new Date(),
    }]);
    mocks.transaction.userPasswordResetToken.create.mockResolvedValueOnce({ id: 'reset-a' });
    const found = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/forgot',
      payload: { email: 'alice@example.test' },
    });

    expect(missing.statusCode).toBe(200);
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual(missing.json());
    expect(mocks.sendPasswordReset).toHaveBeenCalledOnce();
  });

  it('resets the password once, revokes every device, and invalidates other reset links', async () => {
    mocks.transaction.userPasswordResetToken.findUnique.mockResolvedValue({
      id: 'reset-a',
      userId: 'user-a',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mocks.transaction.$queryRaw.mockResolvedValue([{
      id: 'user-a',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    }]);
    app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/reset/email',
      payload: { token: 'b'.repeat(32), newPassword: 'replacement-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-a', status: 'ACTIVE', emailVerifiedAt: { not: null } },
      data: { passwordHash: 'v2:replacement-hash' },
    });
    expect(mocks.transaction.userDevice.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-a', revokedAt: null },
      data: { revokedAt: expect.any(Date), refreshTokenHash: null, refreshTokenJti: null },
    });
    expect(mocks.transaction.adminPasswordResetToken.updateMany).toHaveBeenCalled();
    expect(mocks.disconnectSubject).toHaveBeenCalledWith('user-a');
  });
});
