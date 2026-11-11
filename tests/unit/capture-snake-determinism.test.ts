import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { advanceFixedTicks } from '../../src/games/snake/fixed-ticks';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(
  join(ROOT, 'scripts', 'capture-snake-screenshots.mjs'),
  'utf8',
);
const VIEW = readFileSync(join(ROOT, 'src', 'games', 'snake', 'snake-view.ts'), 'utf8');
const SCENE = readFileSync(join(ROOT, 'src', 'games', 'snake', 'scene.ts'), 'utf8');

/**
 * Guard for the committed playing PNG. The engine test proves seed 7 plus three
 * fixed ticks reach a deterministic snake, next fruit and HUD state; these
 * tests runtime-test the extracted fixed-tick loop and statically pin the
 * capture script, the view wiring and the scene's final draw / sleep / marker
 * order. A dropped parameter cannot silently restore wall-clock captures while
 * the engine test stays green.
 */
describe('snake screenshot determinism guard', () => {
  it('pins the seed, fixed first fruit and tick count in the playing URL', () => {
    expect(SCRIPT).toContain('const PLAYING_SEED = 7;');
    expect(SCRIPT).toContain('const PLAYING_TICKS = 3;');
    expect(SCRIPT).toContain(
      '`${ORIGIN}/#/games/snake?debug=1&food=11,10&seed=${PLAYING_SEED}&ticks=${PLAYING_TICKS}`',
    );
  });

  it('waits for the fixed-tick marker instead of a wall-clock delay', () => {
    expect(SCRIPT).not.toContain('waitForTimeout(120)');
    expect(SCRIPT).not.toContain('score >= 10');
    expect(SCRIPT).toContain(
      "?.getAttribute('data-debug-ticks') === String(ticks)",
    );
  });

  it('gates the seed and tick seams through the existing debug gate', () => {
    expect(VIEW).toMatch(
      /function debugSeedFromHash\(\): number \| undefined \{\s*if \(!debugEnabled\(\)\) \{\s*return undefined;\s*\}\s*return resolveDebugSeed\(debugParams\(\)\.get\('seed'\)\);/,
    );
    expect(VIEW).toMatch(
      /function debugTicksFromHash\(\): number \| undefined \{\s*if \(!debugEnabled\(\)\) \{\s*return undefined;\s*\}\s*return resolveDebugTicks\(debugParams\(\)\.get\('ticks'\)\);/,
    );
    expect(VIEW).toContain('const seed = debugSeedFromHash();');
    expect(VIEW).toContain('const fixedTickCount = debugTicksFromHash();');
    // The seeded RNG is still the engine's RNG; a removed seed would fall back
    // to the per-mount random seed and break the screenshot silently.
    expect(VIEW).toMatch(/createSeededRng\(\s*seed \?\?/);
  });

  it('requests the fixed ticks only after a run starts and marks completion', () => {
    expect(VIEW).toContain('let debugTicksPaused = false;');
    expect(VIEW).toMatch(
      /if \(fixedTickCount !== undefined\) \{\s*debugTicksPaused = true;\s*\/\/[^]*?runtime\?\.game\.loop\.wake\(\);\s*scene\?\.requestFixedTicks\(fixedTickCount\);/,
    );
    expect(VIEW).toContain('gameRoot.dataset.debugTicks = String(ticks);');
  });

  it('keeps focus and visibility from unfreezing the deterministic frame', () => {
    // Both wake / pause paths are skipped while the debug tick sequence owns
    // the run, so a stray browser event cannot change the captured state.
    expect(VIEW).toMatch(
      /const onVisibilityChange = \(\): void => \{\s*if \(debugTicksPaused\) \{\s*return;\s*\}/,
    );
    expect(VIEW).toMatch(
      /if \(!debugTicksPaused && engine\.currentStatus === 'running'\) \{/,
    );
  });

  it('stores and consumes the requested tick count instead of a hard-coded loop', () => {
    const requestAt = SCENE.indexOf('requestFixedTicks(ticks: number): void {');
    const storeAt = SCENE.indexOf(
      'this.fixedTicks = Math.max(0, Math.floor(ticks));',
      requestAt,
    );
    expect(requestAt).toBeGreaterThan(-1);
    expect(storeAt).toBeGreaterThan(requestAt);

    const ticksAt = SCENE.indexOf('const ticks = this.fixedTicks;', storeAt);
    const clearAt = SCENE.indexOf('this.fixedTicks = null;', ticksAt);
    const advanceAt = SCENE.indexOf('advanceFixedTicks(ticks,', clearAt);
    expect(ticksAt).toBeGreaterThan(storeAt);
    expect(clearAt).toBeGreaterThan(ticksAt);
    expect(advanceAt).toBeGreaterThan(clearAt);

    // The final state is drawn, then the run is frozen until the frame's
    // render finishes, then the capture marker fires; deleting the draw would
    // let the screenshot keep a stale frame. A slept WebGL canvas can capture
    // as black, so the seam must freeze the run instead of the loop.
    const drawAt = SCENE.indexOf('this.drawGame(this.engine.state, time);', advanceAt);
    const frozenAt = SCENE.indexOf('this.frozen = true;', drawAt);
    const renderAt = SCENE.indexOf('Phaser.Core.Events.POST_RENDER', frozenAt);
    const markerAt = SCENE.indexOf('this.callbacks.onFixedTicks?.(ticks);', renderAt);
    expect(drawAt).toBeGreaterThan(advanceAt);
    expect(frozenAt).toBeGreaterThan(drawAt);
    expect(renderAt).toBeGreaterThan(frozenAt);
    expect(markerAt).toBeGreaterThan(renderAt);
    expect(SCENE).not.toContain('this.game.loop.sleep()');
    expect(SCENE).toMatch(/if \(this\.frozen\) \{\s*return;\s*\}/);
    expect(SCENE).toMatch(
      /resetRunState\(\): void \{\s*this\.accumulator = 0;\s*this\.deathFlashUntil = 0;\s*this\.frozen = false;/,
    );
  });

  it('advances exactly the requested fixed ticks', () => {
    const calls: string[] = [];
    advanceFixedTicks(3, () => {
      calls.push('tick');
    });
    expect(calls).toHaveLength(3);

    advanceFixedTicks(0, () => {
      calls.push('unexpected');
    });
    expect(calls).toHaveLength(3);
  });

  it('stops early when a tick reports the run is over', () => {
    let calls = 0;
    advanceFixedTicks(10, () => {
      calls += 1;
      return calls < 2;
    });
    expect(calls).toBe(2);
  });
});
