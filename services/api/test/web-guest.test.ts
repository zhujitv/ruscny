import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, requestLogUrl } from '../src/app.js';
import { normalizeMimeType, validateMimeType } from '../src/routes/messages.js';
import { isInviteTokenPathSegment } from '../src/routes/web-guest.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('browser guest meeting client', () => {
  it('serves a no-store same-origin join page without reflecting the capability', async () => {
    app = await buildApp({ logger: false, realtime: false });
    const token = 'browser_invite_token_1234567890';
    const response = await app.inject({ method: 'GET', url: `/join/${token}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(response.headers['content-security-policy']).not.toContain("connect-src 'none'");
    expect(response.body).toContain('/socket.io/socket.io.js');
    expect(response.body).toContain('id="guest-form"');
    expect(response.body).toContain('src="/logo-mark.svg"');
    expect(response.body).toContain('<strong>RUSCNY</strong>');
    expect(response.body).toContain('无需安装，直接加入会议');
    expect(response.body).not.toContain('TOOYEI');
    expect(response.body).not.toContain(token);
  });

  it('keeps the mobile guest heading and lead free of orphaned final characters', async () => {
    app = await buildApp({ logger: false, realtime: false });
    const response = await app.inject({ method: 'GET', url: '/join/styles.css' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('text-wrap: balance');
    expect(response.body).toContain('font-size: clamp(26px, 7vw, 32px)');
  });

  it('serves the client bundle with realtime, audio and review event support', async () => {
    app = await buildApp({ logger: false, realtime: false });
    const response = await app.inject({ method: 'GET', url: '/join/app.js' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/javascript');
    expect(response.body).toContain("socket.emit('room.join'");
    expect(response.body).toContain("'translation.review.updated'");
    expect(response.body).toContain("fetch('/v1/auth/guest/refresh'");
    expect(response.body).toContain('navigator.mediaDevices.getUserMedia');
    expect(response.body).toContain('messageStatusRank(current?.status) > messageStatusRank(message.status)');
    expect(response.body).toContain('if (context.cancelled || state.terminal || state.ended) return');
    expect(response.body).toContain('await pullAllMessages(contiguousCommittedSequence())');
    expect(response.body).toContain("headers: { Authorization: `Bearer ${state.session.accessToken}` }");
    expect(response.body).toContain('/export?format=txt');
  });

  it('validates invitation path segments and redacts them from request logs', () => {
    const token = 'browser_invite_token_1234567890';
    expect(isInviteTokenPathSegment(token)).toBe(true);
    expect(isInviteTokenPathSegment('too-short')).toBe(false);
    expect(isInviteTokenPathSegment('bad.token.with.dots')).toBe(false);
    expect(requestLogUrl(`/join/${token}?source=qr`)).toBe('/join/[redacted]');
  });

  it('accepts MediaRecorder WebM/Opus while retaining extension validation', () => {
    expect(() => validateMimeType('audio/webm;codecs=opus', 'speech.webm')).not.toThrow();
    expect(normalizeMimeType('audio/webm;codecs=opus', 'speech.webm')).toBe('audio/webm');
    expect(normalizeMimeType('application/octet-stream', 'speech.webm')).toBe('audio/webm');
    expect(() => validateMimeType('audio/webm', 'speech.exe')).toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO' }),
    );
  });
});
