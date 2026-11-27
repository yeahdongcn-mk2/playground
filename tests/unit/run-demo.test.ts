import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROOM_PROXY_TARGET,
  resolveRoomProxyTarget,
} from '../../vite.config';
import {
  createDemoPlan,
  DEMO_PROBE_INTERVAL_MS,
  DEMO_READY_TIMEOUT_MS,
  main,
  runDemo,
  stopDemo,
  waitForDemoReady,
  type DemoChild,
  type DemoFetch,
  type DemoOutput,
  type DemoSpawn,
} from '../../scripts/run-demo.mjs';
import type { DemoConfigEnv } from '../../scripts/lib/demo-config.mjs';

const ROOT = '/repo';
/** The real CLI file, executed as a child process by the entry-point test. */
const RUN_DEMO_SCRIPT = fileURLToPath(
  new URL('../../scripts/run-demo.mjs', import.meta.url),
);
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE_CLI = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: {
    readonly cwd: string;
    readonly env: DemoConfigEnv;
    readonly stdio: 'inherit';
    readonly shell: boolean;
  };
}

/**
 * Stand-in for a spawned demo process.
 *
 * `autoExitOnKill` makes SIGTERM behave like a well-behaved vite/tsx child;
 * turning it off lets a test observe the shutdown sequence before either
 * process reports its exit.
 */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killedWith: Array<NodeJS.Signals | number> = [];
  private readonly autoExitOnKill: boolean;

  constructor(autoExitOnKill = true) {
    super();
    this.autoExitOnKill = autoExitOnKill;
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killedWith.push(signal);
    if (this.autoExitOnKill) {
      queueMicrotask(() => {
        this.finish(null, typeof signal === 'string' ? signal : null);
      });
    }
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface SpawnHarness {
  readonly children: FakeChild[];
  readonly calls: SpawnCall[];
  readonly spawnImpl: DemoSpawn;
}

function createSpawn(autoExitOnKill = true): SpawnHarness {
  const children: FakeChild[] = [];
  const calls: SpawnCall[] = [];
  const spawnImpl: DemoSpawn = (command, args, options) => {
    const child = new FakeChild(autoExitOnKill);
    children.push(child);
    calls.push({ command, args, options });
    return child as unknown as DemoChild;
  };
  return { children, calls, spawnImpl };
}

interface CapturedOutput {
  readonly stream: DemoOutput;
  text(): string;
}

function captureOutput(): CapturedOutput {
  const chunks: string[] = [];
  return {
    stream: {
      write(data: string): boolean {
        chunks.push(data);
        return true;
      },
    },
    text: () => chunks.join(''),
  };
}

/** Poll until an assertion stops throwing; the demo is driven by events. */
async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
}

const READY_MARKER = 'Demo ready:';

function okFetch(fetched: string[]): DemoFetch {
  return async (url) => {
    fetched.push(url);
    return { ok: true };
  };
}

describe('createDemoPlan', () => {
  it('resolves the default 8080/8787 pair and both launch commands', () => {
    const plan = createDemoPlan({}, ROOT);

    expect(plan.cwd).toBe(ROOT);
    expect(plan.distEntry).toBe(join(ROOT, 'dist', 'index.html'));
    expect(plan.config.sitePort).toBe(8080);
    expect(plan.config.roomPort).toBe(8787);

    expect(plan.build.command).toBe(NPM_COMMAND);
    expect(plan.build.args).toEqual(['run', 'build']);

    // The room half is the same tsx entry as `npm run server:room`.
    expect(plan.room.command).toBe(process.execPath);
    expect(plan.room.args).toEqual([TSX_CLI, 'server/room/main.ts']);
    expect(plan.room.env.HOST).toBe('127.0.0.1');
    expect(plan.room.env.PORT).toBe('8787');

    // The site half previews the built output and proxies /ws to the room.
    expect(plan.preview.command).toBe(process.execPath);
    expect(plan.preview.args).toEqual([
      VITE_CLI,
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      '8080',
      '--strictPort',
    ]);
    expect(plan.preview.env.DEMO_ROOM_URL).toBe('http://127.0.0.1:8787');
  });

  it('follows DEMO_SITE_PORT, DEMO_ROOM_PORT and DEMO_ROOM_URL overrides', () => {
    const plan = createDemoPlan(
      {
        DEMO_SITE_PORT: ' 9090 ',
        DEMO_ROOM_PORT: '9191',
        DEMO_ROOM_URL: 'http://room.internal:9292',
      },
      ROOT,
    );

    expect(plan.config.siteUrl).toBe('http://127.0.0.1:9090');
    expect(plan.preview.args).toContain('9090');
    expect(plan.room.env.PORT).toBe('9191');
    expect(plan.preview.env.DEMO_ROOM_URL).toBe('http://room.internal:9292');
    expect(plan.config.healthUrl).toBe('http://room.internal:9292/health');
  });

  it('derives the room URL from an overridden port when only the port changes', () => {
    const plan = createDemoPlan({ DEMO_ROOM_PORT: '9191' }, ROOT);

    expect(plan.preview.env.DEMO_ROOM_URL).toBe('http://127.0.0.1:9191');
    expect(plan.config.healthUrl).toBe('http://127.0.0.1:9191/health');
  });

  it('propagates the contract error for an invalid port', () => {
    expect(() => createDemoPlan({ DEMO_SITE_PORT: 'not-a-port' }, ROOT)).toThrow(
      /DEMO_SITE_PORT/,
    );
  });
});

describe('runDemo', () => {
  it('starts both servers, prints the ready URLs and stops both on SIGTERM', async () => {
    const signals = new EventEmitter();
    const { children, calls, spawnImpl } = createSpawn();
    const stdout = captureOutput();
    const stderr = captureOutput();
    const fetched: string[] = [];

    const running = runDemo({
      env: {},
      cwd: ROOT,
      spawnImpl,
      exists: () => true,
      fetchImpl: okFetch(fetched),
      sleep: async () => undefined,
      signals,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    await waitFor(() => {
      expect(stdout.text()).toContain(READY_MARKER);
    });

    // Both children start together, with no build step when dist exists.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toBe(process.execPath);
    expect(calls[0]?.args).toEqual([TSX_CLI, 'server/room/main.ts']);
    expect(calls[0]?.options.env).toMatchObject({
      HOST: '127.0.0.1',
      PORT: '8787',
    });
    expect(calls[0]?.options.stdio).toBe('inherit');
    expect(calls[1]?.args).toEqual([
      VITE_CLI,
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      '8080',
      '--strictPort',
    ]);
    expect(calls[1]?.options.env.DEMO_ROOM_URL).toBe('http://127.0.0.1:8787');

    // Both readiness URLs are polled and both are printed for the user.
    expect(fetched).toContain('http://127.0.0.1:8787/health');
    expect(fetched).toContain('http://127.0.0.1:8080');
    expect(stdout.text()).toContain('http://127.0.0.1:8080');
    expect(stdout.text()).toContain('http://127.0.0.1:8787');
    expect(stdout.text()).toContain('http://127.0.0.1:8787/health');
    expect(stdout.text()).toContain('Press Ctrl-C');

    signals.emit('SIGTERM');
    const result = await running;

    expect(result.code).toBe(0);
    expect(children[0]?.killedWith).toEqual(['SIGTERM']);
    expect(children[1]?.killedWith).toEqual(['SIGTERM']);
    // The signal handlers are one-shot and removed once the demo stops.
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(stdout.text()).toContain('Demo stopped');
  });

  it('builds first when dist/index.html is missing', async () => {
    const signals = new EventEmitter();
    const { children, calls, spawnImpl } = createSpawn();
    const stdout = captureOutput();

    const running = runDemo({
      env: {},
      cwd: ROOT,
      spawnImpl,
      exists: () => false,
      fetchImpl: okFetch([]),
      sleep: async () => undefined,
      signals,
      stdout: stdout.stream,
      stderr: captureOutput().stream,
    });

    await waitFor(() => {
      expect(children).toHaveLength(1);
    });
    expect(calls[0]?.command).toBe(NPM_COMMAND);
    expect(calls[0]?.args).toEqual(['run', 'build']);
    expect(calls[0]?.options.cwd).toBe(ROOT);
    expect(stdout.text()).toContain('npm run build');

    // A successful build is followed by the two servers.
    children[0]?.finish(0);
    await waitFor(() => {
      expect(children).toHaveLength(3);
      expect(stdout.text()).toContain(READY_MARKER);
    });

    signals.emit('SIGINT');
    await expect(running).resolves.toMatchObject({ code: 0 });
    expect(children[1]?.killedWith).toEqual(['SIGTERM']);
    expect(children[2]?.killedWith).toEqual(['SIGTERM']);
  });

  it('does not start the servers when the build fails', async () => {
    const { children, spawnImpl } = createSpawn();
    const stdout = captureOutput();

    const running = runDemo({
      env: {},
      cwd: ROOT,
      spawnImpl,
      exists: () => false,
      fetchImpl: okFetch([]),
      sleep: async () => undefined,
      signals: new EventEmitter(),
      stdout: stdout.stream,
      stderr: captureOutput().stream,
    });
    const rejected = expect(running).rejects.toThrow(/site build failed/);

    await waitFor(() => {
      expect(children).toHaveLength(1);
    });
    children[0]?.finish(2);
    await rejected;
    expect(children).toHaveLength(1);
  });

  it('stops the other server and fails when one child exits unexpectedly', async () => {
    const signals = new EventEmitter();
    const { children, spawnImpl } = createSpawn();
    const stdout = captureOutput();

    const running = runDemo({
      env: {},
      cwd: ROOT,
      spawnImpl,
      exists: () => true,
      fetchImpl: okFetch([]),
      sleep: async () => undefined,
      signals,
      stdout: stdout.stream,
      stderr: captureOutput().stream,
    });
    const rejected = expect(running).rejects.toThrow(
      /room service exited unexpectedly/,
    );

    await waitFor(() => {
      expect(stdout.text()).toContain(READY_MARKER);
    });
    // The room service crashed after the demo became ready.
    children[0]?.finish(9);
    await rejected;

    expect(children[1]?.killedWith).toEqual(['SIGTERM']);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('stops both children when a signal arrives before the stack is ready', async () => {
    const signals = new EventEmitter();
    const { children, spawnImpl } = createSpawn();
    const stdout = captureOutput();

    const running = runDemo({
      env: {},
      cwd: ROOT,
      spawnImpl,
      exists: () => true,
      // Never answers: only the signal can end this startup.
      fetchImpl: () => new Promise<{ ok: boolean }>(() => undefined),
      sleep: async () => undefined,
      signals,
      stdout: stdout.stream,
      stderr: captureOutput().stream,
    });

    await waitFor(() => {
      expect(children).toHaveLength(2);
    });
    signals.emit('SIGINT');

    await expect(running).resolves.toMatchObject({ code: 0 });
    expect(children[0]?.killedWith).toEqual(['SIGTERM']);
    expect(children[1]?.killedWith).toEqual(['SIGTERM']);
    expect(stdout.text()).not.toContain(READY_MARKER);
  });
});

describe('CLI entry point', () => {
  it('reports a startup failure as { plan: null, code: 1 } and sets the exit code', async () => {
    const previousExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // An invalid port throws while resolving the plan, before any child is
      // spawned, so this exercises main() without opening a port.
      const result = await main({ DEMO_SITE_PORT: 'nope' });

      expect(result).toEqual({ plan: null, code: 1 });
      // The only way a failed start reaches the shell; removing it must fail
      // this test rather than silently turning the failure into exit 0.
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('DEMO_SITE_PORT'),
      );
    } finally {
      process.exitCode = previousExitCode;
      errorSpy.mockRestore();
    }
  });

  it('exits non-zero when the script itself is executed with an invalid port', () => {
    const result = spawnSync(process.execPath, [RUN_DEMO_SCRIPT], {
      env: { ...process.env, DEMO_SITE_PORT: 'nope' },
      encoding: 'utf8',
      timeout: 30_000,
    });

    // This is the isDirectExecution + main wiring end to end: the script must
    // run the CLI, fail before starting a server and propagate exit code 1.
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DEMO_SITE_PORT');
    expect(result.stdout).not.toContain('Starting');
  });
});

describe('waitForDemoReady contract', () => {
  it('keeps the documented probe timing and overall timeout', () => {
    // Pinned so a change to the startup budget or probe cadence is visible in
    // review instead of only in a slow/flaky CI run.
    expect(DEMO_READY_TIMEOUT_MS).toBe(60_000);
    expect(DEMO_PROBE_INTERVAL_MS).toBe(250);
  });
});

describe('demo readiness URL', () => {
  it('probes the resolved health and site URLs', async () => {
    const fetched: string[] = [];
    const plan = createDemoPlan({ DEMO_SITE_PORT: '9090' }, ROOT);

    await waitForDemoReady(plan, {
      fetchImpl: okFetch(fetched),
      sleep: async () => undefined,
    });

    expect(fetched).toHaveLength(2);
    expect(fetched).toContain('http://127.0.0.1:8787/health');
    expect(fetched).toContain('http://127.0.0.1:9090');
  });
});

describe('stopDemo', () => {
  it('signals both children before waiting for either exit', async () => {
    const room = new FakeChild(false);
    const preview = new FakeChild(false);
    let settled = false;

    const stopping = stopDemo([room as unknown as DemoChild, preview as unknown as DemoChild], {
      killTimeoutMs: 1_000,
      stderr: captureOutput().stream,
    });
    stopping.then(() => {
      settled = true;
    });

    // Both SIGTERMs happen in the same turn, before either child exits.
    expect(room.killedWith).toEqual(['SIGTERM']);
    expect(preview.killedWith).toEqual(['SIGTERM']);
    expect(settled).toBe(false);

    room.finish(null, 'SIGTERM');
    await Promise.resolve();
    expect(settled).toBe(false);

    preview.finish(null, 'SIGTERM');
    await stopping;
    expect(room.signalCode).toBe('SIGTERM');
    expect(preview.signalCode).toBe('SIGTERM');
  });

  it('skips children that already exited', async () => {
    const room = new FakeChild();
    room.finish(0);

    await stopDemo([room as unknown as DemoChild], {
      killTimeoutMs: 100,
      stderr: captureOutput().stream,
    });

    expect(room.killedWith).toEqual([]);
  });
});

describe('vite preview proxy target', () => {
  afterEach(() => {
    // The config module reads process.env at import time, so both the stub and
    // the module cache must be restored for the next test.
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps the e2e 4176 target unless DEMO_ROOM_URL is set', () => {
    expect(DEFAULT_ROOM_PROXY_TARGET).toBe('http://127.0.0.1:4176');
    expect(resolveRoomProxyTarget({})).toBe(DEFAULT_ROOM_PROXY_TARGET);
    expect(resolveRoomProxyTarget({ DEMO_ROOM_URL: '   ' })).toBe(
      DEFAULT_ROOM_PROXY_TARGET,
    );
    expect(
      resolveRoomProxyTarget({ DEMO_ROOM_URL: 'http://127.0.0.1:8787' }),
    ).toBe('http://127.0.0.1:8787');
  });

  it('feeds DEMO_ROOM_URL into the preview /ws proxy target', async () => {
    vi.stubEnv('DEMO_ROOM_URL', 'http://127.0.0.1:18787');
    vi.resetModules();

    const { default: config } = await import('../../vite.config');

    // Guards the config wiring itself: hard-coding the target or dropping the
    // proxy entry must fail here even though the resolver stays correct.
    expect(config).toMatchObject({
      preview: {
        proxy: {
          '/ws': { target: 'http://127.0.0.1:18787', ws: true },
        },
      },
    });
  });

  it('keeps the default proxy target when DEMO_ROOM_URL is unset', async () => {
    const configured = process.env.DEMO_ROOM_URL;
    delete process.env.DEMO_ROOM_URL;
    try {
      vi.resetModules();
      const {
        default: config,
        DEFAULT_ROOM_PROXY_TARGET: fallback,
      } = await import('../../vite.config');

      expect(fallback).toBe('http://127.0.0.1:4176');
      expect(config).toMatchObject({
        preview: { proxy: { '/ws': { target: fallback, ws: true } } },
      });
    } finally {
      if (configured !== undefined) {
        process.env.DEMO_ROOM_URL = configured;
      }
    }
  });
});
