import { describe, expect, it } from 'vitest';
import {
  CallTranslationAudioDropTracker,
  CallTranslationAudioQueueOverflowError,
  MAX_CALL_TRANSLATION_AUDIO_CHUNK_BYTES,
  SerializedCallTranslationAudioQueue,
  chunkPcm16Base64Audio,
  isValidBase64Audio,
} from '../src/services/call-translation-audio.js';

describe('friend call translated PCM16 audio chunking', () => {
  it('interrupts only after continuous drops reach the configured limit', () => {
    const tracker = new CallTranslationAudioDropTracker(5_000);

    expect(tracker.recordDrop(10_000)).toEqual({
      durationMs: 0,
      shouldInterrupt: false,
    });
    expect(tracker.recordDrop(14_999)).toEqual({
      durationMs: 4_999,
      shouldInterrupt: false,
    });
    expect(tracker.recordDrop(15_000)).toEqual({
      durationMs: 5_000,
      shouldInterrupt: true,
    });
  });

  it('resets the continuous drop window after one successful append', () => {
    const tracker = new CallTranslationAudioDropTracker(5_000);
    tracker.recordDrop(10_000);
    tracker.recordSuccess();

    expect(tracker.recordDrop(20_000)).toEqual({
      durationMs: 0,
      shouldInterrupt: false,
    });
  });

  it('returns no Socket.IO packets for empty audio', () => {
    expect(chunkPcm16Base64Audio('')).toEqual([]);
  });

  it('keeps one safe PCM16 packet intact', () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    expect(chunkPcm16Base64Audio(pcm.toString('base64'))).toEqual([
      pcm.toString('base64'),
    ]);
  });

  it('splits a provider-sized packet and preserves every byte in order', () => {
    const pcm = Buffer.alloc(1_125_000);
    for (let index = 0; index < pcm.length; index += 1) pcm[index] = index % 251;

    const chunks = chunkPcm16Base64Audio(pcm.toString('base64'));
    const decoded = chunks.map((chunk) => Buffer.from(chunk, 'base64'));

    expect(chunks.length).toBeGreaterThan(1);
    expect(decoded.every(
      (chunk) => chunk.length <= MAX_CALL_TRANSLATION_AUDIO_CHUNK_BYTES,
    )).toBe(true);
    expect(decoded.every((chunk) => chunk.length % 2 === 0)).toBe(true);
    expect(Buffer.concat(decoded)).toEqual(pcm);
  });

  it('rounds an odd requested boundary down without splitting a PCM16 sample', () => {
    const pcm = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const decoded = chunkPcm16Base64Audio(pcm.toString('base64'), 5)
      .map((chunk) => Buffer.from(chunk, 'base64'));

    expect(decoded.map((chunk) => chunk.length)).toEqual([4, 4, 2]);
    expect(Buffer.concat(decoded)).toEqual(pcm);
  });

  it('rejects an odd PCM16 payload instead of truncating a sample', () => {
    expect(() => chunkPcm16Base64Audio(
      Buffer.from([0, 1, 2]).toString('base64'),
    )).toThrow('PCM16 audio byte length must be even');
  });

  it('rejects non-empty malformed base64 instead of silently dropping audio', () => {
    for (const invalid of ['A', 'A=', '==', 'abc==', 'abc===', 'abc$']) {
      expect(isValidBase64Audio(invalid)).toBe(false);
      expect(() => chunkPcm16Base64Audio(invalid)).toThrow(
        'Translated PCM16 audio is not valid base64',
      );
    }
  });

  it('serializes audio tasks even when the first authorization is delayed', async () => {
    const queue = new SerializedCallTranslationAudioQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstAuthorization = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      order.push('first:start');
      await firstAuthorization;
      order.push('first:append');
    });
    const second = queue.enqueue(() => {
      order.push('second:append');
    });
    await Promise.resolve();
    expect(order).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:append', 'second:append']);
  });

  it('does not poison later queued audio after one task fails', async () => {
    const queue = new SerializedCallTranslationAudioQueue();
    const failed = queue.enqueue(() => {
      throw new Error('stale session');
    });
    const next = queue.enqueue(() => undefined);

    await expect(failed).rejects.toThrow('stale session');
    await expect(next).resolves.toBeUndefined();
  });

  it('bounds pending audio while an authorization read is stalled', async () => {
    const queue = new SerializedCallTranslationAudioQueue(2);
    let releaseFirst!: () => void;
    const firstAuthorization = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.enqueue(() => firstAuthorization);
    const second = queue.enqueue(() => undefined);

    await expect(queue.enqueue(() => undefined)).rejects.toBeInstanceOf(
      CallTranslationAudioQueueOverflowError,
    );
    releaseFirst();
    await Promise.all([first, second]);
  });
});
