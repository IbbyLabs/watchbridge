/** Provider-agnostic domain types shared by the clients and the sync engine. */

export type ProviderId = 'trakt' | 'simkl' | 'pmdb';

export type DataType = 'history' | 'progress' | 'ratings' | 'watchlist';

/** External identifiers. For an episode, these are the parent SHOW's ids. */
export interface ExternalIds {
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
  trakt?: number;
  slug?: string;
  simkl?: number;
  mal?: number;
  anilist?: number;
  anidb?: number;
}

/** A reference to a watchable item: a movie, or a specific episode of a show. */
export interface MediaRef {
  /** `show` means the entire series is watched (used when a provider reports a
   *  show as fully completed without enumerating its episodes, e.g. Simkl). */
  kind: 'movie' | 'episode' | 'show';
  /** Movie ids, or (for an episode/show) the show's ids. */
  ids: ExternalIds;
  /** Episode only. */
  season?: number;
  /** Episode only. */
  number?: number;
  title?: string;
  year?: number;
}

/** One watch (a "play"). `watchedAt` null means the source has no known date. */
export interface WatchEvent {
  ref: MediaRef;
  watchedAt: string | null; // ISO 8601 or null (unknown)
}

/** A resume/playback position. */
export interface ProgressEvent {
  ref: MediaRef;
  /** 0–100. */
  progress: number;
  pausedAt?: string | null;
  positionMs?: number;
  runtimeMs?: number;
}

export interface ProviderCapabilities {
  history: boolean;
  progress: boolean;
  ratings: boolean;
  watchlist: boolean;
  /** Whether the provider can store a per-play `watchedAt` date on write. */
  datedHistory: boolean;
}

/** Result of a write to a provider. */
export interface PushResult {
  added: number;
  skipped: number;
  failed: number;
  notFound: number;
}

export const emptyPushResult = (): PushResult => ({ added: 0, skipped: 0, failed: 0, notFound: 0 });
