import type { Page } from '@playwright/test';
import type { ZhenShaSnapshot } from '../../src/games/zhen-sha/engine';
import type { ZhenShaSettlement } from '../../src/games/zhen-sha/settlement';
import { expect, test } from './fixtures';

test.use({ viewport: { width: 320, height: 640 } });

interface ZhenShaDebugState extends ZhenShaSnapshot {
  settlement: ZhenShaSettlement | null;
}

interface ZhenShaDebugApi {
  readonly gameId: 'zhen-sha';
  readonly getState: () => ZhenShaDebugState;
  readonly input: (action: 'block' | 'charge' | 'strike') => void;
  readonly step: (ticks?: number) => void;
  readonly restart: () => void;
  readonly destroy: () => void;
}

interface DebugWindow {
  __playground?: ZhenShaDebugApi;
}

async function openDebugGame(page: Page): Promise<void> {
  await page.goto('/#/games/zhen-sha?debug=1');
  await expect(page.getByTestId('zhen-sha-game')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as DebugWindow).__playground?.gameId ?? null),
    )
    .toBe('zhen-sha');
}

async function readState(page: Page): Promise<ZhenShaDebugState> {
  return page.evaluate(() => {
    const api = (window as unknown as DebugWindow).__playground;
    if (api?.gameId !== 'zhen-sha') {
      throw new Error('Playwright zhen-sha debug API is not available');
    }
    return api.getState();
  });
}

/** Fixed input sequence: three perfect parries at ticks 180 / 360 / 540, then
 * charge + strike inside the break. Every tap lands exactly on its impact tick,
 * so the snapshot depends only on the tick schedule, never on frame pacing. */
async function playFixedWin(page: Page): Promise<ZhenShaDebugState> {
  return page.evaluate(() => {
    const api = (window as unknown as DebugWindow).__playground;
    if (api?.gameId !== 'zhen-sha') {
      throw new Error('Playwright zhen-sha debug API is not available');
    }
    api.step(180);
    api.input('block');
    api.step(1);
    api.step(179);
    api.input('block');
    api.step(1);
    api.step(179);
    api.input('block');
    api.step(1);
    api.input('charge');
    api.step(1);
    api.input('strike');
    api.step(1);
    return api.getState();
  });
}

/** Fixed loss: never tap. The third unparried move ends the duel at tick 595. */
async function playFixedLoss(page: Page): Promise<ZhenShaDebugState> {
  return page.evaluate(() => {
    const api = (window as unknown as DebugWindow).__playground;
    if (api?.gameId !== 'zhen-sha') {
      throw new Error('Playwright zhen-sha debug API is not available');
    }
    api.step(600);
    return api.getState();
  });
}

const WIN_EVENT_STEPS = [180, 360, 540, 540, 542, 542] as const;

/**
 * 320x640 is the documented minimum viewport. The stage may extend past the
 * fold, but the three gesture hints are the onboarding copy and must be read
 * without scrolling (issue #250 t2 review).
 */
test('shows the three gesture hints inside the 320x640 first screen', async ({ page }) => {
  await page.goto('/#/games/zhen-sha');

  const hints = page.getByTestId('gesture-hints');
  await expect(hints).toBeVisible();
  await expect(hints.locator('li')).toHaveCount(3);

  const hintsBox = await hints.boundingBox();
  expect(hintsBox).not.toBeNull();
  expect(hintsBox!.y).toBeGreaterThanOrEqual(0);
  expect(hintsBox!.y + hintsBox!.height).toBeLessThanOrEqual(640);

  // On phones the hints lead the stage so they are not pushed below the fold by
  // the tall play area.
  const stageBox = await page.getByTestId('zhen-sha-stage').boundingBox();
  expect(stageBox).not.toBeNull();
  expect(stageBox!.y).toBeGreaterThanOrEqual(hintsBox!.y + hintsBox!.height);
});

test('settles a fixed win into the battle seal and restarts from boss 1 phase 1', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openDebugGame(page);

  const state = await playFixedWin(page);
  expect(state.status).toBe('won');
  expect(state.perfects).toBe(3);
  expect(state.score).toBe(1900);
  expect(state.hits).toBe(0);
  expect(state.elapsedMs).toBeCloseTo(4525, 6);
  expect(state.boss).toEqual({ name: '黑煞', phase: 1, guard: 'broken' });

  const settlement = state.settlement;
  expect(settlement).not.toBeNull();
  if (settlement === null) {
    return;
  }
  expect(settlement.perfects).toBe(3);
  expect(settlement.elapsedMs).toBeCloseTo(4525, 6);
  expect(settlement.boss).toEqual({ name: '黑煞', phase: 1 });
  expect(settlement.slashes.map((slash) => slash.step)).toEqual([...WIN_EVENT_STEPS]);

  const overlay = page.getByTestId('overlay');
  await expect(overlay).toBeVisible();
  await expect(page.getByTestId('settlement')).toBeVisible();
  await expect(page.getByTestId('settlement-perfects')).toHaveText('3');
  await expect(page.getByTestId('settlement-elapsed')).toHaveText('4.5s');
  await expect(page.getByTestId('settlement-slashes')).toHaveText('6 道');
  await expect(page.getByTestId('settlement-boss')).toHaveText('黑煞 · 第 1 阶段');
  await expect(page.getByTestId('overlay-title')).toHaveText('一棍定魂');
  await expect(page.getByTestId('settlement-canvas')).toHaveAttribute('data-stamps', '1');

  // Later renders keep the very same settlement object and stamp count.
  const stable = await page.evaluate(() => {
    const api = (window as unknown as DebugWindow).__playground;
    if (api?.gameId !== 'zhen-sha') {
      throw new Error('Playwright zhen-sha debug API is not available');
    }
    const first = api.getState().settlement;
    api.step(20);
    const second = api.getState().settlement;
    const canvas = document.querySelector(
      '[data-testid="settlement-canvas"]',
    ) as HTMLCanvasElement | null;
    return { same: first === second, stamps: canvas?.dataset.stamps ?? null };
  });
  expect(stable).toEqual({ same: true, stamps: '1' });

  const desktop = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(desktop.scrollWidth).toBeLessThanOrEqual(desktop.clientWidth);

  await page.getByTestId('overlay-restart').click();
  await expect(overlay).toBeHidden();
  const reset = await readState(page);
  expect(reset.status).toBe('playing');
  expect(reset.step).toBe(0);
  expect(reset.perfects).toBe(0);
  expect(reset.settlement).toBeNull();
  expect(reset.boss).toEqual({ name: '黑煞', phase: 1, guard: 'up' });

  // A second duel settles from scratch: six arcs, not twelve.
  const again = await playFixedWin(page);
  expect(again.settlement?.slashes).toHaveLength(WIN_EVENT_STEPS.length);
  await expect(overlay).toBeVisible();
  await expect(page.getByTestId('settlement-canvas')).toHaveAttribute('data-stamps', '1');

  await page.getByTestId('overlay-restart').click();
  expect((await readState(page)).status).toBe('playing');
  expect((await readState(page)).settlement).toBeNull();
});

test('settles a fixed loss with the frozen boss phase and no perfects', async ({ page }) => {
  await openDebugGame(page);

  const state = await playFixedLoss(page);
  expect(state.status).toBe('lost');
  expect(state.hits).toBe(3);
  expect(state.perfects).toBe(0);
  expect(state.elapsedMs).toBeCloseTo(595 * (1000 / 120), 6);
  expect(state.boss).toEqual({ name: '黑煞', phase: 1, guard: 'up' });
  expect(state.settlement?.slashes).toHaveLength(4);

  await expect(page.getByTestId('overlay')).toBeVisible();
  await expect(page.getByTestId('overlay-title')).toHaveText('被黑煞击倒');
  await expect(page.getByTestId('settlement-perfects')).toHaveText('0');
  await expect(page.getByTestId('settlement-elapsed')).toHaveText('5.0s');
  await expect(page.getByTestId('settlement-slashes')).toHaveText('4 道');
  await expect(page.getByTestId('settlement-boss')).toHaveText('黑煞 · 第 1 阶段');
});

test('returns from the settlement to the lobby and re-enters with a fresh duel', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openDebugGame(page);
  await playFixedWin(page);

  await page.getByTestId('overlay-lobby').click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByTestId('game-card-zhen-sha')).toBeVisible();

  await page.getByTestId('game-card-zhen-sha').click();
  await expect(page).toHaveURL(/#\/games\/zhen-sha$/);
  await expect(page.getByTestId('zhen-sha-game')).toBeVisible();
  await expect(page.getByTestId('status')).toHaveText('进行中');
  await expect(page.getByTestId('perfects')).toHaveText('0');
  await expect(page.getByTestId('overlay')).toBeHidden();
  // The normal entry never installs the debug seam.
  expect(
    await page.evaluate(() => (window as unknown as DebugWindow).__playground),
  ).toBeUndefined();
});

test('keeps the settlement readable and targets at least 44px at 320x640', async ({ page }) => {
  await openDebugGame(page);
  await playFixedWin(page);

  const metrics = await page.evaluate(() => {
    const canvas = document.querySelector(
      '[data-testid="settlement-canvas"]',
    ) as HTMLCanvasElement;
    const card = document.querySelector('[data-testid="settlement"]') as HTMLElement;
    const restart = document.querySelector(
      '[data-testid="overlay-restart"]',
    ) as HTMLElement;
    const lobby = document.querySelector('[data-testid="overlay-lobby"]') as HTMLElement;
    const stat = document.querySelector(
      '[data-testid="settlement-perfects"]',
    ) as HTMLElement;
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      cardWidth: card.getBoundingClientRect().width,
      canvasWidth: canvas.getBoundingClientRect().width,
      restartHeight: restart.getBoundingClientRect().height,
      lobbyHeight: lobby.getBoundingClientRect().height,
      statFontSize: Number.parseFloat(getComputedStyle(stat).fontSize),
    };
  });

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.cardWidth).toBeLessThanOrEqual(320);
  expect(metrics.canvasWidth).toBeGreaterThan(120);
  expect(metrics.restartHeight).toBeGreaterThanOrEqual(44);
  expect(metrics.lobbyHeight).toBeGreaterThanOrEqual(44);
  expect(metrics.statFontSize).toBeGreaterThanOrEqual(12);

  for (const testId of [
    'settlement-perfects',
    'settlement-elapsed',
    'settlement-slashes',
    'settlement-boss',
    'overlay-restart',
    'overlay-lobby',
  ]) {
    await expect(page.getByTestId(testId)).toBeVisible();
  }
});
