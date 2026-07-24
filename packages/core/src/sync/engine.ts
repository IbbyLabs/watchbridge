import type {
  DataType,
  MediaRef,
  ProgressEvent,
  ProviderCapabilities,
  ProviderId,
  PushResult,
  RatingEvent,
  WatchEvent,
  WatchlistEvent,
} from '../providers/types.js';
import { createLogger } from '../logger.js';
import { planHistorySync, planProgressSync, planRatingsSync, planWatchlistSync } from './plan.js';
import { itemKey } from './identity.js';
import { includedByFilters, type SyncFilters } from './filters.js';
import { describeProviderError } from '../providers/errors.js';

const log = createLogger('sync');

/** A provider we can read from. */
export interface SyncSource {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  /** `since` is an optional delta cursor (Simkl activities timestamp); ignored by providers that don't page by date. */
  pullHistory(since?: string | null): Promise<WatchEvent[]>;
  pullProgress(): Promise<ProgressEvent[]>;
  /** Present only on providers that expose user ratings (Trakt, Simkl). */
  pullRatings?(): Promise<RatingEvent[]>;
  /** Present only on providers that expose a watchlist (Trakt, Simkl). */
  pullWatchlist?(): Promise<WatchlistEvent[]>;
  /** A newer delta cursor after a pull, if the provider tracks one (Simkl). */
  readonly lastActivityAll?: string;
  /** Set by providers that skip a pull when their cursor says nothing changed. */
  readonly lastPullSkipped?: boolean;
}

/** A provider we can read from and write to. */
export interface SyncTarget extends SyncSource {
  pushHistory(events: WatchEvent[]): Promise<PushResult>;
  pushProgress(events: ProgressEvent[]): Promise<PushResult>;
  /** Present only on providers that accept rating writes (Trakt, Simkl). */
  pushRatings?(events: RatingEvent[]): Promise<PushResult>;
  /** Present only on providers that accept watchlist writes (Trakt, Simkl). */
  pushWatchlist?(events: WatchlistEvent[]): Promise<PushResult>;
  removeWatchlist?(events: WatchlistEvent[]): Promise<PushResult>;
}

export interface DataTypeReport {
  dataType: DataType;
  planned: number;
  added: number;
  skippedPresent: number;
  skippedOther: number;
  unmatched: number;
  notFound: number;
  failed: number;
  /** Watchlist only, and only when removal propagation is switched on. */
  removed?: number;
  /** Set when the pair can't sync this data type (e.g. Simkl progress). */
  note?: string;
}

export interface SyncReport {
  source: ProviderId;
  target: ProviderId;
  preview: boolean;
  results: DataTypeReport[];
  /**
   * History items successfully delivered to the target this run. The caller
   * persists these so future runs treat them as present (convergence memory).
   * Not part of the user-facing report.
   */
  deliveredHistory?: MediaRef[];
  startedAt: string;
  finishedAt: string;
}

export interface RunSyncOptions {
  dataTypes: DataType[];
  /** When true, plan only — nothing is written. */
  preview: boolean;
  /** Delta cursor for the source's history pull (Simkl). */
  since?: string | null;
  /** Items already delivered to the target on prior runs; treated as present. */
  deliveredHistory?: MediaRef[];
  /** Per-sync scope controls; unset means sync everything. */
  filters?: SyncFilters;
  /** For ratings: the provider whose rating wins a conflict. */
  ratingsAuthority?: ProviderId;
  /**
   * For watchlist: also take items off the target when the source no longer
   * lists them. Off by default, because a removal is not reversible from here.
   */
  propagateWatchlistRemovals?: boolean;
  /** Injected clock for deterministic timestamps in tests. */
  now?: () => Date;
}

/**
 * Run a one-directional sync (source → target) for the requested data types.
 * Additive and idempotent: re-running after an apply plans zero operations,
 * because each data type is diffed against the target's current state.
 */
export async function runSync(
  source: SyncSource,
  target: SyncTarget,
  options: RunSyncOptions,
): Promise<SyncReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const results: DataTypeReport[] = [];
  let deliveredHistory: MediaRef[] | undefined;

  // Each data type is isolated. One provider erroring must not discard the work
  // the earlier ones already wrote — in particular the history delivery memory,
  // which the caller can only persist if this function returns.
  for (const dataType of options.dataTypes) {
    try {
      if (dataType === 'history') {
        const { report, delivered } = await runHistory(source, target, options.preview, options.since, options.deliveredHistory, options.filters);
        results.push(report);
        if (delivered.length > 0) deliveredHistory = delivered;
      } else if (dataType === 'progress') {
        results.push(await runProgress(source, target, options.preview, options.filters));
      } else if (dataType === 'ratings') {
        results.push(await runRatings(source, target, options.preview, options.ratingsAuthority, options.filters));
      } else if (dataType === 'watchlist') {
        results.push(
          await runWatchlist(source, target, options.preview, options.propagateWatchlistRemovals === true, options.filters),
        );
      } else {
        results.push(emptyReport(dataType, `${dataType} sync is not implemented yet`));
      }
    } catch (err) {
      log.error({ source: source.id, target: target.id, dataType, err }, 'Data type failed mid-run');
      // Either side can be the one that failed; the target is the likelier
      // culprit for a write, so name it and let the message carry the detail.
      const reason = describeProviderError(target.id, err);
      results.push({ ...emptyReport(dataType, `${dataType} could not be synced. ${reason}`), failed: 1 });
    }
  }

  return { source: source.id, target: target.id, preview: options.preview, results, deliveredHistory, startedAt, finishedAt: now().toISOString() };
}

async function runHistory(
  source: SyncSource,
  target: SyncTarget,
  preview: boolean,
  since?: string | null,
  delivered: MediaRef[] = [],
  filters?: SyncFilters,
): Promise<{ report: DataTypeReport; delivered: MediaRef[] }> {
  // Source pull may use the delta cursor; the target pull always reflects current state.
  const [srcAll, tgt] = await Promise.all([source.pullHistory(since), target.pullHistory()]);
  const src = srcAll.filter((e) => includedByFilters(e.ref, filters));
  const plan = planHistorySync(src, tgt, delivered);
  const report: DataTypeReport = {
    dataType: 'history',
    planned: plan.toAdd.length,
    added: 0,
    skippedPresent: plan.skippedPresent,
    skippedOther: plan.skippedDuplicate,
    unmatched: plan.unmatched.length,
    notFound: 0,
    failed: 0,
  };
  // An empty plan means something different when the source never looked.
  if (source.lastPullSkipped === true) {
    report.note = `${source.id} reported no changes since the last run, so its history was not re-read`;
  }
  report.note ??= shapeWarning(source.id, 'history', src.length, plan.unmatched.length);
  let deliveredNow: MediaRef[] = [];
  if (!preview && plan.toAdd.length > 0) {
    const res = await target.pushHistory(plan.toAdd);
    applyPush(report, res);
    // A push that didn't throw reached the target. Remember these so the next
    // run treats them as present — targets that accept a write but don't echo it
    // back (provider id/structure mismatch) would otherwise re-send every run.
    // Anything the target explicitly rejected is left out: recording it would
    // mark it present forever even though it never landed.
    if (res.failed === 0) {
      // Match on identity key, not object identity: a provider may hand back
      // reconstructed refs rather than the exact objects it was given.
      const rejected = new Set((res.notFoundRefs ?? []).map(itemKey).filter((k): k is string => k !== null));
      deliveredNow = plan.toAdd
        .map((e) => e.ref)
        .filter((ref) => {
          const key = itemKey(ref);
          return key === null || !rejected.has(key);
        });
    }
  }
  log.info({ source: source.id, target: target.id, preview, ...report }, 'history planned');
  return { report, delivered: deliveredNow };
}

async function runProgress(source: SyncSource, target: SyncTarget, preview: boolean, filters?: SyncFilters): Promise<DataTypeReport> {
  if (!source.capabilities().progress) {
    return emptyReport('progress', `${source.id} does not expose playback progress`);
  }
  const [srcAll, tgt] = await Promise.all([source.pullProgress(), target.pullProgress()]);
  const src = srcAll.filter((e) => includedByFilters(e.ref, filters));
  const plan = planProgressSync(src, tgt);
  const report: DataTypeReport = {
    dataType: 'progress',
    planned: plan.toAdd.length,
    added: 0,
    skippedPresent: plan.skippedUnchanged,
    skippedOther: plan.skippedDuplicate,
    unmatched: plan.unmatched.length,
    notFound: 0,
    failed: 0,
  };
  report.note ??= shapeWarning(source.id, 'progress', src.length, plan.unmatched.length);
  if (!preview && plan.toAdd.length > 0) {
    const res = await target.pushProgress(plan.toAdd);
    applyPush(report, res);
  }
  return report;
}

async function runRatings(
  source: SyncSource,
  target: SyncTarget,
  preview: boolean,
  ratingsAuthority: ProviderId | undefined,
  filters?: SyncFilters,
): Promise<DataTypeReport> {
  if (!source.capabilities().ratings || !source.pullRatings) {
    return emptyReport('ratings', `${source.id} does not expose ratings`);
  }
  if (!target.capabilities().ratings || !target.pushRatings || !target.pullRatings) {
    return emptyReport('ratings', `${target.id} does not accept ratings`);
  }
  const [srcAll, tgt] = await Promise.all([source.pullRatings(), target.pullRatings()]);
  const src = srcAll.filter((e) => includedByFilters(e.ref, filters));
  // No authority set means the source may only fill gaps, never overwrite.
  const sourceIsAuthoritative = ratingsAuthority === source.id;
  const plan = planRatingsSync(src, tgt, { sourceIsAuthoritative });
  const report: DataTypeReport = {
    dataType: 'ratings',
    planned: plan.toApply.length,
    added: 0,
    skippedPresent: plan.skippedUnchanged,
    skippedOther: plan.skippedDuplicate,
    unmatched: plan.unmatched.length,
    notFound: 0,
    failed: 0,
  };
  report.note ??= shapeWarning(source.id, 'ratings', src.length, plan.unmatched.length);
  if (!preview && plan.toApply.length > 0) {
    const res = await target.pushRatings(plan.toApply);
    applyPush(report, res);
  }
  return report;
}

async function runWatchlist(
  source: SyncSource,
  target: SyncTarget,
  preview: boolean,
  propagateRemovals: boolean,
  filters?: SyncFilters,
): Promise<DataTypeReport> {
  if (!source.capabilities().watchlist || !source.pullWatchlist) {
    return emptyReport('watchlist', `${source.id} does not expose a watchlist`);
  }
  if (!target.capabilities().watchlist || !target.pushWatchlist || !target.pullWatchlist) {
    return emptyReport('watchlist', `${target.id} does not accept watchlist changes`);
  }
  // Removals are only planned when the target can actually carry them out.
  const canRemove = propagateRemovals && Boolean(target.removeWatchlist);

  const [srcAll, tgt] = await Promise.all([source.pullWatchlist(), target.pullWatchlist()]);
  const src = srcAll.filter((e) => includedByFilters(e.ref, filters));
  const plan = planWatchlistSync(src, tgt, { propagateRemovals: canRemove });
  const report: DataTypeReport = {
    dataType: 'watchlist',
    planned: plan.toAdd.length + plan.toRemove.length,
    added: 0,
    skippedPresent: plan.skippedPresent,
    skippedOther: plan.skippedDuplicate,
    unmatched: plan.unmatched.length,
    notFound: 0,
    failed: 0,
    ...(canRemove ? { removed: 0 } : {}),
  };
  if (propagateRemovals && !canRemove) {
    report.note = `${target.id} cannot remove watchlist items, so only additions were applied`;
  }
  report.note ??= shapeWarning(source.id, 'watchlist', src.length, plan.unmatched.length);

  if (!preview && plan.toAdd.length > 0) {
    applyPush(report, await target.pushWatchlist(plan.toAdd));
  }
  if (!preview && canRemove && plan.toRemove.length > 0) {
    const res = await target.removeWatchlist!(plan.toRemove);
    report.removed = res.added;
    report.notFound += res.notFound;
    report.failed += res.failed;
    if (res.note) report.note = res.note;
  }
  return report;
}

/**
 * Items come back but none of them carry a usable id.
 *
 * A provider renaming or re-nesting its id block reads exactly like this: the
 * request succeeds, the rows are there, and every one of them is unusable. The
 * sync then quietly plans nothing while looking healthy. A handful of genuinely
 * id-less items is normal, so this only fires when the whole batch is unusable
 * and the batch is big enough for that to mean something.
 */
const SHAPE_CANARY_MIN = 5;

function shapeWarning(
  provider: ProviderId,
  dataType: DataType,
  pulled: number,
  unmatched: number,
): string | undefined {
  if (pulled < SHAPE_CANARY_MIN || unmatched !== pulled) return undefined;
  log.warn({ provider, dataType, pulled }, 'Every item pulled lacked a usable id; the response shape may have changed');
  return `${provider} returned ${pulled} ${dataType} items and none carried an id Watchbridge could use. Their API may have changed.`;
}

function applyPush(report: DataTypeReport, res: PushResult): void {
  report.added = res.added;
  report.notFound += res.notFound;
  report.failed += res.failed;
  if (res.note) report.note = res.note;
}

function emptyReport(dataType: DataType, note: string): DataTypeReport {
  return { dataType, planned: 0, added: 0, skippedPresent: 0, skippedOther: 0, unmatched: 0, notFound: 0, failed: 0, note };
}
