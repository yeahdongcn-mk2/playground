import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_E2E_REPORT_PATH, TARGET_CASES } from '../../scripts/lib/e2e-flakes.mjs';
import type {
  E2eFlakeTarget,
  PlaywrightJsonReport,
  PlaywrightJsonSpec,
  PlaywrightJsonTest,
} from '../../scripts/lib/e2e-flakes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUMMARY_SCRIPT = join(ROOT, 'scripts', 'flake-watch-summary.mjs');

/** One first-run repeat of a guarded case, as the JSON reporter records it. */
type RepeatOutcome = 'passed' | 'failed' | 'skipped' | 'flaky';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flake-watch-summary-'));
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

function targetFor(projectName: string): E2eFlakeTarget {
  const target = TARGET_CASES.find((entry) => entry.projectName === projectName);
  if (target === undefined) throw new Error(`TARGET_CASES is missing the ${projectName} case`);
  return target;
}

const MOBILE_TARGET = targetFor('mobile-webkit');
const RESET_TARGET = targetFor('chromium');

function testFor(projectName: string, repeat: RepeatOutcome): PlaywrightJsonTest {
  if (repeat === 'flaky') {
    return {
      projectName,
      status: 'flaky',
      expectedStatus: 'passed',
      results: [
        { status: 'failed', retry: 0, error: { message: 'first attempt failed' } },
        { status: 'passed', retry: 1 },
      ],
    };
  }
  if (repeat === 'failed') {
    return {
      projectName,
      status: 'unexpected',
      expectedStatus: 'passed',
      results: [{ status: 'failed', retry: 0, error: { message: 'repeat failed' } }],
    };
  }
  if (repeat === 'skipped') {
    return {
      projectName,
      status: 'skipped',
      expectedStatus: 'skipped',
      results: [{ status: 'skipped', retry: 0 }],
    };
  }
  return {
    projectName,
    status: 'expected',
    expectedStatus: 'passed',
    results: [{ status: 'passed', retry: 0 }],
  };
}

function specFor(target: E2eFlakeTarget, repeat: RepeatOutcome): PlaywrightJsonSpec {
  return {
    title: target.titleFragment,
    file: `tests/e2e/${target.projectName}.spec.ts`,
    line: 1,
    tests: [testFor(target.projectName, repeat)],
  };
}

function reportFor(entries: Array<{ target: E2eFlakeTarget; repeats: RepeatOutcome[] }>): PlaywrightJsonReport {
  return {
    config: {},
    errors: [],
    stats: {},
    suites: entries.map(({ target, repeats }) => ({
      title: `${target.projectName}.spec.ts`,
      file: `tests/e2e/${target.projectName}.spec.ts`,
      specs: repeats.map((repeat) => specFor(target, repeat)),
    })),
  };
}

const repeatsOf = (outcome: RepeatOutcome, count = 5): RepeatOutcome[] =>
  Array.from({ length: count }, () => outcome);

function writeReport(dir: string, report: PlaywrightJsonReport): string {
  const file = join(dir, DEFAULT_E2E_REPORT_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report));
  return file;
}

function runSummary(dir: string, { outcome = 'success' } = {}): string {
  return execFileSync(process.execPath, [SUMMARY_SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, FLAKE_WATCH_OUTCOME: outcome, FLAKE_WATCH_REPORT_PATH: '' },
  });
}

/** One `### <label>` section of the rendered job summary. */
function section(summary: string, label: string): string {
  const marker = `### ${label}`;
  const start = summary.indexOf(marker);
  if (start < 0) {
    throw new Error(`the summary is missing the ${marker} section`);
  }
  const next = summary.indexOf('\n### ', start + marker.length);
  return summary.slice(start, next === -1 ? undefined : next);
}

describe('flake-watch summary', () => {
  it('reports both guarded cases separately when all five first runs pass', () => {
    const dir = makeTempDir();
    writeReport(
      dir,
      reportFor([
        { target: MOBILE_TARGET, repeats: repeatsOf('passed') },
        { target: RESET_TARGET, repeats: repeatsOf('passed') },
      ]),
    );

    const summary = runSummary(dir);
    expect(summary).toContain('## guarded first-run stability（flake-watch）');
    expect(summary).toContain('重复次数：5');
    expect(summary).toContain('重试次数：0');
    expect(summary).toContain('结果：success');

    for (const target of TARGET_CASES) {
      const targetSection = section(summary, target.label);
      expect(targetSection).toContain(`- project：${target.projectName}`);
      expect(targetSection).toContain(`- 标题包含：${target.titleFragment}`);
      expect(targetSection).toContain('首跑通过：5');
      expect(targetSection).toContain('失败：0');
      expect(targetSection).toContain('重试后通过：0');
      expect(targetSection).toContain('跳过：0');
    }
  });

  it('attributes a failed repeat to the case it belongs to', () => {
    const dir = makeTempDir();
    writeReport(
      dir,
      reportFor([
        { target: MOBILE_TARGET, repeats: repeatsOf('passed') },
        {
          target: RESET_TARGET,
          repeats: ['passed', 'passed', 'failed', 'passed', 'passed'],
        },
      ]),
    );

    const summary = runSummary(dir, { outcome: 'failure' });
    expect(summary).toContain('结果：failure');
    expect(section(summary, RESET_TARGET.label)).toContain('首跑通过：4');
    expect(section(summary, RESET_TARGET.label)).toContain('失败：1');
    // The other case keeps its own tally instead of inheriting the failure.
    expect(section(summary, MOBILE_TARGET.label)).toContain('首跑通过：5');
    expect(section(summary, MOBILE_TARGET.label)).toContain('失败：0');
  });

  it('counts a retried pass as flaky for the owning case', () => {
    const dir = makeTempDir();
    writeReport(
      dir,
      reportFor([
        { target: MOBILE_TARGET, repeats: repeatsOf('passed') },
        { target: RESET_TARGET, repeats: ['passed', 'flaky', 'passed', 'passed', 'passed'] },
      ]),
    );

    const targetSection = section(runSummary(dir), RESET_TARGET.label);
    expect(targetSection).toContain('首跑通过：4');
    expect(targetSection).toContain('重试后通过：1');
    expect(targetSection).toContain('失败：0');
  });

  it('counts skipped repeats as skipped, not as a pass', () => {
    const dir = makeTempDir();
    writeReport(
      dir,
      reportFor([
        { target: MOBILE_TARGET, repeats: repeatsOf('passed') },
        { target: RESET_TARGET, repeats: ['skipped', 'passed', 'passed', 'passed', 'passed'] },
      ]),
    );

    const targetSection = section(runSummary(dir), RESET_TARGET.label);
    expect(targetSection).toContain('首跑通过：4');
    expect(targetSection).toContain('跳过：1');
  });

  it('flags a guarded case that is missing from the report', () => {
    const dir = makeTempDir();
    const report = reportFor([{ target: MOBILE_TARGET, repeats: repeatsOf('passed') }]);
    writeReport(dir, report);

    const summary = runSummary(dir);
    expect(section(summary, MOBILE_TARGET.label)).toContain('首跑通过：5');
    const missing = section(summary, RESET_TARGET.label);
    expect(missing).toContain('缺失');
    expect(missing).toContain('TARGET_CASES');
  });

  it('keeps a readable summary when the report file is missing', () => {
    const dir = makeTempDir();
    const summary = runSummary(dir, { outcome: 'failure' });
    expect(summary).toContain('结果：failure');
    expect(summary).toContain('无法读取 Playwright JSON 报告');
  });

  it('rejects a JSON document that is not a Playwright report', () => {
    const dir = makeTempDir();
    writeReport(dir, { config: {}, errors: [], stats: {} });
    const summary = runSummary(dir);
    expect(summary).toContain('无法读取 Playwright JSON 报告');
    expect(summary).toContain('缺少顶层 suites 数组');
  });
});
