import { expect, test } from './fixtures';

/**
 * Real-page contract for the online Minesweeper entry (#537 t1, replaying
 * #533): the hub links to `#/online/minesweeper`, the shell lazily mounts the
 * real room view, `?room=` is forwarded, leaving the route destroys the room,
 * and a failed lazy chunk stays retryable.
 *
 * The room service started by `playwright.config.ts` is not exercised here:
 * this spec only covers the shell's entry seam, which stops at the room's
 * create/join screen. The two-process seam itself is locked by
 * `online-server-smoke.spec.ts`.
 */

const ONLINE_ROOM = '[data-testid="online-room"]';
const HUB_ENTRY = 'enter-online-minesweeper';

test.describe('online Minesweeper entry', () => {
  test('links from the hub and mounts the real room after a click', async ({ page }) => {
    await page.goto('/#/');

    const entry = page.getByTestId(HUB_ENTRY);
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute('href', '#/online/minesweeper');

    await entry.click();

    await expect(page.locator(ONLINE_ROOM)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('create-form')).toBeVisible();
    await expect(page.getByTestId('join-form')).toBeVisible();
    await expect(page).toHaveTitle('联机扫雷 · Playground Arcade');
    expect(new URL(page.url()).hash).toBe('#/online/minesweeper');
  });

  test('forwards the ?room= id to the room view', async ({ page }) => {
    await page.goto('/#/online/minesweeper?room=room_demo');

    await expect(page.locator(ONLINE_ROOM)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('join-room-id')).toHaveValue('room_demo');
    await expect(page.getByTestId('share-link')).toHaveAttribute(
      'href',
      '#/online/minesweeper?room=room_demo',
    );
    await expect(page.getByTestId('share-prefill')).toBeVisible();
  });

  test('removes the room DOM after leaving the route and remounts only one copy', async ({
    page,
  }) => {
    await page.goto('/#/online/minesweeper');
    await expect(page.locator(ONLINE_ROOM)).toBeVisible({ timeout: 10_000 });

    // A real hash navigation through the site shell, not a full page reload.
    await page.getByRole('link', { name: '大厅', exact: true }).click();

    await expect(page.locator(ONLINE_ROOM)).toHaveCount(0);
    await expect(page.getByTestId(HUB_ENTRY)).toBeVisible();

    // Re-entering creates exactly one fresh room, never a leftover second copy.
    await page.getByTestId(HUB_ENTRY).click();
    await expect(page.locator(ONLINE_ROOM)).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId('create-form')).toBeVisible();
  });

  test('shows a retryable error when the lazy chunk fails, then retries', async ({
    page,
  }) => {
    let blocked = true;
    await page.route('**/online-room-*.js', async (route) => {
      if (blocked) {
        await route.abort('failed');
      } else {
        await route.continue();
      }
    });

    await page.goto('/#/online/minesweeper');

    const retry = page.locator('#view [data-action="retry"]');
    await expect(retry).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: '联机房间加载失败' })).toBeVisible();
    await expect(page).toHaveTitle('联机房间加载失败 · Playground Arcade');
    await expect(page.locator(ONLINE_ROOM)).toHaveCount(0);

    blocked = false;
    await retry.click();

    await expect(page.locator(ONLINE_ROOM)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('create-form')).toBeVisible();
    await expect(page.getByRole('heading', { name: '联机房间加载失败' })).toHaveCount(0);
  });
});
