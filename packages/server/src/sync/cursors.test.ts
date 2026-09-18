import { describe, expect, it } from 'vitest';
import type { SyncReport } from '@watchbridge/core';
import { advanceCursors, advanceRemoved, noteRemovals } from './runner.js';

const report = (failed: Partial<Record<'history' | 'progress' | 'ratings' | 'watchlist', number>> = {}): SyncReport =>
  ({
    source: 'simkl',
    target: 'trakt',
    preview: false,
    startedAt: 't0',
    finishedAt: 't1',
    results: (['history', 'progress', 'ratings', 'watchlist'] as const).map((dataType) => ({
      dataType,
      planned: 0,
      added: 0,
      skippedPresent: 0,
      skippedOther: 0,
      unmatched: 0,
      notFound: 0,
      failed: failed[dataType] ?? 0,
    })),
  }) as SyncReport;

describe('advanceCursors', () => {
  it('advances every surface when nothing failed', () => {
    const cursors: Record<string, string> = {};
    advanceCursors(
      cursors,
      'simkl',
      { lastActivityAll: 'H2', lastProgressActivity: 'P2', lastRatingsActivity: 'R2', lastWatchlistActivity: 'W2' },
      report(),
    );
    expect(cursors).toEqual({
      'simkl:history': 'H2',
      'simkl:progress': 'P2',
      'simkl:ratings': 'R2',
      'simkl:watchlist': 'W2',
    });
  });

  it('does not advance a surface whose push failed', () => {
    const cursors: Record<string, string> = {};
    advanceCursors(
      cursors,
      'simkl',
      { lastActivityAll: 'H2', lastProgressActivity: 'P2', lastRatingsActivity: 'R2', lastWatchlistActivity: 'W2' },
      report({ history: 1 }),
    );
    expect(cursors['simkl:history']).toBeUndefined();
    expect(cursors['simkl:progress']).toBe('P2');
  });

  it('leaves a surface alone when the source exposes no cursor', () => {
    const cursors: Record<string, string> = {};
    advanceCursors(cursors, 'trakt', { lastActivityAll: undefined }, report());
    expect(cursors).toEqual({});
  });
});

describe('advanceRemoved', () => {
  it('records the removal cursor when history reconciled cleanly', () => {
    const cursors: Record<string, string> = {};
    advanceRemoved(cursors, 'simkl', { lastRemovedActivity: 'R2' }, report());
    expect(cursors['simkl:removed']).toBe('R2');
  });

  it('does not advance the removal cursor when history failed', () => {
    const cursors: Record<string, string> = {};
    advanceRemoved(cursors, 'simkl', { lastRemovedActivity: 'R2' }, report({ history: 1 }));
    expect(cursors['simkl:removed']).toBeUndefined();
  });
});

describe('noteRemovals', () => {
  it('notes removals when removed_from_list moved against the saved cursor', () => {
    const cursors: Record<string, string> = { 'simkl:removed': 'R1' };
    const r = report();
    noteRemovals(cursors, 'simkl', { lastRemovedActivity: 'R2' }, r);
    expect(r.results[0]!.note).toMatch(/removed items/);
  });

  it('stays quiet on the first run (no baseline)', () => {
    const r = report();
    noteRemovals({}, 'simkl', { lastRemovedActivity: 'R1' }, r);
    expect(r.results[0]!.note).toBeUndefined();
  });

  it('stays quiet when nothing moved', () => {
    const cursors: Record<string, string> = { 'simkl:removed': 'R1' };
    const r = report();
    noteRemovals(cursors, 'simkl', { lastRemovedActivity: 'R1' }, r);
    expect(r.results[0]!.note).toBeUndefined();
  });
});
