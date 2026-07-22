export const MAX_CALL_TRANSLATION_AUDIO_CHUNK_BYTES = 96_000;
export const MAX_PENDING_CALL_TRANSLATION_AUDIO_TASKS = 50;
export const MAX_CONTINUOUS_CALL_TRANSLATION_AUDIO_DROP_MS = 5_000;

export class CallTranslationAudioDropTracker {
  private startedAt: number | null = null;

  constructor(
    private readonly maximumContinuousDropMs =
      MAX_CONTINUOUS_CALL_TRANSLATION_AUDIO_DROP_MS,
  ) {
    if (
      !Number.isSafeInteger(maximumContinuousDropMs) ||
      maximumContinuousDropMs < 1
    ) {
      throw new RangeError('Call translation audio drop limit is invalid');
    }
  }

  recordDrop(now = Date.now()): {
    durationMs: number;
    shouldInterrupt: boolean;
  } {
    if (!Number.isFinite(now)) {
      throw new RangeError('Call translation audio drop time is invalid');
    }
    this.startedAt ??= now;
    const durationMs = Math.max(0, Math.floor(now - this.startedAt));
    return {
      durationMs,
      shouldInterrupt: durationMs >= this.maximumContinuousDropMs,
    };
  }

  recordSuccess(): void {
    this.startedAt = null;
  }
}

export class CallTranslationAudioQueueOverflowError extends Error {
  constructor() {
    super('Call translation audio queue is full');
    this.name = 'CallTranslationAudioQueueOverflowError';
  }
}

export class SerializedCallTranslationAudioQueue {
  private pendingTasks = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly maximumPendingTasks = MAX_PENDING_CALL_TRANSLATION_AUDIO_TASKS,
  ) {
    if (!Number.isSafeInteger(maximumPendingTasks) || maximumPendingTasks < 1) {
      throw new RangeError('Call translation audio queue limit is invalid');
    }
  }

  enqueue(task: () => void | Promise<void>): Promise<void> {
    if (this.pendingTasks >= this.maximumPendingTasks) {
      return Promise.reject(new CallTranslationAudioQueueOverflowError());
    }
    this.pendingTasks += 1;
    const result = this.tail.then(task);
    const tracked = result.finally(() => {
      this.pendingTasks -= 1;
    });
    this.tail = tracked.catch(() => undefined);
    return tracked;
  }
}

export function isValidBase64Audio(audio: string): boolean {
  if (!audio || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) return false;
  const unpadded = audio.replace(/=+$/, '');
  const remainder = unpadded.length % 4;
  if (remainder === 1) return false;
  const paddingLength = audio.length - unpadded.length;
  const expectedPadding = remainder === 0 ? 0 : 4 - remainder;
  if (paddingLength > 0 && paddingLength !== expectedPadding) return false;
  const pcm = Buffer.from(audio, 'base64');
  if (pcm.length === 0) return false;
  return pcm.toString('base64').replace(/=+$/, '') === unpadded;
}

export function chunkPcm16Base64Audio(
  audio: string,
  maximumChunkBytes = MAX_CALL_TRANSLATION_AUDIO_CHUNK_BYTES,
): string[] {
  if (!audio) return [];
  if (!Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes < 2) {
    throw new RangeError('PCM16 audio chunk size is invalid');
  }
  const chunkBytes = maximumChunkBytes - (maximumChunkBytes % 2);
  if (!isValidBase64Audio(audio)) {
    throw new RangeError('Translated PCM16 audio is not valid base64');
  }
  const pcm = Buffer.from(audio, 'base64');
  if (pcm.length % 2 !== 0) {
    throw new RangeError('PCM16 audio byte length must be even');
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    chunks.push(pcm.subarray(offset, offset + chunkBytes).toString('base64'));
  }
  return chunks;
}
