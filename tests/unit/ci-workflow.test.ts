import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
  imageTagForPlaywrightVersion,
  readPlaywrightVersion,
} from '../../scripts/lib/capture-env.mjs';
import { WEBKIT_SCREENSHOT_ARTIFACTS } from '../../scripts/lib/screenshot-artifacts.mjs';
import type { ScreenshotArtifact } from '../../scripts/lib/screenshot-artifacts.mjs';
import { DEFAULT_E2E_REPORT_PATH } from '../../scripts/lib/e2e-flakes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');
const FLAKE_WATCH_WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'flake-watch.yml');
const INSTALL_WRAPPER_PATH = join(ROOT, 'scripts', 'install-playwright-ci.mjs');
const NARROW_MANIFEST_PATH = join(ROOT, 'docs', 'screenshots', 'ci-webkit-narrow-manifest.json');
const NARROW_MANIFEST = 'docs/screenshots/ci-webkit-narrow-manifest.json';
const NARROW_CAPTURE_COMMAND = 'npm run screenshots:minesweeper:webkit-narrow';
const NARROW_ARTIFACT_GLOB = 'docs/screenshots/after-minesweeper-webkit-narrow-*.png';
const VERIFY_CLI = 'node scripts/verify-screenshot-artifacts.mjs';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
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
  jobs?: Record<string, WorkflowJob>;
}

const workflow = parse(readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow;
const verify = workflow.jobs?.verify;
const steps = verify?.steps ?? [];
const narrowManifest = JSON.parse(
  readFileSync(NARROW_MANIFEST_PATH, 'utf8'),
) as ScreenshotArtifact[];

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
const PRE_COMMIT_INSTALL_PATTERN =
  /(?:^|\s)(?:pip|pipx|uv)(?:\s+tool)?\s+install(?:\s+--?[^\s]+)*\s+pre-commit(?:[=~><][^\s]*)?(?=\s|$)/;
const PRE_COMMIT_PIN_PATTERN =
  /(?:^|\s)(?:pip|pipx|uv)(?:\s+tool)?\s+install(?:\s+--?[^\s]+)*\s+pre-commit==(\d+\.\d+\.\d+)(?=\s|$)/;
const isPreCommitInstall = (step: WorkflowStep): boolean =>
  PRE_COMMIT_INSTALL_PATTERN.test(step.run ?? '');
/** pip's official bootstrap script; required because the image has no pip. */
const PIP_BOOTSTRAP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const isPipBootstrap = (command: string): boolean => command.includes(PIP_BOOTSTRAP_URL);
/** `python3 -m pip install` against the image's own interpreter. */
const IMAGE_PIP_INSTALL_PATTERN = /(?:^|\s)\/usr\/bin\/python3\s+-m\s+pip\s+install\b/;
const usesImagePip = (command: string): boolean => IMAGE_PIP_INSTALL_PATTERN.test(command);

/** Exact `x.y.z` version pinned by a pre-commit install command, if any. */
function pinnedPreCommitVersion(command: string): string | null {
  const match = PRE_COMMIT_PIN_PATTERN.exec(command);
  return match?.[1] ?? null;
}
const isPreCommitRun = (step: WorkflowStep): boolean =>
  commandsOf(step).some((command) => /^pre-commit run --all-files(?:\s|$)/.test(command));
const isTypecheck = (step: WorkflowStep): boolean => (step.run ?? '').trim() === 'npm run typecheck';
const PLAYWRIGHT_INSTALL_COMMAND = 'node scripts/install-playwright-ci.mjs';
const PLAYWRIGHT_INSTALL_TIMEOUT_MINUTES = 8;
const PLAYWRIGHT_CACHE_PATH = '~/.cache/ms-playwright';
const APT_ACQUIRE_CONFIG_PATH = '/etc/apt/apt.conf.d/99-ci-acquire';
const isPlaywrightInstall = (step: WorkflowStep): boolean =>
  (step.run ?? '').trim() === PLAYWRIGHT_INSTALL_COMMAND;
const isPlaywrightCache = (step: WorkflowStep): boolean =>
  (step.with?.path ?? '').trim() === PLAYWRIGHT_CACHE_PATH;
const isPreCommitCache = (step: WorkflowStep): boolean =>
  (step.uses ?? '').startsWith('actions/cache@') &&
  (step.with?.path ?? '').includes('~/.cache/pre-commit');
const isAptAcquireConfig = (step: WorkflowStep): boolean =>
  (step.run ?? '').includes(APT_ACQUIRE_CONFIG_PATH);
const isE2e = (step: WorkflowStep): boolean => (step.run ?? '').trim() === 'npm run test:e2e';
const SCREENSHOT_DOC_DIMS_COMMAND = 'npm run verify:screenshots:doc-dims';
/** Unit-test report reused by the doc count check instead of rerunning the suite. */
const UNIT_TEST_REPORT = '"$RUNNER_TEMP/vitest-report.json"';
const UNIT_TEST_COMMAND = `npm run test:unit -- --reporter=default --reporter=json --outputFile=${UNIT_TEST_REPORT}`;
const DOC_COUNTS_COMMAND = `npm run verify:doc-counts -- --report ${UNIT_TEST_REPORT}`;
const isUnitTests = (step: WorkflowStep): boolean =>
  (step.run ?? '').trim() === UNIT_TEST_COMMAND;
const isBuild = (step: WorkflowStep): boolean => (step.run ?? '').trim() === 'npm run build';
const isScreenshotDocDims = (step: WorkflowStep): boolean =>
  (step.run ?? '').trim() === SCREENSHOT_DOC_DIMS_COMMAND;
const isDocCounts = (step: WorkflowStep): boolean =>
  (step.run ?? '').trim() === DOC_COUNTS_COMMAND;
const isWebkitScreenshotSmoke = (step: WorkflowStep): boolean =>
  commandsOf(step).some((command) => command.includes(NARROW_CAPTURE_COMMAND));
const E2E_FLAKE_CHECK_COMMAND = 'node scripts/check-e2e-flakes.mjs';
const isE2eFlakeCheck = (step: WorkflowStep): boolean =>
  (step.run ?? '').trim() === E2E_FLAKE_CHECK_COMMAND;

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
      'npm run typecheck',
      'npm run lint',
      UNIT_TEST_COMMAND,
      DOC_COUNTS_COMMAND,
      'npm run verify:screenshots:doc-dims',
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

  it('runs the verify job in the pinned official Playwright image', () => {
    const container = verify?.container;
    const image = typeof container === 'string' ? container : container?.image;
    expect(image, 'verify should declare a job-level container image').toBeDefined();

    // `npm ci` installs the @playwright/test version recorded in the lockfile,
    // so PLAYWRIGHT_IMAGE_PIN must cover that exact version. The tag is derived
    // from the version and the digest pins the multi-arch image.
    expect(PLAYWRIGHT_IMAGE_PIN.version).toBe(readPlaywrightVersion());
    expect(PLAYWRIGHT_IMAGE_PIN.tag).toBe(
      imageTagForPlaywrightVersion(PLAYWRIGHT_IMAGE_PIN.version),
    );
    expect(PLAYWRIGHT_IMAGE_PIN.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const expectedImage = `${PLAYWRIGHT_IMAGE_REPOSITORY}:${PLAYWRIGHT_IMAGE_PIN.tag}@${PLAYWRIGHT_IMAGE_PIN.digest}`;
    expect(image).toBe(expectedImage);

    // The image replaces the runtime install only: the branch-protection check
    // name (`verify`) and its budget must not change.
    expect(Object.keys(workflow.jobs ?? {})).toContain('verify');
    expect(verify?.['runs-on']).toBe('ubuntu-latest');
    expect(verify?.['timeout-minutes']).toBe(20);
  });

  it('gives the verify container the host IPC namespace', () => {
    // GitHub's container jobs default to a 64 MB /dev/shm; Chromium's own
    // Docker guidance recommends host IPC to avoid shared-memory crashes.
    // scripts/run-container-capture.mjs uses the same option for its captures.
    const container = verify?.container;
    expect(container, 'verify should declare container options').toBeTypeOf('object');
    expect(container).not.toBeNull();
    const options =
      typeof container === 'object' && container !== null ? (container.options ?? '') : '';
    // Match the token so another legitimate docker option can be added
    // without breaking the IPC contract.
    expect(options.split(/\s+/)).toContain('--ipc=host');
  });

  it('does not install browsers, cache ~/.cache/ms-playwright or configure apt at runtime', () => {
    expect(stepIndex(isPlaywrightInstall)).toBe(-1);
    expect(stepIndex(isPlaywrightCache)).toBe(-1);
    expect(stepIndex(isAptAcquireConfig)).toBe(-1);
    expect(
      steps.some(
        (step) =>
          (step.uses ?? '').startsWith('actions/cache@') &&
          (step.with?.path ?? '').includes('ms-playwright'),
      ),
      'the image already contains the browsers, so verify must not cache them',
    ).toBe(false);

    for (const command of steps.flatMap(commandsOf)) {
      // A browser install would reintroduce the Issue #202 failure mode and
      // ignore the image pin; apt is part of that install path.
      expect(command).not.toMatch(/\bplaywright\s+install\b/);
      expect(command).not.toContain('--with-deps');
      expect(command).not.toMatch(/\bapt(?:-get)?\s+(?:update|install|get)\b/i);
      expect(command).not.toContain('/etc/apt/');
    }
  });

  it('keeps the bounded install wrapper as the flake-watch fallback', () => {
    // Issue #213 keeps the #202 wrapper so the image change can be rolled back;
    // the scheduled WebKit watch still depends on it.
    expect(existsSync(INSTALL_WRAPPER_PATH)).toBe(true);

    const flakeWatch = parse(readFileSync(FLAKE_WATCH_WORKFLOW_PATH, 'utf8')) as Workflow;
    const watchSteps = flakeWatch.jobs?.['mobile-webkit-first-run']?.steps ?? [];
    const install = watchSteps.find(
      (step) => (step.run ?? '').trim() === 'node scripts/install-playwright-ci.mjs webkit',
    );
    expect(install, 'flake-watch should keep using the bounded install wrapper').toBeDefined();
    expect(install?.['timeout-minutes']).toBe(PLAYWRIGHT_INSTALL_TIMEOUT_MINUTES);
    expect(install?.['continue-on-error']).toBeUndefined();
  });

  it('runs the screenshot doc dimension check between the unit tests and the build', () => {
    const step = requireStep(isScreenshotDocDims, 'a screenshot doc dimensions step');
    expect(step.name).toBe('Screenshot doc dimensions');
    expect((step.run ?? '').trim()).toBe(SCREENSHOT_DOC_DIMS_COMMAND);
    expect(step['continue-on-error']).toBeUndefined();

    const unitTestsIndex = stepIndex(isUnitTests);
    const buildIndex = stepIndex(isBuild);
    expect(unitTestsIndex, 'verify job should still run "npm run test:unit"').toBeGreaterThanOrEqual(
      0,
    );
    expect(buildIndex, 'verify job should still run "npm run build"').toBeGreaterThanOrEqual(0);
    expect(stepIndex(isScreenshotDocDims)).toBeGreaterThan(unitTestsIndex);
    expect(stepIndex(isScreenshotDocDims)).toBeLessThan(buildIndex);

    // The doc-dims check only reads committed files, so keeping the existing
    // 20-minute budget is safe; a regression in that budget should fail here.
    expect(verify?.['timeout-minutes']).toBe(20);
  });

  it('runs the doc test count check after the unit tests and before the build', () => {
    const step = requireStep(isDocCounts, 'a doc test count check step');
    expect(step.name).toBe('Verify doc test counts');
    expect((step.run ?? '').trim()).toBe(DOC_COUNTS_COMMAND);
    expect(step['continue-on-error']).toBeUndefined();

    const unitTests = requireStep(isUnitTests, 'a unit tests step');
    const unitCommand = (unitTests.run ?? '').trim();
    expect(unitCommand).toBe(UNIT_TEST_COMMAND);
    // Keep the default reporter so a unit-test failure still shows its output,
    // and write the JSON report the count check reuses.
    expect(unitCommand).toContain('--reporter=default');
    expect(unitCommand).toContain(`--outputFile=${UNIT_TEST_REPORT}`);

    // Reusing the report keeps the count check from running the whole suite again.
    expect((step.run ?? '').trim()).toContain(`--report ${UNIT_TEST_REPORT}`);
    expect((step.run ?? '').trim()).not.toContain('test:unit');

    const unitTestsIndex = stepIndex(isUnitTests);
    const buildIndex = stepIndex(isBuild);
    const checkIndex = stepIndex(isDocCounts);
    expect(unitTestsIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(checkIndex).toBeGreaterThan(unitTestsIndex);
    expect(checkIndex).toBeLessThan(buildIndex);

    expect(verify?.['timeout-minutes']).toBe(20);
  });

  it('runs the WebKit narrow screenshot smoke test after the e2e tests', () => {
    const smoke = requireStep(isWebkitScreenshotSmoke, 'a WebKit narrow screenshot smoke step');
    const commands = commandsOf(smoke);

    const rmIndex = commands.indexOf(`rm -f ${NARROW_ARTIFACT_GLOB}`);
    const captureIndex = commands.findIndex((command) => command.includes(NARROW_CAPTURE_COMMAND));
    const verifyIndex = commands.findIndex((command) => command.startsWith(VERIFY_CLI));

    expect(commands).toContain('set -euo pipefail');
    expect(
      rmIndex,
      `the step should delete the regenerated ${NARROW_ARTIFACT_GLOB} files first`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      captureIndex,
      `the step should run "${NARROW_CAPTURE_COMMAND}"`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      verifyIndex,
      'the step should verify the regenerated artifacts with the screenshot validator',
    ).toBeGreaterThanOrEqual(0);

    expect(rmIndex).toBeLessThan(captureIndex);
    expect(captureIndex).toBeLessThan(verifyIndex);
    // `tee` keeps the capture log for the validator, so its pipe must not hide
    // a non-zero capture exit; `set -o pipefail` is asserted above.
    expect(commands[captureIndex]).toContain('2>&1 | tee');
    expect(commands[verifyIndex]).toContain(`--manifest ${NARROW_MANIFEST}`);
    expect(commands[verifyIndex]).toContain('--log');

    const e2eIndex = stepIndex(isE2e);
    expect(e2eIndex, 'verify job should still run "npm run test:e2e"').toBeGreaterThanOrEqual(0);
    expect(stepIndex(isWebkitScreenshotSmoke)).toBeGreaterThan(e2eIndex);
    expect(verify?.['timeout-minutes']).toBe(20);
    expect(smoke['continue-on-error']).toBeUndefined();
  });

  it('runs the target e2e flake gate after the e2e tests without continue-on-error', () => {
    const check = requireStep(isE2eFlakeCheck, 'a target e2e flake check step');
    expect(check.name).toBe('Check target e2e flakes');
    expect((check.run ?? '').trim()).toBe(E2E_FLAKE_CHECK_COMMAND);
    expect(check['continue-on-error']).toBeUndefined();

    const e2e = requireStep(isE2e, 'an "npm run test:e2e" step');
    expect(e2e.env?.CI).toBe('true');

    const e2eIndex = stepIndex(isE2e);
    const checkIndex = stepIndex(isE2eFlakeCheck);
    const smokeIndex = stepIndex(isWebkitScreenshotSmoke);
    expect(e2eIndex).toBeGreaterThanOrEqual(0);
    expect(smokeIndex).toBeGreaterThanOrEqual(0);
    expect(checkIndex).toBeGreaterThan(e2eIndex);
    expect(checkIndex).toBeLessThan(smokeIndex);
  });

  it('writes the Playwright JSON report the flake gate reads when running in CI', async () => {
    const previousCi = process.env.CI;
    process.env.CI = 'true';
    try {
      const { default: config } = await import('../../playwright.config');
      expect(config.reporter).toContainEqual([
        'json',
        { outputFile: DEFAULT_E2E_REPORT_PATH },
      ]);
    } finally {
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }
    }
  });

  it('keeps the CI narrow screenshot manifest aligned with the WebKit artifact list', () => {
    expect(narrowManifest).toHaveLength(4);
    expect(narrowManifest).toEqual(
      WEBKIT_SCREENSHOT_ARTIFACTS.filter(
        (artifact) => artifact.narrow === true && artifact.file.startsWith('after-'),
      ),
    );
  });

  it('installs pre-commit after npm ci without a setup-python step', () => {
    const install = requireStep(isPreCommitInstall, 'a pre-commit install step');

    // The setup-python toolcache CPython cannot load its ssl module inside the
    // container (run 43560696477), so it cannot install packages from PyPI.
    expect(steps.some(isSetupPython), 'verify should not rely on actions/setup-python').toBe(false);
    // An installation command such as `pip install pre-commit==4.7.0`,
    // `pip install --upgrade pre-commit`, `pipx install pre-commit` or
    // `uv tool install pre-commit`.
    expect(
      commandsOf(install).some((command) => PRE_COMMIT_INSTALL_PATTERN.test(command)),
    ).toBe(true);

    const npmCiIndex = stepIndex(isNpmCi);
    expect(npmCiIndex).toBeGreaterThanOrEqual(0);
    expect(npmCiIndex).toBeLessThan(stepIndex(isPreCommitInstall));
  });

  it('bootstraps pip for the image interpreter before installing pre-commit', () => {
    const install = requireStep(isPreCommitInstall, 'a pre-commit install step');
    const commands = commandsOf(install);
    const bootstrapIndex = commands.findIndex(isPipBootstrap);
    const pipInstallIndex = commands.findIndex(
      (command) => usesImagePip(command) && pinnedPreCommitVersion(command) !== null,
    );

    // run 43558572972 failed on a bare `pip: not found`; the image's
    // /usr/bin/python3 has neither pip nor ensurepip, so pip must be
    // bootstrapped for that interpreter before the pinned install.
    expect(bootstrapIndex, 'the install step should fetch get-pip.py').toBeGreaterThanOrEqual(0);
    expect(commands[bootstrapIndex + 1]).toContain('get-pip.py');
    expect(commands[bootstrapIndex + 1]).toContain('--break-system-packages');
    expect(
      pipInstallIndex,
      'the install step should run `/usr/bin/python3 -m pip install`',
    ).toBeGreaterThan(bootstrapIndex);
    expect(commands[pipInstallIndex]).toContain('--break-system-packages');
    expect(commands[pipInstallIndex]).toContain('pre-commit==4.7.0');
    // The interpreter check runs after the install, so a missing console
    // script fails with a clear error instead of a later command-not-found.
    expect(commands.indexOf('pre-commit --version')).toBeGreaterThan(pipInstallIndex);
    expect(
      commands.some((candidate) => /^\s*pip\s+install\s/.test(candidate)),
      'installing with a bare `pip` would fail inside the pinned image again',
    ).toBe(false);
    expect(
      commands.some((candidate) => candidate.includes('"$pythonLocation/bin/python"')),
      'the setup-python toolcache interpreter has no usable ssl module in the container',
    ).toBe(false);
  });

  it('pins one exact pre-commit version and ties the cache key to it', () => {
    const install = requireStep(isPreCommitInstall, 'a pre-commit install step');
    const installCommand = commandsOf(install).find(
      (command) => pinnedPreCommitVersion(command) !== null,
    );
    expect(
      installCommand,
      'the pre-commit install step should pin an exact x.y.z version',
    ).toBeDefined();

    const version = pinnedPreCommitVersion(installCommand ?? '');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);

    const cache = steps.find(isPreCommitCache);
    expect(cache, 'verify job should cache pre-commit environments with actions/cache').toBeDefined();
    const cacheKeyPrefix = 'pre-commit-${{ runner.os }}-';
    expect(cache?.with?.key).toContain(`${cacheKeyPrefix}${version}-`);
    expect(cache?.with?.key).toContain("hashFiles('.pre-commit-config.yaml')");
    expect(cache?.with?.['restore-keys']).toContain(`${cacheKeyPrefix}${version}-`);
  });

  it('recognises pinned and unpinned pre-commit install commands', () => {
    expect(pinnedPreCommitVersion('pip install pre-commit==4.7.0')).toBe('4.7.0');
    expect(pinnedPreCommitVersion('pip install --upgrade pre-commit==4.7.0')).toBe('4.7.0');
    expect(pinnedPreCommitVersion('pip install pre-commit')).toBeNull();
    expect(pinnedPreCommitVersion('pip install --upgrade pre-commit')).toBeNull();

    for (const command of [
      'pip install pre-commit',
      'pip install --upgrade pre-commit',
      'pipx install pre-commit',
      'uv tool install pre-commit',
      'pip install pre-commit==4.7.0',
      '/usr/bin/python3 -m pip install --break-system-packages pre-commit==4.7.0',
    ]) {
      expect(isPreCommitInstall({ run: command }), command).toBe(true);
    }
    expect(
      pinnedPreCommitVersion(
        '/usr/bin/python3 -m pip install --break-system-packages pre-commit==4.7.0',
      ),
    ).toBe('4.7.0');
  });

  it('caches the pre-commit environments to keep the job fast', () => {
    const cache = steps.find(isPreCommitCache);
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
