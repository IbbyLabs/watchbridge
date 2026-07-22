import type { ExternalIds, MediaRef } from '../providers/types.js';

/**
 * ID-based identity matching (never by title). Two refs match if they share any
 * external ID of the same type, plus season and episode for episodes. `idStrings`
 * lists all candidate keys for cross-provider matching; `itemKey` is the primary.
 */

// Highest-priority first. tmdb leads because PMDB is TMDB-keyed.
const ID_PRIORITY: Array<keyof ExternalIds> = [
  'tmdb',
  'imdb',
  'trakt',
  'tvdb',
  'simkl',
  'anilist',
  'mal',
  'anidb',
  'slug',
];

function episodeSuffix(ref: MediaRef): string {
  return ref.kind === 'episode' ? `:s${ref.season}:e${ref.number}` : '';
}

/**
 * An episode is only identifiable with both a season and an episode number.
 * Season 0 and episode 0 are real values, so this tests for absence, not falsity.
 */
function episodeIsPlaceable(ref: MediaRef): boolean {
  return ref.kind !== 'episode' || (ref.season !== undefined && ref.number !== undefined);
}

/** Every candidate id-string for a ref (kind-prefixed; episodes carry S/E). */
export function idStrings(ref: MediaRef): string[] {
  // Without a season and number, every episode of a show would share one key and
  // be mistaken for every other. Park it as unidentifiable instead of guessing.
  if (!episodeIsPlaceable(ref)) return [];

  const suffix = episodeSuffix(ref);
  const out: string[] = [];
  for (const key of ID_PRIORITY) {
    const value = ref.ids[key];
    if (value !== undefined && value !== null && value !== '') {
      out.push(`${ref.kind}:${key}:${value}${suffix}`);
    }
  }
  return out;
}

/**
 * Show-level keys (`show:<type>:<id>`, no S/E) for an episode's parent show or a
 * show ref itself. Used to reconcile providers that report a whole series as
 * watched (a `show` ref) against providers that enumerate its episodes.
 */
function showKeys(ref: MediaRef): string[] {
  const out: string[] = [];
  for (const key of ID_PRIORITY) {
    const value = ref.ids[key];
    if (value !== undefined && value !== null && value !== '') {
      out.push(`show:${key}:${value}`);
    }
  }
  return out;
}

/** True if the ref carries at least one usable external id. */
export function hasIdentity(ref: MediaRef): boolean {
  return idStrings(ref).length > 0;
}

/** One stable primary key for de-duplication (highest-priority id + S/E). */
export function itemKey(ref: MediaRef): string | null {
  const [first] = idStrings(ref);
  return first ?? null;
}

/**
 * An index of items by all their id-strings, for O(1) overlap lookups.
 *
 * Handles the show/episode split across providers: a `show` ref (whole series
 * watched) matches any of that show's episodes, and vice-versa, so a series that
 * one provider records as "completed" (no episodes listed) and another records
 * as individual episodes reconcile as already-present instead of re-adding.
 */
export class MatchIndex {
  private readonly ids = new Set<string>();
  /** Show keys for series marked fully watched (from `show` refs). */
  private readonly completedShows = new Set<string>();
  /** Show keys for series that have at least one enumerated episode. */
  private readonly episodeShows = new Set<string>();

  add(ref: MediaRef): void {
    for (const s of idStrings(ref)) this.ids.add(s);
    if (ref.kind === 'show') {
      for (const s of showKeys(ref)) this.completedShows.add(s);
    } else if (ref.kind === 'episode') {
      for (const s of showKeys(ref)) this.episodeShows.add(s);
    }
  }

  /** True if the ref (or, for episodes/shows, its series) is already present. */
  has(ref: MediaRef): boolean {
    if (idStrings(ref).some((s) => this.ids.has(s))) return true;
    if (ref.kind === 'episode') {
      // The whole parent series is marked watched on the target.
      return showKeys(ref).some((s) => this.completedShows.has(s));
    }
    if (ref.kind === 'show') {
      // The target already has this series' episodes (or the whole show).
      return showKeys(ref).some((s) => this.episodeShows.has(s) || this.completedShows.has(s));
    }
    return false;
  }

  static from(refs: MediaRef[]): MatchIndex {
    const idx = new MatchIndex();
    for (const r of refs) idx.add(r);
    return idx;
  }
}
