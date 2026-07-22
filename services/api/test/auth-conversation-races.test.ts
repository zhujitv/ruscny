import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transaction = {
    $queryRaw: vi.fn(),
    conversation: {
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      delete: vi.fn(),
    },
    participant: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    guestIdentity: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    guestPrincipal: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    user: { findUnique: vi.fn() },
    translationMessage: { findMany: vi.fn(), updateMany: vi.fn() },
    meetingInvitation: { updateMany: vi.fn() },
  };
  return {
    enqueueAudioDeletionJobs: vi.fn(),
    wakeAudioDeletionWorker: vi.fn(),
    disconnectDevice: vi.fn(),
    disconnectSubject: vi.fn(),
    transaction,
    prisma: {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) =>
        callback(transaction)),
      conversation: {
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        updateMany: vi.fn(),
      },
      participant: { findFirst: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
      guestIdentity: { findFirst: vi.fn(), updateMany: vi.fn() },
      user: { findUniqueOrThrow: vi.fn() },
      userDevice: {
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        upsert: vi.fn(),
      },
      glossaryTerm: { createMany: vi.fn() },
      translationMessage: { updateMany: vi.fn() },
    },
  };
});

vi.mock('../src/db.js', () => ({ prisma: mocks.prisma }));
vi.mock('../src/services/audio-assets.js', () => ({
  playableAudioUrl: (value: string | null) => value,
}));
vi.mock('../src/services/audio-deletion-outbox.js', () => ({
  enqueueAudioDeletionJobs: mocks.enqueueAudioDeletionJobs,
  wakeAudioDeletionWorker: mocks.wakeAudioDeletionWorker,
}));
vi.mock('../src/realtime-hub.js', () => ({
  realtimeHub: () => ({
    emitToConversation: vi.fn(),
    disconnectDevice: mocks.disconnectDevice,
    disconnectSubject: mocks.disconnectSubject,
    isReady: () => true,
  }),
}));
vi.mock('../src/auth.js', () => ({
  authenticate: async (request: {
    auth?: unknown;
    headers?: { authorization?: string };
  }) => {
    request.auth = request.headers?.authorization === 'Bearer guest-test'
      ? {
          subjectId: 'guest-a',
          guestIdentityId: 'guest-a',
          conversationId: 'conversation-a',
          role: 'GUEST',
          deviceId: 'guest-device-a',
          sessionId: 'guest-session-a',
        }
      : {
          subjectId: 'customer-a',
          role: 'USER',
          deviceId: 'customer-device-a',
          sessionId: 'customer-session-a',
        };
  },
  requireRole: () => async (request: { auth?: unknown }) => {
    request.auth = {
      subjectId: 'host-a',
      role: 'USER',
      deviceId: 'host-device-a',
      sessionId: 'host-session-a',
    };
  },
}));

import { registerAuthRoutes } from '../src/routes/auth.js';
import { registerConversationRoutes } from '../src/routes/conversations.js';
import { config } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { secretHash, stableHash } from '../src/lib/crypto.js';
import { signRefreshToken, verifyAccessToken } from '../src/lib/tokens.js';

let app: FastifyInstance | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  // Clear one-shot transactional results as well as call history. A test that
  // fails before entering its transaction must not leak a queued race result
  // into the next case.
  mocks.transaction.conversation.updateMany.mockReset();
  mocks.transaction.conversation.update.mockReset();
  mocks.transaction.conversation.findUnique.mockReset();
  mocks.transaction.conversation.findUniqueOrThrow.mockReset();
  mocks.transaction.$queryRaw.mockReset();
  mocks.transaction.guestIdentity.findFirst.mockReset();
  mocks.transaction.guestIdentity.findUnique.mockReset();
  mocks.transaction.guestPrincipal.findUnique.mockReset();
  mocks.transaction.guestPrincipal.create.mockReset();
  mocks.transaction.guestPrincipal.update.mockReset();
  mocks.transaction.user.findUnique.mockReset();
  mocks.prisma.conversation.updateMany.mockResolvedValue({ count: 0 });
  mocks.prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof mocks.transaction) => unknown) => callback(mocks.transaction),
  );
  mocks.transaction.conversation.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.conversation.update.mockResolvedValue(invitation);
  mocks.transaction.conversation.findUnique.mockResolvedValue(invitation);
  mocks.transaction.conversation.findUniqueOrThrow.mockResolvedValue(invitation);
  mocks.transaction.$queryRaw.mockResolvedValue([invitation]);
  mocks.transaction.user.findUnique.mockResolvedValue({
    status: 'ACTIVE',
    displayName: 'Ivan',
    company: 'RU Trade',
    preferredLanguage: 'ru',
  });
  mocks.transaction.guestPrincipal.create.mockImplementation(async ({ data }) => ({
    id: 'guest-principal-a',
    tokenHash: data.tokenHash,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSeenAt: data.lastSeenAt,
    revokedAt: null,
  }));
  mocks.enqueueAudioDeletionJobs.mockResolvedValue(0);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function errorEnvelope(instance: FastifyInstance): void {
  instance.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof AppError) {
      await reply.code(error.statusCode).send({ ok: false, code: error.code });
      return;
    }
    throw error;
  });
}

const invitation = {
  id: 'conversation-a',
  kind: 'MEETING',
  status: 'WAITING',
  roomTokenHash: stableHash('valid-room-token-123456'),
  roomCodeHash: stableHash('12345678'),
  expiresAt: new Date(Date.now() + 60_000),
  startedAt: null,
};

describe('join versus end/expiry races', () => {
  it('never resolves a direct chat through the registered meeting join route', async () => {
    mocks.prisma.conversation.findUnique.mockResolvedValue({
      ...invitation,
      kind: 'DIRECT',
      status: 'ACTIVE',
      directPairKey: 'customer-a:customer-b',
    });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerConversationRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations/join',
      payload: {
        roomCode: '12345678',
        displayName: 'Intruder',
        company: 'Unknown',
        preferredLanguage: 'ru',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, code: 'ROOM_NOT_FOUND' });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('never resolves a direct chat through temporary guest authentication', async () => {
    mocks.prisma.conversation.findUnique.mockResolvedValue({
      ...invitation,
      kind: 'DIRECT',
      status: 'ACTIVE',
      directPairKey: 'customer-a:customer-b',
    });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerAuthRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      payload: {
        displayName: 'Intruder',
        company: 'Unknown',
        email: 'intruder@example.test',
        preferredLanguage: 'ru',
        deviceId: 'intruder-device-a',
        roomCode: '12345678',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, code: 'ROOM_NOT_FOUND' });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('revokes the current registered device from Bearer logout without a refresh token', async () => {
    mocks.prisma.userDevice.updateMany.mockResolvedValue({ count: 1 });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerAuthRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: 'Bearer registered-test' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.prisma.userDevice.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'customer-a',
        deviceId: 'customer-device-a',
        sessionId: 'customer-session-a',
        revokedAt: null,
      },
      data: {
        revokedAt: expect.any(Date),
        refreshTokenHash: null,
        refreshTokenJti: null,
      },
    });
    expect(mocks.disconnectDevice).toHaveBeenCalledWith('customer-a', 'customer-device-a');
  });

  it('revokes the Bearer session even when the supplied refresh family is stale', async () => {
    const staleRefreshToken = await signRefreshToken({
      userId: 'customer-a',
      deviceId: 'customer-device-a',
      sessionId: 'stale-session',
      familyId: 'stale-session',
      jti: 'stale-jti',
    });
    mocks.prisma.userDevice.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerAuthRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: 'Bearer registered-test' },
      payload: { refreshToken: staleRefreshToken },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.prisma.userDevice.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        userId: 'customer-a',
        deviceId: 'customer-device-a',
        sessionId: 'customer-session-a',
        revokedAt: null,
      },
      data: {
        revokedAt: expect.any(Date),
        refreshTokenHash: null,
        refreshTokenJti: null,
      },
    });
    expect(mocks.prisma.userDevice.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        userId: 'customer-a',
        deviceId: 'customer-device-a',
        sessionId: 'stale-session',
        revokedAt: null,
        refreshTokenJti: 'stale-jti',
        refreshTokenHash: secretHash(staleRefreshToken, config.PASSWORD_PEPPER),
      },
      data: {
        revokedAt: expect.any(Date),
        refreshTokenHash: null,
        refreshTokenJti: null,
      },
    });
    expect(mocks.disconnectDevice).toHaveBeenCalledTimes(1);
    expect(mocks.disconnectDevice).toHaveBeenCalledWith('customer-a', 'customer-device-a');
  });

  it('expires a guest identity on Bearer-authenticated logout without marking it removed', async () => {
    mocks.transaction.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: 'conversation-a' }])
      .mockResolvedValueOnce([{
        id: 'guest-a',
        sessionId: 'guest-session-a',
        displayName: 'Ivan',
        company: 'RU Trade',
        preferredLanguage: 'ru',
        deviceId: 'guest-device-a',
        conversationId: 'conversation-a',
        guestPrincipalId: 'principal-a',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      }])
      .mockResolvedValueOnce([{ id: 'participant-a' }]);
    mocks.transaction.guestIdentity.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.participant.updateMany.mockResolvedValue({ count: 1 });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerAuthRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: 'Bearer guest-test' },
      payload: { refreshToken: null },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.transaction.guestIdentity.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'guest-a',
        conversationId: 'conversation-a',
        deviceId: 'guest-device-a',
        revokedAt: null,
      },
      data: {
        expiresAt: expect.any(Date),
        sessionId: expect.any(String),
      },
    });
    expect(mocks.transaction.participant.updateMany).toHaveBeenCalledWith({
      where: { guestIdentityId: 'guest-a', removedAt: null },
      data: {
        leftAt: expect.any(Date),
        lastSeenAt: expect.any(Date),
        presence: 'LEFT',
      },
    });
  });

  it('lets an already-authenticated guest logout expire a concurrently renewed generation', async () => {
    mocks.transaction.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: 'conversation-a' }])
      .mockResolvedValueOnce([{
        id: 'guest-a',
        sessionId: 'guest-session-new',
        displayName: 'Ivan',
        company: 'RU Trade',
        preferredLanguage: 'ru',
        deviceId: 'guest-device-a',
        conversationId: 'conversation-a',
        guestPrincipalId: 'principal-a',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      }])
      .mockResolvedValueOnce([{ id: 'participant-a' }]);
    mocks.transaction.guestIdentity.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.participant.updateMany.mockResolvedValue({ count: 1 });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerAuthRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: 'Bearer guest-test' },
      payload: { refreshToken: null },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.transaction.guestIdentity.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'guest-a',
        conversationId: 'conversation-a',
        deviceId: 'guest-device-a',
        revokedAt: null,
      },
      data: {
        expiresAt: expect.any(Date),
        sessionId: expect.any(String),
      },
    });
    expect(mocks.transaction.participant.updateMany).toHaveBeenCalledOnce();
    expect(mocks.disconnectSubject).toHaveBeenCalledWith('guest-a');
  });

  it('rejects a formal-customer join when end wins before the locked credential check', async () => {
    mocks.prisma.conversation.findUnique.mockResolvedValue(invitation);
    mocks.prisma.participant.findFirst.mockResolvedValue(null);
    mocks.prisma.participant.count.mockResolvedValue(0);
    mocks.prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'customer-a',
      displayName: 'Ivan',
      company: 'RU Trade',
      preferredLanguage: 'ru',
    });
    mocks.transaction.$queryRaw.mockResolvedValueOnce([{ ...invitation, status: 'ENDED' }]);

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerConversationRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations/join',
      payload: {
        roomToken: 'valid-room-token-123456',
        displayName: 'Ivan',
        company: 'RU Trade',
        preferredLanguage: 'ru',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, code: 'ROOM_EXPIRED' });
    expect(mocks.transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(mocks.transaction.conversation.update).not.toHaveBeenCalled();
    expect(mocks.transaction.participant.upsert).not.toHaveBeenCalled();
  });

  it('rejects a credential that was rotated after the initial invitation lookup', async () => {
    mocks.prisma.conversation.findUnique.mockResolvedValue(invitation);
    mocks.prisma.user.findUniqueOrThrow.mockResolvedValue({
      displayName: 'Ivan',
      company: 'RU Trade',
      preferredLanguage: 'ru',
    });
    mocks.transaction.$queryRaw.mockResolvedValueOnce([{
      ...invitation,
      roomTokenHash: stableHash('new-room-token-654321'),
    }]);

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerConversationRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations/join',
      payload: {
        roomToken: 'valid-room-token-123456',
        displayName: 'Ivan',
        company: 'RU Trade',
        preferredLanguage: 'ru',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, code: 'ROOM_NOT_FOUND' });
    expect(mocks.transaction.conversation.update).not.toHaveBeenCalled();
    expect(mocks.transaction.participant.findUnique).not.toHaveBeenCalled();
  });

  it('does not insert a participant after concurrent account deletion commits', async () => {
    mocks.prisma.conversation.findUnique.mockResolvedValue(invitation);
    mocks.transaction.user.findUnique.mockResolvedValueOnce({
      status: 'DELETED',
      displayName: '已注销用户',
      company: null,
      preferredLanguage: 'ru',
    });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerConversationRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations/join',
      payload: {
        roomToken: 'valid-room-token-123456',
        displayName: 'Stale PII',
        company: 'Old Company',
        preferredLanguage: 'ru',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, code: 'ACCOUNT_DISABLED' });
    expect(mocks.transaction.participant.findUnique).not.toHaveBeenCalled();
    expect(mocks.transaction.conversation.update).not.toHaveBeenCalled();
  });

  it('rolls back a guest identity when transactional activation loses the race', async () => {
    mocks.prisma.conversation.findUnique.mockResolvedValue(invitation);
    mocks.prisma.guestIdentity.findFirst.mockResolvedValue(null);
    mocks.prisma.participant.count.mockResolvedValue(0);
    mocks.transaction.conversation.updateMany.mockResolvedValueOnce({ count: 0 });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerAuthRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      payload: {
        displayName: 'Ivan',
        company: 'RU Trade',
        email: 'ivan@example.test',
        preferredLanguage: 'ru',
        deviceId: 'guest-device-a',
        roomToken: 'valid-room-token-123456',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, code: 'ROOM_EXPIRED' });
    expect(mocks.transaction.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'conversation-a',
        status: { in: ['WAITING', 'ACTIVE'] },
        expiresAt: { gt: expect.any(Date) },
      },
      data: { status: 'ACTIVE' },
    });
    expect(mocks.transaction.guestIdentity.create).not.toHaveBeenCalled();
  });

  it('rotates a returning guest session and disconnects sockets from the old generation', async () => {
    const oldIdentity = {
      id: 'guest-a',
      sessionId: 'guest-session-old',
      displayName: 'Old name',
      company: null,
      deviceId: 'guest-device-a',
      conversationId: 'conversation-a',
      expiresAt: invitation.expiresAt,
      revokedAt: null,
      createdAt: new Date(),
    };
    mocks.prisma.conversation.findUnique.mockResolvedValue(invitation);
    mocks.prisma.guestIdentity.findFirst.mockResolvedValue(oldIdentity);
    mocks.transaction.conversation.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.guestIdentity.findFirst.mockResolvedValue(oldIdentity);
    mocks.transaction.guestIdentity.update.mockImplementation(async ({ data }) => ({
      ...oldIdentity,
      ...data,
    }));
    mocks.transaction.participant.findUnique.mockResolvedValue({
      id: 'participant-a',
      removedAt: null,
    });
    mocks.transaction.participant.update.mockResolvedValue({});

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerAuthRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      payload: {
        displayName: 'Ivan',
        company: 'RU Trade',
        email: 'ivan@example.test',
        preferredLanguage: 'ru',
        deviceId: 'guest-device-a',
        roomToken: 'valid-room-token-123456',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const updatedSession = mocks.transaction.guestIdentity.update.mock.calls[0]![0].data.sessionId;
    expect(updatedSession).toEqual(expect.any(String));
    expect(updatedSession).not.toBe(oldIdentity.sessionId);
    const claims = await verifyAccessToken(response.json().data.accessToken);
    expect(claims.sessionId).toBe(updatedSession);
    expect(mocks.disconnectSubject).toHaveBeenCalledWith('guest-a');
  });

  it('does not let a formally removed customer rejoin with the same account', async () => {
    mocks.prisma.conversation.findUnique.mockResolvedValue(invitation);
    mocks.prisma.user.findUniqueOrThrow.mockResolvedValue({
      displayName: 'Ivan',
      company: 'RU Trade',
      preferredLanguage: 'ru',
    });
    mocks.transaction.participant.findUnique.mockResolvedValue({
      id: 'removed-participant',
      removedAt: new Date(),
    });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerConversationRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations/join',
      payload: {
        roomToken: 'valid-room-token-123456',
        displayName: 'Ivan',
        company: 'RU Trade',
        preferredLanguage: 'ru',
      },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toEqual({ ok: false, code: 'PARTICIPANT_REMOVED' });
    expect(mocks.prisma.$transaction).toHaveBeenCalledOnce();
    expect(mocks.transaction.conversation.update).not.toHaveBeenCalled();
  });

  it('does not let a removed guest device mint a replacement identity', async () => {
    mocks.prisma.conversation.findUnique.mockResolvedValue(invitation);
    mocks.transaction.conversation.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.guestIdentity.findFirst.mockResolvedValue({
      id: 'removed-guest',
      revokedAt: new Date(),
    });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerAuthRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      payload: {
        displayName: 'Ivan',
        company: 'RU Trade',
        email: 'ivan@example.test',
        preferredLanguage: 'ru',
        deviceId: 'guest-device-a',
        roomToken: 'valid-room-token-123456',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, code: 'PARTICIPANT_REMOVED' });
    expect(mocks.transaction.guestIdentity.create).not.toHaveBeenCalled();
  });

  it('binds a removed guest to its durable principal even after deviceId changes', async () => {
    const principalToken = 'guest-principal-token-1234567890123456';
    mocks.prisma.conversation.findUnique.mockResolvedValue(invitation);
    mocks.transaction.conversation.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.guestPrincipal.findUnique.mockResolvedValue({
      id: 'guest-principal-a',
      tokenHash: secretHash(
        `guest-principal-v1:${principalToken}`,
        config.PASSWORD_PEPPER,
      ),
      revokedAt: null,
    });
    mocks.transaction.guestIdentity.findUnique.mockResolvedValue({
      id: 'removed-guest',
      guestPrincipalId: 'guest-principal-a',
      revokedAt: new Date(),
    });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerAuthRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      payload: {
        displayName: 'Ivan',
        company: 'RU Trade',
        email: 'ivan@example.test',
        preferredLanguage: 'ru',
        deviceId: 'completely-new-device',
        guestPrincipalToken: principalToken,
        roomToken: 'valid-room-token-123456',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, code: 'PARTICIPANT_REMOVED' });
    expect(mocks.transaction.guestIdentity.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown principal token on a different device', async () => {
    mocks.prisma.conversation.findUnique.mockResolvedValue(invitation);
    mocks.transaction.conversation.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.guestPrincipal.findUnique.mockResolvedValue(null);
    mocks.transaction.guestIdentity.findFirst.mockResolvedValue(null);

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerAuthRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      payload: {
        displayName: 'Ivan',
        company: 'RU Trade',
        email: 'ivan@example.test',
        preferredLanguage: 'ru',
        deviceId: 'completely-new-device',
        guestPrincipalToken: 'unknown-principal-token-123456789012345',
        roomToken: 'valid-room-token-123456',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, code: 'GUEST_PRINCIPAL_INVALID' });
  });
});

describe('conversation end compare-and-swap', () => {
  const activeConversation = {
    id: 'conversation-a',
    ownerId: 'host-a',
    contactId: 'contact-a',
    title: 'Meeting',
    hostLanguage: 'zh',
    guestLanguage: 'ru',
    status: 'ACTIVE',
    roomTokenHash: 'token-hash',
    roomCodeHash: 'code-hash',
    guestHistoryPolicy: 'ACCESS_FOR_24_HOURS',
    guestAccessExpiresAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    startedAt: new Date(),
    endedAt: null,
    maxSequence: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    contact: { id: 'contact-a', displayName: 'Ivan', company: null },
    participants: [],
    _count: { messages: 0, participants: 2 },
  };

  it('returns the winning ENDED row when a concurrent end already won', async () => {
    const ended = { ...activeConversation, status: 'ENDED', endedAt: new Date() };
    mocks.prisma.conversation.findUnique.mockResolvedValue(activeConversation);
    mocks.transaction.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([activeConversation])
      .mockResolvedValueOnce([{ id: 'host-a', status: 'ACTIVE' }])
      .mockResolvedValueOnce([{ sessionId: 'host-session-a', revokedAt: null }]);
    mocks.transaction.conversation.updateMany.mockResolvedValue({ count: 0 });
    mocks.transaction.conversation.findUnique
      .mockResolvedValueOnce(activeConversation)
      .mockResolvedValueOnce(ended);
    mocks.transaction.conversation.findUniqueOrThrow.mockResolvedValue(ended);

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerConversationRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations/conversation-a/end',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.conversation.status).toBe('ENDED');
    expect(mocks.transaction.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'conversation-a', status: { in: ['WAITING', 'ACTIVE'] } },
      data: expect.objectContaining({ status: 'ENDED', endedAt: expect.any(Date) }),
    });
    expect(mocks.transaction.guestIdentity.updateMany).not.toHaveBeenCalled();
  });

  it('commits durable audio deletion jobs before waking the object worker', async () => {
    const order: string[] = [];
    mocks.prisma.conversation.findUnique.mockResolvedValue(activeConversation);
    mocks.transaction.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([activeConversation])
      .mockResolvedValueOnce([{ id: 'host-a', status: 'ACTIVE' }])
      .mockResolvedValueOnce([{ sessionId: 'host-session-a', revokedAt: null }])
      .mockResolvedValueOnce([{ id: 'conversation-a' }]);
    mocks.transaction.conversation.findUnique.mockResolvedValue(activeConversation);
    mocks.transaction.translationMessage.findMany.mockResolvedValue([
      { audioUrl: 'asset:tts-123e4567-e89b-12d3-a456-426614174000.mp3' },
    ]);
    mocks.enqueueAudioDeletionJobs.mockImplementation(async () => {
      order.push('outbox');
      return 1;
    });
    mocks.transaction.conversation.delete.mockImplementation(async () => {
      order.push('database');
      return activeConversation;
    });
    mocks.prisma.$transaction.mockImplementation(async (callback) => {
      const result = await callback(mocks.transaction);
      order.push('commit');
      return result;
    });
    mocks.wakeAudioDeletionWorker.mockImplementation(() => {
      order.push('wake');
    });
    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerConversationRoutes(app);
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/conversations/conversation-a',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: {} });
    expect(order).toEqual(['commit', 'outbox', 'database', 'commit', 'wake']);
    expect(mocks.enqueueAudioDeletionJobs).toHaveBeenCalledWith(
      mocks.transaction,
      ['asset:tts-123e4567-e89b-12d3-a456-426614174000.mp3'],
    );
    expect(mocks.transaction.conversation.delete).toHaveBeenCalledWith({
      where: { id: 'conversation-a' },
    });
  });
});

describe('refresh token compare-and-swap', () => {
  it('does not let a refresh token from an old login revoke the new login family', async () => {
    const oldRefreshToken = await signRefreshToken({
      userId: 'user-a',
      deviceId: 'device-a',
      sessionId: 'session-old',
      familyId: 'session-old',
      jti: 'old-login-rotation',
    });
    const currentRefreshToken = await signRefreshToken({
      userId: 'user-a',
      deviceId: 'device-a',
      sessionId: 'session-new',
      familyId: 'session-new',
      jti: 'new-login-rotation',
    });
    mocks.prisma.userDevice.findUnique.mockResolvedValue({
      id: 'device-record-a',
      userId: 'user-a',
      deviceId: 'device-a',
      sessionId: 'session-new',
      revokedAt: null,
      refreshTokenJti: 'new-login-rotation',
      refreshTokenHash: secretHash(currentRefreshToken, config.PASSWORD_PEPPER),
      user: {
        id: 'user-a',
        role: 'USER',
        status: 'ACTIVE',
        displayName: 'Host',
        email: 'host@example.com',
        emailVerifiedAt: new Date(),
      },
    });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerAuthRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: oldRefreshToken, deviceId: 'device-a' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, code: 'REFRESH_TOKEN_INVALID' });
    expect(mocks.prisma.userDevice.updateMany).not.toHaveBeenCalled();
    expect(mocks.disconnectDevice).not.toHaveBeenCalled();
  });

  it('revokes the current family when an already-rotated token is replayed', async () => {
    const oldJti = 'old-rotation';
    const refreshToken = await signRefreshToken({
      userId: 'user-a',
      deviceId: 'device-a',
      sessionId: 'session-a',
      familyId: 'session-a',
      jti: oldJti,
    });
    const oldHash = secretHash(refreshToken, config.PASSWORD_PEPPER);
    const device = {
      id: 'device-record-a',
      userId: 'user-a',
      deviceId: 'device-a',
      sessionId: 'session-a',
      revokedAt: null,
      refreshTokenJti: oldJti,
      refreshTokenHash: oldHash,
      user: {
        id: 'user-a',
        role: 'USER',
        status: 'ACTIVE',
        displayName: 'Host',
        email: 'host@example.com',
        emailVerifiedAt: new Date(),
      },
    };

    let storedJti = oldJti;
    let storedHash = oldHash;
    let revokedAt: Date | null = null;
    mocks.prisma.userDevice.findUnique.mockImplementation(async () => ({
      ...device,
      revokedAt,
      refreshTokenJti: storedJti,
      refreshTokenHash: storedHash,
    }));
    mocks.prisma.userDevice.updateMany.mockImplementation(async ({ where, data }) => {
      if (
        where.sessionId !== device.sessionId ||
        revokedAt ||
        where.refreshTokenJti !== storedJti ||
        where.refreshTokenHash !== storedHash
      ) {
        return { count: 0 };
      }
      if (data.revokedAt) {
        revokedAt = data.revokedAt;
        storedJti = null;
        storedHash = null;
      } else {
        storedJti = data.refreshTokenJti;
        storedHash = data.refreshTokenHash;
      }
      return { count: 1 };
    });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerAuthRoutes(app);
    const rotate = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken, deviceId: 'device-a' },
    });
    expect(rotate.statusCode).toBe(200);
    await expect(verifyAccessToken(rotate.json().data.accessToken)).resolves.toMatchObject({
      sessionId: 'session-a',
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken, deviceId: 'device-a' },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ ok: false, code: 'REFRESH_TOKEN_REUSED' });
    expect(revokedAt).toBeInstanceOf(Date);
    expect(mocks.disconnectDevice).toHaveBeenCalledWith('user-a', 'device-a');
    expect(mocks.prisma.userDevice.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.userDevice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'device-record-a',
          sessionId: 'session-a',
          revokedAt: null,
          refreshTokenJti: oldJti,
          refreshTokenHash: oldHash,
        },
      }),
    );
    expect(mocks.prisma.userDevice.upsert).not.toHaveBeenCalled();
  });

  it('does not let logout from an old family revoke the current device session', async () => {
    const oldRefreshToken = await signRefreshToken({
      userId: 'user-a',
      deviceId: 'device-a',
      sessionId: 'session-old',
      familyId: 'session-old',
      jti: 'old-login-rotation',
    });
    mocks.prisma.userDevice.updateMany.mockResolvedValue({ count: 0 });

    app = Fastify({ logger: false });
    errorEnvelope(app);
    await registerAuthRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken: oldRefreshToken },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.prisma.userDevice.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-a',
        deviceId: 'device-a',
        sessionId: 'session-old',
        revokedAt: null,
        refreshTokenJti: 'old-login-rotation',
        refreshTokenHash: secretHash(oldRefreshToken, config.PASSWORD_PEPPER),
      },
      data: { revokedAt: expect.any(Date), refreshTokenHash: null, refreshTokenJti: null },
    });
    expect(mocks.disconnectDevice).not.toHaveBeenCalled();
  });
});
