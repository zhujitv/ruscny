import { randomUUID } from 'node:crypto';
import { Prisma, type GuestIdentity, type GuestPrincipal } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { config } from '../config.js';
import { systemSetting } from '../services/system-settings.js';
import { prisma } from '../db.js';
import { AppError, conflict, forbidden, unauthorized } from '../errors.js';
import { randomToken, safeEqual, secretHash } from '../lib/crypto.js';
import { safeIdentityText } from '../lib/validation.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  type AuthContext,
  type RefreshContext,
} from '../lib/tokens.js';
import {
  assertLockedInvitationCredential,
  findInvitation,
} from '../services/conversations.js';
import { realtimeHub } from '../realtime-hub.js';
import { historyExpiresAt } from '../policies.js';
import { hashPassword, verifyPassword } from '../services/passwords.js';
import { logoutGuestSession, refreshGuestSession } from '../services/guest-session.js';
import {
  emailHint,
  emailVerificationTokenHash,
  sendAccountPasswordResetEmail,
  sendAccountVerificationEmail,
  userPasswordResetTokenHash,
} from '../services/account-emails.js';

const RECENT_AUTH_WINDOW_MS = 10 * 60 * 1_000;
const DELETED_USER_NAME = 'Deleted user';
const DELETED_GUEST_NAME = 'Deleted guest';
const avatarPreset = z.enum(['jade', 'ocean', 'amber', 'plum', 'graphite', 'rose']);
const interfaceLanguage = z.enum(['system', 'zh', 'ru']);
const translationPlaybackSpeed = z.union([
  z.literal(0.75),
  z.literal(1),
  z.literal(1.25),
  z.literal(1.5),
]);

const guestPrincipalHash = (token: string) =>
  secretHash(`guest-principal-v1:${token}`, config.PASSWORD_PEPPER);

const credentials = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128),
  deviceId: z.string().min(8).max(200),
  platform: z.enum(['ANDROID', 'IOS', 'UNKNOWN']).optional().default('UNKNOWN'),
});

const managedAvatarUrl = z
  .string()
  .url()
  .max(2_000)
  .refine((value) => new URL(value).protocol === 'https:', '头像地址必须使用 HTTPS');

async function revokeRefreshFamilyIfCurrent(claims: RefreshContext): Promise<void> {
  const current = await prisma.userDevice.findUnique({
    where: { userId_deviceId: { userId: claims.userId, deviceId: claims.deviceId } },
  });
  if (
    !current ||
    current.revokedAt ||
    !current.refreshTokenJti ||
    !current.refreshTokenHash ||
    current.sessionId !== claims.sessionId ||
    claims.familyId !== current.sessionId
  ) {
    return;
  }
  const revoked = await prisma.userDevice.updateMany({
    where: {
      id: current.id,
      sessionId: claims.sessionId,
      revokedAt: null,
      refreshTokenJti: current.refreshTokenJti,
      refreshTokenHash: current.refreshTokenHash,
    },
    data: { revokedAt: new Date(), refreshTokenHash: null, refreshTokenJti: null },
  });
  if (revoked.count === 1) {
    realtimeHub().disconnectDevice(current.userId, current.deviceId);
  }
}

async function issueUserSession(user: {
  id: string;
  role: 'USER';
  displayName: string;
  email: string | null;
  company: string | null;
  preferredLanguage: 'zh' | 'ru' | 'en';
  phone?: string | null;
  avatarUrl?: string | null;
  avatarPreset?: string;
  interfaceLanguage?: string;
  autoPlayTranslationAudio?: boolean;
  translationPlaybackSpeed?: number;
  emailVerifiedAt?: Date | null;
}, deviceId: string, platform: 'ANDROID' | 'IOS' | 'UNKNOWN') {
  const authenticatedAt = new Date();
  const sessionId = randomUUID();
  const jti = randomUUID();
  const context: AuthContext = { subjectId: user.id, role: user.role, deviceId, sessionId };
  const accessToken = await signAccessToken(context);
  const refreshToken = await signRefreshToken({
    userId: user.id,
    deviceId,
    sessionId,
    familyId: sessionId,
    jti,
  });
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: string; emailVerifiedAt: Date | null }>>`
      SELECT "status", "emailVerifiedAt"
      FROM "User"
      WHERE "id" = ${user.id}
      FOR UPDATE
    `;
    if (rows[0]?.status !== 'ACTIVE') {
      throw unauthorized('ACCOUNT_DISABLED', '账号不存在或已停用');
    }
    if (!rows[0]?.emailVerifiedAt) {
      throw forbidden('EMAIL_NOT_VERIFIED', '请先通过邮件激活账号');
    }
    await tx.user.update({
      where: { id: user.id },
      data: {
        legalPolicyVersion: config.LEGAL_POLICY_VERSION,
        legalPolicyAcceptedAt: authenticatedAt,
      },
    });
    await tx.userDevice.upsert({
      where: { userId_deviceId: { userId: user.id, deviceId } },
      create: {
        userId: user.id,
        deviceId,
        sessionId,
        platform,
        authenticatedAt,
        refreshTokenJti: jti,
        refreshTokenHash: secretHash(refreshToken, config.PASSWORD_PEPPER),
      },
      update: {
        sessionId,
        platform,
        authenticatedAt,
        refreshTokenJti: jti,
        refreshTokenHash: secretHash(refreshToken, config.PASSWORD_PEPPER),
        revokedAt: null,
        lastSeenAt: new Date(),
      },
    });
  });
  realtimeHub().disconnectDevice(user.id, deviceId);
  return { accessToken, refreshToken, user };
}

async function createEmailVerification(userId: string) {
  const token = randomToken(32);
  const tokenHash = emailVerificationTokenHash(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.EMAIL_VERIFICATION_TTL_MINUTES * 60_000);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{
      id: string;
      status: string;
      email: string | null;
      displayName: string;
      emailVerifiedAt: Date | null;
    }>>`
      SELECT "id", "status", "email", "displayName", "emailVerifiedAt"
      FROM "User"
      WHERE "id" = ${userId}
      FOR UPDATE
    `;
    const user = rows[0];
    if (!user || user.status !== 'ACTIVE' || !user.email || user.emailVerifiedAt) return null;
    const credential = await tx.emailVerificationToken.create({
      data: { userId, tokenHash, expiresAt },
      select: { id: true },
    });
    return { token, tokenId: credential.id, expiresAt, email: user.email, displayName: user.displayName };
  });
}

async function deliverEmailVerification(userId: string): Promise<boolean> {
  const credential = await createEmailVerification(userId);
  if (!credential) return false;
  try {
    await sendAccountVerificationEmail({
      to: credential.email,
      displayName: credential.displayName,
      token: credential.token,
      tokenId: credential.tokenId,
      expiresAt: credential.expiresAt,
    });
    return true;
  } catch (error) {
    await prisma.emailVerificationToken.updateMany({
      where: { id: credential.tokenId, usedAt: null },
      data: { usedAt: new Date() },
    });
    throw error;
  }
}

async function createPasswordReset(userId: string) {
  const token = randomToken(32);
  const tokenHash = userPasswordResetTokenHash(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.PASSWORD_RESET_TTL_MINUTES * 60_000);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{
      id: string;
      status: string;
      email: string | null;
      displayName: string;
      emailVerifiedAt: Date | null;
    }>>`
      SELECT "id", "status", "email", "displayName", "emailVerifiedAt"
      FROM "User"
      WHERE "id" = ${userId}
      FOR UPDATE
    `;
    const user = rows[0];
    if (!user || user.status !== 'ACTIVE' || !user.email || !user.emailVerifiedAt) return null;
    const credential = await tx.userPasswordResetToken.create({
      data: { userId, tokenHash, expiresAt },
      select: { id: true },
    });
    return { token, tokenId: credential.id, expiresAt, email: user.email, displayName: user.displayName };
  });
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/auth/register', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request) => {
    if (!await systemSetting('REGISTRATION_ENABLED')) {
      throw forbidden('REGISTRATION_DISABLED', '系统暂时关闭新用户注册');
    }
    const body = credentials
      .extend({
        displayName: safeIdentityText(1, 100),
        company: safeIdentityText(0, 200).optional(),
        preferredLanguage: z.enum(['zh', 'ru']).optional(),
      })
      .parse(request.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      if (existing.status === 'ACTIVE' && !existing.emailVerifiedAt) {
        throw conflict('EMAIL_VERIFICATION_REQUIRED', '该邮箱尚未激活，请重新发送激活邮件');
      }
      throw conflict('EMAIL_EXISTS', '该邮箱已注册');
    }
    const passwordHash = await hashPassword(body.password, config.PASSWORD_PEPPER);
    const user = await prisma.user.create({
      data: {
        email: body.email,
        displayName: body.displayName,
        company: body.company,
        preferredLanguage: body.preferredLanguage,
        role: 'USER',
        passwordHash,
        legalPolicyVersion: config.LEGAL_POLICY_VERSION,
        legalPolicyAcceptedAt: new Date(),
      },
      select: {
        id: true,
        role: true,
        displayName: true,
        email: true,
        emailVerifiedAt: true,
        company: true,
        preferredLanguage: true,
        phone: true,
        avatarUrl: true,
        avatarPreset: true,
        interfaceLanguage: true,
        autoPlayTranslationAudio: true,
        translationPlaybackSpeed: true,
      },
    });
    await seedDefaultGlossary(user.id);
    try {
      const delivered = await deliverEmailVerification(user.id);
      if (!delivered) throw new Error('New account was not eligible for verification email');
    } catch (error) {
      request.log.warn({ userId: user.id, error }, 'registration verification email failed');
      throw new AppError(
        503,
        'EMAIL_DELIVERY_FAILED',
        '账号已创建，但激活邮件暂未送出，请稍后重新发送',
      );
    }
    return {
      ok: true,
      data: {
        verificationRequired: true,
        emailHint: emailHint(body.email),
      },
    };
  });

  app.post('/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const body = credentials.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    const password = user?.passwordHash
      ? await verifyPassword(body.password, user.passwordHash, config.PASSWORD_PEPPER)
      : { valid: false, needsUpgrade: false };
    if (!user?.passwordHash || user.status !== 'ACTIVE' || !password.valid) {
      throw unauthorized('INVALID_CREDENTIALS', '邮箱或密码错误');
    }
    if (!user.emailVerifiedAt) {
      throw forbidden('EMAIL_NOT_VERIFIED', '请先通过邮件激活账号');
    }
    if (password.needsUpgrade) {
      const upgradedHash = await hashPassword(body.password, config.PASSWORD_PEPPER);
      await prisma.user.updateMany({
        where: { id: user.id, passwordHash: user.passwordHash, status: 'ACTIVE' },
        data: { passwordHash: upgradedHash },
      });
    }
    return {
      ok: true,
      data: await issueUserSession(
        {
          id: user.id,
          role: user.role,
          displayName: user.displayName,
          email: user.email,
          emailVerifiedAt: user.emailVerifiedAt,
          company: user.company,
          preferredLanguage: user.preferredLanguage,
          phone: user.phone,
          avatarUrl: user.avatarUrl,
          avatarPreset: user.avatarPreset,
          interfaceLanguage: user.interfaceLanguage,
          autoPlayTranslationAudio: user.autoPlayTranslationAudio,
          translationPlaybackSpeed: user.translationPlaybackSpeed,
        },
        body.deviceId,
        body.platform,
      ),
    };
  });

  app.post(
    '/v1/auth/email/resend',
    { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } },
    async (request) => {
      const body = z.object({
        email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
      }).strict().parse(request.body);
      const user = await prisma.user.findUnique({
        where: { email: body.email },
        select: { id: true },
      });
      if (user) {
        try {
          await deliverEmailVerification(user.id);
        } catch (error) {
          request.log.warn({ userId: user.id, error }, 'verification email resend failed');
        }
      }
      return {
        ok: true,
        data: {
          accepted: true,
          message: '如果该邮箱对应尚未激活的账号，我们已发送新的激活邮件',
        },
      };
    },
  );

  app.post(
    '/v1/auth/email/verify',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = z.object({ token: z.string().min(32).max(512) }).strict().parse(request.body);
      const tokenHash = emailVerificationTokenHash(body.token);
      const now = new Date();
      const userId = await prisma.$transaction(async (tx) => {
        const credential = await tx.emailVerificationToken.findUnique({
          where: { tokenHash },
          select: { id: true, userId: true, usedAt: true, expiresAt: true },
        });
        if (!credential || credential.usedAt || credential.expiresAt <= now) {
          throw unauthorized('VERIFICATION_TOKEN_INVALID', '激活链接无效或已过期');
        }
        const rows = await tx.$queryRaw<Array<{
          id: string;
          status: string;
          email: string | null;
          emailVerifiedAt: Date | null;
        }>>`
          SELECT "id", "status", "email", "emailVerifiedAt"
          FROM "User"
          WHERE "id" = ${credential.userId}
          FOR UPDATE
        `;
        const user = rows[0];
        if (!user || user.status !== 'ACTIVE' || !user.email) {
          throw unauthorized('VERIFICATION_TOKEN_INVALID', '激活链接无效或已过期');
        }
        const consumed = await tx.emailVerificationToken.updateMany({
          where: { id: credential.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (consumed.count !== 1) {
          throw unauthorized('VERIFICATION_TOKEN_INVALID', '激活链接无效或已过期');
        }
        if (!user.emailVerifiedAt) {
          await tx.user.update({
            where: { id: user.id },
            data: { emailVerifiedAt: now },
          });
        }
        await tx.emailVerificationToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: now },
        });
        return user.id;
      });
      reply.header('Cache-Control', 'no-store');
      return { ok: true, data: { verified: true, userId } };
    },
  );

  app.post('/v1/auth/guest', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const body = z
      .object({
        displayName: safeIdentityText(1, 100),
        company: safeIdentityText(1, 200),
        email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
        preferredLanguage: z.enum(['zh', 'ru']),
        deviceId: z.string().min(8).max(200),
        guestPrincipalToken: z.string().min(32).max(512).optional(),
        inviteToken: z.string().min(16).optional(),
        roomToken: z.string().min(16).optional(),
        roomCode: z.string().regex(/^\d{6,8}$/).optional(),
      })
      .parse(request.body);
    const presentedInvitation = {
      ...(body.inviteToken || body.roomToken
        ? { roomToken: body.inviteToken ?? body.roomToken }
        : {}),
      ...(body.roomCode ? { roomCode: body.roomCode } : {}),
    };
    const conversation = await findInvitation(presentedInvitation);
    let result: { guest: GuestIdentity; guestPrincipalToken: string };
    try {
      result = await prisma.$transaction(async (tx) => {
        const joinedAt = new Date();
        const sessionId = randomUUID();
        const activated = await tx.conversation.updateMany({
          where: {
            id: conversation.id,
            status: { in: ['WAITING', 'ACTIVE'] },
            expiresAt: { gt: joinedAt },
          },
          data: { status: 'ACTIVE' },
        });
        if (activated.count !== 1) {
          throw forbidden('ROOM_EXPIRED', '房间已结束或过期');
        }
        const lockedConversation = await tx.conversation.findUnique({
          where: { id: conversation.id },
        });
        if (!lockedConversation) throw forbidden('ROOM_EXPIRED', '房间已结束或过期');
        assertLockedInvitationCredential(lockedConversation, presentedInvitation);
        await tx.conversation.updateMany({
          where: { id: conversation.id, startedAt: null },
          data: { startedAt: joinedAt },
        });
        const presentedPrincipalHash = body.guestPrincipalToken
          ? guestPrincipalHash(body.guestPrincipalToken)
          : undefined;
        let principal: GuestPrincipal | null = presentedPrincipalHash
          ? await tx.guestPrincipal.findUnique({ where: { tokenHash: presentedPrincipalHash } })
          : null;
        if (principal?.revokedAt) {
          throw forbidden('GUEST_PRINCIPAL_REVOKED', '访客身份已失效');
        }

        let currentIdentity: GuestIdentity | null = principal
          ? await tx.guestIdentity.findUnique({
              where: {
                conversationId_guestPrincipalId: {
                  conversationId: conversation.id,
                  guestPrincipalId: principal.id,
                },
              },
            })
          : null;

        // Compatibility and response-loss recovery: old clients identify the
        // same install with deviceId. A principal token is mandatory only when
        // moving to a different install/device.
        if (!principal) {
          currentIdentity = await tx.guestIdentity.findFirst({
            where: { conversationId: conversation.id, deviceId: body.deviceId },
            orderBy: { createdAt: 'desc' },
          });
          if (body.guestPrincipalToken && !currentIdentity) {
            throw forbidden('GUEST_PRINCIPAL_INVALID', '访客身份凭证无效');
          }
        }
        if (currentIdentity?.revokedAt) {
          throw forbidden('PARTICIPANT_REMOVED', '主持人已将此客户移出会议');
        }

        let guestPrincipalToken = body.guestPrincipalToken;
        if (!principal) {
          // First join, legacy-client upgrade, or recovery after a response was
          // lost. Rotate the durable principal capability and return it only
          // over the authenticated TLS response for secure client storage.
          guestPrincipalToken = randomToken(32);
          const tokenHash = guestPrincipalHash(guestPrincipalToken);
          if (currentIdentity?.guestPrincipalId) {
            principal = await tx.guestPrincipal.update({
              where: { id: currentIdentity.guestPrincipalId },
              data: { tokenHash, lastSeenAt: joinedAt, revokedAt: null },
            });
          } else {
            principal = await tx.guestPrincipal.create({
              data: { tokenHash, lastSeenAt: joinedAt },
            });
          }
        } else {
          await tx.guestPrincipal.update({
            where: { id: principal.id },
            data: { lastSeenAt: joinedAt },
          });
        }

        if (!guestPrincipalToken) {
          throw new Error('Guest principal token was not established');
        }
        const identity = currentIdentity
          ? await tx.guestIdentity.update({
              where: { id: currentIdentity.id },
              data: {
                displayName: body.displayName,
                company: body.company,
                email: body.email,
                preferredLanguage: body.preferredLanguage,
                deviceId: body.deviceId,
                guestPrincipalId: principal.id,
                // A voluntary logout expires the old access token without
                // permanently banning this device. A new authorized join can
                // reactivate the same scoped identity.
                expiresAt: lockedConversation.expiresAt,
                sessionId,
                legalPolicyVersion: config.LEGAL_POLICY_VERSION,
                legalPolicyAcceptedAt: joinedAt,
              },
            })
          : await tx.guestIdentity.create({
              data: {
                displayName: body.displayName,
                company: body.company,
                email: body.email,
                preferredLanguage: body.preferredLanguage,
                deviceId: body.deviceId,
                conversationId: conversation.id,
                guestPrincipalId: principal.id,
                expiresAt: lockedConversation.expiresAt,
                sessionId,
                legalPolicyVersion: config.LEGAL_POLICY_VERSION,
                legalPolicyAcceptedAt: joinedAt,
              },
            });
        const membership = await tx.participant.findUnique({
          where: {
            conversationId_guestIdentityId: {
              conversationId: conversation.id,
              guestIdentityId: identity.id,
            },
          },
        });
        if (membership?.removedAt) {
          throw forbidden('PARTICIPANT_REMOVED', '主持人已将此客户移出会议');
        }
        if (membership) {
          await tx.participant.update({
            where: { id: membership.id },
            data: {
              displayName: body.displayName,
              company: body.company,
              email: body.email,
              preferredLanguage: body.preferredLanguage,
              lastSeenAt: joinedAt,
              leftAt: null,
              presence: 'OFFLINE',
            },
          });
        } else {
          await tx.participant.create({ data: {
            conversationId: conversation.id,
            guestIdentityId: identity.id,
            role: 'GUEST',
            displayName: body.displayName,
            company: body.company,
            email: body.email,
            preferredLanguage: body.preferredLanguage,
            presence: 'OFFLINE',
          } });
        }
        return { guest: identity, guestPrincipalToken };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflict('GUEST_JOIN_CONFLICT', '临时身份正在加入，请重试');
      }
      throw error;
    }
    const guest = result.guest;
    const accessToken = await signAccessToken({
      subjectId: guest.id,
      role: 'GUEST',
      deviceId: body.deviceId,
      sessionId: guest.sessionId,
      guestIdentityId: guest.id,
      conversationId: conversation.id,
    });
    // The identity id is deliberately stable across voluntary logout/rejoin,
    // while its session id is not. Remove any sockets authenticated with the
    // preceding generation before returning the newly scoped credential.
    realtimeHub().disconnectSubject(guest.id);
    return {
      ok: true,
      data: {
        accessToken,
        conversationId: conversation.id,
        guestIdentityId: guest.id,
        guestPrincipalToken: result.guestPrincipalToken,
        role: 'GUEST',
        displayName: guest.displayName,
        company: guest.company,
        email: guest.email,
        preferredLanguage: guest.preferredLanguage,
      },
    };
  });

  app.post(
    '/v1/auth/guest/refresh',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (request) => {
      const body = z
        .object({
          guestPrincipalToken: z.string().min(32).max(512),
          conversationId: z.string().min(1).max(200),
          deviceId: z.string().min(8).max(200),
        })
        .strict()
        .parse(request.body);
      const guest = await refreshGuestSession(body);
      const accessToken = await signAccessToken({
        subjectId: guest.id,
        role: 'GUEST',
        deviceId: guest.deviceId,
        sessionId: guest.sessionId,
        guestIdentityId: guest.id,
        conversationId: guest.conversationId,
      });
      // A renewal advances the server-side generation. Disconnect all sockets
      // from the prior generation before the client reconnects with this token.
      realtimeHub().disconnectSubject(guest.id);
      return {
        ok: true,
        data: {
          accessToken,
          conversationId: guest.conversationId,
          guestIdentityId: guest.id,
          role: 'GUEST',
          displayName: guest.displayName,
          company: guest.company,
          email: guest.email,
          preferredLanguage: guest.preferredLanguage,
        },
      };
    },
  );

  app.post('/v1/auth/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const body = z
      .object({ refreshToken: z.string().min(20), deviceId: z.string().min(8) })
      .parse(request.body);
    const claims = await verifyRefreshToken(body.refreshToken);
    if (claims.deviceId !== body.deviceId) {
      throw unauthorized('REFRESH_DEVICE_MISMATCH', '刷新凭证不属于此设备');
    }
    const device = await prisma.userDevice.findUnique({
      where: { userId_deviceId: { userId: claims.userId, deviceId: claims.deviceId } },
      include: { user: true },
    });
    if (
      device &&
      (claims.sessionId !== device.sessionId || claims.familyId !== device.sessionId)
    ) {
      // A token from an older login family must never revoke the current
      // device row. The access-token session check follows the same rule.
      throw unauthorized('REFRESH_TOKEN_INVALID', '刷新凭证无效或已过期');
    }
    const presentedHash = secretHash(body.refreshToken, config.PASSWORD_PEPPER);
    if (
      !device?.refreshTokenHash ||
      device.revokedAt ||
      device.refreshTokenJti !== claims.jti ||
      !safeEqual(device.refreshTokenHash, presentedHash)
    ) {
      await revokeRefreshFamilyIfCurrent(claims);
      throw unauthorized('REFRESH_TOKEN_REUSED', '刷新凭证已失效，请重新登录');
    }
    if (device.user.status !== 'ACTIVE') throw forbidden('ACCOUNT_DISABLED', '账号已停用');
    if (!device.user.emailVerifiedAt) throw forbidden('EMAIL_NOT_VERIFIED', '请先通过邮件激活账号');
    const nextJti = randomUUID();
    const accessToken = await signAccessToken({
      subjectId: device.user.id,
      role: device.user.role,
      deviceId: device.deviceId,
      sessionId: device.sessionId,
    });
    const refreshToken = await signRefreshToken({
      userId: device.user.id,
      deviceId: device.deviceId,
      sessionId: device.sessionId,
      familyId: device.sessionId,
      jti: nextJti,
    });
    const rotated = await prisma.userDevice.updateMany({
      where: {
        id: device.id,
        sessionId: claims.sessionId,
        revokedAt: null,
        refreshTokenJti: claims.jti,
        refreshTokenHash: device.refreshTokenHash,
      },
      data: {
        refreshTokenJti: nextJti,
        refreshTokenHash: secretHash(refreshToken, config.PASSWORD_PEPPER),
        lastSeenAt: new Date(),
      },
    });
    if (rotated.count !== 1) {
      // If another request already rotated this same family, treat the old
      // credential as a replay and revoke the winning generation as well.
      await revokeRefreshFamilyIfCurrent(claims);
      throw unauthorized('REFRESH_TOKEN_REUSED', '刷新凭证已失效，请重新登录');
    }
    return {
      ok: true,
      data: {
        accessToken,
        refreshToken,
        user: {
          id: device.user.id,
          role: device.user.role,
          displayName: device.user.displayName,
          email: device.user.email,
          emailVerifiedAt: device.user.emailVerifiedAt,
          company: device.user.company,
          preferredLanguage: device.user.preferredLanguage,
          phone: device.user.phone,
          avatarUrl: device.user.avatarUrl,
          avatarPreset: device.user.avatarPreset,
          interfaceLanguage: device.user.interfaceLanguage,
          autoPlayTranslationAudio: device.user.autoPlayTranslationAudio,
          translationPlaybackSpeed: device.user.translationPlaybackSpeed,
        },
      },
    };
  });

  app.get('/v1/auth/me', { preHandler: authenticate }, async (request) => {
    if (request.auth.role === 'GUEST') {
      const guest = await prisma.guestIdentity.findUniqueOrThrow({
        where: { id: request.auth.guestIdentityId ?? request.auth.subjectId },
      });
      return {
        ok: true,
        data: {
          id: guest.id,
          role: 'GUEST',
          displayName: guest.displayName,
          company: guest.company,
          email: guest.email,
          preferredLanguage: guest.preferredLanguage,
          conversationId: guest.conversationId,
        },
      };
    }
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.auth.subjectId },
      select: {
        id: true,
        role: true,
        displayName: true,
        email: true,
        emailVerifiedAt: true,
        phone: true,
        company: true,
        preferredLanguage: true,
        avatarUrl: true,
        avatarPreset: true,
        interfaceLanguage: true,
        autoPlayTranslationAudio: true,
        translationPlaybackSpeed: true,
      },
    });
    return { ok: true, data: user };
  });

  app.patch('/v1/auth/profile', { preHandler: authenticate }, async (request) => {
    if (request.auth.role === 'GUEST') {
      throw forbidden('FORMAL_ACCOUNT_REQUIRED', '访客身份不能修改正式账号资料');
    }
    const body = z
      .object({
        displayName: safeIdentityText(1, 100).optional(),
        phone: z.string().trim().min(5).max(30).nullable().optional(),
        company: safeIdentityText(0, 200).nullable().optional(),
        preferredLanguage: z.enum(['zh', 'ru']).optional(),
        avatarUrl: managedAvatarUrl.nullable().optional(),
        avatarPreset: avatarPreset.optional(),
        interfaceLanguage: interfaceLanguage.optional(),
        autoPlayTranslationAudio: z.boolean().optional(),
        translationPlaybackSpeed: translationPlaybackSpeed.optional(),
      })
      .refine((value) => Object.keys(value).length > 0, '至少提供一个要修改的字段')
      .parse(request.body);
    const changed = await prisma.user.updateMany({
      where: { id: request.auth.subjectId, status: 'ACTIVE' },
      data: body,
    });
    if (changed.count !== 1) {
      throw forbidden('ACCOUNT_DISABLED', '账号不存在或已停用');
    }
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.auth.subjectId },
      select: {
        id: true,
        role: true,
        displayName: true,
        email: true,
        emailVerifiedAt: true,
        phone: true,
        company: true,
        preferredLanguage: true,
        avatarUrl: true,
        avatarPreset: true,
        interfaceLanguage: true,
        autoPlayTranslationAudio: true,
        translationPlaybackSpeed: true,
      },
    });
    return { ok: true, data: user };
  });

  app.post(
    '/v1/auth/password/change',
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request) => {
      if (request.auth.role === 'GUEST') {
        throw forbidden('FORMAL_ACCOUNT_REQUIRED', '访客身份不能修改密码');
      }
      const body = z
        .object({
          currentPassword: z.string().min(8).max(128),
          newPassword: z.string().min(8).max(128),
        })
        .strict()
        .parse(request.body);
      if (body.currentPassword === body.newPassword) {
        throw conflict('PASSWORD_UNCHANGED', '新密码不能与当前密码相同');
      }

      const account = await prisma.user.findUnique({
        where: { id: request.auth.subjectId },
        select: { status: true, passwordHash: true },
      });
      if (!account?.passwordHash || account.status !== 'ACTIVE') {
        throw unauthorized('ACCOUNT_DISABLED', '账号不存在或已停用');
      }
      const verified = await verifyPassword(
        body.currentPassword,
        account.passwordHash,
        config.PASSWORD_PEPPER,
      );
      if (!verified.valid) {
        throw unauthorized('INVALID_CURRENT_PASSWORD', '当前密码错误');
      }

      const newPasswordHash = await hashPassword(body.newPassword, config.PASSWORD_PEPPER);
      const changedAt = new Date();
      const otherDeviceIds = await prisma.$transaction(async (tx) => {
        const changed = await tx.user.updateMany({
          where: {
            id: request.auth.subjectId,
            status: 'ACTIVE',
            passwordHash: account.passwordHash,
          },
          data: { passwordHash: newPasswordHash },
        });
        if (changed.count !== 1) {
          throw conflict('ACCOUNT_CHANGED', '账号状态已发生变化，请重新登录后再试');
        }
        await tx.userPasswordResetToken.updateMany({
          where: { userId: request.auth.subjectId, usedAt: null },
          data: { usedAt: changedAt },
        });
        await tx.adminPasswordResetToken.updateMany({
          where: { userId: request.auth.subjectId, usedAt: null },
          data: { usedAt: changedAt },
        });
        const otherDevices = await tx.userDevice.findMany({
          where: {
            userId: request.auth.subjectId,
            deviceId: { not: request.auth.deviceId },
            revokedAt: null,
          },
          select: { deviceId: true },
        });
        await tx.userDevice.updateMany({
          where: {
            userId: request.auth.subjectId,
            deviceId: { not: request.auth.deviceId },
            revokedAt: null,
          },
          data: {
            revokedAt: changedAt,
            refreshTokenHash: null,
            refreshTokenJti: null,
          },
        });
        await tx.userDevice.updateMany({
          where: {
            userId: request.auth.subjectId,
            deviceId: request.auth.deviceId,
            sessionId: request.auth.sessionId,
            revokedAt: null,
          },
          data: { authenticatedAt: changedAt },
        });
        return otherDevices.map((device) => device.deviceId);
      });
      for (const deviceId of otherDeviceIds) {
        realtimeHub().disconnectDevice(request.auth.subjectId, deviceId);
      }
      return {
        ok: true,
        data: { changedAt, revokedOtherDeviceCount: otherDeviceIds.length },
      };
    },
  );

  app.get('/v1/auth/devices', { preHandler: authenticate }, async (request) => {
    if (request.auth.role === 'GUEST') {
      throw forbidden('FORMAL_ACCOUNT_REQUIRED', '访客身份没有可管理的登录设备');
    }
    const devices = await prisma.userDevice.findMany({
      where: { userId: request.auth.subjectId },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        deviceId: true,
        platform: true,
        lastSeenAt: true,
        createdAt: true,
        revokedAt: true,
      },
    });
    return {
      ok: true,
      data: devices.map((device) => ({
        ...device,
        isCurrent: device.deviceId === request.auth.deviceId,
      })),
    };
  });

  app.delete('/v1/auth/devices/:deviceId', { preHandler: authenticate }, async (request) => {
    if (request.auth.role === 'GUEST') {
      throw forbidden('FORMAL_ACCOUNT_REQUIRED', '访客身份没有可管理的登录设备');
    }
    const { deviceId } = z
      .object({ deviceId: z.string().min(8).max(200) })
      .parse(request.params);
    await prisma.userDevice.updateMany({
      where: { userId: request.auth.subjectId, deviceId },
      data: {
        revokedAt: new Date(),
        refreshTokenHash: null,
        refreshTokenJti: null,
      },
    });
    realtimeHub().disconnectDevice(request.auth.subjectId, deviceId);
    return { ok: true, data: { deviceId } };
  });

  app.post('/v1/auth/logout', async (request) => {
    const body = z.object({ refreshToken: z.string().nullish() }).parse(request.body ?? {});

    // A valid Bearer token is the authoritative current session. Revoke it
    // even when the client no longer has its refresh token (or presents a
    // stale one). Refresh-token handling below remains an independent exact
    // family revocation path so logout stays safe and idempotent.
    if (request.headers.authorization?.startsWith('Bearer ')) {
      try {
        await authenticate(request);
        if (request.auth.role === 'GUEST') {
          // Guests deliberately have no refresh token. Expire the server-side
          // scoped identity so a copied access token cannot keep using the
          // room after logout. `revokedAt` remains reserved for Host removal,
          // allowing a voluntary guest to join again through a valid invite.
          const guestIdentityId = request.auth.guestIdentityId ?? request.auth.subjectId;
          const expired = await logoutGuestSession({
            guestIdentityId,
            conversationId: request.auth.conversationId!,
            deviceId: request.auth.deviceId,
          });
          if (expired) {
            realtimeHub().disconnectSubject(guestIdentityId);
          }
        } else if (request.auth.sessionId) {
          const revoked = await prisma.userDevice.updateMany({
            where: {
              userId: request.auth.subjectId,
              deviceId: request.auth.deviceId,
              sessionId: request.auth.sessionId,
              revokedAt: null,
            },
            data: { revokedAt: new Date(), refreshTokenHash: null, refreshTokenJti: null },
          });
          if (revoked.count === 1) {
            realtimeHub().disconnectDevice(request.auth.subjectId, request.auth.deviceId);
          }
        }
      } catch {
        // Logout stays idempotent and does not reveal Bearer-token validity.
      }
    }
    if (body.refreshToken) {
      try {
        const claims = await verifyRefreshToken(body.refreshToken);
        const revoked = await prisma.userDevice.updateMany({
          where: {
            userId: claims.userId,
            deviceId: claims.deviceId,
            sessionId: claims.sessionId,
            revokedAt: null,
            refreshTokenJti: claims.jti,
            refreshTokenHash: secretHash(body.refreshToken, config.PASSWORD_PEPPER),
          },
          data: { revokedAt: new Date(), refreshTokenHash: null, refreshTokenJti: null },
        });
        if (revoked.count === 1) {
          realtimeHub().disconnectDevice(claims.userId, claims.deviceId);
        }
      } catch {
        // Logout is intentionally idempotent and does not reveal token validity.
      }
    }
    return { ok: true, data: {} };
  });

  app.post(
    '/v1/auth/password/forgot',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request) => {
      const body = z.object({
        email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
      }).strict().parse(request.body);
      const user = await prisma.user.findUnique({
        where: { email: body.email },
        select: { id: true },
      });
      if (user) {
        let credential: Awaited<ReturnType<typeof createPasswordReset>> = null;
        try {
          credential = await createPasswordReset(user.id);
          if (credential) {
            await sendAccountPasswordResetEmail({
              to: credential.email,
              displayName: credential.displayName,
              token: credential.token,
              tokenId: credential.tokenId,
              expiresAt: credential.expiresAt,
            });
          }
        } catch (error) {
          if (credential) {
            await prisma.userPasswordResetToken.updateMany({
              where: { id: credential.tokenId, usedAt: null },
              data: { usedAt: new Date() },
            });
          }
          request.log.warn({ userId: user.id, error }, 'password reset email failed');
        }
      }
      return {
        ok: true,
        data: {
          accepted: true,
          message: '如果该邮箱对应可用账号，我们已发送密码重置邮件',
        },
      };
    },
  );

  app.post(
    '/v1/auth/password/reset/email',
    { config: { rateLimit: { max: 8, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = z.object({
        token: z.string().min(32).max(512),
        newPassword: z.string().min(8).max(128),
      }).strict().parse(request.body);
      const now = new Date();
      const tokenHash = userPasswordResetTokenHash(body.token);
      const passwordHash = await hashPassword(body.newPassword, config.PASSWORD_PEPPER);
      const userId = await prisma.$transaction(async (tx) => {
        const credential = await tx.userPasswordResetToken.findUnique({
          where: { tokenHash },
          select: { id: true, userId: true, usedAt: true, expiresAt: true },
        });
        if (!credential || credential.usedAt || credential.expiresAt <= now) {
          throw unauthorized('RESET_TOKEN_INVALID', '重置链接无效或已过期');
        }
        const rows = await tx.$queryRaw<Array<{
          id: string;
          status: string;
          emailVerifiedAt: Date | null;
        }>>`
          SELECT "id", "status", "emailVerifiedAt"
          FROM "User"
          WHERE "id" = ${credential.userId}
          FOR UPDATE
        `;
        const user = rows[0];
        if (!user || user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
          throw unauthorized('RESET_TOKEN_INVALID', '重置链接无效或已过期');
        }
        const consumed = await tx.userPasswordResetToken.updateMany({
          where: { id: credential.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (consumed.count !== 1) {
          throw unauthorized('RESET_TOKEN_INVALID', '重置链接无效或已过期');
        }
        const changed = await tx.user.updateMany({
          where: { id: user.id, status: 'ACTIVE', emailVerifiedAt: { not: null } },
          data: { passwordHash },
        });
        if (changed.count !== 1) {
          throw unauthorized('RESET_TOKEN_INVALID', '重置链接无效或已过期');
        }
        await tx.userDevice.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: now, refreshTokenHash: null, refreshTokenJti: null },
        });
        await tx.userPasswordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: now },
        });
        await tx.adminPasswordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: now },
        });
        return user.id;
      });
      realtimeHub().disconnectSubject(userId);
      reply.header('Cache-Control', 'no-store');
      return { ok: true, data: { reset: true } };
    },
  );

  app.delete('/v1/auth/account', { preHandler: authenticate }, async (request) => {
    const body = z
      .object({ password: z.string().min(8).max(128).optional() })
      .parse(request.body ?? {});
    const deletedAt = new Date();
    let expectedPasswordHash: string | null = null;

    if (request.auth.role !== 'GUEST') {
      const account = await prisma.user.findUnique({
        where: { id: request.auth.subjectId },
        select: {
          status: true,
          passwordHash: true,
          devices: {
            where: {
              deviceId: request.auth.deviceId,
              ...(request.auth.sessionId ? { sessionId: request.auth.sessionId } : {}),
              revokedAt: null,
            },
            select: { authenticatedAt: true },
            take: 1,
          },
        },
      });
      if (!account?.passwordHash || account.status !== 'ACTIVE') {
        throw unauthorized('ACCOUNT_DISABLED', '账号不存在或已停用');
      }
      const recentlyAuthenticated = Boolean(
        account.devices[0]?.authenticatedAt &&
        account.devices[0].authenticatedAt.getTime() >= deletedAt.getTime() - RECENT_AUTH_WINDOW_MS,
      );
      if (!recentlyAuthenticated) {
        if (!body.password) {
          throw unauthorized('RECENT_AUTH_REQUIRED', '请重新输入密码后注销账号');
        }
        const verified = await verifyPassword(
          body.password,
          account.passwordHash,
          config.PASSWORD_PEPPER,
        );
        if (!verified.valid) throw unauthorized('INVALID_CREDENTIALS', '密码错误');
      } else if (body.password) {
        const verified = await verifyPassword(
          body.password,
          account.passwordHash,
          config.PASSWORD_PEPPER,
        );
        if (!verified.valid) throw unauthorized('INVALID_CREDENTIALS', '密码错误');
      }
      expectedPasswordHash = account.passwordHash;
    }

    const endedConversationIds = await prisma.$transaction(async (tx) => {
      if (request.auth.role === 'GUEST') {
        const guestIdentityId = request.auth.guestIdentityId ?? request.auth.subjectId;
        const memberships = await tx.participant.findMany({
          where: { guestIdentityId },
          select: { id: true, conversationId: true, displayName: true, company: true },
        });
        await lockConversationsForDeletion(
          tx,
          memberships.map((membership) => membership.conversationId),
        );
        const revoked = await tx.guestIdentity.updateMany({
          where: {
            id: guestIdentityId,
            sessionId: request.auth.sessionId,
            revokedAt: null,
          },
          data: {
            displayName: DELETED_GUEST_NAME,
            company: null,
            email: null,
            deviceId: `deleted:${randomUUID()}`,
            expiresAt: deletedAt,
            revokedAt: deletedAt,
            sessionId: randomUUID(),
          },
        });
        if (revoked.count !== 1) {
          throw unauthorized('GUEST_SESSION_CHANGED', '访客身份状态已变更，请重试');
        }
        await tx.translationMessage.updateMany({
          where: { participant: { guestIdentityId }, status: 'PROCESSING' },
          data: {
            status: 'FAILED',
            errorCode: 'ACCOUNT_DELETED',
            errorMessage: '发言者已注销账号',
            updatedAt: deletedAt,
          },
        });
        await tx.translationMessage.updateMany({
          where: { participant: { guestIdentityId } },
          data: {
            speakerDisplayName: DELETED_GUEST_NAME,
            speakerCompany: null,
          },
        });
        await anonymizeMessageCorrectionActors(
          tx,
          guestIdentityId,
          memberships,
          DELETED_GUEST_NAME,
        );
        await anonymizeConversationSummaries(
          tx,
          memberships,
          DELETED_GUEST_NAME,
        );
        await anonymizeSummaryEmailRecipients(
          tx,
          memberships,
          DELETED_GUEST_NAME,
          deletedAt,
        );
        await tx.participant.updateMany({
          where: { guestIdentityId },
          data: {
            guestIdentityId: null,
            displayName: DELETED_GUEST_NAME,
            company: null,
            email: null,
            presence: 'LEFT',
            leftAt: deletedAt,
            lastSeenAt: deletedAt,
          },
        });
        await tx.dataDeletionRequest.upsert({
          where: { subjectType_subjectId: { subjectType: 'GUEST', subjectId: guestIdentityId } },
          create: {
            subjectType: 'GUEST', subjectId: guestIdentityId, status: 'COMPLETED',
            steps: { database: 'COMPLETED', identity: 'ANONYMIZED', externalAssets: 'NOT_APPLICABLE' },
            requestedAt: deletedAt, completedAt: deletedAt,
          },
          update: { status: 'COMPLETED', completedAt: deletedAt },
        });
        return [];
      }

      const conversations = await tx.conversation.findMany({
        where: {
          OR: [
            { ownerId: request.auth.subjectId },
            { participants: { some: { userId: request.auth.subjectId } } },
          ],
        },
        select: {
          id: true,
          kind: true,
          ownerId: true,
          status: true,
          guestHistoryPolicy: true,
        },
      });
      await lockConversationsForDeletion(
        tx,
        conversations.map((conversation) => conversation.id),
      );

      const affectedParticipants = await tx.participant.findMany({
        where: { userId: request.auth.subjectId },
        select: { id: true, conversationId: true, displayName: true, company: true },
      });

      const anonymizedName = `${DELETED_USER_NAME} ${request.auth.subjectId.slice(-8)}`;
      const disabled = await tx.user.updateMany({
        where: {
          id: request.auth.subjectId,
          status: 'ACTIVE',
          passwordHash: expectedPasswordHash,
        },
        data: {
          status: 'DELETED',
          deletedAt,
          displayName: anonymizedName,
          company: null,
          phone: null,
          email: null,
          passwordHash: null,
          avatarUrl: null,
        },
      });
      if (disabled.count !== 1) {
        throw unauthorized('ACCOUNT_STATE_CHANGED', '账号状态已变更，请重试');
      }

      // Preserve immutable utterance text, language, timestamps, sequence and
      // participantId while removing direct personal identifiers.
      await tx.translationMessage.updateMany({
        where: {
          participant: { userId: request.auth.subjectId },
          status: 'PROCESSING',
        },
        data: {
          status: 'FAILED',
          errorCode: 'ACCOUNT_DELETED',
          errorMessage: '发言者已注销账号',
          updatedAt: deletedAt,
        },
      });
      await tx.translationMessage.updateMany({
        where: { participant: { userId: request.auth.subjectId } },
        data: { speakerDisplayName: anonymizedName, speakerCompany: null },
      });
      await anonymizeMessageCorrectionActors(
        tx,
        request.auth.subjectId,
        affectedParticipants,
        anonymizedName,
      );
      await anonymizeConversationSummaries(tx, affectedParticipants, anonymizedName);
      await anonymizeSummaryEmailRecipients(
        tx,
        affectedParticipants,
        anonymizedName,
        deletedAt,
      );
      await tx.participant.updateMany({
        where: { userId: request.auth.subjectId },
        data: {
          userId: null,
          displayName: anonymizedName,
          company: null,
          email: null,
          presence: 'LEFT',
          leftAt: deletedAt,
          lastSeenAt: deletedAt,
        },
      });

      const ownedActive = conversations.filter(
        (conversation) =>
          conversation.ownerId === request.auth.subjectId &&
          (conversation.status === 'WAITING' || conversation.status === 'ACTIVE'),
      );
      for (const conversation of ownedActive) {
        const guestAccessExpiresAt = historyExpiresAt(
          conversation.guestHistoryPolicy,
          deletedAt,
        );
        const transitioned = await tx.conversation.updateMany({
          where: { id: conversation.id, status: { in: ['WAITING', 'ACTIVE'] } },
          data: { status: 'ENDED', endedAt: deletedAt, guestAccessExpiresAt },
        });
        if (transitioned.count !== 1) continue;
        await tx.translationMessage.updateMany({
          where: { conversationId: conversation.id, status: 'PROCESSING' },
          data: {
            status: 'FAILED',
            errorCode: 'ROOM_ENDED',
            errorMessage: '主持人已注销账号，会议已结束',
            updatedAt: deletedAt,
          },
        });
        await tx.guestIdentity.updateMany({
          where: { conversationId: conversation.id },
          data: {
            expiresAt:
              conversation.guestHistoryPolicy === 'PERMANENT'
                ? new Date('9999-12-31T23:59:59.999Z')
                : guestAccessExpiresAt ?? deletedAt,
          },
        });
        await tx.participant.updateMany({
          where: { conversationId: conversation.id, removedAt: null },
          data: { presence: 'LEFT', leftAt: deletedAt, lastSeenAt: deletedAt },
        });
        await tx.meetingInvitation.updateMany({
          where: { conversationId: conversation.id, status: 'PENDING' },
          data: { status: 'EXPIRED', respondedAt: deletedAt },
        });
      }

      await tx.contact.updateMany({
        where: { linkedUserId: request.auth.subjectId },
        data: {
          linkedUserId: null,
          displayName: anonymizedName,
          company: null,
          email: null,
        },
      });
      await tx.friendRequest.deleteMany({
        where: {
          OR: [
            { senderId: request.auth.subjectId },
            { receiverId: request.auth.subjectId },
          ],
        },
      });
      await tx.friendship.deleteMany({
        where: {
          OR: [{ userAId: request.auth.subjectId }, { userBId: request.auth.subjectId }],
        },
      });
      await tx.meetingInvitation.deleteMany({
        where: {
          OR: [
            { inviterId: request.auth.subjectId },
            { inviteeId: request.auth.subjectId },
          ],
        },
      });
      await tx.glossaryTerm.deleteMany({ where: { ownerId: request.auth.subjectId } });
      await tx.userDevice.updateMany({
        where: { userId: request.auth.subjectId },
        data: {
          revokedAt: deletedAt,
          refreshTokenHash: null,
          refreshTokenJti: null,
        },
      });
      await tx.dataDeletionRequest.upsert({
        where: { subjectType_subjectId: { subjectType: 'USER', subjectId: request.auth.subjectId } },
        create: {
          subjectType: 'USER', subjectId: request.auth.subjectId, status: 'COMPLETED',
          steps: { database: 'COMPLETED', identity: 'ANONYMIZED', devices: 'REVOKED', sharedRecords: 'RETAINED_ANONYMIZED' },
          requestedAt: deletedAt, completedAt: deletedAt,
        },
        update: { status: 'COMPLETED', completedAt: deletedAt },
      });
      return ownedActive.map((conversation) => conversation.id);
    }, { maxWait: 10_000, timeout: 60_000 });
    for (const conversationId of endedConversationIds) {
      realtimeHub().emitToConversation(conversationId, 'room.ended', {
        conversationId,
        endedAt: deletedAt,
      });
    }
    realtimeHub().disconnectSubject(request.auth.subjectId);
    return { ok: true, data: {} };
  });
}

interface ParticipantIdentitySnapshot {
  id: string;
  conversationId: string;
  displayName: string;
  company: string | null;
}

async function anonymizeMessageCorrectionActors(
  tx: Prisma.TransactionClient,
  subjectId: string,
  participants: ParticipantIdentitySnapshot[],
  anonymizedName: string,
): Promise<void> {
  const participantIds = participants.map((participant) => participant.id);
  const actorWhere = [
    { actorSubjectId: subjectId },
    ...(participantIds.length
      ? [{ actorParticipantId: { in: participantIds } }]
      : []),
  ];
  const deciderWhere = [
    { decidedBySubjectId: subjectId },
    ...(participantIds.length
      ? [{ decidedByParticipantId: { in: participantIds } }]
      : []),
  ];
  await tx.messageCorrection.updateMany({
    where: { OR: actorWhere },
    data: {
      actorDisplayName: anonymizedName,
      actorCompany: null,
    },
  });
  await tx.messageCorrection.updateMany({
    where: { OR: deciderWhere },
    data: { deciderDisplayName: anonymizedName },
  });
}

async function anonymizeConversationSummaries(
  tx: Prisma.TransactionClient,
  participants: ParticipantIdentitySnapshot[],
  anonymizedName: string,
): Promise<void> {
  if (!participants.length) return;
  const participantIds = new Set(participants.map((participant) => participant.id));
  const pii = [...new Set(
    participants.flatMap((participant) => [participant.displayName, participant.company])
      .filter((value): value is string => Boolean(value)),
  )].sort((left, right) => right.length - left.length);
  const conversationIds = [...new Set(participants.map((participant) => participant.conversationId))];
  const summaries = await tx.conversationSummary.findMany({
    where: { conversationId: { in: conversationIds } },
  });

  for (const summary of summaries) {
    const data = {
      summary: redactIdentityText(summary.summary, pii, anonymizedName),
      participantRoster: anonymizeSummaryJson(
        summary.participantRoster,
        participantIds,
        pii,
        anonymizedName,
      ),
      coreDiscussion: anonymizeSummaryJson(
        summary.coreDiscussion,
        participantIds,
        pii,
        anonymizedName,
      ),
      partyViews: anonymizeSummaryJson(
        summary.partyViews,
        participantIds,
        pii,
        anonymizedName,
      ),
      confirmedItems: anonymizeSummaryJson(
        summary.confirmedItems,
        participantIds,
        pii,
        anonymizedName,
      ),
      actionItems: anonymizeSummaryJson(
        summary.actionItems,
        participantIds,
        pii,
        anonymizedName,
      ),
      openQuestions: anonymizeSummaryJson(
        summary.openQuestions,
        participantIds,
        pii,
        anonymizedName,
      ),
      customerRequirements: anonymizeSummaryJson(
        summary.customerRequirements,
        participantIds,
        pii,
        anonymizedName,
      ),
      products: anonymizeSummaryJson(summary.products, participantIds, pii, anonymizedName),
      specifications: anonymizeSummaryJson(
        summary.specifications,
        participantIds,
        pii,
        anonymizedName,
      ),
      quantity: anonymizeSummaryJson(summary.quantity, participantIds, pii, anonymizedName),
      price: anonymizeSummaryJson(summary.price, participantIds, pii, anonymizedName),
      delivery: anonymizeSummaryJson(summary.delivery, participantIds, pii, anonymizedName),
      paymentTerms: anonymizeSummaryJson(
        summary.paymentTerms,
        participantIds,
        pii,
        anonymizedName,
      ),
    };
    await tx.conversationSummary.update({ where: { id: summary.id }, data });
  }
}

async function anonymizeSummaryEmailRecipients(
  tx: Prisma.TransactionClient,
  participants: ParticipantIdentitySnapshot[],
  anonymizedName: string,
  deletedAt: Date,
): Promise<void> {
  const participantIds = participants.map((participant) => participant.id);
  if (!participantIds.length) return;
  await tx.summaryEmailRecipient.updateMany({
    where: {
      participantId: { in: participantIds },
      status: { in: ['PENDING', 'SENDING'] },
    },
    data: {
      status: 'FAILED',
      recipientEmail: null,
      recipientDisplayName: anonymizedName,
      recipientCompany: null,
      errorCode: 'ACCOUNT_DELETED',
      errorMessage: '收件人已注销账号',
      claimedAt: deletedAt,
    },
  });
  await tx.summaryEmailRecipient.updateMany({
    where: { participantId: { in: participantIds } },
    data: {
      recipientEmail: null,
      recipientDisplayName: anonymizedName,
      recipientCompany: null,
    },
  });
}

function anonymizeSummaryJson(
  value: Prisma.JsonValue,
  participantIds: Set<string>,
  _pii: string[],
  anonymizedName: string,
): Prisma.InputJsonValue {
  const visit = (item: unknown): unknown => {
    // Do not rewrite sourceText/translatedText/view/action text. Speaker and
    // assignee metadata are changed only on objects whose stable participant
    // reference belongs to the deleted identity.
    if (typeof item === 'string') return item;
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    const source = item as Record<string, unknown>;
    const result = Object.fromEntries(
      Object.entries(source).map(([key, child]) => [key, visit(child)]),
    );
    const referencedParticipantId = [source.id, source.participantId, source.assigneeParticipantId]
      .find((candidate): candidate is string =>
        typeof candidate === 'string' && participantIds.has(candidate));
    if (referencedParticipantId) {
      for (const key of ['displayName', 'speakerDisplayName', 'assigneeDisplayName']) {
        if (key in result) result[key] = anonymizedName;
      }
      for (const key of ['company', 'speakerCompany', 'assigneeCompany', 'userId', 'guestIdentityId']) {
        if (key in result) result[key] = null;
      }
    }
    return result;
  };
  return visit(value) as Prisma.InputJsonValue;
}

function redactIdentityText(value: string, pii: string[], anonymizedName: string): string {
  const placeholder = '\u0000identity-redacted\u0000';
  const redacted = pii.reduce(
    (current, identityValue) => current.split(identityValue).join(placeholder),
    value,
  );
  return redacted.split(placeholder).join(anonymizedName);
}

async function lockConversationsForDeletion(
  tx: Prisma.TransactionClient,
  conversationIds: string[],
): Promise<void> {
  const ids = [...new Set(conversationIds)].sort();
  if (!ids.length) return;
  await tx.$queryRaw`
    SELECT "id"
    FROM "Conversation"
    WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE
  `;
}

const defaultTerms = [
  'SPC',
  'WPC',
  'LVT',
  'EIR',
  'IXPE',
  'Wear Layer',
  'Click System',
  'Unilin',
  'Välinge',
  'MOQ',
  'OEM',
  'ODM',
  'Container',
  'Pallet',
  'Packing',
  'Thickness',
  'Square Meter',
  'Tooyei',
];

async function seedDefaultGlossary(ownerId: string): Promise<void> {
  await prisma.glossaryTerm.createMany({
    data: defaultTerms.flatMap((term) => [
      {
        ownerId,
        sourceLanguage: 'zh' as const,
        targetLanguage: 'ru' as const,
        sourceTerm: term,
        targetTerm: term,
        category: 'flooring',
      },
      {
        ownerId,
        sourceLanguage: 'ru' as const,
        targetLanguage: 'zh' as const,
        sourceTerm: term,
        targetTerm: term,
        category: 'flooring',
      },
    ]),
    skipDuplicates: true,
  });
}
