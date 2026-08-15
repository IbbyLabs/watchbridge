import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { itemKey, type DataType, type MediaRef } from '@watchbridge/core';
import type { Db } from '../db/client.js';
import { deliveries } from '../db/schema.js';

/**
 * Persistence for a sync's "convergence memory" — the items it has already
 * delivered to a given target. Scoped per (sync, target provider, data type) so
 * each direction of a two-way sync, and each kind of delivery, tracks
 * independently. A title can be both watched and watchlisted, so history and
 * watchlist deliveries must not collide.
 */
export class DeliveriesStore {
  constructor(private readonly db: Db) {}

  /** Previously-delivered item refs for a (sync, target, data type). */
  async load(syncId: string, target: string, dataType: DataType = 'history'): Promise<MediaRef[]> {
    const rows = await this.db.orm
      .select({ ref: deliveries.ref })
      .from(deliveries)
      .where(
        and(eq(deliveries.syncId, syncId), eq(deliveries.target, target), eq(deliveries.dataType, dataType)),
      );
    const out: MediaRef[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.ref) as MediaRef);
      } catch {
        // Skip a corrupt row rather than fail the whole sync.
      }
    }
    return out;
  }

  /**
   * Delivered refs with when they were delivered, for a (sync, target).
   *
   * The repair needs the timestamp: a title whose stored date sits in the window
   * when we delivered it is one we dated wrong, and one dated outside it is a
   * watch the person actually had.
   */
  async loadDated(
    syncId: string,
    target: string,
    dataType: DataType = 'history',
  ): Promise<Array<{ ref: MediaRef; deliveredAt: Date }>> {
    const rows = await this.db.orm
      .select({ ref: deliveries.ref, createdAt: deliveries.createdAt })
      .from(deliveries)
      .where(
        and(eq(deliveries.syncId, syncId), eq(deliveries.target, target), eq(deliveries.dataType, dataType)),
      );
    const out: Array<{ ref: MediaRef; deliveredAt: Date }> = [];
    for (const r of rows) {
      try {
        out.push({ ref: JSON.parse(r.ref) as MediaRef, deliveredAt: r.createdAt });
      } catch {
        // Skip a corrupt row rather than fail the whole repair.
      }
    }
    return out;
  }

  /** Record newly-delivered refs. Idempotent — re-recording the same item is a no-op. */
  async record(
    syncId: string,
    userId: string,
    target: string,
    refs: MediaRef[],
    dataType: DataType = 'history',
  ): Promise<void> {
    const rows = refs
      .map((ref) => {
        const key = itemKey(ref);
        return key
          ? { id: randomUUID(), syncId, userId, target, dataType, itemKey: key, ref: JSON.stringify(ref) }
          : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length === 0) return;
    await this.db.orm.insert(deliveries).values(rows).onConflictDoNothing();
  }

  /**
   * Drop refs from the ledger. Used when a watchlist item is removed from the
   * target, so the same title can be delivered again if it later returns to the
   * source.
   */
  async forget(syncId: string, target: string, refs: MediaRef[], dataType: DataType = 'history'): Promise<void> {
    const keys = refs.map(itemKey).filter((k): k is string => k !== null);
    if (keys.length === 0) return;
    await this.db.orm
      .delete(deliveries)
      .where(
        and(
          eq(deliveries.syncId, syncId),
          eq(deliveries.target, target),
          eq(deliveries.dataType, dataType),
          inArray(deliveries.itemKey, keys),
        ),
      );
  }
}
