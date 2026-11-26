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
    throw new Error(`无法解析表格中的数字：${cell}`);
  }
  return Number(raw.replaceAll(',', ''));
}

/** One `| 文件 | 行数 |` row of a size table. */
interface SizeRow {
  name: string;
  lines: number;
}

/** Cells of the `| … |` rows in one table block, trimmed. */
function tableCells(block: string): string[][] {
  return block
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

/** A GFM table separator cell such as `---`, `:---` or `---:`. */
function isSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell.replaceAll(' ', ''));
}

/** Parse a size table with a `合计` row into its rows and claimed total. */
function parseSizeTable(block: string, missingTotal: string): { rows: SizeRow[]; total: number } {
  const rows: SizeRow[] = [];
  let total: number | undefined;

  for (const cells of tableCells(block)) {
    const nameCell = cells[0];
    const linesCell = cells[1];
    if (nameCell === undefined || linesCell === undefined) {
      throw new Error(`无法解析表格行：${cells.join(' | ')}`);
    }
    if (nameCell === '生产文件' || isSeparatorCell(nameCell)) {
      continue;
    }
    const lines = parseCellNumber(linesCell);
    if (nameCell.replaceAll('*', '') === '合计') {
      total = lines;
      continue;
    }
    rows.push({ name: nameCell.replaceAll('`', '').trim(), lines });
  }

  if (total === undefined) {
    throw new Error(missingTotal);
  }
  return { rows, total };
}

/** Parse the prototype "实测" table, including its `合计` row. */
function parsePrototypeTable(): { rows: SizeRow[]; total: number } {
  return parseSizeTable(
    level3Section('### kill gate 原型生产规模（实测）'),
    '原型表格缺少「合计」行',
  );
}

/**
 * engine.ts as measured with `wc -l` on 2026-11-27 at commit `4ecc0ce`, the
 * revision the #417 re-estimate was recorded against. A stable constant, not a
 * read of the rolling `docs/zhen-sha-production-size.json` snapshot, so later
 * engine growth cannot invalidate the historical estimate.
 */
const ENGINE_MEASURED_LINES = 678;

/** Line ceiling of #250's M review band. */
const M_LINE_CEILING = 2200;

/** Parse the full-feature "估算" table, including its `合计` row. */
function parseEstimateTable(): { rows: SizeRow[]; total: number } {
  return parseSizeTable(
    level3Section('### 完整特性规模估算'),
    '完整特性估算表缺少「合计」行',
  );
}

/** A number claimed by the conclusion's bullet list or prose. */
function conclusionNumber(pattern: RegExp, label: string): number {
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
    expect(table.rows.map((row) => row.name).sort()).toEqual(PRODUCTION_FILES);
    for (const row of table.rows) {
      const frozen = BASELINE_FILES.find((file) => file.name === row.name);
      expect(frozen, `原型表格中的 ${row.name} 必须属于 43c9ab1 冻结基线`).toBeDefined();
      expect(frozen?.lines, `原型表格中 ${row.name} 的行数应等于 43c9ab1 冻结值`).toBe(row.lines);
    }
    expect(table.total).toBe(PRODUCTION_LINES);
  });

  it('matches the conclusion bullets to the measured prototype size', () => {
    expect(
      conclusionNumber(/文件数[：:]\s*原型\s*([\d,]+)\s*个/, '文件数'),
    ).toBe(PRODUCTION_FILES.length);
    expect(
      conclusionNumber(/行数[：:]\s*原型\s*([\d,]+)\s*行/, '行数'),
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
    // #417 now records the completed over-band re-estimate and its L conclusion.
    expect(progress).toContain('https://github.com/yeahdongcn-mk2/playground/issues/417');
    expect(progress).toContain('重估已完成');
    expect(progress).toMatch(/结论为 L/);
    expect(progress).not.toContain('超限重估由');
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

  it('derives the full-feature estimate total from its rows', () => {
    const table = parseEstimateTable();
    expect(table.rows.length).toBeGreaterThan(0);
    const sum = table.rows.reduce((total, row) => total + row.lines, 0);
    expect(table.total).toBe(sum);
  });

  it('matches the full-feature estimate prose and conclusion to its table', () => {
    const table = parseEstimateTable();
    const estimate = /完整特性[^\n]*?(\d+)\s*个生产文件[^\n]*?约\s*([\d,]+)\s*行/.exec(DOC);
    expect(estimate).not.toBeNull();
    expect(Number(estimate?.[1])).toBe(table.rows.length);
    expect(Number((estimate?.[2] ?? '').replaceAll(',', ''))).toBe(table.total);
    // The conclusion's bullet and paragraph repeat the same numbers, so a stale
    // 2,154 there cannot hide behind an updated table.
    expect(
      conclusionNumber(/完整特性估算约\s*([\d,]+)\s*行/, '完整特性估算行数'),
    ).toBe(table.total);
    expect(section('### 结论')).toContain(`完整特性估算 ${table.rows.length} 个`);
  });

  it('moves the boss-chart interface lines out of the bosses estimate', () => {
    const table = parseEstimateTable();
    const bosses = table.rows.find((row) => row.name === 'bosses.ts');
    const bossChart = table.rows.find((row) => row.name === 'boss-chart.ts');
    expect(bosses, '完整特性估算表必须列出 bosses.ts').toBeDefined();
    expect(bossChart, '完整特性估算表必须列出 boss-chart.ts').toBeDefined();
    // #407's 59 interface lines leave bosses.ts's 300-line estimate for the
    // independently counted file; adding them to both would double count them.
    expect((bosses?.lines ?? 0) + (bossChart?.lines ?? 0)).toBe(300);
  });

  it('keeps the engine estimate at or above the recorded measurement', () => {
    // #417: the old 580-line estimate was below the measured engine (678 lines
    // at 4ecc0ce), so it must not come back without new counter-evidence.
    const engine = parseEstimateTable().rows.find((row) => row.name === 'engine.ts');
    expect(engine, '完整特性估算表必须列出 engine.ts').toBeDefined();
    expect(engine?.lines).toBeGreaterThanOrEqual(ENGINE_MEASURED_LINES);
    // The document records the same value, date and commit the constant freezes.
    expect(DOC).toContain(`${ENGINE_MEASURED_LINES} 行`);
    expect(DOC).toContain('2026-11-27');
    expect(DOC).toContain('4ecc0ce');
  });

  it('states a conclusion consistent with the 2,200-line ceiling', () => {
    expect(['M', 'L']).toContain(CONCLUSION);
    const table = parseEstimateTable();
    if (CONCLUSION === 'M') {
      expect(table.rows.length).toBeGreaterThanOrEqual(7);
      expect(table.rows.length).toBeLessThanOrEqual(9);
      expect(table.total).toBeGreaterThanOrEqual(1400);
      expect(table.total).toBeLessThanOrEqual(M_LINE_CEILING);
    } else {
      // This document still claims two concepts, so L must come from size.
      expect(table.total).toBeGreaterThan(M_LINE_CEILING);
    }
    // An L conclusion must not leave contradictory M prose behind.
    if (CONCLUSION === 'L') {
      expect(DOC).not.toMatch(/结论[：:]\s*\*{0,2}M\b/);
      expect(DOC).not.toContain('按 M 规模继续');
    }
  });

  it('dispositions merged and open follow-ups under the L conclusion', () => {
    const conclusion = section('### 结论');
    expect(conclusion).toContain('结论：L');
    expect(conclusion).toContain('不进入后续卡');
    expect(conclusion).toContain('#246–#249 不回退');
    expect(conclusion).toContain('只回填真人验收记录');
    expect(conclusion).toContain('不属于新的实现卡');
    expect(conclusion).toContain('https://github.com/yeahdongcn-mk2/playground/issues/261');
    expect(conclusion).toContain('https://github.com/yeahdongcn-mk2/playground/issues/401');
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
