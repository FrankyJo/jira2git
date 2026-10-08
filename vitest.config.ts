import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __GIT2JIRA_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    coverage: { provider: 'v8', include: ['src/**/*.ts'] },
  },
});
