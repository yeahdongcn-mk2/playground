import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, devices, webkit } from '@playwright/test';
import {
  CAPTURE_CONTAINER_FLAG,
  CAPTURE_REPO_ROOT,
  CAPTURE_TARGET_VAR,
  captureEnvironmentFingerprint,
  formatCaptureEnvironmentFingerprint,
  normalizeCaptureTargets,
} from './capture-env.mjs';
import {
  DEFAULT_MANIFEST_PATH,
  compareCaptureEnvironmentFingerprint,
  findSha256ManifestCapture,
  formatManifestCaptureEnvironment,
  parseSha256Manifest,
} from './screenshot-sha256.mjs';
import {
  WEBKIT_FLAG,
  WEBKIT_NARROW_BEFORE_FLAG,
  WEBKIT_NARROW_FLAG,
} from './capture-targets.mjs';

/**
 * The shared WebKit / narrow flag spellings live in `capture-targets.mjs`;
 * they are re-exported here because every capture script imports its engine
 * helpers from this runtime.
 */
export { WEBKIT_FLAG, WEBKIT_NARROW_FLAG, WEBKIT_NARROW_BEFORE_FLAG };
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

/**
 * The capture target every context created by this runtime belongs to.
 *
 * A screenshot does not carry its target (a Chromium process can create a
 * desktop, a phone and a Pixel 7 touch context), so the context helpers that
 * already know the target tag it here. `captureScreenshot` then compares the
 * manifested file against the environment of the context that produced it
 * without every call site repeating the target.
 */
const contextTargets = new WeakMap();

/**
 * The latest fingerprint logged per target.
 *
 * `logCaptureEnvironment` already probes the image, fonts and EGL variables
 * when a context is created; the write-time guard reuses that fingerprint so a
 * run does not probe the same environment for every manifested PNG.
 */
const fingerprintsByTarget = new Map();

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
 * Every capture target the current process has recorded, across browsers.
 *
 * A capture script can use more than one browser (a Chromium run records
 * desktop, mobile and mobile-touch; a dedicated WebKit run records webkit), so
 * the run-level set is process-wide instead of scoped to a browser. The set
 * deduplicates by target, which is what the end-of-run declaration assertion
 * compares against.
 */
const recordedTargets = new Set();

/** Targets recorded so far in this process, in first-recording order. */
export function recordedCaptureTargets() {
  return [...recordedTargets];
}

/**
 * Clear the process-wide recorded set.
 *
 * The capture scripts run once per process, so they never need this; unit
 * tests share one module instance and use it to isolate cases.
 */
export function resetRecordedCaptureTargets() {
  recordedTargets.clear();
  fingerprintsByTarget.clear();
}

function recordCaptureTarget(target) {
  recordedTargets.add(target);
}

/**
 * Fail when the targets a run actually recorded differ from the declaration a
 * capture script made for its argv (Issue #293).
 *
 * The script's `captureTargets(args)` function is the declaration; the runtime
 * set is the evidence actually produced by the context helpers. Both an extra
 * recorded target and a declared target that never appeared are errors: the
 * first would inject a wrong `CAPTURE_TARGET` after the fact, the second would
 * promise evidence the run does not write. The message names every mismatching
 * target and the declaration source so the wrong branch or flag is obvious.
 *
 * `recorded` is injectable for tests; capture scripts rely on the process-wide
 * set populated by {@link logCaptureEnvironment}.
 */
export function assertAllDeclaredCaptureTargets(
  declared,
  { source = 'captureTargets(args)', recorded = recordedCaptureTargets() } = {},
) {
  const expected = normalizeCaptureTargets(declared);
  if (expected === null) {
    throw new Error(
      `Capture target declaration from ${source} is empty: a capture script must ` +
        'declare every target it records.',
    );
  }

  const actual = [...new Set(recorded)];
  const extra = actual.filter((target) => !expected.includes(target));
  const missing = expected.filter((target) => !actual.includes(target));
  if (extra.length === 0 && missing.length === 0) {
    return;
  }

  const differences = [];
  if (extra.length > 0) {
    differences.push(`recorded but not declared: ${extra.join(', ')}`);
  }
  if (missing.length > 0) {
    differences.push(`declared but not recorded: ${missing.join(', ')}`);
  }

  throw new Error(
    `Capture target declaration from ${source} does not match this run ` +
      `(declared: ${expected.join(',')}; recorded: ${actual.join(',') || '(none)'}): ` +
      `${differences.join('; ')}.`,
  );
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
  recordCaptureTarget(target);
  if (loggedTargetsByBrowser.get(browser)?.has(target)) {
    return;
  }
  try {
    const fingerprint = captureEnvironmentFingerprint({
      target,
      run: { browserVersion: browser.version(), ...run },
      env,
    });
    fingerprintsByTarget.set(target, fingerprint);
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
  contextTargets.set(context, 'desktop');
  logCaptureEnvironment('desktop', browser);
  return context;
}

/** Create a phone context and record the phone DPR-2 fingerprint. */
export async function createMobileContext(browser, options = {}) {
  const context = await browser.newContext(options);
  contextTargets.set(context, 'mobile');
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
  contextTargets.set(context, 'mobile-touch');
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
  const target = engine === WEBKIT_ENGINE ? 'webkit' : 'mobile';
  contextTargets.set(context, target);
  // WebKit phone evidence is its own target; Chromium phone evidence is the
  // `mobile` target of a run that also captures desktop.
  logCaptureEnvironment(target, browser);
  return context;
}

/** One-line record that ties a screenshot file to engine, viewport and theme. */
export function captureRecord(name, engine, viewport, colorScheme = 'dark', reducedMotion = 'reduce') {
  const size = viewport == null ? 'unknown' : `${viewport.width}x${viewport.height}`;
  return `${name}: engine=${engine}, viewport=${size}, theme=${colorScheme}, reducedMotion=${reducedMotion}`;
}

/** Consecutive whole-image frames the WebKit READY capture must repeat. */
export const READY_CAPTURE_STABLE_FRAMES = 2;

/** Delay between the frames checked for {@link READY_CAPTURE_STABLE_FRAMES}. */
export const READY_CAPTURE_STABLE_INTERVAL_MS = 250;

/** Extra frames the stable-frame check may read before giving up. */
export const READY_CAPTURE_STABLE_ATTEMPTS = 5;

function normalizeScreenshotBytes(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

/**
 * Read whole-image frames until `stableFrames` consecutive screenshots are
 * byte-identical (Issue #318).
 *
 * A single screenshot can race a pending repaint: the same settled page then
 * exposes two byte-identical frames, while a capture taken mid-repaint differs
 * by a handful of 1-LSB pixels. Capturing through this check makes that race
 * fail loudly instead of committing a transient frame as evidence. It detects
 * a sampled frame change within this run only; the caller's throwaway warm-up
 * page is what settles the first-page raster variant across runs.
 * With the default `stableFrames === 1` this is the previous single-shot
 * capture, so existing callers and their bytes stay unchanged.
 */
async function captureStableFramesBytes(
  page,
  {
    name,
    fullPage,
    animations,
    stableFrames,
    stableIntervalMs,
    stableAttempts,
  },
) {
  if (!Number.isInteger(stableFrames) || stableFrames < 1) {
    throw new TypeError(
      `captureScreenshot(${name}): stableFrames must be a positive integer, got ${String(stableFrames)}.`,
    );
  }
  if (!Number.isInteger(stableAttempts) || stableAttempts < 0) {
    throw new TypeError(
      `captureScreenshot(${name}): stableAttempts must be a non-negative integer, got ${String(stableAttempts)}.`,
    );
  }
  if (!Number.isInteger(stableIntervalMs) || stableIntervalMs <= 0) {
    throw new TypeError(
      `captureScreenshot(${name}): stableIntervalMs must be a positive integer, got ${String(stableIntervalMs)}.`,
    );
  }
  let bytes = normalizeScreenshotBytes(
    await page.screenshot({ fullPage, animations }),
  );
  if (stableFrames === 1) {
    return bytes;
  }

  let identical = 1;
  const observed = [createHash('sha256').update(bytes).digest('hex')];
  for (let attempt = 0; attempt < stableAttempts; attempt += 1) {
    await page.waitForTimeout(stableIntervalMs);
    const next = normalizeScreenshotBytes(
      await page.screenshot({ fullPage, animations }),
    );
    observed.push(createHash('sha256').update(next).digest('hex'));
    if (Buffer.compare(next, bytes) === 0) {
      identical += 1;
      if (identical >= stableFrames) {
        return next;
      }
    } else {
      identical = 1;
    }
    bytes = next;
  }

  throw new Error(
    `Screenshot ${name} did not produce ${stableFrames} consecutive byte-identical ` +
      `frames after ${stableAttempts + 1} capture${stableAttempts === 0 ? '' : 's'} ` +
      `(sha256: ${observed.join(', ')}). ` +
      'No file was written; wait for the pending repaint or widen the stability window ' +
      'instead of committing a transient frame.',
  );
}

/** Screenshots the stable-capture loop may take before it gives up. */
export const CAPTURE_STABLE_ATTEMPTS = 4;

/** Coerce a Playwright screenshot result to a Buffer. */
function screenshotBuffer(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

/**
 * Capture until two consecutive screenshots are byte-identical (Issue #199).
 *
 * A single screenshot can run ahead of WebKit's compositor under concurrent
 * host load: the sticky header seam removes the first-paint header drift, but
 * the READY overlay's blurred backdrop and card text can still be rasterised
 * on a later paint. Taking one screenshot is therefore unprovable; this seam
 * settles and re-captures until the pixels stop changing, so the bytes written
 * to disk are a stable raster rather than a sample of an in-flight one. It
 * throws instead of writing an unstable image when the page never settles.
 *
 * The initial screenshot is taken after a settle, and every later screenshot
 * follows another settle, so a caller that has not pre-settled still starts
 * from a painted frame. Two consecutive identical frames are treated as
 * stable: a raster that genuinely persists across a whole settle window is
 * indistinguishable from a finished one at this layer.
 *
 * The loop is opt-in per capture: existing call sites keep their single
 * screenshot (and therefore their byte-identical evidence) unchanged.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{
 *   fullPage?: boolean,
 *   animations?: 'allow' | 'disabled',
 *   attempts?: number,
 *   settle?: (page: import('@playwright/test').Page) => Promise<void>,
 * }} [options]
 * @returns {Promise<Buffer>}
 */
export async function captureStableBytes(
  page,
  {
    fullPage = false,
    animations = 'disabled',
    attempts = CAPTURE_STABLE_ATTEMPTS,
    settle = settleCapturePaint,
  } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 2) {
    throw new RangeError(
      `captureStableBytes needs at least two screenshots; got ${String(attempts)}.`,
    );
  }

  await settle(page);
  let previous = screenshotBuffer(await page.screenshot({ fullPage, animations }));
  for (let taken = 2; taken <= attempts; taken += 1) {
    await settle(page);
    const next = screenshotBuffer(await page.screenshot({ fullPage, animations }));
    if (next.equals(previous)) {
      return next;
    }
    previous = next;
  }

  throw new Error(
    `The capture did not stabilise after ${attempts} screenshots: no two consecutive ` +
      'screenshots were byte-identical. The page was still repainting; re-run the capture ' +
      'on an idle machine instead of committing an unstable image.',
  );
}

/**
 * Take one screenshot and log the engine / viewport / theme record. Callers
 * pass the same options as `page.screenshot`, so the Chromium bytes stay
 * unchanged.
 *
 * A file recorded in `docs/screenshots/capture-sha256-manifest.json` is guarded
 * before any byte is written (Issue #199): the environment fingerprint of the
 * context that produced it must match the manifest environment, otherwise a
 * host run or a different image / font / EGL stack fails instead of silently
 * replacing the fixed-environment evidence. A matching environment writes the
 * PNG atomically (temporary file + rename) and, when the new sha256 differs
 * from the manifest, prints the manifest / docs checklist while leaving the
 * manifest untouched so `npm run verify:screenshots:sha256` keeps failing.
 * Files the manifest does not record keep the previous single-shot
 * `page.screenshot` write path when neither `stable` nor `stableFrames > 1`
 * is set; either opt-in uses the same stable buffer + atomic write as a
 * manifested file.
 *
 * `stable: true` (Issue #199) replaces the single screenshot with
 * {@link captureStableBytes}: two consecutive byte-identical screenshots after
 * {@link settleCapturePaint}, for the 2048 WebKit READY overlay that can still
 * be mid-raster under concurrent host load. Every other call site keeps the
 * single-screenshot path and therefore its existing bytes.
 *
 * `stableFrames > 1` (Issue #318) uses the interval-based
 * {@link captureStableFramesBytes} instead; the minesweeper WebKit READY
 * capture passes {@link READY_CAPTURE_STABLE_FRAMES} so two consecutive
 * identical frames are required before the PNG is written.
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
    stable = false,
    stableFrames = 1,
    stableIntervalMs = READY_CAPTURE_STABLE_INTERVAL_MS,
    stableAttempts = READY_CAPTURE_STABLE_ATTEMPTS,
    target,
    manifest,
    manifestPath = resolve(CAPTURE_REPO_ROOT, DEFAULT_MANIFEST_PATH),
    readFile = readFileSync,
    fileOperations = {},
    env,
    run,
    fingerprint,
    log = console,
  },
) {
  const path = `${outputDir}/${name}`;
  const parsedManifest = loadSha256Manifest({ manifest, manifestPath, readFile });
  const capture =
    parsedManifest === null ? null : findSha256ManifestCapture(parsedManifest, name);

  if (capture === null) {
    // Unrecorded evidence: keep the existing path byte-for-byte unless the
    // caller explicitly asks for a stability check.
    if (stable) {
      const buffer = await captureStableBytes(page, { fullPage, animations });
      writeFileAtomically(path, buffer, fileOperations);
    } else if (stableFrames !== 1) {
      const buffer = await captureStableFramesBytes(page, {
        name,
        fullPage,
        animations,
        stableFrames,
        stableIntervalMs,
        stableAttempts,
      });
      writeFileAtomically(path, buffer, fileOperations);
    } else {
      await page.screenshot({ path, fullPage, animations });
    }
    console.log(captureRecord(name, engine, page.viewportSize(), colorScheme, reducedMotion));
    return;
  }

  const captureTarget = target ?? manifestedCaptureTarget(page, engine);
  const actualFingerprint =
    fingerprint ?? fingerprintForTarget(captureTarget, { env, run });
  const comparison = compareCaptureEnvironmentFingerprint(
    actualFingerprint,
    parsedManifest.environment,
  );
  if (comparison.problems.length > 0) {
    throw new Error(
      manifestedEnvironmentErrorMessage({
        name,
        path,
        manifestLabel: manifestLabelFor({ manifest, manifestPath }),
        environment: parsedManifest.environment,
        capture,
        comparison,
        fingerprint: actualFingerprint,
      }),
    );
  }

  // The guard passed: capture to memory first, so a failing screenshot never
  // replaces the committed PNG, then write it atomically in the same directory.
  const buffer = stable
    ? await captureStableBytes(page, { fullPage, animations })
    : stableFrames !== 1
      ? await captureStableFramesBytes(page, {
          name,
          fullPage,
          animations,
          stableFrames,
          stableIntervalMs,
          stableAttempts,
        })
      : normalizeScreenshotBytes(await page.screenshot({ fullPage, animations }));
  writeFileAtomically(path, buffer, fileOperations);

  const actualSha256 = createHash('sha256').update(buffer).digest('hex');
  if (actualSha256 !== capture.sha256) {
    log.warn(
      manifestHashDriftChecklist({
        file: name,
        path,
        manifest: parsedManifest,
        capture,
        actualSha256,
      }),
    );
  }

  console.log(captureRecord(name, engine, page.viewportSize(), colorScheme, reducedMotion));
}

/**
 * Read and validate the sha256 manifest that drives the write-time guard.
 *
 * A missing manifest (for example a trimmed checkout) means no file is
 * recorded, so unrecorded evidence keeps its normal write path. Any other read
 * or parse failure is fail-closed: writing a screenshot the manifest cannot
 * describe would silently bypass the guard.
 */
function loadSha256Manifest({ manifest, manifestPath, readFile }) {
  if (manifest !== undefined) {
    return manifest === null ? null : manifest;
  }

  let text;
  try {
    text = readFile(manifestPath, 'utf8');
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') {
      return null;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot read the screenshot sha256 manifest ${manifestPath} before writing a screenshot: ` +
        `${detail}. Restore the manifest or capture through a clean checkout.`,
    );
  }

  try {
    return parseSha256Manifest(text, { source: manifestPath });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot parse the screenshot sha256 manifest ${manifestPath} before writing a screenshot: ` +
        `${detail}. Fix the manifest instead of writing evidence it cannot describe.`,
    );
  }
}

/**
 * The target of the context that produced `page`.
 *
 * Context helpers tag every context they create, so a script that captures
 * desktop / phone / touch evidence in one Chromium run still compares each
 * manifested file against its own target. A page created without a helper
 * falls back to the engine's only target (WebKit) or desktop, which keeps the
 * guard fail-closed: a mismatch is reported instead of being accepted.
 */
function manifestedCaptureTarget(page, engine) {
  let context = null;
  try {
    context = page.context?.() ?? null;
  } catch {
    context = null;
  }
  const tagged = context === null ? null : (contextTargets.get(context) ?? null);
  if (tagged !== null) {
    return tagged;
  }
  return engine === WEBKIT_ENGINE ? 'webkit' : 'desktop';
}

/** Reuse the context-creation fingerprint, or build one for this target. */
function fingerprintForTarget(target, { env, run }) {
  if (env === undefined && run === undefined) {
    const cached = fingerprintsByTarget.get(target);
    if (cached !== undefined) {
      return cached;
    }
  }
  return captureEnvironmentFingerprint({ target, env: env ?? process.env, run });
}

function manifestLabelFor({ manifest, manifestPath }) {
  if (manifest !== undefined) {
    return DEFAULT_MANIFEST_PATH;
  }
  return resolve(manifestPath) === resolve(CAPTURE_REPO_ROOT, DEFAULT_MANIFEST_PATH)
    ? DEFAULT_MANIFEST_PATH
    : manifestPath;
}

/** Readable refusal naming the file, both fingerprints and the recapture command. */
function manifestedEnvironmentErrorMessage({
  name,
  path,
  manifestLabel,
  environment,
  capture,
  comparison,
  fingerprint,
}) {
  return [
    `Refusing to write ${path} before writing any bytes: ${name} is tracked by ` +
      `${manifestLabel}, but this capture does not match the fixed environment recorded for it.`,
    `Expected environment fingerprint: ${formatManifestCaptureEnvironment(environment)}`,
    `Actual environment fingerprint: ${formatCaptureEnvironmentFingerprint(fingerprint)}`,
    `Differences: ${comparison.problems.join('; ')}`,
    `Re-capture inside the fixed container: ${capture.command}`,
    'The target PNG was not created or replaced.',
  ].join('\n');
}

/** The checklist printed when a fixed-environment capture changes a hash. */
function manifestHashDriftChecklist({ file, path, manifest, capture, actualSha256 }) {
  const index = manifest.captures.indexOf(capture);
  const command = capture.command;
  return [
    `Wrote ${path} inside the fixed capture environment, but its sha256 differs from ` +
      `${DEFAULT_MANIFEST_PATH}:`,
    `  manifest sha256: ${capture.sha256}`,
    `  captured sha256: ${actualSha256}`,
    'The PNG was written, but the recorded evidence is stale until the following are updated ' +
      'in the same change:',
    `- ${DEFAULT_MANIFEST_PATH}: captures[${index}].sha256 -> ${actualSha256}`,
    `- ${DEFAULT_MANIFEST_PATH}: captures[${index}].provenance.captureCommit -> ` +
      'the commit that produced the new PNG',
    `- docs/screenshots/README.md: the sha256 / capture commit / size row for ${file}`,
    `- docs/screenshots/README.md: the provenance note / table for ${file}`,
    `Until those are updated, npm run verify:screenshots:sha256 keeps failing on the stale ` +
      `sha256 for ${file}. Re-capture with: ${command}`,
  ].join('\n');
}

/** Monotonic suffix so two writes in the same millisecond cannot collide. */
let tempFileCounter = 0;

/**
 * Write a PNG through a temporary sibling and rename it into place.
 *
 * `fileOperations.renameSync` is replaceable so unit tests can fail the swap
 * after the temporary file exists, proving the committed PNG is not replaced
 * and the temporary sibling is removed. The successful path (same bytes, no
 * leftover temporary file) is covered by the normal write test.
 */
function writeFileAtomically(path, bytes, { renameSync: replaceTarget = renameSync } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  tempFileCounter += 1;
  const tempPath = `${path}.tmp-${process.pid}-${tempFileCounter}`;
  try {
    writeFileSync(tempPath, bytes);
    replaceTarget(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temporary file may not exist; the original error is what matters.
    }
    throw error;
  }
}

/** Animation frames the shared capture settle seam waits for. */
export const CAPTURE_SETTLE_FRAMES = 2;

/** Fallback wait after those frames, in milliseconds. */
export const CAPTURE_SETTLE_TIMEOUT_MS = 300;

/**
 * Wait until fonts, two animation frames and a short fallback timeout settle.
 *
 * Shared by the deterministic READY seams so they wait exactly like the
 * already deterministic playing / gameover captures.
 */
export async function settleCapturePaint(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        let remaining = frames;
        const frame = () => {
          remaining -= 1;
          if (remaining <= 0) {
            resolve();
          } else {
            requestAnimationFrame(frame);
          }
        };
        requestAnimationFrame(frame);
      }),
    CAPTURE_SETTLE_FRAMES,
  );
  await page.waitForTimeout(CAPTURE_SETTLE_TIMEOUT_MS);
}

/**
 * Deterministic first-paint seam for the WebKit READY captures (Issue #199 /
 * #318).
 *
 * A fresh browser can rasterise the sticky site header in two subtly different
 * ways: the same DOM boxes and board differ by a small number of pixels with a
 * per-channel difference of one. A scroll round-trip drives the sticky header
 * through its normal repaint path and converges on one rasterisation. The
 * position is restored to 0 so the screenshot still shows the top of the page;
 * {@link settleCapturePaint} then waits for fonts and frames.
 *
 * Both the 2048 and minesweeper READY captures use this seam. The minesweeper
 * caller additionally loads a throwaway warm-up page so the committed READY
 * page is not the browser's first page. The playing / lost / won (or gameover)
 * evidence is already deterministic and must never be wired into those scenes.
 */
export async function settleWebkitReadyPaint(page, { offset = 200 } = {}) {
  await page.evaluate((distance) => window.scrollTo(0, distance), offset);
  await page.waitForFunction(() => window.scrollY > 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => window.scrollY === 0);
  await settleCapturePaint(page);
}

/**
 * Force the WebKit READY overlay and its blurred backdrop through a fresh
 * paint (Issue #199).
 *
 * The header seam fixes the sticky header, but under concurrent host load the
 * READY card can still be composited from two subtly different rasters: about
 * 8895 pixels differ by at most two channel values, all inside the card, and
 * two consecutive screenshots of that wrong composite still agree. Hiding the
 * overlay for two frames and restoring it makes the card repaint on the
 * canonical path. The overlay is hidden only between frames, never in a
 * captured image.
 *
 * The 2048 READY capture and the minesweeper lost WebKit capture use this
 * seam; playing / gameover bytes must not change.
 */
export async function repaintWebkitReadyOverlay(
  page,
  { settle = settleCapturePaint } = {},
) {
  await page.evaluate(async () => {
    const overlay = document.querySelector('[data-testid="overlay"]');
    if (!(overlay instanceof HTMLElement)) return;
    overlay.style.display = 'none';
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
    });
    overlay.style.display = '';
  });
  await settle(page);
}
