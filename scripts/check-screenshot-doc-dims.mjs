import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_README_PATH,
  DEFAULT_SCREENSHOT_DIR,
  verifyDocDimensions,
} from './lib/screenshot-doc-dims.mjs';

const USAGE = `Usage: node scripts/check-screenshot-doc-dims.mjs [options]

Verify the full-page (整页 W×H) sizes documented in the screenshot README
against the PNG signature and IHDR width/height of the committed files.

Options:
  --readme <path>    screenshot README (default: ${DEFAULT_README_PATH})
  --dir <path>       screenshot directory (default: ${DEFAULT_SCREENSHOT_DIR})
  -h, --help         show this help

Exit codes: 0 all sizes match, 1 problems found, 2 usage or I/O error.`;

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
  const docSize = `${problem.docWidth}×${problem.docHeight}`;
  const actual =
    problem.actualWidth === null
      ? 'PNG'
      : `PNG ${problem.actualWidth}×${problem.actualHeight}`;
  return `README ${problem.readmeLine}: ${problem.file}: 整页 ${docSize} != ${actual}（${problem.reason}）`;
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

  const { rows, files, problems } = verifyDocDimensions({ readmeText, dir });

  if (problems.length > 0) {
    console.log(
      `FAIL: 发现 ${problems.length} 处整页尺寸问题（检查了 ${files} 个文件 / ${rows} 行 README）：`,
    );
    for (const problem of problems) {
      console.log(`  ${formatProblem(problem)}`);
    }
    return 1;
  }

  console.log(`OK: 检查了 ${files} 个文件 / ${rows} 行 README，整页尺寸全部一致。`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
