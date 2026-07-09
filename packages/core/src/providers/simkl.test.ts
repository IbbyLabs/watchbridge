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
