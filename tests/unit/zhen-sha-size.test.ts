import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MEASUREMENT_CALIBER,
  PRODUCTION_DIR,
  SNAPSHOT_PATH,
  SYNC_COMMAND,
  buildSizeSnapshot,
  countLines,
  isProductionFile,
  measureProductionSize,
  parseSizeSnapshot,
  serializeSizeSnapshot,
  verifySizeSnapshot,
} from '../../scripts/lib/zhen-sha-size.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT_FILE = join(ROOT, SNAPSHOT_PATH);
const CLI = join(ROOT, 'scripts', 'sync-zhen-sha-size.mjs');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zhen-sha-size-'));
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

/** Create a minimal production tree under `<root>/src/games/zhen-sha/`. */
function writeProductionFixture(root: string, files: Record<string, string>): void {
  const directory = join(root, PRODUCTION_DIR);
  mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents, 'utf8');
  }
}

function readSnapshotText(): string {
  return readFileSync(SNAPSHOT_FILE, 'utf8');
}

describe('zhen-sha production size snapshot', () => {
  it('keeps the committed snapshot in sync with the current production tree', () => {
    const measurement = measureProductionSize(ROOT);
    const verification = verifySizeSnapshot({ snapshotText: readSnapshotText(), measurement });

    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
    expect(verification.snapshot?.directory).toBe(PRODUCTION_DIR);
    expect(verification.snapshot?.caliber).toBe(MEASUREMENT_CALIBER);
    expect(verification.snapshot?.files).toEqual(measurement.files);
    expect(verification.snapshot?.total).toBe(measurement.total);
    expect(measurement.files.length).toBeGreaterThan(0);
  });

  it('excludes tests, type declarations and non-build files from the measurement', () => {
    const root = makeTempDir();
    writeProductionFixture(root, {
      'engine.ts': 'one\ntwo\nthree\n',
      'zhen-sha.css': 'one\ntwo\n',
      'engine.test.ts': 'one\ntwo\nthree\nfour\n',
      'style.test.css': 'one\n',
      'types.d.ts': 'one\n',
      'notes.md': 'one\n',
    });

    expect(countLines('one\ntwo\nthree\n')).toBe(3);
    // `wc -l` counts newline characters, so a missing trailing newline is not a line.
    expect(countLines('one\ntwo\nthree')).toBe(2);
    expect(isProductionFile('engine.test.ts')).toBe(false);
    expect(isProductionFile('style.test.css')).toBe(false);
    expect(isProductionFile('types.d.ts')).toBe(false);
    expect(isProductionFile('notes.md')).toBe(false);

    const measurement = measureProductionSize(root);
    expect(measurement.files).toEqual([
      { file: 'engine.ts', lines: 3 },
      { file: 'zhen-sha.css', lines: 2 },
    ]);
    expect(measurement.total).toBe(5);
  });

  it('reports a drifted line count with the command that refreshes the snapshot', () => {
    const measurement = measureProductionSize(ROOT);
    const tampered = parseSizeSnapshot(readSnapshotText());
    const first = tampered.files[0];
    if (first === undefined) {
      throw new Error('the committed snapshot should not be empty');
    }
    first.lines += 1;
    tampered.total = tampered.files.reduce((total, entry) => total + entry.lines, 0);

    const verification = verifySizeSnapshot({
      snapshotText: JSON.stringify(tampered, null, 2),
      measurement,
    });

    expect(verification.ok).toBe(false);
    const problems = verification.problems.join('\n');
    expect(problems).toContain(first.file);
    expect(problems).toContain(`快照 ${first.lines} 行`);
    expect(problems).toContain(`当前树 ${measurement.files[0]?.lines} 行`);
    expect(problems).not.toContain('快照缺少');
    expect(problems).toContain(SYNC_COMMAND);
  });

  it('reports a file missing from a tampered snapshot', () => {
    const measurement = measureProductionSize(ROOT);
    const tampered = parseSizeSnapshot(readSnapshotText());
    const removed = tampered.files[0];
    if (removed === undefined) {
      throw new Error('the committed snapshot should not be empty');
    }
    tampered.files = tampered.files.slice(1);
    tampered.total -= removed.lines;

    const verification = verifySizeSnapshot({
      snapshotText: JSON.stringify(tampered, null, 2),
      measurement,
    });

    expect(verification.ok).toBe(false);
    expect(verification.problems.join('\n')).toContain(`快照缺少 ${removed.file}`);
    expect(verification.problems.join('\n')).toContain(SYNC_COMMAND);
  });

  it('rejects a malformed snapshot with an actionable error', () => {
    const verification = verifySizeSnapshot({
      snapshotText: '{not json',
      measurement: measureProductionSize(ROOT),
    });

    expect(verification.ok).toBe(false);
    expect(verification.snapshot).toBeNull();
    expect(verification.problems).toHaveLength(1);
    expect(verification.problems[0]).toContain('JSON');
    expect(verification.problems[0]).toContain(SYNC_COMMAND);
  });

  it('serializes a stable snapshot and derives the total from the file entries', () => {
    const measurement = measureProductionSize(ROOT);
    const once = serializeSizeSnapshot(measurement);
    const twice = serializeSizeSnapshot(measurement);

    expect(twice).toBe(once);
    expect(once.endsWith('\n')).toBe(true);
    expect(parseSizeSnapshot(twice)).toEqual(parseSizeSnapshot(once));

    const unsorted = {
      directory: PRODUCTION_DIR,
      files: [
        { file: 'zhen-sha.css', lines: 2 },
        { file: 'engine.ts', lines: 3 },
      ],
      total: 5,
    };
    expect(buildSizeSnapshot(unsorted).files.map((entry) => entry.file)).toEqual([
      'engine.ts',
      'zhen-sha.css',
    ]);
    expect(serializeSizeSnapshot(unsorted)).toBe(
      serializeSizeSnapshot({ ...unsorted, files: [...unsorted.files].reverse() }),
    );
  });

  it('writes the snapshot once and leaves the bytes unchanged on a second run', () => {
    const root = makeTempDir();
    writeProductionFixture(root, {
      'engine.ts': 'one\ntwo\n',
      'view.css': 'one\n',
    });
    mkdirSync(join(root, 'docs'), { recursive: true });

    const first = spawnSync(process.execPath, [CLI], { cwd: root, encoding: 'utf8' });
    expect(first.status, first.stderr).toBe(0);
    const firstBytes = readFileSync(join(root, SNAPSHOT_PATH), 'utf8');
    expect(firstBytes).toBe(serializeSizeSnapshot(measureProductionSize(root)));
    expect(parseSizeSnapshot(firstBytes).files).toEqual([
      { file: 'engine.ts', lines: 2 },
      { file: 'view.css', lines: 1 },
    ]);

    const second = spawnSync(process.execPath, [CLI], { cwd: root, encoding: 'utf8' });
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(join(root, SNAPSHOT_PATH), 'utf8')).toBe(firstBytes);
    expect(second.stdout).toContain('已是最新');
  });
});
