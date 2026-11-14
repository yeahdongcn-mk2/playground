export interface DocDimensionRowBase {
  line: number;
  files: string[];
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
  docWidth: number;
  docHeight: number;
  actualWidth: number | null;
  actualHeight: number | null;
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
  problems: DocDimensionProblem[];
}

export const DEFAULT_README_PATH: string;
export const DEFAULT_SCREENSHOT_DIR: string;

export class ScreenshotDocDimsError extends Error {}

export function parseDocDimensions(text: string): DocDimensionRow[];
export function parsePngDimensions(bytes: Uint8Array): PngDimensions;
export function readPngDimensions(filePath: string): PngDimensions;
export function verifyDocDimensions(options: VerifyDocDimensionsOptions): DocDimensionsReport;
