import { randomBytes } from 'node:crypto';
import {
  MdblistClient,
  PmdbClient,
  SimklClient,
  TraktClient,
  type AppConfig,
  type DeviceCode,
  type ProviderId,
  type SyncTarget,
} from '@watchbridge/core';
import type { ConnectionStore, PublicConnection } from './store.js';

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
      let label = 'Trakt';
      try {
        const settings = await this.newTrakt(tokens).getSettings();
        if (settings.username) label = settings.username;
      } catch {
        // keep default label
      }
      await this.store.upsert(currentUserId, 'trakt', label, { kind: 'trakt', ...tokens });
    } else {
      const accessToken = await this.newSimkl().exchangeCode(code, uri);
      await this.store.upsert(currentUserId, 'simkl', 'Simkl', { kind: 'simkl', accessToken });
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

    let label = 'Trakt';
    try {
      const settings = await this.newTrakt(res).getSettings();
      if (settings.username) label = settings.username;
    } catch {
      // Non-fatal: keep the default label.
    }
    await this.store.upsert(userId, 'trakt', label, {
      kind: 'trakt',
      accessToken: res.accessToken,
      refreshToken: res.refreshToken,
      expiresAt: res.expiresAt,
    });
    return 'connected';
  }

  // ── Simkl PIN flow ───────────────────────────────────────────────

  startSimklPin() {
    return this.newSimkl().requestPin();
  }

  async pollSimklPin(userId: string, userCode: string): Promise<PollStatus> {
    const res = await this.newSimkl().pollPin(userCode);
    if (res === 'pending') return 'pending';
    await this.store.upsert(userId, 'simkl', 'Simkl', { kind: 'simkl', accessToken: res });
    return 'connected';
  }

  // ── PMDB api key ─────────────────────────────────────────────────

  async connectPmdb(userId: string, apiKey: string): Promise<PublicConnection> {
    const ok = await new PmdbClient(apiKey).validate();
    if (!ok) throw new InvalidApiKey();
    return this.store.upsert(userId, 'pmdb', 'PublicMetaDB', { kind: 'pmdb', apiKey });
  }

  // ── MDBList api key ───────────────────────────────────────────────

  async connectMdblist(userId: string, apiKey: string): Promise<PublicConnection> {
    const ok = await new MdblistClient(apiKey).validate();
    if (!ok) throw new InvalidApiKey();
    return this.store.upsert(userId, 'mdblist', 'MDBList', { kind: 'mdblist', apiKey });
  }

  // ── Connected clients (for the sync engine) ──────────────────────

  async traktFor(userId: string): Promise<TraktClient | null> {
    const c = await this.store.getCreds(userId, 'trakt');
    if (!c || c.creds.kind !== 'trakt') return null;
    const connId = c.id;
    return this.newTrakt(
      {
        accessToken: c.creds.accessToken,
        refreshToken: c.creds.refreshToken,
        expiresAt: c.creds.expiresAt,
      },
      (tokens) => this.store.updateCreds(connId, { kind: 'trakt', ...tokens }),
    );
  }

  async simklFor(userId: string): Promise<SimklClient | null> {
    const c = await this.store.getCreds(userId, 'simkl');
    if (!c || c.creds.kind !== 'simkl') return null;
    return this.newSimkl(c.creds.accessToken);
  }

  async pmdbFor(userId: string): Promise<PmdbClient | null> {
    const c = await this.store.getCreds(userId, 'pmdb');
    if (!c || c.creds.kind !== 'pmdb') return null;
    return new PmdbClient(c.creds.apiKey);
  }

  async mdblistFor(userId: string): Promise<MdblistClient | null> {
    const c = await this.store.getCreds(userId, 'mdblist');
    if (!c || c.creds.kind !== 'mdblist') return null;
    return new MdblistClient(c.creds.apiKey);
  }

  /** A connected client for a provider, as the read/write port the engine uses. */
  async clientFor(userId: string, provider: ProviderId): Promise<SyncTarget | null> {
    if (provider === 'trakt') return this.traktFor(userId);
    if (provider === 'simkl') return this.simklFor(userId);
    if (provider === 'mdblist') return this.mdblistFor(userId);
    return this.pmdbFor(userId);
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

export class InvalidApiKey extends Error {
  constructor() {
    super('The API key was rejected');
    this.name = 'InvalidApiKey';
  }
}
