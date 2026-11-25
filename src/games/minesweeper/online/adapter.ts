/**
 * Server-side engine adapter for online Minesweeper.
 *
 * The adapter binds the pure rules engine to one authoritative match without
 * changing how mines are placed: the server-chosen config and seed are
 * injected into `MinesweeperEngine` through `createSeededRng`, so the first
 * reveal still plants the mines and the first-click safe zone is untouched.
 *
 * Only the redacted projection may leave the server. It carries `seedHash`, a
 * `sha256(String(seed))` commitment, and never a hidden cell's `mine` flag or
 * adjacent count. `expandEndBoard` and `endPayload` are the only functions
 * that expose every mine and the seed itself; the caller must invoke them
 * only when the match really ended.
 *
 * This module is server-only (it uses Node's crypto) and has no DOM, timer or
 * storage dependency, so replays run unchanged in Node.
 */

import { createHash } from 'node:crypto';
import {
  createSeededRng,
  MinesweeperEngine,
  validateConfig,
  type MinesweeperConfig,
  type MinesweeperStatus,
} from '../engine';
import type {
  CreateMatchInput,
  EngineAdapter,
  EngineActionResult,
  EngineMatch,
  MatchEndPayload,
  MatchEndReason,
  MatchStats,
  RedactedCell,
  RedactedSnapshot,
  ReplayAction,
  ReplayDigest,
  ReplayRecord,
  RevealedBoard,
  SnapshotEngineStatus,
} from './types';

/** Mutable server state kept out of the frozen client-invisible handle. */
interface MatchRuntime {
  readonly engine: MinesweeperEngine;
  /** Accepted actions in strictly increasing `seq` order. */
  readonly actions: ReplayAction[];
}

/** One match's engine and replay log, keyed by the opaque server handle. */
const MATCH_RUNTIMES = new WeakMap<EngineMatch, MatchRuntime>();

/** One end-only input; stats are decided by the room layer. */
export interface EndPayloadInput {
  readonly reason: MatchEndReason;
  readonly winnerId: string | null;
  readonly loserId: string | null;
  readonly stats: MatchStats;
}

/** Result of a verified replay. */
export interface ReplayOutcome {
  /** One digest per replayed action, in `seq` order. */
  readonly digests: readonly ReplayDigest[];
  /** Digest of the final state; the empty record reports `seq` 0. */
  readonly finalDigest: ReplayDigest;
  /** Engine status after the last replayed action. */
  readonly status: MinesweeperStatus;
}

/** Replay stopped because a step did not match the recorded digest. */
export class ReplayMismatchError extends Error {
  readonly seq: number;

  constructor(seq: number, detail: string) {
    super(`Replay mismatch at seq ${seq}: ${detail}`);
    this.name = 'ReplayMismatchError';
    this.seq = seq;
  }
}

/** Render an untrusted value in an error without losing its identity. */
function formatValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** Seeds are integers so `String(seed)` and `mulberry32` stay reproducible. */
function assertSeed(seed: number): number {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError(`seed must be a safe integer, received ${formatValue(seed)}.`);
  }
  return seed;
}

/** Lowercase SHA-256 hex of a UTF-8 string. */
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Public seed commitment: the lowercase hex SHA-256 of the decimal seed.
 *
 * The client only ever receives this value before `end`; hashing the decimal
 * spelling keeps the commitment stable across JSON transports.
 */
export function hashSeed(seed: number): string {
  return sha256(String(assertSeed(seed)));
}

/**
 * Create the authoritative engine for one match.
 *
 * `validateConfig` runs first, then the engine receives the validated config
 * and a deterministic `createSeededRng(seed)` source. The engine still plants
 * mines on the first reveal, so the default board, first-click safety and
 * placement timing stay exactly those of `engine.ts`.
 */
export function createMatchEngine(
  config: MinesweeperConfig,
  seed: number,
): MinesweeperEngine {
  const validated = validateConfig(config);
  return new MinesweeperEngine({
    config: validated,
    rng: createSeededRng(assertSeed(seed)),
  });
}

/** Map the engine lifecycle onto the public snapshot status. */
function toSnapshotStatus(status: MinesweeperStatus): SnapshotEngineStatus {
  // A created match is already in progress from the protocol's point of view.
  return status === 'ready' ? 'playing' : status;
}

/**
 * Project an engine snapshot without leaking hidden information.
 *
 * Revealed cells keep their real `adjacentMines`; every other cell reports 0,
 * because the count would otherwise narrow down where the mines sit.
 */
function projectEngineSnapshot(
  engine: MinesweeperEngine,
  seedHash: string,
): RedactedSnapshot {
  const snapshot = engine.state;
  let revealedSafeCount = 0;
  const board = snapshot.board.map((row) =>
    row.map((cell): RedactedCell => {
      if (cell.revealed && !cell.mine) {
        revealedSafeCount += 1;
      }
      return {
        row: cell.row,
        col: cell.col,
        revealed: cell.revealed,
        flagged: cell.flagged,
        adjacentMines: cell.revealed ? cell.adjacentMines : 0,
      };
    }),
  );

  return {
    seedHash,
    engineStatus: toSnapshotStatus(snapshot.status),
    mineCount: snapshot.mineCount,
    remainingMines: snapshot.remainingMines,
    revealedSafeCount,
    elapsedMs: snapshot.elapsedMs,
    board,
  };
}

/**
 * Canonical serialization for a redacted snapshot hash.
 *
 * Elapsed time is deliberately excluded: the replay input is config, seed and
 * ordered actions, so wall-clock state is neither reproducible nor relevant to
 * the board comparison.
 */
function hashRedactedSnapshot(snapshot: RedactedSnapshot): string {
  const cells = snapshot.board
    .map((row) =>
      row
        .map((cell) =>
          [
            cell.row,
            cell.col,
            cell.revealed,
            cell.flagged,
            cell.adjacentMines,
          ].join(','),
        )
        .join(';'),
    )
    .join('|');
  return sha256(
    [
      `seedHash=${snapshot.seedHash}`,
      `engineStatus=${snapshot.engineStatus}`,
      `mineCount=${snapshot.mineCount}`,
      `remainingMines=${snapshot.remainingMines}`,
      `revealedSafeCount=${snapshot.revealedSafeCount}`,
      `board=${cells}`,
    ].join('\n'),
  );
}

/** Digest of the current engine state at one replayed step. */
function digestState(
  engine: MinesweeperEngine,
  seq: number,
  turnId: number,
  seedHash: string,
): ReplayDigest {
  const snapshot = projectEngineSnapshot(engine, seedHash);
  return {
    seq,
    turnId,
    engineStatus: snapshot.engineStatus,
    revealedSafeCount: snapshot.revealedSafeCount,
    remainingMines: snapshot.remainingMines,
    snapshotHash: hashRedactedSnapshot(snapshot),
  };
}

/**
 * Digest one step of the live match after an accepted action.
 *
 * The room layer samples this while it applies actions, so the replay log
 * carries expectations measured from the original match instead of a second
 * run of `replayMatch` over the same config and seed. A replay that rebuilds
 * the board from the wrong config or seed then fails at the first differing
 * step.
 */
export function matchDigest(
  match: EngineMatch,
  seq: number,
  turnId: number,
): ReplayDigest {
  const runtime = runtimeFor(match);
  return digestState(runtime.engine, seq, turnId, match.seedHash);
}

function assertActionFields(action: ReplayAction, label: string): void {
  if (action === null || typeof action !== 'object') {
    throw new TypeError(`${label} must be an object, received ${formatValue(action)}.`);
  }
  if (!Number.isSafeInteger(action.seq) || action.seq < 1) {
    throw new RangeError(
      `${label}.seq must be a positive integer, received ${formatValue(action.seq)}.`,
    );
  }
  if (!Number.isSafeInteger(action.turnId) || action.turnId < 0) {
    throw new RangeError(
      `${label}.turnId must be a non-negative integer, received ${formatValue(action.turnId)}.`,
    );
  }
  if (typeof action.actionId !== 'string' || action.actionId.length === 0) {
    throw new TypeError(`${label}.actionId must be a non-empty string.`);
  }
  if (action.kind !== 'reveal' && action.kind !== 'flag') {
    throw new TypeError(
      `${label}.kind must be "reveal" or "flag", received ${formatValue(action.kind)}.`,
    );
  }
  if (!Number.isSafeInteger(action.row) || !Number.isSafeInteger(action.col)) {
    throw new RangeError(
      `${label} coordinates must be integers, received (${formatValue(action.row)}, ${formatValue(action.col)}).`,
    );
  }
}

function assertActionInBounds(
  action: ReplayAction,
  config: MinesweeperConfig,
  label: string,
): void {
  if (
    action.row < 0 ||
    action.col < 0 ||
    action.row >= config.rows ||
    action.col >= config.cols
  ) {
    throw new RangeError(
      `${label} is out of bounds: (${action.row}, ${action.col}) on a ${config.rows}x${config.cols} board.`,
    );
  }
}

/**
 * Apply one accepted action to an engine with explicit errors.
 *
 * The room layer validates turn ownership and timing; this layer still rejects
 * anything the engine would silently ignore (out-of-bounds cells, revealing a
 * flagged cell, flagging a revealed cell, actions after the match ended) so a
 * diverging action log cannot be recorded as accepted.
 */
function applyToEngine(
  engine: MinesweeperEngine,
  config: MinesweeperConfig,
  action: ReplayAction,
): EngineActionResult {
  assertActionFields(action, 'action');
  assertActionInBounds(action, config, `action at seq ${action.seq}`);

  const status = engine.currentStatus;
  if (status === 'won' || status === 'lost') {
    throw new Error(
      `action at seq ${action.seq} cannot be applied: the match already ended (${status}).`,
    );
  }

  if (action.kind === 'reveal') {
    const result = engine.reveal(action.row, action.col);
    if (result.revealed.length === 0) {
      throw new Error(
        `action at seq ${action.seq} is invalid: cell (${action.row}, ${action.col}) is already revealed or flagged.`,
      );
    }
    return {
      revealedCells: result.revealed,
      flaggedCell: null,
      status: result.status,
    };
  }

  const result = engine.toggleFlag(action.row, action.col);
  if (!result.changed) {
    throw new Error(
      `action at seq ${action.seq} is invalid: cell (${action.row}, ${action.col}) cannot be flagged.`,
    );
  }
  return {
    revealedCells: [],
    flaggedCell: { row: action.row, col: action.col },
    status: result.status,
  };
}

function runtimeFor(match: EngineMatch): MatchRuntime {
  const runtime = MATCH_RUNTIMES.get(match);
  if (runtime === undefined) {
    throw new TypeError(
      `Unknown engine match ${formatValue(match.matchId)}: it was not created by this adapter.`,
    );
  }
  return runtime;
}

function createMatch(input: CreateMatchInput): EngineMatch {
  if (typeof input.matchId !== 'string' || input.matchId.length === 0) {
    throw new TypeError('matchId must be a non-empty string.');
  }
  const config = validateConfig(input.config);
  const seed = assertSeed(input.seed);
  const engine = createMatchEngine(config, seed);
  const seedHash = hashSeed(seed);

  const match: EngineMatch = {
    matchId: input.matchId,
    config,
    seed,
    seedHash,
    get state() {
      return engine.state;
    },
  };
  MATCH_RUNTIMES.set(match, { engine, actions: [] });
  return Object.freeze(match);
}

function applyAction(match: EngineMatch, action: ReplayAction): EngineActionResult {
  const runtime = runtimeFor(match);
  return applyToEngine(runtime.engine, match.config, action);
}

/**
 * Advance the authoritative clock for one match.
 *
 * Delegating to `MinesweeperEngine.tick` keeps the single-player freeze rules:
 * the clock runs only while playing and an invalid delta throws. Because the
 * redacted snapshot reads `engine.state.elapsedMs`, both broadcasts and
 * reconnect snapshots then carry the real match duration.
 */
function tick(match: EngineMatch, deltaMs: number): number {
  const runtime = runtimeFor(match);
  return runtime.engine.tick(deltaMs);
}

function projectSnapshot(match: EngineMatch): RedactedSnapshot {
  const runtime = runtimeFor(match);
  return projectEngineSnapshot(runtime.engine, match.seedHash);
}

function expandEndBoard(match: EngineMatch): RevealedBoard {
  const runtime = runtimeFor(match);
  return runtime.engine.state.board.map((row) =>
    row.map((cell) => ({
      row: cell.row,
      col: cell.col,
      mine: cell.mine,
      revealed: cell.revealed,
      flagged: cell.flagged,
      adjacentMines: cell.adjacentMines,
    })),
  );
}

function recordAction(match: EngineMatch, action: ReplayAction): void {
  const runtime = runtimeFor(match);
  assertActionFields(action, 'action');
  assertActionInBounds(action, match.config, `action at seq ${action.seq}`);

  const lastSeq = runtime.actions.at(-1)?.seq ?? 0;
  if (action.seq <= lastSeq) {
    throw new RangeError(
      `action seq ${action.seq} must be greater than the last recorded seq ${lastSeq} for match ${formatValue(match.matchId)}.`,
    );
  }
  runtime.actions.push(Object.freeze({ ...action }));
}

function getReplayRecord(match: EngineMatch): ReplayRecord {
  const runtime = runtimeFor(match);
  return Object.freeze({
    matchId: match.matchId,
    config: match.config,
    seed: match.seed,
    actions: Object.freeze(runtime.actions.map((action) => Object.freeze({ ...action }))),
  });
}

/**
 * Build the end-only payload.
 *
 * This is the sole output that carries `seed` and every mine position; the
 * room layer must call it only when the match has actually ended (including
 * forfeits and timeouts, which can end a still-active engine).
 */
export function endPayload(
  match: EngineMatch,
  input: EndPayloadInput,
): MatchEndPayload {
  return {
    matchId: match.matchId,
    reason: input.reason,
    winnerId: input.winnerId,
    loserId: input.loserId,
    finalSnapshot: expandEndBoard(match),
    seed: match.seed,
    stats: input.stats,
  };
}

/** Index expected digests by `seq`, rejecting duplicates up front. */
function indexExpectedDigests(
  expected: readonly ReplayDigest[],
): Map<number, ReplayDigest> {
  const bySeq = new Map<number, ReplayDigest>();
  for (const [index, digest] of expected.entries()) {
    if (digest === null || typeof digest !== 'object') {
      throw new TypeError(`expected[${index}] must be a digest object.`);
    }
    if (!Number.isSafeInteger(digest.seq) || digest.seq < 1) {
      throw new RangeError(
        `expected[${index}].seq must be a positive integer, received ${formatValue(digest.seq)}.`,
      );
    }
    if (bySeq.has(digest.seq)) {
      throw new RangeError(`expected digests contain duplicate seq ${digest.seq}.`);
    }
    bySeq.set(digest.seq, digest);
  }
  return bySeq;
}

function compareDigest(expected: ReplayDigest, actual: ReplayDigest): void {
  if (expected.turnId !== actual.turnId) {
    throw new ReplayMismatchError(
      actual.seq,
      `turnId expected ${expected.turnId}, replayed ${actual.turnId}.`,
    );
  }
  if (expected.engineStatus !== actual.engineStatus) {
    throw new ReplayMismatchError(
      actual.seq,
      `engineStatus expected ${expected.engineStatus}, replayed ${actual.engineStatus}.`,
    );
  }
  if (expected.revealedSafeCount !== actual.revealedSafeCount) {
    throw new ReplayMismatchError(
      actual.seq,
      `revealedSafeCount expected ${expected.revealedSafeCount}, replayed ${actual.revealedSafeCount}.`,
    );
  }
  if (expected.remainingMines !== actual.remainingMines) {
    throw new ReplayMismatchError(
      actual.seq,
      `remainingMines expected ${expected.remainingMines}, replayed ${actual.remainingMines}.`,
    );
  }
  if (expected.snapshotHash !== actual.snapshotHash) {
    throw new ReplayMismatchError(
      actual.seq,
      'snapshotHash differs from the recorded digest.',
    );
  }
}

/**
 * Replay one match from `config + seed + ordered actions`.
 *
 * Actions are sorted by `seq` before they reach the engine; duplicate or
 * malformed seq values fail with an explicit error. When expected digests are
 * supplied, every replayed step is compared and the first difference raises a
 * `ReplayMismatchError` carrying the offending `seq`.
 */
export function replayMatch(
  record: ReplayRecord,
  expected?: readonly ReplayDigest[],
): ReplayOutcome {
  if (record === null || typeof record !== 'object') {
    throw new TypeError('replay record must be an object.');
  }
  if (!Array.isArray(record.actions)) {
    throw new TypeError('replay record actions must be an array.');
  }
  const config = validateConfig(record.config);
  const seed = assertSeed(record.seed);
  const seedHash = hashSeed(seed);

  const seen = new Set<number>();
  for (const [index, action] of record.actions.entries()) {
    assertActionFields(action, `action[${index}]`);
    assertActionInBounds(action, config, `action[${index}]`);
    if (seen.has(action.seq)) {
      throw new RangeError(`replay record has duplicate seq ${action.seq}.`);
    }
    seen.add(action.seq);
  }

  const expectedBySeq =
    expected === undefined ? null : indexExpectedDigests(expected);
  const actions = [...record.actions].sort((left, right) => left.seq - right.seq);
  const engine = createMatchEngine(config, seed);
  const digests: ReplayDigest[] = [];

  for (const action of actions) {
    applyToEngine(engine, config, action);
    const digest = digestState(engine, action.seq, action.turnId, seedHash);
    digests.push(digest);
    const expectedDigest = expectedBySeq?.get(action.seq);
    if (expectedBySeq !== null && expectedDigest === undefined) {
      throw new ReplayMismatchError(
        action.seq,
        'the recorded digests have no entry for this action.',
      );
    }
    if (expectedDigest !== undefined) {
      compareDigest(expectedDigest, digest);
    }
  }

  if (expectedBySeq !== null) {
    for (const seq of expectedBySeq.keys()) {
      if (!seen.has(seq)) {
        throw new ReplayMismatchError(
          seq,
          'the replay record has no action for this expected digest.',
        );
      }
    }
  }

  const finalDigest =
    digests.at(-1) ?? digestState(engine, 0, 0, seedHash);
  return { digests, finalDigest, status: engine.currentStatus };
}

function replay(record: ReplayRecord): readonly ReplayDigest[] {
  return replayMatch(record).digests;
}

/** Shared singleton used by the room service and its tests. */
export const engineAdapter: EngineAdapter = {
  createMatch,
  applyAction,
  tick,
  projectSnapshot,
  expandEndBoard,
  recordAction,
  getReplayRecord,
  replay,
};
