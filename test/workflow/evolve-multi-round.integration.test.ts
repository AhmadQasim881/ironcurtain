import { testUserConfig } from '../helpers/user-config.js';
import { USER_CONFIG_DEFAULTS } from '../../src/config/user-config.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REAL_TMP, testCompiledPolicy, testToolAnnotations } from '../fixtures/test-policy.js';
import { isDockerAvailable, isDockerImageAvailable } from '../helpers/docker-available.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import {
  createDockerInfrastructure,
  destroyDockerInfrastructure,
  type DockerInfrastructure,
} from '../../src/docker/docker-infrastructure.js';
import {
  WorkflowOrchestrator,
  type CreateWorkflowInfrastructureInput,
  type WorkflowLifecycleEvent,
} from '../../src/workflow/orchestrator.js';
import type { SessionOptions } from '../../src/session/types.js';
import {
  resolveActiveGate,
  approvedResponse,
  createDeps,
  MockSession,
  statusBlock,
  waitForCompletion,
  waitForGate,
} from './test-helpers.js';
import type { AgentId } from '../../src/docker/agent-adapter.js';

const IMAGE = 'ironcurtain-claude-code:latest';
const TEST_HOME = `${REAL_TMP}/ironcurtain-evolve-multi-round-${process.pid}`;
const ROUND_COUNT = 3;
const TASK = 'write solve(xs) scoring higher the closer solve([1,2,3]) is to 6 over 3 rounds';

type RunMode = 'positive' | 'crash-round-2';

interface EvolveNode {
  readonly id: number;
  readonly parent: readonly number[];
  readonly score: number;
  readonly analysis: string;
  readonly created_at?: string;
}

interface NodesFile {
  readonly next_id: number;
  readonly nodes: Record<string, EvolveNode>;
}

function findHostCaDir(): string | null {
  const home = process.env.IRONCURTAIN_HOME ?? join(homedir(), '.ironcurtain');
  const ca = join(home, 'ca');
  return existsSync(ca) ? ca : null;
}

const hostCaDir = findHostCaDir();
const dockerReady =
  process.env.INTEGRATION_TEST === '1' && isDockerAvailable() && isDockerImageAvailable(IMAGE) && hostCaDir !== null;

function buildDockerSessionConfig(workspaceDir: string, generatedDir: string): IronCurtainConfig {
  return {
    auditLogPath: join(workspaceDir, 'audit.jsonl'),
    allowedDirectory: workspaceDir,
    mcpServers: {},
    protectedPaths: [],
    generatedDir,
    constitutionPath: join(generatedDir, 'constitution.md'),
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: testUserConfig({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'test-fake-key-no-network',
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 300,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      auditRedaction: { enabled: false },
      packageInstall: {
        enabled: true,
        quarantineDays: 2,
        allowedPackages: ['numpy', 'pyyaml'],
        deniedPackages: [],
      },
      dockerResources: { ...USER_CONFIG_DEFAULTS.dockerResources, memoryMb: null, cpus: null },
      containerRuntime: 'docker',
    }),
  };
}

function writePreflightRunSpec(workspacePath: string, rounds: number): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  mkdirSync(resolve(runDir, 'steps'), { recursive: true });
  mkdirSync(resolve(runDir, 'database_data'), { recursive: true });
  mkdirSync(resolve(runDir, 'cognition_data'), { recursive: true });
  mkdirSync(resolve(runDir, 'best'), { recursive: true });
  writeFileSync(resolve(runDir, 'round_log.jsonl'), '');

  const evaluationCommand = [
    "python3 -c '",
    'import json;',
    'ns={{}};',
    'exec(open({quoted_code_path}).read(), ns);',
    's=ns["solve"]([1,2,3]);',
    'score=max(0.0, 6.0 - abs(float(s) - 6.0));',
    'json.dump({{"eval_score": score, "success": score >= 6.0}}, open({quoted_results_path}, "w"))',
    "'",
  ].join('');
  const runSpec = {
    objective: TASK,
    evaluation: {
      core_score: 'eval_score',
      secondary_metrics: [],
      command: evaluationCommand,
      script_path: '',
      timeout_secs: 30,
      // Unreachable on purpose: the deterministic stop_check ends the run on
      // target_met, and round 1 already scores 2, so a reachable target would
      // stop it after one round. These runs end on max_rounds.
      success_criteria: ['eval_score >= 99'],
    },
    budget: { max_rounds: rounds, patience: 2 },
    stop_conditions: ['max_rounds'],
    mutation_scope: {
      writable_paths: ['.evolve_runs'],
      primary_targets: ['candidate.py'],
    },
    sampling: {
      algorithm: 'greedy',
      sample_n: 1,
      feature_dimensions: [],
      feature_bins: 0,
      custom_sampler_path: '',
      custom_sampler_class: '',
    },
    cognition: { source_mode: 'seed', seed_files: [], seed_notes: [] },
    approval: { confirmed: true },
  };
  writeFileSync(resolve(runDir, 'run_spec.yaml'), JSON.stringify(runSpec, null, 2) + '\n');
  writeFileSync(resolve(runDir, 'preflight_summary.md'), '# Preflight Summary\n\n- Status: `READY`\n');
  writeFileSync(
    resolve(runDir, 'cognition_seed.md'),
    [
      '```json',
      '[',
      '  {',
      '    "content": "solve xs sum target evolve toward six by improving the candidate return value",',
      '    "source": "test",',
      '    "metadata": {"kind": "heuristic"}',
      '  }',
      ']',
      '```',
      '',
    ].join('\n'),
  );
  mkdirSync(resolve(workspacePath, '.workflow', 'run_spec'), { recursive: true });
  mkdirSync(resolve(workspacePath, '.workflow', 'cognition_seed'), { recursive: true });
  writeFileSync(
    resolve(workspacePath, '.workflow', 'run_spec', 'run_spec.md'),
    JSON.stringify(runSpec, null, 2) + '\n',
  );
  writeFileSync(
    resolve(workspacePath, '.workflow', 'cognition_seed', 'cognition_seed.md'),
    readFileSync(resolve(runDir, 'cognition_seed.md'), 'utf-8'),
  );
}

function writeProvisionMarker(workspacePath: string): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(resolve(runDir, '.provisioned'), 'numpy\npyyaml\n');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

function writeCandidate(workspacePath: string, mode: RunMode, researcherTurn: number): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const context = readJson(resolve(runDir, 'current', 'context.json')) as { step_name: string };
  const stepDir = resolve(runDir, 'steps', context.step_name);
  mkdirSync(stepDir, { recursive: true });

  if (mode === 'crash-round-2' && researcherTurn === 2) {
    writeFileSync(resolve(stepDir, 'code'), 'x = 1\n');
    return;
  }

  const returnValues = [2, 5, 6];
  const value = returnValues[Math.min(researcherTurn - 1, returnValues.length - 1)];
  writeFileSync(resolve(stepDir, 'code'), `def solve(xs):\n    return ${value}\n`);
}

function writeAnalysis(workspacePath: string, analyzerTurn: number): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  mkdirSync(resolve(runDir, 'current'), { recursive: true });
  writeFileSync(
    resolve(runDir, 'current', 'analysis.md'),
    `Round ${analyzerTurn} lesson: move solve(xs) closer to the sum target while preserving a simple deterministic function.\n`,
  );
}

function writeFinalReport(workspacePath: string): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as NodesFile;
  const scores = Object.values(nodes.nodes).map((node) => `${node.id} -> ${node.score}`);
  const best = Object.values(nodes.nodes).reduce((current, node) => (node.score > current.score ? node : current));
  const report = [
    '# Final Evolve Report',
    '',
    `Objective: ${TASK}`,
    `Rounds: ${Object.keys(nodes.nodes).length} / ${ROUND_COUNT}`,
    `Best node: ${best.id}, score ${best.score}`,
    `Best lesson: ${best.analysis.trim()}`,
    `Score trajectory: ${scores.join(', ')}`,
    'Recommendation: accept the best candidate unless more exploration is explicitly requested.',
    '',
  ].join('\n');
  writeFileSync(resolve(runDir, 'final_report.md'), report);
  mkdirSync(resolve(workspacePath, '.workflow', 'final_report'), { recursive: true });
  writeFileSync(resolve(workspacePath, '.workflow', 'final_report', 'final_report.md'), report);
}

function stripCreatedAt(nodes: NodesFile): unknown {
  return {
    ...nodes,
    nodes: Object.fromEntries(
      Object.entries(nodes.nodes).map(([id, node]) => {
        const rest = { ...node };
        delete rest.created_at;
        return [id, rest];
      }),
    ),
  };
}

function countStates(states: readonly string[], state: string): number {
  return states.filter((s) => s === state).length;
}

describe.skipIf(!dockerReady)('evolve multi-round workflow with real Docker container', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalAuth: string | undefined;
  let originalApiKey: string | undefined;
  const liveBundles = new Set<DockerInfrastructure>();
  const liveOrchestrators = new Set<WorkflowOrchestrator>();

  beforeAll(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    originalAuth = process.env.IRONCURTAIN_DOCKER_AUTH;
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.IRONCURTAIN_HOME = TEST_HOME;
    process.env.IRONCURTAIN_DOCKER_AUTH = 'apikey';
    process.env.ANTHROPIC_API_KEY = 'test-fake-key-no-network';
    mkdirSync(TEST_HOME, { recursive: true });
    cpSync(hostCaDir as string, join(TEST_HOME, 'ca'), { recursive: true });
  });

  async function drainFixtures(): Promise<void> {
    const orchestratorResults = await Promise.allSettled(
      [...liveOrchestrators].map(async (orchestrator) => {
        await orchestrator.shutdownAll();
        liveOrchestrators.delete(orchestrator);
      }),
    );
    const bundleResults = await Promise.allSettled(
      [...liveBundles].map(async (bundle) => {
        await destroyDockerInfrastructure(bundle);
        liveBundles.delete(bundle);
      }),
    );
    const failures = [...orchestratorResults, ...bundleResults].filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Docker fixture cleanup failed',
      );
  }

  afterAll(async () => {
    await drainFixtures();

    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    if (originalAuth === undefined) delete process.env.IRONCURTAIN_DOCKER_AUTH;
    else process.env.IRONCURTAIN_DOCKER_AUTH = originalAuth;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;

    rmSync(TEST_HOME, { recursive: true, force: true });
  }, 120_000);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evolve-multi-round-'));
  });

  // Stop workflow activity and containers before deleting their run files.
  afterEach(async () => {
    await drainFixtures();
    rmSync(tmpDir, { recursive: true, force: true });
  }, 120_000);

  async function runEvolve(label: string, mode: RunMode): Promise<{ states: readonly string[]; workspaceDir: string }> {
    const runDir = resolve(tmpDir, `run-${label}`);
    const workspaceDir = resolve(tmpDir, `workspace-${label}`);
    const generatedDir = resolve(TEST_HOME, `generated-${label}`);
    mkdirSync(runDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(resolve(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      const config = buildDockerSessionConfig(input.workspacePath, generatedDir);
      const bundleDir = resolve(TEST_HOME, 'bundles', input.bundleId);
      const escalationDir = resolve(bundleDir, 'escalations');
      mkdirSync(bundleDir, { recursive: true });
      mkdirSync(escalationDir, { recursive: true });
      const bundle = await createDockerInfrastructure(
        config,
        { kind: 'docker', agent: 'claude-code' as AgentId },
        bundleDir,
        input.workspacePath,
        escalationDir,
        input.bundleId,
        input.workflowId,
        input.scope,
        input.resolvedSkills,
        undefined,
        input.workflowScriptsDir,
        { workflowRunDir: input.workflowRunDir },
      );
      liveBundles.add(bundle);
      return bundle;
    });

    const destroyInfra = vi.fn(async (bundle: DockerInfrastructure) => {
      await destroyDockerInfrastructure(bundle);
      liveBundles.delete(bundle);
    });

    // The orchestrator agent is consulted at the start and after each recorded
    // round that did not meet a stop condition; the deterministic stop_check
    // ends the run after the last round without asking it. It always asks for
    // another round here, so the stop must come from stop_check.
    const orchestratorScript =
      mode === 'positive' ? Array.from({ length: ROUND_COUNT }, () => 'design') : ['design', 'design'];

    let provisionTurns = 0;
    let preflightTurns = 0;
    let orchestratorTurns = 0;
    let researcherTurns = 0;
    let analyzerTurns = 0;
    let finalSummaryTurns = 0;
    const createSession = vi.fn(async (options: SessionOptions) => {
      const workspacePath = options.workspacePath;
      if (!workspacePath) throw new Error('workflow agent session missing workspacePath');
      return new MockSession({
        responses: (msg: string) => {
          if (msg.includes('provisioning the Python environment')) {
            provisionTurns += 1;
            writeProvisionMarker(workspacePath);
            return statusBlock('ready', 'provision confirmed');
          }
          if (msg.includes('configuring a multi-round Evolve experiment')) {
            preflightTurns += 1;
            writePreflightRunSpec(workspacePath, ROUND_COUNT);
            return statusBlock('ready', 'preflight confirmed');
          }
          if (msg.includes('You are the Evolve orchestrator')) {
            const verdict = orchestratorScript[orchestratorTurns];
            orchestratorTurns += 1;
            if (!verdict) throw new Error(`orchestrator script exhausted at turn ${orchestratorTurns}`);
            return statusBlock(verdict, `orchestrator turn ${orchestratorTurns}`);
          }
          if (msg.includes('Write exactly one candidate program for this round')) {
            researcherTurns += 1;
            writeCandidate(workspacePath, mode, researcherTurns);
            return approvedResponse(`candidate ${researcherTurns} written`);
          }
          if (msg.includes('write a SHORT transferable lesson')) {
            analyzerTurns += 1;
            writeAnalysis(workspacePath, analyzerTurns);
            return approvedResponse(`analysis ${analyzerTurns} written`);
          }
          if (msg.includes('The Evolve run has reached a stop condition')) {
            finalSummaryTurns += 1;
            writeFinalReport(workspacePath);
            return approvedResponse(`final summary ${finalSummaryTurns} written`);
          }
          throw new Error(`unexpected agent prompt: ${msg.slice(0, 200)}`);
        },
      });
    });
    const raiseGate = vi.fn();

    const orchestrator = new WorkflowOrchestrator(
      createDeps(runDir, {
        createSession,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
        raiseGate,
      }),
    );
    const states: string[] = [];
    liveOrchestrators.add(orchestrator);
    orchestrator.onEvent((event: WorkflowLifecycleEvent) => {
      if (event.kind === 'state_entered') states.push(event.state);
    });

    const manifestPath = resolve(process.cwd(), 'src', 'workflow', 'workflows', 'evolve', 'workflow.yaml');
    const workflowId = await orchestrator.start(manifestPath, TASK, workspaceDir);

    const firstGate = await waitForGate(raiseGate, 1, 180_000);
    expect(firstGate[0].stateName).toBe('preflight_review');
    expect([...firstGate[0].presentedArtifacts.keys()].sort()).toEqual(['cognition_seed', 'run_spec']);
    resolveActiveGate(orchestrator, workflowId, { type: 'APPROVE' });

    if (mode === 'positive') {
      const gates = await waitForGate(raiseGate, 2, 180_000);
      expect(gates[1].stateName).toBe('final_review');
      expect(gates[1].presentedArtifacts.has('final_report')).toBe(true);
      resolveActiveGate(orchestrator, workflowId, { type: 'APPROVE' });
    } else {
      const gates = await waitForGate(raiseGate, 2, 180_000);
      expect(gates[1].stateName).toBe('human_escalation');
      expect(gates[1].acceptedEvents).toEqual(['APPROVE', 'FORCE_REVISION', 'ABORT']);
      expect(gates[1].presentedArtifacts.has('run_spec')).toBe(true);
      expect(gates[1].summary).toContain('verdict: escalate');
      expect(gates[1].summary).toContain('lane 0 blocked');
      resolveActiveGate(orchestrator, workflowId, { type: 'ABORT' });
    }

    await waitForCompletion(orchestrator, workflowId, 180_000);
    await orchestrator.shutdownAll();

    expect(provisionTurns).toBe(1);
    expect(preflightTurns).toBe(1);
    if (mode === 'positive') {
      expect(orchestratorTurns).toBe(ROUND_COUNT);
      expect(researcherTurns).toBe(ROUND_COUNT);
      expect(analyzerTurns).toBe(ROUND_COUNT);
      expect(finalSummaryTurns).toBe(1);
    } else {
      expect(orchestratorTurns).toBe(2);
      expect(researcherTurns).toBe(2);
      expect(analyzerTurns).toBe(1);
      expect(finalSummaryTurns).toBe(0);
    }

    return { states, workspaceDir };
  }

  it('runs three rounds to done with parents, analyses, cognition, best, and deterministic vectors', async () => {
    const first = await runEvolve('positive-a', 'positive');
    const second = await runEvolve('positive-b', 'positive');
    const runDir = resolve(first.workspaceDir, '.evolve_runs', 'main');
    const secondRunDir = resolve(second.workspaceDir, '.evolve_runs', 'main');

    expect(first.states.at(-1)).toBe('done');
    expect(first.states).not.toContain('failed');
    expect(first.states[0]).toBe('provision');
    expect(first.states).toContain('preflight_review');
    expect(first.states).toContain('final_summary');
    expect(first.states).toContain('final_review');
    expect(countStates(first.states, 'workers')).toBe(ROUND_COUNT);
    expect(countStates(first.states, 'stop_check')).toBe(ROUND_COUNT);
    expect(countStates(first.states, 'orchestrator')).toBe(ROUND_COUNT);

    const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as NodesFile;
    expect(nodes.next_id).toBe(ROUND_COUNT);
    expect(Object.keys(nodes.nodes)).toEqual(['0', '1', '2']);
    expect(nodes.nodes['0'].parent).toEqual([]);
    expect(nodes.nodes['1'].parent.length).toBeGreaterThan(0);
    expect(nodes.nodes['1'].parent[0]).toBeLessThan(1);
    expect(nodes.nodes['2'].parent.length).toBeGreaterThan(0);
    expect(nodes.nodes['2'].parent[0]).toBeLessThan(2);
    expect(Object.values(nodes.nodes).every((node) => node.analysis.trim().length > 0)).toBe(true);

    const scores = Object.keys(nodes.nodes)
      .sort()
      .map((id) => nodes.nodes[id].score);
    expect(scores).toEqual([2, 5, 6]);
    expect(scores[0]).toBeLessThanOrEqual(scores[1]);
    expect(scores[1]).toBeLessThanOrEqual(scores[2]);

    const cognition = readJson(resolve(runDir, 'cognition_data', 'cognition.json')) as {
      items: Record<string, unknown>;
    };
    expect(Object.keys(cognition.items).length).toBeGreaterThanOrEqual(1);
    const finalContext = readJson(resolve(runDir, 'current', 'context.json')) as {
      cognition: { matches: readonly unknown[] };
    };
    expect(finalContext.cognition.matches.length).toBeGreaterThanOrEqual(1);

    const bestScores = readdirSync(resolve(runDir, 'best'))
      .map((entry) => readJson(resolve(runDir, 'best', entry, 'results.json')) as { eval_score: number })
      .map((result) => result.eval_score);
    expect(Math.max(...bestScores)).toBe(Math.max(...scores));
    expect(
      readFileSync(resolve(first.workspaceDir, '.workflow', 'final_report', 'final_report.md'), 'utf-8'),
    ).toContain('Best node');

    const firstVectorStore = readFileSync(resolve(runDir, 'database_data', 'faiss', 'vector_store.pkl'));
    const secondVectorStore = readFileSync(resolve(secondRunDir, 'database_data', 'faiss', 'vector_store.pkl'));
    expect(firstVectorStore.equals(secondVectorStore)).toBe(true);

    const secondNodes = readJson(resolve(secondRunDir, 'database_data', 'nodes.json')) as NodesFile;
    expect(stripCreatedAt(nodes)).toEqual(stripCreatedAt(secondNodes));
  }, 300_000);

  it('routes a mid-loop evaluator crash to human_escalation without a partial second node', async () => {
    const { states, workspaceDir } = await runEvolve('crash', 'crash-round-2');
    const runDir = resolve(workspaceDir, '.evolve_runs', 'main');

    expect(states.at(-1)).toBe('aborted');
    expect(states[0]).toBe('provision');
    expect(states).toContain('human_escalation');
    expect(states).not.toContain('failed');
    expect(countStates(states, 'workers')).toBe(2);
    expect(countStates(states, 'evaluate')).toBe(0);
    expect(countStates(states, 'analysis_record')).toBe(0);
    const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as NodesFile;
    expect(Object.keys(nodes.nodes)).toEqual(['0']);
    expect((readJson(resolve(runDir, 'current', 'result.json')) as { verdict: string }).verdict).toBe(
      'evaluator_blocked',
    );
  }, 300_000);
});
