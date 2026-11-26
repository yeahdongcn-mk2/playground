import { describe, expect, it } from 'vitest';
import {
  ONLINE_MINESWEEPER_HREF,
  onlineRoomHref as clientOnlineRoomHref,
  parseOnlineRoomHref,
} from '../games/minesweeper/online/client/contracts';
import { gameHref, onlineRoomHref, parseRoute } from './router';

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

  it('parses the online room entry without a room', () => {
    expect(parseRoute(ONLINE_MINESWEEPER_HREF)).toEqual({ kind: 'online', roomId: null });
    expect(parseRoute(ONLINE_MINESWEEPER_HREF.slice(1))).toEqual({
      kind: 'online',
      roomId: null,
    });
    expect(parseRoute(`${ONLINE_MINESWEEPER_HREF}/`)).toEqual({ kind: 'online', roomId: null });
    expect(parseRoute(`${ONLINE_MINESWEEPER_HREF}?`)).toEqual({ kind: 'online', roomId: null });
    expect(parseRoute(`${ONLINE_MINESWEEPER_HREF}?room=`)).toEqual({
      kind: 'online',
      roomId: null,
    });
    expect(parseRoute(`${ONLINE_MINESWEEPER_HREF}?room`)).toEqual({ kind: 'online', roomId: null });
  });

  it('decodes the room id from the room query', () => {
    expect(parseRoute(`${ONLINE_MINESWEEPER_HREF}?room=room_1`)).toEqual({
      kind: 'online',
      roomId: 'room_1',
    });
    expect(parseRoute(`${ONLINE_MINESWEEPER_HREF}/?room=room_1`)).toEqual({
      kind: 'online',
      roomId: 'room_1',
    });
    expect(parseRoute(`${ONLINE_MINESWEEPER_HREF}?room=first&room=second`)).toEqual({
      kind: 'online',
      roomId: 'first',
    });
    expect(parseRoute(`${ONLINE_MINESWEEPER_HREF}?room=%E6%88%BF%E9%97%B4`)).toEqual({
      kind: 'online',
      roomId: '房间',
    });
    expect(parseRoute(`${ONLINE_MINESWEEPER_HREF}?room=room%20with%20space`)).toEqual({
      kind: 'online',
      roomId: 'room with space',
    });
    expect(
      parseRoute(`${ONLINE_MINESWEEPER_HREF}?room=room%2Fslash%3Fquestion%26equals%3Done`),
    ).toEqual({ kind: 'online', roomId: 'room/slash?question&equals=one' });
    expect(parseRoute(`${ONLINE_MINESWEEPER_HREF}?room=%2B`)).toEqual({
      kind: 'online',
      roomId: '+',
    });
    expect(parseRoute(`${ONLINE_MINESWEEPER_HREF}?room=%`)).toEqual({
      kind: 'online',
      roomId: '%',
    });
  });

  it('ignores extra query parameters around the room', () => {
    expect(parseRoute(`${ONLINE_MINESWEEPER_HREF}?room=room_1&from=hub`)).toEqual({
      kind: 'online',
      roomId: 'room_1',
    });
    expect(parseRoute(`${ONLINE_MINESWEEPER_HREF}?from=hub&room=room_1&utm=share`)).toEqual({
      kind: 'online',
      roomId: 'room_1',
    });
  });

  it('keeps every other online route unknown', () => {
    expect(parseRoute('#/online')).toEqual({ kind: 'unknown', path: 'online' });
    expect(parseRoute('#/online/')).toEqual({ kind: 'unknown', path: 'online' });
    expect(parseRoute('#/online/2048?room=room_1')).toEqual({
      kind: 'unknown',
      path: 'online/2048',
    });
    expect(parseRoute('#/online/minesweeper-extra')).toEqual({
      kind: 'unknown',
      path: 'online/minesweeper-extra',
    });
    expect(parseRoute('#/online/minesweeper/extra')).toEqual({
      kind: 'unknown',
      path: 'online/minesweeper/extra',
    });
  });

  it('keeps the room href aligned with the online client contract', () => {
    expect(onlineRoomHref()).toBe(ONLINE_MINESWEEPER_HREF);
    expect(onlineRoomHref(null)).toBe(ONLINE_MINESWEEPER_HREF);
    expect(onlineRoomHref('')).toBe(ONLINE_MINESWEEPER_HREF);

    const roomIds = [
      'room_123',
      'room with space',
      'room/slash?question&equals=one',
      '房间-42',
      'room+plus%percent',
    ];
    for (const roomId of roomIds) {
      const href = onlineRoomHref(roomId);
      expect(href).toBe(clientOnlineRoomHref(roomId));
      expect(parseRoute(href)).toEqual({ kind: 'online', roomId });
      expect(parseOnlineRoomHref(href)).toEqual({ roomId });
    }
  });
});
