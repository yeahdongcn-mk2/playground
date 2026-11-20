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
  /** Use the settle-based stable-capture loop (Issue #199); default false. */
  stable?: boolean;
  /**
   * Require this many consecutive byte-identical whole-image frames before
   * writing (default 1 keeps the previous single-shot capture).
   */
  stableFrames?: number;
  /** Delay between stable-frame screenshots, in milliseconds. */
  stableIntervalMs?: number;
  /** Extra frames the stable-frame check may read before failing. */
  stableAttempts?: number;
  /**
   * Bytes a caller already validated (for example against the manifest sha256
   * while resampling a fresh page). The writer skips the screenshot and, for a
   * manifested file, still applies the environment guard and the atomic write;
   * it takes precedence over `stable` / `stableFrames`.
   */
  capturedBytes?: Buffer | Uint8Array;
  /**
   * Validate the manifested environment, then return without capturing or
   * writing (default false). An unrecorded file returns immediately.
   */
  checkOnly?: boolean;
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

export interface ExpectedCaptureSha256Options {
  /** Parsed manifest; defaults to reading `manifestPath` from disk. */
  manifest?: ScreenshotSha256Manifest | null;
  manifestPath?: string;
  readFile?: (path: string, encoding: 'utf8') => string;
}

/**
 * The sha256 recorded for `name` in the screenshot manifest, or null when the
 * file is unrecorded (for example a trimmed checkout).
 */
export function expectedCaptureSha256(
  name: string,
  options?: ExpectedCaptureSha256Options,
): string | null;

/** Consecutive whole-image frames the WebKit READY capture must repeat. */
export const READY_CAPTURE_STABLE_FRAMES: number;

/** Delay between the WebKit READY stability frames, in milliseconds. */
export const READY_CAPTURE_STABLE_INTERVAL_MS: number;

/** Extra frames the WebKit READY stability check may read before failing. */
export const READY_CAPTURE_STABLE_ATTEMPTS: number;

/** Animation frames the shared capture settle seam waits for. */
export const CAPTURE_SETTLE_FRAMES: number;
/** Screenshots the settle-based stable-capture loop may take before giving up. */
export const CAPTURE_STABLE_ATTEMPTS: number;

export interface CaptureStableBytesOptions {
  fullPage?: boolean;
  animations?: 'allow' | 'disabled';
  /** Total screenshots allowed; at least 2 (default {@link CAPTURE_STABLE_ATTEMPTS}). */
  attempts?: number;
  /** Settle seam run between screenshots; defaults to {@link settleCapturePaint}. */
  settle?: (page: Page) => Promise<void>;
}

/**
 * Capture until two consecutive screenshots are byte-identical; throws if the
 * page never settles within `attempts` screenshots.
 */
export function captureStableBytes(
  page: Page,
  options?: CaptureStableBytesOptions,
): Promise<Buffer>;


/** Fallback wait after those frames, in milliseconds. */
export const CAPTURE_SETTLE_TIMEOUT_MS: number;

/** Wait until fonts, two animation frames and a short fallback timeout settle. */
export function settleCapturePaint(page: Page): Promise<void>;

export interface SettleWebkitReadyPaintOptions {
  /** Scroll distance used to force the sticky header repaint; defaults to 200. */
  offset?: number;
}

/**
 * Repaint the sticky site header with a scroll round-trip, then settle fonts
 * and frames before a WebKit capture (2048 and snake READY, minesweeper
 * READY/scores-win).
 */
export function settleWebkitReadyPaint(
  page: Page,
  options?: SettleWebkitReadyPaintOptions,
): Promise<void>;

export interface RepaintWebkitReadyOverlayOptions {
  /** Settle seam run after the repaint; defaults to {@link settleCapturePaint}. */
  settle?: (page: Page) => Promise<void>;
}

/**
 * Hide the overlay (the READY card, the minesweeper loss panel or the
 * minesweeper scores win card) for two frames and restore it, then settle, so
 * its backdrop is painted on the canonical path instead of a load-dependent
 * composite.
 */
export function repaintWebkitReadyOverlay(
  page: Page,
  options?: RepaintWebkitReadyOverlayOptions,
): Promise<void>;
