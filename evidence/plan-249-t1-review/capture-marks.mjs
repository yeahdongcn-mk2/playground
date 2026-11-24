import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';

const [baseUrl, outputPrefix] = process.argv.slice(2);

if (baseUrl === undefined || outputPrefix === undefined) {
  console.error(
    'usage: node evidence/plan-249-t1-review/capture-marks.mjs <base-url> <output-prefix>',
  );
  process.exitCode = 2;
} else {
  mkdirSync(dirname(outputPrefix), { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [
      [320, 640],
      [1440, 1000],
    ]) {
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 1,
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      });
      // Freeze the duel at the same tick in Before and After. Pause the manual
      // clock before the app boots so page-load time cannot advance it, then
      // advance exactly 932 ms (900 + 32) and let the pending frame paint.
      await page.clock.install({ time: new Date('2026-01-01T00:00:00.000Z') });
      await page.clock.pauseAt(new Date('2026-01-01T00:00:01.000Z'));
      await page.goto(`${baseUrl}/#/games/zhen-sha`, { waitUntil: 'networkidle' });
      await page.clock.runFor(900);
      await page.clock.runFor(32);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(80);

      const suffix = `${width}x${height}`;
      await page.screenshot({ path: `${outputPrefix}-resting-${suffix}.png` });

      // Charging state: the canvas lifts the staff arc by 34 logical pixels
      // after a 220 ms hold. Capture the same 700 ms hold in both revisions so
      // the CSS gold edge can be compared against the lifted Canvas arc.
      // The required resting pair stays at scroll 0. For the supplementary
      // charging pair, scroll the whole stage into view in both revisions so
      // the staff arc (bottom of the stage) is on screen when it lifts.
      const stage = page.getByTestId('zhen-sha-stage');
      await stage.scrollIntoViewIfNeeded();
      const stageBox = await stage.boundingBox();
      if (stageBox === null) {
        throw new Error(`missing stage bounding box at ${suffix}`);
      }
      await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
      await page.mouse.down();
      try {
        await page.clock.runFor(700);
        await page.screenshot({ path: `${outputPrefix}-charging-${suffix}.png` });
      } finally {
        await page.mouse.up();
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
