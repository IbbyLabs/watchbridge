import { createHash, randomBytes } from 'node:crypto';
import {
  HttpError,
  MdblistClient,
  PmdbClient,
  SimklClient,
  TraktClient,
  createLogger,
  type AppConfig,
  type DeviceCode,
  type ProviderId,
  type SyncTarget,
} from '@watchbridge/core';
import type { ConnectionStore, PublicConnection } from './store.js';

const log = createLogger('connections');

export class ProviderNotConfigured extends Error {
  constructor(readonly provider: ProviderId) {
    super(`${provider} is not configured on this server`);
    this.name = 'ProviderNotConfigured';
  }
}

export class OAuthStateError extends Error {
  constructor() {
    super('The sign-in link is invalid or expired');
    this.name = 'OAuthStateError';
  }
}

type RedirectProvider = 'trakt' | 'simkl';

/** Short-lived, single-use OAuth `state` values bound to a user (CSRF defence). */
class OAuthStateStore {
  private readonly map = new Map<
    string,
    { userId: string; provider: RedirectProvider; expiresAt: number }
  >();

  create(userId: string, provider: RedirectProvider): string {
    const state = randomBytes(24).toString('base64url');
    this.map.set(state, { userId, provider, expiresAt: Date.now() + 600_000 });
    return state;
  }

  consume(state: string): { userId: string; provider: RedirectProvider } | null {
    const entry = this.map.get(state);
    this.map.delete(state);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return { userId: entry.userId, provider: entry.provider };
  }
}

export type PollStatus = 'pending' | 'connected' | 'expired' | 'denied' | 'slow_down';

/**
 * Builds provider clients from server config + stored per-user credentials, and
 * drives the connect flows. Trakt clients persist refreshed tokens back to the store.
 */
export class ConnectionService {
  constructor(
    private readonly store: ConnectionStore,
    private readonly config: AppConfig,
  ) {}

  private readonly states = new OAuthStateStore();

  isConfigured(provider: ProviderId): boolean {
    if (provider === 'trakt')
      return Boolean(this.config.TRAKT_CLIENT_ID && this.config.TRAKT_CLIENT_SECRET);
    if (provider === 'simkl') return Boolean(this.config.SIMKL_CLIENT_ID);
    return true; // pmdb and mdblist are per-user keys, always available
  }

  /** Whether the redirect (authorization-code) flow is available — needs a secret. */
  redirectConfigured(provider: RedirectProvider): boolean {
    if (provider === 'trakt') return this.isConfigured('trakt');
    return Boolean(this.config.SIMKL_CLIENT_ID && this.config.SIMKL_CLIENT_SECRET);
  }

  // ── Authorization-code (redirect) flow ───────────────────────────

  private redirectUri(provider: RedirectProvider): string {
    return `${this.config.APP_URL}/api/connections/${provider}/callback`;
  }

  /** Build the provider authorize URL to send the user's browser to. */
  authorizeUrl(userId: string, provider: RedirectProvider): string {
    if (!this.redirectConfigured(provider)) throw new ProviderNotConfigured(provider);
    const state = this.states.create(userId, provider);
    const uri = this.redirectUri(provider);
    return provider === 'trakt'
      ? this.newTrakt().authorizeUrl(uri, state)
      : this.newSimkl().authorizeUrl(uri, state);
  }

  /** Handle the callback: validate state, exchange the code, store the connection. */
  async completeRedirect(
    state: string,
    code: string,
    currentUserId: string,
  ): Promise<RedirectProvider> {
    const entry = this.states.consume(state);
    if (!entry || entry.userId !== currentUserId) throw new OAuthStateError();
    const uri = this.redirectUri(entry.provider);

    if (entry.provider === 'trakt') {
      const tokens = await this.newTrakt().exchangeCode(code, uri);
      const who = await this.whoIsTrakt(tokens);
      await this.store.upsert(currentUserId, 'trakt', who.label, { kind: 'trakt', ...tokens }, who.account);
    } else {
      const accessToken = await this.newSimkl().exchangeCode(code, uri);
      const who = await this.whoIsSimkl(accessToken);
      await this.store.upsert(currentUserId, 'simkl', who.label, { kind: 'simkl', accessToken }, who.account);
    }
    return entry.provider;
  }

  // ── Trakt device flow ────────────────────────────────────────────

  startTraktDevice(): Promise<DeviceCode> {
    return this.newTrakt().requestDeviceCode();
  }

  async pollTraktDevice(userId: string, deviceCode: string): Promise<PollStatus> {
    const client = this.newTrakt();
    const res = await client.pollDeviceToken(deviceCode);
    if (typeof res === 'string') return res;

    const who = await this.whoIsTrakt(res);
    await this.store.upsert(
      userId,
      'trakt',
      who.label,
      {
        kind: 'trakt',
        accessToken: res.accessToken,
        refreshToken: res.refreshToken,
        expiresAt: res.expiresAt,
      },
      who.account,
    );
    return 'connected';
  }

  // ── Simkl PIN flow ───────────────────────────────────────────────

  startSimklPin() {
    return this.newSimkl().requestPin();
  }

  async pollSimklPin(userId: string, userCode: string): Promise<PollStatus> {
    const res = await this.newSimkl().pollPin(userCode);
    if (res === 'pending') return 'pending';
    const who = await this.whoIsSimkl(res);
    await this.store.upsert(userId, 'simkl', who.label, { kind: 'simkl', accessToken: res }, who.account);
    return 'connected';
  }

  // ── PMDB api key ─────────────────────────────────────────────────

  async connectPmdb(userId: string, apiKey: string): Promise<PublicConnection> {
    const ok = await new PmdbClient(apiKey).validate();
    if (!ok) throw new InvalidApiKey();
    // The key is the account for a key-based provider, so its fingerprint stands
    // in for an account id. Only the hash is stored.
    return this.store.upsert(userId, 'pmdb', 'PublicMetaDB', { kind: 'pmdb', apiKey }, fingerprint(apiKey));
  }

  // ── MDBList api key ───────────────────────────────────────────────

  async connectMdblist(userId: string, apiKey: string): Promise<PublicConnection> {
    const ok = await new MdblistClient(apiKey).validate();
    if (!ok) throw new InvalidApiKey();
    return this.store.upsert(userId, 'mdblist', 'MDBList', { kind: 'mdblist', apiKey }, fingerprint(apiKey));
  }

  // ── Connected clients (for the sync engine) ──────────────────────

  async traktFor(userId: string): Promise<TraktClient | null> {
    const c = await this.store.getCreds(userId, 'trakt');
    if (!c || c.creds.kind !== 'trakt') return null;
    const connId = c.id;
    return this.watchCredentials(
      this.newTrakt(
        {
          accessToken: c.creds.accessToken,
          refreshToken: c.creds.refreshToken,
          expiresAt: c.creds.expiresAt,
        },
        (tokens) => this.store.updateCreds(connId, { kind: 'trakt', ...tokens }),
      ),
      connId,
      'trakt',
    );
  }

  async simklFor(userId: string): Promise<SimklClient | null> {
    const c = await this.store.getCreds(userId, 'simkl');
    if (!c || c.creds.kind !== 'simkl') return null;
    return this.watchCredentials(this.newSimkl(c.creds.accessToken), c.id, 'simkl');
  }

  async pmdbFor(userId: string): Promise<PmdbClient | null> {
    const c = await this.store.getCreds(userId, 'pmdb');
    if (!c || c.creds.kind !== 'pmdb') return null;
    return this.watchCredentials(new PmdbClient(c.creds.apiKey), c.id, 'pmdb');
  }

  async mdblistFor(userId: string): Promise<MdblistClient | null> {
    const c = await this.store.getCreds(userId, 'mdblist');
    if (!c || c.creds.kind !== 'mdblist') return null;
    return this.watchCredentials(new MdblistClient(c.creds.apiKey), c.id, 'mdblist');
  }

  /**
   * Flag a connection for reconnection the moment the provider rejects its
   * credentials. A 401/403 survives no amount of retrying — Trakt already tries
   * one forced refresh before the error escapes — so without this a revoked
   * token leaves the connection reading "connected" while every run fails.
   */
  private watchCredentials<T extends object>(client: T, connectionId: string, provider: ProviderId): T {
    return new Proxy(client, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (!(out instanceof Promise)) return out;
          return out.catch((err: unknown) => {
            if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
              log.warn({ provider, connectionId, status: err.status }, 'Provider rejected the stored credentials');
              void this.store
                .setStatus(connectionId, 'reauth')
                .catch((e) => log.error({ provider, connectionId, err: e }, 'Failed to flag the connection for reconnection'));
            }
            throw err;
          });
        };
      },
    });
  }

  /** A connected client for a provider, as the read/write port the engine uses. */
  async clientFor(userId: string, provider: ProviderId): Promise<SyncTarget | null> {
    if (provider === 'trakt') return this.traktFor(userId);
    if (provider === 'simkl') return this.simklFor(userId);
    if (provider === 'mdblist') return this.mdblistFor(userId);
    return this.pmdbFor(userId);
  }

  /**
   * Who a set of Trakt tokens belongs to. Failing to find out is not fatal —
   * a null account just means a later reconnect cannot be compared against this
   * one, which is no worse than before the identity was tracked at all.
   */
  private async whoIsTrakt(
    tokens: { accessToken: string; refreshToken: string; expiresAt: number },
  ): Promise<{ label: string; account: string | null }> {
    try {
      const settings = await this.newTrakt(tokens).getSettings();
      return { label: settings.username ?? 'Trakt', account: settings.uuid ?? null };
    } catch (err) {
      log.warn({ provider: 'trakt', err }, 'Could not read the account behind this connection');
      return { label: 'Trakt', account: null };
    }
  }

  private async whoIsSimkl(accessToken: string): Promise<{ label: string; account: string | null }> {
    try {
      const settings = await this.newSimkl(accessToken).getSettings();
      return { label: settings.name ?? 'Simkl', account: settings.accountId ?? null };
    } catch (err) {
      log.warn({ provider: 'simkl', err }, 'Could not read the account behind this connection');
      return { label: 'Simkl', account: null };
    }
  }

  // ── factories ────────────────────────────────────────────────────

  private newTrakt(
    tokens?: { accessToken: string; refreshToken: string; expiresAt: number },
    onRefresh?: (t: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    }) => Promise<void>,
  ): TraktClient {
    if (!this.isConfigured('trakt')) throw new ProviderNotConfigured('trakt');
    return new TraktClient({
      clientId: this.config.TRAKT_CLIENT_ID!,
      clientSecret: this.config.TRAKT_CLIENT_SECRET!,
      tokens,
      onRefresh,
    });
  }

  private newSimkl(accessToken?: string): SimklClient {
    if (!this.isConfigured('simkl')) throw new ProviderNotConfigured('simkl');
    return new SimklClient({
      clientId: this.config.SIMKL_CLIENT_ID!,
      clientSecret: this.config.SIMKL_CLIENT_SECRET,
      accessToken,
      // Sourced from config so a release/v tag bumps it (see APP_VERSION wiring).
      appName: this.config.APP_NAME,
      appVersion: this.config.APP_VERSION,
    });
  }
}

/** A stable, non-reversible stand-in for an API key. */
function fingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 32);
}

export class InvalidApiKey extends Error {
  constructor() {
    super('The API key was rejected');
    this.name = 'InvalidApiKey';
  }
}
