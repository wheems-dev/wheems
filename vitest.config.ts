import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // Temporary folders go in the repository's .tmp/vitest/, never the shared temp folder.
    globalSetup: ['test/setup/tmpdir.ts'],
    setupFiles: ['test/setup/env.ts'],
  },
});
