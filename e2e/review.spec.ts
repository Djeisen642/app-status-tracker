/**
 * Regressions from the adversarial review, one spec per finding a browser can
 * reproduce. Each failed before its fix. The rest (overlapping saves, the
 * popup's first frame, a tray update that fails once) are native or timing
 * bound and are covered in unit tests or by reasoning, as noted in CLAUDE.md.
 */

import { expect, test } from '@playwright/test';

import {
  advanceToNextCheck,
  readSavedSettings,
  setGitHub,
  setNetwork,
  startApp,
} from './harness.ts';

test('an unreadable settings file is never saved over', async ({ page }) => {
  const broken = '{"services": [ this is not json';
  await startApp(page, { settingsText: broken });

  // The defaults run, and the panel says why nothing will be saved.
  await expect(page.locator('#settings-problem')).toBeVisible();
  await expect(page.locator('[data-service]')).toHaveCount(2);

  await page.getByRole('button', { name: 'Add a status page' }).click();
  await page.getByLabel('Status page address').fill('status.cursor.com');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#add-message')).toContainText('couldn’t be read');

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Stop watching GitHub' }).click();
  await expect(page.locator('[data-service="github"]')).toBeVisible();

  // The file on disk is exactly what it was.
  const raw = await page.evaluate(() => localStorage.getItem('app-status-tracker:settings'));
  expect(raw).toBe(broken);
});

test('a dismissed outage stays dismissed through a Wi-Fi blip', async ({ page }) => {
  await startApp(page, { github: 'outage' });
  await page.getByRole('button', { name: 'Dismiss: GitHub: major outage' }).click();
  await expect(page.locator('#popup')).toBeHidden();

  // Offline for two rounds: only the connection pops up.
  await setNetwork(page, 'down');
  await advanceToNextCheck(page, 30);
  await advanceToNextCheck(page, 5);
  await expect(page.locator('#popup')).toContainText('No internet connection');

  // Back online, same outage: the connection's popup closes and GitHub's
  // dismissal holds.
  await setNetwork(page, 'up');
  await advanceToNextCheck(page, 10);
  await expect(page.locator('#internet')).toHaveAttribute('data-state', 'online');
  await expect(page.locator('#popup')).toBeHidden();
});

test('a dismissed outage that eases does not pop up again', async ({ page }) => {
  await startApp(page, { github: 'outage' });
  await page.getByRole('button', { name: 'Dismiss: GitHub: major outage' }).click();

  await setGitHub(page, 'degraded');
  await advanceToNextCheck(page, 30);
  await advanceToNextCheck(page, 30);

  await expect(page.locator('[data-service="github"]')).toHaveAttribute('data-state', 'degraded');
  await expect(page.locator('#popup')).toBeHidden();
});

test('keyboard focus on a service survives the list refreshing', async ({ page }) => {
  await startApp(page);
  const github = page.locator('[data-service="github"]');
  await github.focus();

  await advanceToNextCheck(page, 30);
  await advanceToNextCheck(page, 30);

  await expect(github).toBeFocused();
});

test('what was saved is read back, including entries this build does not know', async ({
  page,
}) => {
  const future = { id: 'x', name: 'Future', kind: 'instatus', pageUrl: 'https://x.example' };
  await startApp(page, {
    settings: {
      theme: 'dark',
      services: [
        {
          id: 'github',
          name: 'GitHub',
          kind: 'statuspage',
          pageUrl: 'https://www.githubstatus.com',
        },
        future,
      ],
    },
  });

  await page.getByRole('button', { name: 'Stop watching GitHub' }).click();
  await expect(page.locator('[data-service="github"]')).toHaveCount(0);

  expect(await readSavedSettings(page)).toEqual({ theme: 'dark', services: [future] });
});
