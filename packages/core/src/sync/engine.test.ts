import { describe, expect, it } from 'vitest';
import { runSync, type SyncTarget } from './engine.js';
import { emptyPushResult, type ProgressEvent, type ProviderId, type PushResult, type WatchEvent } from '../providers/types.js';

/** An in-memory provider that actually stores what is pushed, for round-trips. */
class FakeProvider implements SyncTarget {
  history: WatchEvent[] = [];
  progress: ProgressEvent[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly progressCapable = true,
  ) {}

  capabilities() {
    return { history: true, progress: this.progressCapable, ratings: false, watchlist: false, datedHistory: true };
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
