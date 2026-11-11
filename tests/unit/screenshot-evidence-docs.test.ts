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
const SNAKE_DESIGN = readFileSync(join(ROOT, 'docs', 'snake-design.md'), 'utf8');
const HISTORICAL_SECTION = SCREENSHOTS_README.slice(
  SCREENSHOTS_README.indexOf('## 历史 After 证据与当前构建不一致（Issue #137）'),
  SCREENSHOTS_README.indexOf('## CI：截图文档整页尺寸校验（Issue #134）'),
);

const SCORES_HEADING = '## scores：扫雷本地最高用时榜';
const SCORES_CLEAR_HEADING = '## scores-clear：扫雷最高用时「清空记录」';
const HISTORICAL_COMMIT = '338d06c';
const PLAIN_COMMAND = 'npm run screenshots:minesweeper:scores';
const OVERWRITE_FLAG = '--allow-historical-overwrite';
const DESKTOP_AFTER = 'after-minesweeper-scores-desktop.png';
const MOBILE_AFTER = 'after-minesweeper-scores-320x640.png';
const DESKTOP_CLEAR = 'after-minesweeper-clear-scores-desktop.png';
const MOBILE_CLEAR = 'after-minesweeper-clear-scores-320x640.png';

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

const SCORES = section(SCREENSHOTS_README, SCORES_HEADING);
const SCORES_CLEAR = section(SCREENSHOTS_README, SCORES_CLEAR_HEADING);

describe('scores screenshot historical evidence docs', () => {
  it('marks both scores After screenshots as #45 subtask 1 historical evidence', () => {
    expect(SCORES).toContain('历史证据');
    expect(SCORES).toContain('#45 子任务 1');
    expect(SCORES).toContain(HISTORICAL_COMMIT);
    expect(SCORES).toContain(DESKTOP_AFTER);
    expect(SCORES).toContain(MOBILE_AFTER);
    expect(SCORES).toContain('不代表当前 UI');
    expect(screenshotRow(SCORES, DESKTOP_AFTER)).toContain('#45 子任务 1 历史证据');
    expect(screenshotRow(SCORES, MOBILE_AFTER)).toContain('#45 子任务 1 历史证据');
  });

  it('no longer presents the plain command as how the historical After images are generated', () => {
    const legacyInstruction = /^-\s*生成 After：`npm run screenshots:minesweeper:scores`/m;
    expect(SCORES).not.toMatch(legacyInstruction);

    const generationLines = SCORES.split('\n').filter(
      (line) => line.includes('生成 After') && line.includes(PLAIN_COMMAND),
    );
    expect(generationLines.length).toBeGreaterThan(0);
    for (const line of generationLines) {
      expect(line).toContain('历史证据');
      expect(line).toContain(OVERWRITE_FLAG);
    }
  });

  it('documents the default refusal and the explicit overwrite flag', () => {
    expect(SCORES).toContain('默认拒绝覆盖');
    expect(SCORES).toContain(OVERWRITE_FLAG);
    expect(SCORES).toMatch(/启动 preview[^。]*之前/);
    expect(SCORES).toContain('整页尺寸');
    expect(SCORES).toContain('重建');
  });

  it('points to scores-clear as the current UI evidence', () => {
    expect(SCORES).toContain('scores-clear');
    expect(SCORES).toContain('当前 UI');
    expect(SCORES_CLEAR).toContain('清空记录');
    expect(SCORES_CLEAR).toContain(DESKTOP_CLEAR);
    expect(SCORES_CLEAR).toContain(MOBILE_CLEAR);
  });

  it('keeps the historical full-page sizes and descriptions, not the current panel sizes', () => {
    const desktop = screenshotRow(SCORES, DESKTOP_AFTER);
    const mobile = screenshotRow(SCORES, MOBILE_AFTER);
    expect(desktop).toContain('1440×1606');
    expect(mobile).toContain('640×4098');
    expect(desktop).toContain('还没有「清空记录」');
    expect(mobile).toContain('还没有「清空记录」');
    expect(desktop).not.toContain('1440×1661');
    expect(mobile).not.toContain('640×4210');
  });

  it('marks the root README screenshot command row as historical evidence too', () => {
    const row = ROOT_README.split('\n').find((line) =>
      line.startsWith('| `npm run screenshots:minesweeper:scores`'),
    );
    expect(row).toBeDefined();
    expect(row).toContain('历史证据');
    expect(row).toContain('清空记录');
    expect(row).toContain(OVERWRITE_FLAG);
  });
});

describe('fixed-container historical overwrite docs (Issue #199)', () => {
  it('documents that the overwrite flag only works inside the fixed container', () => {
    expect(HISTORICAL_SECTION).toContain('npm run screenshots:container');
    expect(HISTORICAL_SECTION).toContain(OVERWRITE_FLAG);
    expect(HISTORICAL_SECTION).toContain('固定容器');
    expect(HISTORICAL_SECTION).toContain('source=container');
  });

  it('documents the docs capture commit and sha256 manifest update checklist', () => {
    expect(HISTORICAL_SECTION).toContain('capture-sha256-manifest.json');
    expect(HISTORICAL_SECTION).toContain('捕获 commit');
    expect(HISTORICAL_SECTION).toContain('checklist');
  });

  it('shows the container form of the snake overwrite command', () => {
    expect(SNAKE_DESIGN).toContain(
      'npm run screenshots:container -- screenshots:snake --allow-historical-overwrite',
    );
    expect(SNAKE_DESIGN).toContain('capture-sha256-manifest.json');
  });

  it('shows the container form in every root README screenshot row that mentions the flag', () => {
    const rows = ROOT_README.split('\n').filter(
      (line) => line.startsWith('| `npm run screenshots') && line.includes(OVERWRITE_FLAG),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toContain('npm run screenshots:container');
    }
  });
});
