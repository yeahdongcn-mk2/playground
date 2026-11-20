import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const ZHEN_SHA_ART = '[data-testid="game-card-zhen-sha"] .game-card-art';

interface ZhenShaArtStyle {
  readonly hasModifier: boolean;
  readonly hasDefaultOrb: boolean;
  readonly backgroundImage: string;
  readonly artWidth: number;
  readonly artHeight: number;
  readonly svgWidth: number;
  readonly svgHeight: number;
  readonly svgFilter: string;
  readonly svgAriaHidden: string | null;
  readonly svgViewBox: string | null;
  readonly engineColor: string | null;
}

async function readZhenShaArt(page: Page): Promise<ZhenShaArtStyle> {
  return page.locator(ZHEN_SHA_ART).evaluate((element) => {
    const svg = element.querySelector('svg.zhen-sha-card-art');
    if (!(svg instanceof SVGElement)) {
      throw new Error('zhen-sha card art is missing its dedicated SVG');
    }
    const engine = element.querySelector('.game-card-engine');
    const artRect = element.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const artStyle = getComputedStyle(element);

    return {
      hasModifier: element.classList.contains('game-card-art--zhen-sha'),
      hasDefaultOrb: element.querySelector('.mini-orb') !== null,
      backgroundImage: artStyle.backgroundImage,
      artWidth: artRect.width,
      artHeight: Number.parseFloat(artStyle.height),
      svgWidth: svgRect.width,
      svgHeight: svgRect.height,
      svgFilter: getComputedStyle(svg).filter,
      svgAriaHidden: svg.getAttribute('aria-hidden'),
      svgViewBox: svg.getAttribute('viewBox'),
      engineColor: engine === null ? null : getComputedStyle(engine).color,
    };
  });
}

function expectSvgWidth(art: ZhenShaArtStyle, ratio: number): void {
  // The committed CSS sets a percentage width with a 240px ceiling; deleting
  // either rule changes the rendered size and fails here.
  const expectedWidth = Math.min(art.artWidth * ratio, 240);
  expect(Math.abs(art.svgWidth - expectedWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(art.svgHeight - (art.svgWidth * 132) / 220)).toBeLessThanOrEqual(1);
}

function expectInkAndGold(art: ZhenShaArtStyle): void {
  expect(art.hasModifier).toBe(true);
  expect(art.hasDefaultOrb).toBe(false);
  expect(art.backgroundImage).toMatch(/246,\s*196,\s*83/);
  expect(art.backgroundImage).toMatch(/8,\s*7,\s*10/);
  expect(art.svgFilter).toContain('drop-shadow');
  expect(art.svgFilter).toMatch(/246,\s*196,\s*83/);
  expect(art.svgAriaHidden).toBe('true');
  expect(art.svgViewBox).toBe('0 0 220 132');
  expect(art.engineColor).toBe('rgb(246, 196, 83)');
}

test.describe('zhen-sha hub card art at 1440x1000', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('keeps the dedicated ink-and-gold art inside the shared 184px card box', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('game-card-zhen-sha')).toBeVisible();

    const art = await readZhenShaArt(page);
    expectInkAndGold(art);
    expect(art.artHeight).toBe(184);
    expectSvgWidth(art, 0.74);
  });
});

test.describe('zhen-sha hub card art at 320x640', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('keeps the narrow 156px card box and the wider 84% SVG', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('game-card-zhen-sha')).toBeVisible();

    const art = await readZhenShaArt(page);
    expectInkAndGold(art);
    expect(art.artHeight).toBe(156);
    expectSvgWidth(art, 0.84);
  });
});
