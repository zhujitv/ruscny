import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const friendCall = {
    updateMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
  };
  const transaction = {
    $queryRaw: vi.fn(),
    friendCall,
    friendship: { findUnique: vi.fn() },
  };
  return {
    transaction,
    friendCall,
    emitToSubject: vi.fn(),
    prisma: {
      $transaction: vi.fn(),
      friendCall,
    },
  };
});

vi.mock('../src/db.js', () => ({ prisma: mocks.prisma }));
vi.mock('../src/auth.js', () => ({
  authenticate: async (request: { auth?: unknown }) => {
    request.auth = {
      subjectId: 'user-a',
      role: 'USER',
      deviceId: 'device-a',
      sessionId: 'session-a',
    };
  },
}));
vi.mock('../src/realtime-hub.js', () => ({
  realtimeHub: () => ({
    emitToSubject: mocks.emitToSubject,
    stopFriendCallTranslation: vi.fn(),
  }),
}));
vi.mock('../src/routes/social.js', () => ({
  subjectCredentialRateLimit: () => ({ max: 20, timeWindow: '1 minute' }),
}));
vi.mock('../src/services/service-configuration.js', () => ({
  serviceConfiguration: vi.fn(async (key: string) =>
    key === 'ALIYUN_RTC_APP_ID' ? 'app123' : 'server-secret'),
}));
vi.mock('../src/services/aliyun-rtc.js', () => ({
  AliyunRtcNotConfiguredError: class extends Error {},
  createAliyunRtcCredential: vi.fn(async (channelId: string, userId: string) => ({
    channelId,
    userId,
    token: '000-token',
    expiresAt: 1_900_000_000,
  })),
}));

import { AppError } from '../src/errors.js';
import { registerFriendCallRoutes } from '../src/routes/friend-calls.js';

let app: FastifyInstance | undefined;
const now = new Date('2026-07-20T10:00:00.000Z');
const caller = { id: 'user-a', displayName: 'A', company: null, preferredLanguage: 'zh', avatarUrl: null, avatarPreset: null };
const callee = { id: 'user-b', displayName: 'B', company: null, preferredLanguage: 'ru', avatarUrl: null, avatarPreset: null };
const ringingCall = {
  id: 'call-1',
  callerId: 'user-a',
  calleeId: 'user-b',
  callerDeviceId: 'device-a',
  calleeDeviceId: null,
  channelId: 'fc_channel',
  status: 'RINGING',
  acceptedAt: null,
  endedAt: null,
  endedById: null,
  createdAt: now,
  updatedAt: now,
  caller,
  callee,
};

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (input: unknown) => {
    if (typeof input === 'function') return input(mocks.transaction);
    return Promise.all(input as Promise<unknown>[]);
  });
  mocks.transaction.$queryRaw.mockResolvedValue([
    { id: 'user-a', status: 'ACTIVE' },
    { id: 'user-b', status: 'ACTIVE' },
  ]);
  mocks.friendCall.updateMany.mockResolvedValue({ count: 1 });
  app = Fastify({ logger: false });
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof AppError) {
      await reply.code(error.statusCode).send({ ok: false, code: error.code });
      return;
    }
    throw error;
  });
  await registerFriendCallRoutes(app);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('friend call state and device ownership', () => {
  it('binds a new outgoing call to the authenticated device', async () => {
    mocks.transaction.friendship.findUnique.mockResolvedValue({ id: 'friendship-1' });
    mocks.friendCall.findFirst.mockResolvedValue(null);
    mocks.friendCall.create.mockResolvedValue(ringingCall);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls',
      payload: { friendId: 'user-b' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.friendCall.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ callerDeviceId: 'device-a' }),
    }));
    expect(mocks.friendCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'ACTIVE' }),
    }));
  });

  it('binds acceptance and heartbeat to the answering device', async () => {
    mocks.friendCall.findFirst.mockResolvedValue({ ...ringingCall, calleeId: 'user-a', callerId: 'user-b' });
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/respond',
      payload: { action: 'ACCEPT' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.friendCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'ACTIVE',
        calleeDeviceId: 'device-a',
        lastHeartbeatAt: expect.any(Date),
      }),
    }));
  });

  it('does not issue RTC credentials to a different device session', async () => {
    mocks.friendCall.findFirst.mockResolvedValue(null);
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/rtc-credential',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('ACTIVE_FRIEND_CALL_NOT_FOUND');
  });

  it('refreshes an active call heartbeat only for the owning device', async () => {
    mocks.friendCall.updateMany.mockResolvedValue({ count: 1 });
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/heartbeat',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.friendCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'ACTIVE' }),
      data: { lastHeartbeatAt: expect.any(Date) },
    }));
  });
});
