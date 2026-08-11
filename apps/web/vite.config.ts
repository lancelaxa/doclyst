import { defineConfig } from 'vite';

// Everything is bundled into a single self-contained page. There are no
// runtime fetches, no CDN references and no external fonts, so the built
// output can be opened from disk or served from anywhere without the page
// ever reaching the network.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    // Vite's modulepreload polyfill calls `fetch` to warm preload links. It
    // would never reach anything off-origin, but its presence undermines a
    // property worth being able to check by grep: that the shipped bundle
    // contains no network call at all. The build emits a single chunk, so the
    // polyfill buys nothing here anyway.
    modulePreload: { polyfill: false },
  },
});
