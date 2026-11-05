import Phaser from 'phaser';

/**
 * Shared 2D runtime adapter.
 *
 * Phaser already owns the main loop, scene manager, loader, input and renderer.
 * This adapter only unifies the parts every game should configure the same way:
 * the parent element, responsive RESIZE scaling, pointer count, accessibility
 * attributes and deterministic teardown. It is loaded lazily with the 2D game
 * chunk, never by the app shell.
 */
export interface Phaser2DConfig {
  readonly parent: HTMLElement;
  readonly scene: Phaser.Scene;
  readonly backgroundColor?: string;
  readonly activePointers?: number;
  readonly ariaLabel?: string;
}

export interface Phaser2DRuntime {
  readonly game: Phaser.Game;
  destroy(): void;
}

const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 480;

export function createPhaser2DGame(config: Phaser2DConfig): Phaser2DRuntime {
  const { parent } = config;
  const width = Math.max(1, Math.round(parent.clientWidth || FALLBACK_WIDTH));
  const height = Math.max(1, Math.round(parent.clientHeight || FALLBACK_HEIGHT));
  // Phaser 4's VisibilityHandler assigns process-global handlers and does not
  // clear them in Game.destroy. Capture the document listener while Phaser
  // boots, and remember the window handlers so teardown can restore them.
  const previousOnBlur = window.onblur;
  const previousOnFocus = window.onfocus;
  const capturedVisibility: Array<{
    readonly type: string;
    readonly listener: EventListenerOrEventListenerObject;
  }> = [];
  const originalDocumentAdd = document.addEventListener as typeof document.addEventListener;
  const originalDocumentRemove = document.removeEventListener as typeof document.removeEventListener;
  const patchedDocumentAdd = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === 'visibilitychange' || type === 'webkitvisibilitychange') {
      capturedVisibility.push({ type, listener });
    }
    originalDocumentAdd.call(document, type, listener, options);
  }) as typeof document.addEventListener;
  document.addEventListener = patchedDocumentAdd;

  const restoreDocumentAdd = (): void => {
    if (document.addEventListener === patchedDocumentAdd) {
      document.addEventListener = originalDocumentAdd;
    }
  };

  let game: Phaser.Game;
  try {
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      width,
      height,
      backgroundColor: config.backgroundColor ?? '#070b14',
      banner: false,
      autoFocus: false,
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width,
        height,
        autoRound: true,
        expandParent: false,
      },
      input: {
        activePointers: config.activePointers ?? 3,
      },
      render: {
        antialias: true,
        roundPixels: false,
        powerPreference: 'high-performance',
      },
      scene: [config.scene],
    });
  } catch (error) {
    restoreDocumentAdd();
    for (const { type, listener } of capturedVisibility) {
      originalDocumentRemove.call(document, type, listener);
    }
    capturedVisibility.length = 0;
    window.onblur = previousOnBlur;
    window.onfocus = previousOnFocus;
    throw error;
  }

  if (game.isRunning) {
    restoreDocumentAdd();
  } else {
    // READY fires just before Game.start(), and start() installs the visibility
    // handler; restore after that synchronous work, in a later microtask.
    game.events.once(Phaser.Core.Events.READY, () => queueMicrotask(restoreDocumentAdd));
  }

  game.canvas.setAttribute('data-testid', 'game-canvas');
  game.canvas.setAttribute('aria-label', config.ariaLabel ?? '游戏画布');
  game.canvas.setAttribute('role', 'img');

  // RESIZE mode reacts to window resizes on its own. Observe the real mount
  // container too, so sidebars, orientation changes and split panes adapt.
  let frame = 0;
  let destroyed = false;
  const refresh = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!destroyed && game.isBooted && parent.clientWidth > 0 && parent.clientHeight > 0) {
        // ScaleManager.refresh() reuses its cached parent size; measure first so
        // container-only resizes (sidebars, split panes) are not ignored.
        game.scale.getParentBounds();
        game.scale.refresh();
      }
    });
  };

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
  observer?.observe(parent);
  window.addEventListener('orientationchange', refresh);

  return {
    game,
    destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('orientationchange', refresh);
      restoreDocumentAdd();
      for (const { type, listener } of capturedVisibility) {
        originalDocumentRemove.call(document, type, listener);
      }
      capturedVisibility.length = 0;
      game.scale.removeAllListeners();
      game.destroy(true);
      if (game.isBooted) {
        // Game.destroy() only schedules runDestroy() for the next game step. If
        // the loop is asleep (hidden tab, explicit pause), wake it so teardown
        // still runs instead of leaving the scene and its listeners alive.
        game.loop.wake();
      }
      if (window.onblur !== previousOnBlur) {
        window.onblur = previousOnBlur;
      }
      if (window.onfocus !== previousOnFocus) {
        window.onfocus = previousOnFocus;
      }
    },
  };
}
