import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const README = read('README.md');
const FRAMEWORK = read('docs/framework.md');
const ADR = read('docs/tech-stack-decision.md');

/** The four files the generated unit-test count may touch. */
const COUNT_PATHS = [
  'README.md',
  'docs/framework.md',
  'docs/snake-design.md',
  'docs/score-baseline.json',
];

/** The body of one section, up to the next heading at the same or a higher level. */
function section(text: string, heading: string, nextHeading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw new Error(`找不到小节：${heading}`);
  }
  const end = text.indexOf(nextHeading, start + heading.length);
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

function readmeCiSection(): string {
  return section(README, '### CI 检查顺序', '\n### ');
}

function frameworkSectionThirteen(): string {
  return section(FRAMEWORK, '## 13. 环境与命令', '\n## ');
}

function adrSectionSeven(): string {
  return section(ADR, '## 7. 本地开发 / 构建 / 测试命令', '\n## ');
}

/** The ordered verify checks documented in the README list. */
function readmeCiCheckOrder(): string[] {
  return [...readmeCiSection().matchAll(/^\d+\. `([^`]+)`$/gm)].map((match) => match[1] ?? '');
}

describe('doc test count documentation', () => {
  it('documents docs:counts:write as the single entry point for the four files', () => {
    const row = commandRow('npm run docs:counts:write');

    expect(row).toContain('唯一入口');
    for (const path of COUNT_PATHS) {
      expect(row, `docs:counts:write 的说明缺少 ${path}`).toContain(path);
    }
    expect(row).toContain('unitTests');
    expect(row).toContain('--report');
    expect(row).toContain('npm run test:unit');
    // The generator only rewrites the measured numbers, so a repeated run is
    // an empty diff; both promises must stay documented.
    expect(row).toContain('只改数字');
    expect(row).toContain('重复跑无 diff');
  });

  it('documents verify:doc-counts as the guard for the three docs and the baseline', () => {
    const row = commandRow('npm run verify:doc-counts');

    expect(row).toContain('三份文档');
    expect(row).toContain('基线');
    expect(row).toContain('unitTests');
    expect(row).toContain('`npm run score`');
  });

  it('keeps the README CI list gate-only and explains generation and sync after it', () => {
    const ciSection = readmeCiSection();
    const order = readmeCiCheckOrder();

    // tests/unit/ci-workflow.test.ts owns the exact list. This assertion only
    // guards the Issue #426 contract: the working-tree generation step is not
    // a gate and must stay outside the numbered list.
    expect(order).toContain('Unit tests');
    expect(order).toContain('Verify doc test counts');
    expect(order).not.toContain('Generate doc test counts');

    expect(ciSection).toContain('Generate doc test counts');
    expect(ciSection).toContain('PR 只生成不提交');
    expect(ciSection).toContain('doc-counts-sync');
    for (const path of COUNT_PATHS) {
      expect(ciSection, `README 的 CI 段缺少计数文件 ${path}`).toContain(path);
    }
    // CI compares the baseline but never commits or updates it; only the
    // working-tree unitTests may be rewritten by the Generate step.
    expect(ciSection).toContain('`--update`');
    expect(ciSection).toContain('CI 不会提交或更新基线');
    expect(ciSection).toContain('`Generate doc test counts` 只改写工作区的 `unitTests`');
  });

  it('drops the stale manual baseline wording from the README', () => {
    for (const stale of [
      '新基线仍由人显式运行',
      '人显式提交',
      '人工提交基线',
      '手改计数',
    ]) {
      expect(README, `README.md 不应再写 ${stale}`).not.toContain(stale);
    }
  });

  it('documents the generated count contract in framework section 13', () => {
    const thirteen = frameworkSectionThirteen();

    expect(thirteen).toContain('npm run docs:counts:write');
    expect(thirteen).toContain('npm run verify:doc-counts');
    expect(thirteen).toContain('Generate doc test counts');
    expect(thirteen).toContain('doc-counts-sync');
    for (const path of COUNT_PATHS) {
      expect(thirteen, `docs/framework.md §13 缺少计数文件 ${path}`).toContain(path);
    }
    // The CI order must name the generation step between Unit tests and the guard.
    expect(thirteen).toContain('`test:unit` → `Generate doc test counts` → `verify:doc-counts`');
    expect(thirteen).toContain('生成产物');
    expect(thirteen).toContain('子任务不再修改');
    expect(thirteen).toContain('`--update`');
  });

  it('documents the generated count contract in ADR section 7', () => {
    const seven = adrSectionSeven();

    expect(seven).toContain('npm run docs:counts:write');
    expect(seven).toContain('npm run verify:doc-counts');
    for (const path of COUNT_PATHS) {
      expect(seven, `docs/tech-stack-decision.md §7 缺少计数文件 ${path}`).toContain(path);
    }
    expect(seven).toContain('生成产物');
    expect(seven).toContain('子任务不再修改计数');
    expect(seven).toContain('`--update`');
    // The README list is the gate contract, so §7 must not claim it mirrors
    // every verify step: Generate doc test counts is a preparation step.
    expect(seven).toContain('门禁步骤');
    expect(seven).toContain('`Generate doc test counts` 是工作区准备步骤，不在该列表中');
  });

  it('does not claim a person commits the generated unit-test baseline', () => {
    for (const [label, text] of [
      ['README.md', README],
      ['docs/framework.md', FRAMEWORK],
      ['docs/tech-stack-decision.md', ADR],
    ] as const) {
      for (const stale of ['新基线仍由人在本地显式提交', '人显式提交', '手改计数']) {
        expect(text, `${label} 不应再写 ${stale}`).not.toContain(stale);
      }
    }
  });
});
