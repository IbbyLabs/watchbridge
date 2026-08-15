import { afterEach, describe, expect, it, vi } from 'vitest';
import { MdblistClient } from './mdblist.js';
import type { ProgressEvent, WatchEvent } from './types.js';

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

describe('MdblistClient.validate', () => {
  it('is true on 200 and false on 401/403', async () => {
    routeFetch(() => ({ status: 200 }));
    expect(await new MdblistClient('key').validate()).toBe(true);

    routeFetch(() => ({ status: 401 }));
    expect(await new MdblistClient('key').validate()).toBe(false);

    routeFetch(() => ({ status: 403 }));
    expect(await new MdblistClient('key').validate()).toBe(false);
  });

  it('authenticates with the apikey query parameter', async () => {
    const calls = routeFetch(() => ({ status: 200 }));
    await new MdblistClient('secret-key').validate();
    expect(calls[0]!.url).toContain('apikey=secret-key');
    expect(calls[0]!.url).toContain('/user');
  });
});

describe('MdblistClient.pullHistory', () => {
  // /sync/watched returns last_watched_at on every row. Dropping it makes every
  // imported title land on the day of the import.
  // MDBList knows some titles only by imdb. Keying the read on tmdb alone makes
  // those invisible to anything reading history back, including a repair.
  it('keeps every id the row carries, not only tmdb', async () => {
    routeFetch(() => ({
      body: {
        movies: [
          {
            movie: { ids: { imdb: 'tt0110413', trakt: 70, tvdb: 234 } },
            last_watched_at: '2019-05-19T20:00:00.000Z',
          },
        ],
        episodes: [
          {
            episode: { season: 1, number: 1, show: { ids: { tmdb: 1399, imdb: 'tt0944947' } } },
            last_watched_at: '2018-03-04T20:00:00.000Z',
          },
        ],
        pagination: { has_more: false },
      },
    }));

    const events = await new MdblistClient('k').pullHistory();

    expect(events).toContainEqual({
      ref: { kind: 'movie', ids: { imdb: 'tt0110413', trakt: 70, tvdb: 234 } },
      watchedAt: '2019-05-19T20:00:00.000Z',
    });
    expect(events).toContainEqual({
      ref: { kind: 'episode', ids: { tmdb: 1399, imdb: 'tt0944947' }, season: 1, number: 1 },
      watchedAt: '2018-03-04T20:00:00.000Z',
    });
  });

  it('keeps the watch date each row carries', async () => {
    routeFetch(() => ({
      body: {
        movies: [{ movie: { ids: { tmdb: 550 } }, last_watched_at: '2026-02-23T04:33:00.000Z' }],
        episodes: [
          {
            episode: { season: 2, number: 5, show: { ids: { tmdb: 1399 } } },
            last_watched_at: '2026-02-21T04:06:18.000Z',
          },
        ],
        pagination: { has_more: false },
      },
    }));

    const events = await new MdblistClient('k').pullHistory();

    expect(events).toContainEqual({
      ref: { kind: 'movie', ids: { tmdb: 550 } },
      watchedAt: '2026-02-23T04:33:00.000Z',
    });
    expect(events).toContainEqual({
      ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 2, number: 5 },
      watchedAt: '2026-02-21T04:06:18.000Z',
    });
  });

  it('maps movies and episodes to tmdb-keyed refs and pages until has_more is false', async () => {
    const pages: Record<string, unknown> = {
      'offset=0': {
        movies: [{ movie: { ids: { tmdb: 550 } } }],
        episodes: [{ episode: { season: 2, number: 5, show: { ids: { tmdb: 1399 } } } }],
        pagination: { has_more: true },
      },
      'offset=1000': {
        movies: [{ movie: { ids: { tmdb: 603 } } }],
        pagination: { has_more: false },
      },
    };
    const calls = routeFetch((rec) => ({
      body: pages[rec.url.includes('offset=1000') ? 'offset=1000' : 'offset=0'],
    }));

    const events = await new MdblistClient('k').pullHistory();

    expect(calls.filter((c) => c.url.includes('/sync/watched'))).toHaveLength(2);
    expect(events).toContainEqual({ ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null });
    expect(events).toContainEqual({
      ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 2, number: 5 },
      watchedAt: null,
    });
    expect(events).toContainEqual({ ref: { kind: 'movie', ids: { tmdb: 603 } }, watchedAt: null });
  });
});

describe('MdblistClient.pushHistory', () => {
  it('writes a movie to /sync/watched with its date', async () => {
    const calls = routeFetch(() => ({ body: { updated: { movies: 1 } } }));
    const res = await new MdblistClient('k').pushHistory([
      {
        ref: { kind: 'movie', ids: { imdb: 'tt0137523', tmdb: 550 } },
        watchedAt: '2019-05-19T20:00:00Z',
      },
    ]);

    expect(res.added).toBe(1);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('/sync/watched');
    expect(post.body).toMatchObject({
      movies: [{ ids: { imdb: 'tt0137523', tmdb: 550 }, watched_at: '2019-05-19T20:00:00Z' }],
    });
  });

  it('nests season and episode under the show, each with its own date', async () => {
    const calls = routeFetch(() => ({ body: { updated: { episodes: 2 } } }));
    await new MdblistClient('k').pushHistory([
      {
        ref: { kind: 'episode', ids: { imdb: 'tt0944947' }, season: 1, number: 2 },
        watchedAt: '2019-05-19T20:00:00Z',
      },
      {
        ref: { kind: 'episode', ids: { imdb: 'tt0944947' }, season: 1, number: 3 },
        watchedAt: '2019-05-20T20:00:00Z',
      },
    ]);
    const body = calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      shows: [
        {
          ids: { imdb: 'tt0944947' },
          seasons: [
            {
              number: 1,
              episodes: [
                { number: 2, watched_at: '2019-05-19T20:00:00Z' },
                { number: 3, watched_at: '2019-05-20T20:00:00Z' },
              ],
            },
          ],
        },
      ],
    });
  });

  it('counts a 404 (titles unknown to MDBList) as notFound, not failed', async () => {
    routeFetch(() => ({ status: 404 }));
    const res = await new MdblistClient('k').pushHistory([
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null },
    ]);
    expect(res).toMatchObject({ added: 0, notFound: 1, failed: 0 });
  });

  it('takes the counts from the response rather than from what it sent', async () => {
    routeFetch(() => ({
      body: { updated: { movies: 1 }, not_found: { movies: [{ ids: { tmdb: 999 } }] } },
    }));
    const res = await new MdblistClient('k').pushHistory([
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null },
      { ref: { kind: 'movie', ids: { tmdb: 999 } }, watchedAt: null },
    ]);
    expect(res).toMatchObject({ added: 1, notFound: 1, failed: 0 });
  });

  // The endpoint answers 200 and drops excess episodes into `errors`, so a
  // status check alone reports a truncated write as a complete one.
  it('surfaces errors reported alongside a successful status', async () => {
    routeFetch(() => ({ body: { updated: { episodes: 1 }, errors: ['expansion cap reached'] } }));
    const res = await new MdblistClient('k').pushHistory([
      { ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 1 }, watchedAt: null },
    ]);
    expect(res.note).toContain('expansion cap reached');
  });

  it('counts a whole-show ref and an id-less ref as notFound without a request', async () => {
    const calls = routeFetch(() => ({ body: { updated: {} } }));
    const res = await new MdblistClient('k').pushHistory([
      { ref: { kind: 'show', ids: { tmdb: 1399 } }, watchedAt: null },
      { ref: { kind: 'movie', ids: {} }, watchedAt: null },
    ]);
    expect(res.notFound).toBe(2);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('splits show entries so no request exceeds the 200 MDBList accepts', async () => {
    const calls = routeFetch(() => ({ body: { updated: { episodes: 1 } } }));
    await new MdblistClient('k').pushHistory(
      Array.from({ length: 250 }, (_, i) => ({
        ref: { kind: 'episode' as const, ids: { tmdb: 1000 + i }, season: 1, number: 1 },
        watchedAt: null,
      })),
    );
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      expect((p.body as { shows: unknown[] }).shows.length).toBeLessThanOrEqual(200);
    }
  });
});

describe('MdblistClient.pullProgress', () => {
  it('maps movie and episode playback rows using imdbid/tmdbid keys', async () => {
    routeFetch(() => ({
      body: [
        {
          type: 'movie',
          progress: 42,
          paused_at: '2021-01-01T00:00:00Z',
          movie: { ids: { imdbid: 'tt0137523', tmdbid: 550 } },
        },
        {
          type: 'episode',
          progress: 10,
          show: { ids: { imdbid: 'tt0944947', tmdbid: 1399 } },
          episode: { season: 1, number: 2 },
        },
      ],
    }));

    const events = await new MdblistClient('k').pullProgress();

    expect(events).toContainEqual({
      ref: { kind: 'movie', ids: { imdb: 'tt0137523', tmdb: 550 } },
      progress: 42,
      pausedAt: '2021-01-01T00:00:00Z',
    });
    expect(events).toContainEqual({
      ref: { kind: 'episode', ids: { imdb: 'tt0944947', tmdb: 1399 }, season: 1, number: 2 },
      progress: 10,
      pausedAt: null,
    });
  });
});

describe('MdblistClient.pushProgress', () => {
  it('scrobbles a pause carrying the resume percentage', async () => {
    const calls = routeFetch(() => ({ status: 200 }));
    const events: ProgressEvent[] = [
      { ref: { kind: 'movie', ids: { imdb: 'tt0137523' } }, progress: 37 },
    ];

    const res = await new MdblistClient('k').pushProgress(events);

    expect(res.added).toBe(1);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('/scrobble/pause');
    expect(post.body).toMatchObject({ movie: { ids: { imdb: 'tt0137523' } }, progress: 37 });
  });
});

describe('a failed scrobble explains itself', () => {
  it('carries the reason through to the push result', async () => {
    routeFetch(() => ({ status: 423 }));
    const res = await new MdblistClient('key').pushHistory([
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null },
    ]);
    expect(res.failed).toBe(1);
    expect(res.note).toMatch(/locked/i);
  });

  it('still treats an unknown title as a miss, not a fault', async () => {
    routeFetch(() => ({ status: 404 }));
    const res = await new MdblistClient('key').pushHistory([
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null },
    ]);
    expect(res.notFound).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.note).toBeUndefined();
  });

  it('keeps no api key in the reason it reports', async () => {
    routeFetch(() => ({ status: 423 }));
    const res = await new MdblistClient('super-secret-key').pushHistory([
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null },
    ]);
    expect(res.note).not.toContain('super-secret-key');
  });
});

describe('MdblistClient.removeHistory', () => {
  it('removes the named episodes and nothing wider', async () => {
    const calls = routeFetch(() => ({ body: {} }));
    await new MdblistClient('k').removeHistory([
      { ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 1 }, watchedAt: null },
      { ref: { kind: 'movie', ids: { imdb: 'tt0110413' } }, watchedAt: null },
    ]);
    const post = calls.find((c) => c.url.includes('/sync/watched/remove') && c.method === 'POST');
    expect(post).toBeTruthy();
    expect(post!.body).toMatchObject({
      movies: [{ ids: { imdb: 'tt0110413' } }],
      shows: [{ ids: { tmdb: 1399 }, seasons: [{ number: 1, episodes: [{ number: 1 }] }] }],
    });
  });
})
