import type {
  ChildProcess,
  SpawnOptions,
  spawnSync,
} from 'node:child_process';
import type {
  ScreenshotSha256Capture,
  ScreenshotSha256Manifest,
  ScreenshotSha256ManifestFile,
} from './screenshot-sha256.mjs';

/** One capture of a single manifest, the legacy WebKit load-gate plan shape. */
export interface ReproPlan {
  target: string;
  captures: ScreenshotSha256Capture[];
}

/** One capture aggregated across the manifest set, with its owning manifest. */
export interface ReproManifestCapture {
  file: string;
  sha256: string;
  manifestPath: string;
  command: string;
}

/** A capture command and every file it owns across the manifest set. */
export interface ReproManifestPlan {
  target: string;
  captures: ReproManifestCapture[];
}

export interface ReproHashEntry {
  file: string;
  sha256: string | null;
  error: string | null;
  /** The retained per-run copy below the log directory, or null. */
  copyPath: string | null;
}

export interface ReproRun {
  target: string;
  run: number;
  logPath: string;
  exitCode: number;
  fingerprints: string[];
  hashes: ReproHashEntry[];
}

export interface ReproRunHash {
  run: number;
  sha256: string | null;
  logPath: string;
  copyPath: string | null;
}

export interface ReproDifference {
  file: string;
  target: string;
  /** The manifest that records this file's sha256 and environment. */
  manifestPath: string;
  expected: string;
  /** Every run's hash and retained copy path, in run order. */
  runHashes: ReproRunHash[];
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
  /** Why the run failed before a capture could happen, e.g. a removal error. */
  failureReason: string | null;
}

export interface ReproVerifyFailure {
  target: string;
  run: number;
  /** The owning manifest the run log was verified against. */
  manifestPath: string;
  exitCode: number;
  logPath: string;
  output: string;
}

export interface ReproEnvironmentMismatch {
  target: string;
  /** Every run's fingerprint lines, in run order. */
  runs: Array<{ run: number; logPath: string; fingerprints: string[] }>;
  log1: string;
  log2: string;
  run1: string[];
  run2: string[];
}

export interface ReproArtifactFailure {
  target: string;
  run: number;
  file: string;
  path: string;
  message: string;
}

export interface ReproLoadFailure {
  /** 1-based worker number. */
  index: number;
  /** Whether the worker failed to spawn, to stop, or exited before stop. */
  phase: 'start' | 'stop' | 'runtime';
  message: string;
}

export interface ReproLoadSummary {
  /** Requested worker count; 0 means the repro ran without injected load. */
  requested: number;
  started: number;
  stopped: number;
  exitedEarly: number;
  active: number;
  failures: ReproLoadFailure[];
}

export interface ReproLoadController {
  requested: number;
  readonly started: number;
  readonly failures: ReproLoadFailure[];
  /** PIDs of the spawned workers, in start order. */
  readonly pids: number[];
  snapshot(): ReproLoadSummary;
  /** Stop and await every worker; idempotent. */
  stop(): Promise<ReproLoadSummary>;
}

export interface StartCpuLoadOptions {
  count?: number | string;
  spawn?: ReproSpawn;
  logger?: ReproLogger;
  /** Grace period after SIGTERM before SIGKILL; defaults to LOAD_KILL_GRACE_MS. */
  killGraceMs?: number;
}

export interface ReproResult {
  ok: boolean;
  report: string;
  /** Every manifest the run covered, in discovery / argument order. */
  manifestPaths: string[];
  /** The single manifest path when the set holds exactly one, else null. */
  manifestPath: string | null;
  dir: string;
  logDir: string;
  runsPerTarget: number;
  load: ReproLoadSummary;
  plans: ReproManifestPlan[];
  runs: ReproRun[];
  differences: ReproDifference[];
  captureFailures: ReproCaptureFailure[];
  verifyFailures: ReproVerifyFailure[];
  artifactFailures: ReproArtifactFailure[];
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

/** The child_process.spawn seam used by the default capture runner. */
export type ReproSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SpawnContainerCaptureOptions {
  target: string;
  logPath: string;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  spawn?: ReproSpawn;
}

export interface SpawnSha256VerifierOptions extends ReproVerifyLogOptions {
  spawnSync?: typeof spawnSync;
}

export interface RunScreenshotReproOptions {
  /**
   * One explicit manifest to run against. `null` (default) discovers every
   * `capture-sha256-manifest*.json` below `manifestDir`.
   */
  manifestPath?: string | null;
  /** Directory the manifest set is discovered in; defaults to DEFAULT_MANIFEST_DIR. */
  manifestDir?: string;
  dir?: string;
  logDir?: string;
  repoRoot?: string;
  /** Requested manifest targets; empty means every target. */
  targets?: string[];
  /** Runs per target; defaults to REPRO_RUN_COUNT. */
  runs?: number | string;
  /**
   * CPU load worker processes kept alive for every selected run; 0 (default)
   * leaves the repro load-free. Workers are stopped and awaited in a `finally`.
   */
  load?: number | string;
  env?: NodeJS.ProcessEnv;
  logger?: ReproLogger;
  /** Live progress lines, one per file and run. */
  progress?: (line: string) => void;
  readText?: (path: string) => string;
  hashFile?: (path: string) => string;
  copyFile?: (source: string, destination: string) => void;
  mkdir?: (path: string, options: { recursive: true }) => void;
  removeFile?: (path: string) => void;
  spawn?: ReproSpawn;
  /** Spawn seam for the load workers; defaults to the same `spawn`. */
  spawnLoadWorker?: ReproSpawn;
  spawnSync?: typeof spawnSync;
  /** Grace period after SIGTERM before SIGKILL; defaults to LOAD_KILL_GRACE_MS. */
  killGraceMs?: number;
  runCapture?: (
    options: ReproRunCaptureOptions,
  ) => number | Promise<number>;
  verifyLog?: (
    options: ReproVerifyLogOptions,
  ) => ReproVerification | Promise<ReproVerification>;
}

export const DEFAULT_REPRO_LOG_DIR: string;
export const REPRO_RUN_COUNT: number;
export const DEFAULT_LOAD_COUNT: number;
export const MAX_LOAD_COUNT: number;
export const LOAD_KILL_GRACE_MS: number;
export const SHA256_VERIFIER_PATH: string;

export class ScreenshotReproError extends Error {}

export function captureCommandArgs(target: string): string[];
export function sha256VerifierArgs(options: ReproVerifyLogOptions): string[];
export function parseCaptureTarget(command: string): string;
export function validateCaptureTarget(target: string): string;
export function normalizeRunCount(value: number | string): number;
export function normalizeLoadCount(value: number | string): number;
export function loadWorkerArgs(): string[];
export function startCpuLoad(options?: StartCpuLoadOptions): ReproLoadController;
export function selectReproPlans<T extends { target: string }>(
  plans: T[],
  targets?: string[],
): T[];
export function deriveReproPlans(manifest: ScreenshotSha256Manifest): ReproPlan[];
export function deriveReproPlansFromManifests(
  manifests: ScreenshotSha256ManifestFile[],
): ReproManifestPlan[];
export function reproLogPath(logDir: string, target: string, run: number): string;
export function reproArtifactDir(logDir: string, target: string, run: number): string;
export function reproArtifactPath(
  logDir: string,
  target: string,
  run: number,
  file: string,
): string;
export function spawnContainerCapture(options: SpawnContainerCaptureOptions): Promise<number>;
export function spawnSha256Verifier(options: SpawnSha256VerifierOptions): ReproVerification;
export function runScreenshotRepro(
  options?: RunScreenshotReproOptions,
): Promise<ReproResult>;
