import { randomBytes } from 'node:crypto';
import {
  Prisma,
  type FriendCallMediaType,
  type FriendCallStatus,
} from '@prisma/client';
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
import {
  friendCallHeartbeatExpired,
  friendCallHeartbeatExpiredWhere,
} from '../services/friend-call-liveness.js';
import { subjectCredentialRateLimit } from './social.js';

const activeStatuses: FriendCallStatus[] = ['RINGING', 'ACTIVE'];
const friendCallMediaTypeSchema = z.enum(['AUDIO', 'VIDEO']);
const ringingTimeoutMs = 60_000;
const profileSelect = {
  id: true,
  displayName: true,
  company: true,
  preferredLanguage: true,
  avatarUrl: true,
  avatarPreset: true,
} as const;
const callClosureSelect = {
  id: true,
  callerId: true,
  calleeId: true,
  mediaType: true,
} as const;

interface FriendCallClosure {
  id: string;
  callerId: string;
  calleeId: string;
  mediaType: FriendCallMediaType;
}

export async function registerFriendCallRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/friend-calls', {
    preHandler: authenticate,
    config: { rateLimit: subjectCredentialRateLimit(10) },
  }, async (request) => {
    assertRegistered(request.auth.role);
    const { friendId, mediaType } = z.object({
      friendId: z.string().min(1),
      mediaType: friendCallMediaTypeSchema.default('AUDIO'),
    }).parse(request.body);
    if (friendId === request.auth.subjectId) throw conflict('CANNOT_CALL_SELF', '不能呼叫自己');
    // Fail before changing call state if the service has not been configured.
    const [appId, appKey] = await Promise.all([
      serviceConfiguration('ALIYUN_RTC_APP_ID'),
      serviceConfiguration('ALIYUN_RTC_APP_KEY'),
    ]);
    if (!appId || !appKey) throw conflict('RTC_NOT_CONFIGURED', '实时音视频服务尚未配置');
    const [userAId, userBId] = canonicalPair(request.auth.subjectId, friendId);
    const created = await prisma.$transaction(async (tx) => {
      await lockActiveUsers(tx, [userAId, userBId]);
      const missedCalls = await tx.friendCall.updateManyAndReturn({
        where: {
          status: 'RINGING',
          createdAt: { lt: new Date(Date.now() - ringingTimeoutMs) },
          OR: [
            { callerId: { in: [userAId, userBId] } },
            { calleeId: { in: [userAId, userBId] } },
          ],
        },
        data: { status: 'MISSED', endedAt: new Date() },
        select: callClosureSelect,
      });
      const endedCalls = await tx.friendCall.updateManyAndReturn({
        where: {
          status: 'ACTIVE',
          AND: [
            friendCallHeartbeatExpiredWhere(new Date()),
            {
              OR: [
                { callerId: { in: [userAId, userBId] } },
                { calleeId: { in: [userAId, userBId] } },
              ],
            },
          ],
        },
        data: { status: 'ENDED', endedAt: new Date() },
        select: callClosureSelect,
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
      const call = await tx.friendCall.create({
        data: {
          callerId: request.auth.subjectId,
          calleeId: friendId,
          callerDeviceId: request.auth.deviceId,
          channelId: `fc-${randomBytes(18).toString('hex')}`,
          mediaType,
          livenessVersion: 2,
        },
        include: { caller: { select: profileSelect }, callee: { select: profileSelect } },
      });
      return { call, missedCalls, endedCalls };
    });
    for (const expired of created.missedCalls) notifyCallClosed(expired, 'MISSED');
    for (const expired of created.endedCalls) notifyCallClosed(expired, 'ENDED');
    const { call } = created;
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
    const { action, mediaType } = z.object({
      action: z.enum(['ACCEPT', 'DECLINE']),
      mediaType: friendCallMediaTypeSchema.optional(),
    }).parse(request.body);
    const call = await prisma.friendCall.findFirst({
      where: { id, calleeId: request.auth.subjectId },
      include: { caller: { select: profileSelect }, callee: { select: profileSelect } },
    });
    if (!call) throw notFound('FRIEND_CALL_NOT_FOUND', '通话不存在');
    if (call.status !== 'RINGING') throw conflict('FRIEND_CALL_STATE_CHANGED', '通话状态已经变化');
    const now = new Date();
    const ringingCutoff = new Date(now.getTime() - ringingTimeoutMs);
    if (call.createdAt <= ringingCutoff) {
      const [missed] = await prisma.friendCall.updateManyAndReturn({
        where: {
          id,
          calleeId: request.auth.subjectId,
          status: 'RINGING',
          createdAt: { lte: ringingCutoff },
        },
        data: { status: 'MISSED', endedAt: now },
        select: callClosureSelect,
      });
      if (missed) {
        notifyCallClosed(missed, 'MISSED');
        throw conflict('FRIEND_CALL_MISSED', '来电已超时');
      }
      throw conflict('FRIEND_CALL_STATE_CHANGED', '通话状态已经变化');
    }
    if (action === 'ACCEPT' && call.mediaType === 'AUDIO' && mediaType === 'VIDEO') {
      throw conflict(
        'FRIEND_CALL_MEDIA_UPGRADE_NOT_ALLOWED',
        '语音来电不能升级为视频接听',
      );
    }
    const nextStatus: FriendCallStatus = action === 'ACCEPT' ? 'ACTIVE' : 'DECLINED';
    const acceptedMediaType: FriendCallMediaType = action === 'ACCEPT'
      ? mediaType ?? 'AUDIO'
      : call.mediaType;
    const changed = await prisma.friendCall.updateMany({
      where: {
        id,
        calleeId: request.auth.subjectId,
        status: 'RINGING',
        createdAt: { gt: ringingCutoff },
      },
      data: {
        status: nextStatus,
        ...(action === 'ACCEPT'
          ? {
              acceptedAt: now,
              lastHeartbeatAt: now,
              calleeDeviceId: request.auth.deviceId,
              mediaType: acceptedMediaType,
            }
          : { endedAt: now, endedById: request.auth.subjectId }),
      },
    });
    if (changed.count !== 1) throw conflict('FRIEND_CALL_STATE_CHANGED', '通话状态已经变化');
    const updated = {
      ...call,
      status: nextStatus,
      mediaType: acceptedMediaType,
      acceptedAt: action === 'ACCEPT' ? now : null,
      endedAt: action === 'DECLINE' ? now : null,
      endedById: action === 'DECLINE' ? request.auth.subjectId : null,
    };
    const event = `friend.call.${action === 'ACCEPT' ? 'accepted' : 'declined'}`;
    realtimeHub().emitToSubject(call.callerId, event, {
      call: friendCallDto(updated, call.callerId),
      respondedDeviceId: request.auth.deviceId,
    });
    realtimeHub().emitToSubject(call.calleeId, event, {
      call: friendCallDto(updated, call.calleeId),
      respondedDeviceId: request.auth.deviceId,
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
    const [cancelled] = await prisma.friendCall.updateManyAndReturn({
      where: {
        id,
        status: 'RINGING',
          OR: [
            { callerId: request.auth.subjectId, callerDeviceId: request.auth.deviceId },
            { calleeId: request.auth.subjectId },
          ],
      },
      data: { status: 'CANCELLED', endedAt: now, endedById: request.auth.subjectId },
      select: callClosureSelect,
    });
    let nextStatus: FriendCallStatus = 'CANCELLED';
    let closedCall: FriendCallClosure;
    if (cancelled) {
      closedCall = cancelled;
    } else {
      const [ended] = await prisma.friendCall.updateManyAndReturn({
        where: {
          id,
          status: 'ACTIVE',
          OR: [
            { callerId: request.auth.subjectId, callerDeviceId: request.auth.deviceId },
            { calleeId: request.auth.subjectId, calleeDeviceId: request.auth.deviceId },
          ],
        },
        data: { status: 'ENDED', endedAt: now, endedById: request.auth.subjectId },
        select: callClosureSelect,
      });
      if (!ended) throw conflict('FRIEND_CALL_STATE_CHANGED', '通话已经结束');
      nextStatus = 'ENDED';
      closedCall = ended;
    }
    notifyCallClosed(closedCall, nextStatus);
    return {
      ok: true,
      data: { id, status: nextStatus, mediaType: closedCall.mediaType },
    };
  });

  app.post('/v1/friend-calls/:id/rtc-credential', {
    preHandler: authenticate,
    config: { rateLimit: subjectCredentialRateLimit(20) },
  }, async (request) => {
    assertRegistered(request.auth.role);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { mediaType: expectedMediaType } = z.object({
      mediaType: friendCallMediaTypeSchema.optional(),
    }).default({}).parse(request.body);
    const call = await prisma.friendCall.findFirst({
      where: {
        id,
        status: 'ACTIVE',
        OR: [
          { callerId: request.auth.subjectId, callerDeviceId: request.auth.deviceId },
          { calleeId: request.auth.subjectId, calleeDeviceId: request.auth.deviceId },
        ],
      },
      select: {
        ...callClosureSelect,
        channelId: true,
        callerDeviceId: true,
        calleeDeviceId: true,
        livenessVersion: true,
        acceptedAt: true,
        lastHeartbeatAt: true,
        callerHeartbeatAt: true,
        calleeHeartbeatAt: true,
      },
    });
    if (!call) throw notFound('ACTIVE_FRIEND_CALL_NOT_FOUND', '没有可加入的实时通话');
    if (expectedMediaType && expectedMediaType !== call.mediaType) {
      throw conflict(
        'FRIEND_CALL_MEDIA_TYPE_CHANGED',
        '通话媒体类型已变化，请重新进入通话',
      );
    }
    const now = new Date();
    if (friendCallHeartbeatExpired(call, now)) {
      await expireActiveCallAndNotify(id, now);
      throw notFound('ACTIVE_FRIEND_CALL_NOT_FOUND', '通话已超时结束');
    }
    try {
      const credential = await createAliyunRtcCredential(call.channelId, request.auth.subjectId);
      const refreshed = await prisma.friendCall.updateMany({
        where: {
          id,
          status: 'ACTIVE',
          AND: [
            { NOT: friendCallHeartbeatExpiredWhere(now) },
            {
              OR: [
                { callerId: request.auth.subjectId, callerDeviceId: request.auth.deviceId },
                { calleeId: request.auth.subjectId, calleeDeviceId: request.auth.deviceId },
              ],
            },
          ],
        },
        // Credential issuance proves only REST authorization, not that the
        // native RTC engine joined. Strict v2 side liveness starts at heartbeat.
        data: { lastHeartbeatAt: now },
      });
      if (refreshed.count !== 1) {
        await expireActiveCallAndNotify(id, now);
        throw conflict('FRIEND_CALL_STATE_CHANGED', '通话已经结束');
      }
      let translationAvailable = false;
      try {
        translationAvailable = await realtimeTranslationAvailable();
      } catch (error) {
        request.log.warn(
          {
            callId: id,
            error: error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: 'UnknownError' },
          },
          'Realtime translation availability check failed; RTC remains available',
        );
      }
      request.log.info({
        callId: id,
        subjectId: request.auth.subjectId,
        deviceId: request.auth.deviceId,
        mediaType: call.mediaType,
        expiresAt: credential.expiresAt,
      }, 'Friend call RTC credential issued');
      return {
        ok: true,
        data: {
          credential: {
            ...credential,
            mediaType: call.mediaType,
            realtimeTranslationAvailable: translationAvailable,
          },
        },
      };
    } catch (error) {
      if (error instanceof AliyunRtcNotConfiguredError) {
        throw conflict('RTC_NOT_CONFIGURED', '实时音视频服务尚未配置');
      }
      throw error;
    }
  });

  app.post('/v1/friend-calls/:id/heartbeat', { preHandler: authenticate }, async (request) => {
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
      select: {
        ...callClosureSelect,
        livenessVersion: true,
        acceptedAt: true,
        lastHeartbeatAt: true,
        callerHeartbeatAt: true,
        calleeHeartbeatAt: true,
      },
    });
    if (!call) {
      throw notFound('ACTIVE_FRIEND_CALL_NOT_FOUND', '通话已结束或已在其他设备接听');
    }
    const now = new Date();
    if (friendCallHeartbeatExpired(call, now)) {
      await expireActiveCallAndNotify(id, now);
      throw notFound('ACTIVE_FRIEND_CALL_NOT_FOUND', '对方连接已超时，通话已结束');
    }
    const strictLiveness = call.livenessVersion >= 2;
    const callerIsSource = call.callerId === request.auth.subjectId;
    const refreshed = await prisma.friendCall.updateMany({
      where: {
        id,
        status: 'ACTIVE',
        AND: [
          { NOT: friendCallHeartbeatExpiredWhere(now) },
          {
            OR: [
              { callerId: request.auth.subjectId, callerDeviceId: request.auth.deviceId },
              { calleeId: request.auth.subjectId, calleeDeviceId: request.auth.deviceId },
            ],
          },
        ],
      },
      data: {
        lastHeartbeatAt: now,
        ...(strictLiveness
          ? callerIsSource
            ? { callerHeartbeatAt: now }
            : { calleeHeartbeatAt: now }
          : {}),
      },
    });
    if (refreshed.count !== 1) {
      await expireActiveCallAndNotify(id, now);
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
  mediaType: FriendCallMediaType;
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
    mediaType: call.mediaType,
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
  const expired = await prisma.$transaction(async (tx) => {
    const missedCalls = await tx.friendCall.updateManyAndReturn({
      where: {
        status: 'RINGING',
        createdAt: { lt: new Date(now.getTime() - ringingTimeoutMs) },
        OR: [{ callerId: subjectId }, { calleeId: subjectId }],
      },
      data: { status: 'MISSED', endedAt: now },
      select: callClosureSelect,
    });
    const endedCalls = await tx.friendCall.updateManyAndReturn({
      where: {
        status: 'ACTIVE',
        AND: [
          friendCallHeartbeatExpiredWhere(now),
          { OR: [{ callerId: subjectId }, { calleeId: subjectId }] },
        ],
      },
      data: { status: 'ENDED', endedAt: now },
      select: callClosureSelect,
    });
    return { missedCalls, endedCalls };
  });
  for (const call of expired.missedCalls) notifyCallClosed(call, 'MISSED');
  for (const call of expired.endedCalls) notifyCallClosed(call, 'ENDED');
}

async function expireActiveCallAndNotify(id: string, now: Date): Promise<boolean> {
  const [expired] = await prisma.friendCall.updateManyAndReturn({
    where: {
      id,
      status: 'ACTIVE',
      AND: friendCallHeartbeatExpiredWhere(now),
    },
    data: { status: 'ENDED', endedAt: now },
    select: callClosureSelect,
  });
  if (!expired) return false;
  notifyCallClosed(expired, 'ENDED');
  return true;
}

function notifyCallClosed(call: FriendCallClosure, status: FriendCallStatus): void {
  realtimeHub().stopFriendCallTranslation(call.id);
  const payload = {
    callId: call.id,
    status,
    mediaType: call.mediaType,
  };
  realtimeHub().emitToSubject(call.callerId, 'friend.call.ended', payload);
  if (call.calleeId !== call.callerId) {
    realtimeHub().emitToSubject(call.calleeId, 'friend.call.ended', payload);
  }
}
