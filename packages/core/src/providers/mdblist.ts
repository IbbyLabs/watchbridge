import { HttpClient, HttpError } from './http.js';
import {
  emptyPushResult,
  type MediaRef,
  type ProgressEvent,
  type ProviderCapabilities,
  type PushResult,
  type WatchEvent,
} from './types.js';

const MDBLIST_BASE = 'https://api.mdblist.com';
/** MDBList caps `/sync/watched` at 1000 rows per page. */
const PAGE_LIMIT = 1000;
/** Bound on history pages so a runaway response never loops forever. */
const MAX_PAGES = 50;

interface WatchedTitle {
  ids?: { tmdb?: number | null };
}
interface WatchedMovie {
  movie: WatchedTitle;
}
interface WatchedEpisode {
  episode: { season: number; number: number; show: WatchedTitle };
}
interface WatchedResponse {
  movies?: WatchedMovie[];
  episodes?: WatchedEpisode[];
  pagination?: { has_more?: boolean };
}

/** `/sync/playback` uses `imdbid`/`tmdbid` id keys, unlike the rest of the API. */
interface PlaybackIds {
  imdbid?: string | null;
  tmdbid?: number | null;
}
interface PlaybackRow {
  type: 'movie' | 'episode';
  progress: number;
  paused_at?: string | null;
  movie?: { ids: PlaybackIds };
  show?: { ids: PlaybackIds };
  episode?: { season: number; number: number };
}

/**
 * MDBList (api.mdblist.com) provider. It exposes a Trakt-shaped sync surface:
 * `/scrobble/{start,pause,stop}` (a `stop` marks the title watched), and
 * `/sync/watched` / `/sync/playback` for pulling history and resume points.
 * The API key authenticates as the `apikey` query parameter.
 *
 * Writes go through scrobble, which timestamps at "now" and can't backdate, so
 * `datedHistory` is false. History convergence is handled by the engine: it
 * diffs against `pullHistory` before writing, so re-runs push nothing new.
 */
export class MdblistClient {
  readonly id = 'mdblist' as const;
  private readonly http: HttpClient;

  constructor(apiKey: string) {
    this.http = new HttpClient({
      baseUrl: MDBLIST_BASE,
      defaultQuery: { apikey: apiKey },
      // Pace conservatively; MDBList is generous but not documented per-second.
      minIntervalMs: 40,
      headers: { 'user-agent': 'Watchbridge' },
    });
  }

  capabilities(): ProviderCapabilities {
    return { history: true, progress: true, ratings: false, watchlist: true, datedHistory: false };
  }

  /** Validate the API key. Returns true if accepted, false on 401/403. */
  async validate(): Promise<boolean> {
    try {
      await this.http.get('/user');
      return true;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return false;
      throw err;
    }
  }

  // ── History ──────────────────────────────────────────────────────

  async pullHistory(_since?: string | null): Promise<WatchEvent[]> {
    const out: WatchEvent[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.http.get<WatchedResponse>(
        `/sync/watched?limit=${PAGE_LIMIT}&offset=${offset}`,
      );
      for (const m of res.movies ?? []) {
        const tmdb = m.movie.ids?.tmdb;
        if (tmdb) out.push({ ref: { kind: 'movie', ids: { tmdb } }, watchedAt: null });
      }
      for (const e of res.episodes ?? []) {
        const tmdb = e.episode.show.ids?.tmdb;
        if (tmdb) {
          out.push({
            ref: {
              kind: 'episode',
              ids: { tmdb },
              season: e.episode.season,
              number: e.episode.number,
            },
            watchedAt: null,
          });
        }
      }
      if (!res.pagination?.has_more) break;
      offset += PAGE_LIMIT;
    }
    return out;
  }

  async pushHistory(events: WatchEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    for (const event of events) {
      const ok = await this.scrobble('stop', event.ref, 100);
      if (ok === 'ok') result.added++;
      else if (ok === 'not_found') result.notFound++;
      else result.failed++;
    }
    return result;
  }

  // ── Progress ─────────────────────────────────────────────────────

  async pullProgress(): Promise<ProgressEvent[]> {
    const rows = await this.http.get<PlaybackRow[]>('/sync/playback');
    const out: ProgressEvent[] = [];
    for (const r of rows ?? []) {
      if (r.type === 'movie' && r.movie) {
        out.push({
          ref: this.refFromPlayback('movie', r.movie.ids),
          progress: r.progress,
          pausedAt: r.paused_at ?? null,
        });
      } else if (r.type === 'episode' && r.show && r.episode) {
        out.push({
          ref: this.refFromPlayback('episode', r.show.ids, r.episode.season, r.episode.number),
          progress: r.progress,
          pausedAt: r.paused_at ?? null,
        });
      }
    }
    return out;
  }

  async pushProgress(events: ProgressEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    for (const event of events) {
      // A pause carries a resume position without claiming the title is playing.
      const ok = await this.scrobble('pause', event.ref, event.progress);
      if (ok === 'ok') result.added++;
      else if (ok === 'not_found') result.notFound++;
      else result.failed++;
    }
    return result;
  }

  // ── helpers ──────────────────────────────────────────────────────

  /** Trakt-shaped scrobble. A 404 means MDBList doesn't know the title. */
  private async scrobble(
    action: 'start' | 'pause' | 'stop',
    ref: MediaRef,
    progress: number,
  ): Promise<'ok' | 'not_found' | 'failed'> {
    // A whole-show mark can't be expressed via scrobble (it's per episode).
    if (ref.kind === 'show') return 'not_found';
    const ids = this.scrobbleIds(ref);
    if (!ids) return 'not_found';
    const body =
      ref.kind === 'episode'
        ? {
            show: { ids, season: { number: ref.season, episode: { number: ref.number } } },
            progress,
          }
        : { movie: { ids }, progress };
    try {
      await this.http.post(`/scrobble/${action}`, body);
      return 'ok';
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return 'not_found';
      return 'failed';
    }
  }

  /** The ids MDBList accepts on a scrobble; null when we have nothing to match on. */
  private scrobbleIds(ref: MediaRef): { imdb?: string; tmdb?: number } | null {
    const ids: { imdb?: string; tmdb?: number } = {};
    if (ref.ids.imdb) ids.imdb = ref.ids.imdb;
    if (ref.ids.tmdb) ids.tmdb = ref.ids.tmdb;
    return ids.imdb || ids.tmdb ? ids : null;
  }

  private refFromPlayback(
    kind: 'movie' | 'episode',
    ids: PlaybackIds,
    season?: number,
    number?: number,
  ): MediaRef {
    return {
      kind,
      ids: { imdb: ids.imdbid ?? undefined, tmdb: ids.tmdbid ?? undefined },
      season,
      number,
    };
  }
}
