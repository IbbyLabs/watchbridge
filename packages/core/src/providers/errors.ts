import { HttpError } from './http.js';
import type { ProviderId } from './types.js';

const LABEL: Record<ProviderId, string> = {
  trakt: 'Trakt',
  simkl: 'Simkl',
  pmdb: 'PublicMetaDB',
  mdblist: 'MDBList',
};

/**
 * Turn a provider failure into a sentence someone can act on.
 *
 * Status meanings follow Trakt's published table, which Simkl and MDBList track
 * closely enough for the shared cases. Anything unrecognised falls back to a
 * plain description rather than a raw code, so nothing surfaces as "HTTP 423".
 */
export function describeProviderError(provider: ProviderId, err: unknown): string {
  const name = LABEL[provider] ?? provider;
  if (!(err instanceof HttpError)) {
    const detail = err instanceof Error ? err.message : String(err);
    return `${name} could not be reached: ${detail}`;
  }

  switch (err.status) {
    case 400:
      return `${name} rejected the request as malformed. This is a bug in Watchbridge, not something you can fix.`;
    case 401:
      return `${name} no longer accepts this sign-in. Connect the account again.`;
    case 403:
      return `${name} refused the request. The account may have been disconnected, or this server's ${name} application key is not approved.`;
    case 404:
      return `${name} does not have a record for this item.`;
    case 410:
      return `This ${name} account is deactivated. Sign in on ${name}'s own site to reactivate it, then connect again.`;
    case 412:
      return `${name} rejected the request format. This is a bug in Watchbridge, not something you can fix.`;
    case 420:
      return `This ${name} account has hit a limit on how much it can hold. Free up space on ${name}, or upgrade the account there.`;
    case 422:
      return `${name} would not accept the data sent for this item.`;
    case 423:
      return `This ${name} account is locked. ${name} unlocks it after you run a history analysis in your account settings there.`;
    case 426:
      return `${name} reserves this feature for paid accounts.`;
    case 429:
      return `${name} is rate-limiting this server. Watchbridge already backs off and retries; if this keeps happening, sync less often.`;
    default:
      if (err.status >= 500) {
        return `${name} is having trouble on their end (${err.status}). It usually clears on its own — the next run will try again.`;
      }
      return `${name} returned an unexpected ${err.status} response.`;
  }
}

/**
 * Whether retrying could plausibly succeed. A permanent rejection means the
 * caller should stop rather than burn through the provider's rate limit.
 */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof HttpError)) return true; // network trouble, worth another go
  return err.status === 429 || err.status >= 500;
}
