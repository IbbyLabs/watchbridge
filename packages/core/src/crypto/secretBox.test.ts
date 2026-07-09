import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SecretBox, parseEncryptionKey, safeEqual } from './secretBox.js';

const key = randomBytes(32);

describe('SecretBox', () => {
  it('round-trips plaintext', () => {
    const box = new SecretBox(key);
    const secret = 'trakt-access-token-12345';
    expect(box.decrypt(box.encrypt(secret))).toBe(secret);
  });

  it('produces a different ciphertext each call (random nonce)', () => {
    const box = new SecretBox(key);
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('rejects a tampered ciphertext', () => {
    const box = new SecretBox(key);
    const enc = box.encrypt('do-not-tamper');
    const bytes = Buffer.from(enc.slice(3), 'base64');
    bytes[bytes.length - 1] ^= 0x01;
    const tampered = `v1:${bytes.toString('base64')}`;
    expect(() => box.decrypt(tampered)).toThrow();
  });

  it('rejects a ciphertext from a different key', () => {
    const enc = new SecretBox(key).encrypt('cross-key');
    expect(() => new SecretBox(randomBytes(32)).decrypt(enc)).toThrow();
  });

  it('rejects an unknown version prefix', () => {
    expect(() => new SecretBox(key).decrypt('v2:abc')).toThrow(/format/);
  });
});

describe('parseEncryptionKey', () => {
  it('accepts 64 hex chars', () => {
    expect(parseEncryptionKey('a'.repeat(64))).toHaveLength(32);
  });

  it('accepts 32-byte base64', () => {
    expect(parseEncryptionKey(randomBytes(32).toString('base64'))).toHaveLength(32);
  });

  it('rejects a short key', () => {
    expect(() => parseEncryptionKey('too-short')).toThrow();
  });
});

describe('safeEqual', () => {
  it('matches equal strings and rejects unequal', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
