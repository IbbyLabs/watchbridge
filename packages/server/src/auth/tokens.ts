import { createHash, randomBytes } from 'node:crypto';

/** A high-entropy opaque token plus its storage hash. */
export interface OpaqueToken {
  raw: string;
  hash: string;
}

export function newOpaqueToken(bytes = 32): OpaqueToken {
  const raw = randomBytes(bytes).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
