import { expect, test } from './fixtures';
import {
  expectFirstScreenContract,
  LOSS_MINES,
  openMinesweeper,
} from './minesweeper-helpers';

/**
 * The narrow first-screen matrix for the `mobile-webkit` project. 320px is the
 * documented 34px geometric fallback; every width from 340px up keeps 36px
 * touch targets. All four viewports also assert the compact restart entry,
 * including the 360x640 / 375x667 short-screen sizes fixed for Issue #60.
 */
const WEBKIT_NARROW_VIEWPORTS = [
  { width: 320, height: 640, minimumCellSize: 34, label: '320x640' },
  { width: 360, height: 640, minimumCellSize: 36, label: '360x640' },
  { width: 375, height: 667, minimumCellSize: 36, label: '375x667' },
  { width: 412, height: 839, minimumCellSize: 36, label: '412x839' },
] as const;

/**
 * Cross-engine notes recorded on the same Playwright device emulation:
 *
 * - `dvh`: WebKit supports `100dvh` and resolves it to the emulated inner
 *   height (640/667/839), the same as Chromium. Playwright does not model the
 *   iOS dynamic toolbar, so a real Safari address-bar resize is still not
 *   covered.
 * - Font metrics: WebKit's fallback fonts render the back link about 3% wider
 *   (68.33px vs 66.45px of text at the same computed size); every element still
 *   fits the first screen, so the contract asserts bounds rather than a fixed
 *   text width.
 * - `any-pointer: coarse`: both engines match, so the touch hint and compact
 *   restart entry are rendered.
 * - Safe area: Playwright's iPhone SE emulation reports 0px insets in both
 *   engines; the real notch / home-indicator inset is not simulated.
 */
test.describe('minesweeper first-screen contract on WebKit', () => {
  for (const viewport of WEBKIT_NARROW_VIEWPORTS) {
    test(`keeps the first-screen contract at ${viewport.label}`, async ({
      page,
      browserName,
    }) => {
      expect(browserName).toBe('webkit');
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openMinesweeper(page, { mines: LOSS_MINES });

      await expectFirstScreenContract(page, viewport.minimumCellSize, {
        restartEntry: true,
      });
    });
  }

  test('exposes the WebKit environment assumptions behind the contract', async ({
    page,
    browserName,
  }) => {
    expect(browserName).toBe('webkit');
    await page.setViewportSize({ width: 320, height: 640 });
    await openMinesweeper(page, { mines: LOSS_MINES });

    const environment = await page.evaluate(() => {
      const dvhProbe = document.createElement('div');
      dvhProbe.style.cssText =
        'position: fixed; top: 0; left: 0; width: 1px; height: 100dvh;';
      document.body.append(dvhProbe);
      const dvhHeight = getComputedStyle(dvhProbe).height;
      dvhProbe.remove();

      const safeAreaProbe = document.createElement('div');
      safeAreaProbe.style.cssText =
        'position: fixed; bottom: 0; left: 0; ' +
        'width: env(safe-area-inset-left); height: env(safe-area-inset-bottom);';
      document.body.append(safeAreaProbe);
      const safeArea = getComputedStyle(safeAreaProbe);
      const insets = { left: safeArea.width, bottom: safeArea.height };
      safeAreaProbe.remove();

      return {
        supportsDvh: CSS.supports('height', '100dvh'),
        dvhHeight,
        viewportHeight: `${window.innerHeight}px`,
        anyPointerCoarse: matchMedia('(any-pointer: coarse)').matches,
        safeArea: insets,
      };
    });

    // `dvh` resolves to the emulated first screen instead of overflowing it.
    expect(environment.supportsDvh).toBe(true);
    expect(environment.dvhHeight).toBe(environment.viewportHeight);
    // The iPhone SE device makes the touch affordances apply.
    expect(environment.anyPointerCoarse).toBe(true);
    // Playwright's emulation has no notch or home-indicator safe-area insets.
    expect(environment.safeArea).toEqual({ left: '0px', bottom: '0px' });
  });
});
