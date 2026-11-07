import { describe, expect, it } from 'vitest';
import { resolveDebugSeed } from './debug';

describe('resolveDebugSeed', () => {
  it('defaults a missing seed to 1', () => {
    // Regression: `Number(null)` is 0, so the old `Number(params.get('seed'))`
    // parsing silently used seed 0 whenever `seed` was omitted.
    expect(resolveDebugSeed(null)).toBe(1);
  });

  it('defaults empty and blank seeds to 1', () => {
    expect(resolveDebugSeed('')).toBe(1);
    expect(resolveDebugSeed('   ')).toBe(1);
  });

  it('defaults non-numeric and non-finite seeds to 1', () => {
    expect(resolveDebugSeed('abc')).toBe(1);
    expect(resolveDebugSeed('Infinity')).toBe(1);
    expect(resolveDebugSeed('-Infinity')).toBe(1);
    expect(resolveDebugSeed('NaN')).toBe(1);
  });

  it('keeps an explicit finite seed, including 0', () => {
    expect(resolveDebugSeed('0')).toBe(0);
    expect(resolveDebugSeed('7')).toBe(7);
    expect(resolveDebugSeed('-3')).toBe(-3);
    expect(resolveDebugSeed(' 7 ')).toBe(7);
  });
});
