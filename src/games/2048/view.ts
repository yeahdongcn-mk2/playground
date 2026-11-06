import { query, setText } from '../../core/dom';
import type { GameHandle, GameServices } from '../../core/game';
import { directionFromCode, isEditableTarget } from '../../core/input';
import type { Phaser2DRuntime } from '../../engine/phaser2d';
import {
  createSeededRng,
  Game2048Engine,
  type Board,
  type Direction,
  type Game2048Options,
  type Game2048Snapshot,
} from './engine';
import type { Game2048Scene } from './scene';
import './2048.css';

const READY_TIMEOUT_MS = 12_000;
const BEST_SCORE_KEY = '2048.best';
const SWIPE_THRESHOLD = 24;

const VIEW_HTML = `
  <section class="game-2048" data-testid="2048-game" data-status="loading">
    <div class="game-heading">
      <a class="back-link" href="#/">
        <span aria-hidden="true">←</span> 返回大厅
      </a>
      <div class="game-heading-copy">
        <p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> 2D · 益智 · Phaser 4</p>
        <h1>2048 <span>Twenty Forty-Eight</span></h1>
      </div>
      <dl class="game-2048-hud" aria-label="游戏数据">
        <div class="game-2048-stat">
          <dt>得分</dt>
          <dd data-testid="score">0</dd>
        </div>
        <div class="game-2048-stat">
          <dt>最高分</dt>
          <dd data-testid="best">0</dd>
        </div>
        <div class="game-2048-stat">
          <dt>状态</dt>
          <dd data-testid="status">准备开始</dd>
        </div>
      </dl>
    </div>

    <div class="game-2048-layout">
      <div class="game-2048-main">
        <div class="game-2048-stage" data-testid="2048-stage">
          <div class="game-2048-board" data-testid="2048-board"></div>
          <div class="game-2048-overlay" data-testid="overlay" role="group" aria-labelledby="game-2048-overlay-title">
            <div class="game-2048-overlay-card">
              <p class="panel-kicker" data-testid="overlay-kicker">LOADING</p>
              <h2 id="game-2048-overlay-title" data-testid="overlay-title">正在准备棋盘</h2>
              <p class="game-2048-overlay-body" data-testid="overlay-body">
                引擎加载中，马上开始。
              </p>
              <p class="game-2048-overlay-score" data-testid="overlay-score" hidden></p>
              <button class="button button--primary" type="button" data-action="primary" disabled>
                开始游戏
              </button>
            </div>
          </div>
        </div>

        <p class="game-2048-swipe-hint" data-testid="swipe-hint">
          在棋盘上向任意方向滑动，相同数字相撞会合并。
        </p>
      </div>

      <aside class="game-2048-panel" aria-label="操作与状态">
        <div class="panel-card">
          <p class="panel-kicker">CONTROLS</p>
          <h2>操作</h2>
          <dl class="control-list">
            <div>
              <dt>
                <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd><span class="key-divider">/</span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
              </dt>
              <dd>滑动并合并</dd>
            </div>
            <div><dt><span class="pointer-glyph" aria-hidden="true"></span> 触屏</dt><dd>在棋盘上滑动</dd></div>
            <div><dt><kbd>R</kbd></dt><dd>开始 / 重新开始</dd></div>
          </dl>
        </div>

        <div class="panel-card">
          <p class="panel-kicker">STATUS</p>
          <h2>本局</h2>
          <p class="game-2048-row"><span>最大方块</span><strong data-testid="max-tile">0</strong></p>
          <div class="panel-actions">
            <button class="button button--ghost" type="button" data-action="restart"
              data-testid="restart-button" disabled>重开</button>
          </div>
        </div>

        <p class="game-2048-hint">
          每步都会在空格生成 2 或 4。填满且无法合并时结束，最高分保存在本机。
        </p>
        <p class="sr-only" data-testid="announcer" aria-live="polite"></p>
      </aside>
    </div>
  </section>
`;

interface Game2048DebugApi {
  gameId: '2048';
  getState: () => Game2048Snapshot;
  /** Test seam: destroy the mount without waiting for a route change. */
  destroy: () => void;
}

/**
 * Test seam. `window.__playground` is also declared for the snake game, so use
 * one local cast instead of merging a conflicting global declaration.
 */
interface Game2048DebugWindow {
  __playground?: Game2048DebugApi;
}

function debugWindow(): Game2048DebugWindow {
  return window as unknown as Game2048DebugWindow;
}

function abortError(): DOMException {
  return new DOMException('Game mount aborted', 'AbortError');
}

function blurActiveElement(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    active.blur();
  }
}

function waitForReady(ready: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    ready.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function nextSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

/** Test seam: enabled on the dev server, or with `?debug=1` in a build. */
function debugEnabled(): boolean {
  if (import.meta.env.DEV) {
    return true;
  }
  const query = window.location.hash.split('?')[1];
  return query ? new URLSearchParams(query).has('debug') : false;
}

/** Query string after the hash route, e.g. `#/games/2048?debug=1&board=...`. */
function debugParams(): URLSearchParams {
  const hash = window.location.hash;
  const queryIndex = hash.indexOf('?');
  return new URLSearchParams(
    queryIndex >= 0 ? hash.slice(queryIndex + 1) : window.location.search,
  );
}

/** Force the canvas renderer only when a test asks for it explicitly. */
function debugRenderer(): 'canvas' | undefined {
  if (!debugEnabled()) {
    return undefined;
  }
  return debugParams().get('renderer') === 'canvas' ? 'canvas' : undefined;
}

function debugEngineOptions(): Pick<Game2048Options, 'initialBoard'> {
  if (!debugEnabled()) {
    return {};
  }
  const raw = debugParams().get('board');
  if (!raw) {
    return {};
  }
  const board = parseDebugBoard(raw);
  return board ? { initialBoard: board } : {};
}

/**
 * Row-major board: `/` separates rows, `,` separates cells and `.` is empty,
 * e.g. `2,2,.,./.,.,.,./.,.,.,./.,.,.,.`. Values must be positive powers of two.
 */
function parseDebugBoard(raw: string): Board | undefined {
  const rows = raw.split('/');
  if (rows.length !== 4) {
    return undefined;
  }

  const board: (number | null)[][] = [];
  for (const row of rows) {
    const cells = row.split(',');
    if (cells.length !== 4) {
      return undefined;
    }
    const parsedRow: (number | null)[] = [];
    for (const cell of cells) {
      if (cell === '' || cell === '.') {
        parsedRow.push(null);
        continue;
      }
      const value = Number(cell);
      if (!Number.isInteger(value) || value < 2) {
        return undefined;
      }
      const exponent = Math.log2(value);
      if (!Number.isInteger(exponent)) {
        return undefined;
      }
      parsedRow.push(value);
    }
    board.push(parsedRow);
  }

  if (!board.some((row) => row.some((value) => value !== null))) {
    return undefined;
  }
  return board;
}

function maxTileOf(state: Game2048Snapshot): number {
  let max = 0;
  for (const row of state.board) {
    for (const value of row) {
      if (value !== null && value > max) {
        max = value;
      }
    }
  }
  return max;
}

function bindSwipe(
  target: HTMLElement,
  onDirection: (direction: Direction) => void,
  listenerSignal: AbortSignal,
): void {
  let origin: { readonly pointerId: number; readonly x: number; readonly y: number } | null = null;

  target.addEventListener(
    'pointerdown',
    (event) => {
      if (!event.isPrimary) {
        return;
      }
      // Let buttons and links keep their normal click behaviour; the overlay's
      // start button is inside the stage.
      if (event.target instanceof Element && event.target.closest('button, a')) {
        origin = null;
        return;
      }
      origin = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is a best-effort enhancement for drags leaving the stage.
      }
    },
    { signal: listenerSignal },
  );

  target.addEventListener(
    'pointerup',
    (event) => {
      if (!origin || event.pointerId !== origin.pointerId) {
        return;
      }
      const dx = event.clientX - origin.x;
      const dy = event.clientY - origin.y;
      origin = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_THRESHOLD) {
        return;
      }
      if (Math.abs(dx) > Math.abs(dy)) {
        onDirection(dx > 0 ? 'right' : 'left');
      } else {
        onDirection(dy > 0 ? 'down' : 'up');
      }
    },
    { signal: listenerSignal },
  );

  const clearOrigin = (event: PointerEvent): void => {
    if (origin?.pointerId === event.pointerId) {
      origin = null;
    }
  };
  target.addEventListener('pointercancel', clearOrigin, { signal: listenerSignal });
  target.addEventListener('lostpointercapture', clearOrigin, { signal: listenerSignal });
}

export async function mount2048(
  root: HTMLElement,
  services: GameServices,
  mountSignal: AbortSignal,
): Promise<GameHandle> {
  if (mountSignal.aborted) {
    throw abortError();
  }
  root.innerHTML = VIEW_HTML;

  const gameRoot = query<HTMLElement>(root, '[data-testid="2048-game"]');
  const boardElement = query<HTMLElement>(root, '[data-testid="2048-board"]');
  const stageElement = query<HTMLElement>(root, '[data-testid="2048-stage"]');
  const overlay = query<HTMLElement>(root, '[data-testid="overlay"]');
  const overlayKicker = query<HTMLElement>(root, '[data-testid="overlay-kicker"]');
  const overlayTitle = query<HTMLElement>(root, '[data-testid="overlay-title"]');
  const overlayBody = query<HTMLElement>(root, '[data-testid="overlay-body"]');
  const overlayScore = query<HTMLElement>(root, '[data-testid="overlay-score"]');
  const primaryButton = query<HTMLButtonElement>(
    root,
    '[data-testid="overlay"] [data-action="primary"]',
  );
  const restartButton = query<HTMLButtonElement>(root, '[data-testid="restart-button"]');
  const scoreElement = query<HTMLElement>(root, '[data-testid="score"]');
  const bestElement = query<HTMLElement>(root, '[data-testid="best"]');
  const statusElement = query<HTMLElement>(root, '[data-testid="status"]');
  const maxTileElement = query<HTMLElement>(root, '[data-testid="max-tile"]');
  const announcer = query<HTMLElement>(root, '[data-testid="announcer"]');

  const engine = new Game2048Engine({
    rng: createSeededRng(nextSeed()),
    ...debugEngineOptions(),
  });

  let started = false;
  let best = services.storage.getNumber(BEST_SCORE_KEY, 0);
  let lastStatus = engine.currentStatus;
  let scene: Game2048Scene | null = null;

  const controller = new AbortController();
  const listenerSignal = controller.signal;
  const onMountAbort = (): void => controller.abort();
  mountSignal.addEventListener('abort', onMountAbort, { once: true });

  function sync(): void {
    const state = engine.state;
    const maxTile = maxTileOf(state);
    const settled = state.status === 'gameover';

    if (state.score > best) {
      best = state.score;
      services.storage.set(BEST_SCORE_KEY, best);
    }

    gameRoot.dataset.status = settled ? 'gameover' : started ? 'playing' : 'ready';
    setText(scoreElement, String(state.score));
    setText(bestElement, String(best));
    setText(maxTileElement, String(maxTile));
    setText(statusElement, settled ? '已结束' : started ? '进行中' : '准备开始');
    scene?.render(state);

    restartButton.disabled = !started;
    overlay.hidden = started && !settled;
    primaryButton.disabled = false;

    if (!started && !settled) {
      setText(overlayKicker, 'READY');
      setText(overlayTitle, '合并出 2048');
      setText(overlayBody, '方向键 / WASD 滑动，或在棋盘上滑动；相同数字相撞会合并。');
      overlayScore.hidden = true;
      setText(primaryButton, '开始游戏');
    } else if (settled) {
      setText(overlayKicker, 'GAME OVER');
      setText(overlayTitle, '无路可走');
      setText(overlayBody, '棋盘上没有可移动或合并的方块了。点击「再来一局」重新开始。');
      setText(overlayScore, `本局 ${state.score} 分 · 最大方块 ${maxTile}`);
      overlayScore.hidden = false;
      setText(primaryButton, '再来一局');
    }

    if (state.status !== lastStatus) {
      announce(state.status);
      lastStatus = state.status;
      if (settled) {
        primaryButton.focus({ preventScroll: true });
      }
    }
  }

  function announce(status: Game2048Snapshot['status']): void {
    if (status === 'gameover') {
      setText(announcer, '游戏结束，无路可走');
    }
  }

  function startRun(): void {
    blurActiveElement();
    started = true;
    setText(announcer, '游戏开始');
    services.audio.unlock();
    services.audio.play('start');
    sync();
  }

  function restartRun(): void {
    blurActiveElement();
    engine.restart();
    started = true;
    setText(announcer, '游戏重新开始');
    services.audio.unlock();
    services.audio.play('start');
    sync();
  }

  function primaryAction(): void {
    if (engine.currentStatus === 'gameover') {
      restartRun();
    } else if (!started) {
      startRun();
    }
  }

  function performMove(direction: Direction): void {
    if (!started) {
      startRun();
    }
    if (engine.currentStatus !== 'playing') {
      return;
    }
    services.audio.unlock();
    const result = engine.move(direction);
    if (result.moved && result.mergedTiles.length > 0) {
      services.audio.play('blip');
    }
    if (result.gameOver) {
      services.audio.play('reset');
    }
    sync();
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (isEditableTarget(event.target)) {
      return;
    }

    const direction = directionFromCode(event.code);
    if (direction) {
      event.preventDefault();
      performMove(direction);
      return;
    }

    if (event.code === 'KeyR') {
      event.preventDefault();
      // From READY, R starts the run; once started it restarts, including
      // after a game over. This keeps the panel and README wording true.
      if (started || engine.currentStatus === 'gameover') {
        restartRun();
      } else {
        startRun();
      }
    }
  };

  const [{ createPhaser2DGame }, { Game2048Scene: Game2048SceneClass }] = await Promise.all([
    import('../../engine/phaser2d'),
    import('./scene'),
  ]);
  if (mountSignal.aborted) {
    throw abortError();
  }

  let resolveReady: (() => void) | null = null;
  let readyTimer = 0;
  let runtime: Phaser2DRuntime | null = null;
  try {
    // Start the boot timeout only after the chunks arrived; a slow network
    // must not reject a promise that has no handler yet.
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      readyTimer = window.setTimeout(() => {
        reject(new Error('The 2048 2D runtime did not become ready in time.'));
      }, READY_TIMEOUT_MS);
    });
    void ready.catch(() => {});

    scene = new Game2048SceneClass({
      onReady() {
        window.clearTimeout(readyTimer);
        resolveReady?.();
      },
    });

    runtime = createPhaser2DGame({
      parent: boardElement,
      scene,
      ariaLabel: '2048 棋盘',
      activePointers: 2,
      renderer: debugRenderer(),
    });

    await waitForReady(ready, mountSignal);
    if (mountSignal.aborted) {
      throw abortError();
    }
  } catch (error) {
    window.clearTimeout(readyTimer);
    runtime?.destroy();
    throw error;
  }

  if (!runtime) {
    window.clearTimeout(readyTimer);
    throw new Error('The 2048 2D runtime failed to initialize.');
  }
  const activeRuntime = runtime;

  const onVisibilityChange = (): void => {
    if (document.hidden) {
      activeRuntime.game.loop.sleep();
    } else {
      activeRuntime.game.loop.wake();
    }
  };

  root.addEventListener(
    'click',
    (event) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLButtonElement>('button[data-action]')
          : null;
      if (!target || !root.contains(target)) {
        return;
      }
      const action = target.dataset.action;
      if (action === 'primary') {
        primaryAction();
      } else if (action === 'restart' && started) {
        restartRun();
      }
    },
    { signal: listenerSignal },
  );

  window.addEventListener('keydown', onKeyDown, { signal: listenerSignal });
  document.addEventListener('visibilitychange', onVisibilityChange, { signal: listenerSignal });
  bindSwipe(stageElement, performMove, listenerSignal);

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    // The keydown and visibilitychange listeners are also registered with
    // the abort signal, so abort() below releases every listener added by
    // this mount, including the stage pointer handlers from bindSwipe().
    window.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    mountSignal.removeEventListener('abort', onMountAbort);
    controller.abort();
    const debug = debugWindow();
    if (debug.__playground?.gameId === '2048') {
      delete debug.__playground;
    }
    activeRuntime.destroy();
  };

  if (debugEnabled()) {
    debugWindow().__playground = {
      gameId: '2048',
      getState: () => engine.state,
      destroy,
    };
  }

  sync();

  return { destroy };
}
