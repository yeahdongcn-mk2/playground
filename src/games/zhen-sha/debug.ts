/**
 * Deterministic debug seam for Zhen Sha.
 *
 * The view only reads this module when the hash route carries `?debug=1`, so
 * normal play keeps its wall-clock loop and never exposes `window.__playground`.
 * Everything here is a pure parser: the view owns the DOM, the engine and the
 * fixed-tick stepping.
 *
 * `seed` is recorded in the debug state for replay bookkeeping. The current
 * duel has no randomness, but pinning the seed makes a `seed` + `inputs` URL a
 * complete description of a run and leaves room for seeded rules later.
 */

import type { ZhenShaAction, ZhenShaSnapshot } from './engine';

/** Seed used when the URL omits `seed` or supplies a non-integer value. */
export const DEFAULT_DEBUG_SEED = 1;

/** Upper bound for one `step(n)` call, so a mistyped URL cannot freeze the page. */
export const MAX_DEBUG_STEP_TICKS = 100_000;

const ACTIONS: readonly ZhenShaAction[] = ['block', 'charge', 'strike'];

/** One action scheduled at an absolute fixed tick. */
export interface ZhenShaDebugInput {
  readonly action: ZhenShaAction;
  readonly tick: number;
}

/** Parsed debug query: whether the seam is enabled plus its deterministic inputs. */
export interface ZhenShaDebugOptions {
  readonly enabled: boolean;
  readonly seed: number;
  readonly inputs: readonly ZhenShaDebugInput[];
}

/** Debug state: the engine snapshot plus the pinned seed. */
export interface ZhenShaDebugState extends ZhenShaSnapshot {
  readonly seed: number;
}

/** Test seam installed as `window.__playground` only for `?debug=1` routes. */
export interface ZhenShaDebugApi {
  readonly gameId: 'zhen-sha';
  getState: () => ZhenShaDebugState;
  /** Queue a logical action at an absolute tick (defaults to the next tick). */
  input: (action: ZhenShaAction, atStep?: number) => void;
  /** Advance exactly `ticks` fixed steps, then sync the DOM and drawing. */
  step: (ticks: number) => void;
  /** Reset the duel and re-schedule the URL inputs from tick 0. */
  restart: () => void;
  /** Detach listeners, cancel the loop and remove this seam. */
  destroy: () => void;
}

/**
 * The snake, tetris, 2048 and breakout views also use `window.__playground`,
 * so one local cast avoids a conflicting global declaration.
 */
export interface ZhenShaDebugWindow {
  __playground?: ZhenShaDebugApi;
}

function isAction(raw: string): raw is ZhenShaAction {
  return (ACTIONS as readonly string[]).includes(raw);
}

/**
 * Resolve the debug `seed` query parameter. A missing, blank, non-numeric,
 * non-finite or non-integer value falls back to 1; an explicit integer,
 * including 0 and negative values, is kept as-is.
 */
export function resolveDebugSeed(raw: string | null): number {
  const token = raw?.trim() ?? '';
  if (token === '') {
    return DEFAULT_DEBUG_SEED;
  }
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : DEFAULT_DEBUG_SEED;
}

/**
 * Parse `inputs=block@180,charge@541,strike@542`.
 *
 * Items are comma separated; each entry is `<action>@<tick>` with an action
 * from the engine's logical set and a non-negative integer tick. Malformed
 * entries are ignored individually so one typo does not discard a whole
 * otherwise useful schedule. Order is preserved; the engine sorts by tick and
 * sequence when it applies them.
 */
export function parseDebugInputs(raw: string | null): readonly ZhenShaDebugInput[] {
  if (raw === null || raw.trim() === '') {
    return [];
  }

  const inputs: ZhenShaDebugInput[] = [];
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (token === '') {
      continue;
    }
    const at = token.indexOf('@');
    if (at <= 0 || at !== token.lastIndexOf('@')) {
      continue;
    }
    const action = token.slice(0, at).trim();
    const tickToken = token.slice(at + 1).trim();
    if (!isAction(action) || !/^\d+$/.test(tickToken)) {
      continue;
    }
    const tick = Number(tickToken);
    if (!Number.isSafeInteger(tick)) {
      continue;
    }
    inputs.push({ action, tick });
  }
  return inputs;
}

/** Query string after the hash route, falling back to the real search string. */
export function debugQueryFromHash(hash: string, search = ''): string {
  const queryIndex = hash.indexOf('?');
  if (queryIndex >= 0) {
    return hash.slice(queryIndex + 1);
  }
  return search.startsWith('?') ? search.slice(1) : search;
}

/**
 * Parse the query after the hash route. The seam is enabled only by an exact
 * `debug=1`; any other value (or a missing parameter) leaves normal play alone.
 */
export function parseDebugQuery(query: string): ZhenShaDebugOptions {
  const params = new URLSearchParams(query);
  return {
    enabled: params.get('debug') === '1',
    seed: resolveDebugSeed(params.get('seed')),
    inputs: parseDebugInputs(params.get('inputs')),
  };
}
