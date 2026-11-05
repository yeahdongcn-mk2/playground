/**
 * Framework-agnostic Snake rules.
 *
 * The engine never touches the DOM, Phaser, timers or storage, which keeps the
 * game rules fast to unit test and lets a future renderer (or replay/leaderboard
 * feature) reuse them unchanged.
 */

export type Direction = 'up' | 'right' | 'down' | 'left';

export interface Cell {
  readonly x: number;
  readonly y: number;
}

export const DIRECTIONS: Readonly<Record<Direction, Cell>> = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

const OPPOSITE: Readonly<Record<Direction, Direction>> = {
  up: 'down',
  right: 'left',
  down: 'up',
  left: 'right',
};

/** The direction that would reverse `direction`. */
export function oppositeDirection(direction: Direction): Direction {
  return OPPOSITE[direction];
}

export type SnakeStatus = 'ready' | 'running' | 'paused' | 'gameover' | 'won';

/** Result of one simulation tick, useful for sound and visual feedback. */
export type StepResult = 'idle' | 'moved' | 'ate' | 'died' | 'won';

export interface SnakeConfig {
  width: number;
  height: number;
  initialLength: number;
  initialStepMs: number;
  minStepMs: number;
  speedUpMs: number;
  scorePerFood: number;
}

export const DEFAULT_SNAKE_CONFIG: Readonly<SnakeConfig> = {
  width: 20,
  height: 20,
  initialLength: 3,
  initialStepMs: 150,
  minStepMs: 70,
  speedUpMs: 6,
  scorePerFood: 10,
};

export interface SnakeEngineOptions extends Partial<SnakeConfig> {
  /** Source of randomness in the range [0, 1). Injectable for deterministic tests. */
  rng?: () => number;
  /** Custom starting layout, head first (used by tests and, later, puzzle modes). */
  initialSnake?: readonly Cell[];
  initialDirection?: Direction;
  initialFood?: Cell;
}

export interface SnakeSnapshot {
  readonly width: number;
  readonly height: number;
  readonly snake: readonly Cell[];
  readonly food: Cell | null;
  readonly direction: Direction;
  readonly status: SnakeStatus;
  readonly score: number;
  readonly stepMs: number;
  /** Unaccelerated step duration, for speed multipliers in the UI. */
  readonly baseStepMs: number;
}

/** Infer a head direction from a custom layout (head first). */
function directionFromLayout(layout: readonly Cell[]): Direction {
  const head = layout[0];
  const neck = layout[1];
  if (!head || !neck) {
    return 'right';
  }
  const dx = head.x - neck.x;
  const dy = head.y - neck.y;
  if (dx === 1 && dy === 0) {
    return 'right';
  }
  if (dx === -1 && dy === 0) {
    return 'left';
  }
  if (dx === 0 && dy === 1) {
    return 'down';
  }
  if (dx === 0 && dy === -1) {
    return 'up';
  }
  return 'right';
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

export class SnakeEngine {
  readonly width: number;
  readonly height: number;

  private readonly config: SnakeConfig;
  private readonly rng: () => number;
  private readonly initialLayout: readonly Cell[] | null;
  private readonly initialDirection: Direction;
  private readonly initialFood: Cell | null;

  private snake: Cell[] = [];
  private food: Cell | null = null;
  private direction: Direction = 'right';
  private status: SnakeStatus = 'ready';
  private score = 0;
  private stepMs = DEFAULT_SNAKE_CONFIG.initialStepMs;
  private turnQueue: Direction[] = [];

  constructor(options: SnakeEngineOptions = {}) {
    this.config = { ...DEFAULT_SNAKE_CONFIG, ...options };
    this.width = this.config.width;
    this.height = this.config.height;
    this.validateConfig();

    this.rng = options.rng ?? Math.random;
    this.initialLayout = options.initialSnake ? options.initialSnake.map(cloneCell) : null;
    this.initialDirection =
      options.initialDirection ??
      (this.initialLayout ? directionFromLayout(this.initialLayout) : 'right');
    this.initialFood = options.initialFood ? cloneCell(options.initialFood) : null;

    this.validateInitialLayout();
    this.reset();
  }

  get state(): SnakeSnapshot {
    return {
      width: this.width,
      height: this.height,
      snake: this.snake.map(cloneCell),
      food: this.food ? cloneCell(this.food) : null,
      direction: this.direction,
      status: this.status,
      score: this.score,
      stepMs: this.stepMs,
      baseStepMs: this.config.initialStepMs,
    };
  }

  get currentStatus(): SnakeStatus {
    return this.status;
  }

  /** Begin a round. Only valid from the idle "ready" state. */
  start(): void {
    if (this.status === 'ready') {
      this.status = 'running';
    }
  }

  pause(): void {
    if (this.status === 'running') {
      this.status = 'paused';
    }
  }

  resume(): void {
    if (this.status === 'paused') {
      this.status = 'running';
    }
  }

  togglePause(): void {
    if (this.status === 'running') {
      this.pause();
    } else if (this.status === 'paused') {
      this.resume();
    }
  }

  /** Reset score, speed, layout and food; leaves the engine in "ready". */
  restart(): void {
    this.reset();
  }

  /**
   * Queue a turn. Turns are applied one per tick so quick key presses can
   * describe a corner without skipping a cell. A 180° reversal is rejected.
   */
  turn(direction: Direction): boolean {
    if (this.status !== 'running') {
      return false;
    }
    const last = this.turnQueue.at(-1) ?? this.direction;
    if (direction === last || direction === OPPOSITE[last]) {
      return false;
    }
    if (this.turnQueue.length >= 2) {
      return false;
    }
    this.turnQueue.push(direction);
    return true;
  }

  /** Advance the simulation by exactly one grid cell. */
  step(): StepResult {
    if (this.status !== 'running') {
      return 'idle';
    }

    const queued = this.turnQueue.shift();
    if (queued) {
      this.direction = queued;
    }

    const head = this.snake[0];
    if (!head) {
      return 'idle';
    }
    const delta = DIRECTIONS[this.direction];
    const next: Cell = { x: head.x + delta.x, y: head.y + delta.y };

    if (!this.isInside(next)) {
      this.status = 'gameover';
      return 'died';
    }

    const eating = this.food !== null && next.x === this.food.x && next.y === this.food.y;
    // The tail vacates its cell this tick unless the snake is growing, so
    // following the tail is legal.
    const bodyToCheck = eating ? this.snake : this.snake.slice(0, -1);
    if (bodyToCheck.some((cell) => cell.x === next.x && cell.y === next.y)) {
      this.status = 'gameover';
      return 'died';
    }

    this.snake.unshift(next);

    if (!eating) {
      this.snake.pop();
      return 'moved';
    }

    this.score += this.config.scorePerFood;
    this.stepMs = Math.max(this.config.minStepMs, this.stepMs - this.config.speedUpMs);
    this.food = null;
    this.spawnFood();

    if (this.food === null) {
      this.status = 'won';
      return 'won';
    }
    return 'ate';
  }

  private reset(): void {
    this.snake = (this.initialLayout ?? this.buildDefaultLayout()).map(cloneCell);
    this.direction = this.initialDirection;
    this.turnQueue = [];
    this.score = 0;
    this.stepMs = this.config.initialStepMs;
    this.status = 'ready';
    this.food = this.initialFood ? cloneCell(this.initialFood) : null;
    if (this.food === null) {
      this.spawnFood();
    }
  }

  private buildDefaultLayout(): Cell[] {
    const { initialLength } = this.config;
    const halfX = Math.floor(this.width / 2);
    const halfY = Math.floor(this.height / 2);
    let head: Cell;
    switch (this.initialDirection) {
      case 'right':
        head = { x: Math.max(initialLength - 1, halfX), y: halfY };
        break;
      case 'left':
        head = { x: Math.min(halfX, this.width - initialLength), y: halfY };
        break;
      case 'down':
        head = { x: halfX, y: Math.max(initialLength - 1, halfY) };
        break;
      case 'up':
        head = { x: halfX, y: Math.min(halfY, this.height - initialLength) };
        break;
    }
    const back = DIRECTIONS[oppositeDirection(this.initialDirection)];
    return Array.from({ length: initialLength }, (_, index) => ({
      x: head.x + back.x * index,
      y: head.y + back.y * index,
    }));
  }

  private spawnFood(): void {
    const free: Cell[] = [];
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if (!this.occupies(x, y)) {
          free.push({ x, y });
        }
      }
    }
    if (free.length === 0) {
      this.food = null;
      return;
    }
    const roll = Math.min(1, Math.max(0, this.rng()));
    const index = Math.min(free.length - 1, Math.floor(roll * free.length));
    this.food = free[index] ?? null;
  }

  private occupies(x: number, y: number): boolean {
    return this.snake.some((cell) => cell.x === x && cell.y === y);
  }

  private isInside(cell: Cell): boolean {
    return cell.x >= 0 && cell.x < this.width && cell.y >= 0 && cell.y < this.height;
  }

  private validateConfig(): void {
    const { width, height, initialLength, initialStepMs, minStepMs, speedUpMs, scorePerFood } =
      this.config;
    if (!Number.isInteger(width) || width < 4 || !Number.isInteger(height) || height < 4) {
      throw new Error('Snake board must be at least 4x4 cells.');
    }
    if (!Number.isInteger(initialLength) || initialLength < 2) {
      throw new Error('Snake must start with at least 2 segments.');
    }
    if (initialLength >= width * height) {
      throw new Error('Snake must leave at least one free cell for food.');
    }
    if (initialStepMs <= 0 || minStepMs <= 0 || minStepMs > initialStepMs) {
      throw new Error('Snake step timing is invalid.');
    }
    if (speedUpMs < 0 || scorePerFood < 1) {
      throw new Error('Snake scoring config is invalid.');
    }
  }

  private validateInitialLayout(): void {
    const layout = this.initialLayout ?? this.buildDefaultLayout();
    if (layout.length < 2) {
      throw new Error('Initial snake must contain at least two cells.');
    }
    if (layout.length >= this.width * this.height) {
      throw new Error('Initial snake must leave at least one free cell for food.');
    }
    const seen = new Set<string>();
    for (const [index, cell] of layout.entries()) {
      if (!this.isInside(cell)) {
        throw new Error('Initial snake layout is out of bounds.');
      }
      const key = `${cell.x},${cell.y}`;
      if (seen.has(key)) {
        throw new Error('Initial snake layout contains duplicate cells.');
      }
      seen.add(key);
      const previous = layout[index - 1];
      if (previous && Math.abs(previous.x - cell.x) + Math.abs(previous.y - cell.y) !== 1) {
        throw new Error('Initial snake layout must be a contiguous path.');
      }
    }
    const head = layout[0];
    if (head) {
      const delta = DIRECTIONS[this.initialDirection];
      const next = { x: head.x + delta.x, y: head.y + delta.y };
      if (!this.isInside(next)) {
        throw new Error('Initial direction points off the board.');
      }
      const nextIndex = layout.findIndex((cell) => cell.x === next.x && cell.y === next.y);
      if (nextIndex >= 0 && nextIndex !== layout.length - 1) {
        throw new Error('Initial direction points into the snake.');
      }
    }
    if (this.initialFood) {
      if (!this.isInside(this.initialFood)) {
        throw new Error('Initial food is out of bounds.');
      }
      if (seen.has(`${this.initialFood.x},${this.initialFood.y}`)) {
        throw new Error('Initial food cannot overlap the snake.');
      }
    }
  }
}

function cloneCell(cell: Cell): Cell {
  return { x: cell.x, y: cell.y };
}
