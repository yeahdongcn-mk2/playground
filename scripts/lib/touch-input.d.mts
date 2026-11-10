import type { Locator, Page } from '@playwright/test';

export interface TouchPoint {
  x: number;
  y: number;
}

export function dispatchTouchPointerEvent(
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'click',
  point: TouchPoint,
  pointerId: number,
  options?: { target?: Locator | null; detail?: number },
): Promise<void>;

export function touchLongPress(
  page: Page,
  locator: Locator,
  holdMs?: number,
  pointerId?: number,
): Promise<void>;
