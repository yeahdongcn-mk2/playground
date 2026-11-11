import type { Locator, Page } from '@playwright/test';

export interface TouchPoint {
  x: number;
  y: number;
}

/** Pointer event types the shared touch injector can dispatch. */
export type TouchPointerType =
  | 'pointerdown'
  | 'pointermove'
  | 'pointerup'
  | 'pointercancel'
  | 'click';

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
  type: TouchPointerType,
  point: TouchPoint,
  pointerId: number,
  options?: DispatchTouchOptions,
): Promise<void>;

export interface ReleaseTouchClickOptions {
  /** Deliver the click here instead of the element under the point. */
  target?: Locator | null;
}

/**
 * Dispatch the mouse-mediated release `click` a real touch produces. The
 * pointer id, `pointerType: 'mouse'`, `detail: 1` and `buttons: 0` are fixed by
 * the shared implementation; only the delivery target can be chosen.
 */
export function releaseTouchClick(
  page: Page,
  point: TouchPoint,
  options?: ReleaseTouchClickOptions,
): Promise<void>;

/**
 * Hold a touch on `locator`, release it and emit the release click. The held
 * events use the touch pointer id (default `TOUCH_POINTER_ID`); the release
 * click goes through `releaseTouchClick`.
 */
export function touchLongPress(
  page: Page,
  locator: Locator,
  holdMs?: number,
  pointerId?: number,
): Promise<void>;
