import { describe, expect, it } from 'vitest';
import { renderHub } from '../../src/app/hub';
import type { PlayHistoryReader } from '../../src/app/play-history';
import type { GameModule } from '../../src/core/game';
import { games } from '../../src/games/registry';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const NO_HISTORY: PlayHistoryReader = { lastPlayed: () => null };

/** Every shipped game and the dedicated art hook its card must keep. */
const SHIPPED_ART = [
  { id: 'snake', svgClass: 'snake-card-art' },
  { id: 'tetris', svgClass: 'tetris-card-art' },
  { id: '2048', svgClass: 'game-2048-card-art' },
  { id: 'breakout', svgClass: 'breakout-card-art' },
  { id: 'minesweeper', svgClass: 'minesweeper-card-art' },
  { id: 'zhen-sha', svgClass: 'zhen-sha-card-art' },
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

describe('hub card art', () => {
  it('gives zhen-sha a dedicated ink-and-gold inline SVG instead of the default orb', () => {
    const html = renderHub([gameById('zhen-sha')], NO_HISTORY, NOW);
    expect(html).toContain('class="game-card-art game-card-art--zhen-sha"');

    const art = firstCardArt(html);
    expect(art).toContain(
      '<svg class="zhen-sha-card-art" viewBox="0 0 220 132" aria-hidden="true">',
    );
    expect(art).toContain('url(#zhen-sha-card-ink)');
    expect(art).toContain('url(#zhen-sha-card-staff)');
    expect(art).toContain('#f6c453');
    expect(art).toContain('#08070a');
    expect(art).not.toContain('mini-orb');
    expect(art).not.toMatch(/<image\b|xlink:href|https?:\/\//);
  });

  it('keeps the other five cards on their existing dedicated art', () => {
    for (const { id, svgClass } of SHIPPED_ART.slice(0, 5)) {
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

  it('keeps all six shipped cards on one unique art each and only blank on the default orb', () => {
    const html = renderHub(games, NO_HISTORY, NOW);

    for (const { id, svgClass } of SHIPPED_ART) {
      const block = cardBlock(html, id);
      expect(block).toContain(`class="game-card-art game-card-art--${id}"`);
      expect(block).toContain(`<svg class="${svgClass}"`);
      expect(block.match(/<svg\b/g)).toHaveLength(1);
      expect(block).not.toContain('mini-orb');

      const renderedSvgClass = /<svg class="([^"]+)"/.exec(block)?.[1];
      expect(renderedSvgClass).toBe(svgClass);
    }

    // Extract the classes from the rendered HTML itself so this checks what
    // the hub actually emits rather than de-duplicating the test's own list.
    const renderedSvgClasses = [...html.matchAll(/<svg class="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(renderedSvgClasses).toEqual(SHIPPED_ART.map(({ svgClass }) => svgClass));
    expect(new Set(renderedSvgClasses).size).toBe(renderedSvgClasses.length);
    expect(html.match(/game-card-art--zhen-sha/g)).toHaveLength(1);
    expect(html.match(/zhen-sha-card-art/g)).toHaveLength(1);
    // Blank canvas is the only registered game without dedicated card art.
    expect(html.match(/mini-orb/g)).toHaveLength(1);
  });
});
