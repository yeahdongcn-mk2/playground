/**
 * Framework-agnostic Tetris rules.
 *
 * The engine never touches the DOM, Phaser, timers or storage. A renderer owns
 * drawing and input, then calls the small action API here and reads snapshots.
 * Keeping the rules pure makes line clears, scoring and level progression fast
 * to unit test and lets a replay or puzzle mode reuse the exact same state
 * machine.
 */

export type TetrominoType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

/** All seven pieces in their conventional display order. */
export const TETROMINO_TYPES: readonly TetrominoType[] = [
  'I',
  'O',
  'T',
  'S',
  'Z',
  'J',
  'L',
];

/** Four discrete rotation states, clockwise from the spawn orientation. */
export type Rotation = 0 | 1 | 2 | 3;

export const ROTATIONS: readonly Rotation[] = [0, 1, 2, 3];

export interface Cell {
  readonly x: number;
  readonly y: number;
}

/** A locked cell keeps the piece type so renderers can colour the stack. */
export type BoardCell = TetrominoType | null;

export type Board = ReadonlyArray<ReadonlyArray<BoardCell>>;

export type TetrisStatus = 'ready' | 'running' | 'paused' | 'gameover';

export type RotationDirection = 'cw' | 'ccw';

/** Result of one gravity tick, useful for sound and feedback. */
export type StepResult = 'idle' | 'moved' | 'locked' | 'cleared' | 'gameover';

export interface PieceState {
  readonly type: TetrominoType;
  readonly rotation: Rotation;
  /** Column of the piece's bounding box. May be negative while hugging a wall. */
  readonly x: number;
  /** Row of the piece's bounding box. */
  readonly y: number;
}

export interface ActivePieceSnapshot extends PieceState {
  /** Occupied cells in board coordinates. */
  readonly cells: readonly Cell[];
}

export interface TetrisSnapshot {
  readonly width: number;
  readonly height: number;
  /** Row-major locked board; empty cells are null. */
  readonly board: Board;
  readonly active: ActivePieceSnapshot | null;
  /** Preview of the piece that will spawn next. */
  readonly next: TetrominoType;
  readonly status: TetrisStatus;
  readonly score: number;
  readonly lines: number;
  readonly level: number;
  /** Current gravity interval in milliseconds. */
  readonly gravityMs: number;
}

export interface TetrisConfig {
  readonly width: number;
  readonly height: number;
  readonly linesPerLevel: number;
  readonly initialGravityMs: number;
  readonly gravityStepMs: number;
  readonly minGravityMs: number;
}

export const DEFAULT_TETRIS_CONFIG: Readonly<TetrisConfig> = {
  width: 10,
  height: 20,
  linesPerLevel: 10,
  initialGravityMs: 800,
  gravityStepMs: 70,
  minGravityMs: 80,
};

/** Base score for 0-4 cleared lines, before the level multiplier. */
export const LINE_CLEAR_SCORES: readonly number[] = [0, 100, 300, 500, 800];

export interface InitialPiece {
  readonly type: TetrominoType;
  readonly rotation?: Rotation;
  readonly x?: number;
  readonly y?: number;
}

export interface TetrisEngineOptions extends Partial<TetrisConfig> {
  /** Source of randomness in the range [0, 1). Injectable for deterministic tests. */
  readonly rng?: () => number;
  /** Starting stack, primarily for tests and replays. */
  readonly initialBoard?: Board;
  /** Override the first active piece, primarily for tests and replays. */
  readonly initialPiece?: TetrominoType | InitialPiece;
  /** Deterministic upcoming pieces, consumed before the 7-bag. */
  readonly nextQueue?: readonly TetrominoType[];
}

export interface DropResult {
  readonly rowsDropped: number;
  readonly clearedLines: number;
  readonly scoreGained: number;
  readonly levelUp: boolean;
  readonly gameOver: boolean;
}

type RotationCells = readonly [
  readonly Cell[],
  readonly Cell[],
  readonly Cell[],
  readonly Cell[],
];

/**
 * SRS-compatible cell offsets for every rotation state. I uses a 4x4 box, O a
 * 2x2 box and the remaining pieces a 3x3 box. Rotating one state into the next
 * is exact for both directions because the tables are generated from the same
 * orientations.
 */
const PIECE_CELLS: Readonly<Record<TetrominoType, RotationCells>> = {
  I: [
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ],
    [
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
    ],
    [
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 1, y: 3 },
    ],
  ],
  O: [
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ],
  ],
  T: [
    [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
    ],
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
    ],
    [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ],
  ],
  S: [
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ],
    [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
    ],
    [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ],
  ],
  Z: [
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
    ],
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ],
    [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 0, y: 2 },
    ],
  ],
  J: [
    [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ],
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
    ],
  ],
  L: [
    [
      { x: 2, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ],
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 0, y: 2 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ],
  ],
};

const PIECE_SIZE: Readonly<Record<TetrominoType, number>> = {
  I: 4,
  O: 2,
  T: 3,
  S: 3,
  Z: 3,
  J: 3,
  L: 3,
};

/**
 * A small, predictable wall/floor kick table. The neutral offset is tried
 * first, then one and two cells sideways, then one or two rows up so a piece
 * resting on the floor can still rotate (an I piece needs the two-row lift).
 */
const KICK_OFFSETS: readonly Cell[] = [
  { x: 0, y: 0 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: -2, y: 0 },
  { x: 2, y: 0 },
  { x: 0, y: -1 },
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 0, y: -2 },
];

/** Return the occupied cells of a piece in its local bounding box. */
export function tetrominoCells(type: TetrominoType, rotation: Rotation): Cell[] {
  return PIECE_CELLS[type][rotation].map((cell) => ({ x: cell.x, y: cell.y }));
}

/** Top-centre spawn position for a directly controlled piece. */
export function spawnPosition(type: TetrominoType, width: number): Cell {
  return {
    x: Math.max(0, Math.floor((width - PIECE_SIZE[type]) / 2)),
    y: 0,
  };
}

/** Score for a line clear at the level that was active when the piece locked. */
export function lineClearScore(lines: number, level: number): number {
  const index = Math.trunc(lines);
  if (index < 1 || index >= LINE_CLEAR_SCORES.length) {
    return 0;
  }
  return (LINE_CLEAR_SCORES[index] ?? 0) * level;
}

export function levelForLines(lines: number, linesPerLevel: number): number {
  return 1 + Math.floor(Math.max(0, lines) / Math.max(1, linesPerLevel));
}

export function gravityMsForLevel(
  level: number,
  config: Pick<TetrisConfig, 'initialGravityMs' | 'gravityStepMs' | 'minGravityMs'> = DEFAULT_TETRIS_CONFIG,
): number {
  const gravity = config.initialGravityMs - (level - 1) * config.gravityStepMs;
  return Math.max(config.minGravityMs, gravity);
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

export class TetrisEngine {
  readonly width: number;
  readonly height: number;

  private readonly config: TetrisConfig;
  private readonly rng: () => number;
  private readonly initialBoard: Board;
  private readonly initialPiece: PieceState | null;
  private readonly initialQueue: readonly TetrominoType[];

  private board: BoardCell[][];
  private queue: TetrominoType[];
  private bag: TetrominoType[];
  private active: PieceState | null;
  private nextType: TetrominoType;
  private status: TetrisStatus;
  private score: number;
  private lines: number;
  private level: number;
  private gravityMs: number;

  constructor(options: TetrisEngineOptions = {}) {
    this.config = resolveConfig(options);
    this.width = this.config.width;
    this.height = this.config.height;
    validateConfig(this.config);

    this.rng = options.rng ?? Math.random;
    this.initialBoard = resolveInitialBoard(options.initialBoard, this.width, this.height);
    this.initialPiece = resolveInitialPiece(options.initialPiece, this.width);
    this.initialQueue = [...(options.nextQueue ?? [])];
    for (const type of this.initialQueue) {
      assertTetrominoType(type);
    }

    this.board = [];
    this.queue = [];
    this.bag = [];
    this.active = null;
    this.nextType = 'I';
    this.status = 'ready';
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.gravityMs = gravityMsForLevel(1, this.config);

    this.reset();
  }

  /** Immutable view of everything a renderer needs for one frame. */
  get state(): TetrisSnapshot {
    const active = this.active;
    return {
      width: this.width,
      height: this.height,
      board: cloneBoard(this.board),
      active: active
        ? {
            type: active.type,
            rotation: active.rotation,
            x: active.x,
            y: active.y,
            cells: PIECE_CELLS[active.type][active.rotation].map((cell) => ({
              x: active.x + cell.x,
              y: active.y + cell.y,
            })),
          }
        : null,
      next: this.nextType,
      status: this.status,
      score: this.score,
      lines: this.lines,
      level: this.level,
      gravityMs: this.gravityMs,
    };
  }

  get currentStatus(): TetrisStatus {
    return this.status;
  }

  /** Start a round. Only valid from the idle "ready" state. */
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

  /**
   * Reset the board, score, level, queue and status back to "ready". The
   * injectable RNG keeps advancing between rounds; pass a seeded RNG and a
   * fixed nextQueue when a replay must be fully deterministic.
   */
  restart(): void {
    this.reset();
  }

  moveLeft(): boolean {
    return this.tryMove(-1, 0);
  }

  moveRight(): boolean {
    return this.tryMove(1, 0);
  }

  /** Move one cell down; never locks the piece. */
  softDrop(): boolean {
    return this.tryMove(0, 1);
  }

  /**
   * Rotate the active piece with a simple wall/floor kick. Returns false when
   * every candidate position is blocked.
   */
  rotate(direction: RotationDirection = 'cw'): boolean {
    const active = this.active;
    if (this.status !== 'running' || !active) {
      return false;
    }
    const rotation = nextRotation(active.rotation, direction);
    for (const offset of KICK_OFFSETS) {
      const candidate: PieceState = {
        type: active.type,
        rotation,
        x: active.x + offset.x,
        y: active.y + offset.y,
      };
      if (!this.collides(candidate)) {
        this.active = candidate;
        return true;
      }
    }
    return false;
  }

  /** One gravity tick: fall one cell, or lock and spawn the next piece. */
  step(): StepResult {
    if (this.status !== 'running' || !this.active) {
      return 'idle';
    }
    if (this.tryMove(0, 1)) {
      return 'moved';
    }
    return this.lockActive();
  }

  /** Drop to the floor and lock immediately. Null when the engine is not running. */
  hardDrop(): DropResult | null {
    if (this.status !== 'running' || !this.active) {
      return null;
    }
    let rowsDropped = 0;
    while (this.tryMove(0, 1)) {
      rowsDropped += 1;
    }

    const scoreBefore = this.score;
    const linesBefore = this.lines;
    const levelBefore = this.level;
    this.lockActive();

    return {
      rowsDropped,
      clearedLines: this.lines - linesBefore,
      scoreGained: this.score - scoreBefore,
      levelUp: this.level > levelBefore,
      gameOver: this.currentStatus === 'gameover',
    };
  }

  private reset(): void {
    this.board = cloneBoard(this.initialBoard);
    this.queue = [...this.initialQueue];
    this.bag = [];
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.gravityMs = gravityMsForLevel(1, this.config);
    this.status = 'ready';
    this.active = null;

    if (this.initialPiece) {
      this.ensureQueue(2);
      this.active = clonePiece(this.initialPiece);
      this.nextType = this.peekNext();
      if (this.collides(this.active)) {
        this.active = null;
        this.status = 'gameover';
      }
      return;
    }

    this.spawnNext();
  }

  private spawnNext(): void {
    this.ensureQueue(2);
    const type = this.takeNext();
    const position = spawnPosition(type, this.width);
    this.active = { type, rotation: 0, x: position.x, y: position.y };
    this.nextType = this.peekNext();
    if (this.collides(this.active)) {
      this.active = null;
      this.status = 'gameover';
    }
  }

  private tryMove(dx: number, dy: number): boolean {
    const active = this.active;
    if (this.status !== 'running' || !active) {
      return false;
    }
    const candidate: PieceState = {
      type: active.type,
      rotation: active.rotation,
      x: active.x + dx,
      y: active.y + dy,
    };
    if (this.collides(candidate)) {
      return false;
    }
    this.active = candidate;
    return true;
  }

  private lockActive(): StepResult {
    const active = this.active;
    if (!active) {
      return 'idle';
    }

    for (const cell of PIECE_CELLS[active.type][active.rotation]) {
      const x = active.x + cell.x;
      const y = active.y + cell.y;
      const row = this.board[y];
      if (row) {
        row[x] = active.type;
      }
    }

    const cleared = this.clearLines();
    const levelBefore = this.level;
    if (cleared > 0) {
      this.score += lineClearScore(cleared, levelBefore);
      this.lines += cleared;
      this.level = levelForLines(this.lines, this.config.linesPerLevel);
      this.gravityMs = gravityMsForLevel(this.level, this.config);
    }

    this.spawnNext();

    if (this.status === 'gameover') {
      return 'gameover';
    }
    return cleared > 0 ? 'cleared' : 'locked';
  }

  /** Remove completed rows, returning how many were cleared. */
  private clearLines(): number {
    const kept = this.board.filter((row) => row.some((cell) => cell === null));
    const cleared = this.height - kept.length;
    while (kept.length < this.height) {
      kept.unshift(createEmptyRow(this.width));
    }
    this.board = kept;
    return cleared;
  }

  private collides(piece: PieceState): boolean {
    for (const cell of PIECE_CELLS[piece.type][piece.rotation]) {
      const x = piece.x + cell.x;
      const y = piece.y + cell.y;
      if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
        return true;
      }
      const row = this.board[y];
      if (!row || row[x] !== null) {
        return true;
      }
    }
    return false;
  }

  private ensureQueue(minimum: number): void {
    while (this.queue.length < minimum) {
      if (this.bag.length === 0) {
        this.refillBag();
      }
      const type = this.bag.shift();
      if (!type) {
        throw new Error('Tetris bag is empty.');
      }
      this.queue.push(type);
    }
  }

  private takeNext(): TetrominoType {
    const type = this.queue.shift();
    if (!type) {
      throw new Error('Tetris queue is empty.');
    }
    this.ensureQueue(1);
    return type;
  }

  private peekNext(): TetrominoType {
    this.ensureQueue(1);
    const type = this.queue[0];
    if (!type) {
      throw new Error('Tetris queue is empty.');
    }
    return type;
  }

  /** Standard 7-bag shuffle: every piece appears once per bag. */
  private refillBag(): void {
    const bag: TetrominoType[] = [...TETROMINO_TYPES];
    for (let i = bag.length - 1; i > 0; i -= 1) {
      const roll = Math.min(1, Math.max(0, this.rng()));
      const index = Math.min(i, Math.floor(roll * (i + 1)));
      const current = bag[i];
      const target = bag[index];
      if (current && target) {
        bag[i] = target;
        bag[index] = current;
      }
    }
    this.bag = bag;
  }
}

function resolveConfig(options: TetrisEngineOptions): TetrisConfig {
  return {
    width: options.width ?? DEFAULT_TETRIS_CONFIG.width,
    height: options.height ?? DEFAULT_TETRIS_CONFIG.height,
    linesPerLevel: options.linesPerLevel ?? DEFAULT_TETRIS_CONFIG.linesPerLevel,
    initialGravityMs: options.initialGravityMs ?? DEFAULT_TETRIS_CONFIG.initialGravityMs,
    gravityStepMs: options.gravityStepMs ?? DEFAULT_TETRIS_CONFIG.gravityStepMs,
    minGravityMs: options.minGravityMs ?? DEFAULT_TETRIS_CONFIG.minGravityMs,
  };
}

function validateConfig(config: TetrisConfig): void {
  if (!Number.isInteger(config.width) || config.width < 4) {
    throw new Error('Tetris board width must be an integer of at least 4.');
  }
  if (!Number.isInteger(config.height) || config.height < 4) {
    throw new Error('Tetris board height must be an integer of at least 4.');
  }
  if (!Number.isInteger(config.linesPerLevel) || config.linesPerLevel < 1) {
    throw new Error('Tetris linesPerLevel must be a positive integer.');
  }
  if (!Number.isFinite(config.initialGravityMs) || config.initialGravityMs <= 0) {
    throw new Error('Tetris initialGravityMs must be positive.');
  }
  if (!Number.isFinite(config.gravityStepMs) || config.gravityStepMs < 0) {
    throw new Error('Tetris gravityStepMs cannot be negative.');
  }
  if (!Number.isFinite(config.minGravityMs) || config.minGravityMs <= 0) {
    throw new Error('Tetris minGravityMs must be positive.');
  }
  if (config.minGravityMs > config.initialGravityMs) {
    throw new Error('Tetris minGravityMs cannot exceed initialGravityMs.');
  }
}

function resolveInitialBoard(
  board: Board | undefined,
  width: number,
  height: number,
): Board {
  if (!board) {
    return createEmptyBoard(width, height);
  }
  if (board.length !== height) {
    throw new Error('Initial board height does not match the configured height.');
  }
  return board.map((row) => {
    if (row.length !== width) {
      throw new Error('Initial board row width does not match the configured width.');
    }
    return row.map((cell) => {
      if (cell !== null) {
        assertTetrominoType(cell);
      }
      return cell;
    });
  });
}

function resolveInitialPiece(
  piece: TetrominoType | InitialPiece | undefined,
  width: number,
): PieceState | null {
  if (!piece) {
    return null;
  }
  const spec: InitialPiece = typeof piece === 'string' ? { type: piece } : piece;
  assertTetrominoType(spec.type);
  const rotation = spec.rotation ?? 0;
  if (!ROTATIONS.includes(rotation)) {
    throw new Error('Initial piece rotation must be 0, 1, 2 or 3.');
  }
  const position = spawnPosition(spec.type, width);
  const x = spec.x ?? position.x;
  const y = spec.y ?? position.y;
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error('Initial piece coordinates must be integers.');
  }
  return { type: spec.type, rotation, x, y };
}

function assertTetrominoType(value: string): asserts value is TetrominoType {
  if (!TETROMINO_TYPES.includes(value as TetrominoType)) {
    throw new Error(`Unknown tetromino type: ${value}`);
  }
}

function nextRotation(rotation: Rotation, direction: RotationDirection): Rotation {
  const delta = direction === 'cw' ? 1 : 3;
  return ((rotation + delta) % 4) as Rotation;
}

function createEmptyRow(width: number): BoardCell[] {
  return Array.from({ length: width }, () => null);
}

function createEmptyBoard(width: number, height: number): Board {
  return Array.from({ length: height }, () => createEmptyRow(width));
}

function cloneBoard(board: Board): BoardCell[][] {
  return board.map((row) => row.slice());
}

function clonePiece(piece: PieceState): PieceState {
  return {
    type: piece.type,
    rotation: piece.rotation,
    x: piece.x,
    y: piece.y,
  };
}
