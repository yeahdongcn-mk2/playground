import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkSeq,
  checkTurnId,
  classifyActionId,
  createProtocolError,
  evaluateAction,
  protocolErrorFromResult,
  protocolValidator,
  validateAction,
  validateClientMessage,
  validateServerMessage,
  validateVersion,
  type ActionGate,
  type ProtocolValidation,
  type ProtocolValidationFailure,
} from '../../src/games/minesweeper/online/protocol';
import {
  MESSAGE_SPECS,
  PROTOCOL_VERSION,
  type ActionMessage,
  type ActionValidationContext,
  type ClientToServerMessage,
  type ProtocolErrorCode,
  type ServerToClientMessage,
} from '../../src/games/minesweeper/online/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROTOCOL_SOURCE = readFileSync(
  join(ROOT, 'src', 'games', 'minesweeper', 'online', 'protocol.ts'),
  'utf8',
);

const SHARED_ERROR_CODES: readonly ProtocolErrorCode[] = [
  'unsupported-version',
  'room-not-found',
  'not-your-turn',
  'stale-state',
  'invalid-action',
  'deadline-passed',
  'bad-request',
];

const CONFIG = {
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
};

const PLAYER = {
  playerId: 'p1',
  displayName: 'Ada',
  ready: true,
  presence: 'online',
  isHost: true,
} as const;

const REDACTED_CELL = {
  row: 0,
  col: 0,
  revealed: true,
  flagged: false,
  adjacentMines: 1,
};

const REDACTED_BOARD = [
  [
    REDACTED_CELL,
    { row: 0, col: 1, revealed: false, flagged: true, adjacentMines: 0 },
  ],
  [
    { row: 1, col: 0, revealed: false, flagged: false, adjacentMines: 0 },
    { row: 1, col: 1, revealed: false, flagged: false, adjacentMines: 1 },
  ],
];

const REVEALED_BOARD = [
  [{ row: 0, col: 0, mine: true, revealed: false, flagged: false, adjacentMines: 0 }],
];

const ACTION: ActionMessage = {
  type: 'action',
  roomId: 'room-1',
  matchId: 'match-1',
  actionId: 'action-1',
  seq: 7,
  turnId: 3,
  kind: 'reveal',
  row: 2,
  col: 3,
  clientTimeMs: 1_000,
};

const CREATE_MESSAGE: ClientToServerMessage = {
  type: 'create',
  requestId: 'req-create',
  protocolVersion: PROTOCOL_VERSION,
  config: CONFIG,
  displayName: 'Ada',
};

const JOIN_MESSAGE: ClientToServerMessage = {
  type: 'join',
  requestId: 'req-join',
  protocolVersion: PROTOCOL_VERSION,
  roomId: 'room-1',
  displayName: 'Grace',
};

const READY_MESSAGE: ClientToServerMessage = {
  type: 'ready',
  roomId: 'room-1',
  requestId: 'req-ready',
  ready: true,
};

const ROOM_STATE_MESSAGE: ServerToClientMessage = {
  type: 'room_state',
  roomId: 'room-1',
  seq: 1,
  state: 'ready',
  hostId: 'p1',
  capacity: 2,
  players: [PLAYER],
  config: CONFIG,
  matchId: null,
  turnPlayerId: null,
  joinDeadlineAt: 120_000,
  deadlineAt: null,
  stateReason: null,
};

const SNAPSHOT_MESSAGE: ServerToClientMessage = {
  type: 'snapshot',
  roomId: 'room-1',
  matchId: 'match-1',
  seq: 7,
  turnPlayerId: 'p1',
  turnId: 3,
  seedHash: 'a'.repeat(64),
  deadlineAt: 30_000,
  matchDeadlineAt: 900_000,
  elapsedMs: 5_000,
  engineStatus: 'playing',
  mineCount: 10,
  remainingMines: 9,
  revealedSafeCount: 1,
  board: REDACTED_BOARD,
};

const END_MESSAGE: ServerToClientMessage = {
  type: 'end',
  roomId: 'room-1',
  matchId: 'match-1',
  seq: 8,
  reason: 'mine-hit',
  winnerId: 'p1',
  loserId: 'p2',
  finalSnapshot: REVEALED_BOARD,
  seed: 42,
  stats: { turnCount: 9, revealedSafeCount: 1, flagsPlaced: 0, durationMs: 5_000 },
};

const TIMEOUT_MESSAGE: ServerToClientMessage = {
  type: 'timeout',
  roomId: 'room-1',
  matchId: null,
  seq: 2,
  timer: 'join',
  subjectId: null,
  deadlineAt: 120_000,
  resultingState: 'dissolved',
  reason: 'join deadline passed',
};

const ERROR_MESSAGE: ServerToClientMessage = {
  type: 'error',
  requestId: null,
  roomId: null,
  code: 'bad-request',
  message: 'bad request',
  retryable: false,
  currentSeq: null,
};

const VALID_CLIENT_MESSAGES: readonly ClientToServerMessage[] = [
  CREATE_MESSAGE,
  JOIN_MESSAGE,
  READY_MESSAGE,
  { type: 'start', roomId: 'room-1', requestId: 'req-start' },
  ACTION,
  { type: 'rematch', roomId: 'room-1', requestId: 'req-rematch', accept: true },
  { type: 'leave', roomId: 'room-1', requestId: 'req-leave' },
];

const VALID_SERVER_MESSAGES: readonly ServerToClientMessage[] = [
  ROOM_STATE_MESSAGE,
  SNAPSHOT_MESSAGE,
  {
    type: 'action_result',
    roomId: 'room-1',
    matchId: 'match-1',
    actionId: 'action-1',
    seq: 7,
    turnId: 3,
    accepted: true,
    reason: null,
    revealedCells: [{ row: 2, col: 3 }],
    flaggedCell: null,
    turnPlayerId: 'p2',
    deadlineAt: 30_000,
  },
  END_MESSAGE,
  TIMEOUT_MESSAGE,
  {
    type: 'room_closed',
    roomId: 'room-1',
    seq: 3,
    reason: 'join deadline passed',
    finalState: 'dissolved',
  },
  ERROR_MESSAGE,
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as unknown as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

type AnyProtocolOutcome = ProtocolValidation<unknown> | ActionGate;

function expectFailure(result: AnyProtocolOutcome): ProtocolValidationFailure {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('expected the validator to reject the value');
  }
  return result;
}

function createContext(
  overrides: Partial<ActionValidationContext> = {},
  cellStates: Readonly<Record<string, 'hidden' | 'revealed' | 'flagged'>> = {},
): ActionValidationContext {
  return {
    actorId: 'p1',
    turnPlayerId: 'p1',
    currentSeq: ACTION.seq,
    currentTurnId: ACTION.turnId,
    deadlineAt: 10_000,
    nowMs: 1_000,
    recentActionIds: new Set<string>(),
    rows: 9,
    cols: 9,
    cellState: (row, col) => cellStates[`${row},${col}`] ?? 'hidden',
    ...overrides,
  };
}

/** Stand-in for the room service: it applies only a fresh gate result. */
function applyIfFresh(action: ActionMessage, context: ActionValidationContext): string[] {
  const applied: string[] = [];
  const gate = evaluateAction(action, context);
  if (gate.ok && gate.status === 'fresh') {
    applied.push(action.actionId);
  }
  return applied;
}

describe('online protocol message validation', () => {
  it('accepts all 14 design messages with the right direction', () => {
    expect(VALID_CLIENT_MESSAGES.map((message) => message.type)).toEqual([
      'create',
      'join',
      'ready',
      'start',
      'action',
      'rematch',
      'leave',
    ]);
    expect(VALID_SERVER_MESSAGES.map((message) => message.type)).toEqual([
      'room_state',
      'snapshot',
      'action_result',
      'end',
      'timeout',
      'room_closed',
      'error',
    ]);
    expect(MESSAGE_SPECS).toHaveLength(14);

    for (const message of VALID_CLIENT_MESSAGES) {
      const result = validateClientMessage(message);
      expect(result.ok, `${message.type} should be valid`).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(message);
      }
    }

    for (const message of VALID_SERVER_MESSAGES) {
      const result = validateServerMessage(message);
      expect(result.ok, `${message.type} should be valid`).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(message);
      }
    }
  });

  it('accepts optional fields when they are present and well typed', () => {
    expect(validateClientMessage({ ...JOIN_MESSAGE, playerToken: 'token-1' }).ok).toBe(true);
    expect(
      validateServerMessage({ ...ROOM_STATE_MESSAGE, playerToken: 'token-1' }).ok,
    ).toBe(true);
  });

  it('rejects non-object input and unknown or non-string types', () => {
    for (const input of [null, 'create', [], 42]) {
      expect(expectFailure(validateClientMessage(input)).code).toBe('bad-request');
    }

    expect(
      expectFailure(validateClientMessage({ ...CREATE_MESSAGE, type: 'nope' })),
    ).toMatchObject({ code: 'bad-request' });
    expect(
      expectFailure(validateClientMessage({ ...CREATE_MESSAGE, type: 1 })),
    ).toMatchObject({ code: 'bad-request' });
  });

  it('rejects missing required fields and wrong field types', () => {
    const missingRoom = expectFailure(
      validateClientMessage({ ...JOIN_MESSAGE, roomId: undefined }),
    );
    expect(missingRoom).toMatchObject({ code: 'bad-request' });
    expect(missingRoom.message).toContain('roomId');

    const wrongSeq = expectFailure(validateClientMessage({ ...ACTION, seq: '7' }));
    expect(wrongSeq).toMatchObject({ code: 'bad-request' });
    expect(wrongSeq.message).toContain('seq');
    expect(wrongSeq.message).toContain('integer');

    const wrongReady = expectFailure(
      validateClientMessage({ ...READY_MESSAGE, ready: 'yes' }),
    );
    expect(wrongReady.message).toContain('boolean');

    const wrongOptional = expectFailure(
      validateClientMessage({ ...JOIN_MESSAGE, playerToken: 42 }),
    );
    expect(wrongOptional).toMatchObject({ code: 'bad-request' });
  });

  it('rejects a message sent in the wrong direction', () => {
    const clientFirst = expectFailure(validateServerMessage(CREATE_MESSAGE));
    expect(clientFirst).toMatchObject({ code: 'bad-request' });
    expect(clientFirst.message).toContain('client-to-server');

    const serverFirst = expectFailure(validateClientMessage(ROOM_STATE_MESSAGE));
    expect(serverFirst).toMatchObject({ code: 'bad-request' });
    expect(serverFirst.message).toContain('server-to-client');
  });

  it('rejects unsupported protocol versions and non-integer versions', () => {
    expect(
      expectFailure(
        validateClientMessage({
          ...CREATE_MESSAGE,
          protocolVersion: PROTOCOL_VERSION + 1,
        }),
      ),
    ).toMatchObject({ code: 'unsupported-version', retryable: false });
    expect(validateVersion(PROTOCOL_VERSION)).toEqual({
      ok: true,
      value: PROTOCOL_VERSION,
    });
    expect(expectFailure(validateVersion(PROTOCOL_VERSION + 1)).code).toBe(
      'unsupported-version',
    );

    const wrongType = expectFailure(
      validateClientMessage({ ...CREATE_MESSAGE, protocolVersion: '1' }),
    );
    expect(wrongType.code).toBe('bad-request');
  });

  it('rejects illegal enum values in nested and flat fields', () => {
    expect(expectFailure(validateClientMessage({ ...ACTION, kind: 'explode' })).code).toBe(
      'bad-request',
    );

    const badState = expectFailure(
      validateServerMessage({ ...ROOM_STATE_MESSAGE, state: 'bogus' }),
    );
    expect(badState.code).toBe('bad-request');
    expect(badState.message).toContain('state');

    expect(
      expectFailure(
        validateServerMessage({ ...SNAPSHOT_MESSAGE, engineStatus: 'bogus' }),
      ).code,
    ).toBe('bad-request');
    expect(
      expectFailure(validateServerMessage({ ...END_MESSAGE, reason: 'bogus' })).code,
    ).toBe('bad-request');
    expect(
      expectFailure(
        validateServerMessage({
          ...TIMEOUT_MESSAGE,
          timer: 'bogus',
        }),
      ).code,
    ).toBe('bad-request');
    expect(
      expectFailure(validateServerMessage({ ...ERROR_MESSAGE, code: 'made-up' })).code,
    ).toBe('bad-request');
  });

  it('validates the nested config and player list', () => {
    const badRows = expectFailure(
      validateClientMessage({
        ...CREATE_MESSAGE,
        config: { ...CONFIG, rows: '9' },
      }),
    );
    expect(badRows.code).toBe('bad-request');
    expect(badRows.message).toContain('config.rows');

    const missingPolicy = expectFailure(
      validateClientMessage({
        ...CREATE_MESSAGE,
        config: { rows: 9, cols: 9, mines: 10 },
      }),
    );
    expect(missingPolicy.message).toContain('firstClickSafe');

    const badPresence = expectFailure(
      validateServerMessage({
        ...ROOM_STATE_MESSAGE,
        players: [{ ...PLAYER, presence: 'away' }],
      }),
    );
    expect(badPresence.message).toContain('presence');

    const notAPlayerList = expectFailure(
      validateServerMessage({ ...ROOM_STATE_MESSAGE, players: PLAYER }),
    );
    expect(notAPlayerList.message).toContain('array');
  });

  it('validates hidden-mine boards and end-only revealed boards', () => {
    const leakedMine = expectFailure(
      validateServerMessage({
        ...SNAPSHOT_MESSAGE,
        board: [[{ ...REDACTED_CELL, mine: true }]],
      }),
    );
    expect(leakedMine.code).toBe('bad-request');
    expect(leakedMine.message).toContain('mine');

    const missingAdjacent = expectFailure(
      validateServerMessage({
        ...SNAPSHOT_MESSAGE,
        board: [[{ row: 0, col: 0, revealed: true, flagged: false }]],
      }),
    );
    expect(missingAdjacent.message).toContain('adjacentMines');

    const endWithoutMine = expectFailure(
      validateServerMessage({
        ...END_MESSAGE,
        finalSnapshot: [[{ row: 0, col: 0, revealed: true, flagged: false, adjacentMines: 0 }]],
      }),
    );
    expect(endWithoutMine.message).toContain('mine');

    const badStats = expectFailure(
      validateServerMessage({
        ...END_MESSAGE,
        stats: { turnCount: 9, revealedSafeCount: 1, flagsPlaced: 0 },
      }),
    );
    expect(badStats.message).toContain('durationMs');
  });

  it('rejects wrongly typed nullable fields', () => {
    const badMatchId = expectFailure(
      validateServerMessage({ ...ROOM_STATE_MESSAGE, matchId: 42 }),
    );
    expect(badMatchId.code).toBe('bad-request');
    expect(badMatchId.message).toContain('matchId');
    expect(validateServerMessage({ ...ROOM_STATE_MESSAGE, matchId: null }).ok).toBe(true);
  });

  it('never mutates the input, even when it is frozen', () => {
    const message = deepFreeze({
      type: 'create',
      requestId: 'req-create',
      protocolVersion: PROTOCOL_VERSION,
      config: { ...CONFIG },
      displayName: 'Ada',
    });
    const before = JSON.stringify(message);

    expect(validateClientMessage(message).ok).toBe(true);
    expect(JSON.stringify(message)).toBe(before);

    const invalid = deepFreeze({ ...ACTION, kind: 'explode' });
    const invalidBefore = JSON.stringify(invalid);
    const result = expectFailure(validateClientMessage(invalid));
    expect(result.code).toBe('bad-request');
    expect(JSON.stringify(invalid)).toBe(invalidBefore);
  });

  it('does not depend on scene or storage globals', () => {
    expect(PROTOCOL_SOURCE).not.toMatch(/\b(?:document|window|localStorage)\b/);
  });
});

describe('online protocol seq and turn gates', () => {
  it('accepts the client sequence that matches the server sequence', () => {
    expect(checkSeq(7, 7)).toEqual({ ok: true, value: 7 });
  });

  it('rejects behind and ahead sequences as stale', () => {
    expect(expectFailure(checkSeq(7, 6))).toMatchObject({
      code: 'stale-state',
      retryable: true,
      currentSeq: 7,
    });
    expect(expectFailure(checkSeq(7, 8)).code).toBe('stale-state');
    expect(expectFailure(checkSeq(7, Number.NaN)).code).toBe('stale-state');
  });

  it('accepts only the current turn id', () => {
    expect(checkTurnId(3, 3)).toEqual({ ok: true, value: 3 });
    expect(expectFailure(checkTurnId(3, 2)).code).toBe('stale-state');
    expect(expectFailure(checkTurnId(3, 4)).code).toBe('stale-state');
  });
});

describe('online protocol action gate', () => {
  it('accepts a fresh action without changing the action or context', () => {
    const context = createContext();
    const actionBefore = JSON.stringify(ACTION);
    const gate = evaluateAction(ACTION, context);

    expect(gate).toEqual({ ok: true, status: 'fresh', action: ACTION });
    expect(JSON.stringify(ACTION)).toBe(actionBefore);
    expect(context.recentActionIds.size).toBe(0);
    expect(context.currentSeq).toBe(ACTION.seq);
  });

  it('treats a repeated actionId as an idempotent retry and does not re-apply it', () => {
    const context = createContext({ recentActionIds: new Set([ACTION.actionId]) });

    expect(classifyActionId(ACTION.actionId, context.recentActionIds)).toBe('duplicate');
    const gate = evaluateAction(ACTION, context);
    expect(gate).toMatchObject({ ok: true, status: 'duplicate' });
    expect(applyIfFresh(ACTION, context)).toEqual([]);
    expect(applyIfFresh(ACTION, createContext())).toEqual([ACTION.actionId]);
  });

  it('checks the duplicate before the sequence so a retry is not reported as stale', () => {
    const context = createContext({
      recentActionIds: new Set([ACTION.actionId]),
      currentSeq: ACTION.seq + 1,
      currentTurnId: ACTION.turnId + 1,
    });
    expect(evaluateAction(ACTION, context)).toMatchObject({ ok: true, status: 'duplicate' });
  });

  it('rejects an action from the player who is not on turn', () => {
    const rejected = expectFailure(evaluateAction(ACTION, createContext({ actorId: 'p2' })));
    expect(rejected).toMatchObject({
      code: 'not-your-turn',
      retryable: false,
      currentSeq: ACTION.seq,
    });
  });

  it('rejects stale sequences and turn ids without consuming a turn', () => {
    const staleSeq = expectFailure(
      evaluateAction(ACTION, createContext({ currentSeq: ACTION.seq + 1 })),
    );
    expect(staleSeq.code).toBe('stale-state');
    expect(staleSeq.currentSeq).toBe(ACTION.seq + 1);

    const staleTurn = expectFailure(
      evaluateAction(ACTION, createContext({ currentTurnId: ACTION.turnId + 1 })),
    );
    expect(staleTurn.code).toBe('stale-state');
    expect(staleTurn.currentSeq).toBe(ACTION.seq);
  });

  it('rejects actions that arrive at or after the deadline', () => {
    const rejected = expectFailure(
      evaluateAction(ACTION, createContext({ nowMs: 10_000, deadlineAt: 10_000 })),
    );
    expect(rejected).toMatchObject({ code: 'deadline-passed', retryable: false });
    expect(evaluateAction(ACTION, createContext({ nowMs: 9_999, deadlineAt: 10_000 })).ok).toBe(
      true,
    );
  });

  it('rejects out-of-bounds and non-integer coordinates without reading the board', () => {
    let cellReads = 0;
    const context: ActionValidationContext = {
      ...createContext(),
      cellState: () => {
        cellReads += 1;
        return 'hidden';
      },
    };

    for (const [row, col] of [
      [-1, 0],
      [0, -1],
      [9, 0],
      [0, 9],
      [1.5, 0],
    ] as const) {
      const rejected = expectFailure(evaluateAction({ ...ACTION, row, col }, context));
      expect(rejected.code).toBe('invalid-action');
    }
    expect(cellReads).toBe(0);
  });

  it('rejects already revealed and already flagged cells', () => {
    const revealed = expectFailure(
      evaluateAction(
        ACTION,
        createContext({}, { [`${ACTION.row},${ACTION.col}`]: 'revealed' }),
      ),
    );
    expect(revealed).toMatchObject({ code: 'invalid-action', retryable: false });
    expect(revealed.message).toContain('revealed');

    const flagged = expectFailure(
      evaluateAction(
        { ...ACTION, kind: 'flag' },
        createContext({}, { [`${ACTION.row},${ACTION.col}`]: 'flagged' }),
      ),
    );
    expect(flagged.code).toBe('invalid-action');
    expect(flagged.message).toContain('flagged');
  });

  it('keeps the shared-interface gate from accepting a duplicate as fresh', () => {
    expect(validateAction(ACTION, createContext()).ok).toBe(true);

    const duplicate = expectFailure(
      validateAction(ACTION, createContext({ recentActionIds: new Set([ACTION.actionId]) })),
    );
    expect(duplicate.code).toBe('stale-state');
    expect(duplicate.message).toContain('cached action_result');

    const notOnTurn = expectFailure(validateAction(ACTION, createContext({ actorId: 'p2' })));
    expect(notOnTurn.code).toBe('not-your-turn');
  });

  it('leaves the action and room facts untouched on rejection', () => {
    const context = createContext({
      currentSeq: ACTION.seq - 1,
      recentActionIds: new Set(['other-action']),
    });
    const actionBefore = JSON.stringify(ACTION);
    const contextBefore = JSON.stringify({
      ...context,
      recentActionIds: [...context.recentActionIds],
    });

    expectFailure(evaluateAction(ACTION, context));

    expect(JSON.stringify(ACTION)).toBe(actionBefore);
    expect(
      JSON.stringify({ ...context, recentActionIds: [...context.recentActionIds] }),
    ).toBe(contextBefore);
  });
});

describe('online protocol validator surface', () => {
  it('exposes the shared validator contract with the same results', () => {
    expect(protocolValidator.validateVersion(PROTOCOL_VERSION)).toEqual({
      ok: true,
      value: PROTOCOL_VERSION,
    });
    expect(protocolValidator.checkSeq(7, 7)).toEqual({ ok: true, value: 7 });
    expect(protocolValidator.checkTurnId(3, 3)).toEqual({ ok: true, value: 3 });
    expect(protocolValidator.classifyActionId('a', new Set(['a']))).toBe('duplicate');
    expect(protocolValidator.classifyActionId('a', new Set())).toBe('fresh');

    const message = protocolValidator.validateMessage(
      { ...JOIN_MESSAGE, roomId: 42 },
      'client-to-server',
    );
    expect(message).toMatchObject({ ok: false, code: 'bad-request' });

    const action = protocolValidator.validateAction(ACTION, createContext());
    expect(action).toMatchObject({ ok: true, value: ACTION });
  });
});

describe('online protocol error construction', () => {
  it('builds an error message from the shared code defaults', () => {
    expect(createProtocolError('bad-request')).toEqual({
      type: 'error',
      requestId: null,
      roomId: null,
      code: 'bad-request',
      message: 'bad request',
      retryable: false,
      currentSeq: null,
    });
  });

  it('keeps the code defaults and applies request facts', () => {
    expect(
      createProtocolError('stale-state', {
        requestId: 'req-1',
        roomId: 'room-1',
        currentSeq: 9,
      }),
    ).toEqual({
      type: 'error',
      requestId: 'req-1',
      roomId: 'room-1',
      code: 'stale-state',
      message: 'stale state; resync and retry',
      retryable: true,
      currentSeq: 9,
    });
  });

  it('allows explicit message, retryable and currentSeq overrides', () => {
    expect(
      createProtocolError('invalid-action', {
        message: 'cell already revealed',
        retryable: true,
        currentSeq: 4,
      }),
    ).toMatchObject({
      message: 'cell already revealed',
      retryable: true,
      currentSeq: 4,
    });
  });

  it('converts a validation rejection into a wire error message', () => {
    const rejected = expectFailure(
      validateClientMessage({ ...JOIN_MESSAGE, roomId: 42 }),
    );
    expect(protocolErrorFromResult(rejected, { requestId: 'req-join' })).toEqual({
      type: 'error',
      requestId: 'req-join',
      roomId: null,
      code: 'bad-request',
      message: rejected.message,
      retryable: false,
      currentSeq: null,
    });
  });

  it('reports the current sequence for stale action rejections', () => {
    const rejected = expectFailure(
      evaluateAction(ACTION, createContext({ currentSeq: ACTION.seq + 1 })),
    );
    const wireError = protocolErrorFromResult(rejected, {
      requestId: 'req-action',
      roomId: ACTION.roomId,
    });
    expect(wireError).toMatchObject({
      code: 'stale-state',
      retryable: true,
      currentSeq: ACTION.seq + 1,
    });
  });

  it('round-trips every shared error code through the wire validator', () => {
    for (const code of SHARED_ERROR_CODES) {
      const result = validateServerMessage(createProtocolError(code));
      expect(result.ok, code).toBe(true);
    }
  });
});

describe('online protocol error codes', () => {
  it('covers every shared error code in the defaults', () => {
    for (const code of SHARED_ERROR_CODES) {
      const error = createProtocolError(code);
      expect(error.type).toBe('error');
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(0);
      expect(typeof error.retryable).toBe('boolean');
    }
  });
});
