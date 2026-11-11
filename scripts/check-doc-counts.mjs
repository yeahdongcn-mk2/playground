import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DOC_COUNT_PATHS,
  DocCountsError,
  TEST_COMMAND,
  verifyDocCounts,
} from './lib/doc-counts.mjs';

const USAGE = `Usage: node scripts/check-doc-counts.mjs [options]

Check that the ${TEST_COMMAND} counts documented in
${DOC_COUNT_PATHS.join(' / ')}
match the numTotalTests field of a Vitest JSON report.

Without --report the script runs:

  ${TEST_COMMAND} -- --reporter=json --outputFile=<temporary file>

Options:
  --report <path>   reuse an existing Vitest JSON report
  -h, --help        show this help

Exit codes: 0 counts match, 1 mismatch / failing tests / missing count,
            2 usage or I/O error.`;

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

function readDocuments(paths) {
  return paths.map((path) => ({ path, text: readText(path) }));
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
    } else {
      const dir = mkdtempSync(join(tmpdir(), 'doc-counts-'));
      tempDirs.push(dir);
      reportPath = join(dir, 'vitest-report.json');
      console.log(`Running ${TEST_COMMAND} to measure numTotalTests...`);
      testExitCode = runUnitTests(reportPath);
    }

    if (!existsSync(reportPath)) {
      console.error(`error: 找不到 Vitest JSON 报告：${reportPath}`);
      if (testExitCode !== 0) {
        console.error(`hint: ${TEST_COMMAND} 退出码为 ${testExitCode}，没有生成报告。`);
      }
      return testExitCode === 0 ? 2 : 1;
    }

    const documents = readDocuments(DOC_COUNT_PATHS);
    const verification = verifyDocCounts({
      documents,
      reportText: readText(reportPath),
      reportPath,
      testExitCode,
    });

    if (verification.problems.length > 0) {
      console.log(
        `FAIL: 发现 ${verification.problems.length} 处单测计数问题（实测 numTotalTests=${verification.total}）：`,
      );
      for (const problem of verification.problems) {
        console.log(`  ${problem.reason}`);
      }
      return 1;
    }

    console.log(
      `OK: ${DOC_COUNT_PATHS.join(' / ')} 的单测计数均为 ${verification.total}，与 Vitest numTotalTests 一致。`,
    );
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`error: ${detail}`);
    return error instanceof DocCountsError ? 2 : 1;
  } finally {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

process.exitCode = main(process.argv.slice(2));
