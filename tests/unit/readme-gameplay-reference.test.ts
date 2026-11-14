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

const CHINESE_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

/** The one README line that enumerates the complete gameplay references. */
function gameplayReference(source: string): string {
  const matches = source.split('\n').filter((line) => line.includes('完整玩法参考'));
  expect(
    matches,
    'README.md should have exactly one line naming the complete gameplay references',
  ).toHaveLength(1);
  const [line] = matches;
  if (line === undefined) {
    throw new Error('README.md is missing the complete gameplay reference line');
  }
  return line;
}

describe('README gameplay reference', () => {
  it('derives six complete games with two DOM and four Phaser engines from the registry', () => {
    expect(shippedGames).toHaveLength(6);
    expect(shippedGames.map((game) => game.meta.id)).toContain('zhen-sha');
    expect(shippedGames.map((game) => game.meta.title)).toContain('镇煞');
    expect(domGames.map((game) => game.meta.id)).toEqual(['minesweeper', 'zhen-sha']);
    expect(phaserGames).toHaveLength(4);
    expect(domGames.length + phaserGames.length).toBe(shippedGames.length);
  });

  it('lists every complete game directory and names 镇煞 in the gameplay reference', () => {
    const reference = gameplayReference(README);
    for (const game of shippedGames) {
      expect(
        reference,
        `README gameplay reference should list src/games/${game.meta.id}/`,
      ).toContain(`src/games/${game.meta.id}/`);
    }
    expect(reference).toContain('src/games/zhen-sha/');
    expect(reference).toContain('镇煞');
  });

  it('documents the DOM / Phaser split exactly as the registry derives it', () => {
    const reference = gameplayReference(README);
    const domTitles = domGames.map((game) => game.meta.title).join('与');
    expect(reference).toContain(`${domTitles}是 ${domGames.length} 款纯 DOM 参考`);

    const phaserCountLabel = CHINESE_DIGITS[phaserGames.length] ?? '?';
    expect(reference).toContain(`其余${phaserCountLabel}款使用 Phaser 场景`);
  });

  it('describes zhen-sha with the tests it ships, not a debug seam it lacks', () => {
    const reference = gameplayReference(README);
    const zhenShaIndex = reference.indexOf('src/games/zhen-sha/');
    expect(zhenShaIndex).toBeGreaterThanOrEqual(0);
    // 镇煞 has engine.test.ts / zhen-sha-view.test.ts but no `?debug=1` seam, so
    // its fragment must not borrow the debug-seam wording used by the Phaser games.
    const zhenShaFragment = reference.slice(zhenShaIndex);
    expect(zhenShaFragment).toContain('与测试');
    expect(zhenShaFragment).not.toContain('调试接缝');
  });
});
