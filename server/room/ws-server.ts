/**
 * Network transport for the standalone online Minesweeper room service.
 *
 * This module owns exactly two things: the small HTTP surface used by health
 * checks and the WebSocket connection that carries the shared protocol from
 * `src/games/minesweeper/online`. It deliberately owns no room state: every
 * lifecycle command is handed to an injected {@link RoomManager}, and the
 * transport only turns the manager's {@link RoomCommandResult} into sends.
 *
 * Two invariants keep the transport a thin layer:
 *
 * - A client message is validated with the shared `validateClientMessage`
 *   (which also pins the protocol version on `create`/`join`) before the room
 *   manager is called. Invalid input produces a protocol `error` and leaves the
 *   room untouched.
 * - Deliveries are addressed by `playerToken`, per the contract in
 *   `contracts.ts`. A seat's token is only ever sent back to the connection
 *   that owns that seat, and a token with no live connection is dropped
 *   instead of being re-addressed to the caller.
 *
 * The transport is intentionally passive about connection lifecycle: a closed
 * socket removes its connection mapping and nothing else. Presence, reconnect
 * grace and timer-driven room transitions belong to the room/match layers.
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
  PlayerToken,
  RoomCommandResult,
  RoomConnection,
  RoomDelivery,
  RoomManager,
} from './contracts';

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

/** Options accepted by {@link startRoomServer}. */
export interface RoomServerOptions {
  /**
   * The room manager the transport delegates every lifecycle command to.
   * Injecting it (instead of constructing a room table here) keeps the
   * transport testable against a fake and keeps room state out of the socket
   * layer.
   */
  readonly manager: RoomManager;
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
   * dropped.
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
 * token. It never asks the room manager to change state when a socket closes.
 */
class RoomSocketHub {
  private readonly manager: RoomManager;
  private readonly connections = new Map<WebSocket, ClientConnection>();
  private readonly tokenConnections = new Map<PlayerToken, Set<ClientConnection>>();
  private nextConnectionId = 1;

  constructor(manager: RoomManager) {
    this.manager = manager;
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
    socket.on('close', () => {
      this.removeConnection(connection);
    });
    socket.on('error', () => {
      // A transport error is followed by `close`, which cleans the mapping.
      socket.terminate();
    });
  }

  deliverAll(deliveries: readonly RoomDelivery[]): void {
    for (const delivery of deliveries) {
      this.deliver(delivery);
    }
  }

  private handleMessage(
    connection: ClientConnection,
    data: RawData,
    isBinary: boolean,
  ): void {
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
      if (result !== null) {
        this.applyCommandResult(connection, result);
      }
    } catch {
      // A manager failure is a server-side fault, but it must not drop the
      // socket or take the process down. Report it as a rejected request.
      this.sendError(
        connection.socket,
        'bad-request',
        'the room service could not handle the message',
      );
    }
  }

  /** Dispatch one validated client message; `null` means it was answered directly. */
  private runCommand(
    connection: ClientConnection,
    message: ClientToServerMessage,
  ): RoomCommandResult | null {
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
        // The shared protocol accepts actions, but the authoritative match
        // layer (#484) owns them. The room lifecycle transport must not
        // pretend to apply one.
        this.sendError(
          connection.socket,
          'bad-request',
          'action messages are not handled by the room lifecycle transport',
        );
        return null;
    }
  }

  private applyCommandResult(
    connection: ClientConnection,
    result: RoomCommandResult,
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
    const recipients = this.tokenConnections.get(delivery.playerToken);
    if (recipients === undefined) {
      // The seat has no live connection (offline), so the message is dropped
      // rather than sent to a different connection.
      return;
    }
    const payload = JSON.stringify(delivery.message);
    for (const recipient of recipients) {
      if (recipient.socket.readyState === WebSocket.OPEN) {
        recipient.socket.send(payload);
      }
    }
  }

  private bindToken(connection: ClientConnection, token: PlayerToken): void {
    if (connection.playerToken === token) {
      return;
    }
    this.unbindToken(connection);
    connection.playerToken = token;
    const recipients = this.tokenConnections.get(token);
    if (recipients === undefined) {
      this.tokenConnections.set(token, new Set([connection]));
      return;
    }
    recipients.add(connection);
  }

  private unbindToken(connection: ClientConnection): void {
    const token = connection.playerToken;
    if (token === null) {
      return;
    }
    connection.playerToken = null;
    const recipients = this.tokenConnections.get(token);
    if (recipients === undefined) {
      return;
    }
    recipients.delete(connection);
    if (recipients.size === 0) {
      this.tokenConnections.delete(token);
    }
  }

  private removeConnection(connection: ClientConnection): void {
    if (!this.connections.has(connection.socket)) {
      return;
    }
    this.connections.delete(connection.socket);
    this.unbindToken(connection);
  }

  private sendError(
    socket: WebSocket,
    code: ProtocolErrorCode,
    message: string,
  ): void {
    sendMessage(socket, createProtocolError(code, { message }));
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
  const hub = new RoomSocketHub(options.manager);
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
  });
  const httpServer = createHttpServer(handleHttpRequest);
  let closing = false;

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
