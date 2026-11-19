import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_E2E_REPORT_PATH,
  E2eFlakesError,
  TARGET_CASES,
  analyzeE2eFlakes,
  collectTargetCases,
  describeE2eFlakes,
  exitCodeForAnalysis,
  parseE2eReport,
  readE2eReport,
  summarizeResultError,
} from '../../scripts/lib/e2e-flakes.mjs';
import type {
  E2eFlakeTarget,
  E2eFlakesStatus,
  PlaywrightJsonReport,
  PlaywrightJsonTestResult,
  PlaywrightJsonTest,
} from '../../scripts/lib/e2e-flakes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'check-e2e-flakes.mjs');

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

function targetFor(titleFragment: string): E2eFlakeTarget {
  const target = TARGET_CASES.find((entry) => entry.titleFragment === titleFragment);
  if (target === undefined) throw new Error(`TARGET_CASES is missing the ${titleFragment} case`);
  return target;
}

const HUB_TARGET = targetFor('hub and blank canvas');
const RESET_TARGET = targetFor('reset centres the cursor and keyboard keeps working afterwards');
const RESTART_TARGET = targetFor(
  'restarting from the sidebar focuses the visible compact restart on a phone',
);

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

function targetCase(
  target: E2eFlakeTarget,
  attempts: FixtureCase['attempts'],
  firstError?: string,
): FixtureCase {
  return {
    projectName: target.projectName,
    title: target.titleFragment,
    attempts,
    ...(firstError === undefined ? {} : { firstError }),
  };
}

function passingAll(): FixtureCase[] {
  return [
    targetCase(HUB_TARGET, ['passed']),
    targetCase(RESET_TARGET, ['passed']),
    targetCase(RESTART_TARGET, ['passed']),
  ];
}

function writeReport(dir: string, report: PlaywrightJsonReport, name = 'report.json'): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

function statusOf(
  analysis: ReturnType<typeof analyzeE2eFlakes>,
  target: E2eFlakeTarget,
): E2eFlakesStatus {
  const entry = analysis.targets.find((item) => item.target.label === target.label);
  if (entry === undefined) throw new Error(`analysis is missing ${target.label}`);
  return entry.status;
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

describe('TARGET_CASES', () => {
  it('lists all guarded first-run cases with a project, fragment and label', () => {
    expect(TARGET_CASES.map((target) => [target.projectName, target.titleFragment])).toEqual([
      ['mobile-webkit', 'hub and blank canvas'],
      ['chromium', 'reset centres the cursor and keyboard keeps working afterwards'],
      [
        'mobile-webkit',
        'restarting from the sidebar focuses the visible compact restart on a phone',
      ],
    ]);
    for (const target of TARGET_CASES) {
      expect(target.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the targets wired to the real e2e cases and Playwright projects', () => {
    const sharedCases = readFileSync(
      join(ROOT, 'tests', 'e2e', 'framework-mobile-cases.ts'),
      'utf8',
    );
    const frameworkSpec = readFileSync(join(ROOT, 'tests', 'e2e', 'framework.spec.ts'), 'utf8');
    const webkitEntry = readFileSync(
      join(ROOT, 'tests', 'e2e', 'framework.mobile.webkit.spec.ts'),
      'utf8',
    );
    const touchCases = readFileSync(
      join(ROOT, 'tests', 'e2e', 'minesweeper-mobile-touch-cases.ts'),
      'utf8',
    );
    const minesweeperWebkitEntry = readFileSync(
      join(ROOT, 'tests', 'e2e', 'minesweeper.mobile.webkit.spec.ts'),
      'utf8',
    );
    const config = readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8');

    // If a case is renamed or the WebKit entry point stops using the shared
    // module, the gate would silently have nothing to check.
    expect(sharedCases).toContain(HUB_TARGET.titleFragment);
    expect(frameworkSpec).toContain(RESET_TARGET.titleFragment);
    expect(touchCases).toContain(RESTART_TARGET.titleFragment);
    expect(webkitEntry).toContain('defineFrameworkMobileCases');
    expect(minesweeperWebkitEntry).toContain('defineMinesweeperMobileTouchCases');
    expect(config).toContain(`name: '${HUB_TARGET.projectName}'`);
    expect(config).toContain(`name: '${RESET_TARGET.projectName}'`);
  });
});

describe('collectTargetCases', () => {
  it('collects every target case and annotates the target label', () => {
    const cases = collectTargetCases(makeReport(passingAll()));

    expect(cases).toHaveLength(3);
    expect(cases.map((entry) => entry.targetLabel)).toEqual([
      HUB_TARGET.label,
      RESET_TARGET.label,
      RESTART_TARGET.label,
    ]);
    expect(cases.map((entry) => entry.projectName)).toEqual([
      'mobile-webkit',
      'chromium',
      'mobile-webkit',
    ]);
  });

  it('separates the two mobile-webkit targets by their title fragments', () => {
    const report = makeReport([
      targetCase(HUB_TARGET, ['passed']),
      targetCase(RESTART_TARGET, ['failed', 'passed']),
      targetCase(RESET_TARGET, ['passed']),
    ]);

    const cases = collectTargetCases(report);
    expect(cases.filter((entry) => entry.projectName === 'mobile-webkit')).toHaveLength(2);
    expect(cases.map((entry) => entry.targetLabel)).toEqual([
      HUB_TARGET.label,
      RESET_TARGET.label,
      RESTART_TARGET.label,
    ]);
    expect(cases.find((entry) => entry.targetLabel === RESTART_TARGET.label)?.outcome).toBe(
      'flaky',
    );
  });

  it('collects a target case nested inside describe suites', () => {
    const report = makeReport([targetCase(HUB_TARGET, ['passed'])]);
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

    const cases = collectTargetCases(report);

    expect(cases).toHaveLength(1);
    expect(cases[0]?.targetLabel).toBe(HUB_TARGET.label);
  });

  it('ignores a matching title from another project', () => {
    const report = makeReport([
      ...passingAll(),
      { projectName: 'mobile', title: RESET_TARGET.titleFragment, attempts: ['failed', 'passed'] },
      { projectName: 'mobile-webkit', title: RESET_TARGET.titleFragment, attempts: ['failed', 'passed'] },
      { projectName: 'mobile', title: RESTART_TARGET.titleFragment, attempts: ['failed', 'passed'] },
      { projectName: 'chromium', title: RESTART_TARGET.titleFragment, attempts: ['failed', 'passed'] },
    ]);

    expect(collectTargetCases(report).map((entry) => entry.targetLabel)).toEqual([
      HUB_TARGET.label,
      RESET_TARGET.label,
      RESTART_TARGET.label,
    ]);
    expect(analyzeE2eFlakes(report).status).toBe('passed');
  });

  it('reads only the mobile-webkit test from a spec shared by two projects', () => {
    // The JSON reporter merges tests of the same spec file/line across
    // projects, and the framework phone case is defined once in a shared
    // module used by both the Chromium `mobile` and `mobile-webkit` projects.
    const report = makeReport([
      targetCase(HUB_TARGET, ['failed', 'passed']),
      targetCase(RESET_TARGET, ['passed']),
      targetCase(RESTART_TARGET, ['passed']),
    ]);
    const spec = report.suites?.[0]?.specs?.[0];
    if (!spec) throw new Error('fixture report is incomplete');
    spec.tests = [
      { projectName: 'mobile', status: 'expected', results: [{ status: 'passed' }] },
      ...(spec.tests ?? []),
    ];

    const analysis = analyzeE2eFlakes(report);

    expect(analysis.status).toBe('flaky');
    expect(analysis.cases.filter((entry) => entry.targetLabel === HUB_TARGET.label)).toHaveLength(
      1,
    );
    expect(analysis.cases.find((entry) => entry.targetLabel === HUB_TARGET.label)?.retryCount).toBe(
      1,
    );
  });
});

describe('analyzeE2eFlakes', () => {
  it('passes when all target cases pass on the first attempt', () => {
    const analysis = analyzeE2eFlakes(makeReport(passingAll()));

    expect(analysis.status).toBe('passed');
    expect(analysis.targets.map((entry) => entry.status)).toEqual([
      'passed',
      'passed',
      'passed',
    ]);
    expect(statusOf(analysis, HUB_TARGET)).toBe('passed');
    expect(statusOf(analysis, RESET_TARGET)).toBe('passed');
    expect(statusOf(analysis, RESTART_TARGET)).toBe('passed');
    expect(analysis.cases).toHaveLength(3);
    expect(analysis.cases[0]).toMatchObject({
      targetLabel: HUB_TARGET.label,
      projectName: 'mobile-webkit',
      outcome: 'passed',
      retryCount: 0,
      firstError: null,
    });
    expect(exitCodeForAnalysis(analysis)).toBe(0);

    const output = describeE2eFlakes(analysis).join('\n');
    expect(output).toContain(HUB_TARGET.label);
    expect(output).toContain(RESET_TARGET.label);
    expect(output).toContain(RESTART_TARGET.label);
    expect(output).toContain(`mobile-webkit / ${HUB_TARGET.titleFragment}`);
    expect(output).toContain(`chromium / ${RESET_TARGET.titleFragment}`);
    expect(output).toContain(`mobile-webkit / ${RESTART_TARGET.titleFragment}`);
    expect(output).toContain('3 个目标通过门禁');
  });

  it('fails when the reset target only passes after one retry', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([
        targetCase(HUB_TARGET, ['passed']),
        targetCase(RESET_TARGET, ['failed', 'passed'], 'Error: reset readout did not settle'),
        targetCase(RESTART_TARGET, ['passed']),
      ]),
    );

    expect(analysis.status).toBe('flaky');
    expect(statusOf(analysis, RESET_TARGET)).toBe('flaky');
    expect(statusOf(analysis, HUB_TARGET)).toBe('passed');
    expect(statusOf(analysis, RESTART_TARGET)).toBe('passed');
    expect(exitCodeForAnalysis(analysis)).toBe(1);

    const resetCase = analysis.cases.find((entry) => entry.targetLabel === RESET_TARGET.label);
    expect(resetCase).toMatchObject({
      outcome: 'flaky',
      retryCount: 1,
      firstError: 'Error: reset readout did not settle',
    });

    const output = describeE2eFlakes(analysis, 'reports/e2e.json').join('\n');
    expect(output).toContain(`chromium / ${RESET_TARGET.titleFragment}`);
    expect(output).toContain('重试次数：1');
    expect(output).toContain('首跑错误：Error: reset readout did not settle');
    expect(output).toContain('reports/e2e.json');
    expect(output).toContain('1/3 个目标未通过门禁');
  });

  it('fails when the hub target only passes after retries', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([
        targetCase(HUB_TARGET, ['failed', 'failed', 'passed']),
        targetCase(RESET_TARGET, ['passed']),
        targetCase(RESTART_TARGET, ['passed']),
      ]),
    );

    expect(analysis.status).toBe('flaky');
    expect(statusOf(analysis, HUB_TARGET)).toBe('flaky');
    expect(exitCodeForAnalysis(analysis)).toBe(1);
    expect(analysis.cases.find((entry) => entry.targetLabel === HUB_TARGET.label)?.retryCount).toBe(
      2,
    );

    const output = describeE2eFlakes(analysis).join('\n');
    expect(output).toContain(`mobile-webkit / ${HUB_TARGET.titleFragment}`);
    expect(output).toContain('重试次数：2');
  });

  it('fails when the sidebar restart target only passes after one retry', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([
        targetCase(HUB_TARGET, ['passed']),
        targetCase(RESET_TARGET, ['passed']),
        targetCase(
          RESTART_TARGET,
          ['failed', 'passed'],
          'Error: compact restart focus did not settle',
        ),
      ]),
    );

    expect(analysis.status).toBe('flaky');
    expect(statusOf(analysis, RESTART_TARGET)).toBe('flaky');
    expect(exitCodeForAnalysis(analysis)).toBe(1);
    expect(
      analysis.cases.find((entry) => entry.targetLabel === RESTART_TARGET.label),
    ).toMatchObject({
      projectName: 'mobile-webkit',
      outcome: 'flaky',
      retryCount: 1,
      firstError: 'Error: compact restart focus did not settle',
    });

    const output = describeE2eFlakes(analysis).join('\n');
    expect(output).toContain(`mobile-webkit / ${RESTART_TARGET.titleFragment}`);
    expect(output).toContain('重试次数：1');
    expect(output).toContain('首跑错误：Error: compact restart focus did not settle');
    expect(output).toContain('1/3 个目标未通过门禁');
  });

  it('does not repeat target failures that already failed the e2e step', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([
        targetCase(HUB_TARGET, ['failed', 'failed']),
        targetCase(RESET_TARGET, ['failed', 'failed']),
        targetCase(RESTART_TARGET, ['failed', 'failed']),
      ]),
    );

    expect(analysis.status).toBe('failed');
    expect(analysis.targets.map((entry) => entry.status)).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    expect(exitCodeForAnalysis(analysis)).toBe(0);

    const output = describeE2eFlakes(analysis).join('\n');
    expect(output).toContain('e2e 步骤已判失败，本检查不重复报错');
    expect(output).not.toContain('重试次数');
    expect(output).toContain('3 个目标通过门禁');
  });

  it('passes when one target failed outright and the others passed', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([
        targetCase(HUB_TARGET, ['failed']),
        targetCase(RESET_TARGET, ['passed']),
        targetCase(RESTART_TARGET, ['passed']),
      ]),
    );

    expect(analysis.status).toBe('failed');
    expect(exitCodeForAnalysis(analysis)).toBe(0);
    expect(describeE2eFlakes(analysis).join('\n')).toContain('3 个目标通过门禁');
  });

  it('fails when the reset target was skipped', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([
        targetCase(HUB_TARGET, ['passed']),
        targetCase(RESET_TARGET, ['skipped']),
        targetCase(RESTART_TARGET, ['passed']),
      ]),
    );

    expect(analysis.status).toBe('skipped');
    expect(statusOf(analysis, RESET_TARGET)).toBe('skipped');
    expect(exitCodeForAnalysis(analysis)).toBe(1);
    expect(describeE2eFlakes(analysis).join('\n')).toContain('被跳过');
  });

  it('fails when a target is marked as an expected failure', () => {
    // `test.fail()` is green in the e2e step, but it is not a stable first run.
    const expectedFailure = analyzeE2eFlakes(
      makeReport([
        {
          projectName: HUB_TARGET.projectName,
          title: HUB_TARGET.titleFragment,
          attempts: ['failed'],
          expectedStatus: 'failed',
        },
        targetCase(RESET_TARGET, ['passed']),
        targetCase(RESTART_TARGET, ['passed']),
      ]),
    );

    expect(expectedFailure.status).toBe('skipped');
    expect(statusOf(expectedFailure, HUB_TARGET)).toBe('skipped');
    expect(exitCodeForAnalysis(expectedFailure)).toBe(1);
    expect(describeE2eFlakes(expectedFailure).join('\n')).toContain('预期失败');
  });

  it('fails when a target status cannot be recognized', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([
        targetCase(HUB_TARGET, ['passed']),
        targetCase(RESET_TARGET, []),
        targetCase(RESTART_TARGET, ['passed']),
      ]),
    );

    expect(analysis.status).toBe('unknown');
    expect(statusOf(analysis, RESET_TARGET)).toBe('unknown');
    expect(exitCodeForAnalysis(analysis)).toBe(1);
    expect(describeE2eFlakes(analysis).join('\n')).toContain('状态无法识别');
  });

  it('fails when the report is missing the reset target', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([targetCase(HUB_TARGET, ['passed']), targetCase(RESTART_TARGET, ['passed'])]),
    );

    expect(analysis.status).toBe('missing');
    expect(statusOf(analysis, RESET_TARGET)).toBe('missing');
    expect(statusOf(analysis, HUB_TARGET)).toBe('passed');
    expect(statusOf(analysis, RESTART_TARGET)).toBe('passed');
    expect(exitCodeForAnalysis(analysis)).toBe(1);

    const output = describeE2eFlakes(analysis, 'reports/run.json').join('\n');
    expect(output).toContain(RESET_TARGET.label);
    expect(output).toContain('报告中缺失');
    expect(output).toContain('TARGET_CASES');
    expect(output).toContain('reports/run.json');
  });

  it('fails when the report is missing the hub target', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([targetCase(RESET_TARGET, ['passed']), targetCase(RESTART_TARGET, ['passed'])]),
    );

    expect(analysis.status).toBe('missing');
    expect(statusOf(analysis, HUB_TARGET)).toBe('missing');
    expect(statusOf(analysis, RESET_TARGET)).toBe('passed');
    expect(statusOf(analysis, RESTART_TARGET)).toBe('passed');
    expect(exitCodeForAnalysis(analysis)).toBe(1);
  });

  it('fails when the report is missing the sidebar restart target', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([targetCase(HUB_TARGET, ['passed']), targetCase(RESET_TARGET, ['passed'])]),
    );

    expect(analysis.status).toBe('missing');
    expect(statusOf(analysis, RESTART_TARGET)).toBe('missing');
    expect(statusOf(analysis, HUB_TARGET)).toBe('passed');
    expect(statusOf(analysis, RESET_TARGET)).toBe('passed');
    expect(exitCodeForAnalysis(analysis)).toBe(1);

    const output = describeE2eFlakes(analysis, 'reports/run.json').join('\n');
    expect(output).toContain(RESTART_TARGET.label);
    expect(output).toContain('报告中缺失');
  });

  it('fails when the report has no target case at all', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([{ projectName: 'mobile', title: HUB_TARGET.titleFragment, attempts: ['passed'] }]),
    );

    expect(analysis.status).toBe('missing');
    expect(analysis.targets.map((entry) => entry.status)).toEqual([
      'missing',
      'missing',
      'missing',
    ]);
    expect(exitCodeForAnalysis(analysis)).toBe(1);
    expect(describeE2eFlakes(analysis).join('\n')).toContain('3/3 个目标未通过门禁');
  });

  it('ignores flaky cases outside the guarded targets', () => {
    const analysis = analyzeE2eFlakes(
      makeReport([
        ...passingAll(),
        { projectName: 'chromium', title: 'desktop case', attempts: ['failed', 'passed'] },
        { projectName: 'mobile-webkit', title: 'other webkit case', attempts: ['failed', 'passed'] },
        { projectName: 'mobile', title: HUB_TARGET.titleFragment, attempts: ['failed', 'passed'] },
      ]),
    );

    expect(analysis.status).toBe('passed');
    expect(analysis.cases).toHaveLength(3);
    expect(exitCodeForAnalysis(analysis)).toBe(0);
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
    const file = writeReport(dir, makeReport(passingAll()));

    expect(readE2eReport(file).suites).toHaveLength(3);
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
  it('exits 0 when all target cases passed first', () => {
    const dir = makeTempDir();
    const report = writeReport(dir, makeReport(passingAll()));

    const { status, stdout, stderr } = runCli(['--report', report]);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain(HUB_TARGET.label);
    expect(stdout).toContain(RESET_TARGET.label);
    expect(stdout).toContain(RESTART_TARGET.label);
    expect(stdout).toContain('3 个目标通过门禁');
  });

  it('exits 1 and prints project/title/retry/error for a flaky reset target', () => {
    const dir = makeTempDir();
    const report = writeReport(
      dir,
      makeReport([
        targetCase(HUB_TARGET, ['passed']),
        targetCase(RESET_TARGET, ['failed', 'passed'], 'Error: first-run readout mismatch'),
        targetCase(RESTART_TARGET, ['passed']),
      ]),
    );

    const { status, stdout } = runCli(['--report', report]);

    expect(status).toBe(1);
    expect(stdout).toContain(`chromium / ${RESET_TARGET.titleFragment}`);
    expect(stdout).toContain('重试次数：1');
    expect(stdout).toContain('首跑错误：Error: first-run readout mismatch');
  });

  it('exits 1 for a flaky hub target', () => {
    const dir = makeTempDir();
    const report = writeReport(
      dir,
      makeReport([
        targetCase(HUB_TARGET, ['failed', 'passed'], 'Error: tap readout did not settle'),
        targetCase(RESET_TARGET, ['passed']),
        targetCase(RESTART_TARGET, ['passed']),
      ]),
    );

    const { status, stdout } = runCli(['--report', report]);

    expect(status).toBe(1);
    expect(stdout).toContain(`mobile-webkit / ${HUB_TARGET.titleFragment}`);
    expect(stdout).toContain('首跑错误：Error: tap readout did not settle');
  });

  it('exits 1 for a flaky sidebar restart target', () => {
    const dir = makeTempDir();
    const report = writeReport(
      dir,
      makeReport([
        targetCase(HUB_TARGET, ['passed']),
        targetCase(RESET_TARGET, ['passed']),
        targetCase(
          RESTART_TARGET,
          ['failed', 'passed'],
          'Error: compact restart focus did not settle',
        ),
      ]),
    );

    const { status, stdout } = runCli(['--report', report]);

    expect(status).toBe(1);
    expect(stdout).toContain(`mobile-webkit / ${RESTART_TARGET.titleFragment}`);
    expect(stdout).toContain('首跑错误：Error: compact restart focus did not settle');
  });

  it('exits 0 when all targets failed outright', () => {
    const dir = makeTempDir();
    const report = writeReport(
      dir,
      makeReport([
        targetCase(HUB_TARGET, ['failed', 'failed']),
        targetCase(RESET_TARGET, ['failed', 'failed']),
        targetCase(RESTART_TARGET, ['failed', 'failed']),
      ]),
    );

    const { status, stdout } = runCli(['--report', report]);

    expect(status).toBe(0);
    expect(stdout).toContain('e2e 步骤已判失败');
    expect(stdout).toContain('3 个目标通过门禁');
  });

  it('exits 0 when only another project or a non-target case is flaky', () => {
    const dir = makeTempDir();
    const report = writeReport(
      dir,
      makeReport([
        ...passingAll(),
        { projectName: 'chromium', title: 'desktop case', attempts: ['failed', 'passed'] },
        { projectName: 'mobile-webkit', title: 'other webkit case', attempts: ['failed', 'passed'] },
      ]),
    );

    const { status, stdout } = runCli(['--report', report]);

    expect(status).toBe(0);
    expect(stdout).toContain('3 个目标通过门禁');
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
    expect(stdout).toContain(HUB_TARGET.label);
    expect(stdout).toContain(RESET_TARGET.label);
    expect(stdout).toContain(RESTART_TARGET.label);
    expect(stdout).toContain('报告中缺失');
    expect(stdout).toContain('TARGET_CASES');
  });

  it('exits 1 when the report is missing one of the three targets', () => {
    const dir = makeTempDir();
    const report = writeReport(
      dir,
      makeReport([targetCase(RESET_TARGET, ['passed']), targetCase(RESTART_TARGET, ['passed'])]),
    );

    const { status, stdout } = runCli(['--report', report]);

    expect(status).toBe(1);
    expect(stdout).toContain(HUB_TARGET.label);
    expect(stdout).toContain('报告中缺失');
    expect(stdout).toContain('1/3 个目标未通过门禁');
  });

  it('reads the default CI report path from the working directory', () => {
    const dir = makeTempDir();
    const reportDir = join(dir, dirname(DEFAULT_E2E_REPORT_PATH));
    mkdirSync(reportDir, { recursive: true });
    writeReport(
      reportDir,
      makeReport(passingAll()),
      DEFAULT_E2E_REPORT_PATH.split('/').at(-1) ?? 'e2e-report.json',
    );

    const { status, stdout } = runCli([], dir);

    expect(status).toBe(0);
    expect(stdout).toContain('3 个目标通过门禁');
  });

  it('exits 0 for --help and 2 for a usage error', () => {
    const help = runCli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: node scripts/check-e2e-flakes.mjs');
    expect(help.stdout).toContain(HUB_TARGET.titleFragment);
    expect(help.stdout).toContain(RESET_TARGET.titleFragment);
    expect(help.stdout).toContain(RESTART_TARGET.titleFragment);
    expect(help.stdout).toContain('--report');

    const unknown = runCli(['--unknown']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown option: --unknown');

    expect(runCli(['--report']).status).toBe(2);
  });
});
