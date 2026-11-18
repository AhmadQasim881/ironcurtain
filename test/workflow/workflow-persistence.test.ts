/**
 * Workflow persistence across restarts, moves and versions:
 *
 *   - a run whose IronCurtain home moved resumes in the moved (rebased)
 *     workspace, never recreating the old location;
 *   - a checkpoint or definition copy from a newer format is refused with
 *     WORKFLOW_CHECKPOINT_TOO_NEW rather than reported as corrupted;
 *   - the definition copy is stamped and written owner-only;
 *   - failed checkpoint saves reach the message log and the workflow tab.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SessionOptions } from '../../src/session/types.js';
import type { WorkflowCheckpoint, WorkflowDefinition, WorkflowId } from '../../src/workflow/types.js';
import { WorkflowOrchestrator, type WorkflowTabHandle } from '../../src/workflow/orchestrator.js';
import { FileCheckpointStore, type CheckpointStore } from '../../src/workflow/checkpoint.js';
import { RUN_DEFINITION_SCHEMA_VERSION } from '../../src/workflow/run-definition.js';
import { VERSION } from '../../src/version.js';
import {
  MockSession,
  approvedResponse,
  createDeps,
  resolveActiveGate,
  waitForGate,
  writeDefinitionFile,
} from './test-helpers.js';

const gatedDef: WorkflowDefinition = {
  name: 'persistence-gated',
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
      writeFileSync(resolve(dir, 'draft.md'), 'the first draft');
      return approvedResponse();
    },
  });
}

describe('workflow persistence', () => {
  let root: string;
  let defPath: string;
  const orchestrators: WorkflowOrchestrator[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['HOME', 'IRONCURTAIN_HOME']) savedEnv[key] = process.env[key];
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-wf-persistence-')));
    process.env.HOME = join(root, 'user');
    mkdirSync(process.env.HOME, { recursive: true });
    delete process.env.IRONCURTAIN_HOME;
    const defsDir = join(root, 'defs');
    mkdirSync(defsDir);
    defPath = writeDefinitionFile(defsDir, gatedDef);
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

  function makeOrchestrator(
    baseDir: string,
    overrides: { checkpointStore?: CheckpointStore; tab?: WorkflowTabHandle } = {},
  ): { orchestrator: WorkflowOrchestrator; raiseGate: ReturnType<typeof vi.fn> } {
    const raiseGate = vi.fn();
    const orchestrator = new WorkflowOrchestrator(
      createDeps(baseDir, {
        checkpointStore: overrides.checkpointStore ?? new FileCheckpointStore(baseDir),
        raiseGate,
        createSession: vi.fn(async (opts: SessionOptions) => draftWritingSession(opts)),
        workspaceLockDir: join(root, 'workspace-locks'),
        ...(overrides.tab ? { createWorkflowTab: () => overrides.tab as WorkflowTabHandle } : {}),
      }),
    );
    orchestrators.push(orchestrator);
    return { orchestrator, raiseGate };
  }

  /** Starts the gated workflow under `baseDir` and stops it (as a daemon restart would) at the gate. */
  async function runToGateAndStop(baseDir: string): Promise<WorkflowId> {
    const { orchestrator, raiseGate } = makeOrchestrator(baseDir);
    const workflowId = await orchestrator.start(defPath, 'persist me');
    await waitForGate(raiseGate, 1);
    await orchestrator.shutdownAll();
    return workflowId;
  }

  it('resumes in the rebased workspace after the IronCurtain home moved', async () => {
    const oldHome = join(root, 'home-m1', '.ironcurtain');
    const newHome = join(root, 'home-m2', '.ironcurtain');
    const oldBase = join(oldHome, 'workflow-runs');
    const workflowId = await runToGateAndStop(oldBase);
    const oldWorkspace = join(oldBase, workflowId, 'workspace');
    expect(readFileSync(join(oldWorkspace, '.workflow', 'draft', 'draft.md'), 'utf8')).toBe('the first draft');

    // Move the whole home (new machine, renamed user, changed IRONCURTAIN_HOME).
    mkdirSync(join(root, 'home-m2'));
    renameSync(oldHome, newHome);
    const newBase = join(newHome, 'workflow-runs');
    const newWorkspace = join(newBase, workflowId, 'workspace');

    const { orchestrator, raiseGate } = makeOrchestrator(newBase);
    await orchestrator.resume(workflowId);
    await waitForGate(raiseGate, 1);

    expect(orchestrator.getDetail(workflowId)?.workspacePath).toBe(newWorkspace);
    expect(readFileSync(join(newWorkspace, '.workflow', 'draft', 'draft.md'), 'utf8')).toBe('the first draft');
    // Nothing was recreated at the old location.
    expect(existsSync(join(root, 'home-m1', '.ironcurtain'))).toBe(false);
    // The resumed checkpoint records the new run directory and workspace.
    const checkpoint = new FileCheckpointStore(newBase).load(workflowId);
    expect(checkpoint?.runDir).toBe(join(newBase, workflowId));
    expect(checkpoint?.workspacePath).toBe(newWorkspace);
  });

  it('rebases an unversioned checkpoint written before run directories were recorded', async () => {
    const oldBase = join(root, 'old', 'workflow-runs');
    const workflowId = await runToGateAndStop(oldBase);
    // Strip the format stamp and runDir: what an earlier release wrote.
    const checkpointPath = join(oldBase, workflowId, 'checkpoint.json');
    const legacy = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Record<string, unknown>;
    delete legacy.schemaVersion;
    delete legacy.writerVersion;
    delete legacy.runDir;
    writeFileSync(checkpointPath, JSON.stringify(legacy, null, 2));

    const newBase = join(root, 'new', 'workflow-runs');
    mkdirSync(join(root, 'new'));
    renameSync(oldBase, newBase);

    const { orchestrator, raiseGate } = makeOrchestrator(newBase);
    await orchestrator.resume(workflowId);
    await waitForGate(raiseGate, 1);
    expect(orchestrator.getDetail(workflowId)?.workspacePath).toBe(join(newBase, workflowId, 'workspace'));
    expect(existsSync(oldBase)).toBe(false);
  });

  it('refuses a checkpoint written in a newer format with WORKFLOW_CHECKPOINT_TOO_NEW', async () => {
    const baseDir = join(root, 'runs');
    const workflowId = await runToGateAndStop(baseDir);
    const checkpointPath = join(baseDir, workflowId, 'checkpoint.json');
    const record = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(checkpointPath, JSON.stringify({ ...record, schemaVersion: 99, writerVersion: '99.0.0' }));

    const { orchestrator, raiseGate } = makeOrchestrator(baseDir);
    await expect(orchestrator.resume(workflowId)).rejects.toMatchObject({
      code: 'WORKFLOW_CHECKPOINT_TOO_NEW',
      message: expect.stringContaining('99.0.0'),
    });
    expect(raiseGate).not.toHaveBeenCalled();
    expect(orchestrator.listResumable()).toEqual([]);
  });

  it('refuses a definition copy written in a newer format with WORKFLOW_CHECKPOINT_TOO_NEW', async () => {
    const baseDir = join(root, 'runs');
    const workflowId = await runToGateAndStop(baseDir);
    const definitionPath = join(baseDir, workflowId, 'definition.json');
    const record = JSON.parse(readFileSync(definitionPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(definitionPath, JSON.stringify({ ...record, schemaVersion: 99 }));

    const { orchestrator } = makeOrchestrator(baseDir);
    await expect(orchestrator.resume(workflowId)).rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_TOO_NEW' });
  });

  it('stamps the definition copy with its format and writer and keeps it owner-only', async () => {
    const baseDir = join(root, 'runs');
    const workflowId = await runToGateAndStop(baseDir);
    const definitionPath = join(baseDir, workflowId, 'definition.json');
    const record = JSON.parse(readFileSync(definitionPath, 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({
      schemaVersion: RUN_DEFINITION_SCHEMA_VERSION,
      writerVersion: VERSION,
      name: gatedDef.name,
    });
    expect(statSync(definitionPath).mode & 0o777).toBe(0o600);

    // An unstamped copy from an earlier release still resumes.
    delete record.schemaVersion;
    delete record.writerVersion;
    writeFileSync(definitionPath, JSON.stringify(record));
    const { orchestrator, raiseGate } = makeOrchestrator(baseDir);
    await orchestrator.resume(workflowId);
    await waitForGate(raiseGate, 1);
  });

  it('reports repeated checkpoint save failures in the message log and the workflow tab', async () => {
    const baseDir = join(root, 'runs');
    const real = new FileCheckpointStore(baseDir);
    let failSaves = true;
    const flaky: CheckpointStore = {
      save: (id: WorkflowId, checkpoint: WorkflowCheckpoint) => {
        if (failSaves) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        real.save(id, checkpoint);
      },
      load: (id) => real.load(id),
      listAll: () => real.listAll(),
      remove: (id) => real.remove(id),
    };
    const writes: string[] = [];
    const tab: WorkflowTabHandle = { write: (text) => writes.push(text), setLabel: () => {}, close: () => {} };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { orchestrator, raiseGate } = makeOrchestrator(baseDir, { checkpointStore: flaky, tab });
      const workflowId = await orchestrator.start(defPath, 'fails to persist');
      await waitForGate(raiseGate, 1);

      const entries = readFileSync(join(baseDir, workflowId, 'messages.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; error?: string; context?: string });
      const saveErrors = entries.filter((entry) => entry.type === 'error' && entry.context === 'checkpoint save');
      expect(saveErrors.length).toBeGreaterThanOrEqual(1);
      expect(saveErrors[0].error).toContain('no space left on device');
      expect(writes.some((text) => text.includes('Failed to save checkpoint'))).toBe(true);

      // The next successful save ends the streak, and says so.
      failSaves = false;
      resolveActiveGate(orchestrator, workflowId, { type: 'APPROVE' });
      await vi.waitFor(() => expect(writes.some((text) => text.includes('succeed again'))).toBe(true));
    } finally {
      stderr.mockRestore();
    }
  });
});
