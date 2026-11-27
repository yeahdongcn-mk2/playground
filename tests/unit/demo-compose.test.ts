import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  DEFAULT_DEMO_ROOM_PORT,
  DEFAULT_DEMO_SITE_PORT,
  DEMO_HEALTH_PATH,
  DEMO_ROOM_PORT_VAR,
  DEMO_ROOM_URL_VAR,
  DEMO_SITE_PORT_VAR,
  DEMO_WS_PATH,
} from '../../scripts/lib/demo-config.mjs';
import { DEFAULT_ROOM_SERVER_PORT } from '../../server/room/contracts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const WEB_DOCKERFILE = 'docker/demo/web.Dockerfile';
const ROOM_DOCKERFILE = 'docker/demo/room.Dockerfile';
const NGINX_TEMPLATE = 'docker/demo/nginx.conf.template';
const WEB_ENTRYPOINT = 'docker/demo/web-entrypoint.sh';

const WEB_CONTAINER_PORT = 80;

interface ComposeBuild {
  readonly context?: string;
  readonly dockerfile?: string;
}

interface ComposeHealthcheck {
  readonly test?: readonly string[];
  readonly interval?: string;
  readonly timeout?: string;
  readonly retries?: number;
  readonly start_period?: string;
}

interface ComposeService {
  readonly build?: ComposeBuild;
  readonly environment?: Readonly<Record<string, string>>;
  readonly ports?: readonly string[];
  readonly expose?: readonly string[];
  readonly healthcheck?: ComposeHealthcheck;
  readonly depends_on?: Readonly<Record<string, { readonly condition?: string }>>;
}

interface ComposeFile {
  readonly services?: Readonly<Record<string, ComposeService>>;
  readonly volumes?: unknown;
}

/** Read one repository file and fail with its path instead of an ENOENT. */
function readRepoFile(relativePath: string): string {
  const absolutePath = join(ROOT, relativePath);
  expect(existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return readFileSync(absolutePath, 'utf8');
}

const compose = parse(readRepoFile('compose.yaml')) as ComposeFile;

/** Read one service or fail with the compose path and the missing name. */
function service(name: string): ComposeService {
  const found = compose.services?.[name];
  if (found === undefined) {
    throw new Error(`compose.yaml is missing the "${name}" service`);
  }
  return found;
}

const web = service('web');
const room = service('room');

/** The `${VARIABLE:-fallback}` string a compose port mapping must publish. */
function publishedMapping(
  variable: string,
  fallback: number,
  containerPort: number,
): string {
  return `127.0.0.1:\${${variable}:-${fallback}}:${containerPort}`;
}

/** Extract the fallback from a `${VARIABLE:-fallback}` compose expression. */
function composeDefault(expression: string | undefined, variable: string): string {
  const match = new RegExp(`\\$\\{${variable}:-([^}]*)\\}`).exec(expression ?? '');
  const fallback = match?.[1];
  if (fallback === undefined) {
    throw new Error(`${String(expression)} is not a ${variable} default expression`);
  }
  return fallback;
}

describe('compose demo stack shape', () => {
  it('defines exactly the web and room services', () => {
    expect(Object.keys(compose.services ?? {}).sort()).toEqual(['room', 'web']);
  });

  it('builds each service from the repository root with its demo Dockerfile', () => {
    expect(web.build).toEqual({ context: '.', dockerfile: WEB_DOCKERFILE });
    expect(room.build).toEqual({ context: '.', dockerfile: ROOM_DOCKERFILE });
  });

  it('publishes the site and room ports on loopback with contract defaults', () => {
    expect(web.ports).toEqual([
      publishedMapping(DEMO_SITE_PORT_VAR, DEFAULT_DEMO_SITE_PORT, WEB_CONTAINER_PORT),
    ]);
    expect(room.ports).toEqual([
      publishedMapping(
        DEMO_ROOM_PORT_VAR,
        DEFAULT_DEMO_ROOM_PORT,
        DEFAULT_ROOM_SERVER_PORT,
      ),
    ]);
    expect(room.expose).toEqual([String(DEFAULT_ROOM_SERVER_PORT)]);
  });

  it('wires the room container to listen on every interface for the web proxy', () => {
    expect(room.environment?.HOST).toBe('0.0.0.0');
    expect(room.environment?.PORT).toBe(String(DEFAULT_ROOM_SERVER_PORT));
  });

  it('defaults the web container proxy target to the room service', () => {
    expect(web.environment?.[DEMO_ROOM_URL_VAR]).toBe(
      `\${${DEMO_ROOM_URL_VAR}:-http://room:${DEFAULT_DEMO_ROOM_PORT}}`,
    );
  });

  it('starts the web service only after the room service is healthy', () => {
    expect(web.depends_on).toEqual({ room: { condition: 'service_healthy' } });
    expect(room.depends_on).toBeUndefined();
  });

  it('healthchecks both services', () => {
    expect(web.healthcheck?.test).toEqual([
      'CMD-SHELL',
      'wget -q -O /dev/null http://127.0.0.1/',
    ]);
    expect(room.healthcheck?.test).toEqual([
      'CMD-SHELL',
      `wget -q -O - http://127.0.0.1:${DEFAULT_ROOM_SERVER_PORT}${DEMO_HEALTH_PATH} | grep -q '"status":"ok"'`,
    ]);

    for (const healthcheck of [web.healthcheck, room.healthcheck]) {
      expect(healthcheck?.interval).toBe('5s');
      expect(healthcheck?.timeout).toBe('3s');
      expect(healthcheck?.retries).toBe(12);
      expect(healthcheck?.start_period).toBe('5s');
    }
  });

  it('declares no volumes so down and down -v both leave nothing behind', () => {
    expect(compose.volumes).toBeUndefined();
  });
});

describe('nginx same-origin room proxy', () => {
  const template = readRepoFile(NGINX_TEMPLATE);

  it('serves the built site with an index.html fallback', () => {
    expect(template).toContain('location / {');
    expect(template).toContain('try_files $uri $uri/ /index.html;');
  });

  it('proxies the same-origin WebSocket path to DEMO_ROOM_URL', () => {
    expect(template).toContain(`location ${DEMO_WS_PATH} {`);
    expect(template).toContain(`proxy_pass \${${DEMO_ROOM_URL_VAR}};`);
    // A trailing slash would make nginx rewrite /ws to /; the entrypoint
    // strips user-supplied trailing slashes before this template renders.
    expect(template).not.toContain(`proxy_pass \${${DEMO_ROOM_URL_VAR}}/;`);
  });

  it('forwards the HTTP/1.1 upgrade headers the room service needs', () => {
    expect(template).toMatch(/proxy_http_version\s+1\.1;/);
    expect(template).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(template).toContain('proxy_set_header Connection $demo_connection_upgrade;');
  });
});

describe('demo Dockerfiles and build context', () => {
  it('builds dist/ in a node stage and serves it from nginx', () => {
    const dockerfile = readRepoFile(WEB_DOCKERFILE);
    expect(dockerfile).toMatch(/^FROM node:\S+ AS build$/m);
    expect(dockerfile).toContain('RUN npm ci');
    expect(dockerfile).toContain('RUN npm run build');
    expect(dockerfile).toContain(
      'COPY --from=build /app/dist /usr/share/nginx/html',
    );
    expect(dockerfile).toMatch(/^FROM nginx:\S+$/m);
    expect(dockerfile).toContain(
      `COPY ${NGINX_TEMPLATE} /etc/nginx/templates/default.conf.template`,
    );
  });

  it('runs the existing room entry point through tsx', () => {
    const dockerfile = readRepoFile(ROOM_DOCKERFILE);
    expect(dockerfile).toMatch(/^FROM node:\S+$/m);
    expect(dockerfile).toContain('RUN npm ci');
    expect(dockerfile).toContain('server/room/main.ts');
    // The room layer reuses the shared Minesweeper engine and wire contract.
    expect(dockerfile).toContain('COPY src ./src');
    expect(dockerfile).toContain('tsx');
    expect(dockerfile).toContain('ENV HOST=0.0.0.0');
    expect(dockerfile).toContain(`ENV PORT=${DEFAULT_ROOM_SERVER_PORT}`);
    expect(dockerfile).toContain(`EXPOSE ${DEFAULT_ROOM_SERVER_PORT}`);
  });

  it('normalizes trailing slashes out of the proxy origin before nginx starts', () => {
    const entrypoint = readRepoFile(WEB_ENTRYPOINT);
    expect(entrypoint).toContain('${room_url%/}');
    expect(entrypoint).toContain('export DEMO_ROOM_URL="$room_url"');
    expect(entrypoint).toContain('exec /docker-entrypoint.sh "$@"');
  });

  it('keeps sources in the build context and local artifacts out of it', () => {
    const entries = readRepoFile('.dockerignore')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    for (const ignored of ['.git', '.github', '.plan', 'node_modules', 'dist']) {
      expect(entries).toContain(ignored);
    }
    for (const kept of ['src', 'server', 'public', 'package.json', 'docker/demo']) {
      expect(entries).not.toContain(kept);
    }
  });
});

describe('compose defaults stay in sync with the demo contract', () => {
  it('publishes the contract site port by default', () => {
    expect(DEFAULT_DEMO_SITE_PORT).toBe(8080);
    expect(composeDefault(web.ports?.[0], DEMO_SITE_PORT_VAR)).toBe(
      String(DEFAULT_DEMO_SITE_PORT),
    );
  });

  it('publishes the room service port the room contract defines', () => {
    expect(DEFAULT_DEMO_ROOM_PORT).toBe(DEFAULT_ROOM_SERVER_PORT);
    expect(DEFAULT_ROOM_SERVER_PORT).toBe(8787);
    expect(composeDefault(room.ports?.[0], DEMO_ROOM_PORT_VAR)).toBe(
      String(DEFAULT_DEMO_ROOM_PORT),
    );
    expect(room.environment?.PORT).toBe(String(DEFAULT_DEMO_ROOM_PORT));
  });

  it('points the proxy default at the room service and its contract port', () => {
    expect(
      composeDefault(web.environment?.[DEMO_ROOM_URL_VAR], DEMO_ROOM_URL_VAR),
    ).toBe(`http://room:${DEFAULT_DEMO_ROOM_PORT}`);
  });
});
