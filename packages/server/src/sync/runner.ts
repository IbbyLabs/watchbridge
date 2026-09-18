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
import { syncs, syncRuns, users, type Sync, type SyncRun } from '../db/schema.js';
import type { ConnectionService } from '../connections/service.js';
import type { Mailer } from '../mail/mailer.js';
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

/** Requests a source reports spending, for providers that count them. */
export function readRequestCount(source: unknown): number | undefined {
  const n = (source as { lastPullRequests?: unknown })?.lastPullRequests;
  return typeof n === 'number' ? n : undefined;
}

/**
 * Advance per-surface delta cursors only when the surface exposes a newer one
 * AND that surface's push had no failures — a transient error must never skip
 * items on the next run.
 */
export function advanceCursors(
  cursors: Record<string, string>,
  provider: string,
  source: {
    lastActivityAll?: string;
    lastProgressActivity?: string;
    lastRatingsActivity?: string;
    lastWatchlistActivity?: string;
  },
  report: SyncReport,
): void {
  const advance = (dataType: DataType, value: string | undefined): void => {
    if (value === undefined) return;
    const failed = report.results.find((r) => r.dataType === dataType)?.failed ?? 0;
    if (failed === 0) cursors[`${provider}:${dataType}`] = value;
  };
  advance('history', source.lastActivityAll);
  advance('progress', source.lastProgressActivity);
  advance('ratings', source.lastRatingsActivity);
  advance('watchlist', source.lastWatchlistActivity);
}

/**
 * Surface items Simkl removed from its library (`removed_from_list` moved) when
 * removal propagation is OFF. The drift must be visible, not silent.
 */
export function noteRemovals(
  cursors: Record<string, string>,
  provider: string,
  source: { lastRemovedActivity?: string },
  report: SyncReport,
): void {
  const latest = source.lastRemovedActivity;
  if (typeof latest !== 'string') return;
  const key = `${provider}:removed`;
  const previous = cursors[key];
  if (previous !== undefined && latest !== previous) {
    const note = `${provider} removed items from its library since the last run. Watchbridge does not remove them from the target — they will stay on the other side.`;
    const result = report.results.find((r) => r.dataType === 'history') ?? report.results[0];
    if (result) result.note = result.note ? `${result.note} ${note}` : note;
  }
}

/**
 * Advance the removal cursor only when the history surface reconciled cleanly
 * (no failures) — otherwise the next run re-detects the same deletions.
 */
export function advanceRemoved(
  cursors: Record<string, string>,
  provider: string,
  source: { lastRemovedActivity?: string },
  report: SyncReport,
): void {
  const latest = source.lastRemovedActivity;
  if (typeof latest !== 'string') return;
  const failed = report.results.find((r) => r.dataType === 'history')?.failed ?? 0;
  if (failed === 0) cursors[`${provider}:removed`] = latest;
}

/** Executes a sync configuration by wiring connected clients into the engine. */
export class SyncRunner {
  private readonly deliveries: DeliveriesStore;
  /** In-memory daily sync-alert budget (single-process, like the rate limiter). */
  private readonly alertBudget = { day: '', sent: 0 };

  constructor(
    private readonly db: Db,
    private readonly connections: ConnectionService,
    /** Hours between forced full re-reads that ignore the delta cursor. 0 disables it. */
    private readonly reconcileIntervalHours = 168,
    /** Optional alerting. When set, a scheduled run emails the owner on the first
     *  failure and again on recovery — transitions only, never per-error. */
    private readonly alerts?: { mailer: Mailer; appUrl: string; maxEmailsPerDay?: number },
  ) {
    this.deliveries = new DeliveriesStore(db);
  }

  /**
   * Whether this run should ignore the delta cursor and re-read everything. A
   * Simkl cursor can silently stop advancing (an activities read failing, or the
   * account being reconnected), and a delta pull against a stuck cursor keeps
   * skipping the same window forever. A periodic full read heals that on its own.
   */
  private dueForFullReconcile(sync: Sync, now: Date): boolean {
    if (this.reconcileIntervalHours <= 0) return false;
    const last = sync.lastFullReconcileAt?.getTime();
    if (last === undefined) return true;
    return now.getTime() - last >= this.reconcileIntervalHours * 3_600_000;
  }

  /** Plan only — nothing is written, nothing is persisted. */
  preview(sync: Sync): Promise<RunOutcome> {
    return this.execute(sync, 'preview');
  }

  /** Persist what a run delivered to (and removed from) a target's ledger. */
  private async persistDeliveries(sync: Sync, target: string, report: SyncReport): Promise<void> {
    if (report.deliveredHistory?.length) {
      await this.deliveries.record(sync.id, sync.userId, target, report.deliveredHistory);
    }
    if (report.deliveredWatchlist?.length) {
      await this.deliveries.record(sync.id, sync.userId, target, report.deliveredWatchlist, 'watchlist');
    }
    // Removed watchlist items leave the ledger so they can be delivered again if
    // they later return to the source.
    if (report.removedWatchlist?.length) {
      await this.deliveries.forget(sync.id, target, report.removedWatchlist, 'watchlist');
    }
    // Removed history items leave the ledger for the same reason (opt-in).
    if (report.removedHistory?.length) {
      await this.deliveries.forget(sync.id, target, report.removedHistory);
    }
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
    // A preview should not consume the reconciliation window; only a real run does.
    const fullReconcile = !preview && this.dueForFullReconcile(sync, startedAt);
    const ratingsAuthority = (sync.ratingsAuthority as ProviderId | null) ?? undefined;
    // Never on a two-way sync: the forward pass would delete an item the user
    // had just added on the other side, before the return pass could carry it over.
    const propagateWatchlistRemovals =
      sync.propagateWatchlistRemovals === true && sync.direction !== 'two_way';
    const propagateHistoryRemovals =
      sync.propagateHistoryRemovals === true && sync.direction !== 'two_way';
    const key = (provider: string, dataType: DataType) => `${provider}:${dataType}`;
    const removedCursor = (provider: string) => cursors[`${provider}:removed`] ?? null;
    const reports: SyncReport[] = [];
    const forwardDelivered = await this.deliveries.load(sync.id, sync.target);
    const forwardWatchlist = await this.deliveries.load(sync.id, sync.target, 'watchlist');
    // What the correctness machinery actually had to work with this run. A guard
    // reading an empty or missing input is indistinguishable from a guard that is
    // simply not needed, and stays "disabled" without anyone noticing.
    const guards = {
      deliveryMemory: forwardDelivered.length,
      cursor: cursors[key(sync.source, 'history')] ? 'saved' : 'none',
      filters: filters ? 'applied' : 'none',
      watchlistRemovals: propagateWatchlistRemovals ? 'on' : 'off',
      historyRemovals: propagateHistoryRemovals ? 'on' : 'off',
      read: fullReconcile ? 'full' : 'delta',
      // What the source's history pull cost in requests. Rate limits are per
      // application credential, so this is the number a cursor reduces and the
      // only way to tell afterwards whether it did.
      sourceRequests: readRequestCount(source),
    };
    try {
      const forward = await runSync(source, target, {
        dataTypes,
        preview,
        filters,
        ratingsAuthority,
        propagateWatchlistRemovals,
        propagateHistoryRemovals,
        // On a reconciliation run, drop the cursors so the source re-reads everything.
        since: fullReconcile ? null : (cursors[key(sync.source, 'history')] ?? null),
        sinceProgress: fullReconcile ? null : (cursors[key(sync.source, 'progress')] ?? null),
        sinceRatings: fullReconcile ? null : (cursors[key(sync.source, 'ratings')] ?? null),
        sinceWatchlist: fullReconcile ? null : (cursors[key(sync.source, 'watchlist')] ?? null),
        removedSince: removedCursor(sync.source),
        deliveredHistory: forwardDelivered,
        deliveredWatchlist: forwardWatchlist,
      });
      reports.push(forward);
      advanceCursors(cursors, sync.source, source, forward);
      if (!preview) {
        if (propagateHistoryRemovals) {
          advanceRemoved(cursors, sync.source, source, forward);
        } else {
          noteRemovals(cursors, sync.source, source, forward);
          advanceRemoved(cursors, sync.source, source, forward);
        }
        await this.persistDeliveries(sync, sync.target, forward);
      }

      if (sync.direction === 'two_way') {
        const back = await runSync(target, source, {
          dataTypes,
          preview,
          filters,
          ratingsAuthority,
          propagateWatchlistRemovals,
          propagateHistoryRemovals,
          since: fullReconcile ? null : (cursors[key(sync.target, 'history')] ?? null),
          sinceProgress: fullReconcile ? null : (cursors[key(sync.target, 'progress')] ?? null),
          sinceRatings: fullReconcile ? null : (cursors[key(sync.target, 'ratings')] ?? null),
          sinceWatchlist: fullReconcile ? null : (cursors[key(sync.target, 'watchlist')] ?? null),
          removedSince: removedCursor(sync.target),
          deliveredHistory: await this.deliveries.load(sync.id, sync.source),
          deliveredWatchlist: await this.deliveries.load(sync.id, sync.source, 'watchlist'),
        });
        reports.push(back);
        advanceCursors(cursors, sync.target, target, back);
        if (!preview) {
          if (propagateHistoryRemovals) {
            advanceRemoved(cursors, sync.target, target, back);
          } else {
            noteRemovals(cursors, sync.target, target, back);
            advanceRemoved(cursors, sync.target, target, back);
          }
          await this.persistDeliveries(sync, sync.source, back);
        }
      }
    } catch (err) {
      // Stored on the run and shown to the user, so it has to read as a sentence
      // rather than a status code.
      const error = describeProviderError(sync.target as ProviderId, err);
      log.error({ syncId: sync.id, err }, 'Sync run failed');
      return this.finish(sync, trigger, { status: 'error', reports, error }, startedAt, undefined, guards);
    }

    const failed = reports.some((r) => r.results.some((x) => x.failed > 0));
    const status = failed ? 'partial' : 'success';
    // Only count the reconciliation as done when the read actually succeeded, so a
    // failed full read is retried next run rather than deferred a whole interval.
    const reconciledAt = fullReconcile && status === 'success' ? startedAt : undefined;
    return this.finish(sync, trigger, { status, reports }, startedAt, cursors, guards, reconciledAt);
  }

  private async finish(
    sync: Sync,
    trigger: Trigger,
    outcome: RunOutcome,
    startedAt: Date,
    cursors?: Record<string, string>,
    guards?: Record<string, unknown>,
    reconciledAt?: Date,
  ): Promise<RunOutcome> {
    if (trigger === 'preview') return outcome;

    // The delivery/removal ref lists are convergence bookkeeping, not part of the
    // user-facing report — drop them from what's stored and returned.
    outcome = {
      ...outcome,
      reports: outcome.reports.map(
        ({ deliveredHistory: _d, deliveredWatchlist: _w, removedWatchlist: _r, removedHistory: _h, ...r }) => r,
      ),
    };

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
        ...(reconciledAt ? { lastFullReconcileAt: reconciledAt } : {}),
      })
      .where(eq(syncs.id, sync.id));

    this.logRun(sync, trigger, outcome, now.getTime() - startedAt.getTime(), guards);
    await this.maybeAlert(sync, trigger, outcome);

    const [run] = await this.db.orm.select().from(syncRuns).where(eq(syncRuns.id, id)).limit(1);
    return { ...outcome, run };
  }

  /**
   * Email the owner when a scheduled sync crosses between working and failing.
   *
   * Only transitions are sent: the first failure after a good run, and the first
   * success after a failure. A sync that stays broken emails once, not every
   * hour. Manual runs never alert — the user is already watching. A mail failure
   * is logged and swallowed so it can never break the run itself.
   */
  private async maybeAlert(sync: Sync, trigger: Trigger, outcome: RunOutcome): Promise<void> {
    if (!this.alerts || trigger !== 'scheduled') return;
    const wasFailing = sync.lastRunStatus === 'error' || sync.lastRunStatus === 'partial';
    const isFailing = outcome.status === 'error' || outcome.status === 'partial';

    if (isFailing === wasFailing) return; // no transition, stay quiet

    const [owner] = await this.db.orm
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, sync.userId))
      .limit(1);
    if (!owner?.email) return;
    const syncsUrl = `${this.alerts.appUrl}/syncs`;

    if (!this.allowAlertEmail()) {
      log.warn({ syncId: sync.id }, 'Sync alert suppressed — daily email budget exhausted');
      return;
    }

    try {
      if (isFailing) {
        await this.alerts.mailer.sendSyncFailureEmail(owner.email, {
          syncName: sync.name,
          reason: this.alertReason(outcome),
          syncsUrl,
        });
      } else {
        await this.alerts.mailer.sendSyncRecoveryEmail(owner.email, { syncName: sync.name, syncsUrl });
      }
    } catch (err) {
      log.error({ syncId: sync.id, err }, 'Could not send the sync alert email');
    }
  }

  /** True while the daily sync-alert email budget still has room. */
  private allowAlertEmail(): boolean {
    const max = this.alerts?.maxEmailsPerDay ?? 0;
    if (max <= 0) return true; // unset/0 = no cap

    const day = new Date().toISOString().slice(0, 10); // UTC calendar day
    if (this.alertBudget.day !== day) {
      this.alertBudget.day = day;
      this.alertBudget.sent = 0;
    }
    if (this.alertBudget.sent >= max) return false;
    this.alertBudget.sent += 1;
    return true;
  }

  /** A short, credential-free reason from the outcome for the alert body. */
  private alertReason(outcome: RunOutcome): string {
    if (outcome.error) return outcome.error;
    for (const report of outcome.reports) {
      const failed = report.results.find((r) => r.failed > 0 && r.note);
      if (failed?.note) return failed.note;
    }
    return 'One or more data types did not complete.';
  }

  /**
   * One structured line per run. Without it a working instance is silent, so
   * there is no way to tell from the outside whether syncs are running at all.
   */
  private logRun(
    sync: Sync,
    trigger: Trigger,
    outcome: RunOutcome,
    durationMs: number,
    guards?: Record<string, unknown>,
  ): void {
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
      ...(guards ? { guards } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    };

    const message = 'Sync run finished';
    if (outcome.status === 'error') log.error(fields, message);
    else if (outcome.status === 'partial') log.warn(fields, message);
    else log.info(fields, message);
  }
}
