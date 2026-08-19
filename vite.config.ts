import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs so the built bundle runs from file:// or any static host.
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
