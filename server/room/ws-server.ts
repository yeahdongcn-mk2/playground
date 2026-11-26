/**
 * Network transport for the standalone online Minesweeper room service.
 *
 * This module owns exactly two things: the small HTTP surface used by health
 * checks and the WebSocket connection that carries the shared protocol from
 * `src/games/minesweeper/online`. It deliberately owns no room state: every
 * lifecycle command and every authoritative action is handed to an injected
 * {@link MatchRoomManager}, and the transport only turns the manager's
 * {@link RoomCommandResult} / {@link MatchCommandResult} into sends.
 *
 * Three invariants keep the transport a thin layer:
 *
 * - A client message is validated with the shared `validateClientMessage`
 *   (which also pins the protocol version on `create`/`join`) before the room
 *   manager is called. Invalid input produces a protocol `error` and leaves the
 *   room untouched.
 * - An `action` is forwarded to {@link MatchRoomManager.action} exactly like a
 *   lifecycle command. The manager owns turn arbitration and builds the
 *   per-seat `action_result` / `snapshot` deliveries, so the transport never
 *   applies a board rule or answers an action locally.
 * - Deliveries are addressed by `playerToken`, per the contract in
 *   `contracts.ts`. A seat's token is only ever sent back to the connection
 *   that owns that seat, and a token with no live connection is dropped
 *   instead of being re-addressed to the caller.
 * - Every delivery batch passes one seam: the batch is sent to its seats and
 *   then each room it mentions is re-armed in the injected
 *   {@link DeadlineScheduler}. Command results and the asynchronous presence /
 *   grace-expiry deliveries both go through it, so a lifecycle command that
 *   moved `joinDeadlineAt`, `turnDeadlineAt` or `matchDeadlineAt` is followed by
 *   exactly one timer recomputation and a dissolved/finished room loses its
 *   timer. The scheduler owns the timers; the transport only tells it which
 *   rooms changed.
 *
 * Connection lifecycle has two transport-owned rules. First, a closed socket
 * removes its connection mapping and nothing else: presence, reconnect grace
 * and timer-driven room transitions belong to the injected
 * {@link PresenceController} and the room/match layers, which the transport
 * only notifies. Second, a `playerToken` has at most one live socket: a
 * successful `create`/`join` that binds a token already owned by another
 * connection closes the older socket (`4001` / `session-replaced`). Replacing
 * only swaps sockets, so it never advances `seq` or moves a room deadline.
 */

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { createProtocolError, protocolErrorFromResult, validateClientMessage } from '../../src/games/minesweeper/online/index';
import type {
  ClientToServerMessage,
  ProtocolErrorCode,
  ServerToClientMessage,
} from '../../src/games/minesweeper/online/index';
import { DEFAULT_ROOM_SERVER_PORT } from './contracts';
import type {
  MatchCommandResult,
  MatchRoomManager,
  PlayerToken,
  PresenceController,
  PresenceSocket,
  RoomCommandResult,
  RoomConnection,
  RoomDelivery,
  RoomId,
} from './contracts';
import type { DeadlineScheduler } from './deadline-scheduler';

/** HTTP path of the health probe: `GET /health` → `200 {"status":"ok"}`. */
export const ROOM_HEALTH_PATH = '/health';

/** WebSocket upgrade path used by room clients. */
export const ROOM_WS_PATH = '/ws';

/** Loopback host used by default; deployments pass their own bind host. */
const DEFAULT_ROOM_SERVER_HOST = '127.0.0.1';

/**
 * Upper bound for one client frame. Protocol messages are a few KiB; the cap
 * keeps a misbehaving client from forcing the room service to buffer a large
 * payload. An oversized frame is rejected by `ws` before it reaches the hub.
 */
const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;

/** Application close code for a socket replaced by a newer connection. */
const SESSION_REPLACED_CLOSE_CODE = 4001;

/** Application close reason paired with {@link SESSION_REPLACED_CLOSE_CODE}. */
const SESSION_REPLACED_REASON = 'session-replaced';

/** Options accepted by {@link startRoomServer}. */
export interface RoomServerOptions {
  /**
   * The room manager the transport delegates every lifecycle command and
   * authoritative action to. Injecting it (instead of constructing a room
   * table here) keeps the transport testable against a fake and keeps room
   * state out of the socket layer.
   */
  readonly manager: MatchRoomManager;
  /**
   * Optional connection-layer presence controller (design 5.1–5.3).
   *
   * When injected, the transport reports socket open/close, `pong` frames and
   * token bind/unbind changes to it, and hands it a ping-only socket adapter.
   * The controller owns heartbeat timing and grace; the transport never drives
   * a timer itself. Without a controller the transport keeps the pre-presence
   * behaviour: connections live and die and the room layer is untouched.
   *
   * The optional `close` hook is the controller's own shutdown cleanup: the
   * transport calls it before closing the sockets so heartbeat and grace
   * timers do not outlive the server.
   */
  readonly presence?: PresenceController & { readonly close?: () => void };
  /**
   * Optional room-deadline scheduler (`deadline-scheduler.ts`).
   *
   * The transport refreshes it after every delivered batch, which covers both
   * client command results and the asynchronous presence / grace-expiry
   * deliveries the controller hands back through `RoomServer.deliver`. It is
   * cancelled wholesale by `close()`. Without a scheduler the transport keeps
   * its command-only behaviour and no timer is armed.
   */
  readonly deadlines?: DeadlineScheduler;
  /** Bind host; defaults to loopback so a local server is not exposed. */
  readonly host?: string;
  /** Bind port; `0` asks the OS for a free port (useful in tests). */
  readonly port?: number;
}

/** Running transport handle returned once the server is listening. */
export interface RoomServer {
  /** Actual bind host (the requested host, not a resolved address). */
  readonly host: string;
  /** Actual bound port; differs from the requested port when `port: 0` was used. */
  readonly port: number;
  /**
   * Deliver room messages that were not a response to a client message, such
   * as timer-driven `timeout`/`room_closed` broadcasts. The room manager uses
   * this for its asynchronous deliveries; tokens without a live connection are
   * dropped. Any room mentioned by the batch is re-armed in the deadline
   * scheduler after the send, so a presence transition that dissolved the room
   * also releases its timer.
   */
  deliver(deliveries: readonly RoomDelivery[]): void;
  /** Stop accepting connections, close every client and release the port. */
  close(): Promise<void>;
}

/** One live socket and the seat token it currently owns, if any. */
interface ClientConnection {
  readonly id: string;
  readonly socket: WebSocket;
  playerToken: PlayerToken | null;
}

/** Identity fields a rejected message may still carry. */
interface MessageIdentity {
  readonly requestId: string | null;
  readonly roomId: string | null;
}

/** Presence hook names, used to label controller faults in diagnostics. */
type PresenceHook =
  | 'connectionOpened'
  | 'connectionClosed'
  | 'pongReceived'
  | 'tokenBound'
  | 'tokenUnbound';

function readRequestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://room.invalid').pathname;
  } catch {
    return '/';
  }
}

function handleHttpRequest(request: IncomingMessage, response: ServerResponse): void {
  if (request.method === 'GET' && readRequestPath(request) === ROOM_HEALTH_PATH) {
    const body = '{"status":"ok"}';
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    response.end(body);
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('not found');
}

function decodeMessageText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return data.toString('utf8');
}

function sendMessage(socket: WebSocket, message: ServerToClientMessage): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}

/** Preserve whichever identity fields a malformed message happens to carry. */
function readMessageIdentity(input: unknown): MessageIdentity {
  if (typeof input !== 'object' || input === null) {
    return { requestId: null, roomId: null };
  }
  const record = input as Readonly<Record<string, unknown>>;
  const requestId = record['requestId'];
  const roomId = record['roomId'];
  return {
    requestId: typeof requestId === 'string' ? requestId : null,
    roomId: typeof roomId === 'string' ? roomId : null,
  };
}

/**
 * Per-server connection registry.
 *
 * The registry is the only place that knows which socket owns which seat
 * token. It holds at most one live socket per token: binding a token that
 * another connection already owns replaces that connection. It never asks the
 * room manager to change state when a socket closes; presence changes are
 * reported to the injected {@link PresenceController} instead.
 *
 * Delivery is also the scheduler seam: after a batch is sent, the optional
 * `onDeliver` callback receives that same batch so the host can re-arm the
 * rooms it mentions. Keeping the callback on the one `deliverAll` path means a
 * client command result, a server-initiated delivery and a presence transition
 * are treated identically.
 *
 * Exported so the unit tests can drive it directly with fake sockets and
 * assert deterministic registry behaviour (replacement removes the old socket
 * before it closes). Production code reaches it through {@link startRoomServer}.
 *
 * @internal
 */
export class RoomSocketHub {
  private readonly manager: MatchRoomManager;
  private readonly presence: PresenceController | null;
  private readonly onDeliver: ((deliveries: readonly RoomDelivery[]) => void) | null;
  private readonly connections = new Map<WebSocket, ClientConnection>();
  private readonly tokenConnections = new Map<PlayerToken, ClientConnection>();
  private nextConnectionId = 1;

  constructor(
    manager: MatchRoomManager,
    presence: PresenceController | null,
    onDeliver: ((deliveries: readonly RoomDelivery[]) => void) | null = null,
  ) {
    this.manager = manager;
    this.presence = presence;
    this.onDeliver = onDeliver;
  }

  addConnection(socket: WebSocket): void {
    const connection: ClientConnection = {
      id: `connection-${this.nextConnectionId}`,
      socket,
      playerToken: null,
    };
    this.nextConnectionId += 1;
    this.connections.set(socket, connection);

    socket.on('message', (data: RawData, isBinary: boolean) => {
      this.handleMessage(connection, data, isBinary);
    });
    socket.on('pong', () => {
      // A replaced socket may still deliver a pong while it closes; the
      // connection no longer owns an active entry, so do not report it.
      if (this.connections.get(socket) === connection) {
        this.notifyPresence('pongReceived', (presence) =>
          presence.pongReceived(connection.id),
        );
      }
    });
    socket.on('close', () => {
      this.removeConnection(connection);
      this.notifyPresence('connectionClosed', (presence) =>
        presence.connectionClosed(connection.id),
      );
    });
    socket.on('error', () => {
      // A transport error is followed by `close`, which cleans the mapping.
      socket.terminate();
    });

    this.notifyPresence('connectionOpened', (presence) =>
      presence.connectionOpened(connection.id, this.presenceSocket(socket)),
    );
  }

  /**
   * Run one presence hook without letting a controller fault break transport
   * bookkeeping.
   *
   * Presence is an observer of the socket layer: a throw from the controller
   * must not prevent a replacement close, skip deliveries or leak an uncaught
   * exception out of a WebSocket event listener.
   */
  private notifyPresence(
    hook: PresenceHook,
    notify: (presence: PresenceController) => void,
  ): void {
    if (this.presence === null) {
      return;
    }
    try {
      notify(this.presence);
    } catch (error) {
      // The controller is an internal collaborator, so its failure must not
      // corrupt the transport's state machine. Report it rather than swallow
      // it: a controller fault would otherwise be completely invisible.
      console.error(`[room] presence ${hook} hook failed`, error);
    }
  }

  /** Adapt the live socket to the ping-only surface the controller may use. */
  private presenceSocket(socket: WebSocket): PresenceSocket {
    return {
      ping: () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.ping();
        }
      },
    };
  }

  deliverAll(deliveries: readonly RoomDelivery[]): void {
    for (const delivery of deliveries) {
      this.deliver(delivery);
    }
    // The batch is sent before the deadline seam runs: a timeout that jumps
    // straight to `finished` must reach the clients before its timer is
    // cancelled, and a command result is already observable when the next
    // deadline is armed.
    if (this.onDeliver !== null) {
      this.onDeliver(deliveries);
    }
  }

  private handleMessage(
    connection: ClientConnection,
    data: RawData,
    isBinary: boolean,
  ): void {
    // A replaced connection may still have a frame in flight while it closes.
    // It no longer owns a socket entry, so it must not act on the room.
    if (this.connections.get(connection.socket) !== connection) {
      return;
    }

    if (isBinary) {
      this.sendError(connection.socket, 'bad-request', 'binary messages are not supported');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeMessageText(data));
    } catch {
      this.sendError(connection.socket, 'bad-request', 'message must be valid JSON');
      return;
    }

    const validation = validateClientMessage(parsed);
    if (!validation.ok) {
      sendMessage(
        connection.socket,
        protocolErrorFromResult(validation, readMessageIdentity(parsed)),
      );
      return;
    }

    try {
      const result = this.runCommand(connection, validation.value);
      // Deliver before releasing a leaving connection's token: the room layer
      // builds a final `room_closed` for the leaving seat before removing it,
      // and the socket that carried that token must still receive it.
      this.applyCommandResult(connection, result);
      if (validation.value.type === 'leave' && result.ok) {
        // The seat is released, so the connection stops owning its token. This
        // is a transport binding change, not a room event: a deliberate leave
        // must not open a reconnect grace window for the token.
        this.unbindToken(connection);
      }
    } catch {
      // A manager failure is a server-side fault, but it must not drop the
      // socket or take the process down. Report it as a rejected request while
      // keeping the already-validated identity so the client can correlate it.
      this.sendError(
        connection.socket,
        'bad-request',
        'the room service could not handle the message',
        readMessageIdentity(validation.value),
      );
    }
  }

  /** Dispatch one validated client message to the manager. */
  private runCommand(
    connection: ClientConnection,
    message: ClientToServerMessage,
  ): RoomCommandResult | MatchCommandResult {
    const roomConnection: RoomConnection = {
      connectionId: connection.id,
      playerToken: connection.playerToken,
    };

    switch (message.type) {
      case 'create':
        return this.manager.create(roomConnection, message);
      case 'join':
        return this.manager.join(roomConnection, message);
      case 'ready':
        return this.manager.ready(roomConnection, message);
      case 'start':
        return this.manager.start(roomConnection, message);
      case 'leave':
        return this.manager.leave(roomConnection, message);
      case 'rematch':
        return this.manager.rematch(roomConnection, message);
      case 'action':
        // The manager also owns the authoritative match layer (#484); forward
        // the action and let it decide the deliveries. A rejection comes back
        // as a match result and is sent by `applyCommandResult`.
        return this.manager.action(roomConnection, message);
    }
  }

  private applyCommandResult(
    connection: ClientConnection,
    result: RoomCommandResult | MatchCommandResult,
  ): void {
    if (!result.ok) {
      sendMessage(connection.socket, result.error);
      return;
    }

    if (result.boundToken !== undefined) {
      this.bindToken(connection, result.boundToken);
    }
    this.deliverAll(result.deliveries);
  }

  private deliver(delivery: RoomDelivery): void {
    const recipient = this.tokenConnections.get(delivery.playerToken);
    if (recipient === undefined) {
      // The seat has no live connection (offline), so the message is dropped
      // rather than sent to a different connection.
      return;
    }
    if (recipient.socket.readyState === WebSocket.OPEN) {
      recipient.socket.send(JSON.stringify(delivery.message));
    }
  }

  private bindToken(connection: ClientConnection, token: PlayerToken): void {
    if (connection.playerToken === token) {
      return;
    }
    this.unbindToken(connection);
    this.replaceTokenOwner(token);
    connection.playerToken = token;
    this.tokenConnections.set(token, connection);
    this.notifyPresence('tokenBound', (presence) =>
      presence.tokenBound(connection.id, token),
    );
  }

  /**
   * Close and forget the connection that currently owns `token`.
   *
   * The old connection is unbound before its socket closes, so the later
   * `close` event cannot make the presence controller start a grace window for
   * the token: it is already owned by the replacement. Only the socket swap is
   * observable, and this path never calls the room manager, so `seq` and the
   * `turn` / `match` deadlines stay exactly where they were.
   */
  private replaceTokenOwner(token: PlayerToken): void {
    const existing = this.tokenConnections.get(token);
    if (existing === undefined) {
      return;
    }
    this.connections.delete(existing.socket);
    this.unbindToken(existing);
    existing.socket.close(SESSION_REPLACED_CLOSE_CODE, SESSION_REPLACED_REASON);
  }

  /** Release one connection's token binding without closing its socket. */
  private unbindToken(connection: ClientConnection): void {
    const token = connection.playerToken;
    if (token === null) {
      return;
    }
    connection.playerToken = null;
    if (this.tokenConnections.get(token) === connection) {
      this.tokenConnections.delete(token);
    }
    this.notifyPresence('tokenUnbound', (presence) =>
      presence.tokenUnbound(connection.id),
    );
  }

  /**
   * Forget a closed socket.
   *
   * The presence controller owns the token→offline transition through
   * `connectionClosed`, so this helper only clears the transport maps and must
   * not emit `tokenUnbound` (which means the seat was released or replaced
   * while the connection was still usable).
   */
  private removeConnection(connection: ClientConnection): void {
    this.connections.delete(connection.socket);
    const token = connection.playerToken;
    if (token === null) {
      return;
    }
    connection.playerToken = null;
    if (this.tokenConnections.get(token) === connection) {
      this.tokenConnections.delete(token);
    }
  }

  private sendError(
    socket: WebSocket,
    code: ProtocolErrorCode,
    message: string,
    identity: MessageIdentity = { requestId: null, roomId: null },
  ): void {
    sendMessage(
      socket,
      createProtocolError(code, {
        requestId: identity.requestId,
        roomId: identity.roomId,
        message,
      }),
    );
  }
}

function listenOn(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    for (const client of server.clients) {
      client.terminate();
    }
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

/**
 * Re-arm the deadline of every room mentioned by one delivered batch.
 *
 * The scheduler is an internal collaborator on the delivery path, so a fault
 * in it must not turn an already-successful command into a protocol error or
 * break the batch that was just sent. The room id comes from the message, and
 * `null` (an error frame that never travels as a delivery) is ignored.
 */
function refreshDeliveredRooms(
  deadlines: DeadlineScheduler,
  deliveries: readonly RoomDelivery[],
): void {
  const roomIds = new Set<RoomId>();
  for (const delivery of deliveries) {
    const roomId = delivery.message.roomId;
    if (roomId !== null) {
      roomIds.add(roomId);
    }
  }
  for (const roomId of roomIds) {
    try {
      deadlines.refresh(roomId);
    } catch (error) {
      console.error(`[room] deadline refresh failed for ${roomId}`, error);
    }
  }
}

/**
 * Start the HTTP/WebSocket transport on a real socket.
 *
 * `port: 0` binds an ephemeral port and the returned handle reports the actual
 * port, which is how the unit tests keep every case independent. The returned
 * `close` is idempotent so a `SIGTERM` handler can call it more than once.
 */
export async function startRoomServer(
  options: RoomServerOptions,
): Promise<RoomServer> {
  const host = options.host ?? DEFAULT_ROOM_SERVER_HOST;
  const requestedPort = options.port ?? DEFAULT_ROOM_SERVER_PORT;
  const presence = options.presence ?? null;
  const deadlines = options.deadlines ?? null;
  let closing = false;
  const hub = new RoomSocketHub(
    options.manager,
    presence,
    deadlines === null
      ? null
      : (deliveries) => {
          // A late delivery after shutdown must not re-arm a deadline that
          // `close()` already released.
          if (!closing) {
            refreshDeliveredRooms(deadlines, deliveries);
          }
        },
  );
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
  });
  const httpServer = createHttpServer(handleHttpRequest);

  webSocketServer.on('connection', (socket: WebSocket) => {
    hub.addConnection(socket);
  });

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closing || readRequestPath(request) !== ROOM_WS_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request);
    });
  });

  await listenOn(httpServer, requestedPort, host);

  const address = httpServer.address();
  const port =
    address !== null && typeof address === 'object' ? address.port : requestedPort;

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closePromise === null) {
      closing = true;
      closePromise = (async () => {
        // Stop timer owners before the sockets go away, so no heartbeat or
        // grace timer survives the transport. Both cleanups are best-effort:
        // a failure there must not skip closing the listeners.
        try {
          presence?.close?.();
        } catch (error) {
          console.error('[room] presence close failed', error);
        }
        try {
          deadlines?.cancelAll();
        } catch (error) {
          console.error('[room] deadline cancelAll failed', error);
        }
        await closeWebSocketServer(webSocketServer);
        await closeHttpServer(httpServer);
      })();
    }
    return closePromise;
  };

  return {
    host,
    port,
    deliver: (deliveries) => hub.deliverAll(deliveries),
    close,
  };
}
