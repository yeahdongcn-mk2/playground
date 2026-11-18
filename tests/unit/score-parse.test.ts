import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  kbToBytes,
  parseBudgetMetrics,
  parseUnitTests,
} from '../../scripts/lib/score.mjs';
import type { CapturedCommandResult } from '../../scripts/lib/score.mjs';

const COMMIT = 'a'.repeat(40);
const GENERATED_AT = '2026-11-18T00:00:00.000Z';

const LINT_OK = [
  'Found 0 warnings and 0 errors.',
  'Finished in 20ms on 207 files with 97 rules using 12 threads.',
  'Module boundaries OK (69 source files).',
  '',
].join('\n');

const BUDGET_OK = [
  'Entry JS: 24.58 KB (8.12 KB gzip)',
  'All JS chunks: 412.33 KB gzip (2D game budget 450 KB)',
  'CSS: 9.10 KB gzip',
  'Budget check OK: shell is engine-free and within the 2D download budget.',
  '',
].join('\n');

const BUDGET_OVER_LIMIT = [
  'Entry JS: 60.00 KB (52.00 KB gzip)',
  'All JS chunks: 500.00 KB gzip (2D game budget 450 KB)',
  'Budget check failed:',
  '  - entry JS is 52.00 KB gzip, over the 50 KB budget',
  '',
].join('\n');

const DOC_COUNTS_OK = [
  'Running npm run test:unit to measure numTotalTests...',
  'OK: README.md / docs/framework.md / docs/snake-design.md 的单测计数均为 1258，与 Vitest numTotalTests 一致。',
  '',
].join('\n');

const DOC_DIMS_OK = [
  'OK: 检查了 40 个文件 / 40 行 README（整页 30 行 / 视口 10 行，sha256 40 个文件），尺寸与 sha256 全部一致。',
  '',
].join('\n');

const SHA_OK = 'OK: 40 screenshot sha256 entries verified in /repo/docs/screenshots\n';
const WEBKIT_OK =
  'OK: 12 WebKit screenshot artifacts verified in /repo/docs/screenshots\n';

const BUILD_OK: CapturedCommandResult = {
  name: 'build',
  script: 'build',
  status: 0,
  signal: null,
  stdout: 'vite v8.3.5 building for production...\n',
  stderr: '',
};

function ok(name: string, stdout: string): CapturedCommandResult {
  return { name, script: name, status: 0, signal: null, stdout, stderr: '' };
}

function failing(name: string, stderr: string): CapturedCommandResult {
  return { name, script: name, status: 1, signal: null, stdout: '', stderr };
}

function passingResults(): CapturedCommandResult[] {
  return [
    ok('lint', LINT_OK),
    ok('check:budget', BUDGET_OK),
    ok('verify:doc-counts', DOC_COUNTS_OK),
    ok('verify:screenshots:doc-dims', DOC_DIMS_OK),
    ok('verify:screenshots:sha256', SHA_OK),
    ok('verify:screenshots:webkit', WEBKIT_OK),
  ];
}

function snapshotFrom(results: CapturedCommandResult[], gitCommit: string | null = COMMIT) {
  return buildSnapshot({
    results,
    build: BUILD_OK,
    gitCommit,
    generatedAt: GENERATED_AT,
  });
}

describe('buildSnapshot', () => {
  it('marks all six checks pass and extracts every metric', () => {
    const snapshot = snapshotFrom(passingResults());

    expect(snapshot.checks).toEqual({
      lint: 'pass',
      'check:budget': 'pass',
      'verify:doc-counts': 'pass',
      'verify:screenshots:doc-dims': 'pass',
      'verify:screenshots:sha256': 'pass',
      'verify:screenshots:webkit': 'pass',
    });
    expect(snapshot.unitTests).toBe(1258);
    expect(snapshot.entryGzipBytes).toBe(8315);
    expect(snapshot.totalJsGzipBytes).toBe(422226);
    expect(snapshot.gitCommit).toBe(COMMIT);
    expect(snapshot.generatedAt).toBe(GENERATED_AT);
    expect(snapshot.error).toEqual({});
  });

  it('records a failing check without losing the other values', () => {
    const results = passingResults();
    results[4] = failing(
      'verify:screenshots:sha256',
      'FAIL: 1 screenshot sha256 problem(s) across 40 entries in /repo/docs/screenshots:\n',
    );

    const snapshot = snapshotFrom(results);

    expect(snapshot.checks['verify:screenshots:sha256']).toBe('fail');
    expect(snapshot.checks.lint).toBe('pass');
    expect(snapshot.unitTests).toBe(1258);
    expect(snapshot.entryGzipBytes).toBe(8315);
    expect(snapshot.error).toEqual({});
  });

  it('marks a documented usage/I/O error (exit 2) as null with a reason', () => {
    const results = passingResults();
    results[3] = {
      name: 'verify:screenshots:doc-dims',
      script: 'verify:screenshots:doc-dims',
      status: 2,
      signal: null,
      stdout: '',
      stderr: 'error: cannot read README /repo/docs/screenshots/README.md: ENOENT\n',
    };

    const snapshot = snapshotFrom(results);

    expect(snapshot.checks['verify:screenshots:doc-dims']).toBeNull();
    expect(snapshot.error['verify:screenshots:doc-dims']).toContain('execution error');
    expect(snapshot.error['verify:screenshots:doc-dims']).toContain('cannot read README');
  });

  it('keeps the parsed gzip sizes when check:budget fails on an over-budget build', () => {
    const results = passingResults();
    results[1] = failing('check:budget', BUDGET_OVER_LIMIT);

    const snapshot = snapshotFrom(results);

    expect(snapshot.checks['check:budget']).toBe('fail');
    expect(snapshot.entryGzipBytes).toBe(53248);
    expect(snapshot.totalJsGzipBytes).toBe(512000);
    expect(snapshot.error).toEqual({});
  });

  it('marks a check:budget exit without a violation block as an execution error', () => {
    const results = passingResults();
    results[1] = failing(
      'check:budget',
      'dist/index.html is missing; run `npm run build` first.\n',
    );

    const snapshot = snapshotFrom(results);

    expect(snapshot.checks['check:budget']).toBeNull();
    expect(snapshot.error['check:budget']).toContain('did not report a validation failure');
    expect(snapshot.error['check:budget']).toContain('dist/index.html is missing');
    expect(snapshot.entryGzipBytes).toBeNull();
    expect(snapshot.totalJsGzipBytes).toBeNull();
  });

  it('reports null metrics and null checks with reasons for unparseable output', () => {
    const results = passingResults();
    results[1] = ok('check:budget', 'unexpected budget output\n');
    results[2] = ok('verify:doc-counts', 'unexpected doc-count output\n');

    const snapshot = snapshotFrom(results);

    expect(snapshot.checks['check:budget']).toBeNull();
    expect(snapshot.checks['verify:doc-counts']).toBeNull();
    expect(snapshot.entryGzipBytes).toBeNull();
    expect(snapshot.totalJsGzipBytes).toBeNull();
    expect(snapshot.unitTests).toBeNull();
    expect(snapshot.error['check:budget']).toContain('success marker');
    expect(snapshot.error['verify:doc-counts']).toContain('success marker');
    expect(snapshot.error.entryGzipBytes).toContain('entry gzip size');
    expect(snapshot.error.totalJsGzipBytes).toContain('total JS gzip size');
    expect(snapshot.error.unitTests).toContain('numTotalTests');
  });

  it('marks an unexecuted entry point as null with a reason', () => {
    const results = passingResults().filter((result) => result.name !== 'lint');

    const snapshot = snapshotFrom(results);

    expect(snapshot.checks.lint).toBeNull();
    expect(snapshot.error.lint).toContain('was not executed');
    expect(snapshot.checks['check:budget']).toBe('pass');
  });

  it('marks a missing npm script as null instead of fail', () => {
    const results = passingResults();
    results[5] = failing(
      'verify:screenshots:webkit',
      'npm error Missing script: "verify:screenshots:webkit"\n',
    );

    const snapshot = snapshotFrom(results);

    expect(snapshot.checks['verify:screenshots:webkit']).toBeNull();
    expect(snapshot.error['verify:screenshots:webkit']).toContain('is missing');
  });

  it('marks an entry killed by a signal as null with the signal name', () => {
    const results = passingResults();
    results[2] = {
      name: 'verify:doc-counts',
      script: 'verify:doc-counts',
      status: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
    };

    const snapshot = snapshotFrom(results);

    expect(snapshot.checks['verify:doc-counts']).toBeNull();
    expect(snapshot.error['verify:doc-counts']).toContain('signal SIGTERM');
  });

  it('marks an entry that could not start as null with the spawn error', () => {
    const results = passingResults();
    results[0] = {
      name: 'lint',
      script: 'lint',
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: 'spawn npm ENOENT',
    };

    const snapshot = snapshotFrom(results);

    expect(snapshot.checks.lint).toBeNull();
    expect(snapshot.error.lint).toContain('failed to start');
    expect(snapshot.error.lint).toContain('spawn npm ENOENT');
  });

  it('records a failed build in error without dropping the rest of the snapshot', () => {
    const snapshot = buildSnapshot({
      results: passingResults(),
      build: { ...BUILD_OK, status: 1, stderr: 'error TS2322: type mismatch\n' },
      gitCommit: COMMIT,
      generatedAt: GENERATED_AT,
    });

    expect(snapshot.error.build).toBe('npm run build exited with code 1');
    expect(snapshot.checks.lint).toBe('pass');
    expect(snapshot.unitTests).toBe(1258);
  });

  it('records a missing git commit as null with a reason', () => {
    const snapshot = snapshotFrom(passingResults(), null);

    expect(snapshot.gitCommit).toBeNull();
    expect(snapshot.error.gitCommit).toContain('commit hash');
  });
});

describe('parseBudgetMetrics', () => {
  it('converts the KB figures printed by check:budget into bytes', () => {
    expect(parseBudgetMetrics(BUDGET_OK)).toEqual({
      entryGzipBytes: 8315,
      totalJsGzipBytes: 422226,
    });
  });

  it('returns null only for the line that is missing', () => {
    expect(parseBudgetMetrics('Entry JS: 24.58 KB (8.12 KB gzip)\n')).toEqual({
      entryGzipBytes: 8315,
      totalJsGzipBytes: null,
    });
  });

  it('returns null for an unparseable KB figure instead of NaN', () => {
    expect(
      parseBudgetMetrics('Entry JS: 24.58 KB (1.2.3 KB gzip)\nAll JS chunks: x KB gzip\n'),
    ).toEqual({
      entryGzipBytes: null,
      totalJsGzipBytes: null,
    });
  });
});

describe('parseUnitTests', () => {
  it('reads the count from the passing doc-counts line', () => {
    expect(parseUnitTests(DOC_COUNTS_OK)).toBe(1258);
  });

  it('reads the measured count from a failing mismatch line', () => {
    expect(
      parseUnitTests('FAIL: 发现 1 处单测计数问题（实测 numTotalTests=1300）：\n'),
    ).toBe(1300);
  });

  it('returns null when no count is reported', () => {
    expect(parseUnitTests('OK: something unrelated\n')).toBeNull();
  });
});

describe('kbToBytes', () => {
  it('rounds the rounded KB figure back to whole bytes', () => {
    expect(kbToBytes(8.12)).toBe(8315);
    expect(kbToBytes(0)).toBe(0);
  });
});
