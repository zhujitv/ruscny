import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

type Handler = (...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  connectionHandler: undefined as Handler | undefined,
  closeHook: undefined as (() => Promise<void>) | undefined,
  io: {
    adapter: vi.fn(),
    use: vi.fn(),
    on: vi.fn(),
    in: vi.fn(),
    close: vi.fn(),
    sockets: { sockets: new Map() },
  },
  roomTarget: {
    fetchSockets: vi.fn(),
    disconnectSockets: vi.fn(),
  },
  app: {
    server: {},
    log: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    addHook: vi.fn(),
  },
  prisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    conversation: { updateMany: vi.fn() },
    participant: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
    friendship: { findMany: vi.fn() },
    translationMessage: { findMany: vi.fn() },
  },
  validateAuthContext: vi.fn(),
  getConversationForAuth: vi.fn(),
  assertDirectConversationLiveAccess: vi.fn(),
  getParticipant: vi.fn(),
  recoverStaleProcessingMessages: vi.fn(),
  setRealtimeHub: vi.fn(),
}));

vi.mock('socket.io', () => ({
  Server: vi.fn(function MockSocketIoServer() {
    return mocks.io;
  }),
}));
vi.mock('../src/config.js', () => ({
  config: {
    CORS_ORIGINS: '',
    NODE_ENV: 'test',
    REDIS_URL: undefined,
  },
}));
vi.mock('../src/db.js', () => ({ prisma: mocks.prisma }));
vi.mock('../src/auth.js', () => ({ validateAuthContext: mocks.validateAuthContext }));
vi.mock('../src/lib/tokens.js', () => ({ verifyAccessToken: vi.fn() }));
vi.mock('../src/realtime-hub.js', () => ({ setRealtimeHub: mocks.setRealtimeHub }));
vi.mock('../src/services/conversations.js', () => ({
  getConversationForAuth: mocks.getConversationForAuth,
  assertDirectConversationLiveAccess: mocks.assertDirectConversationLiveAccess,
  getParticipant: mocks.getParticipant,
  messageDto: (message: unknown) => message,
  participantDto: (value: unknown) => value,
}));
vi.mock('../src/services/message-processing.js', () => ({
  recoverStaleProcessingMessages: mocks.recoverStaleProcessingMessages,
}));

import { AppError } from '../src/errors.js';
import { attachRealtime, validateSocketAndJoinedRooms } from '../src/realtime.js';

const conversationId = 'conversation-a';
const conversationRoom = `conversation:${conversationId}`;
const participant = {
  id: 'participant-a',
  role: 'GUEST',
  displayName: 'Ivan',
  joinedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function guestIdentity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'guest-a',
    sessionId: 'session-a',
    deviceId: 'device-a',
    conversationId,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    ...overrides,
  };
}

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: conversationId,
    status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 60_000),
    maxSequence: 0,
    ...overrides,
  };
}

function connectSocket() {
  const handlers = new Map<string, Handler>();
  const onceHandlers = new Map<string, Handler>();
  const socket = {
    id: 'socket-a',
    data: {
      auth: {
        subjectId: 'guest-a',
        guestIdentityId: 'guest-a',
        conversationId,
        role: 'GUEST',
        deviceId: 'device-a',
        sessionId: 'session-a',
      },
      tokenExpiresAt: Date.now() + 60_000,
      participantIds: {},
    },
    on: vi.fn(),
    once: vi.fn(),
    use: vi.fn(),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
  socket.on.mockImplementation((event: string, handler: Handler) => {
    handlers.set(event, handler);
    return socket;
  });
  socket.once.mockImplementation((event: string, handler: Handler) => {
    onceHandlers.set(event, handler);
    return socket;
  });
  mocks.connectionHandler?.(socket);
  return { handlers, onceHandlers, socket };
}

async function joinRoom() {
  const connected = connectSocket();
  const acknowledge = vi.fn();
  const handler = connected.handlers.get('room.join');
  if (!handler) throw new Error('room.join handler was not registered');
  await handler({ conversationId, lastSequence: 0 }, acknowledge);
  return { ...connected, acknowledge };
}

function expectRejectedJoin(
  result: Awaited<ReturnType<typeof joinRoom>>,
  error: { code: string; message: string },
) {
  expect(result.socket.join).toHaveBeenCalledWith(conversationRoom);
  expect(result.socket.leave).toHaveBeenCalledTimes(1);
  expect(result.socket.leave).toHaveBeenCalledWith(conversationRoom);
  expect(result.acknowledge).toHaveBeenCalledWith({ ok: false, error });
  expect(result.socket.emit).toHaveBeenCalledWith('room.error', error);
  expect(result.acknowledge.mock.calls.some(([value]) => value?.ok === true)).toBe(false);
  expect(result.socket.emit.mock.calls.some(([event]) => event === 'room.joined')).toBe(false);
  const conversationJoinOrder = result.socket.join.mock.invocationCallOrder[1];
  const leaveOrder = result.socket.leave.mock.invocationCallOrder[0];
  const acknowledgeOrder = result.acknowledge.mock.invocationCallOrder[0];
  expect(conversationJoinOrder).toBeLessThan(leaveOrder);
  expect(leaveOrder).toBeLessThan(acknowledgeOrder);
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.connectionHandler = undefined;
  mocks.closeHook = undefined;
  mocks.io.on.mockImplementation((event: string, handler: Handler) => {
    if (event === 'connection') mocks.connectionHandler = handler;
    return mocks.io;
  });
  mocks.io.in.mockReturnValue(mocks.roomTarget);
  mocks.io.close.mockResolvedValue(undefined);
  mocks.io.sockets.sockets.clear();
  mocks.roomTarget.fetchSockets.mockResolvedValue([]);
  mocks.app.addHook.mockImplementation((name: string, hook: () => Promise<void>) => {
    if (name === 'onClose') mocks.closeHook = hook;
    return mocks.app;
  });
  mocks.prisma.conversation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.participant.findMany.mockResolvedValue([]);
  mocks.prisma.participant.findUnique.mockResolvedValue(participant);
  mocks.prisma.participant.findUniqueOrThrow.mockResolvedValue(participant);
  mocks.prisma.participant.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.translationMessage.findMany.mockResolvedValue([]);
  mocks.prisma.friendship.findMany.mockResolvedValue([]);
  mocks.prisma.$transaction.mockImplementation(async (callback: Handler) =>
    callback(mocks.prisma));
  mocks.prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = Array.from(strings).join('?');
    if (sql.includes('FROM "Conversation"')) return [conversation()];
    if (sql.includes('FROM "GuestIdentity"')) return [guestIdentity()];
    if (sql.includes('FROM "UserDevice"')) {
      return [{ sessionId: 'session-a', revokedAt: null }];
    }
    if (sql.includes('FROM "User"')) return [{ id: 'user-a', status: 'ACTIVE' }];
    if (sql.includes('FROM "Participant"')) {
      return [{
        ...participant,
        userId: null,
        guestIdentityId: 'guest-a',
        removedAt: null,
        leftAt: null,
        presence: 'OFFLINE',
      }];
    }
    return [];
  });
  mocks.recoverStaleProcessingMessages.mockResolvedValue(0);
  mocks.validateAuthContext.mockResolvedValue(undefined);
  mocks.getConversationForAuth.mockResolvedValue(conversation());
  mocks.getParticipant.mockResolvedValue(participant);
  await attachRealtime(mocks.app as unknown as FastifyInstance);
});

afterEach(async () => {
  await mocks.closeHook?.();
});

describe('room.join post-join authoritative revalidation', () => {
  it('rejects overlapping joins on the same socket without starting duplicate database work', async () => {
    const connected = connectSocket();
    const handler = connected.handlers.get('room.join');
    if (!handler) throw new Error('room.join handler was not registered');
    let releaseConversation!: (value: ReturnType<typeof conversation>) => void;
    mocks.getConversationForAuth.mockImplementationOnce(() => new Promise((resolve) => {
      releaseConversation = resolve;
    }));
    const firstAcknowledge = vi.fn();
    const secondAcknowledge = vi.fn();

    const firstJoin = handler({ conversationId, lastSequence: 0 }, firstAcknowledge);
    await Promise.resolve();
    await handler({ conversationId, lastSequence: 0 }, secondAcknowledge);

    expect(secondAcknowledge).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'ROOM_JOIN_IN_PROGRESS', message: '正在加入该会议' },
    });
    expect(mocks.getConversationForAuth).toHaveBeenCalledTimes(1);

    releaseConversation(conversation());
    await firstJoin;
    expect(firstAcknowledge).toHaveBeenCalledWith({
      ok: true,
      data: expect.objectContaining({ conversationId }),
    });
    connected.onceHandlers.get('disconnect')?.();
  });

  it('recovers crashed attempts before reading the backfill snapshot', async () => {
    mocks.getConversationForAuth.mockResolvedValue(conversation({ maxSequence: 1 }));
    mocks.prisma.$queryRaw.mockResolvedValueOnce([conversation({ maxSequence: 1 })]);
    mocks.prisma.translationMessage.findMany.mockResolvedValue([
      {
        id: 'message-a',
        conversationId,
        sequence: 1,
        status: 'FAILED',
        errorCode: 'PROCESSING_TIMEOUT',
      },
    ]);

    const result = await joinRoom();

    expect(mocks.recoverStaleProcessingMessages).toHaveBeenCalledWith(conversationId);
    expect(mocks.recoverStaleProcessingMessages.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prisma.translationMessage.findMany.mock.invocationCallOrder[0]!,
    );
    expect(result.acknowledge).toHaveBeenCalledWith({
      ok: true,
      data: expect.objectContaining({
        latestSequence: 1,
        missingMessages: [expect.objectContaining({
          sequence: 1,
          status: 'FAILED',
          errorCode: 'PROCESSING_TIMEOUT',
        })],
      }),
    });
    result.onceHandlers.get('disconnect')?.();
  });

  it.each([
    ['ended', { status: 'ENDED' }],
    ['expired', { status: 'EXPIRED' }],
    ['past its expiry time', { status: 'ACTIVE', expiresAt: new Date(0) }],
  ])('leaves without a successful response when the room has %s after socket.join', async (
    _label,
    terminalState,
  ) => {
    mocks.prisma.$queryRaw.mockResolvedValueOnce([conversation(terminalState)]);

    const result = await joinRoom();

    expect(mocks.getConversationForAuth).toHaveBeenCalledTimes(1);
    expect(result.socket.join.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.prisma.$queryRaw.mock.invocationCallOrder[0]!,
    );
    expectRejectedJoin(result, {
      code: 'ROOM_EXPIRED',
      message: '房间已结束或过期',
    });
    expect(mocks.prisma.participant.updateMany).not.toHaveBeenCalled();
    result.onceHandlers.get('disconnect')?.();
  });

  it('leaves without a successful response when membership is removed after socket.join', async () => {
    mocks.prisma.$queryRaw
      .mockResolvedValueOnce([conversation()])
      .mockResolvedValueOnce([guestIdentity()])
      .mockResolvedValueOnce([{
        ...participant,
        userId: null,
        guestIdentityId: 'guest-a',
        removedAt: new Date(),
        leftAt: null,
        presence: 'REMOVED',
      }]);

    const result = await joinRoom();

    expect(mocks.getParticipant).toHaveBeenCalledTimes(1);
    expect(result.socket.join.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.prisma.$queryRaw.mock.invocationCallOrder[1]!,
    );
    expectRejectedJoin(result, {
      code: 'NOT_A_PARTICIPANT',
      message: '您不是该会议参与者',
    });
    expect(mocks.prisma.participant.updateMany).not.toHaveBeenCalled();
    result.onceHandlers.get('disconnect')?.();
  });

  it('leaves when removal wins after the final membership read', async () => {
    mocks.getConversationForAuth.mockResolvedValue(conversation());
    mocks.prisma.participant.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await joinRoom();

    expect(mocks.prisma.participant.updateMany).toHaveBeenCalledWith({
      where: {
        id: participant.id,
        conversationId,
        removedAt: null,
        leftAt: null,
        presence: { in: ['ONLINE', 'OFFLINE'] },
      },
      data: { lastSeenAt: expect.any(Date), presence: 'ONLINE' },
    });
    expectRejectedJoin(result, {
      code: 'NOT_A_PARTICIPANT',
      message: '您不是该会议参与者',
    });
    result.onceHandlers.get('disconnect')?.();
  });

  it('leaves without a successful response when auth is revoked after socket.join', async () => {
    mocks.getConversationForAuth.mockResolvedValue(conversation());
    mocks.validateAuthContext
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AppError(401, 'DEVICE_REVOKED', '此设备登录已被撤销'));

    const result = await joinRoom();

    expect(mocks.validateAuthContext).toHaveBeenCalledTimes(2);
    expect(result.socket.join.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.validateAuthContext.mock.invocationCallOrder[1]!,
    );
    expectRejectedJoin(result, {
      code: 'DEVICE_REVOKED',
      message: '此设备登录已被撤销',
    });
    expect(mocks.prisma.participant.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.participant.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: participant.id,
        conversationId,
        removedAt: null,
        leftAt: null,
        presence: 'ONLINE',
      },
      data: { presence: 'OFFLINE', lastSeenAt: expect.any(Date) },
    });
    result.onceHandlers.get('disconnect')?.();
  });
});

describe('continuous joined-room authorization', () => {
  it('rejects a Socket whose joined conversation has expired', async () => {
    mocks.getConversationForAuth.mockResolvedValue(
      conversation({ status: 'EXPIRED' }),
    );

    await expect(
      validateSocketAndJoinedRooms(
        {
          auth: {
            subjectId: 'guest-a',
            guestIdentityId: 'guest-a',
            conversationId,
            role: 'GUEST',
            deviceId: 'device-a',
            sessionId: 'session-a',
          },
          tokenExpiresAt: Date.now() + 60_000,
        },
        new Set(['socket-a', 'auth:subject:guest-a', conversationRoom]),
      ),
    ).rejects.toMatchObject({ code: 'ROOM_EXPIRED', statusCode: 403 });
    expect(mocks.getConversationForAuth).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: 'guest-a' }),
      conversationId,
      { history: true },
    );
  });

  it('rejects a LEFT participant even when that identity may still read HTTP history', async () => {
    mocks.getConversationForAuth.mockResolvedValue(conversation());
    mocks.getParticipant.mockRejectedValue(
      new AppError(403, 'NOT_A_PARTICIPANT', '您不是该会议参与者'),
    );

    await expect(
      validateSocketAndJoinedRooms(
        {
          auth: {
            subjectId: 'guest-a',
            guestIdentityId: 'guest-a',
            conversationId,
            role: 'GUEST',
            deviceId: 'device-a',
            sessionId: 'session-a',
          },
          tokenExpiresAt: Date.now() + 60_000,
        },
        new Set(['socket-a', conversationRoom]),
      ),
    ).rejects.toMatchObject({ code: 'NOT_A_PARTICIPANT', statusCode: 403 });
  });
});

describe('per-socket leave and distributed disconnect failure handling', () => {
  it('keeps the participant ONLINE when another socket remains in the room', async () => {
    const connected = connectSocket();
    connected.socket.data.participantIds[conversationId] = participant.id;
    mocks.roomTarget.fetchSockets.mockResolvedValue([{
      id: 'socket-b',
      data: { participantIds: { [conversationId]: participant.id } },
    }]);
    const handler = connected.handlers.get('room.leave');
    if (!handler) throw new Error('room.leave handler was not registered');

    await handler({ conversationId });

    expect(connected.socket.leave).toHaveBeenCalledWith(conversationRoom);
    expect(mocks.prisma.participant.updateMany).not.toHaveBeenCalled();
    expect(connected.socket.data.participantIds[conversationId]).toBeUndefined();
  });

  it('marks the participant OFFLINE, not LEFT, after its last room socket leaves', async () => {
    const connected = connectSocket();
    connected.socket.data.participantIds[conversationId] = participant.id;
    mocks.roomTarget.fetchSockets.mockResolvedValue([]);
    const handler = connected.handlers.get('room.leave');
    if (!handler) throw new Error('room.leave handler was not registered');

    await handler({ conversationId });

    expect(mocks.prisma.participant.updateMany).toHaveBeenCalledWith({
      where: {
        id: participant.id,
        conversationId,
        removedAt: null,
        leftAt: null,
        presence: 'ONLINE',
      },
      data: { presence: 'OFFLINE', lastSeenAt: expect.any(Date) },
    });
  });

  it('catches a Redis fetch failure and disconnects matching local sockets', async () => {
    const connected = connectSocket();
    connected.socket.data.participantIds[conversationId] = participant.id;
    mocks.io.sockets.sockets.set(connected.socket.id, connected.socket);
    mocks.roomTarget.fetchSockets.mockRejectedValueOnce(new Error('redis unavailable'));
    const hub = mocks.setRealtimeHub.mock.calls[0]![0] as {
      disconnectParticipant(conversationId: string, participantId: string): Promise<boolean>;
    };

    await expect(hub.disconnectParticipant(conversationId, participant.id)).resolves.toBe(true);

    expect(connected.socket.emit).toHaveBeenCalledWith('participant.removed', {
      conversationId,
      participantId: participant.id,
    });
    expect(connected.socket.disconnect).toHaveBeenCalledWith(true);
    expect(mocks.app.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId, participantId: participant.id }),
      'Distributed participant disconnect failed; applying local fallback',
    );
  });
});
