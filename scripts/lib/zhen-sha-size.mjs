/**
 * Rolling snapshot of the zhen-sha production size.
 *
 * The historical kill-gate assessment keeps its own frozen table in
 * docs/zhen-sha-kill-gate.md. This module owns the "current production size"
 * contract instead: it measures every non-test `.ts` / `.css` source in
 * src/games/zhen-sha/ and compares them with docs/zhen-sha-production-size.json.
 * Refresh the snapshot with `npm run sync:zhen-sha-size` whenever a zhen-sha
 * engine PR changes the source tree.
 *
 * The filter matches PRODUCTION_FILES in originality.test.ts, so files that are
 * only referenced by tests (for example boss-chart-adapter.ts) still count. The
 * rolling caliber is therefore wider than the 43c9ab1 historical baseline in
 * docs/zhen-sha-kill-gate.md, which only counts the four files that shipped at
 * that commit.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Repository-relative directory that owns the zhen-sha production sources. */
export const PRODUCTION_DIR = 'src/games/zhen-sha';

/** Repository-relative path of the generated rolling snapshot. */
export const SNAPSHOT_PATH = 'docs/zhen-sha-production-size.json';

/** Command that regenerates the snapshot after an intentional size change. */
export const SYNC_COMMAND = 'npm run sync:zhen-sha-size';

/** How the measurement decides which files and lines count. */
export const MEASUREMENT_CALIBER = [
  '统计 src/games/zhen-sha/ 下所有非测试 .ts 与 .css 源文件（含仅被测试引用的文件），',
  '排除 *.test.ts、*.test.css 与 *.d.ts；',
  '行数按换行符个数计数，与 wc -l 一致。',
].join('');

/** Raised when a snapshot cannot be parsed or serialized as expected. */
export class ZhenShaSizeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZhenShaSizeError';
  }
}

/** The one command that repairs a drifted snapshot. */
function syncHint() {
  return `运行 ${SYNC_COMMAND} 重新生成 ${SNAPSHOT_PATH}`;
}

/**
 * Whether a file is a non-test source counted by the rolling snapshot.
 *
 * `.ts` / `.css` only, with test files and type declarations excluded. This is
 * the same rule as PRODUCTION_FILES in originality.test.ts, so sources that are
 * only imported by tests are included.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isProductionFile(name) {
  const extension = extname(name);
  if (extension !== '.ts' && extension !== '.css') {
    return false;
  }
  return !name.endsWith('.test.ts') && !name.endsWith('.test.css') && !name.endsWith('.d.ts');
}

/**
 * Count lines exactly the way `wc -l` does: the number of newline characters.
 *
 * @param {string} text
 * @returns {number}
 */
export function countLines(text) {
  return text.split('\n').length - 1;
}

/** Compare snapshot entries by file name, independent of the host locale. */
function compareEntries(left, right) {
  if (left.file < right.file) return -1;
  if (left.file > right.file) return 1;
  return 0;
}

/**
 * Measure the production files that currently participate in the build.
 *
 * @param {string} [root] repository root; defaults to this checkout
 * @returns {{ directory: string, files: Array<{ file: string, lines: number }>, total: number }}
 */
export function measureProductionSize(root = ROOT) {
  const directory = join(root, PRODUCTION_DIR);
  const files = readdirSync(directory)
    .filter(isProductionFile)
    .sort()
    .map((file) => ({
      file,
      lines: countLines(readFileSync(join(directory, file), 'utf8')),
    }));

  return {
    directory: PRODUCTION_DIR,
    files,
    total: files.reduce((total, entry) => total + entry.lines, 0),
  };
}

/**
 * Turn a measurement into the canonical snapshot object: stable key order,
 * stable file order and a total derived from the entries.
 *
 * @param {{ directory?: string, files: Array<{ file: string, lines: number }>, total?: number }} measurement
 * @returns {{ directory: string, caliber: string, files: Array<{ file: string, lines: number }>, total: number }}
 */
export function buildSizeSnapshot(measurement) {
  const files = measurement.files
    .map(({ file, lines }) => ({ file, lines }))
    .sort(compareEntries);

  return {
    directory: measurement.directory ?? PRODUCTION_DIR,
    caliber: MEASUREMENT_CALIBER,
    files,
    total: files.reduce((total, entry) => total + entry.lines, 0),
  };
}

/**
 * Serialize a measurement as the committed snapshot bytes.
 *
 * Always ends with a newline so a repeated sync produces identical bytes.
 *
 * @param {{ directory?: string, files: Array<{ file: string, lines: number }>, total?: number }} measurement
 * @returns {string}
 */
export function serializeSizeSnapshot(measurement) {
  return `${JSON.stringify(buildSizeSnapshot(measurement), null, 2)}\n`;
}

function requireObject(value, label, source) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ZhenShaSizeError(`${source} 的 ${label} 必须是 JSON 对象；${syncHint()}`);
  }
  return value;
}

/**
 * Parse and validate a committed snapshot.
 *
 * Structural problems throw so callers cannot silently compare against a
 * half-parsed document; semantic drift is reported by verifySizeSnapshot.
 *
 * @param {string} text
 * @param {string} [source] label used in error messages
 * @returns {{ directory: string, caliber: string, files: Array<{ file: string, lines: number }>, total: number }}
 */
export function parseSizeSnapshot(text, source = SNAPSHOT_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ZhenShaSizeError(`${source}: 不是合法的 JSON（${detail}）；${syncHint()}`);
  }

  const snapshot = requireObject(parsed, '顶层', source);
  if (typeof snapshot.directory !== 'string' || snapshot.directory === '') {
    throw new ZhenShaSizeError(`${source}: directory 必须是非空字符串；${syncHint()}`);
  }
  if (typeof snapshot.caliber !== 'string' || snapshot.caliber === '') {
    throw new ZhenShaSizeError(`${source}: caliber 必须是非空字符串；${syncHint()}`);
  }
  if (!Array.isArray(snapshot.files)) {
    throw new ZhenShaSizeError(`${source}: files 必须是数组；${syncHint()}`);
  }

  const seen = new Set();
  const files = snapshot.files.map((entry, index) => {
    const item = requireObject(entry, `files[${index}]`, source);
    if (typeof item.file !== 'string' || item.file === '') {
      throw new ZhenShaSizeError(`${source}: files[${index}].file 必须是非空字符串；${syncHint()}`);
    }
    if (seen.has(item.file)) {
      throw new ZhenShaSizeError(`${source}: files 重复列出 ${item.file}；${syncHint()}`);
    }
    seen.add(item.file);
    if (typeof item.lines !== 'number' || !Number.isInteger(item.lines) || item.lines < 0) {
      throw new ZhenShaSizeError(
        `${source}: ${item.file} 的 lines 必须是 >= 0 的整数；${syncHint()}`,
      );
    }
    return { file: item.file, lines: item.lines };
  });

  if (
    typeof snapshot.total !== 'number' ||
    !Number.isInteger(snapshot.total) ||
    snapshot.total < 0
  ) {
    throw new ZhenShaSizeError(`${source}: total 必须是 >= 0 的整数；${syncHint()}`);
  }

  return {
    directory: snapshot.directory,
    caliber: snapshot.caliber,
    files,
    total: snapshot.total,
  };
}

/**
 * Compare the committed snapshot with a fresh measurement.
 *
 * Every problem names the drifted entry and ends with the command that repairs
 * the snapshot, so a failing unit test is actionable on its own.
 *
 * @param {{ snapshotText: string, measurement?: { directory: string, files: Array<{ file: string, lines: number }>, total: number } }} options
 * @returns {{ ok: boolean, snapshot: object | null, problems: string[], hint: string }}
 */
export function verifySizeSnapshot({ snapshotText, measurement = measureProductionSize() }) {
  let snapshot;
  try {
    snapshot = parseSizeSnapshot(snapshotText);
  } catch (error) {
    return {
      ok: false,
      snapshot: null,
      problems: [error instanceof Error ? error.message : String(error)],
      hint: syncHint(),
    };
  }

  const problems = [];
  const fail = (message) => {
    problems.push(`${message}；${syncHint()}`);
  };

  if (snapshot.directory !== measurement.directory) {
    fail(`快照的目录为 ${snapshot.directory}，当前为 ${measurement.directory}`);
  }
  if (snapshot.caliber !== MEASUREMENT_CALIBER) {
    fail('快照的统计口径与当前实现不一致');
  }

  const measured = new Map(measurement.files.map((entry) => [entry.file, entry.lines]));
  const committed = new Map(snapshot.files.map((entry) => [entry.file, entry.lines]));

  for (const { file, lines } of measurement.files) {
    const expected = committed.get(file);
    if (expected === undefined) {
      fail(`快照缺少 ${file}（当前树 ${lines} 行）`);
    } else if (expected !== lines) {
      fail(`${file}: 快照 ${expected} 行，当前树 ${lines} 行`);
    }
  }

  for (const { file, lines } of snapshot.files) {
    if (!measured.has(file)) {
      fail(`快照多出 ${file}（${lines} 行，当前树中不存在）`);
    }
  }

  const committedTotal = snapshot.files.reduce((total, entry) => total + entry.lines, 0);
  if (snapshot.total !== committedTotal) {
    fail(`快照内部不一致：files 合计 ${committedTotal} 行，total 为 ${snapshot.total} 行`);
  }
  if (snapshot.total !== measurement.total) {
    fail(`合计：快照 ${snapshot.total} 行，当前树 ${measurement.total} 行`);
  }

  return { ok: problems.length === 0, snapshot, problems, hint: syncHint() };
}
