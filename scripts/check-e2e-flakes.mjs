import {
  DEFAULT_E2E_REPORT_PATH,
  E2eFlakesError,
  TARGET_CASES,
  analyzeE2eFlakes,
  describeE2eFlakes,
  exitCodeForAnalysis,
  readE2eReport,
} from './lib/e2e-flakes.mjs';

const TARGET_LINES = TARGET_CASES.map(
  (target) => `  - ${target.projectName} / title contains "${target.titleFragment}"`,
).join('\n');

const USAGE = `Usage: node scripts/check-e2e-flakes.mjs [options]

Fail when one of the guarded first-run cases only passes after a retry (or is
skipped, missing or unrecognized) in the Playwright JSON report of the current
run. Guarded cases:
${TARGET_LINES}

Other projects and other cases are ignored, so the existing retry policy stays
unchanged. A target that failed outright is already failing the e2e step, so
it is not reported twice.

Options:
  --report <path>    Playwright JSON report (default: ${DEFAULT_E2E_REPORT_PATH})
  -h, --help         show this help

Exit codes: 0 every target passed first or failed outright (the e2e step is
already red), 1 any target flaky/skipped/unrecognized/missing, 2 usage error or
a missing/unreadable report.`;

function parseArgs(argv) {
  const options = { report: DEFAULT_E2E_REPORT_PATH };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (arg !== '--report') {
      throw new Error(`unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`${arg} needs a value`);
    }
    index += 1;
    options.report = value;
  }

  return options;
}

function errorDetail(error) {
  return error instanceof Error ? error.message : String(error);
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`error: ${errorDetail(error)}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  let report;
  try {
    report = readE2eReport(options.report);
  } catch (error) {
    if (error instanceof E2eFlakesError) {
      // A missing or unparsable report is an input error, like the sibling
      // check CLIs; it still fails CI but is not a target-flake verdict.
      console.error(`[e2e-flakes] ${error.message}`);
      return 2;
    }
    throw error;
  }

  const analysis = analyzeE2eFlakes(report);
  for (const line of describeE2eFlakes(analysis, options.report)) {
    console.log(line);
  }
  return exitCodeForAnalysis(analysis);
}

process.exitCode = main(process.argv.slice(2));
