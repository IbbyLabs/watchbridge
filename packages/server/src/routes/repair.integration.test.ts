import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '@watchbridge/core';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '../db/client.js';
import type { Mailer } from '../mail/mailer.js';
import { buildApp } from '../app.js';

/**
 * Asks the built app for the route rather than calling the class behind it.
 *
 * Every other test drives `DateRepair` directly, so a repair that works
 * perfectly and is never mounted passes all of them — an unused import is not a
 * type error and not a test failure. Only a request to the app can tell the
 * difference between a route that is missing and one that is merely gated.
 */

const mailer: Mailer = {
  async sendVerificationEmail() {},
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

let app: FastifyInstance;
let db: Db;
let config: AppConfig;

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
  app = buildApp({ config, db, mailer });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.close?.();
  vi.unstubAllGlobals();
});

describe('the repair routes are reachable', () => {
  // 401 says the route exists and wants a session. 404 says it was never
  // mounted, which is what a person pressing the button would have met.
  it('answers the check with a challenge rather than a 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/repair/watch-dates' });
    expect(res.statusCode).toBe(401);
  });

  it('answers the run with a challenge rather than a 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/repair/watch-dates' });
    expect(res.statusCode).toBe(401);
  });

  // Without this, a 401 above could just mean everything unknown is challenged.
  it('still returns 404 for a route that genuinely does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/repair/not-a-real-route' });
    expect(res.statusCode).toBe(404);
  });
});
