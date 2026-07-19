import type { Language } from '@prisma/client';
import { prisma } from '../db.js';
import { translationProvider } from '../providers/translation.js';
import { realtimeHub } from '../realtime-hub.js';
import { deleteTtsAsset, persistTtsAudio } from './audio-assets.js';
import { enqueueAudioDeletionJobsNow } from './audio-deletion-outbox.js';
import { messageDto } from './conversations.js';

export const TTS_PENDING_CODE = 'TTS_PENDING';
export const TTS_PROCESSING_CODE = 'TTS_PROCESSING';
const TTS_FAILED_CODE = 'TTS_FAILED';

const defaultBatchSize = 4;
const defaultIntervalMs = 5_000;
const defaultClaimTimeoutMs = 2 * 60_000;

interface TtsGenerationLogger {
  error(bindings: Record<string, unknown>, message: string): unknown;
}

interface ProcessOptions {
  batchSize?: number;
  claimTimeoutMs?: number;
  now?: Date;
}

interface WorkerOptions extends ProcessOptions {
  intervalMs?: number;
  logger?: TtsGenerationLogger;
}

export interface TtsGenerationRunResult {
  candidates: number;
  claimed: number;
  generated: number;
  failed: number;
}

export interface TtsGenerationWorker {
  wake(): void;
  stop(): Promise<void>;
}

let activeWorker: TtsGenerationWorker | undefined;

/**
 * Generates TTS after ASR and MT have already been returned to the client.
 * Compare-and-swap claims make this safe across multiple API instances, and
 * stale PROCESSING rows are recoverable after a process restart.
 */
export async function processTtsGenerationJobs(
  options: ProcessOptions = {},
): Promise<TtsGenerationRunResult> {
  const batchSize = options.batchSize ?? defaultBatchSize;
  const claimTimeoutMs = options.claimTimeoutMs ?? defaultClaimTimeoutMs;
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - claimTimeoutMs);
  const candidates = await prisma.translationMessage.findMany({
    where: {
      status: 'FINAL',
      audioUrl: null,
      translatedText: { not: '' },
      OR: [
        { errorCode: TTS_PENDING_CODE },
        {
          errorCode: TTS_PROCESSING_CODE,
          updatedAt: { lte: staleBefore },
        },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: batchSize,
    select: {
      id: true,
      conversationId: true,
      translatedText: true,
      targetLanguage: true,
      errorCode: true,
      updatedAt: true,
    },
  });
  const result: TtsGenerationRunResult = {
    candidates: candidates.length,
    claimed: 0,
    generated: 0,
    failed: 0,
  };

  await Promise.all(candidates.map(async (candidate) => {
    const claimedAt = new Date();
    const claim = await prisma.translationMessage.updateMany({
      where: {
        id: candidate.id,
        status: 'FINAL',
        audioUrl: null,
        translatedText: candidate.translatedText,
        errorCode: candidate.errorCode,
        updatedAt: candidate.updatedAt,
      },
      data: {
        errorCode: TTS_PROCESSING_CODE,
        errorMessage: null,
        updatedAt: claimedAt,
      },
    });
    if (claim.count !== 1) return;
    result.claimed += 1;

    let storedAudio: string | null = null;
    try {
      const speech = await translationProvider.synthesize({
        text: candidate.translatedText,
        language: speechLanguage(candidate.targetLanguage),
      });
      storedAudio = await persistTtsAudio(speech.audioUrl);
      const completedAt = new Date();
      const completed = await prisma.translationMessage.updateMany({
        where: {
          id: candidate.id,
          status: 'FINAL',
          audioUrl: null,
          translatedText: candidate.translatedText,
          errorCode: TTS_PROCESSING_CODE,
          updatedAt: claimedAt,
        },
        data: {
          audioUrl: storedAudio,
          errorCode: null,
          errorMessage: null,
          updatedAt: completedAt,
        },
      });
      if (completed.count !== 1) {
        await cleanupUncommittedAudio(storedAudio);
        return;
      }
      storedAudio = null;
      result.generated += 1;
      await emitCurrentMessage(candidate.id, candidate.conversationId);
    } catch (error) {
      if (storedAudio) await cleanupUncommittedAudio(storedAudio);
      const failed = await prisma.translationMessage.updateMany({
        where: {
          id: candidate.id,
          status: 'FINAL',
          audioUrl: null,
          translatedText: candidate.translatedText,
          errorCode: TTS_PROCESSING_CODE,
          updatedAt: claimedAt,
        },
        data: {
          errorCode: TTS_FAILED_CODE,
          errorMessage: '译文已完成，语音暂不可用',
          updatedAt: new Date(),
        },
      });
      if (failed.count === 1) {
        result.failed += 1;
        await emitCurrentMessage(candidate.id, candidate.conversationId);
      }
    }
  }));

  return result;
}

export function startTtsGenerationWorker(
  options: WorkerOptions = {},
): TtsGenerationWorker {
  const intervalMs = options.intervalMs ?? defaultIntervalMs;
  const batchSize = options.batchSize ?? defaultBatchSize;
  let stopped = false;
  let runAgain = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const schedule = (delay: number): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
    timer.unref();
  };
  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      runAgain = true;
      return running;
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    running = (async () => {
      do {
        runAgain = false;
        const processed = await processTtsGenerationJobs({
          batchSize,
          claimTimeoutMs: options.claimTimeoutMs,
        });
        if (processed.claimed === batchSize) runAgain = true;
      } while (runAgain && !stopped);
    })()
      .catch((error: unknown) => {
        options.logger?.error(
          { error: errorMessage(error) },
          'TTS generation worker failed',
        );
      })
      .finally(() => {
        running = undefined;
        if (!stopped) schedule(intervalMs);
      });
    return running;
  };
  const worker: TtsGenerationWorker = {
    wake() {
      if (stopped) return;
      if (running) {
        runAgain = true;
        return;
      }
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running;
      if (activeWorker === worker) activeWorker = undefined;
    },
  };
  activeWorker = worker;
  worker.wake();
  return worker;
}

export function wakeTtsGenerationWorker(): void {
  activeWorker?.wake();
}

async function emitCurrentMessage(messageId: string, conversationId: string): Promise<void> {
  const message = await prisma.translationMessage.findUnique({ where: { id: messageId } });
  if (!message) return;
  realtimeHub().emitToConversation(conversationId, 'translation.final', messageDto(message));
}

async function cleanupUncommittedAudio(storedValue: string): Promise<void> {
  try {
    await deleteTtsAsset(storedValue);
  } catch {
    await enqueueAudioDeletionJobsNow([storedValue]).catch(() => undefined);
  }
}

function speechLanguage(language: Language): 'zh' | 'ru' {
  if (language === 'zh') return 'zh';
  if (language === 'ru') return 'ru';
  throw new Error(`Unsupported TTS language: ${language}`);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : 'Unknown TTS generation error';
  return message.slice(0, 1_000);
}
