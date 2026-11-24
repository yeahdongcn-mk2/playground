import { expect, test } from './fixtures';

const VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 1440, height: 1000 },
] as const;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function assertInsideStage(box: Box, stage: Box, label: string): void {
  const tolerance = 1;
  expect(box.x, `${label} 左边缘越出舞台`).toBeGreaterThanOrEqual(stage.x - tolerance);
  expect(box.y, `${label} 上边缘越出舞台`).toBeGreaterThanOrEqual(stage.y - tolerance);
  expect(box.x + box.width, `${label} 右边缘越出舞台`).toBeLessThanOrEqual(
    stage.x + stage.width + tolerance,
  );
  expect(box.y + box.height, `${label} 下边缘越出舞台`).toBeLessThanOrEqual(
    stage.y + stage.height + tolerance,
  );
}

interface PolygonPoint {
  readonly x: number;
  readonly y: number;
}

function parsePolygon(raw: string): PolygonPoint[] {
  const inner = /^\s*polygon\(\s*([\s\S]*?)\s*\)\s*$/.exec(raw);
  if (inner === null) {
    throw new Error(`not a polygon: ${raw}`);
  }
  return (inner[1] ?? '').split(',').map((part) => {
    const point = /^\s*(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%\s*$/.exec(part);
    if (point === null) {
      throw new Error(`cannot parse polygon point: ${part}`);
    }
    return { x: Number.parseFloat(point[1] ?? ''), y: Number.parseFloat(point[2] ?? '') };
  });
}

test.describe('zhen-sha decorative marks', () => {
  for (const viewport of VIEWPORTS) {
    test(`keeps the seal, wordmark and gold edge visible at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto('/#/games/zhen-sha');

      const stage = page.getByTestId('zhen-sha-stage');
      const seal = page.locator('.zhen-sha-seal');
      const wordmark = page.locator('.zhen-sha-wordmark');
      await expect(stage).toBeVisible();
      await expect(seal).toBeVisible();
      await expect(wordmark).toBeVisible();
      await expect(seal).toHaveText('镇煞');
      await expect(wordmark).toHaveText('镇煞');

      const stageBox = await stage.boundingBox();
      const sealBox = await seal.boundingBox();
      const wordmarkBox = await wordmark.boundingBox();
      if (stageBox === null || sealBox === null || wordmarkBox === null) {
        throw new Error('missing bounding box');
      }
      assertInsideStage(sealBox, stageBox, '朱砂印');
      assertInsideStage(wordmarkBox, stageBox, '字标');
      expect(overlaps(sealBox, wordmarkBox), '印与字标不能互相遮挡').toBe(false);

      const hud = await page.locator('.zhen-sha-hud').first().boundingBox();
      const hints = await page.getByTestId('gesture-hints').boundingBox();
      if (hud !== null) {
        expect(overlaps(sealBox, hud), '朱砂印不能遮挡 HUD').toBe(false);
        expect(overlaps(wordmarkBox, hud), '字标不能遮挡 HUD').toBe(false);
      }
      if (hints !== null) {
        expect(overlaps(sealBox, hints), '朱砂印不能遮挡手势提示').toBe(false);
        expect(overlaps(wordmarkBox, hints), '字标不能遮挡手势提示').toBe(false);
      }

      for (const [label, locator] of [
        ['朱砂印', seal],
        ['字标', wordmark],
      ] as const) {
        const style = await locator.evaluate((element) => {
          const computed = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return {
            color: computed.color,
            opacity: Number.parseFloat(computed.opacity),
            display: computed.display,
            visibility: computed.visibility,
            width: box.width,
            height: box.height,
          };
        });
        expect(style.display, `${label} 不能 display: none`).not.toBe('none');
        expect(style.visibility, `${label} 不能隐藏`).toBe('visible');
        expect(style.opacity, `${label} 的 opacity 必须大于 0`).toBeGreaterThan(0);
        expect(style.color, `${label} 的颜色不能透明`).not.toMatch(
          /^(?:transparent|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\))$/,
        );
        expect(style.width, `${label} 必须有宽度`).toBeGreaterThan(0);
        expect(style.height, `${label} 必须有高度`).toBeGreaterThan(0);
      }

      // The decorative layers must never intercept a gesture.
      for (const selector of ['.zhen-sha-marks', '.zhen-sha-arc-glow', '.zhen-sha-arc-edge']) {
        await expect(page.locator(selector)).toHaveCSS('pointer-events', 'none');
      }
    });
  }

  test('lifts the CSS gold edge with the canvas while charging at 320x640', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/#/games/zhen-sha');

    const stage = page.getByTestId('zhen-sha-stage');
    await expect(stage).toBeVisible();
    const edge = page.locator('.zhen-sha-arc-edge');
    const readClip = (): Promise<string> =>
      edge.evaluate((element) => getComputedStyle(element).clipPath);
    const isLifted = (): Promise<boolean> =>
      stage.evaluate((element) => element.classList.contains('is-arc-lifted'));

    const resting = await readClip();
    expect(resting).toMatch(/^polygon\(/);
    expect(await isLifted()).toBe(false);

    // At 320x640 the stage sits below the fold; scroll it fully into view before
    // pressing, otherwise the pointer coordinates fall outside the viewport.
    await stage.scrollIntoViewIfNeeded();
    const stageBox = await stage.boundingBox();
    if (stageBox === null) {
      throw new Error('missing stage bounding box');
    }
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + 40);
    await page.mouse.down();
    let raised: string;
    try {
      await expect
        .poll(readClip, { message: '蓄势后 CSS 金边应随 Canvas 金弧抬起', timeout: 2_000 })
        .not.toBe(resting);
      expect(await isLifted(), '蓄势时舞台应带 is-arc-lifted').toBe(true);
      // Read the raised clip while the pointer is still down: right after
      // pointerup the strike flash is set on the next animation frame, so a
      // read in that gap could see the resting polygon.
      raised = await readClip();
    } finally {
      await page.mouse.up();
    }
    const restingPoints = parsePolygon(resting);
    const raisedPoints = parsePolygon(raised);
    expect(raisedPoints).toHaveLength(restingPoints.length);
    expect(raisedPoints[0]?.x).toBeCloseTo(restingPoints[0]?.x ?? Number.NaN, 1);
    expect(raisedPoints[0]?.y).toBeCloseTo(restingPoints[0]?.y ?? Number.NaN, 1);
    for (let index = 0; index < restingPoints.length; index += 1) {
      const restPoint = restingPoints[index];
      const raisedPoint = raisedPoints[index];
      if (restPoint === undefined || raisedPoint === undefined) {
        throw new Error(`polygon point count mismatch at ${index}`);
      }
      expect(raisedPoint.y, `金边第 ${index} 个顶点没有随 lift 抬起`).toBeLessThanOrEqual(
        restPoint.y + 1e-9,
      );
    }
    expect(raisedPoints.some((point, index) => point.y < (restingPoints[index]?.y ?? 0))).toBe(
      true,
    );

    // Once the swing ends the edge settles back onto the resting arc.
    await expect
      .poll(readClip, { message: '收棍后 CSS 金边应回到静息弧', timeout: 3_000 })
      .toBe(resting);
    expect(await isLifted(), '收棍后舞台应移除 is-arc-lifted').toBe(false);
  });
});
