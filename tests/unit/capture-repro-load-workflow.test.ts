import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  DEFAULT_REPRO_LOAD_RUNS,
  DEFAULT_REPRO_LOAD_TARGETS,
  DEFAULT_REPRO_LOAD_WORKERS,
  MIN_REPRO_LOAD_RUNS,
  REPRO_LOAD_INPUT_ENV,
} from '../../scripts/lib/repro-load-inputs.mjs';
import { deriveReproPlans } from '../../scripts/lib/screenshot-repro.mjs';
import {
  DEFAULT_MANIFEST_DIR,
  DEFAULT_MANIFEST_PATH,
  loadSha256Manifests,
  parseSha256Manifest,
} from '../../scripts/lib/screenshot-sha256.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'capture-repro-load.yml');
const NIGHTLY_PATH = join(ROOT, '.github', 'workflows', 'capture-repro.yml');
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, 'utf8');
const NIGHTLY_SOURCE = readFileSync(NIGHTLY_PATH, 'utf8');
const MANIFEST_PATH = join(ROOT, DEFAULT_MANIFEST_PATH);
const PACKAGE_PATH = join(ROOT, 'package.json');
const INPUT_VALIDATOR = 'node scripts/check-repro-load-inputs.mjs';
/** Every manifest the repro entry discovers, including the target splits. */
const MANIFESTS = loadSha256Manifests({ dir: join(ROOT, DEFAULT_MANIFEST_DIR) });
/** The read-only assertion both repro workflows run after the capture step. */
const MANIFEST_UNCHANGED_COMMAND =
  "git diff --exit-code -- 'docs/screenshots/capture-sha256-manifest*.json'";

/** The pathspecs after `--` in one git command, with their quotes removed. */
function commandPathspecs(command: string): string[] {
  const match = /\s--\s+(.+)$/.exec(command.trim());
  if (!match?.[1]) {
    throw new Error(
      `expected a git command with a pathspec, got ${JSON.stringify(command)}`,
    );
  }
  return match[1]
    .trim()
    .split(/\s+/)
    .map((pathspec) => pathspec.replace(/^['"]|['"]$/g, ''));
}

/** Match one git pathspec glob (`*` / `?`) against a repository-relative path. */
function pathspecMatches(pathspec: string, path: string): boolean {
  if (pathspec === path) {
    return true;
  }
  const source = [...pathspec]
    .map((char) => {
      if (char === '*') {
        return '.*';
      }
      if (char === '?') {
        return '.';
      }
      return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    })
    .join('');
  return new RegExp(`^${source}$`).test(path);
}

/** Whether the step's pathspecs cover one discovered manifest path. */
function pathspecsCover(path: string, pathspecs: string[]): boolean {
  return pathspecs.some((pathspec) => pathspecMatches(pathspec, path));
}

interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  'runs-on'?: string;
  'timeout-minutes'?: number;
  container?: unknown;
  steps?: WorkflowStep[];
}

interface WorkflowInput {
  description?: string;
  required?: boolean;
  type?: string;
  default?: string;
}

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
}

const workflow = parse(WORKFLOW_SOURCE) as Workflow;
const nightly = parse(NIGHTLY_SOURCE) as Workflow;
const job = workflow.jobs?.['load-repro'];
const steps = job?.steps ?? [];
const dispatchInputs = (
  workflow.on?.workflow_dispatch as { inputs?: Record<string, WorkflowInput> } | undefined
)?.inputs;
const scripts = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).scripts as Record<
  string,
  string
>;

function requireStep(
  predicate: (step: WorkflowStep) => boolean,
  description: string,
): WorkflowStep {
  const step = steps.find(predicate);
  if (!step) {
    throw new Error(`the load-repro job is missing ${description}`);
  }
  return step;
}

describe('capture-repro-load workflow (Issue #352)', () => {
  it('only runs on a daily schedule or manual dispatch', () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.on?.push).toBeUndefined();
    expect(workflow.on?.pull_request).toBeUndefined();
    expect(WORKFLOW_SOURCE).not.toMatch(/^\s{0,2}(?:push|pull_request):/m);

    const schedule = workflow.on?.schedule as Array<{ cron?: string }> | undefined;
    expect(schedule).toHaveLength(1);
    expect(schedule?.[0]?.cron).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);

    // The load gate is a second, independent nightly: it must not replace or
    // duplicate the 04:41 two-run job's slot.
    const nightlySchedule = nightly.on?.schedule as Array<{ cron?: string }> | undefined;
    expect(schedule?.[0]?.cron).not.toBe(nightlySchedule?.[0]?.cron);
  });

  it('exposes exactly the targets, runs and load dispatch inputs', () => {
    expect(Object.keys(dispatchInputs ?? {}).sort()).toEqual(['load', 'runs', 'targets']);

    const targets = dispatchInputs?.targets;
    const runs = dispatchInputs?.runs;
    const load = dispatchInputs?.load;

    expect(targets?.default).toBe(DEFAULT_REPRO_LOAD_TARGETS.join(','));
    expect(runs?.default).toBe(String(DEFAULT_REPRO_LOAD_RUNS));
    expect(load?.default).toBe(String(DEFAULT_REPRO_LOAD_WORKERS));

    // The dispatch default and the validator floor are the same 4: a manual
    // run must not quietly downgrade the gate to the nightly's two runs.
    expect(DEFAULT_REPRO_LOAD_RUNS).toBe(MIN_REPRO_LOAD_RUNS);
    expect(runs?.description).toContain(`>= ${MIN_REPRO_LOAD_RUNS}`);

    for (const input of [targets, runs, load]) {
      expect(input?.required).toBe(false);
      expect(input?.type).toBe('string');
    }
  });

  it('defaults to the three affected WebKit targets the manifest names', () => {
    expect([...DEFAULT_REPRO_LOAD_TARGETS]).toEqual([
      'screenshots:webkit',
      'screenshots:breakout:webkit',
      'screenshots:snake:webkit',
    ]);
    expect(DEFAULT_REPRO_LOAD_TARGETS.every((target) => target.endsWith(':webkit'))).toBe(
      true,
    );

    const manifest = parseSha256Manifest(readFileSync(MANIFEST_PATH, 'utf8'));
    const manifestTargets = deriveReproPlans(manifest).map((plan) => plan.target);
    for (const target of DEFAULT_REPRO_LOAD_TARGETS) {
      expect(manifestTargets).toContain(target);
    }
  });

  it('validates the dispatch inputs before they reach a run script', () => {
    const validateStep = requireStep(
      (step) => step.id === 'validate',
      'an input validation step',
    );
    expect(validateStep.run?.trim()).toBe(INPUT_VALIDATOR);
    expect(validateStep.env).toEqual({
      [REPRO_LOAD_INPUT_ENV.targets]: '${{ inputs.targets }}',
      [REPRO_LOAD_INPUT_ENV.runs]: '${{ inputs.runs }}',
      [REPRO_LOAD_INPUT_ENV.load]: '${{ inputs.load }}',
    });

    const validateIndex = steps.indexOf(validateStep);
    const captureIndex = steps.findIndex((step) =>
      (step.run ?? '').includes('npm run verify:screenshots:repro'),
    );
    expect(validateIndex).toBeGreaterThanOrEqual(0);
    expect(captureIndex).toBeGreaterThan(validateIndex);

    // No raw dispatch expression may be interpolated into a run script; the
    // inputs only enter through the env maps above.
    for (const step of steps) {
      expect(step.run ?? '').not.toMatch(
        /\$\{\{\s*(?:inputs|github\.event\.inputs)\./,
      );
    }
  });

  it('runs the repro with --target / --runs / --load from the validated outputs', () => {
    expect(scripts['verify:screenshots:repro']).toBe(
      'node scripts/verify-screenshot-repro.mjs',
    );

    const captureStep = requireStep(
      (step) => (step.run ?? '').includes('npm run verify:screenshots:repro'),
      'the load-gated repro step',
    );
    expect(captureStep.env).toEqual({
      TARGETS: '${{ steps.validate.outputs.targets }}',
      RUNS: '${{ steps.validate.outputs.runs }}',
      LOAD: '${{ steps.validate.outputs.load }}',
    });

    const command = captureStep.run ?? '';
    expect(command).toContain('npm run verify:screenshots:repro --');
    expect(command).toContain('--target');
    expect(command).toContain('--runs');
    expect(command).toContain('--load');
    expect(command).toContain('--runs "$RUNS"');
    expect(command).toContain('--load "$LOAD"');
  });

  it('grants read-only contents permission and leaves the container to the entry', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job).toBeDefined();
    expect(job?.['runs-on']).toBe('ubuntu-latest');
    // scripts/run-container-capture.mjs starts the fixed Playwright container;
    // a job-level `container:` would shadow the environment under test.
    expect(job?.container).toBeUndefined();
  });

  it('keeps a bounded timeout for four runs of three container targets', () => {
    const timeout = job?.['timeout-minutes'];
    expect(timeout).toBe(120);
    // Bounded below GitHub's six-hour maximum, but above the nightly's 60
    // minutes because the same twelve captures run under injected load.
    const nightlyJob = nightly.jobs?.repro;
    expect(typeof nightlyJob?.['timeout-minutes']).toBe('number');
    expect(timeout).toBeGreaterThan(nightlyJob?.['timeout-minutes'] ?? 0);
    expect(timeout).toBeLessThanOrEqual(360);
  });

  it('installs dependencies before the capture runs', () => {
    const checkoutIndex = steps.findIndex((step) =>
      (step.uses ?? '').startsWith('actions/checkout@'),
    );
    const setupIndex = steps.findIndex((step) =>
      (step.uses ?? '').startsWith('actions/setup-node@'),
    );
    const installIndex = steps.findIndex((step) => (step.run ?? '').trim() === 'npm ci');
    const captureIndex = steps.findIndex((step) =>
      (step.run ?? '').includes('npm run verify:screenshots:repro'),
    );

    expect(checkoutIndex).toBe(0);
    expect(setupIndex).toBeGreaterThan(checkoutIndex);
    expect(steps[setupIndex]?.with?.['node-version']).toBe(24);
    expect(steps[setupIndex]?.with?.cache).toBe('npm');
    expect(installIndex).toBeGreaterThan(setupIndex);
    expect(captureIndex).toBeGreaterThan(installIndex);
  });

  it('uploads both run logs and checks every manifest even after a failure', () => {
    const upload = requireStep(
      (step) => (step.uses ?? '').startsWith('actions/upload-artifact@'),
      'an artifact upload',
    );
    expect(upload.if).toBe('always()');
    expect(upload.with?.name).toBe('capture-repro-load-logs');
    expect(upload.with?.path).toContain('test-results/screenshot-repro/');
    expect(upload.with?.path).toContain('test-results/capture-container/');

    const manifestCheck = requireStep(
      (step) => (step.run ?? '').trim() === MANIFEST_UNCHANGED_COMMAND,
      'a manifests-unchanged assertion',
    );
    expect(manifestCheck.if).toBe('always()');

    // The load gate accepts manifest targets, so its read-only step must cover
    // every discovered manifest (WebKit + desktop + mobile), not only WebKit.
    const manifestPaths = MANIFESTS.map(({ path }) =>
      relative(ROOT, path).split('\\').join('/'),
    );
    for (const required of [
      DEFAULT_MANIFEST_PATH,
      'docs/screenshots/capture-sha256-manifest-desktop.json',
      'docs/screenshots/capture-sha256-manifest-mobile.json',
    ]) {
      expect(manifestPaths).toContain(required);
    }

    const pathspecs = commandPathspecs(manifestCheck.run ?? '');
    expect(pathspecs.length).toBeGreaterThan(0);
    for (const path of manifestPaths) {
      expect(pathspecsCover(path, pathspecs)).toBe(true);
    }

    for (const step of steps) {
      const command = (step.run ?? '').trim();
      expect(command).not.toMatch(/\bgit\s+(?:commit|add|checkout|restore)\b/);
      expect(command).not.toMatch(/\bcapture-sha256-manifest\.json\b.*>/);
    }
  });

  it('leaves the existing nightly two-run contract unchanged', () => {
    expect(Object.keys(nightly.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
    const schedule = nightly.on?.schedule as Array<{ cron?: string }> | undefined;
    expect(schedule).toHaveLength(1);
    expect(schedule?.[0]?.cron).toBe('41 4 * * *');
    expect(nightly.permissions).toEqual({ contents: 'read' });

    // The new job lives in its own workflow; the nightly still has exactly the
    // one repro job, and it still runs the entry without any load arguments.
    expect(Object.keys(nightly.jobs ?? {})).toEqual(['repro']);
    const nightlyJob = nightly.jobs?.repro;
    expect(nightlyJob?.['timeout-minutes']).toBe(60);
    const nightlyCommands = (nightlyJob?.steps ?? []).map((step) => (step.run ?? '').trim());
    const reproCommand = nightlyCommands.find((command) =>
      command.includes('verify:screenshots:repro'),
    );
    expect(reproCommand).toBe('npm run verify:screenshots:repro');
    expect(reproCommand).not.toMatch(/--(?:target|runs|load)\b/);
    expect(NIGHTLY_SOURCE).not.toContain('capture-repro-load');
  });
});
