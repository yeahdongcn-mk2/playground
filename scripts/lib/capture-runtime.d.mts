import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import type {
  CaptureEnvironmentFingerprint,
  CaptureFingerprintRun,
  CaptureTarget,
} from './capture-env.mjs';
import type { ScreenshotSha256Manifest } from './screenshot-sha256.mjs';

export const WEBKIT_FLAG: string;
export const WEBKIT_NARROW_FLAG: string;
export const WEBKIT_NARROW_BEFORE_FLAG: string;
export const CHROMIUM_ENGINE: 'chromium';
export const WEBKIT_ENGINE: 'webkit';
export const WEBKIT_DEVICE: string;
export const TOUCH_MOBILE_DEVICE: string;

export type CaptureEngine = 'chromium' | 'webkit';

export function parseCaptureEngine(args?: readonly string[]): CaptureEngine;
export function engineLabel(engine: CaptureEngine): 'Chromium' | 'WebKit';
export function launchCaptureBrowser(engine: CaptureEngine): Promise<Browser>;
export function closeCaptureBrowser(browser?: Browser | null): Promise<void>;

export interface LogCaptureEnvironmentOptions {
  env?: Record<string, string | undefined>;
  run?: {
    browserVersion?: string | null;
    nodeVersion?: string;
    playwrightVersion?: string;
    fontPackages?: CaptureEnvironmentFingerprint['fonts'];
  };
}

export function assertContainerCaptureTarget(
  target: CaptureTarget,
  env?: Record<string, string | undefined>,
): void;

export function logCaptureEnvironment(
  target: CaptureTarget,
  browser: Pick<Browser, 'version'>,
  options?: LogCaptureEnvironmentOptions,
): void;

/** Capture targets recorded so far in this process, in first-recording order. */
export function recordedCaptureTargets(): CaptureTarget[];
/** Clear the process-wide recorded set; used by unit tests. */
export function resetRecordedCaptureTargets(): void;

export interface AssertDeclaredCaptureTargetsOptions {
  /** Label of the declaration that is compared, named in the error. */
  source?: string;
  /** Recorded targets to compare; defaults to the process-wide set. */
  recorded?: readonly string[];
}

export function assertAllDeclaredCaptureTargets(
  declared: string | readonly string[] | null | undefined,
  options?: AssertDeclaredCaptureTargetsOptions,
): void;

export function createDesktopContext(
  browser: Browser,
  options?: BrowserContextOptions,
): Promise<BrowserContext>;
export function createMobileContext(
  browser: Browser,
  options?: BrowserContextOptions,
): Promise<BrowserContext>;
export function createTouchMobileContext(
  browser: Browser,
  options?: BrowserContextOptions,
): Promise<BrowserContext>;

export interface StartPreviewServerOptions {
  port: number;
  host?: string;
  entry?: string;
  stdio?: 'ignore' | 'inherit' | Array<'ignore' | 'pipe' | 'inherit'>;
}

export function startPreviewServer(options: StartPreviewServerOptions): ChildProcess;
export function stopPreviewServer(server?: ChildProcess | null): void;

export interface Viewport {
  width: number;
  height: number;
}

export interface PhoneContextOptions {
  viewport?: Viewport;
  screen?: Viewport;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  colorScheme?: 'dark' | 'light';
  reducedMotion?: 'reduce' | 'no-preference';
}

export interface PhoneContextResult {
  viewport?: Viewport;
  screen?: Viewport;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
  colorScheme?: 'dark' | 'light';
  reducedMotion?: 'reduce' | 'no-preference';
}

export function phoneContextOptions(
  engine: CaptureEngine,
  options?: PhoneContextOptions,
): PhoneContextResult;
export function createPhoneContext(
  browser: Browser,
  engine: CaptureEngine,
  options?: PhoneContextOptions,
): Promise<BrowserContext>;

export function captureRecord(
  name: string,
  engine: CaptureEngine,
  viewport: Viewport | null | undefined,
  colorScheme?: string,
  reducedMotion?: string,
): string;

/** Replaceable final rename for the atomic write path; unit tests inject a failure. */
export interface CaptureAtomicWriteOperations {
  renameSync?: (oldPath: string, newPath: string) => void;
}

export interface CaptureScreenshotOptions {
  engine: CaptureEngine;
  fullPage?: boolean;
  outputDir?: string;
  colorScheme?: string;
  reducedMotion?: string;
  animations?: 'allow' | 'disabled';
  /** Override the target of the context that produced the page (tests / edge cases). */
  target?: CaptureTarget;
  /** Parsed manifest; defaults to reading `manifestPath` from disk. */
  manifest?: ScreenshotSha256Manifest | null;
  manifestPath?: string;
  readFile?: (path: string, encoding: 'utf8') => string;
  /** Replaceable atomic rename (unit tests inject a failure). */
  fileOperations?: CaptureAtomicWriteOperations;
  /** Environment used when no context fingerprint is available; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Extra fingerprint inputs (browser version, font packages) for tests. */
  run?: CaptureFingerprintRun;
  /** Explicit fingerprint; skips the context / env probe. */
  fingerprint?: CaptureEnvironmentFingerprint;
  /** Warning sink for the manifest hash-drift checklist (default `console`). */
  log?: { warn: (message: string) => void };
}

export function captureScreenshot(
  page: Page,
  name: string,
  options: CaptureScreenshotOptions,
): Promise<void>;

/** Animation frames the shared capture settle seam waits for. */
export const CAPTURE_SETTLE_FRAMES: number;

/** Fallback wait after those frames, in milliseconds. */
export const CAPTURE_SETTLE_TIMEOUT_MS: number;

/** Wait until fonts, two animation frames and a short fallback timeout settle. */
export function settleCapturePaint(page: Page): Promise<void>;

/**
 * Repaint the sticky site header with a scroll round-trip, then settle fonts
 * and frames before a WebKit READY capture.
 */
export function settleWebkitReadyPaint(
  page: Page,
  options?: { offset?: number },
): Promise<void>;
