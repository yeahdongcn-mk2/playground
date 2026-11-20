import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderHub } from '../../src/app/hub';
import type { PlayHistoryReader } from '../../src/app/play-history';
import type { GameModule } from '../../src/core/game';
import { games } from '../../src/games/registry';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const NO_HISTORY: PlayHistoryReader = { lastPlayed: () => null };
const APP_CSS = readFileSync(new URL('../../src/styles/app.css', import.meta.url), 'utf8');
const ZHEN_SHA_ART_HREF = '[href="#/games/zhen-sha"]';

/** Every shipped game with a dedicated inline SVG card art. */
const SHIPPED_ART = [
  { id: 'snake', svgClass: 'snake-card-art' },
  { id: 'tetris', svgClass: 'tetris-card-art' },
  { id: '2048', svgClass: 'game-2048-card-art' },
  { id: 'breakout', svgClass: 'breakout-card-art' },
  { id: 'minesweeper', svgClass: 'minesweeper-card-art' },
] as const;

function gameById(id: string): GameModule {
  const game = games.find((candidate) => candidate.meta.id === id);
  if (game === undefined) {
    throw new Error(`registry is missing ${id}`);
  }
  return game;
}

/** The art block of the first card in a one-game hub render. */
function firstCardArt(html: string): string {
  const start = html.indexOf('<div class="game-card-art');
  const end = html.indexOf('<div class="game-card-body">', start);
  if (start < 0 || end < 0) {
    throw new Error('rendered hub is missing a game card art block');
  }
  return html.slice(start, end);
}

/** One card of a full hub render, bounded by the next card's own test id. */
function cardBlock(html: string, id: string): string {
  const marker = `data-testid="game-card-${id}"`;
  const start = html.indexOf(marker);
  if (start < 0) {
    throw new Error(`rendered hub is missing the ${id} card`);
  }

  // The same card also contains data-testid="game-card-last-played-<id>",
  // which shares the data-testid="game-card-" prefix but is not the next
  // card. Skip those nested ids so the block really ends at the next card.
  let next = html.indexOf('data-testid="game-card-', start + marker.length);
  while (next >= 0 && html.startsWith('data-testid="game-card-last-played-', next)) {
    next = html.indexOf('data-testid="game-card-', next + 1);
  }
  return html.slice(start, next < 0 ? undefined : next);
}

/**
 * All CSS blocks that target the zhen-sha card through its existing href hook.
 * The rules live in app.css (not the entry bundle) so the hub keeps the default
 * markup; deleting or unscoping them must fail the assertions below.
 */
function zhenShaArtCss(): string {
  const blocks: string[] = [];
  for (const match of APP_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1] ?? '';
    if (!selector.includes(ZHEN_SHA_ART_HREF)) continue;
    blocks.push(`${selector.trim()} {${match[2] ?? ''}}`);
  }
  if (blocks.length === 0) {
    throw new Error('app.css is missing the zhen-sha card art rules');
  }
  return blocks.join('\n');
}

/** Decode the percent-encoded SVG data URI carried by the CSS pseudo-element. */
function zhenShaDataUriSvg(css: string): string {
  const match = /url\("data:image\/svg\+xml,([^"]+)"\)/.exec(css);
  if (match?.[1] === undefined) {
    throw new Error('zhen-sha CSS is missing its inline SVG data URI');
  }
  const svg = decodeURIComponent(match[1]);
  if (!svg.startsWith('<svg')) {
    throw new Error('zhen-sha data URI does not decode to an SVG document');
  }
  return svg;
}

describe('hub card art', () => {
  it('paints zhen-sha from app.css while the hub keeps the default card markup', () => {
    const html = renderHub([gameById('zhen-sha')], NO_HISTORY, NOW);
    expect(html).toContain(`href="#/games/zhen-sha"`);

    const art = firstCardArt(html);
    // No SVG or long art string in the entry bundle: the card keeps the same
    // default markup as blank and only CSS paints the dedicated art.
    expect(art).toContain('class="game-card-art"');
    expect(art).not.toContain('game-card-art--');
    expect(art).toContain('class="mini-orb"');
    expect(art).not.toContain('<svg');
    expect(art).not.toContain('zhen-sha-card-art');

    const css = zhenShaArtCss();
    const svg = zhenShaDataUriSvg(css);
    expect(svg).toContain("viewBox='0 0 220 132'");
    expect(svg).toContain('#f6c453');
    expect(svg).toContain('#08070a');
    // The ink ring and the gold staff are the two signature shapes.
    expect(svg).toMatch(/r='56'/);
    expect(svg).toMatch(/stroke-width='6'/);
    expect(svg).not.toMatch(/<image\b|xlink:href/);

    expect(css).toMatch(/\.game-card-art > \.mini-orb\s*\{\s*display:\s*none/);
    expect(css).toMatch(/width:\s*74%/);
    expect(css).toMatch(/aspect-ratio:\s*220\s*\/\s*132/);
    // The narrow-screen override must stay in app.css too.
    expect(css).toMatch(/width:\s*84%/);
  });

  it('keeps the other five cards on their existing dedicated art', () => {
    // Select by id rather than by slice position so a future reorder cannot
    // silently leave one of the five existing cards unpinned.
    for (const { id, svgClass } of SHIPPED_ART) {
      const html = renderHub([gameById(id)], NO_HISTORY, NOW);
      expect(html).toContain(`class="game-card-art game-card-art--${id}"`);

      const art = firstCardArt(html);
      expect(art).toContain(`<svg class="${svgClass}" viewBox="0 0 220 132" aria-hidden="true">`);
      expect(art.match(/<svg\b/g)).toHaveLength(1);
      expect(art).not.toContain('zhen-sha');
      expect(art).not.toContain('mini-orb');

      // Pin the complete art block, not just its opening tag: any SVG path,
      // color or attribute change in one of the five existing cards must fail
      // here instead of silently drifting from the shipped art. Strip trailing
      // markup whitespace so the repository's trailing-whitespace hook and the
      // expected snapshot cannot conflict; whitespace carries no SVG content.
      expect(art.replace(/[ \t]+$/gm, '')).toMatchSnapshot(`${id} card art`);
    }
  });

  it('keeps all six shipped cards distinct and only blank on the visible default orb', () => {
    const html = renderHub(games, NO_HISTORY, NOW);
    const renderedSvgClasses: string[] = [];

    for (const { id, svgClass } of SHIPPED_ART) {
      const block = cardBlock(html, id);
      expect(block).toContain(`class="game-card-art game-card-art--${id}"`);
      expect(block).toContain(`<svg class="${svgClass}"`);
      expect(block.match(/<svg\b/g)).toHaveLength(1);
      expect(block).not.toContain('mini-orb');

      const renderedSvgClass = /<svg class="([^"]+)"/.exec(block)?.[1];
      if (renderedSvgClass === undefined) {
        throw new Error(`${id} card is missing its svg class`);
      }
      expect(renderedSvgClass).toBe(svgClass);
      renderedSvgClasses.push(renderedSvgClass);
    }

    // Derive the list from each rendered card block, not from the test's own
    // constant, so the uniqueness check covers what the hub actually emits.
    expect(renderedSvgClasses).toEqual(SHIPPED_ART.map(({ svgClass }) => svgClass));
    expect(new Set(renderedSvgClasses).size).toBe(renderedSvgClasses.length);

    const zhenShaBlock = cardBlock(html, 'zhen-sha');
    expect(zhenShaBlock).toContain('class="game-card-art"');
    expect(zhenShaBlock).not.toContain('game-card-art--');
    expect(zhenShaBlock).not.toContain('<svg');
    expect(zhenShaBlock).toContain('mini-orb');

    const blankBlock = cardBlock(html, 'blank');
    expect(blankBlock).toContain('class="game-card-art"');
    expect(blankBlock).not.toContain('<svg');
    expect(blankBlock).toContain('mini-orb');

    // zhen-sha's default orb stays in the markup for CSS to hide; blank is the
    // only card that still shows it.
    expect(html.match(/mini-orb/g)).toHaveLength(2);
    expect(html).not.toContain('game-card-art--zhen-sha');
    expect(html).not.toContain('zhen-sha-card-art');
  });
});
