/**
 * Shared pacing for one upstream.
 *
 * Providers rate-limit per application credential, not per connection: Trakt and
 * Simkl both count every request made with the app's client_id, whoever made it.
 * A client built per sync run therefore paces in isolation and, with several runs
 * in flight, the app as a whole exceeds the published limit — which Simkl answers
 * by suspending the client_id without warning.
 *
 * One gate per provider, held for the life of the process and handed to every
 * client built for it, keeps the spacing global.
 */
export class RateGate {
  private queue: Promise<void> = Promise.resolve();
  private lastAt = 0;

  /**
   * Resolves once the caller may issue a request, at least `minIntervalMs` after
   * the previous caller was let through. Waiters are served in arrival order.
   */
  acquire(minIntervalMs: number): Promise<void> {
    const turn = this.queue.then(async () => {
      const wait = this.lastAt + minIntervalMs - Date.now();
      if (minIntervalMs > 0 && wait > 0) await new Promise((r) => setTimeout(r, wait));
      // Recorded even for an unpaced call: it still hit the upstream, so the next
      // paced caller must space itself from it.
      this.lastAt = Date.now();
    });
    // Keep the queue alive but never let one waiter's rejection poison the rest.
    this.queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }
}

/** Process-wide gates, one per upstream, created on first use. */
const gates = new Map<string, RateGate>();

export function sharedRateGate(provider: string): RateGate {
  const existing = gates.get(provider);
  if (existing) return existing;
  const gate = new RateGate();
  gates.set(provider, gate);
  return gate;
}
