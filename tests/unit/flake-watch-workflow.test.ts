import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEFAULT_E2E_REPORT_PATH } from '../../scripts/lib/e2e-flakes.mjs';
import {
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
  imageTagForPlaywrightVersion,
  readPlaywrightVersion,
} from '../../scripts/lib/capture-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'flake-watch.yml');
const CI_WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, 'utf8');
const SUMMARY_SCRIPT = join(ROOT, 'scripts', 'flake-watch-summary.mjs');
const REPEAT_COUNT = 5;
const TEST_STEP_ID = 'flake-watch';
/** Steps the pinned image makes unnecessary; Issue #213 removed them. */
const REMOVED_STEP_NAMES = [
  'Configure apt Acquire retries and timeouts',
  'Cache Playwright browsers',
  'Install Playwright WebKit',
];
const TEST_COMMAND_TOKENS = [
  'npx playwright test',
  '--project=mobile-webkit',
  '-g "hub and blank canvas"',
  `--repeat-each=${REPEAT_COUNT}`,
  '--retries=0',
];

interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
  'timeout-minutes'?: number;
}

interface WorkflowJob {
  'runs-on'?: string;
  'timeout-minutes'?: number;
  container?: string | { image?: string; options?: string };
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
}

const workflow = parse(WORKFLOW_SOURCE) as Workflow;
const job = workflow.jobs?.['mobile-webkit-first-run'];
const steps = job?.steps ?? [];

const isFlakeCheck = (step: WorkflowStep): boolean =>
  (step.run ?? '').includes('npx playwright test');

function stepIndex(predicate: (step: WorkflowStep) => boolean): number {
  return steps.findIndex(predicate);
}

function requireStep(
  predicate: (step: WorkflowStep) => boolean,
  description: string,
): WorkflowStep {
  const step = steps.find(predicate);
  if (!step) {
    throw new Error(`the flake-watch job is missing ${description}`);
  }
  return step;
}

describe('flake-watch workflow', () => {
  it('only runs on a daily schedule or manual dispatch', () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.on?.push).toBeUndefined();
    expect(workflow.on?.pull_request).toBeUndefined();

    const schedule = workflow.on?.schedule as Array<{ cron?: string }> | undefined;
    expect(schedule).toHaveLength(1);
    expect(schedule?.[0]?.cron).toBe('17 3 * * *');

    // Guard against a push/pull_request trigger being added in any form; this
    // workflow must never lengthen regular PR CI.
    expect(WORKFLOW_SOURCE).not.toMatch(/^\s{0,2}(?:push|pull_request):/m);
  });

  it('grants read-only repository contents permission', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('runs in the same pinned Playwright image as the verify job', () => {
    const container = job?.container;
    const image = typeof container === 'string' ? container : container?.image;
    expect(image, 'the watch job should declare a container image').toBeDefined();

    // `npm ci` installs the @playwright/test version recorded in the lockfile,
    // so the shared pin must cover that exact version. The tag is derived from
    // the version and the digest fixes the multi-arch image.
    expect(PLAYWRIGHT_IMAGE_PIN.version).toBe(readPlaywrightVersion());
    expect(PLAYWRIGHT_IMAGE_PIN.tag).toBe(
      imageTagForPlaywrightVersion(PLAYWRIGHT_IMAGE_PIN.version),
    );
    expect(PLAYWRIGHT_IMAGE_PIN.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const expectedImage = `${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}`;
    expect(image).toBe(expectedImage);

    // Issue #213 requires the scheduled watch to use the exact same image as
    // the PR verify job, so a Playwright bump updates one workflow rather than
    // leaving the two environments to drift.
    const ciWorkflow = parse(readFileSync(CI_WORKFLOW_PATH, 'utf8')) as Workflow;
    const verifyContainer = ciWorkflow.jobs?.verify?.container;
    const verifyImage =
      typeof verifyContainer === 'string' ? verifyContainer : verifyContainer?.image;
    expect(verifyImage).toBe(expectedImage);
    expect(image).toBe(verifyImage);

    // GitHub's container jobs default to a 64 MB /dev/shm; WebKit needs the
    // host IPC namespace, matching the verify job and the capture container.
    const options =
      typeof container === 'object' && container !== null ? (container.options ?? '') : '';
    expect(options.split(/\s+/)).toContain('--ipc=host');
  });

  it('prepares dependencies and the build before the repeated check', () => {
    const checkout = steps[0];
    expect(checkout?.uses).toMatch(/^actions\/checkout@/);

    const setupNode = steps[1];
    expect(setupNode?.uses).toMatch(/^actions\/setup-node@/);
    expect(setupNode?.with?.['node-version']).toBe(24);
    expect(setupNode?.with?.cache).toBe('npm');

    const commands = steps.map((step) => (step.run ?? '').trim());
    const installIndex = commands.indexOf('npm ci');
    const buildIndex = commands.indexOf('npm run build');
    const checkIndex = stepIndex(isFlakeCheck);

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(installIndex);
    expect(checkIndex).toBeGreaterThan(buildIndex);
  });

  it('does not install browsers, cache ms-playwright or configure apt at runtime', () => {
    // The pinned image already ships WebKit and its system dependencies, so
    // the three Issue #202 install steps must stay gone.
    for (const name of REMOVED_STEP_NAMES) {
      expect(
        steps.some((step) => step.name === name),
        `the watch job should not have the "${name}" step`,
      ).toBe(false);
    }
    // Only the browser cache is forbidden; a future non-browser cache (for
    // example a build cache) should not trip this assertion. The precise
    // check is the `ms-playwright` path below.
    expect(
      steps.some((step) => String(step.with?.path ?? '').includes('ms-playwright')),
      'the image supplies the browsers, so the watch must not cache them',
    ).toBe(false);

    for (const command of steps.map((step) => step.run ?? '')) {
      // A browser install would reintroduce the Issue #202 failure mode and
      // ignore the image pin; apt is part of that install path. Match any
      // `apt`/`apt-get` token so option forms such as `apt-get -y install`
      // and `apt -y install` cannot slip through.
      expect(command).not.toMatch(/\bplaywright\s+install\b/);
      expect(command).not.toContain('--with-deps');
      expect(command).not.toMatch(/\bapt(?:-get)?\b/i);
      expect(command).not.toContain('scripts/install-playwright-ci.mjs');
    }
  });

  it('repeats the mobile-webkit hub case five times without retries', () => {
    const check = requireStep(isFlakeCheck, 'the repeated mobile-webkit check');
    expect(check.id).toBe(TEST_STEP_ID);

    for (const token of TEST_COMMAND_TOKENS) {
      expect(check.run, `the check command should contain "${token}"`).toContain(token);
    }
    // A plain substring would also accept --repeat-each=50 or 500, which could
    // outgrow the 30-minute job while this test still passed.
    expect(check.run).toMatch(/--repeat-each=5(?:\s|$)/);

    // A retry can no longer turn a cold-start failure into a pass, and a trace
    // must still be retained when the single attempt fails.
    expect(check.env?.CI).toBe('true');
    expect(check.run).toContain('--trace=retain-on-failure');
  });

  it('keeps the job timeout long enough for five full runs', () => {
    expect(job?.['runs-on']).toBe('ubuntu-latest');
    expect(job?.['timeout-minutes']).toBe(30);
  });

  it('fails the job instead of tolerating a flaky repeat', () => {
    for (const step of steps) {
      expect(step['continue-on-error'] ?? false).toBe(false);
    }
    expect(WORKFLOW_SOURCE).not.toContain('continue-on-error');
  });

  it('writes the step summary through the summary script', () => {
    const summary = requireStep(
      (step) => (step.run ?? '').includes('GITHUB_STEP_SUMMARY'),
      'a step-summary step',
    );
    expect(summary.if).toBe('always()');
    expect(summary.run).toContain('node scripts/flake-watch-summary.mjs');
    expect(summary.run).toContain('$GITHUB_STEP_SUMMARY');
    expect(summary.env?.FLAKE_WATCH_OUTCOME).toBe(`\${{ steps.${TEST_STEP_ID}.outcome }}`);
    expect(stepIndex((step) => (step.run ?? '').includes('GITHUB_STEP_SUMMARY'))).toBeGreaterThan(
      stepIndex(isFlakeCheck),
    );
  });

  it('summarizes the Playwright JSON report stats in the step summary', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'flake-watch-summary-'));
    try {
      const reportPath = join(workDir, DEFAULT_E2E_REPORT_PATH);
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(
        reportPath,
        JSON.stringify({ stats: { expected: 5, unexpected: 2, flaky: 1, skipped: 3 } }),
      );

      // Run the real script against a report fixture at the canonical path, so
      // deleting a stat or swapping its label fails here instead of silently
      // changing the job summary.
      const summary = execFileSync(process.execPath, [SUMMARY_SCRIPT], {
        cwd: workDir,
        encoding: 'utf8',
        env: { ...process.env, FLAKE_WATCH_OUTCOME: 'success', FLAKE_WATCH_REPORT_PATH: '' },
      });
      expect(summary).toContain('重复次数：5');
      expect(summary).toContain('重试次数：0');
      expect(summary).toContain('结果：success');
      expect(summary).toContain('首跑通过：5');
      expect(summary).toContain('失败：2');
      expect(summary).toContain('重试后通过：1');
      expect(summary).toContain('跳过：3');

      // A missing report must still produce a summary and name the problem.
      const missing = execFileSync(process.execPath, [SUMMARY_SCRIPT], {
        cwd: workDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          FLAKE_WATCH_OUTCOME: 'failure',
          FLAKE_WATCH_REPORT_PATH: join(workDir, 'missing.json'),
        },
      });
      expect(missing).toContain('结果：failure');
      expect(missing).toContain('无法读取 Playwright JSON 报告');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('uploads the Playwright report and failure evidence when the check finishes', () => {
    const upload = requireStep(
      (step) => (step.uses ?? '').startsWith('actions/upload-artifact@'),
      'an upload-artifact step',
    );
    expect(upload.if).toBe('always()');
    // Trace, failure screenshot and the JSON report all live under this path.
    expect(upload.with?.path).toContain('test-results/');
    expect(upload.with?.['if-no-files-found']).toBe('ignore');
    expect(stepIndex((step) => (step.uses ?? '').startsWith('actions/upload-artifact@'))).toBeGreaterThan(
      stepIndex(isFlakeCheck),
    );
  });
});
