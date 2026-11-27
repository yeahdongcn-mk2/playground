import {
  HEARTBEAT_INTERVAL_MS,
  MATCH_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  TURN_TIMEOUT_MS,
} from '../../server/room/contracts';
import { expect, test } from './fixtures';
import { ONLINE_ROOM_HEALTH_URL } from './online-room-constants';
import { ONLINE_ROOM_EFFECTIVE_TIMINGS } from './online-room-server';

/** How long a browser-side socket may take to open, send and receive. */
const SOCKET_TIMEOUT_MS = 10_000;

interface UpgradeProbe {
  /** `reply` when a server frame arrived, otherwise the failure kind. */
  readonly outcome: 'reply' | 'error' | 'timeout';
  /** Raw text of the server frame; empty unless `outcome` is `reply`. */
  readonly reply: string;
}

/**
 * The online e2e suite depends on two processes being wired together before
 * any two-player scenario can run: the real room service, and the preview site
 * proxying same-origin `/ws` to it. This smoke test proves that seam with no
 * game code involved, so a failure here points at the test infrastructure
 * rather than at a game rule.
 */
test.describe('online room test infrastructure', () => {
  // The launcher shortens the join, turn and presence windows but must keep
  // the turn deadline behind the presence chain: grace starts only when
  // offline detection fires, so the whole window is
  // offlineDetectMs + graceMs. A shorter turn would forfeit the match before
  // grace resolves and would stop exercising the real reconnect lifecycle.
  // The same values are what the running room service was started with.
  test('uses shortened test windows ordered detect < grace < turn < match', () => {
    const timings = ONLINE_ROOM_EFFECTIVE_TIMINGS;

    expect(timings.offlineDetectMs).toBe(
      timings.heartbeatIntervalMs * timings.missedBeatsThreshold,
    );
    expect(timings.offlineDetectMs).toBeLessThan(timings.graceMs);
    expect(timings.graceMs).toBeLessThan(timings.turnTimeoutMs);
    expect(timings.turnTimeoutMs).toBeLessThan(timings.matchTimeoutMs);
    expect(timings.offlineDetectMs + timings.graceMs).toBeLessThan(
      timings.turnTimeoutMs,
    );

    // Every window the launcher overrides is shorter than production, while
    // the production constants themselves stay untouched.
    expect(timings.heartbeatIntervalMs).toBeLessThan(HEARTBEAT_INTERVAL_MS);
    expect(timings.graceMs).toBeLessThan(RECONNECT_GRACE_MS);
    expect(timings.turnTimeoutMs).toBeLessThan(TURN_TIMEOUT_MS);
    expect(timings.matchTimeoutMs).toBeLessThan(MATCH_TIMEOUT_MS);
  });

  test('serves health, the preview site and a browser /ws upgrade through the proxy', async ({
    page,
    request,
  }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    if (!baseURL) {
      throw new Error('playwright.config.ts must set use.baseURL');
    }
    const previewOrigin = new URL(baseURL).origin;

    const health = await request.get(ONLINE_ROOM_HEALTH_URL);
    expect(health.status()).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    await page.goto('/');
    await expect(page).toHaveTitle(/Playground Arcade/);
    await expect(page.getByTestId('game-card-blank')).toBeVisible();
    expect(new URL(page.url()).origin).toBe(previewOrigin);

    // A browser WebSocket to same-origin `/ws` must complete the HTTP upgrade
    // through the preview proxy. The probe then sends a deliberately invalid
    // frame: a protocol error coming back proves the proxied connection reaches
    // the room service in both directions, not just a local TCP accept.
    const probe = await page.evaluate(async (timeoutMs): Promise<UpgradeProbe> => {
      return await new Promise<UpgradeProbe>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/ws`);
        const timer = window.setTimeout(() => {
          socket.close();
          resolve({ outcome: 'timeout', reply: '' });
        }, timeoutMs);

        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ type: 'not-a-real-message' }));
        });
        socket.addEventListener('message', (event: MessageEvent) => {
          window.clearTimeout(timer);
          const reply = typeof event.data === 'string' ? event.data : '';
          socket.close();
          resolve({ outcome: 'reply', reply });
        });
        socket.addEventListener('error', () => {
          window.clearTimeout(timer);
          socket.close();
          resolve({ outcome: 'error', reply: '' });
        });
      });
    }, SOCKET_TIMEOUT_MS);

    expect(probe.outcome, 'browser /ws should upgrade and receive a frame').toBe('reply');
    const reply: unknown = JSON.parse(probe.reply);
    expect(reply, 'room service should answer the invalid frame').toMatchObject({
      type: 'error',
      code: 'bad-request',
    });
  });
});
