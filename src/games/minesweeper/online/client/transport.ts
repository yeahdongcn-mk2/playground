/**
 * Browser WebSocket transport for one online Minesweeper seat (#486 t4).
 *
 * This module implements {@link ClientTransport} and owns every WebSocket
 * concern; the store and the view only see validated messages, connection
 * status and connection-layer errors. It never changes room or match rules and
 * never adds a wire message: the heartbeat and server-side reconnect policy
 * belong to #485, and the transport path stays the same-origin `/ws` fixed by
 * #483 (`ROOM_WS_PATH` in `server/room/ws-server.ts`).
 *
 * Four rules shape the implementation:
 *
 * - **Address.** An injected `url` wins, then `VITE_ROOM_SERVER_URL`, then the
 *   same-origin `/ws`. A configured origin (no explicit path) gets `/ws`
 *   appended; an explicit path is used unchanged, so a proxy path survives.
 * - **Envelope.** Every outgoing message gets a `requestId` (or `actionId` for
 *   `action`) when the caller left it empty, and `create`/`join` always carry
 *   the shared `PROTOCOL_VERSION`. Unknown fields are never added, so the
 *   outgoing JSON still passes `validateClientMessage`.
 * - **Token.** The owner-only `playerToken` in a received `room_state` is
 *   persisted with the seat's display name and role in the injected
 *   {@link TokenStore}. It is a bearer secret: the transport keeps it out of
 *   every other message and out of the client render state.
 * - **Recovery.** An unexpected close with a token reconnects with exponential
 *   backoff and re-`join`s with that token, the stored display name and the
 *   stored host/guest role. `session-replaced` (close `4001`), a
 *   `room-not-found` error, a dissolved `room_closed` and unrecoverable close
 *   codes stop reconnecting and are reported through the contract callbacks.
 *
 * The socket factory, id source and backoff timers are all injectable, so the
 * jsdom tests drive fake sockets and fake time without a real network or real
 * 500 ms+ waits.
 */

import { validateServerMessage } from '../protocol';
import { PROTOCOL_VERSION } from '../types';
import type {
  ClientToServerMessage,
  RoomStateMessage,
  ServerToClientMessage,
} from '../types';
import type {
  ClientTransport,
  ClientTransportFactory,
  ConnectionErrorCode,
  RoomConnectionStatus,
  SeatSession,
  TokenStore,
  Unsubscribe,
} from './contracts';

// ---------------------------------------------------------------------------
// Public constants and injection seams
// ---------------------------------------------------------------------------

/** Same-origin room socket path; mirrors `ROOM_WS_PATH` in the room service. */
export const ROOM_CLIENT_WS_PATH = '/ws';

/** First reconnect delay; each further attempt doubles it. */
export const DEFAULT_RECONNECT_BASE_MS = 500;

/** Upper bound for one reconnect delay. */
export const DEFAULT_RECONNECT_MAX_MS = 8_000;

/** Default number of socket reconnect attempts before reporting offline. */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

/** WebSocket application close code used when another connection replaced us. */
const SESSION_REPLACED_CLOSE_CODE = 4001;

/** Close codes after which reconnecting cannot recover this transport. */
const UNRECOVERABLE_CLOSE_CODES = new Set([1003, 1008]);

/**
 * The subset of the browser `WebSocket` surface the transport uses.
 *
 * Handler properties (instead of `addEventListener`) keep the fake socket in
 * the unit test small; the default factory casts the real browser socket once.
 */
export interface RoomTransportSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Injectable timers, so reconnect backoff can run under fake time. */
export interface RoomTransportTimers {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Browser location fields needed to derive the same-origin socket URL. */
export interface RoomTransportLocation {
  readonly protocol: string;
  readonly host: string;
}

/** The one environment value this transport reads, injectable for tests. */
export interface RoomTransportEnv {
  readonly VITE_ROOM_SERVER_URL?: string;
}

/** Options that only affect address resolution. */
export interface RoomWebSocketUrlOptions {
  /** Full socket address or room-server origin; wins over the environment. */
  readonly url?: string;
  /** Injectable environment; defaults to Vite's `import.meta.env`. */
  readonly env?: RoomTransportEnv;
  /** Injectable page location; defaults to the current browser location. */
  readonly location?: RoomTransportLocation;
}

/** Complete options for {@link createRoomTransport}. */
export interface RoomWebSocketTransportOptions extends RoomWebSocketUrlOptions {
  /** Persistence seam for the owner-only `playerToken`. */
  readonly tokenStore: TokenStore;
  /** Factory for the socket; tests inject a fake WebSocket. */
  readonly socketFactory?: (url: string) => RoomTransportSocket;
  /** Random component of generated request/action ids. */
  readonly randomId?: () => string;
  /** Timer seam for reconnect backoff. */
  readonly timers?: RoomTransportTimers;
  /** Delay before reconnect attempt `attempt` (0-based); defaults to exponential. */
  readonly backoffMs?: (attempt: number) => number;
  /** Reconnect attempts before reporting `offline`; defaults to 5. */
  readonly maxReconnectAttempts?: number;
}

// ---------------------------------------------------------------------------
// Default implementations
// ---------------------------------------------------------------------------

const DEFAULT_TIMERS: RoomTransportTimers = {
  setTimeout(handler, delayMs) {
    return globalThis.setTimeout(handler, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

/** Exponential backoff capped at {@link DEFAULT_RECONNECT_MAX_MS}. */
export function defaultReconnectDelay(attempt: number): number {
  return Math.min(DEFAULT_RECONNECT_MAX_MS, DEFAULT_RECONNECT_BASE_MS * 2 ** attempt);
}

function defaultRandomId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultSocketFactory(url: string): RoomTransportSocket {
  if (typeof WebSocket === 'undefined') {
    throw new Error('WebSocket is unavailable in this environment');
  }
  return new WebSocket(url) as unknown as RoomTransportSocket;
}

// ---------------------------------------------------------------------------
// Address resolution
// ---------------------------------------------------------------------------

function trimUrl(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function viteEnvironmentUrl(): string {
  return trimUrl(import.meta.env?.VITE_ROOM_SERVER_URL as string | undefined);
}

function pageLocation(): RoomTransportLocation {
  const location = globalThis.location;
  if (location === undefined) {
    throw new Error('cannot resolve the room WebSocket URL without a browser location');
  }
  return location;
}

function pageSocketScheme(location: RoomTransportLocation): 'ws:' | 'wss:' {
  return location.protocol === 'https:' || location.protocol === 'wss:' ? 'wss:' : 'ws:';
}

function pageHttpOrigin(location: RoomTransportLocation): string {
  const scheme = pageSocketScheme(location) === 'wss:' ? 'https:' : 'http:';
  return `${scheme}//${location.host}`;
}

function pageSocketOrigin(location: RoomTransportLocation): string {
  return `${pageSocketScheme(location)}//${location.host}`;
}

/**
 * Normalize one explicit socket URL.
 *
 * A root path means "the room service origin", so `/ws` is appended. Any
 * other path is taken as the caller's endpoint (for example a reverse-proxy
 * path) and kept as-is, apart from trailing slashes and the hash.
 */
function normalizeSocketEndpoint(url: URL): string {
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path === '' ? ROOM_CLIENT_WS_PATH : path;
  return url.toString();
}

/**
 * Resolve the room socket address in the documented precedence order.
 *
 * `url` (injected) beats `VITE_ROOM_SERVER_URL`, which beats the same-origin
 * `/ws`. Absolute `ws://` / `wss://` and `http://` / `https://` addresses are
 * accepted, as are protocol-relative, root-relative and bare host values.
 */
export function resolveRoomWebSocketUrl(options: RoomWebSocketUrlOptions = {}): string {
  const configured =
    trimUrl(options.url) ||
    (options.env === undefined
      ? viteEnvironmentUrl()
      : trimUrl(options.env.VITE_ROOM_SERVER_URL));
  const location = (): RoomTransportLocation => options.location ?? pageLocation();

  if (configured === '') {
    return `${pageSocketOrigin(location())}${ROOM_CLIENT_WS_PATH}`;
  }

  if (/^wss?:\/\//i.test(configured)) {
    return normalizeSocketEndpoint(new URL(configured));
  }

  if (/^https?:\/\//i.test(configured)) {
    const url = new URL(configured);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return normalizeSocketEndpoint(url);
  }

  const page = location();
  if (configured.startsWith('//')) {
    const url = new URL(configured, pageHttpOrigin(page));
    url.protocol = pageSocketScheme(page);
    return normalizeSocketEndpoint(url);
  }

  if (configured.startsWith('/')) {
    return normalizeSocketEndpoint(new URL(`${pageSocketOrigin(page)}${configured}`));
  }

  // A bare `host[:port][/path]` value keeps the page's security level.
  const url = new URL(`//${configured}`, pageHttpOrigin(page));
  url.protocol = pageSocketScheme(page);
  return normalizeSocketEndpoint(url);
}

// ---------------------------------------------------------------------------
// Outgoing message envelope
// ---------------------------------------------------------------------------

function nextMessageId(prefix: string, randomId: () => string): string {
  return `${prefix}-${randomId()}`;
}

/**
 * Fill the client-owned envelope fields of one already-typed message.
 *
 * The caller's non-empty id is preserved so a retry keeps its idempotency
 * key; an empty id is replaced. `create`/`join` always carry the shared
 * `PROTOCOL_VERSION` instead of trusting a caller-provided version.
 */
export function withClientEnvelope(
  message: ClientToServerMessage,
  randomId: () => string = defaultRandomId,
): ClientToServerMessage {
  switch (message.type) {
    case 'create':
      return {
        ...message,
        requestId: message.requestId || nextMessageId('create', randomId),
        protocolVersion: PROTOCOL_VERSION,
      };
    case 'join':
      return {
        ...message,
        requestId: message.requestId || nextMessageId('join', randomId),
        protocolVersion: PROTOCOL_VERSION,
      };
    case 'ready':
      return {
        ...message,
        requestId: message.requestId || nextMessageId('ready', randomId),
      };
    case 'start':
      return {
        ...message,
        requestId: message.requestId || nextMessageId('start', randomId),
      };
    case 'rematch':
      return {
        ...message,
        requestId: message.requestId || nextMessageId('rematch', randomId),
      };
    case 'leave':
      return {
        ...message,
        requestId: message.requestId || nextMessageId('leave', randomId),
      };
    case 'action':
      return {
        ...message,
        actionId: message.actionId || nextMessageId('action', randomId),
      };
  }
}

// ---------------------------------------------------------------------------
// Close classification
// ---------------------------------------------------------------------------

type CloseOutcome = 'retryable' | 'session-replaced' | 'unrecoverable';

function classifyClose(event: { readonly code?: number; readonly reason?: string }): CloseOutcome {
  const code = typeof event.code === 'number' ? event.code : 1006;
  const reason = typeof event.reason === 'string' ? event.reason : '';
  if (code === SESSION_REPLACED_CLOSE_CODE || reason === 'session-replaced') {
    return 'session-replaced';
  }
  if (UNRECOVERABLE_CLOSE_CODES.has(code)) {
    return 'unrecoverable';
  }
  return 'retryable';
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Create one transport instance for one seat.
 *
 * `connect` may be called again after a close to retry deliberately; every
 * call discards the previous socket and pending queue. The instance owns no
 * global state, so the composition root can create one per mounted room.
 */
export function createRoomTransport(
  options: RoomWebSocketTransportOptions,
): ClientTransport {
  const { tokenStore } = options;
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const randomId = options.randomId ?? defaultRandomId;
  const timers = options.timers ?? DEFAULT_TIMERS;
  const backoff =
    options.backoffMs ?? ((attempt: number) => defaultReconnectDelay(attempt));
  const maxReconnectAttempts = Math.max(
    0,
    Math.floor(options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS),
  );

  let status: RoomConnectionStatus = 'idle';
  let session: SeatSession | null = null;
  let socket: RoomTransportSocket | null = null;
  let socketOpen = false;
  let rejoinOnOpen = false;
  let reconnectAttempt = 0;
  let reconnectTimer: unknown = null;
  let queued: ClientToServerMessage[] = [];
  let terminal = false;

  const messageListeners = new Set<(message: ServerToClientMessage) => void>();
  const statusListeners = new Set<(next: RoomConnectionStatus) => void>();
  const errorListeners = new Set<(code: ConnectionErrorCode) => void>();

  function setStatus(next: RoomConnectionStatus): void {
    if (status === next) return;
    status = next;
    for (const listener of Array.from(statusListeners)) {
      listener(next);
    }
  }

  function emitMessage(message: ServerToClientMessage): void {
    for (const listener of Array.from(messageListeners)) {
      listener(message);
    }
  }

  function emitError(code: ConnectionErrorCode): void {
    for (const listener of Array.from(errorListeners)) {
      listener(code);
    }
  }

  function stopReconnectTimer(): void {
    if (reconnectTimer === null) return;
    timers.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  /** Detach every handler and close the socket without treating it as a loss. */
  function disposeSocket(): void {
    const previous = socket;
    socket = null;
    socketOpen = false;
    queued = [];
    if (previous === null) return;
    previous.onopen = null;
    previous.onmessage = null;
    previous.onclose = null;
    previous.onerror = null;
    try {
      previous.close(1000, 'client-close');
    } catch {
      // A socket that cannot close is already unusable; its handlers are gone.
    }
  }

  function loadStoredToken(candidate: SeatSession): SeatSession {
    let stored: SeatSession | null = null;
    const resumeStoredSeat = candidate.playerToken === null || candidate.playerToken === '';
    if (resumeStoredSeat) {
      try {
        stored = tokenStore.load(candidate.roomId);
      } catch {
        stored = null;
      }
    }
    const playerToken = candidate.playerToken || stored?.playerToken || null;
    // A seat resumed from storage keeps the seat identity the server knows;
    // an explicit seat (create/new join) keeps the caller's name.
    const displayName =
      resumeStoredSeat && stored !== null && stored.displayName !== ''
        ? stored.displayName
        : candidate.displayName !== ''
          ? candidate.displayName
          : stored?.displayName ?? '';
    // A stored token proves the persisted host/guest seat, so a caller that
    // only knows a default role must not overwrite it.
    const role = resumeStoredSeat && stored !== null ? stored.role : candidate.role;
    return { roomId: candidate.roomId, playerToken, displayName, role };
  }

  function persistToken(message: RoomStateMessage): void {
    const playerToken = message.playerToken;
    if (session === null || typeof playerToken !== 'string' || playerToken === '') return;
    const next: SeatSession = {
      roomId: message.roomId,
      playerToken,
      displayName: session.displayName,
      role: session.role,
    };
    session = next;
    try {
      tokenStore.save(next);
    } catch {
      // Persistence is best effort; the in-memory seat still supports reconnect.
    }
  }

  /** Drop a token the server has invalidated (dissolved, replaced or missing). */
  function forgetToken(): void {
    if (session === null) return;
    const roomId = session.roomId;
    session = { ...session, playerToken: null };
    try {
      tokenStore.clear(roomId);
    } catch {
      // Clearing is best effort like saving; the in-memory token is gone.
    }
  }

  function handleServerMessage(message: ServerToClientMessage): void {
    // Valid traffic proves the reconnected socket finished its handshake; only
    // then does the backoff counter start over. Resetting on `open` alone
    // would let a connect-then-drop loop retry forever.
    reconnectAttempt = 0;

    if (message.type === 'room_state') {
      persistToken(message);
    }

    if (message.type === 'room_closed') {
      // The room is gone; a later socket close must not start a reconnect loop.
      terminal = true;
      stopReconnectTimer();
      forgetToken();
      emitMessage(message);
      disposeSocket();
      setStatus('closed');
      return;
    }

    if (message.type === 'error' && message.code === 'room-not-found') {
      terminal = true;
      stopReconnectTimer();
      forgetToken();
      emitMessage(message);
      disposeSocket();
      setStatus('closed');
      return;
    }

    emitMessage(message);
  }

  function handlePayload(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const validation = validateServerMessage(parsed);
    if (!validation.ok) return;
    handleServerMessage(validation.value);
  }

  function sendNow(message: ClientToServerMessage): void {
    if (socket === null || !socketOpen) {
      queued.push(message);
      return;
    }
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A browser socket error is followed by `close`, which owns recovery.
    }
  }

  function flushQueue(): void {
    if (queued.length === 0) return;
    const pending = queued;
    queued = [];
    for (const message of pending) {
      sendNow(message);
    }
  }

  function sendRejoin(): void {
    // Defensive only: the close/open paths already require a token before a
    // resume is scheduled, so this never runs without a seat.
    if (session === null || session.playerToken === null || session.playerToken === '') {
      return;
    }
    const join = withClientEnvelope(
      {
        type: 'join',
        requestId: '',
        protocolVersion: PROTOCOL_VERSION,
        roomId: session.roomId,
        playerToken: session.playerToken,
        displayName: session.displayName,
      },
      randomId,
    );
    sendNow(join);
  }

  function handleOpen(): void {
    socketOpen = true;
    setStatus('connected');
    if (rejoinOnOpen) {
      rejoinOnOpen = false;
      sendRejoin();
    }
    flushQueue();
  }

  function beginReconnect(): void {
    if (terminal) return;
    setStatus('reconnecting');
    emitError('connection-lost');
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (terminal || reconnectTimer !== null) return;
    if (reconnectAttempt >= maxReconnectAttempts) {
      terminal = true;
      setStatus('offline');
      return;
    }
    const attempt = reconnectAttempt;
    reconnectAttempt += 1;
    const delay = Math.max(0, backoff(attempt));
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      if (!terminal && socket === null) {
        openSocket(true);
      }
    }, delay);
  }

  function handleClose(event: { readonly code?: number; readonly reason?: string }): void {
    const previous = socket;
    socket = null;
    socketOpen = false;
    queued = [];
    if (previous !== null) {
      previous.onopen = null;
      previous.onmessage = null;
      previous.onclose = null;
      previous.onerror = null;
    }

    if (terminal) {
      setStatus('closed');
      return;
    }

    const outcome = classifyClose(event);
    if (outcome === 'session-replaced') {
      terminal = true;
      stopReconnectTimer();
      forgetToken();
      emitError('session-replaced');
      setStatus('closed');
      return;
    }
    if (outcome === 'unrecoverable') {
      terminal = true;
      stopReconnectTimer();
      // A policy/incompatibility close stops this transport but does not prove
      // the server released the seat, so the stored token is kept.
      // `connection-lost` is the only contract code for a local loss; the
      // `closed` status is what tells listeners this one will not retry.
      emitError('connection-lost');
      setStatus('closed');
      return;
    }
    if (session === null || session.playerToken === null || session.playerToken === '') {
      // Nothing can resume the seat yet; the caller must create/join again.
      terminal = true;
      stopReconnectTimer();
      emitError('connection-lost');
      setStatus('offline');
      return;
    }
    beginReconnect();
  }

  function handleOpenFailure(): void {
    if (terminal) return;
    if (session === null || session.playerToken === null || session.playerToken === '') {
      terminal = true;
      emitError('connection-lost');
      setStatus('offline');
      return;
    }
    beginReconnect();
  }

  function openSocket(reconnect: boolean): void {
    if (terminal || socket !== null) return;
    let nextSocket: RoomTransportSocket;
    try {
      nextSocket = socketFactory(resolveRoomWebSocketUrl(options));
    } catch {
      handleOpenFailure();
      return;
    }
    socket = nextSocket;
    socketOpen = false;
    rejoinOnOpen = reconnect;
    setStatus(reconnect ? 'reconnecting' : 'connecting');

    nextSocket.onopen = () => {
      if (socket !== nextSocket) return;
      handleOpen();
    };
    nextSocket.onmessage = (event) => {
      if (socket !== nextSocket) return;
      handlePayload(event.data);
    };
    nextSocket.onclose = (event) => {
      if (socket !== nextSocket) return;
      handleClose(event);
    };
    nextSocket.onerror = () => {
      // Browsers follow a socket error with `close`; recovery lives there.
    };
  }

  return {
    connect(nextSession: SeatSession): void {
      // Keep messages sent before the first socket existed; a socket that is
      // being replaced, however, owns a stale queue that must not be replayed.
      const parked = socket === null ? queued : [];
      terminal = false;
      reconnectAttempt = 0;
      rejoinOnOpen = false;
      stopReconnectTimer();
      disposeSocket();
      queued = parked;
      session = loadStoredToken(nextSession);
      openSocket(false);
    },

    send(message: ClientToServerMessage): void {
      if (terminal) return;
      const normalized = withClientEnvelope(message, randomId);
      if (socket !== null && socketOpen) {
        sendNow(normalized);
      } else {
        queued.push(normalized);
      }
    },

    close(): void {
      terminal = true;
      rejoinOnOpen = false;
      stopReconnectTimer();
      disposeSocket();
      setStatus('closed');
    },

    onMessage(listener: (message: ServerToClientMessage) => void): Unsubscribe {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },

    onStatus(listener: (next: RoomConnectionStatus) => void): Unsubscribe {
      statusListeners.add(listener);
      // The contract requires the current status once on subscription.
      listener(status);
      return () => {
        statusListeners.delete(listener);
      };
    },

    onError(listener: (code: ConnectionErrorCode) => void): Unsubscribe {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
  };
}

/**
 * Wrap {@link createRoomTransport} in the per-mount {@link ClientTransportFactory}
 * the view contract injects. Each mounted room gets an independent socket.
 *
 * The factory deliberately ignores its session argument: the host applies the
 * seat through `connect(session)` only after subscribing to status/messages, so
 * the socket cannot open before the view is ready.
 */
export function createRoomTransportFactory(
  options: RoomWebSocketTransportOptions,
): ClientTransportFactory {
  return () => createRoomTransport(options);
}
