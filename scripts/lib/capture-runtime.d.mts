import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import type {
  CaptureEnvironmentFingerprint,
  CaptureTarget,
} from './capture-env.mjs';

export const WEBKIT_FLAG: string;
export const WEBKIT_NARROW_FLAG: string;
export const WEBKIT_NARROW_BEFORE_FLAG: string;
export const CHROMIUM_ENGINE: 'chromium';
export const WEBKIT_ENGINE: 'webkit';
export const WEBKIT_DEVICE: string;

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

export function createDesktopContext(
  browser: Browser,
  options?: BrowserContextOptions,
): Promise<BrowserContext>;
export function createMobileContext(
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

export interface CaptureScreenshotOptions {
  engine: CaptureEngine;
  fullPage?: boolean;
  outputDir?: string;
  colorScheme?: string;
  reducedMotion?: string;
  animations?: 'allow' | 'disabled';
}

export function captureScreenshot(
  page: Page,
  name: string,
  options: CaptureScreenshotOptions,
): Promise<void>;
