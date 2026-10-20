import { isNotNull, lt, or } from 'drizzle-orm';
import { createLogger } from '@watchbridge/core';
import type { Db } from './client.js';
import {
  emailChangeTokens,
  emailVerificationTokens,
  passwordResetTokens,
  sessions,
  syncRuns,
} from './schema.js';

const log = createLogger('purge');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Retention periods stated in PRIVACY.md. */
export const SESSION_GRACE_MS = 7 * DAY_MS;
export const SYNC_RUN_RETENTION_MS = 90 * DAY_MS;
const PURGE_INTERVAL_MS = DAY_MS;

export interface PurgeCounts {
  sessions: number;
  syncRuns: number;
  tokens: number;
}

/** Deletes rows past the retention periods PRIVACY.md promises. */
export async function purgeExpired(db: Db, now = new Date()): Promise<PurgeCounts> {
  const sessionCutoff = new Date(now.getTime() - SESSION_GRACE_MS);
  const runCutoff = new Date(now.getTime() - SYNC_RUN_RETENTION_MS);

  const deadSessions = await db.orm
    .delete(sessions)
    .where(lt(sessions.expiresAt, sessionCutoff))
    .returning();
  const oldRuns = await db.orm
    .delete(syncRuns)
    .where(lt(syncRuns.startedAt, runCutoff))
    .returning();

  let tokens = 0;
  for (const table of [emailVerificationTokens, passwordResetTokens, emailChangeTokens]) {
    const gone = await db.orm
      .delete(table)
      .where(or(lt(table.expiresAt, now), isNotNull(table.consumedAt)))
      .returning();
    tokens += gone.length;
  }

  return { sessions: deadSessions.length, syncRuns: oldRuns.length, tokens };
}

/** Runs purgeExpired at startup and then daily. */
export class PurgeJob {
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: Db) {}

  start(): void {
    this.timer = setInterval(() => void this.run(), PURGE_INTERVAL_MS);
    this.timer.unref();
    void this.run();
    log.info({ intervalHours: PURGE_INTERVAL_MS / 3_600_000 }, 'Retention purge scheduled');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<void> {
    try {
      const counts = await purgeExpired(this.db);
      log.info(counts, 'Purged rows past their retention period');
    } catch (err) {
      log.error({ err }, 'Retention purge failed');
    }
  }
}
