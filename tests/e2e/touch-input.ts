import type { Locator, Page } from '@playwright/test';

/**
 * Cross-engine touch input for gesture tests.
 *
 * Playwright's `page.touchscreen` only exposes `tap`, and only Chromium has a
 * CDP session that can hold a finger down and move it. WebKit has neither, so
 * swipes and drags are injected as the pointer events a real touch produces:
 * `pointerdown` / `pointermove` / `pointerup` (or `pointercancel`) with
 * `pointerType: 'touch'`, plus the release `click` where a browser would emit
 * one. Both engines drive the same product code path, and no test depends on a
 * Chromium-only CDP session.
 */

export interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

export type TouchPointerType =
  | 'pointerdown'
  | 'pointermove'
  | 'pointerup'
  | 'pointercancel'
  | 'click';

export interface TouchGesture {
  readonly page: Page;
  readonly pointerId: number;
  /** Deliver every event here instead of the element under the point. */
  readonly target: Locator | null;
  readonly start: TouchPoint;
  last: TouchPoint;
}

export interface StartTouchOptions {
  /** Pointer id carried by the whole gesture; defaults to 1. */
  readonly pointerId?: number;
  /**
   * Element that receives every event. Defaults to `document.elementFromPoint`
   * at each step, which is what an uncaptured touch does.
   */
  readonly target?: Locator;
}

export interface EndTouchOptions {
  /** Also dispatch the release click a real touch produces. */
  readonly click?: boolean;
}

export interface DispatchTouchOptions {
  readonly target?: Locator;
  readonly detail?: number;
  readonly buttons?: number;
}

/** Dispatch one touch pointer event at a viewport point. */
export async function dispatchTouchPointerEvent(
  page: Page,
  type: TouchPointerType,
  point: TouchPoint,
  pointerId: number,
  options: DispatchTouchOptions = {},
): Promise<void> {
  const init = {
    type,
    pointerId,
    clientX: point.x,
    clientY: point.y,
    buttons:
      options.buttons ?? (type === 'pointerdown' || type === 'pointermove' ? 1 : 0),
    detail: options.detail ?? 0,
  };
  if (options.target) {
    await options.target.evaluate((element, eventInit) => {
      element.dispatchEvent(
        new PointerEvent(eventInit.type, {
          bubbles: true,
          cancelable: true,
          pointerId: eventInit.pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX: eventInit.clientX,
          clientY: eventInit.clientY,
          button: 0,
          buttons: eventInit.buttons,
          detail: eventInit.detail,
        }),
      );
    }, init);
    return;
  }
  await page.evaluate((eventInit) => {
    const element =
      document.elementFromPoint(eventInit.clientX, eventInit.clientY) ?? document.body;
    element.dispatchEvent(
      new PointerEvent(eventInit.type, {
        bubbles: true,
        cancelable: true,
        pointerId: eventInit.pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: eventInit.clientX,
        clientY: eventInit.clientY,
        button: 0,
        buttons: eventInit.buttons,
        detail: eventInit.detail,
      }),
    );
  }, init);
}

/** Begin a held touch at `point`. */
export async function startTouch(
  page: Page,
  point: TouchPoint,
  options: StartTouchOptions = {},
): Promise<TouchGesture> {
  const pointerId = options.pointerId ?? 1;
  const target = options.target ?? null;
  await dispatchTouchPointerEvent(page, 'pointerdown', point, pointerId, {
    target: target ?? undefined,
    buttons: 1,
  });
  return { page, pointerId, target, start: point, last: point };
}

/** Move the held touch to `point`. */
export async function moveTouch(gesture: TouchGesture, point: TouchPoint): Promise<void> {
  await dispatchTouchPointerEvent(gesture.page, 'pointermove', point, gesture.pointerId, {
    target: gesture.target ?? undefined,
    buttons: 1,
  });
  gesture.last = point;
}

/** Release the held touch, optionally with the release click a real touch emits. */
export async function endTouch(
  gesture: TouchGesture,
  options: EndTouchOptions = {},
): Promise<void> {
  await dispatchTouchPointerEvent(gesture.page, 'pointerup', gesture.last, gesture.pointerId, {
    target: gesture.target ?? undefined,
    buttons: 0,
  });
  if (options.click) {
    await dispatchTouchPointerEvent(gesture.page, 'click', gesture.last, gesture.pointerId, {
      target: gesture.target ?? undefined,
      detail: 1,
      buttons: 0,
    });
  }
}

/** Cancel the held touch the way a browser takeover or scroll would. */
export async function cancelTouch(gesture: TouchGesture): Promise<void> {
  await dispatchTouchPointerEvent(
    gesture.page,
    'pointercancel',
    gesture.last,
    gesture.pointerId,
    {
      target: gesture.target ?? undefined,
      buttons: 0,
    },
  );
}
