import type {
  DataType,
  ProgressEvent,
  ProviderCapabilities,
  ProviderId,
  PushResult,
  WatchEvent,
} from '../providers/types.js';
import { createLogger } from '../logger.js';
import { planHistorySync, planProgressSync } from './plan.js';

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
  startedAt: string;
  finishedAt: string;
}

export interface RunSyncOptions {
  dataTypes: DataType[];
  /** When true, plan only — nothing is written. */
  preview: boolean;
  /** Delta cursor for the source's history pull (Simkl). */
  since?: string | null;
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

  for (const dataType of options.dataTypes) {
    if (dataType === 'history') {
      results.push(await runHistory(source, target, options.preview, options.since));
    } else if (dataType === 'progress') {
      results.push(await runProgress(source, target, options.preview));
    } else {
      results.push(emptyReport(dataType, `${dataType} sync is not implemented yet`));
    }
  }

  return { source: source.id, target: target.id, preview: options.preview, results, startedAt, finishedAt: now().toISOString() };
}

async function runHistory(
  source: SyncSource,
  target: SyncTarget,
  preview: boolean,
  since?: string | null,
): Promise<DataTypeReport> {
  // Source pull may use the delta cursor; the target pull always reflects current state.
  const [src, tgt] = await Promise.all([source.pullHistory(since), target.pullHistory()]);
  const plan = planHistorySync(src, tgt);
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
  if (!preview && plan.toAdd.length > 0) {
    const res = await target.pushHistory(plan.toAdd);
    applyPush(report, res);
  }
  log.info({ source: source.id, target: target.id, preview, ...report }, 'history planned');
  return report;
}

async function runProgress(source: SyncSource, target: SyncTarget, preview: boolean): Promise<DataTypeReport> {
  if (!source.capabilities().progress) {
    return emptyReport('progress', `${source.id} does not expose playback progress`);
  }
  const [src, tgt] = await Promise.all([source.pullProgress(), target.pullProgress()]);
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
