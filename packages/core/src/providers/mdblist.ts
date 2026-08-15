import { describeProviderError } from './errors.js';
import { HttpClient, HttpError } from './http.js';
import {
  emptyPushResult,
  type MediaRef,
  type ProgressEvent,
  type ProviderCapabilities,
  type PushResult,
  type ExternalIds,
  type WatchEvent,
} from './types.js';

/** A scrobble that failed for a reason worth passing back to the user. */
interface ScrobbleFailure {
  failed: string;
}

const MDBLIST_BASE = 'https://api.mdblist.com';
/**
 * Show entries per `/sync/watched` write. Over MDBList's cap of 200 the whole
 * request is rejected, so this splits rather than risking the batch.
 */
const SHOWS_PER_WRITE = 200;

type ScrobbleIds = { imdb?: string; tmdb?: number };

interface WatchedWriteResponse {
  updated?: { movies?: number; shows?: number; seasons?: number; episodes?: number };
  not_found?: Record<string, unknown[]>;
  errors?: unknown[];
}

/**
 * Identity key for grouping episodes into one show entry.
 *
 * imdb leads here where sync/identity.ts leads with tmdb. The difference is
 * deliberate: this groups a payload MDBList resolves, that one keys stored
 * delivery records. Harmonising them changes grouping on one side or every
 * stored key on the other.
 */
function idKey(ids: ScrobbleIds): string {
  return ids.imdb ? `imdb:${ids.imdb}` : `tmdb:${ids.tmdb}`;
}

/**
 * Split a write so no request carries more show entries than MDBList accepts.
 * Movies ride with the first batch; they have no cap of their own.
 */
function* batches(
  movies: Array<Record<string, unknown>>,
  shows: Array<Record<string, unknown>>,
): Generator<{ movies: Array<Record<string, unknown>>; shows: Array<Record<string, unknown>> }> {
  if (movies.length === 0 && shows.length === 0) return;
  let first = true;
  for (let i = 0; i < shows.length; i += SHOWS_PER_WRITE) {
    yield { movies: first ? movies : [], shows: shows.slice(i, i + SHOWS_PER_WRITE) };
    first = false;
  }
  if (first) yield { movies, shows: [] };
}
/** MDBList caps `/sync/watched` at 1000 rows per page. */
const PAGE_LIMIT = 1000;
/** Bound on history pages so a runaway response never loops forever. */
const MAX_PAGES = 50;

interface WatchedTitle {
  ids?: { tmdb?: number | null; imdb?: string | null; tvdb?: number | null; trakt?: number | null };
}

/**
 * Every id MDBList returned. Dropping the ones we do not key on makes a title
 * it knows only by imdb invisible to anything reading history back.
 */
function idsFrom(t: WatchedTitle | undefined): ExternalIds {
  const ids: ExternalIds = {};
  if (t?.ids?.tmdb) ids.tmdb = t.ids.tmdb;
  if (t?.ids?.imdb) ids.imdb = t.ids.imdb;
  if (t?.ids?.tvdb) ids.tvdb = t.ids.tvdb;
  if (t?.ids?.trakt) ids.trakt = t.ids.trakt;
  return ids;
}

/** Whether a ref carries anything MDBList can be asked about. */
function hasId(ids: ExternalIds): boolean {
  return Boolean(ids.tmdb || ids.imdb);
}
interface WatchedMovie {
  movie: WatchedTitle;
  last_watched_at?: string | null;
}
interface WatchedEpisode {
  episode: { season: number; number: number; show: WatchedTitle };
  last_watched_at?: string | null;
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
 * History writes go through `POST /sync/watched`, which carries `watched_at`
 * per item. Scrobble is kept for progress, where "now" is what a resume point
 * means. History convergence is handled by the engine: it diffs against
 * `pullHistory` before writing, so re-runs push nothing new.
 *
 * That endpoint updates in place and takes whatever date it is sent, without
 * comparing it to what is stored. Anything writing a date a user may not have
 * chosen has to decide that before calling this.
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
    return { history: true, progress: true, ratings: false, watchlist: true, datedHistory: true };
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
      // last_watched_at is the most recent play, not the first. It becomes the
      // one date the target gets.
      for (const m of res.movies ?? []) {
        const ids = idsFrom(m.movie);
        if (hasId(ids)) out.push({ ref: { kind: 'movie', ids }, watchedAt: m.last_watched_at ?? null });
      }
      for (const e of res.episodes ?? []) {
        const ids = idsFrom(e.episode.show);
        if (hasId(ids)) {
          out.push({
            ref: {
              kind: 'episode',
              ids,
              season: e.episode.season,
              number: e.episode.number,
            },
            watchedAt: e.last_watched_at ?? null,
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
    const movies: Array<Record<string, unknown>> = [];
    // Show identity -> its seasons -> episode -> watch time.
    const shows = new Map<
      string,
      { ids: ScrobbleIds; seasons: Map<number, Map<number, string | undefined>> }
    >();

    for (const e of events) {
      // Same id selection as the scrobble path: /sync/watched matches on either.
      const ids = this.scrobbleIds(e.ref);
      if (!ids) {
        result.notFound++;
        continue;
      }
      const at = e.watchedAt ?? undefined;
      if (e.ref.kind === 'movie') {
        movies.push({ ids, watched_at: at });
      } else if (e.ref.kind === 'show') {
        // A whole-series marker would mark every aired episode watched. The
        // scrobble path never did that and the sources that emit these are not
        // the ones this fixes, so it stays a miss rather than a bulk write.
        result.notFound++;
      } else if (e.ref.season !== undefined && e.ref.number !== undefined) {
        const key = idKey(ids);
        const show = shows.get(key) ?? { ids, seasons: new Map<number, Map<number, string | undefined>>() };
        const eps = show.seasons.get(e.ref.season) ?? new Map<number, string | undefined>();
        const seen = eps.get(e.ref.number);
        eps.set(e.ref.number, seen && at ? (seen < at ? seen : at) : (seen ?? at));
        show.seasons.set(e.ref.season, eps);
        shows.set(key, show);
      } else {
        result.notFound++;
      }
    }

    const showEntries = [
      ...[...shows.values()].map((show) => ({
        ids: show.ids,
        seasons: [...show.seasons.entries()].map(([number, eps]) => ({
          number,
          episodes: [...eps.entries()].map(([n, at]) => ({ number: n, watched_at: at })),
        })),
      })),
    ];

    for (const batch of batches(movies, showEntries)) {
      await this.sendWatched(batch, result);
    }
    return result;
  }

  /**
   * One `/sync/watched` write. Counts come from the response rather than from
   * what was sent: the endpoint reports `not_found` per kind, and drops excess
   * episodes into `errors` while still answering 200.
   */
  private async sendWatched(
    body: { movies: Array<Record<string, unknown>>; shows: Array<Record<string, unknown>> },
    result: PushResult,
  ): Promise<void> {
    try {
      const res = await this.http.post<WatchedWriteResponse>('/sync/watched', body);
      const updated = res?.updated;
      result.added +=
        (updated?.movies ?? 0) + (updated?.shows ?? 0) + (updated?.seasons ?? 0) + (updated?.episodes ?? 0);
      const missing = Object.values(res?.not_found ?? {}).reduce(
        (n, list) => n + (Array.isArray(list) ? list.length : 0),
        0,
      );
      result.notFound += missing;
      const errors = res?.errors ?? [];
      if (errors.length) {
        result.note ??= `mdblist reported ${errors.length} write error(s): ${String(errors[0]).slice(0, 120)}`;
      }
    } catch (err) {
      // A 404 is MDBList saying it does not know these titles, which is a miss
      // rather than a fault — the same distinction the scrobble path drew.
      if (err instanceof HttpError && err.status === 404) {
        result.notFound += body.movies.length + body.shows.length;
        return;
      }
      result.failed += body.movies.length + body.shows.length;
      result.note ??= describeProviderError('mdblist', err);
    }
  }

  /**
   * Take items out of watched history. Clears `last_watched_at` while leaving
   * ratings and other state alone.
   */
  async removeHistory(events: WatchEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    const movies: Array<Record<string, unknown>> = [];
    const shows = new Map<string, { ids: ScrobbleIds; seasons: Map<number, Set<number>> }>();

    for (const e of events) {
      const ids = this.scrobbleIds(e.ref);
      if (!ids) {
        result.notFound++;
        continue;
      }
      if (e.ref.kind === 'movie') {
        movies.push({ ids });
      } else if (e.ref.kind === 'episode' && e.ref.season !== undefined && e.ref.number !== undefined) {
        const key = idKey(ids);
        const show = shows.get(key) ?? { ids, seasons: new Map<number, Set<number>>() };
        const eps = show.seasons.get(e.ref.season) ?? new Set<number>();
        eps.add(e.ref.number);
        show.seasons.set(e.ref.season, eps);
        shows.set(key, show);
      } else {
        result.notFound++;
      }
    }

    const showEntries = [...shows.values()].map((show) => ({
      ids: show.ids,
      seasons: [...show.seasons.entries()].map(([number, eps]) => ({
        number,
        episodes: [...eps].map((n) => ({ number: n })),
      })),
    }));
    if (movies.length === 0 && showEntries.length === 0) return result;

    try {
      await this.http.post('/sync/watched/remove', { movies, shows: showEntries });
      result.added = movies.length + [...shows.values()].reduce(
        (a, s) => a + [...s.seasons.values()].reduce((b, eps) => b + eps.size, 0),
        0,
      );
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        result.notFound += movies.length + showEntries.length;
        return result;
      }
      result.failed = events.length;
      result.note = describeProviderError('mdblist', err);
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
      else {
        result.failed++;
        result.note ??= ok.failed;
      }
    }
    return result;
  }

  // ── helpers ──────────────────────────────────────────────────────

  /** Trakt-shaped scrobble. A 404 means MDBList doesn't know the title. */
  private async scrobble(
    action: 'start' | 'pause' | 'stop',
    ref: MediaRef,
    progress: number,
  ): Promise<'ok' | 'not_found' | ScrobbleFailure> {
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
      // 404 means MDBList does not know the title, which is a miss rather than a
      // fault; anything else keeps its reason so the run can explain itself.
      if (err instanceof HttpError && err.status === 404) return 'not_found';
      return { failed: describeProviderError('mdblist', err) };
    }
  }

  /** The ids MDBList accepts on a scrobble; null when we have nothing to match on. */
  private scrobbleIds(ref: MediaRef): ScrobbleIds | null {
    const ids: ScrobbleIds = {};
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
