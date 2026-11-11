import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOC_COUNT_PATHS,
  DocCountsError,
  parseDocumentedCount,
  parseVitestReport,
  verifyDocCounts,
} from '../../scripts/lib/doc-counts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'check-doc-counts.mjs');

const README_LINE = 'npm run test:unit    # 628 passed（含贪食蛇 27（引擎 23 + 调试 4））';
const FRAMEWORK_LINE =
  '当前提交本地通过：`typecheck`、`lint`、`build`、`check:budget` 通过；`npm run test:unit` 628 passed；`npm run test:e2e` 153 passed（桌面 86 + 手机 36 + WebKit 31）。';
const SNAKE_LINE = '运行：`npm run test:unit`（全仓 628 个用例）。';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'doc-counts-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function docsWithCount(count: number) {
  return [
    {
      path: 'README.md',
      text: `# README\n\nnpm run test:unit    # ${count} passed（含贪食蛇 27）\n`,
    },
    {
      path: 'docs/framework.md',
      text: `当前提交：\`npm run test:unit\` ${count} passed；\`npm run test:e2e\` 153 passed。\n`,
    },
    {
      path: 'docs/snake-design.md',
      text: `运行：\`npm run test:unit\`（全仓 ${count} 个用例）。\n`,
    },
  ];
}

function reportJson(total: number, extra: Record<string, number> = {}): string {
  return JSON.stringify({
    numTotalTests: total,
    numPassedTests: total,
    numFailedTests: 0,
    numPendingTests: 0,
    ...extra,
  });
}

function writeReport(text: string): string {
  const file = join(makeTempDir(), 'vitest-report.json');
  writeFileSync(file, text);
  return file;
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error === undefined ? '' : String(result.error)}`,
  };
}

/** The count currently documented in README.md; the CLI tests derive fixtures from it. */
function committedCount(): number {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  return parseDocumentedCount(readme, 'README.md').count;
}

describe('parseDocumentedCount', () => {
  it('parses the README "N passed" form', () => {
    expect(parseDocumentedCount(README_LINE, 'README.md')).toEqual({ line: 1, count: 628 });
  });

  it('parses the framework "N passed" form with surrounding backticks', () => {
    expect(parseDocumentedCount(FRAMEWORK_LINE, 'docs/framework.md')).toEqual({
      line: 1,
      count: 628,
    });
  });

  it('parses the snake design "全仓 N 个用例" form', () => {
    expect(parseDocumentedCount(SNAKE_LINE, 'docs/snake-design.md')).toEqual({
      line: 1,
      count: 628,
    });
  });

  it('skips earlier command mentions that have no count and reports the real line', () => {
    const text = ['运行 `npm run test:unit` 前先构建。', '', README_LINE, '', SNAKE_LINE].join(
      '\n',
    );

    expect(parseDocumentedCount(text, 'README.md')).toEqual({ line: 3, count: 628 });
  });

  it('throws a DocCountsError naming the file when the count is missing', () => {
    expect(() =>
      parseDocumentedCount('先运行 npm run test:unit 再构建。', 'README.md'),
    ).toThrow(DocCountsError);
    expect(() =>
      parseDocumentedCount('先运行 npm run test:unit 再构建。', 'README.md'),
    ).toThrow(/README\.md: npm run test:unit 同行缺少/);
  });

  it('throws a DocCountsError naming the file when the command is missing', () => {
    expect(() =>
      parseDocumentedCount('npm run test:e2e # 153 passed', 'docs/snake-design.md'),
    ).toThrow(/docs\/snake-design\.md: 找不到 npm run test:unit/);
  });
});

describe('parseVitestReport', () => {
  it('reads numTotalTests and the pass / fail counters', () => {
    expect(parseVitestReport(reportJson(628), 'fixture.json')).toEqual({
      numTotalTests: 628,
      numFailedTests: 0,
      numPassedTests: 628,
      numPendingTests: 0,
    });
  });

  it('rejects invalid JSON with a clear error', () => {
    expect(() => parseVitestReport('not json', 'fixture.json')).toThrow(DocCountsError);
    expect(() => parseVitestReport('not json', 'fixture.json')).toThrow(
      /fixture\.json: 不是合法的 JSON/,
    );
  });

  it('rejects a report without numTotalTests instead of comparing against undefined', () => {
    expect(() => parseVitestReport('{}', 'fixture.json')).toThrow(
      /fixture\.json: 缺少或无效的 numTotalTests 字段/,
    );
  });

  it('rejects a non-integer numTotalTests', () => {
    expect(() => parseVitestReport(reportJson(1.5), 'fixture.json')).toThrow(
      /numTotalTests 字段/,
    );
  });
});

describe('verifyDocCounts', () => {
  it('passes when all three documented counts equal numTotalTests', () => {
    const verification = verifyDocCounts({
      documents: docsWithCount(628),
      reportText: reportJson(628),
    });

    expect(verification.total).toBe(628);
    expect(verification.documented).toEqual([
      { file: 'README.md', line: 3, count: 628 },
      { file: 'docs/framework.md', line: 1, count: 628 },
      { file: 'docs/snake-design.md', line: 1, count: 628 },
    ]);
    expect(verification.problems).toEqual([]);
  });

  it('reports every mismatch with file, line, documented and measured counts', () => {
    const verification = verifyDocCounts({
      documents: docsWithCount(627),
      reportText: reportJson(700),
    });

    expect(verification.problems).toHaveLength(3);
    expect(verification.problems[0]).toMatchObject({
      kind: 'mismatch',
      file: 'README.md',
      line: 3,
      expected: 627,
      actual: 700,
    });
    expect(verification.problems[0]?.reason).toContain('README.md:3: 文档写 627 个用例');
    expect(verification.problems[0]?.reason).toContain('实测 700 个');
    expect(verification.problems[1]?.file).toBe('docs/framework.md');
    expect(verification.problems[2]?.file).toBe('docs/snake-design.md');
  });

  it('reports a document whose count line cannot be parsed', () => {
    const documents = docsWithCount(628);
    documents[2] = { path: 'docs/snake-design.md', text: '运行 `npm run test:unit` 即可。\n' };

    const verification = verifyDocCounts({ documents, reportText: reportJson(628) });

    expect(verification.problems).toHaveLength(1);
    expect(verification.problems[0]).toMatchObject({
      kind: 'missing-count',
      file: 'docs/snake-design.md',
      line: null,
      expected: null,
      actual: 628,
    });
    expect(verification.problems[0]?.reason).toContain('同行缺少');
  });

  it('reports failing tests even when the counts match', () => {
    const verification = verifyDocCounts({
      documents: docsWithCount(628),
      reportText: reportJson(628, { numFailedTests: 2, numPassedTests: 626 }),
      testExitCode: 1,
    });

    expect(verification.problems).toHaveLength(1);
    expect(verification.problems[0]).toMatchObject({ kind: 'tests-failed', actual: 628 });
    expect(verification.problems[0]?.reason).toContain('numFailedTests=2，退出码=1');
  });
});

describe('check-doc-counts CLI', () => {
  it('exits 0 when the committed documents match the report', () => {
    const count = committedCount();
    const report = writeReport(reportJson(count));

    const { status, stdout, stderr } = runCli(['--report', report]);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain('OK:');
    expect(stdout).toContain(`均为 ${count}`);
  });

  it('exits 1 and names every mismatched document with both counts', () => {
    const count = committedCount();
    const measured = count + 5;
    const report = writeReport(reportJson(measured));

    const { status, stdout } = runCli(['--report', report]);

    expect(status).toBe(1);
    expect(stdout).toContain('FAIL:');
    for (const path of DOC_COUNT_PATHS) {
      expect(stdout).toContain(path);
    }
    expect(stdout).toContain(`文档写 ${count} 个用例`);
    expect(stdout).toContain(`实测 ${measured} 个`);
  });

  it('exits 1 when the report records failing tests', () => {
    const count = committedCount();
    const report = writeReport(reportJson(count, { numFailedTests: 1 }));

    const { status, stdout } = runCli(['--report', report]);

    expect(status).toBe(1);
    expect(stdout).toContain('numFailedTests=1');
  });

  it('exits 2 and names the path when --report points at a missing file', () => {
    const report = join(makeTempDir(), 'missing.json');

    const { status, stderr } = runCli(['--report', report]);

    expect(status).toBe(2);
    expect(stderr).toContain('找不到 Vitest JSON 报告');
    expect(stderr).toContain(report);
  });

  it('exits 2 when the report has no numTotalTests field', () => {
    const report = writeReport('{}');

    const { status, stderr } = runCli(['--report', report]);

    expect(status).toBe(2);
    expect(stderr).toContain('numTotalTests');
  });

  it('exits 2 when the report is not valid JSON', () => {
    const report = writeReport('not json');

    const { status, stderr } = runCli(['--report', report]);

    expect(status).toBe(2);
    expect(stderr).toContain('不是合法的 JSON');
  });

  it('exits 0 for --help and -h', () => {
    const long = runCli(['--help']);
    expect(long.status).toBe(0);
    expect(long.stderr).toBe('');
    expect(long.stdout).toContain('Usage: node scripts/check-doc-counts.mjs');
    expect(long.stdout).toContain('--report');

    expect(runCli(['-h']).status).toBe(0);
  });

  it('exits 2 for an unknown option or a missing --report value', () => {
    const unknown = runCli(['--unknown']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown option: --unknown');
    expect(unknown.stderr).toContain('Usage:');

    const missing = runCli(['--report']);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('--report needs a value');
  });
});
