import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_SPECS,
  PROTOCOL_VERSION,
  type EndMessage,
  type MatchEndReason,
  type RoomStateMessage,
} from '../../src/games/minesweeper/online/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESIGN_PATH = join(ROOT, 'docs', 'minesweeper-online-design.md');
const TYPES_PATH = join(ROOT, 'src', 'games', 'minesweeper', 'online', 'types.ts');
const DESIGN = readFileSync(DESIGN_PATH, 'utf8');
const TYPES_SOURCE = readFileSync(TYPES_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Compile-time series contract assertions: a false assertion fails typecheck.
// ---------------------------------------------------------------------------

/** The type argument must be exactly `true`. */
type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type RoomSeries = NonNullable<RoomStateMessage['series']>;
type SeriesRound = RoomSeries['history'][number];

type SeriesIsOptional = Assert<Equal<RoomStateMessage['series'], RoomSeries | undefined>>;
type SeriesWinsAreKeyedByPlayerId = Assert<
  Equal<RoomSeries['wins'], Readonly<Record<string, number>>>
>;
type SeriesHistoryIsReadonly = Assert<Equal<RoomSeries['history'], readonly SeriesRound[]>>;
type SeriesFields = Assert<
  Equal<
    keyof RoomSeries,
    | 'bestOf'
    | 'winsRequired'
    | 'maxRounds'
    | 'round'
    | 'wins'
    | 'firstMoverId'
    | 'decided'
    | 'winnerId'
    | 'history'
  >
>;
type SeriesCounterFields = Assert<
  Equal<
    | RoomSeries['bestOf']
    | RoomSeries['winsRequired']
    | RoomSeries['maxRounds']
    | RoomSeries['round'],
    number
  >
>;
type SeriesFirstMoverIdIsString = Assert<Equal<RoomSeries['firstMoverId'], string>>;
type SeriesDecidedIsBoolean = Assert<Equal<RoomSeries['decided'], boolean>>;
type SeriesWinnerIdIsNullable = Assert<Equal<RoomSeries['winnerId'], string | null>>;
type SeriesRoundFields = Assert<
  Equal<
    keyof SeriesRound,
    'round' | 'matchId' | 'winnerId' | 'loserId' | 'reason' | 'firstMoverId'
  >
>;
type SeriesRoundRoundIsNumber = Assert<Equal<SeriesRound['round'], number>>;
type SeriesRoundMatchIdIsString = Assert<Equal<SeriesRound['matchId'], string>>;
type SeriesRoundFirstMoverIdIsString = Assert<Equal<SeriesRound['firstMoverId'], string>>;
type SeriesRoundReasonIsMatchEndReason = Assert<
  Equal<SeriesRound['reason'], MatchEndReason>
>;
type SeriesRoundWinnerIdsAreNullable = Assert<
  Equal<SeriesRound['winnerId'] | SeriesRound['loserId'], string | null>
>;
type EndHasNoSeries = Assert<Equal<Exclude<keyof EndMessage, 'series'>, keyof EndMessage>>;

const seriesIsOptional: SeriesIsOptional = true;
const seriesWinsAreKeyedByPlayerId: SeriesWinsAreKeyedByPlayerId = true;
const seriesHistoryIsReadonly: SeriesHistoryIsReadonly = true;
const seriesFields: SeriesFields = true;
const seriesCounterFields: SeriesCounterFields = true;
const seriesFirstMoverIdIsString: SeriesFirstMoverIdIsString = true;
const seriesDecidedIsBoolean: SeriesDecidedIsBoolean = true;
const seriesWinnerIdIsNullable: SeriesWinnerIdIsNullable = true;
const seriesRoundFields: SeriesRoundFields = true;
const seriesRoundRoundIsNumber: SeriesRoundRoundIsNumber = true;
const seriesRoundMatchIdIsString: SeriesRoundMatchIdIsString = true;
const seriesRoundFirstMoverIdIsString: SeriesRoundFirstMoverIdIsString = true;
const seriesRoundReasonIsMatchEndReason: SeriesRoundReasonIsMatchEndReason = true;
const seriesRoundWinnerIdsAreNullable: SeriesRoundWinnerIdsAreNullable = true;
const endHasNoSeries: EndHasNoSeries = true;

const SERIES_TYPE_ASSERTIONS = [
  seriesIsOptional,
  seriesWinsAreKeyedByPlayerId,
  seriesHistoryIsReadonly,
  seriesFields,
  seriesCounterFields,
  seriesFirstMoverIdIsString,
  seriesDecidedIsBoolean,
  seriesWinnerIdIsNullable,
  seriesRoundFields,
  seriesRoundRoundIsNumber,
  seriesRoundMatchIdIsString,
  seriesRoundFirstMoverIdIsString,
  seriesRoundReasonIsMatchEndReason,
  seriesRoundWinnerIdsAreNullable,
  endHasNoSeries,
] as const;

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
  readonly version: number;
  readonly messages: readonly DesignMessage[];
}

const EXPECTED_MESSAGE_TYPES = [
  'create',
  'join',
  'ready',
  'start',
  'action',
  'rematch',
  'leave',
  'room_state',
  'snapshot',
  'action_result',
  'end',
  'timeout',
  'room_closed',
  'error',
] as const;

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

const protocol = readJsonBlock('design:protocol') as DesignProtocol;

describe('minesweeper online shared contract', () => {
  it('pins the wire protocol version to design:protocol', () => {
    expect(PROTOCOL_VERSION).toBe(protocol.version);
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('lists the 14 design messages exactly once and in design order', () => {
    expect(MESSAGE_SPECS).toHaveLength(14);
    expect(MESSAGE_SPECS.map((spec) => spec.type)).toEqual([...EXPECTED_MESSAGE_TYPES]);

    const designTypes = protocol.messages.map((message) => message.type);
    expect(designTypes).toHaveLength(14);
    expect(MESSAGE_SPECS.map((spec) => spec.type).sort()).toEqual(designTypes.sort());
  });

  it('matches every message direction and field against design:protocol', () => {
    const designByType = new Map(
      protocol.messages.map((message) => [message.type, message]),
    );

    for (const spec of MESSAGE_SPECS) {
      const design = designByType.get(spec.type);
      expect(design, `missing design:protocol entry for ${spec.type}`).toBeDefined();
      if (design === undefined) {
        continue;
      }

      expect(spec.direction, `direction of ${spec.type}`).toBe(design.direction);
      expect(spec.fields, `fields of ${spec.type}`).toEqual(design.fields);

      const seen = new Set<string>();
      for (const field of spec.fields) {
        expect(field.name.length, `empty field name on ${spec.type}`).toBeGreaterThan(0);
        expect(field.type.length, `empty field type on ${spec.type}.${field.name}`).toBeGreaterThan(0);
        expect(typeof field.required).toBe('boolean');
        expect(seen.has(field.name), `duplicate field ${spec.type}.${field.name}`).toBe(false);
        seen.add(field.name);
      }
    }

    expect(designByType.size).toBe(MESSAGE_SPECS.length);

    // `room_state.series` is optional; `end` keeps expressing one round only.
    const roomState = MESSAGE_SPECS.find((spec) => spec.type === 'room_state');
    const end = MESSAGE_SPECS.find((spec) => spec.type === 'end');
    expect(roomState).toBeDefined();
    expect(end).toBeDefined();
    if (roomState === undefined || end === undefined) {
      return;
    }
    expect(
      roomState.fields.find((field) => field.name === 'series'),
      'room_state.series must be an optional SeriesState',
    ).toEqual({ name: 'series', type: 'SeriesState', required: false });
    expect(
      end.fields.some((field) => field.name === 'series'),
      'end must not carry a series field',
    ).toBe(false);

    expect(TYPES_SOURCE).toMatch(/\binterface SeriesState\b/);
    expect(TYPES_SOURCE).toMatch(/\binterface SeriesRoundResult\b/);
    expect(SERIES_TYPE_ASSERTIONS.every((assertion) => assertion)).toBe(true);
  });

  it('keeps mines and the seed out of snapshots and exposes them only on end', () => {
    const snapshot = MESSAGE_SPECS.find((spec) => spec.type === 'snapshot');
    const end = MESSAGE_SPECS.find((spec) => spec.type === 'end');
    expect(snapshot).toBeDefined();
    expect(end).toBeDefined();
    if (snapshot === undefined || end === undefined) {
      return;
    }

    const snapshotFields = new Map(snapshot.fields.map((field) => [field.name, field]));
    expect(snapshotFields.get('board')?.type).toBe('RedactedBoard');
    expect(snapshotFields.get('seedHash')?.type).toBe('string');
    expect(snapshotFields.has('seed')).toBe(false);
    expect(snapshotFields.has('finalSnapshot')).toBe(false);

    const endFields = new Map(end.fields.map((field) => [field.name, field]));
    expect(endFields.get('finalSnapshot')?.type).toBe('RevealedBoard');
    expect(endFields.get('seed')?.type).toBe('integer');
  });

  it('publishes the seed and the full board only in end', () => {
    const withField = (name: string): string[] =>
      MESSAGE_SPECS.filter((spec) => spec.fields.some((field) => field.name === name)).map(
        (spec) => spec.type,
      );

    expect(withField('seed')).toEqual(['end']);
    expect(withField('finalSnapshot')).toEqual(['end']);
  });

  it('does not depend on DOM or storage globals', () => {
    expect(TYPES_SOURCE).not.toMatch(/\b(?:document|window|localStorage)\b/);
  });
});
