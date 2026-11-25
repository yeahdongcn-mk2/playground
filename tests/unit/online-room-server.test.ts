import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  broadcastToSeats,
  createRoomId,
  issuePlayerToken,
  JOIN_TIMEOUT_MS,
  ROOM_CAPACITY,
  roomErrorMessage,
  roomStateDeliveries,
  seatedCommandSuccess,
  type MatchCommandResult,
  type MatchRoomManager,
  type RoomCommandResult,
  type RoomConnection,
  type RoomErrorCode,
  type RoomRecord,
  type RoomSeat,
} from '../../server/room/contracts';
import {
  ROOM_HEALTH_PATH,
  ROOM_WS_PATH,
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
 * per-seat `room_state` deliveries built by `contracts.ts`. Lifecycle
 * correctness is covered by the room-manager tests, not here.
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
    this.state = 'playing';
    this.seq += 1;
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
    this.turnPlayerId = this.seats.find((seat) => seat.isHost)?.playerId ?? null;
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
      deadlineAt: this.joinDeadlineAt,
    };
    const snapshot: SnapshotMessage = {
      type: 'snapshot',
      roomId: this.roomId,
      matchId: this.matchId,
      seq: this.seq,
      turnPlayerId: seat.playerId,
      turnId: message.turnId,
      deadlineAt: this.joinDeadlineAt,
      matchDeadlineAt: this.joinDeadlineAt,
      seedHash: 'fake-seed-hash',
      engineStatus: 'playing',
      mineCount: this.config.mines,
      remainingMines: this.config.mines,
      revealedSafeCount: 1,
      elapsedMs: 0,
      board: [],
    };
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
      deadlineAt: null,
      stateReason: null,
    };
  }
}

/** A real WebSocket client that queues server frames for ordered assertions. */
class TestClient {
  private readonly socket: WebSocket;
  private readonly queued: ServerToClientMessage[] = [];
  private readonly waiting: ((message: ServerToClientMessage) => void)[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerToClientMessage;
      const waiter = this.waiting.shift();
      if (waiter !== undefined) {
        waiter(message);
        return;
      }
      this.queued.push(message);
    });
    socket.on('error', () => undefined);
  }

  static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${ROOM_WS_PATH}`);
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
    if (this.socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.socket.once('close', () => resolve()));
  }

  terminate(): void {
    this.socket.terminate();
  }
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

async function startTestServer(manager: MatchRoomManager): Promise<RoomServer> {
  const server = await startRoomServer({ manager, host: '127.0.0.1', port: 0 });
  servers.push(server);
  return server;
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

async function createSeatedRoom(manager: FakeRoomManager): Promise<SeatedRoom> {
  const server = await startTestServer(manager);
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
