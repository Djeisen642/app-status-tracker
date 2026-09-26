/**
 * Screenshot capture.
 *
 * These are tests rather than a separate script on purpose: each one asserts the
 * panel actually rendered before saving, so a broken build produces a failure
 * instead of a picture of a blank window. The images land in `docs/screenshots/`
 * for eyeballing a change.
 *
 * Run just these with:
 *   pnpm run e2e -- capture
 */

import { expect, test } from '@playwright/test';

import { advanceToNextCheck, startApp } from './harness.ts';

const SHOTS = 'docs/screenshots';

/** Match the real Tauri window so the shots show true proportions. */
test.use({ viewport: { width: 360, height: 440 } });

for (const colorScheme of ['light', 'dark'] as const) {
  test(`capture: the panel (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await startApp(page);

    await expect(page.locator('#internet')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('[data-service="github"]')).toHaveAttribute(
      'data-state',
      'operational',
    );
    await page.screenshot({ path: `${SHOTS}/panel-${colorScheme}.png` });
  });

  test(`capture: the real Cursor incident popup (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await startApp(page, { cursor: 'incident' });

    const popup = page.locator('#popup');
    await expect(popup).toContainText('Cursor: degraded');
    await popup.screenshot({ path: `${SHOTS}/popup-cursor-${colorScheme}.png` });
  });

  test(`capture: the GitHub outage popup (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    // SYNTHETIC outage: see `setGitHub` in the harness.
    await startApp(page, { github: 'outage' });

    const popup = page.locator('#popup');
    await expect(popup).toContainText('GitHub: major outage');
    await popup.screenshot({ path: `${SHOTS}/popup-github-${colorScheme}.png` });
  });

  test(`capture: the panel during an outage (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await startApp(page, { github: 'outage' });
    await page.locator('#popup').getByText('GitHub: major outage').click();

    await expect(page.locator('[data-service="github"]')).toHaveAttribute('data-state', 'major');
    await page.screenshot({ path: `${SHOTS}/panel-outage-${colorScheme}.png` });
  });

  test(`capture: the offline popup (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await startApp(page, { network: 'down' });
    await advanceToNextCheck(page, 5);

    const popup = page.locator('#popup');
    await expect(popup).toBeVisible();
    // The real window is sized to the popup, so capture just that.
    await popup.screenshot({ path: `${SHOTS}/popup-offline-${colorScheme}.png` });
  });

  test(`capture: the panel, offline (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await startApp(page, { network: 'down' });
    await advanceToNextCheck(page, 5);
    // Clicking the popup is how you get from it to the panel.
    await page.locator('#popup').getByText('No internet connection').click();

    await expect(page.locator('#internet')).toHaveAttribute('data-state', 'offline');
    await page.screenshot({ path: `${SHOTS}/offline-${colorScheme}.png` });
  });

  test(`capture: the add form refusing a site (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await startApp(page);
    await page.route('https://example.com/api/v2/summary.json', (route) =>
      route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' }),
    );
    await page.getByRole('button', { name: 'Add a status page' }).click();
    await page.getByLabel('Status page address').fill('example.com');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.locator('#add-message')).toHaveAttribute('data-tone', 'error');
    await page.screenshot({ path: `${SHOTS}/add-refused-${colorScheme}.png` });
  });
}
