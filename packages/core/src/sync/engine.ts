import type {
  DataType,
  MediaRef,
  ProgressEvent,
  ProviderCapabilities,
  ProviderId,
  PushResult,
  WatchEvent,
} from '../providers/types.js';
import { createLogger } from '../logger.js';
import { planHistorySync, planProgressSync } from './plan.js';
import { itemKey } from './identity.js';
import { includedByFilters, type SyncFilters } from './filters.js';

const log = createLogger('sync');

/** A provider we can read from. */
export interface SyncSource {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  /** `since` is an optional delta cursor (Simkl activities timestamp); ignored by providers that don't page by date. */
  pullHistory(since?: string | null): Promise<WatchEvent[]>;
  pullProgress(): Promise<ProgressEvent[]>;
  /** A newer delta cursor after a pull, if the provider tracks one (Simkl). */
  readonly lastActivityAll?: string;
}

/** A provider we can read from and write to. */
export interface SyncTarget extends SyncSource {
  pushHistory(events: WatchEvent[]): Promise<PushResult>;
  pushProgress(events: ProgressEvent[]): Promise<PushResult>;
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

  for (const dataType of options.dataTypes) {
    if (dataType === 'history') {
      const { report, delivered } = await runHistory(source, target, options.preview, options.since, options.deliveredHistory, options.filters);
      results.push(report);
      if (delivered.length > 0) deliveredHistory = delivered;
    } else if (dataType === 'progress') {
      results.push(await runProgress(source, target, options.preview, options.filters));
    } else {
      results.push(emptyReport(dataType, `${dataType} sync is not implemented yet`));
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
  if (!preview && plan.toAdd.length > 0) {
    const res = await target.pushProgress(plan.toAdd);
    applyPush(report, res);
  }
  return report;
}

function applyPush(report: DataTypeReport, res: PushResult): void {
  report.added = res.added;
  report.notFound += res.notFound;
  report.failed += res.failed;
}

function emptyReport(dataType: DataType, note: string): DataTypeReport {
  return { dataType, planned: 0, added: 0, skippedPresent: 0, skippedOther: 0, unmatched: 0, notFound: 0, failed: 0, note };
}
