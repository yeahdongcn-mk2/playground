import type { Locator, Page } from '@playwright/test';
import type {
  ZhenShaDebugInput,
  ZhenShaDebugState,
  ZhenShaDebugWindow,
} from '../../src/games/zhen-sha/debug';
import type { ZhenShaAction } from '../../src/games/zhen-sha/engine';
import {
  expect,
  expectNoAnimationFrames,
  installListenerProbe,
  installRafProbe,
  listenerCount,
  pendingLongTimerCount,
  rafCount,
  rafPending,
  resetRafCount,
  trackProbeTarget,
} from './fixtures';
import {
  endTouch,
  startTouch,
  TOUCH_POINTER_ID,
  type TouchGesture,
} from './touch-input';

/**
 * Shared, frozen contract for the Zhen Sha browser tests (#253 t2).
 *
 * t3-t5 import only this module; keeping the URL builder, the deterministic
 * input lines, the pointer adapters and the layout assertions here means the
 * mobile, WebKit and lifecycle suites cannot drift from the desktop one.
 *
 * The deterministic paths are driven by the `?debug=1` seam from t1: a fixed
 * `seed` plus absolute-tick `inputs` fully describe a duel, and `stepZhenSha`
 * advances the simulation without a wall clock. The module also exposes the
 * live-mode entries the lifecycle suite needs; no helper owns a wall-clock
 * wait, and the re-exported `expectNoAnimationFrames` only observes a bounded
 * window. `destroyZhenSha` calls the view handle's destroy.
 */

/** Fixed ticks of the view's 220 ms long-press threshold at 120 ticks/s. */
export const ZHEN_SHA_HOLD_TICKS = 27;

/**
 * Three perfect parries at the killing-move impact ticks, followed by the
 * charged finisher on the open guard. The ticks are absolute engine ticks:
 * impacts at 180, 360 and 540, then charge at 541 and strike at 542.
 */
export const WIN_INPUTS: readonly ZhenShaDebugInput[] = [
  { action: 'block', tick: 180 },
  { action: 'block', tick: 360 },
  { action: 'block', tick: 540 },
  { action: 'charge', tick: 541 },
  { action: 'strike', tick: 542 },
];

/**
 * The three killing-move impact ticks derived from {@link WIN_INPUTS}. The
 * mobile and WebKit suites parry the same three strikes instead of copying
 * the numbers, so the replay contract has one source.
 */
export const IMPACT_TICKS: readonly number[] = WIN_INPUTS.filter(
  ({ action }) => action === 'block',
).map(({ tick }) => tick);

/**
 * A deliberately early tap whiffs and commits the first killing move, so the
 * loss line scores nothing and takes three unparried hits without any lucky
 * timing. It exercises the same input replay path as the win line.
 */
export const LOSS_INPUTS: readonly ZhenShaDebugInput[] = [{ action: 'block', tick: 0 }];

export interface ZhenShaExpectation {
  readonly status: 'won' | 'lost';
  readonly perfects: number;
  readonly hits: number;
  readonly score: number;
  /** Settlement heading rendered by the current `overlay-title`. */
  readonly title: string;
  /** Settlement body rendered by the current `overlay-body`. */
  readonly body: string;
  /** Engine tick at which the duel settles; `step(600)` stops here. */
  readonly settledAtStep: number;
}

/**
 * Baseline on the current tree: #251 t2's `settlement-*` testids are not
 * merged, so the text comes from the current `overlay-title` / `overlay-body`.
 * The numbers themselves are independent of that UI choice.
 */
export const EXPECTED_WIN: ZhenShaExpectation = {
  status: 'won',
  perfects: 3,
  hits: 0,
  score: 1900,
  title: '一棍定魂',
  body: '完美 3 次 · 得分 1900',
  settledAtStep: 543,
};

export const EXPECTED_LOSS: ZhenShaExpectation = {
  status: 'lost',
  perfects: 0,
  hits: 3,
  score: 0,
  title: '被黑煞击倒',
  body: '中招 3 次 · 再来一局找回节奏',
  settledAtStep: 595,
};

/**
 * Assert a settled snapshot matches the shared win/loss expectation. The
 * mobile and WebKit suites reuse this instead of duplicating the field list;
 * overlay text is asserted separately once the settlement is on screen.
 */
export function expectZhenShaSettlementState(
  state: ZhenShaDebugState,
  expected: ZhenShaExpectation,
): void {
  expect(state.status).toBe(expected.status);
  expect(state.perfects).toBe(expected.perfects);
  expect(state.hits).toBe(expected.hits);
  expect(state.score).toBe(expected.score);
  expect(state.step).toBe(expected.settledAtStep);
}

export interface ZhenShaDebugUrlOptions {
  readonly seed?: number;
  readonly inputs?: readonly ZhenShaDebugInput[];
}

/** `block@180,block@360,block@540,charge@541,strike@542` (t1's grammar). */
export function formatZhenShaInputs(inputs: readonly ZhenShaDebugInput[]): string {
  return inputs.map(({ action, tick }) => `${action}@${tick}`).join(',');
}

function debugSearch(options: ZhenShaDebugUrlOptions): string {
  const params = new URLSearchParams({ debug: '1' });
  if (options.seed !== undefined) {
    params.set('seed', String(options.seed));
  }
  const inputs = options.inputs ?? [];
  if (inputs.length > 0) {
    params.set('inputs', formatZhenShaInputs(inputs));
  }
  return params.toString();
}

/** Canonical deterministic URL for one duel, `#/games/zhen-sha?debug=1...`. */
export function buildZhenShaUrl(options: ZhenShaDebugUrlOptions = {}): string {
  return `/#/games/zhen-sha?${debugSearch(options)}`;
}

/**
 * The debug query has to outlive the hub click: the hub's href has no query,
 * so the parameters live in the real search string and the view falls back to
 * `location.search` when the hash route has no query of its own. The explicit
 * `#/` keeps the start URL on the documented hub route.
 */
function hubDebugUrl(options: ZhenShaDebugUrlOptions): string {
  return `/?${debugSearch(options)}#/`;
}

/**
 * The snake debug module declares `window.__playground` globally with its own
 * snapshot shape, so the helper extends Zhen Sha's product-owned cast type
 * instead of augmenting `Window`.
 */
interface ZhenShaDebugHelpersWindow extends ZhenShaDebugWindow {
  __zhenShaPageHidden?: boolean;
}

async function expectZhenShaMounted(page: Page): Promise<void> {
  await expect(page.getByTestId('zhen-sha-game')).toBeVisible();
  await expect(page.getByTestId('zhen-sha-stage')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as unknown as ZhenShaDebugHelpersWindow).__playground;
        return api?.gameId ?? 'missing';
      }),
    )
    .toBe('zhen-sha');
}

/** Open a deterministic duel directly, bypassing the hub. */
export async function openZhenShaDebug(
  page: Page,
  options: ZhenShaDebugUrlOptions = {},
): Promise<ZhenShaDebugState> {
  await page.goto(buildZhenShaUrl(options));
  await expectZhenShaMounted(page);
  return readZhenShaState(page);
}

async function clickHubEntry(page: Page, url: string): Promise<void> {
  await page.goto(url);
  const entry = page.getByTestId('enter-zhen-sha');
  await expect(entry).toBeVisible();
  await entry.click();
}

/**
 * Enter from the real hub: load `#/`, click the hero `enter-zhen-sha` link,
 * and wait for the debug seam. Used by the desktop and mobile entry flows.
 */
export async function enterZhenShaFromHub(
  page: Page,
  options: ZhenShaDebugUrlOptions = {},
): Promise<ZhenShaDebugState> {
  await clickHubEntry(page, hubDebugUrl(options));
  await expectZhenShaMounted(page);
  return readZhenShaState(page);
}

/**
 * Open normal play without `?debug=1`. The lifecycle suite needs the real
 * wall-clock frame loop so it can observe hiding pausing it and showing
 * resuming it; the debug entry deliberately never starts that loop.
 */
export async function openZhenShaLive(page: Page): Promise<void> {
  await page.goto('/#/games/zhen-sha');
  await expect(page.getByTestId('zhen-sha-game')).toBeVisible();
  await expect(page.getByTestId('zhen-sha-stage')).toBeVisible();
}

/** Enter normal play (no debug seam) from the hub's hero link. */
export async function enterZhenShaLiveFromHub(page: Page): Promise<void> {
  await clickHubEntry(page, '/#/');
  await expect(page.getByTestId('zhen-sha-game')).toBeVisible();
  await expect(page.getByTestId('zhen-sha-stage')).toBeVisible();
}

/** Read the seam's snapshot (engine state plus the pinned seed). */
export function readZhenShaState(page: Page): Promise<ZhenShaDebugState> {
  return page.evaluate(() => {
    const api = (window as unknown as ZhenShaDebugHelpersWindow).__playground;
    if (api === undefined || api.gameId !== 'zhen-sha') {
      throw new Error('Zhen Sha debug API is not available');
    }
    return api.getState();
  });
}

/** Advance exactly `ticks` fixed steps and return the resulting snapshot. */
export async function stepZhenSha(page: Page, ticks: number): Promise<ZhenShaDebugState> {
  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new RangeError(`Zhen Sha steps must be a non-negative integer, got ${ticks}`);
  }
  await page.evaluate((count) => {
    const api = (window as unknown as ZhenShaDebugHelpersWindow).__playground;
    if (api === undefined || api.gameId !== 'zhen-sha') {
      throw new Error('Zhen Sha debug API is not available');
    }
    api.step(count);
  }, ticks);
  return readZhenShaState(page);
}

/** Queue one logical action at an absolute tick (defaults to the next tick). */
export async function inputZhenSha(
  page: Page,
  action: ZhenShaAction,
  atStep?: number,
): Promise<void> {
  await page.evaluate(
    ({ action: nextAction, atStep: nextStep }) => {
      const api = (window as unknown as ZhenShaDebugHelpersWindow).__playground;
      if (api === undefined || api.gameId !== 'zhen-sha') {
        throw new Error('Zhen Sha debug API is not available');
      }
      api.input(nextAction, nextStep);
    },
    { action, atStep },
  );
}

/** Restart through the seam and return the fresh tick-zero snapshot. */
export async function restartZhenSha(page: Page): Promise<ZhenShaDebugState> {
  await page.evaluate(() => {
    const api = (window as unknown as ZhenShaDebugHelpersWindow).__playground;
    if (api === undefined || api.gameId !== 'zhen-sha') {
      throw new Error('Zhen Sha debug API is not available');
    }
    api.restart();
  });
  return readZhenShaState(page);
}

/** Assert that no Zhen Sha debug seam is installed. */
export async function expectNoDebugSeam(
  page: Page,
  message = 'the Zhen Sha debug seam must not be installed',
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as ZhenShaDebugHelpersWindow).__playground === undefined,
        ),
      { message },
    )
    .toBe(true);
}

/**
 * Destroy the view's seam and listeners, then confirm the API is gone.
 * `times` calls the captured view `destroy` that many times inside one
 * evaluate, so lifecycle tests can prove the view handle's destroy is
 * idempotent even after the first call removed `window.__playground`.
 */
export async function destroyZhenSha(page: Page, times = 1): Promise<void> {
  if (!Number.isInteger(times) || times < 1) {
    throw new RangeError(`destroyZhenSha times must be a positive integer, got ${times}`);
  }
  await page.evaluate((count) => {
    const api = (window as unknown as ZhenShaDebugHelpersWindow).__playground;
    if (api === undefined || api.gameId !== 'zhen-sha') {
      return;
    }
    const destroy = api.destroy;
    for (let index = 0; index < count; index += 1) {
      destroy();
    }
  }, times);
  await expectNoDebugSeam(page);
}

async function stageBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const stage = page.getByTestId('zhen-sha-stage');
  await expect(stage).toBeVisible();
  const box = await stage.boundingBox();
  if (box === null) {
    throw new Error('Zhen Sha stage has no bounding box');
  }
  return box;
}

async function stageCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await stageBox(page);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A real mouse click at the middle of the stage. */
export async function tapZhenShaWithMouse(page: Page): Promise<void> {
  const point = await stageCenter(page);
  await page.mouse.click(point.x, point.y);
}

/**
 * Hold a real mouse button while fixed steps age the view's hold timer, then
 * release. `stepZhenSha(27)` turns the press into `charge`; the `pointerup`
 * queues `strike`, which the caller resolves with one more step.
 */
export async function holdZhenShaWithMouse(
  page: Page,
  holdTicks = ZHEN_SHA_HOLD_TICKS,
): Promise<void> {
  const point = await stageCenter(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  try {
    await stepZhenSha(page, holdTicks);
  } finally {
    await page.mouse.up();
  }
}

/** Step to `impactStep`, tap with the mouse and consume the parry. */
export async function parryZhenShaWithMouse(
  page: Page,
  impactStep: number,
): Promise<ZhenShaDebugState> {
  const state = await readZhenShaState(page);
  if (state.step > impactStep) {
    throw new Error(
      `Cannot parry at tick ${impactStep}: the duel is already at tick ${state.step}`,
    );
  }
  await stepZhenSha(page, impactStep - state.step);
  await tapZhenShaWithMouse(page);
  return stepZhenSha(page, 1);
}

export interface ZhenShaTouchPress {
  readonly gesture: TouchGesture;
  readonly point: { readonly x: number; readonly y: number };
}

/**
 * Begin a held touch on the stage using the shared cross-engine injector from
 * `touch-input.ts`. The fingerprint stays down until the caller steps and then
 * calls {@link endZhenShaTouch}, so the same fixed-step hold works in WebKit.
 */
export async function startZhenShaTouch(page: Page): Promise<ZhenShaTouchPress> {
  const stage = page.getByTestId('zhen-sha-stage');
  await expect(stage).toBeVisible();
  const box = await stageBox(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const gesture = await startTouch(page, point, {
    target: stage,
    pointerId: TOUCH_POINTER_ID,
  });
  return { gesture, point };
}

/** Release a held touch, optionally with the release click a real tap emits. */
export async function endZhenShaTouch(
  press: ZhenShaTouchPress,
  options: { readonly click?: boolean } = {},
): Promise<void> {
  await endTouch(press.gesture, { click: options.click ?? true });
}

/** One real touch tap at the middle of the stage. */
export async function tapZhenShaWithTouch(page: Page): Promise<void> {
  const press = await startZhenShaTouch(page);
  await endZhenShaTouch(press);
}

/**
 * Touch down, age the long press with fixed steps, then lift. The lift queues
 * `strike`; like {@link holdZhenShaWithMouse}, the caller steps once more to
 * resolve the finisher and reach settlement.
 */
export async function holdZhenShaWithTouch(
  page: Page,
  holdTicks = ZHEN_SHA_HOLD_TICKS,
): Promise<void> {
  const press = await startZhenShaTouch(page);
  try {
    await stepZhenSha(page, holdTicks);
  } finally {
    await endZhenShaTouch(press);
  }
}

/** Step to `impactStep`, tap with the touch injector and consume the parry. */
export async function parryZhenShaWithTouch(
  page: Page,
  impactStep: number,
): Promise<ZhenShaDebugState> {
  const state = await readZhenShaState(page);
  if (state.step > impactStep) {
    throw new Error(
      `Cannot parry at tick ${impactStep}: the duel is already at tick ${state.step}`,
    );
  }
  await stepZhenSha(page, impactStep - state.step);
  await tapZhenShaWithTouch(page);
  return stepZhenSha(page, 1);
}

/**
 * Stub `document.hidden` and dispatch `visibilitychange`, mirroring the
 * breakout lifecycle helper. Restore with {@link restorePageVisibility}.
 */
export async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((nextHidden) => {
    const win = window as unknown as ZhenShaDebugHelpersWindow;
    if (win.__zhenShaPageHidden === undefined) {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => Boolean((window as unknown as ZhenShaDebugHelpersWindow).__zhenShaPageHidden),
      });
    }
    win.__zhenShaPageHidden = nextHidden;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/**
 * Restore the real `document.hidden` getter after {@link setPageHidden} and
 * dispatch the visible `visibilitychange` a restore implies, so a live game
 * resumes its frame loop instead of staying logically hidden. Callers that
 * only want the stub removed can call `setPageHidden(page, false)` first.
 */
export async function restorePageVisibility(page: Page): Promise<void> {
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden');
    delete (window as unknown as ZhenShaDebugHelpersWindow).__zhenShaPageHidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/**
 * Collect `console.error` messages from now on. Assert `[]` at the end of each
 * test; the fixture already fails on uncaught page errors.
 */
export function trackZhenShaConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  return errors;
}

/**
 * Install the fixture listener / long-timer / rAF probes. Like all
 * `addInitScript` probes this must run before the first `page.goto`.
 */
export async function installZhenShaProbes(page: Page): Promise<void> {
  await installListenerProbe(page);
  await installRafProbe(page);
}

export {
  expectNoAnimationFrames,
  installListenerProbe,
  installRafProbe,
  listenerCount,
  pendingLongTimerCount,
  rafCount,
  rafPending,
  resetRafCount,
  trackProbeTarget,
};
// Re-exported so the mobile and lifecycle suites can import every tool from
// this one contract; the adapters above are the Zhen Sha-specific narrowings.
export {
  cancelTouch,
  endTouch,
  moveTouch,
  startTouch,
  TOUCH_POINTER_ID,
} from './touch-input';
export type { TouchGesture } from './touch-input';
export type {
  ZhenShaDebugApi,
  ZhenShaDebugInput,
  ZhenShaDebugState,
  ZhenShaDebugWindow,
} from '../../src/games/zhen-sha/debug';

/** Assert the page does not scroll horizontally at the narrow viewport. */
export async function expectNoZhenShaHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, 'Zhen Sha page should not scroll horizontally').toBeLessThanOrEqual(1);
}

async function expectControlAtLeast44(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} should have a bounding box`).not.toBeNull();
  if (box === null) {
    return;
  }
  expect(box.width, `${label} should be at least 44px wide`).toBeGreaterThanOrEqual(44);
  expect(box.height, `${label} should be at least 44px tall`).toBeGreaterThanOrEqual(44);
}

/**
 * Every game control that is currently visible must be a large enough touch
 * target: the stage, the panel restart button and, once settled, the
 * settlement overlay's restart button.
 */
export async function expectZhenShaTouchTargets(page: Page): Promise<void> {
  await expectControlAtLeast44(page.getByTestId('zhen-sha-stage'), 'stage');
  await expectControlAtLeast44(page.getByTestId('restart-button'), 'restart button');
  const overlayRestart = page.getByTestId('overlay-restart');
  if (await overlayRestart.isVisible()) {
    await expectControlAtLeast44(overlayRestart, 'settlement restart');
  }
}

/**
 * Assert that a visible element starts and ends inside the current viewport.
 * Exported so the mobile and WebKit suites can reuse the first-screen contract
 * for the gesture hints, not only for the settlement content.
 */
export async function expectZhenShaInsideFirstScreen(
  page: Page,
  locator: Locator,
  label: string,
): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) {
    throw new Error('Zhen Sha layout assertions require a fixed viewport');
  }
  const box = await locator.boundingBox();
  expect(box, `${label} should have a bounding box`).not.toBeNull();
  if (box === null) {
    return;
  }
  expect(box.x, `${label} should start inside the first screen`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${label} should start inside the first screen`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${label} should end inside the first screen`).toBeLessThanOrEqual(
    viewport.width + 1,
  );
  expect(box.y + box.height, `${label} should end inside the first screen`).toBeLessThanOrEqual(
    viewport.height + 1,
  );
}

/**
 * The settlement content and its restart control must be readable without
 * scrolling. The overlay backdrop may extend below the fold on a short phone,
 * so this asserts the title, body and button rather than the stage-sized
 * backdrop, and verifies the page itself was not scrolled to reach them.
 */
export async function expectZhenShaSettlementInFirstScreen(page: Page): Promise<void> {
  await expect(page.getByTestId('overlay')).toBeVisible();
  await expectZhenShaInsideFirstScreen(
    page,
    page.getByTestId('overlay-title'),
    'settlement title',
  );
  await expectZhenShaInsideFirstScreen(
    page,
    page.getByTestId('overlay-body'),
    'settlement body',
  );
  await expectZhenShaInsideFirstScreen(
    page,
    page.getByTestId('overlay-restart'),
    'settlement restart',
  );
  await expectControlAtLeast44(
    page.getByTestId('overlay-restart'),
    'settlement restart',
  );
  const scrollY = await page.evaluate(() => window.scrollY);
  expect(scrollY, 'the settlement must not require scrolling the page').toBeLessThanOrEqual(1);
}
