import { defineConfig } from 'vitest/config';

// Two shapes of the same app.
//
// The default build targets a plain `file://` open as well as a static host, so
// it is a classic IIFE folded into one HTML file: Chrome applies CORS to module
// scripts and blocks them outright on a `file://` page.
//
// `P2D_ANDROID=1` builds for the Android shell instead. There the page is served
// over the WebViewAssetLoader's https origin, which is a normal secure context,
// so the ES-module build loads and - the part that matters - the OCR web worker
// and its WASM core do too. Inlining would only get in the way, so it is skipped.
const android = process.env.P2D_ANDROID === '1';

export default defineConfig({
  // Relative asset URLs so the built bundle runs from file://, from any static
  // host, and from the asset loader alike.
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    outDir: android ? 'dist-android' : 'dist',
    modulePreload: false,
    rollupOptions: {
      output: android
        ? { entryFileNames: 'assets/[name].js' }
        : { format: 'iife', inlineDynamicImports: true, entryFileNames: 'assets/[name].js' },
    },
  },
  worker: { format: 'es' },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
