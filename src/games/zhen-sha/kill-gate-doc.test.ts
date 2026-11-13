import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GAME_DIR = join(ROOT, 'src', 'games', 'zhen-sha');
const DOC = readFileSync(join(ROOT, 'docs', 'zhen-sha-kill-gate.md'), 'utf8');

/** Whether a file in the game directory contributes to the production build. */
function isProductionFile(name: string): boolean {
  const extension = extname(name);
  if (extension !== '.ts' && extension !== '.css') {
    return false;
  }
  return !name.endsWith('.test.ts') && !name.endsWith('.test.css') && !name.endsWith('.d.ts');
}

/** Count lines the way `wc -l` does, with or without a final newline. */
function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

const PRODUCTION_FILES = readdirSync(GAME_DIR).filter(isProductionFile).sort();
const PRODUCTION_LINES = PRODUCTION_FILES.reduce(
  (total, name) => total + countLines(readFileSync(join(GAME_DIR, name), 'utf8')),
  0,
);

/** A `标签：数字` metric claimed by the assessment document. */
function claimedNumber(label: string): number {
  const match = new RegExp(`${label}[：:]\\s*([\\d,]+)`).exec(DOC);
  const raw = match?.[1];
  if (raw === undefined) {
    throw new Error(`docs/zhen-sha-kill-gate.md 缺少可解析的「${label}」`);
  }
  return Number(raw.replaceAll(',', ''));
}

/** The text of one level-2 section, up to the next level-2 heading. */
function section(heading: string): string {
  const start = DOC.indexOf(heading);
  if (start < 0) {
    throw new Error(`missing section: ${heading}`);
  }
  const end = DOC.indexOf('\n## ', start + heading.length);
  return DOC.slice(start, end === -1 ? undefined : end);
}

const CONCLUSION = /结论[：:]\s*\*{0,2}(M|L)\b/.exec(DOC)?.[1];
const PLAYTEST = section('## 3 人试玩');

describe('zhen-sha kill gate engineering assessment', () => {
  it('measures only build-participating production sources', () => {
    expect(PRODUCTION_FILES).not.toContain('engine.test.ts');
    expect(PRODUCTION_FILES).not.toContain('zhen-sha-view.test.ts');
    expect(PRODUCTION_FILES).not.toContain('kill-gate-doc.test.ts');
    expect(PRODUCTION_FILES.length).toBeGreaterThan(0);
  });

  it('matches the documented prototype file count and line total', () => {
    expect(claimedNumber('生产文件数')).toBe(PRODUCTION_FILES.length);
    expect(claimedNumber('生产行数')).toBe(PRODUCTION_LINES);
    for (const name of PRODUCTION_FILES) {
      expect(DOC).toContain(`\`${name}\``);
    }
  });

  it('lists the registry entry separately from the prototype count', () => {
    expect(DOC).toMatch(/registry\.ts[^\n]*1 行/);
  });

  it('includes the formal engineering assessment sections', () => {
    expect(DOC).toContain('## 工程评估');
    expect(DOC).toContain('### kill gate 原型生产规模（实测）');
    expect(DOC).toContain('### 完整特性规模估算');
    expect(DOC).toContain('### 结论');
  });

  it('states an explicit M or L conclusion against the M review band', () => {
    expect(['M', 'L']).toContain(CONCLUSION);
    expect(DOC).toContain('7–9 个文件');
    expect(DOC).toContain('1,400–2,200 行');
    expect(DOC).toContain('2 个新概念');
  });

  it('keeps the full-feature estimate inside the M band when M is claimed', () => {
    const estimate = /完整特性[^\n]*?(\d+)\s*个生产文件[^\n]*?约\s*([\d,]+)\s*行/.exec(DOC);
    expect(estimate).not.toBeNull();
    if (CONCLUSION === 'M') {
      const files = Number(estimate?.[1]);
      const lines = Number((estimate?.[2] ?? '').replaceAll(',', ''));
      expect(files).toBeGreaterThanOrEqual(7);
      expect(files).toBeLessThanOrEqual(9);
      expect(lines).toBeGreaterThanOrEqual(1400);
      expect(lines).toBeLessThanOrEqual(2200);
    }
  });

  it('lists the two new concepts individually', () => {
    expect(claimedNumber('新概念数')).toBe(2);
    expect(DOC).toContain('固定步长实时弹反判定');
    expect(DOC).toContain('无素材的程序化水墨 Canvas 表现与手势输入');
  });

  it('rules out new physics, audio, 3D and entity pools', () => {
    expect(DOC).toContain('没有新增物理、音频、3D 或实体池');
  });

  it('documents automated and non-automated acceptance surfaces', () => {
    expect(DOC).toContain('### 可自动验收面');
    expect(DOC).toContain('### 不可自动验收面');
    expect(DOC).toContain('3 人盲测试玩');
  });

  it('flags procedural ink as a third-concept sensitivity that forces an L review', () => {
    expect(DOC).toMatch(/程序化水墨[^\n]*第三个新概念[^\n]*按 L 复核/);
  });

  it('links the unexecuted playtest to issue #261 without claiming a pass', () => {
    expect(PLAYTEST).toContain('未执行');
    expect(PLAYTEST).toContain('https://github.com/yeahdongcn-mk2/playground/issues/261');
    expect(PLAYTEST).toContain('不得判定通过');
    expect(PLAYTEST).not.toMatch(/试玩已通过|3 人试玩通过|已完成 3 人试玩/);
  });
});
