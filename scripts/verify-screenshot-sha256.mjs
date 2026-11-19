#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_MANIFEST_PATH,
  DEFAULT_SCREENSHOT_DIR,
  ScreenshotSha256Error,
  expectedRecaptureCommand,
  imageReference,
  manifestEnvironmentMismatches,
  manifestPlatformMismatch,
  parseSha256Manifest,
  verifyScreenshotSha256,
} from './lib/screenshot-sha256.mjs';

const USAGE = `Usage: node scripts/verify-screenshot-sha256.mjs [options]

Verify the fixed-environment screenshot evidence against
${DEFAULT_MANIFEST_PATH}: each PNG must exist and hash to its recorded
sha256. With --log the capture environment fingerprint printed by the capture
runtime is checked too, and environment drift is reported separately from a
changed PNG. A log that contains the runtime's sha256 drift checklist is also
checked: every captured sha256 must equal the current manifest entry. A log
with no drift checklist keeps the previous behaviour and skips that check, so
older logs remain usable.

Options:
  --dir <path>       screenshot directory (default: ${DEFAULT_SCREENSHOT_DIR})
  --manifest <path>  sha256 manifest (default: ${DEFAULT_MANIFEST_PATH})
  --log <path>       capture log with capture-env fingerprint line(s) and/or
                     the sha256 drift checklist printed by the capture runtime
  -h, --help         show this help

Exit codes: 0 all checks pass, 1 hash, environment, platform or capture-log
            sha256 mismatch, 2 usage, invalid manifest, unreadable
            manifest/log, malformed capture-env line or malformed capture-log
            sha256 drift record. A missing or changed PNG is a hash failure (1);
            a platform difference is printed as its own section and exits 1.
            A captured sha256 that differs from the manifest, or a captured
            file the manifest does not record, is a capture-log sha256 failure
            (1); a drift checklist with missing, repeated or non-64-hex-lower-
            case fields is invalid input (2). Logs without a drift checklist
            are accepted unchanged for compatibility.`;

function parseArgs(argv) {
  const options = {
    dir: DEFAULT_SCREENSHOT_DIR,
    manifest: DEFAULT_MANIFEST_PATH,
    log: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (arg !== '--dir' && arg !== '--manifest' && arg !== '--log') {
      throw new ScreenshotSha256Error(`unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new ScreenshotSha256Error(`${arg} needs a value`);
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

function readText(filePath, label) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScreenshotSha256Error(`cannot read ${label} ${filePath}: ${detail}`);
  }
}

function environmentLines(environment) {
  if (!environment.checked) {
    return ['unavailable (no --log supplied)'];
  }
  if (environment.fingerprints.length > 0) {
    return environment.fingerprints.map((fingerprint) => fingerprint.line);
  }
  return ['unavailable (no matching capture-env fingerprint in the log)'];
}

function printActualEnvironment(environment) {
  const lines = environmentLines(environment);
  console.error('Actual capture environment:');
  for (const line of lines) {
    console.error(`  ${line}`);
  }
}

function printHashProblems(hashProblems, captureByFile, entries, dir) {
  console.error(
    `FAIL: ${hashProblems.length} screenshot sha256 problem(s) across ` +
      `${entries} entries in ${dir}:`,
  );
  for (const problem of hashProblems) {
    console.error(`  ${problem.file}: ${problem.message}`);
    console.error(`    expected sha256: ${problem.expected}`);
    console.error(`    actual sha256:   ${problem.actual ?? 'unavailable'}`);
    const capture = captureByFile.get(problem.file);
    if (capture !== undefined) {
      console.error(`    recapture in fixed container: ${capture.command}`);
    }
  }
}

function printLogHashProblems(problems, captureByFile) {
  console.error(`FAIL: ${problems.length} capture-log captured sha256 problem(s):`);
  for (const problem of problems) {
    console.error(`  ${problem.file}: ${problem.message}`);
    console.error(
      `    expected sha256: ${problem.expected ?? 'not recorded in the manifest'}`,
    );
    console.error(`    captured sha256: ${problem.actual}`);
    const capture = captureByFile.get(problem.file);
    if (capture !== undefined) {
      console.error(`    recapture in fixed container: ${capture.command}`);
    } else {
      // Without a manifest entry there is no reliable target to derive, so do
      // not print a guessed fixed-container command that could recapture the
      // wrong file.
      console.error(
        '    recapture with the script that wrote this file, then add it to the manifest.',
      );
    }
  }
}

function printPlatformMismatches(mismatches, manifest) {
  const labels = {
    manifest: 'sha256 manifest',
    log: 'capture log fingerprint',
  };
  console.error(`Platform mismatch (${mismatches.length}):`);
  for (const mismatch of mismatches) {
    console.error(`  source:            ${labels[mismatch.source] ?? mismatch.source}`);
    console.error(`  expected platform: ${mismatch.expected}`);
    console.error(`  actual platform:   ${mismatch.actual}`);
    if (mismatch.image !== null) {
      console.error(`  expected image:    ${imageReference(mismatch.image)}`);
    }
    if (mismatch.actualImage !== undefined && mismatch.actualImage !== null) {
      console.error(`  actual image:      ${imageReference(mismatch.actualImage)}`);
    }
  }
  console.error('Recapture in the fixed container after an explicit evidence refresh:');
  for (const capture of manifest.captures) {
    console.error(`  ${capture.file}: ${expectedRecaptureCommand(capture.file)}`);
  }
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

  const dir = resolve(options.dir);
  const manifestPath = resolve(options.manifest);

  let manifest;
  try {
    manifest = parseSha256Manifest(readText(manifestPath, 'manifest'), {
      source: manifestPath,
    });
  } catch (error) {
    if (!(error instanceof ScreenshotSha256Error)) throw error;
    console.error(`error: invalid sha256 manifest: ${error.message}`);
    return 2;
  }

  // A platform recorded on another CPU architecture is evidence drift (exit 1),
  // not a malformed manifest; every other fixed-contract difference is still
  // invalid manifest input (exit 2).
  const manifestPlatform = manifestPlatformMismatch(manifest);
  const environmentMismatches = manifestEnvironmentMismatches(manifest).filter(
    (problem) => problem !== manifestPlatform?.message,
  );
  if (environmentMismatches.length > 0) {
    console.error(
      `error: sha256 manifest ${manifestPath} does not match the fixed capture environment:`,
    );
    for (const problem of environmentMismatches) {
      console.error(`  - ${problem}`);
    }
    if (manifestPlatform !== null) {
      printPlatformMismatches([manifestPlatform], manifest);
    }
    console.error(
      'hint: update docs/screenshots/README.md and the manifest when the fixed capture environment changes.',
    );
    return 2;
  }
  if (manifestPlatform !== null) {
    printPlatformMismatches([manifestPlatform], manifest);
    return 1;
  }

  let logText;
  let logPath = null;
  try {
    if (options.log !== null) {
      logPath = resolve(options.log);
      logText = readText(logPath, 'capture log');
    }
  } catch (error) {
    if (!(error instanceof ScreenshotSha256Error)) throw error;
    console.error(`error: ${error.message}`);
    return 2;
  }

  const captureByFile = new Map(
    manifest.captures.map((capture) => [capture.file, capture]),
  );
  const result = verifyScreenshotSha256({ dir, manifest, logText });
  const { hashProblems, logHashes, environment } = result;

  // A malformed log is invalid input (exit 2), but it must not hide a changed
  // committed PNG: report the hash problems before returning.
  if (hashProblems.length > 0) {
    printHashProblems(hashProblems, captureByFile, result.entries, dir);
  }

  const invalidLogProblems = [
    ...(environment.invalid ? environment.problems : []),
    ...(logHashes.invalid && logHashes.invalidMessage !== null
      ? [logHashes.invalidMessage]
      : []),
  ];
  if (invalidLogProblems.length > 0) {
    console.error(`error: invalid capture log ${logPath ?? ''}:`);
    for (const problem of invalidLogProblems) {
      console.error(`  ${problem}`);
    }
    return 2;
  }

  if (hashProblems.length === 0 && environment.ok && logHashes.ok) {
    const envNote =
      logPath === null
        ? ''
        : '; capture environment fingerprint verified';
    const logHashNote =
      logHashes.records.length === 0
        ? ''
        : `; capture-log captured sha256 verified (${logHashes.records.length} record(s))`;
    console.log(
      `OK: ${result.entries} screenshot sha256 entries verified in ${dir}` +
        `${envNote}${logHashNote}`,
    );
    return 0;
  }

  // Platform drift is its own failure class: keep it out of the generic
  // environment block so the expected / actual platform and image are not
  // buried next to DPR / EGL / font messages.
  const platformProblems = new Set(
    environment.platformMismatches.map((mismatch) => mismatch.message),
  );
  const environmentProblems = environment.problems.filter(
    (problem) => !platformProblems.has(problem),
  );

  // Captured sha256 drift is reported on its own as well: it proves a logged
  // run wrote different bytes even when the committed PNGs still match.
  if (logHashes.problems.length > 0) {
    printLogHashProblems(logHashes.problems, captureByFile);
  }

  if (environmentProblems.length > 0) {
    console.error(
      `Environment fingerprint mismatch${logPath === null ? '' : ` (${logPath})`}:`,
    );
    for (const problem of environmentProblems) {
      console.error(`  ${problem}`);
    }
  }
  if (environment.platformMismatches.length > 0) {
    printPlatformMismatches(environment.platformMismatches, manifest);
  }

  printActualEnvironment(environment);
  // The platform section already lists the fixed-container recapture commands,
  // so only print the generic block when no platform difference was reported.
  if (environmentProblems.length > 0 && environment.platformMismatches.length === 0) {
    console.error('Recapture in the fixed container after an explicit evidence refresh:');
    for (const capture of manifest.captures) {
      console.error(`  ${capture.file}: ${capture.command}`);
    }
  }
  if (hashProblems.length === 0) {
    const failureClasses = [];
    if (environment.problems.length > 0) {
      failureClasses.push(`${environment.problems.length} capture environment problem(s)`);
    }
    if (logHashes.problems.length > 0) {
      failureClasses.push(
        `${logHashes.problems.length} capture-log captured sha256 problem(s)`,
      );
    }
    if (failureClasses.length > 0) {
      // "committed PNG hashes still match" is only true while the log hash
      // check passed; with captured sha256 drift it would be misleading.
      const suffix =
        logHashes.problems.length === 0
          ? '; committed PNG hashes still match the manifest.'
          : '.';
      console.error(`FAIL: ${failureClasses.join('; ')}${suffix}`);
    }
  }
  return 1;
}

process.exitCode = main(process.argv.slice(2));
