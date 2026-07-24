import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  runSync,
  createLogger,
  describeProviderError,
  type DataType,
  type ProviderId,
  type SyncFilters,
  type SyncReport,
} from '@watchbridge/core';
import type { Db } from '../db/client.js';
import { syncs, syncRuns, type Sync, type SyncRun } from '../db/schema.js';
import type { ConnectionService } from '../connections/service.js';
import { DeliveriesStore } from './deliveries.js';

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
    if (Array.isArray(arr))
      return arr.filter((x): x is DataType => x === 'history' || x === 'progress' || x === 'ratings' || x === 'watchlist');
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

function parseFilters(raw: string | null): SyncFilters | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as unknown;
    return obj && typeof obj === 'object' ? (obj as SyncFilters) : undefined;
  } catch {
    return undefined;
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
  private readonly deliveries: DeliveriesStore;

  constructor(
    private readonly db: Db,
    private readonly connections: ConnectionService,
  ) {
    this.deliveries = new DeliveriesStore(db);
  }

  /** Plan only — nothing is written, nothing is persisted. */
  preview(sync: Sync): Promise<RunOutcome> {
    return this.execute(sync, 'preview');
  }

  async execute(sync: Sync, trigger: Trigger): Promise<RunOutcome> {
    const preview = trigger === 'preview';
    const startedAt = new Date();
    const dataTypes = parseDataTypes(sync.dataTypes);

    const [source, target] = await Promise.all([
      this.connections.clientFor(sync.userId, sync.source as ProviderId),
      this.connections.clientFor(sync.userId, sync.target as ProviderId),
    ]);

    if (!source || !target) {
      const error = `Missing connection: ${!source ? sync.source : sync.target} is not connected`;
      return this.finish(sync, trigger, { status: 'error', reports: [], error }, startedAt);
    }

    const cursors = parseCursors(sync.cursors);
    const filters = parseFilters(sync.filters);
    const ratingsAuthority = (sync.ratingsAuthority as ProviderId | null) ?? undefined;
    // Never on a two-way sync: the forward pass would delete an item the user
    // had just added on the other side, before the return pass could carry it over.
    const propagateWatchlistRemovals =
      sync.propagateWatchlistRemovals === true && sync.direction !== 'two_way';
    const key = (provider: string) => `${provider}:history`;
    const reports: SyncReport[] = [];
    try {
      const forward = await runSync(source, target, {
        dataTypes,
        preview,
        filters,
        ratingsAuthority,
        propagateWatchlistRemovals,
        since: cursors[key(sync.source)] ?? null,
        deliveredHistory: await this.deliveries.load(sync.id, sync.target),
      });
      reports.push(forward);
      advanceCursor(cursors, key(sync.source), source, forward);
      if (!preview && forward.deliveredHistory?.length) {
        await this.deliveries.record(sync.id, sync.userId, sync.target, forward.deliveredHistory);
      }

      if (sync.direction === 'two_way') {
        const back = await runSync(target, source, {
          dataTypes,
          preview,
          filters,
          ratingsAuthority,
          propagateWatchlistRemovals,
          since: cursors[key(sync.target)] ?? null,
          deliveredHistory: await this.deliveries.load(sync.id, sync.source),
        });
        reports.push(back);
        advanceCursor(cursors, key(sync.target), target, back);
        if (!preview && back.deliveredHistory?.length) {
          await this.deliveries.record(sync.id, sync.userId, sync.source, back.deliveredHistory);
        }
      }
    } catch (err) {
      // Stored on the run and shown to the user, so it has to read as a sentence
      // rather than a status code.
      const error = describeProviderError(sync.target as ProviderId, err);
      log.error({ syncId: sync.id, err }, 'Sync run failed');
      return this.finish(sync, trigger, { status: 'error', reports, error }, startedAt);
    }

    const failed = reports.some((r) => r.results.some((x) => x.failed > 0));
    return this.finish(sync, trigger, { status: failed ? 'partial' : 'success', reports }, startedAt, cursors);
  }

  private async finish(
    sync: Sync,
    trigger: Trigger,
    outcome: RunOutcome,
    startedAt: Date,
    cursors?: Record<string, string>,
  ): Promise<RunOutcome> {
    if (trigger === 'preview') return outcome;

    // deliveredHistory is convergence bookkeeping, not part of the user-facing
    // report — drop it from what's stored and returned.
    outcome = { ...outcome, reports: outcome.reports.map(({ deliveredHistory: _d, ...r }) => r) };

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
      startedAt,
      finishedAt: now,
    });
    await this.db.orm
      .update(syncs)
      .set({
        lastRunAt: now,
        lastRunStatus: outcome.status,
        updatedAt: now,
        ...(cursors ? { cursors: JSON.stringify(cursors) } : {}),
      })
      .where(eq(syncs.id, sync.id));

    this.logRun(sync, trigger, outcome, now.getTime() - startedAt.getTime());

    const [run] = await this.db.orm.select().from(syncRuns).where(eq(syncRuns.id, id)).limit(1);
    return { ...outcome, run };
  }

  /**
   * One structured line per run. Without it a working instance is silent, so
   * there is no way to tell from the outside whether syncs are running at all.
   */
  private logRun(sync: Sync, trigger: Trigger, outcome: RunOutcome, durationMs: number): void {
    const fields = {
      syncId: sync.id,
      name: sync.name,
      source: sync.source,
      target: sync.target,
      direction: sync.direction,
      trigger,
      status: outcome.status,
      durationMs,
      directions: outcome.reports.map((r) => ({
        source: r.source,
        target: r.target,
        results: r.results.map((x) => ({
          dataType: x.dataType,
          planned: x.planned,
          added: x.added,
          ...(x.removed !== undefined ? { removed: x.removed } : {}),
          skippedPresent: x.skippedPresent,
          notFound: x.notFound,
          failed: x.failed,
          ...(x.note ? { note: x.note } : {}),
        })),
      })),
      ...(outcome.error ? { error: outcome.error } : {}),
    };

    const message = 'Sync run finished';
    if (outcome.status === 'error') log.error(fields, message);
    else if (outcome.status === 'partial') log.warn(fields, message);
    else log.info(fields, message);
  }
}
