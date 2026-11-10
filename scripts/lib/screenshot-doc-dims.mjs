import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reusable validator for the full-page dimensions documented in
 * `docs/screenshots/README.md`.
 *
 * The README tables record the committed full-page size of each screenshot as
 * `整页 <width>×<height>`. This module parses only table rows that start with
 * `|` and contain both a backticked `.png` file name and such a size, then
 * reads the PNG signature and IHDR width/height (bytes 16–23) from the
 * committed file. It never runs a capture script, needs no image decoder, and
 * does not write any file, so it can check the repository offline.
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
const BACKTICK_PNG = /`([^`\n]+\.png)`/g;

/** Raised when a file cannot be read as a PNG with a complete IHDR. */
export class ScreenshotDocDimsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScreenshotDocDimsError';
  }
}

/**
 * Extract the documented full-page sizes from Markdown table rows.
 *
 * Body text that mentions `整页 W×H` outside a table row is ignored, as are
 * table rows without a backticked `.png` file name or without a full-page
 * size. A row may list several files in one cell; each file is recorded under
 * the same row so the verifier can check them one by one.
 *
 * @returns {Array<{ line: number, files: string[], width: number, height: number }>}
 */
export function parseDocDimensions(text) {
  const rows = [];
  const lines = String(text).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !line.startsWith('|')) continue;

    // The documented size must live in a table cell, not merely in the row
    // text; split on the cell separators before matching.
    const dimensionCell = line.split('|').find((cell) => FULL_PAGE_SIZE.test(cell));
    if (dimensionCell === undefined) continue;
    const size = FULL_PAGE_SIZE.exec(dimensionCell);
    if (size === null) continue;

    const files = [];
    const seen = new Set();
    for (const match of line.matchAll(BACKTICK_PNG)) {
      const file = match[1];
      if (file === undefined || file === '' || seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
    if (files.length === 0) continue;

    rows.push({
      line: index + 1,
      files,
      width: Number(size[1]),
      height: Number(size[2]),
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
 * Verify every documented full-page size against the committed PNG bytes.
 *
 * @returns {{
 *   rows: number,
 *   files: number,
 *   problems: Array<{
 *     readmeLine: number,
 *     file: string,
 *     docWidth: number,
 *     docHeight: number,
 *     actualWidth: number | null,
 *     actualHeight: number | null,
 *     reason: string,
 *   }>,
 * }}
 */
export function verifyDocDimensions({ readmeText, dir = DEFAULT_SCREENSHOT_DIR }) {
  const rows = parseDocDimensions(readmeText);
  const problems = [];
  let files = 0;

  for (const row of rows) {
    for (const file of row.files) {
      files += 1;
      const filePath = join(dir, file);

      let actual;
      try {
        actual = readPngDimensions(filePath);
      } catch (error) {
        problems.push({
          readmeLine: row.line,
          file,
          docWidth: row.width,
          docHeight: row.height,
          actualWidth: null,
          actualHeight: null,
          reason: readErrorReason(error, filePath),
        });
        continue;
      }

      if (actual.width !== row.width || actual.height !== row.height) {
        problems.push({
          readmeLine: row.line,
          file,
          docWidth: row.width,
          docHeight: row.height,
          actualWidth: actual.width,
          actualHeight: actual.height,
          reason: '尺寸不一致',
        });
      }
    }
  }

  return { rows: rows.length, files, problems };
}
