import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  deriveReproPlansFromManifests,
  REPRO_RUN_COUNT,
} from '../../scripts/lib/screenshot-repro.mjs';
import {
  DEFAULT_MANIFEST_DIR,
  DEFAULT_MANIFEST_PATH,
  loadSha256Manifests,
} from '../../scripts/lib/screenshot-sha256.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'capture-repro.yml');
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, 'utf8');
const PACKAGE_PATH = join(ROOT, 'package.json');
const SCREENSHOTS_README_PATH = join(ROOT, 'docs', 'screenshots', 'README.md');
const README_PATH = join(ROOT, 'README.md');
const MANIFEST_DIR = join(ROOT, DEFAULT_MANIFEST_DIR);

/** Every manifest the repro entry discovers: the WebKit one plus target splits. */
const MANIFESTS = loadSha256Manifests({ dir: MANIFEST_DIR });

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

/** English number words the job comment may use, from zero to ninety-nine. */
const NUMBER_WORDS = new Map<string, number>([
  ['zero', 0],
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
  ['thirteen', 13],
  ['fourteen', 14],
  ['fifteen', 15],
  ['sixteen', 16],
  ['seventeen', 17],
  ['eighteen', 18],
  ['nineteen', 19],
  ['twenty', 20],
  ['thirty', 30],
  ['forty', 40],
  ['fifty', 50],
  ['sixty', 60],
  ['seventy', 70],
  ['eighty', 80],
  ['ninety', 90],
]);

/**
 * Read an English number word such as `six`, `Twelve` or `twenty-one`.
 *
 * `yaml.parse` drops comments, so the capture-count contract lives in the job
 * comment text; this parser keeps the assertion symmetric with the words the
 * workflow author writes.
 */
function parseEnglishNumberWord(word: string): number {
  const normalized = word.toLowerCase();
  const direct = NUMBER_WORDS.get(normalized);
  if (direct !== undefined) {
    return direct;
  }
  const parts = normalized.split('-');
  if (parts.length === 2) {
    const tens = NUMBER_WORDS.get(parts[0] ?? '');
    const unit = NUMBER_WORDS.get(parts[1] ?? '');
    if (
      tens !== undefined &&
      tens >= 20 &&
      tens % 10 === 0 &&
      unit !== undefined &&
      unit >= 1 &&
      unit <= 9
    ) {
      return tens + unit;
    }
  }
  throw new Error(`expected an English number word, got ${JSON.stringify(word)}`);
}

/**
 * The comment block immediately above the repro job's `timeout-minutes`.
 *
 * That note states how many captures the 60-minute budget has to cover, so
 * anchoring the assertion to `jobs.repro` keeps it from reading an unrelated
 * job or comment.
 */
function reproJobComment(): string {
  const lines = WORKFLOW_SOURCE.split(/\r?\n/);
  const jobIndex = lines.findIndex((line) => /^ {2}repro:\s*$/.test(line));
  if (jobIndex < 0) {
    throw new Error('the workflow is missing the jobs.repro key');
  }
  const nextJobIndex = lines.findIndex(
    (line, index) => index > jobIndex && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line),
  );
  const jobEnd = nextJobIndex < 0 ? lines.length : nextJobIndex;
  const timeoutIndex = lines.findIndex(
    (line, index) =>
      index > jobIndex && index < jobEnd && /^\s+timeout-minutes:\s*60\s*$/.test(line),
  );
  if (timeoutIndex < 0) {
    throw new Error('the repro job is missing timeout-minutes: 60');
  }
  const comment: string[] = [];
  for (let index = timeoutIndex - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (!/^\s*#/.test(line)) {
      break;
    }
    comment.unshift(line);
  }
  return comment.join('\n');
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

  it('keeps a bounded timeout for twelve container captures', () => {
    expect(job?.['timeout-minutes']).toBe(60);
  });

  it('states the manifest-derived capture count in the job comment', () => {
    const comment = reproJobComment();
    const match =
      /#[ \t]+([A-Za-z]+(?:-[A-Za-z]+)*) captures \(([A-Za-z]+(?:-[A-Za-z]+)*) manifest targets x two runs\)/.exec(
        comment,
      );
    if (match === null) {
      throw new Error(
        'the repro job comment is missing "<N> captures (<M> manifest targets x two runs)"',
      );
    }
    const capturesWord = match[1] ?? '';
    const targetsWord = match[2] ?? '';

    // The repro entry derives its plans from the whole discovered manifest set,
    // so the job note must count those commands, not the single WebKit file.
    const targetCount = deriveReproPlansFromManifests(MANIFESTS).length;

    // Every manifest target is captured once per run, so the job note counts
    // capture invocations (targets x default runs), not manifested PNGs.
    expect(REPRO_RUN_COUNT).toBe(2);
    expect(parseEnglishNumberWord(capturesWord)).toBe(targetCount * REPRO_RUN_COUNT);
    expect(parseEnglishNumberWord(targetsWord)).toBe(targetCount);
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

  it('derives targets from the manifest set instead of hardcoding them', () => {
    // A target list in the workflow would let the nightly job miss newly
    // manifested evidence; scripts/lib/screenshot-repro.mjs derives the
    // unique commands from every discovered capture-sha256-manifest*.json.
    expect(WORKFLOW_SOURCE).not.toMatch(/screenshots:(?:webkit|2048|breakout|snake|minesweeper)\b/);
    expect(WORKFLOW_SOURCE).not.toMatch(/screenshots:container\s+--\s+screenshots/);
    expect(DEFAULT_MANIFEST_PATH).toBe('docs/screenshots/capture-sha256-manifest.json');
    expect(MANIFESTS.length).toBeGreaterThanOrEqual(1);
  });

  it('aggregates the pinning contract across every discovered manifest', () => {
    const plans = deriveReproPlansFromManifests(MANIFESTS);
    const manifestPaths = new Set(MANIFESTS.map(({ path }) => path));

    const expectedTargets = [
      ...new Set(
        MANIFESTS.flatMap(({ manifest }) =>
          manifest.captures.map((capture) => {
            const match = /^npm run screenshots:container -- (\S+)$/.exec(
              capture.command,
            );
            if (!match?.[1]) {
              throw new Error(`unexpected manifest command: ${capture.command}`);
            }
            return match[1];
          }),
        ),
      ),
    ];
    expect(plans.map((plan) => plan.target)).toEqual(expectedTargets);
    const captures = plans.flatMap((plan) => plan.captures);
    expect(captures).toHaveLength(
      MANIFESTS.reduce((total, { manifest }) => total + manifest.captures.length, 0),
    );
    expect(plans.every((plan) => plan.captures.length > 0)).toBe(true);
    // Every capture stays attributed to the manifest that records its bytes.
    expect(captures.every((capture) => manifestPaths.has(capture.manifestPath))).toBe(
      true,
    );
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

  it('documents the pre-run removal and the unavailable hash on a skipped write', () => {
    expect(reproDocs).toContain('每跑开始前');
    expect(reproDocs).toContain('删除');
    expect(reproDocs).toContain('unavailable');
    expect(reproDocs).toContain('git restore docs/screenshots');
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
