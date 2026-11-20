import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BudgetError,
  ENTRY_LIMIT,
  PER_GAME_LIMIT,
  TOTAL_JS_LIMIT,
  evaluateZhenShaViewChunks,
  findZhenShaViewChunks,
  formatGzipKb,
  measureBudget,
} from '../../scripts/lib/budget.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'check-budget.mjs');
const ENTRY_FILE = 'index-abc123.js';
const ENTRY_HTML = `<script type="module" crossorigin src="/assets/${ENTRY_FILE}"></script>`;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-budget-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface FixtureFile {
  name: string;
  contents: Buffer | string;
}

interface FixtureOptions {
  entry?: Buffer | string;
  chunks?: FixtureFile[];
  css?: FixtureFile[];
}

/** Create a minimal `dist/` fixture that the real CLI can measure from its cwd. */
function makeDist({ entry = 'console.log("shell");', chunks = [], css = [] }: FixtureOptions) {
  const dir = makeTempDir();
  const assets = join(dir, 'dist', 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), `<!doctype html>${ENTRY_HTML}`);
  writeFileSync(join(assets, ENTRY_FILE), entry);
  for (const chunk of [...css, ...chunks]) {
    writeFileSync(join(assets, chunk.name), chunk.contents);
  }
  return dir;
}

/** An incompressible chunk so its gzip size stays close to the raw size. */
function zhenShaChunk(rawBytes: number, suffix = String(rawBytes)): FixtureFile {
  return {
    name: `zhen-sha-view-${suffix}.js`,
    contents: randomBytes(rawBytes),
  };
}

function runCli(distDir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI], {
    cwd: distDir,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('zhen-sha view gzip budget', () => {
  it('passes when the chunk gzip is at or under 35 KB', () => {
    const atLimit = evaluateZhenShaViewChunks([
      { file: 'zhen-sha-view-a.js', gzipBytes: PER_GAME_LIMIT },
    ]);

    expect(atLimit.failures).toEqual([]);
    expect(atLimit.totalGzipBytes).toBe(PER_GAME_LIMIT);
  });

  it('fails when the chunk gzip is over 35 KB and names the chunk, size and limit', () => {
    const chunk = { file: 'zhen-sha-view-over.js', gzipBytes: PER_GAME_LIMIT + 1 };
    const result = evaluateZhenShaViewChunks([chunk]);

    expect(result.totalGzipBytes).toBe(PER_GAME_LIMIT + 1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('zhen-sha-view-over.js');
    expect(result.failures[0]).toContain(formatGzipKb(PER_GAME_LIMIT + 1));
    expect(result.failures[0]).toContain('35 KB');
  });

  it('measures an over-budget fixture chunk through the shared gzipSync default level', () => {
    const chunk = zhenShaChunk(36 * 1024);
    const dir = makeDist({ chunks: [chunk] });
    const report = measureBudget(join(dir, 'dist'));

    expect(report.zhenSha.chunks).toHaveLength(1);
    expect(report.zhenSha.chunks[0]?.gzipBytes).toBeGreaterThan(PER_GAME_LIMIT);
    expect(report.zhenSha.gzipBytes).toBeGreaterThan(PER_GAME_LIMIT);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain(chunk.name);
    expect(report.failures[0]).toContain(formatGzipKb(report.zhenSha.gzipBytes));
    expect(report.failures[0]).toContain('35 KB');
  });

  it('fails loudly when no zhen-sha view chunk is present', () => {
    const dir = makeDist({});
    const report = measureBudget(join(dir, 'dist'));

    expect(report.zhenSha.chunks).toEqual([]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('zhen-sha-view-*.js');
    expect(report.failures[0]).toContain('npm run build');

    const result = runCli(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Budget check failed:');
    expect(result.stderr).toContain('zhen-sha-view-*.js');
    expect(result.stderr).toContain('npm run build');
  });

  it('lists every matching chunk and judges their combined gzip, not only the first', () => {
    const first = zhenShaChunk(10 * 1024, 'a');
    const second = zhenShaChunk(30 * 1024, 'b');
    const dir = makeDist({ chunks: [first, second] });
    const report = measureBudget(join(dir, 'dist'));

    expect(report.zhenSha.chunks.map((chunk) => chunk.file)).toEqual([first.name, second.name]);
    expect(report.zhenSha.gzipBytes).toBeGreaterThan(PER_GAME_LIMIT);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain(first.name);
    expect(report.failures[0]).toContain(second.name);
    expect(report.failures[0]).toContain(formatGzipKb(report.zhenSha.gzipBytes));
    expect(report.failures[0]).toContain('35 KB');
  });

  it('passes multiple chunks whose combined gzip stays under 35 KB', () => {
    const dir = makeDist({
      chunks: [zhenShaChunk(16 * 1024, 'a'), zhenShaChunk(16 * 1024, 'b')],
    });
    const report = measureBudget(join(dir, 'dist'));

    expect(report.zhenSha.chunks).toHaveLength(2);
    expect(report.zhenSha.gzipBytes).toBeLessThanOrEqual(PER_GAME_LIMIT);
    expect(report.failures).toEqual([]);

    const result = runCli(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`zhen-sha-view-a.js`);
    expect(result.stdout).toContain(`zhen-sha-view-b.js`);
    expect(result.stdout).toContain('Zhen Sha view JS:');
    expect(result.stdout).toContain('total:');
  });
});

describe('existing budget gates', () => {
  it('keeps the entry under 50 KB and free of engine markers', () => {
    const dir = makeDist({ entry: 'Phaser.Game;', chunks: [zhenShaChunk(1024)] });
    const report = measureBudget(join(dir, 'dist'));

    expect(report.entry.gzipBytes).toBeLessThanOrEqual(ENTRY_LIMIT);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('engine marker');

    const overEntry = makeDist({
      entry: randomBytes(ENTRY_LIMIT + 1024),
      chunks: [zhenShaChunk(1024)],
    });
    const overReport = measureBudget(join(overEntry, 'dist'));
    expect(overReport.entry.gzipBytes).toBeGreaterThan(ENTRY_LIMIT);
    expect(overReport.failures.some((failure) => failure.includes('50 KB budget'))).toBe(true);
  });

  it('keeps the 450 KB total JS budget', () => {
    const dir = makeDist({
      chunks: [zhenShaChunk(1024), { name: 'phaser.esm-deadbeef.js', contents: randomBytes(TOTAL_JS_LIMIT) }],
    });
    const report = measureBudget(join(dir, 'dist'));

    expect(report.allJs.gzipBytes).toBeGreaterThan(TOTAL_JS_LIMIT);
    expect(report.failures.some((failure) => failure.includes('450 KB 2D budget'))).toBe(true);
  });

  it('fails when dist/index.html is missing', () => {
    const dir = makeTempDir();

    expect(() => measureBudget(join(dir, 'dist'))).toThrowError(BudgetError);
    expect(() => measureBudget(join(dir, 'dist'))).toThrow(/npm run build/);
  });

  it('finds only hashed zhen-sha view chunk names', () => {
    expect(
      findZhenShaViewChunks([
        'zhen-sha-view-b.js',
        'zhen-sha-view-a.js',
        'zhen-sha-view.css',
        'zhen-sha-view.test.js',
        'index.js',
      ]),
    ).toEqual(['zhen-sha-view-a.js', 'zhen-sha-view-b.js']);
  });
});
