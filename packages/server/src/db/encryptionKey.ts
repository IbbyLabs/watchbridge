import { ConfigStartupError, type SecretBox } from '@watchbridge/core';
import { connections } from './schema.js';
import type { Db } from './client.js';

/** How many stored secrets to test before concluding the key is wrong. */
const SAMPLE_SIZE = 25;

/**
 * Verify at startup that `APP_ENCRYPTION_KEY` still decrypts what is already
 * stored. Every provider credential is sealed with that key, so a rotated or
 * mis-set key makes all of them permanently unreadable — and without this check
 * the app starts, reports healthy, and fails every sync instead of saying why.
 *
 * One unreadable row is treated as a corrupt row, not a wrong key: the check
 * only fails when nothing in the sample decrypts.
 */
export async function assertStoredSecretsDecryptable(db: Db, box: SecretBox): Promise<void> {
  const rows = await db.orm
    .select({ provider: connections.provider, credentials: connections.credentials })
    .from(connections)
    .limit(SAMPLE_SIZE);

  if (rows.length === 0) return;

  const undecryptable: string[] = [];
  for (const row of rows) {
    try {
      box.decrypt(row.credentials);
      return; // One success proves the key is right.
    } catch {
      undecryptable.push(row.provider);
    }
  }

  const providers = [...new Set(undecryptable)].sort().join(', ');
  throw new ConfigStartupError(
    `Stored provider credentials cannot be decrypted with the current APP_ENCRYPTION_KEY.\n` +
      `Affected: ${providers} (${undecryptable.length} of ${rows.length} sampled).\n\n` +
      `This usually means APP_ENCRYPTION_KEY changed, or a database was restored without\n` +
      `the key that encrypted it. Refusing to start so the mistake is not mistaken for a\n` +
      `working instance.\n\n` +
      `Restore the original key, or clear the connections table and re-link the accounts.`,
  );
}
