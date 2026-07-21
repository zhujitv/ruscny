import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { prisma } from '../../src/db.js';
import { PROCESSING_LEASE_MS } from '../../src/services/message-processing.js';
import {
  emailVerificationTokenHash,
  userPasswordResetTokenHash,
} from '../../src/services/account-emails.js';
import {
  friendCallActiveHeartbeatTimeoutMs,
  friendCallHeartbeatExpiredWhere,
  friendCallHeartbeatFreshWhere,
} from '../../src/services/friend-call-liveness.js';

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; role: 'USER'; displayName: string; email: string };
}

let app: FastifyInstance;
let origin: string;
let counter = 0;

beforeAll(async () => {
  await prisma.$connect();
  app = await buildApp({ logger: false, realtime: true });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind TCP');
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe.sequential('PostgreSQL API isolation and concurrency', () => {
  it('keeps NULL-heartbeat calls fresh during the post-acceptance grace period', async () => {
    const caller = await register('liveness-caller', 'zh');
    const callee = await register('liveness-callee', 'ru');
    const now = new Date();
    const stale = new Date(
      now.getTime() - friendCallActiveHeartbeatTimeoutMs - 1_000,
    );
    const call = await prisma.friendCall.create({
      data: {
        callerId: caller.user.id,
        calleeId: callee.user.id,
        callerDeviceId: deviceId('liveness-caller'),
        calleeDeviceId: deviceId('liveness-callee'),
        channelId: `integration-friend-call-${++counter}`,
        status: 'ACTIVE',
        mediaType: 'VIDEO',
        livenessVersion: 2,
        acceptedAt: now,
        lastHeartbeatAt: now,
      },
    });

    await expectLivenessMatches(call.id, now, { expired: 0, fresh: 1 });
    const refreshed = await prisma.friendCall.updateMany({
      where: {
        id: call.id,
        status: 'ACTIVE',
        AND: friendCallHeartbeatFreshWhere(now),
      },
      data: { lastHeartbeatAt: now },
    });
    expect(refreshed.count).toBe(1);

    await prisma.friendCall.update({
      where: { id: call.id },
      data: {
        acceptedAt: stale,
        callerHeartbeatAt: null,
        calleeHeartbeatAt: null,
      },
    });
    await expectLivenessMatches(call.id, now, { expired: 1, fresh: 0 });

    await prisma.friendCall.update({
      where: { id: call.id },
      data: {
        callerHeartbeatAt: now,
        calleeHeartbeatAt: now,
      },
    });
    await expectLivenessMatches(call.id, now, { expired: 0, fresh: 1 });

    await prisma.friendCall.update({
      where: { id: call.id },
      data: {
        acceptedAt: now,
        callerHeartbeatAt: stale,
        calleeHeartbeatAt: now,
      },
    });
    await expectLivenessMatches(call.id, now, { expired: 1, fresh: 0 });
  });

  it('requires email activation and revokes every session after an emailed password reset', async () => {
    const label = `email-flow-${++counter}`;
    const email = `${label}@example.test`;
    const device = deviceId(label);
    const registration = await request('POST', '/v1/auth/register', undefined, {
      displayName: 'Email Flow',
      email,
      password: 'integration-password-123',
      deviceId: device,
    });
    expect(registration.statusCode).toBe(200);
    expect(registration.json().data.verificationRequired).toBe(true);

    const blocked = await request('POST', '/v1/auth/login', undefined, {
      email,
      password: 'integration-password-123',
      deviceId: device,
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('EMAIL_NOT_VERIFIED');

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const verificationToken = 'integration-email-verification-token-0001';
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: emailVerificationTokenHash(verificationToken),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect((await request('POST', '/v1/auth/email/verify', undefined, {
      token: verificationToken,
    })).statusCode).toBe(200);

    const login = await request('POST', '/v1/auth/login', undefined, {
      email,
      password: 'integration-password-123',
      deviceId: device,
    });
    expect(login.statusCode).toBe(200);
    const session = login.json().data as Session;

    const resetToken = 'integration-user-password-reset-token-0001';
    await prisma.userPasswordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: userPasswordResetTokenHash(resetToken),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect((await request('POST', '/v1/auth/password/reset/email', undefined, {
      token: resetToken,
      newPassword: 'replacement-password-456',
    })).statusCode).toBe(200);
    expect((await request('GET', '/v1/auth/me', session.accessToken)).statusCode).toBe(401);
    expect((await request('POST', '/v1/auth/login', undefined, {
      email,
      password: 'replacement-password-456',
      deviceId: device,
    })).statusCode).toBe(200);
  });

  it('isolates user data and lets every registered user host meetings they create', async () => {
    const hostA = await register('host-a', 'zh');
    const hostB = await register('host-b', 'zh');
    const contactA = await createContact(hostA, 'Ivan A');
    const contactB = await createContact(hostB, 'Ivan B');

    const crossHost = await request('POST', '/v1/conversations', hostA.accessToken, {
      contactId: contactB.id,
      title: 'must not exist',
    });
    expect(crossHost.statusCode).toBe(404);

    const conversation = await createConversation(hostA, contactA.id);
    const customerA = await register('customer-a', 'ru');
    const outsider = await register('customer-b', 'ru');
    expect(
      (await request('POST', '/v1/conversations/join', customerA.accessToken, {
        roomToken: conversation.roomToken,
      })).statusCode,
    ).toBe(200);

    const hidden = await request(
      'GET',
      `/v1/conversations/${conversation.id}`,
      outsider.accessToken,
    );
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().code).toBe('CONVERSATION_NOT_FOUND');

    const customerOwnedContact = await createContact(customerA, 'Customer-owned contact');
    const customerOwnedConversation = await createConversation(
      customerA,
      customerOwnedContact.id,
    );
    const customerAsHost = await prisma.participant.findFirstOrThrow({
      where: {
        conversationId: customerOwnedConversation.id,
        userId: customerA.user.id,
      },
    });
    expect(customerAsHost.role).toBe('HOST');
  });

  it('rotates one refresh token atomically under concurrent reuse', async () => {
    const session = await register('refresh-host', 'zh');
    const payload = {
      refreshToken: session.refreshToken,
      deviceId: deviceId('refresh-host'),
    };
    const responses = await Promise.all([
      request('POST', '/v1/auth/refresh', undefined, payload),
      request('POST', '/v1/auth/refresh', undefined, payload),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    const winner = responses.find((response) => response.statusCode === 200);
    expect(winner).toBeDefined();
    const winnerAccessToken = winner!.json().data.accessToken as string;
    const revokedWinner = await request('GET', '/v1/auth/me', winnerAccessToken);
    expect(revokedWinner.statusCode).toBe(401);
    expect(revokedWinner.json().code).toBe('DEVICE_REVOKED');
  });

  it('does not revive an old access token when the same device logs in again', async () => {
    const original = await register('session-generation', 'ru');
    const login = await request('POST', '/v1/auth/login', undefined, {
      email: original.user.email,
      password: 'integration-password-123',
      deviceId: deviceId('session-generation'),
      platform: 'IOS',
    });
    expect(login.statusCode).toBe(200);
    const replacement = login.json().data as Session;

    const oldRefresh = await request('POST', '/v1/auth/refresh', undefined, {
      refreshToken: original.refreshToken,
      deviceId: deviceId('session-generation'),
    });
    expect(oldRefresh.statusCode).toBe(401);
    expect(oldRefresh.json().code).toBe('REFRESH_TOKEN_INVALID');

    const oldAccess = await request('GET', '/v1/auth/me', original.accessToken);
    expect(oldAccess.statusCode).toBe(401);
    expect(oldAccess.json().code).toBe('DEVICE_REVOKED');
    expect((await request('GET', '/v1/auth/me', replacement.accessToken)).statusCode).toBe(200);
    expect((await request('POST', '/v1/auth/refresh', undefined, {
      refreshToken: replacement.refreshToken,
      deviceId: deviceId('session-generation'),
    })).statusCode).toBe(200);
    const device = await prisma.userDevice.findUniqueOrThrow({
      where: {
        userId_deviceId: {
          userId: original.user.id,
          deviceId: deviceId('session-generation'),
        },
      },
    });
    expect(device.platform).toBe('IOS');
  });

  it('allows four Chinese users and one Russian guest to join concurrently', async () => {
    const host = await register('race-host', 'zh');
    const contact = await createContact(host, 'Race Contact');
    const conversation = await createConversation(host, contact.id);
    const chineseParticipants = await Promise.all([
      register('race-customer-a', 'ru'),
      register('race-customer-b', 'ru'),
      register('race-customer-c', 'ru'),
      register('race-customer-d', 'ru'),
    ]);

    const responses = await Promise.all([
      ...chineseParticipants.map((participant) =>
        request('POST', '/v1/conversations/join', participant.accessToken, {
          roomToken: conversation.roomToken,
          displayName: participant.user.displayName,
          company: 'China Flooring Group',
          preferredLanguage: 'zh',
        })),
      request('POST', '/v1/auth/guest', undefined, {
        displayName: 'Russian Guest',
        company: 'RU Trade',
        email: 'race-russian-guest@example.test',
        preferredLanguage: 'ru',
        deviceId: deviceId('race-russian-guest'),
        roomToken: conversation.roomToken,
      }),
    ]);
    expect(
      responses.map((response) => response.statusCode),
      responses.map((response) => response.body).join('\n'),
    ).toEqual([200, 200, 200, 200, 200]);
    const participants = await prisma.participant.findMany({
      where: { conversationId: conversation.id },
      orderBy: { joinedAt: 'asc' },
    });
    expect(participants).toHaveLength(6);
    expect(participants.filter((item) => item.preferredLanguage === 'zh')).toHaveLength(5);
    expect(participants.filter((item) => item.preferredLanguage === 'ru')).toHaveLength(1);
  });

  it('supports friend requests, in-app invitations, speaker snapshots and removal isolation', async () => {
    const host = await register('social-host', 'zh');
    const invitee = await register('social-invitee', 'ru');
    const outsider = await register('social-outsider', 'ru');

    const search = await request(
      'GET',
      `/v1/users/search?q=${encodeURIComponent('social-invitee')}`,
      host.accessToken,
    );
    expect(search.statusCode).toBe(200);
    expect(search.json().data.items[0].id).toBe(invitee.user.id);

    const friendRequest = await request('POST', '/v1/friend-requests', host.accessToken, {
      receiverId: invitee.user.id,
    });
    expect(friendRequest.statusCode).toBe(200);
    const friendRequestId = friendRequest.json().data.friendRequest.id as string;
    const incoming = await request(
      'GET',
      '/v1/friend-requests?box=incoming',
      invitee.accessToken,
    );
    expect(incoming.json().data.items.map((item: any) => item.id)).toContain(friendRequestId);
    expect((await request(
      'POST',
      `/v1/friend-requests/${friendRequestId}/respond`,
      invitee.accessToken,
      { action: 'ACCEPT' },
    )).statusCode).toBe(200);
    const friends = await request('GET', '/v1/friends', host.accessToken);
    expect(friends.json().data.items[0]).toMatchObject({
      id: invitee.user.id,
      canInvite: true,
    });

    const contact = await createContact(host, 'Social Contact');
    const conversation = await createConversation(host, contact.id);
    const incompleteGuest = await request('POST', '/v1/auth/guest', undefined, {
      displayName: 'Incomplete Guest',
      deviceId: deviceId('incomplete-guest'),
      roomToken: conversation.roomToken,
    });
    expect(incompleteGuest.statusCode).toBe(400);
    expect(incompleteGuest.json().code).toBe('VALIDATION_ERROR');
    const meetingInvitation = await request(
      'POST',
      `/v1/conversations/${conversation.id}/invitations`,
      host.accessToken,
      { inviteeId: invitee.user.id },
    );
    expect(meetingInvitation.statusCode).toBe(200);
    const invitationId = meetingInvitation.json().data.invitation.id as string;
    const pendingInvitations = await request(
      'GET',
      '/v1/meeting-invitations',
      invitee.accessToken,
    );
    expect(pendingInvitations.json().data.items[0].id).toBe(invitationId);

    const accepted = await request(
      'POST',
      `/v1/meeting-invitations/${invitationId}/respond`,
      invitee.accessToken,
      {
        action: 'ACCEPT',
        displayName: 'Ivan Snapshot',
        company: 'RU Snapshot LLC',
        preferredLanguage: 'ru',
      },
    );
    expect(accepted.statusCode).toBe(200);
    const participantId = accepted.json().data.participant.participantId as string;
    expect(participantId).toBeTruthy();

    const message = await request(
      'POST',
      `/v1/conversations/${conversation.id}/messages/text`,
      invitee.accessToken,
      {
        sourceText: 'Поставка подтверждена.',
        sourceLanguage: 'ru',
        idempotencyKey: 'social-speaker-snapshot-0001',
      },
    );
    expect(message.statusCode).toBe(200);
    expect(message.json().data).toMatchObject({
      participantId,
      speakerDisplayName: 'Ivan Snapshot',
      speakerCompany: 'RU Snapshot LLC',
      speakerLanguage: 'ru',
    });
    expect((await request(
      'PATCH',
      `/v1/conversations/${conversation.id}/participants/me`,
      invitee.accessToken,
      {
        displayName: 'Ivan Renamed',
        company: 'RU Renamed LLC',
        preferredLanguage: 'ru',
      },
    )).statusCode).toBe(200);
    const history = await request(
      'GET',
      `/v1/conversations/${conversation.id}/messages`,
      invitee.accessToken,
    );
    expect(history.json().data.items[0]).toMatchObject({
      participantId,
      speakerDisplayName: 'Ivan Snapshot',
      speakerCompany: 'RU Snapshot LLC',
    });
    const exported = await request(
      'GET',
      `/v1/conversations/${conversation.id}/export?format=txt&groupBy=speaker`,
      invitee.accessToken,
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain('Ivan Snapshot｜RU Snapshot LLC｜ru');
    expect((await request(
      'DELETE',
      `/v1/conversations/${conversation.id}/participants/${participantId}`,
      host.accessToken,
    )).statusCode).toBe(200);
    for (const finalPath of [
      `/v1/conversations/${conversation.id}/messages`,
      `/v1/conversations/${conversation.id}/participants`,
      `/v1/conversations/${conversation.id}/export?format=txt`,
    ]) {
      const denied = await request('GET', finalPath, invitee.accessToken);
      expect(denied.statusCode).toBe(404);
    }
    expect((await request(
      'POST',
      '/v1/conversations/join',
      invitee.accessToken,
      { roomToken: conversation.roomToken },
    )).json().code).toBe('PARTICIPANT_REMOVED');
    expect((await request(
      'GET',
      `/v1/conversations/${conversation.id}/participants`,
      outsider.accessToken,
    )).statusCode).toBe(404);
    expect((await request(
      'POST',
      `/v1/conversations/${conversation.id}/end`,
      host.accessToken,
      {},
    )).statusCode).toBe(200);
    const summary = await request(
      'POST',
      `/v1/conversations/${conversation.id}/summary`,
      host.accessToken,
      {},
      { 'idempotency-key': 'integration-summary-generation-0001' },
    );
    expect(summary.statusCode).toBe(200);
    expect(summary.json().data.summary.participantRoster).toHaveLength(2);
    expect(summary.json().data.summary.coreDiscussion[0]).toMatchObject({
      participantId,
      speakerDisplayName: 'Ivan Snapshot',
    });
    expect((await request(
      'GET',
      `/v1/conversations/${conversation.id}/summary`,
      invitee.accessToken,
    )).statusCode).toBe(404);
    expect((await request(
      'DELETE',
      `/v1/friends/${invitee.user.id}`,
      host.accessToken,
    )).statusCode).toBe(200);
  });

  it('linearizes a customer join against ending the meeting', async () => {
    const host = await register('end-race-host', 'zh');
    const contact = await createContact(host, 'End Race Contact');
    const conversation = await createConversation(host, contact.id);
    const customer = await register('end-race-customer', 'ru');

    const [join, end] = await Promise.all([
      request('POST', '/v1/conversations/join', customer.accessToken, {
        roomToken: conversation.roomToken,
      }),
      request('POST', `/v1/conversations/${conversation.id}/end`, host.accessToken, {}),
    ]);
    expect(end.statusCode).toBe(200);
    expect([200, 403]).toContain(join.statusCode);
    expect((await prisma.conversation.findUniqueOrThrow({
      where: { id: conversation.id },
    })).status).toBe('ENDED');

    const afterEnd = await request('POST', '/v1/conversations/join', customer.accessToken, {
      roomToken: conversation.roomToken,
    });
    expect(afterEnd.statusCode).toBe(403);
    expect(afterEnd.json().code).toBe('ROOM_EXPIRED');
  });

  it('keeps duplicate messages single and makes an ended room read-only', async () => {
    const host = await register('message-host', 'zh');
    const contact = await createContact(host, 'Message Contact');
    const conversation = await createConversation(host, contact.id);
    const customer = await register('message-customer', 'ru');
    await request('POST', '/v1/conversations/join', customer.accessToken, {
      roomToken: conversation.roomToken,
    });

    const first = await request(
      'POST',
      `/v1/conversations/${conversation.id}/messages/text`,
      host.accessToken,
      {
        sourceText: '这个产品有库存。',
        sourceLanguage: 'zh',
        idempotencyKey: 'integration-message-key-0001',
      },
    );
    const duplicate = await request(
      'POST',
      `/v1/conversations/${conversation.id}/messages/text`,
      host.accessToken,
      {
        sourceText: '这个产品有库存。',
        sourceLanguage: 'zh',
        idempotencyKey: 'integration-message-key-0001',
      },
    );
    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().data.id).toBe(first.json().data.id);
    expect(await prisma.translationMessage.count()).toBe(1);

    const keyReuse = await request(
      'POST',
      `/v1/conversations/${conversation.id}/messages/text`,
      host.accessToken,
      {
        sourceText: '这段文字不能复用同一幂等键',
        sourceLanguage: 'zh',
        idempotencyKey: 'integration-message-key-0001',
      },
    );
    expect(keyReuse.statusCode).toBe(409);
    expect(keyReuse.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await prisma.translationMessage.count()).toBe(1);

    await prisma.translationMessage.update({
      where: { id: first.json().data.id },
      data: {
        status: 'FAILED',
        sourceText: '',
        translatedText: '',
        audioUrl: null,
        errorCode: 'PROVIDER_TIMEOUT',
        errorMessage: 'simulated recoverable failure',
      },
    });
    const recovered = await request(
      'POST',
      `/v1/conversations/${conversation.id}/messages/text`,
      host.accessToken,
      {
        sourceText: '这个产品有库存。',
        sourceLanguage: 'zh',
        idempotencyKey: 'integration-message-key-0001',
      },
    );
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().data.id).toBe(first.json().data.id);
    expect(recovered.json().data.status).toBe('FINAL');
    expect(recovered.json().data.sequence).toBe(first.json().data.sequence);
    expect(await prisma.translationMessage.count()).toBe(1);

    const multipart = new FormData();
    // Keep the mobile client's historical file-first order: the backend must
    // collect later fields rather than depending on multipart part ordering.
    multipart.append('audio', new Blob([Buffer.from('mock-wav')], { type: 'audio/wav' }), 'voice.wav');
    multipart.append('sourceLanguage', 'zh');
    multipart.append('targetLanguage', 'ru');
    multipart.append('mockSourceText', '这个产品有库存。');
    const audioResponse = await fetch(
      `${origin}/v1/conversations/${conversation.id}/audio`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${host.accessToken}`,
          'Idempotency-Key': 'integration-audio-key-0001',
        },
        body: multipart,
      },
    );
    expect(audioResponse.status).toBe(200);
    expect((await audioResponse.json() as any).data.status).toBe('FINAL');

    expect(
      (await request('POST', `/v1/conversations/${conversation.id}/end`, host.accessToken, {}))
        .statusCode,
    ).toBe(200);
    const afterEnd = await request(
      'POST',
      `/v1/conversations/${conversation.id}/messages/text`,
      host.accessToken,
      {
        sourceText: '会议结束后不能发送',
        sourceLanguage: 'zh',
        idempotencyKey: 'integration-message-key-0002',
      },
    );
    expect(afterEnd.statusCode).toBe(403);
    expect(afterEnd.json().code).toBe('ROOM_NOT_ACTIVE');
  });

  it('rejects an invitation after its database expiry boundary', async () => {
    const host = await register('expiry-host', 'zh');
    const contact = await createContact(host, 'Expiry Contact');
    const conversation = await createConversation(host, contact.id);
    const customer = await register('expiry-customer', 'ru');
    expect((await request('POST', '/v1/conversations/join', customer.accessToken, {
      roomToken: conversation.roomToken,
    })).statusCode).toBe(200);
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const staleActiveAccess = await request(
      'GET',
      `/v1/conversations/${conversation.id}/messages`,
      customer.accessToken,
    );
    expect(staleActiveAccess.statusCode).toBe(403);
    expect(staleActiveAccess.json().code).toBe('ROOM_EXPIRED');

    const response = await request('POST', '/v1/auth/guest', undefined, {
      displayName: 'Expired Guest',
      company: 'Expired LLC',
      email: 'expired-guest@example.test',
      preferredLanguage: 'ru',
      deviceId: deviceId('expired-guest'),
      inviteToken: conversation.roomToken,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('ROOM_EXPIRED');
  });

  it('rotates invitation credentials once and enforces Host/state boundaries', async () => {
    const host = await register('rotate-invite-host', 'zh');
    const customer = await register('rotate-invite-customer', 'ru');
    const contact = await createContact(host, 'Rotate Invite Contact');
    const conversation = await createConversation(host, contact.id);

    const forbiddenRotate = await request(
      'POST',
      `/v1/conversations/${conversation.id}/invitation/rotate`,
      customer.accessToken,
      {},
    );
    expect(forbiddenRotate.statusCode).toBe(404);
    expect(forbiddenRotate.json().code).toBe('CONVERSATION_NOT_FOUND');

    const rotated = await request(
      'POST',
      `/v1/conversations/${conversation.id}/invitation/rotate`,
      host.accessToken,
      {},
    );
    expect(rotated.statusCode).toBe(200);
    expect(rotated.headers['cache-control']).toBe('private, no-store');
    const invitation = rotated.json().data as {
      conversationId: string;
      roomToken: string;
      roomCode: string;
      inviteUrl: string;
    };
    expect(invitation.conversationId).toBe(conversation.id);
    expect(invitation.roomToken).not.toBe(conversation.roomToken);
    expect(invitation.roomCode).not.toBe(conversation.roomCode);
    expect(invitation.inviteUrl).toContain(`/join/${invitation.roomToken}`);

    const oldToken = await request('POST', '/v1/conversations/join', customer.accessToken, {
      roomToken: conversation.roomToken,
    });
    expect(oldToken.statusCode).toBe(404);
    expect(oldToken.json().code).toBe('ROOM_NOT_FOUND');
    const oldCode = await request('POST', '/v1/conversations/join', customer.accessToken, {
      roomCode: conversation.roomCode,
    });
    expect(oldCode.statusCode).toBe(404);
    expect((await request('POST', '/v1/conversations/join', customer.accessToken, {
      roomToken: invitation.roomToken,
    })).statusCode).toBe(200);

    expect((await request(
      'POST',
      `/v1/conversations/${conversation.id}/end`,
      host.accessToken,
      {},
    )).statusCode).toBe(200);
    const endedRotate = await request(
      'POST',
      `/v1/conversations/${conversation.id}/invitation/rotate`,
      host.accessToken,
      {},
    );
    expect(endedRotate.statusCode).toBe(409);
    expect(endedRotate.json().code).toBe('ROOM_ENDED');

    const expired = await createConversation(host, contact.id);
    await prisma.conversation.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const expiredRotate = await request(
      'POST',
      `/v1/conversations/${expired.id}/invitation/rotate`,
      host.accessToken,
      {},
    );
    expect(expiredRotate.statusCode).toBe(403);
    expect(expiredRotate.json().code).toBe('ROOM_EXPIRED');
  });

  it('keeps a logged-out Guest token revoked after the same device rejoins', async () => {
    const host = await register('guest-session-host', 'zh');
    const contact = await createContact(host, 'Guest Session Contact');
    const conversation = await createConversation(host, contact.id);
    const guestDeviceId = deviceId('guest-session-device');
    const first = await request('POST', '/v1/auth/guest', undefined, {
      displayName: 'Guest Session',
      company: 'Guest LLC',
      email: 'guest-session@example.test',
      preferredLanguage: 'ru',
      deviceId: guestDeviceId,
      inviteToken: conversation.roomToken,
    });
    expect(first.statusCode).toBe(200);
    const firstToken = first.json().data.accessToken as string;
    expect((await request('GET', '/v1/auth/me', firstToken)).statusCode).toBe(200);

    expect((await request('POST', '/v1/auth/logout', firstToken, {
      refreshToken: null,
    })).statusCode).toBe(200);
    expect((await request('GET', '/v1/auth/me', firstToken)).statusCode).toBe(401);

    const second = await request('POST', '/v1/auth/guest', undefined, {
      displayName: 'Guest Session',
      company: 'Guest LLC',
      email: 'guest-session@example.test',
      preferredLanguage: 'ru',
      deviceId: guestDeviceId,
      inviteToken: conversation.roomToken,
    });
    expect(second.statusCode).toBe(200);
    const secondToken = second.json().data.accessToken as string;
    expect(secondToken).not.toBe(firstToken);
    const resurrectedOld = await request('GET', '/v1/auth/me', firstToken);
    expect(resurrectedOld.statusCode).toBe(401);
    expect(resurrectedOld.json().code).toBe('GUEST_TOKEN_REVOKED');
    expect((await request('GET', '/v1/auth/me', secondToken)).statusCode).toBe(200);
  });

  it('recovers stale PROCESSING gaps before Socket and REST backfill reads', async () => {
    const host = await register('stale-message-host', 'zh');
    const customer = await register('stale-message-customer', 'ru');
    const contact = await createContact(host, 'Stale Message Contact');
    const conversation = await createConversation(host, contact.id);
    expect((await request('POST', '/v1/conversations/join', customer.accessToken, {
      roomToken: conversation.roomToken,
    })).statusCode).toBe(200);
    const speaker = await prisma.participant.findFirstOrThrow({
      where: { conversationId: conversation.id, userId: host.user.id },
    });
    const staleAt = new Date(Date.now() - PROCESSING_LEASE_MS - 1_000);
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { maxSequence: 2 },
    });
    const stale = await prisma.translationMessage.create({
      data: {
        conversationId: conversation.id,
        participantId: speaker.id,
        speakerRole: 'HOST',
        speakerDisplayName: speaker.displayName,
        speakerCompany: speaker.company,
        speakerLanguage: speaker.preferredLanguage,
        sourceLanguage: 'zh',
        targetLanguage: 'ru',
        sequence: 1,
        idempotencyKey: 'stale-backfill-message-0001',
        requestHash: 'stale-request-hash-1',
        status: 'PROCESSING',
        updatedAt: staleAt,
      },
    });
    const active = await prisma.translationMessage.create({
      data: {
        conversationId: conversation.id,
        participantId: speaker.id,
        speakerRole: 'HOST',
        speakerDisplayName: speaker.displayName,
        speakerCompany: speaker.company,
        speakerLanguage: speaker.preferredLanguage,
        sourceLanguage: 'zh',
        targetLanguage: 'ru',
        sequence: 2,
        idempotencyKey: 'active-backfill-message-0002',
        requestHash: 'active-request-hash-2',
        status: 'PROCESSING',
      },
    });

    // @ts-expect-error bundled integration-only module has no adjacent declarations
    const { io } = await import('../../../../node_modules/socket.io/client-dist/socket.io.esm.min.js');
    const socket = io(origin, {
      transports: ['websocket'],
      auth: { token: customer.accessToken },
      reconnection: false,
      forceNew: true,
    });
    await once(socket, 'connect');
    const joined = await new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('room.join timeout')), 5_000);
      socket.emit('room.join', { conversationId: conversation.id, lastSequence: 0 }, (ack: any) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
    expect(joined.ok).toBe(true);
    expect(joined.data.latestSequence).toBe(0);
    expect(joined.data.missingMessages.map((message: any) => [
      message.sequence,
      message.status,
      message.errorCode,
    ])).toEqual([]);
    expect((await prisma.translationMessage.findUniqueOrThrow({
      where: { id: stale.id },
    })).status).toBe('FAILED');
    expect((await prisma.translationMessage.findUniqueOrThrow({
      where: { id: active.id },
    })).status).toBe('PROCESSING');
    socket.close();

    await prisma.translationMessage.update({
      where: { id: active.id },
      data: { updatedAt: staleAt },
    });
    const backfill = await request(
      'GET',
      `/v1/conversations/${conversation.id}/messages?afterSequence=0`,
      host.accessToken,
    );
    expect(backfill.statusCode).toBe(200);
    expect(backfill.json().data.items.map((message: any) => [
      message.sequence,
      message.status,
      message.errorCode,
    ])).toEqual([]);
  });
});

describe.sequential('Socket.IO authentication and backfill', () => {
  it('rejects an invalid handshake and backfills one authorized room in sequence', async () => {
    // The server package ships the matching official browser/Node ESM client bundle.
    // @ts-expect-error bundled integration-only module has no adjacent declarations
    const { io } = await import('../../../../node_modules/socket.io/client-dist/socket.io.esm.min.js');

    const invalid = io(origin, {
      transports: ['websocket'],
      auth: { token: 'invalid-token' },
      reconnection: false,
      forceNew: true,
    });
    const invalidCode = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect_error timeout')), 5_000);
      invalid.on('connect_error', (error: { data?: { code?: string } }) => {
        clearTimeout(timer);
        resolve(error.data?.code ?? '');
      });
    });
    invalid.close();
    expect(invalidCode).toBe('TOKEN_INVALID');

    const host = await register('socket-host', 'zh');
    const contact = await createContact(host, 'Socket Contact');
    const conversation = await createConversation(host, contact.id);
    const customer = await register('socket-customer', 'ru');
    await request('POST', '/v1/conversations/join', customer.accessToken, {
      roomToken: conversation.roomToken,
    });
    await request(
      'POST',
      `/v1/conversations/${conversation.id}/messages/text`,
      host.accessToken,
      {
        sourceText: '这个产品有库存。',
        sourceLanguage: 'zh',
        idempotencyKey: 'socket-backfill-message-0001',
      },
    );

    const socket = io(origin, {
      transports: ['websocket'],
      auth: { token: customer.accessToken },
      reconnection: false,
      forceNew: true,
    });
    await once(socket, 'connect');
    const joined = await new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('room.join timeout')), 5_000);
      socket.emit(
        'room.join',
        { conversationId: conversation.id, lastSequence: 0 },
        (ack: Record<string, any>) => {
          clearTimeout(timer);
          resolve(ack);
        },
      );
    });
    expect(joined.ok).toBe(true);
    expect(joined.data.conversationId).toBe(conversation.id);
    expect(joined.data.missingMessages).toHaveLength(1);
    expect(joined.data.missingMessages[0].sequence).toBe(1);
    expect(joined.data.participants).toHaveLength(2);

    const disconnected = once(socket, 'disconnect');
    const removed = await request(
      'DELETE',
      `/v1/conversations/${conversation.id}/participants/${joined.data.participantId}`,
      host.accessToken,
    );
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data.participantId).toBe(joined.data.participantId);
    await disconnected;
    expect(
      (await request('GET', `/v1/conversations/${conversation.id}`, customer.accessToken))
        .statusCode,
    ).toBe(404);
    const rejoin = await request('POST', '/v1/conversations/join', customer.accessToken, {
      roomToken: conversation.roomToken,
    });
    expect(rejoin.statusCode).toBe(403);
    expect(rejoin.json().code).toBe('PARTICIPANT_REMOVED');

    const changedDeviceWithOldInvite = await request('POST', '/v1/auth/guest', undefined, {
      displayName: 'Changed Device',
      company: 'Changed Device LLC',
      email: 'changed-device@example.test',
      preferredLanguage: 'ru',
      deviceId: deviceId('changed-device-old-invite'),
      inviteToken: conversation.roomToken,
    });
    expect(changedDeviceWithOldInvite.statusCode).toBe(200);

    const replacementGuest = await request('POST', '/v1/auth/guest', undefined, {
      displayName: 'Replacement Guest',
      company: 'Replacement LLC',
      email: 'replacement-guest@example.test',
      preferredLanguage: 'ru',
      deviceId: deviceId('replacement-guest'),
      inviteToken: conversation.roomToken,
    });
    expect(replacementGuest.statusCode).toBe(200);
    socket.close();
  });

  it('disconnects a revoked device socket and continuously rejects its access token', async () => {
    // @ts-expect-error bundled integration-only module has no adjacent declarations
    const { io } = await import('../../../../node_modules/socket.io/client-dist/socket.io.esm.min.js');
    const session = await register('revoked-socket-host', 'zh');
    const socket = io(origin, {
      transports: ['websocket'],
      auth: { token: session.accessToken },
      reconnection: false,
      forceNew: true,
    });
    await once(socket, 'connect');
    const disconnected = once(socket, 'disconnect');
    const revoked = await request(
      'DELETE',
      `/v1/auth/devices/${encodeURIComponent(deviceId('revoked-socket-host'))}`,
      session.accessToken,
    );
    expect(revoked.statusCode).toBe(200);
    await disconnected;
    const afterRevoke = await request('GET', '/v1/auth/me', session.accessToken);
    expect(afterRevoke.statusCode).toBe(401);
    expect(afterRevoke.json().code).toBe('DEVICE_REVOKED');
    socket.close();
  });
});

async function expectLivenessMatches(
  callId: string,
  now: Date,
  expected: { expired: number; fresh: number },
): Promise<void> {
  const [expired, fresh] = await Promise.all([
    prisma.friendCall.count({
      where: { id: callId, ...friendCallHeartbeatExpiredWhere(now) },
    }),
    prisma.friendCall.count({
      where: { id: callId, ...friendCallHeartbeatFreshWhere(now) },
    }),
  ]);
  expect({ expired, fresh }).toEqual(expected);
}

async function register(
  label: string,
  preferredLanguage: 'zh' | 'ru',
): Promise<Session> {
  const email = `${label}-${++counter}@example.test`;
  const password = 'integration-password-123';
  const response = await request('POST', '/v1/auth/register', undefined, {
    displayName: label,
    email,
    password,
    company: `${label} LLC`,
    preferredLanguage,
    deviceId: deviceId(label),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().data.verificationRequired).toBe(true);
  await prisma.user.update({
    where: { email },
    data: { emailVerifiedAt: new Date() },
  });
  const login = await request('POST', '/v1/auth/login', undefined, {
    email,
    password,
    deviceId: deviceId(label),
  });
  expect(login.statusCode).toBe(200);
  return login.json().data as Session;
}

function deviceId(label: string): string {
  return `integration-device-${label}`;
}

async function createContact(session: Session, displayName: string) {
  const response = await request('POST', '/v1/contacts', session.accessToken, {
    displayName,
    company: 'Integration LLC',
  });
  expect(response.statusCode).toBe(200);
  return response.json().data as { id: string };
}

async function createConversation(session: Session, contactId: string) {
  const response = await request('POST', '/v1/conversations', session.accessToken, {
    contactId,
    title: 'Integration meeting',
  });
  expect(response.statusCode).toBe(200);
  return response.json().data.conversation as {
    id: string;
    roomToken: string;
    roomCode: string;
  };
}

function request(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  accessToken?: string,
  payload?: object,
  headers?: Record<string, string>,
) {
  return app.inject({
    method,
    url,
    remoteAddress: `127.0.0.${(counter % 200) + 1}`,
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    ...(payload ? { payload } : {}),
  });
}

function once(socket: any, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timeout`)), 5_000);
    socket.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
