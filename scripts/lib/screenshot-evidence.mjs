/**
 * Shared protection for the historical After screenshots frozen by Issue #137.
 *
 * The t1–t3 documentation in docs/screenshots/README.md records the After
 * images that only represent their original capture revision: later UI changes
 * (the shared footer copy, the minesweeper sidebar, WebKit environment
 * differences) make a current-build re-run produce different bytes. Rewriting
 * those files silently would replace the historical baseline with today's UI.
 *
 * Every capture script calls {@link guardHistoricalAfterEvidence} from its
 * local `capture()` helper in After mode. The guard skips a protected file and
 * prints a warning unless the operator passes
 * `--allow-historical-overwrite`, which stays the explicit opt-in used by the
 * #45 scores precedent.
 *
 * The capture scripts that only refresh current evidence (2048 playing /
 * gameover, breakout playing, the dedicated minesweeper viewports and the
 * `after-minesweeper-webkit-narrow-*` CI smoke matrix) must stay out of this
 * list so their runs keep writing files.
 */

/** Explicit opt-in that lets an After capture replace a frozen file. */
export const HISTORICAL_OVERWRITE_FLAG = '--allow-historical-overwrite';

/**
 * Frozen historical After evidence from Issue #137's t1–t3 documentation.
 *
 * `issue` is the original issue that captured the file, `trackingIssue` is the
 * umbrella issue for the historical-evidence policy, `captureCommit` is the
 * last revision that produced the committed PNG and `note` explains why a
 * current-build re-run differs.
 *
 * @typedef {{
 *   file: string,
 *   game: '2048' | 'breakout' | 'snake' | 'minesweeper',
 *   issue: string,
 *   trackingIssue: string,
 *   captureCommit: string,
 *   note: string,
 * }} HistoricalAfterEvidence
 *
 * @type {readonly HistoricalAfterEvidence[]}
 */
export const HISTORICAL_AFTER_EVIDENCE = Object.freeze(
  [
    {
      file: 'after-2048-ready-desktop.png',
      game: '2048',
      issue: '#26',
      trackingIssue: '#137',
      captureCommit: '8ec4adc',
      note: '2048 ready 桌面整页图含旧页脚「四款游戏已上线」，当前构建重跑必然不同。',
    },
    {
      file: 'after-2048-ready-mobile.png',
      game: '2048',
      issue: '#26',
      trackingIssue: '#137',
      captureCommit: '8ec4adc',
      note: '2048 ready 手机图：#26 的历史产物，当前构建重跑有 15599 个像素不同（每通道最大 20，集中在棋盘面板边缘），重跑会静默覆盖历史产物。',
    },
    {
      file: 'after-breakout-ready-desktop.png',
      game: 'breakout',
      issue: '#29',
      trackingIssue: '#137',
      captureCommit: '26e84fa',
      note: '打砖块 ready 桌面整页图含旧页脚，当前构建重跑必然不同。',
    },
    {
      file: 'after-breakout-levelclear-desktop.png',
      game: 'breakout',
      issue: '#29',
      trackingIssue: '#137',
      captureCommit: '26e84fa',
      note: '打砖块 levelclear 桌面整页图含旧页脚，当前构建重跑必然不同。',
    },
    {
      file: 'after-breakout-gameover-desktop.png',
      game: 'breakout',
      issue: '#29',
      trackingIssue: '#137',
      captureCommit: '26e84fa',
      note: '打砖块 gameover 桌面整页图含旧页脚，当前构建重跑必然不同。',
    },
    {
      file: 'after-snake-ready.png',
      game: 'snake',
      issue: '#14',
      trackingIssue: '#137',
      captureCommit: '048fe5a',
      note: '贪食蛇桌面整页图除旧页脚外，画布区域还有每通道差 1 的像素（bbox 约 x 245–876、y 218–847）。',
    },
    {
      file: 'after-snake-gameover.png',
      game: 'snake',
      issue: '#14',
      trackingIssue: '#137',
      captureCommit: '048fe5a',
      note: '贪食蛇 gameover 桌面整页图除旧页脚外，画布区域还有每通道差 1 的像素（bbox 约 x 245–876、y 218–847）。',
    },
    {
      file: 'after-snake-mobile.png',
      game: 'snake',
      issue: '#14',
      trackingIssue: '#137',
      captureCommit: '048fe5a',
      note: '贪食蛇手机图不含页脚，重跑仍有约 54596 个像素每通道差 1。',
    },
    {
      file: 'after-breakout-ready-mobile.png',
      game: 'breakout',
      issue: '#29',
      trackingIssue: '#137',
      captureCommit: '26e84fa',
      note: '打砖块手机 ready 图的重跑差异覆盖游戏区约 y=472..1565，不是页脚。',
    },
    {
      file: 'after-breakout-gameover-mobile.png',
      game: 'breakout',
      issue: '#29',
      trackingIssue: '#137',
      captureCommit: '26e84fa',
      note: '打砖块手机 gameover 图的重跑差异覆盖游戏区约 y=472..1565，不是页脚。',
    },
    {
      file: 'after-minesweeper-ready-desktop.png',
      game: 'minesweeper',
      issue: '#61',
      trackingIssue: '#137',
      captureCommit: '993f5e7',
      note: '扫雷 ready 桌面整页图：#85 最高用时榜、#87「清空记录」等侧栏 UI 变更后未重拍，当前构建重跑整页尺寸与像素都不同。',
    },
    {
      file: 'after-minesweeper-playing-desktop.png',
      game: 'minesweeper',
      issue: '#61',
      trackingIssue: '#137',
      captureCommit: '993f5e7',
      note: '扫雷 playing 桌面整页图：#85、#87 侧栏 UI 变更后未重拍，当前构建重跑整页尺寸与像素都不同。',
    },
    {
      file: 'after-minesweeper-lost-desktop.png',
      game: 'minesweeper',
      issue: '#61',
      trackingIssue: '#137',
      captureCommit: '993f5e7',
      note: '扫雷 lost 桌面整页图：#85、#87 侧栏 UI 变更后未重拍，当前构建重跑整页尺寸与像素都不同。',
    },
    {
      file: 'after-minesweeper-won-desktop.png',
      game: 'minesweeper',
      issue: '#61',
      trackingIssue: '#137',
      captureCommit: '993f5e7',
      note: '扫雷 won 桌面整页图：#85、#87 侧栏 UI 变更后未重拍，当前构建重跑整页尺寸与像素都不同。',
    },
    {
      file: 'after-minesweeper-ready-mobile.png',
      game: 'minesweeper',
      issue: '#61',
      trackingIssue: '#137',
      captureCommit: '993f5e7',
      note: '扫雷 ready 手机图：#85、#87 侧栏 UI 变更后未重拍，当前构建重跑约 50.8 万像素不同。',
    },
    {
      file: 'after-minesweeper-playing-mobile.png',
      game: 'minesweeper',
      issue: '#61',
      trackingIssue: '#137',
      captureCommit: '993f5e7',
      note: '扫雷 playing 手机图：#85、#87 侧栏 UI 变更后未重拍，当前构建重跑约 50.9 万像素不同。',
    },
    {
      file: 'after-minesweeper-lost-mobile.png',
      game: 'minesweeper',
      issue: '#61',
      trackingIssue: '#137',
      captureCommit: '993f5e7',
      note: '扫雷 lost 手机图：#85、#87 侧栏 UI 变更后未重拍，当前构建重跑约 50.7 万像素不同。',
    },
    {
      file: 'after-minesweeper-won-mobile.png',
      game: 'minesweeper',
      issue: '#61',
      trackingIssue: '#137',
      captureCommit: '993f5e7',
      note: '扫雷 won 手机图：#85、#87 侧栏 UI 变更后未重拍，当前构建重跑约 56.1 万像素不同。',
    },
    {
      file: 'after-2048-ready-webkit.png',
      game: '2048',
      issue: '#120',
      trackingIssue: '#137',
      captureCommit: '498a14f',
      note: '2048 ready WebKit 手机图：同一捕获提交下两次 sha256 不同，跨环境重跑也无法等于已提交产物。',
    },
    {
      file: 'after-breakout-ready-webkit.png',
      game: 'breakout',
      issue: '#120',
      trackingIssue: '#137',
      captureCommit: '498a14f',
      note: '打砖块 ready WebKit 手机图（iPhone SE 3rd gen）：同一命令重跑后 sha256 与已提交产物不同。',
    },
    {
      file: 'after-breakout-levelclear-webkit.png',
      game: 'breakout',
      issue: '#120',
      trackingIssue: '#137',
      captureCommit: '498a14f',
      note: '打砖块 levelclear WebKit 手机图：同一命令重跑后 sha256 与已提交产物不同。',
    },
    {
      file: 'after-breakout-gameover-webkit.png',
      game: 'breakout',
      issue: '#120',
      trackingIssue: '#137',
      captureCommit: '498a14f',
      note: '打砖块 gameover WebKit 手机图：同一命令重跑后 sha256 与已提交产物不同。',
    },
    {
      file: 'after-minesweeper-ready-webkit.png',
      game: 'minesweeper',
      issue: '#120',
      trackingIssue: '#137',
      captureCommit: '498a14f',
      note: '扫雷 ready WebKit 手机图：重跑像素差集中在 HUD / 文字行，sha256 与已提交产物不同。',
    },
    {
      file: 'after-minesweeper-playing-webkit.png',
      game: 'minesweeper',
      issue: '#120',
      trackingIssue: '#137',
      captureCommit: '498a14f',
      note: '扫雷 playing WebKit 手机图：重跑像素差集中在 HUD / 文字行，sha256 与已提交产物不同。',
    },
    {
      file: 'after-minesweeper-lost-webkit.png',
      game: 'minesweeper',
      issue: '#120',
      trackingIssue: '#137',
      captureCommit: '498a14f',
      note: '扫雷 lost WebKit 手机图：重跑像素差集中在 HUD / 文字行，sha256 与已提交产物不同。',
    },
    {
      file: 'after-minesweeper-won-webkit.png',
      game: 'minesweeper',
      issue: '#120',
      trackingIssue: '#137',
      captureCommit: '498a14f',
      note: '扫雷 won WebKit 手机图：重跑像素差集中在 HUD / 文字行，sha256 与已提交产物不同。',
    },
  ].map((entry) => Object.freeze(entry)),
);

const EVIDENCE_BY_FILE = new Map(
  HISTORICAL_AFTER_EVIDENCE.map((entry) => [entry.file, entry]),
);

/**
 * Find the frozen evidence record for one screenshot file name.
 *
 * @param {string} file
 * @returns {HistoricalAfterEvidence | null}
 */
export function findHistoricalAfterEvidence(file) {
  return EVIDENCE_BY_FILE.get(file) ?? null;
}

/**
 * Decide whether one capture may write its PNG.
 *
 * The decision is pure: it never touches the filesystem. A protected file is
 * skipped only in After mode and only when the operator did not pass the
 * explicit overwrite flag; Before and dedicated narrow modes keep their
 * existing behaviour.
 *
 * @param {{ file: string, mode?: string, allowHistoricalOverwrite?: boolean }} options
 * @returns {{ action: 'write' | 'skip', file: string, entry: HistoricalAfterEvidence | null }}
 */
export function decideAfterCaptureWrite({
  file,
  mode = 'after',
  allowHistoricalOverwrite = false,
}) {
  const entry = findHistoricalAfterEvidence(file);
  if (entry === null || mode !== 'after' || allowHistoricalOverwrite) {
    return { action: 'write', file, entry };
  }
  return { action: 'skip', file, entry };
}

/**
 * Warn or allow one capture before it writes its PNG.
 *
 * Returns `true` when the caller should write the file. A skipped historical
 * capture warns with the tracking issue, file name and overwrite flag; an
 * explicit overwrite warns that the docs and capture commit must be updated in
 * the same change.
 *
 * @param {{
 *   file: string,
 *   mode?: string,
 *   allowHistoricalOverwrite?: boolean,
 *   log?: { warn: (message: string) => void },
 * }} options
 * @returns {boolean}
 */
export function guardHistoricalAfterEvidence({
  file,
  mode = 'after',
  allowHistoricalOverwrite = false,
  log = console,
}) {
  const decision = decideAfterCaptureWrite({ file, mode, allowHistoricalOverwrite });
  if (decision.action === 'write') {
    if (decision.entry !== null && mode === 'after' && allowHistoricalOverwrite) {
      log.warn(
        `Overwriting historical After evidence ${file} (${decision.entry.trackingIssue}, ` +
          `${decision.entry.game}, captured at ${decision.entry.captureCommit} for ${decision.entry.issue}) ` +
          `because ${HISTORICAL_OVERWRITE_FLAG} was passed. Update docs/screenshots/README.md and ` +
          `the documented capture commit in the same change.`,
      );
    }
    return true;
  }

  log.warn(
    `Refusing to overwrite historical After evidence ${file} (${decision.entry.trackingIssue}, ` +
      `${decision.entry.game}, captured at ${decision.entry.captureCommit} for ${decision.entry.issue}). ` +
      `${decision.entry.note} Re-run with ${HISTORICAL_OVERWRITE_FLAG} only when intentionally ` +
      `regenerating it, then update docs/screenshots/README.md and the documented capture commit.`,
  );
  return false;
}
