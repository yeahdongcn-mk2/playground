import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  cellLocator,
  expectFirstScreenContract,
  longPressCell,
  LOSS_MINE_CLICK,
  LOSS_MINES,
  LOSS_SAFE_CLICK,
  openMinesweeper,
} from './minesweeper-helpers';
import { RELEASE_CLICK_POINTER_ID, TOUCH_POINTER_ID } from './touch-input';

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

/** The pointer fields that decide whether the product suppresses a release click. */
interface PointerShape {
  readonly type: 'pointerdown' | 'pointerup' | 'click';
  readonly constructorName: string;
  readonly pointerId: number | null;
  readonly pointerType: string | null;
  readonly detail: number;
  readonly trusted: boolean;
}

const POINTER_SHAPES_KEY = '__webkitPointerShapes';

/** Read the pointer shapes recorded for the current mount. */
async function readPointerShapes(page: Page): Promise<PointerShape[]> {
  return page.evaluate((key) => {
    const shapes = (window as unknown as Record<string, PointerShape[] | undefined>)[key];
    return shapes ?? [];
  }, POINTER_SHAPES_KEY);
}

/** Record pointerdown / pointerup / click shapes and their trust state. */
async function recordPointerShapes(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const shapes: PointerShape[] = [];
    (window as unknown as Record<string, PointerShape[]>)[key] = shapes;
    for (const type of ['pointerdown', 'pointerup', 'click'] as const) {
      window.addEventListener(
        type,
        (event) => {
          const pointer = event as PointerEvent;
          shapes.push({
            type,
            constructorName: event.constructor.name,
            pointerId: event instanceof PointerEvent ? pointer.pointerId : null,
            pointerType: event instanceof PointerEvent ? pointer.pointerType : null,
            detail: event.detail,
            trusted: event.isTrusted,
          });
        },
        { capture: true },
      );
    }
  }, POINTER_SHAPES_KEY);
}

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

  test('exposes the WebKit environment and real touch-event assumptions behind the contract', async ({
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

    // A real tap tells us the event shapes the helper has to fabricate. Record
    // them before the fallback injects its own gesture.
    await recordPointerShapes(page);
    const safeCell = cellLocator(page, LOSS_SAFE_CLICK.row, LOSS_SAFE_CLICK.col);
    const safeBox = await safeCell.boundingBox();
    expect(safeBox).not.toBeNull();
    await page.touchscreen.tap(
      (safeBox?.x ?? 0) + (safeBox?.width ?? 0) / 2,
      (safeBox?.y ?? 0) + (safeBox?.height ?? 0) / 2,
    );
    await expect
      .poll(
        async () =>
          (await readPointerShapes(page)).filter(
            (shape) => shape.type === 'click' && shape.trusted,
          ).length,
      )
      .toBe(1);

    // The fallback then dispatches the release click of a long press.
    await longPressCell(page, LOSS_MINE_CLICK.row, LOSS_MINE_CLICK.col);
    await expect
      .poll(
        async () =>
          (await readPointerShapes(page)).filter(
            (shape) => shape.type === 'click' && !shape.trusted,
          ).length,
      )
      .toBe(1);

    const shapes = await readPointerShapes(page);
    const find = (
      type: PointerShape['type'],
      trusted: boolean,
    ): PointerShape | undefined =>
      shapes.find((shape) => shape.type === type && shape.trusted === trusted);
    const realDown = find('pointerdown', true);
    const realUp = find('pointerup', true);
    const realClick = find('click', true);
    const injectedDown = find('pointerdown', false);
    const injectedUp = find('pointerup', false);
    const injectedClick = find('click', false);
    expect(realDown, 'the real tap should emit a pointerdown').toBeDefined();
    expect(realUp, 'the real tap should emit a pointerup').toBeDefined();
    expect(realClick, 'the real tap should emit a release click').toBeDefined();
    expect(injectedDown, 'the helper should emit a pointerdown').toBeDefined();
    expect(injectedUp, 'the helper should emit a pointerup').toBeDefined();
    expect(injectedClick, 'the helper should emit a release click').toBeDefined();

    // WebKit reports the touch pointer and the mouse-mediated release click
    // differently; the product must not assume they share a pointer id or type.
    expect(realDown?.constructorName).toBe('PointerEvent');
    expect(realDown?.pointerType).toBe('touch');
    expect(realDown?.pointerId).toBe(TOUCH_POINTER_ID);
    expect(realDown?.detail).toBe(0);
    expect(realUp?.pointerType).toBe('touch');
    expect(realUp?.pointerId).toBe(realDown?.pointerId);
    expect(realClick?.constructorName).toBe('PointerEvent');
    expect(realClick?.pointerType).toBe('mouse');
    expect(realClick?.pointerId).toBe(RELEASE_CLICK_POINTER_ID);
    expect(realClick?.detail).toBe(1);
    expect(realDown?.pointerId).not.toBe(realClick?.pointerId);
    expect(realDown?.pointerType).not.toBe(realClick?.pointerType);

    // The helper must fabricate the shapes WebKit actually delivers; if WebKit
    // changes to a MouseEvent or another pointer id, this fails instead of
    // leaving the long-press cases green against a stale simulation.
    expect(injectedDown?.constructorName).toBe(realDown?.constructorName);
    expect(injectedDown?.pointerType).toBe(realDown?.pointerType);
    expect(injectedDown?.pointerId).toBe(realDown?.pointerId);
    expect(injectedDown?.detail).toBe(realDown?.detail);
    expect(injectedUp?.pointerType).toBe(realUp?.pointerType);
    expect(injectedUp?.pointerId).toBe(realUp?.pointerId);
    expect(injectedClick?.constructorName).toBe(realClick?.constructorName);
    expect(injectedClick?.pointerType).toBe(realClick?.pointerType);
    expect(injectedClick?.pointerId).toBe(realClick?.pointerId);
    expect(injectedClick?.detail).toBe(realClick?.detail);
  });
});
