import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { deriveReproPlans } from '../../scripts/lib/screenshot-repro.mjs';
import {
  DEFAULT_MANIFEST_PATH,
  parseSha256Manifest,
} from '../../scripts/lib/screenshot-sha256.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'capture-repro.yml');
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, 'utf8');
const PACKAGE_PATH = join(ROOT, 'package.json');
const SCREENSHOTS_README_PATH = join(ROOT, 'docs', 'screenshots', 'README.md');
const README_PATH = join(ROOT, 'README.md');
const MANIFEST_PATH = join(ROOT, DEFAULT_MANIFEST_PATH);

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  'runs-on'?: string;
  'timeout-minutes'?: number;
  container?: unknown;
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
}

const workflow = parse(WORKFLOW_SOURCE) as Workflow;
const job = workflow.jobs?.repro;
const steps = job?.steps ?? [];
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
    throw new Error(`the repro job is missing ${description}`);
  }
  return step;
}

describe('capture-repro workflow', () => {
  it('only runs on a daily schedule or manual dispatch', () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.on?.push).toBeUndefined();
    expect(workflow.on?.pull_request).toBeUndefined();

    const schedule = workflow.on?.schedule as Array<{ cron?: string }> | undefined;
    expect(schedule).toHaveLength(1);
    expect(schedule?.[0]?.cron).toBe('41 4 * * *');

    // The two-run check is deliberately off the PR critical path.
    expect(WORKFLOW_SOURCE).not.toMatch(/^\s{0,2}(?:push|pull_request):/m);
  });

  it('grants read-only repository contents permission', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('runs on an ordinary ubuntu runner without a job-level container', () => {
    expect(job).toBeDefined();
    expect(job?.['runs-on']).toBe('ubuntu-latest');
    // The fixed Playwright container is started by the capture entry, so a
    // job-level `container:` would shadow the environment under test.
    expect(job?.container).toBeUndefined();
  });

  it('keeps a bounded timeout for six container captures', () => {
    expect(job?.['timeout-minutes']).toBe(60);
  });

  it('installs dependencies and runs the reusable repro entry', () => {
    const checkout = steps[0];
    expect(checkout?.uses).toMatch(/^actions\/checkout@/);

    const setupNode = steps[1];
    expect(setupNode?.uses).toMatch(/^actions\/setup-node@/);
    expect(setupNode?.with?.['node-version']).toBe(24);
    expect(setupNode?.with?.cache).toBe('npm');

    const commands = steps.map((step) => (step.run ?? '').trim());
    const installIndex = commands.indexOf('npm ci');
    const reproIndex = commands.indexOf('npm run verify:screenshots:repro');

    expect(scripts['verify:screenshots:repro']).toBe(
      'node scripts/verify-screenshot-repro.mjs',
    );
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(reproIndex).toBeGreaterThan(installIndex);
    expect(requireStep((step) => step.run === 'npm run verify:screenshots:repro', 'the repro entry'))
      .toBeDefined();
  });

  it('derives targets from the manifest instead of hardcoding them', () => {
    // A target list in the workflow would let the nightly job miss newly
    // manifested evidence; scripts/lib/screenshot-repro.mjs derives the
    // unique commands from docs/screenshots/capture-sha256-manifest.json.
    expect(WORKFLOW_SOURCE).not.toMatch(/screenshots:(?:webkit|2048|breakout|snake|minesweeper)\b/);
    expect(WORKFLOW_SOURCE).not.toMatch(/screenshots:container\s+--\s+screenshots/);
    expect(DEFAULT_MANIFEST_PATH).toBe('docs/screenshots/capture-sha256-manifest.json');
  });

  it('pins the manifest source and the two-run order in the repro library', () => {
    const manifest = parseSha256Manifest(readFileSync(MANIFEST_PATH, 'utf8'));
    const plans = deriveReproPlans(manifest);

    const expectedTargets = [
      ...new Set(
        manifest.captures.map((capture) => {
          const match = /^npm run screenshots:container -- (\S+)$/.exec(capture.command);
          if (!match?.[1]) {
            throw new Error(`unexpected manifest command: ${capture.command}`);
          }
          return match[1];
        }),
      ),
    ];
    expect(plans.map((plan) => plan.target)).toEqual(expectedTargets);
    expect(plans.flatMap((plan) => plan.captures)).toHaveLength(manifest.captures.length);
    expect(plans.every((plan) => plan.captures.length > 0)).toBe(true);
  });

  it('never commits, restores or rewrites the manifest', () => {
    const commands = steps.map((step) => (step.run ?? '').trim());
    for (const command of commands) {
      expect(command).not.toMatch(/\bgit\s+(?:commit|add|checkout|restore)\b/);
      expect(command).not.toMatch(/\bcapture-sha256-manifest\.json\b.*>/);
    }

    const manifestCheck = requireStep(
      (step) => (step.run ?? '').trim() === 'git diff --exit-code -- docs/screenshots/capture-sha256-manifest.json',
      'a manifest-unchanged assertion',
    );
    // It must run even after a failed repro, so the readonly contract is
    // checked on the failure path too.
    expect(manifestCheck.if).toBe('always()');
  });

  it('uploads both run logs even when the repro fails', () => {
    const upload = requireStep(
      (step) => (step.uses ?? '').startsWith('actions/upload-artifact@'),
      'an artifact upload',
    );
    expect(upload.if).toBe('always()');
    expect(upload.with?.path).toContain('test-results/screenshot-repro/');
    expect(upload.with?.path).toContain('test-results/capture-container/');
  });
});

/** The text of one level-2 section, up to the next level-2 heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw new Error(`missing section: ${heading}`);
  }
  const end = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

describe('nightly screenshot repro docs (Issue #199)', () => {
  const screenshotsReadme = readFileSync(SCREENSHOTS_README_PATH, 'utf8');
  const reproDocs = section(
    screenshotsReadme,
    '## 夜间固定容器两跑复现与排障（Issue #199）',
  );
  const readme = readFileSync(README_PATH, 'utf8');

  it('documents the scheduled / manual workflow and the reusable entry', () => {
    expect(reproDocs).toContain('.github/workflows/capture-repro.yml');
    expect(reproDocs).toContain('schedule');
    expect(reproDocs).toContain('workflow_dispatch');
    expect(reproDocs).toContain('npm run verify:screenshots:repro');
    expect(reproDocs).toContain('npm run screenshots:container -- <target>');
  });

  it('documents the manifest-driven two-run contract and both logs', () => {
    expect(reproDocs).toContain('docs/screenshots/capture-sha256-manifest.json');
    expect(reproDocs).toContain('command');
    expect(reproDocs).toContain('连续两跑');
    expect(reproDocs).toContain('test-results/screenshot-repro/');
    expect(reproDocs).toContain('test-results/capture-container/');
    expect(reproDocs).toContain('verify:screenshots:sha256');
  });

  it('documents the failure summary, troubleshooting and re-capture steps', () => {
    expect(reproDocs).toContain('GITHUB_STEP_SUMMARY');
    expect(reproDocs).toContain('期望');
    expect(reproDocs).toContain('实际 sha256');
    expect(reproDocs).toContain('环境指纹');
    expect(reproDocs).toContain('排障');
    expect(reproDocs).toContain('重拍');
    expect(reproDocs).toContain('只读');
    expect(reproDocs).not.toMatch(/工作流.*(?:自动)?(?:修改|更新|提交).*清单/);
  });

  it('links the nightly flow from the main README', () => {
    expect(readme).toContain('capture-repro.yml');
    expect(readme).toContain('夜间固定容器两跑复现与排障');
  });
});
