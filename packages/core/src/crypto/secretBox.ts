import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Authenticated symmetric encryption for secrets at rest (provider OAuth tokens,
 * PMDB API keys). AES-256-GCM with a random 96-bit nonce per record.
 *
 * Wire format (base64):  v1:<base64(nonce ‖ authTag ‖ ciphertext)>
 * The version prefix lets the scheme rotate without ambiguity.
 */

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Parse a 32-byte key from a base64 or hex string. Throws if the material does
 * not decode to exactly 32 bytes so a misconfigured key fails loudly at startup.
 */
export function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  let key: Buffer | null = null;

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else {
    try {
      const b64 = Buffer.from(trimmed, 'base64');
      if (b64.length === KEY_BYTES) key = b64;
    } catch {
      key = null;
    }
  }

  if (!key || key.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must decode to ${KEY_BYTES} bytes (64 hex chars or 32-byte base64). ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`SecretBox key must be ${KEY_BYTES} bytes`);
    }
    this.#key = key;
  }

  static fromEnv(raw: string): SecretBox {
    return new SecretBox(parseEncryptionKey(raw));
  }

  encrypt(plaintext: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGO, this.#key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${Buffer.concat([nonce, tag, ciphertext]).toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [version, body] = payload.split(':', 2);
    if (version !== VERSION || !body) {
      throw new Error('Unrecognised ciphertext format');
    }
    const buf = Buffer.from(body, 'base64');
    if (buf.length < NONCE_BYTES + TAG_BYTES) {
      throw new Error('Ciphertext too short');
    }
    const nonce = buf.subarray(0, NONCE_BYTES);
    const tag = buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGO, this.#key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

/** Constant-time string comparison for tokens/verification codes. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
