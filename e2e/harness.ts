/**
 * Shared setup for driving the app in a browser.
 *
 * The clock is frozen so the connectivity check's timer is deterministic, and
 * the network is controlled from outside the page: Playwright's own routing
 * answers the probe URLs, and `context.setOffline` flips `navigator.onLine`.
 * No test-only hooks leak into the app itself. Keep it that way.
 */

import { readFileSync } from 'node:fs';

import { expect, type Page } from '@playwright/test';

import { PROBES } from '../src/lib/connectivity.ts';
import { apiUrl, DEFAULT_SERVICES } from '../src/lib/services.ts';

/** A fixed Monday, 10:30 local. */
export const MONDAY_1030 = new Date(2026, 7, 3, 10, 30);

/** How the probe endpoints behave: `up` answers them, `down` drops them. */
export type Network = 'up' | 'down';

/**
 * What GitHub's status API answers.
 *
 * `operational` is the real capture in `fixtures/`, served as-is. `outage` is
 * SYNTHETIC: that capture with Actions set to `major_outage`, Statuspage's
 * documented value, for driving the UI through a bad state. It proves the app
 * reacts to the value, not that GitHub's API sends it that way. `down` fails
 * the request outright.
 */
export type GitHubState = 'operational' | 'outage' | 'down';

const GITHUB_OPERATIONAL = readFileSync(
  new URL('../fixtures/statuspage/github-2026-09-25-operational.json', import.meta.url),
  'utf8',
);

function githubBody(state: 'operational' | 'outage'): string {
  if (state === 'operational') return GITHUB_OPERATIONAL;
  const summary = JSON.parse(GITHUB_OPERATIONAL) as {
    components: { name: string; status: string }[];
  };
  for (const component of summary.components) {
    if (component.name === 'Actions') component.status = 'major_outage';
  }
  return JSON.stringify(summary);
}

/**
 * What Cursor's status API answers.
 *
 * `incident` is the real capture in `fixtures/`: Grok Bot degraded, indicator
 * `minor`, one open incident. `operational` is SYNTHETIC: that capture with
 * every component set operational, the indicator `none` and no incidents, so
 * specs that aren't about Cursor start from a quiet page. `down` fails the
 * request outright.
 */
export type CursorState = 'operational' | 'incident' | 'down';

const CURSOR_INCIDENT = readFileSync(
  new URL('../fixtures/statuspage/cursor-2026-09-25-incident.json', import.meta.url),
  'utf8',
);

function cursorBody(state: 'operational' | 'incident'): string {
  if (state === 'incident') return CURSOR_INCIDENT;
  const summary = JSON.parse(CURSOR_INCIDENT) as {
    components: { status: string }[];
    incidents: unknown[];
    status: { indicator: string; description: string };
  };
  for (const component of summary.components) component.status = 'operational';
  summary.incidents = [];
  summary.status = { indicator: 'none', description: 'All Systems Operational' };
  return JSON.stringify(summary);
}

function service(id: string) {
  const found = DEFAULT_SERVICES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`${id} is no longer a default service`);
  return found;
}

const GITHUB = service('github');
const CURSOR = service('cursor');
export const GITHUB_PAGE = GITHUB.pageUrl;
export const CURSOR_PAGE = CURSOR.pageUrl;

export interface SeedOptions {
  /** Simulated wall-clock time. */
  now?: Date;
  /** The probe endpoints' behavior at launch. Defaults to `up`. */
  network?: Network;
  /** GitHub's status API at launch. Defaults to `operational`. */
  github?: GitHubState;
  /** Cursor's status API at launch. Defaults to `operational` (synthetic). */
  cursor?: CursorState;
}

/** Freeze the clock, start from empty storage, and load the app. */
export async function startApp(page: Page, options: SeedOptions = {}): Promise<void> {
  await page.clock.install({ time: options.now ?? MONDAY_1030 });
  await setNetwork(page, options.network ?? 'up');
  await setGitHub(page, options.github ?? 'operational');
  await setCursor(page, options.cursor ?? 'operational');
  // The status pages themselves, for when a link to one is followed.
  for (const pageUrl of [GITHUB_PAGE, CURSOR_PAGE]) {
    await page
      .context()
      .route(`${pageUrl}/`, (route) =>
        route.fulfill({ contentType: 'text/html', body: '<title>Status</title>' }),
      );
  }
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

/** Answer GitHub's status API with `state` from now on. Never the real network. */
export async function setGitHub(page: Page, state: GitHubState): Promise<void> {
  await answer(page, apiUrl(GITHUB), state === 'down' ? null : githubBody(state));
}

/** Answer Cursor's status API with `state` from now on. Never the real network. */
export async function setCursor(page: Page, state: CursorState): Promise<void> {
  await answer(page, apiUrl(CURSOR), state === 'down' ? null : cursorBody(state));
}

/** Serve `body` as a status API's JSON, or refuse the connection when `null`. */
async function answer(page: Page, url: string, body: string | null): Promise<void> {
  await page.unroute(url);
  await page.route(url, (route) =>
    body === null
      ? route.abort('connectionrefused')
      : route.fulfill({
          contentType: 'application/json',
          // The page is served from localhost; this is a cross-origin read.
          headers: { 'Access-Control-Allow-Origin': '*' },
          body,
        }),
  );
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
