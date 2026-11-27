import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_SPECS,
  type MatchEndReason,
  type RoomState,
  type RoomStateMessage,
} from '../../src/games/minesweeper/online/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESIGN_PATH = join(ROOT, 'docs', 'minesweeper-online-design.md');
const DESIGN = readFileSync(DESIGN_PATH, 'utf8');

// This suite is the single place where the series contract is cross-checked:
// the TS DTOs, `design:series`, `design:protocol` and `design:room-lifecycle`
// must agree. t1 already pins parts of it in `online-contracts.test.ts` and
// `minesweeper-online-design.test.ts`; the overlap here is intentional so this
// file stays an independent, end-to-end contract check. The series is
// contract-only: server scoring and the score UI are out of scope, and
// `room_state.series` may stay absent until that work lands.

// ---------------------------------------------------------------------------
// Compile-time series contract, read through the exported room-state DTO.
// `SeriesState` / `SeriesRoundResult` are private to types.ts, so the aliases
// below are the same wire types `room_state.series` carries.
// ---------------------------------------------------------------------------

type SeriesState = NonNullable<RoomStateMessage['series']>;
type SeriesRoundResult = SeriesState['history'][number];

/** The type argument must be exactly `true`. */
type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// `Pick` + an optional property literal distinguishes `series?: SeriesState`
// from `series: SeriesState | undefined`, which indexed access alone cannot.
type SeriesIsOptional = Assert<
  Equal<Pick<RoomStateMessage, 'series'>, { readonly series?: SeriesState }>
>;
type SeriesStateIsReadonly = Assert<Equal<SeriesState, Readonly<SeriesState>>>;
type SeriesCounters = Assert<
  Equal<
    | SeriesState['bestOf']
    | SeriesState['winsRequired']
    | SeriesState['maxRounds']
    | SeriesState['round'],
    number
  >
>;
type SeriesWinsAreKeyedByPlayerId = Assert<
  Equal<SeriesState['wins'], Readonly<Record<string, number>>>
>;
type SeriesFirstMoverIdIsString = Assert<Equal<SeriesState['firstMoverId'], string>>;
type SeriesDecidedIsBoolean = Assert<Equal<SeriesState['decided'], boolean>>;
type SeriesWinnerIdIsNullable = Assert<Equal<SeriesState['winnerId'], string | null>>;
type SeriesHistoryIsReadonly = Assert<
  Equal<SeriesState['history'], readonly SeriesRoundResult[]>
>;
type SeriesRoundResultIsReadonly = Assert<
  Equal<SeriesRoundResult, Readonly<SeriesRoundResult>>
>;
type SeriesRoundRoundIsNumber = Assert<Equal<SeriesRoundResult['round'], number>>;
type SeriesRoundMatchIdIsString = Assert<Equal<SeriesRoundResult['matchId'], string>>;
type SeriesRoundWinnerIdIsNullable = Assert<
  Equal<SeriesRoundResult['winnerId'], string | null>
>;
type SeriesRoundLoserIdIsNullable = Assert<
  Equal<SeriesRoundResult['loserId'], string | null>
>;
type SeriesRoundReasonIsMatchEndReason = Assert<
  Equal<SeriesRoundResult['reason'], MatchEndReason>
>;
type SeriesRoundFirstMoverIdIsString = Assert<
  Equal<SeriesRoundResult['firstMoverId'], string>
>;

const seriesIsOptional: SeriesIsOptional = true;
const seriesStateIsReadonly: SeriesStateIsReadonly = true;
const seriesCounters: SeriesCounters = true;
const seriesWinsAreKeyedByPlayerId: SeriesWinsAreKeyedByPlayerId = true;
const seriesFirstMoverIdIsString: SeriesFirstMoverIdIsString = true;
const seriesDecidedIsBoolean: SeriesDecidedIsBoolean = true;
const seriesWinnerIdIsNullable: SeriesWinnerIdIsNullable = true;
const seriesHistoryIsReadonly: SeriesHistoryIsReadonly = true;
const seriesRoundResultIsReadonly: SeriesRoundResultIsReadonly = true;
const seriesRoundRoundIsNumber: SeriesRoundRoundIsNumber = true;
const seriesRoundMatchIdIsString: SeriesRoundMatchIdIsString = true;
const seriesRoundWinnerIdIsNullable: SeriesRoundWinnerIdIsNullable = true;
const seriesRoundLoserIdIsNullable: SeriesRoundLoserIdIsNullable = true;
const seriesRoundReasonIsMatchEndReason: SeriesRoundReasonIsMatchEndReason = true;
const seriesRoundFirstMoverIdIsString: SeriesRoundFirstMoverIdIsString = true;

const SERIES_TYPE_ASSERTIONS = [
  seriesIsOptional,
  seriesStateIsReadonly,
  seriesCounters,
  seriesWinsAreKeyedByPlayerId,
  seriesFirstMoverIdIsString,
  seriesDecidedIsBoolean,
  seriesWinnerIdIsNullable,
  seriesHistoryIsReadonly,
  seriesRoundResultIsReadonly,
  seriesRoundRoundIsNumber,
  seriesRoundMatchIdIsString,
  seriesRoundWinnerIdIsNullable,
  seriesRoundLoserIdIsNullable,
  seriesRoundReasonIsMatchEndReason,
  seriesRoundFirstMoverIdIsString,
] as const;

/**
 * A full best-of-three fixture: host wins rounds 1 and 3, round 2 is drawn and
 * awards no win, so the host reaches two wins in round 3. It fixes every field
 * and both sides of the nullable ids without depending on the server.
 */
const SERIES_FIXTURE: SeriesState = {
  bestOf: 3,
  winsRequired: 2,
  maxRounds: 3,
  round: 3,
  wins: { host: 2, guest: 0 },
  firstMoverId: 'host',
  decided: true,
  winnerId: 'host',
  history: [
    {
      round: 1,
      matchId: 'match-1',
      winnerId: 'host',
      loserId: 'guest',
      reason: 'mine-hit',
      firstMoverId: 'host',
    },
    {
      round: 2,
      matchId: 'match-2',
      winnerId: null,
      loserId: null,
      reason: 'match-timeout',
      firstMoverId: 'guest',
    },
    {
      round: 3,
      matchId: 'match-3',
      winnerId: 'host',
      loserId: 'guest',
      reason: 'all-safe-revealed',
      firstMoverId: 'host',
    },
  ],
};

/** A round that exhausted its match timer; a draw awards no win. */
const DRAWN_ROUND: SeriesRoundResult = {
  round: 1,
  matchId: 'match-draw-1',
  winnerId: null,
  loserId: null,
  reason: 'match-timeout',
  firstMoverId: 'host',
};

/** The in-progress wire shape: no winner is known yet. */
const UNDECIDED_SERIES_FIXTURE: SeriesState = {
  bestOf: 3,
  winsRequired: 2,
  maxRounds: 3,
  round: 2,
  wins: { host: 1, guest: 0 },
  firstMoverId: 'guest',
  decided: false,
  winnerId: null,
  history: [
    {
      round: 1,
      matchId: 'match-1',
      winnerId: 'host',
      loserId: 'guest',
      reason: 'mine-hit',
      firstMoverId: 'host',
    },
  ],
};

/** Exhausting maxRounds without two wins ends the series drawn. */
const EXHAUSTED_SERIES_FIXTURE: SeriesState = {
  bestOf: 3,
  winsRequired: 2,
  maxRounds: 3,
  round: 3,
  wins: { host: 0, guest: 0 },
  firstMoverId: 'host',
  decided: true,
  winnerId: null,
  history: [
    DRAWN_ROUND,
    { ...DRAWN_ROUND, round: 2, matchId: 'match-draw-2', firstMoverId: 'guest' },
    { ...DRAWN_ROUND, round: 3, matchId: 'match-draw-3' },
  ],
};

const SERIES_FIELD_NAMES = [
  'bestOf',
  'winsRequired',
  'maxRounds',
  'round',
  'wins',
  'firstMoverId',
  'decided',
  'winnerId',
  'history',
] as const;
type SeriesFieldNamesMatch = Assert<
  Equal<(typeof SERIES_FIELD_NAMES)[number], keyof SeriesState>
>;
const seriesFieldNamesMatch: SeriesFieldNamesMatch = true;

const SERIES_ROUND_FIELD_NAMES = [
  'round',
  'matchId',
  'winnerId',
  'loserId',
  'reason',
  'firstMoverId',
] as const;
type SeriesRoundFieldNamesMatch = Assert<
  Equal<(typeof SERIES_ROUND_FIELD_NAMES)[number], keyof SeriesRoundResult>
>;
const seriesRoundFieldNamesMatch: SeriesRoundFieldNamesMatch = true;

const EXPECTED_SERIES_FIELD_TYPES: Readonly<Record<keyof SeriesState, string>> = {
  bestOf: 'integer',
  winsRequired: 'integer',
  maxRounds: 'integer',
  round: 'integer',
  wins: 'Record<playerId, integer>',
  firstMoverId: 'string',
  decided: 'boolean',
  winnerId: 'string|null',
  history: 'SeriesRoundResult[]',
};

const EXPECTED_SERIES_ROUND_FIELD_TYPES: Readonly<
  Record<keyof SeriesRoundResult, string>
> = {
  round: 'integer',
  matchId: 'string',
  winnerId: 'string|null',
  loserId: 'string|null',
  reason: 'match-reason',
  firstMoverId: 'string',
};

// ---------------------------------------------------------------------------
// design:* JSON blocks
// ---------------------------------------------------------------------------

interface DesignField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

interface DesignMessage {
  readonly type: string;
  readonly direction: string;
  readonly fields: readonly DesignField[];
}

interface DesignProtocol {
  readonly messages: readonly DesignMessage[];
}

interface LifecycleState {
  readonly name: string;
}

interface LifecycleTransition {
  readonly event: string;
  readonly from: string;
  readonly to: string;
}

interface LifecycleDesign {
  readonly initial: string;
  readonly terminalStates: readonly string[];
  readonly states: readonly LifecycleState[];
  readonly transitions: readonly LifecycleTransition[];
}

interface SeriesFieldMapping {
  readonly name: string;
  readonly type: string;
}

interface SeriesRoomStateMapping {
  readonly message: string;
  readonly field: string;
  readonly type: string;
  readonly required: boolean;
  readonly fields: readonly SeriesFieldMapping[];
  readonly roundResultFields: readonly SeriesFieldMapping[];
}

interface SeriesDesign {
  readonly version: number;
  readonly status: string;
  readonly bestOf: number;
  readonly winsRequired: number;
  readonly maxRounds: number;
  readonly firstMover: string;
  readonly firstRoundFirstMover: string;
  readonly resetAfterDecision: boolean;
  readonly roomStateSeries: SeriesRoomStateMapping;
}

/** Escape a marker before embedding it in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse the JSON fenced block immediately after a design marker. */
function readJsonBlock(marker: string): unknown {
  const pattern = new RegExp(
    '<!--\\s*' + escapeRegExp(marker) + '\\s*-->\\s*```json\\s*\\n([\\s\\S]*?)\\n```',
  );
  const match = pattern.exec(DESIGN);
  if (match === null) {
    throw new Error(`Missing ${marker} JSON block in ${DESIGN_PATH}.`);
  }
  const block = match[1];
  if (block === undefined || block.trim().length === 0) {
    throw new Error(`Empty ${marker} JSON block in ${DESIGN_PATH}.`);
  }
  return JSON.parse(block) as unknown;
}

const lifecycle = readJsonBlock('design:room-lifecycle') as LifecycleDesign;
const protocol = readJsonBlock('design:protocol') as DesignProtocol;
const series = readJsonBlock('design:series') as SeriesDesign;

// ---------------------------------------------------------------------------
// Room state names stay owned by design:room-lifecycle
// ---------------------------------------------------------------------------

const ROOM_STATE_NAMES = [
  'idle',
  'waiting',
  'ready',
  'playing',
  'finished',
  'dissolved',
] as const;
type LifecycleRoomState = (typeof ROOM_STATE_NAMES)[number];
type RoomStateMatchesLifecycle = Assert<Equal<RoomState, LifecycleRoomState>>;
const roomStateMatchesLifecycle: RoomStateMatchesLifecycle = true;

const ROOM_STATE_ASSERTIONS = [roomStateMatchesLifecycle] as const;

// The design:series object has no room-state machine of its own; its keys are
// pinned so a future `states` / `seriesStates` map cannot slip in unnoticed.
const SERIES_DESIGN_KEYS = [
  'version',
  'status',
  'bestOf',
  'winsRequired',
  'maxRounds',
  'firstMover',
  'firstRoundFirstMover',
  'resetAfterDecision',
  'roomStateSeries',
] as const;
const SERIES_ROOM_STATE_MAPPING_KEYS = [
  'message',
  'field',
  'type',
  'required',
  'fields',
  'roundResultFields',
] as const;

describe('minesweeper online series contract', () => {
  it('pins the SeriesState and SeriesRoundResult fixture fields and nullability', () => {
    expect(Object.keys(SERIES_FIXTURE).sort()).toEqual([...SERIES_FIELD_NAMES].sort());
    expect(SERIES_FIXTURE.bestOf).toBe(3);
    expect(SERIES_FIXTURE.winsRequired).toBe(2);
    expect(SERIES_FIXTURE.maxRounds).toBe(3);
    expect(SERIES_FIXTURE.round).toBe(3);
    expect(SERIES_FIXTURE.wins).toEqual({ host: 2, guest: 0 });
    expect(SERIES_FIXTURE.firstMoverId).toBe('host');
    expect(SERIES_FIXTURE.decided).toBe(true);
    expect(SERIES_FIXTURE.winnerId).toBe('host');
    expect(SERIES_FIXTURE.history).toHaveLength(3);
    expect(SERIES_FIXTURE.history.map((round) => round.round)).toEqual([1, 2, 3]);

    const drawn = SERIES_FIXTURE.history[1];
    expect(drawn, 'the fixture must carry a drawn round').toBeDefined();
    if (drawn !== undefined) {
      expect(Object.keys(drawn).sort()).toEqual([...SERIES_ROUND_FIELD_NAMES].sort());
      expect(drawn.winnerId).toBeNull();
      expect(drawn.loserId).toBeNull();
      expect(drawn.reason).toBe('match-timeout');
      expect(drawn.firstMoverId).toBe('guest');
    }

    const winningRound = SERIES_FIXTURE.history[0];
    expect(winningRound?.winnerId).toBe('host');
    expect(winningRound?.loserId).toBe('guest');

    // The in-progress wire shape and an exhausted, drawn series both expose
    // the nullable winner without inventing a second fixture type.
    expect(UNDECIDED_SERIES_FIXTURE.decided).toBe(false);
    expect(UNDECIDED_SERIES_FIXTURE.winnerId).toBeNull();
    expect(UNDECIDED_SERIES_FIXTURE.round).toBeLessThan(
      UNDECIDED_SERIES_FIXTURE.maxRounds,
    );
    expect(UNDECIDED_SERIES_FIXTURE.history).toHaveLength(1);
    expect(UNDECIDED_SERIES_FIXTURE.history[0]?.winnerId).toBe('host');

    expect(EXHAUSTED_SERIES_FIXTURE.decided).toBe(true);
    expect(EXHAUSTED_SERIES_FIXTURE.winnerId).toBeNull();
    expect(EXHAUSTED_SERIES_FIXTURE.round).toBe(EXHAUSTED_SERIES_FIXTURE.maxRounds);
    expect(EXHAUSTED_SERIES_FIXTURE.wins).toEqual({ host: 0, guest: 0 });
    expect(EXHAUSTED_SERIES_FIXTURE.history).toHaveLength(3);
    expect(
      EXHAUSTED_SERIES_FIXTURE.history.every(
        (round) => round.winnerId === null && round.loserId === null,
      ),
    ).toBe(true);

    expect(SERIES_TYPE_ASSERTIONS.every((assertion) => assertion)).toBe(true);
    expect(seriesFieldNamesMatch).toBe(true);
    expect(seriesRoundFieldNamesMatch).toBe(true);
  });

  it('parses design:series and fixes the best-of-three parameters', () => {
    expect(series.version).toBe(1);
    expect(series.status).toBe('contract-only');
    expect(series.bestOf).toBe(3);
    expect(series.winsRequired).toBe(2);
    expect(series.maxRounds).toBe(3);
    expect(series.firstMover).toBe('alternates');
    expect(series.firstRoundFirstMover).toBe('host');
    expect(series.resetAfterDecision).toBe(true);

    // First to two wins ends the series, otherwise it runs the full three.
    expect(series.bestOf).toBe(series.maxRounds);
    expect(series.winsRequired * 2 - 1).toBe(series.maxRounds);

    expect(series.roomStateSeries.message).toBe('room_state');
    expect(series.roomStateSeries.field).toBe('series');
    expect(series.roomStateSeries.type).toBe('SeriesState');
    expect(series.roomStateSeries.required).toBe(false);
  });

  it('keeps the design:series field tables aligned with the typed contract', () => {
    expect(series.roomStateSeries.fields.map((field) => field.name)).toEqual([
      ...SERIES_FIELD_NAMES,
    ]);
    expect(
      Object.fromEntries(
        series.roomStateSeries.fields.map((field) => [field.name, field.type]),
      ),
    ).toEqual(EXPECTED_SERIES_FIELD_TYPES);

    expect(series.roomStateSeries.roundResultFields.map((field) => field.name)).toEqual([
      ...SERIES_ROUND_FIELD_NAMES,
    ]);
    expect(
      Object.fromEntries(
        series.roomStateSeries.roundResultFields.map((field) => [
          field.name,
          field.type,
        ]),
      ),
    ).toEqual(EXPECTED_SERIES_ROUND_FIELD_TYPES);
  });

  it('cross-checks room_state.series between design:protocol and MESSAGE_SPECS', () => {
    const designMessage = protocol.messages.find(
      (message) => message.type === series.roomStateSeries.message,
    );
    expect(designMessage, 'design:protocol must declare room_state').toBeDefined();
    expect(designMessage?.direction).toBe('server-to-client');

    const designField = designMessage?.fields.find(
      (field) => field.name === series.roomStateSeries.field,
    );
    expect(designField, 'design:protocol must declare room_state.series').toBeDefined();

    const spec = MESSAGE_SPECS.find(
      (message) => message.type === series.roomStateSeries.message,
    );
    expect(spec, 'MESSAGE_SPECS must declare room_state').toBeDefined();
    const specField = spec?.fields.find(
      (field) => field.name === series.roomStateSeries.field,
    );

    const expected = { name: 'series', type: 'SeriesState', required: false };
    expect(designField).toEqual(expected);
    expect(specField).toEqual(expected);
    expect(specField).toEqual(designField);
  });

  it('reuses the design:room-lifecycle state names without new room states', () => {
    const stateNames = lifecycle.states.map((state) => state.name);
    expect([...stateNames].sort()).toEqual([...ROOM_STATE_NAMES].sort());
    expect(new Set(stateNames).size).toBe(stateNames.length);

    // design:series only maps the optional room_state field; it does not own a
    // second state machine or add room states.
    expect(Object.keys(series).sort()).toEqual([...SERIES_DESIGN_KEYS].sort());
    expect(Object.keys(series.roomStateSeries).sort()).toEqual(
      [...SERIES_ROOM_STATE_MAPPING_KEYS].sort(),
    );
    expect(series.roomStateSeries.fields.map((field) => field.name)).not.toContain(
      'state',
    );

    const roomStateField = { name: 'state', type: 'RoomState', required: true };
    const spec = MESSAGE_SPECS.find((message) => message.type === 'room_state');
    expect(spec?.fields.find((field) => field.name === 'state')).toEqual(roomStateField);
    const designMessage = protocol.messages.find(
      (message) => message.type === 'room_state',
    );
    expect(designMessage?.fields.find((field) => field.name === 'state')).toEqual(
      roomStateField,
    );

    // The only series-adjacent lifecycle edge is still finished -> ready.
    const rematchTransitions = lifecycle.transitions.filter(
      (transition) => transition.event === 'rematch',
    );
    expect(rematchTransitions).toHaveLength(1);
    expect(rematchTransitions[0]).toMatchObject({ from: 'finished', to: 'ready' });

    expect(ROOM_STATE_ASSERTIONS.every((assertion) => assertion)).toBe(true);
  });
});
