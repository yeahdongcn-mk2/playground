/**
 * Shell seam to the lazily loaded online Minesweeper room (#486).
 *
 * The shell must never statically import the online client: the room view,
 * its reducer and the WebSocket transport belong in a separate lazy chunk and
 * must not grow the hub entry bundle. This module is the only place that knows
 * both the hash route and the room entry, and the dynamic import lives behind
 * an injectable loader so shell tests can drive a fake client module.
 *
 * The returned handle is the lifetime contract for the route: after
 * `destroy()`, a load that resolves late must not mount, and an already
 * mounted room is destroyed and its mount point cleared.
 */

/** Options the shell passes to the room view. */
export interface OnlineRoomMountOptions {
  /** Room id parsed from the hash; `null` opens the create/join screen. */
  readonly roomId: string | null;
}

/** The only room-client surface the shell needs. */
export interface OnlineRoomHandle {
  destroy(): void;
}

/** The online client module shape loaded on demand. */
export interface OnlineRoomClientModule {
  mountOnlineRoom(root: HTMLElement, options?: OnlineRoomMountOptions): OnlineRoomHandle;
}

/** Resolve the online client module; replaced in shell tests. */
export type OnlineRoomModuleLoader = () => Promise<OnlineRoomClientModule>;

/** Production loader: the one dynamic import of the online client. */
export const loadOnlineRoomClient: OnlineRoomModuleLoader = () =>
  import('../games/minesweeper/online/client/online-room');

export interface OnlineRouteOptions {
  /** Override the lazy loader, for deterministic shell tests. */
  readonly load?: OnlineRoomModuleLoader;
  /**
   * Abort a pending mount when the shell leaves the route. An already-aborted
   * signal cancels before loading; the route then leaves `root` untouched.
   */
  readonly signal?: AbortSignal;
}

/** A pending or mounted online route. */
export interface OnlineRouteHandle {
  readonly roomId: string | null;
  /**
   * Resolves once the room is mounted. Rejects when loading or mounting fails;
   * a route cancelled through `destroy()` resolves without mounting instead of
   * surfacing an error for a page the user already left.
   */
  readonly ready: Promise<void>;
  /** Ignore a pending load, destroy a mounted room and clear its mount point. */
  destroy(): void;
}

/**
 * Mount the online room lazily into `root`.
 *
 * `root` is cleared by `destroy()`. The caller owns the route lifetime: the
 * shell aborts/destroys on every hash change and on `beforeunload`, and the
 * `ready` promise is only awaited while the owning render is still current.
 */
export function openOnlineRoute(
  root: HTMLElement,
  roomId: string | null,
  options: OnlineRouteOptions = {},
): OnlineRouteHandle {
  const load = options.load ?? loadOnlineRoomClient;
  let destroyed = options.signal?.aborted === true;
  let mounted: OnlineRoomHandle | null = null;

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    options.signal?.removeEventListener('abort', handleAbort);
    const handle = mounted;
    mounted = null;
    if (handle !== null) {
      try {
        handle.destroy();
      } catch (error) {
        console.error('Failed to destroy the online room', error);
      }
    }
    root.replaceChildren();
  }

  function handleAbort(): void {
    destroy();
  }

  if (options.signal !== undefined && !destroyed) {
    options.signal.addEventListener('abort', handleAbort, { once: true });
  }

  const ready = (async (): Promise<void> => {
    if (destroyed) {
      return;
    }

    let client: OnlineRoomClientModule;
    try {
      client = await load();
    } catch (error) {
      if (destroyed) {
        return;
      }
      throw error;
    }
    if (destroyed) {
      return;
    }

    const handle = client.mountOnlineRoom(root, { roomId });
    if (destroyed) {
      try {
        handle.destroy();
      } catch (error) {
        console.error('Failed to destroy the late online room', error);
      }
      return;
    }
    mounted = handle;
  })();

  return { roomId, ready, destroy };
}
