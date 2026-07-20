import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { prisma } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { randomRoomCode, randomToken, stableHash } from '../lib/crypto.js';
import { realtimeHub } from '../realtime-hub.js';
import {
  conversationDto,
  conversationInclude,
  participantDto,
} from '../services/conversations.js';

const participantProfileSchema = z.object({
  displayName: profileTextSchema(100),
  company: profileTextSchema(200),
  preferredLanguage: z.enum(['zh', 'ru']),
});

function profileTextSchema(maxLength: number) {
  return z.string().trim().min(1).max(maxLength).refine(
    (value) => !/[\u0000-\u001F\u007F]/u.test(value),
    '不能包含换行或控制字符',
  );
}

export async function registerSocialRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/users/search', {
    preHandler: authenticate,
    config: { rateLimit: subjectCredentialRateLimit(30) },
  }, async (request) => {
    assertRegistered(request.auth.role);
    const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(request.query);
    const normalizedQuery = q.toLowerCase();
    const exactEmailQuery = normalizedQuery.includes('@');
    const users = await prisma.user.findMany({
      where: {
        id: { not: request.auth.subjectId },
        status: 'ACTIVE',
        OR: [
          { displayName: { contains: q, mode: 'insensitive' } },
          { company: { contains: q, mode: 'insensitive' } },
          ...(exactEmailQuery ? [{ email: { equals: normalizedQuery, mode: 'insensitive' as const } }] : []),
        ],
      },
      select: {
        id: true,
        displayName: true,
        email: true,
        company: true,
        preferredLanguage: true,
      },
      take: 30,
    });
    const states = await relationshipStates(
      request.auth.subjectId,
      users.map((user) => user.id),
    );
    return {
      ok: true,
      data: {
        items: users.map((user) => ({
          ...user,
          email: maskEmail(user.email),
          relationship: states.get(user.id) ?? 'NONE',
        })),
      },
    };
  });

  app.post('/v1/friend-requests', {
    preHandler: authenticate,
    config: { rateLimit: subjectCredentialRateLimit(10) },
  }, async (request) => {
    assertRegistered(request.auth.role);
    const { receiverId } = z.object({ receiverId: z.string() }).parse(request.body);
    if (receiverId === request.auth.subjectId) {
      throw conflict('CANNOT_FRIEND_SELF', '不能添加自己为好友');
    }
    const friendRequest = await prisma.$transaction(async (tx) => {
      await assertActiveUsersLocked(tx, [request.auth.subjectId, receiverId]);
      const [userAId, userBId] = canonicalPair(request.auth.subjectId, receiverId);
      const friendship = await tx.friendship.findUnique({
        where: { userAId_userBId: { userAId, userBId } },
      });
      if (friendship) throw conflict('ALREADY_FRIENDS', '已经是好友');
      const reverse = await tx.friendRequest.findUnique({
        where: {
          senderId_receiverId: {
            senderId: receiverId,
            receiverId: request.auth.subjectId,
          },
        },
      });
      if (reverse?.status === 'PENDING') {
        throw conflict('INCOMING_REQUEST_EXISTS', '对方已发送好友申请，请先处理');
      }
      return tx.friendRequest.upsert({
        where: {
          senderId_receiverId: {
            senderId: request.auth.subjectId,
            receiverId,
          },
        },
        create: { senderId: request.auth.subjectId, receiverId },
        update: { status: 'PENDING', respondedAt: null },
        include: { sender: { select: publicUserSelect }, receiver: { select: publicUserSelect } },
      });
    });
    realtimeHub().emitToSubject(receiverId, 'friend.request.created', {
      friendRequest: friendRequestDto(friendRequest),
    });
    return { ok: true, data: { friendRequest: friendRequestDto(friendRequest) } };
  });

  app.get('/v1/friend-requests', { preHandler: authenticate }, async (request) => {
    assertRegistered(request.auth.role);
    const { box } = z
      .object({ box: z.enum(['incoming', 'outgoing', 'all']).default('incoming') })
      .parse(request.query);
    const rows = await prisma.friendRequest.findMany({
      where: box === 'incoming'
        ? { receiverId: request.auth.subjectId }
        : box === 'outgoing'
          ? { senderId: request.auth.subjectId }
          : {
              OR: [
                { receiverId: request.auth.subjectId },
                { senderId: request.auth.subjectId },
              ],
            },
      include: { sender: { select: publicUserSelect }, receiver: { select: publicUserSelect } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { ok: true, data: { items: rows.map(friendRequestDto) } };
  });

  app.post(
    '/v1/friend-requests/:id/respond',
    { preHandler: authenticate },
    async (request) => {
      assertRegistered(request.auth.role);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { action } = z.object({ action: z.enum(['ACCEPT', 'DECLINE']) }).parse(request.body);
      const current = await prisma.friendRequest.findFirst({
        where: { id, receiverId: request.auth.subjectId },
      });
      if (!current) throw notFound('FRIEND_REQUEST_NOT_FOUND', '好友申请不存在');
      if (current.status !== 'PENDING') {
        throw conflict('FRIEND_REQUEST_ALREADY_RESPONDED', '好友申请已处理');
      }
      const respondedAt = new Date();
      const saved = await prisma.$transaction(async (tx) => {
        await assertActiveUsersLocked(tx, [current.senderId, current.receiverId]);
        const claimed = await tx.friendRequest.updateMany({
          where: { id, receiverId: request.auth.subjectId, status: 'PENDING' },
          data: {
            status: action === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED',
            respondedAt,
          },
        });
        if (claimed.count !== 1) {
          throw conflict('FRIEND_REQUEST_ALREADY_RESPONDED', '好友申请已处理');
        }
        if (action === 'ACCEPT') {
          const [userAId, userBId] = canonicalPair(current.senderId, current.receiverId);
          await tx.friendship.upsert({
            where: { userAId_userBId: { userAId, userBId } },
            create: { userAId, userBId },
            update: {},
          });
        }
        return tx.friendRequest.findUniqueOrThrow({
          where: { id },
          include: {
            sender: { select: publicUserSelect },
            receiver: { select: publicUserSelect },
          },
        });
      });
      realtimeHub().emitToSubject(current.senderId, 'friend.request.responded', {
        friendRequest: friendRequestDto(saved),
      });
      return { ok: true, data: { friendRequest: friendRequestDto(saved) } };
    },
  );

  app.get('/v1/friends', { preHandler: authenticate }, async (request) => {
    assertRegistered(request.auth.role);
    const friendships = await prisma.friendship.findMany({
      where: {
        OR: [
          { userAId: request.auth.subjectId },
          { userBId: request.auth.subjectId },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    const friendIds = friendships.map((item) =>
      item.userAId === request.auth.subjectId ? item.userBId : item.userAId);
    const users = await prisma.user.findMany({
      where: { id: { in: friendIds }, status: 'ACTIVE' },
      select: {
        ...publicUserSelect,
        devices: {
          where: { revokedAt: null },
          select: { lastSeenAt: true },
          orderBy: { lastSeenAt: 'desc' },
          take: 1,
        },
      },
    });
    const items = await Promise.all(users.map(async (user) => {
      const socketOnline = await realtimeHub().isSubjectOnline(user.id);
      const recentlySeen = Boolean(
        user.devices[0]?.lastSeenAt &&
        user.devices[0].lastSeenAt.getTime() > Date.now() - 5 * 60_000,
      );
      const { devices: _devices, ...profile } = user;
      return {
        ...profile,
        online: socketOnline || recentlySeen,
        canInvite: true,
      };
    }));
    return { ok: true, data: { items } };
  });

  app.delete('/v1/friends/:friendId', { preHandler: authenticate }, async (request) => {
    assertRegistered(request.auth.role);
    const { friendId } = z.object({ friendId: z.string() }).parse(request.params);
    const [userAId, userBId] = canonicalPair(request.auth.subjectId, friendId);
    const directChat = await prisma.$transaction(async (tx) => {
      await lockUserRows(tx, [userAId, userBId]);
      const conversation = await tx.conversation.findUnique({
        where: { directPairKey: `${userAId}:${userBId}` },
        select: {
          id: true,
          participants: {
            where: { userId: { in: [userAId, userBId] } },
            select: { id: true },
          },
        },
      });
      const removed = await tx.friendship.deleteMany({ where: { userAId, userBId } });
      if (!removed.count) throw notFound('FRIEND_NOT_FOUND', '好友不存在');
      await tx.friendRequest.deleteMany({
        where: {
          OR: [
            { senderId: request.auth.subjectId, receiverId: friendId },
            { senderId: friendId, receiverId: request.auth.subjectId },
          ],
        },
      });
      return conversation;
    });
    realtimeHub().emitToSubject(friendId, 'friend.removed', {
      userId: request.auth.subjectId,
    });
    if (directChat) {
      await Promise.all(
        directChat.participants.map((participant) =>
          realtimeHub().disconnectDirectChatParticipant(
            directChat.id,
            participant.id,
          )),
      );
    }
    return { ok: true, data: { friendId } };
  });

  app.post(
    '/v1/direct-chats/:friendId',
    {
      preHandler: authenticate,
      config: { rateLimit: subjectCredentialRateLimit(20) },
    },
    async (request) => {
      assertRegistered(request.auth.role);
      const { friendId } = z.object({ friendId: z.string().min(1) }).parse(request.params);
      if (friendId === request.auth.subjectId) {
        throw conflict('CANNOT_CHAT_WITH_SELF', '不能和自己创建私聊');
      }
      const [userAId, userBId] = canonicalPair(request.auth.subjectId, friendId);
      const directPairKey = `${userAId}:${userBId}`;
      const conversation = await prisma.$transaction(async (tx) => {
        await assertActiveUsersLocked(tx, [userAId, userBId]);
        const friendships = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "Friendship"
          WHERE "userAId" = ${userAId} AND "userBId" = ${userBId}
          FOR SHARE
        `;
        if (!friendships[0]) throw forbidden('FRIEND_REQUIRED', '只能和好友直接聊天');
        const existing = await tx.conversation.findUnique({
          where: { directPairKey },
          include: conversationInclude,
        });
        if (existing) return existing;

        const profiles = await tx.user.findMany({
          where: { id: { in: [userAId, userBId] }, status: 'ACTIVE' },
          select: {
            id: true,
            displayName: true,
            company: true,
            email: true,
            preferredLanguage: true,
          },
        });
        const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
        const owner = profileById.get(request.auth.subjectId);
        const friend = profileById.get(friendId);
        if (!owner || !friend) throw notFound('USER_NOT_FOUND', '用户不存在');
        const existingContact = await tx.contact.findFirst({
          where: { ownerId: owner.id, linkedUserId: friend.id },
          orderBy: { createdAt: 'asc' },
        });
        const contact = existingContact ?? await tx.contact.create({
          data: {
            ownerId: owner.id,
            linkedUserId: friend.id,
            displayName: friend.displayName,
            company: friend.company,
            email: friend.email?.toLowerCase() ?? null,
          },
        });
        const now = new Date();
        const created = await tx.conversation.create({
          data: {
            kind: 'DIRECT',
            directPairKey,
            ownerId: owner.id,
            contactId: contact.id,
            title: null,
            hostLanguage: owner.preferredLanguage,
            guestLanguage: friend.preferredLanguage,
            status: 'ACTIVE',
            roomTokenHash: stableHash(randomToken(24)),
            roomCodeHash: stableHash(randomRoomCode()),
            guestHistoryPolicy: 'PERMANENT',
            expiresAt: new Date('9999-12-31T23:59:59.999Z'),
            startedAt: now,
            participants: {
              create: [
                {
                  userId: owner.id,
                  role: 'HOST',
                  displayName: owner.displayName,
                  company: owner.company,
                  email: owner.email?.toLowerCase() ?? null,
                  preferredLanguage: owner.preferredLanguage,
                  presence: 'OFFLINE',
                  lastSeenAt: now,
                },
                {
                  userId: friend.id,
                  role: 'GUEST',
                  displayName: friend.displayName,
                  company: friend.company,
                  email: friend.email?.toLowerCase() ?? null,
                  preferredLanguage: friend.preferredLanguage,
                  presence: 'OFFLINE',
                  lastSeenAt: now,
                },
              ],
            },
          },
          include: conversationInclude,
        });
        return created;
      });
      realtimeHub().emitToSubject(friendId, 'direct.chat.ready', {
        conversationId: conversation.id,
      });
      return {
        ok: true,
        data: {
          conversation: conversationDto(
            conversation,
            undefined,
            request.auth.subjectId,
          ),
        },
      };
    },
  );

  app.get('/v1/direct-chats', { preHandler: authenticate }, async (request) => {
    assertRegistered(request.auth.role);
    const rows = await prisma.conversation.findMany({
      where: {
        kind: 'DIRECT',
        participants: {
          some: {
            userId: request.auth.subjectId,
            removedAt: null,
          },
        },
      },
      include: conversationInclude,
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return {
      ok: true,
      data: {
        items: rows.map((conversation) =>
          conversationDto(conversation, undefined, request.auth.subjectId)),
      },
    };
  });

  app.post(
    '/v1/conversations/:id/invitations',
    { preHandler: authenticate },
    async (request) => {
      assertRegistered(request.auth.role);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { inviteeId } = z.object({ inviteeId: z.string() }).parse(request.body);
      const [userAId, userBId] = canonicalPair(request.auth.subjectId, inviteeId);
      const invitation = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<LockedSocialConversation[]>`
          SELECT "id", "ownerId", "status", "expiresAt", "startedAt", "kind"
          FROM "Conversation"
          WHERE "id" = ${id}
          FOR UPDATE
        `;
        const conversation = rows[0];
        if (!conversation || conversation.ownerId !== request.auth.subjectId) {
          throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');
        }
        if (conversation.kind === 'DIRECT') {
          throw forbidden('DIRECT_CHAT_INVITATIONS_UNAVAILABLE', '好友私聊不支持会议邀请');
        }
        const now = new Date();
        if (
          (conversation.status !== 'WAITING' && conversation.status !== 'ACTIVE') ||
          conversation.expiresAt <= now
        ) {
          throw conflict('ROOM_NOT_ACTIVE', '会议已结束或过期');
        }
        await assertActiveUsersLocked(tx, [request.auth.subjectId, inviteeId]);
        const friendship = await tx.friendship.findUnique({
          where: { userAId_userBId: { userAId, userBId } },
        });
        if (!friendship) throw forbidden('FRIEND_REQUIRED', '只能直接邀请好友');
        return tx.meetingInvitation.upsert({
          where: { conversationId_inviteeId: { conversationId: id, inviteeId } },
          create: { conversationId: id, inviterId: request.auth.subjectId, inviteeId },
          update: {
            inviterId: request.auth.subjectId,
            status: 'PENDING',
            respondedAt: null,
          },
          include: meetingInvitationInclude,
        });
      });
      realtimeHub().emitToSubject(inviteeId, 'meeting.invitation.created', {
        invitation: meetingInvitationDto(invitation),
      });
      return { ok: true, data: { invitation: meetingInvitationDto(invitation) } };
    },
  );

  app.get('/v1/meeting-invitations', { preHandler: authenticate }, async (request) => {
    assertRegistered(request.auth.role);
    const { status } = z
      .object({
        status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED', 'ALL'])
          .default('PENDING'),
      })
      .parse(request.query);
    const rows = await prisma.meetingInvitation.findMany({
      where: {
        inviteeId: request.auth.subjectId,
        ...(status === 'ALL' ? {} : { status }),
      },
      include: meetingInvitationInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { ok: true, data: { items: rows.map(meetingInvitationDto) } };
  });

  app.post(
    '/v1/meeting-invitations/:id/respond',
    { preHandler: authenticate },
    async (request) => {
      assertRegistered(request.auth.role);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = z
        .object({ action: z.enum(['ACCEPT', 'DECLINE']) })
        .and(participantProfileSchema.partial())
        .parse(request.body);
      const invitation = await prisma.meetingInvitation.findFirst({
        where: { id, inviteeId: request.auth.subjectId },
        include: meetingInvitationInclude,
      });
      if (!invitation) throw notFound('MEETING_INVITATION_NOT_FOUND', '会议邀请不存在');
      if (invitation.status !== 'PENDING') {
        throw conflict('MEETING_INVITATION_ALREADY_RESPONDED', '会议邀请已处理');
      }
      if (body.action === 'DECLINE') {
        const declined = await prisma.$transaction(async (tx) => {
          const claimed = await tx.meetingInvitation.updateMany({
            where: { id, inviteeId: request.auth.subjectId, status: 'PENDING' },
            data: { status: 'DECLINED', respondedAt: new Date() },
          });
          if (claimed.count !== 1) {
            throw conflict('MEETING_INVITATION_ALREADY_RESPONDED', '会议邀请已处理');
          }
          return tx.meetingInvitation.findUniqueOrThrow({
            where: { id },
            include: meetingInvitationInclude,
          });
        });
        realtimeHub().emitToSubject(invitation.inviterId, 'meeting.invitation.responded', {
          invitation: meetingInvitationDto(declined),
        });
        return { ok: true, data: { invitation: meetingInvitationDto(declined) } };
      }
      const profile = participantProfileSchema.safeParse(body);
      if (!profile.success) {
        throw conflict(
          'PARTICIPANT_PROFILE_REQUIRED',
          '接受邀请前必须确认姓名、公司和使用语言',
        );
      }
      const now = new Date();
      const result = await prisma.$transaction(async (tx) => {
        // Lock order is Conversation -> MeetingInvitation, matching Host end,
        // invitation creation and participant removal.  This prevents an
        // ACCEPT from changing an ENDED conversation back to ACTIVE.
        const rows = await tx.$queryRaw<LockedSocialConversation[]>`
          SELECT "id", "ownerId", "status", "expiresAt", "startedAt", "kind"
          FROM "Conversation"
          WHERE "id" = ${invitation.conversationId}
          FOR UPDATE
        `;
        const conversation = rows[0];
        if (!conversation) throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');
        if (conversation.kind === 'DIRECT') {
          throw forbidden('DIRECT_CHAT_INVITATIONS_UNAVAILABLE', '好友私聊不支持会议邀请');
        }
        if (
          (conversation.status !== 'WAITING' && conversation.status !== 'ACTIVE') ||
          conversation.expiresAt <= now
        ) {
          throw forbidden('ROOM_EXPIRED', '会议已结束或过期');
        }
        await assertActiveUsersLocked(tx, [invitation.inviterId, invitation.inviteeId]);
        const claimed = await tx.meetingInvitation.updateMany({
          where: { id, inviteeId: request.auth.subjectId, status: 'PENDING' },
          data: { status: 'ACCEPTED', respondedAt: now },
        });
        if (claimed.count !== 1) {
          throw conflict('MEETING_INVITATION_ALREADY_RESPONDED', '会议邀请已处理');
        }
        const existing = await tx.participant.findUnique({
          where: {
            conversationId_userId: {
              conversationId: invitation.conversationId,
              userId: request.auth.subjectId,
            },
          },
        });
        if (existing?.removedAt) {
          throw forbidden('PARTICIPANT_REMOVED', '已被主持人移出会议');
        }
        await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            status: 'ACTIVE',
            ...(conversation.startedAt ? {} : { startedAt: now }),
          },
        });
        const participant = existing
          ? await tx.participant.update({
              where: { id: existing.id },
              data: {
                ...profile.data,
                presence: 'OFFLINE',
                leftAt: null,
                lastSeenAt: now,
              },
            })
          : await tx.participant.create({
              data: {
                conversationId: conversation.id,
                userId: request.auth.subjectId,
                role: 'GUEST',
                ...profile.data,
                presence: 'OFFLINE',
                lastSeenAt: now,
              },
            });
        const accepted = await tx.meetingInvitation.findUniqueOrThrow({
          where: { id },
          include: meetingInvitationInclude,
        });
        const joined = await tx.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
          include: conversationInclude,
        });
        return { accepted, participant, conversation: joined };
      });
      realtimeHub().emitToSubject(invitation.inviterId, 'meeting.invitation.responded', {
        invitation: meetingInvitationDto(result.accepted),
      });
      return {
        ok: true,
        data: {
          invitation: meetingInvitationDto(result.accepted),
          participant: participantDto(result.participant),
          conversation: conversationDto(result.conversation),
        },
      };
    },
  );
}

const publicUserSelect = {
  id: true,
  displayName: true,
  email: true,
  company: true,
  preferredLanguage: true,
} as const;

const meetingInvitationInclude = {
  inviter: { select: publicUserSelect },
  invitee: { select: publicUserSelect },
  conversation: {
    include: {
      contact: { select: { id: true, displayName: true, company: true } },
    },
  },
} as const;

interface LockedSocialConversation {
  id: string;
  ownerId: string;
  status: string;
  expiresAt: Date;
  startedAt: Date | null;
  kind: 'MEETING' | 'DIRECT';
}

function assertRegistered(role: string): void {
  if (role === 'GUEST') {
    throw forbidden('FORMAL_ACCOUNT_REQUIRED', '临时用户不能使用好友功能');
  }
}

function canonicalPair(left: string, right: string): [string, string] {
  return left < right ? [left, right] : [right, left];
}

export function subjectCredentialRateLimit(max: number) {
  return {
    max,
    timeWindow: '1 minute',
    // Rate limiting runs before route preHandlers, so key the authenticated
    // credential without retaining it in limiter storage.  IP remains the
    // fallback for malformed unauthenticated requests.
    keyGenerator: (request: { headers: { authorization?: string }; ip: string }) => {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) return request.ip;
      // authenticate() trims the Bearer payload, so the limiter must hash the
      // same canonical credential. Otherwise harmless trailing whitespace can
      // create unlimited independent rate-limit buckets for one valid token.
      const token = authorization.slice(7).trim();
      return token ? stableHash(token) : request.ip;
    },
  };
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const separator = email.indexOf('@');
  if (separator <= 0) return '***';
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

async function assertActiveUsersLocked(
  tx: Prisma.TransactionClient,
  userIds: string[],
): Promise<void> {
  const users = await lockUserRows(tx, userIds);
  if (users.length !== new Set(userIds).size || users.some((user) => user.status !== 'ACTIVE')) {
    throw notFound('USER_NOT_FOUND', '用户不存在');
  }
}

async function lockUserRows(
  tx: Prisma.TransactionClient,
  userIds: string[],
): Promise<Array<{ id: string; status: string }>> {
  const ids = [...new Set(userIds)].sort();
  if (!ids.length) return [];
  return tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status"
    FROM "User"
    WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE
  `;
}

async function relationshipStates(
  subjectId: string,
  otherIds: string[],
): Promise<Map<string, string>> {
  if (!otherIds.length) return new Map();
  const [friendships, requests] = await Promise.all([
    prisma.friendship.findMany({
      where: {
        OR: [
          { userAId: subjectId, userBId: { in: otherIds } },
          { userBId: subjectId, userAId: { in: otherIds } },
        ],
      },
    }),
    prisma.friendRequest.findMany({
      where: {
        status: 'PENDING',
        OR: [
          { senderId: subjectId, receiverId: { in: otherIds } },
          { receiverId: subjectId, senderId: { in: otherIds } },
        ],
      },
    }),
  ]);
  const result = new Map<string, string>();
  for (const friendship of friendships) {
    result.set(
      friendship.userAId === subjectId ? friendship.userBId : friendship.userAId,
      'FRIEND',
    );
  }
  for (const request of requests) {
    const otherId = request.senderId === subjectId ? request.receiverId : request.senderId;
    if (!result.has(otherId)) {
      result.set(otherId, request.senderId === subjectId ? 'OUTGOING' : 'INCOMING');
    }
  }
  return result;
}

function friendRequestDto(request: {
  id: string;
  senderId: string;
  receiverId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  respondedAt: Date | null;
  sender: unknown;
  receiver: unknown;
}) {
  return request;
}

function meetingInvitationDto(invitation: {
  id: string;
  conversationId: string;
  inviterId: string;
  inviteeId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  respondedAt: Date | null;
  inviter: unknown;
  invitee: unknown;
  conversation: {
    id: string;
    title: string | null;
    status: string;
    expiresAt: Date;
    contact: { displayName: string; company: string | null };
  };
}) {
  return {
    id: invitation.id,
    conversationId: invitation.conversationId,
    inviterId: invitation.inviterId,
    inviteeId: invitation.inviteeId,
    status: invitation.status,
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
    respondedAt: invitation.respondedAt,
    inviter: invitation.inviter,
    invitee: invitation.invitee,
    conversation: {
      id: invitation.conversation.id,
      title: invitation.conversation.title,
      status: invitation.conversation.status,
      expiresAt: invitation.conversation.expiresAt,
      contactName: invitation.conversation.contact.displayName,
      company: invitation.conversation.contact.company,
    },
  };
}
