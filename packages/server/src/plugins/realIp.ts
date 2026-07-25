import type { FastifyInstance } from 'fastify';
import { resolveClientIp, type AppConfig } from '@watchbridge/core';

/**
 * Populate `request.clientIp` from the socket peer and trusted proxy headers.
 * Registered on the root instance (no encapsulation) so every route sees it.
 */
export function registerRealIp(app: FastifyInstance, config: AppConfig): void {
  app.decorateRequest('clientIp', '');
  app.addHook('onRequest', async (request) => {
    const result = resolveClientIp(
      {
        socketAddress: request.socket.remoteAddress,
        forwardedFor: request.headers['x-forwarded-for'],
        cfConnectingIp: request.headers['cf-connecting-ip'],
      },
      {
        trustedProxies: config.trustedProxyCidrs,
        trustCloudflareHeader: config.TRUST_CLOUDFLARE_HEADER,
      },
    );
    request.clientIp = result.ip;
  });
}
