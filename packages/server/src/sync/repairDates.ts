import { itemKey, createLogger, type MediaRef, type WatchEvent } from '@watchbridge/core';
import type { ConnectionService } from '../connections/service.js';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { repairIntents } from '../db/schema.js';
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

/**
 * Items corrected between verifying reads.
 *
 * Writes stay one at a time, so a failure still affects a single item. This
 * only batches the reading: neither provider offers a per-item history read, so
 * verifying after every item means pulling the whole account every time, which
 * grows with the square of how much is wrong. An intent stays until its item
 * has been seen correct, so anything in the last unverified group is named in
 * the intents and picked up by the next run.
 */
const VERIFY_EVERY = 25;

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

/** The provider surface the repair uses, so a fake needs nothing more. */
interface RepairClient {
  pullHistory(): Promise<WatchEvent[]>;
  pushHistory(events: WatchEvent[]): Promise<unknown>;
  removeHistory?(events: WatchEvent[]): Promise<unknown>;
}

export class DateRepair {
  constructor(
    private readonly connections: ConnectionService,
    private readonly deliveries: DeliveriesStore,
    private readonly db: Db,
  ) {}

  /** Intent rows for items written but not yet seen correct, within one run. */
  private readonly intentIds = new Map<string, string>();

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

  /**
   * Correct the dates this repair owns, one item at a time.
   *
   * One item per step rather than a batch: this is started by a person and left
   * to run, so an hour costs nothing, and a failure between the removal and the
   * add then affects a single item instead of a batch of them. The intent row is
   * written before the removal so an interruption leaves a record of what is
   * missing rather than a gap nothing knows about.
   *
   * It stops on the first item that does not read back correctly. Twenty items
   * corrected and then a halt is recoverable; two thousand streamed through with
   * a silent failure at item forty is not.
   */
  async run(userId: string, syncId: string, source: string, target: string): Promise<RepairPlan> {
    const counts = emptyCounts();
    const ledger = await this.deliveries.loadDated(syncId, target);
    counts.delivered = ledger.length;
    if (ledger.length === 0) return { target, counts, unidentifiable: true };

    const client = await this.connections.clientFor(userId, target as never);
    if (!client) {
      counts.stoppedBecause = `${target} is not connected`;
      return { target, counts, unidentifiable: false };
    }
    const current = await this.readCurrent(userId, target);
    const sourceDates = await this.readCurrent(userId, source);
    if (!current || !sourceDates) {
      counts.stoppedBecause = 'could not read both sides, so nothing was changed';
      return { target, counts, unidentifiable: false };
    }

    // Anything removed by an earlier run and not put back comes first: it is
    // the only state where a person is missing a watch rather than holding a
    // wrong date, so it is worse than everything below it.
    const resumed = await this.finishPending(userId, syncId, target, client);
    counts.repaired += resumed.repaired;
    counts.failed += resumed.failed;
    if (resumed.stoppedBecause) {
      counts.stoppedBecause = resumed.stoppedBecause;
      return { target, counts, unidentifiable: false };
    }

    const written: Array<{ key: string; wanted: string }> = [];
    for (const entry of ledger) {
      const key = itemKey(entry.ref);
      if (!key || !current.has(key)) continue;
      counts.examined++;

      if (!looksDelivered(current.get(key) ?? null, entry.deliveredAt)) {
        counts.skipped++;
        continue;
      }
      const wanted = sourceDates.get(key);
      if (!wanted) {
        counts.skipped++;
        continue;
      }
      counts.candidates++;

      const outcome = await this.repairOne(userId, syncId, target, client, entry.ref, key, wanted);
      if (outcome !== 'written') {
        counts.failed++;
        counts.stoppedBecause = outcome;
        break;
      }
      written.push({ key, wanted });
      if (written.length >= VERIFY_EVERY) {
        const problem = await this.verify(syncId, target, client, written);
        counts.repaired += written.length - (problem ? 1 : 0);
        written.length = 0;
        if (problem) {
          counts.failed++;
          counts.stoppedBecause = problem;
          break;
        }
      }
    }

    if (!counts.stoppedBecause && written.length) {
      const problem = await this.verify(syncId, target, client, written);
      counts.repaired += written.length - (problem ? 1 : 0);
      if (problem) {
        counts.failed++;
        counts.stoppedBecause = problem;
      }
    }
    return { target, counts, unidentifiable: false };
  }

  /**
   * One item. Returns 'repaired' or the reason a person should be shown.
   *
   * Simkl will not change a date in place, so the removal is unavoidable there.
   * MDBList overwrites whatever is stored, so it needs no removal — and must not
   * be given one, since a removal it cannot undo is pure risk.
   */
  private async repairOne(
    userId: string,
    syncId: string,
    target: string,
    client: RepairClient,
    ref: MediaRef,
    key: string,
    wanted: string,
  ): Promise<'written' | string> {
    const intentId = randomUUID();
    const mustRemove = target !== 'mdblist';

    try {
      if (mustRemove) {
        if (!client.removeHistory) return `${target} cannot remove history, so the date cannot be corrected`;
        await this.db.orm.insert(repairIntents).values({
          id: intentId,
          userId,
          syncId,
          target,
          itemKey: key,
          ref: JSON.stringify(ref),
          watchedAt: wanted,
        });
        await client.removeHistory([{ ref, watchedAt: null }]);
      }

      await client.pushHistory([{ ref, watchedAt: wanted }]);
      if (!mustRemove) {
        // Nothing was removed, so there is no intent to clear.
        return 'written';
      }
      this.intentIds.set(`${target}:${key}`, intentId);
      return 'written';
    } catch (err) {
      log.warn({ userId, target, key, err }, 'Could not correct a watch date');
      return `a write failed part-way (${key})`;
    }
  }

  /**
   * Confirm a group of corrections landed, in one read rather than one each.
   * Returns the reason to stop, or undefined when every item is correct.
   */
  private async verify(
    syncId: string,
    target: string,
    client: RepairClient,
    written: Array<{ key: string; wanted: string }>,
  ): Promise<string | undefined> {
    const now = byKey(await client.pullHistory());
    for (const item of written) {
      const after = now.get(item.key) ?? null;
      if (!after || Math.abs(Date.parse(after) - Date.parse(item.wanted)) > 1000) {
        return `an item did not read back with its corrected date (${item.key})`;
      }
    }
    for (const item of written) {
      const id = this.intentIds.get(`${target}:${item.key}`);
      if (!id) continue;
      await this.db.orm.delete(repairIntents).where(eq(repairIntents.id, id));
      this.intentIds.delete(`${target}:${item.key}`);
    }
    void syncId;
    return undefined;
  }

  /**
   * Put back anything an earlier run removed and did not restore. Each intent
   * carries the ref and the date, so this needs neither the source nor the
   * ledger — which is what makes it survive the sync being deleted.
   */
  private async finishPending(
    userId: string,
    syncId: string,
    target: string,
    client: RepairClient,
  ): Promise<{ repaired: number; failed: number; stoppedBecause?: string }> {
    const pending = await this.pending(syncId, target);
    let repaired = 0;
    for (const item of pending) {
      const key = itemKey(item.ref);
      if (!key) continue;
      try {
        await client.pushHistory([{ ref: item.ref, watchedAt: item.watchedAt }]);
        const after = byKey(await client.pullHistory()).get(key) ?? null;
        if (!after || Math.abs(Date.parse(after) - Date.parse(item.watchedAt)) > 1000) {
          return { repaired, failed: 1, stoppedBecause: `an item removed earlier did not come back (${key})` };
        }
        await this.db.orm
          .delete(repairIntents)
          .where(
            and(
              eq(repairIntents.syncId, syncId),
              // The unique index is on all three. Without the target, restoring
              // an item for one provider clears another provider's pending row
              // and leaves that item removed with nothing knowing.
              eq(repairIntents.target, target),
              eq(repairIntents.itemKey, key),
            ),
          );
        repaired++;
      } catch (err) {
        log.warn({ userId, target, key, err }, 'Could not restore an item removed by an earlier run');
        return { repaired, failed: 1, stoppedBecause: `an item removed earlier could not be restored (${key})` };
      }
    }
    return { repaired, failed: 0 };
  }

  /** Items removed and not yet put back, for this sync and target. */
  async pending(syncId: string, target: string): Promise<Array<{ ref: MediaRef; watchedAt: string }>> {
    const rows = await this.db.orm
      .select()
      .from(repairIntents)
      .where(and(eq(repairIntents.syncId, syncId), eq(repairIntents.target, target)));
    return rows.map((r) => ({ ref: JSON.parse(r.ref) as MediaRef, watchedAt: r.watchedAt }));
  }

  private async readCurrent(userId: string, provider: string): Promise<Map<string, string | null> | null> {
    const client = await this.connections.clientFor(userId, provider as never);
    if (!client?.pullHistory) return null;
    return byKey(await client.pullHistory());
  }
}

export { looksDelivered, byKey, WINDOW_MS };
export type { MediaRef };
