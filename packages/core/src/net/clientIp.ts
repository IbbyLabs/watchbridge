import ipaddr from 'ipaddr.js';

/**
 * Resolve the real client IP when running behind Cloudflare (and/or another
 * reverse proxy). The rule that keeps this spoof-resistant: forwarded headers
 * are only believed when the *direct* peer (the socket's remote address) is a
 * trusted proxy. A client hitting the origin directly can set any header it
 * likes, so its headers are ignored and its socket address is used.
 */

export interface ResolveClientIpInput {
  /** The immediate TCP peer address (e.g. Fastify `request.socket.remoteAddress`). */
  socketAddress: string | undefined;
  /** `X-Forwarded-For` header value(s). */
  forwardedFor?: string | string[] | undefined;
  /** `CF-Connecting-IP` header value(s). */
  cfConnectingIp?: string | string[] | undefined;
}

export interface ClientIpOptions {
  /** CIDR ranges / bare IPs whose forwarded headers are trusted. */
  trustedProxies: string[];
  /** Prefer the Cloudflare header over X-Forwarded-For when the peer is trusted. */
  trustCloudflareHeader: boolean;
}

export interface ClientIpResult {
  ip: string;
  source: 'cf' | 'xff' | 'socket';
}

type Range = [ipaddr.IPv4 | ipaddr.IPv6, number];

function parseRanges(cidrs: string[]): Range[] {
  const ranges: Range[] = [];
  for (const entry of cidrs) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      if (trimmed.includes('/')) {
        ranges.push(ipaddr.parseCIDR(trimmed) as Range);
      } else {
        const addr = ipaddr.parse(trimmed);
        ranges.push([addr, addr.kind() === 'ipv4' ? 32 : 128]);
      }
    } catch {
      // Ignore malformed entries; config validation surfaces these separately.
    }
  }
  return ranges;
}

function normalize(raw: string): (ipaddr.IPv4 | ipaddr.IPv6) | null {
  const value = raw.trim();
  if (!value || !ipaddr.isValid(value)) return null;
  let addr = ipaddr.parse(value);
  // Collapse IPv4-mapped IPv6 (::ffff:1.2.3.4) to plain IPv4 for matching.
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    addr = (addr as ipaddr.IPv6).toIPv4Address();
  }
  return addr;
}

function isTrusted(ip: string, ranges: Range[]): boolean {
  const addr = normalize(ip);
  if (!addr) return false;
  for (const [net, bits] of ranges) {
    if (net.kind() !== addr.kind()) continue;
    try {
      if (addr.match(net, bits)) return true;
    } catch {
      // kind mismatch already guarded; ignore other parse edge cases.
    }
  }
  return false;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function resolveClientIp(
  input: ResolveClientIpInput,
  options: ClientIpOptions,
): ClientIpResult {
  const socket = (input.socketAddress ?? '').trim();
  const ranges = parseRanges(options.trustedProxies);

  const peerTrusted = socket !== '' && isTrusted(socket, ranges);

  const fallback: ClientIpResult = {
    ip: normalize(socket)?.toString() ?? socket,
    source: 'socket',
  };

  if (!peerTrusted) {
    // Direct client connection (or unknown peer): never trust forwarded headers.
    return fallback;
  }

  if (options.trustCloudflareHeader) {
    const cf = firstHeaderValue(input.cfConnectingIp);
    const cfAddr = cf ? normalize(cf) : null;
    if (cfAddr) return { ip: cfAddr.toString(), source: 'cf' };
  }

  // Walk X-Forwarded-For right-to-left; the first hop that is not itself a
  // trusted proxy is the real client. If every hop is trusted, take the left-most.
  const xffRaw = firstHeaderValue(input.forwardedFor);
  if (xffRaw) {
    const hops = xffRaw
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i]!;
      const addr = normalize(hop);
      if (!addr) continue;
      if (!isTrusted(hop, ranges)) {
        return { ip: addr.toString(), source: 'xff' };
      }
      if (i === 0) {
        return { ip: addr.toString(), source: 'xff' };
      }
    }
  }

  return fallback;
}
