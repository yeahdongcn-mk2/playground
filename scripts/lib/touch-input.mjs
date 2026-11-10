import { setTimeout as delay } from 'node:timers/promises';

/**
 * One held touch for screenshot scripts.
 *
 * Playwright only exposes `touchscreen.tap`; holding a finger down needs a CDP
 * session on Chromium, and WebKit has no CDP. This mirrors
 * `tests/e2e/touch-input.ts`: dispatch the `pointerdown` / `pointerup` / release
 * `click` a real touch produces, with `pointerType: 'touch'`, so the same view
 * code runs on both engines and the scripts no longer depend on
 * `newCDPSession` or `Input.dispatchTouchEvent`.
 */

function pointerInit(type, point, pointerId, detail = 0) {
  return {
    type,
    pointerId,
    clientX: point.x,
    clientY: point.y,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
    detail,
  };
}

/** Dispatch one touch-shaped pointer event at a viewport point. */
export async function dispatchTouchPointerEvent(
  page,
  type,
  point,
  pointerId,
  { target = null, detail = 0 } = {},
) {
  const init = pointerInit(type, point, pointerId, detail);
  if (target) {
    await target.evaluate((element, eventInit) => {
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

/** Hold a touch on `locator`, release it and emit the release click. */
export async function touchLongPress(page, locator, holdMs = 650, pointerId = 1) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('touch target has no bounding box');
  }
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await dispatchTouchPointerEvent(page, 'pointerdown', point, pointerId, { target: locator });
  await delay(holdMs);
  await dispatchTouchPointerEvent(page, 'pointerup', point, pointerId, { target: locator });
  await dispatchTouchPointerEvent(page, 'click', point, pointerId, {
    target: locator,
    detail: 1,
  });
}
