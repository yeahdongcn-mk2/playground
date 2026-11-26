// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBoardRenderer,
  DEFAULT_LONG_PRESS_MS,
  deriveBoardContext,
  LONG_PRESS_MOVE_TOLERANCE_PX,
  type BoardActionGateFn,
  type OnlineBoardContext,
} from '../../src/games/minesweeper/online/client/board';
import type {
  BoardActionGate,
  BoardActionIntent,
  BoardRenderer,
  BoardViewModel,
  OnlineBoardCellView,
} from '../../src/games/minesweeper/online/client/contracts';
import type { RevealedBoard } from '../../src/games/minesweeper/online/types';

const ROWS = 3;
const COLS = 3;
const HOST = 'player-host';
const GUEST = 'player-guest';

function makeCells(
  overrides: Readonly<Record<string, Partial<OnlineBoardCellView>>> = {},
): OnlineBoardCellView[][] {
  return Array.from({ length: ROWS }, (_, row) =>
    Array.from({ length: COLS }, (_, col) => ({
      row,
      col,
      revealed: false,
      flagged: false,
      adjacentMines: 0,
      pending: false,
      ...overrides[`${row},${col}`],
    })),
  );
}

function makeView(overrides: Partial<BoardViewModel> = {}): BoardViewModel {
  return {
    roomId: 'room-board-test',
    matchId: 'match-board-test',
    selfId: HOST,
    turnPlayerId: HOST,
    turnId: 4,
    status: 'playing',
    seedHash: 'seed-hash',
    deadlineAt: 1_700_000_030_000,
    matchDeadlineAt: 1_700_000_900_000,
    elapsedMs: 12_000,
    mineCount: 2,
    remainingMines: 2,
    revealedSafeCount: 0,
    rows: ROWS,
    cols: COLS,
    cells: makeCells(),
    ...overrides,
  };
}

/** A gate that lets every in-bounds cell through; the board still enforces state. */
const allowGate: BoardActionGateFn = () => ({
  allowed: true,
  reason: null,
  message: null,
});

function makeContext(overrides: Partial<OnlineBoardContext> = {}): OnlineBoardContext {
  return {
    phase: 'playing',
    isMyTurn: true,
    actionGate: allowGate,
    finalBoard: null,
    ...overrides,
  };
}

const blockedGate: BoardActionGateFn = () => ({
  allowed: false,
  reason: 'awaiting-server',
  message: '这一步正在等待服务器确认。',
});

interface Harness {
  readonly container: HTMLElement;
  readonly intents: BoardActionIntent[];
  readonly renderer: BoardRenderer;
  setContext(context: OnlineBoardContext): void;
}

function mount(view: BoardViewModel, initialContext: OnlineBoardContext = makeContext()): Harness {
  let current = initialContext;
  const container = document.createElement('div');
  document.body.append(container);
  const intents: BoardActionIntent[] = [];
  const renderer = createBoardRenderer({ context: () => current });
  const render = (): void => {
    renderer.render(container, view, (intent) => {
      intents.push(intent);
    });
  };
  render();
  return {
    container,
    intents,
    renderer,
    setContext(context): void {
      current = context;
      render();
    },
  };
}

function grid(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-testid="online-board"]');
  if (!element) {
    throw new Error('expected the online board grid');
  }
  return element;
}

function cell(container: HTMLElement, row: number, col: number): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-testid="online-cell-${row}-${col}"]`,
  );
  if (!button) {
    throw new Error(`expected the cell at ${row},${col}`);
  }
  return button;
}

function flagToggle(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="online-board-flag-mode"]',
  );
  if (!button) {
    throw new Error('expected the flag-mode toggle');
  }
  return button;
}

function cells(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-cell]'));
}

/** Blocked cells are ARIA-disabled but stay focusable for read-only navigation. */
function isBlocked(button: HTMLButtonElement): boolean {
  return (
    button.getAttribute('aria-disabled') === 'true' &&
    button.dataset.locked === 'true'
  );
}

function click(target: HTMLElement): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
}

function rightClick(target: HTMLElement): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function pressKey(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function pointer(
  target: HTMLElement,
  type: string,
  init: PointerEventInit = {},
): PointerEvent {
  const event = new window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 2,
    pointerType: 'touch',
    isPrimary: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function makeFinalBoard(): RevealedBoard {
  return Array.from({ length: ROWS }, (_, row) =>
    Array.from({ length: COLS }, (_, col) => ({
      row,
      col,
      mine: (row === 0 && col === 0) || (row === 0 && col === 2),
      revealed: row === 1 && col === 1,
      flagged: row === 0 && col === 2,
      adjacentMines:
        row === 1 && col === 1 ? 2 : row === 2 && col === 2 ? 2 : 0,
    })),
  );
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('redacted online board rendering', () => {
  it('renders an ARIA grid from the redacted snapshot only', () => {
    const harness = mount(makeView());
    const board = grid(harness.container);

    expect(board.getAttribute('role')).toBe('grid');
    expect(board.getAttribute('aria-rowcount')).toBe(String(ROWS));
    expect(board.getAttribute('aria-colcount')).toBe(String(COLS));
    expect(board.getAttribute('aria-label')).toContain('3 行 3 列');
    expect(board.style.getPropertyValue('--rows')).toBe('3');
    expect(board.style.getPropertyValue('--cols')).toBe('3');

    const rows = board.querySelectorAll<HTMLElement>('[role="row"]');
    expect(rows).toHaveLength(ROWS);
    for (const [index, row] of Array.from(rows).entries()) {
      expect(row.getAttribute('aria-rowindex')).toBe(String(index + 1));
      const rowCells = row.querySelectorAll('[role="gridcell"]');
      expect(rowCells).toHaveLength(COLS);
      expect(rowCells[0]?.getAttribute('aria-colindex')).toBe('1');
      expect(rowCells[COLS - 1]?.getAttribute('aria-colindex')).toBe(String(COLS));
    }

    for (const button of cells(harness.container)) {
      expect(button.dataset.state).toBe('hidden');
      expect(button.textContent).toBe('');
      expect(button.hasAttribute('data-mine')).toBe(false);
      expect(button.hasAttribute('data-number')).toBe(false);
      expect(button.getAttribute('aria-label')).toContain('未翻开');
    }
    // No hidden mine field, attribute or icon may reach the DOM.
    expect(harness.container.innerHTML).not.toContain('data-mine');
    expect(harness.container.textContent).not.toContain('✹');
  });

  it('keeps hidden adjacent counts and flags from looking like mines', () => {
    const view = makeView({
      cells: makeCells({
        '0,0': { adjacentMines: 3 },
        '0,1': { flagged: true, adjacentMines: 5 },
        '1,1': { revealed: true, adjacentMines: 2 },
      }),
    });
    const harness = mount(view);

    const hidden = cell(harness.container, 0, 0);
    expect(hidden.textContent).toBe('');
    expect(hidden.hasAttribute('data-number')).toBe(false);
    expect(hidden.hasAttribute('data-mine')).toBe(false);

    const flagged = cell(harness.container, 0, 1);
    expect(flagged.textContent).toBe('⚑');
    expect(flagged.hasAttribute('data-mine')).toBe(false);
    expect(flagged.dataset.flagged).toBe('true');

    const revealed = cell(harness.container, 1, 1);
    expect(revealed.textContent).toBe('2');
    expect(revealed.dataset.number).toBe('2');
    expect(revealed.hasAttribute('data-mine')).toBe(false);
  });
});

describe('online board turn gating', () => {
  it('disables every cell and the flag toggle when it is not this seat turn', () => {
    const harness = mount(makeView(), makeContext({ isMyTurn: false }));
    const board = grid(harness.container);

    expect(board.getAttribute('aria-readonly')).toBe('true');
    expect(flagToggle(harness.container).disabled).toBe(true);
    for (const button of cells(harness.container)) {
      expect(isBlocked(button)).toBe(true);
      expect(button.disabled).toBe(false);
    }

    click(cell(harness.container, 0, 0));
    rightClick(cell(harness.container, 0, 0));
    pressKey(cell(harness.container, 0, 0), 'f');
    pressKey(cell(harness.container, 0, 0), 'Enter');
    expect(harness.intents).toEqual([]);
  });

  it('disables every cell while the room is not playing even on this seat turn', () => {
    const harness = mount(makeView(), makeContext({ phase: 'waiting', isMyTurn: true }));

    expect(flagToggle(harness.container).disabled).toBe(true);
    expect(flagToggle(harness.container).getAttribute('aria-disabled')).toBe('true');
    for (const button of cells(harness.container)) {
      expect(isBlocked(button)).toBe(true);
    }
    click(cell(harness.container, 1, 1));
    rightClick(cell(harness.container, 1, 1));
    pressKey(cell(harness.container, 1, 1), 'f');
    pressKey(cell(harness.container, 1, 1), 'Enter');
    expect(harness.intents).toEqual([]);
  });

  it('disables only revealed, flagged and pending cells on this seat turn', () => {
    const view = makeView({
      cells: makeCells({
        '0,0': { revealed: true, adjacentMines: 1 },
        '0,1': { flagged: true },
        '0,2': { pending: true },
      }),
    });
    const harness = mount(view);

    expect(isBlocked(cell(harness.container, 0, 0))).toBe(true);
    expect(isBlocked(cell(harness.container, 0, 1))).toBe(true);
    expect(isBlocked(cell(harness.container, 0, 2))).toBe(true);
    expect(cell(harness.container, 0, 2).dataset.pending).toBe('true');
    expect(isBlocked(cell(harness.container, 1, 0))).toBe(false);
    expect(isBlocked(cell(harness.container, 1, 1))).toBe(false);

    click(cell(harness.container, 0, 0));
    rightClick(cell(harness.container, 0, 1));
    click(cell(harness.container, 0, 2));
    expect(harness.intents).toEqual([]);
  });

  it('honours the injected selector gate even on an actionable cell', () => {
    const harness = mount(makeView(), makeContext({ actionGate: blockedGate }));

    expect(isBlocked(cell(harness.container, 1, 1))).toBe(true);
    click(cell(harness.container, 1, 1));
    expect(harness.intents).toEqual([]);
  });

  it('derives turn and phase without an injected context', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const intents: BoardActionIntent[] = [];
    const renderer = createBoardRenderer();

    renderer.render(container, makeView(), (intent) => intents.push(intent));
    click(cell(container, 1, 1));
    expect(intents).toEqual([{ kind: 'reveal', row: 1, col: 1 }]);

    renderer.render(
      container,
      makeView({ selfId: HOST, turnPlayerId: GUEST }),
      (intent) => intents.push(intent),
    );
    click(cell(container, 2, 2));
    expect(intents).toHaveLength(1);
    renderer.destroy();
  });
});

describe('online board intents and input modes', () => {
  it('emits exactly one reveal intent from a primary click', () => {
    const harness = mount(makeView());

    click(cell(harness.container, 1, 2));

    expect(harness.intents).toEqual([{ kind: 'reveal', row: 1, col: 2 }]);
    expect(Object.keys(harness.intents[0] ?? {}).sort()).toEqual([
      'col',
      'kind',
      'row',
    ]);
  });

  it('emits a flag intent from a mouse right click and keeps the menu closed', () => {
    const harness = mount(makeView());

    const event = rightClick(cell(harness.container, 2, 1));

    expect(event.defaultPrevented).toBe(true);
    expect(harness.intents).toEqual([{ kind: 'flag', row: 2, col: 1 }]);
  });

  it('emits a flag intent from the keyboard and moves focus with the arrow keys', () => {
    const harness = mount(makeView());
    const first = cell(harness.container, 0, 0);
    first.focus();

    pressKey(first, 'f');
    pressKey(first, 'ArrowRight');
    expect(document.activeElement).toBe(cell(harness.container, 0, 1));

    pressKey(document.activeElement as HTMLElement, 'End');
    expect(document.activeElement).toBe(cell(harness.container, 0, 2));
    pressKey(document.activeElement as HTMLElement, 'Home');
    expect(document.activeElement).toBe(cell(harness.container, 0, 0));

    expect(harness.intents).toEqual([{ kind: 'flag', row: 0, col: 0 }]);
    expect(cell(harness.container, 0, 0).tabIndex).toBe(0);
    expect(cell(harness.container, 0, 1).tabIndex).toBe(-1);
  });

  it('keeps read-only cells navigable with aria-disabled instead of native disabled', () => {
    const harness = mount(makeView(), makeContext({ isMyTurn: false }));
    const target = cell(harness.container, 1, 1);
    target.focus();
    expect(document.activeElement).toBe(target);

    pressKey(target, 'ArrowRight');
    expect(document.activeElement).toBe(cell(harness.container, 1, 2));
    expect(cell(harness.container, 1, 2).tabIndex).toBe(0);
    pressKey(cell(harness.container, 1, 2), 'f');
    expect(harness.intents).toEqual([]);
  });

  it('turns a tap into a flag while flag mode is on', () => {
    const harness = mount(makeView());
    const toggle = flagToggle(harness.container);

    click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    click(cell(harness.container, 1, 0));
    expect(harness.intents).toEqual([{ kind: 'flag', row: 1, col: 0 }]);

    click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    click(cell(harness.container, 1, 0));
    expect(harness.intents).toEqual([
      { kind: 'flag', row: 1, col: 0 },
      { kind: 'reveal', row: 1, col: 0 },
    ]);
  });

  it('flags after a touch long press and swallows the release click', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = mount(makeView());
    const target = cell(harness.container, 1, 1);

    pointer(target, 'pointerdown', { clientX: 4, clientY: 4 });
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);
    expect(harness.intents).toEqual([{ kind: 'flag', row: 1, col: 1 }]);

    // The release click that follows the long press must not also reveal.
    click(target);
    expect(harness.intents).toEqual([{ kind: 'flag', row: 1, col: 1 }]);
  });

  it('never appends a long-press flag to a completed tap', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = mount(makeView());
    const target = cell(harness.container, 1, 1);

    pointer(target, 'pointerdown', { clientX: 4, clientY: 4 });
    pointer(target, 'pointerup', { clientX: 4, clientY: 4 });
    click(target);
    // Releasing a short tap must disarm the long-press timer: at the deadline
    // the tap has already become exactly one reveal, not a reveal plus a flag.
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);

    expect(harness.intents).toEqual([{ kind: 'reveal', row: 1, col: 1 }]);
  });

  it('cancels a pending long press when the pointer is cancelled', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = mount(makeView());
    const target = cell(harness.container, 1, 1);

    pointer(target, 'pointerdown', { clientX: 4, clientY: 4 });
    pointer(target, 'pointercancel', { clientX: 4, clientY: 4 });
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);

    expect(harness.intents).toEqual([]);
  });

  it('does not double-flag when the browser also emits a touch contextmenu', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = mount(makeView());
    const target = cell(harness.container, 2, 0);

    pointer(target, 'pointerdown', { clientX: 4, clientY: 4 });
    const menu = pointer(target, 'contextmenu', { clientX: 4, clientY: 4 });
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);
    click(target);

    expect(menu.defaultPrevented).toBe(true);
    expect(harness.intents).toEqual([{ kind: 'flag', row: 2, col: 0 }]);
  });

  it('does not double-flag a flag-mode tap that also emits a touch contextmenu', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = mount(makeView());
    click(flagToggle(harness.container));
    const target = cell(harness.container, 2, 1);

    pointer(target, 'pointerdown', { clientX: 4, clientY: 4 });
    pointer(target, 'contextmenu', { clientX: 4, clientY: 4 });
    pointer(target, 'pointerup', { clientX: 4, clientY: 4 });
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);
    click(target);

    expect(harness.intents).toEqual([{ kind: 'flag', row: 2, col: 1 }]);
  });

  it('does not double-flag when the long-press timer wins the race', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = mount(makeView());
    const target = cell(harness.container, 2, 0);

    pointer(target, 'pointerdown', { clientX: 4, clientY: 4 });
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);
    pointer(target, 'contextmenu', { clientX: 4, clientY: 4 });
    click(target);

    expect(harness.intents).toEqual([{ kind: 'flag', row: 2, col: 0 }]);
  });

  it('keeps suppressing the release click even when the finger stays down', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = mount(makeView());
    const target = cell(harness.container, 1, 1);

    pointer(target, 'pointerdown', { clientX: 4, clientY: 4 });
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);
    // Hold far past the old fixed suppression window, then release.
    vi.advanceTimersByTime(1500);
    click(target);

    expect(harness.intents).toEqual([{ kind: 'flag', row: 1, col: 1 }]);
  });

  it('does not swallow an unrelated tap after a touch contextmenu', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = mount(makeView());
    const pressed = cell(harness.container, 1, 1);
    const other = cell(harness.container, 0, 0);

    pointer(pressed, 'pointerdown', { clientX: 4, clientY: 4 });
    pointer(pressed, 'contextmenu', { clientX: 4, clientY: 4 });
    pointer(pressed, 'pointerup', { clientX: 4, clientY: 4 });
    pointer(other, 'pointerdown', { clientX: 4, clientY: 4 });
    pointer(other, 'pointerup', { clientX: 4, clientY: 4 });
    click(other);

    // The hold itself flagged the pressed cell; the later tap on another cell
    // still reveals instead of being swallowed as the release click.
    expect(harness.intents).toEqual([
      { kind: 'flag', row: 1, col: 1 },
      { kind: 'reveal', row: 0, col: 0 },
    ]);
  });

  it('clears a leftover release-click token when the next gesture starts', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = mount(makeView());
    const target = cell(harness.container, 1, 1);

    pointer(target, 'pointerdown', { clientX: 4, clientY: 4 });
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);
    // Some browsers skip the release click after the native contextmenu, so
    // this hold's suppression token is left behind. It must not swallow the
    // next tap on the same cell.
    expect(harness.intents).toEqual([{ kind: 'flag', row: 1, col: 1 }]);

    pointer(target, 'pointerdown', { clientX: 4, clientY: 4 });
    click(target);

    expect(harness.intents).toEqual([
      { kind: 'flag', row: 1, col: 1 },
      { kind: 'reveal', row: 1, col: 1 },
    ]);
  });

  it('cancels a long press when the finger moves beyond the tolerance', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = mount(makeView());
    const target = cell(harness.container, 2, 2);

    pointer(target, 'pointerdown', { clientX: 4, clientY: 4 });
    pointer(target, 'pointermove', {
      clientX: 4 + LONG_PRESS_MOVE_TOLERANCE_PX + 1,
      clientY: 4,
    });
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);

    expect(harness.intents).toEqual([]);
  });

  it('does not flag on a long press while flag mode already handles taps', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = mount(makeView());
    click(flagToggle(harness.container));
    const target = cell(harness.container, 0, 0);

    pointer(target, 'pointerdown', { clientX: 4, clientY: 4 });
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);
    expect(harness.intents).toEqual([]);

    click(target);
    expect(harness.intents).toEqual([{ kind: 'flag', row: 0, col: 0 }]);
  });
});

describe('online board end-only final snapshot', () => {
  it('paints mine positions only after the match is finished', () => {
    // The last redacted snapshot can still say `playing`: `end` is what
    // carries the final board, so the room phase decides when to paint it.
    const harness = mount(makeView());

    for (const button of cells(harness.container)) {
      expect(button.hasAttribute('data-mine')).toBe(false);
    }
    expect(harness.container.textContent).not.toContain('✹');

    const finalBoard = makeFinalBoard();
    harness.setContext(
      makeContext({ phase: 'finished', isMyTurn: false, finalBoard }),
    );

    const mine = cell(harness.container, 0, 0);
    expect(mine.dataset.mine).toBe('true');
    expect(mine.dataset.state).toBe('mine');
    expect(mine.textContent).toBe('✹');
    expect(mine.getAttribute('aria-label')).toContain('地雷');

    const flaggedMine = cell(harness.container, 0, 2);
    expect(flaggedMine.dataset.mine).toBe('true');
    expect(flaggedMine.textContent).toBe('⚑');
    expect(flaggedMine.getAttribute('aria-label')).toContain('地雷');

    const safeRevealed = cell(harness.container, 1, 1);
    expect(safeRevealed.hasAttribute('data-mine')).toBe(false);
    expect(safeRevealed.dataset.state).toBe('revealed');
    expect(safeRevealed.textContent).toBe('2');
    expect(safeRevealed.dataset.number).toBe('2');

    // A hidden safe cell still must not expose its (known) adjacency count.
    const safeHidden = cell(harness.container, 2, 2);
    expect(safeHidden.dataset.state).toBe('hidden');
    expect(safeHidden.hasAttribute('data-number')).toBe(false);
    expect(safeHidden.textContent).toBe('');

    // The result board is read-only; a click after `end` never becomes an intent.
    for (const button of cells(harness.container)) {
      expect(isBlocked(button)).toBe(true);
    }
    click(mine);
    expect(harness.intents).toEqual([]);
  });

  it('paints the end board when the last snapshot already reports a loss', () => {
    const harness = mount(
      makeView({ status: 'lost', revealedSafeCount: 1 }),
      makeContext({ phase: 'finished', isMyTurn: false, finalBoard: makeFinalBoard() }),
    );

    expect(cell(harness.container, 0, 0).dataset.mine).toBe('true');
    expect(cell(harness.container, 0, 2).textContent).toBe('⚑');
    expect(cell(harness.container, 1, 1).textContent).toBe('2');
    for (const button of cells(harness.container)) {
      expect(isBlocked(button)).toBe(true);
    }
  });

  it('ignores a final board that arrives while the snapshot is still playing', () => {
    const harness = mount(makeView(), makeContext({ finalBoard: makeFinalBoard() }));

    for (const button of cells(harness.container)) {
      expect(button.hasAttribute('data-mine')).toBe(false);
      expect(button.disabled).toBe(false);
    }
    expect(harness.container.textContent).not.toContain('✹');
  });
});

describe('online board lifecycle', () => {
  it('updates the same cells in place across snapshots', () => {
    const harness = mount(makeView());
    const target = cell(harness.container, 1, 2);
    target.focus();
    expect(document.activeElement).toBe(target);

    const revealed = makeView({
      cells: makeCells({ '0,0': { revealed: true, adjacentMines: 0 } }),
    });
    const intents: BoardActionIntent[] = [];
    harness.renderer.render(harness.container, revealed, (intent) => intents.push(intent));

    expect(cell(harness.container, 1, 2)).toBe(target);
    expect(cell(harness.container, 0, 0).dataset.state).toBe('revealed');
    expect(document.activeElement).toBe(target);
    expect(intents).toEqual([]);

    // A snapshot that disables the focused cell no longer drops focus: the
    // cell stays focusable via aria-disabled and the roving tab stop follows it.
    harness.renderer.render(
      harness.container,
      makeView({ cells: makeCells({ '1,2': { revealed: true } }) }),
      (intent) => intents.push(intent),
    );
    expect(isBlocked(target)).toBe(true);
    expect(document.activeElement).toBe(target);
  });

  it('rebuilds the grid for a new row/col count and drops the pending hold', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = mount(makeView());
    pointer(cell(harness.container, 1, 1), 'pointerdown', { clientX: 4, clientY: 4 });

    const smaller = makeView({
      rows: 2,
      cols: 2,
      cells: makeCells().slice(0, 2).map((row) => row.slice(0, 2)),
    });
    const intents: BoardActionIntent[] = [];
    harness.renderer.render(harness.container, smaller, (intent) => intents.push(intent));
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);

    expect(harness.container.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(cells(harness.container)).toHaveLength(4);
    expect(intents).toEqual([]);
  });

  it('destroy detaches listeners and timers and removes the rendered board', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = mount(makeView());
    const target = cell(harness.container, 0, 0);
    pointer(target, 'pointerdown', { clientX: 1, clientY: 1 });

    harness.renderer.destroy();
    harness.renderer.destroy();
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);
    click(target);

    expect(harness.container.children).toHaveLength(0);
    expect(harness.intents).toEqual([]);
  });

  it('exposes the default derivation for a standalone renderer', () => {
    const board = makeView();
    const context = deriveBoardContext(board);
    expect(context.phase).toBe('playing');
    expect(context.isMyTurn).toBe(true);
    expect(context.finalBoard).toBeNull();
    expect(context.actionGate(0, 0, 'reveal')).toEqual({
      allowed: true,
      reason: null,
      message: null,
    } satisfies BoardActionGate);
  });
});
