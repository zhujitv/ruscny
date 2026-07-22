import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const productionSecrets = {
  JWT_ACCESS_SECRET: 'production-access-secret-0000000000000001',
  JWT_REFRESH_SECRET: 'production-refresh-secret-00000000000001',
  PASSWORD_PEPPER: 'production-password-pepper-0001',
  SERVICE_CONFIG_MASTER_KEY: 'production-service-config-master-key-0001',
  DATABASE_URL:
    'postgresql://translator:secret@db.internal:5432/translator?schema=public&sslmode=require',
  REDIS_URL: 'rediss://redis.internal:6380',
  PUBLIC_API_URL: 'https://api.translate.example.com',
  AUDIO_STORAGE_DRIVER: 's3',
  AUDIO_URL_SIGNING_SECRET: 'production-audio-signing-secret-000001',
  S3_ENDPOINT: 'https://objects.example.com',
  S3_REGION: 'cn-test-1',
  S3_BUCKET: 'translator-audio',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test_server_side_key',
  EMAIL_FROM: 'RUSCNY <minutes@send.example.com>',
  SUMMARY_PROVIDER: 'aliyun',
};

describe('production configuration guards', () => {
  it('keeps ASR uploads below the provider Base64 request limit', () => {
    expect(loadConfig({}).UPLOAD_MAX_BYTES).toBe(6_000_000);
    expect(() => loadConfig({ UPLOAD_MAX_BYTES: '6000001' })).toThrow();
  });

  it('uses virtual-hosted S3 URLs by default and allows MinIO path style explicitly', () => {
    expect(loadConfig({}).S3_FORCE_PATH_STYLE).toBe(false);
    expect(loadConfig({ S3_FORCE_PATH_STYLE: 'true' }).S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('uses a bounded Redis namespace for shared rate limits', () => {
    expect(loadConfig({}).RATE_LIMIT_NAMESPACE).toBe('zh-ru-translator-rate-limit-');
    expect(loadConfig({ RATE_LIMIT_NAMESPACE: 'translator:staging:rate-' }).RATE_LIMIT_NAMESPACE)
      .toBe('translator:staging:rate-');
    expect(() => loadConfig({ RATE_LIMIT_NAMESPACE: 'invalid namespace' })).toThrow();
  });

  it('treats blank optional values from a copied env example as unset', () => {
    const parsed = loadConfig({
      AUDIO_URL_SIGNING_SECRET: '',
      REDIS_URL: '',
      S3_ENDPOINT: '',
      S3_REGION: '',
      S3_BUCKET: '',
      S3_ACCESS_KEY_ID: '',
      S3_SECRET_ACCESS_KEY: '',
      RESEND_API_KEY: '',
      EMAIL_FROM: '',
    });

    expect(parsed.AUDIO_URL_SIGNING_SECRET).toBeUndefined();
    expect(parsed.S3_ENDPOINT).toBeUndefined();
    expect(parsed.RESEND_API_KEY).toBeUndefined();
  });

  it('keeps administrator bootstrap explicit and bounds reset-link lifetime', () => {
    expect(loadConfig({}).SYSTEM_ADMIN_USER_IDS).toBe('');
    expect(loadConfig({ ADMIN_PASSWORD_RESET_TTL_MINUTES: '15' }).ADMIN_PASSWORD_RESET_TTL_MINUTES)
      .toBe(15);
    expect(() => loadConfig({ ADMIN_PASSWORD_RESET_TTL_MINUTES: '2' })).toThrow();
    expect(() => loadConfig({ ADMIN_PASSWORD_RESET_TTL_MINUTES: '1441' })).toThrow();
  });

  it('refuses development authentication secrets in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      'Production authentication secrets are not configured',
    );
  });

  it('allows external credentials to be supplied by encrypted administrator configuration', () => {
    const parsed = loadConfig({
      NODE_ENV: 'production',
      TRANSLATION_PROVIDER: 'aliyun',
      ...productionSecrets,
      ALIYUN_API_KEY: '',
      RESEND_API_KEY: '',
      S3_ACCESS_KEY_ID: '',
      S3_SECRET_ACCESS_KEY: '',
    });
    expect(parsed.ALIYUN_API_KEY).toBeUndefined();
    expect(parsed.SERVICE_CONFIG_MASTER_KEY).toBeTruthy();
  });

  it('allows the S3 endpoint itself to come from administrator configuration', () => {
    const parsed = loadConfig({
      NODE_ENV: 'production',
      TRANSLATION_PROVIDER: 'aliyun',
      ...productionSecrets,
      S3_ENDPOINT: '',
    });
    expect(parsed.S3_ENDPOINT).toBeUndefined();
  });

  it('refuses the fixed mock translator in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        TRANSLATION_PROVIDER: 'mock',
        ...productionSecrets,
      }),
    ).toThrow('Production requires TRANSLATION_PROVIDER=aliyun');
  });

  it('accepts Aliyun only when its server-side provider configuration is complete', () => {
    const parsed = loadConfig({
      NODE_ENV: 'production',
      TRANSLATION_PROVIDER: 'aliyun',
      ALIYUN_API_KEY: 'server-side-key',
      ALIYUN_TTS_VOICE_ZH: 'zh-voice',
      ALIYUN_TTS_VOICE_RU: 'ru-voice',
      ...productionSecrets,
    });
    expect(parsed.ALIYUN_API_KEY).toBe('server-side-key');
  });

  it('rejects plaintext PostgreSQL and public Redis transports in production', () => {
    const complete = {
      NODE_ENV: 'production',
      TRANSLATION_PROVIDER: 'aliyun',
      ALIYUN_API_KEY: 'server-side-key',
      ALIYUN_TTS_VOICE_ZH: 'zh-voice',
      ALIYUN_TTS_VOICE_RU: 'ru-voice',
      ...productionSecrets,
    };
    expect(() => loadConfig({
      ...complete,
      DATABASE_URL: 'postgresql://translator:secret@db.internal:5432/translator',
    })).toThrow('Production DATABASE_URL must require TLS');
    expect(() => loadConfig({
      ...complete,
      REDIS_URL: 'redis://redis.internal:6379',
    })).toThrow('Production REDIS_URL must use rediss:// or authenticated Railway private networking');
    expect(() => loadConfig({
      ...complete,
      REDIS_URL: 'redis://redis.railway.internal:6379',
    })).toThrow('Production REDIS_URL must use rediss:// or authenticated Railway private networking');
  });

  it('accepts authenticated Redis on Railway private networking', () => {
    const parsed = loadConfig({
      NODE_ENV: 'production',
      TRANSLATION_PROVIDER: 'aliyun',
      ALIYUN_API_KEY: 'server-side-key',
      ALIYUN_TTS_VOICE_ZH: 'zh-voice',
      ALIYUN_TTS_VOICE_RU: 'ru-voice',
      ...productionSecrets,
      REDIS_URL: 'redis://default:secret@redis.railway.internal:6379',
    });
    expect(parsed.REDIS_URL).toBe('redis://default:secret@redis.railway.internal:6379');
  });

  it('accepts PostgreSQL certificate verification modes in production', () => {
    const parsed = loadConfig({
      NODE_ENV: 'production',
      TRANSLATION_PROVIDER: 'aliyun',
      ALIYUN_API_KEY: 'server-side-key',
      ALIYUN_TTS_VOICE_ZH: 'zh-voice',
      ALIYUN_TTS_VOICE_RU: 'ru-voice',
      ...productionSecrets,
      DATABASE_URL:
        'postgresql://translator:secret@db.internal:5432/translator?sslmode=verify-full',
    });
    expect(parsed.REDIS_URL).toBe('rediss://redis.internal:6380');
  });

  it('rejects insecure provider or object-storage URLs in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        TRANSLATION_PROVIDER: 'aliyun',
        ALIYUN_API_KEY: 'server-side-key',
        ALIYUN_TTS_VOICE_ZH: 'zh-voice',
        ALIYUN_TTS_VOICE_RU: 'ru-voice',
        ALIYUN_DASHSCOPE_BASE_URL: 'http://dashscope.example.com/api/v1',
        ...productionSecrets,
      }),
    ).toThrow('Production public and external service URLs must use HTTPS');
  });
});
