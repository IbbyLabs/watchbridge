import type { ExternalIds, MediaRef } from '../providers/types.js';
import { sharesAnyId } from './identity.js';

/**
 * Per-sync scope controls. All fields are optional; an absent field means "do
 * not filter on this dimension", so a sync with no filters syncs everything and
 * existing syncs are unaffected.
 */
export interface SyncFilters {
  /** Sync movies. Default true. */
  movies?: boolean;
  /** Sync episodes and whole-show markers. Default true. */
  shows?: boolean;
  /** Skip season-0 specials. Default false (specials are synced). */
  excludeSpecials?: boolean;
  /** Titles to skip, matched when the item shares any id with an entry. */
  exclude?: ExternalIds[];
}

/** Whether an item passes the sync's filters and should be considered for syncing. */
export function includedByFilters(ref: MediaRef, filters?: SyncFilters): boolean {
  if (!filters) return true;

  if (ref.kind === 'movie' && filters.movies === false) return false;
  if ((ref.kind === 'episode' || ref.kind === 'show') && filters.shows === false) return false;
  if (ref.kind === 'episode' && ref.season === 0 && filters.excludeSpecials) return false;
  if (filters.exclude?.some((ids) => sharesAnyId(ref.ids, ids))) return false;

  return true;
}
