import { describe, expect, it } from 'vitest';
import { resolveClientIp, type ClientIpOptions } from './clientIp.js';

const behindCloudflare: ClientIpOptions = {
  // Two representative Cloudflare ranges + loopback (tunnel) for the tests.
  trustedProxies: ['173.245.48.0/20', '2400:cb00::/32', '127.0.0.1/32'],
  trustCloudflareHeader: true,
};

describe('resolveClientIp', () => {
  it('trusts CF-Connecting-IP when the peer is a Cloudflare address', () => {
    const r = resolveClientIp(
      {
        socketAddress: '173.245.48.5',
        cfConnectingIp: '203.0.113.7',
        forwardedFor: '203.0.113.7, 173.245.48.5',
      },
      behindCloudflare,
    );
    expect(r).toEqual({ ip: '203.0.113.7', source: 'cf' });
  });

  it('ignores forged headers from an untrusted direct client', () => {
    const r = resolveClientIp(
      {
        socketAddress: '198.51.100.9',
        cfConnectingIp: '1.2.3.4',
        forwardedFor: '1.2.3.4',
      },
      behindCloudflare,
    );
    expect(r).toEqual({ ip: '198.51.100.9', source: 'socket' });
  });

  it('falls back to X-Forwarded-For when CF header is absent but peer is trusted', () => {
    const r = resolveClientIp(
      {
        socketAddress: '127.0.0.1',
        forwardedFor: '203.0.113.20, 127.0.0.1',
      },
      behindCloudflare,
    );
    expect(r).toEqual({ ip: '203.0.113.20', source: 'xff' });
  });

  it('does not trust the CF header when trustCloudflareHeader is off', () => {
    const r = resolveClientIp(
      { socketAddress: '127.0.0.1', cfConnectingIp: '9.9.9.9', forwardedFor: '203.0.113.30' },
      { ...behindCloudflare, trustCloudflareHeader: false },
    );
    expect(r).toEqual({ ip: '203.0.113.30', source: 'xff' });
  });

  it('handles IPv4-mapped IPv6 socket addresses', () => {
    const r = resolveClientIp(
      { socketAddress: '::ffff:173.245.48.5', cfConnectingIp: '203.0.113.7' },
      behindCloudflare,
    );
    expect(r).toEqual({ ip: '203.0.113.7', source: 'cf' });
  });

  it('returns the socket address when no proxies are trusted', () => {
    const r = resolveClientIp(
      { socketAddress: '203.0.113.99', cfConnectingIp: '1.1.1.1' },
      { trustedProxies: [], trustCloudflareHeader: true },
    );
    expect(r).toEqual({ ip: '203.0.113.99', source: 'socket' });
  });

  it('walks multiple XFF hops and skips trusted proxies right-to-left', () => {
    const r = resolveClientIp(
      {
        socketAddress: '127.0.0.1',
        forwardedFor: '203.0.113.40, 173.245.48.9, 127.0.0.1',
      },
      behindCloudflare,
    );
    expect(r).toEqual({ ip: '203.0.113.40', source: 'xff' });
  });
});
