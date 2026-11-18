import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBaseline } from '../../scripts/lib/score.mjs';
import type { CheckStatus, ScoreBaseline } from '../../scripts/lib/score.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'score.mjs');
const BASELINE_RELATIVE_PATH = join('docs', 'score-baseline.json');

/**
 * The CLI runs `npm run <script>` for the build and the six checks and reads
 * the commit with `git rev-parse HEAD`. A fake `npm` and `git` on PATH keep
 * these tests offline and deterministic: no real build, check or git call runs.
 */
const CURRENT_UNIT_TESTS = 1258;
const CURRENT_ENTRY_GZIP_BYTES = 11428;
const CURRENT_TOTAL_JS_GZIP_BYTES = 420434;

const PASS_CHECKS: Record<string, CheckStatus> = {
  lint: 'pass',
  'check:budget': 'pass',
  'verify:doc-counts': 'pass',
  'verify:screenshots:doc-dims': 'pass',
  'verify:screenshots:sha256': 'pass',
  'verify:screenshots:webkit': 'pass',
};

interface FakeRun {
  status?: number;
  stdout?: string;
  stderr?: string;
}

function docCountsOutput(count: number): string {
  return `OK: README.md / docs/framework.md / docs/snake-design.md 的单测计数均为 ${count}，与 Vitest numTotalTests 一致。\n`;
}

function successRuns(overrides: Record<string, FakeRun> = {}): Record<string, FakeRun> {
  return {
    build: { stdout: 'vite v8.3.5 building for production...\n' },
    lint: { stdout: 'Module boundaries OK (69 source files).\n' },
    'check:budget': {
      stdout: [
        'Entry JS: 24.58 KB (11.16 KB gzip)',
        'All JS chunks: 410.58 KB gzip (2D game budget 450 KB)',
        'Budget check OK: shell is engine-free and within the 2D download budget.',
        '',
      ].join('\n'),
    },
    'verify:doc-counts': { stdout: docCountsOutput(CURRENT_UNIT_TESTS) },
    'verify:screenshots:doc-dims': { stdout: 'OK: 尺寸与 sha256 全部一致。\n' },
    'verify:screenshots:sha256': {
      stdout: 'OK: 40 screenshot sha256 entries verified in /repo/docs/screenshots\n',
    },
    'verify:screenshots:webkit': {
      stdout: 'OK: 12 WebKit screenshot artifacts verified in /repo/docs/screenshots\n',
    },
    ...overrides,
  };
}

function baseline(overrides: Partial<ScoreBaseline> = {}): ScoreBaseline {
  return {
    unitTests: CURRENT_UNIT_TESTS,
    entryGzipBytes: CURRENT_ENTRY_GZIP_BYTES,
    totalJsGzipBytes: CURRENT_TOTAL_JS_GZIP_BYTES,
    checks: { ...PASS_CHECKS },
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function fakeNpmSource(runs: Record<string, FakeRun>): string {
  return `#!/usr/bin/env node
const fixtures = ${JSON.stringify(runs)};
const script = process.argv[2] === 'run' ? process.argv[3] : process.argv[2];
const fixture = fixtures[script];
if (fixture === undefined) {
  process.stderr.write(\`fake npm: unexpected script \${String(script)}\\n\`);
  process.exitCode = 127;
} else {
  process.stdout.write(fixture.stdout ?? '');
  process.stderr.write(fixture.stderr ?? '');
  process.exitCode = fixture.status ?? 0;
}
`;
}

interface ProjectOptions {
  baseline?: ScoreBaseline | null;
  runs?: Record<string, FakeRun>;
}

function makeProject(options: ProjectOptions = {}): string {
  const { baseline: baselineValue = baseline(), runs = {} } = options;
  const dir = mkdtempSync(join(tmpdir(), 'score-cli-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'docs'));

  // POSIX-only fixtures: the CLI resolves `npm` / `git` through PATH and these
  // files rely on the executable shebang. The suite is skipped on Windows.
  writeFileSync(join(dir, 'bin', 'npm'), fakeNpmSource(successRuns(runs)), { mode: 0o755 });
  writeFileSync(
    join(dir, 'bin', 'git'),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify('a'.repeat(40))} + '\\n');\n`,
    { mode: 0o755 },
  );

  if (baselineValue !== null) {
    writeFileSync(
      join(dir, BASELINE_RELATIVE_PATH),
      `${JSON.stringify(baselineValue, null, 2)}\n`,
    );
  }

  return dir;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScoreCli(dir: string, args: string[] = []): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error === undefined ? '' : String(result.error)}`,
  };
}

// The fake `npm` and `git` executables rely on the POSIX shebang mechanism.
const describeCli = process.platform === 'win32' ? describe.skip : describe;

describeCli('score CLI', () => {
  it('exits 0 when the snapshot matches the baseline', () => {
    const dir = makeProject();

    const result = runScoreCli(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('结论: 与基线一致');
    expect(result.stdout).toContain('SCORE_JSON');
  });

  it('exits 1 and names a unit test regression with its delta', () => {
    const dir = makeProject({
      baseline: baseline({ unitTests: CURRENT_UNIT_TESTS + 1 }),
    });

    const result = runScoreCli(dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('结论: 退化');
    expect(result.stdout).toContain(
      `unitTests: 当前 ${CURRENT_UNIT_TESTS}，基线 ${CURRENT_UNIT_TESTS + 1}，差 -1`,
    );
  });

  it('exits 1 and names an entry gzip regression with its delta', () => {
    const dir = makeProject({
      baseline: baseline({ entryGzipBytes: CURRENT_ENTRY_GZIP_BYTES - 1 }),
    });

    const result = runScoreCli(dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('结论: 退化');
    expect(result.stdout).toContain(
      `entryGzipBytes: 当前 ${CURRENT_ENTRY_GZIP_BYTES}，基线 ${
        CURRENT_ENTRY_GZIP_BYTES - 1
      }，差 +1`,
    );
  });

  it('exits 2 and explains how to create a missing baseline', () => {
    const dir = makeProject({ baseline: null });

    const result = runScoreCli(dir);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`找不到基线文件 ${join('docs', 'score-baseline.json')}`);
    expect(result.stderr).toContain('请先运行 npm run score -- --update 生成基线');
    expect(result.stderr).not.toContain('Running npm run');
    expect(existsSync(join(dir, BASELINE_RELATIVE_PATH))).toBe(false);
  });

  it('exits 2 and reports a corrupt baseline', () => {
    const dir = makeProject({ baseline: null });
    writeFileSync(join(dir, BASELINE_RELATIVE_PATH), '{');

    const result = runScoreCli(dir);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('不是合法的 JSON');
    expect(result.stderr).toContain('请先运行 npm run score -- --update 生成基线');
    expect(result.stderr).not.toContain('Running npm run');
  });

  it('exits 2 and prints usage for an unknown option', () => {
    const dir = makeProject();

    const result = runScoreCli(dir, ['--bogus']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown option: --bogus');
    expect(result.stderr).toContain('Usage: npm run score');
    expect(result.stderr).not.toContain('Running npm run');
  });

  it('writes the new baseline with --update and prints old → new values', () => {
    const dir = makeProject({
      baseline: baseline({
        unitTests: CURRENT_UNIT_TESTS - 1,
        entryGzipBytes: CURRENT_ENTRY_GZIP_BYTES - 1,
      }),
    });

    const result = runScoreCli(dir, ['--update']);

    // The entry gzip value regresses, but --update still writes and exits 0.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('结论: 退化');
    expect(result.stdout).toContain('基线已更新');
    expect(result.stdout).toContain(
      `unitTests: ${CURRENT_UNIT_TESTS - 1} → ${CURRENT_UNIT_TESTS}`,
    );
    expect(result.stdout).toContain(
      `entryGzipBytes: ${CURRENT_ENTRY_GZIP_BYTES - 1} → ${CURRENT_ENTRY_GZIP_BYTES}`,
    );

    const scoreJsonLine = result.stdout
      .split('\n')
      .find((line) => line.startsWith('SCORE_JSON '));
    expect(scoreJsonLine).toBeDefined();
    const printedSnapshot = JSON.parse(
      (scoreJsonLine ?? '').slice('SCORE_JSON '.length),
    ) as { unitTests: number };
    expect(printedSnapshot.unitTests).toBe(CURRENT_UNIT_TESTS);

    const written = parseBaseline(
      readFileSync(join(dir, BASELINE_RELATIVE_PATH), 'utf8'),
    );
    expect(written).toEqual(baseline());
  });

  it('creates the baseline with --update when none exists', () => {
    const dir = makeProject({ baseline: null });

    const result = runScoreCli(dir, ['--update']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('基线已更新');
    expect(result.stdout).toContain(`unitTests: 无 → ${CURRENT_UNIT_TESTS}`);
    expect(
      parseBaseline(readFileSync(join(dir, BASELINE_RELATIVE_PATH), 'utf8')),
    ).toEqual(baseline());
  });

  it('rebuilds a corrupt baseline with --update after warning', () => {
    const dir = makeProject({ baseline: null });
    writeFileSync(join(dir, BASELINE_RELATIVE_PATH), '{');

    const result = runScoreCli(dir, ['--update']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('现有基线不可用');
    expect(
      parseBaseline(readFileSync(join(dir, BASELINE_RELATIVE_PATH), 'utf8')),
    ).toEqual(baseline());
  });

  it('refuses to overwrite the baseline when the snapshot is incomplete', () => {
    const previous = `${JSON.stringify(
      baseline({ unitTests: CURRENT_UNIT_TESTS, entryGzipBytes: 11000, totalJsGzipBytes: 410000 }),
      null,
      2,
    )}\n`;
    const dir = makeProject({
      baseline: baseline({ entryGzipBytes: 11000, totalJsGzipBytes: 410000 }),
      runs: {
        build: { status: 1, stderr: 'vite build failed\n' },
        'check:budget': { status: 1, stderr: 'dist/ not found; run npm run build first\n' },
      },
    });

    const result = runScoreCli(dir, ['--update']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('当前快照不完整，拒绝写入基线');
    expect(result.stderr).toContain('entryGzipBytes');
    expect(result.stderr).toContain('totalJsGzipBytes');
    expect(result.stderr).toContain('  - check:budget: npm run check:budget exited with code 1');
    expect(result.stderr).toContain('  - build: npm run build exited with code 1');
    expect(readFileSync(join(dir, BASELINE_RELATIVE_PATH), 'utf8')).toBe(previous);
  });

  it('refuses to create a baseline from an incomplete snapshot', () => {
    const dir = makeProject({
      baseline: null,
      runs: { 'check:budget': { status: 1, stderr: 'boom\n' } },
    });

    const result = runScoreCli(dir, ['--update']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('当前快照不完整，拒绝写入基线');
    expect(existsSync(join(dir, BASELINE_RELATIVE_PATH))).toBe(false);
  });
});
