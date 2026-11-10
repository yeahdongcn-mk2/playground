export interface DocDimensionRow {
  line: number;
  files: string[];
  width: number;
  height: number;
}

export interface PngDimensions {
  width: number;
  height: number;
}

export interface DocDimensionProblem {
  readmeLine: number;
  file: string;
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
  problems: DocDimensionProblem[];
}

export const DEFAULT_README_PATH: string;
export const DEFAULT_SCREENSHOT_DIR: string;

export class ScreenshotDocDimsError extends Error {}

export function parseDocDimensions(text: string): DocDimensionRow[];
export function parsePngDimensions(bytes: Uint8Array): PngDimensions;
export function readPngDimensions(filePath: string): PngDimensions;
export function verifyDocDimensions(options: VerifyDocDimensionsOptions): DocDimensionsReport;
