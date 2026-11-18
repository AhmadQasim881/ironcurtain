/**
 * Tests for shared helpers exported from `src/workflow/cli-support.ts`.
 *
 * `isCheckpointResumable` is covered for the four checkpoint generations it
 * documents — mid-run, terminal completed, terminal non-completed, and legacy
 * retained checkpoints without `finalStatus`.
 *
 * `printSummary`, `printResumeInfo` and `synthesizeCheckpoint` read a run's
 * `.workflow` tree, which the agent can write (FU-07): a file, FIFO or
 * symlink there must not crash the CLI, a symlinked task file must never
 * become the resumed agent's task, and a FIFO must never hang the CLI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isCheckpointResumable,
  printResumeInfo,
  printSummary,
  synthesizeCheckpoint,
} from '../src/workflow/cli-support.js';
import { FileCheckpointStore } from '../src/workflow/checkpoint.js';
import type { WorkflowOrchestrator } from '../src/workflow/orchestrator.js';
import type { WorkflowCheckpoint, WorkflowId, WorkflowStatus } from '../src/workflow/types.js';
import { fifoSupported, makeFifo, startFifoUnblocker } from './helpers/fifo.js';

function makeCheckpoint(finalStatus?: WorkflowStatus): WorkflowCheckpoint {
  return {
    machineState: 'coding',
    context: {
      taskDescription: 'test',
      artifacts: {},
      round: 1,
      maxRounds: 4,
      previousOutputHashes: {},
      previousTestCount: null,
      humanPrompt: null,
      reviewHistory: [],
      totalTokens: 0,
      lastError: null,
      agentConversationsByState: {},
      previousAgentOutput: null,
      previousAgentNotes: null,
      previousStateName: null,
      visitCounts: {},
    },
    timestamp: new Date().toISOString(),
    transitionHistory: [],
    definitionPath: '/tmp/workflow.json',
    finalStatus,
  };
}

describe('isCheckpointResumable', () => {
  it('returns true for a mid-run checkpoint (no finalStatus)', () => {
    const cp = makeCheckpoint(undefined);
    expect(isCheckpointResumable(cp)).toBe(true);
  });

  it('returns false for a terminal completed checkpoint', () => {
    const cp = makeCheckpoint({
      phase: 'completed',
      result: { finalArtifacts: {} },
    });
    expect(isCheckpointResumable(cp)).toBe(false);
  });

  it('returns true for a terminal aborted checkpoint', () => {
    const cp = makeCheckpoint({
      phase: 'aborted',
      reason: 'user abort',
    });
    expect(isCheckpointResumable(cp)).toBe(true);
  });

  it('returns true for a terminal failed checkpoint', () => {
    const cp = makeCheckpoint({
      phase: 'failed',
      error: 'agent crashed',
      lastState: 'implement',
    });
    expect(isCheckpointResumable(cp)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agent-writable .workflow trees (FU-07)
// ---------------------------------------------------------------------------

const WORKFLOW_ID = 'wf-untrusted-1' as WorkflowId;
const PLACEHOLDER_TASK = 'Unknown task (synthesized checkpoint)';
const HOST_SECRET = 'HOST SECRET: never the agent task';

describe('workflow CLI helpers on an agent-writable .workflow', () => {
  let base: string;
  let runsDir: string;
  let workspace: string;
  let artifactDir: string;
  let secretFile: string;
  let stdout: string[];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'ic-cli-support-')));
    runsDir = join(base, 'workflow-runs');
    workspace = join(runsDir, WORKFLOW_ID, 'workspace');
    artifactDir = join(workspace, '.workflow');
    mkdirSync(workspace, { recursive: true });
    // A host file outside every run (an SSH key, say).
    secretFile = join(base, 'id_ed25519');
    writeFileSync(secretFile, HOST_SECRET);
    // Where a symlinked .workflow leads: outputs and a task file, none of them the run's.
    mkdirSync(join(base, 'outside', 'host-dir'), { recursive: true });
    mkdirSync(join(base, 'outside', 'task'));
    writeFileSync(join(base, 'outside', 'task', 'task.md'), HOST_SECRET);
    stdout = [];
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    };
    process.stderr.write = (): boolean => true;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    rmSync(base, { recursive: true, force: true });
  });

  const completed = {
    getStatus: () => ({ phase: 'completed', result: { finalArtifacts: {} } }),
  } as unknown as WorkflowOrchestrator;

  function synthesize(): WorkflowCheckpoint {
    return synthesizeCheckpoint(runsDir, 'plan', join(runsDir, 'definition.json'), new FileCheckpointStore(runsDir))
      .checkpoint;
  }

  /** Each non-directory an agent could leave at `.workflow`. */
  const nonDirectories: Array<[string, () => void]> = [
    ['a regular file', () => writeFileSync(artifactDir, 'not a directory')],
    ['a symlink to a directory outside the workspace', () => symlinkSync(join(base, 'outside'), artifactDir)],
  ];
  if (fifoSupported) nonDirectories.push(['a FIFO', () => makeFifo(artifactDir)]);

  it.each(nonDirectories)('printSummary and printResumeInfo do not throw when .workflow is %s', (_kind, plant) => {
    plant();

    expect(() => printSummary(completed, WORKFLOW_ID, artifactDir)).not.toThrow();
    expect(() =>
      printResumeInfo(runsDir, WORKFLOW_ID, { ...makeCheckpoint(), workspacePath: workspace }),
    ).not.toThrow();

    const out = stdout.join('');
    expect(out).toContain('Contents: (not a directory)');
    expect(out).toContain('Artifacts present: (not a directory)');
    expect(out).not.toContain('host-dir');
  });

  it('lists only the real artifact directories, never a link or a file', () => {
    mkdirSync(join(artifactDir, 'plan'), { recursive: true });
    mkdirSync(join(artifactDir, 'review'));
    writeFileSync(join(artifactDir, 'notes.txt'), 'x');
    symlinkSync(join(base, 'outside'), join(artifactDir, 'linked'));

    printSummary(completed, WORKFLOW_ID, artifactDir);
    printResumeInfo(runsDir, WORKFLOW_ID, { ...makeCheckpoint(), workspacePath: workspace });

    const out = stdout.join('');
    expect(out).toContain('Contents: plan, review\n');
    expect(out).toContain('Artifacts present: plan, review');
  });

  it('synthesizeCheckpoint takes the task from a regular task file and the artifacts from real directories', () => {
    mkdirSync(join(artifactDir, 'task'), { recursive: true });
    writeFileSync(join(artifactDir, 'task', 'description.md'), '  Fix the parser bug  \n');
    mkdirSync(join(artifactDir, 'plan'));
    writeFileSync(join(artifactDir, 'stray.txt'), 'x');
    symlinkSync(join(base, 'outside'), join(artifactDir, 'linked'));

    const checkpoint = synthesize();

    expect(checkpoint.context.taskDescription).toBe('Fix the parser bug');
    expect(checkpoint.context.artifacts).toEqual({ plan: join(artifactDir, 'plan'), task: join(artifactDir, 'task') });
    expect(checkpoint.workspacePath).toBe(workspace);
  });

  it('synthesizeCheckpoint never takes the task from a symlinked task file', () => {
    mkdirSync(join(artifactDir, 'task'), { recursive: true });
    symlinkSync(secretFile, join(artifactDir, 'task', 'a.md'));

    const checkpoint = synthesize();

    expect(checkpoint.context.taskDescription).toBe(PLACEHOLDER_TASK);
    expect(JSON.stringify(checkpoint)).not.toContain(HOST_SECRET);
    expect(stdout.join('')).not.toContain(HOST_SECRET);
  });

  it('synthesizeCheckpoint skips a symlinked task file and uses the regular one beside it', () => {
    mkdirSync(join(artifactDir, 'task'), { recursive: true });
    symlinkSync(secretFile, join(artifactDir, 'task', 'a.md'));
    writeFileSync(join(artifactDir, 'task', 'b.md'), 'The real task');

    expect(synthesize().context.taskDescription).toBe('The real task');
  });

  it('synthesizeCheckpoint never follows a symlinked task directory or .workflow', () => {
    mkdirSync(artifactDir);
    symlinkSync(join(base, 'outside', 'task'), join(artifactDir, 'task'));
    const linkedTaskDir = synthesize();
    expect(linkedTaskDir.context.taskDescription).toBe(PLACEHOLDER_TASK);
    expect(linkedTaskDir.context.artifacts).toEqual({});

    rmSync(artifactDir, { recursive: true });
    symlinkSync(join(base, 'outside'), artifactDir);
    const linkedRoot = synthesize();
    expect(linkedRoot.context.taskDescription).toBe(PLACEHOLDER_TASK);
    expect(linkedRoot.context.artifacts).toEqual({});
    expect(JSON.stringify([linkedTaskDir, linkedRoot])).not.toContain(HOST_SECRET);
  });

  it('synthesizeCheckpoint does not throw when .workflow is a regular file', () => {
    writeFileSync(artifactDir, 'not a directory');

    const checkpoint = synthesize();

    expect(checkpoint.context.taskDescription).toBe(PLACEHOLDER_TASK);
    expect(checkpoint.context.artifacts).toEqual({});
  });

  it.skipIf(!fifoSupported)('synthesizeCheckpoint never blocks on a FIFO task file', () => {
    mkdirSync(join(artifactDir, 'task'), { recursive: true });
    const fifo = join(artifactDir, 'task', 'a.md');
    makeFifo(fifo);
    const unblocker = startFifoUnblocker(fifo, 5);
    const started = Date.now();
    let checkpoint: WorkflowCheckpoint;
    try {
      checkpoint = synthesize();
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(checkpoint.context.taskDescription).toBe(PLACEHOLDER_TASK);
  });
});
