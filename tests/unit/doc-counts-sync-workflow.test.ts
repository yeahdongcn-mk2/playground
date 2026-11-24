import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  BASELINE_RELATIVE_PATH,
  DOC_COUNT_PATHS as DOCUMENT_COUNT_PATHS,
} from '../../scripts/lib/doc-counts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI_WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');
const SYNC_WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'doc-counts-sync.yml');

const UNIT_TEST_REPORT = '"$RUNNER_TEMP/vitest-report.json"';
const UNIT_TEST_COMMAND = `npm run test:unit -- --reporter=default --reporter=json --outputFile=${UNIT_TEST_REPORT}`;
const GENERATE_COMMAND = `npm run docs:counts:write -- --report ${UNIT_TEST_REPORT}`;
const VERIFY_COMMAND = `npm run verify:doc-counts -- --report ${UNIT_TEST_REPORT}`;
/**
 * The exact files the generator may rewrite: the documents that repeat the
 * count plus the baseline. Derived from the generator's own constants so a
 * scope change fails this workflow contract instead of silently drifting.
 */
const COUNT_FILE_PATHS = [...DOCUMENT_COUNT_PATHS, BASELINE_RELATIVE_PATH];

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
  'timeout-minutes'?: number;
}

interface WorkflowJob {
  'runs-on'?: string;
  'timeout-minutes'?: number;
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, WorkflowJob>;
}

const ciWorkflow = parse(readFileSync(CI_WORKFLOW_PATH, 'utf8')) as Workflow;
const syncWorkflow = parse(readFileSync(SYNC_WORKFLOW_PATH, 'utf8')) as Workflow;
const ciSteps = ciWorkflow.jobs?.['verify']?.steps ?? [];
const syncJob = syncWorkflow.jobs?.['sync'];
const syncSteps = syncJob?.steps ?? [];

function commandsOf(step: WorkflowStep): string[] {
  return (step.run ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function stepIndex(steps: WorkflowStep[], predicate: (step: WorkflowStep) => boolean): number {
  return steps.findIndex(predicate);
}

function requireStep(
  steps: WorkflowStep[],
  predicate: (step: WorkflowStep) => boolean,
  description: string,
): WorkflowStep {
  const step = steps.find(predicate);
  if (!step) {
    throw new Error(`the workflow is missing ${description}`);
  }
  return step;
}

const isUnitTests = (step: WorkflowStep): boolean => (step.run ?? '').trim() === UNIT_TEST_COMMAND;
const isGenerate = (step: WorkflowStep): boolean => (step.run ?? '').trim() === GENERATE_COMMAND;
const isVerify = (step: WorkflowStep): boolean => (step.run ?? '').trim() === VERIFY_COMMAND;
const isInstall = (step: WorkflowStep): boolean => (step.run ?? '').trim() === 'npm ci';
const isCommit = (step: WorkflowStep): boolean =>
  (step.run ?? '').includes('git push origin HEAD:main');

describe('doc test count generation and sync workflows', () => {
  it('keeps the PR verify job generating before its unchanged count guard', () => {
    const generate = requireStep(ciSteps, isGenerate, 'a doc test count generation step');
    expect(generate.name).toBe('Generate doc test counts');
    expect((generate.run ?? '').trim()).toBe(GENERATE_COMMAND);
    expect((generate.run ?? '').trim()).toContain('--report');
    expect((generate.run ?? '').trim()).not.toContain('--update');
    expect(generate['continue-on-error']).toBeUndefined();

    const verify = requireStep(ciSteps, isVerify, 'a doc test count verify step');
    expect((verify.run ?? '').trim()).toBe(VERIFY_COMMAND);
    expect(verify['continue-on-error']).toBeUndefined();

    const unitTestsIndex = stepIndex(ciSteps, isUnitTests);
    const generateIndex = stepIndex(ciSteps, isGenerate);
    const verifyIndex = stepIndex(ciSteps, isVerify);
    expect(unitTestsIndex).toBeGreaterThanOrEqual(0);
    expect(generateIndex).toBeGreaterThan(unitTestsIndex);
    expect(verifyIndex).toBeGreaterThan(generateIndex);
  });

  it('only triggers the sync workflow on pushes to main', () => {
    expect(Object.keys(syncWorkflow.on ?? {})).toEqual(['push']);
    expect(syncWorkflow.on?.pull_request).toBeUndefined();

    const push = syncWorkflow.on?.push as { branches?: string[] } | undefined;
    expect(push?.branches).toEqual(['main']);
  });

  it('grants contents: write so the bot can commit the regenerated files', () => {
    expect(syncWorkflow.permissions?.contents).toBe('write');
  });

  it('serializes overlapping main pushes before the bot commits', () => {
    expect(syncWorkflow.concurrency).toEqual({
      group: 'doc-counts-sync',
      'cancel-in-progress': true,
    });
  });

  it('installs dependencies and runs the unit tests on ubuntu-latest with node 24', () => {
    expect(syncJob?.['runs-on']).toBe('ubuntu-latest');

    const checkout = syncSteps.find((step) => (step.uses ?? '').startsWith('actions/checkout@'));
    expect(checkout).toBeDefined();

    const setupNode = syncSteps.find((step) =>
      (step.uses ?? '').startsWith('actions/setup-node@'),
    );
    expect(setupNode).toBeDefined();
    expect(String(setupNode?.with?.['node-version'])).toBe('24');

    const installIndex = stepIndex(syncSteps, isInstall);
    const unitTestsIndex = stepIndex(syncSteps, isUnitTests);
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(unitTestsIndex).toBeGreaterThan(installIndex);
    expect((syncSteps[unitTestsIndex]?.run ?? '').trim()).toBe(UNIT_TEST_COMMAND);
  });

  it('generates from the unit-test report and verifies it before committing', () => {
    const generate = requireStep(syncSteps, isGenerate, 'a doc test count generation step');
    expect((generate.run ?? '').trim()).toBe(GENERATE_COMMAND);
    expect((generate.run ?? '').trim()).toContain('--report');
    expect((generate.run ?? '').trim()).not.toContain('--update');

    const verify = requireStep(syncSteps, isVerify, 'a doc test count verify step');
    expect((verify.run ?? '').trim()).toBe(VERIFY_COMMAND);
    expect(verify['continue-on-error']).toBeUndefined();

    const unitTestsIndex = stepIndex(syncSteps, isUnitTests);
    const generateIndex = stepIndex(syncSteps, isGenerate);
    const verifyIndex = stepIndex(syncSteps, isVerify);
    const commitIndex = stepIndex(syncSteps, isCommit);
    expect(unitTestsIndex).toBeGreaterThanOrEqual(0);
    expect(generateIndex).toBeGreaterThan(unitTestsIndex);
    expect(verifyIndex).toBeGreaterThan(generateIndex);
    expect(commitIndex).toBeGreaterThan(verifyIndex);

    for (const step of syncSteps) {
      expect(step['continue-on-error']).toBeUndefined();
    }
    for (const command of syncSteps.flatMap(commandsOf)) {
      expect(command).not.toContain('--update');
    }
  });

  it('stages exactly the four count files and does nothing when they are current', () => {
    const commit = requireStep(syncSteps, isCommit, 'a commit step');
    const run = commit.run ?? '';
    expect(commit.shell).toBe('bash');

    // Nothing to commit: the generator reported the committed counts as fresh.
    expect(run).toContain('if git diff --quiet; then');
    expect(run).toContain('exit 0');

    // Any non-empty diff must be exactly the generated paths.
    expect(run).toContain('git diff --name-only');
    expect(run).toMatch(/if \[ "\$changed" != "\$expected" \]; then/);
    expect(run).toContain('exit 1');

    // The expected set itself must name all four paths: the `git add` line
    // below also lists them, so checking only the whole script would not catch
    // a dropped path in the comparison.
    const expectedStart = run.indexOf('expected="$(printf');
    const expectedEnd = run.indexOf('changed="$(git diff');
    expect(expectedStart).toBeGreaterThanOrEqual(0);
    expect(expectedEnd).toBeGreaterThan(expectedStart);
    const expectedPaths =
      run.slice(expectedStart, expectedEnd).match(/[A-Za-z0-9_./-]+\.(?:md|json)/g) ?? [];
    expect(expectedPaths).toHaveLength(COUNT_FILE_PATHS.length);
    expect(new Set(expectedPaths)).toEqual(new Set(COUNT_FILE_PATHS));

    const addCommands = commandsOf(commit).filter((command) => /^git add\b/.test(command));
    expect(addCommands).toEqual([`git add -- ${COUNT_FILE_PATHS.join(' ')}`]);

    expect(run).toContain('git diff --cached --quiet');
    expect(run).toContain('github-actions[bot]');
    expect(run).toContain('41898282+github-actions[bot]@users.noreply.github.com');
    expect(run).toContain('[skip ci]');
    expect(run).toContain('git push origin HEAD:main');

    // No force push: a rejected main push should fail instead of overwriting.
    for (const command of commandsOf(commit)) {
      expect(command).not.toMatch(/git push[^\n]*--force/);
      expect(command).not.toMatch(/git push[^\n]*\s-f(?:\s|$)/);
      expect(command).not.toMatch(/git push[^\n]*\+HEAD/);
    }
  });
});

/**
 * The commit step is the only runtime logic in the sync workflow: it decides
 * whether the regenerated counts are committable, stages exactly the four
 * generated paths, commits and pushes. Text assertions cannot falsify those
 * branches, so every case below executes the YAML `run` block itself against a
 * throwaway git repository and a local bare remote.
 */
const commitStepScript = requireStep(syncSteps, isCommit, 'a commit step').run ?? '';

interface ScratchRepository {
  root: string;
  work: string;
  remote: string;
  env: NodeJS.ProcessEnv;
}

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratchEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'empty-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // git push's rejection text is localized; pin the messages the test reads.
    LC_ALL: 'C',
  };
}

function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function gitOk(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = git(cwd, args, env);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

function writeTrackedFile(work: string, relativePath: string, contents: string): void {
  const absolutePath = join(work, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function createScratchRepository(): ScratchRepository {
  const root = mkdtempSync(join(tmpdir(), 'doc-counts-sync-'));
  scratchRoots.push(root);
  writeFileSync(join(root, 'empty-gitconfig'), '');

  const env = scratchEnv(root);
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  mkdirSync(work);
  gitOk(root, ['init', '--bare', '--initial-branch=main', remote], env);
  gitOk(work, ['init', '--initial-branch=main'], env);
  gitOk(work, ['config', 'user.name', 'Doc counts test'], env);
  gitOk(work, ['config', 'user.email', 'doc-counts-test@example.com'], env);

  writeTrackedFile(work, 'package.json', '{"name":"scratch"}\n');
  for (const relativePath of COUNT_FILE_PATHS) {
    writeTrackedFile(work, relativePath, `counts for ${relativePath}\n`);
  }

  gitOk(work, ['add', '--all'], env);
  gitOk(work, ['commit', '-m', 'initial'], env);
  gitOk(work, ['remote', 'add', 'origin', remote], env);
  gitOk(work, ['push', '--set-upstream', 'origin', 'main'], env);
  return { root, work, remote, env };
}

function regenerateCountFile(scratch: ScratchRepository, relativePath: string): void {
  writeFileSync(join(scratch.work, relativePath), `regenerated ${relativePath}\n`);
}

function runCommitStep(scratch: ScratchRepository): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const scriptPath = join(scratch.root, 'commit-counts.sh');
  writeFileSync(scriptPath, commitStepScript);
  const result = spawnSync('bash', ['--noprofile', '--norc', scriptPath], {
    cwd: scratch.work,
    env: scratch.env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function remoteMainHead(scratch: ScratchRepository): string {
  return gitOk(scratch.remote, ['rev-parse', 'main'], scratch.env).trim();
}

function remoteMainCommitCount(scratch: ScratchRepository): number {
  return Number(gitOk(scratch.remote, ['rev-list', '--count', 'main'], scratch.env).trim());
}

function workHead(scratch: ScratchRepository): string {
  return gitOk(scratch.work, ['rev-parse', 'HEAD'], scratch.env).trim();
}

function remoteChangedPaths(scratch: ScratchRepository): string[] {
  return gitOk(scratch.remote, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'main'], scratch.env)
    .trim()
    .split('\n')
    .filter((path) => path.length > 0)
    .sort();
}

describe('doc test count sync commit step in a scratch repository', () => {
  it('exits 0 without committing when the generated counts are already current', () => {
    const scratch = createScratchRepository();
    const before = remoteMainHead(scratch);

    const result = runCommitStep(scratch);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nothing to commit');
    expect(remoteMainHead(scratch)).toBe(before);
    expect(workHead(scratch)).toBe(before);
    expect(remoteMainCommitCount(scratch)).toBe(1);
  });

  it('commits and pushes exactly the four regenerated count files', () => {
    const scratch = createScratchRepository();
    const before = remoteMainHead(scratch);

    for (const relativePath of COUNT_FILE_PATHS) {
      regenerateCountFile(scratch, relativePath);
    }
    const result = runCommitStep(scratch);

    expect(result.status).toBe(0);
    expect(remoteMainHead(scratch)).not.toBe(before);
    expect(workHead(scratch)).toBe(remoteMainHead(scratch));
    expect(remoteMainCommitCount(scratch)).toBe(2);
    expect(remoteChangedPaths(scratch)).toEqual([...COUNT_FILE_PATHS].sort());
    expect(
      gitOk(scratch.remote, ['log', '-1', '--format=%s', 'main'], scratch.env).trim(),
    ).toBe('docs: sync generated unit test counts [skip ci]');
    expect(gitOk(scratch.remote, ['log', '-1', '--format=%an', 'main'], scratch.env).trim()).toBe(
      'github-actions[bot]',
    );
    expect(gitOk(scratch.remote, ['log', '-1', '--format=%ae', 'main'], scratch.env).trim()).toBe(
      '41898282+github-actions[bot]@users.noreply.github.com',
    );
    expect(gitOk(scratch.work, ['status', '--porcelain'], scratch.env).trim()).toBe('');
  });

  it('refuses a partial regeneration instead of committing half the set', () => {
    const scratch = createScratchRepository();
    const before = remoteMainHead(scratch);

    const [firstCountFile] = COUNT_FILE_PATHS;
    if (!firstCountFile) throw new Error('the generator has no count documents');
    regenerateCountFile(scratch, firstCountFile);
    const result = runCommitStep(scratch);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unexpected paths');
    expect(result.stderr).toContain(firstCountFile);
    expect(remoteMainHead(scratch)).toBe(before);
    expect(workHead(scratch)).toBe(before);
    expect(remoteMainCommitCount(scratch)).toBe(1);
  });

  it('refuses a diff that touches an extra tracked path next to the four', () => {
    const scratch = createScratchRepository();
    const before = remoteMainHead(scratch);

    for (const relativePath of COUNT_FILE_PATHS) {
      regenerateCountFile(scratch, relativePath);
    }
    writeFileSync(join(scratch.work, 'package.json'), '{"name":"scratch","extra":true}\n');
    const result = runCommitStep(scratch);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unexpected paths');
    expect(result.stderr).toContain('package.json');
    expect(remoteMainHead(scratch)).toBe(before);
    expect(remoteMainCommitCount(scratch)).toBe(1);
  });

  it('refuses a diff that only touches an unrelated tracked path', () => {
    const scratch = createScratchRepository();
    const before = remoteMainHead(scratch);

    writeFileSync(join(scratch.work, 'package.json'), '{"name":"scratch","extra":true}\n');
    const result = runCommitStep(scratch);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unexpected paths');
    expect(remoteMainHead(scratch)).toBe(before);
    expect(remoteMainCommitCount(scratch)).toBe(1);
  });

  it('does not force-push over a main commit that landed first', () => {
    const scratch = createScratchRepository();
    const other = join(scratch.root, 'other');
    gitOk(scratch.root, ['clone', scratch.remote, other], scratch.env);
    gitOk(other, ['config', 'user.name', 'Doc counts test'], scratch.env);
    gitOk(other, ['config', 'user.email', 'doc-counts-test@example.com'], scratch.env);
    writeTrackedFile(other, 'README.md', 'advanced on remote\n');
    gitOk(other, ['add', '--all'], scratch.env);
    gitOk(other, ['commit', '-m', 'advance main'], scratch.env);
    gitOk(other, ['push', 'origin', 'main'], scratch.env);
    const remoteAhead = remoteMainHead(scratch);
    expect(remoteMainCommitCount(scratch)).toBe(2);

    for (const relativePath of COUNT_FILE_PATHS) {
      regenerateCountFile(scratch, relativePath);
    }
    const result = runCommitStep(scratch);

    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain('rejected');
    expect(remoteMainHead(scratch)).toBe(remoteAhead);
    expect(remoteMainCommitCount(scratch)).toBe(2);
    expect(gitOk(scratch.remote, ['show', 'main:README.md'], scratch.env)).toBe(
      'advanced on remote\n',
    );
  });
});
