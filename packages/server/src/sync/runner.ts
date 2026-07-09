import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  runSync,
  createLogger,
  type DataType,
  type ProviderId,
  type SyncReport,
} from '@watchbridge/core';
import type { Db } from '../db/client.js';
import { syncs, syncRuns, type Sync, type SyncRun } from '../db/schema.js';
import type { ConnectionService } from '../connections/service.js';

const log = createLogger('runner');

export type Trigger = 'manual' | 'scheduled' | 'preview';

export interface RunOutcome {
  status: 'success' | 'partial' | 'error';
  reports: SyncReport[];
  error?: string;
  run?: SyncRun;
}

export function parseDataTypes(raw: string): DataType[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) return arr.filter((x): x is DataType => x === 'history' || x === 'progress');
  } catch {
    // fall through
  }
  return [];
}

function parseCursors(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as unknown;
    return obj && typeof obj === 'object' ? (obj as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Advance a delta cursor only when the source exposes a newer one (Simkl) AND
 * the history push had no failures — so a transient error never skips items.
 */
function advanceCursor(
  cursors: Record<string, string>,
  key: string,
  source: { lastActivityAll?: string },
  report: SyncReport,
): void {
  const historyFailed = report.results.find((r) => r.dataType === 'history')?.failed ?? 0;
  if (source.lastActivityAll && historyFailed === 0) {
    cursors[key] = source.lastActivityAll;
  }
}

/** Executes a sync configuration by wiring connected clients into the engine. */
export class SyncRunner {
  constructor(
    private readonly db: Db,
    private readonly connections: ConnectionService,
  ) {}

  /** Plan only — nothing is written, nothing is persisted. */
  preview(sync: Sync): Promise<RunOutcome> {
    return this.execute(sync, 'preview');
  }

  async execute(sync: Sync, trigger: Trigger): Promise<RunOutcome> {
    const preview = trigger === 'preview';
    const dataTypes = parseDataTypes(sync.dataTypes);

    const [source, target] = await Promise.all([
      this.connections.clientFor(sync.userId, sync.source as ProviderId),
      this.connections.clientFor(sync.userId, sync.target as ProviderId),
    ]);

    if (!source || !target) {
      const error = `Missing connection: ${!source ? sync.source : sync.target} is not connected`;
      return this.finish(sync, trigger, { status: 'error', reports: [], error });
    }

    const cursors = parseCursors(sync.cursors);
    const key = (provider: string) => `${provider}:history`;
    const reports: SyncReport[] = [];
    try {
      const forward = await runSync(source, target, { dataTypes, preview, since: cursors[key(sync.source)] ?? null });
      reports.push(forward);
      advanceCursor(cursors, key(sync.source), source, forward);

      if (sync.direction === 'two_way') {
        const back = await runSync(target, source, { dataTypes, preview, since: cursors[key(sync.target)] ?? null });
        reports.push(back);
        advanceCursor(cursors, key(sync.target), target, back);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error({ syncId: sync.id, err }, 'Sync run failed');
      return this.finish(sync, trigger, { status: 'error', reports, error });
    }

    const failed = reports.some((r) => r.results.some((x) => x.failed > 0));
    return this.finish(sync, trigger, { status: failed ? 'partial' : 'success', reports }, cursors);
  }

  private async finish(
    sync: Sync,
    trigger: Trigger,
    outcome: RunOutcome,
    cursors?: Record<string, string>,
  ): Promise<RunOutcome> {
    if (trigger === 'preview') return outcome;

    const now = new Date();
    const id = randomUUID();
    await this.db.orm.insert(syncRuns).values({
      id,
      syncId: sync.id,
      userId: sync.userId,
      trigger,
      status: outcome.status,
      report: JSON.stringify(outcome.reports),
      error: outcome.error ?? null,
      finishedAt: now,
    });
    await this.db.orm
      .update(syncs)
      .set({ lastRunAt: now, updatedAt: now, ...(cursors ? { cursors: JSON.stringify(cursors) } : {}) })
      .where(eq(syncs.id, sync.id));

    const [run] = await this.db.orm.select().from(syncRuns).where(eq(syncRuns.id, id)).limit(1);
    return { ...outcome, run };
  }
}
