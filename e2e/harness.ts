/**
 * Shared setup for driving the app in a browser.
 *
 * The clock is frozen so the connectivity check's timer is deterministic, and
 * the network is controlled from outside the page: Playwright's own routing
 * answers the probe URLs, and `context.setOffline` flips `navigator.onLine`.
 * No test-only hooks leak into the app itself. Keep it that way.
 */

import type { Page } from '@playwright/test';

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
  // Let startup awaits flush.
  await page.clock.runFor(100);
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

/** Advance the simulated clock by `seconds`, letting the check's timers fire. */
export async function advanceSeconds(page: Page, seconds: number): Promise<void> {
  await page.clock.runFor(seconds * 1000);
}
