import {
  DEFAULT_E2E_REPORT_PATH,
  E2eFlakesError,
  analyzeE2eFlakes,
  describeE2eFlakes,
  exitCodeForAnalysis,
  readE2eReport,
} from './lib/e2e-flakes.mjs';

const USAGE = `Usage: node scripts/check-e2e-flakes.mjs [options]

Fail when the mobile-webkit "hub and blank canvas" case only passes after a
retry in the Playwright JSON report of the current run. Other projects and
other cases are ignored, so the existing retry policy stays unchanged.

Options:
  --report <path>    Playwright JSON report (default: ${DEFAULT_E2E_REPORT_PATH})
  -h, --help         show this help

Exit codes: 0 target passed on its first attempt (or the e2e step already
failed it), 1 flaky/skipped/missing target or an unreadable report, 2 usage
error.`;

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
      console.error(`[e2e-flakes] ${error.message}`);
      return 1;
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
