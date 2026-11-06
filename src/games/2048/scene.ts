import Phaser from 'phaser';
import { BOARD_SIZE, type Game2048Snapshot } from './engine';
import { COLORS, FALLBACK_TILE, TILE_STYLES } from './palette';

export interface Game2048SceneCallbacks {
  onReady?(): void;
}

interface BoardMetrics {
  readonly cell: number;
  readonly board: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Phaser presentation layer for 2048. Rules and scoring live in the pure
 * engine; this scene only draws the latest snapshot. There is no animation
 * loop work, so the view can render on demand after each move.
 */
export class Game2048Scene extends Phaser.Scene {
  private readonly callbacks: Game2048SceneCallbacks;
  private layer!: Phaser.GameObjects.Graphics;
  private tileTexts: Phaser.GameObjects.Text[] = [];
  private snapshot: Game2048Snapshot | null = null;
  private readyFired = false;

  constructor(callbacks: Game2048SceneCallbacks = {}) {
    super('game-2048');
    this.callbacks = callbacks;
  }

  create(): void {
    this.layer = this.add.graphics();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown, this);
    // game.destroy(true) bypasses SHUTDOWN and only emits DESTROY in Phaser 4.
    this.events.once(Phaser.Scenes.Events.DESTROY, this.handleShutdown, this);
    this.draw();

    if (!this.readyFired) {
      this.readyFired = true;
      this.callbacks.onReady?.();
    }
  }

  /** Draw a new engine snapshot on the next paint of this scene. */
  render(snapshot: Game2048Snapshot): void {
    this.snapshot = snapshot;
    this.draw();
  }

  private readonly handleResize = (): void => {
    this.draw();
  };

  private readonly handleShutdown = (): void => {
    this.scale?.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.tileTexts = [];
  };

  private metrics(): BoardMetrics {
    const width = this.scale.width;
    const height = this.scale.height;
    const padding = Math.max(10, Math.round(Math.min(width, height) * 0.055));
    const board = Math.max(1, Math.min(width, height) - padding * 2);
    return {
      cell: board / BOARD_SIZE,
      board,
      offsetX: (width - board) / 2,
      offsetY: (height - board) / 2,
    };
  }

  private draw(): void {
    if (!this.layer) {
      return;
    }

    for (const text of this.tileTexts) {
      text.destroy();
    }
    this.tileTexts = [];

    const layer = this.layer;
    const view = this.metrics();
    const width = this.scale.width;
    const height = this.scale.height;
    layer.clear();

    layer.fillStyle(COLORS.canvas, 1);
    layer.fillRect(0, 0, width, height);

    const frameInset = Math.max(5, Math.round(view.cell * 0.16));
    const radius = Math.min(18, view.cell * 0.18);
    layer.fillStyle(COLORS.frame, 1);
    layer.fillRoundedRect(
      view.offsetX - frameInset,
      view.offsetY - frameInset,
      view.board + frameInset * 2,
      view.board + frameInset * 2,
      radius + frameInset * 0.4,
    );
    layer.fillStyle(COLORS.board, 1);
    layer.fillRoundedRect(view.offsetX, view.offsetY, view.board, view.board, radius);

    const gap = Math.max(2, view.cell * 0.08);
    const tileSize = Math.max(1, view.cell - gap);
    const tileRadius = Math.min(10, tileSize * 0.16);
    const state = this.snapshot;

    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        const x = view.offsetX + col * view.cell + gap / 2;
        const y = view.offsetY + row * view.cell + gap / 2;
        const value = state?.board[row]?.[col] ?? null;

        if (value === null) {
          layer.fillStyle(COLORS.empty, 1);
          layer.fillRoundedRect(x, y, tileSize, tileSize, tileRadius);
          continue;
        }

        const style = TILE_STYLES[value] ?? FALLBACK_TILE;
        layer.fillStyle(style.fill, 1);
        layer.fillRoundedRect(x, y, tileSize, tileSize, tileRadius);
        layer.lineStyle(1, COLORS.highlight, 0.14);
        layer.strokeRoundedRect(x, y, tileSize, tileSize, tileRadius);

        const digits = String(value).length;
        const fontSize = Math.max(
          10,
          Math.round(tileSize * (digits >= 4 ? 0.26 : digits === 3 ? 0.3 : 0.36)),
        );
        const text = this.add
          .text(x + tileSize / 2, y + tileSize / 2, String(value), {
            fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
            fontSize: `${fontSize}px`,
            fontStyle: 'bold',
            color: `#${style.text.toString(16).padStart(6, '0')}`,
          })
          .setOrigin(0.5);
        this.tileTexts.push(text);
      }
    }

    layer.lineStyle(1, COLORS.border, 0.9);
    layer.strokeRoundedRect(
      view.offsetX - frameInset,
      view.offsetY - frameInset,
      view.board + frameInset * 2,
      view.board + frameInset * 2,
      radius + frameInset * 0.4,
    );
  }
}
