import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  readPngDimensions,
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

/**
 * Build a valid PNG of the requested size with a distinct tEXt chunk, so two
 * files in the same row can share dimensions but differ byte-for-byte.
 */
function makeLabelledPng(width: number, height: number, label: string): Buffer {
  const png = makePng(width, height);
  const text = pngChunk('tEXt', Buffer.from(`label=${label}`, 'latin1'));
  // IEND is the last 12 bytes (length + type + CRC); keep it last.
  return Buffer.concat([png.subarray(0, png.length - 12), text, png.subarray(png.length - 12)]);
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashCell(hashes: string[], fallback = '说明'): string {
  if (hashes.length === 0) return fallback;
  return hashes.map((hash) => `\`${hash}\``).join(' / ');
}

function tableRow(
  files: string[],
  width: number,
  height: number,
  hashes: string[] = [],
): string {
  const names = files.map((file) => `\`${file}\``).join(' / ');
  return `| ${names} | 场景 | 1440×1000 / 深色 / 整页 ${width}×${height} | ${hashCell(hashes)} |`;
}

function viewportRow(
  files: string[],
  viewportWidth: number,
  viewportHeight: number,
  width: number,
  height: number,
  hashes: string[] = [],
): string {
  const names = files.map((file) => `\`${file}\``).join(' / ');
  return `| ${names} | 场景 | ${viewportWidth}×${viewportHeight} / ${width}×${height} | ${hashCell(hashes, 'sha256')} |`;
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
      {
        line: 5,
        kind: 'full-page',
        files: ['before-a.png', 'after-a.png'],
        hashes: [null, null],
        width: 1440,
        height: 1324,
      },
    ]);
  });

  it('parses viewport rows with the PNG size after the slash', () => {
    const text = [
      '# 截图来源',
      '| 文件 | 场景 | CSS 视口 / PNG 尺寸 | sha256 |',
      '| --- | --- | --- | --- |',
      viewportRow(['before-a.png', 'after-a.png'], 1440, 1000, 1440, 1000),
      viewportRow(['phone.png'], 320, 640, 640, 1280),
    ].join('\n');

    expect(parseDocDimensions(text)).toEqual([
      {
        line: 4,
        kind: 'viewport',
        files: ['before-a.png', 'after-a.png'],
        hashes: [null, null],
        viewportWidth: 1440,
        viewportHeight: 1000,
        width: 1440,
        height: 1000,
      },
      {
        line: 5,
        kind: 'viewport',
        files: ['phone.png'],
        hashes: [null],
        viewportWidth: 320,
        viewportHeight: 640,
        width: 640,
        height: 1280,
      },
    ]);
  });

  it('parses complete backticked sha256 values and pairs them with files', () => {
    const first = '0123456789abcdef'.repeat(4);
    const second = 'FEDCBA9876543210'.repeat(4);
    const text = [
      '| 文件 | 场景 | CSS 视口 / PNG 尺寸 | sha256 |',
      '| --- | --- | --- | --- |',
      viewportRow(['before-a.png', 'after-a.png'], 1440, 1000, 1440, 1000, [first, second]),
    ].join('\n');

    expect(parseDocDimensions(text)).toEqual([
      {
        line: 3,
        kind: 'viewport',
        files: ['before-a.png', 'after-a.png'],
        hashes: [first, second.toLowerCase()],
        viewportWidth: 1440,
        viewportHeight: 1000,
        width: 1440,
        height: 1000,
      },
    ]);
  });

  it('ignores ellipsis shorthand and non-hex values, and keeps short hex in its file slot', () => {
    const text = [
      viewportRow(['truncated.png'], 1440, 1000, 1440, 1000, ['7232a897…']),
      viewportRow(['short.png'], 320, 640, 640, 1280, ['a'.repeat(63)]),
      viewportRow(['long.png'], 320, 640, 640, 1280, ['b'.repeat(65)]),
      viewportRow(['non-hex.png'], 320, 640, 640, 1280, ['g'.repeat(64)]),
    ].join('\n');
    const rows = parseDocDimensions(text);

    expect(rows.map((row) => row.hashes)).toEqual([[null], ['a'.repeat(63)], [null], [null]]);
  });

  it('ignores body text and rows without a backticked PNG name or recognised size', () => {
    expect(parseDocDimensions('正文整页 1440×1324，`a.png` 不在表格里')).toEqual([]);
    expect(parseDocDimensions('| a.png | 整页 1440×1324 |')).toEqual([]);
    expect(parseDocDimensions('| `a.png` | 1440×1000 / 深色 |')).toEqual([]);
    expect(parseDocDimensions('正文 320×640 / 640×1280，`a.png` 不在表格里')).toEqual([]);
    expect(parseDocDimensions('| a.png | 320×640 / 640×1280 |')).toEqual([]);
    expect(parseDocDimensions('| `a.png` | 320×640 / 深色 |')).toEqual([]);
  });

  it('counts a row with both formats once as a full-page row', () => {
    const text = [
      '| `both.png` | 场景 | 整页 1440×1324 | 1440×1000 / 1440×1000 |',
    ].join('\n');

    expect(parseDocDimensions(text)).toEqual([
      {
        line: 1,
        kind: 'full-page',
        files: ['both.png'],
        hashes: [null],
        width: 1440,
        height: 1324,
      },
    ]);
  });

  it('lists the 16 full-page and 8 viewport rows in the committed README', () => {
    const rows = parseDocDimensions(readFileSync(README, 'utf8'));
    const fullPage = rows.filter((row) => row.kind === 'full-page');
    const viewport = rows.filter((row) => row.kind === 'viewport');
    const fullPageFiles = fullPage.flatMap((row) => row.files);
    const viewportFiles = viewport.flatMap((row) => row.files);

    expect(rows).toHaveLength(24);
    expect(fullPage).toHaveLength(16);
    expect(fullPageFiles).toHaveLength(16);
    expect(viewport).toHaveLength(8);
    expect(viewportFiles).toHaveLength(8);
    expect(
      fullPageFiles.filter((file) => file.includes('scores') && !file.includes('clear')),
    ).toHaveLength(4);
    expect(fullPageFiles.filter((file) => file.includes('clear-scores'))).toHaveLength(4);

    expect(new Set(viewportFiles)).toEqual(
      new Set([
        'before-zhen-sha-route-desktop.png',
        'after-zhen-sha-route-desktop.png',
        'before-zhen-sha-route-320x640.png',
        'after-zhen-sha-route-320x640.png',
        'before-hub-copy-desktop.png',
        'after-hub-copy-desktop.png',
        'before-hub-copy-320x640.png',
        'after-hub-copy-320x640.png',
      ]),
    );

    const viewportByFile = new Map(
      viewport.flatMap((row) => row.files.map((file) => [file, row] as const)),
    );
    for (const file of ['before-zhen-sha-route-desktop.png', 'after-zhen-sha-route-desktop.png',
      'before-hub-copy-desktop.png', 'after-hub-copy-desktop.png']) {
      expect(viewportByFile.get(file)).toMatchObject({
        viewportWidth: 1440,
        viewportHeight: 1000,
        width: 1440,
        height: 1000,
      });
    }
    for (const file of ['before-zhen-sha-route-320x640.png', 'after-zhen-sha-route-320x640.png',
      'before-hub-copy-320x640.png', 'after-hub-copy-320x640.png']) {
      expect(viewportByFile.get(file)).toMatchObject({
        viewportWidth: 320,
        viewportHeight: 640,
        width: 640,
        height: 1280,
      });
    }
  });

  it('documents a complete sha256 only for the 8 viewport evidence rows', () => {
    const readmeText = readFileSync(README, 'utf8');
    const rows = parseDocDimensions(readmeText);
    const hashedRows = rows.filter((row) => row.hashes.some((hash) => hash !== null));

    expect(hashedRows.flatMap((row) => row.files)).toEqual([
      'before-zhen-sha-route-desktop.png',
      'after-zhen-sha-route-desktop.png',
      'before-zhen-sha-route-320x640.png',
      'after-zhen-sha-route-320x640.png',
      'before-hub-copy-desktop.png',
      'after-hub-copy-desktop.png',
      'before-hub-copy-320x640.png',
      'after-hub-copy-320x640.png',
    ]);
    for (const row of hashedRows) {
      expect(row.files).toHaveLength(1);
      expect(row.hashes).toHaveLength(1);
      expect(row.hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    }

    // The hub full-page rows use an 8-character shorthand; it is skipped, not
    // compared with a non-existent file prefix.
    expect(readmeText).toContain('7232a897…');
    expect(readmeText).toContain('d2fa7877…');
    const hubRows = rows.filter((row) =>
      row.files.some(
        (file) => file === 'after-hub-desktop.png' || file === 'after-hub-mobile.png',
      ),
    );
    expect(hubRows).toHaveLength(2);
    for (const row of hubRows) {
      expect(row.kind).toBe('full-page');
      expect(row.hashes).toEqual([null]);
    }
  });
});

describe('committed hub screenshot full-page docs (Issue #161)', () => {
  const HUB_SCREENSHOTS = ['after-hub-desktop.png', 'after-hub-mobile.png'] as const;

  function documentedSizes(text: string) {
    const documented = new Map<string, { width: number; height: number }>();
    for (const row of parseDocDimensions(text)) {
      for (const file of row.files) {
        documented.set(file, { width: row.width, height: row.height });
      }
    }
    return documented;
  }

  it('documents 整页 W×H for each committed hub screenshot and matches the PNG', () => {
    const documented = documentedSizes(readFileSync(README, 'utf8'));

    for (const file of HUB_SCREENSHOTS) {
      const size = documented.get(file);
      expect(size, `${file} 缺少「整页 W×H」文档行`).toBeDefined();
      expect(size, `${file} 文档尺寸与 PNG 不一致`).toEqual(
        readPngDimensions(join(SCREENSHOT_DIR, file)),
      );
    }
  });

  it('fails when a hub documentation row is removed or its size is mistyped', () => {
    const source = readFileSync(README, 'utf8');

    const withoutDesktop = source
      .split('\n')
      .filter(
        (line) =>
          !(
            line.startsWith('|') &&
            line.includes('`after-hub-desktop.png`') &&
            line.includes('整页')
          ),
      )
      .join('\n');
    expect(parseDocDimensions(withoutDesktop).flatMap((row) => row.files)).not.toContain(
      'after-hub-desktop.png',
    );

    const mistyped = source.replace('| 整页 1440×3468 |', '| 整页 1440×3469 |');
    const desktop = parseDocDimensions(mistyped).find((row) =>
      row.files.includes('after-hub-desktop.png'),
    );
    if (desktop === undefined) {
      throw new Error('README 缺少 after-hub-desktop.png 的整页尺寸行');
    }
    expect({ width: desktop.width, height: desktop.height }).not.toEqual(
      readPngDimensions(join(SCREENSHOT_DIR, 'after-hub-desktop.png')),
    );
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
  it('passes for the committed README with 24 rows and 24 files', () => {
    const report = verifyDocDimensions({
      readmeText: readFileSync(README, 'utf8'),
      dir: SCREENSHOT_DIR,
    });

    expect(report).toEqual({
      rows: 24,
      files: 24,
      fullPageRows: 16,
      viewportRows: 8,
      sha256Files: 8,
      problems: [],
    });
  });

  it('passes when document and PNG sizes agree', () => {
    const dir = makeTempDir();
    writePng(dir, 'after-a.png', 1440, 1324);

    const report = verifyDocDimensions({
      readmeText: tableRow(['after-a.png'], 1440, 1324),
      dir,
    });

    expect(report).toEqual({
      rows: 1,
      files: 1,
      fullPageRows: 1,
      viewportRows: 0,
      sha256Files: 0,
      problems: [],
    });
  });

  it('passes when the CSS viewport differs from the PNG size but the slash size matches', () => {
    const dir = makeTempDir();
    writePng(dir, 'phone.png', 640, 1280);

    const report = verifyDocDimensions({
      readmeText: viewportRow(['phone.png'], 320, 640, 640, 1280),
      dir,
    });

    expect(report).toEqual({
      rows: 1,
      files: 1,
      fullPageRows: 0,
      viewportRows: 1,
      sha256Files: 0,
      problems: [],
    });
  });

  it('passes when the documented sha256 matches the PNG bytes', () => {
    const dir = makeTempDir();
    const bytes = makePng(1440, 1000);
    writeFileSync(join(dir, 'after-a.png'), bytes);
    const documented = sha256Of(bytes);

    const report = verifyDocDimensions({
      readmeText: viewportRow(['after-a.png'], 1440, 1000, 1440, 1000, [documented]),
      dir,
    });

    expect(report).toEqual({
      rows: 1,
      files: 1,
      fullPageRows: 0,
      viewportRows: 1,
      sha256Files: 1,
      problems: [],
    });
  });

  it('reports a wrong sha256 with line, file, documented and actual hashes', () => {
    const dir = makeTempDir();
    const bytes = makePng(1440, 1000);
    writeFileSync(join(dir, 'after-a.png'), bytes);
    const actual = sha256Of(bytes);
    const documented = `${actual.slice(0, 63)}${actual.endsWith('0') ? '1' : '0'}`;

    const { problems } = verifyDocDimensions({
      readmeText: viewportRow(['after-a.png'], 1440, 1000, 1440, 1000, [documented]),
      dir,
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      readmeLine: 1,
      file: 'after-a.png',
      kind: 'viewport',
      check: 'sha256',
      docSha256: documented,
      actualSha256: actual,
      reason: 'sha256 不一致',
    });
  });

  it('pairs each complete sha256 with its own file in a multi-file row', () => {
    const dir = makeTempDir();
    const firstBytes = makeLabelledPng(1440, 1000, 'first');
    const secondBytes = makeLabelledPng(1440, 1000, 'second');
    writeFileSync(join(dir, 'before-a.png'), firstBytes);
    writeFileSync(join(dir, 'after-a.png'), secondBytes);
    const firstHash = sha256Of(firstBytes);
    const secondHash = sha256Of(secondBytes);
    const wrongSecond = `${secondHash.slice(0, 63)}${secondHash.endsWith('0') ? '1' : '0'}`;

    const { sha256Files, problems } = verifyDocDimensions({
      readmeText: viewportRow(
        ['before-a.png', 'after-a.png'],
        1440,
        1000,
        1440,
        1000,
        [firstHash, wrongSecond],
      ),
      dir,
    });

    expect(sha256Files).toBe(2);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      readmeLine: 1,
      file: 'after-a.png',
      kind: 'viewport',
      check: 'sha256',
      docSha256: wrongSecond,
      actualSha256: secondHash,
      reason: 'sha256 不一致',
    });
  });

  it('reports a truncated sha256 against the second file of a multi-file row', () => {
    const dir = makeTempDir();
    const firstBytes = makeLabelledPng(640, 1280, 'first');
    const secondBytes = makeLabelledPng(640, 1280, 'second');
    writeFileSync(join(dir, 'before-b.png'), firstBytes);
    writeFileSync(join(dir, 'after-b.png'), secondBytes);
    const firstHash = sha256Of(firstBytes);
    const secondHash = sha256Of(secondBytes);
    const truncatedSecond = secondHash.slice(0, 63);

    const { sha256Files, problems } = verifyDocDimensions({
      readmeText: viewportRow(
        ['before-b.png', 'after-b.png'],
        320,
        640,
        640,
        1280,
        [firstHash, truncatedSecond],
      ),
      dir,
    });

    expect(sha256Files).toBe(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      readmeLine: 1,
      file: 'after-b.png',
      kind: 'viewport',
      check: 'sha256',
      docSha256: truncatedSecond,
      actualSha256: secondHash,
    });
    expect(problems[0]?.reason).toContain('sha256 截断');
  });

  it('ignores unrelated hash-like tokens and keeps the trailing documented hash', () => {
    const dir = makeTempDir();
    const bytes = makePng(1440, 1000);
    writeFileSync(join(dir, 'after-a.png'), bytes);
    const actual = sha256Of(bytes);
    const wrong = `${actual.slice(0, 63)}${actual.endsWith('0') ? '1' : '0'}`;
    const commit = 'c'.repeat(40);
    const readmeText =
      `| \`after-a.png\` | \`${commit}\` | 1440×1000 / 1440×1000 | ` +
      `\`${commit}\` / \`${wrong}\` |`;

    const { sha256Files, problems } = verifyDocDimensions({ readmeText, dir });

    expect(sha256Files).toBe(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      readmeLine: 1,
      file: 'after-a.png',
      check: 'sha256',
      docSha256: wrong,
      actualSha256: actual,
      reason: 'sha256 不一致',
    });
  });

  it('skips ellipsis shorthand and short hex that does not match the PNG hash', () => {
    const dir = makeTempDir();
    writePng(dir, 'after-a.png', 1440, 1000);
    const readmeText = [
      viewportRow(['after-a.png'], 1440, 1000, 1440, 1000, ['7232a897…']),
      viewportRow(['after-a.png'], 1440, 1000, 1440, 1000, ['a'.repeat(63)]),
      viewportRow(['after-a.png'], 1440, 1000, 1440, 1000, ['deadbeef']),
      viewportRow(['after-a.png'], 1440, 1000, 1440, 1000, ['abc1234']),
      viewportRow(['after-a.png'], 1440, 1000, 1440, 1000, ['g'.repeat(64)]),
    ].join('\n');

    const report = verifyDocDimensions({ readmeText, dir });

    expect(report.sha256Files).toBe(0);
    expect(report.problems).toEqual([]);
  });

  it('reports an unmarked truncated sha256 that is a prefix of the PNG hash', () => {
    const dir = makeTempDir();
    const desktopBytes = makePng(1440, 1000);
    const phoneBytes = makePng(320, 640);
    writeFileSync(join(dir, 'desktop.png'), desktopBytes);
    writeFileSync(join(dir, 'phone.png'), phoneBytes);
    const desktopHash = sha256Of(desktopBytes);
    const phoneHash = sha256Of(phoneBytes);
    const readmeText = [
      viewportRow(['desktop.png'], 1440, 1000, 1440, 1000, [desktopHash.slice(0, 63)]),
      viewportRow(['phone.png'], 320, 640, 320, 640, [phoneHash.slice(0, 8)]),
    ].join('\n');

    const { problems } = verifyDocDimensions({ readmeText, dir });

    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({
      readmeLine: 1,
      file: 'desktop.png',
      check: 'sha256',
      docSha256: desktopHash.slice(0, 63),
      actualSha256: desktopHash,
    });
    expect(problems[0]?.reason).toContain('sha256 截断');
    expect(problems[1]).toMatchObject({
      readmeLine: 2,
      file: 'phone.png',
      check: 'sha256',
      docSha256: phoneHash.slice(0, 8),
      actualSha256: phoneHash,
    });
  });

  it('checks size and sha256 in one pass and reports both problems', () => {
    const dir = makeTempDir();
    const bytes = makePng(1440, 1000);
    writeFileSync(join(dir, 'after-a.png'), bytes);
    const actual = sha256Of(bytes);
    const documented = '0'.repeat(64);

    const { rows, problems } = verifyDocDimensions({
      readmeText: viewportRow(['after-a.png'], 1440, 1000, 1441, 1000, [documented]),
      dir,
    });

    expect(rows).toBe(1);
    expect(problems.map((problem) => problem.check)).toEqual(['size', 'sha256']);
    expect(problems[0]).toMatchObject({
      check: 'size',
      docWidth: 1441,
      docHeight: 1000,
      actualWidth: 1440,
      actualHeight: 1000,
      docSha256: documented,
      actualSha256: actual,
      reason: '尺寸不一致',
    });
    expect(problems[1]).toMatchObject({
      check: 'sha256',
      docSha256: documented,
      actualSha256: actual,
      reason: 'sha256 不一致',
    });
  });

  it('reports a missing PNG even when the row documents a sha256', () => {
    const dir = makeTempDir();
    const documented = 'a'.repeat(64);

    const { files, sha256Files, problems } = verifyDocDimensions({
      readmeText: viewportRow(['missing.png'], 320, 640, 640, 1280, [documented]),
      dir,
    });

    expect(files).toBe(1);
    expect(sha256Files).toBe(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      readmeLine: 1,
      file: 'missing.png',
      kind: 'viewport',
      check: 'size',
      docSha256: documented,
      actualSha256: null,
    });
    expect(problems[0]?.reason).toContain('PNG 文件缺失');
  });

  it('reports a wrong documented viewport PNG size', () => {
    const dir = makeTempDir();
    writePng(dir, 'after-hub-copy-desktop.png', 1440, 1000);

    const { problems } = verifyDocDimensions({
      readmeText: viewportRow(['after-hub-copy-desktop.png'], 1440, 1000, 1441, 1000),
      dir,
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      readmeLine: 1,
      file: 'after-hub-copy-desktop.png',
      kind: 'viewport',
      docWidth: 1441,
      docHeight: 1000,
      actualWidth: 1440,
      actualHeight: 1000,
      reason: '尺寸不一致',
    });
  });

  it('reports a missing viewport PNG', () => {
    const dir = makeTempDir();

    const { files, problems } = verifyDocDimensions({
      readmeText: viewportRow(['missing.png'], 320, 640, 640, 1280),
      dir,
    });

    expect(files).toBe(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      readmeLine: 1,
      file: 'missing.png',
      kind: 'viewport',
      docWidth: 640,
      docHeight: 1280,
      actualWidth: null,
      actualHeight: null,
    });
    expect(problems[0]?.reason).toContain('PNG 文件缺失');
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
      kind: 'full-page',
      docWidth: 1000,
      docHeight: 1324,
      actualWidth: 1440,
      actualHeight: 1324,
      reason: '尺寸不一致',
    });
    expect(problems[1]).toMatchObject({
      readmeLine: 2,
      file: 'height.png',
      kind: 'full-page',
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
      kind: 'full-page',
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
    expect(stdout).toContain('24 个文件');
    expect(stdout).toContain('24 行 README');
    expect(stdout).toContain('整页 16 行 / 视口 8 行');
    expect(stdout).toContain('sha256 8 个文件');
    expect(stdout).toContain('尺寸与 sha256 全部一致');
  });

  it('exits 0 for a correct viewport row whose CSS size differs from the PNG size', () => {
    const dir = makeTempDir();
    writePng(dir, 'phone.png', 640, 1280);
    const readme = writeReadme(dir, [
      '# 截图来源',
      viewportRow(['phone.png'], 320, 640, 640, 1280),
    ]);

    const { status, stdout, stderr } = runCli(['--readme', readme, '--dir', dir]);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain('1 个文件');
    expect(stdout).toContain('1 行 README');
    expect(stdout).toContain('整页 0 行 / 视口 1 行');
  });

  it('exits 1 for a wrong viewport PNG size and prints the documented and actual sizes', () => {
    const dir = makeTempDir();
    writePng(dir, 'after-hub-copy-desktop.png', 1440, 1000);
    const readme = writeReadme(dir, [
      '# 截图来源',
      viewportRow(['after-hub-copy-desktop.png'], 1440, 1000, 1441, 1000),
    ]);

    const { status, stdout } = runCli(['--readme', readme, '--dir', dir]);

    expect(status).toBe(1);
    expect(stdout).toContain('README 2: after-hub-copy-desktop.png');
    expect(stdout).toContain('视口 PNG 1441×1000');
    expect(stdout).toContain('!= PNG 1440×1000');
    expect(stdout).toContain('尺寸不一致');
  });

  it('exits 1 and names a missing viewport PNG', () => {
    const dir = makeTempDir();
    const readme = writeReadme(dir, [
      '# 截图来源',
      viewportRow(['missing-viewport.png'], 320, 640, 640, 1280),
    ]);

    const { status, stdout } = runCli(['--readme', readme, '--dir', dir]);

    expect(status).toBe(1);
    expect(stdout).toContain('README 2: missing-viewport.png');
    expect(stdout).toContain('视口 PNG 640×1280');
    expect(stdout).toContain('PNG 文件缺失');
  });

  it('exits 0 when the documented sha256 matches the PNG', () => {
    const dir = makeTempDir();
    const bytes = makePng(1440, 1000);
    writeFileSync(join(dir, 'after-a.png'), bytes);
    const readme = writeReadme(dir, [
      '# 截图来源',
      viewportRow(['after-a.png'], 1440, 1000, 1440, 1000, [sha256Of(bytes)]),
    ]);

    const { status, stdout, stderr } = runCli(['--readme', readme, '--dir', dir]);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain('sha256 1 个文件');
    expect(stdout).toContain('尺寸与 sha256 全部一致');
  });

  it('exits 1 for a wrong sha256 and prints the documented and actual hashes', () => {
    const dir = makeTempDir();
    const bytes = makePng(1440, 1000);
    writeFileSync(join(dir, 'after-a.png'), bytes);
    const actual = sha256Of(bytes);
    const documented = '0'.repeat(64);
    const readme = writeReadme(dir, [
      '# 截图来源',
      viewportRow(['after-a.png'], 1440, 1000, 1440, 1000, [documented]),
    ]);

    const { status, stdout } = runCli(['--readme', readme, '--dir', dir]);

    expect(status).toBe(1);
    expect(stdout).toContain('README 2: after-a.png');
    expect(stdout).toContain(documented);
    expect(stdout).toContain(actual);
    expect(stdout).toContain('sha256 不一致');
  });

  it('exits 1 for a truncated sha256 and prints the documented and actual hashes', () => {
    const dir = makeTempDir();
    const bytes = makePng(1440, 1000);
    writeFileSync(join(dir, 'after-a.png'), bytes);
    const actual = sha256Of(bytes);
    const documented = actual.slice(0, 63);
    const readme = writeReadme(dir, [
      '# 截图来源',
      viewportRow(['after-a.png'], 1440, 1000, 1440, 1000, [documented]),
    ]);

    const { status, stdout } = runCli(['--readme', readme, '--dir', dir]);

    expect(status).toBe(1);
    expect(stdout).toContain('README 2: after-a.png');
    expect(stdout).toContain(documented);
    expect(stdout).toContain(actual);
    expect(stdout).toContain('sha256 截断');
  });

  it('exits 0 and skips an ellipsis 8-character sha256', () => {
    const dir = makeTempDir();
    writePng(dir, 'after-hub-desktop.png', 1440, 1000);
    const readme = writeReadme(dir, [
      '# 截图来源',
      viewportRow(['after-hub-desktop.png'], 1440, 1000, 1440, 1000, ['7232a897…']),
    ]);

    const { status, stdout, stderr } = runCli(['--readme', readme, '--dir', dir]);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain('sha256 0 个文件');
    expect(stdout).not.toContain('7232a897');
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
