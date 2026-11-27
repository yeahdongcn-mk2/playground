import { defineConfig } from 'vite';

/**
 * Room-service origin the e2e preview proxy keeps using when the demo does
 * not override it. It must match `ONLINE_ROOM_SERVER_PORT` in
 * `tests/e2e/online-room-constants.ts`; the build config deliberately keeps a
 * literal instead of importing test code.
 */
export const DEFAULT_ROOM_PROXY_TARGET = 'http://127.0.0.1:4176';

/**
 * Resolve the preview `/ws` proxy target from the environment.
 *
 * `npm run demo` starts the site preview with `DEMO_ROOM_URL` pointing at the
 * room service it just launched, so the same-origin socket reaches that port.
 * A plain `npm run preview` (the e2e suite) leaves it unset or blank and keeps
 * the historic 4176 target, so changing the demo defaults cannot silently move
 * the e2e proxy.
 */
export function resolveRoomProxyTarget(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.DEMO_ROOM_URL?.trim() ?? '';
  return configured === '' ? DEFAULT_ROOM_PROXY_TARGET : configured;
}

export default defineConfig({
  build: {
    target: 'es2022',
    // Phaser is a large engine chunk, but it is only fetched when a 2D game
    // starts. The small shell stays below the default warning limit.
    chunkSizeWarningLimit: 1600,
  },
  server: {
    port: 5173,
  },
  preview: {
    // The browser always opens the room socket as same-origin `/ws` against
    // the preview site; forward the upgrade to the room service. This is
    // test/dev infrastructure only and does not change the production build.
    proxy: {
      '/ws': {
        // The demo passes its room origin through DEMO_ROOM_URL; the e2e
        // suite leaves it unset and keeps the 4176 target defined above.
        target: resolveRoomProxyTarget(),
        ws: true,
      },
    },
  },
});
