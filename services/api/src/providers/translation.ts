import type { Language } from '@prisma/client';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { serviceConfiguration } from '../services/service-configuration.js';

export interface TranslationTerm {
  source: string;
  target: string;
}

export interface ProviderMetadata {
  provider: string;
  requestId?: string;
}

export interface TranslationProvider {
  transcribe(input: {
    audio: Buffer;
    mimeType: string;
    language: 'zh' | 'ru';
    mockHint?: string;
  }): Promise<{ text: string } & ProviderMetadata>;
  translate(input: {
    text: string;
    sourceLanguage: 'zh' | 'ru';
    targetLanguage: 'zh' | 'ru';
    terms: TranslationTerm[];
  }): Promise<{ text: string } & ProviderMetadata>;
  synthesize(input: {
    text: string;
    language: 'zh' | 'ru';
  }): Promise<{ audioUrl: string } & ProviderMetadata>;
}

const mockTranslations: Record<string, string> = {
  '这个产品有库存。': 'Этот товар есть в наличии.',
  '最低订购量是多少？': 'Каков минимальный объём заказа?',
  'Какой минимальный объём заказа?': '最低订购量是多少？',
  'Этот товар есть в наличии.': '这个产品有库存。',
};

class MockTranslationProvider implements TranslationProvider {
  async transcribe(input: {
    language: 'zh' | 'ru';
    mockHint?: string;
  }): Promise<{ text: string; provider: string }> {
    return {
      text:
        input.mockHint?.trim() ||
        (input.language === 'zh' ? '这个产品有库存。' : 'Какой минимальный объём заказа?'),
      provider: 'mock',
    };
  }

  async translate(input: {
    text: string;
    sourceLanguage: 'zh' | 'ru';
  }): Promise<{ text: string; provider: string }> {
    return {
      text:
        mockTranslations[input.text] ??
        (input.sourceLanguage === 'zh'
          ? `[模拟俄语译文] ${input.text}`
          : `[模拟中文译文] ${input.text}`),
      provider: 'mock',
    };
  }

  async synthesize(): Promise<{ audioUrl: string; provider: string }> {
    // Deliberately no fake playable URL. The client exercises the valid TTS-degraded state.
    throw new AppError(502, 'TTS_UNAVAILABLE', 'Mock 模式不生成语音');
  }
}

interface OpenAICompatibleResponse {
  id?: string;
  request_id?: string;
  choices?: Array<{ message?: { content?: string } }>;
  output?: unknown;
}

class AliyunTranslationProvider implements TranslationProvider {
  private async request(
    url: string,
    body: unknown,
  ): Promise<{ json: OpenAICompatibleResponse; requestId?: string }> {
    const apiKey = await serviceConfiguration('ALIYUN_API_KEY');
    if (!apiKey) {
      throw new AppError(503, 'PROVIDER_CONFIGURATION_ERROR', '阿里云服务未配置');
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.ALIYUN_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new AppError(504, 'PROVIDER_TIMEOUT', '翻译服务响应超时');
      }
      throw new AppError(502, 'PROVIDER_UNAVAILABLE', '无法连接翻译服务');
    }
    const requestId = response.headers.get('x-request-id') ?? undefined;
    const json = (await response.json().catch(() => ({}))) as OpenAICompatibleResponse & {
      code?: string;
      message?: string;
    };
    if (!response.ok) {
      throw providerHttpError(response.status);
    }
    return { json, ...(requestId ? { requestId } : {}) };
  }

  async transcribe(input: {
    audio: Buffer;
    mimeType: string;
    language: 'zh' | 'ru';
  }): Promise<{ text: string; provider: string; requestId?: string }> {
    const [baseUrl, model] = await Promise.all([
      serviceConfiguration('ALIYUN_COMPATIBLE_BASE_URL'),
      serviceConfiguration('ALIYUN_ASR_MODEL'),
    ]);
    const data = `data:${input.mimeType};base64,${input.audio.toString('base64')}`;
    const result = await this.request(
      `${baseUrl!.replace(/\/$/, '')}/chat/completions`,
      {
        model,
        messages: [
          {
            role: 'user',
            content: [{ type: 'input_audio', input_audio: { data } }],
          },
        ],
        stream: false,
        asr_options: { language: input.language, enable_itn: input.language === 'zh' },
      },
    );
    const text = result.json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new AppError(422, 'ASR_NO_SPEECH', '未识别到有效语音');
    return {
      text,
      provider: model!,
      ...(result.requestId ? { requestId: result.requestId } : {}),
    };
  }

  async translate(input: {
    text: string;
    sourceLanguage: 'zh' | 'ru';
    targetLanguage: 'zh' | 'ru';
    terms: TranslationTerm[];
  }): Promise<{ text: string; provider: string; requestId?: string }> {
    const [baseUrl, model] = await Promise.all([
      serviceConfiguration('ALIYUN_COMPATIBLE_BASE_URL'),
      serviceConfiguration('ALIYUN_TRANSLATION_MODEL'),
    ]);
    const languageName = (language: 'zh' | 'ru') =>
      language === 'zh' ? 'Chinese' : 'Russian';
    const result = await this.request(
      `${baseUrl!.replace(/\/$/, '')}/chat/completions`,
      {
        model,
        messages: [{ role: 'user', content: input.text }],
        translation_options: {
          source_lang: languageName(input.sourceLanguage),
          target_lang: languageName(input.targetLanguage),
          ...(input.terms.length ? { terms: input.terms.slice(0, 100) } : {}),
        },
      },
    );
    const text = result.json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new AppError(502, 'MT_FAILED', '翻译服务未返回译文');
    return {
      text,
      provider: model!,
      ...(result.requestId ? { requestId: result.requestId } : {}),
    };
  }

  async synthesize(input: {
    text: string;
    language: 'zh' | 'ru';
  }): Promise<{ audioUrl: string; provider: string; requestId?: string }> {
    const [baseUrl, model, voice] = await Promise.all([
      serviceConfiguration('ALIYUN_DASHSCOPE_BASE_URL'),
      serviceConfiguration('ALIYUN_TTS_MODEL'),
      serviceConfiguration(input.language === 'zh' ? 'ALIYUN_TTS_VOICE_ZH' : 'ALIYUN_TTS_VOICE_RU'),
    ]);
    const result = await this.request(
      `${baseUrl!.replace(/\/$/, '')}/services/aigc/multimodal-generation/generation`,
      {
        model,
        input: {
          text: input.text,
          language_type: input.language === 'zh' ? 'Chinese' : 'Russian',
          ...(voice ? { voice } : {}),
        },
      },
    );
    const audioUrl = findAudioUrl(result.json);
    if (!audioUrl) throw new AppError(502, 'TTS_FAILED', '语音服务未返回音频');
    return {
      audioUrl,
      provider: model!,
      ...(result.requestId ? { requestId: result.requestId } : {}),
    };
  }
}

export function providerHttpError(status: number): AppError {
  if (status === 429) {
    return new AppError(
      429,
      'PROVIDER_RATE_LIMITED',
      '翻译服务请求过于频繁，请稍后重试',
    );
  }
  return new AppError(502, 'PROVIDER_FAILED', '翻译服务调用失败');
}

function findAudioUrl(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.url === 'string' && /^https?:\/\//.test(object.url)) return object.url;
  for (const child of Object.values(object)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findAudioUrl(item);
        if (found) return found;
      }
    } else {
      const found = findAudioUrl(child);
      if (found) return found;
    }
  }
  return undefined;
}

export const translationProvider: TranslationProvider =
  config.TRANSLATION_PROVIDER === 'aliyun'
    ? new AliyunTranslationProvider()
    : new MockTranslationProvider();

export function assertLanguagePair(source: Language, target: Language): asserts source is 'zh' | 'ru' {
  if (
    !['zh', 'ru'].includes(source) ||
    !['zh', 'ru'].includes(target) ||
    source === target
  ) {
    throw new AppError(400, 'INVALID_LANGUAGE_PAIR', '第一版只支持中文与俄语互译');
  }
}
