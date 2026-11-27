import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderHub } from '../../src/app/hub';
import type { PlayHistoryReader } from '../../src/app/play-history';
import { onlineRoomHref } from '../../src/app/router';
import { games } from '../../src/games/registry';

const NO_HISTORY: PlayHistoryReader = { lastPlayed: () => null };
const HUB_SOURCE = readFileSync(new URL('../../src/app/hub.ts', import.meta.url), 'utf8');
const ENTRY_MARKER = 'data-testid="enter-online-minesweeper"';

/** The complete `<section class="hero">` block of one hub render. */
function heroBlock(html: string): string {
  const start = html.indexOf('<section class="hero"');
  const end = html.indexOf('</section>', start);
  if (start < 0 || end < 0) {
    throw new Error('rendered hub is missing the hero section');
  }
  return html.slice(start, end + '</section>'.length);
}

/** The complete `<a>` block of the online entry. */
function entryBlock(html: string): string {
  const markerAt = html.indexOf(ENTRY_MARKER);
  if (markerAt < 0) {
    throw new Error('rendered hub is missing the online Minesweeper entry');
  }
  const start = html.lastIndexOf('<a ', markerAt);
  const end = html.indexOf('</a>', markerAt);
  if (start < 0 || end < 0) {
    throw new Error('rendered hub has a malformed online Minesweeper entry');
  }
  return html.slice(start, end + '</a>'.length);
}

/** The opening tag of the online entry. */
function entryTag(html: string): string {
  const block = entryBlock(html);
  return block.slice(0, block.indexOf('>') + 1);
}

describe('hub online Minesweeper entry', () => {
  it('adds one entry that points at the router online href', () => {
    const html = renderHub(games, NO_HISTORY);
    const tag = entryTag(html);
    const block = entryBlock(html);

    expect(html.match(new RegExp(ENTRY_MARKER, 'g')) ?? []).toHaveLength(1);
    expect(heroBlock(html)).toContain(block);
    expect(tag).toContain(`href="${onlineRoomHref()}"`);
    expect(block).toContain('联机扫雷');
    // The route helper owns the href, so a future room id format stays in sync.
    expect(onlineRoomHref()).toBe('#/online/minesweeper');
  });

  it('reuses an existing button class instead of adding hub styles', () => {
    const tag = entryTag(renderHub(games, NO_HISTORY));

    expect(tag).toContain('class="button button--ghost"');
    expect(tag).not.toContain('style=');
  });

  it('keeps the hero primary button exclusive to zhen-sha', () => {
    const hero = heroBlock(renderHub(games, NO_HISTORY));

    expect(hero.match(/button--primary/g) ?? []).toHaveLength(1);
    expect(hero).toMatch(
      /<a class="button button--primary" href="#\/games\/zhen-sha" data-testid="enter-zhen-sha">/,
    );
    expect(entryTag(hero)).not.toContain('button--primary');
  });

  it('keeps the online client out of the hub module', () => {
    // The hub may only import the href helper from the shell router; a static
    // room/view/socket import would pull the online chunk into the entry.
    expect(HUB_SOURCE).toMatch(
      /import\s*\{[^}]*\bonlineRoomHref\b[^}]*\}\s*from\s*'\.\/router'/,
    );
    expect(HUB_SOURCE).not.toMatch(
      /(?:from|import\s*\()\s*['"][^'"]*games\/minesweeper\/online/,
    );
    expect(HUB_SOURCE).not.toMatch(/mountOnlineRoom|WebSocket|room_state|onlineSeatStorageKey/);
  });
});

/**
 * The shell may reach the online client only through the lazy seam module.
 * The hub-only checks above would miss a static import added to `app.ts` or
 * `online-route.ts`, which would silently pull the room chunk into the entry
 * bundle (only the entry-size budget would notice, without saying why).
 */
describe('shell online client seam', () => {
  const CLIENT_PATH = 'games/minesweeper/online';
  const SHELL_SOURCES = readdirSync(new URL('../../src/app/', import.meta.url))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({
      name,
      source: readFileSync(new URL(`../../src/app/${name}`, import.meta.url), 'utf8'),
    }));

  it('names the online client only in the dynamic import of online-route.ts', () => {
    const referencing = SHELL_SOURCES.filter(({ source }) => source.includes(CLIENT_PATH));

    expect(referencing.map(({ name }) => name)).toEqual(['online-route.ts']);
    const seam = referencing[0]?.source ?? '';
    expect(seam).toMatch(
      /import\('\.\.\/games\/minesweeper\/online\/client\/online-room'\)/,
    );
    // Same module, but a static form: it must never appear in the seam either.
    expect(seam).not.toMatch(
      /(?:^|\n)\s*(?:import|export)\s[^;\n]*['"][^'"]*games\/minesweeper\/online/,
    );
  });

  it('keeps every other shell module free of online client references', () => {
    for (const { name, source } of SHELL_SOURCES) {
      if (name === 'online-route.ts') continue;
      expect(source, `${name} must not reference the online client module`).not.toMatch(
        /games\/minesweeper\/online/,
      );
      expect(source, `${name} must not mount the room view directly`).not.toMatch(
        /mountOnlineRoom|onlineSeatStorageKey/,
      );
    }
  });
});
