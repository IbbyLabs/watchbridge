import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '@watchbridge/core';
import type { ConnectionService } from '../connections/service.js';
import type { Db } from '../db/client.js';
import { syncs } from '../db/schema.js';
import { DeliveriesStore } from '../sync/deliveries.js';
import { DateRepair, type RepairPlan } from '../sync/repairDates.js';
import { requireAuth } from '../plugins/auth.js';

const log = createLogger('repair');

/** Providers where a history push arrived stamped with the time of the push. */
const AFFECTED = new Set(['simkl', 'mdblist']);

/**
 * The one-time repair for history delivered with the wrong watch date.
 *
 * A person asks for this and it runs once. There is no schedule and no
 * on-behalf-of: it removes watch history before putting it back, and that is
 * not something to do to somebody without them choosing it.
 */
export function repairRoutes(app: FastifyInstance, db: Db, connections: ConnectionService): void {
  const auth = { preHandler: requireAuth };
  const repair = new DateRepair(connections, new DeliveriesStore(db), db);

  const mine = async (userId: string) =>
    (await db.orm.select().from(syncs).where(eq(syncs.userId, userId))).filter((s) =>
      AFFECTED.has(s.target),
    );

  /** What a repair would do, having done none of it. */
  app.get('/api/repair/watch-dates', auth, async (request) => {
    const userId = request.user!.id;
    const plans: Array<RepairPlan & { syncId: string; name: string }> = [];
    for (const sync of await mine(userId)) {
      const plan = await repair.plan(userId, sync.id, sync.source, sync.target);
      plans.push({ ...plan, syncId: sync.id, name: sync.name });
    }
    return { plans, explanation: explain(plans) };
  });

  app.post('/api/repair/watch-dates', auth, async (request) => {
    const userId = request.user!.id;
    const results: Array<RepairPlan & { syncId: string; name: string }> = [];
    for (const sync of await mine(userId)) {
      const result = await repair.run(userId, sync.id, sync.source, sync.target);
      results.push({ ...result, syncId: sync.id, name: sync.name });
      log.info({ userId, sync: sync.id, target: sync.target, counts: result.counts }, 'Ran a watch-date repair');
    }
    const remaining = results.reduce((n, r) => n + r.counts.remaining, 0);
    return { results, remaining, explanation: explain(results) };
  });
}

/**
 * What to tell the person, in their terms.
 *
 * Someone with no delivery record gets told plainly rather than offered a
 * rewrite from source. We cannot tell which of their dates we wrote, and
 * rewriting everything would overwrite watches they really had — introducing a
 * second wrong date while fixing the first.
 */
export function explain(plans: RepairPlan[]): string[] {
  const out: string[] = [];
  // Every branch below is per-plan, so somebody with no syncs would get an
  // empty list and a page that does not visibly react to being pressed. That is
  // the state anyone is in before they set anything up.
  if (plans.length === 0) {
    return [
      'Nothing to check. This corrects watch dates on history Watchbridge has sent to Simkl or ' +
        'MDBList, and there are no syncs set up yet.',
    ];
  }
  for (const p of plans) {
    if (p.counts.pendingRestores > 0) {
      const n = p.counts.pendingRestores;
      out.push(
        `${n} ${n === 1 ? 'item was' : 'items were'} removed from ${p.target} by an earlier attempt and ` +
          `not put back yet. Running this restores ${n === 1 ? 'it' : 'them'} first.`,
      );
    }
    if (p.unidentifiable) {
      out.push(
        `We have no record of what we sent to ${p.target}, so we cannot tell which dates we got wrong ` +
          `and which are watches you really had. Nothing has been changed. You can correct dates on ` +
          `${p.target} directly, or re-import from your source there.`,
      );
      continue;
    }
    if (p.counts.stoppedBecause) {
      out.push(`Stopped part-way on ${p.target}: ${p.counts.stoppedBecause}. Run it again to carry on.`);
      continue;
    }
    if (p.counts.candidates === 0) {
      out.push(`Nothing on ${p.target} needs correcting.`);
      continue;
    }
    const tail = p.counts.remaining > 0 ? `, ${p.counts.remaining} still to go` : '';
    out.push(
      `${p.target}: ${p.counts.repaired} of ${p.counts.candidates} corrected${tail}, ` +
        `${p.counts.skipped} left alone because they are dated outside the import.`,
    );
  }
  return out;
}
