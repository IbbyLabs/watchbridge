import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient, HttpError } from './http.js';

afterEach(() => vi.restoreAllMocks());

describe('HttpClient', () => {
  it('retries on 429 honouring Retry-After, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpClient({ baseUrl: 'https://x', maxRetries: 2, maxBackoffMs: 5 });
    await expect(client.get('/y')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on 5xx then gives up as HttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 503 })));
    const client = new HttpClient({ baseUrl: 'https://x', maxRetries: 1, maxBackoffMs: 1 });
    await expect(client.get('/y')).rejects.toBeInstanceOf(HttpError);
  });

  it('throws HttpError immediately on 4xx (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpClient({ baseUrl: 'https://x' });
    await expect(client.get('/y')).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('backoff never becomes an immediate retry', () => {
  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  const limited = (retryAfter: string) =>
    new Response('', { status: 429, headers: { 'retry-after': retryAfter } });

  it('floors a Retry-After of 0 instead of retrying instantly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(limited('0')).mockResolvedValueOnce(ok()));
    const client = new HttpClient({ baseUrl: 'https://x', maxRetries: 2, minBackoffMs: 80 });

    const started = Date.now();
    await client.get('/y');

    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it('floors a negative Retry-After too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(limited('-5')).mockResolvedValueOnce(ok()));
    const client = new HttpClient({ baseUrl: 'https://x', maxRetries: 2, minBackoffMs: 80 });

    const started = Date.now();
    await client.get('/y');

    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it('still honours a longer Retry-After as a wait, not a cap', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(limited('1')).mockResolvedValueOnce(ok()));
    const client = new HttpClient({ baseUrl: 'https://x', maxRetries: 2, minBackoffMs: 10 });

    const started = Date.now();
    await client.get('/y');

    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
});

describe('writes are paced separately from reads', () => {
  // Trakt allows 1000 GET per 5 minutes but only 1 write per second; Simkl allows
  // 10 GET/sec but 1 POST/sec. A single interval cannot express either.
  it('spaces writes by the write interval', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const client = new HttpClient({ baseUrl: 'https://x', minIntervalMs: 5, writeMinIntervalMs: 150 });

    const started = Date.now();
    await client.post('/a', {});
    await client.post('/b', {});

    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('does not slow reads down to the write interval', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const client = new HttpClient({ baseUrl: 'https://x', minIntervalMs: 5, writeMinIntervalMs: 400 });

    const started = Date.now();
    await client.get('/a');
    await client.get('/b');

    expect(Date.now() - started).toBeLessThan(200);
  });

  it('falls back to the read interval when no write interval is given', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const client = new HttpClient({ baseUrl: 'https://x', minIntervalMs: 120 });

    const started = Date.now();
    await client.post('/a', {});
    await client.post('/b', {});

    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });
});
