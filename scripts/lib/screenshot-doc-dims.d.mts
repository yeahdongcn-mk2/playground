export interface DocDimensionRowBase {
  line: number;
  files: string[];
  /**
   * One hash slot per file, aligned with `files` by index: a complete 64-hex
   * sha256 (lower-cased), an 8–63-character hex prefix treated as a possible
   * truncated hash, or null for a file without a documented hash (including the
   * `…` / `...` shorthand). Slots are read from the row's last table cell; when
   * that cell carries extra hash-like tokens, the trailing slots are used. A
   * short value is only reported when it is a prefix of that file's actual
   * sha256.
   */
  hashes: Array<string | null>;
  /** Documented PNG size: either the full-page size or the value after `/`. */
  width: number;
  height: number;
}

export interface DocFullPageDimensionRow extends DocDimensionRowBase {
  kind: 'full-page';
}

export interface DocViewportDimensionRow extends DocDimensionRowBase {
  kind: 'viewport';
  /** CSS viewport size before the slash; not compared with the IHDR size. */
  viewportWidth: number;
  viewportHeight: number;
}

export type DocDimensionRow = DocFullPageDimensionRow | DocViewportDimensionRow;

export interface PngDimensions {
  width: number;
  height: number;
}

export interface DocDimensionProblem {
  readmeLine: number;
  file: string;
  kind: 'full-page' | 'viewport';
  /** Which check failed; size and sha256 can both fail for the same file. */
  check: 'size' | 'sha256';
  docWidth: number;
  docHeight: number;
  actualWidth: number | null;
  actualHeight: number | null;
  /**
   * Documented sha256 on a `sha256` problem: the complete hash, or the
   * truncated prefix when only a short value was documented. On size / read
   * problems it is the complete documented hash, or null when none was.
   */
  docSha256: string | null;
  /** Actual sha256 when it was computed, or null when the file could not be read. */
  actualSha256: string | null;
  reason: string;
}

export interface VerifyDocDimensionsOptions {
  readmeText: string;
  dir?: string;
}

export interface DocDimensionsReport {
  rows: number;
  files: number;
  fullPageRows: number;
  viewportRows: number;
  /** Files whose row documents a complete sha256. */
  sha256Files: number;
  problems: DocDimensionProblem[];
}

export const DEFAULT_README_PATH: string;
export const DEFAULT_SCREENSHOT_DIR: string;

export class ScreenshotDocDimsError extends Error {}

export function parseDocDimensions(text: string): DocDimensionRow[];
export function parsePngDimensions(bytes: Uint8Array): PngDimensions;
export function readPngDimensions(filePath: string): PngDimensions;
export function verifyDocDimensions(options: VerifyDocDimensionsOptions): DocDimensionsReport;
