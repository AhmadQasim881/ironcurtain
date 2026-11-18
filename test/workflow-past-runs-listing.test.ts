/**
 * `workflows.listResumable` (the daemon's past-runs listing) against a real
 * WorkflowManager and real run directories (WP-83: GAP4-6, GAP4-11, WFC-28).
 *
 * The dashboard lists past runs on every (re)connect, synchronously on the
 * daemon's event loop. Each checkpoint used to be parsed twice per listing
 * (discovery read it for snapshot ids, then the loader again), and every
 * listing re-parsed every run. Now discovery reads no run file, and a run's
 * row is rebuilt only when one of its files, or its lock, changed. One run
 * that cannot be read no longer fails the whole listing.
 */

import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// The real session factory reads the user's config; listing never starts a
// session (see workflow-manager.test.ts).
vi.mock('../src/workflow/cli-support.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workflow/cli-support.js')>();
  return {
    ...actual,
    createWorkflowSessionFactory: () => () => Promise.reject(new Error('session factory not used in tests')),
  };
});

// A run lock can change state with no file changing (its holder exits); this
// lets a test flip it without a second process.
const lockOverrides = vi.hoisted(() => ({ held: new Set<string>() }));
vi.mock('../src/workflow/run-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workflow/run-lock.js')>();
  return {
    ...actual,
    isWorkflowRunLockHeld: (baseDir: string, workflowId: string): boolean =>
      lockOverrides.held.has(workflowId) || actual.isWorkflowRunLockHeld(baseDir, workflowId as never),
  };
});

import { workflowDispatch, type WorkflowDispatchContext } from '../src/web-ui/dispatch/workflow-dispatch.js';
import type { PastRunDto, WorkflowDetailDto } from '../src/web-ui/web-ui-types.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import { SessionManager } from '../src/session/session-manager.js';
import { WorkflowManager } from '../src/workflow/workflow-manager.js';
import { FileCheckpointStore } from '../src/workflow/checkpoint.js';
import * as logger from '../src/logger.js';
import type { ControlRequestHandler } from '../src/daemon/control-socket.js';
import type { WorkflowCheckpoint, WorkflowDefinition, WorkflowId } from '../src/workflow/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDefinition(name = 'listing-flow'): WorkflowDefinition {
  return {
    name,
    description: 'A minimal valid workflow',
    initial: 'done',
    states: { done: { type: 'terminal', description: 'Terminal state' } },
  };
}

/** A two-state definition, to tell its state graph from {@link makeDefinition}'s. */
function makePlanDefinition(): WorkflowDefinition {
  return {
    name: 'listing-flow',
    description: 'Plans, then stops',
    initial: 'plan',
    states: {
      plan: {
        type: 'agent',
        description: 'Plan stage',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: ['plan'],
        transitions: [{ to: 'done' }],
      },
      done: { type: 'terminal', description: 'Terminal state' },
    },
  };
}

function makeCheckpoint(taskDescription: string, overrides: Partial<WorkflowCheckpoint> = {}): WorkflowCheckpoint {
  return {
    machineState: 'done',
    context: {
      taskDescription,
      artifacts: {},
      round: 1,
      maxRounds: 4,
      previousOutputHashes: {},
      previousTestCount: null,
      humanPrompt: null,
      reviewHistory: [],
      totalTokens: 10,
      lastError: null,
      agentConversationsByState: {},
      previousAgentOutput: null,
      previousAgentNotes: null,
      previousStateName: null,
      visitCounts: {},
    },
    timestamp: '2026-11-10T00:00:00.000Z',
    transitionHistory: [],
    definitionPath: '/nonexistent/definition.json',
    ...overrides,
  };
}

let home: string;
let baseDir: string;
let manager: WorkflowManager;
let ctx: WorkflowDispatchContext;
let originalHome: string | undefined;

function runDir(id: string): string {
  return resolve(baseDir, id);
}

function seedRun(id: string, checkpoint: WorkflowCheckpoint, definition: WorkflowDefinition = makeDefinition()): void {
  mkdirSync(runDir(id), { recursive: true });
  writeFileSync(resolve(runDir(id), 'definition.json'), JSON.stringify(definition));
  writeFileSync(resolve(runDir(id), 'checkpoint.json'), JSON.stringify(checkpoint));
}

/** Replaces a file the way the run writers do: a new file renamed over the old one. */
function replaceByRename(path: string, content: string): void {
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}

async function listPastRuns(): Promise<PastRunDto[]> {
  return (await workflowDispatch(ctx, 'workflows.listResumable', {})) as PastRunDto[];
}

/** Calls of a `JSON.parse` spy that parsed a checkpoint (only checkpoints carry `transitionHistory`). */
function checkpointParses(parse: MockInstance<typeof JSON.parse>): number {
  return parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('"transitionHistory"')).length;
}

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), 'ic-past-runs-'));
  originalHome = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = home;
  baseDir = resolve(home, 'workflow-runs');
  mkdirSync(baseDir, { recursive: true });
  manager = new WorkflowManager({ eventBus: new WebEventBus() });
  ctx = {
    handler: {} as ControlRequestHandler,
    sessionManager: new SessionManager(),
    mode: { kind: 'docker', agent: 'claude-code' as never },
    eventBus: new WebEventBus(),
    maxConcurrentWebSessions: 5,
    sessionQueues: new Map(),
    workflowManager: manager,
  };
  lockOverrides.held.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await manager.shutdown();
  if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
  else process.env.IRONCURTAIN_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

describe('past-runs listing cost', () => {
  it('parses each of 300 checkpoints once, and none again while they are unchanged', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `wf-${String(i).padStart(3, '0')}`);
    for (const id of ids) seedRun(id, makeCheckpoint(`task ${id}`));
    const parse = vi.spyOn(JSON, 'parse');

    const first = await listPastRuns();

    expect(first).toHaveLength(300);
    expect(new Set(first.map((dto) => dto.workflowId))).toEqual(new Set(ids));
    expect(checkpointParses(parse)).toBe(300);

    parse.mockClear();
    const second = await listPastRuns();

    expect(second).toEqual(first);
    expect(checkpointParses(parse)).toBe(0);
  });

  it('re-parses only a run whose checkpoint was saved again, and drops a removed run', async () => {
    for (const id of ['wf-a', 'wf-b', 'wf-c']) seedRun(id, makeCheckpoint(`task ${id}`));
    await listPastRuns();
    // A real save (rename over the old file, the old one kept as the previous copy).
    new FileCheckpointStore(baseDir).save('wf-b' as WorkflowId, makeCheckpoint('task wf-b, round two'));
    rmSync(runDir('wf-c'), { recursive: true });
    const parse = vi.spyOn(JSON, 'parse');

    const rows = await listPastRuns();

    expect(checkpointParses(parse)).toBe(1);
    expect(rows.map((dto) => dto.workflowId).sort()).toEqual(['wf-a', 'wf-b']);
    expect(rows.find((dto) => dto.workflowId === 'wf-b')?.taskDescription).toBe('task wf-b, round two');
  });

  it('rebuilds a row when its run lock changes state, with no file changing', async () => {
    seedRun('wf-elsewhere', makeCheckpoint('task'));
    expect((await listPastRuns())[0]?.phase).toBe('completed');

    lockOverrides.held.add('wf-elsewhere');
    expect((await listPastRuns())[0]?.phase).toBe('running_elsewhere');

    lockOverrides.held.delete('wf-elsewhere');
    expect((await listPastRuns())[0]?.phase).toBe('completed');
  });

  it('rebuilds a run with no definition copy on every listing (its definition lives elsewhere)', async () => {
    const external = resolve(home, 'external-definition.json');
    writeFileSync(external, JSON.stringify(makeDefinition('external-one')));
    mkdirSync(runDir('wf-legacy'), { recursive: true });
    writeFileSync(
      resolve(runDir('wf-legacy'), 'checkpoint.json'),
      JSON.stringify(makeCheckpoint('task', { definitionPath: external })),
    );
    expect((await listPastRuns())[0]?.name).toBe('external-one');

    replaceByRename(external, JSON.stringify(makeDefinition('external-two')));

    expect((await listPastRuns())[0]?.name).toBe('external-two');
  });

  it('serves a recovered checkpoint again once the damaged one is replaced', async () => {
    seedRun('wf-recover', makeCheckpoint('the good one'));
    linkSync(resolve(runDir('wf-recover'), 'checkpoint.json'), resolve(runDir('wf-recover'), 'checkpoint.prev.json'));
    replaceByRename(resolve(runDir('wf-recover'), 'checkpoint.json'), '{ damaged');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect((await listPastRuns())[0]?.taskDescription).toBe('the good one');

    replaceByRename(resolve(runDir('wf-recover'), 'checkpoint.json'), JSON.stringify(makeCheckpoint('repaired')));

    expect((await listPastRuns())[0]?.taskDescription).toBe('repaired');
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe('past-runs listing robustness', () => {
  it('skips a run that cannot be read or examined with a warning, and lists the others', async () => {
    seedRun('wf-fine', makeCheckpoint('fine'));
    // Checkpoint-less run whose message log is not a readable file (EISDIR).
    mkdirSync(resolve(runDir('wf-unreadable-log'), 'messages.jsonl'), { recursive: true });
    writeFileSync(resolve(runDir('wf-unreadable-log'), 'definition.json'), JSON.stringify(makeDefinition()));
    // A probed name that is a symlink loop: the run cannot be examined (ELOOP).
    seedRun('wf-looped', makeCheckpoint('looped'));
    rmSync(resolve(runDir('wf-looped'), 'checkpoint.json'));
    symlinkSync('checkpoint.json', resolve(runDir('wf-looped'), 'checkpoint.json'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const rows = await listPastRuns();

    expect(rows.map((dto) => dto.workflowId)).toEqual(['wf-fine']);
    const warnings = warn.mock.calls.map(([message]) => message);
    expect(warnings.some((message) => message.includes('wf-unreadable-log') && message.includes('EISDIR'))).toBe(true);
    expect(warnings.some((message) => message.includes('wf-looped') && message.includes('ELOOP'))).toBe(true);
  });

  it('is not disturbed by links an agent planted in a run workspace', async () => {
    seedRun('wf-planted', makeCheckpoint('planted'));
    const artifactDir = resolve(runDir('wf-planted'), 'workspace', '.workflow');
    mkdirSync(artifactDir, { recursive: true });
    symlinkSync(resolve(home, 'gone'), resolve(artifactDir, 'dangling'));

    expect((await listPastRuns()).map((dto) => dto.workflowId)).toEqual(['wf-planted']);
  });
});

// ---------------------------------------------------------------------------
// workflows.get state graph (GAP4-11)
// ---------------------------------------------------------------------------

describe('workflows.get state graph', () => {
  it('is computed from the definition each request, never served stale for the same id', async () => {
    seedRun('wf-graph', makeCheckpoint('task'));
    const before = (await workflowDispatch(ctx, 'workflows.get', { workflowId: 'wf-graph' })) as WorkflowDetailDto;
    expect(before.stateGraph.states.map((state) => state.id)).toEqual(['done']);

    replaceByRename(resolve(runDir('wf-graph'), 'definition.json'), JSON.stringify(makePlanDefinition()));
    const after = (await workflowDispatch(ctx, 'workflows.get', { workflowId: 'wf-graph' })) as WorkflowDetailDto;

    expect(after.stateGraph.states.map((state) => state.id)).toEqual(['plan', 'done']);
  });
});
