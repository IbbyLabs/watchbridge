import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@watchbridge/core';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from './db/client.js';
import type { Mailer } from './mail/mailer.js';
import { buildApp } from './app.js';
import { createShutdown, type DrainState } from './shutdown.js';

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
} as NodeJS.ProcessEnv;

let app: FastifyInstance;
let db: Db;
const drain: DrainState = { draining: false };

beforeAll(async () => {
  const config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
  app = buildApp({ config, db, mailer, drain });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('shutdown drain', () => {
  it('reads the drain window from WATCHBRIDGE_DRAIN_SECONDS, default 0', () => {
    expect(loadConfig(testEnv).WATCHBRIDGE_DRAIN_SECONDS).toBe(0);
    expect(loadConfig({ ...testEnv, WATCHBRIDGE_DRAIN_SECONDS: '15' }).WATCHBRIDGE_DRAIN_SECONDS).toBe(15);
  });

  it('flips /api/ready to 503 once draining begins while /api/health stays 200', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ status: 'ready' });

    const close = vi.fn(async () => {});
    const exit = vi.fn();
    const done = createShutdown({ drain, drainSeconds: 0.05, close, exit })('SIGTERM');

    const during = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(during.statusCode).toBe(503);
    expect(during.json()).toEqual({ status: 'draining' });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(close).not.toHaveBeenCalled();

    await done;
    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
