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

interface HostingCandidate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly staticFrontend: boolean;
  readonly ownServer: boolean;
  readonly thirdPartyRealtime: boolean;
  readonly authority: string;
}

interface HostingRejection {
  readonly id: string;
  readonly reason: string;
}

interface HostingReason {
  readonly dimension: string;
  readonly label: string;
  readonly choice: string;
  readonly alternative: string;
}

interface HostingEvolutionStage {
  readonly stage: string;
  readonly change: string;
  readonly invariant: string;
}

interface HostingDesign {
  readonly version: number;
  readonly status: string;
  readonly choice: string;
  readonly candidates: readonly HostingCandidate[];
  readonly rejected: readonly HostingRejection[];
  readonly reasons: readonly HostingReason[];
  readonly references: readonly string[];
  readonly evolution: readonly HostingEvolutionStage[];
  readonly reevaluateWhen: readonly string[];
}

interface ImplementationTask {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly detail: string;
  readonly depends_on: readonly string[];
  readonly handles_events: readonly string[];
  readonly acceptance: readonly string[];
}

interface ImplementationPlanContracts {
  readonly roomStates: readonly string[];
  readonly timersMs: Readonly<Record<string, number>>;
  readonly hostingChoice: string;
  readonly protocolVersion: number;
}

interface ImplementationPlan {
  readonly version: number;
  readonly status: string;
  readonly sourceIssue: number;
  readonly order: string;
  readonly contracts: ImplementationPlanContracts;
  readonly tasks: readonly ImplementationTask[];
}

interface ChapterEntry {
  readonly title: string;
  readonly anchor: string;
}

/** Escape a marker before embedding it in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the anchor GitHub generates for a unique numbered chapter heading. */
function githubAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\p{Pd}\s]/gu, '')
    .replace(/\s/g, '-');
}

/** Parse numbered `## N. 标题` headings outside fenced code blocks. */
function parseChapterHeadings(): Map<number, ChapterEntry> {
  const headings = new Map<number, ChapterEntry>();
  let inFence = false;
  for (const line of DESIGN.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = /^## (\d+)\. (.+)$/.exec(line);
    if (match === null) {
      continue;
    }
    const numberText = match[1];
    const title = match[2];
    if (numberText === undefined || title === undefined) {
      continue;
    }
    const number = Number(numberText);
    if (headings.has(number)) {
      throw new Error(`Duplicate chapter heading ${number} in ${DESIGN_PATH}.`);
    }
    const trimmed = title.trim();
    headings.set(number, {
      title: trimmed,
      anchor: githubAnchor(`${number}. ${trimmed}`),
    });
  }
  return headings;
}

/** Parse the chapter-index table rows of the form `[N. 标题](#anchor)`. */
function parseChapterIndex(index: string): Map<number, ChapterEntry> {
  const entries = new Map<number, ChapterEntry>();
  for (const line of index.split('\n')) {
    const match = /^\|\s*\[(\d+)\. (.+?)\]\(#([^)]+)\)\s*\|/.exec(line);
    if (match === null) {
      continue;
    }
    const numberText = match[1];
    const title = match[2];
    const anchor = match[3];
    if (numberText === undefined || title === undefined || anchor === undefined) {
      continue;
    }
    const number = Number(numberText);
    if (entries.has(number)) {
      throw new Error(`Duplicate chapter index entry ${number} in ${DESIGN_PATH}.`);
    }
    entries.set(number, { title: title.trim(), anchor });
  }
  return entries;
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
const hosting = readJsonBlock('design:hosting') as HostingDesign;
const implementationPlan = readJsonBlock('design:implementation-plan') as ImplementationPlan;

const STATES = lifecycle.states.map((state) => state.name);
const STATE_SET = new Set(STATES);
const TRANSITIONS = lifecycle.transitions;
const EVENTS = new Set(TRANSITIONS.map((transition) => transition.event));
const IMPLEMENTATION_TASKS = implementationPlan.tasks;
const IMPLEMENTATION_IDS = IMPLEMENTATION_TASKS.map((task) => task.id);
const TASK_INDEX = new Map(IMPLEMENTATION_IDS.map((id, index) => [id, index]));

/** Extract one Markdown section from its heading up to the next given heading. */
function sectionBetween(startHeading: string, endHeading: string): string {
  const start = DESIGN.indexOf(startHeading);
  if (start < 0) {
    throw new Error(`Missing section ${startHeading} in ${DESIGN_PATH}.`);
  }
  const end = DESIGN.indexOf(endHeading, start + startHeading.length);
  if (end < 0) {
    throw new Error(`Missing section ${endHeading} after ${startHeading} in ${DESIGN_PATH}.`);
  }
  return DESIGN.slice(start, end);
}

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

describe('minesweeper online hosting selection design', () => {
  it('selects one listed candidate and rejects every other candidate with a reason', () => {
    expect(hosting.version).toBe(1);
    expect(hosting.status).toBe('design-only');

    const ids = hosting.candidates.map((candidate) => candidate.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(hosting.choice);
    for (const id of ['dedicated-room-service', 'third-party-realtime']) {
      expect(ids).toContain(id);
    }

    const chosen = hosting.candidates.find((candidate) => candidate.id === hosting.choice);
    expect(chosen).toBeDefined();
    if (chosen === undefined) {
      throw new Error('The chosen hosting candidate must be listed.');
    }
    expect(chosen.authority).toBe('server');
    expect(chosen.ownServer).toBe(true);
    expect(chosen.staticFrontend).toBe(true);

    expect(hosting.rejected.length).toBeGreaterThan(0);
    const rejectedIds = new Set<string>();
    for (const rejection of hosting.rejected) {
      expect(ids).toContain(rejection.id);
      expect(rejection.id).not.toBe(hosting.choice);
      expect(rejection.reason.trim().length).toBeGreaterThan(0);
      expect(rejectedIds.has(rejection.id)).toBe(false);
      rejectedIds.add(rejection.id);
    }
    for (const id of ids) {
      if (id !== hosting.choice) {
        expect(rejectedIds.has(id)).toBe(true);
      }
    }
  });

  it('compares every required dimension with reasons for both options', () => {
    const required = [
      'deployment-ops',
      'cost',
      'latency',
      'authority-anti-cheat',
      'disconnect-recovery',
      'data-privacy',
      'testability',
      'static-deployment-alignment',
    ];
    const dimensions = hosting.reasons.map((reason) => reason.dimension);
    expect(new Set(dimensions).size).toBe(dimensions.length);
    for (const dimension of required) {
      expect(dimensions).toContain(dimension);
    }
    for (const reason of hosting.reasons) {
      expect(reason.label.trim().length).toBeGreaterThan(0);
      expect(reason.choice.trim().length).toBeGreaterThan(0);
      expect(reason.alternative.trim().length).toBeGreaterThan(0);
    }
    const alignment = hosting.reasons.find(
      (reason) => reason.dimension === 'static-deployment-alignment',
    );
    expect(alignment?.label).toContain('静态');
  });

  it('keeps the hosting decision, references and evolution path coherent', () => {
    expect(hosting.references).toEqual(
      expect.arrayContaining(['docs/tech-stack-decision.md', 'docs/framework.md']),
    );

    expect(protocol.hosting.requiresServer).toBe(true);
    expect(protocol.hosting.staticHostingOnly).toBe(false);
    expect(protocol.hosting.reason.trim().length).toBeGreaterThan(0);
    const chosen = hosting.candidates.find((candidate) => candidate.id === hosting.choice);
    expect(chosen?.ownServer).toBe(protocol.hosting.requiresServer);

    expect(hosting.evolution.length).toBeGreaterThan(0);
    const stages = new Set<string>();
    for (const stage of hosting.evolution) {
      expect(stage.stage.trim().length).toBeGreaterThan(0);
      expect(stage.change.trim().length).toBeGreaterThan(0);
      expect(stage.invariant.trim().length).toBeGreaterThan(0);
      expect(stages.has(stage.stage)).toBe(false);
      stages.add(stage.stage);
    }
    expect(stages.has('mvp')).toBe(true);
    for (const trigger of hosting.reevaluateWhen) {
      expect(trigger.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('minesweeper online implementation plan design', () => {
  it('lists complete tasks with stable ids and topological dependencies', () => {
    expect(implementationPlan.version).toBe(1);
    expect(implementationPlan.status).toBe('design-only');
    expect(implementationPlan.sourceIssue).toBe(46);
    expect(implementationPlan.order).toBe('topological');
    expect(IMPLEMENTATION_TASKS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(IMPLEMENTATION_IDS).size).toBe(IMPLEMENTATION_IDS.length);

    for (const task of IMPLEMENTATION_TASKS) {
      expect(task.id.trim().length).toBeGreaterThan(0);
      expect(task.category.trim().length).toBeGreaterThan(0);
      expect(task.title.trim().length).toBeGreaterThan(0);
      expect(task.detail.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(task.depends_on)).toBe(true);
      expect(Array.isArray(task.handles_events)).toBe(true);
      expect(Array.isArray(task.acceptance)).toBe(true);
      expect(task.acceptance.length).toBeGreaterThan(0);
      for (const item of task.acceptance) {
        expect(item.trim().length).toBeGreaterThan(0);
      }

      const position = TASK_INDEX.get(task.id);
      expect(position).toBeDefined();
      for (const dependency of task.depends_on) {
        const dependencyPosition = TASK_INDEX.get(dependency);
        expect(dependencyPosition).toBeDefined();
        if (dependencyPosition === undefined || position === undefined) {
          continue;
        }
        expect(dependencyPosition).toBeLessThan(position);
      }
    }
  });

  it('assigns each lifecycle event to a single owner except the shared timeout', () => {
    const declaredEvents = new Set(lifecycle.events.map((event) => event.name));
    const owners = new Map<string, string[]>();

    for (const task of IMPLEMENTATION_TASKS) {
      const seen = new Set<string>();
      for (const event of task.handles_events) {
        expect(declaredEvents.has(event)).toBe(true);
        expect(seen.has(event)).toBe(false);
        seen.add(event);

        const taskIds = owners.get(event) ?? [];
        taskIds.push(task.id);
        owners.set(event, taskIds);
      }
    }

    for (const event of declaredEvents) {
      const taskIds = owners.get(event) ?? [];
      expect(taskIds.length).toBe(event === 'timeout' ? 2 : 1);
    }
    expect(owners.get('timeout')).toEqual(
      expect.arrayContaining(['room-service', 'reconnect-timeout']),
    );
    expect(owners.get('rematch')).toEqual(['room-service']);
  });

  it('makes room-service own the rematch lifecycle event', () => {
    const roomService = IMPLEMENTATION_TASKS.find((task) => task.id === 'room-service');
    expect(roomService?.handles_events).toContain('rematch');
    expect(roomService?.detail).toContain('rematch');
    expect(roomService?.acceptance.some((item) => item.includes('rematch'))).toBe(true);
  });

  it('documents injectable engine construction in the engine adapter task', () => {
    const engineAdapter = IMPLEMENTATION_TASKS.find((task) => task.id === 'engine-adapter');
    expect(engineAdapter?.detail).toContain(
      'new MinesweeperEngine({ config, rng: createSeededRng(seed) })',
    );
  });

  it('covers the six required implementation categories', () => {
    const categories = new Set(IMPLEMENTATION_TASKS.map((task) => task.category));
    for (const category of ['engine', 'protocol', 'hosting', 'reconnect', 'client-ui', 'e2e']) {
      expect(categories.has(category)).toBe(true);
    }
  });

  it('has no dependency cycles', () => {
    const byId = new Map(IMPLEMENTATION_TASKS.map((task) => [task.id, task]));
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string): void => {
      if (done.has(id)) {
        return;
      }
      if (visiting.has(id)) {
        throw new Error(`Dependency cycle detected at ${id}.`);
      }
      visiting.add(id);
      const task = byId.get(id);
      if (task === undefined) {
        throw new Error(`Unknown implementation task ${id}.`);
      }
      for (const dependency of task.depends_on) {
        visit(dependency);
      }
      visiting.delete(id);
      done.add(id);
    };
    for (const id of IMPLEMENTATION_IDS) {
      visit(id);
    }
    expect(done.size).toBe(IMPLEMENTATION_IDS.length);
  });

  it('keeps the plan contracts aligned with lifecycle, protocol and hosting', () => {
    expect([...implementationPlan.contracts.roomStates].sort()).toEqual([...STATES].sort());
    for (const timer of ['join', 'turn', 'match']) {
      expect(implementationPlan.contracts.timersMs[timer]).toBe(lifecycle.timers[timer]?.defaultMs);
    }
    expect(implementationPlan.contracts.hostingChoice).toBe(hosting.choice);
    expect(implementationPlan.contracts.protocolVersion).toBe(protocol.version);
  });
});

describe('minesweeper online single-player relationship and glossary', () => {
  it('documents the parameterized engine reuse and single-player guarantees', () => {
    const relationship = sectionBetween(
      '## 2. 与现有单机玩法和规则引擎参数化的关系',
      '## 3. 房间生命周期',
    );
    for (const reference of [
      'MinesweeperConfig',
      'createSeededRng',
      'src/games/minesweeper/engine.ts',
      'difficulty.ts',
      'validateConfig',
    ]) {
      expect(relationship).toContain(reference);
    }
    expect(relationship).toContain(
      'new MinesweeperEngine({ config, rng: createSeededRng(seed) })',
    );
    expect(relationship).not.toContain('new MinesweeperEngine(config)');
    for (const topic of ['不回归', '排行榜', '自定义难度']) {
      expect(relationship).toContain(topic);
    }
  });

  it('provides a chapter index and a glossary', () => {
    expect(DESIGN).toContain('## 0. 章节索引');
    expect(DESIGN).toContain('## 10. 术语表');

    const index = sectionBetween('## 0. 章节索引', '## 1. 背景与范围');

    const headings = parseChapterHeadings();
    const headingNumbers = [...headings.keys()]
      .filter((number) => number !== 0)
      .sort((a, b) => a - b);
    for (const section of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(headingNumbers).toContain(section);
    }

    const entries = parseChapterIndex(index);
    expect([...entries.keys()].sort((a, b) => a - b)).toEqual(headingNumbers);

    for (const number of headingNumbers) {
      const heading = headings.get(number);
      const entry = entries.get(number);
      expect(entry).toBeDefined();
      if (heading === undefined || entry === undefined) {
        continue;
      }
      expect(entry.title).toBe(heading.title);
      expect(entry.anchor).toBe(heading.anchor);
    }

    const glossaryStart = DESIGN.indexOf('## 10. 术语表');
    expect(glossaryStart).toBeGreaterThan(-1);
    const glossary = DESIGN.slice(glossaryStart);
    for (const term of [
      'presence',
      'seq',
      '宽限期',
      '脱敏快照',
      'src/games/minesweeper/engine.ts',
    ]) {
      expect(glossary).toContain(term);
    }
  });
});
