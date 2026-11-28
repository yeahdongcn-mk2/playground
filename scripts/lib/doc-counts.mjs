import { rmSync } from 'node:fs';

/**
 * Cross-check and rewrite the unit-test counts recorded in the repository
 * docs against the `numTotalTests` field of a Vitest JSON report.
 *
 * The three documents record the count next to `npm run test:unit`:
 * README.md and docs/framework.md use `N passed`, docs/snake-design.md uses
 * `全仓 N 个用例`; docs/score-baseline.json stores the same number in its
 * `unitTests` field. Parsing and rewriting stay in this module so the check
 * and write CLIs and the unit tests share the same rules; nothing here runs
 * the test suite. The only file-system work is `cleanupTempDirs`, which
 * removes temporary directories the caller already created.
 */

export const TEST_COMMAND = 'npm run test:unit';

/** Documents that repeat the whole-repository unit-test count. */
export const DOC_COUNT_PATHS = [
  'README.md',
  'docs/framework.md',
  'docs/snake-design.md',
];

/** The score baseline that records the same count in `unitTests`. */
export const BASELINE_RELATIVE_PATH = 'docs/score-baseline.json';

const COMMAND_PATTERN = /npm run test:unit/;
const COUNT_PATTERN = /(\d+)\s+(?:passed|个用例)/;
const UNIT_TESTS_PATTERN = /("unitTests"\s*:\s*)(\d+)/;

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
 * Locate the count token in a document, keeping the raw line and regex match
 * so the rewriter can replace only the digits.
 *
 * @returns {{
 *   lineIndex: number,
 *   line: number,
 *   count: number,
 *   lineText: string,
 *   match: RegExpExecArray,
 * }}
 */
function locateDocumentedCount(text, file) {
  const lines = String(text).split('\n');
  let sawCommand = false;

  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index] ?? '';
    if (!COMMAND_PATTERN.test(lineText)) continue;
    sawCommand = true;

    const match = COUNT_PATTERN.exec(lineText);
    if (match?.[1] === undefined) continue;
    return {
      lineIndex: index,
      line: index + 1,
      count: Number(match[1]),
      lineText,
      match,
    };
  }

  if (sawCommand) {
    throw new DocCountsError(
      `${file}: ${TEST_COMMAND} 同行缺少 "N passed" 或 "全仓 N 个用例" 计数`,
    );
  }
  throw new DocCountsError(`${file}: 找不到 ${TEST_COMMAND} 的文档计数行`);
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
  const { line, count } = locateDocumentedCount(text, file);
  return { line, count };
}

function parseCountValue(total, source) {
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
    throw new DocCountsError(
      `${source}: 计数必须是 >= 0 的整数（实际：${describeValue(total)}）`,
    );
  }
  return total;
}

/**
 * Rewrite the documented unit-test count, leaving every other byte alone.
 *
 * Only the matched `N passed` / `全仓 N 个用例` token changes; the rest of the
 * line, the other lines, the line endings and the trailing newline are kept
 * verbatim. Calling this again with the same total returns the same text.
 *
 * @param {string} text
 * @param {number} total measured `numTotalTests`
 * @param {string} [file]
 * @returns {string}
 */
export function rewriteDocumentedCount(text, total, file = 'document') {
  const measured = parseCountValue(total, file);
  const source = String(text);
  const found = locateDocumentedCount(source, file);
  if (found.count === measured) return source;

  const matchIndex = found.match.index;
  const digits = found.match[1];
  if (matchIndex === undefined || digits === undefined) {
    throw new DocCountsError(`${file}: 无法定位计数 token`);
  }

  const lines = source.split('\n');
  const lineText = found.lineText;
  const rewrittenLine = `${lineText.slice(0, matchIndex)}${measured}${lineText.slice(
    matchIndex + digits.length,
  )}`;
  lines[found.lineIndex] = rewrittenLine;
  return lines.join('\n');
}

/**
 * Rewrite only the `unitTests` number in docs/score-baseline.json.
 *
 * The file is validated as JSON first, but serialization is intentionally not
 * used: replacing the token keeps the other fields, key order, indentation and
 * final newline byte-for-byte identical. Calling this again with the same
 * total returns the same text.
 *
 * @param {string} text
 * @param {number} total measured `numTotalTests`
 * @param {string} [source]
 * @returns {string}
 */
export function rewriteBaselineUnitTests(text, total, source = BASELINE_RELATIVE_PATH) {
  const measured = parseCountValue(total, source);
  const original = String(text);

  let baseline;
  try {
    baseline = JSON.parse(original);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DocCountsError(`${source}: 不是合法的 JSON（${detail}）`);
  }

  if (typeof baseline !== 'object' || baseline === null || Array.isArray(baseline)) {
    throw new DocCountsError(`${source}: 顶层必须是 JSON 对象`);
  }

  const current = baseline.unitTests;
  if (current === undefined) {
    throw new DocCountsError(`${source}: 缺少 unitTests 字段`);
  }
  if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0) {
    throw new DocCountsError(
      `${source}: unitTests 必须是 >= 0 的整数（实际：${describeValue(current)}）`,
    );
  }

  // Validate the raw token before deciding whether anything changes: a
  // duplicate key or a text/value mismatch must not be hidden by an
  // already-matching count.
  const matches = [...original.matchAll(new RegExp(UNIT_TESTS_PATTERN, 'g'))];
  if (matches.length !== 1) {
    throw new DocCountsError(
      `${source}: 期望恰好一个 "unitTests" 数值，实际找到 ${matches.length} 个`,
    );
  }

  const match = matches[0];
  const prefix = match?.[1];
  const digits = match?.[2];
  const matchIndex = match?.index;
  if (prefix === undefined || digits === undefined || matchIndex === undefined) {
    throw new DocCountsError(`${source}: 无法定位 unitTests 数值`);
  }
  if (Number(digits) !== current) {
    throw new DocCountsError(`${source}: unitTests 文本与 JSON 值不一致`);
  }
  if (current === measured) return original;

  const start = matchIndex + prefix.length;
  return `${original.slice(0, start)}${measured}${original.slice(start + digits.length)}`;
}

/**
 * Plan every write for one Vitest report without touching the file system.
 *
 * All documents and the baseline are validated before returning, so a missing
 * count line or a corrupt baseline makes the caller fail before it starts
 * writing. `changedPaths` lists only the files whose bytes actually change, in
 * document order followed by the baseline.
 *
 * @param {{
 *   documents: Array<{ path: string, text: string }>,
 *   baselineText: string,
 *   total: number,
 *   numFailedTests?: number,
 * }} options
 * @returns {{
 *   total: number,
 *   documents: Array<{ path: string, before: string, after: string, changed: boolean }>,
 *   baseline: { path: string, before: string, after: string, changed: boolean },
 *   changedPaths: string[],
 * }}
 */
export function planDocCountWrites({
  documents,
  baselineText,
  total,
  numFailedTests = 0,
} = {}) {
  const measured = parseCountValue(total, 'planDocCountWrites');
  if (!Array.isArray(documents)) {
    throw new DocCountsError('documents 必须是文档数组');
  }
  if (
    typeof numFailedTests !== 'number' ||
    !Number.isSafeInteger(numFailedTests) ||
    numFailedTests < 0
  ) {
    throw new DocCountsError(
      `numFailedTests 必须是 >= 0 的整数（实际：${describeValue(numFailedTests)}）`,
    );
  }
  if (numFailedTests > 0) {
    throw new DocCountsError(
      `单测未全部通过：numFailedTests=${numFailedTests}，拒绝写入文档计数`,
    );
  }

  const plannedDocuments = documents.map((document) => {
    if (
      document === null ||
      typeof document !== 'object' ||
      typeof document.path !== 'string' ||
      typeof document.text !== 'string'
    ) {
      throw new DocCountsError('documents 的每一项都必须有 path 和 text 字符串');
    }
    const after = rewriteDocumentedCount(document.text, measured, document.path);
    return {
      path: document.path,
      before: document.text,
      after,
      changed: after !== document.text,
    };
  });

  if (typeof baselineText !== 'string') {
    throw new DocCountsError('baselineText 必须是字符串');
  }
  const before = baselineText;
  const after = rewriteBaselineUnitTests(before, measured);
  const baseline = {
    path: BASELINE_RELATIVE_PATH,
    before,
    after,
    changed: after !== before,
  };

  const changedPaths = plannedDocuments
    .filter((document) => document.changed)
    .map((document) => document.path);
  if (baseline.changed) changedPaths.push(baseline.path);

  return { total: measured, documents: plannedDocuments, baseline, changedPaths };
}

function readCounter(report, field, source) {
  const value = report[field];
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
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
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
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

/**
 * Remove temporary directories created by a CLI, swallowing every removal
 * error.
 *
 * Cleanup runs from a `finally` block, so an error thrown here would escape
 * `main` and replace the exit code the command had already chosen (for
 * example turning a clean 0 into Node's default 1). Each directory is
 * attempted even when an earlier removal fails, and `remove` is injectable so
 * tests can exercise a failing delete without relying on file-system
 * permissions.
 *
 * @param {string[]} dirs
 * @param {(path: string, options: { recursive: boolean, force: boolean }) => void} [remove]
 */
export function cleanupTempDirs(dirs, remove = rmSync) {
  for (const dir of dirs) {
    try {
      remove(dir, { recursive: true, force: true });
    } catch {
      // Cleanup must never override the command's own exit code.
    }
  }
}
