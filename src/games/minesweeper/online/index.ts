/**
 * Public entry point for online Minesweeper.
 *
 * The server, the client and the tests import the online contract from this
 * module only. The sibling modules stay internal: `types.ts` owns every shared
 * DTO and the `MESSAGE_SPECS` table, `adapter.ts` implements the engine adapter
 * and `protocol.ts` implements the runtime validator. This file only re-exports
 * that surface, so it cannot become a second DTO layer.
 */

export type {
  ActionIdStatus,
  ActionResultMessage,
  ActionKind,
  ActionMessage,
  ActionValidationContext,
  ClientMessageType,
  ClientToServerMessage,
  CreateMatchInput,
  CreateMessage,
  EndMessage,
  EngineActionResult,
  EngineAdapter,
  EngineMatch,
  ErrorMessage,
  JoinMessage,
  LeaveMessage,
  MatchEndPayload,
  MatchEndReason,
  MatchStats,
  MessageByType,
  MessageDirection,
  MessageFieldSpec,
  MessageOfType,
  MessageSpec,
  OnlineMessage,
  OnlineMessageType,
  PlayerPresence,
  PlayerView,
  ProtocolErrorCode,
  ProtocolResult,
  ProtocolValidator,
  ReadyMessage,
  RedactedBoard,
  RedactedCell,
  RedactedSnapshot,
  RematchMessage,
  ReplayAction,
  ReplayDigest,
  ReplayRecord,
  RevealedBoard,
  RevealedCell,
  RoomClosedMessage,
  RoomState,
  RoomStateMessage,
  ServerMessageType,
  ServerToClientMessage,
  SnapshotEngineStatus,
  SnapshotMessage,
  StartMessage,
  TimeoutMessage,
  TimeoutTimer,
} from './types';
export {
  MESSAGE_SPECS,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_VERSION,
} from './types';

export type { EndPayloadInput, ReplayOutcome } from './adapter';
export {
  createMatchEngine,
  endPayload,
  engineAdapter,
  hashSeed,
  matchDigest,
  ReplayMismatchError,
  replayMatch,
} from './adapter';

export type {
  ActionGate,
  ProtocolErrorOptions,
  ProtocolValidation,
  ProtocolValidationFailure,
} from './protocol';
export {
  checkSeq,
  checkTurnId,
  classifyActionId,
  createProtocolError,
  createProtocolValidator,
  evaluateAction,
  protocolErrorFromResult,
  protocolValidator,
  validateAction,
  validateClientMessage,
  validateMessage,
  validateServerMessage,
  validateVersion,
} from './protocol';
