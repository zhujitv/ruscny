import type { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdminCapability, type AdminCapability } from '../admin-auth.js';
import { prisma } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { maskEmail } from './summary-email.js';
import { systemSettingDefaults } from '../services/system-settings.js';
import { realtimeHub } from '../realtime-hub.js';
import { messageDto } from '../services/conversations.js';

const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });
const reasonSchema = z.string().trim().min(3).max(500);

function capability(request: FastifyRequest): AdminCapability {
  const route = request.routeOptions.url ?? '';
  if (route.startsWith('/v1/admin/email')) return 'MANAGE_EMAIL';
  if (route.startsWith('/v1/admin/system-glossary')) return 'MANAGE_GLOSSARY';
  if (route.startsWith('/v1/admin/quality')) return 'MANAGE_QUALITY';
  if (route.startsWith('/v1/admin/governance') && request.method === 'GET') return 'READ_GOVERNANCE';
  if (route.startsWith('/v1/admin/governance')) return 'MANAGE_GOVERNANCE';
  return 'MANAGE_SETTINGS';
}

async function preHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAdminCapability(request, reply, capability(request));
  reply.header('Cache-Control', 'private, no-store');
}

function audit(request: FastifyRequest, action: string, targetType: string, targetId: string | null, metadata: Prisma.InputJsonObject = {}) {
  return prisma.adminAuditLog.create({ data: { actorUserId: request.auth.subjectId, action, targetType, targetId, metadata, requestId: request.id, ipAddress: request.ip.slice(0, 200) } });
}

export async function registerAdminBusinessRoutes(app: FastifyInstance) {
  app.get('/v1/admin/email/distributions', { preHandler }, async (request) => {
    const query = pageSchema.extend({ status: z.enum(['PROCESSING', 'COMPLETED', 'PARTIAL_FAILURE', 'FAILED']).optional(), q: z.string().trim().max(200).optional() }).parse(request.query);
    const where: Prisma.SummaryEmailDistributionWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { OR: [{ id: { contains: query.q, mode: 'insensitive' } }, { conversationId: { contains: query.q, mode: 'insensitive' } }] } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.summaryEmailDistribution.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize,
        select: { id: true, conversationId: true, summaryRevision: true, status: true, recipientCount: true, sentCount: true, failedCount: true, createdAt: true, completedAt: true, conversation: { select: { title: true } } },
      }),
      prisma.summaryEmailDistribution.count({ where }),
    ]);
    return { ok: true, data: { items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) } };
  });

  app.get('/v1/admin/email/distributions/:id', { preHandler }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const distribution = await prisma.summaryEmailDistribution.findUnique({ where: { id }, select: {
      id: true, conversationId: true, summaryRevision: true, status: true, recipientCount: true, sentCount: true, failedCount: true, createdAt: true, completedAt: true,
      recipients: { orderBy: { createdAt: 'asc' }, select: { id: true, recipientEmail: true, recipientDisplayName: true, recipientLanguage: true, status: true, attempts: true, errorCode: true, errorMessage: true, sentAt: true, updatedAt: true } },
    } });
    if (!distribution) throw notFound('EMAIL_DISTRIBUTION_NOT_FOUND', '邮件分发不存在');
    await audit(request, 'EMAIL_DISTRIBUTION_VIEWED', 'SUMMARY_EMAIL_DISTRIBUTION', id);
    return { ok: true, data: { ...distribution, recipients: distribution.recipients.map((item) => ({ ...item, recipientEmail: undefined, emailHint: maskEmail(item.recipientEmail) })) } };
  });

  const termBody = z.object({ sourceLanguage: z.enum(['zh', 'ru', 'en']), targetLanguage: z.enum(['zh', 'ru']), sourceTerm: z.string().trim().min(1).max(200), targetTerm: z.string().trim().min(1).max(200), category: z.string().trim().max(100).nullish(), enabled: z.boolean().default(true) });
  app.get('/v1/admin/system-glossary', { preHandler }, async (request) => {
    const query = pageSchema.extend({ q: z.string().trim().max(200).optional(), sourceLanguage: z.enum(['zh', 'ru', 'en']).optional(), targetLanguage: z.enum(['zh', 'ru']).optional(), enabled: z.enum(['true', 'false']).transform((value) => value === 'true').optional() }).parse(request.query);
    const where: Prisma.SystemGlossaryTermWhereInput = { sourceLanguage: query.sourceLanguage, targetLanguage: query.targetLanguage, enabled: query.enabled, ...(query.q ? { OR: [{ sourceTerm: { contains: query.q, mode: 'insensitive' } }, { targetTerm: { contains: query.q, mode: 'insensitive' } }, { category: { contains: query.q, mode: 'insensitive' } }] } : {}) };
    const [items, total] = await Promise.all([prisma.systemGlossaryTerm.findMany({ where, orderBy: [{ sourceLanguage: 'asc' }, { sourceTerm: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }), prisma.systemGlossaryTerm.count({ where })]);
    return { ok: true, data: { items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) } };
  });
  app.post('/v1/admin/system-glossary', { preHandler }, async (request) => {
    const body = termBody.parse(request.body);
    if (body.sourceLanguage === body.targetLanguage) throw conflict('INVALID_LANGUAGE_PAIR', '公共术语的源语言和目标语言不能相同');
    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.systemGlossaryTerm.create({ data: { ...body, category: body.category || null, createdById: request.auth.subjectId, updatedById: request.auth.subjectId } });
      await tx.adminAuditLog.create({ data: { actorUserId: request.auth.subjectId, action: 'SYSTEM_GLOSSARY_CREATED', targetType: 'SYSTEM_GLOSSARY_TERM', targetId: created.id, metadata: { sourceLanguage: created.sourceLanguage, targetLanguage: created.targetLanguage }, requestId: request.id, ipAddress: request.ip.slice(0, 200) } });
      return created;
    });
    return { ok: true, data: item };
  });
  app.patch('/v1/admin/system-glossary/:id', { preHandler }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params); const body = termBody.partial().parse(request.body);
    const item = await prisma.$transaction(async (tx) => {
      const existing = await tx.systemGlossaryTerm.findUnique({ where: { id } }); if (!existing) throw notFound('SYSTEM_GLOSSARY_NOT_FOUND', '公共术语不存在');
      if ((body.sourceLanguage ?? existing.sourceLanguage) === (body.targetLanguage ?? existing.targetLanguage)) throw conflict('INVALID_LANGUAGE_PAIR', '公共术语的源语言和目标语言不能相同');
      const updated = await tx.systemGlossaryTerm.update({ where: { id }, data: { ...body, ...(body.category !== undefined ? { category: body.category || null } : {}), updatedById: request.auth.subjectId } });
      await tx.adminAuditLog.create({ data: { actorUserId: request.auth.subjectId, action: 'SYSTEM_GLOSSARY_UPDATED', targetType: 'SYSTEM_GLOSSARY_TERM', targetId: id, metadata: {}, requestId: request.id, ipAddress: request.ip.slice(0, 200) } });
      return updated;
    });
    return { ok: true, data: item };
  });
  app.delete('/v1/admin/system-glossary/:id', { preHandler }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const changed = await prisma.$transaction(async (tx) => {
      const result = await tx.systemGlossaryTerm.updateMany({ where: { id, enabled: true }, data: { enabled: false, updatedById: request.auth.subjectId } });
      if (result.count) await tx.adminAuditLog.create({ data: { actorUserId: request.auth.subjectId, action: 'SYSTEM_GLOSSARY_DISABLED', targetType: 'SYSTEM_GLOSSARY_TERM', targetId: id, metadata: {}, requestId: request.id, ipAddress: request.ip.slice(0, 200) } });
      return result.count;
    });
    if (!changed) throw notFound('SYSTEM_GLOSSARY_NOT_FOUND', '公共术语不存在或已经停用'); return { ok: true, data: { id, enabled: false } };
  });

  app.get('/v1/admin/quality/corrections', { preHandler }, async (request) => {
    const query = pageSchema.extend({ status: z.enum(['PENDING', 'CONFIRMED', 'REJECTED']).optional(), kind: z.enum(['MANUAL', 'RETRANSLATE']).optional() }).parse(request.query);
    const where = { status: query.status, kind: query.kind };
    const [items, total] = await Promise.all([prisma.messageCorrection.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: { id: true, conversationId: true, messageId: true, revision: true, kind: true, status: true, actorType: true, actorDisplayName: true, reason: true, createdAt: true, decidedAt: true, deciderDisplayName: true } }), prisma.messageCorrection.count({ where })]);
    return { ok: true, data: { items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) } };
  });
  app.get('/v1/admin/quality/corrections/:id', { preHandler }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params); const { reason } = z.object({ reason: reasonSchema }).parse(request.query);
    const item = await prisma.messageCorrection.findUnique({ where: { id }, select: {
      id: true, conversationId: true, messageId: true, revision: true, kind: true, status: true, proposedSourceText: true, proposedTranslatedText: true, reason: true, actorType: true, actorDisplayName: true, createdAt: true, decidedAt: true, decisionReason: true, deciderDisplayName: true,
      message: { select: { sourceText: true, translatedText: true, confirmedSourceText: true, confirmedTranslatedText: true, reviewRevision: true, reviewStatus: true } },
    } });
    if (!item) throw notFound('CORRECTION_NOT_FOUND', '纠错记录不存在'); await audit(request, 'QUALITY_CONTENT_VIEWED', 'MESSAGE_CORRECTION', id, { reason }); return { ok: true, data: item };
  });
  app.patch('/v1/admin/quality/corrections/:id/decision', { preHandler }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params); const body = z.object({ decision: z.enum(['CONFIRMED', 'REJECTED']), reason: reasonSchema }).parse(request.body);
    const result = await prisma.$transaction(async (tx) => {
      const correction = await tx.messageCorrection.findUnique({ where: { id }, include: { message: true } }); if (!correction) throw notFound('CORRECTION_NOT_FOUND', '纠错记录不存在');
      if (correction.status !== 'PENDING' || correction.message.reviewRevision !== correction.revision || correction.message.reviewStatus !== 'PENDING') throw conflict('CORRECTION_STATE_CHANGED', '纠错状态已经变化');
      const decidedAt = new Date();
      const decided = await tx.messageCorrection.updateMany({ where: { id, status: 'PENDING', revision: correction.revision }, data: { status: body.decision, decisionReason: body.reason, decidedAt, decidedBySubjectId: request.auth.subjectId, deciderDisplayName: 'System administrator' } });
      if (decided.count !== 1) throw conflict('CORRECTION_STATE_CHANGED', '纠错状态已经变化');
      const confirmed = body.decision === 'CONFIRMED';
      const message = await tx.translationMessage.updateMany({ where: { id: correction.messageId, reviewRevision: correction.revision, reviewStatus: 'PENDING' }, data: { reviewStatus: body.decision, reviewedAt: decidedAt, pendingSourceText: null, pendingTranslatedText: null, ...(confirmed ? { confirmedSourceText: correction.proposedSourceText, confirmedTranslatedText: correction.proposedTranslatedText } : {}) } });
      if (message.count !== 1) throw conflict('CORRECTION_STATE_CHANGED', '纠错状态已经变化');
      await tx.adminAuditLog.create({ data: { actorUserId: request.auth.subjectId, action: `QUALITY_CORRECTION_${body.decision}`, targetType: 'MESSAGE_CORRECTION', targetId: id, metadata: { reason: body.reason }, requestId: request.id, ipAddress: request.ip.slice(0, 200) } });
      return { id, status: body.decision, messageId: correction.messageId, conversationId: correction.conversationId };
    });
    const message = await prisma.translationMessage.findUnique({ where: { id: result.messageId } });
    if (message) realtimeHub().emitToConversation(result.conversationId, 'translation.review.updated', messageDto(message));
    return { ok: true, data: result };
  });

  app.get('/v1/admin/governance/deletions', { preHandler }, async (request) => {
    const query = pageSchema.extend({ status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'PARTIAL_FAILURE']).optional(), subjectType: z.string().trim().max(50).optional() }).parse(request.query); const where = { status: query.status, subjectType: query.subjectType };
    const [items, total, deletedUsers, pendingAssets] = await Promise.all([prisma.dataDeletionRequest.findMany({ where, orderBy: { requestedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }), prisma.dataDeletionRequest.count({ where }), prisma.user.count({ where: { status: 'DELETED' } }), prisma.audioDeletionJob.count()]);
    return { ok: true, data: { items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize), summary: { deletedUsers, pendingAssets } } };
  });
  app.patch('/v1/admin/governance/deletions/:id', { preHandler }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params); const body = z.object({ status: z.enum(['IN_PROGRESS', 'PARTIAL_FAILURE']), reason: reasonSchema, lastError: z.string().trim().max(1000).nullish() }).superRefine((value, ctx) => { if (value.status === 'PARTIAL_FAILURE' && !value.lastError) ctx.addIssue({ code: 'custom', message: '部分失败必须填写错误原因', path: ['lastError'] }); }).parse(request.body);
    const item = await prisma.$transaction(async (tx) => {
      const current = await tx.dataDeletionRequest.findUnique({ where: { id } });
      if (!current) throw notFound('DATA_DELETION_NOT_FOUND', '删除台账不存在');
      if (current.status === 'COMPLETED') throw conflict('DATA_DELETION_COMPLETED', '已完成的删除台账不能人工回退');
      const changed = await tx.dataDeletionRequest.updateMany({ where: { id, status: current.status, updatedAt: current.updatedAt }, data: { status: body.status, lastError: body.lastError || null, completedAt: null } });
      if (changed.count !== 1) throw conflict('DATA_DELETION_STATE_CHANGED', '删除台账状态已经变化');
      await tx.adminAuditLog.create({ data: { actorUserId: request.auth.subjectId, action: 'DATA_DELETION_STATUS_CHANGED', targetType: 'DATA_DELETION_REQUEST', targetId: id, metadata: { previousStatus: current.status, nextStatus: body.status, reason: body.reason }, requestId: request.id, ipAddress: request.ip.slice(0, 200) } });
      return tx.dataDeletionRequest.findUniqueOrThrow({ where: { id } });
    });
    return { ok: true, data: item };
  });

  app.get('/v1/admin/settings', { preHandler }, async () => {
    const stored = await prisma.systemSetting.findMany(); const map = new Map(stored.map((item) => [item.key, item]));
    return { ok: true, data: { items: Object.entries(systemSettingDefaults).map(([key, defaultValue]) => ({ key, value: map.get(key)?.value ?? defaultValue, version: map.get(key)?.version ?? 0, updatedAt: map.get(key)?.updatedAt ?? null })) } };
  });
  app.patch('/v1/admin/settings/:key', { preHandler }, async (request) => {
    const { key } = z.object({ key: z.enum(['REGISTRATION_ENABLED', 'QUALITY_REVIEW_ENABLED']) }).parse(request.params); const body = z.object({ value: z.boolean(), expectedVersion: z.number().int().min(0), reason: reasonSchema }).parse(request.body);
    const expectedType = typeof systemSettingDefaults[key]; if (typeof body.value !== expectedType) throw conflict('SETTING_TYPE_INVALID', '配置值类型不正确');
    const item = await prisma.$transaction(async (tx) => {
      const current = await tx.systemSetting.findUnique({ where: { key } }); if ((current?.version ?? 0) !== body.expectedVersion) throw conflict('SETTING_VERSION_CHANGED', '配置已被其他管理员修改，请刷新');
      const updated = current ? await tx.systemSetting.update({ where: { key }, data: { value: body.value, version: { increment: 1 }, updatedById: request.auth.subjectId } }) : await tx.systemSetting.create({ data: { key, value: body.value, version: 1, updatedById: request.auth.subjectId } });
      await tx.adminAuditLog.create({ data: { actorUserId: request.auth.subjectId, action: 'SYSTEM_SETTING_CHANGED', targetType: 'SYSTEM_SETTING', targetId: key, metadata: { previousVersion: current?.version ?? 0, nextVersion: updated.version, reason: body.reason }, requestId: request.id, ipAddress: request.ip.slice(0, 200) } }); return updated;
    });
    return { ok: true, data: item };
  });
}
