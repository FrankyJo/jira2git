import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __GIT2JIRA_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    // Integration tests drive real git processes, which are slow on some CI runners.
    testTimeout: 60_000,
    coverage: { provider: 'v8', include: ['src/**/*.ts'] },
  },
});
