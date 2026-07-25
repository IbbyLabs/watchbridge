import { and, eq, isNotNull } from 'drizzle-orm';
import { createLogger, type AppConfig } from '@watchbridge/core';
import type { Db } from '../db/client.js';
import { syncs, type Sync } from '../db/schema.js';
import type { RunOutcome, SyncRunner, Trigger } from './runner.js';

const log = createLogger('scheduler');

/** Global + per-user concurrency gate so scheduled work can't overwhelm the box. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly perUser = new Map<string, number>();
  private readonly waiters: Array<{ userId: string; resolve: () => void }> = [];

  constructor(
    private readonly globalMax: number,
    private readonly perUserMax: number,
  ) {}

  async run<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(userId);
    try {
      return await fn();
    } finally {
      this.release(userId);
    }
  }

  private canRun(userId: string): boolean {
    return this.active < this.globalMax && (this.perUser.get(userId) ?? 0) < this.perUserMax;
  }

  private take(userId: string): void {
    this.active++;
    this.perUser.set(userId, (this.perUser.get(userId) ?? 0) + 1);
  }

  private acquire(userId: string): Promise<void> {
    if (this.canRun(userId)) {
      this.take(userId);
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push({ userId, resolve }));
  }

  private release(userId: string): void {
    this.active--;
    const n = (this.perUser.get(userId) ?? 1) - 1;
    if (n <= 0) this.perUser.delete(userId);
    else this.perUser.set(userId, n);

    const idx = this.waiters.findIndex((w) => this.canRun(w.userId));
    if (idx >= 0) {
      const [w] = this.waiters.splice(idx, 1);
      this.take(w!.userId);
      w!.resolve();
    }
  }
}

/**
 * In-process scheduler: every minute it runs enabled interval syncs that are due,
 * through the concurrency limiter, guarding against overlapping runs of the same
 * sync. Single-container by design; swap for a distributed queue to scale out.
 */
export class SyncScheduler {
  private timer?: NodeJS.Timeout;
  private readonly inFlight = new Set<string>();
  readonly limiter: ConcurrencyLimiter;

  constructor(
    private readonly db: Db,
    private readonly runner: SyncRunner,
    config: AppConfig,
  ) {
    this.limiter = new ConcurrencyLimiter(config.MAX_CONCURRENT_SYNCS_GLOBAL, config.MAX_CONCURRENT_SYNCS_PER_USER);
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
    void this.tick();
    log.info('Scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run a sync immediately (manual), respecting the concurrency gate. */
  runNow(sync: Sync): Promise<RunOutcome> {
    return this.dispatch(sync, 'manual');
  }

  /**
   * Plan a sync without writing anything. A preview writes nothing but reads just
   * as much, so it goes through the same gate — otherwise repeated previews are an
   * unbounded burst of provider reads, which is what gets an API key suspended.
   */
  previewNow(sync: Sync): Promise<RunOutcome> {
    return this.dispatch(sync, 'preview');
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    let due: Sync[];
    try {
      due = await this.db.orm
        .select()
        .from(syncs)
        .where(and(eq(syncs.enabled, true), isNotNull(syncs.intervalMinutes)));
    } catch (err) {
      log.error({ err }, 'Scheduler tick query failed');
      return;
    }
    for (const sync of due) {
      const interval = (sync.intervalMinutes ?? 0) * 60_000;
      const last = sync.lastRunAt ? sync.lastRunAt.getTime() : 0;
      if (now - last >= interval && !this.inFlight.has(sync.id)) {
        void this.dispatch(sync, 'scheduled').catch((err) => log.error({ syncId: sync.id, err }, 'Scheduled run error'));
      }
    }
  }

  private dispatch(sync: Sync, trigger: Trigger): Promise<RunOutcome> {
    if (this.inFlight.has(sync.id)) {
      return Promise.resolve({ status: 'error', reports: [], error: 'A run for this sync is already in progress' });
    }
    this.inFlight.add(sync.id);
    return this.limiter
      .run(sync.userId, () => this.runner.execute(sync, trigger))
      .finally(() => this.inFlight.delete(sync.id));
  }
}
