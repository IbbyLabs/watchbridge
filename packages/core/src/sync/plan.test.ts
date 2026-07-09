import { describe, expect, it } from 'vitest';
import { planHistorySync, planProgressSync } from './plan.js';
import type { ProgressEvent, WatchEvent } from '../providers/types.js';

const movie = (tmdb: number, extra: Record<string, unknown> = {}, watchedAt: string | null = '2021-01-01T00:00:00Z'): WatchEvent => ({
  ref: { kind: 'movie', ids: { tmdb, ...extra } },
  watchedAt,
});
const episode = (showTmdb: number, season: number, number: number, watchedAt: string | null = null): WatchEvent => ({
  ref: { kind: 'episode', ids: { tmdb: showTmdb }, season, number },
  watchedAt,
});

describe('planHistorySync', () => {
  it('adds items the target does not have', () => {
    const plan = planHistorySync([movie(550), movie(551)], [movie(550)]);
    expect(plan.toAdd.map((e) => e.ref.ids.tmdb)).toEqual([551]);
    expect(plan.skippedPresent).toBe(1);
  });

  it('is idempotent: re-planning after applying yields zero operations', () => {
    const source = [movie(550), movie(551), episode(1399, 1, 1)];
    const target: WatchEvent[] = [];
    const first = planHistorySync(source, target);
    // Simulate applying the plan to the target, then re-plan.
    const appliedTarget = [...target, ...first.toAdd];
    const second = planHistorySync(source, appliedTarget);
    expect(first.toAdd).toHaveLength(3);
    expect(second.toAdd).toHaveLength(0);
  });

  it('never adds a duplicate play (matches by item, ignores differing timestamps)', () => {
    // Source watched the same movie twice at different times; target already has it.
    const source = [movie(550, {}, '2021-01-01T00:00:00Z'), movie(550, {}, '2022-06-06T00:00:00Z')];
    const plan = planHistorySync(source, [movie(550, {}, '2019-01-01T00:00:00Z')]);
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.skippedDuplicate + plan.skippedPresent).toBe(2);
  });

  it('matches across providers when IDs differ (imdb in source, tmdb in target)', () => {
    const source: WatchEvent[] = [{ ref: { kind: 'movie', ids: { imdb: 'tt0137523', tmdb: 550 } }, watchedAt: null }];
    const target: WatchEvent[] = [{ ref: { kind: 'movie', ids: { imdb: 'tt0137523' } }, watchedAt: null }];
    const plan = planHistorySync(source, target);
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.skippedPresent).toBe(1);
  });

  it('distinguishes a movie from a show that share a tmdb number', () => {
    const source: WatchEvent[] = [{ ref: { kind: 'movie', ids: { tmdb: 1399 } }, watchedAt: null }];
    const target: WatchEvent[] = [episode(1399, 1, 1)];
    const plan = planHistorySync(source, target);
    // The movie is NOT considered present just because a show has tmdb 1399.
    expect(plan.toAdd).toHaveLength(1);
  });

  it('matches episodes by show id + season + number', () => {
    const plan = planHistorySync([episode(1399, 1, 1), episode(1399, 1, 2)], [episode(1399, 1, 1)]);
    expect(plan.toAdd).toEqual([expect.objectContaining({ ref: expect.objectContaining({ season: 1, number: 2 }) })]);
  });

  it('parks items with no usable id as unmatched, never guessing', () => {
    const source: WatchEvent[] = [{ ref: { kind: 'movie', ids: {}, title: 'Some Movie' }, watchedAt: null }];
    const plan = planHistorySync(source, []);
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.unmatched).toHaveLength(1);
  });

  it('collapses duplicate source items into a single add', () => {
    const plan = planHistorySync([movie(550), movie(550)], []);
    expect(plan.toAdd).toHaveLength(1);
    expect(plan.skippedDuplicate).toBe(1);
  });

  // A provider may report a fully-watched series as a whole-show marker instead
  // of listing episodes (Simkl). These must reconcile against per-episode data so
  // syncs converge instead of re-adding every run.
  const show = (tmdb: number): WatchEvent => ({ ref: { kind: 'show', ids: { tmdb } }, watchedAt: null });

  it('treats episodes as present when the target has the whole show marked watched', () => {
    const source = [episode(1399, 1, 1), episode(1399, 2, 3)];
    const plan = planHistorySync(source, [show(1399)]);
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.skippedPresent).toBe(2);
  });

  it('treats a whole-show marker as present when the target already has its episodes', () => {
    const plan = planHistorySync([show(1399)], [episode(1399, 1, 1)]);
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.skippedPresent).toBe(1);
  });

  it('does not mark unrelated episodes present from a different show marker', () => {
    const plan = planHistorySync([episode(1399, 1, 1)], [show(1400)]);
    expect(plan.toAdd).toHaveLength(1);
  });

  it('treats extraPresent (already-delivered) items as present so they are not re-sent', () => {
    const source = [episode(1399, 1, 1), episode(1399, 1, 2)];
    // Episode 1 was delivered on a prior run but the target never echoes it back.
    const plan = planHistorySync(source, [], [episode(1399, 1, 1).ref]);
    expect(plan.toAdd).toEqual([expect.objectContaining({ ref: expect.objectContaining({ season: 1, number: 2 }) })]);
    expect(plan.skippedPresent).toBe(1);
  });

  it('converges to zero once every item has been delivered, even if the target still reports none', () => {
    const source = [episode(1399, 1, 1), movie(550)];
    const delivered = source.map((e) => e.ref);
    const plan = planHistorySync(source, [], delivered);
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.skippedPresent).toBe(2);
  });

  it('converges: a completed-show target plans zero on the second run', () => {
    // First sync pushes episodes; the target then reports the series as completed
    // (no episodes enumerated). The re-run must plan nothing, not re-add.
    const source = [episode(1399, 1, 1), episode(1399, 1, 2), episode(1399, 2, 1)];
    const first = planHistorySync(source, []);
    expect(first.toAdd).toHaveLength(3);
    const targetAfter = [show(1399)];
    const second = planHistorySync(source, targetAfter);
    expect(second.toAdd).toHaveLength(0);
    expect(second.skippedPresent).toBe(3);
  });
});

describe('planProgressSync', () => {
  const prog = (tmdb: number, progress: number): ProgressEvent => ({ ref: { kind: 'movie', ids: { tmdb } }, progress });

  it('adds new resume positions', () => {
    const plan = planProgressSync([prog(550, 40)], []);
    expect(plan.toAdd).toHaveLength(1);
  });

  it('skips positions within 1% of the target (no churn)', () => {
    const plan = planProgressSync([prog(550, 40.5)], [prog(550, 40)]);
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.skippedUnchanged).toBe(1);
  });

  it('updates when progress moved materially', () => {
    const plan = planProgressSync([prog(550, 80)], [prog(550, 40)]);
    expect(plan.toAdd).toHaveLength(1);
  });
});
