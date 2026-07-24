import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '@watchbridge/core';
import { requireAuth } from '../plugins/auth.js';
import type { Db } from '../db/client.js';
import { syncs, syncRuns, type Sync } from '../db/schema.js';
import { parseDataTypes, type SyncRunner } from '../sync/runner.js';
import type { SyncScheduler } from '../sync/scheduler.js';

const provider = z.enum(['trakt', 'simkl', 'pmdb', 'mdblist']);
const dataType = z.enum(['history', 'progress', 'ratings', 'watchlist']);

const externalIds = z
  .object({
    imdb: z.string().optional(),
    tmdb: z.number().int().optional(),
    tvdb: z.number().int().optional(),
    trakt: z.number().int().optional(),
    slug: z.string().optional(),
    simkl: z.number().int().optional(),
    mal: z.number().int().optional(),
    anilist: z.number().int().optional(),
    anidb: z.number().int().optional(),
  })
  .strict();

const filters = z
  .object({
    movies: z.boolean().optional(),
    shows: z.boolean().optional(),
    excludeSpecials: z.boolean().optional(),
    exclude: z.array(externalIds).max(500).optional(),
  })
  .strict();

const createBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    source: provider,
    target: provider,
    dataTypes: z.array(dataType).min(1),
    direction: z.enum(['one_way', 'two_way']).default('one_way'),
    intervalMinutes: z.number().int().positive().nullable().optional(),
    filters: filters.nullable().optional(),
    ratingsAuthority: provider.nullable().optional(),
    propagateWatchlistRemovals: z.boolean().optional(),
  })
  .refine((v) => v.source !== v.target, {
    message: 'source and target must differ',
    path: ['target'],
  })
  .refine((v) => !v.dataTypes.includes('ratings') || v.ratingsAuthority === v.source || v.ratingsAuthority === v.target, {
    message: 'ratings syncs need a ratings authority of the source or target',
    path: ['ratingsAuthority'],
  })
  .refine((v) => v.direction !== 'two_way' || v.propagateWatchlistRemovals !== true, {
    message:
      'a two-way sync cannot propagate watchlist removals: an item just added on one side is indistinguishable from one removed on the other',
    path: ['propagateWatchlistRemovals'],
  });

const patchBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  dataTypes: z.array(dataType).min(1).optional(),
  direction: z.enum(['one_way', 'two_way']).optional(),
  intervalMinutes: z.number().int().positive().nullable().optional(),
  filters: filters.nullable().optional(),
  ratingsAuthority: provider.nullable().optional(),
  propagateWatchlistRemovals: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

/** Store null for an absent or empty filter object, so "no filtering" is uniform. */
function serializeFilters(f: z.infer<typeof filters> | null | undefined): string | null {
  if (!f || Object.keys(f).length === 0) return null;
  return JSON.stringify(f);
}

function parseFilters(raw: string | null): z.infer<typeof filters> | null {
  if (!raw) return null;
  try {
    return filters.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function toPublic(s: Sync) {
  return {
    id: s.id,
    name: s.name,
    source: s.source,
    target: s.target,
    dataTypes: parseDataTypes(s.dataTypes),
    direction: s.direction,
    intervalMinutes: s.intervalMinutes,
    filters: parseFilters(s.filters),
    ratingsAuthority: s.ratingsAuthority,
    propagateWatchlistRemovals: s.propagateWatchlistRemovals,
    enabled: s.enabled,
    lastRunAt: s.lastRunAt,
    lastRunStatus: s.lastRunStatus,
    createdAt: s.createdAt,
  };
}

export function syncRoutes(
  app: FastifyInstance,
  db: Db,
  runner: SyncRunner,
  scheduler: SyncScheduler,
  config: AppConfig,
): void {
  const auth = { preHandler: requireAuth };

  const load = async (request: FastifyRequest): Promise<Sync | null> => {
    const id = (request.params as { id: string }).id;
    const [row] = await db.orm
      .select()
      .from(syncs)
      .where(and(eq(syncs.id, id), eq(syncs.userId, request.user!.id)))
      .limit(1);
    return row ?? null;
  };

  const clampInterval = (m: number | null | undefined): number | null => {
    if (m === null || m === undefined) return null;
    return Math.max(config.MIN_SCHEDULE_INTERVAL_MINUTES, m);
  };

  app.get('/api/syncs', auth, async (request, reply) => {
    const rows = await db.orm.select().from(syncs).where(eq(syncs.userId, request.user!.id));
    return reply.send(rows.map(toPublic));
  });

  app.post('/api/syncs', auth, async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.flatten() });
    const data = parsed.data;
    const id = randomUUID();
    await db.orm.insert(syncs).values({
      id,
      userId: request.user!.id,
      name: data.name,
      source: data.source,
      target: data.target,
      dataTypes: JSON.stringify(data.dataTypes),
      direction: data.direction,
      intervalMinutes: clampInterval(data.intervalMinutes),
      filters: serializeFilters(data.filters),
      ratingsAuthority: data.dataTypes.includes('ratings') ? (data.ratingsAuthority ?? null) : null,
      propagateWatchlistRemovals:
        data.dataTypes.includes('watchlist') && data.propagateWatchlistRemovals === true,
    });
    const [row] = await db.orm.select().from(syncs).where(eq(syncs.id, id)).limit(1);
    return reply.code(201).send(toPublic(row!));
  });

  app.patch('/api/syncs/:id', auth, async (request, reply) => {
    const existing = await load(request);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const parsed = patchBody.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.flatten() });
    const d = parsed.data;

    // Validate the ratings authority against the sync's state after the patch.
    const nextDataTypes = d.dataTypes ?? parseDataTypes(existing.dataTypes);
    const nextAuthority =
      d.ratingsAuthority !== undefined ? d.ratingsAuthority : existing.ratingsAuthority;
    if (
      nextDataTypes.includes('ratings') &&
      nextAuthority !== existing.source &&
      nextAuthority !== existing.target
    ) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: 'ratings syncs need a ratings authority of the source or target',
      });
    }
    // Ratings authority only means anything for a ratings sync; clear it otherwise.
    const authorityValue = nextDataTypes.includes('ratings') ? (nextAuthority ?? null) : null;
    // Same for removal propagation: dropping watchlist from a sync turns it back off,
    // so re-adding watchlist later cannot silently resurrect a destructive setting.
    const nextRemovals =
      d.propagateWatchlistRemovals !== undefined
        ? d.propagateWatchlistRemovals
        : existing.propagateWatchlistRemovals;
    const nextDirection = d.direction ?? existing.direction;
    if (nextRemovals === true && nextDirection === 'two_way') {
      return reply.code(400).send({
        error: 'invalid_input',
        message:
          'a two-way sync cannot propagate watchlist removals: an item just added on one side is indistinguishable from one removed on the other',
      });
    }
    const removalsValue = nextDataTypes.includes('watchlist') && nextRemovals === true;

    await db.orm
      .update(syncs)
      .set({
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.dataTypes !== undefined ? { dataTypes: JSON.stringify(d.dataTypes) } : {}),
        ...(d.direction !== undefined ? { direction: d.direction } : {}),
        ...(d.intervalMinutes !== undefined
          ? { intervalMinutes: clampInterval(d.intervalMinutes) }
          : {}),
        ...(d.filters !== undefined ? { filters: serializeFilters(d.filters) } : {}),
        ...(d.dataTypes !== undefined || d.ratingsAuthority !== undefined
          ? { ratingsAuthority: authorityValue }
          : {}),
        ...(d.dataTypes !== undefined || d.propagateWatchlistRemovals !== undefined
          ? { propagateWatchlistRemovals: removalsValue }
          : {}),
        ...(d.enabled !== undefined ? { enabled: d.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(syncs.id, existing.id));
    const [row] = await db.orm.select().from(syncs).where(eq(syncs.id, existing.id)).limit(1);
    return reply.send(toPublic(row!));
  });

  app.delete('/api/syncs/:id', auth, async (request, reply) => {
    const existing = await load(request);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    await db.orm.delete(syncs).where(eq(syncs.id, existing.id));
    return reply.send({ status: 'removed' });
  });

  app.post('/api/syncs/:id/preview', auth, async (request, reply) => {
    const sync = await load(request);
    if (!sync) return reply.code(404).send({ error: 'not_found' });
    const outcome = await runner.preview(sync);
    return reply.send(outcome);
  });

  app.post('/api/syncs/:id/run', auth, async (request, reply) => {
    const sync = await load(request);
    if (!sync) return reply.code(404).send({ error: 'not_found' });
    const outcome = await scheduler.runNow(sync);
    return reply.send(outcome);
  });

  app.get('/api/syncs/:id/runs', auth, async (request, reply) => {
    const sync = await load(request);
    if (!sync) return reply.code(404).send({ error: 'not_found' });
    const rows = await db.orm
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.syncId, sync.id))
      .orderBy(desc(syncRuns.startedAt))
      .limit(50);
    return reply.send(rows);
  });
}
