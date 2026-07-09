import type { MediaRef, ProgressEvent, WatchEvent } from '../providers/types.js';
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
 * Progress planning. Push a resume position when the target has no equal-or-newer
 * position for that item. A position is "unchanged" if the target's progress for
 * the same item is within 1 percentage point — avoids churning writes on tiny drift.
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
    if (existing && Math.abs(existing.progress - event.progress) <= 1) {
      plan.skippedUnchanged++;
      continue;
    }
    plan.toAdd.push(event);
  }
  return plan;
}
