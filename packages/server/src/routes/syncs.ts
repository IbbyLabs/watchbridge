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
const dataType = z.enum(['history', 'progress']);

const createBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    source: provider,
    target: provider,
    dataTypes: z.array(dataType).min(1),
    direction: z.enum(['one_way', 'two_way']).default('one_way'),
    intervalMinutes: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => v.source !== v.target, {
    message: 'source and target must differ',
    path: ['target'],
  });

const patchBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  dataTypes: z.array(dataType).min(1).optional(),
  direction: z.enum(['one_way', 'two_way']).optional(),
  intervalMinutes: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});

function toPublic(s: Sync) {
  return {
    id: s.id,
    name: s.name,
    source: s.source,
    target: s.target,
    dataTypes: parseDataTypes(s.dataTypes),
    direction: s.direction,
    intervalMinutes: s.intervalMinutes,
    enabled: s.enabled,
    lastRunAt: s.lastRunAt,
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
    await db.orm
      .update(syncs)
      .set({
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.dataTypes !== undefined ? { dataTypes: JSON.stringify(d.dataTypes) } : {}),
        ...(d.direction !== undefined ? { direction: d.direction } : {}),
        ...(d.intervalMinutes !== undefined
          ? { intervalMinutes: clampInterval(d.intervalMinutes) }
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
