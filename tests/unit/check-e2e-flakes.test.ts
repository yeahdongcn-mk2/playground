import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_E2E_REPORT_PATH,
  E2eFlakesError,
  TARGET_PROJECT_NAME,
  TARGET_TITLE_FRAGMENT,
  analyzeE2eFlakes,
  describeE2eFlakes,
  exitCodeForAnalysis,
  parseE2eReport,
  readE2eReport,
  summarizeResultError,
} from '../../scripts/lib/e2e-flakes.mjs';
import type {
  PlaywrightJsonReport,
  PlaywrightJsonTestResult,
  PlaywrightJsonTest,
} from '../../scripts/lib/e2e-flakes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'check-e2e-flakes.mjs');
const TARGET_TITLE = 'hub and blank canvas fit a phone viewport';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-flakes-'));
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

interface FixtureCase {
  projectName: string;
  title: string;
  attempts: Array<'passed' | 'failed' | 'skipped'>;
  firstError?: string;
  expectedStatus?: string;
}

function testStatus(attempts: FixtureCase['attempts']): string {
  if (attempts[0] === 'skipped') return 'skipped';
  if (attempts.every((status) => status === 'passed')) return 'expected';
  if (attempts.at(-1) === 'passed') return 'flaky';
  return 'unexpected';
}

function result(status: FixtureCase['attempts'][number], retry: number, error: string) {
  return {
    status,
    retry,
    ...(status === 'passed' ? {} : { error: { message: error } }),
  } satisfies PlaywrightJsonTestResult;
}

/** Minimal Playwright JSON report: one file suite per fixture case. */
function makeReport(cases: FixtureCase[]): PlaywrightJsonReport {
  return {
    config: {},
    errors: [],
    suites: cases.map((entry, index) => {
      const file = `tests/e2e/fixture-${index}.spec.ts`;
      const test: PlaywrightJsonTest = {
        projectName: entry.projectName,
        status: testStatus(entry.attempts),
        ...(entry.expectedStatus === undefined
          ? {}
          : { expectedStatus: entry.expectedStatus }),
        results: entry.attempts.map((status, retry) =>
          result(status, retry, entry.firstError ?? `attempt ${retry} failed`),
        ),
      };
      return {
        title: file,
        file,
        specs: [
          {
            title: entry.title,
            ok: entry.attempts.at(-1) === 'passed',
            file,
            line: 10,
            tests: [test],
          },
        ],
      };
    }),
  };
}

function target(attempts: FixtureCase['attempts'], firstError?: string): FixtureCase {
  return {
    projectName: TARGET_PROJECT_NAME,
    title: TARGET_TITLE,
    attempts,
    ...(firstError === undefined ? {} : { firstError }),
  };
}

function writeReport(dir: string, report: PlaywrightJsonReport, name = 'report.json'): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

function runCli(
  args: string[],
  cwd = ROOT,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error === undefined ? '' : String(result.error)}`,
  };
}

describe('analyzeE2eFlakes', () => {
  it('passes when the target case passes on the first attempt', () => {
    const analysis = analyzeE2eFlakes(makeReport([target(['passed'])]));

    expect(analysis.status).toBe('passed');
    expect(analysis.cases).toEqual([
      {
        title: TARGET_TITLE,
        projectName: TARGET_PROJECT_NAME,
        file: 'tests/e2e/fixture-0.spec.ts',
        line: 10,
        outcome: 'passed',
        retryCount: 0,
        firstError: null,
      },
    ]);
    expect(exitCodeForAnalysis(analysis)).toBe(0);
    expect(describeE2eFlakes(analysis).join('\n')).toContain(TARGET_TITLE);
  });

  it('fails when the target case only passes after one retry', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([target(['failed', 'passed'], 'Error: tap readout did not settle')]),
    );

    expect(analysis.status).toBe('flaky');
    expect(analysis.cases[0]).toMatchObject({
      outcome: 'flaky',
      retryCount: 1,
      firstError: 'Error: tap readout did not settle',
    });
    expect(exitCodeForAnalysis(analysis)).toBe(1);

    const output = describeE2eFlakes(analysis).join('\n');
    expect(output).toContain(`[e2e-flakes] 目标用例重试后通过`);
    expect(output).toContain(`${TARGET_PROJECT_NAME} / ${TARGET_TITLE}`);
    expect(output).toContain('重试次数：1');
    expect(output).toContain('首跑错误：Error: tap readout did not settle');
  });

  it('reports how many retries the target case needed', () => {
    const analysis = analyzeE2eFlakes(makeReport([target(['failed', 'failed', 'passed'])]));

    expect(analysis.status).toBe('flaky');
    expect(analysis.cases[0]?.retryCount).toBe(2);
    expect(describeE2eFlakes(analysis).join('\n')).toContain('重试次数：2');
  });

  it('does not repeat a target failure that already failed the e2e step', () => {
    const analysis = analyzeE2eFlakes(makeReport([target(['failed', 'failed'])]));

    expect(analysis.status).toBe('failed');
    expect(analysis.cases[0]?.outcome).toBe('failed');
    expect(exitCodeForAnalysis(analysis)).toBe(0);

    const output = describeE2eFlakes(analysis).join('\n');
    expect(output).toContain(`[e2e-flakes] 目标用例失败`);
    expect(output).toContain('e2e 步骤已判失败，本检查不重复报错');
    expect(output).not.toContain('重试次数');
  });

  it('fails when the target case was skipped or marked as an expected failure', () => {
    const skipped = analyzeE2eFlakes(makeReport([target(['skipped'])]));

    expect(skipped.status).toBe('skipped');
    expect(exitCodeForAnalysis(skipped)).toBe(1);
    expect(describeE2eFlakes(skipped).join('\n')).toContain('目标用例被跳过');

    // `test.fail()` is green in the e2e step, but it is not a stable first run.
    const expectedFailure = analyzeE2eFlakes(
      makeReport([
        {
          projectName: TARGET_PROJECT_NAME,
          title: TARGET_TITLE,
          attempts: ['failed'],
          expectedStatus: 'failed',
        },
      ]),
    );
    expect(expectedFailure.status).toBe('skipped');
    expect(exitCodeForAnalysis(expectedFailure)).toBe(1);
    expect(describeE2eFlakes(expectedFailure).join('\n')).toContain('预期失败');
  });

  it('ignores flaky cases from another project', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([
        target(['passed']),
        {
          projectName: 'mobile',
          title: 'hub and blank canvas fit a phone viewport',
          attempts: ['failed', 'passed'],
        },
      ]),
    );

    expect(analysis.status).toBe('passed');
    expect(analysis.cases).toHaveLength(1);
    expect(exitCodeForAnalysis(analysis)).toBe(0);
  });

  it('ignores flaky mobile-webkit cases whose title is not the target', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([
        target(['passed']),
        { projectName: 'mobile-webkit', title: 'another phone case', attempts: ['failed', 'passed'] },
      ]),
    );

    expect(analysis.status).toBe('passed');
    expect(analysis.cases).toHaveLength(1);
    expect(exitCodeForAnalysis(analysis)).toBe(0);
  });

  it('fails when the report has no target case at all', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([{ projectName: 'mobile', title: TARGET_TITLE, attempts: ['passed'] }]),
    );

    expect(analysis.status).toBe('missing');
    expect(exitCodeForAnalysis(analysis)).toBe(1);
    const output = describeE2eFlakes(analysis, 'reports/run.json').join('\n');
    expect(output).toContain(TARGET_TITLE_FRAGMENT);
    expect(output).toContain('reports/run.json');
    expect(output).toContain('门禁无法确认');
  });

  it('collects a target case nested inside describe suites', () => {
    const report = makeReport([target(['passed'])]);
    const fileSuite = report.suites?.[0];
    const spec = fileSuite?.specs?.[0];
    if (!fileSuite || !spec) throw new Error('fixture report is incomplete');
    report.suites = [
      {
        title: fileSuite.title,
        file: fileSuite.file,
        specs: [],
        suites: [{ title: 'mobile shell', file: fileSuite.file, specs: [spec] }],
      },
    ];

    expect(analyzeE2eFlakes(report).status).toBe('passed');
  });

  it('reads only the mobile-webkit test from a spec shared by two projects', () => {
    // The JSON reporter merges tests of the same spec file/line across
    // projects, and the framework phone case is defined once in a shared
    // module used by both the Chromium `mobile` and `mobile-webkit` projects.
    const report = makeReport([target(['failed', 'passed'])]);
    const spec = report.suites?.[0]?.specs?.[0];
    if (!spec) throw new Error('fixture report is incomplete');
    spec.tests = [
      { projectName: 'mobile', status: 'expected', results: [{ status: 'passed' }] },
      ...(spec.tests ?? []),
    ];

    const analysis = analyzeE2eFlakes(report);

    expect(analysis.status).toBe('flaky');
    expect(analysis.cases).toHaveLength(1);
    expect(analysis.cases[0]?.projectName).toBe(TARGET_PROJECT_NAME);
    expect(analysis.cases[0]?.retryCount).toBe(1);
  });
});

describe('gate wiring', () => {
  it('keeps the constants wired to the real mobile-webkit case', () => {
    const sharedCases = readFileSync(
      join(ROOT, 'tests', 'e2e', 'framework-mobile-cases.ts'),
      'utf8',
    );
    const webkitEntry = readFileSync(
      join(ROOT, 'tests', 'e2e', 'framework.mobile.webkit.spec.ts'),
      'utf8',
    );
    const config = readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8');

    // If the case is renamed or the WebKit entry point stops using the shared
    // module, the gate would silently have nothing to check.
    expect(sharedCases).toContain(TARGET_TITLE_FRAGMENT);
    expect(webkitEntry).toContain('defineFrameworkMobileCases');
    expect(config).toContain(`name: '${TARGET_PROJECT_NAME}'`);
  });
});

describe('parseE2eReport', () => {
  it('rejects invalid JSON and non-Playwright JSON', () => {
    expect(() => parseE2eReport('not json')).toThrow(E2eFlakesError);
    expect(() => parseE2eReport('not json')).toThrow(/无法解析/);
    expect(() => parseE2eReport('{}')).toThrow(/缺少顶层 suites 数组/);
    expect(() => parseE2eReport('[]')).toThrow(/缺少顶层 suites 数组/);
    expect(() => parseE2eReport('null')).toThrow(/缺少顶层 suites 数组/);
  });

  it('accepts a report with a suites array', () => {
    expect(parseE2eReport('{"suites": []}')).toEqual({ suites: [] });
  });
});

describe('readE2eReport', () => {
  it('names the missing report path', () => {
    const dir = makeTempDir();
    const missing = join(dir, 'missing.json');

    expect(() => readE2eReport(missing)).toThrow(E2eFlakesError);
    expect(() => readE2eReport(missing)).toThrow(/报告缺失或不可读/);
    expect(() => readE2eReport(missing)).toThrow(missing);
  });

  it('reads and parses a written report', () => {
    const dir = makeTempDir();
    const file = writeReport(dir, makeReport([target(['passed'])]));

    expect(readE2eReport(file).suites).toHaveLength(1);
  });
});

describe('summarizeResultError', () => {
  it('uses the first non-empty line of the raw error message', () => {
    const summary = summarizeResultError({
      status: 'failed',
      error: { message: '\u001b[31mError: first line\u001b[0m\nsecond line' },
    });

    expect(summary).toBe('Error: first line');
  });

  it('falls back to the formatted errors array', () => {
    const summary = summarizeResultError({
      status: 'timedOut',
      errors: ['', { message: 'Test timeout of 30000ms exceeded.\nCall log follows' }],
    });

    expect(summary).toBe('Test timeout of 30000ms exceeded.');

    expect(
      summarizeResultError({
        status: 'timedOut',
        errors: ['', 'Interrupted by the test runner'],
      }),
    ).toBe('Interrupted by the test runner');
  });

  it('returns null when the result carries no error', () => {
    expect(summarizeResultError({ status: 'passed' })).toBeNull();
  });
});

describe('check-e2e-flakes CLI', () => {
  it('exits 0 for a report where the target case passed first', () => {
    const dir = makeTempDir();
    const report = writeReport(dir, makeReport([target(['passed'])]));

    const { status, stdout, stderr } = runCli(['--report', report]);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain('目标用例首跑通过');
    expect(stdout).toContain(TARGET_TITLE);
  });

  it('exits 1 and prints the case name and retry count for a retried target', () => {
    const dir = makeTempDir();
    const report = writeReport(
      dir,
      makeReport([target(['failed', 'passed'], 'Error: first-run readout mismatch')]),
    );

    const { status, stdout } = runCli(['--report', report]);

    expect(status).toBe(1);
    expect(stdout).toContain('目标用例重试后通过');
    expect(stdout).toContain(`${TARGET_PROJECT_NAME} / ${TARGET_TITLE}`);
    expect(stdout).toContain('重试次数：1');
    expect(stdout).toContain('首跑错误：Error: first-run readout mismatch');
  });

  it('exits 0 when only another project or a non-target case is flaky', () => {
    const dir = makeTempDir();
    const report = writeReport(
      dir,
      makeReport([
        target(['passed']),
        { projectName: 'chromium', title: 'desktop case', attempts: ['failed', 'passed'] },
        { projectName: 'mobile-webkit', title: 'other webkit case', attempts: ['failed', 'passed'] },
      ]),
    );

    const { status, stdout } = runCli(['--report', report]);

    expect(status).toBe(0);
    expect(stdout).toContain('目标用例首跑通过');
  });

  it('exits 2 when the report is missing', () => {
    const dir = makeTempDir();

    const { status, stderr } = runCli(['--report', join(dir, 'missing.json')]);

    expect(status).toBe(2);
    expect(stderr).toContain('报告缺失或不可读');
    expect(stderr).toContain('CI=true npm run test:e2e');
  });

  it('exits 2 when the report cannot be parsed', () => {
    const dir = makeTempDir();
    const file = join(dir, 'broken.json');
    writeFileSync(file, '{"suites": [');

    const { status, stderr } = runCli(['--report', file]);

    expect(status).toBe(2);
    expect(stderr).toContain('无法解析 Playwright JSON 报告');
  });

  it('exits 1 when a parsed report has no target case', () => {
    const dir = makeTempDir();
    const report = writeReport(dir, makeReport([]));

    const { status, stdout } = runCli(['--report', report]);

    expect(status).toBe(1);
    expect(stdout).toContain('报告中没有找到');
    expect(stdout).toContain(TARGET_TITLE_FRAGMENT);
  });

  it('reads the default CI report path from the working directory', () => {
    const dir = makeTempDir();
    const reportDir = join(dir, dirname(DEFAULT_E2E_REPORT_PATH));
    mkdirSync(reportDir, { recursive: true });
    writeReport(
      reportDir,
      makeReport([target(['passed'])]),
      DEFAULT_E2E_REPORT_PATH.split('/').at(-1) ?? 'e2e-report.json',
    );

    const { status, stdout } = runCli([], dir);

    expect(status).toBe(0);
    expect(stdout).toContain('目标用例首跑通过');
  });

  it('exits 0 for --help and 2 for a usage error', () => {
    const help = runCli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: node scripts/check-e2e-flakes.mjs');
    expect(help.stdout).toContain('--report');

    const unknown = runCli(['--unknown']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown option: --unknown');

    expect(runCli(['--report']).status).toBe(2);
  });
});
