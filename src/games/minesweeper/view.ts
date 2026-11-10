import { query, setText } from '../../core/dom';
import type { GameHandle, GameServices } from '../../core/game';
import { resolveDebugSeed } from './debug';
import {
  DIFFICULTY_PRESETS,
  findDifficultyForConfig,
  parseCustomDifficulty,
} from './difficulty';
import {
  createSeededRng,
  DEFAULT_MINESWEEPER_CONFIG,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  MinesweeperEngine,
  validateConfig,
  type Cell,
  type MinesweeperCell,
  type MinesweeperConfig,
  type MinesweeperOptions,
  type MinesweeperSnapshot,
  type MinesweeperStatus,
} from './engine';
import { bucketForConfig, createMinesweeperScores } from './scores';
import './minesweeper.css';

const CLOCK_INTERVAL_MS = 250;
/** The only board width whose narrow-screen cells keep the ≥36px promise. */
const TOUCH_TARGET_GUARANTEED_COLS = 9;
/** Hold this long on a touchscreen to toggle a flag instead of revealing. */
const LONG_PRESS_MS = 500;
/** Moving further than this while holding cancels the long press (e.g. scroll). */
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

const STATUS_LABELS: Readonly<Record<MinesweeperStatus, string>> = {
  ready: '待开始',
  playing: '进行中',
  won: '胜利',
  lost: '踩雷结束',
};

/**
 * Render the three preset buttons with the active one pressed. The labels and
 * boards come from the difficulty module so the selector cannot drift from the
 * presets the parser and the engine validate against.
 */
function difficultyPresetButtonsHtml(config: Readonly<MinesweeperConfig>): string {
  const active = findDifficultyForConfig(config);
  return DIFFICULTY_PRESETS.map(
    (preset) => `<button class="button button--ghost minesweeper-preset" type="button"
      data-difficulty="${preset.id}" data-testid="difficulty-${preset.id}"
      aria-pressed="${String(preset.id === active)}">${preset.label}</button>`,
  ).join('');
}

/**
 * Render the three preset score rows from the same list the selector and the
 * score store use, so ids, labels and order cannot drift.
 */
function scorePresetRowsHtml(): string {
  return DIFFICULTY_PRESETS.map(
    (preset) => `<div class="minesweeper-score" data-score-bucket="${preset.id}">
              <dt>${preset.label}</dt>
              <dd data-testid="score-${preset.id}-time">—</dd>
            </div>`,
  ).join('');
}

/** Render the shell for one board configuration; the board itself is rebuilt later. */
function viewHtml(config: Readonly<MinesweeperConfig>): string {
  return `
  <section class="minesweeper-game" data-testid="minesweeper-game" data-status="ready">
    <div class="game-heading">
      <a class="back-link" href="#/">
        <span aria-hidden="true">←</span> 返回大厅
      </a>
      <div class="game-heading-copy">
        <p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> DOM · 益智 · 经典</p>
        <h1>扫雷 <span>Minesweeper</span></h1>
      </div>
      <dl class="minesweeper-hud" aria-label="游戏数据">
        <div class="minesweeper-stat">
          <dt>剩余雷数</dt>
          <dd data-testid="remaining-mines">${config.mines}</dd>
        </div>
        <div class="minesweeper-stat">
          <dt>用时</dt>
          <dd data-testid="timer">0:00</dd>
        </div>
        <div class="minesweeper-stat">
          <dt>状态</dt>
          <dd data-testid="status">待开始</dd>
        </div>
      </dl>
    </div>

    <div class="minesweeper-layout">
      <div class="minesweeper-main">
        <div class="minesweeper-stage" data-testid="minesweeper-stage">
          <div class="minesweeper-board" data-testid="minesweeper-board" role="group"
            aria-label="${config.rows} × ${config.cols} 扫雷棋盘"></div>
          <div class="minesweeper-overlay" data-testid="overlay" role="group"
            aria-labelledby="minesweeper-overlay-title" hidden>
            <div class="minesweeper-overlay-card">
              <p class="panel-kicker" data-testid="overlay-kicker">RESULT</p>
              <h2 id="minesweeper-overlay-title" data-testid="overlay-title">棋局结束</h2>
              <p class="minesweeper-overlay-body" data-testid="overlay-body">点击「再来一局」重新开始。</p>
              <button class="button button--primary" type="button" data-action="restart"
                data-testid="overlay-primary">再来一局</button>
            </div>
          </div>
        </div>
        <p class="minesweeper-board-size-warning" data-testid="board-size-warning"
          role="status">
          大棋盘在窄屏下按比例缩小，≥36px 的触控目标只对 9×9 保证；建议横屏或改用更小的棋盘。
        </p>
        <p class="minesweeper-hint minesweeper-pointer-hint">
          左键翻开格子，右键插旗标记地雷。第一次翻开总是安全的，雷区在第一次翻开后生成。
        </p>
        <p class="minesweeper-touch-hint" data-testid="touch-hint">
          轻点翻开格子，长按约 0.5 秒插旗 / 取消旗。长按期间移动或滚动会取消，不会误触。
        </p>
        <div class="minesweeper-touch-actions">
          <button class="button button--ghost" type="button" data-action="restart"
            data-testid="mobile-restart-button">重开</button>
        </div>
      </div>

      <aside class="minesweeper-panel" aria-label="操作与状态">
        <div class="panel-card">
          <p class="panel-kicker">CONTROLS</p>
          <h2>操作</h2>
          <dl class="control-list">
            <div>
              <dt><span class="pointer-glyph" aria-hidden="true"></span> 左键</dt>
              <dd>翻开格子</dd>
            </div>
            <div><dt>右键</dt><dd>插旗 / 取消旗</dd></div>
            <div><dt>触屏</dt><dd>轻点翻开 / 长按插旗</dd></div>
            <div><dt>按钮</dt><dd>重开 / 返回大厅</dd></div>
          </dl>
        </div>

        <div class="panel-card">
          <p class="panel-kicker">STATUS</p>
          <h2>本局</h2>
          <p class="minesweeper-summary"><span>已插旗</span><strong data-testid="flag-count">0</strong></p>
          <p class="minesweeper-summary"><span>棋盘</span><strong data-testid="board-summary">${config.rows} × ${config.cols} · ${config.mines} 雷</strong></p>
          <div class="panel-actions">
            <button class="button button--ghost" type="button" data-action="restart"
              data-testid="restart-button">重开</button>
          </div>
        </div>

        <div class="panel-card minesweeper-difficulty" aria-labelledby="minesweeper-difficulty-title">
          <p class="panel-kicker">DIFFICULTY</p>
          <h2 id="minesweeper-difficulty-title">难度</h2>
          <div class="minesweeper-presets" role="group" aria-label="预设难度"
            data-testid="difficulty-presets">
            ${difficultyPresetButtonsHtml(config)}
          </div>
          <form class="minesweeper-custom" data-testid="custom-difficulty-form"
            aria-describedby="minesweeper-difficulty-error" novalidate>
            <div class="minesweeper-custom-fields">
              <div class="minesweeper-field">
                <label for="minesweeper-custom-rows">行数</label>
                <input id="minesweeper-custom-rows" type="number" inputmode="numeric"
                  min="${MIN_ROWS}" max="${MAX_ROWS}" step="1" name="rows"
                  value="${config.rows}" data-testid="custom-rows">
              </div>
              <div class="minesweeper-field">
                <label for="minesweeper-custom-cols">列数</label>
                <input id="minesweeper-custom-cols" type="number" inputmode="numeric"
                  min="${MIN_COLS}" max="${MAX_COLS}" step="1" name="cols"
                  value="${config.cols}" data-testid="custom-cols">
              </div>
              <div class="minesweeper-field">
                <label for="minesweeper-custom-mines">雷数</label>
                <input id="minesweeper-custom-mines" type="number" inputmode="numeric"
                  min="1" step="1" name="mines"
                  value="${config.mines}" data-testid="custom-mines">
              </div>
            </div>
            <button class="button button--primary minesweeper-custom-submit" type="submit"
              data-testid="custom-difficulty-submit">开始自定义</button>
            <p class="minesweeper-error" id="minesweeper-difficulty-error" role="alert"
              data-testid="difficulty-error" hidden></p>
          </form>
        </div>

        <div class="panel-card minesweeper-scores" data-testid="scores-panel"
          aria-labelledby="minesweeper-scores-title">
          <p class="panel-kicker">BEST TIMES</p>
          <h2 id="minesweeper-scores-title">最高用时</h2>
          <p class="minesweeper-scores-empty" data-testid="scores-empty">还没有记录</p>
          <dl class="minesweeper-scores-list" data-testid="scores-presets" hidden>
            ${scorePresetRowsHtml()}
          </dl>
          <div class="minesweeper-scores-custom" data-testid="scores-custom" hidden>
            <dl class="minesweeper-scores-list" data-testid="scores-custom-list"></dl>
          </div>
          <div class="panel-actions minesweeper-scores-actions">
            <button class="button button--ghost" type="button"
              data-action="clear-scores" data-testid="clear-scores-button"
              aria-label="清空记录">清空记录</button>
          </div>
        </div>

        <p class="minesweeper-hint">全部安全格翻开即获胜；插旗数量可以超过雷数，剩余雷数会随之变为负数。</p>
        <p class="sr-only" data-testid="announcer" aria-live="polite"></p>
      </aside>
    </div>
  </section>
`;
}

/** Build the row-major button grid for one board configuration. */
function boardHtml(config: Readonly<MinesweeperConfig>): string {
  return Array.from({ length: config.rows }, (_, row) => {
    const cells = Array.from({ length: config.cols }, (_, col) => {
      const testId = `cell-${row}-${col}`;
      return `<button class="minesweeper-cell" type="button"
        data-cell data-row="${row}" data-col="${col}" data-state="hidden"
        data-testid="${testId}" aria-label="第 ${row + 1} 行第 ${col + 1} 列，未翻开"></button>`;
    }).join('');
    return `<div class="minesweeper-row">${cells}</div>`;
  }).join('');
}

/** Collect the buttons of a freshly rendered board in row-major order. */
function cellButtonsFor(
  board: HTMLElement,
  config: Readonly<MinesweeperConfig>,
): HTMLButtonElement[][] {
  return Array.from({ length: config.rows }, (_, row) =>
    Array.from({ length: config.cols }, (_, col) =>
      query<HTMLButtonElement>(board, `[data-testid="cell-${row}-${col}"]`),
    ),
  );
}

interface MinesweeperDebugApi {
  gameId: 'minesweeper';
  getState: () => MinesweeperSnapshot;
  /** Test seam: rebuild the mount with another board configuration. */
  setConfig: (config: MinesweeperConfig) => void;
  /** Test seam: destroy the mount without waiting for a route change. */
  destroy: () => void;
}

/**
 * The snake, tetris, 2048 and breakout views also use `window.__playground`,
 * so one local cast avoids a conflicting global declaration.
 */
interface MinesweeperDebugWindow {
  __playground?: MinesweeperDebugApi;
}

function debugWindow(): MinesweeperDebugWindow {
  return window as unknown as MinesweeperDebugWindow;
}

function abortError(): DOMException {
  return new DOMException('Game mount aborted', 'AbortError');
}

/** Test seam, enabled on the dev server or with `?debug=1` in a build. */
function debugEnabled(): boolean {
  if (import.meta.env.DEV) {
    return true;
  }
  const query = window.location.hash.split('?')[1];
  return query ? new URLSearchParams(query).has('debug') : false;
}

/** Query string after the hash route, e.g. `#/games/minesweeper?debug=1&mines=...`. */
function debugParams(): URLSearchParams {
  const hash = window.location.hash;
  const queryIndex = hash.indexOf('?');
  return new URLSearchParams(
    queryIndex >= 0 ? hash.slice(queryIndex + 1) : window.location.search,
  );
}

/** Read one integer debug parameter, or null when the supplied token is invalid. */
function parseDebugInteger(raw: string | null, fallback: number): number | null {
  if (raw === null) {
    return fallback;
  }
  const token = raw.trim();
  if (!/^\d+$/.test(token)) {
    return null;
  }
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : null;
}

/** Read the optional safe-first flag (`1`/`true` or `0`/`false`). */
function parseDebugSafeFirst(raw: string | null): boolean | null {
  if (raw === null) {
    return true;
  }
  const token = raw.trim().toLowerCase();
  if (token === '1' || token === 'true') {
    return true;
  }
  if (token === '0' || token === 'false') {
    return false;
  }
  return null;
}

/**
 * Resolve the board configuration from the debug query string. An invalid
 * value or an invalid combination falls back to the classic beginner board
 * instead of throwing while the view mounts.
 */
function resolveDebugConfig(): Readonly<MinesweeperConfig> {
  const params = debugParams();
  const rows = parseDebugInteger(params.get('rows'), DEFAULT_MINESWEEPER_CONFIG.rows);
  const cols = parseDebugInteger(params.get('cols'), DEFAULT_MINESWEEPER_CONFIG.cols);
  const mines = parseDebugInteger(
    params.get('mineCount'),
    DEFAULT_MINESWEEPER_CONFIG.mines,
  );
  const firstClickSafe = parseDebugSafeFirst(params.get('safeFirst'));
  if (rows === null || cols === null || mines === null || firstClickSafe === null) {
    return DEFAULT_MINESWEEPER_CONFIG;
  }
  try {
    return validateConfig({ rows, cols, mines, firstClickSafe });
  } catch {
    return DEFAULT_MINESWEEPER_CONFIG;
  }
}

/**
 * Parse a fixed mine layout, e.g. `mines=0,0;0,1;...`, against the current
 * board. Invalid or incomplete layouts are ignored instead of surfacing a
 * debug-only crash to the player.
 */
function parseDebugMines(
  raw: string | null,
  config: Readonly<MinesweeperConfig>,
): readonly Cell[] | undefined {
  if (!raw) {
    return undefined;
  }
  const cells: Cell[] = [];
  const seen = new Set<number>();
  for (const part of raw.split(';')) {
    if (part === '') {
      continue;
    }
    const [rowText, colText, extra] = part.split(',');
    if (rowText === undefined || colText === undefined || extra !== undefined) {
      return undefined;
    }
    // `Number('')` is 0, so require a non-empty integer token; otherwise a
    // malformed layout would silently become a valid row-0 board.
    const rowToken = rowText.trim();
    const colToken = colText.trim();
    if (!/^\d+$/.test(rowToken) || !/^\d+$/.test(colToken)) {
      return undefined;
    }
    const row = Number(rowToken);
    const col = Number(colToken);
    if (row >= config.rows || col >= config.cols) {
      return undefined;
    }
    const index = row * config.cols + col;
    if (seen.has(index)) {
      return undefined;
    }
    seen.add(index);
    cells.push({ row, col });
  }
  return cells.length === config.mines ? cells : undefined;
}

/**
 * Deterministic options for e2e runs, including a stable PRNG fallback.
 * A missing or invalid `seed` uses 1; only an explicit finite value (such as
 * `seed=0`) overrides it.
 */
function engineSeamOptions(
  config: Readonly<MinesweeperConfig>,
): Pick<MinesweeperOptions, 'initialMines' | 'rng'> {
  if (!debugEnabled()) {
    return {};
  }
  const params = debugParams();
  return {
    rng: createSeededRng(resolveDebugSeed(params.get('seed'))),
    initialMines: parseDebugMines(params.get('mines'), config),
  };
}

function formatTime(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

type CellVisual = 'hidden' | 'flagged' | 'revealed' | 'mine' | 'exploded';

function cellVisual(cell: MinesweeperCell, status: MinesweeperStatus): CellVisual {
  if (status === 'lost' && cell.mine) {
    if (cell.revealed) {
      return 'exploded';
    }
    // Keep a correct flag visible after the loss; only unflagged mines are
    // exposed so the board still agrees with the HUD flag count.
    return cell.flagged ? 'flagged' : 'mine';
  }
  if (cell.revealed) {
    return 'revealed';
  }
  return cell.flagged ? 'flagged' : 'hidden';
}

function cellLabel(cell: MinesweeperCell, status: MinesweeperStatus): string {
  const position = `第 ${cell.row + 1} 行第 ${cell.col + 1} 列`;
  const visual = cellVisual(cell, status);
  switch (visual) {
    case 'flagged':
      return `${position}，已插旗`;
    case 'revealed':
      return cell.adjacentMines === 0
        ? `${position}，已翻开，周围没有地雷`
        : `${position}，已翻开，周围 ${cell.adjacentMines} 颗雷`;
    case 'mine':
    case 'exploded':
      return `${position}，地雷`;
    case 'hidden':
      return `${position}，未翻开`;
  }
}

function cellContent(cell: MinesweeperCell, visual: CellVisual): string {
  switch (visual) {
    case 'flagged':
      return '⚑';
    case 'mine':
    case 'exploded':
      return '✹';
    case 'revealed':
      return cell.adjacentMines === 0 ? '' : String(cell.adjacentMines);
    case 'hidden':
      return '';
  }
}

export async function mountMinesweeper(
  root: HTMLElement,
  services: GameServices,
  mountSignal: AbortSignal,
): Promise<GameHandle> {
  if (mountSignal.aborted) {
    throw abortError();
  }
  const initialConfig = debugEnabled()
    ? resolveDebugConfig()
    : DEFAULT_MINESWEEPER_CONFIG;
  root.innerHTML = viewHtml(initialConfig);

  const gameRoot = query<HTMLElement>(root, '[data-testid="minesweeper-game"]');
  const stageElement = query<HTMLElement>(root, '[data-testid="minesweeper-stage"]');
  const boardElement = query<HTMLElement>(root, '[data-testid="minesweeper-board"]');
  const overlay = query<HTMLElement>(root, '[data-testid="overlay"]');
  const overlayKicker = query<HTMLElement>(root, '[data-testid="overlay-kicker"]');
  const overlayTitle = query<HTMLElement>(root, '[data-testid="overlay-title"]');
  const overlayBody = query<HTMLElement>(root, '[data-testid="overlay-body"]');
  const primaryButton = query<HTMLButtonElement>(root, '[data-testid="overlay-primary"]');
  const restartButton = query<HTMLButtonElement>(root, '[data-testid="restart-button"]');
  const mobileRestartButton = query<HTMLButtonElement>(
    root,
    '[data-testid="mobile-restart-button"]',
  );
  const remainingElement = query<HTMLElement>(root, '[data-testid="remaining-mines"]');
  const flagCountElement = query<HTMLElement>(root, '[data-testid="flag-count"]');
  const timerElement = query<HTMLElement>(root, '[data-testid="timer"]');
  const statusElement = query<HTMLElement>(root, '[data-testid="status"]');
  const boardSummary = query<HTMLElement>(root, '[data-testid="board-summary"]');
  const announcer = query<HTMLElement>(root, '[data-testid="announcer"]');
  const presetButtons = Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-difficulty]'),
  );
  const customForm = query<HTMLFormElement>(root, '[data-testid="custom-difficulty-form"]');
  const rowsInput = query<HTMLInputElement>(root, '[data-testid="custom-rows"]');
  const colsInput = query<HTMLInputElement>(root, '[data-testid="custom-cols"]');
  const minesInput = query<HTMLInputElement>(root, '[data-testid="custom-mines"]');
  const customSubmit = query<HTMLButtonElement>(
    root,
    '[data-testid="custom-difficulty-submit"]',
  );
  const difficultyError = query<HTMLElement>(root, '[data-testid="difficulty-error"]');
  const scoresEmpty = query<HTMLElement>(root, '[data-testid="scores-empty"]');
  const scoresPresets = query<HTMLElement>(root, '[data-testid="scores-presets"]');
  const scoresCustom = query<HTMLElement>(root, '[data-testid="scores-custom"]');
  const scoresCustomList = query<HTMLElement>(root, '[data-testid="scores-custom-list"]');
  const clearScoresButton = query<HTMLButtonElement>(
    root,
    '[data-testid="clear-scores-button"]',
  );
  const presetScoreElements = DIFFICULTY_PRESETS.map((preset) => ({
    preset,
    element: query<HTMLElement>(root, `[data-testid="score-${preset.id}-time"]`),
  }));
  const scores = createMinesweeperScores(services.storage);

  const controller = new AbortController();
  const listenerSignal = controller.signal;
  const onMountAbort = (): void => controller.abort();
  mountSignal.addEventListener('abort', onMountAbort, { once: true });

  let clock: number | null = null;
  let lastTickAt = 0;
  let lastStatus: MinesweeperStatus = 'ready';
  let currentConfig: Readonly<MinesweeperConfig> = DEFAULT_MINESWEEPER_CONFIG;
  let engine: MinesweeperEngine;
  let cellButtons: HTMLButtonElement[][] = [];

  interface TouchGesture {
    readonly pointerId: number;
    readonly row: number;
    readonly col: number;
    readonly startX: number;
    readonly startY: number;
    timer: number | null;
    longPressed: boolean;
  }

  let touchGesture: TouchGesture | null = null;
  // Release clicks that must not also reveal a cell: the long press already
  // toggled a flag, or the finger moved / the page scrolled. This is
  // gesture-level state, not a timer: the release click arrives when the finger
  // lifts, which may be long after the 500 ms long-press timer (for example a
  // second hold that clears a flag). A real touch release click cannot be
  // matched back by pointer id: WebKit reports the pointerdown as pointerType
  // "touch" / pointerId 2, then the click as a mouse-mediated PointerEvent with
  // pointerType "mouse" / pointerId 1. Remember the gesture's target cell
  // instead and swallow the first detail > 0 click on that cell. The pointer id
  // is bookkeeping only: it lets a cancelled pointer drop its own token and
  // lets a second finger start its own gesture without clearing the first
  // finger's suppression. A rebuild replaces the board DOM and can change the
  // rows / columns, so that path stores `null` ("detached"): the token no
  // longer names a cell and swallows the next detail > 0 click wherever it
  // lands once its finger has lifted. Tokens survive restart / rebuild, a
  // pointerdown with no active gesture drops the ones whose gesture is over,
  // and destroy clears them. Keyboard activation (detail 0) never consumes one.
  const suppressedClicks = new Map<number, { row: number; col: number } | null>();
  // Touch pointers that are still physically down on the board. A detached
  // token outlives cancelTouchGesture(), so `touchGesture === null` no longer
  // means no finger is down: while the detached pointer is still down, a click
  // belongs to another finger and must reveal normally instead of consuming the
  // token. The token is consumed by the released finger's own click.
  const activeTouchPointers = new Set<number>();

  function clearGestureTimer(gesture: TouchGesture): void {
    if (gesture.timer !== null) {
      window.clearTimeout(gesture.timer);
      gesture.timer = null;
    }
  }

  function suppressNextClick(pointerId: number, row: number, col: number): void {
    suppressedClicks.set(pointerId, { row, col });
  }

  function endTouchGesture(suppressClick: boolean, detachTarget = false): void {
    if (!touchGesture) {
      return;
    }
    clearGestureTimer(touchGesture);
    if (suppressClick) {
      // Keep this finger's release click from revealing the cell, even if a
      // second finger starts its own gesture in the meantime. A rebuild can
      // change the rows / columns (and therefore the cell under the finger),
      // so that path detaches the token from any target.
      suppressedClicks.set(
        touchGesture.pointerId,
        detachTarget ? null : { row: touchGesture.row, col: touchGesture.col },
      );
    }
    touchGesture = null;
  }

  function cancelTouchGesture(detachTarget = false): void {
    endTouchGesture(true, detachTarget);
  }

  function stopClock(): void {
    if (clock === null) {
      return;
    }
    window.clearInterval(clock);
    clock = null;
  }

  function startClock(): void {
    if (clock !== null) {
      return;
    }
    lastTickAt = performance.now();
    clock = window.setInterval(() => {
      const now = performance.now();
      const delta = now - lastTickAt;
      lastTickAt = now;
      engine.tick(delta);
      setText(timerElement, formatTime(engine.elapsedMs));
    }, CLOCK_INTERVAL_MS);
  }

  function showDifficultyError(message: string): void {
    // Unhide the live region before filling it so assistive technology sees the
    // alert appear with its text, rather than a text update on a hidden node.
    difficultyError.hidden = false;
    setText(difficultyError, message);
  }

  function hideDifficultyError(): void {
    setText(difficultyError, '');
    difficultyError.hidden = true;
  }

  /**
   * Mark the preset matching `currentConfig` as pressed (or none for a custom
   * board) and keep the custom fields showing the active rows, columns and
   * mines. A custom board equal to a preset therefore lights that preset up.
   */
  function syncDifficultyControls(): void {
    const active = findDifficultyForConfig(currentConfig);
    for (const button of presetButtons) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.difficulty === active),
      );
    }
    rowsInput.value = String(currentConfig.rows);
    colsInput.value = String(currentConfig.cols);
    minesInput.value = String(currentConfig.mines);
  }

  /**
   * Re-render the best-time panel from storage.
   *
   * Presets keep their fixed order (initial difficulty, then intermediate and
   * expert) and show a dash when only other buckets have records; custom boards
   * are one row each and only appear once they have a record. An empty table
   * shows the empty-state copy instead of three dash rows. Restarting or
   * switching difficulty only re-reads the table, so the board cannot be lost.
   */
  function renderScores(): void {
    const entries = scores.list();
    const presetIds: ReadonlySet<string> = new Set(
      DIFFICULTY_PRESETS.map((preset) => preset.id),
    );
    const bestByBucket = new Map(
      entries.map((entry) => [entry.bucket.id, entry.elapsedMs] as const),
    );

    scoresEmpty.hidden = entries.length > 0;
    scoresPresets.hidden = entries.length === 0;
    for (const { preset, element } of presetScoreElements) {
      const elapsedMs = bestByBucket.get(preset.id);
      setText(element, elapsedMs === undefined ? '—' : formatTime(elapsedMs));
    }

    const customEntries = entries.filter(
      (entry) => !presetIds.has(entry.bucket.id),
    );
    scoresCustom.hidden = customEntries.length === 0;
    scoresCustomList.replaceChildren(
      ...customEntries.map((entry) => {
        const row = document.createElement('div');
        row.className = 'minesweeper-score';
        row.dataset.scoreBucket = entry.bucket.id;
        const label = document.createElement('dt');
        label.textContent = entry.bucket.label;
        const time = document.createElement('dd');
        time.textContent = formatTime(entry.elapsedMs);
        row.append(label, time);
        return row;
      }),
    );
    // The button stays in the DOM on an empty table so the card does not shift
    // when the last record appears or disappears.
    clearScoresButton.disabled = entries.length === 0;
  }

  /** Clear the local best-time table and show the empty state immediately. */
  function clearScores(): void {
    scores.clear();
    renderScores();
    announce('最高用时记录已清空');
  }

  /**
   * Persist the finishing time once per game. `scores.record` ignores invalid
   * values and non-improving times, so a repeated sync or a stale transition
   * cannot write twice.
   */
  function recordWin(elapsedMs: number): void {
    scores.record(bucketForConfig(currentConfig), elapsedMs);
    renderScores();
  }

  /**
   * Rebuild the whole game for `rawConfig`: stop the old clock, cancel the
   * pending touch gesture while keeping its release-click suppression, replace
   * the board DOM and engine, reset the HUD and move focus out of the overlay
   * if it was about to hide. Board, selector and form listeners live on the
   * stable `boardElement` / `customForm` / `root` and the listener signal, so
   * this path never adds listeners or intervals.
   */
  function applyConfig(rawConfig: MinesweeperConfig): void {
    let config: Readonly<MinesweeperConfig>;
    try {
      config = validateConfig(rawConfig);
    } catch {
      // Debug-only callers may pass anything; never leave a half-built board.
      config = DEFAULT_MINESWEEPER_CONFIG;
    }
    const focusWasInOverlay = overlay.contains(document.activeElement);
    currentConfig = config;
    hideDifficultyError();

    stopClock();
    // Like restart, a rebuild must keep the suppression that cancelTouchGesture
    // adds: the finger is still down and its release click will target the
    // rebuilt board. Rows / columns may change, so the token is detached from
    // the old cell and swallows that click wherever it lands.
    cancelTouchGesture(true);

    stageElement.style.setProperty('--rows', String(config.rows));
    stageElement.style.setProperty('--cols', String(config.cols));
    // Only 9×9 keeps the 36px touch-target guarantee; the narrow-screen warning
    // is keyed off this state instead of duplicating the column check in CSS.
    gameRoot.dataset.largeBoard = String(config.cols > TOUCH_TARGET_GUARANTEED_COLS);
    // Square boards derive the stage height from the unpadded board in CSS;
    // this keeps WebKit's aspect-ratio handling from stretching the padded
    // stage (see minesweeper.css).
    gameRoot.dataset.squareBoard = String(config.rows === config.cols);
    boardElement.setAttribute(
      'aria-label',
      `${config.rows} × ${config.cols} 扫雷棋盘`,
    );
    setText(boardSummary, `${config.rows} × ${config.cols} · ${config.mines} 雷`);

    boardElement.innerHTML = boardHtml(config);
    cellButtons = cellButtonsFor(boardElement, config);
    engine = new MinesweeperEngine({
      config,
      ...engineSeamOptions(config),
    });

    // Reset every piece of per-game HUD and overlay state before syncing.
    setText(remainingElement, String(config.mines));
    setText(flagCountElement, '0');
    setText(timerElement, formatTime(0));
    setText(statusElement, STATUS_LABELS.ready);
    setText(announcer, '');
    setText(overlayKicker, 'RESULT');
    setText(overlayTitle, '棋局结束');
    setText(overlayBody, '点击「再来一局」重新开始。');
    overlay.hidden = true;
    gameRoot.dataset.status = 'ready';
    lastStatus = engine.currentStatus;

    syncDifficultyControls();
    renderScores();
    sync();

    // Hiding the overlay while its restart button owns focus would leave focus
    // on an invisible control. Move it to the selected preset (or the custom
    // submit button for a custom board) instead.
    if (focusWasInOverlay) {
      const activePreset = presetButtons.find(
        (button) => button.getAttribute('aria-pressed') === 'true',
      );
      (activePreset ?? customSubmit).focus();
    }
  }

  applyConfig(initialConfig);

  function announce(message: string): void {
    setText(announcer, message);
  }

  function renderCell(cell: MinesweeperCell, status: MinesweeperStatus): void {
    const button = cellButtons[cell.row]?.[cell.col];
    if (!button) {
      return;
    }
    const visual = cellVisual(cell, status);
    button.dataset.state = visual;
    if (cell.revealed) {
      button.dataset.revealed = 'true';
    } else {
      delete button.dataset.revealed;
    }
    if (visual === 'revealed' && cell.adjacentMines > 0) {
      button.dataset.number = String(cell.adjacentMines);
    } else {
      delete button.dataset.number;
    }
    if (cell.mine && (visual === 'mine' || visual === 'exploded')) {
      button.dataset.mine = 'true';
    } else {
      delete button.dataset.mine;
    }
    button.textContent = cellContent(cell, visual);
    button.setAttribute('aria-label', cellLabel(cell, status));
  }

  function sync(): void {
    const state = engine.state;
    gameRoot.dataset.status = state.status;
    for (const row of state.board) {
      for (const cell of row) {
        renderCell(cell, state.status);
      }
    }
    setText(remainingElement, String(state.remainingMines));
    setText(flagCountElement, String(state.flaggedCount));
    setText(timerElement, formatTime(state.elapsedMs));
    setText(statusElement, STATUS_LABELS[state.status]);

    const finished = state.status === 'won' || state.status === 'lost';
    overlay.hidden = !finished;
    if (finished) {
      if (state.status === 'won') {
        setText(overlayKicker, 'CLEARED');
        setText(overlayTitle, '扫雷成功');
        setText(overlayBody, `全部安全格已翻开，用时 ${formatTime(state.elapsedMs)}。`);
      } else {
        setText(overlayKicker, 'BOOM');
        setText(overlayTitle, '踩到地雷');
        setText(overlayBody, `本局用时 ${formatTime(state.elapsedMs)}，点击「再来一局」重新开始。`);
      }
    }

    if (state.status === 'playing') {
      startClock();
    } else {
      stopClock();
    }

    if (state.status !== lastStatus) {
      // The win chime belongs to entering the won state. A first reveal can
      // clear the whole board before the view ever observes "playing", so the
      // transition may be ready -> won as well as playing -> won. A repeated
      // sync, a restart or a board rebuild cannot play it again. The same
      // one-shot transition is what records the best time, so a lost game and
      // a restart never touch the table.
      if (state.status === 'won' && lastStatus !== 'won') {
        recordWin(state.elapsedMs);
        services.audio.play('win');
      }
      if (state.status === 'playing') {
        announce('游戏开始');
      } else if (state.status === 'won') {
        announce('扫雷成功，全部安全格已翻开');
      } else if (state.status === 'lost') {
        announce('踩到地雷，本局结束');
      }
      lastStatus = state.status;
      if (finished) {
        primaryButton.focus({ preventScroll: true });
      }
    }
  }

  function currentCell(target: EventTarget | null): { row: number; col: number } | null {
    if (!(target instanceof Element)) {
      return null;
    }
    const button = target.closest<HTMLElement>('[data-cell]');
    if (!button || !boardElement.contains(button)) {
      return null;
    }
    const row = Number(button.dataset.row);
    const col = Number(button.dataset.col);
    return Number.isInteger(row) &&
      Number.isInteger(col) &&
      row >= 0 &&
      row < currentConfig.rows &&
      col >= 0 &&
      col < currentConfig.cols
      ? { row, col }
      : null;
  }

  function reveal(row: number, col: number): void {
    const status = engine.currentStatus;
    if (status === 'won' || status === 'lost') {
      return;
    }
    services.audio.unlock();
    const result = engine.reveal(row, col);
    if (result.hitMine) {
      services.audio.play('mine');
    } else if (result.revealed.length > 0) {
      services.audio.play('reveal');
    }
    sync();
  }

  function toggleFlag(row: number, col: number): void {
    const status = engine.currentStatus;
    if (status === 'won' || status === 'lost') {
      return;
    }
    services.audio.unlock();
    const result = engine.toggleFlag(row, col);
    if (result.changed) {
      services.audio.play('flag');
    }
    sync();
  }

  function restart(): void {
    // A restart from another finger must not let a held cell's timer flag the
    // fresh board a moment later. Restart keeps the board layout, so the
    // pending token still matches the held cell's release click.
    cancelTouchGesture();
    services.audio.unlock();
    engine.restart();
    stopClock();
    lastStatus = engine.currentStatus;
    sync();
    // A rejected custom board can leave a stale alert and field values while
    // the active game still uses the previous config. Restarting is a fresh
    // game action, so clear that transient error and show the active config.
    hideDifficultyError();
    syncDifficultyControls();
    renderScores();
    announce('游戏重新开始');
    // The overlay hides with focus still inside it, so move focus back to a
    // visible restart control once the new board is ready. On touch layouts the
    // compact button next to the board is preferred even when the restart came
    // from the sidebar button, which can sit below the phone fold; desktop
    // hides the touch actions and keeps the sidebar button.
    const focusTarget =
      mobileRestartButton.offsetParent !== null ? mobileRestartButton : restartButton;
    // Let focus scroll the target into view: a sidebar restart on a phone can
    // leave the compact button above the fold, and a focused off-screen button
    // would only look like the focus was lost.
    focusTarget.focus();
  }

  boardElement.addEventListener(
    'pointerdown',
    (event) => {
      // Any new press supersedes a pending touch hold: a second finger, a
      // mouse click after a cancelled hold, or a pen tap.
      const hadActiveGesture = touchGesture !== null;
      cancelTouchGesture();
      if (!hadActiveGesture) {
        // With no gesture tracked, a pending cell token has no release click we
        // can attribute, so drop it rather than let it swallow this new press's
        // click. A gesture cancelled by movement can still emit a click; this
        // cleanup deliberately prefers not swallowing the new tap. A detached
        // token is different: its finger may still be down after a rebuild, so
        // keep it until that finger lifts.
        for (const [pointerId, suppressed] of suppressedClicks) {
          if (suppressed !== null || !activeTouchPointers.has(pointerId)) {
            suppressedClicks.delete(pointerId);
          }
        }
      }
      // Only this pointer's stale token is cleared; another finger's pending
      // release click keeps its own entry.
      suppressedClicks.delete(event.pointerId);
      if (event.pointerType !== 'touch') {
        return;
      }
      activeTouchPointers.add(event.pointerId);
      const cell = currentCell(event.target);
      if (!cell) {
        return;
      }
      const gesture: TouchGesture = {
        pointerId: event.pointerId,
        row: cell.row,
        col: cell.col,
        startX: event.clientX,
        startY: event.clientY,
        timer: null,
        longPressed: false,
      };
      gesture.timer = window.setTimeout(() => {
        gesture.timer = null;
        if (touchGesture !== gesture || gesture.longPressed) {
          return;
        }
        gesture.longPressed = true;
        // The release must not reveal the cell on the synthetic click.
        suppressNextClick(gesture.pointerId, gesture.row, gesture.col);
        toggleFlag(gesture.row, gesture.col);
      }, LONG_PRESS_MS);
      touchGesture = gesture;
    },
    { signal: listenerSignal },
  );

  boardElement.addEventListener(
    'pointermove',
    (event) => {
      if (!touchGesture || touchGesture.pointerId !== event.pointerId) {
        return;
      }
      const distance = Math.hypot(
        event.clientX - touchGesture.startX,
        event.clientY - touchGesture.startY,
      );
      // A drag is a scroll / accidental movement, not a long press or a tap.
      if (distance > LONG_PRESS_MOVE_TOLERANCE_PX) {
        cancelTouchGesture();
      }
    },
    { signal: listenerSignal },
  );

  boardElement.addEventListener(
    'pointerup',
    (event) => {
      if (event.pointerType === 'touch') {
        activeTouchPointers.delete(event.pointerId);
      }
      if (!touchGesture || touchGesture.pointerId !== event.pointerId) {
        return;
      }
      clearGestureTimer(touchGesture);
      touchGesture = null;
      // A quick tap reaches the click handler below and reveals exactly once.
    },
    { signal: listenerSignal },
  );

  boardElement.addEventListener(
    'pointercancel',
    (event) => {
      if (event.pointerType === 'touch') {
        activeTouchPointers.delete(event.pointerId);
      }
      if (touchGesture?.pointerId === event.pointerId) {
        // A cancelled pointer never produces a click, so cancel without adding
        // a suppression token.
        endTouchGesture(false);
      }
      // Drop only this pointer's token: its click cannot arrive any more,
      // while another finger's pending release click keeps its suppression.
      suppressedClicks.delete(event.pointerId);
    },
    { signal: listenerSignal },
  );
  boardElement.addEventListener('pointerleave', () => cancelTouchGesture(), {
    signal: listenerSignal,
  });

  // Scrolling must cancel a pending flag even when the browser does not send
  // pointercancel (for example a programmatic scroll or a nested scroller).
  window.addEventListener('scroll', () => cancelTouchGesture(), {
    capture: true,
    passive: true,
    signal: listenerSignal,
  });

  boardElement.addEventListener(
    'click',
    (event) => {
      // A touch release click cannot be identified by pointer id: WebKit sends
      // pointerdown as pointerType "touch" / pointerId 2 but the click as a
      // mouse-mediated PointerEvent with pointerType "mouse" / pointerId 1.
      // Match the pending gesture by its target cell instead and swallow that
      // first detail > 0 click. A click on another cell belongs to a different
      // finger or a later tap, so it must neither reveal the suppressed cell
      // nor clear that finger's suppression. A detached token (rebuild) names
      // no cell: it swallows the click wherever it lands once its own finger
      // has lifted, while a still-held finger's click belongs to another finger
      // and must reveal. Keyboard activation (detail 0) always passes.
      if (event.detail > 0 && suppressedClicks.size > 0) {
        const target = currentCell(event.target);
        let matched: number | undefined;
        let detached: number | undefined;
        for (const [pointerId, suppressed] of suppressedClicks) {
          if (
            target !== null &&
            suppressed !== null &&
            suppressed.row === target.row &&
            suppressed.col === target.col
          ) {
            matched = pointerId;
            break;
          }
          if (
            suppressed === null &&
            detached === undefined &&
            !activeTouchPointers.has(pointerId)
          ) {
            detached = pointerId;
          }
        }
        const consumed = matched ?? detached;
        if (consumed !== undefined) {
          suppressedClicks.delete(consumed);
          return;
        }
        if (!target) {
          // The click missed every cell. Consume a token that is already
          // released so it cannot swallow a later real click, but keep a
          // detached token whose finger is still down.
          for (const [pointerId, suppressed] of suppressedClicks) {
            if (suppressed !== null || !activeTouchPointers.has(pointerId)) {
              suppressedClicks.delete(pointerId);
              break;
            }
          }
          return;
        }
      }
      const cell = currentCell(event.target);
      if (cell) {
        reveal(cell.row, cell.col);
      }
    },
    { signal: listenerSignal },
  );

  boardElement.addEventListener(
    'contextmenu',
    (event) => {
      const cell = currentCell(event.target);
      if (!cell) {
        return;
      }
      // Keep the browser menu closed so right-click stays a flag toggle and a
      // touch long press never opens the native menu or selects text.
      event.preventDefault();
      // Touch long presses are owned by the 500 ms timer; a contextmenu that
      // arrives while the finger is down must not toggle the flag a second
      // time. Mouse right-click keeps its existing behavior.
      const touchContextMenu =
        event instanceof PointerEvent && event.pointerType === 'touch';
      if (touchContextMenu || touchGesture !== null) {
        // Some touch browsers fire the native contextmenu at the same moment
        // as our timer. Whichever runs first owns the flag; if the menu wins,
        // disarm the timer so one hold still toggles exactly once.
        if (touchGesture && !touchGesture.longPressed) {
          clearGestureTimer(touchGesture);
          touchGesture.longPressed = true;
          suppressNextClick(touchGesture.pointerId, touchGesture.row, touchGesture.col);
          toggleFlag(touchGesture.row, touchGesture.col);
        }
        return;
      }
      toggleFlag(cell.row, cell.col);
    },
    { signal: listenerSignal },
  );

  root.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const presetButton = event.target.closest<HTMLButtonElement>(
        'button[data-difficulty]',
      );
      if (presetButton && root.contains(presetButton)) {
        const preset = DIFFICULTY_PRESETS.find(
          (candidate) => candidate.id === presetButton.dataset.difficulty,
        );
        if (preset) {
          applyConfig(preset);
        }
        return;
      }
      const restartTarget = event.target.closest<HTMLButtonElement>(
        'button[data-action="restart"]',
      );
      if (restartTarget && root.contains(restartTarget)) {
        restart();
        return;
      }
      const clearTarget = event.target.closest<HTMLButtonElement>(
        'button[data-action="clear-scores"]',
      );
      if (clearTarget && root.contains(clearTarget)) {
        clearScores();
      }
    },
    { signal: listenerSignal },
  );

  customForm.addEventListener(
    'submit',
    (event) => {
      // Always own the submission so a rejected custom board never reloads the
      // page or escapes the view. A parse failure only updates the alert; the
      // current board, clock and preset selection stay untouched.
      event.preventDefault();
      const result = parseCustomDifficulty(
        rowsInput.value,
        colsInput.value,
        minesInput.value,
      );
      if (!result.ok) {
        showDifficultyError(result.message);
        return;
      }
      applyConfig(result.config);
    },
    { signal: listenerSignal },
  );

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    // The board and restart listeners are signal-bound; the clock and the
    // mountSignal bridge are not, so both are released explicitly here.
    mountSignal.removeEventListener('abort', onMountAbort);
    controller.abort();
    cancelTouchGesture();
    // No further click can reach this mount; drop any pending suppression
    // tokens and the pointer liveness they consult.
    suppressedClicks.clear();
    activeTouchPointers.clear();
    stopClock();
    const debug = debugWindow();
    const api = debug.__playground;
    if (api?.gameId === 'minesweeper' && api.destroy === destroy) {
      delete debug.__playground;
    }
  };

  if (debugEnabled()) {
    debugWindow().__playground = {
      gameId: 'minesweeper',
      getState: () => engine.state,
      setConfig: (config) => applyConfig(config),
      destroy,
    };
  }

  sync();

  return { destroy };
}
