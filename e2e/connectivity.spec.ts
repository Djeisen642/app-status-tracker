/**
 * The internet connection check, driven in a real browser.
 *
 * The browser build can't see a captive portal (a cross-origin `no-cors`
 * fetch hides the answer), so portal detection is covered by the unit tests
 * on `judgeProbe`. Everything else here runs the real controller and timer.
 */

import { expect, test, type Page } from '@playwright/test';

import { advanceToNextCheck, setNetwork, startApp } from './harness.ts';

function internetRow(page: Page) {
  return page.locator('#internet');
}

test('reports connected when the probes answer', async ({ page }) => {
  await startApp(page);

  await expect(internetRow(page)).toHaveAttribute('data-state', 'online');
  await expect(internetRow(page)).toContainText('connected');
  await expect(page.locator('#offline-note')).toBeHidden();
});

test('says offline at once when the OS reports no network', async ({ page, context }) => {
  await startApp(page);
  await expect(internetRow(page)).toHaveAttribute('data-state', 'online');

  await context.setOffline(true);

  await expect(internetRow(page)).toHaveAttribute('data-state', 'offline');
  await expect(page.locator('#offline-note')).toContainText('on hold');

  await context.setOffline(false);

  await expect(internetRow(page)).toHaveAttribute('data-state', 'online');
  await expect(page.locator('#offline-note')).toBeHidden();
});

test('waits for a second failed round before saying offline', async ({ page }) => {
  await startApp(page);
  await expect(internetRow(page)).toHaveAttribute('data-state', 'online');

  // The network interface is up but nothing gets through: a dead router.
  await setNetwork(page, 'down');

  await advanceToNextCheck(page, 30);
  await expect(internetRow(page)).toHaveAttribute('data-state', 'online');

  await advanceToNextCheck(page, 5);
  await expect(internetRow(page)).toHaveAttribute('data-state', 'offline');

  await setNetwork(page, 'up');
  await advanceToNextCheck(page, 10);
  await expect(internetRow(page)).toHaveAttribute('data-state', 'online');
});

test('starting with no way out ends up offline, not stuck on checking', async ({ page }) => {
  await startApp(page, { network: 'down' });
  await expect(internetRow(page)).toHaveAttribute('data-state', 'checking');

  await advanceToNextCheck(page, 5);
  await expect(internetRow(page)).toHaveAttribute('data-state', 'offline');
});
