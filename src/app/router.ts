export type Route =
  | { readonly kind: 'home' }
  | { readonly kind: 'game'; readonly id: string }
  | { readonly kind: 'unknown'; readonly path: string };

/**
 * Parse the tiny hash router used by the static shell.
 *
 * Canonical form is `#/games/<id>`; `#/` and `#` are the hub. An optional
 * query string (`#/games/blank?debug=1`) is ignored by the shell and can be
 * inspected by the game itself.
 */
export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = (raw.split('?')[0] ?? '').replace(/^\/+|\/+$/g, '');
  if (path === '' || path === 'home') {
    return { kind: 'home' };
  }
  const match = /^games\/([a-z0-9][a-z0-9-]*)$/.exec(path);
  if (match?.[1]) {
    return { kind: 'game', id: match[1] };
  }
  return { kind: 'unknown', path };
}

export function gameHref(id: string): string {
  return `#/games/${id}`;
}
