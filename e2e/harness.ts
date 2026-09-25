/**
 * Shared setup for driving the app in a browser.
 *
 * The clock is frozen so the connectivity check's timer is deterministic, and
 * the network is controlled from outside the page: Playwright's own routing
 * answers the probe URLs, and `context.setOffline` flips `navigator.onLine`.
 * No test-only hooks leak into the app itself. Keep it that way.
 */

import { expect, type Page } from '@playwright/test';

import { PROBES } from '../src/lib/connectivity.ts';

/** A fixed Monday, 10:30 local. */
export const MONDAY_1030 = new Date(2026, 7, 3, 10, 30);

/** How the probe endpoints behave: `up` answers them, `down` drops them. */
export type Network = 'up' | 'down';

export interface SeedOptions {
  /** Simulated wall-clock time. */
  now?: Date;
  /** The probe endpoints' behavior at launch. Defaults to `up`. */
  network?: Network;
}

/** Freeze the clock, start from empty storage, and load the app. */
export async function startApp(page: Page, options: SeedOptions = {}): Promise<void> {
  await page.clock.install({ time: options.now ?? MONDAY_1030 });
  await setNetwork(page, options.network ?? 'up');
  await page.addInitScript(() => {
    localStorage.clear();
  });
  await page.goto('/');
  // Let startup awaits flush, then wait for the first check to land.
  await page.clock.runFor(100);
  await expect(page.locator('#internet')).toHaveAttribute('title', /Last checked/);
}

/**
 * Answer or drop the probe endpoints from now on.
 *
 * Every probe is routed, never left to the real network: the sandbox and CI
 * may block these hosts, and a test must not depend on whether they do.
 */
export async function setNetwork(page: Page, network: Network): Promise<void> {
  for (const probe of PROBES) {
    await page.unroute(probe.url);
    await page.route(probe.url, (route) =>
      network === 'up'
        ? route.fulfill({ status: probe.expectStatus, body: probe.expectBody ?? '' })
        : route.abort('internetdisconnected'),
    );
  }
}

/**
 * Advance the simulated clock by `seconds`, which must reach the next scheduled
 * check, and wait for that check to finish.
 *
 * Firing the timer is not enough. The probes are real `fetch`es answered by
 * Playwright's router on *real* time, so the check completes, and schedules
 * the one after it, some real milliseconds later. Advancing the fake clock
 * again before then skips the next check entirely. So wait for the Internet
 * row's "Last checked" time to move, which it does at the end of every round.
 */
export async function advanceToNextCheck(page: Page, seconds: number): Promise<void> {
  const row = page.locator('#internet');
  const before = (await row.getAttribute('title')) ?? '';
  await page.clock.runFor(seconds * 1000);
  await expect(row).not.toHaveAttribute('title', before);
}
