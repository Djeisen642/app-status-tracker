/**
 * The popup, driven in a real browser.
 *
 * In a browser there is no window to shrink, so "the popup is showing" is the
 * page switching to popup mode (`body[data-mode="popup"]`). Whether the real
 * window appears without taking focus can only be checked on a desktop.
 *
 * The internet connection is the only check that can go bad so far. A captive
 * portal can't be simulated here (a `no-cors` fetch hides the redirect), so
 * the sign-in link is covered by the unit tests in `alerts.test.ts`.
 */

import { expect, test, type Page } from '@playwright/test';

import { advanceToNextCheck, setNetwork, startApp } from './harness.ts';

function popup(page: Page) {
  return page.locator('#popup');
}

async function goOffline(page: Page): Promise<void> {
  await setNetwork(page, 'down');
  // Two failed rounds: the next scheduled check at 30s, then the quick recheck.
  await advanceToNextCheck(page, 30);
  await advanceToNextCheck(page, 5);
}

test('stays out of the way while everything is fine', async ({ page }) => {
  await startApp(page);

  await expect(page.locator('#internet')).toHaveAttribute('data-state', 'online');
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'panel');
  await expect(popup(page)).toBeHidden();
});

test('pops up when the connection goes, and closes itself when it comes back', async ({ page }) => {
  await startApp(page);
  await goOffline(page);

  await expect(page.locator('body')).toHaveAttribute('data-mode', 'popup');
  await expect(popup(page)).toBeVisible();
  await expect(popup(page)).toContainText('No internet connection');
  // Nothing to open while offline, so no link is offered.
  await expect(popup(page).locator('.alert-link')).toHaveCount(0);
  await expect(page.locator('#panel')).toBeHidden();

  await setNetwork(page, 'up');
  await advanceToNextCheck(page, 10);

  await expect(page.locator('body')).toHaveAttribute('data-mode', 'panel');
  await expect(popup(page)).toBeHidden();
});

test('a dismissed popup stays away until the next outage', async ({ page }) => {
  await startApp(page);
  await goOffline(page);
  await expect(popup(page)).toBeVisible();

  await page.getByRole('button', { name: 'Dismiss: No internet connection' }).click();
  await expect(popup(page)).toBeHidden();

  // Still offline, several checks later: not back.
  await advanceToNextCheck(page, 30);
  await expect(popup(page)).toBeHidden();

  // Recover, then lose it again: that is a new outage, so it pops again.
  await setNetwork(page, 'up');
  await advanceToNextCheck(page, 10);
  await expect(page.locator('#internet')).toHaveAttribute('data-state', 'online');
  await goOffline(page);
  await expect(popup(page)).toBeVisible();
});

test('clicking the popup opens the full panel, and it does not pop again', async ({ page }) => {
  await startApp(page);
  await goOffline(page);

  await popup(page).getByText('No internet connection').click();

  await expect(page.locator('body')).toHaveAttribute('data-mode', 'panel');
  await expect(page.locator('#panel')).toBeVisible();
  await expect(page.locator('#internet')).toHaveAttribute('data-state', 'offline');

  await advanceToNextCheck(page, 30);
  await expect(popup(page)).toBeHidden();
});

test('pops up at launch if the connection is already down', async ({ page }) => {
  await startApp(page, { network: 'down' });
  await advanceToNextCheck(page, 5);

  await expect(popup(page)).toBeVisible();
  await expect(popup(page)).toContainText('No internet connection');
});
