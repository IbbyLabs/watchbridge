/**
 * `/scrobble/pause` is absent from Trakt's published API. If it is withdrawn,
 * resume positions stop being written and nothing else changes — no user-facing
 * error, no missing feature, just a thing that quietly stops keeping up. The
 * only signal available is the status code, so it has to be distinguishable
 * from an ordinary write failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}));

const { TraktClient } = await import('./trakt.js');
const { RateGate } = await import('./rateGate.js');

function routeFetch(status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(status === 200 ? '{}' : '', { status })),
  );
}

const client = () =>
  new TraktClient({
    clientId: 'cid',
    clientSecret: 'sec',
    gate: new RateGate(),
    tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 },
  });

const event = { ref: { kind: 'movie' as const, ids: { tmdb: 550 } }, progress: 42 };

afterEach(() => {
  vi.restoreAllMocks();
  warn.mockClear();
});

describe('the undocumented resume-position endpoint', () => {
  it('warns when Trakt answers 404', async () => {
    routeFetch(404);
    const res = await client().pushProgress([event]);
    expect(res.failed).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ status: 404, endpoint: '/scrobble/pause' });
  });

  it('warns when Trakt answers 405', async () => {
    routeFetch(405);
    await client().pushProgress([event]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stays quiet on an ordinary write failure', async () => {
    routeFetch(422);
    const res = await client().pushProgress([event]);
    expect(res.failed).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet when the write succeeds', async () => {
    routeFetch(200);
    const res = await client().pushProgress([event]);
    expect(res.added).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
