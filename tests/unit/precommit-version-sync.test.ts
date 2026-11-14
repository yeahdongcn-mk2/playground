import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The local installation guide, the pre-commit config and CI must all agree on
// one pinned pre-commit version. If any of them drifts, these tests fail.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README_PATH = join(ROOT, 'README.md');
const CONFIG_PATH = join(ROOT, '.pre-commit-config.yaml');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');

const readme = readFileSync(README_PATH, 'utf8');
const config = readFileSync(CONFIG_PATH, 'utf8');

interface WorkflowStep {
  run?: string;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const workflow = parse(readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow;
const verifyRunCommands = (workflow.jobs?.verify?.steps ?? []).flatMap((step) =>
  (step.run ?? '')
    .split('\n')
    .map((command) => command.trim())
    .filter((command) => command.length > 0),
);
// CI installs pre-commit inside the Playwright container as
// `/usr/bin/python3 -m pip install ...` after bootstrapping pip with
// get-pip.py (see docs/ci-flaky-policy.md). The matcher intentionally also
// accepts the local bare `pip` / `pipx` forms documented in README.md and
// .pre-commit-config.yaml.
const ciInstallCommands = verifyRunCommands.filter(
  (command) => /\bpipx?\s+install\b/.test(command) && /\bpre-commit\b/.test(command),
);

const PINNED_VERSION = /pre-commit==(\d+\.\d+\.\d+)/g;
const EXACT_PIN = /pre-commit==\d+\.\d+\.\d+/;
const INSTALL_COMMAND = /(?:pip|pipx)\s+install\b/;

/** Every exact `x.y.z` pre-commit pin in a text, in source order. */
function pinnedVersions(text: string): string[] {
  return [...text.matchAll(PINNED_VERSION)].map((match) => match[1] ?? '');
}

/**
 * Install command lines that mention pre-commit without pinning an exact
 * version, such as `pip install pre-commit` or `pipx install --upgrade
 * pre-commit`. Such a line would let the local guide drift from CI.
 */
function unpinnedInstallLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => INSTALL_COMMAND.test(line) && /\bpre-commit\b/.test(line))
    .filter((line) => !EXACT_PIN.test(line));
}

/** Distinct versions pinned by CI's pre-commit install steps. */
const ciVersions = [...new Set(ciInstallCommands.flatMap(pinnedVersions))];
const ciVersion = ciVersions.length === 1 ? (ciVersions[0] ?? '') : '';

describe('pre-commit version synced across README, config and CI', () => {
  it('pins CI to an exact x.y.z pre-commit version', () => {
    expect(ciVersions).toHaveLength(1);
    expect(ciVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ciInstallCommands.some((command) => EXACT_PIN.test(command))).toBe(true);
    expect(unpinnedInstallLines(ciInstallCommands.join('\n'))).toEqual([]);
  });

  it('pins both local install variants in .pre-commit-config.yaml to the CI version', () => {
    expect(config).toMatch(/pip install pre-commit==\d+\.\d+\.\d+/);
    expect(config).toMatch(/pipx install pre-commit==\d+\.\d+\.\d+/);

    const versions = pinnedVersions(config);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(new Set(versions)).toEqual(new Set([ciVersion]));
    expect(unpinnedInstallLines(config)).toEqual([]);
  });

  it('ties the README local setup guide to the CI version', () => {
    const versions = pinnedVersions(readme);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(new Set(versions)).toEqual(new Set([ciVersion]));
    expect(unpinnedInstallLines(readme)).toEqual([]);

    expect(readme).toContain(`pip install pre-commit==${ciVersion}`);
    expect(readme).toContain('pre-commit install');
    expect(readme).toContain('pre-commit run --all-files');
  });

  it('documents that bumping the version must update the CI install command and cache key', () => {
    expect(readme).toContain('升级');
    expect(readme).toContain('.github/workflows/ci.yml');
    expect(readme).toContain('缓存键');
  });
});
