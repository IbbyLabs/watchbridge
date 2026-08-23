import { describe, expect, it } from 'vitest';
import { roughDuration } from './duration.ts';

describe('roughDuration', () => {
  it('says under a minute rather than a number for a handful', () => {
    expect(roughDuration(1)).toBe('under a minute');
    expect(roughDuration(44)).toBe('under a minute');
  });

  it('counts in minutes through the middle of the range', () => {
    expect(roughDuration(45)).toBe('about 2 minutes');
    expect(roughDuration(600)).toBe('about 20 minutes');
  });

  it('reaches an hour where the docstring says it does', () => {
    // repairDates.ts: "a couple of thousand corrections is most of an hour".
    expect(roughDuration(2000)).toBe('about an hour');
  });

  it('counts in hours beyond that', () => {
    expect(roughDuration(5400)).toBe('about 3 hours');
  });

  // A count is never negative, but a phrase reading "about -3 minutes" is the
  // kind of thing that ships because nobody asked.
  it('never produces a negative phrase', () => {
    expect(roughDuration(-10)).toBe('under a minute');
  });
});
