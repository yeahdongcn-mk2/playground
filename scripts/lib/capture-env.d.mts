export type CaptureTarget = 'desktop' | 'mobile' | 'mobile-touch' | 'webkit';
export type CaptureSource = 'host' | 'container';

export interface CaptureImagePin {
  version: string;
  tag: string;
  digest: string;
}

export interface CaptureImage {
  repository: string;
  tag: string;
  digest: string;
  version: string;
  reference: string;
}

export interface CaptureFontPackage {
  name: string;
  version: string;
}

export interface CaptureEnvironmentImage {
  repository: string;
  tag: string;
  digest: string;
}

export interface CaptureEnvironmentFingerprint {
  source: CaptureSource;
  target: CaptureTarget;
  dpr: number;
  image: CaptureEnvironmentImage | null;
  node: string;
  playwright: string;
  browser: string | null;
  fonts: CaptureFontPackage[] | 'unavailable' | null;
  env: Record<string, string | null> | null;
}

export interface CaptureFingerprintRun {
  browserVersion?: string | null;
  nodeVersion?: string;
  playwrightVersion?: string;
  fontPackages?: CaptureFontPackage[] | 'unavailable';
}

export interface CaptureFingerprintOptions {
  target?: CaptureTarget;
  run?: CaptureFingerprintRun;
  env?: Record<string, string | undefined>;
  lockfilePath?: string;
  readFile?: (path: string, encoding: 'utf8') => string;
}

export interface ReadPlaywrightVersionOptions {
  lockfilePath?: string;
  readFile?: (path: string, encoding: 'utf8') => string;
}

export interface ResolveCaptureImageOptions {
  version?: string;
  lockfilePath?: string;
  readFile?: (path: string, encoding: 'utf8') => string;
  imageTag?: string;
  digest?: string;
}

export interface ProbeFontPackagesOptions {
  execFile?: (file: string, args: readonly string[]) => string;
}

export interface AssertContainerCaptureEnvironmentOptions {
  env?: Record<string, string | undefined>;
  /** Expected target set for the run; a single target or a list. */
  target?: string | readonly string[];
  targets?: readonly string[];
  version?: string;
  lockfilePath?: string;
  readFile?: (path: string, encoding: 'utf8') => string;
}

export interface ContainerCaptureEnvironment {
  targets: string[];
  dprs: number[];
  imageTag: string;
  version: string;
}

export const CAPTURE_REPO_ROOT: string;
export const PLAYWRIGHT_IMAGE_REPOSITORY: string;
export const PLAYWRIGHT_IMAGE_PIN: Readonly<CaptureImagePin>;
export const CAPTURE_CONTAINER_FLAG: string;
export const CAPTURE_IMAGE_TAG_VAR: string;
export const CAPTURE_IMAGE_DIGEST_VAR: string;
export const CAPTURE_TARGET_VAR: string;
export const CAPTURE_TARGET_DPR_VAR: string;
export const CAPTURE_EGL_ENV: Readonly<Record<string, string>>;
export const CAPTURE_EGL_VARS: readonly string[];
export const CAPTURE_TARGET_DPRS: Readonly<Record<string, number>>;
export const CAPTURE_TARGETS: readonly string[];
export const CAPTURE_FONT_PACKAGES: readonly string[];

export function imageTagForPlaywrightVersion(version: string): string;
export function readPlaywrightVersion(
  options?: ReadPlaywrightVersionOptions,
): string;
export function assertImageTagMatchesPlaywrightVersion(
  imageTag: string,
  version: string,
): void;
export function resolveCaptureImage(
  options?: ResolveCaptureImageOptions,
): CaptureImage;
export function dprForCaptureTarget(target: string): number;
export function normalizeCaptureTargets(
  targets?: string | readonly string[] | null,
): string[] | null;
export function probeFontPackages(
  options?: ProbeFontPackagesOptions,
): CaptureFontPackage[] | 'unavailable';
export function captureEnvironmentFingerprint(
  options?: CaptureFingerprintOptions,
): CaptureEnvironmentFingerprint;
export function formatCaptureEnvironmentFingerprint(
  fingerprint: CaptureEnvironmentFingerprint,
): string;
export function assertContainerCaptureEnvironment(
  options?: AssertContainerCaptureEnvironmentOptions,
): ContainerCaptureEnvironment;
