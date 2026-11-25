/**
 * Shared contract for the standalone online Minesweeper room service.
 *
 * This module is the seam between the transport layer (`ws-server.ts`), the
 * in-memory room manager and the tests. It owns the public room-service types,
 * the room constants, the seat/room records the manager keeps in memory, the
 * delivery model and the pure id/state helpers. It deliberately contains no
 * room lifecycle logic: the state machine lives in `room-manager.ts`.
 *
 * Two rules shape the surface:
 *
 * - The wire DTOs are the ones from `src/games/minesweeper/online` (#482);
 *   this file adds no second message layer. Room responses are built with
 *   `createProtocolError` and checked by the shared validators.
 * - A `playerToken` is a bearer secret. It is never part of the public room
 *   state: only the owner's own delivery carries it. The public projection
 *   (`publicRoomState`) cannot contain one, and the per-seat delivery helper
 *   is the one place that attaches a token to a `room_state` message.
 *
 * The module is server-only (Node crypto) and has no DOM, timer or storage
 * dependency.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  createProtocolError,
  type ProtocolErrorOptions,
} from '../../src/games/minesweeper/online/protocol';
import type {
  CreateMessage,
  ErrorMessage,
  JoinMessage,
  LeaveMessage,
  PlayerPresence,
  PlayerView,
  ProtocolErrorCode,
  ReadyMessage,
  RematchMessage,
  RoomState,
  RoomStateMessage,
  ServerToClientMessage,
  StartMessage,
  TimeoutTimer,
} from '../../src/games/minesweeper/online/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long a freshly created room may wait for the second seat and readiness.
 *
 * Design 3.4: the `join` timer starts on `create`, is reset by `rematch` and
 * dissolves the room when it expires. `ready` shares the timer on purpose so a
 * late joiner is not kicked by a separate readiness deadline.
 */
export const JOIN_TIMEOUT_MS = 120_000;

/** Seats per room, fixed by design 3.4 (a two-player match). */
export const ROOM_CAPACITY = 2;

/** Default local port of the room service; overridable through the entry point. */
export const DEFAULT_ROOM_SERVER_PORT = 8787;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Opaque, server-issued room identifier. */
export type RoomId = string;

/**
 * Secret bearer token that proves ownership of one seat.
 *
 * It is only ever delivered to its owner and must never be logged, broadcast
 * or derived from public state. Reconnecting with a valid token resumes the
 * seat.
 */
export type PlayerToken = string;

/** Stable public player identifier, safe to send to every seat. */
export type PlayerId = string;

/**
 * Mint a fresh room id.
 *
 * The id is random and carries no sequence or clock component, so two rooms
 * created in the same millisecond cannot collide and an id cannot be guessed
 * from a previous one.
 */
export function createRoomId(): RoomId {
  return `room_${randomUUID()}`;
}

/**
 * Mint a fresh seat token.
 *
 * 32 random bytes encoded as base64url: enough entropy to make guessing or
 * correlating tokens infeasible, and independent of the room id and player id
 * that do appear in public state.
 */
export function issuePlayerToken(): PlayerToken {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// Room and seat records kept in memory
// ---------------------------------------------------------------------------

/**
 * One seat of a room.
 *
 * `playerToken` stays on the server: it is the only secret in this record and
 * is stripped by `publicRoomState`. The remaining fields are the surface of
 * `PlayerView` in a `room_state` message.
 */
export interface RoomSeat {
  readonly playerId: PlayerId;
  readonly playerToken: PlayerToken;
  readonly displayName: string;
  readonly ready: boolean;
  readonly presence: PlayerPresence;
  readonly isHost: boolean;
  /** Seat creation time, kept for diagnostics and presence bookkeeping. */
  readonly joinedAt: number;
}

/**
 * One in-memory room.
 *
 * The record is immutable: the room manager replaces it on every accepted
 * transition, so a rejected command can never leave a half-applied update
 * behind. Fields that only the match layer owns (`matchId`, `turnPlayerId`,
 * `deadlineAt`) are carried here so `publicRoomState` can project them.
 */
export interface RoomRecord {
  readonly roomId: RoomId;
  readonly config: CreateMessage['config'];
  readonly capacity: number;
  readonly state: RoomState;
  /** Monotonic sequence stamped on every `room_state` broadcast. */
  readonly seq: number;
  readonly hostId: PlayerId;
  readonly seats: readonly RoomSeat[];
  readonly matchId: string | null;
  readonly turnPlayerId: PlayerId | null;
  /** Absolute deadline of the current `join` window; reset by `rematch`. */
  readonly joinDeadlineAt: number;
  /** Absolute deadline of the current turn, or null outside a `.playing` match. */
  readonly deadlineAt: number | null;
  readonly stateReason: string | null;
}

/** Public projection of one seat: exactly the `PlayerView` wire shape. */
function publicPlayerView(seat: RoomSeat): PlayerView {
  return {
    playerId: seat.playerId,
    displayName: seat.displayName,
    ready: seat.ready,
    presence: seat.presence,
    isHost: seat.isHost,
  };
}

/**
 * Public room state for a `room_state` broadcast.
 *
 * The return type removes `playerToken` from `RoomStateMessage`, so a caller
 * cannot accidentally attach a seat secret; only `roomStateDeliveries` adds a
 * seat's own token to that seat's copy of the message.
 */
export type PublicRoomState = Omit<RoomStateMessage, 'playerToken'>;

/** Project the client-safe part of a room; never includes a `playerToken`. */
export function publicRoomState(room: RoomRecord): PublicRoomState {
  return {
    type: 'room_state',
    roomId: room.roomId,
    seq: room.seq,
    state: room.state,
    hostId: room.hostId,
    capacity: room.capacity,
    players: room.seats.map(publicPlayerView),
    config: room.config,
    matchId: room.matchId,
    turnPlayerId: room.turnPlayerId,
    joinDeadlineAt: room.joinDeadlineAt,
    deadlineAt: room.deadlineAt,
    stateReason: room.stateReason,
  };
}

// ---------------------------------------------------------------------------
// Delivery model
// ---------------------------------------------------------------------------

/**
 * One outbound message addressed to exactly one seat.
 *
 * `playerToken` is the recipient's token, never a broadcast credential. The
 * transport resolves it to that seat's connection; a token with no live
 * connection is simply undeliverable (an offline seat), not an error.
 */
export interface RoomDelivery {
  readonly playerToken: PlayerToken;
  readonly message: ServerToClientMessage;
}

/** Successful command: the messages to deliver, in delivery order. */
export interface RoomCommandSuccess {
  readonly ok: true;
  readonly deliveries: readonly RoomDelivery[];
}

/** Reason a lifecycle command was rejected before it changed any state. */
export const ROOM_ERROR_CODES = [
  'room-not-found',
  'room-full',
  'not-in-room',
  'not-host',
  'not-ready',
  'invalid-state',
  'deadline-passed',
  'bad-request',
] as const;

/** Internal room failure code, e.g. `room-full` or `not-host`. */
export type RoomErrorCode = (typeof ROOM_ERROR_CODES)[number];

/**
 * Wire protocol code for each internal room failure.
 *
 * `room-not-found` is the one code callers can rely on end-to-end: design 3
 * requires an unknown or dissolved room to answer with exactly that code. The
 * remaining lifecycle violations are `bad-request`, except an expired window,
 * which reuses `deadline-passed`.
 */
export const ROOM_ERROR_PROTOCOL_CODE: Readonly<Record<RoomErrorCode, ProtocolErrorCode>> = {
  'room-not-found': 'room-not-found',
  'room-full': 'bad-request',
  'not-in-room': 'bad-request',
  'not-host': 'bad-request',
  'not-ready': 'bad-request',
  'invalid-state': 'bad-request',
  'deadline-passed': 'deadline-passed',
  'bad-request': 'bad-request',
};

/** Default human-readable message for each internal room failure. */
const ROOM_ERROR_MESSAGES: Readonly<Record<RoomErrorCode, string>> = {
  'room-not-found': 'room not found',
  'room-full': 'room is full',
  'not-in-room': 'player is not in this room',
  'not-host': 'only the room host may do that',
  'not-ready': 'both players must be ready first',
  'invalid-state': 'event is not valid in the current room state',
  'deadline-passed': 'the room deadline has passed',
  'bad-request': 'bad request',
};

/** Overrides accepted by {@link roomErrorMessage}; mirrors protocol errors. */
export type RoomErrorOptions = ProtocolErrorOptions;

/**
 * Build the unified rejection carried by every failed lifecycle command.
 *
 * The wire `code` is the mapped protocol code from
 * {@link ROOM_ERROR_PROTOCOL_CODE}; the internal `room-full` / `not-host`
 * detail stays in the message. A caller sending the error to the requesting
 * seat must not broadcast it to the room.
 */
export function roomErrorMessage(
  code: RoomErrorCode,
  options: RoomErrorOptions = {},
): ErrorMessage {
  return createProtocolError(ROOM_ERROR_PROTOCOL_CODE[code], {
    ...options,
    message: options.message ?? ROOM_ERROR_MESSAGES[code],
  });
}

/** Failed command: one unified error, addressed to the requesting connection. */
export interface RoomCommandFailure {
  readonly ok: false;
  readonly code: RoomErrorCode;
  readonly error: ErrorMessage;
}

/** Unified result of every room lifecycle command. */
export type RoomCommandResult = RoomCommandSuccess | RoomCommandFailure;

/**
 * A connection as the room manager sees it.
 *
 * The transport owns the socket and the connection→token map. It passes the
 * token it has learned (null before create/join) so the manager can find the
 * caller's seat without trusting any room state sent by the client.
 */
export interface RoomConnection {
  readonly connectionId: string;
  readonly playerToken: PlayerToken | null;
}

// ---------------------------------------------------------------------------
// Delivery helpers
// ---------------------------------------------------------------------------

/**
 * Build the per-seat `room_state` deliveries for a broadcast.
 *
 * Every seat receives the same public projection; the only difference is its
 * own `playerToken`. No delivery carries another seat's token.
 */
export function roomStateDeliveries(room: RoomRecord): readonly RoomDelivery[] {
  const state = publicRoomState(room);
  return room.seats.map((seat) => ({
    playerToken: seat.playerToken,
    message: { ...state, playerToken: seat.playerToken },
  }));
}

/**
 * Address one already-seat-independent message to every seat.
 *
 * Room-level events (`timeout`, `room_closed`, `snapshot`, `end`, ...) are
 * broadcast this way: one shared message object, one delivery per seat. Empty
 * rooms produce no deliveries.
 */
export function broadcastToSeats(
  room: RoomRecord,
  message: ServerToClientMessage,
): readonly RoomDelivery[] {
  return room.seats.map((seat) => ({ playerToken: seat.playerToken, message }));
}

// ---------------------------------------------------------------------------
// Room manager contract
// ---------------------------------------------------------------------------

/**
 * In-memory room service contract.
 *
 * Every method is synchronous and single-instance: the design fixes one
 * serial event queue per room, so a command is applied completely before the
 * next one starts. All methods return a {@link RoomCommandResult}: a success
 * lists the deliveries the transport must send, and a failure carries one
 * {@link RoomCommandFailure} without changing room state.
 *
 * `action` is intentionally absent: authoritative match commands belong to the
 * match layer (#484), not the room lifecycle.
 */
export interface RoomManager {
  /** `idle → waiting`: validate the request, assign a room, seat the host. */
  create(connection: RoomConnection, message: CreateMessage): RoomCommandResult;
  /** Join a waiting room, or resume a seat with a valid token. */
  join(connection: RoomConnection, message: JoinMessage): RoomCommandResult;
  /** Set or clear one seat's readiness; readiness may flip the room state. */
  ready(connection: RoomConnection, message: ReadyMessage): RoomCommandResult;
  /** Host starts the match from `ready`; the match layer owns the new match. */
  start(connection: RoomConnection, message: StartMessage): RoomCommandResult;
  /** Leave a room outside a running match. */
  leave(connection: RoomConnection, message: LeaveMessage): RoomCommandResult;
  /** Accept or decline a rematch after a finished match. */
  rematch(connection: RoomConnection, message: RematchMessage): RoomCommandResult;
  /** Destroy a room (server initiated, e.g. when the host leaves) and notify its seats. */
  dissolve(roomId: RoomId, reason: string): RoomCommandResult;
  /** Expire a lifecycle timer; `join` dissolves here, `turn`/`match` are owned by #485. */
  timeout(roomId: RoomId, timer: TimeoutTimer): RoomCommandResult;
}
