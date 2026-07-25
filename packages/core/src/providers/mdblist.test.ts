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
  it('scrobbles a stop with the imdb id for a movie', async () => {
    const calls = routeFetch(() => ({ status: 200 }));
    const events: WatchEvent[] = [
      { ref: { kind: 'movie', ids: { imdb: 'tt0137523', tmdb: 550 } }, watchedAt: null },
    ];

    const res = await new MdblistClient('k').pushHistory(events);

    expect(res.added).toBe(1);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('/scrobble/stop');
    expect(post.body).toMatchObject({
      movie: { ids: { imdb: 'tt0137523', tmdb: 550 } },
      progress: 100,
    });
  });

  it('nests season/episode under show for an episode', async () => {
    const calls = routeFetch(() => ({ status: 200 }));
    await new MdblistClient('k').pushHistory([
      {
        ref: { kind: 'episode', ids: { imdb: 'tt0944947' }, season: 1, number: 2 },
        watchedAt: null,
      },
    ]);
    const body = calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      show: { ids: { imdb: 'tt0944947' }, season: { number: 1, episode: { number: 2 } } },
      progress: 100,
    });
  });

  it('counts a 404 (title unknown to MDBList) as notFound, not failed', async () => {
    routeFetch(() => ({ status: 404 }));
    const res = await new MdblistClient('k').pushHistory([
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null },
    ]);
    expect(res).toMatchObject({ added: 0, notFound: 1, failed: 0 });
  });

  it('counts a whole-show ref and an id-less ref as notFound without a request', async () => {
    const calls = routeFetch(() => ({ status: 200 }));
    const res = await new MdblistClient('k').pushHistory([
      { ref: { kind: 'show', ids: { tmdb: 1399 } }, watchedAt: null },
      { ref: { kind: 'movie', ids: {} }, watchedAt: null },
    ]);
    expect(res.notFound).toBe(2);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
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
