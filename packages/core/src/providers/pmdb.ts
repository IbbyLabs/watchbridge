import { describeProviderError } from './errors.js';
import { HttpClient, HttpError } from './http.js';
import { sharedRateGate } from './rateGate.js';
import {
  emptyPushResult,
  type ExternalIds,
  type MediaRef,
  type ProgressEvent,
  type ProviderCapabilities,
  type PushResult,
  type WatchEvent,
  type WatchlistEvent,
} from './types.js';

const PMDB_BASE = 'https://publicmetadb.com';

/** Backstop on paging, so a misbehaving endpoint cannot spin indefinitely. */
const MAX_PAGES = 200;

/** PublicMetaDB accepts up to 50 resume points per batch call. */
const RESUME_BATCH_MAX = 50;

/** At or above this, PublicMetaDB marks the item finished and drops the resume row. */
const AUTO_COMPLETE_PERCENT = 80;

interface PmdbWatched {
  id: string;
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  season?: number | null;
  episode?: number | null;
  watched_at?: string | null;
}

interface PmdbResume {
  id: string;
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  season?: number | null;
  episode?: number | null;
  position_ms: number;
  runtime_ms: number;
  paused_at?: string | null;
}

interface Paginated<T> {
  items?: T[];
  total?: number;
  totalPages?: number;
}

/** A list's metadata (the `type: 'watchlist'` list is the user's watchlist). */
interface PmdbList {
  id: string;
  name?: string;
  type?: string;
}

/** One item on a list — a whole movie or show, keyed by TMDB id. */
interface PmdbListItem {
  id: string;
  tmdb_id: number;
  media_type: 'movie' | 'tv';
}/** Maps our external-id keys to PMDB `mappings/lookup` id_type values. */
const LOOKUP_ORDER: Array<[keyof ExternalIds, string]> = [
  ['imdb', 'imdb'],
  ['tvdb', 'tvdb'],
  ['trakt', 'trakt'],
  ['anilist', 'anilist'],
  ['mal', 'mal'],
  ['anidb', 'anidb'],
];

/**
 * PublicMetaDB (publicmetadb.com) provider.
 *
 * Auth: `Authorization: Bearer pm-...` on every request. Limits are enforced
 * **per IP** (300 requests / 10s) plus per-hour contribution caps (e.g. resume
 * saves 300/hour, batch 30/hour, ratings 200/hour) — hence the shared rate gate.
 *
 * History writes go through `POST /api/external/watched` with `?dedupe=true` so
 * a re-run reuses a matching play instead of logging a duplicate. `watched_at:
 * null` means "date unknown" (omitting it would default to now).
 *
 * Ratings are deliberately NOT implemented (`ratings: false`): PMDB's ratings API
 * is per-title (`GET /api/external/ratings` needs a `tmdb_id`) with no "list all
 * my ratings", so the engine's pull-and-diff ratings model cannot work here, and
 * the scale is 0–100 with a text label rather than a 1–10 score.
 *
 * A watchlist is a List with `type: 'watchlist'` (there is no dedicated
 * endpoint); we find it on read and create it only on a write, so a preview
 * never creates anything.
 */
export class PmdbClient {
  readonly id = 'pmdb' as const;
  private readonly http: HttpClient;

  constructor(apiKey: string, app?: { appName?: string; appVersion?: string }) {
    this.http = new HttpClient({
      baseUrl: PMDB_BASE,
      // PMDB limit: 300 requests / 10s, enforced **per IP** — so every connection
      // this process holds shares one budget. Pace globally, not per client.
      minIntervalMs: 40,
      gate: sharedRateGate('pmdb'),
      headers: {
        authorization: `Bearer ${apiKey}`,
        'user-agent': `${app?.appName ?? 'Watchbridge'}/${app?.appVersion ?? '0.1.0'}`,
      },
    });
  }

  capabilities(): ProviderCapabilities {
    // ratings not implemented for PMDB yet; do not advertise it.
    return { history: true, progress: true, ratings: false, watchlist: true, datedHistory: true };
  }

  /** Validate the API key. Returns true if accepted, false on 401. */
  async validate(): Promise<boolean> {
    try {
      await this.http.get('/api/external/watched?page=1&perPage=1');
      return true;
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) return false;
      throw err;
    }
  }

  // ── History ──────────────────────────────────────────────────────

  async pullHistory(_since?: string | null): Promise<WatchEvent[]> {
    const rows = await this.paginate<PmdbWatched>('/api/external/watched');
    return rows.map((r) => ({
      ref: this.toRef(r),
      watchedAt: r.watched_at ?? null,
    }));
  }

  async pushHistory(events: WatchEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    for (const event of events) {
      // PMDB history is per movie/episode; a whole-show marker can't be expressed.
      if (event.ref.kind === 'show') {
        result.notFound++;
        continue;
      }
      const tmdb = await this.resolveTmdb(event.ref);
      if (!tmdb) {
        result.notFound++;
        continue;
      }
      const payload: Record<string, unknown> = {
        tmdb_id: tmdb,
        media_type: event.ref.kind === 'movie' ? 'movie' : 'tv',
        // Explicit ISO or null; omitting would default to now.
        watched_at: event.watchedAt,
      };
      if (event.ref.kind === 'episode') {
        payload.season = event.ref.season;
        payload.episode = event.ref.number;
      }
      try {
        // ?dedupe=true reuses a matching play instead of inserting a duplicate.
        await this.http.post('/api/external/watched?dedupe=true', payload);
        result.added++;
      } catch (err) {
        result.failed++;
        // Keep the first reason: a bare count gives the user nothing to act on.
        result.note ??= describeProviderError('pmdb', err);
      }
    }
    return result;
  }

  /**
   * Remove plays from watch history. PMDB's bulk delete takes its scope in query
   * params: `tmdb_id` + `media_type` wipes every play of a title, and adding
   * `season`/`episode` narrows it to one episode. A whole-series ref therefore
   * deletes the show's entire history.
   */
  async removeHistory(events: WatchEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    for (const event of events) {
      const tmdb = await this.resolveTmdb(event.ref);
      if (!tmdb) {
        result.notFound++;
        continue;
      }
      const params = new URLSearchParams({
        tmdb_id: String(tmdb),
        media_type: event.ref.kind === 'movie' ? 'movie' : 'tv',
      });
      if (event.ref.kind === 'episode' && event.ref.season !== undefined && event.ref.number !== undefined) {
        params.set('season', String(event.ref.season));
        params.set('episode', String(event.ref.number));
      }
      try {
        await this.http.delete(`/api/external/watched?${params.toString()}`);
        result.added++;
      } catch (err) {
        result.failed++;
        result.note ??= describeProviderError('pmdb', err);
      }
    }
    return result;
  }

  /**
   * Correct a play's date in place (`PATCH /api/external/watched/:id`) instead of
   * removing and re-adding it. Only done when exactly ONE matching play exists —
   * with several (rewatches) there is no way to know which one we wrote, so it
   * reports false and the caller falls back to remove-and-add.
   */
  async updateWatchDate(ref: MediaRef, watchedAt: string): Promise<boolean> {
    const tmdb = await this.resolveTmdb(ref);
    if (!tmdb) return false;
    const played = (await this.paginate<PmdbWatched>('/api/external/watched')).filter(
      (r) =>
        r.tmdb_id === tmdb &&
        r.media_type === (ref.kind === 'movie' ? 'movie' : 'tv') &&
        (ref.kind !== 'episode' || (r.season === ref.season && r.episode === ref.number)),
    );
    if (played.length !== 1 || !played[0]!.id) return false;
    try {
      await this.http.patch(`/api/external/watched/${played[0]!.id}`, { watched_at: watchedAt });
      return true;
    } catch (err) {
      // 404 = the play is gone; either way there is nothing to correct here.
      if (err instanceof HttpError && err.status === 404) return false;
      throw err;
    }
  }

  // ── Watchlist ────────────────────────────────────────────────────
  //
  // PMDB has no dedicated watchlist endpoint: a watchlist is a List with
  // `type: 'watchlist'`. We find it, and create it only on a write (never on a
  // pull, so a preview never creates anything).

  private readonly watchlistCache = { id: undefined as string | undefined };

  /** The user's watchlist list id, or null if they have none yet. */
  private async findWatchlist(): Promise<string | null> {
    if (this.watchlistCache.id) return this.watchlistCache.id;
    const lists = await this.paginate<PmdbList>('/api/external/lists');
    const existing = lists.find((l) => l.type === 'watchlist');
    if (existing) this.watchlistCache.id = existing.id;
    return this.watchlistCache.id ?? null;
  }

  /** Like findWatchlist, but creates the list when the user has none. */
  private async ensureWatchlist(): Promise<string | null> {
    const found = await this.findWatchlist();
    if (found) return found;
    const created = await this.http.post<{ item?: { id?: string } }>('/api/external/lists', {
      name: 'Watchlist',
      is_public: false,
      type: 'watchlist',
    });
    const id = created?.item?.id;
    if (id) this.watchlistCache.id = id;
    return id ?? null;
  }

  async pullWatchlist(_since?: string | null): Promise<WatchlistEvent[]> {
    // No activities endpoint, so no cheap gate: a full (paginated) read.
    const listId = await this.findWatchlist();
    if (!listId) return []; // no watchlist yet — nothing to mirror
    const rows = await this.paginate<PmdbListItem>(`/api/external/lists/${listId}/items`);
    return rows
      .filter((r) => r.tmdb_id)
      .map<WatchlistEvent>((r) => ({
        ref:
          r.media_type === 'movie'
            ? { kind: 'movie', ids: { tmdb: r.tmdb_id } }
            : { kind: 'show', ids: { tmdb: r.tmdb_id } },
      }));
  }

  async pushWatchlist(events: WatchlistEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    if (events.length === 0) return result;
    const listId = await this.ensureWatchlist();
    if (!listId) {
      result.failed = events.length;
      result.note = 'PublicMetaDB did not return a watchlist to add to.';
      return result;
    }
    for (const e of events) {
      if (e.ref.kind !== 'movie' && e.ref.kind !== 'show') {
        result.notFound++;
        continue;
      }
      const tmdb = await this.resolveTmdb(e.ref);
      if (!tmdb) {
        result.notFound++;
        continue;
      }
      try {
        await this.http.post(`/api/external/lists/${listId}/items`, {
          tmdb_id: tmdb,
          media_type: e.ref.kind === 'movie' ? 'movie' : 'tv',
        });
        result.added++;
      } catch (err) {
        result.failed++;
        result.note ??= describeProviderError('pmdb', err);
      }
    }
    return result;
  }

  async removeWatchlist(events: WatchlistEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    if (events.length === 0) return result;
    const listId = await this.ensureWatchlist();
    if (!listId) {
      result.failed = events.length;
      result.note = 'PublicMetaDB did not return a watchlist to remove from.';
      return result;
    }
    // Removal is by list-item id, so read the list once and match by media id.
    const items = await this.paginate<PmdbListItem>(`/api/external/lists/${listId}/items`);
    const itemIdFor = new Map(items.map((it) => [`${it.media_type}:${it.tmdb_id}`, it.id]));
    for (const e of events) {
      if (e.ref.kind !== 'movie' && e.ref.kind !== 'show') {
        result.notFound++;
        continue;
      }
      const tmdb = await this.resolveTmdb(e.ref);
      if (!tmdb) {
        result.notFound++;
        continue;
      }
      const itemId = itemIdFor.get(`${e.ref.kind === 'movie' ? 'movie' : 'tv'}:${tmdb}`);
      if (!itemId) {
        result.notFound++; // not on the watchlist — nothing to remove
        continue;
      }
      try {
        await this.http.delete(`/api/external/lists/${listId}/items/${itemId}`);
        result.added++;
      } catch (err) {
        result.failed++;
        result.note ??= describeProviderError('pmdb', err);
      }
    }
    return result;
  }

  // ── Progress ─────────────────────────────────────────────────────

  async pullProgress(): Promise<ProgressEvent[]> {
    const rows = await this.paginate<PmdbResume>('/api/external/resume');
    return rows.map((r) => ({
      ref: this.toRef(r),
      progress: r.runtime_ms > 0 ? Math.min(100, (r.position_ms / r.runtime_ms) * 100) : 0,
      pausedAt: r.paused_at ?? null,
      positionMs: r.position_ms,
      runtimeMs: r.runtime_ms,
    }));
  }

  async pushProgress(events: ProgressEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    let autoCompleting = 0;
    const payloads: Array<Record<string, unknown>> = [];
    for (const event of events) {
      const tmdb = await this.resolveTmdb(event.ref);
      if (!tmdb || event.positionMs === undefined || event.runtimeMs === undefined) {
        result.notFound++;
        continue;
      }
      // PMDB turns a resume position at or above AUTO_COMPLETE_PERCENT into a
      // finished play. A source that reports someone is 85% through a film has
      // not said they finished it, so sending this would invent a watch. If they
      // did finish it, the history sync carries it across with a real date.
      if (event.progress >= AUTO_COMPLETE_PERCENT) {
        result.skipped++;
        autoCompleting++;
        continue;
      }
      const payload: Record<string, unknown> = {
        tmdb_id: tmdb,
        media_type: event.ref.kind === 'movie' ? 'movie' : 'tv',
        position_ms: event.positionMs,
        runtime_ms: event.runtimeMs,
      };
      if (event.ref.kind === 'episode') {
        payload.season = event.ref.season;
        payload.episode = event.ref.number;
      }
      payloads.push(payload);
    }

    // Batch up to 50 per call: fewer requests against the per-IP limit, and the
    // batch endpoint's hourly allowance is much larger than the single-item one.
    // PMDB applies the same smart rules (<2% ignored, ≥80% auto-completes) per item.
    for (let i = 0; i < payloads.length; i += RESUME_BATCH_MAX) {
      const chunk = payloads.slice(i, i + RESUME_BATCH_MAX);
      try {
        await this.http.post('/api/external/resume/batch', { items: chunk });
        result.added += chunk.length;
      } catch (err) {
        result.failed += chunk.length;
        result.note ??= describeProviderError('pmdb', err);
      }
    }
    if (autoCompleting > 0) {
      const skipped = `${autoCompleting} resume position${autoCompleting === 1 ? '' : 's'} past ${AUTO_COMPLETE_PERCENT}% were left alone, because PublicMetaDB would have recorded them as finished`;
      // Keep a failure reason alongside it rather than replacing it.
      result.note = result.note ? `${skipped}. ${result.note}` : skipped;
    }
    return result;
  }

  // ── ID resolution ────────────────────────────────────────────────

  /** Resolve a ref to a TMDB id, using PMDB's community mappings if needed. */
  async resolveTmdb(ref: MediaRef): Promise<number | null> {
    if (ref.ids.tmdb) return ref.ids.tmdb;
    const mediaType = ref.kind === 'movie' ? 'movie' : 'tv';
    for (const [key, idType] of LOOKUP_ORDER) {
      const value = ref.ids[key];
      if (value === undefined) continue;
      const tmdb = await this.lookupTmdb(idType, String(value), mediaType);
      if (tmdb) return tmdb;
    }
    return null;
  }

  async lookupTmdb(idType: string, idValue: string, mediaType: 'movie' | 'tv'): Promise<number | null> {
    try {
      const res = await this.http.get<{ results?: Array<{ tmdb_id?: number; votes?: number }> }>(
        `/api/external/mappings/lookup?id_type=${idType}&id_value=${encodeURIComponent(idValue)}&media_type=${mediaType}`,
      );
      const results = res.results ?? [];
      if (results.length === 0) return null;
      // Prefer the community-upvoted mapping to avoid a wrong franchise-root entry.
      const best = results.reduce((a, b) => ((b.votes ?? 0) > (a.votes ?? 0) ? b : a));
      return best.tmdb_id ?? null;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 401)) return null;
      throw err;
    }
  }

  // ── helpers ──────────────────────────────────────────────────────

  private toRef(r: { tmdb_id: number; media_type: 'movie' | 'tv'; season?: number | null; episode?: number | null }): MediaRef {
    if (r.media_type === 'movie') {
      return { kind: 'movie', ids: { tmdb: r.tmdb_id } };
    }
    return {
      kind: 'episode',
      ids: { tmdb: r.tmdb_id },
      season: r.season ?? undefined,
      number: r.episode ?? undefined,
    };
  }

  private async paginate<T>(path: string, perPage = 100): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    for (;;) {
      const res = await this.http.get<Paginated<T> | T[]>(`${path}?page=${page}&perPage=${perPage}`);
      // A bare array is the whole set — nothing to page.
      if (Array.isArray(res)) {
        out.push(...res);
        break;
      }
      const items = res.items ?? [];
      out.push(...items);
      // The docs describe `{ items, total }` and never mention `totalPages`, so
      // stop on the counts rather than a field that may be absent (which would
      // silently truncate a library at one page).
      if (items.length === 0) break;
      if (typeof res.total === 'number' && out.length >= res.total) break;
      if (items.length < perPage) break;
      if (++page > MAX_PAGES) break;
    }
    return out;
  }
}
