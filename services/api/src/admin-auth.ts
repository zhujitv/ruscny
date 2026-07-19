import type { FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from './auth.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { forbidden } from './errors.js';

export type AdminCapability =
  | 'READ_OPERATIONS'
  | 'MANAGE_USERS'
  | 'MANAGE_MEETINGS'
  | 'RETRY_FAILURES'
  | 'RETRY_TASKS'
  | 'READ_AUDIT'
  | 'MANAGE_ADMIN_ROLES'
  | 'MANAGE_EMAIL'
  | 'MANAGE_GLOSSARY'
  | 'MANAGE_QUALITY'
  | 'READ_GOVERNANCE'
  | 'MANAGE_GOVERNANCE'
  | 'MANAGE_SETTINGS';

const roleCapabilities: Record<string, ReadonlySet<AdminCapability>> = {
  SUPER_ADMIN: new Set(['READ_OPERATIONS', 'MANAGE_USERS', 'MANAGE_MEETINGS', 'RETRY_FAILURES', 'RETRY_TASKS', 'READ_AUDIT', 'MANAGE_ADMIN_ROLES', 'MANAGE_EMAIL', 'MANAGE_GLOSSARY', 'MANAGE_QUALITY', 'READ_GOVERNANCE', 'MANAGE_GOVERNANCE', 'MANAGE_SETTINGS']),
  OPERATIONS: new Set(['READ_OPERATIONS', 'MANAGE_USERS', 'MANAGE_MEETINGS', 'RETRY_FAILURES', 'RETRY_TASKS', 'READ_AUDIT', 'MANAGE_EMAIL', 'MANAGE_GLOSSARY', 'MANAGE_QUALITY', 'READ_GOVERNANCE', 'MANAGE_GOVERNANCE']),
  SUPPORT: new Set(['READ_OPERATIONS', 'MANAGE_USERS', 'MANAGE_MEETINGS', 'MANAGE_EMAIL']),
  QUALITY: new Set(['READ_OPERATIONS', 'RETRY_FAILURES', 'MANAGE_GLOSSARY', 'MANAGE_QUALITY']),
  AUDITOR: new Set(['READ_OPERATIONS', 'READ_AUDIT', 'READ_GOVERNANCE']),
  VIEWER: new Set(['READ_OPERATIONS']),
};

export function configuredSystemAdminUserIds(value = config.SYSTEM_ADMIN_USER_IDS): Set<string> {
  return new Set(
    value
      .split(',')
      .map((userId) => userId.trim())
      .filter(Boolean),
  );
}

export function isSystemAdminRecord(
  user: {
    id: string;
    status: string;
    isSystemAdmin: boolean;
  },
  configuredUserIds = configuredSystemAdminUserIds(),
): boolean {
  return user.status === 'ACTIVE' && (
    user.isSystemAdmin || configuredUserIds.has(user.id)
  );
}

/**
 * System administration is deliberately re-read from PostgreSQL on every
 * request. Product role claims in the access token and any browser value are
 * never treated as administrator authority.
 */
export async function requireSystemAdmin(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  await authenticate(request);
  if (request.auth.role === 'GUEST') {
    throw forbidden('SYSTEM_ADMIN_REQUIRED', '需要服务器管理员权限');
  }
  const user = await prisma.user.findUnique({
    where: { id: request.auth.subjectId },
    select: {
      id: true,
      status: true,
      isSystemAdmin: true,
    },
  });
  if (!user || !isSystemAdminRecord(user)) {
    throw forbidden('SYSTEM_ADMIN_REQUIRED', '需要服务器管理员权限');
  }
}

export async function requireAdminCapability(
  request: FastifyRequest,
  _reply: FastifyReply,
  capability: AdminCapability,
): Promise<void> {
  await authenticate(request);
  if (request.auth.role === 'GUEST') {
    throw forbidden('SYSTEM_ADMIN_REQUIRED', '需要服务器管理员权限');
  }
  const user = await prisma.user.findUnique({
    where: { id: request.auth.subjectId },
    select: { id: true, status: true, isSystemAdmin: true, adminRole: true },
  });
  if (!user || !isSystemAdminRecord(user)) {
    throw forbidden('SYSTEM_ADMIN_REQUIRED', '需要服务器管理员权限');
  }
  const bootstrapAdmin = configuredSystemAdminUserIds().has(user.id);
  // Only the immutable bootstrap allowlist may recover as SUPER_ADMIN.
  // A durable database administrator without an assigned role fails closed.
  const role = bootstrapAdmin ? 'SUPER_ADMIN' : user.adminRole;
  if (!role) {
    throw forbidden('ADMIN_ROLE_REQUIRED', '管理员职责尚未配置');
  }
  if (!roleCapabilities[role]?.has(capability)) {
    throw forbidden('ADMIN_PERMISSION_REQUIRED', '当前管理员职责不允许执行该操作');
  }
}
