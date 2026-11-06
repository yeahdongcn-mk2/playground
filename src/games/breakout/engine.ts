/**
 * Framework-agnostic Breakout rules.
 *
 * The engine never touches the DOM, Phaser, timers or storage. A renderer owns
 * drawing, input and the animation loop, then calls `update(deltaMs)` for a
 * fixed-step simulation and reads immutable snapshots. Keeping collisions,
 * scoring, lives and level progression here makes them fast to unit test and
 * lets the scene and a future replay viewer share one state machine.
 *
 * Coordinates use a logical court of `width` x `height` units with the origin
 * at the top-left. Ball positions are centres, paddle positions are centres,
 * and brick positions are top-left corners so a renderer can draw them
 * directly.
 *
 * There is no paused status: the renderer owns the loop, so it pauses the game
 * by simply not calling `update()` and resumes with the next call.
 */

/** The simulation always advances in steps of this many milliseconds. */
export const FIXED_STEP_MS = 1000 / 120;

const FIXED_STEP_SECONDS = FIXED_STEP_MS / 1000;

/** Ignore huge frame gaps (tab switches) instead of simulating them in one go. */
const MAX_UPDATE_MS = 250;

/** Number of colour tiers a level can use; the renderer owns the actual colours. */
export const BRICK_COLOR_TIERS = 4;

const ROWS_PER_COLOR_TIER = 2;

/** -1 moves left, 1 moves right and 0 holds the paddle. */
export type PaddleDirection = -1 | 0 | 1;

/**
 * `ready` holds the ball on the paddle until `start()`. `running` is active
 * play. `levelclear` waits for `nextLevel()`. `gameover` waits for a restart.
 */
export type BreakoutStatus = 'ready' | 'running' | 'levelclear' | 'gameover';

export interface BreakoutConfig {
  /** Logical court width in game units. */
  readonly width: number;
  /** Logical court height in game units. */
  readonly height: number;
  readonly paddleWidth: number;
  readonly paddleHeight: number;
  /** Paddle travel speed in units per second. */
  readonly paddleSpeed: number;
  /** Gap between the paddle's bottom edge and the bottom of the court. */
  readonly paddleBottomMargin: number;
  readonly ballRadius: number;
  /** Initial ball speed in units per second. */
  readonly ballSpeed: number;
  /** Extra ball speed for every level after the first. */
  readonly ballSpeedGain: number;
  /** Upper bound for the level speed curve. */
  readonly maxBallSpeed: number;
  /** Lives at the start of a fresh game. */
  readonly lives: number;
  readonly brickColumns: number;
  /** Brick rows on level 1. */
  readonly brickRows: number;
  /** Maximum bricks rows as levels get harder. */
  readonly brickMaxRows: number;
  /** Additional rows per level, up to `brickMaxRows`. */
  readonly brickRowsPerLevel: number;
  /** Distance from the top of the court to the first brick row. */
  readonly brickTop: number;
  /** Horizontal gap between the court wall and the brick grid. */
  readonly brickSideMargin: number;
  readonly brickGap: number;
  readonly brickHeight: number;
  /** Points awarded for destroying one brick. */
  readonly scorePerBrick: number;
  /** Direction of the initial serve, measured from straight up. */
  readonly serveAngleDegrees: number;
  /** Most extreme paddle rebound angle, reached when the ball hits an edge. */
  readonly maxBounceAngleDegrees: number;
}

export const DEFAULT_BREAKOUT_CONFIG: Readonly<BreakoutConfig> = Object.freeze({
  width: 480,
  height: 720,
  paddleWidth: 96,
  paddleHeight: 14,
  paddleSpeed: 620,
  paddleBottomMargin: 36,
  ballRadius: 8,
  ballSpeed: 320,
  ballSpeedGain: 40,
  maxBallSpeed: 680,
  lives: 3,
  brickColumns: 10,
  brickRows: 4,
  brickMaxRows: 8,
  brickRowsPerLevel: 1,
  brickTop: 72,
  brickSideMargin: 24,
  brickGap: 4,
  brickHeight: 24,
  scorePerBrick: 10,
  serveAngleDegrees: 30,
  maxBounceAngleDegrees: 60,
});

/** A brick position in grid coordinates, used for custom starting layouts. */
export interface BrickSpec {
  readonly row: number;
  readonly col: number;
  /** Colour tier override; defaults to the row's tier. */
  readonly colorTier?: number;
  /** Point value override; defaults to `scorePerBrick`. */
  readonly points?: number;
}

/** One destructible brick. Coordinates are top-left based. */
export interface Brick {
  readonly id: number;
  readonly row: number;
  readonly col: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Palette slot; the renderer chooses the concrete colour. */
  readonly colorTier: number;
  readonly points: number;
}

export interface PaddleSnapshot {
  /** Horizontal centre of the paddle. */
  readonly x: number;
  /** Top edge of the paddle. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BallSnapshot {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly vx: number;
  readonly vy: number;
  /** True while the ball rests on the paddle waiting for a serve. */
  readonly attached: boolean;
}

export interface BreakoutSnapshot {
  readonly width: number;
  readonly height: number;
  readonly paddle: PaddleSnapshot;
  readonly ball: BallSnapshot;
  readonly bricks: readonly Brick[];
  readonly score: number;
  readonly lives: number;
  readonly level: number;
  /** Speed applied on the next serve and paddle rebound. */
  readonly ballSpeed: number;
  readonly status: BreakoutStatus;
}

export interface InitialBall {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

export interface BreakoutEngineOptions extends Partial<BreakoutConfig> {
  /** Source of randomness in the range [0, 1). Injectable for deterministic tests. */
  readonly rng?: () => number;
  /** Level used by the constructor and restart. Defaults to 1. */
  readonly initialLevel?: number;
  /**
   * Custom starting bricks, primarily for tests and replays. When omitted the
   * level layout is generated for `initialLevel`. Must not be empty. These
   * bricks are restored by a restart; `nextLevel()` always generates the next
   * level's standard layout.
   */
  readonly initialBricks?: readonly BrickSpec[];
  /**
   * Exact starting ball, primarily for tests and replays. When present the
   * engine starts in `running` with this ball instead of `ready` with it on the
   * paddle.
   */
  readonly initialBall?: InitialBall;
}

/** Result of exactly one fixed simulation step. */
export interface BreakoutStep {
  readonly destroyedBricks: readonly Brick[];
  readonly scoreGained: number;
  readonly lifeLost: boolean;
  readonly levelCleared: boolean;
  readonly gameOver: boolean;
  readonly status: BreakoutStatus;
}

/** Result of an `update()` call, which may contain several fixed steps. */
export interface BreakoutUpdate extends BreakoutStep {
  /** Number of fixed steps simulated by this call. */
  readonly steps: number;
}

interface MutableBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
  attached: boolean;
}

interface StepAccumulator {
  destroyedBricks: Brick[];
  scoreGained: number;
  lifeLost: boolean;
  levelCleared: boolean;
  gameOver: boolean;
}

/** Small, fast, deterministic PRNG (mulberry32). */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Clamp one numeric value into an inclusive range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return 1;
  }
  return Math.max(1, Math.floor(level));
}

/** Brick rows generated for a level, capped by `brickMaxRows`. */
export function brickRowsForLevel(
  level: number,
  overrides: Partial<BreakoutConfig> = {},
): number {
  const config = resolveConfig(overrides);
  const normalized = normalizeLevel(level);
  return Math.min(
    config.brickMaxRows,
    config.brickRows + (normalized - 1) * config.brickRowsPerLevel,
  );
}

/** Ball speed for a level; the curve rises by `ballSpeedGain` and stays capped. */
export function ballSpeedForLevel(
  level: number,
  overrides: Partial<BreakoutConfig> = {},
): number {
  const config = resolveConfig(overrides);
  const normalized = normalizeLevel(level);
  return Math.min(
    config.maxBallSpeed,
    config.ballSpeed + (normalized - 1) * config.ballSpeedGain,
  );
}

/**
 * Colour tier for a brick row. Rows are grouped in pairs, so a four-tier level
 * has one tier per two rows and the renderer can draw clear horizontal bands.
 */
export function brickColorTierForRow(row: number): number {
  const safeRow = Number.isFinite(row) ? Math.max(0, Math.floor(row)) : 0;
  return Math.min(BRICK_COLOR_TIERS - 1, Math.floor(safeRow / ROWS_PER_COLOR_TIER));
}

/**
 * Build one level's brick layout. Layout depends only on the level and the
 * configuration, never on the random source, so a level is reproducible.
 */
export function createLevelBricks(
  level: number,
  overrides: Partial<BreakoutConfig> = {},
): Brick[] {
  const config = resolveConfig(overrides);
  return buildLevelBricks(normalizeLevel(level), config);
}

function buildLevelBricks(level: number, config: BreakoutConfig): Brick[] {
  const rows = brickRowsForLevel(level, config);
  const brickWidth = brickWidthFor(config);
  const bricks: Brick[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < config.brickColumns; col += 1) {
      bricks.push({
        id: row * config.brickColumns + col,
        row,
        col,
        x: config.brickSideMargin + col * (brickWidth + config.brickGap),
        y: config.brickTop + row * (config.brickHeight + config.brickGap),
        width: brickWidth,
        height: config.brickHeight,
        colorTier: brickColorTierForRow(row),
        points: config.scorePerBrick,
      });
    }
  }
  return bricks;
}

function brickWidthFor(config: BreakoutConfig): number {
  return (
    (config.width -
      2 * config.brickSideMargin -
      (config.brickColumns - 1) * config.brickGap) /
    config.brickColumns
  );
}

function copyBrick(brick: Brick): Brick {
  return { ...brick };
}

function resolveConfig(overrides: Partial<BreakoutConfig>): BreakoutConfig {
  const config: BreakoutConfig = {
    width: overrides.width ?? DEFAULT_BREAKOUT_CONFIG.width,
    height: overrides.height ?? DEFAULT_BREAKOUT_CONFIG.height,
    paddleWidth: overrides.paddleWidth ?? DEFAULT_BREAKOUT_CONFIG.paddleWidth,
    paddleHeight: overrides.paddleHeight ?? DEFAULT_BREAKOUT_CONFIG.paddleHeight,
    paddleSpeed: overrides.paddleSpeed ?? DEFAULT_BREAKOUT_CONFIG.paddleSpeed,
    paddleBottomMargin:
      overrides.paddleBottomMargin ?? DEFAULT_BREAKOUT_CONFIG.paddleBottomMargin,
    ballRadius: overrides.ballRadius ?? DEFAULT_BREAKOUT_CONFIG.ballRadius,
    ballSpeed: overrides.ballSpeed ?? DEFAULT_BREAKOUT_CONFIG.ballSpeed,
    ballSpeedGain: overrides.ballSpeedGain ?? DEFAULT_BREAKOUT_CONFIG.ballSpeedGain,
    maxBallSpeed: overrides.maxBallSpeed ?? DEFAULT_BREAKOUT_CONFIG.maxBallSpeed,
    lives: overrides.lives ?? DEFAULT_BREAKOUT_CONFIG.lives,
    brickColumns: overrides.brickColumns ?? DEFAULT_BREAKOUT_CONFIG.brickColumns,
    brickRows: overrides.brickRows ?? DEFAULT_BREAKOUT_CONFIG.brickRows,
    brickMaxRows: overrides.brickMaxRows ?? DEFAULT_BREAKOUT_CONFIG.brickMaxRows,
    brickRowsPerLevel:
      overrides.brickRowsPerLevel ?? DEFAULT_BREAKOUT_CONFIG.brickRowsPerLevel,
    brickTop: overrides.brickTop ?? DEFAULT_BREAKOUT_CONFIG.brickTop,
    brickSideMargin:
      overrides.brickSideMargin ?? DEFAULT_BREAKOUT_CONFIG.brickSideMargin,
    brickGap: overrides.brickGap ?? DEFAULT_BREAKOUT_CONFIG.brickGap,
    brickHeight: overrides.brickHeight ?? DEFAULT_BREAKOUT_CONFIG.brickHeight,
    scorePerBrick: overrides.scorePerBrick ?? DEFAULT_BREAKOUT_CONFIG.scorePerBrick,
    serveAngleDegrees:
      overrides.serveAngleDegrees ?? DEFAULT_BREAKOUT_CONFIG.serveAngleDegrees,
    maxBounceAngleDegrees:
      overrides.maxBounceAngleDegrees ?? DEFAULT_BREAKOUT_CONFIG.maxBounceAngleDegrees,
  };
  validateConfig(config);
  return config;
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number.`);
  }
}

function assertPositive(name: string, value: number): void {
  assertFinite(name, value);
  if (value <= 0) {
    throw new RangeError(`${name} must be greater than 0.`);
  }
}

function assertNonNegative(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0) {
    throw new RangeError(`${name} must not be negative.`);
  }
}

function assertIntegerAtLeast(name: string, value: number, minimum: number): void {
  assertFinite(name, value);
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer of at least ${minimum}.`);
  }
}

function assertAngle(name: string, value: number): void {
  assertFinite(name, value);
  if (value <= 0 || value >= 90) {
    throw new RangeError(
      `${name} must be greater than 0 and less than 90 degrees.`,
    );
  }
}

function validateConfig(config: BreakoutConfig): void {
  assertPositive('width', config.width);
  assertPositive('height', config.height);
  assertPositive('paddleWidth', config.paddleWidth);
  assertPositive('paddleHeight', config.paddleHeight);
  assertPositive('paddleSpeed', config.paddleSpeed);
  assertNonNegative('paddleBottomMargin', config.paddleBottomMargin);
  assertPositive('ballRadius', config.ballRadius);
  assertPositive('ballSpeed', config.ballSpeed);
  assertNonNegative('ballSpeedGain', config.ballSpeedGain);
  assertPositive('maxBallSpeed', config.maxBallSpeed);
  assertIntegerAtLeast('lives', config.lives, 1);
  assertIntegerAtLeast('brickColumns', config.brickColumns, 1);
  assertIntegerAtLeast('brickRows', config.brickRows, 1);
  assertIntegerAtLeast('brickMaxRows', config.brickMaxRows, config.brickRows);
  assertIntegerAtLeast('brickRowsPerLevel', config.brickRowsPerLevel, 0);
  assertNonNegative('brickTop', config.brickTop);
  assertNonNegative('brickSideMargin', config.brickSideMargin);
  assertNonNegative('brickGap', config.brickGap);
  assertPositive('brickHeight', config.brickHeight);
  assertNonNegative('scorePerBrick', config.scorePerBrick);
  assertAngle('serveAngleDegrees', config.serveAngleDegrees);
  assertAngle('maxBounceAngleDegrees', config.maxBounceAngleDegrees);

  if (config.paddleWidth > config.width) {
    throw new RangeError('paddleWidth must not exceed width.');
  }
  if (config.paddleBottomMargin + config.paddleHeight >= config.height) {
    throw new RangeError('paddleBottomMargin and paddleHeight must fit inside height.');
  }
  if (config.ballRadius * 2 >= config.width || config.ballRadius * 2 >= config.height) {
    throw new RangeError('ballRadius must be smaller than half the court.');
  }
  if (config.ballSpeed > config.maxBallSpeed) {
    throw new RangeError('ballSpeed must not exceed maxBallSpeed.');
  }
  const maxStepDistance = config.maxBallSpeed * FIXED_STEP_SECONDS;
  const thinnestSurface = Math.min(config.brickHeight, config.paddleHeight);
  if (maxStepDistance >= thinnestSurface + 2 * config.ballRadius) {
    throw new RangeError(
      'maxBallSpeed is too high for the configured ball and surface sizes; ' +
        'the ball could tunnel through a brick or the paddle.',
    );
  }
  if (brickWidthFor(config) <= 0) {
    throw new RangeError('brick columns, margins and gaps must leave room for a brick.');
  }
  const brickBottom =
    config.brickTop +
    (config.brickMaxRows - 1) * (config.brickHeight + config.brickGap) +
    config.brickHeight;
  const paddleTop = config.height - config.paddleBottomMargin - config.paddleHeight;
  if (brickBottom >= paddleTop) {
    throw new RangeError('The brick grid must end above the paddle.');
  }
}

function validateBrickSpecs(specs: readonly BrickSpec[], config: BreakoutConfig): void {
  if (specs.length === 0) {
    throw new RangeError('initialBricks must contain at least one brick.');
  }
  for (const spec of specs) {
    assertIntegerAtLeast('initialBricks[].row', spec.row, 0);
    assertIntegerAtLeast('initialBricks[].col', spec.col, 0);
    if (spec.row >= config.brickMaxRows) {
      throw new RangeError(`initialBricks[].row must be below ${config.brickMaxRows}.`);
    }
    if (spec.col >= config.brickColumns) {
      throw new RangeError(`initialBricks[].col must be below ${config.brickColumns}.`);
    }
    if (spec.colorTier !== undefined) {
      assertIntegerAtLeast('initialBricks[].colorTier', spec.colorTier, 0);
    }
    if (spec.points !== undefined) {
      assertNonNegative('initialBricks[].points', spec.points);
    }
  }
}

function validateInitialBall(ball: InitialBall): void {
  assertFinite('initialBall.x', ball.x);
  assertFinite('initialBall.y', ball.y);
  assertFinite('initialBall.vx', ball.vx);
  assertFinite('initialBall.vy', ball.vy);
}

/** Circle against axis-aligned rectangle, used for paddle and brick hits. */
function circleIntersectsRect(
  cx: number,
  cy: number,
  radius: number,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): boolean {
  const nearestX = clamp(cx, rect.x, rect.x + rect.width);
  const nearestY = clamp(cy, rect.y, rect.y + rect.height);
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

export class BreakoutEngine {
  readonly width: number;
  readonly height: number;

  private readonly config: BreakoutConfig;
  private readonly rng: () => number;
  private readonly initialLevel: number;
  private readonly initialBricks: readonly BrickSpec[] | null;
  private readonly initialBall: Readonly<MutableBall> | null;

  private bricks: Brick[] = [];
  private ball: MutableBall = { x: 0, y: 0, vx: 0, vy: 0, attached: true };
  private paddleX = 0;
  private paddleDirection: PaddleDirection = 0;
  private ballSpeed = 0;
  private score = 0;
  private lives = 0;
  private level = 1;
  private status: BreakoutStatus = 'ready';
  private accumulatorMs = 0;

  constructor(options: BreakoutEngineOptions = {}) {
    const { rng, initialLevel, initialBricks, initialBall, ...configOverrides } = options;
    this.config = resolveConfig(configOverrides);
    this.width = this.config.width;
    this.height = this.config.height;

    this.rng = rng ?? Math.random;

    if (initialLevel !== undefined) {
      assertIntegerAtLeast('initialLevel', initialLevel, 1);
    }
    this.initialLevel = initialLevel ?? 1;

    if (initialBricks) {
      validateBrickSpecs(initialBricks, this.config);
      this.initialBricks = initialBricks.map((spec) => ({ ...spec }));
    } else {
      this.initialBricks = null;
    }

    if (initialBall) {
      validateInitialBall(initialBall);
      this.initialBall = { ...initialBall, attached: false };
    } else {
      this.initialBall = null;
    }

    this.reset();
  }

  /** Immutable view of everything a renderer needs for one frame. */
  get state(): BreakoutSnapshot {
    return {
      width: this.width,
      height: this.height,
      paddle: {
        x: this.paddleX,
        y: this.paddleTop,
        width: this.config.paddleWidth,
        height: this.config.paddleHeight,
      },
      ball: {
        x: this.ball.x,
        y: this.ball.y,
        radius: this.config.ballRadius,
        vx: this.ball.vx,
        vy: this.ball.vy,
        attached: this.ball.attached,
      },
      bricks: this.bricks.map(copyBrick),
      score: this.score,
      lives: this.lives,
      level: this.level,
      ballSpeed: this.ballSpeed,
      status: this.status,
    };
  }

  get currentStatus(): BreakoutStatus {
    return this.status;
  }

  /** Start the current level's serve. Returns false when not waiting on a serve. */
  start(): boolean {
    if (this.status !== 'ready' || !this.ball.attached) {
      return false;
    }
    const direction = this.random() < 0.5 ? -1 : 1;
    const angle = (this.config.serveAngleDegrees * Math.PI) / 180;
    this.ball.vx = direction * Math.sin(angle) * this.ballSpeed;
    this.ball.vy = -Math.cos(angle) * this.ballSpeed;
    this.ball.attached = false;
    this.status = 'running';
    this.accumulatorMs = 0;
    return true;
  }

  /** Reset score, lives, level, bricks and ball to a fresh game. */
  restart(): void {
    this.reset();
  }

  /**
   * Advance from `levelclear` to a fresh copy of the next level. Returns false
   * when the current level is still in play.
   */
  nextLevel(): boolean {
    if (this.status !== 'levelclear') {
      return false;
    }
    this.level += 1;
    this.ballSpeed = ballSpeedForLevel(this.level, this.config);
    this.bricks = buildLevelBricks(this.level, this.config);
    this.paddleX = this.width / 2;
    this.paddleDirection = 0;
    this.accumulatorMs = 0;
    this.attachBall();
    this.status = 'ready';
    return true;
  }

  /** Hold the paddle still (0), move it left (-1) or right (1). */
  setPaddleDirection(direction: PaddleDirection): void {
    if (direction !== -1 && direction !== 0 && direction !== 1) {
      throw new RangeError(`Unknown paddle direction: ${String(direction)}.`);
    }
    this.paddleDirection = direction;
  }

  /** Move the paddle by `deltaX` units immediately, clamping it to the court. */
  movePaddle(deltaX: number): void {
    if (!Number.isFinite(deltaX)) {
      return;
    }
    this.paddleX = this.clampPaddle(this.paddleX + deltaX);
    this.syncAttachedBall();
  }

  /** Teleport the paddle so its centre is at `centerX`, clamped to the court. */
  movePaddleTo(centerX: number): void {
    if (!Number.isFinite(centerX)) {
      return;
    }
    this.paddleX = this.clampPaddle(centerX);
    this.syncAttachedBall();
  }

  /**
   * Advance the simulation by `deltaMs` milliseconds using fixed simulation
   * steps. The accumulator carries the remainder into the next call, so frame
   * times do not change the physics. Huge gaps are capped at 250 ms.
   */
  update(deltaMs: number): BreakoutUpdate {
    const accumulator: StepAccumulator = {
      destroyedBricks: [],
      scoreGained: 0,
      lifeLost: false,
      levelCleared: false,
      gameOver: false,
    };

    if (this.status === 'levelclear' || this.status === 'gameover') {
      this.accumulatorMs = 0;
      return this.finishUpdate(0, accumulator);
    }
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      return this.finishUpdate(0, accumulator);
    }

    this.accumulatorMs += Math.min(deltaMs, MAX_UPDATE_MS);
    let steps = 0;
    while (this.accumulatorMs + 1e-9 >= FIXED_STEP_MS) {
      const step = this.step();
      steps += 1;
      accumulator.destroyedBricks.push(...step.destroyedBricks);
      accumulator.scoreGained += step.scoreGained;
      accumulator.lifeLost ||= step.lifeLost;
      accumulator.levelCleared ||= step.levelCleared;
      accumulator.gameOver ||= step.gameOver;
      this.accumulatorMs -= FIXED_STEP_MS;
      if (this.accumulatorMs < 0) {
        this.accumulatorMs = 0;
      }
      if (step.status === 'levelclear' || step.status === 'gameover') {
        this.accumulatorMs = 0;
        break;
      }
    }
    return this.finishUpdate(steps, accumulator);
  }

  /** Advance exactly one fixed simulation step. */
  step(): BreakoutStep {
    const accumulator: StepAccumulator = {
      destroyedBricks: [],
      scoreGained: 0,
      lifeLost: false,
      levelCleared: false,
      gameOver: false,
    };

    if (this.status === 'ready' || this.status === 'running') {
      this.movePaddleByDirection(FIXED_STEP_SECONDS);
      this.syncAttachedBall();
    }
    if (this.status === 'running') {
      this.advanceBall(FIXED_STEP_SECONDS, accumulator);
    }

    return {
      destroyedBricks: accumulator.destroyedBricks,
      scoreGained: accumulator.scoreGained,
      lifeLost: accumulator.lifeLost,
      levelCleared: accumulator.levelCleared,
      gameOver: accumulator.gameOver,
      status: this.status,
    };
  }

  private get paddleTop(): number {
    return this.height - this.config.paddleBottomMargin - this.config.paddleHeight;
  }

  private clampPaddle(centerX: number): number {
    const halfWidth = this.config.paddleWidth / 2;
    return clamp(centerX, halfWidth, this.width - halfWidth);
  }

  private movePaddleByDirection(seconds: number): void {
    if (this.paddleDirection === 0) {
      return;
    }
    this.paddleX = this.clampPaddle(
      this.paddleX + this.paddleDirection * this.config.paddleSpeed * seconds,
    );
  }

  private syncAttachedBall(): void {
    if (!this.ball.attached) {
      return;
    }
    this.ball.x = this.paddleX;
    this.ball.y = this.paddleTop - this.config.ballRadius;
    this.ball.vx = 0;
    this.ball.vy = 0;
  }

  private attachBall(): void {
    this.ball.attached = true;
    this.syncAttachedBall();
  }

  private advanceBall(seconds: number, accumulator: StepAccumulator): void {
    if (this.ball.attached) {
      return;
    }
    const previousBottom = this.ball.y + this.config.ballRadius;
    this.ball.x += this.ball.vx * seconds;
    this.ball.y += this.ball.vy * seconds;
    this.bounceOffWalls();
    if (this.collidesWithPaddle() && this.ball.vy > 0) {
      if (previousBottom <= this.paddleTop) {
        this.bounceOffPaddle();
      } else {
        // The ball was already level with the paddle, so this is a side graze
        // rather than a top-face save; nudge it out without teleporting it up.
        this.bounceOffPaddleSide();
      }
    }
    this.collideWithBricks(accumulator);
    if (this.status === 'running' && this.ball.y - this.config.ballRadius > this.height) {
      this.loseLife(accumulator);
    }
  }

  private bounceOffWalls(): void {
    const radius = this.config.ballRadius;
    if (this.ball.x - radius < 0) {
      this.ball.x = radius;
      if (this.ball.vx < 0) {
        this.ball.vx = -this.ball.vx;
      }
    } else if (this.ball.x + radius > this.width) {
      this.ball.x = this.width - radius;
      if (this.ball.vx > 0) {
        this.ball.vx = -this.ball.vx;
      }
    }
    if (this.ball.y - radius < 0) {
      this.ball.y = radius;
      if (this.ball.vy < 0) {
        this.ball.vy = -this.ball.vy;
      }
    }
  }

  private collidesWithPaddle(): boolean {
    const halfWidth = this.config.paddleWidth / 2;
    // A ball whose centre is already below the paddle has missed it; without
    // this guard the circle/rectangle test would "save" it from underneath.
    if (this.ball.y > this.paddleTop + this.config.paddleHeight) {
      return false;
    }
    return circleIntersectsRect(
      this.ball.x,
      this.ball.y,
      this.config.ballRadius,
      {
        x: this.paddleX - halfWidth,
        y: this.paddleTop,
        width: this.config.paddleWidth,
        height: this.config.paddleHeight,
      },
    );
  }

  private bounceOffPaddle(): void {
    const halfWidth = this.config.paddleWidth / 2;
    const offset = clamp((this.ball.x - this.paddleX) / halfWidth, -1, 1);
    const angle = (offset * this.config.maxBounceAngleDegrees * Math.PI) / 180;
    this.ball.y = this.paddleTop - this.config.ballRadius;
    this.ball.vx = Math.sin(angle) * this.ballSpeed;
    this.ball.vy = -Math.abs(Math.cos(angle) * this.ballSpeed);
  }

  private bounceOffPaddleSide(): void {
    const halfWidth = this.config.paddleWidth / 2;
    const left = this.paddleX - halfWidth;
    const right = this.paddleX + halfWidth;
    if (this.ball.x < this.paddleX) {
      this.ball.x = Math.max(this.config.ballRadius, left - this.config.ballRadius);
      this.ball.vx = -Math.abs(this.ball.vx);
    } else {
      this.ball.x = Math.min(this.width - this.config.ballRadius, right + this.config.ballRadius);
      this.ball.vx = Math.abs(this.ball.vx);
    }
  }

  private collideWithBricks(accumulator: StepAccumulator): void {
    for (let index = 0; index < this.bricks.length; index += 1) {
      const brick = this.bricks[index];
      if (!brick) {
        continue;
      }
      if (
        !circleIntersectsRect(
          this.ball.x,
          this.ball.y,
          this.config.ballRadius,
          brick,
        )
      ) {
        continue;
      }

      this.bricks.splice(index, 1);
      this.score += brick.points;
      accumulator.scoreGained += brick.points;
      accumulator.destroyedBricks.push(copyBrick(brick));
      this.bounceOffBrick(brick);

      if (this.bricks.length === 0) {
        this.status = 'levelclear';
        this.ball.vx = 0;
        this.ball.vy = 0;
        accumulator.levelCleared = true;
      }
      // At most one brick is resolved per step so the rebound direction is
      // unambiguous; neighbouring bricks are handled on following steps.
      return;
    }
  }

  private bounceOffBrick(brick: Brick): void {
    const radius = this.config.ballRadius;
    const overlapX = Math.min(
      this.ball.x + radius - brick.x,
      brick.x + brick.width - (this.ball.x - radius),
    );
    const overlapY = Math.min(
      this.ball.y + radius - brick.y,
      brick.y + brick.height - (this.ball.y - radius),
    );

    if (overlapX < overlapY) {
      this.ball.vx =
        this.ball.x < brick.x + brick.width / 2
          ? -Math.abs(this.ball.vx)
          : Math.abs(this.ball.vx);
    } else {
      this.ball.vy =
        this.ball.y < brick.y + brick.height / 2
          ? -Math.abs(this.ball.vy)
          : Math.abs(this.ball.vy);
    }
  }

  private loseLife(accumulator: StepAccumulator): void {
    this.lives = Math.max(0, this.lives - 1);
    accumulator.lifeLost = true;
    this.attachBall();
    if (this.lives === 0) {
      this.status = 'gameover';
      accumulator.gameOver = true;
    } else {
      this.status = 'ready';
    }
  }

  private finishUpdate(steps: number, accumulator: StepAccumulator): BreakoutUpdate {
    return {
      steps,
      destroyedBricks: accumulator.destroyedBricks,
      scoreGained: accumulator.scoreGained,
      lifeLost: accumulator.lifeLost,
      levelCleared: accumulator.levelCleared,
      gameOver: accumulator.gameOver,
      status: this.status,
    };
  }

  private reset(): void {
    this.score = 0;
    this.lives = this.config.lives;
    this.level = this.initialLevel;
    this.ballSpeed = ballSpeedForLevel(this.level, this.config);
    this.bricks = this.initialBricks
      ? this.buildCustomBricks(this.initialBricks)
      : buildLevelBricks(this.level, this.config);
    this.paddleX = this.width / 2;
    this.paddleDirection = 0;
    this.accumulatorMs = 0;

    if (this.initialBall) {
      this.ball = { ...this.initialBall, attached: false };
      this.status = 'running';
    } else {
      this.ball = { x: 0, y: 0, vx: 0, vy: 0, attached: true };
      this.attachBall();
      this.status = 'ready';
    }
  }

  private buildCustomBricks(specs: readonly BrickSpec[]): Brick[] {
    const brickWidth = brickWidthFor(this.config);
    return specs.map((spec, index) => ({
      id: index,
      row: spec.row,
      col: spec.col,
      x: this.config.brickSideMargin + spec.col * (brickWidth + this.config.brickGap),
      y: this.config.brickTop + spec.row * (this.config.brickHeight + this.config.brickGap),
      width: brickWidth,
      height: this.config.brickHeight,
      colorTier: Math.min(
        BRICK_COLOR_TIERS - 1,
        spec.colorTier ?? brickColorTierForRow(spec.row),
      ),
      points: spec.points ?? this.config.scorePerBrick,
    }));
  }

  private random(): number {
    const value = this.rng();
    if (!Number.isFinite(value)) {
      return 0.5;
    }
    return clamp(value, 0, 1 - Number.EPSILON);
  }
}
