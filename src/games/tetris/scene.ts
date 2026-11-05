import Phaser from 'phaser';
import { directionFromCode, isEditableTarget } from '../../core/input';
import type { Cell, StepResult, TetrisEngine, TetrisSnapshot } from './engine';
import { TETROMINO_COLORS } from './palette';

export type TetrisAction =
  | 'left'
  | 'right'
  | 'rotate'
  | 'softDrop'
  | 'hardDrop'
  | 'pause'
  | 'restart';

export interface TetrisSceneCallbacks {
  /** A keyboard action the DOM shell should apply to the shared engine. */
  onAction(action: TetrisAction): void;
  /** Fired after every gravity or soft-drop tick so the HUD can follow. */
  onStep(result: StepResult): void;
  onReady?(): void;
}

interface BoardMetrics {
  readonly width: number;
  readonly height: number;
  readonly cell: number;
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

const SOFT_DROP_MS = 45;
const MAX_FRAME_DELTA = 250;
const COLORS = {
  canvas: 0x04070e,
  frame: 0x0b1526,
  board: 0x0a1322,
  grid: 0x17243a,
  border: 0x263a58,
  highlight: 0xffffff,
  gameOver: 0xf87171,
} as const;

/**
 * Phaser presentation layer for Tetris. The rules stay in TetrisEngine; this
 * scene draws a snapshot and translates shared keyboard input into engine
 * actions owned by the DOM shell.
 */
export class TetrisScene extends Phaser.Scene {
  private readonly engine: TetrisEngine;
  private readonly callbacks: TetrisSceneCallbacks;
  private readonly reduceMotion: boolean;
  /**
   * Phaser may dispatch the same native keyboard event again in a later frame
   * when another key arrives. Track native events so a single press never
   * rotates or restarts twice.
   */
  private readonly handledKeyEvents = new WeakSet<KeyboardEvent>();

  private layer!: Phaser.GameObjects.Graphics;
  private gravityClock = 0;
  private softDropClock = 0;
  private softDropHeld = false;
  private readyFired = false;
  private clearedFlashUntil = 0;

  constructor(engine: TetrisEngine, callbacks: TetrisSceneCallbacks, reduceMotion = false) {
    super('tetris');
    this.engine = engine;
    this.callbacks = callbacks;
    this.reduceMotion = reduceMotion;
  }

  create(): void {
    this.layer = this.add.graphics();
    this.draw(this.engine.state, 0);
    this.bindKeyboard();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown, this);
    // game.destroy(true) bypasses SHUTDOWN and only emits DESTROY in Phaser 4.
    this.events.once(Phaser.Scenes.Events.DESTROY, this.handleShutdown, this);

    if (!this.readyFired) {
      this.readyFired = true;
      this.callbacks.onReady?.();
    }
  }

  /** Reset transient presentation state at the start of a new round. */
  resetRunState(): void {
    this.gravityClock = 0;
    this.softDropClock = 0;
    this.softDropHeld = false;
    this.clearedFlashUntil = 0;
  }

  /** A short, motion-safe flash for satisfying line clears and hard drops. */
  flashClear(): void {
    if (this.reduceMotion) {
      return;
    }
    this.cameras.main.flash(120, 192, 132, 252);
  }

  update(time: number, delta: number): void {
    const frameDelta = Math.min(delta, MAX_FRAME_DELTA);

    if (this.engine.currentStatus === 'running') {
      if (this.softDropHeld) {
        this.softDropClock += frameDelta;
        let guard = 0;
        while (
          this.softDropHeld &&
          this.engine.currentStatus === 'running' &&
          this.softDropClock >= SOFT_DROP_MS &&
          guard < 8
        ) {
          this.softDropClock -= SOFT_DROP_MS;
          guard += 1;
          if (this.engine.softDrop()) {
            this.callbacks.onStep('moved');
          } else {
            // The piece is resting on the stack; let the gravity tick lock it
            // instead of waiting for the next slower gravity interval.
            const result = this.engine.step();
            this.callbacks.onStep(result);
            this.handleFeedback(result, time);
          }
        }
      } else {
        this.softDropClock = 0;
      }

      this.gravityClock += frameDelta;
      let guard = 0;
      while (this.engine.currentStatus === 'running' && guard < 8) {
        const interval = this.engine.state.gravityMs;
        if (this.gravityClock < interval) {
          break;
        }
        this.gravityClock -= interval;
        guard += 1;
        const result = this.engine.step();
        this.callbacks.onStep(result);
        this.handleFeedback(result, time);
      }
    } else {
      this.gravityClock = 0;
      this.softDropClock = 0;
    }

    this.draw(this.engine.state, time);
  }

  private readonly handleResize = (): void => {
    this.draw(this.engine.state, this.time.now);
  };

  private readonly handleShutdown = (): void => {
    this.softDropHeld = false;
    this.input?.keyboard?.off('keydown', this.handleKeyDown);
    this.input?.keyboard?.off('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleWindowBlur);
    this.scale?.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
  };

  private bindKeyboard(): void {
    const keyboard = this.input.keyboard;
    if (!keyboard) {
      return;
    }
    keyboard.on('keydown', this.handleKeyDown);
    keyboard.on('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleWindowBlur);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.handledKeyEvents.has(event)) {
      return;
    }
    this.handledKeyEvents.add(event);

    // Never steal browser or OS shortcuts (Ctrl/Cmd/Alt + key).
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : null;
    if (isEditableTarget(target)) {
      return;
    }

    // Space/Enter belong to a focused link or button (start, pause, restart),
    // except for the touch action keys where the game shortcut stays useful.
    const focusControl = target?.closest('a[href], button, [role="button"], [role="link"]');
    const touchKey = target?.closest('.tetris-key');
    if (focusControl && !touchKey && (event.code === 'Space' || event.code === 'Enter')) {
      return;
    }

    const direction = directionFromCode(event.code);
    if (direction) {
      event.preventDefault();
      if (direction === 'down') {
        // Accelerated fall is driven by the scene's update loop while held;
        // still fire once immediately so a tap always moves one cell.
        this.softDropHeld = true;
        if (!event.repeat) {
          this.callbacks.onAction('softDrop');
        }
        return;
      }
      if (direction === 'up') {
        if (!event.repeat) {
          this.callbacks.onAction('rotate');
        }
        return;
      }
      // Left/right keep moving on the browser's key-repeat events.
      this.callbacks.onAction(direction);
      return;
    }

    switch (event.code) {
      case 'Space':
        event.preventDefault();
        if (!event.repeat) {
          this.callbacks.onAction('hardDrop');
        }
        break;
      case 'KeyP':
      case 'Escape':
        event.preventDefault();
        if (!event.repeat) {
          this.callbacks.onAction('pause');
        }
        break;
      case 'KeyR':
        event.preventDefault();
        if (!event.repeat) {
          this.callbacks.onAction('restart');
        }
        break;
      default:
        break;
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (directionFromCode(event.code) === 'down') {
      this.softDropHeld = false;
      this.softDropClock = 0;
    }
  };

  private readonly handleWindowBlur = (): void => {
    this.softDropHeld = false;
    this.softDropClock = 0;
  };

  private handleFeedback(result: StepResult, time: number): void {
    if (result === 'cleared') {
      this.clearedFlashUntil = time + 180;
      if (!this.reduceMotion) {
        this.cameras.main.flash(140, 34, 211, 238);
      }
    } else if (result === 'gameover' && !this.reduceMotion) {
      this.cameras.main.shake(180, 0.006);
    }
  }

  private metrics(state: TetrisSnapshot): BoardMetrics {
    const width = this.scale.width;
    const height = this.scale.height;
    const padding = Math.max(8, Math.round(Math.min(width, height) * 0.035));
    const cell = Math.max(
      1,
      Math.min(
        (width - padding * 2) / state.width,
        (height - padding * 2) / state.height,
      ),
    );
    const boardWidth = cell * state.width;
    const boardHeight = cell * state.height;
    return {
      width,
      height,
      cell,
      boardWidth,
      boardHeight,
      offsetX: (width - boardWidth) / 2,
      offsetY: (height - boardHeight) / 2,
    };
  }

  private draw(state: TetrisSnapshot, time: number): void {
    if (!this.layer) {
      return;
    }
    const layer = this.layer;
    const view = this.metrics(state);
    layer.clear();

    layer.fillStyle(COLORS.canvas, 1);
    layer.fillRect(0, 0, view.width, view.height);

    const frameInset = Math.max(4, Math.round(view.cell * 0.32));
    layer.fillStyle(COLORS.frame, 1);
    layer.fillRoundedRect(
      view.offsetX - frameInset,
      view.offsetY - frameInset,
      view.boardWidth + frameInset * 2,
      view.boardHeight + frameInset * 2,
      Math.min(18, view.cell * 0.7),
    );
    layer.fillStyle(COLORS.board, 1);
    layer.fillRect(view.offsetX, view.offsetY, view.boardWidth, view.boardHeight);

    layer.lineStyle(1, COLORS.grid, 0.7);
    for (let column = 1; column < state.width; column += 1) {
      const x = view.offsetX + column * view.cell;
      layer.lineBetween(x, view.offsetY, x, view.offsetY + view.boardHeight);
    }
    for (let row = 1; row < state.height; row += 1) {
      const y = view.offsetY + row * view.cell;
      layer.lineBetween(view.offsetX, y, view.offsetX + view.boardWidth, y);
    }

    layer.lineStyle(1, COLORS.border, 0.9);
    layer.strokeRoundedRect(
      view.offsetX - frameInset,
      view.offsetY - frameInset,
      view.boardWidth + frameInset * 2,
      view.boardHeight + frameInset * 2,
      Math.min(18, view.cell * 0.7),
    );

    for (let row = 0; row < state.height; row += 1) {
      const boardRow = state.board[row];
      if (!boardRow) {
        continue;
      }
      for (let column = 0; column < state.width; column += 1) {
        const type = boardRow[column];
        if (!type) {
          continue;
        }
        this.drawBlock(layer, view, column, row, TETROMINO_COLORS[type].core, 0.94);
      }
    }

    const active = state.active;
    if (active) {
      const ghost = this.ghostCells(state);
      for (const cell of ghost) {
        this.drawGhost(layer, view, cell, TETROMINO_COLORS[active.type].core);
      }
      for (const cell of active.cells) {
        this.drawBlock(layer, view, cell.x, cell.y, TETROMINO_COLORS[active.type].core, 1);
      }
    }

    if (time < this.clearedFlashUntil) {
      layer.fillStyle(COLORS.highlight, 0.08);
      layer.fillRect(view.offsetX, view.offsetY, view.boardWidth, view.boardHeight);
    }

    if (state.status === 'gameover') {
      layer.lineStyle(2, COLORS.gameOver, 0.55);
      layer.strokeRect(view.offsetX, view.offsetY, view.boardWidth, view.boardHeight);
    }
  }

  private drawBlock(
    layer: Phaser.GameObjects.Graphics,
    view: BoardMetrics,
    column: number,
    row: number,
    color: number,
    alpha: number,
  ): void {
    const inset = Math.max(1, view.cell * 0.06);
    const x = view.offsetX + column * view.cell + inset;
    const y = view.offsetY + row * view.cell + inset;
    const size = Math.max(1, view.cell - inset * 2);
    const radius = Math.min(6, size * 0.22);
    layer.fillStyle(color, alpha);
    layer.fillRoundedRect(x, y, size, size, radius);
    layer.lineStyle(1, COLORS.highlight, 0.16);
    layer.strokeRoundedRect(x, y, size, size, radius);
  }

  private drawGhost(
    layer: Phaser.GameObjects.Graphics,
    view: BoardMetrics,
    cell: Cell,
    color: number,
  ): void {
    const inset = Math.max(1, view.cell * 0.12);
    const x = view.offsetX + cell.x * view.cell + inset;
    const y = view.offsetY + cell.y * view.cell + inset;
    const size = Math.max(1, view.cell - inset * 2);
    const radius = Math.min(5, size * 0.2);
    layer.fillStyle(color, 0.07);
    layer.fillRoundedRect(x, y, size, size, radius);
    layer.lineStyle(1.5, color, 0.4);
    layer.strokeRoundedRect(x, y, size, size, radius);
  }

  private ghostCells(state: TetrisSnapshot): Cell[] {
    const active = state.active;
    if (!active) {
      return [];
    }
    const occupied = new Set<string>();
    state.board.forEach((row, y) => {
      row.forEach((cell, x) => {
        if (cell) {
          occupied.add(`${x},${y}`);
        }
      });
    });

    let drop = 0;
    search: while (drop < state.height) {
      const next = active.cells.map((cell) => ({
        x: cell.x,
        y: cell.y + drop + 1,
      }));
      for (const cell of next) {
        if (
          cell.y >= state.height ||
          cell.x < 0 ||
          cell.x >= state.width ||
          occupied.has(`${cell.x},${cell.y}`)
        ) {
          break search;
        }
      }
      drop += 1;
    }

    return active.cells.map((cell) => ({
      x: cell.x,
      y: cell.y + drop,
    }));
  }
}
