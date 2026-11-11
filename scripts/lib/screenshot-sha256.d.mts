import type { CaptureFontPackage } from './capture-env.mjs';

export interface ScreenshotSha256Image {
  repository: string;
  tag: string;
  digest: string;
}

export interface ScreenshotSha256Environment {
  source: 'container' | 'host';
  target: string;
  dpr: number;
  image: ScreenshotSha256Image;
  egl: Record<string, string>;
  fonts: CaptureFontPackage[];
}

export interface ScreenshotSha256Provenance {
  container: string;
  captureCommit: string;
}

export interface ScreenshotSha256Capture {
  file: string;
  sha256: string;
  command: string;
  provenance: ScreenshotSha256Provenance;
}

export interface ScreenshotSha256Manifest {
  environment: ScreenshotSha256Environment;
  captures: ScreenshotSha256Capture[];
}

export interface CaptureEnvironmentFingerprintRecord {
  source: string;
  target: string;
  dpr: number;
  image: ScreenshotSha256Image | null;
  node: string;
  playwright: string;
  browser: string | null;
  fonts: CaptureFontPackage[] | 'unavailable';
  env: Record<string, string> | null;
  line: string;
}

export interface CaptureEnvironmentVerification {
  checked: boolean;
  /** True when a capture-env: line exists but cannot be parsed. */
  invalid: boolean;
  ok: boolean;
  problems: string[];
  fingerprints: CaptureEnvironmentFingerprintRecord[];
}

export interface ScreenshotSha256HashProblem {
  file: string;
  expected: string;
  actual: string | null;
  message: string;
}

export interface ScreenshotSha256Verification {
  entries: number;
  hashProblems: ScreenshotSha256HashProblem[];
  environment: CaptureEnvironmentVerification;
}

export interface ParseSha256ManifestOptions {
  source?: string;
}

export interface VerifyCaptureEnvironmentOptions {
  logText?: string | null;
  environment: ScreenshotSha256Environment;
}

export interface VerifyScreenshotSha256Options {
  dir?: string;
  manifest: ScreenshotSha256Manifest;
  logText?: string;
  readFile?: (path: string) => Buffer;
}

export const DEFAULT_SCREENSHOT_DIR: string;
export const DEFAULT_MANIFEST_PATH: string;
export const SHA256_PATTERN: RegExp;
export const IMAGE_DIGEST_PATTERN: RegExp;
export const CAPTURE_COMMIT_PATTERN: RegExp;

export class ScreenshotSha256Error extends Error {}

export function parseSha256Manifest(
  text: string,
  options?: ParseSha256ManifestOptions,
): ScreenshotSha256Manifest;
export function manifestEnvironmentMismatches(
  manifest: ScreenshotSha256Manifest,
): string[];
export function imageReference(image: ScreenshotSha256Image): string;
export function parseImageReference(value: string): ScreenshotSha256Image | null;
export function parseCaptureEnvironmentFingerprintLine(
  line: string,
): CaptureEnvironmentFingerprintRecord;
export function parseCaptureLogFingerprints(text: string): CaptureEnvironmentFingerprintRecord[];
export function verifyCaptureEnvironment(
  options?: VerifyCaptureEnvironmentOptions,
): CaptureEnvironmentVerification;
export function verifyScreenshotSha256(
  options?: VerifyScreenshotSha256Options,
): ScreenshotSha256Verification;
