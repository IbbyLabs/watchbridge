/**
 * Roughly how long a repair run takes, in words.
 *
 * A correction on Simkl is a removal and an add, and Simkl accepts about one
 * write a second, so a couple of thousand of them is most of an hour. Someone
 * told nothing starts two thousand corrections, watches the page ask again
 * twenty times, and concludes it is broken — midway, which is worse than not
 * starting.
 *
 * Every boundary rounds up. A phrase that undershoots is the failure this
 * exists to prevent; one that overshoots costs a pleasant surprise.
 */
export function roughDuration(items: number): string {
  const seconds = Math.max(0, items) * 2;
  if (seconds < 60) return 'under a minute';

  const minutes = Math.ceil(seconds / 60);
  if (minutes === 1) return 'about a minute';
  if (minutes < 60) return `about ${minutes} minutes`;

  // Half-hour steps either side of an hour. Whole hours would call 75 minutes
  // either an hour, which undershoots, or two, which overshoots by most of one.
  if (minutes < 75) return 'about an hour';
  if (minutes < 105) return 'about an hour and a half';
  return `about ${Math.max(2, Math.round(minutes / 60))} hours`;
}
