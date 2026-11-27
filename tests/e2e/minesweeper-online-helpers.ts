/**
 * Playwright helpers for the online Minesweeper two-context e2e suite (#538).
 *
 * The module is split into two halves:
 *
 * - pure code — wire-frame classification, redacted-board snapshots, action
 *   frames and the stored-seat parser — that unit tests drive without a
 *   browser; and
 * - page-driving code that only touches the `Page` it receives, so one helper
 *   can serve both seats of a match.
 *
 * Playwright is imported with `import type` only: loading this module in
 * Vitest must not pull in the Playwright runtime. No helper sleeps a fixed
 * duration; every wait is tied to a protocol frame or a DOM state the real
 * room service publishes.
 */

import type { Page, WebSocket } from '@playwright/test';

import { onlineRoomHref } from '../../src/games/minesweeper/online/client/contracts';
import {
  validateClientMessage,
  validateServerMessage,
} from '../../src/games/minesweeper/online/protocol';
import type {
  ActionKind,
  ActionMessage,
  ActionResultMessage,
  ClientToServerMessage,
  MessageByType,
  RedactedBoard,
  RoomStateMessage,
  ServerMessageType,
  ServerToClientMessage,
  SnapshotMessage,
} from '../../src/games/minesweeper/online/types';

/** Bounded wait for one frame or DOM transition; never used as a sleep. */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

/**
 * Prefix of the per-room `sessionStorage` entry that keeps a resumable seat.
 *
 * It mirrors `ONLINE_SEAT_STORAGE_PREFIX` in
 * `src/games/minesweeper/online/client/online-room.ts`. The e2e helper cannot
 * import that module because it pulls browser CSS into Playwright's test
 * transform; `tests/unit/minesweeper-online-helpers.test.ts` locks the two
 * values together instead.
 */
export const ONLINE_SEAT_STORAGE_KEY_PREFIX = 'minesweeper.online.seat:';

/** `sessionStorage` key that keeps the resumable seat for `roomId`. */
export function onlineSeatStorageKey(roomId: string): string {
  return `${ONLINE_SEAT_STORAGE_KEY_PREFIX}${roomId}`;
}

// ---------------------------------------------------------------------------
// Wire-frame classification
// ---------------------------------------------------------------------------

/** A raw WebSocket payload as Playwright reports it. */
export type WireFrameData = string | Buffer;

/** Outcome of classifying one raw frame. */
export type WireFrameClassification =
  | { readonly kind: 'server-message'; readonly message: ServerToClientMessage }
  | { readonly kind: 'client-message'; readonly message: ClientToServerMessage }
  | { readonly kind: 'invalid'; readonly reason: string };

function frameText(frame: WireFrameData): string {
  return typeof frame === 'string' ? frame : frame.toString('utf8');
}

/**
 * Classify one raw frame against the pinned online protocol.
 *
 * Recognition is intentionally direction-aware: the client and the server
 * share seven message types, and the frame alone does not say which side sent
 * it. A valid server message wins, then a valid client message; everything
 * else (bad JSON, unknown types, missing fields) is `invalid` with the
 * protocol validator's reason so a failing test can print it.
 */
export function classifyWireFrame(frame: WireFrameData): WireFrameClassification {
  const text = frameText(frame);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: 'frame is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'invalid', reason: 'frame must be a JSON object' };
  }
  const type = (parsed as { readonly type?: unknown }).type;
  if (typeof type !== 'string') {
    return { kind: 'invalid', reason: 'frame has no string "type"' };
  }

  const server = validateServerMessage(parsed);
  if (server.ok) {
    return { kind: 'server-message', message: server.value };
  }
  const client = validateClientMessage(parsed);
  if (client.ok) {
    return { kind: 'client-message', message: client.value };
  }
  return { kind: 'invalid', reason: server.message };
}

/** Parse only a server frame; anything else (including client frames) is null. */
export function parseServerFrame(frame: WireFrameData): ServerToClientMessage | null {
  const classified = classifyWireFrame(frame);
  return classified.kind === 'server-message' ? classified.message : null;
}

/** The sequence carried by a server message; `error` is the only one without. */
export function serverMessageSeq(message: ServerToClientMessage): number | null {
  return message.type === 'error' ? null : message.seq;
}

function describeFrame(message: ServerToClientMessage): string {
  const seq = serverMessageSeq(message);
  return seq === null ? message.type : `${message.type}@${seq}`;
}

// ---------------------------------------------------------------------------
// Server-frame recorder
// ---------------------------------------------------------------------------

/** Options for one bounded frame wait. */
export interface WaitForServerMessageOptions {
  /** Override the bounded wait; defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /**
   * Ignore frames already recorded when the wait starts: only messages at or
   * after this index may match. Use it when a wait must observe a frame the
   * next action produces (a new round or a reconnect) instead of matching an
   * older frame that already satisfies the predicate.
   */
  readonly afterMessageCount?: number;
}

/** Options for waiting on the verdict of one submitted action. */
export interface WaitForActionResultOptions extends WaitForServerMessageOptions {
  /** Wait for an accepted (`true`) or rejected (`false`) verdict only. */
  readonly accepted?: boolean;
}

/**
 * Records every server frame of one page and resolves waits against the
 * recorded stream.
 *
 * Create the recorder before navigating: the first `room_state` (the one that
 * carries the seat token) can arrive before a later `openOnlineRoom` call
 * returns. Waits check already-recorded frames first, so a message that
 * arrived early is never missed, and several waits may observe the same
 * stream independently.
 */
export interface ServerFrameRecorder {
  /** Parsed server frames in arrival order. */
  readonly messages: readonly ServerToClientMessage[];
  /** Raw frames that failed protocol validation, in arrival order. */
  readonly invalidFrames: readonly string[];
  /** Wait for the first server message accepted by `predicate`. */
  waitForServerMessage(
    predicate: (message: ServerToClientMessage) => boolean,
    options?: WaitForServerMessageOptions,
  ): Promise<ServerToClientMessage>;
  /** Wait for the first server message of `type`. */
  waitForMessageOfType<T extends ServerMessageType>(
    type: T,
    options?: WaitForServerMessageOptions,
  ): Promise<MessageByType[T]>;
  /** Wait for the `action_result` of one `actionId`, optionally by verdict. */
  waitForActionResult(
    actionId: string,
    options?: WaitForActionResultOptions,
  ): Promise<ActionResultMessage>;
  /** Wait for the first server message carrying `seq`. */
  waitForSeq(seq: number, options?: WaitForServerMessageOptions): Promise<ServerToClientMessage>;
  /**
   * Feed one server frame observed outside `page.on('websocket')`.
   *
   * A spec that routes the socket with `page.routeWebSocket` can forward the
   * server-side frames here (`connectToServer().onMessage(...)`) while still
   * using the same waits; client frames are ignored.
   */
  recordServerFrame(payload: WireFrameData): void;
  /** Forget every recorded frame; pending waits keep waiting. */
  clear(): void;
  /** Detach from the page and reject every pending wait. */
  dispose(): void;
}

interface FrameWaiter {
  readonly predicate: (message: ServerToClientMessage) => boolean;
  readonly resolve: (message: ServerToClientMessage) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

function waitForMessage<T extends ServerToClientMessage>(
  predicate: (message: ServerToClientMessage) => message is T,
  description: string,
  messages: readonly ServerToClientMessage[],
  waiters: Set<FrameWaiter>,
  disposed: () => boolean,
  defaultTimeoutMs: number,
  options?: WaitForServerMessageOptions,
): Promise<T>;
function waitForMessage(
  predicate: (message: ServerToClientMessage) => boolean,
  description: string,
  messages: readonly ServerToClientMessage[],
  waiters: Set<FrameWaiter>,
  disposed: () => boolean,
  defaultTimeoutMs: number,
  options?: WaitForServerMessageOptions,
): Promise<ServerToClientMessage>;
function waitForMessage(
  predicate: (message: ServerToClientMessage) => boolean,
  description: string,
  messages: readonly ServerToClientMessage[],
  waiters: Set<FrameWaiter>,
  disposed: () => boolean,
  defaultTimeoutMs: number,
  options: WaitForServerMessageOptions = {},
): Promise<ServerToClientMessage> {
  const firstIndex = Math.max(0, options.afterMessageCount ?? 0);
  const existing = messages.slice(firstIndex).find((message) => predicate(message));
  if (existing !== undefined) {
    return Promise.resolve(existing);
  }
  if (disposed()) {
    return Promise.reject(new Error('the server frame recorder is already disposed'));
  }

  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  return new Promise<ServerToClientMessage>((resolve, reject) => {
    const waiter: FrameWaiter = { predicate, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(
        new Error(
          `timed out after ${timeoutMs}ms waiting for ${description}; ` +
            `received [${messages.map(describeFrame).join(', ')}]`,
        ),
      );
    }, timeoutMs);
    waiters.add(waiter);
  });
}

/** Start recording the server frames of `page`. */
export function createServerFrameRecorder(
  page: Page,
  options: { readonly timeoutMs?: number } = {},
): ServerFrameRecorder {
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const messages: ServerToClientMessage[] = [];
  const invalidFrames: string[] = [];
  const waiters = new Set<FrameWaiter>();
  let disposed = false;

  function settle(message: ServerToClientMessage): void {
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) {
        continue;
      }
      waiters.delete(waiter);
      if (waiter.timer !== null) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve(message);
    }
  }

  function record(payload: WireFrameData): void {
    if (disposed) {
      return;
    }
    const classified = classifyWireFrame(payload);
    if (classified.kind === 'server-message') {
      messages.push(classified.message);
      settle(classified.message);
      return;
    }
    if (classified.kind === 'invalid') {
      invalidFrames.push(frameText(payload));
    }
  }

  const onWebSocket = (socket: WebSocket): void => {
    socket.on('framereceived', ({ payload }) => {
      record(payload);
    });
  };
  page.on('websocket', onWebSocket);

  function clear(): void {
    messages.length = 0;
    invalidFrames.length = 0;
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    page.off('websocket', onWebSocket);
    for (const waiter of waiters) {
      if (waiter.timer !== null) {
        clearTimeout(waiter.timer);
      }
      waiter.reject(new Error('the server frame recorder was disposed while waiting'));
    }
    waiters.clear();
  }

  return {
    get messages() {
      return messages;
    },
    get invalidFrames() {
      return invalidFrames;
    },
    waitForServerMessage(predicate, waitOptions) {
      return waitForMessage(
        predicate,
        'a server message',
        messages,
        waiters,
        () => disposed,
        defaultTimeoutMs,
        waitOptions,
      );
    },
    waitForMessageOfType<T extends ServerMessageType>(
      type: T,
      waitOptions?: WaitForServerMessageOptions,
    ): Promise<MessageByType[T]> {
      return waitForMessage(
        (message): message is MessageByType[T] => message.type === type,
        `a "${type}" message`,
        messages,
        waiters,
        () => disposed,
        defaultTimeoutMs,
        waitOptions,
      );
    },
    waitForActionResult(actionId, waitOptions = {}) {
      const { accepted } = waitOptions;
      const description =
        accepted === undefined
          ? `action_result for ${actionId}`
          : `action_result for ${actionId} with accepted=${String(accepted)}`;
      return waitForMessage(
        (message): message is ActionResultMessage =>
          message.type === 'action_result' &&
          message.actionId === actionId &&
          (accepted === undefined || message.accepted === accepted),
        description,
        messages,
        waiters,
        () => disposed,
        defaultTimeoutMs,
        waitOptions,
      );
    },
    waitForSeq(seq, waitOptions) {
      return waitForMessage(
        (message) => serverMessageSeq(message) === seq,
        `seq ${seq}`,
        messages,
        waiters,
        () => disposed,
        defaultTimeoutMs,
        waitOptions,
      );
    },
    recordServerFrame(payload) {
      record(payload);
    },
    clear,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Series frames and page text
// ---------------------------------------------------------------------------

/**
 * The wire `room_state.series` value.
 *
 * `SeriesState` is private to the protocol module, so the helper derives it
 * from the exported `room_state` DTO exactly like `server/room/series.ts`
 * does. `room_state.series` is optional until the first round starts, which is
 * why every accessor below has a `null` case.
 */
export type SeriesFrameState = NonNullable<RoomStateMessage['series']>;

/** One completed round carried in {@link SeriesFrameState.history}. */
export type SeriesFrameRound = SeriesFrameState['history'][number];

/** The two seats of a series; `wins` is keyed by these player ids. */
export interface SeriesSeats {
  readonly hostId: string;
  readonly opponentId: string;
}

/** Host-first, comparable view of one `room_state.series` frame. */
export interface SeriesFrameView {
  readonly series: SeriesFrameState;
  /** Current (or just finished) round, 1-based. */
  readonly round: number;
  readonly hostWins: number;
  readonly opponentWins: number;
  /** Host-first score, e.g. `1 : 0`. */
  readonly score: string;
  readonly firstMoverId: string;
  readonly decided: boolean;
  readonly winnerId: string | null;
  readonly history: readonly SeriesFrameRound[];
}

/** Latest `room_state` in arrival order, or `null` before the first one. */
export function latestRoomState(
  messages: readonly ServerToClientMessage[],
): RoomStateMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'room_state') {
      return message;
    }
  }
  return null;
}

/** Sequence of the latest `room_state`, or `null` when none has arrived. */
export function latestRoomStateSeq(
  messages: readonly ServerToClientMessage[],
): number | null {
  return latestRoomState(messages)?.seq ?? null;
}

/**
 * True when the latest `room_state` has reached `baselineSeq` or a newer
 * sequence. A reconnecting seat uses this to prove it caught up with the state
 * it saw before the connection dropped.
 */
export function roomStateReachedSeq(
  messages: readonly ServerToClientMessage[],
  baselineSeq: number,
): boolean {
  const seq = latestRoomStateSeq(messages);
  return seq !== null && seq >= baselineSeq;
}

/** Latest `room_state.series`, or `null` when no room state carried one. */
export function latestRoomStateSeries(
  messages: readonly ServerToClientMessage[],
): SeriesFrameState | null {
  return latestRoomState(messages)?.series ?? null;
}

/** Wins recorded for `playerId`; a seat missing from the table has zero. */
export function seriesWins(series: SeriesFrameState, playerId: string): number {
  return series.wins[playerId] ?? 0;
}

/** Build the host-first view of one series frame. */
export function seriesView(series: SeriesFrameState, seats: SeriesSeats): SeriesFrameView {
  const hostWins = seriesWins(series, seats.hostId);
  const opponentWins = seriesWins(series, seats.opponentId);
  return {
    series,
    round: series.round,
    hostWins,
    opponentWins,
    score: `${hostWins} : ${opponentWins}`,
    firstMoverId: series.firstMoverId,
    decided: series.decided,
    winnerId: series.winnerId,
    history: series.history,
  };
}

/** Latest series frame as a host-first view, or `null` when absent. */
export function latestSeriesView(
  messages: readonly ServerToClientMessage[],
  seats: SeriesSeats,
): SeriesFrameView | null {
  const series = latestRoomStateSeries(messages);
  return series === null ? null : seriesView(series, seats);
}

/**
 * First mover the alternation rule requires for `round` (1-based).
 *
 * The host opens round 1 and every odd round; the other seat opens every even
 * round. `server/room/series.ts` owns the authoritative implementation; this
 * mirrors its published rule so an e2e assertion can name the expected id.
 */
export function expectedFirstMoverId(round: number, seats: SeriesSeats): string {
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new RangeError(`series round must be a positive integer, got ${String(round)}`);
  }
  return round % 2 === 1 ? seats.hostId : seats.opponentId;
}

/** Parsed `series-score` text, e.g. `你 1 : 0 对手`. */
export interface SeriesScoreText {
  readonly leftWins: number;
  readonly rightWins: number;
}

/**
 * Parse the two win counts from the rendered `series-score` text.
 *
 * The series block may label the counts relative to the viewer (`你 1 : 0
 * 对手`) or render bare numbers (`1 : 1`); only the digits and the colon
 * matter here. A full-width colon is accepted too. Returns `null` when the
 * text carries no score instead of inventing `0 : 0`.
 */
export function parseSeriesScoreText(text: string): SeriesScoreText | null {
  const match = /(\d+)\s*[:：]\s*(\d+)/.exec(text);
  if (match === null) {
    return null;
  }
  const left = match[1];
  const right = match[2];
  if (left === undefined || right === undefined) {
    return null;
  }
  const leftWins = Number(left);
  const rightWins = Number(right);
  if (!Number.isSafeInteger(leftWins) || !Number.isSafeInteger(rightWins)) {
    return null;
  }
  return { leftWins, rightWins };
}

/** Parsed `series-round` text, e.g. `第 2 局 / 三局两胜`. */
export interface SeriesRoundText {
  /** Current round, 1-based. */
  readonly round: number;
  /** `3` when the text names the best-of-three format, otherwise `null`. */
  readonly bestOf: number | null;
}

/** Parse the current round (and the best-of count when named) from the DOM. */
export function parseSeriesRoundText(text: string): SeriesRoundText | null {
  const match = /第\s*(\d+)\s*局/.exec(text);
  if (match === null) {
    return null;
  }
  const rawRound = match[1];
  if (rawRound === undefined) {
    return null;
  }
  const round = Number(rawRound);
  if (!Number.isSafeInteger(round) || round < 1) {
    return null;
  }
  return { round, bestOf: text.includes('三局两胜') ? 3 : null };
}

/** True when `series-status` announces the series verdict. */
export function isSeriesDecidedText(text: string): boolean {
  return text.includes('系列赛结束');
}

/** Rematch button label categories the series UI exposes. */
export type RematchTextKind = 'next-round' | 'new-series' | 'pending' | 'unknown';

/**
 * Classify the rematch button text.
 *
 * The pending label wins first because it can contain other words
 * (`已申请重新开始，等待对手`); the decided label (`再来一轮系列赛`) is
 * checked before the undecided one (`下一局`), and the pre-series
 * `再来一局` stays accepted so an older baseline still classifies.
 */
export function classifyRematchText(text: string): RematchTextKind {
  const normalized = text.trim();
  if (normalized === '') {
    return 'unknown';
  }
  if (normalized.includes('已申请')) {
    return 'pending';
  }
  if (normalized.includes('再来一轮')) {
    return 'new-series';
  }
  if (normalized.includes('下一局') || normalized.includes('再来一局')) {
    return 'next-round';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Redacted-board snapshots
// ---------------------------------------------------------------------------

/** One comparable redacted cell. Hidden cells never expose a mine count. */
export interface BoardCellView {
  readonly row: number;
  readonly col: number;
  readonly revealed: boolean;
  readonly flagged: boolean;
  readonly adjacentMines: number;
}

/** Row-major redacted board, indexed by row and then by column. */
export type BoardSnapshot = readonly (readonly BoardCellView[])[];

/** One cell that differs between two board snapshots. */
export interface BoardCellDifference {
  readonly row: number;
  readonly col: number;
  /** Compact token of the left board: `#` hidden, `F` flagged, `0`..`8`. */
  readonly left: string;
  /** Compact token of the right board. */
  readonly right: string;
}

/** Flatten a wire redacted board into comparable cells. */
export function redactedBoardCells(board: RedactedBoard): BoardCellView[] {
  const cells: BoardCellView[] = [];
  for (const row of board) {
    for (const cell of row) {
      cells.push({
        row: cell.row,
        col: cell.col,
        revealed: cell.revealed,
        flagged: cell.flagged,
        adjacentMines: cell.revealed ? cell.adjacentMines : 0,
      });
    }
  }
  return cells;
}

/**
 * Build a rectangular snapshot from unordered cells.
 *
 * The board must be a contiguous matrix starting at `(0, 0)`: a duplicate, a
 * missing row/column or a ragged row is a protocol/rendering bug and throws
 * instead of silently comparing unequal shapes.
 */
export function boardSnapshotFromCells(cells: readonly BoardCellView[]): BoardSnapshot {
  if (cells.length === 0) {
    throw new Error('a board snapshot needs at least one cell');
  }

  const byRow = new Map<number, Map<number, BoardCellView>>();
  for (const cell of cells) {
    if (
      !Number.isSafeInteger(cell.row) ||
      !Number.isSafeInteger(cell.col) ||
      cell.row < 0 ||
      cell.col < 0
    ) {
      throw new Error(
        `board cell has invalid coordinates (${String(cell.row)}, ${String(cell.col)})`,
      );
    }
    let row = byRow.get(cell.row);
    if (row === undefined) {
      row = new Map<number, BoardCellView>();
      byRow.set(cell.row, row);
    }
    if (row.has(cell.col)) {
      throw new Error(`board cell (${cell.row}, ${cell.col}) appears twice`);
    }
    row.set(cell.col, cell);
  }

  const rowIndexes = [...byRow.keys()].sort((left, right) => left - right);
  const board: BoardCellView[][] = [];
  let expectedCols = -1;

  for (let rowIndex = 0; rowIndex < rowIndexes.length; rowIndex += 1) {
    const actualRow = rowIndexes[rowIndex];
    if (actualRow !== rowIndex) {
      throw new Error(`board row ${rowIndex} is missing`);
    }
    const row = byRow.get(rowIndex);
    if (row === undefined) {
      throw new Error(`board row ${rowIndex} is missing`);
    }
    const colIndexes = [...row.keys()].sort((left, right) => left - right);
    if (expectedCols === -1) {
      expectedCols = colIndexes.length;
    }
    if (colIndexes.length !== expectedCols) {
      throw new Error(
        `board row ${rowIndex} has ${colIndexes.length} cells; expected ${expectedCols}`,
      );
    }

    const rowCells: BoardCellView[] = [];
    for (let colIndex = 0; colIndex < colIndexes.length; colIndex += 1) {
      const actualCol = colIndexes[colIndex];
      if (actualCol !== colIndex) {
        throw new Error(`board cell (${rowIndex}, ${colIndex}) is missing`);
      }
      const cell = row.get(colIndex);
      if (cell === undefined) {
        throw new Error(`board cell (${rowIndex}, ${colIndex}) is missing`);
      }
      rowCells.push({
        row: rowIndex,
        col: colIndex,
        revealed: cell.revealed,
        flagged: cell.flagged,
        adjacentMines: cell.revealed ? cell.adjacentMines : 0,
      });
    }
    board.push(rowCells);
  }

  return board;
}

/** Build a snapshot from a wire redacted board. */
export function boardSnapshotFromRedactedBoard(board: RedactedBoard): BoardSnapshot {
  return boardSnapshotFromCells(redactedBoardCells(board));
}

/** Build a snapshot from a `snapshot` message. */
export function boardSnapshotFromSnapshot(message: SnapshotMessage): BoardSnapshot {
  return boardSnapshotFromRedactedBoard(message.board);
}

/** Compact token for one cell: `#` hidden, `F` flagged, otherwise `0`..`8`. */
export function formatBoardCell(cell: BoardCellView): string {
  if (cell.flagged) {
    return 'F';
  }
  if (!cell.revealed) {
    return '#';
  }
  return String(cell.adjacentMines);
}

/** Compact, row-major rendering used in assertions and failure messages. */
export function formatBoardSnapshot(board: BoardSnapshot): string {
  return board.map((row) => row.map(formatBoardCell).join(',')).join('/');
}

/**
 * Compare two snapshots cell by cell.
 *
 * Sizes must match; a shape mismatch throws because two clients of one room
 * can never legitimately see different board dimensions.
 */
export function diffBoardSnapshots(
  left: BoardSnapshot,
  right: BoardSnapshot,
): BoardCellDifference[] {
  if (left.length !== right.length) {
    throw new Error(`board row counts differ: ${left.length} !== ${right.length}`);
  }

  const differences: BoardCellDifference[] = [];
  for (let row = 0; row < left.length; row += 1) {
    const leftRow = left[row];
    const rightRow = right[row];
    if (leftRow === undefined || rightRow === undefined) {
      throw new Error(`board row ${row} is missing`);
    }
    if (leftRow.length !== rightRow.length) {
      throw new Error(
        `board row ${row} column counts differ: ${leftRow.length} !== ${rightRow.length}`,
      );
    }
    for (let col = 0; col < leftRow.length; col += 1) {
      const leftCell = leftRow[col];
      const rightCell = rightRow[col];
      if (leftCell === undefined || rightCell === undefined) {
        throw new Error(`board cell (${row}, ${col}) is missing`);
      }
      if (
        leftCell.revealed === rightCell.revealed &&
        leftCell.flagged === rightCell.flagged &&
        leftCell.adjacentMines === rightCell.adjacentMines
      ) {
        continue;
      }
      differences.push({
        row,
        col,
        left: formatBoardCell(leftCell),
        right: formatBoardCell(rightCell),
      });
    }
  }
  return differences;
}

/** True when both snapshots show the same redacted board. */
export function boardSnapshotsEqual(left: BoardSnapshot, right: BoardSnapshot): boolean {
  return diffBoardSnapshots(left, right).length === 0;
}

/** Read the rendered board of one page as a comparable snapshot. */
export async function readBoardSnapshot(page: Page): Promise<BoardSnapshot> {
  const cells = await page.evaluate((): BoardCellView[] => {
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="online-cell-"]'),
    );
    return elements.map((element) => {
      const revealed = element.dataset.revealed === 'true';
      return {
        row: Number(element.dataset.row),
        col: Number(element.dataset.col),
        revealed,
        flagged: element.dataset.flagged === 'true',
        adjacentMines: revealed ? Number(element.dataset.number ?? '0') : 0,
      };
    });
  });
  return boardSnapshotFromCells(cells);
}

// ---------------------------------------------------------------------------
// Action frames
// ---------------------------------------------------------------------------

/** Fields needed to build one client `action` frame. */
export interface ActionFrameOptions {
  readonly roomId: string;
  readonly matchId: string;
  readonly actionId: string;
  readonly seq: number;
  readonly turnId: number;
  readonly kind: ActionKind;
  readonly row: number;
  readonly col: number;
  /** Defaults to `0`; a test may pin the wall clock it reports. */
  readonly clientTimeMs?: number;
}

/** Build a protocol-shaped `action` frame without touching page state. */
export function buildActionFrame(options: ActionFrameOptions): ActionMessage {
  return {
    type: 'action',
    roomId: options.roomId,
    matchId: options.matchId,
    actionId: options.actionId,
    seq: options.seq,
    turnId: options.turnId,
    kind: options.kind,
    row: options.row,
    col: options.col,
    clientTimeMs: options.clientTimeMs ?? 0,
  };
}

/** Fields that vary between actions derived from one `snapshot` message. */
export interface ActionFromSnapshotOptions {
  readonly actionId: string;
  readonly kind: ActionKind;
  readonly row: number;
  readonly col: number;
  /** Defaults to the snapshot's seq, the last sequence the client applied. */
  readonly seq?: number;
  /** Defaults to the snapshot's turn id. */
  readonly turnId?: number;
  readonly clientTimeMs?: number;
}

/** Build a fresh action from the state a `snapshot` message published. */
export function actionFrameFromSnapshot(
  snapshot: SnapshotMessage,
  options: ActionFromSnapshotOptions,
): ActionMessage {
  return buildActionFrame({
    roomId: snapshot.roomId,
    matchId: snapshot.matchId,
    actionId: options.actionId,
    seq: options.seq ?? snapshot.seq,
    turnId: options.turnId ?? snapshot.turnId,
    kind: options.kind,
    row: options.row,
    col: options.col,
    ...(options.clientTimeMs === undefined ? {} : { clientTimeMs: options.clientTimeMs }),
  });
}

/**
 * Copy an action exactly for a duplicate-`actionId` retry.
 *
 * The server recognises a retry by the action id and must return the cached
 * verdict without touching seq, the turn or the board, so the retry must not
 * change any field — not even seq/turnId after the original advanced them.
 */
export function duplicateActionFrame(action: ActionMessage): ActionMessage {
  return { ...action };
}

/** Coordinates for an action that the server must reject as out of bounds. */
export interface InvalidCoordinateActionFrameOptions {
  readonly row: number;
  readonly col: number;
  /**
   * Fresh id for the invalid attempt; defaults to `<actionId>-invalid` so the
   * duplicate-id gate cannot answer with the cached result first.
   */
  readonly actionId?: string;
}

/**
 * Derive an out-of-bounds action from an accepted one.
 *
 * The default fresh `actionId` matters: the server checks duplicate ids before
 * the sequence and coordinate gates, so reusing the original id would turn the
 * invalid-coordinate probe into an accepted retry.
 */
export function invalidCoordinateActionFrame(
  action: ActionMessage,
  options: InvalidCoordinateActionFrameOptions,
): ActionMessage {
  return {
    ...action,
    actionId: options.actionId ?? `${action.actionId}-invalid`,
    row: options.row,
    col: options.col,
  };
}

// ---------------------------------------------------------------------------
// Stored seat
// ---------------------------------------------------------------------------

/** The resumable seat entry the browser keeps in `sessionStorage`. */
export interface StoredSeatSession {
  readonly roomId: string;
  readonly playerToken: string | null;
  readonly displayName: string;
  readonly role: 'host' | 'guest';
}

/** Parse one stored seat entry; `null` for absent or malformed values. */
export function parseStoredSeatSession(
  raw: string | null,
  roomId: string,
): StoredSeatSession | null {
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  if (record['roomId'] !== roomId) {
    return null;
  }
  if (typeof record['displayName'] !== 'string') {
    return null;
  }
  if (record['role'] !== 'host' && record['role'] !== 'guest') {
    return null;
  }
  const token = record['playerToken'];
  if (token !== null && typeof token !== 'string') {
    return null;
  }
  return {
    roomId,
    playerToken: token,
    displayName: record['displayName'],
    role: record['role'],
  };
}

/** Read the stored seat entry for `roomId` from the page's `sessionStorage`. */
export async function readStoredSeatSession(
  page: Page,
  roomId: string,
): Promise<StoredSeatSession | null> {
  const raw = await page.evaluate(
    (storageKey) => window.sessionStorage.getItem(storageKey),
    onlineSeatStorageKey(roomId),
  );
  return parseStoredSeatSession(raw, roomId);
}

/** Read only the resumable seat token, or `null` when the page has none. */
export async function readSeatToken(page: Page, roomId: string): Promise<string | null> {
  return (await readStoredSeatSession(page, roomId))?.playerToken ?? null;
}

// ---------------------------------------------------------------------------
// Page driving
// ---------------------------------------------------------------------------

/** Options for opening the online room entry. */
export interface OpenOnlineRoomOptions {
  /** Room id from an invitation/deep link; omit for the create/join screen. */
  readonly roomId?: string | null;
}

/** Absolute path (relative to `baseURL`) of the online room entry. */
export function onlineRoomPath(roomId: string | null = null): string {
  return `/${onlineRoomHref(roomId)}`;
}

/**
 * Open `#/online/minesweeper` and wait for the create/join landing.
 *
 * A `roomId` opens the invitation deep link, prefilling the join form and
 * resuming that seat when `sessionStorage` still has its token.
 */
export async function openOnlineRoom(
  page: Page,
  options: OpenOnlineRoomOptions = {},
): Promise<void> {
  await page.goto(onlineRoomPath(options.roomId ?? null));
  await page.getByTestId('online-room').waitFor({ state: 'visible' });
  await page.getByTestId('nickname').waitFor({ state: 'visible' });
}

/** Fill the nickname field shown on the create/join landing. */
export async function fillNickname(page: Page, nickname: string): Promise<void> {
  await page.getByTestId('nickname').fill(nickname);
}

/** Phases the room shell publishes on `online-room[data-phase]`. */
export type OnlineRoomPhase = 'waiting' | 'ready' | 'playing' | 'finished' | 'dissolved';

/** Wait until the room shell reports `phase` (its `data-phase` attribute). */
export async function waitForRoomPhase(page: Page, phase: OnlineRoomPhase): Promise<void> {
  await page
    .locator(`[data-testid="online-room"][data-phase="${phase}"]`)
    .waitFor({ state: 'visible' });
}

/** Wait until the room shell reports one of `phases`, and return it. */
async function waitForAnyRoomPhase(
  page: Page,
  phases: readonly OnlineRoomPhase[],
  timeoutMs: number,
): Promise<OnlineRoomPhase> {
  const handle = await page.waitForFunction(
    (allowed: readonly string[]) => {
      const room = document.querySelector('[data-testid="online-room"]');
      const phase = room?.getAttribute('data-phase') ?? '';
      return allowed.includes(phase) ? phase : false;
    },
    [...phases],
    { timeout: timeoutMs },
  );
  return (await handle.jsonValue()) as OnlineRoomPhase;
}

/** Wait until the server-published room id is non-empty. */
export async function waitForRoomId(page: Page): Promise<string> {
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="room-id"]');
    return element !== null && (element.textContent ?? '').trim() !== '';
  });
  const roomId = (await page.getByTestId('room-id').textContent())?.trim() ?? '';
  if (roomId === '') {
    throw new Error('the room id stayed empty after the room_state arrived');
  }
  return roomId;
}

/** Options for one bounded DOM-text wait. */
export interface WaitForPageTextOptions {
  /** Override the bounded wait; defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

/**
 * Wait until one test-id's trimmed text satisfies `mode` and return that text.
 *
 * The predicate runs in the browser through `waitForFunction`, so the wait is
 * tied to the rendered DOM and never to a fixed sleep.
 */
async function waitForTestIdText(
  page: Page,
  testId: string,
  expected: string,
  mode: 'contains' | 'equals',
  options: WaitForPageTextOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  await page.waitForFunction(
    (target: { readonly testId: string; readonly expected: string; readonly mode: string }) => {
      const element = document.querySelector(`[data-testid="${target.testId}"]`);
      const text = (element?.textContent ?? '').trim();
      return target.mode === 'contains' ? text.includes(target.expected) : text === target.expected;
    },
    { testId, expected, mode },
    { timeout: timeoutMs },
  );
  return (await page.getByTestId(testId).textContent())?.trim() ?? '';
}

/** Series state read from the room's rendered DOM. */
export interface SeriesPageState {
  readonly scoreText: string;
  readonly score: SeriesScoreText | null;
  readonly roundText: string;
  readonly round: SeriesRoundText | null;
  readonly statusText: string;
  /** True when `series-status` contains `系列赛结束`. */
  readonly decided: boolean;
  readonly rematchText: string;
  readonly rematchKind: RematchTextKind;
}

/**
 * Read the series block, the series status and the rematch label together.
 *
 * Waits for `series-score` first: the three series elements are rendered as one
 * block, so once the score is visible the round and status text are settled
 * too. A missing status element reads as an empty string (undecided) instead
 * of throwing.
 */
export async function readSeriesPage(page: Page): Promise<SeriesPageState> {
  await page.getByTestId('series-score').waitFor({ state: 'visible' });
  const texts = await page.evaluate(() => {
    const read = (testId: string): string => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      return (element?.textContent ?? '').trim();
    };
    return {
      scoreText: read('series-score'),
      roundText: read('series-round'),
      statusText: read('series-status'),
      rematchText: read('rematch'),
    };
  });
  return {
    ...texts,
    score: parseSeriesScoreText(texts.scoreText),
    round: parseSeriesRoundText(texts.roundText),
    decided: isSeriesDecidedText(texts.statusText),
    rematchKind: classifyRematchText(texts.rematchText),
  };
}

/** Wait until `series-score` contains `expected`, e.g. `1 : 1`. */
export async function waitForSeriesScore(
  page: Page,
  expected: string,
  options: WaitForPageTextOptions = {},
): Promise<string> {
  return waitForTestIdText(page, 'series-score', expected, 'contains', options);
}

/** Wait until `series-round` contains `expected`, e.g. `第 2 局`. */
export async function waitForSeriesRound(
  page: Page,
  expected: string,
  options: WaitForPageTextOptions = {},
): Promise<string> {
  return waitForTestIdText(page, 'series-round', expected, 'contains', options);
}

/** Wait until `series-status` announces the series verdict. */
export async function waitForSeriesDecided(
  page: Page,
  options: WaitForPageTextOptions = {},
): Promise<string> {
  return waitForTestIdText(page, 'series-status', '系列赛结束', 'contains', options);
}

/** Wait until the rematch button text equals `expected` (trimmed). */
export async function waitForRematchText(
  page: Page,
  expected: string,
  options: WaitForPageTextOptions = {},
): Promise<string> {
  return waitForTestIdText(page, 'rematch', expected, 'equals', options);
}

/** Options for creating a room from the landing page. */
export interface CreateOnlineRoomOptions {
  readonly nickname: string;
  /** Difficulty preset id; the page default is used when omitted. */
  readonly difficulty?: string;
  /**
   * Custom board dimensions. Selecting these switches the difficulty select to
   * `custom`, reveals the custom fields and fills them before creating the
   * room; it takes precedence over `difficulty`.
   */
  readonly customBoard?: OnlineRoomCustomBoard;
}

/** Rows / columns / mines for a custom create-room board. */
export interface OnlineRoomCustomBoard {
  readonly rows: number;
  readonly cols: number;
  readonly mines: number;
}

/** Fill the nickname, create a room and return the server-assigned room id. */
export async function createOnlineRoom(
  page: Page,
  options: CreateOnlineRoomOptions,
): Promise<string> {
  await fillNickname(page, options.nickname);
  if (options.customBoard !== undefined) {
    const board = options.customBoard;
    await page.getByTestId('difficulty').selectOption('custom');
    await page.getByTestId('custom-fields').waitFor({ state: 'visible' });
    await page.getByTestId('custom-rows').fill(String(board.rows));
    await page.getByTestId('custom-cols').fill(String(board.cols));
    await page.getByTestId('custom-mines').fill(String(board.mines));
  } else if (options.difficulty !== undefined) {
    await page.getByTestId('difficulty').selectOption(options.difficulty);
  }
  await page.getByTestId('create-room').click();
  await page.getByTestId('waiting').waitFor({ state: 'visible' });
  return waitForRoomId(page);
}

/** Options for joining a room from the landing page. */
export interface JoinOnlineRoomOptions {
  readonly nickname: string;
  readonly roomId: string;
}

/** Fill the nickname and room id, join, and wait for the room screen. */
export async function joinOnlineRoom(
  page: Page,
  options: JoinOnlineRoomOptions,
): Promise<void> {
  await fillNickname(page, options.nickname);
  await page.getByTestId('join-room-id').fill(options.roomId);
  await page.getByTestId('join-room').click();
  await page.getByTestId('waiting').waitFor({ state: 'visible' });
  await page.waitForFunction(
    (roomId) =>
      document.querySelector('[data-testid="room-id"]')?.textContent?.trim() === roomId,
    options.roomId,
  );
}

/** Set this seat's ready flag from the waiting screen. */
export async function setOnlineReady(page: Page, ready = true): Promise<void> {
  const toggle = page.getByTestId('toggle-ready');
  await toggle.waitFor({ state: 'visible' });
  const pressed = (await toggle.getAttribute('aria-pressed')) === 'true';
  if (pressed === ready) {
    return;
  }
  await toggle.click();
  await page
    .locator(`[data-testid="toggle-ready"][aria-pressed="${String(ready)}"]`)
    .waitFor();
}

/** Click the host-only start control and wait for the playable board. */
export async function startOnlineMatch(page: Page): Promise<void> {
  await page.getByTestId('start-match').click();
  await waitForRoomPhase(page, 'playing');
  await page.getByTestId('online-cell-0-0').waitFor({ state: 'visible' });
}

/** Options for starting the round after a finished one. */
export interface StartNextRoundOptions {
  readonly recorder: ServerFrameRecorder;
  /** Match id of the just-finished round; the next round must differ. */
  readonly previousMatchId: string;
  /** Override the bounded wait; defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

/**
 * Click this seat's rematch control and wait for the next round to start.
 *
 * The room only leaves `finished` once both seats accept, so call this for both
 * seats concurrently (`Promise.all`), or after the other seat already voted.
 * The room then returns to `ready`; the host starts the next round exactly like
 * the first one, while a guest's start control stays disabled. The helper
 * clicks that start control on the host seat and resolves with the new match id
 * once this page sees the matching `room_state` and a playable board.
 */
export async function startNextRound(
  page: Page,
  options: StartNextRoundOptions,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const seen = options.recorder.messages.length;

  const rematch = page.getByTestId('rematch');
  await rematch.waitFor({ state: 'visible' });
  await rematch.click();

  const phase = await waitForAnyRoomPhase(page, ['ready', 'playing'], timeoutMs);
  if (phase === 'ready') {
    // A guest's start button is visible but permanently disabled; wait until
    // either the host can start or the host's start already reached `playing`.
    await page.waitForFunction(
      () => {
        const room = document.querySelector('[data-testid="online-room"]');
        if (room?.getAttribute('data-phase') === 'playing') {
          return true;
        }
        const start = document.querySelector('[data-testid="start-match"]');
        return start instanceof HTMLButtonElement && !start.disabled;
      },
      undefined,
      { timeout: timeoutMs },
    );
    const stillReady = await page
      .getByTestId('online-room')
      .evaluate((element) => element.getAttribute('data-phase') === 'ready');
    if (stillReady) {
      const start = page.getByTestId('start-match');
      if (await start.isEnabled()) {
        await start.click();
      }
    }
  }

  const nextRound = await options.recorder.waitForServerMessage(
    (message) =>
      message.type === 'room_state' &&
      message.state === 'playing' &&
      message.matchId !== null &&
      message.matchId !== options.previousMatchId,
    { timeoutMs, afterMessageCount: seen },
  );
  await waitForRoomPhase(page, 'playing');
  await page.getByTestId('online-cell-0-0').waitFor({ state: 'visible' });
  if (nextRound.type !== 'room_state' || nextRound.matchId === null) {
    throw new Error('startNextRound did not observe the next round room_state');
  }
  return nextRound.matchId;
}

/** Wait until the server snapshot makes it this seat's turn. */
export async function waitForMyTurn(page: Page): Promise<void> {
  await page.locator('[data-testid="online-board"][data-actions-enabled="true"]').waitFor();
}

/**
 * Wait until a cell shows the requested visual state, or until the match ends
 * and the board is unmounted (a reveal can be the terminal mine).
 */
async function waitForCellState(
  page: Page,
  row: number,
  col: number,
  attribute: 'revealed' | 'flagged',
): Promise<void> {
  await page.waitForFunction(
    (target: { readonly row: number; readonly col: number; readonly attribute: string }) => {
      const room = document.querySelector('[data-testid="online-room"]');
      if (room?.getAttribute('data-phase') !== 'playing') {
        return true;
      }
      const cell = document.querySelector(
        `[data-testid="online-cell-${target.row}-${target.col}"]`,
      );
      return cell instanceof HTMLElement && cell.dataset[target.attribute] === 'true';
    },
    { row, col, attribute },
  );
}

/** Reveal one cell by left-clicking its rendered button. */
export async function revealCell(page: Page, row: number, col: number): Promise<void> {
  const cell = page.getByTestId(`online-cell-${row}-${col}`);
  await cell.waitFor({ state: 'visible' });
  await cell.click();
  await waitForCellState(page, row, col, 'revealed');
}

/** Flag one cell through the board's right-click gesture. */
export async function flagCell(page: Page, row: number, col: number): Promise<void> {
  const cell = page.getByTestId(`online-cell-${row}-${col}`);
  await cell.waitFor({ state: 'visible' });
  await cell.click({ button: 'right' });
  await waitForCellState(page, row, col, 'flagged');
}

/** Wait for the result screen after a completed match. */
export async function waitForMatchEnd(page: Page): Promise<void> {
  await page.getByTestId('finished').waitFor({ state: 'visible' });
}

/** How {@link reconnectSeat} drops the live socket before resuming the seat. */
export type SeatReconnectMode = 'reload' | 'offline';

/** Options for dropping and resuming one seat's connection. */
export interface ReconnectSeatOptions {
  readonly recorder: ServerFrameRecorder;
  /**
   * `reload` (default) refreshes the page; `offline` leaves the room while the
   * browser network is offline and reopens the same URL afterwards.
   */
  readonly mode?: SeatReconnectMode;
  /**
   * Phase the reconnected page must reach; defaults to `playing`, the phase a
   * reconnect during a round has to resume.
   */
  readonly expectedPhase?: OnlineRoomPhase;
  /** Override the bounded wait; defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

/** Evidence collected while one seat reconnects. */
export interface ReconnectSeatResult {
  readonly mode: SeatReconnectMode;
  /** Latest `room_state.seq` observed before the connection dropped. */
  readonly beforeSeq: number;
  /** `room_state.seq` of the frame recorded after the drop. */
  readonly afterSeq: number;
  readonly phase: OnlineRoomPhase;
}

/**
 * Drop one seat's socket and wait until it resumed the same room.
 *
 * `reload` is the deterministic default: a refresh tears down the page's
 * WebSocket, and the deep link re-joins with the seat token kept in
 * `sessionStorage`. `offline` navigates to `about:blank` while the browser
 * network is offline, then restores the network and reopens the room URL;
 * Playwright's `context.setOffline` alone does not close an existing
 * WebSocket, so leaving the room is what actually drops it.
 *
 * Recovery is proven by a `room_state` recorded *after* the drop whose seq is at
 * least the seq observed before it, plus the room returning to
 * `expectedPhase`. The real room service is never mocked or restarted.
 */
export async function reconnectSeat(
  page: Page,
  options: ReconnectSeatOptions,
): Promise<ReconnectSeatResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const mode = options.mode ?? 'reload';
  const expectedPhase = options.expectedPhase ?? 'playing';
  const recorder = options.recorder;
  const beforeSeq = latestRoomStateSeq(recorder.messages);
  if (beforeSeq === null) {
    throw new Error('reconnectSeat needs a room_state before the connection is dropped');
  }
  const seen = recorder.messages.length;
  const roomUrl = page.url();

  if (mode === 'reload') {
    await page.reload();
  } else {
    const context = page.context();
    await context.setOffline(true);
    await page.goto('about:blank');
    await context.setOffline(false);
    await page.goto(roomUrl);
  }

  const recovered = await recorder.waitForServerMessage(
    (message) => message.type === 'room_state' && message.seq >= beforeSeq,
    { timeoutMs, afterMessageCount: seen },
  );
  await waitForRoomPhase(page, expectedPhase);
  if (recovered.type !== 'room_state') {
    throw new Error('reconnectSeat did not observe a room_state after reconnecting');
  }
  return { mode, beforeSeq, afterSeq: recovered.seq, phase: expectedPhase };
}
