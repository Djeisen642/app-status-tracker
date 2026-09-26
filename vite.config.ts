import { defineConfig } from 'vite';

// Tauri exposes the dev host through this env var when targeting a physical
// device; otherwise we bind to localhost.
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  // Prevent Vite from clobbering the Rust compiler output in the terminal.
  clearScreen: false,
  server: {
    // Tauri requires a fixed, predictable port. This app uses 1440 so it can run
    // side-by-side with noticeable-calendar-alert (1420) and task-tracker (1430)
    // during development.
    port: 1440,
    strictPort: true,
    host: host ?? false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1441,
        }
      : undefined,
    watch: {
      // The Rust side is rebuilt by `cargo`, so Vite should ignore it.
      ignored: ['**/src-tauri/**'],
    },
  },
  // Produce a lean, modern bundle. Vite 8 transpiles/minifies with Oxc
  // (via Rolldown) — no separate esbuild install required.
  build: {
    target: 'es2022',
    minify: 'oxc',
    sourcemap: false,
  },
});
