import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraktClient } from './trakt.js';
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

const cfg = { clientId: 'cid', clientSecret: 'sec' };
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
