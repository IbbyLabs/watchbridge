import { defineConfig } from 'vitest/config';

/**
 * These suites are integration tests: each file boots its own in-memory Postgres,
 * runs the migrations, and registers a user (argon2id, deliberately slow). Run in
 * parallel on a busy machine, that setup comfortably outlasts the default 10s
 * hook timeout, which showed up as flaky failures rather than real ones.
 */
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
});
