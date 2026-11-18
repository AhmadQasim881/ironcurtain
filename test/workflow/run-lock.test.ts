/**
 * Cross-process run ownership (WP-48): a run and its workspace are locked from
 * start()/resume() until the run is terminalReady, so no second process (or
 * second orchestrator) executes the same run or writes the same workspace, and
 * listings skip runs that are live elsewhere. A crashed holder's lock is
 * reclaimed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { WorkflowDefinition, WorkflowId } from '../../src/workflow/types.js';
import { WorkflowOrchestrator, type WorkflowOrchestratorDeps } from '../../src/workflow/orchestrator.js';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';
import { findResumableCheckpoints } from '../../src/workflow/checkpoint-selection.js';
import {
  claimWorkflowRunLock,
  claimWorkflowWorkspaceLock,
  getWorkflowRunLockPath,
  getWorkspaceLockPath,
  isWorkflowLockBusyError,
  isWorkflowRunLockHeld,
  WorkflowLockBusyError,
} from '../../src/workflow/run-lock.js';
import { createDeps, resolveActiveGate, waitForCompletion, waitForGate, writeDefinitionFile } from './test-helpers.js';

const gateFirstDef: WorkflowDefinition = {
  name: 'run-lock-gate-first',
  description: 'Starts at a gate',
  initial: 'approve',
  settings: { mode: 'builtin', maxRounds: 2 },
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

/** A complete owner record for a process that no longer exists. */
function writeDeadOwnerLock(path: string): void {
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: 2 ** 30,
      processIdentity: 'dead-process-start',
      token: '00000000-0000-4000-8000-00000000dead',
      createdAtMs: Date.now() - 60_000,
    })}\n`,
    { mode: 0o600 },
  );
}

describe('workflow run and workspace locks', () => {
  let root: string;
  let baseDir: string;
  let lockDir: string;
  let defPath: string;
  const orchestrators: WorkflowOrchestrator[] = [];

  function makeOrchestrator(overrides: Partial<WorkflowOrchestratorDeps> = {}): {
    orchestrator: WorkflowOrchestrator;
    raiseGate: ReturnType<typeof vi.fn>;
  } {
    const raiseGate = vi.fn();
    const orchestrator = new WorkflowOrchestrator(
      createDeps(baseDir, {
        raiseGate,
        checkpointStore: new FileCheckpointStore(overrides.baseDir ?? baseDir),
        workspaceLockDir: lockDir,
        createSession: vi.fn(),
        ...overrides,
      }),
    );
    orchestrators.push(orchestrator);
    return { orchestrator, raiseGate };
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'wf-run-lock-')));
    baseDir = join(root, 'runs');
    lockDir = join(root, 'workspace-locks');
    mkdirSync(baseDir);
    const defsDir = join(root, 'defs');
    mkdirSync(defsDir);
    defPath = writeDefinitionFile(defsDir, gateFirstDef);
  });

  afterEach(async () => {
    for (const orchestrator of orchestrators.splice(0)) {
      await orchestrator.shutdownAll().catch(() => {});
    }
    rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Lock primitives
  // -------------------------------------------------------------------------

  describe('primitives', () => {
    const id = 'wf-lock-unit' as WorkflowId;

    it('claims a run lock, refuses any second claim, and frees it on release', () => {
      const held = claimWorkflowRunLock(baseDir, id);
      expect(existsSync(getWorkflowRunLockPath(baseDir, id))).toBe(true);
      expect(isWorkflowRunLockHeld(baseDir, id)).toBe(true);

      // Not re-entrant: this process is refused like any other.
      let thrown: unknown;
      try {
        claimWorkflowRunLock(baseDir, id);
      } catch (err) {
        thrown = err;
      }
      expect(isWorkflowLockBusyError(thrown)).toBe(true);
      expect(thrown).toMatchObject({ code: 'WORKFLOW_LOCK_BUSY', kind: 'run', ownerPid: process.pid });

      held.release();
      expect(isWorkflowRunLockHeld(baseDir, id)).toBe(false);
      claimWorkflowRunLock(baseDir, id).release();
    });

    it('reclaims the lock of a crashed holder', () => {
      mkdirSync(join(baseDir, id), { recursive: true });
      writeDeadOwnerLock(getWorkflowRunLockPath(baseDir, id));
      expect(isWorkflowRunLockHeld(baseDir, id)).toBe(false);

      const held = claimWorkflowRunLock(baseDir, id);
      expect(held.owner.pid).toBe(process.pid);
      held.release();
    });

    it('keys the workspace lock on the directory, so every spelling is one lock', () => {
      const workspace = join(root, 'project');
      mkdirSync(workspace);
      const alias = join(root, 'project-alias');
      symlinkSync(workspace, alias);

      const held = claimWorkflowWorkspaceLock(lockDir, alias);
      expect(existsSync(getWorkspaceLockPath(lockDir, workspace))).toBe(true);
      expect(() => claimWorkflowWorkspaceLock(lockDir, join(root, 'project', '.'))).toThrow(WorkflowLockBusyError);
      expect(() => claimWorkflowWorkspaceLock(lockDir, workspace)).toThrow(/Workspace .*project is in use/);
      held.release();
      claimWorkflowWorkspaceLock(lockDir, workspace).release();
    });

    it('keys the workspace lock on directory identity, not on a path string', () => {
      // A name realpath does not canonicalize still reaches the same lock.
      // Renaming stands in for the case and Unicode-normalization variants a
      // case-insensitive filesystem (macOS APFS) accepts for one directory,
      // and for bind mounts: different strings, one directory.
      const workspace = join(root, 'renamed-before');
      mkdirSync(workspace);
      const held = claimWorkflowWorkspaceLock(lockDir, workspace);
      const renamed = join(root, 'renamed-after');
      renameSync(workspace, renamed);
      try {
        expect(() => claimWorkflowWorkspaceLock(lockDir, renamed)).toThrow(WorkflowLockBusyError);
        // A different directory, even one later given the old name, is free.
        mkdirSync(workspace);
        claimWorkflowWorkspaceLock(lockDir, workspace).release();
      } finally {
        held.release();
      }
      claimWorkflowWorkspaceLock(lockDir, renamed).release();
    });

    it('never places a lock for an id that is not one plain path segment', () => {
      expect(() => claimWorkflowRunLock(baseDir, '../escape' as WorkflowId)).toThrow(/Invalid workflow ID/);
      expect(existsSync(join(root, 'escape'))).toBe(false);
      expect(isWorkflowRunLockHeld(baseDir, '../escape' as WorkflowId)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Orchestrators in one process
  // -------------------------------------------------------------------------

  it('a second orchestrator cannot resume a run the first holds, and can once it stopped', async () => {
    const { orchestrator: first, raiseGate: firstGate } = makeOrchestrator();
    const workflowId = await first.start(defPath, 'task');
    await waitForGate(firstGate, 1);
    expect(isWorkflowRunLockHeld(baseDir, workflowId)).toBe(true);

    const { orchestrator: second, raiseGate: secondGate } = makeOrchestrator();
    expect(second.listResumable()).not.toContain(workflowId);
    expect(findResumableCheckpoints(baseDir, new FileCheckpointStore(baseDir))).toEqual([]);
    await expect(second.resume(workflowId)).rejects.toMatchObject({
      code: 'WORKFLOW_ALREADY_ACTIVE',
      message: expect.stringContaining(`Workflow ${workflowId} is running in this process`),
    });
    expect(second.listActive()).toEqual([]);

    await first.abort(workflowId);
    expect(isWorkflowRunLockHeld(baseDir, workflowId)).toBe(false);
    expect(second.listResumable()).toContain(workflowId);

    await second.resume(workflowId);
    await waitForGate(secondGate, 1);
    expect(isWorkflowRunLockHeld(baseDir, workflowId)).toBe(true);
  });

  it('refuses to start a run on a workspace another run holds, under any spelling', async () => {
    const workspace = join(root, 'shared-workspace');
    mkdirSync(workspace);
    const alias = join(root, 'shared-alias');
    symlinkSync(workspace, alias);
    const otherBase = join(root, 'other-runs');
    mkdirSync(otherBase);

    const { orchestrator: first, raiseGate } = makeOrchestrator();
    const firstId = await first.start(defPath, 'task', workspace);
    await waitForGate(raiseGate, 1);

    // Another orchestrator on another base directory (another process in real
    // life: the CLI next to the daemon) is refused before it writes anything.
    const { orchestrator: second, raiseGate: secondGate } = makeOrchestrator({
      baseDir: otherBase,
      checkpointStore: new FileCheckpointStore(otherBase),
    });
    await expect(second.start(defPath, 'task', alias)).rejects.toThrow(
      /Workspace .*shared-workspace is in use by a workflow or cron job running in this process/,
    );
    expect(second.listActive()).toEqual([]);
    // The refused start left no run directory behind.
    expect(readdirSync(otherBase)).toEqual([]);

    await first.abort(firstId);
    const secondId = await second.start(defPath, 'task', alias);
    await waitForGate(secondGate, 1);
    expect(second.getDetail(secondId)?.workspacePath).toBe(workspace);
  });

  it('refuses to resume a checkpoint whose workspace another run holds', async () => {
    const workspace = join(root, 'imported-workspace');
    mkdirSync(workspace);
    const { orchestrator: first, raiseGate } = makeOrchestrator();
    const workflowId = await first.start(defPath, 'task', workspace);
    await waitForGate(raiseGate, 1);

    // The same checkpoint imported into another base directory still points
    // at the live run's workspace.
    const otherBase = join(root, 'imported-runs');
    const otherStore = new FileCheckpointStore(otherBase);
    const checkpoint = new FileCheckpointStore(baseDir).load(workflowId);
    expect(checkpoint).toBeDefined();
    if (!checkpoint) return;
    otherStore.save(workflowId, checkpoint);
    writeFileSync(join(otherBase, workflowId, 'definition.json'), JSON.stringify(gateFirstDef));

    const { orchestrator: second } = makeOrchestrator({ baseDir: otherBase, checkpointStore: otherStore });
    await expect(second.resume(workflowId)).rejects.toMatchObject({
      code: 'WORKFLOW_ALREADY_ACTIVE',
      message: expect.stringContaining('imported-workspace is in use'),
    });
    // Neither lock leaks from the refused resume.
    expect(isWorkflowRunLockHeld(otherBase, workflowId)).toBe(false);
    expect(second.listActive()).toEqual([]);
  });

  it('releases both locks once a run completes', async () => {
    const workspace = join(root, 'done-workspace');
    mkdirSync(workspace);
    const { orchestrator, raiseGate } = makeOrchestrator();
    const workflowId = await orchestrator.start(defPath, 'task', workspace);
    await waitForGate(raiseGate, 1);
    expect(existsSync(getWorkspaceLockPath(lockDir, workspace))).toBe(true);

    resolveActiveGate(orchestrator, workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator, workflowId);
    await vi.waitFor(() => expect(orchestrator.listActive()).toEqual([]), { timeout: 2000, interval: 5 });

    expect(existsSync(getWorkflowRunLockPath(baseDir, workflowId))).toBe(false);
    expect(existsSync(getWorkspaceLockPath(lockDir, workspace))).toBe(false);
  });

  it('resumes a run whose previous holder crashed', async () => {
    const { orchestrator: first, raiseGate } = makeOrchestrator();
    const workflowId = await first.start(defPath, 'task');
    await waitForGate(raiseGate, 1);
    await first.abort(workflowId);
    // A holder that died without releasing leaves its owner record behind.
    writeDeadOwnerLock(getWorkflowRunLockPath(baseDir, workflowId));

    const { orchestrator: second, raiseGate: secondGate } = makeOrchestrator();
    expect(second.listResumable()).toContain(workflowId);
    await second.resume(workflowId);
    await waitForGate(secondGate, 1);
  });

  // -------------------------------------------------------------------------
  // Two processes
  // -------------------------------------------------------------------------

  it('a second process cannot resume a run the first holds; the first crashing frees it', async () => {
    const orchestratorUrl = pathToFileURL(join(process.cwd(), 'src', 'workflow', 'orchestrator.ts')).href;
    const checkpointUrl = pathToFileURL(join(process.cwd(), 'src', 'workflow', 'checkpoint.ts')).href;
    const idFile = join(root, 'held-id');
    const program = `
      import { writeFileSync } from 'node:fs';
      import { WorkflowOrchestrator } from ${JSON.stringify(orchestratorUrl)};
      import { FileCheckpointStore } from ${JSON.stringify(checkpointUrl)};
      const [baseDir, defPath, lockDir, idFile] = process.argv.slice(1);
      const orchestrator = new WorkflowOrchestrator({
        createSession: async () => { throw new Error('no sessions in this fixture'); },
        createWorkflowTab: () => ({ write() {}, setLabel() {}, close() {} }),
        raiseGate: () => {},
        dismissGate: () => {},
        baseDir,
        checkpointStore: new FileCheckpointStore(baseDir),
        userConfig: { snapshot: { enabled: false } },
        protectedPaths: [],
        workspaceLockDir: lockDir,
      });
      const id = await orchestrator.start(defPath, 'held by another process');
      writeFileSync(idFile, id);
      setInterval(() => {}, 1000);
    `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', program, baseDir, defPath, lockDir, idFile],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, IRONCURTAIN_HOME: join(root, 'child-home') },
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    try {
      await vi.waitFor(
        () => {
          if (child.exitCode !== null) throw new Error(`holder exited early: ${stderr}`);
          expect(existsSync(idFile)).toBe(true);
        },
        { timeout: 45_000, interval: 50 },
      );
      const workflowId = readFileSync(idFile, 'utf8') as WorkflowId;

      const { orchestrator, raiseGate } = makeOrchestrator();
      expect(isWorkflowRunLockHeld(baseDir, workflowId)).toBe(true);
      expect(orchestrator.listResumable()).not.toContain(workflowId);
      await expect(orchestrator.resume(workflowId)).rejects.toMatchObject({
        code: 'WORKFLOW_ALREADY_ACTIVE',
        message: expect.stringContaining(`running in another IronCurtain process (pid ${child.pid})`),
      });
      expect(orchestrator.listActive()).toEqual([]);

      // The holder dies without cleaning up; its lock is reclaimed.
      child.kill('SIGKILL');
      await exited;
      expect(isWorkflowRunLockHeld(baseDir, workflowId)).toBe(false);
      expect(orchestrator.listResumable()).toContain(workflowId);
      await orchestrator.resume(workflowId);
      await waitForGate(raiseGate, 1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  }, 60_000);
});
