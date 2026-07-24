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
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
  SESSION_SECRET: 'q'.repeat(40),
  TRAKT_CLIENT_ID: 'tcid',
  TRAKT_CLIENT_SECRET: 'tsec',
} as NodeJS.ProcessEnv;

const APIKEY = 'pm-exportkey-1234567890';

let app: FastifyInstance;
let db: Db;
let config: AppConfig;
let cookie: string;
const authed = (opts: Record<string, unknown>) =>
  app.inject({ ...opts, cookies: { wb_session: cookie } } as never);

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('/api/external/watched')
        ? new Response(JSON.stringify({ items: [] }), { status: 200 })
        : new Response('{}', { status: 404 }),
    ),
  );
  config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
  app = buildApp({ config, db, mailer });
  await app.ready();

  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'e@f.com', username: 'erin', password: 'correcthorse' },
  });
  const token = new URL(captured.verifyUrl!).searchParams.get('token')!;
  await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  cookie = (
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'erin', password: 'correcthorse' },
    })
  ).cookies.find((c) => c.name === 'wb_session')!.value;

  await authed({ method: 'POST', url: '/api/connections/pmdb', payload: { apiKey: APIKEY } });
  await authed({
    method: 'POST',
    url: '/api/syncs',
    payload: { name: 'Export me', source: 'trakt', target: 'pmdb', dataTypes: ['history'] },
  });
});

afterAll(async () => {
  await app.close();
  await db.close();
  vi.restoreAllMocks();
});

describe('account export', () => {
  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/account/export' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the account, connections and syncs as a downloadable file', async () => {
    const res = await authed({ method: 'GET', url: '/api/account/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="watchbridge-export-/);

    const doc = res.json();
    expect(doc.account).toMatchObject({ email: 'e@f.com', username: 'erin' });
    expect(doc.connections).toHaveLength(1);
    expect(doc.connections[0]).toMatchObject({ provider: 'pmdb', status: 'active' });
    expect(doc.syncs).toHaveLength(1);
    expect(doc.syncs[0]).toMatchObject({ name: 'Export me', dataTypes: ['history'] });
  });

  it('carries no credential anywhere in the document', async () => {
    const res = await authed({ method: 'GET', url: '/api/account/export' });
    expect(res.body).not.toContain(APIKEY);
    expect(res.body).not.toMatch(/"credentials"/);
    expect(res.body).not.toMatch(/"passwordHash"/);
  });

  it('includes runs once a sync has run', async () => {
    const syncs = (await authed({ method: 'GET', url: '/api/syncs' })).json() as Array<{ id: string }>;
    await authed({ method: 'POST', url: `/api/syncs/${syncs[0]!.id}/run` });

    const doc = (await authed({ method: 'GET', url: '/api/account/export' })).json();
    expect(doc.runs.length).toBeGreaterThan(0);
    expect(doc.runs[0]).toHaveProperty('report');
  });

  it('does not leak another account\'s data', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'g@h.com', username: 'gina', password: 'correcthorse' },
    });
    const token = new URL(captured.verifyUrl!).searchParams.get('token')!;
    await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
    const other = (
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { identifier: 'gina', password: 'correcthorse' },
      })
    ).cookies.find((c) => c.name === 'wb_session')!.value;

    const res = await app.inject({
      method: 'GET',
      url: '/api/account/export',
      cookies: { wb_session: other },
    });
    const doc = res.json();
    expect(doc.account.email).toBe('g@h.com');
    expect(doc.connections).toHaveLength(0);
    expect(doc.syncs).toHaveLength(0);
  });
});
