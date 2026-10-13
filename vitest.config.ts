import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 20000,
    env: { NODE_ENV: 'test', HIO_DB_PATH: ':memory:', SESSION_SECRET: 'test-only-secret-not-for-production-0123456789', LOG_LEVEL: 'silent' },
  },
});
