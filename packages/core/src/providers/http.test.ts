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

    const client = new HttpClient({ baseUrl: 'https://x', maxRetries: 2 });
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
