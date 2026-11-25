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
 * The manager owns room lifecycle and seating only. The authoritative match
 * layer (#484) calls {@link InMemoryRoomManager.finishMatch} once it has
 * produced the `end` payload; action validation, snapshots and verdicts are
 * deliberately absent here. Turn/match timer policy belongs to #485, so
 * {@link InMemoryRoomManager.timeout} handles the `join` timer only.
 */

import { randomInt, randomUUID } from 'node:crypto';
import {
  JOIN_TIMEOUT_MS,
  ROOM_CAPACITY,
  broadcastToSeats,
  createRoomId,
  issuePlayerToken,
  roomErrorMessage,
  roomStateDeliveries,
  seatedCommandSuccess,
  type PlayerId,
  type PlayerToken,
  type RoomCommandFailure,
  type RoomCommandResult,
  type RoomConnection,
  type RoomDelivery,
  type RoomErrorCode,
  type RoomId,
  type RoomManager,
  type RoomRecord,
  type RoomSeat,
} from './contracts';
import {
  PROTOCOL_VERSION,
  createMatchEngine,
  type CreateMessage,
  type JoinMessage,
  type LeaveMessage,
  type MatchEndReason,
  type ReadyMessage,
  type RematchMessage,
  type RoomClosedMessage,
  type RoomState,
  type StartMessage,
  type TimeoutMessage,
  type TimeoutTimer,
} from '../../src/games/minesweeper/online/index';
import {
  validateConfig,
  type MinesweeperConfig,
  type MinesweeperEngine,
} from '../../src/games/minesweeper/engine';

/** Runtime handle for the authoritative match owned by the room. */
export interface RoomMatch {
  readonly matchId: string;
  readonly seed: number;
  readonly engine: MinesweeperEngine;
}

/** Constructor hooks used by the transport and tests. */
export interface RoomManagerOptions {
  /** Clock used for every deadline; defaults to `Date.now`. */
  readonly now?: () => number;
  /** `join` window in milliseconds; defaults to the design's 120 s. */
  readonly joinTimeoutMs?: number;
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
export class InMemoryRoomManager implements RoomManager {
  private readonly rooms = new Map<RoomId, RoomEntry>();
  private readonly now: () => number;
  private readonly joinTimeoutMs: number;
  private readonly createSeed: () => number;

  constructor(options: RoomManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.joinTimeoutMs = options.joinTimeoutMs ?? JOIN_TIMEOUT_MS;
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
      return this.resumeSeat(room, seat);
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
   * `ready → playing`: mint a new matchId and seed, then hold one authoritative
   * engine. The match layer owns every action and snapshot from here on.
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
    // `ready` is only set when both seats are full and ready, so the state
    // guard also covers the design's readiness check. Presence and the
    // "both still online" half of t-start belong to the reconnect layer
    // (#485); until it is wired in every seated player is online.

    const matchId = `match_${randomUUID()}`;
    const seed = this.createSeed();
    const engine = createMatchEngine(room.config, seed);
    // `joinDeadlineAt` stays at its lobby value; it is only meaningful while
    // the room is waiting/ready and is reset by rematch.
    const next = withSeq(room, {
      state: 'playing',
      matchId,
      turnPlayerId: room.hostId,
      deadlineAt: null,
      stateReason: 'match-started',
    });

    this.rooms.set(room.roomId, {
      ...entry,
      record: next,
      match: { matchId, seed, engine },
    });
    return { ok: true, deliveries: roomStateDeliveries(next) };
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
    if (votes.size < room.seats.length) {
      const next = withSeq(room, { stateReason: 'rematch-pending' });
      this.rooms.set(room.roomId, { ...entry, record: next, rematchVotes: votes });
      return { ok: true, deliveries: roomStateDeliveries(next) };
    }
    // Presence/online checks for t-rematch belong to the reconnect layer
    // (#485); until it is wired in every seated player is online.

    const next = withSeq(room, {
      state: 'ready',
      matchId: null,
      turnPlayerId: null,
      deadlineAt: null,
      joinDeadlineAt: this.now() + this.joinTimeoutMs,
      stateReason: 'rematch',
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
   * Expire the `join` window and dissolve the room.
   *
   * `turn` and `match` timers are owned by #485 and intentionally rejected
   * here so a timer call alone never produces a `finished` room; only the
   * match layer may make that transition. The caller schedules the timer; the
   * deadline is the authority, which makes an early call a `deadline-passed`
   * rejection with no state change.
   */
  timeout(roomId: RoomId, timer: TimeoutTimer): RoomCommandResult {
    const entry = this.rooms.get(roomId);
    if (entry === undefined) {
      return reject('room-not-found', { roomId });
    }
    const room = entry.record;
    if (timer !== 'join') {
      return reject('invalid-state', { roomId }, room);
    }
    if (room.state !== 'waiting' && room.state !== 'ready') {
      return reject('invalid-state', { roomId }, room);
    }
    if (this.now() < room.joinDeadlineAt) {
      return reject('deadline-passed', { roomId }, room);
    }

    // Two sequential broadcasts need two sequence numbers: a client that
    // applied the timeout at N+1 would drop a room_closed carrying the same
    // seq. Once the record is removed no version at N+1 has to be readable.
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

  /**
   * Match-layer seam (#484): move `playing → finished` after the verdict.
   *
   * The result payload is built by the match layer; this method only records
   * the terminal state and keeps the match id/engine until `rematch` clears
   * them. `matchId` is checked against the held match so a late timer or a
   * retried end from an earlier match cannot finish the next one. It is not
   * part of the wire `RoomManager` contract.
   */
  finishMatch(
    roomId: RoomId,
    matchId: string,
    reason: MatchEndReason,
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

    const next = withSeq(room, {
      state: 'finished',
      turnPlayerId: null,
      deadlineAt: null,
      stateReason: reason,
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
   * Confirm one seat and return its current `room_state`.
   *
   * A duplicate or retried `join` is idempotent: only that seat gets the
   * current state and the sequence does not move. Presence changes and the
   * playing snapshot are owned by the reconnect layer (#485), so this manager
   * deliberately does not mutate the seat here.
   */
  private resumeSeat(room: RoomRecord, seat: RoomSeat): RoomCommandResult {
    return {
      ok: true,
      deliveries: [seatStateDelivery(room, seat)],
      boundToken: seat.playerToken,
    };
  }
}

/** Create an in-memory room table for the WebSocket transport. */
export function createRoomManager(options: RoomManagerOptions = {}): InMemoryRoomManager {
  return new InMemoryRoomManager(options);
}
