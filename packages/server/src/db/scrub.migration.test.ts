import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import { syncRuns, syncs, users } from './schema.js';

/**
 * Migration 0011 clears any `sync_runs.error` that still carries a leaked API key.
 * The migrator only applies a migration once, so this runs the migration's own SQL
 * against seeded rows to prove the statement scrubs the leaking rows and spares the
 * rest.
 */
const SCRUB_SQL = readFileSync(
  fileURLToPath(new URL('../../drizzle/0011_scrub_leaked_apikeys_from_errors.sql', import.meta.url)),
  'utf8',
);

let db: Db;

beforeAll(async () => {
  db = await createDb('pglite://memory');
  await db.migrate();
  await db.orm.insert(users).values({ id: 'u1', email: 'u@e.com', passwordHash: 'x' });
  await db.orm.insert(syncs).values({
    id: 's1',
    userId: 'u1',
    name: 'S',
    source: 'trakt',
    target: 'mdblist',
    dataTypes: '["history"]',
  });
  await db.orm.insert(syncRuns).values([
    {
      id: 'leak',
      syncId: 's1',
      userId: 'u1',
      trigger: 'scheduled',
      status: 'error',
      error: 'HTTP 423 for https://api.mdblist.com/scrobble/stop?apikey=super-secret-key',
    },
    {
      id: 'clean',
      syncId: 's1',
      userId: 'u1',
      trigger: 'scheduled',
      status: 'error',
      error: 'HTTP 500 for https://api.mdblist.com/scrobble/stop',
    },
    { id: 'none', syncId: 's1', userId: 'u1', trigger: 'scheduled', status: 'error', error: null },
  ]);

  await db.orm.execute(sql.raw(SCRUB_SQL));
});

afterAll(async () => {
  await db.close();
});

const errorOf = async (id: string) =>
  (await db.orm.select().from(syncRuns).where(eq(syncRuns.id, id)))[0]!.error;

describe('the leaked-credential scrub', () => {
  it('clears a row whose error carries an apikey, keeping the key out of it', async () => {
    const after = await errorOf('leak');
    expect(after).not.toContain('super-secret-key');
    expect(after).toMatch(/contained a credential/);
  });

  it('leaves an innocent error untouched', async () => {
    expect(await errorOf('clean')).toBe('HTTP 500 for https://api.mdblist.com/scrobble/stop');
  });

  it('leaves a null error untouched', async () => {
    expect(await errorOf('none')).toBeNull();
  });
});
