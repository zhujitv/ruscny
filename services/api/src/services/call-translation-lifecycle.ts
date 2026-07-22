import type { RealtimeTranslationLanguage } from './aliyun-realtime-translation.js';

export type CallTranslationLifecycleEvent =
  | 'ready'
  | 'provider_error'
  | 'provider_finished'
  | 'audio_append_failed'
  | 'audio_frame_dropped'
  | 'source_client_finished'
  | 'source_socket_disconnected';

const knownClientFinishReasons = new Set([
  'client_finish',
  'socket_disconnected',
  'stale_start',
  'start_failed',
  'server_error',
  'server_finished',
  'playback_exception',
  'peer_disconnected',
]);

const callInterruptingClientFinishReasons = new Set([
  'socket_disconnected',
  'stale_start',
  'start_failed',
  'server_error',
  'server_finished',
  'playback_exception',
  'peer_disconnected',
]);

export interface CallTranslationLifecycleContext {
  callId: string;
  sourceLanguage: RealtimeTranslationLanguage;
  targetLanguage: RealtimeTranslationLanguage;
  startedAt: number;
}

export interface CallTranslationSessionReference {
  key: string;
  callId: string;
  socketId: string;
}

export function callTranslationLifecycleDiagnostic(
  context: CallTranslationLifecycleContext,
  event: CallTranslationLifecycleEvent,
  now = Date.now(),
): {
  callId: string;
  direction: string;
  durationMs: number;
  translationEvent: CallTranslationLifecycleEvent;
} {
  const durationMs = Number.isFinite(now) && Number.isFinite(context.startedAt)
    ? Math.max(0, Math.floor(now - context.startedAt))
    : 0;
  return {
    callId: context.callId,
    direction: `${context.sourceLanguage}_to_${context.targetLanguage}`,
    durationMs,
    translationEvent: event,
  };
}

export function callTranslationInterruptionPayload(callId: string): {
  callId: string;
  code: 'REALTIME_TRANSLATION_FAILED';
  message: string;
} {
  return {
    callId,
    code: 'REALTIME_TRANSLATION_FAILED',
    message: '实时翻译服务暂时不可用，已恢复原声通话',
  };
}

export function safeCallTranslationClientReason(value: unknown): string {
  return typeof value === 'string' && knownClientFinishReasons.has(value)
    ? value
    : 'unknown';
}

export function callTranslationClientFinishInterruptsCall(
  reason: string,
): boolean {
  return callInterruptingClientFinishReasons.has(reason);
}

export function callTranslationKeysForCall(
  sessions: Iterable<CallTranslationSessionReference>,
  callId: string,
): string[] {
  const keys: string[] = [];
  for (const session of sessions) {
    if (session.callId === callId) keys.push(session.key);
  }
  return keys;
}

export function callTranslationCallIdsForSocket(
  sessions: Iterable<CallTranslationSessionReference>,
  socketId: string,
): string[] {
  const callIds = new Set<string>();
  for (const session of sessions) {
    if (session.socketId === socketId) callIds.add(session.callId);
  }
  return [...callIds];
}
