import { spawn } from 'node:child_process';
import { chromium, devices, webkit } from '@playwright/test';
import {
  CAPTURE_CONTAINER_FLAG,
  CAPTURE_TARGET_VAR,
  captureEnvironmentFingerprint,
  formatCaptureEnvironmentFingerprint,
  normalizeCaptureTargets,
} from './capture-env.mjs';

/** Engine selector shared by every screenshot script. */
export const WEBKIT_FLAG = '--webkit';
export const WEBKIT_NARROW_FLAG = '--webkit-narrow';
export const WEBKIT_NARROW_BEFORE_FLAG = '--webkit-narrow-before';
export const CHROMIUM_ENGINE = 'chromium';
export const WEBKIT_ENGINE = 'webkit';
/** The same device the `mobile-webkit` Playwright project uses. */
export const WEBKIT_DEVICE = 'iPhone SE (3rd gen)';
/**
 * The device whose viewport, fractional DPR and touch flags define the
 * minesweeper touch evidence.
 */
export const TOUCH_MOBILE_DEVICE = 'Pixel 7';

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

/** Targets already logged for one browser, so each run logs each target once. */
const loggedTargetsByBrowser = new WeakMap();

function markTargetLogged(browser, target) {
  let logged = loggedTargetsByBrowser.get(browser);
  if (logged === undefined) {
    logged = new Set();
    loggedTargetsByBrowser.set(browser, logged);
  }
  if (logged.has(target)) {
    return false;
  }
  logged.add(target);
  return true;
}

/**
 * Fail when a container capture records a target that CAPTURE_TARGET omits.
 *
 * The container entry derives CAPTURE_TARGET from the capture script and its
 * passthrough flags, but the script itself decides which context it creates.
 * Asserting at the recording point catches a mismatch between the injected
 * environment contract and the evidence actually written; the error names the
 * real target so a wrong passthrough is easy to correct.
 *
 * Host runs keep the fingerprint-only behaviour and do not need CAPTURE_TARGET.
 */
export function assertContainerCaptureTarget(target, env = process.env) {
  if (env[CAPTURE_CONTAINER_FLAG] !== '1') {
    return;
  }

  const raw = env[CAPTURE_TARGET_VAR];
  let declared;
  try {
    declared = normalizeCaptureTargets(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot validate capture target "${String(target)}": ` +
        `${CAPTURE_TARGET_VAR}="${String(raw)}" is invalid (${detail}). ` +
        'Run captures through npm run screenshots:container, which injects a valid target list.',
    );
  }
  if (declared !== null && declared.includes(target)) {
    return;
  }

  const actual = raw === undefined || raw.trim() === '' ? '(not set)' : raw;
  throw new Error(
    `Capture target "${String(target)}" was recorded but is not listed in ` +
      `${CAPTURE_TARGET_VAR}="${actual}". Run captures through ` +
      'npm run screenshots:container, which injects that list from the capture ' +
      `script and its flags; the entry must include "${String(target)}".`,
  );
}

/**
 * Log the fixed capture environment fingerprint (Issue #199) for one target.
 *
 * The fingerprint is recorded when a browser first creates a context for that
 * target, not at browser launch: a single Chromium run captures desktop
 * (DPR 1), phone (DPR 2) and Pixel 7 touch (DPR 2.625) evidence, and a
 * launch-time guess would label the phone or touch images `desktop`. Deduped
 * per browser and target, so a run with several desktop, phone or touch
 * contexts still emits one line per target.
 *
 * Host runs report `source=host` with unavailable image / font / EGL fields, so
 * the existing `npm run screenshots:*` commands keep working unchanged, and
 * fingerprint errors are logged as a warning instead of failing the capture.
 * Container target validation runs before that warning branch: a target the
 * entry did not declare aborts the run instead of being downgraded to a
 * warning. Strict environment validation is owned by the container entry.
 */
export function logCaptureEnvironment(target, browser, { env, run } = {}) {
  assertContainerCaptureTarget(target, env);
  if (loggedTargetsByBrowser.get(browser)?.has(target)) {
    return;
  }
  try {
    const fingerprint = captureEnvironmentFingerprint({
      target,
      run: { browserVersion: browser.version(), ...run },
      env,
    });
    console.log(formatCaptureEnvironmentFingerprint(fingerprint));
    markTargetLogged(browser, target);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`capture-env: unavailable (${detail})`);
  }
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

/** Create a desktop context and record the desktop DPR-1 fingerprint. */
export async function createDesktopContext(browser, options = {}) {
  const context = await browser.newContext(options);
  logCaptureEnvironment('desktop', browser);
  return context;
}

/** Create a phone context and record the phone DPR-2 fingerprint. */
export async function createMobileContext(browser, options = {}) {
  const context = await browser.newContext(options);
  logCaptureEnvironment('mobile', browser);
  return context;
}

/**
 * Create the Pixel 7 touch context used by the minesweeper touch evidence.
 *
 * The viewport, fractional DPR 2.625, mobile and touch flags come from the
 * Playwright device descriptor, so the `mobile-touch` fingerprint matches what
 * the browser actually renders. The unit test pins the Pixel 7 descriptor to the
 * target contract, so a Playwright bump that changes the device cannot silently
 * desynchronise the fingerprint. Theme / motion default to the committed
 * screenshots and callers may override them.
 */
export async function createTouchMobileContext(browser, options = {}) {
  const device = devices[TOUCH_MOBILE_DEVICE];
  const context = await browser.newContext({
    viewport: device.viewport,
    screen: device.screen,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
    userAgent: device.userAgent,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    ...options,
  });
  logCaptureEnvironment('mobile-touch', browser);
  return context;
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
  const context = await browser.newContext(phoneContextOptions(engine, options));
  // WebKit phone evidence is its own target; Chromium phone evidence is the
  // `mobile` target of a run that also captures desktop.
  logCaptureEnvironment(engine === WEBKIT_ENGINE ? 'webkit' : 'mobile', browser);
  return context;
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
