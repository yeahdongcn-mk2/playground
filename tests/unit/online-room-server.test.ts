import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  broadcastToSeats,
  createRoomId,
  HEARTBEAT_INTERVAL_MS,
  issuePlayerToken,
  JOIN_TIMEOUT_MS,
  MATCH_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  ROOM_CAPACITY,
  roomErrorMessage,
  roomStateDeliveries,
  seatedCommandSuccess,
  TURN_TIMEOUT_MS,
  type MatchCommandResult,
  type MatchRoomManager,
  type PresenceController,
  type PresenceSocket,
  type RoomCommandResult,
  type RoomConnection,
  type RoomDelivery,
  type RoomErrorCode,
  type RoomRecord,
  type RoomSeat,
} from '../../server/room/contracts';
import {
  createDeadlineScheduler,
  type DeadlineScheduler,
} from '../../server/room/deadline-scheduler';
import {
  createPresenceController,
  type PresenceClock,
  type PresenceTimer,
} from '../../server/room/presence';
import { createRoomManager, type InMemoryRoomManager } from '../../server/room/room-manager';
import {
  ROOM_HEALTH_PATH,
  ROOM_WS_PATH,
  RoomSocketHub,
  startRoomServer,
  type RoomServer,
} from '../../server/room/ws-server';
import {
  PROTOCOL_VERSION,
  createProtocolError,
} from '../../src/games/minesweeper/online/index';
import type {
  ActionMessage,
  ActionResultMessage,
  ClientToServerMessage,
  CreateMessage,
  JoinMessage,
  LeaveMessage,
  ProtocolErrorCode,
  ReadyMessage,
  RematchMessage,
  RoomClosedMessage,
  RoomStateMessage,
  ServerToClientMessage,
  SnapshotMessage,
  StartMessage,
  TimeoutMessage,
  TimeoutTimer,
} from '../../src/games/minesweeper/online/index';

const CONFIG: CreateMessage['config'] = {
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
};

const servers: RoomServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.terminate();
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

function commandFailure(code: RoomErrorCode): RoomCommandResult {
  return { ok: false, code, error: roomErrorMessage(code) };
}

/** Build a match-layer rejection carrying a shared protocol code. */
function matchFailure(
  code: ProtocolErrorCode,
  roomId: string,
  currentSeq: number,
  message: string,
): MatchCommandResult {
  return {
    ok: false,
    code,
    error: createProtocolError(code, { roomId, currentSeq, message }),
  };
}

/**
 * Minimal in-memory manager used to exercise the transport in isolation.
 *
 * It follows the real delivery contract: `create`/`join` bind the requesting
 * connection to its seat token and every accepted command returns the
 * per-seat `room_state` deliveries built by `contracts.ts`. It also carries a
 * deliberately small token-resume path (seat restored in place, current
 * `seq`/`deadlineAt`, optional playing snapshot) so the transport's rebinding
 * and delivery order can be tested; real reconnect and lifecycle correctness
 * stay in the room-manager tests.
 */
class FakeRoomManager implements MatchRoomManager {
  readonly calls: string[] = [];
  /** Makes the next `join` throw, exercising the transport's fault boundary. */
  throwOnNextJoin = false;
  /** Last action that reached the manager, so the transport forward is visible. */
  lastAction: ActionMessage | null = null;
  private config: CreateMessage['config'] = CONFIG;
  private roomId = '';
  private state: RoomRecord['state'] = 'idle';
  private seq = 0;
  private hostId = '';
  private seats: readonly RoomSeat[] = [];
  private matchId: string | null = null;
  private turnPlayerId: string | null = null;
  private turnId = 0;
  private deadlineAt: number | null = null;
  private readonly joinDeadlineAt = Date.now() + JOIN_TIMEOUT_MS;

  get room(): RoomRecord {
    return this.snapshot();
  }

  create(_connection: RoomConnection, message: CreateMessage): RoomCommandResult {
    this.calls.push('create');
    const seat = this.makeSeat(message.displayName, true);
    this.config = message.config;
    this.roomId = createRoomId();
    this.hostId = seat.playerId;
    this.seats = [seat];
    this.state = 'waiting';
    this.seq = 1;
    return seatedCommandSuccess(this.snapshot(), seat);
  }

  join(_connection: RoomConnection, message: JoinMessage): RoomCommandResult {
    this.calls.push('join');
    if (this.throwOnNextJoin) {
      this.throwOnNextJoin = false;
      throw new Error('fake room manager failure');
    }
    if (this.roomId === '' || message.roomId !== this.roomId) {
      return commandFailure('room-not-found');
    }
    // A `join` carrying an existing token resumes that seat: no new seat, no
    // seq/deadline movement, and a playing room also re-sends its snapshot.
    if (message.playerToken !== undefined) {
      const resumed = this.seats.find(
        (seat) => seat.playerToken === message.playerToken,
      );
      if (resumed !== undefined) {
        return this.resumeSeat(resumed);
      }
    }
    if (this.seats.length >= ROOM_CAPACITY) {
      return commandFailure('room-full');
    }
    const seat = this.makeSeat(message.displayName, false);
    this.seats = [...this.seats, seat];
    this.seq += 1;
    return seatedCommandSuccess(this.snapshot(), seat);
  }

  ready(connection: RoomConnection, message: ReadyMessage): RoomCommandResult {
    this.calls.push('ready');
    if (this.roomId === '' || message.roomId !== this.roomId) {
      return commandFailure('room-not-found');
    }
    const index = this.seats.findIndex(
      (seat) => seat.playerToken === connection.playerToken,
    );
    if (index === -1) {
      return commandFailure('not-in-room');
    }
    const seats = this.seats.map((seat, position) =>
      position === index ? { ...seat, ready: message.ready } : seat,
    );
    this.seats = seats;
    this.state = seats.every((seat) => seat.ready) ? 'ready' : 'waiting';
    this.seq += 1;
    return { ok: true, deliveries: roomStateDeliveries(this.snapshot()) };
  }

  start(connection: RoomConnection, message: StartMessage): RoomCommandResult {
    this.calls.push('start');
    const host = this.seats.find((seat) => seat.isHost);
    if (host === undefined || host.playerToken !== connection.playerToken) {
      return commandFailure('not-host');
    }
    if (message.roomId !== this.roomId) {
      return commandFailure('room-not-found');
    }
    this.beginMatch();
    return { ok: true, deliveries: roomStateDeliveries(this.snapshot()) };
  }

  /**
   * Put the fake room into a playing match so `action` has a current turn.
   *
   * The transport test only needs the command seam; turn arbitration and board
   * rules are covered by the room lifecycle and match tests.
   */
  beginMatch(): void {
    this.state = 'playing';
    this.matchId = 'match_fake';
    this.seq += 1;
    this.turnId += 1;
    this.turnPlayerId = this.seats.find((seat) => seat.isHost)?.playerId ?? null;
    this.deadlineAt = Date.now() + TURN_TIMEOUT_MS;
  }

  action(connection: RoomConnection, message: ActionMessage): MatchCommandResult {
    this.calls.push('action');
    this.lastAction = message;
    const seat = this.seats.find(
      (candidate) => candidate.playerToken === connection.playerToken,
    );
    if (seat === undefined || this.matchId === null || message.roomId !== this.roomId) {
      return matchFailure('invalid-action', message.roomId, this.seq, 'no running match');
    }
    if (message.matchId !== this.matchId) {
      return matchFailure('invalid-action', message.roomId, this.seq, 'stale match id');
    }
    if (seat.playerId !== this.turnPlayerId) {
      return matchFailure('not-your-turn', message.roomId, this.seq, 'not this seat\'s turn');
    }

    this.seq += 1;
    this.turnId += 1;
    const actionResult: ActionResultMessage = {
      type: 'action_result',
      roomId: this.roomId,
      matchId: this.matchId,
      actionId: message.actionId,
      seq: this.seq,
      turnId: message.turnId,
      accepted: true,
      reason: null,
      revealedCells: [],
      flaggedCell: null,
      turnPlayerId: seat.playerId,
      deadlineAt: this.deadlineAt ?? this.joinDeadlineAt,
    };
    const snapshot = this.matchSnapshot(message.turnId);
    // Same delivery shape as the real manager: the verdict goes to the actor,
    // the snapshot is broadcast to every seat.
    return {
      ok: true,
      deliveries: [
        { playerToken: seat.playerToken, message: actionResult },
        ...this.seats.map((current) => ({ playerToken: current.playerToken, message: snapshot })),
      ],
    };
  }

  leave(connection: RoomConnection, message: LeaveMessage): RoomCommandResult {
    this.calls.push('leave');
    if (message.roomId !== this.roomId) {
      return commandFailure('room-not-found');
    }
    const seat = this.seats.find(
      (candidate) => candidate.playerToken === connection.playerToken,
    );
    if (seat === undefined) {
      return commandFailure('not-in-room');
    }
    this.seats = this.seats.filter((candidate) => candidate !== seat);
    this.seq += 1;
    // A host leaving a lobby dissolves the room. The real manager builds its
    // final broadcast before forgetting the seat, so the leaving socket still
    // receives room_closed; mirror that so the transport's
    // deliver-before-unbind order is actually covered.
    if (seat.isHost) {
      this.state = 'dissolved';
      const closed: RoomClosedMessage = {
        type: 'room_closed',
        roomId: this.roomId,
        seq: this.seq,
        reason: 'host-left',
        finalState: 'dissolved',
      };
      const deliveries: RoomDelivery[] = [...roomStateDeliveries(this.snapshot())];
      deliveries.push({ playerToken: seat.playerToken, message: closed });
      return { ok: true, deliveries };
    }
    return { ok: true, deliveries: roomStateDeliveries(this.snapshot()) };
  }

  rematch(_connection: RoomConnection, _message: RematchMessage): RoomCommandResult {
    this.calls.push('rematch');
    return commandFailure('invalid-state');
  }

  dissolve(_roomId: string, _reason: string): RoomCommandResult {
    this.calls.push('dissolve');
    return commandFailure('room-not-found');
  }

  timeout(_roomId: string, _timer: TimeoutTimer): RoomCommandResult {
    this.calls.push('timeout');
    return commandFailure('room-not-found');
  }

  /**
   * Resume an existing seat in place, as the real manager does for a reconnect:
   * no new seat, no `seq` change and no deadline movement. A playing match also
   * re-sends the current full snapshot to every seat.
   */
  private resumeSeat(seat: RoomSeat): RoomCommandResult {
    this.seats = this.seats.map((current) =>
      current === seat ? { ...current, presence: 'online' } : current,
    );
    const deliveries: RoomDelivery[] = [...roomStateDeliveries(this.snapshot())];
    if (this.state === 'playing') {
      const snapshot = this.matchSnapshot(this.turnId);
      for (const current of this.seats) {
        deliveries.push({ playerToken: current.playerToken, message: snapshot });
      }
    }
    return { ok: true, deliveries, boundToken: seat.playerToken };
  }

  /** Build the current playing snapshot, shared by `action` and reconnect. */
  private matchSnapshot(turnId: number): SnapshotMessage {
    if (this.matchId === null) {
      throw new Error('fake room has no running match');
    }
    const turnPlayerId = this.turnPlayerId;
    if (turnPlayerId === null) {
      throw new Error('fake room has no current turn player');
    }
    return {
      type: 'snapshot',
      roomId: this.roomId,
      matchId: this.matchId,
      seq: this.seq,
      turnPlayerId,
      turnId,
      deadlineAt: this.deadlineAt ?? this.joinDeadlineAt,
      matchDeadlineAt: this.joinDeadlineAt,
      seedHash: 'fake-seed-hash',
      engineStatus: 'playing',
      mineCount: this.config.mines,
      remainingMines: this.config.mines,
      revealedSafeCount: 1,
      elapsedMs: 0,
      board: [],
    };
  }

  private makeSeat(displayName: string, isHost: boolean): RoomSeat {
    return {
      playerId: `player-${this.seats.length + 1}`,
      playerToken: issuePlayerToken(),
      displayName,
      ready: false,
      presence: 'online',
      isHost,
      joinedAt: Date.now(),
    };
  }

  private snapshot(): RoomRecord {
    return {
      roomId: this.roomId,
      config: this.config,
      capacity: ROOM_CAPACITY,
      state: this.state,
      seq: this.seq,
      hostId: this.hostId,
      seats: this.seats,
      matchId: this.matchId,
      turnPlayerId: this.turnPlayerId,
      joinDeadlineAt: this.joinDeadlineAt,
      deadlineAt: this.deadlineAt,
      stateReason: null,
    };
  }
}

/** A real WebSocket client that queues server frames for ordered assertions. */
class TestClient {
  private readonly socket: WebSocket;
  private readonly queued: ServerToClientMessage[] = [];
  private readonly waiting: ((message: ServerToClientMessage) => void)[] = [];
  private readonly closeInfo: Promise<{ readonly code: number; readonly reason: string }>;
  /** Every frame received, kept for "exactly once" assertions. */
  readonly received: ServerToClientMessage[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.closeInfo = new Promise((resolve) => {
      socket.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerToClientMessage;
      this.received.push(message);
      const waiter = this.waiting.shift();
      if (waiter !== undefined) {
        waiter(message);
        return;
      }
      this.queued.push(message);
    });
    socket.on('error', () => undefined);
  }

  static async connect(
    port: number,
    options: { readonly autoPong?: boolean } = {},
  ): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${ROOM_WS_PATH}`, options);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (error) => reject(error));
    });
    return new TestClient(socket);
  }

  send(message: ClientToServerMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(text: string): void {
    this.socket.send(text);
  }

  sendBinary(data: Buffer): void {
    this.socket.send(data, { binary: true });
  }

  next(): Promise<ServerToClientMessage> {
    const message = this.queued.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  closed(): Promise<void> {
    return this.closeInfo.then(() => undefined);
  }

  /** Close code/reason of this socket, whether or not it has already closed. */
  closedWith(): Promise<{ readonly code: number; readonly reason: string }> {
    return this.closeInfo;
  }

  terminate(): void {
    this.socket.terminate();
  }
}

type FakeSocketListener = (...args: unknown[]) => void;

/**
 * Server-side socket double for driving {@link RoomSocketHub} directly.
 *
 * The transport only needs `on`, `send`, `ping`, `close`, `terminate` and
 * `readyState`, so the fake records outgoing frames and close calls and lets a
 * test emit `message` / `pong` events at a deterministic point in time — in
 * particular after a replacement has closed the socket but before its `close`
 * event would arrive.
 */
class FakeServerSocket {
  readyState: number = WebSocket.OPEN;
  readonly sent: ServerToClientMessage[] = [];
  readonly closeCalls: { readonly code?: number; readonly reason?: string }[] = [];
  private readonly listeners = new Map<string, FakeSocketListener[]>();

  on(event: string, listener: FakeSocketListener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as ServerToClientMessage);
  }

  ping(): void {
    // The hub's presence adapter pings; the fake has no network to ping.
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

/** First `room_state` frame a fake server socket received. */
function firstRoomState(socket: FakeServerSocket): RoomStateMessage {
  const message = socket.sent.find((candidate) => candidate.type === 'room_state');
  if (message === undefined || message.type !== 'room_state') {
    throw new Error('expected a room_state frame');
  }
  return message;
}

interface TestTimer {
  dueAt: number;
  readonly intervalMs: number | null;
  readonly callback: () => void;
}

/**
 * Deterministic clock shared by the room manager, presence controller and
 * deadline scheduler.
 *
 * `advance` runs due callbacks in due/creation order, letting a callback arm
 * the next timer at the advanced instant; intervals re-arm themselves. This is
 * the transport-level counterpart of the scheduler's own clock double: it
 * proves the real manager and the real transport agree on deadlines without
 * sleeping through a 30 s turn or a 120 s join window.
 */
class TestClock implements PresenceClock {
  private current: number;
  private nextHandle = 1;
  private readonly timers = new Map<number, TestTimer>();

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): PresenceTimer {
    return this.schedule(callback, delayMs, null);
  }

  setInterval(callback: () => void, intervalMs: number): PresenceTimer {
    return this.schedule(callback, intervalMs, intervalMs);
  }

  clearTimeout(handle: PresenceTimer): void {
    this.timers.delete(handle as unknown as number);
  }

  clearInterval(handle: PresenceTimer): void {
    this.timers.delete(handle as unknown as number);
  }

  advance(ms: number): void {
    const target = this.current + ms;
    for (let guard = 0; guard < 100_000; guard += 1) {
      let nextId: number | null = null;
      let nextEntry: TestTimer | null = null;
      for (const [id, entry] of this.timers) {
        if (entry.dueAt > target) {
          continue;
        }
        if (
          nextEntry === null ||
          entry.dueAt < nextEntry.dueAt ||
          (entry.dueAt === nextEntry.dueAt && id < (nextId ?? 0))
        ) {
          nextId = id;
          nextEntry = entry;
        }
      }
      if (nextId === null || nextEntry === null) {
        this.current = target;
        return;
      }
      this.current = nextEntry.dueAt;
      if (nextEntry.intervalMs === null) {
        this.timers.delete(nextId);
      } else {
        nextEntry.dueAt += nextEntry.intervalMs;
      }
      nextEntry.callback();
    }
    throw new Error('test clock fired too many timers');
  }

  get timerCount(): number {
    return this.timers.size;
  }

  /** Earliest pending due time, or null when nothing is armed. */
  nextDueAt(): number | null {
    let earliest: number | null = null;
    for (const entry of this.timers.values()) {
      if (earliest === null || entry.dueAt < earliest) {
        earliest = entry.dueAt;
      }
    }
    return earliest;
  }

  private schedule(
    callback: () => void,
    delayMs: number,
    intervalMs: number | null,
  ): PresenceTimer {
    const id = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(id, { dueAt: this.current + delayMs, intervalMs, callback });
    return id as unknown as PresenceTimer;
  }
}

interface PresenceEvent {
  readonly kind: 'opened' | 'closed' | 'pong' | 'bound' | 'unbound';
  readonly connectionId: string;
  readonly playerToken: string | null;
}

/**
 * Record the transport→controller hooks and keep the ping adapter handed to
 * `connectionOpened`.
 *
 * The test drives one heartbeat round itself through `ping()` instead of
 * owning a timer: the transport's ping adapter sends a real WebSocket ping,
 * the `ws` client answers it automatically, and the server forwards the pong
 * back as `pongReceived`. No 5 s wait is involved.
 */
class FakePresenceController implements PresenceController {
  readonly events: PresenceEvent[] = [];
  private readonly sockets = new Map<string, PresenceSocket>();
  private readonly tokens = new Map<string, string>();

  connectionOpened(connectionId: string, socket: PresenceSocket): void {
    this.sockets.set(connectionId, socket);
    this.events.push({ kind: 'opened', connectionId, playerToken: null });
  }

  connectionClosed(connectionId: string): void {
    this.events.push({
      kind: 'closed',
      connectionId,
      playerToken: this.tokens.get(connectionId) ?? null,
    });
    this.sockets.delete(connectionId);
    this.tokens.delete(connectionId);
  }

  pongReceived(connectionId: string): void {
    this.events.push({
      kind: 'pong',
      connectionId,
      playerToken: this.tokens.get(connectionId) ?? null,
    });
  }

  tokenBound(connectionId: string, playerToken: string): void {
    this.tokens.set(connectionId, playerToken);
    this.events.push({ kind: 'bound', connectionId, playerToken });
  }

  tokenUnbound(connectionId: string): void {
    const playerToken = this.tokens.get(connectionId) ?? null;
    this.tokens.delete(connectionId);
    this.events.push({ kind: 'unbound', connectionId, playerToken });
  }

  /** Send one heartbeat ping through the adapter the transport handed over. */
  ping(connectionId: string): void {
    const socket = this.sockets.get(connectionId);
    if (socket === undefined) {
      throw new Error(`no presence socket for ${connectionId}`);
    }
    socket.ping();
  }
}

/**
 * Presence controller that throws from every hook.
 *
 * The transport promises that an observer fault cannot break socket
 * bookkeeping, replacement, delivery or event-listener isolation; this fake
 * makes each of those promises falsifiable. It still records the adapter and
 * the hook calls so the test can drive a heartbeat round and prove that the
 * throw happened at the transport boundary instead of never being invoked.
 */
class ThrowingPresenceController implements PresenceController {
  readonly calls: string[] = [];
  readonly openedIds: string[] = [];
  readonly closedIds: string[] = [];
  private readonly sockets = new Map<string, PresenceSocket>();

  connectionOpened(connectionId: string, socket: PresenceSocket): void {
    this.openedIds.push(connectionId);
    this.sockets.set(connectionId, socket);
    this.fail('connectionOpened');
  }

  connectionClosed(connectionId: string): void {
    this.closedIds.push(connectionId);
    this.fail('connectionClosed');
  }

  pongReceived(): void {
    this.fail('pongReceived');
  }

  tokenBound(): void {
    this.fail('tokenBound');
  }

  tokenUnbound(): void {
    this.fail('tokenUnbound');
  }

  /** Send one heartbeat ping through the adapter stored before the throw. */
  ping(connectionId: string): void {
    this.sockets.get(connectionId)?.ping();
  }

  private fail(hook: string): never {
    this.calls.push(hook);
    throw new Error(`presence ${hook} threw`);
  }
}

/** Wait for an asynchronous controller event without fixed sleeps. */
async function waitForPresence(
  controller: FakePresenceController,
  predicate: (event: PresenceEvent) => boolean,
  description: string,
): Promise<void> {
  await vi.waitFor(
    () => {
      if (!controller.events.some(predicate)) {
        throw new Error(`timed out waiting for ${description}`);
      }
    },
    { interval: 10, timeout: 2_000 },
  );
}

/** Connection id the controller reported for a bound token. */
function connectionIdForToken(
  controller: FakePresenceController,
  playerToken: string,
): string {
  const event = controller.events.find(
    (candidate) =>
      candidate.kind === 'bound' && candidate.playerToken === playerToken,
  );
  if (event === undefined) {
    throw new Error(`no connection is bound to ${playerToken}`);
  }
  return event.connectionId;
}

function createMessage(overrides: Partial<CreateMessage> = {}): CreateMessage {
  return {
    type: 'create',
    requestId: 'req-create',
    protocolVersion: PROTOCOL_VERSION,
    config: CONFIG,
    displayName: 'Host',
    ...overrides,
  };
}

function joinMessage(roomId: string, overrides: Partial<JoinMessage> = {}): JoinMessage {
  return {
    type: 'join',
    requestId: 'req-join',
    protocolVersion: PROTOCOL_VERSION,
    roomId,
    displayName: 'Guest',
    ...overrides,
  };
}

function readyMessage(roomId: string, ready: boolean): ReadyMessage {
  return { type: 'ready', requestId: 'req-ready', roomId, ready };
}

function startMessage(roomId: string): StartMessage {
  return { type: 'start', requestId: 'req-start', roomId };
}

/** Wire-valid action echoing the fake room's current seq and match id. */
function actionMessage(
  manager: FakeRoomManager,
  overrides: Partial<ActionMessage> = {},
): ActionMessage {
  return {
    type: 'action',
    roomId: manager.room.roomId,
    matchId: manager.room.matchId ?? 'match_missing',
    actionId: 'action-1',
    seq: manager.room.seq,
    turnId: 0,
    kind: 'reveal',
    row: 0,
    col: 0,
    clientTimeMs: 0,
    ...overrides,
  };
}

async function startTestServer(
  manager: MatchRoomManager,
  presence?: PresenceController,
  deadlines?: DeadlineScheduler,
): Promise<RoomServer> {
  const server = await startRoomServer({
    manager,
    presence,
    deadlines,
    host: '127.0.0.1',
    port: 0,
  });
  servers.push(server);
  return server;
}

/**
 * Wait until one client has received a frame of `type` matching `predicate`.
 *
 * `fromIndex` restricts the search to frames received after that position, so
 * a stale frame from an earlier phase cannot satisfy a "this just happened"
 * assertion. Callers snapshot `client.received.length` before the action.
 */
async function waitForMessage(
  client: TestClient,
  type: ServerToClientMessage['type'],
  predicate: (message: ServerToClientMessage) => boolean = () => true,
  description: string = type,
  fromIndex: number = 0,
): Promise<ServerToClientMessage> {
  await vi.waitFor(
    () => {
      if (
        !client.received
          .slice(fromIndex)
          .some((message) => message.type === type && predicate(message))
      ) {
        throw new Error(`timed out waiting for ${description}`);
      }
    },
    { interval: 5, timeout: 2_000 },
  );
  const found = client.received
    .slice(fromIndex)
    .find((message) => message.type === type && predicate(message));
  if (found === undefined) {
    throw new Error(`missing ${description} after wait`);
  }
  return found;
}

async function connect(port: number): Promise<TestClient> {
  const client = await TestClient.connect(port);
  clients.push(client);
  return client;
}

async function nextRoomState(client: TestClient): Promise<RoomStateMessage> {
  const message = await client.next();
  expect(message.type).toBe('room_state');
  if (message.type !== 'room_state') {
    throw new Error(`expected room_state, received ${message.type}`);
  }
  return message;
}

function requiredToken(state: RoomStateMessage): string {
  if (state.playerToken === undefined) {
    throw new Error('room_state is missing its playerToken');
  }
  return state.playerToken;
}

interface SeatedRoom {
  readonly server: RoomServer;
  readonly host: TestClient;
  readonly guest: TestClient;
  readonly roomId: string;
}

async function createSeatedRoom(
  manager: FakeRoomManager,
  presence?: PresenceController,
): Promise<SeatedRoom> {
  const server = await startTestServer(manager, presence);
  const host = await connect(server.port);
  host.send(createMessage());
  const created = await nextRoomState(host);
  requiredToken(created);

  const guest = await connect(server.port);
  guest.send(joinMessage(created.roomId));
  const guestState = await nextRoomState(guest);
  const hostState = await nextRoomState(host);
  expect(guestState.players).toHaveLength(2);
  expect(hostState.players).toHaveLength(2);
  return { server, host, guest, roomId: created.roomId };
}

describe('room WebSocket/HTTP transport', () => {
  it('serves GET /health and rejects unknown HTTP routes', async () => {
    const server = await startTestServer(new FakeRoomManager());

    const health = await fetch(`http://127.0.0.1:${server.port}${ROOM_HEALTH_PATH}`);
    expect(health.status).toBe(200);
    expect(health.headers.get('content-type')).toContain('application/json');
    expect(await health.json()).toEqual({ status: 'ok' });

    const missing = await fetch(`http://127.0.0.1:${server.port}/missing`);
    expect(missing.status).toBe(404);
  });

  it('rejects a WebSocket upgrade outside the room path', async () => {
    const server = await startTestServer(new FakeRoomManager());
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/not-ws`);

    const outcome = await new Promise<{ readonly statusCode: number | null }>((resolve) => {
      socket.once('unexpected-response', (_request, response) => {
        resolve({ statusCode: response.statusCode ?? null });
      });
      socket.once('open', () => resolve({ statusCode: null }));
    });
    if (socket.readyState === WebSocket.OPEN) {
      socket.terminate();
    }

    expect(outcome.statusCode).toBe(404);
  });

  it('drives create → join → ready over real WebSocket connections', async () => {
    const manager = new FakeRoomManager();
    const server = await startTestServer(manager);
    const host = await connect(server.port);

    host.send(createMessage());
    const created = await nextRoomState(host);
    expect(created.state).toBe('waiting');
    expect(created.players).toHaveLength(1);
    const hostToken = requiredToken(created);
    expect(manager.calls).toEqual(['create']);

    const guest = await connect(server.port);
    guest.send(joinMessage(created.roomId));
    const guestState = await nextRoomState(guest);
    const hostState = await nextRoomState(host);
    expect(guestState.players).toHaveLength(2);
    expect(hostState.players).toHaveLength(2);
    const guestToken = requiredToken(guestState);
    expect(hostState.playerToken).toBe(hostToken);
    expect(guestToken).not.toBe(hostToken);

    // A seat token is a bearer secret: each connection sees only its own.
    expect(JSON.stringify(hostState)).not.toContain(guestToken);
    expect(JSON.stringify(guestState)).not.toContain(hostToken);
    expect(JSON.stringify(hostState.players)).not.toContain(hostToken);
    expect(JSON.stringify(guestState.players)).not.toContain(guestToken);

    host.send(readyMessage(created.roomId, true));
    const hostWaiting = await nextRoomState(host);
    const guestWaiting = await nextRoomState(guest);
    expect(hostWaiting.state).toBe('waiting');
    expect(guestWaiting.state).toBe('waiting');

    guest.send(readyMessage(created.roomId, true));
    const hostReady = await nextRoomState(host);
    const guestReady = await nextRoomState(guest);
    expect(hostReady.state).toBe('ready');
    expect(guestReady.state).toBe('ready');
    expect(hostReady.players.every((player) => player.ready)).toBe(true);
    expect(manager.calls).toEqual(['create', 'join', 'ready', 'ready']);
  });

  it('rejects invalid input and unsupported versions without touching the room', async () => {
    const manager = new FakeRoomManager();
    const server = await startTestServer(manager);
    const client = await connect(server.port);

    client.send(createMessage({ protocolVersion: PROTOCOL_VERSION + 1 }));
    const versionError = await client.next();
    expect(versionError).toMatchObject({
      type: 'error',
      code: 'unsupported-version',
      requestId: 'req-create',
    });

    client.sendRaw('{ not json');
    const malformed = await client.next();
    expect(malformed).toMatchObject({ type: 'error', code: 'bad-request', requestId: null });

    client.sendRaw(JSON.stringify({ type: 'room_state' }));
    const wrongDirection = await client.next();
    expect(wrongDirection).toMatchObject({ type: 'error', code: 'bad-request' });

    // A valid protocol message in a binary frame must be rejected as binary:
    // decoding it as text would otherwise accept the command.
    client.sendBinary(Buffer.from(JSON.stringify(createMessage({ requestId: 'req-binary' }))));
    const binaryFrame = await client.next();
    expect(binaryFrame).toMatchObject({
      type: 'error',
      code: 'bad-request',
      requestId: null,
      message: 'binary messages are not supported',
    });

    client.sendRaw(JSON.stringify({ type: 'bogus', requestId: 'req-unknown' }));
    const unknownType = await client.next();
    expect(unknownType).toMatchObject({
      type: 'error',
      code: 'bad-request',
      requestId: 'req-unknown',
    });

    // A malformed action is still caught by the shared validator, so the
    // manager never sees it.
    client.sendRaw(JSON.stringify({ type: 'action', roomId: 'room-remote' }));
    const malformedAction = await client.next();
    expect(malformedAction).toMatchObject({
      type: 'error',
      code: 'bad-request',
      requestId: null,
      roomId: 'room-remote',
    });

    expect(manager.calls).toEqual([]);
  });

  it('rejects invalid custom configs on a real socket without sending room_state', async () => {
    // Unlike the fake-manager transport tests above, this one runs the real
    // `InMemoryRoomManager` behind the real WebSocket server, so the engine's
    // `validateConfig` rules decide what reaches the table.
    const manager = createRoomManager({
      now: () => 1_700_000_000_000,
      createSeed: () => 7,
    });
    const server = await startTestServer(manager);
    const client = await connect(server.port);

    const invalidConfigs: readonly {
      readonly label: string;
      readonly config: CreateMessage['config'];
    }[] = [
      { label: 'rows-below-min', config: { rows: 4, cols: 12, mines: 20, firstClickSafe: true } },
      { label: 'rows-above-max', config: { rows: 31, cols: 12, mines: 20, firstClickSafe: true } },
      { label: 'cols-below-min', config: { rows: 12, cols: 4, mines: 20, firstClickSafe: true } },
      { label: 'cols-above-max', config: { rows: 12, cols: 31, mines: 20, firstClickSafe: true } },
      { label: 'mines-equal-cells', config: { rows: 5, cols: 5, mines: 25, firstClickSafe: true } },
      {
        label: 'mines-above-safe-capacity',
        config: { rows: 5, cols: 5, mines: 17, firstClickSafe: true },
      },
    ];

    for (const { label, config } of invalidConfigs) {
      const requestId = `req-invalid-${label}`;
      client.send(createMessage({ requestId, config }));
      const error = await client.next();
      expect(error, label).toMatchObject({
        type: 'error',
        code: 'bad-request',
        requestId,
      });
      expect(manager.roomCount, label).toBe(0);
    }

    // A rejected create must be silent about room state: the server has no
    // room whose `seq`, seats or board it could publish.
    expect(client.received.filter((message) => message.type === 'room_state')).toHaveLength(0);

    // The same connection can still create a legal custom board; the wire
    // config reaches the manager unchanged.
    const customConfig: CreateMessage['config'] = {
      rows: 12,
      cols: 12,
      mines: 20,
      firstClickSafe: true,
    };
    client.send(createMessage({ requestId: 'req-valid-custom', config: customConfig }));
    const created = await nextRoomState(client);
    expect(created).toMatchObject({
      type: 'room_state',
      state: 'waiting',
      config: customConfig,
    });
    expect(manager.roomCount).toBe(1);
    expect(manager.getRoom(created.roomId)?.config).toStrictEqual(customConfig);
  });

  it('forwards an action and delivers action_result only to the actor with a snapshot to both', async () => {
    const manager = new FakeRoomManager();
    const { host, guest, roomId } = await createSeatedRoom(manager);
    manager.beginMatch();
    const sent = actionMessage(manager);
    host.send(sent);

    const hostResult = await host.next();
    expect(hostResult).toMatchObject({
      type: 'action_result',
      roomId,
      matchId: 'match_fake',
      actionId: 'action-1',
      accepted: true,
    });
    const hostSnapshot = await host.next();
    expect(hostSnapshot).toMatchObject({ type: 'snapshot', roomId, matchId: 'match_fake' });
    const guestSnapshot = await guest.next();
    expect(guestSnapshot).toMatchObject({ type: 'snapshot', roomId, matchId: 'match_fake' });

    // The transport forwarded the decoded action unchanged, and the guest's
    // first frame is the room broadcast: the actor-only verdict never reached
    // the other seat.
    expect(manager.calls).toEqual(['create', 'join', 'action']);
    expect(manager.lastAction).toEqual(sent);

    // A bearer token is a seat secret and no match message may carry one.
    for (const message of [hostResult, hostSnapshot, guestSnapshot]) {
      for (const seat of manager.room.seats) {
        expect(JSON.stringify(message)).not.toContain(seat.playerToken);
      }
    }
  });

  it('answers a rejected action with a protocol error and keeps the connection usable', async () => {
    const manager = new FakeRoomManager();
    const { host, guest, roomId } = await createSeatedRoom(manager);

    // No match has started, so the manager owns the rejection; the transport
    // must forward its MatchCommandResult.error instead of a local bad-request.
    host.send(actionMessage(manager, { matchId: 'match_missing' }));
    const rejected = await host.next();
    expect(rejected).toMatchObject({ type: 'error', code: 'invalid-action', roomId });
    expect(manager.calls).toEqual(['create', 'join', 'action']);

    // The socket survives a rejected action and still serves requests; the
    // error was not broadcast to the other connection.
    host.send(readyMessage(roomId, true));
    const hostState = await nextRoomState(host);
    const guestState = await nextRoomState(guest);
    expect(hostState.players).toHaveLength(2);
    expect(guestState.players).toHaveLength(2);
    expect(manager.calls).toEqual(['create', 'join', 'action', 'ready']);
  });

  it('reports a manager failure without dropping the connection', async () => {
    const manager = new FakeRoomManager();
    manager.throwOnNextJoin = true;
    const server = await startTestServer(manager);
    const client = await connect(server.port);

    client.send(joinMessage('room-missing', { requestId: 'req-manager-failure' }));
    const failure = await client.next();
    expect(failure).toMatchObject({
      type: 'error',
      code: 'bad-request',
      requestId: 'req-manager-failure',
      roomId: 'room-missing',
    });

    // The socket survives the server-side fault and still serves requests.
    client.send(createMessage());
    const created = await nextRoomState(client);
    expect(created.state).toBe('waiting');
  });

  it('broadcasts timeout and room_closed deliveries to every seated connection', async () => {
    const manager = new FakeRoomManager();
    const { server, host, guest, roomId } = await createSeatedRoom(manager);
    const room = manager.room;

    const timeout: TimeoutMessage = {
      type: 'timeout',
      roomId,
      matchId: null,
      seq: room.seq,
      timer: 'join',
      subjectId: null,
      deadlineAt: room.joinDeadlineAt,
      resultingState: 'dissolved',
      reason: 'join window expired',
    };
    server.deliver(broadcastToSeats(room, timeout));
    const hostTimeout = await host.next();
    const guestTimeout = await guest.next();
    expect(hostTimeout).toMatchObject({ type: 'timeout', roomId, timer: 'join' });
    expect(guestTimeout).toMatchObject({ type: 'timeout', roomId, timer: 'join' });

    const closed: RoomClosedMessage = {
      type: 'room_closed',
      roomId,
      seq: room.seq,
      reason: 'join window expired',
      finalState: 'dissolved',
    };
    server.deliver(broadcastToSeats(room, closed));
    const hostClosed = await host.next();
    const guestClosed = await guest.next();
    expect(hostClosed).toMatchObject({ type: 'room_closed', roomId });
    expect(guestClosed).toMatchObject({ type: 'room_closed', roomId });
  });

  it('keeps room state unchanged when a connection disconnects', async () => {
    const manager = new FakeRoomManager();
    const { server, host, guest, roomId } = await createSeatedRoom(manager);
    const callsBefore = [...manager.calls];

    const guestClosed = guest.closed();
    guest.terminate();
    await guestClosed;
    // `guest.closed()` fires on the client. Yield one event-loop turn so the
    // server also processes the close before asserting that nothing changed.
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.calls).toEqual(callsBefore);
    expect(manager.room.seats).toHaveLength(2);
    expect(manager.room.state).toBe('waiting');

    server.deliver(
      broadcastToSeats(manager.room, {
        type: 'room_closed',
        roomId,
        seq: manager.room.seq,
        reason: 'host closed the room',
        finalState: 'dissolved',
      }),
    );
    const hostClosed = await host.next();
    expect(hostClosed.type).toBe('room_closed');
    expect(manager.calls).toEqual(callsBefore);
  });

  it('drops a delivery for a seat with no live connection instead of re-addressing it', async () => {
    // An offline seat keeps its bearer token in the room state. Build one
    // deterministically (created but never connected) so the assertion does
    // not depend on close-event timing.
    const manager = new FakeRoomManager();
    manager.create({ connectionId: 'offline-host', playerToken: null }, createMessage());
    const offlineSeat = manager.room.seats.find((seat) => seat.isHost);
    if (offlineSeat === undefined) {
      throw new Error('seeded room is missing its host seat');
    }
    const offlineToken = offlineSeat.playerToken;

    const server = await startTestServer(manager);
    const guest = await connect(server.port);
    guest.send(joinMessage(manager.room.roomId));
    const guestState = await nextRoomState(guest);
    const guestToken = requiredToken(guestState);

    // The host seat's per-seat room_state carries its bearer token. With no
    // live connection for that token the delivery must be dropped, never
    // re-addressed to another connection (which would leak the offline token).
    const offlineState = roomStateDeliveries(manager.room).find(
      (delivery) => delivery.playerToken === offlineToken,
    );
    if (offlineState === undefined) {
      throw new Error('expected a room_state delivery for the offline token');
    }
    server.deliver([offlineState]);

    // A distinguishable marker proves the live guest sees only its own delivery.
    const marker: RoomClosedMessage = {
      type: 'room_closed',
      roomId: manager.room.roomId,
      seq: manager.room.seq,
      reason: 'delivery-drop marker',
      finalState: 'dissolved',
    };
    server.deliver([{ playerToken: guestToken, message: marker }]);

    const received = await guest.next();
    expect(received).toEqual(marker);
  });

  it('forwards connection, pong and token bindings to the presence controller', async () => {
    const manager = new FakeRoomManager();
    const presence = new FakePresenceController();
    const server = await startTestServer(manager, presence);
    const client = await connect(server.port);

    await waitForPresence(presence, (event) => event.kind === 'opened', 'connection opened');
    const opened = presence.events.find((event) => event.kind === 'opened');
    if (opened === undefined) {
      throw new Error('missing opened event');
    }
    const connectionId = opened.connectionId;

    client.send(createMessage());
    const created = await nextRoomState(client);
    const hostToken = requiredToken(created);
    await waitForPresence(
      presence,
      (event) =>
        event.kind === 'bound' &&
        event.connectionId === connectionId &&
        event.playerToken === hostToken,
      'host token bound',
    );

    // One real heartbeat round: the controller pings through the adapter the
    // transport handed it, the client answers, and the server forwards the pong.
    presence.ping(connectionId);
    await waitForPresence(
      presence,
      (event) => event.kind === 'pong' && event.connectionId === connectionId,
      'pong forwarded',
    );

    // A successful host leave dissolves the room. The transport must send the
    // result (including the final room_closed addressed to the leaving seat)
    // before releasing the token, so that frame is observable here.
    client.send({ type: 'leave', requestId: 'req-leave', roomId: created.roomId });
    const finalFrame = await client.next();
    expect(finalFrame).toMatchObject({
      type: 'room_closed',
      roomId: created.roomId,
      reason: 'host-left',
      finalState: 'dissolved',
    });
    await waitForPresence(
      presence,
      (event) => event.kind === 'unbound' && event.connectionId === connectionId,
      'host token unbound',
    );

    const closed = client.closed();
    client.terminate();
    await closed;
    await waitForPresence(
      presence,
      (event) => event.kind === 'closed' && event.connectionId === connectionId,
      'connection closed',
    );

    expect(presence.events).toEqual([
      { kind: 'opened', connectionId, playerToken: null },
      { kind: 'bound', connectionId, playerToken: hostToken },
      { kind: 'pong', connectionId, playerToken: hostToken },
      { kind: 'unbound', connectionId, playerToken: hostToken },
      { kind: 'closed', connectionId, playerToken: null },
    ]);
  });

  it('reports a bound token on close instead of a separate unbind', async () => {
    const manager = new FakeRoomManager();
    const presence = new FakePresenceController();
    const server = await startTestServer(manager, presence);
    const client = await connect(server.port);

    client.send(createMessage());
    const created = await nextRoomState(client);
    const hostToken = requiredToken(created);
    await waitForPresence(
      presence,
      (event) => event.kind === 'bound' && event.playerToken === hostToken,
      'host token bound',
    );
    const callsBefore = [...manager.calls];

    const closed = client.closed();
    client.terminate();
    await closed;
    await waitForPresence(
      presence,
      (event) => event.kind === 'closed' && event.playerToken === hostToken,
      'bound connection closed',
    );

    // A socket close while the seat is still bound is reported through
    // `connectionClosed` with the token attached; that is how the controller
    // starts offline detection. A separate `tokenUnbound` would instead look
    // like a deliberate release, so none may be emitted.
    const connectionId = connectionIdForToken(presence, hostToken);
    expect(presence.events.filter((event) => event.connectionId === connectionId)).toEqual([
      { kind: 'opened', connectionId, playerToken: null },
      { kind: 'bound', connectionId, playerToken: hostToken },
      { kind: 'closed', connectionId, playerToken: hostToken },
    ]);
    expect(presence.events.some((event) => event.kind === 'unbound')).toBe(false);
    expect(manager.calls).toEqual(callsBefore);
  });

  it('replaces the active socket for a token without moving room state or deadlines', async () => {
    const manager = new FakeRoomManager();
    const presence = new FakePresenceController();
    const { server, guest, roomId } = await createSeatedRoom(manager, presence);

    const hostSeat = manager.room.seats.find((seat) => seat.isHost);
    const guestSeat = manager.room.seats.find((seat) => !seat.isHost);
    if (hostSeat === undefined || guestSeat === undefined) {
      throw new Error('seated room is missing a guest seat');
    }
    const hostToken = hostSeat.playerToken;
    const guestToken = guestSeat.playerToken;
    await waitForPresence(
      presence,
      (event) => event.kind === 'bound' && event.playerToken === hostToken,
      'host bound',
    );
    await waitForPresence(
      presence,
      (event) => event.kind === 'bound' && event.playerToken === guestToken,
      'guest bound',
    );
    const hostId = connectionIdForToken(presence, hostToken);
    const guestId = connectionIdForToken(presence, guestToken);

    manager.beginMatch();
    const before = {
      seq: manager.room.seq,
      deadlineAt: manager.room.deadlineAt,
      joinDeadlineAt: manager.room.joinDeadlineAt,
    };
    expect(before.deadlineAt).not.toBeNull();

    const replacement = await connect(server.port);
    await waitForPresence(
      presence,
      (event) =>
        event.kind === 'opened' &&
        event.connectionId !== hostId &&
        event.connectionId !== guestId,
      'replacement opened',
    );
    const replacementId = presence.events.find(
      (event) =>
        event.kind === 'opened' &&
        event.connectionId !== hostId &&
        event.connectionId !== guestId,
    )?.connectionId;
    if (replacementId === undefined) {
      throw new Error('missing replacement connection id');
    }

    const oldClosed = guest.closedWith();
    replacement.send(
      joinMessage(roomId, { playerToken: guestToken, requestId: 'req-reconnect' }),
    );

    // The resumed socket first gets the room state, then the current full
    // snapshot: no delta replay and no second seat.
    const resumedState = await nextRoomState(replacement);
    expect(resumedState.state).toBe('playing');
    expect(resumedState.playerToken).toBe(guestToken);
    const resumedSnapshot = await replacement.next();
    expect(resumedSnapshot).toMatchObject({
      type: 'snapshot',
      roomId,
      matchId: 'match_fake',
      seq: before.seq,
    });
    if (resumedSnapshot.type !== 'snapshot') {
      throw new Error(`expected snapshot, received ${resumedSnapshot.type}`);
    }
    expect(resumedSnapshot.deadlineAt).toBe(before.deadlineAt);
    expect(resumedSnapshot.matchDeadlineAt).toBe(before.joinDeadlineAt);

    // The replaced socket is closed with an observable application code so a
    // client can tell a takeover from a network failure.
    expect(await oldClosed).toEqual({ code: 4001, reason: 'session-replaced' });

    // Swapping sockets is transport-only: the manager saw one more join and
    // neither seq nor either deadline moved.
    expect(manager.calls).toEqual(['create', 'join', 'join']);
    expect(manager.room.seq).toBe(before.seq);
    expect(manager.room.deadlineAt).toBe(before.deadlineAt);
    expect(manager.room.joinDeadlineAt).toBe(before.joinDeadlineAt);
    expect(manager.room.seats).toHaveLength(2);

    // The old binding is released before its socket closes, so the token is
    // never treated as newly offline: bind → unbind → bind, and then only the
    // connection itself closes.
    await waitForPresence(
      presence,
      (event) =>
        event.kind === 'bound' &&
        event.connectionId === replacementId &&
        event.playerToken === guestToken,
      'replacement bound',
    );
    await waitForPresence(
      presence,
      (event) => event.kind === 'closed' && event.connectionId === guestId,
      'replaced socket closed',
    );
    expect(presence.events.filter((event) => event.playerToken === guestToken)).toEqual([
      { kind: 'bound', connectionId: guestId, playerToken: guestToken },
      { kind: 'unbound', connectionId: guestId, playerToken: guestToken },
      { kind: 'bound', connectionId: replacementId, playerToken: guestToken },
    ]);
    expect(presence.events.filter((event) => event.connectionId === guestId)).toEqual([
      { kind: 'opened', connectionId: guestId, playerToken: null },
      { kind: 'bound', connectionId: guestId, playerToken: guestToken },
      { kind: 'unbound', connectionId: guestId, playerToken: guestToken },
      { kind: 'closed', connectionId: guestId, playerToken: null },
    ]);

    // Only the new socket holds the token now. The registry-level removal of
    // the old socket is proven deterministically by the dedicated hub test
    // below; this marker proves the token now routes to the replacement alone.
    const marker: RoomClosedMessage = {
      type: 'room_closed',
      roomId,
      seq: manager.room.seq,
      reason: 'replacement delivery marker',
      finalState: 'dissolved',
    };
    server.deliver([{ playerToken: guestToken, message: marker }]);
    expect(await replacement.next()).toEqual(marker);
  });

  it('removes a replaced socket from the hub registry before its close event', () => {
    const manager = new FakeRoomManager();
    const presence = new FakePresenceController();
    const hub = new RoomSocketHub(manager, presence);
    const oldSocket = new FakeServerSocket();
    const replacement = new FakeServerSocket();

    hub.addConnection(oldSocket as unknown as WebSocket);
    oldSocket.emit('message', JSON.stringify(createMessage()), false);
    const created = firstRoomState(oldSocket);
    const hostToken = requiredToken(created);
    const oldConnectionId = presence.events.find(
      (event) => event.kind === 'opened',
    )?.connectionId;
    if (oldConnectionId === undefined) {
      throw new Error('missing opened event for the replaced socket');
    }

    hub.addConnection(replacement as unknown as WebSocket);
    replacement.emit(
      'message',
      JSON.stringify(
        joinMessage(created.roomId, {
          playerToken: hostToken,
          requestId: 'req-reconnect',
        }),
      ),
      false,
    );

    expect(firstRoomState(replacement).playerToken).toBe(hostToken);
    expect(oldSocket.closeCalls).toEqual([
      { code: 4001, reason: 'session-replaced' },
    ]);

    // A frame that arrives while the replaced socket is still closing must not
    // reach the room manager: the registry entry is deleted before the
    // socket's `close` event, so its handlers are already inert.
    const callsBefore = [...manager.calls];
    oldSocket.emit(
      'message',
      JSON.stringify(readyMessage(created.roomId, true)),
      false,
    );
    expect(manager.calls).toEqual(callsBefore);

    // The same rule covers the late-pong guard: a pong from the replaced
    // socket is not reported, while the replacement's pong still is.
    const replacementConnectionId = presence.events.find(
      (event) =>
        event.kind === 'opened' && event.connectionId !== oldConnectionId,
    )?.connectionId;
    if (replacementConnectionId === undefined) {
      throw new Error('missing opened event for the replacement socket');
    }
    oldSocket.emit('pong');
    expect(
      presence.events.some(
        (event) =>
          event.kind === 'pong' && event.connectionId === oldConnectionId,
      ),
    ).toBe(false);
    replacement.emit('pong');
    expect(
      presence.events.some(
        (event) =>
          event.kind === 'pong' &&
          event.connectionId === replacementConnectionId,
      ),
    ).toBe(true);

    // Its later `close` event only clears an already-missing mapping.
    oldSocket.emit('close');
    expect(manager.calls).toEqual(callsBefore);
  });

  it('contains presence controller faults without breaking create, join, replacement or delivery', async () => {
    const manager = new FakeRoomManager();
    const presence = new ThrowingPresenceController();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { server, host, guest, roomId } = await createSeatedRoom(
      manager,
      presence,
    );

    // create/join already delivered room_state to both seats even though every
    // connectionOpened/tokenBound hook threw.
    expect(manager.calls).toEqual(['create', 'join']);

    const guestSeat = manager.room.seats.find((seat) => !seat.isHost);
    if (guestSeat === undefined) {
      throw new Error('seated room is missing a guest seat');
    }
    const guestToken = guestSeat.playerToken;

    const replacement = await connect(server.port);
    const oldClosed = guest.closedWith();
    replacement.send(
      joinMessage(roomId, {
        playerToken: guestToken,
        requestId: 'req-reconnect',
      }),
    );

    // Replacement still completes, closes the old socket with 4001 and delivers
    // the resumed state even though tokenUnbound/tokenBound threw.
    const resumed = await nextRoomState(replacement);
    expect(resumed.playerToken).toBe(guestToken);
    expect(await oldClosed).toEqual({ code: 4001, reason: 'session-replaced' });

    // A heartbeat pong is forwarded, and its hook's throw stays inside the
    // transport event listener instead of escaping.
    const hostConnectionId = presence.openedIds[0];
    if (hostConnectionId === undefined) {
      throw new Error('no opened connection recorded');
    }
    presence.ping(hostConnectionId);
    await vi.waitFor(
      () => expect(presence.calls).toContain('pongReceived'),
      { interval: 10, timeout: 2_000 },
    );

    // Server-initiated delivery to the new owner is not skipped after a
    // throwing tokenBound.
    const marker: RoomClosedMessage = {
      type: 'room_closed',
      roomId,
      seq: manager.room.seq,
      reason: 'fault isolation marker',
      finalState: 'dissolved',
    };
    server.deliver([{ playerToken: guestToken, message: marker }]);
    expect(await replacement.next()).toEqual(marker);

    // The close listener is isolated too.
    const hostClosed = host.closed();
    host.terminate();
    await hostClosed;
    await vi.waitFor(
      () => expect(presence.closedIds).toContain(hostConnectionId),
      { interval: 10, timeout: 2_000 },
    );

    // Every hook was actually invoked and threw; the transport reported the
    // fault instead of letting it corrupt bookkeeping or escape.
    expect(presence.calls).toEqual(
      expect.arrayContaining([
        'connectionOpened',
        'tokenBound',
        'tokenUnbound',
        'pongReceived',
        'connectionClosed',
      ]),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      '[room] presence connectionOpened hook failed',
      expect.any(Error),
    );
  });

  it('closes cleanly and releases the listening port', async () => {
    const manager = new FakeRoomManager();
    const server = await startTestServer(manager);
    const client = await connect(server.port);
    const clientClosed = client.closed();

    await server.close();
    await server.close();
    await clientClosed;

    const restarted = await startRoomServer({
      manager,
      host: '127.0.0.1',
      port: server.port,
    });
    servers.push(restarted);
    expect(restarted.port).toBe(server.port);

    const health = await fetch(`http://127.0.0.1:${restarted.port}${ROOM_HEALTH_PATH}`);
    expect(health.status).toBe(200);
  });
});

describe('room deadline wiring', () => {
  const START = 1_700_000_000_000;

  /** Real manager + real scheduler sharing one deterministic clock. */
  function createScheduledServer(): {
    readonly clock: TestClock;
    readonly manager: InMemoryRoomManager;
    readonly scheduler: DeadlineScheduler;
    readonly start: () => Promise<RoomServer>;
  } {
    const clock = new TestClock(START);
    const manager = createRoomManager({
      now: () => clock.now(),
      createSeed: () => 7,
    });
    let server: RoomServer | null = null;
    const scheduler = createDeadlineScheduler({
      manager,
      clock,
      deliver: (deliveries) => server?.deliver(deliveries),
    });
    return {
      clock,
      manager,
      scheduler,
      start: async () => {
        server = await startTestServer(manager, undefined, scheduler);
        return server;
      },
    };
  }

  it('arms one timer per room and re-arms it after every lifecycle command', async () => {
    const harness = createScheduledServer();
    const server = await harness.start();
    const host = await connect(server.port);
    host.send(createMessage());
    const created = await nextRoomState(host);
    const roomId = created.roomId;
    const hostToken = requiredToken(created);

    const room = harness.manager.getRoom(roomId);
    if (room === undefined) {
      throw new Error('create did not store a room');
    }
    expect(harness.scheduler.scheduledRoomCount).toBe(1);
    expect(harness.clock.nextDueAt()).toBe(room.joinDeadlineAt);

    // `join` only adds a seat while the shared join window keeps running.
    const guest = await connect(server.port);
    guest.send(joinMessage(roomId));
    const guestState = await nextRoomState(guest);
    await nextRoomState(host);
    const guestToken = requiredToken(guestState);
    expect(harness.scheduler.scheduledRoomCount).toBe(1);
    expect(harness.clock.nextDueAt()).toBe(room.joinDeadlineAt);

    // `ready` does not move a deadline; the same one timer stays armed.
    host.send(readyMessage(roomId, true));
    await nextRoomState(host);
    await nextRoomState(guest);
    guest.send(readyMessage(roomId, true));
    await nextRoomState(host);
    await nextRoomState(guest);
    expect(harness.scheduler.scheduledRoomCount).toBe(1);
    expect(harness.clock.nextDueAt()).toBe(room.joinDeadlineAt);

    // `start` replaces the join window with the match's turn deadline.
    host.send(startMessage(roomId));
    const startedRoom = await waitForMessage(
      host,
      'room_state',
      (message) => message.type === 'room_state' && message.state === 'playing',
      'playing room_state',
    );
    expect(startedRoom).toMatchObject({ type: 'room_state', roomId, state: 'playing' });
    const match = harness.manager.getMatch(roomId);
    if (match === null) {
      throw new Error('start did not create a match');
    }
    expect(harness.scheduler.scheduledRoomCount).toBe(1);
    expect(harness.clock.nextDueAt()).toBe(match.state.turnDeadlineAt);

    // An accepted action moves the turn deadline; the old timer must be gone.
    harness.clock.advance(10_000);
    const playing = harness.manager.getRoom(roomId);
    const actingMatch = harness.manager.getMatch(roomId);
    if (playing === undefined || actingMatch === null) {
      throw new Error('the room must still be playing');
    }
    host.send({
      type: 'action',
      roomId,
      matchId: actingMatch.matchId,
      actionId: 'action-wired-1',
      seq: playing.seq,
      turnId: actingMatch.state.turnId,
      kind: 'reveal',
      row: 0,
      col: 0,
      clientTimeMs: harness.clock.now(),
    });
    await waitForMessage(
      host,
      'action_result',
      (message) => message.type === 'action_result' && message.accepted,
      'accepted action_result',
    );
    const advanced = harness.manager.getMatch(roomId);
    if (advanced === null) {
      throw new Error('the match disappeared after an accepted action');
    }
    expect(advanced.state.turnDeadlineAt).toBe(START + 10_000 + TURN_TIMEOUT_MS);
    expect(harness.clock.nextDueAt()).toBe(advanced.state.turnDeadlineAt);

    // Replacing the guest socket resumes the seat but must not move either
    // deadline: the timer still points at the deadline the action produced.
    const replacement = await connect(server.port);
    replacement.send(
      joinMessage(roomId, { playerToken: guestToken, requestId: 'req-reconnect' }),
    );
    await waitForMessage(
      replacement,
      'room_state',
      (message) => message.type === 'room_state' && message.playerToken === guestToken,
      'resumed room_state',
    );
    const resumedSnapshot = await waitForMessage(
      replacement,
      'snapshot',
      () => true,
      'resumed snapshot',
    );
    expect(resumedSnapshot).toMatchObject({
      type: 'snapshot',
      deadlineAt: advanced.state.turnDeadlineAt,
      matchDeadlineAt: advanced.state.matchDeadlineAt,
    });
    expect(harness.manager.getMatch(roomId)?.state.turnDeadlineAt).toBe(
      advanced.state.turnDeadlineAt,
    );
    expect(harness.clock.nextDueAt()).toBe(advanced.state.turnDeadlineAt);

    // Reaching that original deadline produces exactly one terminal result.
    harness.clock.advance(TURN_TIMEOUT_MS);
    await waitForMessage(
      host,
      'timeout',
      (message) => message.type === 'timeout' && message.timer === 'turn',
      'turn timeout',
    );
    await waitForMessage(
      replacement,
      'end',
      (message) => message.type === 'end' && message.reason === 'turn-timeout',
      'turn end',
    );
    expect(harness.manager.getRoom(roomId)?.state).toBe('finished');
    expect(harness.scheduler.scheduledRoomCount).toBe(0);
    expect(host.received.filter((message) => message.type === 'timeout')).toHaveLength(1);
    expect(host.received.filter((message) => message.type === 'end')).toHaveLength(1);

    // Re-joining the retained match cannot resurrect its timer, and the
    // resume itself must re-send the retained end (not just match the old one).
    const framesBeforeResume = replacement.received.length;
    replacement.send(
      joinMessage(roomId, { playerToken: guestToken, requestId: 'req-resume-finished' }),
    );
    await waitForMessage(
      replacement,
      'end',
      (message) => message.type === 'end',
      'resumed end',
      framesBeforeResume,
    );
    expect(harness.scheduler.scheduledRoomCount).toBe(0);
    expect(harness.clock.nextDueAt()).toBeNull();
    expect(
      harness.manager.getRoom(roomId)?.seats.find((seat) => seat.isHost)?.playerToken,
    ).toBe(hostToken);

    // `rematch` restarts the join window: the scheduler must arm the new join
    // deadline instead of leaving the finished match's timer cancelled.
    host.send({ type: 'rematch', requestId: 'req-rematch-host', roomId, accept: true });
    replacement.send({
      type: 'rematch',
      requestId: 'req-rematch-guest',
      roomId,
      accept: true,
    });
    await waitForMessage(
      host,
      'room_state',
      (message) =>
        message.type === 'room_state' &&
        message.state === 'ready' &&
        message.stateReason === 'rematch',
      'rematch ready state',
    );
    const ready = harness.manager.getRoom(roomId);
    if (ready === undefined) {
      throw new Error('rematch did not keep the room');
    }
    expect(ready.state).toBe('ready');
    expect(harness.scheduler.scheduledRoomCount).toBe(1);
    expect(harness.clock.nextDueAt()).toBe(ready.joinDeadlineAt);

    harness.clock.advance(JOIN_TIMEOUT_MS);
    await waitForMessage(
      host,
      'timeout',
      (message) => message.type === 'timeout' && message.timer === 'join',
      'join timeout after rematch',
    );
    expect(harness.manager.roomCount).toBe(0);
    expect(harness.scheduler.scheduledRoomCount).toBe(0);
  });

  it('cancels the room timer when a lifecycle command dissolves the room', async () => {
    const harness = createScheduledServer();
    const server = await harness.start();
    const host = await connect(server.port);
    host.send(createMessage());
    const created = await nextRoomState(host);
    expect(harness.scheduler.scheduledRoomCount).toBe(1);

    host.send({ type: 'leave', requestId: 'req-leave', roomId: created.roomId });
    await waitForMessage(
      host,
      'room_closed',
      (message) => message.type === 'room_closed',
      'room_closed',
    );

    expect(harness.manager.roomCount).toBe(0);
    expect(harness.scheduler.scheduledRoomCount).toBe(0);
    expect(harness.clock.nextDueAt()).toBeNull();

    // Even a far-future wakeup finds no room and produces no extra event.
    harness.clock.advance(JOIN_TIMEOUT_MS * 2);
    expect(harness.manager.roomCount).toBe(0);
    expect(host.received.filter((message) => message.type === 'timeout')).toHaveLength(0);
  });

  it('cancels every deadline timer when the server closes', async () => {
    const harness = createScheduledServer();
    const server = await harness.start();
    const host = await connect(server.port);
    host.send(createMessage());
    const created = await nextRoomState(host);
    expect(harness.scheduler.scheduledRoomCount).toBe(1);

    await server.close();

    // The scheduler released its timer, so a later join window cannot fire on
    // a server that is already gone.
    expect(harness.scheduler.scheduledRoomCount).toBe(0);
    expect(harness.clock.nextDueAt()).toBeNull();

    // A delivery that races shutdown (an embedder call here) must not re-arm
    // the deadline that close() just released.
    const afterClose: RoomClosedMessage = {
      type: 'room_closed',
      roomId: created.roomId,
      seq: 0,
      reason: 'after-close',
      finalState: 'dissolved',
    };
    server.deliver([{ playerToken: 'after-close', message: afterClose }]);
    expect(harness.scheduler.scheduledRoomCount).toBe(0);
    expect(harness.clock.nextDueAt()).toBeNull();

    harness.clock.advance(JOIN_TIMEOUT_MS * 2);
    expect(harness.manager.roomCount).toBe(1);
    expect(harness.manager.getRoom(created.roomId)?.state).toBe('waiting');
  });

  it('re-arms after a presence delivery expires a grace window and dissolves the room', async () => {
    const clock = new TestClock(START);
    const manager = createRoomManager({ now: () => clock.now() });
    let server: RoomServer | null = null;
    const deliver = (deliveries: readonly RoomDelivery[]): void => {
      server?.deliver(deliveries);
    };
    const presence = createPresenceController({ manager, deliver, clock });
    const scheduler = createDeadlineScheduler({ manager, deliver, clock });
    server = await startTestServer(manager, presence, scheduler);

    // This client never answers a heartbeat, so the seat goes offline without
    // any test-owned timing loop.
    const host = await TestClient.connect(server.port, { autoPong: false });
    clients.push(host);
    host.send(createMessage());
    const created = await nextRoomState(host);
    expect(scheduler.scheduledRoomCount).toBe(1);

    clock.advance(HEARTBEAT_INTERVAL_MS);
    clock.advance(HEARTBEAT_INTERVAL_MS);
    await waitForMessage(
      host,
      'room_state',
      (message) =>
        message.type === 'room_state' &&
        message.players.some((player) => player.presence === 'offline'),
      'offline room_state',
    );
    // The presence delivery went through the transport's batch seam: the
    // join timer is still the one room deadline the scheduler tracks (presence
    // moves no deadline). The clock also holds the grace timer, so only the
    // scheduler count proves the join timer is still armed.
    expect(scheduler.scheduledRoomCount).toBe(1);
    expect(created.joinDeadlineAt).toBe(START + JOIN_TIMEOUT_MS);

    clock.advance(RECONNECT_GRACE_MS);
    const closed = await waitForMessage(
      host,
      'room_closed',
      (message) => message.type === 'room_closed',
      'grace-expired room_closed',
    );
    expect(closed).toMatchObject({
      type: 'room_closed',
      roomId: created.roomId,
      reason: 'host-grace-expired',
      finalState: 'dissolved',
    });
    expect(manager.roomCount).toBe(0);
    // That delivery was also the scheduler's re-arm input: the dissolved room
    // has no deadline, so the previously armed join timer is gone. The
    // heartbeat interval still belongs to the connection and is not a room
    // deadline, so only the scheduler count is asserted here.
    expect(scheduler.scheduledRoomCount).toBe(0);
    // The only timer the shared clock still owns is the connection's heartbeat
    // interval; the dissolved room's join deadline is gone.
    expect(clock.timerCount).toBe(1);
  });

  it('keeps the whole-match cap in the timer even when the turn window is longer', async () => {
    const clock = new TestClock(START);
    const manager = createRoomManager({
      now: () => clock.now(),
      createSeed: () => 7,
      turnTimeoutMs: MATCH_TIMEOUT_MS + 1_000,
      matchTimeoutMs: MATCH_TIMEOUT_MS,
    });
    let server: RoomServer | null = null;
    const scheduler = createDeadlineScheduler({
      manager,
      clock,
      deliver: (deliveries) => server?.deliver(deliveries),
    });
    server = await startTestServer(manager, undefined, scheduler);

    const host = await connect(server.port);
    host.send(createMessage());
    const created = await nextRoomState(host);
    const guest = await connect(server.port);
    guest.send(joinMessage(created.roomId));
    await nextRoomState(guest);
    await nextRoomState(host);
    host.send(readyMessage(created.roomId, true));
    await nextRoomState(host);
    await nextRoomState(guest);
    guest.send(readyMessage(created.roomId, true));
    await nextRoomState(host);
    await nextRoomState(guest);
    host.send(startMessage(created.roomId));
    await waitForMessage(
      host,
      'room_state',
      (message) => message.type === 'room_state' && message.state === 'playing',
      'playing room_state',
    );

    const match = manager.getMatch(created.roomId);
    if (match === null) {
      throw new Error('start did not create a match');
    }
    expect(clock.nextDueAt()).toBe(match.state.matchDeadlineAt);
    // The match layer caps the turn deadline at the match cap, so the two are
    // the same instant here; the scheduler's tie-break must still pick 'match'.
    expect(match.state.turnDeadlineAt).toBe(match.state.matchDeadlineAt);

    clock.advance(MATCH_TIMEOUT_MS);
    await waitForMessage(
      host,
      'timeout',
      (message) => message.type === 'timeout' && message.timer === 'match',
      'match timeout',
    );
    const end = await waitForMessage(
      guest,
      'end',
      (message) => message.type === 'end' && message.reason === 'match-timeout',
      'match end',
    );
    expect(end).toMatchObject({ type: 'end', reason: 'match-timeout' });
    expect(manager.getRoom(created.roomId)?.state).toBe('finished');
    expect(scheduler.scheduledRoomCount).toBe(0);
    expect(host.received.filter((message) => message.type === 'timeout')).toHaveLength(1);
    expect(host.received.filter((message) => message.type === 'end')).toHaveLength(1);
  });

  it('keeps a delivered command result when the scheduler refresh throws', async () => {
    const manager = new FakeRoomManager();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refresh = vi.fn((): void => {
      throw new Error('refresh exploded');
    });
    const scheduler: DeadlineScheduler = {
      refresh,
      cancel: () => undefined,
      cancelAll: () => undefined,
      scheduledRoomCount: 0,
    };
    const server = await startTestServer(manager, undefined, scheduler);

    const host = await connect(server.port);
    host.send(createMessage());
    const created = await nextRoomState(host);

    // The room_state reached the client even though the transport's scheduler
    // seam threw, so a successful command did not turn into a protocol error.
    expect(created.type).toBe('room_state');
    expect(refresh).toHaveBeenCalledWith(created.roomId);
    expect(host.received.filter((message) => message.type === 'error')).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      `[room] deadline refresh failed for ${created.roomId}`,
      expect.any(Error),
    );
  });

  it('closes the listeners when presence and scheduler cleanup throws', async () => {
    const manager = new FakeRoomManager();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const presence: PresenceController & { close(): void } = {
      connectionOpened: () => undefined,
      connectionClosed: () => undefined,
      pongReceived: () => undefined,
      tokenBound: () => undefined,
      tokenUnbound: () => undefined,
      close: () => {
        throw new Error('presence close exploded');
      },
    };
    const deadlines: DeadlineScheduler = {
      refresh: () => undefined,
      cancel: () => undefined,
      cancelAll: () => {
        throw new Error('cancelAll exploded');
      },
      scheduledRoomCount: 0,
    };
    const server = await startRoomServer({
      manager,
      presence,
      deadlines,
      host: '127.0.0.1',
      port: 0,
    });
    servers.push(server);

    const host = await connect(server.port);
    const hostClosed = host.closed();
    await expect(server.close()).resolves.toBeUndefined();
    await hostClosed;

    expect(errorSpy).toHaveBeenCalledWith(
      '[room] presence close failed',
      expect.any(Error),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      '[room] deadline cancelAll failed',
      expect.any(Error),
    );
    await expect(
      fetch(`http://127.0.0.1:${server.port}${ROOM_HEALTH_PATH}`),
    ).rejects.toThrow();
  });
});
