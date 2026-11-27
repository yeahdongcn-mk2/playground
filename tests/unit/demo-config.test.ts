import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEMO_HOST,
  DEFAULT_DEMO_ROOM_PORT,
  DEFAULT_DEMO_ROOM_URL,
  DEFAULT_DEMO_SITE_PORT,
  DEMO_HEALTH_PATH,
  DEMO_ROOM_PORT_VAR,
  DEMO_ROOM_URL_VAR,
  DEMO_SITE_PORT_VAR,
  DEMO_WS_PATH,
  demoHealthUrl,
  demoSiteUrl,
  demoWebSocketUrl,
  resolveDemoConfig,
} from '../../scripts/lib/demo-config.mjs';
import { DEFAULT_ROOM_SERVER_PORT } from '../../server/room/contracts';
import { ROOM_HEALTH_PATH, ROOM_WS_PATH } from '../../server/room/ws-server';

type Env = Record<string, string | undefined>;

/**
 * The local demo stack as documented in #541: site 8080, room service 8787,
 * same-origin `/ws` proxied to the room origin, health at `/health`.
 */
const DEFAULT_CONFIG = {
  sitePort: 8080,
  roomPort: 8787,
  roomUrl: 'http://127.0.0.1:8787',
  siteUrl: 'http://127.0.0.1:8080',
  healthUrl: 'http://127.0.0.1:8787/health',
  wsUrl: 'ws://127.0.0.1:8787/ws',
};

const INVALID_PORTS = ['abc', '0', '-1', '1.5', '65536', '8080abc'];

describe('demo config contract', () => {
  it('pins the environment variable names consumed by the stack', () => {
    expect(DEMO_SITE_PORT_VAR).toBe('DEMO_SITE_PORT');
    expect(DEMO_ROOM_PORT_VAR).toBe('DEMO_ROOM_PORT');
    expect(DEMO_ROOM_URL_VAR).toBe('DEMO_ROOM_URL');
  });

  it('pins the local defaults', () => {
    expect(DEFAULT_DEMO_HOST).toBe('127.0.0.1');
    expect(DEFAULT_DEMO_SITE_PORT).toBe(8080);
    expect(DEFAULT_DEMO_ROOM_PORT).toBe(8787);
    expect(DEFAULT_DEMO_ROOM_URL).toBe('http://127.0.0.1:8787');
  });

  it('keeps the room port equal to the room service default', () => {
    // `server/room/contracts.ts` owns the room service default; the demo
    // contract must not silently listen on a different port.
    expect(DEFAULT_DEMO_ROOM_PORT).toBe(DEFAULT_ROOM_SERVER_PORT);
  });

  it('keeps the health and WebSocket paths equal to the room transport', () => {
    // `server/room/ws-server.ts` owns the paths the room service answers.
    expect(DEMO_HEALTH_PATH).toBe(ROOM_HEALTH_PATH);
    expect(DEMO_HEALTH_PATH).toBe('/health');
    expect(DEMO_WS_PATH).toBe(ROOM_WS_PATH);
    expect(DEMO_WS_PATH).toBe('/ws');
  });
});

describe('resolveDemoConfig defaults', () => {
  it('uses the local defaults for an empty environment', () => {
    expect(resolveDemoConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it('treats unset, empty and whitespace values as defaults', () => {
    const env: Env = {
      DEMO_SITE_PORT: '',
      DEMO_ROOM_PORT: '   ',
      DEMO_ROOM_URL: '\t\n',
    };
    expect(resolveDemoConfig(env)).toEqual(DEFAULT_CONFIG);
  });

  it('returns a frozen contract', () => {
    expect(Object.isFrozen(resolveDemoConfig({}))).toBe(true);
  });
});

describe('resolveDemoConfig overrides', () => {
  it('overrides the site port and derives the site URL', () => {
    expect(resolveDemoConfig({ DEMO_SITE_PORT: '8081' })).toEqual({
      ...DEFAULT_CONFIG,
      sitePort: 8081,
      siteUrl: 'http://127.0.0.1:8081',
    });
  });

  it('derives the room, health and WebSocket URLs from an overridden room port', () => {
    // Overriding only DEMO_ROOM_PORT must move the proxy target with it;
    // otherwise the site would still proxy to 8787.
    expect(resolveDemoConfig({ DEMO_ROOM_PORT: '9000' })).toEqual({
      ...DEFAULT_CONFIG,
      roomPort: 9000,
      roomUrl: 'http://127.0.0.1:9000',
      healthUrl: 'http://127.0.0.1:9000/health',
      wsUrl: 'ws://127.0.0.1:9000/ws',
    });
  });

  it('uses DEMO_ROOM_URL as the proxy target and appends the room paths', () => {
    expect(resolveDemoConfig({ DEMO_ROOM_URL: 'http://room:8787' })).toEqual({
      ...DEFAULT_CONFIG,
      roomUrl: 'http://room:8787',
      healthUrl: 'http://room:8787/health',
      wsUrl: 'ws://room:8787/ws',
    });
  });

  it('maps an https room origin to wss and removes a trailing slash', () => {
    expect(
      resolveDemoConfig({ DEMO_ROOM_URL: '  https://room.example.test/  ' }),
    ).toEqual({
      ...DEFAULT_CONFIG,
      roomUrl: 'https://room.example.test',
      healthUrl: 'https://room.example.test/health',
      wsUrl: 'wss://room.example.test/ws',
    });
  });

  it('keeps an explicit room URL when the room port also changes', () => {
    // Compose maps a host port but points the site at the room container, so
    // the two values intentionally differ.
    const config = resolveDemoConfig({
      DEMO_ROOM_PORT: '9000',
      DEMO_ROOM_URL: 'http://room:8787',
    });
    expect(config.roomPort).toBe(9000);
    expect(config.roomUrl).toBe('http://room:8787');
    expect(config.healthUrl).toBe('http://room:8787/health');
    expect(config.wsUrl).toBe('ws://room:8787/ws');
  });

  it('trims surrounding whitespace in every overridden value', () => {
    expect(
      resolveDemoConfig({
        DEMO_SITE_PORT: ' 8081 ',
        DEMO_ROOM_PORT: ' 9000 ',
        DEMO_ROOM_URL: '  http://127.0.0.1:9000/  ',
      }),
    ).toEqual({
      sitePort: 8081,
      roomPort: 9000,
      roomUrl: 'http://127.0.0.1:9000',
      siteUrl: 'http://127.0.0.1:8081',
      healthUrl: 'http://127.0.0.1:9000/health',
      wsUrl: 'ws://127.0.0.1:9000/ws',
    });
  });

  it('accepts the boundary ports', () => {
    const config = resolveDemoConfig({ DEMO_SITE_PORT: '1', DEMO_ROOM_PORT: '65535' });
    expect(config.sitePort).toBe(1);
    expect(config.roomPort).toBe(65535);
    expect(config.siteUrl).toBe('http://127.0.0.1:1');
    expect(config.roomUrl).toBe('http://127.0.0.1:65535');
  });
});

describe('resolveDemoConfig rejects invalid values', () => {
  it.each([DEMO_SITE_PORT_VAR, DEMO_ROOM_PORT_VAR])(
    'rejects an invalid %s value',
    (variable) => {
      for (const value of INVALID_PORTS) {
        expect(() => resolveDemoConfig({ [variable]: value })).toThrow(variable);
      }
    },
  );

  it('names the variable, the raw value and the fallback in the port error', () => {
    expect(() => resolveDemoConfig({ DEMO_SITE_PORT: 'abc' })).toThrow(
      /Invalid DEMO_SITE_PORT "abc": expected an integer between 1 and 65535/,
    );
    expect(() => resolveDemoConfig({ DEMO_ROOM_PORT: '65536' })).toThrow(
      /Invalid DEMO_ROOM_PORT "65536": expected an integer between 1 and 65535/,
    );
  });

  it.each([
    'room:8787',
    'ftp://room:8787',
    'http://',
    'http://room:8787/room',
    'http://room:8787?probe=1',
    'http://room:8787#fragment',
    'http://user:secret@room:8787',
  ])('rejects the invalid DEMO_ROOM_URL %s', (value) => {
    expect(() => resolveDemoConfig({ DEMO_ROOM_URL: value })).toThrow(
      /Invalid DEMO_ROOM_URL/,
    );
  });
});

describe('URL helpers', () => {
  it('builds the site URL from the site port', () => {
    expect(demoSiteUrl(8080)).toBe('http://127.0.0.1:8080');
    expect(demoSiteUrl(8080, '0.0.0.0')).toBe('http://0.0.0.0:8080');
  });

  it('builds the health URL from the room origin', () => {
    expect(demoHealthUrl('http://127.0.0.1:8787')).toBe(
      'http://127.0.0.1:8787/health',
    );
    expect(demoHealthUrl('https://room.example.test/')).toBe(
      'https://room.example.test/health',
    );
    expect(demoHealthUrl()).toBe(`${DEFAULT_DEMO_ROOM_URL}${DEMO_HEALTH_PATH}`);
  });

  it('builds the room WebSocket URL and upgrades https to wss', () => {
    expect(demoWebSocketUrl('http://127.0.0.1:8787')).toBe(
      'ws://127.0.0.1:8787/ws',
    );
    expect(demoWebSocketUrl('https://room.example.test/')).toBe(
      'wss://room.example.test/ws',
    );
    expect(demoWebSocketUrl()).toBe('ws://127.0.0.1:8787/ws');
  });

  it('matches the URLs resolved into the config', () => {
    const config = resolveDemoConfig({ DEMO_SITE_PORT: '8081', DEMO_ROOM_PORT: '9000' });
    expect(config.siteUrl).toBe(demoSiteUrl(config.sitePort));
    expect(config.healthUrl).toBe(demoHealthUrl(config.roomUrl));
    expect(config.wsUrl).toBe(demoWebSocketUrl(config.roomUrl));
  });
});
