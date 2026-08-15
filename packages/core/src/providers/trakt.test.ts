import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraktClient } from './trakt.js';
import { RateGate } from './rateGate.js';
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

const cfg = {
  clientId: 'cid',
  clientSecret: 'sec',
  // Isolated from the process-wide pacer, which would otherwise serialize the suite.
  get gate() {
    return new RateGate();
  },
};
const future = () => Date.now() + 3_600_000;

afterEach(() => vi.restoreAllMocks());

describe('Trakt device flow', () => {
  it('requests a device code', async () => {
    routeFetch(() => ({
      body: { device_code: 'dc', user_code: 'ABCD', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5 },
    }));
    const code = await new TraktClient(cfg).requestDeviceCode();
    expect(code).toMatchObject({ deviceCode: 'dc', userCode: 'ABCD', verificationUrl: 'https://trakt.tv/activate' });
  });

  it('maps a 400 poll to pending and a 200 to tokens', async () => {
    const pending = new TraktClient(cfg);
    routeFetch(() => ({ status: 400 }));
    await expect(pending.pollDeviceToken('dc')).resolves.toBe('pending');

    const ok = new TraktClient(cfg);
    routeFetch(() => ({ body: { access_token: 'at', refresh_token: 'rt', expires_in: 7776000, created_at: 0 } }));
    const tokens = await ok.pollDeviceToken('dc');
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
  });
});

describe('Trakt pullHistory', () => {
  it('normalizes movies and episodes (episodes keyed by show ids)', async () => {
    routeFetch((rec) => {
      if (rec.url.includes('/sync/history/movies')) {
        return { body: [{ watched_at: '2021-01-01T00:00:00Z', movie: { title: 'Fight Club', year: 1999, ids: { trakt: 1, imdb: 'tt0137523', tmdb: 550 } } }] };
      }
      if (rec.url.includes('/sync/history/episodes')) {
        return { body: [{ watched_at: '2021-02-02T00:00:00Z', episode: { season: 1, number: 2, ids: { trakt: 10 } }, show: { title: 'GoT', ids: { trakt: 5, tvdb: 121361, tmdb: 1399 } } }] };
      }
      return { body: [] };
    });
    const events = await new TraktClient({ ...cfg, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() } }).pullHistory();
    expect(events).toContainEqual({
      ref: { kind: 'movie', ids: { imdb: 'tt0137523', tmdb: 550, trakt: 1 }, title: 'Fight Club', year: 1999 },
      watchedAt: '2021-01-01T00:00:00Z',
    });
    expect(events).toContainEqual({
      ref: { kind: 'episode', ids: { tmdb: 1399, tvdb: 121361, trakt: 5 }, season: 1, number: 2, title: 'GoT' },
      watchedAt: '2021-02-02T00:00:00Z',
    });
  });
});

describe('Trakt pushHistory', () => {
  it('groups episodes into shows/seasons and posts movies', async () => {
    const calls = routeFetch((rec) => (rec.url.endsWith('/sync/history') ? { body: { added: { movies: 1, episodes: 2 } } } : { body: [] }));
    const events: WatchEvent[] = [
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: '2021-01-01T00:00:00Z' },
      { ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 1 }, watchedAt: '2021-01-02T00:00:00Z' },
      { ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 2 }, watchedAt: '2021-01-03T00:00:00Z' },
    ];
    const res = await new TraktClient({ ...cfg, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() } }).pushHistory(events);

    expect(res.added).toBe(3);
    const post = calls.find((c) => c.url.endsWith('/sync/history'))!.body as { movies: unknown[]; shows: Array<{ ids: unknown; seasons: Array<{ number: number; episodes: unknown[] }> }> };
    expect(post.movies).toHaveLength(1);
    expect(post.shows).toHaveLength(1);
    expect(post.shows[0]!.seasons[0]).toMatchObject({ number: 1 });
    expect(post.shows[0]!.seasons[0]!.episodes).toHaveLength(2);
  });
});

describe('Trakt pullProgress', () => {
  const withTokens = () => new TraktClient({ ...cfg, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() } });

  it('requests extended=full and reconstructs position/runtime in ms from the runtime', async () => {
    const calls = routeFetch((rec) =>
      rec.url.includes('/sync/playback')
        ? {
            body: [
              { progress: 50, paused_at: '2025-01-01T00:00:00Z', type: 'movie', movie: { title: 'Fight Club', runtime: 139, ids: { tmdb: 550 } } },
              { progress: 25, paused_at: '2025-02-02T00:00:00Z', type: 'episode', episode: { season: 1, number: 1, runtime: 60, ids: { trakt: 10 } }, show: { title: 'GoT', ids: { tmdb: 1399 } } },
            ],
          }
        : { body: [] },
    );
    const events = await withTokens().pullProgress();
    expect(calls[0]!.url).toContain('extended=full');
    const movie = events.find((e) => e.ref.kind === 'movie')!;
    expect(movie.runtimeMs).toBe(139 * 60_000);
    expect(movie.positionMs).toBe(Math.round(0.5 * 139 * 60_000));
    const ep = events.find((e) => e.ref.kind === 'episode')!;
    expect(ep.runtimeMs).toBe(60 * 60_000);
    expect(ep.positionMs).toBe(Math.round(0.25 * 60 * 60_000));
  });

  it('omits ms fields when the source reports no runtime', async () => {
    routeFetch((rec) =>
      rec.url.includes('/sync/playback')
        ? { body: [{ progress: 50, paused_at: null, type: 'movie', movie: { title: 'X', ids: { tmdb: 1 } } }] }
        : { body: [] },
    );
    const events = await withTokens().pullProgress();
    expect(events[0]!.positionMs).toBeUndefined();
    expect(events[0]!.runtimeMs).toBeUndefined();
  });
});

describe('Trakt pushProgress', () => {
  const withTokens = () => new TraktClient({ ...cfg, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() } });

  it('posts a movie resume position to /scrobble/pause', async () => {
    const calls = routeFetch(() => ({ status: 201, body: { action: 'pause', progress: 42 } }));
    const events: ProgressEvent[] = [{ ref: { kind: 'movie', ids: { tmdb: 550 } }, progress: 42 }];
    const res = await withTokens().pushProgress(events);
    expect(res.added).toBe(1);
    const post = calls.find((c) => c.url.endsWith('/scrobble/pause'))!;
    expect(post.body).toMatchObject({ movie: { ids: { tmdb: 550 } }, progress: 42 });
  });

  it('posts an episode resume position with show ids and season/number', async () => {
    const calls = routeFetch(() => ({ status: 201, body: { action: 'pause' } }));
    const events: ProgressEvent[] = [{ ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 2, number: 3 }, progress: 61 }];
    const res = await withTokens().pushProgress(events);
    expect(res.added).toBe(1);
    const post = calls.find((c) => c.url.endsWith('/scrobble/pause'))!;
    expect(post.body).toMatchObject({ show: { ids: { tmdb: 1399 } }, episode: { season: 2, number: 3 }, progress: 61 });
  });

  it('treats a 409 (already scrobbling) as applied', async () => {
    routeFetch(() => ({ status: 409 }));
    const res = await withTokens().pushProgress([{ ref: { kind: 'movie', ids: { tmdb: 550 } }, progress: 42 }]);
    expect(res.added).toBe(1);
    expect(res.failed).toBe(0);
  });
});

describe('Trakt redirect flow', () => {
  it('builds an authorize URL', () => {
    const url = new TraktClient(cfg).authorizeUrl('https://app/cb', 'st8');
    expect(url).toContain('https://trakt.tv/oauth/authorize');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp%2Fcb');
    expect(url).toContain('state=st8');
  });

  it('exchanges a code for tokens', async () => {
    routeFetch(() => ({ body: { access_token: 'at', refresh_token: 'rt', expires_in: 7776000, created_at: 0 } }));
    const tokens = await new TraktClient(cfg).exchangeCode('code', 'https://app/cb');
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
  });
});

describe('Trakt token refresh', () => {
  it('refreshes an expired access token and reports it via onRefresh', async () => {
    const refreshed: unknown[] = [];
    const calls = routeFetch((rec) => {
      if (rec.url.endsWith('/oauth/token')) return { body: { access_token: 'new', refresh_token: 'newr', expires_in: 7776000 } };
      if (rec.url.includes('/sync/last_activities')) return { body: { movies: {} } };
      return { body: {} };
    });
    const client = new TraktClient({
      ...cfg,
      tokens: { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() - 1000 },
      onRefresh: async (t) => void refreshed.push(t),
    });
    await client.getLastActivities();
    expect(calls.some((c) => c.url.endsWith('/oauth/token'))).toBe(true);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({ accessToken: 'new', refreshToken: 'newr' });
  });
});

describe('paging is bounded and complete', () => {
  const authed = () => new TraktClient({ ...cfg, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() } });

  it('follows every page of playback rather than stopping at the first', async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        type: 'movie',
        progress: 10,
        paused_at: '2026-01-01T00:00:00Z',
        movie: { title: `M${n}-${i}`, ids: { tmdb: n * 1000 + i }, runtime: 100 },
      }));
    const calls = routeFetch(({ url }) => {
      if (url.includes('page=1')) return { body: page(1, 100) };
      if (url.includes('page=2')) return { body: page(2, 7) };
      return { body: [] };
    });

    const out = await authed().pullProgress();

    expect(out).toHaveLength(107);
    expect(calls.filter((c) => c.url.includes('/sync/playback'))).toHaveLength(2);
    // extended=full must survive the added paging params, or runtime is lost.
    expect(calls[0].url).toContain('extended=full');
    expect(calls[0].url).toContain('page=1');
  });

  it('stops instead of looping when an endpoint ignores the page parameter', async () => {
    // Returning the same rows for every page would otherwise spin forever.
    const rows = Array.from({ length: 100 }, (_, i) => ({
      type: 'movie',
      progress: 10,
      movie: { title: `M${i}`, ids: { tmdb: i }, runtime: 100 },
    }));
    const calls = routeFetch(() => ({ body: rows }));

    const out = await authed().pullProgress();

    expect(calls.length).toBeLessThan(5);
    expect(out).toHaveLength(100); // the one page it actually got, not duplicates
  });

  it('stops when an endpoint ignores paging and returns more than the page size', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      type: 'movie',
      progress: 10,
      movie: { title: `M${i}`, ids: { tmdb: i }, runtime: 100 },
    }));
    const calls = routeFetch(() => ({ body: rows }));

    const out = await authed().pullProgress();

    expect(calls).toHaveLength(1);
    expect(out).toHaveLength(250);
  });
});

describe('Trakt ratings', () => {
  const authed = () => new TraktClient({ ...cfg, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() } });

  it('reads movie and show ratings', async () => {
    routeFetch(({ url }) => {
      if (url.includes('/sync/ratings/movies')) return { body: [{ rated_at: '2024-01-01T00:00:00Z', rating: 8, movie: { title: 'Fight Club', ids: { tmdb: 550 } } }] };
      if (url.includes('/sync/ratings/shows')) return { body: [{ rated_at: '2024-02-01T00:00:00Z', rating: 9, show: { title: 'GoT', ids: { tmdb: 1399 } } }] };
      return { body: [] };
    });

    const out = await authed().pullRatings();

    expect(out).toHaveLength(2);
    expect(out.find((r) => r.ref.kind === 'movie')).toMatchObject({ rating: 8, ratedAt: '2024-01-01T00:00:00Z' });
    expect(out.find((r) => r.ref.kind === 'show')).toMatchObject({ rating: 9 });
  });

  it('writes movie and show ratings in one call and counts not_found', async () => {
    const calls = routeFetch(() => ({ body: { not_found: { movies: [], shows: [] } } }));

    const res = await authed().pushRatings([
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, rating: 8 },
      { ref: { kind: 'show', ids: { tmdb: 1399 } }, rating: 9 },
    ]);

    expect(res.added).toBe(2);
    const post = calls.find((c) => c.url.includes('/sync/ratings') && c.method === 'POST')!;
    expect(post.body).toMatchObject({
      movies: [{ rating: 8, ids: { tmdb: 550 } }],
      shows: [{ rating: 9, ids: { tmdb: 1399 } }],
    });
  });

  it('reports an episode rating as not-found (unsupported through this model)', async () => {
    const calls = routeFetch(() => ({ body: {} }));

    const res = await authed().pushRatings([
      { ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 1 }, rating: 10 },
    ]);

    expect(res.notFound).toBe(1);
    expect(res.added).toBe(0);
    // Nothing was posted because there was nothing writable.
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('subtracts what Trakt says it could not find', async () => {
    routeFetch(() => ({ body: { not_found: { movies: [{ ids: { tmdb: 999 } }], shows: [] } } }));

    const res = await authed().pushRatings([
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, rating: 8 },
      { ref: { kind: 'movie', ids: { tmdb: 999 } }, rating: 7 },
    ]);

    expect(res.notFound).toBe(1);
    expect(res.added).toBe(1);
  });
});

describe('Trakt watchlist', () => {
  const tokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: future() };

  it('reads movies and shows off the watchlist', async () => {
    routeFetch((rec) => {
      if (rec.url.includes('/sync/watchlist/movies')) {
        return { body: [{ listed_at: '2026-01-01T00:00:00Z', movie: { title: 'Fight Club', year: 1999, ids: { tmdb: 550 } } }] };
      }
      if (rec.url.includes('/sync/watchlist/shows')) {
        return { body: [{ listed_at: '2026-02-01T00:00:00Z', show: { title: 'Severance', ids: { tmdb: 95396 } } }] };
      }
      return { body: [] };
    });

    const items = await new TraktClient({ ...cfg, tokens }).pullWatchlist();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ ref: { kind: 'movie', ids: { tmdb: 550 } }, listedAt: '2026-01-01T00:00:00Z' });
    expect(items[1]!.ref.kind).toBe('show');
  });

  it('adds and removes through the two list endpoints with a media-ids body', async () => {
    const calls = routeFetch(() => ({ body: { added: { movies: 1, shows: 0 }, not_found: { movies: [], shows: [] } } }));
    const client = new TraktClient({ ...cfg, tokens });

    const added = await client.pushWatchlist([{ ref: { kind: 'movie', ids: { tmdb: 550 } } }]);
    expect(added.added).toBe(1);
    const add = calls.find((c) => c.url.endsWith('/sync/watchlist'))!;
    expect(add.method).toBe('POST');
    expect(add.body).toEqual({ movies: [{ ids: { tmdb: 550 } }], shows: [] });

    await client.removeWatchlist([{ ref: { kind: 'show', ids: { tmdb: 95396 } } }]);
    const remove = calls.find((c) => c.url.endsWith('/sync/watchlist/remove'))!;
    expect(remove.body).toEqual({ movies: [], shows: [{ ids: { tmdb: 95396 } }] });
  });

  it('counts what the target already had as skipped, not added', async () => {
    routeFetch(() => ({ body: { added: { movies: 0 }, existing: { movies: 1 }, not_found: { movies: [] } } }));
    const res = await new TraktClient({ ...cfg, tokens }).pushWatchlist([{ ref: { kind: 'movie', ids: { tmdb: 550 } } }]);
    expect(res.added).toBe(0);
    expect(res.skipped).toBe(1);
  });

  it('explains a full watchlist instead of failing silently', async () => {
    routeFetch(() => ({ status: 420 }));
    const res = await new TraktClient({ ...cfg, tokens }).pushWatchlist([{ ref: { kind: 'movie', ids: { tmdb: 550 } } }]);
    expect(res.failed).toBe(1);
    expect(res.added).toBe(0);
    expect(res.note).toMatch(/watchlist is full/i);
  });

  it('does not send an item with no usable id', async () => {
    const calls = routeFetch(() => ({ body: {} }));
    const res = await new TraktClient({ ...cfg, tokens }).pushWatchlist([{ ref: { kind: 'movie', ids: {} } }]);
    expect(res.notFound).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

// Rate limits are per application credential, so a full re-page of one user's
// library is a cost every other user shares. The cursor is what avoids it.
describe('TraktClient history cursor', () => {
  it('skips the pull when the activity timestamp has not moved', async () => {
    const calls = routeFetch((rec) =>
      rec.url.includes('/sync/last_activities')
        ? { body: { episodes: { watched_at: '2026-08-15T10:00:00Z' }, movies: { watched_at: '2026-08-14T10:00:00Z' } } }
        : { body: [] },
    );
    const c = new TraktClient({ ...cfg, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() } });

    const out = await c.pullHistory('2026-08-15T10:00:00Z');

    expect(out).toEqual([]);
    expect(c.lastPullSkipped).toBe(true);
    expect(calls.filter((x) => x.url.includes('/sync/history'))).toHaveLength(0);
    expect(c.lastPullRequests).toBe(1);
  });

  it('pulls when the timestamp has moved, and reports what it cost', async () => {
    routeFetch((rec) =>
      rec.url.includes('/sync/last_activities')
        ? { body: { episodes: { watched_at: '2026-08-15T12:00:00Z' } } }
        : { body: [] },
    );
    const c = new TraktClient({ ...cfg, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() } });

    await c.pullHistory('2026-08-15T10:00:00Z');

    expect(c.lastPullSkipped).toBe(false);
    expect(c.lastActivityAll).toBe('2026-08-15T12:00:00Z');
    expect(c.lastPullRequests).toBeGreaterThan(1);
  });

  // A missing cursor costs requests; a wrongly-skipped pull costs a user their
  // sync. So a failed activity call falls through to the full pull.
  // 400 rather than 500: anything at or above 500 is retried with backoff, so a
  // server error tests the retry path slowly instead of the fallback path.
  it('pulls in full when the activity call fails', async () => {
    const calls = routeFetch((rec) =>
      rec.url.includes('/sync/last_activities') ? { status: 400 } : { body: [] },
    );
    const c = new TraktClient({ ...cfg, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() } });

    await c.pullHistory('2026-08-15T10:00:00Z');

    expect(c.lastPullSkipped).toBe(false);
    expect(calls.some((x) => x.url.includes('/sync/history'))).toBe(true);
  });
});
