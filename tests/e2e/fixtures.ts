import { expect, test as base, type Page } from '@playwright/test';

/** Fail any test that triggers an uncaught page error. */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => {
        errors.push(error.message);
      });
      await use(errors);
      expect(errors, 'uncaught page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export interface GamePosition {
  x: number;
  y: number;
}

export async function openBlankGame(page: Page): Promise<void> {
  await page.goto('/#/games/blank');
  await expect(page.getByTestId('blank-game')).toBeVisible();
  await expect(page.getByTestId('blank-stage')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('blank-loading')).toBeHidden();
}

export async function readPosition(
  page: Page,
): Promise<GamePosition> {
  const readout = page.getByTestId('readout');
  const [x, y] = await Promise.all([
    readout.getAttribute('data-x'),
    readout.getAttribute('data-y'),
  ]);
  return { x: Number(x), y: Number(y) };
}

export async function canvasBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('canvas[data-testid="game-canvas"]').boundingBox();
  if (!box) {
    throw new Error('Game canvas has no bounding box');
  }
  return box;
}

/**
 * Track window-level `blur` listeners added via addEventListener. Phaser also
 * assigns window.onblur, which is not counted here and is library-global.
 */
export async function installBlurListenerProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const blurListeners = new Set<EventListenerOrEventListenerObject>();
    const visibilityListeners = new Set<EventListenerOrEventListenerObject>();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'blur') blurListeners.add(listener);
      return add(type, listener, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === 'blur') blurListeners.delete(listener);
      return remove(type, listener, options);
    }) as typeof window.removeEventListener;

    const documentAdd = document.addEventListener.bind(document);
    const documentRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'visibilitychange') visibilityListeners.add(listener);
      return documentAdd(type, listener, options);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === 'visibilitychange') visibilityListeners.delete(listener);
      return documentRemove(type, listener, options);
    }) as typeof document.removeEventListener;

    const probe = {
      __blurListenerCount: () => blurListeners.size,
      __visibilityListenerCount: () => visibilityListeners.size,
    };
    Object.assign(window, probe);
  });
}

export async function blurListenerCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __blurListenerCount: () => number }).__blurListenerCount(),
  );
}

export async function visibilityListenerCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __visibilityListenerCount: () => number })
        .__visibilityListenerCount(),
  );
}
