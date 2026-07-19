import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { Prisma } from '@prisma/client';
import { Redis } from 'ioredis';
import { ZodError } from 'zod';
import { config } from './config.js';
import { prisma } from './db.js';
import { AppError } from './errors.js';
import { attachRealtime } from './realtime.js';
import { realtimeHub } from './realtime-hub.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAdminBusinessRoutes } from './routes/admin-business.js';
import { registerAdminWebRoutes } from './routes/admin-web.js';
import { registerCustomerWebRoutes } from './routes/customer-web.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAudioAssetRoutes } from './routes/audio-assets.js';
import { registerContactRoutes } from './routes/contacts.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerGlossaryRoutes } from './routes/glossary.js';
import { registerMessageReviewRoutes } from './routes/message-reviews.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerSocialRoutes } from './routes/social.js';
import { registerSummaryEmailRoutes } from './routes/summary-email.js';
import { registerWebGuestRoutes } from './routes/web-guest.js';

interface BuildOptions {
  logger?: FastifyServerOptions['logger'];
  realtime?: boolean;
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? (config.NODE_ENV === 'test' ? false : {
      level: config.LOG_LEVEL,
      serializers: {
        req(value: unknown) {
          const request = value as {
            id?: string;
            method?: string;
            url?: string;
            hostname?: string;
            remoteAddress?: string;
            remotePort?: number;
          };
          return {
            id: request.id,
            method: request.method,
            // Signed audio URLs and invite-like capability parameters must
            // never be written to request logs.
            url: requestLogUrl(request.url ?? ''),
            hostname: request.hostname,
            remoteAddress: request.remoteAddress,
            remotePort: request.remotePort,
          };
        },
      },
    }),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.UPLOAD_MAX_BYTES + 200_000,
    requestIdHeader: 'x-request-id',
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(cors, {
    origin: config.CORS_ORIGINS
      ? config.CORS_ORIGINS.split(',').map((value) => value.trim())
      : false,
  });

  const canonicalPublicOrigin = new URL(config.PUBLIC_APP_URL).origin;
  const canonicalPublicHostname = new URL(canonicalPublicOrigin).hostname.toLowerCase();
  const apexPublicHostname = canonicalPublicHostname.startsWith('www.')
    ? canonicalPublicHostname.slice(4)
    : undefined;
  if (apexPublicHostname) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.hostname.toLowerCase() !== apexPublicHostname) return;
      await reply.redirect(`${canonicalPublicOrigin}${request.raw.url ?? request.url}`, 308);
    });
  }

  let rateLimitRedis: Redis | undefined;
  if (config.REDIS_URL) {
    const candidate = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
    candidate.on('error', (error) => {
      app.log.warn({ error }, 'Redis rate-limit store error');
    });
    try {
      await candidate.connect();
      rateLimitRedis = candidate;
    } catch (error) {
      candidate.disconnect();
      if (config.NODE_ENV === 'production') throw error;
      app.log.warn({ error }, 'Redis rate-limit store unavailable; using local development store');
    }
  }
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    nameSpace: config.RATE_LIMIT_NAMESPACE,
    ...(rateLimitRedis ? { redis: rateLimitRedis } : {}),
  });
  if (rateLimitRedis) {
    app.addHook('onClose', async () => {
      await rateLimitRedis?.quit();
    });
  }
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.UPLOAD_MAX_BYTES, fields: 10 },
  });

  app.get('/v1', async () => ({
    ok: true,
    data: { service: 'zh-ru-translator-api', version: '0.1.0' },
  }));
  app.get('/health/live', async () => ({ ok: true, data: { status: 'live' } }));
  app.get('/health/ready', async () => {
    await prisma.$queryRaw`SELECT 1`;
    if (!realtimeHub().isReady()) {
      throw new AppError(503, 'REALTIME_NOT_READY', '实时通信暂未就绪');
    }
    return {
      ok: true,
      data: {
        status: 'ready',
        provider: config.TRANSLATION_PROVIDER,
      },
    };
  });

  await registerCustomerWebRoutes(app);
  await registerWebGuestRoutes(app);
  await registerAdminWebRoutes(app);
  await registerAuthRoutes(app);
  await registerAdminRoutes(app);
  await registerAdminBusinessRoutes(app);
  await registerAudioAssetRoutes(app);
  await registerContactRoutes(app);
  await registerConversationRoutes(app);
  await registerGlossaryRoutes(app);
  await registerMessageReviewRoutes(app);
  await registerMessageRoutes(app);
  await registerSocialRoutes(app);
  await registerSummaryEmailRoutes(app);

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send({ ok: false, code: 'NOT_FOUND', message: '接口不存在' });
  });
  app.setErrorHandler(async (error: unknown, request, reply) => {
    const normalized = normalizeError(error);
    if (normalized.statusCode >= 500) {
      const source = error instanceof Error ? error : new Error('Unknown error');
      request.log.error(
        { error: { name: source.name, message: source.message }, code: normalized.code },
        'request failed',
      );
    }
    await reply.code(normalized.statusCode).send({
      ok: false,
      code: normalized.code,
      message: normalized.message,
      requestId: request.id,
      ...(normalized.details ? { details: normalized.details } : {}),
    });
  });

  if (options.realtime !== false) await attachRealtime(app);
  return app;
}

export function requestLogUrl(rawUrl: string): string {
  const path = rawUrl.split('?', 1)[0] ?? '';
  // Invitation links carry a capability in the path rather than a query
  // string. Keep the route useful in logs without persisting that secret.
  return path.replace(
    /^\/join\/[A-Za-z0-9_-]{16,256}\/?$/,
    '/join/[redacted]',
  );
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new AppError(400, 'VALIDATION_ERROR', '请求参数不正确', error.flatten());
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return new AppError(409, 'DUPLICATE_RESOURCE', '数据已存在');
    if (error.code === 'P2025') return new AppError(404, 'NOT_FOUND', '资源不存在');
  }
  if (
    error instanceof Error &&
    'statusCode' in error &&
    (error as Error & { statusCode?: number }).statusCode === 413
  ) {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', '上传内容过大');
  }
  if (
    error instanceof Error &&
    'statusCode' in error &&
    (error as Error & { statusCode?: number }).statusCode === 429
  ) {
    return new AppError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
  }
  return new AppError(500, 'INTERNAL_ERROR', '服务器暂时无法处理请求');
}
