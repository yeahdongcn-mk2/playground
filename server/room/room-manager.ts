/**
 * In-memory room table and lifecycle state machine for the online Minesweeper
 * room service (issue #483, design section 3).
 *
 * The table is intentionally a plain `Map` in one Node process:
 *
 * - every command is synchronous and applies completely before the next one,
 *   which is the single serial event queue the design asks for; there are no
 *   locks, worker threads, files or database backends;
 * - a room record is immutable, so a rejected command cannot leave a
 *   half-applied update behind;
 * - `dissolve` and the `join` timeout remove the record, and a fresh manager
 *   instance starts with an empty map. A room from an earlier process is
 *   therefore indistinguishable from an unknown room (`room-not-found`);
 * - seat tokens stay server-side. `roomStateDeliveries` is the only place a
 *   token is attached to a message, so a seat never receives another seat's
 *   token.
 *
 * The manager owns room lifecycle, seating and the authoritative match table
 * (#484). `start` builds one immutable match state from `server/room/match.ts`
 * and stores it next to the room; `action` proves the caller owns the current
 * turn and delegates every rule (seq/turnId, deadline, bounds, cell state,
 * idempotency, verdicts) to that state machine. `forfeit` and
 * {@link InMemoryRoomManager.finishMatch} provide the server-internal endings.
 * Turn/match timer *scheduling* is deliberately absent: #485 owns the timers,
 * while this manager exposes the deadlines and the `join` timeout only.
 *
 * The best-of-three series (#554 t1) rides on the room record: `start` creates
 * it or reuses its `firstMoverId`, every end path scores one round through
 * {@link InMemoryRoomManager.finishMatch}, and `rematch` advances or resets it.
 * `contracts.ts` projects the stored value unchanged into `room_state`.
 */

import { randomInt, randomUUID } from 'node:crypto';
import {
  JOIN_TIMEOUT_MS,
  MATCH_TIMEOUT_MS,
  ROOM_CAPACITY,
  TURN_TIMEOUT_MS,
  broadcastToSeats,
  createRoomId,
  issuePlayerToken,
  roomErrorMessage,
  roomStateDeliveries,
  seatedCommandSuccess,
  type MatchCommandResult,
  type MatchRoomManager,
  type PlayerId,
  type PlayerToken,
  type PresenceRoomManager,
  type RoomCommandFailure,
  type RoomCommandResult,
  type RoomConnection,
  type RoomDelivery,
  type RoomErrorCode,
  type RoomId,
  type RoomRecord,
  type RoomSeat,
} from './contracts';
import {
  PROTOCOL_VERSION,
  createProtocolError,
  protocolErrorFromResult,
  type ActionMessage,
  type CreateMessage,
  type EngineMatch,
  type JoinMessage,
  type LeaveMessage,
  type MatchEndReason,
  type PlayerPresence,
  type ProtocolErrorCode,
  type ProtocolValidationFailure,
  type ReadyMessage,
  type RematchMessage,
  type ReplayDigest,
  type ReplayRecord,
  type RoomClosedMessage,
  type RoomState,
  type StartMessage,
  type TimeoutMessage,
  type TimeoutTimer,
} from '../../src/games/minesweeper/online/index';
import {
  validateConfig,
  type MinesweeperConfig,
} from '../../src/games/minesweeper/engine';
import {
  applyMatchAction,
  createMatchState,
  forfeitMatch,
  matchReplayRecord,
  matchTimeout,
  toActionResultMessage,
  toEndMessage,
  toSnapshotMessage,
  type MatchEnd,
  type MatchState,
} from './match';
import {
  advanceSeries,
  createSeries,
  recordSeriesRound,
  resetSeries,
  type SeriesPlayers,
} from './series';

/** Runtime handle for the authoritative match owned by the room. */
export interface RoomMatch {
  readonly matchId: string;
  readonly seed: number;
  readonly engine: EngineMatch;
  /** Full match bookkeeping: seq, turn, deadlines, replay log and verdict. */
  readonly state: MatchState;
}

/** Constructor hooks used by the transport and tests. */
export interface RoomManagerOptions {
  /** Clock used for every deadline; defaults to `Date.now`. */
  readonly now?: () => number;
  /** `join` window in milliseconds; defaults to the design's 120 s. */
  readonly joinTimeoutMs?: number;
  /** Turn window in milliseconds; defaults to the design's 30 s. */
  readonly turnTimeoutMs?: number;
  /** Whole-match window in milliseconds; defaults to the design's 900 s. */
  readonly matchTimeoutMs?: number;
  /** Seed source for a new match; defaults to 32 bits from `node:crypto`. */
  readonly createSeed?: () => number;
}

/** One table row: the public record plus server-only match state. */
interface RoomEntry {
  readonly record: RoomRecord;
  readonly match: RoomMatch | null;
  readonly rematchVotes: ReadonlySet<PlayerId>;
}

/** Fields a lifecycle transition may replace; identity, config and seq are fixed. */
type RoomPatch = Partial<
  Omit<RoomRecord, 'roomId' | 'config' | 'capacity' | 'hostId' | 'seq'>
>;

/** Minimal request facts carried by a rejection. */
interface RequestRef {
  readonly requestId?: string | null;
  readonly roomId?: string | null;
}

/** 32-bit unsigned seed from the platform CSPRNG. */
function randomSeed(): number {
  return randomInt(0, 0x1_0000_0000);
}

/** Opaque public player id; it carries no token or room information. */
function createPlayerId(): PlayerId {
  return `player_${randomUUID()}`;
}

/**
 * Trim a display name and reject an empty one.
 *
 * The transport already validates the wire shape; this guard keeps the room
 * table clean when a caller invokes the manager directly in tests.
 */
function normalizeDisplayName(value: string): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Normalize a human-readable state reason and never broadcast an empty one. */
function normalizeReason(value: string, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

/** Build the unified rejection without touching the table. */
function reject(
  code: RoomErrorCode,
  request: RequestRef,
  room: RoomRecord | null = null,
): RoomCommandFailure {
  return {
    ok: false,
    code,
    error: roomErrorMessage(code, {
      requestId: request.requestId ?? null,
      roomId: room?.roomId ?? request.roomId ?? null,
      currentSeq: room?.seq ?? null,
    }),
  };
}

/**
 * Build a match-layer rejection without touching the table.
 *
 * Match failures use the shared protocol codes (the same ones
 * `evaluateAction` returns), never the internal room codes, so the transport
 * can forward the error unchanged.
 */
function rejectMatch(
  code: ProtocolErrorCode,
  roomId: RoomId | null,
  currentSeq: number | null,
  message: string,
): Extract<MatchCommandResult, { readonly ok: false }> {
  return {
    ok: false,
    code,
    error: createProtocolError(code, { roomId, currentSeq, message }),
  };
}

/** Fold one `evaluateAction`/`forfeitMatch` rejection into a match failure. */
function rejectGate(
  failure: ProtocolValidationFailure,
  roomId: RoomId | null,
): Extract<MatchCommandResult, { readonly ok: false }> {
  return {
    ok: false,
    code: failure.code,
    error: protocolErrorFromResult(failure, { roomId }),
  };
}

/** Replace a room record and bump the broadcast sequence. */
function withSeq(room: RoomRecord, patch: RoomPatch): RoomRecord {
  return { ...room, ...patch, seq: room.seq + 1 };
}

/** Seat owning a token, or null for an absent/unknown token. */
function findSeatByToken(room: RoomRecord, token: PlayerToken | null): RoomSeat | null {
  if (token === null) {
    return null;
  }
  return room.seats.find((seat) => seat.playerToken === token) ?? null;
}

/**
 * The two seats of the room's best-of-three series.
 *
 * `start` and a completed `rematch` only run with a full room, so the series
 * helpers can key their wins table and first-mover alternation by these ids.
 * The opponent is derived from the host id so a swapped seat order cannot
 * change who opens the odd rounds.
 */
function seriesPlayersOf(room: RoomRecord): SeriesPlayers {
  const opponent = room.seats.find((seat) => seat.playerId !== room.hostId);
  if (opponent === undefined) {
    throw new Error(`room ${room.roomId} needs two seats for a series`);
  }
  return { hostId: room.hostId, opponentId: opponent.playerId };
}

/** The current `room_state` addressed to one seat only. */
function seatStateDelivery(room: RoomRecord, seat: RoomSeat): RoomDelivery {
  const delivery = roomStateDeliveries(room).find(
    (candidate) => candidate.playerToken === seat.playerToken,
  );
  if (delivery === undefined) {
    throw new Error(`seat ${seat.playerId} is not part of room ${room.roomId}`);
  }
  return delivery;
}

/**
 * In-memory, single-process room table.
 *
 * Every public method follows {@link RoomManager}: a success lists messages to
 * deliver, a failure carries one `error` message and leaves the table exactly
 * as it was.
 */
export class InMemoryRoomManager implements MatchRoomManager, PresenceRoomManager {
  private readonly rooms = new Map<RoomId, RoomEntry>();
  private readonly now: () => number;
  private readonly joinTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly matchTimeoutMs: number;
  private readonly createSeed: () => number;

  constructor(options: RoomManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.joinTimeoutMs = options.joinTimeoutMs ?? JOIN_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
    this.matchTimeoutMs = options.matchTimeoutMs ?? MATCH_TIMEOUT_MS;
    this.createSeed = options.createSeed ?? randomSeed;
  }

  /** Number of live rooms, used by health reporting and tests. */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** Read-only view of one room record; `undefined` once dissolved. */
  getRoom(roomId: RoomId): RoomRecord | undefined {
    return this.rooms.get(roomId)?.record;
  }

  /**
   * Server-side match handle (id, seed, engine), or null before the first
   * start, after a rematch, or once the room is dissolved.
   *
   * A `finished` room keeps its handle until the rematch clears it, so the
   * match layer can still read the final result. The seed and engine are never
   * projected into a wire message here; the match layer decides when to
   * publish the seed and the final board.
   */
  getMatch(roomId: RoomId): RoomMatch | null {
    return this.rooms.get(roomId)?.match ?? null;
  }

  /**
   * Replay input (match id, config, seed and accepted actions) for the match
   * currently held by the room, or null when no match is running/retained.
   *
   * Server-only: the seed must never be sent to a client before `end`.
   */
  getReplayRecord(roomId: RoomId): ReplayRecord | null {
    const match = this.rooms.get(roomId)?.match;
    return match === null || match === undefined ? null : matchReplayRecord(match.state);
  }

  /** Recorded per-step digests of the retained match, in accepted-seq order. */
  getReplayDigests(roomId: RoomId): readonly ReplayDigest[] | null {
    return this.rooms.get(roomId)?.match?.state.digests ?? null;
  }

  /** `idle → waiting`: validate the request, assign a room and seat the host. */
  create(_connection: RoomConnection, message: CreateMessage): RoomCommandResult {
    // The transport validates the wire version with the #482 validator; a
    // direct mismatch folds into bad-request because RoomErrorCode has no
    // unsupported-version member.
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      return reject('bad-request', { requestId: message.requestId });
    }

    let config: Readonly<MinesweeperConfig>;
    try {
      config = validateConfig(message.config);
    } catch {
      return reject('bad-request', { requestId: message.requestId });
    }

    const displayName = normalizeDisplayName(message.displayName);
    if (displayName === null) {
      return reject('bad-request', { requestId: message.requestId });
    }

    const now = this.now();
    let roomId = createRoomId();
    while (this.rooms.has(roomId)) {
      roomId = createRoomId();
    }

    const host: RoomSeat = {
      playerId: createPlayerId(),
      playerToken: issuePlayerToken(),
      displayName,
      ready: false,
      presence: 'online',
      isHost: true,
      joinedAt: now,
    };
    const record: RoomRecord = {
      roomId,
      config,
      capacity: ROOM_CAPACITY,
      state: 'waiting',
      seq: 1,
      hostId: host.playerId,
      seats: [host],
      matchId: null,
      turnPlayerId: null,
      joinDeadlineAt: now + this.joinTimeoutMs,
      deadlineAt: null,
      stateReason: null,
    };

    this.rooms.set(roomId, { record, match: null, rematchVotes: new Set() });
    return seatedCommandSuccess(record, host);
  }

  /** Fill the second seat, or resume a seat with its previously issued token. */
  join(connection: RoomConnection, message: JoinMessage): RoomCommandResult {
    const entry = this.rooms.get(message.roomId);
    if (entry === undefined) {
      return reject('room-not-found', {
        requestId: message.requestId,
        roomId: message.roomId,
      });
    }
    const room = entry.record;

    if (message.protocolVersion !== PROTOCOL_VERSION) {
      return reject('bad-request', { requestId: message.requestId, roomId: room.roomId }, room);
    }

    // The wire contract requires displayName on every join; a resumed seat
    // keeps its stored name and only proves ownership with the token.
    const displayName = normalizeDisplayName(message.displayName);
    if (displayName === null) {
      return reject('bad-request', { requestId: message.requestId, roomId: room.roomId }, room);
    }

    // A reconnect may have no message token yet; the transport can already
    // have bound the seat token to this connection (duplicate/retried join).
    const messageToken = message.playerToken === '' ? null : message.playerToken;
    const resumeToken = messageToken ?? connection.playerToken;
    if (resumeToken !== null) {
      const seat = findSeatByToken(room, resumeToken);
      if (seat === null) {
        return reject('not-in-room', { requestId: message.requestId, roomId: room.roomId }, room);
      }
      return this.resumeSeat(entry, seat);
    }

    if (room.state !== 'waiting') {
      return reject('invalid-state', { requestId: message.requestId, roomId: room.roomId }, room);
    }
    if (room.seats.length >= room.capacity) {
      return reject('room-full', { requestId: message.requestId, roomId: room.roomId }, room);
    }

    const guest: RoomSeat = {
      playerId: createPlayerId(),
      playerToken: issuePlayerToken(),
      displayName,
      ready: false,
      presence: 'online',
      isHost: false,
      joinedAt: this.now(),
    };
    const next = withSeq(room, { seats: [...room.seats, guest], stateReason: 'guest-joined' });
    this.rooms.set(room.roomId, { ...entry, record: next });
    return seatedCommandSuccess(next, guest);
  }

  /** Set or clear readiness; the state flips only when the whole room agrees. */
  ready(connection: RoomConnection, message: ReadyMessage): RoomCommandResult {
    const entry = this.rooms.get(message.roomId);
    if (entry === undefined) {
      return reject('room-not-found', {
        requestId: message.requestId,
        roomId: message.roomId,
      });
    }
    const room = entry.record;
    const seat = findSeatByToken(room, connection.playerToken);
    if (seat === null) {
      return reject('not-in-room', { requestId: message.requestId, roomId: room.roomId }, room);
    }
    if (room.state !== 'waiting' && room.state !== 'ready') {
      return reject('invalid-state', { requestId: message.requestId, roomId: room.roomId }, room);
    }
    if (typeof message.ready !== 'boolean') {
      return reject('bad-request', { requestId: message.requestId, roomId: room.roomId }, room);
    }

    const seats = room.seats.map((current) =>
      current.playerId === seat.playerId ? { ...current, ready: message.ready } : current,
    );
    const allReady = seats.length === room.capacity && seats.every((current) => current.ready);
    const state: RoomState = allReady ? 'ready' : room.state === 'ready' ? 'waiting' : room.state;
    const stateReason =
      state === 'ready'
        ? 'all-ready'
        : state === 'waiting' && room.state === 'ready'
          ? 'unready'
          : room.stateReason;

    const next = withSeq(room, { seats, state, stateReason });
    this.rooms.set(room.roomId, { ...entry, record: next });
    return { ok: true, deliveries: roomStateDeliveries(next) };
  }

  /**
   * `ready → playing`: mint a new matchId and seed, then hold the authoritative
   * match state. The starting `room_state` and the redacted `snapshot` are
   * broadcast to both seats; from here on the match layer owns every action.
   */
  start(connection: RoomConnection, message: StartMessage): RoomCommandResult {
    const entry = this.rooms.get(message.roomId);
    if (entry === undefined) {
      return reject('room-not-found', {
        requestId: message.requestId,
        roomId: message.roomId,
      });
    }
    const room = entry.record;
    const seat = findSeatByToken(room, connection.playerToken);
    if (seat === null) {
      return reject('not-in-room', { requestId: message.requestId, roomId: room.roomId }, room);
    }
    if (!seat.isHost) {
      return reject('not-host', { requestId: message.requestId, roomId: room.roomId }, room);
    }
    if (room.state !== 'ready') {
      return reject('invalid-state', { requestId: message.requestId, roomId: room.roomId }, room);
    }
    // t-start guard (design 3.2): the host may only start while both seats are
    // online. A grace-expired seat is removed or dissolves the room; a
    // reconnect restores `online` before its own start can be accepted.
    if (room.seats.some((current) => current.presence !== 'online')) {
      return reject('invalid-state', { requestId: message.requestId, roomId: room.roomId }, room);
    }
    // `ready` is only set when both seats are full and ready, so the state
    // guard also covers the design's readiness check.

    const now = this.now();
    const matchId = `match_${randomUUID()}`;
    const seed = this.createSeed();
    // The first round creates the series; a later start (after the rematch
    // edge advanced or reset it) reuses the stored value, so the first mover
    // of every round stays server-authoritative across a reconnect.
    const players = seriesPlayersOf(room);
    const series = room.series ?? createSeries(players);
    const matchState = createMatchState({
      matchId,
      // The starting snapshot shares the room_state broadcast sequence: one
      // state change, one seq, so a client can echo either message back.
      initialSeq: room.seq + 1,
      config: room.config,
      seed,
      seats: room.seats.map((current) => ({
        playerId: current.playerId,
        isHost: current.isHost,
      })),
      firstTurnPlayerId: series.firstMoverId,
      nowMs: now,
      turnDurationMs: this.turnTimeoutMs,
      matchDurationMs: this.matchTimeoutMs,
    });
    // `joinDeadlineAt` stays at its lobby value; it is only meaningful while
    // the room is waiting/ready and is reset by rematch.
    const next = withSeq(room, {
      state: 'playing',
      matchId,
      turnPlayerId: matchState.turnPlayerId,
      deadlineAt: matchState.turnDeadlineAt,
      stateReason: 'match-started',
      series,
    });

    this.rooms.set(room.roomId, {
      ...entry,
      record: next,
      match: { matchId, seed, engine: matchState.engine, state: matchState },
    });
    const snapshot = toSnapshotMessage(matchState.snapshot, room.roomId);
    return {
      ok: true,
      deliveries: [...roomStateDeliveries(next), ...broadcastToSeats(next, snapshot)],
    };
  }

  /**
   * Submit one reveal/flag for the current turn (`MatchRoomManager.action`).
   *
   * Admission is the match layer's: the room only proves the caller owns a
   * seat in a playing match with the expected matchId, then hands the action
   * to `applyMatchAction`. A rejection changes neither the room record nor the
   * match state. An accepted action advances the room seq to the match seq,
   * updates the turn and its deadline, and delivers one `action_result` to the
   * actor followed by the `snapshot` broadcast. A duplicate `actionId` returns
   * the cached `action_result` without moving the room. A terminal action
   * additionally broadcasts `end` and moves the room to `finished`.
   */
  action(connection: RoomConnection, message: ActionMessage): MatchCommandResult {
    const entry = this.rooms.get(message.roomId);
    if (entry === undefined) {
      return rejectMatch(
        'room-not-found',
        message.roomId,
        null,
        `room ${message.roomId} is not in the table`,
      );
    }
    const room = entry.record;
    const seat = findSeatByToken(room, connection.playerToken);
    if (seat === null) {
      return rejectMatch(
        'invalid-action',
        room.roomId,
        room.seq,
        'the connection does not own a seat in this room',
      );
    }
    const match = entry.match;
    if (room.state !== 'playing' || match === null) {
      return rejectMatch(
        'invalid-action',
        room.roomId,
        room.seq,
        `room ${room.roomId} has no running match`,
      );
    }
    if (message.matchId !== match.matchId) {
      return rejectMatch(
        'invalid-action',
        room.roomId,
        room.seq,
        `match ${message.matchId} is not the current match ${match.matchId}`,
      );
    }

    const outcome = applyMatchAction(
      match.state,
      seat.playerId,
      {
        actionId: message.actionId,
        seq: message.seq,
        turnId: message.turnId,
        kind: message.kind,
        row: message.row,
        col: message.col,
      },
      this.now(),
    );
    if (!outcome.ok) {
      return rejectGate(outcome, room.roomId);
    }

    if (outcome.status === 'duplicate') {
      // Retry of an already accepted action: replay the cached verdict to the
      // actor only; the room seq/turn and the board stay exactly as they are.
      return {
        ok: true,
        deliveries: [
          {
            playerToken: seat.playerToken,
            message: toActionResultMessage(outcome.actionResult, room.roomId),
          },
        ],
      };
    }

    const nextMatch: RoomMatch = { ...match, state: outcome.state };
    if (outcome.end !== null) {
      // The terminal action shares its advanced seq with `end`: one state
      // change, so finishMatch's seq bump is that same `outcome.state.seq`.
      const ended = this.finishMatch(
        room.roomId,
        match.matchId,
        outcome.end.reason,
        outcome.end,
      );
      if (!ended.ok) {
        return rejectMatch('invalid-action', room.roomId, room.seq, ended.error.message);
      }
      const finishedEntry = this.rooms.get(room.roomId);
      if (finishedEntry === undefined) {
        return rejectMatch('room-not-found', room.roomId, null, 'room disappeared');
      }
      this.rooms.set(room.roomId, { ...finishedEntry, match: nextMatch });
      const finished = finishedEntry.record;
      return {
        ok: true,
        deliveries: [
          {
            playerToken: seat.playerToken,
            message: toActionResultMessage(outcome.actionResult, room.roomId),
          },
          ...broadcastToSeats(finished, toSnapshotMessage(outcome.snapshot, room.roomId)),
          ...broadcastToSeats(finished, toEndMessage(outcome.end, room.roomId)),
          ...ended.deliveries,
        ],
      };
    }

    const nextRecord: RoomRecord = {
      ...room,
      seq: outcome.state.seq,
      turnPlayerId: outcome.state.turnPlayerId,
      deadlineAt: outcome.state.turnDeadlineAt,
    };
    this.rooms.set(room.roomId, { ...entry, record: nextRecord, match: nextMatch });
    return {
      ok: true,
      deliveries: [
        {
          playerToken: seat.playerToken,
          message: toActionResultMessage(outcome.actionResult, room.roomId),
        },
        ...broadcastToSeats(nextRecord, toSnapshotMessage(outcome.snapshot, room.roomId)),
      ],
    };
  }

  /**
   * Server-internal concession (`forfeit`): produce one `end` for both seats,
   * then move the room to `finished` through {@link finishMatch}.
   *
   * No board action is applied and no turn is consumed; the forfeiting player
   * must be seated in the identified match. Called by the room layer itself
   * (for example a host concession command or #485's grace timeout), never by
   * an untrusted wire message here.
   */
  forfeit(roomId: RoomId, matchId: string, playerId: PlayerId): MatchCommandResult {
    const entry = this.rooms.get(roomId);
    if (entry === undefined) {
      return rejectMatch('room-not-found', roomId, null, `room ${roomId} is not in the table`);
    }
    const room = entry.record;
    const match = entry.match;
    if (room.state !== 'playing' || match === null || match.matchId !== matchId) {
      return rejectMatch(
        'invalid-action',
        room.roomId,
        room.seq,
        `match ${matchId} is not the running match in room ${room.roomId}`,
      );
    }

    const outcome = forfeitMatch(match.state, playerId, this.now(), 'forfeit');
    if (!outcome.ok) {
      return rejectGate(outcome, room.roomId);
    }

    const ended = this.finishMatch(room.roomId, matchId, 'forfeit', outcome.end);
    if (!ended.ok) {
      return rejectMatch('invalid-action', room.roomId, room.seq, ended.error.message);
    }
    const finishedEntry = this.rooms.get(room.roomId);
    if (finishedEntry === undefined) {
      return rejectMatch('room-not-found', room.roomId, null, 'room disappeared');
    }
    this.rooms.set(room.roomId, {
      ...finishedEntry,
      match: { ...match, state: outcome.state },
    });
    const finished = finishedEntry.record;
    return {
      ok: true,
      deliveries: [
        ...broadcastToSeats(finished, toEndMessage(outcome.end, room.roomId)),
        ...ended.deliveries,
      ],
    };
  }

  /** Leave a lobby room; losing the host dissolves the room for everyone. */
  leave(connection: RoomConnection, message: LeaveMessage): RoomCommandResult {
    const entry = this.rooms.get(message.roomId);
    if (entry === undefined) {
      return reject('room-not-found', {
        requestId: message.requestId,
        roomId: message.roomId,
      });
    }
    const room = entry.record;
    const seat = findSeatByToken(room, connection.playerToken);
    if (seat === null) {
      return reject('not-in-room', { requestId: message.requestId, roomId: room.roomId }, room);
    }
    if (room.state !== 'waiting' && room.state !== 'ready') {
      // The design only has leave transitions from the lobby. During a match
      // a socket disconnect is presence, not a room event; `finished` rooms
      // are closed by dissolve (host close/server cleanup).
      return reject('invalid-state', { requestId: message.requestId, roomId: room.roomId }, room);
    }
    if (seat.isHost) {
      return this.dissolveEntry(entry, 'host-left');
    }

    const seats = room.seats.filter((current) => current.playerId !== seat.playerId);
    const next = withSeq(room, {
      seats,
      state: room.state === 'ready' ? 'waiting' : room.state,
      stateReason: 'player-left',
    });
    this.rooms.set(room.roomId, { ...entry, record: next });
    return { ok: true, deliveries: roomStateDeliveries(next) };
  }

  /**
   * `finished → ready`: both seats accept, seats are kept, the join window is
   * restarted and the previous match id/seed/engine are cleared.
   *
   * The series follows the design's rematch rule: while it is undecided the
   * next round starts and its first mover alternates; once it is decided
   * (including a `maxRounds` series without a two-win seat) the rematch opens
   * a fresh 0:0 series with the host moving first. A decline leaves the live
   * score untouched.
   */
  rematch(connection: RoomConnection, message: RematchMessage): RoomCommandResult {
    const entry = this.rooms.get(message.roomId);
    if (entry === undefined) {
      return reject('room-not-found', {
        requestId: message.requestId,
        roomId: message.roomId,
      });
    }
    const room = entry.record;
    const seat = findSeatByToken(room, connection.playerToken);
    if (seat === null) {
      return reject('not-in-room', { requestId: message.requestId, roomId: room.roomId }, room);
    }
    if (room.state !== 'finished') {
      return reject('invalid-state', { requestId: message.requestId, roomId: room.roomId }, room);
    }

    const votes = new Set(entry.rematchVotes);
    if (!message.accept) {
      // A decline cancels the whole pending rematch: both seats must accept
      // again, otherwise one stale vote could restart a room the decliner
      // just rejected.
      const next = withSeq(room, { stateReason: 'rematch-declined' });
      this.rooms.set(room.roomId, { ...entry, record: next, rematchVotes: new Set() });
      return { ok: true, deliveries: roomStateDeliveries(next) };
    }

    votes.add(seat.playerId);
    const allVoted = votes.size >= room.seats.length;
    // t-rematch guard (design 3.2): both seats must still be online, not just
    // have voted. An offline vote stays pending and the transition completes
    // only when a later rematch re-checks the guard with everyone back online.
    const allOnline = room.seats.every((current) => current.presence === 'online');
    if (!allVoted || !allOnline) {
      const next = withSeq(room, {
        stateReason: allVoted ? 'rematch-waiting-online' : 'rematch-pending',
      });
      this.rooms.set(room.roomId, { ...entry, record: next, rematchVotes: votes });
      return { ok: true, deliveries: roomStateDeliveries(next) };
    }

    // Both seats accepted and are online: the series either advances to its
    // next round (undecided) or starts over from 0:0/round 1 (decided, even
    // when the round cap produced no winner). A decline returned above, so it
    // never rewrites a live score.
    const players = seriesPlayersOf(room);
    const nextSeries =
      room.series === undefined
        ? undefined
        : room.series.decided
          ? resetSeries(room.series, players)
          : advanceSeries(room.series, players);

    const next = withSeq(room, {
      state: 'ready',
      matchId: null,
      turnPlayerId: null,
      deadlineAt: null,
      joinDeadlineAt: this.now() + this.joinTimeoutMs,
      stateReason: 'rematch',
      ...(nextSeries === undefined ? {} : { series: nextSeries }),
    });
    this.rooms.set(room.roomId, { record: next, match: null, rematchVotes: new Set() });
    return { ok: true, deliveries: roomStateDeliveries(next) };
  }

  /** Destroy a room from any live state and notify every current seat. */
  dissolve(roomId: RoomId, reason: string): RoomCommandResult {
    const entry = this.rooms.get(roomId);
    if (entry === undefined) {
      return reject('room-not-found', { roomId });
    }
    return this.dissolveEntry(entry, normalizeReason(reason, 'dissolved'));
  }

  /**
   * Expire one lifecycle timer.
   *
   * - `join`: dissolve a waiting/ready room exactly once (design 3.4).
   * - `turn`: the current player forfeits; one `timeout(timer=turn)`, one
   *   `end` and one `room_state(finished)` are broadcast.
   * - `match`: the match ends by the per-player safe-cell ranking in
   *   `server/room/match.ts`; a tie is a draw with no winner/loser.
   *
   * Every branch rejects before the deadline so a caller can schedule a timer
   * optimistically without risking an early ending. Once the room is no longer
   * in the timer's state, a repeated call is an `invalid-state` rejection and
   * never produces a second terminal message.
   */
  timeout(roomId: RoomId, timer: TimeoutTimer): RoomCommandResult {
    const entry = this.rooms.get(roomId);
    if (entry === undefined) {
      return reject('room-not-found', { roomId });
    }
    const room = entry.record;
    if (timer === 'join') {
      if (room.state !== 'waiting' && room.state !== 'ready') {
        return reject('invalid-state', { roomId }, room);
      }
      if (this.now() < room.joinDeadlineAt) {
        return reject('deadline-passed', { roomId }, room);
      }

      // `timeout` and `room_closed` are two sequential lifecycle broadcasts,
      // so they consume two consecutive sequence numbers. This is compatible
      // with the equal-seq batch rule documented on `finishByTimer`; once the
      // record is removed no version at N+1 has to be readable.
      const timeout: TimeoutMessage = {
        type: 'timeout',
        roomId: room.roomId,
        matchId: null,
        seq: room.seq + 1,
        timer: 'join',
        subjectId: null,
        deadlineAt: room.joinDeadlineAt,
        resultingState: 'dissolved',
        reason: 'join-timeout',
      };
      const closed: RoomClosedMessage = {
        type: 'room_closed',
        roomId: room.roomId,
        seq: room.seq + 2,
        reason: 'join-timeout',
        finalState: 'dissolved',
      };
      const deliveries = [...broadcastToSeats(room, timeout), ...broadcastToSeats(room, closed)];

      this.rooms.delete(room.roomId);
      return { ok: true, deliveries };
    }

    if (room.state !== 'playing' || entry.match === null) {
      return reject('invalid-state', { roomId }, room);
    }
    const deadline =
      timer === 'turn' ? entry.match.state.turnDeadlineAt : entry.match.state.matchDeadlineAt;
    if (this.now() < deadline) {
      return reject('deadline-passed', { roomId }, room);
    }
    return this.finishByTimer(entry, timer);
  }

  /**
   * Apply one connection-layer presence value to the seat owning a token.
   *
   * Presence is connection state, not a room transition: this method never
   * moves `seq`, `turnId`, a seed or any deadline. The updated `room_state` is
   * delivered to the current seats so both clients see the new presence; a
   * repeated value is idempotent and produces no deliveries.
   */
  setPresence(playerToken: PlayerToken, presence: PlayerPresence): RoomCommandResult {
    if (presence !== 'online' && presence !== 'reconnecting' && presence !== 'offline') {
      return reject('bad-request', {});
    }
    const found = this.findEntryByToken(playerToken);
    if (found === null) {
      return reject('not-in-room', {});
    }
    const { entry, seat } = found;
    if (seat.presence === presence) {
      return { ok: true, deliveries: [] };
    }
    const seats = entry.record.seats.map((current) =>
      current.playerId === seat.playerId ? { ...current, presence } : current,
    );
    // Deliberately not `withSeq`: presence is connection state and must leave
    // the room sequence (and every timer) untouched.
    const next: RoomRecord = { ...entry.record, seats };
    this.rooms.set(next.roomId, { ...entry, record: next });
    return { ok: true, deliveries: roomStateDeliveries(next) };
  }

  /**
   * Resolve a seat whose reconnect grace window has run out (design 5.6).
   *
   * The connection layer calls this only for a seat it has marked `offline`; a
   * call for an online seat is stale (for example reconnect won the race) and
   * changes nothing. Lobby outcomes release a guest seat or dissolve the room
   * for its host; a playing forfeit only happens when it is that player's turn,
   * otherwise the seat is reserved until its turn or the match timer ends.
   */
  graceExpired(playerToken: PlayerToken): RoomCommandResult {
    const found = this.findEntryByToken(playerToken);
    if (found === null) {
      return reject('not-in-room', {});
    }
    const { entry, seat } = found;
    const room = entry.record;
    if (seat.presence !== 'offline') {
      return reject('invalid-state', { roomId: room.roomId }, room);
    }

    if (room.state === 'waiting' || room.state === 'ready') {
      if (seat.isHost) {
        return this.dissolveEntry(entry, 'host-grace-expired');
      }
      const seats = room.seats.filter((current) => current.playerId !== seat.playerId);
      const next = withSeq(room, {
        seats,
        state: room.state === 'ready' ? 'waiting' : room.state,
        stateReason: 'grace-expired',
      });
      this.rooms.set(room.roomId, { ...entry, record: next });
      return { ok: true, deliveries: roomStateDeliveries(next) };
    }

    if (room.state === 'playing') {
      if (room.turnPlayerId !== seat.playerId) {
        // Not this player's turn: keep the seat. The turn timer will forfeit
        // if they are still offline when the turn reaches them, and the match
        // timer remains authoritative either way.
        return { ok: true, deliveries: [] };
      }
      return this.finishByTimer(entry, 'turn');
    }

    // `finished` retains its result until the rematch window closes; a
    // dissolved room has already been removed from the table.
    if (room.state === 'finished') {
      return { ok: true, deliveries: [] };
    }
    return reject('invalid-state', { roomId: room.roomId }, room);
  }

  /**
   * Apply one turn or match ending and publish its single terminal triple.
   *
   * The match layer produces the verdict (`turn-timeout` forfeits the current
   * player, `match-timeout` ranks safe-cell counts), then `finishMatch` records
   * `playing → finished`. `timeout`, `end` and `room_state` all carry the same
   * finished sequence, so a retry cannot produce a second terminal result.
   *
   * Client rule for #486 (the design 4.3 "render seq >= applied" branch of the
   * 4.3/5.4 conflict): treat every message carrying one seq as a batch.
   * Deduplicate repeated copies of the same message type/identity, but do not
   * drop a different message type merely because its seq equals the watermark
   * just advanced — the timeout, end and finished room state all belong to
   * this single terminal transition and all have to reach the UI. The
   * action-terminal path (`action_result`, `snapshot`, `end`, `room_state`)
   * follows the same rule. The "drop seq <= applied" rule of 5.4 only
   * discards a duplicate of a message that was already applied. The
   * join-timeout branch keeps its `timeout` and `room_closed` on consecutive
   * seqs, which also satisfies this rule.
   */
  private finishByTimer(
    entry: RoomEntry,
    timer: 'turn' | 'match',
  ): RoomCommandResult {
    const room = entry.record;
    const match = entry.match;
    if (room.state !== 'playing' || match === null) {
      return reject('invalid-state', { roomId: room.roomId }, room);
    }

    const now = this.now();
    const outcome =
      timer === 'turn'
        ? forfeitMatch(match.state, match.state.turnPlayerId, now, 'turn-timeout')
        : matchTimeout(match.state, now);
    if (!outcome.ok) {
      return reject('invalid-state', { roomId: room.roomId }, room);
    }

    const reason: MatchEndReason = timer === 'turn' ? 'turn-timeout' : 'match-timeout';
    const ended = this.finishMatch(room.roomId, match.matchId, reason, outcome.end);
    if (!ended.ok) {
      return reject('invalid-state', { roomId: room.roomId }, room);
    }
    const finishedEntry = this.rooms.get(room.roomId);
    if (finishedEntry === undefined) {
      return reject('room-not-found', { roomId: room.roomId });
    }
    this.rooms.set(room.roomId, {
      ...finishedEntry,
      match: { ...match, state: outcome.state },
    });
    const finished = finishedEntry.record;
    const timeout: TimeoutMessage = {
      type: 'timeout',
      roomId: room.roomId,
      matchId: match.matchId,
      seq: finished.seq,
      timer,
      subjectId: timer === 'turn' ? match.state.turnPlayerId : null,
      deadlineAt:
        timer === 'turn' ? match.state.turnDeadlineAt : match.state.matchDeadlineAt,
      resultingState: 'finished',
      reason,
    };
    return {
      ok: true,
      deliveries: [
        ...broadcastToSeats(finished, timeout),
        ...broadcastToSeats(finished, toEndMessage(outcome.end, room.roomId, finished.seq)),
        ...ended.deliveries,
      ],
    };
  }

  /** The live seat owning a token, across every room in the table. */
  private findEntryByToken(
    playerToken: PlayerToken,
  ): { readonly entry: RoomEntry; readonly seat: RoomSeat } | null {
    if (typeof playerToken !== 'string' || playerToken.length === 0) {
      return null;
    }
    for (const entry of this.rooms.values()) {
      const seat = findSeatByToken(entry.record, playerToken);
      if (seat !== null) {
        return { entry, seat };
      }
    }
    return null;
  }

  /**
   * Match-layer seam (#484): move `playing → finished` after the verdict and
   * record the round in the room's series.
   *
   * The result payload is built by the match layer; `end` carries the verdict
   * (`winnerId`, `reason`) the series scores, so every end path — an action
   * ending, `forfeit`, `turn-timeout` and `match-timeout` — funnels through
   * here instead of scoring in four places. A drawn `end` (`winnerId: null`)
   * only appends to `history`. `recordSeriesRound` is idempotent per
   * `matchId`, and the room state guard below already makes a second end for
   * the same match impossible. This method only records the terminal state and
   * keeps the match id/engine until `rematch` clears them.
   *
   * `matchId` is checked against the held match so a late timer or a retried
   * end from an earlier match cannot finish the next one. It is not part of
   * the wire `RoomManager` contract.
   */
  finishMatch(
    roomId: RoomId,
    matchId: string,
    reason: MatchEndReason,
    end: MatchEnd | null = null,
  ): RoomCommandResult {
    const entry = this.rooms.get(roomId);
    if (entry === undefined) {
      return reject('room-not-found', { roomId });
    }
    const room = entry.record;
    if (
      room.state !== 'playing' ||
      entry.match === null ||
      entry.match.matchId !== matchId
    ) {
      return reject('invalid-state', { roomId }, room);
    }

    // Score the round before the transition so the same `room_state` that
    // announces `finished` already carries the updated series.
    const series =
      room.series === undefined || end === null
        ? room.series
        : recordSeriesRound(room.series, {
            matchId,
            winnerId: end.winnerId,
            reason: end.reason,
          });

    const next = withSeq(room, {
      state: 'finished',
      turnPlayerId: null,
      deadlineAt: null,
      stateReason: reason,
      ...(series === undefined ? {} : { series }),
    });
    this.rooms.set(room.roomId, { ...entry, record: next });
    return { ok: true, deliveries: roomStateDeliveries(next) };
  }

  /** Build `room_closed` for every seat before removing the table row. */
  private dissolveEntry(entry: RoomEntry, reason: string): RoomCommandResult {
    const room = entry.record;
    const next = withSeq(room, { state: 'dissolved', stateReason: reason, deadlineAt: null });
    const closed: RoomClosedMessage = {
      type: 'room_closed',
      roomId: room.roomId,
      seq: next.seq,
      reason,
      finalState: 'dissolved',
    };
    const deliveries = broadcastToSeats(next, closed);
    this.rooms.delete(room.roomId);
    return { ok: true, deliveries };
  }

  /**
   * Resume a seat for a `join` carrying its original token (design 5.3/5.4).
   *
   * The seat keeps its `playerId`, host flag and token, the room keeps its
   * `seq` and every deadline, and presence flips back to `online` without a
   * room event. Recovery is a full snapshot at the current seq: `playing`
   * sends the current match snapshot (never the offline actions or an
   * unacknowledged `action_result`), `finished` re-sends the retained `end`,
   * and the lobby only restores the room state. A repeated join therefore
   * returns the same information without moving anything.
   */
  private resumeSeat(entry: RoomEntry, seat: RoomSeat): RoomCommandResult {
    const room = entry.record;
    const presenceChanged = seat.presence !== 'online';
    const record: RoomRecord = presenceChanged
      ? {
          ...room,
          seats: room.seats.map((current) =>
            current.playerId === seat.playerId ? { ...current, presence: 'online' } : current,
          ),
        }
      : room;
    if (presenceChanged) {
      this.rooms.set(record.roomId, { ...entry, record });
    }

    const resumedSeat = record.seats.find(
      (current) => current.playerId === seat.playerId,
    );
    if (resumedSeat === undefined) {
      throw new Error(`seat ${seat.playerId} disappeared from room ${room.roomId}`);
    }
    const deliveries: RoomDelivery[] = presenceChanged
      ? [...roomStateDeliveries(record)]
      : [seatStateDelivery(record, resumedSeat)];

    if (record.state === 'playing' && entry.match !== null) {
      deliveries.push({
        playerToken: seat.playerToken,
        message: toSnapshotMessage(entry.match.state.snapshot, record.roomId, record.seq),
      });
    } else if (record.state === 'finished') {
      const end = entry.match?.state.end;
      if (end !== null && end !== undefined) {
        deliveries.push({
          playerToken: seat.playerToken,
          message: toEndMessage(end, record.roomId, record.seq),
        });
      }
    }

    return {
      ok: true,
      deliveries,
      boundToken: seat.playerToken,
    };
  }
}

/** Create an in-memory room table for the WebSocket transport. */
export function createRoomManager(options: RoomManagerOptions = {}): InMemoryRoomManager {
  return new InMemoryRoomManager(options);
}
