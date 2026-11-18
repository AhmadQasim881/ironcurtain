/**
 * Daemon shutdown drains its workflows (WP-48): `IronCurtainDaemon.shutdown()`
 * aborts every run of its WorkflowManager with the daemon-shutdown reason
 * (terminal checkpoint, `run_terminal` marker, run lock released) while the
 * web UI can still tell its clients, refuses further workflow requests, and a
 * workflow drain that hangs cannot hold the shutdown past its deadline.
 *
 * Drives the real daemon wiring (control socket, web UI server, WorkflowManager)
 * and a real `workflows.start` over the daemon's WebSocket; the workflow starts
 * at a gate, so no session, LLM or Docker is involved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../src/workflow/container-snapshots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/workflow/container-snapshots.js')>()),
  // The daemon's snapshot GC sweep would shell out to the docker CLI.
  sweepContainerSnapshots: vi.fn(async () => ({ removedImages: [], agedImages: [], orphanImages: [] })),
}));

import { IronCurtainDaemon, DAEMON_WORKFLOW_SHUTDOWN_REASON } from '../src/daemon/ironcurtain-daemon.js';
import { WorkflowManager } from '../src/workflow/workflow-manager.js';
import { createDaemonClient, type DaemonClient, type DaemonEvent } from '../src/daemon-client/daemon-client.js';
import { getWorkflowRunLockPath } from '../src/workflow/run-lock.js';
import * as logger from '../src/logger.js';
import type { WorkflowCheckpoint, WorkflowId } from '../src/workflow/types.js';
import type { WorkflowDetailDto } from '../src/web-ui/web-ui-types.js';

interface DaemonInternals {
  startControlSocket(): Promise<void>;
  startWebUiServer(): Promise<void>;
  workflowManager: WorkflowManager | null;
  webUiServer: unknown;
}

const gateFirstDefinition = {
  name: 'daemon-shutdown-gate',
  description: 'Starts at a gate',
  initial: 'approve',
  settings: { mode: 'builtin' },
  states: {
    approve: {
      type: 'human_gate',
      description: 'Approve',
      acceptedEvents: ['APPROVE', 'ABORT'],
      transitions: [
        { to: 'done', event: 'APPROVE' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

describe('IronCurtainDaemon.shutdown and workflows', () => {
  let home: string;
  let savedHome: string | undefined;
  let client: DaemonClient | undefined;
  let daemon: IronCurtainDaemon | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ic-daemon-wf-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(async () => {
    await client?.close().catch(() => {});
    client = undefined;
    await daemon?.shutdown().catch(() => {});
    daemon = undefined;
    vi.restoreAllMocks();
    logger.teardown();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function bootDaemon(options: { workflowShutdownDeadlineMs?: number } = {}): Promise<DaemonInternals> {
    daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true, webUi: { port: 0 }, ...options });
    const internals = daemon as unknown as DaemonInternals;
    await internals.startControlSocket();
    await internals.startWebUiServer();
    return internals;
  }

  it('aborts a run paused at a gate with the daemon reason and a run_terminal marker', async () => {
    const internals = await bootDaemon();
    const manager = internals.workflowManager;
    expect(manager).not.toBeNull();

    const defsDir = join(home, 'defs');
    mkdirSync(defsDir);
    const definitionPath = join(defsDir, 'gate.json');
    writeFileSync(definitionPath, JSON.stringify(gateFirstDefinition));

    client = createDaemonClient();
    await client.connect();
    const events: DaemonEvent[] = [];
    client.onEvent((event) => events.push(event));

    const started = await client.call<{ workflowId: string }>('workflows.start', {
      definitionPath,
      taskDescription: 'wait at the gate',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const workflowId = started.payload.workflowId as WorkflowId;
    const activeClient = client;
    await vi.waitFor(
      async () => {
        const detail = await activeClient.call<WorkflowDetailDto>('workflows.get', { workflowId });
        expect(detail.ok && detail.payload.phase).toBe('waiting_human');
      },
      { timeout: 5000, interval: 20 },
    );
    const runDir = join(home, 'workflow-runs', workflowId);
    expect(existsSync(getWorkflowRunLockPath(join(home, 'workflow-runs'), workflowId))).toBe(true);

    await daemon?.shutdown();

    const checkpoint = JSON.parse(readFileSync(join(runDir, 'checkpoint.json'), 'utf8')) as WorkflowCheckpoint;
    expect(checkpoint.finalStatus).toEqual({ phase: 'aborted', reason: DAEMON_WORKFLOW_SHUTDOWN_REASON });
    // The gate the run was paused at stays the resume point.
    expect(checkpoint.machineState).toBe('approve');
    const log = readFileSync(join(runDir, 'messages.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; phase?: string });
    expect(log.at(-1)).toMatchObject({ type: 'run_terminal', phase: 'aborted' });
    expect(existsSync(getWorkflowRunLockPath(join(home, 'workflow-runs'), workflowId))).toBe(false);

    // Clients heard about it before the web UI went down.
    const failed = events.find((event) => event.event === 'workflow.failed');
    expect(failed?.payload).toMatchObject({ workflowId, phase: 'aborted', error: DAEMON_WORKFLOW_SHUTDOWN_REASON });

    // The stopped manager accepts nothing more and is no longer the daemon's.
    expect(internals.workflowManager).toBeNull();
    expect(() => manager?.getOrchestrator()).toThrow(expect.objectContaining({ code: 'WORKFLOW_MANAGER_CLOSED' }));
  });

  it('does not let a hung workflow drain hold the shutdown past its deadline', async () => {
    const hang = vi.spyOn(WorkflowManager.prototype, 'shutdown').mockReturnValue(new Promise<void>(() => {}));
    const warn = vi.spyOn(logger, 'warn');
    const internals = await bootDaemon({ workflowShutdownDeadlineMs: 50 });

    await daemon?.shutdown();

    expect(hang).toHaveBeenCalledWith({
      reason: DAEMON_WORKFLOW_SHUTDOWN_REASON,
      snapshotBudgetMs: expect.any(Number) as number,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Workflow shutdown did not finish'));
    // The rest of the shutdown still ran.
    expect(internals.webUiServer).toBeNull();
  });

  it('runs the shutdown once: a second call joins the first', async () => {
    await bootDaemon();
    const drain = vi.spyOn(WorkflowManager.prototype, 'shutdown');

    const first = daemon?.shutdown();
    const second = daemon?.shutdown();
    expect(second).toBe(first);
    await first;
    expect(drain).toHaveBeenCalledTimes(1);
  });
});
