import { spawn } from 'node:child_process';
import { chromium, devices, webkit } from '@playwright/test';

/** Engine selector shared by every screenshot script. */
export const WEBKIT_FLAG = '--webkit';
export const WEBKIT_NARROW_FLAG = '--webkit-narrow';
export const WEBKIT_NARROW_BEFORE_FLAG = '--webkit-narrow-before';
export const CHROMIUM_ENGINE = 'chromium';
export const WEBKIT_ENGINE = 'webkit';
/** The same device the `mobile-webkit` Playwright project uses. */
export const WEBKIT_DEVICE = 'iPhone SE (3rd gen)';

/**
 * Resolve the capture engine from a script's argv.
 *
 * `--webkit` selects WebKit for the stable phone scenarios; the two narrow
 * flags are WebKit-only modes, so they also select the WebKit engine. The
 * default is Chromium, which keeps every existing Chromium command unchanged.
 */
export function parseCaptureEngine(args = process.argv.slice(2)) {
  if (args.includes(WEBKIT_FLAG) || args.includes(WEBKIT_NARROW_FLAG) || args.includes(WEBKIT_NARROW_BEFORE_FLAG)) {
    return WEBKIT_ENGINE;
  }
  return CHROMIUM_ENGINE;
}

/** Human-readable engine name for logs and docs. */
export function engineLabel(engine) {
  return engine === WEBKIT_ENGINE ? 'WebKit' : 'Chromium';
}

/** Launch the engine a capture script selected. */
export async function launchCaptureBrowser(engine) {
  return engine === WEBKIT_ENGINE ? webkit.launch() : chromium.launch();
}

/** Close a capture browser without masking the capture error. */
export async function closeCaptureBrowser(browser) {
  await browser?.close();
}

/**
 * Spawn the production preview used by screenshot scripts.
 *
 * The command and stdio behaviour are the same as the scripts' previous inline
 * spawns; callers that need detailed startup errors still attach their own
 * stderr listeners and readiness probes.
 */
export function startPreviewServer({
  port,
  host = '127.0.0.1',
  entry = 'node_modules/vite/bin/vite.js',
  stdio = 'ignore',
}) {
  const server = spawn(
    process.execPath,
    [entry, 'preview', '--host', host, '--port', String(port), '--strictPort'],
    { stdio },
  );
  process.on('exit', () => server.kill());
  return server;
}

/** Stop a preview spawned by {@link startPreviewServer}. */
export function stopPreviewServer(server) {
  server?.kill('SIGTERM');
}

/**
 * Playwright context options for a phone capture.
 *
 * Chromium keeps the existing Pixel-style viewport, DPR and touch options.
 * WebKit uses the same `iPhone SE (3rd gen)` device as the `mobile-webkit`
 * project; an explicit viewport overrides the device's 375×667 size for the
 * narrow matrix.
 */
export function phoneContextOptions(
  engine,
  {
    viewport,
    screen,
    deviceScaleFactor = 2,
    isMobile = true,
    hasTouch = true,
    colorScheme = 'dark',
    reducedMotion = 'reduce',
  } = {},
) {
  if (engine === WEBKIT_ENGINE) {
    const device = devices[WEBKIT_DEVICE];
    return {
      viewport: viewport ?? device.viewport,
      screen: screen ?? viewport ?? device.screen,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      userAgent: device.userAgent,
      colorScheme,
      reducedMotion,
    };
  }
  return {
    viewport,
    screen,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    colorScheme,
    reducedMotion,
  };
}

/** Create a phone context on the selected engine. */
export async function createPhoneContext(browser, engine, options) {
  return browser.newContext(phoneContextOptions(engine, options));
}

/** One-line record that ties a screenshot file to engine, viewport and theme. */
export function captureRecord(name, engine, viewport, colorScheme = 'dark', reducedMotion = 'reduce') {
  const size = viewport == null ? 'unknown' : `${viewport.width}x${viewport.height}`;
  return `${name}: engine=${engine}, viewport=${size}, theme=${colorScheme}, reducedMotion=${reducedMotion}`;
}

/**
 * Take one screenshot and log the engine / viewport / theme record. Callers
 * pass the same options as `page.screenshot`, so the Chromium bytes stay
 * unchanged.
 */
export async function captureScreenshot(
  page,
  name,
  {
    engine,
    fullPage = false,
    outputDir = 'docs/screenshots',
    colorScheme = 'dark',
    reducedMotion = 'reduce',
    animations = 'disabled',
  },
) {
  await page.screenshot({
    path: `${outputDir}/${name}`,
    fullPage,
    animations,
  });
  console.log(captureRecord(name, engine, page.viewportSize(), colorScheme, reducedMotion));
}
