/**
 * The panel, driven in a real browser.
 *
 * Phase 0 has nothing to fetch, so this proves the shell: the controller finds
 * its elements, starts without throwing, and shows the empty state rather than
 * a blank window.
 */

import { expect, test } from '@playwright/test';

import { startApp } from './harness.ts';

test('starts on the empty state with nothing to watch', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await startApp(page);

  await expect(page.getByRole('heading', { name: 'Service status' })).toBeVisible();
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.getByText('No services yet')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the close button is reachable from the keyboard', async ({ page }) => {
  await startApp(page);

  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();
});
