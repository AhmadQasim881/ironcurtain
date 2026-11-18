/**
 * Tests for WorkflowManager.loadPastRun.
 *
 * Covers happy path (live and not-live, checkpointed and checkpoint-less),
 * not_found (empty directory, unknown workflowId, no-checkpoint + no-def),
 * and corruption paths (malformed checkpoint JSON, malformed definition
 * JSON, schema-invalid definition).
 *
 * `createWorkflowSessionFactory` is mocked because it would otherwise
 * call `loadConfig()` and read the user's real config — heavy and not
 * relevant to the disk-loading logic under test. The mock returns a
 * stub session factory that the orchestrator never invokes during
 * `loadPastRun`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Mock the session factory before importing WorkflowManager. The real
// implementation calls loadConfig() which reads ~/.ironcurtain/config.json
// and is irrelevant to the disk-loading paths we exercise here. We retain
// the real `isCheckpointResumable` predicate (pure, trivial, no I/O) so that
// `importExternalCheckpoint` still exercises the genuine phase filter.
vi.mock('../src/workflow/cli-support.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workflow/cli-support.js')>();
  return {
    ...actual,
    createWorkflowSessionFactory: () => () => Promise.reject(new Error('session factory not used in tests')),
  };
});

import { WorkflowManager, WorkflowManagerClosedError } from '../src/workflow/workflow-manager.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import { claimWorkflowRunLock, isWorkflowRunLockHeld } from '../src/workflow/run-lock.js';
import { emptyWorkflowUsage } from '../src/workflow/workflow-usage.js';
import type { WorkflowId, WorkflowCheckpoint, WorkflowContext, WorkflowDefinition } from '../src/workflow/types.js';
import { fifoSupported, makeFifo, startFifoUnblocker } from './helpers/fifo.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeContext(taskDescription: string): WorkflowContext {
  return {
    taskDescription,
    artifacts: {},
    round: 1,
    maxRounds: 4,
    previousOutputHashes: {},
    previousTestCount: null,
    humanPrompt: null,
    reviewHistory: [],
    totalTokens: 1000,
    lastError: null,
    agentConversationsByState: {},
    previousAgentOutput: null,
    previousAgentNotes: null,
    previousStateName: null,
    visitCounts: {},
  };
}

function makeCheckpoint(overrides: Partial<WorkflowCheckpoint> = {}): WorkflowCheckpoint {
  return {
    machineState: 'plan',
    context: makeContext('Test task'),
    timestamp: new Date().toISOString(),
    transitionHistory: [],
    definitionPath: '/tmp/test-def.json',
    ...overrides,
  };
}

/**
 * Minimal but schema-valid workflow definition. Uses a single terminal state
 * so semantic validation (initial-state-exists, reachability) passes without
 * needing transitions or guards.
 */
function makeValidDefinition(): WorkflowDefinition {
  return {
    name: 'test-flow',
    description: 'A minimal valid workflow for testing',
    initial: 'done',
    states: {
      done: {
        type: 'terminal',
        description: 'Terminal state',
      },
    },
  };
}

/** A valid definition whose deterministic state runs a command on the host. */
function makeHostDefinition(): WorkflowDefinition {
  return {
    name: 'host-flow',
    description: 'Runs a host command',
    initial: 'build',
    settings: { mode: 'builtin' },
    states: {
      build: {
        type: 'deterministic',
        description: 'Builds on the host',
        run: [['make']],
        host: true,
        transitions: [{ to: 'done' }],
      },
      done: { type: 'terminal', description: 'Done' },
    },
  };
}

/**
 * A definition recorded before a shared-container scope needed one persona
 * (or `allowMixedPersonas: true`), which also runs a host command.
 */
function makeMixedPersonaHostDefinition(): WorkflowDefinition {
  return {
    name: 'mixed-persona-host-flow',
    description: 'Two personas share the primary scope, then a host build',
    initial: 'read',
    settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
    states: {
      read: {
        type: 'agent',
        description: 'Reads untrusted input',
        persona: 'reader',
        prompt: 'Read.',
        inputs: [],
        outputs: ['notes'],
        transitions: [{ to: 'review' }],
      },
      review: {
        type: 'agent',
        description: 'Acts with a broader policy',
        persona: 'reviewer',
        prompt: 'Review.',
        inputs: ['notes'],
        outputs: ['report'],
        transitions: [{ to: 'build' }],
      },
      build: {
        type: 'deterministic',
        description: 'Builds on the host',
        run: [['make']],
        host: true,
        transitions: [{ to: 'done' }],
      },
      done: { type: 'terminal', description: 'Done' },
    },
  };
}

/** Writes both a checkpoint and a valid definition.json under {baseDir}/{id}/. */
function seedRun(baseDir: string, workflowId: WorkflowId, checkpoint: WorkflowCheckpoint): void {
  const runDir = resolve(baseDir, workflowId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(resolve(runDir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));
  writeFileSync(resolve(runDir, 'definition.json'), JSON.stringify(makeValidDefinition(), null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowManager.loadPastRun', () => {
  let tmpHome: string;
  let baseDir: string;
  let manager: WorkflowManager;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = resolve(tmpdir(), `ic-test-wfm-${randomUUID()}`);
    mkdirSync(tmpHome, { recursive: true });
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = tmpHome;
    // baseDir matches what WorkflowManager.getBaseDir() will compute.
    baseDir = resolve(tmpHome, 'workflow-runs');
    manager = new WorkflowManager({ eventBus: new WebEventBus() });
  });

  afterEach(async () => {
    await manager.shutdown();
    if (originalHome === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalHome;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('happy path', () => {
    it('loads a valid past run with isLive=false when not active', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      const checkpoint = makeCheckpoint({ machineState: 'reviewing' });
      seedRun(baseDir, id, checkpoint);

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(false);
      if ('error' in result) return; // type narrow
      expect(result.checkpoint).toBeDefined();
      expect(result.checkpoint?.machineState).toBe('reviewing');
      expect(result.checkpoint?.context.taskDescription).toBe('Test task');
      expect(result.definition.name).toBe('test-flow');
      expect(result.definition.initial).toBe('done');
      expect(result.isLive).toBe(false);
      // messageLogPath is always returned (existence unchecked).
      expect(result.messageLogPath).toBe(resolve(baseDir, id, 'messages.jsonl'));
    });

    it('still loads a past run recorded before host deterministic states needed host: true', () => {
      // Displaying a run executes nothing, so a run recorded without the
      // acknowledgement must not vanish from `workflow inspect` and the web
      // UI. Resuming it still fails validation (orchestrator.resume).
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'checkpoint.json'), JSON.stringify(makeCheckpoint({ machineState: 'check' })));
      writeFileSync(
        resolve(runDir, 'definition.json'),
        JSON.stringify({
          name: 'host-flow',
          description: 'Recorded with a host deterministic state and no host: true',
          initial: 'check',
          settings: { mode: 'builtin' },
          states: {
            check: {
              type: 'deterministic',
              description: 'Runs the tests on the host',
              run: [['npm', 'test']],
              transitions: [{ to: 'done' }],
            },
            done: { type: 'terminal', description: 'Done' },
          },
        }),
      );

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.definition.name).toBe('host-flow');
      expect(result.checkpoint?.machineState).toBe('check');
    });

    it('still loads a past run recorded before a shared scope needed one persona or allowMixedPersonas', () => {
      // Same display-only reasoning: a run of a workflow that mixed personas
      // in one shared-container scope before the rule existed (the bundled
      // test-email-summary did) must stay visible. Resuming it still fails
      // validation (orchestrator.resume).
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'checkpoint.json'), JSON.stringify(makeCheckpoint({ machineState: 'review' })));
      writeFileSync(
        resolve(runDir, 'definition.json'),
        JSON.stringify({
          name: 'mixed-persona-flow',
          description: 'Recorded with two personas in one shared scope and no allowMixedPersonas',
          initial: 'read',
          settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
          states: {
            read: {
              type: 'agent',
              description: 'Reads untrusted input',
              persona: 'reader',
              prompt: 'Read.',
              inputs: [],
              outputs: ['notes'],
              transitions: [{ to: 'review' }],
            },
            review: {
              type: 'agent',
              description: 'Acts with a broader policy',
              persona: 'reviewer',
              prompt: 'Review.',
              inputs: ['notes'],
              outputs: ['report'],
              transitions: [{ to: 'done' }],
            },
            done: { type: 'terminal', description: 'Done' },
          },
        }),
      );

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.definition.name).toBe('mixed-persona-flow');
      expect(result.definition.settings?.allowMixedPersonas).toBeUndefined();
      expect(result.checkpoint?.machineState).toBe('review');
    });

    it('loads a run with no checkpoint but a local definition.json', () => {
      // A directory that has only definition.json -- models the
      // "completed-pre-retention" case where checkpoint.json was deleted
      // but the definition copy remains. loadPastRun must succeed with
      // checkpoint=undefined so the dispatch layer can synthesize the DTO
      // from the definition + message log.
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'definition.json'), JSON.stringify(makeValidDefinition(), null, 2));

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.checkpoint).toBeUndefined();
      expect(result.definition.name).toBe('test-flow');
      expect(result.messageLogPath).toBe(resolve(baseDir, id, 'messages.jsonl'));
      expect(result.isLive).toBe(false);
    });

    it('loads a run with definition.json and messages.jsonl but no checkpoint', () => {
      // messageLogPath points at the on-disk log even though loadPastRun
      // itself does not read or validate it (callers use MessageLog.readAll
      // on demand; existence is not required).
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'definition.json'), JSON.stringify(makeValidDefinition(), null, 2));
      const logPath = resolve(runDir, 'messages.jsonl');
      // One arbitrary message log line -- the loader should not parse it.
      writeFileSync(logPath, '{"ts":"2026-04-23T00:00:00.000Z","kind":"state_transition","from":"plan","to":"done"}\n');

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.checkpoint).toBeUndefined();
      expect(result.definition.name).toBe('test-flow');
      expect(result.messageLogPath).toBe(logPath);
      expect(result.isLive).toBe(false);
    });

    it('returns isLive=true when the workflow is in controller.listActive()', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      seedRun(baseDir, id, makeCheckpoint());

      // Force the orchestrator into existence and stub listActive() to claim
      // this workflow is live. Using a spy avoids needing to actually start
      // a workflow (which would require Docker, sessions, etc.).
      const controller = manager.getOrchestrator();
      vi.spyOn(controller, 'listActive').mockReturnValue([id]);

      const result = manager.loadPastRun(id);
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.isLive).toBe(true);
      expect(result.runningElsewhere).toBe(false);
    });

    it('reports runningElsewhere while another holder owns the run lock', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      seedRun(baseDir, id, makeCheckpoint());
      // The holder stands in for another process (the lock is not re-entrant,
      // so this process counts as a different holder than the manager).
      const held = claimWorkflowRunLock(baseDir, id);
      try {
        const result = manager.loadPastRun(id);
        expect('error' in result).toBe(false);
        if ('error' in result) return;
        expect(result.isLive).toBe(false);
        expect(result.runningElsewhere).toBe(true);
      } finally {
        held.release();
      }

      const released = manager.loadPastRun(id);
      expect('error' in released || released.runningElsewhere).toBe(false);
    });

    it('falls back to checkpoint.definitionPath when no local definition.json exists', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      // Write definition somewhere outside baseDir/{id}/
      const externalDefPath = resolve(tmpHome, 'external-def.json');
      writeFileSync(externalDefPath, JSON.stringify(makeValidDefinition(), null, 2));

      // Seed only the checkpoint -- no local definition.json copy.
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      const checkpoint = makeCheckpoint({ definitionPath: externalDefPath });
      writeFileSync(resolve(runDir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));

      const result = manager.loadPastRun(id);
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.definition.name).toBe('test-flow');
    });

    it('shows the workspace where a moved run directory is now', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      seedRun(baseDir, id, makeCheckpoint({ workspacePath: `/old/home/.ironcurtain/workflow-runs/${id}/workspace` }));

      const result = manager.loadPastRun(id);
      if ('error' in result) throw new Error(result.message);
      expect(result.checkpoint?.workspacePath).toBe(resolve(baseDir, id, 'workspace'));
    });
  });

  describe('too_new', () => {
    it('reports a checkpoint or definition copy written in a newer format', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      seedRun(baseDir, id, makeCheckpoint());
      const checkpointPath = resolve(baseDir, id, 'checkpoint.json');
      const original = readFileSync(checkpointPath, 'utf8');
      writeFileSync(checkpointPath, JSON.stringify({ ...JSON.parse(original), schemaVersion: 99 }));
      expect(manager.loadPastRun(id)).toMatchObject({ error: 'too_new' });

      writeFileSync(checkpointPath, original);
      const definitionPath = resolve(baseDir, id, 'definition.json');
      writeFileSync(definitionPath, JSON.stringify({ ...makeValidDefinition(), schemaVersion: 99 }));
      expect(manager.loadPastRun(id)).toMatchObject({ error: 'too_new' });
    });
  });

  describe('workflow ids', () => {
    it('never builds a path from an id that is not one path segment', () => {
      const outside = resolve(tmpHome, 'outside');
      seedRun(tmpHome, 'outside' as WorkflowId, makeCheckpoint());
      expect(existsSync(resolve(outside, 'checkpoint.json'))).toBe(true);
      expect(manager.loadPastRun('../outside' as WorkflowId)).toMatchObject({ error: 'not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // not_found
  // -------------------------------------------------------------------------

  describe('not_found', () => {
    it('returns not_found for a workflowId with nothing on disk', () => {
      // Nonexistent directory: no checkpoint and no definition to fall back
      // on, so nothing worth rendering. After B5 the discriminant is
      // "directory doesn't exist OR no loadable definition"; the end result
      // for a completely unknown id is still not_found.
      const result = manager.loadPastRun(`wf-${randomUUID()}` as WorkflowId);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('not_found');
    });

    it('returns not_found even if other workflows exist on disk', () => {
      // Seed an unrelated checkpoint.
      seedRun(baseDir, `wf-${randomUUID()}` as WorkflowId, makeCheckpoint());

      const result = manager.loadPastRun(`wf-${randomUUID()}` as WorkflowId);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('not_found');
    });

    it('returns not_found for an empty run directory', () => {
      // Directory exists but has neither checkpoint.json nor definition.json.
      // Under the relaxed B5 contract this is the canonical "nothing to
      // render" case -- checkpoint-less would otherwise try to proceed, but
      // the definition resolver has no file to load.
      const id = `wf-${randomUUID()}` as WorkflowId;
      mkdirSync(resolve(baseDir, id), { recursive: true });

      const result = manager.loadPastRun(id);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('not_found');
    });
  });

  // -------------------------------------------------------------------------
  // corrupted
  // -------------------------------------------------------------------------

  describe('corrupted', () => {
    it('returns corrupted with a message when checkpoint JSON is malformed', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'checkpoint.json'), '{ this is : not valid json');
      // Definition is fine; the error is in the checkpoint.
      writeFileSync(resolve(runDir, 'definition.json'), JSON.stringify(makeValidDefinition()));

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('corrupted');
      expect(result.message).toBeDefined();
      expect(result.message).toContain(id);
    });

    it('returns corrupted with a message when definition JSON is malformed', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'checkpoint.json'), JSON.stringify(makeCheckpoint()));
      writeFileSync(resolve(runDir, 'definition.json'), '{ broken json');

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('corrupted');
      expect(result.message).toBeDefined();
      expect(result.message).toContain('definition');
    });

    it('returns corrupted when the definition fails schema validation', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'checkpoint.json'), JSON.stringify(makeCheckpoint()));
      // Parses as JSON but fails Zod (missing required `initial`, `states`).
      writeFileSync(resolve(runDir, 'definition.json'), JSON.stringify({ name: 'incomplete' }));

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('corrupted');
      expect(result.message).toBeDefined();
    });

    it('returns not_found when the definition file is missing entirely', () => {
      // Post-B5: a checkpoint whose definitionPath is gone and with no
      // local definition.json copy is "no renderable content" rather than
      // "corrupted file." `corrupted` is now reserved strictly for
      // present-but-malformed files.
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      // Checkpoint points to a definitionPath that does not exist, and there
      // is no local definition.json copy.
      const checkpoint = makeCheckpoint({ definitionPath: resolve(tmpHome, 'does-not-exist.json') });
      writeFileSync(resolve(runDir, 'checkpoint.json'), JSON.stringify(checkpoint));

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('not_found');
      expect(result.message).toContain('missing');
    });

    it('does not throw on a corrupted file', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'checkpoint.json'), 'totally not json');

      expect(() => manager.loadPastRun(id)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // baseDirOverride
  // -------------------------------------------------------------------------

  describe('baseDirOverride', () => {
    it('reads checkpoints from the override directory instead of IRONCURTAIN_HOME', async () => {
      // Seed a checkpoint in a directory unrelated to IRONCURTAIN_HOME, then
      // confirm a manager with `baseDirOverride` set to that path can load it
      // even though `IRONCURTAIN_HOME` points elsewhere. Used by `workflow
      // inspect` to operate on user-supplied baseDir arguments.
      const externalBase = resolve(tmpdir(), `ic-test-wfm-ext-${randomUUID()}`);
      mkdirSync(externalBase, { recursive: true });
      try {
        const id = `wf-${randomUUID()}` as WorkflowId;
        seedRun(externalBase, id, makeCheckpoint({ machineState: 'external' }));

        const externalManager = new WorkflowManager({
          eventBus: new WebEventBus(),
          baseDirOverride: externalBase,
        });

        try {
          const result = externalManager.loadPastRun(id);
          expect('error' in result).toBe(false);
          if ('error' in result) return;
          expect(result.checkpoint?.machineState).toBe('external');

          // The default-baseDir manager should NOT see this run.
          const sameIdInDefault = manager.loadPastRun(id);
          expect('error' in sameIdInDefault).toBe(true);
          if (!('error' in sameIdInDefault)) return;
          expect(sameIdInDefault.error).toBe('not_found');
        } finally {
          await externalManager.shutdown();
        }
      } finally {
        rmSync(externalBase, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// importExternalCheckpoint
// ---------------------------------------------------------------------------

/**
 * Writes a checkpoint and the run's definition copy under {baseDir}/{id}/.
 * An import needs a loadable definition (it is checked for host commands
 * before anything is copied), so every importable run has one.
 */
function seedCheckpointOnly(baseDir: string, workflowId: WorkflowId, checkpoint: WorkflowCheckpoint): void {
  seedRun(baseDir, workflowId, checkpoint);
}

describe('WorkflowManager.importExternalCheckpoint', () => {
  let tmpHome: string;
  let externalBase: string;
  let manager: WorkflowManager;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = resolve(tmpdir(), `ic-test-wfm-import-${randomUUID()}`);
    mkdirSync(tmpHome, { recursive: true });
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = tmpHome;

    externalBase = resolve(tmpdir(), `ic-test-wfm-import-ext-${randomUUID()}`);
    mkdirSync(externalBase, { recursive: true });

    manager = new WorkflowManager({ eventBus: new WebEventBus() });
  });

  afterEach(async () => {
    await manager.shutdown();
    if (originalHome === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalHome;
    }
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(externalBase, { recursive: true, force: true });
  });

  it('skips completed checkpoints and imports the most-recent non-completed one', () => {
    const completedId = `wf-completed-${randomUUID()}` as WorkflowId;
    const abortedId = `wf-aborted-${randomUUID()}` as WorkflowId;

    // Completed run with the newer timestamp — must be skipped.
    seedCheckpointOnly(
      externalBase,
      completedId,
      makeCheckpoint({
        timestamp: '2026-04-23T12:00:00.000Z',
        finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
      }),
    );

    // Aborted run with an older timestamp — must be selected because the
    // completed one is filtered out even though it is "most recent."
    seedCheckpointOnly(
      externalBase,
      abortedId,
      makeCheckpoint({
        timestamp: '2026-04-20T12:00:00.000Z',
        finalStatus: { phase: 'aborted', reason: 'user cancelled' },
      }),
    );

    const imported = manager.importExternalCheckpoint(externalBase);
    expect(imported).toBe(abortedId);
  });

  it('throws when every external checkpoint is completed', () => {
    seedCheckpointOnly(
      externalBase,
      `wf-${randomUUID()}` as WorkflowId,
      makeCheckpoint({
        finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
      }),
    );

    expect(() => manager.importExternalCheckpoint(externalBase)).toThrow(/No valid checkpoints found/);
  });

  it('still imports a legacy checkpoint without finalStatus', () => {
    // Pre-B3b retained checkpoints (aborted/failed runs from before the
    // finalStatus field was added) carry no finalStatus. The resumable
    // predicate must treat these as importable.
    const legacyId = `wf-legacy-${randomUUID()}` as WorkflowId;
    seedCheckpointOnly(externalBase, legacyId, makeCheckpoint({ timestamp: '2026-01-01T00:00:00.000Z' }));

    const imported = manager.importExternalCheckpoint(externalBase);
    expect(imported).toBe(legacyId);
  });

  it('throws when the external baseDir has no checkpoints at all', () => {
    // Empty directory — no subdirectories, no checkpoint.json anywhere.
    expect(() => manager.importExternalCheckpoint(externalBase)).toThrow(/No checkpoints found/);
  });

  it('explicit targetId bypass still imports regardless of phase', () => {
    // Import is also useful independently for archived-run inspection. The
    // orchestrator, not the copy operation, rejects an attempt to resume it.
    const completedId = `wf-completed-${randomUUID()}` as WorkflowId;
    seedCheckpointOnly(
      externalBase,
      completedId,
      makeCheckpoint({
        finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
      }),
    );

    const imported = manager.importExternalCheckpoint(externalBase, completedId);
    expect(imported).toBe(completedId);
  });

  it('refuses a run that is running in another process', () => {
    const id = `wf-live-${randomUUID()}` as WorkflowId;
    seedCheckpointOnly(externalBase, id, makeCheckpoint());
    const held = claimWorkflowRunLock(externalBase, id);
    try {
      expect(() => manager.importExternalCheckpoint(externalBase, id)).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_ALREADY_ACTIVE' }),
      );
      // Selecting the latest run skips a live one.
      expect(() => manager.importExternalCheckpoint(externalBase)).toThrow(/running in another process are skipped/);
      expect(existsSync(resolve(tmpHome, 'workflow-runs', id, 'checkpoint.json'))).toBe(false);
    } finally {
      held.release();
    }
    expect(manager.importExternalCheckpoint(externalBase)).toBe(id);
  });

  it('never overwrites a run that another process runs in the local base directory', () => {
    // A CLI `workflow start` shares the daemon's workflow-runs directory: the
    // same id is live there, its run lock held by that process.
    const id = `wf-local-live-${randomUUID()}` as WorkflowId;
    const localRunDir = resolve(tmpHome, 'workflow-runs', id);
    seedRun(resolve(tmpHome, 'workflow-runs'), id, makeCheckpoint({ machineState: 'live-state' }));
    const localBytes = readFileSync(resolve(localRunDir, 'checkpoint.json'), 'utf8');
    const localDefinition = readFileSync(resolve(localRunDir, 'definition.json'), 'utf8');
    seedRun(externalBase, id, makeCheckpoint({ machineState: 'stale-copy' }));
    writeFileSync(
      resolve(externalBase, id, 'definition.json'),
      JSON.stringify({ ...makeValidDefinition(), description: 'the external copy' }),
    );

    const held = claimWorkflowRunLock(resolve(tmpHome, 'workflow-runs'), id);
    try {
      expect(() => manager.importExternalCheckpoint(externalBase, id)).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_ALREADY_ACTIVE' }),
      );
      expect(readFileSync(resolve(localRunDir, 'checkpoint.json'), 'utf8')).toBe(localBytes);
      expect(readFileSync(resolve(localRunDir, 'definition.json'), 'utf8')).toBe(localDefinition);
    } finally {
      held.release();
    }

    // Releasing the lock does not authorize replacing this existing run.
    expect(() => manager.importExternalCheckpoint(externalBase, id)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_NOT_RESUMABLE', message: expect.stringContaining('already exists') }),
    );
    expect(readFileSync(resolve(localRunDir, 'checkpoint.json'), 'utf8')).toBe(localBytes);
    expect(readFileSync(resolve(localRunDir, 'definition.json'), 'utf8')).toBe(localDefinition);
    expect(isWorkflowRunLockHeld(resolve(tmpHome, 'workflow-runs'), id)).toBe(false);
  });

  it('refuses repeat import before replacing an existing definition or staged file', () => {
    const id = `wf-repeat-${randomUUID()}` as WorkflowId;
    const sourceScripts = resolve(externalBase, id, 'workflow-scripts');
    seedRun(externalBase, id, makeCheckpoint({ workflowScriptsDir: sourceScripts }));
    mkdirSync(sourceScripts);
    writeFileSync(resolve(sourceScripts, 'example.txt'), 'original staged fixture');
    manager.importExternalCheckpoint(externalBase, id);
    const localRun = resolve(tmpHome, 'workflow-runs', id);
    const originalDefinition = readFileSync(resolve(localRun, 'definition.json'), 'utf8');
    writeFileSync(
      resolve(externalBase, id, 'definition.json'),
      JSON.stringify({
        ...makeValidDefinition(),
        description: 'updated external definition',
      }),
    );
    writeFileSync(resolve(sourceScripts, 'example.txt'), 'updated staged fixture');
    let failure: unknown;
    try {
      manager.importExternalCheckpoint(externalBase, id);
    } catch (error) {
      failure = error;
    }
    expect(readFileSync(resolve(localRun, 'definition.json'), 'utf8')).toBe(originalDefinition);
    expect(readFileSync(resolve(localRun, 'workflow-scripts', 'example.txt'), 'utf8')).toBe('original staged fixture');
    expect(failure).toMatchObject({
      code: 'WORKFLOW_NOT_RESUMABLE',
      message: expect.stringContaining('already exists'),
    });
  });

  it('writes nothing outside the base directory for an id that is not one path segment', () => {
    // A crafted id `../<name>` that does reach a checkpoint (one next to the
    // external directory) must not be copied to `<home>/<name>`.
    const name = `escaped-import-${randomUUID()}`;
    seedCheckpointOnly(dirname(externalBase), name as WorkflowId, makeCheckpoint());
    try {
      expect(() => manager.importExternalCheckpoint(externalBase, `../${name}`)).toThrow(/Invalid workflow ID/);
      expect(existsSync(resolve(tmpHome, name))).toBe(false);
    } finally {
      rmSync(resolve(dirname(externalBase), name), { recursive: true, force: true });
    }
  });

  it('refuses a run directory given as the base directory and writes nothing', () => {
    // `workflow resume <runDir>`: the run's workspace is agent-writable, and a
    // checkpoint planted there must never be imported as a run.
    const runDir = resolve(externalBase, 'real-run');
    seedRun(externalBase, 'real-run' as WorkflowId, makeCheckpoint());
    seedRun(runDir, 'workspace' as WorkflowId, makeCheckpoint({ machineState: 'planted' }));

    for (const id of [undefined, 'workspace']) {
      expect(() => manager.importExternalCheckpoint(runDir, id)).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_INVALID_BASE_DIR' }),
      );
    }
    expect(existsSync(resolve(tmpHome, 'workflow-runs', 'workspace'))).toBe(false);
  });

  it('requires trust to import a definition that runs commands on the host', () => {
    const id = `wf-host-${randomUUID()}` as WorkflowId;
    seedRun(externalBase, id, makeCheckpoint({ machineState: 'build' }));
    writeFileSync(resolve(externalBase, id, 'definition.json'), JSON.stringify(makeHostDefinition()));
    const localRunDir = resolve(tmpHome, 'workflow-runs', id);

    expect(() => manager.importExternalCheckpoint(externalBase, id)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_IMPORT_UNTRUSTED', message: expect.stringContaining('build') }),
    );
    expect(existsSync(resolve(localRunDir, 'checkpoint.json'))).toBe(false);
    expect(existsSync(resolve(localRunDir, 'definition.json'))).toBe(false);

    expect(manager.importExternalCheckpoint(externalBase, id, { trust: true })).toBe(id);
    expect(JSON.parse(readFileSync(resolve(localRunDir, 'definition.json'), 'utf8'))).toMatchObject({
      name: 'host-flow',
      schemaVersion: expect.any(Number),
    });
  });

  it('requires a run-local definition instead of opening an original package from the checkpoint', () => {
    const id = `wf-host-original-${randomUUID()}` as WorkflowId;
    const original = resolve(externalBase, 'host-flow.json');
    writeFileSync(original, JSON.stringify(makeHostDefinition()));
    seedRun(externalBase, id, makeCheckpoint({ machineState: 'build', definitionPath: original }));
    rmSync(resolve(externalBase, id, 'definition.json'));

    expect(() => manager.importExternalCheckpoint(externalBase, id)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_CHECKPOINT_CORRUPTED', message: expect.stringContaining('run-local') }),
    );
    expect(() => manager.importExternalCheckpoint(externalBase, id, { trust: true })).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_CHECKPOINT_CORRUPTED' }),
    );
  });

  it.skipIf(!fifoSupported)(
    'refuses, without blocking, a definition the checkpoint names that is a FIFO (FU-07)',
    () => {
      // The external directory can ship the file its checkpoint names: a FIFO
      // there used to block the daemon's event loop on the definition read.
      const id = `wf-fifo-definition-${randomUUID()}` as WorkflowId;
      const fifo = resolve(externalBase, 'workflow.yaml');
      makeFifo(fifo);
      seedRun(externalBase, id, makeCheckpoint({ definitionPath: fifo }));
      rmSync(resolve(externalBase, id, 'definition.json'));

      const unblocker = startFifoUnblocker(fifo, 5);
      const started = Date.now();
      try {
        expect(() => manager.importExternalCheckpoint(externalBase, id)).toThrow(
          expect.objectContaining({
            code: 'WORKFLOW_CHECKPOINT_CORRUPTED',
            message: expect.stringContaining('run-local'),
          }),
        );
      } finally {
        unblocker.stop();
      }
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(existsSync(resolve(tmpHome, 'workflow-runs', id, 'checkpoint.json'))).toBe(false);
    },
  );

  it.skipIf(!fifoSupported)('refuses, without blocking, a run whose run lock is a FIFO (FU-07)', () => {
    // The run lock is read from the external directory before the definition
    // is: a FIFO at run.lock used to block the daemon's event loop on that
    // read. It now counts as held (never opened, never reclaimed).
    const id = `wf-fifo-lock-${randomUUID()}` as WorkflowId;
    seedRun(externalBase, id, makeCheckpoint());
    const lock = resolve(externalBase, id, 'run.lock');
    makeFifo(lock);

    const unblocker = startFifoUnblocker(lock, 5);
    const started = Date.now();
    try {
      expect(() => manager.importExternalCheckpoint(externalBase, id)).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_ALREADY_ACTIVE' }),
      );
      // Selecting the latest run skips it the same way.
      expect(() => manager.importExternalCheckpoint(externalBase)).toThrow(/running in another process are skipped/);
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(existsSync(resolve(tmpHome, 'workflow-runs', id, 'checkpoint.json'))).toBe(false);
  });

  it('imports a run recorded before a shared scope needed one persona, and still requires trust for its host commands', () => {
    // Display-grade validation, as for a host state without host: true: the
    // run is imported (resume validates it fully) and its host commands are
    // recognised instead of the import failing as corrupted.
    const id = `wf-mixed-${randomUUID()}` as WorkflowId;
    seedRun(externalBase, id, makeCheckpoint({ machineState: 'read' }));
    writeFileSync(resolve(externalBase, id, 'definition.json'), JSON.stringify(makeMixedPersonaHostDefinition()));

    expect(() => manager.importExternalCheckpoint(externalBase, id)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_IMPORT_UNTRUSTED', message: expect.stringContaining('build') }),
    );
    expect(manager.importExternalCheckpoint(externalBase, id, { trust: true })).toBe(id);
    expect(JSON.parse(readFileSync(resolve(tmpHome, 'workflow-runs', id, 'definition.json'), 'utf8'))).toMatchObject({
      name: 'mixed-persona-host-flow',
    });
  });

  it("keeps the run's usage and task scope", () => {
    // Dropping them would let the resumed run start its run-wide usage (and
    // its settings.workflowBudget ceiling) over, and run without the task
    // scope that narrowed its policy. Resume re-validates the scope.
    const id = `wf-usage-scope-${randomUUID()}` as WorkflowId;
    const usage = {
      ...emptyWorkflowUsage(),
      inputTokens: 5000,
      outputTokens: 700,
      totalTokens: 5700,
      estimatedCostUsd: 1.25,
    };
    const taskPolicyDir = resolve(tmpHome, 'task-policies', 'scope-key');
    seedRun(externalBase, id, makeCheckpoint({ usage, taskPolicyDir }));

    manager.importExternalCheckpoint(externalBase, id);
    const imported = JSON.parse(
      readFileSync(resolve(tmpHome, 'workflow-runs', id, 'checkpoint.json'), 'utf8'),
    ) as WorkflowCheckpoint;
    expect(imported.usage).toEqual(usage);
    expect(imported.taskPolicyDir).toBe(taskPolicyDir);
  });

  it('validates the imported workspace', () => {
    const missingId = `wf-missing-ws-${randomUUID()}` as WorkflowId;
    seedRun(externalBase, missingId, makeCheckpoint({ workspacePath: resolve(externalBase, 'gone') }));
    expect(() => manager.importExternalCheckpoint(externalBase, missingId)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_WORKSPACE_MISSING' }),
    );

    const unsafeId = `wf-unsafe-ws-${randomUUID()}` as WorkflowId;
    seedRun(externalBase, unsafeId, makeCheckpoint({ workspacePath: tmpHome }));
    expect(() => manager.importExternalCheckpoint(externalBase, unsafeId)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_NOT_RESUMABLE', message: expect.stringContaining('validation') }),
    );
    expect(existsSync(resolve(tmpHome, 'workflow-runs', unsafeId, 'checkpoint.json'))).toBe(false);
  });

  it("keeps using the external run's own workspace, rebased when that directory moved", () => {
    const id = `wf-moved-ext-${randomUUID()}` as WorkflowId;
    // Recorded under a base directory that no longer exists; the run (with
    // its workspace) now lives in externalBase.
    seedRun(
      externalBase,
      id,
      makeCheckpoint({
        workspacePath: `/gone/elsewhere/workflow-runs/${id}/workspace`,
        workflowSkillsDir: `/gone/elsewhere/workflow-runs/${id}/workflow-skills`,
        workflowScriptsDir: '/home/someone/.ssh',
        containerSnapshots: { primary: { image: `sha256:${'a'.repeat(64)}` } },
      }),
    );
    mkdirSync(resolve(externalBase, id, 'workspace'));
    mkdirSync(resolve(externalBase, id, 'workflow-skills'));

    manager.importExternalCheckpoint(externalBase, id);
    const imported = JSON.parse(
      readFileSync(resolve(tmpHome, 'workflow-runs', id, 'checkpoint.json'), 'utf8'),
    ) as WorkflowCheckpoint;
    expect(imported.workspacePath).toBe(realpathSync(resolve(externalBase, id, 'workspace')));
    expect(imported.workflowSkillsDir).toBe(realpathSync(resolve(tmpHome, 'workflow-runs', id, 'workflow-skills')));
    // Paths outside the external run and snapshot image references are not imported.
    expect(imported.workflowScriptsDir).toBeUndefined();
    expect(imported.containerSnapshots).toBeUndefined();
    expect(imported.runDir).toBe(resolve(tmpHome, 'workflow-runs', id));
  });

  it('drops a staged directory that is a symlink or missing, even when it is named inside the external run', () => {
    // An agent that wrote the external directory could point the staged
    // scripts (bind-mounted into its container) at a host directory.
    const id = `wf-staged-link-${randomUUID()}` as WorkflowId;
    const runDir = resolve(externalBase, id);
    const hostSecrets = resolve(externalBase, 'host-secrets');
    mkdirSync(hostSecrets);
    seedRun(
      externalBase,
      id,
      makeCheckpoint({
        workflowScriptsDir: resolve(runDir, 'workflow-scripts'),
        workflowSkillsDir: resolve(runDir, 'workflow-skills'),
      }),
    );
    symlinkSync(hostSecrets, resolve(runDir, 'workflow-scripts'));

    manager.importExternalCheckpoint(externalBase, id);
    const imported = JSON.parse(
      readFileSync(resolve(tmpHome, 'workflow-runs', id, 'checkpoint.json'), 'utf8'),
    ) as WorkflowCheckpoint;
    expect(imported.workflowScriptsDir).toBeUndefined();
    expect(imported.workflowSkillsDir).toBeUndefined();
  });

  it('treats its own base directory under another spelling as nothing to import', () => {
    // A symlink to the daemon's own base directory names the same runs:
    // re-importing one over itself would drop its snapshot references (and GC
    // would then delete those images) and rewrite its files.
    const localBase = resolve(tmpHome, 'workflow-runs');
    const id = `wf-own-${randomUUID()}` as WorkflowId;
    seedRun(
      localBase,
      id,
      makeCheckpoint({
        machineState: 'build',
        containerSnapshots: { primary: { image: `sha256:${'c'.repeat(64)}` } },
      }),
    );
    const checkpointPath = resolve(localBase, id, 'checkpoint.json');
    const before = readFileSync(checkpointPath, 'utf8');
    const alias = resolve(externalBase, 'alias-of-own-runs');
    symlinkSync(localBase, alias);

    expect(manager.importExternalCheckpoint(alias, id)).toBe(id);
    expect(readFileSync(checkpointPath, 'utf8')).toBe(before);
  });

  it('refuses an external checkpoint written in a newer format', () => {
    const id = `wf-newer-${randomUUID()}` as WorkflowId;
    seedRun(externalBase, id, makeCheckpoint());
    const path = resolve(externalBase, id, 'checkpoint.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), schemaVersion: 99 }));
    expect(() => manager.importExternalCheckpoint(externalBase, id)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_CHECKPOINT_TOO_NEW' }),
    );
  });

  it('does not overwrite local checkpoint bytes for an active workflow', () => {
    const id = `wf-active-${randomUUID()}` as WorkflowId;
    const localPath = resolve(tmpHome, 'workflow-runs', id, 'checkpoint.json');
    mkdirSync(resolve(localPath, '..'), { recursive: true });
    const originalBytes = '{"local":"checkpoint bytes must survive"}\n';
    writeFileSync(localPath, originalBytes);
    seedCheckpointOnly(externalBase, id, makeCheckpoint({ machineState: 'external-state' }));

    const controller = manager.getOrchestrator();
    vi.spyOn(controller, 'listActive').mockReturnValue([id]);

    expect(() => manager.importExternalCheckpoint(externalBase, id)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_ALREADY_ACTIVE' }),
    );
    expect(readFileSync(localPath, 'utf8')).toBe(originalBytes);
  });
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

describe('WorkflowManager.shutdown', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = resolve(tmpdir(), `ic-test-wfm-shutdown-${randomUUID()}`);
    mkdirSync(tmpHome, { recursive: true });
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalHome;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('aborts every run with the given reason, then refuses all further requests', async () => {
    const manager = new WorkflowManager({ eventBus: new WebEventBus() });
    const defPath = resolve(tmpHome, 'gate-first.json');
    writeFileSync(
      defPath,
      JSON.stringify({
        name: 'gate-first',
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
      }),
    );
    const controller = manager.getOrchestrator();
    const workflowId = await controller.start(defPath, 'task');

    const first = manager.shutdown({ reason: 'Daemon shutdown' });
    // A second call joins the first drain instead of starting another.
    expect(manager.shutdown()).toBe(first);
    await first;

    const checkpoint = JSON.parse(
      readFileSync(resolve(tmpHome, 'workflow-runs', workflowId, 'checkpoint.json'), 'utf8'),
    ) as WorkflowCheckpoint;
    expect(checkpoint.finalStatus).toEqual({ phase: 'aborted', reason: 'Daemon shutdown' });
    expect(() => manager.getOrchestrator()).toThrow(WorkflowManagerClosedError);
    expect(() => manager.loadPastRun(workflowId)).toThrow(expect.objectContaining({ code: 'WORKFLOW_MANAGER_CLOSED' }));
  });
});
