import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma, type Participant, type ParticipantRole, type TranslationMessage } from '@prisma/client';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../errors.js';
import { randomToken } from '../lib/crypto.js';
import type { AuthContext } from '../lib/tokens.js';
import {
  assertLanguagePair,
  translationProvider,
  type TranslationTerm,
} from '../providers/translation.js';
import { realtimeHub } from '../realtime-hub.js';
import {
  getConversationForAuth,
  getParticipant,
  messageDto,
} from '../services/conversations.js';
import { PROCESSING_LEASE_MS } from '../services/message-processing.js';
import {
  TTS_PENDING_CODE,
  wakeTtsGenerationWorker,
} from '../services/tts-generation.js';

type SpeechLanguage = 'zh' | 'ru';

export { PROCESSING_LEASE_MS };

export async function registerMessageRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/conversations/:id/audio',
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const idempotencyKey = headerValue(request, 'idempotency-key');
      if (!idempotencyKey || idempotencyKey.length > 200) {
        throw badRequest('IDEMPOTENCY_KEY_REQUIRED', '缺少有效的 Idempotency-Key');
      }
      const upload = await readAudioUpload(request);
      const sourceLanguage = upload.fields.sourceLanguage;
      const targetLanguage = upload.fields.targetLanguage;
      const pair = parsePair(sourceLanguage, targetLanguage);
      validateMimeType(upload.mimeType, upload.filename);
      const message = await processMessage({
        request,
        conversationId: id,
        idempotencyKey,
        sourceLanguage: pair.sourceLanguage,
        targetLanguage: pair.targetLanguage,
        audio: upload.audio,
        mimeType: normalizeMimeType(upload.mimeType, upload.filename),
        mockHint: upload.fields.mockSourceText,
      });
      return { ok: true, data: messageDto(message) };
    },
  );

  app.post(
    '/v1/conversations/:id/messages/text',
    { preHandler: authenticate },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = z
        .object({
          sourceText: z.string().trim().min(1).max(5_000),
          sourceLanguage: z.enum(['zh', 'ru']),
          targetLanguage: z.enum(['zh', 'ru']).optional(),
          idempotencyKey: z.string().min(8).max(200).optional(),
        })
        .parse(request.body);
      const targetLanguage = body.targetLanguage ?? (body.sourceLanguage === 'zh' ? 'ru' : 'zh');
      const pair = parsePair(body.sourceLanguage, targetLanguage);
      const message = await processMessage({
        request,
        conversationId: id,
        idempotencyKey:
          headerValue(request, 'idempotency-key') ?? body.idempotencyKey ?? randomToken(16),
        sourceLanguage: pair.sourceLanguage,
        targetLanguage: pair.targetLanguage,
        sourceText: body.sourceText,
      });
      return { ok: true, data: messageDto(message) };
    },
  );
}

export interface ProcessInput {
  request: FastifyRequest;
  conversationId: string;
  idempotencyKey: string;
  sourceLanguage: SpeechLanguage;
  targetLanguage: SpeechLanguage;
  sourceText?: string;
  audio?: Buffer;
  mimeType?: string;
  mockHint?: string;
}

async function processMessage(input: ProcessInput) {
  const conversation = await getConversationForAuth(input.request.auth, input.conversationId, {
    history: true,
  });
  if (
    conversation.expiresAt <= new Date() ||
    (conversation.status !== 'WAITING' && conversation.status !== 'ACTIVE')
  ) {
    throw forbidden('ROOM_NOT_ACTIVE', '会议已结束或过期');
  }
  const participant = await getParticipant(input.request.auth, input.conversationId);
  assertParticipantCanSpeak(conversation.status, participant.role, conversation.expiresAt);
  if (participant.preferredLanguage !== input.sourceLanguage) {
    throw forbidden(
      'PARTICIPANT_LANGUAGE_MISMATCH',
      '发言语言与本次会议的参会语言不一致，请先更新参会信息',
    );
  }
  const attempt = await acquireProcessingAttempt(input, participant);
  if (!attempt.acquired) return attempt.message;
  let processing = attempt.message;

  realtimeHub().emitToConversation(input.conversationId, 'translation.processing', {
    ...messageDto(processing),
    sourceText: undefined,
    translatedText: undefined,
  });

  let recognizedSourceText = input.sourceText;
  try {
    const transcription = input.sourceText
      ? { text: input.sourceText, provider: 'text-input', requestId: undefined }
      : await translationProvider.transcribe({
          audio: input.audio!,
          mimeType: input.mimeType!,
          language: input.sourceLanguage,
          ...(input.mockHint ? { mockHint: input.mockHint } : {}),
        });
    recognizedSourceText = transcription.text;
    if (!input.sourceText) {
      const recognized = await persistRecognizedSourceText(
        processing,
        transcription.text,
        input.request.auth,
        input.conversationId,
      );
      processing = recognized.message;
      // A leave/removal/end operation may have terminalized this attempt while
      // ASR was running. Do not call MT/TTS for a lease we no longer own.
      if (!recognized.committed) return recognized.message;
    }
    const terms = await glossaryTerms(
      conversation.ownerId,
      input.sourceLanguage,
      input.targetLanguage,
      transcription.text,
    );
    const translation = await translationProvider.translate({
      text: transcription.text,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      terms,
    });
    const finalResult = await commitFinalMessage({
      processing,
      conversationId: input.conversationId,
      sourceText: transcription.text,
      translatedText: translation.text,
      audioUrl: null,
      provider: translation.provider,
      providerRequestId: translation.requestId ?? transcription.requestId,
      errorCode: TTS_PENDING_CODE,
      errorMessage: null,
      auth: input.request.auth,
    });
    if (!finalResult.committed) {
      return finalResult.message;
    }
    const finalMessage = finalResult.message;
    realtimeHub().emitToConversation(input.conversationId, 'translation.final', messageDto(finalMessage));
    wakeTtsGenerationWorker();
    return finalMessage;
  } catch (error) {
    const failedResult = await failMessageAttempt(
      processing,
      providerError(error),
      input.request.auth,
      input.conversationId,
      recognizedSourceText,
    );
    if (!failedResult.committed) return failedResult.message;
    const failed = failedResult.message;
    if (
      failedResult.authorizationValid &&
      shouldBroadcastTranslationFailure(failedResult.error)
    ) {
      realtimeHub().emitToConversation(input.conversationId, 'translation.failed', {
        ...messageDto(failed),
        retryable: ['PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED', 'ASR_FAILED', 'MT_FAILED'].includes(
          failedResult.error.code,
        ),
      });
    }
    throw failedResult.error;
  }
}

interface ProcessingAttempt {
  message: TranslationMessage;
  acquired: boolean;
}

export async function acquireProcessingAttempt(
  input: ProcessInput,
  participant: Pick<
    Participant,
    'id' | 'role' | 'displayName' | 'company' | 'preferredLanguage'
  >,
): Promise<ProcessingAttempt> {
  const requestHash = messageRequestHash(input);
  const uniqueWhere = {
    conversationId_participantId_idempotencyKey: {
      conversationId: input.conversationId,
      participantId: participant.id,
      idempotencyKey: input.idempotencyKey,
    },
  };
  const prior = await prisma.translationMessage.findUnique({ where: uniqueWhere });
  if (prior) {
    assertSameIdempotentRequest(prior, input, requestHash);
    return claimExistingMessage(prior, input);
  }

  try {
    const processing = await prisma.$transaction(async (tx) => {
      // authenticate() ran before request parsing, but a session can be
      // revoked while the upload body is being received. Revalidate the
      // server-owned identity under the same lock order used by FINAL before
      // allocating a sequence or sending audio/text to an external provider.
      const lockedParticipant = await assertMessageAuthorizationLocked(
        tx,
        input.conversationId,
        participant.id,
        input.request.auth,
      );
      const advanced = await tx.conversation.updateMany({
        where: {
          id: input.conversationId,
          status: lockedParticipant.role === 'HOST'
            ? { in: ['WAITING', 'ACTIVE'] }
            : 'ACTIVE',
          expiresAt: { gt: new Date() },
        },
        data: { maxSequence: { increment: 1 } },
      });
      if (advanced.count !== 1) {
        throw forbidden('ROOM_NOT_ACTIVE', '会议已结束或过期');
      }
      if (lockedParticipant.preferredLanguage !== input.sourceLanguage) {
        throw forbidden(
          'PARTICIPANT_LANGUAGE_MISMATCH',
          '发言语言与本次会议的参会语言不一致，请先更新参会信息',
        );
      }
      const current = await tx.conversation.findUniqueOrThrow({
        where: { id: input.conversationId },
        select: { maxSequence: true },
      });
      return tx.translationMessage.create({
        data: {
          conversationId: input.conversationId,
          participantId: participant.id,
          speakerRole: lockedParticipant.role === 'HOST' ? 'HOST' : 'GUEST',
          speakerDisplayName: lockedParticipant.displayName,
          speakerCompany: lockedParticipant.company,
          speakerLanguage: lockedParticipant.preferredLanguage,
          sourceLanguage: input.sourceLanguage,
          targetLanguage: input.targetLanguage,
          // Typed input is already authoritative source content. Persist it
          // while PROCESSING so a later provider failure cannot erase it.
          sourceText: input.sourceText ?? '',
          sequence: current.maxSequence,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        },
      });
    });
    return { message: processing, acquired: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await prisma.translationMessage.findUnique({ where: uniqueWhere });
      if (raced) {
        assertSameIdempotentRequest(raced, input, requestHash);
        return claimExistingMessage(raced, input);
      }
    }
    throw error;
  }
}

function messageRequestHash(input: ProcessInput): string {
  const hash = createHash('sha256');
  hash.update(input.sourceLanguage);
  hash.update('\0');
  hash.update(input.targetLanguage);
  hash.update('\0');
  if (input.sourceText !== undefined) {
    hash.update('text\0');
    hash.update(input.sourceText, 'utf8');
  } else {
    hash.update('audio\0');
    hash.update(input.mimeType ?? '');
    hash.update('\0');
    hash.update(input.mockHint ?? '', 'utf8');
    hash.update('\0');
    hash.update(input.audio ?? Buffer.alloc(0));
  }
  return hash.digest('hex');
}

function assertSameIdempotentRequest(
  message: TranslationMessage,
  input: ProcessInput,
  requestHash: string,
): void {
  const differs = message.requestHash
    ? message.requestHash !== requestHash
    : message.sourceLanguage !== input.sourceLanguage ||
      message.targetLanguage !== input.targetLanguage;
  if (differs) {
    throw conflict(
      'IDEMPOTENCY_KEY_REUSED',
      '同一 Idempotency-Key 不能用于不同的消息内容',
    );
  }
}

async function claimExistingMessage(
  message: TranslationMessage,
  input: ProcessInput,
): Promise<ProcessingAttempt> {
  if (!shouldClaimMessage(message)) return { message, acquired: false };

  const claimedAt = new Date();
  const claimed = await prisma.$transaction(async (tx) => {
    // Revalidate the entire account/device/guest and membership chain before
    // a stale retry can restart provider work.
    await assertMessageAuthorizationLocked(
      tx,
      message.conversationId,
      message.participantId,
      input.request.auth,
    );
    const result = await tx.translationMessage.updateMany({
      where: {
        id: message.id,
        status: message.status,
        updatedAt: message.updatedAt,
      },
      data: {
        status: 'PROCESSING',
        // Retain known source on retry: typed input comes from this request;
        // audio may already have a prior attempt's persisted ASR result.
        sourceText: input.sourceText ?? message.sourceText,
        translatedText: '',
        audioUrl: null,
        provider: null,
        providerRequestId: null,
        errorCode: null,
        errorMessage: null,
        startedAtMs: null,
        endedAtMs: null,
        updatedAt: claimedAt,
      },
    });
    if (result.count !== 1) return null;
    return tx.translationMessage.findUniqueOrThrow({ where: { id: message.id } });
  });
  if (claimed) return { message: claimed, acquired: true };

  const current = await prisma.translationMessage.findUnique({ where: { id: message.id } });
  if (!current) throw conflict('MESSAGE_ATTEMPT_LOST', '消息处理状态已变更');
  return { message: current, acquired: false };
}

export function shouldClaimMessage(
  message: Pick<TranslationMessage, 'status' | 'updatedAt'>,
  now = new Date(),
  leaseMs = PROCESSING_LEASE_MS,
): boolean {
  if (message.status === 'FAILED') return true;
  return (
    message.status === 'PROCESSING' &&
    message.updatedAt.getTime() <= now.getTime() - leaseMs
  );
}

interface FinalMessageInput {
  processing: TranslationMessage;
  conversationId: string;
  sourceText: string;
  translatedText: string;
  audioUrl: string | null;
  provider: string;
  providerRequestId?: string;
  errorCode: string | null;
  errorMessage: string | null;
  auth: AuthContext;
}

interface AttemptCommit {
  message: TranslationMessage;
  committed: boolean;
}

export async function commitFinalMessage(input: FinalMessageInput): Promise<AttemptCommit> {
  return prisma.$transaction(async (tx) => {
    // SELECT FOR UPDATE serializes this commit with the /end transaction. If
    // /end commits first we refuse FINAL; if this commits first, /end waits and
    // the persisted FINAL necessarily predates the ended Conversation state.
    await assertMessageAuthorizationLocked(
      tx,
      input.conversationId,
      input.processing.participantId,
      input.auth,
    );
    const result = await tx.translationMessage.updateMany({
      where: {
        id: input.processing.id,
        status: 'PROCESSING',
        updatedAt: input.processing.updatedAt,
      },
      data: {
        status: 'FINAL',
        sourceText: input.sourceText,
        translatedText: input.translatedText,
        audioUrl: input.audioUrl,
        provider: input.provider,
        providerRequestId: input.providerRequestId,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        updatedAt: new Date(),
      },
    });
    const current = await tx.translationMessage.findUnique({
      where: { id: input.processing.id },
    });
    if (!current) throw conflict('MESSAGE_ATTEMPT_LOST', '消息处理状态已变更');
    return { message: current, committed: result.count === 1 };
  });
}

/**
 * Saves an ASR result under the current processing lease before MT/TTS runs.
 * A failed translation therefore still has its known original utterance, and
 * a stale worker cannot overwrite a newer retry generation.
 */
export async function persistRecognizedSourceText(
  processing: TranslationMessage,
  sourceText: string,
  auth: AuthContext,
  conversationId: string,
): Promise<AttemptCommit> {
  return prisma.$transaction(async (tx) => {
    // ASR itself is an external call. Do not persist its result if a revoke,
    // leave, removal or room end won while recognition was in flight.
    await assertMessageAuthorizationLocked(
      tx,
      conversationId,
      processing.participantId,
      auth,
    );
    const result = await tx.translationMessage.updateMany({
      where: {
        id: processing.id,
        status: 'PROCESSING',
        updatedAt: processing.updatedAt,
      },
      data: { sourceText, updatedAt: new Date() },
    });
    const current = await tx.translationMessage.findUnique({ where: { id: processing.id } });
    if (!current) throw conflict('MESSAGE_ATTEMPT_LOST', '消息处理状态已变更');
    return { message: current, committed: result.count === 1 };
  });
}

interface FailedAttemptCommit extends AttemptCommit {
  error: AppError;
  authorizationValid: boolean;
}

export async function failMessageAttempt(
  processing: TranslationMessage,
  error: AppError,
  auth: AuthContext,
  conversationId: string,
  knownSourceText?: string,
): Promise<FailedAttemptCommit> {
  return prisma.$transaction(async (tx) => {
    let effectiveError = error;
    let authorizationValid = true;
    try {
      // Provider failures race the same revoke/end operations as successful
      // results. Revalidate under locks before writing or broadcasting any
      // terminal state; lifecycle failures win and are never broadcast.
      await assertMessageAuthorizationLocked(
        tx,
        conversationId,
        processing.participantId,
        auth,
      );
    } catch (authorizationError) {
      if (!(authorizationError instanceof AppError)) throw authorizationError;
      effectiveError = authorizationError;
      authorizationValid = false;
    }
    const result = await tx.translationMessage.updateMany({
      where: {
        id: processing.id,
        status: 'PROCESSING',
        updatedAt: processing.updatedAt,
      },
      data: {
        status: 'FAILED',
        errorCode: effectiveError.code,
        errorMessage: effectiveError.message,
        ...(knownSourceText !== undefined ? { sourceText: knownSourceText } : {}),
        updatedAt: new Date(),
      },
    });
    const current = await tx.translationMessage.findUnique({ where: { id: processing.id } });
    if (!current) throw conflict('MESSAGE_ATTEMPT_LOST', '消息处理状态已变更');
    return {
      message: current,
      committed: result.count === 1,
      error: effectiveError,
      authorizationValid,
    };
  });
}

interface LockedConversation {
  status: string;
  expiresAt: Date;
}

function isSpeechOpen(status: string, role: ParticipantRole): boolean {
  return status === 'ACTIVE' || (status === 'WAITING' && role === 'HOST');
}

export function assertParticipantCanSpeak(
  status: string,
  role: ParticipantRole,
  expiresAt: Date,
  now = new Date(),
): void {
  if (expiresAt <= now || !isSpeechOpen(status, role)) {
    throw forbidden(
      'ROOM_NOT_ACTIVE',
      status === 'WAITING'
        ? '会议等待参会者加入时只有主持人可以先发言'
        : '会议已结束或过期',
    );
  }
}

export async function lockConversationForSpeech(
  tx: Prisma.TransactionClient,
  conversationId: string,
): Promise<LockedConversation | undefined> {
  const rows = await tx.$queryRaw<LockedConversation[]>`
    SELECT "status", "expiresAt"
    FROM "Conversation"
    WHERE "id" = ${conversationId}
    FOR UPDATE
  `;
  return rows[0];
}

export async function assertConversationActiveLocked(
  tx: Prisma.TransactionClient,
  conversationId: string,
  now?: Date,
): Promise<void> {
  const conversation = await lockConversationForSpeech(tx, conversationId);
  if (
    !conversation ||
    conversation.status !== 'ACTIVE' ||
    conversation.expiresAt <= (now ?? new Date())
  ) {
    throw forbidden('ROOM_NOT_ACTIVE', '会议已结束或过期');
  }
}

interface LockedParticipant {
  removedAt: Date | null;
  leftAt: Date | null;
  presence: string;
  role: 'HOST' | 'GUEST';
  displayName: string;
  company: string | null;
  preferredLanguage: SpeechLanguage;
  userId?: string | null;
  guestIdentityId?: string | null;
}

export async function assertParticipantActiveLocked(
  tx: Prisma.TransactionClient,
  conversationId: string,
  participantId: string,
): Promise<LockedParticipant> {
  const rows = await tx.$queryRaw<LockedParticipant[]>`
    SELECT "removedAt", "leftAt", "presence", "role", "displayName", "company", "preferredLanguage"
    FROM "Participant"
    WHERE "id" = ${participantId} AND "conversationId" = ${conversationId}
    FOR UPDATE
  `;
  if (!rows[0] || rows[0].removedAt || rows[0].presence === 'REMOVED') {
    throw forbidden('PARTICIPANT_REMOVED', '参会者已被移出会议');
  }
  if (rows[0].leftAt || rows[0].presence === 'LEFT') {
    throw forbidden('PARTICIPANT_INACTIVE', '参会者已离开会议');
  }
  return rows[0];
}

interface LockedUserAuthorization {
  id: string;
  status: string;
}

interface LockedDeviceAuthorization {
  sessionId: string;
  revokedAt: Date | null;
}

interface LockedGuestAuthorization {
  id: string;
  sessionId: string;
  deviceId: string;
  conversationId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Revalidates speech authorization at each post-provider write boundary. Lock order is
 * Conversation -> User -> UserDevice -> Participant for registered users and
 * Conversation -> GuestIdentity -> Participant for guests, matching existing
 * session/account lifecycle transactions and avoiding lock-order inversions.
 */
export async function assertMessageAuthorizationLocked(
  tx: Prisma.TransactionClient,
  conversationId: string,
  participantId: string,
  auth: AuthContext,
  now = new Date(),
): Promise<LockedParticipant> {
  const conversation = await lockConversationForSpeech(tx, conversationId);
  if (!conversation || conversation.expiresAt <= now) {
    throw forbidden('ROOM_NOT_ACTIVE', '会议已结束或过期');
  }

  if (auth.role === 'GUEST') {
    const guestIdentityId = auth.guestIdentityId ?? auth.subjectId;
    const identities = await tx.$queryRaw<LockedGuestAuthorization[]>`
      SELECT "id", "sessionId", "deviceId", "conversationId", "expiresAt", "revokedAt"
      FROM "GuestIdentity"
      WHERE "id" = ${guestIdentityId}
      FOR UPDATE
    `;
    const identity = identities[0];
    if (
      !identity ||
      identity.revokedAt ||
      identity.expiresAt <= now ||
      identity.conversationId !== conversationId ||
      identity.deviceId !== auth.deviceId ||
      !auth.sessionId ||
      identity.sessionId !== auth.sessionId
    ) {
      throw unauthorized('GUEST_TOKEN_REVOKED', '访客身份已失效');
    }
    const participant = await lockParticipant(tx, conversationId, participantId);
    assertParticipantActive(participant);
    if (participant.guestIdentityId !== guestIdentityId || participant.userId) {
      throw forbidden('NOT_A_PARTICIPANT', '您不是该会议参与者');
    }
    assertParticipantCanSpeak(
      conversation.status,
      participant.role,
      conversation.expiresAt,
      now,
    );
    return participant;
  }

  const users = await tx.$queryRaw<LockedUserAuthorization[]>`
    SELECT "id", "status"
    FROM "User"
    WHERE "id" = ${auth.subjectId}
    FOR UPDATE
  `;
  if (!users[0] || users[0].status !== 'ACTIVE') {
    throw unauthorized('ACCOUNT_DISABLED', '账号不存在或已停用');
  }
  const devices = await tx.$queryRaw<LockedDeviceAuthorization[]>`
    SELECT "sessionId", "revokedAt"
    FROM "UserDevice"
    WHERE "userId" = ${auth.subjectId} AND "deviceId" = ${auth.deviceId}
    FOR UPDATE
  `;
  const device = devices[0];
  if (
    !device ||
    device.revokedAt ||
    !auth.sessionId ||
    device.sessionId !== auth.sessionId
  ) {
    throw unauthorized('DEVICE_REVOKED', '此设备登录已被撤销');
  }
  const participant = await lockParticipant(tx, conversationId, participantId);
  assertParticipantActive(participant);
  if (participant.userId !== auth.subjectId || participant.guestIdentityId) {
    throw forbidden('NOT_A_PARTICIPANT', '您不是该会议参与者');
  }
  assertParticipantCanSpeak(
    conversation.status,
    participant.role,
    conversation.expiresAt,
    now,
  );
  return participant;
}

async function lockParticipant(
  tx: Prisma.TransactionClient,
  conversationId: string,
  participantId: string,
): Promise<LockedParticipant | undefined> {
  const rows = await tx.$queryRaw<LockedParticipant[]>`
    SELECT "removedAt", "leftAt", "presence", "role", "displayName", "company",
           "preferredLanguage", "userId", "guestIdentityId"
    FROM "Participant"
    WHERE "id" = ${participantId} AND "conversationId" = ${conversationId}
    FOR UPDATE
  `;
  return rows[0];
}

function assertParticipantActive(
  participant: LockedParticipant | undefined,
): asserts participant is LockedParticipant {
  if (!participant || participant.removedAt || participant.presence === 'REMOVED') {
    throw forbidden('PARTICIPANT_REMOVED', '参会者已被移出会议');
  }
  if (participant.leftAt || participant.presence === 'LEFT') {
    throw forbidden('PARTICIPANT_INACTIVE', '参会者已离开会议');
  }
}

const NON_BROADCAST_FAILURE_CODES = new Set([
  'ACCOUNT_DISABLED',
  'DEVICE_REVOKED',
  'GUEST_TOKEN_REVOKED',
  'NOT_A_PARTICIPANT',
  'PARTICIPANT_REMOVED',
  'PARTICIPANT_INACTIVE',
  'ROOM_NOT_ACTIVE',
]);

export function shouldBroadcastTranslationFailure(error: AppError): boolean {
  return !NON_BROADCAST_FAILURE_CODES.has(error.code);
}

async function glossaryTerms(
  ownerId: string,
  sourceLanguage: SpeechLanguage,
  targetLanguage: SpeechLanguage,
  sourceText: string,
): Promise<TranslationTerm[]> {
  const [privateRows, systemRows] = await Promise.all([
    prisma.glossaryTerm.findMany({
      where: { ownerId, sourceLanguage: { in: [sourceLanguage, 'en'] }, targetLanguage, enabled: true },
      orderBy: { sourceTerm: 'asc' }, take: 500,
    }),
    prisma.systemGlossaryTerm.findMany({
      where: { sourceLanguage: { in: [sourceLanguage, 'en'] }, targetLanguage, enabled: true },
      orderBy: { sourceTerm: 'asc' }, take: 500,
    }),
  ]);
  // Private owner terms override global operational terminology.
  const rows = [...privateRows, ...systemRows];
  const normalized = sourceText.toLocaleLowerCase();
  const matched = rows
    .filter((row) => normalized.includes(row.sourceTerm.toLocaleLowerCase()))
    .sort((left, right) =>
      Number(right.sourceLanguage === sourceLanguage) -
      Number(left.sourceLanguage === sourceLanguage));
  const unique = new Map<string, TranslationTerm>();
  for (const row of matched) {
    const key = row.sourceTerm.toLocaleLowerCase();
    if (!unique.has(key)) {
      unique.set(key, { source: row.sourceTerm, target: row.targetTerm });
    }
    if (unique.size === 100) break;
  }
  return [...unique.values()];
}

function parsePair(source: unknown, target: unknown) {
  const parsed = z
    .object({ sourceLanguage: z.enum(['zh', 'ru']), targetLanguage: z.enum(['zh', 'ru']) })
    .parse({ sourceLanguage: source, targetLanguage: target });
  assertLanguagePair(parsed.sourceLanguage, parsed.targetLanguage);
  return parsed;
}

function providerError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError(502, 'PROVIDER_FAILED', '语音翻译处理失败');
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value?.toString();
}

interface AudioUpload {
  audio: Buffer;
  filename: string;
  mimeType: string;
  fields: Record<string, string>;
}

async function readAudioUpload(request: FastifyRequest): Promise<AudioUpload> {
  let audio: Buffer | undefined;
  let filename = '';
  let mimeType = '';
  const fields: Record<string, string> = {};

  for await (const part of request.parts({
    limits: { fileSize: config.UPLOAD_MAX_BYTES, files: 1, fields: 10 },
  })) {
    if (part.type === 'file') {
      if (part.fieldname !== 'audio') {
        part.file.resume();
        throw badRequest('INVALID_AUDIO', '录音文件字段必须为 audio');
      }
      if (audio) {
        part.file.resume();
        throw badRequest('INVALID_AUDIO', '一次只能上传一个录音文件');
      }
      filename = part.filename;
      mimeType = part.mimetype;
      audio = await part.toBuffer();
      if (part.file.truncated || audio.length === 0 || audio.length > config.UPLOAD_MAX_BYTES) {
        throw badRequest('INVALID_AUDIO', '录音为空或超过大小限制');
      }
    } else {
      fields[part.fieldname] = String(part.value ?? '');
    }
  }

  if (!audio) throw badRequest('INVALID_AUDIO', '缺少录音文件');
  return { audio, filename, mimeType, fields };
}

export function validateMimeType(mimeType: string, filename: string): void {
  const baseMimeType = mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  const allowed = new Set([
    'audio/aac',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/mpeg',
    'audio/ogg',
    'audio/opus',
    'audio/webm',
    'audio/wav',
    'audio/x-wav',
    'application/octet-stream',
  ]);
  if (!allowed.has(baseMimeType) || !/\.(aac|m4a|mp3|ogg|opus|wav|webm)$/i.test(filename)) {
    throw badRequest('INVALID_AUDIO', '不支持的录音格式');
  }
}

export function normalizeMimeType(mimeType: string, filename: string): string {
  const baseMimeType = mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  if (baseMimeType !== 'application/octet-stream') return baseMimeType;
  if (/\.m4a$/i.test(filename)) return 'audio/mp4';
  if (/\.mp3$/i.test(filename)) return 'audio/mpeg';
  if (/\.ogg$/i.test(filename)) return 'audio/ogg';
  if (/\.opus$/i.test(filename)) return 'audio/opus';
  if (/\.webm$/i.test(filename)) return 'audio/webm';
  if (/\.wav$/i.test(filename)) return 'audio/wav';
  return 'audio/aac';
}
