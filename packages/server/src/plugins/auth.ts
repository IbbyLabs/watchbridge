import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '@watchbridge/core';
import type { AuthService } from '../auth/service.js';

export const SESSION_COOKIE = 'wb_session';

/** Resolve `request.user` from the session cookie on every request. */
export function registerAuth(app: FastifyInstance, auth: AuthService): void {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    request.user = token ? await auth.resolveSession(token) : null;
  });
}

export const requireAuth: preHandlerHookHandler = async (request, reply) => {
  if (!request.user) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Sign in required' });
  }
};

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  config: AppConfig,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
  });
}
