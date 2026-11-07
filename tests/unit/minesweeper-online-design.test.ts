import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESIGN_PATH = join(ROOT, 'docs', 'minesweeper-online-design.md');
const DESIGN = readFileSync(DESIGN_PATH, 'utf8');

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

interface LifecycleState {
  readonly name: string;
  readonly kind: string;
  readonly timers: readonly string[];
}

interface LifecycleEvent {
  readonly name: string;
  readonly source: string;
}

interface LifecycleTransition {
  readonly id: string;
  readonly from: string;
  readonly event: string;
  readonly to: string;
  readonly timer?: string;
  readonly guard: string;
}

interface LifecycleTimer {
  readonly scope: string;
  readonly defaultMs: number;
  readonly start: string;
  readonly reset: string;
  readonly onExpire: string;
  readonly reason: string;
}

interface LifecycleDesign {
  readonly version: number;
  readonly initial: string;
  readonly terminalStates: readonly string[];
  readonly terminalExitEvents: readonly string[];
  readonly capacity: number;
  readonly states: readonly LifecycleState[];
  readonly events: readonly LifecycleEvent[];
  readonly timers: Readonly<Record<string, LifecycleTimer>>;
  readonly transitions: readonly LifecycleTransition[];
}

interface ProtocolTurn {
  readonly actionsPerTurn: number;
  readonly firstTurn: string;
  readonly order: string;
  readonly flagConsumesTurn: boolean;
}

interface ProtocolAdjudication {
  readonly mineHit: string;
  readonly winCondition: string;
  readonly engine: string;
  readonly serverValidates: readonly string[];
}

interface ProtocolSeed {
  readonly source: string;
  readonly algorithm: string;
  readonly firstClickSafe: boolean;
  readonly clientMayChooseSeed: boolean;
  readonly commitment: string;
  readonly replayRecord: readonly string[];
}

interface ProtocolOrdering {
  readonly mode: string;
  readonly sequence: string;
  readonly clientExpectedSeq: boolean;
  readonly idempotencyKey: string;
  readonly conflict: string;
  readonly turnOwnership: string;
}

interface ProtocolVisibility {
  readonly snapshotHidesMines: boolean;
  readonly revealMinesAt: string;
  readonly perPlayerView: string;
}

interface ProtocolDisconnect {
  readonly presence: string;
  readonly graceMs: number;
  readonly immediateRoomTransition: boolean;
  readonly resume: string;
  readonly expiry: string;
}

interface ProtocolHosting {
  readonly requiresServer: boolean;
  readonly staticHostingOnly: boolean;
  readonly mvp: string;
  readonly stateStore: string;
  readonly persistence: string;
  readonly reason: string;
}

interface ProtocolDesign {
  readonly version: number;
  readonly implementationStatus: string;
  readonly transport: Readonly<Record<string, string>>;
  readonly syncModel: string;
  readonly authority: string;
  readonly board: string;
  readonly playersPerRoom: number;
  readonly turn: ProtocolTurn;
  readonly adjudication: ProtocolAdjudication;
  readonly seed: ProtocolSeed;
  readonly ordering: ProtocolOrdering;
  readonly visibility: ProtocolVisibility;
  readonly disconnect: ProtocolDisconnect;
  readonly hosting: ProtocolHosting;
  readonly messages: readonly DesignMessage[];
}

interface ReconnectHeartbeat {
  readonly channel: string;
  readonly intervalMs: number;
  readonly missedBeats: number;
  readonly detectMs: number;
  readonly clock: string;
  readonly onDetect: string;
}

interface ReconnectGrace {
  readonly graceMs: number;
  readonly startsAt: string;
  readonly seatReserved: boolean;
  readonly pauseOnDisconnect: boolean;
  readonly pauseTimers: boolean;
  readonly playingCurrent: string;
  readonly playingOther: string;
  readonly lobby: string;
  readonly finished: string;
}

interface ReconnectForfeit {
  readonly timer: string;
  readonly timeoutMs: number;
  readonly startsAt: string;
  readonly when: string;
  readonly outcome: string;
}

interface ReconnectRecovery {
  readonly method: string;
  readonly eventReplay: boolean;
  readonly auth: string;
  readonly includes: readonly string[];
  readonly onFinished: string;
  readonly onDissolved: string;
}

interface ReconnectIdempotency {
  readonly reconnect: string;
  readonly duplicateJoin: string;
  readonly duplicateAction: string;
  readonly duplicateTimeout: string;
  readonly socketRace: string;
}

interface ReconnectHosting {
  readonly topology: string;
  readonly p2p: boolean;
  readonly hostMigration: string;
  readonly hostDisconnectInLobby: string;
  readonly hostDisconnectInMatch: string;
}

interface ReconnectState {
  readonly name: string;
  readonly reconnect: string;
  readonly reason: string;
  readonly graceOutcome: string;
  readonly recovery: string;
}

interface ReconnectOutcome {
  readonly id: string;
  readonly kind: string;
  readonly from: string;
  readonly event?: string;
  readonly to: string;
  readonly timer?: string;
  readonly transition: string;
  readonly recovery?: string;
  readonly guard?: string;
}

interface ReconnectDesign {
  readonly version: number;
  readonly status: string;
  readonly heartbeat: ReconnectHeartbeat;
  readonly grace: ReconnectGrace;
  readonly forfeit: ReconnectForfeit;
  readonly recovery: ReconnectRecovery;
  readonly idempotency: ReconnectIdempotency;
  readonly hosting: ReconnectHosting;
  readonly states: readonly ReconnectState[];
  readonly outcomes: readonly ReconnectOutcome[];
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
const protocol = readJsonBlock('design:protocol') as ProtocolDesign;
const reconnect = readJsonBlock('design:reconnect') as ReconnectDesign;

const STATES = lifecycle.states.map((state) => state.name);
const STATE_SET = new Set(STATES);
const TRANSITIONS = lifecycle.transitions;
const EVENTS = new Set(TRANSITIONS.map((transition) => transition.event));

function transitionTargets(): Map<string, string[]> {
  const adjacency = new Map<string, string[]>(STATES.map((name) => [name, []]));
  for (const transition of TRANSITIONS) {
    adjacency.get(transition.from)?.push(transition.to);
  }
  return adjacency;
}

function fieldNamesOf(type: string): Set<string> {
  const message = protocol.messages.find((candidate) => candidate.type === type);
  if (message === undefined) {
    throw new Error(`Missing protocol message: ${type}.`);
  }
  return new Set(message.fields.map((field) => field.name));
}

describe('minesweeper online room lifecycle design', () => {
  it('declares the six room states and starts from idle', () => {
    expect(lifecycle.version).toBe(1);
    expect(lifecycle.capacity).toBe(2);
    expect(new Set(STATES).size).toBe(STATES.length);
    expect(STATE_SET.has(lifecycle.initial)).toBe(true);
    for (const name of ['idle', 'waiting', 'ready', 'playing', 'finished', 'dissolved']) {
      expect(STATE_SET.has(name)).toBe(true);
    }
    expect(lifecycle.terminalStates).toEqual(expect.arrayContaining(['finished', 'dissolved']));
    for (const terminal of lifecycle.terminalStates) {
      expect(STATE_SET.has(terminal)).toBe(true);
    }
  });

  it('keeps every transition inside declared states and events', () => {
    const declaredEvents = new Set(lifecycle.events.map((event) => event.name));
    const ids = new Set<string>();
    for (const transition of TRANSITIONS) {
      expect(STATE_SET.has(transition.from)).toBe(true);
      expect(STATE_SET.has(transition.to)).toBe(true);
      expect(declaredEvents.has(transition.event)).toBe(true);
      expect(transition.id.length).toBeGreaterThan(0);
      expect(ids.has(transition.id)).toBe(false);
      ids.add(transition.id);
      expect(transition.guard.length).toBeGreaterThan(0);
      if (transition.timer !== undefined) {
        expect(lifecycle.timers[transition.timer]).toBeDefined();
      }
    }
  });

  it('reaches every declared state from the initial state', () => {
    const adjacency = transitionTargets();
    const visited = new Set<string>();
    const queue: string[] = [lifecycle.initial];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current)) {
        continue;
      }
      visited.add(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          queue.push(next);
        }
      }
    }
    expect([...visited].sort()).toEqual([...STATES].sort());
  });

  it('allows only rematch and dissolve to leave terminal states', () => {
    const terminal = new Set(lifecycle.terminalStates);
    const allowed = new Set(lifecycle.terminalExitEvents);
    expect([...allowed].sort()).toEqual(['dissolve', 'rematch']);
    for (const transition of TRANSITIONS) {
      if (terminal.has(transition.from)) {
        expect(allowed.has(transition.event)).toBe(true);
      }
    }
    expect(TRANSITIONS.filter((transition) => transition.from === 'dissolved')).toHaveLength(0);
    expect(
      TRANSITIONS.some(
        (transition) => transition.from === 'finished' && transition.event === 'rematch',
      ),
    ).toBe(true);
  });

  it('covers create, join, ready, start, end and timeout', () => {
    for (const event of ['create', 'join', 'ready', 'start', 'end', 'timeout']) {
      expect(EVENTS.has(event)).toBe(true);
    }
  });

  it('defines join, turn and match timers with timeout transitions', () => {
    const join = lifecycle.timers.join;
    const turn = lifecycle.timers.turn;
    const match = lifecycle.timers.match;
    expect(join).toBeDefined();
    expect(turn).toBeDefined();
    expect(match).toBeDefined();
    if (join === undefined || turn === undefined || match === undefined) {
      throw new Error('The design must declare join, turn and match timers.');
    }
    for (const timer of [join, turn, match]) {
      expect(timer.defaultMs).toBeGreaterThan(0);
      expect(timer.onExpire.length).toBeGreaterThan(0);
      expect(timer.reason.length).toBeGreaterThan(0);
    }
    expect(join.start).toBe('create');
    expect(join.reset).toBe('on-rematch');
    expect(turn.defaultMs).toBeLessThan(match.defaultMs);
    expect(match.reset).toBe('never');

    const timeoutTimers = new Set(
      TRANSITIONS.filter((transition) => transition.event === 'timeout').map(
        (transition) => transition.timer,
      ),
    );
    expect(timeoutTimers.has('join')).toBe(true);
    expect(timeoutTimers.has('turn')).toBe(true);
    expect(timeoutTimers.has('match')).toBe(true);

    const byName = new Map(lifecycle.states.map((state) => [state.name, state]));
    expect(byName.get('waiting')?.timers).toContain('join');
    expect(byName.get('ready')?.timers).toContain('join');
    expect(byName.get('playing')?.timers).toEqual(expect.arrayContaining(['turn', 'match']));
    for (const terminal of lifecycle.terminalStates) {
      expect(byName.get(terminal)?.timers ?? []).toHaveLength(0);
    }
  });
});

describe('minesweeper online sync and adjudication protocol', () => {
  it('fixes the turn-based, server-authoritative shared-board model', () => {
    expect(protocol.version).toBe(1);
    expect(protocol.implementationStatus).toBe('design-only');
    expect(protocol.syncModel).toBe('turn-based');
    expect(protocol.authority).toBe('server');
    expect(protocol.board).toBe('shared');
    expect(protocol.playersPerRoom).toBe(2);
    expect(protocol.turn.actionsPerTurn).toBe(1);
    expect(protocol.turn.firstTurn).toBe('host');
    expect(protocol.turn.flagConsumesTurn).toBe(true);
    expect(protocol.adjudication.mineHit).toBe('server');
    expect(protocol.adjudication.engine).toBe('MinesweeperEngine');
    expect(protocol.hosting.requiresServer).toBe(true);
    expect(protocol.hosting.staticHostingOnly).toBe(false);
  });

  it('locks deterministic seed and first-click safety', () => {
    expect(protocol.seed.source).toBe('server');
    expect(protocol.seed.algorithm).toBe('mulberry32');
    expect(protocol.seed.firstClickSafe).toBe(true);
    expect(protocol.seed.clientMayChooseSeed).toBe(false);
    expect(protocol.seed.commitment).toBe('sha256(seed)');
    expect(protocol.seed.replayRecord).toEqual(['seed', 'config', 'orderedActions']);
  });

  it('serializes actions and rejects stale or duplicate input', () => {
    expect(protocol.ordering.mode).toBe('server-serialized');
    expect(protocol.ordering.sequence).toBe('monotonic-seq');
    expect(protocol.ordering.clientExpectedSeq).toBe(true);
    expect(protocol.ordering.idempotencyKey).toBe('actionId');
    expect(protocol.ordering.conflict).toBe('reject-stale-and-resync');
    expect(protocol.ordering.turnOwnership).toBe('only-current-player');
    expect(protocol.visibility.snapshotHidesMines).toBe(true);
    expect(protocol.visibility.revealMinesAt).toBe('end');
  });

  it('keeps disconnect presence outside the room state machine', () => {
    expect(protocol.disconnect.presence).toBe('per-player');
    expect(protocol.disconnect.graceMs).toBeGreaterThan(0);
    expect(protocol.disconnect.immediateRoomTransition).toBe(false);
    expect(protocol.disconnect.resume).toBe('snapshot-at-current-seq');
    expect(protocol.disconnect.expiry).toBe('timeout');
  });

  it('publishes complete messages with directions and fields', () => {
    const seen = new Set<string>();
    for (const message of protocol.messages) {
      expect(message.type.length).toBeGreaterThan(0);
      expect(seen.has(message.type)).toBe(false);
      seen.add(message.type);
      expect(['client-to-server', 'server-to-client']).toContain(message.direction);
      expect(message.fields.length).toBeGreaterThan(0);

      const fieldNames = new Set<string>();
      for (const field of message.fields) {
        expect(field.name.length).toBeGreaterThan(0);
        expect(field.type.length).toBeGreaterThan(0);
        expect(typeof field.required).toBe('boolean');
        expect(fieldNames.has(field.name)).toBe(false);
        fieldNames.add(field.name);
      }
    }

    for (const type of [
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
    ]) {
      expect(seen.has(type)).toBe(true);
    }

    expect(protocol.messages.some((message) => message.direction === 'client-to-server')).toBe(
      true,
    );
    expect(protocol.messages.some((message) => message.direction === 'server-to-client')).toBe(
      true,
    );

    const byType = new Map(protocol.messages.map((message) => [message.type, message]));
    expect(byType.get('join')?.direction).toBe('client-to-server');
    expect(byType.get('action')?.direction).toBe('client-to-server');
    expect(byType.get('snapshot')?.direction).toBe('server-to-client');
    expect(byType.get('end')?.direction).toBe('server-to-client');

    for (const name of ['roomId', 'matchId', 'actionId', 'seq', 'turnId', 'kind', 'row', 'col']) {
      expect(fieldNamesOf('action').has(name)).toBe(true);
    }
    for (const name of ['seq', 'turnPlayerId', 'turnId', 'seedHash', 'deadlineAt', 'board']) {
      expect(fieldNamesOf('snapshot').has(name)).toBe(true);
    }
    for (const name of ['roomId', 'seq', 'state', 'playerToken']) {
      expect(fieldNamesOf('room_state').has(name)).toBe(true);
    }
    for (const name of ['seq', 'timer', 'resultingState']) {
      expect(fieldNamesOf('timeout').has(name)).toBe(true);
    }
    for (const name of ['reason', 'winnerId', 'finalSnapshot', 'seed']) {
      expect(fieldNamesOf('end').has(name)).toBe(true);
    }
    for (const name of ['requestId', 'roomId', 'protocolVersion', 'playerToken']) {
      expect(fieldNamesOf('join').has(name)).toBe(true);
    }
  });
});

describe('minesweeper online disconnect and reconnect design', () => {
  it('orders heartbeat detection before grace before forfeit', () => {
    expect(reconnect.version).toBe(1);
    const { detectMs } = reconnect.heartbeat;
    const { graceMs } = reconnect.grace;
    const { timeoutMs } = reconnect.forfeit;
    for (const value of [detectMs, graceMs, timeoutMs]) {
      expect(value).toBeGreaterThan(0);
    }
    expect(reconnect.heartbeat.intervalMs).toBeGreaterThan(0);
    expect(reconnect.heartbeat.missedBeats).toBeGreaterThan(0);
    expect(reconnect.heartbeat.intervalMs * reconnect.heartbeat.missedBeats).toBe(detectMs);
    expect(detectMs).toBeLessThan(graceMs);
    expect(graceMs).toBeLessThan(timeoutMs);
    expect(graceMs).toBe(protocol.disconnect.graceMs);

    const turnTimer = lifecycle.timers.turn;
    expect(turnTimer).toBeDefined();
    if (turnTimer === undefined) {
      throw new Error('The design must declare the turn timer.');
    }
    expect(reconnect.forfeit.timer).toBe('turn');
    expect(timeoutMs).toBe(turnTimer.defaultMs);
  });

  it('maps every room state to an explicit reconnect policy', () => {
    const declared = new Set(STATES);
    const names = reconnect.states.map((state) => state.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of STATES) {
      expect(names).toContain(name);
    }

    const allowed = new Set(['waiting', 'ready', 'playing', 'finished']);
    const rejected = new Set(['idle', 'dissolved']);
    for (const state of reconnect.states) {
      expect(declared.has(state.name)).toBe(true);
      expect(['allowed', 'rejected']).toContain(state.reconnect);
      if (allowed.has(state.name)) {
        expect(state.reconnect).toBe('allowed');
      }
      if (rejected.has(state.name)) {
        expect(state.reconnect).toBe('rejected');
      }
      expect(state.reason.length).toBeGreaterThan(0);
      expect(state.graceOutcome.length).toBeGreaterThan(0);
      expect(state.recovery.length).toBeGreaterThan(0);
    }

    const playing = reconnect.states.find((state) => state.name === 'playing');
    expect(playing?.recovery).toBe(reconnect.recovery.method);
    expect(reconnect.recovery.method).toBe('snapshot-at-current-seq');
    expect(reconnect.recovery.eventReplay).toBe(false);
    expect(reconnect.recovery.method).toBe(protocol.disconnect.resume);
    expect(reconnect.recovery.onDissolved).toBe('room-not-found');
    expect(reconnect.recovery.onFinished).toBe('end');
  });

  it('keeps every disconnect, timeout and reconnect outcome inside the state machine', () => {
    const terminal = new Set(lifecycle.terminalStates);
    const transitionsById = new Map(TRANSITIONS.map((transition) => [transition.id, transition]));

    for (const outcome of reconnect.outcomes) {
      expect(outcome.id.length).toBeGreaterThan(0);
      expect(STATE_SET.has(outcome.from)).toBe(true);
      expect(STATE_SET.has(outcome.to)).toBe(true);

      if (outcome.transition === 'state-preserving') {
        expect(outcome.from).toBe(outcome.to);
        continue;
      }
      if (outcome.transition === 'rejected') {
        expect(outcome.from).toBe(outcome.to);
        expect(terminal.has(outcome.to)).toBe(true);
        continue;
      }

      const transition = transitionsById.get(outcome.transition);
      expect(transition).toBeDefined();
      if (transition === undefined) {
        continue;
      }
      expect(transition.from).toBe(outcome.from);
      expect(transition.event).toBe(outcome.event);
      expect(transition.to).toBe(outcome.to);
      if (outcome.timer !== undefined) {
        expect(transition.timer).toBe(outcome.timer);
        expect(lifecycle.timers[outcome.timer]?.defaultMs ?? 0).toBeGreaterThan(0);
      }
    }

    for (const id of [
      'waiting-join-timeout',
      'ready-join-timeout',
      'playing-turn-timeout',
      'playing-match-timeout',
      'waiting-seat-release',
      'ready-seat-release',
      'waiting-host-dissolve',
      'ready-host-dissolve',
      'reconnect-playing',
      'reconnect-finished',
      'reconnect-dissolved',
    ]) {
      expect(reconnect.outcomes.some((outcome) => outcome.id === id)).toBe(true);
    }

    for (const state of ['waiting', 'ready', 'playing', 'finished', 'dissolved']) {
      expect(
        reconnect.outcomes.some((outcome) => outcome.kind === 'reconnect' && outcome.from === state),
      ).toBe(true);
    }

    for (const outcome of reconnect.outcomes.filter((candidate) => candidate.from === 'playing')) {
      expect(['playing', 'finished']).toContain(outcome.to);
      expect(outcome.to).not.toBe('dissolved');
    }

    const forfeit = reconnect.outcomes.find((outcome) => outcome.id === 'playing-turn-timeout');
    expect(forfeit?.to).toBe('finished');
    expect(forfeit?.transition).toBe('t-turn-timeout');
    expect(terminal.has(reconnect.forfeit.outcome)).toBe(true);

    const dissolvedReconnect = reconnect.outcomes.find(
      (outcome) => outcome.kind === 'reconnect' && outcome.from === 'dissolved',
    );
    expect(dissolvedReconnect?.transition).toBe('rejected');
    expect(dissolvedReconnect?.recovery).toBe('room-not-found');
  });

  it('continues the match and makes reconnection idempotent', () => {
    expect(reconnect.status).toBe('design-only');
    expect(reconnect.grace.seatReserved).toBe(true);
    expect(reconnect.grace.pauseOnDisconnect).toBe(false);
    expect(reconnect.grace.pauseTimers).toBe(false);
    expect(reconnect.grace.playingCurrent).toBe('forfeit');
    expect(reconnect.grace.playingOther).toBe('wait-until-turn');
    expect(reconnect.grace.lobby).toBe('release-seat-or-dissolve');
    expect(reconnect.grace.finished).toBe('retain-result');
    expect(reconnect.heartbeat.onDetect).toBe('offline');

    for (const value of Object.values(reconnect.idempotency)) {
      expect(value.length).toBeGreaterThan(0);
    }
    expect(reconnect.idempotency.duplicateAction).toBe('actionId-cache');
    expect(reconnect.idempotency.duplicateTimeout).toBe('once-per-seq');

    expect(reconnect.hosting.topology).toBe('server-authoritative');
    expect(reconnect.hosting.p2p).toBe(false);
    expect(reconnect.hosting.hostMigration).toBe('not-applicable');
    expect(reconnect.hosting.hostDisconnectInLobby).toBe('dissolve');
  });
});
