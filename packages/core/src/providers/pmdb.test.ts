import { afterEach, describe, expect, it, vi } from 'vitest';
import { PmdbClient } from './pmdb.js';
import type { WatchEvent } from './types.js';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

function routeFetch(handler: (rec: Recorded) => { status?: number; body?: unknown }) {
  const calls: Recorded[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const rec: Recorded = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(rec);
    const { status = 200, body } = handler(rec);
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('PmdbClient.pushHistory', () => {
  it('posts with ?dedupe=true and an explicit watched_at (never omitted)', async () => {
    const calls = routeFetch(() => ({ body: {} }));
    const client = new PmdbClient('pm-key');
    const events: WatchEvent[] = [
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: '2021-01-02T03:04:05Z' },
      { ref: { kind: 'movie', ids: { tmdb: 551 } }, watchedAt: null },
    ];
    const res = await client.pushHistory(events);

    expect(res.added).toBe(2);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    for (const p of posts) expect(p.url).toContain('/api/external/watched?dedupe=true');
    expect(posts[0]!.body).toMatchObject({ tmdb_id: 550, media_type: 'movie', watched_at: '2021-01-02T03:04:05Z' });
    // Unknown date must be sent as an explicit null, not omitted.
    expect((posts[1]!.body as Record<string, unknown>).watched_at).toBeNull();
  });

  it('sends media_type tv with season/episode for episodes', async () => {
    const calls = routeFetch(() => ({ body: {} }));
    await new PmdbClient('k').pushHistory([
      { ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 2, number: 5 }, watchedAt: null },
    ]);
    const body = calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
    expect(body).toMatchObject({ tmdb_id: 1399, media_type: 'tv', season: 2, episode: 5 });
  });

  it('resolves a missing TMDB id via mappings/lookup before posting', async () => {
    const calls = routeFetch((rec) => {
      if (rec.url.includes('/mappings/lookup')) return { body: { results: [{ tmdb_id: 603, votes: 9 }] } };
      return { body: {} };
    });
    const res = await new PmdbClient('k').pushHistory([
      { ref: { kind: 'movie', ids: { imdb: 'tt0133093' } }, watchedAt: null },
    ]);
    expect(res.added).toBe(1);
    expect(calls.some((c) => c.url.includes('id_type=imdb&id_value=tt0133093'))).toBe(true);
    expect((calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>).tmdb_id).toBe(603);
  });

  it('counts an unresolvable item as notFound without posting', async () => {
    const calls = routeFetch((rec) =>
      rec.url.includes('/mappings/lookup') ? { status: 404 } : { body: {} },
    );
    const res = await new PmdbClient('k').pushHistory([
      { ref: { kind: 'movie', ids: { imdb: 'tt9999999' } }, watchedAt: null },
    ]);
    expect(res.notFound).toBe(1);
    expect(res.added).toBe(0);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('PmdbClient.pullHistory', () => {
  it('normalizes watched rows to events', async () => {
    routeFetch((rec) => {
      if (rec.url.includes('/api/external/watched')) {
        return {
          body: {
            total: 2,
            totalPages: 1,
            items: [
              { id: 'a', tmdb_id: 550, media_type: 'movie', watched_at: '2020-05-05T00:00:00Z' },
              { id: 'b', tmdb_id: 1399, media_type: 'tv', season: 1, episode: 1, watched_at: null },
            ],
          },
        };
      }
      return { body: {} };
    });
    const events = await new PmdbClient('k').pullHistory();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: '2020-05-05T00:00:00Z' });
    expect(events[1]).toEqual({
      ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 1 },
      watchedAt: null,
    });
  });
});

describe('PmdbClient.pushProgress', () => {
  const at = (progress: number, positionMs: number) => ({
    ref: { kind: 'movie' as const, ids: { tmdb: 550 } },
    progress,
    positionMs,
    runtimeMs: 8_340_000,
  });

  it('sends a mid-film resume position', async () => {
    const calls = routeFetch(() => ({ body: { success: true } }));
    const res = await new PmdbClient('pm-key').pushProgress([at(42, 3_502_800)]);

    expect(res.added).toBe(1);
    expect(calls).toHaveLength(1);
    // Batched: the payload rides in `items` on the batch endpoint.
    expect(calls[0].url).toContain('/api/external/resume/batch');
    expect(calls[0].body).toMatchObject({
      items: [expect.objectContaining({ tmdb_id: 550, media_type: 'movie', position_ms: 3_502_800 })],
    });
  });

  it('does not send a position PublicMetaDB would turn into a finished play', async () => {
    const calls = routeFetch(() => ({ body: { success: true } }));
    const res = await new PmdbClient('pm-key').pushProgress([at(85, 7_089_000)]);

    expect(calls).toHaveLength(0);
    expect(res.added).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.note).toMatch(/recorded them as finished/);
  });

  it('keeps sending the rest of the batch', async () => {
    const calls = routeFetch(() => ({ body: { success: true } }));
    const res = await new PmdbClient('pm-key').pushProgress([at(95, 7_923_000), at(30, 2_502_000)]);

    expect(calls).toHaveLength(1);
    expect(res.added).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it('chunks resume positions into batches of 50', async () => {
    const calls = routeFetch(() => ({ body: { success: true } }));
    const events = Array.from({ length: 120 }, (_, i) => ({
      ref: { kind: 'movie' as const, ids: { tmdb: 1000 + i } },
      progress: 10,
      positionMs: 1_000,
      runtimeMs: 10_000,
    }));
    const res = await new PmdbClient('pm-key').pushProgress(events);

    expect(res.added).toBe(120);
    const posts = calls.filter((c) => c.url.includes('/api/external/resume/batch'));
    expect(posts).toHaveLength(3); // 50 + 50 + 20
    expect((posts[0]!.body as { items: unknown[] }).items).toHaveLength(50);
    expect((posts[2]!.body as { items: unknown[] }).items).toHaveLength(20);
  });
});

describe('PmdbClient.removeHistory', () => {
  it('bulk-deletes a title by tmdb_id and media_type', async () => {
    const calls = routeFetch(() => ({ body: { success: true } }));
    const res = await new PmdbClient('pm-key').removeHistory([
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null },
    ]);

    expect(res.added).toBe(1);
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toContain('/api/external/watched?');
    expect(del.url).toContain('tmdb_id=550');
    expect(del.url).toContain('media_type=movie');
    expect(del.url).not.toContain('season');
  });

  it('narrows to one episode when season and episode are given', async () => {
    const calls = routeFetch(() => ({ body: { success: true } }));
    await new PmdbClient('pm-key').removeHistory([
      { ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 2, number: 3 }, watchedAt: null },
    ]);

    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toContain('media_type=tv');
    expect(del.url).toContain('season=2');
    expect(del.url).toContain('episode=3');
  });
});

describe('PmdbClient pagination', () => {
  it('keeps paging on `total` even when `totalPages` is absent', async () => {
    const rows = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: `${from + i}`, tmdb_id: 1000 + from + i, media_type: 'movie' as const }));
    const calls = routeFetch((rec) => {
      if (rec.url.includes('page=1')) return { body: { items: rows(0, 100), total: 150 } };
      if (rec.url.includes('page=2')) return { body: { items: rows(100, 50), total: 150 } };
      return { body: { items: [], total: 150 } };
    });

    const out = await new PmdbClient('pm-key').pullHistory();

    expect(out).toHaveLength(150);
    expect(calls.filter((c) => c.url.includes('/api/external/watched'))).toHaveLength(2);
  });

  it('stops after one page when the response is a bare array', async () => {
    const calls = routeFetch(() => ({ body: [{ id: 'a', tmdb_id: 550, media_type: 'movie' }] }));
    const out = await new PmdbClient('pm-key').pullHistory();

    expect(out).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

describe('PmdbClient watchlist', () => {
  const lists = (items: unknown[]) => ({ body: { items, total: items.length } });

  it('reads the watchlist list items as movies and shows', async () => {
    routeFetch((rec) => {
      if (rec.url.includes('/api/external/lists?')) return lists([{ id: 'lst_1', name: 'Watchlist', type: 'watchlist' }]);
      if (rec.url.includes('/api/external/lists/lst_1/items')) {
        return {
          body: {
            list: { id: 'lst_1' },
            items: [
              { id: 'li_1', tmdb_id: 550, media_type: 'movie' },
              { id: 'li_2', tmdb_id: 1399, media_type: 'tv' },
            ],
            total: 2,
          },
        };
      }
      return { body: {} };
    });

    const out = await new PmdbClient('pm-key').pullWatchlist();

    expect(out).toEqual([
      { ref: { kind: 'movie', ids: { tmdb: 550 } } },
      { ref: { kind: 'show', ids: { tmdb: 1399 } } },
    ]);
  });

  it('does not create a watchlist on a read', async () => {
    const calls = routeFetch((rec) => (rec.url.includes('/api/external/lists') ? lists([]) : { body: {} }));
    const out = await new PmdbClient('pm-key').pullWatchlist();

    expect(out).toEqual([]);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates the watchlist on first write, then adds items', async () => {
    const calls = routeFetch((rec) => {
      if (rec.method === 'POST' && rec.url.endsWith('/api/external/lists')) {
        return { body: { success: true, item: { id: 'lst_new', type: 'watchlist' } } };
      }
      if (rec.url.includes('/api/external/lists')) return lists([]);
      return { body: { success: true } };
    });

    const res = await new PmdbClient('pm-key').pushWatchlist([{ ref: { kind: 'movie', ids: { tmdb: 550 } } }]);

    expect(res.added).toBe(1);
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/external/lists'))!;
    expect(create.body).toMatchObject({ type: 'watchlist' });
    const add = calls.find((c) => c.url.includes('/api/external/lists/lst_new/items'))!;
    expect(add.body).toEqual({ tmdb_id: 550, media_type: 'movie' });
  });

  it('adds to an existing watchlist without creating one', async () => {
    const calls = routeFetch((rec) => {
      if (rec.url.includes('/api/external/lists?')) return lists([{ id: 'lst_1', type: 'watchlist' }]);
      return { body: { success: true } };
    });

    const res = await new PmdbClient('pm-key').pushWatchlist([{ ref: { kind: 'show', ids: { tmdb: 1399 } } }]);

    expect(res.added).toBe(1);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/external/lists'))).toBe(false);
    const add = calls.find((c) => c.url.includes('/items'))!;
    expect(add.body).toEqual({ tmdb_id: 1399, media_type: 'tv' });
  });

  it('removes by matching the list item id', async () => {
    const calls = routeFetch((rec) => {
      if (rec.url.includes('/api/external/lists?')) return lists([{ id: 'lst_1', type: 'watchlist' }]);
      if (rec.url.includes('/api/external/lists/lst_1/items?')) {
        return { body: { items: [{ id: 'li_x', tmdb_id: 550, media_type: 'movie' }], total: 1 } };
      }
      return { body: { success: true } };
    });

    const res = await new PmdbClient('pm-key').removeWatchlist([{ ref: { kind: 'movie', ids: { tmdb: 550 } } }]);

    expect(res.added).toBe(1);
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toContain('/api/external/lists/lst_1/items/li_x');
  });
});

describe('PmdbClient.updateWatchDate', () => {
  it('patches the one matching play in place', async () => {
    const calls = routeFetch((rec) => {
      if (rec.url.includes('/api/external/watched?')) {
        return { body: { items: [{ id: 'w1', tmdb_id: 550, media_type: 'movie' }], total: 1 } };
      }
      return { body: { success: true } };
    });

    const ok = await new PmdbClient('pm-key').updateWatchDate({ kind: 'movie', ids: { tmdb: 550 } }, '2021-02-03T00:00:00Z');

    expect(ok).toBe(true);
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('/api/external/watched/w1');
    expect(patch.body).toEqual({ watched_at: '2021-02-03T00:00:00Z' });
  });

  it('declines when more than one play matches (rewatches)', async () => {
    const calls = routeFetch(() => ({
      body: {
        items: [
          { id: 'w1', tmdb_id: 550, media_type: 'movie' },
          { id: 'w2', tmdb_id: 550, media_type: 'movie' },
        ],
        total: 2,
      },
    }));

    const ok = await new PmdbClient('pm-key').updateWatchDate({ kind: 'movie', ids: { tmdb: 550 } }, '2021-02-03T00:00:00Z');

    expect(ok).toBe(false);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});
