import { defineConfig } from 'vite';

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
    // the preview site; forward the upgrade to the local room service. This is
    // test/dev infrastructure only and does not change the production build.
    proxy: {
      '/ws': {
        // Must match ONLINE_ROOM_SERVER_PORT in
        // tests/e2e/online-room-constants.ts (the build config does not import
        // test code). The smoke spec fails if the room service and this proxy
        // target drift apart.
        target: 'http://127.0.0.1:4176',
        ws: true,
      },
    },
  },
});
