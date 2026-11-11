import { query, setText } from '../../core/dom';
import type { GameHandle, GameServices } from '../../core/game';
import type { Phaser2DRuntime } from '../../engine/phaser2d';
import type { Cell, Direction, SnakeStatus, StepResult } from './engine';
import {
  createSeededRng,
  DEFAULT_SNAKE_CONFIG,
  oppositeDirection,
  SnakeEngine,
} from './engine';
import { resolveDebugSeed, resolveDebugTicks } from './debug';
import type { SnakeScene } from './scene';
import './snake.css';

/** Local equivalents of the small DOM helpers this view needs. */
function queryAll<T extends Element>(root: ParentNode, selector: string): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

function blurActiveElement(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    active.blur();
  }
}

const HIGH_SCORE_KEY = 'snake.highscore';
const READY_TIMEOUT_MS = 12_000;

const VIEW_HTML = `
  <section class="snake-game" data-testid="snake-game" data-status="ready">
    <div class="game-heading">
      <a class="back-link" href="#/">
        <span aria-hidden="true">←</span> 返回大厅
      </a>
      <div class="game-heading-copy">
        <p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> 2D · 街机 · Phaser 4</p>
        <h1>贪食蛇 <span>Snake</span></h1>
      </div>
      <dl class="snake-hud" aria-label="游戏数据">
        <div class="snake-stat">
          <dt>得分</dt>
          <dd data-testid="score">0</dd>
        </div>
        <div class="snake-stat">
          <dt>最高分</dt>
          <dd data-testid="best">0</dd>
        </div>
        <div class="snake-stat">
          <dt>长度</dt>
          <dd data-testid="length">3</dd>
        </div>
      </dl>
    </div>

    <div class="snake-layout">
      <div class="snake-main">
        <div class="snake-stage">
          <div class="snake-board" data-testid="snake-board"></div>
          <div class="snake-overlay" data-testid="overlay" role="group" aria-labelledby="snake-overlay-title">
            <div class="snake-overlay-card">
              <p class="panel-kicker" data-testid="overlay-kicker">LOADING</p>
              <h2 id="snake-overlay-title" data-testid="overlay-title">正在准备棋盘</h2>
              <p class="snake-overlay-body" data-testid="overlay-body">
                引擎加载中，马上开始。
              </p>
              <p class="snake-overlay-score" data-testid="overlay-score" hidden></p>
              <button class="button button--primary" type="button" data-action="primary" disabled>
                开始游戏
              </button>
            </div>
          </div>
        </div>

        <div class="snake-touch" data-testid="dpad" role="group" aria-label="触屏方向键">
          <div class="snake-dpad">
            <span></span>
            <button type="button" class="snake-key" data-direction="up" aria-label="向上">↑</button>
            <span></span>
            <button type="button" class="snake-key" data-direction="left" aria-label="向左">←</button>
            <button type="button" class="snake-key snake-key--center"
              data-action="center" data-testid="dpad-center" aria-label="开始或暂停">●</button>
            <button type="button" class="snake-key" data-direction="right" aria-label="向右">→</button>
            <span></span>
            <button type="button" class="snake-key" data-direction="down" aria-label="向下">↓</button>
            <span></span>
          </div>
        </div>
      </div>

      <aside class="snake-panel" aria-label="操作与状态">
        <div class="panel-card">
          <p class="panel-kicker">CONTROLS</p>
          <h2>操作</h2>
          <dl class="control-list">
            <div>
              <dt><kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd><span class="key-divider">/</span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dt>
              <dd>转向</dd>
            </div>
            <div><dt><kbd>空格</kbd> / <kbd>Enter</kbd></dt><dd>开始 / 暂停</dd></div>
            <div><dt><kbd>P</kbd> / <kbd>Esc</kbd></dt><dd>暂停 / 继续</dd></div>
            <div><dt><kbd>R</kbd></dt><dd>重新开始</dd></div>
            <div><dt><span class="pointer-glyph" aria-hidden="true"></span> 触屏</dt><dd>滑动或方向键</dd></div>
          </dl>
        </div>

        <div class="panel-card">
          <p class="panel-kicker">STATUS</p>
          <h2>本局</h2>
          <p class="snake-row"><span>速度</span><strong data-testid="speed">1.00×</strong></p>
          <p class="snake-row"><span>模式</span><strong>经典 · 无尽</strong></p>
          <div class="panel-actions">
            <button class="button button--ghost" type="button" data-action="pause" disabled>暂停</button>
            <button class="button button--ghost" type="button" data-action="restart" disabled>重开</button>
          </div>
        </div>

        <p class="snake-hint">每吃到一个果实都会稍微加速。撞墙或撞到自己，本局结束。</p>
        <p class="sr-only" data-testid="announcer" aria-live="polite"></p>
      </aside>
    </div>
  </section>
`;

function abortError(): DOMException {
  return new DOMException('Game mount aborted', 'AbortError');
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

export async function mountSnake(
  root: HTMLElement,
  services: GameServices,
  mountSignal: AbortSignal,
): Promise<GameHandle> {
  if (mountSignal.aborted) {
    throw abortError();
  }
  root.innerHTML = VIEW_HTML;

  const gameRoot = query<HTMLElement>(root, '[data-testid="snake-game"]');
  const boardElement = query<HTMLElement>(root, '[data-testid="snake-board"]');
  const overlay = query<HTMLElement>(root, '[data-testid="overlay"]');
  const overlayKicker = query<HTMLElement>(root, '[data-testid="overlay-kicker"]');
  const overlayTitle = query<HTMLElement>(root, '[data-testid="overlay-title"]');
  const overlayBody = query<HTMLElement>(root, '[data-testid="overlay-body"]');
  const overlayScore = query<HTMLElement>(root, '[data-testid="overlay-score"]');
  const primaryButton = query<HTMLButtonElement>(
    root,
    '[data-testid="overlay"] [data-action="primary"]',
  );
  const centerDpadButton = query<HTMLButtonElement>(root, '[data-testid="dpad-center"]');
  const pauseButton = query<HTMLButtonElement>(root, '[data-action="pause"]');
  const restartButton = query<HTMLButtonElement>(root, '[data-action="restart"]');
  const scoreElement = query<HTMLElement>(root, '[data-testid="score"]');
  const bestElement = query<HTMLElement>(root, '[data-testid="best"]');
  const lengthElement = query<HTMLElement>(root, '[data-testid="length"]');
  const speedElement = query<HTMLElement>(root, '[data-testid="speed"]');
  const announcer = query<HTMLElement>(root, '[data-testid="announcer"]');

  const engine = (() => {
    // Seed once per mount; restarts reuse the sequence but each page load varies
    // unless the debug `seed` parameter pins it for reproducible captures.
    const seed = debugSeedFromHash();
    const rng = createSeededRng(
      seed ?? ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0),
    );
    const initialFood = debugFoodFromHash();
    if (!initialFood) {
      return new SnakeEngine({ rng });
    }
    try {
      return new SnakeEngine({ rng, initialFood });
    } catch {
      // A debug-only food that overlaps the starting snake is ignored.
      return new SnakeEngine({ rng });
    }
  })();
  const fixedTickCount = debugTicksFromHash();

  let best = services.storage.getNumber(HIGH_SCORE_KEY, 0);
  let runStartBest = best;
  let lastStatus = engine.currentStatus;

  const controller = new AbortController();
  const listenerSignal = controller.signal;
  mountSignal.addEventListener('abort', () => controller.abort(), { once: true });
  let pausedByVisibility = false;
  /**
   * Set once a debug fixed-tick count is requested. It keeps focus / visibility
   * events from waking the loop or pausing the engine before the deterministic
   * screenshot state has been advanced and frozen.
   */
  let debugTicksPaused = false;

  function sync(result?: StepResult): void {
    const state = engine.state;

    if (state.score > best) {
      best = state.score;
      services.storage.set(HIGH_SCORE_KEY, best);
    }

    gameRoot.dataset.status = state.status;
    setText(scoreElement, String(state.score));
    setText(bestElement, String(best));
    setText(lengthElement, String(state.snake.length));
    setText(speedElement, `${(state.baseStepMs / state.stepMs).toFixed(2)}×`);

    const settled = state.status === 'ready' || state.status === 'gameover' || state.status === 'won';
    primaryButton.disabled = false;
    restartButton.disabled = state.status === 'ready';
    pauseButton.disabled = settled;
    centerDpadButton.setAttribute(
      'aria-label',
      state.status === 'ready'
        ? '开始游戏'
        : state.status === 'running'
          ? '暂停'
          : state.status === 'paused'
            ? '继续'
            : '再来一局',
    );
    pauseButton.textContent = state.status === 'paused' ? '继续' : '暂停';

    overlay.hidden = state.status === 'running';
    if (state.status !== 'running') {
      const isNewRecord = state.score > runStartBest && state.score > 0;
      switch (state.status) {
        case 'ready':
          setText(overlayKicker, 'READY');
          setText(overlayTitle, '吃掉果实，别撞墙');
          setText(overlayBody, '方向键 / WASD 控制方向；空格开始。');
          overlayScore.hidden = true;
          primaryButton.textContent = '开始游戏';
          break;
        case 'paused':
          setText(overlayKicker, 'PAUSED');
          setText(overlayTitle, '已暂停');
          setText(overlayBody, '按空格、P 或点击按钮继续。');
          overlayScore.hidden = true;
          primaryButton.textContent = '继续游戏';
          break;
        case 'gameover':
          setText(overlayKicker, 'GAME OVER');
          setText(overlayTitle, isNewRecord ? '新纪录！' : '撞上了');
          setText(
            overlayBody,
            isNewRecord ? '这局刷新了你的最高分。' : '再来一局，冲一次最高分。',
          );
          setText(overlayScore, `本局 ${state.score} 分 · 最高 ${best} 分`);
          overlayScore.hidden = false;
          primaryButton.textContent = '再来一局';
          break;
        case 'won':
          setText(overlayKicker, 'PERFECT');
          setText(overlayTitle, '全盘制胜');
          setText(overlayBody, '棋盘被填满了，真正的贪食蛇大师。');
          setText(overlayScore, `本局 ${state.score} 分 · 最高 ${best} 分`);
          overlayScore.hidden = false;
          primaryButton.textContent = '再来一局';
          break;
      }
    }

    if (state.status === 'gameover' || state.status === 'won') {
      primaryButton.focus({ preventScroll: true });
    }

    if (state.status !== lastStatus) {
      announce(state.status);
      lastStatus = state.status;
    }

    if (result === 'ate') {
      services.audio.play('blip');
    } else if (result === 'died') {
      services.audio.play('reset');
    } else if (result === 'won') {
      services.audio.play('start');
    }
  }

  function announce(status: SnakeStatus): void {
    switch (status) {
      case 'paused':
        setText(announcer, '游戏已暂停');
        break;
      case 'gameover':
        setText(announcer, '游戏结束');
        break;
      case 'won':
        setText(announcer, '你赢了，棋盘已被填满');
        break;
      case 'running':
        setText(announcer, '游戏开始');
        break;
      default:
        break;
    }
  }

  function beginRun(turn?: Direction): void {
    blurActiveElement();
    scene?.resetRunState();
    engine.start();
    runStartBest = best;
    if (turn) {
      engine.turn(turn);
    }
    services.audio.unlock();
    services.audio.play('start');
    if (fixedTickCount !== undefined) {
      debugTicksPaused = true;
      // The loop may be asleep after a visibility change; wake it so the next
      // frame can advance the fixed ticks.
      runtime?.game.loop.wake();
      scene?.requestFixedTicks(fixedTickCount);
    }
    sync();
  }

  function startRun(): void {
    beginRun();
  }

  function restartRun(): void {
    engine.restart();
    beginRun();
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
      case 'running':
        pauseGame();
        break;
      case 'gameover':
      case 'won':
        restartRun();
        break;
    }
  }

  function pauseGame(): void {
    blurActiveElement();
    engine.pause();
    services.audio.play('blip');
    sync();
  }

  function pauseToggle(): void {
    blurActiveElement();
    if (engine.currentStatus === 'running') {
      pauseGame();
    } else if (engine.currentStatus === 'paused') {
      engine.resume();
      sync();
    }
  }

  function handleDirection(direction: Direction): void {
    if (engine.currentStatus === 'ready') {
      // The starting snake points right and its body is to the left, so a
      // 180-degree first turn is impossible; do not start just to ignore it.
      if (direction === oppositeDirection(engine.state.direction)) {
        return;
      }
      beginRun(direction);
      return;
    }
    if (engine.currentStatus === 'running') {
      engine.turn(direction);
    }
  }

  const [{ createPhaser2DGame }, { SnakeScene: SnakeSceneClass }] = await Promise.all([
    import('../../engine/phaser2d'),
    import('./scene'),
  ]);
  if (mountSignal.aborted) {
    throw abortError();
  }

  let resolveReady: (() => void) | null = null;
  let readyTimer = 0;
  let ready: Promise<void> | null = null;
  let scene: SnakeScene | null = null;
  let runtime: Phaser2DRuntime | null = null;
  try {
    // Start the boot timeout only after the chunks have arrived: a slow network
    // must not reject a promise that has no handler yet.
    ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      readyTimer = window.setTimeout(() => {
        reject(new Error('The Snake 2D runtime did not become ready in time.'));
      }, READY_TIMEOUT_MS);
    });
    void ready.catch(() => {});
    const readyPromise = ready;

    scene = new SnakeSceneClass(
      engine,
      {
        onStep(result) {
          sync(result);
        },
        onDirection: handleDirection,
        onPrimaryAction: primaryAction,
        onPauseToggle: pauseToggle,
        onRestart: restartRun,
        onReady() {
          window.clearTimeout(readyTimer);
          resolveReady?.();
        },
        onFixedTicks(ticks) {
          sync();
          // The capture script waits for this marker, so it can never snapshot
          // a half-advanced fixed-tick sequence.
          gameRoot.dataset.debugTicks = String(ticks);
        },
      },
      services.reduceMotion,
    );

    runtime = createPhaser2DGame({
      parent: boardElement,
      scene,
      ariaLabel: '贪食蛇棋盘',
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

  if (!runtime) {
    window.clearTimeout(readyTimer);
    throw new Error('The Snake 2D runtime failed to initialize.');
  }
  const activeRuntime = runtime;

  primaryButton.addEventListener('click', primaryAction, { signal: listenerSignal });
  pauseButton.addEventListener('click', pauseToggle, { signal: listenerSignal });
  restartButton.addEventListener('click', restartRun, { signal: listenerSignal });

  for (const button of queryAll<HTMLButtonElement>(root, '[data-direction]')) {
    button.addEventListener(
      'click',
      () => {
        const direction = button.dataset.direction as Direction | undefined;
        if (direction) {
          handleDirection(direction);
        }
      },
      { signal: listenerSignal },
    );
  }

  centerDpadButton.addEventListener('click', primaryAction, { signal: listenerSignal });

  bindSwipe(boardElement, handleDirection, listenerSignal);

  const onVisibilityChange = (): void => {
    if (debugTicksPaused) {
      return;
    }
    if (document.hidden) {
      pausedByVisibility = engine.currentStatus === 'running';
      if (engine.currentStatus === 'running') {
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
  document.addEventListener('visibilitychange', onVisibilityChange, { signal: listenerSignal });

  const onWindowBlur = (): void => {
    if (!debugTicksPaused && engine.currentStatus === 'running') {
      engine.pause();
      sync();
    }
  };
  window.addEventListener('blur', onWindowBlur, { signal: listenerSignal });

  if (debugEnabled()) {
    window.__playground = {
      gameId: 'snake',
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
      controller.abort();
      window.clearTimeout(readyTimer);
      if (window.__playground?.gameId === 'snake') {
        delete window.__playground;
      }
      activeRuntime.destroy();
    },
  };
}

/** Test seam: enabled on the dev server, or with `?debug=1` in a build. */
function debugEnabled(): boolean {
  if (import.meta.env.DEV) {
    return true;
  }
  const query = window.location.hash.split('?')[1];
  return query ? new URLSearchParams(query).has('debug') : false;
}

/** Query string after the hash route, e.g. `#/games/snake?debug=1&food=11,10`. */
function debugParams(): URLSearchParams {
  const hash = window.location.hash;
  const queryIndex = hash.indexOf('?');
  return new URLSearchParams(
    queryIndex >= 0 ? hash.slice(queryIndex + 1) : window.location.search,
  );
}

/** Test seam used by Playwright to pin the next-fruit RNG deterministically. */
function debugSeedFromHash(): number | undefined {
  if (!debugEnabled()) {
    return undefined;
  }
  return resolveDebugSeed(debugParams().get('seed'));
}

/** Test seam used by screenshots to freeze the run after a fixed tick count. */
function debugTicksFromHash(): number | undefined {
  if (!debugEnabled()) {
    return undefined;
  }
  return resolveDebugTicks(debugParams().get('ticks'));
}

/** Test seam used by Playwright to place the first fruit deterministically. */
function debugFoodFromHash(): Cell | undefined {
  if (!debugEnabled()) {
    return undefined;
  }
  const raw = debugParams().get('food');
  if (!raw) {
    return undefined;
  }
  const [x, y] = raw.split(',').map(Number);
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x === undefined ||
    y === undefined ||
    x < 0 ||
    y < 0 ||
    x >= DEFAULT_SNAKE_CONFIG.width ||
    y >= DEFAULT_SNAKE_CONFIG.height
  ) {
    return undefined;
  }
  return { x, y };
}


function bindSwipe(
  target: HTMLElement,
  onDirection: (direction: Direction) => void,
  listenerSignal: AbortSignal,
): void {
  let origin: { x: number; y: number } | null = null;
  const threshold = 24;

  target.addEventListener(
    'pointerdown',
    (event) => {
      origin = { x: event.clientX, y: event.clientY };
    },
    { signal: listenerSignal },
  );

  target.addEventListener(
    'pointerup',
    (event) => {
      if (!origin) {
        return;
      }
      const dx = event.clientX - origin.x;
      const dy = event.clientY - origin.y;
      origin = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) {
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

  target.addEventListener(
    'pointercancel',
    () => {
      origin = null;
    },
    { signal: listenerSignal },
  );
}
