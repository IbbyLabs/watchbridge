/**
 * Roughly how long a repair run takes, in words.
 *
 * A correction on Simkl is a removal and an add, and Simkl accepts about one
 * write a second, so a couple of thousand of them is most of an hour. Someone
 * told nothing starts two thousand corrections, watches the page ask again
 * twenty times, and concludes it is broken — midway, which is worse than not
 * starting.
 */
export function roughDuration(items: number): string {
  const seconds = Math.max(0, items) * 2;
  if (seconds < 90) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = seconds / 3600;
  return hours < 1.5 ? 'about an hour' : `about ${Math.round(hours)} hours`;
}
