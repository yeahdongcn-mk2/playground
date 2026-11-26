export type Route =
  | { readonly kind: 'home' }
  | { readonly kind: 'game'; readonly id: string }
  | { readonly kind: 'online'; readonly roomId: string | null }
  | { readonly kind: 'unknown'; readonly path: string };

/** Canonical online Minesweeper entry; mirrors the online client contract. */
const ONLINE_MINESWEEPER_HREF = '#/online/minesweeper';

/** Query parameter that carries the room id on the online entry. */
const ONLINE_ROOM_QUERY_PARAM = 'room';

/**
 * Parse the tiny hash router used by the static shell.
 *
 * Canonical form is `#/games/<id>`; `#/` and `#` are the hub. An optional
 * query string (`#/games/blank?debug=1`) is ignored by the shell and can be
 * inspected by the game itself.
 *
 * `#/online/minesweeper` is the online room entry. Its optional `room` query
 * is decoded into `roomId` (an empty value means the create/join screen);
 * every other `#/online/*` path stays unknown so the online client keeps
 * ownership of its own routes instead of the shell guessing.
 */
export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryStart = raw.indexOf('?');
  const path = (queryStart === -1 ? raw : raw.slice(0, queryStart)).replace(/^\/+|\/+$/g, '');
  if (path === 'online/minesweeper') {
    const query = queryStart === -1 ? '' : raw.slice(queryStart + 1);
    const roomId = new URLSearchParams(query).get(ONLINE_ROOM_QUERY_PARAM);
    return { kind: 'online', roomId: roomId === null || roomId === '' ? null : roomId };
  }
  if (path === '' || path === 'home') {
    return { kind: 'home' };
  }
  const match = /^games\/([a-z0-9][a-z0-9-]*)$/.exec(path);
  if (match?.[1]) {
    return { kind: 'game', id: match[1] };
  }
  return { kind: 'unknown', path };
}

/**
 * Build the online room href for shell links.
 *
 * `null` / an empty id points at the create/join screen. The id is encoded so
 * arbitrary server ids survive a round trip through the hash; this mirrors
 * the online client contract without importing it into the shell bundle.
 */
export function onlineRoomHref(roomId: string | null = null): string {
  if (roomId === null || roomId === '') {
    return ONLINE_MINESWEEPER_HREF;
  }
  return `${ONLINE_MINESWEEPER_HREF}?${ONLINE_ROOM_QUERY_PARAM}=${encodeURIComponent(roomId)}`;
}

export function gameHref(id: string): string {
  return `#/games/${id}`;
}
