/**
 * FU-10: the notices of a workflow's agent sessions. Setuid/setgid or
 * root-owned files an agent left in its container's host mounts (DINF-3)
 * reach the run's message log, from a state session's diagnostics (after a
 * turn, or at the end of a state that owns its container) and from a shared
 * bundle's teardown; neither marks the run failed. A stale-policy notice is
 * shown on stderr, where buildSessionConfig wrote the warning before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { BundleId, SessionOptions } from '../../src/session/types.js';
import type { HostPrivilegedFilesDiagnostic } from '../../src/session/startup-notices.js';
import type { WorkflowDefinition, WorkflowId } from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import { HOST_MOUNT_SCAN_ERROR_CONTEXT, MessageLog, type ErrorEntry } from '../../src/workflow/message-log.js';
import {
  approvedResponse,
  createArtifactAwareSession,
  createDeps,
  createMockTab,
  stubPersonasForTest,
  waitForCompletion,
  writeDefinitionFile,
} from './test-helpers.js';

const singleStateDef = (settings: WorkflowDefinition['settings']): WorkflowDefinition => ({
  name: 'session-notices',
  description: 'One agent state',
  initial: 'work',
  settings,
  states: {
    work: {
      type: 'agent',
      description: 'Work',
      persona: 'global',
      prompt: 'Work.',
      inputs: [],
      outputs: ['result'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
});

const HOST_FILES: HostPrivilegedFilesDiagnostic = {
  kind: 'host_privileged_files',
  when: 'after agent turn',
  stripped: 0,
  unstripped: 1,
  rootOwned: 0,
  unlisted: 0,
  paths: ['/home/user/project/bin/shell'],
  incomplete: false,
  hint: 'Inspect the files IronCurtain could not neutralize and remove them as root (for example with sudo rm).',
};

function stubInfrastructure(workflowId: string, bundleId: BundleId): DockerInfrastructure {
  return {
    __stub: true,
    workflowId,
    bundleId,
    setTokenSessionId: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
  } as unknown as DockerInfrastructure;
}

describe('workflow session notices', () => {
  let tmpDir: string;
  let cleanupPersonas: (() => void) | undefined;
  const orchestrators: WorkflowOrchestrator[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-session-notices-'));
    cleanupPersonas = stubPersonasForTest(tmpDir, singleStateDef({ mode: 'builtin' }));
  });

  afterEach(async () => {
    for (const orchestrator of orchestrators.splice(0)) await orchestrator.shutdownAll();
    cleanupPersonas?.();
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function hostMountFindings(workflowId: WorkflowId): ErrorEntry[] {
    return new MessageLog(resolve(tmpDir, workflowId, 'messages.jsonl'))
      .readAll()
      .filter(
        (entry): entry is ErrorEntry => entry.type === 'error' && entry.context === HOST_MOUNT_SCAN_ERROR_CONTEXT,
      );
  }

  function stderrSpy(): string[] {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    return writes;
  }

  it("records the findings a state's session reports, and shows its stale-policy notice", async () => {
    const stderr = stderrSpy();
    const tab = createMockTab();
    const createSession = vi.fn(async (options: SessionOptions) => {
      // What a session emits while it initializes, and after its turn.
      options.onDiagnostic?.({ kind: 'policy_stale', message: 'Warning: the compiled policy at /p may be stale:' });
      options.onDiagnostic?.({ kind: 'tool_call', toolName: 'filesystem.read_file', preview: 'allowed' });
      options.onDiagnostic?.(HOST_FILES);
      return createArtifactAwareSession([{ text: approvedResponse(), artifacts: ['result'] }], tmpDir);
    });
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createSession, createWorkflowTab: () => tab }));
    orchestrators.push(orchestrator);

    const workflowId = await orchestrator.start(
      writeDefinitionFile(tmpDir, singleStateDef({ mode: 'builtin' })),
      'task',
    );
    await waitForCompletion(orchestrator, workflowId);

    const findings = hostMountFindings(workflowId);
    expect(findings).toHaveLength(1);
    expect(findings[0].error).toMatch(/^\[host-files\] Warning \(after agent turn\): IronCurtain found setuid/u);
    expect(findings[0].error).toContain('/home/user/project/bin/shell');
    expect(findings[0].error).toContain('sudo rm');
    const output = stderr.join('');
    expect(output).toContain('[workflow] [policy] Warning: the compiled policy at /p may be stale:');
    expect(output).toContain('[workflow] [host-files] Warning (after agent turn)');
    // The finding is shown in the workflow tab too; the policy warning stays on stderr, as before.
    const tabLines = vi.mocked(tab.write).mock.calls.map(([line]) => line);
    expect(tabLines).toEqual(expect.arrayContaining([expect.stringMatching(/^\[host-files\] Warning/u)]));
    expect(tabLines.some((line) => line.includes('[policy]'))).toBe(false);
    // A warning, not a failure: the run completed.
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
  });

  it("records what a shared bundle's teardown found left behind", async () => {
    stderrSpy();
    const def = singleStateDef({ mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true });
    const left: HostPrivilegedFilesDiagnostic = { ...HOST_FILES, when: 'session end', rootOwned: 1 };
    const destroyInfra = vi.fn(async () => ({ privilegedFiles: left }));
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: vi.fn(async () =>
          createArtifactAwareSession([{ text: approvedResponse(), artifacts: ['result'] }], tmpDir),
        ),
        createWorkflowInfrastructure: vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
          stubInfrastructure(input.workflowId, input.bundleId),
        ),
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    orchestrators.push(orchestrator);

    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, def), 'task');
    await waitForCompletion(orchestrator, workflowId);
    // Joins the teardown the completion started.
    await orchestrator.shutdownAll();

    expect(destroyInfra).toHaveBeenCalledTimes(1);
    const findings = hostMountFindings(workflowId);
    expect(findings).toHaveLength(1);
    expect(findings[0].error).toContain('Warning (session end)');
    expect(findings[0].error).toContain('1 root-owned entry');
  });

  it('records nothing when a teardown resolves with nothing to report', async () => {
    const def = singleStateDef({ mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true });
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: vi.fn(async () =>
          createArtifactAwareSession([{ text: approvedResponse(), artifacts: ['result'] }], tmpDir),
        ),
        createWorkflowInfrastructure: vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
          stubInfrastructure(input.workflowId, input.bundleId),
        ),
        destroyWorkflowInfrastructure: vi.fn(async () => {}),
      }),
    );
    orchestrators.push(orchestrator);

    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, def), 'task');
    await waitForCompletion(orchestrator, workflowId);
    await orchestrator.shutdownAll();

    expect(hostMountFindings(workflowId)).toEqual([]);
  });

  it('records a mocked teardown finding when an abort overtakes bundle creation', async () => {
    stderrSpy();
    const def = singleStateDef({ mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true });
    let release: ((infra: DockerInfrastructure) => void) | undefined;
    let input: CreateWorkflowInfrastructureInput | undefined;
    const destroy = vi.fn(async () => ({ privilegedFiles: { ...HOST_FILES, when: 'session end' } }));
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createWorkflowInfrastructure: vi.fn((value: CreateWorkflowInfrastructureInput) => {
          input = value;
          return new Promise<DockerInfrastructure>((resolve) => {
            release = resolve;
          });
        }),
        destroyWorkflowInfrastructure: destroy,
        createSession: vi.fn(),
      }),
    );
    orchestrators.push(orchestrator);
    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, def), 'task');
    await vi.waitFor(() => expect(input).toBeDefined());
    const abort = orchestrator.abort(workflowId);
    if (!release || !input) throw new Error('Expected the small fixture bundle to be pending');
    release(stubInfrastructure(input.workflowId, input.bundleId));
    await abort;
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(hostMountFindings(workflowId)).toHaveLength(1);
  });
});
