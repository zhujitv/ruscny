import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    systemSetting: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    systemGlossaryTerm: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    messageCorrection: { findUnique: vi.fn(), updateMany: vi.fn() },
    translationMessage: { updateMany: vi.fn() },
    dataDeletionRequest: { findUnique: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    adminAuditLog: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(),
      adminAuditLog: { create: vi.fn() },
      systemGlossaryTerm: { create: vi.fn(), findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
      systemSetting: { findMany: vi.fn() },
      messageCorrection: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
      translationMessage: { findUnique: vi.fn() },
      summaryEmailDistribution: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
      dataDeletionRequest: { findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
      user: { count: vi.fn() }, audioDeletionJob: { count: vi.fn() },
    },
  };
});

vi.mock('../src/db.js', () => ({ prisma: mocks.prisma }));
vi.mock('../src/admin-auth.js', () => ({
  requireAdminCapability: vi.fn(async (request) => { request.auth = { subjectId: 'admin-a', role: 'USER' }; }),
}));
vi.mock('../src/routes/summary-email.js', () => ({ maskEmail: () => 'm***@example.test' }));

import { registerAdminBusinessRoutes } from '../src/routes/admin-business.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.tx));
  mocks.prisma.adminAuditLog.create.mockResolvedValue({ id: 'audit-a' });
  mocks.tx.adminAuditLog.create.mockResolvedValue({ id: 'audit-a' });
});

describe('phase two administrator operations', () => {
  it('creates only global terminology and records an audit event', async () => {
    mocks.tx.systemGlossaryTerm.create.mockResolvedValue({ id: 'term-a', sourceLanguage: 'zh', targetLanguage: 'ru', sourceTerm: '交期', targetTerm: 'срок поставки', enabled: true });
    const app = Fastify(); await registerAdminBusinessRoutes(app);
    const response = await app.inject({ method: 'POST', url: '/v1/admin/system-glossary', payload: { sourceLanguage: 'zh', targetLanguage: 'ru', sourceTerm: '交期', targetTerm: 'срок поставки' } });
    expect(response.statusCode).toBe(200);
    expect(mocks.tx.systemGlossaryTerm.create).toHaveBeenCalledWith({ data: expect.objectContaining({ createdById: 'admin-a', updatedById: 'admin-a' }) });
    expect(mocks.tx.adminAuditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'SYSTEM_GLOSSARY_CREATED' }) });
    await app.close();
  });

  it('updates a safe setting with optimistic concurrency and audit', async () => {
    mocks.tx.systemSetting.findUnique.mockResolvedValue({ key: 'REGISTRATION_ENABLED', value: true, version: 2 });
    mocks.tx.systemSetting.update.mockResolvedValue({ key: 'REGISTRATION_ENABLED', value: false, version: 3 });
    const app = Fastify(); await registerAdminBusinessRoutes(app);
    const response = await app.inject({ method: 'PATCH', url: '/v1/admin/settings/REGISTRATION_ENABLED', payload: { value: false, expectedVersion: 2, reason: 'maintenance window' } });
    expect(response.statusCode).toBe(200);
    expect(mocks.tx.systemSetting.update).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'REGISTRATION_ENABLED' } }));
    expect(mocks.tx.adminAuditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'SYSTEM_SETTING_CHANGED' }) });
    await app.close();
  });

  it('keeps quality list responses free of message bodies', async () => {
    mocks.prisma.messageCorrection.findMany.mockResolvedValue([{ id: 'correction-a', status: 'PENDING' }]);
    mocks.prisma.messageCorrection.count.mockResolvedValue(1);
    const app = Fastify(); await registerAdminBusinessRoutes(app);
    const response = await app.inject({ method: 'GET', url: '/v1/admin/quality/corrections' });
    expect(response.statusCode).toBe(200);
    expect(mocks.prisma.messageCorrection.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.not.objectContaining({ proposedSourceText: true, proposedTranslatedText: true }) }));
    await app.close();
  });

  it('decides a correction with CAS guards for both rows', async () => {
    mocks.tx.messageCorrection.findUnique.mockResolvedValue({
      id: 'correction-a', status: 'PENDING', revision: 2, messageId: 'message-a', conversationId: 'conversation-a', proposedSourceText: '新原文', proposedTranslatedText: 'Новый перевод',
      message: { id: 'message-a', reviewRevision: 2, reviewStatus: 'PENDING' },
    });
    mocks.tx.messageCorrection.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.translationMessage.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.translationMessage.findUnique.mockResolvedValue(null);
    const app = Fastify(); await registerAdminBusinessRoutes(app);
    const response = await app.inject({ method: 'PATCH', url: '/v1/admin/quality/corrections/correction-a/decision', payload: { decision: 'CONFIRMED', reason: 'reviewed by quality team' } });
    expect(response.statusCode).toBe(200);
    expect(mocks.tx.messageCorrection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'correction-a', status: 'PENDING', revision: 2 } }));
    expect(mocks.tx.translationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'message-a', reviewRevision: 2, reviewStatus: 'PENDING' } }));
    await app.close();
  });
});
