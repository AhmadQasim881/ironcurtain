/**
 * CodeModeProxy connection handling over a stub sandbox, so it runs on every
 * host (the full proxy integration test needs isolated-vm and a real MCP
 * backend): one MCP server per agent connection with its own JSON-RPC id
 * space and its own circuit-breaker lane, malformed frames isolated to their
 * connection, and the warnings an agent can trigger bounded before they reach
 * the host's session log. Also (WP-55): a request the agent cancels, or whose
 * connection closes, cancels its script, and the reply's `[logs]` section and
 * return value share one size budget. And (WP-85): each call runs in the
 * async context the proxy was created in, so its log lines reach the
 * session's logger claim. And (FU-13): a connection that never reads its
 * replies is throttled instead of having them pile up in host memory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { connect as netConnect, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { UdsClientTransport } from './helpers/uds-client-transport.js';

const warn = vi.hoisted(() => vi.fn<(message: string) => void>());
vi.mock('../src/logger.js', () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }));
/** Every `executeCode` call the stub sandbox received, with its options. */
const executions = vi.hoisted(() => [] as Array<{ code: string; lane: string | undefined }>);
/** The options the stub sandbox was initialized with. */
const initOptions = vi.hoisted(() => [] as Array<{ maxLanes?: number }>);

type StubExecute = (
  code: string,
  options?: { signal?: AbortSignal; lane?: string },
) => Promise<{ result: unknown; logs: string[] }>;

/** Per-test behaviour of the stub sandbox, and what the proxy built it with. */
const stub = vi.hoisted(() => ({
  execute: undefined as StubExecute | undefined,
  constructedWith: [] as unknown[],
}));

vi.mock('../src/sandbox/index.js', () => ({
  Sandbox: class {
    constructor(options?: unknown) {
      stub.constructedWith.push(options);
    }
    async initialize(_config: unknown, options: { maxLanes?: number } = {}): Promise<void> {
      initOptions.push(options);
    }
    async executeCode(
      code: string,
      options?: { signal?: AbortSignal; lane?: string },
    ): Promise<{ result: unknown; logs: string[] }> {
      executions.push({ code, lane: options?.lane });
      if (stub.execute) return stub.execute(code, options);
      return { result: `ran: ${code}`, logs: [] };
    }
    getHelpData(): unknown {
      return { serverDescriptions: {}, toolsByServer: {} };
    }
    getCoordinator(): null {
      return null;
    }
    async shutdown(): Promise<void> {}
  },
}));

import { createCodeModeProxy, formatExecutionOutput, type DockerProxy } from '../src/docker/code-mode-proxy.js';
import { AGENT_WARNING_BUDGET } from '../src/docker/agent-warning-log.js';
import { CODE_MODE_PROXY_MAX_CONCURRENT_CHAINS } from '../src/sandbox/chain-limits.js';

// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function connectRaw(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath, () => resolve(socket));
    socket.on('error', reject);
  });
}

/** Resolves with the next newline-terminated line the socket receives. */
function readLine(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline !== -1) {
        socket.off('data', onData);
        resolve(buffer.slice(0, newline));
      }
    };
    socket.on('data', onData);
  });
}

function waitForClose(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once('close', () => resolve());
  });
}

/** True if the socket emits 'drain' within `ms`; false if its peer has stopped reading. */
function drainedWithin(socket: Socket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onDrain = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      socket.off('drain', onDrain);
      resolve(false);
    }, ms);
    socket.once('drain', onDrain);
  });
}

describe('CodeModeProxy agent connections', () => {
  let dir: string;
  let socketPath: string;
  let proxy: DockerProxy | undefined;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    warn.mockClear();
    stub.execute = undefined;
    stub.constructedWith.length = 0;
    executions.length = 0;
    initOptions.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'cmp-conn-'));
    socketPath = join(dir, 'proxy.sock');
    proxy = createCodeModeProxy({ socketPath, config: {} as IronCurtainConfig, listenMode: 'uds' });
    await proxy.start();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await proxy?.stop();
    proxy = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves concurrent clients with colliding JSON-RPC ids on their own MCP servers', async () => {
    const clientA = new Client({ name: 'lane-a', version: '0' }, {});
    const clientB = new Client({ name: 'lane-b', version: '0' }, {});
    try {
      // Both connect before either calls: the second must not evict the first.
      await clientA.connect(new UdsClientTransport(socketPath));
      await clientB.connect(new UdsClientTransport(socketPath));
      // Both clients number their requests the same way, so these ids collide.
      const call = (client: Client, lane: string) =>
        client.callTool({ name: 'execute_code', arguments: { code: `return "${lane}";` } });
      const [a, b] = await Promise.all([call(clientA, 'lane-a'), call(clientB, 'lane-b')]);
      expect(a.content).toEqual([{ type: 'text', text: 'ran: return "lane-a";' }]);
      expect(b.content).toEqual([{ type: 'text', text: 'ran: return "lane-b";' }]);
    } finally {
      await clientA.close().catch(() => undefined);
      await clientB.close().catch(() => undefined);
    }
  });

  it('runs the code of each connection under its own host-assigned circuit-breaker lane', async () => {
    const clientA = new Client({ name: 'lane-a', version: '0' }, {});
    const clientB = new Client({ name: 'lane-b', version: '0' }, {});
    try {
      await clientA.connect(new UdsClientTransport(socketPath));
      await clientB.connect(new UdsClientTransport(socketPath));
      const run = (client: Client, code: string) => client.callTool({ name: 'execute_code', arguments: { code } });
      await run(clientA, 'a1');
      await run(clientB, 'b1');
      await run(clientA, 'a2');
    } finally {
      await clientA.close().catch(() => undefined);
      await clientB.close().catch(() => undefined);
    }

    const laneOf = (code: string) => executions.find((execution) => execution.code === code)?.lane;
    expect(laneOf('a1')).toEqual(expect.any(String));
    expect(laneOf('b1')).toEqual(expect.any(String));
    // Same connection, same lane; different connections, different lanes.
    expect(laneOf('a2')).toBe(laneOf('a1'));
    expect(laneOf('b1')).not.toBe(laneOf('a1'));

    // A reconnecting agent is a new connection, so a new lane: the breaker's
    // all-lanes window (maxLanes) is what bounds it, not the lane key.
    const clientC = new Client({ name: 'lane-a-again', version: '0' }, {});
    try {
      await clientC.connect(new UdsClientTransport(socketPath));
      await clientC.callTool({ name: 'execute_code', arguments: { code: 'c1' } });
    } finally {
      await clientC.close().catch(() => undefined);
    }
    expect(new Set([laneOf('a1'), laneOf('b1'), laneOf('c1')]).size).toBe(3);
  });

  it('hands maxLanes to the sandbox it initializes', async () => {
    const lanesSocket = join(dir, 'lanes.sock');
    const lanesProxy = createCodeModeProxy({
      socketPath: lanesSocket,
      config: {} as IronCurtainConfig,
      listenMode: 'uds',
      maxLanes: 4,
    });
    try {
      await lanesProxy.start();
      expect(initOptions.at(-1)?.maxLanes).toBe(4);
    } finally {
      await lanesProxy.stop();
    }
  });

  it('keeps a connection usable after a malformed frame and leaves other clients alone', async () => {
    const noisy = await connectRaw(socketPath);
    sockets.push(noisy);
    noisy.write('this is not json\n');

    const bystander = new Client({ name: 'bystander', version: '0' }, {});
    try {
      await bystander.connect(new UdsClientTransport(socketPath));
      expect((await bystander.listTools()).tools.map((t) => t.name)).toEqual(['execute_code']);
    } finally {
      await bystander.close().catch(() => undefined);
    }

    const reply = readLine(noisy);
    noisy.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    expect(JSON.parse(await reply)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(noisy.destroyed).toBe(false);
  });

  it('bounds, escapes and rate-limits the warnings a hostile connection can trigger', async () => {
    const raw = await connectRaw(socketPath);
    sockets.push(raw);
    // V8 quotes raw input bytes (here an OSC 52 clipboard write) in a JSON
    // syntax error; the MCP SDK quotes a response to an unknown request id
    // back whole; and every garbage line is one more warning.
    raw.write('\u001b]52;c;ZXZpbA==\u0007 not json\n');
    raw.write(`{"jsonrpc":"2.0","id":4242,"result":{"blob":"${'A'.repeat(1_000_000)}"}}\n`);
    raw.write('x\n'.repeat(1_000));
    // Frames on one connection are handled in order: once this ping is
    // answered, every line before it has been processed.
    const reply = readLine(raw);
    raw.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    expect(JSON.parse(await reply)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });

    const lines = warn.mock.calls.map(([line]) => line);
    expect(lines).toHaveLength(AGENT_WARNING_BUDGET);
    for (const line of lines) {
      expect(RAW_CONTROL.test(line)).toBe(false);
      expect(line.length).toBeLessThan(2_000);
    }
    expect(lines[0]).toContain('\\u001b]52;c;');
    expect(lines[1]).toContain('unknown message ID');

    // stop() reports what the budget held back.
    await proxy?.stop();
    proxy = undefined;
    expect(warn.mock.calls.at(-1)?.[0]).toMatch(
      /^Code Mode proxy: \d+ further agent connection warning\(s\) suppressed/,
    );
  });

  it('stop() closes every agent connection', async () => {
    const a = await connectRaw(socketPath);
    const b = await connectRaw(socketPath);
    sockets.push(a, b);
    const replyA = readLine(a);
    a.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await replyA;

    await proxy?.stop();
    proxy = undefined;
    await Promise.all([waitForClose(a), waitForClose(b)]);
  });

  it('stops reading from a connection that sends pings without reading the replies, and serves it once it reads', async () => {
    const flooder = await connectRaw(socketPath);
    flooder.on('error', () => undefined);
    sockets.push(flooder);
    flooder.pause(); // never reads a reply

    // Pings until the proxy stops taking them: a write that does not drain
    // within half a second while the flooder reads nothing. Without the
    // send-side bound the proxy takes all of them and queues every reply.
    let sent = 0;
    let stalled = false;
    while (!stalled && sent < 1_000_000) {
      let batch = '';
      for (let i = 0; i < 1_000; i++) batch += `{"jsonrpc":"2.0","id":${sent++},"method":"ping"}\n`;
      if (flooder.write(batch)) await new Promise((resolve) => setImmediate(resolve));
      else stalled = !(await drainedWithin(flooder, 500));
    }
    expect(stalled).toBe(true);

    // Other agents are served meanwhile.
    const bystander = new Client({ name: 'bystander', version: '0' }, {});
    try {
      await bystander.connect(new UdsClientTransport(socketPath));
      expect((await bystander.listTools()).tools.map((t) => t.name)).toEqual(['execute_code']);
    } finally {
      await bystander.close().catch(() => undefined);
    }

    // Throttled, not dropped: once it reads, every ping it sent is answered.
    let answered = 0;
    flooder.on('data', (chunk: Buffer) => {
      for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, at + 1)) answered++;
    });
    flooder.resume();
    await vi.waitFor(
      () => {
        expect(answered).toBe(sent);
      },
      { timeout: 20_000, interval: 20 },
    );
    expect(flooder.destroyed).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('runs a bounded number of scripts at once (sandbox built with the proxy cap)', () => {
    expect(stub.constructedWith).toEqual([{ maxConcurrentChains: CODE_MODE_PROXY_MAX_CONCURRENT_CHAINS }]);
  });

  it('cancels the script when the agent cancels its request', async () => {
    let seen: AbortSignal | undefined;
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    stub.execute = async (_code, options) => {
      seen = options?.signal;
      started();
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { result: null, logs: ['[ERROR] Code execution failed: Script execution cancelled'] };
    };
    const client = new Client({ name: 'canceller', version: '0' }, {});
    try {
      await client.connect(new UdsClientTransport(socketPath));
      const controller = new AbortController();
      const call = client
        .callTool({ name: 'execute_code', arguments: { code: 'while (true) {}' } }, undefined, {
          signal: controller.signal,
        })
        .catch((err: unknown) => err);
      await running;
      expect(seen?.aborted).toBe(false);
      controller.abort(new Error('the agent gave up'));
      await call;
      await vi.waitFor(() => {
        expect(seen?.aborted).toBe(true);
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("cancels the script when the agent's connection closes", async () => {
    let seen: AbortSignal | undefined;
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    stub.execute = async (_code, options) => {
      seen = options?.signal;
      started();
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { result: null, logs: [] };
    };
    const client = new Client({ name: 'leaver', version: '0' }, {});
    await client.connect(new UdsClientTransport(socketPath));
    const call = client
      .callTool({ name: 'execute_code', arguments: { code: 'while (true) {}' } })
      .catch((err: unknown) => err);
    await running;
    await client.close();
    await call;
    await vi.waitFor(() => {
      expect(seen?.aborted).toBe(true);
    });
  });

  it('runs execute_code in the async context the proxy was created in (the session logger claim)', async () => {
    // An accepted socket's data events carry no async context, so without
    // the proxy's binding the coordinator's lines for an agent's tool calls
    // (policy decisions, auto-approve) lost the session's logger claim and
    // landed in the daemon log. The proxy is created inside the context and
    // started and called from outside it, as a session's bundle is.
    const context = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    stub.execute = async (code) => {
      seen.push(context.getStore());
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(context.getStore());
      return { result: `ran: ${code}`, logs: [] };
    };
    const sessionSocket = join(dir, 'session-proxy.sock');
    const sessionProxy = context.run('session-a', () =>
      createCodeModeProxy({ socketPath: sessionSocket, config: {} as IronCurtainConfig, listenMode: 'uds' }),
    );
    const client = new Client({ name: 'agent', version: '0' }, {});
    try {
      await sessionProxy.start();
      await client.connect(new UdsClientTransport(sessionSocket));
      await client.callTool({ name: 'execute_code', arguments: { code: 'return 1;' } });
      await client.callTool({ name: 'execute_code', arguments: { code: 'return 2;' } });
    } finally {
      await client.close().catch(() => undefined);
      await sessionProxy.stop();
    }
    expect(context.getStore()).toBeUndefined();
    expect(seen).toEqual(['session-a', 'session-a', 'session-a', 'session-a']);
  });

  it('bounds the [logs] section and the return value under one budget', async () => {
    const logs = Array.from({ length: 5_000 }, (_, i) => `log line ${i} `.padEnd(120, '.'));
    logs.push('[ERROR] Code execution failed: kept at the end');
    stub.execute = async () => ({ result: { data: 'd'.repeat(400_000) }, logs });
    const client = new Client({ name: 'flooder', version: '0' }, {});
    try {
      await client.connect(new UdsClientTransport(socketPath));
      const reply = await client.callTool({ name: 'execute_code', arguments: { code: 'flood()' } });
      const text = (reply.content as Array<{ type: string; text: string }>)[0].text;
      expect(Buffer.byteLength(text)).toBeLessThan(110_000);
      expect(text.startsWith('[logs]\nlog line 0 ')).toBe(true);
      expect(text).toContain('console output truncated');
      expect(text).toContain('kept at the end');
      expect(text).toContain('[... truncated');
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe('formatExecutionOutput', () => {
  it('keeps small output whole: logs, a blank line, then the return value', () => {
    expect(formatExecutionOutput({ a: 1 }, ['one', 'two'])).toBe('[logs]\none\ntwo\n\n{\n  "a": 1\n}');
    expect(formatExecutionOutput('text', [])).toBe('text');
    expect(formatExecutionOutput(undefined, [])).toBe('(no return value)');
  });

  it('gives the return value the room the console does not need, and the other way round', () => {
    const big = 'v'.repeat(50_000);
    const withShortLogs = formatExecutionOutput(big, ['short'], 10_000);
    expect(Buffer.byteLength(withShortLogs)).toBeLessThanOrEqual(10_100);
    expect(withShortLogs).toContain('[logs]\nshort');

    const manyLogs = Array.from({ length: 1_000 }, (_, i) => `entry ${i}`);
    const withShortResult = formatExecutionOutput('done', manyLogs, 2_000);
    expect(Buffer.byteLength(withShortResult)).toBeLessThanOrEqual(2_100);
    expect(withShortResult.endsWith('\n\ndone')).toBe(true);
    expect(withShortResult).toContain('entry 999');
  });
});
