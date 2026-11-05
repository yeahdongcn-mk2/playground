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
});
