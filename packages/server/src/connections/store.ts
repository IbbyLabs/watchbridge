import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { SecretBox } from '@watchbridge/core';
import type { ProviderId } from '@watchbridge/core';
import type { Db } from '../db/client.js';
import { connections, deliveries, syncs, type Connection } from '../db/schema.js';
import { createLogger } from '@watchbridge/core';

const log = createLogger('connections');

export interface TraktCreds {
  kind: 'trakt';
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
export interface SimklCreds {
  kind: 'simkl';
  accessToken: string;
}
export interface PmdbCreds {
  kind: 'pmdb';
  apiKey: string;
}
export interface MdblistCreds {
  kind: 'mdblist';
  apiKey: string;
}
export type Credentials = TraktCreds | SimklCreds | PmdbCreds | MdblistCreds;

/** Connection with no secret material — safe to return to the client. */
export interface PublicConnection {
  id: string;
  provider: ProviderId;
  label: string | null;
  status: string;
  createdAt: Date;
  lastValidatedAt: Date | null;
}

export function toPublic(c: Connection): PublicConnection {
  return {
    id: c.id,
    provider: c.provider as ProviderId,
    label: c.label,
    status: c.status,
    createdAt: c.createdAt,
    lastValidatedAt: c.lastValidatedAt,
  };
}

export class ConnectionStore {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  async list(userId: string): Promise<PublicConnection[]> {
    const rows = await this.db.orm.select().from(connections).where(eq(connections.userId, userId));
    return rows.map(toPublic);
  }

  /**
   * Create or replace the user's connection for a provider.
   *
   * `remoteAccount` identifies the account on the far side. When it changes, the
   * connection now points somewhere else, and anything derived from the previous
   * account is discarded in the same breath as the credential swap — a delta
   * cursor from the old account would skip the new account's history, and its
   * delivery memory would claim items were already pushed that never were.
   */
  async upsert(
    userId: string,
    provider: ProviderId,
    label: string | null,
    creds: Credentials,
    remoteAccount: string | null = null,
  ): Promise<PublicConnection> {
    const encrypted = this.box.encrypt(JSON.stringify(creds));
    const existing = await this.raw(userId, provider);
    if (existing) {
      const switched =
        remoteAccount !== null &&
        existing.remoteAccount !== null &&
        existing.remoteAccount !== remoteAccount;
      await this.db.orm
        .update(connections)
        .set({
          credentials: encrypted,
          label,
          status: 'active',
          remoteAccount: remoteAccount ?? existing.remoteAccount,
          updatedAt: new Date(),
          lastValidatedAt: new Date(),
        })
        .where(eq(connections.id, existing.id));
      if (switched) await this.forgetProviderState(userId, provider);
      return toPublic({ ...existing, label, status: 'active', credentials: encrypted });
    }
    const id = randomUUID();
    const now = new Date();
    await this.db.orm.insert(connections).values({
      id,
      userId,
      provider,
      label,
      credentials: encrypted,
      status: 'active',
      remoteAccount,
      lastValidatedAt: now,
    });
    return { id, provider, label, status: 'active', createdAt: now, lastValidatedAt: now };
  }

  /**
   * Drop everything this user's syncs remember about a provider: the delta
   * cursors that say where to resume, and the record of what has already been
   * delivered to it. Both are meaningless once the account behind it changes.
   */
  private async forgetProviderState(userId: string, provider: ProviderId): Promise<void> {
    const rows = await this.db.orm
      .select({ id: syncs.id, cursors: syncs.cursors })
      .from(syncs)
      .where(and(eq(syncs.userId, userId), or(eq(syncs.source, provider), eq(syncs.target, provider))));
    if (rows.length === 0) return;

    for (const row of rows) {
      let cursors: Record<string, unknown>;
      try {
        cursors = JSON.parse(row.cursors) as Record<string, unknown>;
      } catch {
        cursors = {};
      }
      for (const key of Object.keys(cursors)) {
        if (key.startsWith(`${provider}:`)) delete cursors[key];
      }
      await this.db.orm
        .update(syncs)
        .set({ cursors: JSON.stringify(cursors), updatedAt: new Date() })
        .where(eq(syncs.id, row.id));
    }

    await this.db.orm.delete(deliveries).where(
      and(
        inArray(
          deliveries.syncId,
          rows.map((r) => r.id),
        ),
        eq(deliveries.target, provider),
      ),
    );
    log.warn(
      { userId, provider, syncs: rows.length },
      'Provider reconnected to a different account; cleared its cursors and delivery memory',
    );
  }

  private raw(userId: string, provider: ProviderId): Promise<Connection | undefined> {
    return this.db.orm
      .select()
      .from(connections)
      .where(and(eq(connections.userId, userId), eq(connections.provider, provider)))
      .limit(1)
      .then((r) => r[0]);
  }

  /** Load and decrypt a user's credentials for a provider. */
  async getCreds(
    userId: string,
    provider: ProviderId,
  ): Promise<{ id: string; creds: Credentials } | null> {
    const row = await this.raw(userId, provider);
    if (!row) return null;
    return { id: row.id, creds: JSON.parse(this.box.decrypt(row.credentials)) as Credentials };
  }

  async updateCreds(id: string, creds: Credentials): Promise<void> {
    await this.db.orm
      .update(connections)
      .set({ credentials: this.box.encrypt(JSON.stringify(creds)), updatedAt: new Date() })
      .where(eq(connections.id, id));
  }

  async setStatus(id: string, status: 'active' | 'reauth' | 'error'): Promise<void> {
    await this.db.orm
      .update(connections)
      .set({ status, updatedAt: new Date() })
      .where(eq(connections.id, id));
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const [row] = await this.db.orm
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.userId, userId)))
      .limit(1);
    if (!row) return false;
    await this.db.orm.delete(connections).where(eq(connections.id, id));
    return true;
  }
}
