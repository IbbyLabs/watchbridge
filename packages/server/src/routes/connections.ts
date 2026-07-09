import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig, ProviderId } from '@watchbridge/core';
import { requireAuth } from '../plugins/auth.js';
import type { ConnectionStore } from '../connections/store.js';
import {
  ConnectionService,
  InvalidApiKey,
  ProviderNotConfigured,
} from '../connections/service.js';

const deviceBody = z.object({ deviceCode: z.string().min(1) });
const pinBody = z.object({ userCode: z.string().min(1) });
const pmdbBody = z.object({ apiKey: z.string().min(10).max(200) });

export function connectionRoutes(
  app: FastifyInstance,
  service: ConnectionService,
  store: ConnectionStore,
  config: AppConfig,
): void {
  const auth = { preHandler: requireAuth };

  app.get('/api/connections', auth, async (request, reply) => {
    return reply.send(await store.list(request.user!.id));
  });

  // Which providers the operator has configured (SPA hides unavailable ones).
  // `redirect` = the one-click browser flow is available (needs a client secret).
  app.get('/api/connections/providers', auth, async (_request, reply) => {
    const providers: ProviderId[] = ['trakt', 'simkl', 'pmdb'];
    return reply.send(
      providers.map((p) => ({
        provider: p,
        configured: service.isConfigured(p),
        redirect: p === 'trakt' || p === 'simkl' ? service.redirectConfigured(p) : false,
      })),
    );
  });

  // Redirect (authorization-code) flow: SPA fetches the URL and navigates to it.
  app.get('/api/connections/:provider/authorize', auth, async (request, reply) => {
    const provider = (request.params as { provider: string }).provider;
    if (provider !== 'trakt' && provider !== 'simkl') return reply.code(404).send({ error: 'not_found' });
    try {
      return reply.send({ url: service.authorizeUrl(request.user!.id, provider) });
    } catch (err) {
      return providerError(reply, err);
    }
  });

  // Browser callback the provider redirects back to. GET with a single-use,
  // user-bound state, so it is CSRF-safe; ends in a redirect to the SPA.
  app.get('/api/connections/:provider/callback', async (request, reply) => {
    const provider = (request.params as { provider: string }).provider;
    const { code, state, error } = request.query as { code?: string; state?: string; error?: string };
    const back = (suffix: string) => reply.redirect(`${config.APP_URL}/connections?${suffix}`);
    if (provider !== 'trakt' && provider !== 'simkl') return reply.code(404).send({ error: 'not_found' });
    if (!request.user) return reply.redirect(`${config.APP_URL}/login`);
    if (error || !code || !state) return back(`error=${provider}`);
    try {
      const connected = await service.completeRedirect(state, code, request.user.id);
      return back(`connected=${connected}`);
    } catch {
      return back(`error=${provider}`);
    }
  });

  app.post('/api/connections/trakt/device', auth, async (_request, reply) => {
    try {
      return reply.send(await service.startTraktDevice());
    } catch (err) {
      return providerError(reply, err);
    }
  });

  app.post('/api/connections/trakt/device/poll', auth, async (request, reply) => {
    const parsed = deviceBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    try {
      const status = await service.pollTraktDevice(request.user!.id, parsed.data.deviceCode);
      return reply.send({ status });
    } catch (err) {
      return providerError(reply, err);
    }
  });

  app.post('/api/connections/simkl/pin', auth, async (_request, reply) => {
    try {
      return reply.send(await service.startSimklPin());
    } catch (err) {
      return providerError(reply, err);
    }
  });

  app.post('/api/connections/simkl/pin/poll', auth, async (request, reply) => {
    const parsed = pinBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    try {
      const status = await service.pollSimklPin(request.user!.id, parsed.data.userCode);
      return reply.send({ status });
    } catch (err) {
      return providerError(reply, err);
    }
  });

  app.post('/api/connections/pmdb', auth, async (request, reply) => {
    const parsed = pmdbBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    try {
      const connection = await service.connectPmdb(request.user!.id, parsed.data.apiKey);
      return reply.code(201).send(connection);
    } catch (err) {
      if (err instanceof InvalidApiKey) {
        return reply.code(400).send({ error: 'invalid_api_key', message: err.message });
      }
      return providerError(reply, err);
    }
  });

  app.delete('/api/connections/:id', auth, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const removed = await store.remove(request.user!.id, id);
    return reply.code(removed ? 200 : 404).send({ status: removed ? 'removed' : 'not_found' });
  });
}

function providerError(reply: FastifyReply, err: unknown) {
  if (err instanceof ProviderNotConfigured) {
    return reply.code(503).send({ error: 'provider_not_configured', provider: err.provider });
  }
  throw err;
}
