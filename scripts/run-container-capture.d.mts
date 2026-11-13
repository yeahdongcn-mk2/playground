import type { ChildProcess, SpawnOptions, spawnSync } from 'node:child_process';
import type { CaptureImage } from './lib/capture-env.mjs';

export interface PackageScripts {
  scripts?: Record<string, string>;
}

export interface RunContainerCaptureOptions {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  spawnSync?: typeof spawnSync;
  readFile?: (path: string, encoding?: 'utf8') => string;
  existsSync?: (path: string) => boolean;
  repoRoot?: string;
  packagePath?: string;
  lockfilePath?: string;
  logDir?: string;
  ensureDependencies?: (options: {
    repoRoot: string;
    env: Record<string, string | undefined>;
    readFile: (path: string, encoding?: 'utf8') => string;
    existsSync: (path: string) => boolean;
  }) => Promise<boolean>;
  checkPort?: (port: number, host?: string) => Promise<void>;
  logger?: Pick<Console, 'log'>;
  now?: () => string;
  uid?: number;
  gid?: number;
}

export interface ParseContainerCaptureArgsOptions {
  scripts?: Record<string, string>;
}

export interface ParsedContainerCaptureArgs {
  target: string;
  passthrough: string[];
}

export interface EnsureCaptureImageOptions {
  spawnSync?: typeof spawnSync;
  repoRoot?: string;
  tag?: string;
}

export interface BuildDockerRunArgsOptions {
  target: string;
  passthrough?: readonly string[];
  repoRoot?: string;
  image: CaptureImage;
  containerImage?: string;
  imageTag?: string;
  imageDigest?: string;
  uid?: number;
  gid?: number;
  previewPort?: number | null;
  env?: Record<string, string | undefined>;
}

export interface EnsureContainerDependenciesOptions {
  repoRoot?: string;
  env?: Record<string, string | undefined>;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  readFile?: (path: string, encoding?: 'utf8') => string;
  existsSync?: (path: string) => boolean;
  writeFile?: (path: string, data: string) => void;
}

export const CONTAINER_WORKDIR: string;
export const CONTAINER_CAPTURE_IMAGE: string;
export const CONTAINER_LOG_DIR: string;
export const CAPTURE_LOCK_HASH_FILE: string;

export function readPackageScripts(options?: {
  packagePath?: string;
  readFile?: (path: string, encoding?: 'utf8') => string;
}): Record<string, string>;
export function captureTargets(scripts: Record<string, string>): string[];
/**
 * Capture targets (in DPR order) one container run records.
 *
 * `passthrough` is the extra argv the container entry forwards to the capture
 * script; the flags that change the recorded target set are folded in on top of
 * the target script name (see the implementation for the exact rules).
 */
export function captureTargetsForScript(
  script: string,
  passthrough?: readonly string[],
): string[];
export function previewPortForTarget(
  target: string,
  value?: string,
): number | null;
export function parseContainerCaptureArgs(
  argv?: readonly string[],
  options?: ParseContainerCaptureArgsOptions,
): ParsedContainerCaptureArgs;
export function preflightDocker(options?: {
  spawnSync?: typeof spawnSync;
}): void;
export function localCaptureImageName(tag?: string): string;
export function ensureCaptureImage(
  options?: EnsureCaptureImageOptions,
): string;
export function buildDockerRunArgs(
  options: BuildDockerRunArgsOptions,
): string[];
export function ensureContainerDependencies(
  options?: EnsureContainerDependenciesOptions,
): Promise<boolean>;
export function runContainerCapture(
  options?: RunContainerCaptureOptions,
): Promise<number | null>;
