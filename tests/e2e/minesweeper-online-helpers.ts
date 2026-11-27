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
  const existing = messages.find((message) => predicate(message));
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

/** Wait until the room shell reports `phase` (its `data-phase` attribute). */
export async function waitForRoomPhase(
  page: Page,
  phase: 'waiting' | 'ready' | 'playing' | 'finished' | 'dissolved',
): Promise<void> {
  await page
    .locator(`[data-testid="online-room"][data-phase="${phase}"]`)
    .waitFor({ state: 'visible' });
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

/** Options for creating a room from the landing page. */
export interface CreateOnlineRoomOptions {
  readonly nickname: string;
  /** Difficulty preset id; the page default is used when omitted. */
  readonly difficulty?: string;
}

/** Fill the nickname, create a room and return the server-assigned room id. */
export async function createOnlineRoom(
  page: Page,
  options: CreateOnlineRoomOptions,
): Promise<string> {
  await fillNickname(page, options.nickname);
  if (options.difficulty !== undefined) {
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
