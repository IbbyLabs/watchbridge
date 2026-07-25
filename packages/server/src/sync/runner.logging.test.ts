import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const logged: Array<{ level: string; fields: Record<string, unknown>; msg: string }> = [];

vi.mock('@watchbridge/core', async () => {
  const actual = await vi.importActual<typeof import('@watchbridge/core')>('@watchbridge/core');
  const record =
    (level: string) =>
    (fields: Record<string, unknown>, msg?: string): void => {
      logged.push({ level, fields, msg: msg ?? '' });
    };
  return {
    ...actual,
    createLogger: () => ({ info: record('info'), warn: record('warn'), error: record('error') }),
  };
});

const { createDb } = await import('../db/client.js');
const { users, syncs, deliveries } = await import('../db/schema.js');
const { SyncRunner } = await import('./runner.js');
type Db = Awaited<ReturnType<typeof createDb>>;

let db: Db;
let runner: InstanceType<typeof SyncRunner>;

/** A connection service whose providers are stubbed, so no network is touched. */
const connections = {
  clientFor: vi.fn(),
} as unknown as ConstructorParameters<typeof SyncRunner>[1];

const stubClient = (id: string) => ({
  id,
  capabilities: () => ({ history: true, progress: false, ratings: false, watchlist: false, datedHistory: true }),
  pullHistory: async () => [],
  pushHistory: async () => ({ added: 0, skipped: 0, failed: 0, notFound: 0 }),
});

beforeAll(async () => {
  db = await createDb('pglite://memory');
  await db.migrate();
  await db.orm.insert(users).values({ id: 'u1', email: 'u@e.com', passwordHash: 'x' });
  await db.orm.insert(syncs).values({
    id: 's1',
    userId: 'u1',
    name: 'Trakt to Simkl',
    source: 'trakt',
    target: 'simkl',
    dataTypes: '["history"]',
  });
  runner = new SyncRunner(db, connections);
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  logged.length = 0;
  vi.mocked(connections.clientFor).mockImplementation(async (_u: string, p: string) => stubClient(p));
});

const sync = async () => (await db.orm.select().from(syncs).limit(1))[0];

describe('sync run logging', () => {
  it('logs one line per completed run, with the provider pair and outcome', async () => {
    await runner.execute(await sync(), 'scheduled');

    const lines = logged.filter((l) => l.msg === 'Sync run finished');
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('info');
    expect(lines[0].fields).toMatchObject({
      syncId: 's1',
      source: 'trakt',
      target: 'simkl',
      trigger: 'scheduled',
      status: 'success',
    });
    expect(lines[0].fields.durationMs).toEqual(expect.any(Number));
  });

  it('includes the per-data-type counts so a run can be diagnosed from logs alone', async () => {
    await runner.execute(await sync(), 'manual');

    const [line] = logged.filter((l) => l.msg === 'Sync run finished');
    const directions = line.fields.directions as Array<{ results: Array<Record<string, unknown>> }>;
    expect(directions[0].results[0]).toMatchObject({
      dataType: 'history',
      planned: 0,
      added: 0,
      failed: 0,
    });
  });

  it('logs a preview at debug-free silence — previews write nothing', async () => {
    await runner.preview(await sync());

    expect(logged.filter((l) => l.msg === 'Sync run finished')).toHaveLength(0);
  });

  it('logs at error level when the run could not start', async () => {
    vi.mocked(connections.clientFor).mockResolvedValue(null);

    await runner.execute(await sync(), 'scheduled');

    const [line] = logged.filter((l) => l.msg === 'Sync run finished');
    expect(line.level).toBe('error');
    expect(line.fields).toMatchObject({ status: 'error' });
    expect(String(line.fields.error)).toContain('not connected');
  });

  it('logs at warn level when the run partially failed', async () => {
    // Source has an item the target lacks, so a push is actually attempted, and
    // that push reports a failure.
    vi.mocked(connections.clientFor).mockImplementation(async (_u: string, p: string) => ({
      ...stubClient(p),
      pullHistory: async () =>
        p === 'trakt' ? [{ ref: { kind: 'movie' as const, ids: { tmdb: 1 } }, watchedAt: null }] : [],
      pushHistory: async () => ({ added: 0, skipped: 0, failed: 1, notFound: 0 }),
    }));

    await runner.execute(await sync(), 'scheduled');

    const [line] = logged.filter((l) => l.msg === 'Sync run finished');
    expect(line.level).toBe('warn');
    expect(line.fields).toMatchObject({ status: 'partial' });
  });
});

describe('a data type that throws does not sink the whole run', () => {
  const sync = async () => (await db.orm.select().from(syncs))[0]!;

  it('records a partial run and leaves the delta cursor where it was', async () => {
    await db.orm.update(syncs).set({ dataTypes: '["history","ratings"]' });
    vi.mocked(connections.clientFor).mockImplementation(async (_u: string, p: string) => ({
      ...stubClient(p),
      capabilities: () => ({ history: true, progress: false, ratings: true, watchlist: false, datedHistory: true }),
      lastActivityAll: 'T-NEW',
      pullHistory: async () => {
        throw new Error('Trakt timed out');
      },
      pullRatings: async () => [],
      pushRatings: async () => ({ added: 0, skipped: 0, failed: 0, notFound: 0 }),
    }));

    const outcome = await runner.execute(await sync(), 'scheduled');

    expect(outcome.status).toBe('partial');
    const history = outcome.reports[0]!.results.find((r) => r.dataType === 'history')!;
    expect(history.failed).toBe(1);
    expect(history.note).toContain('Trakt timed out');
    // Ratings still ran rather than being abandoned.
    expect(outcome.reports[0]!.results.some((r) => r.dataType === 'ratings')).toBe(true);
    // A failed history pull must not consume the delta window.
    expect((await sync()).cursors).not.toContain('T-NEW');

    await db.orm.update(syncs).set({ dataTypes: '["history"]', cursors: '{}' });
  });
});

describe('the run line records which guards were in effect', () => {
  const sync = async () => (await db.orm.select().from(syncs))[0]!;

  it('reports delivery memory, cursor, filters and removal state', async () => {
    // A recent reconcile keeps this a normal delta run rather than a forced full one.
    await db.orm.update(syncs).set({ filters: JSON.stringify({ movies: false }), lastFullReconcileAt: new Date() });
    await runner.execute(await sync(), 'scheduled');

    const [line] = logged.filter((l) => l.msg === 'Sync run finished');
    expect(line.fields.guards).toEqual({
      deliveryMemory: 0,
      cursor: 'none',
      filters: 'applied',
      watchlistRemovals: 'off',
      read: 'delta',
    });

    await db.orm.update(syncs).set({ filters: null });
  });

  it('says so when no filter is set', async () => {
    await db.orm.update(syncs).set({ lastFullReconcileAt: new Date() });
    await runner.execute(await sync(), 'scheduled');
    const [line] = logged.filter((l) => l.msg === 'Sync run finished');
    expect((line.fields.guards as { filters: string }).filters).toBe('none');
  });

  it('omits them when the run never started, rather than reporting empty ones', async () => {
    // Nothing was consulted, so saying "delivery memory: 0" here would read as
    // "the memory was empty" instead of "it was never reached".
    vi.mocked(connections.clientFor).mockImplementation(async () => null);
    await runner.execute(await sync(), 'scheduled');

    const [line] = logged.filter((l) => l.msg === 'Sync run finished');
    expect(line.fields).not.toHaveProperty('guards');
    expect(String(line.fields.error)).toContain('not connected');
  });
});

describe('weekly full reconciliation', () => {
  const sync = async () => (await db.orm.select().from(syncs))[0]!;

  // A source that only returns items when read in full (since === null), the way
  // a stuck delta cursor would keep skipping the same window.
  const fullOnlySource = (id: string) => ({
    ...stubClient(id),
    lastActivityAll: 'FRESH',
    pullHistory: async (since?: string | null) =>
      since ? [] : [{ ref: { kind: 'movie' as const, ids: { tmdb: 1 } }, watchedAt: null }],
  });

  beforeEach(async () => {
    await db.orm.update(syncs).set({ cursors: JSON.stringify({ 'trakt:history': 'STALE' }), lastFullReconcileAt: null });
  });

  it('ignores the cursor on the first scheduled run and records the reconcile', async () => {
    vi.mocked(connections.clientFor).mockImplementation(async (_u: string, p: string) => fullOnlySource(p));
    await runner.execute(await sync(), 'scheduled');

    const [line] = logged.filter((l) => l.msg === 'Sync run finished');
    expect((line.fields.guards as { read: string }).read).toBe('full');
    expect((await sync()).lastFullReconcileAt).not.toBeNull();
  });

  it('uses the delta cursor again once a reconcile is recent', async () => {
    await db.orm.update(syncs).set({ lastFullReconcileAt: new Date() });
    vi.mocked(connections.clientFor).mockImplementation(async (_u: string, p: string) => fullOnlySource(p));

    await runner.execute(await sync(), 'scheduled');
    const [line] = logged.filter((l) => l.msg === 'Sync run finished');
    expect((line.fields.guards as { read: string }).read).toBe('delta');
  });

  it('reconciles again once the interval has elapsed', async () => {
    await db.orm.update(syncs).set({ lastFullReconcileAt: new Date(Date.now() - 8 * 24 * 3_600_000) });
    vi.mocked(connections.clientFor).mockImplementation(async (_u: string, p: string) => fullOnlySource(p));

    await runner.execute(await sync(), 'scheduled');
    const [line] = logged.filter((l) => l.msg === 'Sync run finished');
    expect((line.fields.guards as { read: string }).read).toBe('full');
  });

  it('does not consume the window on a preview', async () => {
    vi.mocked(connections.clientFor).mockImplementation(async (_u: string, p: string) => fullOnlySource(p));
    await runner.execute(await sync(), 'preview');
    expect((await sync()).lastFullReconcileAt).toBeNull();
  });
});

describe('delivery memory survives a full re-read', () => {
  const sync = async () => (await db.orm.select().from(syncs))[0]!;

  // A target that accepts writes but never reflects them on read, the way Simkl
  // does for shows whose seasons it models separately.
  const swallowingPair = () =>
    vi.mocked(connections.clientFor).mockImplementation(async (_u: string, p: string) => {
      if (p === 'trakt') {
        return {
          ...stubClient('trakt'),
          pullHistory: async () => [{ ref: { kind: 'movie' as const, ids: { tmdb: 99 } }, watchedAt: null }],
        };
      }
      return {
        ...stubClient('simkl'),
        pullHistory: async () => [],
        pushHistory: async (events: unknown[]) => ({ added: events.length, skipped: 0, failed: 0, notFound: 0 }),
      };
    });

  beforeEach(async () => {
    await db.orm.delete(deliveries);
    await db.orm.update(syncs).set({ cursors: '{}', lastFullReconcileAt: null });
  });

  it('does not re-push an item on a forced full read once it has been delivered', async () => {
    swallowingPair();

    const first = await runner.execute(await sync(), 'scheduled');
    expect(first.reports[0]!.results[0]!.added).toBe(1);

    // Force the next run to be a full reconcile too (cursor ignored), the exact
    // condition under which a naive sync would re-push everything.
    await db.orm.update(syncs).set({ lastFullReconcileAt: null, cursors: '{}' });

    const second = await runner.execute(await sync(), 'scheduled');
    const history = second.reports[0]!.results[0]!;
    expect(history.added).toBe(0);
    expect(history.planned).toBe(0);
    expect(history.skippedPresent).toBe(1);
  });
})
