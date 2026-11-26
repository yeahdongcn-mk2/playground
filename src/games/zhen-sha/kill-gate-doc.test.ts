import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOC = readFileSync(join(ROOT, 'docs', 'zhen-sha-kill-gate.md'), 'utf8');

/**
 * Production size frozen at baseline 43c9ab1, as `{ name, lines }`.
 * The historical assessment must not follow the current working tree; the
 * rolling snapshot owns the current production size instead.
 */
const BASELINE_FILES = [
  { name: 'engine.ts', lines: 457 },
  { name: 'index.ts', lines: 29 },
  { name: 'zhen-sha-view.ts', lines: 676 },
  { name: 'zhen-sha.css', lines: 254 },
] as const;

const PRODUCTION_FILES: string[] = BASELINE_FILES.map((file) => file.name).sort();
const PRODUCTION_LINES = BASELINE_FILES.reduce((total, file) => total + file.lines, 0);

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

/** The text of one level-3 section, up to the next level-2 or level-3 heading. */
function level3Section(heading: string): string {
  const start = DOC.indexOf(heading);
  if (start < 0) {
    throw new Error(`missing section: ${heading}`);
  }
  const after = start + heading.length;
  const ends = [DOC.indexOf('\n### ', after), DOC.indexOf('\n## ', after)].filter(
    (offset) => offset !== -1,
  );
  const end = ends.length === 0 ? -1 : Math.min(...ends);
  return DOC.slice(start, end === -1 ? undefined : end);
}

/** Parse a table cell holding a plain or bold number, e.g. `457` or `**1,416**`. */
function parseCellNumber(cell: string): number {
  const raw = /\d[\d,]*/.exec(cell)?.[0];
  if (raw === undefined) {
    throw new Error(`无法解析原型表格中的数字：${cell}`);
  }
  return Number(raw.replaceAll(',', ''));
}

/** One `| 文件 | 行数 |` row of the prototype measurement table. */
interface PrototypeRow {
  name: string;
  lines: number;
}

/** Parse the prototype "实测" table, including its `合计` row. */
function parsePrototypeTable(): { files: PrototypeRow[]; total: number } {
  const subsection = section('### kill gate 原型生产规模（实测）');
  const nextHeading = subsection.indexOf('\n### ');
  const block = nextHeading === -1 ? subsection : subsection.slice(0, nextHeading);
  const rows = block
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  const files: PrototypeRow[] = [];
  let total: number | undefined;

  for (const cells of rows) {
    const nameCell = cells[0];
    const linesCell = cells[1];
    if (nameCell === undefined || linesCell === undefined) {
      throw new Error(`无法解析原型表格行：${cells.join(' | ')}`);
    }
    if (nameCell === '生产文件' || nameCell.startsWith('---')) {
      continue;
    }
    const lines = parseCellNumber(linesCell);
    if (nameCell.replaceAll('*', '') === '合计') {
      total = lines;
      continue;
    }
    files.push({ name: nameCell.replaceAll('`', '').trim(), lines });
  }

  if (total === undefined) {
    throw new Error('原型表格缺少「合计」行');
  }
  return { files, total };
}

/** A `原型 <number>` metric claimed by the conclusion's bullet list. */
function conclusionPrototypeNumber(pattern: RegExp, label: string): number {
  const raw = pattern.exec(section('### 结论'))?.[1];
  if (raw === undefined) {
    throw new Error(`docs/zhen-sha-kill-gate.md 的结论段缺少可解析的「${label}」`);
  }
  return Number(raw.replaceAll(',', ''));
}

/** The explicit `结论：M` / `结论：L` claim, rejecting an ambiguous `M 或 L`. */
function parseConclusion(text: string): string | undefined {
  const match = /结论[：:]\s*\*{0,2}([^\n*。.]*?)\s*\*{0,2}\s*(?:[。.]|$)/m.exec(text);
  const claim = match?.[1]?.trim();
  return claim === 'M' || claim === 'L' ? claim : undefined;
}

const CONCLUSION = parseConclusion(DOC);
const PLAYTEST = section('## 3 人试玩');

describe('zhen-sha kill gate engineering assessment', () => {
  it('keeps the 43c9ab1 production set frozen', () => {
    // 冻结基线契约：只允许 43c9ab1 的四个生产文件，测试文件与基线后新增的
    // bosses.ts / settlement.ts / boss-chart.ts 等都不会进入这个集合。
    expect(PRODUCTION_FILES).toEqual(['engine.ts', 'index.ts', 'zhen-sha-view.ts', 'zhen-sha.css']);
    expect(PRODUCTION_LINES).toBe(1416);
  });

  it('matches the documented prototype file count and line total', () => {
    expect(claimedNumber('生产文件数')).toBe(PRODUCTION_FILES.length);
    expect(claimedNumber('生产行数')).toBe(PRODUCTION_LINES);
    for (const name of PRODUCTION_FILES) {
      expect(DOC).toContain(`\`${name}\``);
    }
    // The conclusion repeats the prototype size in prose as well.
    expect(DOC).toContain(`原型 ${PRODUCTION_FILES.length} 个`);
    expect(DOC).toContain(`原型 ${PRODUCTION_LINES.toLocaleString('en-US')} 行`);
  });

  it('matches the documented prototype per-file table and total', () => {
    const table = parsePrototypeTable();
    expect(table.files.map((row) => row.name).sort()).toEqual(PRODUCTION_FILES);
    for (const row of table.files) {
      const frozen = BASELINE_FILES.find((file) => file.name === row.name);
      expect(frozen, `原型表格中的 ${row.name} 必须属于 43c9ab1 冻结基线`).toBeDefined();
      expect(frozen?.lines, `原型表格中 ${row.name} 的行数应等于 43c9ab1 冻结值`).toBe(row.lines);
    }
    expect(table.total).toBe(PRODUCTION_LINES);
  });

  it('matches the conclusion bullets to the measured prototype size', () => {
    expect(
      conclusionPrototypeNumber(/文件数[：:]\s*原型\s*([\d,]+)\s*个/, '文件数'),
    ).toBe(PRODUCTION_FILES.length);
    expect(
      conclusionPrototypeNumber(/行数[：:]\s*原型\s*([\d,]+)\s*行/, '行数'),
    ).toBe(PRODUCTION_LINES);
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

  it('points baseline-after progress at the rolling production size snapshot', () => {
    const progress = level3Section('### 基线后进展');

    // The only source of truth for the current size is the generated snapshot;
    // the document must name the pointer and the command that refreshes it.
    expect(progress).toContain('docs/zhen-sha-production-size.json');
    expect(progress).toContain('npm run sync:zhen-sha-size');
    expect(progress).toContain('tests/unit/zhen-sha-size.test.ts');
    // The rolling caliber counts test-only sources, unlike the frozen table.
    expect(progress).toMatch(/包含仅被测试引用的[^\n]*boss-chart-adapter\.ts/);
    expect(progress).toContain('43c9ab1');
    expect(progress).toContain('4 文件 / 1,416 行');
    // #417 keeps tracking the over-band re-estimate; the L condition stays.
    expect(progress).toContain('https://github.com/yeahdongcn-mk2/playground/issues/417');
    expect(progress).toMatch(/L 条件/);
    // No hand-maintained current numbers that change with every engine PR.
    expect(progress).not.toContain('3,375');
    expect(progress).not.toContain('1,175');
    expect(progress).not.toContain('8 个文件');
    // The task also removes the 2,229 / 2,288 hand-calculated aggregations;
    // adding either number back must fail this assertion.
    expect(progress).not.toContain('2,229');
    expect(progress).not.toContain('2,288');
    expect(progress).not.toMatch(
      /`[^`\n]+\.(?:ts|css)`[：:]\s*\d[\d,]*(?:\s*→\s*\d[\d,]*)?\s*行/,
    );
    expect(progress).not.toContain('不计入当前生产规模');
  });

  it('qualifies the test-only exclusion caliber as frozen to 43c9ab1', () => {
    const caliber = level3Section('### 评估口径');
    expect(caliber).toContain('43c9ab1');
    expect(caliber).toContain('docs/zhen-sha-production-size.json');
    expect(caliber).toContain('npm run sync:zhen-sha-size');
    expect(caliber).toMatch(/仅被测试引用的[^\n]*仍计入/);
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
    // #249 requires reduced motion; the motion layer is now implemented and
    // guarded by motion.test.ts, so the document must say so.
    expect(DOC).toContain('prefers-reduced-motion');
    expect(DOC).toContain('motion.test.ts');
    expect(DOC).not.toContain('仍未实现、未测');
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
