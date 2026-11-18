/**
 * The workflow test helpers keep a test's checkpoints in the sibling
 * `<tmpDir>-ckpt`, outside the run directory the test removes itself, so the
 * helpers remove it when the test finishes. Before they did, most workflow
 * test files left one such directory per test in os.tmpdir(): thousands per
 * suite run, until a 1M-inode /tmp was full.
 */

import { afterAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowCheckpoint, WorkflowId } from '../../src/workflow/types.js';
import { checkpointDirFor, createCheckpointStore, createDeps } from './test-helpers.js';

const workflowId = 'wf-checkpoint-cleanup' as WorkflowId;

function checkpoint(): WorkflowCheckpoint {
  return {
    machineState: 'implement',
    context: {
      taskDescription: 'Clean up after yourself',
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
    definitionPath: '/nonexistent/workflow.json',
  };
}

describe('workflow test helpers remove the checkpoint directories they hand out', () => {
  /** Every run directory a test below made. */
  const runDirs: string[] = [];
  function makeRunDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-cleanup-test-'));
    runDirs.push(dir);
    return dir;
  }

  afterAll(() => {
    const leftovers = runDirs.map((runDir) => `${runDir}-ckpt`).filter((dir) => existsSync(dir));
    for (const dir of [...runDirs, ...leftovers]) rmSync(dir, { recursive: true, force: true });
    // Every test's checkpoint directory was already gone when its test finished.
    expect(leftovers).toEqual([]);
  });

  it('keeps the checkpoint beside the run directory, so it outlives that directory for the rest of the test', () => {
    const runDir = makeRunDir();
    const store = createCheckpointStore(runDir);
    store.save(workflowId, checkpoint());
    expect(checkpointDirFor(runDir)).toBe(`${runDir}-ckpt`);

    rmSync(runDir, { recursive: true, force: true });

    expect(store.load(workflowId)?.machineState).toBe('implement');
  });

  it('removes the checkpoint directory when the test finishes, also for the store createDeps makes', () => {
    const runDir = makeRunDir();
    const ckptDir = `${runDir}-ckpt`;
    // Registered before the helper's own hook, so it runs after it:
    // onTestFinished hooks run last-registered first.
    onTestFinished(() => {
      expect(existsSync(ckptDir)).toBe(false);
    });

    createDeps(runDir).checkpointStore.save(workflowId, checkpoint());
    // A second handle on the same directory schedules nothing twice.
    expect(createCheckpointStore(runDir).load(workflowId)?.machineState).toBe('implement');
    expect(existsSync(ckptDir)).toBe(true);
  });

  // it.fails passes only when its body throws, so nothing in this test can
  // check the cleanup; the afterAll above does. The body fails after the same
  // steps that pass in the test above.
  it.fails('removes the checkpoint directory of a failing test too', () => {
    const runDir = makeRunDir();
    createDeps(runDir).checkpointStore.save(workflowId, checkpoint());
    throw new Error('the test fails after it made its checkpoint directory');
  });

  describe('a store made in beforeEach', () => {
    let runDir = '';

    beforeEach(() => {
      runDir = makeRunDir();
      createCheckpointStore(runDir).save(workflowId, checkpoint());
    });

    it('lasts for its test (the afterAll above checks that it is gone afterwards)', () => {
      expect(existsSync(checkpointDirFor(runDir))).toBe(true);
    });
  });

  describe('outside a running test', () => {
    let refusal: unknown;
    try {
      // Collection time: there is no test whose end could remove the directory.
      checkpointDirFor(join(tmpdir(), 'ckpt-cleanup-test-never-made'));
    } catch (error) {
      refusal = error;
    }

    it('refuses to hand out a checkpoint directory it could not remove', () => {
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toMatch(/must be created while a test runs/);
    });
  });
});
