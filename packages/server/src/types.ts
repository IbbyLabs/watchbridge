import type { User } from './db/schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Real client IP resolved from the socket + trusted proxy headers. */
    clientIp: string;
    /** Authenticated user for the request, or null. */
    user: User | null;
  }
}

export {};
