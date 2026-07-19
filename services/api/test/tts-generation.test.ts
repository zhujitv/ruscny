import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  findUnique: vi.fn(),
  synthesize: vi.fn(),
  persistTtsAudio: vi.fn(),
  deleteTtsAsset: vi.fn(),
  enqueueAudioDeletionJobsNow: vi.fn(),
  emitToConversation: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  prisma: {
    translationMessage: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
      findUnique: mocks.findUnique,
    },
  },
}));
vi.mock('../src/providers/translation.js', () => ({
  translationProvider: { synthesize: mocks.synthesize },
}));
vi.mock('../src/services/audio-assets.js', () => ({
  persistTtsAudio: mocks.persistTtsAudio,
  deleteTtsAsset: mocks.deleteTtsAsset,
}));
vi.mock('../src/services/audio-deletion-outbox.js', () => ({
  enqueueAudioDeletionJobsNow: mocks.enqueueAudioDeletionJobsNow,
}));
vi.mock('../src/realtime-hub.js', () => ({
  realtimeHub: () => ({ emitToConversation: mocks.emitToConversation }),
}));
vi.mock('../src/services/conversations.js', () => ({
  messageDto: (message: unknown) => message,
}));

import {
  processTtsGenerationJobs,
  TTS_PENDING_CODE,
  TTS_PROCESSING_CODE,
} from '../src/services/tts-generation.js';

const now = new Date('2026-07-19T11:00:00.000Z');
const candidate = {
  id: 'message-1',
  conversationId: 'conversation-1',
  translatedText: 'Привет',
  targetLanguage: 'ru',
  errorCode: TTS_PENDING_CODE,
  updatedAt: new Date('2026-07-19T10:59:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([candidate]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.synthesize.mockResolvedValue({
    audioUrl: 'https://tts-result.oss-cn-beijing.aliyuncs.com/result.wav',
    provider: 'aliyun',
  });
  mocks.persistTtsAudio.mockResolvedValue(
    'asset:tts-123e4567-e89b-12d3-a456-426614174000.wav',
  );
  mocks.findUnique.mockResolvedValue({
    ...candidate,
    status: 'FINAL',
    audioUrl: 'asset:tts-123e4567-e89b-12d3-a456-426614174000.wav',
    errorCode: null,
  });
});

describe('TTS generation worker', () => {
  it('claims pending text, persists audio and broadcasts the updated message', async () => {
    const result = await processTtsGenerationJobs({ now });

    expect(result).toEqual({ candidates: 1, claimed: 1, generated: 1, failed: 0 });
    expect(mocks.synthesize).toHaveBeenCalledWith({ text: 'Привет', language: 'ru' });
    expect(mocks.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: candidate.id,
        status: 'FINAL',
        audioUrl: null,
        translatedText: candidate.translatedText,
        errorCode: TTS_PENDING_CODE,
        updatedAt: candidate.updatedAt,
      },
      data: {
        errorCode: TTS_PROCESSING_CODE,
        errorMessage: null,
        updatedAt: expect.any(Date),
      },
    });
    expect(mocks.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({
        audioUrl: 'asset:tts-123e4567-e89b-12d3-a456-426614174000.wav',
        errorCode: null,
      }),
    }));
    expect(mocks.emitToConversation).toHaveBeenCalledWith(
      candidate.conversationId,
      'translation.final',
      expect.objectContaining({ id: candidate.id, audioUrl: expect.any(String) }),
    );
  });

  it('marks TTS failure without losing the completed translation', async () => {
    mocks.synthesize.mockRejectedValue(new Error('provider unavailable'));
    mocks.findUnique.mockResolvedValue({
      ...candidate,
      status: 'FINAL',
      audioUrl: null,
      errorCode: 'TTS_FAILED',
      errorMessage: '译文已完成，语音暂不可用',
    });

    const result = await processTtsGenerationJobs({ now });

    expect(result).toEqual({ candidates: 1, claimed: 1, generated: 0, failed: 1 });
    expect(mocks.persistTtsAudio).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({
        errorCode: 'TTS_FAILED',
        errorMessage: '译文已完成，语音暂不可用',
      }),
    }));
    expect(mocks.emitToConversation).toHaveBeenCalledOnce();
  });

  it('recovers only stale processing rows after the claim timeout', async () => {
    mocks.findMany.mockResolvedValue([]);

    await processTtsGenerationJobs({ now, claimTimeoutMs: 60_000 });

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        status: 'FINAL',
        audioUrl: null,
        translatedText: { not: '' },
        OR: [
          { errorCode: TTS_PENDING_CODE },
          {
            errorCode: TTS_PROCESSING_CODE,
            updatedAt: { lte: new Date('2026-07-19T10:59:00.000Z') },
          },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: 4,
      select: {
        id: true,
        conversationId: true,
        translatedText: true,
        targetLanguage: true,
        errorCode: true,
        updatedAt: true,
      },
    });
  });
});
