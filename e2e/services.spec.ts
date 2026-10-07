/**
 * Services, driven in a real browser: GitHub's status API answered by
 * Playwright from the real capture in `fixtures/` (see `setGitHub` for the
 * synthetic outage variant).
 *
 * Rounds run every 30s while online, and a healthy service is due every 60s,
 * so reaching its next fetch takes two rounds.
 */

import { expect, test, type Page } from '@playwright/test';

import {
  advanceToNextCheck,
  CURSOR_PAGE,
  GITHUB_PAGE,
  setCursor,
  setGitHub,
  setNetwork,
  startApp,
} from './harness.ts';

const GITHUB_ONLY = {
  services: [
    { id: 'github', name: 'GitHub', kind: 'statuspage', pageUrl: 'https://www.githubstatus.com' },
  ],
};

function githubRow(page: Page) {
  return page.locator('[data-service="github"]');
}

/**
 * Four 30s rounds: a service that has failed twice waits two minutes before
 * its next fetch (the backoff doubles from the 60s poll).
 */
async function pastBackoff(page: Page): Promise<void> {
  for (let round = 0; round < 4; round += 1) await advanceToNextCheck(page, 30);
}

/** Two 30s rounds: the second one is when GitHub is due again. */
async function nextServicePoll(page: Page): Promise<void> {
  await advanceToNextCheck(page, 30);
  await advanceToNextCheck(page, 30);
}

test('lists GitHub as operational from the real capture', async ({ page }) => {
  await startApp(page);

  await expect(githubRow(page)).toHaveAttribute('data-state', 'operational');
  await expect(githubRow(page)).toContainText('GitHub');
  await expect(githubRow(page)).toContainText('operational');
  await expect(page.locator('#empty')).toBeHidden();
});

test('a real Cursor incident pops up with its name and a link to status.cursor.com', async ({
  page,
  context,
}) => {
  await startApp(page, { cursor: 'incident' });

  const popup = page.locator('#popup');
  await expect(popup).toBeVisible();
  await expect(popup).toContainText('Cursor: degraded');
  await expect(popup).toContainText('Investigating service degradation — Grok Bot');

  const [statusPage] = await Promise.all([
    context.waitForEvent('page'),
    popup.getByRole('button', { name: 'View status page' }).click(),
  ]);
  expect(statusPage.url()).toBe(`${CURSOR_PAGE}/`);
});

test('the Cursor row shows the incident under its name', async ({ page }) => {
  await startApp(page, { cursor: 'incident' });
  await page.locator('#popup').getByText('Cursor: degraded').click();

  const row = page.locator('[data-service="cursor"]');
  await expect(row).toHaveAttribute('data-state', 'degraded');
  await expect(page.locator('#hero')).toHaveAttribute('data-tone', 'warn');
  await expect(page.locator('#hero-title')).toHaveText('Cursor is degraded');
  // The headline says what is happening, not how many services there are.
  await expect(page.locator('#hero-detail')).toHaveText(
    'Investigating service degradation — Grok Bot',
  );
  await expect(row).toContainText('Investigating service degradation — Grok Bot');
});

test('two services in trouble share one popup', async ({ page }) => {
  await startApp(page, { github: 'outage', cursor: 'incident' });

  const alerts = page.locator('#popup .alert');
  await expect(alerts).toHaveCount(2);
  await expect(page.locator('#popup')).toContainText('GitHub: major outage');
  await expect(page.locator('#popup')).toContainText('Cursor: degraded');
});

test('Cursor recovering turns its popup into a resolved card with a link', async ({
  page,
  context,
}) => {
  await startApp(page, { cursor: 'incident' });
  await expect(page.locator('#popup')).toContainText('Cursor: degraded');

  await setCursor(page, 'operational');
  await nextServicePoll(page);

  // The same card, now saying it is over: what it was, how bad, how long it was seen.
  const popup = page.locator('#popup');
  await expect(popup).toBeVisible();
  await expect(popup.locator('.alert')).toHaveCount(1);
  await expect(popup).toContainText('Cursor: resolved');
  await expect(popup).not.toContainText('Cursor: degraded');
  await expect(popup).toContainText('Investigating service degradation — Grok Bot');
  await expect(popup).toContainText(/degraded, seen for \d+ min/);
  await expect(popup.locator('.alert')).toHaveAttribute('data-tone', 'good');

  const [statusPage] = await Promise.all([
    context.waitForEvent('page'),
    popup.getByRole('button', { name: 'View status page' }).click(),
  ]);
  expect(statusPage.url()).toBe(`${CURSOR_PAGE}/`);
});

test('pops up on an outage, linking to the status page', async ({ page, context }) => {
  await startApp(page);
  await setGitHub(page, 'outage');
  await nextServicePoll(page);

  const popup = page.locator('#popup');
  await expect(popup).toBeVisible();
  await expect(popup).toContainText('GitHub: major outage');
  await expect(popup).toContainText('Actions');

  const [statusPage] = await Promise.all([
    context.waitForEvent('page'),
    popup.getByRole('button', { name: 'View status page' }).click(),
  ]);
  expect(statusPage.url()).toBe(`${GITHUB_PAGE}/`);
  // Following the link leaves the popup up: it goes when GitHub recovers or when dismissed.
  await expect(popup).toBeVisible();
});

test('a resolved card stays until it is dismissed, then the popup closes', async ({ page }) => {
  await startApp(page, { github: 'outage' });
  await expect(page.locator('#popup')).toContainText('GitHub: major outage');

  await setGitHub(page, 'operational');
  await nextServicePoll(page);

  const popup = page.locator('#popup');
  await expect(popup).toContainText('GitHub: resolved');
  await expect(popup).toContainText(/major outage, seen for \d+ min/);
  await expect(githubRow(page)).toHaveAttribute('data-state', 'operational');

  // No timer takes it down: it is news you may have been away for.
  await advanceToNextCheck(page, 30);
  await advanceToNextCheck(page, 30);
  await expect(popup).toContainText('GitHub: resolved');

  await popup.getByRole('button', { name: 'Dismiss: GitHub: resolved' }).click();
  await expect(popup).toBeHidden();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'panel');
});

test('an outage you dismissed still gets its resolved card', async ({ page }) => {
  await startApp(page, { github: 'outage' });
  await page.getByRole('button', { name: 'Dismiss: GitHub: major outage' }).click();
  await expect(page.locator('#popup')).toBeHidden();

  await setGitHub(page, 'operational');
  await nextServicePoll(page);

  await expect(page.locator('#popup')).toContainText('GitHub: resolved');
});

test('clicking a resolved card opens the panel and does not bring it back', async ({ page }) => {
  await startApp(page, { github: 'outage' });
  await setGitHub(page, 'operational');
  await nextServicePoll(page);
  await page.locator('#popup').getByText('GitHub: resolved').click();

  await expect(page.locator('body')).toHaveAttribute('data-mode', 'panel');
  await expect(page.locator('#panel')).toBeVisible();
  await advanceToNextCheck(page, 30);
  await expect(page.locator('#popup')).toBeHidden();
});

test('a new outage after a resolved card replaces it', async ({ page }) => {
  await startApp(page, { github: 'outage' });
  await setGitHub(page, 'operational');
  await nextServicePoll(page);
  await expect(page.locator('#popup')).toContainText('GitHub: resolved');

  await setGitHub(page, 'outage');
  await nextServicePoll(page);

  const popup = page.locator('#popup');
  await expect(popup).toContainText('GitHub: major outage');
  await expect(popup).not.toContainText('resolved');
});

test('an unreachable status page reads as unknown, and does not pop up', async ({ page }) => {
  await startApp(page);
  await setGitHub(page, 'down');

  await nextServicePoll(page);
  // One failure keeps the last reading.
  await expect(githubRow(page)).toHaveAttribute('data-state', 'operational');

  // The retry after a failure waits a full poll interval: two more rounds.
  await nextServicePoll(page);
  await expect(githubRow(page)).toHaveAttribute('data-state', 'unknown');
  await expect(page.locator('#popup')).toBeHidden();
});

test('a status page that goes dark during an outage is not a recovery', async ({ page }) => {
  await startApp(page, { github: 'outage' });
  await page.getByRole('button', { name: 'Dismiss: GitHub: major outage' }).click();

  // Two failed fetches in a row: the app can no longer see GitHub at all.
  await setGitHub(page, 'down');
  await nextServicePoll(page);
  await nextServicePoll(page);
  await expect(githubRow(page)).toHaveAttribute('data-state', 'unknown');
  await expect(page.locator('#popup')).toBeHidden();

  // It answers again, with the outage still on: still no good news to give.
  await setGitHub(page, 'outage');
  await pastBackoff(page);
  await expect(githubRow(page)).toHaveAttribute('data-state', 'major');
  await expect(page.locator('#popup')).not.toContainText('resolved');

  // Only a real all-clear ends it.
  await setGitHub(page, 'operational');
  await nextServicePoll(page);
  await expect(page.locator('#popup')).toContainText('GitHub: resolved');
});

test('blind then better: the all-clear is announced when sight returns', async ({ page }) => {
  await startApp(page, { github: 'outage' });
  await setGitHub(page, 'down');
  await nextServicePoll(page);
  await nextServicePoll(page);
  await expect(githubRow(page)).toHaveAttribute('data-state', 'unknown');

  await setGitHub(page, 'operational');
  await pastBackoff(page);

  await expect(page.locator('#popup')).toContainText('GitHub: resolved');
});

test('a service you stop watching mid-outage is not reported as resolved', async ({ page }) => {
  await startApp(page, { github: 'outage' });
  await page.locator('#popup').getByText('GitHub: major outage').click();
  await page.getByRole('button', { name: 'Stop watching GitHub' }).click();
  await expect(githubRow(page)).toHaveCount(0);

  await advanceToNextCheck(page, 30);
  await advanceToNextCheck(page, 30);
  await expect(page.locator('#popup')).toBeHidden();
});

test('a page added mid-outage is remembered, so its end is announced', async ({ page }) => {
  await startApp(page, { settings: GITHUB_ONLY, cursor: 'incident' });
  await page.getByRole('button', { name: 'Add a status page' }).click();
  await page.getByLabel('Status page address').fill('status.cursor.com');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('[data-service="status.cursor.com"]')).toHaveAttribute(
    'data-state',
    'degraded',
  );
  // You were just told; no popup for the add itself.
  await expect(page.locator('#popup')).toBeHidden();

  await setCursor(page, 'operational');
  await nextServicePoll(page);
  await expect(page.locator('#popup')).toContainText('Cursor: resolved');
});

test('while the first connection check is still out, a service is checking, not on hold', async ({
  page,
}) => {
  // The probes fail, so the first round ends still "checking" (offline takes two).
  await startApp(page, { network: 'down' });

  await expect(page.locator('#internet')).toHaveAttribute('data-state', 'checking');
  await expect(githubRow(page)).toHaveAttribute('data-state', 'checking');
});

test('offline, services are on hold and only the connection pops up', async ({ page }) => {
  await startApp(page, { github: 'outage' });
  await page
    .locator('#popup')
    .getByRole('button', { name: /Dismiss: GitHub/ })
    .click();

  await setNetwork(page, 'down');
  await advanceToNextCheck(page, 30);
  await advanceToNextCheck(page, 5);

  await expect(page.locator('#popup')).toContainText('No internet connection');
  await expect(page.locator('#popup')).not.toContainText('GitHub');
  await expect(githubRow(page)).toHaveAttribute('data-state', 'hold');
});

test('a service in trouble sorts above one that is fine, regardless of configured order', async ({
  page,
}) => {
  // Cursor is configured second (see DEFAULT_SERVICES); with only it in
  // trouble it should still render first.
  await startApp(page, { cursor: 'incident' });
  await page.locator('#popup').getByText('Cursor: degraded').click();

  const rows = page.locator('[data-service]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-service', 'cursor');
  await expect(rows.nth(1)).toHaveAttribute('data-service', 'github');
});

test('clicking a service row opens its status page', async ({ page, context }) => {
  await startApp(page);

  const [statusPage] = await Promise.all([context.waitForEvent('page'), githubRow(page).click()]);
  expect(statusPage.url()).toBe(`${GITHUB_PAGE}/`);
});
