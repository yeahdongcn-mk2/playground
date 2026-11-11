import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchTouchPointerEvent,
  RELEASE_CLICK_POINTER_ID,
  releaseTouchClick,
  TOUCH_POINTER_ID,
  touchLongPress,
} from '../../scripts/lib/touch-input.mjs';
import type { Locator, Page } from '@playwright/test';

/**
 * Unit coverage for the screenshot touch helper.
 *
 * The helper runs its PointerEvent construction inside Playwright's page
 * context, where a real `PointerEvent` exists. Node has none, so the fake page
 * and locator below execute the same page function against a fake event class
 * and record exactly which events the helper dispatches. This pins the real
 * WebKit shape: the held touch uses pointer id 2 / 'touch', while the release
 * click is the mouse-mediated pointer id 1 / 'mouse' / detail 1, so the two ids
 * can never collapse back into one. `releaseTouchClick` is also covered through
 * both delivery paths (the page's element under the point and an explicit
 * locator), because both the screenshot long press and the e2e helper use it.
 */

interface RecordedPointerEvent {
  readonly type: string;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly detail: number;
  readonly buttons: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly isPrimary: boolean;
}

class FakePointerEvent implements RecordedPointerEvent {
  readonly type: string;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly detail: number;
  readonly buttons: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly isPrimary: boolean;

  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    this.pointerId = Number(init.pointerId);
    this.pointerType = String(init.pointerType);
    this.detail = Number(init.detail);
    this.buttons = Number(init.buttons);
    this.clientX = Number(init.clientX);
    this.clientY = Number(init.clientY);
    this.bubbles = init.bubbles === true;
    this.cancelable = init.cancelable === true;
    this.isPrimary = init.isPrimary === true;
  }
}

interface EventSink {
  readonly dispatched: RecordedPointerEvent[];
  readonly element: { dispatchEvent(event: RecordedPointerEvent): boolean };
}

function createSink(): EventSink {
  const dispatched: RecordedPointerEvent[] = [];
  return {
    dispatched,
    element: {
      dispatchEvent(event) {
        dispatched.push(event);
        return true;
      },
    },
  };
}

/** Run the page function the helper passes to `page.evaluate`. */
function fakePage(): Page {
  return {
    async evaluate(pageFunction: unknown, arg: unknown) {
      const run = pageFunction as (eventInit: unknown) => unknown;
      return run(arg);
    },
  } as unknown as Page;
}

/** Run the page function the helper passes to `locator.evaluate`. */
function fakeLocator(sink: EventSink): Locator {
  return {
    async boundingBox() {
      return { x: 10, y: 20, width: 30, height: 40 };
    },
    async evaluate(pageFunction: unknown, arg: unknown) {
      const run = pageFunction as (
        element: EventSink['element'],
        eventInit: unknown,
      ) => unknown;
      return run(sink.element, arg);
    },
  } as unknown as Locator;
}

function shape(event: RecordedPointerEvent) {
  return {
    type: event.type,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    detail: event.detail,
    buttons: event.buttons,
  };
}

let sink: EventSink;

beforeEach(() => {
  sink = createSink();
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  vi.stubGlobal('document', {
    elementFromPoint: () => sink.element,
    body: sink.element,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('screenshot touch injection shape', () => {
  it('holds a touch with pointer id 2 and clicks as mouse pointer id 1', async () => {
    await touchLongPress(fakePage(), fakeLocator(sink), 0);

    expect(sink.dispatched.map(shape)).toEqual([
      { type: 'pointerdown', pointerId: 2, pointerType: 'touch', detail: 0, buttons: 1 },
      { type: 'pointerup', pointerId: 2, pointerType: 'touch', detail: 0, buttons: 0 },
      { type: 'click', pointerId: 1, pointerType: 'mouse', detail: 1, buttons: 0 },
    ]);

    expect(TOUCH_POINTER_ID).toBe(2);
    expect(RELEASE_CLICK_POINTER_ID).toBe(1);
    expect(TOUCH_POINTER_ID).not.toBe(RELEASE_CLICK_POINTER_ID);
    expect(sink.dispatched[0]?.pointerId).not.toBe(sink.dispatched[2]?.pointerId);
    expect(sink.dispatched[0]?.pointerType).not.toBe(sink.dispatched[2]?.pointerType);
  });

  it('targets the locator centre and keeps the touch options by default', async () => {
    await touchLongPress(fakePage(), fakeLocator(sink), 0);

    expect(sink.dispatched.map((event) => [event.clientX, event.clientY])).toEqual([
      [25, 40],
      [25, 40],
      [25, 40],
    ]);
  });

  it('dispatches the shared release click through the page path', async () => {
    await releaseTouchClick(fakePage(), { x: 7, y: 8 });

    expect(sink.dispatched.map(shape)).toEqual([
      { type: 'click', pointerId: 1, pointerType: 'mouse', detail: 1, buttons: 0 },
    ]);
    expect(sink.dispatched[0]?.clientX).toBe(7);
    expect(sink.dispatched[0]?.clientY).toBe(8);
  });

  it('dispatches the shared release click through the locator path', async () => {
    await releaseTouchClick(fakePage(), { x: 25, y: 40 }, { target: fakeLocator(sink) });

    expect(sink.dispatched.map(shape)).toEqual([
      { type: 'click', pointerId: 1, pointerType: 'mouse', detail: 1, buttons: 0 },
    ]);
    expect(sink.dispatched[0]?.clientX).toBe(25);
    expect(sink.dispatched[0]?.clientY).toBe(40);
  });

  it('dispatches touch events by default and accepts an explicit mouse release', async () => {
    const page = fakePage();
    await dispatchTouchPointerEvent(page, 'pointerdown', { x: 5, y: 6 }, TOUCH_POINTER_ID);
    await dispatchTouchPointerEvent(page, 'pointerup', { x: 5, y: 6 }, TOUCH_POINTER_ID);
    await dispatchTouchPointerEvent(page, 'click', { x: 5, y: 6 }, RELEASE_CLICK_POINTER_ID, {
      detail: 1,
      buttons: 0,
      pointerType: 'mouse',
    });

    expect(sink.dispatched.map(shape)).toEqual([
      { type: 'pointerdown', pointerId: 2, pointerType: 'touch', detail: 0, buttons: 1 },
      { type: 'pointerup', pointerId: 2, pointerType: 'touch', detail: 0, buttons: 0 },
      { type: 'click', pointerId: 1, pointerType: 'mouse', detail: 1, buttons: 0 },
    ]);
  });
});
