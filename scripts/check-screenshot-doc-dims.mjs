import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_README_PATH,
  DEFAULT_SCREENSHOT_DIR,
  verifyDocDimensions,
} from './lib/screenshot-doc-dims.mjs';

const USAGE = `Usage: node scripts/check-screenshot-doc-dims.mjs [options]

Verify the sizes and complete sha256 hashes documented in the screenshot README
against the committed PNG files. Two table row formats are supported:

  - full-page rows: 整页 W×H
  - viewport rows:  CSS 视口 / PNG 尺寸 (e.g. 1440×1000 / 1440×1000)

For viewport rows only the PNG size after the slash is compared with the IHDR;
the CSS viewport before the slash is recorded but not compared, because it can
differ by the device pixel ratio.

A complete backticked 64-character sha256 in a row is compared with the file
bytes. An unmarked shorter hex value that matches the beginning of the file's
sha256 is reported as a truncated hash; explicit shorthand such as
\`7232a897…\` is skipped.

Options:
  --readme <path>    screenshot README (default: ${DEFAULT_README_PATH})
  --dir <path>       screenshot directory (default: ${DEFAULT_SCREENSHOT_DIR})
  -h, --help         show this help

Exit codes: 0 all sizes and complete sha256 hashes match, 1 problems found,
            2 usage or I/O error.`;

function parseArgs(argv) {
  const options = { readme: DEFAULT_README_PATH, dir: DEFAULT_SCREENSHOT_DIR };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (arg !== '--readme' && arg !== '--dir') {
      throw new Error(`unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`${arg} needs a value`);
    }
    index += 1;
    if (arg === '--readme') {
      options.readme = value;
    } else {
      options.dir = value;
    }
  }

  return options;
}

function formatProblem(problem) {
  if (problem.check === 'sha256') {
    return `README ${problem.readmeLine}: ${problem.file}: sha256 文档 ${problem.docSha256} != 实际 ${problem.actualSha256}（${problem.reason}）`;
  }

  const docSize = `${problem.docWidth}×${problem.docHeight}`;
  const actual =
    problem.actualWidth === null
      ? 'PNG'
      : `PNG ${problem.actualWidth}×${problem.actualHeight}`;
  const label = problem.kind === 'viewport' ? '视口 PNG' : '整页';
  return `README ${problem.readmeLine}: ${problem.file}: ${label} ${docSize} != ${actual}（${problem.reason}）`;
}

function formatBreakdown(fullPageRows, viewportRows) {
  return `整页 ${fullPageRows} 行 / 视口 ${viewportRows} 行`;
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

  const readmePath = resolve(options.readme);
  const dir = resolve(options.dir);

  let readmeText;
  try {
    readmeText = readFileSync(readmePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`error: cannot read README ${readmePath}: ${detail}`);
    return 2;
  }

  try {
    if (!statSync(dir).isDirectory()) {
      throw new Error(`not a directory: ${dir}`);
    }
    accessSync(dir, constants.R_OK | constants.X_OK);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`error: cannot read screenshot directory ${dir}: ${detail}`);
    return 2;
  }

  const { rows, files, fullPageRows, viewportRows, sha256Files, problems } =
    verifyDocDimensions({
      readmeText,
      dir,
    });

  if (problems.length > 0) {
    console.log(
      `FAIL: 发现 ${problems.length} 处尺寸 / sha256 问题（检查了 ${files} 个文件 / ${rows} 行 README，${formatBreakdown(fullPageRows, viewportRows)}）：`,
    );
    for (const problem of problems) {
      console.log(`  ${formatProblem(problem)}`);
    }
    return 1;
  }

  console.log(
    `OK: 检查了 ${files} 个文件 / ${rows} 行 README（${formatBreakdown(fullPageRows, viewportRows)}，sha256 ${sha256Files} 个文件），尺寸与 sha256 全部一致。`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
