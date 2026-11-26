// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSessionStorageTokenStore,
  mountOnlineRoom,
  onlineSeatStorageKey,
} from '../../src/games/minesweeper/online/client/online-room';
import {
  ONLINE_MINESWEEPER_HREF,
  type OnlineRoomHandle,
  type SeatSession,
} from '../../src/games/minesweeper/online/client/contracts';
import type { RoomTransportSocket } from '../../src/games/minesweeper/online/client/transport';
import type { OnlineRoomViewOptions } from '../../src/games/minesweeper/online/client/room-view';
import { validateClientMessage } from '../../src/games/minesweeper/online/protocol';
import { PROTOCOL_VERSION } from '../../src/games/minesweeper/online/types';
import type {
  ActionResultMessage,
  ActionMessage,
  ClientToServerMessage,
  CreateMessage,
  LeaveMessage,
  PlayerView,
  RedactedBoard,
  RoomStateMessage,
  SnapshotMessage,
} from '../../src/games/minesweeper/online/types';
import type { MinesweeperConfig } from '../../src/games/minesweeper/engine';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const ROOM_ID = 'room_entry_test';
const MATCH_ID = 'match_entry_test';
const HOST_ID = 'player_host';
const HOST_TOKEN = 'host-token-entry';
const CONFIG: MinesweeperConfig = {
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
};

function hostPlayer(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    playerId: HOST_ID,
    displayName: 'Ada',
    ready: false,
    presence: 'online',
    isHost: true,
    ...overrides,
  };
}

function roomState(overrides: Partial<RoomStateMessage> = {}): RoomStateMessage {
  return {
    type: 'room_state',
    roomId: ROOM_ID,
    seq: 1,
    state: 'waiting',
    hostId: HOST_ID,
    capacity: 2,
    players: [hostPlayer()],
    config: CONFIG,
    matchId: null,
    turnPlayerId: null,
    joinDeadlineAt: NOW + 90_000,
    deadlineAt: null,
    stateReason: null,
    ...overrides,
  };
}

function redactedBoard(rows: number, cols: number): RedactedBoard {
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, col) => ({
      row,
      col,
      revealed: false,
      flagged: false,
      adjacentMines: 0,
    })),
  );
}

function snapshot(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    type: 'snapshot',
    roomId: ROOM_ID,
    matchId: MATCH_ID,
    seq: 3,
    turnPlayerId: HOST_ID,
    turnId: 2,
    seedHash: 'seed-hash',
    deadlineAt: NOW + 30_000,
    matchDeadlineAt: NOW + 600_000,
    elapsedMs: 1_000,
    engineStatus: 'playing',
    mineCount: CONFIG.mines,
    remainingMines: CONFIG.mines,
    revealedSafeCount: 0,
    board: redactedBoard(CONFIG.rows, CONFIG.cols),
    ...overrides,
  };
}

function actionResult(overrides: Partial<ActionResultMessage> = {}): ActionResultMessage {
  return {
    type: 'action_result',
    roomId: ROOM_ID,
    matchId: MATCH_ID,
    actionId: 'action-entry-test',
    seq: 4,
    turnId: 2,
    accepted: true,
    reason: null,
    revealedCells: [{ row: 0, col: 0 }],
    flaggedCell: null,
    turnPlayerId: HOST_ID,
    deadlineAt: NOW + 30_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake browser WebSocket
// ---------------------------------------------------------------------------

/** Minimal browser WebSocket driven directly by the test. */
class FakeSocket implements RoomTransportSocket {
  readonly sent: string[] = [];
  readonly url: string;
  closed: { readonly code: number | undefined; readonly reason: string | undefined } | null =
    null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null =
    null;
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

  /** Deliver the browser `open` event, flushing the transport's queued frame. */
  open(): void {
    this.onopen?.(undefined);
  }

  /** Deliver one server frame through the transport's validator. */
  receive(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.({ data });
  }
}

// ---------------------------------------------------------------------------
// Mount harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly root: HTMLElement;
  readonly handle: OnlineRoomHandle;
  readonly sockets: FakeSocket[];
}

const harnesses: Harness[] = [];

/** Mount the real composition root with only the WebSocket faked. */
function mountRoom(options: OnlineRoomViewOptions = {}): Harness {
  const sockets: FakeSocket[] = [];
  const root = document.createElement('div');
  document.body.append(root);
  const handle = mountOnlineRoom(root, options, {
    socketFactory(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const harness: Harness = { root, handle, sockets };
  harnesses.push(harness);
  return harness;
}

function byTestId<T extends Element>(root: ParentNode, testId: string): T {
  const element = root.querySelector<T>(`[data-testid="${testId}"]`);
  if (element === null) {
    throw new Error(`missing element: ${testId}`);
  }
  return element;
}

function submitCreate(root: HTMLElement, displayName: string): void {
  const nickname = byTestId<HTMLInputElement>(root, 'nickname');
  nickname.value = displayName;
  byTestId<HTMLFormElement>(root, 'create-form').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
}

function sentMessage(socket: FakeSocket, index: number): ClientToServerMessage {
  const raw = socket.sent.at(index);
  if (raw === undefined) {
    throw new Error(`the socket did not send frame ${index}`);
  }
  return JSON.parse(raw) as ClientToServerMessage;
}

function firstSocket(harness: Harness): FakeSocket {
  const socket = harness.sockets[0];
  if (socket === undefined) {
    throw new Error('the mount did not open a socket');
  }
  return socket;
}

/** Create a room through the real view/store/transport and return its socket. */
function createRoom(harness: Harness): FakeSocket {
  submitCreate(harness.root, 'Ada');
  const socket = firstSocket(harness);
  socket.open();
  return socket;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.handle.destroy();
  }
  document.body.replaceChildren();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

// ---------------------------------------------------------------------------
// Mount and browser assembly
// ---------------------------------------------------------------------------

describe('mountOnlineRoom composition root', () => {
  it('mounts the create/join landing page without opening a socket', () => {
    const harness = mountRoom();

    expect(byTestId<HTMLElement>(harness.root, 'landing').hidden).toBe(false);
    expect(byTestId<HTMLElement>(harness.root, 'connecting').hidden).toBe(true);
    expect(byTestId<HTMLSelectElement>(harness.root, 'difficulty').value).toBe('beginner');
    expect(harness.sockets).toHaveLength(0);
    expect(harness.handle.roomId).toBe('');
    expect(harness.handle.getState()).toMatchObject({
      phase: 'idle',
      connection: 'idle',
      room: null,
      snapshot: null,
    });
  });

  it('prefills the join form and stored nickname from a room href', () => {
    window.sessionStorage.setItem(
      onlineSeatStorageKey(ROOM_ID),
      JSON.stringify({
        roomId: ROOM_ID,
        playerToken: HOST_TOKEN,
        displayName: 'Ada',
        role: 'host',
      } satisfies SeatSession),
    );

    const harness = mountRoom({ roomId: ROOM_ID });

    expect(byTestId<HTMLInputElement>(harness.root, 'nickname').value).toBe('Ada');
    expect(byTestId<HTMLInputElement>(harness.root, 'join-room-id').value).toBe(ROOM_ID);
    expect(byTestId<HTMLElement>(harness.root, 'share-prefill').hidden).toBe(false);
    expect(harness.sockets).toHaveLength(0);
  });

  it('creates a room through the real transport and persists the seat token', () => {
    const harness = mountRoom();
    const socket = createRoom(harness);

    expect(new URL(socket.url).pathname).toBe('/ws');
    expect(socket.sent).toHaveLength(1);
    const create = sentMessage(socket, 0) as CreateMessage;
    expect(validateClientMessage(create).ok).toBe(true);
    expect(create).toMatchObject({
      type: 'create',
      displayName: 'Ada',
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(create.config).toEqual(CONFIG);

    socket.receive(roomState({ playerToken: HOST_TOKEN }));

    expect(byTestId<HTMLElement>(harness.root, 'waiting').hidden).toBe(false);
    expect(byTestId(harness.root, 'room-id').textContent).toBe(ROOM_ID);
    expect(byTestId<HTMLAnchorElement>(harness.root, 'room-share-link').getAttribute('href')).toBe(
      `${ONLINE_MINESWEEPER_HREF}?room=${ROOM_ID}`,
    );
    expect(harness.handle.getState()).toMatchObject({
      phase: 'waiting',
      connection: 'connected',
      room: { roomId: ROOM_ID },
      selfId: HOST_ID,
    });

    const raw = window.sessionStorage.getItem(onlineSeatStorageKey(ROOM_ID));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? 'null')).toEqual({
      roomId: ROOM_ID,
      playerToken: HOST_TOKEN,
      displayName: 'Ada',
      role: 'host',
    } satisfies SeatSession);
  });

  it('renders the real redacted board and submits a cell reveal action', () => {
    const harness = mountRoom();
    const socket = createRoom(harness);

    socket.receive(roomState({ playerToken: HOST_TOKEN, seq: 1 }));
    socket.receive(
      roomState({
        playerToken: HOST_TOKEN,
        seq: 2,
        state: 'playing',
        matchId: MATCH_ID,
        turnPlayerId: HOST_ID,
        deadlineAt: NOW + 30_000,
      }),
    );
    socket.receive(snapshot({ seq: 3 }));

    const boardMount = byTestId<HTMLElement>(harness.root, 'online-board');
    expect(boardMount.dataset['actionsEnabled']).toBe('true');
    const cellCount = boardMount.querySelectorAll('button[data-cell]').length;
    expect(cellCount).toBe(CONFIG.rows * CONFIG.cols);
    // The shared live board never paints a mine; only the end board may.
    expect(boardMount.querySelector('[data-mine]')).toBeNull();

    const firstCell = boardMount.querySelector<HTMLButtonElement>('button[data-cell]');
    if (firstCell === null) {
      throw new Error('the real board renderer produced no cell');
    }
    expect(firstCell.disabled).toBe(false);
    firstCell.click();

    const action = sentMessage(socket, socket.sent.length - 1) as ActionMessage;
    expect(validateClientMessage(action).ok).toBe(true);
    expect(action).toMatchObject({
      type: 'action',
      roomId: ROOM_ID,
      matchId: MATCH_ID,
      kind: 'reveal',
      row: 0,
      col: 0,
      seq: 3,
      turnId: 2,
    });
  });

  it('locks the real board while an action waits for its snapshot', () => {
    const harness = mountRoom();
    const socket = createRoom(harness);

    socket.receive(roomState({ playerToken: HOST_TOKEN, seq: 1 }));
    socket.receive(
      roomState({
        playerToken: HOST_TOKEN,
        seq: 2,
        state: 'playing',
        matchId: MATCH_ID,
        turnPlayerId: HOST_ID,
        deadlineAt: NOW + 30_000,
      }),
    );
    socket.receive(snapshot({ seq: 3 }));

    const boardMount = byTestId<HTMLElement>(harness.root, 'online-board');
    const before = boardMount.querySelector<HTMLButtonElement>('button[data-cell]');
    if (before === null) {
      throw new Error('the real board renderer produced no cell');
    }
    expect(before.dataset['locked']).toBe('false');

    // `action_result` advances the store's lastSeq before the paired snapshot
    // arrives, so the snapshot is stale and the composed gate must keep the
    // whole board locked until the server resync lands.
    socket.receive(actionResult({ seq: 4 }));

    const locked = boardMount.querySelector<HTMLButtonElement>('button[data-cell]');
    if (locked === null) {
      throw new Error('the real board renderer produced no cell after the action result');
    }
    expect(locked.dataset['locked']).toBe('true');
    expect(locked.dataset['blockReason']).toBe('awaiting-server');
  });

  it('destroys the mounted room but keeps the seat resumable', () => {
    const harness = mountRoom();
    const socket = createRoom(harness);
    socket.receive(roomState({ playerToken: HOST_TOKEN }));

    harness.handle.destroy();

    expect(socket.closed).toEqual({ code: 1000, reason: 'client-close' });
    expect(harness.root.childElementCount).toBe(0);
    expect(window.sessionStorage.getItem(onlineSeatStorageKey(ROOM_ID))).not.toBeNull();

    const remounted = mountRoom({ roomId: ROOM_ID });
    expect(byTestId<HTMLInputElement>(remounted.root, 'nickname').value).toBe('Ada');
    expect(byTestId<HTMLInputElement>(remounted.root, 'join-room-id').value).toBe(ROOM_ID);
    expect(remounted.sockets).toHaveLength(0);
    expect(remounted.handle.getState().phase).toBe('idle');
  });

  it('clears the seat and rewrites location.hash when leaving the lobby', () => {
    const harness = mountRoom();
    const socket = createRoom(harness);
    socket.receive(roomState({ playerToken: HOST_TOKEN }));

    byTestId<HTMLButtonElement>(harness.root, 'leave-room').click();

    const leave = sentMessage(socket, socket.sent.length - 1) as LeaveMessage;
    expect(leave).toMatchObject({ type: 'leave', roomId: ROOM_ID });
    expect(window.location.hash).toBe('#/');
    expect(window.sessionStorage.getItem(onlineSeatStorageKey(ROOM_ID))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sessionStorage TokenStore
// ---------------------------------------------------------------------------

const STORED_SESSION: SeatSession = {
  roomId: ROOM_ID,
  playerToken: HOST_TOKEN,
  displayName: 'Ada',
  role: 'host',
};

/** A storage whose every operation throws, like a blocked browser store. */
function throwingStorage(): Storage {
  const fail = (): never => {
    throw new Error('storage is blocked');
  };
  return {
    get length(): number {
      return fail();
    },
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  } as unknown as Storage;
}

describe('createSessionStorageTokenStore', () => {
  it('persists a seat across store instances and forgets it on clear', () => {
    createSessionStorageTokenStore().save(STORED_SESSION);
    expect(window.sessionStorage.getItem(onlineSeatStorageKey(ROOM_ID))).not.toBeNull();

    const reloaded = createSessionStorageTokenStore();
    expect(reloaded.load(ROOM_ID)).toEqual(STORED_SESSION);

    reloaded.clear(ROOM_ID);
    expect(createSessionStorageTokenStore().load(ROOM_ID)).toBeNull();
  });

  it('drops a corrupt entry instead of failing the mount', () => {
    window.sessionStorage.setItem(onlineSeatStorageKey(ROOM_ID), '{not json');

    expect(createSessionStorageTokenStore().load(ROOM_ID)).toBeNull();
    expect(window.sessionStorage.getItem(onlineSeatStorageKey(ROOM_ID))).toBeNull();
  });

  it('stays usable and forgets the token when the storage throws', () => {
    const store = createSessionStorageTokenStore(throwingStorage());

    expect(() => store.save(STORED_SESSION)).not.toThrow();
    expect(store.load(ROOM_ID)).toEqual(STORED_SESSION);

    expect(() => store.clear(ROOM_ID)).not.toThrow();
    expect(store.load(ROOM_ID)).toBeNull();
  });
});
