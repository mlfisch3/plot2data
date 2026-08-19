import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs so the built bundle runs from file:// or any static host.
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    // A classic IIFE, not an ES module: Chrome applies CORS to module scripts,
    // which blocks them outright on a `file://` page. `tools/inline-bundle.ts`
    // then folds the script and stylesheet into index.html so the built app is
    // one self-contained file that opens from the filesystem.
    modulePreload: false,
    rollupOptions: {
      output: { format: 'iife', inlineDynamicImports: true, entryFileNames: 'assets/[name].js' },
    },
  },
  worker: { format: 'es' },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
