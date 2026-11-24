import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BudgetDocs, BudgetDocsInput } from '../../scripts/lib/budget-docs.mjs';
import {
  BudgetDocsError,
  compareBudgetDocs,
  readBudgetDocs,
} from '../../scripts/lib/budget-docs.mjs';
import type { BudgetReport } from '../../scripts/lib/budget.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const FRAMEWORK = readFileSync(join(ROOT, 'docs', 'framework.md'), 'utf8');

const README_MARKERS = ['Entry JS:', 'All JS chunks:', 'CSS:', 'Zhen Sha view JS:'] as const;
const FRAMEWORK_BULLET = '入口 JS 约';

interface DocumentTexts {
  readme: string;
  framework: string;
}

function currentDocs(): BudgetDocs {
  return readBudgetDocs({ readme: README, framework: FRAMEWORK });
}

function lineIndex(text: string, marker: string): number {
  const index = text.split('\n').findIndex((line) => line.includes(marker));
  if (index < 0) throw new Error(`找不到包含「${marker}」的行`);
  return index;
}

function sourceLine(text: string, marker: string): string {
  return text.split('\n')[lineIndex(text, marker)] ?? '';
}

function removeLine(text: string, marker: string): string {
  const lines = text.split('\n');
  lines.splice(lineIndex(text, marker), 1);
  return lines.join('\n');
}

function duplicateLine(text: string, marker: string): string {
  const lines = text.split('\n');
  const index = lineIndex(text, marker);
  lines.splice(index, 0, lines[index] ?? '');
  return lines.join('\n');
}

function mutateLine(text: string, marker: string, mutate: (line: string) => string): string {
  const lines = text.split('\n');
  const index = lineIndex(text, marker);
  lines[index] = mutate(lines[index] ?? '');
  return lines.join('\n');
}

function expectBudgetDocsError(run: () => unknown, path: string): BudgetDocsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BudgetDocsError);
    const docsError = error as BudgetDocsError;
    expect(docsError.path).toBe(path);
    expect(docsError.message).toContain(path);
    return docsError;
  }
  throw new Error(`预期 readBudgetDocs 抛出 ${path} 的 BudgetDocsError`);
}

function kbToBytes(kb: number): number {
  return Math.round(kb * 1024);
}

/** A report whose measured values render to exactly the documented numbers. */
function reportFrom(docs: BudgetDocs): BudgetReport {
  const zhenShaGzipBytes = kbToBytes(docs.readme.zhenSha.gzipKb);
  return {
    entry: {
      file: 'assets/index-abc123.js',
      bytes: kbToBytes(docs.readme.entry.rawKb),
      gzipBytes: kbToBytes(docs.readme.entry.gzipKb),
    },
    allJs: { files: ['index-abc123.js'], gzipBytes: kbToBytes(docs.readme.allJs.gzipKb) },
    cssGzipBytes: kbToBytes(docs.readme.css.gzipKb),
    zhenSha: {
      chunks: [{ file: docs.readme.zhenSha.file, bytes: 0, gzipBytes: zhenShaGzipBytes }],
      gzipBytes: zhenShaGzipBytes,
    },
    failures: [],
  };
}

/** Change the second capture group of `pattern` by +1 so a doc typo is simulated. */
function bumpCaptured(line: string, pattern: RegExp): string {
  const match = pattern.exec(line);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`无法按 ${String(pattern)} 递增数字：${line}`);
  }
  const next = (Number(match[2]) + 1).toFixed(2);
  return line.replace(pattern, `${match[1]}${next}`);
}

interface MismatchCase {
  name: string;
  path: string;
  field: string;
  mutate: (texts: DocumentTexts) => DocumentTexts;
}

/**
 * Each case edits the real document text rather than the parsed object, so a
 * regex or capture regression in `readBudgetDocs` cannot hide a wrong value.
 */
const MISMATCH_CASES: MismatchCase[] = [
  {
    name: 'README Entry JS raw size',
    path: 'README.md',
    field: 'Entry JS 原始体积',
    mutate: (texts) => ({
      ...texts,
      readme: mutateLine(texts.readme, 'Entry JS:', (line) =>
        bumpCaptured(line, /(Entry JS: )([\d.]+)/),
      ),
    }),
  },
  {
    name: 'README Entry JS gzip size',
    path: 'README.md',
    field: 'Entry JS gzip 体积',
    mutate: (texts) => ({
      ...texts,
      readme: mutateLine(texts.readme, 'Entry JS:', (line) =>
        bumpCaptured(line, /(\()([\d.]+)(?= KB gzip\))/),
      ),
    }),
  },
  {
    name: 'README All JS chunks gzip size',
    path: 'README.md',
    field: 'All JS chunks gzip 体积',
    mutate: (texts) => ({
      ...texts,
      readme: mutateLine(texts.readme, 'All JS chunks:', (line) =>
        bumpCaptured(line, /(All JS chunks: )([\d.]+)/),
      ),
    }),
  },
  {
    name: 'README CSS gzip size',
    path: 'README.md',
    field: 'CSS gzip 体积',
    mutate: (texts) => ({
      ...texts,
      readme: mutateLine(texts.readme, 'CSS:', (line) =>
        bumpCaptured(line, /(CSS: )([\d.]+)/),
      ),
    }),
  },
  {
    name: 'README Zhen Sha chunk file name',
    path: 'README.md',
    field: 'Zhen Sha view JS chunk 文件名',
    mutate: (texts) => ({
      ...texts,
      readme: mutateLine(texts.readme, 'Zhen Sha view JS:', (line) =>
        line.replace(/(Zhen Sha view JS: )\S+\.js/, '$1zhen-sha-view-WRONG.js'),
      ),
    }),
  },
  {
    name: 'README Zhen Sha gzip size',
    path: 'README.md',
    field: 'Zhen Sha view JS gzip 体积',
    mutate: (texts) => ({
      ...texts,
      readme: mutateLine(texts.readme, 'Zhen Sha view JS:', (line) =>
        bumpCaptured(line, /(Zhen Sha view JS: \S+\.js )([\d.]+)/),
      ),
    }),
  },
  {
    name: 'framework section 14 entry gzip size',
    path: 'docs/framework.md',
    field: '第 14 节 入口 JS gzip 体积',
    mutate: (texts) => ({
      ...texts,
      framework: mutateLine(texts.framework, FRAMEWORK_BULLET, (line) =>
        bumpCaptured(line, /(入口 JS 约 )([\d.]+)/),
      ),
    }),
  },
  {
    name: 'framework section 14 all JS gzip size',
    path: 'docs/framework.md',
    field: '第 14 节 全部 JS chunk gzip 体积',
    mutate: (texts) => ({
      ...texts,
      framework: mutateLine(texts.framework, FRAMEWORK_BULLET, (line) =>
        bumpCaptured(line, /(全部 JS chunk 合计 ≤\d+ KB gzip（当前约 )([\d.]+)/),
      ),
    }),
  },
  {
    name: 'framework section 14 Zhen Sha gzip size',
    path: 'docs/framework.md',
    field: '第 14 节 Zhen Sha view JS gzip 体积',
    mutate: (texts) => ({
      ...texts,
      framework: mutateLine(texts.framework, FRAMEWORK_BULLET, (line) =>
        bumpCaptured(line, /(要求合计 ≤\d+ KB gzip（当前约 )([\d.]+)/),
      ),
    }),
  },
];

describe('readBudgetDocs', () => {
  it('parses the four README verification lines', () => {
    const { readme } = currentDocs();
    const entryLine = sourceLine(README, 'Entry JS:');
    const allJsLine = sourceLine(README, 'All JS chunks:');
    const cssLine = sourceLine(README, 'CSS:');
    const zhenShaLine = sourceLine(README, 'Zhen Sha view JS:');

    expect(readme.path).toBe('README.md');
    expect(readme.entry.rawKb).toBeGreaterThan(0);
    expect(readme.entry.gzipKb).toBeGreaterThan(0);
    expect(entryLine).toContain(`${readme.entry.rawKb.toFixed(2)} KB`);
    expect(entryLine).toContain(`${readme.entry.gzipKb.toFixed(2)} KB gzip`);
    expect(readme.entry.rawKb).toBeGreaterThan(readme.entry.gzipKb);

    expect(readme.allJs.gzipKb).toBeGreaterThanOrEqual(readme.entry.gzipKb);
    expect(allJsLine).toContain(`${readme.allJs.gzipKb.toFixed(2)} KB gzip`);

    expect(readme.css.gzipKb).toBeGreaterThan(0);
    expect(cssLine).toContain(`${readme.css.gzipKb.toFixed(2)} KB gzip`);

    expect(readme.zhenSha.file).toMatch(/^zhen-sha-view-.+\.js$/);
    expect(readme.zhenSha.gzipKb).toBeGreaterThan(0);
    expect(readme.zhenSha.gzipKb).toBeLessThanOrEqual(readme.allJs.gzipKb);
    expect(zhenShaLine).toContain(readme.zhenSha.file);
    expect(zhenShaLine).toContain(`${readme.zhenSha.gzipKb.toFixed(2)} KB gzip`);
  });

  it('parses the three gzip values from the unique section 14 bullet', () => {
    const { framework } = currentDocs();
    const line = sourceLine(FRAMEWORK, FRAMEWORK_BULLET);

    expect(framework.path).toBe('docs/framework.md');
    expect(framework.entry.gzipKb).toBeGreaterThan(0);
    expect(line).toContain(`入口 JS 约 ${framework.entry.gzipKb.toFixed(2)} KB gzip`);

    expect(framework.allJs.gzipKb).toBeGreaterThanOrEqual(framework.entry.gzipKb);
    expect(line).toMatch(
      new RegExp(
        `全部 JS chunk 合计 ≤\\d+ KB gzip（当前约 ${framework.allJs.gzipKb.toFixed(2)} KB gzip）`,
      ),
    );

    expect(framework.zhenSha.gzipKb).toBeGreaterThan(0);
    expect(framework.zhenSha.gzipKb).toBeLessThanOrEqual(framework.allJs.gzipKb);
    expect(line).toMatch(
      new RegExp(
        `要求合计 ≤\\d+ KB gzip（当前约 ${framework.zhenSha.gzipKb.toFixed(2)} KB gzip）`,
      ),
    );
  });

  it('parses the current repository documents', () => {
    expect(() => currentDocs()).not.toThrow();
  });

  it('accepts optional backticks around the documented zhen-sha chunk name', () => {
    const readme = mutateLine(README, 'Zhen Sha view JS:', (line) =>
      line.replace(/(Zhen Sha view JS: )(\S+\.js)/, '$1`$2`'),
    );

    const docs = readBudgetDocs({ readme, framework: FRAMEWORK });

    expect(docs.readme.zhenSha.file).toBe(currentDocs().readme.zhenSha.file);
  });

  it('keeps the README and framework measurements in sync', () => {
    const { readme, framework } = currentDocs();

    expect(framework.entry.gzipKb).toBe(readme.entry.gzipKb);
    expect(framework.allJs.gzipKb).toBe(readme.allJs.gzipKb);
    expect(framework.zhenSha.gzipKb).toBe(readme.zhenSha.gzipKb);
  });
});

describe('compareBudgetDocs', () => {
  it('reports no failures when the current docs match the measured report', () => {
    const docs = currentDocs();

    expect(compareBudgetDocs(docs, reportFrom(docs))).toEqual([]);
  });

  for (const testCase of MISMATCH_CASES) {
    it(`reports ${testCase.name} as a failure`, () => {
      const pristine = currentDocs();
      const report = reportFrom(pristine);
      const docs = readBudgetDocs(testCase.mutate({ readme: README, framework: FRAMEWORK }));

      const failures = compareBudgetDocs(docs, report);

      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain(testCase.path);
      expect(failures[0]).toContain(testCase.field);
      expect(failures[0]).toContain('文档写');
      expect(failures[0]).toContain('实测');
    });
  }

  it('names both chunk filenames when the zhen-sha chunk name is wrong', () => {
    const pristine = currentDocs();
    const report = reportFrom(pristine);
    const measuredFile = report.zhenSha.chunks[0]?.file;
    expect(measuredFile).toBeDefined();
    const docs = readBudgetDocs({
      readme: mutateLine(README, 'Zhen Sha view JS:', (line) =>
        line.replace(/(Zhen Sha view JS: )\S+\.js/, '$1zhen-sha-view-WRONG.js'),
      ),
      framework: FRAMEWORK,
    });

    const failures = compareBudgetDocs(docs, report);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('zhen-sha-view-WRONG.js');
    expect(failures[0]).toContain(measuredFile ?? '');
  });

  it('fails when the measured report has no zhen-sha view chunk', () => {
    const docs = currentDocs();
    const report = reportFrom(docs);
    report.zhenSha = { chunks: [], gzipBytes: 0 };

    const failures = compareBudgetDocs(docs, report);

    expect(failures.some((failure) => failure.includes('没有 zhen-sha-view 产物'))).toBe(true);
  });

  it('fails when the measured report has several zhen-sha view chunks', () => {
    const docs = currentDocs();
    const report = reportFrom(docs);
    report.zhenSha = {
      chunks: [
        { file: 'zhen-sha-view-AAA111.js', bytes: 0, gzipBytes: 1 },
        { file: 'zhen-sha-view-BBB222.js', bytes: 0, gzipBytes: 2 },
      ],
      gzipBytes: report.zhenSha.gzipBytes,
    };

    const failures = compareBudgetDocs(docs, report);

    const chunkFailure = failures.find((failure) =>
      failure.includes('只记录一个 chunk'),
    );
    expect(chunkFailure).toBeDefined();
    expect(chunkFailure).toContain('zhen-sha-view-AAA111.js');
    expect(chunkFailure).toContain('zhen-sha-view-BBB222.js');
  });
});

describe('readBudgetDocs malformed documents', () => {
  for (const marker of README_MARKERS) {
    it(`throws with the README path when the ${marker} line is missing`, () => {
      const error = expectBudgetDocsError(
        () => readBudgetDocs({ readme: removeLine(README, marker), framework: FRAMEWORK }),
        'README.md',
      );

      expect(error.message).toContain(marker);
    });

    it(`throws with the README path when the ${marker} line is duplicated`, () => {
      const error = expectBudgetDocsError(
        () => readBudgetDocs({ readme: duplicateLine(README, marker), framework: FRAMEWORK }),
        'README.md',
      );

      expect(error.message).toContain('实际 2 行');
    });
  }

  it('throws with the README path when the verification section is missing', () => {
    const error = expectBudgetDocsError(
      () => readBudgetDocs({ readme: removeLine(README, '## 验证'), framework: FRAMEWORK }),
      'README.md',
    );

    expect(error.message).toContain('## 验证');
  });

  it('throws with the README path when the verification section is duplicated', () => {
    const error = expectBudgetDocsError(
      () => readBudgetDocs({ readme: duplicateLine(README, '## 验证'), framework: FRAMEWORK }),
      'README.md',
    );

    expect(error.message).toContain('2 个');
  });

  it('ends the verification section at an indented level-2 heading', () => {
    const readme = `${README.replace('\n## 已知限制', '\n  ## 已知限制')}\n# Entry JS: 99.99 KB (99.99 KB gzip)\n`;

    expect(() => readBudgetDocs({ readme, framework: FRAMEWORK })).not.toThrow();
  });

  it('throws with the framework path when section 14 is missing', () => {
    const error = expectBudgetDocsError(
      () => readBudgetDocs({ readme: README, framework: removeLine(FRAMEWORK, '## 14.') }),
      'docs/framework.md',
    );

    expect(error.message).toContain('第 14 节');
  });

  it('throws with the framework path when section 14 is duplicated', () => {
    const error = expectBudgetDocsError(
      () => readBudgetDocs({ readme: README, framework: duplicateLine(FRAMEWORK, '## 14.') }),
      'docs/framework.md',
    );

    expect(error.message).toContain('2 个');
  });

  it('throws with the framework path when the unique budget bullet is missing', () => {
    const error = expectBudgetDocsError(
      () =>
        readBudgetDocs({
          readme: README,
          framework: removeLine(FRAMEWORK, FRAMEWORK_BULLET),
        }),
      'docs/framework.md',
    );

    expect(error.message).toContain(FRAMEWORK_BULLET);
  });

  it('throws with the framework path when the budget bullet is duplicated', () => {
    const error = expectBudgetDocsError(
      () =>
        readBudgetDocs({
          readme: README,
          framework: duplicateLine(FRAMEWORK, FRAMEWORK_BULLET),
        }),
      'docs/framework.md',
    );

    expect(error.message).toContain('实际 2 行');
  });

  it('throws when one framework line repeats the budget marker', () => {
    const framework = mutateLine(FRAMEWORK, FRAMEWORK_BULLET, (line) =>
      `${line} 另一个入口 JS 约 99.99 KB gzip`,
    );

    const error = expectBudgetDocsError(
      () => readBudgetDocs({ readme: README, framework }),
      'docs/framework.md',
    );

    expect(error.message).toContain('出现了 2 次');
  });

  it('throws with the README path when an Entry JS line does not match the format', () => {
    const readme = mutateLine(README, 'Entry JS:', (line) =>
      line.replace(/\([\d.]+ KB gzip\)/, '(not-a-number KB gzip)'),
    );

    const error = expectBudgetDocsError(
      () => readBudgetDocs({ readme, framework: FRAMEWORK }),
      'README.md',
    );

    expect(error.message).toContain('Entry JS');
  });

  it('throws a clear error when README records a multi-chunk zhen-sha block', () => {
    const readme = `${mutateLine(README, 'Zhen Sha view JS:', (line) =>
      line.replace(/Zhen Sha view JS: .*$/, 'Zhen Sha view JS:'),
    )}\n  zhen-sha-view-AAA111.js: 1.00 KB gzip\n  total: 1.00 KB gzip\n`;

    const error = expectBudgetDocsError(
      () => readBudgetDocs({ readme, framework: FRAMEWORK }),
      'README.md',
    );

    expect(error.message).toContain('单个 chunk');
  });

  it('throws with the framework path when a section 14 number cannot be parsed', () => {
    const framework = mutateLine(FRAMEWORK, FRAMEWORK_BULLET, (line) =>
      line.replace(/当前约 [\d.]+/, '当前约 很多'),
    );

    const error = expectBudgetDocsError(
      () => readBudgetDocs({ readme: README, framework }),
      'docs/framework.md',
    );

    expect(error.message).toContain('全部 JS chunk');
  });

  it('throws with the document path when the input is not text', () => {
    const error = expectBudgetDocsError(
      () =>
        readBudgetDocs({
          readme: 42,
          framework: FRAMEWORK,
        } as unknown as BudgetDocsInput),
      'README.md',
    );

    expect(error.message).toContain('string');
  });
});
