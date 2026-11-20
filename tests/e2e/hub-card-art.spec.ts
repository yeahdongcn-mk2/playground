import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const ZHEN_SHA_CARD = 'a.game-card[href="#/games/zhen-sha"]';
const ZHEN_SHA_ART = `${ZHEN_SHA_CARD} .game-card-art`;

interface ZhenShaArtStyle {
  readonly hasModifier: boolean;
  readonly inlineSvgCount: number;
  readonly orbDisplay: string | null;
  readonly backgroundImage: string;
  readonly artWidth: number;
  readonly artHeight: number;
  readonly pseudoWidth: number;
  readonly pseudoHeight: number;
  readonly pseudoBackgroundImage: string;
  readonly pseudoFilter: string;
  readonly engineColor: string | null;
  readonly engineBorderColor: string | null;
}

async function readZhenShaArt(page: Page): Promise<ZhenShaArtStyle> {
  return page.locator(ZHEN_SHA_ART).evaluate((element) => {
    const before = getComputedStyle(element, '::before');
    const orb = element.querySelector('.mini-orb');
    const engine = element.querySelector('.game-card-engine');
    const engineStyle = engine === null ? null : getComputedStyle(engine);
    const artRect = element.getBoundingClientRect();
    const artStyle = getComputedStyle(element);

    return {
      hasModifier: element.classList.contains('game-card-art--zhen-sha'),
      inlineSvgCount: element.querySelectorAll('svg').length,
      orbDisplay: orb instanceof HTMLElement ? getComputedStyle(orb).display : null,
      backgroundImage: artStyle.backgroundImage,
      artWidth: artRect.width,
      artHeight: Number.parseFloat(artStyle.height),
      pseudoWidth: Number.parseFloat(before.width),
      pseudoHeight: Number.parseFloat(before.height),
      pseudoBackgroundImage: before.backgroundImage,
      pseudoFilter: before.filter,
      engineColor: engineStyle?.color ?? null,
      engineBorderColor: engineStyle?.borderTopColor ?? null,
    };
  });
}

/** The decoded SVG carried by the CSS pseudo-element's data URI. */
function decodePseudoSvg(backgroundImage: string): string {
  const match = /url\("data:image\/svg\+xml,([^"]+)"\)/.exec(backgroundImage);
  if (match?.[1] === undefined) {
    throw new Error(`zhen-sha CSS is missing its inline SVG data URI: ${backgroundImage}`);
  }
  return decodeURIComponent(match[1]);
}

function expectPseudoArtWidth(art: ZhenShaArtStyle, ratio: number): void {
  // The committed CSS sets a percentage width with a 240px ceiling. The
  // viewports below are chosen so deleting the base 74% rule, the narrow 84%
  // override or the ceiling each changes this rendered size and fails here.
  const expectedWidth = Math.min(art.artWidth * ratio, 240);
  expect(Math.abs(art.pseudoWidth - expectedWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(art.pseudoHeight - (art.pseudoWidth * 132) / 220)).toBeLessThanOrEqual(1);
}

function expectInkAndGold(art: ZhenShaArtStyle): void {
  // The entry JS must stay free of the art: the hub renders the default card
  // markup and CSS paints the dedicated pseudo-element instead.
  expect(art.hasModifier).toBe(false);
  expect(art.inlineSvgCount).toBe(0);
  expect(art.orbDisplay).toBe('none');
  expect(art.backgroundImage).toMatch(/246,\s*196,\s*83/);
  expect(art.backgroundImage).toMatch(/8,\s*7,\s*10/);

  const svg = decodePseudoSvg(art.pseudoBackgroundImage);
  expect(svg).toContain("viewBox='0 0 220 132'");
  expect(svg).toContain('#f6c453');
  expect(svg).toContain('#08070a');
  expect(svg).not.toMatch(/<image\b|xlink:href/);

  expect(art.pseudoFilter).toContain('drop-shadow');
  expect(art.pseudoFilter).toMatch(/246,\s*196,\s*83/);
  expect(art.engineColor).toBe('rgb(246, 196, 83)');
  expect(art.engineBorderColor).toBe('rgba(246, 196, 83, 0.34)');
}

test.describe('zhen-sha hub card art at 1440x1000', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('paints the dedicated ink-and-gold art inside the shared 184px card box', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('game-card-zhen-sha')).toBeVisible();

    const art = await readZhenShaArt(page);
    expectInkAndGold(art);
    expect(art.artHeight).toBe(184);
    expectPseudoArtWidth(art, 0.74);
  });
});

test.describe('zhen-sha hub card art at 1024x800', () => {
  test.use({ viewport: { width: 1024, height: 800 } });

  test('uses the base 74% width where the 240px ceiling does not dominate', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('game-card-zhen-sha')).toBeVisible();

    const art = await readZhenShaArt(page);
    expectInkAndGold(art);
    expect(art.artHeight).toBe(184);
    // This viewport only proves the 74% rule when the percentage is the
    // smaller term; fail loudly instead of silently capping if the grid
    // layout grows the card art past that point.
    expect(art.artWidth * 0.74).toBeLessThan(240);
    expectPseudoArtWidth(art, 0.74);
  });
});

test.describe('zhen-sha hub card art at 320x640', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('keeps the narrow 156px card box with the 84% width override', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('game-card-zhen-sha')).toBeVisible();

    const art = await readZhenShaArt(page);
    expectInkAndGold(art);
    expect(art.artHeight).toBe(156);
    expectPseudoArtWidth(art, 0.84);
  });
});
