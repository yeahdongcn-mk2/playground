import { chromium } from '@playwright/test';

const [baseUrl, state = 'after'] = process.argv.slice(2);

if (baseUrl === undefined) {
  console.error('usage: node evidence/plan-245-t0/verify-tutorial.mjs <url> <before|after>');
  process.exitCode = 2;
} else if (state !== 'before' && state !== 'after') {
  console.error(`unknown state: ${state}`);
  process.exitCode = 2;
} else {
  const browser = await chromium.launch();
  const checks = [];

  async function open(reducedMotion) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      reducedMotion,
    });
    await page.goto(`${baseUrl}/#/games/zhen-sha`, { waitUntil: 'networkidle' });
    await page.getByTestId('zhen-sha-stage').waitFor({ state: 'visible' });
    return page;
  }

  function check(name, condition) {
    checks.push({ name, pass: Boolean(condition) });
  }

  try {
    if (state === 'before') {
      const page = await open('no-preference');
      check('no tutorial hint exists', (await page.getByTestId('tutorial-hint').count()) === 0);
      check(
        'long gesture note is visible',
        await page.getByTestId('gesture-note').isVisible(),
      );
      await page.close();
    } else {
      const page = await open('no-preference');
      const hint = page.getByTestId('tutorial-hint');
      await hint.waitFor({ state: 'visible' });
      check('first-visit hint is visible', await hint.isVisible());
      check(
        'hint animates by default',
        (await hint.getAttribute('data-motion')) === 'animated' &&
          (await page
            .getByTestId('tutorial-hint')
            .locator('.zhen-sha-tutorial-ring')
            .evaluate((element) => getComputedStyle(element).animationName)) ===
            'zhen-sha-tutorial-pulse',
      );
      check(
        'hint does not intercept pointers',
        (await hint.evaluate((element) => getComputedStyle(element).pointerEvents)) === 'none',
      );
      const copy = (await page.getByTestId('tutorial-copy').textContent())?.trim() ?? '';
      check(
        'hint is at most six Han characters',
        (copy.match(/[\u4e00-\u9fff]/g) ?? []).length <= 6,
      );
      check(
        'long gesture note is hidden',
        !(await page.getByTestId('gesture-note').isVisible()),
      );
      check(
        'sidebar long note is hidden',
        !(await page.getByTestId('sidebar-note').isVisible()),
      );
      await page.close();

      const reduced = await open('reduce');
      const reducedHint = reduced.getByTestId('tutorial-hint');
      await reducedHint.waitFor({ state: 'visible' });
      check('reduced-motion hint is visible', await reducedHint.isVisible());
      check(
        'reduced-motion uses the static branch',
        (await reducedHint.getAttribute('data-motion')) === 'static',
      );
      check(
        'reduced-motion ring has no animation',
        (await reducedHint
          .locator('.zhen-sha-tutorial-ring')
          .evaluate((element) => getComputedStyle(element).animationName)) === 'none',
      );
      await reduced.close();
    }
  } finally {
    await browser.close();
  }

  for (const { name, pass } of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'} ${state}: ${name}`);
  }
  if (checks.some(({ pass }) => !pass) || checks.length === 0) {
    process.exitCode = 1;
  }
}
