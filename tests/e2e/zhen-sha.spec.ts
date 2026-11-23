import { expect, test } from './fixtures';
import {
  EXPECTED_LOSS,
  EXPECTED_WIN,
  IMPACT_TICKS,
  LOSS_INPUTS,
  WIN_INPUTS,
  ZHEN_SHA_HOLD_TICKS,
  destroyZhenSha,
  enterZhenShaFromHub,
  enterZhenShaLiveFromHub,
  expectNoAnimationFrames,
  expectNoDebugSeam,
  expectNoZhenShaHorizontalOverflow,
  expectZhenShaInsideFirstScreen,
  expectZhenShaSettlementInFirstScreen,
  expectZhenShaSettlementState,
  expectZhenShaTouchTargets,
  holdZhenShaWithMouse,
  inputZhenSha,
  installZhenShaProbes,
  listenerCount,
  openZhenShaDebug,
  openZhenShaLive,
  parryZhenShaWithMouse,
  pendingLongTimerCount,
  rafCount,
  rafPending,
  readZhenShaState,
  restartZhenSha,
  restorePageVisibility,
  setPageHidden,
  stepZhenSha,
  trackProbeTarget,
  trackZhenShaConsoleErrors,
} from './zhen-sha-helpers';

test.describe('320×640 first screen', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('shows the three gesture hints inside the 320x640 first screen', async ({ page }) => {
    const errors = trackZhenShaConsoleErrors(page);
    await page.goto('/#/games/zhen-sha');

    const hints = page.getByTestId('gesture-hints');
    await expect(hints).toBeVisible();
    await expect(hints.locator('li')).toHaveCount(3);
    await expectZhenShaInsideFirstScreen(page, hints, 'gesture hints');

    // On phones the hints lead the stage so they are not pushed below the fold by
    // the tall play area.
    const hintsBox = await hints.boundingBox();
    expect(hintsBox).not.toBeNull();
    const stageBox = await page.getByTestId('zhen-sha-stage').boundingBox();
    expect(stageBox).not.toBeNull();
    expect(stageBox!.y).toBeGreaterThanOrEqual(hintsBox!.y + hintsBox!.height);
    expect(errors).toEqual([]);
  });

  test('keeps 320x640 horizontally scroll-free with 44px controls and a first-screen loss', async ({
    page,
  }) => {
    const errors = trackZhenShaConsoleErrors(page);
    const initial = await openZhenShaDebug(page, { seed: 253, inputs: LOSS_INPUTS });
    expect(initial.status).toBe('playing');

    await expectNoZhenShaHorizontalOverflow(page);
    await expectZhenShaTouchTargets(page);
    expect(await page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(1);

    const state = await stepZhenSha(page, 700);
    expectZhenShaSettlementState(state, EXPECTED_LOSS);

    await expectNoZhenShaHorizontalOverflow(page);
    await expectZhenShaSettlementInFirstScreen(page);
    await expect(page.getByTestId('overlay-title')).toHaveText(EXPECTED_LOSS.title);
    await expect(page.getByTestId('overlay-body')).toHaveText(EXPECTED_LOSS.body);
    expect(errors).toEqual([]);
  });
});

test.describe('desktop 1440×1000', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('enters from the hub, parries with the mouse and restarts by keyboard', async ({
    page,
  }) => {
    const errors = trackZhenShaConsoleErrors(page);
    let state = await enterZhenShaFromHub(page, { seed: 253 });
    expect(state.status).toBe('playing');
    expect(state.step).toBe(0);
    expect(state.seed).toBe(253);

    for (const [index, impact] of IMPACT_TICKS.entries()) {
      state = await parryZhenShaWithMouse(page, impact);
      expect(state.step, `parry ${index + 1} consumes tick ${impact}`).toBe(impact + 1);
      expect(state.perfects, `perfect parries after impact ${impact}`).toBe(index + 1);
      expect(state.score).toBe(300 * (index + 1));
      expect(state.hits).toBe(0);
      expect(state.status).toBe('playing');
    }

    expect(state.momentum).toBe(3);
    expect(state.breakTicksLeft).toBeGreaterThan(0);

    await inputZhenSha(page, 'charge', 541);
    await inputZhenSha(page, 'strike', 542);
    state = await stepZhenSha(page, 2);
    expectZhenShaSettlementState(state, EXPECTED_WIN);

    await expect(page.getByTestId('overlay')).toBeVisible();
    await expect(page.getByTestId('overlay-title')).toHaveText(EXPECTED_WIN.title);
    await expect(page.getByTestId('overlay-body')).toHaveText(EXPECTED_WIN.body);
    await expectZhenShaSettlementInFirstScreen(page);

    // The view focuses the settlement restart on the winning transition, so
    // Enter is a real keyboard activation of that button.
    await expect(page.getByTestId('overlay-restart')).toBeFocused();
    await page.keyboard.press('Enter');
    state = await readZhenShaState(page);
    expect(state.status).toBe('playing');
    expect(state.step).toBe(0);
    expect(state.perfects).toBe(0);
    expect(state.hits).toBe(0);
    expect(state.score).toBe(0);
    await expect(page.getByTestId('overlay')).toBeHidden();
    await expect(page.getByTestId('perfects')).toHaveText('0');
    await expect(page.getByTestId('score')).toHaveText('0');
    await expect(page.getByTestId('status')).toHaveText('进行中');

    // A mouse click on the side-panel restart also resets in-progress counters.
    state = await parryZhenShaWithMouse(page, 180);
    expect(state.perfects).toBe(1);
    expect(state.score).toBe(300);
    await expect(page.getByTestId('perfects')).toHaveText('1');
    await page.getByTestId('restart-button').click();
    state = await readZhenShaState(page);
    expect(state.status).toBe('playing');
    expect(state.step).toBe(0);
    expect(state.perfects).toBe(0);
    expect(state.hits).toBe(0);
    expect(state.score).toBe(0);
    await expect(page.getByTestId('perfects')).toHaveText('0');
    await expect(page.getByTestId('score')).toHaveText('0');
    expect(errors).toEqual([]);
  });

  test('holds the mouse to charge and releases to strike on the open guard', async ({
    page,
  }) => {
    const errors = trackZhenShaConsoleErrors(page);
    await openZhenShaDebug(page, { seed: 253, inputs: WIN_INPUTS.slice(0, 3) });
    const parried = await stepZhenSha(page, 541);
    expect(parried.status).toBe('playing');
    expect(parried.perfects).toBe(3);
    expect(parried.breakTicksLeft).toBeGreaterThan(ZHEN_SHA_HOLD_TICKS);

    await holdZhenShaWithMouse(page);
    const charged = await readZhenShaState(page);
    expect(charged.charging).toBe(true);
    expect(charged.step).toBe(541 + ZHEN_SHA_HOLD_TICKS);

    const won = await stepZhenSha(page, 1);
    expectZhenShaSettlementState(won, {
      ...EXPECTED_WIN,
      settledAtStep: 541 + ZHEN_SHA_HOLD_TICKS + 1,
    });
    await expect(page.getByTestId('overlay-title')).toHaveText(EXPECTED_WIN.title);
    expect(errors).toEqual([]);
  });

  test('replays seed + inputs to the win without pointer events, twice', async ({ page }) => {
    const errors = trackZhenShaConsoleErrors(page);
    const initial = await openZhenShaDebug(page, { seed: 253, inputs: WIN_INPUTS });
    expect(initial.status).toBe('playing');
    expect(initial.step).toBe(0);
    expect(initial.seed).toBe(253);

    const first = await stepZhenSha(page, 700);
    expectZhenShaSettlementState(first, EXPECTED_WIN);
    await expect(page.getByTestId('overlay-title')).toHaveText(EXPECTED_WIN.title);
    await expect(page.getByTestId('overlay-body')).toHaveText(EXPECTED_WIN.body);

    const restarted = await restartZhenSha(page);
    expect(restarted.status).toBe('playing');
    expect(restarted.step).toBe(0);
    const second = await stepZhenSha(page, 700);
    expectZhenShaSettlementState(second, EXPECTED_WIN);
    expect(second.perfects).toBe(first.perfects);
    expect(second.score).toBe(first.score);
    expect(second.hits).toBe(first.hits);
    expect(errors).toEqual([]);
  });

  test('replays seed + inputs to the loss without pointer events', async ({ page }) => {
    const errors = trackZhenShaConsoleErrors(page);
    await openZhenShaDebug(page, { seed: 253, inputs: LOSS_INPUTS });

    const state = await stepZhenSha(page, 700);
    expectZhenShaSettlementState(state, EXPECTED_LOSS);
    await expect(page.getByTestId('overlay-title')).toHaveText(EXPECTED_LOSS.title);
    await expect(page.getByTestId('overlay-body')).toHaveText(EXPECTED_LOSS.body);
    expect(errors).toEqual([]);
  });

  test('opens normal play without installing the debug seam', async ({ page }) => {
    const errors = trackZhenShaConsoleErrors(page);

    await openZhenShaLive(page);
    await expectNoDebugSeam(page, 'normal entry must not install window.__playground');

    await enterZhenShaLiveFromHub(page);
    await expectNoDebugSeam(page, 'normal hub entry must not install window.__playground');
    await expect(page.getByTestId('zhen-sha-stage')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('pauses the live frame loop while hidden and resumes it when shown', async ({
    page,
  }) => {
    const errors = trackZhenShaConsoleErrors(page);
    await installZhenShaProbes(page);
    await openZhenShaLive(page);
    await expect.poll(() => rafCount(page)).toBeGreaterThan(0);

    await setPageHidden(page, true);
    try {
      await expectNoAnimationFrames(page);
      expect(await pendingLongTimerCount(page)).toBe(0);
    } finally {
      await setPageHidden(page, false);
      await restorePageVisibility(page);
    }

    await expect.poll(() => rafCount(page)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('releases the debug seam and its listeners on destroy', async ({ page }) => {
    const errors = trackZhenShaConsoleErrors(page);
    await installZhenShaProbes(page);
    await openZhenShaDebug(page, { seed: 253 });
    await trackProbeTarget(page, 'zhen-sha-stage', '[data-testid="zhen-sha-stage"]');

    expect(await listenerCount(page, 'document', 'visibilitychange')).toBe(1);
    expect(await listenerCount(page, 'zhen-sha-stage', 'pointerdown')).toBe(1);
    expect(await pendingLongTimerCount(page)).toBe(0);
    expect(await rafPending(page)).toBe(0);

    // The captured product destroy runs twice in one evaluate, proving the
    // idempotency the lifecycle suite needs.
    await destroyZhenSha(page, 2);
    await expect.poll(() => listenerCount(page, 'document', 'visibilitychange')).toBe(0);
    await expect.poll(() => listenerCount(page, 'zhen-sha-stage', 'pointerdown')).toBe(0);
    expect(await pendingLongTimerCount(page)).toBe(0);
    expect(await rafPending(page)).toBe(0);
    expect(errors).toEqual([]);
  });
});
