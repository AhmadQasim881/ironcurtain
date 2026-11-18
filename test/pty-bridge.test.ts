/**
 * Unit tests for the PTY bridge (src/pty/pty-bridge.ts):
 *  - `buildSpawnArgs`: pure child-argv construction (F6), testable without spawning.
 *  - `createPtyBridge` output wiring: the `onData` stream sink + `serialize()`
 *    reconnect snapshot (web-ui additions), with node-pty and the session
 *    registry mocked so no real child is spawned and discovery resolves at once.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as logger from '../src/logger.js';
import {
  buildSpawnArgs,
  createPtyBridge,
  PTY_KILL_GRACE_MS,
  PTY_KILL_RETRY_MS,
  type PtyBridgeOptions,
} from '../src/pty/pty-bridge.js';
import { PTY_MAX_COLS, PTY_MAX_ROWS, PTY_MIN_COLS, PTY_MIN_ROWS } from '../src/pty/pty-size.js';

/** Shared, mutable fake-child state reachable from the hoisted node-pty mock. */
const ptyMock = vi.hoisted(() => {
  const state: {
    dataCb?: (d: string) => void;
    exitCb?: (e: { exitCode: number }) => void;
    killCalls: string[];
    killExits: boolean;
    /** Every `child.resize(cols, rows)` the bridge issued. */
    resizeCalls: Array<[number, number]>;
    /** The `{ cols, rows }` the bridge spawned the child with. */
    spawnSize: { cols: number; rows: number } | undefined;
    /** The environment the last spawn was given. */
    lastEnv?: Record<string, string>;
    /** Every `child.write(data)` the bridge issued (keystrokes and query replies). */
    writes: string[];
  } = { killCalls: [], killExits: true, resizeCalls: [], spawnSize: undefined, writes: [] };
  return { state };
});

vi.mock('node-pty', () => {
  const spawn = (_bin: string, _args: string[], opts: { cols: number; rows: number; env?: Record<string, string> }) => {
    ptyMock.state.spawnSize = { cols: opts.cols, rows: opts.rows };
    ptyMock.state.lastEnv = opts.env;
    return {
      pid: 424242,
      onData: (cb: (d: string) => void) => {
        ptyMock.state.dataCb = cb;
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        ptyMock.state.exitCb = cb;
      },
      write: (data: string) => {
        ptyMock.state.writes.push(data);
      },
      resize: (cols: number, rows: number) => {
        ptyMock.state.resizeCalls.push([cols, rows]);
      },
      kill: (signal: string) => {
        ptyMock.state.killCalls.push(signal);
        if (ptyMock.state.killExits) {
          ptyMock.state.exitCb?.({ exitCode: signal === 'SIGTERM' ? 143 : 137 });
        }
      },
    };
  };
  return { default: { spawn }, spawn };
});

// Registry mock, controllable per-test. Default: resolve discovery immediately
// with a matching registration so the bridge's background poll returns on its
// first iteration -- no 200ms timer outlives a test. The session-discovery
// tests override the return value to exercise slow/late/never registration.
const registryMock = vi.hoisted(() => {
  const DEFAULT = [{ pid: 424242, sessionId: 'sess-test', escalationDir: '/tmp/esc-test' }];
  return { readActiveRegistrations: vi.fn(() => DEFAULT), DEFAULT };
});
vi.mock('../src/escalation/session-registry.js', () => ({
  readActiveRegistrations: registryMock.readActiveRegistrations,
}));

/** Minimal always-required options; per-test flags are layered on top. */
function baseOptions(overrides: Partial<PtyBridgeOptions> = {}): PtyBridgeOptions {
  return {
    cols: 80,
    rows: 24,
    ironcurtainBin: 'ironcurtain',
    agent: 'claude-code',
    ...overrides,
  };
}

describe('buildSpawnArgs', () => {
  it('always emits the start --pty --agent base', () => {
    expect(buildSpawnArgs(baseOptions())).toEqual(['start', '--pty', '--agent', 'claude-code']);
  });

  it('prepends prefixArgs (tsx loader / script path) before the subcommand', () => {
    const args = buildSpawnArgs(baseOptions({ prefixArgs: ['--import', 'tsx', '/path/cli.ts'] }));
    expect(args.slice(0, 5)).toEqual(['--import', 'tsx', '/path/cli.ts', 'start', '--pty']);
  });

  it('appends --provider-profile <name> when providerProfileName is set', () => {
    const args = buildSpawnArgs(baseOptions({ providerProfileName: 'kimi' }));
    expect(args).toContain('--provider-profile');
    const flagIdx = args.indexOf('--provider-profile');
    expect(args[flagIdx + 1]).toBe('kimi');
  });

  it('omits --provider-profile when providerProfileName is unset', () => {
    expect(buildSpawnArgs(baseOptions())).not.toContain('--provider-profile');
  });

  it('omits --provider-profile when providerProfileName is empty string', () => {
    expect(buildSpawnArgs(baseOptions({ providerProfileName: '' }))).not.toContain('--provider-profile');
  });

  // --- Pin existing flag behavior so the extraction didn't regress it. ---

  it('appends --workspace <path> when set, omits when unset', () => {
    expect(buildSpawnArgs(baseOptions({ workspacePath: '/w/s' }))).toContain('--workspace');
    const args = buildSpawnArgs(baseOptions({ workspacePath: '/w/s' }));
    expect(args[args.indexOf('--workspace') + 1]).toBe('/w/s');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--workspace');
  });

  it('appends --persona <name> when set, omits when unset', () => {
    const args = buildSpawnArgs(baseOptions({ persona: 'exec-assistant' }));
    expect(args[args.indexOf('--persona') + 1]).toBe('exec-assistant');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--persona');
  });

  it('appends --resume <id> when set, omits when unset', () => {
    const args = buildSpawnArgs(baseOptions({ resumeSessionId: 'session-xyz' }));
    expect(args[args.indexOf('--resume') + 1]).toBe('session-xyz');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--resume');
  });

  it('appends --model <id> when set, omits when unset', () => {
    const args = buildSpawnArgs(baseOptions({ model: 'claude-opus-4' }));
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--model');
  });

  it('appends --capture-traces (a boolean flag) only when true', () => {
    expect(buildSpawnArgs(baseOptions({ captureTraces: true }))).toContain('--capture-traces');
    expect(buildSpawnArgs(baseOptions({ captureTraces: false }))).not.toContain('--capture-traces');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--capture-traces');
  });

  it('emits all selection flags together in the documented order', () => {
    const args = buildSpawnArgs(
      baseOptions({
        prefixArgs: ['/cli.js'],
        resumeSessionId: 'sid',
        workspacePath: '/ws',
        persona: 'p',
        providerProfileName: 'glm-5.2',
        model: 'm',
        captureTraces: true,
      }),
    );
    expect(args).toEqual([
      '/cli.js',
      'start',
      '--pty',
      '--agent',
      'claude-code',
      '--resume',
      'sid',
      '--workspace',
      '/ws',
      '--persona',
      'p',
      '--provider-profile',
      'glm-5.2',
      '--model',
      'm',
      '--capture-traces',
    ]);
  });
});

describe('createPtyBridge — child environment', () => {
  const NAMES = [
    'NODE_OPTIONS',
    'MCP_SERVERS_CONFIG',
    'SERVER_CREDENTIALS',
    'ANTHROPIC_API_KEY',
    'LD_PRELOAD',
  ] as const;
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("keeps the user's credentials but drops code-injection and relay-internal variables", async () => {
    // The child is IronCurtain itself (`start --pty`), so it needs the same
    // credentials as the parent; what must not cross are the variables that
    // run code in every Node child and the ones that configure one MCP relay.
    process.env.NODE_OPTIONS = '--require /tmp/evil.js';
    process.env.LD_PRELOAD = '/tmp/evil.so';
    process.env.MCP_SERVERS_CONFIG = '{"github":{}}';
    process.env.SERVER_CREDENTIALS = '{"TOKEN":"x"}';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-user';

    const bridge = await createPtyBridge(baseOptions({ muxId: 'mux-1', muxPid: 4242 }));
    const env = ptyMock.state.lastEnv ?? {};
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-user');
    expect(env.IRONCURTAIN_MUX_ID).toBe('mux-1');
    expect(env.IRONCURTAIN_MUX_PID).toBe('4242');
    expect(env.PATH).toBe(process.env.PATH);
    for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'MCP_SERVERS_CONFIG', 'SERVER_CREDENTIALS']) {
      expect(env, name).not.toHaveProperty(name);
    }
    // And process.env itself was not mutated by the spawn.
    expect(process.env.IRONCURTAIN_MUX_ID).toBeUndefined();
    bridge.kill();
  });
});

describe('createPtyBridge — output wiring (onData / serialize)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    ptyMock.state.dataCb = undefined;
    ptyMock.state.exitCb = undefined;
    ptyMock.state.killCalls = [];
    ptyMock.state.killExits = true;
  });

  it('onData fires with the chunk AFTER the headless buffer reflects it', async () => {
    const bridge = await createPtyBridge(baseOptions());
    const observed: Array<{ chunk: string; inSnapshot: boolean }> = [];
    // A serialize() taken inside the onData handler must already contain the chunk
    // -- this is the reconnect ordering invariant (onData fires post buffer-write).
    bridge.onData((chunk) => {
      observed.push({ chunk, inSnapshot: bridge.serialize().includes('MARKER') });
    });

    ptyMock.state.dataCb?.('MARKER-text');
    await tick();

    expect(observed).toHaveLength(1);
    expect(observed[0].chunk).toBe('MARKER-text');
    expect(observed[0].inSnapshot).toBe(true);
    bridge.kill();
  });

  it('fires onOutput (grid sink) before onData (stream sink)', async () => {
    const bridge = await createPtyBridge(baseOptions());
    const order: string[] = [];
    bridge.onOutput(() => order.push('output'));
    bridge.onData(() => order.push('data'));

    ptyMock.state.dataCb?.('x');
    await tick();

    expect(order).toEqual(['output', 'data']);
    bridge.kill();
  });

  it('onData unsubscribe stops further callbacks', async () => {
    const bridge = await createPtyBridge(baseOptions());
    const seen: string[] = [];
    const unsub = bridge.onData((c) => seen.push(c));

    ptyMock.state.dataCb?.('a');
    await tick();
    unsub();
    ptyMock.state.dataCb?.('b');
    await tick();

    expect(seen).toEqual(['a']);
    bridge.kill();
  });

  it('serialize() reflects written screen content', async () => {
    const bridge = await createPtyBridge(baseOptions());
    ptyMock.state.dataCb?.('hello serialize');
    await tick();
    expect(bridge.serialize()).toContain('hello serialize');
    bridge.kill();
  });

  it('serialize({ scrollback }) caps the tail without throwing', async () => {
    const bridge = await createPtyBridge(baseOptions());
    ptyMock.state.dataCb?.('line one\r\nline two');
    await tick();
    const snap = bridge.serialize({ scrollback: 0 });
    expect(typeof snap).toBe('string');
    bridge.kill();
  });
});

// TUI-10: programs query their terminal (cursor position, device attributes)
// and wait for the answer. Under the mux only the headless terminal can
// answer; its replies must reach the child's PTY, and only when asked for.
describe('createPtyBridge — terminal query replies', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    ptyMock.state.dataCb = undefined;
    ptyMock.state.exitCb = undefined;
    ptyMock.state.killCalls = [];
    ptyMock.state.killExits = true;
    ptyMock.state.writes = [];
  });

  it('answers a cursor position request (DSR 6) with a CPR written to the child', async () => {
    const bridge = await createPtyBridge(baseOptions({ answerTerminalQueries: true }));

    ptyMock.state.dataCb?.('hello\x1b[6n');
    await tick();

    // Row 1, column 6: after the five characters of "hello".
    expect(ptyMock.state.writes).toEqual(['\x1b[1;6R']);
    bridge.kill();
  });

  it('answers a primary device attributes request (DA1)', async () => {
    const bridge = await createPtyBridge(baseOptions({ answerTerminalQueries: true }));

    ptyMock.state.dataCb?.('\x1b[c');
    await tick();

    expect(ptyMock.state.writes).toHaveLength(1);
    // eslint-disable-next-line no-control-regex
    expect(ptyMock.state.writes[0]).toMatch(/^\x1b\[\?[0-9;]+c$/u);
    bridge.kill();
  });

  it('writes no reply when not asked to (the web UI: the browser xterm answers)', async () => {
    const bridge = await createPtyBridge(baseOptions());

    ptyMock.state.dataCb?.('hello\x1b[6n\x1b[c');
    await tick();

    expect(ptyMock.state.writes).toEqual([]);
    bridge.kill();
  });

  it('writes no reply once the child has exited', async () => {
    const bridge = await createPtyBridge(baseOptions({ answerTerminalQueries: true }));
    bridge.kill();
    expect(bridge.alive).toBe(false);

    ptyMock.state.dataCb?.('\x1b[6n');
    await tick();

    expect(ptyMock.state.writes).toEqual([]);
  });

  it('keystrokes still reach the child unchanged next to the replies', async () => {
    const bridge = await createPtyBridge(baseOptions({ answerTerminalQueries: true }));

    bridge.write('ls\r');
    ptyMock.state.dataCb?.('\x1b[6n');
    await tick();

    expect(ptyMock.state.writes).toEqual(['ls\r', '\x1b[1;1R']);
    bridge.kill();
  });
});

// WEB-12: a single oversized resize made the headless terminal allocate
// gigabytes (off-heap, unbounded by --max-old-space-size) and wrapped
// node-pty's unsigned-short winsize. The bridge clamps every resize source.
describe('createPtyBridge — size bounds', () => {
  beforeEach(() => {
    ptyMock.state.dataCb = undefined;
    ptyMock.state.exitCb = undefined;
    ptyMock.state.killCalls = [];
    ptyMock.state.killExits = true;
    ptyMock.state.resizeCalls = [];
    ptyMock.state.spawnSize = undefined;
  });

  it('clamps an oversized resize for both the child PTY and the headless terminal', async () => {
    const bridge = await createPtyBridge(baseOptions());

    bridge.resize(1_000_000, 1_000_000);

    expect(ptyMock.state.resizeCalls).toEqual([[PTY_MAX_COLS, PTY_MAX_ROWS]]);
    expect(bridge.terminal.cols).toBe(PTY_MAX_COLS);
    expect(bridge.terminal.rows).toBe(PTY_MAX_ROWS);
    bridge.kill();
  });

  it('clamps an undersized or non-finite resize to the minima (fail-safe: smallest allocation)', async () => {
    const bridge = await createPtyBridge(baseOptions());

    bridge.resize(0, -5);
    bridge.resize(Number.NaN, Number.POSITIVE_INFINITY);

    expect(ptyMock.state.resizeCalls).toEqual([
      [PTY_MIN_COLS, PTY_MIN_ROWS],
      [PTY_MIN_COLS, PTY_MIN_ROWS],
    ]);
    expect(bridge.terminal.cols).toBe(PTY_MIN_COLS);
    expect(bridge.terminal.rows).toBe(PTY_MIN_ROWS);
    bridge.kill();
  });

  it('passes an in-range resize through unchanged', async () => {
    const bridge = await createPtyBridge(baseOptions());

    bridge.resize(120, 40);

    expect(ptyMock.state.resizeCalls).toEqual([[120, 40]]);
    expect(bridge.terminal.cols).toBe(120);
    expect(bridge.terminal.rows).toBe(40);
    bridge.kill();
  });

  it('clamps the initial spawn size as well', async () => {
    const bridge = await createPtyBridge(baseOptions({ cols: 50_000, rows: 9_000 }));

    expect(ptyMock.state.spawnSize).toEqual({ cols: PTY_MAX_COLS, rows: PTY_MAX_ROWS });
    expect(bridge.terminal.cols).toBe(PTY_MAX_COLS);
    expect(bridge.terminal.rows).toBe(PTY_MAX_ROWS);
    bridge.kill();
  });
});

describe('createPtyBridge — termination escalation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ptyMock.state.dataCb = undefined;
    ptyMock.state.exitCb = undefined;
    ptyMock.state.killCalls = [];
    ptyMock.state.killExits = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('escalates from SIGTERM to SIGKILL after the grace period', async () => {
    const bridge = await createPtyBridge(baseOptions());
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const forceKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      ptyMock.state.exitCb?.({ exitCode: 137 });
      return true;
    });

    try {
      bridge.kill();
      expect(ptyMock.state.killCalls).toEqual(['SIGTERM']);

      await vi.advanceTimersByTimeAsync(PTY_KILL_GRACE_MS - 1);
      expect(ptyMock.state.killCalls).toEqual(['SIGTERM']);

      await vi.advanceTimersByTimeAsync(1);
      expect(ptyMock.state.killCalls).toEqual(['SIGTERM']);
      expect(forceKillSpy).toHaveBeenCalledWith(424242, 'SIGKILL');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`pid=424242`));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`${PTY_KILL_GRACE_MS}ms`));
    } finally {
      warnSpy.mockRestore();
      forceKillSpy.mockRestore();
    }
  });

  it('cancels SIGKILL when the child exits during the grace period', async () => {
    const bridge = await createPtyBridge(baseOptions());
    const forceKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    try {
      bridge.kill();
      ptyMock.state.exitCb?.({ exitCode: 143 });
      await vi.advanceTimersByTimeAsync(PTY_KILL_GRACE_MS);

      expect(bridge.alive).toBe(false);
      expect(ptyMock.state.killCalls).toEqual(['SIGTERM']);
      expect(forceKillSpy).not.toHaveBeenCalled();
    } finally {
      forceKillSpy.mockRestore();
    }
  });

  it('makes repeated kill calls idempotent while termination is pending', async () => {
    const bridge = await createPtyBridge(baseOptions());
    const forceKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      ptyMock.state.exitCb?.({ exitCode: 137 });
      return true;
    });

    try {
      bridge.kill();
      bridge.kill();
      expect(ptyMock.state.killCalls).toEqual(['SIGTERM']);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(PTY_KILL_GRACE_MS);
      expect(forceKillSpy).toHaveBeenCalledTimes(1);
    } finally {
      forceKillSpy.mockRestore();
    }
  });

  it('retries a failed direct SIGKILL until onExit confirms termination', async () => {
    const bridge = await createPtyBridge(baseOptions());
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const forceKillSpy = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw new Error('force kill failed');
      })
      .mockImplementation(() => {
        ptyMock.state.exitCb?.({ exitCode: 137 });
        return true;
      });

    try {
      bridge.kill();
      await vi.advanceTimersByTimeAsync(PTY_KILL_GRACE_MS);
      expect(forceKillSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('pid=424242'));

      await vi.advanceTimersByTimeAsync(PTY_KILL_RETRY_MS);
      expect(forceKillSpy).toHaveBeenCalledTimes(2);
      expect(bridge.alive).toBe(false);
    } finally {
      errorSpy.mockRestore();
      forceKillSpy.mockRestore();
    }
  });

  it('throttles persistent force-kill failure logs while continuing retries', async () => {
    const bridge = await createPtyBridge(baseOptions());
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const forceKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('EPERM');
    });

    try {
      bridge.kill();
      await vi.advanceTimersByTimeAsync(PTY_KILL_GRACE_MS);
      expect(forceKillSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(9 * PTY_KILL_RETRY_MS);
      expect(forceKillSpy).toHaveBeenCalledTimes(10);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(PTY_KILL_RETRY_MS);
      expect(forceKillSpy).toHaveBeenCalledTimes(11);
      expect(errorSpy).toHaveBeenCalledTimes(2);

      ptyMock.state.exitCb?.({ exitCode: 137 });
    } finally {
      errorSpy.mockRestore();
      forceKillSpy.mockRestore();
    }
  });
});

describe('createPtyBridge — session discovery (no fixed timeout)', () => {
  afterEach(() => {
    registryMock.readActiveRegistrations.mockImplementation(() => registryMock.DEFAULT);
    ptyMock.state.exitCb = undefined;
    vi.useRealTimers();
  });

  it('discovers a registration that appears long after the child spawns', async () => {
    // Regression: a slow container runtime (Apple `container` boots a VM per
    // container) can take well over the former 10s discovery deadline to
    // register. Discovery must keep polling while the child is alive, else the
    // escalation watcher never starts and escalations never surface.
    vi.useFakeTimers();
    registryMock.readActiveRegistrations.mockReturnValue([]); // not registered yet
    const bridge = await createPtyBridge(baseOptions());
    let discovered: unknown = 'unset';
    bridge.onSessionDiscovered((reg) => {
      discovered = reg;
    });

    // Well past the former 10s deadline with no registration -> still polling,
    // NOT resolved to null (the bug: it used to give up here).
    await vi.advanceTimersByTimeAsync(15_000);
    expect(discovered).toBe('unset');

    // Registration finally appears; the next poll surfaces it.
    registryMock.readActiveRegistrations.mockReturnValue([
      { pid: 424242, sessionId: 'sess-late', escalationDir: '/tmp/esc-late' },
    ]);
    await vi.advanceTimersByTimeAsync(200);
    expect(discovered).toMatchObject({ sessionId: 'sess-late', escalationDir: '/tmp/esc-late' });
    bridge.kill();
  });

  it('resolves discovery to null when the child exits before registering', async () => {
    vi.useFakeTimers();
    registryMock.readActiveRegistrations.mockReturnValue([]); // never registers
    const bridge = await createPtyBridge(baseOptions());
    let discovered: unknown = 'unset';
    bridge.onSessionDiscovered((reg) => {
      discovered = reg;
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(discovered).toBe('unset');

    // Child exits -> discovery aborts -> queued callbacks flush with null.
    ptyMock.state.exitCb?.({ exitCode: 1 });
    expect(discovered).toBeNull();
  });
});
