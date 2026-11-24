/**
 * Compare the gzip budget numbers written in README.md and docs/framework.md
 * with a live measurement of `dist/`.
 *
 * The measurement comes from the same `measureBudget()` call as
 * `npm run check:budget`; parsing and comparison live in the shared
 * `budget-docs` contract. Nothing here recomputes gzip, parses Vite output or
 * introduces another threshold.
 */
import { readFileSync } from 'node:fs';
import { BudgetError, measureBudget } from './lib/budget.mjs';
import {
  BudgetDocsError,
  compareBudgetDocs,
  readBudgetDocs,
} from './lib/budget-docs.mjs';

const README_PATH = 'README.md';
const FRAMEWORK_PATH = 'docs/framework.md';

/**
 * Read one budget document, turning a filesystem error into the same
 * path-named `BudgetDocsError` the parser raises, so the CLI still prints the
 * `Budget docs failed:` marker instead of a raw Node stack trace.
 *
 * @param {string} path
 * @returns {string}
 */
function readDocument(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BudgetDocsError(`${path}: 无法读取文档（${detail}）`, path);
  }
}

/**
 * Print the shared failure marker and one bullet per message.
 *
 * @param {string[]} messages
 * @returns {1}
 */
function printFailures(messages) {
  console.error('Budget docs failed:');
  for (const message of messages) console.error(`  - ${message}`);
  return 1;
}

function main() {
  let docs;
  let report;
  try {
    docs = readBudgetDocs({
      readme: readDocument(README_PATH),
      framework: readDocument(FRAMEWORK_PATH),
    });
    report = measureBudget('dist');
  } catch (error) {
    if (error instanceof BudgetError || error instanceof BudgetDocsError) {
      return printFailures([error.message]);
    }
    throw error;
  }

  const failures = compareBudgetDocs(docs, report);
  if (failures.length > 0) {
    return printFailures(failures);
  }

  console.log(
    `Budget docs OK: ${docs.readme.path} 与 ${docs.framework.path} 的预算数字与 dist 实测一致。`,
  );
  return 0;
}

process.exitCode = main();
