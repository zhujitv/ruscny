import { randomBytes } from 'node:crypto';
import { Prisma, type FriendCallStatus } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { prisma } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { realtimeHub } from '../realtime-hub.js';
import {
  AliyunRtcNotConfiguredError,
  createAliyunRtcCredential,
} from '../services/aliyun-rtc.js';
import { serviceConfiguration } from '../services/service-configuration.js';
import { realtimeTranslationAvailable } from '../services/aliyun-realtime-translation.js';
import { subjectCredentialRateLimit } from './social.js';

const activeStatuses: FriendCallStatus[] = ['RINGING', 'ACTIVE'];
const ringingTimeoutMs = 60_000;
const activeHeartbeatTimeoutMs = 90_000;
const profileSelect = {
  id: true,
  displayName: true,
  company: true,
  preferredLanguage: true,
  avatarUrl: true,
  avatarPreset: true,
} as const;

export async function registerFriendCallRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/friend-calls', {
    preHandler: authenticate,
    config: { rateLimit: subjectCredentialRateLimit(10) },
  }, async (request) => {
    assertRegistered(request.auth.role);
    const { friendId } = z.object({ friendId: z.string().min(1) }).parse(request.body);
    if (friendId === request.auth.subjectId) throw conflict('CANNOT_CALL_SELF', '不能呼叫自己');
    // Fail before changing call state if the service has not been configured.
    const [appId, appKey] = await Promise.all([
      serviceConfiguration('ALIYUN_RTC_APP_ID'),
      serviceConfiguration('ALIYUN_RTC_APP_KEY'),
    ]);
    if (!appId || !appKey) throw conflict('RTC_NOT_CONFIGURED', '实时语音服务尚未配置');
    const [userAId, userBId] = canonicalPair(request.auth.subjectId, friendId);
    const call = await prisma.$transaction(async (tx) => {
      await lockActiveUsers(tx, [userAId, userBId]);
      await tx.friendCall.updateMany({
        where: {
          status: 'RINGING',
          createdAt: { lt: new Date(Date.now() - ringingTimeoutMs) },
          OR: [
            { callerId: { in: [userAId, userBId] } },
            { calleeId: { in: [userAId, userBId] } },
          ],
        },
        data: { status: 'MISSED', endedAt: new Date() },
      });
      await tx.friendCall.updateMany({
        where: {
          status: 'ACTIVE',
          OR: [
            { lastHeartbeatAt: null },
            { lastHeartbeatAt: { lt: new Date(Date.now() - activeHeartbeatTimeoutMs) } },
          ],
          AND: {
            OR: [
              { callerId: { in: [userAId, userBId] } },
              { calleeId: { in: [userAId, userBId] } },
            ],
          },
        },
        data: { status: 'ENDED', endedAt: new Date() },
      });
      const friendship = await tx.friendship.findUnique({
        where: { userAId_userBId: { userAId, userBId } },
      });
      if (!friendship) throw forbidden('FRIEND_REQUIRED', '只能呼叫好友');
      const existing = await tx.friendCall.findFirst({
        where: {
          status: { in: activeStatuses },
          OR: [
            { callerId: { in: [userAId, userBId] } },
            { calleeId: { in: [userAId, userBId] } },
          ],
        },
      });
      if (existing) throw conflict('USER_ALREADY_IN_CALL', '你或对方正在通话中');
      return tx.friendCall.create({
        data: {
          callerId: request.auth.subjectId,
          calleeId: friendId,
          callerDeviceId: request.auth.deviceId,
          channelId: `fc_${randomBytes(18).toString('base64url')}`,
        },
        include: { caller: { select: profileSelect }, callee: { select: profileSelect } },
      });
    });
    const dto = friendCallDto(call, request.auth.subjectId);
    realtimeHub().emitToSubject(friendId, 'friend.call.incoming', {
      call: friendCallDto(call, friendId),
    });
    return { ok: true, data: { call: dto } };
  });

  app.get('/v1/friend-calls/active', { preHandler: authenticate }, async (request) => {
    assertRegistered(request.auth.role);
    await expireStaleCallsForSubject(request.auth.subjectId);
    const call = await prisma.friendCall.findFirst({
      where: {
        status: { in: activeStatuses },
        OR: [
          { callerId: request.auth.subjectId, callerDeviceId: request.auth.deviceId },
          {
            calleeId: request.auth.subjectId,
            OR: [
              { status: 'RINGING' },
              { calleeDeviceId: request.auth.deviceId },
            ],
          },
        ],
      },
      include: { caller: { select: profileSelect }, callee: { select: profileSelect } },
      orderBy: { createdAt: 'desc' },
    });
    return { ok: true, data: { call: call ? friendCallDto(call, request.auth.subjectId) : null } };
  });

  app.get('/v1/friend-calls', { preHandler: authenticate }, async (request) => {
    assertRegistered(request.auth.role);
    const calls = await prisma.friendCall.findMany({
      where: { OR: [{ callerId: request.auth.subjectId }, { calleeId: request.auth.subjectId }] },
      include: { caller: { select: profileSelect }, callee: { select: profileSelect } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { ok: true, data: { items: calls.map((call) => friendCallDto(call, request.auth.subjectId)) } };
  });

  app.post('/v1/friend-calls/:id/respond', { preHandler: authenticate }, async (request) => {
    assertRegistered(request.auth.role);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { action } = z.object({ action: z.enum(['ACCEPT', 'DECLINE']) }).parse(request.body);
    const call = await prisma.friendCall.findFirst({
      where: { id, calleeId: request.auth.subjectId },
      include: { caller: { select: profileSelect }, callee: { select: profileSelect } },
    });
    if (!call) throw notFound('FRIEND_CALL_NOT_FOUND', '通话不存在');
    if (call.status !== 'RINGING') throw conflict('FRIEND_CALL_STATE_CHANGED', '通话状态已经变化');
    const nextStatus: FriendCallStatus = action === 'ACCEPT' ? 'ACTIVE' : 'DECLINED';
    const now = new Date();
    const changed = await prisma.friendCall.updateMany({
      where: { id, calleeId: request.auth.subjectId, status: 'RINGING' },
      data: {
        status: nextStatus,
        ...(action === 'ACCEPT'
          ? {
              acceptedAt: now,
              lastHeartbeatAt: now,
              calleeDeviceId: request.auth.deviceId,
            }
          : { endedAt: now, endedById: request.auth.subjectId }),
      },
    });
    if (changed.count !== 1) throw conflict('FRIEND_CALL_STATE_CHANGED', '通话状态已经变化');
    const updated = { ...call, status: nextStatus, acceptedAt: action === 'ACCEPT' ? now : null, endedAt: action === 'DECLINE' ? now : null, endedById: action === 'DECLINE' ? request.auth.subjectId : null };
    realtimeHub().emitToSubject(call.callerId, `friend.call.${action === 'ACCEPT' ? 'accepted' : 'declined'}`, {
      call: friendCallDto(updated, call.callerId),
    });
    return { ok: true, data: { call: friendCallDto(updated, request.auth.subjectId) } };
  });

  app.post('/v1/friend-calls/:id/end', { preHandler: authenticate }, async (request) => {
    assertRegistered(request.auth.role);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const call = await prisma.friendCall.findFirst({
      where: {
        id,
        OR: [{ callerId: request.auth.subjectId }, { calleeId: request.auth.subjectId }],
      },
      include: { caller: { select: profileSelect }, callee: { select: profileSelect } },
    });
    if (!call) throw notFound('FRIEND_CALL_NOT_FOUND', '通话不存在');
    const now = new Date();
    const cancelled = await prisma.friendCall.updateMany({
      where: {
        id,
        status: 'RINGING',
        OR: [
          { callerId: request.auth.subjectId, callerDeviceId: request.auth.deviceId },
          { calleeId: request.auth.subjectId },
        ],
      },
      data: { status: 'CANCELLED', endedAt: now, endedById: request.auth.subjectId },
    });
    let nextStatus: FriendCallStatus = 'CANCELLED';
    if (cancelled.count !== 1) {
      const ended = await prisma.friendCall.updateMany({
        where: {
          id,
          status: 'ACTIVE',
          OR: [
            { callerId: request.auth.subjectId, callerDeviceId: request.auth.deviceId },
            { calleeId: request.auth.subjectId, calleeDeviceId: request.auth.deviceId },
          ],
        },
        data: { status: 'ENDED', endedAt: now, endedById: request.auth.subjectId },
      });
      if (ended.count !== 1) throw conflict('FRIEND_CALL_STATE_CHANGED', '通话已经结束');
      nextStatus = 'ENDED';
    }
    const otherId = call.callerId === request.auth.subjectId ? call.calleeId : call.callerId;
    realtimeHub().stopFriendCallTranslation(id);
    realtimeHub().emitToSubject(otherId, 'friend.call.ended', { callId: id, status: nextStatus });
    return { ok: true, data: { id, status: nextStatus } };
  });

  app.post('/v1/friend-calls/:id/rtc-credential', {
    preHandler: authenticate,
    config: { rateLimit: subjectCredentialRateLimit(20) },
  }, async (request) => {
    assertRegistered(request.auth.role);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const call = await prisma.friendCall.findFirst({
      where: {
        id,
        status: 'ACTIVE',
        OR: [
          { callerId: request.auth.subjectId, callerDeviceId: request.auth.deviceId },
          { calleeId: request.auth.subjectId, calleeDeviceId: request.auth.deviceId },
        ],
      },
      select: { channelId: true },
    });
    if (!call) throw notFound('ACTIVE_FRIEND_CALL_NOT_FOUND', '没有可加入的语音通话');
    try {
      const credential = await createAliyunRtcCredential(call.channelId, request.auth.subjectId);
      const refreshed = await prisma.friendCall.updateMany({
        where: {
          id,
          status: 'ACTIVE',
          OR: [
            { callerId: request.auth.subjectId, callerDeviceId: request.auth.deviceId },
            { calleeId: request.auth.subjectId, calleeDeviceId: request.auth.deviceId },
          ],
        },
        data: { lastHeartbeatAt: new Date() },
      });
      if (refreshed.count !== 1) {
        throw conflict('FRIEND_CALL_STATE_CHANGED', '通话已经结束');
      }
      return {
        ok: true,
        data: {
          credential: {
            ...credential,
            realtimeTranslationAvailable: await realtimeTranslationAvailable(),
          },
        },
      };
    } catch (error) {
      if (error instanceof AliyunRtcNotConfiguredError) {
        throw conflict('RTC_NOT_CONFIGURED', '实时语音服务尚未配置');
      }
      throw error;
    }
  });

  app.post('/v1/friend-calls/:id/heartbeat', { preHandler: authenticate }, async (request) => {
    assertRegistered(request.auth.role);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const refreshed = await prisma.friendCall.updateMany({
      where: {
        id,
        status: 'ACTIVE',
        OR: [
          { callerId: request.auth.subjectId, callerDeviceId: request.auth.deviceId },
          { calleeId: request.auth.subjectId, calleeDeviceId: request.auth.deviceId },
        ],
      },
      data: { lastHeartbeatAt: new Date() },
    });
    if (refreshed.count !== 1) {
      throw notFound('ACTIVE_FRIEND_CALL_NOT_FOUND', '通话已经结束或已在其他设备接听');
    }
    return { ok: true, data: { id } };
  });
}

function friendCallDto(call: {
  id: string;
  callerId: string;
  calleeId: string;
  status: FriendCallStatus;
  acceptedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  caller: unknown;
  callee: unknown;
}, subjectId: string) {
  return {
    id: call.id,
    direction: call.callerId === subjectId ? 'OUTGOING' : 'INCOMING',
    status: call.status,
    peer: call.callerId === subjectId ? call.callee : call.caller,
    createdAt: call.createdAt,
    acceptedAt: call.acceptedAt,
    endedAt: call.endedAt,
    updatedAt: call.updatedAt,
  };
}

function canonicalPair(left: string, right: string): [string, string] {
  return left < right ? [left, right] : [right, left];
}

function assertRegistered(role: string): void {
  if (role === 'GUEST') throw forbidden('FORMAL_ACCOUNT_REQUIRED', '临时用户不能使用好友通话');
}

async function lockActiveUsers(tx: Prisma.TransactionClient, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)].sort();
  const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status" FROM "User"
    WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id" FOR UPDATE
  `;
  if (rows.length !== ids.length || rows.some((row) => row.status !== 'ACTIVE')) {
    throw notFound('USER_NOT_FOUND', '用户不存在');
  }
}

async function expireStaleCallsForSubject(subjectId: string): Promise<void> {
  const now = new Date();
  await prisma.$transaction([
    prisma.friendCall.updateMany({
      where: {
        status: 'RINGING',
        createdAt: { lt: new Date(now.getTime() - ringingTimeoutMs) },
        OR: [{ callerId: subjectId }, { calleeId: subjectId }],
      },
      data: { status: 'MISSED', endedAt: now },
    }),
    prisma.friendCall.updateMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { lastHeartbeatAt: null },
          { lastHeartbeatAt: { lt: new Date(now.getTime() - activeHeartbeatTimeoutMs) } },
        ],
        AND: { OR: [{ callerId: subjectId }, { calleeId: subjectId }] },
      },
      data: { status: 'ENDED', endedAt: now },
    }),
  ]);
}
