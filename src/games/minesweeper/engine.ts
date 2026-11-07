/**
 * Framework-agnostic Minesweeper rules for a configurable board.
 *
 * The engine never touches the DOM, Phaser, timers or storage. Mines are only
 * placed on the first reveal. With the default `firstClickSafe` policy the
 * clicked cell and its eight neighbours are excluded from placement, so the
 * opening move is always safe; injected layouts that violate that rule are
 * repaired the same way. A renderer owns drawing, input and the animation loop,
 * calls `tick(deltaMs)` to advance the clock and reads immutable snapshots
 * from `state`.
 *
 * The board defaults to the classic beginner setup: 9x9 with 10 mines. The
 * exported `ROWS`, `COLS` and `MINE_COUNT` describe that default so existing
 * renderers keep working, while a `MinesweeperConfig` lets callers pick another
 * board size, mine count or first-click policy. Every configuration passes
 * through `validateConfig` before an engine is built; invalid values are
 * rejected instead of clamped or silently corrected.
 */

/** Board rows on the default beginner board, counted from the top. */
export const ROWS = 9;

/** Board columns on the default beginner board, counted from the left. */
export const COLS = 9;

/** Mines placed on the default beginner board. */
export const MINE_COUNT = 10;

/**
 * Playable bounds for a configured board. They keep the DOM grid readable on
 * desktop and mobile and include the classic 9x9, 16x16 and 16x30 layouts.
 */
export const MIN_ROWS = 5;
export const MAX_ROWS = 30;
export const MIN_COLS = 5;
export const MAX_COLS = 30;

/** Board dimensions, mine count and first-click policy for one game. */
export interface MinesweeperConfig {
  /** Board rows, counted from the top. */
  readonly rows: number;
  /** Board columns, counted from the left. */
  readonly cols: number;
  /** Mines placed on the board. */
  readonly mines: number;
  /**
   * Keep the first clicked cell and its neighbours mine-free. When false, mines
   * may sit anywhere, including the first clicked cell, and an injected layout
   * is kept exactly as supplied.
   */
  readonly firstClickSafe: boolean;
}

/** Classic beginner board: 9x9, 10 mines and a safe first click. */
export const DEFAULT_MINESWEEPER_CONFIG: Readonly<MinesweeperConfig> = Object.freeze({
  rows: ROWS,
  cols: COLS,
  mines: MINE_COUNT,
  firstClickSafe: true,
});

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

/** Immutable row-major board; rows are top to bottom, columns left to right. */
export type MinesweeperBoard = readonly (readonly MinesweeperCell[])[];

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
  readonly board: MinesweeperBoard;
}

export interface MinesweeperOptions {
  /** Board setup; defaults to the classic beginner board. */
  readonly config?: MinesweeperConfig;
  /** Source of randomness in the range [0, 1). Injectable for deterministic tests. */
  readonly rng?: () => number;
  /**
   * Exact mine layout for tests and replays. Must contain exactly
   * `config.mines` distinct, in-bounds cells. With `firstClickSafe` enabled,
   * every mine inside the first-click safe zone is moved to a random cell
   * outside it, so the first reveal is always safe; with it disabled, the
   * layout is kept exactly as supplied.
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

function isInside(rows: number, cols: number, row: number, col: number): boolean {
  return (
    Number.isInteger(row) &&
    Number.isInteger(col) &&
    row >= 0 &&
    row < rows &&
    col >= 0 &&
    col < cols
  );
}

/** True when `row` and `col` address a cell on the default beginner board. */
export function isInBounds(row: number, col: number): boolean {
  return isInside(ROWS, COLS, row, col);
}

/** Render a rejected value in an error message without losing its identity. */
function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  return String(value);
}

/** Throw a `RangeError` naming `field` and the rejected value. */
function rejectConfig(field: string, reason: string, value: unknown): never {
  throw new RangeError(
    `${field} ${reason}, received ${formatValue(value)}.`,
  );
}

function validateDimension(
  field: 'rows' | 'cols',
  value: number,
  min: number,
  max: number,
): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    rejectConfig(field, `must be an integer between ${min} and ${max}`, value);
  }
}

/**
 * Validate a board configuration and return a frozen copy of it.
 *
 * Rules, all enforced without clamping: `rows`/`cols` must be positive
 * integers inside the playable bounds; `mines` must be a positive integer
 * smaller than the cell count; `firstClickSafe` must be a boolean; and when
 * the first click is safe, every mine must fit outside the largest 3x3 safe
 * zone the board can produce. Importers such as a difficulty parser can reuse
 * this function instead of duplicating the bounds and capacity rules.
 *
 * @throws RangeError when the configuration is not playable.
 */
export function validateConfig(config: MinesweeperConfig): Readonly<MinesweeperConfig> {
  if (config === null || typeof config !== 'object') {
    rejectConfig('config', 'must be an object', config);
  }
  const { rows, cols, mines, firstClickSafe } = config;
  validateDimension('rows', rows, MIN_ROWS, MAX_ROWS);
  validateDimension('cols', cols, MIN_COLS, MAX_COLS);

  const cells = rows * cols;
  if (!Number.isInteger(mines) || mines <= 0) {
    rejectConfig('mines', 'must be a positive integer', mines);
  }
  if (mines >= cells) {
    rejectConfig('mines', `must be smaller than the ${cells} board cells`, mines);
  }
  if (firstClickSafe !== true && firstClickSafe !== false) {
    rejectConfig('firstClickSafe', 'must be a boolean', firstClickSafe);
  }
  if (firstClickSafe) {
    // No click can clear more than a 3x3 block, so that is the worst case the
    // mine count must fit around for every possible first click.
    const safeCapacity = Math.min(rows, 3) * Math.min(cols, 3);
    const available = cells - safeCapacity;
    if (mines > available) {
      rejectConfig(
        'mines',
        `must fit outside the ${safeCapacity}-cell first-click safe zone (at most ${available})`,
        mines,
      );
    }
  }

  return Object.freeze({ rows, cols, mines, firstClickSafe });
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

function createCells(rows: number, cols: number): CellState[] {
  return Array.from({ length: rows * cols }, () => ({
    mine: false,
    revealed: false,
    flagged: false,
    adjacent: 0,
  }));
}

export class MinesweeperEngine {
  private readonly config: Readonly<MinesweeperConfig>;
  private readonly rng: () => number;
  private readonly initialMineIndexes: readonly number[] | null;

  private cells: CellState[] = [];
  private gameStatus: MinesweeperStatus = 'ready';
  private elapsed = 0;
  private flagged = 0;
  private placed = false;
  private exploded: Cell | null = null;

  constructor(options: MinesweeperOptions = {}) {
    this.config = validateConfig(
      options.config === undefined ? DEFAULT_MINESWEEPER_CONFIG : options.config,
    );
    this.rng = options.rng ?? Math.random;
    this.initialMineIndexes = options.initialMines
      ? this.validateMines(options.initialMines)
      : null;
    this.reset();
  }

  /** Immutable view of the board, clock and status. */
  get state(): MinesweeperSnapshot {
    const { rows, cols, mines } = this.config;
    const board = Array.from({ length: rows }, (_, row) =>
      Array.from({ length: cols }, (_, col) => this.snapshotCell(row, col)),
    );
    return {
      rows,
      cols,
      mineCount: mines,
      flaggedCount: this.flagged,
      remainingMines: mines - this.flagged,
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
    return this.config.mines - this.flagged;
  }

  /**
   * Reveal one cell. The first call plants the mines (outside the safe zone
   * when `firstClickSafe` is enabled), starts the clock and flood-fills
   * through blank cells. Revealing a flagged or already revealed cell is a
   * no-op; any action after a win or loss is a no-op as well.
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
    this.cells = createCells(this.config.rows, this.config.cols);
    this.gameStatus = 'ready';
    this.elapsed = 0;
    this.flagged = 0;
    this.placed = false;
    this.exploded = null;
  }

  private validateMines(mines: readonly Cell[]): number[] {
    const { rows, cols, mines: mineCount } = this.config;
    if (mines.length !== mineCount) {
      throw new RangeError(
        `initialMines must contain exactly ${mineCount} cells, received ${mines.length}.`,
      );
    }
    const seen = new Set<number>();
    const indexes: number[] = [];
    for (const mine of mines) {
      if (!isInside(rows, cols, mine.row, mine.col)) {
        throw new RangeError(
          `Mine out of bounds: (${mine.row}, ${mine.col}) for a ${rows}x${cols} board.`,
        );
      }
      const index = mine.row * cols + mine.col;
      if (seen.has(index)) {
        throw new RangeError(`Duplicate mine at (${mine.row}, ${mine.col}).`);
      }
      seen.add(index);
      indexes.push(index);
    }
    return indexes;
  }

  /** Indexes covered by the first-click safe zone, clipped to the board. */
  private safeZoneIndexes(row: number, col: number): Set<number> {
    const { rows, cols } = this.config;
    const safe = new Set<number>([row * cols + col]);
    for (const offset of NEIGHBOUR_OFFSETS) {
      const neighbourRow = row + offset.row;
      const neighbourCol = col + offset.col;
      if (isInside(rows, cols, neighbourRow, neighbourCol)) {
        safe.add(neighbourRow * cols + neighbourCol);
      }
    }
    return safe;
  }

  /**
   * Place every configured mine. With a safe first click every mine must stay
   * outside the safe zone, so an injected layout keeps its mines unless they
   * sit inside the zone, in which case they are re-placed randomly. With
   * `firstClickSafe: false`, mines may sit anywhere and an injected layout is
   * kept exactly.
   */
  private plantMines(safeRow: number, safeCol: number): void {
    const { firstClickSafe, mines: mineCount } = this.config;
    const cells = this.config.rows * this.config.cols;
    const safe = firstClickSafe ? this.safeZoneIndexes(safeRow, safeCol) : null;

    const mines = new Set<number>(this.initialMineIndexes ?? []);
    if (safe) {
      for (const index of mines) {
        if (safe.has(index)) {
          mines.delete(index);
        }
      }
    }

    const candidates: number[] = [];
    for (let index = 0; index < cells; index += 1) {
      if (!mines.has(index) && !(safe?.has(index) ?? false)) {
        candidates.push(index);
      }
    }

    const needed = mineCount - mines.size;
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
    const { rows, cols } = this.config;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const cell = this.cellAt(row, col);
        if (cell.mine) {
          cell.adjacent = 0;
          continue;
        }
        let count = 0;
        for (const offset of NEIGHBOUR_OFFSETS) {
          const neighbourRow = row + offset.row;
          const neighbourCol = col + offset.col;
          if (!isInside(rows, cols, neighbourRow, neighbourCol)) {
            continue;
          }
          const neighbour = this.cells[neighbourRow * cols + neighbourCol];
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
    const { rows, cols } = this.config;
    const revealed: Cell[] = [];
    const stack: Cell[] = [{ row, col }];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        break;
      }
      const cell = this.cells[current.row * cols + current.col];
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
        if (isInside(rows, cols, neighbourRow, neighbourCol)) {
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
    const { rows, cols } = this.config;
    if (!isInside(rows, cols, row, col)) {
      throw new RangeError(`Cell out of bounds: (${row}, ${col}).`);
    }
    const cell = this.cells[row * cols + col];
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
