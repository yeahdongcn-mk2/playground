import { chromium } from '@playwright/test';

const [baseUrl] = process.argv.slice(2);

if (baseUrl === undefined) {
  console.error('usage: node evidence/plan-249-t1-review/verify-marks.mjs <base-url>');
  process.exitCode = 2;
} else {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 320, height: 640 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    await page.goto(`${baseUrl}/#/games/zhen-sha`, { waitUntil: 'networkidle' });
    const stage = page.getByTestId('zhen-sha-stage');
    await stage.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);

    /**
     * Compare the Canvas gold arc's bright core with the CSS gold edge's
     * clip-path band at the same x. Both live in the 360x560 logical canvas, so
     * an aligned pair differs by only the stroke/band width, not by the 34px
     * lift the canvas applies while charging.
     */
    const compare = async () =>
      page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="zhen-sha-canvas"]');
        const edge = document.querySelector('.zhen-sha-arc-edge');
        if (!(canvas instanceof HTMLCanvasElement)) {
          throw new Error('missing canvas');
        }
        if (!(edge instanceof HTMLElement)) {
          throw new Error('missing CSS gold edge');
        }
        const ctx = canvas.getContext('2d');
        if (ctx === null) {
          throw new Error('missing 2d context');
        }
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        // The 7px gold stroke is the only saturated gold in this band; take
        // the middle of its qualifying span so the bright inner highlight does
        // not pull the estimate to one edge.
        const goldCore = (x) => {
          let minY = -1;
          let maxY = -1;
          for (let y = 400; y <= 515; y += 1) {
            const index = (y * canvas.width + x) * 4;
            const r = pixels[index] ?? 0;
            const g = pixels[index + 1] ?? 0;
            const b = pixels[index + 2] ?? 0;
            if (r > 150 && g > 120 && b < 210) {
              if (minY < 0) {
                minY = y;
              }
              maxY = y;
            }
          }
          return minY < 0 ? -1 : (minY + maxY) / 2;
        };

        const raw = getComputedStyle(edge).clipPath;
        const inner = /^\s*polygon\(\s*([\s\S]*?)\s*\)\s*$/.exec(raw);
        if (inner === null) {
          throw new Error(`bad edge clip-path: ${raw}`);
        }
        const points = (inner[1] ?? '').split(',').map((part) => {
          const match = /^\s*(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%\s*$/.exec(part);
          if (match === null) {
            throw new Error(`bad edge point: ${part}`);
          }
          return { x: Number(match[1]) / 100, y: Number(match[2]) / 100 };
        });
        const top = points.slice(0, points.length / 2);
        const bottom = points.slice(points.length / 2).reverse();
        const centerY = (logicalX) => {
          const fraction = logicalX / canvas.width;
          let found = null;
          for (let index = 0; index < top.length - 1; index += 1) {
            const left = top[index];
            const right = top[index + 1];
            if (left === undefined || right === undefined) {
              continue;
            }
            if (fraction >= left.x && fraction <= right.x) {
              const ratio = (fraction - left.x) / (right.x - left.x);
              const topY = left.y + (right.y - left.y) * ratio;
              const leftBottom = bottom[index];
              const rightBottom = bottom[index + 1];
              if (leftBottom === undefined || rightBottom === undefined) {
                continue;
              }
              const bottomY = leftBottom.y + (rightBottom.y - leftBottom.y) * ratio;
              found = ((topY + bottomY) / 2) * canvas.height;
            }
          }
          return found;
        };

        const samples = [];
        for (let x = 90; x <= 290; x += 10) {
          const canvasY = goldCore(x);
          const cssY = centerY(x);
          if (canvasY < 0 || cssY === null) {
            continue;
          }
          samples.push({ x, canvasY, cssY, delta: cssY - canvasY });
        }
        return { samples, clip: raw };
      });

    const resting = await compare();

    const stageBox = await stage.boundingBox();
    if (stageBox === null) {
      throw new Error('missing stage bounding box');
    }
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + 40);
    await page.mouse.down();
    await page.waitForTimeout(700);
    const charging = await compare();
    await page.mouse.up();

    const maxAbs = (result) =>
      result.samples.reduce((max, sample) => Math.max(max, Math.abs(sample.delta)), 0);
    const average = (result) =>
      result.samples.reduce((sum, sample) => sum + sample.canvasY, 0) / result.samples.length;

    const lift = average(resting) - average(charging);
    console.log(`alignment samples: ${resting.samples.length} / ${charging.samples.length}`);
    console.log(`resting max |css-canvas|: ${maxAbs(resting).toFixed(2)} px`);
    console.log(`charging max |css-canvas|: ${maxAbs(charging).toFixed(2)} px`);
    console.log(`canvas arc lift (resting - charging): ${lift.toFixed(2)} px`);

    if (resting.samples.length < 10 || charging.samples.length < 10) {
      throw new Error('not enough alignment samples');
    }
    if (maxAbs(resting) > 4 || maxAbs(charging) > 4) {
      throw new Error(
        `CSS gold edge is not aligned with the Canvas arc (resting ${maxAbs(resting).toFixed(2)} px, charging ${maxAbs(charging).toFixed(2)} px)`,
      );
    }
    if (lift < 10) {
      throw new Error(`Canvas arc did not lift while charging (${lift.toFixed(2)} px)`);
    }
  } finally {
    await browser.close();
  }
}
