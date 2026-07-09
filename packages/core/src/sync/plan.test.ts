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
