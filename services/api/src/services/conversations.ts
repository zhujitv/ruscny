import type {
  Conversation,
  Participant,
  Prisma,
  TranslationMessage,
} from '@prisma/client';
import { prisma } from '../db.js';
import { forbidden, notFound, unauthorized } from '../errors.js';
import { stableHash } from '../lib/crypto.js';
import type { AuthContext } from '../lib/tokens.js';
import { conversationScopeMatches, guestHistoryAllowed } from '../policies.js';
import { playableAudioUrl } from './audio-assets.js';

export const conversationInclude = {
  contact: { select: { id: true, displayName: true, company: true } },
  participants: {
    orderBy: { joinedAt: 'asc' as const },
    select: {
      id: true,
      role: true,
      userId: true,
      guestIdentityId: true,
      displayName: true,
      company: true,
      preferredLanguage: true,
      presence: true,
      joinedAt: true,
      leftAt: true,
      lastSeenAt: true,
      removedAt: true,
    },
  },
  _count: {
    select: {
      messages: true,
      participants: { where: { removedAt: null } },
    },
  },
} satisfies Prisma.ConversationInclude;

export type ConversationWithContact = Prisma.ConversationGetPayload<{
  include: typeof conversationInclude;
}>;

export async function findInvitation(input: {
  roomToken?: string;
  roomCode?: string;
}): Promise<Conversation> {
  const { roomTokenHash, roomCodeHash } = invitationCredentialHashes(input);
  if (!roomTokenHash && !roomCodeHash) {
    throw notFound('ROOM_NOT_FOUND', '房间不存在');
  }
  const conversation = roomTokenHash
    ? await prisma.conversation.findUnique({ where: { roomTokenHash } })
    : await prisma.conversation.findUnique({ where: { roomCodeHash: roomCodeHash! } });
  if (!conversation || conversation.kind !== 'MEETING') {
    throw notFound('ROOM_NOT_FOUND', '房间不存在');
  }
  const now = new Date();
  if (
    conversation.status === 'ENDED' ||
    conversation.status === 'EXPIRED' ||
    conversation.expiresAt <= now
  ) {
    if (conversation.status !== 'ENDED' && conversation.status !== 'EXPIRED') {
      const expired = await prisma.conversation.updateMany({
        where: {
          id: conversation.id,
          status: { in: ['WAITING', 'ACTIVE'] },
          expiresAt: { lte: now },
        },
        data: { status: 'EXPIRED' },
      });
      if (expired.count === 1) {
        await prisma.translationMessage.updateMany({
          where: { conversationId: conversation.id, status: 'PROCESSING' },
          data: {
            status: 'FAILED',
            errorCode: 'ROOM_EXPIRED',
            errorMessage: '房间已过期',
          },
        });
      }
    }
    throw forbidden('ROOM_EXPIRED', '房间已结束或过期');
  }
  return conversation;
}

/**
 * Hashes are derived once from the credential presented by the caller and can
 * then be checked again after the Conversation row has been locked.  The
 * second check is what makes invitation rotation and joining linearizable:
 * an invitation that was valid before the lock cannot be used after a
 * concurrent rotation commits.
 */
export function invitationCredentialHashes(input: {
  roomToken?: string;
  roomCode?: string;
}): { roomTokenHash?: string; roomCodeHash?: string } {
  return {
    ...(input.roomToken ? { roomTokenHash: stableHash(input.roomToken) } : {}),
    ...(input.roomCode ? { roomCodeHash: stableHash(input.roomCode) } : {}),
  };
}

export function assertLockedInvitationCredential(
  conversation: Pick<Conversation, 'kind' | 'roomTokenHash' | 'roomCodeHash'>,
  input: { roomToken?: string; roomCode?: string },
): void {
  if (conversation.kind !== 'MEETING') {
    throw notFound('ROOM_NOT_FOUND', '房间不存在');
  }
  const { roomTokenHash, roomCodeHash } = invitationCredentialHashes(input);
  const matches = roomTokenHash
    ? conversation.roomTokenHash === roomTokenHash
    : roomCodeHash
      ? conversation.roomCodeHash === roomCodeHash
      : false;
  if (!matches) throw notFound('ROOM_NOT_FOUND', '房间不存在');
}

export async function getConversationForAuth(
  auth: AuthContext,
  conversationId: string,
  options: { history?: boolean } = {},
): Promise<ConversationWithContact> {
  return prisma.$transaction((tx) =>
    getConversationForAuthInTransaction(tx, auth, conversationId, options),
  );
}

interface LockedReadableConversation {
  id: string;
  status: Conversation['status'];
  expiresAt: Date;
}

interface LockedReadableUser {
  id: string;
  status: string;
}

interface LockedReadableDevice {
  sessionId: string;
  revokedAt: Date | null;
}

interface LockedReadableGuest {
  conversationId: string;
  sessionId: string;
  revokedAt: Date | null;
  expiresAt: Date;
}

/**
 * Authorizes a conversation read while holding the Conversation row lock.
 *
 * Every endpoint that returns conversation-scoped data must perform its final
 * data query in the same transaction after calling this helper. Removal,
 * leaving, meeting end and account deletion all take the Conversation lock
 * first, so either the read completes before the permission change or it sees
 * the new server-owned relationship. There is no check-then-query window.
 */
export async function getConversationForAuthInTransaction(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  conversationId: string,
  options: { history?: boolean } = {},
): Promise<ConversationWithContact> {
  const now = new Date();
  const lockedRows = await tx.$queryRaw<LockedReadableConversation[]>`
    SELECT "id", "status", "expiresAt"
    FROM "Conversation"
    WHERE "id" = ${conversationId}
    FOR UPDATE
  `;
  const locked = lockedRows[0];
  if (!locked) throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');

  // Expiry is resolved behind the same lock as the protected read. A request
  // that races the expiry boundary therefore cannot return pre-expiry data.
  if (
    (locked.status === 'WAITING' || locked.status === 'ACTIVE') &&
    locked.expiresAt <= now
  ) {
    await tx.conversation.update({
      where: { id: conversationId },
      data: { status: 'EXPIRED' },
    });
    await tx.translationMessage.updateMany({
      where: { conversationId, status: 'PROCESSING' },
      data: {
        status: 'FAILED',
        errorCode: 'ROOM_EXPIRED',
        errorMessage: '房间已过期',
      },
    });
  }
  const conversation = await tx.conversation.findUnique({
    where: { id: conversationId },
    include: conversationInclude,
  });
  if (!conversation || !conversationScopeMatches(auth, conversation)) {
    throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');
  }
  if (auth.role !== 'GUEST') {
    const ownsConversation = conversation.ownerId === auth.subjectId;
    const userRows = await tx.$queryRaw<LockedReadableUser[]>`
      SELECT "id", "status"
      FROM "User"
      WHERE "id" = ${auth.subjectId}
      FOR UPDATE
    `;
    const user = userRows[0];
    if (!user || user.status !== 'ACTIVE') {
      throw unauthorized('ACCOUNT_DISABLED', '账号不存在或已停用');
    }
    const deviceRows = await tx.$queryRaw<LockedReadableDevice[]>`
      SELECT "sessionId", "revokedAt"
      FROM "UserDevice"
      WHERE "userId" = ${auth.subjectId}
        AND "deviceId" = ${auth.deviceId}
      FOR UPDATE
    `;
    const device = deviceRows[0];
    if (
      !device ||
      device.revokedAt ||
      !auth.sessionId ||
      device.sessionId !== auth.sessionId
    ) {
      throw unauthorized('DEVICE_REVOKED', '此设备登录已被撤销');
    }
    // The Conversation lock is the serialization boundary for membership
    // mutations. Keep this as a non-locking relation query so account deletion
    // (Conversation -> User -> Participant) cannot deadlock a protected read.
    const participant = ownsConversation
      ? null
      : await tx.participant.findFirst({
          where: {
            conversationId,
            userId: auth.subjectId,
            removedAt: null,
          },
          select: { id: true },
        });
    if (!ownsConversation && !participant) {
      throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');
    }
    if (conversation.status === 'EXPIRED') {
      throw forbidden('ROOM_EXPIRED', '房间已过期');
    }
    if (!ownsConversation && options.history && !guestHistoryAllowed(conversation, now)) {
      throw forbidden('HISTORY_ACCESS_EXPIRED', '该会议的历史查看权限已过期');
    }
  } else {
    const guestIdentityId = auth.guestIdentityId ?? auth.subjectId;
    const guestRows = await tx.$queryRaw<LockedReadableGuest[]>`
      SELECT "conversationId", "sessionId", "revokedAt", "expiresAt"
      FROM "GuestIdentity"
      WHERE "id" = ${guestIdentityId}
      FOR UPDATE
    `;
    const guest = guestRows[0];
    if (
      !guest ||
      guest.conversationId !== conversationId ||
      guest.revokedAt ||
      guest.expiresAt <= now ||
      !auth.sessionId ||
      guest.sessionId !== auth.sessionId
    ) {
      throw unauthorized('GUEST_TOKEN_REVOKED', '访客身份已失效');
    }
    const participant = await tx.participant.findFirst({
      where: {
        conversationId,
        guestIdentityId,
        removedAt: null,
      },
      select: { id: true },
    });
    if (!participant) throw notFound('CONVERSATION_NOT_FOUND', '会议不存在');
    if (conversation.status === 'EXPIRED') throw forbidden('ROOM_EXPIRED', '房间已过期');
    if (options.history && !guestHistoryAllowed(conversation, now)) {
      throw forbidden('HISTORY_ACCESS_EXPIRED', '该会议的历史查看权限已过期');
    }
  }
  return conversation;
}

export async function getParticipant(
  auth: AuthContext,
  conversationId: string,
): Promise<Participant> {
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
  if (!participant) throw forbidden('NOT_A_PARTICIPANT', '您不是该会议参与者');
  return participant;
}

type DirectConversationAccess = Pick<Conversation, 'kind' | 'directPairKey'>;

export async function assertDirectConversationLiveAccess(
  auth: AuthContext,
  conversation: DirectConversationAccess,
): Promise<void> {
  return prisma.$transaction((tx) =>
    assertDirectConversationLiveAccessInTransaction(tx, auth, conversation),
  );
}

export async function assertDirectConversationLiveAccessInTransaction(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  conversation: DirectConversationAccess,
): Promise<void> {
  if (conversation.kind !== 'DIRECT') return;
  if (auth.role === 'GUEST') {
    throw forbidden('FORMAL_ACCOUNT_REQUIRED', '好友私聊只支持正式账号');
  }
  const [userAId, userBId, extra] = conversation.directPairKey?.split(':') ?? [];
  if (
    !userAId ||
    !userBId ||
    extra ||
    (auth.subjectId !== userAId && auth.subjectId !== userBId)
  ) {
    throw forbidden('DIRECT_CHAT_INVALID', '好友私聊关系无效');
  }
  const friendship = await tx.friendship.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
    select: { id: true },
  });
  if (!friendship) {
    throw forbidden('FRIEND_REQUIRED', '好友关系已解除，不能继续实时私聊');
  }
}

export function conversationDto(
  conversation: ConversationWithContact,
  invitation?: { roomToken: string; roomCode: string; inviteUrl: string },
  viewerUserId?: string,
) {
  const directPairIds = conversation.directPairKey?.split(':') ?? [];
  const directPeerUserId = conversation.kind === 'DIRECT' && viewerUserId
    ? directPairIds.length === 2
      ? directPairIds.find((id) => id !== viewerUserId)
      : undefined
    : undefined;
  const directPeer = conversation.kind === 'DIRECT' && viewerUserId
    ? conversation.participants.find(
        (participant) => participant.userId === directPeerUserId,
      ) ?? conversation.participants.find(
        (participant) => participant.userId == null,
      )
    : undefined;
  const displayedContact = directPeer
    ? {
        id: directPeer.userId ?? directPeerUserId ?? directPeer.id,
        displayName: directPeer.displayName,
        company: directPeer.company ?? null,
      }
    : conversation.contact;
  return {
    id: conversation.id,
    kind: conversation.kind,
    ownerId: conversation.ownerId,
    contactId: conversation.contactId,
    title: conversation.title,
    hostLanguage: conversation.hostLanguage,
    guestLanguage: conversation.guestLanguage,
    status: conversation.status,
    roomToken: conversation.kind === 'MEETING' ? (invitation?.roomToken ?? '') : '',
    roomCode: conversation.kind === 'MEETING' ? (invitation?.roomCode ?? '') : '',
    inviteUrl: conversation.kind === 'MEETING' ? invitation?.inviteUrl : undefined,
    capabilities: {
      invitations: conversation.kind === 'MEETING',
      participantManagement: conversation.kind === 'MEETING',
      documentExport: conversation.kind === 'MEETING',
      aiSummary: conversation.kind === 'MEETING',
      summaryDistribution: conversation.kind === 'MEETING',
    },
    directPeer: directPeer
      ? {
          id: directPeer.userId ?? directPeerUserId ?? directPeer.id,
          displayName: directPeer.displayName,
          company: directPeer.company ?? null,
          preferredLanguage: directPeer.preferredLanguage,
          presence: directPeer.removedAt
            ? 'REMOVED'
            : directPeer.leftAt
              ? 'LEFT'
              : directPeer.presence,
        }
      : null,
    guestHistoryPolicy: conversation.guestHistoryPolicy,
    guestAccessExpiresAt: conversation.guestAccessExpiresAt,
    expiresAt: conversation.expiresAt,
    startedAt: conversation.startedAt,
    endedAt: conversation.endedAt,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    contact: displayedContact,
    contactName: displayedContact.displayName,
    company: displayedContact.company,
    messageCount: conversation._count.messages,
    participantCount: conversation._count.participants,
    participants: conversation.participants.map(participantDto),
  };
}

export function participantDto(participant: {
  id: string;
  role: string;
  userId?: string | null;
  guestIdentityId?: string | null;
  displayName: string;
  company?: string | null;
  preferredLanguage: string;
  presence?: string;
  joinedAt: Date;
  leftAt?: Date | null;
  lastSeenAt?: Date | null;
  removedAt?: Date | null;
}) {
  return {
    id: participant.id,
    participantId: participant.id,
    role: participant.role,
    registered: Boolean(participant.userId),
    displayName: participant.displayName,
    company: participant.company ?? null,
    preferredLanguage: participant.preferredLanguage,
    presence: participant.removedAt
      ? 'REMOVED'
      : participant.leftAt
        ? 'LEFT'
        : (participant.presence ?? 'OFFLINE'),
    joinedAt: participant.joinedAt,
    leftAt: participant.leftAt ?? null,
    lastSeenAt: participant.lastSeenAt ?? null,
    removedAt: participant.removedAt ?? null,
  };
}

export function messageDto(message: TranslationMessage) {
  const sourceText = effectiveSourceText(message);
  const translatedText = effectiveTranslatedText(message);
  return {
    id: message.id,
    messageId: message.id,
    conversationId: message.conversationId,
    participantId: message.participantId,
    speakerRole: message.speakerRole,
    sourceLanguage: message.sourceLanguage,
    targetLanguage: message.targetLanguage,
    speakerDisplayName: message.speakerDisplayName,
    speakerName: message.speakerDisplayName,
    displayName: message.speakerDisplayName,
    speakerCompany: message.speakerCompany,
    company: message.speakerCompany,
    speakerLanguage: message.speakerLanguage,
    // Existing clients keep reading sourceText/translatedText and therefore
    // automatically receive the last confirmed wording. The immutable
    // provider result remains available explicitly for review/audit screens.
    sourceText,
    translatedText,
    originalSourceText: message.sourceText,
    originalTranslatedText: message.translatedText,
    reviewStatus: message.reviewStatus,
    reviewRevision: message.reviewRevision,
    hasConfirmedCorrection: Boolean(
      message.confirmedSourceText !== null ||
      message.confirmedTranslatedText !== null,
    ),
    pendingCorrection:
      message.reviewStatus === 'PENDING' &&
      message.pendingSourceText !== null &&
      message.pendingTranslatedText !== null
        ? {
            revision: message.reviewRevision,
            sourceText: message.pendingSourceText,
            translatedText: message.pendingTranslatedText,
          }
        : null,
    reviewedAt: message.reviewedAt,
    audioUrl: playableAudioUrl(message.audioUrl),
    status: message.status,
    sequence: message.sequence,
    startedAtMs: message.startedAtMs,
    endedAtMs: message.endedAtMs,
    provider: message.provider,
    errorCode: message.errorCode,
    errorMessage: message.errorMessage,
    createdAt: message.createdAt,
  };
}

export function effectiveSourceText(
  message: Pick<TranslationMessage, 'sourceText' | 'confirmedSourceText'>,
): string {
  return message.confirmedSourceText ?? message.sourceText;
}

export function effectiveTranslatedText(
  message: Pick<TranslationMessage, 'translatedText' | 'confirmedTranslatedText'>,
): string {
  return message.confirmedTranslatedText ?? message.translatedText;
}
