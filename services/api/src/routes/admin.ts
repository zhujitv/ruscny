import { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isSystemAdminRecord, requireAdminCapability, type AdminCapability } from '../admin-auth.js';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { randomToken, secretHash } from '../lib/crypto.js';
import { realtimeHub } from '../realtime-hub.js';
import { hashPassword } from '../services/passwords.js';
import { historyExpiresAt } from '../policies.js';
import { messageDto } from '../services/conversations.js';
import { retryFailedMessage } from '../services/admin-message-retry.js';
import { wakeAudioDeletionWorker } from '../services/audio-deletion-outbox.js';
import { wakeSummaryEmailWorker } from './summary-email.js';

const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const reasonSchema = z.string().trim().max(500).optional();
const PASSWORD_RESET_CONTEXT = 'admin-password-reset-v1:';

export function adminPasswordResetTokenHash(token: string): string {
  return secretHash(`${PASSWORD_RESET_CONTEXT}${token}`, config.PASSWORD_PEPPER);
}

async function adminPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAdminCapability(request, reply, capabilityForAdminRoute(request));
  reply.header('Cache-Control', 'private, no-store');
  reply.header('Pragma', 'no-cache');
}

function capabilityForAdminRoute(request: FastifyRequest): AdminCapability {
  const route = request.routeOptions.url ?? request.url.split('?', 1)[0] ?? '';
  if (route === '/v1/admin/audit-logs') return 'READ_AUDIT';
  if (route.startsWith('/v1/admin/admins')) return 'MANAGE_ADMIN_ROLES';
  if (route === '/v1/admin/failures/:id/retry') return 'RETRY_FAILURES';
  if (route === '/v1/admin/tasks/:type/:id/retry') return 'RETRY_TASKS';
  if (request.method !== 'GET' && route.startsWith('/v1/admin/users/')) return 'MANAGE_USERS';
  if (request.method !== 'GET' && route.startsWith('/v1/admin/conversations/')) return 'MANAGE_MEETINGS';
  return 'READ_OPERATIONS';
}

function auditContext(request: FastifyRequest) {
  return {
    actorUserId: request.auth.subjectId,
    requestId: request.id,
    ipAddress: request.ip.slice(0, 200),
  };
}

function auditCreate(
  tx: Prisma.TransactionClient,
  request: FastifyRequest,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Prisma.InputJsonObject = {},
) {
  return tx.adminAuditLog.create({
    data: {
      ...auditContext(request),
      action,
      targetType,
      targetId,
      metadata,
    },
  });
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/auth/password/reset',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = z.object({
        token: z.string().min(32).max(512),
        newPassword: z.string().min(8).max(128),
      }).parse(request.body);
      const now = new Date();
      const passwordHash = await hashPassword(body.newPassword, config.PASSWORD_PEPPER);
      const tokenHash = adminPasswordResetTokenHash(body.token);
      const targetUserId = await prisma.$transaction(async (tx) => {
        const credential = await tx.adminPasswordResetToken.findUnique({
          where: { tokenHash },
          select: {
            id: true,
            userId: true,
            createdById: true,
            usedAt: true,
            expiresAt: true,
          },
        });
        if (
          !credential ||
          credential.usedAt ||
          credential.expiresAt <= now
        ) {
          throw unauthorized('RESET_TOKEN_INVALID', '重置凭证无效或已过期');
        }
        // Keep the same User -> AdminPasswordResetToken lock order as token
        // issuance. This prevents consume-vs-issue deadlocks while still
        // making a concurrently replaced token fail its CAS below.
        const lockedUsers = await tx.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT "id", "status"
          FROM "User"
          WHERE "id" = ${credential.userId}
          FOR UPDATE
        `;
        if (!lockedUsers[0] || lockedUsers[0].status === 'DELETED') {
          throw unauthorized('RESET_TOKEN_INVALID', '重置凭证无效或已过期');
        }
        const consumed = await tx.adminPasswordResetToken.updateMany({
          where: { id: credential.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (consumed.count !== 1) {
          throw unauthorized('RESET_TOKEN_INVALID', '重置凭证无效或已过期');
        }
        const changed = await tx.user.updateMany({
          where: { id: credential.userId, status: { not: 'DELETED' } },
          data: { passwordHash },
        });
        if (changed.count !== 1) {
          throw unauthorized('RESET_TOKEN_INVALID', '重置凭证无效或已过期');
        }
        await tx.userDevice.updateMany({
          where: { userId: credential.userId, revokedAt: null },
          data: { revokedAt: now, refreshTokenHash: null, refreshTokenJti: null },
        });
        await tx.adminPasswordResetToken.updateMany({
          where: { userId: credential.userId, usedAt: null },
          data: { usedAt: now },
        });
        await tx.adminAuditLog.create({
          data: {
            actorUserId: credential.createdById,
            action: 'USER_PASSWORD_RESET_COMPLETED',
            targetType: 'USER',
            targetId: credential.userId,
            requestId: request.id,
            ipAddress: request.ip.slice(0, 200),
            metadata: { completedByTargetUser: true },
          },
        });
        return credential.userId;
      });
      realtimeHub().disconnectSubject(targetUserId);
      reply.header('Cache-Control', 'no-store');
      return { ok: true, data: {} };
    },
  );

  app.get('/v1/admin/me', { preHandler: adminPreHandler }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.auth.subjectId },
      select: {
        id: true,
        email: true,
        displayName: true,
        preferredLanguage: true,
        isSystemAdmin: true,
        adminRole: true,
      },
    });
    return { ok: true, data: user };
  });

  app.get('/v1/admin/overview', { preHandler: adminPreHandler }, async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const [
      totalUsers,
      activeUsers,
      disabledUsers,
      newUsers24h,
      totalConversations,
      waitingConversations,
      activeConversations,
      endedConversations,
      onlineParticipants,
      totalMessages,
      messages24h,
      failedMessages,
      processingMessages,
      pendingAudioDeletionJobs,
    ] = await Promise.all([
      prisma.user.count({ where: { status: { not: 'DELETED' } } }),
      prisma.user.count({ where: { status: 'ACTIVE' } }),
      prisma.user.count({ where: { status: 'DISABLED' } }),
      prisma.user.count({ where: { status: { not: 'DELETED' }, createdAt: { gte: since } } }),
      prisma.conversation.count(),
      prisma.conversation.count({ where: { status: 'WAITING' } }),
      prisma.conversation.count({ where: { status: 'ACTIVE' } }),
      prisma.conversation.count({ where: { status: 'ENDED' } }),
      prisma.participant.count({ where: { presence: 'ONLINE', removedAt: null, leftAt: null } }),
      prisma.translationMessage.count(),
      prisma.translationMessage.count({ where: { createdAt: { gte: since } } }),
      prisma.translationMessage.count({ where: { status: 'FAILED' } }),
      prisma.translationMessage.count({ where: { status: 'PROCESSING' } }),
      prisma.audioDeletionJob.count(),
    ]);
    return {
      ok: true,
      data: {
        generatedAt: new Date(),
        users: { total: totalUsers, active: activeUsers, disabled: disabledUsers, new24h: newUsers24h },
        conversations: {
          total: totalConversations,
          waiting: waitingConversations,
          active: activeConversations,
          ended: endedConversations,
        },
        participants: { online: onlineParticipants },
        messages: {
          total: totalMessages,
          new24h: messages24h,
          failed: failedMessages,
          processing: processingMessages,
        },
        maintenance: { pendingAudioDeletionJobs },
      },
    };
  });

  app.get('/v1/admin/metrics', { preHandler: adminPreHandler }, async (request) => {
    const { days } = z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
    }).parse(request.query);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
    const [byStatus, byProvider, bySourceLanguage, failures, recentFailures, users, conversations] =
      await Promise.all([
        prisma.translationMessage.groupBy({
          by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true },
        }),
        prisma.translationMessage.groupBy({
          by: ['provider'], where: { createdAt: { gte: since } }, _count: { _all: true },
        }),
        prisma.translationMessage.groupBy({
          by: ['sourceLanguage'], where: { createdAt: { gte: since } }, _count: { _all: true },
        }),
        prisma.translationMessage.groupBy({
          by: ['errorCode'],
          where: { createdAt: { gte: since }, status: 'FAILED' },
          _count: { _all: true },
          orderBy: { _count: { errorCode: 'desc' } },
          take: 50,
        }),
        prisma.translationMessage.findMany({
          where: { createdAt: { gte: since }, status: 'FAILED' },
          orderBy: { updatedAt: 'desc' },
          take: 50,
          select: {
            id: true,
            conversationId: true,
            sequence: true,
            provider: true,
            errorCode: true,
            errorMessage: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.user.count({ where: { createdAt: { gte: since }, status: { not: 'DELETED' } } }),
        prisma.conversation.count({ where: { createdAt: { gte: since } } }),
      ]);
    const counted = <T extends Record<string, unknown>>(rows: Array<T & { _count: { _all: number } }>) =>
      rows.map(({ _count, ...row }) => ({ ...row, count: _count._all }));
    return {
      ok: true,
      data: {
        days,
        since,
        newUsers: users,
        newConversations: conversations,
        messages: {
          byStatus: counted(byStatus),
          byProvider: counted(byProvider),
          bySourceLanguage: counted(bySourceLanguage),
        },
        errors: { byCode: counted(failures), recent: recentFailures },
      },
    };
  });

  app.get('/v1/admin/users', { preHandler: adminPreHandler }, async (request) => {
    const query = pageQuerySchema.extend({
      q: z.string().trim().max(200).optional(),
      status: z.enum(['ACTIVE', 'DISABLED', 'DELETED']).optional(),
    }).parse(request.query);
    const where: Prisma.UserWhereInput = {
      ...(query.status ? { status: query.status } : { status: { not: 'DELETED' } }),
      ...(query.q ? {
        OR: [
          { displayName: { contains: query.q, mode: 'insensitive' } },
          { company: { contains: query.q, mode: 'insensitive' } },
          { email: { contains: query.q, mode: 'insensitive' } },
          { phone: { contains: query.q, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          role: true,
          isSystemAdmin: true,
          adminRole: true,
          displayName: true,
          company: true,
          email: true,
          phone: true,
          preferredLanguage: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          devices: {
            orderBy: { lastSeenAt: 'desc' },
            take: 1,
            select: { lastSeenAt: true, platform: true, revokedAt: true },
          },
          _count: {
            select: {
              participants: { where: { presence: 'ONLINE', removedAt: null, leftAt: null } },
              devices: { where: { revokedAt: null } },
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);
    return {
      ok: true,
      data: {
        items: items.map(({ devices, _count, ...user }) => ({
          ...user,
          online: _count.participants > 0,
          activeDeviceCount: _count.devices,
          lastSeenAt: devices[0]?.lastSeenAt ?? null,
          lastPlatform: devices[0]?.platform ?? null,
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  });

  app.get('/v1/admin/users/:id', { preHandler: adminPreHandler }, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const [user, messageStatus, recentOperations] = await Promise.all([prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        role: true,
        isSystemAdmin: true,
        adminRole: true,
        displayName: true,
        company: true,
        email: true,
        phone: true,
        avatarUrl: true,
        preferredLanguage: true,
        status: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
        devices: {
          orderBy: { lastSeenAt: 'desc' },
          select: {
            deviceId: true,
            platform: true,
            authenticatedAt: true,
            lastSeenAt: true,
            revokedAt: true,
          },
        },
        _count: { select: { conversations: true, participants: true, contacts: true, sentFriendRequests: true, receivedFriendRequests: true, glossaryTerms: true } },
      },
    }), prisma.translationMessage.groupBy({
      by: ['status'], where: { participant: { userId: id } }, _count: { _all: true },
    }), prisma.adminAuditLog.findMany({
      where: { targetType: 'USER', targetId: id }, orderBy: { createdAt: 'desc' }, take: 20,
      select: { id: true, action: true, metadata: true, createdAt: true, actor: { select: { displayName: true } } },
    })]);
    if (!user) throw notFound('USER_NOT_FOUND', '用户不存在');
    await prisma.adminAuditLog.create({
      data: { ...auditContext(request), action: 'USER_DETAIL_VIEWED', targetType: 'USER', targetId: id, metadata: {} },
    });
    return { ok: true, data: { ...user, messageStatus: messageStatus.map((item) => ({ status: item.status, count: item._count._all })), recentOperations } };
  });

  app.patch('/v1/admin/users/:id/status', { preHandler: adminPreHandler }, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({
      status: z.enum(['ACTIVE', 'DISABLED']),
      reason: reasonSchema,
    }).parse(request.body);
    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, status: true, isSystemAdmin: true, email: true },
    });
    if (!target) throw notFound('USER_NOT_FOUND', '用户不存在');
    if (target.status === 'DELETED') throw conflict('USER_DELETED', '已注销账号不能恢复');
    if (id === request.auth.subjectId && body.status === 'DISABLED') {
      throw forbidden('CANNOT_DISABLE_SELF', '不能停用当前管理员账号');
    }
    if (isSystemAdminRecord(target) && body.status === 'DISABLED') {
      throw forbidden('SYSTEM_ADMIN_PROTECTED', '请先通过受控运维流程移除系统管理员权限');
    }
    if (target.status === body.status) return { ok: true, data: target };
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({
        where: { id, status: target.status },
        data: { status: body.status },
      });
      if (changed.count !== 1) throw conflict('USER_STATUS_CHANGED', '用户状态已变更，请刷新后重试');
      if (body.status === 'DISABLED') {
        await tx.userDevice.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: now, refreshTokenHash: null, refreshTokenJti: null },
        });
      }
      await auditCreate(tx, request, `USER_${body.status}`, 'USER', id, {
        previousStatus: target.status,
        nextStatus: body.status,
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return tx.user.findUniqueOrThrow({
        where: { id },
        select: { id: true, status: true, isSystemAdmin: true, email: true },
      });
    });
    if (body.status === 'DISABLED') realtimeHub().disconnectSubject(id);
    return { ok: true, data: updated };
  });

  app.post('/v1/admin/users/:id/revoke-sessions', { preHandler: adminPreHandler }, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { reason } = z.object({ reason: reasonSchema }).parse(request.body ?? {});
    const user = await prisma.user.findUnique({ where: { id }, select: { status: true } });
    if (!user) throw notFound('USER_NOT_FOUND', '用户不存在');
    if (user.status === 'DELETED') throw conflict('USER_DELETED', '账号已注销');
    const now = new Date();
    const revokedCount = await prisma.$transaction(async (tx) => {
      const revoked = await tx.userDevice.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: now, refreshTokenHash: null, refreshTokenJti: null },
      });
      await auditCreate(tx, request, 'USER_SESSIONS_REVOKED', 'USER', id, {
        revokedDeviceCount: revoked.count,
        ...(reason ? { reason } : {}),
      });
      return revoked.count;
    });
    realtimeHub().disconnectSubject(id);
    return { ok: true, data: { userId: id, revokedDeviceCount: revokedCount, revokedAt: now } };
  });

  app.post('/v1/admin/users/:id/password-reset', { preHandler: adminPreHandler }, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { reason } = z.object({ reason: reasonSchema }).parse(request.body ?? {});
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, status: true, email: true },
    });
    if (!user) throw notFound('USER_NOT_FOUND', '用户不存在');
    if (user.status === 'DELETED') throw conflict('USER_DELETED', '账号已注销');
    if (!user.email) throw conflict('USER_EMAIL_REQUIRED', '该账号没有可用邮箱');
    const resetToken = randomToken(32);
    const tokenHash = adminPasswordResetTokenHash(resetToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.ADMIN_PASSWORD_RESET_TTL_MINUTES * 60_000);
    await prisma.$transaction(async (tx) => {
      // Serialize issuance per target account. Without this row lock, two
      // concurrent administrators can both invalidate an empty set and then
      // create two simultaneously valid reset capabilities.
      const lockedUsers = await tx.$queryRaw<Array<{
        id: string;
        status: string;
        email: string | null;
      }>>`
        SELECT "id", "status", "email"
        FROM "User"
        WHERE "id" = ${id}
        FOR UPDATE
      `;
      const lockedUser = lockedUsers[0];
      if (!lockedUser) throw notFound('USER_NOT_FOUND', '用户不存在');
      if (lockedUser.status === 'DELETED') {
        throw conflict('USER_DELETED', '账号已注销');
      }
      if (!lockedUser.email) {
        throw conflict('USER_EMAIL_REQUIRED', '该账号没有可用邮箱');
      }
      await tx.adminPasswordResetToken.updateMany({
        where: { userId: id, usedAt: null },
        data: { usedAt: now },
      });
      await tx.adminPasswordResetToken.create({
        data: {
          userId: id,
          createdById: request.auth.subjectId,
          tokenHash,
          expiresAt,
        },
      });
      await auditCreate(tx, request, 'USER_PASSWORD_RESET_ISSUED', 'USER', id, {
        expiresAt: expiresAt.toISOString(),
        ...(reason ? { reason } : {}),
      });
    });
    const resetUrl = `${config.PUBLIC_API_URL.replace(/\/$/, '')}/reset-password#token=${encodeURIComponent(resetToken)}`;
    return {
      ok: true,
      data: {
        userId: id,
        resetToken,
        resetUrl,
        expiresAt,
        warning: '重置凭证只显示这一次，请通过受信渠道发送',
      },
    };
  });

  app.get('/v1/admin/conversations', { preHandler: adminPreHandler }, async (request) => {
    const query = pageQuerySchema.extend({
      q: z.string().trim().max(200).optional(),
      status: z.enum(['WAITING', 'ACTIVE', 'ENDED', 'EXPIRED']).optional(),
    }).parse(request.query);
    const where: Prisma.ConversationWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? {
        OR: [
          { id: { contains: query.q, mode: 'insensitive' } },
          { title: { contains: query.q, mode: 'insensitive' } },
          { owner: { displayName: { contains: query.q, mode: 'insensitive' } } },
          { owner: { email: { contains: query.q, mode: 'insensitive' } } },
          { contact: { displayName: { contains: query.q, mode: 'insensitive' } } },
          { contact: { company: { contains: query.q, mode: 'insensitive' } } },
        ],
      } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          title: true,
          status: true,
          hostLanguage: true,
          guestLanguage: true,
          expiresAt: true,
          startedAt: true,
          endedAt: true,
          createdAt: true,
          owner: { select: { id: true, displayName: true, email: true, company: true } },
          contact: { select: { id: true, displayName: true, company: true } },
          _count: { select: { participants: true, messages: true } },
        },
      }),
      prisma.conversation.count({ where }),
    ]);
    return {
      ok: true,
      data: {
        items: items.map(({ _count, ...conversation }) => ({
          ...conversation,
          participantCount: _count.participants,
          messageCount: _count.messages,
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  });

  app.get('/v1/admin/conversations/:id', { preHandler: adminPreHandler }, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const [conversation, messageStatus, invitations, distributions, recentFailures] = await Promise.all([
      prisma.conversation.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          status: true,
          hostLanguage: true,
          guestLanguage: true,
          guestHistoryPolicy: true,
          guestAccessExpiresAt: true,
          expiresAt: true,
          startedAt: true,
          endedAt: true,
          maxSequence: true,
          createdAt: true,
          updatedAt: true,
          owner: { select: { id: true, displayName: true, email: true, company: true } },
          contact: { select: { id: true, displayName: true, company: true } },
          participants: {
            orderBy: { joinedAt: 'asc' },
            select: {
              id: true,
              role: true,
              userId: true,
              guestIdentityId: true,
              displayName: true,
              company: true,
              preferredLanguage: true,
              presence: true,
              joinedAt: true,
              leftAt: true,
              lastSeenAt: true,
              removedAt: true,
            },
          },
          _count: { select: { messages: true } },
        },
      }),
      prisma.translationMessage.groupBy({
        by: ['status'],
        where: { conversationId: id },
        _count: { _all: true },
      }),
      prisma.meetingInvitation.findMany({
        where: { conversationId: id }, orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, createdAt: true, respondedAt: true, invitee: { select: { id: true, displayName: true, email: true } } },
      }),
      prisma.summaryEmailDistribution.findMany({
        where: { conversationId: id }, orderBy: { createdAt: 'desc' }, take: 20,
        select: { id: true, status: true, recipientCount: true, sentCount: true, failedCount: true, createdAt: true, completedAt: true },
      }),
      prisma.translationMessage.findMany({
        where: { conversationId: id, status: 'FAILED' }, orderBy: { updatedAt: 'desc' }, take: 20,
        select: { id: true, sequence: true, provider: true, errorCode: true, errorMessage: true, updatedAt: true },
      }),
    ]);
    if (!conversation) throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');
    await prisma.adminAuditLog.create({
      data: { ...auditContext(request), action: 'CONVERSATION_DETAIL_VIEWED', targetType: 'CONVERSATION', targetId: id, metadata: {} },
    });
    return {
      ok: true,
      data: {
        ...conversation,
        messageCount: conversation._count.messages,
        messageStatus: messageStatus.map((item) => ({ status: item.status, count: item._count._all })),
        invitations,
        summaryEmailDistributions: distributions,
        recentFailures,
      },
    };
  });

  app.get('/v1/admin/failures', { preHandler: adminPreHandler }, async (request) => {
    const query = pageQuerySchema.extend({
      q: z.string().trim().max(200).optional(),
      provider: z.string().trim().max(100).optional(),
    }).parse(request.query);
    const where: Prisma.TranslationMessageWhereInput = {
      status: 'FAILED',
      ...(query.provider ? { provider: { contains: query.provider, mode: 'insensitive' } } : {}),
      ...(query.q ? {
        OR: [
          { id: { contains: query.q, mode: 'insensitive' } },
          { conversationId: { contains: query.q, mode: 'insensitive' } },
          { provider: { contains: query.q, mode: 'insensitive' } },
          { errorCode: { contains: query.q, mode: 'insensitive' } },
          { errorMessage: { contains: query.q, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.translationMessage.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          conversationId: true,
          sequence: true,
          provider: true,
          errorCode: true,
          errorMessage: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.translationMessage.count({ where }),
    ]);
    return {
      ok: true,
      data: {
        items,
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  });

  app.post('/v1/admin/failures/:id/retry', { preHandler: adminPreHandler }, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(request.body);
    const before = await prisma.translationMessage.findUnique({
      where: { id }, select: { errorCode: true, conversationId: true },
    });
    if (!before) throw notFound('MESSAGE_NOT_FOUND', '消息不存在');
    try {
      const message = await retryFailedMessage(id);
      await prisma.adminAuditLog.create({
        data: {
          ...auditContext(request), action: 'TRANSLATION_FAILURE_RETRIED', targetType: 'MESSAGE', targetId: id,
          metadata: { reason, previousErrorCode: before.errorCode, conversationId: before.conversationId, result: message.status },
        },
      });
      realtimeHub().emitToConversation(message.conversationId, 'translation.final', messageDto(message));
      return { ok: true, data: { id: message.id, status: message.status, errorCode: message.errorCode } };
    } catch (error) {
      await prisma.adminAuditLog.create({
        data: {
          ...auditContext(request), action: 'TRANSLATION_FAILURE_RETRY_FAILED', targetType: 'MESSAGE', targetId: id,
          metadata: { reason, previousErrorCode: before.errorCode, conversationId: before.conversationId },
        },
      });
      throw error;
    }
  });

  app.get('/v1/admin/health', { preHandler: adminPreHandler }, async () => {
    const startedAt = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const databaseLatencyMs = Date.now() - startedAt;
    const now = new Date();
    const [audioPending, audioFailed, emailPending, emailFailed, processingMessages, staleMessages] = await Promise.all([
      prisma.audioDeletionJob.count(),
      prisma.audioDeletionJob.count({ where: { lastError: { not: null } } }),
      prisma.summaryEmailRecipient.count({ where: { status: { in: ['PENDING', 'SENDING'] } } }),
      prisma.summaryEmailRecipient.count({ where: { status: 'FAILED' } }),
      prisma.translationMessage.count({ where: { status: 'PROCESSING' } }),
      prisma.translationMessage.count({ where: { status: 'PROCESSING', updatedAt: { lt: new Date(now.getTime() - 120_000) } } }),
    ]);
    return {
      ok: true,
      data: {
        generatedAt: now,
        service: { status: 'ready', version: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'local' },
        database: { status: 'ready', latencyMs: databaseLatencyMs },
        realtime: { status: realtimeHub().isReady() ? 'ready' : 'degraded' },
        providers: { translation: config.TRANSLATION_PROVIDER, email: config.EMAIL_PROVIDER, storage: config.AUDIO_STORAGE_DRIVER },
        queues: { audioPending, audioFailed, emailPending, emailFailed, processingMessages, staleMessages },
      },
    };
  });

  app.get('/v1/admin/tasks', { preHandler: adminPreHandler }, async (request) => {
    const query = pageQuerySchema.extend({ type: z.enum(['AUDIO_DELETION', 'SUMMARY_EMAIL']).optional() }).parse(request.query);
    const filter = query.type ? Prisma.sql`WHERE "type" = ${query.type}` : Prisma.empty;
    const offset = (query.page - 1) * query.pageSize;
    type TaskRow = { type: string; id: string; status: string; attempts: number; errorCode: string | null; errorMessage: string | null; createdAt: Date; updatedAt: Date };
    const [items, audioCount, emailCount] = await Promise.all([
      prisma.$queryRaw<TaskRow[]>(Prisma.sql`
        SELECT * FROM (
          SELECT 'AUDIO_DELETION'::text AS "type", "id",
            CASE WHEN "lastError" IS NOT NULL THEN 'FAILED' WHEN "lockedAt" IS NOT NULL THEN 'RUNNING' ELSE 'PENDING' END AS "status",
            "attempts", NULL::text AS "errorCode", "lastError" AS "errorMessage", "createdAt", "updatedAt"
          FROM "AudioDeletionJob"
          UNION ALL
          SELECT 'SUMMARY_EMAIL'::text AS "type", "id", "status"::text, "attempts", "errorCode", "errorMessage", "createdAt", "updatedAt"
          FROM "SummaryEmailRecipient"
        ) AS tasks ${filter}
        ORDER BY "updatedAt" DESC, "id" DESC
        LIMIT ${query.pageSize} OFFSET ${offset}
      `),
      query.type === 'SUMMARY_EMAIL' ? 0 : prisma.audioDeletionJob.count(),
      query.type === 'AUDIO_DELETION' ? 0 : prisma.summaryEmailRecipient.count(),
    ]);
    const total = audioCount + emailCount;
    return { ok: true, data: { items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) } };
  });

  app.post('/v1/admin/tasks/:type/:id/retry', { preHandler: adminPreHandler }, async (request) => {
    const { type, id } = z.object({ type: z.enum(['AUDIO_DELETION', 'SUMMARY_EMAIL']), id: z.string().min(1) }).parse(request.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(request.body);
    const now = new Date();
    let changed = 0;
    if (type === 'AUDIO_DELETION') {
      changed = await prisma.$transaction(async (tx) => {
        const result = await tx.audioDeletionJob.updateMany({ where: { id, lockedAt: null, lastError: { not: null } }, data: { nextAttemptAt: now, lastError: null } });
        if (result.count) await auditCreate(tx, request, 'BACKGROUND_TASK_RETRIED', type, id, { reason });
        return result.count;
      });
      if (changed) wakeAudioDeletionWorker();
    } else {
      changed = await prisma.$transaction(async (tx) => {
        const recipient = await tx.summaryEmailRecipient.findUnique({ where: { id }, select: { status: true, errorCode: true, distributionId: true } });
        if (!recipient || recipient.status !== 'FAILED' || recipient.errorCode === 'EMAIL_DELIVERY_UNKNOWN_RETRY_EXPIRED') return 0;
        const result = await tx.summaryEmailRecipient.updateMany({ where: { id, status: 'FAILED', errorCode: recipient.errorCode }, data: { status: 'PENDING', claimedAt: null, errorCode: null, errorMessage: null } });
        if (!result.count) return 0;
        await tx.summaryEmailDistribution.update({ where: { id: recipient.distributionId }, data: { status: 'PROCESSING', completedAt: null } });
        await auditCreate(tx, request, 'BACKGROUND_TASK_RETRIED', type, id, { reason, distributionId: recipient.distributionId });
        return result.count;
      });
      if (changed) wakeSummaryEmailWorker();
    }
    if (!changed) throw conflict('TASK_NOT_RETRYABLE', '任务不存在或当前状态不能重试');
    return { ok: true, data: { type, id, status: 'PENDING', retriedAt: now } };
  });

  app.get('/v1/admin/admins', { preHandler: adminPreHandler }, async () => {
    const items = await prisma.user.findMany({
      where: { isSystemAdmin: true, status: { not: 'DELETED' } }, orderBy: { createdAt: 'asc' },
      select: { id: true, displayName: true, email: true, status: true, adminRole: true, createdAt: true, updatedAt: true },
    });
    return { ok: true, data: { items } };
  });

  app.patch('/v1/admin/admins/:id/role', { preHandler: adminPreHandler }, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { role, reason } = z.object({
      role: z.enum(['SUPER_ADMIN', 'OPERATIONS', 'SUPPORT', 'QUALITY', 'AUDITOR', 'VIEWER']),
      reason: z.string().trim().min(3).max(500),
    }).parse(request.body);
    const target = await prisma.user.findUnique({ where: { id }, select: { isSystemAdmin: true, adminRole: true, status: true } });
    if (!target || !target.isSystemAdmin || target.status === 'DELETED') throw notFound('ADMIN_NOT_FOUND', '管理员不存在');
    if (id === request.auth.subjectId && role !== 'SUPER_ADMIN') throw forbidden('CANNOT_DOWNGRADE_SELF', '不能降低当前超级管理员自己的权限');
    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id }, data: { adminRole: role }, select: { id: true, displayName: true, email: true, adminRole: true } });
      await auditCreate(tx, request, 'ADMIN_ROLE_CHANGED', 'USER', id, { previousRole: target.adminRole ?? 'UNASSIGNED', nextRole: role, reason });
      return user;
    });
    return { ok: true, data: updated };
  });

  app.post('/v1/admin/conversations/:id/end', { preHandler: adminPreHandler }, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { reason } = z.object({ reason: reasonSchema }).parse(request.body ?? {});
    const current = await prisma.conversation.findUnique({
      where: { id },
      select: { id: true, status: true, guestHistoryPolicy: true, endedAt: true },
    });
    if (!current) throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');
    if (current.status === 'EXPIRED') throw conflict('ROOM_EXPIRED', '会议已过期');
    if (current.status === 'ENDED') {
      return { ok: true, data: { conversationId: id, status: current.status, endedAt: current.endedAt } };
    }
    const endedAt = new Date();
    const guestAccessExpiresAt = historyExpiresAt(current.guestHistoryPolicy, endedAt);
    const transitioned = await prisma.$transaction(async (tx) => {
      const transitioned = await tx.conversation.updateMany({
        where: { id, status: { in: ['WAITING', 'ACTIVE'] } },
        data: { status: 'ENDED', endedAt, guestAccessExpiresAt },
      });
      if (transitioned.count !== 1) {
        const state = await tx.conversation.findUnique({ where: { id }, select: { status: true } });
        if (state?.status === 'ENDED') return false;
        throw conflict('CONVERSATION_STATE_CHANGED', '会议状态已变更，请刷新后重试');
      }
      await tx.translationMessage.updateMany({
        where: { conversationId: id, status: 'PROCESSING' },
        data: {
          status: 'FAILED',
          errorCode: 'ROOM_ENDED',
          errorMessage: '会议已由服务器管理员结束',
          updatedAt: endedAt,
        },
      });
      await tx.guestIdentity.updateMany({
        where: { conversationId: id },
        data: {
          expiresAt: current.guestHistoryPolicy === 'PERMANENT'
            ? new Date('9999-12-31T23:59:59.999Z')
            : guestAccessExpiresAt ?? endedAt,
        },
      });
      await tx.participant.updateMany({
        where: { conversationId: id, removedAt: null },
        data: { presence: 'LEFT', leftAt: endedAt, lastSeenAt: endedAt },
      });
      await tx.meetingInvitation.updateMany({
        where: { conversationId: id, status: 'PENDING' },
        data: { status: 'EXPIRED', respondedAt: endedAt },
      });
      await auditCreate(tx, request, 'CONVERSATION_ENDED', 'CONVERSATION', id, {
        previousStatus: current.status,
        ...(reason ? { reason } : {}),
      });
      return true;
    });
    if (transitioned) {
      realtimeHub().emitToConversation(id, 'room.ended', { conversationId: id, endedAt });
    }
    const resolved = transitioned
      ? endedAt
      : (await prisma.conversation.findUnique({
          where: { id },
          select: { endedAt: true },
        }))?.endedAt ?? endedAt;
    return { ok: true, data: { conversationId: id, status: 'ENDED', endedAt: resolved } };
  });

  app.get('/v1/admin/audit-logs', { preHandler: adminPreHandler }, async (request) => {
    const query = pageQuerySchema.extend({
      q: z.string().trim().max(200).optional(),
      action: z.string().trim().max(100).optional(),
      targetType: z.string().trim().max(100).optional(),
      actorUserId: z.string().trim().max(200).optional(),
    }).parse(request.query);
    const where: Prisma.AdminAuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.q ? {
        OR: [
          { action: { contains: query.q, mode: 'insensitive' } },
          { targetType: { contains: query.q, mode: 'insensitive' } },
          { targetId: { contains: query.q, mode: 'insensitive' } },
          { actorUserId: { contains: query.q, mode: 'insensitive' } },
          { actor: { displayName: { contains: query.q, mode: 'insensitive' } } },
          { actor: { email: { contains: query.q, mode: 'insensitive' } } },
        ],
      } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { actor: { select: { id: true, displayName: true, email: true } } },
      }),
      prisma.adminAuditLog.count({ where }),
    ]);
    return {
      ok: true,
      data: {
        items,
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  });
}
