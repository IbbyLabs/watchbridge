import { itemKey, createLogger, type MediaRef, type WatchEvent } from '@watchbridge/core';
import type { ConnectionService } from '../connections/service.js';
import type { DeliveriesStore } from './deliveries.js';

const log = createLogger('repair-dates');

/**
 * One-time repair for history we delivered with the wrong watch date.
 *
 * Before the fix, history pushed to Simkl and MDBList arrived stamped with the
 * time of the push rather than the time of the watch. Neither provider heals
 * this on a later sync: Simkl treats a re-add of a known item as a no-op, and
 * MDBList takes whatever date it is sent without comparing.
 *
 * A person starts this themselves and it runs once. It is not scheduled, and it
 * does not run on anyone's behalf.
 */

/** How far a stored date may sit from the delivery for us to own it. */
const WINDOW_MS = 60 * 60 * 1000;

export interface RepairCounts {
  /** Items in the ledger for this sync and target. */
  delivered: number;
  /** Of those, still present on the provider with a date we can read. */
  examined: number;
  /** Dates matching the delivery window, so ours to correct. */
  candidates: number;
  repaired: number;
  /** Dated outside the window: a watch the person had, left alone. */
  skipped: number;
  failed: number;
  /** Set when the run stopped early; the reason a person should be shown. */
  stoppedBecause?: string;
}

export interface RepairPlan {
  target: string;
  counts: RepairCounts;
  /** True when there is no ledger, so nothing can be told apart. */
  unidentifiable: boolean;
}

function emptyCounts(): RepairCounts {
  return { delivered: 0, examined: 0, candidates: 0, repaired: 0, skipped: 0, failed: 0 };
}

/**
 * Whether a stored date is one of ours.
 *
 * Deliberately not "take the newer of the two": the bug wrote the time of the
 * import, which is always newer than the real watch, so a newest-wins rule
 * keeps exactly the value being removed.
 */
function looksDelivered(stored: string | null, deliveredAt: Date): boolean {
  if (!stored) return false;
  const t = Date.parse(stored);
  if (Number.isNaN(t)) return false;
  return Math.abs(t - deliveredAt.getTime()) <= WINDOW_MS;
}

/** Current watch date per item, keyed the way the ledger is keyed. */
function byKey(events: WatchEvent[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const e of events) {
    const key = itemKey(e.ref);
    if (key) out.set(key, e.watchedAt);
  }
  return out;
}

export class DateRepair {
  constructor(
    private readonly connections: ConnectionService,
    private readonly deliveries: DeliveriesStore,
  ) {}

  /**
   * What a repair would do, without doing any of it. The same reads the run
   * performs, so a plan that says zero is a plan and not a guess.
   */
  async plan(userId: string, syncId: string, source: string, target: string): Promise<RepairPlan> {
    const counts = emptyCounts();
    const ledger = await this.deliveries.loadDated(syncId, target);
    counts.delivered = ledger.length;
    if (ledger.length === 0) {
      return { target, counts, unidentifiable: true };
    }

    const current = await this.readCurrent(userId, target);
    if (!current) {
      counts.stoppedBecause = `${target} is not connected`;
      return { target, counts, unidentifiable: false };
    }

    const sourceDates = await this.readCurrent(userId, source);
    for (const entry of ledger) {
      const key = itemKey(entry.ref);
      if (!key || !current.has(key)) continue;
      counts.examined++;
      if (!looksDelivered(current.get(key) ?? null, entry.deliveredAt)) {
        counts.skipped++;
        continue;
      }
      // Without a date from the source there is nothing to correct it to, and
      // removing it would lose the watch outright.
      if (!sourceDates?.get(key)) {
        counts.skipped++;
        continue;
      }
      counts.candidates++;
    }
    return { target, counts, unidentifiable: false };
  }

  private async readCurrent(userId: string, provider: string): Promise<Map<string, string | null> | null> {
    const client = await this.connections.clientFor(userId, provider as never);
    if (!client?.pullHistory) return null;
    return byKey(await client.pullHistory());
  }
}

export { looksDelivered, byKey, WINDOW_MS };
export type { MediaRef };
