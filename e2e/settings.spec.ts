/**
 * The Settings overlay: opens over the panel, shows build info, and closes
 * without leaking focus or closing the window underneath it.
 */

import { expect, test } from '@playwright/test';

import { startApp } from './harness.ts';

test('opens over the panel showing build info, and closes with its own button', async ({
  page,
}) => {
  await startApp(page);

  await expect(page.locator('#settings')).toBeHidden();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#settings')).toBeVisible();
  // The version this was built from; the commit and date vary per build.
  await expect(page.locator('#build-info')).toContainText(/^\d+\.\d+\.\d+/);

  await page.locator('#settings-close').click();
  await expect(page.locator('#settings')).toBeHidden();
  // Closing the overlay must not have closed the panel underneath it.
  await expect(page.locator('#panel')).toBeVisible();
});

test('Esc closes Settings first, without closing the panel', async ({ page }) => {
  await startApp(page);

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#settings')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('#settings')).toBeHidden();
  await expect(page.locator('#panel')).toBeVisible();
});

test('the covered panel is inert while Settings is open, not just hidden behind it', async ({
  page,
}) => {
  await startApp(page);

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#settings')).toBeVisible();

  // Tab from the sheet's own close button must not escape into the panel
  // it's covering: no invisible close button, add-open button or row to land
  // on. It's the only focusable element while the sheet is open, so Tab
  // simply has nowhere else in the document to go.
  await page.locator('#settings-close').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#close')).not.toBeFocused();
  await expect(page.locator('#add-open')).not.toBeFocused();
});
