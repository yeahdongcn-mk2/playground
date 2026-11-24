import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

test.use({ viewport: { width: 320, height: 640 } });

/**
 * 320x640 is the documented minimum viewport. The stage may extend past the
 * fold, but the three gesture hints are the onboarding copy and must be read
 * without scrolling (issue #250 t2 review).
 */
test('shows the three gesture hints inside the 320x640 first screen', async ({ page }) => {
  await page.goto('/#/games/zhen-sha');

  const hints = page.getByTestId('gesture-hints');
  await expect(hints).toBeVisible();
  await expect(hints.locator('li')).toHaveCount(3);

  const hintsBox = await hints.boundingBox();
  expect(hintsBox).not.toBeNull();
  expect(hintsBox!.y).toBeGreaterThanOrEqual(0);
  expect(hintsBox!.y + hintsBox!.height).toBeLessThanOrEqual(640);

  // On phones the hints lead the stage so they are not pushed below the fold by
  // the tall play area.
  const stageBox = await page.getByTestId('zhen-sha-stage').boundingBox();
  expect(stageBox).not.toBeNull();
  expect(stageBox!.y).toBeGreaterThanOrEqual(hintsBox!.y + hintsBox!.height);
});

/**
 * The debug seam replays three perfect blocks, then charges and strikes on an
 * exposed boss. `step()` owns time while the seam is enabled, so the live
 * frame loop cannot advance the duel behind the test's back.
 */
const WIN_REPLAY_URL =
  '/#/games/zhen-sha?debug=1&inputs=block@180,block@360,block@540,charge@541,strike@542';
/** The replay above reaches the win on this fixed tick. */
const WIN_TICK = 543;

interface ZhenShaDebugWindow {
  __playground?: {
    readonly gameId: 'zhen-sha';
    readonly step: (ticks: number) => void;
  };
}

/** Mount the game, then advance the fixed-step replay until it settles. */
async function openSettlement(page: Page): Promise<void> {
  await page.goto(WIN_REPLAY_URL);
  await page.waitForFunction(
    () => (window as unknown as ZhenShaDebugWindow).__playground !== undefined,
  );
  // The app focuses the game view after mounting; the modal must restore that
  // focus when restart closes it.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.id ?? ''))
    .toBe('view');
  await page.evaluate((tick) => {
    const api = (window as unknown as ZhenShaDebugWindow).__playground;
    if (api === undefined) {
      throw new Error('Zhen Sha debug seam is not installed');
    }
    api.step(tick);
  }, WIN_TICK);
  await expect(page.getByTestId('overlay')).toBeVisible();
}

/** Whether keyboard focus currently sits inside the settlement overlay. */
async function focusInsideOverlay(page: Page): Promise<boolean> {
  return page
    .getByTestId('overlay')
    .evaluate((overlay) => overlay.contains(document.activeElement));
}

async function hasInert(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.hasAttribute('inert'));
}

/** Click the visual center of an element with a real pointer event. */
async function clickCenter(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  expect(box, 'pointer target must be visible').not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

test('traps focus in the settlement dialog and restores the page shell on restart', async ({
  page,
}) => {
  await openSettlement(page);

  const overlay = page.getByTestId('overlay');
  const overlayRestart = page.getByTestId('overlay-restart');
  const title = page.getByTestId('overlay-title');
  const header = page.locator('header.site-header');
  const brand = header.locator('.brand');
  const navLinks = header.locator('.site-nav a[href]');
  const soundToggle = header.getByTestId('sound-toggle');
  const githubLink = header.locator('.site-nav a.icon-button');

  // The overlay is a modal dialog whose accessible name comes from its heading.
  const titleText = (await title.textContent())?.trim() ?? '';
  expect(titleText).not.toBe('');
  await expect(page.getByRole('dialog', { name: titleText })).toBeVisible();
  await expect(overlay).toHaveAttribute('aria-modal', 'true');
  const labelledBy = await overlay.getAttribute('aria-labelledby');
  expect(labelledBy, 'the dialog must be named by its heading').not.toBeNull();
  await expect(title).toHaveAttribute('id', labelledBy!);

  // Opening the settlement inerts the page shell and moves focus into the
  // dialog's first action.
  const footer = page.locator('footer.site-footer');
  await expect(header).toHaveAttribute('inert', '');
  await expect(footer).toHaveAttribute('inert', '');
  await expect(overlayRestart).toBeFocused();

  // Tab and Shift+Tab cycle inside the dialog instead of reaching the shell.
  for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab'] as const) {
    await page.keyboard.press(key);
    expect(await focusInsideOverlay(page), `${key} must keep focus inside the dialog`).toBe(
      true,
    );
  }

  // Inert also blocks programmatic focus, not just the Tab order. The text nav
  // links are display:none at 320px; the brand, sound toggle and GitHub link
  // are the shell focus targets that are visible here.
  const shellFocusTargets = [brand, ...(await navLinks.all()), soundToggle];
  for (const [index, target] of shellFocusTargets.entries()) {
    const focused = await target.evaluate((element) => {
      element.focus();
      return document.activeElement === element;
    });
    expect(focused, `page shell focus target ${index} must stay unfocusable`).toBe(false);
  }
  expect(
    await focusInsideOverlay(page),
    'shell focus attempts must leave focus in the dialog',
  ).toBe(true);

  // A real pointer click on the header must not navigate away from the game.
  await clickCenter(page, brand);
  await expect(page).toHaveURL(/#\/games\/zhen-sha\?debug=1/);
  await expect(overlay).toBeVisible();

  // The GitHub link opens a new page, so a click must not produce a popup.
  const popup = page.waitForEvent('popup', { timeout: 500 }).catch(() => null);
  await clickCenter(page, githubLink);
  expect(await popup, 'inert header links must not open a new page').toBeNull();
  await expect(page).toHaveURL(/#\/games\/zhen-sha\?debug=1/);
  await expect(overlay).toBeVisible();

  // Even if the inert click blurred the dialog action, Tab goes back inside.
  await page.keyboard.press('Tab');
  expect(await focusInsideOverlay(page), 'Tab must re-enter the dialog').toBe(true);

  // Restart closes the dialog, removes the background inert and returns focus
  // to the game view that held it before the settlement opened.
  await overlayRestart.click();
  await expect(overlay).toBeHidden();
  expect(await hasInert(header), 'header inert must be removed after restart').toBe(false);
  expect(await hasInert(footer), 'footer inert must be removed after restart').toBe(false);
  await expect(page.getByTestId('status')).toHaveText('进行中');
  await expect(page.locator('#view')).toBeFocused();

  // The shell is part of the Tab order again: skip link, brand, then nav.
  await page.locator('.skip-link').focus();
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(brand).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(soundToggle).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(githubLink).toBeFocused();
});
