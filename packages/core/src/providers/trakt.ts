import { HttpClient, HttpError } from './http.js';
import { createLogger } from '../logger.js';
import { describeProviderError } from './errors.js';
import { sharedRateGate, type RateGate } from './rateGate.js';
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

const log = createLogger('trakt');

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
interface TraktRatingMovie {
  rated_at: string;
  rating: number;
  movie: { title?: string; year?: number; ids: TraktIdBlock };
}
interface TraktRatingShow {
  rated_at: string;
  rating: number;
  show: { title?: string; year?: number; ids: TraktIdBlock };
}
interface TraktWatchlistMovie {
  listed_at: string;
  movie: { title?: string; year?: number; ids: TraktIdBlock };
}
interface TraktWatchlistShow {
  listed_at: string;
  show: { title?: string; year?: number; ids: TraktIdBlock };
}
interface TraktListWriteResponse {
  added?: { movies?: number; shows?: number };
  deleted?: { movies?: number; shows?: number };
  existing?: { movies?: number; shows?: number };
  not_found?: { movies?: unknown[]; shows?: unknown[] };
}

export interface TraktConfig {
  clientId: string;
  clientSecret: string;
  tokens?: TraktTokens;
  /** Persist refreshed tokens (server wires this to the connection store). */
  onRefresh?: (tokens: TraktTokens) => Promise<void>;
  /** Override the process-wide pacer. Mainly so tests are not serialized by it. */
  gate?: RateGate;
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
  /** Newest history activity seen on the last pull, for the next run's cursor. */
  lastActivityAll?: string;
  /** Set when the cursor said nothing changed, so an empty pull is not a loss. */
  lastPullSkipped = false;
  /** GETs the last pull cost, so the saving is measurable rather than asserted. */
  lastPullRequests = 0;
  private readonly http: HttpClient;
  private tokens?: TraktTokens;

  constructor(private readonly cfg: TraktConfig) {
    this.tokens = cfg.tokens;
    this.http = new HttpClient({
      baseUrl: TRAKT_BASE,
      // 1000 GET per 5 minutes (~3.3/sec) but only 1 write per second.
      minIntervalMs: 350,
      writeMinIntervalMs: 1_000,
      // Trakt counts every request against the app's client_id, so pacing has to
      // span all of this process's Trakt clients, not just this one.
      gate: cfg.gate ?? sharedRateGate('trakt'),
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

  /**
   * The newest history timestamp, or undefined if the call fails. A failure
   * falls through to a full pull rather than skipping one: a missed cursor costs
   * requests, a wrongly-skipped pull costs a user their sync.
   */
  private async historyActivityAt(): Promise<string | undefined> {
    try {
      this.lastPullRequests++;
      const acts = await this.getLastActivities();
      const seen = [acts?.episodes?.watched_at, acts?.movies?.watched_at].filter(
        (v): v is string => typeof v === 'string',
      );
      return seen.length === 0 ? undefined : seen.sort().at(-1);
    } catch {
      return undefined;
    }
  }

  getLastActivities(): Promise<Record<string, Record<string, string>>> {
    return this.authed((auth) => this.http.get('/sync/last_activities', { headers: auth }));
  }

  /**
   * `uuid` is Trakt's globally unique per-user identifier. Trakt documents it as
   * the value to identify a user locally, and unlike the username it does not
   * change, which is what makes it usable for spotting a reconnect to a
   * different account.
   */
  async getSettings(): Promise<{ username?: string; uuid?: string }> {
    const r = await this.authed<{ user?: { username?: string; ids?: { uuid?: string } } }>((auth) =>
      this.http.get('/users/settings', { headers: auth }),
    );
    return { username: r.user?.username, uuid: r.user?.ids?.uuid };
  }

  /**
   * `/sync/last_activities` carries a timestamp per section, so a user whose
   * history has not moved costs one request instead of a full re-page of the
   * library. Rate limits are per application credential, so that cost is shared
   * by everyone using the app rather than borne by the user who has it.
   *
   * Same shape as the Simkl client: read the cursor, skip when it matches, and
   * report the skip so an empty result is not mistaken for an empty library.
   */
  async pullHistory(since?: string | null): Promise<WatchEvent[]> {
    this.lastPullRequests = 0;
    this.lastPullSkipped = false;

    const activity = await this.historyActivityAt();
    if (activity) this.lastActivityAll = activity;
    if (since && activity && since === activity) {
      this.lastPullSkipped = true;
      return [];
    }

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
        else {
          // A 404 or 405 means the endpoint is gone rather than the write being
          // rejected, and the two are otherwise indistinguishable here.
          if (err instanceof HttpError && (err.status === 404 || err.status === 405)) {
            log.warn(
              { status: err.status, endpoint: '/scrobble/pause' },
              'Trakt no longer serves the resume-position endpoint; resume positions are not being written',
            );
          }
          // Every other provider explains a failed write through the result;
          // a bare count gives the user nothing to act on.
          result.note ??= describeProviderError('trakt', err);
          result.failed++;
        }
      }
    }
    return result;
  }

  async pullRatings(): Promise<RatingEvent[]> {
    // Movies and shows only. Trakt rates episodes by the episode's own id, which
    // an episode ref does not carry, so episode ratings are out of scope for now.
    const movies = await this.pageAll<TraktRatingMovie>('/sync/ratings/movies');
    const shows = await this.pageAll<TraktRatingShow>('/sync/ratings/shows');
    const out: RatingEvent[] = [];
    for (const m of movies) {
      out.push({
        ref: { kind: 'movie', ids: toIds(m.movie.ids), title: m.movie.title, year: m.movie.year },
        rating: m.rating,
        ratedAt: m.rated_at,
      });
    }
    for (const s of shows) {
      out.push({
        ref: { kind: 'show', ids: toIds(s.show.ids), title: s.show.title, year: s.show.year },
        rating: s.rating,
        ratedAt: s.rated_at,
      });
    }
    return out;
  }

  async pushRatings(events: RatingEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    const movies: Array<Record<string, unknown>> = [];
    const shows: Array<Record<string, unknown>> = [];

    for (const e of events) {
      if (e.ref.kind !== 'movie' && e.ref.kind !== 'show') {
        result.notFound++; // episodes/seasons are not supported through this model
        continue;
      }
      if (!hasWritableId(e.ref.ids)) {
        result.notFound++;
        continue;
      }
      const entry = { rating: e.rating, rated_at: e.ratedAt ?? undefined, ids: writableIds(e.ref.ids) };
      (e.ref.kind === 'movie' ? movies : shows).push(entry);
    }

    if (movies.length === 0 && shows.length === 0) return result;

    const res = await this.authed<{ not_found?: { movies?: unknown[]; shows?: unknown[] } }>((auth) =>
      this.http.post('/sync/ratings', { movies, shows }, { headers: auth }),
    );
    const rejected = (res?.not_found?.movies?.length ?? 0) + (res?.not_found?.shows?.length ?? 0);
    result.notFound += rejected;
    result.added = movies.length + shows.length - rejected;
    return result;
  }

  async pullWatchlist(): Promise<WatchlistEvent[]> {
    // Movies and shows only. A season or episode can sit on a Trakt watchlist,
    // but neither maps onto a whole-title watchlist entry elsewhere.
    const movies = await this.pageAll<TraktWatchlistMovie>('/sync/watchlist/movies');
    const shows = await this.pageAll<TraktWatchlistShow>('/sync/watchlist/shows');
    const out: WatchlistEvent[] = [];
    for (const m of movies) {
      out.push({
        ref: { kind: 'movie', ids: toIds(m.movie.ids), title: m.movie.title, year: m.movie.year },
        listedAt: m.listed_at ?? null,
      });
    }
    for (const s of shows) {
      out.push({
        ref: { kind: 'show', ids: toIds(s.show.ids), title: s.show.title, year: s.show.year },
        listedAt: s.listed_at ?? null,
      });
    }
    return out;
  }

  async pushWatchlist(events: WatchlistEvent[]): Promise<PushResult> {
    return this.writeWatchlist(events, '/sync/watchlist');
  }

  async removeWatchlist(events: WatchlistEvent[]): Promise<PushResult> {
    return this.writeWatchlist(events, '/sync/watchlist/remove');
  }

  /** Add and remove take the same media-ids body and return the same envelope. */
  private async writeWatchlist(events: WatchlistEvent[], path: string): Promise<PushResult> {
    const result = emptyPushResult();
    const movies: Array<Record<string, unknown>> = [];
    const shows: Array<Record<string, unknown>> = [];

    for (const e of events) {
      if ((e.ref.kind !== 'movie' && e.ref.kind !== 'show') || !hasWritableId(e.ref.ids)) {
        result.notFound++;
        continue;
      }
      (e.ref.kind === 'movie' ? movies : shows).push({ ids: writableIds(e.ref.ids) });
    }

    const sent = movies.length + shows.length;
    if (sent === 0) return result;

    let res: TraktListWriteResponse;
    try {
      res = await this.authed<TraktListWriteResponse>((auth) =>
        this.http.post(path, { movies, shows }, { headers: auth }),
      );
    } catch (err) {
      // Trakt answers 420 when the account's watchlist is at its limit. Retrying
      // cannot help, so report it as something the user has to resolve.
      if (err instanceof HttpError && err.status === 420) {
        result.failed = sent;
        result.note = 'Trakt refused the additions because this account’s watchlist is full.';
        return result;
      }
      throw err;
    }

    const rejected = (res?.not_found?.movies?.length ?? 0) + (res?.not_found?.shows?.length ?? 0);
    const applied = res?.added ?? res?.deleted;
    result.notFound += rejected;
    result.added = applied ? (applied.movies ?? 0) + (applied.shows ?? 0) : sent - rejected;
    result.skipped = (res?.existing?.movies ?? 0) + (res?.existing?.shows ?? 0);
    return result;
  }

  // ── helpers ──────────────────────────────────────────────────────

  private async pageAll<T>(path: string, limit = 100): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    let page = 1;
    let previousFirstRow: string | undefined;

    for (;;) {
      this.lastPullRequests++;
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
