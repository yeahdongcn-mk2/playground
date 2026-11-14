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

const HUB_SCREENSHOTS = ['after-hub-desktop.png', 'after-hub-mobile.png'] as const;

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

  it('documents a complete sha256 for the 8 viewport rows and 2 hub full-page rows', () => {
    const readmeText = readFileSync(README, 'utf8');
    const rows = parseDocDimensions(readmeText);
    const hashedRows = rows.filter((row) => row.hashes.some((hash) => hash !== null));

    expect(hashedRows.flatMap((row) => row.files)).toEqual([
      'after-hub-desktop.png',
      'after-hub-mobile.png',
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

    const hubRows = rows.filter((row) =>
      row.files.some(
        (file) => file === 'after-hub-desktop.png' || file === 'after-hub-mobile.png',
      ),
    );
    expect(hubRows).toHaveLength(2);
    const hubRowsByFile = new Map(
      hubRows.flatMap((row) => row.files.map((file) => [file, row] as const)),
    );
    for (const file of ['after-hub-desktop.png', 'after-hub-mobile.png']) {
      const row = hubRowsByFile.get(file);
      expect(row?.kind).toBe('full-page');
      expect(row?.hashes).toEqual([
        sha256Of(readFileSync(join(SCREENSHOT_DIR, file))),
      ]);
    }
  });
});

describe('committed hub screenshot full-page docs (Issue #161)', () => {
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

  it('checks the complete hub sha256 and reports a wrong or truncated hash with both values', () => {
    const source = readFileSync(README, 'utf8');
    const rows = parseDocDimensions(source);

    for (const file of HUB_SCREENSHOTS) {
      const row = rows.find((candidate) => candidate.files.includes(file));
      if (row === undefined) throw new Error(`README 缺少 ${file} 的整页尺寸行`);
      const actual = sha256Of(readFileSync(join(SCREENSHOT_DIR, file)));
      expect(row.hashes).toEqual([actual]);

      const wrong = `${actual.slice(0, 63)}${actual.endsWith('0') ? '1' : '0'}`;
      const truncated = actual.slice(0, 63);
      for (const [documented, reason] of [
        [wrong, 'sha256 不一致'],
        [truncated, 'sha256 截断'],
      ] as const) {
        const mutated = source.replace(`\`${actual}\``, `\`${documented}\``);
        expect(mutated).not.toBe(source);
        const report = verifyDocDimensions({ readmeText: mutated, dir: SCREENSHOT_DIR });

        const completeHashes = parseDocDimensions(mutated)
          .flatMap((mutatedRow) => mutatedRow.hashes)
          .filter((hash) => hash !== null && hash.length === 64);
        expect(report.sha256Files).toBe(completeHashes.length);
        expect(report.problems).toHaveLength(1);
        expect(report.problems[0]).toMatchObject({
          readmeLine: row.line,
          file,
          kind: 'full-page',
          check: 'sha256',
          docSha256: documented,
          actualSha256: actual,
        });
        expect(report.problems[0]?.reason).toContain(reason);
      }
    }

    expect(verifyDocDimensions({ readmeText: source, dir: SCREENSHOT_DIR }).problems).toEqual([]);
  });
});

describe('hub screenshot single owner docs (Issue #221)', () => {
  const HUB_OWNER_COMMAND = 'npm run screenshots:container -- screenshots';
  const SINGLE_GAME_COMMAND =
    /screenshots:(?:2048|breakout|minesweeper|snake)(?::[a-z0-9-]+)*/;
  // The two committed full-page hub captures and the wording that refers to
  // them; `after-hub-*.png` names the shared pair together. `after-hub-webkit.png`
  // is separate viewport evidence, so a bare `hub` must not match that filename.
  const HUB_EVIDENCE =
    /after-hub-(?:desktop|mobile|\*)\.png|共享大厅证据|大厅证据|共享证据|共享图|(?<!after-)\bhub\b/i;
  // Commands that may legitimately write the shared hub evidence. The plain
  // `screenshots` command is the owner entry point (`capture-screenshots.mjs`).
  const OWNER_COMMAND =
    /screenshots:container -- screenshots|capture-screenshots\.mjs|npm run screenshots(?!:)/;
  const WRITE_VERB = /写出|写入|写|还原|刷新|重写|覆盖|更新|生成/;
  // `只由` / `仅由` are ownership assertions, not negations: they are checked
  // separately by the owner-attribution rule below.
  const OWNER_ATTRIBUTION_WORDING = /只由|仅由/;
  // Capture command mentioned by an ownership sentence. Backticks are optional
  // so prose such as `只由 npm run screenshots:2048 写入` is covered too.
  const CAPTURE_COMMAND =
    /`?npm run screenshots(?::[a-z0-9-]+)*(?:\s+--\s+screenshots(?::[a-z0-9-]+)*)?`?/g;
  const NON_REFRESH_WORDING =
    /不再|不会|不写|不重写|不刷新|不覆盖|不生成|未写|未生成|未刷新|未还原|未重写|未覆盖|不需要|不允许|无需|不必|无关|不由|禁止|不得/;
  // Exact wording removed by Issue #221: single-game capture commands used to
  // "incidentally write out" / "restore" the shared hub files.
  const STALE_HUB_WORDING =
    /(?:顺带|同时|也|再|会|仍)?\s*(?:写出|写|刷新|重写|覆盖|还原|生成)\s*(?:出\s*)?[`\s]*(?:hub|共享大厅证据|共享证据|大厅证据|共享图|after-hub-(?:desktop|mobile|\*)\.png)/i;

  const OLD_2048_PARAGRAPH =
    '  两次运行的 6 个 sha256 应完全一致，且等于已提交产物。本任务只提交这 6 张 playing / gameover 图；' +
    'After 守卫现在会跳过 ready 桌面 / 手机 / WebKit 历史图，只顺带写出 hub，提交前用 `git checkout --` ' +
    '还原 hub，保持未受影响的已提交产物不变。WebKit 产物在官方 Playwright 容器' +
    '（`mcr.microsoft.com/playwright:v1.64.1-noble`，与仓库的 Playwright 1.64.1 对应）内捕获，' +
    '避免宿主 EGL / 字体环境差异。';
  const OLD_SNAKE_BULLET =
    '- 提交范围：After 守卫会跳过 ready / gameover / mobile 历史图，只顺带写出 hub；' +
    '提交前用 `git checkout --` 还原 hub，只保留本任务的 `after-snake-playing.png` 与文档 / 测试改动，' +
    '未受影响的已提交产物保持不变。';

  interface HubRow {
    line: number;
    command: string | null;
  }

  interface LineEntry {
    line: number;
    text: string;
  }

  /** Split a Markdown line into clauses so a negation cannot hide a later claim. */
  function clausesOf(line: string): string[] {
    return line
      .split(/[，。；,;]|但|却/)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0);
  }

  /** Group lines into blank-line separated blocks (a paragraph / list item). */
  function blankLineBlocks(text: string): LineEntry[][] {
    const blocks: LineEntry[][] = [];
    let current: LineEntry[] = [];
    text.split('\n').forEach((lineText, index) => {
      if (lineText.trim() === '') {
        if (current.length > 0) blocks.push(current);
        current = [];
        return;
      }
      current.push({ line: index + 1, text: lineText });
    });
    if (current.length > 0) blocks.push(current);
    return blocks;
  }

  /** Group lines into heading-delimited sections, keeping 1-based line numbers. */
  function markdownSections(text: string): LineEntry[][] {
    const sections: LineEntry[][] = [];
    let current: LineEntry[] = [];
    text.split('\n').forEach((lineText, index) => {
      if (/^#{1,6} /.test(lineText)) {
        if (current.length > 0) sections.push(current);
        current = [];
      }
      current.push({ line: index + 1, text: lineText });
    });
    if (current.length > 0) sections.push(current);
    return sections;
  }

  /**
   * Contract for the committed shared-hub evidence:
   * 1. the two hub table rows must name the container owner command;
   * 2. every `只由 / 仅由 ... 写入` ownership sentence must name the owner
   *    command (and no single-game command), even inside parentheses;
   * 3. a single-game screenshot command may only mention hub evidence in its
   *    own paragraph when the clause says it does not write it;
   * 4. the old "incidentally writes hub / restore hub" wording must never come
   *    back, even when it is moved away from its original command block.
   * A clause can break more than one rule, so it may produce more than one
   * message; tests mutate the README and assert the exact contract that broke.
   */
  function hubCaptureProblems(text: string): string[] {
    const problems: string[] = [];
    const rows = new Map<string, HubRow[]>();

    text.split('\n').forEach((line, index) => {
      if (!line.startsWith('|')) return;
      const cells = line.split('|');
      const commandCell = cells[cells.length - 2] ?? '';
      // Only the authoritative evidence table records a capture command; the
      // historical sections may still name the same files in their tables.
      if (!commandCell.includes('npm run ')) return;
      for (const file of HUB_SCREENSHOTS) {
        if (!line.includes(`\`${file}\``)) continue;
        const commands = [...commandCell.matchAll(/`(npm run [^`]+)`/g)].map(
          (match) => match[1] ?? '',
        );
        const row: HubRow = { line: index + 1, command: commands[0] ?? null };
        rows.set(file, [...(rows.get(file) ?? []), row]);
      }
    });

    for (const file of HUB_SCREENSHOTS) {
      const fileRows = rows.get(file) ?? [];
      const row = fileRows[0];
      if (fileRows.length !== 1 || row === undefined) {
        problems.push(`README 应有且仅有一行 ${file}，实际 ${fileRows.length} 行`);
        continue;
      }
      if (row.command !== HUB_OWNER_COMMAND) {
        problems.push(
          `README ${row.line}: ${file} 的捕获命令必须是 ${HUB_OWNER_COMMAND}，` +
            `实际 ${row.command ?? '缺少命令'}`,
        );
      }
    }

    // A `只由 / 仅由` sentence that names capture commands is an ownership
    // assertion, not a negation: every such command must be the documented
    // owner command. Only commands after the attribution are the claim, so a
    // negated single-game command earlier in the same clause (e.g. 「
    // `npm run screenshots:2048` 不写共享大厅证据（… 只由 owner 写入）」) is fine.
    text.split('\n').forEach((lineText, index) => {
      for (const clause of clausesOf(lineText)) {
        const attribution = OWNER_ATTRIBUTION_WORDING.exec(clause);
        if (attribution === null || attribution.index === undefined) continue;
        if (!HUB_EVIDENCE.test(clause)) continue;
        const commands = [...clause.slice(attribution.index).matchAll(CAPTURE_COMMAND)].map(
          (match) => (match[0] ?? '').replaceAll('`', '').replace(/\s+/g, ' ').trim(),
        );
        // Prose such as 「只由 Playwright 渲染生成」 is not a capture-command
        // attribution, and a sentence without a command is not this contract.
        if (commands.length === 0) continue;
        if (commands.every((command) => command === HUB_OWNER_COMMAND)) continue;
        problems.push(
          `README ${index + 1}: 共享大厅证据的「只由 / 仅由」归属句必须使用 ` +
            `${HUB_OWNER_COMMAND} 且不得含单游戏命令：${clause}`,
        );
      }
    });

    // A clause that also names a single-game command is that command's claim,
    // so an owner command elsewhere in the clause must not whitelist it.
    const isOwnerAttributed = (clause: string): boolean =>
      OWNER_COMMAND.test(clause) && !SINGLE_GAME_COMMAND.test(clause);

    for (const block of blankLineBlocks(text)) {
      if (!block.some(({ text: line }) => SINGLE_GAME_COMMAND.test(line))) continue;
      for (const { line, text: lineText } of block) {
        for (const clause of clausesOf(lineText)) {
          if (!HUB_EVIDENCE.test(clause) || !WRITE_VERB.test(clause)) continue;
          if (NON_REFRESH_WORDING.test(clause) || isOwnerAttributed(clause)) continue;
          problems.push(
            `README ${line}: 单游戏截图命令所在段落被描述为写共享大厅证据：${clause}`,
          );
        }
      }
    }

    for (const section of markdownSections(text)) {
      for (const { line, text: lineText } of section) {
        if (!STALE_HUB_WORDING.test(lineText)) continue;
        for (const clause of clausesOf(lineText)) {
          if (!STALE_HUB_WORDING.test(clause)) continue;
          if (NON_REFRESH_WORDING.test(clause) || isOwnerAttributed(clause)) continue;
          problems.push(`README ${line}: 仍在使用旧的「顺带写出 hub」表述：${clause}`);
        }
      }
    }

    return problems;
  }

  function replaceLine(
    source: string,
    predicate: (line: string) => boolean,
    replacement: string,
  ): string {
    const lines = source.split('\n');
    const index = lines.findIndex(predicate);
    expect(index, 'README 缺少待变异的行').toBeGreaterThanOrEqual(0);
    lines[index] = replacement;
    return lines.join('\n');
  }

  it('attributes both hub screenshots to the container owner command only', () => {
    const readmeText = readFileSync(README, 'utf8');
    expect(hubCaptureProblems(readmeText)).toEqual([]);

    const ownership = readmeText
      .split('\n')
      .find((line) => line.startsWith('- 单一 owner（Issue #221）：'));
    expect(ownership, 'README 缺少「单一 owner」条目').toBeDefined();
    expect(ownership).toContain(HUB_OWNER_COMMAND);
    expect(ownership).toContain('`scripts/capture-screenshots.mjs`');
    expect(ownership).toContain('不再重写');
    for (const command of [
      'npm run screenshots:2048',
      'npm run screenshots:breakout',
      'npm run screenshots:minesweeper',
      'npm run screenshots:snake',
    ]) {
      expect(ownership).toContain(`\`${command}\``);
    }
  });

  /** Prefix every problem from the owner-attribution rule starts with. */
  function ownershipProblemPrefix(line: number): string {
    return (
      `README ${line}: 共享大厅证据的「只由 / 仅由」归属句必须使用 ` +
      `${HUB_OWNER_COMMAND} 且不得含单游戏命令`
    );
  }

  it('fails when any real owner-attributed hub sentence names a single-game command', () => {
    const source = readFileSync(README, 'utf8');
    const lines = source.split('\n');
    const ownerSentences = [
      {
        label: '2048 确定性重截',
        matches: (line: string) =>
          line.trimStart().startsWith('两次运行的 6 个 sha256 应完全一致') &&
          OWNER_ATTRIBUTION_WORDING.test(line),
      },
      {
        label: '扫雷生成 After',
        matches: (line: string) =>
          line.startsWith('- 生成 After：`npm run screenshots:minesweeper`') &&
          OWNER_ATTRIBUTION_WORDING.test(line),
      },
      {
        label: '贪食蛇提交范围',
        matches: (line: string) =>
          line.startsWith('- 提交范围：After 守卫会跳过 ready / gameover / mobile 历史图') &&
          OWNER_ATTRIBUTION_WORDING.test(line),
      },
    ];

    for (const { label, matches } of ownerSentences) {
      const matchesIndex = lines.findIndex(matches);
      if (matchesIndex < 0) throw new Error(`${label} 缺少 owner 归属句`);
      const line = lines[matchesIndex]!;
      expect(line).toContain(HUB_OWNER_COMMAND);

      // Rewrite the owner attribution to a single-game command while keeping
      // the surrounding negation (「不写 / 不再写」) and parentheses intact.
      const mutatedLine = line.replace(HUB_OWNER_COMMAND, 'npm run screenshots:2048');
      expect(mutatedLine).not.toBe(line);
      const problems = hubCaptureProblems(source.replace(line, mutatedLine));

      const prefix = ownershipProblemPrefix(matchesIndex + 1);
      expect(
        problems.some((problem) => problem.startsWith(prefix)),
        `${label} 改成单游戏命令后未被捕获：${problems.join('；')}`,
      ).toBe(true);
    }
  });

  it('fails when an added 仅由 ownership sentence names a single-game command', () => {
    const source = readFileSync(README, 'utf8');
    // Matches the review reproduction, which writes the command without
    // backticks: the bare `npm run screenshots:2048` must be caught too.
    const addedLine = '- `after-hub-desktop.png` 仅由 npm run screenshots:2048 写入。';
    const addedLineNumber = source.split('\n').length + 1;

    const problems = hubCaptureProblems(`${source}\n${addedLine}\n`);

    expect(
      problems.some((problem) => problem.startsWith(ownershipProblemPrefix(addedLineNumber))),
      `追加的「仅由」错误归属未被捕获：${problems.join('；')}`,
    ).toBe(true);
  });

  it('rejects mixed owner / single-game claims but ignores prose-only attributions', () => {
    const source = readFileSync(README, 'utf8');
    const addedLineNumber = source.split('\n').length + 1;
    const mixed =
      '- `after-hub-desktop.png` 只由 `npm run screenshots:container -- screenshots` ' +
      '与 `npm run screenshots:2048` 写入。';

    const mixedProblems = hubCaptureProblems(`${source}\n${mixed}\n`);

    expect(
      mixedProblems.some((problem) =>
        problem.startsWith(ownershipProblemPrefix(addedLineNumber)),
      ),
      `owner / 单游戏混写未被捕获：${mixedProblems.join('；')}`,
    ).toBe(true);

    // The write verb may sit in the next clause; the command still belongs to
    // the attribution and must fail.
    const commaClaim = '- `after-hub-*.png` 只由 `npm run screenshots:2048`，写入方式同下。';
    expect(
      hubCaptureProblems(`${source}\n${commaClaim}\n`).some((problem) =>
        problem.startsWith(ownershipProblemPrefix(addedLineNumber)),
      ),
      '跨逗号的单游戏归属未被捕获',
    ).toBe(true);

    const legitimate = [
      // The negation applies to the single-game command before the attribution;
      // only the commands after 「只由」 are the ownership claim.
      '- `npm run screenshots:2048` 不写共享大厅证据' +
        '（`after-hub-*.png` 只由 `npm run screenshots:container -- screenshots` 写入）。',
      // `只由` may describe what determines a capture without naming a writer.
      '- `after-hub-desktop.png` 只由 seed 与 tick 数决定。',
      '- 大厅 hub 图只由 Playwright 渲染生成。',
      '- hub 路由只由 `npm run test:unit` 覆盖。',
    ];
    for (const line of legitimate) {
      expect(hubCaptureProblems(`${source}\n${line}\n`), line).toEqual([]);
    }
  });

  it('fails when a hub table row names a single-game command', () => {
    const source = readFileSync(README, 'utf8');
    const mutated = source
      .split('\n')
      .map((line) =>
        line.includes('`after-hub-desktop.png`') && line.includes(HUB_OWNER_COMMAND)
          ? line.replace(HUB_OWNER_COMMAND, 'npm run screenshots:2048')
          : line,
      )
      .join('\n');
    expect(mutated).not.toBe(source);

    const problems = hubCaptureProblems(mutated);

    expect(problems.some((problem) => problem.includes('after-hub-desktop.png'))).toBe(true);
  });

  it('fails when the removed 2048 hub wording is restored in place', () => {
    const source = readFileSync(README, 'utf8');
    const mutated = replaceLine(
      source,
      (line) => line.trimStart().startsWith('两次运行的 6 个 sha256 应完全一致'),
      OLD_2048_PARAGRAPH,
    );
    expect(mutated).not.toBe(source);

    const problems = hubCaptureProblems(mutated);

    expect(problems.some((problem) => problem.includes('仍在使用旧的'))).toBe(true);
  });

  it('fails when the removed snake hub wording is restored in place', () => {
    const source = readFileSync(README, 'utf8');
    const mutated = replaceLine(
      source,
      (line) =>
        line.startsWith('- 提交范围：After 守卫会跳过 ready / gameover / mobile 历史图'),
      OLD_SNAKE_BULLET,
    );
    expect(mutated).not.toBe(source);

    const problems = hubCaptureProblems(mutated);

    expect(problems.some((problem) => problem.includes('顺带写出 hub'))).toBe(true);
  });

  it('fails when the exact old hub wording is appended to the README', () => {
    const source = readFileSync(README, 'utf8');

    const problems = hubCaptureProblems(
      `${source}\n${OLD_2048_PARAGRAPH}\n${OLD_SNAKE_BULLET}\n`,
    );

    expect(problems.some((problem) => problem.includes('顺带写出 hub'))).toBe(true);
  });

  it('fails when a single-game command is described as refreshing hub evidence', () => {
    const source = readFileSync(README, 'utf8');
    const staleWording =
      '\n- `npm run screenshots:snake` 会顺带刷新 `after-hub-desktop.png` 与 `after-hub-mobile.png`。\n';

    const problems = hubCaptureProblems(`${source}${staleWording}`);

    expect(problems.some((problem) => problem.includes('单游戏截图命令'))).toBe(true);
  });

  it('fails when one hub file is negated but the other is still claimed', () => {
    const source = readFileSync(README, 'utf8');
    const staleWording =
      '\n- `npm run screenshots:2048` 不再写 `after-hub-desktop.png`，但会刷新 `after-hub-mobile.png`。\n';

    const problems = hubCaptureProblems(`${source}${staleWording}`);

    expect(problems.some((problem) => problem.includes('单游戏截图命令'))).toBe(true);
  });

  it('fails when the old wording is moved into an owner-only section', () => {
    const source = readFileSync(README, 'utf8');
    const ownerLine = source
      .split('\n')
      .find((line) => line.includes('（owner 命令）仍会写出 hub 图'));
    expect(ownerLine, 'README 缺少 owner 命令写出 hub 的说明').toBeDefined();
    const mutated = source.replace(`${ownerLine}\n`, `${ownerLine}\n${OLD_SNAKE_BULLET}\n`);
    expect(mutated).not.toBe(source);

    const problems = hubCaptureProblems(mutated);

    expect(problems.some((problem) => problem.includes('顺带写出 hub'))).toBe(true);
  });

  it('fails when a negation shields a coordinated stale claim', () => {
    const source = readFileSync(README, 'utf8');
    const staleWording = '\n- `npm run screenshots:2048` 不写历史图但会顺带写出 hub。\n';

    const problems = hubCaptureProblems(`${source}${staleWording}`);

    expect(problems.some((problem) => problem.includes('顺带写出 hub'))).toBe(true);
  });

  it('fails when a single-game command and the owner command share the claim', () => {
    const source = readFileSync(README, 'utf8');
    const staleWording =
      '\n- `npm run screenshots:2048` 与 `npm run screenshots` 都会顺带写出 hub。\n';

    const problems = hubCaptureProblems(`${source}${staleWording}`);

    expect(problems.some((problem) => problem.includes('顺带写出 hub'))).toBe(true);
  });

  it('fails when the owner command is used with a single-game capture target', () => {
    const source = readFileSync(README, 'utf8');
    const staleWording =
      '\n- `npm run screenshots:container -- screenshots:2048` 会顺带写出 hub。\n';

    const problems = hubCaptureProblems(`${source}${staleWording}`);

    expect(problems.some((problem) => problem.includes('顺带写出 hub'))).toBe(true);
  });

  it('fails when a game script is described as writing a hub file by name', () => {
    const source = readFileSync(README, 'utf8');

    for (const staleWording of [
      '\n- 2048 截图脚本会顺带写出 `after-hub-desktop.png`。\n',
      '\n- 2048 截图脚本会顺带写出 `after-hub-*.png`。\n',
    ]) {
      const problems = hubCaptureProblems(`${source}${staleWording}`);

      expect(problems.some((problem) => problem.includes('顺带写出'))).toBe(true);
    }
  });

  it('fails when a hub table row is missing or duplicated', () => {
    const source = readFileSync(README, 'utf8');
    const lines = source.split('\n');
    const desktopRow = lines.find(
      (line) =>
        line.startsWith('|') &&
        line.includes('`after-hub-desktop.png`') &&
        line.includes(HUB_OWNER_COMMAND),
    );
    const mobileRow = lines.find(
      (line) =>
        line.startsWith('|') &&
        line.includes('`after-hub-mobile.png`') &&
        line.includes(HUB_OWNER_COMMAND),
    );
    expect(desktopRow, 'README 缺少 after-hub-desktop.png 的捕获行').toBeDefined();
    expect(mobileRow, 'README 缺少 after-hub-mobile.png 的捕获行').toBeDefined();

    const withoutDesktop = source.replace(`${desktopRow}\n`, '');
    expect(withoutDesktop).not.toBe(source);
    expect(
      hubCaptureProblems(withoutDesktop).some((problem) =>
        problem.includes('after-hub-desktop.png，实际 0 行'),
      ),
    ).toBe(true);

    const duplicated = source.replace(`${mobileRow}\n`, `${mobileRow}\n${mobileRow}\n`);
    expect(duplicated).not.toBe(source);
    expect(
      hubCaptureProblems(duplicated).some((problem) =>
        problem.includes('after-hub-mobile.png，实际 2 行'),
      ),
    ).toBe(true);
  });

  it('does not treat after-hub-webkit.png as shared hub evidence', () => {
    const source = readFileSync(README, 'utf8');
    const webkitWording =
      '\n- `npm run screenshots:2048` 会刷新 `after-hub-webkit.png`。\n';

    expect(hubCaptureProblems(`${source}${webkitWording}`)).toEqual([]);
  });

  it('accepts equivalent negations that do not write hub evidence', () => {
    const source = readFileSync(README, 'utf8');
    const legitimate = [
      '- `npm run screenshots:2048` 不生成共享大厅证据。',
      '- `npm run screenshots:2048` 本次未写 `after-hub-desktop.png`。',
      '- `npm run screenshots:2048` 生成的 `after-2048-playing-desktop.png` 与共享大厅证据无关。',
    ].join('\n');

    expect(hubCaptureProblems(`${source}\n${legitimate}\n`)).toEqual([]);
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
      sha256Files: 10,
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
    expect(stdout).toContain('sha256 10 个文件');
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

  it('exits 1 for a wrong or truncated hub full-page sha256 and prints the line, file and both hashes', () => {
    const source = readFileSync(README, 'utf8');
    const rows = parseDocDimensions(source);
    const dir = makeTempDir();

    for (const { file, truncate } of [
      { file: 'after-hub-desktop.png', truncate: false },
      { file: 'after-hub-mobile.png', truncate: true },
    ] as const) {
      const row = rows.find((candidate) => candidate.files.includes(file));
      if (row === undefined) throw new Error(`README 缺少 ${file} 的整页尺寸行`);
      const actual = sha256Of(readFileSync(join(SCREENSHOT_DIR, file)));
      const documented = truncate
        ? actual.slice(0, 63)
        : `${actual.slice(0, 63)}${actual.endsWith('0') ? '1' : '0'}`;
      const readme = writeReadme(
        dir,
        source.replace(`\`${actual}\``, `\`${documented}\``).split('\n'),
      );

      const { status, stdout, stderr } = runCli(['--readme', readme, '--dir', SCREENSHOT_DIR]);

      expect(stderr).toBe('');
      expect(status).toBe(1);
      expect(stdout).toContain(`README ${row.line}: ${file}`);
      expect(stdout).toContain(`sha256 文档 ${documented} != 实际 ${actual}`);
      expect(stdout).toContain(truncate ? 'sha256 截断' : 'sha256 不一致');
    }
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
