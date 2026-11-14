import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEFAULT_E2E_REPORT_PATH } from '../../scripts/lib/e2e-flakes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'flake-watch.yml');
const CI_WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, 'utf8');
const SUMMARY_SCRIPT = join(ROOT, 'scripts', 'flake-watch-summary.mjs');
const REPEAT_COUNT = 5;
const TEST_STEP_ID = 'flake-watch';
const PLAYWRIGHT_INSTALL_COMMAND = 'node scripts/install-playwright-ci.mjs webkit';
const PLAYWRIGHT_INSTALL_TIMEOUT_MINUTES = 8;
const PLAYWRIGHT_CACHE_PATH = '~/.cache/ms-playwright';
const APT_ACQUIRE_CONFIG_PATH = '/etc/apt/apt.conf.d/99-ci-acquire';
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
const isPlaywrightInstall = (step: WorkflowStep): boolean =>
  (step.run ?? '').trim() === PLAYWRIGHT_INSTALL_COMMAND;
const isPlaywrightCache = (step: WorkflowStep): boolean =>
  (step.with?.path ?? '') === PLAYWRIGHT_CACHE_PATH;
const isAptAcquireConfig = (step: WorkflowStep): boolean =>
  (step.run ?? '').includes(APT_ACQUIRE_CONFIG_PATH);

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

  it('prepares dependencies, WebKit and the build before the repeated check', () => {
    const checkout = steps[0];
    expect(checkout?.uses).toMatch(/^actions\/checkout@/);

    const setupNode = steps[1];
    expect(setupNode?.uses).toMatch(/^actions\/setup-node@/);
    expect(setupNode?.with?.['node-version']).toBe(24);
    expect(setupNode?.with?.cache).toBe('npm');

    const commands = steps.map((step) => (step.run ?? '').trim());
    const installIndex = commands.indexOf('npm ci');
    const playwrightIndex = commands.indexOf(PLAYWRIGHT_INSTALL_COMMAND);
    const buildIndex = commands.indexOf('npm run build');
    const checkIndex = stepIndex(isFlakeCheck);

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(playwrightIndex).toBeGreaterThan(installIndex);
    expect(buildIndex).toBeGreaterThan(playwrightIndex);
    expect(checkIndex).toBeGreaterThan(buildIndex);

    // The raw install command must not come back: it has no retries, no
    // step-level timeout and no diagnostic output for apt/DNS failures.
    expect(WORKFLOW_SOURCE).not.toContain('npx playwright install');
  });

  it('installs WebKit through the bounded wrapper with an explicit step timeout', () => {
    const install = requireStep(isPlaywrightInstall, 'a Playwright install step');
    expect(install.name).toBe('Install Playwright WebKit');
    expect((install.run ?? '').trim()).toBe(PLAYWRIGHT_INSTALL_COMMAND);
    expect(install['timeout-minutes']).toBe(PLAYWRIGHT_INSTALL_TIMEOUT_MINUTES);
    expect(install['continue-on-error']).toBeUndefined();

    // The step timeout must leave the five repeats room inside the 30-minute
    // job timeout and must still be shorter than the job itself.
    const jobTimeout = job?.['timeout-minutes'];
    expect(jobTimeout).toBe(30);
    expect(install['timeout-minutes']).toBeLessThan(jobTimeout ?? 0);

    const installIndex = stepIndex(isPlaywrightInstall);
    expect(stepIndex((step) => (step.run ?? '').trim() === 'npm ci')).toBeLessThan(installIndex);
    expect(installIndex).toBeLessThan(stepIndex((step) => (step.run ?? '').trim() === 'npm run build'));
  });

  it('caches WebKit under a distinct key while restoring the shared cache prefix', () => {
    const cache = requireStep(isPlaywrightCache, 'a Playwright browser cache step');
    expect(cache.uses).toBe('actions/cache@v4');
    expect(cache.with?.path).toBe(PLAYWRIGHT_CACHE_PATH);
    expect(cache.with?.key).toBe(
      "playwright-webkit-${{ runner.os }}-${{ hashFiles('package-lock.json') }}",
    );
    const restoreKeys = String(cache.with?.['restore-keys'] ?? '');
    // Own prefix first, then the shared prefix a cached verify job would write.
    expect(restoreKeys).toContain('playwright-webkit-${{ runner.os }}-');
    expect(restoreKeys).toContain('playwright-${{ runner.os }}-');
    expect(cache['continue-on-error']).toBeUndefined();

    // This job installs only WebKit. Writing that under the shared
    // `playwright-<os>-<lockfile hash>` key would permanently poison the
    // Chromium + WebKit cache if the cached verify job from Issue #202 is
    // restored, so the write key stays WebKit-specific while the shared
    // prefix remains restorable. Issue #213 moved the PR job into the pinned
    // Playwright image, so verify no longer writes that shared entry itself.
    const ciWorkflow = parse(readFileSync(CI_WORKFLOW_PATH, 'utf8')) as Workflow;
    const ciCache = (ciWorkflow.jobs?.verify?.steps ?? []).find(
      (step) =>
        (step.uses ?? '').startsWith('actions/cache@') &&
        (step.with?.path ?? '') === PLAYWRIGHT_CACHE_PATH,
    );
    expect(ciCache, 'the pinned-image verify job must not cache browsers').toBeUndefined();

    const cacheIndex = stepIndex(isPlaywrightCache);
    const installIndex = stepIndex(isPlaywrightInstall);
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(cacheIndex).toBeLessThan(installIndex);
    expect(stepIndex((step) => (step.run ?? '').trim() === 'npm ci')).toBeLessThan(cacheIndex);
  });

  it('configures apt Acquire retries and timeouts before installing WebKit', () => {
    const apt = requireStep(isAptAcquireConfig, 'an apt Acquire config step');
    expect(apt.name).toBe('Configure apt Acquire retries and timeouts');
    expect(apt['continue-on-error']).toBeUndefined();

    const run = apt.run ?? '';
    expect(run).toContain('sudo');
    expect(run).toContain(APT_ACQUIRE_CONFIG_PATH);
    expect(run).toMatch(/Acquire::Retries\s+"1";/);
    expect(run).toMatch(/Acquire::http::Timeout\s+"15";/);
    expect(run).toMatch(/Acquire::https::Timeout\s+"15";/);

    const aptIndex = stepIndex(isAptAcquireConfig);
    const installIndex = stepIndex(isPlaywrightInstall);
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(aptIndex).toBeLessThan(installIndex);
    expect(stepIndex((step) => (step.run ?? '').trim() === 'npm ci')).toBeLessThan(aptIndex);
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
