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

const PMDB_BASE = 'https://publicmetadb.com';

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

/** Maps our external-id keys to PMDB `mappings/lookup` id_type values. */
const LOOKUP_ORDER: Array<[keyof ExternalIds, string]> = [
  ['imdb', 'imdb'],
  ['tvdb', 'tvdb'],
  ['trakt', 'trakt'],
  ['anilist', 'anilist'],
  ['mal', 'mal'],
  ['anidb', 'anidb'],
];

export class PmdbClient {
  readonly id = 'pmdb' as const;
  private readonly http: HttpClient;

  constructor(apiKey: string) {
    this.http = new HttpClient({
      baseUrl: PMDB_BASE,
      // PMDB limit: 300 requests / 10s. Pace conservatively.
      minIntervalMs: 40,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'user-agent': 'Watchbridge',
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
      } catch {
        result.failed++;
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
      try {
        // PMDB ignores anything under 2%, which is a no-op rather than a problem.
        await this.http.post('/api/external/resume', payload);
        result.added++;
      } catch {
        result.failed++;
      }
    }
    if (autoCompleting > 0) {
      result.note = `${autoCompleting} resume position${autoCompleting === 1 ? '' : 's'} past ${AUTO_COMPLETE_PERCENT}% were left alone, because PublicMetaDB would have recorded them as finished`;
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
      const items = Array.isArray(res) ? res : (res.items ?? []);
      out.push(...items);
      const totalPages = Array.isArray(res) ? 1 : (res.totalPages ?? 1);
      if (items.length === 0 || page >= totalPages) break;
      page++;
    }
    return out;
  }
}
