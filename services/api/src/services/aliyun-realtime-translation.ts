import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import { serviceConfiguration } from './service-configuration.js';

export type RealtimeTranslationLanguage = 'zh' | 'ru';

export type RealtimeTranslationEvent =
  | { type: 'source.partial'; text: string; language: RealtimeTranslationLanguage }
  | { type: 'source.final'; text: string; language: RealtimeTranslationLanguage }
  | { type: 'translation.partial'; text: string; language: RealtimeTranslationLanguage }
  | { type: 'translation.final'; text: string; language: RealtimeTranslationLanguage }
  | { type: 'translation.audio'; audio: string; sampleRate: 24_000 }
  | { type: 'error'; code: string; message: string }
  | { type: 'finished' };

interface ResolvedConfiguration {
  apiKey: string;
  workspaceId: string;
  endpoint: string;
  model: string;
  maxSessionSeconds: number;
}

interface SessionOptions {
  sourceLanguage: RealtimeTranslationLanguage;
  targetLanguage: RealtimeTranslationLanguage;
  outputAudio: boolean;
  onEvent: (event: RealtimeTranslationEvent) => void;
}

interface ProtocolErrorDetails {
  code?: string;
  parameter?: string;
  phase?: 'connect' | 'session.update' | 'stream';
  retryWithoutAudio?: boolean;
}

const connectTimeoutMs = 10_000;
const finishTimeoutMs = 3_000;
const maximumAudioFrameBytes = 12_800;
const maximumBufferedBytes = 512_000;
const maximumAudioBytesPerSecond = 64_000;

export class AliyunRealtimeTranslationNotConfiguredError extends Error {}
export class AliyunRealtimeTranslationProtocolError extends Error {
  readonly code?: string;
  readonly parameter?: string;
  readonly phase?: 'connect' | 'session.update' | 'stream';
  readonly retryWithoutAudio: boolean;

  constructor(message: string, details: ProtocolErrorDetails = {}) {
    super(message);
    this.name = 'AliyunRealtimeTranslationProtocolError';
    this.code = details.code;
    this.parameter = details.parameter;
    this.phase = details.phase;
    this.retryWithoutAudio = details.retryWithoutAudio ?? false;
  }
}

export function isAliyunRealtimeAudioFallbackError(error: unknown): boolean {
  return error instanceof AliyunRealtimeTranslationProtocolError && error.retryWithoutAudio;
}

export function buildAliyunRealtimeSessionUpdate(options: {
  sourceLanguage: RealtimeTranslationLanguage;
  targetLanguage: RealtimeTranslationLanguage;
  outputAudio: boolean;
}): Record<string, unknown> {
  return {
    event_id: eventId(),
    type: 'session.update',
    session: {
      modalities: options.outputAudio ? ['text', 'audio'] : ['text'],
      ...(options.outputAudio ? { voice: 'Tina' } : {}),
      sample_rate: 16_000,
      input_audio_format: 'pcm',
      output_audio_format: 'pcm',
      input_audio_transcription: {
        model: 'qwen3-asr-flash-realtime',
        language: options.sourceLanguage,
      },
      translation: { language: options.targetLanguage },
    },
  };
}

export async function realtimeTranslationAvailable(): Promise<boolean> {
  return (await resolveConfiguration({ strict: false })) !== null;
}

export async function createAliyunRealtimeTranslationSession(
  options: SessionOptions,
): Promise<AliyunRealtimeTranslationSession> {
  if (options.sourceLanguage === options.targetLanguage) {
    throw new AliyunRealtimeTranslationProtocolError('Source and target languages must differ');
  }
  const configuration = await resolveConfiguration({ strict: true });
  if (!configuration) throw new AliyunRealtimeTranslationNotConfiguredError();
  return AliyunRealtimeTranslationSession.connect(configuration, options);
}

export class AliyunRealtimeTranslationSession {
  private ready = false;
  private finishing = false;
  private finished = false;
  private lastSequence = -1;
  private audioWindowStartedAt = Date.now();
  private audioBytesInWindow = 0;
  private sessionTimeout?: NodeJS.Timeout;
  private finishTimeout?: NodeJS.Timeout;

  private constructor(
    private readonly socket: WebSocket,
    private readonly configuration: ResolvedConfiguration,
    private readonly options: SessionOptions,
  ) {}

  static async connect(
    configuration: ResolvedConfiguration,
    options: SessionOptions,
  ): Promise<AliyunRealtimeTranslationSession> {
    const url = buildAliyunRealtimeUrl(
      configuration.endpoint,
      configuration.workspaceId,
      configuration.model,
    );
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${configuration.apiKey}`,
        'X-DashScope-WorkSpace': configuration.workspaceId,
        'User-Agent': 'RUSCNY-Server/1.0',
      },
      handshakeTimeout: connectTimeoutMs,
      maxPayload: 2_000_000,
      perMessageDeflate: false,
    });
    const session = new AliyunRealtimeTranslationSession(
      socket,
      configuration,
      options,
    );
    await session.waitUntilReady();
    return session;
  }

  appendAudio(audio: Buffer, sequence: number): void {
    if (!this.ready || this.finishing || this.finished) {
      throw new AliyunRealtimeTranslationProtocolError('Realtime translation session is not writable');
    }
    if (!Number.isSafeInteger(sequence) || sequence <= this.lastSequence) {
      throw new AliyunRealtimeTranslationProtocolError('Audio sequence is invalid');
    }
    if (audio.length === 0 || audio.length > maximumAudioFrameBytes || audio.length % 2 !== 0) {
      throw new AliyunRealtimeTranslationProtocolError('PCM audio frame is invalid');
    }
    const now = Date.now();
    if (now - this.audioWindowStartedAt >= 1_000) {
      this.audioWindowStartedAt = now;
      this.audioBytesInWindow = 0;
    }
    this.audioBytesInWindow += audio.length;
    if (this.audioBytesInWindow > maximumAudioBytesPerSecond) {
      throw new AliyunRealtimeTranslationProtocolError('PCM audio rate limit exceeded');
    }
    if (this.socket.bufferedAmount > maximumBufferedBytes) {
      throw new AliyunRealtimeTranslationProtocolError('Realtime translation upstream is congested');
    }
    this.lastSequence = sequence;
    this.send({
      event_id: eventId(),
      type: 'input_audio_buffer.append',
      audio: audio.toString('base64'),
    });
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    if (!this.finishing && this.socket.readyState === WebSocket.OPEN) {
      this.finishing = true;
      this.send({ event_id: eventId(), type: 'session.finish' });
    }
    await new Promise<void>((resolve) => {
      if (this.finished) {
        resolve();
        return;
      }
      const done = () => resolve();
      this.socket.once('close', done);
      this.finishTimeout = setTimeout(() => {
        this.socket.close(1000, 'client finished');
        resolve();
      }, finishTimeoutMs);
      this.finishTimeout.unref();
    });
  }

  abort(): void {
    if (this.finished) return;
    this.finishing = true;
    this.socket.close(1000, 'session aborted');
  }

  private async waitUntilReady(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let socketOpened = false;
      const timer = setTimeout(() => {
        const sessionUpdateTimedOut = socketOpened && this.options.outputAudio;
        settle(new AliyunRealtimeTranslationProtocolError(
          socketOpened
            ? 'Aliyun realtime session update timed out'
            : 'Aliyun realtime connection timed out',
          {
            code: socketOpened ? 'SESSION_UPDATE_TIMEOUT' : 'CONNECTION_TIMEOUT',
            phase: socketOpened ? 'session.update' : 'connect',
            retryWithoutAudio: sessionUpdateTimedOut,
          },
        ));
        this.socket.terminate();
      }, connectTimeoutMs);
      timer.unref();
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      this.socket.on('open', () => {
        socketOpened = true;
        this.send(buildAliyunRealtimeSessionUpdate(this.options));
      });
      this.socket.on('message', (raw) => {
        try {
          const event = parseServerEvent(raw);
          if (event.type === 'error' && !this.ready) {
            const detail = objectValue(event.error);
            const providerCode = stringValue(detail.code) || 'unknown_error';
            const providerParameter = stringValue(detail.param) || stringValue(detail.parameter);
            const providerMessage = stringValue(detail.message);
            const error = new AliyunRealtimeTranslationProtocolError(
              `Aliyun realtime session rejected (${providerCode})`,
              {
                code: safeProviderDiagnostic(providerCode),
                parameter: safeProviderDiagnostic(providerParameter),
                phase: 'session.update',
                retryWithoutAudio: this.options.outputAudio && isAudioOutputRejection(
                  providerCode,
                  providerParameter,
                  providerMessage,
                ),
              },
            );
            settle(error);
            this.socket.terminate();
            return;
          }
          if (event.type === 'session.updated') {
            this.ready = true;
            this.sessionTimeout = setTimeout(() => {
              void this.finish();
            }, this.configuration.maxSessionSeconds * 1_000);
            this.sessionTimeout.unref();
            settle();
          }
          this.handleEvent(event);
        } catch (error) {
          const normalized = normalizeError(error);
          settle(normalized);
          this.options.onEvent({
            type: 'error',
            code: 'ALIYUN_REALTIME_PROTOCOL_ERROR',
            message: normalized.message,
          });
          this.finishing = true;
          this.socket.terminate();
        }
      });
      this.socket.once('error', (error) => {
        settle(normalizeError(error));
      });
      this.socket.once('close', (code) => {
        const unexpected = this.ready && !this.finishing;
        if (!this.ready) {
          settle(new AliyunRealtimeTranslationProtocolError(
            `Aliyun realtime socket closed (${code})`,
            {
              code: 'SOCKET_CLOSED',
              phase: socketOpened ? 'session.update' : 'connect',
              retryWithoutAudio: socketOpened && this.options.outputAudio,
            },
          ));
        }
        this.cleanup();
        if (unexpected) {
          this.options.onEvent({
            type: 'error',
            code: 'ALIYUN_REALTIME_CONNECTION_CLOSED',
            message: 'Aliyun realtime connection closed unexpectedly',
          });
        }
      });
    });
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = stringValue(event.type);
    if (type === 'error') {
      const detail = objectValue(event.error);
      const code = stringValue(detail.code) || 'ALIYUN_REALTIME_ERROR';
      const message = stringValue(detail.message) || 'Aliyun realtime translation failed';
      this.options.onEvent({ type: 'error', code, message });
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.text') {
      this.options.onEvent({
        type: 'source.partial',
        text: boundedText(`${stringValue(event.text)}${stringValue(event.stash)}`),
        language: this.options.sourceLanguage,
      });
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      this.options.onEvent({
        type: 'source.final',
        text: boundedText(stringValue(event.transcript)),
        language: this.options.sourceLanguage,
      });
      return;
    }
    if (type === 'response.text.text' || type === 'response.audio_transcript.text') {
      this.options.onEvent({
        type: 'translation.partial',
        text: boundedText(`${stringValue(event.text)}${stringValue(event.stash)}`),
        language: this.options.targetLanguage,
      });
      return;
    }
    if (type === 'response.text.done' || type === 'response.audio_transcript.done') {
      const text = type === 'response.text.done'
        ? stringValue(event.text)
        : stringValue(event.transcript);
      this.options.onEvent({
        type: 'translation.final',
        text: boundedText(text),
        language: this.options.targetLanguage,
      });
      return;
    }
    if (type === 'response.audio.delta' && this.options.outputAudio) {
      const audio = stringValue(event.delta);
      if (audio && audio.length <= 1_500_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(audio)) {
        this.options.onEvent({ type: 'translation.audio', audio, sampleRate: 24_000 });
      }
      return;
    }
    if (type === 'session.finished') {
      this.options.onEvent({ type: 'finished' });
      this.socket.close(1000, 'session finished');
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new AliyunRealtimeTranslationProtocolError('Aliyun realtime socket is not open');
    }
    this.socket.send(JSON.stringify(payload));
  }

  private cleanup(): void {
    if (this.finished) return;
    this.finished = true;
    this.ready = false;
    if (this.sessionTimeout) clearTimeout(this.sessionTimeout);
    if (this.finishTimeout) clearTimeout(this.finishTimeout);
  }
}

export function buildAliyunRealtimeUrl(
  endpoint: string,
  workspaceId: string,
  model: string,
): string {
  assertIdentifier(workspaceId, 'workspace ID');
  assertIdentifier(model, 'model');
  const url = new URL(endpoint);
  if (url.protocol !== 'wss:') {
    throw new AliyunRealtimeTranslationProtocolError('Aliyun realtime endpoint must use wss');
  }
  if (url.hostname === 'cn-beijing.maas.aliyuncs.com') {
    url.hostname = `${workspaceId}.cn-beijing.maas.aliyuncs.com`;
  }
  if (!url.hostname.endsWith('.maas.aliyuncs.com')) {
    throw new AliyunRealtimeTranslationProtocolError('Aliyun realtime endpoint is not allowed');
  }
  url.searchParams.set('model', model);
  return url.toString();
}

async function resolveConfiguration(options: { strict: boolean }): Promise<ResolvedConfiguration | null> {
  const [enabled, workspaceId, apiKey, endpoint, model, maxSessionSecondsValue] = await Promise.all([
    serviceConfiguration('ALIYUN_REALTIME_TRANSLATION_ENABLED'),
    serviceConfiguration('ALIYUN_REALTIME_WORKSPACE_ID'),
    serviceConfiguration('ALIYUN_REALTIME_API_KEY'),
    serviceConfiguration('ALIYUN_REALTIME_WEBSOCKET_URL'),
    serviceConfiguration('ALIYUN_REALTIME_TRANSLATION_MODEL'),
    serviceConfiguration('ALIYUN_REALTIME_MAX_SESSION_SECONDS'),
  ]);
  if (enabled !== 'true') return null;
  if (!workspaceId || !apiKey || !endpoint || !model) {
    if (options.strict) throw new AliyunRealtimeTranslationNotConfiguredError();
    return null;
  }
  const maxSessionSeconds = Number(maxSessionSecondsValue);
  if (!Number.isSafeInteger(maxSessionSeconds) || maxSessionSeconds < 300 || maxSessionSeconds > 7_200) {
    if (options.strict) {
      throw new AliyunRealtimeTranslationProtocolError('Realtime translation duration is invalid');
    }
    return null;
  }
  return { apiKey, workspaceId, endpoint, model, maxSessionSeconds };
}

function parseServerEvent(raw: RawData): Record<string, unknown> {
  const text = Buffer.isBuffer(raw)
    ? raw.toString('utf8')
    : Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.from(raw).toString('utf8');
  if (text.length > 2_000_000) {
    throw new AliyunRealtimeTranslationProtocolError('Aliyun realtime event is too large');
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AliyunRealtimeTranslationProtocolError('Aliyun realtime event is invalid');
  }
  return parsed as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function boundedText(value: string): string {
  return value.trim().slice(0, 20_000);
}

function isAudioOutputRejection(code: string, parameter: string, message: string): boolean {
  const detail = `${code} ${parameter} ${message}`.toLowerCase();
  return [
    'modalit',
    'voice',
    'output_audio',
    'output audio',
    'audio output',
  ].some((marker) => detail.includes(marker));
}

function safeProviderDiagnostic(value: string): string | undefined {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return normalized || undefined;
}

function eventId(): string {
  return `event_${randomUUID().replaceAll('-', '')}`;
}

function assertIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new AliyunRealtimeTranslationProtocolError(`Invalid Aliyun realtime ${name}`);
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
