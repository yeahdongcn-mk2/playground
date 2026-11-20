import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BudgetError,
  ENTRY_LIMIT,
  PER_GAME_LIMIT,
  TOTAL_JS_LIMIT,
  evaluateZhenShaViewChunks,
  findZhenShaViewChunks,
  formatGzipKb,
  gzipBytes,
  measureBudget,
} from '../../scripts/lib/budget.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'check-budget.mjs');
const ENTRY_FILE = 'index-abc123.js';
const ENTRY_HTML = `<script type="module" crossorigin src="/assets/${ENTRY_FILE}"></script>`;
const KB = 1024;

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

/**
 * Deterministic pseudo-random bytes: incompressible, so the gzip size stays
 * just above the raw size without depending on `randomBytes`.
 */
function incompressibleBytes(rawBytes: number): Buffer {
  const buffer = Buffer.alloc(rawBytes);
  let state = 0x12345678;
  for (let index = 0; index < rawBytes; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buffer[index] = (state >>> 0) & 0xff;
  }
  return buffer;
}

/**
 * Deterministic repetitive bytes serialized from JSON records: compresses far
 * below its raw size, and zlib levels 6 and 9 produce different lengths for it,
 * so tests can tell which level the measurement used. The slice may cut the
 * JSON short; that is harmless because only the gzip measurement is tested.
 */
function compressibleRecords(rawBytes: number): Buffer {
  const records: Array<{ i: number; v: number }> = [];
  // A serialized record is at least 12 bytes, so this yields enough records.
  while (records.length * 12 < rawBytes) {
    const i = records.length;
    records.push({ i, v: (i * 7) % 13 });
  }
  return Buffer.from(JSON.stringify(records).slice(0, rawBytes));
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

/** A deterministic incompressible zhen-sha view chunk. */
function zhenShaChunk(rawBytes: number, suffix = String(rawBytes)): FixtureFile {
  return {
    name: `zhen-sha-view-${suffix}.js`,
    contents: incompressibleBytes(rawBytes),
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

describe('gzip measurement', () => {
  it('compresses the measured bytes with gzipSync at the default level instead of using raw length', () => {
    const fixture = compressibleRecords(36 * KB);

    expect(fixture.length).toBe(36 * KB);
    // The production measurement must agree with an explicit default-level
    // gzip, and the fixture makes level 6 and level 9 disagree.
    expect(gzipBytes(fixture)).toBe(gzipSync(fixture, { level: 6 }).length);
    // Fixture-discrimination guard: if this fails, the fixture no longer tells
    // zlib levels apart; pick another fixture instead of relaxing the gate.
    expect(gzipSync(fixture, { level: 9 }).length).not.toBe(gzipBytes(fixture));
    // Highly compressible input: raw is over 35 KB, gzip is far below it.
    expect(gzipBytes(fixture)).toBeLessThan(35 * KB);
  });

  it('formats byte counts with two decimals and the KB unit', () => {
    expect(formatGzipKb(0)).toBe('0.00 KB');
    expect(formatGzipKb(512)).toBe('0.50 KB');
    expect(formatGzipKb(35 * KB)).toBe('35.00 KB');
    expect(formatGzipKb(36 * KB)).toBe('36.00 KB');
  });
});

describe('zhen-sha view gzip budget', () => {
  it('pins the per-game limit to 35 KB and judges the exact boundary', () => {
    expect(PER_GAME_LIMIT).toBe(35 * KB);

    const atLimit = evaluateZhenShaViewChunks([
      { file: 'zhen-sha-view-limit.js', gzipBytes: 35 * KB },
    ]);
    expect(atLimit.failures).toEqual([]);
    expect(atLimit.totalGzipBytes).toBe(35 * KB);

    const oneByteOver = evaluateZhenShaViewChunks([
      { file: 'zhen-sha-view-limit.js', gzipBytes: 35 * KB + 1 },
    ]);
    expect(oneByteOver.failures).toHaveLength(1);
    expect(oneByteOver.failures[0]).toContain('zhen-sha-view-limit.js');
    expect(oneByteOver.failures[0]).toContain('over the 35 KB per-game budget');
  });

  it('fails when the chunk gzip is over 35 KB and hard-codes the size and limit in the message', () => {
    const result = evaluateZhenShaViewChunks([
      { file: 'zhen-sha-view-over.js', gzipBytes: 36 * KB },
    ]);

    expect(result.totalGzipBytes).toBe(36 * KB);
    expect(result.failures).toEqual([
      'zhen-sha-view-over.js is 36.00 KB gzip, over the 35 KB per-game budget',
    ]);
  });

  it('lists every chunk and hard-codes the combined message for several chunks', () => {
    const result = evaluateZhenShaViewChunks([
      { file: 'zhen-sha-view-a.js', gzipBytes: 10 * KB },
      { file: 'zhen-sha-view-b.js', gzipBytes: 26 * KB },
    ]);

    expect(result.totalGzipBytes).toBe(36 * KB);
    expect(result.failures).toEqual([
      'zhen-sha-view chunks total 36.00 KB gzip (zhen-sha-view-a.js 10.00 KB + zhen-sha-view-b.js 26.00 KB), over the 35 KB per-game budget',
    ]);
  });

  it('passes a raw fixture over 35 KB whose gzip stays under 35 KB', () => {
    const chunk: FixtureFile = {
      name: 'zhen-sha-view-compressible.js',
      contents: compressibleRecords(36 * KB),
    };
    const dir = makeDist({ chunks: [chunk] });
    const report = measureBudget(join(dir, 'dist'));

    expect(report.zhenSha.chunks).toHaveLength(1);
    expect(report.zhenSha.chunks[0]?.bytes).toBe(36 * KB);
    expect(report.zhenSha.chunks[0]?.gzipBytes).toBe(gzipSync(chunk.contents, { level: 6 }).length);
    expect(report.zhenSha.gzipBytes).toBeLessThan(35 * KB);
    expect(report.failures).toEqual([]);

    const result = runCli(dir);
    expect(result.status).toBe(0);
    const expectedChunkKb = `${(gzipSync(chunk.contents).length / KB).toFixed(2)} KB`;
    expect(result.stdout).toContain(
      `Zhen Sha view JS: ${chunk.name} ${expectedChunkKb} gzip (per-game budget 35 KB)`,
    );
  });

  it('measures an over-budget fixture chunk and fails with the chunk name and limit', () => {
    const chunk = zhenShaChunk(36 * KB);
    const dir = makeDist({ chunks: [chunk] });
    const report = measureBudget(join(dir, 'dist'));

    expect(report.zhenSha.chunks).toHaveLength(1);
    expect(report.zhenSha.chunks[0]?.gzipBytes).toBe(gzipSync(chunk.contents).length);
    expect(report.zhenSha.chunks[0]?.gzipBytes).toBeGreaterThan(35 * KB);
    expect(report.zhenSha.gzipBytes).toBeGreaterThan(35 * KB);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain(chunk.name);
    expect(report.failures[0]).toContain('over the 35 KB per-game budget');
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
    const first = zhenShaChunk(20 * KB, 'a');
    const second = zhenShaChunk(20 * KB, 'b');
    const dir = makeDist({ chunks: [first, second] });
    const report = measureBudget(join(dir, 'dist'));

    expect(report.zhenSha.chunks.map((chunk) => chunk.file)).toEqual([first.name, second.name]);
    expect(report.zhenSha.gzipBytes).toBeGreaterThan(35 * KB);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain(first.name);
    expect(report.failures[0]).toContain(second.name);
    expect(report.failures[0]).toContain('over the 35 KB per-game budget');
  });

  it('passes multiple chunks whose combined gzip stays under 35 KB', () => {
    const chunks: FixtureFile[] = ['a', 'b', 'c'].map((suffix) => ({
      name: `zhen-sha-view-${suffix}.js`,
      contents: compressibleRecords(16 * KB),
    }));
    const dir = makeDist({ chunks });
    const report = measureBudget(join(dir, 'dist'));

    expect(report.zhenSha.chunks).toHaveLength(3);
    expect(report.zhenSha.gzipBytes).toBeLessThanOrEqual(35 * KB);
    expect(report.failures).toEqual([]);

    const result = runCli(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Zhen Sha view JS:');
    const perChunkGzipBytes = chunks.map((chunk) => gzipSync(chunk.contents).length);
    chunks.forEach((chunk, index) => {
      const expectedKb = `${((perChunkGzipBytes[index] ?? 0) / KB).toFixed(2)} KB`;
      expect(result.stdout).toContain(`  ${chunk.name}: ${expectedKb} gzip`);
    });
    const totalGzipBytes = perChunkGzipBytes.reduce((total, bytes) => total + bytes, 0);
    expect(result.stdout).toContain(
      `  total: ${(totalGzipBytes / KB).toFixed(2)} KB gzip (per-game budget 35 KB)`,
    );
  });

  it('rejects a non-array chunk list with BudgetError', () => {
    // Include a truthy non-array, so a weakened `if (!chunks)` guard cannot pass.
    const invalidValues: unknown[] = [null, {}, 'zhen-sha-view-a.js'];

    for (const invalid of invalidValues) {
      const chunks = invalid as ReadonlyArray<{ file: string; gzipBytes: number }>;
      expect(() => evaluateZhenShaViewChunks(chunks)).toThrowError(BudgetError);
      expect(() => evaluateZhenShaViewChunks(chunks)).toThrow(/must be an array/);
    }
  });
});

describe('existing budget gates', () => {
  it('prints the actual CSS gzip size', () => {
    const cssContents = compressibleRecords(8 * KB);
    const dir = makeDist({
      css: [{ name: 'index-abc.css', contents: cssContents }],
      chunks: [zhenShaChunk(KB)],
    });

    const result = runCli(dir);
    expect(result.status).toBe(0);
    const expectedCssKb = `${(gzipSync(cssContents).length / KB).toFixed(2)} KB`;
    expect(result.stdout).toContain(`CSS: ${expectedCssKb} gzip`);
  });

  it('fails when dist/index.html has no entry script', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><div id="app"></div>');

    expect(() => measureBudget(join(dir, 'dist'))).toThrowError(BudgetError);
    expect(() => measureBudget(join(dir, 'dist'))).toThrow(/Could not find the entry script/);

    const result = runCli(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Could not find the entry script');
  });

  it('fails when dist/assets is missing', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.html'), `<!doctype html>${ENTRY_HTML}`);

    expect(() => measureBudget(join(dir, 'dist'))).toThrowError(BudgetError);
    expect(() => measureBudget(join(dir, 'dist'))).toThrow(/dist\/assets is missing/);

    const result = runCli(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dist/assets is missing');
  });

  it('keeps the entry under 50 KB and free of engine markers', () => {
    const dir = makeDist({ entry: 'Phaser.Game;', chunks: [zhenShaChunk(KB)] });
    const report = measureBudget(join(dir, 'dist'));

    expect(report.entry.gzipBytes).toBeLessThanOrEqual(ENTRY_LIMIT);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('engine marker');

    const overEntry = makeDist({
      entry: incompressibleBytes(ENTRY_LIMIT + KB),
      chunks: [zhenShaChunk(KB)],
    });
    const overReport = measureBudget(join(overEntry, 'dist'));
    expect(overReport.entry.gzipBytes).toBeGreaterThan(ENTRY_LIMIT);
    expect(overReport.failures.some((failure) => failure.includes('50 KB budget'))).toBe(true);
  });

  it('keeps the 450 KB total JS budget', () => {
    const dir = makeDist({
      chunks: [
        zhenShaChunk(KB),
        { name: 'phaser.esm-deadbeef.js', contents: incompressibleBytes(TOTAL_JS_LIMIT) },
      ],
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
