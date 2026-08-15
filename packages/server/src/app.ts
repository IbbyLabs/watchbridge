import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { SecretBox, type AppConfig } from '@watchbridge/core';
import type { Db } from './db/client.js';
import type { Mailer } from './mail/mailer.js';
import { AuthService } from './auth/service.js';
import { ConnectionStore } from './connections/store.js';
import { ConnectionService } from './connections/service.js';
import { connectionRoutes } from './routes/connections.js';
import { repairRoutes } from './routes/repair.js';
import { SyncRunner } from './sync/runner.js';
import { SyncScheduler } from './sync/scheduler.js';
import { syncRoutes } from './routes/syncs.js';
import { RateLimiter } from './plugins/rateLimit.js';
import { registerRealIp } from './plugins/realIp.js';
import { registerAuth } from './plugins/auth.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/account.js';
import './types.js';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  mailer: Mailer;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, db, mailer } = deps;
  const app = Fastify({
    logger: false,
    // We resolve the client IP ourselves (see registerRealIp) rather than using
    // Fastify's trustProxy, so this stays false.
    trustProxy: false,
    bodyLimit: 256 * 1024,
  });

  app.register(helmet, { contentSecurityPolicy: false });
  app.register(cookie, { secret: config.SESSION_SECRET });

  registerRealIp(app, config);

  const auth = new AuthService(db, mailer, config);
  registerAuth(app, auth);

  // CSRF baseline: reject cross-origin state-changing requests. Browsers always
  // send Origin on such requests; native clients (no Origin) are allowed.
  const appOrigin = new URL(config.APP_URL).origin;
  app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin && origin !== appOrigin) {
      return reply.code(403).send({ error: 'bad_origin', message: 'Cross-origin request blocked' });
    }
  });

  const box = SecretBox.fromEnv(config.APP_ENCRYPTION_KEY);
  const connectionStore = new ConnectionStore(db, box);
  const connectionService = new ConnectionService(connectionStore, config);

  const runner = new SyncRunner(db, connectionService, config.FULL_RECONCILE_INTERVAL_HOURS, {
    mailer,
    appUrl: config.APP_URL,
  });
  const scheduler = new SyncScheduler(db, runner, config);

  const limiter = new RateLimiter();
  healthRoutes(app, db, config);
  authRoutes(app, auth, limiter, config);
  accountRoutes(app, db);
  connectionRoutes(app, connectionService, connectionStore, config);
  syncRoutes(app, db, scheduler, config);
  repairRoutes(app, db, connectionService);

  // The scheduler polls the DB on a timer; keep it off in tests.
  if (config.NODE_ENV !== 'test') scheduler.start();

  registerSpa(app);
  return app;
}

/** Serve the built SPA (if present) with history-API fallback for client routes. */
function registerSpa(app: FastifyInstance): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.WEB_DIST,
    resolve(here, '../../web/dist'), // monorepo: packages/server/dist -> packages/web/dist
    resolve(here, '../web'), // deployed: <app>/dist -> <app>/web
  ].filter((c): c is string => Boolean(c));

  const webDist = candidates.find((c) => existsSync(join(c, 'index.html')));
  if (!webDist) return;

  app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });
}
