/**
 * Cloudflare published edge ranges. Used to expand the `cloudflare` keyword in
 * TRUSTED_PROXIES so an operator fronting the origin with Cloudflare can trust
 * `CF-Connecting-IP` without pasting the full list.
 *
 * Source: https://www.cloudflare.com/ips/ — refresh if Cloudflare updates them.
 */
export const CLOUDFLARE_IPV4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
] as const;

export const CLOUDFLARE_IPV6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const;

export const LOOPBACK = ['127.0.0.1/32', '::1/128'] as const;

export const PRIVATE_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
] as const;

/**
 * Expand a raw TRUSTED_PROXIES list, resolving the keywords `cloudflare`,
 * `loopback`, and `private` into their concrete CIDR ranges. Anything else is
 * passed through verbatim (a CIDR or bare IP).
 */
export function expandTrustedProxies(entries: string[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    switch (key) {
      case 'cloudflare':
        out.push(...CLOUDFLARE_IPV4, ...CLOUDFLARE_IPV6);
        break;
      case 'loopback':
        out.push(...LOOPBACK);
        break;
      case 'private':
        out.push(...PRIVATE_RANGES);
        break;
      default:
        out.push(raw.trim());
    }
  }
  return out;
}
