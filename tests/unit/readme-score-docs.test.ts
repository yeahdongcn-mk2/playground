import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

/** The body of one level-2 section, up to the next level-2 heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw new Error(`找不到小节：${heading}`);
  }
  const end = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

/**
 * The one command-table row for an npm script. Exactly one row is required so
 * the docs cannot keep a stale duplicate next to the current description.
 */
function commandRow(script: string): string {
  const prefix = `| \`${script}\` |`;
  const rows = README.split('\n').filter((line) => line.startsWith(prefix));
  expect(rows, `README.md 的命令表应恰好有一行以 ${prefix} 开头`).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) {
    throw new Error(`README.md 的命令表缺少 ${script}`);
  }
  return row;
}

describe('README score documentation', () => {
  it('lists npm run score in the command table against the baseline file', () => {
    expect(commandRow('npm run score')).toContain('docs/score-baseline.json');
  });

  it('documents the comparison table, SCORE_JSON line, exit code, --update and build step', () => {
    const row = commandRow('npm run score');

    for (const marker of [
      '指标 / 当前值 / 基线值 / 差值',
      'SCORE_JSON',
      '--update',
      '退出 1',
      '只报差值',
      '不自动更新基线',
      'npm run build',
      'check:budget',
      'dist/',
    ]) {
      expect(row, `npm run score 的用法说明缺少：${marker}`).toContain(marker);
    }
  });

  it('records npm run score in the verification section', () => {
    const verification = section(README, '## 验证');
    const scoreLine = verification
      .split('\n')
      .find((line) => line.trimStart().startsWith('npm run score'));

    expect(scoreLine, 'README 的「验证」段落应记录 npm run score').toBeDefined();
    expect(scoreLine).toContain('SCORE_JSON');
  });

  it('says CI runs npm run score without --update and a person commits the baseline', () => {
    const verification = section(README, '## 验证');

    expect(verification).toContain('CI');
    expect(verification).toContain('`npm run score`');
    expect(verification).toContain('不会运行 `npm run score -- --update`');
    expect(verification).toContain('基线仍由人显式运行 `--update` 后提交');
  });
});
