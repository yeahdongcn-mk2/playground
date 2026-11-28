import { describe, expect, it } from 'vitest';
import {
  publicRoomState,
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
  type ActionMessage,
  type CreateMessage,
  type EndMessage,
  type JoinMessage,
  type ReadyMessage,
  type RematchMessage,
  type RoomStateMessage,
  type StartMessage,
} from '../../src/games/minesweeper/online/index';
import type {
  MinesweeperCell,
  MinesweeperConfig,
} from '../../src/games/minesweeper/engine';

// This suite is the room-layer contract for #554 t1: the manager, not the
// match state machine, owns the best-of-three bookkeeping. Every assertion
// drives the real manager through `ready → playing → finished → ready`; the
// series is only read from the returned `room_state`, so a scoring or
// first-mover bug in `server/room/room-manager.ts` fails here instead of in
// the e2e spec.

type WireSeries = NonNullable<RoomStateMessage['series']>;

const NOW = 1_700_000_000_000;
/**
 * Deterministic 9×9 board with a dense mine field.
 *
 * The high mine count keeps a first reveal from flooding the whole board, so
 * the mine-hit ending below is deterministic instead of a rare all-safe win.
 */
const CONFIG: MinesweeperConfig = {
  rows: 9,
  cols: 9,
  mines: 35,
  firstClickSafe: true,
};
const FIXED_SEED = 202_411_028;

let connectionSeq = 0;

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

function joinMessage(
  roomId: string,
  overrides: Partial<JoinMessage> = {},
): JoinMessage {
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

function rematchMessage(roomId: string, accept = true): RematchMessage {
  return { type: 'rematch', roomId, requestId: 'req_rematch', accept };
}

/** Manager plus a mutable clock, so deadline tests never really wait. */
interface Harness {
  readonly manager: InMemoryRoomManager;
  readonly clock: { now: number };
}

function makeHarness(options: RoomManagerOptions = {}): Harness {
  const clock = { now: NOW };
  return {
    manager: createRoomManager({
      now: () => clock.now,
      createSeed: () => FIXED_SEED,
      ...options,
    }),
    clock,
  };
}

interface SeatedRoom extends Harness {
  readonly roomId: string;
  readonly hostToken: string;
  readonly guestToken: string;
}

/** create → join → both ready: the state `start` accepts. */
function readyRoom(options: RoomManagerOptions = {}): SeatedRoom {
  const harness = makeHarness(options);
  const created = expectOk(
    harness.manager.create(connection(), createMessage()),
  );
  const hostToken = created.boundToken;
  if (hostToken === undefined) {
    throw new Error('create must bind the host token');
  }
  const roomId = roomStatesOf(created)[0]?.roomId;
  if (roomId === undefined) {
    throw new Error('create must deliver a room_state');
  }

  const joined = expectOk(
    harness.manager.join(connection(), joinMessage(roomId)),
  );
  const guestToken = joined.boundToken;
  if (guestToken === undefined) {
    throw new Error('join must bind the guest token');
  }
  expectOk(
    harness.manager.ready(connection(hostToken), readyMessage(roomId, true)),
  );
  expectOk(
    harness.manager.ready(connection(guestToken), readyMessage(roomId, true)),
  );
  expect(harness.manager.getRoom(roomId)?.state).toBe('ready');
  return { ...harness, roomId, hostToken, guestToken };
}

function expectOk(result: RoomCommandResult): RoomCommandSuccess;
function expectOk(
  result: MatchCommandResult,
): Extract<MatchCommandResult, { readonly ok: true }>;
function expectOk(
  result: RoomCommandResult | MatchCommandResult,
):
  | RoomCommandSuccess
  | Extract<MatchCommandResult, { readonly ok: true }> {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.code}: ${result.error.message}`);
  }
  return result;
}

function expectRejected(
  result: RoomCommandResult | MatchCommandResult,
  code: string,
): void {
  expect(result.ok, `expected rejection ${code}`).toBe(false);
  if (result.ok) {
    throw new Error(`expected rejection ${code}`);
  }
  expect(result.code).toBe(code);
}

function deliveriesOf(
  result: RoomCommandResult | MatchCommandResult,
): RoomCommandSuccess['deliveries'] {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.code}: ${result.error.message}`);
  }
  return result.deliveries;
}

function roomStatesOf(
  result: RoomCommandResult | MatchCommandResult,
): RoomStateMessage[] {
  return deliveriesOf(result).flatMap((delivery) =>
    delivery.message.type === 'room_state' ? [delivery.message] : [],
  );
}

function endOf(
  result: RoomCommandResult | MatchCommandResult,
): EndMessage | undefined {
  for (const delivery of deliveriesOf(result)) {
    if (delivery.message.type === 'end') {
      return delivery.message;
    }
  }
  return undefined;
}

/** Start the room's current round and return its authoritative match. */
function startRound(room: SeatedRoom): RoomMatch {
  expectOk(
    room.manager.start(connection(room.hostToken), startMessage(room.roomId)),
  );
  return matchOf(room.manager, room.roomId);
}

function matchOf(
  manager: InMemoryRoomManager,
  roomId: string,
): RoomMatch {
  const match = manager.getMatch(roomId);
  if (match === null) {
    throw new Error(`room ${roomId} has no match`);
  }
  return match;
}

/** The room's published series; a started room always has one. */
function seriesOf(
  manager: InMemoryRoomManager,
  roomId: string,
): WireSeries {
  const series = manager.getRoom(roomId)?.series;
  if (series === undefined) {
    throw new Error(`room ${roomId} has no series`);
  }
  return series;
}

/** Every delivered `room_state` copy carries the given series. */
function expectPublishedSeries(
  result: RoomCommandResult | MatchCommandResult,
  expected: WireSeries,
): void {
  const states = roomStatesOf(result);
  expect(states.length).toBeGreaterThan(0);
  for (const state of states) {
    expect(state.series).toEqual(expected);
  }
}

function seatIds(
  manager: InMemoryRoomManager,
  roomId: string,
): { readonly hostId: string; readonly guestId: string } {
  const seats = manager.getRoom(roomId)?.seats ?? [];
  const host = seats.find((seat) => seat.isHost);
  const guest = seats.find((seat) => !seat.isHost);
  if (host === undefined || guest === undefined) {
    throw new Error(`room ${roomId} does not have two seats`);
  }
  return { hostId: host.playerId, guestId: guest.playerId };
}

interface ActionOverrides {
  readonly actionId?: string;
  readonly row?: number;
  readonly col?: number;
}

/** Build a reveal against the room's current seq/turn. */
function actionFor(
  manager: InMemoryRoomManager,
  roomId: string,
  overrides: ActionOverrides = {},
): ActionMessage {
  const room = manager.getRoom(roomId);
  if (room === undefined || room.matchId === null) {
    throw new Error(`room ${roomId} has no running match`);
  }
  const match = matchOf(manager, roomId);
  return {
    type: 'action',
    roomId,
    matchId: match.matchId,
    actionId: `action_${room.seq + 1}`,
    seq: room.seq,
    turnId: match.state.turnId,
    kind: 'reveal',
    row: 0,
    col: 0,
    clientTimeMs: NOW,
    ...overrides,
  };
}

function hiddenCells(
  manager: InMemoryRoomManager,
  roomId: string,
  predicate: (cell: MinesweeperCell) => boolean,
): MinesweeperCell[] {
  return matchOf(manager, roomId)
    .state.engine.state.board.flat()
    .filter((cell) => !cell.revealed && !cell.flagged && predicate(cell));
}

/** First hidden cell the server board marks as safe; a non-mine reveal target. */
function firstHiddenSafe(
  manager: InMemoryRoomManager,
  roomId: string,
): MinesweeperCell {
  const cell = hiddenCells(manager, roomId, (candidate) => !candidate.mine)[0];
  if (cell === undefined) {
    throw new Error('expected a hidden safe cell');
  }
  return cell;
}

/** The hidden mine: revealing it ends the match with `mine-hit`. */
function firstHiddenMine(
  manager: InMemoryRoomManager,
  roomId: string,
): MinesweeperCell {
  const cell = hiddenCells(manager, roomId, (candidate) => candidate.mine)[0];
  if (cell === undefined) {
    throw new Error('expected a hidden mine');
  }
  return cell;
}

/** A snapshot of the stored record, for before/after equality checks. */
function recordOf(manager: InMemoryRoomManager, roomId: string): RoomRecord {
  const room = manager.getRoom(roomId);
  if (room === undefined) {
    throw new Error(`room ${roomId} is not in the table`);
  }
  return structuredClone(room);
}

describe('room manager best-of-three series', () => {
  it('scores 1:0, 1:1, 2:1 with first movers host, opponent, host', () => {
    const room = readyRoom();
    const { manager } = room;
    const { hostId, guestId } = seatIds(manager, room.roomId);

    // Round 1: the host opens (seat order does not decide it, the series does).
    const round1 = startRound(room);
    expect(round1.state.turnPlayerId).toBe(hostId);
    expect(manager.getRoom(room.roomId)?.turnPlayerId).toBe(hostId);
    expect(seriesOf(manager, room.roomId)).toMatchObject({
      bestOf: 3,
      winsRequired: 2,
      maxRounds: 3,
      round: 1,
      wins: { [hostId]: 0, [guestId]: 0 },
      firstMoverId: hostId,
      decided: false,
      winnerId: null,
      history: [],
    });

    const forfeit1 = expectOk(
      manager.forfeit(room.roomId, round1.matchId, guestId),
    );
    expect(endOf(forfeit1)).toMatchObject({
      reason: 'forfeit',
      winnerId: hostId,
      loserId: guestId,
    });
    let series = seriesOf(manager, room.roomId);
    expect(series.wins).toEqual({ [hostId]: 1, [guestId]: 0 });
    expect(series.decided).toBe(false);
    expect(series.winnerId).toBeNull();
    expect(series.history).toEqual([
      {
        round: 1,
        matchId: round1.matchId,
        winnerId: hostId,
        loserId: guestId,
        reason: 'forfeit',
        firstMoverId: hostId,
      },
    ]);
    expectPublishedSeries(forfeit1, series);

    // One accept keeps the room finished; the second advances the series.
    const pending = expectOk(
      manager.rematch(
        connection(room.hostToken),
        rematchMessage(room.roomId, true),
      ),
    );
    expect(manager.getRoom(room.roomId)?.state).toBe('finished');
    expect(seriesOf(manager, room.roomId)).toEqual(series);
    expectPublishedSeries(pending, series);

    const round2Ready = expectOk(
      manager.rematch(
        connection(room.guestToken),
        rematchMessage(room.roomId, true),
      ),
    );
    expect(manager.getRoom(room.roomId)?.state).toBe('ready');
    series = seriesOf(manager, room.roomId);
    expect(series).toMatchObject({
      round: 2,
      wins: { [hostId]: 1, [guestId]: 0 },
      firstMoverId: guestId,
      decided: false,
      winnerId: null,
    });
    expect(series.history).toHaveLength(1);
    expectPublishedSeries(round2Ready, series);

    // Round 2: the guest opens. The guest reveals safely, then the host's
    // turn expires, which scores the round for the guest.
    const round2 = startRound(room);
    expect(round2.state.turnPlayerId).toBe(guestId);
    expect(manager.getRoom(room.roomId)?.turnPlayerId).toBe(guestId);
    const safe = firstHiddenSafe(manager, room.roomId);
    expectOk(
      manager.action(
        connection(room.guestToken),
        actionFor(manager, room.roomId, {
          actionId: 'round2-guest-safe',
          row: safe.row,
          col: safe.col,
        }),
      ),
    );
    room.clock.now = matchOf(manager, room.roomId).state.turnDeadlineAt;
    const turnTimeout = expectOk(manager.timeout(room.roomId, 'turn'));
    expect(endOf(turnTimeout)).toMatchObject({
      reason: 'turn-timeout',
      winnerId: guestId,
      loserId: hostId,
    });
    series = seriesOf(manager, room.roomId);
    expect(series.wins).toEqual({ [hostId]: 1, [guestId]: 1 });
    expect(series.decided).toBe(false);
    expect(series.history[1]).toEqual({
      round: 2,
      matchId: matchOf(manager, room.roomId).matchId,
      winnerId: guestId,
      loserId: hostId,
      reason: 'turn-timeout',
      firstMoverId: guestId,
    });
    expectPublishedSeries(turnTimeout, series);

    // Both accept again: round 3 goes back to the host.
    expectOk(
      manager.rematch(
        connection(room.hostToken),
        rematchMessage(room.roomId, true),
      ),
    );
    expectOk(
      manager.rematch(
        connection(room.guestToken),
        rematchMessage(room.roomId, true),
      ),
    );
    series = seriesOf(manager, room.roomId);
    expect(series).toMatchObject({
      round: 3,
      wins: { [hostId]: 1, [guestId]: 1 },
      firstMoverId: hostId,
      decided: false,
    });

    // Round 3: the host opens, the guest hits the mine and the host takes 2:1.
    const round3 = startRound(room);
    expect(round3.state.turnPlayerId).toBe(hostId);
    const opening = firstHiddenSafe(manager, room.roomId);
    expectOk(
      manager.action(
        connection(room.hostToken),
        actionFor(manager, room.roomId, {
          actionId: 'round3-host-open',
          row: opening.row,
          col: opening.col,
        }),
      ),
    );
    const mine = firstHiddenMine(manager, room.roomId);
    const mineHit = expectOk(
      manager.action(
        connection(room.guestToken),
        actionFor(manager, room.roomId, {
          actionId: 'round3-guest-mine',
          row: mine.row,
          col: mine.col,
        }),
      ),
    );
    expect(endOf(mineHit)).toMatchObject({
      reason: 'mine-hit',
      winnerId: hostId,
      loserId: guestId,
    });

    series = seriesOf(manager, room.roomId);
    expect(series.wins).toEqual({ [hostId]: 2, [guestId]: 1 });
    expect(series.round).toBe(3);
    expect(series.decided).toBe(true);
    expect(series.winnerId).toBe(hostId);
    expect(series.history.map((entry) => entry.round)).toEqual([1, 2, 3]);
    expect(series.history.map((entry) => entry.firstMoverId)).toEqual([
      hostId,
      guestId,
      hostId,
    ]);
    expect(series.history.map((entry) => entry.winnerId)).toEqual([
      hostId,
      guestId,
      hostId,
    ]);
    expect(series.history.map((entry) => entry.reason)).toEqual([
      'forfeit',
      'turn-timeout',
      'mine-hit',
    ]);
    expectPublishedSeries(mineHit, series);

    // Decided: the rematch starts a fresh series at 0:0 / round 1 / host first.
    expectOk(
      manager.rematch(
        connection(room.hostToken),
        rematchMessage(room.roomId, true),
      ),
    );
    const reset = expectOk(
      manager.rematch(
        connection(room.guestToken),
        rematchMessage(room.roomId, true),
      ),
    );
    expect(manager.getRoom(room.roomId)?.state).toBe('ready');
    series = seriesOf(manager, room.roomId);
    expect(series).toEqual({
      bestOf: 3,
      winsRequired: 2,
      maxRounds: 3,
      round: 1,
      wins: { [hostId]: 0, [guestId]: 0 },
      firstMoverId: hostId,
      decided: false,
      winnerId: null,
      history: [],
    });
    expectPublishedSeries(reset, series);

    const restart = startRound(room);
    expect(restart.state.turnPlayerId).toBe(hostId);
  });

  it('records drawn rounds in history only and ends an exhausted series without a winner', () => {
    const room = readyRoom();
    const { manager } = room;
    const { hostId, guestId } = seatIds(manager, room.roomId);

    // Round 1 ends as a match-timeout draw: nothing is scored.
    const round1 = startRound(room);
    room.clock.now = round1.state.matchDeadlineAt;
    const draw1 = expectOk(manager.timeout(room.roomId, 'match'));
    expect(endOf(draw1)).toMatchObject({
      reason: 'match-timeout',
      winnerId: null,
      loserId: null,
    });
    let series = seriesOf(manager, room.roomId);
    expect(series.wins).toEqual({ [hostId]: 0, [guestId]: 0 });
    expect(series.decided).toBe(false);
    expect(series.history).toEqual([
      {
        round: 1,
        matchId: round1.matchId,
        winnerId: null,
        loserId: null,
        reason: 'match-timeout',
        firstMoverId: hostId,
      },
    ]);

    // The rematch still advances to round 2 because the series is undecided.
    expectOk(
      manager.rematch(
        connection(room.hostToken),
        rematchMessage(room.roomId, true),
      ),
    );
    expectOk(
      manager.rematch(
        connection(room.guestToken),
        rematchMessage(room.roomId, true),
      ),
    );
    series = seriesOf(manager, room.roomId);
    expect(series).toMatchObject({
      round: 2,
      wins: { [hostId]: 0, [guestId]: 0 },
      firstMoverId: guestId,
      decided: false,
    });

    // Round 2: the host forfeits, so the guest leads 1:0.
    const round2 = startRound(room);
    expect(round2.state.turnPlayerId).toBe(guestId);
    expectOk(manager.forfeit(room.roomId, round2.matchId, hostId));
    series = seriesOf(manager, room.roomId);
    expect(series.wins).toEqual({ [hostId]: 0, [guestId]: 1 });
    expect(series.decided).toBe(false);

    expectOk(
      manager.rematch(
        connection(room.hostToken),
        rematchMessage(room.roomId, true),
      ),
    );
    expectOk(
      manager.rematch(
        connection(room.guestToken),
        rematchMessage(room.roomId, true),
      ),
    );
    series = seriesOf(manager, room.roomId);
    expect(series).toMatchObject({
      round: 3,
      wins: { [hostId]: 0, [guestId]: 1 },
      firstMoverId: hostId,
    });

    // Round 3 draws as well: the round cap decides without a two-win seat.
    const round3 = startRound(room);
    expect(round3.state.turnPlayerId).toBe(hostId);
    room.clock.now = round3.state.matchDeadlineAt;
    const draw3 = expectOk(manager.timeout(room.roomId, 'match'));
    expect(endOf(draw3)).toMatchObject({ winnerId: null, loserId: null });
    series = seriesOf(manager, room.roomId);
    expect(series.round).toBe(3);
    expect(series.wins).toEqual({ [hostId]: 0, [guestId]: 1 });
    expect(series.decided).toBe(true);
    expect(series.winnerId).toBeNull();
    expect(series.history.map((entry) => entry.round)).toEqual([1, 2, 3]);
    expect(series.history.map((entry) => entry.winnerId)).toEqual([
      null,
      guestId,
      null,
    ]);
    expect(series.history.map((entry) => entry.loserId)).toEqual([
      null,
      hostId,
      null,
    ]);
    expect(series.history.map((entry) => entry.firstMoverId)).toEqual([
      hostId,
      guestId,
      hostId,
    ]);

    // A capped series is decided even without a winner, so rematch resets it.
    expectOk(
      manager.rematch(
        connection(room.hostToken),
        rematchMessage(room.roomId, true),
      ),
    );
    expectOk(
      manager.rematch(
        connection(room.guestToken),
        rematchMessage(room.roomId, true),
      ),
    );
    series = seriesOf(manager, room.roomId);
    expect(series).toEqual({
      bestOf: 3,
      winsRequired: 2,
      maxRounds: 3,
      round: 1,
      wins: { [hostId]: 0, [guestId]: 0 },
      firstMoverId: hostId,
      decided: false,
      winnerId: null,
      history: [],
    });
  });

  it('scores forfeit, turn-timeout and match-timeout once and rejects a second ending', () => {
    const forfeited = readyRoom();
    const forfeitIds = seatIds(forfeited.manager, forfeited.roomId);
    const round = startRound(forfeited);
    expectOk(
      forfeited.manager.forfeit(forfeited.roomId, round.matchId, forfeitIds.guestId),
    );
    const forfeitSeries = seriesOf(forfeited.manager, forfeited.roomId);
    expect(forfeitSeries.history).toHaveLength(1);
    expect(forfeitSeries.wins).toEqual({ [forfeitIds.hostId]: 1, [forfeitIds.guestId]: 0 });
    const forfeitBefore = recordOf(forfeited.manager, forfeited.roomId);
    expectRejected(
      forfeited.manager.forfeit(forfeited.roomId, round.matchId, forfeitIds.guestId),
      'invalid-action',
    );
    expectRejected(
      forfeited.manager.timeout(forfeited.roomId, 'turn'),
      'invalid-state',
    );
    expect(seriesOf(forfeited.manager, forfeited.roomId)).toEqual(forfeitSeries);
    expect(recordOf(forfeited.manager, forfeited.roomId)).toEqual(forfeitBefore);

    const turned = readyRoom();
    const turnIds = seatIds(turned.manager, turned.roomId);
    const turnRound = startRound(turned);
    turned.clock.now = turnRound.state.turnDeadlineAt;
    expectOk(turned.manager.timeout(turned.roomId, 'turn'));
    const turnSeries = seriesOf(turned.manager, turned.roomId);
    expect(turnSeries.history).toHaveLength(1);
    // `turn-timeout` forfeits the player whose turn it is: the host opened
    // round 1, so the host loses it.
    expect(turnSeries.history[0]).toMatchObject({
      round: 1,
      winnerId: turnIds.guestId,
      loserId: turnIds.hostId,
      reason: 'turn-timeout',
    });
    expectRejected(
      turned.manager.timeout(turned.roomId, 'turn'),
      'invalid-state',
    );
    expect(seriesOf(turned.manager, turned.roomId)).toEqual(turnSeries);

    const timedOut = readyRoom();
    const matchIds = seatIds(timedOut.manager, timedOut.roomId);
    const matchRound = startRound(timedOut);
    timedOut.clock.now = matchRound.state.matchDeadlineAt;
    expectOk(timedOut.manager.timeout(timedOut.roomId, 'match'));
    const matchSeries = seriesOf(timedOut.manager, timedOut.roomId);
    expect(matchSeries.history).toHaveLength(1);
    expect(matchSeries.history[0]).toMatchObject({
      round: 1,
      matchId: matchRound.matchId,
      winnerId: null,
      loserId: null,
      reason: 'match-timeout',
      firstMoverId: matchIds.hostId,
    });
    expectRejected(
      timedOut.manager.timeout(timedOut.roomId, 'match'),
      'invalid-state',
    );
    expect(seriesOf(timedOut.manager, timedOut.roomId)).toEqual(matchSeries);
  });

  it('keeps the score when a rematch is declined and clears the stale votes', () => {
    const room = readyRoom();
    const { manager } = room;
    const { hostId, guestId } = seatIds(manager, room.roomId);

    const round1 = startRound(room);
    expectOk(manager.forfeit(room.roomId, round1.matchId, guestId));
    const scored = seriesOf(manager, room.roomId);
    expect(scored.wins).toEqual({ [hostId]: 1, [guestId]: 0 });

    // One accept is pending; a decline cancels it without touching the score.
    expectOk(
      manager.rematch(
        connection(room.hostToken),
        rematchMessage(room.roomId, true),
      ),
    );
    const declined = expectOk(
      manager.rematch(
        connection(room.guestToken),
        rematchMessage(room.roomId, false),
      ),
    );
    expect(manager.getRoom(room.roomId)?.state).toBe('finished');
    expect(manager.getRoom(room.roomId)?.stateReason).toBe('rematch-declined');
    expect(seriesOf(manager, room.roomId)).toEqual(scored);
    expectPublishedSeries(declined, scored);

    // The decline cleared the old vote: one new accept must not start round 2.
    expectOk(
      manager.rematch(
        connection(room.hostToken),
        rematchMessage(room.roomId, true),
      ),
    );
    expect(manager.getRoom(room.roomId)?.state).toBe('finished');
    expect(seriesOf(manager, room.roomId)).toEqual(scored);

    // Both accept: the undecided series advances, keeping the 1:0 score.
    expectOk(
      manager.rematch(
        connection(room.guestToken),
        rematchMessage(room.roomId, true),
      ),
    );
    expect(manager.getRoom(room.roomId)?.state).toBe('ready');
    expect(seriesOf(manager, room.roomId)).toMatchObject({
      round: 2,
      wins: { [hostId]: 1, [guestId]: 0 },
      firstMoverId: guestId,
      decided: false,
    });
  });

  it('publishes the same public series on room_state, reconnect and resend without seed or board', () => {
    const room = readyRoom();
    const { manager } = room;
    const { hostId, guestId } = seatIds(manager, room.roomId);

    const round1 = startRound(room);
    const finished = expectOk(
      manager.forfeit(room.roomId, round1.matchId, guestId),
    );
    const stored = seriesOf(manager, room.roomId);
    expect(stored.wins).toEqual({ [hostId]: 1, [guestId]: 0 });
    expectPublishedSeries(finished, stored);

    // The public projection carries the series but no match secret or board.
    const record = recordOf(manager, room.roomId);
    const projected = publicRoomState(record);
    expect(projected.series).toEqual(stored);
    const seriesJson = JSON.stringify(projected.series);
    expect(seriesJson).not.toMatch(/seed|seedHash|board|mineLayout|minePositions/i);
    expect(seriesJson).not.toContain('finalSnapshot');
    const roomJson = JSON.stringify(projected);
    expect(roomJson).not.toMatch(/"(seed|seedHash|board|mineLayout|minePositions)"/);

    // A reconnect's room_state re-sends that exact series, and a retried
    // resume returns the same value without moving the score.
    const resume = expectOk(
      manager.join(
        connection(),
        joinMessage(room.roomId, { playerToken: room.guestToken }),
      ),
    );
    const resumedStates = roomStatesOf(resume);
    expect(resumedStates).toHaveLength(1);
    expect(resumedStates[0]?.series).toEqual(stored);
    expect(deliveriesOf(resume).map((delivery) => delivery.message.type)).toEqual([
      'room_state',
      'end',
    ]);

    const resent = expectOk(
      manager.join(
        connection(room.guestToken),
        joinMessage(room.roomId),
      ),
    );
    expect(roomStatesOf(resent)[0]?.series).toEqual(stored);
    expect(recordOf(manager, room.roomId)).toEqual(record);

    // A playing reconnect carries the same series alongside the snapshot of
    // the round that is already under way.
    expectOk(
      manager.rematch(
        connection(room.hostToken),
        rematchMessage(room.roomId, true),
      ),
    );
    expectOk(
      manager.rematch(
        connection(room.guestToken),
        rematchMessage(room.roomId, true),
      ),
    );
    const round2 = startRound(room);
    expect(round2.state.turnPlayerId).toBe(guestId);
    const playing = seriesOf(manager, room.roomId);
    expect(playing).toMatchObject({
      round: 2,
      wins: { [hostId]: 1, [guestId]: 0 },
      firstMoverId: guestId,
      decided: false,
    });
    const playingResume = expectOk(
      manager.join(
        connection(),
        joinMessage(room.roomId, { playerToken: room.guestToken }),
      ),
    );
    expect(
      deliveriesOf(playingResume).map((delivery) => delivery.message.type),
    ).toEqual(['room_state', 'snapshot']);
    expect(roomStatesOf(playingResume)[0]?.series).toEqual(playing);
  });
});
