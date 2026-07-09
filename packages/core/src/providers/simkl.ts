import { HttpClient, HttpError } from './http.js';
import {
  emptyPushResult,
  type ExternalIds,
  type MediaRef,
  type ProgressEvent,
  type ProviderCapabilities,
  type PushResult,
  type WatchEvent,
} from './types.js';

const SIMKL_BASE = 'https://api.simkl.com';

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
  movie: { title?: string; year?: number; ids: SimklIdBlock };
}
interface SimklShowItem {
  last_watched_at?: string;
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
  expiresIn: number;
  interval: number;
}

export interface SimklConfig {
  clientId: string;
  clientSecret?: string;
  accessToken?: string;
  appName?: string;
  appVersion?: string;
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

  /** Latest `/sync/activities` "all" timestamp seen during a pull (delta cursor). */
  lastActivityAll?: string;

  constructor(private readonly cfg: SimklConfig) {
    this.http = new HttpClient({
      baseUrl: SIMKL_BASE,
      minIntervalMs: 300,
      headers: {
        'simkl-api-key': cfg.clientId,
        'user-agent': `${cfg.appName ?? 'Watchbridge'}/${cfg.appVersion ?? '0.1.0'}`,
        ...(cfg.accessToken ? { authorization: `Bearer ${cfg.accessToken}` } : {}),
      },
      // Simkl requires app-name/app-version on every request or it suspends the key.
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

  authorizeUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      state,
    });
    return `https://simkl.com/oauth/authorize?${params.toString()}`;
  }

  /** Exchange the redirect code for an access token. */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const r = await this.http.post<{ access_token?: string }>('/oauth/token', {
      code,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    if (!r.access_token) throw new Error('Simkl code exchange failed');
    return r.access_token;
  }

  // ── PIN auth flow ────────────────────────────────────────────────

  async requestPin(): Promise<SimklPin & { userCode: string }> {
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

  /** Poll once. Returns an access token when authorized, or 'pending'. */
  async pollPin(userCode: string): Promise<string | 'pending'> {
    const r = await this.http.get<{ result: string; access_token?: string; message?: string }>(
      `/oauth/pin/${userCode}?client_id=${this.cfg.clientId}`,
    );
    if (r.result === 'OK' && r.access_token) return r.access_token;
    return 'pending';
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

  // ── Reads ────────────────────────────────────────────────────────

  getActivities(): Promise<Record<string, unknown>> {
    return this.http.get('/sync/activities');
  }

  /** The `/sync/activities` "all" timestamp — used as the delta cursor. */
  async currentActivity(): Promise<string | undefined> {
    try {
      const a = await this.getActivities();
      return typeof a.all === 'string' ? a.all : undefined;
    } catch {
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
    if (since && ts && since === ts) return []; // unchanged — don't hit the library

    const delta = since ? `&date_from=${encodeURIComponent(since)}` : '';
    const out: WatchEvent[] = [];

    const movies = await this.http
      .get<{ movies?: SimklMovieItem[] }>(`/sync/all-items/movies/completed?extended=full${delta}`)
      .catch(() => ({ movies: [] }));
    for (const m of movies.movies ?? []) {
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
      const res = await this.http
        .get<Record<string, SimklShowItem[]>>(
          `/sync/all-items/${type}?extended=full&include_all_episodes=yes&episode_watched_at=yes${delta}`,
        )
        .catch(() => ({}) as Record<string, SimklShowItem[]>);
      const items = res[type] ?? res.shows ?? [];
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
    const items = await this.http
      .get<SimklPlaybackItem[]>('/sync/playback')
      .catch(() => [] as SimklPlaybackItem[]);
    const out: ProgressEvent[] = [];
    for (const it of items ?? []) {
      if (it.type === 'movie' && it.movie) {
        out.push({ ref: { kind: 'movie', ids: toIds(it.movie.ids), title: it.movie.title }, progress: it.progress, pausedAt: it.paused_at ?? null });
      } else if (it.type === 'episode' && it.show && it.episode) {
        out.push({
          ref: { kind: 'episode', ids: toIds(it.show.ids), season: it.episode.season, number: it.episode.number, title: it.show.title },
          progress: it.progress,
          pausedAt: it.paused_at ?? null,
        });
      }
    }
    return out;
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
      } catch {
        result.failed++;
      }
    }
    return result;
  }

  // ── Writes ───────────────────────────────────────────────────────

  async pushHistory(events: WatchEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    const movies: Array<Record<string, unknown>> = [];
    const wholeShows: Array<Record<string, unknown>> = [];
    const showsByKey = new Map<string, { ids: ExternalIds; seasons: Map<number, Set<number>> }>();

    for (const e of events) {
      if (e.ref.kind === 'movie') {
        if (!hasId(e.ref.ids)) {
          result.notFound++;
          continue;
        }
        movies.push({ watched_at: e.watchedAt ?? undefined, ids: e.ref.ids });
      } else if (e.ref.kind === 'show') {
        // Whole series watched — send the show with no seasons so Simkl marks all
        // aired episodes.
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
        const eps = show.seasons.get(e.ref.season) ?? new Set<number>();
        eps.add(e.ref.number);
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
          episodes: [...eps].map((n) => ({ number: n })),
        })),
      })),
    ];

    if (movies.length === 0 && shows.length === 0) return result;

    try {
      await this.http.post('/sync/history', { movies, shows });
      const episodeAdds = [...showsByKey.values()].reduce(
        (a, s) => a + [...s.seasons.values()].reduce((b, eps) => b + eps.size, 0),
        0,
      );
      result.added = movies.length + wholeShows.length + episodeAdds;
    } catch {
      result.failed = events.length;
    }
    return result;
  }
}

const hasId = (ids: ExternalIds): boolean =>
  Boolean(ids.imdb || ids.tmdb || ids.tvdb || ids.simkl || ids.mal || ids.anilist);

const idKey = (ids: ExternalIds): string =>
  ids.simkl ? `s${ids.simkl}` : ids.imdb ? `i${ids.imdb}` : ids.tmdb ? `m${ids.tmdb}` : ids.tvdb ? `v${ids.tvdb}` : `a${ids.anilist ?? ids.mal}`;
