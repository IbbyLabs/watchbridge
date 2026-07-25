import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '@watchbridge/core';
import { requireAuth } from '../plugins/auth.js';
import type { Db } from '../db/client.js';
import { connections, deliveries, syncRuns, syncs } from '../db/schema.js';
import { parseDataTypes } from '../sync/runner.js';

const log = createLogger('account');

/** Newest runs first, capped so one export cannot pull an unbounded history. */
const MAX_RUNS = 500;

export function accountRoutes(app: FastifyInstance, db: Db): void {
  const auth = { preHandler: requireAuth };

  /**
   * Everything Watchbridge holds for the signed-in user, as one JSON document.
   *
   * Provider credentials are deliberately absent: they are the one thing here
   * that grants access to somebody else's account, and an export is a file that
   * ends up in downloads folders and email attachments. Everything else — what
   * is connected, how it is configured, and what every run did — is included.
   */
  app.get('/api/account/export', auth, async (request, reply) => {
    const userId = request.user!.id;

    const [conns, syncRows, runRows, deliveryRows] = await Promise.all([
      db.orm.select().from(connections).where(eq(connections.userId, userId)),
      db.orm.select().from(syncs).where(eq(syncs.userId, userId)),
      db.orm
        .select()
        .from(syncRuns)
        .where(eq(syncRuns.userId, userId))
        .orderBy(desc(syncRuns.startedAt))
        .limit(MAX_RUNS),
      db.orm.select().from(deliveries).where(eq(deliveries.userId, userId)),
    ]);

    const document = {
      exportedAt: new Date().toISOString(),
      note: 'Provider credentials are not included in this export.',
      account: {
        email: request.user!.email,
        username: request.user!.username,
        emailVerified: request.user!.emailVerified,
        createdAt: request.user!.createdAt,
      },
      connections: conns.map((c) => ({
        provider: c.provider,
        label: c.label,
        status: c.status,
        createdAt: c.createdAt,
        lastValidatedAt: c.lastValidatedAt,
      })),
      syncs: syncRows.map((s) => ({
        id: s.id,
        name: s.name,
        source: s.source,
        target: s.target,
        dataTypes: parseDataTypes(s.dataTypes),
        direction: s.direction,
        intervalMinutes: s.intervalMinutes,
        filters: safeJson(s.filters),
        ratingsAuthority: s.ratingsAuthority,
        propagateWatchlistRemovals: s.propagateWatchlistRemovals,
        enabled: s.enabled,
        createdAt: s.createdAt,
        lastRunAt: s.lastRunAt,
        lastRunStatus: s.lastRunStatus,
      })),
      runs: runRows.map((r) => ({
        syncId: r.syncId,
        trigger: r.trigger,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        error: r.error,
        report: safeJson(r.report),
      })),
      // What each sync has already delivered. Included because it explains why a
      // run plans nothing, which is otherwise invisible.
      deliveries: deliveryRows.map((d) => ({
        syncId: d.syncId,
        target: d.target,
        itemKey: d.itemKey,
        ref: safeJson(d.ref),
        createdAt: d.createdAt,
      })),
      truncated: runRows.length === MAX_RUNS ? { runs: `only the most recent ${MAX_RUNS} runs` } : undefined,
    };

    log.info(
      {
        userId,
        connections: document.connections.length,
        syncs: document.syncs.length,
        runs: document.runs.length,
        deliveries: document.deliveries.length,
      },
      'Account data exported',
    );

    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="watchbridge-export-${stamp}.json"`)
      .send(document);
  });
}

/** Stored JSON columns are returned as parsed values, or as null if unreadable. */
function safeJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
