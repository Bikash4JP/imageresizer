import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // Image encoding is CPU-bound; running files in parallel mostly adds contention.
    fileParallelism: false,
  },
});
