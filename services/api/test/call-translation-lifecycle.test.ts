import { describe, expect, it } from 'vitest';
import {
  callTranslationCallIdsForSocket,
  callTranslationClientFinishInterruptsCall,
  callTranslationInterruptionPayload,
  callTranslationKeysForCall,
  callTranslationLifecycleDiagnostic,
  safeCallTranslationClientReason,
} from '../src/services/call-translation-lifecycle.js';

describe('friend call translation lifecycle helpers', () => {
  const sessions = [
    { key: 'source-a:call-1', callId: 'call-1', socketId: 'source-a' },
    { key: 'source-b:call-1', callId: 'call-1', socketId: 'source-b' },
    { key: 'source-a:call-2', callId: 'call-2', socketId: 'source-a' },
  ];

  it('builds privacy-safe lifecycle diagnostics with direction and duration', () => {
    expect(callTranslationLifecycleDiagnostic({
      callId: 'call-1',
      sourceLanguage: 'zh',
      targetLanguage: 'ru',
      startedAt: 1_000,
    }, 'provider_finished', 4_250)).toEqual({
      callId: 'call-1',
      direction: 'zh_to_ru',
      durationMs: 3_250,
      translationEvent: 'provider_finished',
    });
  });

  it('labels a dropped realtime audio frame without participant data', () => {
    expect(callTranslationLifecycleDiagnostic({
      callId: 'call-safe',
      sourceLanguage: 'ru',
      targetLanguage: 'zh',
      startedAt: 1_000,
    }, 'audio_frame_dropped', 1_250)).toEqual({
      callId: 'call-safe',
      direction: 'ru_to_zh',
      durationMs: 250,
      translationEvent: 'audio_frame_dropped',
    });
  });

  it('clamps invalid or negative lifecycle durations', () => {
    expect(callTranslationLifecycleDiagnostic({
      callId: 'call-1',
      sourceLanguage: 'ru',
      targetLanguage: 'zh',
      startedAt: 5_000,
    }, 'ready', 4_000).durationMs).toBe(0);
  });

  it('selects both directional sessions when a call must be closed', () => {
    expect(callTranslationKeysForCall(sessions, 'call-1')).toEqual([
      'source-a:call-1',
      'source-b:call-1',
    ]);
  });

  it('deduplicates calls owned by a disconnected source socket', () => {
    expect(callTranslationCallIdsForSocket(sessions, 'source-a')).toEqual([
      'call-1',
      'call-2',
    ]);
  });

  it('uses one non-sensitive interruption payload for both call devices', () => {
    expect(callTranslationInterruptionPayload('call-1')).toEqual({
      callId: 'call-1',
      code: 'REALTIME_TRANSLATION_FAILED',
      message: '实时翻译服务暂时不可用，已恢复原声通话',
    });
  });

  it('allows only known client finish reasons into production logs', () => {
    expect(safeCallTranslationClientReason('playback_exception')).toBe(
      'playback_exception',
    );
    expect(safeCallTranslationClientReason('person@example.com')).toBe('unknown');
    expect(safeCallTranslationClientReason('secret-token-value')).toBe('unknown');
    expect(safeCallTranslationClientReason(null)).toBe('unknown');
  });

  it('distinguishes normal teardown from call-wide translation failures', () => {
    expect(callTranslationClientFinishInterruptsCall('client_finish')).toBe(false);
    expect(callTranslationClientFinishInterruptsCall('unknown')).toBe(false);
    expect(callTranslationClientFinishInterruptsCall('playback_exception')).toBe(true);
    expect(callTranslationClientFinishInterruptsCall('peer_disconnected')).toBe(true);
    expect(callTranslationClientFinishInterruptsCall('server_finished')).toBe(true);
  });
});
