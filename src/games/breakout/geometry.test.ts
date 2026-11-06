import { describe, expect, it } from 'vitest';
import { courtMetrics, courtXFromClientX } from './geometry';

describe('breakout court geometry', () => {
  it('fills a canvas with the same 2:3 aspect ratio', () => {
    const metrics = courtMetrics(240, 360, 480, 720);
    expect(metrics.scale).toBeCloseTo(0.5, 6);
    expect(metrics.offsetX).toBeCloseTo(0, 6);
    expect(metrics.offsetY).toBeCloseTo(0, 6);
    expect(metrics.width).toBeCloseTo(240, 6);
    expect(metrics.height).toBeCloseTo(360, 6);
  });

  it('letterboxes a wider canvas and centres the court', () => {
    const metrics = courtMetrics(400, 300, 480, 720);
    expect(metrics.scale).toBeCloseTo(300 / 720, 6);
    expect(metrics.width).toBeCloseTo(200, 6);
    expect(metrics.height).toBeCloseTo(300, 6);
    expect(metrics.offsetX).toBeCloseTo(100, 6);
    expect(metrics.offsetY).toBeCloseTo(0, 6);
  });

  it('maps a client X through the letterbox and clamps to the court', () => {
    const rect = { left: 50, width: 400, height: 300 };
    expect(courtXFromClientX(50, rect, 480, 720)).toBe(0);
    expect(courtXFromClientX(250, rect, 480, 720)).toBeCloseTo(240, 6);
    expect(courtXFromClientX(450, rect, 480, 720)).toBe(480);
  });
});
