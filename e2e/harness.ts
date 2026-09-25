/**
 * Shared setup for driving the app in a browser.
 *
 * The clock is frozen so that anything time-based (the poller, "checked 2 min
 * ago") is deterministic once it exists. State will be seeded through the same
 * `localStorage` keys the browser build uses, so no test-only hooks leak into
 * the app itself. Keep it that way.
 */

import type { Page } from '@playwright/test';

/** A fixed Monday, 10:30 local. */
export const MONDAY_1030 = new Date(2026, 7, 3, 10, 30);

export interface SeedOptions {
  /** Simulated wall-clock time. */
  now?: Date;
}

/** Freeze the clock, start from empty storage, and load the app. */
export async function startApp(page: Page, options: SeedOptions = {}): Promise<void> {
  await page.clock.install({ time: options.now ?? MONDAY_1030 });
  await page.addInitScript(() => {
    localStorage.clear();
  });
  await page.goto('/');
  // Let startup awaits flush.
  await page.clock.runFor(100);
}
