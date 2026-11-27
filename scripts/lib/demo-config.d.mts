export const DEMO_SITE_PORT_VAR: string;
export const DEMO_ROOM_PORT_VAR: string;
export const DEMO_ROOM_URL_VAR: string;

export const DEFAULT_DEMO_HOST: string;
export const DEFAULT_DEMO_SITE_PORT: number;
export const DEFAULT_DEMO_ROOM_PORT: number;
export const DEFAULT_DEMO_ROOM_URL: string;

export const DEMO_HEALTH_PATH: string;
export const DEMO_WS_PATH: string;

/** Environment map accepted by {@link resolveDemoConfig}. */
export interface DemoConfigEnv {
  readonly [name: string]: string | undefined;
}

/** Fully resolved local demo configuration. */
export interface DemoConfig {
  /** Port the static site serves on. */
  readonly sitePort: number;
  /** Port the room service listens on. */
  readonly roomPort: number;
  /** Normalized origin the site proxies room traffic to. */
  readonly roomUrl: string;
  /** Local origin of the static site, e.g. `http://127.0.0.1:8080`. */
  readonly siteUrl: string;
  /** Room-service health URL, e.g. `http://127.0.0.1:8787/health`. */
  readonly healthUrl: string;
  /** Direct room-service WebSocket URL, e.g. `ws://127.0.0.1:8787/ws`. */
  readonly wsUrl: string;
}

export function demoSiteUrl(sitePort: number, host?: string): string;

export function demoHealthUrl(roomUrl?: string): string;

export function demoWebSocketUrl(roomUrl?: string): string;

export function resolveDemoConfig(env?: DemoConfigEnv): DemoConfig;
