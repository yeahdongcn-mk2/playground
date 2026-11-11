import type { Locator, Page } from '@playwright/test';

export interface TouchPoint {
  x: number;
  y: number;
}

/**
 * Pointer id a real touch reports for the finger itself. Both engines report 2
 * for the first touch on an emulated phone.
 */
export const TOUCH_POINTER_ID: 2;

/**
 * Pointer id WebKit reports for the mouse-mediated release click a touch
 * produces. It differs from the touch pointerdown id on purpose.
 */
export const RELEASE_CLICK_POINTER_ID: 1;

export interface DispatchTouchOptions {
  /** Deliver the event here instead of the element under the point. */
  target?: Locator | null;
  detail?: number;
  buttons?: number;
  /**
   * Pointer type carried by the event. Touch event streams use 'touch'; the
   * release click a real touch produces is mouse-mediated ('mouse').
   */
  pointerType?: 'touch' | 'mouse';
}

export function dispatchTouchPointerEvent(
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'click',
  point: TouchPoint,
  pointerId: number,
  options?: DispatchTouchOptions,
): Promise<void>;

/**
 * Hold a touch on `locator`, release it and emit the release click. The held
 * events use the touch pointer id (default `TOUCH_POINTER_ID`); the release
 * click uses `RELEASE_CLICK_POINTER_ID` with `pointerType: 'mouse'`.
 */
export function touchLongPress(
  page: Page,
  locator: Locator,
  holdMs?: number,
  pointerId?: number,
): Promise<void>;
