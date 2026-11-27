// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIFFICULTY_PRESETS } from '../../src/games/minesweeper/difficulty';
import type { MinesweeperConfig } from '../../src/games/minesweeper/engine';
import {
  mountOnlineRoomView,
  type OnlineRoomViewOptions,
} from '../../src/games/minesweeper/online/client/room-view';
import {
  connectionClientError,
  createInitialRoomClientState,
  onlineRoomHref,
  ROOM_CLIENT_ERROR_TEXT,
  roomClientErrorFromWire,
  type BoardActionGate,
  type BoardActionIntent,
  type BoardRenderer,
  type BoardViewModel,
  type ClientTransport,
  type ConnectionErrorCode,
  type OnlineRoomHandle,
  type OnlineRoomViewDependencies,
  type RoomClientState,
  type RoomClientStore,
  type RoomConnectionStatus,
  type RoomCountdown,
  type RoomSelectors,
  type SeatSession,
  type TokenStore,
} from '../../src/games/minesweeper/online/client/contracts';
import {
  createRoomClientStore,
  roomSelectors,
} from '../../src/games/minesweeper/online/client/store';
import type {
  ActionMessage,
  ClientToServerMessage,
  CreateMessage,
  EndMessage,
  JoinMessage,
  PlayerView,
  ReadyMessage,
  RedactedBoard,
  RematchMessage,
  RoomStateMessage,
  ServerToClientMessage,
  SnapshotMessage,
  StartMessage,
} from '../../src/games/minesweeper/online/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const ROOM_ID = 'room-ui-test';
const MATCH_ID = 'match-ui-test';
const NEXT_MATCH_ID = 'match-ui-test-2';
const HOST_ID = 'player_host';
const GUEST_ID = 'player_guest';
const CONFIG: MinesweeperConfig = {
  rows: 3,
  cols: 3,
  mines: 1,
  firstClickSafe: true,
};

function hostPlayer(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    playerId: HOST_ID,
    displayName: 'Ada',
    ready: true,
    presence: 'online',
    isHost: true,
    ...overrides,
  };
}

function guestPlayer(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    playerId: GUEST_ID,
    displayName: 'Grace',
    ready: true,
    presence: 'online',
    isHost: false,
    ...overrides,
  };
}

function makeRoom(overrides: Partial<RoomStateMessage> = {}): RoomStateMessage {
  return {
    type: 'room_state',
    roomId: ROOM_ID,
    seq: 7,
    state: 'waiting',
    hostId: HOST_ID,
    capacity: 2,
    players: [hostPlayer(), guestPlayer()],
    config: CONFIG,
    matchId: null,
    turnPlayerId: null,
    joinDeadlineAt: NOW + 90_000,
    deadlineAt: null,
    stateReason: null,
    ...overrides,
  };
}

function makeRedactedBoard(): RedactedBoard {
  return [
    [
      { row: 0, col: 0, revealed: true, flagged: false, adjacentMines: 0 },
      { row: 0, col: 1, revealed: false, flagged: false, adjacentMines: 0 },
      { row: 0, col: 2, revealed: false, flagged: true, adjacentMines: 0 },
    ],
    [
      { row: 1, col: 0, revealed: false, flagged: false, adjacentMines: 0 },
      { row: 1, col: 1, revealed: false, flagged: false, adjacentMines: 0 },
      { row: 1, col: 2, revealed: true, flagged: false, adjacentMines: 1 },
    ],
    [
      { row: 2, col: 0, revealed: false, flagged: false, adjacentMines: 0 },
      { row: 2, col: 1, revealed: false, flagged: false, adjacentMines: 0 },
      { row: 2, col: 2, revealed: false, flagged: false, adjacentMines: 0 },
    ],
  ];
}

function makeSnapshot(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    type: 'snapshot',
    roomId: ROOM_ID,
    matchId: MATCH_ID,
    seq: 9,
    turnPlayerId: HOST_ID,
    turnId: 2,
    seedHash: 'seed-hash',
    deadlineAt: NOW + 30_000,
    matchDeadlineAt: NOW + 600_000,
    elapsedMs: 5_000,
    engineStatus: 'playing',
    mineCount: 3,
    remainingMines: 2,
    revealedSafeCount: 5,
    board: makeRedactedBoard(),
    ...overrides,
  };
}

function makeRoomViewState(
  overrides: Partial<RoomStateMessage> = {},
  snapshot: SnapshotMessage | null = null,
): RoomClientState {
  const room = makeRoom(overrides);
  return Object.freeze({
    phase: room.state,
    connection: 'connected' as RoomConnectionStatus,
    lastSeq: room.seq,
    role: 'host' as const,
    selfId: HOST_ID,
    room,
    snapshot,
    end: null,
    error: null,
  });
}

function makeEnd(overrides: Partial<EndMessage> = {}): EndMessage {
  return {
    type: 'end',
    roomId: ROOM_ID,
    seq: 20,
    matchId: MATCH_ID,
    reason: 'mine-hit',
    winnerId: GUEST_ID,
    loserId: HOST_ID,
    finalSnapshot: [],
    seed: 42,
    stats: {
      turnCount: 8,
      revealedSafeCount: 5,
      flagsPlaced: 2,
      durationMs: 125_000,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory fakes for the injected seams
// ---------------------------------------------------------------------------

class TestStore implements RoomClientStore {
  private state: RoomClientState;
  private readonly listeners = new Set<(state: RoomClientState) => void>();
  readonly applied: ServerToClientMessage[] = [];

  constructor(initial: RoomClientState) {
    this.state = initial;
  }

  getState(): RoomClientState {
    return this.state;
  }

  subscribe(listener: (state: RoomClientState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  applyServerMessage(message: ServerToClientMessage): void {
    this.applied.push(message);
  }

  reset(): void {
    this.push(createInitialRoomClientState());
  }

  push(state: RoomClientState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener(state));
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

class TestTransport implements ClientTransport {
  readonly sent: ClientToServerMessage[] = [];
  readonly sessions: SeatSession[] = [];
  readonly statuses: RoomConnectionStatus[] = [];
  readonly errors: ConnectionErrorCode[] = [];
  closed = false;
  private readonly messageListeners = new Set<(message: ServerToClientMessage) => void>();
  private readonly statusListeners = new Set<(status: RoomConnectionStatus) => void>();
  private readonly errorListeners = new Set<(code: ConnectionErrorCode) => void>();

  connect(session: SeatSession): void {
    this.sessions.push(session);
  }

  send(message: ClientToServerMessage): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
  }

  onMessage(listener: (message: ServerToClientMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onStatus(listener: (status: RoomConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onError(listener: (code: ConnectionErrorCode) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  emitMessage(message: ServerToClientMessage): void {
    this.messageListeners.forEach((listener) => listener(message));
  }

  emitStatus(status: RoomConnectionStatus): void {
    this.statuses.push(status);
    this.statusListeners.forEach((listener) => listener(status));
  }

  emitError(code: ConnectionErrorCode): void {
    this.errors.push(code);
    this.errorListeners.forEach((listener) => listener(code));
  }
}

class TestTokenStore implements TokenStore {
  private readonly records = new Map<string, SeatSession>();

  load(roomId: string): SeatSession | null {
    return this.records.get(roomId) ?? null;
  }

  save(session: SeatSession): void {
    this.records.set(session.roomId, session);
  }

  clear(roomId: string): void {
    this.records.delete(roomId);
  }
}

class TestRenderer implements BoardRenderer {
  readonly views: BoardViewModel[] = [];
  readonly containers: HTMLElement[] = [];
  destroyed = 0;
  private intentHandler: ((intent: BoardActionIntent) => void) | null = null;

  render(
    container: HTMLElement,
    view: BoardViewModel,
    onIntent: (intent: BoardActionIntent) => void,
  ): void {
    this.containers.push(container);
    this.views.push(view);
    this.intentHandler = onIntent;
  }

  destroy(): void {
    this.destroyed += 1;
    this.intentHandler = null;
  }

  intent(intent: BoardActionIntent): void {
    if (this.intentHandler === null) {
      throw new Error('renderer has no intent handler');
    }
    this.intentHandler(intent);
  }
}

function isHost(state: RoomClientState): boolean {
  return state.room !== null && state.selfId === state.room.hostId;
}

function actionGate(
  state: RoomClientState,
  row: number,
  col: number,
  kind: BoardActionIntent['kind'],
): BoardActionGate {
  if (state.phase !== 'playing') {
    return { allowed: false, reason: 'room-not-playing', message: '对局尚未开始。' };
  }
  const snapshot = state.snapshot;
  if (snapshot === null) {
    return { allowed: false, reason: 'missing-board', message: '棋盘尚未就绪。' };
  }
  if (state.selfId === null || snapshot.turnPlayerId !== state.selfId) {
    return { allowed: false, reason: 'not-your-turn', message: '还没轮到你行动。' };
  }
  const cell = snapshot.board[row]?.[col];
  if (cell === undefined) {
    return { allowed: false, reason: 'out-of-bounds', message: '格子不存在。' };
  }
  if (cell.revealed) {
    return { allowed: false, reason: 'cell-revealed', message: '这个格子已经翻开。' };
  }
  if (kind === 'reveal' && cell.flagged) {
    return { allowed: false, reason: 'cell-flagged', message: '先取消这个格子的旗。' };
  }
  return { allowed: true, reason: null, message: null };
}

function boardView(state: RoomClientState): BoardViewModel | null {
  const snapshot = state.snapshot;
  if (snapshot === null) {
    return null;
  }
  const rows = snapshot.board.length;
  const cols = snapshot.board[0]?.length ?? 0;
  return {
    roomId: snapshot.roomId,
    matchId: snapshot.matchId,
    selfId: state.selfId,
    turnPlayerId: snapshot.turnPlayerId,
    turnId: snapshot.turnId,
    status: snapshot.engineStatus,
    seedHash: snapshot.seedHash,
    deadlineAt: snapshot.deadlineAt,
    matchDeadlineAt: snapshot.matchDeadlineAt,
    elapsedMs: snapshot.elapsedMs,
    mineCount: snapshot.mineCount,
    remainingMines: snapshot.remainingMines,
    revealedSafeCount: snapshot.revealedSafeCount,
    rows,
    cols,
    cells: snapshot.board.map((row) =>
      row.map((cell) => ({
        row: cell.row,
        col: cell.col,
        revealed: cell.revealed,
        flagged: cell.flagged,
        adjacentMines: cell.adjacentMines,
        pending: false,
      })),
    ),
  };
}

function countdownFor(state: RoomClientState, nowMs: number): RoomCountdown {
  let kind: RoomCountdown['kind'] = 'none';
  let deadlineAt: number | null = null;
  if (state.phase === 'waiting' || state.phase === 'ready') {
    kind = 'join';
    deadlineAt = state.room?.joinDeadlineAt ?? null;
  } else if (state.phase === 'playing' && state.snapshot !== null) {
    const turnAt = state.snapshot.deadlineAt;
    const matchAt = state.snapshot.matchDeadlineAt;
    kind = turnAt <= matchAt ? 'turn' : 'match';
    deadlineAt = Math.min(turnAt, matchAt);
  }
  if (deadlineAt === null) {
    return { kind: 'none', deadlineAt: null, remainingMs: 0, expired: false, label: '' };
  }
  const remainingMs = Math.max(0, deadlineAt - nowMs);
  const label = kind === 'join' ? '加入剩余' : kind === 'turn' ? '回合剩余' : '整局剩余';
  return {
    kind,
    deadlineAt,
    remainingMs,
    expired: remainingMs === 0,
    label,
  };
}

function makeSelectors(): RoomSelectors {
  return {
    isMyTurn(state) {
      return (
        state.phase === 'playing' &&
        state.snapshot !== null &&
        state.selfId !== null &&
        state.snapshot.turnPlayerId === state.selfId
      );
    },
    isHost,
    canStart(state) {
      return state.phase === 'ready' && isHost(state);
    },
    canToggleReady(state) {
      return (
        (state.phase === 'waiting' || state.phase === 'ready') && state.selfId !== null
      );
    },
    board: boardView,
    actionGate,
    countdown: countdownFor,
    errorText(state) {
      return state.error?.message ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// DOM harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly root: HTMLElement;
  readonly handle: OnlineRoomHandle;
  readonly transports: TestTransport[];
  readonly stores: TestStore[];
  readonly renderers: TestRenderer[];
  readonly tokens: TestTokenStore;
  readonly navigations: string[];
  readonly selectors: RoomSelectors;
  setNow(value: number): void;
}

type HarnessOverrides = Partial<
  Pick<OnlineRoomViewDependencies, 'createStore' | 'selectors'>
>;

function mountHarness(
  options: OnlineRoomViewOptions = {},
  overrides: HarnessOverrides = {},
): Harness {
  const root = document.createElement('div');
  document.body.append(root);

  const transports: TestTransport[] = [];
  const stores: TestStore[] = [];
  const renderers: TestRenderer[] = [];
  const tokens = new TestTokenStore();
  const navigations: string[] = [];
  const selectors = overrides.selectors ?? makeSelectors();
  let clock = NOW;

  const dependencies: OnlineRoomViewDependencies = {
    createTransport(_session) {
      const transport = new TestTransport();
      transports.push(transport);
      return transport;
    },
    createStore(storeOptions) {
      const store = new TestStore(createInitialRoomClientState(storeOptions.session));
      stores.push(store);
      return store;
    },
    selectors,
    createBoardRenderer() {
      const renderer = new TestRenderer();
      renderers.push(renderer);
      return renderer;
    },
    tokenStore: tokens,
    now: () => clock,
    navigate: (href) => {
      navigations.push(href);
    },
    ...overrides,
  };

  const handle = mountOnlineRoomView(root, dependencies, options);
  return {
    root,
    handle,
    transports,
    stores,
    renderers,
    tokens,
    navigations,
    selectors,
    setNow(value: number) {
      clock = value;
    },
  };
}

function byTestId<T extends Element>(root: ParentNode, testId: string): T {
  const element = root.querySelector<T>(`[data-testid="${testId}"]`);
  if (element === null) {
    throw new Error(`missing element: ${testId}`);
  }
  return element;
}

function click(root: ParentNode, testId: string): void {
  byTestId<HTMLButtonElement>(root, testId).click();
}

function setInput(root: ParentNode, testId: string, value: string): void {
  byTestId<HTMLInputElement>(root, testId).value = value;
}

function submitForm(root: ParentNode, testId: string): void {
  byTestId<HTMLFormElement>(root, testId).dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
}

function firstStore(harness: Harness): TestStore {
  const store = harness.stores[0];
  if (store === undefined) {
    throw new Error('the view did not create a store');
  }
  return store;
}

function firstTransport(harness: Harness): TestTransport {
  const transport = harness.transports[0];
  if (transport === undefined) {
    throw new Error('the view did not create a transport');
  }
  return transport;
}

function createHost(harness: Harness, name = 'Ada'): void {
  setInput(harness.root, 'nickname', name);
  submitForm(harness.root, 'create-form');
}

/** Choose the custom-difficulty option the same way a user's change event does. */
function selectCustomDifficulty(harness: Harness): void {
  const select = byTestId<HTMLSelectElement>(harness.root, 'difficulty');
  select.value = 'custom';
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillCustomBoard(
  harness: Harness,
  rows: string,
  cols: string,
  mines: string,
): void {
  setInput(harness.root, 'custom-rows', rows);
  setInput(harness.root, 'custom-cols', cols);
  setInput(harness.root, 'custom-mines', mines);
}

/** Drive the mounted seat into a playing state and return its board renderer. */
function pushPlaying(harness: Harness): TestRenderer {
  const store = firstStore(harness);
  store.push(
    makeRoomViewState(
      { seq: 9, state: 'playing', matchId: MATCH_ID, turnPlayerId: HOST_ID },
      makeSnapshot(),
    ),
  );
  const renderer = harness.renderers[0];
  if (renderer === undefined) {
    throw new Error('the view did not create a board renderer');
  }
  return renderer;
}

function lastActionId(harness: Harness): string {
  const message = firstTransport(harness).sent.at(-1);
  if (message?.type !== 'action') {
    throw new Error('the view did not send an action');
  }
  return message.actionId;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.location.hash = '';
});

// ---------------------------------------------------------------------------
// Landing, create and join
// ---------------------------------------------------------------------------

describe('online room landing', () => {
  it('renders create/join controls, presets and a prefilled share link', () => {
    const harness = mountHarness({ roomId: 'shared-room' });

    expect(harness.stores).toHaveLength(0);
    expect(harness.transports).toHaveLength(0);
    expect(harness.handle.roomId).toBe('shared-room');
    expect(byTestId<HTMLElement>(harness.root, 'landing').hidden).toBe(false);
    expect(byTestId<HTMLInputElement>(harness.root, 'join-room-id').value).toBe(
      'shared-room',
    );
    const share = byTestId<HTMLAnchorElement>(harness.root, 'share-link');
    expect(share.getAttribute('href')).toBe(onlineRoomHref('shared-room'));
    expect(share.textContent).toContain('shared-room');

    const options = [...byTestId<HTMLSelectElement>(harness.root, 'difficulty').options];
    expect(options.map((option) => option.value)).toEqual([
      ...DIFFICULTY_PRESETS.map((preset) => preset.id),
      'custom',
    ]);

    harness.handle.destroy();
  });

  it('falls back to the room id in the hash when no option is given', () => {
    window.location.hash = '#/online/minesweeper?room=hash-room';

    const harness = mountHarness();

    expect(harness.handle.roomId).toBe('hash-room');
    expect(byTestId<HTMLInputElement>(harness.root, 'join-room-id').value).toBe(
      'hash-room',
    );
    const share = byTestId<HTMLAnchorElement>(harness.root, 'share-link');
    expect(share.getAttribute('href')).toBe(onlineRoomHref('hash-room'));
    expect(share.textContent).toContain('hash-room');
    expect(byTestId<HTMLElement>(harness.root, 'share-prefill').hidden).toBe(false);

    harness.handle.destroy();
  });

  it('requires a nickname before opening a socket', () => {
    const harness = mountHarness({ roomId: null });

    submitForm(harness.root, 'create-form');

    expect(harness.transports).toHaveLength(0);
    expect(harness.stores).toHaveLength(0);
    const error = byTestId<HTMLElement>(harness.root, 'form-error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('昵称');

    harness.handle.destroy();
  });

  it('requires a room id before joining', () => {
    const harness = mountHarness({ roomId: null });
    setInput(harness.root, 'nickname', 'Grace');

    submitForm(harness.root, 'join-form');

    expect(harness.transports).toHaveLength(0);
    expect(byTestId<HTMLElement>(harness.root, 'form-error').textContent).toContain(
      '房间号',
    );

    harness.handle.destroy();
  });

  it('rejects a nickname longer than the maximum', () => {
    const harness = mountHarness({ roomId: null });
    // Programmatic assignment bypasses the input's `maxlength`, so this targets
    // the readNickname guard rather than the browser constraint.
    setInput(harness.root, 'nickname', 'x'.repeat(25));

    submitForm(harness.root, 'create-form');

    expect(harness.transports).toHaveLength(0);
    expect(harness.stores).toHaveLength(0);
    const error = byTestId<HTMLElement>(harness.root, 'form-error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('昵称最多 24 个字符。');

    harness.handle.destroy();
  });
});

describe('online room create and join', () => {
  it('creates a host seat with the selected difficulty and stores the owner token', () => {
    const harness = mountHarness({ roomId: null });
    setInput(harness.root, 'nickname', 'Ada');
    byTestId<HTMLSelectElement>(harness.root, 'difficulty').value = 'intermediate';

    submitForm(harness.root, 'create-form');

    expect(harness.transports).toHaveLength(1);
    expect(harness.stores).toHaveLength(1);
    const transport = firstTransport(harness);
    expect(transport.sessions[0]).toEqual({
      roomId: '',
      playerToken: null,
      displayName: 'Ada',
      role: 'host',
    });
    const create = transport.sent[0] as CreateMessage;
    expect(create.type).toBe('create');
    expect(create.protocolVersion).toBe(1);
    expect(create.displayName).toBe('Ada');
    expect(create.config).toEqual({
      rows: 16,
      cols: 16,
      mines: 40,
      firstClickSafe: true,
    });
    expect(create.requestId.length).toBeGreaterThan(0);

    expect(byTestId<HTMLElement>(harness.root, 'landing').hidden).toBe(true);
    expect(byTestId<HTMLElement>(harness.root, 'connecting').hidden).toBe(false);
    expect(byTestId<HTMLElement>(harness.root, 'connecting-detail').textContent).toContain(
      'Ada',
    );

    const ownerRoom = { ...makeRoom({ seq: 1 }), playerToken: 'owner-token' };
    transport.emitMessage(ownerRoom);
    expect(harness.tokens.load(ROOM_ID)?.playerToken).toBe('owner-token');
    expect(harness.handle.roomId).toBe(ROOM_ID);
    expect(firstStore(harness).applied).toEqual([ownerRoom]);

    firstStore(harness).push(
      makeRoomViewState({ seq: 1, players: [hostPlayer(), guestPlayer()] }),
    );
    expect(byTestId<HTMLElement>(harness.root, 'waiting').hidden).toBe(false);
    expect(byTestId<HTMLElement>(harness.root, 'room-id').textContent).toBe(ROOM_ID);
    expect(byTestId<HTMLAnchorElement>(harness.root, 'room-share-link').href).toContain(
      'room-ui-test',
    );
    expect(byTestId(harness.root, 'players').querySelectorAll('[data-testid="player"]')).toHaveLength(2);

    harness.handle.destroy();
  });

  it('shows custom rows/columns/mines only for the custom option with accessible labels', () => {
    const harness = mountHarness({ roomId: null });

    const select = byTestId<HTMLSelectElement>(harness.root, 'difficulty');
    const customFields = byTestId<HTMLElement>(harness.root, 'custom-fields');
    expect(select.options[select.options.length - 1]?.textContent).toContain('自定义');
    expect(customFields.hidden).toBe(true);

    for (const testId of ['custom-rows', 'custom-cols', 'custom-mines']) {
      const input = byTestId<HTMLInputElement>(harness.root, testId);
      expect(input.type).toBe('number');
      const label = harness.root.querySelector<HTMLLabelElement>(
        `label[for="${input.id}"]`,
      );
      expect(label).not.toBeNull();
      expect(label?.htmlFor).toBe(input.id);
      expect(input.labels?.[0]).toBe(label);
    }

    selectCustomDifficulty(harness);
    expect(customFields.hidden).toBe(false);

    select.value = 'beginner';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(customFields.hidden).toBe(true);

    harness.handle.destroy();
  });

  it('sends a valid custom board as the create config', () => {
    const harness = mountHarness({ roomId: null });
    setInput(harness.root, 'nickname', 'Ada');
    selectCustomDifficulty(harness);
    fillCustomBoard(harness, '12', '12', '20');

    submitForm(harness.root, 'create-form');

    expect(harness.transports).toHaveLength(1);
    const create = firstTransport(harness).sent[0] as CreateMessage;
    expect(create.type).toBe('create');
    expect(create.config).toEqual({
      rows: 12,
      cols: 12,
      mines: 20,
      firstClickSafe: true,
    });
    expect(byTestId<HTMLElement>(harness.root, 'form-error').hidden).toBe(true);

    harness.handle.destroy();
  });

  it('rejects invalid custom boards with the parser reason and sends no create', () => {
    const cases = [
      {
        rows: '4',
        cols: '9',
        mines: '10',
        message: '行数必须是 5 到 30 之间的整数。',
      },
      {
        rows: '9',
        cols: '31',
        mines: '10',
        message: '列数必须是 5 到 30 之间的整数。',
      },
      {
        rows: '9',
        cols: '9',
        mines: '81',
        message: '雷数必须小于格子总数（81）。',
      },
      {
        rows: '5',
        cols: '5',
        mines: '17',
        message: '雷数过多：首点安全区占 9 格，最多只能放 16 颗雷。',
      },
      {
        rows: '9.5',
        cols: '9',
        mines: '10',
        message: '行数必须是整数。',
      },
      {
        rows: '',
        cols: '9',
        mines: '10',
        message: '行数不能为空。',
      },
    ];

    for (const scenario of cases) {
      const harness = mountHarness({ roomId: null });
      setInput(harness.root, 'nickname', 'Ada');
      selectCustomDifficulty(harness);
      fillCustomBoard(harness, scenario.rows, scenario.cols, scenario.mines);

      submitForm(harness.root, 'create-form');

      expect(harness.transports).toHaveLength(0);
      expect(harness.stores).toHaveLength(0);
      const error = byTestId<HTMLElement>(harness.root, 'form-error');
      expect(error.hidden).toBe(false);
      expect(error.textContent).toBe(scenario.message);
      expect(byTestId<HTMLElement>(harness.root, 'landing').hidden).toBe(false);

      harness.handle.destroy();
    }
  });

  it('escapes hostile nicknames in the player list and the prefilled input', () => {
    const hostile = '<b>A"da</b><img>';
    const harness = mountHarness({ roomId: null, displayName: hostile });

    expect(byTestId<HTMLInputElement>(harness.root, 'nickname').value).toBe(hostile);
    expect(harness.root.querySelector('b, img')).toBeNull();

    submitForm(harness.root, 'create-form');
    const store = firstStore(harness);
    store.push(
      makeRoomViewState({
        players: [
          hostPlayer({ displayName: hostile }),
          guestPlayer({ displayName: hostile }),
        ],
      }),
    );

    const players = byTestId<HTMLElement>(harness.root, 'players');
    expect(players.querySelectorAll('b, img')).toHaveLength(0);
    expect(players.textContent).toContain(hostile);
    expect(players.querySelector('.online-room__player-name')?.textContent).toContain(
      hostile,
    );

    harness.handle.destroy();
  });

  it('joins from a share link as a guest and only toggles readiness', () => {
    const harness = mountHarness({ roomId: 'shared-room' });
    setInput(harness.root, 'nickname', 'Grace');

    submitForm(harness.root, 'join-form');

    const transport = firstTransport(harness);
    const join = transport.sent[0] as JoinMessage;
    expect(join.type).toBe('join');
    expect(join.protocolVersion).toBe(1);
    expect(join.roomId).toBe('shared-room');
    expect(join.displayName).toBe('Grace');
    expect(join.playerToken).toBeUndefined();
    expect(transport.sessions[0]).toEqual({
      roomId: 'shared-room',
      playerToken: null,
      displayName: 'Grace',
      role: 'guest',
    });

    const store = firstStore(harness);
    store.push(
      Object.freeze({
        phase: 'waiting',
        connection: 'connected' as RoomConnectionStatus,
        lastSeq: 2,
        role: 'guest' as const,
        selfId: GUEST_ID,
        room: makeRoom({
          seq: 2,
          players: [hostPlayer(), guestPlayer({ ready: false })],
        }),
        snapshot: null,
        end: null,
        error: null,
      }),
    );

    expect(byTestId<HTMLElement>(harness.root, 'waiting').hidden).toBe(false);
    expect(byTestId<HTMLButtonElement>(harness.root, 'start-match').disabled).toBe(true);
    expect(byTestId<HTMLElement>(harness.root, 'start-match').textContent).toContain(
      '仅房主',
    );
    expect(byTestId<HTMLElement>(harness.root, 'toggle-ready').textContent).toContain(
      '准备',
    );

    click(harness.root, 'toggle-ready');
    const ready = transport.sent.at(-1) as ReadyMessage;
    expect(ready).toMatchObject({
      type: 'ready',
      roomId: ROOM_ID,
      ready: true,
    });

    store.push(
      Object.freeze({
        phase: 'ready',
        connection: 'connected' as RoomConnectionStatus,
        lastSeq: 3,
        role: 'guest' as const,
        selfId: GUEST_ID,
        room: makeRoom({
          seq: 3,
          state: 'ready',
          players: [hostPlayer(), guestPlayer({ ready: true })],
        }),
        snapshot: null,
        end: null,
        error: null,
      }),
    );
    expect(byTestId<HTMLElement>(harness.root, 'toggle-ready').textContent).toContain(
      '取消准备',
    );
    expect(byTestId<HTMLButtonElement>(harness.root, 'start-match').disabled).toBe(true);

    harness.handle.destroy();
  });

  it('lets only the host start once both players are ready', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);
    const transport = firstTransport(harness);

    store.push(makeRoomViewState({ seq: 2 }));
    expect(byTestId<HTMLButtonElement>(harness.root, 'start-match').disabled).toBe(true);

    store.push(
      makeRoomViewState({
        seq: 3,
        state: 'ready',
        players: [hostPlayer(), guestPlayer({ ready: true })],
      }),
    );
    expect(byTestId<HTMLButtonElement>(harness.root, 'start-match').disabled).toBe(false);

    click(harness.root, 'start-match');
    const start = transport.sent.at(-1) as StartMessage;
    expect(start).toMatchObject({
      type: 'start',
      roomId: ROOM_ID,
    });
    expect(start.requestId.length).toBeGreaterThan(0);

    harness.handle.destroy();
  });

  it('resumes a stored guest token when joining its room again', () => {
    const harness = mountHarness({ roomId: 'shared-room' });
    harness.tokens.save({
      roomId: 'shared-room',
      playerToken: 'resume-token',
      displayName: 'Grace',
      role: 'guest',
    });
    setInput(harness.root, 'nickname', 'Grace');

    submitForm(harness.root, 'join-form');

    const transport = firstTransport(harness);
    const join = transport.sent[0] as JoinMessage;
    expect(join.playerToken).toBe('resume-token');
    expect(transport.sessions[0]).toMatchObject({
      roomId: 'shared-room',
      playerToken: 'resume-token',
      role: 'guest',
    });

    harness.handle.destroy();
  });

  it('reuses a stored display name when joining with an empty nickname', () => {
    const harness = mountHarness({ roomId: 'shared-room' });
    harness.tokens.save({
      roomId: 'shared-room',
      playerToken: 'resume-token',
      displayName: 'Ada',
      role: 'guest',
    });

    submitForm(harness.root, 'join-form');

    const transport = firstTransport(harness);
    expect(transport.sessions[0]?.displayName).toBe('Ada');
    expect((transport.sent[0] as JoinMessage).displayName).toBe('Ada');

    harness.handle.destroy();
  });
});

// ---------------------------------------------------------------------------
// Waiting, countdown and leave semantics
// ---------------------------------------------------------------------------

describe('online room waiting controls', () => {
  it('estimates the join countdown from the server deadline only', () => {
    vi.useFakeTimers();
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);
    const transport = firstTransport(harness);

    store.push(makeRoomViewState({ joinDeadlineAt: NOW + 90_000 }));
    expect(byTestId<HTMLElement>(harness.root, 'join-countdown').textContent).toBe('1:30');

    harness.setNow(NOW + 89_500);
    vi.advanceTimersByTime(250);
    expect(byTestId<HTMLElement>(harness.root, 'join-countdown').textContent).toBe('0:01');
    expect(byTestId<HTMLElement>(harness.root, 'join-countdown').dataset.deadlineAt).toBe(
      String(NOW + 90_000),
    );

    harness.setNow(NOW + 90_000);
    vi.advanceTimersByTime(250);
    expect(byTestId<HTMLElement>(harness.root, 'join-countdown').textContent).toBe('0:00');
    // Expiry is display-only: the view never sends a timeout or changes phase.
    expect(store.getState().phase).toBe('waiting');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.type).toBe('create');

    harness.handle.destroy();
  });

  it('sends leave only from waiting/ready and clears the stored seat', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);
    const transport = firstTransport(harness);
    transport.emitMessage({ ...makeRoom({ seq: 1 }), playerToken: 'owner-token' });
    store.push(makeRoomViewState({ seq: 1 }));
    expect(harness.tokens.load(ROOM_ID)?.playerToken).toBe('owner-token');

    click(harness.root, 'leave-room');

    const leave = transport.sent.at(-1) as ClientToServerMessage;
    expect(leave).toMatchObject({
      type: 'leave',
      roomId: ROOM_ID,
    });
    expect(transport.closed).toBe(true);
    expect(harness.tokens.load(ROOM_ID)).toBeNull();
    expect(harness.navigations).toEqual(['#/']);

    harness.handle.destroy();
  });
});

// ---------------------------------------------------------------------------
// Playing and board rendering
// ---------------------------------------------------------------------------

describe('online room playing', () => {
  it('renders the redacted board, counts down from deadlines and sends allowed actions', () => {
    vi.useFakeTimers();
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);
    const transport = firstTransport(harness);
    const snapshot = makeSnapshot();

    store.push(
      makeRoomViewState(
        {
          seq: 9,
          state: 'playing',
          matchId: MATCH_ID,
          turnPlayerId: HOST_ID,
          deadlineAt: NOW + 30_000,
        },
        snapshot,
      ),
    );

    expect(byTestId<HTMLElement>(harness.root, 'playing').hidden).toBe(false);
    expect(harness.renderers).toHaveLength(1);
    const renderer = harness.renderers[0];
    if (renderer === undefined) {
      throw new Error('the view did not create a board renderer');
    }
    expect(renderer.views).toHaveLength(1);
    const view = renderer.views[0];
    if (view === undefined) {
      throw new Error('the view did not render a board');
    }
    expect(view.cells.flat().every((cell) => !Object.hasOwn(cell, 'mine'))).toBe(true);
    expect(JSON.stringify(view)).not.toContain('"mine"');
    expect(view.rows).toBe(3);
    expect(view.cols).toBe(3);

    expect(byTestId<HTMLElement>(harness.root, 'turn-owner').textContent).toBe('你的回合');
    expect(byTestId<HTMLElement>(harness.root, 'remaining-mines').textContent).toBe('2');
    expect(byTestId<HTMLElement>(harness.root, 'turn-countdown').textContent).toBe('0:30');
    expect(byTestId<HTMLElement>(harness.root, 'match-countdown').textContent).toBe('10:00');
    expect(byTestId<HTMLElement>(harness.root, 'online-board').dataset.actionsEnabled).toBe(
      'true',
    );

    // A revealed cell is rejected by the injected gate and never reaches the wire.
    renderer.intent({ kind: 'reveal', row: 0, col: 0 });
    expect(transport.sent.some((message) => message.type === 'action')).toBe(false);
    expect(byTestId<HTMLElement>(harness.root, 'action-error').hidden).toBe(false);

    renderer.intent({ kind: 'reveal', row: 1, col: 1 });
    const action = transport.sent.at(-1) as ActionMessage;
    expect(action).toMatchObject({
      type: 'action',
      roomId: ROOM_ID,
      matchId: MATCH_ID,
      seq: 9,
      turnId: 2,
      kind: 'reveal',
      row: 1,
      col: 1,
      clientTimeMs: NOW,
    });
    expect(action.actionId).toMatch(/^action-[0-9a-f]{16}-\d+$/);

    harness.setNow(NOW + 30_000);
    vi.advanceTimersByTime(250);
    expect(byTestId<HTMLElement>(harness.root, 'turn-countdown').textContent).toBe('0:00');
    expect(byTestId<HTMLElement>(harness.root, 'match-countdown').textContent).toBe('9:30');
    expect(transport.sent.filter((message) => message.type === 'action')).toHaveLength(1);
    expect(store.getState().phase).toBe('playing');

    // Returning to the hub during a match closes the socket but never sends leave.
    click(harness.root, 'playing-lobby');
    expect(transport.sent.filter((message) => message.type === 'leave')).toHaveLength(0);
    expect(transport.closed).toBe(true);
    expect(harness.navigations).toEqual(['#/']);

    harness.handle.destroy();
  });

  it('keeps action ids unique across seats and remounts', () => {
    const firstSeat = mountHarness({ roomId: null });
    createHost(firstSeat);
    const firstRenderer = pushPlaying(firstSeat);
    firstRenderer.intent({ kind: 'reveal', row: 1, col: 1 });
    const firstActionId = lastActionId(firstSeat);
    expect(firstActionId).toMatch(/-1$/);

    firstRenderer.intent({ kind: 'flag', row: 2, col: 2 });
    const secondActionId = lastActionId(firstSeat);
    expect(secondActionId).not.toBe(firstActionId);
    expect(secondActionId).toMatch(/-2$/);

    // The other seat is a separate mount in a separate browsing context.
    const otherSeat = mountHarness({ roomId: null });
    createHost(otherSeat, 'Grace');
    const otherRenderer = pushPlaying(otherSeat);
    otherRenderer.intent({ kind: 'reveal', row: 1, col: 1 });
    expect(lastActionId(otherSeat)).not.toBe(firstActionId);

    // Refreshing or remounting the same seat must not reuse the old ids.
    firstSeat.handle.destroy();
    const remount = mountHarness({ roomId: null });
    createHost(remount);
    const remountRenderer = pushPlaying(remount);
    remountRenderer.intent({ kind: 'reveal', row: 1, col: 1 });
    expect(lastActionId(remount)).not.toBe(firstActionId);

    otherSeat.handle.destroy();
    remount.handle.destroy();
  });

  it('falls back to Math.random when the environment lacks crypto', () => {
    vi.stubGlobal('crypto', {});
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const renderer = pushPlaying(harness);
    renderer.intent({ kind: 'reveal', row: 1, col: 1 });

    expect(lastActionId(harness)).toMatch(/^action-[0-9a-f]{16}-1$/);
    expect(random).toHaveBeenCalled();

    harness.handle.destroy();
  });

  it('locks the board when it is the opponent turn', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);
    const transport = firstTransport(harness);
    const snapshot = makeSnapshot({ turnPlayerId: GUEST_ID });

    store.push(
      makeRoomViewState(
        { seq: 9, state: 'playing', matchId: MATCH_ID, turnPlayerId: GUEST_ID },
        snapshot,
      ),
    );

    const renderer = harness.renderers[0];
    if (renderer === undefined) {
      throw new Error('the view did not create a board renderer');
    }
    expect(renderer.views.at(-1)?.turnPlayerId).toBe(GUEST_ID);
    expect(renderer.views.at(-1)?.selfId).toBe(HOST_ID);
    expect(byTestId<HTMLElement>(harness.root, 'turn-owner').textContent).toContain(
      '对手回合',
    );
    expect(byTestId<HTMLElement>(harness.root, 'online-board').dataset.actionsEnabled).toBe(
      'false',
    );

    // Both reveal and flag are disabled on the opponent turn: the view never
    // submits either intent and explains the gate instead.
    renderer.intent({ kind: 'reveal', row: 2, col: 2 });
    expect(byTestId<HTMLElement>(harness.root, 'action-error').textContent).toContain(
      '还没轮到你',
    );
    renderer.intent({ kind: 'flag', row: 2, col: 2 });
    expect(transport.sent.some((message) => message.type === 'action')).toBe(false);
    expect(byTestId<HTMLElement>(harness.root, 'action-error').textContent).toContain(
      '还没轮到你',
    );

    harness.handle.destroy();
  });
});

// ---------------------------------------------------------------------------
// Reconnect recovery
// ---------------------------------------------------------------------------

describe('online room reconnect recovery', () => {
  it('renders the current-seq resync snapshot and never replays a submitted action', () => {
    // This test wires the real reducer/selectors into the view so the visible
    // board after a reconnect is the server's current-seq snapshot, not the
    // board the player saw before the socket dropped.
    const harness = mountHarness(
      { roomId: null },
      { createStore: createRoomClientStore, selectors: roomSelectors },
    );
    createHost(harness);
    const transport = firstTransport(harness);

    transport.emitMessage({ ...makeRoom({ seq: 1 }), playerToken: 'owner-token' });
    transport.emitStatus('connected');
    transport.emitMessage(
      makeRoom({ seq: 9, state: 'playing', matchId: MATCH_ID, turnPlayerId: HOST_ID }),
    );
    transport.emitMessage(makeSnapshot({ seq: 9 }));

    const renderer = harness.renderers[0];
    if (renderer === undefined) {
      throw new Error('the view did not create a board renderer');
    }
    expect(renderer.views.at(-1)).toMatchObject({ turnId: 2, turnPlayerId: HOST_ID });

    renderer.intent({ kind: 'reveal', row: 1, col: 1 });
    const submitted = transport.sent.filter((message) => message.type === 'action');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ seq: 9, turnId: 2, row: 1, col: 1 });

    // The socket drops; the view keeps the last board visible under the banner.
    transport.emitStatus('reconnecting');
    expect(byTestId<HTMLElement>(harness.root, 'reconnect-banner').hidden).toBe(false);

    // A queued snapshot from before the disconnect is older than `lastSeq` and
    // must not replace the visible board.
    transport.emitMessage(makeSnapshot({ seq: 8, turnId: 1 }));
    expect(harness.handle.getState().lastSeq).toBe(9);
    expect(harness.handle.getState().snapshot?.seq).toBe(9);
    expect(byTestId<HTMLElement>(harness.root, 'turn-countdown').textContent).toBe('0:30');

    // The server resyncs room state and a full redacted snapshot at its
    // current seq; the view replaces the whole board instead of merging.
    const resyncedBoard = makeRedactedBoard().map((row, rowIndex) =>
      row.map((cell, colIndex) =>
        rowIndex === 2 && colIndex === 2
          ? { ...cell, revealed: true, flagged: false, adjacentMines: 0 }
          : cell,
      ),
    );
    transport.emitStatus('connected');
    transport.emitMessage(
      makeRoom({
        seq: 12,
        state: 'playing',
        matchId: MATCH_ID,
        turnPlayerId: HOST_ID,
        deadlineAt: NOW + 40_000,
      }),
    );
    transport.emitMessage(
      makeSnapshot({
        seq: 12,
        turnId: 5,
        remainingMines: 1,
        deadlineAt: NOW + 40_000,
        board: resyncedBoard,
      }),
    );

    const state = harness.handle.getState();
    expect(state.lastSeq).toBe(12);
    expect(state.snapshot?.seq).toBe(12);

    const view = renderer.views.at(-1);
    expect(view).toMatchObject({ turnId: 5, turnPlayerId: HOST_ID, remainingMines: 1 });
    expect(view?.cells[2]?.[2]?.revealed).toBe(true);
    expect(
      view?.cells
        .flat()
        .filter((cell) => !cell.revealed)
        .every((cell) => !Object.hasOwn(cell, 'mine')),
    ).toBe(true);
    expect(byTestId<HTMLElement>(harness.root, 'remaining-mines').textContent).toBe('1');
    expect(byTestId<HTMLElement>(harness.root, 'turn-countdown').textContent).toBe('0:40');
    expect(byTestId<HTMLElement>(harness.root, 'online-board').dataset.actionsEnabled).toBe(
      'true',
    );
    expect(byTestId<HTMLElement>(harness.root, 'reconnect-banner').hidden).toBe(true);

    // Reconnecting and resyncing never re-send the action from before the drop.
    expect(transport.sent.filter((message) => message.type === 'action')).toEqual(
      submitted,
    );

    harness.handle.destroy();
  });
});

// ---------------------------------------------------------------------------
// Result, rematch and closed states
// ---------------------------------------------------------------------------

describe('online room result', () => {
  it('shows the outcome, reason and stats, then requests a rematch', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);
    const transport = firstTransport(harness);

    store.push(
      Object.freeze({
        phase: 'finished',
        connection: 'connected' as RoomConnectionStatus,
        lastSeq: 20,
        role: 'host' as const,
        selfId: HOST_ID,
        room: makeRoom({
          seq: 20,
          state: 'finished',
          matchId: MATCH_ID,
          players: [hostPlayer(), guestPlayer({ ready: false })],
        }),
        snapshot: makeSnapshot(),
        end: makeEnd(),
        error: null,
      }),
    );

    expect(byTestId<HTMLElement>(harness.root, 'finished').hidden).toBe(false);
    expect(byTestId<HTMLElement>(harness.root, 'result-outcome').textContent).toBe('失败');
    expect(byTestId<HTMLElement>(harness.root, 'result-detail').textContent).toContain(
      'Grace',
    );
    expect(byTestId<HTMLElement>(harness.root, 'result-reason').textContent).toContain(
      '踩到地雷',
    );
    expect(byTestId<HTMLElement>(harness.root, 'stat-turns').textContent).toBe('8');
    expect(byTestId<HTMLElement>(harness.root, 'stat-safe-cells').textContent).toBe('5');
    expect(byTestId<HTMLElement>(harness.root, 'stat-flags').textContent).toBe('2');
    expect(byTestId<HTMLElement>(harness.root, 'stat-duration').textContent).toBe('2:05');

    click(harness.root, 'rematch');
    const rematch = transport.sent.at(-1) as RematchMessage;
    expect(rematch).toMatchObject({
      type: 'rematch',
      roomId: ROOM_ID,
      accept: true,
    });
    expect(byTestId<HTMLButtonElement>(harness.root, 'rematch').disabled).toBe(true);

    click(harness.root, 'finished-lobby');
    expect(transport.sent.filter((message) => message.type === 'leave')).toHaveLength(0);
    expect(transport.closed).toBe(true);
    expect(harness.navigations).toEqual(['#/']);

    harness.handle.destroy();
  });

  it('shows a readable win result for the winning seat', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);

    store.push(
      Object.freeze({
        phase: 'finished',
        connection: 'connected' as RoomConnectionStatus,
        lastSeq: 21,
        role: 'host' as const,
        selfId: HOST_ID,
        room: makeRoom({ seq: 21, state: 'finished', matchId: MATCH_ID }),
        snapshot: makeSnapshot(),
        end: makeEnd({ winnerId: HOST_ID, loserId: GUEST_ID }),
        error: null,
      }),
    );

    expect(byTestId<HTMLElement>(harness.root, 'result-outcome').textContent).toBe('胜利');
    expect(byTestId<HTMLElement>(harness.root, 'result-detail').textContent).toContain(
      '你赢下了',
    );

    harness.handle.destroy();
  });

  it('reports a draw when neither seat won', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);

    store.push(
      Object.freeze({
        phase: 'finished',
        connection: 'connected' as RoomConnectionStatus,
        lastSeq: 22,
        role: 'host' as const,
        selfId: HOST_ID,
        room: makeRoom({ seq: 22, state: 'finished', matchId: MATCH_ID }),
        snapshot: makeSnapshot(),
        end: makeEnd({ winnerId: null, loserId: null, reason: 'match-timeout' }),
        error: null,
      }),
    );

    expect(byTestId<HTMLElement>(harness.root, 'result-outcome').textContent).toBe('平局');
    expect(byTestId<HTMLElement>(harness.root, 'result-detail').textContent).toBe(
      '双方都没有获胜，本局结束。',
    );
    expect(byTestId<HTMLElement>(harness.root, 'result-reason').textContent).toContain(
      '整局超时',
    );

    harness.handle.destroy();
  });

  it('re-enables rematch after the next match finishes', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);
    const pushFinished = (seq: number, matchId: string): void => {
      store.push(
        Object.freeze({
          phase: 'finished',
          connection: 'connected' as RoomConnectionStatus,
          lastSeq: seq,
          role: 'host' as const,
          selfId: HOST_ID,
          room: makeRoom({ seq, state: 'finished', matchId }),
          snapshot: makeSnapshot(),
          end: makeEnd({ seq, matchId }),
          error: null,
        }),
      );
    };

    pushFinished(20, MATCH_ID);
    const rematch = byTestId<HTMLButtonElement>(harness.root, 'rematch');
    click(harness.root, 'rematch');
    expect(rematch.disabled).toBe(true);
    expect(rematch.textContent).toBe('已申请重开，等待对手');

    // The server clears the match and returns both seats to ready.
    store.push(
      makeRoomViewState({ seq: 21, state: 'ready', matchId: null }),
    );
    pushFinished(22, NEXT_MATCH_ID);

    expect(rematch.disabled).toBe(false);
    expect(rematch.textContent).toBe('再来一局');

    harness.handle.destroy();
  });

  it('explains a dissolved room and lets the player return to the hub', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);
    const transport = firstTransport(harness);
    transport.emitMessage({ ...makeRoom({ seq: 1 }), playerToken: 'owner-token' });
    store.push(
      makeRoomViewState({
        seq: 3,
        state: 'dissolved',
        stateReason: 'join-timeout',
        players: [hostPlayer()],
      }),
    );

    expect(byTestId<HTMLElement>(harness.root, 'closed').hidden).toBe(false);
    expect(byTestId<HTMLElement>(harness.root, 'closed-reason').textContent).toContain(
      'join-timeout',
    );

    click(harness.root, 'closed-lobby');
    expect(transport.closed).toBe(true);
    expect(harness.tokens.load(ROOM_ID)).toBeNull();
    expect(harness.navigations).toEqual(['#/']);

    harness.handle.destroy();
  });
});

// ---------------------------------------------------------------------------
// Errors, presence, reconnect and lifecycle cleanup
// ---------------------------------------------------------------------------

describe('online room diagnostics', () => {
  it('renders readable error code text, presence and reconnect hints', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);
    const error = roomClientErrorFromWire({
      type: 'error',
      requestId: 'req-1',
      roomId: ROOM_ID,
      code: 'room-not-found',
      message: 'room missing',
      retryable: false,
      currentSeq: null,
    });

    store.push(
      Object.freeze({
        phase: 'waiting',
        connection: 'reconnecting' as RoomConnectionStatus,
        lastSeq: 4,
        role: 'host' as const,
        selfId: HOST_ID,
        room: makeRoom({
          seq: 4,
          players: [hostPlayer(), guestPlayer({ presence: 'reconnecting', ready: false })],
        }),
        snapshot: null,
        end: null,
        error,
      }),
    );

    const banner = byTestId<HTMLElement>(harness.root, 'reconnect-banner');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('重连');

    const presence = byTestId<HTMLElement>(harness.root, 'presence-warning');
    expect(presence.hidden).toBe(false);
    expect(presence.textContent).toContain('Grace');
    expect(presence.textContent).toContain('重连');

    const roomError = byTestId<HTMLElement>(harness.root, 'room-error');
    expect(roomError.hidden).toBe(false);
    expect(roomError.dataset.code).toBe('room-not-found');
    expect(roomError.textContent).toBe(ROOM_CLIENT_ERROR_TEXT['room-not-found']);

    harness.handle.destroy();
  });

  it('renders readable text for the room, session and stale-seq error codes', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);
    const errors = [
      roomClientErrorFromWire({
        type: 'error',
        requestId: 'req-room',
        roomId: ROOM_ID,
        code: 'room-not-found',
        message: 'room missing',
        retryable: false,
        currentSeq: null,
      }),
      roomClientErrorFromWire({
        type: 'error',
        requestId: 'req-seq',
        roomId: ROOM_ID,
        code: 'stale-state',
        message: 'stale state; resync and retry',
        retryable: true,
        currentSeq: 4,
      }),
      connectionClientError('session-replaced'),
    ];

    for (const error of errors) {
      store.push({ ...makeRoomViewState({ seq: 4 }), error });
      const roomError = byTestId<HTMLElement>(harness.root, 'room-error');
      expect(roomError.hidden).toBe(false);
      expect(roomError.dataset.code).toBe(error.code);
      expect(roomError.textContent).toBe(ROOM_CLIENT_ERROR_TEXT[error.code]);
      expect(roomError.textContent).not.toContain(error.code);
    }

    harness.handle.destroy();
  });

  it('warns when the opponent is offline and labels the player row', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);

    store.push(
      makeRoomViewState({
        players: [hostPlayer(), guestPlayer({ presence: 'offline' })],
      }),
    );

    const warning = byTestId<HTMLElement>(harness.root, 'presence-warning');
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toContain('Grace');
    expect(warning.textContent).toContain('已离线');

    const players = byTestId<HTMLElement>(harness.root, 'players');
    expect(players.querySelectorAll('[data-presence="offline"]')).toHaveLength(1);
    const offlineRow = players.querySelector(`[data-player-id="${GUEST_ID}"]`);
    expect(offlineRow?.getAttribute('data-presence')).toBe('offline');
    expect(
      offlineRow?.querySelector('[data-testid="player-presence"]')?.textContent,
    ).toBe('已离线');

    harness.handle.destroy();
  });

  it('shows and then clears the offline/closed connection banners', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);
    const banner = byTestId<HTMLElement>(harness.root, 'reconnect-banner');

    store.push(
      Object.freeze({
        ...makeRoomViewState({ seq: 2 }),
        connection: 'offline' as RoomConnectionStatus,
      }),
    );
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('离线');

    store.push(
      Object.freeze({
        ...makeRoomViewState({ seq: 3 }),
        connection: 'closed' as RoomConnectionStatus,
      }),
    );
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('连接已关闭');
    expect(banner.textContent).not.toContain('离线');

    store.push(
      Object.freeze({
        ...makeRoomViewState({ seq: 4 }),
        connection: 'connected' as RoomConnectionStatus,
      }),
    );
    expect(banner.hidden).toBe(true);

    harness.handle.destroy();
  });

  it('cancels a pending connection without sending leave', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const transport = firstTransport(harness);

    click(harness.root, 'cancel-connect');

    expect(transport.closed).toBe(true);
    expect(transport.sent.filter((message) => message.type === 'leave')).toHaveLength(0);
    expect(byTestId<HTMLElement>(harness.root, 'landing').hidden).toBe(false);

    harness.handle.destroy();
  });

  it('destroys the board renderer and detaches the store on destroy', () => {
    const harness = mountHarness({ roomId: null });
    createHost(harness);
    const store = firstStore(harness);
    const transport = firstTransport(harness);
    store.push(
      makeRoomViewState(
        { seq: 9, state: 'playing', matchId: MATCH_ID },
        makeSnapshot(),
      ),
    );
    const renderer = harness.renderers[0];
    if (renderer === undefined) {
      throw new Error('the view did not create a board renderer');
    }
    expect(store.listenerCount).toBe(1);

    harness.handle.destroy();

    expect(renderer.destroyed).toBe(1);
    expect(store.listenerCount).toBe(0);
    expect(transport.closed).toBe(true);
    expect(harness.root.childElementCount).toBe(0);
    // A second destroy is idempotent.
    harness.handle.destroy();
    expect(renderer.destroyed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stylesheet guard
// ---------------------------------------------------------------------------

/**
 * Source-level guard for the online room stylesheet.
 *
 * The stage cards set `display: flex`, which outranks the browser's
 * `[hidden] { display: none }` rule. jsdom force-applies `[hidden]`, so a
 * computed-style unit test cannot catch the regression; this source-level
 * test pins the author rule while the real-browser check lives in the room
 * e2e.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOM_VIEW_CSS = readFileSync(
  join(ROOT, 'src', 'games', 'minesweeper', 'online', 'client', 'room-view.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** Whether an author rule hides `.online-room__card` elements with `hidden`. */
function hidesHiddenCards(css: string): boolean {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(
    ([, selector = '', declarations = '']) =>
      selector.includes('.online-room__card') &&
      selector.includes('[hidden]') &&
      /display\s*:\s*none/.test(declarations),
  );
}

describe('online room card visibility', () => {
  it('hides inactive cards with an author rule that beats the flex display', () => {
    expect(hidesHiddenCards(ROOM_VIEW_CSS)).toBe(true);
  });
});
