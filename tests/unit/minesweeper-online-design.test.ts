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
