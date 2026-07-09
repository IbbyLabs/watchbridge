import { createLogger } from '../logger.js';

const log = createLogger('http');

export interface HttpOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  /** Query params added to every request unless already present (e.g. Simkl app-name). */
  defaultQuery?: Record<string, string>;
  /** Minimum spacing between requests, ms (e.g. Trakt writes = 1/sec). */
  minIntervalMs?: number;
  /** Max retries on 429 / 5xx. */
  maxRetries?: number;
  /** Bounds the backoff wait honoured from Retry-After, ms. */
  maxBackoffMs?: number;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A small fetch wrapper that paces requests, retries on 429/5xx honouring
 * `Retry-After`, and throws `HttpError` on non-2xx. One instance per provider
 * connection so pacing is isolated per upstream.
 */
export class HttpClient {
  private readonly opts: Required<HttpOptions>;
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(options: HttpOptions) {
    this.opts = {
      headers: {},
      defaultQuery: {},
      minIntervalMs: 0,
      maxRetries: 4,
      maxBackoffMs: 60_000,
      timeoutMs: 20_000,
      ...options,
    };
  }

  get<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>('GET', path, undefined, init);
  }

  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
    return this.request<T>('POST', path, body, init);
  }

  delete<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>('DELETE', path, undefined, init);
  }

  /** Serialize through a promise chain so minInterval pacing is honoured. */
  private request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
    const run = async (): Promise<T> => {
      await this.pace();
      return this.execute<T>(method, path, body, init);
    };
    const result = this.chain.then(run, run);
    // Keep the chain alive but swallow rejections so one failure doesn't poison it.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async pace(): Promise<void> {
    if (this.opts.minIntervalMs <= 0) return;
    const wait = this.lastAt + this.opts.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastAt = Date.now();
  }

  private async execute<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<T> {
    let url = path.startsWith('http') ? path : `${this.opts.baseUrl}${path}`;
    const defaults = Object.entries(this.opts.defaultQuery);
    if (defaults.length > 0) {
      const u = new URL(url);
      for (const [k, v] of defaults) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
      url = u.toString();
    }
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            ...this.opts.headers,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(init?.headers as Record<string, string> | undefined),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.opts.maxRetries) {
          const wait = this.backoff(res, attempt);
          log.warn({ url, status: res.status, attempt, wait }, 'Retrying after backoff');
          await sleep(wait);
          attempt++;
          continue;
        }
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HttpError(res.status, text, url);
      }

      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  private backoff(res: Response, attempt: number): number {
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) return Math.min(secs * 1000, this.opts.maxBackoffMs);
    }
    const base = Math.min(2 ** attempt * 1000, this.opts.maxBackoffMs);
    return base + Math.floor(Math.random() * 250); // jitter
  }
}
