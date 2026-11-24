/**
 * Boss charts for Zhen Sha: every boss is two phases of timed, parryable moves.
 *
 * This module is a pure data table. Each number describes rhythm or judgement
 * only: how long a move winds up, how long it stays active, how wide its parry
 * band is and how much damage it deals. Nothing here draws, listens, waits or
 * reads input; callers walk the chart with their own deterministic tick loop.
 *
 * Move ids are stable public names. Once a chart ships, renaming or reusing an
 * id breaks saved replays and the difficulty-curve checks in
 * `bosses.test.ts`; add a new id instead.
 *
 * Duration budget: each boss is roughly 20–30 seconds of
 * `telegraphMs + activeMs` across both phases, so three bosses land inside the
 * 60–90 second target for the finished campaign.
 */

/** One timed, parryable move inside a boss phase. */
export interface BossMove {
  /** Stable name; unique across `BOSSES` and never reused for a different move. */
  readonly id: string;
  /** Wind-up before the move becomes active, in milliseconds. */
  readonly telegraphMs: number;
  /** Time the move stays active after its wind-up, in milliseconds. */
  readonly activeMs: number;
  /** Parry band inside the active time, in milliseconds. */
  readonly parryWindowMs: number;
  /** Damage dealt when the move lands unparried. */
  readonly damage: number;
}

/** Ordered moves of one boss phase. */
export interface BossPhase {
  /** Stable name; unique across `BOSSES`. */
  readonly id: string;
  readonly moves: readonly BossMove[];
}

/** One boss: two ordered phases whose second half is faster and heavier. */
export interface BossChart {
  /** Stable name; unique across `BOSSES`. */
  readonly id: string;
  readonly phases: readonly BossPhase[];
}

export const BOSSES: readonly BossChart[] = [
  {
    id: 'boss-1',
    phases: [
      {
        id: 'boss-1-phase-1',
        // Deliberate tells: the first phase teaches each move's silhouette.
        moves: [
          { id: 'b1-p1-overhead', telegraphMs: 1350, activeMs: 320, parryWindowMs: 160, damage: 8 },
          { id: 'b1-p1-sweep', telegraphMs: 1200, activeMs: 280, parryWindowMs: 140, damage: 7 },
          { id: 'b1-p1-thrust', telegraphMs: 1500, activeMs: 400, parryWindowMs: 200, damage: 10 },
          { id: 'b1-p1-feint-slash', telegraphMs: 1250, activeMs: 300, parryWindowMs: 150, damage: 8 },
          { id: 'b1-p1-twin-cut', telegraphMs: 1400, activeMs: 360, parryWindowMs: 180, damage: 9 },
          { id: 'b1-p1-low-sweep', telegraphMs: 1150, activeMs: 260, parryWindowMs: 130, damage: 7 },
          { id: 'b1-p1-rising-cut', telegraphMs: 1300, activeMs: 340, parryWindowMs: 170, damage: 9 },
          { id: 'b1-p1-guard-break', telegraphMs: 1250, activeMs: 300, parryWindowMs: 150, damage: 8 },
        ],
      },
      {
        id: 'boss-1-phase-2',
        // The same silhouettes return with a shorter tell and heavier damage.
        moves: [
          { id: 'b1-p2-overhead', telegraphMs: 950, activeMs: 300, parryWindowMs: 150, damage: 10 },
          { id: 'b1-p2-sweep', telegraphMs: 1050, activeMs: 260, parryWindowMs: 130, damage: 9 },
          { id: 'b1-p2-thrust', telegraphMs: 900, activeMs: 340, parryWindowMs: 170, damage: 12 },
          { id: 'b1-p2-feint-slash', telegraphMs: 1100, activeMs: 280, parryWindowMs: 140, damage: 10 },
          { id: 'b1-p2-twin-cut', telegraphMs: 1000, activeMs: 320, parryWindowMs: 160, damage: 11 },
          { id: 'b1-p2-low-sweep', telegraphMs: 950, activeMs: 260, parryWindowMs: 130, damage: 9 },
          { id: 'b1-p2-rising-cut', telegraphMs: 1050, activeMs: 300, parryWindowMs: 150, damage: 12 },
          { id: 'b1-p2-guard-break', telegraphMs: 900, activeMs: 280, parryWindowMs: 140, damage: 10 },
        ],
      },
    ],
  },
  {
    id: 'boss-2',
    phases: [
      {
        id: 'boss-2-phase-1',
        // Wider arcs and a slower stomp, but every hit already reads as heavy.
        moves: [
          { id: 'b2-p1-cleave', telegraphMs: 1450, activeMs: 360, parryWindowMs: 180, damage: 9 },
          { id: 'b2-p1-backhand', telegraphMs: 1300, activeMs: 320, parryWindowMs: 160, damage: 8 },
          { id: 'b2-p1-stomp', telegraphMs: 1600, activeMs: 420, parryWindowMs: 210, damage: 11 },
          { id: 'b2-p1-charge', telegraphMs: 1400, activeMs: 340, parryWindowMs: 170, damage: 9 },
          { id: 'b2-p1-spin', telegraphMs: 1500, activeMs: 380, parryWindowMs: 190, damage: 10 },
          { id: 'b2-p1-hook', telegraphMs: 1250, activeMs: 300, parryWindowMs: 150, damage: 8 },
          { id: 'b2-p1-slam', telegraphMs: 1350, activeMs: 340, parryWindowMs: 170, damage: 9 },
        ],
      },
      {
        id: 'boss-2-phase-2',
        // Phase two compresses the wind-ups and pushes every hit into double digits.
        moves: [
          { id: 'b2-p2-cleave', telegraphMs: 1050, activeMs: 320, parryWindowMs: 160, damage: 11 },
          { id: 'b2-p2-backhand', telegraphMs: 1150, activeMs: 300, parryWindowMs: 150, damage: 10 },
          { id: 'b2-p2-stomp', telegraphMs: 1000, activeMs: 360, parryWindowMs: 180, damage: 13 },
          { id: 'b2-p2-charge', telegraphMs: 1100, activeMs: 310, parryWindowMs: 155, damage: 11 },
          { id: 'b2-p2-spin', telegraphMs: 950, activeMs: 300, parryWindowMs: 150, damage: 12 },
          { id: 'b2-p2-hook', telegraphMs: 1100, activeMs: 320, parryWindowMs: 160, damage: 10 },
          { id: 'b2-p2-slam', telegraphMs: 1000, activeMs: 300, parryWindowMs: 150, damage: 12 },
        ],
      },
    ],
  },
  {
    id: 'boss-3',
    phases: [
      {
        id: 'boss-3-phase-1',
        // A brawler that closes the distance: short, blunt tells instead of blades.
        moves: [
          { id: 'b3-p1-cross-cut', telegraphMs: 1280, activeMs: 300, parryWindowMs: 150, damage: 9 },
          { id: 'b3-p1-backfist', telegraphMs: 1150, activeMs: 260, parryWindowMs: 130, damage: 8 },
          { id: 'b3-p1-knee', telegraphMs: 1220, activeMs: 280, parryWindowMs: 140, damage: 8 },
          { id: 'b3-p1-spin-kick', telegraphMs: 1350, activeMs: 340, parryWindowMs: 170, damage: 10 },
          { id: 'b3-p1-shoulder', telegraphMs: 1180, activeMs: 270, parryWindowMs: 135, damage: 8 },
          { id: 'b3-p1-double-palm', telegraphMs: 1300, activeMs: 310, parryWindowMs: 155, damage: 9 },
          { id: 'b3-p1-low-kick', telegraphMs: 1120, activeMs: 250, parryWindowMs: 125, damage: 8 },
          { id: 'b3-p1-elbow', telegraphMs: 1240, activeMs: 290, parryWindowMs: 145, damage: 9 },
        ],
      },
      {
        id: 'boss-3-phase-2',
        // No new shapes: the same eight unarmed moves arrive faster and hit harder.
        moves: [
          { id: 'b3-p2-cross-cut', telegraphMs: 980, activeMs: 280, parryWindowMs: 140, damage: 11 },
          { id: 'b3-p2-backfist', telegraphMs: 900, activeMs: 240, parryWindowMs: 120, damage: 10 },
          { id: 'b3-p2-knee', telegraphMs: 950, activeMs: 260, parryWindowMs: 130, damage: 11 },
          { id: 'b3-p2-spin-kick', telegraphMs: 1040, activeMs: 320, parryWindowMs: 160, damage: 13 },
          { id: 'b3-p2-shoulder', telegraphMs: 920, activeMs: 250, parryWindowMs: 125, damage: 10 },
          { id: 'b3-p2-double-palm', telegraphMs: 1010, activeMs: 290, parryWindowMs: 145, damage: 12 },
          { id: 'b3-p2-low-kick', telegraphMs: 880, activeMs: 230, parryWindowMs: 115, damage: 10 },
          { id: 'b3-p2-elbow', telegraphMs: 960, activeMs: 270, parryWindowMs: 135, damage: 12 },
        ],
      },
    ],
  },
];
