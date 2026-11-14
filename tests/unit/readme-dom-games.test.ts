import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { games } from '../../src/games/registry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

/** Games shipped in the registry; blank only demonstrates the framework. */
const shippedGames = games.filter((game) => game.meta.id !== 'blank');
const domGames = shippedGames.filter((game) => game.meta.engine === 'dom');
const phaserGames = shippedGames.filter((game) => game.meta.engine === 'phaser');
const domTitles = domGames.map((game) => game.meta.title);

/** The one README technology-stack row that lists the DOM games. */
function domGamesRow(source: string): string {
  const matches = source
    .split('\n')
    .filter((line) => line.startsWith('| DOM 游戏 |'));
  expect(
    matches,
    'README.md should have exactly one technology-stack "DOM 游戏" row',
  ).toHaveLength(1);
  const [line] = matches;
  if (line === undefined) {
    throw new Error('README.md is missing the technology-stack DOM games row');
  }
  return line;
}

/** Assert the row names exactly the registry's DOM games and keeps the no-engine copy. */
function assertDomRow(row: string): void {
  expect(row).toContain('原生 DOM + CSS');
  expect(row).toContain('不加载引擎');
  expect(domTitles.length).toBeGreaterThan(0);
  expect(row, `DOM games row should list ${domTitles.join('与')}`).toContain(
    domTitles.join('与'),
  );
  for (const title of domTitles) {
    expect(row, `DOM games row should list ${title}`).toContain(title);
  }
  for (const game of phaserGames) {
    expect(
      row,
      `DOM games row must not list the Phaser game ${game.meta.title}`,
    ).not.toContain(game.meta.title);
  }
}

describe('README technology-stack DOM games row', () => {
  it('derives the DOM games from the registry instead of hard-coding them', () => {
    expect(shippedGames).toHaveLength(6);
    expect(domGames.map((game) => game.meta.id)).toEqual(['minesweeper', 'zhen-sha']);
    expect(domTitles).toEqual(['扫雷', '镇煞']);
    expect(phaserGames).toHaveLength(4);
    expect(domGames.length + phaserGames.length).toBe(shippedGames.length);
  });

  it('lists both DOM games from the registry and keeps the no-engine wording', () => {
    assertDomRow(domGamesRow(README));
  });

  it('fails when the row falls back to naming only minesweeper', () => {
    const row = domGamesRow(README);
    const reverted = row.replace(domTitles.join('与'), domTitles[0] ?? '');
    expect(reverted).not.toBe(row);

    expect(() => assertDomRow(reverted)).toThrow();
  });
});
