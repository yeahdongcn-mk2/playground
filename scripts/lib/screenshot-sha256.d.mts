import type { CaptureFontPackage, CaptureSource } from './capture-env.mjs';

export interface ScreenshotSha256Image {
  repository: string;
  tag: string;
  digest: string;
}

export interface ScreenshotSha256Environment {
  source: CaptureSource;
  target: string;
  dpr: number;
  platform: string;
  image: ScreenshotSha256Image;
  egl: Record<string, string>;
  fonts: CaptureFontPackage[];
}

export interface ScreenshotSha256PlatformMismatch {
  source: 'manifest' | 'log';
  expected: string;
  actual: string;
  image: ScreenshotSha256Image | null;
  actualImage?: ScreenshotSha256Image | null;
  message: string;
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
  source: CaptureSource;
  target: string;
  dpr: number;
  platform: string;
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
  /** Every environment problem, including platform drift. */
  problems: string[];
  /** The platform subset, structured for the CLI's separate report. */
  platformMismatches: ScreenshotSha256PlatformMismatch[];
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
export const FILE_NAME_PATTERN: RegExp;
export const PLATFORM_PATTERN: RegExp;

export class ScreenshotSha256Error extends Error {}

export function parseSha256Manifest(
  text: string,
  options?: ParseSha256ManifestOptions,
): ScreenshotSha256Manifest;
export function manifestEnvironmentMismatches(
  manifest: ScreenshotSha256Manifest,
): string[];
export function manifestPlatformMismatch(
  manifest: ScreenshotSha256Manifest,
): ScreenshotSha256PlatformMismatch | null;
export function imageReference(image: ScreenshotSha256Image): string;
export function expectedRecaptureCommand(file: string): string;
export function parseImageReference(value: string): ScreenshotSha256Image | null;
export function parseCaptureEnvironmentFingerprintLine(
  line: string,
): CaptureEnvironmentFingerprintRecord;
export function parseCaptureLogFingerprints(text: string): CaptureEnvironmentFingerprintRecord[];
export function verifyCaptureEnvironment(
  options?: VerifyCaptureEnvironmentOptions,
): CaptureEnvironmentVerification;
export function verifyScreenshotSha256(
  options: VerifyScreenshotSha256Options,
): ScreenshotSha256Verification;
