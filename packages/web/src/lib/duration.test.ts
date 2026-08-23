import { describe, expect, it } from 'vitest';
import { roughDuration } from './duration.ts';

// A correction is two writes at about one a second, so an item is two seconds.
describe('roughDuration', () => {
  it('says under a minute only while it is under a minute', () => {
    expect(roughDuration(1)).toBe('under a minute');
    expect(roughDuration(29)).toBe('under a minute'); // 58s
  });

  it('never undershoots at a boundary', () => {
    expect(roughDuration(30)).toBe('about a minute'); // 60s
    expect(roughDuration(44)).toBe('about 2 minutes'); // 88s, not "under a minute"
    expect(roughDuration(2700)).toBe('about an hour and a half'); // 90 min, not "an hour"
    expect(roughDuration(3150)).toBe('about 2 hours'); // 105 min, not "an hour and a half"
  });

  it('counts in minutes through the middle of the range', () => {
    expect(roughDuration(600)).toBe('about 20 minutes');
    expect(roughDuration(1500)).toBe('about 50 minutes');
  });

  it('reaches an hour where the repair docstring says it does', () => {
    // repairDates.ts: "a couple of thousand corrections is most of an hour".
    expect(roughDuration(2000)).toBe('about an hour');
  });

  it('counts in hours beyond that', () => {
    expect(roughDuration(3225)).toBe('about 2 hours');
    expect(roughDuration(9000)).toBe('about 5 hours');
  });

  it('never says a plural of one', () => {
    for (let items = 1; items <= 4000; items += 7) {
      expect(roughDuration(items)).not.toMatch(/\b1 (minutes|hours)\b/);
    }
  });

  it('never produces a negative phrase', () => {
    expect(roughDuration(-10)).toBe('under a minute');
  });
});
