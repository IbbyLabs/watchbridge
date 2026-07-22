/**
 * Regression guards for failure modes reported against comparable sync tools.
 * Each case pins a property Watchbridge relies on, so a future change that
 * reintroduces one of these fails here rather than in someone's library.
 * See docs/COMPETITIVE-AUDIT.md for the sources behind each.
 */
import { describe, expect, it } from 'vitest';
import { runSync, type SyncTarget } from './engine.js';
import {
  emptyPushResult,
  type ProgressEvent,
  type ProviderId,
  type PushResult,
  type WatchEvent,
} from '../providers/types.js';

class FakeProvider implements SyncTarget {
  history: WatchEvent[] = [];
  progress: ProgressEvent[] = [];
  /** Everything ever handed to pushHistory, to assert on what crossed the wire. */
  pushed: WatchEvent[][] = [];

  constructor(readonly id: ProviderId) {}

  capabilities() {
    return { history: true, progress: true, ratings: false, watchlist: false, datedHistory: true };
  }
  async pullHistory() {
    return [...this.history];
  }
  async pushHistory(events: WatchEvent[]): Promise<PushResult> {
    this.pushed.push(events);
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
}

const now = () => new Date('2026-07-22T12:00:00Z');
const movie = (tmdb: number, watchedAt: string | null = null): WatchEvent => ({
  ref: { kind: 'movie', ids: { tmdb } },
  watchedAt,
});

describe('regression: an empty source never destroys target data', () => {
  // A Jellyfin-Trakt failure mode: syncing from a fresh or empty library was read
  // as "nothing is watched" and propagated outward, wiping a Trakt history.
  it('plans and writes nothing when the source returns no items', async () => {
    const source = new FakeProvider('trakt');
    const target = new FakeProvider('simkl');
    target.history = [movie(550), movie(680), movie(13)];

    const report = await runSync(source, target, { dataTypes: ['history'], preview: false, now });

    const history = report.results.find((r) => r.dataType === 'history')!;
    expect(history.planned).toBe(0);
    expect(history.added).toBe(0);
    expect(target.pushed).toHaveLength(0);
    expect(target.history).toHaveLength(3); // untouched
  });

  it('leaves target items alone when the source has only a subset of them', async () => {
    const source = new FakeProvider('trakt');
    source.history = [movie(550)];
    const target = new FakeProvider('simkl');
    target.history = [movie(550), movie(680), movie(13)];

    await runSync(source, target, { dataTypes: ['history'], preview: false, now });

    // Additive by design: what the source lacks is never removed from the target.
    expect(target.history).toHaveLength(3);
  });
});

describe('regression: watch dates come from the source, never regenerated', () => {
  // TraktRater and similar tools have rewritten users' watch dates to "now",
  // collapsing years of history onto the day the sync ran.
  it('pushes the source timestamp unchanged', async () => {
    const source = new FakeProvider('trakt');
    source.history = [movie(550, '2014-03-02T20:15:00Z')];
    const target = new FakeProvider('simkl');

    await runSync(source, target, { dataTypes: ['history'], preview: false, now });

    expect(target.pushed[0][0].watchedAt).toBe('2014-03-02T20:15:00Z');
  });

  it('keeps an unknown date as null rather than substituting the current time', async () => {
    const source = new FakeProvider('trakt');
    source.history = [movie(550, null)];
    const target = new FakeProvider('simkl');

    await runSync(source, target, { dataTypes: ['history'], preview: false, now });

    expect(target.pushed[0][0].watchedAt).toBeNull();
  });
});

describe('regression: a failed push is not recorded as delivered', () => {
  // Delivery memory treats an item as present forever after. Recording one that
  // never landed would strand it: never re-sent, never actually on the target.
  it('reports no deliveries when the target rejects the whole batch', async () => {
    const source = new FakeProvider('trakt');
    source.history = [movie(550)];
    const target = new FakeProvider('simkl');
    target.pushHistory = async (events: WatchEvent[]): Promise<PushResult> => ({
      ...emptyPushResult(),
      failed: events.length,
    });

    const report = await runSync(source, target, { dataTypes: ['history'], preview: false, now });

    expect(report.deliveredHistory ?? []).toHaveLength(0);
  });

  it('records nothing from a preview, which writes nothing', async () => {
    const source = new FakeProvider('trakt');
    source.history = [movie(550)];
    const target = new FakeProvider('simkl');

    const report = await runSync(source, target, { dataTypes: ['history'], preview: true, now });

    expect(report.deliveredHistory ?? []).toHaveLength(0);
    expect(target.pushed).toHaveLength(0);
  });
});

describe('regression: repeated runs do not inflate the target', () => {
  // The single most common defect across Trakt media-server plugins: history
  // that grows on every run, up to accounts being locked for duplicate plays.
  it('stays at the same size across several consecutive runs', async () => {
    const source = new FakeProvider('trakt');
    source.history = [movie(550), movie(680)];
    const target = new FakeProvider('simkl');

    for (let i = 0; i < 5; i++) {
      await runSync(source, target, { dataTypes: ['history'], preview: false, now });
    }

    expect(target.history).toHaveLength(2);
  });
});
