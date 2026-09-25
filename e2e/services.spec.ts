/**
 * Services, driven in a real browser: GitHub's status API answered by
 * Playwright from the real capture in `fixtures/` (see `setGitHub` for the
 * synthetic outage variant).
 *
 * Rounds run every 30s while online, and a healthy service is due every 60s,
 * so reaching its next fetch takes two rounds.
 */

import { expect, test, type Page } from '@playwright/test';

import { advanceToNextCheck, GITHUB_PAGE, setGitHub, setNetwork, startApp } from './harness.ts';

function githubRow(page: Page) {
  return page.locator('[data-service="github"]');
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

test('the popup closes by itself when GitHub recovers', async ({ page }) => {
  await startApp(page, { github: 'outage' });
  await expect(page.locator('#popup')).toBeVisible();

  await setGitHub(page, 'operational');
  await nextServicePoll(page);

  await expect(page.locator('#popup')).toBeHidden();
  await expect(githubRow(page)).toHaveAttribute('data-state', 'operational');
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

test('clicking a service row opens its status page', async ({ page, context }) => {
  await startApp(page);

  const [statusPage] = await Promise.all([context.waitForEvent('page'), githubRow(page).click()]);
  expect(statusPage.url()).toBe(`${GITHUB_PAGE}/`);
});
