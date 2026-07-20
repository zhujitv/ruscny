import type { FastifyInstance } from 'fastify';
import { Prisma, type Participant } from '@prisma/client';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { randomRoomCode, randomToken, stableHash } from '../lib/crypto.js';
import type { AuthContext } from '../lib/tokens.js';
import { historyExpiresAt } from '../policies.js';
import { realtimeHub } from '../realtime-hub.js';
import {
  conversationDto,
  conversationInclude,
  assertDirectConversationLiveAccessInTransaction,
  assertLockedInvitationCredential,
  effectiveSourceText,
  effectiveTranslatedText,
  findInvitation,
  getConversationForAuth,
  getConversationForAuthInTransaction,
  messageDto,
  participantDto,
} from '../services/conversations.js';
import {
  enqueueAudioDeletionJobs,
  wakeAudioDeletionWorker,
} from '../services/audio-deletion-outbox.js';
import { recoverStaleProcessingMessages } from '../services/message-processing.js';
import { summaryIsStale } from '../services/summary-freshness.js';
import {
  meetingSummaryProvider,
  SUMMARY_PROMPT_VERSION,
  type SummaryGenerationAudit,
} from '../providers/meeting-summary.js';

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

const summarySourceSequencesSchema = z.array(z.number().int().positive()).min(1).max(5_000);
const summaryPartyViewSchema = z.object({
  participantId: z.string().min(1),
  view: z.string().trim().min(1).max(20_000),
  sourceSequences: summarySourceSequencesSchema,
}).strict();
const summarySourcedItemSchema = z.object({
  text: z.string().trim().min(1).max(10_000),
  sourceSequences: summarySourceSequencesSchema,
}).strict();
const summaryActionItemSchema = summarySourcedItemSchema.extend({
  assigneeParticipantId: z.string().min(1),
  dueAt: z.string().datetime({ offset: true }).optional(),
}).strict();
const summaryGenerationSchema = z.object({
  summary: z.string().trim().min(1).max(20_000).optional(),
  summarySourceSequences: summarySourceSequencesSchema.optional(),
  partyViews: z.array(summaryPartyViewSchema).max(1_000).optional(),
  confirmedItems: z.array(summarySourcedItemSchema).max(1_000).optional(),
  actionItems: z.array(summaryActionItemSchema).max(1_000).optional(),
  openQuestions: z.array(summarySourcedItemSchema).max(1_000).optional(),
}).strict();

export async function registerConversationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/conversations',
    { preHandler: requireRole('USER') },
    async (request) => {
      const body = z
        .object({
          contactId: z.string(),
          title: z.string().trim().max(200).optional(),
          hostLanguage: z.enum(['zh', 'ru']).default('zh'),
          guestLanguage: z.enum(['zh', 'ru']).default('ru'),
          guestHistoryPolicy: z
            .enum([
              'NO_ACCESS_AFTER_END',
              'ACCESS_FOR_24_HOURS',
              'ACCESS_FOR_7_DAYS',
              'PERMANENT',
            ])
            .default('ACCESS_FOR_24_HOURS'),
          hostProfile: participantProfileSchema.optional(),
        })
        .parse(request.body);
      const contact = await prisma.contact.findFirst({
        where: { id: body.contactId, ownerId: request.auth.subjectId },
      });
      if (!contact) throw notFound('CONTACT_NOT_FOUND', '客户不存在');
      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: request.auth.subjectId },
        select: {
          displayName: true,
          company: true,
          email: true,
          preferredLanguage: true,
        },
      });
      const roomToken = randomToken(24);
      const roomCode = randomRoomCode();
      const expiresAt = new Date(Date.now() + config.INVITE_TTL_MINUTES * 60_000);
      const conversation = await prisma.$transaction(async (tx) => {
        const created = await tx.conversation.create({
          data: {
            ownerId: request.auth.subjectId,
            contactId: contact.id,
            title: body.title || null,
            hostLanguage: body.hostLanguage,
            guestLanguage: body.guestLanguage,
            guestHistoryPolicy: body.guestHistoryPolicy,
            roomTokenHash: stableHash(roomToken),
            roomCodeHash: stableHash(roomCode),
            expiresAt,
          },
        });
        await tx.participant.create({
          data: {
            conversationId: created.id,
            userId: request.auth.subjectId,
            role: 'HOST',
            displayName: body.hostProfile?.displayName ?? owner.displayName,
            company: body.hostProfile?.company ?? owner.company,
            email: owner.email?.toLowerCase() ?? null,
            preferredLanguage:
              body.hostProfile?.preferredLanguage ??
              body.hostLanguage ??
              owner.preferredLanguage,
            presence: 'OFFLINE',
          },
        });
        return tx.conversation.findUniqueOrThrow({
          where: { id: created.id },
          include: conversationInclude,
        });
      });
      const inviteUrl = `${config.PUBLIC_APP_URL.replace(/\/$/, '')}/join/${roomToken}`;
      return {
        ok: true,
        data: {
          conversation: conversationDto(conversation, { roomToken, roomCode, inviteUrl }),
        },
      };
    },
  );

  app.post(
    '/v1/conversations/:id/invitation/rotate',
    {
      preHandler: requireRole('USER'),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const current = await getConversationForAuth(request.auth, id);
      assertMeetingConversation(current);
      const now = new Date();
      if (current.status === 'ENDED') {
        throw conflict('ROOM_ENDED', '会议已结束，无法更新邀请');
      }
      if (current.status === 'EXPIRED' || current.expiresAt <= now) {
        throw forbidden('ROOM_EXPIRED', '会议已过期，无法更新邀请');
      }

      let result: InvitationRotationResult | undefined;
      for (let collisionAttempt = 0; collisionAttempt < 5; collisionAttempt += 1) {
        const roomToken = randomToken(24);
        const roomCode = randomRoomCode();
        try {
          const outcome = await prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<LockedInvitationConversation[]>`
              SELECT "id", "ownerId", "status", "expiresAt", "roomTokenHash", "roomCodeHash"
              FROM "Conversation"
              WHERE "id" = ${id}
              FOR UPDATE
            `;
            const locked = rows[0];
            if (!locked || locked.ownerId !== request.auth.subjectId) {
              throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');
            }
            const lockedAt = new Date();
            if (locked.status === 'ENDED') return { boundary: 'ENDED' as const };
            if (
              locked.status === 'EXPIRED' ||
              locked.expiresAt <= lockedAt ||
              (locked.status !== 'WAITING' && locked.status !== 'ACTIVE')
            ) {
              if (
                locked.status !== 'EXPIRED' &&
                locked.status !== 'ENDED' &&
                locked.expiresAt <= lockedAt
              ) {
                await tx.conversation.update({
                  where: { id },
                  data: { status: 'EXPIRED' },
                });
                await tx.translationMessage.updateMany({
                  where: { conversationId: id, status: 'PROCESSING' },
                  data: {
                    status: 'FAILED',
                    errorCode: 'ROOM_EXPIRED',
                    errorMessage: '房间已过期',
                    updatedAt: lockedAt,
                  },
                });
              }
              return { boundary: 'EXPIRED' as const };
            }
            if (
              locked.roomTokenHash !== current.roomTokenHash ||
              locked.roomCodeHash !== current.roomCodeHash
            ) {
              return { boundary: 'CONFLICT' as const };
            }
            await tx.conversation.update({
              where: { id },
              data: {
                roomTokenHash: stableHash(roomToken),
                roomCodeHash: stableHash(roomCode),
              },
            });
            return {
              boundary: 'ROTATED' as const,
              expiresAt: locked.expiresAt,
            };
          });
          if (outcome.boundary === 'ENDED') {
            throw conflict('ROOM_ENDED', '会议已结束，无法更新邀请');
          }
          if (outcome.boundary === 'EXPIRED') {
            throw forbidden('ROOM_EXPIRED', '会议已过期，无法更新邀请');
          }
          if (outcome.boundary === 'CONFLICT') {
            throw conflict(
              'INVITATION_ROTATE_CONFLICT',
              '邀请凭证已被更新，请使用最新结果',
            );
          }
          result = {
            conversationId: id,
            roomToken,
            roomCode,
            inviteUrl: `${config.PUBLIC_APP_URL.replace(/\/$/, '')}/join/${roomToken}`,
            expiresAt: outcome.expiresAt,
          };
          break;
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            continue;
          }
          throw error;
        }
      }
      if (!result) {
        throw conflict('INVITATION_COLLISION', '邀请凭证生成冲突，请重试');
      }
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Pragma', 'no-cache');
      return { ok: true, data: result };
    },
  );

  app.post(
    '/v1/conversations/join',
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
    },
    async (request) => {
      const body = z
        .object({
          roomToken: z.string().min(16).optional(),
          inviteToken: z.string().min(16).optional(),
          roomCode: z.string().regex(/^\d{6,8}$/).optional(),
          displayName: profileTextSchema(100).optional(),
          company: profileTextSchema(200).optional(),
          preferredLanguage: z.enum(['zh', 'ru']).optional(),
        })
        .parse(request.body ?? {});
      if (request.auth.role === 'GUEST' && request.auth.conversationId) {
        const scoped = await getConversationForAuth(request.auth, request.auth.conversationId);
        return { ok: true, data: { conversation: conversationDto(scoped) } };
      }
      const conversation = await findInvitation({
        ...(body.roomToken || body.inviteToken
          ? { roomToken: body.roomToken ?? body.inviteToken }
          : {}),
        ...(body.roomCode ? { roomCode: body.roomCode } : {}),
      });
      const presentedInvitation = {
        ...(body.roomToken || body.inviteToken
          ? { roomToken: body.roomToken ?? body.inviteToken }
          : {}),
        ...(body.roomCode ? { roomCode: body.roomCode } : {}),
      };
      await prisma.$transaction(async (tx) => {
          const joinedAt = new Date();
          const rows = await tx.$queryRaw<LockedInvitationConversation[]>`
            SELECT "id", "kind", "ownerId", "status", "expiresAt", "startedAt", "roomTokenHash", "roomCodeHash"
            FROM "Conversation"
            WHERE "id" = ${conversation.id}
            FOR UPDATE
          `;
          const locked = rows[0];
          if (!locked) throw notFound('ROOM_NOT_FOUND', '房间不存在');
          assertLockedInvitationCredential(locked, presentedInvitation);
          if (
            (locked.status !== 'WAITING' && locked.status !== 'ACTIVE') ||
            locked.expiresAt <= joinedAt
          ) {
            throw forbidden('ROOM_EXPIRED', '房间已结束或过期');
          }
          // Account deletion takes Conversation locks before anonymizing the
          // User. Re-read the account after obtaining the same lock so a stale
          // pre-read cannot insert PII for a DELETED user after cleanup.
          const user = await tx.user.findUnique({
            where: { id: request.auth.subjectId },
            select: {
              status: true,
              displayName: true,
              company: true,
              email: true,
              preferredLanguage: true,
            },
          });
          if (!user || user.status !== 'ACTIVE') {
            throw forbidden('ACCOUNT_DISABLED', '账号不存在或已停用');
          }
          const displayName = body.displayName ?? user.displayName;
          const company = body.company ?? user.company;
          const preferredLanguage = body.preferredLanguage ?? user.preferredLanguage;
          if (!displayName || !company || !preferredLanguage) {
            throw new AppError(
              400,
              'PARTICIPANT_PROFILE_REQUIRED',
              '进入会议前必须确认姓名、公司和使用语言',
            );
          }
          const membership = await tx.participant.findUnique({
            where: {
              conversationId_userId: {
                conversationId: conversation.id,
                userId: request.auth.subjectId,
              },
            },
          });
          if (membership?.removedAt) {
            throw forbidden('PARTICIPANT_REMOVED', '主持人已将此客户移出会议');
          }
          await tx.conversation.update({
            where: { id: locked.id },
            data: {
              status: 'ACTIVE',
              ...(locked.startedAt ? {} : { startedAt: joinedAt }),
            },
          });
          if (membership) {
            await tx.participant.update({
              where: { id: membership.id },
              data: {
                displayName,
                company,
                email: user.email?.toLowerCase() ?? null,
                preferredLanguage,
                lastSeenAt: joinedAt,
                leftAt: null,
                presence: 'OFFLINE',
              },
            });
          } else {
            await tx.participant.create({ data: {
              conversationId: conversation.id,
              userId: request.auth.subjectId,
              role: 'GUEST',
              displayName,
              company,
              email: user.email?.toLowerCase() ?? null,
              preferredLanguage,
              presence: 'OFFLINE',
            } });
          }
        });
      const joined = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
        include: conversationInclude,
      });
      return { ok: true, data: { conversation: conversationDto(joined) } };
    },
  );

  app.get('/v1/conversations', { preHandler: authenticate }, async (request) => {
    const query = z
      .object({
        contactId: z.string().optional(),
        search: z.string().trim().max(100).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .parse(request.query);
    const baseWhere = {
      kind: 'MEETING' as const,
      ...(query.contactId ? { contactId: query.contactId } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' as const } },
              { contact: { displayName: { contains: query.search, mode: 'insensitive' as const } } },
              { contact: { company: { contains: query.search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };
    const where = request.auth.role === 'GUEST'
      ? { id: request.auth.conversationId ?? '__none__' }
      : {
          AND: [
            baseWhere,
            {
              OR: [
                { ownerId: request.auth.subjectId },
                {
                  participants: {
                    some: {
                      userId: request.auth.subjectId,
                      removedAt: null,
                    },
                  },
                },
              ],
            },
          ],
        };
    const rows = await prisma.conversation.findMany({
      where,
      include: conversationInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const visible = [];
    for (const row of rows) {
      try {
        const authorized = await getConversationForAuth(request.auth, row.id, { history: true });
        visible.push(conversationDto(authorized, undefined, request.auth.subjectId));
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'HISTORY_ACCESS_EXPIRED')) throw error;
      }
    }
    return { ok: true, data: { items: visible } };
  });

  app.get('/v1/conversations/:id', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const conversation = await getConversationForAuth(request.auth, id, { history: true });
    return {
      ok: true,
      data: {
        conversation: conversationDto(conversation, undefined, request.auth.subjectId),
      },
    };
  });

  app.patch(
    '/v1/conversations/:id',
    { preHandler: requireRole('USER') },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = z.object({ title: z.string().trim().min(1).max(200) }).parse(request.body);
      const current = await getConversationForAuth(request.auth, id);
      assertMeetingConversation(current);
      assertConversationOwner(current.ownerId, request.auth.subjectId);
      const conversation = await prisma.conversation.update({
        where: { id },
        data: { title: body.title },
        include: conversationInclude,
      });
      return { ok: true, data: { conversation: conversationDto(conversation) } };
    },
  );

  app.post(
    '/v1/conversations/:id/end',
    { preHandler: requireRole('USER') },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const current = await getConversationForAuth(request.auth, id);
      assertMeetingConversation(current);
      assertConversationOwner(current.ownerId, request.auth.subjectId);
      if (current.status === 'EXPIRED') throw forbidden('ROOM_EXPIRED', '会议已过期');
      if (current.status === 'ENDED') {
        return { ok: true, data: { conversation: conversationDto(current) } };
      }
      const endedAt = new Date();
      const guestAccessExpiresAt = historyExpiresAt(current.guestHistoryPolicy, endedAt);
      const result = await prisma.$transaction(async (tx) => {
        const transitioned = await tx.conversation.updateMany({
          where: { id, status: { in: ['WAITING', 'ACTIVE'] } },
          data: { status: 'ENDED', endedAt, guestAccessExpiresAt },
        });
        const resolved = await tx.conversation.findUnique({
          where: { id },
        });
        if (!resolved) throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');
        if (resolved.status === 'EXPIRED') throw forbidden('ROOM_EXPIRED', '会议已过期');
        if (resolved.status !== 'ENDED') {
          throw conflict('CONVERSATION_STATE_CHANGED', '会议状态已变更，请重试');
        }
        if (transitioned.count === 1) {
          await tx.translationMessage.updateMany({
            where: { conversationId: id, status: 'PROCESSING' },
            data: {
              status: 'FAILED',
              errorCode: 'ROOM_ENDED',
              errorMessage: '会议已结束',
              updatedAt: endedAt,
            },
          });
          await tx.guestIdentity.updateMany({
            where: { conversationId: id },
            data: {
              expiresAt:
                current.guestHistoryPolicy === 'PERMANENT'
                  ? new Date('9999-12-31T23:59:59.999Z')
              : guestAccessExpiresAt ?? endedAt,
            },
          });
          await tx.participant.updateMany({
            where: { conversationId: id, removedAt: null },
            data: {
              presence: 'LEFT',
              leftAt: endedAt,
              lastSeenAt: endedAt,
            },
          });
          await tx.meetingInvitation.updateMany({
            where: { conversationId: id, status: 'PENDING' },
            data: { status: 'EXPIRED', respondedAt: endedAt },
          });
        }
        // Read the response only after terminal participant states are written;
        // otherwise the end response can still contain stale ONLINE members.
        const fresh = await tx.conversation.findUniqueOrThrow({
          where: { id },
          include: conversationInclude,
        });
        return { conversation: fresh, transitioned: transitioned.count === 1 };
      });
      if (result.transitioned) {
        realtimeHub().emitToConversation(id, 'room.ended', {
          conversationId: id,
          endedAt: result.conversation.endedAt,
        });
      }
      return { ok: true, data: { conversation: conversationDto(result.conversation) } };
    },
  );

  app.delete(
    '/v1/conversations/:id',
    { preHandler: requireRole('USER') },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const current = await getConversationForAuth(request.auth, id);
      assertMeetingConversation(current);
      assertConversationOwner(current.ownerId, request.auth.subjectId);
      const queuedAudioDeletions = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Conversation" WHERE "id" = ${id} FOR UPDATE
        `;
        if (!rows[0]) throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');
        const assets = await tx.translationMessage.findMany({
          where: { conversationId: id, audioUrl: { not: null } },
          select: { audioUrl: true },
        });
        const queued = await enqueueAudioDeletionJobs(
          tx,
          assets.map((asset) => asset.audioUrl),
        );
        await tx.conversation.delete({ where: { id } });
        return queued;
      }, { maxWait: 10_000, timeout: 60_000 });
      if (queuedAudioDeletions > 0) wakeAudioDeletionWorker();
      return { ok: true, data: {} };
    },
  );

  app.delete(
    '/v1/conversations/:id/participants/:participantId',
    { preHandler: requireRole('USER') },
    async (request) => {
      const { id, participantId } = z
        .object({ id: z.string(), participantId: z.string() })
        .parse(request.params);
      const current = await getConversationForAuth(request.auth, id);
      assertMeetingConversation(current);
      assertConversationOwner(current.ownerId, request.auth.subjectId);
      const removedAt = new Date();
      let removal: { participant: Participant; invitationRotated: boolean } | undefined;
      for (let collisionAttempt = 0; collisionAttempt < 5; collisionAttempt += 1) {
        const invalidatedTokenHash = stableHash(randomToken(24));
        const invalidatedCodeHash = stableHash(randomRoomCode());
        try {
          removal = await prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<LockedRemovalConversation[]>`
              SELECT "id", "ownerId", "status", "expiresAt"
              FROM "Conversation"
              WHERE "id" = ${id}
              FOR UPDATE
            `;
            const locked = rows[0];
            if (!locked || locked.ownerId !== request.auth.subjectId) {
              throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');
            }
            if (
              (locked.status !== 'WAITING' && locked.status !== 'ACTIVE') ||
              locked.expiresAt <= removedAt
            ) {
              throw conflict('ROOM_NOT_ACTIVE', '会议已结束或过期');
            }
            const participant = await tx.participant.findFirst({
              where: {
                id: participantId,
                conversationId: id,
                role: { not: 'HOST' },
                removedAt: null,
              },
            });
            if (!participant) {
              throw notFound('PARTICIPANT_NOT_FOUND', '参会者不存在');
            }
            const invitationRotated = Boolean(participant.guestIdentityId);
            if (participant.guestIdentityId) {
              // Keep the shared lifecycle order Conversation -> GuestIdentity
              // -> Participant. Guest refresh, logout, deletion and message
              // finalization use the same order.
              await tx.guestIdentity.updateMany({
                where: { id: participant.guestIdentityId },
                data: { revokedAt: removedAt, expiresAt: removedAt },
              });
            }
            const updated = await tx.participant.update({
              where: { id: participant.id },
              data: {
                removedAt,
                leftAt: removedAt,
                lastSeenAt: removedAt,
                presence: 'REMOVED',
              },
            });
            await tx.translationMessage.updateMany({
              where: { participantId: participant.id, status: 'PROCESSING' },
              data: {
                status: 'FAILED',
                errorCode: 'PARTICIPANT_REMOVED',
                errorMessage: '参会者已被主持人移出会议',
                updatedAt: removedAt,
              },
            });
            if (participant.guestIdentityId) {
              // A shared room credential cannot identify the removed Guest.
              // Invalidate it in the same row-locked transaction so changing a
              // client-controlled device id cannot reuse the old link/code.
              await tx.conversation.update({
                where: { id },
                data: {
                  roomTokenHash: invalidatedTokenHash,
                  roomCodeHash: invalidatedCodeHash,
                },
              });
            }
            if (participant.userId) {
              await tx.meetingInvitation.updateMany({
                where: {
                  conversationId: id,
                  inviteeId: participant.userId,
                  status: { in: ['PENDING', 'ACCEPTED'] },
                },
                data: { status: 'REVOKED', respondedAt: removedAt },
              });
            }
            return { participant: updated, invitationRotated };
          });
          break;
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            continue;
          }
          throw error;
        }
      }
      if (!removal) throw conflict('INVITATION_COLLISION', '邀请凭证生成冲突，请重试');
      realtimeHub().emitToConversation(id, 'participant.removed', {
        conversationId: id,
        participantId: removal.participant.id,
        removedAt,
      });
      if (removal.invitationRotated) {
        const rotationPayload = {
          conversationId: id,
          reason: 'PARTICIPANT_REMOVED',
          credentialsAvailable: false,
        };
        realtimeHub().emitToConversation(id, 'invitation.rotated', rotationPayload);
        realtimeHub().emitToSubject(request.auth.subjectId, 'invitation.rotated', rotationPayload);
      }
      await realtimeHub().disconnectParticipant(id, removal.participant.id);
      return {
        ok: true,
        data: {
          conversationId: id,
          participantId: removal.participant.id,
          removedAt,
          invitationRotated: removal.invitationRotated,
        },
      };
    },
  );

  app.get(
    '/v1/conversations/:id/participants',
    { preHandler: authenticate },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const participants = await prisma.$transaction(async (tx) => {
        await getConversationForAuthInTransaction(tx, request.auth, id, {
          history: true,
        });
        return tx.participant.findMany({
          where: { conversationId: id },
          orderBy: { joinedAt: 'asc' },
        });
      });
      return { ok: true, data: { items: participants.map(participantDto) } };
    },
  );

  app.patch(
    '/v1/conversations/:id/participants/me',
    { preHandler: authenticate },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      await getConversationForAuth(request.auth, id);
      const body = participantProfileSchema.parse(request.body);
      const updated = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<LockedParticipantConversation[]>`
          SELECT "id", "kind", "directPairKey", "status", "expiresAt"
          FROM "Conversation"
          WHERE "id" = ${id}
          FOR UPDATE
        `;
        const conversation = rows[0];
        const now = new Date();
        if (
          !conversation ||
          (conversation.status !== 'WAITING' && conversation.status !== 'ACTIVE') ||
          conversation.expiresAt <= now
        ) {
          throw conflict('ROOM_NOT_ACTIVE', '会议已结束或过期');
        }
        await assertDirectConversationLiveAccessInTransaction(
          tx,
          request.auth,
          conversation,
        );
        const participant = await tx.participant.findFirst({
          where: participantWhereForAuth(request.auth, id, { active: true }),
        });
        if (!participant) throw forbidden('NOT_A_PARTICIPANT', '您不是该会议参与者');
        return tx.participant.update({
          where: { id: participant.id },
          data: {
            displayName: body.displayName,
            company: body.company,
            preferredLanguage: body.preferredLanguage,
          },
        });
      });
      realtimeHub().emitToConversation(id, 'participant.updated', {
        conversationId: id,
        participant: participantDto(updated),
      });
      return { ok: true, data: { participant: participantDto(updated) } };
    },
  );

  app.post(
    '/v1/conversations/:id/leave',
    { preHandler: authenticate },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const current = await getConversationForAuth(request.auth, id);
      assertMeetingConversation(current);
      const leftAt = new Date();
      const result = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<LockedParticipantConversation[]>`
          SELECT "id", "status", "expiresAt"
          FROM "Conversation"
          WHERE "id" = ${id}
          FOR UPDATE
        `;
        const conversation = rows[0];
        if (!conversation) throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');
        const participant = await tx.participant.findFirst({
          where: participantWhereForAuth(request.auth, id),
        });
        if (!participant) throw forbidden('NOT_A_PARTICIPANT', '您不是该会议参与者');
        if (participant.role === 'HOST') {
          throw conflict('HOST_MUST_END_CONVERSATION', '主持人请使用结束会议');
        }
        if (participant.leftAt || participant.presence === 'LEFT') {
          return { participant, transitioned: false };
        }
        if (
          (conversation.status !== 'WAITING' && conversation.status !== 'ACTIVE') ||
          conversation.expiresAt <= leftAt
        ) {
          throw conflict('ROOM_NOT_ACTIVE', '会议已结束或过期');
        }
        const left = await tx.participant.update({
          where: { id: participant.id },
          data: {
            presence: 'LEFT',
            leftAt,
            lastSeenAt: leftAt,
          },
        });
        await tx.translationMessage.updateMany({
          where: { participantId: participant.id, status: 'PROCESSING' },
          data: {
            status: 'FAILED',
            errorCode: 'PARTICIPANT_LEFT',
            errorMessage: '参会者已离开会议',
            updatedAt: leftAt,
          },
        });
        return { participant: left, transitioned: true };
      });
      if (result.transitioned) {
        realtimeHub().emitToConversation(id, 'participant.presence', {
          conversationId: id,
          participant: participantDto(result.participant),
        });
      }
      await realtimeHub().disconnectParticipant(id, result.participant.id);
      return { ok: true, data: { participant: participantDto(result.participant) } };
    },
  );

  app.get(
    '/v1/conversations/:id/messages',
    { preHandler: authenticate },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const query = z
        .object({
          afterSequence: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        })
        .parse(request.query);
      await getConversationForAuth(request.auth, id, { history: true });
      await recoverStaleProcessingMessages(id);
      const messages = await prisma.$transaction(async (tx) => {
        await getConversationForAuthInTransaction(tx, request.auth, id, {
          history: true,
        });
        return tx.translationMessage.findMany({
          where: { conversationId: id, sequence: { gt: query.afterSequence } },
          orderBy: { sequence: 'asc' },
          take: query.limit,
        });
      });
      return { ok: true, data: { items: messages.map(messageDto) } };
    },
  );

  app.get(
    '/v1/conversations/:id/export',
    { preHandler: authenticate },
    async (request, reply) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { format, groupBy } = z
        .object({
          format: z.enum(['txt', 'md']).default('txt'),
          groupBy: z.enum(['sequence', 'speaker']).default('sequence'),
        })
        .parse(request.query);
      const readable = await getConversationForAuth(request.auth, id, { history: true });
      assertMeetingDocumentsAvailable(readable);
      await recoverStaleProcessingMessages(id);
      const { conversation, messages } = await prisma.$transaction(async (tx) => {
        const authorized = await getConversationForAuthInTransaction(
          tx,
          request.auth,
          id,
          { history: true },
        );
        assertMeetingDocumentsAvailable(authorized);
        const scopedMessages = await tx.translationMessage.findMany({
          where: { conversationId: id, status: { in: ['FINAL', 'FAILED'] } },
          orderBy: { sequence: 'asc' },
        });
        return { conversation: authorized, messages: scopedMessages };
      });
      const orderedMessages = groupBy === 'speaker'
        ? [...messages].sort(
            (left, right) =>
              left.participantId.localeCompare(right.participantId) ||
              left.sequence - right.sequence,
          )
        : messages;
      const lines = format === 'md'
        ? [
            `# ${escapeMarkdownInline(conversation.title || '中俄翻译记录')}`,
            '',
            `- 客户：${escapeMarkdownInline(conversation.contact.displayName)}`,
            `- 会话 ID：\`${conversation.id}\``,
            '',
            ...orderedMessages.flatMap((message) => [
              `## ${message.createdAt.toISOString()}｜${escapeMarkdownInline(message.speakerDisplayName)}｜${escapeMarkdownInline(message.speakerCompany ?? '-')}｜${message.sourceLanguage}`,
              '',
              `- 状态：${escapeMarkdownInline(exportStatusText(message))}`,
              '',
              `**原文（${message.sourceLanguage}）**`,
              '',
              markdownQuotedText(exportSourceText(message)),
              '',
              `**译文（${message.targetLanguage}）**`,
              '',
              markdownQuotedText(exportTranslatedText(message)),
              '',
            ]),
          ]
        : [
            singleLineExportField(conversation.title || '中俄翻译记录'),
            `客户：${singleLineExportField(conversation.contact.displayName)}`,
            `会话 ID：${conversation.id}`,
            '',
            ...orderedMessages.flatMap((message) => [
              `${message.createdAt.toISOString()}｜${singleLineExportField(message.speakerDisplayName)}｜${singleLineExportField(message.speakerCompany ?? '-')}｜${message.sourceLanguage}`,
              `状态：${singleLineExportField(exportStatusText(message))}`,
              `原文：${indentPlainTextContinuation(exportSourceText(message))}`,
              `译文：${indentPlainTextContinuation(exportTranslatedText(message))}`,
              '',
            ]),
          ];
      reply
        .type(format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="conversation-${id}.${format}"`);
      return lines.join('\n');
    },
  );

  app.get(
    '/v1/conversations/:id/summary',
    { preHandler: authenticate },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const result = await prisma.$transaction(async (tx) => {
        const conversation = await getConversationForAuthInTransaction(tx, request.auth, id, {
          history: true,
        });
        assertMeetingDocumentsAvailable(conversation);
        const [summary, sourceState] = await Promise.all([
          tx.conversationSummary.findUnique({ where: { conversationId: id } }),
          tx.translationMessage.aggregate({
            where: { conversationId: id, status: 'FINAL' },
            _max: { sequence: true, updatedAt: true },
            _count: { _all: true },
          }),
        ]);
        if (!summary) throw notFound('SUMMARY_NOT_FOUND', '会议纪要尚未生成');
        const isStale = summary.sourceMaxSequence === null ||
          summary.sourceMessageCount === null ||
          summary.sourceLatestMessageUpdatedAt === null
          ? null
          : summaryIsStale(summary, sourceState);
        return { summary: { ...summary, isStale } };
      });
      return { ok: true, data: result };
    },
  );

  app.post(
    '/v1/conversations/:id/summary',
    {
      preHandler: requireRole('USER'),
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const readable = await getConversationForAuth(request.auth, id, { history: true });
      assertMeetingDocumentsAvailable(readable);
      const body = summaryGenerationSchema.parse(request.body ?? {});
      if (Object.keys(body).length > 0) {
        const saved = await prisma.$transaction(async (tx) => {
          const conversation = await getConversationForAuthInTransaction(
            tx,
            request.auth,
            id,
            { history: true },
          );
          assertMeetingDocumentsAvailable(conversation);
          assertConversationOwner(conversation.ownerId, request.auth.subjectId);
          if (conversation.status !== 'ENDED') {
            throw conflict(
              'SUMMARY_REQUIRES_ENDED_CONVERSATION',
              '请先结束会议，再修改最终会议纪要',
            );
          }
          return generateConversationSummary(tx, conversation, body, undefined, undefined, {
            mode: 'MANUAL',
            generatedByUserId: request.auth.subjectId,
          });
        });
        return { ok: true, data: { summary: saved } };
      }

      const idempotencyKey = request.headers['idempotency-key'];
      if (
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.length < 8 ||
        idempotencyKey.length > 200
      ) {
        throw badRequest('IDEMPOTENCY_KEY_REQUIRED', '生成 AI 会议纪要需要有效的 Idempotency-Key');
      }

      const snapshot = await prisma.$transaction(async (tx) => {
        const conversation = await getConversationForAuthInTransaction(
          tx,
          request.auth,
          id,
          { history: true },
        );
        assertMeetingDocumentsAvailable(conversation);
        assertConversationOwner(conversation.ownerId, request.auth.subjectId);
        if (conversation.status !== 'ENDED') {
          throw conflict(
            'SUMMARY_REQUIRES_ENDED_CONVERSATION',
            '请先结束会议，再生成最终会议纪要',
          );
        }
        const owner = await tx.user.findUnique({
          where: { id: request.auth.subjectId },
          select: { legalPolicyVersion: true },
        });
        if (owner?.legalPolicyVersion !== config.LEGAL_POLICY_VERSION) {
          throw conflict('LEGAL_POLICY_REACCEPT_REQUIRED', '请重新登录并确认最新隐私政策后再生成 AI 纪要');
        }
        const [participants, messages] = await Promise.all([
          tx.participant.findMany({
          where: { conversationId: id },
          orderBy: { joinedAt: 'asc' },
          }),
          tx.translationMessage.findMany({
          where: { conversationId: id, status: 'FINAL' },
          orderBy: { sequence: 'asc' },
          }),
        ]);
        return { conversation, participants, messages };
      });
      const sourceMessageVersions = snapshot.messages.map(messageSourceVersion);
      const sourceParticipantVersions = snapshot.participants.map(participantSourceVersion);
      const sourceHash = stableHash(JSON.stringify({
        conversationId: id,
        messages: sourceMessageVersions,
        participants: sourceParticipantVersions,
        model: config.ALIYUN_SUMMARY_MODEL,
        promptVersion: SUMMARY_PROMPT_VERSION,
      }));
      const activeKey = `${id}:${sourceHash}`;
      const staleBefore = new Date(Date.now() - config.SUMMARY_GENERATION_STALE_MS);

      let generationId: string;
      try {
        const claim = await prisma.$transaction(async (tx) => {
          const existing = await tx.summaryGeneration.findUnique({
            where: { conversationId_idempotencyKey: { conversationId: id, idempotencyKey } },
          });
          if (existing) {
            if (existing.sourceHash !== sourceHash) {
              throw conflict('IDEMPOTENCY_KEY_REUSED', '同一 Idempotency-Key 不能用于不同的会议纪要来源');
            }
            if (existing.status === 'COMPLETED' && existing.summaryRevision) {
              const summary = await tx.conversationSummary.findUnique({ where: { conversationId: id } });
              if (summary?.revision === existing.summaryRevision) return { summary };
              throw conflict('IDEMPOTENCY_RESULT_REPLACED', '该生成结果已被更新，请使用新的 Idempotency-Key');
            }
            if (existing.status === 'PROCESSING' && existing.startedAt >= staleBefore) {
              throw conflict('SUMMARY_GENERATION_IN_PROGRESS', '本场会议纪要正在生成，请勿重复提交');
            }
            const reclaimed = await tx.summaryGeneration.update({
              where: { id: existing.id },
              data: {
                status: 'PROCESSING',
                activeKey,
                errorCode: null,
                startedAt: new Date(),
                completedAt: null,
                attempts: { increment: 1 },
              },
            });
            return { generationId: reclaimed.id };
          }
          const activeGeneration = await tx.summaryGeneration.findUnique({
            where: { activeKey },
          });
          if (activeGeneration) {
            if (activeGeneration.startedAt >= staleBefore) {
              throw conflict('SUMMARY_GENERATION_IN_PROGRESS', '本场会议纪要正在生成，请勿重复提交');
            }
            await tx.summaryGeneration.update({
              where: { id: activeGeneration.id },
              data: {
                status: 'FAILED',
                activeKey: null,
                errorCode: 'SUMMARY_GENERATION_STALE',
                completedAt: new Date(),
              },
            });
          }
          const recentCount = await tx.summaryGeneration.count({
            where: {
              requestedByUserId: request.auth.subjectId,
              createdAt: { gte: new Date(Date.now() - 60_000) },
            },
          });
          if (recentCount >= 5) {
            throw new AppError(429, 'SUMMARY_GENERATION_RATE_LIMITED', 'AI 会议纪要生成过于频繁，请稍后再试');
          }
          const created = await tx.summaryGeneration.create({
            data: {
              conversationId: id,
              requestedByUserId: request.auth.subjectId,
              idempotencyKey,
              sourceHash,
              activeKey,
              provider: config.SUMMARY_PROVIDER,
              model: config.ALIYUN_SUMMARY_MODEL,
              promptVersion: SUMMARY_PROMPT_VERSION,
            },
          });
          return { generationId: created.id };
        });
        if ('summary' in claim) return { ok: true, data: { summary: claim.summary } };
        generationId = claim.generationId;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw conflict('SUMMARY_GENERATION_IN_PROGRESS', '本场会议纪要正在生成，请勿重复提交');
        }
        throw error;
      }

      try {
        const generated = await meetingSummaryProvider.generate({
          conversationTitle: snapshot.conversation.title ?? snapshot.conversation.id,
          participants: snapshot.participants.map((participant) => ({
            participantId: participant.id,
            displayName: participant.displayName,
            company: participant.company,
            preferredLanguage: participant.preferredLanguage,
          })),
          messages: snapshot.messages.map((message) => ({
            sequence: message.sequence,
            participantId: message.participantId,
            speakerDisplayName: message.speakerDisplayName,
            speakerCompany: message.speakerCompany,
            sourceLanguage: message.sourceLanguage,
            sourceText: effectiveSourceText(message),
            translatedText: effectiveTranslatedText(message),
            spokenAt: message.createdAt.toISOString(),
          })),
        });
        const saved = await prisma.$transaction(async (tx) => {
          const conversation = await getConversationForAuthInTransaction(
            tx,
            request.auth,
            id,
            { history: true },
          );
          assertMeetingDocumentsAvailable(conversation);
          assertConversationOwner(conversation.ownerId, request.auth.subjectId);
          if (conversation.status !== 'ENDED') {
            throw conflict('SUMMARY_REQUIRES_ENDED_CONVERSATION', '会议状态已变化，未保存 AI 纪要');
          }
          const summary = await generateConversationSummary(
            tx,
            conversation,
            generated.draft,
            sourceMessageVersions,
            sourceParticipantVersions,
            {
              mode: 'AI',
              generatedByUserId: request.auth.subjectId,
              sourceHash,
              audit: generated.audit,
            },
          );
          await tx.summaryGeneration.update({
            where: { id: generationId },
            data: {
              status: 'COMPLETED',
              activeKey: null,
              summaryRevision: summary.revision,
              providerRequestId: generated.audit.providerRequestId,
              inputTokens: generated.audit.inputTokens,
              outputTokens: generated.audit.outputTokens,
              completedAt: new Date(),
            },
          });
          return summary;
        });
        return { ok: true, data: { summary: saved } };
      } catch (error) {
        await prisma.summaryGeneration.updateMany({
          where: { id: generationId, status: 'PROCESSING' },
          data: {
            status: 'FAILED',
            activeKey: null,
            errorCode: error instanceof AppError ? error.code : 'SUMMARY_GENERATION_FAILED',
            completedAt: new Date(),
          },
        });
        throw error;
      }
    },
  );

  app.post(
    '/v1/conversations/:id/summary/approve',
    { preHandler: requireRole('USER') },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = z.object({ revision: z.number().int().positive() }).strict().parse(request.body);
      const summary = await prisma.$transaction(async (tx) => {
        const conversation = await getConversationForAuthInTransaction(tx, request.auth, id, { history: true });
        assertMeetingDocumentsAvailable(conversation);
        assertConversationOwner(conversation.ownerId, request.auth.subjectId);
        const current = await tx.conversationSummary.findUnique({ where: { conversationId: id } });
        if (!current) throw notFound('SUMMARY_NOT_FOUND', '会议纪要尚未生成');
        if (current.revision !== body.revision) {
          throw conflict('SUMMARY_REVISION_CONFLICT', '会议纪要已更新，请重新查看后确认');
        }
        const sourceState = await tx.translationMessage.aggregate({
          where: { conversationId: id, status: 'FINAL' },
          _max: { sequence: true, updatedAt: true },
          _count: { _all: true },
        });
        if (summaryIsStale(current, sourceState)) {
          throw conflict('SUMMARY_STALE', '会议内容已变化，请重新生成会议纪要后再确认');
        }
        return tx.conversationSummary.update({
          where: { id: current.id },
          data: {
            approvedRevision: current.revision,
            approvedAt: new Date(),
            approvedByUserId: request.auth.subjectId,
          },
        });
      });
      return { ok: true, data: { summary } };
    },
  );
}

interface SummarySaveMetadata {
  mode: 'AI' | 'MANUAL';
  generatedByUserId: string;
  sourceHash?: string;
  audit?: SummaryGenerationAudit;
}

async function generateConversationSummary(
  tx: Prisma.TransactionClient,
  conversation: Awaited<ReturnType<typeof getConversationForAuthInTransaction>>,
  body: z.infer<typeof summaryGenerationSchema>,
  expectedSourceVersions?: string[],
  expectedParticipantVersions?: string[],
  metadata?: SummarySaveMetadata,
) {
  const id = conversation.id;
  const [participants, messages] = await Promise.all([
    tx.participant.findMany({
      where: { conversationId: id },
      orderBy: { joinedAt: 'asc' },
    }),
    tx.translationMessage.findMany({
      where: { conversationId: id, status: 'FINAL' },
      orderBy: { sequence: 'asc' },
    }),
  ]);
  if (
    expectedSourceVersions &&
    (expectedSourceVersions.length !== messages.length ||
      expectedSourceVersions.some((version, index) => version !== messageSourceVersion(messages[index]!)))
  ) {
    throw conflict(
      'SUMMARY_SOURCE_CHANGED',
      '会议内容在 AI 整理期间发生变化，请重新生成会议纪要',
    );
  }
  if (
    expectedParticipantVersions &&
    (expectedParticipantVersions.length !== participants.length ||
      expectedParticipantVersions.some(
        (version, index) => version !== participantSourceVersion(participants[index]!),
      ))
  ) {
    throw conflict(
      'SUMMARY_SOURCE_CHANGED',
      '参会者资料在 AI 整理期间发生变化，请重新生成会议纪要',
    );
  }
  const participantRoster = participants.map(participantDto);
  const participantById = new Map(
    participants.map((participant) => [participant.id, participant]),
  );
  const messageBySequence = new Map(
    messages.map((message) => [message.sequence, message]),
  );
  const sourceSnapshots = (sequences: number[]) => sequences.map((sequence) => {
    const message = messageBySequence.get(sequence);
    if (!message) {
      throw badRequest(
        'SUMMARY_SOURCE_NOT_FOUND',
        `会议纪要引用的发言序号 ${sequence} 不存在`,
      );
    }
    return {
      sequence: message.sequence,
      participantId: message.participantId,
      speakerDisplayName: message.speakerDisplayName,
      speakerCompany: message.speakerCompany,
      sourceLanguage: message.sourceLanguage,
      sourceText: effectiveSourceText(message),
      translatedText: effectiveTranslatedText(message),
      spokenAt: message.createdAt.toISOString(),
    };
  });

  // Speaker identity and source text are always rebuilt from immutable
  // server-side message snapshots. Clients may add annotations, never replace
  // attribution with client-owned names or participant IDs.
  const coreDiscussion = sourceSnapshots(messages.map((message) => message.sequence));
  const partyViews = body.partyViews
    ? body.partyViews.map((view) => {
        const participant = participantById.get(view.participantId);
        if (!participant) {
          throw badRequest(
            'SUMMARY_PARTICIPANT_NOT_FOUND',
            '会议纪要引用的参会者不存在',
          );
        }
        const sources = sourceSnapshots(view.sourceSequences);
        if (sources.some((source) => source.participantId !== participant.id)) {
          throw badRequest(
            'SUMMARY_SPEAKER_MISMATCH',
            '各方观点的发言序号必须属于指定参会者',
          );
        }
        return {
          participantId: participant.id,
          speakerDisplayName: participant.displayName,
          speakerCompany: participant.company,
          preferredLanguage: participant.preferredLanguage,
          view: view.view,
          sourceSequences: view.sourceSequences,
          sources,
        };
      })
    : participants.flatMap((participant) => {
        const statements = messages.filter(
          (message) => message.participantId === participant.id,
        );
        if (!statements.length) return [];
        const sourceSequences = statements.map((message) => message.sequence);
        return [{
          participantId: participant.id,
          speakerDisplayName: participant.displayName,
          speakerCompany: participant.company,
          preferredLanguage: participant.preferredLanguage,
          view: statements.map(effectiveSourceText).join('\n'),
          sourceSequences,
          sources: sourceSnapshots(sourceSequences),
        }];
      });
  const withSources = (items: Array<{ text: string; sourceSequences: number[] }>) =>
    items.map((item) => ({ ...item, sources: sourceSnapshots(item.sourceSequences) }));
  const confirmedItems = withSources(body.confirmedItems ?? []);
  const openQuestions = withSources(body.openQuestions ?? []);
  const summarySources = sourceSnapshots(
    body.summarySourceSequences ?? messages.map((message) => message.sequence),
  );
  const actionItems = (body.actionItems ?? []).map((item) => {
    const assignee = participantById.get(item.assigneeParticipantId);
    if (!assignee) {
      throw badRequest(
        'SUMMARY_ASSIGNEE_NOT_FOUND',
        '待办事项负责人必须是本会议参会者',
      );
    }
    return {
      ...item,
      assigneeDisplayName: assignee.displayName,
      assigneeCompany: assignee.company,
      sources: sourceSnapshots(item.sourceSequences),
    };
  });
  const summaryText = body.summary ??
    `会议“${conversation.title ?? conversation.id}”共记录 ${messages.length} 条发言。`;
  const generatedAt = new Date();
  const sourceMaxSequence = messages.at(-1)?.sequence ?? 0;
  const sourceLatestMessageUpdatedAt = messages.reduce<Date | null>(
    (latest, message) =>
      !latest || message.updatedAt > latest ? message.updatedAt : latest,
    null,
  ) ?? new Date(0);

  return tx.conversationSummary.upsert({
    where: { conversationId: id },
    create: {
      conversationId: id,
      summary: summaryText,
      summarySources: asJson(summarySources),
      participantRoster: asJson(participantRoster),
      coreDiscussion: asJson(coreDiscussion),
      partyViews: asJson(partyViews),
      confirmedItems: asJson(confirmedItems),
      actionItems: asJson(actionItems),
      openQuestions: asJson(openQuestions),
      customerRequirements: [],
      products: [],
      specifications: [],
      quantity: [],
      price: [],
      delivery: [],
      paymentTerms: [],
      sourceMaxSequence,
      sourceMessageCount: messages.length,
      sourceLatestMessageUpdatedAt,
      revision: 1,
      generationMode: metadata?.mode ?? 'MANUAL',
      provider: metadata?.audit?.provider,
      model: metadata?.audit?.model,
      promptVersion: metadata?.audit?.promptVersion,
      providerRequestId: metadata?.audit?.providerRequestId,
      inputTokens: metadata?.audit?.inputTokens,
      outputTokens: metadata?.audit?.outputTokens,
      sourceHash: metadata?.sourceHash,
      generatedByUserId: metadata?.generatedByUserId,
      generatedAt,
    },
    update: {
      summary: summaryText,
      summarySources: asJson(summarySources),
      participantRoster: asJson(participantRoster),
      coreDiscussion: asJson(coreDiscussion),
      partyViews: asJson(partyViews),
      confirmedItems: asJson(confirmedItems),
      actionItems: asJson(actionItems),
      openQuestions: asJson(openQuestions),
      sourceMaxSequence,
      sourceMessageCount: messages.length,
      sourceLatestMessageUpdatedAt,
      revision: { increment: 1 },
      generationMode: metadata?.mode ?? 'MANUAL',
      provider: metadata?.audit?.provider ?? null,
      model: metadata?.audit?.model ?? null,
      promptVersion: metadata?.audit?.promptVersion ?? null,
      providerRequestId: metadata?.audit?.providerRequestId ?? null,
      inputTokens: metadata?.audit?.inputTokens ?? null,
      outputTokens: metadata?.audit?.outputTokens ?? null,
      sourceHash: metadata?.sourceHash ?? null,
      generatedByUserId: metadata?.generatedByUserId,
      approvedRevision: null,
      approvedAt: null,
      approvedByUserId: null,
      generatedAt,
    },
  });
}

function messageSourceVersion(message: {
  id: string;
  sequence: number;
  updatedAt: Date;
}): string {
  return JSON.stringify([message.id, message.sequence, message.updatedAt.toISOString()]);
}

function participantSourceVersion(participant: {
  id: string;
  displayName: string;
  company: string | null;
  preferredLanguage: string;
  removedAt: Date | null;
}): string {
  return JSON.stringify([
    participant.id,
    participant.displayName,
    participant.company,
    participant.preferredLanguage,
    participant.removedAt?.toISOString() ?? '',
  ]);
}

interface LockedInvitationConversation {
  id: string;
  kind: 'MEETING' | 'DIRECT';
  ownerId: string;
  status: string;
  expiresAt: Date;
  startedAt: Date | null;
  roomTokenHash: string;
  roomCodeHash: string;
}

interface InvitationRotationResult {
  conversationId: string;
  roomToken: string;
  roomCode: string;
  inviteUrl: string;
  expiresAt: Date;
}

interface LockedRemovalConversation {
  id: string;
  ownerId: string;
  status: string;
  expiresAt: Date;
}

interface LockedParticipantConversation {
  id: string;
  kind: 'MEETING' | 'DIRECT';
  directPairKey: string | null;
  status: string;
  expiresAt: Date;
}

function participantWhereForAuth(
  auth: AuthContext,
  conversationId: string,
  options: { active?: boolean } = {},
): Prisma.ParticipantWhereInput {
  return {
    conversationId,
    removedAt: null,
    ...(options.active
      ? { leftAt: null, presence: { in: ['ONLINE', 'OFFLINE'] as const } }
      : {}),
    ...(auth.role === 'GUEST'
      ? { guestIdentityId: auth.guestIdentityId ?? auth.subjectId }
      : { userId: auth.subjectId }),
  };
}

function assertConversationOwner(ownerId: string, subjectId: string): void {
  if (ownerId !== subjectId) {
    throw forbidden('HOST_PERMISSION_REQUIRED', '只有本会议主持人可以执行此操作');
  }
}

function assertMeetingConversation(
  conversation: { kind: 'MEETING' | 'DIRECT' },
): void {
  if (conversation.kind === 'DIRECT') {
    throw forbidden(
      'DIRECT_CHAT_MEETING_ACTION_UNAVAILABLE',
      '好友私聊不支持房间邀请、参会者管理或结束会议操作',
    );
  }
}

function assertMeetingDocumentsAvailable(
  conversation: { kind: 'MEETING' | 'DIRECT' },
): void {
  if (conversation.kind === 'DIRECT') {
    throw forbidden(
      'DIRECT_CHAT_DOCUMENTS_UNAVAILABLE',
      '好友私聊仅保留消息记录，不支持导出、AI 整理或纪要分发',
    );
  }
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function exportStatusText(message: {
  status: string;
  errorCode?: string | null;
  errorMessage?: string | null;
}): string {
  const detail = [message.errorCode, message.errorMessage]
    .filter((value): value is string => Boolean(value))
    .join('：');
  const status = message.status === 'FAILED' ? '翻译失败' : '已完成';
  return detail ? `${status}（${detail}）` : status;
}

function exportSourceText(message: Parameters<typeof effectiveSourceText>[0]): string {
  return effectiveSourceText(message) || '（未识别到原文）';
}

function exportTranslatedText(
  message: Parameters<typeof effectiveTranslatedText>[0] & { status: string },
): string {
  const translated = effectiveTranslatedText(message);
  if (translated) return translated;
  return message.status === 'FAILED' ? '（翻译失败，无译文）' : '（无译文）';
}

function singleLineExportField(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]+/gu, ' ').trim();
}

function indentPlainTextContinuation(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ' ')
    .split('\n')
    .map((line, index) => index === 0 ? line : `  ${line}`)
    .join('\n');
}

function escapeMarkdownInline(value: string): string {
  return singleLineExportField(value)
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]()#+.!|<>-])/g, '\\$1');
}

function markdownQuotedText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ' ')
    .split('\n')
    .map((line) => `> ${escapeMarkdownInline(line)}`)
    .join('\n');
}
