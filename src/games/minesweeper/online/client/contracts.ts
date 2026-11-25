/**
 * Client-side contract for online Minesweeper (#486).
 *
 * This module is the single public seam between the client room store, the
 * transport, the board renderer and the view. It only defines types,
 * constants, pure value helpers and injection points: the reducer, the DOM
 * renderer and the WebSocket are intentionally not implemented here. Later
 * tasks fill those seams without adding a second DTO or message layer.
 *
 * The wire DTOs stay in `../types.ts` (owned by #482); this file imports them
 * and never edits them or invents a new message. Two client-only rules are
 * pinned here:
 *
 * - `room_state` does not carry the recipient's own `playerId`. The seat
 *   role (`host` / `guest`) comes from the create/join request and is stored
 *   in {@link SeatSession}; {@link deriveSelfId} maps it onto `hostId` /
 *   `players` and the store keeps the result in
 *   {@link RoomClientState.selfId}.
 * - The owner-only `playerToken` is a bearer secret, so
 *   {@link RoomClientRoom} is the room broadcast without it. The token lives
 *   in the {@link TokenStore}, never in render state.
 *
 * Readability is part of the contract too: every wire `ProtocolErrorCode`
 * plus the two connection-layer outcomes (`session-replaced`,
 * `connection-lost`) has one user-facing text in
 * {@link ROOM_CLIENT_ERROR_TEXT}. The wire code `stale-state` is the issue's
 * `stale-seq`; no new error code is introduced.
 */

import { PROTOCOL_ERROR_CODES } from '../protocol';
import type {
  ActionKind,
  ClientToServerMessage,
  EndMessage,
  ErrorMessage,
  ProtocolErrorCode,
  RoomState,
  RoomStateMessage,
  ServerToClientMessage,
  SnapshotEngineStatus,
  SnapshotMessage,
} from '../types';

// ---------------------------------------------------------------------------
// Connection and seat session
// ---------------------------------------------------------------------------

/** Which seat this client owns; never sent on the wire. */
export type SeatRole = 'host' | 'guest';

/**
 * Everything a client must remember to open or resume one seat.
 *
 * `playerToken` is `null` until the server delivers it in the owner's first
 * `room_state`; a stored session with a token resumes the same seat after a
 * disconnect. `role` decides how {@link deriveSelfId} resolves the seat,
 * because `room_state` has no per-recipient `playerId` field.
 */
export interface SeatSession {
  readonly roomId: string;
  readonly playerToken: string | null;
  readonly displayName: string;
  readonly role: SeatRole;
}

/**
 * Persistence seam for {@link SeatSession}.
 *
 * A browser implementation would back this with `sessionStorage`; tests can
 * inject an in-memory map. `clear` must make the stored token unusable from
 * this client even when the underlying storage throws.
 */
export interface TokenStore {
  /** Return the stored session for `roomId`, or `null` when there is none. */
  load(roomId: string): SeatSession | null;
  /** Persist a session, replacing any previous session for the same room. */
  save(session: SeatSession): void;
  /** Forget the session and token for `roomId`. */
  clear(roomId: string): void;
}

/**
 * Client-side connection lifecycle.
 *
 * This is intentionally separate from the wire `RoomState` and from the
 * seat-level `PlayerPresence`: a room can be `playing` while this browser is
 * `reconnecting`, and presence only describes a seat, not the local socket.
 */
export type RoomConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'closed';

/** Detach a listener registered through the store or the transport. */
export type Unsubscribe = () => void;

/**
 * The transport seam: one way to open a room socket, send client messages,
 * close it, and observe both inbound messages and connection changes.
 *
 * The implementation owns WebSocket details (URL, reconnect backoff, token
 * binding) and is created per seat. It is the only client module allowed to
 * speak directly to the room service; the store and view consume these
 * callbacks. Status listeners should also be told the current status once on
 * subscription so a late subscriber never starts out stale.
 */
export interface ClientTransport {
  /** Open or re-open the socket for this seat, binding its token when present. */
  connect(session: SeatSession): void;
  /** Queue one already-validated client message; runtime errors surface via status. */
  send(message: ClientToServerMessage): void;
  /** Close the socket. It is safe to call more than once. */
  close(): void;
  /** Receive every server message in arrival order. */
  onMessage(listener: (message: ServerToClientMessage) => void): Unsubscribe;
  /** Receive every connection-status change. */
  onStatus(listener: (status: RoomConnectionStatus) => void): Unsubscribe;
  /** Receive a connection-layer failure that is not a server `error` message. */
  onError(listener: (code: ConnectionErrorCode) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Client state, store and selectors
// ---------------------------------------------------------------------------

/** The room lifecycle as seen by the client; mirrors the wire `RoomState`. */
export type RoomClientPhase = RoomState;

/** The latest room broadcast with the owner-only token removed. */
export type RoomClientRoom = Omit<RoomStateMessage, 'playerToken'>;

/**
 * One readable client error.
 *
 * `message` is the user-facing text from {@link ROOM_CLIENT_ERROR_TEXT};
 * `detail` keeps the server's raw explanation (or `null`) for diagnostics
 * without showing protocol wording in the UI.
 */
export interface RoomClientError {
  readonly code: RoomClientErrorCode;
  readonly message: string;
  readonly detail: string | null;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly currentSeq: number | null;
}

/**
 * Everything the room view needs to render one frame.
 *
 * The store owns this value and replaces it atomically; listeners only ever
 * see a frozen snapshot. `lastSeq` is the highest server `seq` already applied,
 * so older or duplicated broadcasts can be dropped. `end`, `snapshot` and
 * `room` are the raw server payloads: the redacted board in `snapshot` never
 * contains hidden mines, and only `end` may reveal them.
 */
export interface RoomClientState {
  /** Latest room lifecycle value; `idle` before the first `room_state`. */
  readonly phase: RoomClientPhase;
  /** Local socket lifecycle, not a room state and not the seat presence. */
  readonly connection: RoomConnectionStatus;
  /** Highest applied server `seq`; starts at `0`. */
  readonly lastSeq: number;
  /** Seat role from create/join, used to derive `selfId`. */
  readonly role: SeatRole | null;
  /** This player's public id, derived from `role` + `room`. */
  readonly selfId: string | null;
  /** Latest room broadcast, without the owner-only `playerToken`. */
  readonly room: RoomClientRoom | null;
  /** Latest redacted board snapshot, or `null` before the match starts. */
  readonly snapshot: SnapshotMessage | null;
  /** Final result after the match; the only client value that reveals mines. */
  readonly end: EndMessage | null;
  /** Latest readable error, or `null` when the last state is healthy. */
  readonly error: RoomClientError | null;
}

/** Receives every committed client state change. */
export type RoomClientStateListener = (state: RoomClientState) => void;

/**
 * The client state machine seam.
 *
 * Implementations own the reducer that turns `ServerToClientMessage` values
 * into the next {@link RoomClientState}; this contract only fixes the API.
 * `applyServerMessage` must drop a room broadcast whose `seq` is not newer
 * than `lastSeq`, never mutate its argument, and notify every listener once
 * after a state change. `reset` returns the store to
 * {@link createInitialRoomClientState} state.
 */
export interface RoomClientStore {
  getState(): RoomClientState;
  subscribe(listener: RoomClientStateListener): Unsubscribe;
  applyServerMessage(message: ServerToClientMessage): void;
  reset(): void;
}

/** What the store needs from the transport and the seat it serves. */
export interface RoomClientStoreOptions {
  readonly session: SeatSession;
  readonly transport: ClientTransport;
}

/** Factory seam so the view does not import a concrete reducer. */
export type RoomClientStoreFactory = (options: RoomClientStoreOptions) => RoomClientStore;

/** Factory seam for a per-mount transport. */
export type ClientTransportFactory = (session: SeatSession) => ClientTransport;

/** Why a board cell cannot be acted on right now. */
export type BoardActionBlockReason =
  | 'room-not-playing'
  | 'missing-board'
  | 'not-your-turn'
  | 'out-of-bounds'
  | 'cell-revealed'
  | 'cell-flagged'
  | 'awaiting-server';

/**
 * Read-only verdict for one board intent.
 *
 * A blocked gate never means "retry forever": the view renders the reason and
 * the action button/cell as disabled. `message` is already human-readable and
 * may be `null` while `allowed` is true.
 */
export interface BoardActionGate {
  readonly allowed: boolean;
  readonly reason: BoardActionBlockReason | null;
  readonly message: string | null;
}

/** Which server deadline a countdown is following. */
export type CountdownKind = 'join' | 'turn' | 'match' | 'none';

/**
 * Countdown derived only from a server timestamp.
 *
 * `remainingMs` is an estimate for display; the server deadline is the sole
 * source of truth. The view never uses this value to accept or reject an
 * action. When no deadline applies, `kind` is `none`, `deadlineAt` is `null`
 * and `remainingMs` is `0`.
 */
export interface RoomCountdown {
  readonly kind: CountdownKind;
  readonly deadlineAt: number | null;
  readonly remainingMs: number;
  readonly expired: boolean;
  readonly label: string;
}

/**
 * Read-only derivations from {@link RoomClientState}.
 *
 * Selectors never mutate state and never send messages. Implementations can be
 * shared across the view and tests; `nowMs` is injected so a countdown can be
 * asserted deterministically.
 *
 * Deadline precedence for {@link RoomSelectors.countdown}: while `playing`,
 * the earlier of the turn `deadlineAt` and the match `matchDeadlineAt`; while
 * `waiting` / `ready`, the room `joinDeadlineAt`; otherwise no countdown.
 */
export interface RoomSelectors {
  /** True only while playing and `selfId` equals the current `turnPlayerId`. */
  isMyTurn(state: RoomClientState): boolean;
  /** True when this seat is the host of the current room. */
  isHost(state: RoomClientState): boolean;
  /** True when the host may start the match from `ready`. */
  canStart(state: RoomClientState): boolean;
  /** True when this seat may toggle readiness in `waiting` / `ready`. */
  canToggleReady(state: RoomClientState): boolean;
  /** Redacted board view for rendering, or `null` before the match starts. */
  board(state: RoomClientState): BoardViewModel | null;
  /** Decide whether one reveal/flag intent is currently allowed. */
  actionGate(
    state: RoomClientState,
    row: number,
    col: number,
    kind: ActionKind,
  ): BoardActionGate;
  /** Estimate the relevant server deadline at `nowMs`. */
  countdown(state: RoomClientState, nowMs: number): RoomCountdown;
  /** Readable text for the current error, or `null` when there is none. */
  errorText(state: RoomClientState): string | null;
}

// ---------------------------------------------------------------------------
// Board view model and renderer seam
// ---------------------------------------------------------------------------

/**
 * One rendered board cell.
 *
 * It deliberately has no `mine` field. Hidden mines are never rendered, and
 * the end-only final board is a separate result screen rather than this shared
 * match board; `adjacentMines` is meaningful only when `revealed`.
 */
export interface OnlineBoardCellView {
  readonly row: number;
  readonly col: number;
  readonly revealed: boolean;
  readonly flagged: boolean;
  readonly adjacentMines: number;
  /** True while this player's action on the cell awaits the server verdict. */
  readonly pending: boolean;
}

/**
 * The redacted board plus the counters a renderer needs.
 *
 * `cells` are row-major and each row has exactly `cols` entries. No hidden
 * cell state, mine positions or seeds appear here; those only arrive through
 * `RoomClientState.end`.
 */
export interface BoardViewModel {
  readonly roomId: string;
  readonly matchId: string;
  readonly selfId: string | null;
  readonly turnPlayerId: string;
  readonly turnId: number;
  readonly status: SnapshotEngineStatus;
  readonly seedHash: string;
  readonly deadlineAt: number;
  readonly matchDeadlineAt: number;
  readonly elapsedMs: number;
  readonly mineCount: number;
  readonly remainingMines: number;
  readonly revealedSafeCount: number;
  readonly rows: number;
  readonly cols: number;
  readonly cells: readonly (readonly OnlineBoardCellView[])[];
}

/** One user intent produced by a board cell, before it becomes an `action`. */
export interface BoardActionIntent {
  readonly kind: ActionKind;
  readonly row: number;
  readonly col: number;
}

/**
 * DOM renderer seam.
 *
 * The implementation owns elements, event listeners and pending styling; it
 * receives only the redacted view model and reports intents. It must not call
 * the transport directly, so the view can gate and sequence actions.
 */
export interface BoardRenderer {
  render(
    container: HTMLElement,
    view: BoardViewModel,
    onIntent: (intent: BoardActionIntent) => void,
  ): void;
  destroy(): void;
}

/** Factory seam for a fresh renderer on each room mount. */
export type BoardRendererFactory = () => BoardRenderer;

// ---------------------------------------------------------------------------
// Online room view seam
// ---------------------------------------------------------------------------

/**
 * Injected capabilities of the online room view.
 *
 * The view module later composes these instead of importing a socket, storage
 * or a concrete store. Tests can pass fakes and never open a browser context.
 */
export interface OnlineRoomViewDependencies {
  readonly createTransport: ClientTransportFactory;
  readonly createStore: RoomClientStoreFactory;
  readonly selectors: RoomSelectors;
  readonly createBoardRenderer: BoardRendererFactory;
  readonly tokenStore: TokenStore;
  /** Client wall clock used only for countdown estimates against server deadlines. */
  readonly now: () => number;
  /** Navigate between the hub, create/join form and a specific room href. */
  readonly navigate: (href: string) => void;
}

/**
 * A mounted online room view.
 *
 * `destroy` must close the transport, detach listeners and destroy the board
 * renderer; the shell calls it on every route change, even while a socket is
 * still reconnecting. `getState` exposes the latest committed state for tests
 * and e2e diagnostics without adding a second observable.
 */
export interface OnlineRoomHandle {
  readonly roomId: string;
  getState(): RoomClientState;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

/**
 * Create the pre-connection state.
 *
 * `phase` stays `idle` until the first `room_state`, and `connection` stays
 * `idle` until the transport reports `connecting`; passing a stored session
 * only restores the seat role so a retry keeps using the right identity.
 */
export function createInitialRoomClientState(
  session: SeatSession | null = null,
): RoomClientState {
  return Object.freeze({
    phase: 'idle',
    connection: 'idle',
    lastSeq: 0,
    role: session?.role ?? null,
    selfId: null,
    room: null,
    snapshot: null,
    end: null,
    error: null,
  });
}

// ---------------------------------------------------------------------------
// Self identity
// ---------------------------------------------------------------------------

/**
 * Derive this client's public player id from its seat role and `room_state`.
 *
 * `room_state` has no per-recipient `playerId`: the create request produces
 * the host seat, a join produces the guest seat, and a reconnect reuses the
 * stored role. The host is `hostId`; the guest is the other player in
 * `players`. Returns `null` when the matching seat is not present (for
 * example, a stale broadcast from before this seat joined).
 */
export function deriveSelfId(role: SeatRole, room: RoomStateMessage): string | null {
  if (role === 'host') {
    return room.hostId;
  }
  const guest = room.players.find((player) => player.playerId !== room.hostId);
  return guest?.playerId ?? null;
}

// ---------------------------------------------------------------------------
// Readable errors
// ---------------------------------------------------------------------------

/**
 * Outcomes produced by the connection layer rather than a server `error`
 * message. They are deliberately not added to the wire `ProtocolErrorCode`
 * union: `session-replaced` closes the old socket, and `connection-lost` is a
 * local transport event.
 */
export const CONNECTION_ERROR_CODES = ['session-replaced', 'connection-lost'] as const;

/** Every connection-layer error code. */
export type ConnectionErrorCode = (typeof CONNECTION_ERROR_CODES)[number];

/** Every code the client can show, without adding a new wire error code. */
export type RoomClientErrorCode = ProtocolErrorCode | ConnectionErrorCode;

/** Complete runtime list used by the view contract test and error rendering. */
export const ROOM_CLIENT_ERROR_CODES: readonly RoomClientErrorCode[] = Object.freeze([
  ...PROTOCOL_ERROR_CODES,
  ...CONNECTION_ERROR_CODES,
]);

/**
 * One readable sentence per client-visible error.
 *
 * The record is typed as `Record<RoomClientErrorCode, string>`, so adding a
 * wire error code without a text fails the build. `stale-state` intentionally
 * covers the issue's older `stale-seq` wording; no `stale-seq` key exists.
 */
export const ROOM_CLIENT_ERROR_TEXT: Readonly<Record<RoomClientErrorCode, string>> = Object.freeze({
  'unsupported-version': '页面版本与房间服务不一致，请刷新页面后重试。',
  'room-not-found': '房间不存在或已解散，请重新创建或加入。',
  'not-your-turn': '还没轮到你行动，请等对手完成这一步。',
  'stale-state': '房间状态已更新，请按最新棋盘重新操作。',
  'invalid-action': '这一步无法执行，请换一个格子试试。',
  'deadline-passed': '本回合已超时，请等待结算。',
  'bad-request': '请求未通过校验，请重试。',
  'session-replaced': '这个席位已在另一处打开，本页面的连接已断开。',
  'connection-lost': '与房间的连接已断开，正在尝试重连。',
});

/** Read the user-facing text for one client-visible error code. */
export function roomClientErrorText(code: RoomClientErrorCode): string {
  return ROOM_CLIENT_ERROR_TEXT[code];
}

/** Convert a wire `error` message into the client's readable error shape. */
export function roomClientErrorFromWire(message: ErrorMessage): RoomClientError {
  return {
    code: message.code,
    message: roomClientErrorText(message.code),
    detail: message.message,
    retryable: message.retryable,
    requestId: message.requestId,
    currentSeq: message.currentSeq,
  };
}

/** Build a readable error for a connection-layer outcome. */
export function connectionClientError(code: ConnectionErrorCode): RoomClientError {
  return {
    code,
    message: roomClientErrorText(code),
    detail: null,
    retryable: code === 'connection-lost',
    requestId: null,
    currentSeq: null,
  };
}

// ---------------------------------------------------------------------------
// Online room href
// ---------------------------------------------------------------------------

/** Canonical online room entry; the room id travels in the `room` query. */
export const ONLINE_MINESWEEPER_HREF = '#/online/minesweeper';

/** Query parameter that identifies the room to join. */
export const ONLINE_ROOM_QUERY_PARAM = 'room';

/** Parsed online route. `roomId` is `null` for the create/join screen. */
export interface OnlineRoomRoute {
  readonly roomId: string | null;
}

/**
 * Build the room href used by links and redirects.
 *
 * `null` / an empty id points at the create/join screen. The id is encoded so
 * arbitrary server ids survive a round trip through the hash.
 */
export function onlineRoomHref(roomId: string | null = null): string {
  if (roomId === null || roomId === '') {
    return ONLINE_MINESWEEPER_HREF;
  }
  return `${ONLINE_MINESWEEPER_HREF}?${ONLINE_ROOM_QUERY_PARAM}=${encodeURIComponent(roomId)}`;
}

/**
 * Parse `#/online/minesweeper?room=...`.
 *
 * Returns `null` for any other route so callers can fall through to the app
 * router. A leading `#` and a trailing slash are optional, matching the app's
 * hash router; unknown query parameters are ignored, and an empty `room=` is
 * treated like an absent one. A malformed percent escape is replaced rather
 * than thrown by `URLSearchParams`.
 */
export function parseOnlineRoomHref(hash: string): OnlineRoomRoute | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryStart = raw.indexOf('?');
  const path = (queryStart === -1 ? raw : raw.slice(0, queryStart))
    .replace(/^\/+|\/+$/g, '');
  if (path !== 'online/minesweeper') {
    return null;
  }
  const query = queryStart === -1 ? '' : raw.slice(queryStart + 1);
  const roomId = new URLSearchParams(query).get(ONLINE_ROOM_QUERY_PARAM);
  return { roomId: roomId === null || roomId === '' ? null : roomId };
}
