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

/** One card of a full hub render, bounded by the next card's test id. */
function cardBlock(html: string, id: string): string {
  const marker = `data-testid="game-card-${id}"`;
  const start = html.indexOf(marker);
  if (start < 0) {
    throw new Error(`rendered hub is missing the ${id} card`);
  }
  const next = html.indexOf('data-testid="game-card-', start + marker.length);
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
    }
  });

  it('keeps all six shipped cards on one unique art each and only blank on the default orb', () => {
    const html = renderHub(games, NO_HISTORY, NOW);
    const svgClasses: string[] = [];

    for (const { id, svgClass } of SHIPPED_ART) {
      const block = cardBlock(html, id);
      expect(block).toContain(`class="game-card-art game-card-art--${id}"`);
      expect(block).toContain(`<svg class="${svgClass}"`);
      expect(block.match(/<svg\b/g)).toHaveLength(1);
      expect(block).not.toContain('mini-orb');

      const renderedSvgClass = /<svg class="([^"]+)"/.exec(block)?.[1];
      expect(renderedSvgClass).toBe(svgClass);
      svgClasses.push(svgClass);
    }

    expect(new Set(svgClasses).size).toBe(SHIPPED_ART.length);
    expect(html.match(/game-card-art--zhen-sha/g)).toHaveLength(1);
    expect(html.match(/zhen-sha-card-art/g)).toHaveLength(1);
    // Blank canvas is the only registered game without dedicated card art.
    expect(html.match(/mini-orb/g)).toHaveLength(1);
  });
});
