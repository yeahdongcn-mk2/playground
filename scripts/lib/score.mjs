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

/**
 * Parse the two gzip sizes printed by `npm run check:budget`.
 *
 * A missing line yields null for that value instead of throwing, so a
 * partially broken budget run still produces the rest of the snapshot.
 *
 * @returns {{ entryGzipBytes: number | null, totalJsGzipBytes: number | null }}
 */
export function parseBudgetMetrics(output) {
  const text = String(output ?? '');
  const entry = ENTRY_GZIP_PATTERN.exec(text);
  const total = TOTAL_JS_GZIP_PATTERN.exec(text);

  return {
    entryGzipBytes: entry === null ? null : kbToBytes(Number(entry[1])),
    totalJsGzipBytes: total === null ? null : kbToBytes(Number(total[1])),
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

/**
 * Render the human-readable "指标 / 当前值" table. Any null item is listed in
 * an `error` section below the table so the reason stays visible.
 */
export function formatScoreTable(snapshot) {
  const labels = [
    'unitTests',
    'entryGzipBytes',
    'totalJsGzipBytes',
    ...CHECK_DEFINITIONS.map((definition) => definition.name),
    'gitCommit',
    'generatedAt',
  ];
  const width = Math.max(...labels.map((label) => label.length));
  const values = [
    formatValue(snapshot.unitTests),
    formatValue(snapshot.entryGzipBytes),
    formatValue(snapshot.totalJsGzipBytes),
    ...CHECK_DEFINITIONS.map((definition) => formatValue(snapshot.checks[definition.name])),
    formatValue(snapshot.gitCommit),
    formatValue(snapshot.generatedAt),
  ];

  const lines = [
    `${padDisplay('指标', width)}  ${'当前值'}`,
    `${'-'.repeat(width)}  ${'-'.repeat(displayWidth('当前值'))}`,
  ];
  for (let index = 0; index < labels.length; index += 1) {
    lines.push(`${labels[index].padEnd(width)}  ${values[index]}`);
  }

  const errors = Object.entries(snapshot.error);
  if (errors.length > 0) {
    lines.push('', '错误:');
    for (const [key, reason] of errors) {
      lines.push(`  ${key}: ${reason}`);
    }
  }

  return lines.join('\n');
}
