import { createLogger, loadConfig, ConfigStartupError, SecretBox } from '@watchbridge/core';
import { createDb } from './db/client.js';
import { assertStoredSecretsDecryptable } from './db/encryptionKey.js';
import { createMailer } from './mail/mailer.js';
import { buildApp } from './app.js';

const log = createLogger('server');

async function main(): Promise<void> {
  const config = loadConfig();

  const db = await createDb(config.DATABASE_URL);
  await db.migrate();
  log.info('Database migrated');

  // Every stored provider credential is sealed with APP_ENCRYPTION_KEY. Prove the
  // key still opens them before serving, so a wrong key fails loudly here rather
  // than as an unexplained failure on every sync.
  await assertStoredSecretsDecryptable(db, SecretBox.fromEnv(config.APP_ENCRYPTION_KEY));

  const mailer = createMailer(config);
  await mailer.verify();

  const app = buildApp({ config, db, mailer });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down');
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  log.info({ port: config.PORT, url: config.APP_URL }, 'Watchbridge listening');
}

main().catch((err) => {
  if (err instanceof ConfigStartupError) {
    // Config problems: print the message plainly, no stack trace.
    process.stderr.write(`\n${err.message}\n\n`);
    process.exit(1);
  }
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
