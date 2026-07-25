import { describe, expect, it } from 'vitest';
import { RateGate, sharedRateGate } from './rateGate.js';
import { HttpClient } from './http.js';

describe('RateGate', () => {
  it('spaces successive callers by the interval', async () => {
    const gate = new RateGate();
    const started = Date.now();
    await gate.acquire(0);
    await gate.acquire(80);
    await gate.acquire(80);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it('serves waiters in the order they arrived', async () => {
    const gate = new RateGate();
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => gate.acquire(20).then(() => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });

  it('keeps pacing after a waiter rejects', async () => {
    const gate = new RateGate();
    await Promise.allSettled([gate.acquire(20).then(() => Promise.reject(new Error('boom')))]);
    const started = Date.now();
    await gate.acquire(60);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it('hands the same gate to every caller for one provider, and different ones across providers', () => {
    expect(sharedRateGate('trakt')).toBe(sharedRateGate('trakt'));
    expect(sharedRateGate('trakt')).not.toBe(sharedRateGate('simkl'));
  });
});

describe('a shared gate paces separate clients as one', () => {
  it('spaces requests made through two clients built independently', async () => {
    const seen: number[] = [];
    globalThis.fetch = (async () => {
      seen.push(Date.now());
      return new Response('[]', { status: 200 });
    }) as typeof fetch;

    // Two clients for the same upstream, exactly as two concurrent sync runs
    // would build them.
    const gate = new RateGate();
    const a = new HttpClient({ baseUrl: 'https://x', minIntervalMs: 100, gate });
    const b = new HttpClient({ baseUrl: 'https://x', minIntervalMs: 100, gate });

    await Promise.all([a.get('/1'), b.get('/2'), a.get('/3'), b.get('/4')]);

    expect(seen).toHaveLength(4);
    // Without the shared gate the two clients would pace independently and the
    // four requests would land in roughly half the time.
    expect(seen[3]! - seen[0]!).toBeGreaterThanOrEqual(250);
  });
});
