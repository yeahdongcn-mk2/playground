/**
 * Browser composition root for the online Minesweeper room (#486 t2).
 *
 * This is the only online client module that knows both the browser and the
 * concrete parts. It wires the already-shipped seams together:
 *
 * - a `sessionStorage`-backed {@link TokenStore} for the resumable seat,
 * - the WebSocket transport factory from `./transport`,
 * - the reducer and selectors from `./store`,
 * - the redacted board renderer from `./board`,
 * - the room shell from `./room-view`, and
 * - browser navigation by rewriting `location.hash`.
 *
 * Nothing here re-implements a rule, a message or a second DTO: the view still
 * receives an {@link OnlineRoomViewDependencies} object, exactly like its unit
 * tests do, and the returned handle is the view's own
 * {@link OnlineRoomHandle}. The application shell (a later lazy route) only
 * has to call {@link mountOnlineRoom} and `destroy()` the returned handle on
 * every route change.
 *
 * The optional {@link OnlineRoomEnvironment} argument exists so an integration
 * test can inject a fake `WebSocket` (and a deterministic clock) without
 * monkey-patching globals. Production callers omit it and get the browser
 * socket and `Date.now`.
 */

import { createBoardRenderer } from './board';
import {
  createInitialRoomClientState,
  type OnlineRoomHandle,
  type OnlineRoomViewDependencies,
  type RoomClientState,
  type SeatSession,
  type TokenStore,
} from './contracts';
import { mountOnlineRoomView, type OnlineRoomViewOptions } from './room-view';
import { createRoomClientStore, roomSelectors } from './store';
import { createRoomTransportFactory, type RoomTransportSocket } from './transport';

// ---------------------------------------------------------------------------
// sessionStorage-backed TokenStore
// ---------------------------------------------------------------------------

/** Prefix of every persisted online seat; one key per room. */
export const ONLINE_SEAT_STORAGE_PREFIX = 'minesweeper.online.seat:';

/** The `sessionStorage` key that keeps the resumable seat for `roomId`. */
export function onlineSeatStorageKey(roomId: string): string {
  return `${ONLINE_SEAT_STORAGE_PREFIX}${roomId}`;
}

/**
 * Access `sessionStorage` without letting a blocked storage break the mount.
 *
 * Browsers can throw from the `sessionStorage` getter itself (blocked cookies,
 * sandboxed iframes, some private modes), not only from `getItem`/`setItem`.
 */
function browserSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Validate one parsed value before handing it back as a {@link SeatSession}. */
function isSeatSession(value: unknown, roomId: string): value is SeatSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record['roomId'] === roomId &&
    typeof record['displayName'] === 'string' &&
    (record['role'] === 'host' || record['role'] === 'guest') &&
    (record['playerToken'] === null || typeof record['playerToken'] === 'string')
  );
}

/**
 * Read one seat, dropping an entry that is corrupt or belongs to another room.
 *
 * The entry is removed on the way out so a bad value cannot fail again on every
 * mount; a blocked removal is still safe because the next read re-validates.
 */
function readStoredSeat(storage: Storage | null, roomId: string): SeatSession | null {
  if (storage === null) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(onlineSeatStorageKey(roomId));
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isSeatSession(parsed, roomId)) {
    try {
      storage.removeItem(onlineSeatStorageKey(roomId));
    } catch {
      // A blocked storage has no value left to protect; memory is authoritative.
    }
    return null;
  }
  return parsed;
}

/**
 * Create the browser {@link TokenStore}: `sessionStorage` with an in-memory
 * cache so a partially blocked storage still behaves like a token store.
 *
 * The cache matters for two cases the contract calls out:
 *
 * - a failed `setItem` (quota, private mode) must not lose the token for the
 *   lifetime of this page, or the seat could not be resumed after a reconnect;
 * - a failed `removeItem` must still make the token unusable *from this
 *   client*, so `clear` writes a `null` tombstone that wins over the stale
 *   storage value on every later `load`.
 *
 * One store is created per mounted room; a later mount reads the same
 * `sessionStorage` key and can resume the seat from a page reload.
 */
export function createSessionStorageTokenStore(
  storage: Storage | null = browserSessionStorage(),
): TokenStore {
  const cache = new Map<string, SeatSession | null>();

  return {
    load(roomId: string): SeatSession | null {
      const cached = cache.get(roomId);
      if (cached !== undefined) {
        return cached;
      }
      const session = readStoredSeat(storage, roomId);
      cache.set(roomId, session);
      return session;
    },

    save(session: SeatSession): void {
      cache.set(session.roomId, session);
      if (storage === null) {
        return;
      }
      try {
        storage.setItem(onlineSeatStorageKey(session.roomId), JSON.stringify(session));
      } catch {
        // Best effort: the in-memory cache keeps this page resumable.
      }
    },

    clear(roomId: string): void {
      cache.set(roomId, null);
      if (storage === null) {
        return;
      }
      try {
        storage.removeItem(onlineSeatStorageKey(roomId));
      } catch {
        // The tombstone above already hides the stale value from this client.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mount seam
// ---------------------------------------------------------------------------

/**
 * Non-production overrides for {@link mountOnlineRoom}.
 *
 * These exist so the integration test can drive a fake socket through the real
 * composition root. There is deliberately no option for the token store, store,
 * selectors, renderer or view: the production path must always use the shipped
 * implementations, and those seams already have their own unit tests.
 */
export interface OnlineRoomEnvironment {
  /** Replace the browser `WebSocket` constructor with a fake socket. */
  readonly socketFactory?: (url: string) => RoomTransportSocket;
}

/**
 * Mount the online room screen and return its destroyable handle.
 *
 * `options.roomId` comes from the `#/online/minesweeper?room=` route: a value
 * opens the join form with the room id prefilled (and resumes a stored seat
 * token), while `null`/absent shows the create/join landing page. Navigation
 * between those states writes `location.hash`, so the application router owns
 * the actual screen change.
 */
export function mountOnlineRoom(
  root: HTMLElement,
  options: OnlineRoomViewOptions = {},
  environment: OnlineRoomEnvironment = {},
): OnlineRoomHandle {
  const tokenStore = createSessionStorageTokenStore();
  const selectors = roomSelectors;

  // The board renderer factory has no state argument, so the composition root
  // keeps the latest committed state from the store it created. The board's
  // context closure reads this value at render time to give the real board the
  // authoritative phase/turn/actionGate (the redacted view model alone cannot
  // see, for example, that an `action_result` made the snapshot stale).
  // `finalBoard` comes from the end message because the board context contract
  // requires it: it is reserved for a result screen that renders the board in
  // the `finished` phase. The current room view unmounts the board as soon as
  // the phase leaves `playing`, so it does not display that value today.
  let latestState: RoomClientState = createInitialRoomClientState();

  const createTransport = createRoomTransportFactory({
    tokenStore,
    ...(environment.socketFactory === undefined
      ? {}
      : { socketFactory: environment.socketFactory }),
  });

  const dependencies: OnlineRoomViewDependencies = {
    createTransport,
    createStore(storeOptions) {
      const store = createRoomClientStore(storeOptions);
      latestState = store.getState();
      // Subscribe before the view does: the view renders from its own
      // subscription, so the board context must already be current when that
      // render runs. The store itself owns the listener set and is unreachable
      // after the handle is destroyed.
      store.subscribe((state) => {
        latestState = state;
      });
      return store;
    },
    selectors,
    createBoardRenderer() {
      return createBoardRenderer({
        context: () => ({
          phase: latestState.phase,
          isMyTurn: selectors.isMyTurn(latestState),
          actionGate: (row, col, kind) =>
            selectors.actionGate(latestState, row, col, kind),
          finalBoard: latestState.end?.finalSnapshot ?? null,
        }),
      });
    },
    tokenStore,
    now: Date.now,
    navigate(href: string): void {
      window.location.hash = href;
    },
  };

  return mountOnlineRoomView(root, dependencies, options);
}
