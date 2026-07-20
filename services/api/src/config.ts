import 'dotenv/config';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

// dotenv represents an intentionally unset `KEY=` as an empty string. Treat
// blank optional secrets and endpoints as absent so the committed example can
// be copied for local development without weakening production validation.
const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);
const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional(),
);
const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(32).optional(),
);
const optionalEmail = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().email().max(254).optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: booleanString,
  DATABASE_URL: z
    .string()
    .default('postgresql://translator:translator@localhost:5432/translator?schema=public'),
  REDIS_URL: optionalString,
  RATE_LIMIT_NAMESPACE: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9:_-]+$/)
    .default('zh-ru-translator-rate-limit-'),
  JWT_ACCESS_SECRET: z.string().min(32).default('development-access-secret-change-me-0001'),
  JWT_REFRESH_SECRET: z.string().min(32).default('development-refresh-secret-change-me-001'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  PASSWORD_PEPPER: z.string().min(16).default('development-password-pepper-change-me'),
  // Bootstrap key used only to encrypt service credentials stored by the
  // administrator. It must stay in the deployment secret store and is never
  // exposed through the admin API.
  SERVICE_CONFIG_MASTER_KEY: optionalSecret,
  SERVICE_CONFIG_PREVIOUS_MASTER_KEYS: optionalString,
  SERVICE_CONFIG_ALLOWED_HOSTS: z.string().default(''),
  // Bootstrap access is bound to immutable User ids, never to reusable email
  // addresses. Database isSystemAdmin remains the preferred durable capability.
  SYSTEM_ADMIN_USER_IDS: z.string().default(''),
  ADMIN_PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1_440).default(30),
  LEGAL_POLICY_VERSION: z.string().trim().min(1).max(100).default('2026-07-19-ai-summary'),
  TRANSLATION_PROVIDER: z.enum(['mock', 'aliyun']).default('mock'),
  ALIYUN_API_KEY: optionalString,
  ALIYUN_COMPATIBLE_BASE_URL: z
    .string()
    .url()
    .default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  ALIYUN_DASHSCOPE_BASE_URL: z
    .string()
    .url()
    .default('https://dashscope.aliyuncs.com/api/v1'),
  ALIYUN_ASR_MODEL: z.string().default('qwen3-asr-flash'),
  ALIYUN_TRANSLATION_MODEL: z.string().default('qwen-mt-flash'),
  ALIYUN_TTS_MODEL: z.string().default('qwen3-tts-flash'),
  SUMMARY_PROVIDER: z.enum(['mock', 'aliyun']).default('mock'),
  ALIYUN_SUMMARY_MODEL: z.string().default('qwen-plus'),
  SUMMARY_MAX_MESSAGES: z.coerce.number().int().min(1).max(5_000).default(1_000),
  SUMMARY_MAX_INPUT_CHARACTERS: z.coerce.number().int().min(10_000).max(2_000_000).default(500_000),
  SUMMARY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(120_000),
  SUMMARY_GENERATION_STALE_MS: z.coerce.number().int().min(30_000).max(900_000).default(180_000),
  ALIYUN_TTS_VOICE_ZH: optionalString,
  ALIYUN_TTS_VOICE_RU: optionalString,
  ALIYUN_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
  EMAIL_PROVIDER: z.enum(['mock', 'resend']).default('mock'),
  RESEND_API_KEY: optionalString,
  RESEND_API_BASE_URL: z.string().url().default('https://api.resend.com'),
  EMAIL_FROM: optionalString,
  EMAIL_REPLY_TO: optionalEmail,
  EMAIL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  EMAIL_VERIFICATION_TTL_MINUTES: z.coerce.number().int().min(10).max(10_080).default(1_440),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(10).max(1_440).default(30),
  PUBLIC_APP_URL: z.string().url().default('https://www.ruscny.net'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  INVITE_TTL_MINUTES: z.coerce.number().int().positive().default(1_440),
  // Qwen3-ASR's request cap includes Base64 expansion and JSON overhead.
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().max(6_000_000).default(6_000_000),
  CORS_ORIGINS: z.string().default(''),
  AUDIO_STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  AUDIO_LOCAL_DIRECTORY: z.string().default('storage/audio'),
  AUDIO_URL_SIGNING_SECRET: optionalSecret,
  AUDIO_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  S3_ENDPOINT: optionalUrl,
  S3_REGION: optionalString,
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_FORCE_PATH_STYLE: booleanString,
  ALIYUN_RTC_APP_ID: optionalString,
  ALIYUN_RTC_APP_KEY: optionalString,
  ALIYUN_RTC_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(3_600),
  ALIYUN_REALTIME_WORKSPACE_ID: optionalString,
  ALIYUN_REALTIME_API_KEY: optionalString,
  ALIYUN_REALTIME_TRANSLATION_ENABLED: booleanString,
  ALIYUN_REALTIME_WEBSOCKET_URL: z.string().url().default('wss://cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime'),
  ALIYUN_REALTIME_TRANSLATION_MODEL: z.string().default('qwen3.5-livetranslate-flash-realtime'),
  ALIYUN_REALTIME_MAX_SESSION_SECONDS: z.coerce.number().int().min(300).max(7_200).default(3_600),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(environment);
  if (parsed.NODE_ENV === 'production') {
    const unsafe = [
      parsed.JWT_ACCESS_SECRET,
      parsed.JWT_REFRESH_SECRET,
      parsed.PASSWORD_PEPPER,
    ].some((value) => value.startsWith('development-'));
    if (unsafe) throw new Error('Production authentication secrets are not configured');
    if (!parsed.SERVICE_CONFIG_MASTER_KEY) {
      throw new Error('SERVICE_CONFIG_MASTER_KEY is required in production');
    }
    if (!hasSecurePostgresTransport(parsed.DATABASE_URL)) {
      throw new Error('Production DATABASE_URL must require TLS with sslmode=require or verify');
    }
    if (!parsed.REDIS_URL) throw new Error('REDIS_URL is required in production');
    if (!hasSecureRedisTransport(parsed.REDIS_URL)) {
      throw new Error(
        'Production REDIS_URL must use rediss:// or authenticated Railway private networking',
      );
    }
    if (parsed.TRANSLATION_PROVIDER !== 'aliyun') {
      throw new Error('Production requires TRANSLATION_PROVIDER=aliyun');
    }
    if (parsed.SUMMARY_PROVIDER !== 'aliyun') {
      throw new Error('Production requires SUMMARY_PROVIDER=aliyun');
    }
    if (parsed.EMAIL_PROVIDER !== 'resend') {
      throw new Error('Production requires EMAIL_PROVIDER=resend');
    }
    if (parsed.AUDIO_STORAGE_DRIVER !== 's3') {
      throw new Error('Production requires AUDIO_STORAGE_DRIVER=s3');
    }
    if (!parsed.AUDIO_URL_SIGNING_SECRET) {
      throw new Error('AUDIO_URL_SIGNING_SECRET is required in production');
    }
    if (!parsed.PUBLIC_API_URL.startsWith('https://')) {
      throw new Error('PUBLIC_API_URL must use HTTPS in production');
    }
    if (
      !parsed.PUBLIC_APP_URL.startsWith('https://') ||
      !parsed.ALIYUN_COMPATIBLE_BASE_URL.startsWith('https://') ||
      !parsed.ALIYUN_DASHSCOPE_BASE_URL.startsWith('https://') ||
      !parsed.RESEND_API_BASE_URL.startsWith('https://') ||
      (parsed.S3_ENDPOINT != null && !parsed.S3_ENDPOINT.startsWith('https://'))
    ) {
      throw new Error('Production public and external service URLs must use HTTPS');
    }
  }
  return parsed;
}

export const config = loadConfig();

function hasSecurePostgresTransport(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') return false;
    return ['require', 'verify-ca', 'verify-full'].includes(
      (url.searchParams.get('sslmode') ?? '').toLowerCase(),
    );
  } catch {
    return false;
  }
}

function hasSecureRedisTransport(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'rediss:') return true;
    return url.protocol === 'redis:'
      && url.hostname.endsWith('.railway.internal')
      && url.password.length > 0;
  } catch {
    return false;
  }
}
