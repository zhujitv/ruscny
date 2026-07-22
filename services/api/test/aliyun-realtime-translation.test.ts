import { describe, expect, it } from 'vitest';
import {
  AliyunRealtimeTranslationProtocolError,
  buildAliyunRealtimeSessionUpdate,
  isAliyunRealtimeAudioFallbackError,
  isAliyunRealtimeDroppableAudioError,
} from '../src/services/aliyun-realtime-translation.js';

describe('Aliyun realtime translation session protocol', () => {
  it('requests translated text and Tina audio for audio mode', () => {
    expect(buildAliyunRealtimeSessionUpdate({
      sourceLanguage: 'zh',
      targetLanguage: 'ru',
      outputAudio: true,
    })).toMatchObject({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        voice: 'Tina',
        sample_rate: 16_000,
        input_audio_format: 'pcm',
        output_audio_format: 'pcm',
        input_audio_transcription: {
          model: 'qwen3-asr-flash-realtime',
          language: 'zh',
        },
        translation: { language: 'ru' },
      },
    });
  });

  it('requests text only and omits a voice for subtitle mode', () => {
    const update = buildAliyunRealtimeSessionUpdate({
      sourceLanguage: 'ru',
      targetLanguage: 'zh',
      outputAudio: false,
    });

    expect(update).toMatchObject({
      type: 'session.update',
      session: {
        modalities: ['text'],
        input_audio_transcription: { language: 'ru' },
        translation: { language: 'zh' },
      },
    });
    expect(update.session).not.toHaveProperty('voice');
  });

  it('only falls back to subtitles for audio-session startup failures', () => {
    expect(isAliyunRealtimeAudioFallbackError(
      new AliyunRealtimeTranslationProtocolError(
        'Aliyun realtime session timed out',
        { phase: 'session.update', retryWithoutAudio: true },
      ),
    )).toBe(true);
    expect(isAliyunRealtimeAudioFallbackError(
      new AliyunRealtimeTranslationProtocolError(
        'Aliyun realtime session rejected (invalid_credentials)',
        {
          code: 'invalid_credentials',
          phase: 'session.update',
          retryWithoutAudio: false,
        },
      ),
    )).toBe(false);
  });

  it('only drops isolated realtime audio-frame pressure errors', () => {
    for (const code of [
      'INVALID_SEQUENCE',
      'INVALID_PCM_FRAME',
      'INPUT_RATE_LIMIT',
      'UPSTREAM_CONGESTED',
    ]) {
      expect(isAliyunRealtimeDroppableAudioError(
        new AliyunRealtimeTranslationProtocolError('safe diagnostic', {
          code,
          phase: 'stream',
        }),
      )).toBe(true);
    }

    for (const code of ['SESSION_NOT_WRITABLE', 'SOCKET_NOT_OPEN']) {
      expect(isAliyunRealtimeDroppableAudioError(
        new AliyunRealtimeTranslationProtocolError('safe diagnostic', {
          code,
          phase: 'stream',
        }),
      )).toBe(false);
    }
    expect(isAliyunRealtimeDroppableAudioError(
      new AliyunRealtimeTranslationProtocolError('safe diagnostic', {
        code: 'UPSTREAM_CONGESTED',
        phase: 'session.update',
      }),
    )).toBe(false);
  });
});
