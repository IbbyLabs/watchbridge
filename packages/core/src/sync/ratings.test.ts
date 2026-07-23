import { describe, expect, it } from 'vitest';
import { planRatingsSync } from './plan.js';
import type { RatingEvent } from '../providers/types.js';

const rate = (tmdb: number, rating: number, kind: 'movie' | 'episode' = 'movie'): RatingEvent =>
  kind === 'movie'
    ? { ref: { kind: 'movie', ids: { tmdb } }, rating }
    : { ref: { kind: 'episode', ids: { tmdb }, season: 1, number: 1 }, rating };

describe('planRatingsSync', () => {
  it('applies a rating the target does not have yet', () => {
    const plan = planRatingsSync([rate(550, 8)], [], { sourceIsAuthoritative: true });
    expect(plan.toApply).toHaveLength(1);
  });

  it('fills a missing target rating regardless of which side is authoritative', () => {
    const auth = planRatingsSync([rate(550, 8)], [], { sourceIsAuthoritative: true });
    const nonAuth = planRatingsSync([rate(550, 8)], [], { sourceIsAuthoritative: false });
    expect(auth.toApply).toHaveLength(1);
    expect(nonAuth.toApply).toHaveLength(1);
  });

  it('never rewrites an identical rating (no rated_at churn)', () => {
    const plan = planRatingsSync([rate(550, 8)], [rate(550, 8)], { sourceIsAuthoritative: true });
    expect(plan.toApply).toHaveLength(0);
    expect(plan.skippedUnchanged).toBe(1);
  });

  it('overwrites a differing rating when the source is authoritative', () => {
    const plan = planRatingsSync([rate(550, 9)], [rate(550, 6)], { sourceIsAuthoritative: true });
    expect(plan.toApply).toHaveLength(1);
    expect(plan.toApply[0].rating).toBe(9);
  });

  it('keeps the target rating when the target is authoritative', () => {
    const plan = planRatingsSync([rate(550, 9)], [rate(550, 6)], { sourceIsAuthoritative: false });
    expect(plan.toApply).toHaveLength(0);
    expect(plan.skippedUnchanged).toBe(1);
  });

  it('parks a rating with no usable id as unmatched', () => {
    const plan = planRatingsSync(
      [{ ref: { kind: 'movie', ids: {} }, rating: 8 }],
      [],
      { sourceIsAuthoritative: true },
    );
    expect(plan.toApply).toHaveLength(0);
    expect(plan.unmatched).toHaveLength(1);
  });

  it('collapses duplicate source ratings for one item into a single apply', () => {
    const plan = planRatingsSync([rate(550, 8), rate(550, 9)], [], { sourceIsAuthoritative: true });
    expect(plan.toApply).toHaveLength(1);
    expect(plan.skippedDuplicate).toBe(1);
  });

  it('matches episodes by show id plus season and number', () => {
    const plan = planRatingsSync(
      [rate(1399, 9, 'episode')],
      [rate(1399, 9, 'episode')],
      { sourceIsAuthoritative: true },
    );
    expect(plan.toApply).toHaveLength(0);
    expect(plan.skippedUnchanged).toBe(1);
  });
});
