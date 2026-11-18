/**
 * Host-side I/O on the agent-writable workflow workspace (WP-19).
 *
 * In Docker mode the workspace is a read-write bind mount, so an agent (or a
 * process it left behind) controls every entry under it, including in a
 * workspace reused by a later run. These tests plant the entries a hostile
 * agent would (symlinks to host files and directories, FIFOs, links to
 * /dev/zero, symlinked artifact roots) and check that the orchestrator never
 * writes through them, never blocks on them, and never walks the host tree
 * behind them.
 *
 * FIFO cases run under a helper that unblocks a regressed (blocking) open after
 * a few seconds, so a regression fails the elapsed-time assertion instead of
 * hanging the worker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pass-through `node:fs` with one seam: a hook that runs before every
// lstatSync/statSync, used to delete a file between the directory listing and
// the stat (a concurrent writer) and to observe which paths get walked.
const fsHooks = vi.hoisted(() => ({ onStat: undefined as ((path: string) => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const hooked =
    (fn: unknown) =>
    (path: unknown, ...rest: unknown[]): unknown => {
      fsHooks.onStat?.(String(path));
      return (fn as (...args: unknown[]) => unknown)(path, ...rest);
    };
  return { ...actual, lstatSync: hooked(actual.lstatSync), statSync: hooked(actual.statSync) };
});

import { MessageLog } from '../../src/workflow/message-log.js';
import { writeRunDefinition } from '../../src/workflow/run-definition.js';
import type { DeterministicInvokeInput, DeterministicInvokeResult } from '../../src/workflow/machine-builder.js';
import { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import {
  DETERMINISTIC_RESULT_ERROR_VERDICT,
  createWorkflowId,
  type AgentStateDefinition,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowId,
} from '../../src/workflow/types.js';
import { fifoSupported, makeFifo, startFifoUnblocker } from '../helpers/fifo.js';
import {
  resolveActiveGate,
  MockSession,
  approvedResponse,
  createCheckpointStore,
  createDeps,
  createMockTab,
  waitForCompletion,
  waitForGate,
  writeDefinitionFile,
  writeEvolveLaneNodes,
} from './test-helpers.js';

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/** One agent state with no outputs and no isStalled guard: no output hash walk. */
const singleAgentDef: WorkflowDefinition = {
  name: 'workspace-io-single',
  description: 'One agent, then done',
  initial: 'implement',
  settings: { mode: 'builtin' },
  states: {
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'global',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: [],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

/** Same, but routed through isStalled: the workspace root is hashed after the turn. */
const stallCheckedDef: WorkflowDefinition = {
  name: 'workspace-io-stall',
  description: 'One stall-checked agent, then done',
  initial: 'implement',
  settings: { mode: 'builtin' },
  states: {
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'global',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: [],
      transitions: [{ to: 'stalled', guard: 'isStalled' }, { to: 'done' }],
    },
    stalled: {
      type: 'human_gate',
      description: 'Stall gate',
      acceptedEvents: ['ABORT'],
      transitions: [{ to: 'aborted', event: 'ABORT' }],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

/** An agent that must produce `plan`, then a gate presenting `plan` and `extra`. */
const planGateDef: WorkflowDefinition = {
  name: 'workspace-io-plan-gate',
  description: 'Plan, then review it',
  initial: 'plan',
  settings: { mode: 'builtin' },
  states: {
    plan: {
      type: 'agent',
      description: 'Creates a plan',
      persona: 'global',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'plan_gate' }],
    },
    plan_gate: {
      type: 'human_gate',
      description: 'Review the plan',
      acceptedEvents: ['APPROVE', 'ABORT'],
      present: ['plan', 'extra'],
      transitions: [
        { to: 'done', event: 'APPROVE' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TASK = 'Refactor the parser';

let base: string;
let baseDir: string;
let workspace: string;
let hostHome: string;
let orchestrators: WorkflowOrchestrator[];
let stderrLines: string[];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ironcurtain-ws-io-'));
  baseDir = join(base, 'runs');
  workspace = join(base, 'workspace');
  hostHome = join(base, 'host-home');
  mkdirSync(baseDir);
  mkdirSync(workspace);
  mkdirSync(join(hostHome, '.ssh'), { recursive: true });
  writeFileSync(join(hostHome, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAA host-key\n');
  writeFileSync(join(hostHome, '.gitconfig'), '[user]\n\tname = Host\n');
  orchestrators = [];
  stderrLines = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
    stderrLines.push(String(chunk));
    return (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  });
});

afterEach(async () => {
  fsHooks.onStat = undefined;
  for (const orchestrator of orchestrators) await orchestrator.shutdownAll();
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

function makeOrchestrator(overrides: Parameters<typeof createDeps>[1] = {}): {
  orchestrator: WorkflowOrchestrator;
  tabWrites: string[];
} {
  const tabWrites: string[] = [];
  const orchestrator = new WorkflowOrchestrator(
    createDeps(baseDir, {
      createSession: vi.fn(async () => new MockSession({ responses: () => approvedResponse() })),
      createWorkflowTab: vi.fn(() => {
        const tab = createMockTab();
        vi.mocked(tab.write).mockImplementation((line: string) => {
          tabWrites.push(line);
        });
        return tab;
      }),
      ...overrides,
    }),
  );
  orchestrators.push(orchestrator);
  return { orchestrator, tabWrites };
}

function messages(workflowId: WorkflowId): Array<Record<string, unknown>> {
  return readFileSync(join(baseDir, workflowId, 'messages.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const descriptionPath = (): string => join(workspace, '.workflow', 'task', 'description.md');
const hostKeys = (): string => readFileSync(join(hostHome, '.ssh', 'authorized_keys'), 'utf-8');
const hostGitconfig = (): string => readFileSync(join(hostHome, '.gitconfig'), 'utf-8');

/** Private-method seam (same bracket-access pattern as orchestrator-deterministic.test.ts). */
interface OrchestratorInternals {
  applyResultFile(
    instance: { workspacePath: string },
    input: DeterministicInvokeInput,
    base: DeterministicInvokeResult,
  ): DeterministicInvokeResult;
  reconstructFanOutBatchFromDb(
    instance: { workspacePath: string; tab: ReturnType<typeof createMockTab> },
    definition: WorkflowDefinition,
    segment: readonly string[],
    workers: number,
  ): {
    kind: 'unavailable' | 'ready' | 'error';
    error?: string;
    reconstruction?: { batchIndex: number; recordedByLane: ReadonlyMap<number, unknown> };
  };
  computeFanOutCandidateDuplicateStats(
    instance: { workspacePath: string; tab: ReturnType<typeof createMockTab> },
    children: ReadonlyArray<{ index: number; status: string; context: WorkflowContext }>,
  ): { duplicateCount: number; candidateCount: number } | undefined;
  findMissingArtifacts(instance: unknown, stateConfig: AgentStateDefinition): string[];
}

function internals(orchestrator: WorkflowOrchestrator): OrchestratorInternals {
  return orchestrator as unknown as OrchestratorInternals;
}

function resultInput(resultFile: string): DeterministicInvokeInput {
  return {
    stateId: 'check',
    commands: [['node', 'check.js']],
    context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
    container: true,
    resultFile,
  };
}

/** Just enough of an evolve fan-out for the crash-resume DB read: a `sample` head with a `--run-dir`. */
const evolveSampleDef: WorkflowDefinition = {
  name: 'workspace-io-evolve',
  description: 'Evolve sample head',
  initial: 'sample',
  settings: { mode: 'builtin' },
  states: {
    sample: {
      type: 'deterministic',
      description: 'Samples parents',
      run: [
        [
          '/opt/workflow-venv/bin/python',
          '/workflow-scripts/evolve_result.py',
          'sample',
          '--run-dir',
          '/workspace/.evolve_runs/main',
          '--result-file',
          '/workspace/.evolve_runs/main/current/sample.json',
        ],
      ],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

function reconstructBatch(
  orchestrator: WorkflowOrchestrator,
): ReturnType<OrchestratorInternals['reconstructFanOutBatchFromDb']> {
  return internals(orchestrator).reconstructFanOutBatchFromDb(
    { workspacePath: workspace, tab: createMockTab() },
    evolveSampleDef,
    ['sample'],
    2,
  );
}

function recordedLane(index: number, stepName: string): { index: number; status: string; context: WorkflowContext } {
  return {
    index,
    status: 'recorded',
    context: {
      lastDeterministicResult: { passed: true, payload: { step_name: stepName } },
    } as unknown as WorkflowContext,
  };
}

// ---------------------------------------------------------------------------
// start() / resume(): the workflow-owned tree and .gitignore
// ---------------------------------------------------------------------------

describe('start() in a reused workspace', () => {
  it('replaces a symlinked description.md and skips a symlinked .gitignore, leaving both targets untouched', async () => {
    mkdirSync(join(workspace, '.workflow', 'task'), { recursive: true });
    symlinkSync(join(hostHome, '.ssh', 'authorized_keys'), descriptionPath());
    symlinkSync(join(hostHome, '.gitconfig'), join(workspace, '.gitignore'));
    const { orchestrator, tabWrites } = makeOrchestrator();

    const workflowId = await orchestrator.start(writeDefinitionFile(base, singleAgentDef), TASK, workspace);
    await waitForCompletion(orchestrator, workflowId);

    expect(hostKeys()).toBe('ssh-ed25519 AAAA host-key\n');
    expect(hostGitconfig()).toBe('[user]\n\tname = Host\n');
    expect(lstatSync(descriptionPath()).isFile()).toBe(true);
    expect(readFileSync(descriptionPath(), 'utf-8')).toBe(TASK);
    expect(readlinkSync(join(workspace, '.gitignore'))).toBe(join(hostHome, '.gitconfig'));
    expect(stderrLines.join('')).toContain('.gitignore');
    expect(tabWrites.some((line) => line.startsWith('[warning]') && line.includes('symbolic link'))).toBe(true);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
  });

  it('moves a symlinked .workflow aside instead of creating files in its target', async () => {
    const hostDir = join(hostHome, 'projects');
    mkdirSync(hostDir);
    symlinkSync(hostDir, join(workspace, '.workflow'));
    const { orchestrator } = makeOrchestrator();

    const workflowId = await orchestrator.start(writeDefinitionFile(base, singleAgentDef), TASK, workspace);
    await waitForCompletion(orchestrator, workflowId);

    expect(readdirSync(hostDir)).toEqual([]);
    expect(lstatSync(join(workspace, '.workflow')).isDirectory()).toBe(true);
    expect(readFileSync(descriptionPath(), 'utf-8')).toBe(TASK);
    const displaced = readdirSync(workspace).filter((name) => name.startsWith('.workflow.ironcurtain-displaced-'));
    expect(displaced).toHaveLength(1);
    expect(readlinkSync(join(workspace, displaced[0]))).toBe(hostDir);
  });

  it('moves a symlinked .workflow/task aside instead of writing description.md into its target', async () => {
    mkdirSync(join(workspace, '.workflow'));
    symlinkSync(join(hostHome, '.ssh'), join(workspace, '.workflow', 'task'));
    const { orchestrator } = makeOrchestrator();

    const workflowId = await orchestrator.start(writeDefinitionFile(base, singleAgentDef), TASK, workspace);
    await waitForCompletion(orchestrator, workflowId);

    expect(readdirSync(join(hostHome, '.ssh'))).toEqual(['authorized_keys']);
    expect(hostKeys()).toBe('ssh-ed25519 AAAA host-key\n');
    expect(lstatSync(join(workspace, '.workflow', 'task')).isDirectory()).toBe(true);
    expect(readFileSync(descriptionPath(), 'utf-8')).toBe(TASK);
  });

  it('skips a .gitignore that links to /dev/zero', async () => {
    symlinkSync('/dev/zero', join(workspace, '.gitignore'));
    const { orchestrator } = makeOrchestrator();
    const started = Date.now();

    const workflowId = await orchestrator.start(writeDefinitionFile(base, singleAgentDef), TASK, workspace);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(readlinkSync(join(workspace, '.gitignore'))).toBe('/dev/zero');
    expect(stderrLines.join('')).toMatch(/left .*\.gitignore unchanged \(it is a symbolic link\)/);
    await waitForCompletion(orchestrator, workflowId);
  });

  it('still creates or appends a regular .gitignore', async () => {
    writeFileSync(join(workspace, '.gitignore'), 'node_modules\n');
    const { orchestrator } = makeOrchestrator();
    const workflowId = await orchestrator.start(writeDefinitionFile(base, singleAgentDef), TASK, workspace);
    await waitForCompletion(orchestrator, workflowId);
    expect(readFileSync(join(workspace, '.gitignore'), 'utf-8')).toBe('node_modules\n.workflow/\n');
  });

  it.skipIf(!fifoSupported)('does not block on FIFOs at description.md and .gitignore', async () => {
    mkdirSync(join(workspace, '.workflow', 'task'), { recursive: true });
    makeFifo(descriptionPath());
    makeFifo(join(workspace, '.gitignore'));
    const unblockers = [startFifoUnblocker(descriptionPath()), startFifoUnblocker(join(workspace, '.gitignore'))];
    const { orchestrator } = makeOrchestrator();
    const started = Date.now();
    let workflowId: WorkflowId;
    try {
      workflowId = await orchestrator.start(writeDefinitionFile(base, singleAgentDef), TASK, workspace);
    } finally {
      for (const unblocker of unblockers) unblocker.stop();
    }

    expect(Date.now() - started).toBeLessThan(1000);
    expect(lstatSync(descriptionPath()).isFile()).toBe(true);
    expect(readFileSync(descriptionPath(), 'utf-8')).toBe(TASK);
    expect(lstatSync(join(workspace, '.gitignore')).isFIFO()).toBe(true);
    await waitForCompletion(orchestrator, workflowId);
  });
});

describe('resume()', () => {
  it('moves a .workflow replaced by a symlink while paused aside before touching artifacts', async () => {
    const defPath = writeDefinitionFile(base, planGateDef);
    const workflowId = createWorkflowId();
    const checkpointStore = createCheckpointStore(baseDir);
    mkdirSync(join(baseDir, workflowId), { recursive: true });
    writeRunDefinition(join(baseDir, workflowId), planGateDef);
    checkpointStore.save(workflowId, {
      machineState: 'plan_gate',
      context: {
        taskDescription: TASK,
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
        previousStateName: 'plan',
        visitCounts: { plan: 1 },
      },
      timestamp: new Date().toISOString(),
      transitionHistory: [],
      definitionPath: defPath,
      workspacePath: workspace,
    });
    // While paused, the agent swapped `.workflow` for a link to a host
    // directory that happens to contain a `plan/` directory.
    const hostDir = join(hostHome, 'projects');
    mkdirSync(join(hostDir, 'plan'), { recursive: true });
    writeFileSync(join(hostDir, 'plan', 'host-file'), 'host');
    symlinkSync(hostDir, join(workspace, '.workflow'));

    const raiseGate = vi.fn();
    const { orchestrator } = makeOrchestrator({ checkpointStore, raiseGate });
    await orchestrator.resume(workflowId);
    const [gate] = await waitForGate(raiseGate, 1);

    expect(lstatSync(join(workspace, '.workflow')).isDirectory()).toBe(true);
    expect(readdirSync(hostDir)).toEqual(['plan']);
    expect(readdirSync(join(hostDir, 'plan'))).toEqual(['host-file']);
    expect(readFileSync(descriptionPath(), 'utf-8')).toBe(TASK);
    expect(gate.presentedArtifacts.size).toBe(0);
    expect(stderrLines.join('')).toContain('moved it aside');
  });
});

// ---------------------------------------------------------------------------
// Reads: result files, nodes.json, fan-out candidates
// ---------------------------------------------------------------------------

describe('host-side reads of agent-writable files', () => {
  it.skipIf(!fifoSupported)('fails fast on a FIFO result file', () => {
    mkdirSync(join(workspace, '.workflow'));
    const fifo = join(workspace, '.workflow', 'result.json');
    makeFifo(fifo);
    const { orchestrator } = makeOrchestrator();
    const unblocker = startFifoUnblocker(fifo);
    const started = Date.now();
    let result: DeterministicInvokeResult;
    try {
      result = internals(orchestrator).applyResultFile(
        { workspacePath: workspace },
        resultInput('.workflow/result.json'),
        { passed: true },
      );
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.verdict).toBe(DETERMINISTIC_RESULT_ERROR_VERDICT);
    expect(result.errors).toContain('not a regular file');
  });

  it('refuses result files that link to /dev/zero, are oversized, or sit behind a directory symlinked out of the workspace', () => {
    const { orchestrator } = makeOrchestrator();
    const apply = (resultFile: string): DeterministicInvokeResult =>
      internals(orchestrator).applyResultFile({ workspacePath: workspace }, resultInput(resultFile), {
        passed: true,
      });
    mkdirSync(join(workspace, '.workflow'));

    symlinkSync('/dev/zero', join(workspace, '.workflow', 'zero.json'));
    expect(apply('.workflow/zero.json').errors).toContain('escapes the workspace');

    symlinkSync(join(workspace, 'inside.json'), join(workspace, '.workflow', 'inside-link.json'));
    writeFileSync(join(workspace, 'inside.json'), JSON.stringify({ verdict: 'ok' }));
    expect(apply('.workflow/inside-link.json').errors).toContain('symbolic link');

    writeFileSync(join(workspace, '.workflow', 'big.json'), Buffer.alloc(1024 * 1024 + 1, 0x20));
    expect(apply('.workflow/big.json').errors).toContain('larger than');

    writeFileSync(join(hostHome, 'result.json'), JSON.stringify({ verdict: 'leak' }));
    symlinkSync(hostHome, join(workspace, 'escape'));
    const escaped = apply('escape/result.json');
    expect(escaped.verdict).toBe(DETERMINISTIC_RESULT_ERROR_VERDICT);
    expect(escaped.errors).toContain('escapes the workspace');

    writeFileSync(join(workspace, '.workflow', 'ok.json'), JSON.stringify({ verdict: 'accepted' }));
    expect(apply('.workflow/ok.json').verdict).toBe('accepted');
  });

  it.skipIf(!fifoSupported)('fails fast on a FIFO nodes.json instead of treating the DB as empty', () => {
    const dbDir = join(workspace, '.evolve_runs', 'main', 'database_data');
    mkdirSync(dbDir, { recursive: true });
    makeFifo(join(dbDir, 'nodes.json'));
    const { orchestrator } = makeOrchestrator();
    const unblocker = startFifoUnblocker(join(dbDir, 'nodes.json'));
    const started = Date.now();
    let reconstruction: ReturnType<OrchestratorInternals['reconstructFanOutBatchFromDb']>;
    try {
      reconstruction = reconstructBatch(orchestrator);
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(reconstruction).toMatchObject({ kind: 'error' });
    expect(reconstruction.error).toContain('could not read evolve nodes DB');
  });

  it('distinguishes a missing nodes.json from one that links to /dev/zero', () => {
    const dbDir = join(workspace, '.evolve_runs', 'main', 'database_data');
    const { orchestrator } = makeOrchestrator();

    expect(reconstructBatch(orchestrator)).toMatchObject({ kind: 'ready', reconstruction: { batchIndex: 1 } });
    mkdirSync(dbDir, { recursive: true });
    symlinkSync('/dev/zero', join(dbDir, 'nodes.json'));
    const started = Date.now();
    expect(reconstructBatch(orchestrator)).toMatchObject({ kind: 'error' });
    expect(Date.now() - started).toBeLessThan(1000);
    rmSync(join(dbDir, 'nodes.json'));
    writeEvolveLaneNodes(dbDir, [0], 1);
    const ready = reconstructBatch(orchestrator);
    expect(ready.kind).toBe('ready');
    expect(ready.reconstruction?.recordedByLane.size).toBe(1);
  });

  it.skipIf(!fifoSupported)('skips a FIFO candidate without blocking and still counts duplicates', () => {
    const steps = join(workspace, '.evolve_runs', 'main', 'steps');
    for (const step of ['step_0001_lane_0', 'step_0001_lane_1', 'step_0001_lane_2']) {
      mkdirSync(join(steps, step), { recursive: true });
    }
    writeFileSync(join(steps, 'step_0001_lane_0', 'code'), 'print(1)\n');
    writeFileSync(join(steps, 'step_0001_lane_1', 'code'), 'print(1)\n');
    makeFifo(join(steps, 'step_0001_lane_2', 'code'));
    const { orchestrator } = makeOrchestrator();
    const tab = createMockTab();
    const unblocker = startFifoUnblocker(join(steps, 'step_0001_lane_2', 'code'));
    const started = Date.now();
    let stats: { duplicateCount: number; candidateCount: number } | undefined;
    try {
      stats = internals(orchestrator).computeFanOutCandidateDuplicateStats({ workspacePath: workspace, tab }, [
        recordedLane(0, 'step_0001_lane_0'),
        recordedLane(1, 'step_0001_lane_1'),
        recordedLane(2, 'step_0001_lane_2'),
      ]);
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(stats).toMatchObject({ candidateCount: 2, duplicateCount: 1 });
    expect(vi.mocked(tab.write).mock.calls.flat().join('\n')).toContain('NOT_REGULAR_FILE');
  });

  it('never joins a step_name outside the bridge spelling into a host path', () => {
    // A lane result claiming `step_name: "../../../secret"` must not make the
    // host hash `<workspace>/secret/code` (or anything else it names).
    mkdirSync(join(workspace, 'secret'));
    writeFileSync(join(workspace, 'secret', 'code'), 'secret');
    mkdirSync(join(workspace, '.evolve_runs', 'main', 'steps'), { recursive: true });
    const { orchestrator } = makeOrchestrator();
    const touched: string[] = [];
    fsHooks.onStat = (path) => {
      if (path.includes('secret')) touched.push(path);
    };

    const stats = internals(orchestrator).computeFanOutCandidateDuplicateStats(
      { workspacePath: workspace, tab: createMockTab() },
      [recordedLane(0, '../../../secret'), recordedLane(1, 'step_1/../../x')],
    );

    expect(stats).toBeUndefined();
    expect(touched).toEqual([]);
  });

  it('skips a candidate that links to /dev/zero', () => {
    const step = join(workspace, '.evolve_runs', 'main', 'steps', 'step_0002_lane_0');
    mkdirSync(step, { recursive: true });
    symlinkSync('/dev/zero', join(step, 'code'));
    const { orchestrator } = makeOrchestrator();
    const started = Date.now();
    expect(
      internals(orchestrator).computeFanOutCandidateDuplicateStats({ workspacePath: workspace, tab: createMockTab() }, [
        recordedLane(0, 'step_0002_lane_0'),
      ]),
    ).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Artifact roots and the output hash walk
// ---------------------------------------------------------------------------

describe('artifact outputs planted by the agent', () => {
  const planState = planGateDef.states.plan as AgentStateDefinition;

  function syntheticInstance(): Record<string, unknown> {
    return {
      id: 'wf-ws-io',
      workspacePath: workspace,
      artifactDir: join(workspace, '.workflow'),
      tab: createMockTab(),
      messageLog: new MessageLog(join(base, 'synthetic-messages.jsonl')),
      currentState: 'plan',
    };
  }

  it('counts an output dir symlinked to / as missing within 1 s and reports it once', () => {
    mkdirSync(join(workspace, '.workflow'));
    symlinkSync('/', join(workspace, '.workflow', 'plan'));
    const { orchestrator } = makeOrchestrator();
    const instance = syntheticInstance();

    const started = Date.now();
    expect(internals(orchestrator).findMissingArtifacts(instance, planState)).toEqual(['plan']);
    expect(internals(orchestrator).findMissingArtifacts(instance, planState)).toEqual(['plan']);
    expect(Date.now() - started).toBeLessThan(1000);

    const logged = readFileSync(join(base, 'synthetic-messages.jsonl'), 'utf-8').trim().split('\n');
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0])).toMatchObject({ type: 'error', context: 'security: unsafe artifact output' });
  });

  it('counts outputs under a .workflow symlinked to a populated host directory as missing', () => {
    const hostDir = join(hostHome, 'projects');
    mkdirSync(join(hostDir, 'plan'), { recursive: true });
    writeFileSync(join(hostDir, 'plan', 'host-file'), 'host');
    symlinkSync(hostDir, join(workspace, '.workflow'));
    const { orchestrator } = makeOrchestrator();
    expect(internals(orchestrator).findMissingArtifacts(syntheticInstance(), planState)).toEqual(['plan']);
  });

  it('end to end: a planted output symlink is neither accepted as the artifact nor presented at the gate', async () => {
    let turn = 0;
    const raiseGate = vi.fn();
    const { orchestrator, tabWrites } = makeOrchestrator({
      raiseGate,
      createSession: vi.fn(
        async () =>
          new MockSession({
            responses: () => {
              turn++;
              if (turn === 1) {
                mkdirSync(join(workspace, '.workflow'), { recursive: true });
                symlinkSync('/', join(workspace, '.workflow', 'plan'));
              }
              return approvedResponse();
            },
          }),
      ),
    });

    const workflowId = await orchestrator.start(writeDefinitionFile(base, planGateDef), TASK, workspace);
    // The agent state fails (the error routes to the gate) instead of handing on `/` as its plan.
    const [gate] = await waitForGate(raiseGate, 1);

    expect(gate.summary).toContain('Missing artifacts after retry: plan');
    expect(gate.presentedArtifacts.has('plan')).toBe(false);
    const log = messages(workflowId);
    expect(log.some((entry) => entry.type === 'agent_retry' && entry.reason === 'missing_artifacts')).toBe(true);
    expect(log.filter((entry) => entry.context === 'security: unsafe artifact output')).toHaveLength(1);
    expect(tabWrites.some((line) => line.startsWith('[security]'))).toBe(true);
  });

  it('end to end: a real artifact is presented at the gate but a symlinked one is not', async () => {
    const raiseGate = vi.fn();
    const hostDir = join(hostHome, 'projects');
    mkdirSync(hostDir);
    const { orchestrator } = makeOrchestrator({
      raiseGate,
      createSession: vi.fn(
        async () =>
          new MockSession({
            responses: () => {
              mkdirSync(join(workspace, '.workflow', 'plan'), { recursive: true });
              writeFileSync(join(workspace, '.workflow', 'plan', 'plan.md'), 'the plan');
              if (!existsSync(join(workspace, '.workflow', 'extra'))) {
                symlinkSync(hostDir, join(workspace, '.workflow', 'extra'));
              }
              return approvedResponse();
            },
          }),
      ),
    });

    await orchestrator.start(writeDefinitionFile(base, planGateDef), TASK, workspace);
    const [gate] = await waitForGate(raiseGate, 1);

    expect([...gate.presentedArtifacts.keys()]).toEqual(['plan']);
    expect(gate.presentedArtifacts.get('plan')).toBe(join(workspace, '.workflow', 'plan'));
  });
});

describe('artifact snapshots on a revisited state', () => {
  /** plan -> gate; FORCE_REVISION loops back to plan, whose second visit snapshots `plan`. */
  const revisionDef: WorkflowDefinition = {
    name: 'workspace-io-revision',
    description: 'Plan, review, revise',
    initial: 'plan',
    settings: { mode: 'builtin' },
    states: {
      plan: {
        type: 'agent',
        description: 'Creates a plan',
        persona: 'global',
        prompt: 'You are a planner.',
        inputs: [],
        outputs: ['plan'],
        transitions: [{ to: 'plan_gate' }],
      },
      plan_gate: {
        type: 'human_gate',
        description: 'Review the plan',
        acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
        present: ['plan'],
        transitions: [
          { to: 'done', event: 'APPROVE' },
          { to: 'plan', event: 'FORCE_REVISION' },
          { to: 'aborted', event: 'ABORT' },
        ],
      },
      done: { type: 'terminal', description: 'Done' },
      aborted: { type: 'terminal', description: 'Aborted' },
    },
  };

  it('copies the previous visit of an output to <name>.v1 before the state runs again', async () => {
    const planDir = join(workspace, '.workflow', 'plan');
    const raiseGate = vi.fn();
    const { orchestrator } = makeOrchestrator({
      raiseGate,
      createSession: vi.fn(
        async () =>
          new MockSession({
            responses: () => {
              // The second visit runs after the snapshot, so it finds plan.v1.
              const visit = existsSync(join(workspace, '.workflow', 'plan.v1')) ? 'second' : 'first';
              mkdirSync(join(planDir, 'notes'), { recursive: true });
              writeFileSync(join(planDir, 'plan.md'), `${visit} plan`);
              writeFileSync(join(planDir, 'notes', 'n.md'), `${visit} notes`);
              return approvedResponse();
            },
          }),
      ),
    });

    const workflowId = await orchestrator.start(writeDefinitionFile(base, revisionDef), TASK, workspace);
    await waitForGate(raiseGate, 1);
    resolveActiveGate(orchestrator, workflowId, { type: 'FORCE_REVISION', prompt: 'Revise it' });
    await waitForGate(raiseGate, 2);

    const snapshot = join(workspace, '.workflow', 'plan.v1');
    expect(readFileSync(join(snapshot, 'plan.md'), 'utf-8')).toBe('first plan');
    expect(readFileSync(join(snapshot, 'notes', 'n.md'), 'utf-8')).toBe('first notes');
    expect(readFileSync(join(planDir, 'plan.md'), 'utf-8')).toBe('second plan');
    expect(stderrLines.join('')).not.toContain('snapshotArtifacts');

    resolveActiveGate(orchestrator, workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator, workflowId);
  });
});

describe('output hash walk', () => {
  it('is skipped for a state without an isStalled transition', async () => {
    mkdirSync(join(workspace, 'src'));
    const sentinel = join(workspace, 'src', 'sentinel.ts');
    writeFileSync(sentinel, 'export {};\n');
    const touched: string[] = [];
    fsHooks.onStat = (path) => {
      if (path === sentinel) touched.push(path);
    };
    const { orchestrator } = makeOrchestrator();

    const first = await orchestrator.start(writeDefinitionFile(base, singleAgentDef), TASK, workspace);
    await waitForCompletion(orchestrator, first);
    expect(orchestrator.getStatus(first)?.phase).toBe('completed');
    expect(touched).toEqual([]);

    // The same workspace under an isStalled transition is walked.
    const second = await orchestrator.start(writeDefinitionFile(base, stallCheckedDef), TASK, workspace);
    await waitForCompletion(orchestrator, second);
    expect(orchestrator.getStatus(second)?.phase).toBe('completed');
    expect(touched.length).toBeGreaterThan(0);
  });

  it('does not fail the state when a file is deleted between listing and stat', async () => {
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'a.ts'), 'a');
    const victim = join(workspace, 'src', 'lane.tmp');
    writeFileSync(victim, 'temp');
    writeFileSync(join(workspace, 'src', 'b.ts'), 'b');
    let deleted = false;
    fsHooks.onStat = (path) => {
      if (!deleted && path === victim) {
        deleted = true;
        rmSync(victim); // a concurrent writer renaming its temp file away
      }
    };
    const { orchestrator } = makeOrchestrator();

    const workflowId = await orchestrator.start(writeDefinitionFile(base, stallCheckedDef), TASK, workspace);
    await waitForCompletion(orchestrator, workflowId);

    expect(deleted).toBe(true);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
  });
});
