export interface ScreenshotViewport {
  width: number;
  height: number;
}

export interface ScreenshotArtifact {
  file: string;
  viewport: ScreenshotViewport;
  narrow?: boolean;
  /** Pinned pixel height for a full-page capture whose content height varies. */
  fullPagePixelHeight?: number;
}

export interface ArtifactProblem {
  file: string;
  message: string;
}

export interface CaptureLogRecord {
  file: string;
  engine: string;
  viewport: ScreenshotViewport;
  line: string;
}

export interface VerifyScreenshotArtifactsOptions {
  dir?: string;
  manifest?: readonly ScreenshotArtifact[];
  deviceScaleFactor?: number;
  logText?: string;
}

export interface ScreenshotArtifactReport {
  artifacts: number;
  problems: ArtifactProblem[];
}

export const WEBKIT_DEVICE_SCALE_FACTOR: number;
export const DEFAULT_SCREENSHOT_DIR: string;
export const WEBKIT_SCREENSHOT_ARTIFACTS: readonly ScreenshotArtifact[];

export class ScreenshotArtifactError extends Error {}

export function parsePng(bytes: Uint8Array): ScreenshotViewport;
export function readPngSize(filePath: string): ScreenshotViewport;
export function expectedPixelSize(
  artifact: ScreenshotArtifact,
  deviceScaleFactor?: number,
): ScreenshotViewport;
export function checkArtifactName(artifact: ScreenshotArtifact): string | null;
export function parseCaptureLog(text: string): Map<string, CaptureLogRecord>;
export function verifyCaptureLog(
  text: string,
  manifest?: readonly ScreenshotArtifact[],
): ArtifactProblem[];
export function verifyScreenshotArtifacts(
  options?: VerifyScreenshotArtifactsOptions,
): ScreenshotArtifactReport;
