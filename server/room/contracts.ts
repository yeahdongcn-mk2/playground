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
import { createProtocolError } from '../../src/games/minesweeper/online/index';
import type {
  ActionMessage,
  CreateMessage,
  ErrorMessage,
  JoinMessage,
  LeaveMessage,
  PlayerPresence,
  PlayerView,
  ProtocolErrorCode,
  ProtocolErrorOptions,
  ReadyMessage,
  RematchMessage,
  RoomState,
  RoomStateMessage,
  ServerToClientMessage,
  StartMessage,
  TimeoutTimer,
} from '../../src/games/minesweeper/online/index';

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

/**
 * How long the player whose turn it is may take to submit an action.
 *
 * Design 3.4 (`design:room-lifecycle.timers.turn`): the timer starts with the
 * turn and resets on an accepted action or a turn change; expiring it ends the
 * match through the `end` event.
 */
export const TURN_TIMEOUT_MS = 30_000;

/**
 * Hard cap on one match, starting at `start` and never reset.
 *
 * Design 3.4 (`design:room-lifecycle.timers.match`): expiring it ends the
 * match through the `end` event even while a turn is still running.
 */
export const MATCH_TIMEOUT_MS = 900_000;

/**
 * Application-level WebSocket ping interval (design 5.1 and the
 * `design:reconnect` `heartbeat.intervalMs` value).
 *
 * The server sends one `ping` per live connection on this cadence. The client
 * answers `pong` on the same socket; the server clock alone decides whether a
 * beat was answered, so client throttling cannot extend a deadline.
 */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Consecutive unanswered heartbeat beats that mark a player `offline`
 * (design 5.1, `design:reconnect` `heartbeat.missedBeats`).
 *
 * One lost packet or a throttled background tab must not look like a
 * forfeit, so detection needs a streak rather than a single miss.
 */
export const HEARTBEAT_MISSED_BEATS = 2;

/**
 * Time from the last answered heartbeat to offline detection: exactly
 * {@link HEARTBEAT_MISSED_BEATS} missed {@link HEARTBEAT_INTERVAL_MS} beats.
 *
 * This is a derived constant rather than a copy of `10_000` so the heartbeat
 * policy stays the single source of the 10 s detection threshold that design
 * 5.1 requires to be shorter than the grace and turn windows.
 */
export const OFFLINE_DETECT_MS = HEARTBEAT_INTERVAL_MS * HEARTBEAT_MISSED_BEATS;

/**
 * How long an `offline` seat is reserved for its token before the room layer
 * resolves it (design 5.2 and `design:reconnect` `grace.graceMs`).
 *
 * The window starts when offline detection fires, not when the socket closed.
 * It buys the player time to reconnect with the original token; it does not
 * pause or reset {@link TURN_TIMEOUT_MS} or {@link MATCH_TIMEOUT_MS}, so going
 * offline can never be used to buy unlimited time or dodge the match cap.
 * When it lapses, the room manager applies the design 5.6 outcome for the
 * room state at that moment.
 *
 * The four durations form one ordered chain:
 * `OFFLINE_DETECT_MS < RECONNECT_GRACE_MS < TURN_TIMEOUT_MS < MATCH_TIMEOUT_MS`
 * — a player is declared offline before the grace window opens, the grace
 * window closes before a turn forfeit, and the turn deadline is far tighter
 * than the hard match cap.
 */
export const RECONNECT_GRACE_MS = 15_000;

/**
 * Guard the heartbeat/grace/turn/match ordering the reconnect design relies
 * on.
 *
 * The values above are constants, but the ordering is a load-bearing part of
 * the contract: swapping any two would make detection race the grace window
 * or let a grace period outlive the turn it is supposed to protect. A runtime
 * guard keeps that failure loud at import time instead of silently changing
 * the semantics; `tests/unit/online-reconnect-contracts.test.ts` also pins the
 * numbers independently.
 */
function assertPresenceTimerOrder(): void {
  const ordered =
    HEARTBEAT_MISSED_BEATS >= 1 &&
    OFFLINE_DETECT_MS === HEARTBEAT_INTERVAL_MS * HEARTBEAT_MISSED_BEATS &&
    OFFLINE_DETECT_MS < RECONNECT_GRACE_MS &&
    RECONNECT_GRACE_MS < TURN_TIMEOUT_MS &&
    TURN_TIMEOUT_MS < MATCH_TIMEOUT_MS;
  if (!ordered) {
    throw new Error(
      'presence timer contract violated: expected ' +
        'OFFLINE_DETECT_MS < RECONNECT_GRACE_MS < TURN_TIMEOUT_MS < MATCH_TIMEOUT_MS',
    );
  }
}

assertPresenceTimerOrder();

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
  /** Must equal the `playerId` of exactly one host seat. */
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

/**
 * Successful command: the messages to deliver, in delivery order.
 *
 * `boundToken` is set only by `create` and `join`, which seat the requesting
 * connection: it is the token that connection now owns, whether freshly issued
 * or resumed from `JoinMessage.playerToken`. The transport binds it to the
 * calling connection before dispatching. Any other delivery token that has no
 * live connection belongs to an offline seat and must be dropped, never
 * re-addressed to the caller.
 */
export interface RoomCommandSuccess {
  readonly ok: true;
  readonly deliveries: readonly RoomDelivery[];
  readonly boundToken?: PlayerToken;
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
 * Result of one authoritative match command.
 *
 * A successful action reuses {@link RoomCommandSuccess}: it lists the messages
 * to deliver, in order, and never binds a new seat. A rejected action carries
 * the shared #482 `ProtocolErrorCode` itself rather than an internal
 * {@link RoomErrorCode}; build its `error` with `createProtocolError(code, …)`
 * so it is exactly the wire DTO the shared server validator accepts.
 */
export type MatchCommandResult =
  | RoomCommandSuccess
  | {
      readonly ok: false;
      readonly code: ProtocolErrorCode;
      readonly error: ErrorMessage;
    };

/**
 * A connection as the room manager sees it.
 *
 * The transport owns the socket and the connection→token map. It passes the
 * token it has already bound (null before `create`/`join`); a resuming `join`
 * takes the seat token from `JoinMessage.playerToken` instead, and the success
 * `boundToken` tells the transport what to bind.
 */
export interface RoomConnection {
  readonly connectionId: string;
  readonly playerToken: PlayerToken | null;
}

// ---------------------------------------------------------------------------
// Presence and reconnect contract
// ---------------------------------------------------------------------------

/**
 * The only socket capability the presence controller needs.
 *
 * The transport owns the socket, its lifecycle and the connection→token map;
 * the controller only needs to send one application-level `ping` on a live
 * connection. Keeping this surface narrow lets tests fake heartbeat timing
 * without a WebSocket, and keeps close/error handling out of the controller.
 */
export interface PresenceSocket {
  /** Send one application-level ping on this live connection. */
  ping(): void;
}

/**
 * Connection-layer presence controller (#485, design 5.1–5.3).
 *
 * The transport calls these hooks; the controller turns them into heartbeat
 * timers, presence transitions and grace deadlines, and reports the result
 * through {@link PresenceRoomManager}. It never edits a room record itself:
 * heartbeat bookkeeping must not raise a room event or change `seq`,
 * `turnId` or `seed`.
 *
 * `tokenBound` / `tokenUnbound` are how the controller learns which seat a
 * connection represents. The transport binds the token returned by
 * `create` / `join` and unbinds it on `leave` or seat release; before a bind,
 * a connection has no player presence to report. The implementation is
 * constructed with a {@link PresenceRoomManager}, which is the only way it can
 * affect room state.
 */
export interface PresenceController {
  /** A transport connection is ready; start its heartbeat from this moment. */
  connectionOpened(connectionId: string, socket: PresenceSocket): void;
  /** The connection is gone; stop its heartbeat and let its bound token go offline. */
  connectionClosed(connectionId: string): void;
  /** A valid `pong` arrived; reset the miss streak for this connection. */
  pongReceived(connectionId: string): void;
  /** The connection now owns `playerToken`; heartbeat outcomes apply to that seat. */
  tokenBound(connectionId: string, playerToken: PlayerToken): void;
  /** The connection no longer owns a seat (leave, release or replacement). */
  tokenUnbound(connectionId: string): void;
}

/**
 * Room-layer half of the presence seam (#485, design 5.2 and 5.6).
 *
 * Implemented by the room manager (or a thin adapter around it) and called by
 * the {@link PresenceController}. Both commands are synchronous and
 * serialized like every other room command, and both answer with the same
 * {@link RoomCommandResult} the transport already delivers: the caller never
 * gets to mutate a room record directly.
 *
 * - `setPresence` mirrors one connection-layer presence value onto the seat
 *   that owns the token. It does not change {@link RoomState} or `seq`; the
 *   only room event presence can eventually produce is `graceExpired`.
 * - `graceExpired` is the room event for a lapsed reconnect window. It
 *   releases the seat, dissolves the room or records the forfeit / retained
 *   result exactly as design 5.6 prescribes for the current state.
 */
export interface PresenceRoomManager {
  /** Apply one presence value to the seat owning `playerToken`. */
  setPresence(playerToken: PlayerToken, presence: PlayerPresence): RoomCommandResult;
  /** Resolve the seat whose reconnect grace window has run out. */
  graceExpired(playerToken: PlayerToken): RoomCommandResult;
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
 * Success for a command that seated the calling connection (`create`/`join`).
 *
 * It binds the connection to its token and broadcasts the new room state. The
 * transport must send the remaining deliveries by their own tokens and drop
 * any token without a live connection instead of re-addressing it.
 */
export function seatedCommandSuccess(
  room: RoomRecord,
  seat: RoomSeat,
): RoomCommandSuccess {
  return {
    ok: true,
    deliveries: roomStateDeliveries(room),
    boundToken: seat.playerToken,
  };
}

/**
 * One message that is safe to send to every seat.
 *
 * `room_state` is excluded because its per-seat copy carries `playerToken`
 * (use {@link roomStateDeliveries}); `error` is excluded because it answers the
 * requesting connection, not the room.
 */
export type BroadcastMessage = Exclude<ServerToClientMessage, RoomStateMessage | ErrorMessage>;

/**
 * Address one seat-independent message to every current seat.
 *
 * Room-level events (`timeout`, `room_closed`, `snapshot`, `end`, ...) are
 * broadcast this way: one shared message object, one delivery per seat. Empty
 * rooms produce no deliveries. Build the deliveries before removing the seat
 * that triggered the event, so a leaving seat still receives `room_closed`.
 */
export function broadcastToSeats(
  room: RoomRecord,
  message: BroadcastMessage,
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
 * match layer (#484), not the room lifecycle. {@link MatchRoomManager} extends
 * this contract with that one command.
 */
export interface RoomManager {
  /** `idle → waiting`: validate the request, assign a room, seat the host. */
  create(connection: RoomConnection, message: CreateMessage): RoomCommandResult;
  /** Join a waiting room (new token) or resume a seat with `JoinMessage.playerToken`. */
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

/**
 * Room manager extended with the authoritative match command.
 *
 * This is the seam the match layer implements: `action` applies one reveal or
 * flag for the current turn and answers with a {@link MatchCommandResult}.
 * Every lifecycle method keeps its {@link RoomCommandResult} semantics. The
 * action implementation, turn arbitration and replay ordering land with the
 * match layer (#484); this contract only fixes the public signature.
 */
export interface MatchRoomManager extends RoomManager {
  action(connection: RoomConnection, message: ActionMessage): MatchCommandResult;
}
