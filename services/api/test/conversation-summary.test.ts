import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const mocks = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    participant: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    translationMessage: { findMany: vi.fn(), aggregate: vi.fn() },
    conversationSummary: { upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    summaryGeneration: {
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  return {
    getConversationForAuth: vi.fn(),
    getConversationForAuthInTransaction: vi.fn(),
    prisma,
  };
});

vi.mock('../src/db.js', () => ({ prisma: mocks.prisma }));
vi.mock('../src/auth.js', () => ({
  authenticate: vi.fn(async (request: { auth?: unknown }) => {
    request.auth = {
      subjectId: 'host-a',
      role: 'USER',
      deviceId: 'device-a',
      sessionId: 'session-a',
    };
  }),
  requireRole: () => async (request: { auth?: unknown }) => {
    request.auth = {
      subjectId: 'host-a',
      role: 'USER',
      deviceId: 'device-a',
      sessionId: 'session-a',
    };
  },
}));
vi.mock('../src/services/conversations.js', () => ({
  conversationInclude: {},
  conversationDto: (value: unknown) => value,
  effectiveSourceText: (value: {
    sourceText: string;
    confirmedSourceText?: string | null;
  }) => value.confirmedSourceText ?? value.sourceText,
  effectiveTranslatedText: (value: {
    translatedText: string;
    confirmedTranslatedText?: string | null;
  }) => value.confirmedTranslatedText ?? value.translatedText,
  findInvitation: vi.fn(),
  getConversationForAuth: mocks.getConversationForAuth,
  getConversationForAuthInTransaction: mocks.getConversationForAuthInTransaction,
  getParticipant: vi.fn(),
  messageDto: (value: unknown) => value,
  participantDto: (value: unknown) => value,
}));
vi.mock('../src/services/audio-assets.js', () => ({ deleteTtsAssets: vi.fn() }));
vi.mock('../src/services/message-processing.js', () => ({
  recoverStaleProcessingMessages: vi.fn(),
}));
vi.mock('../src/realtime-hub.js', () => ({
  realtimeHub: () => ({
    emitToConversation: vi.fn(),
    emitToSubject: vi.fn(),
    disconnectParticipant: vi.fn(),
  }),
}));

import { AppError } from '../src/errors.js';
import { registerConversationRoutes } from '../src/routes/conversations.js';

let app: FastifyInstance | undefined;
const participant = {
  id: 'participant-a',
  conversationId: 'conversation-a',
  userId: 'host-a',
  guestIdentityId: null,
  role: 'HOST',
  displayName: 'Server Name',
  company: 'Server Company',
  preferredLanguage: 'zh',
  presence: 'OFFLINE',
  joinedAt: new Date('2026-01-01T00:00:00.000Z'),
  leftAt: null,
  lastSeenAt: null,
  removedAt: null,
};
const message = {
  id: 'message-a',
  conversationId: 'conversation-a',
  participantId: participant.id,
  sequence: 1,
  status: 'FINAL',
  speakerDisplayName: 'Immutable Speaker',
  speakerCompany: 'Immutable Company',
  sourceLanguage: 'zh',
  targetLanguage: 'ru',
  sourceText: '服务端原文',
  translatedText: 'Текст сервера',
  createdAt: new Date('2026-01-01T00:01:00.000Z'),
  updatedAt: new Date('2026-01-01T00:01:05.000Z'),
};

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getConversationForAuth.mockResolvedValue({
    id: 'conversation-a',
    ownerId: 'host-a',
    title: 'Meeting',
    status: 'ENDED',
  });
  mocks.getConversationForAuthInTransaction.mockResolvedValue({
    id: 'conversation-a',
    ownerId: 'host-a',
    title: 'Meeting',
    status: 'ENDED',
  });
  mocks.prisma.participant.findMany.mockResolvedValue([participant]);
  mocks.prisma.user.findUnique.mockResolvedValue({ legalPolicyVersion: '2026-07-19-ai-summary' });
  mocks.prisma.translationMessage.findMany.mockResolvedValue([message]);
  mocks.prisma.translationMessage.aggregate.mockResolvedValue({
    _max: { sequence: message.sequence, updatedAt: message.updatedAt },
    _count: { _all: 1 },
  });
  mocks.prisma.conversationSummary.upsert.mockImplementation(async ({ create }) => create);
  mocks.prisma.conversationSummary.findUnique.mockResolvedValue(null);
  mocks.prisma.summaryGeneration.findUnique.mockResolvedValue(null);
  mocks.prisma.summaryGeneration.count.mockResolvedValue(0);
  mocks.prisma.summaryGeneration.create.mockResolvedValue({ id: 'generation-a' });
  mocks.prisma.summaryGeneration.update.mockResolvedValue({ id: 'generation-a' });
  mocks.prisma.summaryGeneration.updateMany.mockResolvedValue({ count: 1 });
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
  await registerConversationRoutes(app);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('server-attributed meeting summary', () => {
  it('rejects AI summary generation for a friend direct chat', async () => {
    mocks.getConversationForAuth.mockResolvedValueOnce({
      id: 'conversation-a',
      kind: 'DIRECT',
      ownerId: 'host-a',
      status: 'ACTIVE',
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/conversations/conversation-a/summary',
      headers: { 'idempotency-key': 'direct-chat-summary' },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('DIRECT_CHAT_DOCUMENTS_UNAVAILABLE');
    expect(mocks.prisma.summaryGeneration.create).not.toHaveBeenCalled();
    expect(mocks.prisma.conversationSummary.upsert).not.toHaveBeenCalled();
  });

  it('rejects reading a summary for a friend direct chat', async () => {
    mocks.getConversationForAuthInTransaction.mockResolvedValueOnce({
      id: 'conversation-a',
      kind: 'DIRECT',
      ownerId: 'host-a',
      status: 'ACTIVE',
    });

    const response = await app!.inject({
      method: 'GET',
      url: '/v1/conversations/conversation-a/summary',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('DIRECT_CHAT_DOCUMENTS_UNAVAILABLE');
    expect(mocks.prisma.conversationSummary.findUnique).not.toHaveBeenCalled();
  });

  it('rejects document export for a friend direct chat', async () => {
    mocks.getConversationForAuth.mockResolvedValueOnce({
      id: 'conversation-a',
      kind: 'DIRECT',
      ownerId: 'host-a',
      status: 'ACTIVE',
    });

    const response = await app!.inject({
      method: 'GET',
      url: '/v1/conversations/conversation-a/export?format=txt',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('DIRECT_CHAT_DOCUMENTS_UNAVAILABLE');
    expect(mocks.prisma.translationMessage.findMany).not.toHaveBeenCalled();
  });

  it('rejects client-supplied coreDiscussion snapshots', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/conversations/conversation-a/summary',
      payload: {
        coreDiscussion: [{ participantId: 'forged', speakerDisplayName: 'Forged' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION_ERROR');
    expect(mocks.prisma.conversationSummary.upsert).not.toHaveBeenCalled();
  });

  it('binds core discussion and party views to server participant/message snapshots', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/conversations/conversation-a/summary',
      payload: {
        partyViews: [{
          participantId: participant.id,
          view: '确认需求',
          sourceSequences: [message.sequence],
        }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const upsert = mocks.prisma.conversationSummary.upsert.mock.calls[0]![0];
    expect(upsert.create.coreDiscussion).toEqual([expect.objectContaining({
      participantId: participant.id,
      speakerDisplayName: message.speakerDisplayName,
      sourceText: message.sourceText,
      spokenAt: message.createdAt.toISOString(),
    })]);
    expect(upsert.create.partyViews).toEqual([expect.objectContaining({
      participantId: participant.id,
      speakerDisplayName: participant.displayName,
      speakerCompany: participant.company,
      sourceSequences: [message.sequence],
      sources: [expect.objectContaining({ speakerDisplayName: message.speakerDisplayName })],
    })]);
    expect(upsert.create).toMatchObject({
      sourceMaxSequence: message.sequence,
      sourceMessageCount: 1,
      sourceLatestMessageUpdatedAt: message.updatedAt,
      revision: 1,
    });
    expect(mocks.prisma.summaryGeneration.create).not.toHaveBeenCalled();
    expect(mocks.getConversationForAuthInTransaction).toHaveBeenCalledWith(
      mocks.prisma,
      expect.objectContaining({ subjectId: 'host-a', sessionId: 'session-a' }),
      'conversation-a',
      { history: true },
    );
  });

  it('does not generate a mutable snapshot before the meeting has ended', async () => {
    mocks.getConversationForAuthInTransaction.mockResolvedValueOnce({
      id: 'conversation-a',
      ownerId: 'host-a',
      title: 'Meeting',
      status: 'ACTIVE',
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/conversations/conversation-a/summary',
      headers: { 'idempotency-key': 'summary-test-ended' },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('SUMMARY_REQUIRES_ENDED_CONVERSATION');
    expect(mocks.prisma.participant.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.translationMessage.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.conversationSummary.upsert).not.toHaveBeenCalled();
  });

  it('requires an idempotency key for AI generation', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/conversations/conversation-a/summary',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(mocks.prisma.summaryGeneration.create).not.toHaveBeenCalled();
  });

  it('retires a stale active generation before accepting a new key', async () => {
    mocks.prisma.summaryGeneration.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'generation-stale',
        startedAt: new Date(Date.now() - 10 * 60_000),
      });

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/conversations/conversation-a/summary',
      headers: { 'idempotency-key': 'summary-test-stale-takeover' },
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.prisma.summaryGeneration.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: 'generation-stale' },
        data: expect.objectContaining({
          status: 'FAILED',
          activeKey: null,
          errorCode: 'SUMMARY_GENERATION_STALE',
        }),
      }),
    );
    expect(mocks.prisma.summaryGeneration.create).toHaveBeenCalledOnce();
  });

  it('does not save an AI draft when a source message changes during generation', async () => {
    mocks.prisma.translationMessage.findMany
      .mockResolvedValueOnce([message])
      .mockResolvedValueOnce([{
        ...message,
        confirmedSourceText: '整理期间确认的新原文',
        updatedAt: new Date(message.updatedAt.getTime() + 1_000),
      }]);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/conversations/conversation-a/summary',
      headers: { 'idempotency-key': 'summary-test-race' },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('SUMMARY_SOURCE_CHANGED');
    expect(mocks.prisma.conversationSummary.upsert).not.toHaveBeenCalled();
  });

  it('reports whether a viewed summary matches the final server message boundary', async () => {
    mocks.prisma.conversationSummary.findUnique.mockResolvedValueOnce({
      id: 'summary-a',
      conversationId: 'conversation-a',
      summary: 'old snapshot',
      sourceMaxSequence: 1,
      sourceMessageCount: 1,
      sourceLatestMessageUpdatedAt: message.updatedAt,
      revision: 2,
    });
    mocks.prisma.translationMessage.aggregate.mockResolvedValueOnce({
      _max: { sequence: 3, updatedAt: message.updatedAt },
      _count: { _all: 3 },
    });

    const response = await app!.inject({
      method: 'GET',
      url: '/v1/conversations/conversation-a/summary',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.summary).toMatchObject({
      id: 'summary-a',
      revision: 2,
      isStale: true,
    });
  });

  it('marks a summary stale when a message is corrected in place', async () => {
    mocks.prisma.conversationSummary.findUnique.mockResolvedValueOnce({
      id: 'summary-a',
      conversationId: 'conversation-a',
      summary: 'old snapshot',
      sourceMaxSequence: 1,
      sourceMessageCount: 1,
      sourceLatestMessageUpdatedAt: message.updatedAt,
      revision: 2,
    });
    mocks.prisma.translationMessage.aggregate.mockResolvedValueOnce({
      _max: {
        sequence: 1,
        updatedAt: new Date(message.updatedAt.getTime() + 1_000),
      },
      _count: { _all: 1 },
    });

    const response = await app!.inject({
      method: 'GET',
      url: '/v1/conversations/conversation-a/summary',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.summary.isStale).toBe(true);
  });

  it('lets only the current fresh revision be approved for distribution', async () => {
    mocks.prisma.conversationSummary.findUnique.mockResolvedValueOnce({
      id: 'summary-a',
      conversationId: 'conversation-a',
      sourceMaxSequence: 1,
      sourceMessageCount: 1,
      sourceLatestMessageUpdatedAt: message.updatedAt,
      revision: 2,
      approvedRevision: null,
      approvedAt: null,
    });
    mocks.prisma.conversationSummary.update.mockImplementationOnce(async ({ data }) => ({
      id: 'summary-a',
      revision: 2,
      ...data,
    }));

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/conversations/conversation-a/summary/approve',
      payload: { revision: 2 },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.prisma.conversationSummary.update).toHaveBeenCalledWith({
      where: { id: 'summary-a' },
      data: expect.objectContaining({
        approvedRevision: 2,
        approvedByUserId: 'host-a',
        approvedAt: expect.any(Date),
      }),
    });
  });
});

describe('identity-preserving transcript export', () => {
  it('includes failed messages and groups speakers by stable participantId', async () => {
    const authorized = {
      id: 'conversation-a',
      ownerId: 'host-a',
      title: 'Meeting',
      status: 'ENDED',
      contact: { displayName: 'Customer' },
    };
    mocks.getConversationForAuth.mockResolvedValueOnce(authorized);
    mocks.getConversationForAuthInTransaction.mockResolvedValueOnce(authorized);
    mocks.prisma.translationMessage.findMany.mockResolvedValueOnce([
      {
        ...message,
        id: 'message-z',
        participantId: 'participant-z',
        sequence: 1,
        speakerDisplayName: 'Same Name',
        sourceText: '第一条',
        status: 'FINAL',
        errorCode: 'TTS_FAILED',
        errorMessage: '语音合成失败',
      },
      {
        ...message,
        id: 'message-a',
        participantId: 'participant-a',
        sequence: 2,
        speakerDisplayName: 'Same Name',
        sourceText: '已识别但翻译失败',
        translatedText: '',
        status: 'FAILED',
        errorCode: 'PROVIDER_TIMEOUT',
        errorMessage: '供应商超时',
      },
    ]);

    const response = await app!.inject({
      method: 'GET',
      url: '/v1/conversations/conversation-a/export?format=txt&groupBy=speaker',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('状态：翻译失败（PROVIDER_TIMEOUT：供应商超时）');
    expect(response.body).toContain('状态：已完成（TTS_FAILED：语音合成失败）');
    expect(response.body).toContain('原文：已识别但翻译失败');
    expect(response.body).toContain('译文：（翻译失败，无译文）');
    expect(response.body.indexOf('已识别但翻译失败')).toBeLessThan(
      response.body.indexOf('第一条'),
    );
    expect(mocks.prisma.translationMessage.findMany).toHaveBeenCalledWith({
      where: {
        conversationId: 'conversation-a',
        status: { in: ['FINAL', 'FAILED'] },
      },
      orderBy: { sequence: 'asc' },
    });
  });
});
