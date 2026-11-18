import type { ScreenshotSha256Capture, ScreenshotSha256Manifest } from './screenshot-sha256.mjs';

export interface ReproPlan {
  target: string;
  captures: ScreenshotSha256Capture[];
}

export interface ReproHashEntry {
  file: string;
  sha256: string | null;
  error: string | null;
}

export interface ReproRun {
  target: string;
  run: number;
  logPath: string;
  exitCode: number;
  fingerprints: string[];
  hashes: ReproHashEntry[];
}

export interface ReproDifference {
  file: string;
  target: string;
  expected: string;
  run1: string | null;
  run2: string | null;
  log1: string;
  log2: string;
}

export interface ReproCaptureFailure {
  target: string;
  run: number;
  exitCode: number;
  logPath: string;
}

export interface ReproVerifyFailure {
  target: string;
  run: number;
  exitCode: number;
  logPath: string;
  output: string;
}

export interface ReproEnvironmentMismatch {
  target: string;
  log1: string;
  log2: string;
  run1: string[];
  run2: string[];
}

export interface ReproResult {
  ok: boolean;
  report: string;
  manifestPath: string;
  dir: string;
  logDir: string;
  plans: ReproPlan[];
  runs: ReproRun[];
  differences: ReproDifference[];
  captureFailures: ReproCaptureFailure[];
  verifyFailures: ReproVerifyFailure[];
  environmentMismatches: ReproEnvironmentMismatch[];
  verifiedFiles: number;
}

export interface ReproLogger {
  log?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface ReproRunCaptureOptions {
  target: string;
  run: number;
  logPath: string;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  logger: ReproLogger;
}

export interface ReproVerifyLogOptions {
  logPath: string;
  dir: string;
  manifestPath: string;
  repoRoot: string;
}

export interface ReproVerification {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunScreenshotReproOptions {
  manifestPath?: string;
  dir?: string;
  logDir?: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  logger?: ReproLogger;
  readText?: (path: string) => string;
  hashFile?: (path: string) => string;
  mkdir?: (path: string, options: { recursive: true }) => void;
  runCapture?: (
    options: ReproRunCaptureOptions,
  ) => number | Promise<number>;
  verifyLog?: (
    options: ReproVerifyLogOptions,
  ) => ReproVerification | Promise<ReproVerification>;
}

export const DEFAULT_REPRO_LOG_DIR: string;
export const REPRO_RUN_COUNT: number;
export const SHA256_VERIFIER_PATH: string;

export class ScreenshotReproError extends Error {}

export function captureCommandArgs(target: string): string[];
export function sha256VerifierArgs(options: ReproVerifyLogOptions): string[];
export function parseCaptureTarget(command: string): string;
export function deriveReproPlans(manifest: ScreenshotSha256Manifest): ReproPlan[];
export function reproLogPath(logDir: string, target: string, run: number): string;
export function runScreenshotRepro(
  options?: RunScreenshotReproOptions,
): Promise<ReproResult>;
