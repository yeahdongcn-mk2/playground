#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  CHECK_DEFINITIONS,
  buildSnapshot,
  formatScoreTable,
} from './lib/score.mjs';

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const STEP_TIMEOUT_MS = 30 * 60 * 1000;

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function describeSpawnError(error) {
  return error instanceof Error ? error.message : String(error);
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

function main() {
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
  const snapshot = buildSnapshot({
    results,
    build,
    gitCommit: git.commit,
    gitCommitError: git.error,
    generatedAt: new Date().toISOString(),
  });

  console.log(formatScoreTable(snapshot));
  console.log(`SCORE_JSON ${JSON.stringify(snapshot)}`);

  // The collection step always exits 0: baseline comparison and the regression
  // exit code belong to a follow-up task.
  return 0;
}

process.exitCode = main();
