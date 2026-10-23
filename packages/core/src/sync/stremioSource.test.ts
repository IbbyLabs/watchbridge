import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StremioClient } from '../providers/stremio.js';
import {
  emptyPushResult,
  isSourceOnly,
  type MediaRef,
  type WatchEvent,
} from '../providers/types.js';
import { isSyncTarget, runSync, type SyncTarget } from './engine.js';

const IMDB = 'tt0903747';
const videos = [1, 2, 3].map((n) => ({
  id: `${IMDB}:1:${n}`,
  season: 1,
  episode: n,
  released: `2008-01-${10 + n}T00:00:00.000Z`,
}));

function stubStremio(): void {
  const watched = deflateSync(Buffer.from([0b011])).toString('base64');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('api.strem.io')
        ? {
            result: [
              {
                _id: 'tt0133093',
                name: 'The Matrix',
                type: 'movie',
                state: { timesWatched: 1, lastWatched: '2026-01-02T03:04:05.000Z' },
              },
              {
                _id: IMDB,
                name: 'Breaking Bad',
                type: 'series',
                state: {
                  lastWatched: '2026-05-01T00:00:00.000Z',
                  watched: `${IMDB}:1:2:2:${watched}`,
                },
              },
            ],
          }
        : { meta: { videos } };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

/** A target that accepts writes but never reports them back on a pull. */
class WriteOnlyTarget implements SyncTarget {
  readonly id = 'trakt' as const;
  pushed: WatchEvent[] = [];
  capabilities() {
    return { history: true, progress: false, ratings: false, watchlist: false, datedHistory: true };
  }
  async pullHistory() {
    return [];
  }
  async pullProgress() {
    return [];
  }
  async pushHistory(events: WatchEvent[]) {
    this.pushed.push(...events);
    return { ...emptyPushResult(), added: events.length };
  }
  async pushProgress() {
    return emptyPushResult();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('a Stremio source', () => {
  it('delivers movies and watched episodes once, then plans nothing on a repeat run', async () => {
    stubStremio();
    const source = new StremioClient('k');
    const target = new WriteOnlyTarget();

    const first = await runSync(source, target, { dataTypes: ['history'], preview: false });
    expect(first.results[0]).toMatchObject({ planned: 3, added: 3, failed: 0 });
    expect(target.pushed.map((e) => e.ref.kind).sort()).toEqual(['episode', 'episode', 'movie']);
    expect(target.pushed.every((e) => e.watchedAt !== null)).toBe(true);

    // The runner persists deliveredHistory and feeds it back on the next run.
    const delivered: MediaRef[] = first.deliveredHistory ?? [];
    expect(delivered).toHaveLength(3);
    const second = await runSync(source, target, {
      dataTypes: ['history'],
      preview: false,
      deliveredHistory: delivered,
    });
    expect(second.results[0]).toMatchObject({ planned: 0, added: 0, skippedPresent: 3 });
    expect(target.pushed).toHaveLength(3);
  });

  it('sends only the newly watched episode on a later run', async () => {
    stubStremio();
    const source = new StremioClient('k');
    const target = new WriteOnlyTarget();
    const first = await runSync(source, target, { dataTypes: ['history'], preview: false });

    const watched = deflateSync(Buffer.from([0b111])).toString('base64');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.includes('api.strem.io')
          ? {
              result: [
                {
                  _id: IMDB,
                  type: 'series',
                  state: {
                    lastWatched: '2026-06-01T00:00:00.000Z',
                    watched: `${IMDB}:1:3:3:${watched}`,
                  },
                },
              ],
            }
          : { meta: { videos } };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const second = await runSync(source, target, {
      dataTypes: ['history'],
      preview: false,
      deliveredHistory: first.deliveredHistory,
    });
    expect(second.results[0]).toMatchObject({ planned: 1, added: 1, skippedPresent: 2 });
    expect(target.pushed.at(-1)!.ref).toMatchObject({ kind: 'episode', season: 1, number: 3 });
  });

  it('reports nothing for data types Stremio does not have', async () => {
    stubStremio();
    const report = await runSync(new StremioClient('k'), new WriteOnlyTarget(), {
      dataTypes: ['progress', 'ratings', 'watchlist'],
      preview: false,
    });
    expect(report.results.map((r) => [r.planned, r.added])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });
});

describe('Stremio is never written to', () => {
  it('is flagged source-only and is not a sync target', () => {
    expect(isSourceOnly('stremio')).toBe(true);
    expect(isSourceOnly('trakt')).toBe(false);
    expect(isSyncTarget(new StremioClient('k'))).toBe(false);
    expect(isSyncTarget(new WriteOnlyTarget())).toBe(true);
  });

  it('refuses to run a sync into Stremio, even with a writable-looking target', async () => {
    const lookalike = Object.assign(new WriteOnlyTarget(), { id: 'stremio' as const });
    await expect(
      runSync(new WriteOnlyTarget(), lookalike, { dataTypes: ['history'], preview: false }),
    ).rejects.toThrow(/source-only/);
    expect(lookalike.pushed).toEqual([]);
  });

  it('refuses the return pass of a two-way run whose source is Stremio', async () => {
    const lookalike = Object.assign(new WriteOnlyTarget(), { id: 'stremio' as const });
    await expect(
      runSync(new WriteOnlyTarget(), lookalike, {
        dataTypes: ['history', 'watchlist'],
        preview: true,
      }),
    ).rejects.toThrow(/source-only/);
  });
});
