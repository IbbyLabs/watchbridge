import { describe, expect, it } from 'vitest';
import { runSync, type SyncTarget } from './engine.js';
import { itemKey } from './identity.js';
import {
  emptyPushResult,
  type ProgressEvent,
  type ProviderId,
  type PushResult,
  type RatingEvent,
  type WatchEvent,
  type WatchlistEvent,
} from '../providers/types.js';

/** An in-memory provider that actually stores what is pushed, for round-trips. */
class FakeProvider implements SyncTarget {
  history: WatchEvent[] = [];
  progress: ProgressEvent[] = [];
  ratings: RatingEvent[] = [];
  watchlist: WatchlistEvent[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly progressCapable = true,
    private readonly ratingsCapable = false,
    private readonly watchlistCapable = false,
  ) {}

  capabilities() {
    return {
      history: true,
      progress: this.progressCapable,
      ratings: this.ratingsCapable,
      watchlist: this.watchlistCapable,
      datedHistory: true,
    };
  }
  async pullHistory() {
    return [...this.history];
  }
  async pushHistory(events: WatchEvent[]): Promise<PushResult> {
    this.history.push(...events);
    return { ...emptyPushResult(), added: events.length };
  }
  async pullProgress() {
    return [...this.progress];
  }
  async pushProgress(events: ProgressEvent[]): Promise<PushResult> {
    this.progress.push(...events);
    return { ...emptyPushResult(), added: events.length };
  }
  async pullRatings() {
    return [...this.ratings];
  }
  async pushRatings(events: RatingEvent[]): Promise<PushResult> {
    // Overwrite an existing rating for the same item, else append.
    for (const e of events) {
      const k = itemKey(e.ref);
      const i = this.ratings.findIndex((r) => itemKey(r.ref) === k);
      if (i >= 0) this.ratings[i] = e;
      else this.ratings.push(e);
    }
    return { ...emptyPushResult(), added: events.length };
  }
  async pullWatchlist() {
    return [...this.watchlist];
  }
  async pushWatchlist(events: WatchlistEvent[]): Promise<PushResult> {
    this.watchlist.push(...events);
    return { ...emptyPushResult(), added: events.length };
  }
  async removeWatchlist(events: WatchlistEvent[]): Promise<PushResult> {
    const gone = new Set(events.map((e) => itemKey(e.ref)));
    this.watchlist = this.watchlist.filter((e) => !gone.has(itemKey(e.ref)));
    return { ...emptyPushResult(), added: events.length };
  }
}

const now = () => new Date('2026-07-09T00:00:00Z');

describe('runSync', () => {
  it('preview plans without writing anything', async () => {
    const source = new FakeProvider('trakt');
    source.history = [{ ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null }];
    const target = new FakeProvider('pmdb');

    const report = await runSync(source, target, { dataTypes: ['history'], preview: true, now });
    const history = report.results.find((r) => r.dataType === 'history')!;
    expect(history.planned).toBe(1);
    expect(history.added).toBe(0);
    expect(target.history).toHaveLength(0); // nothing written in preview
  });

  it('applies and is idempotent on a second run', async () => {
    const source = new FakeProvider('trakt');
    source.history = [
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null },
      { ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 1 }, watchedAt: null },
    ];
    const target = new FakeProvider('pmdb');

    const first = await runSync(source, target, { dataTypes: ['history'], preview: false, now });
    expect(first.results[0]!.added).toBe(2);
    expect(target.history).toHaveLength(2);

    const second = await runSync(source, target, { dataTypes: ['history'], preview: false, now });
    expect(second.results[0]!.planned).toBe(0);
    expect(second.results[0]!.added).toBe(0);
    expect(target.history).toHaveLength(2); // no duplicates
  });

  it('remembers deliveries and converges against a target that never echoes writes back', async () => {
    const source = new FakeProvider('trakt');
    source.history = [{ ref: { kind: 'episode', ids: { tmdb: 78173 }, season: 3, number: 1 }, watchedAt: null }];
    // A target that accepts pushes but never reflects them on read (like Simkl
    // for split shows): pushHistory reports success, pullHistory stays empty.
    const swallowing = new FakeProvider('simkl');
    swallowing.pushHistory = async (events) => ({ ...emptyPushResult(), added: events.length });

    const first = await runSync(source, swallowing, { dataTypes: ['history'], preview: false, now });
    expect(first.results[0]!.planned).toBe(1);
    expect(first.deliveredHistory).toHaveLength(1);

    // Without the memory it would re-plan; feeding it back converges to zero.
    const second = await runSync(source, swallowing, {
      dataTypes: ['history'],
      preview: false,
      deliveredHistory: first.deliveredHistory,
      now,
    });
    expect(second.results[0]!.planned).toBe(0);
    expect(second.results[0]!.skippedPresent).toBe(1);
  });

  it('notes when the source cannot provide progress', async () => {
    const source = new FakeProvider('simkl', false); // progress not capable
    const target = new FakeProvider('pmdb');
    const report = await runSync(source, target, { dataTypes: ['progress'], preview: false, now });
    expect(report.results[0]!.note).toContain('progress');
    expect(report.results[0]!.added).toBe(0);
  });

  it('syncs progress when the source supports it', async () => {
    const source = new FakeProvider('pmdb');
    source.progress = [{ ref: { kind: 'movie', ids: { tmdb: 550 } }, progress: 42 }];
    const target = new FakeProvider('trakt');
    const report = await runSync(source, target, { dataTypes: ['progress'], preview: false, now });
    expect(report.results[0]!.added).toBe(1);
    expect(target.progress).toHaveLength(1);
  });
});

describe('runSync honours filters', () => {
  const now = () => new Date('2026-07-23T00:00:00Z');

  it('does not plan an item the filters exclude', async () => {
    const source = new FakeProvider('trakt');
    source.history = [
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null },
      { ref: { kind: 'episode', ids: { tmdb: 78173 }, season: 1, number: 1 }, watchedAt: null },
    ];
    const target = new FakeProvider('simkl');

    const report = await runSync(source, target, {
      dataTypes: ['history'],
      preview: false,
      now,
      filters: { movies: false },
    });

    const history = report.results.find((r) => r.dataType === 'history')!;
    // Only the episode survives the movies:false filter.
    expect(history.added).toBe(1);
    expect(target.history).toHaveLength(1);
    expect(target.history[0].ref.kind).toBe('episode');
  });

  it('applies filters to progress as well', async () => {
    const source = new FakeProvider('trakt');
    source.progress = [
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, progress: 40 },
      { ref: { kind: 'episode', ids: { tmdb: 78173 }, season: 1, number: 1 }, progress: 40 },
    ];
    const target = new FakeProvider('simkl');

    const report = await runSync(source, target, {
      dataTypes: ['progress'],
      preview: false,
      now,
      filters: { shows: false },
    });

    const progress = report.results.find((r) => r.dataType === 'progress')!;
    expect(progress.added).toBe(1);
    expect(target.progress).toHaveLength(1);
    expect(target.progress[0].ref.kind).toBe('movie');
  });
});

describe('runSync ratings', () => {
  const now = () => new Date('2026-07-24T00:00:00Z');
  const rate = (tmdb: number, rating: number): RatingEvent => ({ ref: { kind: 'movie', ids: { tmdb } }, rating });

  it('notes unsupported when a side does not do ratings', async () => {
    const source = new FakeProvider('pmdb', true, false);
    const target = new FakeProvider('simkl', true, true);
    const report = await runSync(source, target, { dataTypes: ['ratings'], preview: false, now });
    const r = report.results.find((x) => x.dataType === 'ratings')!;
    expect(r.note).toContain('does not expose ratings');
    expect(r.planned).toBe(0);
  });

  it('applies source ratings the target lacks', async () => {
    const source = new FakeProvider('trakt', true, true);
    source.ratings = [rate(550, 8), rate(680, 9)];
    const target = new FakeProvider('simkl', true, true);

    const report = await runSync(source, target, {
      dataTypes: ['ratings'],
      preview: false,
      ratingsAuthority: 'trakt',
      now,
    });

    const r = report.results.find((x) => x.dataType === 'ratings')!;
    expect(r.added).toBe(2);
    expect(target.ratings).toHaveLength(2);
  });

  it('overwrites a conflicting rating when the source is the authority', async () => {
    const source = new FakeProvider('trakt', true, true);
    source.ratings = [rate(550, 9)];
    const target = new FakeProvider('simkl', true, true);
    target.ratings = [rate(550, 6)];

    await runSync(source, target, {
      dataTypes: ['ratings'],
      preview: false,
      ratingsAuthority: 'trakt',
      now,
    });

    expect(target.ratings).toHaveLength(1);
    expect(target.ratings[0].rating).toBe(9);
  });

  it('leaves a conflicting target rating alone when the target is the authority', async () => {
    const source = new FakeProvider('trakt', true, true);
    source.ratings = [rate(550, 9)];
    const target = new FakeProvider('simkl', true, true);
    target.ratings = [rate(550, 6)];

    const report = await runSync(source, target, {
      dataTypes: ['ratings'],
      preview: false,
      ratingsAuthority: 'simkl',
      now,
    });

    expect(target.ratings[0].rating).toBe(6);
    expect(report.results.find((x) => x.dataType === 'ratings')!.added).toBe(0);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const source = new FakeProvider('trakt', true, true);
    source.ratings = [rate(550, 8)];
    const target = new FakeProvider('simkl', true, true);
    const opts = { dataTypes: ['ratings'] as const, preview: false, ratingsAuthority: 'trakt' as const, now };

    await runSync(source, target, opts);
    const second = await runSync(source, target, opts);

    expect(second.results.find((x) => x.dataType === 'ratings')!.planned).toBe(0);
    expect(target.ratings).toHaveLength(1);
  });
});

describe('runSync watchlist', () => {
  const listed = (tmdb: number): WatchlistEvent => ({ ref: { kind: 'movie', ids: { tmdb } } });
  const pair = () => [new FakeProvider('trakt', true, false, true), new FakeProvider('simkl', true, false, true)] as const;

  it('notes unsupported when a side has no watchlist', async () => {
    const source = new FakeProvider('trakt');
    const target = new FakeProvider('pmdb');
    const report = await runSync(source, target, { dataTypes: ['watchlist'], preview: false, now });
    expect(report.results.find((x) => x.dataType === 'watchlist')!.note).toContain('does not expose a watchlist');
  });

  it('adds source items the target lacks, and is idempotent', async () => {
    const [source, target] = pair();
    source.watchlist = [listed(550), listed(680)];
    target.watchlist = [listed(550)];

    const first = await runSync(source, target, { dataTypes: ['watchlist'], preview: false, now });
    const r = first.results.find((x) => x.dataType === 'watchlist')!;
    expect(r.planned).toBe(1);
    expect(r.added).toBe(1);
    expect(target.watchlist).toHaveLength(2);

    const second = await runSync(source, target, { dataTypes: ['watchlist'], preview: false, now });
    expect(second.results.find((x) => x.dataType === 'watchlist')!.planned).toBe(0);
  });

  it('leaves extra target items alone unless removals are switched on', async () => {
    const [source, target] = pair();
    source.watchlist = [listed(550)];
    target.watchlist = [listed(550), listed(680)];

    await runSync(source, target, { dataTypes: ['watchlist'], preview: false, now });
    expect(target.watchlist).toHaveLength(2);
    expect(source.watchlist).toHaveLength(1);
  });

  it('removes target items the source dropped when removals are switched on', async () => {
    const [source, target] = pair();
    source.watchlist = [listed(550)];
    target.watchlist = [listed(550), listed(680)];

    const report = await runSync(source, target, {
      dataTypes: ['watchlist'],
      preview: false,
      propagateWatchlistRemovals: true,
      now,
    });
    const r = report.results.find((x) => x.dataType === 'watchlist')!;
    expect(r.removed).toBe(1);
    expect(target.watchlist.map((e) => e.ref.ids.tmdb)).toEqual([550]);
  });

  it('writes nothing in preview, including removals', async () => {
    const [source, target] = pair();
    source.watchlist = [listed(550)];
    target.watchlist = [listed(680)];

    const report = await runSync(source, target, {
      dataTypes: ['watchlist'],
      preview: true,
      propagateWatchlistRemovals: true,
      now,
    });
    expect(report.results.find((x) => x.dataType === 'watchlist')!.planned).toBe(2);
    expect(target.watchlist.map((e) => e.ref.ids.tmdb)).toEqual([680]);
  });

  it('says so and keeps adding when the target cannot remove', async () => {
    const [source, target] = pair();
    source.watchlist = [listed(550)];
    target.watchlist = [listed(680)];
    (target as { removeWatchlist?: unknown }).removeWatchlist = undefined;

    const report = await runSync(source, target, {
      dataTypes: ['watchlist'],
      preview: false,
      propagateWatchlistRemovals: true,
      now,
    });
    const r = report.results.find((x) => x.dataType === 'watchlist')!;
    expect(r.note).toContain('cannot remove watchlist items');
    expect(r.added).toBe(1);
    expect(target.watchlist).toHaveLength(2);
  });

  it('never empties a target from a source that returned nothing', async () => {
    const [source, target] = pair();
    source.watchlist = [];
    target.watchlist = [listed(550), listed(680)];

    await runSync(source, target, {
      dataTypes: ['watchlist'],
      preview: false,
      propagateWatchlistRemovals: true,
      now,
    });
    expect(target.watchlist).toHaveLength(2);
  });
});
