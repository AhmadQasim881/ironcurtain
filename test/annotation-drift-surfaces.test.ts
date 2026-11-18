/**
 * Where a session shows annotation drift (WP-27). The coordinator only logs
 * it; sessions emit an `annotation_drift` diagnostic while they initialize,
 * which is before a transport is running or a web session has a label:
 *
 *  - the CLI transport keeps it and prints it once the session runs, after
 *    the start-up spinner, and lists it under /logs;
 *  - the web transport holds it until the dispatcher has assigned the label
 *    and announced the session, then emits `session.diagnostic`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationDriftDiagnostic } from '../src/session/annotation-drift-diagnostics.js';
import type { SessionManager } from '../src/session/session-manager.js';
import type { BudgetStatus, ConversationTurn, DiagnosticEvent, Session, SessionInfo } from '../src/session/types.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import { WebSessionTransport } from '../src/web-ui/web-session-transport.js';

const DRIFT: AnnotationDriftDiagnostic = {
  kind: 'annotation_drift',
  serverName: 'git',
  message:
    'tool annotations for MCP server "git" do not match its live tools (1 tool(s) changed: git_clone (unannotated: path)); calls using the changes are denied or evaluated under default roles',
  hint: 'Run `ironcurtain annotate-tools --server git`, review the result and recompile the policy.',
};

function mockSession(overrides: Partial<Session> = {}): Session {
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
    getInfo: () => ({ id: 'wp27-session', status: 'ready', turnCount: 0, createdAt: '' }) as unknown as SessionInfo,
    sendMessage: vi.fn().mockResolvedValue('done'),
    getHistory: () => [] as readonly ConversationTurn[],
    getDiagnosticLog: () => [DRIFT] as readonly DiagnosticEvent[],
    resolveEscalation: vi.fn().mockResolvedValue(undefined),
    getPendingEscalations: () => [],
    getBudgetStatus: () => budget,
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ic-drift-surfaces-'));
  vi.stubEnv('IRONCURTAIN_HOME', home);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('CLI transport', () => {
  it('prints drift found during initialization once the session runs, before the response', async () => {
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
    // Emitted while the session initializes: nothing is printed yet.
    onDiagnostic(DRIFT);
    expect(writes.join('')).not.toContain('[annotations]');

    await transport.run(mockSession());

    const output = writes.join('');
    const notice = output.indexOf('[annotations] Warning: tool annotations for MCP server "git"');
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(output.indexOf('Run `ironcurtain annotate-tools --server git`')).toBeGreaterThan(notice);
    expect(output.indexOf('[stdout]')).toBeGreaterThan(notice);
    expect(output.split('[annotations]')).toHaveLength(2);
  });
});

describe('web transport', () => {
  function webTransport() {
    const bus = new WebEventBus();
    const events: Array<{ event: string; payload: unknown }> = [];
    bus.subscribe((event, payload) => events.push({ event, payload }));
    const transport = new WebSessionTransport({ eventBus: bus, sessionManager: {} as SessionManager });
    return { transport, events };
  }

  it('holds drift emitted before the session has a label and emits it once the session runs', async () => {
    const { transport, events } = webTransport();
    transport.createDiagnosticHandler()(DRIFT);
    expect(events).toEqual([]);

    transport.sessionLabel = 4;
    const run = transport.run(mockSession());
    // Not synchronously: the dispatcher announces the session first.
    expect(events).toEqual([]);
    await Promise.resolve();
    expect(events).toEqual([{ event: 'session.diagnostic', payload: { label: 4, event: DRIFT } }]);

    // Later drift diagnostics go out at once.
    transport.createDiagnosticHandler()({ ...DRIFT, serverName: 'github' });
    expect(events).toHaveLength(2);

    transport.close();
    await run;
    expect(events.filter((e) => e.event === 'session.diagnostic')).toHaveLength(2);
  });
});
