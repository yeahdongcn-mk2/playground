import Phaser from 'phaser';
import type { BreakoutEngine, BreakoutSnapshot, BreakoutUpdate } from './engine';
import { courtMetrics, type CourtMetrics } from './geometry';
import { BREAKOUT_COLORS as COLORS, BRICK_COLORS } from './palette';

export interface BreakoutSceneCallbacks {
  /** Fired after a simulation update that changed score, lives or status. */
  onStep(result: BreakoutUpdate): void;
  onReady?(): void;
}

/**
 * Phaser presentation layer for Breakout. The rules, collisions and scoring
 * stay in BreakoutEngine; this scene drives the shared fixed-step simulation
 * from Phaser's update loop and draws one immutable snapshot per frame.
 */
export class BreakoutScene extends Phaser.Scene {
  private readonly engine: BreakoutEngine;
  private readonly callbacks: BreakoutSceneCallbacks;
  private readonly reduceMotion: boolean;

  private layer!: Phaser.GameObjects.Graphics;
  private readyFired = false;

  constructor(
    engine: BreakoutEngine,
    callbacks: BreakoutSceneCallbacks,
    reduceMotion = false,
  ) {
    super('breakout');
    this.engine = engine;
    this.callbacks = callbacks;
    this.reduceMotion = reduceMotion;
  }

  create(): void {
    this.layer = this.add.graphics();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown, this);
    // game.destroy(true) bypasses SHUTDOWN and only emits DESTROY in Phaser 4.
    this.events.once(Phaser.Scenes.Events.DESTROY, this.handleShutdown, this);
    this.draw(this.engine.state);

    if (!this.readyFired) {
      this.readyFired = true;
      this.callbacks.onReady?.();
    }
  }

  update(_time: number, delta: number): void {
    const result = this.engine.update(delta);
    if (
      result.destroyedBricks.length > 0 ||
      result.lifeLost ||
      result.levelCleared ||
      result.gameOver
    ) {
      this.handleFeedback(result);
      this.callbacks.onStep(result);
    }
    this.draw(this.engine.state);
  }

  private readonly handleResize = (): void => {
    this.draw(this.engine.state);
  };

  private readonly handleShutdown = (): void => {
    this.scale?.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
  };

  private handleFeedback(result: BreakoutUpdate): void {
    if (this.reduceMotion) {
      return;
    }
    if (result.levelCleared) {
      this.cameras.main.flash(150, 34, 211, 238);
    } else if (result.gameOver || result.lifeLost) {
      this.cameras.main.shake(150, 0.004);
    }
  }

  private metrics(state: BreakoutSnapshot): CourtMetrics {
    return courtMetrics(this.scale.width, this.scale.height, state.width, state.height);
  }

  private draw(state: BreakoutSnapshot): void {
    if (!this.layer) {
      return;
    }
    const layer = this.layer;
    const view = this.metrics(state);
    const width = this.scale.width;
    const height = this.scale.height;
    layer.clear();

    layer.fillStyle(COLORS.canvas, 1);
    layer.fillRect(0, 0, width, height);

    const radius = Math.min(20, view.width * 0.04);
    layer.fillStyle(COLORS.court, 1);
    layer.fillRoundedRect(view.offsetX, view.offsetY, view.width, view.height, radius);

    // A soft top band makes the brick field read as the far wall of the court.
    layer.fillStyle(COLORS.courtHighlight, 0.04);
    layer.fillRoundedRect(view.offsetX, view.offsetY, view.width, view.height * 0.18, radius);

    const scale = view.scale;
    for (const brick of state.bricks) {
      const x = view.offsetX + brick.x * scale;
      const y = view.offsetY + brick.y * scale;
      const brickWidth = brick.width * scale;
      const brickHeight = brick.height * scale;
      const brickRadius = Math.min(6, brickHeight * 0.24);
      const color = BRICK_COLORS[brick.colorTier] ?? BRICK_COLORS[0];

      layer.fillStyle(color, 1);
      layer.fillRoundedRect(x, y, brickWidth, brickHeight, brickRadius);
      layer.lineStyle(1, COLORS.brickHighlight, 0.22);
      layer.strokeRoundedRect(x, y, brickWidth, brickHeight, brickRadius);
      layer.fillStyle(COLORS.brickHighlight, 0.24);
      layer.fillRoundedRect(
        x + brickWidth * 0.12,
        y + brickHeight * 0.16,
        brickWidth * 0.76,
        Math.max(1, brickHeight * 0.1),
        brickRadius * 0.4,
      );
    }

    const paddle = state.paddle;
    const paddleX = view.offsetX + (paddle.x - paddle.width / 2) * scale;
    const paddleY = view.offsetY + paddle.y * scale;
    const paddleWidth = paddle.width * scale;
    const paddleHeight = paddle.height * scale;
    const paddleRadius = paddleHeight / 2;

    layer.fillStyle(COLORS.paddle, 0.16);
    layer.fillRoundedRect(
      paddleX - paddleHeight * 0.35,
      paddleY - paddleHeight * 0.35,
      paddleWidth + paddleHeight * 0.7,
      paddleHeight * 1.7,
      paddleRadius,
    );
    layer.fillStyle(COLORS.paddle, 1);
    layer.fillRoundedRect(paddleX, paddleY, paddleWidth, paddleHeight, paddleRadius);
    layer.lineStyle(1, COLORS.paddleEdge, 0.9);
    layer.strokeRoundedRect(paddleX, paddleY, paddleWidth, paddleHeight, paddleRadius);
    layer.fillStyle(COLORS.paddleHighlight, 0.55);
    layer.fillRoundedRect(
      paddleX + paddleWidth * 0.08,
      paddleY + paddleHeight * 0.14,
      paddleWidth * 0.84,
      Math.max(1, paddleHeight * 0.22),
      paddleRadius * 0.5,
    );

    const ball = state.ball;
    const ballX = view.offsetX + ball.x * scale;
    const ballY = view.offsetY + ball.y * scale;
    const ballRadius = ball.radius * scale;

    layer.fillStyle(COLORS.ballGlow, 0.18);
    layer.fillCircle(ballX, ballY, ballRadius * 2.1);
    layer.fillStyle(COLORS.ball, 1);
    layer.fillCircle(ballX, ballY, ballRadius);
    layer.fillStyle(COLORS.ballGlow, 0.65);
    layer.fillCircle(ballX + ballRadius * 0.2, ballY + ballRadius * 0.2, ballRadius * 0.45);

    layer.lineStyle(2, COLORS.courtEdge, 0.9);
    layer.strokeRoundedRect(view.offsetX, view.offsetY, view.width, view.height, radius);
  }
}
