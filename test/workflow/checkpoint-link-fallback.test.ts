/**
 * `FileCheckpointStore` keeps the replaced checkpoint as checkpoint.prev.json
 * through a hard link. Some filesystems (SMB, several FUSE mounts) have no
 * hard links; the store must then copy the bytes instead of losing the
 * previous copy or failing the save. And when the save itself fails (a full
 * disk), the previous copy must still be a checkpoint resume can use.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';
import { createWorkflowId, type WorkflowCheckpoint } from '../../src/workflow/types.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, linkSync: vi.fn(actual.linkSync), renameSync: vi.fn(actual.renameSync) };
});

function makeCheckpoint(machineState: string): WorkflowCheckpoint {
  return {
    machineState,
    context: {
      taskDescription: 'task',
      artifacts: {},
      round: 0,
      maxRounds: 1,
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
  };
}

describe('FileCheckpointStore without hard links', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = resolve('/tmp', `ironcurtain-checkpoint-nolink-${process.pid}-${Date.now()}`);
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    vi.mocked(linkSync).mockReset();
    vi.mocked(renameSync).mockReset();
  });

  it('copies the previous checkpoint when it cannot be hard-linked', () => {
    const store = new FileCheckpointStore(baseDir, { warn: () => {} });
    const id = createWorkflowId();
    store.save(id, makeCheckpoint('planning'));

    vi.mocked(linkSync).mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    store.save(id, makeCheckpoint('coding'));

    expect(linkSync).toHaveBeenCalled();
    const previous = JSON.parse(
      readFileSync(resolve(baseDir, id, 'checkpoint.prev.json'), 'utf8'),
    ) as WorkflowCheckpoint;
    expect(previous.machineState).toBe('planning');
    expect(store.load(id)?.machineState).toBe('coding');
  });

  it('still recovers from the previous copy when a save after damage fails too', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const store = new FileCheckpointStore(baseDir, { warn: () => {} });
    const id = createWorkflowId();
    store.save(id, makeCheckpoint('planning'));
    store.save(id, makeCheckpoint('coding'));
    // checkpoint.json is damaged; a resume runs from the previous copy.
    writeFileSync(resolve(baseDir, id, 'checkpoint.json'), '{"machineState":');
    expect(store.load(id)?.machineState).toBe('planning');

    // The resumed run's next save fails at the rename (the disk is full).
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(to).endsWith('/checkpoint.json')) {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      }
      actual.renameSync(from, to);
    });
    expect(() => store.save(id, makeCheckpoint('review'))).toThrow();
    vi.mocked(renameSync).mockImplementation(actual.renameSync);

    // The good previous copy was not displaced by the damaged file.
    expect(store.load(id)?.machineState).toBe('planning');
  });
});
