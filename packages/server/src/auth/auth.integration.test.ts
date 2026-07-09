import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SESSION_SECRET: 'x'.repeat(40),
} as NodeJS.ProcessEnv;

let app: FastifyInstance;
let db: Db;
let config: AppConfig;

beforeAll(async () => {
  config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
  app = buildApp({ config, db, mailer });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

const creds = { email: 'a@b.com', username: 'alice', password: 'correcthorse' };

describe('auth flow', () => {
  it('registers and sends a verification link', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: creds });
    expect(res.statusCode).toBe(201);
    expect(captured.verifyUrl).toContain('/api/auth/verify?token=');
  });

  it('rejects duplicate email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...creds, username: 'alice2' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('email_taken');
  });

  it('blocks login before verification', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: creds.email, password: creds.password },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('email_unverified');
  });

  it('verifies, logs in, and authenticates /me', async () => {
    const token = new URL(captured.verifyUrl!).searchParams.get('token')!;
    const verify = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
    expect(verify.statusCode).toBe(302);
    expect(verify.headers.location).toContain('verified=1');

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'alice', password: creds.password },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === 'wb_session');
    expect(cookie?.value).toBeTruthy();

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { wb_session: cookie!.value },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('a@b.com');
  });

  it('rejects a reused verification token', async () => {
    const token = new URL(captured.verifyUrl!).searchParams.get('token')!;
    const verify = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
    expect(verify.headers.location).toContain('verified=0');
  });

  it('rejects wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'alice', password: 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('blocks cross-origin mutations (CSRF baseline)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { identifier: 'alice', password: creds.password },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('bad_origin');
  });
});
