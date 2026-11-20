#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CAPTURE_REPO_ROOT } from './lib/capture-env.mjs';
import {
  DEFAULT_MANIFEST_PATH,
  parseSha256Manifest,
} from './lib/screenshot-sha256.mjs';
import {
  DEFAULT_REPRO_LOAD_RUNS,
  DEFAULT_REPRO_LOAD_TARGETS,
  DEFAULT_REPRO_LOAD_WORKERS,
  MIN_REPRO_LOAD_RUNS,
  REPRO_LOAD_INPUT_ENV,
  formatGithubOutput,
  manifestCaptureTargets,
  normalizeReproLoadInputs,
} from './lib/repro-load-inputs.mjs';

const USAGE = `Usage: node scripts/check-repro-load-inputs.mjs [options]

Validate the workflow_dispatch inputs of .github/workflows/capture-repro-load.yml
and write the normalized values to $GITHUB_OUTPUT, so the capture step never
splices a raw dispatch input into a \`run:\` script.

The raw inputs come from the workflow env:
  ${REPRO_LOAD_INPUT_ENV.targets}
                     comma-separated manifest capture targets
                     (default: ${DEFAULT_REPRO_LOAD_TARGETS.join(',')})
  ${REPRO_LOAD_INPUT_ENV.runs}
                     runs per target, integer >= ${MIN_REPRO_LOAD_RUNS} (default: ${DEFAULT_REPRO_LOAD_RUNS})
  ${REPRO_LOAD_INPUT_ENV.load}
                     CPU load worker processes, positive integer
                     (default: ${DEFAULT_REPRO_LOAD_WORKERS})

Options:
  --manifest <path>  sha256 manifest (default: ${DEFAULT_MANIFEST_PATH})
  --output <path>    file that receives the targets= / runs= / load= lines
                     (default: $GITHUB_OUTPUT)
  -h, --help         show this help

Exit codes: 0 valid inputs were written, 1 the output file cannot be written,
            2 usage, an invalid input or an unreadable manifest.`;

/** Parse the small CLI option set. Unknown options are usage errors. */
export function parseArgs(argv) {
  const options = { help: false, manifest: DEFAULT_MANIFEST_PATH, output: null };
  const valued = new Set(['--manifest', '--output']);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { ...options, help: true };
    }
    if (!valued.has(arg)) {
      throw new Error(`unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`${arg} needs a value`);
    }
    index += 1;
    if (arg === '--manifest') {
      options.manifest = value;
    } else {
      options.output = value;
    }
  }

  return options;
}

/**
 * Validate the dispatch inputs and publish them as step outputs.
 *
 * The read / write seams are injectable so unit tests can use fixture manifests
 * and temporary output files without touching a real GitHub runner.
 */
export function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    logger = console,
    repoRoot = CAPTURE_REPO_ROOT,
    readText = (path) => readFileSync(path, 'utf8'),
    writeOutput = appendFileSync,
  } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`error: ${detail}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    logger.log(USAGE);
    return 0;
  }

  const outputPath = options.output ?? env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath === '') {
    logger.error(
      'error: GITHUB_OUTPUT is not set; pass --output <path> when running outside a workflow.',
    );
    return 2;
  }

  let inputs;
  try {
    const manifestPath = resolve(repoRoot, options.manifest);
    const manifest = parseSha256Manifest(readText(manifestPath), { source: manifestPath });
    inputs = normalizeReproLoadInputs(
      {
        targets: env[REPRO_LOAD_INPUT_ENV.targets],
        runs: env[REPRO_LOAD_INPUT_ENV.runs],
        load: env[REPRO_LOAD_INPUT_ENV.load],
      },
      manifestCaptureTargets(manifest),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`error: ${detail}`);
    return 2;
  }

  try {
    writeOutput(outputPath, formatGithubOutput(inputs));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`error: cannot write the step outputs to ${outputPath}: ${detail}`);
    return 1;
  }

  logger.log(
    `OK: ${inputs.targets.length} target(s) x ${inputs.runs} runs under ` +
      `${inputs.load} CPU load worker(s): ${inputs.targets.join(', ')}.`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = main();
}
