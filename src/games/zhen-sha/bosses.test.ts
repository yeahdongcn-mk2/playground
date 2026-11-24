import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOSSES } from './bosses';
import type { BossChart, BossMove, BossPhase } from './bosses';
import { MAX_HITS } from './engine';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, 'bosses.ts'), 'utf8');

/**
 * The committed shape of all three charts. Keeping the full id list here means
 * a rename or a reordered move fails this test instead of silently invalidating
 * saved replays.
 */
const EXPECTED_CHARTS = [
  {
    id: 'boss-1',
    phases: [
      {
        id: 'boss-1-phase-1',
        moveIds: [
          'b1-p1-overhead',
          'b1-p1-sweep',
          'b1-p1-thrust',
          'b1-p1-feint-slash',
          'b1-p1-twin-cut',
          'b1-p1-low-sweep',
          'b1-p1-rising-cut',
          'b1-p1-guard-break',
        ],
      },
      {
        id: 'boss-1-phase-2',
        moveIds: [
          'b1-p2-overhead',
          'b1-p2-sweep',
          'b1-p2-thrust',
          'b1-p2-feint-slash',
          'b1-p2-twin-cut',
          'b1-p2-low-sweep',
          'b1-p2-rising-cut',
          'b1-p2-guard-break',
        ],
      },
    ],
  },
  {
    id: 'boss-2',
    phases: [
      {
        id: 'boss-2-phase-1',
        moveIds: [
          'b2-p1-cleave',
          'b2-p1-backhand',
          'b2-p1-stomp',
          'b2-p1-charge',
          'b2-p1-spin',
          'b2-p1-hook',
          'b2-p1-slam',
        ],
      },
      {
        id: 'boss-2-phase-2',
        moveIds: [
          'b2-p2-cleave',
          'b2-p2-backhand',
          'b2-p2-stomp',
          'b2-p2-charge',
          'b2-p2-spin',
          'b2-p2-hook',
          'b2-p2-slam',
        ],
      },
    ],
  },
  {
    id: 'boss-3',
    phases: [
      {
        id: 'boss-3-phase-1',
        moveIds: [
          'b3-p1-cross-cut',
          'b3-p1-backfist',
          'b3-p1-knee',
          'b3-p1-spin-kick',
          'b3-p1-shoulder',
          'b3-p1-double-palm',
          'b3-p1-low-kick',
          'b3-p1-elbow',
        ],
      },
      {
        id: 'boss-3-phase-2',
        moveIds: [
          'b3-p2-cross-cut',
          'b3-p2-backfist',
          'b3-p2-knee',
          'b3-p2-spin-kick',
          'b3-p2-shoulder',
          'b3-p2-double-palm',
          'b3-p2-low-kick',
          'b3-p2-elbow',
        ],
      },
    ],
  },
] as const;

/** Words that sound like an acceptance criterion but cannot be measured. */
const UNVERIFIABLE_WORDS = [
  '良好',
  '流畅',
  '不要太难',
  '好玩',
  '有趣',
  '爽快',
  '手感',
  '打击感',
  '难度适中',
  '合理',
  '丰富',
  '优秀',
  '出色',
];

/** Tokens that would mean the data table depends on a host or a renderer. */
const FORBIDDEN_SOURCE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['module import', /(?:^|\n)\s*import\b/],
  ['require call', /\brequire\s*\(/],
  ['re-export from a module', /(?:^|\n)\s*export\b[^;]*\bfrom\b/],
  ['DOM document', /\bdocument\b/],
  ['DOM window', /\bwindow\b/],
  ['DOM element', /\b(?:HTMLElement|HTMLCanvasElement|Element|Node)\b/],
  ['Canvas drawing', /\bcanvas\b/i],
  ['Phaser', /\bPhaser\b/],
  ['THREE', /\bTHREE\b/],
  ['audio', /\b(?:Audio|AudioContext|audio|sound)\b/i],
  ['timer', /\b(?:setTimeout|setInterval|requestAnimationFrame)\b/],
  ['wall clock', /\b(?:Date\.now|performance\.now)\b/],
  ['unseeded randomness', /\bMath\.random\b/],
];

function phaseAt(boss: BossChart, index: number): BossPhase {
  const phase = boss.phases[index];
  if (phase === undefined) {
    throw new Error(`${boss.id} is missing phase ${String(index + 1)}`);
  }
  return phase;
}

function bossAt(id: string): BossChart {
  const boss = BOSSES.find((candidate) => candidate.id === id);
  if (boss === undefined) {
    throw new Error(`missing boss ${id}`);
  }
  return boss;
}

function movesOf(boss: BossChart): readonly BossMove[] {
  return boss.phases.flatMap((phase) => phase.moves);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('cannot average an empty list');
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function chartDurationMs(boss: BossChart): number {
  return movesOf(boss).reduce((sum, move) => sum + move.telegraphMs + move.activeMs, 0);
}

/** A phase's timing/damage numbers with move order removed, for reuse checks. */
type StatQuad = readonly [number, number, number, number];

function phaseSignature(phase: BossPhase): readonly StatQuad[] {
  return phase.moves
    .map((move): StatQuad => [move.telegraphMs, move.activeMs, move.parryWindowMs, move.damage])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || left[3] - right[3]);
}

/** Result of replaying the whole chart with one fixed input policy. */
interface CampaignRun {
  readonly elapsedMs: number;
  readonly hits: number;
  readonly movesFaced: number;
  readonly failed: boolean;
}

/**
 * Walk all three bosses in chart order. `parry` is the only input: either every
 * move is parried or every move lands. Time advances only by each move's
 * telegraph plus active duration, so the run never reads a wall clock.
 */
function runCampaign(parry: boolean): CampaignRun {
  let elapsedMs = 0;
  let hits = 0;
  let movesFaced = 0;
  let failed = false;

  for (const boss of BOSSES) {
    for (const phase of boss.phases) {
      for (const move of phase.moves) {
        movesFaced += 1;
        elapsedMs += move.telegraphMs + move.activeMs;
        if (!parry) {
          hits += 1;
          if (hits >= MAX_HITS) {
            failed = true;
            return { elapsedMs, hits, movesFaced, failed };
          }
        }
      }
    }
  }

  return { elapsedMs, hits, movesFaced, failed };
}

function stringFields(): readonly string[] {
  const fields: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      fields.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) {
        visit(item);
      }
    }
  };
  visit(BOSSES);
  return fields;
}

describe('Zhen Sha boss charts', () => {
  it('starts with the three planned bosses, each holding two ordered phases', () => {
    expect(BOSSES.map((boss) => boss.id)).toEqual(['boss-1', 'boss-2', 'boss-3']);
    for (const boss of BOSSES) {
      expect(boss.phases.map((phase) => phase.id)).toEqual([
        `${boss.id}-phase-1`,
        `${boss.id}-phase-2`,
      ]);
    }
  });

  it('keeps every phase between 6 and 10 moves', () => {
    for (const boss of BOSSES) {
      for (const phase of boss.phases) {
        expect(phase.moves.length, `${phase.id} move count`).toBeGreaterThanOrEqual(6);
        expect(phase.moves.length, `${phase.id} move count`).toBeLessThanOrEqual(10);
      }
    }
  });

  it('gives every move positive integer timing and damage fields', () => {
    const fields = ['telegraphMs', 'activeMs', 'parryWindowMs', 'damage'] as const;
    for (const boss of BOSSES) {
      for (const move of movesOf(boss)) {
        for (const field of fields) {
          expect(Number.isInteger(move[field]), `${move.id}.${field} must be an integer`).toBe(
            true,
          );
          expect(move[field], `${move.id}.${field} must be positive`).toBeGreaterThan(0);
        }
        expect(move.parryWindowMs, `${move.id} parry window fits its active time`).toBeLessThanOrEqual(
          move.activeMs,
        );
      }
    }
  });

  it('keeps every move id globally unique and identical to the committed chart', () => {
    const actual = BOSSES.map((boss) => ({
      id: boss.id,
      phases: boss.phases.map((phase) => ({
        id: phase.id,
        moveIds: phase.moves.map((move) => move.id),
      })),
    }));
    expect(actual).toEqual(EXPECTED_CHARTS);

    const seen = new Set<string>();
    for (const boss of actual) {
      for (const phase of boss.phases) {
        for (const moveId of phase.moveIds) {
          expect(seen.has(moveId), `move id ${moveId} is reused`).toBe(false);
          seen.add(moveId);
        }
      }
    }
  });

  it('makes phase two average telegraph at least 15% shorter than phase one (within-phase mean)', () => {
    for (const boss of BOSSES) {
      const first = mean(phaseAt(boss, 0).moves.map((move) => move.telegraphMs));
      const second = mean(phaseAt(boss, 1).moves.map((move) => move.telegraphMs));
      expect(second, `${boss.id} phase two average telegraph`).toBeLessThanOrEqual(first * 0.85);
    }
  });

  it('raises phase two average damage per hit to at least 1.2× phase one (within-phase mean)', () => {
    for (const boss of BOSSES) {
      const first = mean(phaseAt(boss, 0).moves.map((move) => move.damage));
      const second = mean(phaseAt(boss, 1).moves.map((move) => move.damage));
      expect(second, `${boss.id} phase two average damage`).toBeGreaterThanOrEqual(first * 1.2);
    }
  });

  it('budgets each boss between 20 and 30 seconds of telegraph-plus-active time', () => {
    for (const boss of BOSSES) {
      const duration = chartDurationMs(boss);
      expect(duration, `${boss.id} total rhythm`).toBeGreaterThanOrEqual(20_000);
      expect(duration, `${boss.id} total rhythm`).toBeLessThanOrEqual(30_000);
    }
  });

  it('runs all three charts inside the 60–90 second campaign budget', () => {
    const totalMs = BOSSES.reduce((sum, boss) => sum + chartDurationMs(boss), 0);
    expect(totalMs, 'three-boss campaign length').toBeGreaterThanOrEqual(60_000);
    expect(totalMs, 'three-boss campaign length').toBeLessThanOrEqual(90_000);
  });

  it('gives the third boss no move ids in common with the first boss', () => {
    const firstIds = new Set(movesOf(bossAt('boss-1')).map((move) => move.id));
    const thirdMoves = movesOf(bossAt('boss-3'));
    expect(thirdMoves.length).toBeGreaterThan(0);
    expect(thirdMoves.filter((move) => firstIds.has(move.id)).map((move) => move.id)).toEqual([]);
  });

  it('does not clone the first boss by only reordering its stat quadruples', () => {
    const first = bossAt('boss-1');
    const third = bossAt('boss-3');
    for (let index = 0; index < 2; index += 1) {
      const firstPhase = phaseAt(first, index);
      const thirdPhase = phaseAt(third, index);
      expect(
        phaseSignature(thirdPhase),
        `${thirdPhase.id} reuses the numbers of ${firstPhase.id}`,
      ).not.toEqual(phaseSignature(firstPhase));
    }
  });

  it('clears all three bosses on the fixed-input perfect run inside 60–90 seconds', () => {
    const run = runCampaign(true);
    const totalMoves = BOSSES.reduce((sum, boss) => sum + movesOf(boss).length, 0);

    expect(run.failed).toBe(false);
    expect(run.hits).toBe(0);
    expect(run.movesFaced).toBe(totalMoves);
    expect(run.elapsedMs).toBeGreaterThanOrEqual(60_000);
    expect(run.elapsedMs).toBeLessThanOrEqual(90_000);
  });

  it('fails the all-miss run on the third hit under the existing MAX_HITS rule', () => {
    const run = runCampaign(false);

    expect(MAX_HITS).toBe(3);
    expect(run.failed).toBe(true);
    expect(run.hits).toBe(MAX_HITS);
    expect(run.movesFaced).toBe(MAX_HITS);
  });

  it('repeats both fixed-input runs identically without reading a wall clock', () => {
    const perfect = runCampaign(true);
    const allMiss = runCampaign(false);

    expect(runCampaign(true)).toEqual(perfect);
    expect(runCampaign(false)).toEqual(allMiss);
  });

  it('keeps every string field free of unverifiable quality words', () => {
    const fields = stringFields();
    expect(fields.length).toBeGreaterThan(0);
    for (const value of fields) {
      for (const word of UNVERIFIABLE_WORDS) {
        expect(value.includes(word), `${value} must not contain ${word}`).toBe(false);
      }
    }
  });

  it('keeps the chart data free of imports, DOM, rendering, audio, timers and wall-clock reads', () => {
    expect(SOURCE.trim().length).toBeGreaterThan(0);
    for (const [label, pattern] of FORBIDDEN_SOURCE_PATTERNS) {
      expect(SOURCE, `bosses.ts must not contain ${label}`).not.toMatch(pattern);
    }
    for (const word of UNVERIFIABLE_WORDS) {
      expect(SOURCE, `bosses.ts must not contain ${word}`).not.toContain(word);
    }
  });

  it('does not depend on the rules module or the view', () => {
    expect(SOURCE).not.toMatch(/zhen-sha-view/);
    expect(SOURCE).not.toMatch(/\bengine\b/);
  });
});
