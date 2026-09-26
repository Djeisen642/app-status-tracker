/**
 * Adding a status page: it is checked before it is added, and refused with a
 * reason when it can't be watched.
 *
 * Every site's API is answered by Playwright, never the real network. The
 * supported cases serve real captures from `fixtures/`.
 */

import { expect, test, type Page } from '@playwright/test';

import { CURSOR_PAGE, GITHUB_PAGE, readSavedSettings, setStatusApi, startApp } from './harness.ts';

const GITHUB_ONLY = {
  services: [
    { id: 'github', name: 'GitHub', kind: 'statuspage', pageUrl: 'https://www.githubstatus.com' },
  ],
};

function message(page: Page) {
  return page.locator('#add-message');
}

async function add(page: Page, address: string): Promise<void> {
  if (await page.locator('#add-form').isHidden()) {
    await page.getByRole('button', { name: '+ Add a status page' }).click();
  }
  await page.getByLabel('Status page address').fill(address);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
}

test('a supported page is checked, added, and shows its state straight away', async ({ page }) => {
  await startApp(page, { settings: GITHUB_ONLY, cursor: 'incident' });
  await expect(page.locator('[data-service]')).toHaveCount(1);

  await add(page, 'status.cursor.com');

  await expect(message(page)).toHaveText('Added Cursor: 8 components, currently degraded.');
  await expect(message(page)).toHaveAttribute('data-tone', 'success');
  const row = page.locator('[data-service="status.cursor.com"]');
  await expect(row).toHaveAttribute('data-state', 'degraded');
  // You were just told it's degraded: no popup announcing it as news.
  await expect(page.locator('#popup')).toBeHidden();
});

test('what was added survives a restart', async ({ page }) => {
  await startApp(page, { settings: GITHUB_ONLY });
  await add(page, 'status.cursor.com');
  await expect(message(page)).toHaveAttribute('data-tone', 'success');

  expect(await readSavedSettings(page)).toEqual({
    services: [
      GITHUB_ONLY.services[0],
      { id: 'status.cursor.com', name: 'Cursor', kind: 'statuspage', pageUrl: CURSOR_PAGE },
    ],
  });

  await page.reload();
  await page.clock.runFor(100);
  await expect(page.locator('[data-service="status.cursor.com"]')).toBeVisible();
});

test('a site without a Statuspage API is refused, with what is supported', async ({ page }) => {
  await startApp(page);
  await setStatusApi(page, 'https://example.com', '<html>Not Found</html>', 404);

  await add(page, 'https://example.com/status');

  await expect(message(page)).toHaveAttribute('data-tone', 'error');
  await expect(message(page)).toContainText('example.com isn’t a supported status page');
  await expect(message(page)).toContainText('Atlassian Statuspage');
  await expect(page.locator('[data-service]')).toHaveCount(2);
});

test('a page that answers with a homepage instead of a summary is refused', async ({ page }) => {
  await startApp(page);
  await setStatusApi(page, 'https://status.example.org', '<!doctype html><title>Hi</title>');

  await add(page, 'status.example.org');

  await expect(message(page)).toContainText('isn’t a supported status page');
});

test('an unreachable site is reported as unreachable, not as unsupported', async ({ page }) => {
  await startApp(page);
  await setStatusApi(page, 'https://status.nowhere.example', null);

  await add(page, 'status.nowhere.example');

  await expect(message(page)).toContainText('Couldn’t reach status.nowhere.example');
});

test('something that is not a web address is refused before anything is fetched', async ({
  page,
}) => {
  await startApp(page);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v2/summary.json')) requests.push(request.url());
  });

  await add(page, 'localhost');
  await expect(message(page)).toContainText('isn’t a public web address');

  await add(page, 'file:///etc/passwd');
  await expect(message(page)).toContainText('Only web addresses');
  expect(requests).toEqual([]);
});

/*
 * The same page reached through a redirect (status.github.com →
 * www.githubstatus.com) is refused too, but that can't be driven here: a
 * cross-origin fetch in the browser build doesn't follow a redirect Playwright
 * fakes. On the desktop Rust follows it (fetch.rs tests that), and the verdict
 * on where it landed is unit-tested in candidate.test.ts.
 */
test('a page already watched is refused without being fetched again', async ({ page }) => {
  await startApp(page);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v2/summary.json')) requests.push(request.url());
  });

  await add(page, `${GITHUB_PAGE}/incidents/abc`);

  await expect(message(page)).toHaveText('You’re already watching this page, as “GitHub”.');
  await expect(page.locator('[data-service]')).toHaveCount(2);
  expect(requests).toEqual([]);
});

test('removing a service stops watching it, and is saved', async ({ page }) => {
  await startApp(page);

  await page.getByRole('button', { name: 'Stop watching Cursor' }).click();

  await expect(page.locator('[data-service="cursor"]')).toHaveCount(0);
  expect(await readSavedSettings(page)).toEqual(GITHUB_ONLY);
});

test('a service removed while its fetch is out stays removed', async ({ page }) => {
  await startApp(page);
  // Hold Cursor's next answer until the service has been removed.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('https://status.cursor.com/api/v2/summary.json', async (route) => {
    await held;
    await route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' } });
  });

  await page.clock.runFor(60_000);
  await page.getByRole('button', { name: 'Stop watching Cursor' }).click();
  release();

  await expect(page.locator('#internet')).toHaveAttribute('title', /Last checked/);
  await page.clock.runFor(30_000);
  await expect(page.locator('[data-service="cursor"]')).toHaveCount(0);
  await expect(page.locator('#popup')).toBeHidden();
});

test('Esc backs out of the add form without closing anything else', async ({ page }) => {
  await startApp(page);
  await page.getByRole('button', { name: '+ Add a status page' }).click();
  await expect(page.getByLabel('Status page address')).toBeFocused();

  await page.keyboard.press('Escape');

  await expect(page.locator('#add-form')).toBeHidden();
  await expect(page.getByRole('button', { name: '+ Add a status page' })).toBeFocused();
});
