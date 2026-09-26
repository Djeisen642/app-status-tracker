import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke tests: the real app, driven in a real browser.
 *
 * The unit suite covers pure logic exhaustively, but nothing in it proves the
 * app *runs*: that `main.ts` finds its elements, that the panel renders what
 * the model says. A typo in `mustGet('service-list')` passes lint, typecheck,
 * tests and the bundle, and ships a blank window.
 *
 * This is possible only because the frontend is deliberately framework-free and
 * browser-runnable: `tauri.ts` guards every native call behind `isTauri()`. So
 * the browser exercises the same controller and the same rendering the desktop
 * build uses, everything except the native shell.
 */
/**
 * Escape hatch for environments that already have a Chromium and can't download
 * Playwright's pinned build — CI images, locked-down networks, container
 * sandboxes. Unset (the normal case) Playwright uses its own managed browser.
 */
const systemChromium = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  outputDir: './e2e/.results',

  use: {
    baseURL: 'http://localhost:1440',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(systemChromium === undefined
          ? {}
          : { launchOptions: { executablePath: systemChromium } }),
      },
    },
  ],

  // Reuse a dev server if one is already up, so `pnpm run dev` in another
  // terminal doubles as the harness during development.
  webServer: {
    command: 'pnpm run dev',
    url: 'http://localhost:1440',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
