import Phaser from 'phaser';
import { directionFromCode, isEditableTarget } from '../../core/input';
import type { Direction, SnakeEngine, SnakeSnapshot, StepResult } from './engine';
import { advanceFixedTicks } from './fixed-ticks';

const COLORS = {
  canvas: 0x070b14,
  board: 0x0b1526,
  grid: 0x16263f,
  border: 0x263a58,
  head: 0xd9f99d,
  bodyStart: 0xa3e635,
  bodyEnd: 0x4d7c0f,
  eye: 0x0a101d,
  food: 0xfb7185,
  foodGlow: 0xfb7185,
  leaf: 0x4ade80,
} as const;

export interface SnakeSceneCallbacks {
  onStep(result: StepResult): void;
  onDirection(direction: Direction): void;
  onPrimaryAction(): void;
  onPauseToggle(): void;
  onRestart(): void;
  onReady?(): void;
  /** Fired after a debug fixed-tick capture sequence has been advanced. */
  onFixedTicks?(ticks: number): void;
}

interface BoardMetrics {
  readonly size: number;
  readonly pad: number;
  readonly board: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly cellW: number;
  readonly cellH: number;
}

/**
 * Phaser presentation layer. It owns drawing and keyboard input only; every
 * rule lives in SnakeEngine so the game stays testable without a browser.
 *
 * The canvas is driven by the shared RESIZE adapter, so all geometry is derived
 * from the current scale on every draw instead of a fixed logical size.
 */
export class SnakeScene extends Phaser.Scene {
  private readonly engine: SnakeEngine;
  private readonly callbacks: SnakeSceneCallbacks;
  private readonly reduceMotion: boolean;
  /**
   * Phaser keeps a native keyboard event in its queue until the next game step's
   * postUpdate, and can dispatch that same event again if another key arrives
   * within the same frame. Remembering native events avoids double-handling
   * (e.g. a second arrow press replaying the first turn).
   */
  private readonly handledKeyEvents = new WeakSet<KeyboardEvent>();

  private boardLayer!: Phaser.GameObjects.Graphics;
  private gameLayer!: Phaser.GameObjects.Graphics;

  private accumulator = 0;
  private deathFlashUntil = 0;
  private readyFired = false;
  private fixedTicks: number | null = null;
  private frozen = false;

  constructor(engine: SnakeEngine, callbacks: SnakeSceneCallbacks, reduceMotion = false) {
    super('snake');
    this.engine = engine;
    this.callbacks = callbacks;
    this.reduceMotion = reduceMotion;
  }

  create(): void {
    this.boardLayer = this.add.graphics();
    this.gameLayer = this.add.graphics();

    this.drawBoard(this.engine.state);
    this.drawGame(this.engine.state, 0);
    this.bindKeyboard();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown, this);

    if (!this.readyFired) {
      this.readyFired = true;
      this.callbacks.onReady?.();
    }
  }

  /** Clear transient run state when a fresh round starts. */
  resetRunState(): void {
    this.accumulator = 0;
    this.deathFlashUntil = 0;
    this.frozen = false;
  }

  /**
   * Debug/capture seam. The next update advances exactly `ticks` engine ticks
   * instead of the wall-clock `delta`, draws that final state and freezes the
   * run afterwards. The captured state therefore depends only on the engine
   * seed, the initial fruit and this tick count, not on frame timing. Normal
   * play never calls this.
   */
  requestFixedTicks(ticks: number): void {
    this.fixedTicks = Math.max(0, Math.floor(ticks));
  }

  update(time: number, delta: number): void {
    if (this.fixedTicks !== null) {
      const ticks = this.fixedTicks;
      this.fixedTicks = null;
      this.accumulator = 0;
      advanceFixedTicks(ticks, () => {
        if (this.engine.currentStatus !== 'running') {
          return false;
        }
        const result = this.engine.step();
        this.callbacks.onStep(result);
        this.handleFeedback(result, time);
        return this.engine.currentStatus === 'running';
      });
      this.drawGame(this.engine.state, time);
      this.frozen = true;
      // Do not sleep the Phaser loop here: a slept WebGL canvas can capture as
      // black. Keeping the loop alive only re-renders the retained, frozen
      // graphics, while `frozen` stops any further engine ticks. The capture
      // marker fires after this frame's render, so a snapshot can never catch a
      // half-drawn board.
      this.game.events.once(Phaser.Core.Events.POST_RENDER, () => {
        this.callbacks.onFixedTicks?.(ticks);
      });
      return;
    }

    if (this.frozen) {
      return;
    }

    const status = this.engine.currentStatus;

    if (status === 'running') {
      this.accumulator += Math.min(delta, 250);
      let guard = 0;
      while (this.engine.currentStatus === 'running' && guard < 8) {
        const state = this.engine.state;
        if (this.accumulator < state.stepMs) {
          break;
        }
        this.accumulator -= state.stepMs;
        const result = this.engine.step();
        this.callbacks.onStep(result);
        this.handleFeedback(result, time);
        guard += 1;
      }
    } else {
      this.accumulator = 0;
    }

    this.drawGame(this.engine.state, time);
  }

  private readonly handleResize = (): void => {
    this.drawBoard(this.engine.state);
  };

  private readonly handleShutdown = (): void => {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
  };

  private bindKeyboard(): void {
    const keyboard = this.input.keyboard;
    if (!keyboard) {
      return;
    }

    keyboard.on('keydown', (event: KeyboardEvent) => {
      if (this.handledKeyEvents.has(event)) {
        return;
      }
      this.handledKeyEvents.add(event);

      // Let focused links and non-game buttons behave natively for Space/Enter.
      // A focused D-pad direction button still uses the global Space/Enter
      // action, so the documented pause shortcut keeps working after a tap.
      const target = event.target instanceof HTMLElement ? event.target : null;
      const gameDirection = target?.closest('[data-direction]');
      const focusControl = target?.closest(
        'a[href], button, [role="button"], [role="link"]',
      );
      if (isEditableTarget(target)) {
        return;
      }
      if (focusControl && !gameDirection && (event.code === 'Space' || event.code === 'Enter')) {
        return;
      }

      const direction = directionFromCode(event.code);
      if (direction) {
        event.preventDefault();
        this.callbacks.onDirection(direction);
        return;
      }

      switch (event.code) {
        case 'Space':
        case 'Enter':
          event.preventDefault();
          if (!event.repeat) {
            this.callbacks.onPrimaryAction();
          }
          break;
        case 'KeyP':
        case 'Escape':
          event.preventDefault();
          if (!event.repeat) {
            this.callbacks.onPauseToggle();
          }
          break;
        case 'KeyR':
          event.preventDefault();
          if (!event.repeat) {
            this.callbacks.onRestart();
          }
          break;
        default:
          break;
      }
    });
  }

  private handleFeedback(result: StepResult, time: number): void {
    if (result === 'died') {
      this.deathFlashUntil = this.reduceMotion ? 0 : time + 220;
      if (!this.reduceMotion) {
        this.cameras.main.shake(160, 0.004);
      }
    } else if (result === 'won' && !this.reduceMotion) {
      this.cameras.main.flash(240, 163, 230, 53);
    }
  }

  private metrics(state: SnakeSnapshot): BoardMetrics {
    const width = this.scale.width;
    const height = this.scale.height;
    const size = Math.max(1, Math.min(width, height));
    const pad = Math.max(12, Math.round(size * 0.0625));
    const board = Math.max(1, size - pad * 2);
    return {
      size,
      pad,
      board,
      offsetX: (width - size) / 2,
      offsetY: (height - size) / 2,
      cellW: board / state.width,
      cellH: board / state.height,
    };
  }

  private drawBoard(state: SnakeSnapshot): void {
    if (!this.boardLayer) {
      return;
    }
    const layer = this.boardLayer;
    const view = this.metrics(state);
    layer.clear();

    layer.fillStyle(COLORS.canvas, 1);
    layer.fillRect(0, 0, this.scale.width, this.scale.height);

    layer.fillStyle(COLORS.board, 1);
    layer.fillRoundedRect(
      view.offsetX + view.pad - 10,
      view.offsetY + view.pad - 10,
      view.board + 20,
      view.board + 20,
      Math.min(20, view.board * 0.05),
    );

    layer.fillStyle(COLORS.grid, 0.75);
    for (let x = 0; x <= state.width; x += 1) {
      layer.fillRect(
        view.offsetX + view.pad + x * view.cellW,
        view.offsetY + view.pad,
        1,
        view.board,
      );
    }
    for (let y = 0; y <= state.height; y += 1) {
      layer.fillRect(
        view.offsetX + view.pad,
        view.offsetY + view.pad + y * view.cellH,
        view.board,
        1,
      );
    }

    layer.lineStyle(1, COLORS.border, 0.9);
    layer.strokeRoundedRect(
      view.offsetX + view.pad - 10,
      view.offsetY + view.pad - 10,
      view.board + 20,
      view.board + 20,
      Math.min(20, view.board * 0.05),
    );
  }

  private drawGame(state: SnakeSnapshot, time: number): void {
    const layer = this.gameLayer;
    if (!layer) {
      return;
    }
    const view = this.metrics(state);
    layer.clear();

    const dying = time < this.deathFlashUntil;
    const pulse = this.reduceMotion ? 0 : Math.sin(time / 220) * Math.max(1, view.cellW * 0.22);

    if (state.food) {
      const centerX = view.offsetX + view.pad + (state.food.x + 0.5) * view.cellW;
      const centerY = view.offsetY + view.pad + (state.food.y + 0.5) * view.cellH;
      layer.fillStyle(COLORS.foodGlow, 0.16);
      layer.fillCircle(centerX, centerY, Math.min(view.cellW, view.cellH) * 0.55 + pulse);
      layer.fillStyle(COLORS.food, 1);
      layer.fillCircle(centerX, centerY, Math.min(view.cellW, view.cellH) * 0.3 + pulse * 0.4);
      layer.fillStyle(0xffffff, 0.55);
      layer.fillCircle(
        centerX - view.cellW * 0.08,
        centerY - view.cellH * 0.08,
        Math.max(1.5, Math.min(view.cellW, view.cellH) * 0.07),
      );
      layer.fillStyle(COLORS.leaf, 1);
      layer.fillEllipse(
        centerX + view.cellW * 0.1,
        centerY - view.cellH * 0.33,
        view.cellW * 0.2,
        view.cellH * 0.1,
      );
    }

    const segments = state.snake;
    const lastIndex = Math.max(1, segments.length - 1);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (!segment) {
        continue;
      }
      const t = index / lastIndex;
      const color = dying ? 0xf87171 : lerpColor(COLORS.bodyStart, COLORS.bodyEnd, t);
      const x = view.offsetX + view.pad + segment.x * view.cellW;
      const y = view.offsetY + view.pad + segment.y * view.cellH;
      const inset = Math.max(1.5, (index === 0 ? 2 : 3.2) * (view.cellW / 28));
      layer.fillStyle(color, index === 0 ? 1 : 0.92);
      layer.fillRoundedRect(
        x + inset,
        y + inset,
        view.cellW - inset * 2,
        view.cellH - inset * 2,
        Math.min(9, view.cellW * 0.3),
      );
    }

    const head = segments[0];
    if (head) {
      const x = view.offsetX + view.pad + head.x * view.cellW;
      const y = view.offsetY + view.pad + head.y * view.cellH;
      const radius = Math.max(1.8, view.cellW * 0.075);
      layer.fillStyle(COLORS.head, 1);
      layer.fillRoundedRect(
        x + view.cellW * 0.18,
        y + view.cellH * 0.18,
        view.cellW * 0.64,
        view.cellH * 0.64,
        Math.min(8, view.cellW * 0.25),
      );

      const eye = eyePositions(state.direction, x, y, view.cellW, view.cellH);
      layer.fillStyle(COLORS.eye, 1);
      layer.fillCircle(eye[0].x, eye[0].y, radius);
      layer.fillCircle(eye[1].x, eye[1].y, radius);
    }
  }
}

function eyePositions(
  direction: Direction,
  x: number,
  y: number,
  cellW: number,
  cellH: number,
): readonly [{ x: number; y: number }, { x: number; y: number }] {
  switch (direction) {
    case 'right':
      return [
        { x: x + cellW * 0.72, y: y + cellH * 0.36 },
        { x: x + cellW * 0.72, y: y + cellH * 0.64 },
      ];
    case 'left':
      return [
        { x: x + cellW * 0.28, y: y + cellH * 0.36 },
        { x: x + cellW * 0.28, y: y + cellH * 0.64 },
      ];
    case 'up':
      return [
        { x: x + cellW * 0.36, y: y + cellH * 0.28 },
        { x: x + cellW * 0.64, y: y + cellH * 0.28 },
      ];
    case 'down':
      return [
        { x: x + cellW * 0.36, y: y + cellH * 0.72 },
        { x: x + cellW * 0.64, y: y + cellH * 0.72 },
      ];
  }
}

function lerpColor(from: number, to: number, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  const fromR = (from >> 16) & 0xff;
  const fromG = (from >> 8) & 0xff;
  const fromB = from & 0xff;
  const toR = (to >> 16) & 0xff;
  const toG = (to >> 8) & 0xff;
  const toB = to & 0xff;
  const r = Math.round(fromR + (toR - fromR) * clamped);
  const g = Math.round(fromG + (toG - fromG) * clamped);
  const b = Math.round(fromB + (toB - fromB) * clamped);
  return (r << 16) | (g << 8) | b;
}
