import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';

// Tauri exposes the dev host through this env var when targeting a physical
// device; otherwise we bind to localhost.
const host = process.env.TAURI_DEV_HOST;

// package.json is already the single source of truth for the version (see
// scripts/version.ts), so the Settings overlay's build info reads it here
// rather than carrying a second copy.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/** `null` outside a git checkout (a source tarball, an unusual CI checkout). */
function commitHash(): string | null {
  try {
    return execSync('git rev-parse --short=8 HEAD', { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

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

  // Baked in at build time rather than read at runtime: build info is a
  // static fact about this binary, not something worth a Tauri command and a
  // capability grant. Declared in src/vite-env.d.ts.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_COMMIT__: JSON.stringify(commitHash()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
});
