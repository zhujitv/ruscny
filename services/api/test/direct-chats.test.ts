import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transaction = {
    $queryRaw: vi.fn(),
    conversation: { findUnique: vi.fn(), create: vi.fn() },
    user: { findMany: vi.fn() },
    contact: { findFirst: vi.fn(), create: vi.fn() },
    friendship: { deleteMany: vi.fn() },
    friendRequest: { deleteMany: vi.fn() },
    friendCall: { updateManyAndReturn: vi.fn() },
  };
  return {
    transaction,
    emitToSubject: vi.fn(),
    disconnectDirectChatParticipant: vi.fn(),
    prisma: {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) =>
        callback(transaction)),
      conversation: { findMany: vi.fn() },
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
    disconnectDirectChatParticipant: mocks.disconnectDirectChatParticipant,
    stopFriendCallTranslation: vi.fn(),
    isSubjectOnline: vi.fn().mockResolvedValue(false),
  }),
}));
vi.mock('../src/services/conversations.js', () => ({
  conversationInclude: {},
  conversationDto: (conversation: Record<string, unknown>) => ({
    id: conversation.id,
    kind: conversation.kind,
    roomToken: '',
    roomCode: '',
    capabilities: {
      documentExport: false,
      aiSummary: false,
      summaryDistribution: false,
    },
  }),
  participantDto: (value: unknown) => value,
}));

import { AppError } from '../src/errors.js';
import { registerSocialRoutes } from '../src/routes/social.js';

let app: FastifyInstance | undefined;

const directConversation = {
  id: 'direct-a-b',
  kind: 'DIRECT',
  directPairKey: 'user-a:user-b',
};

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof mocks.transaction) => unknown) =>
      callback(mocks.transaction),
  );
  mocks.transaction.$queryRaw.mockResolvedValue([
    { id: 'user-a', status: 'ACTIVE' },
    { id: 'user-b', status: 'ACTIVE' },
  ]);
  mocks.transaction.friendCall.updateManyAndReturn.mockResolvedValue([]);
  app = Fastify({ logger: false });
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof AppError) {
      await reply.code(error.statusCode).send({ ok: false, code: error.code });
      return;
    }
    throw error;
  });
  await registerSocialRoutes(app);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('friend direct chats', () => {
  it('disconnects both direct-chat participants when the friendship ends', async () => {
    mocks.transaction.conversation.findUnique.mockResolvedValue({
      id: 'direct-a-b',
      participants: [{ id: 'participant-a' }, { id: 'participant-b' }],
    });
    mocks.transaction.friendship.deleteMany.mockResolvedValue({ count: 1 });
    mocks.transaction.friendRequest.deleteMany.mockResolvedValue({ count: 2 });
    mocks.transaction.friendCall.updateManyAndReturn.mockResolvedValue([{
      id: 'call-a-b',
      callerId: 'user-a',
      calleeId: 'user-b',
      mediaType: 'VIDEO',
    }]);

    const response = await app!.inject({
      method: 'DELETE',
      url: '/v1/friends/user-b',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.disconnectDirectChatParticipant).toHaveBeenCalledTimes(2);
    expect(mocks.disconnectDirectChatParticipant).toHaveBeenCalledWith(
      'direct-a-b',
      'participant-a',
    );
    expect(mocks.disconnectDirectChatParticipant).toHaveBeenCalledWith(
      'direct-a-b',
      'participant-b',
    );
    expect(mocks.transaction.friendCall.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['RINGING', 'ACTIVE'] } }),
        select: { id: true, callerId: true, calleeId: true, mediaType: true },
      }),
    );
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-b',
      'friend.call.ended',
      { callId: 'call-a-b', status: 'ENDED', mediaType: 'VIDEO' },
    );
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-a',
      'friend.call.ended',
      { callId: 'call-a-b', status: 'ENDED', mediaType: 'VIDEO' },
    );
  });

  it('requires an active friendship before opening a direct chat', async () => {
    mocks.transaction.$queryRaw
      .mockResolvedValueOnce([
        { id: 'user-a', status: 'ACTIVE' },
        { id: 'user-b', status: 'ACTIVE' },
      ])
      .mockResolvedValueOnce([]);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/direct-chats/user-b',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('FRIEND_REQUIRED');
    expect(mocks.transaction.conversation.create).not.toHaveBeenCalled();
  });

  it('reuses the single direct chat for the same canonical friend pair', async () => {
    mocks.transaction.$queryRaw
      .mockResolvedValueOnce([
        { id: 'user-a', status: 'ACTIVE' },
        { id: 'user-b', status: 'ACTIVE' },
      ])
      .mockResolvedValueOnce([{ id: 'friendship-a-b' }]);
    mocks.transaction.conversation.findUnique.mockResolvedValue(directConversation);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/direct-chats/user-b',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.conversation).toMatchObject({
      id: directConversation.id,
      kind: 'DIRECT',
      roomToken: '',
      roomCode: '',
      capabilities: {
        documentExport: false,
        aiSummary: false,
        summaryDistribution: false,
      },
    });
    expect(mocks.transaction.conversation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { directPairKey: 'user-a:user-b' } }),
    );
    expect(mocks.transaction.conversation.create).not.toHaveBeenCalled();
  });

  it('creates a permanent active translation chat without exposing meeting credentials', async () => {
    mocks.transaction.$queryRaw
      .mockResolvedValueOnce([
        { id: 'user-a', status: 'ACTIVE' },
        { id: 'user-b', status: 'ACTIVE' },
      ])
      .mockResolvedValueOnce([{ id: 'friendship-a-b' }]);
    mocks.transaction.conversation.findUnique.mockResolvedValue(null);
    mocks.transaction.user.findMany.mockResolvedValue([
      {
        id: 'user-a',
        displayName: '王伟',
        company: 'CN Trade',
        email: 'a@example.test',
        preferredLanguage: 'zh',
      },
      {
        id: 'user-b',
        displayName: 'Иван',
        company: 'RU Trade',
        email: 'b@example.test',
        preferredLanguage: 'ru',
      },
    ]);
    mocks.transaction.contact.findFirst.mockResolvedValue(null);
    mocks.transaction.contact.create.mockResolvedValue({ id: 'contact-b' });
    mocks.transaction.conversation.create.mockResolvedValue(directConversation);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/direct-chats/user-b',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.transaction.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'DIRECT',
          directPairKey: 'user-a:user-b',
          status: 'ACTIVE',
          guestHistoryPolicy: 'PERMANENT',
          participants: {
            create: expect.arrayContaining([
              expect.objectContaining({ userId: 'user-a', role: 'HOST' }),
              expect.objectContaining({ userId: 'user-b', role: 'GUEST' }),
            ]),
          },
        }),
      }),
    );
    expect(response.json().data.conversation.roomToken).toBe('');
    expect(response.json().data.conversation.roomCode).toBe('');
    expect(mocks.emitToSubject).toHaveBeenCalledWith(
      'user-b',
      'direct.chat.ready',
      { conversationId: directConversation.id },
    );
  });
});
