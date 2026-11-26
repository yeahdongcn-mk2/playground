// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROOM_WS_PATH } from '../../server/room/ws-server';
import {
  createRoomTransport,
  createRoomTransportFactory,
  DEFAULT_RECONNECT_BASE_MS,
  DEFAULT_RECONNECT_MAX_MS,
  defaultReconnectDelay,
  resolveRoomWebSocketUrl,
  ROOM_CLIENT_WS_PATH,
  withClientEnvelope,
  type RoomTransportSocket,
  type RoomTransportTimers,
} from '../../src/games/minesweeper/online/client/transport';
import type {
  ClientTransport,
  ConnectionErrorCode,
  RoomConnectionStatus,
  SeatSession,
  TokenStore,
} from '../../src/games/minesweeper/online/client/contracts';
import { validateClientMessage } from '../../src/games/minesweeper/online/protocol';
import { PROTOCOL_VERSION } from '../../src/games/minesweeper/online/types';
import type {
  ActionMessage,
  ClientToServerMessage,
  CreateMessage,
  ErrorMessage,
  JoinMessage,
  PlayerView,
  ProtocolErrorCode,
  ReadyMessage,
  RoomClosedMessage,
  RoomStateMessage,
  ServerToClientMessage,
} from '../../src/games/minesweeper/online/types';
import type { MinesweeperConfig } from '../../src/games/minesweeper/engine';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOM_ID = 'room_transport_test';
const MATCH_ID = 'match_transport_test';
const HOST_ID = 'player_host';
const HOST_TOKEN = 'host-token';
const GUEST_TOKEN = 'guest-token';
const NOW = 1_700_000_000_000;
const LOCATION = { protocol: 'https:', host: 'play.example' };

const CONFIG: MinesweeperConfig = {
  rows: 3,
  cols: 3,
  mines: 2,
  firstClickSafe: true,
};

const HOST: PlayerView = {
  playerId: HOST_ID,
  displayName: 'Ada',
  ready: false,
  presence: 'online',
  isHost: true,
};

const HOST_SESSION: SeatSession = {
  roomId: ROOM_ID,
  playerToken: null,
  displayName: HOST.displayName,
  role: 'host',
};

const GUEST_SESSION: SeatSession = {
  roomId: ROOM_ID,
  playerToken: null,
  displayName: 'Grace',
  role: 'guest',
};

const CREATE_MESSAGE: CreateMessage = {
  type: 'create',
  requestId: '',
  // A stale version must be replaced by the transport envelope.
  protocolVersion: 0,
  config: CONFIG,
  displayName: HOST.displayName,
};

const JOIN_MESSAGE: JoinMessage = {
  type: 'join',
  requestId: '',
  protocolVersion: 0,
  roomId: ROOM_ID,
  displayName: HOST.displayName,
};

const READY_MESSAGE: ReadyMessage = {
  type: 'ready',
  roomId: ROOM_ID,
  requestId: '',
  ready: true,
};

const START_MESSAGE: ClientToServerMessage = {
  type: 'start',
  roomId: ROOM_ID,
  requestId: '',
};

const REMATCH_MESSAGE: ClientToServerMessage = {
  type: 'rematch',
  roomId: ROOM_ID,
  requestId: '',
  accept: true,
};

const LEAVE_MESSAGE: ClientToServerMessage = {
  type: 'leave',
  roomId: ROOM_ID,
  requestId: '',
};

const ACTION_MESSAGE: ActionMessage = {
  type: 'action',
  roomId: ROOM_ID,
  matchId: MATCH_ID,
  actionId: '',
  seq: 3,
  turnId: 2,
  kind: 'reveal',
  row: 1,
  col: 1,
  clientTimeMs: NOW,
};

function roomState(overrides: Partial<RoomStateMessage> = {}): RoomStateMessage {
  return {
    type: 'room_state',
    roomId: ROOM_ID,
    seq: 1,
    state: 'waiting',
    hostId: HOST_ID,
    capacity: 2,
    players: [HOST],
    config: CONFIG,
    matchId: null,
    turnPlayerId: null,
    joinDeadlineAt: NOW + 120_000,
    deadlineAt: null,
    stateReason: null,
    ...overrides,
  };
}

function errorMessage(code: ProtocolErrorCode): ErrorMessage {
  return {
    type: 'error',
    requestId: null,
    roomId: ROOM_ID,
    code,
    message: `${code} from the room service`,
    retryable: code === 'stale-state',
    currentSeq: null,
  };
}

const ROOM_CLOSED: RoomClosedMessage = {
  type: 'room_closed',
  roomId: ROOM_ID,
  seq: 9,
  reason: 'the room was dissolved',
  finalState: 'dissolved',
};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Fake browser WebSocket: records frames and lets the test drive events. */
class FakeSocket implements RoomTransportSocket {
  readonly sent: string[] = [];
  readonly url: string;
  closed: { readonly code: number | undefined; readonly reason: string | undefined } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    if (this.closed !== null) {
      throw new Error('cannot send on a closed fake socket');
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  /** Deliver the browser `open` event. */
  open(): void {
    this.onopen?.(undefined);
  }

  /** Deliver one text frame; objects are serialized like the server does. */
  receive(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.({ data });
  }

  /** Deliver the server-side `close` event with its close frame. */
  serverClose(code: number, reason = ''): void {
    this.closed = { code, reason };
    this.onclose?.({ code, reason });
  }
}

class MemoryTokenStore implements TokenStore {
  readonly saved: SeatSession[] = [];
  readonly cleared: string[] = [];
  private readonly sessions = new Map<string, SeatSession>();

  load(roomId: string): SeatSession | null {
    return this.sessions.get(roomId) ?? null;
  }

  save(session: SeatSession): void {
    this.saved.push(session);
    this.sessions.set(session.roomId, session);
  }

  clear(roomId: string): void {
    this.cleared.push(roomId);
    this.sessions.delete(roomId);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly transport: ClientTransport;
  readonly tokenStore: TokenStore;
  readonly sockets: FakeSocket[];
  readonly statuses: RoomConnectionStatus[];
  readonly errors: ConnectionErrorCode[];
  readonly messages: ServerToClientMessage[];
}

interface HarnessOptions {
  readonly tokenStore?: TokenStore;
  readonly backoffMs?: (attempt: number) => number;
  readonly maxReconnectAttempts?: number;
}

function createSequentialRandomId(): () => string {
  let value = 0;
  return () => {
    value += 1;
    return String(value);
  };
}

function setup(options: HarnessOptions = {}): Harness {
  const sockets: FakeSocket[] = [];
  const statuses: RoomConnectionStatus[] = [];
  const errors: ConnectionErrorCode[] = [];
  const messages: ServerToClientMessage[] = [];
  const tokenStore = options.tokenStore ?? new MemoryTokenStore();
  const randomId = createSequentialRandomId();

  const transport = createRoomTransport({
    tokenStore,
    location: LOCATION,
    env: {},
    randomId,
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...(options.backoffMs === undefined ? {} : { backoffMs: options.backoffMs }),
    ...(options.maxReconnectAttempts === undefined
      ? {}
      : { maxReconnectAttempts: options.maxReconnectAttempts }),
  });

  transport.onStatus((status) => statuses.push(status));
  transport.onError((code) => errors.push(code));
  transport.onMessage((message) => messages.push(message));

  return { transport, tokenStore, sockets, statuses, errors, messages };
}

function socketAt(sockets: readonly FakeSocket[], index: number): FakeSocket {
  const socket = sockets[index];
  if (socket === undefined) {
    throw new Error(`expected socket ${index}, only ${sockets.length} created`);
  }
  return socket;
}

function lastSocket(sockets: readonly FakeSocket[]): FakeSocket {
  return socketAt(sockets, sockets.length - 1);
}

function memoryTokenStore(harness: Harness): MemoryTokenStore {
  const store = harness.tokenStore;
  if (!(store instanceof MemoryTokenStore)) {
    throw new Error('expected the harness to use a MemoryTokenStore');
  }
  return store;
}

function parseClientMessage(frame: string): ClientToServerMessage {
  const parsed: unknown = JSON.parse(frame);
  const validation = validateClientMessage(parsed);
  if (!validation.ok) {
    throw new Error(`transport sent an invalid client message: ${validation.message}`);
  }
  return validation.value;
}

function connectAndOpen(harness: Harness, session: SeatSession): FakeSocket {
  harness.transport.connect(session);
  const socket = lastSocket(harness.sockets);
  socket.open();
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Address resolution
// ---------------------------------------------------------------------------

describe('online room transport address', () => {
  it('keeps the client path in sync with the room service ROOM_WS_PATH', () => {
    expect(ROOM_CLIENT_WS_PATH).toBe(ROOM_WS_PATH);
    expect(ROOM_CLIENT_WS_PATH).toBe('/ws');
  });

  it('defaults to the same-origin /ws socket', () => {
    expect(resolveRoomWebSocketUrl({ location: LOCATION, env: {} })).toBe('wss://play.example/ws');
    expect(resolveRoomWebSocketUrl({ location: { protocol: 'http:', host: 'localhost:5173' }, env: {} })).toBe(
      'ws://localhost:5173/ws',
    );
  });

  it('reads VITE_ROOM_SERVER_URL and converts http origins to ws', () => {
    expect(
      resolveRoomWebSocketUrl({
        location: LOCATION,
        env: { VITE_ROOM_SERVER_URL: 'https://rooms.example.com' },
      }),
    ).toBe('wss://rooms.example.com/ws');
    expect(
      resolveRoomWebSocketUrl({
        location: LOCATION,
        env: { VITE_ROOM_SERVER_URL: 'http://127.0.0.1:8787/' },
      }),
    ).toBe('ws://127.0.0.1:8787/ws');
  });

  it('falls back to the Vite environment when no env object is injected', () => {
    vi.stubEnv('VITE_ROOM_SERVER_URL', 'wss://env.example.com/ws');
    expect(resolveRoomWebSocketUrl({ location: LOCATION })).toBe('wss://env.example.com/ws');
    // An explicitly injected environment still wins over the build environment.
    expect(
      resolveRoomWebSocketUrl({
        location: LOCATION,
        env: { VITE_ROOM_SERVER_URL: 'wss://injected.example.com/ws' },
      }),
    ).toBe('wss://injected.example.com/ws');
    // An injected but empty environment is authoritative: it must not leak the
    // host/CI value into the same-origin default.
    expect(resolveRoomWebSocketUrl({ location: LOCATION, env: {} })).toBe(
      'wss://play.example/ws',
    );
  });

  it('resolves an absolute address without a browser location', () => {
    expect(resolveRoomWebSocketUrl({ url: 'wss://rooms.example.com/ws' })).toBe(
      'wss://rooms.example.com/ws',
    );
    expect(resolveRoomWebSocketUrl({ env: { VITE_ROOM_SERVER_URL: 'ws://127.0.0.1:8787' } })).toBe(
      'ws://127.0.0.1:8787/ws',
    );
  });

  it('lets an injected url win and preserves an explicit proxy path', () => {
    expect(
      resolveRoomWebSocketUrl({
        location: LOCATION,
        url: 'ws://127.0.0.1:8787/rooms/socket',
        env: { VITE_ROOM_SERVER_URL: 'wss://ignored.example.com/ws' },
      }),
    ).toBe('ws://127.0.0.1:8787/rooms/socket');
    expect(resolveRoomWebSocketUrl({ location: LOCATION, url: '/gateway/ws', env: {} })).toBe(
      'wss://play.example/gateway/ws',
    );
  });

  it('accepts protocol-relative, bare-host and root-relative forms', () => {
    expect(
      resolveRoomWebSocketUrl({ location: LOCATION, url: '//rooms.example.com', env: {} }),
    ).toBe('wss://rooms.example.com/ws');
    expect(
      resolveRoomWebSocketUrl({
        location: { protocol: 'http:', host: 'play.example' },
        url: 'rooms.example.com:8787',
        env: {},
      }),
    ).toBe('ws://rooms.example.com:8787/ws');
    expect(resolveRoomWebSocketUrl({ location: LOCATION, url: '/', env: {} })).toBe(
      'wss://play.example/ws',
    );
  });
});

// ---------------------------------------------------------------------------
// Outgoing envelope
// ---------------------------------------------------------------------------

describe('online room transport envelopes', () => {
  it('fills request ids, action ids and the shared protocol version', () => {
    const randomId = () => 'fixed';

    const create = withClientEnvelope(CREATE_MESSAGE, randomId);
    const join = withClientEnvelope(JOIN_MESSAGE, randomId);
    const ready = withClientEnvelope(READY_MESSAGE, randomId);
    const start = withClientEnvelope(START_MESSAGE, randomId);
    const action = withClientEnvelope(ACTION_MESSAGE, randomId);
    const rematch = withClientEnvelope(REMATCH_MESSAGE, randomId);
    const leave = withClientEnvelope(LEAVE_MESSAGE, randomId);

    expect(create).toEqual({
      ...CREATE_MESSAGE,
      requestId: 'create-fixed',
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(join).toEqual({
      ...JOIN_MESSAGE,
      requestId: 'join-fixed',
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(ready).toEqual({ ...READY_MESSAGE, requestId: 'ready-fixed' });
    expect(start).toEqual({ ...START_MESSAGE, requestId: 'start-fixed' });
    expect(action).toEqual({ ...ACTION_MESSAGE, actionId: 'action-fixed' });
    expect(rematch).toEqual({ ...REMATCH_MESSAGE, requestId: 'rematch-fixed' });
    expect(leave).toEqual({ ...LEAVE_MESSAGE, requestId: 'leave-fixed' });

    for (const message of [create, join, ready, start, action, rematch, leave]) {
      expect(validateClientMessage(message).ok).toBe(true);
    }
  });

  it('preserves non-empty caller ids so retries keep their idempotency key', () => {
    const retained = withClientEnvelope(
      { ...READY_MESSAGE, requestId: 'ready-existing' },
      () => 'ignored',
    );
    expect(retained).toEqual({ ...READY_MESSAGE, requestId: 'ready-existing' });

    const retainedAction = withClientEnvelope(
      { ...ACTION_MESSAGE, actionId: 'action-existing' },
      () => 'ignored',
    );
    expect(retainedAction).toEqual({ ...ACTION_MESSAGE, actionId: 'action-existing' });
  });

  it('queues create/join/action sends until the socket opens and validates them', () => {
    const harness = setup();
    harness.transport.connect(HOST_SESSION);
    const socket = lastSocket(harness.sockets);

    expect(harness.statuses.at(-1)).toBe('connecting');
    harness.transport.send(CREATE_MESSAGE);
    expect(socket.sent).toHaveLength(0);

    socket.open();
    expect(harness.statuses.at(-1)).toBe('connected');
    expect(socket.sent).toHaveLength(1);

    harness.transport.send(JOIN_MESSAGE);
    harness.transport.send(ACTION_MESSAGE);
    harness.transport.send(READY_MESSAGE);
    expect(socket.sent).toHaveLength(4);

    const create = parseClientMessage(socket.sent[0] ?? '');
    const join = parseClientMessage(socket.sent[1] ?? '');
    const action = parseClientMessage(socket.sent[2] ?? '');
    const ready = parseClientMessage(socket.sent[3] ?? '');

    expect(create).toMatchObject({
      type: 'create',
      requestId: 'create-1',
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(join).toMatchObject({
      type: 'join',
      requestId: 'join-2',
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(action).toMatchObject({ type: 'action', actionId: 'action-3' });
    expect(ready).toMatchObject({ type: 'ready', requestId: 'ready-4' });
    expect('requestId' in action).toBe(false);
  });

  it('keeps messages sent before connect() in the queue', () => {
    const harness = setup();
    harness.transport.send(READY_MESSAGE);
    harness.transport.connect(HOST_SESSION);
    const socket = lastSocket(harness.sockets);
    socket.open();

    expect(socket.sent).toHaveLength(1);
    expect(parseClientMessage(socket.sent[0] ?? '')).toMatchObject({
      type: 'ready',
      requestId: 'ready-1',
    });
  });

  it('exposes the per-mount factory from the client transport contract', () => {
    const store = new MemoryTokenStore();
    const factory = createRoomTransportFactory({
      tokenStore: store,
      location: LOCATION,
      env: {},
      socketFactory: () => new FakeSocket('ws://factory.example/ws'),
    });
    const first = factory(HOST_SESSION);
    const second = factory(GUEST_SESSION);
    expect(first).not.toBe(second);
  });
});

// ---------------------------------------------------------------------------
// Inbound validation and token persistence
// ---------------------------------------------------------------------------

describe('online room transport inbound messages', () => {
  it('forwards validated server messages and drops malformed frames', () => {
    const harness = setup();
    const socket = connectAndOpen(harness, HOST_SESSION);

    socket.receive('{not json');
    socket.receive('"a string"');
    socket.receive({ type: 'room_state', roomId: ROOM_ID });
    socket.receive({ ...roomState(), unexpected: true });
    expect(harness.messages).toHaveLength(0);

    const state = roomState();
    socket.receive(state);
    expect(harness.messages).toEqual([state]);
  });

  it('persists the owner-only playerToken with the seat display name and role', () => {
    const hostHarness = setup();
    const hostSocket = connectAndOpen(hostHarness, HOST_SESSION);
    const hostState = roomState({ playerToken: HOST_TOKEN });
    hostSocket.receive(hostState);

    expect(hostHarness.messages).toEqual([hostState]);
    expect(memoryTokenStore(hostHarness).saved).toEqual([
      {
        roomId: ROOM_ID,
        playerToken: HOST_TOKEN,
        displayName: HOST.displayName,
        role: 'host',
      },
    ]);

    const guestHarness = setup();
    const guestSocket = connectAndOpen(guestHarness, GUEST_SESSION);
    guestSocket.receive(roomState({ playerToken: GUEST_TOKEN }));

    expect(memoryTokenStore(guestHarness).saved).toEqual([
      {
        roomId: ROOM_ID,
        playerToken: GUEST_TOKEN,
        displayName: GUEST_SESSION.displayName,
        role: 'guest',
      },
    ]);
  });

  it('restores the stored name and role when the caller has no token', () => {
    const store = new MemoryTokenStore();
    store.save({ ...GUEST_SESSION, playerToken: GUEST_TOKEN, displayName: 'Stored Grace' });
    const harness = setup({ tokenStore: store });
    // A fresh mount may only know a default role and a new typed name; the
    // persisted seat identity wins while resuming.
    const socket = connectAndOpen(harness, {
      roomId: ROOM_ID,
      playerToken: null,
      displayName: 'Typed Grace',
      role: 'host',
    });

    socket.serverClose(1006);
    vi.advanceTimersByTime(DEFAULT_RECONNECT_BASE_MS);
    const resumed = lastSocket(harness.sockets);
    resumed.open();
    expect(parseClientMessage(resumed.sent[0] ?? '')).toMatchObject({
      type: 'join',
      playerToken: GUEST_TOKEN,
      displayName: 'Stored Grace',
    });

    resumed.receive(roomState({ playerToken: 'guest-token-2' }));

    expect(memoryTokenStore(harness).saved.at(-1)).toEqual({
      roomId: ROOM_ID,
      playerToken: 'guest-token-2',
      displayName: 'Stored Grace',
      role: 'guest',
    });
  });

  it('does not persist a token when the broadcast has none or the store throws', () => {
    const store = new MemoryTokenStore();
    const harness = setup({ tokenStore: store });
    const socket = connectAndOpen(harness, HOST_SESSION);

    socket.receive(roomState());
    expect(store.saved).toHaveLength(0);

    const throwingStore: TokenStore = {
      load: () => null,
      save: () => {
        throw new Error('storage unavailable');
      },
      clear: () => undefined,
    };
    const throwingHarness = setup({ tokenStore: throwingStore });
    const throwingSocket = connectAndOpen(throwingHarness, HOST_SESSION);
    const state = roomState({ playerToken: HOST_TOKEN });
    throwingSocket.receive(state);

    // Storage failure must not swallow the authoritative broadcast.
    expect(throwingHarness.messages).toEqual([state]);
    expect(throwingHarness.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Token reconnect and terminal outcomes
// ---------------------------------------------------------------------------

describe('online room transport reconnect', () => {
  it('rejoins with the stored token, name and role after an unexpected close', () => {
    const store = new MemoryTokenStore();
    store.save({ ...GUEST_SESSION, playerToken: GUEST_TOKEN, displayName: 'Grace' });
    const harness = setup({ tokenStore: store });
    const socket = connectAndOpen(harness, GUEST_SESSION);

    socket.serverClose(1006, 'abnormal closure');
    expect(harness.statuses.at(-1)).toBe('reconnecting');
    expect(harness.errors).toEqual(['connection-lost']);

    vi.advanceTimersByTime(DEFAULT_RECONNECT_BASE_MS - 1);
    expect(harness.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(harness.sockets).toHaveLength(2);

    const resumed = lastSocket(harness.sockets);
    expect(resumed.url).toBe('wss://play.example/ws');
    resumed.open();
    expect(harness.statuses.at(-1)).toBe('connected');

    const join = parseClientMessage(resumed.sent[0] ?? '');
    expect(join).toMatchObject({
      type: 'join',
      roomId: ROOM_ID,
      playerToken: GUEST_TOKEN,
      displayName: 'Grace',
      protocolVersion: PROTOCOL_VERSION,
    });
    expect((join as JoinMessage).requestId.length).toBeGreaterThan(0);

    // The recovered socket clears the connection-lost error without a new one.
    expect(harness.errors).toEqual(['connection-lost']);
  });

  it('uses the persisted token from the first room_state for the next reconnect', () => {
    const harness = setup();
    const socket = connectAndOpen(harness, HOST_SESSION);
    socket.receive(roomState({ playerToken: HOST_TOKEN }));

    socket.serverClose(1006, 'network lost');
    vi.advanceTimersByTime(DEFAULT_RECONNECT_BASE_MS);
    const resumed = lastSocket(harness.sockets);
    resumed.open();

    const join = parseClientMessage(resumed.sent[0] ?? '');
    expect(join).toMatchObject({
      type: 'join',
      playerToken: HOST_TOKEN,
      displayName: HOST.displayName,
    });
  });

  it('reconnects after a normal (1000) close instead of ending the seat', () => {
    const store = new MemoryTokenStore();
    store.save({ ...HOST_SESSION, playerToken: HOST_TOKEN });
    const harness = setup({ tokenStore: store });
    const socket = connectAndOpen(harness, HOST_SESSION);

    socket.serverClose(1000, 'proxy restart');
    expect(harness.statuses.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(DEFAULT_RECONNECT_BASE_MS);
    expect(harness.sockets).toHaveLength(2);

    lastSocket(harness.sockets).open();
    expect(parseClientMessage(lastSocket(harness.sockets).sent[0] ?? '')).toMatchObject({
      type: 'join',
      playerToken: HOST_TOKEN,
    });
  });

  it('backs off further on each failed reconnect attempt', () => {
    const store = new MemoryTokenStore();
    store.save({ ...HOST_SESSION, playerToken: HOST_TOKEN });
    const harness = setup({ tokenStore: store, backoffMs: (attempt) => (attempt + 1) * 100 });
    const socket = connectAndOpen(harness, HOST_SESSION);

    socket.serverClose(1006);
    vi.advanceTimersByTime(100);
    expect(harness.sockets).toHaveLength(2);

    // The second reconnect is opened but never reaches `open`; its close uses
    // the next, larger backoff.
    lastSocket(harness.sockets).serverClose(1006);
    vi.advanceTimersByTime(199);
    expect(harness.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(harness.sockets).toHaveLength(3);
  });

  it('reports offline after the configured reconnect attempts are exhausted', () => {
    const store = new MemoryTokenStore();
    store.save({ ...HOST_SESSION, playerToken: HOST_TOKEN });
    const harness = setup({ tokenStore: store, maxReconnectAttempts: 1 });
    const socket = connectAndOpen(harness, HOST_SESSION);

    socket.serverClose(1006);
    vi.advanceTimersByTime(DEFAULT_RECONNECT_BASE_MS);
    expect(harness.sockets).toHaveLength(2);

    lastSocket(harness.sockets).serverClose(1006);
    expect(harness.statuses.at(-1)).toBe('offline');
    vi.advanceTimersByTime(60_000);
    expect(harness.sockets).toHaveLength(2);
  });

  it('counts attempts that open and then drop before recovery', () => {
    const store = new MemoryTokenStore();
    store.save({ ...HOST_SESSION, playerToken: HOST_TOKEN });
    const harness = setup({ tokenStore: store, maxReconnectAttempts: 2 });
    const socket = connectAndOpen(harness, HOST_SESSION);

    socket.serverClose(1006);
    vi.advanceTimersByTime(DEFAULT_RECONNECT_BASE_MS);
    const second = lastSocket(harness.sockets);
    second.open();
    second.serverClose(1006);

    vi.advanceTimersByTime(DEFAULT_RECONNECT_BASE_MS * 2);
    const third = lastSocket(harness.sockets);
    third.open();
    third.serverClose(1006);

    expect(harness.sockets).toHaveLength(3);
    expect(harness.statuses.at(-1)).toBe('offline');
    vi.advanceTimersByTime(60_000);
    expect(harness.sockets).toHaveLength(3);
  });

  it('flushes messages queued during backoff after the resume join', () => {
    const store = new MemoryTokenStore();
    store.save({ ...HOST_SESSION, playerToken: HOST_TOKEN });
    const harness = setup({ tokenStore: store });
    const socket = connectAndOpen(harness, HOST_SESSION);

    socket.serverClose(1006);
    harness.transport.send(READY_MESSAGE);
    vi.advanceTimersByTime(DEFAULT_RECONNECT_BASE_MS);
    const resumed = lastSocket(harness.sockets);
    resumed.open();

    expect(resumed.sent).toHaveLength(2);
    expect(parseClientMessage(resumed.sent[0] ?? '')).toMatchObject({
      type: 'join',
      playerToken: HOST_TOKEN,
    });
    expect(parseClientMessage(resumed.sent[1] ?? '')).toMatchObject({ type: 'ready' });
  });

  it('ignores a stale close event dispatched after the socket was replaced', () => {
    const store = new MemoryTokenStore();
    store.save({ ...HOST_SESSION, playerToken: HOST_TOKEN });
    const harness = setup({ tokenStore: store });
    const socket = connectAndOpen(harness, HOST_SESSION);

    // Keep the detached handler: a browser can still dispatch a queued close
    // after the transport dropped the socket, and it must not double-recover.
    const staleClose = socket.onclose;
    socket.serverClose(1006);
    staleClose?.({ code: 1006, reason: 'late duplicate' });
    expect(harness.errors).toEqual(['connection-lost']);
    expect(harness.statuses.at(-1)).toBe('reconnecting');

    vi.advanceTimersByTime(DEFAULT_RECONNECT_BASE_MS);
    expect(harness.sockets).toHaveLength(2);
  });

  it('caps the default exponential backoff', () => {
    expect(defaultReconnectDelay(0)).toBe(DEFAULT_RECONNECT_BASE_MS);
    expect(defaultReconnectDelay(1)).toBe(DEFAULT_RECONNECT_BASE_MS * 2);
    expect(defaultReconnectDelay(20)).toBe(DEFAULT_RECONNECT_MAX_MS);
  });

  it('uses injected backoff timers', () => {
    const store = new MemoryTokenStore();
    store.save({ ...HOST_SESSION, playerToken: HOST_TOKEN });
    const scheduled: { handler: () => void; delay: number }[] = [];
    const cleared: unknown[] = [];
    const timers: RoomTransportTimers = {
      setTimeout(handler, delay) {
        scheduled.push({ handler, delay });
        return scheduled.length;
      },
      clearTimeout(handle) {
        cleared.push(handle);
      },
    };
    const sockets: FakeSocket[] = [];
    const transport = createRoomTransport({
      tokenStore: store,
      location: LOCATION,
      env: {},
      timers,
      randomId: () => 'timer',
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    transport.connect(HOST_SESSION);
    socketAt(sockets, 0).open();
    socketAt(sockets, 0).serverClose(1006);

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delay).toBe(DEFAULT_RECONNECT_BASE_MS);
    scheduled[0]?.handler();
    expect(sockets).toHaveLength(2);

    socketAt(sockets, 1).open();
    socketAt(sockets, 1).serverClose(1006);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]?.delay).toBe(DEFAULT_RECONNECT_BASE_MS * 2);

    transport.close();
    expect(cleared).toEqual([2]);
    scheduled[1]?.handler();
    expect(sockets).toHaveLength(2);
  });

  it('reports a lost connection without a token instead of looping', () => {
    const harness = setup();
    const socket = connectAndOpen(harness, HOST_SESSION);

    socket.serverClose(1006);
    expect(harness.errors).toEqual(['connection-lost']);
    expect(harness.statuses.at(-1)).toBe('offline');
    vi.advanceTimersByTime(60_000);
    expect(harness.sockets).toHaveLength(1);
  });

  it('stops permanently when the seat was replaced elsewhere', () => {
    const store = new MemoryTokenStore();
    store.save({ ...HOST_SESSION, playerToken: HOST_TOKEN });
    const harness = setup({ tokenStore: store });
    const socket = connectAndOpen(harness, HOST_SESSION);

    socket.serverClose(4001, 'session-replaced');
    expect(harness.errors).toEqual(['session-replaced']);
    expect(harness.statuses.at(-1)).toBe('closed');
    // The replaced seat's local token must not be reused by a later mount.
    expect(store.cleared).toEqual([ROOM_ID]);
    vi.advanceTimersByTime(60_000);
    expect(harness.sockets).toHaveLength(1);
  });

  it('stops reconnecting and reports room-not-found from a resume join', () => {
    const store = new MemoryTokenStore();
    store.save({ ...HOST_SESSION, playerToken: HOST_TOKEN });
    const harness = setup({ tokenStore: store });
    const socket = connectAndOpen(harness, HOST_SESSION);

    // Drop the first socket, reconnect, and let the resumed join be rejected.
    socket.serverClose(1006);
    vi.advanceTimersByTime(DEFAULT_RECONNECT_BASE_MS);
    const resumed = lastSocket(harness.sockets);
    expect(harness.sockets).toHaveLength(2);
    resumed.open();
    resumed.receive(errorMessage('room-not-found'));

    expect(harness.messages).toEqual([errorMessage('room-not-found')]);
    expect(harness.statuses.at(-1)).toBe('closed');
    expect(resumed.closed).toMatchObject({ code: 1000, reason: 'client-close' });
    expect(store.cleared).toEqual([ROOM_ID]);

    vi.advanceTimersByTime(60_000);
    expect(harness.sockets).toHaveLength(2);
  });

  it('stops after room_closed and clears the dissolved seat token', () => {
    const store = new MemoryTokenStore();
    store.save({ ...HOST_SESSION, playerToken: HOST_TOKEN });
    const harness = setup({ tokenStore: store });
    const socket = connectAndOpen(harness, HOST_SESSION);

    socket.receive(ROOM_CLOSED);
    expect(harness.messages).toEqual([ROOM_CLOSED]);
    expect(store.cleared).toEqual([ROOM_ID]);
    expect(harness.statuses.at(-1)).toBe('closed');
    expect(socket.closed).toMatchObject({ code: 1000, reason: 'client-close' });

    // A later transport close must not reopen the dissolved room.
    socket.serverClose(1006);
    expect(harness.errors).toEqual([]);
    expect(harness.statuses.at(-1)).toBe('closed');
    vi.advanceTimersByTime(60_000);
    expect(harness.sockets).toHaveLength(1);
  });

  it.each([1003, 1008])('stops on the unrecoverable close code %i', (code) => {
    const store = new MemoryTokenStore();
    store.save({ ...HOST_SESSION, playerToken: HOST_TOKEN });
    const harness = setup({ tokenStore: store });
    const socket = connectAndOpen(harness, HOST_SESSION);

    socket.serverClose(code, 'server closed the socket');
    expect(harness.errors).toEqual(['connection-lost']);
    expect(harness.statuses.at(-1)).toBe('closed');
    vi.advanceTimersByTime(60_000);
    expect(harness.sockets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle and cleanup
// ---------------------------------------------------------------------------

describe('online room transport lifecycle', () => {
  it('tells late status subscribers the current status and unsubscribes cleanly', () => {
    const harness = setup();
    expect(harness.statuses).toEqual(['idle']);

    const socket = connectAndOpen(harness, HOST_SESSION);
    expect(socket.sent).toEqual([]);

    const seen: RoomConnectionStatus[] = [];
    const unsubscribe = harness.transport.onStatus((status) => seen.push(status));
    expect(seen).toEqual(['connected']);

    unsubscribe();
    harness.transport.close();
    expect(seen).toEqual(['connected']);
    expect(harness.statuses.at(-1)).toBe('closed');
  });

  it('close() clears pending work, closes the socket and is safe to repeat', () => {
    const harness = setup();
    const socket = connectAndOpen(harness, HOST_SESSION);
    harness.transport.send(READY_MESSAGE);
    expect(socket.sent).toHaveLength(1);

    harness.transport.close();
    harness.transport.close();
    expect(harness.statuses.at(-1)).toBe('closed');
    expect(socket.closed).toMatchObject({ code: 1000, reason: 'client-close' });

    // A message after close must not throw or reach the closed socket.
    harness.transport.send(READY_MESSAGE);
    expect(socket.sent).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(harness.sockets).toHaveLength(1);
  });

  it('close() cancels a scheduled reconnect', () => {
    const store = new MemoryTokenStore();
    store.save({ ...HOST_SESSION, playerToken: HOST_TOKEN });
    const harness = setup({ tokenStore: store });
    const socket = connectAndOpen(harness, HOST_SESSION);

    socket.serverClose(1006);
    expect(harness.statuses.at(-1)).toBe('reconnecting');
    harness.transport.close();
    expect(harness.statuses.at(-1)).toBe('closed');

    vi.advanceTimersByTime(60_000);
    expect(harness.sockets).toHaveLength(1);
  });

  it('connect() after close reloads the stored token for the next reconnect', () => {
    const store = new MemoryTokenStore();
    store.save({ ...GUEST_SESSION, playerToken: GUEST_TOKEN });
    const harness = setup({ tokenStore: store });
    // A policy close is terminal; no reconnect is scheduled.
    connectAndOpen(harness, GUEST_SESSION).serverClose(1008, 'unsupported client');
    expect(harness.statuses.at(-1)).toBe('closed');
    harness.transport.close();
    vi.advanceTimersByTime(60_000);
    expect(harness.sockets).toHaveLength(1);

    const reopened = connectAndOpen(harness, { ...GUEST_SESSION, playerToken: null });
    expect(reopened.url).toBe('wss://play.example/ws');
    expect(harness.statuses.at(-1)).toBe('connected');

    // The fresh transport loaded the stored seat, so the next drop rejoins it.
    reopened.serverClose(1006);
    vi.advanceTimersByTime(DEFAULT_RECONNECT_BASE_MS);
    const resumed = lastSocket(harness.sockets);
    resumed.open();
    expect(parseClientMessage(resumed.sent[0] ?? '')).toMatchObject({
      type: 'join',
      playerToken: GUEST_TOKEN,
      displayName: GUEST_SESSION.displayName,
    });
  });

  it('reports connection-lost when the socket factory cannot create a socket', () => {
    const statuses: RoomConnectionStatus[] = [];
    const errors: ConnectionErrorCode[] = [];
    const transport = createRoomTransport({
      tokenStore: new MemoryTokenStore(),
      location: LOCATION,
      env: {},
      socketFactory: () => {
        throw new Error('constructor unavailable');
      },
    });
    transport.onStatus((status) => statuses.push(status));
    transport.onError((code) => errors.push(code));

    transport.connect(HOST_SESSION);
    expect(statuses.at(-1)).toBe('offline');
    expect(errors).toEqual(['connection-lost']);
  });
});
