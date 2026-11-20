import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REPRO_LOAD_RUNS,
  DEFAULT_REPRO_LOAD_TARGETS,
  DEFAULT_REPRO_LOAD_WORKERS,
  MIN_REPRO_LOAD_RUNS,
  REPRO_LOAD_INPUT_ENV,
  ReproLoadInputError,
  formatGithubOutput,
  manifestCaptureTargets,
  normalizeLoad,
  normalizeReproLoadInputs,
  normalizeRuns,
  parseTargetList,
} from '../../scripts/lib/repro-load-inputs.mjs';
import { MAX_LOAD_COUNT } from '../../scripts/lib/screenshot-repro.mjs';
import {
  DEFAULT_MANIFEST_PATH,
  parseSha256Manifest,
} from '../../scripts/lib/screenshot-sha256.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-repro-load-inputs.mjs');
const MANIFEST_PATH = join(ROOT, DEFAULT_MANIFEST_PATH);
const SUPPORTED = [
  'screenshots:webkit',
  'screenshots:breakout:webkit',
  'screenshots:snake:webkit',
  'screenshots:minesweeper:webkit',
];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repro-load-inputs-'));
  tempDirs.push(dir);
  return dir;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI with the given env; an undefined value removes the variable. */
function runCli(
  env: Record<string, string | undefined> = {},
  args: string[] = [],
): CliResult {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete childEnv[key];
    } else {
      childEnv[key] = value;
    }
  }
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: childEnv,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('repro load inputs', () => {
  it('falls back to the scheduled defaults when every input is blank', () => {
    expect(DEFAULT_REPRO_LOAD_RUNS).toBe(4);
    expect(MIN_REPRO_LOAD_RUNS).toBe(4);
    expect(DEFAULT_REPRO_LOAD_WORKERS).toBe(8);
    expect(DEFAULT_REPRO_LOAD_WORKERS).toBeLessThanOrEqual(MAX_LOAD_COUNT);

    const defaults = {
      targets: [...DEFAULT_REPRO_LOAD_TARGETS],
      runs: DEFAULT_REPRO_LOAD_RUNS,
      load: DEFAULT_REPRO_LOAD_WORKERS,
    };
    expect(normalizeReproLoadInputs({}, SUPPORTED)).toEqual(defaults);

    for (const blank of ['', '   ']) {
      expect(
        normalizeReproLoadInputs(
          { targets: blank, runs: blank, load: blank },
          SUPPORTED,
        ),
      ).toEqual(defaults);
    }
  });

  it('parses a comma-separated target list, trims entries and drops duplicates', () => {
    expect(
      parseTargetList(
        ' screenshots:snake:webkit , screenshots:webkit, screenshots:snake:webkit ',
        SUPPORTED,
      ),
    ).toEqual(['screenshots:snake:webkit', 'screenshots:webkit']);
  });

  it('rejects empty entries, malformed targets and targets the manifest does not name', () => {
    expect(() => parseTargetList('screenshots:webkit,,screenshots:snake:webkit', SUPPORTED))
      .toThrow(ReproLoadInputError);
    expect(() => parseTargetList('screenshots:webkit,npm run screenshots:webkit', SUPPORTED))
      .toThrow(ReproLoadInputError);
    expect(() => parseTargetList('screenshots:tetris:webkit', SUPPORTED)).toThrow(
      /unsupported targets entry/,
    );
    expect(() => parseTargetList('screenshots:webkit', [])).toThrow(
      /names no supported capture target/,
    );
  });

  it('derives the supported set from the real manifest', () => {
    const manifest = parseSha256Manifest(readFileSync(MANIFEST_PATH, 'utf8'));
    const targets = manifestCaptureTargets(manifest);

    expect(targets).toContain('screenshots:webkit');
    expect(targets).toContain('screenshots:breakout:webkit');
    expect(targets).toContain('screenshots:snake:webkit');
    expect(targets).toContain('screenshots:minesweeper:scores:webkit');

    expect(
      normalizeReproLoadInputs(
        { targets: DEFAULT_REPRO_LOAD_TARGETS.join(',') },
        targets,
      ).targets,
    ).toEqual([...DEFAULT_REPRO_LOAD_TARGETS]);
  });

  it('requires at least four runs and a safe positive integer', () => {
    expect(normalizeRuns('4')).toBe(4);
    expect(normalizeRuns(' 12 ')).toBe(12);
    expect(() => normalizeRuns(String(MIN_REPRO_LOAD_RUNS - 1))).toThrow(/at least 4/);
    expect(() => normalizeRuns('0')).toThrow(ReproLoadInputError);
    expect(() => normalizeRuns('-2')).toThrow(ReproLoadInputError);
    expect(() => normalizeRuns('1.5')).toThrow(ReproLoadInputError);
    expect(() => normalizeRuns('four')).toThrow(ReproLoadInputError);
  });

  it('requires a positive load below the repro upper bound', () => {
    expect(normalizeLoad('1')).toBe(1);
    expect(normalizeLoad(String(MAX_LOAD_COUNT))).toBe(MAX_LOAD_COUNT);
    expect(() => normalizeLoad('0')).toThrow(/positive integer/);
    expect(() => normalizeLoad(String(MAX_LOAD_COUNT + 1))).toThrow(/at most/);
    expect(() => normalizeLoad('-2')).toThrow(ReproLoadInputError);
    expect(() => normalizeLoad('1.5')).toThrow(ReproLoadInputError);
  });

  it('refuses to validate without a manifest-derived target set', () => {
    expect(() => normalizeReproLoadInputs({})).toThrow(/supportedTargets/);
  });

  it('formats only the normalized values as step outputs', () => {
    expect(formatGithubOutput({ targets: ['a', 'b'], runs: 5, load: 9 })).toBe(
      'targets=a,b\nruns=5\nload=9\n',
    );
  });
});

describe('check-repro-load-inputs CLI', () => {
  it('writes the validated dispatch inputs to $GITHUB_OUTPUT', () => {
    const output = join(tempDir(), 'github-output.txt');
    const result = runCli({
      GITHUB_OUTPUT: output,
      [REPRO_LOAD_INPUT_ENV.targets]: 'screenshots:webkit,screenshots:snake:webkit',
      [REPRO_LOAD_INPUT_ENV.runs]: '6',
      [REPRO_LOAD_INPUT_ENV.load]: '12',
    });

    expect(result.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(
      'targets=screenshots:webkit,screenshots:snake:webkit\nruns=6\nload=12\n',
    );
    expect(result.stdout).toContain('2 target(s) x 6 runs under 12 CPU load worker(s)');
  });

  it('writes the defaults for a scheduled run without dispatch inputs', () => {
    const output = join(tempDir(), 'github-output.txt');
    const result = runCli({
      GITHUB_OUTPUT: output,
      [REPRO_LOAD_INPUT_ENV.targets]: undefined,
      [REPRO_LOAD_INPUT_ENV.runs]: undefined,
      [REPRO_LOAD_INPUT_ENV.load]: undefined,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(
      `targets=${DEFAULT_REPRO_LOAD_TARGETS.join(',')}\n` +
        `runs=${DEFAULT_REPRO_LOAD_RUNS}\nload=${DEFAULT_REPRO_LOAD_WORKERS}\n`,
    );
  });

  it('fails without writing outputs when runs is below the floor', () => {
    const output = join(tempDir(), 'github-output.txt');
    const result = runCli({
      GITHUB_OUTPUT: output,
      [REPRO_LOAD_INPUT_ENV.runs]: '3',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('at least 4');
    expect(existsSync(output)).toBe(false);
  });

  it('fails without writing outputs when a target is not in the manifest', () => {
    const output = join(tempDir(), 'github-output.txt');
    const result = runCli({
      GITHUB_OUTPUT: output,
      [REPRO_LOAD_INPUT_ENV.targets]: 'screenshots:tetris:webkit',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unsupported targets entry');
    expect(existsSync(output)).toBe(false);
  });

  it('fails without $GITHUB_OUTPUT and on an unknown option', () => {
    const noOutput = runCli({ GITHUB_OUTPUT: undefined });
    expect(noOutput.status).toBe(2);
    expect(noOutput.stderr).toContain('GITHUB_OUTPUT');

    const unknown = runCli({ GITHUB_OUTPUT: join(tempDir(), 'out.txt') }, ['--nope']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown option');
  });

  it('prints the usage for --help and rejects an unreadable manifest', () => {
    const help = runCli({}, ['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: node scripts/check-repro-load-inputs.mjs');
    expect(help.stdout).toContain(REPRO_LOAD_INPUT_ENV.targets);

    const missingManifest = runCli(
      { GITHUB_OUTPUT: join(tempDir(), 'out.txt') },
      ['--manifest', join(tempDir(), 'missing.json')],
    );
    expect(missingManifest.status).toBe(2);
    expect(missingManifest.stderr).toContain('error:');
  });
});
