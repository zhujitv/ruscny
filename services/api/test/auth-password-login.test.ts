import bcrypt from 'bcryptjs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transaction = {
    $queryRaw: vi.fn(),
    user: { update: vi.fn() },
    userDevice: { upsert: vi.fn() },
    emailVerificationToken: { updateMany: vi.fn(), create: vi.fn() },
  };
  return {
    transaction,
    disconnectDevice: vi.fn(),
    prisma: {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) =>
        callback(transaction)),
      user: {
        findUnique: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
      userDevice: {
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
      emailVerificationToken: { updateMany: vi.fn() },
      glossaryTerm: { createMany: vi.fn() },
      systemSetting: { findUnique: vi.fn() },
    },
  };
});

vi.mock('../src/db.js', () => ({ prisma: mocks.prisma }));
vi.mock('../src/realtime-hub.js', () => ({
  realtimeHub: () => ({
    emitToConversation: vi.fn(),
    emitToSubject: vi.fn(),
    disconnectDevice: mocks.disconnectDevice,
    disconnectSubject: vi.fn(),
    disconnectParticipant: vi.fn(),
    isSubjectOnline: async () => false,
    isReady: () => true,
  }),
}));
vi.mock('../src/services/audio-assets.js', () => ({
  playableAudioUrl: (value: string | null) => value,
}));

import { config } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { registerAuthRoutes } from '../src/routes/auth.js';

let app: FastifyInstance | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof mocks.transaction) => unknown) => callback(mocks.transaction),
  );
  mocks.transaction.$queryRaw.mockResolvedValue([{ status: 'ACTIVE', emailVerifiedAt: new Date() }]);
  mocks.transaction.userDevice.upsert.mockResolvedValue({});
  mocks.transaction.emailVerificationToken.updateMany.mockResolvedValue({ count: 0 });
  mocks.transaction.emailVerificationToken.create.mockResolvedValue({ id: 'verification-a' });
  mocks.prisma.emailVerificationToken.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.user.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.systemSetting.findUnique.mockResolvedValue(null);
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
    throw error;
  });
  await registerAuthRoutes(instance);
  return instance;
}

describe('password login hardening', () => {
  it('blocks registration when the safe operational switch is disabled', async () => {
    mocks.prisma.systemSetting.findUnique.mockResolvedValue({ value: false });
    app = await createApp();
    const response = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { displayName: 'Alice', email: 'alice@example.test', password: 'password-123', deviceId: 'register-device-a' } });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('REGISTRATION_DISABLED');
    expect(mocks.prisma.user.create).not.toHaveBeenCalled();
  });

  it('creates one unified registered-user type even when an old client submits a role', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    mocks.prisma.user.create.mockResolvedValue({
      id: 'user-new',
      role: 'USER',
      displayName: 'Alice',
      email: 'alice@example.test',
      emailVerifiedAt: null,
      company: 'ACME',
      preferredLanguage: 'zh',
    });
    mocks.prisma.glossaryTerm.createMany.mockResolvedValue({ count: 1 });
    mocks.transaction.$queryRaw.mockResolvedValue([{
      id: 'user-new',
      status: 'ACTIVE',
      email: 'alice@example.test',
      displayName: 'Alice',
      emailVerifiedAt: null,
    }]);
    app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Alice',
        email: 'alice@example.test',
        password: 'password-123',
        company: 'ACME',
        preferredLanguage: 'zh',
        role: 'CUSTOMER',
        deviceId: 'register-device-a',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: 'USER' }),
    }));
    expect(response.json().data).toMatchObject({
      verificationRequired: true,
      emailHint: 'al***@example.test',
    });
    expect(mocks.transaction.userDevice.upsert).not.toHaveBeenCalled();
    expect(mocks.transaction.emailVerificationToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'user-new' }) }),
    );
  });

  it('does not issue a session when account deletion wins after the initial password read', async () => {
    const password = 'password-123';
    const legacyHash = await bcrypt.hash(`${password}:${config.PASSWORD_PEPPER}`, 4);
    mocks.prisma.user.findUnique.mockResolvedValue({
      id: 'user-a',
      role: 'USER',
      displayName: 'Alice',
      email: 'alice@example.test',
      emailVerifiedAt: new Date(),
      company: 'ACME',
      preferredLanguage: 'zh',
      passwordHash: legacyHash,
      status: 'ACTIVE',
    });
    mocks.transaction.$queryRaw.mockResolvedValue([{ status: 'DELETED', emailVerifiedAt: new Date() }]);
    app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'alice@example.test',
        password,
        deviceId: 'login-device-a',
        platform: 'ANDROID',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, code: 'ACCOUNT_DISABLED' });
    expect(mocks.transaction.userDevice.upsert).not.toHaveBeenCalled();
    expect(mocks.disconnectDevice).not.toHaveBeenCalled();
  });

  it('upgrades a valid legacy hash and creates the device session under an ACTIVE row lock', async () => {
    const password = 'password-123';
    const legacyHash = await bcrypt.hash(`${password}:${config.PASSWORD_PEPPER}`, 4);
    mocks.prisma.user.findUnique.mockResolvedValue({
      id: 'user-a',
      role: 'USER',
      displayName: 'Alice',
      email: 'alice@example.test',
      emailVerifiedAt: new Date(),
      company: 'ACME',
      preferredLanguage: 'zh',
      passwordHash: legacyHash,
      status: 'ACTIVE',
    });
    app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'alice@example.test',
        password,
        deviceId: 'login-device-a',
        platform: 'ANDROID',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.accessToken).toEqual(expect.any(String));
    expect(mocks.prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-a', passwordHash: legacyHash, status: 'ACTIVE' },
      data: { passwordHash: expect.stringMatching(/^v2:\$2/) },
    });
    expect(mocks.transaction.userDevice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'user-a',
          authenticatedAt: expect.any(Date),
        }),
      }),
    );
  });
});
