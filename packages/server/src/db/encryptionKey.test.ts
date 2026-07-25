import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigStartupError, SecretBox } from '@watchbridge/core';
import { createDb, type Db } from './client.js';
import { connections, users } from './schema.js';
import { assertStoredSecretsDecryptable } from './encryptionKey.js';

const keyA = Buffer.alloc(32, 1).toString('base64');
const keyB = Buffer.alloc(32, 2).toString('base64');

let db: Db;

/** Clear stored connections so each case starts from a known state. */
async function freshDb(): Promise<Db> {
  await db.orm.delete(connections);
  return db;
}

async function addConnection(provider: string, box: SecretBox): Promise<void> {
  await db.orm.insert(connections).values({
    id: `c-${provider}`,
    userId: 'u1',
    provider,
    credentials: box.encrypt(JSON.stringify({ kind: provider, accessToken: 'tok' })),
  });
}

beforeAll(async () => {
  db = await createDb('pglite://memory');
  await db.migrate();
  await db.orm.insert(users).values({ id: 'u1', email: 'u@e.com', passwordHash: 'x' });
});

afterAll(async () => {
  await db.close();
});

describe('assertStoredSecretsDecryptable', () => {
  it('passes when the key decrypts what is stored', async () => {
    await freshDb();
    const box = SecretBox.fromEnv(keyA);
    await addConnection('trakt', box);

    await expect(assertStoredSecretsDecryptable(db, box)).resolves.toBeUndefined();
  });

  it('passes when there is nothing stored yet', async () => {
    await freshDb();

    await expect(assertStoredSecretsDecryptable(db, SecretBox.fromEnv(keyA))).resolves.toBeUndefined();
  });

  it('throws a startup error when the key cannot decrypt what is stored', async () => {
    await freshDb();
    await addConnection('trakt', SecretBox.fromEnv(keyA));

    await expect(assertStoredSecretsDecryptable(db, SecretBox.fromEnv(keyB))).rejects.toBeInstanceOf(
      ConfigStartupError,
    );
  });

  it('names the affected providers and the likely cause, without leaking ciphertext', async () => {
    await freshDb();
    await addConnection('trakt', SecretBox.fromEnv(keyA));
    await addConnection('simkl', SecretBox.fromEnv(keyA));

    const err = await assertStoredSecretsDecryptable(db, SecretBox.fromEnv(keyB)).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('APP_ENCRYPTION_KEY');
    expect(message).toContain('trakt');
    expect(message).toContain('simkl');
    // The stored ciphertext must never appear in an error an operator will paste around.
    const [row] = await db.orm.select().from(connections).limit(1);
    expect(message).not.toContain(row.credentials);
  });

  it('passes when at least one stored secret decrypts, so one corrupt row is not fatal', async () => {
    await freshDb();
    const box = SecretBox.fromEnv(keyA);
    await addConnection('trakt', box);
    await db.orm.insert(connections).values({
      id: 'c-corrupt',
      userId: 'u1',
      provider: 'simkl',
      credentials: 'not-valid-ciphertext',
    });

    await expect(assertStoredSecretsDecryptable(db, box)).resolves.toBeUndefined();
  });
});
