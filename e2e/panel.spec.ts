/**
 * The panel, driven in a real browser.
 *
 * The shell: the controller finds its elements and starts without throwing,
 * rather than shipping a blank window.
 */

import { expect, test } from '@playwright/test';

import { startApp } from './harness.ts';

test('starts cleanly, with the connection first and the services under it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await startApp(page);

  await expect(page.getByRole('heading', { name: 'Service status' })).toBeVisible();
  await expect(page.locator('#internet')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Services' })).toContainText('GitHub');
  expect(errors).toEqual([]);
});

test('the close button is reachable from the keyboard', async ({ page }) => {
  await startApp(page);

  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();
});
