import { readFileSync } from 'node:fs';

/**
 * Fail-on-flaky gate for one Playwright case in the `mobile-webkit` project.
 *
 * Playwright's own `failOnFlakyTests` / `--fail-on-flaky-tests` applies to the
 * whole run, so enabling it would also turn the existing flaky cases in other
 * projects into PR failures (issue #164). Instead this module reads the JSON
 * report of the current run and only inspects project `mobile-webkit` cases
 * whose title contains `hub and blank canvas`, the framework phone case
 * introduced for issue #117.
 *
 * Retry policy, assertions and timeouts stay untouched: other cases keep
 * being recorded as flaky by `retries: 2`, while a report where the target
 * case only passes after a retry makes the dedicated CI step exit non-zero.
 */

/** JSON report written by the CI Playwright run (see `playwright.config.ts`). */
export const DEFAULT_E2E_REPORT_PATH = 'test-results/e2e-report.json';

/** Project that owns the guarded framework phone case. */
export const TARGET_PROJECT_NAME = 'mobile-webkit';

/** Title fragment that identifies the guarded framework phone case. */
export const TARGET_TITLE_FRAGMENT = 'hub and blank canvas';

/** Longest first-run error summary printed for a flaky case. */
const MAX_ERROR_SUMMARY_LENGTH = 240;

/** Raised when the report cannot be read or is not a Playwright JSON report. */
export class E2eFlakesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'E2eFlakesError';
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorDetail(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse the text of a Playwright JSON report.
 *
 * A JSON document without a top-level `suites` array is not a Playwright
 * report (for example an empty object left by a broken writer), so it is
 * rejected instead of silently yielding "no target case".
 */
export function parseE2eReport(text) {
  let report;
  try {
    report = JSON.parse(String(text));
  } catch (error) {
    throw new E2eFlakesError(`无法解析 Playwright JSON 报告：${errorDetail(error)}`);
  }

  if (!isRecord(report) || !Array.isArray(report.suites)) {
    throw new E2eFlakesError('无法解析 Playwright JSON 报告：缺少顶层 suites 数组');
  }

  return report;
}

/** Read and parse the Playwright JSON report at `filePath`. */
export function readE2eReport(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? `，${error.code}` : '';
    throw new E2eFlakesError(
      `报告缺失或不可读：${filePath}${code}；请先在本 job 运行 npm run test:e2e`,
    );
  }

  return parseE2eReport(text);
}

function normalizeErrorMessage(value) {
  const text = String(value)
    // Playwright error strings can carry ANSI colour codes.
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (text === undefined) return null;
  return text.length > MAX_ERROR_SUMMARY_LENGTH
    ? `${text.slice(0, MAX_ERROR_SUMMARY_LENGTH - 1)}…`
    : text;
}

/**
 * First non-empty line of the first failure recorded for one test result.
 *
 * The JSON reporter stores the raw `error` object on each result and the
 * formatted errors in `errors`, so both shapes are read.
 */
export function summarizeResultError(result) {
  if (!isRecord(result)) return null;

  const candidates = [];
  if (typeof result.error === 'string') {
    candidates.push(result.error);
  } else if (isRecord(result.error)) {
    candidates.push(result.error.message, result.error.value);
  }
  if (Array.isArray(result.errors)) {
    for (const entry of result.errors) {
      if (typeof entry === 'string') {
        candidates.push(entry);
      } else if (isRecord(entry)) {
        candidates.push(entry.message, entry.value);
      }
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const summary = normalizeErrorMessage(candidate);
    if (summary !== null) return summary;
  }
  return null;
}

function* walkSuites(suites) {
  for (const suite of suites) {
    if (!isRecord(suite)) continue;
    yield suite;
    if (Array.isArray(suite.suites)) yield* walkSuites(suite.suites);
  }
}

function testResults(test) {
  return Array.isArray(test.results) ? test.results.filter(isRecord) : [];
}

function classifyOutcome(test) {
  const results = testResults(test);
  const statuses = results.map((result) => result.status);
  const firstStatus = statuses[0];
  const passedIndex = statuses.indexOf('passed');

  if (test.status === 'flaky' || (passedIndex > 0 && firstStatus !== 'passed')) {
    return 'flaky';
  }
  if (test.status === 'skipped' || firstStatus === 'skipped') {
    return 'skipped';
  }
  if (test.status === 'unexpected' || (results.length > 0 && passedIndex === -1)) {
    return 'failed';
  }
  if (test.status === 'expected' && passedIndex === 0) {
    return 'passed';
  }
  return 'unknown';
}

function retryCountOf(results) {
  const passedIndex = results.findIndex((result) => result.status === 'passed');
  if (passedIndex <= 0) return 0;
  const retry = results[passedIndex]?.retry;
  return typeof retry === 'number' && Number.isInteger(retry) && retry >= 0 ? retry : passedIndex;
}

function toTargetCase(spec, suite, test) {
  const results = testResults(test);
  const firstFailure = results.find((result) => result.status !== 'passed') ?? results[0];
  return {
    title: spec.title,
    projectName: test.projectName,
    file: spec.file ?? suite.file ?? '',
    line: typeof spec.line === 'number' ? spec.line : 0,
    outcome: classifyOutcome(test),
    retryCount: retryCountOf(results),
    firstError: summarizeResultError(firstFailure),
  };
}

/** All `mobile-webkit` tests whose spec title contains the target fragment. */
export function collectTargetCases(report) {
  const cases = [];
  for (const suite of walkSuites(Array.isArray(report?.suites) ? report.suites : [])) {
    if (!Array.isArray(suite.specs)) continue;
    for (const spec of suite.specs) {
      if (!isRecord(spec) || typeof spec.title !== 'string') continue;
      if (!spec.title.includes(TARGET_TITLE_FRAGMENT)) continue;
      for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
        if (!isRecord(test) || test.projectName !== TARGET_PROJECT_NAME) continue;
        cases.push(toTargetCase(spec, suite, test));
      }
    }
  }
  return cases;
}

/**
 * Decide what the gate should say about the report.
 *
 * - `passed`: every target case passed on its first attempt.
 * - `flaky`: a target case failed first and only passed after a retry.
 * - `failed`: the target case failed; the e2e step already failed the job, so
 *   this check stays quiet instead of reporting the same failure twice.
 * - `skipped`: the target case was skipped, so first-run stability is not
 *   proven.
 * - `missing`: the report has no target case (renamed/removed test or a
 *   filtered run), which must not silently disable the gate.
 * - `unknown`: the report has target cases but their state is not one of the
 *   states Playwright documents; do not silently pass.
 */
export function analyzeE2eFlakes(report) {
  const cases = collectTargetCases(report);

  if (cases.length === 0) return { status: 'missing', cases };
  if (cases.some((entry) => entry.outcome === 'flaky')) return { status: 'flaky', cases };
  if (cases.some((entry) => entry.outcome === 'failed')) return { status: 'failed', cases };
  if (cases.some((entry) => entry.outcome === 'skipped')) return { status: 'skipped', cases };
  if (cases.some((entry) => entry.outcome === 'unknown')) return { status: 'unknown', cases };
  return { status: 'passed', cases };
}

/** Exit code for an analysis: only a first-run pass (or an already failed e2e) is 0. */
export function exitCodeForAnalysis(analysis) {
  return analysis.status === 'passed' || analysis.status === 'failed' ? 0 : 1;
}

/** Human-readable lines for one analysis; `reportPath` is only used in hints. */
export function describeE2eFlakes(analysis, reportPath = DEFAULT_E2E_REPORT_PATH) {
  const prefix = '[e2e-flakes]';
  const target = `project=${TARGET_PROJECT_NAME} 且标题含「${TARGET_TITLE_FRAGMENT}」`;
  const location = (entry) => `${entry.projectName} / ${entry.title}`;

  if (analysis.status === 'passed') {
    return [
      `${prefix} 目标用例首跑通过：${analysis.cases.length} 个用例`,
      ...analysis.cases.map((entry) => `  ${location(entry)}`),
    ];
  }

  if (analysis.status === 'flaky') {
    const lines = [`${prefix} 目标用例重试后通过，CI 判失败：`];
    for (const entry of analysis.cases) {
      if (entry.outcome !== 'flaky') continue;
      lines.push(`  ${location(entry)}`);
      lines.push(`  重试次数：${entry.retryCount}`);
      lines.push(`  首跑错误：${entry.firstError ?? '未知错误'}`);
    }
    lines.push(`  报告：${reportPath}`);
    return lines;
  }

  if (analysis.status === 'failed') {
    return [
      `${prefix} 目标用例失败：`,
      ...analysis.cases
        .filter((entry) => entry.outcome === 'failed')
        .map((entry) => `  ${location(entry)}`),
      '  e2e 步骤已判失败，本检查不重复报错。',
    ];
  }

  if (analysis.status === 'skipped') {
    return [
      `${prefix} 目标用例被跳过，门禁无法确认首跑通过：`,
      ...analysis.cases
        .filter((entry) => entry.outcome === 'skipped')
        .map((entry) => `  ${location(entry)}`),
      `  报告：${reportPath}`,
    ];
  }

  if (analysis.status === 'unknown') {
    return [
      `${prefix} 目标用例状态无法识别，门禁不接受：`,
      ...analysis.cases
        .filter((entry) => entry.outcome === 'unknown')
        .map((entry) => `  ${location(entry)}`),
      `  报告：${reportPath}`,
    ];
  }

  return [
    `${prefix} 报告中没有找到 ${target} 的用例，门禁无法确认首跑稳定性：`,
    `  报告：${reportPath}`,
    '  请确认用例仍在 mobile-webkit project 中运行，且报告来自本次完整 e2e。',
  ];
}
