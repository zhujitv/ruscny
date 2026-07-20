import { createHash } from 'node:crypto';
import type {
  ConversationSummary,
  Language,
  Participant,
  Prisma,
  SummaryEmailDistribution,
  SummaryEmailRecipient,
} from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import { prisma } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { getConversationForAuthInTransaction } from '../services/conversations.js';
import {
  EmailProviderError,
  sendTransactionalEmail,
} from '../services/email-provider.js';
import { renderSummaryEmail } from '../services/summary-email-template.js';
import { summaryIsStale } from '../services/summary-freshness.js';

const distributionBodySchema = z.object({
  participantIds: z.array(z.string().min(1)).min(1).max(100).optional(),
}).strict();

const emailSchema = z.string().trim().email().max(254);
const stuckClaimMs = 2 * 60 * 1_000;
const providerIdempotencySafetyMs = 23 * 60 * 60 * 1_000;
const defaultWorkerIntervalMs = 5_000;
const defaultWorkerBatchSize = 10;

interface SummaryEmailLogger {
  error(bindings: Record<string, unknown>, message: string): unknown;
}

interface SummaryEmailWorkerOptions {
  intervalMs?: number;
  batchSize?: number;
  logger?: SummaryEmailLogger;
}

export interface SummaryEmailWorker {
  wake(): void;
  stop(): Promise<void>;
}

let activeSummaryEmailWorker: SummaryEmailWorker | undefined;

const participantIdentityInclude = {
  user: { select: { email: true, status: true } },
  guestIdentity: { select: { email: true, revokedAt: true, expiresAt: true } },
} satisfies Prisma.ParticipantInclude;

const participantWithIdentity = {
  include: participantIdentityInclude,
  orderBy: { joinedAt: 'asc' as const },
} satisfies Prisma.ParticipantFindManyArgs;

type ParticipantWithIdentity = Prisma.ParticipantGetPayload<typeof participantWithIdentity>;

interface RecipientCandidate {
  participantId: string;
  displayName: string;
  company: string | null;
  preferredLanguage: Language;
  email: string | null;
  eligible: boolean;
  reason: string | null;
}

export async function registerSummaryEmailRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/conversations/:id/summary/email-recipients',
    { preHandler: requireRole('USER') },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const result = await prisma.$transaction(async (tx) => {
        const conversation = await getConversationForAuthInTransaction(
          tx,
          request.auth,
          id,
          { history: true },
        );
        assertSummaryDistributionAvailable(conversation);
        assertOwner(conversation.ownerId, request.auth.subjectId);
        const [summary, participants, sourceState] = await Promise.all([
          tx.conversationSummary.findUnique({ where: { conversationId: id } }),
          tx.participant.findMany({
            where: { conversationId: id },
            ...participantWithIdentity,
          }),
          tx.translationMessage.aggregate({
            where: { conversationId: id, status: 'FINAL' },
            _max: { sequence: true, updatedAt: true },
            _count: { _all: true },
          }),
        ]);
        if (!summary) throw notFound('SUMMARY_NOT_FOUND', '会议纪要尚未生成');
        return {
          summaryRevision: summary.revision,
          isStale: summaryIsStale(summary, sourceState),
          isApproved: summary.approvedRevision === summary.revision && summary.approvedAt !== null,
          items: participants.map((participant) =>
            recipientCandidateDto(recipientCandidate(participant))),
        };
      });
      return { ok: true, data: result };
    },
  );

  app.post(
    '/v1/conversations/:id/summary/email-distributions',
    {
      preHandler: requireRole('USER'),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = distributionBodySchema.parse(request.body ?? {});
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
        throw badRequest('IDEMPOTENCY_KEY_REQUIRED', '缺少有效的 Idempotency-Key');
      }

      let distributionId: string;
      try {
        distributionId = await prisma.$transaction(async (tx) => {
        const conversation = await getConversationForAuthInTransaction(
          tx,
          request.auth,
          id,
          { history: true },
        );
        assertSummaryDistributionAvailable(conversation);
        assertOwner(conversation.ownerId, request.auth.subjectId);
        if (conversation.status !== 'ENDED') {
          throw conflict('SUMMARY_EMAIL_REQUIRES_ENDED_CONVERSATION', '请先结束会议并生成最终会议纪要');
        }

        const existing = await tx.summaryEmailDistribution.findUnique({
          where: { conversationId_idempotencyKey: { conversationId: id, idempotencyKey } },
        });
        if (existing) {
          assertDistributionRequestMatches(existing, body.participantIds);
          return existing.id;
        }

        const [summary, participants, sourceState] = await Promise.all([
          tx.conversationSummary.findUnique({ where: { conversationId: id } }),
          tx.participant.findMany({
            where: { conversationId: id },
            ...participantWithIdentity,
          }),
          tx.translationMessage.aggregate({
            where: { conversationId: id, status: 'FINAL' },
            _max: { sequence: true, updatedAt: true },
            _count: { _all: true },
          }),
        ]);
        if (!summary) throw notFound('SUMMARY_NOT_FOUND', '会议纪要尚未生成');
        if (summaryIsStale(summary, sourceState)) {
          throw conflict('SUMMARY_STALE', '会议内容已变化，请重新生成会议纪要后再发送');
        }
        if (summary.approvedRevision !== summary.revision || !summary.approvedAt) {
          throw conflict('SUMMARY_APPROVAL_REQUIRED', '请先查看并确认当前会议纪要，再进行邮件分发');
        }

        const candidates = participants.map((participant) => recipientCandidate(participant));
        const requestedIds = body.participantIds
          ? [...new Set(body.participantIds)]
          : candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.participantId);
        const candidateById = new Map(candidates.map((candidate) => [candidate.participantId, candidate]));
        const selected = requestedIds.map((participantId) => {
          const candidate = candidateById.get(participantId);
          if (!candidate) {
            throw badRequest('SUMMARY_EMAIL_RECIPIENT_INVALID', '收件人不属于本会议');
          }
          if (!candidate.eligible || !candidate.email) {
            throw badRequest(
              candidate.reason ?? 'SUMMARY_EMAIL_RECIPIENT_INELIGIBLE',
              `${candidate.displayName} 没有可用的会议纪要邮件权限或邮箱`,
            );
          }
          return candidate as RecipientCandidate & { email: string };
        });
        if (!selected.length) {
          throw badRequest('SUMMARY_EMAIL_RECIPIENTS_REQUIRED', '没有可发送会议纪要的参会者');
        }
        const requestHash = distributionRequestHash(
          summary.id,
          summary.revision,
          selected.map((candidate) => candidate.participantId),
        );
        const created = await tx.summaryEmailDistribution.create({
          data: {
            conversationId: id,
            summaryId: summary.id,
            summaryRevision: summary.revision,
            requestedByUserId: request.auth.subjectId,
            idempotencyKey,
            requestHash,
            recipientCount: selected.length,
            recipients: {
              create: selected.map((candidate) => ({
                participantId: candidate.participantId,
                recipientEmail: candidate.email,
                recipientDisplayName: candidate.displayName,
                recipientCompany: candidate.company,
                recipientLanguage: candidate.preferredLanguage,
              })),
            },
          },
          select: { id: true },
        });
        return created.id;
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const existing = await prisma.summaryEmailDistribution.findUnique({
          where: {
            conversationId_idempotencyKey: {
              conversationId: id,
              idempotencyKey,
            },
          },
        });
        if (!existing) throw error;
        assertDistributionRequestMatches(existing, body.participantIds);
        distributionId = existing.id;
      }

      wakeSummaryEmailWorker();
      const distribution = await prisma.summaryEmailDistribution.findUniqueOrThrow({
        where: { id: distributionId },
        include: { recipients: { orderBy: { createdAt: 'asc' } } },
      });
      return { ok: true, data: { distribution: distributionDto(distribution) } };
    },
  );

  app.get(
    '/v1/conversations/:id/summary/email-distributions/:distributionId',
    { preHandler: requireRole('USER') },
    async (request) => {
      const { id, distributionId } = z.object({
        id: z.string(),
        distributionId: z.string(),
      }).parse(request.params);
      const distribution = await prisma.$transaction(async (tx) => {
        const conversation = await getConversationForAuthInTransaction(
          tx,
          request.auth,
          id,
          { history: true },
        );
        assertSummaryDistributionAvailable(conversation);
        assertOwner(conversation.ownerId, request.auth.subjectId);
        const found = await tx.summaryEmailDistribution.findFirst({
          where: { id: distributionId, conversationId: id },
          include: { recipients: { orderBy: { createdAt: 'asc' } } },
        });
        if (!found) {
          throw notFound('SUMMARY_EMAIL_DISTRIBUTION_NOT_FOUND', '邮件分发任务不存在');
        }
        return found;
      });
      return { ok: true, data: { distribution: distributionDto(distribution) } };
    },
  );
}

export function recipientCandidate(participant: ParticipantWithIdentity): RecipientCandidate {
  if (participant.removedAt) {
    return candidate(participant, null, false, 'PARTICIPANT_REMOVED');
  }
  if (participant.userId && participant.user?.status !== 'ACTIVE') {
    return candidate(participant, null, false, 'ACCOUNT_UNAVAILABLE');
  }
  if (participant.guestIdentityId) {
    if (!participant.guestIdentity || participant.guestIdentity.revokedAt) {
      return candidate(participant, null, false, 'GUEST_ACCESS_REVOKED');
    }
    if (participant.guestIdentity.expiresAt <= new Date()) {
      return candidate(participant, null, false, 'HISTORY_ACCESS_EXPIRED');
    }
  }
  const raw = participant.email ?? participant.user?.email ?? participant.guestIdentity?.email;
  const parsed = emailSchema.safeParse(raw?.trim().toLowerCase());
  if (!parsed.success) return candidate(participant, null, false, 'PARTICIPANT_EMAIL_MISSING');
  return candidate(participant, parsed.data, true, null);
}

function candidate(
  participant: Pick<Participant, 'id' | 'displayName' | 'company' | 'preferredLanguage'>,
  email: string | null,
  eligible: boolean,
  reason: string | null,
): RecipientCandidate {
  return {
    participantId: participant.id,
    displayName: participant.displayName,
    company: participant.company ?? null,
    preferredLanguage: participant.preferredLanguage,
    email,
    eligible,
    reason,
  };
}

function recipientCandidateDto(recipient: RecipientCandidate) {
  return {
    participantId: recipient.participantId,
    displayName: recipient.displayName,
    company: recipient.company,
    preferredLanguage: recipient.preferredLanguage,
    eligible: recipient.eligible,
    emailHint: maskEmail(recipient.email),
    reason: recipient.reason,
  };
}

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const separator = email.lastIndexOf('@');
  if (separator <= 0 || separator === email.length - 1) return null;
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const visibleLocal = local.length <= 2
    ? `${local[0]}***`
    : `${local[0]}***${local.at(-1)}`;
  return `${visibleLocal}@${domain}`;
}

export async function processSummaryEmailDistribution(
  distributionId: string,
): Promise<void> {
  const distribution = await prisma.summaryEmailDistribution.findUniqueOrThrow({
    where: { id: distributionId },
    include: { conversation: true, recipients: true },
  });
  if (distribution.status !== 'PROCESSING') return;

  const summary = await prisma.conversationSummary.findUnique({
    where: { id: distribution.summaryId },
  });
  if (!summary || summary.revision !== distribution.summaryRevision) {
    await prisma.summaryEmailRecipient.updateMany({
      where: { distributionId, status: { in: ['PENDING', 'SENDING'] } },
      data: {
        status: 'FAILED',
        errorCode: 'SUMMARY_REVISION_UNAVAILABLE',
        errorMessage: '会议纪要版本已变化，请重新发起分发',
      },
    });
    await finalizeDistribution(distributionId);
    return;
  }
  if (summary.approvedRevision !== summary.revision || !summary.approvedAt) {
    await prisma.summaryEmailRecipient.updateMany({
      where: { distributionId, status: { in: ['PENDING', 'SENDING'] } },
      data: {
        status: 'FAILED',
        errorCode: 'SUMMARY_APPROVAL_REQUIRED',
        errorMessage: '会议纪要尚未确认，未发送',
      },
    });
    await finalizeDistribution(distributionId);
    return;
  }
  if (await persistedSummaryIsStale(distribution.conversationId, summary)) {
    await prisma.summaryEmailRecipient.updateMany({
      where: { distributionId, status: { in: ['PENDING', 'SENDING'] } },
      data: {
        status: 'FAILED',
        errorCode: 'SUMMARY_STALE',
        errorMessage: '会议内容已变化，请重新生成会议纪要后再发送',
      },
    });
    await finalizeDistribution(distributionId);
    return;
  }
  const now = new Date();
  const unsafeRetryBefore = new Date(now.getTime() - providerIdempotencySafetyMs);
  await prisma.summaryEmailRecipient.updateMany({
    where: {
      distributionId,
      status: 'SENDING',
      claimedAt: { lt: unsafeRetryBefore },
    },
    data: {
      status: 'FAILED',
      errorCode: 'EMAIL_DELIVERY_UNKNOWN_RETRY_EXPIRED',
      errorMessage: '邮件发送结果无法确认且安全重试窗口已过，请勿自动重复发送',
    },
  });
  await prisma.summaryEmailRecipient.updateMany({
    where: {
      distributionId,
      status: 'SENDING',
      OR: [
        { claimedAt: null },
        {
          claimedAt: {
            gte: unsafeRetryBefore,
            lt: new Date(now.getTime() - stuckClaimMs),
          },
        },
      ],
    },
    data: { status: 'PENDING', claimedAt: null },
  });
  const pending = await prisma.summaryEmailRecipient.findMany({
    where: { distributionId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
  });
  await mapWithConcurrency(pending, 4, (recipient) =>
    sendRecipient(distribution, summary, recipient),
  );
  await finalizeDistribution(distributionId);
}

export async function processPendingSummaryEmailDistributions(
  batchSize = defaultWorkerBatchSize,
): Promise<number> {
  const distributions = await prisma.summaryEmailDistribution.findMany({
    where: { status: 'PROCESSING' },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
    select: { id: true },
  });
  await mapWithConcurrency(distributions, 2, ({ id }) =>
    processSummaryEmailDistribution(id),
  );
  return distributions.length;
}

export function startSummaryEmailWorker(
  options: SummaryEmailWorkerOptions = {},
): SummaryEmailWorker {
  const intervalMs = options.intervalMs ?? defaultWorkerIntervalMs;
  const batchSize = options.batchSize ?? defaultWorkerBatchSize;
  let stopped = false;
  let runAgain = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const schedule = (delay: number): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
    timer.unref();
  };
  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      runAgain = true;
      return running;
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    running = (async () => {
      do {
        runAgain = false;
        await processPendingSummaryEmailDistributions(batchSize);
      } while (runAgain && !stopped);
    })()
      .catch((error: unknown) => {
        options.logger?.error(
          { error: summaryEmailWorkerError(error) },
          'summary email worker failed',
        );
      })
      .finally(() => {
        running = undefined;
        if (!stopped) schedule(intervalMs);
      });
    return running;
  };
  const worker: SummaryEmailWorker = {
    wake() {
      if (stopped) return;
      if (running) {
        runAgain = true;
        return;
      }
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running;
      if (activeSummaryEmailWorker === worker) activeSummaryEmailWorker = undefined;
    },
  };
  activeSummaryEmailWorker = worker;
  worker.wake();
  return worker;
}

export function wakeSummaryEmailWorker(): void {
  activeSummaryEmailWorker?.wake();
}

function summaryEmailWorkerError(error: unknown): string {
  const value = error instanceof Error
    ? `${error.name}: ${error.message}`
    : 'Unknown summary email worker error';
  return value.slice(0, 1_000);
}

async function sendRecipient(
  distribution: SummaryEmailDistribution & { conversation: { title: string | null }; recipients: SummaryEmailRecipient[] },
  summary: ConversationSummary,
  recipient: SummaryEmailRecipient,
): Promise<void> {
  const claimedAt = new Date();
  const claimed = await prisma.summaryEmailRecipient.updateMany({
    where: { id: recipient.id, status: 'PENDING' },
    data: { status: 'SENDING', claimedAt, attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return;
  const currentParticipant = await prisma.participant.findFirst({
    where: {
      id: recipient.participantId,
      conversationId: distribution.conversationId,
    },
    include: participantIdentityInclude,
  });
  const currentCandidate = currentParticipant
    ? recipientCandidate(currentParticipant)
    : null;
  if (
    !currentCandidate?.eligible ||
    !currentCandidate.email ||
    currentCandidate.email !== recipient.recipientEmail
  ) {
    await prisma.summaryEmailRecipient.updateMany({
      where: { id: recipient.id, status: 'SENDING', claimedAt },
      data: {
        status: 'FAILED',
        errorCode: currentCandidate?.reason ?? 'PARTICIPANT_ACCESS_REVOKED',
        errorMessage: '参会者权限或邮箱已发生变化，未发送会议纪要',
      },
    });
    return;
  }
  if (!recipient.recipientEmail) {
    await prisma.summaryEmailRecipient.updateMany({
      where: { id: recipient.id, status: 'SENDING', claimedAt },
      data: {
        status: 'FAILED',
        errorCode: 'PARTICIPANT_EMAIL_MISSING',
        errorMessage: '参会者邮箱已不可用',
      },
    });
    return;
  }
  if (await persistedSummaryIsStale(distribution.conversationId, summary)) {
    await prisma.summaryEmailRecipient.updateMany({
      where: { id: recipient.id, status: 'SENDING', claimedAt },
      data: {
        status: 'FAILED',
        errorCode: 'SUMMARY_STALE',
        errorMessage: '会议内容已变化，未发送旧版会议纪要',
      },
    });
    return;
  }
  const currentSummary = await prisma.conversationSummary.findUnique({ where: { id: summary.id } });
  if (
    !currentSummary ||
    currentSummary.revision !== distribution.summaryRevision ||
    currentSummary.approvedRevision !== currentSummary.revision ||
    !currentSummary.approvedAt
  ) {
    await prisma.summaryEmailRecipient.updateMany({
      where: { id: recipient.id, status: 'SENDING', claimedAt },
      data: {
        status: 'FAILED',
        errorCode: 'SUMMARY_APPROVAL_REQUIRED',
        errorMessage: '会议纪要审批状态已变化，未发送',
      },
    });
    return;
  }
  const email = renderSummaryEmail({
    meetingTitle: distribution.conversation.title ?? 'RUSCNY Meeting',
    recipientDisplayName: recipient.recipientDisplayName,
    recipientLanguage: recipient.recipientLanguage,
    summary,
  });
  try {
    const result = await sendTransactionalEmail({
      to: recipient.recipientEmail,
      ...email,
      idempotencyKey: `summary/${distribution.id}/${recipient.id}/r${distribution.summaryRevision}`,
    });
    await prisma.summaryEmailRecipient.updateMany({
      where: { id: recipient.id, status: 'SENDING', claimedAt },
      data: {
        status: 'SENT',
        providerMessageId: result.providerMessageId,
        sentAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });
  } catch (error) {
    const known = error instanceof EmailProviderError;
    await prisma.summaryEmailRecipient.updateMany({
      where: { id: recipient.id, status: 'SENDING', claimedAt },
      data: {
        status: 'FAILED',
        errorCode: known ? error.code : 'EMAIL_SEND_FAILED',
        errorMessage: known ? error.message : '邮件发送失败，请稍后重试',
      },
    });
  }
}

async function finalizeDistribution(distributionId: string): Promise<void> {
  const recipients = await prisma.summaryEmailRecipient.findMany({
    where: { distributionId },
    select: { status: true },
  });
  const sentCount = recipients.filter((item) => item.status === 'SENT').length;
  const failedCount = recipients.filter((item) => item.status === 'FAILED').length;
  const processing = recipients.some((item) => item.status === 'PENDING' || item.status === 'SENDING');
  if (processing) return;
  const status = failedCount === 0
    ? 'COMPLETED'
    : sentCount === 0
      ? 'FAILED'
      : 'PARTIAL_FAILURE';
  await prisma.summaryEmailDistribution.update({
    where: { id: distributionId },
    data: { status, sentCount, failedCount, completedAt: new Date() },
  });
}

function distributionRequestHash(
  summaryId: string,
  summaryRevision: number,
  participantIds: string[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      summaryId,
      summaryRevision,
      participantIds: [...new Set(participantIds)].sort(),
    }))
    .digest('hex');
}

async function persistedSummaryIsStale(
  conversationId: string,
  summary: Pick<
    ConversationSummary,
    'sourceMaxSequence' | 'sourceMessageCount' | 'sourceLatestMessageUpdatedAt'
  >,
): Promise<boolean> {
  const sourceState = await prisma.translationMessage.aggregate({
    where: { conversationId, status: 'FINAL' },
    _max: { sequence: true, updatedAt: true },
    _count: { _all: true },
  });
  return summaryIsStale(summary, sourceState);
}

function assertDistributionRequestMatches(
  distribution: Pick<
    SummaryEmailDistribution,
    'summaryId' | 'summaryRevision' | 'requestHash'
  >,
  participantIds: string[] | undefined,
): void {
  if (!participantIds) return;
  const requestHash = distributionRequestHash(
    distribution.summaryId,
    distribution.summaryRevision,
    participantIds,
  );
  if (requestHash !== distribution.requestHash) {
    throw conflict(
      'IDEMPOTENCY_KEY_REUSED',
      '同一 Idempotency-Key 不能用于不同的纪要分发请求',
    );
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'P2002',
  );
}

function assertOwner(ownerId: string, subjectId: string): void {
  if (ownerId !== subjectId) throw forbidden('HOST_ONLY', '只有本会议主持人可以分发会议纪要');
}

function assertSummaryDistributionAvailable(
  conversation: { kind: 'MEETING' | 'DIRECT' },
): void {
  if (conversation.kind === 'DIRECT') {
    throw forbidden(
      'DIRECT_CHAT_DOCUMENTS_UNAVAILABLE',
      '好友私聊不支持 AI 整理或纪要分发',
    );
  }
}

type DistributionWithRecipients = SummaryEmailDistribution & {
  recipients: SummaryEmailRecipient[];
};

function distributionDto(distribution: DistributionWithRecipients) {
  return {
    id: distribution.id,
    conversationId: distribution.conversationId,
    summaryRevision: distribution.summaryRevision,
    status: distribution.status,
    recipientCount: distribution.recipientCount,
    sentCount: distribution.sentCount,
    failedCount: distribution.failedCount,
    createdAt: distribution.createdAt,
    completedAt: distribution.completedAt,
    recipients: distribution.recipients.map((recipient) => ({
      participantId: recipient.participantId,
      displayName: recipient.recipientDisplayName,
      company: recipient.recipientCompany,
      emailHint: maskEmail(recipient.recipientEmail),
      preferredLanguage: recipient.recipientLanguage,
      status: recipient.status,
      errorCode: recipient.errorCode,
      errorMessage: recipient.errorMessage,
      sentAt: recipient.sentAt,
    })),
  };
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]!);
    }
  }));
}
