import { createLogger } from '@watchbridge/core';

const log = createLogger('server');

/** Flipped on shutdown so /api/ready can steer a load balancer away before the server closes. */
export interface DrainState {
  draining: boolean;
}

export interface ShutdownDeps {
  drain: DrainState;
  drainSeconds: number;
  close: () => Promise<void>;
  exit: (code: number) => void;
}

export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let started = false;
  return async (signal) => {
    if (started) return;
    started = true;
    deps.drain.draining = true;
    log.info({ signal, drain_seconds: deps.drainSeconds }, 'Shutting down; reporting not ready first');
    if (deps.drainSeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, deps.drainSeconds * 1000));
    }
    try {
      await deps.close();
    } catch (err) {
      log.error({ err, signal }, 'Failed to close cleanly during shutdown');
      deps.exit(1);
      return;
    }
    log.info({ signal }, 'Shutdown complete');
    deps.exit(0);
  };
}
