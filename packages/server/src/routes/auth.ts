import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@watchbridge/core';
import { AuthError, type AuthService } from '../auth/service.js';
import type { RateLimiter } from '../plugins/rateLimit.js';
import {
  clearSessionCookie,
  requireAuth,
  SESSION_COOKIE,
  setSessionCookie,
} from '../plugins/auth.js';

const registerBody = z.object({
  email: z.string().email().max(254),
  username: z
    .string()
    .trim()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Username may use letters, numbers, and . _ -')
    .optional(),
  password: z.string().min(8).max(200),
});

const loginBody = z.object({
  identifier: z.string().min(1).max(254),
  password: z.string().min(1).max(200),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

const forgotBody = z.object({ email: z.string().email().max(254) });

const resetBody = z.object({
  token: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

export function authRoutes(
  app: FastifyInstance,
  auth: AuthService,
  limiter: RateLimiter,
  config: AppConfig,
): void {
  app.post(
    '/api/auth/register',
    {
      preHandler: limiter.middleware({
        name: 'register',
        max: config.SIGNUP_RATE_PER_HOUR,
        windowMs: 3_600_000,
      }),
    },
    async (request, reply) => {
      const parsed = registerBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.flatten() });
      }
      try {
        await auth.register(parsed.data);
        return reply.code(201).send({ status: 'verification_sent' });
      } catch (err) {
        return sendAuthError(reply, err);
      }
    },
  );

  app.get(
    '/api/auth/verify',
    // Verification tokens are long random values, but a link that can be probed
    // without limit is still a free oracle.
    { preHandler: limiter.middleware({ name: 'verify', max: 20, windowMs: 3_600_000 }) },
    async (request, reply) => {
      const token = z
        .string()
        .min(1)
        .safeParse((request.query as { token?: string }).token);
      if (!token.success) return reply.redirect(`${config.APP_URL}/login?verified=0`);
      try {
        await auth.verifyEmail(token.data);
        return reply.redirect(`${config.APP_URL}/login?verified=1`);
      } catch {
        return reply.redirect(`${config.APP_URL}/login?verified=0`);
      }
    },
  );

  app.post(
    '/api/auth/login',
    { preHandler: limiter.middleware({ name: 'login', max: 10, windowMs: 300_000 }) },
    async (request, reply) => {
      const parsed = loginBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.flatten() });
      }
      try {
        const user = await auth.login(parsed.data.identifier, parsed.data.password);
        const session = await auth.createSession(user.id, {
          ip: request.clientIp,
          userAgent: request.headers['user-agent'],
        });
        setSessionCookie(reply, session.token, session.expiresAt, config);
        return reply.send(publicUser(user));
      } catch (err) {
        return sendAuthError(reply, err);
      }
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies['wb_session'];
    if (token) await auth.destroySession(token);
    clearSessionCookie(reply, config);
    return reply.send({ status: 'ok' });
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    return reply.send(publicUser(request.user!));
  });

  app.post(
    '/api/auth/password/change',
    // Changing a password requires the current one, so an attacker holding a
    // stolen session could otherwise guess it at will.
    {
      preHandler: [
        requireAuth,
        limiter.middleware({
          name: 'password-change',
          max: 10,
          windowMs: 3_600_000,
          keyBy: (req) => req.user?.id ?? req.clientIp,
        }),
      ],
    },
    async (request, reply) => {
      const parsed = changePasswordBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.flatten() });
      }
      try {
        await auth.changePassword(
          request.user!.id,
          request.cookies[SESSION_COOKIE]!,
          parsed.data.currentPassword,
          parsed.data.newPassword,
        );
        return reply.send({ status: 'ok' });
      } catch (err) {
        return sendAuthError(reply, err);
      }
    },
  );

  app.post(
    '/api/auth/password/forgot',
    { preHandler: limiter.middleware({ name: 'forgot', max: 5, windowMs: 3_600_000 }) },
    async (request, reply) => {
      const parsed = forgotBody.safeParse(request.body);
      // Always answer the same way so the endpoint can't be used to probe which
      // emails have accounts.
      if (parsed.success) await auth.requestPasswordReset(parsed.data.email);
      return reply.send({ status: 'ok' });
    },
  );

  app.post(
    '/api/auth/password/reset',
    { preHandler: limiter.middleware({ name: 'reset', max: 10, windowMs: 3_600_000 }) },
    async (request, reply) => {
      const parsed = resetBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.flatten() });
      }
      try {
        await auth.resetPassword(parsed.data.token, parsed.data.newPassword);
        return reply.send({ status: 'ok' });
      } catch (err) {
        return sendAuthError(reply, err);
      }
    },
  );
}

function publicUser(user: {
  id: string;
  email: string;
  username: string | null;
  emailVerified: boolean;
  isAdmin: boolean;
}) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    emailVerified: user.emailVerified,
    isAdmin: user.isAdmin,
  };
}

function sendAuthError(reply: import('fastify').FastifyReply, err: unknown) {
  if (err instanceof AuthError) {
    return reply.code(err.status).send({ error: err.code, message: err.message });
  }
  throw err;
}
