/**
 * Parse the gzip budget numbers recorded in README.md and docs/framework.md,
 * then compare them with a `measureBudget()` report.
 *
 * README's "验证" section pastes the real `npm run check:budget` output, and
 * docs/framework.md section 14 keeps one bullet with the same gzip
 * measurements. Parsing stays in this module so the CLI, the unit tests and a
 * future build gate share one contract; nothing here reads `dist` or
 * recomputes gzip.
 */

import { formatGzipKb } from './budget.mjs';

const README_PATH = 'README.md';
const FRAMEWORK_PATH = 'docs/framework.md';
const README_SECTION = '## 验证';
const FRAMEWORK_SECTION = /^## 14\./;

/** A non-negative decimal number, with the capture group kept by the caller. */
const NUMBER = '([0-9]+(?:\\.[0-9]+)?)';

const README_ENTRY = new RegExp(`Entry JS: ${NUMBER} KB \\(${NUMBER} KB gzip\\)`);
const README_ALL_JS = new RegExp(`All JS chunks: ${NUMBER} KB gzip`);
const README_CSS = new RegExp(`CSS: ${NUMBER} KB gzip`);
const README_ZHEN_SHA = new RegExp(
  `Zhen Sha view JS: \`?(\\S+\\.js)\`? ${NUMBER} KB gzip`,
);

const FRAMEWORK_ENTRY = new RegExp(`入口 JS 约 ${NUMBER} KB gzip`);
const FRAMEWORK_ALL_JS = new RegExp(
  `全部 JS chunk 合计 ≤${NUMBER} KB gzip（当前约 ${NUMBER} KB gzip）`,
);
const FRAMEWORK_ZHEN_SHA = new RegExp(
  `zhen-sha-view-\\*\\.js\\S* 要求合计 ≤${NUMBER} KB gzip（当前约 ${NUMBER} KB gzip）`,
);

/** Raised when a budget document cannot be parsed as the contract requires. */
export class BudgetDocsError extends Error {
  /**
   * @param {string} message
   * @param {string} [path] document the error belongs to
   */
  constructor(message, path) {
    super(message);
    this.name = 'BudgetDocsError';
    if (path !== undefined) this.path = path;
  }
}

/**
 * The lines of one level-2 section, excluding its heading and the next
 * level-2 heading. Exactly one matching heading is required so a stray
 * duplicate section cannot silently shadow the documented values.
 *
 * @param {string} text
 * @param {string} path
 * @param {string} heading human-readable heading for the error message
 * @param {(line: string) => boolean} isHeading
 * @returns {string[]}
 */
function sectionLines(text, path, heading, isHeading) {
  const lines = String(text).split(/\r?\n/);
  const headingIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (isHeading(lines[index])) headingIndexes.push(index);
  }

  if (headingIndexes.length === 0) {
    throw new BudgetDocsError(`${path}: 找不到「${heading}」小节`, path);
  }
  if (headingIndexes.length > 1) {
    throw new BudgetDocsError(
      `${path}: 找到 ${headingIndexes.length} 个「${heading}」小节，应恰好一个`,
      path,
    );
  }

  const start = headingIndexes[0] + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith('## ')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end);
}

/**
 * The only line of a section containing `marker`. A missing line or a
 * duplicated line is an error instead of a silent first match.
 *
 * @param {string[]} lines
 * @param {string} marker
 * @param {string} path
 * @param {string} sectionLabel
 * @returns {string}
 */
function uniqueLine(lines, marker, path, sectionLabel) {
  const matches = lines.filter((line) => line.includes(marker));

  if (matches.length === 0) {
    throw new BudgetDocsError(
      `${path}: ${sectionLabel}缺少包含「${marker}」的行`,
      path,
    );
  }
  if (matches.length > 1) {
    throw new BudgetDocsError(
      `${path}: ${sectionLabel}包含「${marker}」的行应恰好一行，实际 ${matches.length} 行`,
      path,
    );
  }
  const occurrences = matches[0].split(marker).length - 1;
  if (occurrences > 1) {
    throw new BudgetDocsError(
      `${path}: ${sectionLabel}包含「${marker}」的行出现了 ${occurrences} 次，应恰好一次`,
      path,
    );
  }
  return matches[0];
}

/**
 * Apply one line pattern, raising a document-specific error when the line does
 * not carry the expected numbers or chunk name.
 *
 * @param {RegExp} pattern
 * @param {string} line
 * @param {string} path
 * @param {string} field
 * @returns {RegExpExecArray}
 */
function parseMatch(pattern, line, path, field) {
  const match = pattern.exec(line);
  if (match === null) {
    throw new BudgetDocsError(
      `${path}: 无法解析${field}：${line.trim()}`,
      path,
    );
  }
  return match;
}

/**
 * @param {unknown} text
 * @param {string} path
 * @returns {string}
 */
function documentText(text, path) {
  if (typeof text !== 'string') {
    throw new BudgetDocsError(`${path}: 需要文档文本（string）`, path);
  }
  return text;
}

/**
 * Parse README's "验证" section: the pasted `check:budget` output with Entry
 * JS (raw and gzip), All JS chunks, CSS and Zhen Sha view JS.
 *
 * @param {string} readme
 */
function readReadmeBudget(readme) {
  const text = documentText(readme, README_PATH);
  const lines = sectionLines(
    text,
    README_PATH,
    README_SECTION,
    (line) => line.trim() === README_SECTION,
  );
  const label = '「## 验证」段';

  const entry = parseMatch(
    README_ENTRY,
    uniqueLine(lines, 'Entry JS:', README_PATH, label),
    README_PATH,
    'Entry JS 行',
  );
  const allJs = parseMatch(
    README_ALL_JS,
    uniqueLine(lines, 'All JS chunks:', README_PATH, label),
    README_PATH,
    'All JS chunks 行',
  );
  const css = parseMatch(
    README_CSS,
    uniqueLine(lines, 'CSS:', README_PATH, label),
    README_PATH,
    'CSS 行',
  );
  const zhenShaLine = uniqueLine(lines, 'Zhen Sha view JS:', README_PATH, label);
  if (/Zhen Sha view JS:\s*$/.test(zhenShaLine.trim())) {
    throw new BudgetDocsError(
      `${README_PATH}: 「## 验证」段的 Zhen Sha view JS 只支持单个 chunk 的一行输出，多 chunk 块无法与 chunk 文件名比较`,
      README_PATH,
    );
  }
  const zhenSha = parseMatch(README_ZHEN_SHA, zhenShaLine, README_PATH, 'Zhen Sha view JS 行');

  return {
    path: README_PATH,
    entry: {
      rawKb: Number(entry[1]),
      gzipKb: Number(entry[2]),
    },
    allJs: { gzipKb: Number(allJs[1]) },
    css: { gzipKb: Number(css[1]) },
    zhenSha: {
      file: zhenSha[1],
      gzipKb: Number(zhenSha[2]),
    },
  };
}

/**
 * Parse docs/framework.md section 14's single budget bullet: the entry, all JS
 * and Zhen Sha view gzip measurements.
 *
 * @param {string} framework
 */
function readFrameworkBudget(framework) {
  const text = documentText(framework, FRAMEWORK_PATH);
  const lines = sectionLines(
    text,
    FRAMEWORK_PATH,
    '第 14 节',
    (line) => FRAMEWORK_SECTION.test(line.trim()),
  );

  const line = uniqueLine(lines, '入口 JS 约', FRAMEWORK_PATH, '第 14 节');
  const entry = parseMatch(FRAMEWORK_ENTRY, line, FRAMEWORK_PATH, '入口 JS gzip 体积');
  const allJs = parseMatch(FRAMEWORK_ALL_JS, line, FRAMEWORK_PATH, '全部 JS chunk gzip 体积');
  const zhenSha = parseMatch(
    FRAMEWORK_ZHEN_SHA,
    line,
    FRAMEWORK_PATH,
    'Zhen Sha view JS gzip 体积',
  );

  return {
    path: FRAMEWORK_PATH,
    entry: { gzipKb: Number(entry[1]) },
    allJs: { gzipKb: Number(allJs[2]) },
    zhenSha: { gzipKb: Number(zhenSha[2]) },
  };
}

/**
 * Parse both documents into the numbers a gate can compare with a
 * `measureBudget()` report.
 *
 * The `{}` default only turns a missing call argument into a path-named
 * `BudgetDocsError`; both documents are required for a usable result.
 *
 * @param {{ readme: string, framework: string }} input document contents
 */
export function readBudgetDocs({ readme, framework } = {}) {
  return {
    readme: readReadmeBudget(readme),
    framework: readFrameworkBudget(framework),
  };
}

/**
 * @param {string[]} failures
 * @param {string} path
 * @param {string} field
 * @param {number} documentedKb
 * @param {number} measuredBytes
 */
function compareKb(failures, path, field, documentedKb, measuredBytes) {
  // Scale the documented KB back to bytes so both sides go through the one
  // formatter used by `check:budget`; *1024 and /1024 are exact.
  const documented = formatGzipKb(documentedKb * 1024);
  const measured = formatGzipKb(measuredBytes);
  if (documented !== measured) {
    failures.push(`${path} ${field}: 文档写 ${documented}，实测 ${measured}`);
  }
}

/**
 * @param {string[]} failures
 * @param {string} path
 * @param {string} documentedFile
 * @param {ReadonlyArray<{ file: string }>} chunks
 */
function compareZhenShaFile(failures, path, documentedFile, chunks) {
  if (chunks.length === 1 && chunks[0].file === documentedFile) return;

  if (chunks.length === 0) {
    failures.push(
      `${path} Zhen Sha view JS chunk 文件名: 文档写 ${documentedFile}，实测没有 zhen-sha-view 产物`,
    );
    return;
  }
  if (chunks.length > 1) {
    const files = chunks.map((chunk) => chunk.file).join(', ');
    failures.push(
      `${path} Zhen Sha view JS chunk 文件名: 文档只记录一个 chunk（${documentedFile}），实测 ${chunks.length} 个（${files}）`,
    );
    return;
  }
  failures.push(
    `${path} Zhen Sha view JS chunk 文件名: 文档写 ${documentedFile}，实测 ${chunks[0].file}`,
  );
}

/**
 * Compare every documented number and the zhen-sha chunk name with the report
 * produced by `measureBudget()`. Returns one message per mismatch, each naming
 * the document path and the field, or an empty list when the docs are current.
 *
 * @param {ReturnType<typeof readBudgetDocs>} docs
 * @param {import('./budget.mjs').BudgetReport} report
 * @returns {string[]}
 */
export function compareBudgetDocs(docs, report) {
  const { readme, framework } = docs;
  const failures = [];

  compareKb(failures, readme.path, 'Entry JS 原始体积', readme.entry.rawKb, report.entry.bytes);
  compareKb(failures, readme.path, 'Entry JS gzip 体积', readme.entry.gzipKb, report.entry.gzipBytes);
  compareKb(
    failures,
    readme.path,
    'All JS chunks gzip 体积',
    readme.allJs.gzipKb,
    report.allJs.gzipBytes,
  );
  compareKb(failures, readme.path, 'CSS gzip 体积', readme.css.gzipKb, report.cssGzipBytes);
  compareZhenShaFile(failures, readme.path, readme.zhenSha.file, report.zhenSha.chunks);
  compareKb(
    failures,
    readme.path,
    'Zhen Sha view JS gzip 体积',
    readme.zhenSha.gzipKb,
    report.zhenSha.gzipBytes,
  );

  compareKb(
    failures,
    framework.path,
    '第 14 节 入口 JS gzip 体积',
    framework.entry.gzipKb,
    report.entry.gzipBytes,
  );
  compareKb(
    failures,
    framework.path,
    '第 14 节 全部 JS chunk gzip 体积',
    framework.allJs.gzipKb,
    report.allJs.gzipBytes,
  );
  compareKb(
    failures,
    framework.path,
    '第 14 节 Zhen Sha view JS gzip 体积',
    framework.zhenSha.gzipKb,
    report.zhenSha.gzipBytes,
  );

  return failures;
}
