/**
 * Evolve's round budget is enforced deterministically (WFE-14): after every
 * recorded round the `stop_check` state runs the bridge's `stop_check` over
 * the durable node database, and its verdict — not the orchestrator agent's —
 * decides whether the search continues.
 *
 * Drives the real evolve workflow.yaml through the real orchestrator without
 * Docker: the shared-container bundle is a stub whose `docker.exec` plays the
 * per-round bridge steps (sample / evaluate / attach_analysis) by writing their
 * result files, and runs the REAL `evolve_result.py stop_check` on the host for
 * the stop decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  WorkflowOrchestrator,
  type CreateWorkflowInfrastructureInput,
  type WorkflowLifecycleEvent,
} from '../../src/workflow/orchestrator.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import type { DockerExecResult } from '../../src/docker/types.js';
import {
  MockSession,
  approvedResponse,
  createDeps,
  evolveNode,
  resolveActiveGate,
  statusBlock,
  unwrapBoundedCommand,
  waitForCompletion,
  waitForGate,
  writeNodesFile,
} from './test-helpers.js';

const PYTHON = process.env.PYTHON ?? 'python3';
const EVOLVE_DIR = resolve(__dirname, '..', '..', 'src', 'workflow', 'workflows', 'evolve');
const MANIFEST = resolve(EVOLVE_DIR, 'workflow.yaml');
const BRIDGE = resolve(EVOLVE_DIR, 'scripts', 'evolve_result.py');
const MAX_ROUNDS = 2;

describe('evolve round budget', () => {
  let tmpDir: string;
  let workspaceDir: string;
  let orchestrator: WorkflowOrchestrator | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evolve-stop-'));
    workspaceDir = resolve(tmpDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    workspaceDir = realpathSync(workspaceDir);
  });

  afterEach(async () => {
    await orchestrator?.shutdownAll();
    orchestrator = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Maps a container path under /workspace onto the host workspace. */
  function hostPath(containerPath: string): string {
    if (!containerPath.startsWith('/workspace/')) throw new Error(`unexpected container path ${containerPath}`);
    return resolve(workspaceDir, containerPath.slice('/workspace/'.length));
  }

  function flagValue(argv: readonly string[], flag: string): string {
    const index = argv.indexOf(flag);
    if (index < 0) throw new Error(`missing ${flag} in ${argv.join(' ')}`);
    return argv[index + 1];
  }

  function writeJson(path: string, value: unknown): void {
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  }

  /** Plays the evolve bridge inside the "container". */
  function makeExec(recordedRounds: { count: number }) {
    return vi.fn(async (_container: string, bounded: readonly string[]): Promise<DockerExecResult> => {
      const argv = unwrapBoundedCommand(bounded);
      const subcommand = argv[2];
      const runDir = hostPath(flagValue(argv, '--run-dir'));
      const resultFile = hostPath(flagValue(argv, '--result-file'));
      const step = `step_${String(recordedRounds.count + 1).padStart(4, '0')}`;
      switch (subcommand) {
        case 'sample':
          writeJson(hostPath(flagValue(argv, '--context-file')), { step_name: step, parents: [] });
          writeJson(resultFile, { verdict: 'sampled', passed: true, payload: { step_name: step } });
          return { exitCode: 0, stdout: '', stderr: '' };
        case 'evaluate':
          writeJson(resultFile, { verdict: 'evaluated', passed: true, payload: { score: 1 } });
          return { exitCode: 0, stdout: '', stderr: '' };
        case 'attach_analysis': {
          const nodes: Record<string, unknown> = {};
          for (let id = 0; id <= recordedRounds.count; id += 1) {
            nodes[String(id)] = evolveNode({
              id,
              name: `round-${id + 1}`,
              parent: id === 0 ? [] : [id - 1],
              score: id + 1,
              analysis: `lesson ${id + 1}`,
              batchIndex: id + 1,
            });
          }
          writeNodesFile(resolve(runDir, 'database_data'), nodes, false);
          writeJson(resultFile, { verdict: 'recorded', passed: true, payload: { node_id: recordedRounds.count } });
          recordedRounds.count += 1;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        case 'stop_check': {
          // The production stop decision, run on the host.
          const run = spawnSync(PYTHON, [BRIDGE, 'stop_check', '--run-dir', runDir, '--result-file', resultFile], {
            encoding: 'utf-8',
          });
          return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
        }
        default:
          return { exitCode: 2, stdout: '', stderr: `unexpected bridge command ${argv.join(' ')}` };
      }
    });
  }

  it('stops on the deterministic signal even when the orchestrator agent asks for another design', async () => {
    const recordedRounds = { count: 0 };
    const exec = makeExec(recordedRounds);
    const createInfra = vi.fn(
      async (input: CreateWorkflowInfrastructureInput) =>
        ({
          __stub: true,
          workflowId: input.workflowId,
          bundleId: input.bundleId,
          containerId: 'evolve-container',
          runtimeKind: 'docker',
          docker: { exec, supportsImageSnapshots: false },
          setTokenSessionId: () => {},
          beginCaptureSession: () => {},
          endCaptureSession: async () => {},
        }) as unknown as DockerInfrastructure,
    );

    let orchestratorTurns = 0;
    let finalSummaryTurns = 0;
    const createSession = vi.fn(
      async () =>
        new MockSession({
          responses: (msg: string) => {
            if (msg.includes('provisioning the Python environment')) return statusBlock('ready', 'provisioned');
            if (msg.includes('configuring a multi-round Evolve experiment')) {
              const runDir = resolve(workspaceDir, '.evolve_runs', 'main');
              writeJson(resolve(runDir, 'run_spec.yaml'), {
                objective: 'maximize the score',
                evaluation: { core_score: 'eval_score', success_criteria: ['eval_score >= 99'] },
                budget: { max_rounds: MAX_ROUNDS, patience: 5 },
              });
              writeJson(resolve(workspaceDir, '.workflow', 'run_spec', 'run_spec.md'), { ok: true });
              writeJson(resolve(workspaceDir, '.workflow', 'cognition_seed', 'cognition_seed.md'), { ok: true });
              return statusBlock('ready', 'preflight confirmed');
            }
            if (msg.includes('You are the Evolve orchestrator')) {
              // A confused or prompt-injected orchestrator that never stops.
              orchestratorTurns += 1;
              return statusBlock('design', `orchestrator turn ${orchestratorTurns}: one more round`);
            }
            if (msg.includes('Write exactly one candidate program for this round'))
              return approvedResponse('candidate');
            if (msg.includes('write a SHORT transferable lesson')) return approvedResponse('lesson');
            if (msg.includes('The Evolve run has reached a stop condition')) {
              finalSummaryTurns += 1;
              writeJson(resolve(workspaceDir, '.workflow', 'final_report', 'final_report.md'), { ok: true });
              return approvedResponse('report');
            }
            throw new Error(`unexpected agent prompt: ${msg.slice(0, 120)}`);
          },
        }),
    );

    const raiseGate = vi.fn();
    orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: async () => {},
        raiseGate,
      }),
    );
    const states: string[] = [];
    orchestrator.onEvent((event: WorkflowLifecycleEvent) => {
      if (event.kind === 'state_entered') states.push(event.state);
    });

    const workflowId = await orchestrator.start(MANIFEST, 'evolve a score function', workspaceDir);
    const [preflightGate] = await waitForGate(raiseGate, 1, 15_000);
    expect(preflightGate.stateName).toBe('preflight_review');
    resolveActiveGate(orchestrator, workflowId, { type: 'APPROVE' });

    const gates = await waitForGate(raiseGate, 2, 15_000);
    expect(gates[1].stateName).toBe('final_review');

    // Two rounds recorded (max_rounds), then the stop check ended the search:
    // the agent was asked only before each round, and its third "design" was
    // never requested.
    expect(recordedRounds.count).toBe(MAX_ROUNDS);
    expect(orchestratorTurns).toBe(MAX_ROUNDS);
    expect(states.filter((state) => state === 'workers')).toHaveLength(MAX_ROUNDS);
    expect(states.filter((state) => state === 'stop_check')).toHaveLength(MAX_ROUNDS);
    expect(states.slice(-3)).toEqual(['stop_check', 'final_summary', 'final_review']);
    const verdict = JSON.parse(
      readFileSync(resolve(workspaceDir, '.evolve_runs', 'main', 'current', 'stop_check.json'), 'utf-8'),
    ) as { verdict: string; payload: { stop_reason: string; done_rounds: number } };
    expect(verdict).toMatchObject({ verdict: 'stop', payload: { stop_reason: 'max_rounds', done_rounds: 2 } });
    expect(existsSync(resolve(workspaceDir, '.evolve_runs', 'main', 'current', 'stop_signals.json'))).toBe(true);

    resolveActiveGate(orchestrator, workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator, workflowId, 15_000);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    expect(finalSummaryTurns).toBe(1);
  }, 30_000);
});
