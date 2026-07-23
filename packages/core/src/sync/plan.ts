import type { MediaRef, ProgressEvent, RatingEvent, WatchEvent } from '../providers/types.js';
import { MatchIndex, hasIdentity, itemKey } from './identity.js';

/**
 * Pure, additive sync planning: given the source and the target's current state,
 * return the minimal set of adds. Idempotent (diffs against current state), skips
 * items already present, parks items with no external ID as unmatched. History
 * matches by item identity, not by per-play timestamp.
 */

export interface HistoryPlan {
  toAdd: WatchEvent[];
  unmatched: WatchEvent[]; // no usable external id
  skippedDuplicate: number; // same item appeared twice in the source
  skippedPresent: number; // already in the target
}

/**
 * `extraPresent` are items already delivered to the target on a previous run but
 * that the target may not report back (provider id/structure mismatches). Treat
 * them as present so the sync converges instead of re-sending forever.
 */
export function planHistorySync(
  source: WatchEvent[],
  target: WatchEvent[],
  extraPresent: MediaRef[] = [],
): HistoryPlan {
  const targetIndex = MatchIndex.from(target.map((e) => e.ref));
  for (const ref of extraPresent) targetIndex.add(ref);
  const seen = new Set<string>();
  const plan: HistoryPlan = { toAdd: [], unmatched: [], skippedDuplicate: 0, skippedPresent: 0 };

  for (const event of source) {
    if (!hasIdentity(event.ref)) {
      plan.unmatched.push(event);
      continue;
    }
    const key = itemKey(event.ref)!;
    if (seen.has(key)) {
      plan.skippedDuplicate++;
      continue;
    }
    seen.add(key);

    if (targetIndex.has(event.ref)) {
      plan.skippedPresent++;
      continue;
    }
    plan.toAdd.push(event);
  }
  return plan;
}

export interface ProgressPlan {
  toAdd: ProgressEvent[];
  unmatched: ProgressEvent[];
  skippedDuplicate: number;
  skippedUnchanged: number;
}

/**
 * Whether `sourceAt` should beat `targetAt`. When either timestamp is missing or
 * unparseable we cannot compare, so the source is allowed through (source-wins
 * fallback). Equal times do not count as newer.
 */
function isNewer(sourceAt: string | null | undefined, targetAt: string | null | undefined): boolean {
  if (!sourceAt || !targetAt) return true;
  const s = Date.parse(sourceAt);
  const t = Date.parse(targetAt);
  if (Number.isNaN(s) || Number.isNaN(t)) return true;
  return s > t;
}

/**
 * Progress planning. Push a resume position when the target has no equal-or-newer
 * position for that item. A position is "unchanged" if the target's progress for
 * the same item is within 1 percentage point — avoids churning writes on tiny drift.
 * When positions differ, the more recent `pausedAt` wins so a stale device cannot
 * rewind one advanced elsewhere; if either side lacks a timestamp, the source wins.
 */
export function planProgressSync(source: ProgressEvent[], target: ProgressEvent[]): ProgressPlan {
  const targetByKey = new Map<string, ProgressEvent>();
  for (const e of target) {
    const key = itemKey(e.ref);
    if (key) targetByKey.set(key, e);
  }

  const seen = new Set<string>();
  const plan: ProgressPlan = { toAdd: [], unmatched: [], skippedDuplicate: 0, skippedUnchanged: 0 };

  for (const event of source) {
    if (!hasIdentity(event.ref)) {
      plan.unmatched.push(event);
      continue;
    }
    const key = itemKey(event.ref)!;
    if (seen.has(key)) {
      plan.skippedDuplicate++;
      continue;
    }
    seen.add(key);

    const existing = targetByKey.get(key);
    if (existing) {
      // Positions already agree closely enough — no churn either way.
      if (Math.abs(existing.progress - event.progress) <= 1) {
        plan.skippedUnchanged++;
        continue;
      }
      // When both sides carry a paused-at time, the more recent position wins,
      // so a stale device cannot rewind one advanced elsewhere. Without a time
      // on either side, fall back to source-wins.
      if (!isNewer(event.pausedAt, existing.pausedAt)) {
        plan.skippedUnchanged++;
        continue;
      }
    }
    plan.toAdd.push(event);
  }
  return plan;
}

export interface RatingsPlan {
  toApply: RatingEvent[];
  unmatched: RatingEvent[];
  skippedDuplicate: number;
  skippedUnchanged: number;
}

/**
 * Ratings planning. Unlike history, ratings are update semantics: a re-rate
 * changes a value rather than adding a play, so an identical rating must be a
 * no-op (rewriting it would churn `rated_at`). Conflicts are resolved by a
 * per-sync authoritative side: when the source is authoritative it overwrites a
 * differing target rating; otherwise it only fills a rating the target lacks.
 */
export function planRatingsSync(
  source: RatingEvent[],
  target: RatingEvent[],
  opts: { sourceIsAuthoritative: boolean },
): RatingsPlan {
  const targetByKey = new Map<string, RatingEvent>();
  for (const e of target) {
    const key = itemKey(e.ref);
    if (key) targetByKey.set(key, e);
  }

  const seen = new Set<string>();
  const plan: RatingsPlan = { toApply: [], unmatched: [], skippedDuplicate: 0, skippedUnchanged: 0 };

  for (const event of source) {
    if (!hasIdentity(event.ref)) {
      plan.unmatched.push(event);
      continue;
    }
    const key = itemKey(event.ref)!;
    if (seen.has(key)) {
      plan.skippedDuplicate++;
      continue;
    }
    seen.add(key);

    const existing = targetByKey.get(key);
    if (existing) {
      // Same score, or the target owns this conflict — leave it alone.
      if (existing.rating === event.rating || !opts.sourceIsAuthoritative) {
        plan.skippedUnchanged++;
        continue;
      }
    }
    plan.toApply.push(event);
  }
  return plan;
}
