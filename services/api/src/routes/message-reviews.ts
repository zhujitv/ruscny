import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  Prisma,
  type MessageCorrection,
  type Participant,
  type TranslationMessage,
} from '@prisma/client';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { prisma } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { AuthContext } from '../lib/tokens.js';
import {
  assertLanguagePair,
  translationProvider,
  type TranslationTerm,
} from '../providers/translation.js';
import { realtimeHub } from '../realtime-hub.js';
import {
  effectiveSourceText,
  effectiveTranslatedText,
  getConversationForAuth,
  getConversationForAuthInTransaction,
  messageDto,
  type ConversationWithContact,
} from '../services/conversations.js';
import {
  deleteTtsAsset,
  isStoredTtsAsset,
  persistTtsAudio,
} from '../services/audio-assets.js';
import {
  enqueueAudioDeletionJobs,
  enqueueAudioDeletionJobsNow,
  wakeAudioDeletionWorker,
} from '../services/audio-deletion-outbox.js';
import { systemSetting } from '../services/system-settings.js';

const idempotencyKeySchema = z.string().min(8).max(200);
const reviewTextSchema = z.string().trim().min(1).max(5_000);

const manualCorrectionSchema = z
  .object({
    sourceText: reviewTextSchema.optional(),
    translatedText: reviewTextSchema.optional(),
    reason: z.string().trim().max(1_000).nullish(),
    expectedRevision: z.number().int().min(0),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict()
  .refine(
    (value) => value.sourceText !== undefined || value.translatedText !== undefined,
    { message: '至少修改原文或译文之一' },
  );

const retranslateSchema = z
  .object({
    sourceText: reviewTextSchema.optional(),
    reason: z.string().trim().max(1_000).nullish(),
    expectedRevision: z.number().int().min(0),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

const decisionSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().max(1_000).nullish(),
  })
  .strict();

const glossarySchema = z
  .object({
    sourceTerm: z.string().trim().min(1).max(200),
    targetTerm: z.string().trim().min(1).max(200),
    category: z.string().trim().max(100).nullish(),
  })
  .strict();

export interface ReviewContext {
  auth: AuthContext;
  conversation: ConversationWithContact;
  participant: Participant;
  message: TranslationMessage;
}

interface ProposalInput {
  context: ReviewContext;
  kind: 'MANUAL' | 'RETRANSLATE';
  proposedSourceText: string;
  proposedTranslatedText: string;
  reason?: string | null;
  expectedRevision: number;
  idempotencyKey: string;
  requestHash: string;
}

interface ProposalResult {
  message: TranslationMessage;
  correction: MessageCorrection;
  idempotent: boolean;
}

export async function registerMessageReviewRoutes(app: FastifyInstance): Promise<void> {
  const authenticated = { preHandler: authenticate };
  const reviewMutation = { preHandler: async (request: FastifyRequest) => {
    await authenticate(request);
    if (!await systemSetting('QUALITY_REVIEW_ENABLED')) {
      throw forbidden('QUALITY_REVIEW_DISABLED', '系统暂时关闭翻译纠错');
    }
  } };

  app.get(
    '/v1/conversations/:conversationId/messages/:messageId/corrections',
    authenticated,
    async (request) => {
      const ids = reviewRouteIds(request.params);
      const query = z
        .object({ afterRevision: z.coerce.number().int().min(0).default(0) })
        .parse(request.query);
      const corrections = await prisma.$transaction(async (tx) => {
        await getConversationForAuthInTransaction(
          tx,
          request.auth,
          ids.conversationId,
          { history: true },
        );
        const message = await tx.translationMessage.findFirst({
          where: { id: ids.messageId, conversationId: ids.conversationId },
          select: { id: true },
        });
        if (!message) throw notFound('MESSAGE_NOT_FOUND', '翻译消息不存在');
        return tx.messageCorrection.findMany({
          where: {
            conversationId: ids.conversationId,
            messageId: ids.messageId,
            revision: { gt: query.afterRevision },
          },
          orderBy: { revision: 'asc' },
          take: 500,
        });
      });
      return {
        ok: true,
        data: { items: corrections.map(correctionDto) },
      };
    },
  );

  app.post(
    '/v1/conversations/:conversationId/messages/:messageId/corrections',
    reviewMutation,
    async (request) => {
      const ids = reviewRouteIds(request.params);
      const body = manualCorrectionSchema.parse(request.body);
      const context = await resolveReviewContext(
        request.auth,
        ids.conversationId,
        ids.messageId,
      );
      const proposedSourceText = body.sourceText ?? effectiveSourceText(context.message);
      const proposedTranslatedText =
        body.translatedText ?? effectiveTranslatedText(context.message);
      const requestHash = correctionRequestHash({
        kind: 'MANUAL',
        sourceText: proposedSourceText,
        translatedText: proposedTranslatedText,
        reason: body.reason ?? null,
        expectedRevision: body.expectedRevision,
      });
      const result = await proposeCorrection({
        context,
        kind: 'MANUAL',
        proposedSourceText,
        proposedTranslatedText,
        reason: body.reason,
        expectedRevision: body.expectedRevision,
        idempotencyKey: body.idempotencyKey,
        requestHash,
      });
      emitReviewUpdate(result.message, result.correction);
      return reviewResponse(result);
    },
  );

  app.post(
    '/v1/conversations/:conversationId/messages/:messageId/retranslate',
    reviewMutation,
    async (request) => {
      const ids = reviewRouteIds(request.params);
      const body = retranslateSchema.parse(request.body);
      const context = await resolveReviewContext(
        request.auth,
        ids.conversationId,
        ids.messageId,
      );
      const sourceText = body.sourceText ?? effectiveSourceText(context.message);
      const requestHash = correctionRequestHash({
        kind: 'RETRANSLATE',
        sourceText,
        reason: body.reason ?? null,
        expectedRevision: body.expectedRevision,
      });
      const prior = await idempotentProposal(
        context,
        body.idempotencyKey,
        requestHash,
      );
      if (prior) return reviewResponse(prior);

      assertLanguagePair(context.message.sourceLanguage, context.message.targetLanguage);
      const sourceLanguage = context.message.sourceLanguage as 'zh' | 'ru';
      const targetLanguage = context.message.targetLanguage as 'zh' | 'ru';
      const translated = await translationProvider.translate({
        text: sourceText,
        sourceLanguage,
        targetLanguage,
        terms: await reviewGlossaryTerms(
          context.conversation.ownerId,
          sourceLanguage,
          targetLanguage,
          sourceText,
        ),
      });
      const result = await proposeCorrection({
        context,
        kind: 'RETRANSLATE',
        proposedSourceText: sourceText,
        proposedTranslatedText: translated.text,
        reason: body.reason,
        expectedRevision: body.expectedRevision,
        idempotencyKey: body.idempotencyKey,
        requestHash,
      });
      emitReviewUpdate(result.message, result.correction);
      return reviewResponse(result);
    },
  );

  app.post(
    '/v1/conversations/:conversationId/messages/:messageId/review/confirm',
    reviewMutation,
    async (request) => {
      const ids = reviewRouteIds(request.params);
      const body = decisionSchema.parse(request.body);
      const context = await resolveReviewContext(
        request.auth,
        ids.conversationId,
        ids.messageId,
      );
      const result = await confirmCorrection(request, context, body);
      emitReviewUpdate(result.message, result.correction);
      return reviewResponse(result);
    },
  );

  app.post(
    '/v1/conversations/:conversationId/messages/:messageId/review/reject',
    reviewMutation,
    async (request) => {
      const ids = reviewRouteIds(request.params);
      const body = decisionSchema.parse(request.body);
      const context = await resolveReviewContext(
        request.auth,
        ids.conversationId,
        ids.messageId,
      );
      const result = await rejectCorrection(context, body);
      emitReviewUpdate(result.message, result.correction);
      return reviewResponse(result);
    },
  );

  app.post(
    '/v1/conversations/:conversationId/messages/:messageId/glossary',
    reviewMutation,
    async (request) => {
      const ids = reviewRouteIds(request.params);
      const body = glossarySchema.parse(request.body);
      const context = await resolveReviewContext(
        request.auth,
        ids.conversationId,
        ids.messageId,
      );
      if (
        request.auth.role === 'GUEST' ||
        context.conversation.ownerId !== request.auth.subjectId
      ) {
        throw forbidden(
          'GLOSSARY_OWNER_REQUIRED',
          '只有会议主持人可以把已确认内容加入自己的术语库',
        );
      }
      const term = await prisma.$transaction((tx) =>
        upsertConfirmedGlossaryTerm(tx, context, body),
      );
      return { ok: true, data: { term } };
    },
  );
}

type GlossaryInput = z.infer<typeof glossarySchema>;

/**
 * Adds a term only from the message's current confirmed review revision.
 * The actor lock must stay first so this write serializes with end, removal,
 * leave and identity/session revocation using the established lock order.
 */
export async function upsertConfirmedGlossaryTerm(
  tx: Prisma.TransactionClient,
  context: ReviewContext,
  body: GlossaryInput,
) {
  await lockAndAssertReviewActor(tx, context);

  const message = await tx.translationMessage.findUnique({
    where: { id: context.message.id },
    select: {
      id: true,
      conversationId: true,
      status: true,
      reviewStatus: true,
      reviewRevision: true,
      sourceLanguage: true,
      targetLanguage: true,
    },
  });
  if (!message || message.conversationId !== context.message.conversationId) {
    throw notFound('MESSAGE_NOT_FOUND', '翻译消息不存在');
  }
  if (
    message.status !== 'FINAL' ||
    message.reviewStatus !== 'CONFIRMED' ||
    message.reviewRevision < 1
  ) {
    throw conflict('MESSAGE_NOT_CONFIRMED', '请先确认当前纠错内容再加入术语库');
  }

  const confirmed = await tx.messageCorrection.findUnique({
    where: {
      messageId_revision: {
        messageId: message.id,
        revision: message.reviewRevision,
      },
    },
    select: { conversationId: true, status: true },
  });
  if (
    !confirmed ||
    confirmed.conversationId !== message.conversationId ||
    confirmed.status !== 'CONFIRMED'
  ) {
    throw conflict('MESSAGE_NOT_CONFIRMED', '请先确认当前纠错内容再加入术语库');
  }

  return tx.glossaryTerm.upsert({
    where: {
      ownerId_sourceLanguage_targetLanguage_sourceTerm: {
        ownerId: context.conversation.ownerId,
        sourceLanguage: message.sourceLanguage,
        targetLanguage: message.targetLanguage,
        sourceTerm: body.sourceTerm,
      },
    },
    create: {
      ownerId: context.conversation.ownerId,
      sourceLanguage: message.sourceLanguage,
      targetLanguage: message.targetLanguage,
      sourceTerm: body.sourceTerm,
      targetTerm: body.targetTerm,
      category: body.category || '会议纠错',
      enabled: true,
    },
    update: {
      targetTerm: body.targetTerm,
      category: body.category || '会议纠错',
      enabled: true,
    },
  });
}

async function resolveReadableMessage(
  auth: AuthContext,
  conversationId: string,
  messageId: string,
): Promise<{ conversation: ConversationWithContact; message: TranslationMessage }> {
  const conversation = await getConversationForAuth(auth, conversationId, {
    history: true,
  });
  const message = await prisma.translationMessage.findFirst({
    where: { id: messageId, conversationId },
  });
  if (!message) throw notFound('MESSAGE_NOT_FOUND', '翻译消息不存在');
  return { conversation, message };
}

async function resolveReviewContext(
  auth: AuthContext,
  conversationId: string,
  messageId: string,
): Promise<ReviewContext> {
  const { conversation, message } = await resolveReadableMessage(
    auth,
    conversationId,
    messageId,
  );
  if (message.status !== 'FINAL') {
    throw conflict('MESSAGE_NOT_FINAL', '只有已完成的翻译可以纠错');
  }
  assertLanguagePair(message.sourceLanguage, message.targetLanguage);
  if (conversation.status !== 'ACTIVE' || conversation.expiresAt <= new Date()) {
    throw forbidden('ROOM_NOT_ACTIVE', '会议已结束或过期，历史记录仅可查看');
  }
  const participant = await prisma.participant.findFirst({
    where: {
      conversationId,
      removedAt: null,
      leftAt: null,
      presence: { in: ['ONLINE', 'OFFLINE'] },
      ...(auth.role === 'GUEST'
        ? { guestIdentityId: auth.guestIdentityId ?? auth.subjectId }
        : { userId: auth.subjectId }),
    },
  });
  if (!participant) {
    throw forbidden('NOT_A_PARTICIPANT', '您不是该会议的有效参会者');
  }
  assertMessageReviewActor({
    conversationOwnerId: conversation.ownerId,
    actorSubjectId: auth.subjectId,
    actorParticipantId: participant.id,
    messageParticipantId: message.participantId,
  });
  return { auth, conversation, participant, message };
}

export function assertMessageReviewActor(input: {
  conversationOwnerId: string;
  actorSubjectId: string;
  actorParticipantId: string;
  messageParticipantId: string;
}): void {
  const owner = input.conversationOwnerId === input.actorSubjectId;
  const speaker = input.actorParticipantId === input.messageParticipantId;
  if (!owner && !speaker) {
    throw forbidden(
      'MESSAGE_REVIEW_FORBIDDEN',
      '只有主持人或该条发言的实际发言者可以纠错和确认',
    );
  }
}

interface LockedReviewConversation {
  id: string;
  ownerId: string;
  status: string;
  expiresAt: Date;
}

interface LockedReviewParticipant {
  id: string;
  userId: string | null;
  guestIdentityId: string | null;
  removedAt: Date | null;
  leftAt: Date | null;
  presence: string;
}

interface LockedReviewGuest {
  id: string;
  conversationId: string;
  sessionId: string;
  revokedAt: Date | null;
  expiresAt: Date;
}

interface LockedReviewUser {
  id: string;
  status: string;
}

interface LockedReviewDevice {
  sessionId: string;
  revokedAt: Date | null;
}

/**
 * Serializes review writes with participant removal and revalidates the
 * server-owned identity after any provider/TTS latency. The lock order is
 * Conversation -> identity/session -> Participant, matching account deletion,
 * Guest refresh and Host removal.
 */
export async function lockAndAssertReviewActor(
  tx: Prisma.TransactionClient,
  context: ReviewContext,
  now = new Date(),
): Promise<void> {
  const conversations = await tx.$queryRaw<LockedReviewConversation[]>`
    SELECT "id", "ownerId", "status", "expiresAt"
    FROM "Conversation"
    WHERE "id" = ${context.message.conversationId}
    FOR UPDATE
  `;
  const lockedConversation = conversations[0];
  if (!lockedConversation) {
    throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');
  }
  if (
    lockedConversation.status !== 'ACTIVE' ||
    lockedConversation.expiresAt <= now
  ) {
    throw forbidden('ROOM_NOT_ACTIVE', '会议已结束或过期，历史记录仅可查看');
  }

  if (context.auth.role === 'GUEST') {
    const guestIdentityId =
      context.auth.guestIdentityId ?? context.auth.subjectId;
    const guests = await tx.$queryRaw<LockedReviewGuest[]>`
      SELECT "id", "conversationId", "sessionId", "revokedAt", "expiresAt"
      FROM "GuestIdentity"
      WHERE "id" = ${guestIdentityId}
      FOR UPDATE
    `;
    const guest = guests[0];
    if (
      !guest ||
      guest.conversationId !== context.message.conversationId ||
      guest.revokedAt ||
      guest.expiresAt <= now ||
      !context.auth.sessionId ||
      guest.sessionId !== context.auth.sessionId
    ) {
      throw forbidden('GUEST_TOKEN_REVOKED', '访客身份已失效');
    }
  } else {
    const users = await tx.$queryRaw<LockedReviewUser[]>`
      SELECT "id", "status"
      FROM "User"
      WHERE "id" = ${context.auth.subjectId}
      FOR UPDATE
    `;
    if (!users[0] || users[0].status !== 'ACTIVE') {
      throw forbidden('ACCOUNT_DISABLED', '账号不存在或已停用');
    }
    const devices = await tx.$queryRaw<LockedReviewDevice[]>`
      SELECT "sessionId", "revokedAt"
      FROM "UserDevice"
      WHERE "userId" = ${context.auth.subjectId}
        AND "deviceId" = ${context.auth.deviceId}
      FOR UPDATE
    `;
    const device = devices[0];
    if (
      !device ||
      device.revokedAt ||
      !context.auth.sessionId ||
      device.sessionId !== context.auth.sessionId
    ) {
      throw forbidden('DEVICE_REVOKED', '此设备登录已被撤销');
    }
  }

  const participants = await tx.$queryRaw<LockedReviewParticipant[]>`
    SELECT "id", "userId", "guestIdentityId", "removedAt", "leftAt", "presence"
    FROM "Participant"
    WHERE "id" = ${context.participant.id}
      AND "conversationId" = ${context.message.conversationId}
    FOR UPDATE
  `;
  const participant = participants[0];
  if (!participant || participant.removedAt) {
    throw forbidden('PARTICIPANT_REMOVED', '参会者已被移出会议');
  }
  if (
    participant.leftAt ||
    !['ONLINE', 'OFFLINE'].includes(participant.presence)
  ) {
    throw forbidden('PARTICIPANT_LEFT', '已退出会议，历史记录仅可查看');
  }

  const matchesIdentity = context.auth.role === 'GUEST'
    ? participant.guestIdentityId ===
      (context.auth.guestIdentityId ?? context.auth.subjectId)
    : participant.userId === context.auth.subjectId;
  if (!matchesIdentity) {
    throw forbidden('NOT_A_PARTICIPANT', '当前身份与参会者不匹配');
  }
  assertMessageReviewActor({
    conversationOwnerId: lockedConversation.ownerId,
    actorSubjectId: context.auth.subjectId,
    actorParticipantId: participant.id,
    messageParticipantId: context.message.participantId,
  });
}

async function proposeCorrection(input: ProposalInput): Promise<ProposalResult> {
  const prior = await idempotentProposal(
    input.context,
    input.idempotencyKey,
    input.requestHash,
  );
  if (prior) return prior;

  const revision = input.expectedRevision + 1;
  try {
    return await prisma.$transaction(async (tx) => {
      await lockAndAssertReviewActor(tx, input.context);
      await advanceMessageReviewProposal(tx, {
        messageId: input.context.message.id,
        conversationId: input.context.message.conversationId,
        expectedRevision: input.expectedRevision,
        proposedSourceText: input.proposedSourceText,
        proposedTranslatedText: input.proposedTranslatedText,
      });

      const now = new Date();
      await tx.messageCorrection.updateMany({
        where: { messageId: input.context.message.id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          decisionReason: 'SUPERSEDED',
          decidedAt: now,
          decidedBySubjectId: input.context.participant.userId ??
            input.context.participant.guestIdentityId,
          decidedByParticipantId: input.context.participant.id,
          deciderDisplayName: input.context.participant.displayName,
        },
      });
      const correction = await tx.messageCorrection.create({
        data: {
          conversationId: input.context.message.conversationId,
          messageId: input.context.message.id,
          revision,
          kind: input.kind,
          proposedSourceText: input.proposedSourceText,
          proposedTranslatedText: input.proposedTranslatedText,
          reason: input.reason || null,
          actorType: input.context.participant.userId ? 'USER' : 'GUEST',
          actorSubjectId:
            input.context.participant.userId ??
            input.context.participant.guestIdentityId!,
          actorParticipantId: input.context.participant.id,
          actorDisplayName: input.context.participant.displayName,
          actorCompany: input.context.participant.company,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
        },
      });
      const message = await tx.translationMessage.findUniqueOrThrow({
        where: { id: input.context.message.id },
      });
      return { message, correction, idempotent: false };
    });
  } catch (error) {
    const raced = await idempotentProposal(
      input.context,
      input.idempotencyKey,
      input.requestHash,
    );
    if (raced) return raced;
    if (
      error instanceof AppError ||
      error instanceof Prisma.PrismaClientKnownRequestError
    ) {
      if (error instanceof AppError) throw error;
      if (error.code === 'P2002' || error.code === 'P2034') throw reviewConflict();
    }
    throw error;
  }
}

export async function advanceMessageReviewProposal(
  tx: Pick<Prisma.TransactionClient, 'translationMessage'>,
  input: {
    messageId: string;
    conversationId: string;
    expectedRevision: number;
    proposedSourceText: string;
    proposedTranslatedText: string;
  },
): Promise<void> {
  const advanced = await tx.translationMessage.updateMany({
    where: {
      id: input.messageId,
      conversationId: input.conversationId,
      status: 'FINAL',
      reviewRevision: input.expectedRevision,
    },
    data: {
      reviewRevision: { increment: 1 },
      reviewStatus: 'PENDING',
      pendingSourceText: input.proposedSourceText,
      pendingTranslatedText: input.proposedTranslatedText,
      reviewedAt: null,
    },
  });
  if (advanced.count !== 1) throw reviewConflict();
}

async function idempotentProposal(
  context: ReviewContext,
  idempotencyKey: string,
  requestHash: string,
): Promise<ProposalResult | null> {
  return prisma.$transaction(async (tx) => {
    await lockAndAssertReviewActor(tx, context);
    const correction = await tx.messageCorrection.findUnique({
      where: {
        messageId_idempotencyKey: {
          messageId: context.message.id,
          idempotencyKey,
        },
      },
    });
    if (!correction) return null;
    if (
      correction.conversationId !== context.message.conversationId ||
      correction.requestHash !== requestHash
    ) {
      throw conflict(
        'IDEMPOTENCY_KEY_REUSED',
        '该幂等键已用于不同的纠错请求',
      );
    }
    const message = await tx.translationMessage.findFirst({
      where: {
        id: context.message.id,
        conversationId: context.message.conversationId,
      },
    });
    if (!message) throw notFound('MESSAGE_NOT_FOUND', '翻译消息不存在');
    return { message, correction, idempotent: true };
  });
}

async function confirmCorrection(
  request: FastifyRequest,
  context: ReviewContext,
  body: z.infer<typeof decisionSchema>,
): Promise<ProposalResult> {
  const correction = await currentCorrection(context.message.id, body.expectedRevision);
  if (
    correction.status === 'CONFIRMED' &&
    context.message.reviewRevision === body.expectedRevision
  ) {
    const idempotent = await terminalDecisionResult(
      context,
      correction.id,
      body.expectedRevision,
      'CONFIRMED',
    );
    if (idempotent) return idempotent;
    throw reviewConflict();
  }
  if (correction.status !== 'PENDING') throw reviewConflict();

  const keepsExistingAudio =
    correction.proposedTranslatedText === effectiveTranslatedText(context.message) &&
    isStoredTtsAsset(context.message.audioUrl);
  let generatedAudio: string | null = null;
  let ttsFailed = false;
  if (!keepsExistingAudio) {
    try {
      const speech = await translationProvider.synthesize({
        text: correction.proposedTranslatedText,
        language: context.message.targetLanguage as 'zh' | 'ru',
      });
      generatedAudio = await persistTtsAudio(speech.audioUrl);
    } catch (error) {
      ttsFailed = true;
      request.log.warn(
        { error, messageId: context.message.id },
        'Correction confirmed without regenerated TTS audio',
      );
    }
  }

  let queuedOldAudio = false;
  try {
    const result = await prisma.$transaction(async (tx) => {
      await lockAndAssertReviewActor(tx, context);
      const now = new Date();
      const decided = await tx.messageCorrection.updateMany({
        where: {
          id: correction.id,
          messageId: context.message.id,
          revision: body.expectedRevision,
          status: 'PENDING',
        },
        data: {
          status: 'CONFIRMED',
          decisionReason: body.reason || null,
          decidedAt: now,
          decidedBySubjectId:
            context.participant.userId ?? context.participant.guestIdentityId,
          decidedByParticipantId: context.participant.id,
          deciderDisplayName: context.participant.displayName,
        },
      });
      if (decided.count !== 1) throw reviewConflict();
      const updated = await tx.translationMessage.updateMany({
        where: {
          id: context.message.id,
          reviewRevision: body.expectedRevision,
          reviewStatus: 'PENDING',
        },
        data: {
          confirmedSourceText: correction.proposedSourceText,
          confirmedTranslatedText: correction.proposedTranslatedText,
          pendingSourceText: null,
          pendingTranslatedText: null,
          reviewStatus: 'CONFIRMED',
          reviewedAt: now,
          audioUrl: keepsExistingAudio ? context.message.audioUrl : generatedAudio,
          ...(keepsExistingAudio
            ? {}
            : {
                errorCode: ttsFailed ? 'TTS_FAILED' : null,
                errorMessage: ttsFailed ? '纠错已确认，译文语音暂不可用' : null,
              }),
        },
      });
      if (updated.count !== 1) throw reviewConflict();
      // A previously generated summary contains text snapshots. Removing it
      // prevents clients from treating stale pre-correction minutes as current.
      await tx.conversationSummary.deleteMany({
        where: { conversationId: context.message.conversationId },
      });
      queuedOldAudio = !keepsExistingAudio &&
        (await enqueueAudioDeletionJobs(tx, [context.message.audioUrl])) > 0;
      const [message, savedCorrection] = await Promise.all([
        tx.translationMessage.findUniqueOrThrow({ where: { id: context.message.id } }),
        tx.messageCorrection.findUniqueOrThrow({ where: { id: correction.id } }),
      ]);
      return { message, correction: savedCorrection, idempotent: false };
    });
    if (queuedOldAudio) wakeAudioDeletionWorker();
    return result;
  } catch (error) {
    if (generatedAudio) await cleanupGeneratedAudio(request, generatedAudio);
    const raced = await terminalDecisionResult(
      context,
      correction.id,
      body.expectedRevision,
      'CONFIRMED',
    );
    if (raced) return raced;
    throw error;
  }
}

async function rejectCorrection(
  context: ReviewContext,
  body: z.infer<typeof decisionSchema>,
): Promise<ProposalResult> {
  const correction = await currentCorrection(context.message.id, body.expectedRevision);
  if (
    correction.status === 'REJECTED' &&
    context.message.reviewRevision === body.expectedRevision
  ) {
    const idempotent = await terminalDecisionResult(
      context,
      correction.id,
      body.expectedRevision,
      'REJECTED',
    );
    if (idempotent) return idempotent;
    throw reviewConflict();
  }
  if (correction.status !== 'PENDING') throw reviewConflict();

  try {
    return await prisma.$transaction(async (tx) => {
      await lockAndAssertReviewActor(tx, context);
      const now = new Date();
      const decided = await tx.messageCorrection.updateMany({
        where: {
          id: correction.id,
          messageId: context.message.id,
          revision: body.expectedRevision,
          status: 'PENDING',
        },
        data: {
          status: 'REJECTED',
          decisionReason: body.reason || null,
          decidedAt: now,
          decidedBySubjectId:
            context.participant.userId ?? context.participant.guestIdentityId,
          decidedByParticipantId: context.participant.id,
          deciderDisplayName: context.participant.displayName,
        },
      });
      if (decided.count !== 1) throw reviewConflict();
      const updated = await tx.translationMessage.updateMany({
        where: {
          id: context.message.id,
          reviewRevision: body.expectedRevision,
          reviewStatus: 'PENDING',
        },
        data: {
          pendingSourceText: null,
          pendingTranslatedText: null,
          reviewStatus: 'REJECTED',
          reviewedAt: now,
        },
      });
      if (updated.count !== 1) throw reviewConflict();
      const [message, savedCorrection] = await Promise.all([
        tx.translationMessage.findUniqueOrThrow({ where: { id: context.message.id } }),
        tx.messageCorrection.findUniqueOrThrow({ where: { id: correction.id } }),
      ]);
      return { message, correction: savedCorrection, idempotent: false };
    });
  } catch (error) {
    const raced = await terminalDecisionResult(
      context,
      correction.id,
      body.expectedRevision,
      'REJECTED',
    );
    if (raced) return raced;
    throw error;
  }
}

async function terminalDecisionResult(
  context: ReviewContext,
  correctionId: string,
  expectedRevision: number,
  expectedStatus: 'CONFIRMED' | 'REJECTED',
): Promise<ProposalResult | null> {
  return prisma.$transaction(async (tx) => {
    await lockAndAssertReviewActor(tx, context);
    const [message, correction] = await Promise.all([
      tx.translationMessage.findFirst({
        where: {
          id: context.message.id,
          conversationId: context.message.conversationId,
          reviewRevision: expectedRevision,
        },
      }),
      tx.messageCorrection.findFirst({
        where: {
          id: correctionId,
          conversationId: context.message.conversationId,
          messageId: context.message.id,
          revision: expectedRevision,
          status: expectedStatus,
        },
      }),
    ]);
    return message && correction
      ? { message, correction, idempotent: true }
      : null;
  });
}

async function currentCorrection(
  messageId: string,
  expectedRevision: number,
): Promise<MessageCorrection> {
  const correction = await prisma.messageCorrection.findUnique({
    where: {
      messageId_revision: { messageId, revision: expectedRevision },
    },
  });
  if (!correction) throw reviewConflict();
  return correction;
}

async function reviewGlossaryTerms(
  ownerId: string,
  sourceLanguage: 'zh' | 'ru',
  targetLanguage: 'zh' | 'ru',
  sourceText: string,
): Promise<TranslationTerm[]> {
  const rows = await prisma.glossaryTerm.findMany({
    where: {
      ownerId,
      sourceLanguage: { in: [sourceLanguage, 'en'] },
      targetLanguage,
      enabled: true,
    },
    orderBy: { sourceTerm: 'asc' },
    take: 500,
  });
  const normalized = sourceText.toLocaleLowerCase();
  const unique = new Map<string, TranslationTerm>();
  for (const row of rows) {
    const key = row.sourceTerm.toLocaleLowerCase();
    if (!normalized.includes(key) || unique.has(key)) continue;
    unique.set(key, { source: row.sourceTerm, target: row.targetTerm });
    if (unique.size === 100) break;
  }
  return [...unique.values()];
}

async function cleanupGeneratedAudio(
  request: FastifyRequest,
  storedValue: string,
): Promise<void> {
  try {
    await deleteTtsAsset(storedValue);
  } catch (cleanupError) {
    try {
      await enqueueAudioDeletionJobsNow([storedValue]);
    } catch (queueError) {
      request.log.error(
        { cleanupError, queueError },
        'Failed to clean uncommitted correction TTS audio',
      );
    }
  }
}

function emitReviewUpdate(
  message: TranslationMessage,
  correction: MessageCorrection,
): void {
  realtimeHub().emitToConversation(
    message.conversationId,
    'translation.review.updated',
    {
      ...messageDto(message),
      correction: correctionDto(correction),
    },
  );
}

function reviewResponse(result: ProposalResult) {
  return {
    ok: true,
    data: {
      message: messageDto(result.message),
      correction: correctionDto(result.correction),
      idempotent: result.idempotent,
    },
  };
}

function correctionDto(correction: MessageCorrection) {
  return {
    id: correction.id,
    messageId: correction.messageId,
    conversationId: correction.conversationId,
    revision: correction.revision,
    kind: correction.kind,
    status: correction.status,
    proposedSourceText: correction.proposedSourceText,
    proposedTranslatedText: correction.proposedTranslatedText,
    reason: correction.reason,
    actorParticipantId: correction.actorParticipantId,
    actorDisplayName: correction.actorDisplayName,
    actorCompany: correction.actorCompany,
    decisionReason: correction.decisionReason,
    decidedAt: correction.decidedAt,
    decidedByParticipantId: correction.decidedByParticipantId,
    deciderDisplayName: correction.deciderDisplayName,
    createdAt: correction.createdAt,
  };
}

export function correctionRequestHash(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function reviewRouteIds(value: unknown): {
  conversationId: string;
  messageId: string;
} {
  return z
    .object({ conversationId: z.string().min(1), messageId: z.string().min(1) })
    .parse(value);
}

function reviewConflict(): AppError {
  return conflict(
    'MESSAGE_REVIEW_CONFLICT',
    '纠错版本已变化，请刷新消息后重试',
  );
}
