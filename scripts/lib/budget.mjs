/**
 * Gzip budget measurement shared by `scripts/check-budget.mjs` and the unit
 * tests.
 *
 * Every measured file is compressed with `node:zlib`'s `gzipSync` at its
 * default level (6): the entry script, each JS chunk and the zhen-sha view
 * chunk all use the same calculation. Vite prints its own gzip column during
 * `vite build`, but that number uses a different level and is never used as
 * gate input.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** Gzip budget for the entry script loaded by the shell. */
export const ENTRY_LIMIT = 50 * 1024;
/** Gzip budget for every JS chunk in `dist/assets`. */
export const TOTAL_JS_LIMIT = 450 * 1024;
/** Gzip budget for the lazily loaded zhen-sha view chunk. */
export const PER_GAME_LIMIT = 35 * 1024;

/** Matches the hashed zhen-sha view chunk emitted by Vite. */
export const ZHEN_SHA_VIEW_CHUNK = /^zhen-sha-view-.*\.js$/;

/** Expressions that must not reach the shell entry bundle. */
export const ENGINE_MARKERS = [/\bPhaser\.(?:Game|Scene|AUTO)\b/, /\bTHREE\./];

/** Raised when the build output cannot be measured at all. */
export class BudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetError';
  }
}

/** Gzip byte count for one file's contents, using the shared default level. */
export function gzipBytes(contents) {
  return gzipSync(contents).length;
}

/** Gzip size formatted the way the CLI has always printed it. */
export function formatGzipKb(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

/** Sorted zhen-sha view chunks among the `dist/assets` file names. */
export function findZhenShaViewChunks(files) {
  return files.filter((file) => ZHEN_SHA_VIEW_CHUNK.test(file)).sort();
}

function describeChunks(chunks) {
  return chunks
    .map((chunk) => `${chunk.file} ${formatGzipKb(chunk.gzipBytes)}`)
    .join(' + ');
}

/**
 * Judge the zhen-sha view chunk(s) against the 35 KB per-game budget.
 *
 * A missing chunk is a failure instead of a silent pass: an empty match means
 * the build output is stale or the chunk name changed. Several matching chunks
 * are listed in full and judged by their combined gzip size, so a split chunk
 * cannot dodge the gate by only checking the first file.
 *
 * @param {Array<{ file: string, gzipBytes: number }>} chunks
 * @returns {{ totalGzipBytes: number, failures: string[] }}
 */
export function evaluateZhenShaViewChunks(chunks) {
  if (!Array.isArray(chunks)) {
    throw new BudgetError('zhen-sha view chunks must be an array');
  }

  if (chunks.length === 0) {
    return {
      totalGzipBytes: 0,
      failures: [
        'no dist/assets/zhen-sha-view-*.js chunk found; run `npm run build` first so the 35 KB per-game budget can measure the zhen-sha view chunk',
      ],
    };
  }

  const totalGzipBytes = chunks.reduce((total, chunk) => total + chunk.gzipBytes, 0);
  const failures = [];

  if (totalGzipBytes > PER_GAME_LIMIT) {
    const detail =
      chunks.length === 1
        ? `${chunks[0].file} is ${formatGzipKb(totalGzipBytes)} gzip`
        : `zhen-sha-view chunks total ${formatGzipKb(totalGzipBytes)} gzip (${describeChunks(chunks)})`;
    failures.push(`${detail}, over the 35 KB per-game budget`);
  }

  return { totalGzipBytes, failures };
}

function readGzipEntry(path, file) {
  const contents = readFileSync(path);
  return { file, bytes: contents.length, gzipBytes: gzipBytes(contents) };
}

/**
 * Measure a production build directory against every gzip budget.
 *
 * `dist/index.html` missing is fatal (the caller has not built yet). A stale or
 * renamed zhen-sha chunk is reported through `failures` so the CLI prints it in
 * the usual "Budget check failed" block and exits non-zero.
 *
 * @param {string} [distDir]
 */
export function measureBudget(distDir = 'dist') {
  const indexPath = join(distDir, 'index.html');
  if (!existsSync(indexPath)) {
    throw new BudgetError(`dist/index.html is missing; run \`npm run build\` first.`);
  }

  const html = readFileSync(indexPath, 'utf8');
  const entrySrc = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
  if (!entrySrc) {
    throw new BudgetError('Could not find the entry script in dist/index.html.');
  }

  const assetsDir = join(distDir, 'assets');
  if (!existsSync(assetsDir)) {
    throw new BudgetError('dist/assets is missing; run `npm run build` first.');
  }

  const entryContents = readFileSync(join(distDir, entrySrc.replace(/^\//, '')));
  const entry = {
    file: entrySrc,
    bytes: entryContents.length,
    gzipBytes: gzipBytes(entryContents),
  };
  const failures = [];

  if (entry.gzipBytes > ENTRY_LIMIT) {
    failures.push(
      `entry JS is ${formatGzipKb(entry.gzipBytes)} gzip, over the 50 KB budget`,
    );
  }
  const entryText = entryContents.toString('utf8');
  for (const marker of ENGINE_MARKERS) {
    if (marker.test(entryText)) {
      failures.push(`entry JS contains engine marker ${marker}`);
    }
  }

  const assetFiles = readdirSync(assetsDir);
  const jsFiles = assetFiles.filter((file) => file.endsWith('.js')).sort();
  const allJsGzipBytes = jsFiles.reduce(
    (total, file) => total + readGzipEntry(join(assetsDir, file), file).gzipBytes,
    0,
  );
  if (allJsGzipBytes > TOTAL_JS_LIMIT) {
    failures.push(
      `all JS chunks are ${formatGzipKb(allJsGzipBytes)} gzip, over the 450 KB 2D budget`,
    );
  }

  const cssFiles = assetFiles.filter((file) => file.endsWith('.css')).sort();
  const cssGzipBytes = cssFiles.reduce(
    (total, file) => total + readGzipEntry(join(assetsDir, file), file).gzipBytes,
    0,
  );

  const zhenShaChunks = findZhenShaViewChunks(assetFiles).map((file) =>
    readGzipEntry(join(assetsDir, file), file),
  );
  const zhenSha = evaluateZhenShaViewChunks(zhenShaChunks);
  failures.push(...zhenSha.failures);

  return {
    entry,
    allJs: { files: jsFiles, gzipBytes: allJsGzipBytes },
    cssGzipBytes,
    zhenSha: { chunks: zhenShaChunks, gzipBytes: zhenSha.totalGzipBytes },
    failures,
  };
}
