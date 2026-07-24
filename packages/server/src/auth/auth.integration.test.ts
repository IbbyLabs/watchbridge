import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '@watchbridge/core';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '../db/client.js';
import type { Mailer } from '../mail/mailer.js';
import { buildApp } from '../app.js';

const captured: { verifyUrl?: string; resetUrl?: string } = {};
const mailer: Mailer = {
  async sendVerificationEmail(_to, url) {
    captured.verifyUrl = url;
  },
  async sendPasswordResetEmail(_to, url) {
    captured.resetUrl = url;
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

describe('password management', () => {
  async function loginAlice(password: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'alice', password },
    });
    return res.cookies.find((c) => c.name === 'wb_session')!.value;
  }

  it('changes the password with the correct current password', async () => {
    const cookie = await loginAlice(creds.password);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password/change',
      cookies: { wb_session: cookie },
      payload: { currentPassword: creds.password, newPassword: 'newpassword123' },
    });
    expect(res.statusCode).toBe(200);

    const oldPw = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'alice', password: creds.password },
    });
    expect(oldPw.statusCode).toBe(401);

    const newPw = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'alice', password: 'newpassword123' },
    });
    expect(newPw.statusCode).toBe(200);
  });

  it('rejects a change with the wrong current password', async () => {
    const cookie = await loginAlice('newpassword123');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password/change',
      cookies: { wb_session: cookie },
      payload: { currentPassword: 'wrong-password', newPassword: 'anotherpass123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_password');
  });

  it('emails a reset link and resets the password', async () => {
    const forgot = await app.inject({
      method: 'POST',
      url: '/api/auth/password/forgot',
      payload: { email: creds.email },
    });
    expect(forgot.statusCode).toBe(200);
    expect(captured.resetUrl).toContain('/reset-password?token=');

    const token = new URL(captured.resetUrl!).searchParams.get('token')!;
    const reset = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset',
      payload: { token, newPassword: 'resetpass123' },
    });
    expect(reset.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'alice', password: 'resetpass123' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('answers forgot the same way for an unknown email (no enumeration)', async () => {
    captured.resetUrl = undefined;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password/forgot',
      payload: { email: 'nobody@nowhere.test' },
    });
    expect(res.statusCode).toBe(200);
    expect(captured.resetUrl).toBeUndefined();
  });

  it('rejects a reused reset token', async () => {
    const forgot = await app.inject({
      method: 'POST',
      url: '/api/auth/password/forgot',
      payload: { email: creds.email },
    });
    expect(forgot.statusCode).toBe(200);
    const token = new URL(captured.resetUrl!).searchParams.get('token')!;

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset',
      payload: { token, newPassword: 'finalpass123' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset',
      payload: { token, newPassword: 'sneakypass123' },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('invalid_token');
  });
});

describe('rate limiting covers the credential-guessing routes', () => {
  const spam = async (n: number, send: () => Promise<{ statusCode: number; json: () => unknown }>) => {
    const codes: number[] = [];
    for (let i = 0; i < n; i++) codes.push((await send()).statusCode);
    return codes;
  };

  it('stops repeated login attempts and says how long to wait', async () => {
    const codes = await spam(12, () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { identifier: 'nobody@example.com', password: 'wrongwrongwrong' },
      }),
    );
    expect(codes).toContain(429);

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'nobody@example.com', password: 'wrongwrongwrong' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect((blocked.json() as { message: string }).message).toMatch(/Try again in \d+ (second|minute|hour)/);
  });

  it('stops repeated probing of a verification link', async () => {
    const codes = await spam(22, () =>
      app.inject({ method: 'GET', url: '/api/auth/verify?token=guess' }),
    );
    expect(codes).toContain(429);
  });
});
