import { describe, expect, it } from 'vitest';
import { TraktClient } from '@watchbridge/core';
import { readRequestCount } from './runner.js';

/**
 * `readRequestCount` reaches into the source through a cast, so renaming the
 * field on the provider compiles cleanly and the count silently vanishes from
 * the run log. An absent count already means "this provider does not count",
 * so the disappearance is indistinguishable from normal — and the field is the
 * instrument for deciding whether the cursor fix worked.
 */
describe('the request count survives the cast', () => {
  it('reads a number off a real Trakt client', () => {
    const client = new TraktClient({ clientId: 'c', clientSecret: 's' });
    expect(typeof readRequestCount(client)).toBe('number');
  });

  // Absent must keep meaning "does not count", not "counted zero".
  it('is undefined for a source that does not count', () => {
    expect(readRequestCount({})).toBeUndefined();
    expect(readRequestCount(null)).toBeUndefined();
  });
});
