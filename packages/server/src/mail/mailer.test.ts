import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@watchbridge/core';
import { createMailer, parseMailFrom } from './mailer.js';

const baseEnv = {
  DATABASE_URL: 'postgres://u:p@localhost/db',
  SESSION_SECRET: 'x'.repeat(48),
  APP_ENCRYPTION_KEY: 'a'.repeat(64),
  MAIL_FROM: 'Watchbridge <auth@ibbylabs.dev>',
  CF_EMAIL_ACCOUNT_ID: 'acc',
  CF_EMAIL_API_TOKEN: 'tok',
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('parseMailFrom', () => {
  it('splits a named address', () => {
    expect(parseMailFrom('Watchbridge <auth@ibbylabs.dev>')).toEqual({ address: 'auth@ibbylabs.dev', name: 'Watchbridge' });
  });
  it('keeps a bare address', () => {
    expect(parseMailFrom('auth@ibbylabs.dev')).toEqual({ address: 'auth@ibbylabs.dev' });
  });
});

describe('Cloudflare Email Sending', () => {
  it('posts to the account send endpoint with the parsed sender', async () => {
    const fetchMock = vi.fn(async () => reply({ success: true, errors: [], result: { message_id: '<m1>', queued: ['a@example.com'] } }));
    vi.stubGlobal('fetch', fetchMock);
    await createMailer(loadConfig(baseEnv as NodeJS.ProcessEnv)).sendPasswordResetEmail('a@example.com', 'https://wb.example/r');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/email/sending/send');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const sent = JSON.parse(String(init.body));
    expect(sent.from).toEqual({ address: 'auth@ibbylabs.dev', name: 'Watchbridge' });
    expect(sent.to).toBe('a@example.com');
  });

  it('throws when the recipient is suppressed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ success: true, errors: [], result: { suppressed_recipients: ['a@example.com'] } })));
    await expect(
      createMailer(loadConfig(baseEnv as NodeJS.ProcessEnv)).sendPasswordResetEmail('a@example.com', 'https://wb.example/r'),
    ).rejects.toThrow(/rejected a@example.com/);
  });

  it('throws with the API error detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ success: false, errors: [{ code: 10203, message: 'sending disabled' }] }, 403)));
    await expect(
      createMailer(loadConfig(baseEnv as NodeJS.ProcessEnv)).sendPasswordResetEmail('a@example.com', 'https://wb.example/r'),
    ).rejects.toThrow(/403: 10203 sending disabled/);
  });
});
