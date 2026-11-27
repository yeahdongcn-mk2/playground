import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { validateClientMessage } from '../../src/games/minesweeper/online/protocol';
import type {
  ActionMessage,
  ErrorMessage,
  RedactedBoard,
  RedactedCell,
  SnapshotMessage,
} from '../../src/games/minesweeper/online/types';
import {
  ONLINE_SEAT_STORAGE_KEY_PREFIX,
  actionFrameFromSnapshot,
  boardSnapshotFromCells,
  boardSnapshotFromRedactedBoard,
  boardSnapshotFromSnapshot,
  boardSnapshotsEqual,
  buildActionFrame,
  classifyWireFrame,
  createServerFrameRecorder,
  diffBoardSnapshots,
  duplicateActionFrame,
  formatBoardSnapshot,
  invalidCoordinateActionFrame,
  parseServerFrame,
  parseStoredSeatSession,
  serverMessageSeq,
} from '../e2e/minesweeper-online-helpers';

const ROOM_ID = 'room-e2e-1';
const MATCH_ID = 'match-e2e-1';
const TURN_PLAYER_ID = 'player-host';
const ACTION_ID = 'action-helpers-1';

function cell(
  row: number,
  col: number,
  overrides: Partial<RedactedCell> = {},
): RedactedCell {
  return { row, col, revealed: false, flagged: false, adjacentMines: 0, ...overrides };
}

/**
 * 2x2 redacted board:
 *
 * - `(0, 0)` revealed with no adjacent mines;
 * - `(0, 1)` flagged;
 * - `(1, 0)` hidden but reports a stale adjacent count (must normalise to 0);
 * - `(1, 1)` revealed with three adjacent mines.
 */
const BOARD: RedactedBoard = [
  [cell(0, 0, { revealed: true }), cell(0, 1, { flagged: true })],
  [cell(1, 0, { adjacentMines: 5 }), cell(1, 1, { revealed: true, adjacentMines: 3 })],
];

function snapshotMessage(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    type: 'snapshot',
    roomId: ROOM_ID,
    matchId: MATCH_ID,
    seq: 7,
    turnPlayerId: TURN_PLAYER_ID,
    turnId: 4,
    seedHash: '0123456789abcdef',
    deadlineAt: 1_000,
    matchDeadlineAt: 2_000,
    elapsedMs: 50,
    engineStatus: 'playing',
    mineCount: 2,
    remainingMines: 1,
    revealedSafeCount: 2,
    board: BOARD,
    ...overrides,
  };
}

function baseAction(overrides: Partial<ActionMessage> = {}): ActionMessage {
  return {
    ...buildActionFrame({
      roomId: ROOM_ID,
      matchId: MATCH_ID,
      actionId: ACTION_ID,
      seq: 7,
      turnId: 4,
      kind: 'reveal',
      row: 0,
      col: 0,
    }),
    ...overrides,
  };
}

function errorMessage(): ErrorMessage {
  return {
    type: 'error',
    requestId: null,
    roomId: null,
    code: 'bad-request',
    message: 'bad-request',
    retryable: false,
    currentSeq: null,
  };
}

describe('classifyWireFrame', () => {
  it('recognises a valid server frame and reports its seq', () => {
    const classified = classifyWireFrame(JSON.stringify(snapshotMessage()));

    expect(classified.kind).toBe('server-message');
    if (classified.kind !== 'server-message') {
      throw new Error('expected a server message');
    }
    expect(classified.message).toMatchObject({ type: 'snapshot', seq: 7 });
    expect(serverMessageSeq(classified.message)).toBe(7);
    expect(serverMessageSeq(errorMessage())).toBeNull();
  });

  it('recognises a valid client action frame and parses it as client-only', () => {
    const frame = JSON.stringify(baseAction());
    const classified = classifyWireFrame(frame);

    expect(classified.kind).toBe('client-message');
    if (classified.kind !== 'client-message') {
      throw new Error('expected a client message');
    }
    expect(classified.message).toMatchObject({ type: 'action', actionId: ACTION_ID });
    expect(parseServerFrame(frame)).toBeNull();
  });

  it('parses Buffer payloads the same way as strings', () => {
    const classified = classifyWireFrame(Buffer.from(JSON.stringify(snapshotMessage())));

    expect(classified.kind).toBe('server-message');
    const parsed = parseServerFrame(Buffer.from(JSON.stringify(snapshotMessage())));
    expect(parsed).not.toBeNull();
    expect(parsed === null ? null : serverMessageSeq(parsed)).toBe(7);
  });

  it('rejects non-JSON, unknown types and payloads missing required fields', () => {
    const invalidJson = classifyWireFrame('{not json');
    expect(invalidJson).toEqual({ kind: 'invalid', reason: 'frame is not valid JSON' });

    const unknownType = classifyWireFrame(JSON.stringify({ type: 'not-a-message' }));
    expect(unknownType.kind).toBe('invalid');
    if (unknownType.kind === 'invalid') {
      expect(unknownType.reason).toContain('unknown message type');
    }

    const missingFields = classifyWireFrame(JSON.stringify({ type: 'snapshot', seq: 7 }));
    expect(missingFields.kind).toBe('invalid');
    expect(parseServerFrame(JSON.stringify({ type: 'snapshot', seq: 7 }))).toBeNull();
  });
});

describe('server frame recorder', () => {
  it('records manually forwarded frames and resolves typed and seq waits', async () => {
    // The page is only needed for its socket event subscription; a route-based
    // spec feeds already-observed server frames through recordServerFrame.
    const page = { on: () => {}, off: () => {} } as unknown as Parameters<
      typeof createServerFrameRecorder
    >[0];
    const recorder = createServerFrameRecorder(page, { timeoutMs: 100 });
    try {
      recorder.recordServerFrame(JSON.stringify(snapshotMessage()));
      recorder.recordServerFrame('{not json');

      await expect(recorder.waitForSeq(7)).resolves.toMatchObject({
        type: 'snapshot',
        seq: 7,
      });
      await expect(recorder.waitForMessageOfType('snapshot')).resolves.toMatchObject({
        seq: 7,
      });
      await expect(
        recorder.waitForActionResult('missing-action', { timeoutMs: 10 }),
      ).rejects.toThrow(/timed out after 10ms/);
      expect(recorder.invalidFrames).toHaveLength(1);
    } finally {
      recorder.dispose();
    }
  });
});

describe('board snapshots', () => {
  it('parses a snapshot message into a row-major board and normalises hidden counts', () => {
    const board = boardSnapshotFromSnapshot(snapshotMessage());

    expect(board).toHaveLength(2);
    expect(board[0]).toHaveLength(2);
    expect(board[0]?.[0]).toEqual({
      row: 0,
      col: 0,
      revealed: true,
      flagged: false,
      adjacentMines: 0,
    });
    expect(board[0]?.[1]).toEqual({
      row: 0,
      col: 1,
      revealed: false,
      flagged: true,
      adjacentMines: 0,
    });
    expect(board[1]?.[0]).toEqual({
      row: 1,
      col: 0,
      revealed: false,
      flagged: false,
      adjacentMines: 0,
    });
    expect(formatBoardSnapshot(board)).toBe('0,F/#,3');
  });

  it('builds the same snapshot from cells in any order', () => {
    const cells = BOARD.flat();
    const shuffled = [cells[3], cells[0], cells[2], cells[1]].flatMap((entry) =>
      entry === undefined ? [] : [entry],
    );

    expect(boardSnapshotFromCells(shuffled)).toEqual(boardSnapshotFromRedactedBoard(BOARD));
  });

  it('reports the cells that differ between two boards', () => {
    const left = boardSnapshotFromRedactedBoard(BOARD);
    const right = boardSnapshotFromRedactedBoard([
      [cell(0, 0, { revealed: true }), cell(0, 1)],
      [cell(1, 0, { flagged: true }), cell(1, 1, { revealed: true, adjacentMines: 3 })],
    ]);

    expect(diffBoardSnapshots(left, right)).toEqual([
      { row: 0, col: 1, left: 'F', right: '#' },
      { row: 1, col: 0, left: '#', right: 'F' },
    ]);
    expect(boardSnapshotsEqual(left, right)).toBe(false);
    expect(boardSnapshotsEqual(left, boardSnapshotFromRedactedBoard(BOARD))).toBe(true);
  });

  it('rejects ragged, duplicate and misnumbered cells instead of comparing wrong shapes', () => {
    expect(() =>
      boardSnapshotFromCells([
        cell(0, 0),
        cell(0, 1),
        cell(1, 0),
      ]),
    ).toThrow(/board row 1 has 1 cells; expected 2/);

    expect(() => boardSnapshotFromCells([cell(0, 0), cell(0, 0)])).toThrow(
      /board cell \(0, 0\) appears twice/,
    );

    expect(() => boardSnapshotFromCells([cell(0, 0), cell(1, 1)])).toThrow(
      /board cell \(1, 0\) is missing/,
    );

    const twoByTwo = boardSnapshotFromRedactedBoard(BOARD);
    expect(() => diffBoardSnapshots(twoByTwo, [twoByTwo[0] ?? []])).toThrow(
      /board row counts differ/,
    );
  });
});

describe('action frames', () => {
  it('builds a protocol-shaped action with a deterministic client clock', () => {
    const action = baseAction();

    expect(action).toEqual({
      type: 'action',
      roomId: ROOM_ID,
      matchId: MATCH_ID,
      actionId: ACTION_ID,
      seq: 7,
      turnId: 4,
      kind: 'reveal',
      row: 0,
      col: 0,
      clientTimeMs: 0,
    });
    expect(validateClientMessage(action)).toEqual({ ok: true, value: action });
  });

  it('derives a fresh action from a snapshot, defaulting to its seq and turn', () => {
    const action = actionFrameFromSnapshot(snapshotMessage(), {
      actionId: 'action-from-snapshot',
      kind: 'flag',
      row: 1,
      col: 0,
    });

    expect(action).toMatchObject({
      roomId: ROOM_ID,
      matchId: MATCH_ID,
      actionId: 'action-from-snapshot',
      seq: 7,
      turnId: 4,
      kind: 'flag',
      row: 1,
      col: 0,
      clientTimeMs: 0,
    });

    const overridden = actionFrameFromSnapshot(snapshotMessage(), {
      actionId: 'action-overridden',
      kind: 'reveal',
      row: 1,
      col: 1,
      seq: 8,
      turnId: 5,
      clientTimeMs: 123,
    });
    expect(overridden).toMatchObject({ seq: 8, turnId: 5, clientTimeMs: 123 });
  });

  it('copies a duplicate actionId retry without changing any field', () => {
    const action = baseAction();
    const duplicate = duplicateActionFrame(action);

    expect(duplicate).toEqual(action);
    expect(duplicate).not.toBe(action);
    // A retry may arrive after the original advanced seq/turnId; the action
    // id alone must identify it, so the copy stays byte-for-byte identical.
    expect(duplicateActionFrame(action)).toMatchObject({ actionId: ACTION_ID, seq: 7 });
  });

  it('builds an out-of-bounds frame with a fresh actionId', () => {
    const action = baseAction();
    const invalid = invalidCoordinateActionFrame(action, { row: 9, col: -1 });

    expect(invalid).toEqual({ ...action, actionId: `${ACTION_ID}-invalid`, row: 9, col: -1 });
    expect(validateClientMessage(invalid).ok).toBe(true);
    expect(invalid.actionId).not.toBe(action.actionId);
    expect(invalid.seq).toBe(action.seq);
    expect(invalid.turnId).toBe(action.turnId);

    const explicit = invalidCoordinateActionFrame(action, {
      row: 0,
      col: 9,
      actionId: 'action-invalid-explicit',
    });
    expect(explicit.actionId).toBe('action-invalid-explicit');
  });
});

describe('stored seat parsing', () => {
  it('parses a valid seat and rejects another room or a malformed value', () => {
    const stored = {
      roomId: ROOM_ID,
      playerToken: 'seat-token',
      displayName: 'Ada',
      role: 'host' as const,
    };

    expect(parseStoredSeatSession(JSON.stringify(stored), ROOM_ID)).toEqual(stored);
    expect(parseStoredSeatSession(null, ROOM_ID)).toBeNull();
    expect(parseStoredSeatSession('{not json', ROOM_ID)).toBeNull();
    expect(
      parseStoredSeatSession(JSON.stringify({ ...stored, roomId: 'other-room' }), ROOM_ID),
    ).toBeNull();
    expect(
      parseStoredSeatSession(JSON.stringify({ ...stored, playerToken: 42 }), ROOM_ID),
    ).toBeNull();
    expect(
      parseStoredSeatSession(JSON.stringify({ ...stored, role: 'spectator' }), ROOM_ID),
    ).toBeNull();
  });
});

describe('helper module contract', () => {
  const helperSource = readFileSync(
    new URL('../e2e/minesweeper-online-helpers.ts', import.meta.url),
    'utf8',
  );

  it('imports Playwright types only, never the runtime', () => {
    expect(helperSource).toContain("import type { Page, WebSocket } from '@playwright/test';");
    expect(helperSource).not.toMatch(
      /import\s+(?!type\b)[^;]*from\s+['"]@playwright\/test['"]/,
    );
    // Fixed sleeps are the one wait the online suite must not rely on.
    expect(helperSource).not.toContain('waitForTimeout');
  });

  it('keeps the seat-storage prefix in sync with the client module', () => {
    const clientSource = readFileSync(
      new URL(
        '../../src/games/minesweeper/online/client/online-room.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(clientSource).toContain(
      `export const ONLINE_SEAT_STORAGE_PREFIX = '${ONLINE_SEAT_STORAGE_KEY_PREFIX}';`,
    );
  });
});
