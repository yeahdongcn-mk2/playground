import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_E2E_REPORT_PATH } from './lib/e2e-flakes.mjs';

const REPEAT_COUNT = 5;
const RETRY_COUNT = 0;

/**
 * Build the flake-watch job summary from the Playwright JSON report.
 *
 * Kept out of the workflow YAML so the stats branch can be exercised with a
 * real report fixture; a source-text assertion would not catch swapped labels
 * or a dead branch.
 */
export function summarizeFlakeWatch({
  outcome = 'unknown',
  reportPath = DEFAULT_E2E_REPORT_PATH,
  cwd = process.cwd(),
} = {}) {
  const lines = [
    '## mobile-webkit 首跑稳定性',
    '',
    `- 重复次数：${REPEAT_COUNT}`,
    `- 重试次数：${RETRY_COUNT}`,
    `- 结果：${outcome}`,
  ];

  try {
    const report = JSON.parse(readFileSync(resolve(cwd, reportPath), 'utf8'));
    const stats = report.stats ?? {};
    lines.push(
      `- 首跑通过：${stats.expected ?? 0}`,
      `- 失败：${stats.unexpected ?? 0}`,
      `- 重试后通过：${stats.flaky ?? 0}`,
      `- 跳过：${stats.skipped ?? 0}`,
    );
  } catch (error) {
    lines.push(`- 无法读取 Playwright JSON 报告：${error.message}`);
  }

  return lines.join('\n');
}

function run() {
  const summary = summarizeFlakeWatch({
    outcome: process.env.FLAKE_WATCH_OUTCOME,
    reportPath: process.env.FLAKE_WATCH_REPORT_PATH || DEFAULT_E2E_REPORT_PATH,
  });
  process.stdout.write(`${summary}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
