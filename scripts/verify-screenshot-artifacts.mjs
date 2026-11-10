import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_SCREENSHOT_DIR,
  WEBKIT_SCREENSHOT_ARTIFACTS,
  verifyScreenshotArtifacts,
} from './lib/screenshot-artifacts.mjs';

const USAGE = `Usage: node scripts/verify-screenshot-artifacts.mjs [options]

Verify the committed WebKit screenshot evidence: PNG signature + IHDR size,
expected file name, and (with --log) the capture log's engine=webkit records.

Options:
  --dir <path>       screenshot directory (default: ${DEFAULT_SCREENSHOT_DIR})
  --manifest <path>  JSON array of expected artifacts (default: built-in WebKit list)
  --log <path>       capture log to check for one engine=webkit record per artifact
  -h, --help         show this help

Exit codes: 0 all checks pass, 1 verification failed, 2 usage or I/O error.`;

function parseArgs(argv) {
  const options = { dir: DEFAULT_SCREENSHOT_DIR, manifest: null, log: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (arg !== '--dir' && arg !== '--manifest' && arg !== '--log') {
      throw new Error(`unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`${arg} needs a value`);
    }
    index += 1;
    if (arg === '--dir') {
      options.dir = value;
    } else if (arg === '--manifest') {
      options.manifest = value;
    } else {
      options.log = value;
    }
  }

  return options;
}

/** Load and validate a JSON manifest for callers that do not use the built-in list. */
function loadManifest(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read manifest ${filePath}: ${detail}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`manifest ${filePath} must be a non-empty JSON array of artifacts`);
  }

  return parsed.map((entry, index) => {
    const label = `manifest ${filePath} entry ${index + 1}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label} must be an object`);
    }

    const { file, viewport, narrow, fullPagePixelHeight } = entry;
    if (typeof file !== 'string' || file.trim() === '') {
      throw new Error(`${label} needs a non-empty "file" string`);
    }
    if (
      viewport === null ||
      typeof viewport !== 'object' ||
      !Number.isInteger(viewport.width) ||
      viewport.width <= 0 ||
      !Number.isInteger(viewport.height) ||
      viewport.height <= 0
    ) {
      throw new Error(`${label} needs a "viewport" with positive integer width and height`);
    }
    if (narrow !== undefined && typeof narrow !== 'boolean') {
      throw new Error(`${label} has a non-boolean "narrow"`);
    }
    if (
      fullPagePixelHeight !== undefined &&
      (!Number.isInteger(fullPagePixelHeight) || fullPagePixelHeight <= 0)
    ) {
      throw new Error(`${label} has an invalid "fullPagePixelHeight"`);
    }

    return {
      file,
      viewport: { width: viewport.width, height: viewport.height },
      narrow: narrow === true,
      fullPagePixelHeight,
    };
  });
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`error: ${detail}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  let manifest = WEBKIT_SCREENSHOT_ARTIFACTS;
  let logText;
  try {
    if (options.manifest !== null) {
      manifest = loadManifest(options.manifest);
    }
    if (options.log !== null) {
      logText = readFileSync(options.log, 'utf8');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`error: ${detail}`);
    return 2;
  }

  const dir = resolve(options.dir);
  const { artifacts, problems } = verifyScreenshotArtifacts({ dir, manifest, logText });

  if (problems.length > 0) {
    console.error(
      `FAIL: ${problems.length} screenshot artifact problem(s) across ` +
        `${artifacts} expected WebKit artifacts in ${dir}:`,
    );
    for (const problem of problems) {
      console.error(`  ${problem.file}: ${problem.message}`);
    }
    return 1;
  }

  const logNote = logText === undefined ? '' : '; capture log records verified';
  console.log(`OK: ${artifacts} WebKit screenshot artifacts verified in ${dir}${logNote}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
