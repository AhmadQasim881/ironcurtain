/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Code Mode chain runner: runs one `execute_code` script in a fresh
 * isolated-vm isolate, under limits the host enforces and a signal that can
 * cancel it.
 *
 * Provenance and license. This file is derived from
 * `CodeModeUtcpClient.callToolChain` and the private helpers it calls
 * (`setupConsoleBridge`, `setupToolBridges`, `setupUtilities`,
 * `disposeIsolateSafely`, `sanitizeIdentifier`) in @provos/utcp-code-mode
 * 1.2.13-ic.1, `src/code_mode_utcp_client.ts` (Copyright UTCP Contributors,
 * https://github.com/provos/code-mode), which IronCurtain installs as
 * `@utcp/code-mode`. That file is licensed under the Mozilla Public License
 * 2.0, and so is this one. The MPL applies file by file: the rest of
 * IronCurtain keeps its own license. The runner lives here until the fork
 * ships these changes; the UTCP client is still used for everything else
 * (tool discovery, TypeScript interfaces, tool calls).
 *
 * Changes from the upstream version:
 *   1. Console output is counted on the host, in the bridge callbacks the
 *      isolate calls, against a byte and an entry limit. An in-isolate
 *      wrapper would not do: the script could call the raw bridges directly.
 *      Past either limit the chain ends at once with "console output limit
 *      exceeded" and the isolate is disposed. Dropping the messages instead
 *      would let a spinning script keep the host thread copying data until
 *      the timeout. The strings isolated-vm copies out of the isolate are
 *      host external memory, outside both the isolate's `memoryLimit` and
 *      the V8 heap limit, so this is the only bound on them.
 *   1a. The script can reach no `ivm.Reference`. A Reference offers
 *      non-blocking `apply`/`applyIgnored` beside `applySync`: each call
 *      copies its arguments into host memory and returns at once, so a
 *      script looping over one queues copies faster than the host can count
 *      and refuse them (gigabytes before the dispose lands; an in-flight cap
 *      checked by the host comes too late as well). The console and result
 *      bridges are therefore synchronous `ivm.Callback`s -- plain functions
 *      in the isolate whose every call blocks until the host has handled
 *      it -- and the one Reference the tool bridge needs
 *      (`applySyncPromise`) is captured in a setup closure whose global is
 *      deleted before the script runs (see {@link installBridgeScript}).
 *   2. `signal` cancels the chain like a timeout: the isolate is disposed
 *      and pending tool calls are released.
 *   3. Every bridged tool call receives an AbortSignal that aborts when the
 *      chain ends for any reason, so the caller can withdraw work nobody
 *      waits for any more (the coordinator withdraws a pending escalation
 *      and never dispatches a call whose script is gone).
 *   4. In-flight tool calls per chain are bounded, abandoned calls are
 *      tracked per call rather than per tool name, tool arguments must be a
 *      JSON object, and nothing reaches the returned logs after the chain
 *      ended.
 *   5. The memory limit and the timeout are required, the error text of a
 *      failed chain is length-bounded, and diagnostics go to the session log.
 *      The HTTP `error.response.data` detail of tool errors is dropped (the
 *      IronCurtain protocol never sets it).
 *   6. Bridged tool calls run in the asynchronous context of the code that
 *      started the chain. isolated-vm calls the host back with no async
 *      context, so without this the coordinator's work for a tool call (its
 *      policy and auto-approve log lines among it) lost the session's
 *      AsyncLocalStorage state, such as the logger claim the session's turn
 *      is bound to.
 */

import { AsyncResource } from 'node:async_hooks';
import { boundedToolArgumentsJson } from '../trusted-process/argument-budget.js';
import ivm from 'isolated-vm';
import type { Tool } from '@utcp/sdk';
import * as logger from '../logger.js';

/** Text a chain stopped by its console limit reports (`[ERROR] Code execution failed: ...`). */
export const CONSOLE_LIMIT_EXCEEDED = 'console output limit exceeded';

/**
 * Tool calls one script may have in flight at once. The bridged tool stubs
 * block, and the script cannot reach the bridge Reference itself to call it
 * without blocking (change 1a), so a script never has more than one; the cap
 * is defence in depth, since each pending call holds host memory.
 */
const MAX_PENDING_TOOL_CALLS = 4;

/** Longest error text a failed chain reports (a thrown error's stack can be arbitrarily long). */
const MAX_ERROR_TEXT_CHARS = 8_192;

/** The isolate's global object, as the host sees it. */
type Jail = ivm.Context['global'];

/** The parts of the UTCP client a chain uses: its tools and their TypeScript interfaces. */
export interface ToolChainHost {
  getTools(): Promise<Tool[]>;
  getAllToolsTypeScriptInterfaces(): Promise<string>;
  toolToTypeScriptInterface(tool: Tool): string;
}

/**
 * Runs one bridged tool call. `signal` aborts, with an Error saying why, when
 * the chain that made the call ends before the call settled.
 */
export type ChainToolCaller = (
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

/** How one chain runs. */
export interface ToolChainOptions {
  /** Wall-clock limit for the script, in milliseconds. */
  readonly timeoutMs: number;
  /** isolated-vm `memoryLimit` of the chain's isolate, in MB. */
  readonly memoryLimitMb: number;
  /** Console output (UTF-8 bytes) after which the chain is stopped. */
  readonly maxConsoleBytes: number;
  /** Console calls after which the chain is stopped. */
  readonly maxConsoleEntries: number;
  /** Executes the script's tool calls. */
  readonly callTool: ChainToolCaller;
  /** Cancels the chain (isolate disposed, pending tool calls released). */
  readonly signal?: AbortSignal;
}

/**
 * What the script returned and what it logged. A chain that failed (an
 * exception, a timeout, a cancellation, a limit) has `result: null` and an
 * `[ERROR] Code execution failed: ...` entry in `logs`; the runner itself
 * never rejects for those.
 */
export interface ToolChainResult {
  readonly result: unknown;
  readonly logs: string[];
}

/**
 * Runs `code` as the body of an async function in a fresh isolate with the
 * host's tools bridged in as synchronous functions.
 */
export async function runToolChain(
  host: ToolChainHost,
  code: string,
  options: ToolChainOptions,
): Promise<ToolChainResult> {
  const { timeoutMs, memoryLimitMb, callTool, signal } = options;
  const logs: string[] = [];
  if (signal?.aborted) {
    logs.push(failureLine(cancellationText(signal)));
    return { result: null, logs };
  }

  const tools = await host.getTools();
  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  /** Why the chain ended; set by whichever end comes first. */
  let endReason: string | undefined;

  // Aborted when the chain ends, for any reason; every tool call gets it.
  const callsController = new AbortController();

  // Settled (in `finally`) the moment this chain is over -- result, error,
  // timeout or cancellation. Every bridged tool call races against it, and
  // that race is load-bearing for the process's health, not a nicety: the
  // tool bridge blocks the isolate's OS thread in `applySyncPromise` until
  // the host-side promise settles, and a tool call that never settles (a
  // hung HTTP request, an MCP server that stopped answering) would pin that
  // thread FOREVER. `dispose()` cannot reclaim it -- termination is
  // delivered via a V8 interrupt, which only fires when JS execution
  // resumes, and a thread parked in `applySyncPromise` never resumes on its
  // own. The race guarantees every bridged call settles by end-of-chain, so
  // the thread always unparks and the terminate interrupt can land.
  const pendingToolCalls = new Map<number, string>();
  let nextCallId = 0;
  let releaseChain = (): void => {};
  const chainDone = new Promise<never>((_, reject) => {
    releaseChain = () => {
      // Logged synchronously, before the rejection fans out, so the entries
      // are in `logs` by the time the caller sees the chain's result --
      // `Promise.race` never cancels its losers, so this map (not the race
      // arms) is what knows which calls were genuinely still in flight.
      for (const toolName of pendingToolCalls.values()) {
        logs.push(`[WARN] Tool call "${toolName}" abandoned: the chain ended before it settled`);
      }
      pendingToolCalls.clear();
      callsController.abort(
        new Error(`${endReason ?? 'the execute_code script ended'} before this tool call completed`),
      );
      reject(new Error('tool chain ended'));
    };
  });
  chainDone.catch(() => {}); // settled in finally on every path; never unhandled

  const boundedCallTool = (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    if (callsController.signal.aborted || signal?.aborted === true) {
      return Promise.reject(new Error(`Tool call "${toolName}" refused: the chain has ended`));
    }
    if (pendingToolCalls.size >= MAX_PENDING_TOOL_CALLS) {
      return Promise.reject(
        new Error(
          `Tool call "${toolName}" refused: ${MAX_PENDING_TOOL_CALLS} tool calls of this script are already in flight`,
        ),
      );
    }
    const id = nextCallId++;
    pendingToolCalls.set(id, toolName);
    const real = (async () => callTool(toolName, args, callsController.signal))().finally(() => {
      pendingToolCalls.delete(id);
    });
    // A late settlement after the chain ended must not surface as an
    // unhandled rejection -- the race below has already moved on.
    real.catch(() => {});
    return Promise.race([
      real,
      chainDone.catch(() => {
        throw new Error(`Tool call "${toolName}" abandoned: the chain ended before it settled`);
      }),
    ]);
  };

  // The result callbacks exist before any setup step, so a cancellation or
  // a console limit can end the chain at any point.
  let resolveResult: (json: string) => void = () => {};
  let rejectResult: (err: Error) => void = () => {};
  const resultPromise = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Swallow late rejections of the loser promise to avoid PromiseRejectionHandledWarning.
  resultPromise.catch(() => {});

  const consoleSink = new ConsoleSink(logs, options.maxConsoleBytes, options.maxConsoleEntries, (limitError) => {
    endReason ??= `the execute_code script was stopped (${CONSOLE_LIMIT_EXCEEDED})`;
    rejectResult(limitError);
  });

  const onAbort = (): void => {
    endReason ??= `the execute_code call was cancelled (${abortReasonText(signal)})`;
    rejectResult(new Error(cancellationText(signal)));
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const context = await isolate.createContext();
    const jail = context.global;

    // Set up the jail with a reference to itself
    await jail.set('global', jail.derefInto());

    await setupConsoleBridge(isolate, context, jail, consoleSink);
    await setupToolBridges(isolate, context, jail, tools, boundedCallTool);
    await setupUtilities(host, isolate, context, jail, tools);

    // User code runs as the body of an async function so `return` and
    // top-level `await` work naturally. isolated-vm's `script.run()` does not
    // propagate the Promise from an async script, so the resolved value comes
    // back through a callback once the inner async function settles. The
    // callbacks are synchronous `ivm.Callback`s, not References: the script
    // can call them too, but only ever one blocking call at a time (see
    // change 1a in the header).
    await jail.set(
      '__resolveResult',
      new ivm.Callback((json: unknown) => {
        resolveResult(String(json));
      }),
    );
    await jail.set(
      '__rejectResult',
      new ivm.Callback((errorText: unknown) => {
        rejectResult(new Error(String(errorText)));
      }),
    );

    const wrappedCode = `
      (async function() {
        try {
          const __result = await (async function() {
            ${code}
          })();
          __resolveResult(JSON.stringify({ __result: __result === undefined ? null : __result }));
        } catch (e) {
          __rejectResult(String(e && e.stack ? e.stack : e));
        }
      })()
    `;

    // Set up the host-side timeout race BEFORE running the script so the
    // resultPromise always has a handler attached -- otherwise an early
    // rejection from inside the isolate can race the await below and surface
    // as an unhandled rejection.
    const timeoutPromise = new Promise<string>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        endReason ??= `the execute_code script timed out after ${timeoutMs}ms`;
        reject(new Error(`Script execution timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const settledPromise = Promise.race([resultPromise, timeoutPromise]);
    timeoutPromise.catch(() => {});

    const script = await isolate.compileScript(wrappedCode);
    // A cancellation that landed during setup ends the chain before any of
    // the script runs.
    if (signal?.aborted) throw new Error(cancellationText(signal));
    // Kick off the async IIFE. `script.run` returns once the synchronous
    // portion of the wrapper completes (i.e. immediately, since the body is
    // async). `script.run` may itself reject if the isolate refuses to surface
    // the returned Promise; treat that as benign as long as the callback
    // fires. The exception is a rejection from an isolate that is already
    // DISPOSED -- isolated-vm kills an isolate that hits its memoryLimit, so
    // the callbacks can never fire and waiting on them would strand the chain
    // until the generic timeout, reporting an out-of-memory as "timed out".
    // Surface the real error instead.
    script.run(context, { timeout: timeoutMs }).catch((runErr: unknown) => {
      if (isolate.isDisposed) {
        rejectResult(runErr instanceof Error ? runErr : new Error(String(runErr)));
      }
    });

    const resultJson = await settledPromise;
    endReason ??= 'the execute_code script finished';
    const parsed: unknown = JSON.parse(resultJson);
    const result = parsed !== null && typeof parsed === 'object' ? (parsed as { __result?: unknown }).__result : null;
    return { result: result ?? null, logs };
  } catch (error) {
    endReason ??= 'the execute_code script failed';
    // Push into the live array rather than returning a copy: `finally` runs
    // AFTER this return value is built, and the abandoned-call warnings it
    // writes (see `releaseChain`) must reach the caller too.
    logs.push(failureLine(error instanceof Error ? error.message : String(error)));
    return { result: null, logs };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    // Console calls the isolate makes before the dispose lands are dropped.
    consoleSink.close();
    // Unblock any tool call still parked in `applySyncPromise` BEFORE
    // disposing, so the isolate's thread can resume and take the terminate
    // interrupt (see `chainDone` above).
    releaseChain();
    disposeIsolateSafely(isolate);
  }
}

/** `[ERROR] Code execution failed: <text>`, with the text length-bounded. */
function failureLine(text: string): string {
  const bounded =
    text.length > MAX_ERROR_TEXT_CHARS
      ? `${text.slice(0, MAX_ERROR_TEXT_CHARS)} [... ${text.length - MAX_ERROR_TEXT_CHARS} more characters]`
      : text;
  return `[ERROR] Code execution failed: ${bounded}`;
}

/** Why `signal` aborted: its reason's message or text, or a generic phrase. */
function abortReasonText(signal: AbortSignal | undefined): string {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return 'the call was cancelled';
}

/** What a cancelled chain reports. */
function cancellationText(signal: AbortSignal | undefined): string {
  return `Script execution cancelled: ${abortReasonText(signal)}`;
}

/**
 * Host-side console accounting. The isolate's console functions call the
 * bridge References with already-stringified arguments; this counts what
 * arrives and stops the chain (through `onLimit`) the first time a call
 * would take the output past either limit. Nothing is stored after that, or
 * after `close()`.
 */
class ConsoleSink {
  private bytes = 0;
  private entries = 0;
  private closed = false;

  constructor(
    private readonly logs: string[],
    private readonly maxBytes: number,
    private readonly maxEntries: number,
    private readonly onLimit: (limitError: Error) => void,
  ) {}

  write(prefix: string, args: readonly unknown[]): void {
    if (this.closed) return;
    const parts = args.map((arg) => (typeof arg === 'string' ? arg : String(arg)));
    const remaining = this.maxBytes - this.bytes;
    // A UTF-8 encoding is never shorter than the UTF-16 length, so an
    // oversized message is refused without scanning (or joining) it.
    let length = prefix.length + (prefix ? 1 : 0) + Math.max(0, parts.length - 1);
    for (const part of parts) length += part.length;
    if (this.entries >= this.maxEntries || length > remaining) {
      this.exceeded();
      return;
    }
    const message = parts.join(' ');
    const line = prefix ? `${prefix} ${message}` : message;
    const size = Buffer.byteLength(line, 'utf8');
    if (size > remaining) {
      this.exceeded();
      return;
    }
    this.bytes += size;
    this.entries += 1;
    this.logs.push(line);
  }

  close(): void {
    this.closed = true;
  }

  private exceeded(): void {
    this.closed = true;
    this.onLimit(
      new Error(
        `${CONSOLE_LIMIT_EXCEEDED}: the script wrote more than ${this.maxBytes} bytes or ${this.maxEntries} ` +
          'lines of console output and was stopped. Log less, or return a summary instead.',
      ),
    );
  }
}

/**
 * Dispose an isolate without ever letting disposal failures replace the
 * chain's result, and without trusting a single attempt.
 *
 * A bare `isolate.dispose()` in a `finally` has two failure modes. An
 * isolate that blew its `memoryLimit` was already disposed by isolated-vm
 * itself, so the second dispose throws "Isolate is already disposed" -- and
 * an exception thrown from a `finally` REPLACES the function's return value,
 * turning an orderly out-of-memory result into an opaque rejection. And
 * disposal of a busy isolate is delivered as a terminate request rather than
 * being instantaneous, with upstream reports
 * (https://github.com/laverdet/isolated-vm/issues/198) of isolates whose GC
 * threads out-live it; those leak an OS thread each, which is invisible in
 * memory metrics and only surfaces when the process exhausts a pid limit.
 *
 * So: guard on `isDisposed`, swallow (but log) a throwing dispose, and
 * re-check on a few unref'd timers so a slow teardown gets retried and a
 * genuinely stuck isolate is at least reported instead of silent.
 */
function disposeIsolateSafely(isolate: ivm.Isolate): void {
  const tryDispose = (): void => {
    try {
      if (!isolate.isDisposed) isolate.dispose();
    } catch (err) {
      logger.warn(`[code-mode] isolate dispose attempt failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  tryDispose();
  if (isolate.isDisposed) return;
  let attempts = 0;
  const retry = (): void => {
    attempts += 1;
    tryDispose();
    if (!isolate.isDisposed && attempts < 5) {
      setTimeout(retry, 200 * attempts).unref();
    } else if (!isolate.isDisposed) {
      logger.error('[code-mode] isolate could not be disposed after retries -- its thread and heap are likely leaked');
    }
  };
  setTimeout(retry, 100).unref();
}

/**
 * Sanitizes an identifier to be a valid TypeScript identifier: any character
 * other than a letter, digit or underscore becomes an underscore, and a
 * leading digit is prefixed with one.
 */
function sanitizeIdentifier(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');
}

/**
 * In-isolate source of `take(name)`: returns the bridge the host installed as
 * `global[name]` and deletes that global, throwing -- which fails the chain
 * -- unless the bridge was there and the delete took.
 */
const TAKE_BRIDGE_SOURCE = `
  const take = (name) => {
    const bridge = global[name];
    delete global[name];
    if (bridge === undefined || Object.prototype.hasOwnProperty.call(global, name)) {
      throw new Error('Code Mode bridge setup failed: ' + name);
    }
    return bridge;
  };`;

/**
 * Runs `body` as a strict-mode setup function before any user code. The host
 * installs each bridge as a temporary global; `body` captures it with `take`
 * (see {@link TAKE_BRIDGE_SOURCE}), which deletes the global, so the script
 * finds none of them and never holds an `ivm.Reference` (change 1a in the
 * header). Everything `body` declares stays in the function's scope.
 */
async function installBridgeScript(isolate: ivm.Isolate, context: ivm.Context, body: string): Promise<void> {
  const script = await isolate.compileScript(`(function () {\n'use strict';\n${TAKE_BRIDGE_SOURCE}\n${body}\n})();`);
  await script.run(context);
}

/**
 * Sets up console bridge functions in the isolated context. Console calls in
 * the isolate are forwarded to `sink` in the host process, through one
 * synchronous `ivm.Callback` per method: a plain function in the isolate
 * whose every call blocks until `sink` has counted the message, so a script
 * can never have more than one message in flight.
 */
async function setupConsoleBridge(
  isolate: ivm.Isolate,
  context: ivm.Context,
  jail: Jail,
  sink: ConsoleSink,
): Promise<void> {
  const createLogHandler = (prefix: string): ivm.Callback<(...args: unknown[]) => void> =>
    new ivm.Callback((...args: unknown[]) => {
      sink.write(prefix, args);
    });

  await jail.set('__consoleLog', createLogHandler(''));
  await jail.set('__consoleError', createLogHandler('[ERROR]'));
  await jail.set('__consoleWarn', createLogHandler('[WARN]'));
  await jail.set('__consoleInfo', createLogHandler('[INFO]'));

  await installBridgeScript(
    isolate,
    context,
    `
    const log = take('__consoleLog');
    const error = take('__consoleError');
    const warn = take('__consoleWarn');
    const info = take('__consoleInfo');
    const stringify = (a) => (typeof a === 'object' && a !== null ? JSON.stringify(a, null, 2) : String(a));
    global.console = {
      log: (...args) => { log(...args.map(stringify)); },
      error: (...args) => { error(...args.map(stringify)); },
      warn: (...args) => { warn(...args.map(stringify)); },
      info: (...args) => { info(...args.map(stringify)); },
    };`,
  );
}

/**
 * Sets up tool bridge functions in the isolated context. Tool calls in the
 * isolate are forwarded to `callTool` in the host process. The in-isolate
 * stubs block their OS thread in `applySyncPromise` until the call settles,
 * so `callTool` must be guaranteed to settle by end-of-chain (see `chainDone`
 * in {@link runToolChain}).
 *
 * `applySyncPromise` exists only on an `ivm.Reference`, so this bridge is
 * one; its global is deleted in setup and the stubs call a bound copy of the
 * method (see {@link installBridgeScript}). The stubs only ever pass JSON
 * text, so the native call never throws a transfer error into the script,
 * and anything it does throw is replaced by an error raised in the stub.
 *
 * The bridge is bound to the async context it is created in, the chain
 * caller's (change 6): isolated-vm invokes it with none.
 */
async function setupToolBridges(
  isolate: ivm.Isolate,
  context: ivm.Context,
  jail: Jail,
  tools: readonly Tool[],
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const bridgeCall = AsyncResource.bind(async (toolName: unknown, argsJson: unknown): Promise<string> => {
    try {
      const args: unknown = JSON.parse(boundedToolArgumentsJson(argsJson));
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('Tool arguments must be a JSON object');
      }
      const result = await callTool(String(toolName), args as Record<string, unknown>);
      return JSON.stringify({ success: true, result });
    } catch (error) {
      return JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  const toolCallerRef = new ivm.Reference(bridgeCall);

  await jail.set('__callToolBridge', toolCallerRef);

  const toolSetupParts: string[] = [
    `const bridge = take('__callToolBridge');`,
    // Bound now, while the prototype is untouched; the stubs never look the method up again.
    `const callBridge = bridge.applySyncPromise.bind(bridge);`,
    `const invoke = (toolName, args) => {
      const argsJson = JSON.stringify(args || {});
      if (typeof argsJson !== 'string') throw new TypeError('Tool arguments must be a JSON object');
      let resultJson;
      try {
        // Blocks until the async tool call completes in the main process.
        resultJson = callBridge(undefined, [toolName, argsJson]);
      } catch (bridgeError) {
        const why = bridgeError && typeof bridgeError.message === 'string' ? bridgeError.message : 'unknown error';
        throw new Error('Tool call "' + toolName + '" failed in the tool bridge: ' + why);
      }
      const parsed = JSON.parse(resultJson);
      if (!parsed.success) throw new Error(parsed.error);
      return parsed.result;
    };`,
  ];
  const namespaces = new Set<string>();

  for (const tool of tools) {
    const toolNameJson = JSON.stringify(tool.name);
    if (tool.name.includes('.')) {
      const [manualName, ...toolParts] = tool.name.split('.');
      const sanitizedManualName = sanitizeIdentifier(manualName);
      const toolFnName = toolParts.map((part) => sanitizeIdentifier(part)).join('_');

      if (!namespaces.has(sanitizedManualName)) {
        namespaces.add(sanitizedManualName);
        toolSetupParts.push(`global.${sanitizedManualName} = global.${sanitizedManualName} || {};`);
      }

      toolSetupParts.push(
        `global.${sanitizedManualName}.${toolFnName} = function (args) { return invoke(${toolNameJson}, args); };`,
      );
    } else {
      const sanitizedToolName = sanitizeIdentifier(tool.name);
      toolSetupParts.push(`global.${sanitizedToolName} = function (args) { return invoke(${toolNameJson}, args); };`);
    }
  }

  await installBridgeScript(isolate, context, toolSetupParts.join('\n'));
}

/** Sets up utility functions and interfaces in the isolated context. */
async function setupUtilities(
  host: ToolChainHost,
  isolate: ivm.Isolate,
  context: ivm.Context,
  jail: Jail,
  tools: readonly Tool[],
): Promise<void> {
  // Add TypeScript interface definitions
  const interfaces = await host.getAllToolsTypeScriptInterfaces();
  await jail.set('__interfaces', interfaces);

  // Create interface lookup map
  const interfaceMap: Record<string, string> = {};
  for (const tool of tools) {
    interfaceMap[tool.name] = host.toolToTypeScriptInterface(tool);
  }
  await jail.set('__interfaceMapJson', JSON.stringify(interfaceMap));

  const utilSetupScript = await isolate.compileScript(`
    global.__getToolInterface = (toolName) => {
      const map = JSON.parse(__interfaceMapJson);
      return map[toolName] || null;
    };
  `);
  await utilSetupScript.run(context);
}
