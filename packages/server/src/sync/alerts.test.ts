import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const sent: Array<{ kind: 'failure' | 'recovery'; to: string; syncName: string; reason?: string }> = [];

vi.mock('@watchbridge/core', async () => {
  const actual = await vi.importActual<typeof import('@watchbridge/core')>('@watchbridge/core');
  return { ...actual, createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) };
});

const { createDb } = await import('../db/client.js');
const { users, syncs } = await import('../db/schema.js');
const { SyncRunner } = await import('./runner.js');
type Db = Awaited<ReturnType<typeof createDb>>;

let db: Db;
let runner: InstanceType<typeof SyncRunner>;

const mailer = {
  async sendVerificationEmail() {},
  async sendPasswordResetEmail() {},
  async sendSyncFailureEmail(to: string, alert: { syncName: string; reason: string }) {
    sent.push({ kind: 'failure', to, syncName: alert.syncName, reason: alert.reason });
  },
  async sendSyncRecoveryEmail(to: string, alert: { syncName: string }) {
    sent.push({ kind: 'recovery', to, syncName: alert.syncName });
  },
  async verify() {
    return true;
  },
};

// A connection service whose source is missing, so every run fails with a
// connection error unless we flip it to return a working stub.
const clientFor = vi.fn();
const connections = { clientFor } as unknown as ConstructorParameters<typeof SyncRunner>[1];

const workingStub = (id: string) => ({
  id,
  capabilities: () => ({ history: true, progress: false, ratings: false, watchlist: false, datedHistory: true }),
  pullHistory: async () => [],
  pushHistory: async () => ({ added: 0, skipped: 0, failed: 0, notFound: 0 }),
});

const useWorking = () => clientFor.mockImplementation(async (_u: string, p: string) => workingStub(p));
const useBrokenConnection = () => clientFor.mockImplementation(async () => null);

beforeAll(async () => {
  db = await createDb('pglite://memory');
  await db.migrate();
  await db.orm.insert(users).values({ id: 'u1', email: 'owner@example.com', passwordHash: 'x' });
  await db.orm.insert(syncs).values({
    id: 's1',
    userId: 'u1',
    name: 'Trakt to Simkl',
    source: 'trakt',
    target: 'simkl',
    dataTypes: '["history"]',
  });
  runner = new SyncRunner(db, connections, 0, { mailer, appUrl: 'https://watchbridge.example' });
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  sent.length = 0;
  clientFor.mockReset();
  await db.orm.update(syncs).set({ lastRunStatus: null });
});

const sync = async () => (await db.orm.select().from(syncs).where(eq(syncs.id, 's1')))[0]!;

describe('transition-based sync alerts', () => {
  it('emails on the first scheduled failure', async () => {
    useBrokenConnection();
    await runner.execute(await sync(), 'scheduled');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'failure', to: 'owner@example.com', syncName: 'Trakt to Simkl' });
    expect(sent[0]!.reason).toMatch(/not connected/);
  });

  it('stays quiet while it keeps failing', async () => {
    await db.orm.update(syncs).set({ lastRunStatus: 'error' });
    useBrokenConnection();
    await runner.execute(await sync(), 'scheduled');
    expect(sent).toHaveLength(0);
  });

  it('emails once on recovery', async () => {
    await db.orm.update(syncs).set({ lastRunStatus: 'error' });
    useWorking();
    await runner.execute(await sync(), 'scheduled');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'recovery' });
  });

  it('does not email a plain successful run', async () => {
    await db.orm.update(syncs).set({ lastRunStatus: 'success' });
    useWorking();
    await runner.execute(await sync(), 'scheduled');
    expect(sent).toHaveLength(0);
  });

  it('never alerts on a manual run', async () => {
    useBrokenConnection();
    await runner.execute(await sync(), 'manual');
    expect(sent).toHaveLength(0);
  });

  it('never alerts on a preview', async () => {
    useBrokenConnection();
    await runner.execute(await sync(), 'preview');
    expect(sent).toHaveLength(0);
  });
});
