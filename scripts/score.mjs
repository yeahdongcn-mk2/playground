#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECK_DEFINITIONS,
  buildSnapshot,
  compareSnapshot,
  createBaseline,
  formatBaselineUpdate,
  formatComparisonSummary,
  formatComparisonTable,
  parseBaseline,
  serializeBaseline,
} from './lib/score.mjs';

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const STEP_TIMEOUT_MS = 30 * 60 * 1000;
const BASELINE_RELATIVE_PATH = 'docs/score-baseline.json';
const BASELINE_PATH = join(process.cwd(), BASELINE_RELATIVE_PATH);

const USAGE = `Usage: npm run score [-- --update]

Runs the production build and the six repository checks, then compares the
result with ${BASELINE_RELATIVE_PATH}.

  --update   replace the baseline with the current values and print each
             item's old value → new value
  -h, --help show this help

Exit codes: 0 unchanged / improved, 1 regression, 2 missing or corrupt baseline
or a usage error.`;

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function describeSpawnError(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv) {
  const options = { update: false, help: false };

  for (const arg of argv) {
    if (arg === '--update') {
      options.update = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  return options;
}

function runNpmScript(script) {
  console.error(`Running npm run ${script} ...`);
  const result = spawnSync(npmCommand(), ['run', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: STEP_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });

  return {
    name: script,
    script,
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error === undefined ? null : describeSpawnError(result.error),
  };
}

function readGitCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (result.error !== undefined) {
    return {
      commit: null,
      error: `git rev-parse HEAD failed to start: ${describeSpawnError(result.error)}`,
    };
  }
  if (result.status !== 0) {
    return {
      commit: null,
      error: `git rev-parse HEAD exited with code ${String(result.status)}`,
    };
  }

  const commit = (result.stdout ?? '').trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    return { commit: null, error: 'git rev-parse HEAD did not return a commit hash' };
  }
  return { commit, error: null };
}

/**
 * Read the baseline file without throwing, so `--update` can rebuild a
 * missing or corrupt baseline instead of aborting the capture.
 *
 * @returns {{ baseline: object | null, error: string | null }}
 */
function loadBaseline() {
  let text;
  try {
    text = readFileSync(BASELINE_PATH, 'utf8');
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') {
      return { baseline: null, error: `找不到基线文件 ${BASELINE_RELATIVE_PATH}` };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { baseline: null, error: `无法读取基线文件 ${BASELINE_RELATIVE_PATH}：${detail}` };
  }

  try {
    return { baseline: parseBaseline(text, BASELINE_RELATIVE_PATH), error: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { baseline: null, error: detail };
  }
}

function captureSnapshot() {
  // check:budget reads dist/, and a clean checkout has no dist/. Build first so
  // `npm run score` works right after `npm ci`; the build result is reported in
  // the snapshot error map if it fails.
  const build = runNpmScript('build');
  const results = [];
  for (const definition of CHECK_DEFINITIONS) {
    const result = runNpmScript(definition.script);
    results.push({ ...result, name: definition.name });
  }

  const git = readGitCommit();
  return buildSnapshot({
    results,
    build,
    gitCommit: git.commit,
    gitCommitError: git.error,
    generatedAt: new Date().toISOString(),
  });
}

function printSnapshotJson(snapshot) {
  console.log(`SCORE_JSON ${JSON.stringify(snapshot)}`);
}

function updateBaseline(snapshot) {
  const hadBaseline = existsSync(BASELINE_PATH);
  const loaded = loadBaseline();
  const previous = loaded.baseline;
  const next = createBaseline(snapshot);

  if (hadBaseline && previous === null) {
    console.error(`警告: 现有基线不可用（${loaded.error}），已用当前值重建。`);
  }

  try {
    writeFileSync(BASELINE_PATH, serializeBaseline(next));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`error: 无法写入 ${BASELINE_RELATIVE_PATH}：${detail}`);
    return 2;
  }

  if (previous !== null) {
    const comparison = compareSnapshot(snapshot, previous);
    console.log(formatComparisonTable(comparison));
    console.log(formatComparisonSummary(comparison));
  }
  console.log(formatBaselineUpdate(previous, next));
  printSnapshotJson(snapshot);
  return 0;
}

function compareWithBaseline(snapshot, baseline) {
  const comparison = compareSnapshot(snapshot, baseline);
  console.log(formatComparisonTable(comparison));
  console.log(formatComparisonSummary(comparison));
  printSnapshotJson(snapshot);

  return comparison.status === 'regressed' ? 1 : 0;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`error: ${detail}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  if (options.update) {
    return updateBaseline(captureSnapshot());
  }

  // Fail fast on a missing / corrupt baseline: running the six checks first
  // would only delay the message that asks the user to regenerate it.
  const loaded = loadBaseline();
  if (loaded.baseline === null) {
    console.error(`错误: ${loaded.error}`);
    console.error('请先运行 npm run score -- --update 生成基线。');
    return 2;
  }

  return compareWithBaseline(captureSnapshot(), loaded.baseline);
}

process.exitCode = main();
