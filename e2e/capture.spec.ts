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

import { advanceSeconds, startApp } from './harness.ts';

const SHOTS = 'docs/screenshots';

/** Match the real Tauri window so the shots show true proportions. */
test.use({ viewport: { width: 360, height: 440 } });

for (const colorScheme of ['light', 'dark'] as const) {
  test(`capture: the empty panel (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await startApp(page);

    await expect(page.getByText('No services yet')).toBeVisible();
    await expect(page.locator('#internet')).toHaveAttribute('data-state', 'online');
    await page.screenshot({ path: `${SHOTS}/empty-${colorScheme}.png` });
  });

  test(`capture: offline (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await startApp(page, { network: 'down' });
    await advanceSeconds(page, 5);

    await expect(page.locator('#internet')).toHaveAttribute('data-state', 'offline');
    await page.screenshot({ path: `${SHOTS}/offline-${colorScheme}.png` });
  });
}
