import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transaction = {
    $queryRaw: vi.fn(),
    user: { updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    userDevice: { updateMany: vi.fn() },
    adminAuditLog: { create: vi.fn() },
    adminPasswordResetToken: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    userPasswordResetToken: { updateMany: vi.fn() },
    conversation: { updateMany: vi.fn(), findUnique: vi.fn() },
    translationMessage: { updateMany: vi.fn() },
    guestIdentity: { updateMany: vi.fn() },
    participant: { updateMany: vi.fn() },
    meetingInvitation: { updateMany: vi.fn() },
  };
  return {
    transaction,
    prisma: {
      $transaction: vi.fn(),
      user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), findMany: vi.fn() },
      conversation: { findUnique: vi.fn(), count: vi.fn(), findMany: vi.fn() },
      participant: { count: vi.fn() },
      translationMessage: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
      audioDeletionJob: { count: vi.fn() },
      adminAuditLog: { findMany: vi.fn(), count: vi.fn() },
    },
    disconnectSubject: vi.fn(),
    emitToConversation: vi.fn(),
  };
});

vi.mock('../src/admin-auth.js', () => ({
  isSystemAdminRecord: (user: { status: string; isSystemAdmin: boolean }) =>
    user.status === 'ACTIVE' && user.isSystemAdmin,
  requireSystemAdmin: vi.fn(async (request) => {
    request.auth = {
      subjectId: 'admin-a',
      role: 'USER',
      deviceId: 'admin-device',
      sessionId: 'admin-session',
    };
  }),
  requireAdminCapability: vi.fn(async (request) => {
    request.auth = {
      subjectId: 'admin-a', role: 'USER', deviceId: 'admin-device', sessionId: 'admin-session',
    };
  }),
}));
vi.mock('../src/db.js', () => ({ prisma: mocks.prisma }));
vi.mock('../src/realtime-hub.js', () => ({
  realtimeHub: () => ({
    disconnectSubject: mocks.disconnectSubject,
    emitToConversation: mocks.emitToConversation,
  }),
}));

import { registerAdminRoutes } from '../src/routes/admin.js';

let app: FastifyInstance | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.transaction));
  mocks.transaction.adminAuditLog.create.mockResolvedValue({ id: 'audit-a' });
  mocks.transaction.$queryRaw.mockResolvedValue([{
    id: 'user-a', status: 'ACTIVE', email: 'user@example.com',
  }]);
  mocks.transaction.adminPasswordResetToken.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.adminPasswordResetToken.create.mockResolvedValue({ id: 'reset-a' });
  mocks.transaction.userPasswordResetToken.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.userDevice.updateMany.mockResolvedValue({ count: 2 });
  mocks.transaction.translationMessage.updateMany.mockResolvedValue({ count: 0 });
  mocks.transaction.guestIdentity.updateMany.mockResolvedValue({ count: 0 });
  mocks.transaction.participant.updateMany.mockResolvedValue({ count: 2 });
  mocks.transaction.meetingInvitation.updateMany.mockResolvedValue({ count: 0 });
  app = Fastify({ logger: false });
  await registerAdminRoutes(app);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('server administrator writes', () => {
  it('returns a reset capability once while persisting only its keyed digest', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      id: 'user-a', status: 'ACTIVE', email: 'user@example.com',
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/admin/users/user-a/password-reset',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.resetToken).toHaveLength(43);
    expect(data.resetUrl).toContain('/reset-password#token=');
    expect(mocks.transaction.$queryRaw).toHaveBeenCalledTimes(1);
    const create = mocks.transaction.adminPasswordResetToken.create.mock.calls[0][0].data;
    expect(create.tokenHash).not.toContain(data.resetToken);
    expect(create.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.transaction.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'admin-a',
        action: 'USER_PASSWORD_RESET_ISSUED',
        targetId: 'user-a',
      }),
    });
  });

  it('atomically disables an account, revokes every device, audits, and disconnects it', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      id: 'user-a', status: 'ACTIVE', isSystemAdmin: false, email: 'user@example.com',
    });
    mocks.transaction.user.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-a', status: 'DISABLED', isSystemAdmin: false, email: 'user@example.com',
    });

    const response = await app!.inject({
      method: 'PATCH',
      url: '/v1/admin/users/user-a/status',
      payload: { status: 'DISABLED', reason: 'security review' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.transaction.userDevice.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-a', revokedAt: null },
      data: { revokedAt: expect.any(Date), refreshTokenHash: null, refreshTokenJti: null },
    });
    expect(mocks.transaction.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'USER_DISABLED',
        metadata: expect.objectContaining({ reason: 'security review' }),
      }),
    });
    expect(mocks.disconnectSubject).toHaveBeenCalledWith('user-a');
  });

  it('consumes a password-reset capability once and revokes existing sessions', async () => {
    mocks.transaction.adminPasswordResetToken.findUnique.mockResolvedValue({
      id: 'reset-a',
      userId: 'user-a',
      createdById: 'admin-a',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      targetUser: { status: 'ACTIVE' },
    });
    mocks.transaction.user.updateMany.mockResolvedValue({ count: 1 });

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/auth/password/reset',
      payload: { token: 'x'.repeat(43), newPassword: 'new-password-123' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-a', status: { not: 'DELETED' } },
      data: { passwordHash: expect.stringMatching(/^v2:\$2/) },
    });
    expect(mocks.transaction.userDevice.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-a', revokedAt: null },
      data: { revokedAt: expect.any(Date), refreshTokenHash: null, refreshTokenJti: null },
    });
    expect(mocks.transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(mocks.transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transaction.adminPasswordResetToken.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(mocks.disconnectSubject).toHaveBeenCalledWith('user-a');
  });

  it('ends an active meeting with terminal participant/message state and an audit row', async () => {
    mocks.prisma.conversation.findUnique.mockResolvedValue({
      id: 'conversation-a', status: 'ACTIVE', guestHistoryPolicy: 'ACCESS_FOR_24_HOURS', endedAt: null,
    });
    mocks.transaction.conversation.updateMany.mockResolvedValue({ count: 1 });

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/admin/conversations/conversation-a/end',
      payload: { reason: 'operator requested' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.transaction.participant.updateMany).toHaveBeenCalledWith({
      where: { conversationId: 'conversation-a', removedAt: null },
      data: { presence: 'LEFT', leftAt: expect.any(Date), lastSeenAt: expect.any(Date) },
    });
    expect(mocks.transaction.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'CONVERSATION_ENDED',
        targetId: 'conversation-a',
      }),
    });
    expect(mocks.emitToConversation).toHaveBeenCalledWith(
      'conversation-a',
      'room.ended',
      expect.objectContaining({ conversationId: 'conversation-a' }),
    );
  });
});

describe('server administrator operations queries', () => {
  it('paginates failed translations without exposing message content', async () => {
    mocks.prisma.translationMessage.findMany.mockResolvedValue([{
      id: 'message-a', conversationId: 'conversation-a', sequence: 7,
      provider: 'aliyun', errorCode: 'MT_TIMEOUT', errorMessage: 'provider timeout',
      createdAt: new Date('2026-07-19T08:00:00Z'), updatedAt: new Date('2026-07-19T08:01:00Z'),
    }]);
    mocks.prisma.translationMessage.count.mockResolvedValue(1);

    const response = await app!.inject({
      method: 'GET',
      url: '/v1/admin/failures?q=timeout&provider=ali&page=1&pageSize=10',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ total: 1, totalPages: 1 });
    expect(mocks.prisma.translationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'FAILED' }),
      take: 10,
      select: expect.not.objectContaining({ sourceText: true, translatedText: true }),
    }));
  });

  it('filters the audit trail by free text and target type', async () => {
    mocks.prisma.adminAuditLog.findMany.mockResolvedValue([]);
    mocks.prisma.adminAuditLog.count.mockResolvedValue(0);

    const response = await app!.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs?q=marc&targetType=USER',
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.prisma.adminAuditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ targetType: 'USER', OR: expect.any(Array) }),
    }));
  });
});
