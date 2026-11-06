/**
 * Framework-agnostic Minesweeper rules for the beginner board.
 *
 * The engine never touches the DOM, Phaser, timers or storage. Mines are only
 * placed on the first reveal, excluding the clicked cell and its eight
 * neighbours, so the opening move is always safe. A renderer owns drawing,
 * input and the animation loop, calls `tick(deltaMs)` to advance the clock and
 * reads immutable snapshots from `state`.
 *
 * The board is always 9x9 with 10 mines. `initialMines` exists so unit tests
 * and replays can supply an exact layout; mines that fall inside the first-click
 * safe zone are moved to a random eligible cell so the safety guarantee holds
 * for injected layouts too.
 */

/** Board rows, counted from the top. */
export const ROWS = 9;

/** Board columns, counted from the left. */
export const COLS = 9;

/** Mines placed on every board. */
export const MINE_COUNT = 10;

const CELL_COUNT = ROWS * COLS;

export type MinesweeperStatus = 'ready' | 'playing' | 'won' | 'lost';

export interface Cell {
  readonly row: number;
  readonly col: number;
}

/** One cell as exposed in a snapshot. */
export interface MinesweeperCell extends Cell {
  /** Whether this cell holds a mine. Hidden cells expose this for rendering on loss. */
  readonly mine: boolean;
  readonly revealed: boolean;
  readonly flagged: boolean;
  /** Number of mines in the eight neighbouring cells; 0 for a mine itself. */
  readonly adjacentMines: number;
}

/** Immutable view of everything a renderer needs. */
export interface MinesweeperSnapshot {
  readonly rows: number;
  readonly cols: number;
  readonly mineCount: number;
  readonly flaggedCount: number;
  /** Mine count minus the number of flags placed; flags may exceed the mine count. */
  readonly remainingMines: number;
  readonly status: MinesweeperStatus;
  /** Elapsed play time through `tick()`; frozen once the game ends. */
  readonly elapsedMs: number;
  /** The mine that ended the game, or null while playing. */
  readonly explodedCell: Cell | null;
  readonly board: readonly (readonly MinesweeperCell[])[];
}

export interface MinesweeperOptions {
  /** Source of randomness in the range [0, 1). Injectable for deterministic tests. */
  readonly rng?: () => number;
  /**
   * Exact mine layout for tests and replays. Every mine inside the first-click
   * safe zone is moved to a random cell outside it, so the first reveal is
   * always safe. A layout must contain exactly `MINE_COUNT` distinct cells.
   */
  readonly initialMines?: readonly Cell[];
}

export interface RevealResult {
  /** The cell that was asked to be revealed. */
  readonly cell: Cell;
  /** Cells newly revealed by this action, including the exploded mine. */
  readonly revealed: readonly Cell[];
  readonly hitMine: boolean;
  /** Status after the reveal. */
  readonly status: MinesweeperStatus;
}

export interface FlagResult {
  /** The cell that was asked to be (un)flagged. */
  readonly cell: Cell;
  /** False when the cell was already revealed or the game has ended. */
  readonly changed: boolean;
  /** Whether the cell is flagged after the action. */
  readonly flagged: boolean;
  readonly remainingMines: number;
  readonly status: MinesweeperStatus;
}

interface CellState {
  mine: boolean;
  revealed: boolean;
  flagged: boolean;
  adjacent: number;
}

const NEIGHBOUR_OFFSETS: readonly Cell[] = [
  { row: -1, col: -1 },
  { row: -1, col: 0 },
  { row: -1, col: 1 },
  { row: 0, col: -1 },
  { row: 0, col: 1 },
  { row: 1, col: -1 },
  { row: 1, col: 0 },
  { row: 1, col: 1 },
];

/** True when `row` and `col` address a cell on the fixed board. */
export function isInBounds(row: number, col: number): boolean {
  return (
    Number.isInteger(row) &&
    Number.isInteger(col) &&
    row >= 0 &&
    row < ROWS &&
    col >= 0 &&
    col < COLS
  );
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

function createCells(): CellState[] {
  return Array.from({ length: CELL_COUNT }, () => ({
    mine: false,
    revealed: false,
    flagged: false,
    adjacent: 0,
  }));
}

function validateMines(mines: readonly Cell[]): number[] {
  if (mines.length !== MINE_COUNT) {
    throw new RangeError(`initialMines must contain exactly ${MINE_COUNT} cells.`);
  }
  const seen = new Set<number>();
  const indexes: number[] = [];
  for (const mine of mines) {
    if (!isInBounds(mine.row, mine.col)) {
      throw new RangeError(`Mine out of bounds: (${mine.row}, ${mine.col}).`);
    }
    const index = mine.row * COLS + mine.col;
    if (seen.has(index)) {
      throw new RangeError(`Duplicate mine at (${mine.row}, ${mine.col}).`);
    }
    seen.add(index);
    indexes.push(index);
  }
  return indexes;
}

export class MinesweeperEngine {
  private readonly rng: () => number;
  private readonly initialMineIndexes: readonly number[] | null;

  private cells: CellState[] = createCells();
  private gameStatus: MinesweeperStatus = 'ready';
  private elapsed = 0;
  private flagged = 0;
  private placed = false;
  private exploded: Cell | null = null;

  constructor(options: MinesweeperOptions = {}) {
    this.rng = options.rng ?? Math.random;
    this.initialMineIndexes = options.initialMines ? validateMines(options.initialMines) : null;
    this.reset();
  }

  /** Immutable view of the board, clock and status. */
  get state(): MinesweeperSnapshot {
    const board = Array.from({ length: ROWS }, (_, row) =>
      Array.from({ length: COLS }, (_, col) => this.snapshotCell(row, col)),
    );
    return {
      rows: ROWS,
      cols: COLS,
      mineCount: MINE_COUNT,
      flaggedCount: this.flagged,
      remainingMines: MINE_COUNT - this.flagged,
      status: this.gameStatus,
      elapsedMs: this.elapsed,
      explodedCell: this.exploded ? { ...this.exploded } : null,
      board,
    };
  }

  /** Status shortcut, named to match the other game engines. */
  get currentStatus(): MinesweeperStatus {
    return this.gameStatus;
  }

  /** Elapsed play time in milliseconds. */
  get elapsedMs(): number {
    return this.elapsed;
  }

  /** Mine count minus the number of flags placed. */
  get remainingMines(): number {
    return MINE_COUNT - this.flagged;
  }

  /**
   * Reveal one cell. The first call plants the mines outside the safe zone,
   * starts the clock and flood-fills through blank cells. Revealing a flagged
   * or already revealed cell is a no-op; any action after a win or loss is a
   * no-op as well.
   */
  reveal(row: number, col: number): RevealResult {
    const cell = this.cellAt(row, col);
    const target: Cell = { row, col };

    if (this.gameStatus === 'won' || this.gameStatus === 'lost') {
      return { cell: target, revealed: [], hitMine: false, status: this.gameStatus };
    }
    if (cell.revealed || cell.flagged) {
      return { cell: target, revealed: [], hitMine: false, status: this.gameStatus };
    }

    if (!this.placed) {
      this.plantMines(row, col);
    }

    if (cell.mine) {
      cell.revealed = true;
      this.exploded = { row, col };
      this.gameStatus = 'lost';
      return { cell: target, revealed: [target], hitMine: true, status: 'lost' };
    }

    const revealed = this.floodReveal(row, col);
    if (this.allSafeCellsRevealed()) {
      this.gameStatus = 'won';
    }
    return { cell: target, revealed, hitMine: false, status: this.gameStatus };
  }

  /**
   * Toggle a flag on a hidden cell. Flags are allowed before the first reveal
   * and do not start the clock. Revealed cells and finished games reject the
   * action with `changed: false`.
   */
  toggleFlag(row: number, col: number): FlagResult {
    const cell = this.cellAt(row, col);
    const target: Cell = { row, col };

    if (cell.revealed || this.gameStatus === 'won' || this.gameStatus === 'lost') {
      return {
        cell: target,
        changed: false,
        flagged: cell.flagged,
        remainingMines: this.remainingMines,
        status: this.gameStatus,
      };
    }

    cell.flagged = !cell.flagged;
    this.flagged += cell.flagged ? 1 : -1;
    return {
      cell: target,
      changed: true,
      flagged: cell.flagged,
      remainingMines: this.remainingMines,
      status: this.gameStatus,
    };
  }

  /**
   * Advance the clock by `deltaMs`. Time only runs between the first reveal
   * and the end of the game; ticking before the first reveal or after a win or
   * loss leaves the clock unchanged. Invalid deltas throw.
   */
  tick(deltaMs: number): number {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError('deltaMs must be a non-negative finite number.');
    }
    if (this.gameStatus === 'playing') {
      this.elapsed += deltaMs;
    }
    return this.elapsed;
  }

  /** Start a fresh game, restoring an injected layout and resetting the clock. */
  restart(): void {
    this.reset();
  }

  private reset(): void {
    this.cells = createCells();
    this.gameStatus = 'ready';
    this.elapsed = 0;
    this.flagged = 0;
    this.placed = false;
    this.exploded = null;
  }

  /**
   * Place every mine outside the safe zone. An injected layout keeps its mines
   * unless they sit inside the zone, in which case they are re-placed randomly.
   */
  private plantMines(safeRow: number, safeCol: number): void {
    const safe = new Set<number>([safeRow * COLS + safeCol]);
    for (const offset of NEIGHBOUR_OFFSETS) {
      const row = safeRow + offset.row;
      const col = safeCol + offset.col;
      if (isInBounds(row, col)) {
        safe.add(row * COLS + col);
      }
    }

    const mines = new Set<number>(this.initialMineIndexes ?? []);
    for (const index of mines) {
      if (safe.has(index)) {
        mines.delete(index);
      }
    }

    const candidates: number[] = [];
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (!safe.has(index) && !mines.has(index)) {
        candidates.push(index);
      }
    }

    const needed = MINE_COUNT - mines.size;
    if (candidates.length < needed) {
      throw new RangeError('Not enough cells outside the first-click safe zone.');
    }
    for (let placed = 0; placed < needed; placed += 1) {
      const offset = Math.min(candidates.length - 1, Math.floor(this.roll() * candidates.length));
      const chosen = candidates[offset];
      if (chosen === undefined) {
        throw new Error('Failed to pick a mine cell.');
      }
      mines.add(chosen);
      const tail = candidates.pop();
      if (tail === undefined) {
        throw new Error('Failed to remove a mine candidate.');
      }
      if (offset < candidates.length) {
        candidates[offset] = tail;
      }
    }

    for (const index of mines) {
      const cell = this.cells[index];
      if (cell) {
        cell.mine = true;
      }
    }
    this.computeAdjacentCounts();
    this.placed = true;
    this.gameStatus = 'playing';
  }

  private computeAdjacentCounts(): void {
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const cell = this.cellAt(row, col);
        if (cell.mine) {
          cell.adjacent = 0;
          continue;
        }
        let count = 0;
        for (const offset of NEIGHBOUR_OFFSETS) {
          const neighbourRow = row + offset.row;
          const neighbourCol = col + offset.col;
          if (!isInBounds(neighbourRow, neighbourCol)) {
            continue;
          }
          const neighbour = this.cells[neighbourRow * COLS + neighbourCol];
          if (neighbour?.mine) {
            count += 1;
          }
        }
        cell.adjacent = count;
      }
    }
  }

  /** Reveal `row, col` and, for blank cells, every connected blank area. */
  private floodReveal(row: number, col: number): Cell[] {
    const revealed: Cell[] = [];
    const stack: Cell[] = [{ row, col }];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        break;
      }
      const cell = this.cells[current.row * COLS + current.col];
      if (!cell || cell.mine || cell.revealed || cell.flagged) {
        continue;
      }

      cell.revealed = true;
      revealed.push({ row: current.row, col: current.col });
      if (cell.adjacent !== 0) {
        continue;
      }
      for (const offset of NEIGHBOUR_OFFSETS) {
        const neighbourRow = current.row + offset.row;
        const neighbourCol = current.col + offset.col;
        if (isInBounds(neighbourRow, neighbourCol)) {
          stack.push({ row: neighbourRow, col: neighbourCol });
        }
      }
    }
    return revealed;
  }

  private allSafeCellsRevealed(): boolean {
    return this.cells.every((cell) => cell.mine || cell.revealed);
  }

  /** Return a clamped random value in [0, 1); broken sources fall back to 0.5. */
  private roll(): number {
    const value = this.rng();
    if (!Number.isFinite(value)) {
      return 0.5;
    }
    return Math.min(1 - Number.EPSILON, Math.max(0, value));
  }

  private cellAt(row: number, col: number): CellState {
    if (!isInBounds(row, col)) {
      throw new RangeError(`Cell out of bounds: (${row}, ${col}).`);
    }
    const cell = this.cells[row * COLS + col];
    if (!cell) {
      throw new RangeError(`Cell out of bounds: (${row}, ${col}).`);
    }
    return cell;
  }

  private snapshotCell(row: number, col: number): MinesweeperCell {
    const cell = this.cellAt(row, col);
    return {
      row,
      col,
      mine: cell.mine,
      revealed: cell.revealed,
      flagged: cell.flagged,
      adjacentMines: cell.adjacent,
    };
  }
}
