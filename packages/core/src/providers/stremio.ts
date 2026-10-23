import { inflateSync } from 'node:zlib';
import { createLogger } from '../logger.js';
import { HttpClient, HttpError } from './http.js';
import { sharedRateGate } from './rateGate.js';
import type { DeviceCode } from './trakt.js';
import type { ProgressEvent, ProviderCapabilities, WatchEvent } from './types.js';

const log = createLogger('stremio');

const API_BASE = 'https://api.strem.io/api';
const LINK_BASE = 'https://link.stremio.com/api/v2';
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';

const LIBRARY_COLLECTION = 'libraryItem';

/** Stremio publishes no link-code lifetime; this is how long the UI polls. */
const LINK_EXPIRES_IN = 300;
const LINK_POLL_INTERVAL = 3;

/** Upper bound on an inflated bitfield, so a hostile payload cannot balloon. */
const MAX_BITFIELD_BYTES = 1 << 20;

/** Stremio answers every call with either a result or an error, never both. */
interface ApiEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

interface LinkCode {
  code: string;
  link: string;
  qrcode: string;
}

interface LibraryItemState {
  timesWatched?: number;
  lastWatched?: string | null;
  /** `{anchorVideoId}:{anchorLength}:{base64 zlib bitfield}`; absent without per-video tracking. */
  watched?: string | null;
}

interface LibraryItem {
  _id: string;
  name?: string;
  type?: string;
  removed?: boolean;
  state?: LibraryItemState;
}

interface CinemetaVideo {
  id?: string;
  season?: number;
  episode?: number;
  number?: number;
  released?: string | null;
}

interface CinemetaResponse {
  meta?: { videos?: CinemetaVideo[] };
}

export class StremioLinkPending extends Error {
  constructor() {
    super('Waiting for you to approve the code in Stremio');
    this.name = 'StremioLinkPending';
  }
}

export class StremioSessionInvalid extends Error {
  constructor() {
    super('Your Stremio session is no longer valid. Reconnect to continue syncing');
    this.name = 'StremioSessionInvalid';
  }
}

export type BitfieldFailure = 'malformed' | 'undecodable' | 'anchor_not_found';

export class WatchedBitfieldError extends Error {
  constructor(readonly reason: BitfieldFailure) {
    super(`Could not read the watched bitfield: ${reason}`);
    this.name = 'WatchedBitfieldError';
  }
}

const toMs = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

const rank = (n: number | undefined): number =>
  typeof n === 'number' ? n : Number.MIN_SAFE_INTEGER;

/**
 * Video ids in the order stremio-core indexes the bitfield: season, then
 * episode, then release date, all ascending, videos missing a field first.
 */
export function orderVideos(videos: CinemetaVideo[]): CinemetaVideo[] {
  return [...videos].sort(
    (a, b) =>
      rank(a.season) - rank(b.season) ||
      rank(a.episode ?? a.number) - rank(b.episode ?? b.number) ||
      rank(toMs(a.released) ?? undefined) - rank(toMs(b.released) ?? undefined),
  );
}

/**
 * Decode stremio-core's WatchedBitField against the current ordered video ids.
 * Returns the set of watched video indexes.
 *
 * Bit i lives in byte i>>3 at bit i&7 (least significant first) of the
 * zlib-inflated buffer. The anchor is the last watched video: when the list has
 * grown or shifted, old bit j maps to new index j - offset, where
 * offset = anchorLength - 1 - indexOf(anchor). Old bits are read below
 * anchorLength, as stremio-watched-bitfield's JS does (the Rust port bounds by
 * the new list length, which drops the anchor itself when videos are removed).
 */
export function decodeWatchedField(serialized: string, videoIds: string[]): Set<number> {
  const parts = serialized.split(':');
  if (parts.length < 3) throw new WatchedBitfieldError('malformed');
  const packed = parts.pop() as string;
  const anchorLength = Number.parseInt(parts.pop() as string, 10);
  const anchorId = parts.join(':');
  if (!Number.isInteger(anchorLength) || anchorLength < 1)
    throw new WatchedBitfieldError('malformed');

  const anchorIdx = videoIds.indexOf(anchorId);
  if (anchorIdx === -1) throw new WatchedBitfieldError('anchor_not_found');

  let values: Buffer;
  try {
    values = inflateSync(Buffer.from(packed, 'base64'), { maxOutputLength: MAX_BITFIELD_BYTES });
  } catch {
    throw new WatchedBitfieldError('undecodable');
  }

  const bit = (j: number): boolean => (((values[j >> 3] ?? 0) >> (j & 7)) & 1) === 1;
  const offset = anchorLength - 1 - anchorIdx;
  const watched = new Set<number>();
  for (let i = 0; i < videoIds.length; i++) {
    const j = i + offset;
    if (j >= 0 && j < anchorLength && bit(j)) watched.add(i);
  }
  return watched;
}

/**
 * The user's Stremio library as a read-only history source.
 *
 * Pairing uses Stremio's own link flow: the user approves a short code and we
 * receive a session key. Email and password are never requested.
 */
export class StremioClient {
  readonly id = 'stremio' as const;
  private readonly http: HttpClient;
  private readonly cinemeta: HttpClient;

  constructor(
    private readonly authKey: string,
    app?: { appName?: string; appVersion?: string },
  ) {
    const headers = {
      'user-agent': `${app?.appName ?? 'Watchbridge'}/${app?.appVersion ?? '0.1.0'}`,
    };
    this.http = new HttpClient({
      baseUrl: API_BASE,
      minIntervalMs: 200,
      gate: sharedRateGate('stremio'),
      headers,
    });
    this.cinemeta = new HttpClient({
      baseUrl: CINEMETA_BASE,
      minIntervalMs: 250,
      gate: sharedRateGate('cinemeta'),
      maxRetries: 2,
      headers,
    });
  }

  capabilities(): ProviderCapabilities {
    return {
      history: true,
      progress: false,
      ratings: false,
      watchlist: false,
      datedHistory: false,
    };
  }

  /** Begin pairing: returns the code and the page the user approves it on. */
  static async startLink(): Promise<DeviceCode> {
    const http = new HttpClient({ baseUrl: LINK_BASE });
    const res = await http.get<ApiEnvelope<LinkCode>>('/create?type=Create');
    if (!res.result) throw new Error(res.error?.message ?? 'Stremio would not issue a link code');
    return {
      deviceCode: res.result.code,
      userCode: res.result.code,
      verificationUrl: res.result.link,
      expiresIn: LINK_EXPIRES_IN,
      interval: LINK_POLL_INTERVAL,
    };
  }

  /** Exchange an approved code for a session key; throws `StremioLinkPending` until approved. */
  static async completeLink(code: string): Promise<string> {
    const http = new HttpClient({ baseUrl: LINK_BASE });
    const res = await http.get<ApiEnvelope<{ authKey: string }>>(
      `/read?type=Read&code=${encodeURIComponent(code)}`,
    );
    if (res.result?.authKey) return res.result.authKey;
    // An unapproved code and an expired one answer identically.
    throw new StremioLinkPending();
  }

  /** Whether the session key still works. */
  async validate(): Promise<boolean> {
    try {
      await this.library();
      return true;
    } catch (err) {
      if (err instanceof StremioSessionInvalid) return false;
      throw err;
    }
  }

  private async library(): Promise<LibraryItem[]> {
    const res = await this.http.post<ApiEnvelope<LibraryItem[]>>('/datastoreGet', {
      authKey: this.authKey,
      collection: LIBRARY_COLLECTION,
      all: true,
      ids: [],
    });
    if (res.error) {
      if (res.error.code === 1 || /session|auth/i.test(res.error.message ?? '')) {
        throw new StremioSessionInvalid();
      }
      throw new Error(
        `Stremio refused the library request: ${res.error.message ?? 'unknown error'}`,
      );
    }
    return res.result ?? [];
  }

  async pullProgress(): Promise<ProgressEvent[]> {
    return [];
  }

  async pullHistory(_since?: string | null): Promise<WatchEvent[]> {
    const items = await this.library();
    const metas = new Map<string, Promise<CinemetaVideo[] | null>>();
    const out: WatchEvent[] = [];
    const tally = {
      library: items.length,
      removed: 0,
      other: 0,
      nonImdb: 0,
      movies: 0,
      moviesUndated: 0,
      series: 0,
      seriesSkipped: 0,
      episodes: 0,
      episodesUndated: 0,
    };

    for (const item of items) {
      // Played without being saved is stored as removed, so removal is no sign of unwatching.
      if (item.removed) tally.removed++;
      if (item.type !== 'movie' && item.type !== 'series') {
        tally.other++;
        continue;
      }
      if (!/^tt\d+$/.test(item._id)) {
        tally.nonImdb++;
        continue;
      }
      const lastWatched = toMs(item.state?.lastWatched);

      if (item.type === 'movie') {
        if ((item.state?.timesWatched ?? 0) <= 0) continue;
        if (lastWatched === null) {
          tally.moviesUndated++;
          log.debug({ imdb: item._id }, 'Skipped a watched movie with no watch date');
          continue;
        }
        tally.movies++;
        out.push({
          ref: { kind: 'movie', ids: { imdb: item._id }, title: item.name },
          watchedAt: new Date(lastWatched).toISOString(),
        });
        continue;
      }

      const serialized = item.state?.watched;
      if (!serialized) {
        // Never played is normal for a saved series; played without episode data is not.
        if ((item.state?.timesWatched ?? 0) > 0 || lastWatched !== null) {
          tally.seriesSkipped++;
          log.warn(
            { imdb: item._id, reason: 'no_watched_field' },
            'Skipped a series without per-episode watch data',
          );
        }
        continue;
      }

      const videos = await this.videosFor(metas, item._id);
      if (!videos) {
        tally.seriesSkipped++;
        continue;
      }
      const ordered = orderVideos(videos);
      let watched: Set<number>;
      try {
        watched = decodeWatchedField(
          serialized,
          ordered.map((v) => v.id ?? ''),
        );
      } catch (err) {
        if (!(err instanceof WatchedBitfieldError)) throw err;
        tally.seriesSkipped++;
        log.warn(
          { imdb: item._id, reason: err.reason },
          'Skipped a series whose watched episodes could not be read',
        );
        continue;
      }

      tally.series++;
      for (const idx of [...watched].sort((a, b) => a - b)) {
        const video = ordered[idx]!;
        const number = video.episode ?? video.number;
        if (!Number.isInteger(video.season) || !Number.isInteger(number)) continue;
        const at = episodeDate(toMs(video.released), lastWatched);
        if (at === null) {
          tally.episodesUndated++;
          log.debug(
            { imdb: item._id, videoId: video.id },
            'Skipped a watched episode with no usable date',
          );
          continue;
        }
        tally.episodes++;
        out.push({
          ref: {
            kind: 'episode',
            ids: { imdb: item._id },
            season: video.season,
            number,
            title: item.name,
          },
          watchedAt: new Date(at).toISOString(),
        });
      }
    }

    log.info(tally, 'Stremio library read');
    return out;
  }

  /** Cinemeta's video list for a series, cached for the pull. Null when it could not be had. */
  private videosFor(
    cache: Map<string, Promise<CinemetaVideo[] | null>>,
    imdb: string,
  ): Promise<CinemetaVideo[] | null> {
    let pending = cache.get(imdb);
    if (!pending) {
      pending = this.cinemeta
        .get<CinemetaResponse>(`/meta/series/${imdb}.json`)
        .then((res) => {
          const videos = res?.meta?.videos;
          if (!Array.isArray(videos) || videos.length === 0) {
            log.warn(
              { imdb, reason: 'no_videos' },
              'Skipped a series Cinemeta has no episodes for',
            );
            return null;
          }
          return videos;
        })
        .catch((err: unknown) => {
          log.warn(
            { imdb, status: err instanceof HttpError ? err.status : undefined, err },
            'Skipped a series because Cinemeta could not be read',
          );
          return null;
        });
      cache.set(imdb, pending);
    }
    return pending;
  }
}

/** Release date clamped to the last time the series was watched; either may be missing. */
function episodeDate(released: number | null, lastWatched: number | null): number | null {
  if (released === null) return lastWatched;
  return lastWatched !== null && released > lastWatched ? lastWatched : released;
}
