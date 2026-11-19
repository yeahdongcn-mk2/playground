import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_E2E_REPORT_PATH,
  parseE2eReport,
  summarizeTargetCases,
} from './lib/e2e-flakes.mjs';

const REPEAT_COUNT = 5;
const RETRY_COUNT = 0;

const COUNT_LABELS = [
  ['passed', '首跑通过'],
  ['failed', '失败'],
  ['flaky', '重试后通过'],
  ['skipped', '跳过'],
  ['unknown', '状态无法识别'],
];

/**
 * Build the flake-watch job summary from the Playwright JSON report.
 *
 * The scheduled run repeats each guarded case with `--retries=0`, so the JSON
 * report holds five first-run results per case. The summary groups those
 * results by target (the same `TARGET_CASES` the PR gate reads) so a failed
 * repeat names the case that failed instead of only showing combined stats.
 *
 * Kept out of the workflow YAML so the stats branch can be exercised with real
 * report fixtures; a source-text assertion would not catch swapped labels or a
 * dead branch.
 */
export function summarizeFlakeWatch({
  outcome = 'unknown',
  reportPath = DEFAULT_E2E_REPORT_PATH,
  cwd = process.cwd(),
} = {}) {
  const lines = [
    '## guarded first-run stability（flake-watch）',
    '',
    `- 重复次数：${REPEAT_COUNT}`,
    `- 重试次数：${RETRY_COUNT}`,
    `- 结果：${outcome}`,
  ];

  let report;
  try {
    report = parseE2eReport(readFileSync(resolve(cwd, reportPath), 'utf8'));
  } catch (error) {
    lines.push(`- 无法读取 Playwright JSON 报告：${error.message}`);
    return lines.join('\n');
  }

  for (const { target, counts } of summarizeTargetCases(report)) {
    lines.push(
      '',
      `### ${target.label}`,
      '',
      `- project：${target.projectName}`,
      `- 标题包含：${target.titleFragment}`,
    );
    if (counts.total === 0) {
      lines.push(
        '- 缺失：报告中未找到该用例，无法确认首跑稳定性',
        '  若用例改名或换了 project，请同步 scripts/lib/e2e-flakes.mjs 的 TARGET_CASES。',
      );
      continue;
    }
    for (const [key, label] of COUNT_LABELS) {
      // The per-case tally must always expose the four first-run outcomes;
      // an unknown state is only printed when a report actually contains it.
      if (key === 'unknown' && counts.unknown === 0) continue;
      lines.push(`- ${label}：${counts[key]}`);
    }
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
