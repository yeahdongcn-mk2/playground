import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dprForCaptureTarget } from '../../scripts/lib/capture-env.mjs';
import { captureTargetsForScript } from '../../scripts/run-container-capture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENSHOTS_README = readFileSync(
  join(ROOT, 'docs', 'screenshots', 'README.md'),
  'utf8',
);
const SCREENSHOT_DIR = join(ROOT, 'docs', 'screenshots');

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CORE_DIR = dirname(require.resolve('playwright-core/package.json'));
const PLAYWRIGHT_BROWSERS = require(join(PLAYWRIGHT_CORE_DIR, 'browsers.json')) as {
  browsers: { name: string; browserVersion?: string }[];
};
/** The Chromium build shipped by the pinned Playwright version. */
const CHROMIUM_VERSION = PLAYWRIGHT_BROWSERS.browsers.find(
  (browser) => browser.name === 'chromium',
)?.browserVersion;

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

/**
 * The backticked `targets` / `dprs` contract derived from the capture entry, so
 * the docs cannot pin a hand-written target list that drifts from the code.
 */
function targetContract(script: string, passthrough: readonly string[] = []): string {
  const targets = captureTargetsForScript(script, passthrough);
  const dprs = targets.map((target) => dprForCaptureTarget(target));
  return `\`${targets.join(',')}\` / \`${dprs.join(',')}\``;
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
    expect(captureTargetsForScript('screenshots:minesweeper')).toEqual([
      'desktop',
      'mobile',
      'mobile-touch',
    ]);
    expect(captureTargetsForScript('screenshots:minesweeper:touch-before')).toEqual([
      'mobile-touch',
    ]);
    expect(command).toContain('`screenshots:minesweeper`');
    expect(command).toContain(targetContract('screenshots:minesweeper'));
    expect(command).toContain('`screenshots:minesweeper:touch-before`');
    expect(command).toContain(targetContract('screenshots:minesweeper:touch-before'));
  });

  it('documents that the narrow family wins over touch-before for touch-before runs', () => {
    const command = lineStartingWith(FIXED_ENV, '- 容器命令：');
    expect(captureTargetsForScript('screenshots:minesweeper', ['--narrow'])).toEqual([
      'mobile',
    ]);
    expect(
      captureTargetsForScript('screenshots:minesweeper:touch-before', ['--narrow']),
    ).toEqual(['mobile']);
    expect(command).toContain(
      '对 `screenshots:minesweeper` 与 `screenshots:minesweeper:touch-before` 生效',
    );
    expect(command).toContain(
      `先于 \`--touch-before\` 把目标收紧为 ${targetContract(
        'screenshots:minesweeper',
        ['--narrow'],
      )}`,
    );
    expect(command).toContain(
      `\`screenshots:minesweeper:touch-before --narrow\` 注入 ${targetContract(
        'screenshots:minesweeper:touch-before',
        ['--narrow'],
      )}`,
    );
  });

  it('keeps the phone-only modes and the scores phone part at mobile / 2', () => {
    const command = lineStartingWith(FIXED_ENV, '- 容器命令：');
    for (const flag of ['--narrow(-before)', '--short(-before)', '--large(-before)']) {
      expect(command).toContain(`\`${flag}\``);
    }
    expect(command).toContain('`mobile` / `2`');
    expect(command).toContain(
      `成绩榜是桌面 + 手机组合 ${targetContract('screenshots:minesweeper:scores')}`,
    );
    expect(command).toContain('其手机图仍为 DPR 2');
  });

  it('scopes the three-context Chromium note to the minesweeper after run', () => {
    expect(FIXED_ENV).toContain(
      '扫雷 After 的 Chromium 运行会同时创建桌面、390×844 手机与 Pixel 7 触屏上下文',
    );
    expect(FIXED_ENV).toContain('其他 Chromium 截图脚本');
    expect(FIXED_ENV).toContain('不会出现 `mobile-touch` 行');
  });

  it('records the per-target fingerprint line and a real Chromium example', () => {
    expect(FIXED_ENV).toContain('`target=mobile-touch dpr=2.625`');
    expect(FIXED_ENV).toContain('`target=desktop dpr=1`');
    expect(FIXED_ENV).toContain('`target=mobile dpr=2`');
    expect(FIXED_ENV).toContain('每个目标一行');
    expect(CHROMIUM_VERSION).toBeDefined();
    const example = lineStartingWith(
      FIXED_ENV,
      '  capture-env: source=container target=mobile-touch dpr=2.625 ',
    );
    expect(example).toContain(`browser=${CHROMIUM_VERSION}`);
    expect(example).not.toContain('browser=27.2');
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
    expect(TOUCH_SECTION).toContain(targetContract('screenshots:minesweeper'));
    expect(TOUCH_SECTION).toContain(targetContract('screenshots:minesweeper:touch-before'));
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
