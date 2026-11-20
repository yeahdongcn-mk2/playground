import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const beforeUrl = process.argv[2];
const afterUrl = process.argv[3];
const ids = ['snake', 'tetris', '2048', 'breakout', 'minesweeper', 'zhen-sha'];
const otherIds = ids.filter((id) => id !== 'zhen-sha');
const failures = [];

function sha(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sameBox(left, right) {
  if (left === null || right === null) return false;
  return ['x', 'y', 'width', 'height'].every((key) => Math.abs(left[key] - right[key]) < 0.01);
}

const browser = await chromium.launch();
try {
  for (const [width, height] of [
    [1440, 1000],
    [320, 640],
  ]) {
    const captured = {};
    for (const [label, url] of [
      ['before', beforeUrl],
      ['after', afterUrl],
    ]) {
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.getByTestId('game-card-zhen-sha').waitFor({ state: 'visible' });
      await page.evaluate(() => {
        const games = document.querySelector('#games');
        if (games === null) throw new Error('missing #games');
        window.scrollTo(0, games.getBoundingClientRect().top + window.scrollY - 16);
      });
      await page.waitForTimeout(150);

      captured[label] = {};
      for (const id of ids) {
        const art = page.locator(`[data-testid="game-card-${id}"] .game-card-art`);
        captured[label][id] = {
          box: await art.boundingBox(),
          sha: sha(await art.screenshot()),
        };
      }

      if (label === 'after') {
        const zhenShaArt = page.locator('[data-testid="game-card-zhen-sha"] .game-card-art');
        const svg = zhenShaArt.locator('svg.zhen-sha-card-art');
        const style = await zhenShaArt.evaluate((element) => {
          const computed = getComputedStyle(element);
          return {
            backgroundImage: computed.backgroundImage,
            height: computed.height,
            hasClass: element.classList.contains('game-card-art--zhen-sha'),
            hasOrb: element.querySelector('.mini-orb') !== null,
          };
        });
        const svgInfo = await svg.evaluate((element) => ({
          ariaHidden: element.getAttribute('aria-hidden'),
          viewBox: element.getAttribute('viewBox'),
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
          parentWidth: (element.parentElement?.getBoundingClientRect().width ?? 0),
          externalRefs: /<image\b|xlink:href|https?:\/\//.test(element.outerHTML),
        }));

        if (!style.hasClass) failures.push(`${width}px: zhen-sha art lacks its modifier class`);
        if (style.hasOrb) failures.push(`${width}px: zhen-sha still renders the default orb`);
        if (!style.backgroundImage.includes('246, 196, 83')) {
          failures.push(`${width}px: zhen-sha background misses the gold accent`);
        }
        if (svgInfo.ariaHidden !== 'true') failures.push(`${width}px: zhen-sha SVG is not aria-hidden`);
        if (svgInfo.viewBox !== '0 0 220 132') failures.push(`${width}px: zhen-sha SVG viewBox changed`);
        if (!(svgInfo.width > 40 && svgInfo.height > 20)) failures.push(`${width}px: zhen-sha SVG is too small`);
        if (svgInfo.externalRefs) failures.push(`${width}px: zhen-sha SVG references external content`);
        if (width === 320 && Number.parseFloat(style.height) !== 156) {
          failures.push(`320px: narrow card art height is ${style.height}, expected 156px`);
        }
        if (width === 320 && svgInfo.width / svgInfo.parentWidth < 0.7) {
          failures.push(`320px: narrow zhen-sha SVG ratio is ${svgInfo.width / svgInfo.parentWidth}`);
        }

        console.log(
          `${width}px after zhen-sha: art=${style.height} bg-gold=${style.backgroundImage.includes('246, 196, 83')} svg=${svgInfo.width.toFixed(1)}x${svgInfo.height.toFixed(1)} aria-hidden=${svgInfo.ariaHidden}`,
        );
      }
      await page.close();
    }

    for (const id of otherIds) {
      if (captured.before[id].sha !== captured.after[id].sha) {
        failures.push(`${width}px: ${id} card art pixels changed`);
      }
      if (!sameBox(captured.before[id].box, captured.after[id].box)) {
        failures.push(`${width}px: ${id} card art layout moved`);
      }
    }
    if (captured.before['zhen-sha'].sha === captured.after['zhen-sha'].sha) {
      failures.push(`${width}px: zhen-sha card art did not change`);
    }
    if (!sameBox(captured.before['zhen-sha'].box, captured.after['zhen-sha'].box)) {
      failures.push(`${width}px: zhen-sha card art layout moved`);
    }
    console.log(`${width}px: 5 other card arts unchanged; zhen-sha art changed with a stable box`);
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error('FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('OK: only the zhen-sha card art changed; layout and the other five cards are stable.');
}
