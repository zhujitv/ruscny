import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';

export type ServiceConfigurationCategory = 'ALIYUN_AI' | 'ALIYUN_RTC' | 'EMAIL' | 'STORAGE';
export type ServiceConfigurationValueType = 'string' | 'url' | 'integer' | 'boolean';

interface Definition {
  label: string;
  category: ServiceConfigurationCategory;
  type: ServiceConfigurationValueType;
  secret?: boolean;
  environmentValue: () => string | undefined;
  minimum?: number;
  maximum?: number;
}

export const serviceConfigurationDefinitions = {
  ALIYUN_API_KEY: secret('阿里云百炼 API Key', 'ALIYUN_AI', () => config.ALIYUN_API_KEY),
  ALIYUN_COMPATIBLE_BASE_URL: url('兼容模式 API 地址', 'ALIYUN_AI', () => config.ALIYUN_COMPATIBLE_BASE_URL),
  ALIYUN_DASHSCOPE_BASE_URL: url('DashScope API 地址', 'ALIYUN_AI', () => config.ALIYUN_DASHSCOPE_BASE_URL),
  ALIYUN_ASR_MODEL: text('语音识别模型', 'ALIYUN_AI', () => config.ALIYUN_ASR_MODEL),
  ALIYUN_TRANSLATION_MODEL: text('翻译模型', 'ALIYUN_AI', () => config.ALIYUN_TRANSLATION_MODEL),
  ALIYUN_TTS_MODEL: text('语音合成模型', 'ALIYUN_AI', () => config.ALIYUN_TTS_MODEL),
  ALIYUN_SUMMARY_MODEL: text('会议纪要模型', 'ALIYUN_AI', () => config.ALIYUN_SUMMARY_MODEL),
  ALIYUN_TTS_VOICE_ZH: text('中文语音', 'ALIYUN_AI', () => config.ALIYUN_TTS_VOICE_ZH),
  ALIYUN_TTS_VOICE_RU: text('俄文语音', 'ALIYUN_AI', () => config.ALIYUN_TTS_VOICE_RU),
  ALIYUN_RTC_APP_ID: text('RTC AppID', 'ALIYUN_RTC', () => config.ALIYUN_RTC_APP_ID),
  ALIYUN_RTC_APP_KEY: secret('RTC AppKey', 'ALIYUN_RTC', () => config.ALIYUN_RTC_APP_KEY),
  ALIYUN_RTC_TOKEN_TTL_SECONDS: integer(
    'RTC 令牌有效期（秒）', 'ALIYUN_RTC', () => String(config.ALIYUN_RTC_TOKEN_TTL_SECONDS), 300, 86_400,
  ),
  ALIYUN_REALTIME_WORKSPACE_ID: text('实时翻译工作空间 ID', 'ALIYUN_RTC', () => config.ALIYUN_REALTIME_WORKSPACE_ID),
  ALIYUN_REALTIME_API_KEY: secret('实时翻译 API Key', 'ALIYUN_RTC', () => config.ALIYUN_REALTIME_API_KEY),
  ALIYUN_REALTIME_TRANSLATION_ENABLED: bool(
    '启用好友通话实时翻译', 'ALIYUN_RTC', () => String(config.ALIYUN_REALTIME_TRANSLATION_ENABLED),
  ),
  ALIYUN_REALTIME_WEBSOCKET_URL: url('实时翻译 WebSocket 地址', 'ALIYUN_RTC', () => config.ALIYUN_REALTIME_WEBSOCKET_URL),
  ALIYUN_REALTIME_TRANSLATION_MODEL: text('实时翻译模型', 'ALIYUN_RTC', () => config.ALIYUN_REALTIME_TRANSLATION_MODEL),
  ALIYUN_REALTIME_MAX_SESSION_SECONDS: integer(
    '单次实时翻译最长时长（秒）', 'ALIYUN_RTC', () => String(config.ALIYUN_REALTIME_MAX_SESSION_SECONDS), 300, 7_200,
  ),
  RESEND_API_KEY: secret('Resend API Key', 'EMAIL', () => config.RESEND_API_KEY),
  RESEND_API_BASE_URL: url('邮件 API 地址', 'EMAIL', () => config.RESEND_API_BASE_URL),
  EMAIL_FROM: text('发件人', 'EMAIL', () => config.EMAIL_FROM),
  EMAIL_REPLY_TO: text('回复邮箱', 'EMAIL', () => config.EMAIL_REPLY_TO),
  S3_ENDPOINT: url('对象存储 API 地址', 'STORAGE', () => config.S3_ENDPOINT),
  S3_REGION: text('对象存储区域', 'STORAGE', () => config.S3_REGION),
  S3_BUCKET: text('对象存储桶', 'STORAGE', () => config.S3_BUCKET),
  S3_ACCESS_KEY_ID: secret('对象存储 Access Key ID', 'STORAGE', () => config.S3_ACCESS_KEY_ID),
  S3_SECRET_ACCESS_KEY: secret('对象存储 Secret Access Key', 'STORAGE', () => config.S3_SECRET_ACCESS_KEY),
  S3_FORCE_PATH_STYLE: bool('强制路径样式', 'STORAGE', () => String(config.S3_FORCE_PATH_STYLE)),
} as const satisfies Record<string, Definition>;

export type ServiceConfigurationKey = keyof typeof serviceConfigurationDefinitions;

const cacheTtlMs = 10_000;
const resolvedCache = new Map<ServiceConfigurationKey, { value: string | undefined; expiresAt: number }>();

export interface ServiceConfigurationAdminItem {
  key: ServiceConfigurationKey;
  label: string;
  category: ServiceConfigurationCategory;
  type: ServiceConfigurationValueType;
  secret: boolean;
  configured: boolean;
  source: 'database' | 'environment' | 'unset';
  value: string | null;
  version: number;
  updatedAt: Date | null;
}

export async function listServiceConfigurations(): Promise<ServiceConfigurationAdminItem[]> {
  const stored = await prisma.serviceConfiguration.findMany();
  const byKey = new Map(stored.map((item) => [item.key, item]));
  return (Object.entries(serviceConfigurationDefinitions) as Array<[ServiceConfigurationKey, Definition]>).map(
    ([key, definition]) => {
      const row = byKey.get(key);
      const environmentValue = definition.environmentValue();
      const configured = Boolean(row || environmentValue);
      return {
        key,
        label: definition.label,
        category: definition.category,
        type: definition.type,
        secret: Boolean(definition.secret),
        configured,
        source: row ? 'database' : environmentValue ? 'environment' : 'unset',
        value: definition.secret ? null : row?.value ?? environmentValue ?? null,
        version: row?.version ?? 0,
        updatedAt: row?.updatedAt ?? null,
      };
    },
  );
}

export async function serviceConfiguration(key: ServiceConfigurationKey): Promise<string | undefined> {
  const definition = serviceConfigurationDefinitions[key];
  // Isolated provider unit tests intentionally have no database. Production
  // and integration tests always resolve administrator overrides first.
  if ((config.NODE_ENV === 'test' || process.env.VITEST === 'true') && !process.env.DATABASE_URL) {
    return definition.environmentValue();
  }
  const cached = resolvedCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const stored = await prisma.serviceConfiguration.findUnique({ where: { key } });
  let value: string | undefined;
  if (!stored) {
    value = definition.environmentValue();
  } else if (!definition.secret) {
    value = stored.value ?? undefined;
  } else {
    if (!stored.encryptedValue) throw new Error(`Encrypted service configuration is missing: ${key}`);
    value = decryptConfiguredSecret(stored.encryptedValue, key);
  }
  resolvedCache.set(key, { value, expiresAt: Date.now() + cacheTtlMs });
  return value;
}

export function validateServiceConfigurationValue(
  key: ServiceConfigurationKey,
  input: unknown,
): string {
  const definition = serviceConfigurationDefinitions[key];
  if (definition.type === 'url') {
    const value = z.string().trim().min(1).max(2_000).url().refine((candidate) => ['https:', 'wss:'].includes(new URL(candidate).protocol), {
      message: '外部服务地址必须使用 HTTPS 或 WSS',
    }).parse(input);
    assertAllowedServiceEndpoint(key, value);
    return value;
  }
  if (definition.type === 'integer') {
    return String(z.coerce.number().int().min(definition.minimum ?? 0).max(definition.maximum ?? Number.MAX_SAFE_INTEGER).parse(input));
  }
  if (definition.type === 'boolean') {
    return String(z.union([z.boolean(), z.enum(['true', 'false'])]).parse(input));
  }
  return z.string().trim().min(1).max(2_000).parse(input);
}

export async function writeServiceConfiguration(
  key: ServiceConfigurationKey,
  value: string,
  expectedVersion: number,
  actorUserId: string,
  audit: { reason: string; requestId: string; ipAddress: string },
): Promise<{ version: number; updatedAt: Date }> {
  const definition = serviceConfigurationDefinitions[key];
  const payload = definition.secret
    ? { value: null, encryptedValue: encryptSecret(value, requireMasterKey(), key) }
    : { value, encryptedValue: null };
  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.serviceConfiguration.findUnique({ where: { key } });
    if ((current?.version ?? 0) !== expectedVersion) {
      throw new ServiceConfigurationVersionError();
    }
    let updated: { version: number; updatedAt: Date };
    if (current) {
      const claimed = await tx.serviceConfiguration.updateMany({
        where: { key, version: expectedVersion },
        data: { ...payload, version: { increment: 1 }, updatedById: actorUserId },
      });
      if (claimed.count !== 1) throw new ServiceConfigurationVersionError();
      updated = await tx.serviceConfiguration.findUniqueOrThrow({
        where: { key },
        select: { version: true, updatedAt: true },
      });
    } else {
      updated = await tx.serviceConfiguration.create({
        data: { key, ...payload, updatedById: actorUserId },
        select: { version: true, updatedAt: true },
      });
    }
    await tx.adminAuditLog.create({
      data: {
        actorUserId,
        action: 'SERVICE_CONFIGURATION_CHANGED',
        targetType: 'SERVICE_CONFIGURATION',
        targetId: key,
        metadata: {
          previousVersion: expectedVersion,
          nextVersion: updated.version,
          reason: audit.reason,
        },
        requestId: audit.requestId,
        ipAddress: audit.ipAddress,
      },
    });
    return updated;
  });
  resolvedCache.delete(key);
  return updated;
}

export async function deleteServiceConfiguration(
  key: ServiceConfigurationKey,
  expectedVersion: number,
  actorUserId: string,
  audit: { reason: string; requestId: string; ipAddress: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.serviceConfiguration.findUnique({ where: { key } });
    if (!current || current.version !== expectedVersion) {
      throw new ServiceConfigurationVersionError();
    }
    const removed = await tx.serviceConfiguration.deleteMany({
      where: { key, version: expectedVersion },
    });
    if (removed.count !== 1) throw new ServiceConfigurationVersionError();
    await tx.adminAuditLog.create({
      data: {
        actorUserId,
        action: 'SERVICE_CONFIGURATION_REMOVED',
        targetType: 'SERVICE_CONFIGURATION',
        targetId: key,
        metadata: {
          previousVersion: expectedVersion,
          fallback: serviceConfigurationDefinitions[key].environmentValue() ? 'environment' : 'unset',
          reason: audit.reason,
        },
        requestId: audit.requestId,
        ipAddress: audit.ipAddress,
      },
    });
  });
  resolvedCache.delete(key);
}

export class ServiceConfigurationVersionError extends Error {}

function requireMasterKey(): string {
  if (!config.SERVICE_CONFIG_MASTER_KEY) {
    throw new Error('SERVICE_CONFIG_MASTER_KEY is required for encrypted service configuration');
  }
  return config.SERVICE_CONFIG_MASTER_KEY;
}

function decryptConfiguredSecret(envelope: string, key: ServiceConfigurationKey): string {
  const keys = [
    requireMasterKey(),
    ...(config.SERVICE_CONFIG_PREVIOUS_MASTER_KEYS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length >= 32),
  ];
  let lastError: unknown;
  for (const masterKey of keys) {
    try {
      return decryptSecret(envelope, masterKey, key);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Unable to decrypt service configuration: ${key}`);
}

function assertAllowedServiceEndpoint(key: ServiceConfigurationKey, value: string): void {
  const url = new URL(value);
  const allowedProtocols = key === 'ALIYUN_REALTIME_WEBSOCKET_URL' ? ['wss:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol)) {
    throw new AppError(400, 'SERVICE_ENDPOINT_NOT_ALLOWED', `${key} 使用了不允许的协议`);
  }
  const builtInSuffixes: Partial<Record<ServiceConfigurationKey, string[]>> = {
    ALIYUN_COMPATIBLE_BASE_URL: ['dashscope.aliyuncs.com'],
    ALIYUN_DASHSCOPE_BASE_URL: ['dashscope.aliyuncs.com'],
    ALIYUN_REALTIME_WEBSOCKET_URL: ['maas.aliyuncs.com'],
    RESEND_API_BASE_URL: ['api.resend.com'],
    S3_ENDPOINT: [
      'aliyuncs.com',
      'amazonaws.com',
      'cloudflarestorage.com',
      'storage.googleapis.com',
    ],
  };
  const deploymentHosts = config.SERVICE_CONFIG_ALLOWED_HOSTS
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const allowed = [...(builtInSuffixes[key] ?? []), ...deploymentHosts];
  const hostname = url.hostname.toLowerCase();
  if (!allowed.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
    throw new AppError(400, 'SERVICE_ENDPOINT_NOT_ALLOWED', `${key} 的服务域名未在允许列表中`);
  }
}

export async function assertRuntimeServiceConfigurationReady(): Promise<void> {
  const required = new Set<ServiceConfigurationKey>();
  // Production must be ready to serve the released voice-call feature. In local
  // development, keep RTC optional so the rest of the API can run without cloud
  // credentials; once either value is supplied, require the complete pair.
  if (config.NODE_ENV === 'production' || config.ALIYUN_RTC_APP_ID || config.ALIYUN_RTC_APP_KEY) {
    required.add('ALIYUN_RTC_APP_ID');
    required.add('ALIYUN_RTC_APP_KEY');
  }
  const realtimeTranslationEnabled =
    (await serviceConfiguration('ALIYUN_REALTIME_TRANSLATION_ENABLED')) === 'true';
  if (realtimeTranslationEnabled) {
    required.add('ALIYUN_REALTIME_WORKSPACE_ID');
    required.add('ALIYUN_REALTIME_API_KEY');
    required.add('ALIYUN_REALTIME_WEBSOCKET_URL');
    required.add('ALIYUN_REALTIME_TRANSLATION_MODEL');
  }
  if (config.TRANSLATION_PROVIDER === 'aliyun' || config.SUMMARY_PROVIDER === 'aliyun') {
    required.add('ALIYUN_API_KEY');
    required.add('ALIYUN_COMPATIBLE_BASE_URL');
  }
  if (config.TRANSLATION_PROVIDER === 'aliyun') {
    required.add('ALIYUN_DASHSCOPE_BASE_URL');
  }
  if (config.EMAIL_PROVIDER === 'resend') {
    required.add('RESEND_API_KEY');
    required.add('RESEND_API_BASE_URL');
    required.add('EMAIL_FROM');
  }
  if (config.AUDIO_STORAGE_DRIVER === 's3') {
    for (const key of [
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ] as const) required.add(key);
  }
  const values = await Promise.all([...required].map(async (key) => [key, await serviceConfiguration(key)] as const));
  const missing = values.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Missing runtime service configuration: ${missing.join(', ')}`);
}

function text(label: string, category: ServiceConfigurationCategory, environmentValue: () => string | undefined): Definition {
  return { label, category, type: 'string', environmentValue };
}
function secret(label: string, category: ServiceConfigurationCategory, environmentValue: () => string | undefined): Definition {
  return { ...text(label, category, environmentValue), secret: true };
}
function url(label: string, category: ServiceConfigurationCategory, environmentValue: () => string | undefined): Definition {
  return { label, category, type: 'url', environmentValue };
}
function integer(label: string, category: ServiceConfigurationCategory, environmentValue: () => string | undefined, minimum: number, maximum: number): Definition {
  return { label, category, type: 'integer', environmentValue, minimum, maximum };
}
function bool(label: string, category: ServiceConfigurationCategory, environmentValue: () => string | undefined): Definition {
  return { label, category, type: 'boolean', environmentValue };
}
