import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEBUG_SEED,
  debugQueryFromHash,
  parseDebugInputs,
  parseDebugQuery,
  resolveDebugSeed,
} from './debug';

describe('resolveDebugSeed', () => {
  it('defaults a missing, blank or non-integer seed to 1', () => {
    expect(resolveDebugSeed(null)).toBe(DEFAULT_DEBUG_SEED);
    expect(resolveDebugSeed('')).toBe(DEFAULT_DEBUG_SEED);
    expect(resolveDebugSeed('   ')).toBe(DEFAULT_DEBUG_SEED);
    expect(resolveDebugSeed('abc')).toBe(DEFAULT_DEBUG_SEED);
    expect(resolveDebugSeed('Infinity')).toBe(DEFAULT_DEBUG_SEED);
    expect(resolveDebugSeed('NaN')).toBe(DEFAULT_DEBUG_SEED);
    expect(resolveDebugSeed('1.5')).toBe(DEFAULT_DEBUG_SEED);
  });

  it('keeps an explicit safe integer, including 0 and negatives', () => {
    expect(resolveDebugSeed('0')).toBe(0);
    expect(resolveDebugSeed('7')).toBe(7);
    expect(resolveDebugSeed('-3')).toBe(-3);
    expect(resolveDebugSeed(' 135 ')).toBe(135);
  });
});

describe('parseDebugInputs', () => {
  it('returns an empty schedule for a missing or blank value', () => {
    expect(parseDebugInputs(null)).toEqual([]);
    expect(parseDebugInputs('')).toEqual([]);
    expect(parseDebugInputs('   ')).toEqual([]);
  });

  it('parses comma-separated action@tick entries in order', () => {
    expect(parseDebugInputs('block@180, charge@541 ,strike@542')).toEqual([
      { action: 'block', tick: 180 },
      { action: 'charge', tick: 541 },
      { action: 'strike', tick: 542 },
    ]);
  });

  it('keeps valid entries while dropping malformed ones', () => {
    expect(
      parseDebugInputs(
        'block@180,explode@1,charge@-1,strike@nope,strike@542@9,@3,block,block@1.5,charge@0',
      ),
    ).toEqual([
      { action: 'block', tick: 180 },
      { action: 'charge', tick: 0 },
    ]);
  });

  it('ignores empty comma segments', () => {
    expect(parseDebugInputs('block@1,,strike@2,')).toEqual([
      { action: 'block', tick: 1 },
      { action: 'strike', tick: 2 },
    ]);
  });
});

describe('debugQueryFromHash', () => {
  it('reads the query after the hash route', () => {
    expect(debugQueryFromHash('#/games/zhen-sha?debug=1&seed=7')).toBe('debug=1&seed=7');
  });

  it('falls back to the real search string when the hash has no query', () => {
    expect(debugQueryFromHash('#/games/zhen-sha', '?debug=1&seed=3')).toBe('debug=1&seed=3');
    expect(debugQueryFromHash('#/games/zhen-sha', '')).toBe('');
  });
});

describe('parseDebugQuery', () => {
  it('enables the seam only for an explicit debug=1', () => {
    expect(parseDebugQuery('debug=1').enabled).toBe(true);
    expect(parseDebugQuery('').enabled).toBe(false);
    expect(parseDebugQuery('debug=0').enabled).toBe(false);
    expect(parseDebugQuery('debug=true').enabled).toBe(false);
    expect(parseDebugQuery('seed=7').enabled).toBe(false);
  });

  it('defaults the seed and accepts an explicit one', () => {
    expect(parseDebugQuery('debug=1').seed).toBe(DEFAULT_DEBUG_SEED);
    expect(parseDebugQuery('debug=1&seed=nope').seed).toBe(DEFAULT_DEBUG_SEED);
    expect(parseDebugQuery('debug=1&seed=42').seed).toBe(42);
  });

  it('parses the fixed input schedule', () => {
    expect(
      parseDebugQuery(
        'debug=1&seed=7&inputs=block@180,block@360,block@540,charge@541,strike@542',
      ),
    ).toEqual({
      enabled: true,
      seed: 7,
      inputs: [
        { action: 'block', tick: 180 },
        { action: 'block', tick: 360 },
        { action: 'block', tick: 540 },
        { action: 'charge', tick: 541 },
        { action: 'strike', tick: 542 },
      ],
    });
  });

  it('keeps the parsed inputs on a disabled query', () => {
    expect(parseDebugQuery('seed=7&inputs=block@180')).toEqual({
      enabled: false,
      seed: 7,
      inputs: [{ action: 'block', tick: 180 }],
    });
  });
});
