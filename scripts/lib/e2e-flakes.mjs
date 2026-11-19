import { readFileSync } from 'node:fs';

/**
 * Fail-on-flaky gate for the guarded first-run cases.
 *
 * Playwright's own `failOnFlakyTests` / `--fail-on-flaky-tests` applies to the
 * whole run, so enabling it would also turn the existing flaky cases in other
 * projects into PR failures (issue #164). Instead this module reads the JSON
 * report of the current run and only inspects the explicit targets in
 * `TARGET_CASES`: the framework phone case introduced for issue #117 and the
 * blank canvas reset case from issue #339.
 *
 * Retry policy, assertions and timeouts stay untouched: other cases keep
 * being recorded as flaky by `retries: 2`, while a report where a target case
 * only passes after a retry makes the dedicated CI step exit non-zero.
 */

/** JSON report written by the CI Playwright run (see `playwright.config.ts`). */
export const DEFAULT_E2E_REPORT_PATH = 'test-results/e2e-report.json';

/**
 * Explicit list of guarded first-run cases: project, title fragment and a
 * human-readable label. Adding a case here is the only way to widen the gate;
 * there is deliberately no global `failOnFlakyTests` switch.
 */
export const TARGET_CASES = [
  {
    label: 'framework 手机端（hub and blank canvas）',
    projectName: 'mobile-webkit',
    titleFragment: 'hub and blank canvas',
  },
  {
    label: 'blank canvas reset（reset centres the cursor）',
    projectName: 'chromium',
    titleFragment: 'reset centres the cursor and keyboard keeps working afterwards',
  },
];

/** Longest first-run error summary printed for a flaky case. */
const MAX_ERROR_SUMMARY_LENGTH = 240;

/** Target verdicts that let the gate pass; `failed` is already red in e2e. */
const PASSING_TARGET_STATUSES = new Set(['passed', 'failed']);

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

/**
 * Read and parse the Playwright JSON report at `filePath`.
 *
 * `filePath` is resolved from the command's working directory. CI runs the
 * check from the repository root, the same base Playwright uses to resolve the
 * reporter `outputFile` (its config directory), so the two paths agree.
 */
export function readE2eReport(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? `，${error.code}` : '';
    throw new E2eFlakesError(
      `报告缺失或不可读：${filePath}${code}；JSON 报告仅在 CI 下生成，请先运行 CI=true npm run test:e2e`,
    );
  }

  return parseE2eReport(text);
}

function normalizeErrorMessage(value) {
  const text = String(value)
    // Playwright error strings can carry ANSI colour codes. The control
    // character is intentional here (it is the start of an SGR escape), so
    // silence only this expression instead of changing the regex.
    // eslint-disable-next-line no-control-regex
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

  // `test.skip()` / `test.fail()` cases are not expected to pass, so a green
  // e2e step must not let them satisfy the first-run gate.
  if (typeof test.expectedStatus === 'string' && test.expectedStatus !== 'passed') {
    return 'skipped';
  }
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

function toTargetCase(target, spec, suite, test) {
  const results = testResults(test);
  const firstFailure = results.find((result) => result.status !== 'passed') ?? results[0];
  return {
    targetLabel: target.label,
    title: spec.title,
    projectName: test.projectName,
    file: spec.file ?? suite.file ?? '',
    line: typeof spec.line === 'number' ? spec.line : 0,
    outcome: classifyOutcome(test),
    retryCount: retryCountOf(results),
    firstError: summarizeResultError(firstFailure),
  };
}

/**
 * All cases matching any entry of `TARGET_CASES`, annotated with the target
 * label they matched. Each target is matched independently by project and
 * title fragment, so a case with the same title in another project is ignored.
 */
export function collectTargetCases(report) {
  const cases = [];
  for (const target of TARGET_CASES) {
    for (const suite of walkSuites(Array.isArray(report?.suites) ? report.suites : [])) {
      if (!Array.isArray(suite.specs)) continue;
      for (const spec of suite.specs) {
        if (!isRecord(spec) || typeof spec.title !== 'string') continue;
        if (!spec.title.includes(target.titleFragment)) continue;
        for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
          if (!isRecord(test) || test.projectName !== target.projectName) continue;
          cases.push(toTargetCase(target, spec, suite, test));
        }
      }
    }
  }
  return cases;
}

/**
 * First-run outcome counts for every entry of `TARGET_CASES`.
 *
 * The scheduled flake-watch repeats each guarded case (`--repeat-each=5`) with
 * retries disabled, so every result is a first run. Grouping the report by
 * target lets the job summary report each case separately instead of only the
 * combined `stats` block, which cannot say which case failed.
 */
export function summarizeTargetCases(report) {
  const cases = collectTargetCases(report);
  return TARGET_CASES.map((target) => {
    const targetCases = cases.filter((entry) => entry.targetLabel === target.label);
    const counts = {
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      unknown: 0,
      total: targetCases.length,
    };
    for (const entry of targetCases) {
      if (Object.hasOwn(counts, entry.outcome)) {
        counts[entry.outcome] += 1;
      }
    }
    return { target, counts, cases: targetCases };
  });
}

/**
 * Verdict for one target. `missing` means the report contains no case for the
 * target at all, which is a gate failure rather than a silent pass.
 */
function analyzeTarget(target, cases) {
  const targetCases = cases.filter((entry) => entry.targetLabel === target.label);
  if (targetCases.length === 0) return { target, status: 'missing', cases: [] };
  if (targetCases.some((entry) => entry.outcome === 'flaky')) {
    return { target, status: 'flaky', cases: targetCases };
  }
  if (targetCases.some((entry) => entry.outcome === 'failed')) {
    return { target, status: 'failed', cases: targetCases };
  }
  if (targetCases.some((entry) => entry.outcome === 'skipped')) {
    return { target, status: 'skipped', cases: targetCases };
  }
  if (targetCases.some((entry) => entry.outcome === 'unknown')) {
    return { target, status: 'unknown', cases: targetCases };
  }
  return { target, status: 'passed', cases: targetCases };
}

/**
 * Decide what the gate should say about the report.
 *
 * Every target is analyzed separately, and the gate fails when any target is:
 *
 * - `flaky`: the case failed first and only passed after a retry.
 * - `skipped`: the case was skipped (or marked as an expected failure), so
 *   first-run stability is not proven.
 * - `missing`: the report has no case for the target (renamed test, changed
 *   project or a filtered run), so the gate must not silently pass.
 * - `unknown`: the report has target cases but their state is not one of the
 *   states Playwright documents.
 *
 * `passed` and `failed` targets let the gate pass: a failed target already
 * failed the e2e step, so the dedicated check stays quiet instead of reporting
 * the same failure twice.
 */
export function analyzeE2eFlakes(report) {
  const cases = collectTargetCases(report);
  const targets = TARGET_CASES.map((target) => analyzeTarget(target, cases));

  const blocked = targets.find((entry) => !PASSING_TARGET_STATUSES.has(entry.status));
  let status;
  if (blocked) {
    status = blocked.status;
  } else {
    status = targets.some((entry) => entry.status === 'failed') ? 'failed' : 'passed';
  }

  return { status, targets, cases };
}

/**
 * Exit code for an analysis: 0 when every target passed first or already
 * failed the e2e step; 1 when any target is flaky, skipped, missing or
 * unrecognized.
 */
export function exitCodeForAnalysis(analysis) {
  return analysis.status === 'passed' || analysis.status === 'failed' ? 0 : 1;
}

const TARGET_VERDICTS = {
  passed: '首跑通过',
  flaky: '重试后通过（flaky），门禁判失败',
  failed: '失败，e2e 步骤已判失败',
  skipped: '被跳过或标记为预期失败，门禁无法确认首跑通过',
  unknown: '状态无法识别，门禁不接受',
  missing: '报告中缺失，门禁无法确认首跑稳定性',
};

/** Human-readable lines for one analysis; `reportPath` is only used in hints. */
export function describeE2eFlakes(analysis, reportPath = DEFAULT_E2E_REPORT_PATH) {
  const prefix = '[e2e-flakes]';
  const targets = Array.isArray(analysis.targets) ? analysis.targets : [];
  const lines = [];

  targets.forEach((entry, index) => {
    const target = entry.target;
    lines.push(
      `${prefix} 目标 ${index + 1}/${targets.length}：${target.label}` +
        `（project=${target.projectName}，标题含「${target.titleFragment}」）` +
        `— ${TARGET_VERDICTS[entry.status] ?? entry.status}`,
    );

    if (entry.status === 'missing') {
      lines.push(`  报告：${reportPath}`);
      lines.push('  若用例改名或换了 project，请同步 scripts/lib/e2e-flakes.mjs 的 TARGET_CASES。');
      return;
    }

    if (entry.status === 'flaky') {
      for (const item of entry.cases) {
        if (item.outcome !== 'flaky') continue;
        lines.push(`  ${item.projectName} / ${item.title}`);
        lines.push(`  重试次数：${item.retryCount}`);
        lines.push(`  首跑错误：${item.firstError ?? '未知错误'}`);
      }
      lines.push(`  报告：${reportPath}`);
      return;
    }

    for (const item of entry.cases) {
      lines.push(`  ${item.projectName} / ${item.title}`);
    }
    if (entry.status === 'failed') {
      lines.push('  e2e 步骤已判失败，本检查不重复报错。');
    }
    if (entry.status === 'skipped' || entry.status === 'unknown') {
      lines.push(`  报告：${reportPath}`);
    }
  });

  const blocked = targets.filter((entry) => !PASSING_TARGET_STATUSES.has(entry.status));
  lines.push(
    blocked.length === 0
      ? `${prefix} 结论：${targets.length} 个目标通过门禁`
      : `${prefix} 结论：${blocked.length}/${targets.length} 个目标未通过门禁`,
  );
  return lines;
}
