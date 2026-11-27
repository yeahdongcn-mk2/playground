/**
 * Shared configuration contract for the one-command online demo (#541).
 *
 * The demo is two processes: the built static site and the standalone
 * Minesweeper room service. The compose file, the local `npm run demo` entry
 * point and the e2e smoke test must agree on three things, or the stack starts
 * but the browser cannot reach the room service:
 *
 * - the site port (`DEMO_SITE_PORT`, default 8080),
 * - the room service port (`DEMO_ROOM_PORT`, default 8787; it must stay equal
 *   to `DEFAULT_ROOM_SERVER_PORT` in `server/room/contracts.ts`),
 * - the origin the site proxies room traffic to (`DEMO_ROOM_URL`, default
 *   `http://127.0.0.1:<room port>`).
 *
 * The room service's own `/health` and `/ws` paths stay defined by
 * `server/room/ws-server.ts`; the copies here are pinned against those
 * constants by `tests/unit/demo-config.test.ts` so the contract cannot drift.
 *
 * Only the contract lives in this module: process startup, the compose file
 * and the npm script belong to the follow-up subtasks. Everything is resolved
 * from a plain environment map, so tests can exercise it without touching
 * `process.env`.
 */

/** Environment variable naming the static site port. */
export const DEMO_SITE_PORT_VAR = 'DEMO_SITE_PORT';

/** Environment variable naming the room service port. */
export const DEMO_ROOM_PORT_VAR = 'DEMO_ROOM_PORT';

/** Environment variable naming the site's room-service proxy target. */
export const DEMO_ROOM_URL_VAR = 'DEMO_ROOM_URL';

/** Host the local demo binds and advertises by default. */
export const DEFAULT_DEMO_HOST = '127.0.0.1';

/** Port the static site serves on unless `DEMO_SITE_PORT` overrides it. */
export const DEFAULT_DEMO_SITE_PORT = 8080;

/**
 * Port the room service listens on unless `DEMO_ROOM_PORT` overrides it.
 *
 * This must equal `DEFAULT_ROOM_SERVER_PORT` in `server/room/contracts.ts`;
 * one unit test pins the pair so changing one without the other fails loudly.
 */
export const DEFAULT_DEMO_ROOM_PORT = 8787;

/** Loopback room-service origin used by local runs. */
export const DEFAULT_DEMO_ROOM_URL = `http://${DEFAULT_DEMO_HOST}:${DEFAULT_DEMO_ROOM_PORT}`;

/**
 * Room-service health path. Mirrors `ROOM_HEALTH_PATH` in
 * `server/room/ws-server.ts` (`GET /health` → `200 {"status":"ok"}`).
 */
export const DEMO_HEALTH_PATH = '/health';

/**
 * Room-service WebSocket path. Mirrors `ROOM_WS_PATH` in
 * `server/room/ws-server.ts`; the site proxies this same-origin path so the
 * browser never needs the room service origin.
 */
export const DEMO_WS_PATH = '/ws';

/** Highest valid TCP port. */
const MAX_DEMO_PORT = 65_535;

/** One readable error for every invalid port value. */
function invalidDemoPortError(variable, rawValue, fallback) {
  return new Error(
    `Invalid ${variable} "${String(rawValue)}": expected an integer between 1 and ` +
      `${MAX_DEMO_PORT} (leave ${variable} unset or blank to use ${fallback}).`,
  );
}

/**
 * Resolve one port from an environment value.
 *
 * Unset, null and whitespace-only values fall back to the caller's default.
 * Otherwise the value is trimmed and must be a decimal integer in `1..65535`;
 * port 0 is rejected because the demo advertises a stable, reachable URL.
 * Anything else throws a readable error that names the variable, the raw value
 * and the fallback instead of silently binding something unintended.
 */
function parseDemoPort(rawValue, fallback, variable) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return fallback;
  }

  const text = String(rawValue).trim();
  if (!/^\d+$/.test(text)) {
    throw invalidDemoPortError(variable, rawValue, fallback);
  }

  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > MAX_DEMO_PORT) {
    throw invalidDemoPortError(variable, rawValue, fallback);
  }
  return port;
}

/** One readable error for every invalid room URL value. */
function invalidDemoRoomUrlError(rawValue) {
  return new Error(
    `Invalid DEMO_ROOM_URL "${rawValue}": expected an absolute http:// or https:// ` +
      `origin without a path, query, fragment or credentials.`,
  );
}

/**
 * Normalize the site's room-service proxy target.
 *
 * Unset, null and blank values use `fallback`. Any other value must be an
 * absolute `http(s)` origin: it is the base the site proxies `/ws` to, so a
 * path, query, fragment or embedded credentials are rejected rather than
 * silently producing a URL the room service cannot answer. A trailing slash is
 * accepted and removed so appending {@link DEMO_HEALTH_PATH} is unambiguous.
 */
function normalizeDemoRoomUrl(rawValue, fallback) {
  const text =
    rawValue === undefined || rawValue === null ? '' : String(rawValue).trim();
  const candidate = text === '' ? fallback : text;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw invalidDemoRoomUrlError(candidate);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidDemoRoomUrlError(candidate);
  }
  if (url.username !== '' || url.password !== '') {
    throw invalidDemoRoomUrlError(candidate);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw invalidDemoRoomUrlError(candidate);
  }
  return url.origin;
}

/**
 * Build the local site origin for a resolved site port.
 *
 * `host` exists for callers that bind a different interface; the demo default
 * is loopback so the advertised URL is always reachable on the same machine.
 */
export function demoSiteUrl(sitePort, host = DEFAULT_DEMO_HOST) {
  return `http://${host}:${sitePort}`;
}

/**
 * Build the room service health URL from its origin.
 *
 * A missing value uses {@link DEFAULT_DEMO_ROOM_URL}; any supplied origin is
 * normalized exactly like `DEMO_ROOM_URL` so callers cannot append the path to
 * a malformed target.
 */
export function demoHealthUrl(roomUrl = DEFAULT_DEMO_ROOM_URL) {
  return `${normalizeDemoRoomUrl(roomUrl, DEFAULT_DEMO_ROOM_URL)}${DEMO_HEALTH_PATH}`;
}

/**
 * Build the direct room-service WebSocket URL from its origin.
 *
 * This is the URL of the room service itself (used by probes and tests), not
 * the browser-facing same-origin `/ws` path the site proxies. `https` origins
 * become `wss`.
 */
export function demoWebSocketUrl(roomUrl = DEFAULT_DEMO_ROOM_URL) {
  const origin = normalizeDemoRoomUrl(roomUrl, DEFAULT_DEMO_ROOM_URL);
  const wsOrigin = origin.startsWith('https:')
    ? `wss:${origin.slice('https:'.length)}`
    : `ws:${origin.slice('http:'.length)}`;
  return `${wsOrigin}${DEMO_WS_PATH}`;
}

/**
 * Resolve the complete local demo configuration from an environment map.
 *
 * - `DEMO_SITE_PORT` and `DEMO_ROOM_PORT` are validated port integers.
 * - `DEMO_ROOM_URL` defaults to the loopback origin of the *resolved* room
 *   port, so overriding only `DEMO_ROOM_PORT` cannot leave the site proxy
 *   pointing at the old port. An explicit `DEMO_ROOM_URL` wins and may point
 *   at another host, which is how compose addresses the room container.
 *
 * The returned object is frozen: later subtasks consume it, they do not patch
 * it. It carries the resolved ports, the normalized room origin and the three
 * ready-to-use URLs (`siteUrl`, `healthUrl`, `wsUrl`) so no consumer has to
 * hand-concatenate a port or a path.
 */
export function resolveDemoConfig(env = process.env) {
  const sitePort = parseDemoPort(
    env[DEMO_SITE_PORT_VAR],
    DEFAULT_DEMO_SITE_PORT,
    DEMO_SITE_PORT_VAR,
  );
  const roomPort = parseDemoPort(
    env[DEMO_ROOM_PORT_VAR],
    DEFAULT_DEMO_ROOM_PORT,
    DEMO_ROOM_PORT_VAR,
  );
  const roomUrl = normalizeDemoRoomUrl(
    env[DEMO_ROOM_URL_VAR],
    `http://${DEFAULT_DEMO_HOST}:${roomPort}`,
  );

  return Object.freeze({
    sitePort,
    roomPort,
    roomUrl,
    siteUrl: demoSiteUrl(sitePort),
    healthUrl: demoHealthUrl(roomUrl),
    wsUrl: demoWebSocketUrl(roomUrl),
  });
}
