import { query, setText } from '../../core/dom';
import type { GameHandle, GameServices } from '../../core/game';
import type { Phaser2DRuntime } from '../../engine/phaser2d';
import type { BlankScene, BlankState } from './scene';

const READY_TIMEOUT_MS = 12_000;

const VIEW_HTML = `
  <section class="blank-game" data-testid="blank-game">
    <div class="game-heading">
      <a class="back-link" href="#/">
        <span aria-hidden="true">←</span> 返回大厅
      </a>
      <div class="game-heading-copy">
        <p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> 2D · 框架演示</p>
        <h1>空白画布 <span>Blank Canvas</span></h1>
      </div>
      <p class="route-pill" aria-label="当前路由">#/games/blank</p>
    </div>

    <div class="blank-layout">
      <div class="blank-stage" data-testid="blank-stage">
        <div class="blank-canvas" data-testid="blank-canvas-host"></div>
        <div class="blank-overlay" data-testid="blank-loading" role="status">
          <span class="spinner" aria-hidden="true"></span>
          <p>正在准备画布…</p>
        </div>
        <div class="blank-hud" aria-hidden="true">
          <p class="hud-label">POSITION</p>
          <p class="hud-readout" data-testid="readout" data-x="0" data-y="0">x 0 · y 0</p>
          <p class="hud-meta">
            输入 <strong data-testid="input-mode">待机</strong>
            <span aria-hidden="true">·</span>
            视口 <span data-testid="viewport">…</span>
          </p>
        </div>
      </div>

      <aside class="blank-panel" aria-labelledby="blank-controls-title">
        <div class="panel-card">
          <p class="panel-kicker">CONTROLS</p>
          <h2 id="blank-controls-title">操作</h2>
          <dl class="control-list">
            <div>
              <dt>
                <kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd>
                <span class="key-divider">/</span>
                <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
              </dt>
              <dd>移动光标</dd>
            </div>
            <div>
              <dt><span class="pointer-glyph" aria-hidden="true"></span> 鼠标 / 触屏</dt>
              <dd>点击或拖动</dd>
            </div>
          </dl>
        </div>

        <div class="panel-card">
          <p class="panel-kicker">IN THIS DEMO</p>
          <h2>本次演示</h2>
          <ul class="check-list">
            <li>Phaser 主循环与场景生命周期</li>
            <li>SVG 资源预加载与失败回退</li>
            <li>键盘、指针与触屏统一输入</li>
            <li>容器级响应式画布</li>
          </ul>
          <div class="panel-actions">
            <button class="button button--primary" type="button" data-action="reset" data-testid="reset">
              重置位置
            </button>
            <a class="button button--ghost" href="#/">返回大厅</a>
          </div>
        </div>

        <p class="panel-status" data-testid="game-status" role="status">正在启动…</p>
        <p class="sr-only" data-testid="announcer" aria-live="polite"></p>
        <p class="panel-footnote">画布随容器尺寸变化；页面隐藏时主循环自动休眠。</p>
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

export async function mountBlankGame(
  root: HTMLElement,
  services: GameServices,
  signal: AbortSignal,
): Promise<GameHandle> {
  if (signal.aborted) {
    throw abortError();
  }
  root.innerHTML = VIEW_HTML;

  const stage = query<HTMLElement>(root, '[data-testid="blank-stage"]');
  const canvasHost = query<HTMLElement>(root, '[data-testid="blank-canvas-host"]');
  const loading = query<HTMLElement>(root, '[data-testid="blank-loading"]');
  const readout = query<HTMLElement>(root, '[data-testid="readout"]');
  const inputMode = query<HTMLElement>(root, '[data-testid="input-mode"]');
  const viewport = query<HTMLElement>(root, '[data-testid="viewport"]');
  const status = query<HTMLElement>(root, '[data-testid="game-status"]');
  const announcer = query<HTMLElement>(root, '[data-testid="announcer"]');
  const resetButton = query<HTMLButtonElement>(root, '[data-action="reset"]');

  const controller = new AbortController();

  function renderState(state: BlankState): void {
    readout.dataset.x = String(state.x);
    readout.dataset.y = String(state.y);
    setText(readout, `x ${state.x} · y ${state.y}`);
    setText(
      inputMode,
      state.mode === 'keyboard' ? '键盘' : state.mode === 'pointer' ? '指针 / 触屏' : '待机',
    );
    setText(viewport, `${state.width} × ${state.height}`);
  }

  let resolveReady: (() => void) | null = null;
  let readyTimer = 0;
  let ready: Promise<void> | null = null;
  let scene: BlankScene | null = null;
  let runtime: Phaser2DRuntime | null = null;
  try {
    const [{ createPhaser2DGame }, { BlankScene: SceneClass }] = await Promise.all([
      import('../../engine/phaser2d'),
      import('./scene'),
    ]);
    if (signal.aborted) {
      throw abortError();
    }

    // Start the boot timeout only after the chunks have arrived: a slow network
    // should not reject a promise that has no handler yet.
    ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      readyTimer = window.setTimeout(() => {
        reject(new Error('The 2D runtime did not become ready in time.'));
      }, READY_TIMEOUT_MS);
    });
    void ready.catch(() => {});
    const readyPromise = ready;

    scene = new SceneClass(
      {
        onReady: () => {
          window.clearTimeout(readyTimer);
          resolveReady?.();
        },
        onState: renderState,
        onFirstInput: () => {
          services.audio.unlock();
          services.audio.play('start');
        },
      },
      services.reduceMotion,
    );

    runtime = createPhaser2DGame({
      parent: canvasHost,
      scene,
      ariaLabel: '空白游戏画布：用方向键或拖动指针移动光标',
    });

    await waitForReady(readyPromise, signal);
    if (signal.aborted) {
      throw abortError();
    }
  } catch (error) {
    window.clearTimeout(readyTimer);
    runtime?.destroy();
    throw error;
  }

  const activeScene = scene;
  const activeRuntime = runtime;
  if (!activeScene || !activeRuntime) {
    window.clearTimeout(readyTimer);
    runtime?.destroy();
    throw new Error('The 2D runtime did not initialise.');
  }

  loading.hidden = true;
  stage.dataset.state = 'ready';
  setText(status, '资源就绪 · 画布可交互');

  const onVisibilityChange = (): void => {
    if (document.hidden) {
      activeRuntime.game.loop.sleep();
      setText(status, '已暂停 · 页面不可见');
      return;
    }
    activeRuntime.game.loop.wake();
    setText(status, '运行中 · 画布可交互');
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  resetButton.addEventListener(
    'click',
    () => {
      activeScene.reset();
      services.audio.play('reset');
      setText(status, '位置已重置');
      announcer.textContent = '光标已回到画布中心';
      resetButton.focus({ preventScroll: true });
    },
    { signal: controller.signal },
  );

  return {
    destroy(): void {
      controller.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearTimeout(readyTimer);
      activeRuntime.destroy();
    },
  };
}
