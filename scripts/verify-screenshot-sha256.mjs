#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_MANIFEST_DIR,
  DEFAULT_SCREENSHOT_DIR,
  ScreenshotSha256Error,
  expectedRecaptureCommand,
  imageReference,
  loadSha256Manifests,
  manifestEnvironmentMismatches,
  manifestPlatformMismatch,
  parseCaptureLogFingerprints,
  parseCaptureLogHashRecords,
  parseSha256Manifest,
  verifyScreenshotSha256,
} from './lib/screenshot-sha256.mjs';

const USAGE = `Usage: node scripts/verify-screenshot-sha256.mjs [options]

Verify the fixed-environment screenshot evidence. By default every
${DEFAULT_MANIFEST_DIR}/capture-sha256-manifest*.json file is discovered with
loadSha256Manifests and verified manifest by manifest: each PNG must exist and
hash to its recorded sha256, and the manifest's environment contract and
platform are reported separately. With --log the same capture log is checked
against every manifest: the capture-env fingerprint for that manifest's target
and the captured sha256 records for the files that manifest owns. A log with no
drift checklist keeps the previous behaviour and skips that check, so older
logs remain usable.

--manifest <path> keeps the original single-manifest mode and its output
wording; --manifest-dir <path> verifies another directory of manifests.

Options:
  --dir <path>            screenshot directory (default: ${DEFAULT_SCREENSHOT_DIR})
  --manifest <path>       verify one sha256 manifest; omit to discover all
                          manifests in --manifest-dir
  --manifest-dir <path>   directory of sha256 manifests (default:
                          ${DEFAULT_MANIFEST_DIR}); discovered files match
                          capture-sha256-manifest*.json
  --log <path>            capture log with capture-env fingerprint line(s) and/or
                          the sha256 drift checklist printed by the capture runtime
  -h, --help              show this help

Exit codes: 0 all checks pass, 1 hash, environment, platform or capture-log
            sha256 mismatch, 2 usage, invalid manifest, unreadable
            manifest/log, malformed capture-env line or malformed capture-log
            sha256 drift record. A missing or changed PNG is a hash failure (1);
            a platform difference is printed as its own section and exits 1.
            A captured sha256 that differs from the manifest, or a captured
            file no manifest records, is a capture-log sha256 failure (1); a
            drift checklist with missing, repeated or non-64-hex-lower-case
            fields is invalid input (2). Logs without a drift checklist are
            accepted unchanged for compatibility. When several manifests are
            verified, any invalid manifest exits 2 even if another manifest has
            a mismatch; any hash, environment, platform or capture-log failure
            in any manifest exits 1.`;

function parseArgs(argv) {
  const options = {
    dir: DEFAULT_SCREENSHOT_DIR,
    manifest: null,
    manifestDir: null,
    log: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (
      arg !== '--dir' &&
      arg !== '--manifest' &&
      arg !== '--manifest-dir' &&
      arg !== '--log'
    ) {
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
    } else if (arg === '--manifest-dir') {
      options.manifestDir = value;
    } else {
      options.log = value;
    }
  }

  if (options.manifest !== null && options.manifestDir !== null) {
    throw new ScreenshotSha256Error(
      '--manifest and --manifest-dir cannot be combined',
    );
  }
  if (options.manifestDir === null) {
    options.manifestDir = DEFAULT_MANIFEST_DIR;
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

function printActualEnvironment(environment, manifestPath = null) {
  const lines = environmentLines(environment);
  console.error(
    `Actual capture environment${manifestPath === null ? '' : ` (${manifestPath})`}:`,
  );
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

/**
 * Print hash problems for one manifest of a multi-manifest run.
 *
 * The owning manifest path is part of every line because the same file name
 * cannot be recorded by two manifests, but the report must still say which
 * manifest a hash failure belongs to.
 */
function printHashProblemsForManifest(
  manifestPath,
  hashProblems,
  captureByFile,
  entries,
  dir,
) {
  console.error(
    `FAIL: ${hashProblems.length} screenshot sha256 problem(s) across ` +
      `${entries} entries in ${dir} (manifest: ${manifestPath}):`,
  );
  for (const problem of hashProblems) {
    console.error(
      `  ${problem.file} (manifest: ${manifestPath}): ${problem.message}`,
    );
    console.error(`    expected sha256: ${problem.expected}`);
    console.error(`    actual sha256:   ${problem.actual ?? 'unavailable'}`);
    const capture = captureByFile.get(problem.file);
    if (capture !== undefined) {
      console.error(`    recapture in fixed container: ${capture.command}`);
    }
  }
}

function printLogHashProblems(problems, captureByFile, manifestPath = null) {
  console.error(
    `FAIL: ${problems.length} capture-log captured sha256 problem(s)` +
      `${manifestPath === null ? '' : ` in ${manifestPath}`}:`,
  );
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

function printPlatformMismatches(mismatches, manifest, manifestPath = null) {
  const labels = {
    manifest: 'sha256 manifest',
    log: 'capture log fingerprint',
  };
  console.error(
    `Platform mismatch (${mismatches.length})` +
      `${manifestPath === null ? '' : ` in ${manifestPath}`}:`,
  );
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

function runSingleManifest(options) {
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

/** Match the per-manifest duplicate rule for case / Unicode file aliases. */
function normalizeCaptureFile(file) {
  return file.normalize('NFC').toLowerCase();
}

/**
 * Pre-validate one capture log against every malformed-input rule.
 *
 * The log is shared by all manifests in multi-manifest mode, so a malformed
 * line is reported once instead of once per manifest. The environment and
 * captured sha256 checks themselves still run per manifest because the
 * expected target and owned captures differ.
 */
function invalidCaptureLogProblems(logText) {
  const problems = [];
  for (const parse of [parseCaptureLogFingerprints, parseCaptureLogHashRecords]) {
    try {
      parse(logText);
    } catch (error) {
      if (!(error instanceof ScreenshotSha256Error)) throw error;
      problems.push(error.message);
    }
  }
  return problems;
}

/**
 * Keep only the log hash failures that this manifest owns.
 *
 * A multi-manifest run shares one capture log. The library reports a record
 * whose file is absent from the manifest it is given, so in a set every record
 * owned by another manifest would look like a failure. The owning manifest's
 * own pass hashes that record. A record that no manifest owns is collected
 * separately so it can be reported once, without blaming an arbitrary
 * manifest that happens to be discovered first.
 */
function filterCrossManifestLogHashProblems(
  problems,
  manifestPath,
  owners,
  unownedProblems,
  reportedUnowned,
) {
  const kept = [];
  for (const problem of problems) {
    if (problem.expected === null) {
      const key = normalizeCaptureFile(problem.file);
      const owner = owners.get(key);
      if (owner !== undefined && owner !== manifestPath) {
        continue;
      }
      if (owner === undefined) {
        const dedupeKey = `${key}\0${problem.actual}`;
        if (!reportedUnowned.has(dedupeKey)) {
          reportedUnowned.add(dedupeKey);
          unownedProblems.push(problem);
        }
        continue;
      }
    }
    kept.push(problem);
  }
  return kept;
}

function runManifestSet(options) {
  const dir = resolve(options.dir);
  const manifestDir = resolve(options.manifestDir);

  let manifests;
  try {
    manifests = loadSha256Manifests({ dir: manifestDir });
  } catch (error) {
    if (!(error instanceof ScreenshotSha256Error)) throw error;
    console.error(`error: invalid sha256 manifest set: ${error.message}`);
    return 2;
  }

  if (manifests.length === 0) {
    console.error(`error: no sha256 manifests found in ${manifestDir}`);
    return 2;
  }

  let logPath = null;
  let logText = null;
  if (options.log !== null) {
    try {
      logPath = resolve(options.log);
      logText = readText(logPath, 'capture log');
    } catch (error) {
      if (!(error instanceof ScreenshotSha256Error)) throw error;
      console.error(`error: ${error.message}`);
      return 2;
    }
  }

  let invalidLog = false;
  if (logText !== null) {
    const invalidProblems = invalidCaptureLogProblems(logText);
    if (invalidProblems.length > 0) {
      invalidLog = true;
      console.error(`error: invalid capture log ${logPath}:`);
      for (const problem of invalidProblems) {
        console.error(`  ${problem}`);
      }
      // The committed PNG hashes are still worth checking, but the log cannot
      // be compared with any manifest.
      logText = null;
    }
  }

  const owners = new Map();
  for (const { path, manifest } of manifests) {
    for (const capture of manifest.captures) {
      owners.set(normalizeCaptureFile(capture.file), path);
    }
  }

  const reportedUnownedLogHashes = new Set();
  const unownedLogHashProblems = [];
  const successes = [];
  const totals = {
    entries: 0,
    hashProblems: 0,
    environmentProblems: 0,
    platformMismatches: 0,
    logHashProblems: 0,
    invalidManifests: 0,
  };
  let failed = false;
  const manifestLabel = manifests.length === 1 ? 'manifest' : 'manifests';

  for (const { path: manifestPath, manifest } of manifests) {
    const manifestPlatform = manifestPlatformMismatch(manifest);
    const environmentMismatches = manifestEnvironmentMismatches(manifest).filter(
      (problem) => problem !== manifestPlatform?.message,
    );
    if (environmentMismatches.length > 0) {
      totals.invalidManifests += 1;
      console.error(
        `error: sha256 manifest ${manifestPath} does not match the fixed capture environment:`,
      );
      for (const problem of environmentMismatches) {
        console.error(`  - ${problem}`);
      }
      console.error(
        'hint: update docs/screenshots/README.md and the manifest when the fixed capture environment changes.',
      );
    }
    if (manifestPlatform !== null) {
      totals.platformMismatches += 1;
      failed = true;
      printPlatformMismatches([manifestPlatform], manifest, manifestPath);
    }

    const captureByFile = new Map(
      manifest.captures.map((capture) => [capture.file, capture]),
    );
    const result = verifyScreenshotSha256({ dir, manifest, logText });
    totals.entries += result.entries;

    if (result.hashProblems.length > 0) {
      totals.hashProblems += result.hashProblems.length;
      failed = true;
      printHashProblemsForManifest(
        manifestPath,
        result.hashProblems,
        captureByFile,
        result.entries,
        dir,
      );
    }

    // The multi-manifest path pre-validates the log once, but keep the invalid
    // classes separate if a future parser change lets one through.
    const invalidProblems = [
      ...(result.environment.invalid ? result.environment.problems : []),
      ...(result.logHashes.invalid && result.logHashes.invalidMessage !== null
        ? [result.logHashes.invalidMessage]
        : []),
    ];
    if (invalidProblems.length > 0) {
      invalidLog = true;
      console.error(`error: invalid capture log for ${manifestPath}:`);
      for (const problem of invalidProblems) {
        console.error(`  ${problem}`);
      }
    }

    const platformMessages = new Set(
      result.environment.platformMismatches.map((mismatch) => mismatch.message),
    );
    const environmentProblems = result.environment.invalid
      ? []
      : result.environment.problems.filter(
          (problem) => !platformMessages.has(problem),
        );
    if (environmentProblems.length > 0) {
      totals.environmentProblems += environmentProblems.length;
      failed = true;
      console.error(
        `Environment fingerprint mismatch${logPath === null ? '' : ` (${logPath})`} ` +
          `for ${manifestPath}:`,
      );
      for (const problem of environmentProblems) {
        console.error(`  ${problem}`);
      }
      printActualEnvironment(result.environment, manifestPath);
      if (result.environment.platformMismatches.length === 0) {
        console.error(
          `Recapture in the fixed container after an explicit evidence refresh ` +
            `(manifest: ${manifestPath}):`,
        );
        for (const capture of manifest.captures) {
          console.error(`  ${capture.file}: ${capture.command}`);
        }
      }
    }
    if (result.environment.platformMismatches.length > 0) {
      totals.platformMismatches += result.environment.platformMismatches.length;
      failed = true;
      printPlatformMismatches(
        result.environment.platformMismatches,
        manifest,
        manifestPath,
      );
    }

    const logHashProblems = filterCrossManifestLogHashProblems(
      result.logHashes.problems,
      manifestPath,
      owners,
      unownedLogHashProblems,
      reportedUnownedLogHashes,
    );
    if (logHashProblems.length > 0) {
      totals.logHashProblems += logHashProblems.length;
      failed = true;
      printLogHashProblems(logHashProblems, captureByFile, manifestPath);
    }

    const manifestOk =
      !result.environment.invalid &&
      !result.logHashes.invalid &&
      environmentMismatches.length === 0 &&
      manifestPlatform === null &&
      result.hashProblems.length === 0 &&
      environmentProblems.length === 0 &&
      result.environment.platformMismatches.length === 0 &&
      logHashProblems.length === 0;
    if (manifestOk) {
      const ownLogRecords = result.logHashes.records.filter((record) =>
        captureByFile.has(record.file),
      ).length;
      successes.push({
        path: manifestPath,
        entries: result.entries,
        ownLogRecords,
      });
    }
  }

  if (unownedLogHashProblems.length > 0) {
    totals.logHashProblems += unownedLogHashProblems.length;
    failed = true;
    printLogHashProblems(unownedLogHashProblems, new Map());
  }

  if (invalidLog) {
    return 2;
  }
  if (totals.invalidManifests > 0) {
    console.error(
      `error: ${totals.invalidManifests} sha256 manifest(s) do not match the fixed capture environment contract.`,
    );
    return 2;
  }
  if (failed) {
    const failureClasses = [];
    if (totals.hashProblems > 0) {
      failureClasses.push(`${totals.hashProblems} screenshot sha256 problem(s)`);
    }
    if (totals.environmentProblems > 0) {
      failureClasses.push(
        `${totals.environmentProblems} capture environment problem(s)`,
      );
    }
    if (totals.platformMismatches > 0) {
      failureClasses.push(`${totals.platformMismatches} platform mismatch(es)`);
    }
    if (totals.logHashProblems > 0) {
      failureClasses.push(
        `${totals.logHashProblems} capture-log captured sha256 problem(s)`,
      );
    }
    console.error(
      `FAIL: ${failureClasses.join('; ')} across ${manifests.length} ${manifestLabel} in ${dir}.`,
    );
    return 1;
  }

  const envNote =
    logPath === null ? '' : '; capture environment fingerprint verified';
  const ownLogRecords = successes.reduce(
    (total, success) => total + success.ownLogRecords,
    0,
  );
  const logHashNote =
    ownLogRecords === 0
      ? ''
      : `; capture-log captured sha256 verified (${ownLogRecords} record(s))`;
  console.log(
    `OK: ${totals.entries} screenshot sha256 entries verified across ` +
      `${manifests.length} ${manifestLabel} in ${dir}${envNote}${logHashNote}`,
  );
  for (const success of successes) {
    console.log(`  ${success.path}: ${success.entries} entries`);
  }
  return 0;
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

  if (options.manifest !== null) {
    return runSingleManifest(options);
  }
  return runManifestSet(options);
}

process.exitCode = main(process.argv.slice(2));
