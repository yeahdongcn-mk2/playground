import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENSHOTS_README = readFileSync(
  join(ROOT, 'docs', 'screenshots', 'README.md'),
  'utf8',
);

const HISTORICAL_HEADING = '## 历史 After 证据与当前构建不一致（Issue #137）';
const WEBKIT_PHONE_HEADING =
  '## webkit-phone：t1–t3 稳定场景的 WebKit 手机端截图（Issue #100 / t4）';
const WEBKIT_NARROW_HEADING =
  '## webkit-narrow：扫雷窄屏首屏契约的 WebKit 矩阵（Issue #83 / 子任务 1）';
const WEBKIT_HISTORICAL_TITLE = 'WebKit 历史证据（Issue #137 / #120）';
const WEBKIT_HISTORICAL_HEADING = `### ${WEBKIT_HISTORICAL_TITLE}`;
const CAPTURE_COMMIT = '498a14f';
const ISSUE_199_URL = 'https://github.com/yeahdongcn-mk2/playground/issues/199';
const CONTAINER_IMAGE = 'mcr.microsoft.com/playwright:v1.64.1-noble';

/** The text of one level-2 section, up to the next level-2 heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw new Error(`missing section: ${heading}`);
  }
  const end = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

/** The text of one level-3 subsection, up to the next level-2/3 heading. */
function subsection(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw new Error(`missing subsection: ${heading}`);
  }
  const nextLevel2 = text.indexOf('\n## ', start + heading.length);
  const nextLevel3 = text.indexOf('\n### ', start + heading.length);
  const candidates = [nextLevel2, nextLevel3].filter((index) => index >= 0);
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
}

const HISTORICAL = section(SCREENSHOTS_README, HISTORICAL_HEADING);
const WEBKIT_PHONE = section(SCREENSHOTS_README, WEBKIT_PHONE_HEADING);
const WEBKIT_NARROW = section(SCREENSHOTS_README, WEBKIT_NARROW_HEADING);
const WEBKIT_HISTORICAL = subsection(WEBKIT_PHONE, WEBKIT_HISTORICAL_HEADING);

const BREAKOUT_DRIFT = [
  'after-breakout-ready-webkit.png',
  'after-breakout-levelclear-webkit.png',
  'after-breakout-gameover-webkit.png',
];
const MINESWEEPER_DRIFT = [
  'after-minesweeper-ready-webkit.png',
  'after-minesweeper-playing-webkit.png',
  'after-minesweeper-lost-webkit.png',
  'after-minesweeper-won-webkit.png',
];
const NARROW_DRIFT = [
  'after-minesweeper-webkit-narrow-320x640.png',
  'after-minesweeper-webkit-narrow-360x640.png',
  'after-minesweeper-webkit-narrow-375x667.png',
  'after-minesweeper-webkit-narrow-412x839.png',
];
const DRIFTED = [...BREAKOUT_DRIFT, ...MINESWEEPER_DRIFT, ...NARROW_DRIFT];
const DETERMINISTIC = [
  'after-breakout-playing-webkit.png',
  'after-2048-playing-webkit.png',
  'after-2048-gameover-webkit.png',
];

/** Bullets nested under the drift list, which is where every drifted file must appear. */
function driftBullets(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.startsWith('  - '))
    .join('\n');
}

describe('WebKit historical evidence docs (Issue #137)', () => {
  it('records the #120 capture commit and that the committed PNGs are not re-shot', () => {
    expect(WEBKIT_HISTORICAL).toContain(CAPTURE_COMMIT);
    expect(WEBKIT_HISTORICAL).toContain('#120');
    expect(WEBKIT_HISTORICAL).toContain(
      'https://github.com/yeahdongcn-mk2/playground/commit/498a14fb2c7faf426ae79381f433b64f2a18586e',
    );
    expect(WEBKIT_HISTORICAL).toContain('不重拍');
    expect(WEBKIT_HISTORICAL).toContain('不改动任何已提交 PNG');
  });

  it('lists the drifted breakout, minesweeper and webkit-narrow artifacts', () => {
    for (const file of DRIFTED) {
      expect(WEBKIT_HISTORICAL).toContain(file);
      expect(driftBullets(WEBKIT_HISTORICAL)).toContain(file);
    }
  });

  it('keeps the same-environment deterministic WebKit captures out of the drift list', () => {
    expect(WEBKIT_HISTORICAL).toContain('不在');
    expect(WEBKIT_HISTORICAL).toContain('确定性接缝');
    for (const file of DETERMINISTIC) {
      expect(WEBKIT_HISTORICAL).toContain(file);
      expect(driftBullets(WEBKIT_HISTORICAL)).not.toContain(file);
    }
    expect(WEBKIT_HISTORICAL).toContain('4173dce8');
    expect(WEBKIT_HISTORICAL).toContain('bf7548b7');
  });

  it('marks after-2048-ready-webkit.png as rechecked from the same capture commit and drifted', () => {
    expect(WEBKIT_HISTORICAL).toContain('after-2048-ready-webkit.png');
    expect(WEBKIT_HISTORICAL).toContain('同一捕获提交');
    expect(WEBKIT_HISTORICAL).toContain('4f488a3e');
    expect(WEBKIT_HISTORICAL).toContain('672285de');
    expect(WEBKIT_HISTORICAL).toContain('0.22%');
    expect(driftBullets(WEBKIT_HISTORICAL)).toContain('after-2048-ready-webkit.png');
  });

  it('documents the local EGL requirement and the Playwright container recheck', () => {
    expect(WEBKIT_HISTORICAL).toContain('__EGL_VENDOR_LIBRARY_FILENAMES');
    expect(WEBKIT_HISTORICAL).toContain('EGL_PLATFORM=surfaceless');
    expect(WEBKIT_HISTORICAL).toContain('LIBGL_ALWAYS_SOFTWARE=1');
    expect(WEBKIT_HISTORICAL).toContain(CONTAINER_IMAGE);
    expect(WEBKIT_HISTORICAL).toContain('ready 1.13%');
    expect(WEBKIT_HISTORICAL).toContain('playing 0.06%');
    expect(WEBKIT_HISTORICAL).toContain('lost 0.02%');
    expect(WEBKIT_HISTORICAL).toContain('won 0.02%');
    expect(WEBKIT_HISTORICAL).toContain('10–14');
    expect(WEBKIT_HISTORICAL).toContain('同一捕获环境连续两跑');
  });

  it('makes the CI manifest, not sha256, the authoritative webkit-narrow check', () => {
    expect(WEBKIT_HISTORICAL).toContain('不是 sha256');
    expect(WEBKIT_HISTORICAL).toContain('ci-webkit-narrow-manifest.json');
    expect(WEBKIT_HISTORICAL).toContain('WebKit narrow screenshot smoke test');
    expect(WEBKIT_HISTORICAL).toContain('npm run verify:screenshots:webkit');
    expect(WEBKIT_HISTORICAL).toContain('engine=webkit');
    expect(WEBKIT_HISTORICAL).toContain('视口');
    expect(WEBKIT_HISTORICAL).toContain('不作为「重跑必须等于已提交 PNG」的验收基准');
  });

  it('points hash-level reproduction at the fixed-capture-environment follow-up #199', () => {
    expect(WEBKIT_HISTORICAL).toContain(ISSUE_199_URL);
    expect(WEBKIT_HISTORICAL).toContain('#199');
    expect(WEBKIT_HISTORICAL).toContain('固定捕获环境');
  });

  it('cross-references the WebKit subsection from the narrow matrix and shared historical section', () => {
    expect(WEBKIT_HISTORICAL_TITLE).toBeTruthy();
    expect(WEBKIT_NARROW).toContain('不是与已提交 PNG 的 sha256 比对');
    expect(WEBKIT_NARROW).toContain('ci-webkit-narrow-manifest.json');
    expect(WEBKIT_NARROW).toContain(WEBKIT_HISTORICAL_TITLE);
    expect(HISTORICAL).toContain(WEBKIT_HISTORICAL_TITLE);
    expect(HISTORICAL).toContain('#199');
  });

  it('keeps the webkit-phone and webkit-narrow tables intact for the documented artifacts', () => {
    for (const file of [
      ...BREAKOUT_DRIFT,
      ...MINESWEEPER_DRIFT,
      'after-2048-ready-webkit.png',
      ...DETERMINISTIC,
    ]) {
      const row = WEBKIT_PHONE.split('\n').find(
        (line) => line.startsWith('|') && line.includes(`\`${file}\``),
      );
      expect(row, `missing webkit-phone table row for ${file}`).toBeDefined();
    }
    for (const file of NARROW_DRIFT) {
      const row = WEBKIT_NARROW.split('\n').find(
        (line) => line.startsWith('|') && line.includes(`\`${file}\``),
      );
      expect(row, `missing webkit-narrow table row for ${file}`).toBeDefined();
    }
  });
});
