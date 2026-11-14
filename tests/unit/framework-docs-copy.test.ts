import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { games } from '../../src/games/registry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FRAMEWORK = readFileSync(join(ROOT, 'docs', 'framework.md'), 'utf8');

/** Complete games shipped in the registry; blank only demonstrates the shell. */
const shippedGames = games.filter((game) => game.meta.id !== 'blank');
const domGames = shippedGames.filter((game) => game.meta.engine === 'dom');
const phaserGames = shippedGames.filter((game) => game.meta.engine === 'phaser');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The first `text` fence in section 3, which holds the directory tree. */
function directoryTree(source: string): string {
  const sectionStart = source.indexOf('## 3. ');
  const sectionEnd = source.indexOf('\n## 4. ', sectionStart);
  if (sectionStart < 0 || sectionEnd < 0) {
    throw new Error('docs/framework.md is missing section 3 (目录与依赖方向)');
  }
  const match = /```text\n([\s\S]*?)```/.exec(source.slice(sectionStart, sectionEnd));
  if (match?.[1] === undefined) {
    throw new Error('docs/framework.md section 3 is missing the directory tree fence');
  }
  return match[1];
}

/** The only line in the document that contains `marker`. */
function uniqueLine(source: string, marker: string): string {
  const matches = source.split('\n').filter((candidate) => candidate.includes(marker));
  expect(
    matches,
    `docs/framework.md should have exactly one line containing ${marker}`,
  ).toHaveLength(1);
  const [line] = matches;
  if (line === undefined) {
    throw new Error(`docs/framework.md is missing the line containing ${marker}`);
  }
  return line;
}

/** The one line that enumerates the complete playable references (section 14). */
function gameplayReference(source: string): string {
  return uniqueLine(source, '是完整玩法参考');
}

/** The one line that enumerates the complete split examples (section 10). */
function splitExample(source: string): string {
  return uniqueLine(source, '完整的拆分示例');
}

/** The tree line that documents one game directory. */
function treeEntry(tree: string, id: string): string {
  const pattern = new RegExp(`^\\s+${escapeRegExp(id)}/\\s`);
  const line = tree.split('\n').find((candidate) => pattern.test(candidate));
  if (line === undefined) {
    throw new Error(`docs/framework.md directory tree is missing the ${id}/ entry`);
  }
  return line;
}

describe('framework docs game copy', () => {
  it('derives six complete games with two DOM and four Phaser engines from the registry', () => {
    expect(shippedGames).toHaveLength(6);
    expect(shippedGames.map((game) => game.meta.id)).toContain('zhen-sha');
    expect(shippedGames.map((game) => game.meta.title)).toContain('镇煞');
    expect(domGames.map((game) => game.meta.id)).toEqual(['minesweeper', 'zhen-sha']);
    expect(phaserGames).toHaveLength(4);
  });

  it('lists every complete game in the directory tree and marks both DOM entries', () => {
    const tree = directoryTree(FRAMEWORK);
    for (const game of shippedGames) {
      const entry = treeEntry(tree, game.meta.id);
      if (game.meta.engine === 'dom') {
        expect(entry, `${game.meta.id}/ should be documented as a DOM game`).toContain('DOM');
        expect(entry, `${game.meta.id}/ should be documented as engine-free`).toContain(
          '不加载引擎',
        );
      }
    }

    const zhenShaEntry = treeEntry(tree, 'zhen-sha');
    expect(zhenShaEntry, 'zhen-sha/ should be documented as 镇煞').toContain('镇煞');
    expect(zhenShaEntry, 'zhen-sha/ should be documented as the sixth complete game').toContain(
      '第六个完整玩法',
    );
  });

  it('lists every complete game in the section 10 split example and the gameplay reference', () => {
    const splitExamples = splitExample(FRAMEWORK);
    for (const game of shippedGames) {
      expect(
        splitExamples,
        `section 10 split example should list ${game.meta.id}`,
      ).toContain(`src/games/${game.meta.id}/`);
    }
    expect(splitExamples).toContain('镇煞');

    const reference = gameplayReference(FRAMEWORK);
    for (const game of shippedGames) {
      expect(
        reference,
        `complete gameplay reference should list ${game.meta.id}`,
      ).toContain(`src/games/${game.meta.id}/`);
    }
    expect(reference).toContain('镇煞');

    const domCopy = `${domGames.map((game) => game.meta.title).join('与')}是 ${
      domGames.length
    } 款纯 DOM 参考`;
    expect(reference).toContain(domCopy);
    expect(phaserGames).toHaveLength(4);
    expect(reference).toContain('其余四款使用 Phaser 场景');
  });

  it('removes the stale five-game unit-test wording', () => {
    expect(FRAMEWORK).not.toContain('五个游戏');
    const unitLine = FRAMEWORK.split('\n').find(
      (line) => line.includes('npm run test:unit') && line.includes('Vitest：'),
    );
    expect(unitLine, 'section 12 should keep the test:unit summary').toBeDefined();
    expect(unitLine).toContain('六个游戏');
  });
});
