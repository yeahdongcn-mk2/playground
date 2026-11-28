import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASELINE_RELATIVE_PATH,
  DOC_COUNT_PATHS,
  DocCountsError,
  cleanupTempDirs,
  parseDocumentedCount,
  parseVitestReport,
  planDocCountWrites,
  rewriteBaselineUnitTests,
  rewriteDocumentedCount,
  verifyDocCounts,
} from '../../scripts/lib/doc-counts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'check-doc-counts.mjs');
const SYNC_CLI = join(ROOT, 'scripts', 'sync-doc-counts.mjs');
const PACKAGE_PATH = join(ROOT, 'package.json');

const README_LINE = 'npm run test:unit    # 1376 passed（含贪食蛇 27（引擎 23 + 调试 4））';
const FRAMEWORK_LINE =
  '当前提交本地通过：`typecheck`、`lint`、`build`、`check:budget` 通过；`npm run test:unit` 1376 passed；`npm run test:e2e` 155 passed（桌面 87 + 手机 36 + WebKit 32）。';
const SNAKE_LINE = '运行：`npm run test:unit`（全仓 1376 个用例）。';

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

function runCli(
  args: string[],
  env?: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: env === undefined ? process.env : { ...process.env, ...env },
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

/**
 * A deliberately non-canonical JSON fixture: 4-space indentation, a different
 * key order, and extra spaces around the `unitTests` colon. The writer must
 * preserve these bytes, so a `JSON.stringify(parsed, null, 2)` implementation
 * cannot pass the byte-for-byte assertions below.
 */
function baselineFixture(count: number): string {
  return [
    '{',
    '    "checks": {',
    '        "verify:doc-counts": "pass",',
    '        "lint": "pass"',
    '    },',
    `    "unitTests" :   ${count},`,
    '    "totalJsGzipBytes": 422390,',
    '    "entryGzipBytes": 11889',
    '}',
    '',
  ].join('\n');
}

/** Materialize the four files the write CLI manages in an isolated directory. */
function writeFixtureProject(dir: string, count: number): void {
  mkdirSync(join(dir, 'docs'), { recursive: true });
  for (const document of docsWithCount(count)) {
    writeFileSync(join(dir, document.path), document.text);
  }
  writeFileSync(join(dir, BASELINE_RELATIVE_PATH), baselineFixture(count));
}

function readFixtureProject(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const path of [...DOC_COUNT_PATHS, BASELINE_RELATIVE_PATH]) {
    snapshot[path] = readFileSync(join(dir, path), 'utf8');
  }
  return snapshot;
}

function changedLineIndexes(before: string, after: string): number[] {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  expect(afterLines).toHaveLength(beforeLines.length);
  const changed: number[] = [];
  for (let index = 0; index < beforeLines.length; index += 1) {
    if (beforeLines[index] !== afterLines[index]) changed.push(index);
  }
  return changed;
}

function runSyncCli(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SYNC_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error === undefined ? '' : String(result.error)}`,
  };
}

/** Put an executable `npm` stub first on PATH for the no-`--report` run path. */
function writeFakeNpm(script: string): string {
  const dir = makeTempDir();
  const file = join(dir, 'npm');
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return dir;
}

function pathWith(binDir: string): string {
  return `${binDir}:${process.env.PATH ?? ''}`;
}

describe('parseDocumentedCount', () => {
  it('parses the README "N passed" form', () => {
    expect(parseDocumentedCount(README_LINE, 'README.md')).toEqual({ line: 1, count: 1376 });
  });

  it('parses the framework "N passed" form with surrounding backticks', () => {
    expect(parseDocumentedCount(FRAMEWORK_LINE, 'docs/framework.md')).toEqual({
      line: 1,
      count: 1376,
    });
  });

  it('parses the snake design "全仓 N 个用例" form', () => {
    expect(parseDocumentedCount(SNAKE_LINE, 'docs/snake-design.md')).toEqual({
      line: 1,
      count: 1376,
    });
  });

  it('skips earlier command mentions that have no count and reports the real line', () => {
    const text = ['运行 `npm run test:unit` 前先构建。', '', README_LINE, '', SNAKE_LINE].join(
      '\n',
    );

    expect(parseDocumentedCount(text, 'README.md')).toEqual({ line: 3, count: 1376 });
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

  it.skipIf(process.platform === 'win32')(
    'exits 2 with an error, not an uncaught stack, when the temporary directory cannot be created',
    () => {
      const missingTmp = join(makeTempDir(), 'missing', 'tmp');

      const { status, stdout, stderr } = runCli([], { TMPDIR: missingTmp });

      expect(status).toBe(2);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/^error: 无法创建临时目录：/);
      expect(stderr).not.toMatch(/\n\s+at /);
      expect(stderr).not.toContain('node:internal');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not create a temporary directory on the --report path',
    () => {
      const count = committedCount();
      const report = writeReport(reportJson(count));
      const missingTmp = join(makeTempDir(), 'missing', 'tmp');

      const { status, stdout, stderr } = runCli(['--report', report], { TMPDIR: missingTmp });

      expect(stderr).toBe('');
      expect(status).toBe(0);
      expect(stdout).toContain('OK:');
    },
  );
});

describe('cleanupTempDirs', () => {
  it('removes every directory recursively and forcefully', () => {
    const calls: Array<[string, { recursive: boolean; force: boolean }]> = [];

    cleanupTempDirs(['/tmp/doc-counts-a', '/tmp/doc-counts-b'], (path, options) => {
      calls.push([path, options]);
    });

    expect(calls).toEqual([
      ['/tmp/doc-counts-a', { recursive: true, force: true }],
      ['/tmp/doc-counts-b', { recursive: true, force: true }],
    ]);
  });

  it('removes a real directory with rmSync by default', () => {
    const dir = makeTempDir();
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'vitest-report.json'), '{}');

    cleanupTempDirs([dir]);

    expect(existsSync(dir)).toBe(false);
  });

  it('swallows a failing removal so cleanup cannot overwrite the exit code', () => {
    const attempted: string[] = [];
    let exitCode = 0;

    try {
      cleanupTempDirs(['/tmp/doc-counts-a', '/tmp/doc-counts-b'], (path) => {
        attempted.push(path);
        throw new Error('EACCES: permission denied');
      });
    } catch {
      exitCode = 1;
    }

    // The finally block keeps running after the first failure, and a cleanup
    // error never escapes to replace the code main already chose.
    expect(attempted).toEqual(['/tmp/doc-counts-a', '/tmp/doc-counts-b']);
    expect(exitCode).toBe(0);
  });
});

describe('rewriteDocumentedCount', () => {
  it('rewrites the README "N passed" form and leaves the rest of the line alone', () => {
    expect(rewriteDocumentedCount(README_LINE, 1400, 'README.md')).toBe(
      README_LINE.replace('1376', '1400'),
    );
  });

  it('rewrites the framework "N passed" form without touching the e2e count', () => {
    const rewritten = rewriteDocumentedCount(FRAMEWORK_LINE, 1400, 'docs/framework.md');

    expect(rewritten).toBe(FRAMEWORK_LINE.replace('1376', '1400'));
    expect(rewritten).toContain('155 passed');
  });

  it('rewrites the snake design "全仓 N 个用例" form', () => {
    expect(rewriteDocumentedCount(SNAKE_LINE, 1400, 'docs/snake-design.md')).toBe(
      SNAKE_LINE.replace('1376', '1400'),
    );
  });

  it('returns the original text when the count already matches', () => {
    expect(rewriteDocumentedCount(README_LINE, 1376, 'README.md')).toBe(README_LINE);
  });

  it('is idempotent: rewriting the result with the same total changes nothing', () => {
    const once = rewriteDocumentedCount(README_LINE, 1400, 'README.md');

    expect(rewriteDocumentedCount(once, 1400, 'README.md')).toBe(once);
  });

  it('preserves CRLF line endings and the trailing newline', () => {
    const text = '# Title\r\n\r\nnpm run test:unit # 12 passed\r\nend\r\n';

    expect(rewriteDocumentedCount(text, 13, 'README.md')).toBe(
      '# Title\r\n\r\nnpm run test:unit # 13 passed\r\nend\r\n',
    );
  });

  it('throws a DocCountsError when the count line is missing', () => {
    expect(() => rewriteDocumentedCount('先运行 npm run test:unit。', 1400, 'README.md')).toThrow(
      /README\.md: npm run test:unit 同行缺少/,
    );
  });

  it('rejects a non-integer or negative total', () => {
    expect(() => rewriteDocumentedCount(README_LINE, 1.5, 'README.md')).toThrow(DocCountsError);
    expect(() => rewriteDocumentedCount(README_LINE, -1, 'README.md')).toThrow(
      /计数必须是 >= 0 的整数/,
    );
    expect(() => rewriteDocumentedCount(README_LINE, 1e21, 'README.md')).toThrow(
      /计数必须是 >= 0 的整数/,
    );
    expect(() =>
      rewriteDocumentedCount(README_LINE, '12' as unknown as number, 'README.md'),
    ).toThrow(DocCountsError);
  });
});

describe('rewriteBaselineUnitTests', () => {
  it('defines the baseline path used by both the writer and the CLI', () => {
    expect(BASELINE_RELATIVE_PATH).toBe('docs/score-baseline.json');
  });

  it('replaces only the unitTests number and keeps the other bytes', () => {
    const before = baselineFixture(1280);

    const after = rewriteBaselineUnitTests(before, 1290);

    expect(after).toBe(baselineFixture(1290));
    expect(after.endsWith('\n')).toBe(true);
    expect(JSON.parse(after)).toEqual({ ...JSON.parse(before), unitTests: 1290 });
  });

  it('returns the original text when unitTests already matches', () => {
    const before = baselineFixture(1280);

    expect(rewriteBaselineUnitTests(before, 1280)).toBe(before);
  });

  it('is idempotent: rewriting the result with the same total changes nothing', () => {
    const once = rewriteBaselineUnitTests(baselineFixture(1280), 1290);

    expect(rewriteBaselineUnitTests(once, 1290)).toBe(once);
  });

  it('throws a DocCountsError when unitTests is missing', () => {
    expect(() => rewriteBaselineUnitTests('{\n  "entryGzipBytes": 1\n}\n', 1290)).toThrow(
      /缺少 unitTests 字段/,
    );
  });

  it('throws a DocCountsError for invalid JSON', () => {
    expect(() => rewriteBaselineUnitTests('not json', 1290)).toThrow(/不是合法的 JSON/);
  });

  it('rejects a non-integer or non-numeric unitTests value', () => {
    expect(() => rewriteBaselineUnitTests('{"unitTests": 1.5}\n', 1290)).toThrow(
      /unitTests 必须是 >= 0 的整数/,
    );
    expect(() => rewriteBaselineUnitTests('{"unitTests": "1280"}\n', 1290)).toThrow(
      /unitTests 必须是 >= 0 的整数/,
    );
    expect(() => rewriteBaselineUnitTests('{"unitTests": -1}\n', 1290)).toThrow(
      /unitTests 必须是 >= 0 的整数/,
    );
    expect(() => rewriteBaselineUnitTests('{"unitTests": 1e21}\n', 1290)).toThrow(
      /unitTests 必须是 >= 0 的整数/,
    );
  });

  it('rejects duplicate unitTests keys even when the count already matches', () => {
    const duplicate = '{\n  "unitTests": 1280,\n  "unitTests": 1280\n}\n';

    expect(() => rewriteBaselineUnitTests(duplicate, 1280)).toThrow(
      /期望恰好一个 "unitTests" 数值/,
    );
  });
});

describe('planDocCountWrites', () => {
  it('plans all four writes and changes only the matched count numbers', () => {
    const documents = docsWithCount(1280);
    const baselineText = baselineFixture(1280);

    const plan = planDocCountWrites({ documents, baselineText, total: 1290 });

    expect(plan.total).toBe(1290);
    expect(plan.changedPaths).toEqual([
      'README.md',
      'docs/framework.md',
      'docs/snake-design.md',
      BASELINE_RELATIVE_PATH,
    ]);

    for (const document of plan.documents) {
      expect(document.changed).toBe(true);
      expect(changedLineIndexes(document.before, document.after)).toHaveLength(1);
      expect(document.after).toBe(document.before.replace('1280', '1290'));
    }
    expect(plan.documents[1]?.after).toContain('153 passed');

    expect(plan.baseline.changed).toBe(true);
    expect(changedLineIndexes(plan.baseline.before, plan.baseline.after)).toHaveLength(1);
    expect(plan.baseline.after).toBe(baselineFixture(1290));
    expect(JSON.parse(plan.baseline.after)).toEqual({
      ...JSON.parse(baselineText),
      unitTests: 1290,
    });
  });

  it('is idempotent: planning from the planned output reports no changes', () => {
    const first = planDocCountWrites({
      documents: docsWithCount(1280),
      baselineText: baselineFixture(1280),
      total: 1290,
    });

    const second = planDocCountWrites({
      documents: first.documents.map((document) => ({
        path: document.path,
        text: document.after,
      })),
      baselineText: first.baseline.after,
      total: 1290,
    });

    expect(second.changedPaths).toEqual([]);
    expect(second.baseline.changed).toBe(false);
    expect(second.documents.every((document) => document.changed === false)).toBe(true);
  });

  it('can plan a baseline-only change', () => {
    const plan = planDocCountWrites({
      documents: docsWithCount(1290),
      baselineText: baselineFixture(1280),
      total: 1290,
    });

    expect(plan.changedPaths).toEqual([BASELINE_RELATIVE_PATH]);
    expect(plan.documents.every((document) => document.changed === false)).toBe(true);
    expect(plan.baseline.changed).toBe(true);
  });

  it('refuses to plan writes when tests failed', () => {
    expect(() =>
      planDocCountWrites({
        documents: docsWithCount(1280),
        baselineText: baselineFixture(1280),
        total: 1290,
        numFailedTests: 2,
      }),
    ).toThrow(/numFailedTests=2，拒绝写入文档计数/);
  });

  it('rejects a non-integer total', () => {
    expect(() =>
      planDocCountWrites({
        documents: docsWithCount(1280),
        baselineText: baselineFixture(1280),
        total: 1.5,
      }),
    ).toThrow(DocCountsError);
  });

  it('propagates a missing count line instead of planning a partial write', () => {
    const documents = docsWithCount(1280);
    documents[1] = { path: 'docs/framework.md', text: '先运行 `npm run test:unit`。\n' };

    expect(() =>
      planDocCountWrites({ documents, baselineText: baselineFixture(1280), total: 1290 }),
    ).toThrow(/docs\/framework\.md: npm run test:unit 同行缺少/);
  });
});

describe('sync-doc-counts CLI', () => {
  it('writes the measured count into all four files and prints each path', () => {
    const dir = makeTempDir();
    writeFixtureProject(dir, 1280);
    const report = writeReport(reportJson(1290));

    const { status, stdout, stderr } = runSyncCli(['--report', report], dir);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    for (const path of [...DOC_COUNT_PATHS, BASELINE_RELATIVE_PATH]) {
      expect(stdout).toContain(`updated ${path} -> 1290`);
    }
    expect(stdout).toContain('已把 4 个文件同步为 1290');

    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    const framework = readFileSync(join(dir, 'docs/framework.md'), 'utf8');
    const snake = readFileSync(join(dir, 'docs/snake-design.md'), 'utf8');
    const baseline = readFileSync(join(dir, BASELINE_RELATIVE_PATH), 'utf8');

    expect(parseDocumentedCount(readme, 'README.md').count).toBe(1290);
    expect(parseDocumentedCount(framework, 'docs/framework.md').count).toBe(1290);
    expect(parseDocumentedCount(snake, 'docs/snake-design.md').count).toBe(1290);
    expect((JSON.parse(baseline) as { unitTests: number }).unitTests).toBe(1290);
  });

  it('is idempotent: a second run leaves every file byte-identical', () => {
    const dir = makeTempDir();
    writeFixtureProject(dir, 1280);
    const report = writeReport(reportJson(1290));

    expect(runSyncCli(['--report', report], dir).status).toBe(0);
    const afterFirstRun = readFixtureProject(dir);

    const second = runSyncCli(['--report', report], dir);

    expect(second.status).toBe(0);
    expect(second.stderr).toBe('');
    expect(second.stdout).toContain('无需修改');
    expect(readFixtureProject(dir)).toEqual(afterFirstRun);
  });

  it('refuses to write and exits 1 when the report records failing tests', () => {
    const dir = makeTempDir();
    writeFixtureProject(dir, 1280);
    const before = readFixtureProject(dir);
    const report = writeReport(reportJson(1290, { numFailedTests: 1, numPassedTests: 1289 }));

    const { status, stdout, stderr } = runSyncCli(['--report', report], dir);

    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('numFailedTests=1');
    expect(readFixtureProject(dir)).toEqual(before);
  });

  it('refuses to write and exits 1 when the report measures zero tests', () => {
    const dir = makeTempDir();
    writeFixtureProject(dir, 1280);
    const before = readFixtureProject(dir);
    const report = writeReport(reportJson(0));

    const { status, stderr } = runSyncCli(['--report', report], dir);

    expect(status).toBe(1);
    expect(stderr).toContain('numTotalTests=0');
    expect(readFixtureProject(dir)).toEqual(before);
  });

  it('exits 2 and writes nothing for a missing or malformed report', () => {
    const dir = makeTempDir();
    writeFixtureProject(dir, 1280);
    const before = readFixtureProject(dir);
    const missing = join(makeTempDir(), 'missing.json');
    const invalid = writeReport('not json');
    const nonInteger = writeReport(reportJson(1.5));
    const unsafeInteger = writeReport(reportJson(1e21));

    expect(runSyncCli(['--report', missing], dir).status).toBe(2);
    expect(runSyncCli(['--report', missing], dir).stderr).toContain('找不到 Vitest JSON 报告');

    const malformed = runSyncCli(['--report', invalid], dir);
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain('不是合法的 JSON');

    const fraction = runSyncCli(['--report', nonInteger], dir);
    expect(fraction.status).toBe(2);
    expect(fraction.stderr).toContain('缺少或无效的 numTotalTests 字段');

    const unsafe = runSyncCli(['--report', unsafeInteger], dir);
    expect(unsafe.status).toBe(2);
    expect(unsafe.stderr).toContain('缺少或无效的 numTotalTests 字段');

    expect(readFixtureProject(dir)).toEqual(before);
  });

  it.skipIf(process.platform === 'win32')(
    'exits 2 when the temporary directory cannot be created',
    () => {
      const dir = makeTempDir();
      writeFixtureProject(dir, 1280);
      const before = readFixtureProject(dir);
      const missingTmp = join(makeTempDir(), 'missing', 'tmp');

      const { status, stderr } = runSyncCli([], dir, { TMPDIR: missingTmp });

      expect(status).toBe(2);
      expect(stderr).toContain('无法创建临时目录');
      expect(readFixtureProject(dir)).toEqual(before);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'runs npm run test:unit itself when --report is omitted',
    () => {
      const dir = makeTempDir();
      writeFixtureProject(dir, 1280);
      const argsFile = join(makeTempDir(), 'npm-args.txt');
      const fakeNpm = writeFakeNpm(
        [
          '#!/bin/sh',
          'printf \'%s\\n\' "$@" > "$DOC_COUNTS_NPM_ARGS"',
          'out=""',
          'for arg in "$@"; do',
          '  case "$arg" in',
          '    --outputFile=*) out="${arg#--outputFile=}" ;;',
          '  esac',
          'done',
          'printf \'%s\\n\' \'{"numTotalTests":1290,"numPassedTests":1290,"numFailedTests":0,"numPendingTests":0}\' > "$out"',
          'exit 0',
          '',
        ].join('\n'),
      );

      const { status, stdout, stderr } = runSyncCli([], dir, {
        PATH: pathWith(fakeNpm),
        DOC_COUNTS_NPM_ARGS: argsFile,
      });

      expect(stderr).toBe('');
      expect(status).toBe(0);
      expect(stdout).toContain('Running npm run test:unit');
      expect(stdout).toContain('已把 4 个文件同步为 1290');

      const argv = readFileSync(argsFile, 'utf8').trim().split('\n');
      expect(argv.slice(0, 2)).toEqual(['run', 'test:unit']);
      expect(argv).toContain('--reporter=json');
      expect(argv.some((arg) => arg.startsWith('--outputFile='))).toBe(true);

      expect(
        parseDocumentedCount(readFileSync(join(dir, 'README.md'), 'utf8'), 'README.md').count,
      ).toBe(1290);
      expect(
        (JSON.parse(readFileSync(join(dir, BASELINE_RELATIVE_PATH), 'utf8')) as {
          unitTests: number;
        }).unitTests,
      ).toBe(1290);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'exits 1 and writes nothing when the test command fails',
    () => {
      const dir = makeTempDir();
      writeFixtureProject(dir, 1280);
      const before = readFixtureProject(dir);
      const fakeNpm = writeFakeNpm(['#!/bin/sh', 'exit 3', ''].join('\n'));

      const { status, stderr } = runSyncCli([], dir, { PATH: pathWith(fakeNpm) });

      expect(status).toBe(1);
      expect(stderr).toContain('退出码为 3');
      expect(readFixtureProject(dir)).toEqual(before);
    },
  );

  it('exits 2 and writes nothing when a document cannot be read', () => {
    const dir = makeTempDir();
    writeFixtureProject(dir, 1280);
    const before = readFixtureProject(dir);
    const report = writeReport(reportJson(1290));
    rmSync(join(dir, 'docs/snake-design.md'));

    const { status, stderr } = runSyncCli(['--report', report], dir);

    expect(status).toBe(2);
    expect(stderr).toContain('无法读取 docs/snake-design.md');
    for (const path of ['README.md', 'docs/framework.md', BASELINE_RELATIVE_PATH]) {
      expect(readFileSync(join(dir, path), 'utf8')).toBe(before[path]);
    }
  });

  it('exits 1 and writes nothing when a document count line is missing', () => {
    const dir = makeTempDir();
    writeFixtureProject(dir, 1280);
    writeFileSync(join(dir, 'README.md'), '# README\n\n先运行 `npm run test:unit`。\n');
    const before = readFixtureProject(dir);
    const report = writeReport(reportJson(1290));

    const { status, stdout, stderr } = runSyncCli(['--report', report], dir);

    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('README.md: npm run test:unit 同行缺少');
    expect(readFixtureProject(dir)).toEqual(before);
  });

  it('exits 1 and writes nothing when the baseline has no unitTests', () => {
    const dir = makeTempDir();
    writeFixtureProject(dir, 1280);
    writeFileSync(join(dir, BASELINE_RELATIVE_PATH), '{\n  "entryGzipBytes": 11889\n}\n');
    const before = readFixtureProject(dir);
    const report = writeReport(reportJson(1290));

    const { status, stderr } = runSyncCli(['--report', report], dir);

    expect(status).toBe(1);
    expect(stderr).toContain('缺少 unitTests 字段');
    expect(readFixtureProject(dir)).toEqual(before);
  });

  it('exits 0 for --help and 2 for usage errors', () => {
    const dir = makeTempDir();
    writeFixtureProject(dir, 1280);

    const long = runSyncCli(['--help'], dir);
    expect(long.status).toBe(0);
    expect(long.stderr).toBe('');
    expect(long.stdout).toContain('Usage: node scripts/sync-doc-counts.mjs');
    expect(long.stdout).toContain('--report');

    expect(runSyncCli(['-h'], dir).status).toBe(0);

    const unknown = runSyncCli(['--unknown'], dir);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown option: --unknown');

    const missingValue = runSyncCli(['--report'], dir);
    expect(missingValue.status).toBe(2);
    expect(missingValue.stderr).toContain('--report needs a value');
  });

  it('is wired to the npm run docs:counts:write script', () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['docs:counts:write']).toBe(
      'node scripts/sync-doc-counts.mjs',
    );
  });
});
