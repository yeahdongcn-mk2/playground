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

/** One discovered manifest and the path it was loaded from. */
export interface ScreenshotSha256ManifestFile {
  path: string;
  manifest: ScreenshotSha256Manifest;
}

/** A screenshot file together with the manifest that owns it. */
export interface ScreenshotSha256ManifestCaptureMatch {
  path: string;
  manifest: ScreenshotSha256Manifest;
  capture: ScreenshotSha256Capture;
}

export interface DiscoverSha256ManifestPathsOptions {
  /** Directory to scan (default `DEFAULT_MANIFEST_DIR`). */
  dir?: string;
  /** Injectable directory reader; a missing directory yields no paths. */
  readDir?: (dir: string) => readonly string[];
}

export interface LoadSha256ManifestsOptions extends DiscoverSha256ManifestPathsOptions {
  /** Injectable manifest reader (default `readFileSync`). */
  readFile?: (path: string) => string | Buffer;
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

export interface CaptureLogHashRecord {
  /** The header path's basename, matched against `captures[].file`. */
  file: string;
  /** The full path printed in the `Wrote <path>` header. */
  path: string;
  /** The baseline recorded at capture time; not compared with the manifest. */
  manifestSha256: string;
  /** The sha256 of the bytes that run wrote. */
  capturedSha256: string;
}

export interface CaptureLogHashProblem {
  file: string;
  /** The current manifest sha256, or `null` when the file is not recorded. */
  expected: string | null;
  actual: string;
  message: string;
}

export interface CaptureLogHashesVerification {
  checked: boolean;
  /** True when a drift checklist header exists but cannot be parsed. */
  invalid: boolean;
  /** The parser error when `invalid`, `null` otherwise. */
  invalidMessage: string | null;
  ok: boolean;
  /** Structured drift mismatches; empty when the log is invalid. */
  problems: CaptureLogHashProblem[];
  records: CaptureLogHashRecord[];
}

export interface ScreenshotSha256Verification {
  entries: number;
  hashProblems: ScreenshotSha256HashProblem[];
  logHashes: CaptureLogHashesVerification;
  environment: CaptureEnvironmentVerification;
}

export interface ParseSha256ManifestOptions {
  source?: string;
}

export interface VerifyCaptureEnvironmentOptions {
  logText?: string | null;
  environment: ScreenshotSha256Environment;
}

export interface VerifyCaptureLogHashesOptions {
  logText?: string | null;
  manifest: ScreenshotSha256Manifest;
}

export interface CompareCaptureEnvironmentOptions {
  /** Failure label of the structured platform mismatch (default `manifest`). */
  source?: 'manifest' | 'log';
}

export interface CaptureEnvironmentComparison {
  problems: string[];
  platformMismatches: ScreenshotSha256PlatformMismatch[];
}

export interface VerifyScreenshotSha256Options {
  dir?: string;
  manifest: ScreenshotSha256Manifest;
  logText?: string;
  readFile?: (path: string) => Buffer;
}

export const DEFAULT_SCREENSHOT_DIR: string;
export const DEFAULT_MANIFEST_PATH: string;
export const DEFAULT_MANIFEST_DIR: string;
export const MANIFEST_FILE_PATTERN: RegExp;
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
export function formatManifestCaptureEnvironment(
  environment: ScreenshotSha256Environment,
): string;
export function compareCaptureEnvironmentFingerprint(
  fingerprint: CaptureEnvironmentFingerprintRecord,
  environment: ScreenshotSha256Environment,
  options?: CompareCaptureEnvironmentOptions,
): CaptureEnvironmentComparison;
export function findSha256ManifestCapture(
  manifest: ScreenshotSha256Manifest | null | undefined,
  file: string,
): ScreenshotSha256Capture | null;
export function discoverSha256ManifestPaths(
  options?: DiscoverSha256ManifestPathsOptions,
): string[];
export function loadSha256Manifests(
  options?: LoadSha256ManifestsOptions,
): ScreenshotSha256ManifestFile[];
export function findSha256ManifestCaptureInSet(
  manifests: readonly ScreenshotSha256ManifestFile[] | null | undefined,
  file: string,
): ScreenshotSha256ManifestCaptureMatch | null;
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
export function parseCaptureLogHashRecords(text: string): CaptureLogHashRecord[];
export function verifyCaptureLogHashes(
  options: VerifyCaptureLogHashesOptions,
): CaptureLogHashesVerification;
export function verifyScreenshotSha256(
  options: VerifyScreenshotSha256Options,
): ScreenshotSha256Verification;
