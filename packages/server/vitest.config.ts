import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run the TypeScript sources only. `npm run build` emits compiled copies of
    // every test into `dist/__tests__/`, which vitest would otherwise collect as
    // well — doubling the suite and reporting stale failures from whenever dist
    // was last built.
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});
