/**
 * Code Mode isolate limits and cancellation, on real V8 isolates (WP-55,
 * SES-4 / SES-6).
 *
 *   - Console output is bounded on the host side: a script logging 1 GB is
 *     stopped with "console output limit exceeded" after about 1 MiB, and
 *     the process's memory stays bounded (before the fix the copied strings
 *     piled up as external memory, outside every V8 limit). The script can
 *     reach no `ivm.Reference` (whose non-blocking apply/applyIgnored queued
 *     copies past every host-side limit), and patched builtins or stack
 *     traces do not hand it the tool bridge.
 *   - A signal cancels a running script (its isolate is disposed at once)
 *     and a queued one; `shutdown()` cancels everything.
 *   - Scripts beyond the per-sandbox cap queue in FIFO order, a full queue
 *     refuses at once, and every sandbox draws on one process-wide budget.
 *   - Each bridged tool call gets a signal that aborts when its script ends.
 *
 * No MCP backends: `initialize()` registers an empty tool manual, so only
 * the isolate machinery runs here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from '@utcp/sdk';
import { Sandbox, type SandboxOptions } from '../src/sandbox/index.js';
import { runToolChain, CONSOLE_LIMIT_EXCEEDED, type ToolChainHost } from '../src/sandbox/code-mode-chain.js';
import {
  DEFAULT_MAX_CONSOLE_BYTES,
  DEFAULT_MAX_CONSOLE_ENTRIES,
  WeightedSemaphore,
  chainMemoryWeightMb,
} from '../src/sandbox/chain-limits.js';
import { linesSize } from '../src/session/truncate-result.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { testCompiledPolicy, testToolAnnotations, REAL_TMP } from './fixtures/test-policy.js';
import { isIsolatedVmAvailable } from './helpers/isolated-vm-available.js';

const TEST_ROOT = `${REAL_TMP}/ironcurtain-chain-limits-${process.pid}`;
const GENERATED_DIR = `${TEST_ROOT}/generated`;
const SANDBOX_DIR = `${TEST_ROOT}/sandbox`;

function makeConfig(name: string): IronCurtainConfig {
  return {
    auditLogPath: `${TEST_ROOT}/audit-${name}.jsonl`,
    allowedDirectory: SANDBOX_DIR,
    mcpServers: {},
    protectedPaths: [],
    generatedDir: GENERATED_DIR,
    constitutionPath: resolve(TEST_ROOT, 'constitution.md'),
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      escalationTimeoutSeconds: 300,
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      serverCredentials: {},
    },
  } as unknown as IronCurtainConfig;
}

let sandboxCounter = 0;
const sandboxes: Sandbox[] = [];

async function startSandbox(options: SandboxOptions = {}): Promise<Sandbox> {
  const sandbox = new Sandbox(options);
  sandboxes.push(sandbox);
  await sandbox.initialize(makeConfig(`s${++sandboxCounter}`));
  return sandbox;
}

/** A script that keeps its isolate busy for `ms`, then reports when it ran. */
function busyScript(ms: number): string {
  return `const start = Date.now(); while (Date.now() < start + ${ms}) {} return { start, end: Date.now() };`;
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe.skipIf(!isIsolatedVmAvailable())('Code Mode isolate limits', () => {
  beforeAll(() => {
    mkdirSync(SANDBOX_DIR, { recursive: true });
    mkdirSync(GENERATED_DIR, { recursive: true });
    writeFileSync(resolve(GENERATED_DIR, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(GENERATED_DIR, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));
  });

  afterAll(async () => {
    for (const sandbox of sandboxes.splice(0)) await sandbox.shutdown();
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  describe('console output', () => {
    it('stops a script logging 1 GB with "console output limit exceeded" while host memory stays bounded', async () => {
      const sandbox = await startSandbox();
      const rssBefore = process.memoryUsage().rss;
      const started = Date.now();

      const { result, logs } = await sandbox.executeCode(`
        const chunk = 'x'.repeat(1 << 20);
        for (let i = 0; i < 1024; i++) console.log(chunk);
        return 'finished';
      `);

      const elapsedMs = Date.now() - started;
      const rssGrowth = process.memoryUsage().rss - rssBefore;
      expect(result).toBeNull();
      expect(logs.at(-1)).toContain(`Code execution failed: ${CONSOLE_LIMIT_EXCEEDED}`);
      // Fails fast: stopped at the first message past the limit, not at the timeout.
      expect(elapsedMs).toBeLessThan(10_000);
      // Before the fix every 1 MiB message stayed in host memory (> 1 GB).
      expect(rssGrowth).toBeLessThan(256 * 1024 * 1024);
      // What was kept is within the limit.
      expect(linesSize(logs.slice(0, -1))).toBeLessThanOrEqual(DEFAULT_MAX_CONSOLE_BYTES + logs.length);
    });

    it('leaves the script no ivm.Reference: every host bridge is a blocking call', async () => {
      // A Reference offers non-blocking apply/applyIgnored: each call copies
      // its arguments into host memory and returns at once, so a loop over
      // one queued gigabytes past every host-side limit (measured: ~1 GB via
      // the console bridge, ~4 GB held until the timeout via the tool
      // bridge). The script must not be able to find one anywhere.
      const sandbox = await startSandbox();
      const { result, logs } = await sandbox.executeCode(`
        const isReference = (v) => {
          try { return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.applyIgnored === 'function'; }
          catch (e) { return false; }
        };
        const found = [];
        const seen = new Set();
        const scan = (value, path, depth) => {
          if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value) || depth > 3) return;
          seen.add(value);
          if (isReference(value)) found.push(path);
          let keys = [];
          try { keys = Reflect.ownKeys(value); } catch (e) {}
          for (const key of keys) {
            let child;
            try { child = value[key]; } catch (e) { continue; }
            scan(child, path + '.' + String(key), depth + 1);
          }
        };
        scan(globalThis, 'global', 0);
        const names = ['__logRef', '__errorRef', '__warnRef', '__infoRef', '__callToolRef',
          '__consoleLog', '__consoleError', '__consoleWarn', '__consoleInfo', '__callToolBridge'];
        return {
          found,
          bridgeGlobals: names.filter((name) => typeof globalThis[name] !== 'undefined'),
          resultCallbacksBlocking: typeof __resolveResult === 'function' && typeof __resolveResult.applyIgnored === 'undefined'
            && typeof __rejectResult === 'function' && typeof __rejectResult.applyIgnored === 'undefined',
        };
      `);
      expect(logs).toEqual([]);
      expect(result).toEqual({ found: [], bridgeGlobals: [], resultCallbacksBlocking: true });
    });

    it('stops a script that makes more console calls than the entry limit', async () => {
      const sandbox = await startSandbox();
      const { result, logs } = await sandbox.executeCode(`
        for (let i = 0; i < 1000000; i++) console.log('');
        return 'finished';
      `);
      expect(result).toBeNull();
      expect(logs.at(-1)).toContain(CONSOLE_LIMIT_EXCEEDED);
      expect(logs).toHaveLength(DEFAULT_MAX_CONSOLE_ENTRIES + 1);
    });

    it('keeps ordinary console output and the return value', async () => {
      const sandbox = await startSandbox();
      const { result, logs } = await sandbox.executeCode(`
        console.log('hello', { a: 1 });
        console.error('oops');
        return 42;
      `);
      expect(result).toBe(42);
      expect(logs).toEqual(['hello {\n  "a": 1\n}', '[ERROR] oops']);
    });
  });

  describe('memory limit and timeout', () => {
    it('applies the configured isolate memory limit', async () => {
      const sandbox = await startSandbox({ memoryLimitMb: 16 });
      const { result, logs } = await sandbox.executeCode(`
        const keep = [];
        for (let i = 0; i < 1e7; i++) keep.push('item-' + i + '-'.repeat(64));
        return keep.length;
      `);
      expect(result).toBeNull();
      expect(logs.join('\n')).toMatch(/Code execution failed: .*(memory|disposed)/i);
    });

    it('never runs longer than the caller allows', async () => {
      const sandbox = await startSandbox();
      const started = Date.now();
      const { result, logs } = await sandbox.executeCode('while (true) {}', { timeoutMs: 300 });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result).toBeNull();
      expect(logs.join('\n')).toContain('Script execution timeout after');
    });
  });

  describe('cancellation', () => {
    it('cancels a running script when its signal aborts, long before the timeout', async () => {
      const sandbox = await startSandbox();
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('the turn was cancelled')), 200);
      const started = Date.now();
      const { result, logs } = await sandbox.executeCode('while (true) {}', {
        signal: controller.signal,
        timeoutMs: 60_000,
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result).toBeNull();
      expect(logs.join('\n')).toContain('Script execution cancelled: the turn was cancelled');
    });

    it('cancels a script parked on a promise that never settles', async () => {
      const sandbox = await startSandbox();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const { result, logs } = await sandbox.executeCode('await new Promise(() => {}); return 1;', {
        signal: controller.signal,
      });
      expect(result).toBeNull();
      expect(logs.join('\n')).toContain('Script execution cancelled');
    });

    it('does not start a script whose signal has already aborted', async () => {
      const sandbox = await startSandbox();
      const { result, logs } = await sandbox.executeCode('return 1;', { signal: AbortSignal.abort() });
      expect(result).toBeNull();
      expect(logs.join('\n')).toContain('cancelled');
    });

    it('shutdown() cancels a running script', async () => {
      const sandbox = new Sandbox();
      await sandbox.initialize(makeConfig('shutdown'));
      const running = sandbox.executeCode('while (true) {}', { timeoutMs: 60_000 });
      await waitFor(() => sandbox.getChainLoad().running === 1);
      const started = Date.now();
      await sandbox.shutdown();
      const { result, logs } = await running;
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result).toBeNull();
      expect(logs.join('\n')).toContain('the Code Mode sandbox is shutting down');
    });
  });

  describe('concurrency', () => {
    it('queues execute_code calls beyond the per-sandbox cap and runs them in order', async () => {
      const sandbox = await startSandbox({ maxConcurrentChains: 2 });
      const calls = [0, 1, 2].map(() => sandbox.executeCode(busyScript(400)));
      await waitFor(() => sandbox.getChainLoad().running === 2);
      expect(sandbox.getChainLoad()).toEqual({ running: 2, queued: 1 });

      const results = await Promise.all(calls);
      const spans = results.map((r) => r.result as { start: number; end: number });
      for (const span of spans) expect(span).toEqual({ start: expect.any(Number), end: expect.any(Number) });
      // The third script started only after one of the first two finished.
      expect(spans[2].start).toBeGreaterThanOrEqual(Math.min(spans[0].end, spans[1].end) - 5);
      expect(sandbox.getChainLoad()).toEqual({ running: 0, queued: 0 });
    });

    it('refuses a call at once when the queue is full', async () => {
      const sandbox = await startSandbox({ maxConcurrentChains: 1, maxQueuedChains: 1 });
      const first = sandbox.executeCode(busyScript(300));
      const second = sandbox.executeCode(busyScript(10));
      await waitFor(() => sandbox.getChainLoad().queued === 1);
      const third = await sandbox.executeCode('return 3;');
      expect(third.result).toBeNull();
      expect(third.logs.join('\n')).toContain('too many execute_code calls are waiting');
      expect((await first).result).not.toBeNull();
      expect((await second).result).not.toBeNull();
    });

    it('a queued call leaves the queue when its signal aborts', async () => {
      const sandbox = await startSandbox({ maxConcurrentChains: 1 });
      const first = sandbox.executeCode(busyScript(300));
      const controller = new AbortController();
      const queued = sandbox.executeCode('return 2;', { signal: controller.signal });
      await waitFor(() => sandbox.getChainLoad().queued === 1);
      controller.abort(new Error('no longer needed'));
      const outcome = await queued;
      expect(outcome.result).toBeNull();
      expect(outcome.logs.join('\n')).toContain('cancelled while waiting');
      expect(sandbox.getChainLoad().queued).toBe(0);
      expect((await first).result).not.toBeNull();
    });

    it('scripts of different sandboxes share the process-wide budget', async () => {
      // Room for exactly one default-size script in the whole "process".
      const processBudget = new WeightedSemaphore(chainMemoryWeightMb(128));
      const a = await startSandbox({ processBudget });
      const b = await startSandbox({ processBudget });
      const first = a.executeCode(busyScript(300));
      const second = b.executeCode(busyScript(10));
      await waitFor(() => processBudget.queued === 1);
      expect(b.getChainLoad()).toEqual({ running: 1, queued: 0 });

      const [one, two] = await Promise.all([first, second]);
      const firstSpan = one.result as { end: number };
      const secondSpan = two.result as { start: number };
      expect(secondSpan.start).toBeGreaterThanOrEqual(firstSpan.end - 5);
      expect(processBudget.used).toBe(0);
    });
  });
});

describe.skipIf(!isIsolatedVmAvailable())('runToolChain tool calls', () => {
  const tool: Tool = {
    name: 'tools.demo.slow',
    description: 'test tool',
    inputs: { type: 'object', properties: {} },
    outputs: { type: 'object', properties: {} },
    tags: [],
    tool_call_template: { call_template_type: 'test' },
  } as unknown as Tool;
  const host: ToolChainHost = {
    getTools: async () => [tool],
    getAllToolsTypeScriptInterfaces: async () => '',
    toolToTypeScriptInterface: () => '',
  };
  const limits = {
    memoryLimitMb: 64,
    maxConsoleBytes: DEFAULT_MAX_CONSOLE_BYTES,
    maxConsoleEntries: DEFAULT_MAX_CONSOLE_ENTRIES,
  };

  it("aborts a tool call's signal when the script times out while the call is pending", async () => {
    const seen: AbortSignal[] = [];
    const { result, logs } = await runToolChain(host, 'return tools.demo_slow({});', {
      ...limits,
      timeoutMs: 300,
      callTool: (_name, _args, signal) => {
        seen.push(signal);
        // Never settles on its own: only the chain's end releases it.
        return new Promise(() => {});
      },
    });
    expect(result).toBeNull();
    expect(logs.join('\n')).toContain('Script execution timeout');
    expect(logs.join('\n')).toContain('abandoned');
    expect(seen).toHaveLength(1);
    expect(seen[0].aborted).toBe(true);
    expect((seen[0].reason as Error).message).toContain('timed out');
  });

  it('aborts the signal of every call still pending when the script is cancelled', async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const run = runToolChain(host, 'return tools.demo_slow({});', {
      ...limits,
      timeoutMs: 60_000,
      signal: controller.signal,
      callTool: (_name, _args, signal) => {
        seen.push(signal);
        controller.abort(new Error('session closed'));
        return new Promise(() => {});
      },
    });
    const { result, logs } = await run;
    expect(result).toBeNull();
    expect(logs.join('\n')).toContain('Script execution cancelled: session closed');
    expect(seen[0]?.aborted).toBe(true);
  });

  it('runs each tool call in the async context of the code that started the chain', async () => {
    // isolated-vm calls the host back with no async context; without the
    // binding, the coordinator's work for a tool call (its policy and
    // auto-approve log lines among it) lost the session's logger claim.
    const context = new AsyncLocalStorage<string>();
    const seen: Array<{ session: string; entry: string | undefined; afterAwait: string | undefined }> = [];
    const runAs = (session: string): Promise<unknown> =>
      context.run(session, () =>
        runToolChain(host, 'tools.demo_slow({}); return tools.demo_slow({});', {
          ...limits,
          timeoutMs: 5_000,
          callTool: async () => {
            const entry = context.getStore();
            await new Promise((resolve) => setTimeout(resolve, 5));
            seen.push({ session, entry, afterAwait: context.getStore() });
            return 'ok';
          },
        }),
      );

    await Promise.all([runAs('session-a'), runAs('session-b')]);
    expect(seen).toHaveLength(4);
    for (const call of seen) {
      expect(call.entry).toBe(call.session);
      expect(call.afterAwait).toBe(call.session);
    }
  });

  it('passes tool results through and leaves the signal of a settled call alone', async () => {
    const seen: AbortSignal[] = [];
    const { result } = await runToolChain(host, 'return tools.demo_slow({ n: 1 });', {
      ...limits,
      timeoutMs: 5_000,
      callTool: async (_name, args, signal) => {
        seen.push(signal);
        return { echoed: args };
      },
    });
    expect(result).toEqual({ echoed: { n: 1 } });
    // The chain is over now; the call had settled before that.
    expect(seen).toHaveLength(1);
  });

  it('rejects tool arguments that are not a JSON object', async () => {
    let calls = 0;
    // The stub serializes its argument with JSON.stringify, which the script
    // can replace: JSON text that is not an object reaches the host check, a
    // value that is not text at all is refused in the stub.
    const { result } = await runToolChain(
      host,
      `const realStringify = JSON.stringify;
       const attempt = (fake) => {
         JSON.stringify = () => fake;
         try { tools.demo_slow({}); return 'ran'; } catch (e) { return e.message; } finally { JSON.stringify = realStringify; }
       };
       return [attempt('null'), attempt('[1]'), attempt({ notText: true }), attempt(undefined)];`,
      {
        ...limits,
        timeoutMs: 5_000,
        callTool: async () => {
          calls++;
          return 'ran';
        },
      },
    );
    expect(result).toEqual(Array.from({ length: 4 }, () => 'Tool arguments must be a JSON object'));
    expect(calls).toBe(0);
  });

  it('does not leak the tool bridge through patched builtins or stack traces', async () => {
    const { result } = await runToolChain(
      host,
      `const caught = [];
       const note = (v) => {
         try {
           if (v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.applyIgnored === 'function') caught.push(v);
         } catch (e) {}
       };
       const realBind = Function.prototype.bind;
       Function.prototype.bind = function (thisArg, ...rest) {
         note(this); note(thisArg); rest.forEach(note);
         return Reflect.apply(realBind, this, [thisArg, ...rest]);
       };
       const realMap = Array.prototype.map;
       Array.prototype.map = function (fn, thisArg) { note(this); note(fn); note(thisArg); return Reflect.apply(realMap, this, [fn, thisArg]); };
       const realParse = JSON.parse;
       JSON.parse = function (...args) { args.forEach(note); return Reflect.apply(realParse, JSON, args); };
       Error.prepareStackTrace = (error, frames) => {
         for (const frame of frames) {
           try { note(frame.getThis()); } catch (e) {}
           try { note(frame.getFunction()); } catch (e) {}
         }
         return 'trace';
       };
       console.log('through the patched map');
       const ok = tools.demo_slow({ n: 1 });
       let failed = '';
       try { tools.demo_slow({ fail: true }); } catch (e) { failed = e.message; void e.stack; }
       return { caught: caught.length, ok, failed };`,
      {
        ...limits,
        timeoutMs: 5_000,
        callTool: async (_name, args) => {
          if (args.fail === true) throw new Error('backend refused');
          return { echoed: args };
        },
      },
    );
    expect(result).toEqual({ caught: 0, ok: { echoed: { n: 1 } }, failed: 'backend refused' });
  });
});
