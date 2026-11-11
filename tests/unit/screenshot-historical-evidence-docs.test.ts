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
const SNAKE_HEADING = '## t3：贪食蛇（PR #14）';
const MINESWEEPER_DESKTOP_HEADING = '## t6：扫雷（Issue #33 / 子任务 1）';
const MINESWEEPER_MOBILE_HEADING = '## t7：扫雷触屏与手机布局（Issue #33 / 子任务 2）';
const FOOTER_BEFORE = '四款游戏已上线';
const FOOTER_AFTER = '五款游戏已上线';
const FOOTER_COMMIT = '60bc3f3';
const GAME_2048_CAPTURE_COMMIT = '8ec4adc';
const BREAKOUT_CAPTURE_COMMIT = '26e84fa';
const SNAKE_CAPTURE_COMMIT = '048fe5a';
const MINESWEEPER_CAPTURE_COMMIT = '993f5e7';
const GAME_2048_READY = 'after-2048-ready-desktop.png';
const BREAKOUT_HISTORICAL = [
  'after-breakout-ready-desktop.png',
  'after-breakout-levelclear-desktop.png',
  'after-breakout-gameover-desktop.png',
];
const BREAKOUT_MOBILE_HISTORICAL = [
  'after-breakout-ready-mobile.png',
  'after-breakout-gameover-mobile.png',
];
const SNAKE_HISTORICAL = [
  'after-snake-ready.png',
  'after-snake-gameover.png',
  'after-snake-mobile.png',
];
const MINESWEEPER_DESKTOP_HISTORICAL = [
  'after-minesweeper-ready-desktop.png',
  'after-minesweeper-playing-desktop.png',
  'after-minesweeper-lost-desktop.png',
  'after-minesweeper-won-desktop.png',
];
const MINESWEEPER_MOBILE_HISTORICAL = [
  'after-minesweeper-ready-mobile.png',
  'after-minesweeper-playing-mobile.png',
  'after-minesweeper-lost-mobile.png',
  'after-minesweeper-won-mobile.png',
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

/** The Markdown table row that names the given screenshot. */
function screenshotRow(text: string, file: string): string {
  const row = text
    .split('\n')
    .find((line) => line.startsWith('|') && line.includes(`\`${file}\``));
  if (row === undefined) {
    throw new Error(`missing table row for: ${file}`);
  }
  return row;
}

/** Capture-group bullets in the shared historical section. */
function captureLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('  - ') && line.includes('捕获'));
}

const HISTORICAL = section(SCREENSHOTS_README, HISTORICAL_HEADING);
const GAME_2048 = section(SCREENSHOTS_README, GAME_2048_HEADING);
const BREAKOUT = section(SCREENSHOTS_README, BREAKOUT_HEADING);
const SNAKE = section(SCREENSHOTS_README, SNAKE_HEADING);
const MINESWEEPER_DESKTOP = section(
  SCREENSHOTS_README,
  MINESWEEPER_DESKTOP_HEADING,
);
const MINESWEEPER_MOBILE = section(
  SCREENSHOTS_README,
  MINESWEEPER_MOBILE_HEADING,
);

describe('historical After evidence docs for 2048 / breakout / snake / minesweeper (Issue #137)', () => {
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

    const captureList = captureLines(HISTORICAL).join('\n');
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

    const captureList = captureLines(HISTORICAL).join('\n');
    expect(captureList).not.toContain('after-2048-gameover-desktop.png');
    expect(captureList).not.toContain('after-2048-playing-desktop.png');
    expect(captureList).not.toContain('after-breakout-playing-desktop.png');
    expect(captureList).not.toContain('after-snake-playing.png');
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

  it('points the breakout section at the shared standard for desktop and mobile', () => {
    expect(BREAKOUT).toContain(HISTORICAL_TITLE);
    expect(BREAKOUT).toContain(BREAKOUT_CAPTURE_COMMIT);
    expect(BREAKOUT).toContain('y=472..1565');
    expect(BREAKOUT).toContain('不是页脚');
    for (const file of [...BREAKOUT_HISTORICAL, ...BREAKOUT_MOBILE_HISTORICAL]) {
      expect(BREAKOUT).toContain(file);
      expect(screenshotRow(BREAKOUT, file)).toContain('历史证据');
    }
    expect(BREAKOUT).toContain('逐字节比较只在同一构建、同一捕获环境下成立');
    const generationLines = BREAKOUT.split('\n').filter(
      (line) => line.includes('生成：') && line.includes('npm run screenshots:breakout'),
    );
    expect(generationLines).toHaveLength(1);
    expect(generationLines[0]).toContain(HISTORICAL_TITLE);
  });

  it('lists the snake captures as #14 historical evidence with the canvas drift reason', () => {
    for (const file of SNAKE_HISTORICAL) {
      expect(HISTORICAL).toContain(file);
      expect(SNAKE).toContain(file);
      expect(screenshotRow(SNAKE, file)).toContain('历史证据');
    }
    expect(HISTORICAL).toContain(SNAKE_CAPTURE_COMMIT);
    expect(HISTORICAL).toContain('#14');
    expect(HISTORICAL).toContain('54596');
    expect(HISTORICAL).toContain('每通道差 1');
    expect(SNAKE).toContain(HISTORICAL_TITLE);
    expect(SNAKE).toContain(SNAKE_CAPTURE_COMMIT);
    expect(SNAKE).toContain('54596');
    expect(SNAKE).toContain('每通道差 1');
    expect(SNAKE).toContain('不能作为当前构建');
    expect(SNAKE).toContain('重跑必须逐字节一致');
  });

  it('lists the breakout mobile captures as #29 historical evidence with the game-area drift', () => {
    for (const file of BREAKOUT_MOBILE_HISTORICAL) {
      expect(HISTORICAL).toContain(file);
      expect(screenshotRow(BREAKOUT, file)).toContain('历史证据');
    }
    expect(HISTORICAL).toContain(BREAKOUT_CAPTURE_COMMIT);
    expect(HISTORICAL).toContain('#29');
    expect(HISTORICAL).toContain('y=472..1565');
    expect(HISTORICAL).toContain('不是页脚');
    const captureList = captureLines(HISTORICAL).join('\n');
    for (const file of BREAKOUT_MOBILE_HISTORICAL) {
      expect(captureList).toContain(file);
    }
  });

  it('marks the minesweeper desktop and mobile captures as #61 historical evidence', () => {
    for (const file of MINESWEEPER_DESKTOP_HISTORICAL) {
      expect(HISTORICAL).toContain(file);
      expect(MINESWEEPER_DESKTOP).toContain(file);
      expect(screenshotRow(MINESWEEPER_DESKTOP, file)).toContain('历史证据');
    }
    for (const file of MINESWEEPER_MOBILE_HISTORICAL) {
      expect(HISTORICAL).toContain(file);
      expect(MINESWEEPER_MOBILE).toContain(file);
      expect(screenshotRow(MINESWEEPER_MOBILE, file)).toContain('历史证据');
    }
    for (const sectionText of [HISTORICAL, MINESWEEPER_DESKTOP, MINESWEEPER_MOBILE]) {
      expect(sectionText).toContain(MINESWEEPER_CAPTURE_COMMIT);
      expect(sectionText).toContain('#61');
    }
    expect(MINESWEEPER_DESKTOP).toContain(HISTORICAL_TITLE);
    expect(MINESWEEPER_DESKTOP).toContain('#85');
    expect(MINESWEEPER_DESKTOP).toContain('#87');
    expect(MINESWEEPER_MOBILE).toContain(HISTORICAL_TITLE);
    expect(MINESWEEPER_MOBILE).toContain('1082×2202');
    expect(MINESWEEPER_MOBILE).toContain('50.7');
    expect(MINESWEEPER_MOBILE).toContain('56.1');
  });

  it('keeps committed minesweeper full-page sizes in the table and current-build sizes in prose', () => {
    for (const file of MINESWEEPER_DESKTOP_HISTORICAL) {
      const row = screenshotRow(MINESWEEPER_DESKTOP, file);
      expect(row).toContain('整页 1440×1324');
      expect(row).not.toContain('1440×1529');
      expect(row).not.toContain('1440×1598');
    }
    const prose = MINESWEEPER_DESKTOP.split('\n')
      .filter((line) => !line.startsWith('|'))
      .join('\n');
    expect(prose).toContain('1440×1529');
    expect(prose).toContain('1440×1598');
    expect(prose).toContain('1440×1324');
  });

  it('points the root README screenshot command rows at the shared standard', () => {
    for (const command of [
      'npm run screenshots:snake',
      'npm run screenshots:2048',
      'npm run screenshots:breakout',
      'npm run screenshots:minesweeper',
    ]) {
      const rows = ROOT_README.split('\n').filter((line) =>
        line.startsWith(`| \`${command}\` |`),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain('历史证据');
      expect(rows[0]).toContain(HISTORICAL_TITLE);
    }
  });
});
