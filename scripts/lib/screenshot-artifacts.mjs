import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reusable validator for the committed WebKit screenshot evidence.
 *
 * The capture scripts write PNG files and log one
 * `engine=…, viewport=…` record per file (see `captureRecord` in
 * `./capture-runtime.mjs`). This module parses the PNG signature and the IHDR
 * width/height itself, so verification needs neither Playwright nor an image
 * decoder, and compares the bytes with an explicit manifest of the committed
 * `-webkit` artifacts.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The 12-byte IEND chunk that closes every complete PNG file. */
const PNG_IEND_CHUNK = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** The iPhone SE (3rd gen) WebKit device uses a 2x device pixel ratio. */
export const WEBKIT_DEVICE_SCALE_FACTOR = 2;

export const DEFAULT_SCREENSHOT_DIR = 'docs/screenshots';

/** iPhone SE (3rd gen) viewport used by the stable WebKit phone captures. */
const WEBKIT_PHONE_VIEWPORT = Object.freeze({ width: 375, height: 667 });
/** The scores panel is captured with an explicit 320x640 viewport. */
const WEBKIT_SCORES_VIEWPORT = Object.freeze({ width: 320, height: 640 });

/** Raised when a file cannot be read as a complete PNG. */
export class ScreenshotArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScreenshotArtifactError';
  }
}

function webkitArtifact(file, viewport, { narrow = false, fullPagePixelHeight } = {}) {
  const artifact = {
    file,
    viewport: Object.freeze({ width: viewport.width, height: viewport.height }),
    narrow,
  };
  if (fullPagePixelHeight !== undefined) {
    artifact.fullPagePixelHeight = fullPagePixelHeight;
  }
  return Object.freeze(artifact);
}

/**
 * The expected WebKit artifacts under `docs/screenshots/`.
 *
 * Pixel dimensions follow the CSS viewport at the 2x device pixel ratio, so the
 * 375x667 phone viewport must produce a 750x1334 PNG. `after-minesweeper-scores`
 * is a full-page capture whose height depends on the rendered leaderboard:
 * its width still follows the 320x640 viewport, while the committed full-page
 * height is pinned so a stale or regenerated-at-a-different-size artifact is
 * still detected.
 */
export const WEBKIT_SCREENSHOT_ARTIFACTS = Object.freeze([
  // webkit-phone (`--webkit`): 375x667 CSS px at DPR 2.
  webkitArtifact('after-hub-webkit.png', WEBKIT_PHONE_VIEWPORT),
  webkitArtifact('after-blank-webkit.png', WEBKIT_PHONE_VIEWPORT),
  webkitArtifact('after-snake-webkit.png', WEBKIT_PHONE_VIEWPORT),
  webkitArtifact('after-2048-ready-webkit.png', WEBKIT_PHONE_VIEWPORT),
  webkitArtifact('after-2048-playing-webkit.png', WEBKIT_PHONE_VIEWPORT),
  webkitArtifact('after-2048-gameover-webkit.png', WEBKIT_PHONE_VIEWPORT),
  webkitArtifact('after-breakout-ready-webkit.png', WEBKIT_PHONE_VIEWPORT),
  webkitArtifact('after-breakout-playing-webkit.png', WEBKIT_PHONE_VIEWPORT),
  webkitArtifact('after-breakout-levelclear-webkit.png', WEBKIT_PHONE_VIEWPORT),
  webkitArtifact('after-breakout-gameover-webkit.png', WEBKIT_PHONE_VIEWPORT),
  webkitArtifact('after-minesweeper-ready-webkit.png', WEBKIT_PHONE_VIEWPORT),
  webkitArtifact('after-minesweeper-playing-webkit.png', WEBKIT_PHONE_VIEWPORT),
  webkitArtifact('after-minesweeper-lost-webkit.png', WEBKIT_PHONE_VIEWPORT),
  webkitArtifact('after-minesweeper-won-webkit.png', WEBKIT_PHONE_VIEWPORT),

  // scores (`--webkit`): explicit 320x640 viewport, full-page screenshot.
  webkitArtifact('after-minesweeper-scores-webkit.png', WEBKIT_SCORES_VIEWPORT, {
    fullPagePixelHeight: 4146,
  }),

  // webkit-narrow (`--webkit-narrow`): four explicit viewports at DPR 2.
  webkitArtifact(
    'after-minesweeper-webkit-narrow-320x640.png',
    { width: 320, height: 640 },
    { narrow: true },
  ),
  webkitArtifact(
    'after-minesweeper-webkit-narrow-360x640.png',
    { width: 360, height: 640 },
    { narrow: true },
  ),
  webkitArtifact(
    'after-minesweeper-webkit-narrow-375x667.png',
    { width: 375, height: 667 },
    { narrow: true },
  ),
  webkitArtifact(
    'after-minesweeper-webkit-narrow-412x839.png',
    { width: 412, height: 839 },
    { narrow: true },
  ),

  // webkit-narrow-before: the same matrix against the pre-touch baseline.
  webkitArtifact(
    'before-minesweeper-webkit-narrow-320x640.png',
    { width: 320, height: 640 },
    { narrow: true },
  ),
  webkitArtifact(
    'before-minesweeper-webkit-narrow-360x640.png',
    { width: 360, height: 640 },
    { narrow: true },
  ),
  webkitArtifact(
    'before-minesweeper-webkit-narrow-375x667.png',
    { width: 375, height: 667 },
    { narrow: true },
  ),
  webkitArtifact(
    'before-minesweeper-webkit-narrow-412x839.png',
    { width: 412, height: 839 },
    { narrow: true },
  ),
]);

/** Offset of the IHDR data inside a PNG: 8-byte signature + chunk header. */
const IHDR_DATA_OFFSET = 16;
/** A complete first chunk is 4-byte length + 4-byte type + 13 data + 4-byte CRC. */
const MIN_IHDR_CHUNK_END = 8 + 8 + 13 + 4;

/**
 * Read the IHDR size from complete PNG bytes.
 *
 * Rejects a file that is not a PNG, a file truncated before the IHDR width /
 * height are complete, and a file whose closing IEND chunk is missing (for
 * example a capture cut off after its first IDAT chunk).
 */
export function parsePng(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  if (
    buffer.length < PNG_SIGNATURE.length ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new ScreenshotArtifactError('not a PNG file (missing the 8-byte PNG signature)');
  }

  if (buffer.length < MIN_IHDR_CHUNK_END) {
    throw new ScreenshotArtifactError(
      `truncated PNG file (${buffer.length} bytes cannot hold a complete IHDR chunk)`,
    );
  }

  if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ScreenshotArtifactError(
      'invalid PNG file (the first chunk is not a 13-byte IHDR)',
    );
  }

  if (!buffer.subarray(buffer.length - PNG_IEND_CHUNK.length).equals(PNG_IEND_CHUNK)) {
    throw new ScreenshotArtifactError('truncated PNG file (missing the closing IEND chunk)');
  }

  const width = buffer.readUInt32BE(IHDR_DATA_OFFSET);
  const height = buffer.readUInt32BE(IHDR_DATA_OFFSET + 4);
  if (width === 0 || height === 0) {
    throw new ScreenshotArtifactError(
      `invalid PNG file (IHDR reports ${width}x${height} pixels)`,
    );
  }

  return { width, height };
}

/** Read a PNG file and return its IHDR pixel size. */
export function readPngSize(filePath) {
  return parsePng(readFileSync(filePath));
}

/** Expected pixel size of one artifact at the capture device scale factor. */
export function expectedPixelSize(artifact, deviceScaleFactor = WEBKIT_DEVICE_SCALE_FACTOR) {
  if (!Number.isInteger(deviceScaleFactor) || deviceScaleFactor <= 0) {
    throw new ScreenshotArtifactError(`invalid device scale factor: ${deviceScaleFactor}`);
  }
  return {
    width: artifact.viewport.width * deviceScaleFactor,
    height: artifact.fullPagePixelHeight ?? artifact.viewport.height * deviceScaleFactor,
  };
}

/**
 * Check that an artifact's file name encodes its engine and, for narrow
 * captures, the logical viewport the file was taken at.
 *
 * Returns a problem message or `null` when the name is valid.
 */
export function checkArtifactName(artifact) {
  const { file, viewport, narrow } = artifact;

  if (!file.endsWith('.png')) {
    return `expected a .png file name, got "${file}"`;
  }

  if (narrow) {
    const suffix = `-webkit-narrow-${viewport.width}x${viewport.height}.png`;
    if (!file.endsWith(suffix)) {
      return `expected a WebKit narrow file name ending in "${suffix}", got "${file}"`;
    }
    return null;
  }

  if (!file.endsWith('-webkit.png')) {
    return `expected a WebKit file name ending in "-webkit.png", got "${file}"`;
  }
  if (file.includes('-webkit-narrow-')) {
    return `expected a narrow viewport suffix for a narrow capture, got "${file}"`;
  }
  return null;
}

/**
 * Parse the `captureRecord` lines a capture script writes after each image.
 *
 * Unrelated log lines are ignored; each recognized line is keyed by file name.
 */
export function parseCaptureLog(text) {
  const records = new Map();
  const pattern =
    /^(?<file>[^:\n]+\.png): engine=(?<engine>[a-z]+), viewport=(?<width>\d+)x(?<height>\d+), theme=(?<theme>[^,\n]+), reducedMotion=(?<motion>[^,\n]+)$/;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const groups = pattern.exec(line)?.groups;
    if (groups == null) continue;
    records.set(groups.file, {
      file: groups.file,
      engine: groups.engine,
      viewport: { width: Number(groups.width), height: Number(groups.height) },
      line,
    });
  }

  return records;
}

/**
 * Require one `engine=webkit` record per expected artifact, with the logical
 * viewport the artifact was captured at. Returns problem entries; extra log
 * records that are not part of the manifest are ignored.
 */
export function verifyCaptureLog(text, manifest = WEBKIT_SCREENSHOT_ARTIFACTS) {
  const records = parseCaptureLog(text);
  const problems = [];

  for (const artifact of manifest) {
    const record = records.get(artifact.file);
    if (record == null) {
      problems.push({
        file: artifact.file,
        message:
          `missing capture log record (expected engine=webkit, ` +
          `viewport=${artifact.viewport.width}x${artifact.viewport.height})`,
      });
      continue;
    }

    if (record.engine !== 'webkit') {
      problems.push({
        file: artifact.file,
        message: `capture log record has engine=${record.engine}, expected engine=webkit`,
      });
    }

    if (
      record.viewport.width !== artifact.viewport.width ||
      record.viewport.height !== artifact.viewport.height
    ) {
      problems.push({
        file: artifact.file,
        message:
          `capture log record has viewport=${record.viewport.width}x${record.viewport.height}, ` +
          `expected viewport=${artifact.viewport.width}x${artifact.viewport.height}`,
      });
    }
  }

  return problems;
}

/**
 * Verify the manifest against a screenshot directory.
 *
 * Every artifact must exist, be a complete PNG with the expected pixel size,
 * and carry the expected WebKit file name. When `logText` is supplied, each
 * artifact also needs a matching `engine=webkit` capture record.
 *
 * @returns {{ artifacts: number, problems: Array<{ file: string, message: string }> }}
 */
export function verifyScreenshotArtifacts({
  dir = DEFAULT_SCREENSHOT_DIR,
  manifest = WEBKIT_SCREENSHOT_ARTIFACTS,
  deviceScaleFactor = WEBKIT_DEVICE_SCALE_FACTOR,
  logText,
} = {}) {
  const problems = [];

  for (const artifact of manifest) {
    const filePath = join(dir, artifact.file);

    const nameProblem = checkArtifactName(artifact);
    if (nameProblem != null) {
      problems.push({ file: artifact.file, message: nameProblem });
    }

    let actual;
    try {
      actual = readPngSize(filePath);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') {
        problems.push({ file: artifact.file, message: `missing file: ${filePath}` });
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        problems.push({ file: artifact.file, message: `${filePath}: ${detail}` });
      }
      continue;
    }

    const expected = expectedPixelSize(artifact, deviceScaleFactor);
    if (actual.width !== expected.width || actual.height !== expected.height) {
      const source =
        artifact.fullPagePixelHeight === undefined
          ? `${artifact.viewport.width}x${artifact.viewport.height} CSS px at DPR ${deviceScaleFactor}`
          : `${artifact.viewport.width}x${artifact.viewport.height} CSS px at DPR ${deviceScaleFactor}, ` +
            `full-page height ${artifact.fullPagePixelHeight}`;
      problems.push({
        file: artifact.file,
        message:
          `${filePath}: expected ${expected.width}x${expected.height} pixels (${source}), ` +
          `got ${actual.width}x${actual.height}`,
      });
    }
  }

  if (logText !== undefined) {
    problems.push(...verifyCaptureLog(logText, manifest));
  }

  return { artifacts: manifest.length, problems };
}
