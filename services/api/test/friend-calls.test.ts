import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const mocks = vi.hoisted(() => {
  const friendCall = {
    updateMany: vi.fn(),
    updateManyAndReturn: vi.fn(),
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
    stopFriendCallTranslation: vi.fn(),
    realtimeTranslationAvailable: vi.fn(),
    auth: {
      subjectId: 'user-a',
      role: 'USER',
      deviceId: 'device-a',
      sessionId: 'session-a',
    },
    prisma: {
      $transaction: vi.fn(),
      friendCall,
    },
  };
});

vi.mock('../src/db.js', () => ({ prisma: mocks.prisma }));
vi.mock('../src/auth.js', () => ({
  authenticate: async (request: { auth?: unknown }) => {
    request.auth = { ...mocks.auth };
  },
}));
vi.mock('../src/realtime-hub.js', () => ({
  realtimeHub: () => ({
    emitToSubject: mocks.emitToSubject,
    stopFriendCallTranslation: mocks.stopFriendCallTranslation,
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
    token: Buffer.from(JSON.stringify({
      appid: 'artc-app',
      channelid: channelId,
      userid: userId,
      nonce: '',
      timestamp: 1_900_000_000,
      token: 'a'.repeat(64),
    }), 'utf8').toString('base64'),
    expiresAt: 1_900_000_000,
  })),
}));
vi.mock('../src/services/aliyun-realtime-translation.js', () => ({
  realtimeTranslationAvailable: mocks.realtimeTranslationAvailable,
}));

import { AppError } from '../src/errors.js';
import { registerFriendCallRoutes } from '../src/routes/friend-calls.js';

let app: FastifyInstance | undefined;
const now = new Date();
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
  mediaType: 'AUDIO',
  livenessVersion: 2,
  acceptedAt: null,
  lastHeartbeatAt: null,
  callerHeartbeatAt: null,
  calleeHeartbeatAt: null,
  endedAt: null,
  endedById: null,
  createdAt: now,
  updatedAt: now,
  caller,
  callee,
};
const activeCall = {
  ...ringingCall,
  status: 'ACTIVE',
  acceptedAt: now,
  lastHeartbeatAt: now,
  callerHeartbeatAt: now,
  calleeHeartbeatAt: now,
  calleeDeviceId: 'device-b',
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
  mocks.friendCall.updateManyAndReturn.mockResolvedValue([]);
  mocks.realtimeTranslationAvailable.mockResolvedValue(true);
  Object.assign(mocks.auth, {
    subjectId: 'user-a',
    role: 'USER',
    deviceId: 'device-a',
    sessionId: 'session-a',
  });
  app = Fastify({ logger: false });
  app.setErrorHandler(async (error, _request, reply) => {
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
      data: expect.objectContaining({
        callerDeviceId: 'device-a',
        channelId: expect.stringMatching(/^fc-[a-f0-9]{36}$/),
        mediaType: 'AUDIO',
        livenessVersion: 2,
      }),
    }));
    expect(mocks.friendCall.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
    expect(response.json().data.call.mediaType).toBe('AUDIO');
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-b',
      'friend.call.incoming',
      expect.objectContaining({
        call: expect.objectContaining({ mediaType: 'AUDIO' }),
      }),
    );
  });

  it('persists and publishes a requested video call', async () => {
    const videoCall = { ...ringingCall, mediaType: 'VIDEO' };
    mocks.transaction.friendship.findUnique.mockResolvedValue({ id: 'friendship-1' });
    mocks.friendCall.findFirst.mockResolvedValue(null);
    mocks.friendCall.create.mockResolvedValue(videoCall);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls',
      payload: { friendId: 'user-b', mediaType: 'VIDEO' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.friendCall.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mediaType: 'VIDEO' }),
    }));
    expect(response.json().data.call).toEqual(expect.objectContaining({
      direction: 'OUTGOING',
      mediaType: 'VIDEO',
    }));
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-b',
      'friend.call.incoming',
      expect.objectContaining({
        call: expect.objectContaining({
          direction: 'INCOMING',
          mediaType: 'VIDEO',
        }),
      }),
    );
  });

  it('rejects an unsupported media type before creating the call', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls',
      payload: { friendId: 'user-b', mediaType: 'SCREEN' },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe('VALIDATION_ERROR');
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('stops translation and broadcasts both passive ringing and active expirations', async () => {
    mocks.friendCall.updateManyAndReturn
      .mockResolvedValueOnce([{
        id: 'missed-call',
        callerId: 'user-a',
        calleeId: 'user-b',
        mediaType: 'VIDEO',
      }])
      .mockResolvedValueOnce([{
        id: 'ended-call',
        callerId: 'user-c',
        calleeId: 'user-a',
        mediaType: 'AUDIO',
      }]);
    mocks.friendCall.findFirst.mockResolvedValue(null);

    const response = await app!.inject({
      method: 'GET',
      url: '/v1/friend-calls/active',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.call).toBeNull();
    expect(mocks.stopFriendCallTranslation).toHaveBeenCalledWith('missed-call');
    expect(mocks.stopFriendCallTranslation).toHaveBeenCalledWith('ended-call');
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-b',
      'friend.call.ended',
      { callId: 'missed-call', status: 'MISSED', mediaType: 'VIDEO' },
    );
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-c',
      'friend.call.ended',
      { callId: 'ended-call', status: 'ENDED', mediaType: 'AUDIO' },
    );
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
        mediaType: 'AUDIO',
      }),
    }));
    const update = mocks.friendCall.updateMany.mock.calls[0]?.[0] as { data: object };
    expect(update.data).not.toHaveProperty('callerHeartbeatAt');
    expect(update.data).not.toHaveProperty('calleeHeartbeatAt');
  });

  it('atomically expires a ringing call that is answered after the deadline', async () => {
    const expiredCall = {
      ...ringingCall,
      callerId: 'user-b',
      calleeId: 'user-a',
      createdAt: new Date(Date.now() - 120_000),
    };
    mocks.friendCall.findFirst.mockResolvedValue(expiredCall);
    mocks.friendCall.updateManyAndReturn.mockResolvedValue([{
      id: expiredCall.id,
      callerId: expiredCall.callerId,
      calleeId: expiredCall.calleeId,
      mediaType: expiredCall.mediaType,
    }]);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/respond',
      payload: { action: 'ACCEPT', mediaType: 'AUDIO' },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe('FRIEND_CALL_MISSED');
    expect(mocks.friendCall.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'RINGING',
          createdAt: { lte: expect.any(Date) },
        }),
        data: expect.objectContaining({ status: 'MISSED' }),
      }),
    );
    expect(mocks.friendCall.updateMany).not.toHaveBeenCalled();
    expect(mocks.stopFriendCallTranslation).toHaveBeenCalledWith('call-1');
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-a',
      'friend.call.ended',
      { callId: 'call-1', status: 'MISSED', mediaType: 'AUDIO' },
    );
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-b',
      'friend.call.ended',
      { callId: 'call-1', status: 'MISSED', mediaType: 'AUDIO' },
    );
  });

  it('allows a video call to be accepted as audio and publishes the final type', async () => {
    mocks.friendCall.findFirst.mockResolvedValue({
      ...ringingCall,
      callerId: 'user-b',
      calleeId: 'user-a',
      mediaType: 'VIDEO',
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/respond',
      payload: { action: 'ACCEPT', mediaType: 'AUDIO' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.friendCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'ACTIVE', mediaType: 'AUDIO' }),
    }));
    expect(response.json().data.call.mediaType).toBe('AUDIO');
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-b',
      'friend.call.accepted',
      expect.objectContaining({
        call: expect.objectContaining({ mediaType: 'AUDIO' }),
      }),
    );
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-a',
      'friend.call.accepted',
      expect.objectContaining({
        respondedDeviceId: 'device-a',
        call: expect.objectContaining({ mediaType: 'AUDIO' }),
      }),
    );
  });

  it('defaults an omitted answer media type to audio for older clients', async () => {
    mocks.friendCall.findFirst.mockResolvedValue({
      ...ringingCall,
      callerId: 'user-b',
      calleeId: 'user-a',
      mediaType: 'VIDEO',
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/respond',
      payload: { action: 'ACCEPT' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.friendCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mediaType: 'AUDIO' }),
    }));
    expect(response.json().data.call.mediaType).toBe('AUDIO');
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-b',
      'friend.call.accepted',
      expect.objectContaining({
        call: expect.objectContaining({ mediaType: 'AUDIO' }),
      }),
    );
  });

  it('keeps video only when the answering client explicitly accepts video', async () => {
    mocks.friendCall.findFirst.mockResolvedValue({
      ...ringingCall,
      callerId: 'user-b',
      calleeId: 'user-a',
      mediaType: 'VIDEO',
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/respond',
      payload: { action: 'ACCEPT', mediaType: 'VIDEO' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.friendCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mediaType: 'VIDEO' }),
    }));
    expect(response.json().data.call.mediaType).toBe('VIDEO');
  });

  it('does not allow an audio call to be upgraded to video while accepting', async () => {
    mocks.friendCall.findFirst.mockResolvedValue({
      ...ringingCall,
      callerId: 'user-b',
      calleeId: 'user-a',
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/respond',
      payload: { action: 'ACCEPT', mediaType: 'VIDEO' },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe('FRIEND_CALL_MEDIA_UPGRADE_NOT_ALLOWED');
    expect(mocks.friendCall.updateMany).not.toHaveBeenCalled();
    expect(mocks.emitToSubject).not.toHaveBeenCalled();
  });

  it('includes the media type when notifying the peer that a call ended', async () => {
    mocks.friendCall.findFirst.mockResolvedValue({ ...ringingCall, mediaType: 'VIDEO' });
    mocks.friendCall.updateManyAndReturn.mockResolvedValue([{
      id: 'call-1',
      callerId: 'user-a',
      calleeId: 'user-b',
      mediaType: 'VIDEO',
    }]);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/end',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual({
      id: 'call-1',
      status: 'CANCELLED',
      mediaType: 'VIDEO',
    });
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-b',
      'friend.call.ended',
      { callId: 'call-1', status: 'CANCELLED', mediaType: 'VIDEO' },
    );
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-a',
      'friend.call.ended',
      { callId: 'call-1', status: 'CANCELLED', mediaType: 'VIDEO' },
    );
  });

  it('publishes the media type returned by the winning concurrent end update', async () => {
    mocks.friendCall.findFirst.mockResolvedValue({ ...ringingCall, mediaType: 'VIDEO' });
    mocks.friendCall.updateManyAndReturn
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'call-1',
        callerId: 'user-a',
        calleeId: 'user-b',
        mediaType: 'AUDIO',
      }]);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/end',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual({
      id: 'call-1',
      status: 'ENDED',
      mediaType: 'AUDIO',
    });
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-b',
      'friend.call.ended',
      { callId: 'call-1', status: 'ENDED', mediaType: 'AUDIO' },
    );
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

  it('returns matching ARTC fields without exposing the server AppKey', async () => {
    mocks.friendCall.findFirst.mockResolvedValue({
      ...activeCall,
      channelId: 'fc_channel-1',
    });
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/rtc-credential',
    });

    expect(response.statusCode, response.body).toBe(200);
    const credential = response.json().data.credential as {
      channelId: string;
      userId: string;
      token: string;
      expiresAt: number;
      mediaType: string;
    };
    const payload = JSON.parse(Buffer.from(credential.token, 'base64').toString('utf8'));
    expect(payload.channelid).toBe(credential.channelId);
    expect(payload.userid).toBe(credential.userId);
    expect(payload.timestamp).toBe(credential.expiresAt);
    expect(credential.mediaType).toBe('AUDIO');
    expect(response.body).not.toContain('server-secret');
    expect(response.body).not.toContain('appKey');
  });

  it('rejects an RTC credential request whose expected media type is stale', async () => {
    mocks.friendCall.findFirst.mockResolvedValue({
      ...activeCall,
      mediaType: 'AUDIO',
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/rtc-credential',
      payload: { mediaType: 'VIDEO' },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe('FRIEND_CALL_MEDIA_TYPE_CHANGED');
    expect(mocks.friendCall.updateMany).not.toHaveBeenCalled();
  });

  it('keeps base RTC available when the optional translation probe fails', async () => {
    mocks.friendCall.findFirst.mockResolvedValue(activeCall);
    mocks.realtimeTranslationAvailable.mockRejectedValueOnce(
      new Error('translation configuration unavailable'),
    );

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/rtc-credential',
      payload: { mediaType: 'AUDIO' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.credential).toEqual(expect.objectContaining({
      mediaType: 'AUDIO',
      realtimeTranslationAvailable: false,
    }));
  });

  it('refreshes an active call heartbeat only for the owning device', async () => {
    mocks.friendCall.findFirst.mockResolvedValue(activeCall);
    mocks.friendCall.updateMany.mockResolvedValue({ count: 1 });
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/heartbeat',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.friendCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'ACTIVE' }),
      data: {
        lastHeartbeatAt: expect.any(Date),
        callerHeartbeatAt: expect.any(Date),
      },
    }));
  });

  it('allows a strict call to establish the first side heartbeat during peer grace', async () => {
    mocks.friendCall.findFirst.mockResolvedValue({
      ...activeCall,
      callerHeartbeatAt: null,
      calleeHeartbeatAt: null,
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/heartbeat',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.friendCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        lastHeartbeatAt: expect.any(Date),
        callerHeartbeatAt: expect.any(Date),
      },
    }));
  });

  it('ends a strict call when one side never heartbeats past peer grace', async () => {
    const staleAcceptedAt = new Date(Date.now() - 120_000);
    mocks.friendCall.findFirst.mockResolvedValue({
      ...activeCall,
      acceptedAt: staleAcceptedAt,
      callerHeartbeatAt: new Date(),
      calleeHeartbeatAt: null,
    });
    mocks.friendCall.updateManyAndReturn.mockResolvedValue([{
      id: 'call-1',
      callerId: 'user-a',
      calleeId: 'user-b',
      mediaType: 'AUDIO',
    }]);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/heartbeat',
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().code).toBe('ACTIVE_FRIEND_CALL_NOT_FOUND');
    expect(mocks.friendCall.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'call-1', status: 'ACTIVE' }),
        data: expect.objectContaining({ status: 'ENDED' }),
      }),
    );
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-b',
      'friend.call.ended',
      { callId: 'call-1', status: 'ENDED', mediaType: 'AUDIO' },
    );
  });

  it('keeps migrated version-one calls on the shared heartbeat compatibility path', async () => {
    mocks.friendCall.findFirst.mockResolvedValue({
      ...activeCall,
      livenessVersion: 1,
      callerHeartbeatAt: null,
      calleeHeartbeatAt: null,
      lastHeartbeatAt: new Date(),
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/friend-calls/call-1/heartbeat',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.friendCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { lastHeartbeatAt: expect.any(Date) },
    }));
  });
});
