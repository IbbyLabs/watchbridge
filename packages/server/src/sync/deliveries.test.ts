import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaRef } from '@watchbridge/core';
import { createDb, type Db } from '../db/client.js';
import { users, syncs } from '../db/schema.js';
import { DeliveriesStore } from './deliveries.js';

let db: Db;
let store: DeliveriesStore;

beforeAll(async () => {
  db = await createDb('pglite://memory');
  await db.migrate();
  store = new DeliveriesStore(db);
  await db.orm.insert(users).values({ id: 'u1', email: 'u@e.com', passwordHash: 'x' });
  await db.orm.insert(syncs).values({ id: 's1', userId: 'u1', name: 'S', source: 'trakt', target: 'simkl', dataTypes: '["history"]' });
});

afterAll(async () => {
  await db.close();
});

const ep = (season: number, number: number): MediaRef => ({ kind: 'episode', ids: { tmdb: 78173 }, season, number });

describe('DeliveriesStore', () => {
  it('records and loads refs scoped by (sync, target)', async () => {
    await store.record('s1', 'u1', 'simkl', [ep(1, 1), ep(1, 2)]);
    const loaded = await store.load('s1', 'simkl');
    expect(loaded).toHaveLength(2);
    expect(loaded).toContainEqual(ep(1, 1));
    // A different target scope is isolated.
    expect(await store.load('s1', 'trakt')).toHaveLength(0);
  });

  it('is idempotent — re-recording the same item does not duplicate', async () => {
    await store.record('s1', 'u1', 'simkl', [ep(1, 1), ep(1, 3)]);
    const loaded = await store.load('s1', 'simkl');
    // ep(1,1) already recorded, ep(1,3) is new → 3 total, not 4.
    expect(loaded).toHaveLength(3);
  });

  it('skips refs with no usable id rather than throwing', async () => {
    await store.record('s1', 'u1', 'simkl', [{ kind: 'movie', ids: {}, title: 'No Id' }]);
    expect(await store.load('s1', 'simkl')).toHaveLength(3); // unchanged
  });
});
