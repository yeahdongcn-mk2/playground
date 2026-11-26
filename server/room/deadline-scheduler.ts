/**
 * Room deadline scheduler for the online Minesweeper room service (#485,
 * design 3.4).
 *
 * The scheduler owns one timer per live room and nothing else. It reads the
 * room state together with its join/turn/match deadlines from an injected room
 * source, arms a single timer for the earliest of them, and when that timer
 * fires asks the room manager's `timeout(roomId, timer)` to adjudicate. The
 * room manager stays the only writer of room state: the scheduler never edits
 * a `RoomRecord`, never moves `seq`/`turnId`, and never decides a winner. The
 * deliveries the manager returns are handed to the injected sink, so the
 * scheduler does not know about sockets, connections or the transport either.
 *
 * Responsibilities stay split three ways:
 *
 * - the room manager owns room/match state and rejects a timeout that is early
 *   (`deadline-passed`) or no longer applicable (`invalid-state`);
 * - the transport calls {@link DeadlineScheduler.refresh} after a command that
 *   moves a deadline (`create`, `join`, `start`, `action`, `rematch`, `leave`);
 * - this module only decides *when* to ask, keeps at most one timer in flight
 *   per room, and never produces a room event itself.
 *
 * One timer per room is the idempotency rule. A refresh cancels the previous
 * handle before arming the new deadline, and the callback proves it is still
 * the current generation before running, so a duplicated wakeup or a second
 * refresh cannot produce a second `timeout`. If a timer wakes before the
 * manager's clock reaches the deadline, the manager rejects it with
 * `deadline-passed`; the scheduler does not deliver that rejection on the wire
 * and simply re-arms for the remaining time. If the room has already moved to
 * `finished`, `dissolved` or vanished, the callback is a no-op.
 *
 * The clock and timer surface is injectable. The default is `Date.now` plus the
 * global one-shot timers, so production needs no configuration, while tests can
 * use a virtual clock and never sleep.
 */

import type { TimeoutTimer } from '../../src/games/minesweeper/online/index';
import type {
  RoomCommandResult,
  RoomDelivery,
  RoomId,
  RoomRecord,
} from './contracts';

/** Opaque one-shot timer handle owned by an injected {@link DeadlineClock}. */
export type DeadlineTimer = ReturnType<typeof setTimeout>;

/**
 * Clock and one-shot timer surface the scheduler runs on.
 *
 * The manager is expected to use the same clock (or an equivalent one), since
 * the scheduler and the manager both compare their `now()` against the room
 * deadlines. Injecting the whole surface keeps that in one place for tests and
 * lets a host swap in a virtual clock without touching the scheduler.
 */
export interface DeadlineClock {
  /** Current server time in milliseconds. */
  now(): number;
  /** Schedule a one-shot timer. */
  setTimeout(callback: () => void, delayMs: number): DeadlineTimer;
  /** Cancel a one-shot timer created by {@link DeadlineClock.setTimeout}. */
  clearTimeout(handle: DeadlineTimer): void;
}

/**
 * The match fields the scheduler needs to rank the turn and match deadlines.
 *
 * `MatchState` satisfies this structurally; keeping the seam narrow means the
 * scheduler never reaches into the board, replay log or verdict.
 */
export interface DeadlineMatchSource {
  readonly state: {
    /** Absolute deadline of the current turn. */
    readonly turnDeadlineAt: number;
    /** Absolute deadline of the whole match. */
    readonly matchDeadlineAt: number;
  };
}

/**
 * Room-layer half of the deadline seam.
 *
 * `InMemoryRoomManager` satisfies it as-is: `getRoom`/`getMatch` are the
 * read-only projection of the table, and `timeout` is the only room command the
 * scheduler may issue. No setter or direct record mutation is exposed.
 */
export interface DeadlineRoomManager {
  /** Live room record, or `undefined` once the room was dissolved/removed. */
  getRoom(roomId: RoomId): RoomRecord | undefined;
  /** Match handle of a playing/finished room, or `null` without a match. */
  getMatch(roomId: RoomId): DeadlineMatchSource | null;
  /** Ask the room layer to adjudicate one expired lifecycle timer. */
  timeout(roomId: RoomId, timer: TimeoutTimer): RoomCommandResult;
}

/**
 * Receives the room messages produced by a scheduler-driven timeout.
 *
 * The transport owns sockets, so it is also the only layer that can send a
 * delivery. The scheduler hands over the exact `deliveries` array the room
 * manager returned; an early rejection is never handed over because it is not
 * a room event and has no recipient.
 */
export type DeadlineDeliverySink = (deliveries: readonly RoomDelivery[]) => void;

/** Construction options for {@link createDeadlineScheduler}. */
export interface DeadlineSchedulerOptions {
  /** Room state source and the only command the scheduler may issue. */
  readonly manager: DeadlineRoomManager;
  /** Delivery sink for the room messages a timeout produced. */
  readonly deliver: DeadlineDeliverySink;
  /** Clock and one-shot timer surface; defaults to `Date.now` and global timers. */
  readonly clock?: DeadlineClock;
}

/**
 * Public scheduler surface.
 *
 * `refresh` is the single integration point: call it after every command that
 * may advance `joinDeadlineAt`, `turnDeadlineAt` or `matchDeadlineAt`, and after
 * any other transition that can leave or enter a timer state. `cancel` drops a
 * room that is closing; `cancelAll` releases every handle on shutdown.
 */
export interface DeadlineScheduler {
  /** Recompute the earliest deadline for one room and re-arm its timer. */
  refresh(roomId: RoomId): void;
  /** Cancel one room's timer and stop tracking it. */
  cancel(roomId: RoomId): void;
  /** Cancel every timer; used when the room service shuts down. */
  cancelAll(): void;
  /** Number of rooms with an in-flight timer, for health reporting and tests. */
  readonly scheduledRoomCount: number;
}

/** Default clock: relative deadlines only, so `Date.now` is enough. */
const systemDeadlineClock: DeadlineClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** The earliest deadline of one room, with the timer that adjudicates it. */
interface EarliestDeadline {
  readonly timer: TimeoutTimer;
  readonly deadlineAt: number;
}

/** One in-flight timer and the generation token its callback must match. */
interface PendingDeadline {
  readonly timer: TimeoutTimer;
  readonly deadlineAt: number;
  handle: DeadlineTimer | null;
}

/**
 * Earliest deadline of a room, or `null` when it must not have a timer.
 *
 * - `waiting` / `ready` use the one `join` window shared by both states;
 * - `playing` compares the turn deadline with the hard match cap and returns
 *   whichever comes first. On an exact tie the match cap wins: it ends the
 *   match by safe-cell ranking instead of forfeiting the current player, which
 *   is what design 3.4 asks for at the 15-minute boundary;
 * - `finished` / `dissolved` and an unknown room have no deadline, so a
 *   refresh or a late callback cancels instead of firing.
 */
function earliestDeadline(
  manager: DeadlineRoomManager,
  roomId: RoomId,
): EarliestDeadline | null {
  const room = manager.getRoom(roomId);
  if (room === undefined) {
    return null;
  }
  if (room.state === 'waiting' || room.state === 'ready') {
    return { timer: 'join', deadlineAt: room.joinDeadlineAt };
  }
  if (room.state !== 'playing') {
    return null;
  }
  const match = manager.getMatch(roomId);
  if (match === null) {
    return null;
  }
  const turn: EarliestDeadline = {
    timer: 'turn',
    deadlineAt: match.state.turnDeadlineAt,
  };
  const matchCap: EarliestDeadline = {
    timer: 'match',
    deadlineAt: match.state.matchDeadlineAt,
  };
  return matchCap.deadlineAt <= turn.deadlineAt ? matchCap : turn;
}

/**
 * Build a deadline scheduler.
 *
 * The returned object implements {@link DeadlineScheduler}; it owns every
 * timer it creates and no room state. Methods are synchronous and safe to call
 * for an unknown, finished or already-cancelled room: a refresh from a late
 * command simply cancels, and a callback whose generation was replaced is
 * ignored.
 */
export function createDeadlineScheduler(
  options: DeadlineSchedulerOptions,
): DeadlineScheduler {
  const manager = options.manager;
  const deliver = options.deliver;
  const clock = options.clock ?? systemDeadlineClock;
  const pending = new Map<RoomId, PendingDeadline>();

  /**
   * Arm the one timer of a room.
   *
   * `minimumDelayMs` is normally zero: a deadline that is already due fires on
   * the next tick. The early-rejection retry passes 1 ms so two clocks that
   * disagree by a few milliseconds cannot spin in a zero-delay loop.
   */
  function arm(roomId: RoomId, deadline: EarliestDeadline, minimumDelayMs = 0): void {
    const entry: PendingDeadline = {
      timer: deadline.timer,
      deadlineAt: deadline.deadlineAt,
      handle: null,
    };
    const delayMs = Math.max(minimumDelayMs, deadline.deadlineAt - clock.now());
    entry.handle = clock.setTimeout(() => fire(roomId, entry), delayMs);
    pending.set(roomId, entry);
  }

  /** Drop one room's in-flight timer, if any. */
  function cancel(roomId: RoomId): void {
    const entry = pending.get(roomId);
    if (entry === undefined) {
      return;
    }
    pending.delete(roomId);
    if (entry.handle !== null) {
      clock.clearTimeout(entry.handle);
    }
  }

  /** Recompute the earliest deadline and replace the room's one timer. */
  function refresh(roomId: RoomId): void {
    cancel(roomId);
    const deadline = earliestDeadline(manager, roomId);
    if (deadline !== null) {
      arm(roomId, deadline);
    }
  }

  /**
   * Run one due timer.
   *
   * The generation check makes duplicate wakeups and wakeups superseded by a
   * refresh inert. The room manager remains the adjudicator: a successful
   * timeout is delivered and the room is re-read (it is now `finished` or was
   * removed), an early `deadline-passed` is retried without touching the wire,
   * and a stale `invalid-state`/`room-not-found` is dropped so a second
   * terminal result can never be produced.
   */
  function fire(roomId: RoomId, entry: PendingDeadline): void {
    if (pending.get(roomId) !== entry) {
      return;
    }
    pending.delete(roomId);

    const deadline = earliestDeadline(manager, roomId);
    if (deadline === null) {
      return;
    }

    const result = manager.timeout(roomId, deadline.timer);
    if (result.ok) {
      deliver(result.deliveries);
      // A timeout moves the room to `finished` or removes it, so this cancels
      // rather than re-arms in practice; re-reading keeps the invariant local
      // even if a future lifecycle transition leaves a running deadline.
      refresh(roomId);
      return;
    }
    if (result.code === 'deadline-passed') {
      // The timer woke before the manager's clock reached the deadline. The
      // room did not change and nothing is broadcast; retry the remainder.
      arm(roomId, deadline, 1);
    }
    // `invalid-state` / `room-not-found`: the room already finished, dissolved
    // or moved on. Dropping the timer is what prevents a second terminal state.
  }

  /** Release every live timer on shutdown. */
  function cancelAll(): void {
    for (const entry of pending.values()) {
      if (entry.handle !== null) {
        clock.clearTimeout(entry.handle);
      }
    }
    pending.clear();
  }

  return {
    refresh,
    cancel,
    cancelAll,
    get scheduledRoomCount() {
      return pending.size;
    },
  };
}
