import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENSHOTS_README = readFileSync(
  join(ROOT, 'docs', 'screenshots', 'README.md'),
  'utf8',
);
const SCREENSHOT_DIR = join(ROOT, 'docs', 'screenshots');

const FIXED_ENV_HEADING = '## 固定捕获环境（Issue #199）';
const TOUCH_SECTION_HEADING = '## t7：扫雷触屏与手机布局（Issue #33 / 子任务 2）';
const TOUCH_SCREENSHOTS = ['before', 'after'].flatMap((phase) =>
  ['ready', 'playing', 'lost', 'won'].map(
    (state) => `${phase}-minesweeper-${state}-mobile.png`,
  ),
);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The text of one level-2 section, up to the next level-2 heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw new Error(`missing section: ${heading}`);
  }
  const end = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

/** The first line that starts with the given prefix. */
function lineStartingWith(text: string, prefix: string): string {
  const line = text.split('\n').find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) {
    throw new Error(`missing line: ${prefix}`);
  }
  return line;
}

/** The Markdown table row whose first cell names the given capture target. */
function targetRow(text: string, target: string): string {
  const row = text
    .split('\n')
    .find((line) => line.startsWith('|') && line.startsWith(`| \`${target}\``));
  if (row === undefined) {
    throw new Error(`missing capture target table row: ${target}`);
  }
  return row;
}

/** Read the PNG IHDR width / height without decoding the image. */
function readPngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(join(SCREENSHOT_DIR, file));
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${file}: invalid PNG signature`);
  }
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`${file}: first PNG chunk is not IHDR`);
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

const FIXED_ENV = section(SCREENSHOTS_README, FIXED_ENV_HEADING);
const TOUCH_SECTION = section(SCREENSHOTS_README, TOUCH_SECTION_HEADING);

describe('capture target docs (Issue #209)', () => {
  it('lists mobile-touch at DPR 2.625 with the Pixel 7 412×839 touch evidence', () => {
    const row = targetRow(FIXED_ENV, 'mobile-touch');
    expect(row).toContain('2.625');
    expect(row).toContain('Pixel 7');
    expect(row).toContain('412×839');
  });

  it('keeps Pixel 7 out of the DPR-2 mobile target row', () => {
    const row = targetRow(FIXED_ENV, 'mobile');
    expect(row).not.toContain('Pixel 7');
    expect(row).not.toContain('2.625');
    expect(row).toContain('390×844');
    expect(row).toContain('320×640');
  });

  it('marks the minesweeper -mobile files as Pixel 7 DPR 2.625 in the engine note', () => {
    const note = lineStartingWith(SCREENSHOTS_README, '引擎标注：');
    expect(note).toContain('DPR 2.625');
    expect(note).toContain('mobile-touch');
    expect(note).toContain('Pixel 7 412×839');
  });

  it('documents the container targets of the minesweeper after run and touch-before', () => {
    const command = lineStartingWith(FIXED_ENV, '- 容器命令：');
    expect(command).toContain('`screenshots:minesweeper`');
    expect(command).toContain('`desktop,mobile,mobile-touch` / `1,2,2.625`');
    expect(command).toContain('`screenshots:minesweeper:touch-before`');
    expect(command).toContain('`mobile-touch` / `2.625`');
  });

  it('keeps the phone-only modes and the scores phone part at mobile / 2', () => {
    const command = lineStartingWith(FIXED_ENV, '- 容器命令：');
    for (const flag of ['--narrow(-before)', '--short(-before)', '--large(-before)']) {
      expect(command).toContain(`\`${flag}\``);
    }
    expect(command).toContain('`mobile` / `2`');
    expect(command).toContain('成绩榜是桌面 + 手机组合 `desktop,mobile` / `1,2`');
    expect(command).toContain('其手机图仍为 DPR 2');
  });

  it('records the per-target fingerprint line and the mobile-touch example', () => {
    expect(FIXED_ENV).toContain('`target=mobile-touch dpr=2.625`');
    expect(FIXED_ENV).toContain('`target=desktop dpr=1`');
    expect(FIXED_ENV).toContain('`target=mobile dpr=2`');
    expect(FIXED_ENV).toContain('每个目标一行');
    expect(FIXED_ENV).toMatch(
      /capture-env: source=container target=mobile-touch dpr=2\.625 /,
    );
  });
});

describe('minesweeper touch evidence docs and PNG contract', () => {
  it('keeps the Pixel 7 412×839 and PNG 1082×2202 record in the t7 section', () => {
    expect(TOUCH_SECTION).toContain('Pixel 7');
    expect(TOUCH_SECTION).toContain('412×839');
    expect(TOUCH_SECTION).toContain('DPR 2.625');
    expect(TOUCH_SECTION).toContain('1082×2202');
  });

  it('documents the mobile-touch fingerprint and container reproduction commands', () => {
    expect(TOUCH_SECTION).toContain('`target=mobile-touch dpr=2.625`');
    expect(TOUCH_SECTION).toContain('每个目标一行');
    expect(TOUCH_SECTION).toContain(
      'npm run screenshots:container -- screenshots:minesweeper',
    );
    expect(TOUCH_SECTION).toContain(
      'npm run screenshots:container -- screenshots:minesweeper:touch-before',
    );
    expect(TOUCH_SECTION).toContain('`desktop,mobile,mobile-touch` / `1,2,2.625`');
    expect(TOUCH_SECTION).toContain('`mobile-touch` / `2.625`');
  });

  it('keeps all eight committed before / after touch PNGs at 1082×2202', () => {
    expect(TOUCH_SCREENSHOTS).toHaveLength(8);
    for (const file of TOUCH_SCREENSHOTS) {
      expect({ file, ...readPngSize(file) }).toEqual({
        file,
        width: 1082,
        height: 2202,
      });
    }
  });

  it('references the eight-file IHDR guard in the t7 section', () => {
    expect(TOUCH_SECTION).toContain(
      '`before/after-minesweeper-{ready,playing,lost,won}-mobile.png`',
    );
    expect(TOUCH_SECTION).toContain('`tests/unit/screenshot-target-docs.test.ts`');
  });
});
