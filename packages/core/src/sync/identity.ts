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
  return ref.kind === 'episode' ? `:s${ref.season ?? '?'}:e${ref.number ?? '?'}` : '';
}

/** Every candidate id-string for a ref (kind-prefixed; episodes carry S/E). */
export function idStrings(ref: MediaRef): string[] {
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

/** True if the ref carries at least one usable external id. */
export function hasIdentity(ref: MediaRef): boolean {
  return idStrings(ref).length > 0;
}

/** One stable primary key for de-duplication (highest-priority id + S/E). */
export function itemKey(ref: MediaRef): string | null {
  const [first] = idStrings(ref);
  return first ?? null;
}

/** An index of items by all their id-strings, for O(1) overlap lookups. */
export class MatchIndex {
  private readonly ids = new Set<string>();

  add(ref: MediaRef): void {
    for (const s of idStrings(ref)) this.ids.add(s);
  }

  /** True if any of the ref's id-strings is already indexed. */
  has(ref: MediaRef): boolean {
    return idStrings(ref).some((s) => this.ids.has(s));
  }

  static from(refs: MediaRef[]): MatchIndex {
    const idx = new MatchIndex();
    for (const r of refs) idx.add(r);
    return idx;
  }
}
