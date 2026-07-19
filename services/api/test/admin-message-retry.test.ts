import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn(),
  glossaryFindMany: vi.fn(), systemGlossaryFindMany: vi.fn(), translate: vi.fn(), synthesize: vi.fn(), persistTtsAudio: vi.fn(), deleteTtsAsset: vi.fn(), enqueueAudio: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  prisma: {
    translationMessage: {
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
      findUniqueOrThrow: mocks.findUniqueOrThrow,
    },
    glossaryTerm: { findMany: mocks.glossaryFindMany },
    systemGlossaryTerm: { findMany: mocks.systemGlossaryFindMany },
  },
}));
vi.mock('../src/providers/translation.js', () => ({
  translationProvider: { translate: mocks.translate, synthesize: mocks.synthesize },
}));
vi.mock('../src/services/audio-assets.js', () => ({ persistTtsAudio: mocks.persistTtsAudio, deleteTtsAsset: mocks.deleteTtsAsset }));
vi.mock('../src/services/audio-deletion-outbox.js', () => ({ enqueueAudioDeletionJobsNow: mocks.enqueueAudio }));

import { retryFailedMessage } from '../src/services/admin-message-retry.js';

const failed = {
  id: 'message-a', conversationId: 'conversation-a', participantId: 'participant-a',
  status: 'FAILED', sourceText: '你好', translatedText: '', sourceLanguage: 'zh', targetLanguage: 'ru',
  errorCode: 'MT_FAILED', updatedAt: new Date('2026-07-19T08:00:00Z'),
  conversation: { id: 'conversation-a', ownerId: 'owner-a', status: 'ACTIVE', expiresAt: new Date('2099-01-01') },
  participant: { removedAt: null, leftAt: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(failed);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.glossaryFindMany.mockResolvedValue([]);
  mocks.systemGlossaryFindMany.mockResolvedValue([]);
  mocks.translate.mockResolvedValue({ text: 'Привет', provider: 'aliyun', requestId: 'provider-a' });
  mocks.synthesize.mockRejectedValue(new Error('tts unavailable'));
  mocks.findUniqueOrThrow.mockResolvedValue({ ...failed, status: 'FINAL', translatedText: 'Привет', errorCode: 'TTS_FAILED' });
  mocks.deleteTtsAsset.mockResolvedValue(undefined);
  mocks.enqueueAudio.mockResolvedValue(1);
});

describe('administrator message retry', () => {
  it('uses compare-and-swap and permits a translated result with degraded TTS', async () => {
    const result = await retryFailedMessage('message-a');

    expect(result.status).toBe('FINAL');
    expect(mocks.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: 'message-a', status: 'FAILED', updatedAt: failed.updatedAt }),
      data: expect.objectContaining({ status: 'PROCESSING' }),
    }));
    expect(mocks.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ status: 'PROCESSING' }),
      data: expect.objectContaining({ status: 'FINAL', translatedText: 'Привет', errorCode: 'TTS_FAILED' }),
    }));
  });

  it('refuses retry when no authoritative source text survived', async () => {
    mocks.findUnique.mockResolvedValue({ ...failed, sourceText: '' });
    await expect(retryFailedMessage('message-a')).rejects.toMatchObject({ code: 'MESSAGE_SOURCE_UNAVAILABLE' });
    expect(mocks.translate).not.toHaveBeenCalled();
  });

  it('deletes a newly persisted TTS asset when the final CAS loses', async () => {
    mocks.synthesize.mockResolvedValue({ audioUrl: 'https://provider.test/audio', provider: 'aliyun' });
    mocks.persistTtsAudio.mockResolvedValue('tts-asset:new-audio');
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });
    await expect(retryFailedMessage('message-a')).rejects.toMatchObject({ code: 'MESSAGE_STATUS_CHANGED' });
    expect(mocks.deleteTtsAsset).toHaveBeenCalledWith('tts-asset:new-audio');
  });
});
