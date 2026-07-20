import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

export const randomRoomCode = () => {
  const value = randomBytes(4).readUInt32BE(0) % 100_000_000;
  return value.toString().padStart(8, '0');
};

export const stableHash = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export const secretHash = (value: string, pepper: string) =>
  stableHash(`${pepper}:${value}`);

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const ENCRYPTION_VERSION = 'v2';

/** AES-256-GCM envelope encryption for administrator-managed credentials. */
export function encryptSecret(value: string, masterKey: string, context = ''): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(masterKey), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptSecret(envelope: string, masterKey: string, context = ''): string {
  const [version, encodedIv, encodedTag, encodedValue, extra] = envelope.split('.');
  if (
    (version !== 'v1' && version !== ENCRYPTION_VERSION) || !encodedIv || !encodedTag ||
    encodedValue === undefined || extra !== undefined
  ) {
    throw new Error('Unsupported encrypted credential envelope');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(masterKey),
    Buffer.from(encodedIv, 'base64url'),
  );
  if (version === ENCRYPTION_VERSION) {
    decipher.setAAD(Buffer.from(context, 'utf8'));
  }
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function encryptionKey(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey, 'utf8').digest();
}
