import { chromium } from '@playwright/test';

const [baseUrl, prefix, state = 'after'] = process.argv.slice(2);

if (baseUrl === undefined || prefix === undefined) {
  console.error(
    'usage: node evidence/plan-245-t0/capture-tutorial.mjs <url> <output-prefix> <before|after|before-reduced|after-reduced>',
  );
  process.exitCode = 2;
} else if (!['before', 'after', 'before-reduced', 'after-reduced'].includes(state)) {
  console.error(`unknown state: ${state}`);
  process.exitCode = 2;
} else {
  const reduceMotion = state.endsWith('reduced');
  const baseline = state.startsWith('before');
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [
      [1440, 1000],
      [390, 844],
    ]) {
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 1,
        reducedMotion: reduceMotion ? 'reduce' : 'no-preference',
        // Fresh context: empty localStorage is the first-visit state.
      });
      await page.goto(`${baseUrl}/#/games/zhen-sha`, { waitUntil: 'networkidle' });
      await page.getByTestId('zhen-sha-stage').waitFor({ state: 'visible' });

      if (baseline) {
        await page.getByTestId('gesture-note').waitFor({ state: 'visible' });
      } else {
        await page.getByTestId('tutorial-hint').waitFor({ state: 'visible' });
      }

      // Let the canvas paint and the hint animation reach the same phase in
      // both captures; reduced-motion captures are static by design.
      await page.waitForTimeout(250);
      await page.getByTestId('zhen-sha-game').screenshot({
        path: `${prefix}-${state}-${width}x${height}.png`,
      });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
