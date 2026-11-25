import { describe, expect, it, vi } from 'vitest';

/**
 * Importing the entry point must not open a listener: only the direct
 * execution path (`npm run server:room`, i.e. `tsx server/room/main.ts`) may
 * start the room server. The transport is mocked so a broken guard fails on
 * the recorded call instead of binding the real port 8787.
 */
describe('server/room/main.ts import safety', () => {
  it('does not start the room server when the module is imported', async () => {
    const startRoomServer = vi.fn();
    vi.resetModules();
    vi.doMock('../../server/room/ws-server', () => ({ startRoomServer }));
    // A bypassed guard must reach the mocked transport even when the ambient
    // environment carries an invalid PORT; 0 is always valid and ephemeral.
    vi.stubEnv('PORT', '0');

    try {
      await import('../../server/room/main');
      // Give a bypassed (but asynchronous) startup a chance to reach the mock.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(startRoomServer).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../server/room/ws-server');
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
