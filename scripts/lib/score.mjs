/**
 * Build a health snapshot from the output of the six repository check entry
 * points: lint, check:budget, verify:doc-counts, verify:screenshots:doc-dims,
 * verify:screenshots:sha256 and verify:screenshots:webkit.
 *
 * This module never runs a check and never re-implements a validation rule.
 * `scripts/score.mjs` captures each entry point's stdout/stderr and exit
 * status, then passes them here; parsing stays pure so the unit tests can use
 * fixed fixtures instead of spawning npm.
 */

/** The six checks, their npm scripts and the success marker in their output. */
export const CHECK_DEFINITIONS = [
  {
    name: 'lint',
    script: 'lint',
    successPattern: /Module boundaries OK/,
  },
  {
    name: 'check:budget',
    script: 'check:budget',
    successPattern: /Budget check OK:/,
    // check:budget exits 1 both for a budget violation and for a missing dist/
    // build, so only the printed violation block counts as a validation fail.
    failurePattern: /Budget check failed:/,
  },
  {
    name: 'verify:doc-counts',
    script: 'verify:doc-counts',
    successPattern: /单测计数均为 \d+，与 Vitest numTotalTests 一致/,
  },
  {
    name: 'verify:screenshots:doc-dims',
    script: 'verify:screenshots:doc-dims',
    successPattern: /尺寸与 sha256 全部一致/,
  },
  {
    name: 'verify:screenshots:sha256',
    script: 'verify:screenshots:sha256',
    successPattern: /\d+ screenshot sha256 entries verified/,
  },
  {
    name: 'verify:screenshots:webkit',
    script: 'verify:screenshots:webkit',
    successPattern: /\d+ WebKit screenshot artifacts verified/,
  },
];

const ENTRY_GZIP_PATTERN = /Entry JS:.*?\(([\d.]+) KB gzip\)/;
const TOTAL_JS_GZIP_PATTERN = /All JS chunks:\s*([\d.]+) KB gzip/;
const UNIT_TESTS_FIELD_PATTERN = /numTotalTests\s*[=:]\s*(\d+)/;
const UNIT_TESTS_OK_PATTERN = /单测计数均为\s*(\d+)/;
const MISSING_SCRIPT_PATTERN = /Missing script:/i;

/** Convert the KB number printed by check:budget to whole bytes. */
export function kbToBytes(kilobytes) {
  return Math.round(kilobytes * 1024);
}

function combinedOutput(result) {
  if (result === undefined || result === null) return '';
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

/** First non-empty line of stderr/stdout, trimmed and bounded for the error map. */
function summarizeOutput(result) {
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
    }
  }
  return '';
}

/** Convert one captured KB figure to whole bytes; unparseable input is null. */
function parseKilobytes(match) {
  if (match === null) return null;
  const kilobytes = Number(match[1]);
  return Number.isFinite(kilobytes) ? kbToBytes(kilobytes) : null;
}

/**
 * Parse the two gzip sizes printed by `npm run check:budget`.
 *
 * A missing line or a number that does not parse yields null for that value
 * instead of throwing, so a partially broken budget run still produces the
 * rest of the snapshot and cannot inject NaN into the baseline.
 *
 * @returns {{ entryGzipBytes: number | null, totalJsGzipBytes: number | null }}
 */
export function parseBudgetMetrics(output) {
  const text = String(output ?? '');
  const entry = ENTRY_GZIP_PATTERN.exec(text);
  const total = TOTAL_JS_GZIP_PATTERN.exec(text);

  return {
    entryGzipBytes: parseKilobytes(entry),
    totalJsGzipBytes: parseKilobytes(total),
  };
}

/**
 * Read the measured `numTotalTests` from `npm run verify:doc-counts` output.
 *
 * The passing line says "单测计数均为 N"; the failing line also reports
 * "实测 numTotalTests=N". Either form is accepted so a count mismatch still
 * yields a usable snapshot.
 *
 * @returns {number | null}
 */
export function parseUnitTests(output) {
  const text = String(output ?? '');
  const measured = UNIT_TESTS_FIELD_PATTERN.exec(text);
  if (measured !== null) return Number(measured[1]);

  const documented = UNIT_TESTS_OK_PATTERN.exec(text);
  if (documented !== null) return Number(documented[1]);

  return null;
}

/**
 * Classify one captured entry point.
 *
 * - pass: exit code 0 and the expected success marker is present
 * - fail: the check ran and reported a validation failure (exit code 1, or
 *   check:budget's printed violation block; four entry points document exit
 *   code 2 as a usage/I/O error rather than a validation result)
 * - null: the script was not run, could not start, is missing, exited 0
 *   without a recognisable success marker, or hit an execution error
 *
 * @returns {{ status: 'pass' | 'fail' | null, reason: string | null }}
 */
export function classifyCheckResult(definition, result) {
  if (result === undefined || result === null) {
    return {
      status: null,
      reason: `npm run ${definition.script} was not executed`,
    };
  }
  if (result.error) {
    return {
      status: null,
      reason: `npm run ${definition.script} failed to start: ${result.error}`,
    };
  }

  const output = combinedOutput(result);
  if (MISSING_SCRIPT_PATTERN.test(output)) {
    return {
      status: null,
      reason: `npm script "${definition.script}" is missing`,
    };
  }
  if (typeof result.status !== 'number') {
    const signal = result.signal ? ` (signal ${result.signal})` : '';
    return {
      status: null,
      reason: `npm run ${definition.script} did not report an exit status${signal}`,
    };
  }
  if (result.status === 0) {
    if (definition.successPattern.test(output)) {
      return { status: 'pass', reason: null };
    }
    return {
      status: null,
      reason: `npm run ${definition.script} exited 0 but its output did not contain the expected success marker`,
    };
  }

  const summary = summarizeOutput(result);
  const detail = summary === '' ? '' : `: ${summary}`;

  if (definition.failurePattern !== undefined) {
    return definition.failurePattern.test(output)
      ? { status: 'fail', reason: null }
      : {
          status: null,
          reason: `npm run ${definition.script} exited with code ${result.status} but did not report a validation failure${detail}`,
        };
  }

  if (result.status === 1) {
    return { status: 'fail', reason: null };
  }

  return {
    status: null,
    reason: `npm run ${definition.script} exited with code ${result.status} (execution error)${detail}`,
  };
}

function buildFailureReason(build) {
  if (build.error) return `npm run build failed to start: ${build.error}`;
  if (typeof build.status !== 'number') {
    const signal = build.signal ? ` (signal ${build.signal})` : '';
    return `npm run build did not report an exit status${signal}`;
  }
  if (build.status !== 0) return `npm run build exited with code ${build.status}`;
  return null;
}

/**
 * Assemble the snapshot consumed by the CLI.
 *
 * Every metric and check degrades to null with a reason in `error`; nothing
 * here throws for missing entries or unparseable output, so one broken check
 * cannot hide the rest of the snapshot.
 *
 * @param {{
 *   results: Array<{
 *     name: string,
 *     script?: string,
 *     status: number | null,
 *     signal?: string | null,
 *     stdout?: string,
 *     stderr?: string,
 *     error?: string | null,
 *   }>,
 *   build?: object | null,
 *   gitCommit: string | null,
 *   gitCommitError?: string | null,
 *   generatedAt: string,
 * }} options
 * @returns {{
 *   unitTests: number | null,
 *   entryGzipBytes: number | null,
 *   totalJsGzipBytes: number | null,
 *   checks: Record<string, 'pass' | 'fail' | null>,
 *   gitCommit: string | null,
 *   generatedAt: string,
 *   error: Record<string, string>,
 * }}
 */
export function buildSnapshot({
  results,
  build = null,
  gitCommit,
  gitCommitError = null,
  generatedAt,
}) {
  if (!Array.isArray(results)) {
    throw new TypeError('results must be an array');
  }
  if (typeof generatedAt !== 'string' || generatedAt === '') {
    throw new TypeError('generatedAt must be a non-empty ISO timestamp string');
  }

  const byName = new Map();
  for (const result of results) {
    if (result !== null && typeof result === 'object' && typeof result.name === 'string') {
      byName.set(result.name, result);
    }
  }

  const checks = {};
  const error = {};

  for (const definition of CHECK_DEFINITIONS) {
    const classified = classifyCheckResult(definition, byName.get(definition.name));
    checks[definition.name] = classified.status;
    if (classified.reason !== null) {
      error[definition.name] = classified.reason;
    }
  }

  if (build !== null) {
    const reason = buildFailureReason(build);
    if (reason !== null) error.build = reason;
  }

  const budget = parseBudgetMetrics(combinedOutput(byName.get('check:budget')));
  if (budget.entryGzipBytes === null) {
    error.entryGzipBytes = 'check:budget output did not report the entry gzip size';
  }
  if (budget.totalJsGzipBytes === null) {
    error.totalJsGzipBytes = 'check:budget output did not report the total JS gzip size';
  }

  const unitTests = parseUnitTests(combinedOutput(byName.get('verify:doc-counts')));
  if (unitTests === null) {
    error.unitTests = 'verify:doc-counts output did not report numTotalTests';
  }

  const commit =
    typeof gitCommit === 'string' && gitCommit.trim() !== '' ? gitCommit.trim() : null;
  if (commit === null) {
    error.gitCommit = gitCommitError ?? 'git rev-parse HEAD did not report a commit hash';
  }

  return {
    unitTests,
    entryGzipBytes: budget.entryGzipBytes,
    totalJsGzipBytes: budget.totalJsGzipBytes,
    checks,
    gitCommit: commit,
    generatedAt,
    error,
  };
}

function displayWidth(text) {
  let width = 0;
  for (const character of text) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(
      character,
    )
      ? 2
      : 1;
  }
  return width;
}

function padDisplay(text, width) {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
}

function formatValue(value) {
  return value === null || value === undefined ? 'null' : String(value);
}

/** Metrics compared against the baseline, in table order. */
const COMPARED_METRICS = [
  { name: 'unitTests', lowerIsBetter: false },
  { name: 'entryGzipBytes', lowerIsBetter: true },
  { name: 'totalJsGzipBytes', lowerIsBetter: true },
];

/** Raised when the baseline file cannot be read as a valid score baseline. */
export class ScoreBaselineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScoreBaselineError';
  }
}

function describeValue(value) {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readBaselineMetric(report, name, source) {
  if (!(name in report)) {
    throw new ScoreBaselineError(`${source}: 缺少字段 ${name}`);
  }
  const value = report[name];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ScoreBaselineError(
      `${source}: ${name} 必须是 >= 0 的整数或 null（实际：${describeValue(value)}）`,
    );
  }
  return value;
}

function readBaselineChecks(report, source) {
  const value = report.checks;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScoreBaselineError(
      `${source}: checks 必须是对象（实际：${describeValue(value)}）`,
    );
  }

  const checks = {};
  for (const definition of CHECK_DEFINITIONS) {
    if (!(definition.name in value)) {
      throw new ScoreBaselineError(`${source}: 缺少字段 checks.${definition.name}`);
    }
    const status = value[definition.name];
    if (status !== null && status !== 'pass' && status !== 'fail') {
      throw new ScoreBaselineError(
        `${source}: checks.${definition.name} 必须是 pass、fail 或 null（实际：${describeValue(status)}）`,
      );
    }
    checks[definition.name] = status;
  }
  return checks;
}

/**
 * Parse `docs/score-baseline.json`.
 *
 * Null metrics and null checks are valid (the collection step tolerates an
 * entry point that could not be evaluated), but a missing field or a wrong
 * type is a corrupt baseline: the caller must ask the user to regenerate it
 * with `--update` instead of comparing against garbage.
 *
 * @returns {{
 *   unitTests: number | null,
 *   entryGzipBytes: number | null,
 *   totalJsGzipBytes: number | null,
 *   checks: Record<string, 'pass' | 'fail' | null>,
 * }}
 */
export function parseBaseline(text, source = 'docs/score-baseline.json') {
  let report;
  try {
    report = JSON.parse(String(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScoreBaselineError(`${source}: 不是合法的 JSON（${detail}）`);
  }

  if (typeof report !== 'object' || report === null || Array.isArray(report)) {
    throw new ScoreBaselineError(`${source}: 顶层必须是 JSON 对象`);
  }

  return {
    unitTests: readBaselineMetric(report, 'unitTests', source),
    entryGzipBytes: readBaselineMetric(report, 'entryGzipBytes', source),
    totalJsGzipBytes: readBaselineMetric(report, 'totalJsGzipBytes', source),
    checks: readBaselineChecks(report, source),
  };
}

/** Reduce a snapshot to the comparable values stored in the baseline file. */
export function createBaseline(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') {
    throw new TypeError('snapshot must be an object');
  }

  const checks = {};
  for (const definition of CHECK_DEFINITIONS) {
    checks[definition.name] = snapshot.checks?.[definition.name] ?? null;
  }

  return {
    unitTests: snapshot.unitTests ?? null,
    entryGzipBytes: snapshot.entryGzipBytes ?? null,
    totalJsGzipBytes: snapshot.totalJsGzipBytes ?? null,
    checks,
  };
}

/** Render a baseline object as the on-disk JSON file contents. */
export function serializeBaseline(baseline) {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

/**
 * List the reasons a snapshot cannot become a trustworthy baseline.
 *
 * `--update` must not silently persist a half-captured snapshot: a null,
 * negative or non-integer metric, or a null / unrecognised check, disables
 * the corresponding regression check on every later run. `gitCommit` is only
 * run metadata and is not stored in the baseline, so a failed
 * `git rev-parse` does not make the values incomplete.
 *
 * @returns {string[]} one human-readable line per invalid value; empty when
 *   every baseline field was measured.
 */
export function findSnapshotGaps(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') {
    throw new TypeError('snapshot must be an object');
  }

  const error = snapshot.error ?? {};
  const gaps = [];
  const reported = new Set();

  const report = (key, fallback) => {
    const reason = error[key];
    gaps.push(typeof reason === 'string' && reason !== '' ? `${key}: ${reason}` : fallback);
    reported.add(key);
  };

  for (const metric of COMPARED_METRICS) {
    const value = snapshot[metric.name];
    // Mirror parseBaseline's validation: a NaN or negative value would break
    // the regression maths and must never be written to the baseline.
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      report(metric.name, `${metric.name} 无法获取`);
    }
  }
  for (const definition of CHECK_DEFINITIONS) {
    const value = snapshot.checks?.[definition.name];
    if (value === null || value === undefined) {
      report(definition.name, `${definition.name} 无法获取`);
    } else if (value !== 'pass' && value !== 'fail') {
      // Mirror parseBaseline: an unrecognised status would corrupt the file
      // and fail the next comparison with a baseline error.
      report(definition.name, `${definition.name} 状态无效`);
    }
  }

  // Surface every remaining error entry (including build failures) so a
  // future collection step cannot hide a gap behind a key `--update` does not
  // know about.
  for (const [key, reason] of Object.entries(error)) {
    if (key === 'gitCommit' || reported.has(key)) continue;
    gaps.push(`${key}: ${reason}`);
  }

  return gaps;
}

function compareMetricRow(name, current, baseline, lowerIsBetter) {
  const row = {
    kind: 'metric',
    name,
    current,
    baseline,
    delta: null,
    deltaLabel: '-',
    verdict: 'unknown',
  };

  if (typeof current !== 'number' || typeof baseline !== 'number') {
    // Two nulls are still "the same"; a single null cannot be compared.
    if (current === baseline) {
      row.verdict = 'unchanged';
    }
    return row;
  }

  const delta = current - baseline;
  row.delta = delta;
  row.deltaLabel = delta > 0 ? `+${delta}` : String(delta);

  if (delta === 0) {
    row.verdict = 'unchanged';
  } else if (lowerIsBetter) {
    row.verdict = delta < 0 ? 'improved' : 'regressed';
  } else {
    row.verdict = delta > 0 ? 'improved' : 'regressed';
  }
  return row;
}

function compareCheckRow(name, current, baseline) {
  const row = {
    kind: 'check',
    name,
    current,
    baseline,
    delta: null,
    deltaLabel: '-',
    verdict: 'unchanged',
  };

  if (current === baseline) return row;
  if (baseline === 'pass' && current === 'fail') {
    row.verdict = 'regressed';
    row.deltaLabel = 'pass → fail';
  } else if (baseline === 'fail' && current === 'pass') {
    row.verdict = 'improved';
    row.deltaLabel = 'fail → pass';
  } else {
    // A null on either side means the entry point could not be evaluated;
    // that is reported as unknown rather than guessed as a regression.
    row.verdict = 'unknown';
    row.deltaLabel = `${formatValue(baseline)} → ${formatValue(current)}`;
  }
  return row;
}

/**
 * Compare a fresh snapshot with the baseline.
 *
 * Regression rules: fewer unit tests, larger entry / total JS gzip size, or a
 * check moving from pass to fail. Improvements and unchanged values never
 * cause a non-zero exit. Null metrics or checks are reported as `unknown`
 * instead of throwing.
 *
 * @returns {{
 *   rows: Array<{
 *     kind: 'metric' | 'check',
 *     name: string,
 *     current: number | string | null,
 *     baseline: number | string | null,
 *     delta: number | null,
 *     deltaLabel: string,
 *     verdict: 'improved' | 'regressed' | 'unchanged' | 'unknown',
 *   }>,
 *   regressed: Array<object>,
 *   improved: Array<object>,
 *   unchanged: Array<object>,
 *   unknown: Array<object>,
 *   status: 'improved' | 'regressed' | 'unchanged',
 *   errors: Record<string, string>,
 * }}
 */
export function compareSnapshot(snapshot, baseline) {
  const rows = [];

  for (const metric of COMPARED_METRICS) {
    rows.push(
      compareMetricRow(metric.name, snapshot[metric.name], baseline[metric.name], metric.lowerIsBetter),
    );
  }
  for (const definition of CHECK_DEFINITIONS) {
    rows.push(
      compareCheckRow(
        definition.name,
        snapshot.checks?.[definition.name] ?? null,
        baseline.checks?.[definition.name] ?? null,
      ),
    );
  }

  const regressed = rows.filter((row) => row.verdict === 'regressed');
  const improved = rows.filter((row) => row.verdict === 'improved');
  const unchanged = rows.filter((row) => row.verdict === 'unchanged');
  const unknown = rows.filter((row) => row.verdict === 'unknown');

  return {
    rows,
    regressed,
    improved,
    unchanged,
    unknown,
    status: regressed.length > 0 ? 'regressed' : improved.length > 0 ? 'improved' : 'unchanged',
    errors: snapshot.error !== undefined && snapshot.error !== null ? { ...snapshot.error } : {},
  };
}

/** Render the "指标 / 当前值 / 基线值 / 差值" table. */
export function formatComparisonTable(comparison) {
  const headers = ['指标', '当前值', '基线值', '差值'];
  const rows = comparison.rows.map((row) => [
    row.name,
    formatValue(row.current),
    formatValue(row.baseline),
    row.deltaLabel,
  ]);
  const widths = headers.map((header, column) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[column]))),
  );

  const renderRow = (cells) =>
    cells
      .map((cell, column) =>
        column === widths.length - 1 ? cell : padDisplay(cell, widths[column]),
      )
      .join('  ');

  const lines = [
    renderRow(headers),
    renderRow(widths.map((width) => '-'.repeat(width))),
    ...rows.map(renderRow),
  ];
  return lines.join('\n');
}

function formatComparisonRow(row) {
  return `  ${row.name}: 当前 ${formatValue(row.current)}，基线 ${formatValue(row.baseline)}，差 ${row.deltaLabel}`;
}

/**
 * Render the verdict, the per-item deltas and any current snapshot errors.
 * The caller turns `status === 'regressed'` into exit code 1.
 */
export function formatComparisonSummary(comparison) {
  const lines = [];

  if (comparison.status === 'regressed') {
    lines.push('结论: 退化');
  } else if (comparison.status === 'improved') {
    lines.push('结论: 指标变好（未自动更新基线）');
  } else if (comparison.unknown.length > 0) {
    lines.push('结论: 与基线一致（部分指标无法比较）');
  } else {
    lines.push('结论: 与基线一致');
  }

  if (comparison.regressed.length > 0) {
    lines.push('退化项:');
    for (const row of comparison.regressed) lines.push(formatComparisonRow(row));
  }
  if (comparison.improved.length > 0) {
    lines.push('改进项（未自动更新基线）:');
    for (const row of comparison.improved) lines.push(formatComparisonRow(row));
  }

  const errors = Object.entries(comparison.errors);
  if (errors.length > 0) {
    lines.push('当前快照错误:');
    for (const [key, reason] of errors) lines.push(`  ${key}: ${reason}`);
  }

  return lines.join('\n');
}

/** Render the "基线已更新" report with each item's old value → new value. */
export function formatBaselineUpdate(previous, next) {
  const lines = ['基线已更新'];

  for (const metric of COMPARED_METRICS) {
    const oldValue = previous === null ? '无' : formatValue(previous[metric.name]);
    lines.push(`  ${metric.name}: ${oldValue} → ${formatValue(next[metric.name])}`);
  }
  for (const definition of CHECK_DEFINITIONS) {
    const oldValue = previous === null ? '无' : formatValue(previous.checks[definition.name]);
    lines.push(
      `  ${definition.name}: ${oldValue} → ${formatValue(next.checks[definition.name])}`,
    );
  }

  return lines.join('\n');
}
