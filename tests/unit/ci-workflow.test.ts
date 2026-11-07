import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

interface WorkflowJob {
  'runs-on'?: string;
  'timeout-minutes'?: number;
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

const workflow = parse(readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow;
const verify = workflow.jobs?.verify;
const steps = verify?.steps ?? [];

/** Commands of a `run` step, split by line and trimmed. */
function commandsOf(step: WorkflowStep): string[] {
  return (step.run ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function stepIndex(predicate: (step: WorkflowStep) => boolean): number {
  return steps.findIndex(predicate);
}

function requireStep(
  predicate: (step: WorkflowStep) => boolean,
  description: string,
): WorkflowStep {
  const step = steps.find(predicate);
  if (!step) {
    throw new Error(`the verify job is missing ${description}`);
  }
  return step;
}

const isNpmCi = (step: WorkflowStep): boolean => (step.run ?? '').trim() === 'npm ci';
const isSetupPython = (step: WorkflowStep): boolean =>
  (step.uses ?? '').startsWith('actions/setup-python@');
const isPreCommitInstall = (step: WorkflowStep): boolean =>
  /(?:^|\s)(?:pip|pipx|uv)(?:\s+tool)?\s+install\s+pre-commit(?:\s|$)/.test(step.run ?? '');
const isPreCommitRun = (step: WorkflowStep): boolean =>
  commandsOf(step).some((command) => /^pre-commit run --all-files(?:\s|$)/.test(command));
const isTypecheck = (step: WorkflowStep): boolean => (step.run ?? '').trim() === 'npm run typecheck';

describe('CI workflow', () => {
  it('keeps running on pull requests', () => {
    expect(workflow.on).toBeTypeOf('object');
    expect(Object.keys(workflow.on ?? {})).toContain('pull_request');
  });

  it('keeps the verify job with the existing timeout and steps', () => {
    expect(verify).toBeDefined();
    expect(verify?.['runs-on']).toBe('ubuntu-latest');
    expect(verify?.['timeout-minutes']).toBe(20);

    const requiredCommands = [
      'npm ci',
      'npx playwright install --with-deps chromium',
      'npm run typecheck',
      'npm run lint',
      'npm run test:unit',
      'npm run build',
      'npm run check:budget',
      'npm run test:e2e',
    ];
    for (const command of requiredCommands) {
      expect(
        steps.some((step) => (step.run ?? '').trim() === command),
        `verify job should still run "${command}"`,
      ).toBe(true);
    }
  });

  it('sets up Python and installs pre-commit after npm ci', () => {
    const setupPython = requireStep(isSetupPython, 'an actions/setup-python step');
    const install = requireStep(isPreCommitInstall, 'a pre-commit install step');

    expect(setupPython.with?.['python-version']).toBeDefined();
    // An installation command such as `pip install pre-commit`,
    // `pipx install pre-commit` or `uv tool install pre-commit`.
    expect(commandsOf(install).join('\n')).toMatch(
      /(?:^|\s)(?:pip|pipx|uv)(?:\s+tool)?\s+install\s+pre-commit(?:\s|$)/,
    );

    const npmCiIndex = stepIndex(isNpmCi);
    expect(npmCiIndex).toBeGreaterThanOrEqual(0);
    expect(npmCiIndex).toBeLessThan(stepIndex(isSetupPython));
    expect(stepIndex(isSetupPython)).toBeLessThan(stepIndex(isPreCommitInstall));
  });

  it('caches the pre-commit environments to keep the job fast', () => {
    const cache = steps.find((step) => (step.uses ?? '').startsWith('actions/cache@'));
    expect(cache, 'verify job should cache pre-commit environments with actions/cache').toBeDefined();
    expect(cache?.with?.path).toContain('~/.cache/pre-commit');
    expect(cache?.with?.key).toContain('pre-commit');
  });

  it('runs pre-commit over all files before typechecking', () => {
    const runStep = requireStep(isPreCommitRun, 'a `pre-commit run --all-files` step');
    const command = commandsOf(runStep).find((candidate) =>
      /^pre-commit run --all-files(?:\s|$)/.test(candidate),
    );
    expect(command).toContain('--show-diff-on-failure');

    const installIndex = stepIndex(isPreCommitInstall);
    const runIndex = stepIndex(isPreCommitRun);
    const typecheckIndex = stepIndex(isTypecheck);
    expect(typecheckIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThan(installIndex);
    expect(typecheckIndex).toBeGreaterThan(runIndex);
  });
});
