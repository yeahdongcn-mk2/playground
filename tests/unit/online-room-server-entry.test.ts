import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  DEFAULT_ROOM_SERVER_PORT,
  HEARTBEAT_INTERVAL_MS,
  JOIN_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from '../../server/room/contracts';
import {
  resolveRoomServerConfig,
  startRoomServerFromConfig,
  type RoomServerRuntimeOptions,
} from '../../server/room/main';
import type {
  PresenceClock,
  PresenceControllerHandle,
  PresenceControllerOptions,
  PresenceTimer,
} from '../../server/room/presence';
import { createRoomManager } from '../../server/room/room-manager';
import { ROOM_WS_PATH, type RoomServer } from '../../server/room/ws-server';
import {
  PROTOCOL_VERSION,
  type ClientToServerMessage,
  type CreateMessage,
  type JoinMessage,
  type ReadyMessage,
  type RoomStateMessage,
  type ServerToClientMessage,
  type SnapshotMessage,
  type StartMessage,
} from '../../src/games/minesweeper/online/index';

const servers: RoomServer[] = [];
const entryClients: EntryClient[] = [];

afterEach(async () => {
  for (const client of entryClients.splice(0)) {
    client.terminate();
  }
  await Promise.all(
    servers.splice(0).map((server) => server.close().catch(() => undefined)),
  );
});

/** Build a stand-in presence handle for tests that mock `createPresenceController`. */
function fakePresenceController(): PresenceControllerHandle {
  return {
    connectionOpened: () => undefined,
    connectionClosed: () => undefined,
    pongReceived: () => undefined,
    tokenBound: () => undefined,
    tokenUnbound: () => undefined,
    close: () => undefined,
  };
}

/** Build a stand-in transport handle for tests that mock `startRoomServer`. */
function fakeRoomServer(overrides: Partial<RoomServer> = {}): RoomServer {
  return {
    host: '127.0.0.1',
    port: 0,
    deliver: () => undefined,
    close: () => Promise.resolve(),
    ...overrides,
  };
}

/** Return the readable message a rejected `PORT` value produces. */
function invalidPortMessage(rawPort: string): string {
  try {
    resolveRoomServerConfig({ PORT: rawPort });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`expected PORT "${rawPort}" to be rejected`);
}

/** Resolve once a TCP connect to the port fails, rejecting if it still accepts. */
function expectPortReleased(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const failStillListening = (): void => {
      socket.destroy();
      reject(new Error(`port ${port} still accepts connections after close()`));
    };
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error(`timed out checking that port ${port} was released`));
    });
    socket.once('connect', failStillListening);
    socket.once('error', () => {
      socket.destroy();
      resolve();
    });
  });
}

describe('resolveRoomServerConfig', () => {
  it('defaults to loopback and the contract port when nothing is set', () => {
    expect(DEFAULT_ROOM_SERVER_PORT).toBe(8787);
    expect(resolveRoomServerConfig({})).toEqual({
      host: '127.0.0.1',
      port: DEFAULT_ROOM_SERVER_PORT,
    });
    expect(resolveRoomServerConfig({ HOST: '', PORT: '' })).toEqual({
      host: '127.0.0.1',
      port: DEFAULT_ROOM_SERVER_PORT,
    });
    expect(resolveRoomServerConfig({ HOST: '   ', PORT: '  ' })).toEqual({
      host: '127.0.0.1',
      port: DEFAULT_ROOM_SERVER_PORT,
    });
  });

  it('reads HOST and PORT overrides, trimming surrounding whitespace', () => {
    expect(resolveRoomServerConfig({ HOST: '0.0.0.0', PORT: '9000' })).toEqual({
      host: '0.0.0.0',
      port: 9000,
    });
    expect(resolveRoomServerConfig({ HOST: ' 192.0.2.10 ', PORT: ' 9010 ' })).toEqual({
      host: '192.0.2.10',
      port: 9010,
    });
    expect(resolveRoomServerConfig({ HOST: 'room.example', PORT: '8787' })).toEqual({
      host: 'room.example',
      port: 8787,
    });
  });

  it('accepts the 0 and 65535 port boundaries', () => {
    expect(resolveRoomServerConfig({ PORT: '0' })).toEqual({ host: '127.0.0.1', port: 0 });
    expect(resolveRoomServerConfig({ PORT: '65535' })).toEqual({
      host: '127.0.0.1',
      port: 65535,
    });
  });

  it.each(['abc', '12.5', '-1', '1e3', '9000x'])(
    'rejects non-decimal PORT %s with a readable error',
    (rawPort) => {
      const message = invalidPortMessage(rawPort);
      expect(message).toContain(`Invalid PORT "${rawPort}"`);
      expect(message).toContain('0 and 65535');
    },
  );

  it.each(['65536', '70000', '999999999999999999999'])(
    'rejects out-of-range PORT %s with a readable error',
    (rawPort) => {
      const message = invalidPortMessage(rawPort);
      expect(message).toContain(`Invalid PORT "${rawPort}"`);
      expect(message).toContain('0 and 65535');
    },
  );
});

describe('server/room/main.ts import safety', () => {
  it('does not start the room server when the module is imported', async () => {
    const startRoomServer = vi.fn(async () => fakeRoomServer());
    vi.resetModules();
    vi.doMock('../../server/room/ws-server', () => ({ startRoomServer }));
    // A bypassed guard must reach the mocked transport even when the ambient
    // environment carries an invalid PORT; 0 is always valid and ephemeral.
    vi.stubEnv('PORT', '0');

    try {
      const mod = await import('../../server/room/main');
      // Give a bypassed (but asynchronous) startup a chance to reach the mock.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(startRoomServer).not.toHaveBeenCalled();

      // Prove the mock is wired to the dynamically imported module: without
      // this, a broken mock path could hide a bypassed guard whenever 8787 is
      // already occupied.
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await mod.startRoomServerFromConfig({ host: '127.0.0.1', port: 0 });
      } finally {
        log.mockRestore();
      }
      expect(startRoomServer).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('../../server/room/ws-server');
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('main shutdown', () => {
  it('reports a failed close and exits non-zero on SIGTERM', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    const close = vi.fn(() => Promise.reject(new Error('close failed')));
    const startRoomServer = vi.fn(async () => fakeRoomServer({ close }));
    // Intercept registration so the assertion path never installs a real signal
    // handler whose rejected close outlives this test.
    const once = vi.spyOn(process, 'once').mockImplementation(() => process);

    vi.resetModules();
    vi.doMock('../../server/room/ws-server', () => ({ startRoomServer }));

    try {
      const { main } = await import('../../server/room/main');
      const server = await main({ PORT: '0' });
      expect(server).not.toBeNull();

      const sigterm = once.mock.calls.find(([event]) => event === 'SIGTERM')?.[1];
      expect(sigterm).toBeTypeOf('function');
      if (sigterm === undefined) {
        throw new Error('main() did not register a SIGTERM handler');
      }

      // Clear any ambient value so the assertion proves the handler set it.
      process.exitCode = undefined;
      sigterm();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(close).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith('close failed');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      once.mockRestore();
      vi.doUnmock('../../server/room/ws-server');
      vi.resetModules();
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe('startRoomServerFromConfig', () => {
  it('binds the HOST override, serves /health, and releases the port on close', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // A non-default HOST proves `startRoomServerFromConfig` forwards
      // `config.host`; with the default the forwarded value is invisible.
      const config = resolveRoomServerConfig({ HOST: '0.0.0.0', PORT: '0' });
      const server = await startRoomServerFromConfig(config);
      servers.push(server);

      expect(server.host).toBe('0.0.0.0');
      expect(server.port).toBeGreaterThan(0);
      expect(log).toHaveBeenCalledWith(
        `room server listening on http://0.0.0.0:${server.port}`,
      );

      // A wildcard bind still accepts loopback connections, and hitting it via
      // 127.0.0.1 proves the listener is actually reachable, not just reported.
      const response = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });

      const { port } = server;
      await expect(server.close()).resolves.toBeUndefined();
      // close() is documented (and needed by the signal handlers) to be idempotent.
      await expect(server.close()).resolves.toBeUndefined();
      await expectPortReleased(port);
    } finally {
      log.mockRestore();
    }
  });
});

describe('startRoomServerFromConfig presence windows', () => {
  it('forwards presence overrides only when supplied, keeping production defaults', async () => {
    const createPresenceController = vi.fn(
      (_options: PresenceControllerOptions): PresenceControllerHandle =>
        fakePresenceController(),
    );
    const startRoomServer = vi.fn(async () => fakeRoomServer());
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    vi.resetModules();
    vi.doMock('../../server/room/presence', () => ({ createPresenceController }));
    vi.doMock('../../server/room/ws-server', () => ({ startRoomServer }));

    try {
      const mod = await import('../../server/room/main');
      const manager = createRoomManager({ createSeed: () => 7 });

      // Production passes no presence windows: the entry must not invent
      // values, so the controller falls back to the contract constants.
      await mod.startRoomServerFromConfig({ host: '127.0.0.1', port: 0 }, { manager });
      const defaults = createPresenceController.mock.calls[0]?.[0];
      if (defaults === undefined) {
        throw new Error('createPresenceController was not called without overrides');
      }
      expect(defaults).toMatchObject({ manager });
      expect(defaults).not.toHaveProperty('heartbeatIntervalMs');
      expect(defaults).not.toHaveProperty('missedBeatsThreshold');
      expect(defaults).not.toHaveProperty('graceMs');

      // The e2e launcher's shape: every shortened presence window reaches the
      // controller unchanged, next to the forwarded manager and delivery sink.
      await mod.startRoomServerFromConfig(
        { host: '127.0.0.1', port: 0 },
        {
          manager,
          heartbeatIntervalMs: 1_000,
          missedBeatsThreshold: 3,
          graceMs: 2_000,
        },
      );
      const overridden = createPresenceController.mock.calls[1]?.[0];
      if (overridden === undefined) {
        throw new Error('createPresenceController was not called with overrides');
      }
      expect(overridden).toMatchObject({
        manager,
        heartbeatIntervalMs: 1_000,
        missedBeatsThreshold: 3,
        graceMs: 2_000,
      });
      expect(overridden.deliver).toBeTypeOf('function');
      expect(startRoomServer).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
      vi.doUnmock('../../server/room/presence');
      vi.doUnmock('../../server/room/ws-server');
      vi.resetModules();
    }
  });
});

interface EntryTimer {
  dueAt: number;
  readonly intervalMs: number | null;
  readonly callback: () => void;
}

/**
 * Deterministic clock for the real entry point.
 *
 * It is injected as the manager clock, the presence clock and the deadline
 * scheduler clock, so heartbeat, grace, turn, match and join windows all move
 * together without a real 5 s / 15 s / 30 s / 120 s wait.
 */
class EntryClock implements PresenceClock {
  private current: number;
  private nextHandle = 1;
  private readonly timers = new Map<number, EntryTimer>();

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
      let nextEntry: EntryTimer | null = null;
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
    throw new Error('entry clock fired too many timers');
  }

  get timerCount(): number {
    return this.timers.size;
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

/** Real WebSocket client with an observable frame log and optional auto-pong. */
class EntryClient {
  readonly received: ServerToClientMessage[] = [];
  readonly autoPong: boolean;
  pingCount = 0;
  private syncSequence = 0;
  private readonly socket: WebSocket;
  private readonly closeInfo: Promise<{ readonly code: number; readonly reason: string }>;

  private constructor(socket: WebSocket, autoPong: boolean) {
    this.socket = socket;
    this.autoPong = autoPong;
    this.closeInfo = new Promise((resolve) => {
      socket.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    socket.on('message', (data) => {
      this.received.push(JSON.parse(data.toString()) as ServerToClientMessage);
    });
    socket.on('ping', () => {
      this.pingCount += 1;
    });
    socket.on('error', () => undefined);
  }

  static async connect(
    port: number,
    options: { readonly autoPong?: boolean } = {},
  ): Promise<EntryClient> {
    const autoPong = options.autoPong ?? true;
    const socket = new WebSocket(`ws://127.0.0.1:${port}${ROOM_WS_PATH}`, { autoPong });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (error) => reject(error));
    });
    return new EntryClient(socket, autoPong);
  }

  send(message: ClientToServerMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  /**
   * Prove the server has processed the last automatic pong on this socket.
   *
   * TCP keeps the auto-pong queued before this probe, and the transport reads
   * one socket in order, so the probe's error response is only sent after the
   * presence controller saw the pong. This removes the fixed-sleep race between
   * the manual clock and the real network. The probe joins a non-existent room,
   * which the manager rejects without touching any room or connection state.
   */
  async syncPresence(): Promise<void> {
    this.syncSequence += 1;
    const requestId = `req-sync-${this.syncSequence}`;
    this.send({
      type: 'join',
      requestId,
      protocolVersion: PROTOCOL_VERSION,
      roomId: 'room_sync_probe',
      displayName: 'sync',
    });
    await waitForEntryMessage(
      this,
      'error',
      (message) => message.type === 'error' && message.requestId === requestId,
      'presence sync probe',
    );
  }

  closedWith(): Promise<{ readonly code: number; readonly reason: string }> {
    return this.closeInfo;
  }

  terminate(): void {
    this.socket.terminate();
  }
}

const ENTRY_CONFIG: CreateMessage['config'] = {
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
};

function entryCreateMessage(): CreateMessage {
  return {
    type: 'create',
    requestId: 'req-create',
    protocolVersion: PROTOCOL_VERSION,
    config: ENTRY_CONFIG,
    displayName: 'Host',
  };
}

function entryJoinMessage(roomId: string, playerToken?: string): JoinMessage {
  return {
    type: 'join',
    requestId: 'req-join',
    protocolVersion: PROTOCOL_VERSION,
    roomId,
    displayName: 'Guest',
    ...(playerToken === undefined ? {} : { playerToken }),
  };
}

function entryReadyMessage(roomId: string): ReadyMessage {
  return { type: 'ready', requestId: 'req-ready', roomId, ready: true };
}

function entryStartMessage(roomId: string): StartMessage {
  return { type: 'start', requestId: 'req-start', roomId };
}

function requiredToken(state: RoomStateMessage): string {
  if (state.playerToken === undefined) {
    throw new Error('room_state is missing its playerToken');
  }
  return state.playerToken;
}

/**
 * Wait until the client frame log contains a matching frame.
 *
 * `fromIndex` restricts the search to frames received after that position, so
 * a stale frame from an earlier phase cannot satisfy a "this just happened"
 * assertion.
 */
async function waitForEntryMessage(
  client: EntryClient,
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

/**
 * Advance the injected clock by one heartbeat and wait for every listed client
 * to observe the ping. A responsive client then proves, through a probe
 * round-trip, that the server has processed its auto-pong; the virtual clock
 * never outruns the real network.
 */
async function advanceHeartbeat(
  clock: EntryClock,
  clients: readonly EntryClient[],
): Promise<void> {
  const before = clients.map((client) => client.pingCount);
  clock.advance(HEARTBEAT_INTERVAL_MS);
  for (const [index, client] of clients.entries()) {
    const expected = (before[index] ?? 0) + 1;
    await vi.waitFor(
      () => {
        if (client.pingCount < expected) {
          throw new Error('heartbeat ping was not observed');
        }
      },
      { interval: 5, timeout: 2_000 },
    );
  }
  for (const client of clients) {
    if (client.autoPong) {
      await client.syncPresence();
    }
  }
}

/** Start the real entry with `options`, quieting its listening log line. */
async function startEntryServer(
  options: RoomServerRuntimeOptions,
): Promise<RoomServer> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const server = await startRoomServerFromConfig(
      { host: '127.0.0.1', port: 0 },
      options,
    );
    servers.push(server);
    return server;
  } finally {
    log.mockRestore();
  }
}

interface EntryRoom {
  readonly host: EntryClient;
  readonly guest: EntryClient;
  readonly roomId: string;
  readonly hostToken: string;
}

/** Seat both players, ready both and start a match over real sockets. */
async function createPlayingRoom(
  server: RoomServer,
  options: { readonly hostAutoPong?: boolean } = {},
): Promise<EntryRoom> {
  const host = await EntryClient.connect(server.port, {
    autoPong: options.hostAutoPong ?? true,
  });
  entryClients.push(host);
  host.send(entryCreateMessage());
  const created = (await waitForEntryMessage(
    host,
    'room_state',
    (message) => message.type === 'room_state' && message.players.length === 1,
    'created room_state',
  )) as RoomStateMessage;
  const hostToken = requiredToken(created);

  const guest = await EntryClient.connect(server.port);
  entryClients.push(guest);
  guest.send(entryJoinMessage(created.roomId));
  await waitForEntryMessage(
    guest,
    'room_state',
    (message) => message.type === 'room_state' && message.players.length === 2,
    'guest room_state',
  );
  await waitForEntryMessage(
    host,
    'room_state',
    (message) => message.type === 'room_state' && message.players.length === 2,
    'host room_state with guest',
  );

  host.send(entryReadyMessage(created.roomId));
  guest.send(entryReadyMessage(created.roomId));
  await waitForEntryMessage(
    host,
    'room_state',
    (message) => message.type === 'room_state' && message.state === 'ready',
    'host ready state',
  );
  await waitForEntryMessage(
    guest,
    'room_state',
    (message) => message.type === 'room_state' && message.state === 'ready',
    'guest ready state',
  );

  host.send(entryStartMessage(created.roomId));
  await waitForEntryMessage(
    host,
    'room_state',
    (message) => message.type === 'room_state' && message.state === 'playing',
    'host playing state',
  );
  await waitForEntryMessage(
    guest,
    'room_state',
    (message) => message.type === 'room_state' && message.state === 'playing',
    'guest playing state',
  );
  await waitForEntryMessage(host, 'snapshot', () => true, 'starting snapshot');
  return { host, guest, roomId: created.roomId, hostToken };
}

describe('entry presence and deadline wiring', () => {
  const START = 1_700_000_000_000;

  it('drives heartbeat → offline → grace reconnect and one turn timeout from the real entry', async () => {
    const clock = new EntryClock(START);
    const manager = createRoomManager({
      now: () => clock.now(),
      createSeed: () => 7,
    });
    const server = await startEntryServer({ clock, manager });
    const { host, guest, roomId, hostToken } = await createPlayingRoom(server, {
      hostAutoPong: false,
    });

    const room = manager.getRoom(roomId);
    const match = manager.getMatch(roomId);
    if (room === undefined || match === null) {
      throw new Error('the real entry did not start a match');
    }
    const hostPlayerId = room.hostId;
    const turnDeadline = match.state.turnDeadlineAt;
    const matchDeadline = match.state.matchDeadlineAt;
    expect(turnDeadline).toBe(START + TURN_TIMEOUT_MS);

    // Two 5 s beats with no pong from the host: the first keeps it online, the
    // second (10 s) marks it offline and opens the 15 s grace window. The
    // responsive guest stays on, and no ping is sent before the 5 s interval.
    await advanceHeartbeat(clock, [host, guest]);
    expect(host.pingCount).toBe(1);
    expect(guest.pingCount).toBe(1);
    expect(
      manager
        .getRoom(roomId)
        ?.seats.find((seat) => seat.playerId === hostPlayerId)?.presence,
    ).toBe('online');

    await advanceHeartbeat(clock, [host, guest]);
    expect(host.pingCount).toBe(2);
    expect(guest.pingCount).toBe(2);

    await waitForEntryMessage(
      guest,
      'room_state',
      (message) =>
        message.type === 'room_state' &&
        message.players.some(
          (player) => player.playerId === hostPlayerId && player.presence === 'offline',
        ),
      'host offline',
    );
    expect(manager.getRoom(roomId)?.state).toBe('playing');
    expect(manager.getRoom(roomId)?.deadlineAt).toBe(turnDeadline);
    expect(manager.getMatch(roomId)?.state.turnDeadlineAt).toBe(turnDeadline);

    // A fresh connection resuming the same token inside the window restores
    // the seat, replaces the old socket and leaves both deadlines untouched.
    const replacement = await EntryClient.connect(server.port);
    entryClients.push(replacement);
    const oldHostClosed = host.closedWith();
    const guestFramesBeforeReconnect = guest.received.length;
    replacement.send(entryJoinMessage(roomId, hostToken));
    const resumed = (await waitForEntryMessage(
      replacement,
      'room_state',
      (message) => message.type === 'room_state' && message.playerToken === hostToken,
      'resumed room_state',
    )) as RoomStateMessage;
    expect(
      resumed.players.find((player) => player.playerId === hostPlayerId)?.presence,
    ).toBe('online');
    const resumedSnapshot = (await waitForEntryMessage(
      replacement,
      'snapshot',
      () => true,
      'resumed snapshot',
    )) as SnapshotMessage;
    expect(resumedSnapshot.deadlineAt).toBe(turnDeadline);
    expect(resumedSnapshot.matchDeadlineAt).toBe(matchDeadline);
    expect(await oldHostClosed).toEqual({ code: 4001, reason: 'session-replaced' });
    await waitForEntryMessage(
      guest,
      'room_state',
      (message) =>
        message.type === 'room_state' &&
        message.players.some(
          (player) => player.playerId === hostPlayerId && player.presence === 'online',
        ),
      'host online again',
      guestFramesBeforeReconnect,
    );
    expect(manager.getMatch(roomId)?.state.turnDeadlineAt).toBe(turnDeadline);

    // The reconnect cancelled grace: at the instant the original 15 s window
    // would have lapsed (10 s offline + 15 s), the match must still be playing
    // and no timeout may have been sent.
    while (clock.now() < START + 25_000) {
      await advanceHeartbeat(clock, [replacement, guest]);
    }
    expect(manager.getRoom(roomId)?.state).toBe('playing');
    expect(guest.received.filter((message) => message.type === 'timeout')).toHaveLength(0);

    // The original 30 s turn deadline still ends the match, so the replacement
    // socket did not restart the timer.
    while (clock.now() < turnDeadline) {
      await advanceHeartbeat(clock, [replacement, guest]);
    }
    const timeout = await waitForEntryMessage(
      guest,
      'timeout',
      (message) => message.type === 'timeout' && message.timer === 'turn',
      'turn timeout',
    );
    expect(timeout).toMatchObject({ deadlineAt: turnDeadline, subjectId: hostPlayerId });
    await waitForEntryMessage(
      replacement,
      'end',
      (message) => message.type === 'end' && message.reason === 'turn-timeout',
      'turn end',
    );
    expect(manager.getRoom(roomId)?.state).toBe('finished');
    expect(guest.received.filter((message) => message.type === 'timeout')).toHaveLength(1);
    expect(guest.received.filter((message) => message.type === 'end')).toHaveLength(1);

    // Nothing can produce a second terminal result after the scheduler is
    // cancelled by the finished state. The offline room_state from the idle
    // advance proves every earlier frame has been delivered before counting.
    const guestFramesBeforeIdleAdvance = guest.received.length;
    clock.advance(TURN_TIMEOUT_MS);
    await waitForEntryMessage(
      guest,
      'room_state',
      (message) =>
        message.type === 'room_state' &&
        message.players.some((player) => player.presence === 'offline'),
      'offline room_state after the match ended',
      guestFramesBeforeIdleAdvance,
    );
    expect(guest.received.filter((message) => message.type === 'timeout')).toHaveLength(1);
    expect(guest.received.filter((message) => message.type === 'end')).toHaveLength(1);
  });

  it('produces one match timeout and end when the whole-match cap comes first', async () => {
    const clock = new EntryClock(START);
    const manager = createRoomManager({
      now: () => clock.now(),
      createSeed: () => 7,
      turnTimeoutMs: 60_000,
      matchTimeoutMs: 20_000,
    });
    const server = await startEntryServer({ clock, manager });
    const { host, guest, roomId } = await createPlayingRoom(server);

    const match = manager.getMatch(roomId);
    if (match === null) {
      throw new Error('the real entry did not start a match');
    }
    expect(match.state.matchDeadlineAt).toBe(START + 20_000);

    for (let elapsed = 0; elapsed < 20_000; elapsed += HEARTBEAT_INTERVAL_MS) {
      await advanceHeartbeat(clock, [host, guest]);
    }
    const timeout = await waitForEntryMessage(
      host,
      'timeout',
      (message) => message.type === 'timeout' && message.timer === 'match',
      'match timeout',
    );
    expect(timeout).toMatchObject({
      timer: 'match',
      deadlineAt: match.state.matchDeadlineAt,
      resultingState: 'finished',
    });
    await waitForEntryMessage(
      guest,
      'end',
      (message) => message.type === 'end' && message.reason === 'match-timeout',
      'match end',
    );
    expect(manager.getRoom(roomId)?.state).toBe('finished');
    expect(host.received.filter((message) => message.type === 'timeout')).toHaveLength(1);
    expect(host.received.filter((message) => message.type === 'end')).toHaveLength(1);
  });

  it('lets the existing join window expire through the production entry', async () => {
    const clock = new EntryClock(START);
    // No manager is injected: the entry must create one on the shared clock so
    // the 120 s window it stamps is the same window the scheduler measures.
    const server = await startEntryServer({
      clock,
      managerOptions: { createSeed: () => 7 },
    });
    const host = await EntryClient.connect(server.port);
    entryClients.push(host);
    host.send(entryCreateMessage());
    const created = (await waitForEntryMessage(
      host,
      'room_state',
      (message) => message.type === 'room_state' && message.players.length === 1,
      'created room_state',
    )) as RoomStateMessage;
    expect(created.joinDeadlineAt).toBe(START + JOIN_TIMEOUT_MS);

    // Keep the host answering heartbeats so the join timer, not a grace
    // expiry, is what ends the room.
    for (let elapsed = 0; elapsed < JOIN_TIMEOUT_MS; elapsed += HEARTBEAT_INTERVAL_MS) {
      await advanceHeartbeat(clock, [host]);
    }
    const timeout = await waitForEntryMessage(
      host,
      'timeout',
      (message) => message.type === 'timeout' && message.timer === 'join',
      'join timeout',
    );
    expect(timeout).toMatchObject({
      timer: 'join',
      deadlineAt: created.joinDeadlineAt,
      resultingState: 'dissolved',
    });
    await waitForEntryMessage(
      host,
      'room_closed',
      (message) => message.type === 'room_closed' && message.reason === 'join-timeout',
      'join-timeout room_closed',
    );
  });

  it('cancels heartbeat and deadline timers when the entry server closes', async () => {
    const clock = new EntryClock(START);
    const manager = createRoomManager({
      now: () => clock.now(),
      createSeed: () => 7,
    });
    const server = await startEntryServer({ clock, manager });
    const host = await EntryClient.connect(server.port, { autoPong: false });
    entryClients.push(host);
    host.send(entryCreateMessage());
    const created = (await waitForEntryMessage(
      host,
      'room_state',
      (message) => message.type === 'room_state' && message.players.length === 1,
      'created room_state',
    )) as RoomStateMessage;

    // Put the seat into its reconnect grace window so shutdown has a heartbeat
    // interval, a grace timer and the room's join deadline to release, rather
    // than only the two timers of an online connection.
    clock.advance(HEARTBEAT_INTERVAL_MS);
    clock.advance(HEARTBEAT_INTERVAL_MS);
    await waitForEntryMessage(
      host,
      'room_state',
      (message) =>
        message.type === 'room_state' &&
        message.players.some((player) => player.presence === 'offline'),
      'offline room_state',
    );
    expect(clock.timerCount).toBeGreaterThanOrEqual(3);

    await server.close();

    // No heartbeat, grace or room-deadline timer survives the close.
    expect(clock.timerCount).toBe(0);
    clock.advance(JOIN_TIMEOUT_MS * 2);
    expect(manager.roomCount).toBe(1);
    expect(manager.getRoom(created.roomId)?.state).toBe('waiting');
  });
});
