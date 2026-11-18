/**
 * Start-up notices beyond annotation drift: MCP servers a session could not
 * start (`mcp_server_unavailable`) and host-model features running
 * differently for lack of credentials (`host_model_fallback`). Both reach
 * the same surfaces as drift (see annotation-drift-surfaces.test.ts). Also
 * the bounded in-memory logs sessions keep.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BoundedLog } from '../src/session/bounded-log.js';
import {
  formatSessionNotice,
  formatStartupNotice,
  hostModelDiagnostics,
  isSessionNotice,
  isStartupNotice,
  MAX_POLICY_WARNING_CHARS,
  policyWarningDiagnostics,
  unavailableServerDiagnostics,
  type HostPrivilegedFilesDiagnostic,
  type StartupNotice,
} from '../src/session/startup-notices.js';
import type { SessionManager } from '../src/session/session-manager.js';
import type { BudgetStatus, ConversationTurn, DiagnosticEvent, Session, SessionInfo } from '../src/session/types.js';
import { formatSessionNoticesMessage } from '../src/signal/format.js';
import type { SignalBotDaemon } from '../src/signal/signal-bot-daemon.js';
import { SignalSessionTransport } from '../src/signal/signal-transport.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import { WebSessionTransport } from '../src/web-ui/web-session-transport.js';

const UNAVAILABLE: StartupNotice = {
  kind: 'mcp_server_unavailable',
  serverName: 'github',
  reason: 'MCP error -32000: Connection closed',
};

const FALLBACK: StartupNotice = {
  kind: 'host_model_fallback',
  role: 'summary',
  action: 'agent_model',
  message: 'Auto-compaction\'s summary model "anthropic:claude-haiku-4-5" has no credentials',
};

/** The text `checkPolicyProvenance` reports for a policy compiled before provenance was recorded. */
const STALE_POLICY_REPORT =
  'Warning: the compiled policy at /home/user/.ironcurtain/generated/compiled-policy.json may be stale:\n' +
  '  - it records no provenance: it was compiled by an IronCurtain version from before compiled policies recorded how they were built\n' +
  '  Run `ironcurtain compile-policy` to rebuild it. To refuse stale policies instead of using them, set "policy": { "onStale": "refuse" } in /home/user/.ironcurtain/config.json.\n';

const [STALE_POLICY] = policyWarningDiagnostics([STALE_POLICY_REPORT]);

const HOST_FILES: HostPrivilegedFilesDiagnostic = {
  kind: 'host_privileged_files',
  when: 'after agent turn',
  stripped: 0,
  unstripped: 1,
  rootOwned: 2,
  unlisted: 0,
  paths: ['/home/user/project/bin/shell', '/home/user/project/build'],
  incomplete: false,
  hint: 'Inspect the files IronCurtain could not neutralize and remove them as root (for example with sudo rm).',
};

function mockSession(): Session {
  const budget = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    stepCount: 0,
    elapsedSeconds: 0,
    estimatedCostUsd: 0,
    limits: { maxTotalTokens: null, maxSteps: null, maxSessionSeconds: null, maxEstimatedCostUsd: null },
    cumulative: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
      activeSeconds: 0,
      estimatedCostUsd: 0,
    },
    tokenTrackingAvailable: false,
  } as unknown as BudgetStatus;
  return {
    getInfo: () => ({ id: 'wp85-session', status: 'ready', turnCount: 0, createdAt: '' }) as unknown as SessionInfo,
    sendMessage: vi.fn().mockResolvedValue('done'),
    getHistory: () => [] as readonly ConversationTurn[],
    getDiagnosticLog: () => [] as readonly DiagnosticEvent[],
    resolveEscalation: vi.fn().mockResolvedValue(undefined),
    getPendingEscalations: () => [],
    getBudgetStatus: () => budget,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ic-startup-notices-'));
  vi.stubEnv('IRONCURTAIN_HOME', home);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('start-up notice helpers', () => {
  it('builds the diagnostics from the sandbox and the host-model plan', () => {
    expect(unavailableServerDiagnostics([{ serverName: 'github', reason: 'boom' }])).toEqual([
      { kind: 'mcp_server_unavailable', serverName: 'github', reason: 'boom' },
    ]);
    expect(hostModelDiagnostics([{ role: 'memory', action: 'degraded', message: 'm' }])).toEqual([
      { kind: 'host_model_fallback', role: 'memory', action: 'degraded', message: 'm' },
    ]);
    expect(isStartupNotice(UNAVAILABLE)).toBe(true);
    expect(isStartupNotice(FALLBACK)).toBe(true);
    expect(isStartupNotice({ kind: 'agent_text', preview: 'x' })).toBe(false);
  });

  it('renders server-provided text as one display-safe line', () => {
    const esc = String.fromCharCode(0x1b);
    const line = formatStartupNotice({
      kind: 'mcp_server_unavailable',
      serverName: `evil${esc}[2J`,
      reason: `failed\nforged: all good${esc}[31m`,
    });
    expect(line).not.toContain(esc);
    expect(line).not.toContain('\n');
    expect(line).toContain('[mcp] Warning: MCP server "evil\\u001b[2J" is unavailable');
    expect(formatStartupNotice(FALLBACK)).toBe(`  [models] Warning: ${FALLBACK.message}`);
  });

  it('carries a stale-policy warning as a start-up notice: display text, line feeds kept, bounded', () => {
    expect(STALE_POLICY).toEqual({ kind: 'policy_stale', message: STALE_POLICY_REPORT.trimEnd() });
    expect(isStartupNotice(STALE_POLICY)).toBe(true);
    expect(isSessionNotice(STALE_POLICY)).toBe(true);

    const esc = String.fromCharCode(0x1b);
    const [hostile] = policyWarningDiagnostics([
      `Warning: the compiled policy at /tmp/x${esc}]52;c;AAAA\u0007 may be stale:\n`,
    ]);
    expect(hostile.message).not.toContain(esc);
    expect(hostile.message).toContain('\\u001b]52');

    const [long] = policyWarningDiagnostics([`Warning: ${'x'.repeat(MAX_POLICY_WARNING_CHARS * 2)}`]);
    expect(long.message.length).toBeLessThanOrEqual(MAX_POLICY_WARNING_CHARS);
    expect(long.message).toMatch(/\.\.\.\[\+\d+ chars\]$/u);
  });

  it('renders a stale-policy notice with its reasons indented under it', () => {
    expect(formatStartupNotice(STALE_POLICY).split('\n')).toEqual([
      '  [policy] Warning: the compiled policy at /home/user/.ironcurtain/generated/compiled-policy.json may be stale:',
      expect.stringMatching(/^ {4}- it records no provenance/u) as unknown,
      expect.stringMatching(/^ {4}Run `ironcurtain compile-policy` to rebuild it\./u) as unknown,
    ]);
  });

  it('renders host-mount findings with the counts, the first paths and what to do, as display text', () => {
    expect(isStartupNotice(HOST_FILES)).toBe(false);
    expect(isSessionNotice(HOST_FILES)).toBe(true);
    const lines = formatSessionNotice(HOST_FILES).split('\n');
    expect(lines[0]).toBe(
      "  [host-files] Warning (after agent turn): IronCurtain found setuid/setgid or root-owned files in the agent container's host mounts: " +
        '1 setuid/setgid file it could not neutralize, 2 root-owned entries.',
    );
    expect(lines.slice(1)).toEqual([
      '    /home/user/project/bin/shell',
      '    /home/user/project/build',
      `    ${HOST_FILES.hint}`,
    ]);

    // An agent chooses the file names.
    const esc = String.fromCharCode(0x1b);
    const planted = formatSessionNotice({ ...HOST_FILES, paths: [`/w/evil\n[#1] approved${esc}[2J`] });
    expect(planted).not.toContain(esc);
    expect(planted).toContain('/w/evil\\n[#1] approved\\u001b[2J');
    expect(planted.split('\n')).toHaveLength(3);
  });

  it('renders a host-model message (model IDs a workflow may supply) as display-safe text', () => {
    // A loose model ID (a workflow state's `model:`) may be any text; the
    // notice names it, so terminal controls in it must not reach the terminal.
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const line = formatStartupNotice({
      kind: 'host_model_fallback',
      role: 'summary',
      action: 'disabled',
      message: `Auto-compaction is off: neither does the agent model "x${esc}]52;c;AAAA${bel}y"`,
    });
    expect(line).not.toContain(esc);
    expect(line).not.toContain(bel);
    expect(line).toContain(
      '[models] Warning: Auto-compaction is off: neither does the agent model "x\\u001b]52;c;AAAA',
    );
  });
});

describe('CLI transport', () => {
  it('prints the notices emitted during initialization once the session runs, before the response', async () => {
    const { CliTransport } = await import('../src/session/cli-transport.js');
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(`[stdout]${String(chunk)}`);
      return true;
    });

    const transport = new CliTransport({ initialMessage: 'task', input: new PassThrough() });
    const onDiagnostic = transport.createDiagnosticHandler();
    onDiagnostic(FALLBACK);
    onDiagnostic(UNAVAILABLE);
    expect(writes.join('')).toBe('');

    await transport.run(mockSession());

    const output = writes.join('');
    const fallback = output.indexOf('[models] Warning: Auto-compaction');
    const unavailable = output.indexOf('[mcp] Warning: MCP server "github" is unavailable');
    expect(fallback).toBeGreaterThanOrEqual(0);
    expect(unavailable).toBeGreaterThan(fallback);
    expect(output.indexOf('[stdout]')).toBeGreaterThan(unavailable);
  });

  it('prints a stale-policy notice emitted during initialization after it, with the other start-up notices', async () => {
    const { CliTransport } = await import('../src/session/cli-transport.js');
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const transport = new CliTransport({ initialMessage: 'task', input: new PassThrough() });
    transport.createDiagnosticHandler()(STALE_POLICY);
    // Held while the caller's initialization spinner runs.
    expect(writes.join('')).toBe('');

    await transport.run(mockSession());

    const output = writes.join('');
    expect(output).toContain('[policy] Warning: the compiled policy at /home/user/.ironcurtain/generated');
    expect(output).toContain('    - it records no provenance');
  });

  it('prints host-mount findings on stderr when they arrive, and an empty scan prints nothing', async () => {
    const { CliTransport } = await import('../src/session/cli-transport.js');
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    const transport = new CliTransport({ initialMessage: 'task', input: new PassThrough() });
    const onDiagnostic = transport.createDiagnosticHandler();
    onDiagnostic({ kind: 'step_finish', stepIndex: 1 });
    expect(writes.join('')).toBe('');

    onDiagnostic(HOST_FILES);

    const output = writes.join('');
    expect(output).toContain(
      "[host-files] Warning (after agent turn): IronCurtain found setuid/setgid or root-owned files in the agent container's host mounts",
    );
    expect(output).toContain('/home/user/project/bin/shell');
    expect(output).toContain('sudo rm');
  });
});

describe('Signal transport', () => {
  function fakeDaemon(): { daemon: SignalBotDaemon; sent: Array<{ text: string; textMode?: string }> } {
    const sent: Array<{ text: string; textMode?: string }> = [];
    const daemon = {
      sendSignalMessage: vi.fn(async (text: string, options?: { textMode?: string }) => {
        sent.push({ text, textMode: options?.textMode });
      }),
    } as unknown as SignalBotDaemon;
    return { daemon, sent };
  }

  it('holds the start-up notices for the daemon to send once, and sends later ones as they come', () => {
    const { daemon, sent } = fakeDaemon();
    const transport = new SignalSessionTransport({ daemon });
    const onDiagnostic = transport.createDiagnosticHandler();

    onDiagnostic(STALE_POLICY);
    onDiagnostic(UNAVAILABLE);
    expect(sent).toEqual([]);

    transport.sessionLabel = 4;
    expect(transport.takeStartupNotices()).toEqual([STALE_POLICY, UNAVAILABLE]);
    expect(transport.takeStartupNotices()).toEqual([]);

    onDiagnostic(FALLBACK);
    expect(sent).toEqual([{ text: formatSessionNoticesMessage(4, [FALLBACK]), textMode: 'normal' }]);
  });

  it('sends host-mount findings in plain text, labelled with the session', () => {
    const { daemon, sent } = fakeDaemon();
    const transport = new SignalSessionTransport({ daemon });
    transport.sessionLabel = 2;
    transport.takeStartupNotices();

    transport.createDiagnosticHandler()(HOST_FILES);

    expect(sent).toHaveLength(1);
    expect(sent[0].textMode).toBe('normal');
    expect(sent[0].text.split('\n')).toEqual([
      '[#2] Session notice:',
      "[host-files] Warning (after agent turn): IronCurtain found setuid/setgid or root-owned files in the agent container's host mounts: " +
        '1 setuid/setgid file it could not neutralize, 2 root-owned entries.',
      '  /home/user/project/bin/shell',
      '  /home/user/project/build',
      `  ${HOST_FILES.hint}`,
    ]);
  });
});

describe('web transport', () => {
  it('holds the notices until the session has a label', async () => {
    const bus = new WebEventBus();
    const events: Array<{ event: string; payload: unknown }> = [];
    bus.subscribe((event, payload) => events.push({ event, payload }));
    const transport = new WebSessionTransport({ eventBus: bus, sessionManager: {} as SessionManager });

    transport.createDiagnosticHandler()(UNAVAILABLE);
    transport.createDiagnosticHandler()(FALLBACK);
    expect(events).toEqual([]);

    transport.sessionLabel = 7;
    const run = transport.run(mockSession());
    await Promise.resolve();
    expect(events).toEqual([
      { event: 'session.diagnostic', payload: { label: 7, event: UNAVAILABLE } },
      { event: 'session.diagnostic', payload: { label: 7, event: FALLBACK } },
    ]);
    transport.close();
    await run;
  });

  it('forwards a stale-policy notice and host-mount findings to the browser', async () => {
    const bus = new WebEventBus();
    const events: Array<{ event: string; payload: unknown }> = [];
    bus.subscribe((event, payload) => events.push({ event, payload }));
    const transport = new WebSessionTransport({ eventBus: bus, sessionManager: {} as SessionManager });
    const onDiagnostic = transport.createDiagnosticHandler();

    onDiagnostic(STALE_POLICY);
    transport.sessionLabel = 3;
    const run = transport.run(mockSession());
    await Promise.resolve();
    onDiagnostic(HOST_FILES);

    expect(events).toEqual([
      { event: 'session.diagnostic', payload: { label: 3, event: STALE_POLICY } },
      { event: 'session.diagnostic', payload: { label: 3, event: HOST_FILES } },
    ]);
    transport.close();
    await run;
  });
});

describe('BoundedLog', () => {
  it('keeps the newest entries and counts every one', () => {
    const log = new BoundedLog<number>(3);
    for (let entry = 1; entry <= 5; entry++) log.push(entry);
    expect(log.items).toEqual([3, 4, 5]);
    expect(log.total).toBe(5);
  });

  it('keeps everything while under capacity', () => {
    const log = new BoundedLog<string>(10);
    log.push('a');
    log.push('b');
    expect(log.items).toEqual(['a', 'b']);
    expect(log.total).toBe(2);
  });

  it('refuses a capacity that is not a positive integer', () => {
    expect(() => new BoundedLog(0)).toThrow(RangeError);
    expect(() => new BoundedLog(1.5)).toThrow(RangeError);
  });
});
