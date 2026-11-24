import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderHub } from '../../src/app/hub';
import type { PlayHistoryReader } from '../../src/app/play-history';
import type { GameModule } from '../../src/core/game';
import { games } from '../../src/games/registry';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const NO_HISTORY: PlayHistoryReader = { lastPlayed: () => null };
const APP_CSS = readFileSync(new URL('../../src/styles/app.css', import.meta.url), 'utf8');
const HUB_SOURCE = readFileSync(new URL('../../src/app/hub.ts', import.meta.url), 'utf8');

/** Games whose dedicated inline SVG art stays on the lobby grid. */
const GRID_ART = [
  { id: 'snake', svgClass: 'snake-card-art' },
  { id: 'tetris', svgClass: 'tetris-card-art' },
  { id: '2048', svgClass: 'game-2048-card-art' },
  { id: 'breakout', svgClass: 'breakout-card-art' },
  { id: 'minesweeper', svgClass: 'minesweeper-card-art' },
] as const;

/** Every shipped game with a dedicated inline SVG card art. */
const SHIPPED_ART = [
  ...GRID_ART,
  { id: 'zhen-sha', svgClass: 'zhen-sha-card-art' },
] as const;

/** Games that stay reachable from the lobby grid after zhen-sha moved to the hero. */
const GRID_IDS = ['snake', 'tetris', '2048', 'breakout', 'minesweeper', 'blank'] as const;

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

/** The complete feature card anchor, from its opening tag to the first </a>. */
function featureCard(html: string): string {
  const marker = 'data-testid="game-card-zhen-sha"';
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) {
    throw new Error('rendered hub is missing the zhen-sha feature card');
  }
  const start = html.lastIndexOf('<a ', markerAt);
  const end = html.indexOf('</a>', markerAt);
  if (start < 0 || end < 0) {
    throw new Error('rendered hub has a malformed zhen-sha feature card');
  }
  return html.slice(start, end + '</a>'.length);
}

/** The <section class="hero"> block of the hub. */
function heroBlock(html: string): string {
  const start = html.indexOf('<section class="hero"');
  const end = html.indexOf('</section>', start);
  if (start < 0 || end < 0) {
    throw new Error('rendered hub is missing the hero section');
  }
  return html.slice(start, end + '</section>'.length);
}

/** The <div class="game-grid"> block of the hub. */
function gridBlock(html: string): string {
  const start = html.indexOf('<div class="game-grid">');
  const end = html.indexOf('</section>', start);
  if (start < 0 || end < 0) {
    throw new Error('rendered hub is missing the game grid');
  }
  return html.slice(start, end);
}

describe('hub card art', () => {
  it('promotes zhen-sha into the hero as an inline-SVG feature card', () => {
    const html = renderHub(games, NO_HISTORY, NOW);
    const hero = heroBlock(html);
    const card = featureCard(html);

    // The feature card is a real interactive link: it is not hidden behind the
    // decorative wrapper the orb used to live in.
    expect(card).toContain('class="game-card game-card--feature"');
    expect(card).toContain('href="#/games/zhen-sha"');
    expect(card).toContain('data-testid="game-card-zhen-sha"');
    expect(hero).toContain(card);
    // The interactive wrapper is not hidden; only the decorative art inside it.
    expect(html).toMatch(
      /<div class="hero-visual">\s*<a class="game-card game-card--feature"/,
    );
    expect(card.slice(0, card.indexOf('>'))).not.toContain('aria-hidden');

    // The card face is inline SVG from hub.ts, not a CSS data URI or <image>.
    expect(card).toContain('class="game-card-art game-card-art--zhen-sha"');
    expect(card).toContain(
      '<svg class="zhen-sha-card-art" viewBox="0 0 220 132" aria-hidden="true">',
    );
    expect(card.match(/<svg\b/g)).toHaveLength(1);
    expect(card).not.toMatch(/<image\b|xlink:href/);
    expect(card).not.toContain('data:image/svg+xml');
    expect(card).toContain('#f6c453');
    expect(card).toContain('#08070a');
    // The ink ring and the gold staff are the two signature shapes.
    expect(card).toMatch(/r="56"/);
    expect(card).toMatch(/stroke-width="6"/);

    // The decorative art is hidden, the card body is not: the link's text and
    // CTA stay in the accessibility tree.
    const artStart = card.indexOf('<div class="game-card-art');
    const artEnd = card.indexOf('<div class="game-card-body">', artStart);
    expect(card.slice(artStart, artEnd)).toContain('aria-hidden="true"');
  });

  it('pins the complete zhen-sha inline art', () => {
    const card = featureCard(renderHub(games, NO_HISTORY, NOW));
    const svgStart = card.indexOf('<svg');
    const svgEnd = card.indexOf('</svg>') + '</svg>'.length;
    expect(card.slice(svgStart, svgEnd).replace(/[ \t]+$/gm, '')).toMatchSnapshot(
      'zhen-sha feature card art',
    );
  });

  it('keeps the hero CTA as the only primary button and the blank entry as secondary', () => {
    const hero = heroBlock(renderHub(games, NO_HISTORY, NOW));

    expect(hero).toContain('data-testid="enter-zhen-sha"');
    expect(hero).toContain('href="#/games/zhen-sha"');
    expect(hero.match(/button--primary/g) ?? []).toHaveLength(1);
    expect(hero).toMatch(
      /<a class="button button--primary" href="#\/games\/zhen-sha" data-testid="enter-zhen-sha">/,
    );
    expect(hero).toContain('data-testid="enter-blank"');
    expect(hero).toContain('href="#/games/blank"');
    expect(hero).toContain('看看框架能力');
  });

  it('keeps five games plus blank in the grid and removes the duplicate zhen-sha entry', () => {
    const html = renderHub(games, NO_HISTORY, NOW);
    const grid = gridBlock(html);

    expect(html.match(/data-testid="game-card-zhen-sha"/g) ?? []).toHaveLength(1);
    expect(html).not.toContain('enter-snake');
    expect(grid).not.toContain('zhen-sha');
    for (const id of GRID_IDS) {
      expect(grid).toContain(`data-testid="game-card-${id}"`);
    }
    // The placeholder is still reachable after the remaining six entries.
    expect(grid).toContain('game-card--placeholder');
  });

  it('does not add external links or image references to the hub entry', () => {
    // The single pre-existing link is the GitHub repository constant; the new
    // card art must not add a second URL or an <image>/xlink reference.
    expect(HUB_SOURCE.match(/https?:\/\//g) ?? []).toHaveLength(1);
    expect(featureCard(renderHub(games, NO_HISTORY, NOW))).not.toMatch(
      /https?:\/\/|<image\b|xlink:href/,
    );
  });

  it('draws the feature card from app.css without the retired href selector', () => {
    // The zhen-sha rules target the modifier class now; the old href hook was
    // replaced, not duplicated.
    expect(APP_CSS).not.toContain('[href="#/games/zhen-sha"]');
    expect(APP_CSS).toMatch(/\.game-card-art--zhen-sha\s*\{/);
    expect(APP_CSS).toMatch(/\.zhen-sha-card-art\s*\{[^}]*width:\s*74%/);
    expect(APP_CSS).toMatch(/\.zhen-sha-card-art\s*\{[^}]*max-width:\s*240px/);
    expect(APP_CSS).toMatch(/\.zhen-sha-card-art\s*\{[^}]*drop-shadow/);
    expect(APP_CSS).toMatch(
      /\.game-card-art--zhen-sha \.game-card-engine\s*\{[^}]*color:\s*#f6c453/,
    );
    // The narrow override must stay in app.css too.
    expect(APP_CSS).toMatch(/\.zhen-sha-card-art\s*\{\s*width:\s*84%/);
    // The hero feature card gets an explicit width ceiling for both viewports.
    expect(APP_CSS).toMatch(/\.game-card--feature\s*\{[^}]*width:\s*min\(100%, 520px\)/);
    // The orb rules that used to carry the hero visual are gone.
    expect(APP_CSS).not.toContain('.orb-core');
    expect(APP_CSS).not.toContain('.orb-stage');
  });

  it('keeps the other five cards on their existing dedicated art', () => {
    // Select by id rather than by slice position so a future reorder cannot
    // silently leave one of the five existing cards unpinned.
    for (const { id, svgClass } of GRID_ART) {
      const html = renderHub([gameById(id)], NO_HISTORY, NOW);
      expect(html).toContain(`class="game-card-art game-card-art--${id}"`);

      const art = firstCardArt(html);
      expect(art).toContain(`<svg class="${svgClass}" viewBox="0 0 220 132" aria-hidden="true">`);
      expect(art.match(/<svg\b/g)).toHaveLength(1);
      expect(art).not.toContain('mini-orb');

      // Pin the complete art block, not just its opening tag: any SVG path,
      // color or attribute change in one of the cards must fail here instead
      // of silently drifting from the shipped art. Strip trailing markup
      // whitespace so the repository's trailing-whitespace hook and the
      // expected snapshot cannot conflict; whitespace carries no SVG content.
      expect(art.replace(/[ \t]+$/gm, '')).toMatchSnapshot(`${id} card art`);
    }
  });

  it('keeps all six shipped cards distinct and only blank on the visible default orb', () => {
    const html = renderHub(games, NO_HISTORY, NOW);
    const renderedSvgClasses: string[] = [];

    for (const { id, svgClass } of SHIPPED_ART) {
      expect(html.match(new RegExp(`data-testid="game-card-${id}"`, 'g')) ?? []).toHaveLength(1);
      const block = id === 'zhen-sha' ? featureCard(html) : cardBlock(html, id);
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

    const zhenSha = featureCard(html);
    expect(zhenSha).toContain('class="game-card-art game-card-art--zhen-sha"');
    expect(zhenSha).toContain('zhen-sha-card-art');

    const blankBlock = cardBlock(html, 'blank');
    expect(blankBlock).toContain('class="game-card-art"');
    expect(blankBlock).not.toContain('<svg');
    expect(blankBlock).toContain('mini-orb');

    // Only blank still shows the generic orb.
    expect(html.match(/mini-orb/g)).toHaveLength(1);
  });
});
