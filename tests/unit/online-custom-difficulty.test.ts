/**
 * Server contract for a custom online difficulty (issue #540).
 *
 * The wire `create` message already carries a `MinesweeperConfig` and the room
 * manager already runs it through the engine's `validateConfig`. These tests
 * pin the part the issue names as the acceptance surface:
 *
 * - every out-of-bounds board is rejected with `bad-request` and creates no
 *   room, so a rejected host cannot leak a half-built table;
 * - the first-click safe zone is part of the capacity rule, so a 5x5 board
 *   cannot hold 17 mines even though 17 is below its 25 cells;
 * - a legal 12x12/20 room keeps that config from `create` through `ready` and
 *   `start` into the retained replay record, and both seats start on the same
 *   12-row, 12-column board.
 */

import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  validateServerMessage,
  type CreateMessage,
  type JoinMessage,
  type ReadyMessage,
  type RoomStateMessage,
  type ServerToClientMessage,
  type SnapshotMessage,
  type StartMessage,
} from '../../src/games/minesweeper/online/index';
import type {
  RoomCommandResult,
  RoomCommandSuccess,
  RoomConnection,
} from '../../server/room/contracts';
import {
  createRoomManager,
  type InMemoryRoomManager,
} from '../../server/room/room-manager';

const NOW = 1_700_000_000_000;

/** A legal custom board larger than the three classic presets. */
const CUSTOM_CONFIG = {
  rows: 12,
  cols: 12,
  mines: 20,
  firstClickSafe: true,
} as const satisfies CreateMessage['config'];

let connectionSeq = 0;

function connection(playerToken: string | null = null): RoomConnection {
  connectionSeq += 1;
  return { connectionId: `connection_${connectionSeq}`, playerToken };
}

function createMessage(
  config: CreateMessage['config'],
  requestId: string = 'req_create',
): CreateMessage {
  return {
    type: 'create',
    requestId,
    protocolVersion: PROTOCOL_VERSION,
    config,
    displayName: 'Ada',
  };
}

function joinMessage(roomId: string): JoinMessage {
  return {
    type: 'join',
    requestId: 'req_join',
    protocolVersion: PROTOCOL_VERSION,
    roomId,
    displayName: 'Grace',
  };
}

function readyMessage(roomId: string): ReadyMessage {
  return { type: 'ready', roomId, requestId: 'req_ready', ready: true };
}

function startMessage(roomId: string): StartMessage {
  return { type: 'start', roomId, requestId: 'req_start' };
}

/** Manager with a fixed clock and seed so a start is deterministic. */
function makeManager(): InMemoryRoomManager {
  return createRoomManager({ now: () => NOW, createSeed: () => 7 });
}

function expectOk(result: RoomCommandResult): RoomCommandSuccess {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.code}: ${result.error.message}`);
  }
  return result;
}

function boundToken(result: RoomCommandSuccess): string {
  const token = result.boundToken;
  if (token === undefined) {
    throw new Error('a seated command must bind the caller token');
  }
  return token;
}

function messagesOfType<T extends ServerToClientMessage['type']>(
  result: RoomCommandSuccess,
  type: T,
): (ServerToClientMessage & { readonly type: T })[] {
  return result.deliveries
    .map((delivery) => delivery.message)
    .filter((message): message is ServerToClientMessage & { readonly type: T } =>
      message.type === type,
    );
}

function roomStateOf(result: RoomCommandSuccess): RoomStateMessage {
  const message = messagesOfType(result, 'room_state')[0];
  if (message === undefined) {
    throw new Error('command delivered no room_state');
  }
  return message;
}

function snapshotsOf(result: RoomCommandSuccess): SnapshotMessage[] {
  return messagesOfType(result, 'snapshot');
}

/** Assert one rejection without a created room. */
function expectRejectedCreate(
  manager: InMemoryRoomManager,
  config: CreateMessage['config'],
  label: string,
): void {
  const result = manager.create(connection(), createMessage(config, `req_${label}`));
  if (result.ok) {
    throw new Error(`${label} was accepted as a legal room config`);
  }
  expect(result.code, label).toBe('bad-request');
  expect(result.error.requestId, label).toBe(`req_${label}`);
  expect(manager.roomCount, `${label} must not create a room`).toBe(0);
}

describe('custom difficulty create validation', () => {
  it('rejects rows and columns outside the playable bounds without creating a room', () => {
    const manager = makeManager();

    expectRejectedCreate(manager, { ...CUSTOM_CONFIG, rows: 4 }, 'rows-below-min');
    expectRejectedCreate(manager, { ...CUSTOM_CONFIG, rows: 31 }, 'rows-above-max');
    expectRejectedCreate(manager, { ...CUSTOM_CONFIG, cols: 4 }, 'cols-below-min');
    expectRejectedCreate(manager, { ...CUSTOM_CONFIG, cols: 31 }, 'cols-above-max');

    // Rejections leave the table empty; the next legal create still works.
    expect(manager.roomCount).toBe(0);
    expectOk(manager.create(connection(), createMessage(CUSTOM_CONFIG)));
    expect(manager.roomCount).toBe(1);
  });

  it('rejects mine counts that do not fit the board or the first-click safe zone', () => {
    const manager = makeManager();

    // Mines must be strictly fewer than the cell count.
    expectRejectedCreate(
      manager,
      { rows: 5, cols: 5, mines: 25, firstClickSafe: true },
      'mines-equal-cells',
    );
    expectRejectedCreate(
      manager,
      { rows: 9, cols: 9, mines: 81, firstClickSafe: true },
      'mines-above-cells',
    );

    // 5x5 leaves only 16 cells outside the 3x3 first-click safe zone, so the
    // 17th mine cannot be placed away from a corner opening.
    expectRejectedCreate(
      manager,
      { rows: 5, cols: 5, mines: 17, firstClickSafe: true },
      'mines-above-safe-capacity',
    );

    // The same board at the exact capacity is legal and keeps its config.
    const result = expectOk(
      manager.create(
        connection(),
        createMessage({ rows: 5, cols: 5, mines: 16, firstClickSafe: true }),
      ),
    );
    expect(roomStateOf(result).config).toStrictEqual({
      rows: 5,
      cols: 5,
      mines: 16,
      firstClickSafe: true,
    });
  });
});

describe('custom difficulty replay contract', () => {
  it('keeps a legal 12x12/20 config through create → join → ready → start', () => {
    const manager = makeManager();
    const created = expectOk(manager.create(connection(), createMessage(CUSTOM_CONFIG)));
    const hostToken = boundToken(created);
    const roomId = roomStateOf(created).roomId;

    expect(manager.roomCount).toBe(1);
    const room = manager.getRoom(roomId);
    if (room === undefined) {
      throw new Error('create did not store the room');
    }
    expect(room.config).toStrictEqual(CUSTOM_CONFIG);
    expect(roomStateOf(created).config).toStrictEqual(CUSTOM_CONFIG);

    const joined = expectOk(manager.join(connection(), joinMessage(roomId)));
    const guestToken = boundToken(joined);
    expectOk(manager.ready(connection(hostToken), readyMessage(roomId)));
    expectOk(manager.ready(connection(guestToken), readyMessage(roomId)));

    // Ready is a lobby transition; the chosen board must not be replaced by a
    // preset on the way into the match.
    const readyRoom = manager.getRoom(roomId);
    if (readyRoom === undefined) {
      throw new Error('the room disappeared while becoming ready');
    }
    expect(readyRoom.state).toBe('ready');
    expect(readyRoom.config).toStrictEqual(CUSTOM_CONFIG);

    const started = expectOk(manager.start(connection(hostToken), startMessage(roomId)));
    const playingRoom = manager.getRoom(roomId);
    if (playingRoom === undefined) {
      throw new Error('start dissolved the room');
    }
    expect(playingRoom.state).toBe('playing');
    expect(playingRoom.config).toStrictEqual(CUSTOM_CONFIG);

    // Both seats receive the same starting snapshot and therefore the same
    // board: 12 rows of 12 redacted cells with 20 mines.
    const snapshots = snapshotsOf(started);
    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(validateServerMessage(snapshot).ok).toBe(true);
      expect(snapshot.mineCount).toBe(20);
      expect(snapshot.remainingMines).toBe(20);
      expect(snapshot.board).toHaveLength(12);
      for (const row of snapshot.board) {
        expect(row).toHaveLength(12);
      }
    }
    expect(snapshots[1]).toStrictEqual(snapshots[0]);

    // The retained match and its replay input carry the very same config the
    // host created the room with, not a default or a re-derived preset.
    const replay = manager.getReplayRecord(roomId);
    if (replay === null) {
      throw new Error('a started match must expose its replay record');
    }
    expect(replay.config).toStrictEqual(room.config);
    expect(replay.config).toStrictEqual(CUSTOM_CONFIG);
    expect(manager.getMatch(roomId)?.state.config).toStrictEqual(CUSTOM_CONFIG);
  });
});
