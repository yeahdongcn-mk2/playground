import type { SnakeSnapshot } from './engine';

declare global {
  interface Window {
    /**
     * Test seam. Installed on the Vite dev server, and in production builds
     * only when the page is opened with `?debug=1`.
     */
    __playground?: {
      gameId: 'snake';
      getState: () => SnakeSnapshot;
    };
  }
}
