/**
 * Runtime validation for the online Minesweeper wire protocol.
 *
 * `types.ts` owns the DTOs and the `MESSAGE_SPECS` table; this module turns
 * that table into a pure validator, gates submitted actions on
 * `seq`/`turnId`/`actionId` and exposes the one constructor for protocol
 * `error` messages. It keeps no state and never touches a room or board
 * object, so rejecting a message cannot consume a turn or change a match.
 */

import { MESSAGE_SPECS, PROTOCOL_VERSION } from './types';
import type {
  ActionIdStatus,
  ActionMessage,
  ActionValidationContext,
  ClientToServerMessage,
  ErrorMessage,
  MessageDirection,
  MessageFieldSpec,
  MessageSpec,
  OnlineMessage,
  ProtocolErrorCode,
  ProtocolResult,
  ProtocolValidator,
  ServerToClientMessage,
} from './types';

const ACTION_KINDS = ['reveal', 'flag'] as const;
const ROOM_STATES = ['idle', 'waiting', 'ready', 'playing', 'finished', 'dissolved'] as const;
const SNAPSHOT_STATUSES = ['playing', 'won', 'lost'] as const;
const MATCH_END_REASONS = [
  'mine-hit',
  'all-safe-revealed',
  'forfeit',
  'turn-timeout',
  'match-timeout',
] as const;
const TIMEOUT_TIMERS = ['join', 'turn', 'match'] as const;
const PROTOCOL_ERROR_CODES = [
  'unsupported-version',
  'room-not-found',
  'not-your-turn',
  'stale-state',
  'invalid-action',
  'deadline-passed',
  'bad-request',
] as const;

/**
 * A rejected check. It carries the wire error fields a room service needs:
 * `retryable` and `currentSeq` make it possible to build an `error` message
 * without a second lookup. `currentSeq` is `null` when the check has no
 * authoritative sequence to report.
 */
export interface ProtocolValidationFailure {
  readonly ok: false;
  readonly code: ProtocolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly currentSeq: number | null;
}

/** Result of a protocol check: the accepted value, or a structured rejection. */
export type ProtocolValidation<T> =
  | { readonly ok: true; readonly value: T }
  | ProtocolValidationFailure;

/** Outcome of one action gate. A duplicate retry must reuse its cached result. */
export type ActionGate =
  | { readonly ok: true; readonly status: 'fresh'; readonly action: ActionMessage }
  | { readonly ok: true; readonly status: 'duplicate'; readonly action: ActionMessage }
  | ProtocolValidationFailure;

/** The one place that defines the wire defaults for each protocol error code. */
const ERROR_DEFAULTS: Readonly<
  Record<ProtocolErrorCode, { readonly message: string; readonly retryable: boolean }>
> = {
  'unsupported-version': {
    message: 'unsupported protocol version',
    retryable: false,
  },
  'room-not-found': { message: 'room not found', retryable: false },
  'not-your-turn': { message: 'it is not your turn', retryable: false },
  'stale-state': { message: 'stale state; resync and retry', retryable: true },
  'invalid-action': { message: 'invalid action', retryable: false },
  'deadline-passed': { message: 'the deadline has passed', retryable: false },
  'bad-request': { message: 'bad request', retryable: false },
};

function failure(
  code: ProtocolErrorCode,
  message: string,
  currentSeq: number | null = null,
): ProtocolValidationFailure {
  return {
    ok: false,
    code,
    message,
    retryable: ERROR_DEFAULTS[code].retryable,
    currentSeq,
  };
}

/** Optional fields for the shared `error` message constructor. */
export interface ProtocolErrorOptions {
  readonly requestId?: string | null;
  readonly roomId?: string | null;
  readonly message?: string;
  readonly retryable?: boolean;
  readonly currentSeq?: number | null;
}

/**
 * Build a wire `error` message from the shared defaults and per-request facts.
 * Room services reuse this instead of assembling ad-hoc error payloads.
 */
export function createProtocolError(
  code: ProtocolErrorCode,
  options: ProtocolErrorOptions = {},
): ErrorMessage {
  const defaults = ERROR_DEFAULTS[code];
  return {
    type: 'error',
    requestId: options.requestId ?? null,
    roomId: options.roomId ?? null,
    code,
    message: options.message ?? defaults.message,
    retryable: options.retryable ?? defaults.retryable,
    currentSeq: options.currentSeq ?? null,
  };
}

/**
 * Convert a rejected check into a wire `error` message, keeping the check's
 * message/retryable/currentSeq unless the caller explicitly overrides them.
 */
export function protocolErrorFromResult(
  result: ProtocolValidationFailure,
  options: ProtocolErrorOptions = {},
): ErrorMessage {
  return createProtocolError(result.code, {
    requestId: options.requestId ?? null,
    roomId: options.roomId ?? null,
    message: options.message ?? result.message,
    retryable: options.retryable ?? result.retryable,
    currentSeq: options.currentSeq === undefined ? result.currentSeq : options.currentSeq,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function checkString(value: unknown, path: string): string | null {
  return typeof value === 'string' ? null : `${path} must be a string (got ${describeValue(value)})`;
}

function checkInteger(value: unknown, path: string): string | null {
  return Number.isSafeInteger(value)
    ? null
    : `${path} must be an integer (got ${describeValue(value)})`;
}

function checkBoolean(value: unknown, path: string): string | null {
  return typeof value === 'boolean'
    ? null
    : `${path} must be a boolean (got ${describeValue(value)})`;
}

function checkOneOf(values: readonly string[], value: unknown, path: string): string | null {
  if (typeof value === 'string' && values.includes(value)) {
    return null;
  }
  return `${path} must be one of ${values.join('|')} (got ${describeValue(value)})`;
}

function checkArray(
  value: unknown,
  path: string,
  checkItem: (item: unknown, itemPath: string) => string | null,
): string | null {
  if (!Array.isArray(value)) {
    return `${path} must be an array (got ${describeValue(value)})`;
  }
  for (let index = 0; index < value.length; index += 1) {
    const problem = checkItem(value[index], `${path}[${index}]`);
    if (problem !== null) {
      return problem;
    }
  }
  return null;
}

interface ShapeField {
  readonly name: string;
  readonly check: (value: unknown, path: string) => string | null;
}

function checkObjectShape(
  value: unknown,
  path: string,
  fields: readonly ShapeField[],
): string | null {
  if (!isRecord(value)) {
    return `${path} must be an object (got ${describeValue(value)})`;
  }
  for (const field of fields) {
    const fieldPath = `${path}.${field.name}`;
    const fieldValue = value[field.name];
    if (fieldValue === undefined) {
      return `${fieldPath} is required`;
    }
    const problem = field.check(fieldValue, fieldPath);
    if (problem !== null) {
      return problem;
    }
  }
  return null;
}

function checkBoard(
  value: unknown,
  path: string,
  checkCell: (cell: unknown, cellPath: string) => string | null,
): string | null {
  return checkArray(value, path, (row, rowPath) => checkArray(row, rowPath, checkCell));
}

const CONFIG_FIELDS: readonly ShapeField[] = [
  { name: 'rows', check: checkInteger },
  { name: 'cols', check: checkInteger },
  { name: 'mines', check: checkInteger },
  { name: 'firstClickSafe', check: checkBoolean },
];

const PLAYER_FIELDS: readonly ShapeField[] = [
  { name: 'playerId', check: checkString },
  { name: 'displayName', check: checkString },
  { name: 'ready', check: checkBoolean },
  {
    name: 'presence',
    check: (value, path) => checkOneOf(['online', 'reconnecting', 'offline'], value, path),
  },
  { name: 'isHost', check: checkBoolean },
];

const CELL_FIELDS: readonly ShapeField[] = [
  { name: 'row', check: checkInteger },
  { name: 'col', check: checkInteger },
];

const REDACTED_CELL_FIELDS: readonly ShapeField[] = [
  ...CELL_FIELDS,
  { name: 'revealed', check: checkBoolean },
  { name: 'flagged', check: checkBoolean },
  { name: 'adjacentMines', check: checkInteger },
];

const REVEALED_CELL_FIELDS: readonly ShapeField[] = [
  ...CELL_FIELDS,
  { name: 'mine', check: checkBoolean },
  { name: 'revealed', check: checkBoolean },
  { name: 'flagged', check: checkBoolean },
  { name: 'adjacentMines', check: checkInteger },
];

const MATCH_STATS_FIELDS: readonly ShapeField[] = [
  { name: 'turnCount', check: checkInteger },
  { name: 'revealedSafeCount', check: checkInteger },
  { name: 'flagsPlaced', check: checkInteger },
  { name: 'durationMs', check: checkInteger },
];

function checkCell(value: unknown, path: string): string | null {
  return checkObjectShape(value, path, CELL_FIELDS);
}

function checkRedactedCell(value: unknown, path: string): string | null {
  const problem = checkObjectShape(value, path, REDACTED_CELL_FIELDS);
  if (problem !== null) {
    return problem;
  }
  if (isRecord(value) && 'mine' in value) {
    return `${path}.mine must not appear in a redacted cell`;
  }
  return null;
}

function checkRevealedCell(value: unknown, path: string): string | null {
  return checkObjectShape(value, path, REVEALED_CELL_FIELDS);
}

function checkPlayerView(value: unknown, path: string): string | null {
  return checkObjectShape(value, path, PLAYER_FIELDS);
}

function checkMatchStats(value: unknown, path: string): string | null {
  return checkObjectShape(value, path, MATCH_STATS_FIELDS);
}

/** Validate one value against the nominal field type used by `MESSAGE_SPECS`. */
function checkNominalType(type: string, value: unknown, path: string): string | null {
  switch (type) {
    case 'string':
      return checkString(value, path);
    case 'integer':
      return checkInteger(value, path);
    case 'boolean':
      return checkBoolean(value, path);
    case 'string|null':
      return value === null ? null : checkString(value, path);
    case 'integer|null':
      return value === null ? null : checkInteger(value, path);
    case 'reveal|flag':
      return checkOneOf(ACTION_KINDS, value, path);
    case 'RoomState':
      return checkOneOf(ROOM_STATES, value, path);
    case 'playing|won|lost':
      return checkOneOf(SNAPSHOT_STATUSES, value, path);
    case 'match-reason':
      return checkOneOf(MATCH_END_REASONS, value, path);
    case 'join|turn|match':
      return checkOneOf(TIMEOUT_TIMERS, value, path);
    case 'MinesweeperConfig':
      return checkObjectShape(value, path, CONFIG_FIELDS);
    case 'PlayerView[]':
      return checkArray(value, path, checkPlayerView);
    case 'RedactedBoard':
      return checkBoard(value, path, checkRedactedCell);
    case 'RevealedBoard':
      return checkBoard(value, path, checkRevealedCell);
    case 'Cell[]':
      return checkArray(value, path, checkCell);
    case 'Cell|null':
      return value === null ? null : checkCell(value, path);
    case 'MatchStats':
      return checkMatchStats(value, path);
    default:
      // Fail closed if `MESSAGE_SPECS` gains a type this validator cannot check.
      return `${path} uses unsupported field type "${type}"`;
  }
}

function checkFieldValue(
  spec: MessageSpec,
  field: MessageFieldSpec,
  value: unknown,
): string | null {
  const path = `${spec.type}.${field.name}`;
  if (spec.type === 'error' && field.name === 'code') {
    // `design:protocol` types this field as a plain string; the shared
    // `ProtocolErrorCode` union is the authoritative runtime set.
    return checkOneOf(PROTOCOL_ERROR_CODES, value, path);
  }
  return checkNominalType(field.type, value, path);
}

function checkFields(
  message: Readonly<Record<string, unknown>>,
  spec: MessageSpec,
): string | null {
  for (const field of spec.fields) {
    const value = message[field.name];
    if (value === undefined) {
      if (field.required) {
        return `missing required field "${field.name}" for "${spec.type}"`;
      }
      continue;
    }
    const problem = checkFieldValue(spec, field, value);
    if (problem !== null) {
      return problem;
    }
  }
  return null;
}

/** Reject a client that does not speak the pinned protocol version. */
export function validateVersion(protocolVersion: number): ProtocolValidation<number> {
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion !== PROTOCOL_VERSION) {
    return failure(
      'unsupported-version',
      `unsupported protocol version ${String(protocolVersion)}; expected ${PROTOCOL_VERSION}`,
    );
  }
  return { ok: true, value: protocolVersion };
}

/**
 * Accept only the sequence the client last applied, which must equal the
 * server's current sequence. Older (and unissued newer) input is stale.
 */
export function checkSeq(currentSeq: number, receivedSeq: number): ProtocolValidation<number> {
  if (
    !Number.isSafeInteger(currentSeq) ||
    !Number.isSafeInteger(receivedSeq) ||
    receivedSeq !== currentSeq
  ) {
    return failure(
      'stale-state',
      `stale seq ${String(receivedSeq)}; current seq is ${String(currentSeq)}`,
      Number.isSafeInteger(currentSeq) ? currentSeq : null,
    );
  }
  return { ok: true, value: receivedSeq };
}

/** Accept only the current turn; a mismatch is stale input. */
export function checkTurnId(
  currentTurnId: number,
  receivedTurnId: number,
): ProtocolValidation<number> {
  if (
    !Number.isSafeInteger(currentTurnId) ||
    !Number.isSafeInteger(receivedTurnId) ||
    receivedTurnId !== currentTurnId
  ) {
    return failure(
      'stale-state',
      `stale turnId ${String(receivedTurnId)}; current turnId is ${String(currentTurnId)}`,
    );
  }
  return { ok: true, value: receivedTurnId };
}

/** Classify an action id so a retry reuses the cached result instead of applying. */
export function classifyActionId(
  actionId: string,
  recentActionIds: ReadonlySet<string>,
): ActionIdStatus {
  return recentActionIds.has(actionId) ? 'duplicate' : 'fresh';
}

/**
 * Run the full action gate without applying anything.
 *
 * A duplicate `actionId` wins over sequence checks: it is a retry, so the
 * server must return the cached `action_result` and must not apply the action
 * again. Every rejection leaves the caller's state untouched; the gate only
 * reads the supplied context.
 */
export function evaluateAction(
  action: ActionMessage,
  context: ActionValidationContext,
): ActionGate {
  if (classifyActionId(action.actionId, context.recentActionIds) === 'duplicate') {
    return { ok: true, status: 'duplicate', action };
  }

  if (context.actorId !== context.turnPlayerId) {
    return failure(
      'not-your-turn',
      `player ${context.actorId} cannot act while it is ${context.turnPlayerId}'s turn`,
      context.currentSeq,
    );
  }

  const seq = checkSeq(context.currentSeq, action.seq);
  if (!seq.ok) {
    return seq;
  }

  const turnId = checkTurnId(context.currentTurnId, action.turnId);
  if (!turnId.ok) {
    return { ...turnId, currentSeq: context.currentSeq };
  }

  if (context.nowMs >= context.deadlineAt) {
    return failure(
      'deadline-passed',
      `action arrived at ${context.nowMs}, after the turn deadline ${context.deadlineAt}`,
      context.currentSeq,
    );
  }

  if (action.kind !== 'reveal' && action.kind !== 'flag') {
    return failure(
      'invalid-action',
      `unknown action kind ${String(action.kind)}`,
      context.currentSeq,
    );
  }

  if (!Number.isSafeInteger(action.row) || !Number.isSafeInteger(action.col)) {
    return failure('invalid-action', 'action coordinates must be integers', context.currentSeq);
  }

  if (
    action.row < 0 ||
    action.col < 0 ||
    action.row >= context.rows ||
    action.col >= context.cols
  ) {
    return failure(
      'invalid-action',
      `action (${action.row}, ${action.col}) is outside the ${context.rows}x${context.cols} board`,
      context.currentSeq,
    );
  }

  const cellState = context.cellState(action.row, action.col);
  if (cellState !== 'hidden') {
    return failure(
      'invalid-action',
      `cell (${action.row}, ${action.col}) is ${cellState}`,
      context.currentSeq,
    );
  }

  return { ok: true, status: 'fresh', action };
}

/**
 * Shared-interface action gate. It mirrors `evaluateAction` but collapses the
 * richer outcome into `ProtocolResult`: a fresh action is accepted, while a
 * duplicate is rejected with `stale-state` so a caller that ignores
 * `classifyActionId`/`evaluateAction` can never apply a retry twice. Callers
 * that want the cached-response semantics must classify the action id first.
 */
export function validateAction(
  action: ActionMessage,
  context: ActionValidationContext,
): ProtocolValidation<ActionMessage> {
  const gate = evaluateAction(action, context);
  if (gate.ok) {
    if (gate.status === 'duplicate') {
      return failure(
        'stale-state',
        `duplicate actionId ${action.actionId}; reuse the cached action_result`,
        context.currentSeq,
      );
    }
    return { ok: true, value: gate.action };
  }
  return gate;
}

/** Validate a decoded message against `MESSAGE_SPECS` and its direction. */
export function validateMessage<M extends OnlineMessage>(
  input: unknown,
  direction: MessageDirection,
): ProtocolValidation<M> {
  if (!isRecord(input)) {
    return failure('bad-request', `message must be an object (got ${describeValue(input)})`);
  }

  const type = input['type'];
  if (typeof type !== 'string') {
    return failure('bad-request', `message.type must be a string (got ${describeValue(type)})`);
  }

  const spec = MESSAGE_SPECS.find((candidate) => candidate.type === type);
  if (spec === undefined) {
    return failure('bad-request', `unknown message type "${type}"`);
  }

  if (spec.direction !== direction) {
    return failure(
      'bad-request',
      `message "${type}" is ${spec.direction}, not ${direction}`,
    );
  }

  const fieldsProblem = checkFields(input, spec);
  if (fieldsProblem !== null) {
    return failure('bad-request', fieldsProblem);
  }

  if (spec.fields.some((field) => field.name === 'protocolVersion')) {
    const version = validateVersion(input['protocolVersion'] as number);
    if (!version.ok) {
      return version;
    }
  }

  return { ok: true, value: input as unknown as M };
}

/** Validate a message a client may send. */
export function validateClientMessage(
  input: unknown,
): ProtocolValidation<ClientToServerMessage> {
  return validateMessage<ClientToServerMessage>(input, 'client-to-server');
}

/** Validate a message only the authoritative server may send. */
export function validateServerMessage(
  input: unknown,
): ProtocolValidation<ServerToClientMessage> {
  return validateMessage<ServerToClientMessage>(input, 'server-to-client');
}

function toProtocolResult<T>(result: ProtocolValidation<T>): ProtocolResult<T> {
  return result.ok ? result : { ok: false, code: result.code, message: result.message };
}

/** Build the shared validator; the contract methods stay stateless. */
export function createProtocolValidator(): ProtocolValidator {
  return {
    validateMessage: (input, direction) =>
      toProtocolResult(validateMessage<OnlineMessage>(input, direction)),
    validateVersion: (protocolVersion) => toProtocolResult(validateVersion(protocolVersion)),
    checkSeq: (currentSeq, receivedSeq) => toProtocolResult(checkSeq(currentSeq, receivedSeq)),
    checkTurnId: (currentTurnId, receivedTurnId) =>
      toProtocolResult(checkTurnId(currentTurnId, receivedTurnId)),
    classifyActionId,
    validateAction: (action, context) => toProtocolResult(validateAction(action, context)),
  };
}

/** Stateless shared validator instance. */
export const protocolValidator: ProtocolValidator = createProtocolValidator();
