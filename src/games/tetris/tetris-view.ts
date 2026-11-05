import { query, setText } from '../../core/dom';
import type { GameHandle, GameServices } from '../../core/game';
import type { Phaser2DRuntime } from '../../engine/phaser2d';
import {
  createSeededRng,
  DEFAULT_TETRIS_CONFIG,
  TETROMINO_TYPES,
  TetrisEngine,
  tetrominoCells,
  type Board,
  type StepResult,
  type TetrominoType,
  type TetrisEngineOptions,
  type TetrisSnapshot,
  type TetrisStatus,
} from './engine';
import { TETROMINO_COLORS } from './palette';
import type { TetrisAction, TetrisScene } from './scene';
import './tetris.css';

const READY_TIMEOUT_MS = 12_000;
const NEXT_GRID_SIZE = 4;

const TETRIS_ACTIONS: readonly TetrisAction[] = [
  'left',
  'right',
  'rotate',
  'softDrop',
  'hardDrop',
  'pause',
  'restart',
];

const STATUS_LABELS: Readonly<Record<TetrisStatus, string>> = {
  ready: '待开始',
  running: '进行中',
  paused: '已暂停',
  gameover: '已结束',
};

const VIEW_HTML = `
  <section class="tetris-game" data-testid="tetris-game" data-status="loading">
    <div class="game-heading">
      <a class="back-link" href="#/">
        <span aria-hidden="true">←</span> 返回大厅
      </a>
      <div class="game-heading-copy">
        <p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> 2D · 街机 · Phaser 4</p>
        <h1>俄罗斯方块 <span>Tetris</span></h1>
      </div>
      <dl class="tetris-hud" aria-label="游戏数据">
        <div class="tetris-stat">
          <dt>得分</dt>
          <dd data-testid="score">0</dd>
        </div>
        <div class="tetris-stat">
          <dt>等级</dt>
          <dd data-testid="level">1</dd>
        </div>
        <div class="tetris-stat">
          <dt>消行</dt>
          <dd data-testid="lines">0</dd>
        </div>
      </dl>
    </div>

    <div class="tetris-layout">
      <div class="tetris-main">
        <div class="tetris-stage" data-testid="tetris-stage">
          <div class="tetris-board" data-testid="tetris-board"></div>
          <div class="tetris-overlay" data-testid="overlay" role="group" aria-labelledby="tetris-overlay-title">
            <div class="tetris-overlay-card">
              <p class="panel-kicker" data-testid="overlay-kicker">LOADING</p>
              <h2 id="tetris-overlay-title" data-testid="overlay-title">正在准备棋盘</h2>
              <p class="tetris-overlay-body" data-testid="overlay-body">
                引擎加载中，马上开始。
              </p>
              <p class="tetris-overlay-score" data-testid="overlay-score" hidden></p>
              <button class="button button--primary" type="button" data-action="primary" disabled>
                开始游戏
              </button>
            </div>
          </div>
        </div>

        <div class="tetris-touch" data-testid="touch-controls" role="group" aria-label="触屏操作按钮">
          <div class="tetris-touch-grid">
            <button type="button" class="tetris-key" data-action="left" aria-label="向左移动">←</button>
            <button type="button" class="tetris-key tetris-key--accent" data-action="rotate" aria-label="旋转">↻</button>
            <button type="button" class="tetris-key" data-action="right" aria-label="向右移动">→</button>
            <button type="button" class="tetris-key" data-action="softDrop" aria-label="加速下落">↓</button>
            <button type="button" class="tetris-key tetris-key--accent" data-action="hardDrop" aria-label="硬降到底">⤓</button>
            <button type="button" class="tetris-key" data-action="pause" aria-label="暂停或继续">⏸</button>
          </div>
        </div>
      </div>

      <aside class="tetris-panel" aria-label="操作与状态">
        <div class="panel-card">
          <div class="tetris-next-head">
            <div>
              <p class="panel-kicker">NEXT</p>
              <h2>下一块</h2>
            </div>
            <div class="tetris-next" data-testid="next" data-piece="I" aria-label="下一块"></div>
          </div>
        </div>

        <div class="panel-card">
          <p class="panel-kicker">CONTROLS</p>
          <h2>操作</h2>
          <dl class="control-list">
            <div>
              <dt>
                <kbd>←</kbd><kbd>→</kbd><span class="key-divider">/</span><kbd>A</kbd><kbd>D</kbd>
              </dt>
              <dd>左右移动</dd>
            </div>
            <div><dt><kbd>↑</kbd> / <kbd>W</kbd></dt><dd>旋转</dd></div>
            <div><dt><kbd>↓</kbd> / <kbd>S</kbd></dt><dd>加速下落</dd></div>
            <div><dt><kbd>空格</kbd></dt><dd>硬降到底</dd></div>
            <div><dt><kbd>P</kbd> / <kbd>Esc</kbd></dt><dd>暂停 / 继续</dd></div>
            <div><dt><kbd>R</kbd></dt><dd>重新开始</dd></div>
          </dl>
        </div>

        <div class="panel-card">
          <p class="panel-kicker">STATUS</p>
          <h2>本局</h2>
          <p class="tetris-row"><span>速度</span><strong data-testid="speed">1.00×</strong></p>
          <p class="tetris-row"><span>状态</span><strong data-testid="status">待开始</strong></p>
          <div class="panel-actions">
            <button class="button button--ghost" type="button" data-action="pause"
              data-testid="pause-button" disabled>暂停</button>
            <button class="button button--ghost" type="button" data-action="restart"
              data-testid="restart-button" disabled>重开</button>
          </div>
        </div>

        <p class="tetris-hint">
          消行得分并提升等级，堆到顶端就结束。移动端可以用棋盘下方的按钮操作。
        </p>
        <p class="sr-only" data-testid="announcer" aria-live="polite"></p>
      </aside>
    </div>
  </section>
`;

function abortError(): DOMException {
  return new DOMException('Game mount aborted', 'AbortError');
}

function isTetrisAction(value: string | undefined): value is TetrisAction {
  return value !== undefined && (TETRIS_ACTIONS as readonly string[]).includes(value);
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

export async function mountTetris(
  root: HTMLElement,
  services: GameServices,
  mountSignal: AbortSignal,
): Promise<GameHandle> {
  if (mountSignal.aborted) {
    throw abortError();
  }
  root.innerHTML = VIEW_HTML;

  const gameRoot = query<HTMLElement>(root, '[data-testid="tetris-game"]');
  const boardElement = query<HTMLElement>(root, '[data-testid="tetris-board"]');
  const overlay = query<HTMLElement>(root, '[data-testid="overlay"]');
  const overlayKicker = query<HTMLElement>(root, '[data-testid="overlay-kicker"]');
  const overlayTitle = query<HTMLElement>(root, '[data-testid="overlay-title"]');
  const overlayBody = query<HTMLElement>(root, '[data-testid="overlay-body"]');
  const overlayScore = query<HTMLElement>(root, '[data-testid="overlay-score"]');
  const primaryButton = query<HTMLButtonElement>(
    root,
    '[data-testid="overlay"] [data-action="primary"]',
  );
  const pauseButton = query<HTMLButtonElement>(root, '[data-testid="pause-button"]');
  const restartButton = query<HTMLButtonElement>(root, '[data-testid="restart-button"]');
  const scoreElement = query<HTMLElement>(root, '[data-testid="score"]');
  const levelElement = query<HTMLElement>(root, '[data-testid="level"]');
  const linesElement = query<HTMLElement>(root, '[data-testid="lines"]');
  const speedElement = query<HTMLElement>(root, '[data-testid="speed"]');
  const statusElement = query<HTMLElement>(root, '[data-testid="status"]');
  const nextElement = query<HTMLElement>(root, '[data-testid="next"]');
  const announcer = query<HTMLElement>(root, '[data-testid="announcer"]');

  const engine = new TetrisEngine({
    rng: createSeededRng((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0),
    ...debugEngineOptions(),
  });

  let lastStatus: TetrisStatus = engine.currentStatus;
  let renderedNext: TetrominoType | null = null;
  let scene: TetrisScene | null = null;
  let pausedByVisibility = false;

  const controller = new AbortController();
  const listenerSignal = controller.signal;
  mountSignal.addEventListener('abort', () => controller.abort(), { once: true });

  renderNext(engine.state.next);

  function renderNext(type: TetrominoType): void {
    if (renderedNext === type) {
      return;
    }
    renderedNext = type;
    nextElement.dataset.piece = type;
    const colors = TETROMINO_COLORS[type];
    nextElement.setAttribute('aria-label', `下一块：${type} 形`);
    nextElement.style.setProperty('--next-color', colors.css);

    const cells = tetrominoCells(type, 0);
    const xs = cells.map((cell) => cell.x);
    const ys = cells.map((cell) => cell.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const offsetX = Math.floor((NEXT_GRID_SIZE - (maxX - minX + 1)) / 2);
    const offsetY = Math.floor((NEXT_GRID_SIZE - (maxY - minY + 1)) / 2);
    const filled = new Set(
      cells.map((cell) => `${cell.x - minX + offsetX},${cell.y - minY + offsetY}`),
    );

    const grid: HTMLElement[] = [];
    for (let index = 0; index < NEXT_GRID_SIZE * NEXT_GRID_SIZE; index += 1) {
      const cell = document.createElement('span');
      cell.className = 'tetris-next-cell';
      if (filled.has(`${index % NEXT_GRID_SIZE},${Math.floor(index / NEXT_GRID_SIZE)}`)) {
        cell.classList.add('is-filled');
      }
      grid.push(cell);
    }
    nextElement.replaceChildren(...grid);
  }

  function sync(result?: StepResult): void {
    const state = engine.state;

    gameRoot.dataset.status = state.status;
    setText(scoreElement, String(state.score));
    setText(levelElement, String(state.level));
    setText(linesElement, String(state.lines));
    setText(
      speedElement,
      `${(DEFAULT_TETRIS_CONFIG.initialGravityMs / state.gravityMs).toFixed(2)}×`,
    );
    setText(statusElement, STATUS_LABELS[state.status]);
    renderNext(state.next);

    primaryButton.disabled = false;
    restartButton.disabled = false;
    const canPause = state.status === 'running' || state.status === 'paused';
    pauseButton.disabled = !canPause;
    setText(pauseButton, state.status === 'paused' ? '继续' : '暂停');

    overlay.hidden = state.status === 'running';
    if (state.status !== 'running') {
      switch (state.status) {
        case 'ready':
          setText(overlayKicker, 'READY');
          setText(overlayTitle, '堆出你的最高分');
          setText(overlayBody, '方向键 / WASD 移动与旋转，按空格开始；游戏中空格硬降。');
          overlayScore.hidden = true;
          setText(primaryButton, '开始游戏');
          break;
        case 'paused':
          setText(overlayKicker, 'PAUSED');
          setText(overlayTitle, '已暂停');
          setText(overlayBody, '按 P、空格或点击按钮继续。');
          overlayScore.hidden = true;
          setText(primaryButton, '继续游戏');
          break;
        case 'gameover':
          setText(overlayKicker, 'GAME OVER');
          setText(overlayTitle, '堆到顶了');
          setText(overlayBody, '按 R 或点击按钮，再来一局。');
          setText(
            overlayScore,
            `本局 ${state.score} 分 · 等级 ${state.level} · 消行 ${state.lines}`,
          );
          overlayScore.hidden = false;
          setText(primaryButton, '再来一局');
          break;
      }
    }

    if (state.status !== lastStatus) {
      announce(state.status);
      lastStatus = state.status;
      if (state.status === 'gameover') {
        primaryButton.focus({ preventScroll: true });
      }
    }

    if (result === 'cleared') {
      services.audio.play('blip');
    } else if (result === 'gameover') {
      services.audio.play('reset');
    }
  }

  function announce(status: TetrisStatus): void {
    switch (status) {
      case 'paused':
        setText(announcer, '游戏已暂停');
        break;
      case 'gameover':
        setText(announcer, '游戏结束');
        break;
      case 'running':
        setText(announcer, '游戏开始');
        break;
      default:
        break;
    }
  }

  function startRun(): void {
    blurActiveElement();
    scene?.resetRunState();
    engine.start();
    services.audio.unlock();
    services.audio.play('start');
    sync();
  }

  function restartRun(): void {
    engine.restart();
    startRun();
  }

  function pauseToggle(): void {
    if (engine.currentStatus === 'running') {
      engine.pause();
      sync();
    } else if (engine.currentStatus === 'paused') {
      engine.resume();
      services.audio.unlock();
      sync();
    }
  }

  function primaryAction(): void {
    switch (engine.currentStatus) {
      case 'ready':
        startRun();
        break;
      case 'paused':
        engine.resume();
        services.audio.unlock();
        sync();
        break;
      case 'gameover':
        restartRun();
        break;
      default:
        break;
    }
  }

  function performAction(action: TetrisAction): void {
    if (action === 'restart') {
      restartRun();
      return;
    }
    if (action === 'pause') {
      pauseToggle();
      return;
    }

    if (engine.currentStatus === 'ready') {
      startRun();
      // Start the round with Space without also slamming the first piece down.
      if (action === 'hardDrop') {
        return;
      }
    }
    if (engine.currentStatus === 'gameover') {
      if (action === 'hardDrop' || action === 'softDrop') {
        restartRun();
      }
      return;
    }
    if (engine.currentStatus === 'paused') {
      if (action === 'hardDrop') {
        engine.resume();
        services.audio.unlock();
        sync();
      }
      return;
    }
    if (engine.currentStatus !== 'running') {
      return;
    }

    services.audio.unlock();
    switch (action) {
      case 'left':
        engine.moveLeft();
        sync();
        break;
      case 'right':
        engine.moveRight();
        sync();
        break;
      case 'rotate':
        if (engine.rotate()) {
          services.audio.play('blip');
        }
        sync();
        break;
      case 'softDrop':
        engine.softDrop();
        sync();
        break;
      case 'hardDrop': {
        const result = engine.hardDrop();
        if (result && result.clearedLines > 0) {
          scene?.flashClear();
          services.audio.play('blip');
        }
        if (result?.gameOver) {
          services.audio.play('reset');
        }
        sync();
        break;
      }
      default:
        break;
    }
  }

  const [{ createPhaser2DGame }, { TetrisScene: TetrisSceneClass }] = await Promise.all([
    import('../../engine/phaser2d'),
    import('./scene'),
  ]);
  if (mountSignal.aborted) {
    throw abortError();
  }

  let resolveReady: (() => void) | null = null;
  let readyTimer = 0;
  let ready: Promise<void> | null = null;
  let runtime: Phaser2DRuntime | null = null;
  try {
    // Start the boot timeout only after the chunks have arrived: a slow network
    // must not reject a promise that has no handler yet.
    ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      readyTimer = window.setTimeout(() => {
        reject(new Error('The Tetris 2D runtime did not become ready in time.'));
      }, READY_TIMEOUT_MS);
    });
    void ready.catch(() => {});
    const readyPromise = ready;

    scene = new TetrisSceneClass(
      engine,
      {
        onAction: performAction,
        onStep(result) {
          sync(result);
        },
        onReady() {
          window.clearTimeout(readyTimer);
          resolveReady?.();
        },
      },
      services.reduceMotion,
    );

    runtime = createPhaser2DGame({
      parent: boardElement,
      scene,
      ariaLabel: '俄罗斯方块棋盘',
      activePointers: 2,
    });

    await waitForReady(readyPromise, mountSignal);
    if (mountSignal.aborted) {
      throw abortError();
    }
  } catch (error) {
    window.clearTimeout(readyTimer);
    runtime?.destroy();
    throw error;
  }

  const activeRuntime = runtime;
  if (!activeRuntime) {
    window.clearTimeout(readyTimer);
    throw new Error('The Tetris 2D runtime failed to initialize.');
  }

  // The delegated listener handles the overlay primary button, panel buttons
  // and every touch key without one listener per element.
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
      } else if (isTetrisAction(action)) {
        performAction(action);
      }
    },
    { signal: listenerSignal },
  );

  const onVisibilityChange = (): void => {
    if (document.hidden) {
      pausedByVisibility = engine.currentStatus === 'running';
      if (pausedByVisibility) {
        engine.pause();
        sync();
        // The tab is hidden; announce once when it becomes visible again.
        setText(announcer, '');
      }
      activeRuntime.game.loop.sleep();
      return;
    }
    activeRuntime.game.loop.wake();
    if (pausedByVisibility) {
      pausedByVisibility = false;
      announce('paused');
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  const onWindowBlur = (): void => {
    if (engine.currentStatus === 'running') {
      engine.pause();
      sync();
    }
  };
  window.addEventListener('blur', onWindowBlur);

  if (debugEnabled()) {
    debugWindow().__playground = {
      gameId: 'tetris',
      getState: () => engine.state,
    };
  }

  sync();

  let destroyed = false;
  return {
    destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      // Remove these explicitly instead of relying on the abort signal: the
      // shared e2e listener probe tracks add/removeEventListener calls, and
      // signal-driven removal bypasses the patched removeEventListener.
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onWindowBlur);
      controller.abort();
      window.clearTimeout(readyTimer);
      const debug = debugWindow();
      if (debug.__playground?.gameId === 'tetris') {
        delete debug.__playground;
      }
      activeRuntime.destroy();
    },
  };
}

interface TetrisDebugApi {
  gameId: 'tetris';
  getState: () => TetrisSnapshot;
}

/**
 * Test seam. The global `__playground` property is also declared for the snake
 * game, so access it through one shared cast instead of merging a conflicting
 * `Window` declaration.
 */
interface TetrisDebugWindow {
  __playground?: TetrisDebugApi;
}

function debugWindow(): TetrisDebugWindow {
  return window as unknown as TetrisDebugWindow;
}

/** Test seam: enabled on the dev server, or with `?debug=1` in a build. */
function debugEnabled(): boolean {
  if (import.meta.env.DEV) {
    return true;
  }
  const query = window.location.hash.split('?')[1];
  return query ? new URLSearchParams(query).has('debug') : false;
}

/** Query string after the hash route, e.g. `#/games/tetris?debug=1&piece=O`. */
function debugParams(): URLSearchParams {
  const hash = window.location.hash;
  const queryIndex = hash.indexOf('?');
  return new URLSearchParams(
    queryIndex >= 0 ? hash.slice(queryIndex + 1) : window.location.search,
  );
}

function debugEngineOptions(): Pick<TetrisEngineOptions, 'initialBoard' | 'initialPiece'> {
  if (!debugEnabled()) {
    return {};
  }
  const params = debugParams();
  const options: { initialBoard?: Board; initialPiece?: TetrominoType } = {};

  const piece = params.get('piece');
  if (piece && isTetrominoType(piece)) {
    options.initialPiece = piece;
  }

  const board = params.get('board');
  if (board) {
    const parsed = parseDebugBoard(board);
    if (parsed) {
      options.initialBoard = parsed;
    }
  }

  return options;
}

/** Row-major stack with `.` for empty cells and a piece letter for filled ones. */
function parseDebugBoard(raw: string): Board | undefined {
  const rows = raw.split('/');
  if (rows.length !== DEFAULT_TETRIS_CONFIG.height) {
    return undefined;
  }
  const board: (TetrominoType | null)[][] = [];
  for (const row of rows) {
    if (row.length !== DEFAULT_TETRIS_CONFIG.width) {
      return undefined;
    }
    const cells: (TetrominoType | null)[] = [];
    for (const cell of row) {
      if (cell === '.') {
        cells.push(null);
      } else if (isTetrominoType(cell)) {
        cells.push(cell);
      } else {
        return undefined;
      }
    }
    board.push(cells);
  }
  return board;
}

function isTetrominoType(value: string): value is TetrominoType {
  return (TETROMINO_TYPES as readonly string[]).includes(value);
}

