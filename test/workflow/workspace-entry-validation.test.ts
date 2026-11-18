/**
 * Workflow entry points validate caller-supplied workspaces exactly like
 * `ironcurtain start -w` (validateWorkspacePath) and keep the canonical path:
 *
 *   - WorkflowOrchestrator.start() with a supplied workspace
 *   - WorkflowOrchestrator.resume() with a checkpoint workspace other than the
 *     run's derived default (relocated, imported or tampered checkpoints)
 *   - the daemon's `workflows.start` / `workflows.resume` RPCs
 *
 * while the default workflow workspace keeps working on start and resume.
 *
 * Every test runs with a fake $HOME whose default IronCurtain home holds the
 * production layout (`~/.ironcurtain/workflow-runs/<id>/workspace`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SessionOptions } from '../../src/session/types.js';
import type { WorkflowDefinition, WorkflowId } from '../../src/workflow/types.js';
import { WorkflowOrchestrator, type WorkflowOrchestratorDeps } from '../../src/workflow/orchestrator.js';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';
import { writeRunDefinition } from '../../src/workflow/run-definition.js';
import { createInitialContext } from '../../src/workflow/machine-builder.js';
import { validateWorkspacePath } from '../../src/session/workspace-validation.js';
import { workflowDispatch, type WorkflowDispatchContext } from '../../src/web-ui/dispatch/workflow-dispatch.js';
import { RpcError } from '../../src/web-ui/web-ui-types.js';
import { WebEventBus } from '../../src/web-ui/web-event-bus.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { ControlRequestHandler } from '../../src/daemon/control-socket.js';
import type { WorkflowManager } from '../../src/workflow/workflow-manager.js';
import { runRunState } from '../../src/workflow/run-state-command.js';
import { MockSession, approvedResponse, createDeps, waitForGate, writeDefinitionFile } from './test-helpers.js';

const gatedDef: WorkflowDefinition = {
  name: 'workspace-entry',
  description: 'Draft, then wait for a human',
  initial: 'draft',
  settings: { mode: 'builtin' },
  states: {
    draft: {
      type: 'agent',
      description: 'Writes a draft',
      persona: 'global',
      prompt: 'Write a draft.',
      inputs: [],
      outputs: ['draft'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'human_gate',
      description: 'Review the draft',
      acceptedEvents: ['APPROVE', 'ABORT'],
      present: ['draft'],
      transitions: [
        { to: 'done', event: 'APPROVE' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

/** A session that writes the `draft` artifact into the workspace it was given. */
function draftWritingSession(opts: SessionOptions): MockSession {
  return new MockSession({
    responses: () => {
      if (!opts.workspacePath) throw new Error('session got no workspace');
      const dir = resolve(opts.workspacePath, '.workflow', 'draft');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'draft.md'), 'a draft');
      return approvedResponse();
    },
  });
}

describe('workflow workspace entry validation', () => {
  let root: string;
  let userHome: string;
  let icHome: string;
  let baseDir: string;
  let defPath: string;
  let sessionWorkspaces: string[];
  const orchestrators: WorkflowOrchestrator[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['HOME', 'IRONCURTAIN_HOME', 'AUDIT_LOG_PATH']) savedEnv[key] = process.env[key];
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-wf-workspace-')));
    userHome = join(root, 'home', 'alice');
    icHome = join(userHome, '.ironcurtain');
    baseDir = join(icHome, 'workflow-runs');
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(join(userHome, 'project'), { recursive: true });
    process.env.HOME = userHome;
    delete process.env.IRONCURTAIN_HOME;
    delete process.env.AUDIT_LOG_PATH;
    const defsDir = join(root, 'defs');
    mkdirSync(defsDir);
    defPath = writeDefinitionFile(defsDir, gatedDef);
    sessionWorkspaces = [];
  });

  afterEach(async () => {
    for (const orchestrator of orchestrators.splice(0)) {
      await orchestrator.shutdownAll().catch(() => {});
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function makeOrchestrator(overrides: Partial<WorkflowOrchestratorDeps> = {}): {
    orchestrator: WorkflowOrchestrator;
    raiseGate: ReturnType<typeof vi.fn>;
  } {
    const raiseGate = vi.fn();
    const orchestrator = new WorkflowOrchestrator(
      createDeps(baseDir, {
        checkpointStore: new FileCheckpointStore(baseDir),
        raiseGate,
        createSession: vi.fn(async (opts: SessionOptions) => {
          if (opts.workspacePath) sessionWorkspaces.push(opts.workspacePath);
          return draftWritingSession(opts);
        }),
        ...overrides,
      }),
    );
    orchestrators.push(orchestrator);
    return { orchestrator, raiseGate };
  }

  /** Persists a checkpoint paused at the review gate, with the given workspace. */
  function saveGateCheckpoint(
    store: FileCheckpointStore,
    workflowId: WorkflowId,
    workspacePath: string,
    runBaseDir = baseDir,
  ): void {
    const runDir = resolve(runBaseDir, workflowId);
    mkdirSync(runDir, { recursive: true });
    writeRunDefinition(runDir, gatedDef);
    store.save(workflowId, {
      machineState: 'review',
      context: { ...createInitialContext(gatedDef), taskDescription: 'resume me' },
      timestamp: new Date().toISOString(),
      transitionHistory: [],
      definitionPath: defPath,
      workspacePath,
    });
  }

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------

  describe('start()', () => {
    it.each([
      ['~', 'Cannot use home directory as workspace'],
      ['~/.ironcurtain', 'inside the IronCurtain home directory'],
      ['~/.ironcurtain/workflow-runs', 'inside the IronCurtain home directory'],
    ])('rejects --workspace %s before creating anything', async (workspace, message) => {
      const { orchestrator } = makeOrchestrator();
      await expect(orchestrator.start(defPath, 'task', workspace)).rejects.toMatchObject({
        code: 'WORKSPACE_UNSAFE',
        message: expect.stringContaining(message),
      });
      expect(readdirSync(baseDir)).toEqual([]);
      expect(existsSync(join(userHome, '.workflow'))).toBe(false);
      expect(existsSync(join(icHome, '.workflow'))).toBe(false);
      expect(orchestrator.listActive()).toEqual([]);
    });

    it('rejects a parent of $HOME and a symlink to $HOME', async () => {
      const { orchestrator } = makeOrchestrator();
      await expect(orchestrator.start(defPath, 'task', join(root, 'home'))).rejects.toMatchObject({
        code: 'WORKSPACE_UNSAFE',
        message: expect.stringContaining('contains the home directory'),
      });

      const link = join(root, 'innocent-looking');
      symlinkSync(userHome, link);
      await expect(orchestrator.start(defPath, 'task', link)).rejects.toMatchObject({ code: 'WORKSPACE_UNSAFE' });
      expect(existsSync(join(userHome, '.workflow'))).toBe(false);
    });

    it('rejects a workspace that does not exist instead of creating it', async () => {
      const { orchestrator } = makeOrchestrator();
      const missing = join(root, 'not-there');
      await expect(orchestrator.start(defPath, 'task', missing)).rejects.toMatchObject({
        code: 'WORKSPACE_NOT_FOUND',
      });
      expect(existsSync(missing)).toBe(false);
    });

    it('runs in the canonical path of a supplied workspace', async () => {
      const real = join(userHome, 'project');
      const link = join(root, 'project-link');
      symlinkSync(real, link);
      const { orchestrator, raiseGate } = makeOrchestrator();

      const workflowId = await orchestrator.start(defPath, 'task', link);
      await waitForGate(raiseGate, 1);

      expect(orchestrator.getDetail(workflowId)?.workspacePath).toBe(realpathSync(real));
      expect(sessionWorkspaces).toEqual([realpathSync(real)]);
      expect(existsSync(join(real, '.workflow', 'task', 'description.md'))).toBe(true);
    });

    it('detects a workspace already in use under a different spelling', async () => {
      const real = join(userHome, 'project');
      const link = join(root, 'project-link');
      symlinkSync(real, link);
      const { orchestrator, raiseGate } = makeOrchestrator();

      await orchestrator.start(defPath, 'task', link);
      await waitForGate(raiseGate, 1);
      await expect(orchestrator.start(defPath, 'task', real)).rejects.toThrow('already in use');
    });

    it('uses and accepts the default workspace under ~/.ironcurtain/workflow-runs', async () => {
      const { orchestrator, raiseGate } = makeOrchestrator();
      const workflowId = await orchestrator.start(defPath, 'task');
      await waitForGate(raiseGate, 1);

      const workspace = orchestrator.getDetail(workflowId)?.workspacePath;
      expect(workspace).toBe(resolve(baseDir, workflowId, 'workspace'));
      // The same directory also passes the validator (managed workspace).
      expect(validateWorkspacePath(resolve(baseDir, workflowId, 'workspace'), [icHome])).toBe(
        realpathSync(resolve(baseDir, workflowId, 'workspace')),
      );
    });

    it('falls back to loadConfig().protectedPaths when the deps carry none', async () => {
      // AUDIT_LOG_PATH is one protected entry only loadConfig() knows about.
      const auditDir = join(root, 'audit-dir');
      const workspace = join(auditDir, 'ws');
      mkdirSync(workspace, { recursive: true });
      process.env.AUDIT_LOG_PATH = auditDir;

      const withoutList = makeOrchestrator({ protectedPaths: undefined }).orchestrator;
      await expect(withoutList.start(defPath, 'task', workspace)).rejects.toMatchObject({
        code: 'WORKSPACE_UNSAFE',
        message: expect.stringContaining('overlaps with protected path'),
      });

      const { orchestrator: withEmptyList, raiseGate } = makeOrchestrator({ protectedPaths: [] });
      await withEmptyList.start(defPath, 'task', workspace);
      await waitForGate(raiseGate, 1);
    });
  });

  // -------------------------------------------------------------------------
  // resume()
  // -------------------------------------------------------------------------

  describe('resume()', () => {
    const workflowId = 'wf-entry-resume' as WorkflowId;

    it('resumes a run whose checkpoint holds the derived default workspace', async () => {
      const store = new FileCheckpointStore(baseDir);
      const workspace = resolve(baseDir, workflowId, 'workspace');
      mkdirSync(workspace, { recursive: true });
      saveGateCheckpoint(store, workflowId, workspace);
      const { orchestrator, raiseGate } = makeOrchestrator({ checkpointStore: store });

      await orchestrator.resume(workflowId);
      await waitForGate(raiseGate, 1);
      expect(orchestrator.getDetail(workflowId)?.workspacePath).toBe(workspace);
      expect(existsSync(join(workspace, '.workflow'))).toBe(true);
    });

    it('refuses a run whose derived default workspace is gone instead of recreating it empty', async () => {
      const store = new FileCheckpointStore(baseDir);
      const workspace = resolve(baseDir, workflowId, 'workspace');
      saveGateCheckpoint(store, workflowId, workspace);
      const { orchestrator, raiseGate } = makeOrchestrator({ checkpointStore: store });

      await expect(orchestrator.resume(workflowId)).rejects.toMatchObject({ code: 'WORKFLOW_WORKSPACE_MISSING' });
      expect(existsSync(workspace)).toBe(false);
      expect(raiseGate).not.toHaveBeenCalled();
      expect(orchestrator.listActive()).toEqual([]);
    });

    it('resumes a copied run directory in its own copy of the default workspace', async () => {
      // e.g. resume-standalone of a run copied out of ~/.ironcurtain/workflow-runs:
      // the run-local workspace follows the copy, the original is never touched.
      const otherBase = join(root, 'copied-runs');
      mkdirSync(otherBase);
      const store = new FileCheckpointStore(otherBase);
      const original = resolve(baseDir, workflowId, 'workspace');
      mkdirSync(original, { recursive: true });
      const copy = resolve(otherBase, workflowId, 'workspace');
      mkdirSync(copy, { recursive: true });
      saveGateCheckpoint(store, workflowId, original, otherBase);

      const raiseGate = vi.fn();
      const orchestrator = new WorkflowOrchestrator(
        createDeps(otherBase, { checkpointStore: store, raiseGate, createSession: vi.fn() }),
      );
      orchestrators.push(orchestrator);
      await orchestrator.resume(workflowId);
      await waitForGate(raiseGate, 1);
      expect(orchestrator.getDetail(workflowId)?.workspacePath).toBe(copy);
      expect(existsSync(join(copy, '.workflow'))).toBe(true);
      expect(existsSync(join(original, '.workflow'))).toBe(false);
    });

    it('refuses a copied run whose own workspace was not copied, leaving the original alone', async () => {
      const otherBase = join(root, 'copied-runs');
      mkdirSync(otherBase);
      const store = new FileCheckpointStore(otherBase);
      const original = resolve(baseDir, workflowId, 'workspace');
      mkdirSync(original, { recursive: true });
      saveGateCheckpoint(store, workflowId, original, otherBase);

      const orchestrator = new WorkflowOrchestrator(
        createDeps(otherBase, { checkpointStore: store, raiseGate: vi.fn(), createSession: vi.fn() }),
      );
      orchestrators.push(orchestrator);
      await expect(orchestrator.resume(workflowId)).rejects.toMatchObject({
        code: 'WORKFLOW_WORKSPACE_MISSING',
        message: expect.stringContaining(`recorded as ${original}`),
      });
      expect(existsSync(join(original, '.workflow'))).toBe(false);
      expect(existsSync(resolve(otherBase, workflowId, 'workspace'))).toBe(false);
    });

    it.each([
      ['recorded in the checkpoint', true],
      ['not recorded (a checkpoint from before workspaces were recorded)', false],
    ])('validates a derived default workspace that is a symlink (%s)', async (_label, recordWorkspace) => {
      // A copied or foreign base directory (resume-standalone) can hold a run
      // whose default workspace is a symlink of its author's choosing: it must
      // never hand the agent $HOME unvalidated.
      const otherBase = join(root, 'foreign-runs');
      const runDir = join(otherBase, workflowId);
      mkdirSync(runDir, { recursive: true });
      symlinkSync(userHome, join(runDir, 'workspace'));
      writeRunDefinition(runDir, gatedDef);
      const store = new FileCheckpointStore(otherBase);
      if (recordWorkspace) {
        saveGateCheckpoint(store, workflowId, join(runDir, 'workspace'), otherBase);
      } else {
        store.save(workflowId, {
          machineState: 'review',
          context: { ...createInitialContext(gatedDef), taskDescription: 'resume me' },
          timestamp: new Date().toISOString(),
          transitionHistory: [],
          definitionPath: defPath,
        });
      }
      const raiseGate = vi.fn();
      const orchestrator = new WorkflowOrchestrator(
        createDeps(otherBase, { checkpointStore: store, raiseGate, createSession: vi.fn() }),
      );
      orchestrators.push(orchestrator);

      await expect(orchestrator.resume(workflowId)).rejects.toMatchObject({
        code: 'WORKFLOW_NOT_RESUMABLE',
        message: expect.stringContaining('home directory'),
      });
      expect(raiseGate).not.toHaveBeenCalled();
      expect(existsSync(join(userHome, '.workflow'))).toBe(false);
    });

    it('resumes in the canonical target of a symlinked default workspace that passes validation', async () => {
      const otherBase = join(root, 'foreign-runs');
      const runDir = join(otherBase, workflowId);
      mkdirSync(runDir, { recursive: true });
      const target = join(userHome, 'project');
      symlinkSync(target, join(runDir, 'workspace'));
      const store = new FileCheckpointStore(otherBase);
      saveGateCheckpoint(store, workflowId, join(runDir, 'workspace'), otherBase);
      const raiseGate = vi.fn();
      const orchestrator = new WorkflowOrchestrator(
        createDeps(otherBase, { checkpointStore: store, raiseGate, createSession: vi.fn() }),
      );
      orchestrators.push(orchestrator);

      await orchestrator.resume(workflowId);
      await waitForGate(raiseGate, 1);
      expect(orchestrator.getDetail(workflowId)?.workspacePath).toBe(realpathSync(target));
    });

    it('refuses a checkpoint whose user workspace no longer exists with WORKFLOW_WORKSPACE_MISSING', async () => {
      const store = new FileCheckpointStore(baseDir);
      const gone = join(root, 'gone');
      saveGateCheckpoint(store, workflowId, gone);
      const { orchestrator, raiseGate } = makeOrchestrator({ checkpointStore: store });

      await expect(orchestrator.resume(workflowId)).rejects.toMatchObject({ code: 'WORKFLOW_WORKSPACE_MISSING' });
      expect(existsSync(gone)).toBe(false);
      expect(raiseGate).not.toHaveBeenCalled();
    });

    it.each([
      ['$HOME', (): string => userHome],
      ['the IronCurtain home', (): string => icHome],
      ['a parent of $HOME', (): string => join(root, 'home')],
    ])('refuses a checkpoint whose workspace is %s', async (_label, workspaceOf) => {
      const store = new FileCheckpointStore(baseDir);
      saveGateCheckpoint(store, workflowId, workspaceOf());
      const { orchestrator, raiseGate } = makeOrchestrator({ checkpointStore: store });

      await expect(orchestrator.resume(workflowId)).rejects.toMatchObject({
        code: 'WORKFLOW_NOT_RESUMABLE',
        message: expect.stringContaining('workspace failed validation'),
      });
      expect(raiseGate).not.toHaveBeenCalled();
      expect(orchestrator.listActive()).toEqual([]);
      expect(existsSync(join(workspaceOf(), '.workflow'))).toBe(false);
    });

    it('resumes in the canonical path of a recorded user workspace', async () => {
      const store = new FileCheckpointStore(baseDir);
      const real = join(userHome, 'project');
      const link = join(root, 'project-link');
      symlinkSync(real, link);
      saveGateCheckpoint(store, workflowId, link);
      const { orchestrator, raiseGate } = makeOrchestrator({ checkpointStore: store });

      await orchestrator.resume(workflowId);
      await waitForGate(raiseGate, 1);
      expect(orchestrator.getDetail(workflowId)?.workspacePath).toBe(realpathSync(real));
    });
  });

  // -------------------------------------------------------------------------
  // Daemon RPCs
  // -------------------------------------------------------------------------

  describe('daemon dispatch', () => {
    function makeContext(orchestrator: WorkflowOrchestrator): WorkflowDispatchContext {
      const manager = {
        getOrchestrator: () => orchestrator,
        getBaseDir: () => baseDir,
        importExternalCheckpoint: () => {
          throw new Error('not used');
        },
      } as unknown as WorkflowManager;
      return {
        handler: {} as ControlRequestHandler,
        sessionManager: new SessionManager(),
        mode: { kind: 'builtin' },
        eventBus: new WebEventBus(),
        maxConcurrentWebSessions: 5,
        sessionQueues: new Map(),
        workflowManager: manager,
      };
    }

    async function rpcError(promise: Promise<unknown>): Promise<RpcError> {
      try {
        await promise;
      } catch (err) {
        if (err instanceof RpcError) return err;
        throw err;
      }
      throw new Error('expected the RPC to fail');
    }

    it('maps a rejected workflows.start workspace to INVALID_PARAMS', async () => {
      const { orchestrator } = makeOrchestrator();
      const ctx = makeContext(orchestrator);

      const home = await rpcError(
        workflowDispatch(ctx, 'workflows.start', { definitionPath: defPath, taskDescription: 't', workspacePath: '~' }),
      );
      expect(home.code).toBe('INVALID_PARAMS');
      expect(home.message).toContain('home directory');

      const icHomeErr = await rpcError(
        workflowDispatch(ctx, 'workflows.start', {
          definitionPath: defPath,
          taskDescription: 't',
          workspacePath: icHome,
        }),
      );
      expect(icHomeErr.code).toBe('INVALID_PARAMS');
      expect(icHomeErr.message).toContain('IronCurtain home');

      const missing = await rpcError(
        workflowDispatch(ctx, 'workflows.start', {
          definitionPath: defPath,
          taskDescription: 't',
          workspacePath: join(root, 'missing'),
        }),
      );
      expect(missing.code).toBe('INVALID_PARAMS');
      expect(missing.message).toContain('does not exist');
      expect(existsSync(join(root, 'missing'))).toBe(false);
      expect(readdirSync(baseDir)).toEqual([]);
    });

    it('rejects a relative workflows.start workspace instead of resolving it against the daemon cwd', async () => {
      const { orchestrator } = makeOrchestrator();
      const startSpy = vi.spyOn(orchestrator, 'start');
      const err = await rpcError(
        workflowDispatch(makeContext(orchestrator), 'workflows.start', {
          definitionPath: defPath,
          taskDescription: 't',
          workspacePath: 'project',
        }),
      );
      expect(err.code).toBe('INVALID_PARAMS');
      expect(err.message).toContain('absolute path');
      expect(startSpy).not.toHaveBeenCalled();
    });

    it('starts in the canonical workspace for a valid workflows.start path', async () => {
      const { orchestrator, raiseGate } = makeOrchestrator();
      const link = join(root, 'project-link');
      symlinkSync(join(userHome, 'project'), link);

      const result = (await workflowDispatch(makeContext(orchestrator), 'workflows.start', {
        definitionPath: defPath,
        taskDescription: 't',
        workspacePath: link,
      })) as { workflowId: WorkflowId };
      await waitForGate(raiseGate, 1);
      expect(orchestrator.getDetail(result.workflowId)?.workspacePath).toBe(realpathSync(join(userHome, 'project')));
    });

    it('reports an unsafe checkpoint workspace on workflows.resume as WORKFLOW_NOT_RESUMABLE', async () => {
      const store = new FileCheckpointStore(baseDir);
      const workflowId = 'wf-entry-rpc' as WorkflowId;
      saveGateCheckpoint(store, workflowId, userHome);
      const { orchestrator } = makeOrchestrator({ checkpointStore: store });

      const err = await rpcError(workflowDispatch(makeContext(orchestrator), 'workflows.resume', { workflowId }));
      expect(err.code).toBe('WORKFLOW_NOT_RESUMABLE');
      expect(err.message).toContain('home directory');
    });
  });

  // -------------------------------------------------------------------------
  // workflow run-state
  // -------------------------------------------------------------------------

  describe('workflow run-state', () => {
    it('rejects an unsafe workspace source for `workflow run-state` before copying it', async () => {
      // run-state copies --workspace into the agent's staged workspace, so the
      // source must pass the same validation as a workspace used in place.
      const artifacts = join(root, 'artifacts');
      mkdirSync(artifacts);
      const stderr: string[] = [];
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
        throw new Error(`process.exit(${String(code)})`);
      });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      });
      try {
        for (const workspace of ['~', '~/.ironcurtain', join(root, 'home')]) {
          await expect(
            runRunState([defPath, 'draft', '--artifacts', artifacts, '--workspace', workspace]),
          ).rejects.toThrow('process.exit(2)');
        }
      } finally {
        exitSpy.mockRestore();
        stderrSpy.mockRestore();
      }
      expect(stderr.filter((line) => line.includes('Invalid --workspace'))).toHaveLength(3);
      expect(existsSync(join(icHome, 'debug-runs'))).toBe(false);
    });
  });
});
