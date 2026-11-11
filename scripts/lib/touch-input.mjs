import { setTimeout as delay } from 'node:timers/promises';

/**
 * One held touch for screenshot scripts.
 *
 * Playwright only exposes `touchscreen.tap`; holding a finger down needs a CDP
 * session on Chromium, and WebKit has no CDP. This mirrors
 * `tests/e2e/touch-input.ts`: dispatch the `pointerdown` / `pointerup` / release
 * `click` a real touch produces. The finger events carry `pointerType: 'touch'`
 * and the touch pointer id (2); the release click is the mouse-mediated event
 * WebKit delivers (`pointerType: 'mouse'`, pointer id 1, `detail: 1`), so the
 * same view code runs on both engines and the scripts no longer depend on
 * `newCDPSession` or `Input.dispatchTouchEvent`.
 */

/**
 * Pointer id a real touch reports for the finger itself. Both engines report 2
 * for the first touch on an emulated phone, the same value
 * `tests/e2e/touch-input.ts` exports.
 */
export const TOUCH_POINTER_ID = 2;

/**
 * Pointer id WebKit reports for the mouse-mediated release click a touch
 * produces. It differs from the touch pointerdown id on purpose: the product
 * must not match the click back by pointer id.
 */
export const RELEASE_CLICK_POINTER_ID = 1;

function pointerInit(type, point, pointerId, options) {
  return {
    type,
    pointerId,
    pointerType: options.pointerType ?? 'touch',
    clientX: point.x,
    clientY: point.y,
    buttons:
      options.buttons ?? (type === 'pointerdown' || type === 'pointermove' ? 1 : 0),
    detail: options.detail ?? 0,
  };
}

/** Dispatch one touch-shaped pointer event at a viewport point. */
export async function dispatchTouchPointerEvent(
  page,
  type,
  point,
  pointerId,
  options = {},
) {
  const { target = null } = options;
  const init = pointerInit(type, point, pointerId, options);
  if (target) {
    await target.evaluate((element, eventInit) => {
      element.dispatchEvent(
        new PointerEvent(eventInit.type, {
          bubbles: true,
          cancelable: true,
          pointerId: eventInit.pointerId,
          pointerType: eventInit.pointerType,
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
        pointerType: eventInit.pointerType,
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

/** Hold a touch on `locator`, release it and emit the release click. */
export async function touchLongPress(
  page,
  locator,
  holdMs = 650,
  pointerId = TOUCH_POINTER_ID,
) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('touch target has no bounding box');
  }
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await dispatchTouchPointerEvent(page, 'pointerdown', point, pointerId, { target: locator });
  await delay(holdMs);
  await dispatchTouchPointerEvent(page, 'pointerup', point, pointerId, { target: locator });
  // A real touch does not produce a touch `click`: WebKit reports it as a
  // mouse-mediated PointerEvent with pointerId 1, pointerType 'mouse' and
  // detail 1. Do not reuse the touch id here, or the injection keeps drifting
  // from the shape a real finger delivers.
  await dispatchTouchPointerEvent(page, 'click', point, RELEASE_CLICK_POINTER_ID, {
    target: locator,
    detail: 1,
    buttons: 0,
    pointerType: 'mouse',
  });
}
