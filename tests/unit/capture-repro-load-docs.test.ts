import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  DEFAULT_REPRO_LOAD_RUNS,
  DEFAULT_REPRO_LOAD_TARGETS,
  DEFAULT_REPRO_LOAD_WORKERS,
  MIN_REPRO_LOAD_RUNS,
} from '../../scripts/lib/repro-load-inputs.mjs';
import { reproArtifactDir, reproLogPath } from '../../scripts/lib/screenshot-repro.mjs';
import { parseArgs } from '../../scripts/verify-screenshot-repro.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENSHOTS_README_PATH = join(ROOT, 'docs', 'screenshots', 'README.md');
const README_PATH = join(ROOT, 'README.md');
const LOAD_WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'capture-repro-load.yml');
const NIGHTLY_WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'capture-repro.yml');
const LOAD_SECTION_HEADING = '## 并发负载截图复现（Issue #352）';
const MANIFEST_UNCHANGED_COMMAND =
  'git diff --exit-code -- docs/screenshots/capture-sha256-manifest.json';

interface WorkflowInput {
  default?: string;
}

interface WorkflowStep {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  'timeout-minutes'?: number;
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

const screenshotsReadme = readFileSync(SCREENSHOTS_README_PATH, 'utf8');
const readme = readFileSync(README_PATH, 'utf8');
const loadWorkflow = parse(readFileSync(LOAD_WORKFLOW_PATH, 'utf8')) as Workflow;
const nightlyWorkflow = parse(readFileSync(NIGHTLY_WORKFLOW_PATH, 'utf8')) as Workflow;
const dispatchInputs = (
  loadWorkflow.on?.workflow_dispatch as
    | { inputs?: Record<string, WorkflowInput> }
    | undefined
)?.inputs;
const loadJob = loadWorkflow.jobs?.['load-repro'];
const nightlyJob = nightlyWorkflow.jobs?.repro;

/** The text of one level-2 section, up to the next level-2 heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw new Error(`missing section: ${heading}`);
  }
  const end = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

/** One `- ` bullet, up to the next one (table and fence bodies included). */
function bullet(text: string, prefix: string): string {
  const start = text.indexOf(prefix);
  if (start < 0) {
    throw new Error(`missing bullet: ${prefix}`);
  }
  const end = text.indexOf('\n- ', start + prefix.length);
  return text.slice(start, end === -1 ? undefined : end);
}

/**
 * The documented local repro command, split into CLI argv.
 *
 * The docs must show the same `--target` / `--runs` / `--load` invocation the
 * workflow forwards after validating its dispatch inputs, so the test feeds the
 * documented flags to the real parser instead of only matching strings.
 */
function documentedLocalArgs(text: string): string[] {
  const match = /^\s*npm run verify:screenshots:repro -- (.+)$/m.exec(text);
  const command = match?.[1];
  if (command === undefined) {
    throw new Error('the load section is missing the documented local repro command');
  }
  return command.trim().split(/\s+/);
}

/** The trimmed cells of one `| input | default | meaning |` table row. */
function documentedInputRow(text: string, input: string): string[] {
  const row = text.split('\n').find((line) => line.startsWith(`| \`${input}\` |`));
  if (row === undefined) {
    throw new Error(`missing documented input row: ${input}`);
  }
  return row
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell !== '');
}

/**
 * The backticked default value of one input table row.
 *
 * Row-specific parsing keeps the `runs` and `load` defaults from being swapped
 * in the docs while both literals still appear somewhere.
 */
function documentedInputDefault(text: string, input: string): string | null {
  const cells = documentedInputRow(text, input);
  return /^`(.+)`$/.exec(cells[1] ?? '')?.[1] ?? null;
}

function workflowSteps(workflow: Workflow): WorkflowStep[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

const loadDocs = section(screenshotsReadme, LOAD_SECTION_HEADING);
const REPRO_LOG_DIR = 'test-results/screenshot-repro';
const WEBKIT_LOG_NAME = basename(reproLogPath(REPRO_LOG_DIR, 'screenshots:webkit', 1));
const WEBKIT_PNG_DIR_NAME = `${basename(
  reproArtifactDir(REPRO_LOG_DIR, 'screenshots:webkit', 1),
)}/`;

describe('concurrent-load repro docs (Issue #352)', () => {
  it('documents the new workflow file and both triggers', () => {
    const triggerDocs = bullet(loadDocs, '- 触发：');
    expect(triggerDocs).toContain('.github/workflows/capture-repro-load.yml');
    expect(triggerDocs).toContain('schedule');
    expect(triggerDocs).toContain('workflow_dispatch');

    const schedule = loadWorkflow.on?.schedule as Array<{ cron?: string }> | undefined;
    expect(schedule?.[0]?.cron).toBe('47 5 * * *');
    expect(triggerDocs).toContain('05:47 UTC');
  });

  it('documents the dispatch inputs with the workflow defaults', () => {
    expect(dispatchInputs?.targets?.default).toBe(DEFAULT_REPRO_LOAD_TARGETS.join(','));
    expect(dispatchInputs?.runs?.default).toBe(String(DEFAULT_REPRO_LOAD_RUNS));
    expect(dispatchInputs?.load?.default).toBe(String(DEFAULT_REPRO_LOAD_WORKERS));

    // The dispatch default is the floor: a manual run cannot silently drop the
    // gate back to the nightly's two runs.
    expect(DEFAULT_REPRO_LOAD_RUNS).toBe(MIN_REPRO_LOAD_RUNS);
    expect(documentedInputDefault(loadDocs, 'targets')).toBe(
      dispatchInputs?.targets?.default,
    );
    expect(documentedInputDefault(loadDocs, 'runs')).toBe(
      String(DEFAULT_REPRO_LOAD_RUNS),
    );
    expect(documentedInputDefault(loadDocs, 'load')).toBe(
      String(DEFAULT_REPRO_LOAD_WORKERS),
    );
    expect(documentedInputRow(loadDocs, 'targets')[2] ?? '').toContain('WebKit');
    expect(documentedInputRow(loadDocs, 'runs')[2] ?? '').toContain(
      `至少 ${MIN_REPRO_LOAD_RUNS}`,
    );
    expect(documentedInputRow(loadDocs, 'load')[2] ?? '').toContain('正整数');
  });

  it('documents the three affected WebKit default targets', () => {
    expect(DEFAULT_REPRO_LOAD_TARGETS).toHaveLength(3);
    for (const target of DEFAULT_REPRO_LOAD_TARGETS) {
      expect(target.endsWith(':webkit')).toBe(true);
      expect(loadDocs).toContain(target);
    }
  });

  it('keeps the documented local command consistent with the workflow and CLI', () => {
    const options = parseArgs(documentedLocalArgs(loadDocs));

    // The documented command reproduces the workflow defaults through the same
    // parser the entry uses, so a renamed flag or a different default fails here.
    expect(options.targets).toEqual([...DEFAULT_REPRO_LOAD_TARGETS]);
    expect(options.runs).toBe(Number(dispatchInputs?.runs?.default));
    expect(options.load).toBe(Number(dispatchInputs?.load?.default));
    expect(loadDocs).toContain('--target');
    expect(loadDocs).toContain('--runs');
    expect(loadDocs).toContain('--load');
  });

  it('documents the failure report, non-zero exit and artifact upload', () => {
    const failureDocs = bullet(loadDocs, '- 失败输出：');
    expect(failureDocs).toContain('非 0');
    expect(failureDocs).toContain('失败报告退出 1');
    expect(failureDocs).toContain('用法或清单非法退出 2');
    expect(failureDocs).toContain('sha256');
    expect(failureDocs).toContain('逐跑日志');
    expect(failureDocs).toContain('重拍步骤');
    expect(failureDocs).toContain('GITHUB_STEP_SUMMARY');
    expect(failureDocs).toContain(`${REPRO_LOG_DIR}/${WEBKIT_LOG_NAME}`);
    expect(failureDocs).toContain(WEBKIT_PNG_DIR_NAME);
    expect(failureDocs).toContain('test-results/capture-container/');
    expect(failureDocs).toContain('capture-repro-load-logs');

    // The workflow must upload what the failure bullet promises.
    const upload = (loadJob?.steps ?? []).find((step) =>
      (step.uses ?? '').startsWith('actions/upload-artifact@'),
    );
    expect(upload?.with?.name).toBe('capture-repro-load-logs');
    expect(upload?.with?.path).toContain('test-results/screenshot-repro/');
    expect(upload?.with?.path).toContain('test-results/capture-container/');
  });

  it('documents that the default nightly two-run workflow is unchanged', () => {
    const nightlyDocs = bullet(loadDocs, '- 默认夜间不变：');
    expect(nightlyDocs).toContain('.github/workflows/capture-repro.yml');
    expect(nightlyDocs).toContain('04:41 UTC');
    expect(nightlyDocs).toContain('两跑');
    expect(nightlyDocs).toContain('60 分钟');
    expect(nightlyDocs).toContain('按清单');
    expect(nightlyDocs).toContain('command');
    expect(nightlyDocs).toContain('派生');

    const nightlySchedule = nightlyWorkflow.on?.schedule as
      | Array<{ cron?: string }>
      | undefined;
    expect(nightlySchedule?.[0]?.cron).toBe('41 4 * * *');
    expect(nightlyJob?.['timeout-minutes']).toBe(60);

    // The nightly still runs the entry without any load / selection flag.
    const repro = (nightlyJob?.steps ?? [])
      .map((step) => (step.run ?? '').trim())
      .find((command) => command.includes('verify:screenshots:repro'));
    expect(repro).toBe('npm run verify:screenshots:repro');
  });

  it('documents the manifest read-only contract and the convergence policy', () => {
    const readonlyDocs = bullet(loadDocs, '- 清单只读：');
    expect(readonlyDocs).toContain('只读');
    expect(readonlyDocs).toContain(MANIFEST_UNCHANGED_COMMAND);
    expect(readonlyDocs).toContain('移出');
    expect(readonlyDocs).toContain('targets');
    expect(readonlyDocs).toContain('默认集合');
    expect(readonlyDocs).toContain('记录原因');
    expect(readonlyDocs).toMatch(/不放宽|不降低/);

    for (const workflow of [loadWorkflow, nightlyWorkflow]) {
      const check = workflowSteps(workflow).find(
        (step) => (step.run ?? '').trim() === MANIFEST_UNCHANGED_COMMAND,
      );
      expect(check).toBeDefined();
    }
  });

  it('documents the host-load evidence boundary', () => {
    const boundaryDocs = bullet(loadDocs, '- 证据边界：');
    expect(boundaryDocs).toContain('宿主');
    expect(boundaryDocs).toContain('Linux WebKit');
    expect(boundaryDocs).toContain('固定 Playwright 容器');
    expect(boundaryDocs).toContain('只覆盖');
  });

  it('links the concurrent-load workflow from the main README nightly paragraph', () => {
    const nightlyLine = readme
      .split('\n')
      .find((line) => line.includes('截图证据的夜间复现'));
    expect(nightlyLine).toBeDefined();
    expect(nightlyLine).toContain('](.github/workflows/capture-repro-load.yml)');
    expect(nightlyLine).toContain('](docs/screenshots/README.md)');
    expect(nightlyLine).toContain('并发负载截图复现');
    expect(nightlyLine).toContain('至少 4 跑');
  });
});
