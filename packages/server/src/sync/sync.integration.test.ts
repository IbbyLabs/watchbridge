import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '@watchbridge/core';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '../db/client.js';
import type { Mailer } from '../mail/mailer.js';
import { buildApp } from '../app.js';

const captured: { verifyUrl?: string } = {};
const mailer: Mailer = {
  async sendVerificationEmail(_to, url) {
    captured.verifyUrl = url;
  },
  async verify() {
    return true;
  },
};

const testEnv = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:8080',
  DATABASE_URL: 'pglite://memory',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  SESSION_SECRET: 'z'.repeat(40),
  TRAKT_CLIENT_ID: 'tcid',
  TRAKT_CLIENT_SECRET: 'tsec',
} as NodeJS.ProcessEnv;

// Stateful mock: PMDB "remembers" pushed plays so idempotency is exercised.
const pmdbWatched: Array<{ id: string; tmdb_id: number; media_type: string; watched_at: string | null }> = [];
let pmdbSeq = 0;

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });

      // Trakt connect
      if (url.endsWith('/oauth/device/code')) return json(200, { device_code: 'dc', user_code: 'CODE', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5 });
      if (url.endsWith('/oauth/device/token')) return json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 7776000, created_at: 0 });
      if (url.endsWith('/users/settings')) return json(200, { user: { username: 'dave' } });

      // Trakt history reads
      if (url.includes('/sync/history/movies')) return json(200, [{ watched_at: '2021-01-01T00:00:00Z', movie: { title: 'Fight Club', ids: { trakt: 1, imdb: 'tt0137523', tmdb: 550 } } }]);
      if (url.includes('/sync/history/episodes')) return json(200, []);

      // PMDB watched read/write
      if (url.includes('/api/external/watched')) {
        if (method === 'POST') {
          pmdbWatched.push({ id: `w${++pmdbSeq}`, tmdb_id: body.tmdb_id, media_type: body.media_type, watched_at: body.watched_at });
          return json(200, { success: true });
        }
        return json(200, { items: pmdbWatched, total: pmdbWatched.length, totalPages: 1 });
      }
      return json(404, {});
    }),
  );
}

let app: FastifyInstance;
let db: Db;
let config: AppConfig;
let cookie: string;
const authed = (opts: Record<string, unknown>) => app.inject({ ...opts, cookies: { wb_session: cookie } } as never);

beforeAll(async () => {
  installFetch();
  config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
  app = buildApp({ config, db, mailer });
  await app.ready();

  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'd@e.com', username: 'dave', password: 'correcthorse' } });
  const token = new URL(captured.verifyUrl!).searchParams.get('token')!;
  await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  cookie = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'dave', password: 'correcthorse' } })).cookies.find((c) => c.name === 'wb_session')!.value;

  // Connect Trakt (device) and PMDB (key).
  await authed({ method: 'POST', url: '/api/connections/trakt/device' });
  await authed({ method: 'POST', url: '/api/connections/trakt/device/poll', payload: { deviceCode: 'dc' } });
  await authed({ method: 'POST', url: '/api/connections/pmdb', payload: { apiKey: 'pm-key-1234567890' } });
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('sync end-to-end (trakt -> pmdb history)', () => {
  let syncId: string;

  it('creates a sync', async () => {
    const res = await authed({ method: 'POST', url: '/api/syncs', payload: { name: 'Trakt to PMDB', source: 'trakt', target: 'pmdb', dataTypes: ['history'] } });
    expect(res.statusCode).toBe(201);
    syncId = res.json().id;
  });

  it('preview plans one add without writing', async () => {
    const res = await authed({ method: 'POST', url: `/api/syncs/${syncId}/preview` });
    const out = res.json();
    expect(out.reports[0].results[0]).toMatchObject({ dataType: 'history', planned: 1, added: 0 });
    expect(pmdbWatched).toHaveLength(0);
  });

  it('run applies the add', async () => {
    const res = await authed({ method: 'POST', url: `/api/syncs/${syncId}/run` });
    const out = res.json();
    expect(out.status).toBe('success');
    expect(out.reports[0].results[0]).toMatchObject({ planned: 1, added: 1 });
    expect(pmdbWatched).toHaveLength(1);
    expect(pmdbWatched[0]).toMatchObject({ tmdb_id: 550, media_type: 'movie', watched_at: '2021-01-01T00:00:00Z' });
  });

  it('re-run is idempotent (no duplicate)', async () => {
    const res = await authed({ method: 'POST', url: `/api/syncs/${syncId}/run` });
    expect(res.json().reports[0].results[0]).toMatchObject({ planned: 0, added: 0 });
    expect(pmdbWatched).toHaveLength(1);
  });

  it('records run history', async () => {
    const res = await authed({ method: 'GET', url: `/api/syncs/${syncId}/runs` });
    const runs = res.json() as unknown[];
    expect(runs.length).toBe(2); // two manual runs (preview not persisted)
  });

  it('round-trips a filter and applies it to planning', async () => {
    // The only source item is a movie; a movies:false filter must plan nothing.
    const patched = await authed({
      method: 'PATCH',
      url: `/api/syncs/${syncId}`,
      payload: { filters: { movies: false } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().filters).toEqual({ movies: false });

    const preview = await authed({ method: 'POST', url: `/api/syncs/${syncId}/preview` });
    expect(preview.json().reports[0].results[0]).toMatchObject({ planned: 0 });

    // Clearing the filter restores the item as a candidate (already present now).
    const cleared = await authed({ method: 'PATCH', url: `/api/syncs/${syncId}`, payload: { filters: null } });
    expect(cleared.json().filters).toBeNull();
    const after = await authed({ method: 'POST', url: `/api/syncs/${syncId}/preview` });
    expect(after.json().reports[0].results[0]).toMatchObject({ planned: 0, skippedPresent: 1 });
  });
});

describe('ratings sync validation', () => {
  it('rejects a ratings sync with no authority, then accepts one with a valid authority', async () => {
    const bad = await authed({
      method: 'POST',
      url: '/api/syncs',
      payload: { name: 'R', source: 'trakt', target: 'pmdb', dataTypes: ['ratings'] },
    });
    expect(bad.statusCode).toBe(400);

    const wrong = await authed({
      method: 'POST',
      url: '/api/syncs',
      payload: { name: 'R', source: 'trakt', target: 'pmdb', dataTypes: ['ratings'], ratingsAuthority: 'simkl' },
    });
    expect(wrong.statusCode).toBe(400);

    const ok = await authed({
      method: 'POST',
      url: '/api/syncs',
      payload: { name: 'R', source: 'trakt', target: 'pmdb', dataTypes: ['ratings'], ratingsAuthority: 'trakt' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().ratingsAuthority).toBe('trakt');
  });
});

describe('watchlist removal propagation', () => {
  const create = (payload: Record<string, unknown>) =>
    authed({ method: 'POST', url: '/api/syncs', payload: { name: 'W', source: 'trakt', target: 'simkl', ...payload } });

  it('defaults to off', async () => {
    const res = await create({ dataTypes: ['watchlist'] });
    expect(res.statusCode).toBe(201);
    expect(res.json().propagateWatchlistRemovals).toBe(false);
  });

  it('is stored when asked for on a watchlist sync', async () => {
    const res = await create({ dataTypes: ['watchlist'], propagateWatchlistRemovals: true });
    expect(res.json().propagateWatchlistRemovals).toBe(true);
  });

  it('is ignored on a sync that does not include the watchlist', async () => {
    const res = await create({ dataTypes: ['history'], propagateWatchlistRemovals: true });
    expect(res.json().propagateWatchlistRemovals).toBe(false);
  });

  it('refuses the combination with a two-way sync, and explains why', async () => {
    const res = await create({ dataTypes: ['watchlist'], direction: 'two_way', propagateWatchlistRemovals: true });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/two-way sync cannot propagate watchlist removals/);
  });

  it('refuses a patch that would turn an existing removal sync two-way', async () => {
    const created = await create({ dataTypes: ['watchlist'], propagateWatchlistRemovals: true });
    const res = await authed({
      method: 'PATCH',
      url: `/api/syncs/${created.json().id}`,
      payload: { direction: 'two_way' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('turns itself off when the watchlist is dropped from the sync', async () => {
    const created = await create({ dataTypes: ['watchlist'], propagateWatchlistRemovals: true });
    const id = created.json().id;

    const dropped = await authed({ method: 'PATCH', url: `/api/syncs/${id}`, payload: { dataTypes: ['history'] } });
    expect(dropped.json().propagateWatchlistRemovals).toBe(false);

    // Re-adding the watchlist must not bring the removal setting back with it.
    const readded = await authed({ method: 'PATCH', url: `/api/syncs/${id}`, payload: { dataTypes: ['watchlist'] } });
    expect(readded.json().propagateWatchlistRemovals).toBe(false);
  });
});

describe('last run status', () => {
  it('is null before the first run and reflects the outcome after it', async () => {
    const created = await authed({
      method: 'POST',
      url: '/api/syncs',
      payload: { name: 'L', source: 'trakt', target: 'pmdb', dataTypes: ['history'] },
    });
    const id = created.json().id;
    expect(created.json().lastRunStatus).toBeNull();

    await authed({ method: 'POST', url: `/api/syncs/${id}/run` });

    const list = (await authed({ method: 'GET', url: '/api/syncs' })).json() as Array<{
      id: string;
      lastRunStatus: string | null;
    }>;
    expect(list.find((s) => s.id === id)!.lastRunStatus).toBe('success');
  });

  it('is not touched by a preview', async () => {
    const created = await authed({
      method: 'POST',
      url: '/api/syncs',
      payload: { name: 'P', source: 'trakt', target: 'pmdb', dataTypes: ['history'] },
    });
    const id = created.json().id;
    await authed({ method: 'POST', url: `/api/syncs/${id}/preview` });

    const list = (await authed({ method: 'GET', url: '/api/syncs' })).json() as Array<{
      id: string;
      lastRunStatus: string | null;
    }>;
    expect(list.find((s) => s.id === id)!.lastRunStatus).toBeNull();
  });
});

describe('preview goes through the same gate as a run', () => {
  it('refuses a second concurrent operation on the same sync', async () => {
    const created = await authed({
      method: 'POST',
      url: '/api/syncs',
      payload: { name: 'G', source: 'trakt', target: 'pmdb', dataTypes: ['history'] },
    });
    const id = created.json().id;

    const [a, b] = await Promise.all([
      authed({ method: 'POST', url: `/api/syncs/${id}/preview` }),
      authed({ method: 'POST', url: `/api/syncs/${id}/preview` }),
    ]);

    const outcomes = [a.json(), b.json()];
    const refused = outcomes.filter((o) => o.status === 'error');
    expect(refused).toHaveLength(1);
    expect(refused[0].error).toMatch(/already in progress/);
  });

  it('still previews normally on its own', async () => {
    const created = await authed({
      method: 'POST',
      url: '/api/syncs',
      payload: { name: 'G2', source: 'trakt', target: 'pmdb', dataTypes: ['history'] },
    });
    const res = await authed({ method: 'POST', url: `/api/syncs/${created.json().id}/preview` });
    expect(res.json().status).not.toBe('error');
    expect(res.json().reports[0].results[0].dataType).toBe('history');
  });
});

describe('stalled indicator', () => {
  const make = async (payload: Record<string, unknown>) =>
    (await authed({ method: 'POST', url: '/api/syncs', payload: { source: 'trakt', target: 'pmdb', dataTypes: ['history'], ...payload } })).json();

  const setLastRun = async (id: string, at: Date | null) => {
    const { syncs } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    await db.orm.update(syncs).set({ lastRunAt: at }).where(eq(syncs.id, id));
  };

  it('is false for a manual-only sync (no interval)', async () => {
    const s = await make({ name: 'Manual' });
    expect(s.stalled).toBe(false);
  });

  it('is false right after a scheduled sync is created', async () => {
    const s = await make({ name: 'Fresh', intervalMinutes: 60 });
    expect(s.stalled).toBe(false);
  });

  it('flags a scheduled sync whose last run is well past its interval', async () => {
    const s = await make({ name: 'Lagging', intervalMinutes: 60 });
    await setLastRun(s.id, new Date(Date.now() - 5 * 3600_000)); // 5h ago, interval 1h
    const list = (await authed({ method: 'GET', url: '/api/syncs' })).json() as Array<{ id: string; stalled: boolean }>;
    expect(list.find((x) => x.id === s.id)!.stalled).toBe(true);
  });

  it('does not flag a scheduled sync that ran recently', async () => {
    const s = await make({ name: 'Healthy', intervalMinutes: 60 });
    await setLastRun(s.id, new Date(Date.now() - 30 * 60_000)); // 30m ago
    const list = (await authed({ method: 'GET', url: '/api/syncs' })).json() as Array<{ id: string; stalled: boolean }>;
    expect(list.find((x) => x.id === s.id)!.stalled).toBe(false);
  });

  it('does not flag a paused sync even if it is overdue', async () => {
    const s = await make({ name: 'Paused', intervalMinutes: 60 });
    await setLastRun(s.id, new Date(Date.now() - 10 * 3600_000));
    await authed({ method: 'PATCH', url: `/api/syncs/${s.id}`, payload: { enabled: false } });
    const list = (await authed({ method: 'GET', url: '/api/syncs' })).json() as Array<{ id: string; stalled: boolean }>;
    expect(list.find((x) => x.id === s.id)!.stalled).toBe(false);
  });
});
