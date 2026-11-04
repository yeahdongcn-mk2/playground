import type { SnakeSnapshot } from './engine';

declare global {
  interface Window {
    /**
     * Test seam. Only installed on the Vite dev server, so
     * production users cannot depend on it.
     */
    __playground?: {
      gameId: 'snake';
      getState: () => SnakeSnapshot;
    };
  }
}

export {};
