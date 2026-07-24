import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimklClient } from './simkl.js';

function routeFetch(handler: (url: string, method: string, body: unknown) => { status?: number; body?: unknown }) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const rec = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(rec);
      const { status = 200, body } = handler(rec.url, rec.method, rec.body);
      return new Response(body === undefined ? '' : JSON.stringify(body), { status });
    }),
  );
  return calls;
}

const cfg = { clientId: 'scid', clientSecret: 'ssec', accessToken: 'tok', appName: 'Watchbridge', appVersion: '9.9.9' };

afterEach(() => vi.restoreAllMocks());

describe('SimklClient requests', () => {
  it('appends app-name and app-version to every request', async () => {
    const calls = routeFetch((url) => (url.includes('/sync/activities') ? { body: { all: 'T1' } } : { body: {} }));
    await new SimklClient(cfg).currentActivity();
    expect(calls[0]!.url).toContain('app-name=Watchbridge');
    expect(calls[0]!.url).toContain('app-version=9.9.9');
  });
});

describe('SimklClient.pullHistory delta', () => {
  const activities = { all: 'T2' };
  const withData = (url: string) => {
    if (url.includes('/sync/activities')) return { body: activities };
    if (url.includes('/sync/all-items/movies')) return { body: { movies: [{ last_watched_at: '2021-01-01T00:00:00Z', movie: { ids: { tmdb: 550 } } }] } };
    return { body: {} };
  };

  it('does a full pull and records the activity cursor when no since is given', async () => {
    const calls = routeFetch(withData);
    const client = new SimklClient(cfg);
    const events = await client.pullHistory();
    expect(events).toHaveLength(1);
    expect(client.lastActivityAll).toBe('T2');
    expect(calls.some((c) => c.url.includes('date_from'))).toBe(false);
  });

  it('skips the library entirely when the cursor is unchanged', async () => {
    const calls = routeFetch(withData);
    const events = await new SimklClient(cfg).pullHistory('T2');
    expect(events).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes('/sync/all-items'))).toHaveLength(0);
  });

  it('fetches only the date_from delta when the cursor is older', async () => {
    const calls = routeFetch(withData);
    await new SimklClient(cfg).pullHistory('T1');
    expect(calls.some((c) => c.url.includes('/sync/all-items/movies') && c.url.includes('date_from=T1'))).toBe(true);
  });

  it('maps a completed show to a whole-show marker and a watching show to episodes', async () => {
    routeFetch((url) => {
      if (url.includes('/sync/activities')) return { body: { all: 'T9' } };
      if (url.includes('/sync/all-items/shows'))
        return {
          body: {
            shows: [
              { status: 'completed', watched_episodes_count: 100, total_episodes_count: 100, show: { title: 'Done', ids: { tmdb: 1396 } } },
              { status: 'watching', show: { title: 'Ongoing', ids: { tmdb: 1399 } }, seasons: [{ number: 1, episodes: [{ number: 1 }, { number: 2 }] }] },
            ],
          },
        };
      return { body: {} };
    });
    const events = await new SimklClient(cfg).pullHistory();
    const shows = events.filter((e) => e.ref.kind === 'show');
    const eps = events.filter((e) => e.ref.kind === 'episode');
    expect(shows).toHaveLength(1);
    expect(shows[0]!.ref.ids.tmdb).toBe(1396);
    expect(eps).toHaveLength(2);
    expect(eps.every((e) => e.ref.ids.tmdb === 1399 && e.ref.season === 1)).toBe(true);
  });

  it('requests episode enumeration across all statuses', async () => {
    const calls = routeFetch((url) => (url.includes('/sync/activities') ? { body: { all: 'T9' } } : { body: {} }));
    await new SimklClient(cfg).pullHistory();
    expect(
      calls.some(
        (c) =>
          c.url.includes('/sync/all-items/shows') &&
          c.url.includes('include_all_episodes=yes') &&
          c.url.includes('episode_watched_at=yes'),
      ),
    ).toBe(true);
  });

  it('enumerates watched episodes for completed/dropped shows and keeps watched_at', async () => {
    routeFetch((url) => {
      if (url.includes('/sync/activities')) return { body: { all: 'T9' } };
      if (url.includes('/sync/all-items/shows'))
        return {
          body: {
            shows: [
              {
                status: 'dropped',
                watched_episodes_count: 1,
                total_episodes_count: 160,
                show: { ids: { tmdb: 77 } },
                seasons: [{ number: 1, episodes: [{ number: 1, watched_at: '2025-10-29T00:52:12Z' }] }],
              },
            ],
          },
        };
      return { body: {} };
    });
    const events = await new SimklClient(cfg).pullHistory();
    expect(events).toHaveLength(1);
    expect(events[0]!.ref).toMatchObject({ kind: 'episode', season: 1, number: 1 });
    expect(events[0]!.watchedAt).toBe('2025-10-29T00:52:12Z');
  });

  it('does not mark a still-watching show (no episodes listed) as a whole-show marker', async () => {
    routeFetch((url) => {
      if (url.includes('/sync/activities')) return { body: { all: 'T9' } };
      if (url.includes('/sync/all-items/shows'))
        return { body: { shows: [{ status: 'watching', watched_episodes_count: 3, total_episodes_count: 10, show: { ids: { tmdb: 42 } } }] } };
      return { body: {} };
    });
    const events = await new SimklClient(cfg).pullHistory();
    expect(events).toHaveLength(0);
  });
});

describe('SimklClient.pushHistory', () => {
  it('sends a whole-show marker as a show with no seasons', async () => {
    const calls = routeFetch(() => ({ body: {} }));
    await new SimklClient(cfg).pushHistory([{ ref: { kind: 'show', ids: { tmdb: 1396 } }, watchedAt: null }]);
    const post = calls.find((c) => c.url.includes('/sync/history') && c.method === 'POST');
    expect(post).toBeTruthy();
    const body = post!.body as { shows: Array<{ ids: { tmdb?: number }; seasons?: unknown }> };
    expect(body.shows).toHaveLength(1);
    expect(body.shows[0]!.ids.tmdb).toBe(1396);
    expect(body.shows[0]!.seasons).toBeUndefined();
  });
});

describe('SimklClient progress', () => {
  it('reads movie and episode resume positions from /sync/playback', async () => {
    routeFetch((url) =>
      url.includes('/sync/playback')
        ? {
            body: [
              { type: 'movie', progress: 42, paused_at: '2025-01-01T00:00:00Z', movie: { title: 'Fight Club', ids: { tmdb: 550 } } },
              { type: 'episode', progress: 61, paused_at: '2025-02-02T00:00:00Z', show: { title: 'GoT', ids: { tmdb: 1399 } }, episode: { season: 2, number: 3 } },
            ],
          }
        : { body: {} },
    );
    const events = await new SimklClient(cfg).pullProgress();
    expect(events).toContainEqual({ ref: { kind: 'movie', ids: { tmdb: 550 }, title: 'Fight Club' }, progress: 42, pausedAt: '2025-01-01T00:00:00Z' });
    expect(events).toContainEqual({
      ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 2, number: 3, title: 'GoT' },
      progress: 61,
      pausedAt: '2025-02-02T00:00:00Z',
    });
  });

  it('enriches resume positions with runtime from the detail endpoint (ms reconstruction)', async () => {
    const calls = routeFetch((url) => {
      if (url.includes('/sync/playback'))
        return {
          body: [
            { type: 'movie', progress: 50, paused_at: null, movie: { title: 'Fight Club', ids: { simkl: 100, tmdb: 550 } } },
            { type: 'episode', progress: 25, paused_at: null, show: { title: 'V', ids: { simkl: 15279, tmdb: 21494 } }, episode: { season: 1, number: 1 } },
          ],
        };
      if (url.includes('/movies/100')) return { body: { title: 'Fight Club', runtime: 139 } };
      if (url.includes('/tv/15279')) return { body: { title: 'V', runtime: 45 } };
      return { body: {} };
    });
    const events = await new SimklClient(cfg).pullProgress();
    const movie = events.find((e) => e.ref.kind === 'movie')!;
    expect(movie.runtimeMs).toBe(139 * 60_000);
    expect(movie.positionMs).toBe(Math.round(0.5 * 139 * 60_000));
    const ep = events.find((e) => e.ref.kind === 'episode')!;
    expect(ep.runtimeMs).toBe(45 * 60_000);
    expect(ep.positionMs).toBe(Math.round(0.25 * 45 * 60_000));
    // Anime detection: a plain show uses /tv, not /anime.
    expect(calls.some((c) => c.url.includes('/tv/15279'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/anime/'))).toBe(false);
  });

  it('uses the /anime detail endpoint when the show has anime ids', async () => {
    const calls = routeFetch((url) => {
      if (url.includes('/sync/playback'))
        return { body: [{ type: 'episode', progress: 10, show: { title: 'A', ids: { simkl: 7, mal: 123 } }, episode: { season: 1, number: 1 } }] };
      if (url.includes('/anime/7')) return { body: { runtime: 24 } };
      return { body: {} };
    });
    const events = await new SimklClient(cfg).pullProgress();
    expect(events[0]!.runtimeMs).toBe(24 * 60_000);
    expect(calls.some((c) => c.url.includes('/anime/7'))).toBe(true);
  });

  it('leaves ms fields unset when no Simkl id is present (never guesses)', async () => {
    routeFetch((url) =>
      url.includes('/sync/playback') ? { body: [{ type: 'movie', progress: 50, movie: { title: 'X', ids: { tmdb: 1 } } }] } : { body: {} },
    );
    const events = await new SimklClient(cfg).pullProgress();
    expect(events[0]!.positionMs).toBeUndefined();
    expect(events[0]!.runtimeMs).toBeUndefined();
  });

  it('writes a movie resume position to /scrobble/pause', async () => {
    const calls = routeFetch(() => ({ body: {} }));
    const res = await new SimklClient(cfg).pushProgress([{ ref: { kind: 'movie', ids: { tmdb: 550 } }, progress: 42 }]);
    expect(res.added).toBe(1);
    const post = calls.find((c) => c.url.includes('/scrobble/pause') && c.method === 'POST')!;
    expect(post.body).toMatchObject({ movie: { ids: { tmdb: 550 } }, progress: 42 });
  });

  it('writes an episode resume position with show ids and season/number', async () => {
    const calls = routeFetch(() => ({ body: {} }));
    const res = await new SimklClient(cfg).pushProgress([{ ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 2, number: 3 }, progress: 61 }]);
    expect(res.added).toBe(1);
    const post = calls.find((c) => c.url.includes('/scrobble/pause') && c.method === 'POST')!;
    expect(post.body).toMatchObject({ show: { ids: { tmdb: 1399 } }, episode: { season: 2, number: 3 }, progress: 61 });
  });

  it('reports progress as a capability', () => {
    expect(new SimklClient(cfg).capabilities().progress).toBe(true);
  });
});

describe('SimklClient redirect flow', () => {
  it('builds an authorize URL', () => {
    const url = new SimklClient(cfg).authorizeUrl('https://app/cb', 'st8');
    expect(url).toContain('https://simkl.com/oauth/authorize');
    expect(url).toContain('client_id=scid');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp%2Fcb');
    expect(url).toContain('state=st8');
  });

  it('exchanges a code for an access token', async () => {
    routeFetch((url) => (url.includes('/oauth/token') ? { body: { access_token: 'newtok' } } : { body: {} }));
    await expect(new SimklClient(cfg).exchangeCode('code', 'https://app/cb')).resolves.toBe('newtok');
  });
});

describe('Simkl reports what it actually accepted', () => {
  const creds = { kind: 'simkl' as const, accessToken: 'at' };
  const movie = (tmdb: number): WatchEvent => ({ ref: { kind: 'movie', ids: { tmdb } }, watchedAt: null });
  const episode = (tmdb: number, season: number, number: number): WatchEvent => ({
    ref: { kind: 'episode', ids: { tmdb }, season, number },
    watchedAt: null,
  });

  it('counts a movie Simkl could not find as not-found, not added', async () => {
    routeFetch(() => ({ body: { added: { movies: 1 }, not_found: { movies: [{ ids: { tmdb: 999 } }] } } }));

    const res = await new SimklClient(cfg, creds).pushHistory([movie(550), movie(999)]);

    expect(res.notFound).toBe(1);
    expect(res.added).toBe(1);
  });

  it('returns the refs it could not deliver so they are not remembered as delivered', async () => {
    routeFetch(() => ({ body: { not_found: { movies: [{ ids: { tmdb: 999 } }] } } }));

    const res = await new SimklClient(cfg, creds).pushHistory([movie(550), movie(999)]);

    expect(res.notFoundRefs).toEqual([expect.objectContaining({ ids: { tmdb: 999 } })]);
  });

  it('handles an episode Simkl could not find', async () => {
    routeFetch(() => ({
      body: { not_found: { shows: [{ ids: { tmdb: 1399 }, seasons: [{ number: 1, episodes: [{ number: 2 }] }] }] } },
    }));

    const res = await new SimklClient(cfg, creds).pushHistory([episode(1399, 1, 1), episode(1399, 1, 2)]);

    expect(res.notFound).toBe(1);
    expect(res.added).toBe(1);
    expect(res.notFoundRefs).toEqual([expect.objectContaining({ season: 1, number: 2 })]);
  });

  it('treats an empty not_found as everything accepted', async () => {
    routeFetch(() => ({ body: { added: { movies: 2 }, not_found: { movies: [] } } }));

    const res = await new SimklClient(cfg, creds).pushHistory([movie(550), movie(680)]);

    expect(res.notFound).toBe(0);
    expect(res.added).toBe(2);
    expect(res.notFoundRefs ?? []).toHaveLength(0);
  });

  it('does not invent not-found entries when the response omits the field', async () => {
    // Simkl claims to accept items it will not echo back on a later read; that is
    // what delivery memory exists for, so absence of not_found means accepted.
    routeFetch(() => ({ body: {} }));

    const res = await new SimklClient(cfg, creds).pushHistory([movie(550)]);

    expect(res.notFound).toBe(0);
    expect(res.added).toBe(1);
  });
});

describe('Simkl ratings', () => {
  const creds = { kind: 'simkl' as const, accessToken: 'at' };

  it('reads movie, show and anime ratings, skipping unrated rows', async () => {
    routeFetch(() => ({
      body: {
        movies: [{ user_rating: 8, user_rated_at: '2024-01-01T00:00:00Z', movie: { title: 'Fight Club', ids: { tmdb: 550 } } }],
        shows: [{ user_rating: 9, user_rated_at: '2024-02-01T00:00:00Z', show: { title: 'GoT', ids: { tmdb: 1399 } } }],
        anime: [
          { user_rating: 10, user_rated_at: '2024-03-01T00:00:00Z', show: { title: 'HxH', ids: { mal: 11061 } } },
          { user_rating: null, show: { title: 'Unrated', ids: { mal: 1 } } },
        ],
      },
    }));

    const out = await new SimklClient(cfg, creds).pullRatings();

    expect(out).toHaveLength(3); // the null-rated anime is skipped
    expect(out.filter((r) => r.ref.kind === 'show')).toHaveLength(2); // show + anime
    expect(out.find((r) => r.ref.ids.tmdb === 550)).toMatchObject({ rating: 8 });
  });

  it('writes movie and show ratings and counts not_found', async () => {
    const calls = routeFetch(() => ({ body: { not_found: { movies: [], shows: [] } } }));

    const res = await new SimklClient(cfg, creds).pushRatings([
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, rating: 8 },
      { ref: { kind: 'show', ids: { tmdb: 1399 } }, rating: 9 },
    ]);

    expect(res.added).toBe(2);
    const post = calls.find((c) => c.url.includes('/sync/ratings') && c.method === 'POST')!;
    expect(post.body).toMatchObject({ movies: [{ rating: 8 }], shows: [{ rating: 9 }] });
  });

  it('reports an episode rating as not-found (Simkl cannot rate episodes)', async () => {
    const calls = routeFetch(() => ({ body: {} }));

    const res = await new SimklClient(cfg, creds).pushRatings([
      { ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 1 }, rating: 10 },
    ]);

    expect(res.notFound).toBe(1);
    expect(res.added).toBe(0);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/sync/ratings'))).toBe(false);
  });
});

describe('SimklClient watchlist', () => {
  it('reads plan-to-watch and on-hold across movies, shows and anime', async () => {
    const calls = routeFetch((url) => {
      if (url.includes('/all-items/movies/plantowatch')) {
        return { body: { movies: [{ added_to_watchlist_at: '2026-01-01T00:00:00Z', movie: { title: 'Fight Club', ids: { tmdb: 550 } } }] } };
      }
      if (url.includes('/all-items/shows/hold')) {
        return { body: { shows: [{ added_to_watchlist_at: '2026-02-01T00:00:00Z', show: { title: 'Severance', ids: { tmdb: 95396 } } }] } };
      }
      return { body: {} };
    });

    const items = await new SimklClient(cfg).pullWatchlist();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ ref: { kind: 'movie', ids: { tmdb: 550 } }, listedAt: '2026-01-01T00:00:00Z' });
    expect(items[1]).toMatchObject({ ref: { kind: 'show', ids: { tmdb: 95396 } } });

    // Completed and dropped are library statuses, not watchlist ones.
    const statuses = calls.map((c) => c.url);
    expect(statuses.some((u) => u.includes('completed'))).toBe(false);
    expect(statuses.some((u) => u.includes('dropped'))).toBe(false);
  });

  it('adds to plan-to-watch through add-to-list', async () => {
    const calls = routeFetch(() => ({ body: { not_found: { movies: [], shows: [] } } }));
    const res = await new SimklClient(cfg).pushWatchlist([
      { ref: { kind: 'movie', ids: { tmdb: 550 } } },
      { ref: { kind: 'show', ids: { simkl: 42 } } },
    ]);

    expect(res.added).toBe(2);
    const post = calls.find((c) => c.url.includes('/sync/add-to-list'))!;
    expect(post.body).toEqual({
      movies: [{ to: 'plantowatch', ids: { tmdb: 550 } }],
      shows: [{ to: 'plantowatch', ids: { simkl: 42 } }],
    });
  });

  it('counts items Simkl could not match as not found', async () => {
    routeFetch(() => ({ body: { not_found: { movies: [{ ids: { tmdb: 550 } }], shows: [] } } }));
    const res = await new SimklClient(cfg).pushWatchlist([{ ref: { kind: 'movie', ids: { tmdb: 550 } } }]);
    expect(res.notFound).toBe(1);
    expect(res.added).toBe(0);
  });

  it('removes with a plain media-ids body', async () => {
    const calls = routeFetch(() => ({ body: {} }));
    const res = await new SimklClient(cfg).removeWatchlist([{ ref: { kind: 'movie', ids: { tmdb: 550 } } }]);
    expect(res.added).toBe(1);
    const post = calls.find((c) => c.url.includes('/sync/history/remove'))!;
    expect(post.body).toEqual({ movies: [{ ids: { tmdb: 550 } }], shows: [] });
  });

  it('does not send an item with no usable id', async () => {
    const calls = routeFetch(() => ({ body: {} }));
    const res = await new SimklClient(cfg).pushWatchlist([{ ref: { kind: 'movie', ids: {} } }]);
    expect(res.notFound).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
