import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@watchbridge/core';
import type { Db } from '../db/client.js';

export function healthRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  app.get('/api/health', async (_req, reply) => {
    let dbOk = true;
    try {
      await db.orm.execute(sql`select 1`);
    } catch {
      dbOk = false;
    }
    const status = dbOk ? 'ok' : 'degraded';
    return reply.code(dbOk ? 200 : 503).send({
      status,
      version: config.APP_VERSION,
      db: dbOk,
    });
  });
}
