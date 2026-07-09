import { randomUUID } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import { createLogger, safeEqual, type AppConfig } from '@watchbridge/core';
import type { Db } from '../db/client.js';
import { emailVerificationTokens, sessions, users, type User } from '../db/schema.js';
import type { Mailer } from '../mail/mailer.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { hashToken, newOpaqueToken } from './tokens.js';

const log = createLogger('auth');

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type AuthErrorCode =
  | 'registration_closed'
  | 'email_taken'
  | 'username_taken'
  | 'invalid_credentials'
  | 'email_unverified'
  | 'account_disabled'
  | 'invalid_token';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface RegisterInput {
  email: string;
  username?: string | undefined;
  password: string;
}

export interface SessionContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly mailer: Mailer,
    private readonly config: AppConfig,
  ) {}

  async register(input: RegisterInput): Promise<{ userId: string }> {
    if (!this.config.REGISTRATION_ENABLED) {
      throw new AuthError('registration_closed', 403, 'Registration is currently disabled');
    }
    const email = input.email.trim().toLowerCase();
    const username = input.username?.trim() || null;

    const clashes = await this.db.orm
      .select({ email: users.email, username: users.username })
      .from(users)
      .where(username ? or(eq(users.email, email), eq(users.username, username)) : eq(users.email, email));

    for (const row of clashes) {
      if (row.email === email) throw new AuthError('email_taken', 409, 'Email already registered');
      if (username && row.username === username) {
        throw new AuthError('username_taken', 409, 'Username already taken');
      }
    }

    const userId = randomUUID();
    await this.db.orm.insert(users).values({
      id: userId,
      email,
      username,
      passwordHash: await hashPassword(input.password),
    });

    await this.issueVerification(userId, email);
    log.info({ userId }, 'User registered');
    return { userId };
  }

  private async issueVerification(userId: string, email: string): Promise<void> {
    const token = newOpaqueToken();
    await this.db.orm.insert(emailVerificationTokens).values({
      id: randomUUID(),
      userId,
      tokenHash: token.hash,
      expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
    });
    const url = `${this.config.APP_URL}/api/auth/verify?token=${token.raw}`;
    await this.mailer.sendVerificationEmail(email, url);
  }

  async verifyEmail(rawToken: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    const [row] = await this.db.orm
      .select()
      .from(emailVerificationTokens)
      .where(
        and(eq(emailVerificationTokens.tokenHash, tokenHash), isNull(emailVerificationTokens.consumedAt)),
      )
      .limit(1);

    if (!row || row.expiresAt.getTime() < Date.now() || !safeEqual(row.tokenHash, tokenHash)) {
      throw new AuthError('invalid_token', 400, 'Verification link is invalid or expired');
    }

    await this.db.orm
      .update(emailVerificationTokens)
      .set({ consumedAt: new Date() })
      .where(eq(emailVerificationTokens.id, row.id));
    await this.db.orm
      .update(users)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(users.id, row.userId));
    log.info({ userId: row.userId }, 'Email verified');
  }

  async login(identifier: string, password: string): Promise<User> {
    const id = identifier.trim().toLowerCase();
    const [user] = await this.db.orm
      .select()
      .from(users)
      .where(or(eq(users.email, id), eq(users.username, identifier.trim())))
      .limit(1);

    // Always run a hash comparison to avoid revealing whether the account exists.
    const digest = user?.passwordHash ?? '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$0000000000000000000000000000000000000000000';
    const ok = await verifyPassword(digest, password);

    if (!user || !ok) throw new AuthError('invalid_credentials', 401, 'Invalid email or password');
    if (user.disabled) throw new AuthError('account_disabled', 403, 'Account is disabled');
    if (!user.emailVerified) {
      throw new AuthError('email_unverified', 403, 'Please verify your email before signing in');
    }
    return user;
  }

  async createSession(userId: string, ctx: SessionContext): Promise<{ token: string; expiresAt: Date }> {
    const token = newOpaqueToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.orm.insert(sessions).values({
      id: token.hash,
      userId,
      expiresAt,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return { token: token.raw, expiresAt };
  }

  async resolveSession(rawToken: string): Promise<User | null> {
    const id = hashToken(rawToken);
    const [row] = await this.db.orm
      .select({ user: users, expiresAt: sessions.expiresAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, id))
      .limit(1);

    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) {
      await this.destroySession(rawToken);
      return null;
    }
    if (row.user.disabled) return null;
    return row.user;
  }

  async destroySession(rawToken: string): Promise<void> {
    await this.db.orm.delete(sessions).where(eq(sessions.id, hashToken(rawToken)));
  }
}
