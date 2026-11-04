import Phaser from 'phaser';
import { query, queryAll, setText } from '../../core/dom';
import type { GameHandle, GameServices } from '../../core/game';
import type { Cell, Direction, SnakeStatus, StepResult } from './engine';
import { createSeededRng, DEFAULT_SNAKE_CONFIG, SnakeEngine } from './engine';
import { SnakeScene } from './scene';

import './debug';

const HIGH_SCORE_KEY = 'snake.highscore';
const VIEW_HTML = `
  <section class="game-page" data-testid="snake-game" data-status="ready">
    <div class="game-topbar">
      <a class="back-link" href="#/" data-action="back">
        <span aria-hidden="true">←</span> 全部游戏
      </a>
      <div class="game-title">
        <p class="eyebrow">2D · 街机 · Phaser 4</p>
        <h1>贪食蛇 <span>Snake</span></h1>
      </div>
      <div class="hud" role="group" aria-label="游戏数据">
        <div class="hud-item">
          <span>得分</span>
          <strong data-testid="score">0</strong>
        </div>
        <div class="hud-item">
          <span>最高分</span>
          <strong data-testid="best">0</strong>
        </div>
        <div class="hud-item">
          <span>长度</span>
          <strong data-testid="length">3</strong>
        </div>
      </div>
    </div>

    <div class="game-stage">
      <div class="board-column">
        <div class="board-shell">
          <div class="board" data-testid="snake-board" role="group" aria-label="贪食蛇游戏区"></div>
          <div class="game-overlay" data-testid="overlay">
            <div class="overlay-card">
              <p class="overlay-kicker" data-overlay-kicker data-testid="overlay-kicker">READY</p>
              <h2 data-overlay-title data-testid="overlay-title">吃掉果实，别撞墙</h2>
              <p class="overlay-body" data-overlay-body data-testid="overlay-body">方向键 / WASD 控制方向；空格开始。</p>
              <p class="overlay-score" data-overlay-score data-testid="overlay-score" hidden></p>
              <button class="button button--primary" type="button" data-action="primary">
                开始游戏
              </button>
            </div>
          </div>
        </div>

        <div class="touch-controls" data-testid="dpad" role="group" aria-label="触屏方向键">
          <div class="dpad-grid">
            <span></span>
            <button type="button" class="dpad-button" data-direction="up" aria-label="向上">↑</button>
            <span></span>
            <button type="button" class="dpad-button" data-direction="left" aria-label="向左">←</button>
            <button type="button" class="dpad-button dpad-button--center" data-action="primary" aria-label="开始或暂停">●</button>
            <button type="button" class="dpad-button" data-direction="right" aria-label="向右">→</button>
            <span></span>
            <button type="button" class="dpad-button" data-direction="down" aria-label="向下">↓</button>
            <span></span>
          </div>
        </div>
      </div>

      <aside class="game-side" aria-label="游戏说明与操作">
        <div class="side-card">
          <h2>操作</h2>
          <dl class="key-list">
            <div><dt><kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd></dt><dd>转向</dd></div>
            <div><dt><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dt><dd>转向</dd></div>
            <div><dt><kbd>空格</kbd></dt><dd>开始 / 暂停</dd></div>
            <div><dt><kbd>P</kbd> / <kbd>Esc</kbd></dt><dd>暂停</dd></div>
            <div><dt><kbd>R</kbd></dt><dd>重新开始</dd></div>
          </dl>
        </div>

        <div class="side-card">
          <h2>状态</h2>
          <p class="stat-row"><span>速度</span><strong data-testid="speed">1.00×</strong></p>
          <p class="stat-row"><span>模式</span><strong>经典 · 无尽</strong></p>
          <div class="side-actions">
            <button class="button button--ghost" type="button" data-action="pause">暂停</button>
            <button class="button button--ghost" type="button" data-action="restart">重开</button>
          </div>
        </div>

        <p class="side-hint">每吃到一个果实都会稍微加速。撞墙或撞到自己，本局结束。</p>
      </aside>
    </div>

    <p class="sr-only" data-testid="announcer" aria-live="polite"></p>
  </section>
`;

export async function mountSnake(root: HTMLElement, services: GameServices): Promise<GameHandle> {
  root.innerHTML = VIEW_HTML;

  const gameRoot = query<HTMLElement>(root, '[data-testid="snake-game"]');
  const boardElement = query<HTMLElement>(root, '[data-testid="snake-board"]');
  const overlay = query<HTMLElement>(root, '[data-testid="overlay"]');
  const overlayKicker = query<HTMLElement>(root, '[data-overlay-kicker]');
  const overlayTitle = query<HTMLElement>(root, '[data-overlay-title]');
  const overlayBody = query<HTMLElement>(root, '[data-overlay-body]');
  const overlayScore = query<HTMLElement>(root, '[data-overlay-score]');
  const primaryButton = query<HTMLButtonElement>(root, '[data-action="primary"]');
  const pauseButton = query<HTMLButtonElement>(root, '[data-action="pause"]');
  const scoreElement = query<HTMLElement>(root, '[data-testid="score"]');
  const bestElement = query<HTMLElement>(root, '[data-testid="best"]');
  const lengthElement = query<HTMLElement>(root, '[data-testid="length"]');
  const speedElement = query<HTMLElement>(root, '[data-testid="speed"]');
  const announcer = query<HTMLElement>(root, '[data-testid="announcer"]');

  const engine = (() => {
    // Seed once per mount; restarts reuse the sequence but each page load varies.
    const rng = createSeededRng((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
    const initialFood = debugFoodFromQuery();
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
  let best = services.storage.getNumber(HIGH_SCORE_KEY, 0);
  let runStartBest = best;
  let lastStatus = engine.currentStatus;

  const controller = new AbortController();
  const signal = controller.signal;

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

    pauseButton.disabled =
      state.status === 'ready' || state.status === 'gameover' || state.status === 'won';
    pauseButton.textContent = state.status === 'paused' ? '继续' : '暂停';

    const running = state.status === 'running';
    overlay.hidden = running;
    if (!running) {
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
          setText(overlayTitle, '暂停中');
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

    if (state.status !== lastStatus) {
      announce(state.status);
      lastStatus = state.status;
    }

    if (result === 'ate') {
      services.audio.play('eat');
    } else if (result === 'died') {
      services.audio.play('die');
    } else if (result === 'won') {
      services.audio.play('win');
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

  function startRun(): void {
    blurActiveElement();
    scene.resetRunState();
    engine.start();
    runStartBest = best;
    services.audio.play('start');
    sync();
  }

  function restartRun(): void {
    blurActiveElement();
    engine.restart();
    scene.resetRunState();
    engine.start();
    runStartBest = best;
    services.audio.play('start');
    sync();
  }

  function primaryAction(): void {
    switch (engine.currentStatus) {
      case 'ready':
        startRun();
        break;
      case 'paused':
        engine.resume();
        services.audio.play('start');
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
    services.audio.play('pause');
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
      scene.resetRunState();
      engine.start();
      runStartBest = best;
      services.audio.play('start');
      engine.turn(direction);
      sync();
      return;
    }
    if (engine.currentStatus === 'running') {
      engine.turn(direction);
    }
  }

  const scene = new SnakeScene(engine, {
    onStep(result) {
      sync(result);
    },
    onDirection: handleDirection,
    onPrimaryAction: primaryAction,
    onPauseToggle: pauseToggle,
    onRestart: restartRun,
  });

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: boardElement,
    width: 640,
    height: 640,
    backgroundColor: '#070b14',
    banner: false,
    autoFocus: false,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: 640,
      height: 640,
    },
    scene: [scene],
    render: { antialias: true, roundPixels: false },
  });

  game.canvas.setAttribute('data-testid', 'snake-canvas');
  game.canvas.setAttribute('role', 'img');
  game.canvas.setAttribute('aria-label', '贪食蛇棋盘');

  primaryButton.addEventListener('click', primaryAction, { signal });
  pauseButton.addEventListener('click', pauseToggle, { signal });
  query<HTMLButtonElement>(root, '[data-action="restart"]').addEventListener(
    'click',
    restartRun,
    { signal },
  );

  for (const button of queryAll<HTMLButtonElement>(root, '[data-direction]')) {
    button.addEventListener(
      'click',
      () => {
        const direction = button.dataset.direction as Direction | undefined;
        if (direction) {
          handleDirection(direction);
        }
      },
      { signal },
    );
  }

  const centerDpadButton = query<HTMLButtonElement>(
    root,
    '.dpad-button--center[data-action="primary"]',
  );
  centerDpadButton.addEventListener('click', primaryAction, { signal });

  bindSwipe(boardElement, handleDirection, signal);

  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden && engine.currentStatus === 'running') {
        engine.pause();
        sync();
      }
    },
    { signal },
  );

  if (import.meta.env.DEV) {
    window.__playground = {
      gameId: 'snake',
      getState: () => engine.state,
    };
  }

  sync();

  return {
    destroy(): void {
      controller.abort();
      if (window.__playground?.gameId === 'snake') {
        delete window.__playground;
      }
      game.destroy(true);
    },
  };
}

/** Dev-only seam used by Playwright to place the first fruit deterministically. */
function debugFoodFromQuery(): Cell | undefined {
  if (!import.meta.env.DEV) {
    return undefined;
  }
  const raw = new URLSearchParams(window.location.search).get('food');
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

function blurActiveElement(): void {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

function bindSwipe(
  target: HTMLElement,
  onDirection: (direction: Direction) => void,
  signal: AbortSignal,
): void {
  let origin: { x: number; y: number } | null = null;
  const threshold = 24;

  target.addEventListener(
    'pointerdown',
    (event) => {
      origin = { x: event.clientX, y: event.clientY };
    },
    { signal },
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
    { signal },
  );

  target.addEventListener('pointercancel', () => {
    origin = null;
  }, { signal });
}
