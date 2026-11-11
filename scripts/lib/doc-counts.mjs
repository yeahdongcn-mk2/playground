/**
 * Cross-check the unit-test count documented in the repository docs against
 * the `numTotalTests` field of a Vitest JSON report.
 *
 * The three documents record the count next to `npm run test:unit`:
 * README.md and docs/framework.md use `N passed`, docs/snake-design.md uses
 * `全仓 N 个用例`. Parsing stays in this module so the CLI and the unit tests
 * share the same rules; nothing here runs the test suite or touches the docs.
 */

export const TEST_COMMAND = 'npm run test:unit';

/** Documents that repeat the whole-repository unit-test count. */
export const DOC_COUNT_PATHS = [
  'README.md',
  'docs/framework.md',
  'docs/snake-design.md',
];

const COMMAND_PATTERN = /npm run test:unit/;
const COUNT_PATTERN = /(\d+)\s+(?:passed|个用例)/;

/** Raised when a document or report cannot be parsed as expected. */
export class DocCountsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocCountsError';
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

/**
 * Find the unit-test count documented on the same line as `npm run test:unit`.
 *
 * Earlier mentions of the command without a count (for example a prose line
 * that only says to run it) are skipped. Returns the 1-based line number so a
 * mismatch can point at the exact document line.
 *
 * @returns {{ line: number, count: number }}
 */
export function parseDocumentedCount(text, file = 'document') {
  const lines = String(text).split(/\r?\n/);
  let sawCommand = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!COMMAND_PATTERN.test(line)) continue;
    sawCommand = true;

    const match = COUNT_PATTERN.exec(line);
    if (match?.[1] === undefined) continue;
    return { line: index + 1, count: Number(match[1]) };
  }

  if (sawCommand) {
    throw new DocCountsError(
      `${file}: ${TEST_COMMAND} 同行缺少 "N passed" 或 "全仓 N 个用例" 计数`,
    );
  }
  throw new DocCountsError(`${file}: 找不到 ${TEST_COMMAND} 的文档计数行`);
}

function readCounter(report, field, source) {
  const value = report[field];
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new DocCountsError(
      `${source}: ${field} 必须是 >= 0 的整数（实际：${describeValue(value)}）`,
    );
  }
  return value;
}

/**
 * Parse the parts of a Vitest JSON report needed by the count check.
 *
 * `numTotalTests` is required: a report without a non-negative integer there
 * is treated as malformed instead of silently comparing against `undefined`.
 *
 * @returns {{
 *   numTotalTests: number,
 *   numFailedTests: number,
 *   numPassedTests: number,
 *   numPendingTests: number,
 * }}
 */
export function parseVitestReport(text, source = 'Vitest JSON 报告') {
  let report;
  try {
    report = JSON.parse(String(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DocCountsError(`${source}: 不是合法的 JSON（${detail}）`);
  }

  if (typeof report !== 'object' || report === null || Array.isArray(report)) {
    throw new DocCountsError(`${source}: 顶层必须是 JSON 对象`);
  }

  const total = report.numTotalTests;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
    throw new DocCountsError(
      `${source}: 缺少或无效的 numTotalTests 字段（实际：${describeValue(total)}）；期望 >= 0 的整数`,
    );
  }

  return {
    numTotalTests: total,
    numFailedTests: readCounter(report, 'numFailedTests', source),
    numPassedTests: readCounter(report, 'numPassedTests', source),
    numPendingTests: readCounter(report, 'numPendingTests', source),
  };
}

/**
 * Compare every documented count with the report's `numTotalTests`.
 *
 * A documented count may be missing (malformed line) and the run may have
 * failed tests; both are returned as problems instead of throwing, so the CLI
 * can print every issue at once and exit non-zero.
 *
 * @returns {{
 *   total: number,
 *   numFailedTests: number,
 *   documented: Array<{ file: string, line: number, count: number }>,
 *   problems: Array<{
 *     kind: 'mismatch' | 'missing-count' | 'tests-failed',
 *     file: string,
 *     line: number | null,
 *     expected: number | null,
 *     actual: number | null,
 *     reason: string,
 *   }>,
 * }}
 */
export function verifyDocCounts({
  documents,
  reportText,
  reportPath = 'Vitest JSON 报告',
  testExitCode = 0,
}) {
  if (!Array.isArray(documents)) {
    throw new DocCountsError('documents 必须是文档数组');
  }

  const measured = parseVitestReport(reportText, reportPath);
  const documented = [];
  const problems = [];

  if (measured.numFailedTests > 0 || testExitCode !== 0) {
    problems.push({
      kind: 'tests-failed',
      file: reportPath,
      line: null,
      expected: null,
      actual: measured.numTotalTests,
      reason: `单测未全部通过：numFailedTests=${measured.numFailedTests}，退出码=${testExitCode}（${reportPath}）`,
    });
  }

  for (const document of documents) {
    try {
      const { line, count } = parseDocumentedCount(document.text, document.path);
      documented.push({ file: document.path, line, count });

      if (count !== measured.numTotalTests) {
        problems.push({
          kind: 'mismatch',
          file: document.path,
          line,
          expected: count,
          actual: measured.numTotalTests,
          reason: `${document.path}:${line}: 文档写 ${count} 个用例，实测 ${measured.numTotalTests} 个（Vitest numTotalTests）`,
        });
      }
    } catch (error) {
      if (!(error instanceof DocCountsError)) throw error;
      problems.push({
        kind: 'missing-count',
        file: document.path,
        line: null,
        expected: null,
        actual: measured.numTotalTests,
        reason: error.message,
      });
    }
  }

  return {
    total: measured.numTotalTests,
    numFailedTests: measured.numFailedTests,
    documented,
    problems,
  };
}
