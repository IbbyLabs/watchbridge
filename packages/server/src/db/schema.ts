import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Phase-1 auth schema. IDs are application-generated UUID strings so the schema
 * stays identical across PGlite (dev) and Postgres (prod). Secrets that live in
 * these tables (verification tokens, session tokens) are stored hashed — the raw
 * value only ever exists in the user's email link or cookie.
 */

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    username: text('username'),
    passwordHash: text('password_hash').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    isAdmin: boolean('is_admin').notNull().default(false),
    disabled: boolean('disabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_uniq').on(t.email),
    uniqueIndex('users_username_uniq').on(t.username),
  ],
);

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('evt_token_hash_uniq').on(t.tokenHash), index('evt_user_idx').on(t.userId)],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('prt_token_hash_uniq').on(t.tokenHash), index('prt_user_idx').on(t.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256(cookie token)
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const connections = pgTable(
  'connections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // 'trakt' | 'simkl' | 'pmdb' | 'mdblist'
    /** Display name for the linked account. */
    label: text('label'),
    /** AES-256-GCM encrypted JSON credential blob (tokens or api key). */
    credentials: text('credentials').notNull(),
    status: text('status').notNull().default('active'), // active | reauth | error
    /**
     * Which remote account this connection resolves to. Reconnecting a provider
     * to a different account has to invalidate anything keyed to the old one.
     */
    remoteAccount: text('remote_account'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('connections_user_provider_uniq').on(t.userId, t.provider),
    index('connections_user_idx').on(t.userId),
  ],
);

export const syncs = pgTable(
  'syncs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    source: text('source').notNull(), // provider id
    target: text('target').notNull(), // provider id
    /** JSON array of data types, e.g. ["history","progress"]. */
    dataTypes: text('data_types').notNull(),
    direction: text('direction').notNull().default('one_way'), // one_way | two_way
    /** Null = manual only. Otherwise minutes between scheduled runs. */
    intervalMinutes: integer('interval_minutes'),
    enabled: boolean('enabled').notNull().default(true),
    /** Per-provider delta cursors, JSON e.g. {"simkl:history":"2023-10-12T09:03:45Z"}. */
    cursors: text('cursors').notNull().default('{}'),
    /** Per-sync scope filters (SyncFilters JSON); null means sync everything. */
    filters: text('filters'),
    /** For ratings syncs: the provider whose rating wins a conflict. */
    ratingsAuthority: text('ratings_authority'),
    /** For watchlist syncs: also take items off the target when the source drops them. */
    propagateWatchlistRemovals: boolean('propagate_watchlist_removals').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    /** Status of the most recent non-preview run, so the list needs no per-row query. */
    lastRunStatus: text('last_run_status'),
    /** When this sync last ignored its delta cursor and re-read everything. */
    lastFullReconcileAt: timestamp('last_full_reconcile_at', { withTimezone: true }),
  },
  (t) => [index('syncs_user_idx').on(t.userId), index('syncs_enabled_idx').on(t.enabled)],
);

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: text('id').primaryKey(),
    syncId: text('sync_id')
      .notNull()
      .references(() => syncs.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull(), // manual | scheduled | preview
    status: text('status').notNull(), // success | error | partial
    /** JSON SyncReport(s). */
    report: text('report'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('sync_runs_sync_idx').on(t.syncId), index('sync_runs_user_idx').on(t.userId)],
);

/**
 * Items a sync has successfully delivered to a target. Some providers accept a
 * write but never echo it back under the ids the sync reads by (e.g. Simkl
 * models certain shows' seasons as separate entries), so the diff would re-send
 * them forever. Recording what we've delivered lets planning treat them as
 * present and converge. Additive-only by design: a re-watch is a new item, but
 * un-watching on the target is not re-pushed.
 */
export const deliveries = pgTable(
  'deliveries',
  {
    id: text('id').primaryKey(),
    syncId: text('sync_id')
      .notNull()
      .references(() => syncs.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Provider the item was delivered TO. */
    target: text('target').notNull(),
    /**
     * Which kind of delivery this is. History and watchlist track separately —
     * a title can be both watched and watchlisted, and the two must not collide.
     * Defaults to 'history' so existing rows keep their meaning.
     */
    dataType: text('data_type').notNull().default('history'),
    /** Canonical item-identity key (highest-priority id + S/E). */
    itemKey: text('item_key').notNull(),
    /** JSON MediaRef, to rebuild the match index. */
    ref: text('ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('deliveries_scope_key_uniq').on(t.syncId, t.target, t.dataType, t.itemKey),
    index('deliveries_scope_idx').on(t.syncId, t.target, t.dataType),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type Sync = typeof syncs.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
export type Delivery = typeof deliveries.$inferSelect;

/**
 * Write-ahead for the date repair.
 *
 * Simkl will not update a watch date in place, so correcting one means removing
 * the entry and adding it back. A row here is written before the removal and
 * cleared after the add, so a crash in between leaves a record saying which
 * item is mid-flight instead of an episode that is simply gone.
 */
export const repairIntents = pgTable(
  'repair_intents',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    syncId: text('sync_id')
      .notNull()
      .references(() => syncs.id, { onDelete: 'cascade' }),
    target: text('target').notNull(),
    itemKey: text('item_key').notNull(),
    /** JSON MediaRef, so the item can be restored without re-reading the source. */
    ref: text('ref').notNull(),
    /** The date the entry should end up with. */
    watchedAt: text('watched_at').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('repair_intents_scope_uniq').on(t.syncId, t.target, t.itemKey)],
);

export type RepairIntent = typeof repairIntents.$inferSelect;
