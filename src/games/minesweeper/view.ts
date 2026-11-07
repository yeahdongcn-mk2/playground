import { query, setText } from '../../core/dom';
import type { GameHandle, GameServices } from '../../core/game';
import { resolveDebugSeed } from './debug';
import {
  COLS,
  createSeededRng,
  isInBounds,
  MINE_COUNT,
  MinesweeperEngine,
  ROWS,
  type Cell,
  type MinesweeperCell,
  type MinesweeperOptions,
  type MinesweeperSnapshot,
  type MinesweeperStatus,
} from './engine';
import './minesweeper.css';

const CLOCK_INTERVAL_MS = 250;
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

const VIEW_HTML = `
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
          <dd data-testid="remaining-mines">${MINE_COUNT}</dd>
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
        <div class="minesweeper-stage">
          <div class="minesweeper-board" data-testid="minesweeper-board" role="group"
            aria-label="9 × 9 扫雷棋盘"></div>
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
          <p class="minesweeper-summary"><span>棋盘</span><strong>9 × 9 · ${MINE_COUNT} 雷</strong></p>
          <div class="panel-actions">
            <button class="button button--ghost" type="button" data-action="restart"
              data-testid="restart-button">重开</button>
          </div>
        </div>

        <p class="minesweeper-hint">全部安全格翻开即获胜；插旗数量可以超过雷数，剩余雷数会随之变为负数。</p>
        <p class="sr-only" data-testid="announcer" aria-live="polite"></p>
      </aside>
    </div>
  </section>
`;

interface MinesweeperDebugApi {
  gameId: 'minesweeper';
  getState: () => MinesweeperSnapshot;
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

/**
 * Parse a fixed mine layout, e.g. `mines=0,0;0,1;...`. Invalid or incomplete
 * layouts are ignored instead of surfacing a debug-only crash to the player.
 */
function parseDebugMines(raw: string | null): readonly Cell[] | undefined {
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
    if (!isInBounds(row, col)) {
      return undefined;
    }
    const index = row * COLS + col;
    if (seen.has(index)) {
      return undefined;
    }
    seen.add(index);
    cells.push({ row, col });
  }
  return cells.length === MINE_COUNT ? cells : undefined;
}

/**
 * Deterministic options for e2e runs, including a stable PRNG fallback.
 * A missing or invalid `seed` uses 1; only an explicit finite value (such as
 * `seed=0`) overrides it.
 */
function debugEngineOptions(): Pick<MinesweeperOptions, 'initialMines' | 'rng'> {
  const params = debugParams();
  return {
    rng: createSeededRng(resolveDebugSeed(params.get('seed'))),
    initialMines: parseDebugMines(params.get('mines')),
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
  root.innerHTML = VIEW_HTML;

  const gameRoot = query<HTMLElement>(root, '[data-testid="minesweeper-game"]');
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
  const announcer = query<HTMLElement>(root, '[data-testid="announcer"]');

  boardElement.innerHTML = Array.from({ length: ROWS }, (_, row) => {
    const cells = Array.from({ length: COLS }, (_, col) => {
      const testId = `cell-${row}-${col}`;
      return `<button class="minesweeper-cell" type="button"
        data-cell data-row="${row}" data-col="${col}" data-state="hidden"
        data-testid="${testId}" aria-label="第 ${row + 1} 行第 ${col + 1} 列，未翻开"></button>`;
    }).join('');
    return `<div class="minesweeper-row">${cells}</div>`;
  }).join('');

  const cellButtons: HTMLButtonElement[][] = Array.from({ length: ROWS }, (_, row) =>
    Array.from({ length: COLS }, (_, col) =>
      query<HTMLButtonElement>(boardElement, `[data-testid="cell-${row}-${col}"]`),
    ),
  );

  const engine = new MinesweeperEngine(debugEnabled() ? debugEngineOptions() : {});

  const controller = new AbortController();
  const listenerSignal = controller.signal;
  const onMountAbort = (): void => controller.abort();
  mountSignal.addEventListener('abort', onMountAbort, { once: true });

  let clock: number | null = null;
  let lastTickAt = 0;
  let lastStatus: MinesweeperStatus = engine.currentStatus;

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
  // Pointer ids whose synthetic click must not also reveal a cell: the long
  // press already toggled a flag, or the finger moved / the page scrolled. This
  // is gesture-level state, not a timer: the synthetic click arrives when the
  // finger lifts, which may be long after the 500 ms long-press timer (for
  // example a second hold that clears a flag). It is keyed by pointer id so a
  // second finger can start its own gesture without clearing the suppression
  // that belongs to the first finger. Each id is consumed by one pointer
  // click, or cleared when that pointer starts a new gesture (defensive: a
  // browser may reuse an id). pointercancel drops its id because no click can
  // follow; a scroll / pointerleave cancel keeps its id because a click still
  // might, and ids that never get one stay harmlessly until destroy drops the
  // set. Keyboard activation (detail 0) always passes.
  const suppressedClickPointers = new Set<number>();

  function clearGestureTimer(gesture: TouchGesture): void {
    if (gesture.timer !== null) {
      window.clearTimeout(gesture.timer);
      gesture.timer = null;
    }
  }

  function suppressNextTouchClick(pointerId: number): void {
    suppressedClickPointers.add(pointerId);
  }

  function cancelTouchGesture(): void {
    if (!touchGesture) {
      return;
    }
    clearGestureTimer(touchGesture);
    // Keep this finger's synthetic click from revealing the cell, even if a
    // second finger starts its own gesture in the meantime.
    suppressNextTouchClick(touchGesture.pointerId);
    touchGesture = null;
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
    return isInBounds(row, col) ? { row, col } : null;
  }

  function reveal(row: number, col: number): void {
    const status = engine.currentStatus;
    if (status === 'won' || status === 'lost') {
      return;
    }
    services.audio.unlock();
    const result = engine.reveal(row, col);
    if (result.hitMine) {
      services.audio.play('reset');
    } else if (result.revealed.length > 0) {
      services.audio.play('blip');
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
      services.audio.play('blip');
    }
    sync();
  }

  function restart(): void {
    // A restart from another finger must not let a held cell's timer flag the
    // fresh board a moment later.
    cancelTouchGesture();
    services.audio.unlock();
    engine.restart();
    stopClock();
    lastStatus = engine.currentStatus;
    sync();
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
      cancelTouchGesture();
      // Only this pointer's stale suppression is cleared; another finger's
      // pending release click keeps its own entry.
      suppressedClickPointers.delete(event.pointerId);
      if (event.pointerType !== 'touch') {
        return;
      }
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
        suppressNextTouchClick(gesture.pointerId);
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
      cancelTouchGesture();
      // A cancelled pointer never produces a click, so its id would otherwise
      // stay suppressed for the lifetime of the mount.
      suppressedClickPointers.delete(event.pointerId);
    },
    { signal: listenerSignal },
  );
  boardElement.addEventListener('pointerleave', cancelTouchGesture, {
    signal: listenerSignal,
  });

  // Scrolling must cancel a pending flag even when the browser does not send
  // pointercancel (for example a programmatic scroll or a nested scroller).
  window.addEventListener('scroll', cancelTouchGesture, {
    capture: true,
    passive: true,
    signal: listenerSignal,
  });

  boardElement.addEventListener(
    'click',
    (event) => {
      // A synthetic click is a PointerEvent whose pointerId matches the touch
      // that produced it. Consuming the id here keeps a long press / cancelled
      // gesture from revealing the cell; detail 0 is keyboard activation.
      const suppressed =
        event.detail > 0 &&
        event instanceof PointerEvent &&
        suppressedClickPointers.delete(event.pointerId);
      if (suppressed) {
        return;
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
          suppressNextTouchClick(touchGesture.pointerId);
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
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLButtonElement>('button[data-action="restart"]')
          : null;
      if (target && root.contains(target)) {
        restart();
      }
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
    // No further click can reach this mount; drop any pending suppression ids.
    suppressedClickPointers.clear();
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
      destroy,
    };
  }

  sync();

  return { destroy };
}
