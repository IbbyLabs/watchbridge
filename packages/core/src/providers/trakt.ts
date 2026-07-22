import { HttpClient, HttpError } from './http.js';
import {
  emptyPushResult,
  positionFromRuntime,
  type ExternalIds,
  type MediaRef,
  type ProgressEvent,
  type ProviderCapabilities,
  type PushResult,
  type WatchEvent,
} from './types.js';

/** Backstop on paging, so a misbehaving endpoint cannot spin indefinitely. */
const MAX_PAGES = 200;

const TRAKT_BASE = 'https://api.trakt.tv';
const OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

export interface TraktTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

interface TraktIdBlock {
  trakt?: number;
  slug?: string;
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
}

interface TraktHistoryMovie {
  watched_at: string;
  movie: { title?: string; year?: number; ids: TraktIdBlock };
}
interface TraktHistoryEpisode {
  watched_at: string;
  episode: { season: number; number: number; ids: TraktIdBlock };
  show: { title?: string; year?: number; ids: TraktIdBlock };
}
interface TraktPlaybackItem {
  progress: number;
  paused_at: string;
  type: 'movie' | 'episode';
  // `runtime` (minutes) is present on the movie/episode object with extended=full.
  movie?: { title?: string; year?: number; runtime?: number; ids: TraktIdBlock };
  episode?: { season: number; number: number; runtime?: number; ids: TraktIdBlock };
  show?: { title?: string; year?: number; ids: TraktIdBlock };
}

export interface TraktConfig {
  clientId: string;
  clientSecret: string;
  tokens?: TraktTokens;
  /** Persist refreshed tokens (server wires this to the connection store). */
  onRefresh?: (tokens: TraktTokens) => Promise<void>;
}

const toIds = (b: TraktIdBlock): ExternalIds => ({
  ...(b.imdb ? { imdb: b.imdb } : {}),
  ...(b.tmdb ? { tmdb: b.tmdb } : {}),
  ...(b.tvdb ? { tvdb: b.tvdb } : {}),
  ...(b.trakt ? { trakt: b.trakt } : {}),
  ...(b.slug ? { slug: b.slug } : {}),
});

export class TraktClient {
  readonly id = 'trakt' as const;
  private readonly http: HttpClient;
  private tokens?: TraktTokens;

  constructor(private readonly cfg: TraktConfig) {
    this.tokens = cfg.tokens;
    this.http = new HttpClient({
      baseUrl: TRAKT_BASE,
      minIntervalMs: 350,
      headers: {
        'trakt-api-version': '2',
        'trakt-api-key': cfg.clientId,
        'user-agent': 'Watchbridge',
      },
    });
  }

  capabilities(): ProviderCapabilities {
    return { history: true, progress: true, ratings: true, watchlist: true, datedHistory: true };
  }

  // ── Authorization-code (redirect) flow ───────────────────────────

  /** URL to send the user's browser to for the redirect OAuth flow. */
  authorizeUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      state,
    });
    return `https://trakt.tv/oauth/authorize?${params.toString()}`;
  }

  /** Exchange the code Trakt redirected back with for tokens. */
  async exchangeCode(code: string, redirectUri: string): Promise<TraktTokens> {
    const r = await this.http.post<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      created_at: number;
    }>('/oauth/token', {
      code,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    return this.storeTokens(r);
  }

  // ── Device OAuth flow ────────────────────────────────────────────

  async requestDeviceCode(): Promise<DeviceCode> {
    const r = await this.http.post<{
      device_code: string;
      user_code: string;
      verification_url: string;
      expires_in: number;
      interval: number;
    }>('/oauth/device/code', { client_id: this.cfg.clientId });
    return {
      deviceCode: r.device_code,
      userCode: r.user_code,
      verificationUrl: r.verification_url,
      expiresIn: r.expires_in,
      interval: r.interval,
    };
  }

  /**
   * Poll once for the device token. Returns tokens when authorized, or a status
   * string: 'pending' (keep polling), 'slow_down', 'expired', 'denied'.
   */
  async pollDeviceToken(deviceCode: string): Promise<TraktTokens | 'pending' | 'slow_down' | 'expired' | 'denied'> {
    try {
      const r = await this.http.post<{
        access_token: string;
        refresh_token: string;
        expires_in: number;
        created_at: number;
      }>('/oauth/device/token', {
        code: deviceCode,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      });
      return this.storeTokens(r);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      switch (err.status) {
        case 400:
          return 'pending';
        case 429:
          return 'slow_down';
        case 410:
          return 'expired';
        case 418:
          return 'denied';
        default:
          throw err;
      }
    }
  }

  private storeTokens(r: { access_token: string; refresh_token: string; expires_in: number }): TraktTokens {
    const tokens: TraktTokens = {
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresAt: Date.now() + r.expires_in * 1000,
    };
    this.tokens = tokens;
    return tokens;
  }

  private async ensureFresh(): Promise<string> {
    if (!this.tokens) throw new Error('Trakt client has no tokens');
    if (this.tokens.expiresAt - Date.now() > 60_000) return this.tokens.accessToken;

    const r = await this.http.post<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
    }>('/oauth/token', {
      refresh_token: this.tokens.refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      redirect_uri: OOB_REDIRECT,
      grant_type: 'refresh_token',
    });
    const tokens = this.storeTokens(r);
    await this.cfg.onRefresh?.(tokens);
    return tokens.accessToken;
  }

  private async authed<T>(fn: (auth: Record<string, string>) => Promise<T>): Promise<T> {
    const token = await this.ensureFresh();
    try {
      return await fn({ authorization: `Bearer ${token}` });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401 && this.tokens) {
        // Force a refresh and retry once.
        this.tokens = { ...this.tokens, expiresAt: 0 };
        const retryToken = await this.ensureFresh();
        return fn({ authorization: `Bearer ${retryToken}` });
      }
      throw err;
    }
  }

  // ── Reads ────────────────────────────────────────────────────────

  getLastActivities(): Promise<Record<string, Record<string, string>>> {
    return this.authed((auth) => this.http.get('/sync/last_activities', { headers: auth }));
  }

  async getSettings(): Promise<{ username?: string }> {
    const r = await this.authed<{ user?: { username?: string } }>((auth) =>
      this.http.get('/users/settings', { headers: auth }),
    );
    return { username: r.user?.username };
  }

  async pullHistory(_since?: string | null): Promise<WatchEvent[]> {
    const movies = await this.pageAll<TraktHistoryMovie>('/sync/history/movies');
    const episodes = await this.pageAll<TraktHistoryEpisode>('/sync/history/episodes');
    const out: WatchEvent[] = [];
    for (const m of movies) {
      out.push({
        ref: { kind: 'movie', ids: toIds(m.movie.ids), title: m.movie.title, year: m.movie.year },
        watchedAt: m.watched_at,
      });
    }
    for (const e of episodes) {
      out.push({
        ref: {
          kind: 'episode',
          ids: toIds(e.show.ids),
          season: e.episode.season,
          number: e.episode.number,
          title: e.show.title,
        },
        watchedAt: e.watched_at,
      });
    }
    return out;
  }

  async pullProgress(): Promise<ProgressEvent[]> {
    // extended=full adds `runtime` (minutes) so downstream targets that need a
    // resume position in milliseconds (PMDB) can reconstruct it.
    const items = await this.pageAll<TraktPlaybackItem>('/sync/playback?extended=full');
    const out: ProgressEvent[] = [];
    for (const it of items) {
      if (it.type === 'movie' && it.movie) {
        out.push({
          ref: { kind: 'movie', ids: toIds(it.movie.ids), title: it.movie.title },
          progress: it.progress,
          pausedAt: it.paused_at,
          ...positionFromRuntime(it.movie.runtime, it.progress),
        });
      } else if (it.type === 'episode' && it.episode && it.show) {
        out.push({
          ref: { kind: 'episode', ids: toIds(it.show.ids), season: it.episode.season, number: it.episode.number, title: it.show.title },
          progress: it.progress,
          pausedAt: it.paused_at,
          ...positionFromRuntime(it.episode.runtime, it.progress),
        });
      }
    }
    return out;
  }

  // ── Writes ───────────────────────────────────────────────────────

  async pushHistory(events: WatchEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    const movies: Array<Record<string, unknown>> = [];
    const wholeShows: Array<Record<string, unknown>> = [];
    const showsByKey = new Map<string, { ids: ExternalIds; seasons: Map<number, Array<{ number: number; watched_at: string | null }>> }>();

    for (const e of events) {
      if (e.ref.kind === 'movie') {
        if (!hasWritableId(e.ref.ids)) {
          result.notFound++;
          continue;
        }
        movies.push({ watched_at: e.watchedAt ?? undefined, ids: writableIds(e.ref.ids) });
      } else if (e.ref.kind === 'show') {
        // Whole series watched — Trakt marks every aired episode.
        if (!hasWritableId(e.ref.ids)) {
          result.notFound++;
          continue;
        }
        wholeShows.push({ ids: writableIds(e.ref.ids) });
      } else {
        if (e.ref.season === undefined || e.ref.number === undefined || !hasWritableId(e.ref.ids)) {
          result.notFound++;
          continue;
        }
        const key = idKey(e.ref.ids);
        const show = showsByKey.get(key) ?? { ids: writableIds(e.ref.ids), seasons: new Map() };
        const eps = show.seasons.get(e.ref.season) ?? [];
        eps.push({ number: e.ref.number, watched_at: e.watchedAt });
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
          episodes: eps.map((ep) => ({ number: ep.number, watched_at: ep.watched_at ?? undefined })),
        })),
      })),
    ];

    if (movies.length === 0 && shows.length === 0) return result;

    const res = await this.authed<{ added?: { movies?: number; episodes?: number } }>((auth) =>
      this.http.post('/sync/history', { movies, shows }, { headers: auth }),
    );
    result.added = (res.added?.movies ?? 0) + (res.added?.episodes ?? 0);
    return result;
  }

  /** Write resume positions via `/scrobble/pause` (one call per item). */
  async pushProgress(events: ProgressEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    for (const e of events) {
      let body: Record<string, unknown>;
      if (e.ref.kind === 'movie') {
        if (!hasWritableId(e.ref.ids)) {
          result.notFound++;
          continue;
        }
        body = { movie: { ids: writableIds(e.ref.ids) }, progress: e.progress };
      } else if (e.ref.kind === 'episode') {
        if (e.ref.season === undefined || e.ref.number === undefined || !hasWritableId(e.ref.ids)) {
          result.notFound++;
          continue;
        }
        body = {
          show: { ids: writableIds(e.ref.ids) },
          episode: { season: e.ref.season, number: e.ref.number },
          progress: e.progress,
        };
      } else {
        // Whole-show markers carry no resume position.
        result.notFound++;
        continue;
      }
      try {
        await this.authed((auth) => this.http.post('/scrobble/pause', body, { headers: auth }));
        result.added++;
      } catch (err) {
        // 409 = a scrobble for this item is already in progress; treat as applied.
        if (err instanceof HttpError && err.status === 409) result.added++;
        else result.failed++;
      }
    }
    return result;
  }

  // ── helpers ──────────────────────────────────────────────────────

  private async pageAll<T>(path: string, limit = 100): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    let page = 1;
    let previousFirstRow: string | undefined;

    for (;;) {
      const rows = await this.authed<T[]>((auth) =>
        this.http.get(`${path}${sep}page=${page}&limit=${limit}`, { headers: auth }),
      );

      // Not every Trakt collection is paginated. One that isn't returns the whole
      // set whatever the limit says, so take it once instead of asking forever.
      if (rows.length > limit) {
        out.push(...rows);
        break;
      }

      // Likewise, an endpoint that ignores `page` hands back the same rows every
      // time; without this the loop would never end and would duplicate them.
      const firstRow = rows.length > 0 ? JSON.stringify(rows[0]) : undefined;
      if (firstRow !== undefined && firstRow === previousFirstRow) break;
      previousFirstRow = firstRow;

      out.push(...rows);
      if (rows.length < limit) break;
      if (++page > MAX_PAGES) break;
    }
    return out;
  }
}

function writableIds(ids: ExternalIds): TraktIdBlock {
  return {
    ...(ids.trakt ? { trakt: ids.trakt } : {}),
    ...(ids.imdb ? { imdb: ids.imdb } : {}),
    ...(ids.tmdb ? { tmdb: ids.tmdb } : {}),
    ...(ids.tvdb ? { tvdb: ids.tvdb } : {}),
    ...(ids.slug ? { slug: ids.slug } : {}),
  };
}

const hasWritableId = (ids: ExternalIds): boolean =>
  Boolean(ids.trakt || ids.imdb || ids.tmdb || ids.tvdb || ids.slug);

const idKey = (ids: ExternalIds): string =>
  ids.trakt ? `t${ids.trakt}` : ids.imdb ? `i${ids.imdb}` : ids.tmdb ? `m${ids.tmdb}` : ids.tvdb ? `v${ids.tvdb}` : `s${ids.slug}`;
