/**
 * Framework-agnostic rules for Zhen Sha's parry duel.
 *
 * The engine never touches the DOM, renderers, audio, timers or storage. A
 * view owns drawing and pointer handling, feeds logical actions in, advances
 * the simulation with `update(deltaMs)` or `step()` and reads immutable
 * snapshots. Every decision is made on an integer fixed tick so the same input
 * schedule produces the same result no matter how real time is chunked.
 *
 * The duel follows a `BossChart`: bosses are fought in order, each boss has an
 * ordered list of phases and each phase cycles its ordered moves. One perfect
 * parry per move fills one momentum pip; three perfects break the guard, and a
 * charged staff strike clears the phase and advances to the next phase or the
 * next boss. Three unparried hits end the duel. The default chart reproduces
 * the original single-boss kill gate tick for tick.
 */

import {
  DEFAULT_BOSS_CHART,
  type BossChart,
  type BossChartBoss,
  type BossMoveChart,
  type BossPhaseChart,
} from './boss-chart';

/** Fixed ticks simulated per second of game time. */
export const TICKS_PER_SECOND = 120;

/**
 * Duration of one fixed simulation tick. All rule decisions happen on tick
 * boundaries; milliseconds are only used at the renderer boundary.
 */
export const FIXED_STEP_MS = 1000 / TICKS_PER_SECOND;

/**
 * Half-width of the default perfect parry band, in ticks. A tap within 6 ticks
 * (50 ms) of the impact is perfect; the full band is 100 ms wide.
 */
export const PERFECT_BAND_HALF_TICKS = 6;

/**
 * Half-width of the default normal parry band, in ticks. A tap within 18 ticks
 * (150 ms) of the impact is a normal parry; anything wider is a whiff.
 */
export const NORMAL_BAND_HALF_TICKS = 18;

/** Momentum (势) gained by one perfect parry. */
export const MOMENTUM_PER_PERFECT = 1;

/** Momentum required to break the boss's guard. */
export const MOMENTUM_FOR_BREAK = 3;

/** Unparried hits tolerated before the duel is lost. */
export const MAX_HITS = 3;

/** Score for a perfect parry. */
export const SCORE_PERFECT = 300;

/** Score for a normal parry. */
export const SCORE_NORMAL = 100;

/** Score for landing the finisher on a broken guard. */
export const SCORE_FINISHER = 1000;

/** Wind-up before the first killing move of the default chart (1500 ms). */
export const FIRST_TELEGRAPH_TICKS = 180;

/** Wind-up before every later killing move of the default chart (900 ms). */
export const TELEGRAPH_TICKS = 108;

/** Pause after an exchange in the default chart (600 ms). */
export const RECOVERY_TICKS = 72;

/**
 * Ticks the guard stays broken and open to the finisher (2000 ms). The break
 * covers ticks `[start, start + BREAK_TICKS)`; a strike on the expiry tick is
 * too late and the boss recovers.
 */
export const BREAK_TICKS = 240;
/** Largest real-time delta folded into one `update()` call. */
const MAX_UPDATE_MS = 250;

/** A logical action the view maps pointer gestures to. */
export type ZhenShaAction = 'block' | 'charge' | 'strike';

/** Duel outcome. */
export type ZhenShaStatus = 'playing' | 'won' | 'lost';

/** Result of judging one parry tap. */
export type ParryJudgement = 'perfect' | 'normal' | 'miss';

/** Feedback events drained by the view for sound and effects. */
export type ZhenShaEventType =
  | 'perfect'
  | 'normal'
  | 'miss'
  | 'hit'
  | 'strike'
  | 'break'
  | 'break-end'
  | 'finisher'
  | 'win'
  | 'lose';

export interface ZhenShaEvent {
  readonly type: ZhenShaEventType;
  readonly step: number;
}

export interface ZhenShaAttackSnapshot {
  /** Fixed tick at the centre of the parry bands (the strike's visual impact). */
  readonly impactStep: number;
  /** Ticks until that centre; negative once the late band has begun. */
  readonly ticksUntilImpact: number;
  /** `telegraph` while winding up, `active` from the impact tick on. */
  readonly phase: 'telegraph' | 'active';
  /**
   * True when an earlier whiff committed this move to landing; further taps
   * are ignored until the unparried move resolves.
   */
  readonly committed: boolean;
}

export interface ZhenShaBossSnapshot {
  readonly name: string;
  /** 1-based boss index; with `phase` it forms labels such as `1-1`…`3-2`. */
  readonly bossIndex: number;
  /** 1-based index of the current phase inside the current boss. */
  readonly phase: number;
  readonly guard: 'up' | 'broken';
}

/** Immutable read model handed to the view. */
export interface ZhenShaSnapshot {
  /** Completed fixed ticks; game time is `step * FIXED_STEP_MS`. */
  readonly step: number;
  readonly elapsedMs: number;
  readonly status: ZhenShaStatus;
  readonly boss: ZhenShaBossSnapshot;
  readonly attack: ZhenShaAttackSnapshot | null;
  readonly charging: boolean;
  /** Current momentum (势) in the current phase, 0..MOMENTUM_FOR_BREAK. */
  readonly momentum: number;
  /** Perfect parries landed this duel. */
  readonly perfects: number;
  /** Unparried damage taken this duel, capped at `MAX_HITS`. */
  readonly hits: number;
  readonly score: number;
  /** Ticks until the break expires (exclusive), or 0 while the guard is up. */
  readonly breakTicksLeft: number;
  readonly lastJudgement: ParryJudgement | null;
}

/**
 * One move converted to integer ticks, with its damage kept as a hit cost.
 * Band half-widths are derived from the full-width chart durations with
 * `floor(fullTicks / 2)`, so the two outside ticks of an odd-width band stay
 * inside it.
 */
interface TimedMove {
  readonly telegraphTicks: number;
  readonly normalHalfTicks: number;
  readonly perfectHalfTicks: number;
  readonly damage: number;
}

interface TimedPhase {
  readonly moves: readonly TimedMove[];
}

interface TimedBoss {
  readonly name: string;
  readonly phases: readonly TimedPhase[];
}

interface TimedChart {
  readonly bosses: readonly TimedBoss[];
  readonly recoveryTicks: number;
  readonly firstTelegraphTicks: number;
}

function durationToTicks(ms: number, label: string): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`${label} must be a positive number of milliseconds`);
  }
  return Math.max(1, Math.round((ms * TICKS_PER_SECOND) / 1000));
}

function bandHalfTicks(ms: number, label: string): number {
  return Math.floor(durationToTicks(ms, label) / 2);
}

/** Runtime guard for untrusted chart data, keeping the element type. */
function isNonEmptyArray<T>(value: unknown): value is readonly T[] {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Convert a chart to integer ticks once per engine instance so every later
 * decision is pure integer arithmetic. Non-aligned milliseconds round to the
 * nearest tick; the default chart's values are exact multiples of 1000/120 ms.
 */
function normalizeChart(chart: BossChart): TimedChart {
  if (!isNonEmptyArray<BossChartBoss>(chart.bosses)) {
    throw new RangeError('BossChart must contain at least one boss');
  }

  const bosses: TimedBoss[] = chart.bosses.map((boss, bossIndex) => {
    if (typeof boss.name !== 'string' || boss.name.trim().length === 0) {
      throw new RangeError(`BossChart boss ${bossIndex + 1} needs a name`);
    }
    if (!isNonEmptyArray<BossPhaseChart>(boss.phases)) {
      throw new RangeError(`BossChart boss ${bossIndex + 1} needs a phase`);
    }

    return {
      name: boss.name,
      phases: boss.phases.map((phase, phaseIndex): TimedPhase => {
        if (!isNonEmptyArray<BossMoveChart>(phase.moves)) {
          throw new RangeError(
            `BossChart boss ${bossIndex + 1} phase ${phaseIndex + 1} needs a move`,
          );
        }

        return {
          moves: phase.moves.map((move, moveIndex): TimedMove => {
            const label = `BossChart boss ${bossIndex + 1} phase ${
              phaseIndex + 1
            } move ${moveIndex + 1}`;
            const damage = move.damage;
            if (!Number.isInteger(damage) || damage < 1) {
              throw new RangeError(`${label} damage must be a positive integer`);
            }
            const telegraphTicks = durationToTicks(
              move.telegraphMs,
              `${label} telegraphMs`,
            );
            const normalHalfTicks = bandHalfTicks(move.activeMs, `${label} activeMs`);
            const perfectHalfTicks = bandHalfTicks(
              move.parryWindowMs,
              `${label} parryWindowMs`,
            );
            if (normalHalfTicks < 1) {
              throw new RangeError(`${label} activeMs must span at least one tick`);
            }
            if (perfectHalfTicks > normalHalfTicks) {
              throw new RangeError(
                `${label} parryWindowMs must not be wider than activeMs`,
              );
            }
            return { telegraphTicks, normalHalfTicks, perfectHalfTicks, damage };
          }),
        };
      }),
    };
  });

  const firstBoss = bosses[0];
  const firstPhase = firstBoss?.phases[0];
  const firstMove = firstPhase?.moves[0];
  if (firstMove === undefined) {
    throw new RangeError('BossChart needs an opening move');
  }

  let recoveryTicks = 0;
  if (chart.recoveryMs !== undefined) {
    if (
      typeof chart.recoveryMs !== 'number' ||
      !Number.isFinite(chart.recoveryMs) ||
      chart.recoveryMs < 0
    ) {
      throw new RangeError(
        'BossChart recoveryMs must be a non-negative number of milliseconds',
      );
    }
    recoveryTicks = Math.round((chart.recoveryMs * TICKS_PER_SECOND) / 1000);
  }
  const firstTelegraphTicks =
    chart.firstTelegraphMs === undefined
      ? firstMove.telegraphTicks
      : durationToTicks(chart.firstTelegraphMs, 'BossChart firstTelegraphMs');

  return { bosses, recoveryTicks, firstTelegraphTicks };
}

interface AttackState {
  readonly impactStep: number;
  readonly move: TimedMove;
  /**
   * A whiffed parry commits this move to landing. Blocking again before the
   * move resolves is ignored, so holding down the block action cannot fish
   * for the perfect band after an early tap.
   */
  doomed: boolean;
}

interface PendingInput {
  readonly action: ZhenShaAction;
  readonly step: number;
  readonly seq: number;
}

/**
 * Deterministic parry rules driven by a boss chart.
 *
 * Tap (`block`) is judged against the current move: within its perfect band it
 * scores, fills momentum and eventually breaks the guard; within its normal
 * band it only scores; outside both it is a whiff that commits the move to
 * landing, so a panic tap cannot be re-rolled by tapping again. A hold
 * (`charge`) followed by a release (`strike`) inside the break clears the
 * phase: the next phase or boss begins, and only clearing the last phase of
 * the last boss wins. Three unparried hits end the duel the other way; each
 * landed move adds the chart's `damage` (capped at `MAX_HITS`), which is 1 in
 * both the default chart and the real-chart adapter, so three unparried moves
 * still lose.
 */
export class ZhenShaEngine {
  private readonly chart: TimedChart;

  private bossIndex = 0;
  private phaseIndex = 0;
  private moveIndex = 0;

  private stepIndex = 0;
  private accumulatorMs = 0;

  private status: ZhenShaStatus = 'playing';
  private attack: AttackState | null = null;
  private nextAttackAtStep = 0;
  private charging = false;
  private momentum = 0;
  private perfects = 0;
  private hits = 0;
  private score = 0;
  private breakUntilStep: number | null = null;
  private lastJudgement: ParryJudgement | null = null;

  private inputSeq = 0;
  private pendingInputs: PendingInput[] = [];
  private events: ZhenShaEvent[] = [];

  /**
   * Build an engine for `chart`, defaulting to the kill-gate chart. The chart
   * is validated and converted to ticks once; only integer timing and damage
   * are kept.
   */
  constructor(chart: BossChart = DEFAULT_BOSS_CHART) {
    this.chart = normalizeChart(chart);
    this.restart();
  }

  /**
   * Reset every counter, the stage and the attack schedule, keeping the chart
   * this engine was built with.
   */
  restart(): void {
    this.bossIndex = 0;
    this.phaseIndex = 0;
    this.moveIndex = 0;
    this.stepIndex = 0;
    this.accumulatorMs = 0;
    this.status = 'playing';
    this.nextAttackAtStep = 0;
    this.spawnAttack(this.chart.firstTelegraphTicks);
    this.charging = false;
    this.momentum = 0;
    this.perfects = 0;
    this.hits = 0;
    this.score = 0;
    this.breakUntilStep = null;
    this.lastJudgement = null;
    this.inputSeq = 0;
    this.pendingInputs = [];
    this.events = [];
  }

  /**
   * Queue a logical action. `atStep` defaults to the current tick index, which
   * is the next tick to run; that is what a view wants for live input. Tests
   * and replays pass absolute ticks so the same schedule can be replayed with
   * any real-time chunking. A tick that has already run is clamped to the
   * current one, so queue future inputs before advancing for an exact replay.
   */
  input(action: ZhenShaAction, atStep: number = this.stepIndex): void {
    if (action !== 'block' && action !== 'charge' && action !== 'strike') {
      throw new RangeError(`Unknown Zhen Sha action: ${String(action)}`);
    }
    if (this.status !== 'playing') {
      return;
    }
    const step = Number.isFinite(atStep)
      ? Math.max(this.stepIndex, Math.floor(atStep))
      : this.stepIndex;
    this.inputSeq += 1;
    this.pendingInputs.push({ action, step, seq: this.inputSeq });
    this.pendingInputs.sort((a, b) => a.step - b.step || a.seq - b.seq);
  }

  /**
   * Advance by `deltaMs` using fixed ticks. The accumulator carries the
   * remainder, so a 60 Hz and a 120 Hz caller reach identical ticks.
   */
  update(deltaMs: number): void {
    if (this.status !== 'playing') {
      this.accumulatorMs = 0;
      return;
    }
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      return;
    }

    this.accumulatorMs += Math.min(deltaMs, MAX_UPDATE_MS);
    while (this.accumulatorMs + 1e-9 >= FIXED_STEP_MS) {
      this.step();
      this.accumulatorMs -= FIXED_STEP_MS;
      if (this.accumulatorMs < 0) {
        this.accumulatorMs = 0;
      }
      if (this.status !== 'playing') {
        this.accumulatorMs = 0;
        break;
      }
    }
  }

  /** Advance exactly one fixed tick. */
  step(): void {
    if (this.status !== 'playing') {
      return;
    }

    const tick = this.stepIndex;

    if (
      this.attack === null &&
      this.breakUntilStep === null &&
      tick >= this.nextAttackAtStep
    ) {
      this.spawnAttack(tick + this.currentMove().telegraphTicks);
    }

    this.applyPendingInputs(tick);

    const attack = this.attack;
    if (
      attack !== null &&
      tick >= attack.impactStep + attack.move.normalHalfTicks
    ) {
      this.attack = null;
      this.hits = Math.min(MAX_HITS, this.hits + attack.move.damage);
      this.lastJudgement = 'miss';
      this.pushEvent('hit');
      this.advanceMove();
      if (this.hits >= MAX_HITS) {
        this.status = 'lost';
        this.charging = false;
        this.pushEvent('lose');
      } else {
        this.nextAttackAtStep = tick + this.chart.recoveryTicks;
      }
    }

    this.stepIndex += 1;

    // End the break at the end of its last usable tick, so a resting snapshot
    // never reports a broken guard with no time left to use it.
    if (this.breakUntilStep !== null && this.stepIndex >= this.breakUntilStep) {
      this.breakUntilStep = null;
      this.momentum = 0;
      this.nextAttackAtStep = this.stepIndex + this.chart.recoveryTicks;
      this.pushEvent('break-end');
    }
  }

  /** Current status, without building a full snapshot. */
  get currentStatus(): ZhenShaStatus {
    return this.status;
  }

  /** House-style alias for `snapshot()`, matching the other game engines. */
  get state(): ZhenShaSnapshot {
    return this.snapshot();
  }

  /** Immutable snapshot; later steps never rewrite an object already read. */
  snapshot(): ZhenShaSnapshot {
    const attack = this.attack;
    const breakTicksLeft =
      this.breakUntilStep === null
        ? 0
        : Math.max(0, this.breakUntilStep - this.stepIndex);
    const guardBroken = this.status === 'won' || breakTicksLeft > 0;
    return {
      step: this.stepIndex,
      elapsedMs: this.stepIndex * FIXED_STEP_MS,
      status: this.status,
      boss: {
        name: this.currentBoss().name,
        bossIndex: this.bossIndex + 1,
        phase: this.phaseIndex + 1,
        guard: guardBroken ? 'broken' : 'up',
      },
      attack:
        attack === null
          ? null
          : {
              impactStep: attack.impactStep,
              ticksUntilImpact: attack.impactStep - this.stepIndex,
              phase: this.stepIndex < attack.impactStep ? 'telegraph' : 'active',
              committed: attack.doomed,
            },
      charging: this.charging,
      momentum: this.momentum,
      perfects: this.perfects,
      hits: this.hits,
      score: this.score,
      breakTicksLeft,
      lastJudgement: this.lastJudgement,
    };
  }

  /** Take the feedback events accumulated since the previous call. */
  drainEvents(): readonly ZhenShaEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  private currentBoss(): TimedBoss {
    const boss = this.chart.bosses[this.bossIndex];
    if (boss === undefined) {
      throw new Error('Zhen Sha chart is out of bosses');
    }
    return boss;
  }

  private currentPhase(): TimedPhase {
    const phase = this.currentBoss().phases[this.phaseIndex];
    if (phase === undefined) {
      throw new Error('Zhen Sha chart is out of phases');
    }
    return phase;
  }

  private currentMove(): TimedMove {
    const move = this.currentPhase().moves[this.moveIndex];
    if (move === undefined) {
      throw new Error('Zhen Sha chart is out of moves');
    }
    return move;
  }

  /** Cycle to the next move of the current phase. */
  private advanceMove(): void {
    this.moveIndex = (this.moveIndex + 1) % this.currentPhase().moves.length;
  }

  /**
   * Clear the current phase and move to the next phase, or the first phase of
   * the next boss. Returns false when the last phase of the last boss fell.
   */
  private advanceStage(): boolean {
    const boss = this.currentBoss();
    if (this.phaseIndex + 1 < boss.phases.length) {
      this.phaseIndex += 1;
    } else if (this.bossIndex + 1 < this.chart.bosses.length) {
      this.bossIndex += 1;
      this.phaseIndex = 0;
    } else {
      return false;
    }
    this.moveIndex = 0;
    return true;
  }

  private applyPendingInputs(tick: number): void {
    for (;;) {
      const next = this.pendingInputs[0];
      if (next === undefined || next.step > tick) {
        return;
      }
      this.pendingInputs.shift();
      this.applyAction(next.action);
      if (this.status !== 'playing') {
        this.pendingInputs = [];
        return;
      }
    }
  }

  private applyAction(action: ZhenShaAction): void {
    switch (action) {
      case 'block':
        this.resolveBlock();
        break;
      case 'charge':
        this.charging = true;
        break;
      case 'strike':
        this.resolveStrike();
        break;
    }
  }

  private resolveBlock(): void {
    const attack = this.attack;
    if (attack === null || attack.doomed) {
      return;
    }

    const distance = Math.abs(this.stepIndex - attack.impactStep);
    if (distance <= attack.move.perfectHalfTicks) {
      this.attack = null;
      this.perfects += 1;
      this.score += SCORE_PERFECT;
      this.lastJudgement = 'perfect';
      this.pushEvent('perfect');
      this.advanceMove();
      this.momentum = Math.min(
        MOMENTUM_FOR_BREAK,
        this.momentum + MOMENTUM_PER_PERFECT,
      );
      if (this.momentum >= MOMENTUM_FOR_BREAK) {
        this.breakUntilStep = this.stepIndex + BREAK_TICKS;
        this.pushEvent('break');
      } else {
        this.nextAttackAtStep = this.stepIndex + this.chart.recoveryTicks;
      }
      return;
    }

    if (distance <= attack.move.normalHalfTicks) {
      this.attack = null;
      this.score += SCORE_NORMAL;
      this.lastJudgement = 'normal';
      this.pushEvent('normal');
      this.advanceMove();
      this.nextAttackAtStep = this.stepIndex + this.chart.recoveryTicks;
      return;
    }

    this.rejectParry(attack);
  }

  private resolveStrike(): void {
    if (!this.charging) {
      return;
    }
    this.charging = false;

    if (this.breakUntilStep === null) {
      this.pushEvent('strike');
      return;
    }

    this.attack = null;
    this.breakUntilStep = null;
    this.score += SCORE_FINISHER;
    this.pushEvent('finisher');

    if (!this.advanceStage()) {
      this.status = 'won';
      this.pushEvent('win');
      return;
    }

    // The new phase starts with a clean guard and its own first move.
    this.momentum = 0;
    this.lastJudgement = null;
    this.nextAttackAtStep = this.stepIndex + this.chart.recoveryTicks;
  }

  private rejectParry(attack: AttackState): void {
    attack.doomed = true;
    this.lastJudgement = 'miss';
    this.pushEvent('miss');
  }

  private spawnAttack(impactStep: number): void {
    this.attack = {
      impactStep,
      move: this.currentMove(),
      doomed: false,
    };
  }

  private pushEvent(type: ZhenShaEventType): void {
    this.events.push({ type, step: this.stepIndex });
  }
}
