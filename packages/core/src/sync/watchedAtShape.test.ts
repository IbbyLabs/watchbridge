import { describe, expect, it } from 'vitest';
import { watchedAtShape } from './engine.js';
import type { WatchEvent } from '../types.js';

const at = (watchedAt: string | null): WatchEvent =>
  ({ ref: { tmdb: 550, type: 'movie' }, watchedAt }) as unknown as WatchEvent;

describe('watchedAtShape', () => {
  it('reports one distinct date when everything landed on the same day', () => {
    const shape = watchedAtShape([
      at('2026-08-16T00:15:00Z'),
      at('2026-08-16T00:15:01Z'),
      at('2026-08-16T00:15:02Z'),
    ]);
    // Three items, three timestamps, one calendar day is still the failure the
    // caller needs to see — so distinctness is over the timestamp, and the
    // earliest/latest pair is what shows the span.
    expect(shape?.items).toBe(3);
    expect(shape?.earliest).toBe('2026-08-16');
    expect(shape?.latest).toBe('2026-08-16');
  });

  it('shows a real history as a span of years', () => {
    const shape = watchedAtShape([
      at('2019-04-02T20:00:00Z'),
      at('2023-11-15T09:30:00Z'),
      at('2026-08-01T18:00:00Z'),
    ]);
    expect(shape?.distinctDates).toBe(3);
    expect(shape?.earliest).toBe('2019-04-02');
    expect(shape?.latest).toBe('2026-08-01');
  });

  it('carries no time of day, so nothing in it says when somebody watched', () => {
    const shape = watchedAtShape([at('2019-04-02T20:37:11Z')]);
    const text = JSON.stringify(shape);
    expect(text).not.toContain('20:37');
    expect(text).not.toContain('T');
  });

  it('returns undefined when nothing carries a date rather than reporting zero', () => {
    // A zero would read as "all on one day" in a log; absence has to stay absent.
    expect(watchedAtShape([])).toBeUndefined();
    expect(watchedAtShape([at(null), at('')])).toBeUndefined();
  });

  it('counts every item even when only some carry a date', () => {
    const shape = watchedAtShape([at('2020-01-01T00:00:00Z'), at(null)]);
    expect(shape?.items).toBe(2);
    expect(shape?.distinctDates).toBe(1);
  });
});
