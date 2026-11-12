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
 * `--allow-historical-overwrite` inside the fixed capture container. The flag is
 * not enough on its own: the environment fingerprint written by the container
 * entry must identify the pinned image and EGL stack, so a host re-run cannot
 * silently replace historical evidence with a different rendering
 * environment.
 *
 * The capture scripts that only refresh current evidence (2048 playing /
 * gameover, breakout playing, the dedicated minesweeper viewports and the
 * `after-minesweeper-webkit-narrow-*` CI smoke matrix) must stay out of this
 * list so their runs keep writing files.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CAPTURE_CONTAINER_FLAG,
  CAPTURE_EGL_ENV,
  CAPTURE_EGL_VARS,
  CAPTURE_REPO_ROOT,
  PLAYWRIGHT_IMAGE_PIN,
  PLAYWRIGHT_IMAGE_REPOSITORY,
  captureEnvironmentFingerprint,
} from './capture-env.mjs';

/** Explicit opt-in that lets an After capture replace a frozen file. */
export const HISTORICAL_OVERWRITE_FLAG = '--allow-historical-overwrite';

/** Container entry that owns the fixed capture environment. */
export const HISTORICAL_OVERWRITE_CONTAINER_COMMAND = 'npm run screenshots:container';

/** sha256 manifest that must be updated together with a refreshed evidence PNG. */
export const HISTORICAL_SHA256_MANIFEST =
  'docs/screenshots/capture-sha256-manifest.json';

const HISTORICAL_SHA256_MANIFEST_PATH = resolve(
  CAPTURE_REPO_ROOT,
  HISTORICAL_SHA256_MANIFEST,
);

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
 * Explain why an environment fingerprint is not the fixed capture environment.
 *
 * Only the fields shared by every capture target are compared here: the
 * container marker, the pinned image tag / digest and the EGL variables. The
 * target and DPR vary per context and are logged by the capture runtime.
 *
 * @param {{
 *   source?: string,
 *   image?: { repository?: string, tag?: string, digest?: string } | null,
 *   env?: Record<string, string | null> | null,
 * }} fingerprint
 * @returns {string[]}
 */
function captureFingerprintProblems(fingerprint) {
  const problems = [];

  if (fingerprint.source !== 'container') {
    problems.push(
      `fingerprint source is "${String(fingerprint.source)}" (expected "container"; ` +
        `${CAPTURE_CONTAINER_FLAG}=1 must be injected by ${HISTORICAL_OVERWRITE_CONTAINER_COMMAND})`,
    );
  }

  const image = fingerprint.image ?? null;
  if (image === null) {
    problems.push('image fingerprint is unavailable');
  } else {
    if (image.repository !== PLAYWRIGHT_IMAGE_REPOSITORY) {
      problems.push(
        `image repository is "${String(image.repository)}" (expected "${PLAYWRIGHT_IMAGE_REPOSITORY}")`,
      );
    }
    if (image.tag !== PLAYWRIGHT_IMAGE_PIN.tag) {
      problems.push(
        `image tag is "${String(image.tag)}" (expected "${PLAYWRIGHT_IMAGE_PIN.tag}")`,
      );
    }
    if (image.digest !== PLAYWRIGHT_IMAGE_PIN.digest) {
      problems.push(
        `image digest is "${String(image.digest)}" (expected "${PLAYWRIGHT_IMAGE_PIN.digest}")`,
      );
    }
  }

  const environment = fingerprint.env ?? null;
  for (const name of CAPTURE_EGL_VARS) {
    const actual = environment === null ? null : (environment[name] ?? null);
    if (actual !== CAPTURE_EGL_ENV[name]) {
      problems.push(
        `${name} is ${actual === null ? 'missing' : `"${actual}"`} ` +
          `(expected "${CAPTURE_EGL_ENV[name]}")`,
      );
    }
  }

  return problems;
}

/**
 * Require the fixed capture environment before a historical After overwrite.
 *
 * The environment fingerprint comes from `captureEnvironmentFingerprint()` in
 * `capture-env.mjs`, the same contract the container entry validates. A host run
 * (or a container started with a different image / EGL stack) is rejected with
 * a readable error naming the file and the container command. Ordinary captures
 * never call this helper, so they keep working on the host.
 *
 * @param {{
 *   file: string,
 *   env?: Record<string, string | undefined>,
 *   fingerprint?: {
 *     source?: string,
 *     image?: { repository?: string, tag?: string, digest?: string } | null,
 *     env?: Record<string, string | null> | null,
 *   },
 * }} options
 * @returns {object} the accepted fingerprint
 */
export function assertHistoricalOverwriteEnvironment({
  file,
  env = process.env,
  fingerprint,
}) {
  let actual = fingerprint;
  let unavailable = null;
  if (actual === undefined || actual === null) {
    try {
      actual = captureEnvironmentFingerprint({ env });
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
    }
  }

  const problems =
    unavailable === null
      ? captureFingerprintProblems(actual)
      : [`environment fingerprint is unavailable: ${unavailable}`];

  if (problems.length > 0) {
    throw new Error(
      `Refusing to overwrite historical After evidence ${file}: ` +
        `${HISTORICAL_OVERWRITE_FLAG} only works inside the fixed capture container ` +
        `(${problems.join('; ')}). Re-capture through the container entry: ` +
        `${HISTORICAL_OVERWRITE_CONTAINER_COMMAND} -- <target> ${HISTORICAL_OVERWRITE_FLAG} ` +
        `(for example ${HISTORICAL_OVERWRITE_CONTAINER_COMMAND} -- screenshots:2048 ${HISTORICAL_OVERWRITE_FLAG}).`,
    );
  }

  return actual;
}

/** The capture file names recorded in a parsed sha256 manifest. */
function manifestCaptureFiles(manifest) {
  const captures = Array.isArray(manifest) ? manifest : manifest?.captures;
  if (!Array.isArray(captures)) {
    return new Set();
  }
  return new Set(
    captures
      .map((capture) => (typeof capture === 'string' ? capture : capture?.file))
      .filter((file) => typeof file === 'string' && file !== ''),
  );
}

/**
 * Read the optional sha256 manifest so the checklist can mention it only when
 * the refreshed PNG is actually tracked there. A missing or malformed manifest
 * never blocks the overwrite: the fixed-environment check and the committed PNG
 * evidence are independent.
 */
function readManifestCaptureFiles({
  manifest,
  manifestPath = HISTORICAL_SHA256_MANIFEST_PATH,
  readFile = readFileSync,
} = {}) {
  if (manifest !== undefined && manifest !== null) {
    return manifestCaptureFiles(manifest);
  }
  try {
    return manifestCaptureFiles(JSON.parse(readFile(manifestPath, 'utf8')));
  } catch {
    return new Set();
  }
}

/** Build the checklist every accepted overwrite must print. */
function historicalOverwriteChecklist(entry, manifestFiles) {
  const lines = [
    `Overwriting historical After evidence ${entry.file} (${entry.trackingIssue}, ` +
      `${entry.game}, captured at ${entry.captureCommit} for ${entry.issue}) inside the ` +
      `fixed capture container because ${HISTORICAL_OVERWRITE_FLAG} was passed.`,
    'Update all of the following in the same change:',
    `- screenshot: docs/screenshots/${entry.file}`,
    `- docs/screenshots/README.md: update the recorded capture commit ` +
      `(currently ${entry.captureCommit}) and the size / description`,
  ];
  if (manifestFiles.has(entry.file)) {
    lines.push(
      `- ${HISTORICAL_SHA256_MANIFEST}: update the sha256, provenance and ` +
        `environment fingerprint entry for ${entry.file}`,
    );
  }
  return lines.join('\n');
}

/**
 * Decide whether one capture may write its PNG.
 *
 * The decision is pure: it never touches the filesystem. A protected file is
 * skipped only in After mode and only when the operator did not pass the
 * explicit overwrite flag; Before and dedicated narrow modes keep their
 * existing behaviour. The guard layers the fixed-environment validation on top
 * of this pure decision.
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
 * Validate, warn or allow one capture before it writes its PNG.
 *
 * Returns `true` when the caller should write the file. A skipped historical
 * capture warns with the tracking issue, file name and overwrite flag. A
 * requested overwrite first checks the fixed capture environment fingerprint
 * (throwing a readable error outside the container) and then prints the
 * checklist for the docs capture commit and the optional sha256 manifest.
 *
 * @param {{
 *   file: string,
 *   mode?: string,
 *   allowHistoricalOverwrite?: boolean,
 *   env?: Record<string, string | undefined>,
 *   fingerprint?: object,
 *   manifest?: unknown,
 *   manifestPath?: string,
 *   readFile?: (path: string, encoding: 'utf8') => string,
 *   log?: { warn: (message: string) => void },
 * }} options
 * @returns {boolean}
 */
export function guardHistoricalAfterEvidence({
  file,
  mode = 'after',
  allowHistoricalOverwrite = false,
  env = process.env,
  fingerprint,
  manifest,
  manifestPath,
  readFile,
  log = console,
}) {
  const decision = decideAfterCaptureWrite({ file, mode, allowHistoricalOverwrite });
  const overwriteRequested =
    decision.entry !== null && mode === 'after' && allowHistoricalOverwrite;

  if (decision.action === 'write') {
    if (overwriteRequested) {
      assertHistoricalOverwriteEnvironment({ file, env, fingerprint });
      const manifestFiles = readManifestCaptureFiles({
        manifest,
        manifestPath,
        readFile,
      });
      log.warn(historicalOverwriteChecklist(decision.entry, manifestFiles));
    }
    return true;
  }

  log.warn(
    `Refusing to overwrite historical After evidence ${file} (${decision.entry.trackingIssue}, ` +
      `${decision.entry.game}, captured at ${decision.entry.captureCommit} for ${decision.entry.issue}). ` +
      `${decision.entry.note} Re-run inside the fixed capture container only when intentionally ` +
      `regenerating it: ${HISTORICAL_OVERWRITE_CONTAINER_COMMAND} -- <target> ` +
      `${HISTORICAL_OVERWRITE_FLAG}, then update docs/screenshots/README.md, the documented ` +
      `capture commit and (when listed) ${HISTORICAL_SHA256_MANIFEST}.`,
  );
  return false;
}
