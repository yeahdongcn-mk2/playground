import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_SPECS,
  PROTOCOL_VERSION,
} from '../../src/games/minesweeper/online/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESIGN_PATH = join(ROOT, 'docs', 'minesweeper-online-design.md');
const TYPES_PATH = join(ROOT, 'src', 'games', 'minesweeper', 'online', 'types.ts');
const DESIGN = readFileSync(DESIGN_PATH, 'utf8');
const TYPES_SOURCE = readFileSync(TYPES_PATH, 'utf8');

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
