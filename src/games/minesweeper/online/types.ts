/**
 * Shared wire contract for online Minesweeper.
 *
 * This module is the single source for the online DTOs, the 14-message
 * protocol and the engine/adapter interfaces. The server, the client and the
 * tests all import these definitions, so no second DTO layer may be added.
 *
 * The contract is deliberately free of DOM and storage APIs: it imports only
 * the pure rules engine from `../engine`. The authoritative message table is
 * the `design:protocol` JSON block in `docs/minesweeper-online-design.md`;
 * `tests/unit/online-contracts.test.ts` keeps `MESSAGE_SPECS` aligned with it.
 */

import type {
  Cell,
  MinesweeperCell,
  MinesweeperConfig,
  MinesweeperSnapshot,
  MinesweeperStatus,
} from '../engine';

/** Wire version carried by every client message and checked on `join`. */
export const PROTOCOL_VERSION = 1;

/** Who is allowed to send a message. */
export type MessageDirection = 'client-to-server' | 'server-to-client';

/** The seven messages a client may send. */
export type ClientMessageType =
  | 'create'
  | 'join'
  | 'ready'
  | 'start'
  | 'action'
  | 'rematch'
  | 'leave';

/** The seven messages only the authoritative server may send. */
export type ServerMessageType =
  | 'room_state'
  | 'snapshot'
  | 'action_result'
  | 'end'
  | 'timeout'
  | 'room_closed'
  | 'error';

/** Every message in `design:protocol`. */
export type OnlineMessageType = ClientMessageType | ServerMessageType;

/** A reveal or flag action. Both consume one turn. */
export type ActionKind = 'reveal' | 'flag';

/**
 * Room lifecycle state from `design:room-lifecycle`. `idle` is the pre-room
 * state and never appears in a `room_state` broadcast.
 */
export type RoomState = 'idle' | 'waiting' | 'ready' | 'playing' | 'finished' | 'dissolved';

/** Connection-layer presence; it never becomes part of `RoomState`. */
export type PlayerPresence = 'online' | 'reconnecting' | 'offline';

/** Which timer expired when the server sends a `timeout` message. */
export type TimeoutTimer = 'join' | 'turn' | 'match';

/** Engine status exposed while a match is in progress or just finished. */
export type SnapshotEngineStatus = 'playing' | 'won' | 'lost';

/** Why the authoritative match ended. */
export type MatchEndReason =
  | 'mine-hit'
  | 'all-safe-revealed'
  | 'forfeit'
  | 'turn-timeout'
  | 'match-timeout';

/** Error codes the server returns in an `error` message. */
export type ProtocolErrorCode =
  | 'unsupported-version'
  | 'room-not-found'
  | 'not-your-turn'
  | 'stale-state'
  | 'invalid-action'
  | 'deadline-passed'
  | 'bad-request';

/** Public player summary carried by `room_state`. */
export interface PlayerView {
  readonly playerId: string;
  readonly displayName: string;
  readonly ready: boolean;
  readonly presence: PlayerPresence;
  readonly isHost: boolean;
}

/** Result counters carried by the `end` message. */
export interface MatchStats {
  readonly turnCount: number;
  readonly revealedSafeCount: number;
  readonly flagsPlaced: number;
  readonly durationMs: number;
}

/**
 * One client-visible cell. It intentionally has no `mine` field: hidden mine
 * positions are only published by the `end` message.
 */
export interface RedactedCell extends Cell {
  readonly revealed: boolean;
  readonly flagged: boolean;
  readonly adjacentMines: number;
}

/** Row-major redacted board; rows are top to bottom, columns left to right. */
export type RedactedBoard = readonly (readonly RedactedCell[])[];

/**
 * Engine-side projection of a match snapshot. It carries the public board and
 * counters plus the seed commitment, but never the mine layout or the seed.
 */
export interface RedactedSnapshot {
  readonly seedHash: string;
  readonly engineStatus: SnapshotEngineStatus;
  readonly mineCount: number;
  readonly remainingMines: number;
  readonly revealedSafeCount: number;
  readonly elapsedMs: number;
  readonly board: RedactedBoard;
}

/** A cell of the end-only board, where every mine is public. */
export type RevealedCell = MinesweeperCell;

/** End-only board with all mine positions expanded. */
export type RevealedBoard = readonly (readonly RevealedCell[])[];

/**
 * One accepted action recorded for replay, ordered by `seq`. The action log
 * contains no player identity: only the ordered board actions matter to the
 * deterministic engine.
 */
export interface ReplayAction {
  readonly seq: number;
  readonly turnId: number;
  readonly actionId: string;
  readonly kind: ActionKind;
  readonly row: number;
  readonly col: number;
}

/** Complete replay input: seed, config and accepted actions in `seq` order. */
export interface ReplayRecord {
  readonly matchId: string;
  readonly config: MinesweeperConfig;
  readonly seed: number;
  readonly actions: readonly ReplayAction[];
}

/**
 * Digest of one replayed step, used to compare a replay against the original
 * match without transmitting the mine layout.
 */
export interface ReplayDigest {
  readonly seq: number;
  readonly turnId: number;
  readonly engineStatus: SnapshotEngineStatus;
  readonly revealedSafeCount: number;
  readonly remainingMines: number;
  readonly snapshotHash: string;
}

/**
 * The `end` payload, the only place that publishes every mine position
 * (`finalSnapshot`) and the seed itself.
 */
export interface MatchEndPayload {
  readonly matchId: string;
  readonly reason: MatchEndReason;
  readonly winnerId: string | null;
  readonly loserId: string | null;
  readonly finalSnapshot: RevealedBoard;
  readonly seed: number;
  readonly stats: MatchStats;
}

// ---------------------------------------------------------------------------
// Protocol messages
// ---------------------------------------------------------------------------

/** Create a room; the server validates the config and assigns a `roomId`. */
export interface CreateMessage {
  readonly type: 'create';
  readonly requestId: string;
  readonly protocolVersion: number;
  readonly config: MinesweeperConfig;
  readonly displayName: string;
}

/** Join a room, or resume a seat with a previously issued `playerToken`. */
export interface JoinMessage {
  readonly type: 'join';
  readonly requestId: string;
  readonly protocolVersion: number;
  readonly roomId: string;
  readonly playerToken?: string;
  readonly displayName: string;
}

/** Set or clear readiness. */
export interface ReadyMessage {
  readonly type: 'ready';
  readonly roomId: string;
  readonly requestId: string;
  readonly ready: boolean;
}

/** Host starts the match from `ready`. */
export interface StartMessage {
  readonly type: 'start';
  readonly roomId: string;
  readonly requestId: string;
}

/** The only message that changes the shared board. */
export interface ActionMessage {
  readonly type: 'action';
  readonly roomId: string;
  readonly matchId: string;
  readonly actionId: string;
  readonly seq: number;
  readonly turnId: number;
  readonly kind: ActionKind;
  readonly row: number;
  readonly col: number;
  readonly clientTimeMs: number;
}

/** Accept or decline a rematch after `end`. */
export interface RematchMessage {
  readonly type: 'rematch';
  readonly roomId: string;
  readonly requestId: string;
  readonly accept: boolean;
}

/** Leave a room outside a running match. */
export interface LeaveMessage {
  readonly type: 'leave';
  readonly roomId: string;
  readonly requestId: string;
}

/** Authoritative room state; `playerToken` is only sent to its owner. */
export interface RoomStateMessage {
  readonly type: 'room_state';
  readonly roomId: string;
  readonly seq: number;
  readonly state: RoomState;
  readonly hostId: string;
  readonly capacity: number;
  readonly players: readonly PlayerView[];
  readonly playerToken?: string;
  readonly config: MinesweeperConfig;
  readonly matchId: string | null;
  readonly turnPlayerId: string | null;
  readonly joinDeadlineAt: number;
  readonly deadlineAt: number | null;
  readonly stateReason: string | null;
}

/** Redacted board snapshot broadcast after every accepted action. */
export interface SnapshotMessage extends RedactedSnapshot {
  readonly type: 'snapshot';
  readonly roomId: string;
  readonly matchId: string;
  readonly seq: number;
  readonly turnPlayerId: string;
  readonly turnId: number;
  readonly deadlineAt: number;
  readonly matchDeadlineAt: number;
}

/** The server's verdict for one submitted action. */
export interface ActionResultMessage {
  readonly type: 'action_result';
  readonly roomId: string;
  readonly matchId: string;
  readonly actionId: string;
  readonly seq: number;
  readonly turnId: number;
  readonly accepted: boolean;
  readonly reason: string | null;
  readonly revealedCells: readonly Cell[];
  readonly flaggedCell: Cell | null;
  readonly turnPlayerId: string;
  readonly deadlineAt: number;
}

/** Final result; the only place where the seed and all mines are published. */
export interface EndMessage extends MatchEndPayload {
  readonly type: 'end';
  readonly roomId: string;
  readonly seq: number;
}

/** A join, turn or match timer expired. */
export interface TimeoutMessage {
  readonly type: 'timeout';
  readonly roomId: string;
  readonly matchId: string | null;
  readonly seq: number;
  readonly timer: TimeoutTimer;
  readonly subjectId: string | null;
  readonly deadlineAt: number;
  readonly resultingState: RoomState;
  readonly reason: string;
}

/** The room was dissolved and cannot be recovered. */
export interface RoomClosedMessage {
  readonly type: 'room_closed';
  readonly roomId: string;
  readonly seq: number;
  readonly reason: string;
  readonly finalState: RoomState;
}

/** Protocol or request failure; `requestId` and `roomId` may be unknown. */
export interface ErrorMessage {
  readonly type: 'error';
  readonly requestId: string | null;
  readonly roomId: string | null;
  readonly code: ProtocolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly currentSeq: number | null;
}

/** Every message a client may send. */
export type ClientToServerMessage =
  | CreateMessage
  | JoinMessage
  | ReadyMessage
  | StartMessage
  | ActionMessage
  | RematchMessage
  | LeaveMessage;

/** Every message only the authoritative server may send. */
export type ServerToClientMessage =
  | RoomStateMessage
  | SnapshotMessage
  | ActionResultMessage
  | EndMessage
  | TimeoutMessage
  | RoomClosedMessage
  | ErrorMessage;

/** Any message on the wire. */
export type OnlineMessage = ClientToServerMessage | ServerToClientMessage;

/** Convenience lookup from a message type to its typed message. */
export interface MessageByType {
  readonly create: CreateMessage;
  readonly join: JoinMessage;
  readonly ready: ReadyMessage;
  readonly start: StartMessage;
  readonly action: ActionMessage;
  readonly rematch: RematchMessage;
  readonly leave: LeaveMessage;
  readonly room_state: RoomStateMessage;
  readonly snapshot: SnapshotMessage;
  readonly action_result: ActionResultMessage;
  readonly end: EndMessage;
  readonly timeout: TimeoutMessage;
  readonly room_closed: RoomClosedMessage;
  readonly error: ErrorMessage;
}

/** The message interface for a message type. */
export type MessageOfType<T extends OnlineMessageType> = MessageByType[T];

/** One field in a `MESSAGE_SPECS` entry. */
export interface MessageFieldSpec {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

/** Runtime description of one protocol message. */
export interface MessageSpec {
  readonly type: OnlineMessageType;
  readonly direction: MessageDirection;
  readonly fields: readonly MessageFieldSpec[];
}

/**
 * Runtime mirror of the `design:protocol` message table.
 *
 * The entries and their field order are part of the contract: clients,
 * servers and tests iterate this table instead of restating field lists.
 */
export const MESSAGE_SPECS: readonly MessageSpec[] = [
  {
    type: 'create',
    direction: 'client-to-server',
    fields: [
      { name: 'requestId', type: 'string', required: true },
      { name: 'protocolVersion', type: 'integer', required: true },
      { name: 'config', type: 'MinesweeperConfig', required: true },
      { name: 'displayName', type: 'string', required: true },
    ],
  },
  {
    type: 'join',
    direction: 'client-to-server',
    fields: [
      { name: 'requestId', type: 'string', required: true },
      { name: 'protocolVersion', type: 'integer', required: true },
      { name: 'roomId', type: 'string', required: true },
      { name: 'playerToken', type: 'string', required: false },
      { name: 'displayName', type: 'string', required: true },
    ],
  },
  {
    type: 'ready',
    direction: 'client-to-server',
    fields: [
      { name: 'roomId', type: 'string', required: true },
      { name: 'requestId', type: 'string', required: true },
      { name: 'ready', type: 'boolean', required: true },
    ],
  },
  {
    type: 'start',
    direction: 'client-to-server',
    fields: [
      { name: 'roomId', type: 'string', required: true },
      { name: 'requestId', type: 'string', required: true },
    ],
  },
  {
    type: 'action',
    direction: 'client-to-server',
    fields: [
      { name: 'roomId', type: 'string', required: true },
      { name: 'matchId', type: 'string', required: true },
      { name: 'actionId', type: 'string', required: true },
      { name: 'seq', type: 'integer', required: true },
      { name: 'turnId', type: 'integer', required: true },
      { name: 'kind', type: 'reveal|flag', required: true },
      { name: 'row', type: 'integer', required: true },
      { name: 'col', type: 'integer', required: true },
      { name: 'clientTimeMs', type: 'integer', required: true },
    ],
  },
  {
    type: 'rematch',
    direction: 'client-to-server',
    fields: [
      { name: 'roomId', type: 'string', required: true },
      { name: 'requestId', type: 'string', required: true },
      { name: 'accept', type: 'boolean', required: true },
    ],
  },
  {
    type: 'leave',
    direction: 'client-to-server',
    fields: [
      { name: 'roomId', type: 'string', required: true },
      { name: 'requestId', type: 'string', required: true },
    ],
  },
  {
    type: 'room_state',
    direction: 'server-to-client',
    fields: [
      { name: 'roomId', type: 'string', required: true },
      { name: 'seq', type: 'integer', required: true },
      { name: 'state', type: 'RoomState', required: true },
      { name: 'hostId', type: 'string', required: true },
      { name: 'capacity', type: 'integer', required: true },
      { name: 'players', type: 'PlayerView[]', required: true },
      { name: 'playerToken', type: 'string', required: false },
      { name: 'config', type: 'MinesweeperConfig', required: true },
      { name: 'matchId', type: 'string|null', required: true },
      { name: 'turnPlayerId', type: 'string|null', required: true },
      { name: 'joinDeadlineAt', type: 'integer', required: true },
      { name: 'deadlineAt', type: 'integer|null', required: true },
      { name: 'stateReason', type: 'string|null', required: true },
    ],
  },
  {
    type: 'snapshot',
    direction: 'server-to-client',
    fields: [
      { name: 'roomId', type: 'string', required: true },
      { name: 'matchId', type: 'string', required: true },
      { name: 'seq', type: 'integer', required: true },
      { name: 'turnPlayerId', type: 'string', required: true },
      { name: 'turnId', type: 'integer', required: true },
      { name: 'seedHash', type: 'string', required: true },
      { name: 'deadlineAt', type: 'integer', required: true },
      { name: 'matchDeadlineAt', type: 'integer', required: true },
      { name: 'elapsedMs', type: 'integer', required: true },
      { name: 'engineStatus', type: 'playing|won|lost', required: true },
      { name: 'mineCount', type: 'integer', required: true },
      { name: 'remainingMines', type: 'integer', required: true },
      { name: 'revealedSafeCount', type: 'integer', required: true },
      { name: 'board', type: 'RedactedBoard', required: true },
    ],
  },
  {
    type: 'action_result',
    direction: 'server-to-client',
    fields: [
      { name: 'roomId', type: 'string', required: true },
      { name: 'matchId', type: 'string', required: true },
      { name: 'actionId', type: 'string', required: true },
      { name: 'seq', type: 'integer', required: true },
      { name: 'turnId', type: 'integer', required: true },
      { name: 'accepted', type: 'boolean', required: true },
      { name: 'reason', type: 'string|null', required: true },
      { name: 'revealedCells', type: 'Cell[]', required: true },
      { name: 'flaggedCell', type: 'Cell|null', required: true },
      { name: 'turnPlayerId', type: 'string', required: true },
      { name: 'deadlineAt', type: 'integer', required: true },
    ],
  },
  {
    type: 'end',
    direction: 'server-to-client',
    fields: [
      { name: 'roomId', type: 'string', required: true },
      { name: 'matchId', type: 'string', required: true },
      { name: 'seq', type: 'integer', required: true },
      { name: 'reason', type: 'match-reason', required: true },
      { name: 'winnerId', type: 'string|null', required: true },
      { name: 'loserId', type: 'string|null', required: true },
      { name: 'finalSnapshot', type: 'RevealedBoard', required: true },
      { name: 'seed', type: 'integer', required: true },
      { name: 'stats', type: 'MatchStats', required: true },
    ],
  },
  {
    type: 'timeout',
    direction: 'server-to-client',
    fields: [
      { name: 'roomId', type: 'string', required: true },
      { name: 'matchId', type: 'string|null', required: true },
      { name: 'seq', type: 'integer', required: true },
      { name: 'timer', type: 'join|turn|match', required: true },
      { name: 'subjectId', type: 'string|null', required: true },
      { name: 'deadlineAt', type: 'integer', required: true },
      { name: 'resultingState', type: 'RoomState', required: true },
      { name: 'reason', type: 'string', required: true },
    ],
  },
  {
    type: 'room_closed',
    direction: 'server-to-client',
    fields: [
      { name: 'roomId', type: 'string', required: true },
      { name: 'seq', type: 'integer', required: true },
      { name: 'reason', type: 'string', required: true },
      { name: 'finalState', type: 'RoomState', required: true },
    ],
  },
  {
    type: 'error',
    direction: 'server-to-client',
    fields: [
      { name: 'requestId', type: 'string|null', required: true },
      { name: 'roomId', type: 'string|null', required: true },
      { name: 'code', type: 'string', required: true },
      { name: 'message', type: 'string', required: true },
      { name: 'retryable', type: 'boolean', required: true },
      { name: 'currentSeq', type: 'integer|null', required: true },
    ],
  },
];

// ---------------------------------------------------------------------------
// Engine adapter contract (implemented by the engine-adapter task)
// ---------------------------------------------------------------------------

/** Input for creating one authoritative match engine. */
export interface CreateMatchInput {
  readonly matchId: string;
  readonly config: MinesweeperConfig;
  readonly seed: number;
}

/**
 * Server-side handle for one match. The seed and the authoritative snapshot
 * are secret until `end`: this handle must never reach a client.
 */
export interface EngineMatch {
  readonly matchId: string;
  readonly config: MinesweeperConfig;
  readonly seed: number;
  readonly seedHash: string;
  readonly state: MinesweeperSnapshot;
}

/** One accepted engine step. */
export interface EngineActionResult {
  readonly revealedCells: readonly Cell[];
  readonly flaggedCell: Cell | null;
  readonly status: MinesweeperStatus;
}

/**
 * Server-side adapter over the pure rules engine. It creates match engines,
 * applies accepted actions, projects redacted snapshots, expands the final
 * board and records/replays the ordered action log.
 */
export interface EngineAdapter {
  /** Create the authoritative engine for a match with a server-chosen seed. */
  createMatch(input: CreateMatchInput): EngineMatch;
  /** Apply one accepted reveal or flag to the match engine. */
  applyAction(match: EngineMatch, action: ReplayAction): EngineActionResult;
  /** Project the current engine state into a client-safe snapshot. */
  projectSnapshot(match: EngineMatch): RedactedSnapshot;
  /** Return the end-only board with every mine position expanded. */
  expandEndBoard(match: EngineMatch): RevealedBoard;
  /** Append an accepted action to the match replay log, ordered by `seq`. */
  recordAction(match: EngineMatch, action: ReplayAction): void;
  /** Export the replay input recorded for this match. */
  getReplayRecord(match: EngineMatch): ReplayRecord;
  /** Re-run a replay record and return one digest per replayed action. */
  replay(record: ReplayRecord): readonly ReplayDigest[];
}

// ---------------------------------------------------------------------------
// Protocol validator contract (implemented by the protocol task)
// ---------------------------------------------------------------------------

/** Outcome of one protocol check: a value, or a rejection with an error code. */
export type ProtocolResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ProtocolErrorCode; readonly message: string };

/** Whether an `actionId` is new or a retry that must reuse a cached result. */
export type ActionIdStatus = 'fresh' | 'duplicate';

/** Server-side facts needed to validate one submitted action. */
export interface ActionValidationContext {
  readonly actorId: string;
  readonly turnPlayerId: string;
  readonly currentSeq: number;
  readonly currentTurnId: number;
  readonly deadlineAt: number;
  readonly nowMs: number;
  readonly recentActionIds: ReadonlySet<string>;
  readonly rows: number;
  readonly cols: number;
  readonly cellState: (row: number, col: number) => 'hidden' | 'revealed' | 'flagged';
}

/**
 * Shared validation contract for decoded protocol messages and for the
 * `seq`/`turnId`/`actionId` gates applied to an action.
 */
export interface ProtocolValidator {
  /** Validate a decoded message against `MESSAGE_SPECS` and its direction. */
  validateMessage(input: unknown, direction: MessageDirection): ProtocolResult<OnlineMessage>;
  /** Reject a client that does not speak `PROTOCOL_VERSION`. */
  validateVersion(protocolVersion: number): ProtocolResult<number>;
  /** Accept only the last seq the client has applied; older input is stale. */
  checkSeq(currentSeq: number, receivedSeq: number): ProtocolResult<number>;
  /** Accept only the current turn id; a mismatch is stale input. */
  checkTurnId(currentTurnId: number, receivedTurnId: number): ProtocolResult<number>;
  /** Classify an action id so retries reuse the cached result. */
  classifyActionId(actionId: string, recentActionIds: ReadonlySet<string>): ActionIdStatus;
  /** Run the full action gate and return the accepted action. */
  validateAction(
    action: ActionMessage,
    context: ActionValidationContext,
  ): ProtocolResult<ActionMessage>;
}
