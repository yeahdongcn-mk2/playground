import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_README_PATH,
  DEFAULT_SCREENSHOT_DIR,
  ScreenshotDocDimsError,
  parseDocDimensions,
  parsePngDimensions,
  verifyDocDimensions,
} from '../../scripts/lib/screenshot-doc-dims.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README = join(ROOT, DEFAULT_README_PATH);
const SCREENSHOT_DIR = join(ROOT, DEFAULT_SCREENSHOT_DIR);
const CLI = join(ROOT, 'scripts', 'check-screenshot-doc-dims.mjs');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'screenshot-doc-dims-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

/** Build a minimal valid RGBA PNG whose IHDR reports the requested size. */
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const pixels = Buffer.alloc((1 + width * 4) * height); // filter byte 0 per row
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function writePng(dir: string, name: string, width: number, height: number): void {
  writeFileSync(join(dir, name), makePng(width, height));
}

function tableRow(files: string[], width: number, height: number): string {
  const names = files.map((file) => `\`${file}\``).join(' / ');
  return `| ${names} | 场景 | 1440×1000 / 深色 / 整页 ${width}×${height} | 说明 |`;
}

function writeReadme(dir: string, lines: string[]): string {
  const file = join(dir, 'README.md');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error === undefined ? '' : String(result.error)}`,
  };
}

describe('parseDocDimensions', () => {
  it('parses full-page rows with one or several files in a cell', () => {
    const text = [
      '# 截图来源',
      '正文里的整页 999×888 不是表格行，不参与校验。',
      '| 文件 | 场景 | 视口 / 主题 | 说明 |',
      '| --- | --- | --- | --- |',
      tableRow(['before-a.png', 'after-a.png'], 1440, 1324),
      '| `no-size.png` | 场景 | 1440×1000 / 深色 | 没有整页尺寸 |',
    ].join('\n');

    expect(parseDocDimensions(text)).toEqual([
      { line: 5, files: ['before-a.png', 'after-a.png'], width: 1440, height: 1324 },
    ]);
  });

  it('ignores body text and rows without a backticked PNG name or full-page size', () => {
    expect(parseDocDimensions('正文整页 1440×1324，`a.png` 不在表格里')).toEqual([]);
    expect(parseDocDimensions('| a.png | 整页 1440×1324 |')).toEqual([]);
    expect(parseDocDimensions('| `a.png` | 1440×1000 / 深色 |')).toEqual([]);
  });

  it('lists the 12 documented full-page rows in the committed README', () => {
    const rows = parseDocDimensions(readFileSync(README, 'utf8'));
    const files = rows.flatMap((row) => row.files);

    expect(rows).toHaveLength(12);
    expect(files).toHaveLength(12);
    expect(
      files.filter((file) => file.includes('scores') && !file.includes('clear')),
    ).toHaveLength(4);
    expect(files.filter((file) => file.includes('clear-scores'))).toHaveLength(4);
  });
});

describe('parsePngDimensions', () => {
  it('reads the IHDR size of a committed full-page PNG', () => {
    const bytes = readFileSync(join(SCREENSHOT_DIR, 'after-minesweeper-scores-desktop.png'));

    expect(parsePngDimensions(bytes)).toEqual({ width: 1440, height: 1606 });
  });

  it('rejects a file that does not start with the PNG signature', () => {
    expect(() => parsePngDimensions(Buffer.from('not a png'))).toThrow(ScreenshotDocDimsError);
    expect(() => parsePngDimensions(Buffer.from('not a png'))).toThrow(/PNG 签名错误/);
  });

  it('rejects a file truncated inside the IHDR width/height bytes', () => {
    const truncated = makePng(1440, 1324).subarray(0, 20);

    expect(() => parsePngDimensions(truncated)).toThrow(/IHDR 截断/);
  });
});

describe('verifyDocDimensions', () => {
  it('passes when document and PNG sizes agree', () => {
    const dir = makeTempDir();
    writePng(dir, 'after-a.png', 1440, 1324);

    const report = verifyDocDimensions({
      readmeText: tableRow(['after-a.png'], 1440, 1324),
      dir,
    });

    expect(report).toEqual({ rows: 1, files: 1, problems: [] });
  });

  it('reports a wrong documented width and a wrong documented height', () => {
    const dir = makeTempDir();
    writePng(dir, 'width.png', 1440, 1324);
    writePng(dir, 'height.png', 1440, 1324);
    const readmeText = [
      tableRow(['width.png'], 1000, 1324),
      tableRow(['height.png'], 1440, 1606),
    ].join('\n');

    const { problems } = verifyDocDimensions({ readmeText, dir });

    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({
      readmeLine: 1,
      file: 'width.png',
      docWidth: 1000,
      docHeight: 1324,
      actualWidth: 1440,
      actualHeight: 1324,
      reason: '尺寸不一致',
    });
    expect(problems[1]).toMatchObject({
      readmeLine: 2,
      file: 'height.png',
      docWidth: 1440,
      docHeight: 1606,
      actualWidth: 1440,
      actualHeight: 1324,
      reason: '尺寸不一致',
    });
  });

  it('reports a missing PNG with the expected path', () => {
    const dir = makeTempDir();

    const { files, problems } = verifyDocDimensions({
      readmeText: tableRow(['missing.png'], 1440, 1324),
      dir,
    });

    expect(files).toBe(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      readmeLine: 1,
      file: 'missing.png',
      docWidth: 1440,
      docHeight: 1324,
      actualWidth: null,
      actualHeight: null,
    });
    expect(problems[0]?.reason).toContain('PNG 文件缺失');
    expect(problems[0]?.reason).toContain(join(dir, 'missing.png'));
  });

  it('reports a broken PNG signature and a truncated IHDR separately', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'broken.png'), 'not a png');
    writeFileSync(join(dir, 'truncated.png'), makePng(1440, 1324).subarray(0, 20));
    const readmeText = [
      tableRow(['broken.png'], 1440, 1324),
      tableRow(['truncated.png'], 1440, 1324),
    ].join('\n');

    const { problems } = verifyDocDimensions({ readmeText, dir });

    expect(problems).toHaveLength(2);
    expect(problems[0]?.file).toBe('broken.png');
    expect(problems[0]?.reason).toMatch(/PNG 签名错误/);
    expect(problems[1]?.file).toBe('truncated.png');
    expect(problems[1]?.reason).toMatch(/IHDR 截断/);
    expect(problems[1]?.actualWidth).toBeNull();
  });

  it('checks every file listed in the same cell', () => {
    const dir = makeTempDir();
    writePng(dir, 'ok.png', 1440, 1324);
    writePng(dir, 'wrong.png', 1440, 1606);

    const { rows, files, problems } = verifyDocDimensions({
      readmeText: tableRow(['ok.png', 'wrong.png'], 1440, 1324),
      dir,
    });

    expect(rows).toBe(1);
    expect(files).toBe(2);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.file).toBe('wrong.png');
    expect(problems[0]?.actualHeight).toBe(1606);
  });
});

describe('check-screenshot-doc-dims CLI', () => {
  it('exits 0 for the committed README and screenshots', () => {
    const { status, stdout, stderr } = runCli([]);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain('12 个文件');
    expect(stdout).toContain('12 行');
    expect(stdout).toContain('整页尺寸全部一致');
  });

  it('exits 0 for a temporary README and ignores body 整页 text', () => {
    const dir = makeTempDir();
    writePng(dir, 'after-a.png', 1200, 800);
    const readme = writeReadme(dir, [
      '# 截图来源',
      '正文提到整页 999×999，但不在表格里。',
      tableRow(['after-a.png'], 1200, 800),
    ]);

    const { status, stdout, stderr } = runCli(['--readme', readme, '--dir', dir]);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain('1 个文件');
    expect(stdout).toContain('1 行');
  });

  it('exits 1 and prints the README line, file and both sizes for a mismatch', () => {
    const dir = makeTempDir();
    writePng(dir, 'after-a.png', 1440, 1324);
    const readme = writeReadme(dir, [
      '# 截图来源',
      '',
      '| 文件 | 场景 | 视口 / 主题 | 说明 |',
      '| --- | --- | --- | --- |',
      tableRow(['after-a.png'], 1440, 1606),
    ]);

    const { status, stdout } = runCli(['--readme', readme, '--dir', dir]);

    expect(status).toBe(1);
    expect(stdout).toContain('README 5: after-a.png');
    expect(stdout).toContain('整页 1440×1606');
    expect(stdout).toContain('!= PNG 1440×1324');
  });

  it('exits 1 and names a missing PNG', () => {
    const dir = makeTempDir();
    const readme = writeReadme(dir, [tableRow(['missing.png'], 1440, 1324)]);

    const { status, stdout } = runCli(['--readme', readme, '--dir', dir]);

    expect(status).toBe(1);
    expect(stdout).toContain('README 1: missing.png');
    expect(stdout).toContain('整页 1440×1324');
    expect(stdout).toContain('PNG 文件缺失');
  });

  it('exits 1 and reports a truncated IHDR', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'truncated.png'), makePng(1440, 1324).subarray(0, 20));
    const readme = writeReadme(dir, [tableRow(['truncated.png'], 1440, 1324)]);

    const { status, stdout } = runCli(['--readme', readme, '--dir', dir]);

    expect(status).toBe(1);
    expect(stdout).toContain('README 1: truncated.png');
    expect(stdout).toContain('整页 1440×1324');
    expect(stdout).toContain('IHDR 截断');
  });

  it('exits 0 for --help and -h', () => {
    const long = runCli(['--help']);
    expect(long.status).toBe(0);
    expect(long.stderr).toBe('');
    expect(long.stdout).toContain('Usage: node scripts/check-screenshot-doc-dims.mjs');
    expect(long.stdout).toContain('--readme');
    expect(long.stdout).toContain('--dir');

    expect(runCli(['-h']).status).toBe(0);
  });

  it('exits 2 for an unknown option or a missing option value', () => {
    const unknown = runCli(['--unknown']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown option: --unknown');
    expect(unknown.stderr).toContain('Usage:');

    expect(runCli(['--readme']).status).toBe(2);
    expect(runCli(['--dir']).status).toBe(2);
  });

  it('exits 2 when the README or screenshot directory cannot be read', () => {
    const dir = makeTempDir();
    const readme = writeReadme(dir, [tableRow(['after-a.png'], 1440, 1324)]);
    writePng(dir, 'after-a.png', 1440, 1324);

    const missingReadme = runCli([
      '--readme',
      join(dir, 'missing-README.md'),
      '--dir',
      dir,
    ]);
    expect(missingReadme.status).toBe(2);
    expect(missingReadme.stderr).toContain('cannot read README');

    const missingDir = runCli(['--readme', readme, '--dir', join(dir, 'missing-dir')]);
    expect(missingDir.status).toBe(2);
    expect(missingDir.stderr).toContain('cannot read screenshot directory');
  });
});
