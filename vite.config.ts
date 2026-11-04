import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    // Phaser is a large framework that is loaded lazily only when a 2D game
    // starts. Keep the warning threshold above that lazy game chunk so normal
    // builds stay quiet while the small app shell is still code-split.
    chunkSizeWarningLimit: 1600,
  },
});
