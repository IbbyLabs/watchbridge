import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { purgeExpired, SESSION_GRACE_MS, SYNC_RUN_RETENTION_MS } from './purge.js';
import {
  emailChangeTokens,
  emailVerificationTokens,
  passwordResetTokens,
  sessions,
  syncRuns,
  syncs,
  users,
} from './schema.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const MIN = 60_000;

let db: Db;

beforeAll(async () => {
  db = await createDb('pglite://memory');
  await db.migrate();
  await db.orm.insert(users).values({ id: 'u1', email: 'u@e.com', passwordHash: 'x' });
  await db.orm
    .insert(syncs)
    .values({
      id: 's1',
      userId: 'u1',
      name: 'S',
      source: 'trakt',
      target: 'mdblist',
      dataTypes: '["history"]',
    });

  await db.orm.insert(sessions).values([
    { id: 'live', userId: 'u1', expiresAt: at(MIN) },
    { id: 'expired-in-grace', userId: 'u1', expiresAt: at(-SESSION_GRACE_MS + MIN) },
    { id: 'expired-past-grace', userId: 'u1', expiresAt: at(-SESSION_GRACE_MS - MIN) },
  ]);
  await db.orm.insert(syncRuns).values([
    {
      id: 'recent',
      syncId: 's1',
      userId: 'u1',
      trigger: 'manual',
      status: 'success',
      startedAt: at(-SYNC_RUN_RETENTION_MS + MIN),
    },
    {
      id: 'old',
      syncId: 's1',
      userId: 'u1',
      trigger: 'manual',
      status: 'success',
      startedAt: at(-SYNC_RUN_RETENTION_MS - MIN),
    },
  ]);
  for (const [table, p] of [
    [emailVerificationTokens, 'v'],
    [passwordResetTokens, 'p'],
  ] as const) {
    await db.orm.insert(table).values([
      { id: 'open', userId: 'u1', tokenHash: `${p}1`, expiresAt: at(MIN) },
      { id: 'expired', userId: 'u1', tokenHash: `${p}2`, expiresAt: at(-MIN) },
      {
        id: 'consumed',
        userId: 'u1',
        tokenHash: `${p}3`,
        expiresAt: at(MIN),
        consumedAt: at(-MIN),
      },
    ]);
  }
  await db.orm.insert(emailChangeTokens).values([
    { id: 'open', userId: 'u1', newEmail: 'n@e.com', tokenHash: 'c1', expiresAt: at(MIN) },
    { id: 'expired', userId: 'u1', newEmail: 'n@e.com', tokenHash: 'c2', expiresAt: at(-MIN) },
  ]);
});

afterAll(async () => {
  await db.close();
});

describe('purgeExpired', () => {
  it('deletes only rows past their retention period', async () => {
    expect(await purgeExpired(db, NOW)).toEqual({ sessions: 1, syncRuns: 1, tokens: 5 });

    expect((await db.orm.select().from(sessions)).map((r) => r.id).sort()).toEqual([
      'expired-in-grace',
      'live',
    ]);
    expect((await db.orm.select().from(syncRuns)).map((r) => r.id)).toEqual(['recent']);
    expect((await db.orm.select().from(emailVerificationTokens)).map((r) => r.id)).toEqual([
      'open',
    ]);
    expect((await db.orm.select().from(passwordResetTokens)).map((r) => r.id)).toEqual(['open']);
    expect((await db.orm.select().from(emailChangeTokens)).map((r) => r.id)).toEqual(['open']);
  });

  it('is a no-op on a second run', async () => {
    expect(await purgeExpired(db, NOW)).toEqual({ sessions: 0, syncRuns: 0, tokens: 0 });
  });
});
