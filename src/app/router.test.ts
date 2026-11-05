import { describe, expect, it } from 'vitest';
import { gameHref, parseRoute } from './router';

describe('parseRoute', () => {
  it('treats empty hashes as the hub', () => {
    expect(parseRoute('')).toEqual({ kind: 'home' });
    expect(parseRoute('#')).toEqual({ kind: 'home' });
    expect(parseRoute('#/')).toEqual({ kind: 'home' });
    expect(parseRoute('#/home')).toEqual({ kind: 'home' });
  });

  it('parses game routes', () => {
    expect(parseRoute('#/games/blank')).toEqual({ kind: 'game', id: 'blank' });
    expect(parseRoute('#games/blank')).toEqual({ kind: 'game', id: 'blank' });
    expect(parseRoute('#/games/blank?debug=1')).toEqual({ kind: 'game', id: 'blank' });
    expect(parseRoute('#/games/my-game-2/')).toEqual({ kind: 'game', id: 'my-game-2' });
  });

  it('rejects malformed and unknown game routes', () => {
    expect(parseRoute('#/games')).toEqual({ kind: 'unknown', path: 'games' });
    expect(parseRoute('#/games/Bad_ID!')).toEqual({ kind: 'unknown', path: 'games/Bad_ID!' });
    expect(parseRoute('#/play/blank')).toEqual({ kind: 'unknown', path: 'play/blank' });
  });

  it('exposes the canonical game href', () => {
    expect(gameHref('blank')).toBe('#/games/blank');
  });
});
