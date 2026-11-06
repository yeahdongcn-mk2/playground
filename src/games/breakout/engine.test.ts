import { describe, expect, it } from 'vitest';
import {
  ballSpeedForLevel,
  BRICK_COLOR_TIERS,
  brickColorTierForRow,
  brickRowsForLevel,
  BreakoutEngine,
  createLevelBricks,
  createSeededRng,
  DEFAULT_BREAKOUT_CONFIG,
  FIXED_STEP_MS,
  type BreakoutEngineOptions,
  type Brick,
} from './engine';

const WIDTH = DEFAULT_BREAKOUT_CONFIG.width;
const HEIGHT = DEFAULT_BREAKOUT_CONFIG.height;
const PADDLE_TOP = HEIGHT - DEFAULT_BREAKOUT_CONFIG.paddleBottomMargin -
  DEFAULT_BREAKOUT_CONFIG.paddleHeight;
const PADDLE_HALF = DEFAULT_BREAKOUT_CONFIG.paddleWidth / 2;
const RADIUS = DEFAULT_BREAKOUT_CONFIG.ballRadius;
const BALL_SPEED = DEFAULT_BREAKOUT_CONFIG.ballSpeed;

function makeEngine(options: BreakoutEngineOptions = {}): BreakoutEngine {
  return new BreakoutEngine({ rng: createSeededRng(1), ...options });
}

function brickAt(bricks: readonly Brick[], index = 0): Brick {
  const brick = bricks[index];
  if (!brick) {
    throw new Error(`Expected a brick at index ${index}.`);
  }
  return brick;
}

/** Aim a still ball at the bottom edge of one brick from directly below it. */
function ballUnderBrick(brick: Brick): {
  x: number;
  y: number;
  vx: number;
  vy: number;
} {
  return {
    x: brick.x + brick.width / 2,
    y: brick.y + brick.height + RADIUS - 1,
    vx: 0,
    vy: -200,
  };
}

/**
 * Serve and keep the paddle on the opposite half from the ball until it falls
 * past the bottom. Returns true when exactly one life was lost.
 */
function forceMiss(engine: BreakoutEngine): boolean {
  const lives = engine.state.lives;
  engine.setPaddleDirection(0);
  engine.movePaddleTo(WIDTH - PADDLE_HALF);
  if (!engine.start()) {
    return false;
  }

  let elapsed = 0;
  while (engine.state.lives === lives && elapsed < 60_000) {
    const ballX = engine.state.ball.x;
    engine.movePaddleTo(ballX < WIDTH / 2 ? WIDTH - PADDLE_HALF : PADDLE_HALF);
    engine.update(50);
    elapsed += 50;
  }
  return engine.state.lives === lives - 1;
}

describe('paddle movement', () => {
  it('moves at the configured speed and keeps the ball on top while ready', () => {
    const engine = makeEngine();
    const startX = engine.state.paddle.x;

    engine.setPaddleDirection(1);
    engine.step();

    const expectedStep = DEFAULT_BREAKOUT_CONFIG.paddleSpeed * (FIXED_STEP_MS / 1000);
    expect(engine.state.paddle.x - startX).toBeCloseTo(expectedStep, 6);
    expect(engine.state.ball.x).toBeCloseTo(engine.state.paddle.x, 6);
    expect(engine.state.ball.y).toBeCloseTo(PADDLE_TOP - RADIUS, 6);
    expect(engine.state.ball.attached).toBe(true);
    expect(engine.state.status).toBe('ready');
  });

  it('clamps the paddle centre to both walls while moving', () => {
    const engine = makeEngine();

    engine.setPaddleDirection(1);
    for (let step = 0; step < 300; step += 1) {
      engine.step();
    }
    expect(engine.state.paddle.x).toBeCloseTo(WIDTH - PADDLE_HALF, 6);

    engine.setPaddleDirection(-1);
    for (let step = 0; step < 300; step += 1) {
      engine.step();
    }
    expect(engine.state.paddle.x).toBeCloseTo(PADDLE_HALF, 6);
  });

  it('clamps immediate and touch-style paddle moves', () => {
    const engine = makeEngine();

    engine.movePaddleTo(-100);
    expect(engine.state.paddle.x).toBe(PADDLE_HALF);
    expect(engine.state.ball.x).toBe(PADDLE_HALF);
    engine.movePaddleTo(WIDTH + 100);
    expect(engine.state.paddle.x).toBe(WIDTH - PADDLE_HALF);
    expect(engine.state.ball.x).toBe(WIDTH - PADDLE_HALF);
    engine.movePaddle(-1_000);
    expect(engine.state.paddle.x).toBe(PADDLE_HALF);
    engine.movePaddle(1_000);
    expect(engine.state.paddle.x).toBe(WIDTH - PADDLE_HALF);
    engine.movePaddle(Number.NaN);
    expect(engine.state.paddle.x).toBe(WIDTH - PADDLE_HALF);
  });

  it('rejects an unknown paddle direction at runtime', () => {
    const engine = makeEngine();
    expect(() => {
      engine.setPaddleDirection(2 as -1 | 0 | 1);
    }).toThrow(RangeError);
  });
});

describe('ball collisions', () => {
  it('bounces off the left, right and top walls while preserving speed', () => {
    const left = makeEngine({
      initialBall: { x: RADIUS, y: 300, vx: -120, vy: 0 },
    });
    left.step();
    expect(left.state.ball.x).toBeCloseTo(RADIUS, 6);
    expect(left.state.ball.vx).toBeGreaterThan(0);
    expect(Math.hypot(left.state.ball.vx, left.state.ball.vy)).toBeCloseTo(120, 6);

    const right = makeEngine({
      initialBall: { x: WIDTH - RADIUS, y: 300, vx: 120, vy: 0 },
    });
    right.step();
    expect(right.state.ball.x).toBeCloseTo(WIDTH - RADIUS, 6);
    expect(right.state.ball.vx).toBeLessThan(0);
    expect(Math.hypot(right.state.ball.vx, right.state.ball.vy)).toBeCloseTo(120, 6);

    const top = makeEngine({
      initialBall: { x: WIDTH / 2, y: RADIUS, vx: 0, vy: -120 },
    });
    top.step();
    expect(top.state.ball.y).toBeCloseTo(RADIUS, 6);
    expect(top.state.ball.vy).toBeGreaterThan(0);
    expect(Math.hypot(top.state.ball.vx, top.state.ball.vy)).toBeCloseTo(120, 6);

    const awayFromLeft = makeEngine({
      initialBall: { x: RADIUS, y: 300, vx: 120, vy: 0 },
    });
    awayFromLeft.step();
    expect(awayFromLeft.state.ball.vx).toBeCloseTo(120, 6);

    const awayFromTop = makeEngine({
      initialBall: { x: WIDTH / 2, y: RADIUS, vx: 0, vy: 120 },
    });
    awayFromTop.step();
    expect(awayFromTop.state.ball.vy).toBeCloseTo(120, 6);
  });

  it('uses the paddle hit offset to choose the rebound angle', () => {
    const hit = (x: number) => {
      const engine = makeEngine({
        initialBall: {
          x,
          y: PADDLE_TOP - RADIUS - 0.5,
          vx: 0,
          vy: 120,
        },
      });
      engine.step();
      return engine.state.ball;
    };

    const centre = hit(WIDTH / 2);
    expect(centre.vx).toBeCloseTo(0, 6);
    expect(centre.vy).toBeCloseTo(-BALL_SPEED, 6);

    const left = hit(WIDTH / 2 - PADDLE_HALF / 2);
    const leftAngle = (Math.atan2(left.vx, -left.vy) * 180) / Math.PI;
    expect(left.vx).toBeLessThan(0);
    expect(leftAngle).toBeCloseTo(
      -DEFAULT_BREAKOUT_CONFIG.maxBounceAngleDegrees / 2,
      5,
    );

    const right = hit(WIDTH / 2 + PADDLE_HALF / 2);
    const rightAngle = (Math.atan2(right.vx, -right.vy) * 180) / Math.PI;
    expect(right.vx).toBeGreaterThan(0);
    expect(rightAngle).toBeCloseTo(
      DEFAULT_BREAKOUT_CONFIG.maxBounceAngleDegrees / 2,
      5,
    );

    for (const ball of [centre, left, right]) {
      expect(Math.hypot(ball.vx, ball.vy)).toBeCloseTo(BALL_SPEED, 6);
      expect(ball.vy).toBeLessThan(0);
    }

    const edge = hit(WIDTH / 2 + PADDLE_HALF + 2);
    const edgeAngle = (Math.atan2(edge.vx, -edge.vy) * 180) / Math.PI;
    expect(edge.vx).toBeGreaterThan(0);
    expect(edgeAngle).toBeCloseTo(
      DEFAULT_BREAKOUT_CONFIG.maxBounceAngleDegrees,
      5,
    );
    expect(Math.hypot(edge.vx, edge.vy)).toBeCloseTo(BALL_SPEED, 6);
  });

  it('does not save a ball whose centre has already passed the paddle', () => {
    const paddleBottom = PADDLE_TOP + DEFAULT_BREAKOUT_CONFIG.paddleHeight;
    const engine = makeEngine({
      initialBall: {
        x: WIDTH / 2,
        y: paddleBottom + 2,
        vx: 0,
        vy: 100,
      },
    });

    engine.step();
    expect(engine.state.ball.vy).toBeGreaterThan(0);
    expect(engine.state.ball.y).toBeGreaterThan(paddleBottom);
    expect(engine.state.ball.attached).toBe(false);
  });

  it('nudges a side graze out instead of teleporting it onto the paddle top', () => {
    const paddleLeft = WIDTH / 2 - PADDLE_HALF;
    const engine = makeEngine({
      initialBall: {
        x: paddleLeft - RADIUS + 1,
        y: PADDLE_TOP + 4,
        vx: 100,
        vy: 100,
      },
    });

    engine.step();
    expect(engine.state.ball.y).toBeGreaterThan(PADDLE_TOP);
    expect(engine.state.ball.vy).toBeGreaterThan(0);
    expect(engine.state.ball.vx).toBeLessThan(0);
  });

  it('removes a brick, scores it and rebounds away from the brick', () => {
    const brick = brickAt(createLevelBricks(1));
    const engine = makeEngine({
      initialBricks: [
        { row: 0, col: 0 },
        { row: 0, col: 9 },
      ],
      initialBall: ballUnderBrick(brick),
    });

    expect(engine.state.bricks).toHaveLength(2);
    const update = engine.update(20);

    expect(update.destroyedBricks).toHaveLength(1);
    expect(update.destroyedBricks[0]?.id).toBe(0);
    expect(update.scoreGained).toBe(DEFAULT_BREAKOUT_CONFIG.scorePerBrick);
    expect(engine.state.score).toBe(DEFAULT_BREAKOUT_CONFIG.scorePerBrick);
    expect(engine.state.bricks).toHaveLength(1);
    expect(engine.state.bricks[0]?.id).toBe(1);
    expect(engine.state.ball.vy).toBeGreaterThan(0);
    expect(engine.state.status).toBe('running');
    expect(update.gameOver).toBe(false);
  });

  it('handles custom brick points and colour tiers', () => {
    const brick = brickAt(createLevelBricks(1));
    const engine = makeEngine({
      initialBricks: [
        { row: 0, col: 0, colorTier: 99, points: 42 },
        { row: 0, col: 9 },
      ],
      initialBall: ballUnderBrick(brick),
    });

    expect(engine.state.bricks[0]?.colorTier).toBe(BRICK_COLOR_TIERS - 1);
    expect(engine.state.bricks[0]?.points).toBe(42);

    const update = engine.update(20);
    expect(update.scoreGained).toBe(42);
    expect(engine.state.score).toBe(42);
  });

  it('only resolves one brick per fixed step', () => {
    const brick = brickAt(createLevelBricks(1));
    const engine = makeEngine({
      initialBricks: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
      ],
      // Sit in the gap between both bricks so both are in collision range.
      initialBall: {
        ...ballUnderBrick(brick),
        x: brick.x + brick.width + DEFAULT_BREAKOUT_CONFIG.brickGap / 2,
      },
    });
    const step = engine.step();
    expect(step.destroyedBricks).toHaveLength(1);
    expect(engine.state.bricks).toHaveLength(1);
  });

  it('rebounds off a brick side and removes it', () => {
    const brick = brickAt(createLevelBricks(1));
    const engine = makeEngine({
      initialBricks: [
        { row: 0, col: 0 },
        { row: 0, col: 9 },
      ],
      initialBall: {
        x: brick.x - RADIUS + 1,
        y: brick.y + brick.height / 2,
        vx: 200,
        vy: 0,
      },
    });

    const step = engine.step();
    expect(step.destroyedBricks).toHaveLength(1);
    expect(engine.state.ball.vx).toBeLessThan(0);
    expect(engine.state.bricks).toHaveLength(1);
  });

  it('rebounds off a brick top and removes it', () => {
    const brick = brickAt(createLevelBricks(1));
    const engine = makeEngine({
      initialBricks: [
        { row: 0, col: 0 },
        { row: 0, col: 9 },
      ],
      initialBall: {
        x: brick.x + brick.width / 2,
        y: brick.y - RADIUS + 1,
        vx: 0,
        vy: 200,
      },
    });

    const step = engine.step();
    expect(step.destroyedBricks).toHaveLength(1);
    expect(engine.state.ball.vy).toBeLessThan(0);
    expect(engine.state.bricks).toHaveLength(1);
  });
});

describe('lives and game over', () => {
  it('loses one life when the ball falls past the bottom', () => {
    const engine = makeEngine({
      initialBall: { x: WIDTH / 2, y: HEIGHT + 20, vx: 0, vy: 50 },
    });
    expect(engine.state.lives).toBe(3);

    const update = engine.update(100);
    expect(update.lifeLost).toBe(true);
    expect(update.gameOver).toBe(false);
    expect(engine.state.lives).toBe(2);
    expect(engine.state.status).toBe('ready');
    expect(engine.state.ball.attached).toBe(true);
    expect(engine.state.ball.y).toBeCloseTo(PADDLE_TOP - RADIUS, 6);
  });

  it('ends the game after three missed balls', () => {
    const engine = makeEngine({
      rng: () => 0.99,
      initialBricks: [{ row: 0, col: 0 }],
    });

    expect(forceMiss(engine)).toBe(true);
    expect(engine.state.lives).toBe(2);
    expect(engine.state.status).toBe('ready');

    expect(forceMiss(engine)).toBe(true);
    expect(engine.state.lives).toBe(1);
    expect(engine.state.status).toBe('ready');

    expect(forceMiss(engine)).toBe(true);
    expect(engine.state.lives).toBe(0);
    expect(engine.state.status).toBe('gameover');
    expect(engine.state.ball.attached).toBe(true);
    expect(engine.start()).toBe(false);
    expect(engine.update(100).steps).toBe(0);
    expect(engine.state.bricks).toHaveLength(1);
  });

  it('supports a single-life game over through configuration', () => {
    const engine = makeEngine({
      lives: 1,
      initialBall: { x: WIDTH / 2, y: HEIGHT + 20, vx: 0, vy: 50 },
    });
    const update = engine.update(100);
    expect(update.gameOver).toBe(true);
    expect(engine.state.lives).toBe(0);
    expect(engine.state.status).toBe('gameover');
  });
});

describe('level progression', () => {
  it('clears the level and advances to a faster next level', () => {
    const brick = brickAt(createLevelBricks(1));
    const engine = makeEngine({
      initialBricks: [{ row: 0, col: 0 }],
      initialBall: ballUnderBrick(brick),
    });
    engine.movePaddleTo(100);
    engine.setPaddleDirection(1);

    const update = engine.update(20);
    expect(update.levelCleared).toBe(true);
    expect(engine.state.status).toBe('levelclear');
    expect(engine.state.level).toBe(1);
    expect(engine.state.bricks).toHaveLength(0);
    expect(engine.state.score).toBe(DEFAULT_BREAKOUT_CONFIG.scorePerBrick);
    expect(engine.state.ball.vx).toBe(0);
    expect(engine.state.ball.vy).toBe(0);
    expect(engine.update(100).steps).toBe(0);
    expect(engine.start()).toBe(false);
    expect(engine.nextLevel()).toBe(true);
    const next = engine.state;
    expect(next.level).toBe(2);
    expect(next.status).toBe('ready');
    expect(next.ball.attached).toBe(true);
    expect(next.paddle.x).toBeCloseTo(WIDTH / 2, 6);
    expect(next.ball.x).toBeCloseTo(WIDTH / 2, 6);
    expect(next.ballSpeed).toBe(ballSpeedForLevel(2));
    expect(next.ballSpeed).toBeGreaterThan(ballSpeedForLevel(1));
    expect(next.bricks).toHaveLength(
      DEFAULT_BREAKOUT_CONFIG.brickColumns * brickRowsForLevel(2),
    );
    expect(next.score).toBe(DEFAULT_BREAKOUT_CONFIG.scorePerBrick);
    expect(next.lives).toBe(DEFAULT_BREAKOUT_CONFIG.lives);
    expect(engine.nextLevel()).toBe(false);

    expect(engine.start()).toBe(true);
    expect(engine.state.status).toBe('running');
    expect(Math.hypot(engine.state.ball.vx, engine.state.ball.vy)).toBeCloseTo(
      next.ballSpeed,
      6,
    );

    // The fresh level clears the prior level's paddle direction and speed.
    engine.step();
    expect(engine.state.paddle.x).toBeCloseTo(WIDTH / 2, 6);

    engine.restart();
    expect(engine.state.level).toBe(1);
    expect(engine.state.score).toBe(0);
    expect(engine.state.ballSpeed).toBe(ballSpeedForLevel(1));
  });

  it('builds reproducible row-layered brick data with colour tiers', () => {
    expect(brickRowsForLevel(1)).toBe(4);
    expect(brickRowsForLevel(2)).toBe(5);
    expect(brickRowsForLevel(4)).toBe(7);
    expect(brickRowsForLevel(5)).toBe(8);
    expect(brickRowsForLevel(99)).toBe(DEFAULT_BREAKOUT_CONFIG.brickMaxRows);

    expect(brickColorTierForRow(0)).toBe(0);
    expect(brickColorTierForRow(1)).toBe(0);
    expect(brickColorTierForRow(2)).toBe(1);
    expect(brickColorTierForRow(5)).toBe(2);
    expect(brickColorTierForRow(7)).toBe(BRICK_COLOR_TIERS - 1);
    expect(brickColorTierForRow(100)).toBe(BRICK_COLOR_TIERS - 1);

    const bricks = createLevelBricks(5);
    expect(bricks).toHaveLength(
      DEFAULT_BREAKOUT_CONFIG.brickColumns * DEFAULT_BREAKOUT_CONFIG.brickMaxRows,
    );
    expect(new Set(bricks.map((brick) => brick.colorTier))).toEqual(
      new Set([0, 1, 2, 3]),
    );

    for (const brick of bricks) {
      expect(brick.row).toBeGreaterThanOrEqual(0);
      expect(brick.row).toBeLessThan(DEFAULT_BREAKOUT_CONFIG.brickMaxRows);
      expect(brick.col).toBeGreaterThanOrEqual(0);
      expect(brick.col).toBeLessThan(DEFAULT_BREAKOUT_CONFIG.brickColumns);
      expect(brick.x).toBeGreaterThanOrEqual(DEFAULT_BREAKOUT_CONFIG.brickSideMargin);
      expect(
        brick.x + brick.width,
      ).toBeLessThanOrEqual(WIDTH - DEFAULT_BREAKOUT_CONFIG.brickSideMargin + 1e-9);
      expect(brick.y).toBeGreaterThanOrEqual(DEFAULT_BREAKOUT_CONFIG.brickTop);
      expect(brick.y + brick.height).toBeLessThan(PADDLE_TOP);
      expect(brick.colorTier).toBe(brickColorTierForRow(brick.row));
      expect(brick.points).toBe(DEFAULT_BREAKOUT_CONFIG.scorePerBrick);
    }

    const sameLevel = createLevelBricks(5);
    expect(sameLevel).toEqual(bricks);
    expect(sameLevel).not.toBe(bricks);
    const first = brickAt(sameLevel);
    (first as { x: number }).x = -1;
    expect(brickAt(bricks).x).toBeGreaterThanOrEqual(0);
  });

  it('starts at a configured level with the matching layout and speed', () => {
    const engine = makeEngine({ initialLevel: 3 });
    expect(engine.state.level).toBe(3);
    expect(engine.state.status).toBe('ready');
    expect(engine.state.ballSpeed).toBe(ballSpeedForLevel(3));
    expect(engine.state.bricks).toHaveLength(
      DEFAULT_BREAKOUT_CONFIG.brickColumns * brickRowsForLevel(3),
    );
  });

  it('follows a capped speed curve and honours a custom layout configuration', () => {
    expect(ballSpeedForLevel(1)).toBe(BALL_SPEED);
    expect(ballSpeedForLevel(2)).toBe(BALL_SPEED + DEFAULT_BREAKOUT_CONFIG.ballSpeedGain);
    expect(ballSpeedForLevel(5)).toBe(
      BALL_SPEED + 4 * DEFAULT_BREAKOUT_CONFIG.ballSpeedGain,
    );
    expect(ballSpeedForLevel(100)).toBe(DEFAULT_BREAKOUT_CONFIG.maxBallSpeed);
    expect(
      ballSpeedForLevel(3, {
        ballSpeed: 200,
        ballSpeedGain: 50,
        maxBallSpeed: 260,
      }),
    ).toBe(260);

    const custom = createLevelBricks(2, {
      brickColumns: 6,
      brickRows: 1,
      brickMaxRows: 3,
      brickRowsPerLevel: 1,
    });
    expect(custom).toHaveLength(12);
    expect(brickRowsForLevel(2, {
      brickColumns: 6,
      brickRows: 1,
      brickMaxRows: 3,
      brickRowsPerLevel: 1,
    })).toBe(2);
  });
});

describe('fixed-step updates', () => {
  it('advances physics by an exact fixed step', () => {
    const engine = makeEngine({
      initialBall: { x: 200, y: 400, vx: 120, vy: -240 },
    });
    const before = engine.state.ball;
    engine.step();
    const after = engine.state.ball;

    expect(after.x - before.x).toBeCloseTo(120 * (FIXED_STEP_MS / 1000), 6);
    expect(after.y - before.y).toBeCloseTo(-240 * (FIXED_STEP_MS / 1000), 6);
  });

  it('accumulates frame time into whole fixed steps', () => {
    const engine = makeEngine({
      initialBall: { x: WIDTH / 2, y: 300, vx: 0, vy: 0 },
    });

    const frame = engine.update(100);
    expect(frame.steps).toBe(12);
    expect(frame.status).toBe('running');
    expect(engine.update(10).steps).toBe(1);
    expect(engine.update(-5).steps).toBe(0);
    expect(engine.update(Number.NaN).steps).toBe(0);
  });

  it('does not depend on how a total frame time is partitioned', () => {
    const options: BreakoutEngineOptions = {
      initialBall: { x: 200, y: 300, vx: 37, vy: -53 },
    };
    const single = makeEngine(options);
    const partitioned = makeEngine(options);

    expect(single.update(150).steps).toBe(18);
    for (let frame = 0; frame < 3; frame += 1) {
      partitioned.update(50);
    }
    expect(partitioned.state.ball).toEqual(single.state.ball);
  });

  it('caps an outsized frame gap instead of simulating all of it', () => {
    const engine = makeEngine({
      initialBall: { x: WIDTH / 2, y: 300, vx: 0, vy: 0 },
    });
    expect(engine.update(250).steps).toBe(30);
    expect(engine.update(10_000).steps).toBe(30);
  });
});

describe('serving randomness', () => {
  it('uses the injected random source for the initial serve direction', () => {
    const left = makeEngine({ rng: () => 0.1 });
    expect(left.start()).toBe(true);
    expect(left.state.ball.vx).toBeLessThan(0);
    expect(left.state.ball.vy).toBeLessThan(0);
    expect(Math.hypot(left.state.ball.vx, left.state.ball.vy)).toBeCloseTo(
      BALL_SPEED,
      6,
    );

    const right = makeEngine({ rng: () => 0.9 });
    expect(right.start()).toBe(true);
    expect(right.state.ball.vx).toBeGreaterThan(0);
    expect(right.state.ball.vy).toBeLessThan(0);
  });

  it('is deterministic when seeded', () => {
    const first = makeEngine({ rng: createSeededRng(42) });
    const second = makeEngine({ rng: createSeededRng(42) });
    first.start();
    second.start();
    expect(first.state.ball).toEqual(second.state.ball);
  });

  it('handles a broken random source without breaking the serve', () => {
    const engine = makeEngine({ rng: () => Number.NaN });
    expect(engine.start()).toBe(true);
    expect(Number.isFinite(engine.state.ball.vx)).toBe(true);
    expect(Number.isFinite(engine.state.ball.vy)).toBe(true);
    expect(Math.hypot(engine.state.ball.vx, engine.state.ball.vy)).toBeCloseTo(
      BALL_SPEED,
      6,
    );
  });
});

describe('restart', () => {
  it('resets score, lives, level, paddle and ball to a fresh game', () => {
    const engine = makeEngine({ rng: () => 0.99 });
    expect(forceMiss(engine)).toBe(true);
    expect(engine.state.lives).toBe(2);
    engine.movePaddleTo(100);
    engine.start();
    engine.setPaddleDirection(1);
    expect(engine.state.status).toBe('running');

    engine.restart();
    const state = engine.state;
    expect(state.score).toBe(0);
    expect(state.lives).toBe(DEFAULT_BREAKOUT_CONFIG.lives);
    expect(state.level).toBe(1);
    expect(state.status).toBe('ready');
    expect(state.ball.attached).toBe(true);
    expect(state.ball.x).toBeCloseTo(WIDTH / 2, 6);
    expect(state.paddle.x).toBeCloseTo(WIDTH / 2, 6);
    expect(state.ballSpeed).toBe(ballSpeedForLevel(1));
    expect(state.bricks).toHaveLength(
      DEFAULT_BREAKOUT_CONFIG.brickColumns * DEFAULT_BREAKOUT_CONFIG.brickRows,
    );

    engine.step();
    expect(engine.state.paddle.x).toBeCloseTo(WIDTH / 2, 6);
  });

  it('resets score and restores configured custom starting bricks after a restart', () => {
    const brick = brickAt(createLevelBricks(1));
    const engine = makeEngine({
      initialBricks: [
        { row: 0, col: 0 },
        { row: 0, col: 9 },
      ],
      initialBall: ballUnderBrick(brick),
    });
    engine.update(20);
    expect(engine.state.score).toBe(DEFAULT_BREAKOUT_CONFIG.scorePerBrick);
    engine.movePaddleTo(120);
    engine.restart();

    expect(engine.state.score).toBe(0);
    expect(engine.state.level).toBe(1);
    expect(engine.state.lives).toBe(DEFAULT_BREAKOUT_CONFIG.lives);
    expect(engine.state.ballSpeed).toBe(ballSpeedForLevel(1));
    expect(engine.state.bricks).toHaveLength(2);
    expect(engine.state.bricks.map((brick) => brick.id)).toEqual([0, 1]);
    // initialBall keeps custom-state engines running after a restart.
    expect(engine.state.status).toBe('running');
  });
});

describe('snapshots and validation', () => {
  it('returns defensive copies of mutable state', () => {
    const engine = makeEngine();
    const snapshot = engine.state;
    (snapshot.ball as { x: number }).x = -1;
    const brick = brickAt(snapshot.bricks);
    (brick as { x: number }).x = -1;

    expect(engine.state.ball.x).not.toBe(-1);
    expect(engine.state.bricks[0]?.x).not.toBe(-1);
    expect(engine.state.bricks).toHaveLength(
      DEFAULT_BREAKOUT_CONFIG.brickColumns * DEFAULT_BREAKOUT_CONFIG.brickRows,
    );
  });

  it('rejects invalid configuration and starting state', () => {
    expect(() => new BreakoutEngine({ width: 0 })).toThrow(RangeError);
    expect(() => new BreakoutEngine({ paddleWidth: WIDTH + 1 })).toThrow(RangeError);
    expect(() => new BreakoutEngine({ paddleBottomMargin: HEIGHT })).toThrow(RangeError);
    expect(() => new BreakoutEngine({ lives: 0 })).toThrow(RangeError);
    expect(() => new BreakoutEngine({ maxBallSpeed: 1 })).toThrow(RangeError);
    expect(
      () => new BreakoutEngine({ ballSpeed: 5_000, maxBallSpeed: 5_000 }),
    ).toThrow(RangeError);
    expect(() => new BreakoutEngine({ serveAngleDegrees: 90 })).toThrow(RangeError);
    expect(() => new BreakoutEngine({ maxBounceAngleDegrees: 0 })).toThrow(RangeError);
    expect(() => new BreakoutEngine({ initialLevel: 0 })).toThrow(RangeError);
    expect(() => new BreakoutEngine({ initialBricks: [] })).toThrow(RangeError);
    expect(
      () =>
        new BreakoutEngine({
          initialBricks: [{ row: 0, col: DEFAULT_BREAKOUT_CONFIG.brickColumns }],
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new BreakoutEngine({
          initialBall: { x: Number.NaN, y: 300, vx: 0, vy: 0 },
        }),
    ).toThrow(RangeError);
  });
});
