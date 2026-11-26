/**
 * Connection constants shared by the test-only room service launcher and
 * Playwright's `webServer` config.
 *
 * This module deliberately has no runtime imports or side effects: Playwright
 * loads it while resolving `playwright.config.ts`, before any test server
 * starts, so it must stay independent of the room-service graph. `vite.config.ts`
 * keeps a matching literal because the build config must not import test code.
 */

/** Loopback host the test room service binds. */
export const ONLINE_ROOM_SERVER_HOST = '127.0.0.1';

/**
 * Port the test room service binds; `vite preview` proxies `/ws` here.
 *
 * Avoid the screenshot scripts' preview ports (4174, 4183, 4185, 4186, 4192,
 * 5188) so a local `npm run screenshots` preview can run beside e2e.
 */
export const ONLINE_ROOM_SERVER_PORT = 4176;

const ONLINE_ROOM_SERVER_URL = `http://${ONLINE_ROOM_SERVER_HOST}:${ONLINE_ROOM_SERVER_PORT}`;

/** Readiness URL Playwright polls before starting the browser tests. */
export const ONLINE_ROOM_HEALTH_URL = `${ONLINE_ROOM_SERVER_URL}/health`;
