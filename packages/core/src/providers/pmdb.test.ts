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
