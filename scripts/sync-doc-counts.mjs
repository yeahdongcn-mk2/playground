#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BASELINE_RELATIVE_PATH,
  DOC_COUNT_PATHS,
  DocCountsError,
  TEST_COMMAND,
  parseVitestReport,
  planDocCountWrites,
} from './lib/doc-counts.mjs';

const USAGE = `Usage: node scripts/sync-doc-counts.mjs [options]

Write the measured ${TEST_COMMAND} count (Vitest numTotalTests) into
${DOC_COUNT_PATHS.join(' / ')}
and the unitTests field of ${BASELINE_RELATIVE_PATH}.

Without --report the script runs:

  ${TEST_COMMAND} -- --reporter=json --outputFile=<temporary file>

Only the count numbers change: every other byte in the four files is kept,
and a second run with the same report produces no changes.

Options:
  --report <path>   reuse an existing Vitest JSON report
  -h, --help        show this help

Exit codes: 0 written / already in sync, 1 failing tests, a zero-test report
            or inconsistent document counts, 2 usage, I/O or Vitest report
            error.`;

/** The three documents plus the score baseline. */
const WRITE_TARGET_COUNT = DOC_COUNT_PATHS.length + 1;

function parseArgs(argv) {
  const options = { help: false, report: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { ...options, help: true };
    }
    if (arg !== '--report') {
      throw new DocCountsError(`unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new DocCountsError('--report needs a value');
    }
    options.report = value;
    index += 1;
  }

  return options;
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DocCountsError(`无法读取 ${path}：${detail}`);
  }
}

function runUnitTests(reportPath) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npm,
    ['run', 'test:unit', '--', '--reporter=json', `--outputFile=${reportPath}`],
    { cwd: process.cwd(), stdio: 'inherit' },
  );

  if (result.error) {
    throw new DocCountsError(`无法执行 ${TEST_COMMAND}：${result.error.message}`);
  }
  if (typeof result.status !== 'number') {
    throw new DocCountsError(`${TEST_COMMAND} 被信号 ${String(result.signal)} 终止`);
  }
  return result.status;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`error: ${detail}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const tempDirs = [];
  try {
    let reportPath;
    let testExitCode = 0;

    if (options.report !== null) {
      reportPath = resolve(options.report);
      if (!existsSync(reportPath)) {
        console.error(`error: 找不到 Vitest JSON 报告：${reportPath}`);
        return 2;
      }
    } else {
      let dir;
      try {
        dir = mkdtempSync(join(tmpdir(), 'sync-doc-counts-'));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`error: 无法创建临时目录：${detail}`);
        return 2;
      }
      tempDirs.push(dir);
      reportPath = join(dir, 'vitest-report.json');
      console.log(`Running ${TEST_COMMAND} to measure numTotalTests...`);
      try {
        testExitCode = runUnitTests(reportPath);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`error: ${detail}`);
        return 2;
      }
      if (testExitCode !== 0) {
        console.error(
          `error: ${TEST_COMMAND} 退出码为 ${testExitCode}（未全部通过），拒绝写入文档计数。`,
        );
        return 1;
      }
    }

    let report;
    try {
      report = parseVitestReport(readText(reportPath), reportPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`error: ${detail}`);
      return 2;
    }

    if (report.numTotalTests === 0) {
      console.error(
        `error: 报告的 numTotalTests=0，拒绝把 ${WRITE_TARGET_COUNT} 处计数写成 0。`,
      );
      return 1;
    }

    if (report.numFailedTests > 0) {
      console.error(
        `error: 报告里 numFailedTests=${report.numFailedTests}，拒绝写入文档计数。`,
      );
      return 1;
    }

    let documents;
    let baselineText;
    try {
      documents = DOC_COUNT_PATHS.map((path) => ({ path, text: readText(path) }));
      baselineText = readText(BASELINE_RELATIVE_PATH);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`error: ${detail}`);
      return 2;
    }

    let plan;
    try {
      plan = planDocCountWrites({
        documents,
        baselineText,
        total: report.numTotalTests,
        numFailedTests: report.numFailedTests,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`error: ${detail}`);
      return 1;
    }

    try {
      for (const document of plan.documents) {
        if (document.changed) writeFileSync(resolve(document.path), document.after);
      }
      if (plan.baseline.changed) {
        writeFileSync(resolve(plan.baseline.path), plan.baseline.after);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`error: 无法写入文档计数：${detail}`);
      return 2;
    }

    if (plan.changedPaths.length === 0) {
      console.log(`OK: ${WRITE_TARGET_COUNT} 处单测计数已经是 ${plan.total}，无需修改。`);
      return 0;
    }

    for (const path of plan.changedPaths) {
      console.log(`updated ${path} -> ${plan.total}`);
    }
    console.log(`OK: 已把 ${plan.changedPaths.length} 个文件同步为 ${plan.total}。`);
    return 0;
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Cleanup must never replace the writer's own exit code.
      }
    }
  }
}

process.exitCode = main(process.argv.slice(2));
