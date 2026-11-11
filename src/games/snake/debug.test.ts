import { describe, expect, it } from 'vitest';
import { resolveDebugSeed, resolveDebugTicks } from './debug';

describe('resolveDebugSeed', () => {
  it('ignores a missing, blank or invalid seed', () => {
    expect(resolveDebugSeed(null)).toBeUndefined();
    expect(resolveDebugSeed('')).toBeUndefined();
    expect(resolveDebugSeed('   ')).toBeUndefined();
    expect(resolveDebugSeed('abc')).toBeUndefined();
    expect(resolveDebugSeed('Infinity')).toBeUndefined();
    expect(resolveDebugSeed('NaN')).toBeUndefined();
    expect(resolveDebugSeed('1.5')).toBeUndefined();
    expect(resolveDebugSeed('-3')).toBeUndefined();
  });

  it('keeps an explicit 32-bit seed, including 0', () => {
    expect(resolveDebugSeed('0')).toBe(0);
    expect(resolveDebugSeed('7')).toBe(7);
    expect(resolveDebugSeed(' 135 ')).toBe(135);
    expect(resolveDebugSeed('4294967295')).toBe(0xffffffff);
    expect(resolveDebugSeed('4294967296')).toBeUndefined();
  });
});

describe('resolveDebugTicks', () => {
  it('ignores a missing, blank or invalid tick count', () => {
    expect(resolveDebugTicks(null)).toBeUndefined();
    expect(resolveDebugTicks('')).toBeUndefined();
    expect(resolveDebugTicks('abc')).toBeUndefined();
    expect(resolveDebugTicks('1.5')).toBeUndefined();
    expect(resolveDebugTicks('-1')).toBeUndefined();
    expect(resolveDebugTicks('100001')).toBeUndefined();
  });

  it('keeps an explicit count, including 0 and the maximum', () => {
    expect(resolveDebugTicks('0')).toBe(0);
    expect(resolveDebugTicks('3')).toBe(3);
    expect(resolveDebugTicks(' 120 ')).toBe(120);
    expect(resolveDebugTicks('100000')).toBe(100000);
  });
});
