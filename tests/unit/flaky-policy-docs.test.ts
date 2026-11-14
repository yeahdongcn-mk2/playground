import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { resolveCaptureImage } from '../../scripts/lib/capture-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const POLICY_PATH = 'docs/ci-flaky-policy.md';
const POLICY = read(POLICY_PATH);
const README = read('README.md');
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
const FLAKE_WATCH_WORKFLOW_PATH = '.github/workflows/flake-watch.yml';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  with?: Record<string, string>;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
}

interface WorkflowJob {
  'timeout-minutes'?: number;
  container?: string | { image?: string; options?: string };
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

const ci = parse(read(CI_WORKFLOW_PATH)) as Workflow;
const verifySteps = ci.jobs?.verify?.steps ?? [];
const flakeWatch = parse(read(FLAKE_WATCH_WORKFLOW_PATH)) as Workflow;
const watchSteps = flakeWatch.jobs?.['mobile-webkit-first-run']?.steps ?? [];

function stepNamed(steps: WorkflowStep[], name: string): WorkflowStep | undefined {
  return steps.find((step) => step.name === name);
}

function requireStep(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = stepNamed(steps, name);
  if (step === undefined) {
    throw new Error(`the workflow is missing the "${name}" step`);
  }
  return step;
}

/** One numbered `## <n>. <title>` section of the policy document. */
function policySection(title: string): string {
  const heading = new RegExp(`^## \\d+\\. ${title}$`, 'm').exec(POLICY);
  if (heading?.index === undefined) return '';

  const afterHeading = heading.index + heading[0].length;
  const next = POLICY.slice(afterHeading).search(/^## \d+\. /m);
  const end = next === -1 ? POLICY.length : afterHeading + next;
  return POLICY.slice(heading.index, end);
}

describe('flaky policy docs', () => {
  it('is linked from the README verification section', () => {
    const start = README.indexOf('## 验证');
    const end = README.indexOf('## 已知限制', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const verification = README.slice(start, end);
    expect(verification).toMatch(/\[[^\]]+\]\(docs\/ci-flaky-policy\.md\)/);
    expect(existsSync(join(ROOT, POLICY_PATH))).toBe(true);
    expect(POLICY.length).toBeGreaterThan(500);
  });

  it('defines passed, flaky and failed with first-run semantics', () => {
    expect(POLICY).toMatch(/passed[^\n]*首跑[^\n]*通过/);
    expect(POLICY).toMatch(/flaky[^\n]*首跑失败[^\n]*重试后通过/);
    expect(POLICY).toMatch(/failed[^\n]*重试用尽[^\n]*仍失败/);
    expect(POLICY).toContain('retries: 2');
  });

  it('documents the PR gate step and the target case it protects', () => {
    const e2eIndex = verifySteps.findIndex((step) => step.name === 'End-to-end tests');
    const gateIndex = verifySteps.findIndex((step) => step.name === 'Check target e2e flakes');
    expect(e2eIndex).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThan(e2eIndex);
    expect(verifySteps[gateIndex]?.run?.trim()).toBe('node scripts/check-e2e-flakes.mjs');

    expect(POLICY).toContain('Check target e2e flakes');
    expect(POLICY).toContain('node scripts/check-e2e-flakes.mjs');
    expect(POLICY).toContain('mobile-webkit');
    expect(POLICY).toContain('hub and blank canvas');
  });

  it('keeps other cases on retries: 2 and only records them as flaky', () => {
    expect(POLICY).toMatch(/其他项目与其他用例[^\n]*retries: 2[^\n]*只记录为 flaky/);
    expect(POLICY).toContain('不会让 `Check target e2e flakes` 失败');
  });

  it('documents the daily flake-watch command off the PR path', () => {
    expect(POLICY).toContain('.github/workflows/flake-watch.yml');
    expect(POLICY).toContain('Flake watch');
    expect(POLICY).toContain('--repeat-each=5 --retries=0');
    expect(POLICY).toMatch(/不在 PR 关键路径/);

    expect(Object.keys(flakeWatch.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);

    const repeated = stepNamed(watchSteps, 'Repeat the mobile-webkit hub case five times');
    expect(repeated).toBeDefined();
    expect(repeated?.run).toContain('--project=mobile-webkit');
    expect(repeated?.run).toContain('-g "hub and blank canvas"');
    expect(repeated?.run).toContain('--repeat-each=5');
    expect(repeated?.run).toContain('--retries=0');
  });

  it('documents the CI duration and the residual false-negative cost', () => {
    expect(POLICY).toContain('CI 时长');
    expect(POLICY).toMatch(/只多一次 JSON 报告解析/);
    expect(POLICY).toMatch(/不拉长/);
    expect(POLICY).toContain('误报成本');
    expect(POLICY).toContain('其他用例的 flaky 仍可能以 success 放行');
  });

  it('documents the pinned image, the fallback install cache and the failure boundary', () => {
    const section = policySection('Playwright 运行环境：固定镜像与有界安装回退');
    expect(section, 'the policy should define the pinned image / fallback section').not.toBe('');

    const pinned = resolveCaptureImage();
    expect(section).toContain(pinned.reference);
    expect(section).toMatch(/playwright install/);
    expect(section).toContain('20 分钟');

    expect(section).toContain('~/.cache/ms-playwright');
    expect(section).toContain('scripts/install-playwright-ci.mjs');
    expect(section).toContain('timeout-minutes: 8');
    expect(section).toContain('最多尝试 2 次');
    expect(section).toContain('180 秒');
    expect(section).toContain('10 秒退避');
    expect(section).toContain('Acquire::Retries "1"');
    expect(section).toContain('Acquire::http::Timeout "15"');
    expect(section).toContain('Acquire::https::Timeout "15"');
    expect(section).toContain('Temporary failure resolving');
    expect(section).toContain('404 Not Found');
    expect(section).toMatch(/非零状态/);
    expect(section).toMatch(/步骤自身的 `timeout-minutes` 内/);
    expect(section).toMatch(/不会耗尽 flake-watch job 的 30 分钟/);
    expect(section).toContain('Issue #202');
    expect(section).toContain('43129697008');
    expect(section).toContain('冷缓存');
    expect(section).toContain('热缓存');
  });

  it('keeps the fallback install section aligned with flake-watch.yml and the install wrapper', () => {
    const section = policySection('Playwright 运行环境：固定镜像与有界安装回退');
    const verify = ci.jobs?.verify;
    const verifyContainer = verify?.container;
    const verifyImage =
      typeof verifyContainer === 'string' ? verifyContainer : verifyContainer?.image;
    const jobTimeout = verify?.['timeout-minutes'];
    const pinned = resolveCaptureImage();

    // The verify job runs in the pinned image and no longer installs browsers.
    expect(verifyImage).toBe(pinned.reference);
    expect(jobTimeout).toBe(20);
    expect(section).toContain(pinned.reference);
    expect(section).toContain(`${jobTimeout} 分钟`);

    // The container needs host IPC for Chromium's shared-memory use, and the
    // pre-commit install must bootstrap pip for the image's Python: both the
    // image's own pip and setup-python's container ssl are unusable
    // (runs 43558572972 / 43560696477).
    const verifyContainerOptions =
      typeof verifyContainer === 'string' ? '' : (verifyContainer?.options ?? '');
    expect(verifyContainerOptions.split(/\s+/)).toContain('--ipc=host');
    expect(section).toContain('--ipc=host');
    const preCommitInstall = requireStep(verifySteps, 'Install pre-commit');
    expect(preCommitInstall.shell).toBe('bash');
    const webkitSmoke = requireStep(verifySteps, 'WebKit narrow screenshot smoke test');
    expect(webkitSmoke.shell).toBe('bash');
    expect(section).toContain('shell: bash');
    expect(section).toContain('safe.directory');
    expect(section).toContain('43561619210');
    expect(section).toContain('pre-commit-container-');
    expect(section).toContain('43563009824');
    expect(section).toContain('attempt 2');
    expect(section).toContain('npm cache is not found');
    expect(section).toContain('Cache not found');
    expect(section).toContain('Cache restored from key: pre-commit-container-');
    expect(section).toContain('End-to-end tests');
    expect(section).toContain('WebKit narrow screenshot smoke test');
    const installCommands = (preCommitInstall.run ?? '')
      .split('\n')
      .map((command) => command.trim())
      .filter((command) => command.length > 0);
    expect(
      installCommands.some((command) => command.includes('bootstrap.pypa.io/get-pip.py')),
    ).toBe(true);
    const pinnedInstall = installCommands.find((command) => command.includes('pre-commit==4.7.0'));
    expect(pinnedInstall).toBeDefined();
    expect(pinnedInstall).toContain('python3 -m pip install');
    expect(pinnedInstall).toContain('--break-system-packages');
    // Assert the stable fragments, not the entire multi-line step, so adding a
    // harmless pip flag does not force the policy doc to copy it verbatim.
    expect(section).toContain('bootstrap.pypa.io/get-pip.py');
    expect(section).toContain('pre-commit==4.7.0');
    expect(section).toContain('--break-system-packages');
    const getPipCommand = installCommands.find(
      (command) =>
        command.includes('"$RUNNER_TEMP/get-pip.py"') &&
        command.includes('--break-system-packages'),
    );
    expect(getPipCommand).toBeDefined();
    expect(pinnedInstall).toContain('--break-system-packages');

    // The bounded install remains the flake-watch fallback.
    const watchTimeout = flakeWatch.jobs?.['mobile-webkit-first-run']?.['timeout-minutes'];
    const cache = requireStep(watchSteps, 'Cache Playwright browsers');
    const apt = requireStep(watchSteps, 'Configure apt Acquire retries and timeouts');
    const install = requireStep(watchSteps, 'Install Playwright WebKit');

    expect(watchTimeout).toBe(30);
    expect(cache.uses).toBe('actions/cache@v4');
    expect(cache.with?.path).toBe('~/.cache/ms-playwright');
    expect(cache.with?.key).toContain("hashFiles('package-lock.json')");
    expect(install.run?.trim()).toBe('node scripts/install-playwright-ci.mjs webkit');
    expect(install['timeout-minutes']).toBe(8);
    expect(install['continue-on-error']).toBeUndefined();
    expect(install['timeout-minutes'] ?? 0).toBeLessThan(watchTimeout ?? 0);

    // The doc repeats the fallback workflow's actual cache path/key, step
    // timeout and job budget, so changing flake-watch.yml without this section
    // fails here.
    expect(section).toContain(cache.with?.path ?? '');
    expect(section).toContain(cache.with?.key ?? '');
    for (const restoreKey of (cache.with?.['restore-keys'] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)) {
      expect(section).toContain(restoreKey);
    }
    expect(section).toContain(`timeout-minutes: ${install['timeout-minutes']}`);
    expect(section).toContain(`${watchTimeout} 分钟`);

    const aptRun = apt.run ?? '';
    const acquire = {
      retries: /Acquire::Retries "(\d+)";/.exec(aptRun)?.[1],
      http: /Acquire::http::Timeout "(\d+)";/.exec(aptRun)?.[1],
      https: /Acquire::https::Timeout "(\d+)";/.exec(aptRun)?.[1],
    };
    expect(acquire).toEqual({ retries: '1', http: '15', https: '15' });
    expect(section).toContain(`Acquire::Retries "${acquire.retries}"`);
    expect(section).toContain(`Acquire::http::Timeout "${acquire.http}"`);
    expect(section).toContain(`Acquire::https::Timeout "${acquire.https}"`);

    // Retry count, per-attempt timeout and backoff come from the wrapper.
    const wrapper = read('scripts/install-playwright-ci.mjs');
    const maxAttempts = /const MAX_ATTEMPTS = (\d+);/.exec(wrapper)?.[1];
    const attemptTimeoutMs = /const DEFAULT_TIMEOUT_MS = ([\d_]+);/.exec(wrapper)?.[1];
    const retryDelayMs = /const DEFAULT_RETRY_DELAY_MS = ([\d_]+);/.exec(wrapper)?.[1];
    expect(maxAttempts).toBe('2');
    expect(attemptTimeoutMs).toBe('180_000');
    expect(retryDelayMs).toBe('10_000');
    expect(section).toContain(`最多尝试 ${maxAttempts} 次`);
    expect(section).toContain(`${Number((attemptTimeoutMs ?? '').replaceAll('_', '')) / 1000} 秒`);
    expect(section).toContain(`${Number((retryDelayMs ?? '').replaceAll('_', '')) / 1000} 秒退避`);
  });

  it('sets triage expectations that do not hide flakiness', () => {
    expect(POLICY).toMatch(/先看[^\n]*flaky[^\n]*首跑错误/);
    expect(POLICY).toMatch(/不要通过放宽断言、跳过用例或加大超时/);
    expect(POLICY).toContain('放宽断言');
    expect(POLICY).toContain('跳过用例');
    expect(POLICY).toContain('加大超时');
  });

  it('references workflow files, steps and scripts that exist in the repository', () => {
    const referenced = [
      CI_WORKFLOW_PATH,
      FLAKE_WATCH_WORKFLOW_PATH,
      'scripts/check-e2e-flakes.mjs',
      'scripts/flake-watch-summary.mjs',
      'scripts/install-playwright-ci.mjs',
    ];
    for (const relativePath of referenced) {
      expect(POLICY).toContain(relativePath);
      expect(existsSync(join(ROOT, relativePath)), relativePath).toBe(true);
    }

    expect(POLICY).toContain('node scripts/flake-watch-summary.mjs');
    const summary = stepNamed(watchSteps, 'Summarize first-run results');
    expect(summary?.run).toContain('node scripts/flake-watch-summary.mjs');
    expect(summary?.run).toContain('$GITHUB_STEP_SUMMARY');
  });
});
