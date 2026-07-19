import type { TranslationMessage } from '@prisma/client';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { deleteTtsAsset, persistTtsAudio } from './audio-assets.js';
import { enqueueAudioDeletionJobsNow } from './audio-deletion-outbox.js';
import { translationProvider } from '../providers/translation.js';

const retryableCodes = new Set([
  'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE',
  'PROVIDER_FAILED', 'MT_FAILED', 'TTS_FAILED', 'PROCESSING_TIMEOUT',
]);

export async function retryFailedMessage(messageId: string): Promise<TranslationMessage> {
  const current = await prisma.translationMessage.findUnique({
    where: { id: messageId },
    include: {
      conversation: { select: { id: true, ownerId: true, status: true, expiresAt: true } },
      participant: { select: { removedAt: true, leftAt: true } },
    },
  });
  if (!current) throw new AppError(404, 'MESSAGE_NOT_FOUND', '消息不存在');
  if (current.status !== 'FAILED') throw new AppError(409, 'MESSAGE_NOT_FAILED', '只有失败消息可以重试');
  if (!current.sourceText.trim()) throw new AppError(409, 'MESSAGE_SOURCE_UNAVAILABLE', '没有已确认的原文，不能安全重试');
  if (current.errorCode && !retryableCodes.has(current.errorCode)) {
    throw new AppError(409, 'MESSAGE_NOT_RETRYABLE', '该错误不允许后台重试');
  }
  if (current.conversation.status !== 'ACTIVE' || current.conversation.expiresAt <= new Date()) {
    throw new AppError(409, 'ROOM_NOT_ACTIVE', '会议已结束或过期，不能重新广播翻译');
  }
  if (current.participant.removedAt || current.participant.leftAt) {
    throw new AppError(409, 'PARTICIPANT_NOT_ACTIVE', '原发言者已离开或被移除');
  }

  const claimedAt = new Date();
  const claimed = await prisma.translationMessage.updateMany({
    where: { id: current.id, status: 'FAILED', updatedAt: current.updatedAt },
    data: {
      status: 'PROCESSING', translatedText: '', audioUrl: null, provider: null,
      providerRequestId: null, errorCode: null, errorMessage: null, updatedAt: claimedAt,
    },
  });
  if (claimed.count !== 1) throw new AppError(409, 'MESSAGE_STATUS_CHANGED', '消息状态已变化，请刷新后重试');
  if (current.audioUrl) await cleanupAudio(current.audioUrl);

  let generatedAudioAsset: string | null = null;
  try {
    const sourceTerms = wordsIn(current.sourceText);
    const [privateTerms, globalTerms] = await Promise.all([
      prisma.glossaryTerm.findMany({
        where: { ownerId: current.conversation.ownerId, sourceLanguage: current.sourceLanguage, targetLanguage: current.targetLanguage, enabled: true, sourceTerm: { in: sourceTerms } },
        take: 100, select: { sourceTerm: true, targetTerm: true },
      }),
      prisma.systemGlossaryTerm.findMany({
        where: { sourceLanguage: current.sourceLanguage, targetLanguage: current.targetLanguage, enabled: true, sourceTerm: { in: sourceTerms } },
        take: 100, select: { sourceTerm: true, targetTerm: true },
      }),
    ]);
    const terms = [...privateTerms, ...globalTerms.filter((global) => !privateTerms.some((term) => term.sourceTerm === global.sourceTerm))];
    const translation = await translationProvider.translate({
      text: current.sourceText,
      sourceLanguage: current.sourceLanguage as 'zh' | 'ru',
      targetLanguage: current.targetLanguage as 'zh' | 'ru',
      terms: terms.map((term) => ({ source: term.sourceTerm, target: term.targetTerm })),
    });
    let audioUrl: string | null = null;
    let ttsFailed = false;
    try {
      const speech = await translationProvider.synthesize({
        text: translation.text,
        language: current.targetLanguage as 'zh' | 'ru',
      });
      audioUrl = await persistTtsAudio(speech.audioUrl);
      generatedAudioAsset = audioUrl;
    } catch {
      ttsFailed = true;
    }
    const updated = await prisma.translationMessage.updateMany({
      where: { id: current.id, status: 'PROCESSING', updatedAt: claimedAt },
      data: {
        status: 'FINAL', translatedText: translation.text, audioUrl,
        provider: translation.provider, providerRequestId: translation.requestId,
        errorCode: ttsFailed ? 'TTS_FAILED' : null,
        errorMessage: ttsFailed ? '译文已完成，语音暂不可用' : null,
      },
    });
    if (updated.count !== 1) throw new AppError(409, 'MESSAGE_STATUS_CHANGED', '会议或消息状态已变化');
    generatedAudioAsset = null;
    return prisma.translationMessage.findUniqueOrThrow({ where: { id: current.id } });
  } catch (error) {
    if (generatedAudioAsset) await cleanupAudio(generatedAudioAsset);
    const code = error instanceof AppError ? error.code : 'ADMIN_RETRY_FAILED';
    const message = error instanceof Error ? error.message.slice(0, 500) : '后台重试失败';
    await prisma.translationMessage.updateMany({
      where: { id: current.id, status: 'PROCESSING', updatedAt: claimedAt },
      data: { status: 'FAILED', errorCode: code, errorMessage: message },
    });
    throw error;
  }
}

async function cleanupAudio(storedValue: string): Promise<void> {
  try {
    await deleteTtsAsset(storedValue);
  } catch {
    await enqueueAudioDeletionJobsNow([storedValue]).catch(() => undefined);
  }
}

function wordsIn(value: string): string[] {
  const words = value.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set([...words, value.trim()].filter(Boolean))].slice(0, 500);
}
