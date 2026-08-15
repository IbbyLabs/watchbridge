import { itemKey } from '@watchbridge/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import { repairIntents, syncs, users } from './schema.js';

/**
 * A pending intent is the only record that an item was removed from someone's
 * history and not yet put back. Anything that can delete it without knowing what
 * it is turns a recoverable interruption into a lost watch, so the table's
 * relationships are worth asserting rather than reading off the schema.
 */

let db: Db;

beforeAll(async () => {
  db = await createDb('pglite://memory');
  await db.migrate();
});

afterAll(async () => {
  await db.close?.();
});

async function seed(): Promise<void> {
  await db.orm.delete(repairIntents);
  await db.orm.delete(syncs);
  await db.orm.delete(users);
  await db.orm.insert(users).values({ id: 'u1', email: 'u@e.com', passwordHash: 'x' });
  await db.orm.insert(syncs).values({
    id: 's1',
    userId: 'u1',
    name: 'n',
    source: 'trakt',
    target: 'simkl',
    dataTypes: '["history"]',
  });
  await db.orm.insert(repairIntents).values({
    id: 'i1',
    userId: 'u1',
    syncId: 's1',
    target: 'simkl',
    itemKey: itemKey({ kind: 'movie', ids: { tmdb: 550 } })!,
    ref: '{"kind":"movie","ids":{"tmdb":550}}',
    watchedAt: '2019-05-19T20:00:00Z',
  });
}

const count = async (): Promise<number> => {
  const [row] = await db.orm.select({ n: sql<number>`count(*)::int` }).from(repairIntents);
  return row?.n ?? 0;
};

describe('a pending repair intent', () => {
  it('outlives the sync it belongs to', async () => {
    await seed();
    expect(await count()).toBe(1);
    await db.orm.delete(syncs).where(eq(syncs.id, 's1'));
    expect(await count()).toBe(1);
  });

  // The account is gone, so there is nothing left to restore anything for.
  it('goes when the account does', async () => {
    await seed();
    await db.orm.delete(users).where(eq(users.id, 'u1'));
    expect(await count()).toBe(0);
  });
});
