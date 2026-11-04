import Phaser from 'phaser';
import {
  type Direction,
  type SnakeEngine,
  type SnakeSnapshot,
  type StepResult,
} from './engine';

/** Logical canvas size; Phaser scales this to the responsive board shell. */
const SIZE = 640;
const PAD = 40;
const BOARD = SIZE - PAD * 2;

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
}

/**
 * Phaser presentation layer. It owns drawing and keyboard input only; every
 * rule lives in SnakeEngine so the game stays testable without a browser.
 */
export class SnakeScene extends Phaser.Scene {
  private readonly engine: SnakeEngine;
  private readonly callbacks: SnakeSceneCallbacks;
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
  private readonly reduceMotion: boolean;

  constructor(engine: SnakeEngine, callbacks: SnakeSceneCallbacks) {
    super('snake');
    this.engine = engine;
    this.callbacks = callbacks;
    this.reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  create(): void {
    this.boardLayer = this.add.graphics();
    this.gameLayer = this.add.graphics();

    this.drawBoard(this.engine.state);
    this.drawGame(this.engine.state, 0);
    this.bindKeyboard();
  }

  /** Clear transient run state when a fresh round starts. */
  resetRunState(): void {
    this.accumulator = 0;
    this.deathFlashUntil = 0;
  }

  update(time: number, delta: number): void {
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

      // Let focused buttons/links behave natively (Space/Enter activation)
      // instead of also steering the game. Game controls still accept arrows.
      const target = event.target instanceof HTMLElement ? event.target : null;
      const interactive = target?.closest(
        'button, a, input, select, textarea, [contenteditable="true"]',
      );
      const gameControl = target?.closest(
        '[data-direction], .dpad-button--center, [data-action="primary"], [data-action="pause"], [data-action="restart"]',
      );
      if (interactive && !gameControl) {
        return;
      }
      if (gameControl && (event.code === 'Space' || event.code === 'Enter')) {
        return;
      }

      switch (event.code) {
        case 'ArrowUp':
        case 'KeyW':
          event.preventDefault();
          this.callbacks.onDirection('up');
          break;
        case 'ArrowDown':
        case 'KeyS':
          event.preventDefault();
          this.callbacks.onDirection('down');
          break;
        case 'ArrowLeft':
        case 'KeyA':
          event.preventDefault();
          this.callbacks.onDirection('left');
          break;
        case 'ArrowRight':
        case 'KeyD':
          event.preventDefault();
          this.callbacks.onDirection('right');
          break;
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
      this.deathFlashUntil = time + 220;
      if (!this.reduceMotion) {
        this.cameras.main.shake(160, 0.004);
      }
    } else if (result === 'won' && !this.reduceMotion) {
      this.cameras.main.flash(240, 163, 230, 53);
    }
  }

  private drawBoard(state: SnakeSnapshot): void {
    const layer = this.boardLayer;
    layer.clear();
    layer.fillStyle(COLORS.canvas, 1);
    layer.fillRect(0, 0, SIZE, SIZE);

    layer.fillStyle(COLORS.board, 1);
    layer.fillRoundedRect(PAD - 10, PAD - 10, BOARD + 20, BOARD + 20, 20);

    const cellW = BOARD / state.width;
    const cellH = BOARD / state.height;
    layer.fillStyle(COLORS.grid, 0.75);
    for (let x = 0; x <= state.width; x += 1) {
      layer.fillRect(PAD + x * cellW, PAD, 1, BOARD);
    }
    for (let y = 0; y <= state.height; y += 1) {
      layer.fillRect(PAD, PAD + y * cellH, BOARD, 1);
    }

    layer.lineStyle(1, COLORS.border, 0.9);
    layer.strokeRoundedRect(PAD - 10, PAD - 10, BOARD + 20, BOARD + 20, 20);
  }

  private drawGame(state: SnakeSnapshot, time: number): void {
    const layer = this.gameLayer;
    layer.clear();

    const cellW = BOARD / state.width;
    const cellH = BOARD / state.height;
    const dying = time < this.deathFlashUntil;
    const pulse = this.reduceMotion ? 0 : Math.sin(time / 220) * 1.4;

    if (state.food) {
      const centerX = PAD + (state.food.x + 0.5) * cellW;
      const centerY = PAD + (state.food.y + 0.5) * cellH;
      layer.fillStyle(COLORS.foodGlow, 0.16);
      layer.fillCircle(centerX, centerY, Math.min(cellW, cellH) * 0.55 + pulse);
      layer.fillStyle(COLORS.food, 1);
      layer.fillCircle(centerX, centerY, Math.min(cellW, cellH) * 0.3 + pulse * 0.4);
      layer.fillStyle(0xffffff, 0.55);
      layer.fillCircle(
        centerX - cellW * 0.08,
        centerY - cellH * 0.08,
        Math.max(1.5, Math.min(cellW, cellH) * 0.07),
      );
      layer.fillStyle(COLORS.leaf, 1);
      layer.fillEllipse(
        centerX + cellW * 0.1,
        centerY - cellH * 0.33,
        cellW * 0.2,
        cellH * 0.1,
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
      const x = PAD + segment.x * cellW;
      const y = PAD + segment.y * cellH;
      const inset = index === 0 ? 2 : 3.2;
      layer.fillStyle(color, index === 0 ? 1 : 0.92);
      layer.fillRoundedRect(
        x + inset,
        y + inset,
        cellW - inset * 2,
        cellH - inset * 2,
        Math.min(9, cellW * 0.3),
      );
    }

    const head = segments[0];
    if (head) {
      const x = PAD + head.x * cellW;
      const y = PAD + head.y * cellH;
      const radius = Math.max(1.8, cellW * 0.075);
      layer.fillStyle(COLORS.head, 1);
      layer.fillRoundedRect(
        x + cellW * 0.18,
        y + cellH * 0.18,
        cellW * 0.64,
        cellH * 0.64,
        Math.min(8, cellW * 0.25),
      );

      const eye = eyePositions(state.direction, x, y, cellW, cellH);
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
