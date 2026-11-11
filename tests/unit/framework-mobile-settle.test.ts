import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import {
  BLANK_SETTLE_INTERVAL_MS,
  BLANK_STABLE_SAMPLES,
  waitForBlankSettled,
} from '../../scripts/lib/blank-settle.mjs';
import type { BlankReadoutSample } from '../../scripts/lib/blank-settle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CASES = readFileSync(
  join(ROOT, 'tests', 'e2e', 'framework-mobile-cases.ts'),
  'utf8',
);

/** Drop comments so a commented-out call cannot satisfy the static pin. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Guard for the framework mobile tap case (issue #117). The old case polled
 * the readout for a fixed 3 s and could fail on a cold WebKit start before the
 * scene settled. It must now await the same settle contract the blank
 * screenshot uses: several consecutive samples on the tapped point with the
 * trail cleared, with the existing product tolerance (never widened) and the
 * tap/readout diagnostics kept for failures.
 */
describe('framework mobile settle wait guard', () => {
  it('accepts only consecutive on-target samples with a cleared trail', async () => {
    const target = { x: 60, y: 140 };
    const settled = { x: 60, y: 140, trail: 0 };
    const samples: BlankReadoutSample[] = [
      { x: 0, y: 0, trail: 0 }, // stale reading from before the tap
      { x: 60, y: 140, trail: 2 }, // on target but the trail is still alive
      { x: 66, y: 140, trail: 0 }, // 6 px off: inside the case's 8 px tolerance
      { x: 60, y: 146, trail: 0 },
      { x: 60, y: 140, trail: 0 },
      { x: 60, y: 140, trail: 0 },
      { x: 60, y: 140, trail: 0 }, // fifth consecutive settled sample
    ];
    let current = 0;
    const waits: number[] = [];

    const result = await waitForBlankSettled({} as Page, target, {
      tolerance: 8,
      now: () => current,
      read: async () => {
        const sample = samples.shift();
        if (!sample) {
          throw new Error('read after the expected settle');
        }
        return sample;
      },
      wait: async (_page, delayMs) => {
        waits.push(delayMs);
        current += delayMs;
      },
    });

    expect(result).toEqual(settled);
    expect(samples).toHaveLength(0);
    // Six polls: the live trail broke the streak, the next five stayed settled.
    expect(waits).toEqual(Array(6).fill(BLANK_SETTLE_INTERVAL_MS));
  });

  it('reports the last readout when the point is never reached', async () => {
    let current = 0;
    const error = await waitForBlankSettled({} as Page, { x: 60, y: 140 }, {
      tolerance: 8,
      timeoutMs: 250,
      now: () => current,
      read: async () => ({ x: 0, y: 0, trail: 1 }),
      wait: async (_page, delayMs) => {
        current += delayMs;
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('within 250 ms');
    expect((error as Error).message).toContain(
      'last readout x=0, y=0, trail=1',
    );
  });

  it('pins the case to the settle wait and keeps the tap diagnostics', () => {
    const source = stripComments(CASES);
    expect(source).toContain(
      "import { waitForBlankSettled } from '../../scripts/lib/blank-settle.mjs';",
    );
    expect(source).toMatch(/await\s+waitForBlankSettled\(\s*page,/);
    expect(source).toContain('x: target.localX');
    expect(source).toContain('y: target.localY');
    expect(source).toContain('tolerance: TAP_TOLERANCE');
    // The product tolerance is unchanged and no fixed 3 s coordinate poll is
    // left behind; the wait itself requires BLANK_STABLE_SAMPLES settled reads.
    expect(source).toContain('const TAP_TOLERANCE = 8;');
    expect(source).not.toMatch(/timeout:\s*3_?000/);
    expect(source).not.toContain('TAP_TIMEOUT_MS');
    expect(source).not.toMatch(/expect\s*\.\s*poll\(/);
    // The guard is a run of settled samples, not a longer blind timeout.
    expect(BLANK_STABLE_SAMPLES).toBe(5);
    // A failure must still explain tap delivery and readout movement.
    expect(source).toContain('collectFrameworkTapDiagnostics');
    expect(source).toContain('formatFrameworkTapDiagnostics');
  });
});
