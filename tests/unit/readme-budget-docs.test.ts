import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENTRY_LIMIT,
  PER_GAME_LIMIT,
  TOTAL_JS_LIMIT,
  ZHEN_SHA_VIEW_CHUNK,
} from '../../scripts/lib/budget.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const KB = 1024;

/** A budget limit spelled the way the README writes it. */
function limitKb(limit: number): string {
  return `${limit / KB} KB`;
}

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

describe('README check:budget documentation', () => {
  it('keeps the three documented limits in sync with the budget implementation', () => {
    // The 50 KB / 450 KB / 35 KB values are product policy, so pin them to the
    // constants the gate actually enforces instead of duplicating the numbers.
    expect(ENTRY_LIMIT).toBe(50 * KB);
    expect(TOTAL_JS_LIMIT).toBe(450 * KB);
    expect(PER_GAME_LIMIT).toBe(35 * KB);
  });

  it('has exactly one check:budget row that names every gzip gate', () => {
    const row = commandRow('npm run check:budget');

    for (const marker of [
      '入口',
      'Phaser',
      'THREE',
      `<${limitKb(ENTRY_LIMIT)} gzip`,
      '全部 JS chunk',
      `<${limitKb(TOTAL_JS_LIMIT)} gzip`,
      'dist/assets/zhen-sha-view-*.js',
      `合计 ≤${limitKb(PER_GAME_LIMIT)} gzip`,
    ]) {
      expect(row, `npm run check:budget 的命令表行缺少：${marker}`).toContain(marker);
    }
  });

  it('documents the zero-match, combined-match and gzip measurement rules', () => {
    const row = commandRow('npm run check:budget');

    for (const marker of [
      '0 个匹配视为失败',
      'npm run build',
      '多个匹配按合计判定',
      'gzipSync',
      '默认级别',
      'Vite',
      '不是门禁输入',
    ]) {
      expect(row, `npm run check:budget 的命令表行缺少：${marker}`).toContain(marker);
    }
  });

  it('matches the zhen-sha view glob the gate implements', () => {
    const row = commandRow('npm run check:budget');

    expect(row).toContain('dist/assets/zhen-sha-view-*.js');
    expect(ZHEN_SHA_VIEW_CHUNK.test('zhen-sha-view-BxyVRsgc.js')).toBe(true);
    expect(ZHEN_SHA_VIEW_CHUNK.test('zhen-sha-view.css')).toBe(false);
  });

  it('shows the real check:budget output with a measurable Zhen Sha view line', () => {
    const verification = section(README, '## 验证');

    for (const marker of [
      'Entry JS:',
      'All JS chunks:',
      `(2D game budget ${limitKb(TOTAL_JS_LIMIT)})`,
      'Zhen Sha view JS:',
      `gzip (per-game budget ${limitKb(PER_GAME_LIMIT)})`,
      'Budget check OK: shell is engine-free and within the 2D download budget.',
    ]) {
      expect(verification, `README 的「验证」段落缺少：${marker}`).toContain(marker);
    }

    const entry = /Entry JS: [\d.]+ KB \(([\d.]+) KB gzip\)/.exec(verification);
    expect(entry?.[1], '「验证」段落应记录入口的 gzip 实测值').toBeDefined();
    expect(Number(entry?.[1])).toBeLessThanOrEqual(ENTRY_LIMIT / KB);

    const allJs = /All JS chunks: ([\d.]+) KB gzip/.exec(verification);
    expect(allJs?.[1], '「验证」段落应记录全部 JS 的 gzip 实测值').toBeDefined();
    expect(Number(allJs?.[1])).toBeLessThanOrEqual(TOTAL_JS_LIMIT / KB);

    const zhenSha =
      /Zhen Sha view JS: (\S+\.js) ([\d.]+) KB gzip \(per-game budget (\d+) KB\)/.exec(
        verification,
      );
    expect(zhenSha, '「验证」段落应记录 Zhen Sha view 的 chunk 与 gzip 实测值').not.toBeNull();
    expect(ZHEN_SHA_VIEW_CHUNK.test(zhenSha?.[1] ?? '')).toBe(true);
    expect(Number(zhenSha?.[2])).toBeLessThanOrEqual(PER_GAME_LIMIT / KB);
    expect(Number(zhenSha?.[3])).toBe(PER_GAME_LIMIT / KB);
  });
});
