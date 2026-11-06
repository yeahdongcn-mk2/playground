/**
 * Framework-agnostic 2048 rules.
 *
 * The engine never touches the DOM, Phaser, timers or storage. A renderer owns
 * input, animation and drawing, then calls move() and reads snapshots. Keeping
 * the rules pure makes compression, merging, scoring and game-over detection
 * fast to unit test and lets a Phaser scene and a DOM view share one state
 * machine.
 */

/** Number of rows and columns on the fixed 4x4 board. */
export const BOARD_SIZE = 4;

/** Tiles placed when a fresh game starts. */
export const STARTING_TILES = 2;

/** Probability that a spawned tile is a 4; otherwise it is a 2. */
export const DEFAULT_FOUR_CHANCE = 0.1;

export type Direction = 'up' | 'right' | 'down' | 'left';

export const DIRECTIONS: readonly Direction[] = ['up', 'right', 'down', 'left'];

/** A tile value, or null for an empty cell. */
export type BoardCell = number | null;

/** Row-major board; rows are top to bottom, columns left to right. */
export type Board = ReadonlyArray<ReadonlyArray<BoardCell>>;

export type Game2048Status = 'playing' | 'gameover';

export interface Cell {
  readonly row: number;
  readonly col: number;
}

export interface SpawnedTile extends Cell {
  readonly value: number;
}

/** Destination cell and resulting value of one merge, for pop/score feedback. */
export interface MergedTile extends Cell {
  readonly value: number;
}

export interface Game2048Snapshot {
  readonly size: number;
  /** Defensive copy of the board; empty cells are null. */
  readonly board: Board;
  readonly score: number;
  readonly status: Game2048Status;
}

export interface Game2048Options {
  /** Source of randomness in the range [0, 1). Injectable for deterministic tests. */
  readonly rng?: () => number;
  /** Chance that a spawned tile is a 4. Must be between 0 and 1; other values throw. */
  readonly fourChance?: number;
  /**
   * Exact starting position, primarily for tests and saved games. When present
   * it is used verbatim and no random tiles are spawned; `initialTiles` has no
   * effect on the starting tiles.
   */
  readonly initialBoard?: Board;
  /** Random tiles placed on an empty board by reset/restart. Defaults to 2. */
  readonly initialTiles?: number;
}

export interface MoveResult {
  readonly direction: Direction;
  /** False when the board did not change, so nothing spawned or scored. */
  readonly moved: boolean;
  readonly scoreGained: number;
  /** Tile created after a valid move, or null when the move was a no-op. */
  readonly spawned: SpawnedTile | null;
  readonly mergedTiles: readonly MergedTile[];
  /** True when the game is over after this move. */
  readonly gameOver: boolean;
}

interface LineResult {
  readonly values: readonly BoardCell[];
  readonly gained: number;
  readonly mergeOffsets: readonly number[];
}

/** Every line in the order tiles travel, starting at the destination edge. */
const LINE_CELLS: Readonly<
  Partial<Record<Direction, ReadonlyArray<ReadonlyArray<Cell>>>>
> = buildLineCells();

function buildLineCells(): Record<Direction, Cell[][]> {
  const lines: Record<Direction, Cell[][]> = { up: [], right: [], down: [], left: [] };
  for (let index = 0; index < BOARD_SIZE; index += 1) {
    lines.left.push(
      Array.from({ length: BOARD_SIZE }, (_, col) => ({ row: index, col })),
    );
    lines.right.push(
      Array.from({ length: BOARD_SIZE }, (_, offset) => ({
        row: index,
        col: BOARD_SIZE - 1 - offset,
      })),
    );
    lines.up.push(
      Array.from({ length: BOARD_SIZE }, (_, row) => ({ row, col: index })),
    );
    lines.down.push(
      Array.from({ length: BOARD_SIZE }, (_, offset) => ({
        row: BOARD_SIZE - 1 - offset,
        col: index,
      })),
    );
  }
  return lines;
}

/** An empty, mutable 4x4 board. */
export function createEmptyBoard(): BoardCell[][] {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, (): BoardCell => null),
  );
}

function cloneBoard(board: Board): BoardCell[][] {
  return board.map((row) => [...row]);
}

/** True while any slide or merge is still possible. */
export function canMove(board: Board): boolean {
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const value = cellAt(board, row, col);
      if (value === null) {
        return true;
      }
      const right = cellAt(board, row, col + 1);
      const down = cellAt(board, row + 1, col);
      if (right === value || down === value) {
        return true;
      }
    }
  }
  return false;
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

function cellAt(board: Board, row: number, col: number): BoardCell {
  return board[row]?.[col] ?? null;
}

function isPowerOfTwo(value: number): boolean {
  if (value < 2 || !Number.isInteger(value)) {
    return false;
  }
  const exponent = Math.log2(value);
  return Number.isInteger(exponent) && 2 ** exponent === value;
}

function validateBoard(board: Board): void {
  if (board.length !== BOARD_SIZE) {
    throw new RangeError(`Board must have ${BOARD_SIZE} rows.`);
  }
  let tiles = 0;
  for (const row of board) {
    if (row.length !== BOARD_SIZE) {
      throw new RangeError(`Every row must have ${BOARD_SIZE} cells.`);
    }
    for (const value of row) {
      if (value === null) {
        continue;
      }
      if (!isPowerOfTwo(value)) {
        throw new RangeError(`Invalid tile value: ${String(value)}.`);
      }
      tiles += 1;
    }
  }
  if (tiles === 0) {
    throw new RangeError('initialBoard must contain at least one tile.');
  }
}

/**
 * Slide one line toward its destination edge. Equal neighbours merge once, so
 * [2, 2, 4, 4] becomes [4, 8] and [2, 2, 2, 2] becomes [4, 4] rather than [8].
 */
function slideLine(line: readonly BoardCell[]): LineResult {
  const compact = line.filter((value): value is number => value !== null);
  const values: BoardCell[] = [];
  const mergeOffsets: number[] = [];
  let gained = 0;

  let index = 0;
  while (index < compact.length) {
    const value = compact[index];
    if (value === undefined) {
      break;
    }
    const next = compact[index + 1];
    if (next === value) {
      const mergedValue = value * 2;
      mergeOffsets.push(values.length);
      values.push(mergedValue);
      gained += mergedValue;
      index += 2;
    } else {
      values.push(value);
      index += 1;
    }
  }

  while (values.length < line.length) {
    values.push(null);
  }
  return { values, gained, mergeOffsets };
}

export class Game2048Engine {
  readonly size = BOARD_SIZE;

  private readonly rng: () => number;
  private readonly fourChance: number;
  private readonly initialBoard: Board | null;
  private readonly initialTiles: number;

  private tiles: BoardCell[][] = createEmptyBoard();
  private currentScore = 0;
  private gameStatus: Game2048Status = 'playing';

  constructor(options: Game2048Options = {}) {
    this.rng = options.rng ?? Math.random;
    this.fourChance = options.fourChance ?? DEFAULT_FOUR_CHANCE;
    this.initialTiles = options.initialTiles ?? STARTING_TILES;
    this.initialBoard = options.initialBoard ? cloneBoard(options.initialBoard) : null;

    if (!Number.isFinite(this.fourChance) || this.fourChance < 0 || this.fourChance > 1) {
      throw new RangeError('fourChance must be between 0 and 1.');
    }
    if (
      !Number.isInteger(this.initialTiles) ||
      this.initialTiles < 1 ||
      this.initialTiles > BOARD_SIZE * BOARD_SIZE
    ) {
      throw new RangeError(`initialTiles must be between 1 and ${BOARD_SIZE * BOARD_SIZE}.`);
    }
    if (this.initialBoard) {
      validateBoard(this.initialBoard);
    }

    this.reset();
  }

  /** Immutable view of everything a renderer needs. */
  get state(): Game2048Snapshot {
    return {
      size: this.size,
      board: cloneBoard(this.tiles),
      score: this.currentScore,
      status: this.gameStatus,
    };
  }

  /** Convenience copy of the board; state carries the same data plus status. */
  get board(): Board {
    return cloneBoard(this.tiles);
  }

  /** Convenience accessor for the current score. */
  get score(): number {
    return this.currentScore;
  }

  /** Status shortcut, named to match the snake and tetris engines. */
  get currentStatus(): Game2048Status {
    return this.gameStatus;
  }

  /** Reset score and tiles. A custom initialBoard is restored as given. */
  restart(): void {
    this.reset();
  }

  /**
   * Slide every line toward `direction`, merge equal neighbours and, only when
   * the board changed, add one random tile and refresh the game-over status.
   */
  move(direction: Direction): MoveResult {
    // Validate before the status check so invalid input fails the same way in
    // every state instead of being silently ignored after game over. Object.hasOwn
    // keeps inherited names such as 'constructor' from passing as directions.
    const lines = Object.hasOwn(LINE_CELLS, direction)
      ? LINE_CELLS[direction]
      : undefined;
    if (!lines) {
      throw new RangeError(`Unknown direction: ${String(direction)}.`);
    }

    if (this.gameStatus !== 'playing') {
      return {
        direction,
        moved: false,
        scoreGained: 0,
        spawned: null,
        mergedTiles: [],
        gameOver: this.gameStatus === 'gameover',
      };
    }

    const mergedTiles: MergedTile[] = [];
    let gained = 0;
    let moved = false;

    for (const line of lines) {
      const before = line.map((cell) => cellAt(this.tiles, cell.row, cell.col));
      const result = slideLine(before);
      gained += result.gained;
      if (result.values.some((value, index) => value !== (before[index] ?? null))) {
        moved = true;
      }
      for (const offset of result.mergeOffsets) {
        const cell = line[offset];
        const value = result.values[offset] ?? null;
        if (cell && typeof value === 'number') {
          mergedTiles.push({ row: cell.row, col: cell.col, value });
        }
      }
      for (let index = 0; index < line.length; index += 1) {
        const cell = line[index];
        if (!cell) {
          continue;
        }
        const row = this.tiles[cell.row];
        if (row) {
          row[cell.col] = result.values[index] ?? null;
        }
      }
    }

    if (!moved) {
      return {
        direction,
        moved: false,
        scoreGained: 0,
        spawned: null,
        mergedTiles: [],
        gameOver: false,
      };
    }

    this.currentScore += gained;
    const spawned = this.spawnTile();
    if (!canMove(this.tiles)) {
      this.gameStatus = 'gameover';
    }
    return {
      direction,
      moved: true,
      scoreGained: gained,
      spawned,
      mergedTiles,
      gameOver: this.gameStatus === 'gameover',
    };
  }

  private reset(): void {
    this.tiles = this.initialBoard ? cloneBoard(this.initialBoard) : createEmptyBoard();
    this.currentScore = 0;
    this.gameStatus = 'playing';

    if (!this.initialBoard) {
      for (let tile = 0; tile < this.initialTiles; tile += 1) {
        this.spawnTile();
      }
    }
    if (!canMove(this.tiles)) {
      this.gameStatus = 'gameover';
    }
  }

  /**
   * Place one 2 or 4 in a uniformly chosen empty cell. The first injected RNG
   * call picks the cell index, the second picks the value.
   */
  private spawnTile(): SpawnedTile | null {
    const empty: Cell[] = [];
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        if (cellAt(this.tiles, row, col) === null) {
          empty.push({ row, col });
        }
      }
    }
    if (empty.length === 0) {
      return null;
    }

    const index = Math.min(empty.length - 1, Math.floor(this.random() * empty.length));
    const cell = empty[index];
    if (!cell) {
      return null;
    }
    const value = this.random() < this.fourChance ? 4 : 2;
    const row = this.tiles[cell.row];
    if (row) {
      row[cell.col] = value;
    }
    return { row: cell.row, col: cell.col, value };
  }

  private random(): number {
    const value = this.rng();
    // A broken random source must not be able to suppress a required spawn.
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }
}
