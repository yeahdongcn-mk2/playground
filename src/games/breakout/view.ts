import { query, setText } from '../../core/dom';
import type { GameHandle, GameServices } from '../../core/game';
import { directionFromCode, isEditableTarget } from '../../core/input';
import type { Phaser2DRuntime } from '../../engine/phaser2d';
import {
  BreakoutEngine,
  createSeededRng,
  DEFAULT_BREAKOUT_CONFIG,
  type BreakoutEngineOptions,
  type BreakoutSnapshot,
  type BreakoutStatus,
  type BreakoutUpdate,
  type BrickSpec,
  type InitialBall,
} from './engine';
import { courtXFromClientX } from './geometry';
import type { BreakoutScene } from './scene';
import './breakout.css';

const READY_TIMEOUT_MS = 12_000;

const STATUS_LABELS: Readonly<Record<BreakoutStatus, string>> = {
  ready: '待开始',
  running: '进行中',
  levelclear: '已过关',
  gameover: '已结束',
};

const VIEW_HTML = `
  <section class="breakout-game" data-testid="breakout-game" data-status="loading">
    <div class="game-heading">
      <a class="back-link" href="#/">
        <span aria-hidden="true">←</span> 返回大厅
      </a>
      <div class="game-heading-copy">
        <p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> 2D · 街机 · Phaser 4</p>
        <h1>打砖块 <span>Breakout</span></h1>
      </div>
      <dl class="breakout-hud" aria-label="游戏数据">
        <div class="breakout-stat">
          <dt>得分</dt>
          <dd data-testid="score">0</dd>
        </div>
        <div class="breakout-stat">
          <dt>生命</dt>
          <dd data-testid="lives">3</dd>
        </div>
        <div class="breakout-stat">
          <dt>关卡</dt>
          <dd data-testid="level">1</dd>
        </div>
      </dl>
    </div>

    <div class="breakout-layout">
      <div class="breakout-main">
        <div class="breakout-stage" data-testid="breakout-stage">
          <div class="breakout-board" data-testid="breakout-board"></div>
          <div class="breakout-overlay" data-testid="overlay" role="group" aria-labelledby="breakout-overlay-title">
            <div class="breakout-overlay-card">
              <p class="panel-kicker" data-testid="overlay-kicker">LOADING</p>
              <h2 id="breakout-overlay-title" data-testid="overlay-title">正在准备球场</h2>
              <p class="breakout-overlay-body" data-testid="overlay-body">
                引擎加载中，马上开始。
              </p>
              <p class="breakout-overlay-score" data-testid="overlay-score" hidden></p>
              <button class="button button--primary" type="button" data-action="primary" disabled>
                开始游戏
              </button>
            </div>
          </div>
        </div>

        <p class="breakout-touch-hint" data-testid="touch-hint">
          在球场上拖动或按住左右两侧，挡板会跟着移动。
        </p>
      </div>

      <aside class="breakout-panel" aria-label="操作与状态">
        <div class="panel-card">
          <p class="panel-kicker">CONTROLS</p>
          <h2>操作</h2>
          <dl class="control-list">
            <div>
              <dt>
                <kbd>←</kbd><kbd>→</kbd><span class="key-divider">/</span><kbd>A</kbd><kbd>D</kbd>
              </dt>
              <dd>移动挡板</dd>
            </div>
            <div><dt><kbd>空格</kbd> / <kbd>Enter</kbd></dt><dd>发球 / 继续</dd></div>
            <div><dt><kbd>R</kbd></dt><dd>重新开始</dd></div>
            <div><dt><span class="pointer-glyph" aria-hidden="true"></span> 触屏</dt><dd>在球场上拖动挡板</dd></div>
          </dl>
        </div>

        <div class="panel-card">
          <p class="panel-kicker">STATUS</p>
          <h2>本局</h2>
          <p class="breakout-row"><span>状态</span><strong data-testid="status">待开始</strong></p>
          <p class="breakout-row"><span>球速</span><strong data-testid="speed">320</strong></p>
          <p class="breakout-row"><span>剩余砖块</span><strong data-testid="bricks-left">0</strong></p>
          <div class="panel-actions">
            <button class="button button--ghost" type="button" data-action="restart"
              data-testid="restart-button" disabled>重开</button>
          </div>
        </div>

        <p class="breakout-hint">
          挡板接住小球并弹回，击碎所有砖块过关。每过一关砖块更多、球速更快；漏球扣一条命。
        </p>
        <p class="sr-only" data-testid="announcer" aria-live="polite"></p>
      </aside>
    </div>
  </section>
`;

interface BreakoutDebugApi {
  gameId: 'breakout';
  getState: () => BreakoutSnapshot;
  /** Test seam: destroy the mount without waiting for a route change. */
  destroy: () => void;
}

/**
 * Test seam. `window.__playground` is shared with other games, so use one local
 * cast instead of merging a conflicting global declaration.
 */
interface BreakoutDebugWindow {
  __playground?: BreakoutDebugApi;
}

function debugWindow(): BreakoutDebugWindow {
  return window as unknown as BreakoutDebugWindow;
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

/** Test seam: enabled on the dev server, or with `?debug=1` in a build. */
function debugEnabled(): boolean {
  if (import.meta.env.DEV) {
    return true;
  }
  const hashQuery = window.location.hash.split('?')[1];
  return hashQuery ? new URLSearchParams(hashQuery).has('debug') : false;
}

/** Query string after the hash route, e.g. `#/games/breakout?debug=1&lives=1`. */
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

function readDebugInt(raw: string | null, min: number, max: number): number | undefined {
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

/** `row,col;row,col` in the engine's logical brick grid. */
function parseDebugBricks(raw: string | null): BrickSpec[] | undefined {
  if (!raw) {
    return undefined;
  }
  const specs: BrickSpec[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(';')) {
    const tokens = part.split(',');
    if (tokens.length !== 2) {
      return undefined;
    }
    const row = Number(tokens[0]);
    const col = Number(tokens[1]);
    if (
      !Number.isInteger(row) ||
      !Number.isInteger(col) ||
      row < 0 ||
      row >= DEFAULT_BREAKOUT_CONFIG.brickMaxRows ||
      col < 0 ||
      col >= DEFAULT_BREAKOUT_CONFIG.brickColumns
    ) {
      return undefined;
    }
    const key = `${row},${col}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    specs.push({ row, col });
  }
  return specs.length > 0 ? specs : undefined;
}

/** `x,y,vx,vy` in logical court units. */
function parseDebugBall(raw: string | null): InitialBall | undefined {
  if (!raw) {
    return undefined;
  }
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    return undefined;
  }
  const [x, y, vx, vy] = parts;
  if (x === undefined || y === undefined || vx === undefined || vy === undefined) {
    return undefined;
  }
  // A zero-velocity ball can never hit a brick or fall out, so it would leave
  // the debug game permanently running.
  if (vx === 0 && vy === 0) {
    return undefined;
  }
  return { x, y, vx, vy };
}

function debugEngineOptions(): BreakoutEngineOptions {
  if (!debugEnabled()) {
    return {};
  }
  const params = debugParams();
  const options: {
    rng?: () => number;
    initialLevel?: number;
    lives?: number;
    ballSpeed?: number;
    initialBricks?: BrickSpec[];
    initialBall?: InitialBall;
  } = {};

  const seed = readDebugInt(params.get('seed'), 0, 0xffffffff);
  if (seed !== undefined) {
    options.rng = createSeededRng(seed);
  }
  const level = readDebugInt(params.get('level'), 1, 99);
  if (level !== undefined) {
    options.initialLevel = level;
  }
  const lives = readDebugInt(params.get('lives'), 1, 9);
  if (lives !== undefined) {
    options.lives = lives;
  }
  const speed = readDebugInt(params.get('speed'), 100, DEFAULT_BREAKOUT_CONFIG.maxBallSpeed);
  if (speed !== undefined) {
    options.ballSpeed = speed;
  }
  const bricks = parseDebugBricks(params.get('bricks'));
  if (bricks) {
    options.initialBricks = bricks;
  }
  const ball = parseDebugBall(params.get('ball'));
  if (ball) {
    options.initialBall = ball;
  }
  return options;
}

function createEngine(): BreakoutEngine {
  try {
    return new BreakoutEngine(debugEngineOptions());
  } catch {
    // Invalid debug-only state must never break the normal route.
    return new BreakoutEngine();
  }
}

export async function mountBreakout(
  root: HTMLElement,
  services: GameServices,
  mountSignal: AbortSignal,
): Promise<GameHandle> {
  if (mountSignal.aborted) {
    throw abortError();
  }
  root.innerHTML = VIEW_HTML;

  const gameRoot = query<HTMLElement>(root, '[data-testid="breakout-game"]');
  const boardElement = query<HTMLElement>(root, '[data-testid="breakout-board"]');
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
  const livesElement = query<HTMLElement>(root, '[data-testid="lives"]');
  const levelElement = query<HTMLElement>(root, '[data-testid="level"]');
  const statusElement = query<HTMLElement>(root, '[data-testid="status"]');
  const speedElement = query<HTMLElement>(root, '[data-testid="speed"]');
  const bricksLeftElement = query<HTMLElement>(root, '[data-testid="bricks-left"]');
  const announcer = query<HTMLElement>(root, '[data-testid="announcer"]');

  const engine = createEngine();
  let started = engine.currentStatus !== 'ready';
  let lastStatus: BreakoutStatus = engine.currentStatus;

  const controller = new AbortController();
  const listenerSignal = controller.signal;
  const onMountAbort = (): void => controller.abort();
  mountSignal.addEventListener('abort', onMountAbort, { once: true });

  function sync(): void {
    const state = engine.state;
    if (state.status !== 'running') {
      // A drag captured during play must not keep steering the paddle behind
      // the life-lost / level-clear / game-over overlay.
      dragPointerId = null;
    }
    gameRoot.dataset.status = state.status;
    setText(scoreElement, String(state.score));
    setText(livesElement, String(state.lives));
    setText(levelElement, String(state.level));
    setText(statusElement, STATUS_LABELS[state.status]);
    setText(speedElement, String(Math.round(state.ballSpeed)));
    setText(bricksLeftElement, String(state.bricks.length));

    restartButton.disabled = !started;
    primaryButton.disabled = false;
    overlay.hidden = state.status === 'running';

    if (state.status === 'ready' && !started) {
      setText(overlayKicker, 'READY');
      setText(overlayTitle, '击碎整面砖墙');
      setText(
        overlayBody,
        '← / → 或 A / D 移动挡板，按空格发球。接住小球，打光砖块即可过关。',
      );
      overlayScore.hidden = true;
      setText(primaryButton, '开始游戏');
    } else if (state.status === 'ready') {
      setText(overlayKicker, 'LIFE LOST');
      setText(overlayTitle, '漏球了');
      setText(
        overlayBody,
        `还剩 ${state.lives} 条命。按空格或点击按钮继续发球，挡板会接住下一球。`,
      );
      setText(overlayScore, `本局 ${state.score} 分 · 第 ${state.level} 关`);
      overlayScore.hidden = false;
      setText(primaryButton, '继续发球');
    } else if (state.status === 'levelclear') {
      setText(overlayKicker, 'LEVEL CLEAR');
      setText(overlayTitle, `第 ${state.level} 关清空`);
      setText(overlayBody, '下一关砖块更多、球速更快。按空格或点击按钮继续。');
      setText(
        overlayScore,
        `本局 ${state.score} 分 · 球速 ${Math.round(state.ballSpeed)}`,
      );
      overlayScore.hidden = false;
      setText(primaryButton, `进入第 ${state.level + 1} 关`);
    } else if (state.status === 'gameover') {
      setText(overlayKicker, 'GAME OVER');
      setText(overlayTitle, '生命用完了');
      setText(overlayBody, '按 R 或点击按钮，再来一局。');
      setText(
        overlayScore,
        `本局 ${state.score} 分 · 到达第 ${state.level} 关`,
      );
      overlayScore.hidden = false;
      setText(primaryButton, '再来一局');
    }

    if (state.status !== lastStatus) {
      announce(state.status);
      lastStatus = state.status;
      if (state.status === 'levelclear' || state.status === 'gameover') {
        primaryButton.focus({ preventScroll: true });
      }
    }
  }

  function announce(status: BreakoutStatus): void {
    switch (status) {
      case 'running':
        setText(announcer, '游戏开始');
        break;
      case 'ready':
        if (started) {
          setText(announcer, `漏球了，还剩 ${engine.state.lives} 条命`);
        }
        break;
      case 'levelclear':
        setText(announcer, `第 ${engine.state.level} 关清空`);
        break;
      case 'gameover':
        setText(announcer, '游戏结束，生命用完了');
        break;
    }
  }

  function startRun(): void {
    blurActiveElement();
    if (!engine.start()) {
      sync();
      return;
    }
    started = true;
    services.audio.unlock();
    services.audio.play('start');
    sync();
  }

  function nextLevelRun(): void {
    blurActiveElement();
    if (!engine.nextLevel()) {
      sync();
      return;
    }
    started = true;
    services.audio.unlock();
    services.audio.play('start');
    engine.start();
    sync();
  }

  function restartRun(): void {
    blurActiveElement();
    engine.restart();
    started = engine.currentStatus !== 'ready';
    if (!started) {
      startRun();
      return;
    }
    services.audio.unlock();
    services.audio.play('start');
    sync();
  }

  function primaryAction(): void {
    switch (engine.currentStatus) {
      case 'ready':
        startRun();
        break;
      case 'levelclear':
        nextLevelRun();
        break;
      case 'gameover':
        restartRun();
        break;
      default:
        break;
    }
  }

  function handleStep(result: BreakoutUpdate): void {
    if (result.gameOver || result.lifeLost) {
      services.audio.play('reset');
    } else if (result.levelCleared) {
      services.audio.play('start');
    } else if (result.destroyedBricks.length > 0) {
      services.audio.play('blip');
    }
    sync();
  }

  const held = new Set<'left' | 'right'>();

  function updatePaddleDirection(): void {
    const left = held.has('left');
    const right = held.has('right');
    engine.setPaddleDirection(left === right ? 0 : left ? -1 : 1);
  }

  function releasePaddle(): void {
    held.clear();
    engine.setPaddleDirection(0);
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (isEditableTarget(event.target)) {
      return;
    }

    const direction = directionFromCode(event.code);
    if (direction) {
      if (direction === 'left' || direction === 'right') {
        event.preventDefault();
        held.add(direction);
        updatePaddleDirection();
      }
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : null;
    const focusControl = target?.closest('a[href], button, [role="button"], [role="link"]');

    if (event.code === 'Space' || event.code === 'Enter') {
      // Let a focused link or button keep its native keyboard activation.
      if (focusControl) {
        return;
      }
      event.preventDefault();
      if (!event.repeat) {
        primaryAction();
      }
      return;
    }

    if (event.code === 'KeyR') {
      event.preventDefault();
      if (!event.repeat) {
        restartRun();
      }
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    const direction = directionFromCode(event.code);
    if (direction !== 'left' && direction !== 'right') {
      return;
    }
    held.delete(direction);
    updatePaddleDirection();
  };

  let dragPointerId: number | null = null;
  let windowFocused = true;

  const onWindowBlur = (): void => {
    windowFocused = false;
    releasePaddle();
    dragPointerId = null;
    // Phaser only clamps delta when it loses focus; the game loop itself keeps
    // running, so pause it explicitly or the ball would keep falling while the
    // player cannot reach the keyboard.
    runtime?.game.loop.sleep();
  };

  const onWindowFocus = (): void => {
    windowFocused = true;
    if (!document.hidden) {
      runtime?.game.loop.wake();
    }
  };

  function movePaddleToPointer(event: PointerEvent): void {
    const rect = boardElement.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    engine.movePaddleTo(
      courtXFromClientX(event.clientX, rect, engine.width, engine.height),
    );
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (event.target instanceof Element && event.target.closest('button, a')) {
      return;
    }
    // The overlay covers the court while waiting for a serve; its buttons own
    // that interaction. Once running the court is draggable again.
    if (!overlay.hidden) {
      return;
    }
    dragPointerId = event.pointerId;
    movePaddleToPointer(event);
    try {
      boardElement.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a best-effort enhancement for drags leaving the board.
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (dragPointerId !== event.pointerId || !overlay.hidden) {
      return;
    }
    movePaddleToPointer(event);
  };

  const endPointer = (event: PointerEvent): void => {
    if (dragPointerId === event.pointerId) {
      dragPointerId = null;
    }
  };

  let modules: [typeof import('../../engine/phaser2d'), typeof import('./scene')];
  try {
    modules = await Promise.all([
      import('../../engine/phaser2d'),
      import('./scene'),
    ]);
  } catch (error) {
    mountSignal.removeEventListener('abort', onMountAbort);
    controller.abort();
    throw error;
  }
  if (mountSignal.aborted) {
    mountSignal.removeEventListener('abort', onMountAbort);
    controller.abort();
    throw abortError();
  }
  const [{ createPhaser2DGame }, { BreakoutScene: BreakoutSceneClass }] = modules;

  let resolveReady: (() => void) | null = null;
  let readyTimer = 0;
  let runtime: Phaser2DRuntime | null = null;
  try {
    // Start the boot timeout only after the chunks arrived; a slow network
    // must not reject a promise that has no handler yet.
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      readyTimer = window.setTimeout(() => {
        reject(new Error('The Breakout 2D runtime did not become ready in time.'));
      }, READY_TIMEOUT_MS);
    });
    void ready.catch(() => {});

    const scene: BreakoutScene = new BreakoutSceneClass(
      engine,
      {
        onStep: handleStep,
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
      ariaLabel: '打砖块球场',
      activePointers: 2,
      renderer: debugRenderer(),
    });

    await waitForReady(ready, mountSignal);
    if (mountSignal.aborted) {
      throw abortError();
    }
  } catch (error) {
    window.clearTimeout(readyTimer);
    mountSignal.removeEventListener('abort', onMountAbort);
    controller.abort();
    runtime?.destroy();
    throw error;
  }

  if (!runtime) {
    window.clearTimeout(readyTimer);
    mountSignal.removeEventListener('abort', onMountAbort);
    controller.abort();
    throw new Error('The Breakout 2D runtime failed to initialize.');
  }
  const activeRuntime = runtime;

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
      if (target.dataset.action === 'primary') {
        primaryAction();
      } else if (target.dataset.action === 'restart' && started) {
        restartRun();
      }
    },
    { signal: listenerSignal },
  );

  window.addEventListener('keydown', onKeyDown, { signal: listenerSignal });
  window.addEventListener('keyup', onKeyUp, { signal: listenerSignal });
  window.addEventListener('blur', onWindowBlur, { signal: listenerSignal });
  window.addEventListener('focus', onWindowFocus, { signal: listenerSignal });

  boardElement.addEventListener('pointerdown', onPointerDown, { signal: listenerSignal });
  boardElement.addEventListener('pointermove', onPointerMove, { signal: listenerSignal });
  boardElement.addEventListener('pointerup', endPointer, { signal: listenerSignal });
  boardElement.addEventListener('pointercancel', endPointer, { signal: listenerSignal });
  boardElement.addEventListener('lostpointercapture', endPointer, { signal: listenerSignal });

  const onVisibilityChange = (): void => {
    if (document.hidden) {
      releasePaddle();
      activeRuntime.game.loop.sleep();
    } else if (windowFocused) {
      activeRuntime.game.loop.wake();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange, { signal: listenerSignal });

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    // window key/pointer listeners use listenerSignal; mountSignal is separate.
    mountSignal.removeEventListener('abort', onMountAbort);
    controller.abort();
    window.clearTimeout(readyTimer);
    const debug = debugWindow();
    const api = debug.__playground;
    if (api?.gameId === 'breakout' && api.destroy === destroy) {
      delete debug.__playground;
    }
    activeRuntime.destroy();
  };

  if (debugEnabled()) {
    debugWindow().__playground = {
      gameId: 'breakout',
      getState: () => engine.state,
      destroy,
    };
  }

  sync();

  return { destroy };
}
