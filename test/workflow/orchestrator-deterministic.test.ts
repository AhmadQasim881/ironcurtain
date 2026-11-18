import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DETERMINISTIC_RESULT_ERROR_VERDICT,
  type WorkflowDefinition,
  type WorkflowId,
} from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import type { DockerExecResult } from '../../src/docker/types.js';
import type { WorkflowPythonVenvLayer } from '../../src/docker/workflow-dependency-cache.js';
import {
  TIMEOUT_BINARY,
  TURN_KILL_SWEEP_SCRIPT,
  TURN_KILL_SWEEP_TIMEOUT_MS,
  TURN_MARKER_ENV,
} from '../../src/docker/turn-timeout.js';
import type { DeterministicInvokeInput, DeterministicInvokeResult } from '../../src/workflow/machine-builder.js';
import { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import { createCheckpointStore, createDeps, waitForCompletion, writeDefinitionFile } from './test-helpers.js';
import { killPids, waitForTreePids, waitUntilDead, writeTreeScript } from './host-process-helpers.js';

// ---------------------------------------------------------------------------
// Focused unit tests for the deterministic-execution dispatch in
// IronCurtainWorkflowOrchestrator. The methods under test
// (`executeDeterministicState`, `runDeterministicHost`,
// `runDeterministicInContainer`) are private; we drive them directly via
// bracket access on the orchestrator and register a synthetic
// WorkflowInstance into the private `workflows` map. This is the focused
// unit-test seam the design's §11 #3/#4/#10 prescribe — no full XState
// machine is spun up because the dispatch logic is independent of the FSM.
// ---------------------------------------------------------------------------

// A WorkflowId is a branded string; cast a plain string for tests.
const WF_ID = 'wf-deterministic-test' as WorkflowId;

const sharedContainerDef: WorkflowDefinition = {
  name: 'deterministic-dispatch',
  description: 'Docker shared-container workflow with a container deterministic state',
  initial: 'work',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    work: {
      type: 'agent',
      description: 'mints the bundle',
      persona: 'global',
      prompt: 'work',
      inputs: [],
      outputs: ['result'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

/**
 * Builds a stub DockerInfrastructure with a mocked `docker.exec`. The
 * orchestrator only touches `containerId` and `docker.exec` on the
 * deterministic-in-container path; everything else is irrelevant.
 */
function makeStubBundle(
  containerId: string,
  exec: (
    nameOrId: string,
    command: readonly string[],
    timeoutMs?: number,
    execUser?: string | null,
    workdir?: string,
    environment?: Readonly<Record<string, string>>,
  ) => Promise<DockerExecResult>,
): { bundle: DockerInfrastructure; exec: ReturnType<typeof vi.fn> } {
  const execMock = vi.fn(exec);
  const bundle = {
    containerId,
    docker: { exec: execMock },
  } as unknown as DockerInfrastructure;
  return { bundle, exec: execMock };
}

/**
 * Registers a minimal synthetic WorkflowInstance into the orchestrator's
 * private `workflows` map so `executeDeterministicState` can resolve it.
 * Only the fields the dispatch path reads are populated; the rest are
 * irrelevant for these focused unit tests.
 */
function registerInstance(
  orchestrator: WorkflowOrchestrator,
  definition: WorkflowDefinition,
  bundlesByScope: Map<string, DockerInfrastructure>,
  workspacePath: string,
): { readonly stopController: AbortController } {
  const instance = {
    id: WF_ID,
    definition,
    bundlesByScope,
    workspacePath,
    stopController: new AbortController(),
  };
  // Private map; bracket access is the focused-unit-test seam.
  (orchestrator as unknown as { workflows: Map<WorkflowId, unknown> }).workflows.set(WF_ID, instance);
  return instance;
}

function callApplyResultFile(
  orchestrator: WorkflowOrchestrator,
  workspacePath: string,
  input: DeterministicInvokeInput,
  base: DeterministicInvokeResult,
): DeterministicInvokeResult {
  return (
    orchestrator as unknown as {
      applyResultFile: (
        instance: { workspacePath: string },
        input: DeterministicInvokeInput,
        base: DeterministicInvokeResult,
      ) => DeterministicInvokeResult;
    }
  ).applyResultFile({ workspacePath }, input, base);
}

/** Invokes the private executeDeterministicState through bracket access. */
function callExecuteDeterministicState(
  orchestrator: WorkflowOrchestrator,
  workflowId: WorkflowId,
  input: DeterministicInvokeInput,
  signal?: AbortSignal,
): Promise<DeterministicInvokeResult> {
  return (
    orchestrator as unknown as {
      executeDeterministicState: (
        id: WorkflowId,
        input: DeterministicInvokeInput,
        signal?: AbortSignal,
      ) => Promise<DeterministicInvokeResult>;
    }
  ).executeDeterministicState(workflowId, input, signal);
}

const TASK_CONTEXT = { taskDescription: 'task' } as DeterministicInvokeInput['context'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The in-container wall-clock prefix every container command gets (`timeoutMs` in ms). */
function boundedPrefix(timeoutMs: number): string[] {
  return [TIMEOUT_BINARY, '--kill-after=10', String(timeoutMs / 1000)];
}

/** Host backstop of a container command: the limit plus the kill grace and slack. */
function hostBackstopMs(timeoutMs: number): number {
  return timeoutMs + 10_000 + 15_000;
}

/** True for the marker sweep exec (see turn-timeout.ts), as opposed to a command. */
function isSweep(argv: readonly string[]): boolean {
  return argv[0] === '/bin/sh' && argv[3] === 'ironcurtain-turn-kill';
}

/** The turn marker a command exec carried in its environment. */
function markerOf(call: readonly unknown[]): string {
  const environment = call[5] as Record<string, string> | undefined;
  const id = environment?.[TURN_MARKER_ENV];
  if (id === undefined) throw new Error('exec carried no turn marker');
  return id;
}

describe('WorkflowOrchestrator deterministic execution dispatch', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'deterministic-dispatch-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // §11 #3 + #10 — host-branch dispatch + byte-identity backward-compat gate
  // -------------------------------------------------------------------------

  describe('host branch (container absent/false, host: true)', () => {
    it('routes to the host branch and never touches docker when container is absent', async () => {
      const exec = vi.fn(async (): Promise<DockerExecResult> => ({ exitCode: 0, stdout: '', stderr: '' }));
      const bundles = new Map<string, DockerInfrastructure>([['primary', makeStubBundle('cid', exec).bundle]]);
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, bundles, tmpDir);

      // A real host command that prints a stdout test-count line. `node -e`
      // exercises the actual host runner (no spawn mocking).
      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['node', '-e', "process.stdout.write('7 tests pass')"]],
        context: TASK_CONTEXT,
        host: true,
        // container omitted entirely (the default backward-compat path)
      });

      expect(result).toEqual({ passed: true, testCount: 7, errors: undefined });
      expect(exec).not.toHaveBeenCalled();
    });

    it('host success path: passed true, no testCount when stdout lacks the regex', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['node', '-e', "process.stdout.write('all good')"]],
        context: TASK_CONTEXT,
        container: false,
        host: true,
      });

      expect(result).toEqual({ passed: true, testCount: undefined, errors: undefined });
    });

    it('host failure path: non-zero exit captures stderr into errors and flips passed', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['node', '-e', "process.stderr.write('boom'); process.exit(1)"]],
        context: TASK_CONTEXT,
        container: false,
        host: true,
      });

      expect(result.passed).toBe(false);
      expect(result.testCount).toBeUndefined();
      expect(result.errors).toContain('boom');
    });

    it('host test-count regex sums across commands', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [
          ['node', '-e', "process.stdout.write('3 tests pass')"],
          ['node', '-e', "process.stdout.write('4 specs pass')"],
        ],
        context: TASK_CONTEXT,
        container: false,
        host: true,
      });

      expect(result).toEqual({ passed: true, testCount: 7, errors: undefined });
    });

    it('surfaces the stdout of a failing command that writes nothing to stderr', async () => {
      // pytest and many other runners report failures on stdout only. The old
      // `stderr ?? stdout` never fell back: an empty stderr string won.
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['node', '-e', "process.stdout.write('FAILED test_parse - AssertionError'); process.exit(1)"]],
        context: TASK_CONTEXT,
        host: true,
      });

      expect(result.passed).toBe(false);
      expect(result.errors).toBe('FAILED test_parse - AssertionError');
    });

    it('describes a missing program instead of reporting an empty error', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['ironcurtain-missing-toolchain-xyz', 'test']],
        context: TASK_CONTEXT,
        host: true,
      });

      expect(result.passed).toBe(false);
      expect(result.errors).toContain('cannot start command "ironcurtain-missing-toolchain-xyz"');
      expect(result.errors).toContain('ENOENT');
    });

    it('does not fail a passing command for output over the old 1 MiB buffer', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['node', '-e', "process.stdout.write('.'.repeat(2 * 1024 * 1024) + '\\n9 tests pass\\n')"]],
        context: TASK_CONTEXT,
        host: true,
      });

      expect(result).toEqual({ passed: true, testCount: 9, errors: undefined });
    });

    it('runs each command in the run workspace', async () => {
      const workspace = join(tmpDir, 'workspace');
      mkdirSync(workspace);
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), workspace);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['node', '-e', "require('fs').writeFileSync('cwd.txt', process.cwd())"]],
        context: TASK_CONTEXT,
        host: true,
      });

      expect(result.passed).toBe(true);
      expect(realpathSync(readFileSync(join(workspace, 'cwd.txt'), 'utf8'))).toBe(realpathSync(workspace));
    });

    it('closes stdin, so a command waiting for input finishes instead of hanging', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [
          ['node', '-e', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('1 test pass'))"],
        ],
        context: TASK_CONTEXT,
        host: true,
        timeoutMs: 20_000,
      });

      expect(result).toEqual({ passed: true, testCount: 1, errors: undefined });
    });

    it.skipIf(process.platform === 'win32')(
      'kills a hung command and its grandchildren at timeoutMs and fails the state',
      async () => {
        const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
        registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);
        const pidFile = join(tmpDir, 'pids.json');

        const started = Date.now();
        const pending = callExecuteDeterministicState(orchestrator, WF_ID, {
          stateId: 'check',
          commands: [['node', writeTreeScript(tmpDir), pidFile]],
          context: TASK_CONTEXT,
          host: true,
          timeoutMs: 5_000,
        });
        const pids = await waitForTreePids(pidFile);
        const result = await pending;
        const elapsed = Date.now() - started;
        const alive = await waitUntilDead([pids.child, pids.grandchild]);
        killPids(alive);

        expect(alive).toEqual([]);
        expect(elapsed).toBeLessThan(20_000);
        expect(result.passed).toBe(false);
        expect(result.errors).toContain('timed out after 5000 ms');
      },
    );

    it.skipIf(process.platform === 'win32')(
      'kills a hung sleep tree (shell plus background sleep) at timeoutMs',
      async () => {
        const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
        registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);
        const pidFile = join(tmpDir, 'bg.pid');

        const started = Date.now();
        // The shell records its background sleeper (a grandchild of the
        // runner) and then blocks in a foreground sleep of its own.
        const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
          stateId: 'check',
          commands: [['sh', '-c', `sleep 60 & echo $! > '${pidFile}'; sleep 60`]],
          context: TASK_CONTEXT,
          host: true,
          timeoutMs: 3_000,
        });
        const elapsed = Date.now() - started;
        const alive = await waitUntilDead([Number(readFileSync(pidFile, 'utf8').trim())]);
        killPids(alive);

        expect(alive).toEqual([]);
        expect(elapsed).toBeLessThan(20_000);
        expect(result.passed).toBe(false);
        expect(result.errors).toContain('timed out after 3000 ms');
      },
    );

    it.skipIf(process.platform === 'win32')(
      'kills the running command when the run stops (stopController) and starts no further commands',
      async () => {
        const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
        const instance = registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);
        const pidFile = join(tmpDir, 'pids.json');
        const secondMarker = join(tmpDir, 'second-ran');

        const pending = callExecuteDeterministicState(orchestrator, WF_ID, {
          stateId: 'check',
          commands: [
            ['node', writeTreeScript(tmpDir), pidFile],
            ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(secondMarker)}, '')`],
          ],
          context: TASK_CONTEXT,
          host: true,
          timeoutMs: 120_000,
        });
        const pids = await waitForTreePids(pidFile);
        instance.stopController.abort();
        const result = await pending;
        const alive = await waitUntilDead([pids.child, pids.grandchild]);
        killPids(alive);

        expect(alive).toEqual([]);
        expect(result.passed).toBe(false);
        expect(result.errors).toContain('the workflow is stopping');
        expect(existsSync(secondMarker)).toBe(false);
      },
    );

    it.skipIf(process.platform === 'win32')('kills the running command when the invoke signal aborts', async () => {
      // A drained fan-out lane: XState stops the lane's invoke, aborting its signal.
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);
      const pidFile = join(tmpDir, 'pids.json');
      const invoke = new AbortController();

      const pending = callExecuteDeterministicState(
        orchestrator,
        WF_ID,
        {
          stateId: 'check',
          commands: [['node', writeTreeScript(tmpDir), pidFile]],
          context: TASK_CONTEXT,
          host: true,
          timeoutMs: 120_000,
        },
        invoke.signal,
      );
      const pids = await waitForTreePids(pidFile);
      invoke.abort();
      const result = await pending;
      const alive = await waitUntilDead([pids.child, pids.grandchild]);
      killPids(alive);

      expect(alive).toEqual([]);
      expect(result.passed).toBe(false);
    });
  });

  describe('host branch without the host: true acknowledgement', () => {
    it('refuses to run the commands and throws so the state routes to its error target', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);
      const marker = join(tmpDir, 'ran');

      await expect(
        callExecuteDeterministicState(orchestrator, WF_ID, {
          stateId: 'check',
          commands: [['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`]],
          context: TASK_CONTEXT,
          container: false,
        }),
      ).rejects.toThrow(/State "check" would run its commands on the host but does not set host: true/);
      expect(existsSync(marker)).toBe(false);
    });

    it('lets a state with no non-empty command through (nothing runs on the host)', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'noop',
        commands: [[]],
        context: TASK_CONTEXT,
      });

      expect(result).toEqual({ passed: true, testCount: undefined, errors: undefined });
    });
  });

  // -------------------------------------------------------------------------
  // §11 #3 + #4 — container-branch dispatch + runDeterministicInContainer
  // -------------------------------------------------------------------------

  describe('container branch (container: true)', () => {
    it('routes to the live bundle and calls docker.exec with the verbatim argv, workdir, and user', async () => {
      const { bundle, exec } = makeStubBundle('container-xyz', async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
      }));
      const bundles = new Map<string, DockerInfrastructure>([['primary', bundle]]);
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, bundles, tmpDir);

      await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['python', '/workflow-scripts/run_eval.py', '--json']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
        timeoutMs: 4242,
      });

      expect(exec).toHaveBeenCalledTimes(1);
      // (containerId, the in-container wall clock + verbatim argv, its host
      // backstop, 'codespace', '/workspace', the command's marker)
      expect(exec).toHaveBeenCalledWith(
        'container-xyz',
        [...boundedPrefix(4242), 'python', '/workflow-scripts/run_eval.py', '--json'],
        hostBackstopMs(4242),
        'codespace',
        '/workspace',
        { [TURN_MARKER_ENV]: expect.stringMatching(UUID_PATTERN) as unknown },
      );
      // No shell wrapper: the argv has no `sh`/`-c` tokens.
      const argv = exec.mock.calls[0][1] as string[];
      expect(argv.slice(3)[0]).toBe('python');
      expect(argv).not.toContain('-c');
      expect(argv).not.toContain('sh');
    });

    it('execs as the numeric agent UID of a sudo-off bundle, never by account name (DINF-3)', async () => {
      const { bundle, exec } = makeStubBundle('container-sudo-off', async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
      }));
      const bundles = new Map<string, DockerInfrastructure>([['primary', { ...bundle, agentExecUser: '1000' }]]);
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, bundles, tmpDir);

      await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['python', '/workflow-scripts/run_eval.py']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      expect(exec).toHaveBeenCalledWith(
        'container-sudo-off',
        [...boundedPrefix(600_000), 'python', '/workflow-scripts/run_eval.py'],
        hostBackstopMs(600_000),
        '1000',
        '/workspace',
        { [TURN_MARKER_ENV]: expect.stringMatching(UUID_PATTERN) as unknown },
      );
    });

    it('exit code 0 => passed true', async () => {
      const { bundle } = makeStubBundle('cid', async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['true']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      expect(result).toEqual({ passed: true, testCount: undefined, errors: undefined });
    });

    it('non-zero exit => passed false with stderr captured in errors', async () => {
      const { bundle } = makeStubBundle('cid', async () => ({
        exitCode: 2,
        stdout: 'partial out',
        stderr: 'something failed',
      }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['python', '/workflow-scripts/run_eval.py']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      expect(result.passed).toBe(false);
      expect(result.errors).toBe('something failed');
      expect(result.testCount).toBeUndefined();
    });

    it('falls back to stdout in errors when a failing command produces no stderr', async () => {
      const { bundle } = makeStubBundle('cid', async () => ({
        exitCode: 3,
        stdout: 'only-stdout',
        stderr: '',
      }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['python', 'x.py']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      expect(result.passed).toBe(false);
      expect(result.errors).toBe('only-stdout');
    });

    it('mines testCount from stdout on a passing container command', async () => {
      const { bundle } = makeStubBundle('cid', async () => ({
        exitCode: 0,
        stdout: 'running suite...\n7 tests pass\n',
        stderr: '',
      }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['python', '/workflow-scripts/run_eval.py']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      expect(result).toEqual({ passed: true, testCount: 7, errors: undefined });
    });

    it('skips empty [] commands without calling docker.exec', async () => {
      const { bundle, exec } = makeStubBundle('cid', async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [[], ['node', '/workflow-scripts/lint.js'], []],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      // Only the single non-empty command reaches docker.exec.
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec.mock.calls[0][1]).toEqual([...boundedPrefix(600_000), 'node', '/workflow-scripts/lint.js']);
      expect(result.passed).toBe(true);
    });

    it('targets the requested containerScope bundle', async () => {
      const primary = makeStubBundle('primary-cid', async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      const coder = makeStubBundle('coder-cid', async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      const bundles = new Map<string, DockerInfrastructure>([
        ['primary', primary.bundle],
        ['coder', coder.bundle],
      ]);
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, bundles, tmpDir);

      await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['node', 'lint.js']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
        containerScope: 'coder',
      });

      expect(coder.exec).toHaveBeenCalledWith(
        'coder-cid',
        [...boundedPrefix(600_000), 'node', 'lint.js'],
        hostBackstopMs(600_000),
        'codespace',
        '/workspace',
        { [TURN_MARKER_ENV]: expect.stringMatching(UUID_PATTERN) as unknown },
      );
      expect(primary.exec).not.toHaveBeenCalled();
    });

    it('errors when container is requested but the workflow is not shared-container mode', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      const nonShared: WorkflowDefinition = {
        ...sharedContainerDef,
        settings: { mode: 'docker', dockerAgent: 'claude-code' },
      };
      registerInstance(orchestrator, nonShared, new Map(), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['node', 'lint.js']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      expect(result.passed).toBe(false);
      expect(result.errors).toContain('shared-container');
    });

    it('errors when the workflow id is unknown', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      // Note: no instance registered.

      const result = await callExecuteDeterministicState(orchestrator, 'missing' as WorkflowId, {
        stateId: 'check',
        commands: [['node', 'lint.js']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      expect(result.passed).toBe(false);
      expect(result.errors).toContain('not found');
    });
  });

  // The run's single stop signal (`stopController`, aborted by abort() before
  // its first await) reaches both paths: the host runner kills and refuses
  // commands (see the host branch above), the container path checks it
  // before each `docker exec` and before reading the result file, and
  // sweeps a command it interrupts (see below).
  describe('run stop (WP-48)', () => {
    it('a stopping run starts no command on the host or in the container', async () => {
      const { bundle, exec } = makeStubBundle('container-xyz', async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      const instance = registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);
      const marker = join(tmpDir, 'host-ran');
      instance.stopController.abort();

      await expect(
        callExecuteDeterministicState(orchestrator, WF_ID, {
          stateId: 'check',
          commands: [['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`]],
          context: TASK_CONTEXT,
          host: true,
        }),
      ).rejects.toThrow(/is stopping; not starting deterministic state "check"/);
      await expect(
        callExecuteDeterministicState(orchestrator, WF_ID, {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: TASK_CONTEXT,
          container: true,
        }),
      ).rejects.toThrow(/is stopping/);

      expect(existsSync(marker)).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });

    it('a run that stops during a container command starts no further command and reads no result file', async () => {
      mkdirSync(join(tmpDir, '.workflow'), { recursive: true });
      writeFileSync(join(tmpDir, '.workflow', 'result.json'), JSON.stringify({ verdict: 'pass' }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      let stopRun = (): void => {};
      const { bundle, exec } = makeStubBundle('container-xyz', async () => {
        // The run is aborted while this command is still running in the container.
        stopRun();
        return { exitCode: 0, stdout: '', stderr: '' };
      });
      const instance = registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);
      stopRun = () => instance.stopController.abort();

      await expect(
        callExecuteDeterministicState(orchestrator, WF_ID, {
          stateId: 'check',
          commands: [
            ['node', 'first.js'],
            ['node', 'second.js'],
          ],
          context: TASK_CONTEXT,
          container: true,
          resultFile: '.workflow/result.json',
        }),
      ).rejects.toThrow(/is stopping/);
      // The first command, then the sweep of its processes; never the second.
      const calls = exec.mock.calls.map((call) => call[1] as string[]);
      expect(calls).toHaveLength(2);
      expect(calls[0].slice(-2)).toEqual(['node', 'first.js']);
      expect(isSweep(calls[1])).toBe(true);
    });
  });

  // The host deadline of `docker exec` only kills the host CLI client; the
  // command keeps running in the shared container. Each container command
  // therefore runs under coreutils `timeout` with its own marker, and a
  // timeout or a stop sweeps its processes inside the container (FU-17).
  describe('container wall clock and stop sweep', () => {
    it('runs each command under coreutils timeout with its own marker and a longer host backstop', async () => {
      const { bundle, exec } = makeStubBundle('cid', async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [
          ['python', 'a.py'],
          ['node', 'b.js'],
        ],
        context: TASK_CONTEXT,
        container: true,
        timeoutMs: 2000,
      });

      expect(result.passed).toBe(true);
      expect(exec).toHaveBeenCalledTimes(2);
      const [first, second] = exec.mock.calls;
      expect(first).toEqual([
        'cid',
        ['/usr/bin/timeout', '--kill-after=10', '2', 'python', 'a.py'],
        27_000,
        'codespace',
        '/workspace',
        { [TURN_MARKER_ENV]: expect.stringMatching(UUID_PATTERN) as unknown },
      ]);
      expect(second[1]).toEqual([...boundedPrefix(2000), 'node', 'b.js']);
      expect(markerOf(second)).not.toBe(markerOf(first));
    });

    it('applies the 10-minute default and puts the timeout outside the dependency PATH wrapper', async () => {
      const { bundle, exec } = makeStubBundle('cid', async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      // Only the layer's presence matters: it puts the venv's bin on the PATH.
      const pythonVenv: WorkflowPythonVenvLayer = {
        kind: 'python-venv',
        target: '/y',
        hostDir: '/x',
        cacheKey: 'k',
        cacheRoot: '/c',
        baseDir: '/c/python-venv',
        manifests: {},
      };
      const withDeps: DockerInfrastructure = { ...bundle, workflowPythonVenvMount: pythonVenv };
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', withDeps]]), tmpDir);

      await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['python', 'x.py']],
        context: TASK_CONTEXT,
        container: true,
      });

      const [, argv, hostTimeout] = exec.mock.calls[0] as [string, string[], number];
      expect(argv.slice(0, 5)).toEqual([...boundedPrefix(600_000), '/bin/sh', '-lc']);
      expect(argv.slice(-3)).toEqual(['sh', 'python', 'x.py']);
      expect(hostTimeout).toBe(hostBackstopMs(600_000));
    });

    it('sweeps a timed-out command by its marker as the exec user and reports the timeout', async () => {
      const { bundle, exec } = makeStubBundle('cid', async (_id, argv) =>
        isSweep(argv)
          ? { exitCode: 0, stdout: '2\n', stderr: '' }
          : { exitCode: 124, stdout: 'collected 40 items', stderr: '', timedOut: true },
      );
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(
        orchestrator,
        sharedContainerDef,
        new Map([['primary', { ...bundle, agentExecUser: '1000' }]]),
        tmpDir,
      );

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['pytest', '-x']],
        context: TASK_CONTEXT,
        container: true,
        timeoutMs: 2000,
      });

      expect(exec).toHaveBeenCalledTimes(2);
      const [command, sweep] = exec.mock.calls;
      expect(command[3]).toBe('1000');
      expect(sweep).toEqual([
        'cid',
        ['/bin/sh', '-c', TURN_KILL_SWEEP_SCRIPT, 'ironcurtain-turn-kill', `${TURN_MARKER_ENV}=${markerOf(command)}`],
        TURN_KILL_SWEEP_TIMEOUT_MS,
        '1000',
      ]);
      expect(result.passed).toBe(false);
      expect(result.errors).toContain('command "pytest" timed out after 2000 ms; it was stopped inside the container');
      expect(result.errors).toContain('collected 40 items');
    });

    it("treats the wrapper's exit 124 at the deadline as a timeout, but not the command's own 124 before it", async () => {
      const { bundle, exec } = makeStubBundle('cid', async (_id, argv) =>
        isSweep(argv) ? { exitCode: 0, stdout: '0', stderr: '' } : { exitCode: 124, stdout: '', stderr: 'exit 124' },
      );
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      // A 1 ms limit has passed by the time the exec returns.
      const atDeadline = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['make', 'test']],
        context: TASK_CONTEXT,
        container: true,
        timeoutMs: 1,
      });
      expect(atDeadline.errors).toContain('timed out after 1 ms');
      expect(exec.mock.calls.filter((call) => isSweep(call[1] as string[]))).toHaveLength(1);

      exec.mockClear();
      const beforeDeadline = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['make', 'test']],
        context: TASK_CONTEXT,
        container: true,
        timeoutMs: 600_000,
      });
      expect(beforeDeadline).toMatchObject({ passed: false, errors: 'exit 124' });
      expect(exec).toHaveBeenCalledTimes(1);
    });

    it('sweeps the running command when the run stops during it', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      let stopRun = (): void => {};
      const { bundle, exec } = makeStubBundle('cid', async (_id, argv) => {
        if (isSweep(argv)) return { exitCode: 0, stdout: '1', stderr: '' };
        stopRun();
        // The sweep SIGKILLs the command's processes, ending the exec.
        return { exitCode: 137, stdout: '', stderr: '' };
      });
      const instance = registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);
      stopRun = () => instance.stopController.abort();

      await expect(
        callExecuteDeterministicState(orchestrator, WF_ID, {
          stateId: 'check',
          commands: [['node', 'hang.js']],
          context: TASK_CONTEXT,
          container: true,
        }),
      ).rejects.toThrow(/is stopping/);

      expect(exec).toHaveBeenCalledTimes(2);
      const [command, sweep] = exec.mock.calls;
      expect(sweep[1]).toEqual([
        '/bin/sh',
        '-c',
        TURN_KILL_SWEEP_SCRIPT,
        'ironcurtain-turn-kill',
        `${TURN_MARKER_ENV}=${markerOf(command)}`,
      ]);
      expect(sweep[3]).toBe('codespace');
    });

    it('sweeps the running command of a drained lane and starts none of its later commands', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      const invoke = new AbortController();
      const { bundle, exec } = makeStubBundle('cid', async (_id, argv) => {
        if (isSweep(argv)) return { exitCode: 0, stdout: '1', stderr: '' };
        invoke.abort();
        return { exitCode: 137, stdout: '', stderr: '' };
      });
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      const result = await callExecuteDeterministicState(
        orchestrator,
        WF_ID,
        {
          stateId: 'evaluate',
          commands: [
            ['node', 'first.js'],
            ['node', 'second.js'],
          ],
          context: TASK_CONTEXT,
          container: true,
        },
        invoke.signal,
      );

      const calls = exec.mock.calls.map((call) => call[1] as string[]);
      expect(calls).toHaveLength(2);
      expect(calls[0].slice(-2)).toEqual(['node', 'first.js']);
      expect(isSweep(calls[1])).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.errors).toContain('command "node" was stopped inside the container');
      expect(result.errors).toContain('command "node" was not started');
    });

    it('a command that finishes normally is not swept', async () => {
      const { bundle, exec } = makeStubBundle('cid', async () => ({ exitCode: 1, stdout: '', stderr: 'lint failed' }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['npm', 'run', 'lint']],
        context: TASK_CONTEXT,
        container: true,
        timeoutMs: 60_000,
      });

      expect(exec).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ passed: false, errors: 'lint failed' });
    });
  });

  describe('resultFile contract', () => {
    it('returns the reducer result unchanged when resultFile is absent', () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      const base: DeterministicInvokeResult = { passed: true, testCount: 3, errors: undefined };

      const result = callApplyResultFile(
        orchestrator,
        tmpDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
        },
        base,
      );

      expect(result).toBe(base);
    });

    it('reads verdict and payload from a well-formed result file after successful commands', () => {
      mkdirSync(join(tmpDir, '.workflow'), { recursive: true });
      writeFileSync(
        join(tmpDir, '.workflow', 'result.json'),
        JSON.stringify({ verdict: 'block', payload: { reason: 'policy' } }),
      );
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

      const result = callApplyResultFile(
        orchestrator,
        tmpDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
          resultFile: '.workflow/result.json',
        },
        { passed: true, testCount: 2 },
      );

      expect(result).toEqual({
        passed: true,
        testCount: 2,
        verdict: 'block',
        payload: { reason: 'policy' },
      });
    });

    it('lets a boolean result-file passed field override command success', () => {
      mkdirSync(join(tmpDir, '.workflow'), { recursive: true });
      writeFileSync(join(tmpDir, '.workflow', 'result.json'), JSON.stringify({ verdict: 'failed', passed: false }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

      const result = callApplyResultFile(
        orchestrator,
        tmpDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
          resultFile: '.workflow/result.json',
        },
        { passed: true },
      );

      expect(result.passed).toBe(false);
      expect(result.verdict).toBe('failed');
    });

    it('maps a missing result file to the reserved routable verdict', () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

      const result = callApplyResultFile(
        orchestrator,
        tmpDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
          resultFile: '.workflow/result.json',
        },
        { passed: true, errors: 'prior warning' },
      );

      expect(result.passed).toBe(false);
      expect(result.verdict).toBe(DETERMINISTIC_RESULT_ERROR_VERDICT);
      expect(result.errors).toContain('prior warning');
      expect(result.errors).toContain('not found');
    });

    it('maps malformed JSON and missing verdict to the reserved routable verdict', () => {
      mkdirSync(join(tmpDir, '.workflow'), { recursive: true });
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      const input: DeterministicInvokeInput = {
        stateId: 'check',
        commands: [['node', 'check.js']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
        resultFile: '.workflow/result.json',
      };

      writeFileSync(join(tmpDir, '.workflow', 'result.json'), '{');
      const malformed = callApplyResultFile(orchestrator, tmpDir, input, { passed: true });
      expect(malformed.passed).toBe(false);
      expect(malformed.verdict).toBe(DETERMINISTIC_RESULT_ERROR_VERDICT);
      expect(malformed.errors).toContain('not valid JSON');

      writeFileSync(join(tmpDir, '.workflow', 'result.json'), JSON.stringify({ payload: { ok: true } }));
      const missingVerdict = callApplyResultFile(orchestrator, tmpDir, input, { passed: true });
      expect(missingVerdict.passed).toBe(false);
      expect(missingVerdict.verdict).toBe(DETERMINISTIC_RESULT_ERROR_VERDICT);
      expect(missingVerdict.errors).toContain('missing verdict');
    });

    it('rejects a result file that escapes the workspace via a symlink (security)', () => {
      // A container can plant a symlink in the shared workspace; the host-side read
      // must not follow it off-workspace. The symlink points to a sibling of the
      // workspace, so canonical-path containment must reject it.
      const wsDir = join(tmpDir, 'ws');
      const secret = join(tmpDir, 'outside-secret.json');
      writeFileSync(secret, JSON.stringify({ verdict: 'leak' }));
      mkdirSync(join(wsDir, '.workflow'), { recursive: true });
      symlinkSync(secret, join(wsDir, '.workflow', 'result.json'));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

      const result = callApplyResultFile(
        orchestrator,
        wsDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
          resultFile: '.workflow/result.json',
        },
        { passed: true },
      );

      expect(result.passed).toBe(false);
      expect(result.verdict).toBe(DETERMINISTIC_RESULT_ERROR_VERDICT);
      expect(result.errors).toContain('escapes the workspace');
      expect(result.verdict).not.toBe('leak'); // never surfaced the symlinked-out verdict
    });

    it('reports a read error (not "not valid JSON") when resultFile is a directory', () => {
      // resultFile points at a directory -> readFileSync throws EISDIR, which must be
      // reported as a read failure rather than conflated with a JSON parse error.
      mkdirSync(join(tmpDir, '.workflow', 'result.json'), { recursive: true });
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

      const result = callApplyResultFile(
        orchestrator,
        tmpDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
          resultFile: '.workflow/result.json',
        },
        { passed: true },
      );

      expect(result.passed).toBe(false);
      expect(result.verdict).toBe(DETERMINISTIC_RESULT_ERROR_VERDICT);
      expect(result.errors).toContain('could not be read');
      expect(result.errors).not.toContain('not valid JSON');
    });

    it('does not read resultFile when command reduction already failed', () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      const base: DeterministicInvokeResult = { passed: false, errors: 'command failed' };

      const result = callApplyResultFile(
        orchestrator,
        tmpDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
          resultFile: '.workflow/result.json',
        },
        base,
      );

      expect(result).toBe(base);
    });
  });
});

// ---------------------------------------------------------------------------
// Host deterministic states in a running workflow (start -> abort)
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator host deterministic states in a running workflow', () => {
  let tmpDir: string;
  let orchestrator: WorkflowOrchestrator | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'host-deterministic-run-'));
    orchestrator = undefined;
  });

  afterEach(async () => {
    await orchestrator?.shutdownAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function hostWorkflow(name: string, check: Record<string, unknown>): { name: string } {
    return {
      name,
      description: 'A builtin workflow whose only work is a host deterministic state',
      initial: 'check',
      settings: { mode: 'builtin' },
      states: {
        check: { type: 'deterministic', description: 'Runs on the host', transitions: [{ to: 'done' }], ...check },
        done: { type: 'terminal', description: 'Done' },
      },
    } as { name: string };
  }

  it('refuses to start a workflow whose host state lacks host: true', async () => {
    const marker = join(tmpDir, 'ran');
    const defPath = writeDefinitionFile(
      tmpDir,
      hostWorkflow('host-unacknowledged', {
        run: [['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`]],
      }),
    );
    orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

    await expect(orchestrator.start(defPath, 'task')).rejects.toThrow(/does not set host: true/);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses to resume a run recorded without host: true and names the definition copy to fix', async () => {
    // A run started before host deterministic states needed host: true: its
    // recorded definition copy (which resume prefers over the source file)
    // has no acknowledgement.
    const marker = join(tmpDir, 'ran');
    const workflowId = 'wf-host-recorded-unacknowledged' as WorkflowId;
    const definitionCopy = join(tmpDir, workflowId, 'definition.json');
    mkdirSync(join(tmpDir, workflowId), { recursive: true });
    writeFileSync(
      definitionCopy,
      JSON.stringify(
        hostWorkflow('host-recorded', {
          run: [['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`]],
        }),
      ),
    );
    createCheckpointStore(tmpDir).save(workflowId, {
      machineState: 'check',
      context: {
        taskDescription: 'task',
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
      definitionPath: join(tmpDir, 'source-workflow.yaml'),
    });
    orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

    const error: unknown = await orchestrator.resume(workflowId).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(error).toMatchObject({ code: 'WORKFLOW_CHECKPOINT_CORRUPTED' });
    expect((error as Error).message).toContain(definitionCopy);
    expect((error as Error).message).toContain(
      'State "check" runs its commands on the host but does not set host: true',
    );
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('abort() kills the running host command and its grandchildren', async () => {
    const pidFile = join(tmpDir, 'pids.json');
    const defPath = writeDefinitionFile(
      tmpDir,
      hostWorkflow('host-abort', { host: true, timeoutMs: 120_000, run: [['node', writeTreeScript(tmpDir), pidFile]] }),
    );
    orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

    const workflowId = await orchestrator.start(defPath, 'task');
    const pids = await waitForTreePids(pidFile);
    await orchestrator.abort(workflowId);
    const alive = await waitUntilDead([pids.child, pids.grandchild]);
    killPids(alive);

    expect(alive).toEqual([]);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');
  });

  it('runs an acknowledged host state to completion in the run workspace', async () => {
    const defPath = writeDefinitionFile(
      tmpDir,
      hostWorkflow('host-complete', {
        host: true,
        run: [['node', '-e', "require('fs').writeFileSync('host-ran.txt', process.cwd())"]],
      }),
    );
    orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId, 20_000);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    const workspace = join(tmpDir, workflowId, 'workspace');
    expect(realpathSync(readFileSync(join(workspace, 'host-ran.txt'), 'utf8'))).toBe(realpathSync(workspace));
  });
});
