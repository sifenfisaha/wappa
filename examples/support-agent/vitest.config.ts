import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Only the TypeScript sources — the example's tsconfig has no test exclude,
  // so compiled copies of the tests land in dist/ and must not run twice.
  test: { include: ['src/**/*.test.ts'] },
});
