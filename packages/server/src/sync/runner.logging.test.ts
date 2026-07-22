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
const { users, syncs } = await import('../db/schema.js');
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
