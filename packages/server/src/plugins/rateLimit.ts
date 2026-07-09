import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

interface Bucket {
  hits: number[];
}

export interface LimitOptions {
  /** Unique bucket name (e.g. 'login', 'register'). */
  name: string;
  /** Max requests allowed within the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Key to bucket by. Defaults to the resolved client IP. */
  keyBy?: (req: FastifyRequest) => string;
}

/**
 * In-memory sliding-window rate limiter keyed by real client IP. Sufficient for
 * a single-process deployment; swap for a Redis-backed store when scaling out.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor() {
    // Periodic sweep so idle keys don't accumulate.
    const timer = setInterval(() => this.sweep(), 60_000);
    timer.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      bucket.hits = bucket.hits.filter((t) => now - t < 3_600_000);
      if (bucket.hits.length === 0) this.buckets.delete(key);
    }
  }

  middleware(opts: LimitOptions): preHandlerHookHandler {
    const keyFn = opts.keyBy ?? ((req: FastifyRequest) => req.clientIp);
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const key = `${opts.name}:${keyFn(request)}`;
      const now = Date.now();
      const bucket = this.buckets.get(key) ?? { hits: [] };
      bucket.hits = bucket.hits.filter((t) => now - t < opts.windowMs);

      if (bucket.hits.length >= opts.max) {
        const retryAfter = Math.ceil((bucket.hits[0]! + opts.windowMs - now) / 1000);
        reply.header('Retry-After', String(Math.max(1, retryAfter)));
        return reply.code(429).send({ error: 'rate_limited', message: 'Too many requests' });
      }

      bucket.hits.push(now);
      this.buckets.set(key, bucket);
    };
  }
}
