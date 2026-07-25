import { pino, type Logger } from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

const root = pino({
  level,
  // Redact anything that looks like a secret from structured logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.access_token',
      '*.refresh_token',
      '*.apiKey',
      '*.password',
    ],
    censor: '[redacted]',
  },
});

export function createLogger(scope: string): Logger {
  return root.child({ scope });
}

export type { Logger };
