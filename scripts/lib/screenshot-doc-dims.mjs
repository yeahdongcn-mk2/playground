import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reusable validator for the sizes and sha256 hashes documented in
 * `docs/screenshots/README.md`.
 *
 * The README tables record committed screenshot sizes in two forms:
 *
 * - full-page rows: `整页 <width>×<height>`;
 * - viewport rows: `<cssWidth>×<cssHeight> / <width>×<height>`, where the
 *   value after the slash is the actual PNG size.
 *
 * A row may also document sha256 hashes as backticked hexadecimal values. A
 * complete 64-character value (for example
 * `` `8f903d39bb5e681ec9a59a322ab5a759c5058df6c24f6ffa44a11785ef1a8002` ``)
 * is compared with the file bytes. Hash slots are paired with the row's files
 * in order (one slot per file); a shorter 8–63 character value without an
 * ellipsis is a possible truncated hash and is reported only when it really is
 * a prefix of the committed file's sha256. An ellipsis shorthand such as
 * `` `7232a897…` `` occupies a slot without a value, so it neither shifts later
 * hashes nor produces a problem.
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
/**
 * A backticked 8–64-character hex value. A 64-character value is a complete
 * sha256; a shorter value without a trailing ellipsis is a possible truncated
 * hash. A trailing `…` (or `...`, as in `7232a897…`) marks documentation
 * shorthand: the slot is kept but holds no value, so hashes that follow stay
 * aligned with their files.
 */
const BACKTICK_HASH = /`([0-9a-fA-F]{8,64})(…|\.{3})?`/g;

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
 * row so the verifier can check them one by one. Hash slots are read from the
 * row's last table cell (the sha256 / capture-command column) and aligned with
 * the files by position: one slot per file, `hashes[index]` belongs to
 * `files[index]`. When that cell carries extra hash-like tokens (for example a
 * commit prefix before the documented hash), the trailing slots are the ones
 * that line up with the files. A slot is a complete 64-hex sha256, a shorter
 * hex value without an ellipsis (a possible truncation), or `null` for ellipsis
 * shorthand and for files without a documented hash. A row that documents only
 * some files' hashes must use the `…` placeholder for the others. The verifier
 * only reports a short value when it is a prefix of that file's actual hash, so
 * unrelated short hex values (commit prefixes, colours) are ignored.
 * A full-page size takes precedence over a viewport size in the same row, so a
 * row is never counted twice.
 *
 * @returns {Array<
 *   | {
 *       line: number,
 *       kind: 'full-page',
 *       files: string[],
 *       hashes: Array<string | null>,
 *       width: number,
 *       height: number,
 *     }
 *   | {
 *       line: number,
 *       kind: 'viewport',
 *       files: string[],
 *       hashes: Array<string | null>,
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

    // Read hash slots from the last table cell (sha256 / capture command) and
    // align them with the files. A `…` shorthand keeps its slot as `null` so it
    // does not shift the hashes after it onto the wrong file. When the cell
    // carries more hash-like tokens than files, the trailing slots are the
    // documented hashes, so a leading commit prefix cannot shadow them.
    const hashCell = cells.findLast((cell) => cell.trim() !== '') ?? '';
    const documentedHashes = [];
    for (const match of hashCell.matchAll(BACKTICK_HASH)) {
      const hash = match[1];
      if (hash === undefined) continue;
      // A 64-character value is complete even if someone appends an ellipsis;
      // a shorter value with an ellipsis is documentation shorthand.
      documentedHashes.push(
        match[2] === undefined || hash.length === 64 ? hash.toLowerCase() : null,
      );
    }
    const alignedHashes =
      documentedHashes.length > files.length
        ? documentedHashes.slice(documentedHashes.length - files.length)
        : documentedHashes;
    const hashes = files.map((_, fileIndex) => alignedHashes[fileIndex] ?? null);

    if (fullPageCell !== undefined) {
      const size = FULL_PAGE_SIZE.exec(fullPageCell);
      if (size === null) continue;
      rows.push({
        line: index + 1,
        kind: 'full-page',
        files,
        hashes,
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
 * pixel ratio. Hash slots are paired with files by position, so a row with
 * several files checks each file against its own hash: a complete 64-hex slot
 * is compared with the file's sha256, and a shorter slot is reported only when
 * it is a prefix of that file's actual sha256 (a truncated full hash). An
 * ellipsis shorthand (for example `` `7232a897…` ``) is parsed as an empty
 * slot and therefore produces no hash problem.
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
      // One slot per file: complete hash, possible truncation, or nothing.
      const documentedHash = row.hashes[index] ?? null;
      const completeHash =
        documentedHash !== null && documentedHash.length === 64 ? documentedHash : null;
      const truncatedHash =
        documentedHash !== null && documentedHash.length < 64 ? documentedHash : null;
      if (completeHash !== null) sha256Files += 1;

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
          docSha256: completeHash,
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
          docSha256: completeHash,
          actualSha256: null,
          reason: readErrorReason(error, filePath),
        });
        continue;
      }

      const actualSha256 =
        documentedHash === null
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
          docSha256: completeHash,
          actualSha256,
          reason: '尺寸不一致',
        });
      }

      if (completeHash !== null && completeHash !== actualSha256) {
        problems.push({
          readmeLine: row.line,
          file,
          kind: row.kind,
          check: 'sha256',
          docWidth: row.width,
          docHeight: row.height,
          actualWidth: actual.width,
          actualHeight: actual.height,
          docSha256: completeHash,
          actualSha256,
          reason: 'sha256 不一致',
        });
      }

      if (
        truncatedHash !== null &&
        actualSha256 !== null &&
        actualSha256.startsWith(truncatedHash)
      ) {
        problems.push({
          readmeLine: row.line,
          file,
          kind: row.kind,
          check: 'sha256',
          docWidth: row.width,
          docHeight: row.height,
          actualWidth: actual.width,
          actualHeight: actual.height,
          docSha256: truncatedHash,
          actualSha256,
          reason: `sha256 截断：文档 ${truncatedHash.length} 位，实际 64 位`,
        });
      }
    }
  }

  return { rows: rows.length, files, fullPageRows, viewportRows, sha256Files, problems };
}
