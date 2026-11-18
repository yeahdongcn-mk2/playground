import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENSHOTS_README = readFileSync(
  join(ROOT, 'docs', 'screenshots', 'README.md'),
  'utf8',
);

const HISTORICAL_HEADING = '## 历史 After 证据与当前构建不一致（Issue #137）';
const WEBKIT_PHONE_HEADING =
  '## webkit-phone：t1–t3 稳定场景的 WebKit 手机端截图（Issue #100 / t4）';
const WEBKIT_NARROW_HEADING =
  '## webkit-narrow：扫雷窄屏首屏契约的 WebKit 矩阵（Issue #83 / 子任务 1）';
const WEBKIT_HISTORICAL_TITLE = 'WebKit 历史证据（Issue #137 / #120）';
const WEBKIT_HISTORICAL_HEADING = `### ${WEBKIT_HISTORICAL_TITLE}`;
const CAPTURE_COMMIT = '498a14f';
const ISSUE_199_URL = 'https://github.com/yeahdongcn-mk2/playground/issues/199';
const CONTAINER_IMAGE = 'mcr.microsoft.com/playwright:v1.64.1-noble';

/** The text of one level-2 section, up to the next level-2 heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw new Error(`missing section: ${heading}`);
  }
  const end = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

/** The text of one level-3 subsection, up to the next level-2/3 heading. */
function subsection(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    throw new Error(`missing subsection: ${heading}`);
  }
  const nextLevel2 = text.indexOf('\n## ', start + heading.length);
  const nextLevel3 = text.indexOf('\n### ', start + heading.length);
  const candidates = [nextLevel2, nextLevel3].filter((index) => index >= 0);
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
}

const HISTORICAL = section(SCREENSHOTS_README, HISTORICAL_HEADING);
const WEBKIT_PHONE = section(SCREENSHOTS_README, WEBKIT_PHONE_HEADING);
const WEBKIT_NARROW = section(SCREENSHOTS_README, WEBKIT_NARROW_HEADING);
const WEBKIT_HISTORICAL = subsection(WEBKIT_PHONE, WEBKIT_HISTORICAL_HEADING);

const BREAKOUT_COLLECTED = [
  'after-breakout-ready-webkit.png',
  'after-breakout-levelclear-webkit.png',
  'after-breakout-gameover-webkit.png',
];
const BREAKOUT_COLLECTED_SHA256 = new Map([
  [
    'after-breakout-ready-webkit.png',
    '372a320ab27d94e2881484047adb358ef222391c00c1c4bfb6a636ab6f3e5f65',
  ],
  [
    'after-breakout-levelclear-webkit.png',
    'c1edf10ec9b483db6a022fa26998438286220d88d0be614a0ead09fe046ddf2d',
  ],
  [
    'after-breakout-gameover-webkit.png',
    'ea78b118f6a50374e2949affae4fca410eeedf057c4e316afad0cd1eae7b8d13',
  ],
]);
const BREAKOUT_CAPTURE_COMMIT = 'd3f0f30437b69022f29f6c7677f117f84ffc09f1';
const MINESWEEPER_COLLECTED = [
  'after-minesweeper-ready-webkit.png',
  'after-minesweeper-playing-webkit.png',
  'after-minesweeper-lost-webkit.png',
  'after-minesweeper-won-webkit.png',
];
const MINESWEEPER_COLLECTED_SHA256 = new Map([
  [
    'after-minesweeper-ready-webkit.png',
    '56c3f68d51c643d9e23a3e5a17d99b44b9da47c52d0cca451080ec3dc878fe0a',
  ],
  [
    'after-minesweeper-playing-webkit.png',
    'b64d959f12a3b8a08a0757d8cf1ae4875a21a3d96a6df8a28c4a81ca9290d9fb',
  ],
  [
    'after-minesweeper-lost-webkit.png',
    '6b888d338c7cea61d82578e3ce7e75e5b29620f3fdfc7f25a848a84fea12f3b4',
  ],
  [
    'after-minesweeper-won-webkit.png',
    '77e7b244607dbdec71ff31df1a991a6744d813fa800c254eb1ebbaf8567f12a2',
  ],
]);
const MINESWEEPER_CAPTURE_COMMIT = '76149a83e5aa58b37fd8e2e88bbf8e93f272aab9';
const NARROW_DRIFT = [
  'after-minesweeper-webkit-narrow-320x640.png',
  'after-minesweeper-webkit-narrow-360x640.png',
  'after-minesweeper-webkit-narrow-375x667.png',
  'after-minesweeper-webkit-narrow-412x839.png',
];
const DRIFTED = [...NARROW_DRIFT];
const DETERMINISTIC = [
  'after-breakout-playing-webkit.png',
  'after-2048-playing-webkit.png',
  'after-2048-gameover-webkit.png',
  'after-hub-webkit.png',
  'after-snake-webkit.png',
];
const HUB = 'after-hub-webkit.png';
const HUB_SHA256 =
  '6c2856e33a5619dc2eff5833c059608c74f03492192029515edf345b165581f4';
const SNAKE = 'after-snake-webkit.png';
const SNAKE_SHA256 =
  'd8e262f366b11436d5a1dc309f01ee86a473b23f74684fd92e03392fc28450ba';
const HUB_SNAKE_CAPTURE_COMMIT =
  'c6a8c6c0b6cb70aac968f12d834d00f1073ade61';
const MINESWEEPER_SCORES = 'after-minesweeper-scores-webkit.png';
const MINESWEEPER_SCORES_SHA256 =
  '44768a977454b98f4526033e96c3cdf60012f6278b10912cf7a11071419674fe';
const MINESWEEPER_SCORES_CAPTURE_COMMIT =
  '05818ae0bfe980ac9274d75146d22a4e59f96c8e';

/** Bullets nested under the drift list, which is where every drifted file must appear. */
function driftBullets(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.startsWith('  - '))
    .join('\n');
}

describe('WebKit historical evidence docs (Issue #137)', () => {
  it('records the #120 capture commit and the reviewed t2/t3/t4 re-shots', () => {
    expect(WEBKIT_HISTORICAL).toContain(CAPTURE_COMMIT);
    expect(WEBKIT_HISTORICAL).toContain('#120');
    expect(WEBKIT_HISTORICAL).toContain(
      'https://github.com/yeahdongcn-mk2/playground/commit/498a14fb2c7faf426ae79381f433b64f2a18586e',
    );
    expect(WEBKIT_HISTORICAL).toContain('9c39e68');
    expect(WEBKIT_HISTORICAL).toContain('重新捕获');
    expect(WEBKIT_HISTORICAL).toContain('t1 只重拍扫雷');
    expect(WEBKIT_HISTORICAL).toContain('只重拍扫雷最高用时榜');
    expect(WEBKIT_HISTORICAL).toContain('t3 只重拍大厅与贪食蛇');
    expect(WEBKIT_HISTORICAL).toContain('t4 只重拍打砖块');
    expect(WEBKIT_HISTORICAL).toContain('ready 增加首屏重绘接缝');
    expect(WEBKIT_HISTORICAL).toContain('其余已提交 PNG 不改动');
  });

  it('lists the drifted webkit-narrow artifacts', () => {
    for (const file of DRIFTED) {
      expect(WEBKIT_HISTORICAL).toContain(file);
      expect(driftBullets(WEBKIT_HISTORICAL)).toContain(file);
    }
    expect(WEBKIT_HISTORICAL).toContain('已报告的漂移产物');
    // The breakout READY / levelclear / gameover re-shots are collected, so they
    // must leave the drift list instead of being reported twice.
    for (const file of BREAKOUT_COLLECTED) {
      expect(driftBullets(WEBKIT_HISTORICAL)).not.toContain(file);
    }
    // The four minesweeper WebKit phone states are collected by Issue #318 t1,
    // so they must leave the drift bullet instead of being reported twice.
    for (const file of MINESWEEPER_COLLECTED) {
      expect(driftBullets(WEBKIT_HISTORICAL)).not.toContain(file);
    }
  });

  it('keeps the same-environment deterministic WebKit captures out of the drift list', () => {
    expect(WEBKIT_HISTORICAL).toContain('不在');
    expect(WEBKIT_HISTORICAL).toContain('确定性接缝');
    for (const file of DETERMINISTIC) {
      expect(WEBKIT_HISTORICAL).toContain(file);
      expect(driftBullets(WEBKIT_HISTORICAL)).not.toContain(file);
    }
    expect(WEBKIT_HISTORICAL).toContain('4173dce8');
    expect(WEBKIT_HISTORICAL).toContain('bf7548b7');
  });

  it('records the 2048 ready cross-run difference without fixing a sample hash', () => {
    expect(WEBKIT_HISTORICAL).toContain('after-2048-ready-webkit.png');
    expect(WEBKIT_HISTORICAL).toContain('同一捕获提交');
    expect(WEBKIT_HISTORICAL).toContain('4f488a3e');
    expect(WEBKIT_HISTORICAL).toContain('两次 sha256 不同');
    expect(WEBKIT_HISTORICAL).toContain('672285de');
    expect(WEBKIT_HISTORICAL).toContain('0ea38c8d');
    expect(WEBKIT_HISTORICAL).toContain('不能把单次采样的 0.22% 当作稳定结论');
    expect(driftBullets(WEBKIT_HISTORICAL)).toContain('after-2048-ready-webkit.png');
  });

  it('documents the local EGL requirement and the Playwright container recheck', () => {
    expect(WEBKIT_HISTORICAL).toContain('__EGL_VENDOR_LIBRARY_FILENAMES');
    expect(WEBKIT_HISTORICAL).toContain('EGL_PLATFORM=surfaceless');
    expect(WEBKIT_HISTORICAL).toContain('LIBGL_ALWAYS_SOFTWARE=1');
    expect(WEBKIT_HISTORICAL).toContain(CONTAINER_IMAGE);
    expect(WEBKIT_HISTORICAL).toContain('ready 0.0113%（113 px）');
    expect(WEBKIT_HISTORICAL).toContain('ready 还会出现 1.1264%（11270 px）');
    expect(WEBKIT_HISTORICAL).toContain('574 px');
    expect(WEBKIT_HISTORICAL).toContain('210 px');
    expect(WEBKIT_HISTORICAL).toContain('236 px');
    expect(WEBKIT_HISTORICAL).toContain('playing 0.06%');
    expect(WEBKIT_HISTORICAL).toContain('lost 0.02%');
    expect(WEBKIT_HISTORICAL).toContain('won 0.02%');
    expect(WEBKIT_HISTORICAL).toContain('10 / 14 / 12 / 12');
    expect(WEBKIT_HISTORICAL).toContain('两种结果互差 11157 px（每通道最大 1）');
    expect(WEBKIT_HISTORICAL).toContain('返工后');
    expect(WEBKIT_HISTORICAL).toContain('连续 3 跑（含全新容器首跑）');
    expect(WEBKIT_HISTORICAL).toContain('把上面的跨进程变体与待重绘帧都拦在落盘前');
    expect(WEBKIT_HISTORICAL).not.toContain('扫雷这 4 张在容器内两跑 sha256 相同');
    expect(WEBKIT_HISTORICAL).toContain('2048 ready 在同一容器两跑仍不同');
  });

  it('records the reviewed minesweeper scores capture in the fixed manifest', () => {
    expect(WEBKIT_HISTORICAL).toContain(MINESWEEPER_SCORES);
    expect(WEBKIT_HISTORICAL).toContain(MINESWEEPER_SCORES_SHA256);
    expect(WEBKIT_HISTORICAL).toContain(MINESWEEPER_SCORES_CAPTURE_COMMIT);
    expect(WEBKIT_HISTORICAL).toContain('连续两跑 sha256 相同');
    expect(WEBKIT_HISTORICAL).toContain('5687');
    expect(WEBKIT_HISTORICAL).toContain('0.2143%');
    expect(WEBKIT_HISTORICAL).toContain(
      'screenshots:minesweeper:scores:webkit',
    );
    expect(WEBKIT_HISTORICAL).toContain('#318 t2');
    expect(WEBKIT_HISTORICAL).not.toMatch(
      /本轮未复核[^。]*after-minesweeper-scores-webkit/,
    );

    const manifest = JSON.parse(
      readFileSync(
        join(ROOT, 'docs', 'screenshots', 'capture-sha256-manifest.json'),
        'utf8',
      ),
    ) as {
      captures: Array<{
        file: string;
        sha256: string;
        command: string;
        provenance: { captureCommit: string };
      }>;
    };
    const capture = manifest.captures.find(
      (entry) => entry.file === MINESWEEPER_SCORES,
    );
    expect(capture).toBeDefined();
    expect(capture?.sha256).toBe(MINESWEEPER_SCORES_SHA256);
    expect(capture?.command).toBe(
      'npm run screenshots:container -- screenshots:minesweeper:scores:webkit',
    );
    expect(capture?.provenance.captureCommit).toBe(
      MINESWEEPER_SCORES_CAPTURE_COMMIT,
    );
  });

  it('records the reviewed hub and snake captures in the fixed manifest', () => {
    expect(WEBKIT_HISTORICAL).toContain(HUB);
    expect(WEBKIT_HISTORICAL).toContain(HUB_SHA256);
    expect(WEBKIT_HISTORICAL).toContain(SNAKE);
    expect(WEBKIT_HISTORICAL).toContain(SNAKE_SHA256);
    expect(WEBKIT_HISTORICAL).toContain(HUB_SNAKE_CAPTURE_COMMIT);
    expect(WEBKIT_HISTORICAL).toContain('连续两跑 sha256 相同');
    expect(WEBKIT_HISTORICAL).toContain('#318 t3');
    expect(WEBKIT_HISTORICAL).toContain('740211');
    expect(WEBKIT_HISTORICAL).toContain('73.9841%');
    expect(WEBKIT_HISTORICAL).toContain('158');
    expect(WEBKIT_HISTORICAL).toContain('0.0158%');
    expect(WEBKIT_HISTORICAL).toContain('transition: none');
    expect(WEBKIT_HISTORICAL).toContain('getAnimations()');
    expect(WEBKIT_HISTORICAL).toContain('连续四跑');
    expect(WEBKIT_HISTORICAL).toContain('7092');
    expect(WEBKIT_HISTORICAL).toContain('0.7088%');
    expect(WEBKIT_HISTORICAL).toContain('8e9e845e');
    expect(WEBKIT_HISTORICAL).not.toMatch(
      /本轮未复核[^。]*after-(?:hub|snake)-webkit/,
    );

    const manifest = JSON.parse(
      readFileSync(
        join(ROOT, 'docs', 'screenshots', 'capture-sha256-manifest.json'),
        'utf8',
      ),
    ) as {
      captures: Array<{
        file: string;
        sha256: string;
        command: string;
        provenance: { captureCommit: string };
      }>;
    };
    const expected = [
      [HUB, HUB_SHA256, 'npm run screenshots:container -- screenshots:webkit'],
      [
        SNAKE,
        SNAKE_SHA256,
        'npm run screenshots:container -- screenshots:snake:webkit',
      ],
    ] as const;
    for (const [file, sha256, command] of expected) {
      const capture = manifest.captures.find((entry) => entry.file === file);
      expect(capture, `missing manifest entry for ${file}`).toBeDefined();
      expect(capture?.sha256).toBe(sha256);
      expect(capture?.command).toBe(command);
      expect(capture?.provenance.captureCommit).toBe(
        HUB_SNAKE_CAPTURE_COMMIT,
      );
    }
  });

  it('records the reviewed breakout ready / levelclear / gameover captures', () => {
    expect(WEBKIT_HISTORICAL).toContain('#318 t4');
    expect(WEBKIT_HISTORICAL).toContain('settleReadyBackdrop');
    expect(WEBKIT_HISTORICAL).toContain('首屏重绘接缝');
    expect(WEBKIT_HISTORICAL).toContain('d094461d');
    expect(WEBKIT_HISTORICAL).toContain('443830');
    expect(WEBKIT_HISTORICAL).toContain('44.3608%');
    expect(WEBKIT_HISTORICAL).toContain('1782');
    expect(WEBKIT_HISTORICAL).toContain('0.1781%');
    expect(WEBKIT_HISTORICAL).toContain('278');
    expect(WEBKIT_HISTORICAL).toContain('0.0278%');
    expect(WEBKIT_HISTORICAL).toContain('310');
    expect(WEBKIT_HISTORICAL).toContain('0.0310%');
    expect(WEBKIT_HISTORICAL).toContain('字节未变');
    // The three files must leave the #137 protected set once collected.
    expect(WEBKIT_HISTORICAL).not.toMatch(
      /本轮未复核[^。]*after-breakout-(?:ready|levelclear|gameover)-webkit/,
    );

    const manifest = JSON.parse(
      readFileSync(
        join(ROOT, 'docs', 'screenshots', 'capture-sha256-manifest.json'),
        'utf8',
      ),
    ) as {
      captures: Array<{
        file: string;
        sha256: string;
        command: string;
        provenance: { captureCommit: string };
      }>;
    };
    for (const file of BREAKOUT_COLLECTED) {
      const capture = manifest.captures.find((entry) => entry.file === file);
      expect(capture, `missing manifest entry for ${file}`).toBeDefined();
      expect(capture?.sha256).toBe(BREAKOUT_COLLECTED_SHA256.get(file));
      expect(capture?.command).toBe(
        'npm run screenshots:container -- screenshots:breakout:webkit',
      );
      expect(capture?.provenance.captureCommit).toBe(BREAKOUT_CAPTURE_COMMIT);
    }
  });

  it('records the reviewed minesweeper four-state captures in the fixed manifest', () => {
    expect(WEBKIT_HISTORICAL).toContain('#318 t1');
    expect(WEBKIT_HISTORICAL).toContain('一次性预热页');
    expect(WEBKIT_HISTORICAL).toContain('滚动往返');
    expect(WEBKIT_HISTORICAL).toContain('整幅连续两帧');
    expect(WEBKIT_HISTORICAL).toContain('c463b380');
    expect(WEBKIT_HISTORICAL).toContain('105 px');
    expect(WEBKIT_HISTORICAL).toContain('连续 3 跑');
    for (const file of MINESWEEPER_COLLECTED) {
      // Present in the section, but only in the collected prose/table, never in
      // the drift bullet itself.
      expect(WEBKIT_HISTORICAL).toContain(file);
      expect(driftBullets(WEBKIT_HISTORICAL)).not.toContain(file);
    }

    const manifest = JSON.parse(
      readFileSync(
        join(ROOT, 'docs', 'screenshots', 'capture-sha256-manifest.json'),
        'utf8',
      ),
    ) as {
      captures: Array<{
        file: string;
        sha256: string;
        command: string;
        provenance: { captureCommit: string };
      }>;
    };
    for (const file of MINESWEEPER_COLLECTED) {
      const capture = manifest.captures.find((entry) => entry.file === file);
      expect(capture, `missing manifest entry for ${file}`).toBeDefined();
      expect(capture?.sha256).toBe(MINESWEEPER_COLLECTED_SHA256.get(file));
      expect(capture?.command).toBe(
        'npm run screenshots:container -- screenshots:minesweeper:webkit',
      );
      expect(capture?.provenance.captureCommit).toBe(
        MINESWEEPER_CAPTURE_COMMIT,
      );
    }
  });

  it('makes the CI manifest, not sha256, the authoritative webkit-narrow check', () => {
    expect(WEBKIT_HISTORICAL).toContain('不是 sha256');
    expect(WEBKIT_HISTORICAL).toContain('ci-webkit-narrow-manifest.json');
    expect(WEBKIT_HISTORICAL).toContain('WebKit narrow screenshot smoke test');
    expect(WEBKIT_HISTORICAL).toContain('npm run verify:screenshots:webkit');
    expect(WEBKIT_HISTORICAL).toContain('内置的 23 个');
    expect(WEBKIT_HISTORICAL).toContain('不带 `--log` 时不校验');
    expect(WEBKIT_HISTORICAL).toContain('--log');
    expect(WEBKIT_HISTORICAL).toContain('engine=webkit');
    expect(WEBKIT_HISTORICAL).toContain('视口');
    expect(WEBKIT_HISTORICAL).toContain('不作为「重跑必须等于已提交 PNG」的验收基准');
  });

  it('points hash-level reproduction at the fixed-capture-environment follow-up #199', () => {
    expect(WEBKIT_HISTORICAL).toContain(ISSUE_199_URL);
    expect(WEBKIT_HISTORICAL).toContain('#199');
    expect(WEBKIT_HISTORICAL).toContain('固定捕获环境');
  });

  it('cross-references the WebKit subsection from the narrow matrix and shared historical section', () => {
    expect(WEBKIT_HISTORICAL_TITLE).toBeTruthy();
    expect(WEBKIT_NARROW).toContain('不是与已提交 PNG 的 sha256 比对');
    expect(WEBKIT_NARROW).toContain('ci-webkit-narrow-manifest.json');
    expect(WEBKIT_NARROW).toContain('按内置 23 个 WebKit 产物清单');
    expect(WEBKIT_NARROW).toContain('不校验日志中的');
    expect(WEBKIT_NARROW).toContain(WEBKIT_HISTORICAL_TITLE);
    expect(HISTORICAL).toContain(WEBKIT_HISTORICAL_TITLE);
    expect(HISTORICAL).toContain('#199');
  });

  it('keeps the webkit-phone and webkit-narrow tables and their commands intact', () => {
    for (const file of [
      ...BREAKOUT_COLLECTED,
      ...MINESWEEPER_COLLECTED,
      'after-2048-ready-webkit.png',
      ...DETERMINISTIC,
    ]) {
      const row = WEBKIT_PHONE.split('\n').find(
        (line) => line.startsWith('|') && line.includes(`\`${file}\``),
      );
      expect(row, `missing webkit-phone table row for ${file}`).toBeDefined();
    }
    for (const file of NARROW_DRIFT) {
      const row = WEBKIT_NARROW.split('\n').find(
        (line) => line.startsWith('|') && line.includes(`\`${file}\``),
      );
      expect(row, `missing webkit-narrow table row for ${file}`).toBeDefined();
    }
    // The manifest-recorded rows must advertise the container command; a host
    // command would be refused by the write-time guard.
    const containerCommands = new Map([
      ['after-blank-webkit.png', 'screenshots:container -- screenshots:webkit'],
      [HUB, 'screenshots:container -- screenshots:webkit'],
      [SNAKE, 'screenshots:container -- screenshots:snake:webkit'],
      ['after-2048-playing-webkit.png', 'screenshots:container -- screenshots:2048:webkit'],
      ['after-2048-gameover-webkit.png', 'screenshots:container -- screenshots:2048:webkit'],
      ['after-breakout-playing-webkit.png', 'screenshots:container -- screenshots:breakout:webkit'],
      ['after-breakout-ready-webkit.png', 'screenshots:container -- screenshots:breakout:webkit'],
      ['after-breakout-levelclear-webkit.png', 'screenshots:container -- screenshots:breakout:webkit'],
      ['after-breakout-gameover-webkit.png', 'screenshots:container -- screenshots:breakout:webkit'],
      [
        'after-minesweeper-ready-webkit.png',
        'screenshots:container -- screenshots:minesweeper:webkit',
      ],
      [
        'after-minesweeper-playing-webkit.png',
        'screenshots:container -- screenshots:minesweeper:webkit',
      ],
      [
        'after-minesweeper-lost-webkit.png',
        'screenshots:container -- screenshots:minesweeper:webkit',
      ],
      [
        'after-minesweeper-won-webkit.png',
        'screenshots:container -- screenshots:minesweeper:webkit',
      ],
      [
        MINESWEEPER_SCORES,
        'screenshots:container -- screenshots:minesweeper:scores:webkit',
      ],
    ]);
    for (const [file, command] of containerCommands) {
      const row = WEBKIT_PHONE.split('\n').find(
        (line) => line.startsWith('|') && line.includes(`\`${file}\``),
      );
      expect(row, `missing webkit-phone table row for ${file}`).toContain(
        `\`npm run ${command}\``,
      );
    }
    expect(WEBKIT_PHONE).toContain('会在写出这些文件前被写前护栏拒绝');
  });
});
