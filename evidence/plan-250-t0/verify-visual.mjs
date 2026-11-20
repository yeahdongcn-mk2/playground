import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

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

/** Decode the SVG carried by the CSS pseudo-element data URI. */
function decodePseudoSvg(backgroundImage) {
  const match = /url\("data:image\/svg\+xml,([^"]+)"\)/.exec(backgroundImage);
  if (match?.[1] === undefined) return null;
  return decodeURIComponent(match[1]);
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
        const zhenShaArt = page.locator('a.game-card[href="#/games/zhen-sha"] .game-card-art');
        const style = await zhenShaArt.evaluate((element) => {
          const computed = getComputedStyle(element);
          const before = getComputedStyle(element, '::before');
          const orb = element.querySelector('.mini-orb');
          const artRect = element.getBoundingClientRect();
          return {
            backgroundImage: computed.backgroundImage,
            height: computed.height,
            hasClass: element.classList.contains('game-card-art--zhen-sha'),
            hasInlineSvg: element.querySelector('svg') !== null,
            orbDisplay: orb === null ? null : getComputedStyle(orb).display,
            pseudoBackgroundImage: before.backgroundImage,
            pseudoFilter: before.filter,
            pseudoWidth: Number.parseFloat(before.width),
            pseudoHeight: Number.parseFloat(before.height),
            artWidth: artRect.width,
          };
        });
        const svg = decodePseudoSvg(style.pseudoBackgroundImage);

        if (style.hasClass) {
          failures.push(`${width}px: zhen-sha art grew an inline modifier class`);
        }
        if (style.hasInlineSvg) {
          failures.push(`${width}px: zhen-sha art still renders inline SVG in the entry DOM`);
        }
        if (style.orbDisplay !== 'none') {
          failures.push(`${width}px: zhen-sha default orb is not hidden by CSS`);
        }
        if (!style.backgroundImage.includes('246, 196, 83')) {
          failures.push(`${width}px: zhen-sha background misses the gold accent`);
        }
        if (svg === null) {
          failures.push(`${width}px: zhen-sha CSS pseudo-element misses its inline SVG data URI`);
        } else {
          if (!svg.includes("viewBox='0 0 220 132'")) {
            failures.push(`${width}px: zhen-sha SVG viewBox changed`);
          }
          if (!svg.includes('#f6c453') || !svg.includes('#08070a')) {
            failures.push(`${width}px: zhen-sha SVG misses the gold or ink color`);
          }
          if (/<image\b|xlink:href/.test(svg)) {
            failures.push(`${width}px: zhen-sha SVG references external content`);
          }
        }
        if (!(style.pseudoWidth > 40 && style.pseudoHeight > 20)) {
          failures.push(`${width}px: zhen-sha pseudo-element art is too small`);
        }
        if (!style.pseudoFilter.includes('drop-shadow')) {
          failures.push(`${width}px: zhen-sha pseudo-element misses its drop shadow`);
        }
        if (width === 320 && Number.parseFloat(style.height) !== 156) {
          failures.push(`320px: narrow card art height is ${style.height}, expected 156px`);
        }
        if (width === 320) {
          // Mirror the e2e expectation: the narrow rule is 84% of the card
          // art, capped at 240px. Comparing against min(...) catches a lost
          // 84% override instead of accepting any width above 70%.
          const expectedWidth = Math.min(style.artWidth * 0.84, 240);
          if (Math.abs(style.pseudoWidth - expectedWidth) > 1) {
            failures.push(
              `320px: narrow pseudo art width is ${style.pseudoWidth}, expected ${expectedWidth}`,
            );
          }
        }

        console.log(
          `${width}px after zhen-sha: art=${style.height} bg-gold=${style.backgroundImage.includes('246, 196, 83')} pseudo=${style.pseudoWidth.toFixed(1)}x${style.pseudoHeight.toFixed(1)} data-uri=${svg !== null} orb=${style.orbDisplay}`,
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
