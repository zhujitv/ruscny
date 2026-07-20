import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/lib/crypto.js';
import { generateAliyunRtcToken } from '../src/services/aliyun-rtc.js';
import { buildAliyunRealtimeUrl } from '../src/services/aliyun-realtime-translation.js';
import { validateServiceConfigurationValue } from '../src/services/service-configuration.js';

describe('encrypted administrator service configuration', () => {
  it('round-trips a credential without embedding plaintext in the envelope', () => {
    const secret = 'credential-value-that-must-not-leak';
    const envelope = encryptSecret(secret, 'master-key-with-enough-entropy-0001', 'ALIYUN_RTC_APP_KEY');
    expect(envelope).toMatch(/^v2\./);
    expect(envelope).not.toContain(secret);
    expect(decryptSecret(envelope, 'master-key-with-enough-entropy-0001', 'ALIYUN_RTC_APP_KEY')).toBe(secret);
  });

  it('rejects ciphertext tampering and the wrong master key', () => {
    const envelope = encryptSecret('credential', 'master-key-with-enough-entropy-0001', 'RESEND_API_KEY');
    const tampered = envelope.split('.');
    tampered[2] = `${tampered[2]!.startsWith('A') ? 'B' : 'A'}${tampered[2]!.slice(1)}`;
    expect(() => decryptSecret(envelope, 'different-master-key-with-entropy-0002', 'RESEND_API_KEY')).toThrow();
    expect(() => decryptSecret(envelope, 'master-key-with-enough-entropy-0001', 'ALIYUN_API_KEY')).toThrow();
    expect(() => decryptSecret(tampered.join('.'), 'master-key-with-enough-entropy-0001', 'RESEND_API_KEY')).toThrow();
  });
});

describe('administrator service endpoint allowlist', () => {
  it('accepts the provider host and rejects an arbitrary HTTPS credential sink', () => {
    expect(validateServiceConfigurationValue(
      'ALIYUN_COMPATIBLE_BASE_URL',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    )).toContain('dashscope.aliyuncs.com');
    expect(() => validateServiceConfigurationValue(
      'ALIYUN_COMPATIBLE_BASE_URL',
      'https://attacker.example/compatible-mode/v1',
    )).toThrow(/未在允许列表/);
  });
});

describe('Aliyun RTC server token', () => {
  it('builds a deterministic DingRTC 3.0 AppToken without returning the AppKey', () => {
    const input = {
      appId: 'app123',
      appKey: 'server-only-secret',
      channelId: 'fc_channel',
      userId: 'user_1',
      issueTimestamp: 1_700_000_000,
      expiresAt: 1_700_003_600,
      salt: 123_456_789,
    };
    const token = generateAliyunRtcToken(input);
    expect(token).toBe(generateAliyunRtcToken(input));
    expect(token).toMatch(/^000/);
    expect(token).not.toContain(input.appKey);
    const payload = inflateSync(Buffer.from(token.slice(3), 'base64'));
    expect(payload.readInt32BE(0)).toBe(32);
    expect(payload.length).toBeGreaterThan(64);
  });
});

describe('Aliyun China realtime translation endpoint', () => {
  it('binds the Beijing workspace hostname and model without exposing credentials', () => {
    const url = buildAliyunRealtimeUrl(
      'wss://cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
      'workspace-123',
      'qwen3.5-livetranslate-flash-realtime',
    );
    expect(url).toBe(
      'wss://workspace-123.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime',
    );
    expect(url).not.toContain('api-key');
  });

  it('rejects non-WSS and non-Aliyun endpoints', () => {
    expect(() => buildAliyunRealtimeUrl(
      'https://cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
      'workspace-123',
      'qwen3.5-livetranslate-flash-realtime',
    )).toThrow(/must use wss/);
    expect(() => buildAliyunRealtimeUrl(
      'wss://attacker.example/realtime',
      'workspace-123',
      'qwen3.5-livetranslate-flash-realtime',
    )).toThrow(/not allowed/);
  });
});
