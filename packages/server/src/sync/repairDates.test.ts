import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MediaRef, WatchEvent } from '@watchbridge/core';
import { createDb, type Db } from '../db/client.js';
import { deliveries, repairIntents, syncs, users } from '../db/schema.js';
import { DeliveriesStore } from './deliveries.js';
import { itemKey } from '@watchbridge/core';
import { DateRepair, looksDelivered } from './repairDates.js';

/**
 * The repair removes watch history before putting it back, so the questions
 * worth asserting are about what it declines to touch as much as what it fixes.
 */

const MOVIE: MediaRef = { kind: 'movie', ids: { tmdb: 550 } };
const DELIVERED_AT = new Date('2026-08-01T12:00:00Z');
/** What the bug wrote: the moment of the push, not of the watch. */
const WRONG = '2026-08-01T12:00:03Z';
const RIGHT = '2019-05-19T20:00:00Z';

let db: Db;

/** A provider that records what it was asked to do. */
function fakeProvider(initial: string | null) {
  const calls: string[] = [];
  let stored = initial;
  return {
    calls,
    get stored() {
      return stored;
    },
    async pullHistory(): Promise<WatchEvent[]> {
      return stored === null ? [] : [{ ref: MOVIE, watchedAt: stored }];
    },
    async removeHistory(events: WatchEvent[]) {
      calls.push('remove');
      if (events.length) stored = null;
      return { added: 1, skipped: 0, failed: 0, notFound: 0 };
    },
    async pushHistory(events: WatchEvent[]) {
      calls.push('push');
      stored = events[0]?.watchedAt ?? stored;
      return { added: 1, skipped: 0, failed: 0, notFound: 0 };
    },
  };
}

function repairWith(target: ReturnType<typeof fakeProvider>, source: ReturnType<typeof fakeProvider>, id = 'simkl') {
  const connections = {
    async clientFor(_userId: string, provider: string) {
      return provider === id ? target : source;
    },
  };
  return new DateRepair(connections as never, new DeliveriesStore(db), db);
}

beforeAll(async () => {
  db = await createDb('pglite://memory');
  await db.migrate();
});

afterAll(async () => {
  await db.close?.();
});

beforeEach(async () => {
  await db.orm.delete(deliveries);
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
  await db.orm.insert(deliveries).values({
    id: 'd1',
    syncId: 's1',
    userId: 'u1',
    target: 'simkl',
    dataType: 'history',
    itemKey: itemKey(MOVIE)!,
    ref: JSON.stringify(MOVIE),
    createdAt: DELIVERED_AT,
  });
});

describe('deciding what the repair owns', () => {
  it('claims a date written when we delivered it', () => {
    expect(looksDelivered(WRONG, DELIVERED_AT)).toBe(true);
  });

  it('leaves a date from any other time alone', () => {
    expect(looksDelivered('2026-08-05T09:00:00Z', DELIVERED_AT)).toBe(false);
  });

  // The bug wrote the time of the import, which is always the newer of the two.
  // A newest-wins rule would keep exactly the value being removed.
  it('does not prefer the newer date', () => {
    expect(looksDelivered(RIGHT, DELIVERED_AT)).toBe(false);
  });
});

describe('running the repair', () => {
  it('corrects an item it owns, removing before re-adding', async () => {
    const target = fakeProvider(WRONG);
    const source = fakeProvider(RIGHT);
    const result = await repairWith(target, source).run('u1', 's1', 'trakt', 'simkl');

    expect(result.counts).toMatchObject({ candidates: 1, repaired: 1, failed: 0 });
    expect(target.calls).toEqual(['remove', 'push']);
    expect(target.stored).toBe(RIGHT);
  });

  it('leaves a watch dated outside the window untouched', async () => {
    const target = fakeProvider('2026-08-05T09:00:00Z');
    const source = fakeProvider(RIGHT);
    const result = await repairWith(target, source).run('u1', 's1', 'trakt', 'simkl');

    expect(result.counts).toMatchObject({ skipped: 1, candidates: 0, repaired: 0 });
    expect(target.calls).toEqual([]);
  });

  // Removing it would lose the watch outright, which is worse than a wrong date.
  it('leaves an item the source has no date for', async () => {
    const target = fakeProvider(WRONG);
    const source = fakeProvider(null);
    const result = await repairWith(target, source).run('u1', 's1', 'trakt', 'simkl');

    expect(result.counts).toMatchObject({ skipped: 1, repaired: 0 });
    expect(target.calls).toEqual([]);
  });

  it('clears its intent once the item reads back correctly', async () => {
    const target = fakeProvider(WRONG);
    const source = fakeProvider(RIGHT);
    const repair = repairWith(target, source);
    await repair.run('u1', 's1', 'trakt', 'simkl');
    expect(await repair.pending('s1', 'simkl')).toEqual([]);
  });

  it('keeps an intent when the item does not come back', async () => {
    const target = fakeProvider(WRONG);
    target.pushHistory = async () => ({ added: 0, skipped: 0, failed: 1, notFound: 0 });
    const source = fakeProvider(RIGHT);
    const repair = repairWith(target, source);

    const result = await repair.run('u1', 's1', 'trakt', 'simkl');

    expect(result.counts.repaired).toBe(0);
    expect(result.counts.stoppedBecause).toBeTruthy();
    const pending = await repair.pending('s1', 'simkl');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.watchedAt).toBe(RIGHT);
  });

  it('says plainly when there is no ledger to work from', async () => {
    await db.orm.delete(deliveries);
    const result = await repairWith(fakeProvider(WRONG), fakeProvider(RIGHT)).run('u1', 's1', 'trakt', 'simkl');
    expect(result.unidentifiable).toBe(true);
    expect(result.counts.repaired).toBe(0);
  });
});

// MDBList overwrites whatever is stored, so a removal there is risk with no
// purpose: it cannot be undone if the write that follows fails.
describe('a provider that updates in place', () => {
  it('is written to without removing anything first', async () => {
    await db.orm.delete(deliveries);
    await db.orm.insert(deliveries).values({
      id: 'd2',
      syncId: 's1',
      userId: 'u1',
      target: 'mdblist',
      dataType: 'history',
      itemKey: itemKey(MOVIE)!,
      ref: JSON.stringify(MOVIE),
      createdAt: DELIVERED_AT,
    });
    const target = fakeProvider(WRONG);
    const source = fakeProvider(RIGHT);
    const result = await repairWith(target, source, 'mdblist').run('u1', 's1', 'trakt', 'mdblist');

    expect(result.counts).toMatchObject({ repaired: 1 });
    expect(target.calls).toEqual(['push']);
  });
});

// An item removed by an interrupted run is missing entirely, which is worse
// than the wrong date this exists to fix. It goes back before anything else.
describe('resuming after an interrupted run', () => {
  it('restores what an earlier run removed, before touching anything new', async () => {
    const target = fakeProvider(WRONG);
    target.pushHistory = async () => ({ added: 0, skipped: 0, failed: 1, notFound: 0 });
    const source = fakeProvider(RIGHT);
    const first = repairWith(target, source);
    await first.run('u1', 's1', 'trakt', 'simkl');
    expect(await first.pending('s1', 'simkl')).toHaveLength(1);
    expect(target.stored).toBeNull();

    // A second run, with the write working this time.
    const healed = fakeProvider(null);
    const second = repairWith(healed, source);
    const result = await second.run('u1', 's1', 'trakt', 'simkl');

    expect(healed.stored).toBe(RIGHT);
    expect(result.counts.repaired).toBeGreaterThanOrEqual(1);
    expect(await second.pending('s1', 'simkl')).toEqual([]);
  });

  it('stops rather than starting new work when the restore fails again', async () => {
    const target = fakeProvider(WRONG);
    target.pushHistory = async () => ({ added: 0, skipped: 0, failed: 1, notFound: 0 });
    const source = fakeProvider(RIGHT);
    await repairWith(target, source).run('u1', 's1', 'trakt', 'simkl');

    const stillBroken = fakeProvider(null);
    stillBroken.pushHistory = async () => ({ added: 0, skipped: 0, failed: 1, notFound: 0 });
    const second = repairWith(stillBroken, source);
    const result = await second.run('u1', 's1', 'trakt', 'simkl');

    expect(result.counts.stoppedBecause).toContain('removed earlier');
    expect(await second.pending('s1', 'simkl')).toHaveLength(1);
  });
});

// Someone with no delivery record cannot be repaired: we cannot tell our dates
// from theirs. Offering "rewrite everything from source" would overwrite watches
// they really had, which is a second wrong date rather than a fix.
describe('what a person with no ledger is told', () => {
  it('says we cannot identify the dates, and offers no rewrite', async () => {
    const { explain } = await import('../routes/repair.js');
    const [line] = explain([
      { target: 'simkl', unidentifiable: true, counts: { delivered: 0, examined: 0, candidates: 0, repaired: 0, skipped: 0, failed: 0 } },
    ]);
    expect(line).toContain('no record of what we sent');
    expect(line).toContain('Nothing has been changed');
    expect(line?.toLowerCase()).not.toContain('rewrite everything');
  });

  it('names what stopped a part-way run so it can be resumed', async () => {
    const { explain } = await import('../routes/repair.js');
    const [line] = explain([
      {
        target: 'simkl',
        unidentifiable: false,
        counts: { delivered: 5, examined: 5, candidates: 3, repaired: 1, skipped: 2, failed: 1, stoppedBecause: 'a write failed part-way (tmdb:550)' },
      },
    ]);
    expect(line).toContain('tmdb:550');
    expect(line).toContain('Run it again');
  });
});

// Neither provider offers a per-item history read, so verifying after every
// item means pulling the whole account each time and the cost grows with the
// square of how much is wrong.
describe('how often it re-reads the account', () => {
  it('verifies a group with one read rather than one read each', async () => {
    await db.orm.delete(deliveries);
    const refs = Array.from({ length: 8 }, (_, i) => ({ kind: 'movie' as const, ids: { tmdb: 100 + i } }));
    for (const [i, ref] of refs.entries()) {
      await db.orm.insert(deliveries).values({
        id: `d${i}`,
        syncId: 's1',
        userId: 'u1',
        target: 'simkl',
        dataType: 'history',
        itemKey: itemKey(ref)!,
        ref: JSON.stringify(ref),
        createdAt: DELIVERED_AT,
      });
    }

    let pulls = 0;
    const store = new Map(refs.map((r) => [`tmdb:${r.ids.tmdb}`, WRONG]));
    const target = {
      async pullHistory(): Promise<WatchEvent[]> {
        pulls++;
        return [...store.entries()].map(([k, at]) => ({
          ref: { kind: 'movie' as const, ids: { tmdb: Number(k.split(':')[1]) } },
          watchedAt: at,
        }));
      },
      async removeHistory(events: WatchEvent[]) {
        for (const e of events) store.delete(`tmdb:${e.ref.ids.tmdb}`);
        return { added: 1, skipped: 0, failed: 0, notFound: 0 };
      },
      async pushHistory(events: WatchEvent[]) {
        for (const e of events) store.set(`tmdb:${e.ref.ids.tmdb}`, e.watchedAt!);
        return { added: 1, skipped: 0, failed: 0, notFound: 0 };
      },
    };
    const source = {
      async pullHistory(): Promise<WatchEvent[]> {
        return refs.map((r) => ({ ref: r, watchedAt: RIGHT }));
      },
      async pushHistory() {
        return { added: 0, skipped: 0, failed: 0, notFound: 0 };
      },
    };
    const connections = {
      async clientFor(_u: string, provider: string) {
        return provider === 'simkl' ? target : source;
      },
    };
    const repair = new DateRepair(connections as never, new DeliveriesStore(db), db);

    const result = await repair.run('u1', 's1', 'trakt', 'simkl');

    expect(result.counts.repaired).toBe(8);
    // Two reads for the initial state, one to verify the group. Eight items
    // verified one at a time would be eight more.
    expect(pulls).toBeLessThanOrEqual(3);
    expect(await repair.pending('s1', 'simkl')).toEqual([]);
  });
});

// Only Simkl writes intents today, so a loose delete collides with nothing.
// The moment a second removing provider exists, restoring an item on one target
// would clear the other's pending row and leave that item removed.
describe('two targets with the same item pending', () => {
  it('restoring one leaves the other pending', async () => {
    await db.orm.delete(repairIntents);
    for (const target of ['simkl', 'other']) {
      await db.orm.insert(repairIntents).values({
        id: `i-${target}`,
        userId: 'u1',
        syncId: 's1',
        target,
        itemKey: itemKey(MOVIE)!,
        ref: JSON.stringify(MOVIE),
        watchedAt: RIGHT,
      });
    }

    const target = fakeProvider(null);
    const repair = repairWith(target, fakeProvider(RIGHT));
    await repair.run('u1', 's1', 'trakt', 'simkl');

    expect(await repair.pending('s1', 'simkl')).toEqual([]);
    expect(await repair.pending('s1', 'other')).toHaveLength(1);
  });
});
