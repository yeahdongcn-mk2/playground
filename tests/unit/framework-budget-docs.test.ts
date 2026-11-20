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
const FRAMEWORK = readFileSync(join(ROOT, 'docs', 'framework.md'), 'utf8');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const LABEL = 'docs/framework.md';
const KB = 1024;

/** A budget limit spelled the way the docs write it. */
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
 * The only line of `label` that contains `marker`. Requiring exactly one line
 * keeps the gate documented in one place instead of a stale duplicate.
 */
function uniqueLine(source: string, marker: string, label: string): string {
  const lines = source.split('\n').filter((line) => line.includes(marker));
  expect(lines, `${label} 应恰好有一行包含：${marker}`).toHaveLength(1);
  const [line] = lines;
  if (line === undefined) {
    throw new Error(`${label} 缺少包含 ${marker} 的行`);
  }
  return line;
}

/** Section 12 (测试), which holds the check:budget command line. */
function testSection(): string {
  return section(FRAMEWORK, '## 12. ');
}

/** The documented section 14 bullet that lists the current gzip measurements. */
function budgetBullet(): string {
  return uniqueLine(FRAMEWORK, '入口 JS 约', LABEL);
}

describe('framework check:budget documentation', () => {
  it('keeps the three documented limits in sync with the budget implementation', () => {
    expect(ENTRY_LIMIT).toBe(50 * KB);
    expect(TOTAL_JS_LIMIT).toBe(450 * KB);
    expect(PER_GAME_LIMIT).toBe(35 * KB);
  });

  it('names every gzip gate in the section 12 check:budget command', () => {
    const line = uniqueLine(testSection(), 'npm run check:budget', 'docs/framework.md 第 12 节');

    for (const marker of [
      '入口不含引擎标记',
      'Phaser.Game',
      'Scene',
      'AUTO',
      'THREE.',
      `≤${limitKb(ENTRY_LIMIT)} gzip`,
      '全部 JS chunk 合计',
      `合计 ≤${limitKb(TOTAL_JS_LIMIT)} gzip`,
      'dist/assets/zhen-sha-view-*.js',
      `合计 ≤${limitKb(PER_GAME_LIMIT)} gzip`,
      '0 个匹配视为失败',
      'npm run build',
      '多个匹配按合计判定',
      'node:zlib',
      'gzipSync',
      '默认级别',
      'Vite',
      '不是门禁输入',
    ]) {
      expect(line, `第 12 节的 check:budget 命令行缺少：${marker}`).toContain(marker);
    }
  });

  it('names every gzip gate and measurement rule in the section 14 budget bullet', () => {
    const line = budgetBullet();

    for (const marker of [
      '入口不含引擎标记',
      'Phaser.Game',
      'Scene',
      'AUTO',
      'THREE.',
      `≤${limitKb(ENTRY_LIMIT)} gzip`,
      '全部 JS chunk 合计',
      `合计 ≤${limitKb(TOTAL_JS_LIMIT)} gzip`,
      'dist/assets/zhen-sha-view-*.js',
      `合计 ≤${limitKb(PER_GAME_LIMIT)} gzip`,
      '0 个匹配视为失败',
      'npm run build',
      '多个匹配按合计',
      'node:zlib',
      'gzipSync',
      '默认级别',
      'Vite',
      '不是门禁输入',
    ]) {
      expect(line, `第 14 节的预算条目缺少：${marker}`).toContain(marker);
    }
  });

  it('matches the zhen-sha view glob the gate implements', () => {
    for (const line of [
      uniqueLine(testSection(), 'npm run check:budget', 'docs/framework.md 第 12 节'),
      budgetBullet(),
    ]) {
      expect(line).toContain('dist/assets/zhen-sha-view-*.js');
    }
    expect(ZHEN_SHA_VIEW_CHUNK.test('zhen-sha-view-BxyVRsgc.js')).toBe(true);
    expect(ZHEN_SHA_VIEW_CHUNK.test('zhen-sha-view.css')).toBe(false);
  });

  it('keeps the documented limits and measurements within budget and in sync with README', () => {
    const line = budgetBullet();

    const entryLimit = /入口不含引擎标记[^且]*且 ≤(\d+) KB gzip/.exec(line);
    expect(entryLimit?.[1], '第 14 节应记录入口的 gzip 上限').toBeDefined();
    expect(Number(entryLimit?.[1])).toBe(ENTRY_LIMIT / KB);

    const entry = /入口 JS 约 ([\d.]+) KB gzip/.exec(line);
    expect(entry?.[1], '第 14 节应记录入口 JS 的 gzip 实测值').toBeDefined();
    expect(Number(entry?.[1])).toBeLessThanOrEqual(ENTRY_LIMIT / KB);

    const allJs = /全部 JS chunk 合计 ≤(\d+) KB gzip（当前约 ([\d.]+) KB gzip）/.exec(line);
    expect(allJs?.[1], '第 14 节应记录全部 JS chunk 的 gzip 上限').toBeDefined();
    expect(Number(allJs?.[1])).toBe(TOTAL_JS_LIMIT / KB);
    expect(allJs?.[2], '第 14 节应记录全部 JS chunk 的 gzip 实测值').toBeDefined();
    expect(Number(allJs?.[2])).toBeLessThanOrEqual(TOTAL_JS_LIMIT / KB);

    const zhenSha = /zhen-sha-view-\*\.js[^（]*合计 ≤(\d+) KB gzip（当前约 ([\d.]+) KB gzip）/.exec(
      line,
    );
    expect(zhenSha?.[1], '第 14 节应记录 zhen-sha view 的 gzip 上限').toBeDefined();
    expect(Number(zhenSha?.[1])).toBe(PER_GAME_LIMIT / KB);
    expect(zhenSha?.[2], '第 14 节应记录 zhen-sha view 的 gzip 实测值').toBeDefined();
    expect(Number(zhenSha?.[2])).toBeLessThanOrEqual(PER_GAME_LIMIT / KB);

    // The README "验证" section carries the real `npm run check:budget` output;
    // the framework measurements must not drift away from that copy.
    const verification = section(README, '## 验证');
    const readmeZhenSha = new RegExp(
      `Zhen Sha view JS: \\S+\\.js ([\\d.]+) KB gzip \\(per-game budget ${limitKb(PER_GAME_LIMIT)}\\)`,
    ).exec(verification);
    expect(readmeZhenSha?.[1], 'README 应记录 Zhen Sha view 的 gzip 实测值').toBeDefined();
    expect(zhenSha?.[2]).toBe(readmeZhenSha?.[1]);

    const readmeEntry = /Entry JS: [\d.]+ KB \(([\d.]+) KB gzip\)/.exec(verification);
    expect(readmeEntry?.[1], 'README 应记录入口的 gzip 实测值').toBeDefined();
    expect(entry?.[1]).toBe(readmeEntry?.[1]);

    const readmeAllJs = /All JS chunks: ([\d.]+) KB gzip/.exec(verification);
    expect(readmeAllJs?.[1], 'README 应记录全部 JS 的 gzip 实测值').toBeDefined();
    expect(allJs?.[2]).toBe(readmeAllJs?.[1]);
  });
});
