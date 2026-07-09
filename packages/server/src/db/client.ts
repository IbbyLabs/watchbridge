import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { createLogger } from '@watchbridge/core';
import * as schema from './schema.js';

const log = createLogger('db');

export type Database = PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

export interface Db {
  orm: Database;
  migrate: () => Promise<void>;
  close: () => Promise<void>;
}

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

function pglitePath(databaseUrl: string): string {
  const raw = databaseUrl.startsWith('pglite://')
    ? databaseUrl.slice('pglite://'.length)
    : databaseUrl;
  return resolve(process.cwd(), raw || './data/pg');
}

export async function createDb(databaseUrl: string): Promise<Db> {
  if (/^postgres(ql)?:\/\//.test(databaseUrl)) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: databaseUrl });
    const orm = drizzlePg(pool, { schema });
    log.info('Using Postgres');
    return {
      orm,
      migrate: () => migratePg(orm, { migrationsFolder }),
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const inMemory = databaseUrl === 'pglite://memory' || databaseUrl.endsWith(':memory:');
  let client: InstanceType<typeof PGlite>;
  if (inMemory) {
    client = new PGlite();
    log.info('Using in-memory PGlite');
    const orm = drizzlePglite(client, { schema });
    return {
      orm,
      migrate: () => migratePglite(orm, { migrationsFolder }),
      close: () => client.close(),
    };
  }
  const dir = pglitePath(databaseUrl);
  mkdirSync(dir, { recursive: true });
  client = new PGlite(dir);
  const orm = drizzlePglite(client, { schema });
  log.info({ dir }, 'Using embedded PGlite');
  return {
    orm,
    migrate: () => migratePglite(orm, { migrationsFolder }),
    close: () => client.close(),
  };
}

export { schema };
