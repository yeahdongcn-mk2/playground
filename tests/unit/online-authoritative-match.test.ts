/**
 * Issue #484 acceptance layer (t4): the authoritative match seen through the
 * real room service.
 *
 * Earlier online tests exercise one seam at a time: `online-match-core.test.ts`
 * drives the pure match state machine and `online-room-lifecycle.test.ts` checks
 * the room table in isolation. This file is the end-to-end acceptance layer the
 * Issue asks for: every match is created by `createRoomManager` and reaches
 * `start` through the real `create → join → ready → start` flow, with a fixed
 * seed and injected short turn/match timers. No test waits on a real clock, a
 * socket, a database or an account.
 *
 * The assertions pin the user-visible contract, not implementation details:
 *
 * - rejected actions leave the room record, the authoritative board and the
 *   replay log exactly as they were, and never move `seq`/`turnId`;
 * - a retried `actionId` replays the cached `action_result` and changes nothing;
 * - every `snapshot` before `end` hides the unrevealed mine layout (no `mine`
 *   field, zero adjacent count on hidden cells) and the seed; only `end`
 *   publishes the seed and the complete mine layout;
 * - a mine hit, revealing every safe cell and a forfeit each produce exactly
 *   one `end` and move the room to `finished`, matching
 *   `design:room-lifecycle`'s `playing` self-loop and `end → finished`;
 * - the recorded seed/config/actions replay twice through the adapter with
 *   identical per-step digests and outcomes.
 *
 * Test orchestration may read the server-only engine board and `getMatch()`
 * handle; the redaction assertions then prove that none of it reaches the wire.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type MatchCommandResult,
  type RoomCommandResult,
  type RoomCommandSuccess,
  type RoomConnection,
  type RoomRecord,
} from '../../server/room/contracts';
import {
  createRoomManager,
  type InMemoryRoomManager,
  type RoomManagerOptions,
  type RoomMatch,
} from '../../server/room/room-manager';
import {
  PROTOCOL_VERSION,
  ReplayMismatchError,
  hashSeed,
  replayMatch,
  validateServerMessage,
  type ActionMessage,
  type CreateMessage,
  type EndMessage,
  type JoinMessage,
  type ProtocolErrorCode,
  type ReadyMessage,
  type RoomStateMessage,
  type ServerToClientMessage,
  type SnapshotMessage,
  type StartMessage,
} from '../../src/games/minesweeper/online/index';
import type { MinesweeperCell, MinesweeperConfig } from '../../src/games/minesweeper/engine';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESIGN = readFileSync(join(ROOT, 'docs', 'minesweeper-online-design.md'), 'utf8');

const NOW = 1_700_000_000_000;
/** Fixed server seed, injected through `RoomManagerOptions.createSeed`. */
const SEED = 2_024;
const TURN_TIMEOUT_MS = 1_000;
const MATCH_TIMEOUT_MS = 60_000;

const CONFIG = {
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
} satisfies MinesweeperConfig;

// ---------------------------------------------------------------------------
// design:room-lifecycle
// ---------------------------------------------------------------------------

interface DesignTransition {
  readonly id: string;
  readonly from: string;
  readonly event: string;
  readonly to: string;
}

interface LifecycleDesign {
  readonly terminalStates: readonly string[];
  readonly transitions: readonly DesignTransition[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse the JSON fenced block immediately after a design marker. */
function readJsonBlock(marker: string): unknown {
  const pattern = new RegExp(
    '<!--\\s*' + escapeRegExp(marker) + '\\s*-->\\s*```json\\s*\\n([\\s\\S]*?)\\n```',
  );
  const match = pattern.exec(DESIGN);
  if (match === null) {
    throw new Error(`Missing ${marker} JSON block in docs/minesweeper-online-design.md.`);
  }
  const block = match[1];
  if (block === undefined || block.trim().length === 0) {
    throw new Error(`Empty ${marker} JSON block in docs/minesweeper-online-design.md.`);
  }
  return JSON.parse(block) as unknown;
}

const LIFECYCLE = readJsonBlock('design:room-lifecycle') as LifecycleDesign;

function transitionById(id: string): DesignTransition {
  const transition = LIFECYCLE.transitions.find((candidate) => candidate.id === id);
  if (transition === undefined) {
    throw new Error(`design:room-lifecycle is missing transition ${id}`);
  }
  return transition;
}

const ACTION_LOOP = transitionById('t-action');
const END_TRANSITION = transitionById('t-end');

// ---------------------------------------------------------------------------
// Injected clock and message builders
// ---------------------------------------------------------------------------

let now = NOW;
let connectionSeq = 0;

beforeEach(() => {
  now = NOW;
  connectionSeq = 0;
});

function connection(playerToken: string | null = null): RoomConnection {
  connectionSeq += 1;
  return { connectionId: `connection_${connectionSeq}`, playerToken };
}

function createMessage(overrides: Partial<CreateMessage> = {}): CreateMessage {
  return {
    type: 'create',
    requestId: 'req_create',
    protocolVersion: PROTOCOL_VERSION,
    config: CONFIG,
    displayName: 'Ada',
    ...overrides,
  };
}

function joinMessage(roomId: string, overrides: Partial<JoinMessage> = {}): JoinMessage {
  return {
    type: 'join',
    requestId: 'req_join',
    protocolVersion: PROTOCOL_VERSION,
    roomId,
    displayName: 'Grace',
    ...overrides,
  };
}

function readyMessage(roomId: string, ready: boolean): ReadyMessage {
  return { type: 'ready', roomId, requestId: 'req_ready', ready };
}

function startMessage(roomId: string): StartMessage {
  return { type: 'start', roomId, requestId: 'req_start' };
}

interface ActionOverrides {
  readonly actionId?: string;
  readonly seq?: number;
  readonly turnId?: number;
  readonly kind?: 'reveal' | 'flag';
  readonly row?: number;
  readonly col?: number;
  readonly matchId?: string;
}

/**
 * Build an action against the room's current `seq`/`turnId`, letting a test
 * override exactly the field it wants to make stale or invalid.
 */
function actionFor(
  manager: InMemoryRoomManager,
  roomId: string,
  overrides: ActionOverrides = {},
): ActionMessage {
  const room = manager.getRoom(roomId);
  if (room === undefined || room.matchId === null) {
    throw new Error(`room ${roomId} has no running match`);
  }
  return {
    type: 'action',
    roomId,
    matchId: matchOf(manager, roomId).matchId,
    actionId: `action_${room.seq + 1}`,
    seq: room.seq,
    turnId: matchOf(manager, roomId).state.turnId,
    kind: 'reveal',
    row: 0,
    col: 0,
    clientTimeMs: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Assert a successful command produced only valid server messages and that no
 * delivery contains another seat's bearer token.
 */
function expectOk(
  result: RoomCommandResult | MatchCommandResult,
  allTokens: readonly string[] = [],
): RoomCommandSuccess {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.code}: ${result.error.message}`);
  }
  const tokens = new Set([
    ...allTokens,
    ...result.deliveries.map((delivery) => delivery.playerToken),
  ]);
  for (const delivery of result.deliveries) {
    const validation = validateServerMessage(delivery.message);
    expect(validation.ok, JSON.stringify(validation)).toBe(true);

    const json = JSON.stringify(delivery.message);
    for (const token of tokens) {
      if (token !== delivery.playerToken) {
        expect(json).not.toContain(token);
      }
    }
    if (delivery.message.type === 'room_state') {
      expect(delivery.message.playerToken).toBe(delivery.playerToken);
    } else {
      expect(json).not.toContain('playerToken');
    }
  }
  return result;
}

/** Assert a match-layer rejection is a valid wire error carrying `code`. */
function expectMatchRejected(
  result: MatchCommandResult,
  code: ProtocolErrorCode,
): Extract<MatchCommandResult, { readonly ok: false }> {
  expect(result.ok, `expected match failure ${code}`).toBe(false);
  if (result.ok) {
    throw new Error(`expected match failure ${code}, but the command succeeded`);
  }
  expect(result.code).toBe(code);
  expect(validateServerMessage(result.error).ok, JSON.stringify(result.error)).toBe(true);
  expectNoSeed(result.error, 'error');
  return result;
}

/** Every message of one type in a successful command, in delivery order. */
function messagesOfType<T extends ServerToClientMessage['type']>(
  result: RoomCommandResult | MatchCommandResult,
  type: T,
): Extract<ServerToClientMessage, { readonly type: T }>[] {
  const success = expectOk(result);
  return success.deliveries.flatMap((delivery) =>
    delivery.message.type === type
      ? [delivery.message as Extract<ServerToClientMessage, { readonly type: T }>]
      : [],
  );
}

/** Messages of a successful command in delivery order. */
function deliveriesOf(success: RoomCommandSuccess): ServerToClientMessage[] {
  return success.deliveries.map((delivery) => delivery.message);
}

/** Assert a `snapshot` cannot leak a seed, an unrevealed mine or its count. */
function expectRedactedSnapshot(message: SnapshotMessage): void {
  expectNoSeed(message, 'snapshot');
  expect(message.seedHash).toBe(hashSeed(SEED));
  expect(message.seedHash).toMatch(/^[0-9a-f]{64}$/);

  const leaks: string[] = [];
  for (const row of message.board) {
    for (const cell of row) {
      const path = `(${cell.row},${cell.col})`;
      if (Object.hasOwn(cell, 'mine')) {
        leaks.push(`${path} exposes a mine flag`);
      }
      if (!cell.revealed && cell.adjacentMines !== 0) {
        leaks.push(`${path} exposes adjacentMines=${cell.adjacentMines} while hidden`);
      }
    }
  }
  expect(leaks).toEqual([]);
}

/**
 * Find the first object (in a message tree) that owns a `seed` property.
 *
 * A recursive search is stronger than a JSON substring check: `seedHash` is a
 * legitimate field, while an accidentally added `seed` anywhere is a leak.
 */
function findSeedProperty(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findSeedProperty(entry, `${path}[${index}]`);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (value === null || typeof value !== 'object') {
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'seed') {
      return `${path}.${key}`;
    }
    const found = findSeedProperty(entry, `${path}.${key}`);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** Assert a value (usually a whole message) carries no seed property. */
function expectNoSeed(value: unknown, path = 'message'): void {
  expect(findSeedProperty(value, path), `${path} leaks the match seed`).toBeNull();
}

/** One `end` broadcast is one message per seat; both copies must be identical. */
function expectOneEndPerSeat(
  result: RoomCommandResult | MatchCommandResult,
  playerTokens: readonly string[],
): EndMessage {
  const ends = messagesOfType(result, 'end');
  expect(ends).toHaveLength(playerTokens.length);
  const recipients = expectOk(result)
    .deliveries.filter((delivery) => delivery.message.type === 'end')
    .map((delivery) => delivery.playerToken);
  expect([...recipients].sort()).toEqual([...playerTokens].sort());
  const end = ends[0];
  if (end === undefined) {
    throw new Error('expected an end message');
  }
  for (const copy of ends) {
    expect(copy).toEqual(end);
  }
  return end;
}

/** Number of mine cells in an end-only board. */
function countMines(end: EndMessage): number {
  return end.finalSnapshot.flat().filter((cell) => cell.mine).length;
}

/** Assert the published end carries every mine and the committed seed. */
function expectEndRevealsMatch(end: EndMessage): void {
  expect(end.finalSnapshot).toHaveLength(CONFIG.rows);
  for (const row of end.finalSnapshot) {
    expect(row).toHaveLength(CONFIG.cols);
  }
  expect(countMines(end)).toBe(CONFIG.mines);
  expect(end.seed).toBe(SEED);
  expect(createHash('sha256').update(String(end.seed)).digest('hex')).toBe(hashSeed(SEED));
}

// ---------------------------------------------------------------------------
// Room helpers: always go through the real create → join → ready → start flow
// ---------------------------------------------------------------------------

/** Deep copy of a live record, so a later mutation cannot pass unnoticed. */
function cloneRoom(manager: InMemoryRoomManager, roomId: string): RoomRecord {
  const room = manager.getRoom(roomId);
  if (room === undefined) {
    throw new Error(`room ${roomId} is not in the table`);
  }
  return structuredClone(room);
}

function roomStateOf(result: RoomCommandResult): RoomStateMessage {
  const success = expectOk(result);
  const message = success.deliveries[0]?.message;
  if (message?.type !== 'room_state') {
    throw new Error('expected a room_state delivery');
  }
  return message;
}

function boundTokenOf(success: RoomCommandSuccess, command: string): string {
  if (success.boundToken === undefined) {
    throw new Error(`${command} must bind the calling seat's token`);
  }
  return success.boundToken;
}

/** The retained match of a playing or finished room. */
function matchOf(manager: InMemoryRoomManager, roomId: string): RoomMatch {
  const match = manager.getMatch(roomId);
  if (match === null) {
    throw new Error(`room ${roomId} has no match`);
  }
  return match;
}

function boardOf(manager: InMemoryRoomManager, roomId: string): readonly (readonly MinesweeperCell[])[] {
  return matchOf(manager, roomId).state.engine.state.board;
}

/** First hidden, unflagged cell matching `predicate`, or null. */
function findHidden(
  manager: InMemoryRoomManager,
  roomId: string,
  predicate: (cell: MinesweeperCell) => boolean = () => true,
): MinesweeperCell | null {
  return (
    boardOf(manager, roomId)
      .flat()
      .find((cell) => !cell.revealed && !cell.flagged && predicate(cell)) ?? null
  );
}

function firstHiddenMine(manager: InMemoryRoomManager, roomId: string): MinesweeperCell {
  const mine = findHidden(manager, roomId, (cell) => cell.mine);
  if (mine === null) {
    throw new Error('expected a hidden mine');
  }
  return mine;
}

function firstHiddenSafe(manager: InMemoryRoomManager, roomId: string): MinesweeperCell {
  const safe = findHidden(manager, roomId, (cell) => !cell.mine);
  if (safe === null) {
    throw new Error('expected a hidden safe cell');
  }
  return safe;
}

interface StartedRoom {
  readonly manager: InMemoryRoomManager;
  readonly roomId: string;
  readonly hostToken: string;
  readonly guestToken: string;
  readonly hostId: string;
  readonly guestId: string;
  readonly match: RoomMatch;
  readonly startResult: RoomCommandSuccess;
  /** Every message produced by the create/join/ready/start flow. */
  readonly history: readonly ServerToClientMessage[];
}

/**
 * Start a match through the real room flow with short timers and a fixed seed.
 *
 * `createSeed` only decides the server seed; the seed itself is never sent to a
 * client, which the redaction assertions below prove.
 */
function startedRoom(options: RoomManagerOptions = {}): StartedRoom {
  const manager = createRoomManager({
    now: () => now,
    turnTimeoutMs: TURN_TIMEOUT_MS,
    matchTimeoutMs: MATCH_TIMEOUT_MS,
    createSeed: () => SEED,
    ...options,
  });
  const created = expectOk(manager.create(connection(), createMessage()));
  const hostToken = boundTokenOf(created, 'create');
  const roomId = roomStateOf(created).roomId;
  const joined = expectOk(manager.join(connection(), joinMessage(roomId)));
  const guestToken = boundTokenOf(joined, 'join');
  const hostReady = expectOk(manager.ready(connection(hostToken), readyMessage(roomId, true)));
  const guestReady = expectOk(manager.ready(connection(guestToken), readyMessage(roomId, true)));
  const startResult = expectOk(manager.start(connection(hostToken), startMessage(roomId)));

  const room = manager.getRoom(roomId);
  if (room === undefined) {
    throw new Error(`room ${roomId} disappeared after start`);
  }
  const host = room.seats.find((seat) => seat.isHost);
  const guest = room.seats.find((seat) => !seat.isHost);
  if (host === undefined || guest === undefined) {
    throw new Error('a started room must have two seats');
  }
  const history = [created, joined, hostReady, guestReady, startResult].flatMap((success) =>
    deliveriesOf(success),
  );
  return {
    manager,
    roomId,
    hostToken,
    guestToken,
    hostId: host.playerId,
    guestId: guest.playerId,
    match: matchOf(manager, roomId),
    startResult,
    history,
  };
}

function tokenFor(room: StartedRoom, playerId: string): string {
  if (playerId === room.hostId) {
    return room.hostToken;
  }
  if (playerId === room.guestId) {
    return room.guestToken;
  }
  throw new Error(`player ${playerId} is not seated in room ${room.roomId}`);
}

/**
 * Assert a rejected action changed nothing at all: same room record (including
 * seq), same match handle, same board and same replay input/digests.
 */
function expectRejectedWithoutChange(
  manager: InMemoryRoomManager,
  roomId: string,
  call: () => MatchCommandResult,
  code: ProtocolErrorCode,
): void {
  const beforeRoom = cloneRoom(manager, roomId);
  const beforeMatch = matchOf(manager, roomId);
  const beforeBoard = JSON.stringify(beforeMatch.state.engine.state.board);
  const beforeReplay = JSON.stringify(manager.getReplayRecord(roomId));
  const beforeDigests = JSON.stringify(manager.getReplayDigests(roomId));

  expectMatchRejected(call(), code);

  expect(manager.getRoom(roomId)).toEqual(beforeRoom);
  expect(manager.getRoom(roomId)?.seq).toBe(beforeRoom.seq);
  expect(manager.getMatch(roomId)).toBe(beforeMatch);
  expect(matchOf(manager, roomId).state.turnId).toBe(beforeMatch.state.turnId);
  expect(matchOf(manager, roomId).state.seq).toBe(beforeMatch.state.seq);
  expect(JSON.stringify(boardOf(manager, roomId))).toBe(beforeBoard);
  expect(JSON.stringify(manager.getReplayRecord(roomId))).toBe(beforeReplay);
  expect(JSON.stringify(manager.getReplayDigests(roomId))).toBe(beforeDigests);
}

// ---------------------------------------------------------------------------
// Start and redaction
// ---------------------------------------------------------------------------

describe('online authoritative match: start and redaction', () => {
  it('starts with a redacted snapshot and a seed commitment, never the seed', () => {
    const room = startedRoom();
    const manager = room.manager;

    const snapshots = messagesOfType(room.startResult, 'snapshot');
    expect(snapshots).toHaveLength(2);
    const snapshot = snapshots[0];
    if (snapshot === undefined) {
      throw new Error('start must broadcast a snapshot');
    }
    expect(snapshots[1]).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      type: 'snapshot',
      roomId: room.roomId,
      matchId: room.match.matchId,
      turnId: 0,
      turnPlayerId: room.hostId,
      engineStatus: 'playing',
      revealedSafeCount: 0,
      deadlineAt: NOW + TURN_TIMEOUT_MS,
      matchDeadlineAt: NOW + MATCH_TIMEOUT_MS,
    });
    // The starting board has not planted mines yet: every cell is hidden and
    // every hidden adjacent count is zero.
    expect(snapshot.board.flat().every((cell) => !cell.revealed && !cell.flagged)).toBe(true);
    expectRedactedSnapshot(snapshot);

    const record = manager.getRoom(room.roomId);
    expect(record?.state).toBe('playing');
    expect(record?.seq).toBe(snapshot.seq);
    expect(record?.matchId).toBe(room.match.matchId);
    expect(record?.turnPlayerId).toBe(room.hostId);

    // The server holds the seed; the wire only ever gets the commitment.
    expect(room.match.seed).toBe(SEED);
    expect(room.match.state.seedHash).toBe(hashSeed(SEED));
    for (const message of room.history) {
      expectNoSeed(message, `${message.type} at start`);
    }
    expect(JSON.stringify(room.history)).not.toMatch(/"seed"\s*:/);
  });

  it('keeps every accepted-action snapshot redacted and the room on the playing self-loop', () => {
    const room = startedRoom();
    const manager = room.manager;
    const history: ServerToClientMessage[] = [...room.history];

    const reveal = expectOk(
      manager.action(
        connection(room.hostToken),
        actionFor(manager, room.roomId, { actionId: 'host-reveal' }),
      ),
    );
    history.push(...deliveriesOf(reveal));
    expect(reveal.deliveries.map((delivery) => delivery.message.type)).toEqual([
      'action_result',
      'snapshot',
      'snapshot',
    ]);

    const actionResult = messagesOfType(reveal, 'action_result')[0];
    if (actionResult === undefined) {
      throw new Error('expected an action_result');
    }
    const beforeSeq = room.match.state.seq;
    expect(actionResult).toMatchObject({
      roomId: room.roomId,
      matchId: room.match.matchId,
      actionId: 'host-reveal',
      seq: beforeSeq + 1,
      accepted: true,
      reason: null,
      turnPlayerId: room.guestId,
      deadlineAt: NOW + TURN_TIMEOUT_MS,
    });
    expect(actionResult.revealedCells.length).toBeGreaterThan(0);

    for (const snapshot of messagesOfType(reveal, 'snapshot')) {
      expectRedactedSnapshot(snapshot);
      expect(snapshot.turnPlayerId).toBe(room.guestId);
    }
    expect(manager.getRoom(room.roomId)?.state).toBe(ACTION_LOOP.from);
    expect(manager.getRoom(room.roomId)?.state).toBe(ACTION_LOOP.to);

    const flagTarget = firstHiddenSafe(manager, room.roomId);
    const flag = expectOk(
      manager.action(
        connection(room.guestToken),
        actionFor(manager, room.roomId, {
          actionId: 'guest-flag',
          kind: 'flag',
          row: flagTarget.row,
          col: flagTarget.col,
        }),
      ),
    );
    history.push(...deliveriesOf(flag));
    const flagResult = messagesOfType(flag, 'action_result')[0];
    expect(flagResult?.flaggedCell).toEqual({ row: flagTarget.row, col: flagTarget.col });
    for (const snapshot of messagesOfType(flag, 'snapshot')) {
      expectRedactedSnapshot(snapshot);
    }
    expect(manager.getRoom(room.roomId)?.state).toBe(ACTION_LOOP.to);

    // No action message so far may carry the seed; only the eventual end does.
    for (const message of history) {
      expectNoSeed(message, `${message.type} before end`);
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('online authoritative match: action idempotency', () => {
  it('returns the cached action_result for a repeated actionId without moving seq/turnId', () => {
    const room = startedRoom();
    const manager = room.manager;
    const message = actionFor(manager, room.roomId, { actionId: 'retry-me' });

    const first = expectOk(manager.action(connection(room.hostToken), message));
    const beforeRoom = cloneRoom(manager, room.roomId);
    const beforeMatch = matchOf(manager, room.roomId);
    const cachedSeq = beforeMatch.state.seq;
    const cachedTurnId = beforeMatch.state.turnId;
    expect(first.deliveries.filter((delivery) => delivery.message.type === 'action_result')).toHaveLength(1);

    // The host's turn has already passed; idempotency wins over turn ownership.
    const duplicate = expectOk(manager.action(connection(room.hostToken), message));
    expect(duplicate.deliveries.map((delivery) => delivery.message.type)).toEqual(['action_result']);
    expect(duplicate.deliveries[0]?.playerToken).toBe(room.hostToken);

    const cached = messagesOfType(duplicate, 'action_result')[0];
    if (cached === undefined) {
      throw new Error('expected the cached action_result');
    }
    expect(cached).toMatchObject({
      roomId: room.roomId,
      matchId: room.match.matchId,
      actionId: 'retry-me',
      accepted: true,
      seq: cachedSeq,
      turnId: cachedTurnId,
    });

    // seq/turnId, the room record, the board and the replay log all stay put.
    expect(manager.getRoom(room.roomId)).toEqual(beforeRoom);
    expect(manager.getMatch(room.roomId)).toBe(beforeMatch);
    expect(matchOf(manager, room.roomId).state.seq).toBe(cachedSeq);
    expect(matchOf(manager, room.roomId).state.turnId).toBe(cachedTurnId);
    expect(manager.getReplayRecord(room.roomId)?.actions).toHaveLength(1);
    expectNoSeed(cached, 'cached action_result');

    // Another player reusing that actionId must not receive or replay it.
    expectRejectedWithoutChange(
      manager,
      room.roomId,
      () => manager.action(connection(room.guestToken), message),
      'invalid-action',
    );
  });
});

// ---------------------------------------------------------------------------
// Rejections leave the room, board, seq and replay log untouched
// ---------------------------------------------------------------------------

describe('online authoritative match: rejected actions change nothing', () => {
  it('rejects wrong turn/seq/turnId/deadline/coordinates/cell states unchanged', () => {
    const room = startedRoom();
    const manager = room.manager;
    const host = connection(room.hostToken);
    const guest = connection(room.guestToken);

    // The host moves first: the guest's otherwise well-formed action is out.
    expectRejectedWithoutChange(
      manager,
      room.roomId,
      () => manager.action(guest, actionFor(manager, room.roomId, { actionId: 'not-my-turn' })),
      'not-your-turn',
    );

    expectRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          host,
          actionFor(manager, room.roomId, {
            actionId: 'stale-seq',
            seq: (manager.getRoom(room.roomId)?.seq ?? 1) - 1,
          }),
        ),
      'stale-state',
    );
    expectRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          host,
          actionFor(manager, room.roomId, {
            actionId: 'stale-turn',
            turnId: matchOf(manager, room.roomId).state.turnId + 1,
          }),
        ),
      'stale-state',
    );
    expectRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          host,
          actionFor(manager, room.roomId, { actionId: 'too-low', row: -1 }),
        ),
      'invalid-action',
    );
    expectRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          host,
          actionFor(manager, room.roomId, { actionId: 'too-high', row: CONFIG.rows }),
        ),
      'invalid-action',
    );
    expectRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          host,
          actionFor(manager, room.roomId, { actionId: 'too-wide', col: CONFIG.cols }),
        ),
      'invalid-action',
    );
    expectRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          host,
          actionFor(manager, room.roomId, {
            actionId: 'foreign-match',
            matchId: 'match_other',
          }),
        ),
      'invalid-action',
    );
    expectRejectedWithoutChange(
      manager,
      room.roomId,
      () => manager.action(connection('stale-token'), actionFor(manager, room.roomId)),
      'invalid-action',
    );

    // A real reveal, then the rejected cell-state variants around it.
    const reveal = expectOk(
      manager.action(host, actionFor(manager, room.roomId, { actionId: 'open-corner' })),
    );
    expect(messagesOfType(reveal, 'action_result')).toHaveLength(1);

    expectRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          guest,
          actionFor(manager, room.roomId, { actionId: 'already-revealed', row: 0, col: 0 }),
        ),
      'invalid-action',
    );
    expectRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          guest,
          actionFor(manager, room.roomId, {
            actionId: 'flag-revealed',
            kind: 'flag',
            row: 0,
            col: 0,
          }),
        ),
      'invalid-action',
    );

    const flagged = firstHiddenSafe(manager, room.roomId);
    expectOk(
      manager.action(
        guest,
        actionFor(manager, room.roomId, {
          actionId: 'flag-hidden',
          kind: 'flag',
          row: flagged.row,
          col: flagged.col,
        }),
      ),
    );

    expectRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          host,
          actionFor(manager, room.roomId, {
            actionId: 'reveal-flagged',
            row: flagged.row,
            col: flagged.col,
          }),
        ),
      'invalid-action',
    );
    expectRejectedWithoutChange(
      manager,
      room.roomId,
      () =>
        manager.action(
          host,
          actionFor(manager, room.roomId, {
            actionId: 'flag-again',
            kind: 'flag',
            row: flagged.row,
            col: flagged.col,
          }),
        ),
      'invalid-action',
    );

    expect(manager.getRoom(room.roomId)?.state).toBe('playing');
  });

  it('rejects actions at the turn and match deadlines without changing anything', () => {
    let turnNow = NOW;
    const turnBound = startedRoom({ now: () => turnNow });
    turnNow += TURN_TIMEOUT_MS;
    expectRejectedWithoutChange(
      turnBound.manager,
      turnBound.roomId,
      () =>
        turnBound.manager.action(
          connection(turnBound.hostToken),
          actionFor(turnBound.manager, turnBound.roomId, { actionId: 'turn-too-late' }),
        ),
      'deadline-passed',
    );

    let matchNow = NOW;
    const matchBound = startedRoom({
      now: () => matchNow,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      matchTimeoutMs: 500,
    });
    matchNow += 500;
    expectRejectedWithoutChange(
      matchBound.manager,
      matchBound.roomId,
      () =>
        matchBound.manager.action(
          connection(matchBound.hostToken),
          actionFor(matchBound.manager, matchBound.roomId, { actionId: 'match-too-late' }),
        ),
      'deadline-passed',
    );
    expect(matchBound.manager.getRoom(matchBound.roomId)?.state).toBe('playing');
  });
});

// ---------------------------------------------------------------------------
// Endings: mine hit, every safe cell revealed, forfeit
// ---------------------------------------------------------------------------

describe('online authoritative match: endings', () => {
  it('ends exactly once on a mine hit and only then reveals every mine and the seed', () => {
    const room = startedRoom();
    const manager = room.manager;
    const history: ServerToClientMessage[] = [...room.history];

    const reveal = expectOk(
      manager.action(
        connection(room.hostToken),
        actionFor(manager, room.roomId, { actionId: 'open-first' }),
      ),
    );
    history.push(...deliveriesOf(reveal));
    for (const snapshot of messagesOfType(reveal, 'snapshot')) {
      expectRedactedSnapshot(snapshot);
    }

    const mine = firstHiddenMine(manager, room.roomId);
    const seqBeforeEnd = manager.getRoom(room.roomId)?.seq;
    const hit = expectOk(
      manager.action(
        connection(room.guestToken),
        actionFor(manager, room.roomId, {
          actionId: 'hit-the-mine',
          row: mine.row,
          col: mine.col,
        }),
      ),
    );
    expect(hit.deliveries.map((delivery) => delivery.message.type)).toEqual([
      'action_result',
      'snapshot',
      'snapshot',
      'end',
      'end',
      'room_state',
      'room_state',
    ]);
    for (const snapshot of messagesOfType(hit, 'snapshot')) {
      expectRedactedSnapshot(snapshot);
    }
    history.push(...deliveriesOf(hit));

    const end = expectOneEndPerSeat(hit, [room.hostToken, room.guestToken]);
    expect(end).toMatchObject({
      type: 'end',
      roomId: room.roomId,
      matchId: room.match.matchId,
      reason: 'mine-hit',
      winnerId: room.hostId,
      loserId: room.guestId,
      seq: (seqBeforeEnd ?? 0) + 1,
    });
    expectEndRevealsMatch(end);
    expect(end.finalSnapshot).toEqual(boardOf(manager, room.roomId));

    // The commitment published at start is exactly sha256(String(end.seed)).
    const startSnapshot = messagesOfType(room.startResult, 'snapshot')[0];
    if (startSnapshot === undefined) {
      throw new Error('start must publish a snapshot');
    }
    expect(createHash('sha256').update(String(end.seed)).digest('hex')).toBe(
      startSnapshot.seedHash,
    );

    // Every message before the end hides the seed; only end publishes it.
    for (const message of history) {
      if (message.type === 'end') {
        expect(Object.hasOwn(message, 'seed')).toBe(true);
      } else {
        expectNoSeed(message, `${message.type} before the end`);
      }
    }

    const record = manager.getRoom(room.roomId);
    expect(record).toMatchObject({
      state: END_TRANSITION.to,
      stateReason: 'mine-hit',
      turnPlayerId: null,
      deadlineAt: null,
      matchId: room.match.matchId,
    });
    expect(LIFECYCLE.terminalStates).toContain(END_TRANSITION.to);
    expect(matchOf(manager, room.roomId).state.finished).toBe(true);
    expect(matchOf(manager, room.roomId).state.end?.reason).toBe('mine-hit');

    // No second ending: further actions/forfeits are rejected without an end.
    expectMatchRejected(
      manager.action(
        connection(room.hostToken),
        actionFor(manager, room.roomId, { actionId: 'after-end' }),
      ),
      'invalid-action',
    );
    expectMatchRejected(
      manager.forfeit(room.roomId, room.match.matchId, room.guestId),
      'invalid-action',
    );
    expect(history.filter((message) => message.type === 'end')).toHaveLength(2);
    expect(cloneRoom(manager, room.roomId).seq).toBe(record?.seq);
  });

  it('ends exactly once when every safe cell is revealed', () => {
    const room = startedRoom();
    const manager = room.manager;
    const history: ServerToClientMessage[] = [...room.history];
    const endCopies: EndMessage[] = [];
    let lastActorId: string | null = null;
    let guard = 0;

    while (!matchOf(manager, room.roomId).state.finished && guard < 200) {
      const activeMatch = matchOf(manager, room.roomId);
      const actorId = activeMatch.state.turnPlayerId;
      const target = firstHiddenSafe(manager, room.roomId);
      // Keep the injected clock moving but always inside the short timers; the
      // test must never depend on real waiting.
      now += 10;
      const result = expectOk(
        manager.action(
          connection(tokenFor(room, actorId)),
          actionFor(manager, room.roomId, {
            actionId: `safe-${guard}`,
            row: target.row,
            col: target.col,
          }),
        ),
      );
      history.push(...deliveriesOf(result));
      for (const snapshot of messagesOfType(result, 'snapshot')) {
        expectRedactedSnapshot(snapshot);
      }
      endCopies.push(...messagesOfType(result, 'end'));
      const roomState = manager.getRoom(room.roomId)?.state;
      if (endCopies.length === 0) {
        expect(roomState).toBe(ACTION_LOOP.to);
      } else {
        expect(roomState).toBe(END_TRANSITION.to);
      }
      lastActorId = actorId;
      guard += 1;
    }

    const match = matchOf(manager, room.roomId);
    expect(match.state.finished).toBe(true);
    expect(match.state.snapshot.engineStatus).toBe('won');
    expect(match.state.end?.reason).toBe('all-safe-revealed');
    expect(endCopies).toHaveLength(2);
    const end = endCopies[0];
    if (end === undefined) {
      throw new Error('a finished match must broadcast an end');
    }
    expect(endCopies[1]).toEqual(end);
    expect(end.reason).toBe('all-safe-revealed');
    expect(lastActorId).not.toBeNull();
    expect(end.winnerId).toBe(lastActorId);
    expect(end.loserId).not.toBeNull();
    expectEndRevealsMatch(end);
    expect(end.finalSnapshot).toEqual(boardOf(manager, room.roomId));
    expect(manager.getRoom(room.roomId)?.state).toBe(END_TRANSITION.to);
    // An all-safe win needs a reveal, so the verdict's board really is won.
    expect(countMines(end)).toBe(CONFIG.mines);
    for (const message of history) {
      if (message.type === 'end') {
        expect(Object.hasOwn(message, 'seed')).toBe(true);
      } else {
        expectNoSeed(message, `${message.type} before the end`);
      }
    }
  });

  it('ends exactly once on a forfeit and moves the room to finished', () => {
    const room = startedRoom();
    const manager = room.manager;
    const history: ServerToClientMessage[] = [...room.history];

    const reveal = expectOk(
      manager.action(
        connection(room.hostToken),
        actionFor(manager, room.roomId, { actionId: 'forfeit-preface' }),
      ),
    );
    history.push(...deliveriesOf(reveal));
    const beforeSeq = manager.getRoom(room.roomId)?.seq;

    const forfeited = expectOk(
      manager.forfeit(room.roomId, room.match.matchId, room.guestId),
    );
    history.push(...deliveriesOf(forfeited));
    expect(forfeited.deliveries.map((delivery) => delivery.message.type)).toEqual([
      'end',
      'end',
      'room_state',
      'room_state',
    ]);

    const end = expectOneEndPerSeat(forfeited, [room.hostToken, room.guestToken]);
    expect(end).toMatchObject({
      type: 'end',
      roomId: room.roomId,
      matchId: room.match.matchId,
      reason: 'forfeit',
      winnerId: room.hostId,
      loserId: room.guestId,
      seq: (beforeSeq ?? 0) + 1,
    });
    expectEndRevealsMatch(end);

    expect(manager.getRoom(room.roomId)).toMatchObject({
      state: END_TRANSITION.to,
      stateReason: 'forfeit',
      turnPlayerId: null,
      deadlineAt: null,
    });
    expect(matchOf(manager, room.roomId).state.finished).toBe(true);
    expect(matchOf(manager, room.roomId).state.end?.reason).toBe('forfeit');

    // A second concession and a later action cannot produce another end.
    expectMatchRejected(
      manager.forfeit(room.roomId, room.match.matchId, room.guestId),
      'invalid-action',
    );
    expectMatchRejected(
      manager.action(
        connection(room.hostToken),
        actionFor(manager, room.roomId, { actionId: 'after-forfeit' }),
      ),
      'invalid-action',
    );
    expect(history.filter((message) => message.type === 'end')).toHaveLength(2);
    expect(countMines(end)).toBe(CONFIG.mines);
    for (const message of history) {
      if (message.type === 'end') {
        expect(Object.hasOwn(message, 'seed')).toBe(true);
      } else {
        expectNoSeed(message, `${message.type} before the end`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Replay determinism
// ---------------------------------------------------------------------------

describe('online authoritative match: replay', () => {
  it('replays the recorded seed/config/actions twice to identical digests and results', () => {
    const room = startedRoom();
    const manager = room.manager;

    expectOk(
      manager.action(
        connection(room.hostToken),
        actionFor(manager, room.roomId, { actionId: 'replay-reveal' }),
      ),
    );
    const mine = firstHiddenMine(manager, room.roomId);
    expectOk(
      manager.action(
        connection(room.guestToken),
        actionFor(manager, room.roomId, {
          actionId: 'replay-mine',
          row: mine.row,
          col: mine.col,
        }),
      ),
    );

    const record = manager.getReplayRecord(room.roomId);
    const digests = manager.getReplayDigests(room.roomId);
    if (record === null || digests === null) {
      throw new Error('a started match must expose its replay record and digests');
    }
    expect(record.matchId).toBe(room.match.matchId);
    expect(record.seed).toBe(SEED);
    expect(record.config).toEqual(CONFIG);
    expect(record.actions.map((action) => action.actionId)).toEqual([
      'replay-reveal',
      'replay-mine',
    ]);
    expect(digests.length).toBe(record.actions.length);
    expect(digests.map((digest) => digest.seq)).toEqual(
      record.actions.map((action) => action.seq),
    );

    const firstReplay = replayMatch(record, digests);
    const secondReplay = replayMatch(record, digests);
    expect(secondReplay).toEqual(firstReplay);
    expect(firstReplay.digests).toEqual(digests);
    expect(firstReplay.digests.map((digest) => digest.turnId)).toEqual(
      digests.map((digest) => digest.turnId),
    );
    expect(firstReplay.finalDigest).toEqual(digests.at(-1));
    expect(firstReplay.status).toBe('lost');
    // Without recorded digests the same record still produces that digest list.
    expect(replayMatch(record).digests).toEqual(digests);

    // The recorded digests pin the server seed: a different seed diverges.
    expect(() => replayMatch({ ...record, seed: SEED + 1 }, digests)).toThrow(
      ReplayMismatchError,
    );
  });
});

// ---------------------------------------------------------------------------
// design:room-lifecycle contract
// ---------------------------------------------------------------------------

describe('online authoritative match: design:room-lifecycle agreement', () => {
  it('uses playing → playing for accepted actions and playing → finished for end', () => {
    expect(ACTION_LOOP).toMatchObject({
      from: 'playing',
      event: 'action',
      to: 'playing',
    });
    expect(END_TRANSITION).toMatchObject({
      from: 'playing',
      event: 'end',
      to: 'finished',
    });
    expect(LIFECYCLE.terminalStates).toContain(END_TRANSITION.to);

    const room = startedRoom();
    const manager = room.manager;

    expectOk(
      manager.action(
        connection(room.hostToken),
        actionFor(manager, room.roomId, { actionId: 'design-loop' }),
      ),
    );
    expect(manager.getRoom(room.roomId)?.state).toBe(ACTION_LOOP.to);

    const mine = firstHiddenMine(manager, room.roomId);
    expectOk(
      manager.action(
        connection(room.guestToken),
        actionFor(manager, room.roomId, {
          actionId: 'design-end',
          row: mine.row,
          col: mine.col,
        }),
      ),
    );
    expect(manager.getRoom(room.roomId)?.state).toBe(END_TRANSITION.to);
  });
});
