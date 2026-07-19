import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const mocks = vi.hoisted(() => {
  const state = { role: 'USER' as 'USER' | 'GUEST' };
  const transaction = {
    $queryRaw: vi.fn(),
    participant: { findMany: vi.fn(), updateMany: vi.fn() },
    conversation: { findMany: vi.fn(), updateMany: vi.fn() },
    conversationSummary: { findMany: vi.fn(), update: vi.fn() },
    summaryEmailRecipient: { updateMany: vi.fn() },
    translationMessage: { updateMany: vi.fn() },
    messageCorrection: { updateMany: vi.fn() },
    guestIdentity: { updateMany: vi.fn() },
    meetingInvitation: { updateMany: vi.fn(), deleteMany: vi.fn() },
    contact: { updateMany: vi.fn() },
    friendRequest: { deleteMany: vi.fn() },
    friendship: { deleteMany: vi.fn() },
    glossaryTerm: { deleteMany: vi.fn() },
    userDevice: { updateMany: vi.fn() },
    user: { updateMany: vi.fn() },
    dataDeletionRequest: { upsert: vi.fn() },
  };
  return {
    state,
    transaction,
    emitToConversation: vi.fn(),
    disconnectSubject: vi.fn(),
    prisma: {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) =>
        callback(transaction)),
      user: { findUnique: vi.fn(), update: vi.fn() },
      systemSetting: { findUnique: vi.fn() },
    },
  };
});

vi.mock('../src/db.js', () => ({ prisma: mocks.prisma }));
vi.mock('../src/auth.js', () => ({
  authenticate: async (request: { auth?: unknown }) => {
    request.auth = {
      subjectId: mocks.state.role === 'GUEST' ? 'guest-a' : 'user-a',
      role: mocks.state.role,
      deviceId: 'device-a',
      sessionId: mocks.state.role === 'GUEST' ? 'guest-session-a' : 'session-a',
      ...(mocks.state.role === 'GUEST'
        ? { guestIdentityId: 'guest-a', conversationId: 'conversation-a' }
        : {}),
    };
  },
}));
vi.mock('../src/realtime-hub.js', () => ({
  realtimeHub: () => ({
    emitToConversation: mocks.emitToConversation,
    emitToSubject: vi.fn(),
    disconnectDevice: vi.fn(),
    disconnectSubject: mocks.disconnectSubject,
    disconnectParticipant: vi.fn(),
    isSubjectOnline: async () => false,
    isReady: () => true,
  }),
}));
vi.mock('../src/services/audio-assets.js', () => ({
  playableAudioUrl: (value: string | null) => value,
}));

import { AppError } from '../src/errors.js';
import { registerAuthRoutes } from '../src/routes/auth.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/services/passwords.js';

let app: FastifyInstance | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.role = 'USER';
  mocks.prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof mocks.transaction) => unknown) => callback(mocks.transaction),
  );
  mocks.prisma.user.findUnique.mockResolvedValue({
    status: 'ACTIVE',
    passwordHash: 'v2:stored-password-hash',
    devices: [{ authenticatedAt: new Date() }],
  });
  mocks.transaction.$queryRaw.mockResolvedValue([{ id: 'conversation-a' }]);
  mocks.transaction.conversation.findMany.mockResolvedValue([]);
  mocks.transaction.participant.findMany.mockResolvedValue([]);
  mocks.transaction.conversationSummary.findMany.mockResolvedValue([]);
  mocks.transaction.user.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.conversation.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.guestIdentity.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.dataDeletionRequest.upsert.mockResolvedValue({ id: 'deletion-a' });
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
    if (error instanceof ZodError) {
      await reply.code(400).send({ ok: false, code: 'VALIDATION_ERROR' });
      return;
    }
    throw error;
  });
  await registerAuthRoutes(instance);
  return instance;
}

describe('account deletion preserves shared meeting records', () => {
  it('soft-deletes a recently authenticated customer and detaches identity links', async () => {
    mocks.transaction.conversation.findMany.mockResolvedValue([
      {
        id: 'conversation-a',
        ownerId: 'host-a',
        status: 'ENDED',
        guestHistoryPolicy: 'ACCESS_FOR_24_HOURS',
      },
    ]);
    app = await createApp();

    const response = await app.inject({ method: 'DELETE', url: '/v1/auth/account' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: {} });
    expect(mocks.transaction.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'user-a',
        status: 'ACTIVE',
        passwordHash: 'v2:stored-password-hash',
      },
      data: expect.objectContaining({
        status: 'DELETED',
        deletedAt: expect.any(Date),
        email: null,
        phone: null,
        passwordHash: null,
      }),
    });
    expect(mocks.transaction.translationMessage.updateMany).toHaveBeenCalledWith({
      where: {
        participant: { userId: 'user-a' },
        status: 'PROCESSING',
      },
      data: {
        status: 'FAILED',
        errorCode: 'ACCOUNT_DELETED',
        errorMessage: '发言者已注销账号',
        updatedAt: expect.any(Date),
      },
    });
    expect(mocks.transaction.translationMessage.updateMany).toHaveBeenCalledWith({
      where: { participant: { userId: 'user-a' } },
      data: expect.objectContaining({ speakerCompany: null }),
    });
    expect(mocks.transaction.messageCorrection.updateMany).toHaveBeenNthCalledWith(1, {
      where: { OR: [{ actorSubjectId: 'user-a' }] },
      data: {
        actorDisplayName: 'Deleted user user-a',
        actorCompany: null,
      },
    });
    expect(mocks.transaction.messageCorrection.updateMany).toHaveBeenNthCalledWith(2, {
      where: { OR: [{ decidedBySubjectId: 'user-a' }] },
      data: { deciderDisplayName: 'Deleted user user-a' },
    });
    expect(mocks.transaction.participant.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-a' },
      data: expect.objectContaining({ userId: null, presence: 'LEFT' }),
    });
    expect(mocks.disconnectSubject).toHaveBeenCalledWith('user-a');
  });

  it('anonymizes persisted summary speaker and assignee snapshots', async () => {
    mocks.transaction.conversation.findMany.mockResolvedValue([
      {
        id: 'conversation-a',
        ownerId: 'host-a',
        status: 'ENDED',
        guestHistoryPolicy: 'ACCESS_FOR_24_HOURS',
      },
    ]);
    mocks.transaction.participant.findMany.mockResolvedValue([
      {
        id: 'participant-a',
        conversationId: 'conversation-a',
        displayName: 'Ivan',
        company: 'RU Trade',
      },
    ]);
    const empty = [];
    mocks.transaction.conversationSummary.findMany.mockResolvedValue([
      {
        id: 'summary-a',
        summary: 'Ivan from RU Trade confirmed the order',
        participantRoster: [{
          id: 'participant-a',
          userId: 'user-a',
          displayName: 'Ivan',
          company: 'RU Trade',
        }],
        coreDiscussion: [{
          participantId: 'participant-a',
          speakerDisplayName: 'Ivan',
          speakerCompany: 'RU Trade',
          sourceText: 'Ivan mentioned this product name in the utterance',
        }],
        partyViews: empty,
        confirmedItems: empty,
        actionItems: [{
          assigneeParticipantId: 'participant-a',
          assigneeDisplayName: 'Ivan',
          assigneeCompany: 'RU Trade',
        }],
        openQuestions: empty,
        customerRequirements: empty,
        products: empty,
        specifications: empty,
        quantity: empty,
        price: empty,
        delivery: empty,
        paymentTerms: empty,
      },
    ]);
    app = await createApp();

    const response = await app.inject({ method: 'DELETE', url: '/v1/auth/account' });

    expect(response.statusCode).toBe(200);
    const data = mocks.transaction.conversationSummary.update.mock.calls[0]![0].data;
    expect(data.summary).not.toContain('Ivan');
    expect(data.summary).not.toContain('RU Trade');
    expect(data.participantRoster[0]).toEqual(expect.objectContaining({
      id: 'participant-a',
      userId: null,
      displayName: 'Deleted user user-a',
      company: null,
    }));
    expect(data.actionItems[0]).toEqual(expect.objectContaining({
      assigneeParticipantId: 'participant-a',
      assigneeDisplayName: 'Deleted user user-a',
      assigneeCompany: null,
    }));
    expect(data.coreDiscussion[0].sourceText).toBe(
      'Ivan mentioned this product name in the utterance',
    );
  });

  it('requires password confirmation after the recent-authentication window', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      passwordHash: 'v2:stored-password-hash',
      devices: [{ authenticatedAt: new Date(0) }],
    });
    app = await createApp();

    const response = await app.inject({ method: 'DELETE', url: '/v1/auth/account' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, code: 'RECENT_AUTH_REQUIRED' });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts the correct password after the recent-authentication window', async () => {
    const passwordHash = await hashPassword('correct horse battery staple', config.PASSWORD_PEPPER);
    mocks.prisma.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      passwordHash,
      devices: [{ authenticatedAt: new Date(0) }],
    });
    app = await createApp();

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/account',
      payload: { password: 'correct horse battery staple' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.transaction.user.updateMany).toHaveBeenCalled();
  });

  it('anonymizes a guest without deleting its participant or messages', async () => {
    mocks.state.role = 'GUEST';
    mocks.transaction.participant.findMany.mockResolvedValue([
      {
        id: 'participant-guest-a',
        conversationId: 'conversation-a',
        displayName: 'Ivan',
        company: 'RU Trade',
      },
    ]);
    app = await createApp();

    const response = await app.inject({ method: 'DELETE', url: '/v1/auth/account' });

    expect(response.statusCode).toBe(200);
    expect(mocks.transaction.translationMessage.updateMany).toHaveBeenCalledWith({
      where: {
        participant: { guestIdentityId: 'guest-a' },
        status: 'PROCESSING',
      },
      data: {
        status: 'FAILED',
        errorCode: 'ACCOUNT_DELETED',
        errorMessage: '发言者已注销账号',
        updatedAt: expect.any(Date),
      },
    });
    expect(mocks.transaction.translationMessage.updateMany).toHaveBeenCalledWith({
      where: { participant: { guestIdentityId: 'guest-a' } },
      data: { speakerDisplayName: 'Deleted guest', speakerCompany: null },
    });
    expect(mocks.transaction.messageCorrection.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        OR: [
          { actorSubjectId: 'guest-a' },
          { actorParticipantId: { in: ['participant-guest-a'] } },
        ],
      },
      data: { actorDisplayName: 'Deleted guest', actorCompany: null },
    });
    expect(mocks.transaction.messageCorrection.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        OR: [
          { decidedBySubjectId: 'guest-a' },
          { decidedByParticipantId: { in: ['participant-guest-a'] } },
        ],
      },
      data: { deciderDisplayName: 'Deleted guest' },
    });
    expect(mocks.transaction.participant.updateMany).toHaveBeenCalledWith({
      where: { guestIdentityId: 'guest-a' },
      data: expect.objectContaining({ guestIdentityId: null, presence: 'LEFT' }),
    });
    expect(mocks.transaction.guestIdentity.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'guest-a',
        sessionId: 'guest-session-a',
        revokedAt: null,
      },
      data: expect.objectContaining({
        displayName: 'Deleted guest',
        revokedAt: expect.any(Date),
      }),
    });
    expect(mocks.disconnectSubject).toHaveBeenCalledWith('guest-a');
  });

  it('does not anonymize a concurrently rejoined guest session', async () => {
    mocks.state.role = 'GUEST';
    mocks.transaction.participant.findMany.mockResolvedValue([
      {
        id: 'participant-guest-a',
        conversationId: 'conversation-a',
        displayName: 'Ivan',
        company: 'RU Trade',
      },
    ]);
    mocks.transaction.guestIdentity.updateMany.mockResolvedValue({ count: 0 });
    app = await createApp();

    const response = await app.inject({ method: 'DELETE', url: '/v1/auth/account' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, code: 'GUEST_SESSION_CHANGED' });
    expect(mocks.transaction.translationMessage.updateMany).not.toHaveBeenCalled();
    expect(mocks.transaction.messageCorrection.updateMany).not.toHaveBeenCalled();
    expect(mocks.transaction.participant.updateMany).not.toHaveBeenCalled();
    expect(mocks.disconnectSubject).not.toHaveBeenCalled();
  });

  it('ends active meetings owned by a deleted registered user while retaining their rows', async () => {
    mocks.state.role = 'USER';
    mocks.transaction.conversation.findMany.mockResolvedValue([
      {
        id: 'owned-active',
        ownerId: 'user-a',
        status: 'ACTIVE',
        guestHistoryPolicy: 'ACCESS_FOR_24_HOURS',
      },
    ]);
    app = await createApp();

    const response = await app.inject({ method: 'DELETE', url: '/v1/auth/account' });

    expect(response.statusCode).toBe(200);
    expect(mocks.transaction.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'owned-active', status: { in: ['WAITING', 'ACTIVE'] } },
      data: expect.objectContaining({ status: 'ENDED', endedAt: expect.any(Date) }),
    });
    expect(mocks.emitToConversation).toHaveBeenCalledWith(
      'owned-active',
      'room.ended',
      expect.objectContaining({ conversationId: 'owned-active' }),
    );
  });
});

describe('profile URL policy', () => {
  it('rejects non-HTTPS avatars before persistence', async () => {
    app = await createApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/auth/profile',
      payload: { avatarUrl: 'http://images.example.test/avatar.png' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION_ERROR');
    expect(mocks.prisma.user.update).not.toHaveBeenCalled();
  });

  it.each([
    {
      method: 'POST' as const,
      url: '/v1/auth/register',
      payload: {
        displayName: 'Alice\nInjected',
        email: 'alice@example.test',
        password: 'password-123',
        deviceId: 'device-register-a',
      },
    },
    {
      method: 'POST' as const,
      url: '/v1/auth/guest',
      payload: {
        displayName: 'Ivan',
        company: 'Company\rInjected',
        preferredLanguage: 'ru',
        deviceId: 'device-guest-a',
        roomCode: '12345678',
      },
    },
    {
      method: 'PATCH' as const,
      url: '/v1/auth/profile',
      payload: { displayName: 'Alice\u0000Injected' },
    },
  ])('rejects control characters in identity fields for $url', async (request) => {
    app = await createApp();

    const response = await app.inject(request);

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION_ERROR');
  });
});
