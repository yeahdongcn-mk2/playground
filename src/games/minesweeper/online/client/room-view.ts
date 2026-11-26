/**
 * Online Minesweeper room view (#486).
 *
 * The view is a pure DOM composition of the client contract in
 * `./contracts`: it receives a store, selectors, a board renderer and a
 * transport factory through `OnlineRoomViewDependencies` and never imports a
 * concrete reducer, socket or board implementation. That keeps this module
 * testable with in-memory fakes and leaves the wire, reducer and renderer
 * tasks independent of the room shell.
 *
 * Ownership rules pinned by the design and the client contract:
 *
 * - The client only renders the redacted board; hidden mine positions never
 *   appear in `BoardViewModel`. The final result is text plus counters, not a
 *   second mine-revealing board.
 * - Countdowns are display estimates derived from server deadlines
 *   (`joinDeadlineAt`, `deadlineAt`, `matchDeadlineAt`) and the injected clock.
 *   Reaching zero changes text only: it never sends a message or changes the
 *   phase, because the server alone adjudicates timeouts.
 * - `leave` is sent only while the room is `waiting` or `ready`. Returning to
 *   the hub from a running or finished match only closes the socket, so the
 *   seat stays resumable with its stored token.
 * - The single-player view in `../../view.ts` is intentionally untouched.
 */

import { escapeHtml, query, setText } from '../../../../core/dom';
import {
  DEFAULT_DIFFICULTY_ID,
  DIFFICULTY_PRESETS,
  getDifficulty,
  type DifficultyId,
} from '../../difficulty';
import type { MinesweeperConfig } from '../../engine';
import {
  createInitialRoomClientState,
  onlineRoomHref,
  parseOnlineRoomHref,
  roomClientErrorText,
  type BoardActionIntent,
  type BoardRenderer,
  type ClientTransport,
  type OnlineRoomHandle,
  type OnlineRoomViewDependencies,
  type RoomClientPhase,
  type RoomClientRoom,
  type RoomClientState,
  type RoomClientStore,
  type RoomCountdown,
  type SeatSession,
  type Unsubscribe,
} from './contracts';
import { PROTOCOL_VERSION } from '../types';
import type {
  ActionMessage,
  ClientToServerMessage,
  CreateMessage,
  EndMessage,
  JoinMessage,
  LeaveMessage,
  MatchEndReason,
  PlayerPresence,
  PlayerView,
  ReadyMessage,
  RematchMessage,
  SnapshotMessage,
  StartMessage,
} from '../types';
import './room-view.css';

/** Wall-clock polling used only to refresh countdown text. */
const CLOCK_INTERVAL_MS = 250;
/** Longest accepted nickname; also enforced by the input's `maxlength`. */
const MAX_NICKNAME_LENGTH = 24;
/** Hub route used by every "back to lobby" control. */
const HUB_HREF = '#/';

const PRESENCE_LABELS: Readonly<Record<PlayerPresence, string>> = Object.freeze({
  online: '在线',
  reconnecting: '重连中',
  offline: '已离线',
});

const END_REASON_LABELS: Readonly<Record<MatchEndReason, string>> = Object.freeze({
  'mine-hit': '踩到地雷',
  'all-safe-revealed': '翻完所有安全格',
  forfeit: '认输',
  'turn-timeout': '回合超时',
  'match-timeout': '整局超时',
});

/** Options supplied by the router when it mounts the room screen. */
export interface OnlineRoomViewOptions {
  /** Room id from the hash route; `null`/absent means the create/join screen. */
  readonly roomId?: string | null;
  /** Prefill for the nickname field, for example from a stored seat. */
  readonly displayName?: string;
  /** Preset selected on the create form. */
  readonly difficulty?: DifficultyId;
}

interface SeatConnection {
  session: SeatSession;
  readonly transport: ClientTransport;
  readonly store: RoomClientStore;
  readonly unsubscribeStore: Unsubscribe;
  readonly unsubscribeTransport: Unsubscribe;
}

interface CloseSeatOptions {
  /** Drop the resumable seat token, for example after an explicit leave. */
  readonly clearToken: boolean;
}

/**
 * Mount the online room screen.
 *
 * The returned handle exposes the latest committed state for the shell and
 * tests, and `destroy()` closes the socket, clears the countdown interval and
 * destroys the board renderer. `root` is replaced with the room markup.
 */
export function mountOnlineRoomView(
  root: HTMLElement,
  dependencies: OnlineRoomViewDependencies,
  options: OnlineRoomViewOptions = {},
): OnlineRoomHandle {
  const initialRoomId = resolveInitialRoomId(options);
  const storedSession = initialRoomId === null ? null : dependencies.tokenStore.load(initialRoomId);
  const initialDisplayName = options.displayName ?? storedSession?.displayName ?? '';
  const initialDifficulty = options.difficulty ?? DEFAULT_DIFFICULTY_ID;

  root.innerHTML = roomShellHtml(initialRoomId, initialDisplayName, initialDifficulty);

  const section = query<HTMLElement>(root, '[data-testid="online-room"]');
  const landing = query<HTMLElement>(root, '[data-testid="landing"]');
  const connecting = query<HTMLElement>(root, '[data-testid="connecting"]');
  const waiting = query<HTMLElement>(root, '[data-testid="waiting"]');
  const playing = query<HTMLElement>(root, '[data-testid="playing"]');
  const finished = query<HTMLElement>(root, '[data-testid="finished"]');
  const closed = query<HTMLElement>(root, '[data-testid="closed"]');

  const nicknameInput = query<HTMLInputElement>(root, '[data-testid="nickname"]');
  const difficultySelect = query<HTMLSelectElement>(root, '[data-testid="difficulty"]');
  const createForm = query<HTMLFormElement>(root, '[data-testid="create-form"]');
  const joinForm = query<HTMLFormElement>(root, '[data-testid="join-form"]');
  const joinRoomInput = query<HTMLInputElement>(root, '[data-testid="join-room-id"]');
  const formError = query<HTMLElement>(root, '[data-testid="form-error"]');
  const sharePrefill = query<HTMLElement>(root, '[data-testid="share-prefill"]');
  const sharePrefillLink = query<HTMLAnchorElement>(root, '[data-testid="share-link"]');
  const connectingDetail = query<HTMLElement>(root, '[data-testid="connecting-detail"]');

  const reconnectBanner = query<HTMLElement>(root, '[data-testid="reconnect-banner"]');
  const presenceWarning = query<HTMLElement>(root, '[data-testid="presence-warning"]');
  const roomError = query<HTMLElement>(root, '[data-testid="room-error"]');

  const waitingTitle = query<HTMLElement>(root, '[data-testid="waiting-title"]');
  const roomIdText = query<HTMLElement>(root, '[data-testid="room-id"]');
  const roomShareLink = query<HTMLAnchorElement>(root, '[data-testid="room-share-link"]');
  const joinCountdown = query<HTMLElement>(root, '[data-testid="join-countdown"]');
  const joinCountdownLabel = query<HTMLElement>(root, '[data-testid="join-countdown-label"]');
  const playersList = query<HTMLElement>(root, '[data-testid="players"]');
  const toggleReadyButton = query<HTMLButtonElement>(root, '[data-testid="toggle-ready"]');
  const startButton = query<HTMLButtonElement>(root, '[data-testid="start-match"]');
  const leaveButton = query<HTMLButtonElement>(root, '[data-testid="leave-room"]');

  const turnOwner = query<HTMLElement>(root, '[data-testid="turn-owner"]');
  const turnHint = query<HTMLElement>(root, '[data-testid="turn-hint"]');
  const remainingMinesText = query<HTMLElement>(root, '[data-testid="remaining-mines"]');
  const turnCountdown = query<HTMLElement>(root, '[data-testid="turn-countdown"]');
  const matchCountdown = query<HTMLElement>(root, '[data-testid="match-countdown"]');
  const actionError = query<HTMLElement>(root, '[data-testid="action-error"]');
  const boardMount = query<HTMLElement>(root, '[data-testid="online-board"]');
  const playingLobbyButton = query<HTMLButtonElement>(root, '[data-testid="playing-lobby"]');

  const resultOutcome = query<HTMLElement>(root, '[data-testid="result-outcome"]');
  const resultDetail = query<HTMLElement>(root, '[data-testid="result-detail"]');
  const resultReason = query<HTMLElement>(root, '[data-testid="result-reason"]');
  const statTurns = query<HTMLElement>(root, '[data-testid="stat-turns"]');
  const statSafeCells = query<HTMLElement>(root, '[data-testid="stat-safe-cells"]');
  const statFlags = query<HTMLElement>(root, '[data-testid="stat-flags"]');
  const statDuration = query<HTMLElement>(root, '[data-testid="stat-duration"]');
  const rematchButton = query<HTMLButtonElement>(root, '[data-testid="rematch"]');
  const finishedLobbyButton = query<HTMLButtonElement>(root, '[data-testid="finished-lobby"]');

  const closedReason = query<HTMLElement>(root, '[data-testid="closed-reason"]');
  const closedLobbyButton = query<HTMLButtonElement>(root, '[data-testid="closed-lobby"]');

  if (initialRoomId !== null) {
    joinRoomInput.value = initialRoomId;
    const href = onlineRoomHref(initialRoomId);
    sharePrefillLink.href = href;
    sharePrefillLink.textContent = href;
    sharePrefill.hidden = false;
  }

  let seat: SeatConnection | null = null;
  let boardRenderer: BoardRenderer | null = null;
  let lastRenderedPhase: RoomClientPhase | null = null;
  let currentState = createInitialRoomClientState();
  let currentRoomId = initialRoomId ?? '';
  let rematchRequested = false;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let requestCounter = 0;
  let actionCounter = 0;
  let destroyed = false;

  function nextRequestId(kind: string): string {
    requestCounter += 1;
    return `${kind}-${requestCounter}`;
  }

  function nextActionId(): string {
    actionCounter += 1;
    return `action-${actionCounter}`;
  }

  function showFormError(message: string): void {
    formError.textContent = message;
    formError.hidden = false;
  }

  function clearFormError(): void {
    formError.hidden = true;
    formError.textContent = '';
  }

  function readNickname(fallback: string | null = null): string | null {
    const typed = nicknameInput.value.trim();
    const name = typed === '' && fallback !== null ? fallback.trim() : typed;
    if (name === '') {
      showFormError('先填一个昵称，对手会在玩家列表里看到它。');
      return null;
    }
    if (name.length > MAX_NICKNAME_LENGTH) {
      showFormError(`昵称最多 ${MAX_NICKNAME_LENGTH} 个字符。`);
      return null;
    }
    return name;
  }

  function selectedConfig(): MinesweeperConfig {
    const preset =
      DIFFICULTY_PRESETS.find((candidate) => candidate.id === difficultySelect.value) ??
      getDifficulty(DEFAULT_DIFFICULTY_ID);
    return {
      rows: preset.rows,
      cols: preset.cols,
      mines: preset.mines,
      firstClickSafe: true,
    };
  }

  function startTicker(): void {
    if (ticker !== null) {
      return;
    }
    ticker = setInterval(() => {
      if (seat === null || destroyed) {
        return;
      }
      renderCountdowns(currentState, dependencies.now());
    }, CLOCK_INTERVAL_MS);
  }

  function stopTicker(): void {
    if (ticker === null) {
      return;
    }
    clearInterval(ticker);
    ticker = null;
  }

  function destroyBoardRenderer(): void {
    if (boardRenderer !== null) {
      boardRenderer.destroy();
      boardRenderer = null;
    }
    boardMount.replaceChildren();
  }

  function closeSeat(closeOptions: CloseSeatOptions): void {
    if (seat === null) {
      return;
    }
    const current = seat;
    seat = null;
    current.unsubscribeStore();
    current.unsubscribeTransport();
    current.transport.close();
    const tokenRoomId =
      current.session.roomId !== '' ? current.session.roomId : currentState.room?.roomId ?? '';
    if (closeOptions.clearToken && tokenRoomId !== '') {
      dependencies.tokenStore.clear(tokenRoomId);
    }
    stopTicker();
    destroyBoardRenderer();
    rematchRequested = false;
  }

  function activeRoomId(): string {
    return currentState.room?.roomId ?? seat?.session.roomId ?? '';
  }

  function openSeat(
    session: SeatSession,
    initialMessage: ClientToServerMessage,
    connectingLabel: string,
  ): void {
    closeSeat({ clearToken: false });
    clearFormError();
    const transport = dependencies.createTransport(session);
    const store = dependencies.createStore({ session, transport });
    const unsubscribeStore = store.subscribe((state) => {
      render(state);
    });
    // The store does not own the socket: the view is the composition root that
    // forwards every server message to `applyServerMessage`, and the owner-only
    // token never enters render state, so it is persisted here as well.
    const unsubscribeTransport = transport.onMessage((message) => {
      if (seat === null) {
        return;
      }
      if (message.type === 'room_state') {
        const nextSession: SeatSession = {
          ...seat.session,
          roomId: message.roomId,
          playerToken: message.playerToken ?? seat.session.playerToken,
        };
        seat.session = nextSession;
        currentRoomId = message.roomId;
        if (nextSession.playerToken !== null) {
          dependencies.tokenStore.save(nextSession);
        }
      }
      store.applyServerMessage(message);
    });
    seat = {
      session,
      transport,
      store,
      unsubscribeStore,
      unsubscribeTransport,
    };
    currentRoomId = session.roomId;
    setText(connectingDetail, connectingLabel);
    transport.connect(session);
    transport.send(initialMessage);
    startTicker();
    render(store.getState());
  }

  function render(state: RoomClientState): void {
    if (destroyed) {
      return;
    }
    currentState = state;
    if (seat !== null && state.room !== null) {
      currentRoomId = state.room.roomId;
    }

    section.dataset.phase = state.phase;
    section.dataset.connection = state.connection;

    renderBanners(state);
    renderError(state);

    const phase: RoomClientPhase = seat === null ? 'idle' : state.phase;
    landing.hidden = !(phase === 'idle' && seat === null);
    connecting.hidden = !(phase === 'idle' && seat !== null);
    waiting.hidden = !(phase === 'waiting' || phase === 'ready');
    playing.hidden = phase !== 'playing';
    finished.hidden = phase !== 'finished';
    closed.hidden = phase !== 'dissolved';

    if (phase === 'waiting' || phase === 'ready') {
      renderWaiting(state);
    }
    if (phase === 'playing') {
      renderPlaying(state);
    }
    if (phase === 'finished') {
      renderFinished(state);
    }
    if (phase === 'dissolved') {
      renderClosed(state);
    }
    if (phase !== 'finished') {
      rematchRequested = false;
    }

    if (lastRenderedPhase === 'playing' && phase !== 'playing') {
      destroyBoardRenderer();
    }
    if (phase !== 'playing') {
      actionError.hidden = true;
    }
    lastRenderedPhase = phase;

    renderCountdowns(state, dependencies.now());
  }

  function renderBanners(state: RoomClientState): void {
    let reconnectText = '';
    if (seat !== null) {
      if (state.connection === 'reconnecting') {
        reconnectText = '与房间的连接已断开，正在尝试重连；棋盘与计时的最终裁决仍以服务端为准。';
      } else if (state.connection === 'offline') {
        reconnectText = '网络已离线，正在等待恢复连接；宽限期结束前保留你的席位。';
      } else if (state.connection === 'closed' && state.phase !== 'dissolved') {
        reconnectText = '连接已关闭，请返回大厅后重试。';
      }
    }
    reconnectBanner.hidden = reconnectText === '';
    setText(reconnectBanner, reconnectText);

    const other = otherPlayer(state);
    let presenceText = '';
    if (other !== null && state.phase !== 'dissolved' && state.phase !== 'idle') {
      if (other.presence === 'reconnecting') {
        presenceText = `对手 ${other.displayName} 正在重连，房间计时仍会继续。`;
      } else if (other.presence === 'offline') {
        presenceText = `对手 ${other.displayName} 已离线，宽限期内未重连将判负。`;
      }
    }
    presenceWarning.hidden = presenceText === '';
    setText(presenceWarning, presenceText);
  }

  function renderError(state: RoomClientState): void {
    const error = state.error;
    if (error === null) {
      roomError.hidden = true;
      roomError.textContent = '';
      delete roomError.dataset.code;
      return;
    }
    const selectedText = dependencies.selectors.errorText(state);
    const text =
      selectedText !== null && selectedText.trim() !== ''
        ? selectedText
        : roomClientErrorText(error.code);
    roomError.hidden = false;
    roomError.dataset.code = error.code;
    setText(roomError, text);
  }

  function renderWaiting(state: RoomClientState): void {
    const room = state.room;
    if (room === null) {
      setText(waitingTitle, '正在同步房间…');
      return;
    }
    const selfId = state.selfId;
    const self = findPlayer(room, selfId);
    setText(waitingTitle, room.state === 'ready' ? '双方已准备，等待房主开局。' : phaseWaitingTitle(room));
    setText(roomIdText, room.roomId);
    const href = onlineRoomHref(room.roomId);
    roomShareLink.href = href;
    roomShareLink.textContent = href;

    setText(
      joinCountdownLabel,
      room.state === 'ready' ? '开局等待剩余' : '加入剩余',
    );

    renderPlayers(room, selfId);

    const canToggle = dependencies.selectors.canToggleReady(state);
    toggleReadyButton.disabled = !canToggle;
    toggleReadyButton.textContent = self?.ready === true ? '取消准备' : '准备';
    toggleReadyButton.setAttribute('aria-pressed', String(self?.ready === true));

    const canStart = dependencies.selectors.canStart(state);
    startButton.disabled = !canStart;
    startButton.textContent = dependencies.selectors.isHost(state)
      ? '开始对局'
      : '仅房主可开始';
  }

  function phaseWaitingTitle(room: RoomClientRoom): string {
    if (room.players.length < room.capacity) {
      return '等待对手加入；把房间号或邀请链接发给对方。';
    }
    return '座位已满，双方准备后由房主开局。';
  }

  function renderPlayers(room: RoomClientRoom, selfId: string | null): void {
    playersList.innerHTML = room.players
      .map((player) => playerRowHtml(player, selfId))
      .join('');
  }

  function playerRowHtml(player: PlayerView, selfId: string | null): string {
    const self = player.playerId === selfId;
    return `<li class="online-room__player" data-testid="player"
      data-player-id="${escapeHtml(player.playerId)}"
      data-presence="${player.presence}"
      data-self="${String(self)}"
      data-host="${String(player.isHost)}">
      <span class="online-room__player-name">${escapeHtml(player.displayName)}${self ? '（你）' : ''}</span>
      <span class="online-room__player-tags">
        ${player.isHost ? '<span class="online-room__tag">房主</span>' : ''}
        <span class="online-room__tag online-room__tag--ready" data-ready="${String(player.ready)}">${player.ready ? '已准备' : '未准备'}</span>
        <span class="online-room__tag online-room__tag--presence" data-testid="player-presence">${PRESENCE_LABELS[player.presence]}</span>
      </span>
    </li>`;
  }

  function renderPlaying(state: RoomClientState): void {
    const board = dependencies.selectors.board(state);
    const mayAct = dependencies.selectors.isMyTurn(state);
    boardMount.dataset.actionsEnabled = String(mayAct);
    boardMount.setAttribute('aria-disabled', String(!mayAct));

    if (board === null) {
      setText(turnOwner, '等待服务端棋盘…');
      setText(turnHint, '房间已开局，正在同步脱敏快照。');
      setText(remainingMinesText, '—');
      destroyBoardRenderer();
      return;
    }

    const turnName = playerName(state.room, board.turnPlayerId) ?? '对手';
    setText(turnOwner, mayAct ? '你的回合' : `对手回合 · ${turnName}`);
    setText(
      turnHint,
      mayAct
        ? '轮到你行动：翻开格子或插旗；倒计时只作展示，超时由服务端裁决。'
        : `等待 ${turnName} 行动；棋盘只显示服务端已公开的信息。`,
    );
    setText(remainingMinesText, String(board.remainingMines));

    const renderer = ensureBoardRenderer();
    renderer.render(boardMount, board, handleBoardIntent);
    actionError.hidden = true;
  }

  function ensureBoardRenderer(): BoardRenderer {
    if (boardRenderer === null) {
      boardRenderer = dependencies.createBoardRenderer();
    }
    return boardRenderer;
  }

  function handleBoardIntent(intent: BoardActionIntent): void {
    if (seat === null) {
      return;
    }
    const state = currentState;
    const gate = dependencies.selectors.actionGate(state, intent.row, intent.col, intent.kind);
    if (!gate.allowed) {
      actionError.hidden = false;
      setText(actionError, gate.message ?? '现在还不能操作这个格子。');
      return;
    }
    const snapshot = state.snapshot;
    if (snapshot === null) {
      actionError.hidden = false;
      setText(actionError, '棋盘尚未就绪，请稍候。');
      return;
    }
    actionError.hidden = true;
    const message: ActionMessage = {
      type: 'action',
      roomId: snapshot.roomId,
      matchId: snapshot.matchId,
      actionId: nextActionId(),
      seq: state.lastSeq,
      turnId: snapshot.turnId,
      kind: intent.kind,
      row: intent.row,
      col: intent.col,
      clientTimeMs: dependencies.now(),
    };
    seat.transport.send(message);
  }

  function renderFinished(state: RoomClientState): void {
    const end = state.end;
    if (end === null) {
      setText(resultOutcome, '对局已结束');
      setText(resultDetail, '等待服务端结算信息…');
      setText(resultReason, '未知原因');
      setText(statTurns, '—');
      setText(statSafeCells, '—');
      setText(statFlags, '—');
      setText(statDuration, '—');
      rematchButton.disabled = true;
      return;
    }

    const outcome = end.winnerId === null
      ? '平局'
      : end.winnerId === state.selfId
        ? '胜利'
        : '失败';
    setText(resultOutcome, outcome);
    setText(resultDetail, resultDetailText(state, end));
    setText(resultReason, `结束原因：${END_REASON_LABELS[end.reason]}`);
    setText(statTurns, String(end.stats.turnCount));
    setText(statSafeCells, String(end.stats.revealedSafeCount));
    setText(statFlags, String(end.stats.flagsPlaced));
    setText(statDuration, formatDuration(end.stats.durationMs));

    rematchButton.disabled = rematchRequested;
    rematchButton.textContent = rematchRequested ? '已申请重开，等待对手' : '再来一局';
  }

  function resultDetailText(state: RoomClientState, end: EndMessage): string {
    if (end.winnerId === null) {
      return '双方都没有获胜，本局结束。';
    }
    if (end.winnerId === state.selfId) {
      return '你赢下了这一局，可以再来一局或返回大厅。';
    }
    const winnerName = playerName(state.room, end.winnerId);
    return winnerName === null ? '对手赢下了这一局。' : `${winnerName} 赢下了这一局。`;
  }

  function renderClosed(state: RoomClientState): void {
    const reason = state.room?.stateReason;
    setText(
      closedReason,
      reason === null || reason === undefined
        ? '房间已关闭，请返回大厅重新创建或加入。'
        : `房间已关闭：${reason}`,
    );
  }

  function renderCountdowns(state: RoomClientState, nowMs: number): void {
    if (state.phase === 'waiting' || state.phase === 'ready') {
      const countdown = dependencies.selectors.countdown(state, nowMs);
      applyCountdown(joinCountdown, countdown, nowMs);
      joinCountdown.hidden = countdown.kind === 'none';
      joinCountdownLabel.hidden = countdown.kind === 'none';
      return;
    }
    if (state.phase !== 'playing') {
      return;
    }
    const snapshot: SnapshotMessage | null = state.snapshot;
    if (snapshot === null) {
      return;
    }
    applyRemaining(turnCountdown, snapshot.deadlineAt, nowMs);
    applyRemaining(matchCountdown, snapshot.matchDeadlineAt, nowMs);
  }

  function applyCountdown(
    element: HTMLElement,
    countdown: RoomCountdown,
    nowMs: number,
  ): void {
    if (countdown.deadlineAt === null) {
      setText(element, '0:00');
      delete element.dataset.deadlineAt;
      return;
    }
    applyRemaining(element, countdown.deadlineAt, nowMs);
  }

  function applyRemaining(element: HTMLElement, deadlineAt: number, nowMs: number): void {
    element.dataset.deadlineAt = String(deadlineAt);
    setText(element, formatDuration(Math.max(0, deadlineAt - nowMs)));
  }

  function leaveOrClose(): void {
    const state = currentState;
    if (seat !== null) {
      const canLeave = state.phase === 'waiting' || state.phase === 'ready';
      if (canLeave) {
        const leave: LeaveMessage = {
          type: 'leave',
          roomId: activeRoomId(),
          requestId: nextRequestId('leave'),
        };
        seat.transport.send(leave);
      }
      closeSeat({ clearToken: canLeave || state.phase === 'dissolved' });
    }
    dependencies.navigate(HUB_HREF);
  }

  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (seat !== null) {
      return;
    }
    const displayName = readNickname();
    if (displayName === null) {
      return;
    }
    const session: SeatSession = {
      roomId: '',
      playerToken: null,
      displayName,
      role: 'host',
    };
    const create: CreateMessage = {
      type: 'create',
      requestId: nextRequestId('create'),
      protocolVersion: PROTOCOL_VERSION,
      config: selectedConfig(),
      displayName,
    };
    openSeat(session, create, `${displayName} · 正在创建房间…`);
  });

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (seat !== null) {
      return;
    }
    const roomId = joinRoomInput.value.trim();
    if (roomId === '') {
      showFormError('请填写要加入的房间号。');
      return;
    }
    const saved = dependencies.tokenStore.load(roomId);
    const displayName = readNickname(saved?.displayName ?? null);
    if (displayName === null) {
      return;
    }
    const session: SeatSession = {
      roomId,
      playerToken: saved?.playerToken ?? null,
      displayName,
      role: saved?.role ?? 'guest',
    };
    const join: JoinMessage = {
      type: 'join',
      requestId: nextRequestId('join'),
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      displayName,
      ...(session.playerToken === null ? {} : { playerToken: session.playerToken }),
    };
    openSeat(session, join, `${displayName} · 正在加入 ${roomId}…`);
  });

  toggleReadyButton.addEventListener('click', () => {
    if (seat === null) {
      return;
    }
    const state = currentState;
    const self = state.room === null ? null : findPlayer(state.room, state.selfId);
    const ready: ReadyMessage = {
      type: 'ready',
      roomId: activeRoomId(),
      requestId: nextRequestId('ready'),
      ready: self?.ready !== true,
    };
    seat.transport.send(ready);
  });

  startButton.addEventListener('click', () => {
    if (seat === null) {
      return;
    }
    const start: StartMessage = {
      type: 'start',
      roomId: activeRoomId(),
      requestId: nextRequestId('start'),
    };
    seat.transport.send(start);
  });

  leaveButton.addEventListener('click', () => {
    leaveOrClose();
  });

  playingLobbyButton.addEventListener('click', () => {
    leaveOrClose();
  });

  finishedLobbyButton.addEventListener('click', () => {
    leaveOrClose();
  });

  closedLobbyButton.addEventListener('click', () => {
    leaveOrClose();
  });

  rematchButton.addEventListener('click', () => {
    if (seat === null || rematchRequested) {
      return;
    }
    const rematch: RematchMessage = {
      type: 'rematch',
      roomId: activeRoomId(),
      requestId: nextRequestId('rematch'),
      accept: true,
    };
    seat.transport.send(rematch);
    rematchRequested = true;
    rematchButton.disabled = true;
    rematchButton.textContent = '已申请重开，等待对手';
  });

  query<HTMLButtonElement>(root, '[data-testid="cancel-connect"]').addEventListener(
    'click',
    () => {
      closeSeat({ clearToken: false });
      render(createInitialRoomClientState());
    },
  );

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    closeSeat({ clearToken: false });
    stopTicker();
    root.replaceChildren();
  }

  return {
    get roomId() {
      return currentRoomId;
    },
    getState: () => currentState,
    destroy,
  };
}

/** Resolve a route room id; an explicit option wins over the current hash. */
function resolveInitialRoomId(options: OnlineRoomViewOptions): string | null {
  if (options.roomId !== undefined) {
    return options.roomId === '' ? null : options.roomId;
  }
  const hash = typeof window === 'undefined' ? '' : window.location.hash;
  const route = parseOnlineRoomHref(hash);
  return route?.roomId ?? null;
}

function findPlayer(room: RoomClientRoom, playerId: string | null): PlayerView | null {
  if (playerId === null) {
    return null;
  }
  return room.players.find((player) => player.playerId === playerId) ?? null;
}

function otherPlayer(state: RoomClientState): PlayerView | null {
  const room = state.room;
  if (room === null || state.selfId === null) {
    return null;
  }
  return room.players.find((player) => player.playerId !== state.selfId) ?? null;
}

function playerName(room: RoomClientRoom | null, playerId: string | null): string | null {
  if (room === null || playerId === null) {
    return null;
  }
  return room.players.find((player) => player.playerId === playerId)?.displayName ?? null;
}

/** Format milliseconds as `m:ss`; expiries and negative values show `0:00`. */
function formatDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function roomShellHtml(
  initialRoomId: string | null,
  initialDisplayName: string,
  initialDifficulty: DifficultyId,
): string {
  const presetOptions = DIFFICULTY_PRESETS.map((preset) => {
    const selected = preset.id === initialDifficulty ? ' selected' : '';
    return `<option value="${preset.id}"${selected}>${preset.label} · ${preset.rows}×${preset.cols} · ${preset.mines} 雷</option>`;
  }).join('');

  return `
  <section class="online-room" data-testid="online-room" data-phase="idle" data-connection="idle">
    <div class="game-heading">
      <a class="back-link" href="#/"><span aria-hidden="true">←</span> 返回大厅</a>
      <div class="game-heading-copy">
        <p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> ONLINE · 1v1 · 回合制</p>
        <h1>联机扫雷 <span>Minesweeper Online</span></h1>
      </div>
    </div>

    <div class="online-room__banner" data-testid="reconnect-banner" role="status" hidden></div>
    <div class="online-room__banner online-room__banner--presence" data-testid="presence-warning"
      role="status" hidden></div>
    <div class="online-room__error" data-testid="room-error" role="alert" hidden></div>

    <section class="online-room__card" data-testid="landing" aria-labelledby="online-landing-title">
      <p class="panel-kicker">CREATE / JOIN</p>
      <h2 id="online-landing-title">创建或加入房间</h2>
      <p class="online-room__hint">
        两位玩家共享一块由服务端裁决的棋盘，轮流翻开或插旗；联机入口独立加载，不影响单机扫雷。
      </p>

      <div class="online-room__identity">
        <label for="online-nickname">昵称</label>
        <input id="online-nickname" data-testid="nickname" name="displayName" type="text"
          maxlength="24" autocomplete="nickname" placeholder="例如：Ada"
          value="${escapeHtml(initialDisplayName)}">
      </div>

      <div class="online-room__forms">
        <form class="online-room__form" data-testid="create-form" novalidate>
          <p class="panel-kicker">CREATE</p>
          <h3>创建房间</h3>
          <label for="online-difficulty">难度</label>
          <select id="online-difficulty" data-testid="difficulty" name="difficulty">
            ${presetOptions}
          </select>
          <button class="button button--primary" type="submit" data-testid="create-room">创建房间</button>
        </form>

        <form class="online-room__form" data-testid="join-form" novalidate>
          <p class="panel-kicker">JOIN</p>
          <h3>加入房间</h3>
          <label for="online-room-id">房间号</label>
          <input id="online-room-id" data-testid="join-room-id" name="roomId" type="text"
            maxlength="64" autocomplete="off" placeholder="粘贴房间号或邀请链接中的 room 参数"
            value="${initialRoomId === null ? '' : escapeHtml(initialRoomId)}">
          <button class="button button--primary" type="submit" data-testid="join-room">加入房间</button>
        </form>
      </div>

      <p class="online-room__share" data-testid="share-prefill" hidden>
        邀请链接：<a data-testid="share-link" href="#/online/minesweeper"></a>
      </p>
      <p class="online-room__form-error" data-testid="form-error" role="alert" hidden></p>
    </section>

    <section class="online-room__card" data-testid="connecting" aria-live="polite" hidden>
      <p class="panel-kicker">CONNECTING</p>
      <h2>正在连接房间…</h2>
      <p class="online-room__hint" data-testid="connecting-detail"></p>
      <div class="online-room__actions">
        <button class="button button--ghost" type="button" data-testid="cancel-connect">取消</button>
      </div>
    </section>

    <section class="online-room__card" data-testid="waiting" aria-labelledby="online-waiting-title" hidden>
      <p class="panel-kicker">ROOM</p>
      <h2 id="online-waiting-title" data-testid="waiting-title">等待对手</h2>
      <p class="online-room__hint">
        房间号：<code data-testid="room-id"></code> ·
        邀请链接：<a data-testid="room-share-link" href="#/online/minesweeper"></a>
      </p>
      <p class="online-room__countdown">
        <span data-testid="join-countdown-label">加入剩余</span>
        <strong data-testid="join-countdown">0:00</strong>
      </p>
      <ul class="online-room__players" data-testid="players" aria-label="房间玩家"></ul>
      <div class="online-room__actions">
        <button class="button button--ghost" type="button" data-testid="toggle-ready">准备</button>
        <button class="button button--primary" type="button" data-testid="start-match">开始对局</button>
        <button class="button button--ghost" type="button" data-testid="leave-room">离房</button>
      </div>
    </section>

    <section class="online-room__card" data-testid="playing" aria-labelledby="online-playing-title" hidden>
      <p class="panel-kicker">MATCH</p>
      <h2 id="online-playing-title" data-testid="turn-owner">你的回合</h2>
      <p class="online-room__hint" data-testid="turn-hint"></p>
      <div class="online-room__hud">
        <div class="online-room__stat">
          <span>剩余雷数</span>
          <strong data-testid="remaining-mines">—</strong>
        </div>
        <div class="online-room__stat">
          <span>回合剩余</span>
          <strong data-testid="turn-countdown">0:00</strong>
        </div>
        <div class="online-room__stat">
          <span>整局剩余</span>
          <strong data-testid="match-countdown">0:00</strong>
        </div>
      </div>
      <p class="online-room__action-error" data-testid="action-error" role="status" hidden></p>
      <div class="online-room__board" data-testid="online-board" data-actions-enabled="false"
        aria-disabled="true"></div>
      <div class="online-room__actions">
        <button class="button button--ghost" type="button" data-testid="playing-lobby">返回大厅</button>
      </div>
    </section>

    <section class="online-room__card" data-testid="finished" aria-labelledby="online-result-title" hidden>
      <p class="panel-kicker">RESULT</p>
      <h2 id="online-result-title" data-testid="result-outcome">对局结束</h2>
      <p class="online-room__hint" data-testid="result-detail"></p>
      <p class="online-room__reason" data-testid="result-reason"></p>
      <dl class="online-room__stats" data-testid="result-stats" aria-label="本局统计">
        <div><dt>回合数</dt><dd data-testid="stat-turns">—</dd></div>
        <div><dt>安全格</dt><dd data-testid="stat-safe-cells">—</dd></div>
        <div><dt>插旗</dt><dd data-testid="stat-flags">—</dd></div>
        <div><dt>用时</dt><dd data-testid="stat-duration">—</dd></div>
      </dl>
      <div class="online-room__actions">
        <button class="button button--primary" type="button" data-testid="rematch">再来一局</button>
        <button class="button button--ghost" type="button" data-testid="finished-lobby">返回大厅</button>
      </div>
    </section>

    <section class="online-room__card" data-testid="closed" aria-labelledby="online-closed-title" hidden>
      <p class="panel-kicker">CLOSED</p>
      <h2 id="online-closed-title">房间已解散</h2>
      <p class="online-room__hint" data-testid="closed-reason"></p>
      <div class="online-room__actions">
        <button class="button button--primary" type="button" data-testid="closed-lobby">返回大厅</button>
      </div>
    </section>
  </section>`;
}
