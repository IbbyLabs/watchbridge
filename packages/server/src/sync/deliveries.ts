import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { itemKey, type MediaRef } from '@watchbridge/core';
import type { Db } from '../db/client.js';
import { deliveries } from '../db/schema.js';

/**
 * Persistence for a sync's "convergence memory" — the items it has already
 * delivered to a given target. Scoped per (sync, target provider) so each
 * direction of a two-way sync tracks independently.
 */
export class DeliveriesStore {
  constructor(private readonly db: Db) {}

  /** Previously-delivered item refs for a (sync, target). */
  async load(syncId: string, target: string): Promise<MediaRef[]> {
    const rows = await this.db.orm
      .select({ ref: deliveries.ref })
      .from(deliveries)
      .where(and(eq(deliveries.syncId, syncId), eq(deliveries.target, target)));
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

  /** Record newly-delivered refs. Idempotent — re-recording the same item is a no-op. */
  async record(syncId: string, userId: string, target: string, refs: MediaRef[]): Promise<void> {
    const rows = refs
      .map((ref) => {
        const key = itemKey(ref);
        return key ? { id: randomUUID(), syncId, userId, target, itemKey: key, ref: JSON.stringify(ref) } : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length === 0) return;
    await this.db.orm.insert(deliveries).values(rows).onConflictDoNothing();
  }
}
