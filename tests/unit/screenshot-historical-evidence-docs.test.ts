import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENSHOTS_README = readFileSync(
  join(ROOT, 'docs', 'screenshots', 'README.md'),
  'utf8',
);
const ROOT_README = readFileSync(join(ROOT, 'README.md'), 'utf8');

const HISTORICAL_TITLE = '历史 After 证据与当前构建不一致（Issue #137）';
const HISTORICAL_HEADING = `## ${HISTORICAL_TITLE}`;
const GAME_2048_HEADING = '## t4：2048（PR #26）';
const BREAKOUT_HEADING = '## t5：打砖块（Issue #27 / 子任务 1）';
const FOOTER_BEFORE = '四款游戏已上线';
const FOOTER_AFTER = '五款游戏已上线';
const FOOTER_COMMIT = '60bc3f3';
const GAME_2048_CAPTURE_COMMIT = '8ec4adc';
const BREAKOUT_CAPTURE_COMMIT = '26e84fa';
const GAME_2048_READY = 'after-2048-ready-desktop.png';
const BREAKOUT_HISTORICAL = [
  'after-breakout-ready-desktop.png',
  'after-breakout-levelclear-desktop.png',
  'after-breakout-gameover-desktop.png',
];

/** The text of one level-2 section, up to the next level-2 heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw new Error(`missing section: ${heading}`);
  }
  const end = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

const HISTORICAL = section(SCREENSHOTS_README, HISTORICAL_HEADING);
const GAME_2048 = section(SCREENSHOTS_README, GAME_2048_HEADING);
const BREAKOUT = section(SCREENSHOTS_README, BREAKOUT_HEADING);

describe('historical After evidence docs for 2048 / breakout (Issue #137)', () => {
  it('defines the authoritative comparison standard in a dedicated section', () => {
    expect(HISTORICAL).toContain('权威对照口径');
    expect(HISTORICAL).toContain('同一构建');
    expect(HISTORICAL).toContain('同一捕获环境');
    expect(HISTORICAL).toContain('确定性产物');
    expect(HISTORICAL).toContain('干净 worktree');
    expect(HISTORICAL).toContain('父提交');
    expect(HISTORICAL).toContain('不要求重跑结果等于已提交的历史');
    expect(HISTORICAL).toContain('`fullPage` PNG');
  });

  it('records the footer copy drift that makes historical desktop full-page captures differ', () => {
    expect(HISTORICAL).toContain(FOOTER_BEFORE);
    expect(HISTORICAL).toContain(FOOTER_AFTER);
    expect(HISTORICAL).toContain(FOOTER_COMMIT);
    expect(HISTORICAL).toContain('#36');
    expect(HISTORICAL).toContain('`fullPage`');
    expect(HISTORICAL).toContain('重跑必然不同');
  });

  it('lists the four historical desktop captures with their capture commits', () => {
    expect(HISTORICAL).toContain(GAME_2048_READY);
    for (const file of BREAKOUT_HISTORICAL) {
      expect(HISTORICAL).toContain(file);
    }
    expect(HISTORICAL).toContain(GAME_2048_CAPTURE_COMMIT);
    expect(HISTORICAL).toContain('#26');
    expect(HISTORICAL).toContain(BREAKOUT_CAPTURE_COMMIT);
    expect(HISTORICAL).toContain('#29');

    const captureLines = HISTORICAL.split('\n').filter(
      (line) => line.startsWith('  - ') && line.endsWith('捕获。'),
    );
    expect(captureLines).toHaveLength(2);
    const captureList = captureLines.join('\n');
    expect(captureList).toContain(GAME_2048_READY);
    for (const file of BREAKOUT_HISTORICAL) {
      expect(captureList).toContain(file);
    }
    expect(captureList).toContain(GAME_2048_CAPTURE_COMMIT);
    expect(captureList).toContain(BREAKOUT_CAPTURE_COMMIT);
  });

  it('excludes captures re-shot on the current build from the historical set', () => {
    expect(HISTORICAL).toContain('不在此列');
    expect(HISTORICAL).toContain('8dbe3e7');
    expect(HISTORICAL).toContain('#145');
    expect(HISTORICAL).toContain('after-2048-gameover-desktop.png');
    expect(HISTORICAL).toContain('after-breakout-playing-desktop.png');

    const captureLines = HISTORICAL.split('\n')
      .filter((line) => line.startsWith('  - ') && line.endsWith('捕获。'))
      .join('\n');
    expect(captureLines).not.toContain('after-2048-gameover-desktop.png');
    expect(captureLines).not.toContain('after-2048-playing-desktop.png');
    expect(captureLines).not.toContain('after-breakout-playing-desktop.png');
  });

  it('points the 2048 section at the shared standard', () => {
    expect(GAME_2048).toContain(HISTORICAL_TITLE);
    expect(GAME_2048).toContain(GAME_2048_READY);
    expect(GAME_2048).toContain(GAME_2048_CAPTURE_COMMIT);
    expect(GAME_2048).toContain('逐字节比较只在同一构建、同一捕获环境下成立');
    const generationLines = GAME_2048.split('\n').filter(
      (line) => line.includes('生成：') && line.includes('npm run screenshots:2048'),
    );
    expect(generationLines).toHaveLength(1);
    expect(generationLines[0]).toContain(HISTORICAL_TITLE);
  });

  it('points the breakout section at the shared standard', () => {
    expect(BREAKOUT).toContain(HISTORICAL_TITLE);
    expect(BREAKOUT).toContain(BREAKOUT_CAPTURE_COMMIT);
    for (const file of BREAKOUT_HISTORICAL) {
      expect(BREAKOUT).toContain(file);
    }
    expect(BREAKOUT).toContain('逐字节比较只在同一构建、同一捕获环境下成立');
    const generationLines = BREAKOUT.split('\n').filter(
      (line) => line.includes('生成：') && line.includes('npm run screenshots:breakout'),
    );
    expect(generationLines).toHaveLength(1);
    expect(generationLines[0]).toContain(HISTORICAL_TITLE);
  });

  it('points the root README screenshot command rows at the shared standard', () => {
    for (const command of ['npm run screenshots:2048', 'npm run screenshots:breakout']) {
      const rows = ROOT_README.split('\n').filter((line) =>
        line.startsWith(`| \`${command}\` |`),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain('历史证据');
      expect(rows[0]).toContain(HISTORICAL_TITLE);
    }
  });
});
