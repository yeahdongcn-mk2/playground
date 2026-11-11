import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Locator, Page } from '@playwright/test';
import {
  endTouch,
  RELEASE_CLICK_POINTER_ID as E2E_RELEASE_CLICK_POINTER_ID,
  startTouch,
  TOUCH_POINTER_ID as E2E_TOUCH_POINTER_ID,
} from '../e2e/touch-input';
import {
  RELEASE_CLICK_POINTER_ID as SCRIPT_RELEASE_CLICK_POINTER_ID,
  TOUCH_POINTER_ID as SCRIPT_TOUCH_POINTER_ID,
  touchLongPress,
} from '../../scripts/lib/touch-input.mjs';

/**
 * Parity guard for the two touch injectors.
 *
 * Gesture e2e tests drive the product through `tests/e2e/touch-input.ts`, while
 * the screenshot scripts drive the same product code through
 * `scripts/lib/touch-input.mjs`. The two modules are separate copies, so a
 * shape change on one side (a reused click pointer id, a touch-typed release
 * click, a different `detail` or `buttons`) can silently stop the screenshots
 * from reproducing the input the tests exercise. This test runs both helpers
 * against the same fake page/locator and compares the exact event sequence they
 * dispatch. Node has neither `PointerEvent` nor `document`, so the fakes below
 * stand in for the Playwright page context and record the events.
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

interface PointerShape {
  readonly type: string;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly detail: number;
  readonly buttons: number;
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

/** Run the page function either helper passes to `page.evaluate`. */
function fakePage(): Page {
  return {
    async evaluate(pageFunction: unknown, arg: unknown) {
      const run = pageFunction as (eventInit: unknown) => unknown;
      return run(arg);
    },
  } as unknown as Page;
}

/** Run the page function either helper passes to `locator.evaluate`. */
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

function shape(event: RecordedPointerEvent): PointerShape {
  return {
    type: event.type,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    detail: event.detail,
    buttons: event.buttons,
  };
}

/** Centre of the fake locator's bounding box, used by both helpers. */
const LOCATOR_CENTRE = { x: 25, y: 40 };

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

describe('touch injector parity', () => {
  it('exports the same touch and release-click pointer constants', () => {
    expect(E2E_TOUCH_POINTER_ID).toBe(SCRIPT_TOUCH_POINTER_ID);
    expect(E2E_RELEASE_CLICK_POINTER_ID).toBe(SCRIPT_RELEASE_CLICK_POINTER_ID);
    expect(E2E_TOUCH_POINTER_ID).not.toBe(E2E_RELEASE_CLICK_POINTER_ID);
  });

  it('dispatches the same event sequence from the e2e helper and the screenshot script', async () => {
    const page = fakePage();
    const locator = fakeLocator(sink);

    const gesture = await startTouch(page, LOCATOR_CENTRE, {
      pointerId: E2E_TOUCH_POINTER_ID,
      target: locator,
    });
    await endTouch(gesture, { click: true });
    const e2eSequence = sink.dispatched.map(shape);

    sink.dispatched.length = 0;

    await touchLongPress(page, locator, 0);
    const scriptSequence = sink.dispatched.map(shape);

    expect(e2eSequence).toEqual(scriptSequence);
    // Pin the real WebKit shape on both sides as well, so a coordinated change
    // that keeps the two modules equal but moves them away from a real finger
    // still fails instead of passing parity alone.
    expect(e2eSequence).toEqual([
      { type: 'pointerdown', pointerId: 2, pointerType: 'touch', detail: 0, buttons: 1 },
      { type: 'pointerup', pointerId: 2, pointerType: 'touch', detail: 0, buttons: 0 },
      { type: 'click', pointerId: 1, pointerType: 'mouse', detail: 1, buttons: 0 },
    ]);
  });
});
