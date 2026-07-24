import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { SecretBox, loadConfig, type AppConfig } from '@watchbridge/core';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '../db/client.js';
import { connections } from '../db/schema.js';
import type { Mailer } from '../mail/mailer.js';
import { buildApp } from '../app.js';
import { ConnectionService } from './service.js';
import { ConnectionStore } from './store.js';

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
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_SECRET: 'y'.repeat(40),
  TRAKT_CLIENT_ID: 'tcid',
  TRAKT_CLIENT_SECRET: 'tsec',
  SIMKL_CLIENT_ID: 'scid',
} as NodeJS.ProcessEnv;

let app: FastifyInstance;
let db: Db;
let config: AppConfig;
let cookie: string;

function routeFetch(
  handler: (url: string, method: string, body: unknown) => { status?: number; body?: unknown },
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const { status = 200, body } = handler(
        url,
        init?.method ?? 'GET',
        init?.body ? JSON.parse(init.body as string) : undefined,
      );
      return new Response(body === undefined ? '' : JSON.stringify(body), { status });
    }),
  );
}

beforeAll(async () => {
  config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
  app = buildApp({ config, db, mailer });
  await app.ready();

  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'c@d.com', username: 'carol', password: 'correcthorse' },
  });
  const token = new URL(captured.verifyUrl!).searchParams.get('token')!;
  await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'carol', password: 'correcthorse' },
  });
  cookie = login.cookies.find((c) => c.name === 'wb_session')!.value;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

afterEach(() => vi.restoreAllMocks());

const authed = (opts: Parameters<FastifyInstance['inject']>[0]) =>
  app.inject({ ...(opts as object), cookies: { wb_session: cookie } } as never);

describe('connections', () => {
  it('reports which providers are configured', async () => {
    const res = await authed({ method: 'GET', url: '/api/connections/providers' });
    const list = res.json() as Array<{ provider: string; configured: boolean }>;
    expect(list.find((p) => p.provider === 'trakt')?.configured).toBe(true);
    expect(list.find((p) => p.provider === 'pmdb')?.configured).toBe(true);
  });

  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/connections' });
    expect(res.statusCode).toBe(401);
  });

  it('connects PMDB with a valid key and stores it encrypted', async () => {
    routeFetch((url) =>
      url.includes('/api/external/watched')
        ? { status: 200, body: { items: [] } }
        : { status: 404 },
    );
    const res = await authed({
      method: 'POST',
      url: '/api/connections/pmdb',
      payload: { apiKey: 'pm-testkey-1234567890' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ provider: 'pmdb', status: 'active' });

    // Credentials must be encrypted at rest — the raw key must not appear.
    const [row] = await db.orm.select().from(connections).where(eq(connections.provider, 'pmdb'));
    expect(row!.credentials).not.toContain('pm-testkey');
    expect(row!.credentials.startsWith('v1:')).toBe(true);
  });

  it('rejects an invalid PMDB key', async () => {
    routeFetch(() => ({ status: 401 }));
    const res = await authed({
      method: 'POST',
      url: '/api/connections/pmdb',
      payload: { apiKey: 'pm-badkey-0000000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_api_key');
  });

  it('connects MDBList with a valid key and stores it encrypted', async () => {
    routeFetch((url) => (url.includes('/user') ? { status: 200, body: {} } : { status: 404 }));
    const res = await authed({
      method: 'POST',
      url: '/api/connections/mdblist',
      payload: { apiKey: 'mdblist-testkey-123456' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ provider: 'mdblist', status: 'active' });

    const [row] = await db.orm
      .select()
      .from(connections)
      .where(eq(connections.provider, 'mdblist'));
    expect(row!.credentials).not.toContain('mdblist-testkey');
    expect(row!.credentials.startsWith('v1:')).toBe(true);
  });

  it('rejects an invalid MDBList key', async () => {
    routeFetch(() => ({ status: 401 }));
    const res = await authed({
      method: 'POST',
      url: '/api/connections/mdblist',
      payload: { apiKey: 'mdblist-badkey-000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_api_key');
  });

  it('runs the Trakt device flow and stores the connection', async () => {
    routeFetch((url) => {
      if (url.endsWith('/oauth/device/code'))
        return {
          body: {
            device_code: 'dc',
            user_code: 'WXYZ',
            verification_url: 'https://trakt.tv/activate',
            expires_in: 600,
            interval: 5,
          },
        };
      if (url.endsWith('/oauth/device/token'))
        return {
          body: { access_token: 'at', refresh_token: 'rt', expires_in: 7776000, created_at: 0 },
        };
      if (url.endsWith('/users/settings')) return { body: { user: { username: 'traktcarol' } } };
      return { status: 404 };
    });

    const start = await authed({ method: 'POST', url: '/api/connections/trakt/device' });
    expect(start.json()).toMatchObject({
      userCode: 'WXYZ',
      verificationUrl: 'https://trakt.tv/activate',
    });

    const poll = await authed({
      method: 'POST',
      url: '/api/connections/trakt/device/poll',
      payload: { deviceCode: 'dc' },
    });
    expect(poll.json()).toEqual({ status: 'connected' });

    const list = (await authed({ method: 'GET', url: '/api/connections' })).json() as Array<{
      provider: string;
      label: string;
    }>;
    expect(list.find((c) => c.provider === 'trakt')?.label).toBe('traktcarol');
  });

  it('returns pending while the Trakt device is not yet authorized', async () => {
    routeFetch((url) => (url.endsWith('/oauth/device/token') ? { status: 400 } : { status: 404 }));
    const poll = await authed({
      method: 'POST',
      url: '/api/connections/trakt/device/poll',
      payload: { deviceCode: 'dc' },
    });
    expect(poll.json()).toEqual({ status: 'pending' });
  });

  it('disconnects a connection', async () => {
    const list = (await authed({ method: 'GET', url: '/api/connections' })).json() as Array<{
      id: string;
      provider: string;
    }>;
    const pmdb = list.find((c) => c.provider === 'pmdb')!;
    const del = await authed({ method: 'DELETE', url: `/api/connections/${pmdb.id}` });
    expect(del.json()).toEqual({ status: 'removed' });
  });
});

describe('a rejected token flags the connection for reconnection', () => {
  // The service is rebuilt here rather than reached through the app, so the test
  // exercises the same client the runner gets without needing a route for it.
  const service = () =>
    new ConnectionService(new ConnectionStore(db, SecretBox.fromEnv(config.APP_ENCRYPTION_KEY)), config);

  const connect = async () => {
    routeFetch((url) =>
      url.includes('/api/external/watched') ? { status: 200, body: { items: [] } } : { status: 404 },
    );
    const res = await authed({
      method: 'POST',
      url: '/api/connections/pmdb',
      payload: { apiKey: 'pm-testkey-0987654321' },
    });
    vi.restoreAllMocks();
    const row = (await db.orm.select().from(connections).where(eq(connections.provider, 'pmdb')))[0]!;
    expect(res.statusCode).toBe(201);
    return row;
  };

  const statusOf = async (id: string) =>
    (await db.orm.select().from(connections).where(eq(connections.id, id)))[0]!.status;

  afterEach(async () => {
    await db.orm.delete(connections).where(eq(connections.provider, 'pmdb'));
  });

  it('marks it for reconnection when the provider answers 401', async () => {
    const conn = await connect();
    expect(conn.status).toBe('active');

    routeFetch(() => ({ status: 401 }));
    const client = (await service().clientFor(conn.userId, 'pmdb'))!;
    await expect(client.pullHistory()).rejects.toThrow();

    expect(await statusOf(conn.id)).toBe('reauth');
  });

  it('leaves it connected when the provider errors for a non-auth reason', async () => {
    const conn = await connect();

    routeFetch(() => ({ status: 404 }));
    const client = (await service().clientFor(conn.userId, 'pmdb'))!;
    await expect(client.pullHistory()).rejects.toThrow();

    expect(await statusOf(conn.id)).toBe('active');
  });
});
