import { createHash, randomBytes } from 'node:crypto';
import { HttpClient, HttpError } from './http.js';
import { createLogger } from '../logger.js';
import { describeProviderError } from './errors.js';
import { sharedRateGate, type RateGate } from './rateGate.js';
import { sharesAnyId } from '../sync/identity.js';
import {
  emptyPushResult,
  positionFromRuntime,
  type ExternalIds,
  type MediaRef,
  type ProgressEvent,
  type ProviderCapabilities,
  type PushResult,
  type RatingEvent,
  type WatchEvent,
  type WatchlistEvent,
} from './types.js';

const SIMKL_BASE = 'https://api.simkl.com';

const log = createLogger('simkl');

interface SimklRatedMovie {
  user_rating?: number | null;
  user_rated_at?: string | null;
  movie: { title?: string; year?: number; ids: SimklIdBlock };
}
interface SimklRatedShow {
  user_rating?: number | null;
  user_rated_at?: string | null;
  show: { title?: string; year?: number; ids: SimklIdBlock };
}
interface SimklRatingsResponse {
  movies?: SimklRatedMovie[];
  shows?: SimklRatedShow[];
  anime?: SimklRatedShow[];
}
interface SimklWriteResponse {
  not_found?: { movies?: unknown[]; shows?: unknown[] };
}

interface SimklIdBlock {
  simkl?: number;
  imdb?: string;
  tmdb?: number | string;
  tvdb?: number | string;
  mal?: number | string;
  anilist?: number | string;
  anidb?: number | string;
}

interface SimklMovieItem {
  last_watched_at?: string;
  added_to_watchlist_at?: string;
  status?: string;
  movie: { title?: string; year?: number; ids: SimklIdBlock };
}
interface SimklShowItem {
  last_watched_at?: string;
  added_to_watchlist_at?: string;
  status?: string; // watching | completed | hold | dropped | plantowatch
  watched_episodes_count?: number;
  total_episodes_count?: number;
  show: { title?: string; year?: number; ids: SimklIdBlock };
  seasons?: Array<{ number: number; episodes?: Array<{ number: number; watched_at?: string }> }>;
}

interface SimklPlaybackItem {
  progress: number; // 0-100
  paused_at?: string;
  type: 'movie' | 'episode';
  movie?: { title?: string; year?: number; ids: SimklIdBlock };
  show?: { title?: string; year?: number; ids: SimklIdBlock };
  episode?: { season: number; number: number };
}

export interface SimklPin {
  userCode: string;
  verificationUrl: string;
  /** V2 device flow only: the RFC 8628 URL with the code pre-filled (for a QR). */
  verificationUriComplete?: string;
  /** V2 device flow only: the secret the server polls with (never shown). */
  deviceCode?: string;
  expiresIn: number;
  interval: number;
}

/** V2 tokens carry a refresh token + expiry; V1 carries only the access token. */
export interface SimklTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface SimklConfig {
  clientId: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Which AUTH version this client speaks. Defaults to 'v1'. */
  authVersion?: 'v1' | 'v2';
  /** Persist refreshed tokens back to the store (V2 only). */
  onRefresh?: (tokens: SimklTokens) => Promise<void>;
  appName?: string;
  appVersion?: string;
  /** Override the process-wide pacer. Mainly so tests are not serialized by it. */
  gate?: RateGate;
}

/** PKCE pair for the V2 authorization-code flow: S256 only. */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function parseErrorBody(raw: string): { error?: string } | undefined {
  try {
    return JSON.parse(raw) as { error?: string };
  } catch {
    return undefined;
  }
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const toIds = (b: SimklIdBlock): ExternalIds => ({
  ...(b.imdb ? { imdb: String(b.imdb) } : {}),
  ...(num(b.tmdb) !== undefined ? { tmdb: num(b.tmdb) } : {}),
  ...(num(b.tvdb) !== undefined ? { tvdb: num(b.tvdb) } : {}),
  ...(num(b.simkl) !== undefined ? { simkl: num(b.simkl) } : {}),
  ...(num(b.mal) !== undefined ? { mal: num(b.mal) } : {}),
  ...(num(b.anilist) !== undefined ? { anilist: num(b.anilist) } : {}),
  ...(num(b.anidb) !== undefined ? { anidb: num(b.anidb) } : {}),
});

export class SimklClient {
  readonly id = 'simkl' as const;
  private readonly http: HttpClient;
  /** Separate client for the refresh call, so it never re-enters `http`'s
   *  serialized chain (which would deadlock the request that triggered it). */
  private readonly refreshHttp: HttpClient;
  private readonly authVersion: 'v1' | 'v2';
  private tokens?: SimklTokens;

  /** Latest `/sync/activities` "all" timestamp seen during a pull (delta cursor). */
  lastActivityAll?: string;

  /**
   * True when the last history pull was skipped because Simkl reported nothing
   * had changed. Without this, an empty result reads the same as "no new items",
   * so a cursor that has stopped moving would look like a healthy quiet sync.
   */
  lastPullSkipped = false;

  constructor(private readonly cfg: SimklConfig) {
    this.authVersion = cfg.authVersion ?? 'v1';
    this.tokens = cfg.accessToken
      ? { accessToken: cfg.accessToken, refreshToken: cfg.refreshToken, expiresAt: cfg.expiresAt }
      : undefined;
    this.http = new HttpClient({
      baseUrl: SIMKL_BASE,
      // 10 GET/sec but 1 POST/sec per client_id and per user token; sustained
      // overage gets the client_id suspended without warning.
      minIntervalMs: 300,
      writeMinIntervalMs: 1_000,
      // Simkl suspends a client_id for sustained overage, and it counts every
      // request made with the key — so all Simkl clients share one pacer.
      gate: cfg.gate ?? sharedRateGate('simkl'),
      headers: {
        'simkl-api-key': cfg.clientId,
        'user-agent': `${cfg.appName ?? 'Watchbridge'}/${cfg.appVersion ?? '0.1.0'}`,
      },
      // Simkl requires app-name/app-version on every request or it suspends the key.
      defaultQuery: {
        'app-name': cfg.appName ?? 'Watchbridge',
        'app-version': cfg.appVersion ?? '0.1.0',
      },
      // The access token is injected per request so a V2 token can be refreshed
      // in place without rebuilding the client.
      beforeRequest: () => this.authedHeaders(),
    });
    // The refresh call must not go through `this.http` (it would re-enter the
    // serialized chain mid-request and deadlock), so it gets its own client.
    this.refreshHttp = new HttpClient({
      baseUrl: SIMKL_BASE,
      gate: cfg.gate ?? sharedRateGate('simkl'),
      headers: { 'user-agent': `${cfg.appName ?? 'Watchbridge'}/${cfg.appVersion ?? '0.1.0'}` },
      defaultQuery: {
        'app-name': cfg.appName ?? 'Watchbridge',
        'app-version': cfg.appVersion ?? '0.1.0',
      },
    });
  }

  capabilities(): ProviderCapabilities {
    return { history: true, progress: true, ratings: true, watchlist: true, datedHistory: false };
  }

  // ── Authorization-code (redirect) flow ───────────────────────────

  authorizeUrl(redirectUri: string, state: string, codeChallenge?: string): string {
    if (this.authVersion === 'v2') {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: this.cfg.clientId,
        redirect_uri: redirectUri,
        state,
        scope: 'media:read media:write',
        code_challenge: codeChallenge ?? '',
        code_challenge_method: 'S256',
      });
      return `https://simkl.com/oauth2/authorize?${params.toString()}`;
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      state,
    });
    return `https://simkl.com/oauth/authorize?${params.toString()}`;
  }

  /** Exchange the redirect code for tokens. V2 also sends the PKCE verifier. */
  async exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<SimklTokens> {
    if (this.authVersion === 'v2') {
      const r = await this.http.post<{ access_token: string; refresh_token: string; expires_in: number }>(
        '/oauth2/token',
        {
          grant_type: 'authorization_code',
          code,
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        },
      );
      return this.storeTokens(r);
    }
    const r = await this.http.post<{ access_token?: string }>('/oauth/token', {
      code,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    if (!r.access_token) throw new Error('Simkl code exchange failed');
    return { accessToken: r.access_token };
  }

  // ── PIN / device auth flow ───────────────────────────────────────

  /** V1: GET /oauth/pin. V2: RFC 8628 device flow (POST /oauth2/device). */
  async requestPin(): Promise<SimklPin> {
    if (this.authVersion === 'v2') {
      const r = await this.http.post<{
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete?: string;
        expires_in: number;
        interval: number;
      }>('/oauth2/device', {
        client_id: this.cfg.clientId,
        scope: 'media:read media:write',
      });
      return {
        userCode: r.user_code,
        deviceCode: r.device_code,
        verificationUrl: r.verification_uri,
        verificationUriComplete: r.verification_uri_complete,
        expiresIn: r.expires_in,
        interval: r.interval,
      };
    }
    const r = await this.http.get<{
      result: string;
      user_code: string;
      verification_url: string;
      expires_in: number;
      interval: number;
    }>(`/oauth/pin?client_id=${this.cfg.clientId}`);
    if (r.result !== 'OK') throw new Error('Simkl PIN request failed');
    return {
      userCode: r.user_code,
      verificationUrl: r.verification_url,
      expiresIn: r.expires_in,
      interval: r.interval,
    };
  }

  /** V1 poll. Returns an access token when authorized, or 'pending'. */
  async pollPin(userCode: string): Promise<string | 'pending'> {
    const r = await this.http.get<{ result: string; access_token?: string; message?: string }>(
      `/oauth/pin/${userCode}?client_id=${this.cfg.clientId}`,
    );
    if (r.result === 'OK' && r.access_token) return r.access_token;
    return 'pending';
  }

  /** V2 device poll. Returns tokens when authorized, or a status string. */
  async pollDevice(deviceCode: string): Promise<SimklTokens | 'pending' | 'slow_down' | 'expired' | 'denied'> {
    try {
      const r = await this.http.post<{ access_token: string; refresh_token: string; expires_in: number }>(
        '/oauth2/token',
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: this.cfg.clientId,
          device_code: deviceCode,
        },
      );
      return this.storeTokens(r);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      switch (parseErrorBody(err.body)?.error) {
        case 'authorization_pending': return 'pending';
        case 'slow_down': return 'slow_down';
        case 'expired_token': return 'expired';
        case 'access_denied': return 'denied';
        default: throw err;
      }
    }
  }

  // ── Token refresh (V2) ───────────────────────────────────────────

  private storeTokens(r: { access_token: string; refresh_token?: string; expires_in: number }): SimklTokens {
    const tokens: SimklTokens = {
      accessToken: r.access_token,
      ...(r.refresh_token ? { refreshToken: r.refresh_token } : {}),
      expiresAt: Date.now() + r.expires_in * 1000,
    };
    this.tokens = tokens;
    return tokens;
  }

  /** The current access token, refreshing a near-expiry V2 token first. */
  private async ensureFresh(): Promise<string | undefined> {
    const t = this.tokens;
    if (!t) return undefined;
    if (!t.refreshToken) return t.accessToken; // V1: long-lived, no refresh
    if ((t.expiresAt ?? 0) - Date.now() > 60_000) return t.accessToken;

    const r = await this.refreshHttp.post<{ access_token: string; refresh_token: string; expires_in: number }>(
      '/oauth2/token',
      {
        grant_type: 'refresh_token',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: t.refreshToken,
      },
    );
    const tokens = this.storeTokens(r);
    await this.cfg.onRefresh?.(tokens);
    return tokens.accessToken;
  }

  private async authedHeaders(): Promise<Record<string, string>> {
    const token = await this.ensureFresh();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  async validate(): Promise<boolean> {
    try {
      await this.getActivities();
      return true;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return false;
      throw err;
    }
  }

  /** Display name and the stable numeric account id behind this token. */
  async getSettings(): Promise<{ name?: string; accountId?: string }> {
    const r = await this.http.post<{ user?: { name?: string }; account?: { id?: number | string } }>(
      '/users/settings',
      {},
    );
    const id = r?.account?.id;
    return { name: r?.user?.name, accountId: id === undefined || id === null ? undefined : String(id) };
  }

  // ── Reads ────────────────────────────────────────────────────────

  getActivities(): Promise<Record<string, unknown>> {
    return this.http.get('/sync/activities');
  }

  /** The `/sync/activities` "all" timestamp — used as the delta cursor. */
  async currentActivity(): Promise<string | undefined> {
    try {
      const a = await this.getActivities();
      return typeof a.all === 'string' ? a.all : undefined;
    } catch (err) {
      // Not fatal — the pull falls back to its saved cursor — but a cursor that
      // stops advancing because this keeps failing should not be invisible.
      log.warn({ err }, 'Could not read the Simkl activity cursor');
      return undefined;
    }
  }

  /**
   * Pull watched history. Follows Simkl's required protocol to avoid a suspended
   * key: check `/sync/activities` first; if nothing changed since the saved
   * cursor, skip the pull entirely; otherwise fetch only the `date_from` delta
   * (types fetched sequentially, never in parallel).
   */
  async pullHistory(since?: string | null): Promise<WatchEvent[]> {
    const ts = await this.currentActivity();
    if (ts) this.lastActivityAll = ts;
    this.lastPullSkipped = false;
    if (since && ts && since === ts) {
      this.lastPullSkipped = true;
      return []; // unchanged — don't hit the library
    }

    const delta = since ? `&date_from=${encodeURIComponent(since)}` : '';
    const out: WatchEvent[] = [];

    // Read failures are left to propagate. Swallowing one into an empty list
    // makes a broken pull indistinguishable from an empty library, and the run
    // then reports success having read nothing.
    const movies = await this.http.get<{ movies?: SimklMovieItem[] } | null>(
      `/sync/all-items/movies/completed?extended=full${delta}`,
    );
    for (const m of movies?.movies ?? []) {
      out.push({
        ref: { kind: 'movie', ids: toIds(m.movie.ids), title: m.movie.title, year: m.movie.year },
        watchedAt: m.last_watched_at ?? null,
      });
    }

    // Read every status, and force Simkl to enumerate watched episodes for all of
    // them: `include_all_episodes` lists seasons[].episodes[] for completed and
    // dropped shows too (they skip episode loading by default), and
    // `episode_watched_at` attaches the real per-episode date. Only actually-watched
    // episodes are returned (e.g. 1 watched of 160 → just that one), so this never
    // marks an unwatched episode. The whole-show branch is a fallback for any show
    // Simkl still declines to enumerate.
    for (const type of ['shows', 'anime'] as const) {
      const res = await this.http.get<Record<string, SimklShowItem[]> | null>(
        `/sync/all-items/${type}?extended=full&include_all_episodes=yes&episode_watched_at=yes${delta}`,
      );
      const items = res?.[type] ?? res?.shows ?? [];
      for (const s of items) {
        const ids = toIds(s.show.ids);
        const enumerated = (s.seasons ?? []).some((se) => (se.episodes ?? []).length > 0);
        if (enumerated) {
          for (const season of s.seasons ?? []) {
            for (const ep of season.episodes ?? []) {
              out.push({
                ref: { kind: 'episode', ids, season: season.number, number: ep.number, title: s.show.title },
                watchedAt: ep.watched_at ?? null,
              });
            }
          }
        } else if (s.status === 'completed') {
          // Fully watched but not enumerated — mark the whole series.
          out.push({ ref: { kind: 'show', ids, title: s.show.title }, watchedAt: s.last_watched_at ?? null });
        }
      }
    }
    return out;
  }

  /** Read resume positions from `/sync/playback` (a flat list of movies + episodes). */
  async pullProgress(): Promise<ProgressEvent[]> {
    const items = await this.http.get<SimklPlaybackItem[] | null>('/sync/playback');
    const out: ProgressEvent[] = [];
    for (const it of items ?? []) {
      if (it.type === 'movie' && it.movie) {
        const ids = toIds(it.movie.ids);
        // `/sync/playback` omits runtime; look it up so targets that store a
        // millisecond position (PMDB) can reconstruct one.
        const runtime = await this.runtimeMinutes('movie', ids);
        out.push({
          ref: { kind: 'movie', ids, title: it.movie.title },
          progress: it.progress,
          pausedAt: it.paused_at ?? null,
          ...positionFromRuntime(runtime, it.progress),
        });
      } else if (it.type === 'episode' && it.show && it.episode) {
        const ids = toIds(it.show.ids);
        const runtime = await this.runtimeMinutes('episode', ids);
        out.push({
          ref: { kind: 'episode', ids, season: it.episode.season, number: it.episode.number, title: it.show.title },
          progress: it.progress,
          pausedAt: it.paused_at ?? null,
          ...positionFromRuntime(runtime, it.progress),
        });
      }
    }
    return out;
  }

  /** Per-item runtime (minutes) from Simkl's detail endpoints; cached per client. */
  private readonly runtimeCache = new Map<string, number | undefined>();
  private async runtimeMinutes(kind: 'movie' | 'episode', ids: ExternalIds): Promise<number | undefined> {
    if (ids.simkl === undefined) return undefined; // no Simkl id — can't call the detail endpoint
    const isAnime = ids.mal !== undefined || ids.anilist !== undefined || ids.anidb !== undefined;
    const endpoint = kind === 'movie' ? 'movies' : isAnime ? 'anime' : 'tv';
    const key = `${endpoint}:${ids.simkl}`;
    const cached = this.runtimeCache.get(key);
    if (cached !== undefined || this.runtimeCache.has(key)) return cached;
    // For a TV/anime show the detail runtime is the typical episode length,
    // which is what an episode resume position needs.
    const runtime = await this.http
      .get<{ runtime?: number | null }>(`/${endpoint}/${ids.simkl}?extended=full`)
      .then((r) => (typeof r.runtime === 'number' && r.runtime > 0 ? r.runtime : undefined))
      .catch((err: unknown) => {
        // Optional enrichment: without it the item simply carries no millisecond
        // position, which is better than guessing one.
        log.debug({ endpoint, err }, 'No runtime available for this item');
        return undefined;
      });
    this.runtimeCache.set(key, runtime);
    return runtime;
  }

  /** Write resume positions via `/scrobble/pause` (one call per item). */
  async pushProgress(events: ProgressEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    for (const e of events) {
      if (e.ref.kind === 'movie') {
        if (!hasId(e.ref.ids)) {
          result.notFound++;
          continue;
        }
      } else if (e.ref.kind === 'episode') {
        if (e.ref.season === undefined || e.ref.number === undefined || !hasId(e.ref.ids)) {
          result.notFound++;
          continue;
        }
      } else {
        // Whole-show markers carry no resume position.
        result.notFound++;
        continue;
      }
      const body: Record<string, unknown> =
        e.ref.kind === 'movie'
          ? { movie: { ids: e.ref.ids }, progress: e.progress }
          : { show: { ids: e.ref.ids }, episode: { season: e.ref.season, number: e.ref.number }, progress: e.progress };
      try {
        await this.http.post('/scrobble/pause', body);
        result.added++;
      } catch (err) {
        result.failed++;
        // Keep the first reason: a whole batch usually fails for one cause, and a
        // bare count tells the user nothing they can act on.
        result.note ??= describeProviderError('simkl', err);
      }
    }
    return result;
  }

  // ── Writes ───────────────────────────────────────────────────────

  async pushHistory(events: WatchEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    const movies: Array<Record<string, unknown>> = [];
    const wholeShows: Array<Record<string, unknown>> = [];
    // Episode number to its watch time. Simkl defaults a missing watched_at to
    // the request time, so an import with the dates dropped lands every episode
    // on today.
    const showsByKey = new Map<
      string,
      { ids: ExternalIds; seasons: Map<number, Map<number, string | undefined>> }
    >();

    for (const e of events) {
      if (e.ref.kind === 'movie') {
        if (!hasId(e.ref.ids)) {
          result.notFound++;
          continue;
        }
        movies.push({ watched_at: e.watchedAt ?? undefined, ids: e.ref.ids });
      } else if (e.ref.kind === 'show') {
        // Whole series watched — send the show with no seasons so Simkl marks all
        // aired episodes. These land at the request time: watched_at is an
        // episode-level field, and a show entry has nowhere to carry one.
        if (!hasId(e.ref.ids)) {
          result.notFound++;
          continue;
        }
        wholeShows.push({ ids: e.ref.ids });
      } else {
        if (e.ref.season === undefined || e.ref.number === undefined || !hasId(e.ref.ids)) {
          result.notFound++;
          continue;
        }
        const key = idKey(e.ref.ids);
        const show = showsByKey.get(key) ?? { ids: e.ref.ids, seasons: new Map() };
        const eps = show.seasons.get(e.ref.season) ?? new Map<number, string | undefined>();
        // Two events for one episode: keep the earlier, which is the watch this
        // history records rather than a re-watch.
        const seen = eps.get(e.ref.number);
        const at = e.watchedAt ?? undefined;
        eps.set(e.ref.number, seen && at ? (seen < at ? seen : at) : (seen ?? at));
        show.seasons.set(e.ref.season, eps);
        showsByKey.set(key, show);
      }
    }

    const shows = [
      ...wholeShows,
      ...[...showsByKey.values()].map((s) => ({
        ids: s.ids,
        seasons: [...s.seasons.entries()].map(([number, eps]) => ({
          number,
          episodes: [...eps.entries()].map(([n, at]) => ({ number: n, watched_at: at })),
        })),
      })),
    ];

    if (movies.length === 0 && shows.length === 0) return result;

    try {
      const res = await this.http.post<SimklHistoryResponse>('/sync/history', { movies, shows });
      const episodeAdds = [...showsByKey.values()].reduce(
        (a, s) => a + [...s.seasons.values()].reduce((b, eps) => b + eps.size, 0),
        0,
      );
      const sent = movies.length + wholeShows.length + episodeAdds;

      // Simkl reports what it could not match. Its `added` count is not reliable
      // (it claims items it will not echo back on a later read, which is what
      // delivery memory handles), so subtract the rejections instead of trusting it.
      const rejected = refsRejectedBy(res?.not_found, events);
      result.notFoundRefs = rejected;
      result.notFound += rejected.length;
      result.added = sent - rejected.length;
    } catch (err) {
      result.failed = events.length;
      result.note = describeProviderError('simkl', err);
    }
    return result;
  }

  /**
   * Remove items from history. Simkl has no way to change a watch date, so a
   * correction is a removal followed by an add.
   */
  async removeHistory(events: WatchEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    const movies: Array<Record<string, unknown>> = [];
    const showsByKey = new Map<string, { ids: ExternalIds; seasons: Map<number, Set<number>> }>();

    for (const e of events) {
      if (!hasId(e.ref.ids)) {
        result.notFound++;
        continue;
      }
      if (e.ref.kind === 'movie') {
        movies.push({ ids: e.ref.ids });
      } else if (e.ref.kind === 'episode' && e.ref.season !== undefined && e.ref.number !== undefined) {
        const key = idKey(e.ref.ids);
        const show = showsByKey.get(key) ?? { ids: e.ref.ids, seasons: new Map() };
        const eps = show.seasons.get(e.ref.season) ?? new Set<number>();
        eps.add(e.ref.number);
        show.seasons.set(e.ref.season, eps);
        showsByKey.set(key, show);
      } else {
        result.notFound++;
      }
    }

    const shows = [...showsByKey.values()].map((s) => ({
      ids: s.ids,
      seasons: [...s.seasons.entries()].map(([number, eps]) => ({
        number,
        episodes: [...eps].map((n) => ({ number: n })),
      })),
    }));
    if (movies.length === 0 && shows.length === 0) return result;

    try {
      await this.http.post('/sync/history/remove', { movies, shows });
      result.added = movies.length + [...showsByKey.values()].reduce(
        (a, s) => a + [...s.seasons.values()].reduce((b, eps) => b + eps.size, 0),
        0,
      );
    } catch (err) {
      result.failed = events.length;
      result.note = describeProviderError('simkl', err);
    }
    return result;
  }

  async pullRatings(): Promise<RatingEvent[]> {
    // Movies and shows/anime only; Simkl does not rate episodes or seasons.
    const res = await this.http.post<SimklRatingsResponse>('/sync/ratings', {});
    const out: RatingEvent[] = [];
    for (const m of res?.movies ?? []) {
      if (m.user_rating == null) continue;
      out.push({
        ref: { kind: 'movie', ids: toIds(m.movie.ids), title: m.movie.title, year: m.movie.year },
        rating: m.user_rating,
        ratedAt: m.user_rated_at ?? null,
      });
    }
    for (const s of [...(res?.shows ?? []), ...(res?.anime ?? [])]) {
      if (s.user_rating == null) continue;
      out.push({
        ref: { kind: 'show', ids: toIds(s.show.ids), title: s.show.title, year: s.show.year },
        rating: s.user_rating,
        ratedAt: s.user_rated_at ?? null,
      });
    }
    return out;
  }

  async pushRatings(events: RatingEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    const movies: Array<Record<string, unknown>> = [];
    const shows: Array<Record<string, unknown>> = [];

    for (const e of events) {
      // Simkl rates movies and shows/anime only; episodes and seasons cannot be rated.
      if (e.ref.kind !== 'movie' && e.ref.kind !== 'show') {
        result.notFound++;
        continue;
      }
      if (!hasId(e.ref.ids)) {
        result.notFound++;
        continue;
      }
      const entry = { rating: e.rating, rated_at: e.ratedAt ?? undefined, ids: e.ref.ids };
      (e.ref.kind === 'movie' ? movies : shows).push(entry);
    }

    if (movies.length === 0 && shows.length === 0) return result;

    try {
      const res = await this.http.post<SimklWriteResponse>('/sync/ratings', { movies, shows });
      const rejected = (res?.not_found?.movies?.length ?? 0) + (res?.not_found?.shows?.length ?? 0);
      result.notFound += rejected;
      result.added = movies.length + shows.length - rejected;
    } catch (err) {
      result.failed = events.length;
      result.note = describeProviderError('simkl', err);
    }
    return result;
  }

  /**
   * Read the watchlist. Simkl has no single watchlist: it is a set of status
   * buckets, of which "plan to watch" and "on hold" are the ones a user thinks
   * of as their watchlist. Each bucket is fetched on its own so the responses
   * stay small — an unscoped `all-items` read returns the entire library.
   */
  async pullWatchlist(): Promise<WatchlistEvent[]> {
    const out: WatchlistEvent[] = [];
    for (const status of WATCHLIST_STATUSES) {
      const movies = await this.http.get<{ movies?: SimklMovieItem[] } | null>(
        `/sync/all-items/movies/${status}`,
      );
      for (const m of movies?.movies ?? []) {
        out.push({
          ref: { kind: 'movie', ids: toIds(m.movie.ids), title: m.movie.title, year: m.movie.year },
          listedAt: m.added_to_watchlist_at ?? null,
        });
      }

      for (const type of ['shows', 'anime'] as const) {
        const res = await this.http.get<Record<string, SimklShowItem[]> | null>(
          `/sync/all-items/${type}/${status}`,
        );
        for (const s of res?.[type] ?? res?.shows ?? []) {
          out.push({
            ref: { kind: 'show', ids: toIds(s.show.ids), title: s.show.title, year: s.show.year },
            listedAt: s.added_to_watchlist_at ?? null,
          });
        }
      }
    }
    return out;
  }

  /**
   * Add to the watchlist. Everything lands in "plan to watch": it is the bucket
   * a flat watchlist from another provider means, and "on hold" has no
   * equivalent to carry over.
   */
  async pushWatchlist(events: WatchlistEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    const movies: Array<Record<string, unknown>> = [];
    const shows: Array<Record<string, unknown>> = [];

    for (const e of events) {
      if ((e.ref.kind !== 'movie' && e.ref.kind !== 'show') || !hasId(e.ref.ids)) {
        result.notFound++;
        continue;
      }
      (e.ref.kind === 'movie' ? movies : shows).push({ to: 'plantowatch', ids: e.ref.ids });
    }

    const sent = movies.length + shows.length;
    if (sent === 0) return result;

    try {
      const res = await this.http.post<SimklWriteResponse>('/sync/add-to-list', { movies, shows });
      const rejected = (res?.not_found?.movies?.length ?? 0) + (res?.not_found?.shows?.length ?? 0);
      result.notFound += rejected;
      result.added = sent - rejected;
    } catch (err) {
      result.failed = sent;
      result.note = describeProviderError('simkl', err);
    }
    return result;
  }

  /**
   * Remove from the watchlist. Simkl has no list-only removal: the one endpoint
   * that takes an item off a list also drops it from watch history and clears
   * its rating. That is why watchlist removal is opt-in per sync rather than
   * something that happens by default.
   */
  async removeWatchlist(events: WatchlistEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    const movies: Array<Record<string, unknown>> = [];
    const shows: Array<Record<string, unknown>> = [];

    for (const e of events) {
      if ((e.ref.kind !== 'movie' && e.ref.kind !== 'show') || !hasId(e.ref.ids)) {
        result.notFound++;
        continue;
      }
      (e.ref.kind === 'movie' ? movies : shows).push({ ids: e.ref.ids });
    }

    const sent = movies.length + shows.length;
    if (sent === 0) return result;

    try {
      const res = await this.http.post<SimklWriteResponse>('/sync/history/remove', { movies, shows });
      const rejected = (res?.not_found?.movies?.length ?? 0) + (res?.not_found?.shows?.length ?? 0);
      result.notFound += rejected;
      result.added = sent - rejected;
    } catch (err) {
      result.failed = sent;
      result.note = describeProviderError('simkl', err);
    }
    return result;
  }
}

/** The Simkl status buckets that together make up a user's watchlist. */
const WATCHLIST_STATUSES = ['plantowatch', 'hold'] as const;

const hasId = (ids: ExternalIds): boolean =>
  Boolean(ids.imdb || ids.tmdb || ids.tvdb || ids.simkl || ids.mal || ids.anilist);

const idKey = (ids: ExternalIds): string =>
  ids.simkl ? `s${ids.simkl}` : ids.imdb ? `i${ids.imdb}` : ids.tmdb ? `m${ids.tmdb}` : ids.tvdb ? `v${ids.tvdb}` : `a${ids.anilist ?? ids.mal}`;

interface SimklNotFound {
  movies?: Array<{ ids?: ExternalIds }>;
  shows?: Array<{ ids?: ExternalIds; seasons?: Array<{ number?: number; episodes?: Array<{ number?: number }> }> }>;
}
interface SimklHistoryResponse {
  not_found?: SimklNotFound;
}

/** Map Simkl's `not_found` block back onto the events that were sent. */
function refsRejectedBy(notFound: SimklNotFound | undefined, sent: WatchEvent[]): MediaRef[] {
  if (!notFound) return [];
  const out: MediaRef[] = [];

  for (const m of notFound.movies ?? []) {
    const hit = sent.find((e) => e.ref.kind === 'movie' && sharesAnyId(e.ref.ids, m.ids));
    if (hit) out.push(hit.ref);
  }

  for (const show of notFound.shows ?? []) {
    const seasons = show.seasons ?? [];
    if (seasons.length === 0) {
      // A whole series Simkl does not know.
      const hit = sent.find((e) => e.ref.kind === 'show' && sharesAnyId(e.ref.ids, show.ids));
      if (hit) out.push(hit.ref);
      continue;
    }
    for (const season of seasons) {
      for (const ep of season.episodes ?? []) {
        const hit = sent.find(
          (e) =>
            e.ref.kind === 'episode' &&
            e.ref.season === season.number &&
            e.ref.number === ep.number &&
            sharesAnyId(e.ref.ids, show.ids),
        );
        if (hit) out.push(hit.ref);
      }
    }
  }
  return out;
}
