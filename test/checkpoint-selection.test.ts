/**
 * Tests for `findResumableCheckpoints` and `findLatestResumableCheckpoint`
 * in `src/workflow/checkpoint-selection.ts`.
 *
 * These helpers replace duplicate inline scanning logic that previously
 * lived in both `cli-support.selectResumableWorkflow` (CLI resume) and
 * `WorkflowManager.importExternalCheckpoint` (web UI). The test suite
 * exercises the empty/single/multi/completed-only cases plus the
 * newest-first ordering.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { findLatestResumableCheckpoint, findResumableCheckpoints } from '../src/workflow/checkpoint-selection.js';
import { FileCheckpointStore } from '../src/workflow/checkpoint.js';
import type { WorkflowCheckpoint, WorkflowId, WorkflowStatus } from '../src/workflow/types.js';

function makeCheckpoint(opts: { timestamp?: string; finalStatus?: WorkflowStatus } = {}): WorkflowCheckpoint {
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
    timestamp: opts.timestamp ?? new Date().toISOString(),
    transitionHistory: [],
    definitionPath: '/tmp/workflow.json',
    finalStatus: opts.finalStatus,
  };
}

describe('checkpoint-selection', () => {
  let baseDir: string;
  let store: FileCheckpointStore;

  beforeEach(() => {
    baseDir = mkdtempSync(resolve(tmpdir(), 'checkpoint-selection-'));
    store = new FileCheckpointStore(baseDir);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  describe('findResumableCheckpoints', () => {
    it('returns [] for an empty baseDir', () => {
      const result = findResumableCheckpoints(baseDir, store);
      expect(result).toEqual([]);
    });

    it('returns [] when only completed runs exist', () => {
      store.save(
        'completed-run' as WorkflowId,
        makeCheckpoint({
          finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
        }),
      );

      const result = findResumableCheckpoints(baseDir, store);
      expect(result).toEqual([]);
    });

    it('returns a single resumable run', () => {
      const id = 'aborted-run' as WorkflowId;
      store.save(
        id,
        makeCheckpoint({
          finalStatus: { phase: 'aborted', reason: 'user abort' },
        }),
      );

      const result = findResumableCheckpoints(baseDir, store);
      expect(result.length).toBe(1);
      expect(result[0].workflowId).toBe(id);
    });

    it('includes legacy checkpoints with no finalStatus', () => {
      const id = 'legacy-run' as WorkflowId;
      store.save(id, makeCheckpoint({ finalStatus: undefined }));

      const result = findResumableCheckpoints(baseDir, store);
      expect(result.length).toBe(1);
      expect(result[0].workflowId).toBe(id);
      expect(result[0].checkpoint.finalStatus).toBeUndefined();
    });

    it('filters completed runs out of mixed results', () => {
      store.save(
        'completed-run' as WorkflowId,
        makeCheckpoint({
          finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
        }),
      );
      store.save(
        'aborted-run' as WorkflowId,
        makeCheckpoint({
          finalStatus: { phase: 'aborted', reason: 'user abort' },
        }),
      );

      const result = findResumableCheckpoints(baseDir, store);
      expect(result.length).toBe(1);
      expect(result[0].workflowId).toBe('aborted-run');
    });

    it('returns multiple resumable runs sorted newest-first by checkpoint.timestamp', () => {
      const oldestId = 'oldest-run' as WorkflowId;
      const middleId = 'middle-run' as WorkflowId;
      const newestId = 'newest-run' as WorkflowId;

      store.save(
        oldestId,
        makeCheckpoint({
          timestamp: '2026-01-01T00:00:00.000Z',
          finalStatus: { phase: 'aborted', reason: 'oldest' },
        }),
      );
      store.save(
        newestId,
        makeCheckpoint({
          timestamp: '2026-04-23T00:00:00.000Z',
          finalStatus: { phase: 'aborted', reason: 'newest' },
        }),
      );
      store.save(
        middleId,
        makeCheckpoint({
          timestamp: '2026-02-15T00:00:00.000Z',
          finalStatus: { phase: 'aborted', reason: 'middle' },
        }),
      );

      const result = findResumableCheckpoints(baseDir, store);
      expect(result.length).toBe(3);
      expect(result.map((r) => r.workflowId)).toEqual([newestId, middleId, oldestId]);
      // Sanity: timestamps are strictly descending in the result.
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].checkpoint.timestamp > result[i].checkpoint.timestamp).toBe(true);
      }
    });
  });

  describe('damaged and misplaced runs', () => {
    it('skips a run whose checkpoint fails to load instead of failing the whole scan', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        store.save('good-run' as WorkflowId, makeCheckpoint({ finalStatus: { phase: 'aborted', reason: 'x' } }));
        mkdirSync(resolve(baseDir, 'corrupt-run'));
        writeFileSync(resolve(baseDir, 'corrupt-run', 'checkpoint.json'), '{"truncated":');
        mkdirSync(resolve(baseDir, 'newer-run'));
        writeFileSync(
          resolve(baseDir, 'newer-run', 'checkpoint.json'),
          JSON.stringify({ ...makeCheckpoint(), schemaVersion: 99 }),
        );

        const result = findResumableCheckpoints(baseDir, store);
        expect(result.map((r) => r.workflowId)).toEqual(['good-run']);
        const warned = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
        expect(warned).toContain('Skipping corrupt-run');
        expect(warned).toContain('Skipping newer-run');
      } finally {
        stderr.mockRestore();
      }
    });

    it('renders a skipped run reason safe for a terminal', () => {
      // V8 quotes the damaged input in a JSON parse error; a scanned
      // directory may come from anywhere, escape sequences included.
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        mkdirSync(resolve(baseDir, 'hostile-run'));
        writeFileSync(resolve(baseDir, 'hostile-run', 'checkpoint.json'), '{"a": \u001b]0;owned\u0007 x}');
        expect(findResumableCheckpoints(baseDir, store)).toEqual([]);
        const warned = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
        expect(warned).toContain('Skipping hostile-run');
        expect(warned).not.toContain('\u001b');
        expect(warned).not.toContain('\u0007');
      } finally {
        stderr.mockRestore();
      }
    });

    it('refuses a run directory given as the base directory', () => {
      // `<baseDir>/<id>` passed where `<baseDir>` belongs: its workspace is
      // agent-writable, so a checkpoint planted there must never look like a run.
      const runDir = resolve(baseDir, 'some-run');
      store.save('some-run' as WorkflowId, makeCheckpoint());
      mkdirSync(resolve(runDir, 'workspace'), { recursive: true });
      writeFileSync(resolve(runDir, 'workspace', 'checkpoint.json'), JSON.stringify(makeCheckpoint()));

      expect(() => findResumableCheckpoints(runDir, new FileCheckpointStore(runDir))).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_INVALID_BASE_DIR' }),
      );
    });

    it('never offers entries named like a run directory part or that are not run ids', () => {
      for (const name of ['workspace', 'containers', 'workflow-skills', 'has space']) {
        mkdirSync(resolve(baseDir, name), { recursive: true });
        writeFileSync(resolve(baseDir, name, 'checkpoint.json'), JSON.stringify(makeCheckpoint()));
      }
      expect(findResumableCheckpoints(baseDir, store)).toEqual([]);
    });
  });

  describe('findLatestResumableCheckpoint', () => {
    it('returns undefined for an empty baseDir', () => {
      expect(findLatestResumableCheckpoint(baseDir, store)).toBeUndefined();
    });

    it('returns undefined when only completed runs exist', () => {
      store.save(
        'completed-run' as WorkflowId,
        makeCheckpoint({
          finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
        }),
      );
      expect(findLatestResumableCheckpoint(baseDir, store)).toBeUndefined();
    });

    it('returns the most-recent resumable run when multiple exist', () => {
      const olderId = 'older-run' as WorkflowId;
      const newerId = 'newer-run' as WorkflowId;

      store.save(
        olderId,
        makeCheckpoint({
          timestamp: '2026-01-01T00:00:00.000Z',
          finalStatus: { phase: 'aborted', reason: 'older' },
        }),
      );
      store.save(
        newerId,
        makeCheckpoint({
          timestamp: '2026-04-01T00:00:00.000Z',
          finalStatus: { phase: 'aborted', reason: 'newer' },
        }),
      );

      const latest = findLatestResumableCheckpoint(baseDir, store);
      expect(latest).toBeDefined();
      expect(latest?.workflowId).toBe(newerId);
      expect(latest?.checkpoint.timestamp).toBe('2026-04-01T00:00:00.000Z');
    });

    it('returns the single resumable run when only one exists', () => {
      const id = 'only-run' as WorkflowId;
      store.save(id, makeCheckpoint({ finalStatus: { phase: 'aborted', reason: 'only' } }));

      const latest = findLatestResumableCheckpoint(baseDir, store);
      expect(latest).toBeDefined();
      expect(latest?.workflowId).toBe(id);
    });
  });
});
