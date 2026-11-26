/**
 * Redacted online Minesweeper board (#486 t3).
 *
 * The board renders only what the authoritative server publishes: the redacted
 * `snapshot.board` in {@link BoardViewModel}. A hidden cell therefore has no
 * mine field, no mine attribute and no mine icon in the DOM. Mine positions are
 * painted only when the room view supplies the end-only `finalSnapshot` in
 * {@link OnlineBoardContext.finalBoard}; that value is ignored unless the room
 * is `finished`, so a stale or mistaken context cannot leak a hidden layout.
 *
 * The component implements the t1 {@link BoardRenderer} seam and adds one
 * optional context provider for the values the board view model does not carry
 * (room phase, turn ownership, the selectors' `actionGate` and the end-only
 * board). The room view can derive those from `RoomClientState`; a standalone
 * renderer falls back to the rules in {@link deriveBoardContext}.
 *
 * The t1 factory takes no arguments, so the room view must create the
 * renderer itself and pass the context:
 * `() => createBoardRenderer({ context: () => latestContext })`, where the
 * closure reads the current `RoomClientState`. Wiring `createBoardRenderer`
 * directly as the factory leaves the board on the snapshot-only fallback,
 * which cannot see a room that ended while its last snapshot still says
 * `playing` and therefore cannot paint the end-only mines.
 *
 * This module imports the client contract and the wire reveal types only. It
 * never imports the store, the transport or any server module, and it emits a
 * single `{kind, row, col}` intent instead of a protocol message.
 */

import type { ActionKind, RevealedBoard, RevealedCell } from '../types';
import type {
  BoardActionBlockReason,
  BoardActionGate,
  BoardActionIntent,
  BoardRenderer,
  BoardViewModel,
  OnlineBoardCellView,
  RoomClientPhase,
} from './contracts';
import './board.css';

/** Long-press duration on a touchscreen before a flag intent is emitted. */
export const DEFAULT_LONG_PRESS_MS = 500;

/** Moving further than this while holding cancels the long press (e.g. scroll). */
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

/** Decide whether one board intent is currently allowed. */
export type BoardActionGateFn = (
  row: number,
  col: number,
  kind: ActionKind,
) => BoardActionGate;

/**
 * Read-only context the board needs beyond the redacted view model.
 *
 * `finalBoard` is the `end.finalSnapshot` board and is painted only when
 * `phase` is `finished`; every other value keeps hidden cells redacted.
 */
export interface OnlineBoardContext {
  readonly phase: RoomClientPhase;
  readonly isMyTurn: boolean;
  readonly actionGate: BoardActionGateFn;
  readonly finalBoard: RevealedBoard | null;
}

/** Options for {@link createBoardRenderer}. */
export interface OnlineBoardRendererOptions {
  /** Long-press duration for touch flagging; defaults to 500 ms. */
  readonly longPressMs?: number;
  /**
   * Latest context for each render. The room view closes over its store state;
   * when omitted the board derives phase/turn/gate from the view model.
   */
  readonly context?: () => OnlineBoardContext | null;
}

const BLOCK_MESSAGES: Readonly<Record<BoardActionBlockReason, string>> = {
  'room-not-playing': '对局未在进行中。',
  'missing-board': '棋盘数据尚未就绪。',
  'not-your-turn': '还没轮到你行动。',
  'out-of-bounds': '这个格子不在棋盘内。',
  'cell-revealed': '这个格子已经翻开。',
  'cell-flagged': '这个格子已经插旗。',
  'awaiting-server': '这一步正在等待服务器确认。',
};

type CellVisual = 'hidden' | 'flagged' | 'revealed' | 'mine' | 'exploded';

interface CellCoordinates {
  readonly row: number;
  readonly col: number;
}

interface LongPressGesture extends CellCoordinates {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  timer: number;
}

function blocked(reason: BoardActionBlockReason): BoardActionGate {
  return { allowed: false, reason, message: BLOCK_MESSAGES[reason] };
}

function allowed(): BoardActionGate {
  return { allowed: true, reason: null, message: null };
}

function cellAt(
  board: BoardViewModel,
  row: number,
  col: number,
): OnlineBoardCellView | undefined {
  return board.cells[row]?.[col];
}

/**
 * Cell-state block reason shared by the fallback and injected gates.
 *
 * Room phase and turn ownership are checked by the callers because the
 * fallback derives them from the snapshot while the room view injects them.
 */
function cellStateBlockReason(
  board: BoardViewModel,
  row: number,
  col: number,
): BoardActionBlockReason | null {
  if (row < 0 || row >= board.rows || col < 0 || col >= board.cols) {
    return 'out-of-bounds';
  }
  const cell = cellAt(board, row, col);
  if (!cell) {
    return 'missing-board';
  }
  if (cell.pending) {
    return 'awaiting-server';
  }
  if (cell.revealed) {
    return 'cell-revealed';
  }
  if (cell.flagged) {
    return 'cell-flagged';
  }
  return null;
}

/**
 * The default action gate for a standalone board.
 *
 * The room view injects the selectors' `actionGate`, which is the canonical
 * gate; this fallback mirrors the t1 block reasons so the renderer is still
 * safe (and testable) when it is rendered without a store.
 */
function defaultActionGate(
  board: BoardViewModel,
  finalBoard: RevealedBoard | null,
  row: number,
  col: number,
  kind: ActionKind,
): BoardActionGate {
  if (board.status !== 'playing') {
    return blocked('room-not-playing');
  }
  if (board.selfId === null || board.selfId !== board.turnPlayerId) {
    return blocked('not-your-turn');
  }
  if (finalBoard !== null) {
    return blocked('room-not-playing');
  }
  const reason = cellStateBlockReason(board, row, col);
  if (reason !== null) {
    return blocked(reason);
  }
  // Both reveal and flag share the same board gate; `kind` is kept so the
  // signature cannot drift from the selectors' contract.
  void kind;
  return allowed();
}

/**
 * Derive the default context from a redacted view model.
 *
 * `phase` and turn ownership are derived from the view: a `playing` snapshot
 * means the room is playing, while `won`/`lost` mean the match is finished.
 * There is no final board in this fallback, so mines stay hidden.
 *
 * This fallback is for a standalone renderer or tests; it cannot see a room
 * that ended by forfeit/turn timeout while the last snapshot still says
 * `playing`. The online room view must inject the real phase (from its store)
 * for room play.
 */
export function deriveBoardContext(board: BoardViewModel): OnlineBoardContext {
  const phase: RoomClientPhase = board.status === 'playing' ? 'playing' : 'finished';
  const isMyTurn =
    phase === 'playing' &&
    board.selfId !== null &&
    board.selfId === board.turnPlayerId;
  return {
    phase,
    isMyTurn,
    finalBoard: null,
    actionGate: (row, col, kind) => defaultActionGate(board, null, row, col, kind),
  };
}

/**
 * Trust the injected context for phase/turn, but keep the board's own redaction
 * and state invariants: final mines are usable only after `finished`, and a
 * revealed, flagged or pending cell can never be acted on even if a custom gate
 * says otherwise. The room phase is authoritative here: `end` can arrive while
 * the last redacted snapshot still says `playing`, and only the finished phase
 * unlocks its `finalBoard`.
 */
function normaliseContext(
  board: BoardViewModel,
  injected: OnlineBoardContext | null,
): OnlineBoardContext {
  if (injected === null) {
    return deriveBoardContext(board);
  }
  const ended = injected.phase === 'finished';
  const finalBoard = ended ? injected.finalBoard : null;
  const actionGate: BoardActionGateFn = (row, col, kind) => {
    if (injected.phase !== 'playing' || board.status !== 'playing') {
      return blocked('room-not-playing');
    }
    if (!injected.isMyTurn) {
      return blocked('not-your-turn');
    }
    if (finalBoard !== null) {
      return blocked('room-not-playing');
    }
    const reason = cellStateBlockReason(board, row, col);
    if (reason !== null) {
      return blocked(reason);
    }
    return injected.actionGate(row, col, kind);
  };
  return {
    phase: injected.phase,
    isMyTurn: injected.isMyTurn,
    finalBoard,
    actionGate,
  };
}

function visualFor(
  cell: OnlineBoardCellView | undefined,
  finalCell: RevealedCell | undefined,
  ended: boolean,
): CellVisual {
  if (ended) {
    if (!finalCell) {
      if (cell?.revealed === true) {
        return 'revealed';
      }
      return cell?.flagged === true ? 'flagged' : 'hidden';
    }
    if (finalCell.mine) {
      if (finalCell.revealed) {
        return 'exploded';
      }
      return finalCell.flagged ? 'flagged' : 'mine';
    }
    if (finalCell.revealed) {
      return 'revealed';
    }
    return finalCell.flagged ? 'flagged' : 'hidden';
  }
  if (!cell) {
    return 'hidden';
  }
  if (cell.revealed) {
    return 'revealed';
  }
  return cell.flagged ? 'flagged' : 'hidden';
}

function cellContent(visual: CellVisual, adjacentMines: number): string {
  switch (visual) {
    case 'flagged':
      return '⚑';
    case 'mine':
    case 'exploded':
      return '✹';
    case 'revealed':
      return adjacentMines > 0 ? String(adjacentMines) : '';
    case 'hidden':
      return '';
  }
}

function cellLabel(
  row: number,
  col: number,
  visual: CellVisual,
  adjacentMines: number,
  endedMine: boolean,
): string {
  const position = `第 ${row + 1} 行第 ${col + 1} 列`;
  switch (visual) {
    case 'flagged':
      return endedMine ? `${position}，已插旗，地雷` : `${position}，已插旗`;
    case 'revealed':
      return adjacentMines === 0
        ? `${position}，已翻开，周围没有地雷`
        : `${position}，已翻开，周围 ${adjacentMines} 颗雷`;
    case 'mine':
      return `${position}，地雷`;
    case 'exploded':
      return `${position}，踩中的地雷`;
    case 'hidden':
      return `${position}，未翻开`;
  }
}

function isCoordinates(value: CellCoordinates | null): value is CellCoordinates {
  return value !== null;
}

let boardInstanceCounter = 0;

/**
 * Create the independent online board renderer.
 *
 * One instance owns one rendered board at a time. Calling `render` again on the
 * same container updates the cells in place, so focus, the touch gesture and
 * the flag-mode preference survive a snapshot. Changing rows/cols or the
 * container rebuilds the grid. `destroy` detaches every listener and timer.
 */
export function createBoardRenderer(
  options: OnlineBoardRendererOptions = {},
): BoardRenderer {
  const longPressMs = options.longPressMs ?? DEFAULT_LONG_PRESS_MS;
  const contextProvider = options.context;

  let container: HTMLElement | null = null;
  let shell: HTMLElement | null = null;
  let grid: HTMLElement | null = null;
  let flagButton: HTMLButtonElement | null = null;
  let controller: AbortController | null = null;
  let cellButtons: HTMLButtonElement[][] = [];
  let board: BoardViewModel | null = null;
  let context: OnlineBoardContext | null = null;
  let onIntent: ((intent: BoardActionIntent) => void) | null = null;
  let flagMode = false;
  let focusRow = 0;
  let focusCol = 0;
  let longPress: LongPressGesture | null = null;
  let suppressClickAt: CellCoordinates | null = null;
  let lastTouchAt = 0;
  const hintId = `online-board-hint-${(boardInstanceCounter += 1)}`;

  function cellButtonFrom(target: EventTarget | null): HTMLButtonElement | null {
    if (!(target instanceof Element) || grid === null) {
      return null;
    }
    const button = target.closest<HTMLButtonElement>('button[data-cell]');
    if (!button || !grid.contains(button)) {
      return null;
    }
    return button;
  }

  function coordinatesOf(button: HTMLButtonElement): CellCoordinates | null {
    const row = Number(button.dataset.row);
    const col = Number(button.dataset.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) {
      return null;
    }
    if (!board || row < 0 || row >= board.rows || col < 0 || col >= board.cols) {
      return null;
    }
    return { row, col };
  }

  function clearLongPress(): void {
    if (longPress !== null) {
      window.clearTimeout(longPress.timer);
      longPress = null;
    }
  }

  function clearSuppress(): void {
    suppressClickAt = null;
  }

  /**
   * Ignore the synthetic click for this touch gesture.
   *
   * There is deliberately no timeout: a finger can stay down well past the
   * long-press threshold, so the release click may arrive seconds later. The
   * token is scoped to the cell, cleared by the next pointerdown, and consumed
   * by that cell's click; an unrelated tap is never swallowed.
   */
  function suppressNextClick(row: number, col: number): void {
    suppressClickAt = { row, col };
  }

  function isCellBlocked(button: HTMLButtonElement): boolean {
    return button.dataset.locked === 'true';
  }

  function applyRovingTabindex(): void {
    for (let row = 0; row < cellButtons.length; row += 1) {
      const buttons = cellButtons[row];
      if (!buttons) {
        continue;
      }
      for (let col = 0; col < buttons.length; col += 1) {
        const button = buttons[col];
        if (!button) {
          continue;
        }
        button.tabIndex = row === focusRow && col === focusCol ? 0 : -1;
      }
    }
  }

  function focusCell(row: number, col: number): void {
    const button = cellButtons[row]?.[col];
    if (!button) {
      return;
    }
    focusRow = row;
    focusCol = col;
    applyRovingTabindex();
    button.focus();
  }

  function moveFocus(row: number, col: number, rowDelta: number, colDelta: number): void {
    const rows = cellButtons.length;
    const cols = cellButtons[0]?.length ?? 0;
    let nextRow = row;
    let nextCol = col;
    for (let step = 0; step < rows + cols; step += 1) {
      nextRow += rowDelta;
      nextCol += colDelta;
      if (nextRow < 0 || nextRow >= rows || nextCol < 0 || nextCol >= cols) {
        return;
      }
      if (cellButtons[nextRow]?.[nextCol]) {
        focusCell(nextRow, nextCol);
        return;
      }
    }
  }

  function focusRowEdge(row: number, fromEnd: boolean): void {
    const cols = cellButtons[0]?.length ?? 0;
    for (let step = 0; step < cols; step += 1) {
      const col = fromEnd ? cols - 1 - step : step;
      if (cellButtons[row]?.[col]) {
        focusCell(row, col);
        return;
      }
    }
  }

  function emit(kind: ActionKind, row: number, col: number): boolean {
    if (!context || !board || !onIntent) {
      return false;
    }
    const cell = cellAt(board, row, col);
    if (!cell || cell.revealed || cell.flagged || cell.pending) {
      return false;
    }
    if (!context.actionGate(row, col, kind).allowed) {
      return false;
    }
    // Only the intent shape leaves the renderer; the view turns it into an
    // `action` after its own sequencing checks.
    onIntent({ kind, row, col });
    return true;
  }

  function buildCells(view: BoardViewModel): void {
    if (!grid) {
      return;
    }
    // A rebuilt grid has different nodes; a pending hold must not flag a cell
    // in the new layout by its old coordinates.
    clearLongPress();
    clearSuppress();
    const rows = Math.max(0, Math.floor(view.rows));
    const cols = Math.max(0, Math.floor(view.cols));
    grid.style.setProperty('--rows', String(rows));
    grid.style.setProperty('--cols', String(cols));
    grid.setAttribute('aria-label', `联机扫雷棋盘，${rows} 行 ${cols} 列`);
    grid.setAttribute('aria-rowcount', String(rows));
    grid.setAttribute('aria-colcount', String(cols));

    const nextButtons: HTMLButtonElement[][] = [];
    const rowsFragment: HTMLElement[] = [];
    for (let row = 0; row < rows; row += 1) {
      const rowElement = document.createElement('div');
      rowElement.className = 'online-board__row';
      rowElement.setAttribute('role', 'row');
      rowElement.setAttribute('aria-rowindex', String(row + 1));
      rowElement.dataset.testid = `online-board-row-${row}`;
      const buttons: HTMLButtonElement[] = [];
      for (let col = 0; col < cols; col += 1) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'online-board__cell';
        button.setAttribute('role', 'gridcell');
        button.setAttribute('aria-colindex', String(col + 1));
        button.dataset.testid = `online-cell-${row}-${col}`;
        button.dataset.cell = '';
        button.dataset.row = String(row);
        button.dataset.col = String(col);
        button.tabIndex = -1;
        buttons.push(button);
        rowElement.append(button);
      }
      nextButtons.push(buttons);
      rowsFragment.push(rowElement);
    }
    grid.replaceChildren(...rowsFragment);
    cellButtons = nextButtons;
    if (focusRow >= rows || focusCol >= cols) {
      focusRow = 0;
      focusCol = 0;
    }
  }

  function refresh(): void {
    if (!board || !context || !grid || !shell) {
      return;
    }
    const canAct =
      context.phase === 'playing' &&
      context.isMyTurn &&
      context.finalBoard === null &&
      board.status === 'playing';
    shell.dataset.phase = context.phase;
    shell.dataset.canAct = String(canAct);
    grid.setAttribute('aria-readonly', String(!canAct));

    if (flagButton) {
      flagButton.disabled = !canAct;
      flagButton.setAttribute('aria-disabled', String(!canAct));
      flagButton.setAttribute('aria-pressed', String(flagMode));
      flagButton.dataset.active = String(flagMode);
    }

    for (let row = 0; row < cellButtons.length; row += 1) {
      const buttons = cellButtons[row];
      if (!buttons) {
        continue;
      }
      for (let col = 0; col < buttons.length; col += 1) {
        const button = buttons[col];
        if (!button) {
          continue;
        }
        const cell = board.cells[row]?.[col];
        const finalCell = context.finalBoard?.[row]?.[col];
        const ended = context.finalBoard !== null;
        const visual = visualFor(cell, finalCell, ended);
        const adjacentMines = finalCell?.adjacentMines ?? cell?.adjacentMines ?? 0;
        const pending = context.finalBoard === null && cell?.pending === true;
        const revealGate = context.actionGate(row, col, 'reveal');
        const flagGate = context.actionGate(row, col, 'flag');
        const blockedNow = !canAct || pending || !(revealGate.allowed || flagGate.allowed);

        button.dataset.locked = String(blockedNow);
        button.setAttribute('aria-disabled', String(blockedNow));
        button.dataset.state = visual;
        if (visual === 'revealed' || visual === 'exploded') {
          button.dataset.revealed = 'true';
        } else {
          delete button.dataset.revealed;
        }
        if (visual === 'flagged') {
          button.dataset.flagged = 'true';
        } else {
          delete button.dataset.flagged;
        }
        if (visual === 'revealed' && adjacentMines > 0) {
          button.dataset.number = String(adjacentMines);
        } else {
          delete button.dataset.number;
        }
        if (finalCell?.mine === true) {
          button.dataset.mine = 'true';
        } else {
          delete button.dataset.mine;
        }
        if (pending) {
          button.dataset.pending = 'true';
        } else {
          delete button.dataset.pending;
        }
        const blockReason = revealGate.reason ?? flagGate.reason;
        if (blockedNow && blockReason !== null) {
          button.dataset.blockReason = blockReason;
        } else {
          delete button.dataset.blockReason;
        }
        button.textContent = cellContent(visual, adjacentMines);
        button.setAttribute(
          'aria-label',
          cellLabel(row, col, visual, adjacentMines, finalCell?.mine === true),
        );
      }
    }

    const current = cellButtons[focusRow]?.[focusCol];
    if (!current) {
      focusRow = 0;
      focusCol = 0;
    }
    applyRovingTabindex();
    // The grid itself is not a tab stop: the roving cell keeps keyboard focus
    // and navigation working even while every cell is aria-disabled.
    grid.tabIndex = -1;
  }

  function handleClick(event: MouseEvent): void {
    if (
      flagButton !== null &&
      event.target instanceof Node &&
      flagButton.contains(event.target)
    ) {
      if (flagButton.disabled) {
        return;
      }
      clearSuppress();
      flagMode = !flagMode;
      refresh();
      return;
    }
    if (suppressClickAt !== null) {
      const target = cellButtonFrom(event.target);
      const position = target === null ? null : coordinatesOf(target);
      const sameCell =
        position !== null &&
        position.row === suppressClickAt.row &&
        position.col === suppressClickAt.col;
      clearSuppress();
      if (sameCell) {
        return;
      }
    }
    const button = cellButtonFrom(event.target);
    if (!button || isCellBlocked(button)) {
      return;
    }
    const position = coordinatesOf(button);
    if (!isCoordinates(position)) {
      return;
    }
    emit(flagMode ? 'flag' : 'reveal', position.row, position.col);
  }

  function handleContextMenu(event: MouseEvent): void {
    // Keep the native menu closed anywhere on the grid, including a disabled
    // cell whose right-click has no legal action.
    if (
      grid !== null &&
      event.target instanceof Node &&
      grid.contains(event.target)
    ) {
      event.preventDefault();
    }
    const button = cellButtonFrom(event.target);
    if (!button) {
      return;
    }
    // Some touch browsers fire the native contextmenu for the same hold as our
    // long-press timer or the tap that flag mode already handles. Whichever
    // path owns the gesture must emit exactly once; the others only close the
    // native menu.
    if (suppressClickAt !== null) {
      return;
    }
    const gesture = longPress;
    if (gesture !== null) {
      clearLongPress();
      if (emit('flag', gesture.row, gesture.col)) {
        suppressNextClick(gesture.row, gesture.col);
      }
      return;
    }
    const touchContextMenu =
      (event instanceof PointerEvent && event.pointerType === 'touch') ||
      (lastTouchAt !== 0 && Date.now() - lastTouchAt < 1000);
    if (touchContextMenu) {
      // No active hold: the release click (or flag mode's tap) owns the action.
      return;
    }
    if (isCellBlocked(button)) {
      return;
    }
    const position = coordinatesOf(button);
    if (!isCoordinates(position)) {
      return;
    }
    emit('flag', position.row, position.col);
  }

  function handlePointerDown(event: PointerEvent): void {
    lastTouchAt = event.pointerType === 'touch' ? Date.now() : 0;
    // A new press starts a new gesture; a stale release-click token from a
    // previous hold must not swallow it.
    clearSuppress();
    if (event.pointerType !== 'touch') {
      return;
    }
    clearLongPress();
    const button = cellButtonFrom(event.target);
    if (!button || isCellBlocked(button) || flagMode) {
      return;
    }
    const position = coordinatesOf(button);
    if (!isCoordinates(position)) {
      return;
    }
    const gesture: LongPressGesture = {
      pointerId: event.pointerId,
      row: position.row,
      col: position.col,
      startX: event.clientX,
      startY: event.clientY,
      timer: 0,
    };
    gesture.timer = window.setTimeout(() => {
      if (longPress !== gesture) {
        return;
      }
      longPress = null;
      if (emit('flag', gesture.row, gesture.col)) {
        suppressNextClick(gesture.row, gesture.col);
      }
    }, longPressMs);
    longPress = gesture;
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!longPress || longPress.pointerId !== event.pointerId) {
      return;
    }
    const distance = Math.hypot(
      event.clientX - longPress.startX,
      event.clientY - longPress.startY,
    );
    if (distance > LONG_PRESS_MOVE_TOLERANCE_PX) {
      clearLongPress();
    }
  }

  function handlePointerEnd(event: PointerEvent): void {
    if (longPress?.pointerId === event.pointerId) {
      clearLongPress();
    }
  }

  function handlePointerLeave(): void {
    clearLongPress();
  }

  function handleKeydown(event: KeyboardEvent): void {
    const button = cellButtonFrom(event.target);
    if (!button) {
      return;
    }
    const position = coordinatesOf(button);
    if (!isCoordinates(position)) {
      return;
    }
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        moveFocus(position.row, position.col, 0, -1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        moveFocus(position.row, position.col, 0, 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(position.row, position.col, -1, 0);
        return;
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(position.row, position.col, 1, 0);
        return;
      case 'Home':
        event.preventDefault();
        focusRowEdge(position.row, false);
        return;
      case 'End':
        event.preventDefault();
        focusRowEdge(position.row, true);
        return;
      case 'f':
      case 'F':
        if (!isCellBlocked(button)) {
          event.preventDefault();
          emit('flag', position.row, position.col);
        }
        return;
      default:
        return;
    }
  }

  function handleFocusIn(event: FocusEvent): void {
    const button = cellButtonFrom(event.target);
    if (!button) {
      return;
    }
    const position = coordinatesOf(button);
    if (!isCoordinates(position)) {
      return;
    }
    focusRow = position.row;
    focusCol = position.col;
    applyRovingTabindex();
  }

  function teardownShell(): void {
    controller?.abort();
    controller = null;
    clearLongPress();
    clearSuppress();
    shell?.remove();
    shell = null;
    grid = null;
    flagButton = null;
    cellButtons = [];
  }

  function buildDom(view: BoardViewModel): void {
    if (!container) {
      return;
    }
    teardownShell();
    const nextController = new AbortController();
    controller = nextController;
    const { signal } = nextController;

    const nextShell = document.createElement('div');
    nextShell.className = 'online-board-shell';
    nextShell.dataset.testid = 'online-board-shell';

    const toolbar = document.createElement('div');
    toolbar.className = 'online-board__toolbar';

    const nextFlagButton = document.createElement('button');
    nextFlagButton.type = 'button';
    nextFlagButton.className = 'online-board__flag-mode';
    nextFlagButton.dataset.testid = 'online-board-flag-mode';
    nextFlagButton.setAttribute('aria-pressed', 'false');
    nextFlagButton.textContent = '插旗模式';

    const hint = document.createElement('p');
    hint.className = 'online-board__hint';
    hint.id = hintId;
    hint.textContent =
      '左键翻开；右键或长按插旗。键盘方向键移动，Enter 翻开，F 插旗。';
    toolbar.append(nextFlagButton, hint);

    const nextGrid = document.createElement('div');
    nextGrid.className = 'online-board';
    nextGrid.setAttribute('role', 'grid');
    nextGrid.setAttribute('aria-describedby', hintId);
    nextGrid.dataset.testid = 'online-board';

    nextShell.append(toolbar, nextGrid);
    nextShell.addEventListener('click', handleClick, { signal });
    nextShell.addEventListener('contextmenu', handleContextMenu, { signal });
    nextShell.addEventListener('pointerdown', handlePointerDown, { signal });
    nextShell.addEventListener('pointermove', handlePointerMove, { signal });
    nextShell.addEventListener('pointerup', handlePointerEnd, { signal });
    nextShell.addEventListener('pointercancel', handlePointerEnd, { signal });
    nextShell.addEventListener('keydown', handleKeydown, { signal });
    nextShell.addEventListener('focusin', handleFocusIn, { signal });
    nextGrid.addEventListener('pointerleave', handlePointerLeave, { signal });

    container.replaceChildren(nextShell);
    shell = nextShell;
    grid = nextGrid;
    flagButton = nextFlagButton;
    buildCells(view);
  }

  return {
    render(nextContainer, view, nextOnIntent): void {
      onIntent = nextOnIntent;
      board = view;
      context = normaliseContext(view, contextProvider?.() ?? null);
      if (container !== nextContainer || shell === null || !nextContainer.contains(shell)) {
        container = nextContainer;
        buildDom(view);
      } else if (
        cellButtons.length !== Math.max(0, Math.floor(view.rows)) ||
        (cellButtons[0]?.length ?? 0) !== Math.max(0, Math.floor(view.cols))
      ) {
        buildCells(view);
      }
      refresh();
    },
    destroy(): void {
      teardownShell();
      container = null;
      board = null;
      context = null;
      onIntent = null;
      flagMode = false;
      focusRow = 0;
      focusCol = 0;
    },
  };
}
