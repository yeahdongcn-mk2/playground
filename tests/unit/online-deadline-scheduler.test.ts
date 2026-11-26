import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JOIN_TIMEOUT_MS,
  MATCH_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  type MatchCommandResult,
  type RoomCommandResult,
  type RoomCommandSuccess,
  type RoomConnection,
  type RoomDelivery,
} from '../../server/room/contracts';
import {
  createDeadlineScheduler,
  type DeadlineClock,
  type DeadlineScheduler,
  type DeadlineTimer,
} from '../../server/room/deadline-scheduler';
import {
  InMemoryRoomManager,
  createRoomManager,
  type RoomManagerOptions,
} from '../../server/room/room-manager';
import {
  PROTOCOL_VERSION,
  type ActionMessage,
  type CreateMessage,
  type JoinMessage,
  type ReadyMessage,
  type RematchMessage,
  type ServerToClientMessage,
  type StartMessage,
} from '../../src/games/minesweeper/online/index';
import type { MinesweeperConfig } from '../../src/games/minesweeper/engine';

const NOW = 1_700_000_000_000;
const SEED = 7;

const CONFIG: MinesweeperConfig = {
  rows: 9,
  cols: 9,
  mines: 10,
  firstClickSafe: true,
};

let connectionSequence = 0;

function connection(playerToken: string | null = null): RoomConnection {
  connectionSequence += 1;
  return { connectionId: `connection_${connectionSequence}`, playerToken };
}

function createMessage(): CreateMessage {
  return {
    type: 'create',
    requestId: 'req_create',
    protocolVersion: PROTOCOL_VERSION,
    config: CONFIG,
    displayName: 'Ada',
  };
}

function joinMessage(roomId: string): JoinMessage {
  return {
    type: 'join',
    requestId: 'req_join',
    protocolVersion: PROTOCOL_VERSION,
    roomId,
    displayName: 'Grace',
  };
}

function readyMessage(roomId: string, ready: boolean): ReadyMessage {
  return { type: 'ready', roomId, requestId: 'req_ready', ready };
}

function startMessage(roomId: string): StartMessage {
  return { type: 'start', roomId, requestId: 'req_start' };
}

function rematchMessage(roomId: string): RematchMessage {
  return { type: 'rematch', roomId, requestId: 'req_rematch', accept: true };
}

function expectOk(result: RoomCommandResult | MatchCommandResult): RoomCommandSuccess {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.code}: ${result.error.message}`);
  }
  return result;
}

/** Every message handed to the sink, in delivery order. */
function allMessages(
  batches: readonly (readonly RoomDelivery[])[],
): ServerToClientMessage[] {
  return batches.flatMap((batch) => batch.map((delivery) => delivery.message));
}

/** Every delivered message of one type, in delivery order. */
function messagesOfType<T extends ServerToClientMessage['type']>(
  batches: readonly (readonly RoomDelivery[])[],
  type: T,
): Extract<ServerToClientMessage, { readonly type: T }>[] {
  return allMessages(batches).flatMap((message) =>
    message.type === type
      ? [message as Extract<ServerToClientMessage, { readonly type: T }>]
      : [],
  );
}

interface FakeTimer {
  readonly dueAt: number;
  readonly callback: () => void;
}

/**
 * Deterministic clock/timer double.
 *
 * Nothing here touches the real event loop: `advance` moves virtual time,
 * runs every due callback in due/creation order, and lets callbacks arm new
 * timers at the advanced instant. `earlyWakeCount` makes the next few timers
 * wake early without moving the clock, which models a jittery wakeup and lets
 * a test exercise the manager's `deadline-passed` guard.
 */
class FakeClock implements DeadlineClock {
  private current: number;
  private nextHandle = 0;
  private readonly timers = new Map<number, FakeTimer>();
  private readonly fired: (() => void)[] = [];
  earlyWakeCount = 0;
  earlyWakeMs = 0;

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): DeadlineTimer {
    const handle = (this.nextHandle += 1);
    let effectiveDelay = Math.max(0, delayMs);
    if (this.earlyWakeCount > 0) {
      this.earlyWakeCount -= 1;
      effectiveDelay = Math.max(0, effectiveDelay - this.earlyWakeMs);
    }
    this.timers.set(handle, { dueAt: this.current + effectiveDelay, callback });
    return handle as unknown as DeadlineTimer;
  }

  clearTimeout(handle: DeadlineTimer): void {
    this.timers.delete(handle as unknown as number);
  }

  get timerCount(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.current + Math.max(0, ms);
    for (;;) {
      let nextHandle: number | null = null;
      let nextTimer: FakeTimer | null = null;
      for (const [handle, timer] of this.timers) {
        if (timer.dueAt > target) {
          continue;
        }
        const earlier =
          nextHandle === null ||
          nextTimer === null ||
          timer.dueAt < nextTimer.dueAt ||
          (timer.dueAt === nextTimer.dueAt && handle < nextHandle);
        if (earlier) {
          nextHandle = handle;
          nextTimer = timer;
        }
      }
      if (nextHandle === null || nextTimer === null) {
        break;
      }
      this.timers.delete(nextHandle);
      this.current = Math.max(this.current, nextTimer.dueAt);
      this.fired.push(nextTimer.callback);
      nextTimer.callback();
    }
    this.current = target;
  }

  /** Re-run callbacks that already fired, to model a duplicate wakeup. */
  replayFired(): void {
    for (const callback of this.fired) {
      callback();
    }
  }
}

interface Harness {
  readonly clock: FakeClock;
  readonly manager: InMemoryRoomManager;
  readonly scheduler: DeadlineScheduler;
  /** Every delivery array handed to the scheduler's sink. */
  readonly delivered: (readonly RoomDelivery[])[];
}

function createHarness(managerOptions: RoomManagerOptions = {}): Harness {
  const clock = new FakeClock(NOW);
  const manager = createRoomManager({
    now: () => clock.now(),
    createSeed: () => SEED,
    ...managerOptions,
  });
  const delivered: (readonly RoomDelivery[])[] = [];
  const scheduler = createDeadlineScheduler({
    manager,
    clock,
    deliver(deliveries) {
      delivered.push(deliveries);
    },
  });
  return { clock, manager, scheduler, delivered };
}

interface SeatedRoom {
  readonly roomId: string;
  readonly hostToken: string;
  readonly guestToken: string;
}

function createSeatedRoom(manager: InMemoryRoomManager): SeatedRoom {
  const created = expectOk(manager.create(connection(), createMessage()));
  const hostToken = created.boundToken;
  if (hostToken === undefined) {
    throw new Error('create must bind the host token');
  }
  const roomState = created.deliveries[0]?.message;
  if (roomState?.type !== 'room_state') {
    throw new Error('create must deliver the room state');
  }

  const joined = expectOk(manager.join(connection(), joinMessage(roomState.roomId)));
  const guestToken = joined.boundToken;
  if (guestToken === undefined) {
    throw new Error('join must bind the guest token');
  }
  return { roomId: roomState.roomId, hostToken, guestToken };
}

interface StartedRoom extends SeatedRoom {
  readonly matchId: string;
}

/** create → join → both ready → start; the room is `playing`. */
function startRoom(manager: InMemoryRoomManager): StartedRoom {
  const room = createSeatedRoom(manager);
  expectOk(manager.ready(connection(room.hostToken), readyMessage(room.roomId, true)));
  expectOk(manager.ready(connection(room.guestToken), readyMessage(room.roomId, true)));
  expectOk(manager.start(connection(room.hostToken), startMessage(room.roomId)));
  const match = manager.getMatch(room.roomId);
  if (match === null) {
    throw new Error('start must create a match');
  }
  return { ...room, matchId: match.matchId };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createDeadlineScheduler', () => {
  it('uses the join deadline to dissolve a waiting room exactly once', () => {
    const harness = createHarness();
    const room = createSeatedRoom(harness.manager);

    harness.scheduler.refresh(room.roomId);
    expect(harness.clock.timerCount).toBe(1);

    harness.clock.advance(JOIN_TIMEOUT_MS - 1);
    expect(harness.delivered).toHaveLength(0);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('waiting');

    harness.clock.advance(1);
    const timeouts = messagesOfType(harness.delivered, 'timeout');
    expect(timeouts).toHaveLength(2);
    for (const timeout of timeouts) {
      expect(timeout.timer).toBe('join');
      expect(timeout.resultingState).toBe('dissolved');
      expect(timeout.deadlineAt).toBe(NOW + JOIN_TIMEOUT_MS);
    }
    expect(messagesOfType(harness.delivered, 'room_closed')).toHaveLength(2);
    expect(harness.manager.getRoom(room.roomId)).toBeUndefined();
    expect(harness.scheduler.scheduledRoomCount).toBe(0);
    expect(harness.clock.timerCount).toBe(0);
  });

  it('fires the turn timeout 30 s after start', () => {
    const harness = createHarness();
    const room = startRoom(harness.manager);

    harness.scheduler.refresh(room.roomId);
    harness.clock.advance(TURN_TIMEOUT_MS - 1);
    expect(harness.delivered).toHaveLength(0);

    harness.clock.advance(1);
    const timeouts = messagesOfType(harness.delivered, 'timeout');
    expect(timeouts).toHaveLength(2);
    expect(timeouts[0]?.timer).toBe('turn');
    expect(timeouts[0]?.deadlineAt).toBe(NOW + TURN_TIMEOUT_MS);
    expect(timeouts[0]?.resultingState).toBe('finished');
    expect(messagesOfType(harness.delivered, 'end')[0]?.reason).toBe('turn-timeout');
    expect(messagesOfType(harness.delivered, 'room_state')[0]?.state).toBe('finished');
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('finished');
    expect(harness.clock.timerCount).toBe(0);
  });

  it('fires the 15-minute match cap when the turn window cannot expire first', () => {
    const harness = createHarness({ turnTimeoutMs: MATCH_TIMEOUT_MS * 2 });
    const room = startRoom(harness.manager);
    // The match layer caps the turn at the match deadline, so both expire at
    // the 15-minute boundary and the match cap is the authoritative timer.
    expect(harness.manager.getMatch(room.roomId)?.state.turnDeadlineAt).toBe(
      NOW + MATCH_TIMEOUT_MS,
    );

    harness.scheduler.refresh(room.roomId);
    harness.clock.advance(MATCH_TIMEOUT_MS - 1);
    expect(harness.delivered).toHaveLength(0);

    harness.clock.advance(1);
    const timeouts = messagesOfType(harness.delivered, 'timeout');
    expect(timeouts).toHaveLength(2);
    expect(timeouts[0]?.timer).toBe('match');
    expect(timeouts[0]?.deadlineAt).toBe(NOW + MATCH_TIMEOUT_MS);
    expect(messagesOfType(harness.delivered, 'end')[0]?.reason).toBe('match-timeout');
  });

  it('picks the match deadline when it comes before the turn deadline', () => {
    const harness = createHarness({ turnTimeoutMs: 90_000, matchTimeoutMs: 60_000 });
    const room = startRoom(harness.manager);

    harness.scheduler.refresh(room.roomId);
    harness.clock.advance(59_999);
    expect(harness.delivered).toHaveLength(0);

    harness.clock.advance(1);
    const timeouts = messagesOfType(harness.delivered, 'timeout');
    expect(timeouts).toHaveLength(2);
    expect(timeouts[0]?.timer).toBe('match');
    expect(timeouts[0]?.deadlineAt).toBe(NOW + 60_000);

    // The later turn timer was cancelled together with the match.
    harness.clock.advance(60_000);
    expect(messagesOfType(harness.delivered, 'timeout')).toHaveLength(2);
  });

  it('re-arms after an accepted action moves the turn deadline', () => {
    const harness = createHarness();
    const room = startRoom(harness.manager);
    harness.scheduler.refresh(room.roomId);

    harness.clock.advance(10_000);
    expect(harness.delivered).toHaveLength(0);

    const roomBefore = harness.manager.getRoom(room.roomId);
    const matchBefore = harness.manager.getMatch(room.roomId);
    if (roomBefore === undefined || matchBefore === null) {
      throw new Error('the room must be playing before the action');
    }
    const actor = roomBefore.seats.find(
      (seat) => seat.playerId === roomBefore.turnPlayerId,
    );
    if (actor === undefined) {
      throw new Error('the current turn must belong to a seat');
    }

    const action: ActionMessage = {
      type: 'action',
      roomId: room.roomId,
      matchId: room.matchId,
      actionId: 'action_after_10s',
      seq: roomBefore.seq,
      turnId: matchBefore.state.turnId,
      kind: 'reveal',
      row: 0,
      col: 0,
      clientTimeMs: harness.clock.now(),
    };
    expectOk(harness.manager.action(connection(actor.playerToken), action));

    const matchAfter = harness.manager.getMatch(room.roomId);
    if (matchAfter === null) {
      throw new Error('the match must still be held after an action');
    }
    expect(matchAfter.state.turnDeadlineAt).toBe(NOW + 10_000 + TURN_TIMEOUT_MS);
    const subjectId = matchAfter.state.turnPlayerId;

    harness.scheduler.refresh(room.roomId);
    expect(harness.clock.timerCount).toBe(1);

    // The old 30 s timer was cancelled; only the new 40 s deadline can fire.
    harness.clock.advance(TURN_TIMEOUT_MS - 1);
    expect(harness.delivered).toHaveLength(0);

    harness.clock.advance(1);
    const timeouts = messagesOfType(harness.delivered, 'timeout');
    expect(timeouts).toHaveLength(2);
    expect(timeouts[0]?.timer).toBe('turn');
    expect(timeouts[0]?.deadlineAt).toBe(NOW + 10_000 + TURN_TIMEOUT_MS);
    expect(timeouts[0]?.subjectId).toBe(subjectId);
  });

  it('keeps one timer across repeated refreshes and emits one timeout', () => {
    const harness = createHarness();
    const room = startRoom(harness.manager);

    harness.scheduler.refresh(room.roomId);
    harness.scheduler.refresh(room.roomId);
    harness.scheduler.refresh(room.roomId);
    expect(harness.clock.timerCount).toBe(1);
    expect(harness.scheduler.scheduledRoomCount).toBe(1);

    harness.clock.advance(TURN_TIMEOUT_MS);
    expect(harness.delivered).toHaveLength(1);
    expect(messagesOfType(harness.delivered, 'timeout')).toHaveLength(2);
    expect(messagesOfType(harness.delivered, 'end')).toHaveLength(2);

    // Refreshing a finished room must not resurrect a timer for its retained
    // match deadline.
    harness.scheduler.refresh(room.roomId);
    harness.scheduler.refresh(room.roomId);
    expect(harness.clock.timerCount).toBe(0);
    expect(harness.scheduler.scheduledRoomCount).toBe(0);
    harness.clock.advance(MATCH_TIMEOUT_MS);
    expect(harness.delivered).toHaveLength(1);
  });

  it('ignores a duplicate wakeup after the terminal timeout', () => {
    const harness = createHarness();
    const room = startRoom(harness.manager);
    const timeoutSpy = vi.spyOn(harness.manager, 'timeout');

    harness.scheduler.refresh(room.roomId);
    harness.clock.advance(TURN_TIMEOUT_MS);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    const batches = harness.delivered.length;
    const timeouts = messagesOfType(harness.delivered, 'timeout').length;

    harness.clock.replayFired();
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(harness.delivered).toHaveLength(batches);
    expect(messagesOfType(harness.delivered, 'timeout')).toHaveLength(timeouts);
  });

  it('treats an early wakeup as rejected and still produces one terminal result', () => {
    const harness = createHarness();
    const room = startRoom(harness.manager);
    const timeoutSpy = vi.spyOn(harness.manager, 'timeout');

    // The first timer wakes 100 ms before the deadline, while the clock really
    // is still before it: the manager must reject it without a room event.
    harness.clock.earlyWakeCount = 1;
    harness.clock.earlyWakeMs = 100;
    harness.scheduler.refresh(room.roomId);
    harness.clock.advance(TURN_TIMEOUT_MS - 100);

    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    const early = timeoutSpy.mock.results[0]?.value;
    expect(early?.ok).toBe(false);
    if (early !== undefined && !early.ok) {
      expect(early.code).toBe('deadline-passed');
    }
    expect(harness.delivered).toHaveLength(0);
    expect(harness.clock.timerCount).toBe(1);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('playing');

    // The retry waits out the remaining 100 ms and produces the only timeout.
    harness.clock.advance(100);
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    const timeouts = messagesOfType(harness.delivered, 'timeout');
    expect(timeouts).toHaveLength(2);
    expect(timeouts[0]?.timer).toBe('turn');
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('finished');
    expect(harness.clock.timerCount).toBe(0);
  });

  it('cancels a pending timer when the room finishes without the scheduler', () => {
    const harness = createHarness();
    const room = startRoom(harness.manager);
    harness.scheduler.refresh(room.roomId);
    expect(harness.clock.timerCount).toBe(1);

    expectOk(harness.manager.finishMatch(room.roomId, room.matchId, 'forfeit'));
    harness.scheduler.refresh(room.roomId);
    expect(harness.clock.timerCount).toBe(0);
    expect(harness.scheduler.scheduledRoomCount).toBe(0);

    harness.clock.advance(MATCH_TIMEOUT_MS);
    expect(harness.delivered).toHaveLength(0);
  });

  it('drops the timer when a room is dissolved, even without a refresh', () => {
    const harness = createHarness();
    const room = startRoom(harness.manager);
    const timeoutSpy = vi.spyOn(harness.manager, 'timeout');
    harness.scheduler.refresh(room.roomId);
    expect(harness.clock.timerCount).toBe(1);

    expectOk(harness.manager.dissolve(room.roomId, 'host-left'));
    // No refresh: the armed callback must re-read the table and stand down.
    harness.clock.advance(TURN_TIMEOUT_MS);
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(harness.delivered).toHaveLength(0);
    expect(harness.scheduler.scheduledRoomCount).toBe(0);

    harness.scheduler.refresh(room.roomId);
    expect(harness.clock.timerCount).toBe(0);
  });

  it('re-arms at the restarted join deadline after a rematch', () => {
    const harness = createHarness();
    const room = startRoom(harness.manager);

    harness.scheduler.refresh(room.roomId);
    harness.clock.advance(TURN_TIMEOUT_MS);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('finished');

    expectOk(
      harness.manager.rematch(connection(room.hostToken), rematchMessage(room.roomId)),
    );
    expectOk(
      harness.manager.rematch(connection(room.guestToken), rematchMessage(room.roomId)),
    );
    const ready = harness.manager.getRoom(room.roomId);
    expect(ready?.state).toBe('ready');
    expect(ready?.joinDeadlineAt).toBe(NOW + TURN_TIMEOUT_MS + JOIN_TIMEOUT_MS);

    harness.scheduler.refresh(room.roomId);
    expect(harness.clock.timerCount).toBe(1);

    harness.clock.advance(JOIN_TIMEOUT_MS - 1);
    expect(harness.manager.getRoom(room.roomId)?.state).toBe('ready');
    harness.clock.advance(1);
    expect(harness.manager.getRoom(room.roomId)).toBeUndefined();
    expect(harness.scheduler.scheduledRoomCount).toBe(0);
  });

  it('releases every room timer on cancelAll', () => {
    const harness = createHarness();
    const first = startRoom(harness.manager);
    const second = startRoom(harness.manager);
    harness.scheduler.refresh(first.roomId);
    harness.scheduler.refresh(second.roomId);
    expect(harness.clock.timerCount).toBe(2);
    expect(harness.scheduler.scheduledRoomCount).toBe(2);

    harness.scheduler.cancelAll();
    expect(harness.clock.timerCount).toBe(0);
    expect(harness.scheduler.scheduledRoomCount).toBe(0);

    harness.clock.advance(MATCH_TIMEOUT_MS);
    expect(harness.delivered).toHaveLength(0);
  });

  it('cancels one room timer without touching another room', () => {
    const harness = createHarness();
    const first = startRoom(harness.manager);
    const second = startRoom(harness.manager);
    harness.scheduler.refresh(first.roomId);
    harness.scheduler.refresh(second.roomId);

    harness.scheduler.cancel(first.roomId);
    expect(harness.clock.timerCount).toBe(1);
    expect(harness.scheduler.scheduledRoomCount).toBe(1);

    harness.clock.advance(TURN_TIMEOUT_MS);
    expect(harness.manager.getRoom(first.roomId)?.state).toBe('playing');
    expect(harness.manager.getRoom(second.roomId)?.state).toBe('finished');
    expect(messagesOfType(harness.delivered, 'timeout')).toHaveLength(2);
    expect(harness.scheduler.scheduledRoomCount).toBe(0);
  });
});
