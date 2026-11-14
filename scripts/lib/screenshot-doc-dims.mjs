import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reusable validator for the sizes and complete sha256 hashes documented in
 * `docs/screenshots/README.md`.
 *
 * The README tables record committed screenshot sizes in two forms:
 *
 * - full-page rows: `整页 <width>×<height>`;
 * - viewport rows: `<cssWidth>×<cssHeight> / <width>×<height>`, where the
 *   value after the slash is the actual PNG size.
 *
 * A row may also document a complete sha256 as a backticked 64-character
 * hexadecimal value (for example
 * `` `8f903d39bb5e681ec9a59a322ab5a759c5058df6c24f6ffa44a11785ef1a8002` ``).
 * Hashes are paired with the row's files in order. Truncated hashes such as
 * `` `7232a897…` `` are documentation shorthand: they are skipped, because
 * they cannot be compared with the file content. A shorter hex value without
 * the ellipsis is treated as a possible truncation and reported only when it
 * really is a prefix of the committed file's sha256.
 *
 * This module parses only table rows that start with `|` and contain both a
 * backticked `.png` file name and one of those sizes, then reads the PNG
 * signature, IHDR width/height (bytes 16–23) and full sha256 from the
 * committed file. For viewport rows only the PNG size after the slash is
 * compared with the IHDR; the CSS viewport before the slash is kept as
 * metadata. It never runs a capture script, needs no image decoder, and does
 * not write any file, so it can check the repository offline.
 */

export const DEFAULT_README_PATH = 'docs/screenshots/README.md';
export const DEFAULT_SCREENSHOT_DIR = 'docs/screenshots';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_SIGNATURE_LENGTH = PNG_SIGNATURE.length;

/** Offset of the IHDR data inside a PNG: 8-byte signature + chunk header. */
const IHDR_DATA_OFFSET = 16;
/** A complete IHDR width/height needs the signature, chunk header and 8 bytes. */
const MIN_PNG_SIZE = IHDR_DATA_OFFSET + 8;

const FULL_PAGE_SIZE = /整页\s+(\d+)×(\d+)/;
const VIEWPORT_SIZE = /(\d+)×(\d+)\s*\/\s*(\d+)×(\d+)/;
const BACKTICK_PNG = /`([^`\n]+\.png)`/g;
/** Only a complete 64-character hex hash is comparable with the file bytes. */
const BACKTICK_SHA256 = /`([0-9a-fA-F]{64})`/g;
/**
 * Unmarked shorter hex values are treated as possible truncated hashes. A
 * trailing ellipsis (as in `7232a897…`) marks documentation shorthand instead,
 * so it does not match this pattern and is skipped.
 */
const BACKTICK_SHA256_TRUNCATED = /`([0-9a-fA-F]{8,63})`/g;

/** Raised when a file cannot be read as a PNG with a complete IHDR. */
export class ScreenshotDocDimsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScreenshotDocDimsError';
  }
}

/**
 * Extract the documented sizes and complete sha256 hashes from Markdown table
 * rows.
 *
 * Body text that mentions a size outside a table row is ignored, as are table
 * rows without a backticked `.png` file name or without a recognised size. A
 * row may list several files in one cell; each file is recorded under the same
 * row so the verifier can check them one by one. Complete backticked 64-hex
 * hashes are recorded in the same order and paired with the files by position.
 * Shorter hex values without an ellipsis are recorded as possible truncations;
 * the verifier only reports one when it is a prefix of the file's actual hash,
 * so unrelated short hex values (commit prefixes, colours) are ignored.
 * A full-page size takes precedence over a viewport size in the same row, so a
 * row is never counted twice.
 *
 * @returns {Array<
 *   | {
 *       line: number,
 *       kind: 'full-page',
 *       files: string[],
 *       hashes: string[],
 *       truncatedHashes: string[],
 *       width: number,
 *       height: number,
 *     }
 *   | {
 *       line: number,
 *       kind: 'viewport',
 *       files: string[],
 *       hashes: string[],
 *       truncatedHashes: string[],
 *       viewportWidth: number,
 *       viewportHeight: number,
 *       width: number,
 *       height: number,
 *     }
 * >}
 */
export function parseDocDimensions(text) {
  const rows = [];
  const lines = String(text).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !line.startsWith('|')) continue;

    // The documented size must live in a table cell, not merely in the row
    // text; split on the cell separators before matching.
    const cells = line.split('|');
    const fullPageCell = cells.find((cell) => FULL_PAGE_SIZE.test(cell));
    const viewportCell =
      fullPageCell === undefined
        ? cells.find((cell) => VIEWPORT_SIZE.test(cell))
        : undefined;
    if (fullPageCell === undefined && viewportCell === undefined) continue;

    const files = [];
    const seen = new Set();
    for (const match of line.matchAll(BACKTICK_PNG)) {
      const file = match[1];
      if (file === undefined || file === '' || seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
    if (files.length === 0) continue;

    const hashes = [];
    for (const match of line.matchAll(BACKTICK_SHA256)) {
      const hash = match[1];
      if (hash === undefined) continue;
      hashes.push(hash.toLowerCase());
    }

    const truncatedHashes = [];
    for (const match of line.matchAll(BACKTICK_SHA256_TRUNCATED)) {
      const hash = match[1];
      if (hash === undefined) continue;
      truncatedHashes.push(hash.toLowerCase());
    }

    if (fullPageCell !== undefined) {
      const size = FULL_PAGE_SIZE.exec(fullPageCell);
      if (size === null) continue;
      rows.push({
        line: index + 1,
        kind: 'full-page',
        files,
        hashes,
        truncatedHashes,
        width: Number(size[1]),
        height: Number(size[2]),
      });
      continue;
    }

    const size = VIEWPORT_SIZE.exec(viewportCell);
    if (size === null) continue;
    rows.push({
      line: index + 1,
      kind: 'viewport',
      files,
      hashes,
      truncatedHashes,
      viewportWidth: Number(size[1]),
      viewportHeight: Number(size[2]),
      width: Number(size[3]),
      height: Number(size[4]),
    });
  }

  return rows;
}

/**
 * Read the size from complete PNG bytes without decoding the image.
 *
 * Rejects a file that does not start with the PNG signature and a file
 * truncated before bytes 16–23 (the IHDR width and height) are complete.
 */
export function parsePngDimensions(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  if (
    buffer.length < PNG_SIGNATURE_LENGTH ||
    !buffer.subarray(0, PNG_SIGNATURE_LENGTH).equals(PNG_SIGNATURE)
  ) {
    throw new ScreenshotDocDimsError('PNG 签名错误：缺少 8 字节 PNG 签名');
  }

  if (buffer.length < MIN_PNG_SIZE) {
    throw new ScreenshotDocDimsError(
      `IHDR 截断：文件仅 ${buffer.length} 字节，无法读取 16–23 字节的宽高`,
    );
  }

  if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ScreenshotDocDimsError('IHDR 无效：首个 chunk 不是 13 字节的 IHDR');
  }

  const width = buffer.readUInt32BE(IHDR_DATA_OFFSET);
  const height = buffer.readUInt32BE(IHDR_DATA_OFFSET + 4);
  if (width === 0 || height === 0) {
    throw new ScreenshotDocDimsError(`IHDR 无效：宽高为 ${width}×${height}`);
  }

  return { width, height };
}

/** Read a PNG file and return its IHDR pixel size. */
export function readPngDimensions(filePath) {
  return parsePngDimensions(readFileSync(filePath));
}

function readErrorReason(error, filePath) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT') return `PNG 文件缺失：${filePath}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Verify every documented size and complete sha256 against the committed PNG
 * bytes.
 *
 * Full-page rows compare the documented full-page size with the IHDR size;
 * viewport rows compare the PNG size after the slash. The CSS viewport before
 * the slash is not derived from the PNG because it can differ by the device
 * pixel ratio. A row that documents a complete sha256 also gets its file
 * hashed and compared; an unmarked shorter hash is reported only when it is a
 * prefix of the actual hash, which catches a truncated full hash while
 * ignoring commit prefixes and other short hex values. Explicit shorthand with
 * a trailing ellipsis (for example `` `7232a897…` ``) is never collected by
 * `parseDocDimensions`, so it produces no hash problem.
 *
 * Each file is read once per row, so a row that documents both a size and a
 * complete hash reports both problems in a single pass.
 *
 * @returns {{
 *   rows: number,
 *   files: number,
 *   fullPageRows: number,
 *   viewportRows: number,
 *   sha256Files: number,
 *   problems: Array<{
 *     readmeLine: number,
 *     file: string,
 *     kind: 'full-page' | 'viewport',
 *     check: 'size' | 'sha256',
 *     docWidth: number,
 *     docHeight: number,
 *     actualWidth: number | null,
 *     actualHeight: number | null,
 *     docSha256: string | null,
 *     actualSha256: string | null,
 *     reason: string,
 *   }>,
 * }}
 */
export function verifyDocDimensions({ readmeText, dir = DEFAULT_SCREENSHOT_DIR }) {
  const rows = parseDocDimensions(readmeText);
  const problems = [];
  let files = 0;
  let fullPageRows = 0;
  let viewportRows = 0;
  let sha256Files = 0;

  for (const row of rows) {
    if (row.kind === 'full-page') {
      fullPageRows += 1;
    } else {
      viewportRows += 1;
    }

    for (const [index, file] of row.files.entries()) {
      files += 1;
      const filePath = join(dir, file);
      const docSha256 = row.hashes[index] ?? null;
      if (docSha256 !== null) sha256Files += 1;

      // With a single file, every unmarked short hash in the row could be its
      // truncation; with several files, keep the positional pairing.
      const truncatedHashes =
        row.files.length === 1
          ? row.truncatedHashes
          : row.truncatedHashes[index] === undefined
            ? []
            : [row.truncatedHashes[index]];

      let bytes;
      try {
        bytes = readFileSync(filePath);
      } catch (error) {
        problems.push({
          readmeLine: row.line,
          file,
          kind: row.kind,
          check: 'size',
          docWidth: row.width,
          docHeight: row.height,
          actualWidth: null,
          actualHeight: null,
          docSha256,
          actualSha256: null,
          reason: readErrorReason(error, filePath),
        });
        continue;
      }

      let actual;
      try {
        actual = parsePngDimensions(bytes);
      } catch (error) {
        problems.push({
          readmeLine: row.line,
          file,
          kind: row.kind,
          check: 'size',
          docWidth: row.width,
          docHeight: row.height,
          actualWidth: null,
          actualHeight: null,
          docSha256,
          actualSha256: null,
          reason: readErrorReason(error, filePath),
        });
        continue;
      }

      const actualSha256 =
        docSha256 === null && truncatedHashes.length === 0
          ? null
          : createHash('sha256').update(bytes).digest('hex');

      if (actual.width !== row.width || actual.height !== row.height) {
        problems.push({
          readmeLine: row.line,
          file,
          kind: row.kind,
          check: 'size',
          docWidth: row.width,
          docHeight: row.height,
          actualWidth: actual.width,
          actualHeight: actual.height,
          docSha256,
          actualSha256,
          reason: '尺寸不一致',
        });
      }

      if (docSha256 !== null && docSha256 !== actualSha256) {
        problems.push({
          readmeLine: row.line,
          file,
          kind: row.kind,
          check: 'sha256',
          docWidth: row.width,
          docHeight: row.height,
          actualWidth: actual.width,
          actualHeight: actual.height,
          docSha256,
          actualSha256,
          reason: 'sha256 不一致',
        });
      }

      for (const truncated of truncatedHashes) {
        if (actualSha256 === null || !actualSha256.startsWith(truncated)) continue;
        problems.push({
          readmeLine: row.line,
          file,
          kind: row.kind,
          check: 'sha256',
          docWidth: row.width,
          docHeight: row.height,
          actualWidth: actual.width,
          actualHeight: actual.height,
          docSha256: truncated,
          actualSha256,
          reason: `sha256 截断：文档 ${truncated.length} 位，实际 64 位`,
        });
      }
    }
  }

  return { rows: rows.length, files, fullPageRows, viewportRows, sha256Files, problems };
}
