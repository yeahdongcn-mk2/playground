/**
 * Pure boss-chart contract for Zhen Sha, intended for the rules engine and the
 * real 3 boss × 2 phase data that #246 commits in `bosses.ts`.
 *
 * A chart is data only: no DOM, renderer, audio, timer or wall clock, and no
 * import from the engine or the view. Since #448 the engine consumes a chart:
 * the constructor converts it once with `normalizeChart(chart)` and schedules
 * from `telegraphMs` for the wind-up, `activeMs` for the normal parry band
 * (opening `activeMs / 2` before the impact tick and closing `activeMs / 2`
 * after it), `parryWindowMs` for the perfect band and `recoveryMs` for the rest
 * between exchanges. `damage` takes no part in judgement: it is a display /
 * design point value that the engine only checks that it is positive, while the
 * hit budget stays one point per unparried move (#449 settled that meaning).
 *
 * Relationship to `bosses.ts`: #246 already ships `BOSSES` with its own
 * `BossMove` / `BossPhase` / `BossChart` types — there a boss carries `id`,
 * `damage` is 7–13 points and `activeMs` is post-wind-up active time. In both
 * contracts `damage` is a display / design point value for one unparried move,
 * not a hit count: the engine always spends exactly one of its `MAX_HITS` per
 * unparried move, whatever `damage` says. This module deliberately does not
 * change `bosses.ts`.
 *
 * `bosses` and `phases` are arrays, not fixed-size tuples. Real charts have
 * three bosses with two phases each and 6–10 moves per phase, but the default
 * chart below is a single boss with a single phase and a single repeated move
 * that reproduces the existing kill-gate timing exactly, and the engine
 * consumes it by default.
 */

/**
 * One boss move as timing and damage data.
 *
 * All times are milliseconds of game time; the engine converts them to
 * integer ticks (120 per second). The default chart's values are exact
 * multiples of 1000/120 ms; non-aligned real values (for example #246's 320 ms)
 * need one explicit rounding rule before they drive judgement. The impact tick
 * ends the wind-up and is the centre of the parry bands.
 */
export interface BossMoveChart {
  /** Stable identifier, unique inside a chart; real data must not recycle it. */
  readonly id: string;
  /** Wind-up before the impact tick; 900 ms for the default chart's repeated move. */
  readonly telegraphMs: number;
  /**
   * Full width of the normal parry band in this contract, not the post-wind-up
   * active time that `bosses.ts` currently calls `activeMs`: the band opens
   * `activeMs / 2` before impact and closes `activeMs / 2` after it, both
   * endpoints inclusive. A tap inside it parries normally; a tap outside it
   * lets the move land.
   */
  readonly activeMs: number;
  /**
   * Full width of the perfect parry band, centred on the impact tick and
   * nested inside `activeMs`, endpoints inclusive. A tap inside it is perfect
   * and earns momentum.
   */
  readonly parryWindowMs: number;
  /**
   * Display / design point value for one unparried move. It describes the
   * fiction and never contributes to the hit budget: every unparried move
   * spends exactly one of the engine's `MAX_HITS`, regardless of this number.
   * #246's `bosses.ts` stores 7–13 points for its own data; the value is not a
   * hit count in either contract.
   */
  readonly damage: number;
}

/** One boss phase: an ordered, cycling list of moves. */
export interface BossPhaseChart {
  /** Stable identifier, unique inside a chart. */
  readonly id: string;
  /** 6–10 moves for real data; the default kill-gate phase has one. */
  readonly moves: readonly BossMoveChart[];
}

/** One boss: a name shown by the view and an ordered list of phases. */
export interface BossChartBoss {
  readonly name: string;
  /** Two phases for real data; one for the default kill-gate boss. */
  readonly phases: readonly BossPhaseChart[];
}

/** A complete duel chart: every boss the player must defeat, in order. */
export interface BossChart {
  readonly bosses: readonly BossChartBoss[];
  /**
   * Optional pause between a resolved exchange and the next wind-up. The
   * default kill-gate chart uses 600 ms; omitted charts rest immediately.
   */
  readonly recoveryMs?: number;
  /**
   * Optional wind-up that replaces the first move's own `telegraphMs` for the
   * duel's opening attack only. The default chart warms up for 1500 ms and then
   * uses the move's 900 ms wind-up for every later attack.
   */
  readonly firstTelegraphMs?: number;
}

/**
 * Default chart for the argument-free engine.
 *
 * It reproduces the original kill gate tick for tick: one 黑煞 phase whose
 * single move repeats after a 900 ms wind-up, an opening attack warmed up for
 * 1500 ms, a 600 ms recovery, a 300 ms normal parry band and a nested 100 ms
 * perfect band. At 120 Hz those are 108, 180, 72, 36 and 12 ticks, i.e.
 * TELEGRAPH_TICKS, FIRST_TELEGRAPH_TICKS, RECOVERY_TICKS,
 * 2 × NORMAL_BAND_HALF_TICKS and 2 × PERFECT_BAND_HALF_TICKS. Those constants
 * remain the tick equivalents of these millisecond values, for contracts and
 * tests to reference, but the engine already schedules from the chart and no
 * longer reads them.
 */
export const DEFAULT_BOSS_CHART: BossChart = {
  firstTelegraphMs: 1500,
  recoveryMs: 600,
  bosses: [
    {
      name: '黑煞',
      phases: [
        {
          id: 'kill-gate-1',
          moves: [
            {
              id: 'kill-gate-strike',
              telegraphMs: 900,
              activeMs: 300,
              parryWindowMs: 100,
              damage: 1,
            },
          ],
        },
      ],
    },
  ],
};
