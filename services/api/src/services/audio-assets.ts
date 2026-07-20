import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { config } from '../config.js';
import { AppError, notFound } from '../errors.js';
import { safeEqual } from '../lib/crypto.js';
import { serviceConfiguration } from './service-configuration.js';

const assetPrefix = 'asset:';
const maximumTtsBytes = 15_000_000;
const validKey = /^tts-[0-9a-f-]+\.(mp3|wav|ogg|aac|m4a)$/;

let s3Client: S3Client | undefined;
let s3ClientFingerprint: string | undefined;

async function s3(): Promise<{ client: S3Client; bucket: string }> {
  const [endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyleValue] =
    await Promise.all([
      serviceConfiguration('S3_ENDPOINT'),
      serviceConfiguration('S3_REGION'),
      serviceConfiguration('S3_BUCKET'),
      serviceConfiguration('S3_ACCESS_KEY_ID'),
      serviceConfiguration('S3_SECRET_ACCESS_KEY'),
      serviceConfiguration('S3_FORCE_PATH_STYLE'),
    ]);
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
    throw new AppError(503, 'STORAGE_NOT_CONFIGURED', '对象存储尚未配置');
  }
  const fingerprint = [endpoint, region, accessKeyId, secretAccessKey, forcePathStyleValue].join('\u0000');
  if (!s3Client || s3ClientFingerprint !== fingerprint) {
    s3Client?.destroy();
    s3Client = new S3Client({
      endpoint,
      region,
      forcePathStyle: forcePathStyleValue === 'true',
      credentials: { accessKeyId, secretAccessKey },
    });
    s3ClientFingerprint = fingerprint;
  }
  return { client: s3Client, bucket };
}

export async function persistTtsAudio(upstreamUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(upstreamUrl);
  } catch {
    throw new AppError(502, 'TTS_ASSET_REJECTED', '语音服务返回了不可信的音频地址');
  }
  if (!isAliyunAssetHost(url.hostname)) {
    throw new AppError(502, 'TTS_ASSET_REJECTED', '语音服务返回了不可信的音频地址');
  }
  // DashScope currently returns a short-lived HTTP URL on its own Beijing OSS
  // result host. Upgrade only after the hostname has passed the exact Aliyun
  // boundary check; arbitrary HTTP origins remain rejected.
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') {
    throw new AppError(502, 'TTS_ASSET_REJECTED', '语音服务返回了不可信的音频地址');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(config.ALIYUN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AppError(502, 'TTS_ASSET_DOWNLOAD_FAILED', '无法下载生成的译文语音');
  }
  if (!response.ok) {
    throw new AppError(502, 'TTS_ASSET_DOWNLOAD_FAILED', '无法下载生成的译文语音');
  }
  const contentType = parseAudioContentType(response.headers.get('content-type'));
  if (!contentType) {
    throw new AppError(502, 'TTS_ASSET_INVALID', '语音服务返回了非音频内容');
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maximumTtsBytes) {
    throw new AppError(502, 'TTS_ASSET_TOO_LARGE', '生成的译文语音超过大小限制');
  }
  let bytes: Buffer;
  try {
    bytes = await readResponseBodyLimited(response, maximumTtsBytes);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'TTS_ASSET_DOWNLOAD_FAILED', '无法下载生成的译文语音');
  }
  if (!bytes.length) {
    throw new AppError(502, 'TTS_ASSET_INVALID', '生成的译文语音无效');
  }
  const key = `tts-${randomUUID()}.${extensionFor(contentType)}`;

  if (config.AUDIO_STORAGE_DRIVER === 's3') {
    const storage = await s3();
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        CacheControl: 'private, no-store',
        ServerSideEncryption: 'AES256',
      }),
    );
  } else {
    await mkdir(config.AUDIO_LOCAL_DIRECTORY, { recursive: true });
    await writeFile(path.join(config.AUDIO_LOCAL_DIRECTORY, key), bytes, { flag: 'wx' });
  }
  return `${assetPrefix}${key}`;
}

export function playableAudioUrl(storedValue: string | null): string | null {
  if (!storedValue) return null;
  if (!storedValue.startsWith(assetPrefix)) return null;
  const key = storedValue.slice(assetPrefix.length);
  if (!validKey.test(key)) return null;
  const expires = Math.floor(Date.now() / 1_000) + config.AUDIO_SIGNED_URL_TTL_SECONDS;
  const signature = assetSignature(key, expires);
  return `${config.PUBLIC_API_URL.replace(/\/$/, '')}/v1/audio/assets/${encodeURIComponent(key)}` +
    `?expires=${expires}&signature=${signature}`;
}

export function storedAudioAssetValue(key: string): string {
  if (!validKey.test(key)) {
    throw new AppError(403, 'AUDIO_URL_INVALID', '语音播放链接无效或已过期');
  }
  return `${assetPrefix}${key}`;
}

export function isStoredTtsAsset(storedValue: string | null): storedValue is string {
  if (!storedValue?.startsWith(assetPrefix)) return false;
  return validKey.test(storedValue.slice(assetPrefix.length));
}

export function verifyAssetSignature(key: string, expires: number, signature: string): void {
  const now = Math.floor(Date.now() / 1_000);
  if (
    !validKey.test(key) ||
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires > now + config.AUDIO_SIGNED_URL_TTL_SECONDS + 60 ||
    !safeEqual(assetSignature(key, expires), signature)
  ) {
    throw new AppError(403, 'AUDIO_URL_INVALID', '语音播放链接无效或已过期');
  }
}

export async function readTtsAsset(
  key: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  if (!validKey.test(key)) throw notFound('AUDIO_NOT_FOUND', '语音不存在');
  try {
    if (config.AUDIO_STORAGE_DRIVER === 's3') {
      const storage = await s3();
      const result = await storage.client.send(
        new GetObjectCommand({ Bucket: storage.bucket, Key: key }),
      );
      if (result.ContentLength && result.ContentLength > maximumTtsBytes) {
        throw new Error('object too large');
      }
      const raw = await result.Body?.transformToByteArray();
      if (!raw?.length || raw.length > maximumTtsBytes) throw new Error('invalid object');
      return {
        bytes: Buffer.from(raw),
        contentType: parseAudioContentType(result.ContentType) ?? contentTypeForKey(key),
      };
    }
    const bytes = await readFile(path.join(config.AUDIO_LOCAL_DIRECTORY, key));
    if (!bytes.length || bytes.length > maximumTtsBytes) throw new Error('invalid asset');
    return { bytes, contentType: contentTypeForKey(key) };
  } catch {
    throw notFound('AUDIO_NOT_FOUND', '语音不存在或已清理');
  }
}

export async function deleteTtsAsset(storedValue: string | null): Promise<void> {
  if (!isStoredTtsAsset(storedValue)) return;
  const key = storedValue.slice(assetPrefix.length);
  try {
    if (config.AUDIO_STORAGE_DRIVER === 's3') {
      const storage = await s3();
      await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
    } else {
      await unlink(path.join(config.AUDIO_LOCAL_DIRECTORY, key));
    }
  } catch (error) {
    if (
      config.AUDIO_STORAGE_DRIVER === 'local' &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    throw new AppError(502, 'AUDIO_DELETE_FAILED', '语音文件删除失败，请稍后重试');
  }
}

export async function deleteTtsAssets(storedValues: Array<string | null>): Promise<void> {
  const results = await Promise.allSettled(
    [...new Set(storedValues)].map((value) => deleteTtsAsset(value)),
  );
  if (results.some((result) => result.status === 'rejected')) {
    throw new AppError(502, 'AUDIO_DELETE_FAILED', '部分语音文件删除失败，请稍后重试');
  }
}

function assetSignature(key: string, expires: number): string {
  return createHmac(
    'sha256',
    config.AUDIO_URL_SIGNING_SECRET ?? config.JWT_ACCESS_SECRET,
  )
    .update(`${key}.${expires}`)
    .digest('base64url');
}

function isAliyunAssetHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'aliyuncs.com' ||
    normalized.endsWith('.aliyuncs.com') ||
    normalized === 'aliyun.com' ||
    normalized.endsWith('.aliyun.com');
}

function parseAudioContentType(value: string | undefined | null): string | null {
  const contentType = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType?.startsWith('audio/')) return contentType;
  return null;
}

async function readResponseBodyLimited(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing response body');
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new AppError(502, 'TTS_ASSET_TOO_LARGE', '生成的译文语音超过大小限制');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function extensionFor(contentType: string): string {
  if (contentType.includes('wav')) return 'wav';
  if (contentType.includes('ogg') || contentType.includes('opus')) return 'ogg';
  if (contentType.includes('aac')) return 'aac';
  if (contentType.includes('mp4') || contentType.includes('m4a')) return 'm4a';
  return 'mp3';
}

function contentTypeForKey(key: string): string {
  if (key.endsWith('.wav')) return 'audio/wav';
  if (key.endsWith('.ogg')) return 'audio/ogg';
  if (key.endsWith('.aac')) return 'audio/aac';
  if (key.endsWith('.m4a')) return 'audio/mp4';
  return 'audio/mpeg';
}
