import { describe, expect, it } from 'vitest';
import { planWatchlistSync } from './plan.js';
import type { WatchlistEvent } from '../providers/types.js';

const movie = (tmdb: number): WatchlistEvent => ({ ref: { kind: 'movie', ids: { tmdb } } });
const show = (tmdb: number): WatchlistEvent => ({ ref: { kind: 'show', ids: { tmdb } } });

describe('planWatchlistSync', () => {
  it('adds source items the target does not have', () => {
    const plan = planWatchlistSync([movie(550), show(1399)], [movie(550)], { propagateRemovals: false });
    expect(plan.toAdd).toHaveLength(1);
    expect(plan.toAdd[0].ref.ids.tmdb).toBe(1399);
    expect(plan.skippedPresent).toBe(1);
  });

  it('is idempotent: re-planning after adding yields nothing', () => {
    const plan = planWatchlistSync([movie(550)], [movie(550)], { propagateRemovals: false });
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
  });

  it('does not remove anything when removals are off, even if the target has extra items', () => {
    const plan = planWatchlistSync([movie(550)], [movie(550), show(1399)], { propagateRemovals: false });
    expect(plan.toRemove).toHaveLength(0);
  });

  it('removes target items missing from the source only when removals are on', () => {
    const plan = planWatchlistSync([movie(550)], [movie(550), show(1399)], { propagateRemovals: true });
    expect(plan.toRemove).toHaveLength(1);
    expect(plan.toRemove[0].ref.ids.tmdb).toBe(1399);
  });

  it('never removes when the source is empty, to avoid wiping a target watchlist', () => {
    const plan = planWatchlistSync([], [movie(550), show(1399)], { propagateRemovals: true });
    expect(plan.toRemove).toHaveLength(0);
    expect(plan.toAdd).toHaveLength(0);
  });

  it('matches across id types so the same title is not re-added', () => {
    const plan = planWatchlistSync(
      [{ ref: { kind: 'movie', ids: { imdb: 'tt0137523', tmdb: 550 } } }],
      [{ ref: { kind: 'movie', ids: { tmdb: 550 } } }],
      { propagateRemovals: false },
    );
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.skippedPresent).toBe(1);
  });

  it('parks an item with no usable id as unmatched', () => {
    const plan = planWatchlistSync([{ ref: { kind: 'movie', ids: {} } }], [], { propagateRemovals: false });
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.unmatched).toHaveLength(1);
  });

  it('collapses a duplicate source item into a single add', () => {
    const plan = planWatchlistSync([movie(550), movie(550)], [], { propagateRemovals: false });
    expect(plan.toAdd).toHaveLength(1);
    expect(plan.skippedDuplicate).toBe(1);
  });
});
