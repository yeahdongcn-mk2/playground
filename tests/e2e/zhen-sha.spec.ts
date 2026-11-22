import { readFileSync } from 'node:fs';
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

/**
 * Count every window.fetch / XMLHttpRequest call. Installed before navigation so
 * the save flow can prove it never touches the network, even while offline.
 */
async function installNetworkProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = window as unknown as { __networkCalls?: number };
    probe.__networkCalls = 0;

    const fetchImpl = (window as unknown as { fetch?: (...args: unknown[]) => Promise<unknown> })
      .fetch;
    if (typeof fetchImpl === 'function') {
      (window as unknown as { fetch: (...args: unknown[]) => Promise<unknown> }).fetch = (
        ...args: unknown[]
      ) => {
        probe.__networkCalls = (probe.__networkCalls ?? 0) + 1;
        return fetchImpl(...args);
      };
    }

    const xhr = XMLHttpRequest.prototype as unknown as {
      open: (...args: unknown[]) => void;
    };
    const originalOpen = xhr.open;
    xhr.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
      probe.__networkCalls = (probe.__networkCalls ?? 0) + 1;
      originalOpen.apply(this, args);
    };
  });
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

test('saves the battle seal as a 1080x1440 PNG while offline', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installNetworkProbe(page);
  await openDebugGame(page);
  await playFixedWin(page);

  await context.setOffline(true);
  try {
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('overlay-save-seal').click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^zhen-sha-seal-\d+\.png$/);
    const downloadPath = await download.path();
    if (downloadPath === null) {
      throw new Error('the download has no local path');
    }
    const png = readFileSync(downloadPath);

    // PNG signature followed by the IHDR width/height, big-endian.
    expect([...png.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(png.readUInt32BE(16)).toBe(1080);
    expect(png.readUInt32BE(20)).toBe(1440);

    // The same native button is keyboard operable and downloads again.
    await page.getByTestId('overlay-save-seal').focus();
    const keyboardDownload = page.waitForEvent('download');
    await page.keyboard.press('Enter');
    expect((await keyboardDownload).suggestedFilename()).toMatch(
      /^zhen-sha-seal-\d+\.png$/,
    );

    const networkCalls = await page.evaluate(
      () => (window as unknown as { __networkCalls?: number }).__networkCalls ?? 0,
    );
    expect(networkCalls).toBe(0);
  } finally {
    await context.setOffline(false);
  }
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

test('keeps the settlement readable: all actions inside the 320x640 first screen', async ({
  page,
}) => {
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
    const save = document.querySelector('[data-testid="overlay-save-seal"]') as HTMLElement;
    const lobby = document.querySelector('[data-testid="overlay-lobby"]') as HTMLElement;
    const stat = document.querySelector(
      '[data-testid="settlement-perfects"]',
    ) as HTMLElement;
    const box = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      card: box(card),
      canvasWidth: box(canvas).width,
      restart: box(restart),
      save: box(save),
      lobby: box(lobby),
      statFontSize: Number.parseFloat(getComputedStyle(stat).fontSize),
    };
  });

  expect(metrics.viewport).toEqual({ width: 320, height: 640 });
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.card.width).toBeLessThanOrEqual(320);
  expect(metrics.canvasWidth).toBeGreaterThan(120);
  expect(metrics.restart.height).toBeGreaterThanOrEqual(44);
  expect(metrics.save.height).toBeGreaterThanOrEqual(44);
  expect(metrics.lobby.height).toBeGreaterThanOrEqual(44);
  expect(metrics.statFontSize).toBeGreaterThanOrEqual(12);

  // The result must be operable on the documented minimum viewport without
  // scrolling: assert the geometry, not just non-zero visibility. With the
  // mobile overlay falling back to `position: absolute`, the card and all
  // three actions land below 640px and these bounds fail.
  for (const [label, rect] of [
    ['settlement card', metrics.card],
    ['restart action', metrics.restart],
    ['save action', metrics.save],
    ['lobby action', metrics.lobby],
  ] as const) {
    expect(rect.top, `${label} starts inside the 320x640 first screen`).toBeGreaterThanOrEqual(0);
    expect(rect.bottom, `${label} ends inside the 320x640 first screen`).toBeLessThanOrEqual(
      metrics.viewport.height,
    );
    expect(rect.left, `${label} starts inside the 320x640 first screen`).toBeGreaterThanOrEqual(0);
    expect(rect.right, `${label} ends inside the 320x640 first screen`).toBeLessThanOrEqual(
      metrics.viewport.width,
    );
  }

  for (const testId of [
    'settlement-perfects',
    'settlement-elapsed',
    'settlement-slashes',
    'settlement-boss',
    'overlay-restart',
    'overlay-save-seal',
    'overlay-lobby',
  ]) {
    await expect(page.getByTestId(testId)).toBeVisible();
  }

  // Bounding boxes alone cannot prove the result is readable: the fixed layer
  // used to live inside the stage's stacking context, so the sticky site header
  // still painted over the top of the card even though every rect was inside
  // the viewport. Hit-test the content instead and require the visible element
  // to belong to the settlement.
  const occlusion = await page.evaluate(() => {
    const header = document.querySelector('.site-header') as HTMLElement;
    const ids = [
      'overlay-kicker',
      'overlay-title',
      'settlement-canvas',
      'settlement-perfects',
      'settlement-elapsed',
      'settlement-slashes',
      'settlement-boss',
      'overlay-restart',
      'overlay-save-seal',
      'overlay-lobby',
    ] as const;
    const samples = ids.flatMap((testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      return [
        { testId, x, y: rect.top + 1 },
        { testId, x, y: rect.top + rect.height / 2 },
      ];
    });
    return {
      headerBottom: header.getBoundingClientRect().bottom,
      samples: samples.map(({ testId, x, y }) => {
        const hit = document.elementFromPoint(x, y) as HTMLElement | null;
        return {
          testId,
          x: Math.round(x),
          y: Math.round(y),
          hitTestId: hit?.dataset.testid ?? null,
          insideSettlement: Boolean(hit?.closest('[data-testid="settlement"]')),
        };
      }),
    };
  });

  // At least one sample must sit in the header band; otherwise this case could
  // silently stop covering the occlusion it is meant to catch.
  expect(
    occlusion.samples.filter((sample) => sample.y < occlusion.headerBottom).length,
    'samples must exercise the header band',
  ).toBeGreaterThan(0);
  for (const sample of occlusion.samples) {
    expect(
      sample.insideSettlement,
      `${sample.testId} at (${sample.x}, ${sample.y}) is covered by ` +
        `"${sample.hitTestId ?? 'unknown'}" instead of the settlement`,
    ).toBe(true);
  }
});

test.describe('touch input', () => {
  test.use({ hasTouch: true });

  test('saves the battle seal with a touch tap at 320x640', async ({ page }) => {
    await openDebugGame(page);
    await playFixedWin(page);

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('overlay-save-seal').tap();
    expect((await downloadPromise).suggestedFilename()).toMatch(
      /^zhen-sha-seal-\d+\.png$/,
    );
  });
});
