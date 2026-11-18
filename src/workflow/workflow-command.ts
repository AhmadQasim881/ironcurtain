/**
 * CLI entry point for `ironcurtain workflow`.
 *
 * Subcommands:
 *   start   <definition> "task" [--model <model>] [--workspace <path>] [--task-scoped]
 *   resume  <workflowId|existingBaseDir> [--workflow-id <id>] [--trust] [--json] [--ensure-daemon]
 *   resume-standalone <baseDir> [--state <stateName>] [--model <model>] [--trust]
 *   inspect <baseDir> [--all]
 *   status  <workflowId> [--json] [--ensure-daemon]
 *   await   <workflowId> [--timeout <sec>] [--json] [--ensure-daemon]
 *   watch   <workflowId|runDir> [--json] [--since <ISO>] [--events <list>] [--lines <N>]
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { getIronCurtainHome } from '../config/paths.js';
import { loadConfig } from '../config/index.js';
import type { IronCurtainConfig } from '../config/types.js';
import { validateWorkspacePath } from '../session/workspace-validation.js';
import { formatHelp, type CommandSpec } from '../cli-help.js';
import { FileCheckpointStore } from './checkpoint.js';
import { discoverWorkflows, resolveWorkflowPath, parseDefinitionFile } from './discovery.js';
import { discoverWorkflowRuns, type WorkflowRunSummary } from './workflow-discovery.js';
import { listArtifactOutputNames } from './artifacts.js';
import { assertWorkflowRunsBaseDir, isSameDirectory } from './checkpoint-selection.js';
import { WorkflowManager } from './workflow-manager.js';
import { TypedEventBus } from '../event-bus/typed-event-bus.js';
import type { WebEventMap } from '../web-ui/web-event-bus.js';
import { countBySeverity, lintWorkflow } from './lint.js';
import { defaultLintContext, type LintMode } from './lint-integration.js';
import { MessageLog } from './message-log.js';
import {
  WorkflowOrchestrator,
  type WorkflowOrchestratorDeps,
  type WorkflowResumeOptions,
  type WorkflowTabHandle,
} from './orchestrator.js';
import { WORKFLOW_ARTIFACT_DIR, type WorkflowId, type WorkflowCheckpoint, type WorkflowDefinition } from './types.js';
import {
  createWorkflowSessionFactory,
  createConsoleTab,
  createGateHandler,
  printLifecycleEvent,
  printSummary,
  printResumeInfo,
  selectResumableWorkflow,
  synthesizeCheckpoint,
  runEventLoop,
  writeStdout,
  writeStderr,
  displayBlock,
  displayLine,
  RED,
  BLUE,
  BOLD,
  DIM,
  MAGENTA,
  CYAN,
  YELLOW,
  RESET,
} from './cli-support.js';
import { runRunState } from './run-state-command.js';
import { hostCommandStatesForResume } from './run-definition.js';
import { runDaemonGateCommand } from './daemon-gate-commands.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { errorMessage } from '../utils/error-message.js';
import { guardStdioStreamErrors } from '../utils/stdio-guard.js';
import { runWorkflowWatch } from './workflow-watch-command.js';
import { hasContainerSnapshots, sweepContainerSnapshots } from './container-snapshots.js';
import { installWorkflowShutdownSignals, workflowStopOptionsForSignal } from './shutdown-signals.js';
import {
  checkedModelOverride,
  formatDiagnostic,
  printDiagnostics,
  loadAndValidateDefinition,
  parseArgsStrict,
  runCliPreflightLint,
} from './cli-shared.js';

// ---------------------------------------------------------------------------
// Help specs
// ---------------------------------------------------------------------------

const workflowSpec: CommandSpec = {
  name: 'ironcurtain workflow',
  description: 'Run multi-agent workflows',
  usage: [
    'ironcurtain workflow list',
    'ironcurtain workflow start <name-or-path> "task" [--model <model>] [--workspace <path>] [--task-scoped] [--no-lint] [--strict-lint]',
    'ironcurtain workflow resume <workflowId|existingBaseDir> [--workflow-id <id>] [--trust] [--json] [--ensure-daemon]',
    'ironcurtain workflow resume-standalone <baseDir> [--state <stateName>] [--model <model>] [--trust] [--no-lint] [--strict-lint]',
    'ironcurtain workflow inspect <baseDir> [--all]',
    'ironcurtain workflow lint <name-or-path> [--strict]',
    'ironcurtain workflow run-state <name-or-path> <state> --artifacts <dir> [options]',
    'ironcurtain workflow run <name-or-path> "task" [--workspace <path>] [--json] [--ensure-daemon]',
    'ironcurtain workflow status <workflowId> [--json] [--ensure-daemon]',
    'ironcurtain workflow await <workflowId> [--timeout <sec>] [--json] [--ensure-daemon]',
    'ironcurtain workflow watch <workflowId|runDir> [--json] [--since <ISO>] [--events <list>] [--lines <N>]',
    'ironcurtain workflow gate <workflowId> --gate-id <gateId> --event <EVENT> [--prompt <text>] [--json]',
    'ironcurtain workflow escalation <workflowId> --approve --escalation-id <id> [--whitelist <n>] [--json]',
    'ironcurtain workflow escalation <workflowId> --deny [--escalation-id <id>] [--json]',
    'ironcurtain workflow show <workflowId> --artifact <name> [--file <path>] [--json]',
  ],
  subcommands: [
    { name: 'list', description: 'List available workflow definitions' },
    { name: 'start', description: 'Start a workflow by name or definition file path (interactive)' },
    { name: 'resume', description: 'Resume a checkpointed workflow through the daemon' },
    { name: 'resume-standalone', description: 'Resume without the daemon (advanced)' },
    { name: 'inspect', description: 'Show workflow status, artifacts, and recent messages' },
    { name: 'lint', description: 'Run semantic checks on a workflow definition' },
    { name: 'run-state', description: 'Run a single agent state once against pre-staged artifacts' },
    { name: 'run', description: 'Start a gated workflow on the daemon (non-interactive, machine-readable)' },
    { name: 'status', description: 'Print one status snapshot and exit; use for stateless polling' },
    {
      name: 'await',
      description:
        'Subscribe and exit at the next gate, tool-call escalation or terminal (not ordinary transitions); use for automation',
    },
    {
      name: 'watch',
      description: 'Continuously stream transitions/events; does not exit after one (use --lines for a snapshot)',
    },
    { name: 'gate', description: 'Resolve a human gate with an event (APPROVE/FORCE_REVISION/REPLAN/ABORT)' },
    {
      name: 'escalation',
      description: 'Approve or deny a tool call that policy escalated inside an agent state (phase: escalation)',
    },
    { name: 'show', description: 'Print a presented artifact for a gated workflow' },
  ],
  options: [
    { flag: 'model', description: 'Override the agent model (start, resume-standalone)', placeholder: '<model-id>' },
    {
      flag: 'workspace',
      description: 'Use an existing directory as workspace (start only)',
      placeholder: '<path>',
    },
    {
      flag: 'state',
      description: 'Synthesize checkpoint at this state (resume-standalone only)',
      placeholder: '<name>',
    },
    { flag: 'all', description: 'Show full message log (inspect only)' },
    { flag: 'no-lint', description: 'Skip pre-flight linting (start, resume-standalone)' },
    { flag: 'strict-lint', description: 'Treat lint warnings as errors (start, resume-standalone)' },
    { flag: 'strict', description: 'Treat lint warnings as errors (lint only)' },
    { flag: 'capture-traces', description: 'Capture LLM API traces for this run (start only)' },
    {
      flag: 'task-scoped',
      description:
        "Narrow every state's policy to the task: compile the task into a task scope (cached per task) and " +
        'escalate every call outside it (start only; opt-in, a new task is first compiled with the LLM)',
    },
    {
      flag: 'json',
      description: 'Emit machine-readable JSON to stdout (run, resume, status, await, watch, gate, escalation, show)',
    },
    {
      flag: 'ensure-daemon',
      description:
        'Auto-start a detached daemon if none is running (run, resume, status, await, gate, escalation, show)',
    },
    { flag: 'workflow-id', description: 'Select a workflow within an external base directory', placeholder: '<id>' },
    {
      flag: 'trust',
      description:
        'Allow a run from another base directory whose definition runs commands on this host (resume, resume-standalone)',
    },
    {
      flag: 'event',
      description: 'Gate event: APPROVE | FORCE_REVISION | REPLAN | ABORT (gate only)',
      placeholder: '<EVENT>',
    },
    {
      flag: 'prompt',
      description: 'Feedback for FORCE_REVISION/REPLAN gate events (gate only)',
      placeholder: '<text>',
    },
    { flag: 'artifact', description: 'Artifact name to read (show only)', placeholder: '<name>' },
    { flag: 'approve', description: 'Approve the escalated tool call (escalation only)' },
    { flag: 'deny', description: 'Deny the escalated tool call (escalation only)' },
    {
      flag: 'escalation-id',
      description: 'Escalation to resolve; required with --approve (escalation only)',
      placeholder: '<id>',
    },
    {
      flag: 'whitelist',
      description:
        'Approve and whitelist candidate <n> (0-based, as listed by status) until the persona changes or the session ends (escalation only)',
      placeholder: '<n>',
    },
    {
      flag: 'file',
      description: 'Read one file of the artifact, e.g. one listed as omitted (show only)',
      placeholder: '<path>',
    },
    {
      flag: 'timeout',
      description: 'Max seconds to await; timeout exits while the workflow keeps running',
      placeholder: '<sec>',
    },
    { flag: 'since', description: 'Replay watch records at or after an ISO timestamp', placeholder: '<ISO>' },
    {
      flag: 'events',
      description: 'Watch event filters (comma-separated, or all)',
      placeholder: '<list>',
    },
    { flag: 'lines', description: 'Replay only the last N selected watch records', placeholder: '<N>' },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: [
    'ironcurtain workflow list',
    'ironcurtain workflow start design-and-code "Build a REST API"',
    'ironcurtain workflow start ./my-workflow.yaml "Build a REST API"',
    'ironcurtain workflow start design-and-code "task" --model anthropic:claude-haiku-4-5',
    'ironcurtain workflow start design-and-code "Add a CSV export" --task-scoped',
    'ironcurtain workflow resume wf-abc123 --json',
    'ironcurtain workflow resume /tmp/workflow-runs --workflow-id wf-abc123 --ensure-daemon',
    'ironcurtain workflow resume-standalone /tmp/workflow-runs --state review',
    'ironcurtain workflow inspect /tmp/workflow-abc123',
    'ironcurtain workflow inspect /tmp/workflow-abc123 --all',
    'ironcurtain workflow run design-and-code "Build a REST API" --json --ensure-daemon',
    'ironcurtain workflow await wf-7a3 --timeout 3600 --json --ensure-daemon',
    'ironcurtain workflow watch wf-7a3 --events transition,verdict,retry,error',
    'ironcurtain workflow watch wf-7a3 --lines 20 --json',
    'ironcurtain workflow show wf-7a3 --artifact spec --json',
    'ironcurtain workflow show wf-7a3 --artifact spec --file sections/api.md --json',
    'ironcurtain workflow gate wf-7a3 --gate-id wf-7a3-review-1-3f9c... --event FORCE_REVISION --prompt "tighten the intro" --json',
    'ironcurtain workflow gate wf-7a3 --gate-id wf-7a3-review-2-a81d... --event APPROVE --json',
    'ironcurtain workflow escalation wf-7a3 --approve --escalation-id 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed --json',
  ],
};

// ---------------------------------------------------------------------------
// Lint helpers
// ---------------------------------------------------------------------------

function resolveLintMode(noLint: unknown, strictLint: unknown): LintMode {
  if (noLint === true) return 'off';
  if (strictLint === true) return 'strict';
  return 'warn';
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function runStart(args: string[]): Promise<void> {
  const { values, positionals } = parseArgsStrict({
    args,
    options: {
      model: { type: 'string' },
      workspace: { type: 'string' },
      'no-lint': { type: 'boolean' },
      'strict-lint': { type: 'boolean' },
      'capture-traces': { type: 'boolean' },
      'task-scoped': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stderr.write(formatHelp(workflowSpec) + '\n');
    return;
  }

  const definitionRef = positionals[0];
  const taskDescription = positionals[1];

  if (!definitionRef || !taskDescription) {
    writeStderr(`${RED}Usage: ironcurtain workflow start <name-or-path> "task" [--model <model>]${RESET}`);
    process.exit(1);
  }
  const modelOverride = checkedModelOverride(values.model, 1);

  const resolvedDef = resolveWorkflowPath(definitionRef);
  if (!resolvedDef) {
    writeStderr(`${RED}Workflow not found: ${definitionRef}${RESET}`);
    writeStderr(`${DIM}Looked in bundled and user workflow directories.${RESET}`);
    writeStderr(`${DIM}Run 'ironcurtain workflow list' to see available workflows.${RESET}`);
    process.exit(1);
  }

  // Pre-flight: validate + lint before any orchestrator side effects.
  const lintMode = resolveLintMode(values['no-lint'], values['strict-lint']);
  runCliPreflightLint(resolvedDef, lintMode);

  const config = loadConfig();

  // Fail fast with the same validator `start -w` uses. The orchestrator
  // re-validates authoritatively; this only gives an early, readable error.
  let workspacePath: string | undefined;
  if (values.workspace) {
    try {
      workspacePath = validateWorkspacePath(values.workspace as string, config.protectedPaths);
    } catch (err) {
      writeStderr(`${RED}Invalid workspace: ${err instanceof Error ? err.message : String(err)}${RESET}`);
      process.exit(1);
    }
  }

  const captureTracesFlag = values['capture-traces'] as boolean | undefined;

  // --task-scoped (opt-in only): compile (or reuse) the task scope at this
  // CLI entry, before the orchestrator exists, so the workflow runtime
  // never reaches the policy pipeline.
  const taskPolicyDir =
    values['task-scoped'] === true ? await prepareWorkflowTaskScope(taskDescription, config, workspacePath) : undefined;

  const baseDir = resolve(getIronCurtainHome(), 'workflow-runs');
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });

  const checkpointStore = new FileCheckpointStore(baseDir);
  const gateHandler = createGateHandler();
  const sessionFactory = createWorkflowSessionFactory(modelOverride);
  await sweepContainerSnapshots({ baseDir, checkpointStore, userConfig: config.userConfig }).catch((err: unknown) => {
    writeStderr(`[workflow] Container snapshot GC skipped: ${err instanceof Error ? err.message : String(err)}`);
  });

  const deps: WorkflowOrchestratorDeps = {
    createSession: sessionFactory,
    createWorkflowTab: (label: string): WorkflowTabHandle => createConsoleTab(label),
    raiseGate: gateHandler.raiseGate,
    dismissGate: gateHandler.dismissGate,
    baseDir,
    checkpointStore,
    userConfig: config.userConfig,
    protectedPaths: config.protectedPaths,
    // Pass the RAW --capture-traces flag; the infrastructure factory
    // resolves it against userConfig (single resolution point).
    captureTracesOverride: captureTracesFlag,
  };

  const orchestrator = new WorkflowOrchestrator(deps);
  orchestrator.onEvent(printLifecycleEvent);

  const controller = new AbortController();
  let caughtSignal: NodeJS.Signals | undefined;
  const uninstallShutdownSignals = installWorkflowShutdownSignals(controller, {
    onFirstSignal: (signal) => {
      caughtSignal = signal;
      writeStderr(`\n[workflow] Caught ${signal}, shutting down...`);
    },
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Exit only AFTER the finally so workflow + Docker teardown (shutdownAll)
  // fully drains first. Calling process.exit() inside the try — as this code
  // used to — terminates the process synchronously and cuts off the async
  // teardown in the finally, orphaning each run's per-session --internal
  // Docker network. Crash reconciliation now repairs that state on the next
  // startup, but graceful exits must still drain teardown rather than relying
  // on recovery. The apple-container backend loses this race every time
  // (slower VM shutdown), so the fix matters there in particular.
  // Definitely assigned before the post-finally `process.exit`: the only way
  // to skip that assignment is a throw, which propagates past it.
  let exitCode: number;
  try {
    writeStdout(`${BOLD}${MAGENTA}Starting workflow${RESET}`);
    writeStdout(`${DIM}Task: ${taskDescription}${RESET}`);
    writeStdout(`${DIM}Base dir: ${baseDir}${RESET}`);
    writeStdout('');

    const workflowId = await orchestrator.start(
      resolvedDef,
      taskDescription,
      workspacePath,
      taskPolicyDir !== undefined ? { taskPolicyDir } : undefined,
    );

    const wsPath = workspacePath ?? resolve(baseDir, workflowId, 'workspace');
    const artifactDir = resolve(wsPath, '.workflow');

    await runEventLoop(orchestrator, workflowId, rl, controller.signal);

    printSummary(orchestrator, workflowId, artifactDir);

    exitCode = computeExitCode(orchestrator, workflowId, controller.signal);
  } finally {
    rl.close();
    // Joins any in-flight teardown (see WorkflowInstance.teardownPromise)
    // so the process.exit below never strands infrastructure. After a signal
    // the runs are recorded as interrupted by it and snapshot commits are
    // bounded to fit the force-exit window.
    await orchestrator.shutdownAll(workflowStopOptionsForSignal(caughtSignal)).catch(() => {});
    uninstallShutdownSignals();
    writeStdout(`${DIM}Artifacts preserved at: ${baseDir}${RESET}`);
  }
  process.exit(exitCode);
}

/**
 * Compiles (or reuses from the cache) the task scope of a `--task-scoped`
 * run. Exits when no scope can be prepared: the user asked for a narrowed
 * run, so it never silently starts unscoped. The pipeline is reached only
 * through this dynamic import (the sanctioned seam).
 */
async function prepareWorkflowTaskScope(
  taskDescription: string,
  config: IronCurtainConfig,
  workspacePath: string | undefined,
): Promise<string> {
  writeStderr(`${DIM}Preparing the task scope (--task-scoped)...${RESET}`);
  try {
    const { compileTaskScopePolicy, formatTaskScopeSummary } = await import('../cron/compile-task-policy.js');
    const scope = await compileTaskScopePolicy(taskDescription, {
      config,
      ...(workspacePath !== undefined ? { workspacePath } : {}),
    });
    for (const line of formatTaskScopeSummary(scope)) writeStderr(`${DIM}${line}${RESET}`);
    return scope.policyDir;
  } catch (err) {
    writeStderr(`${RED}Could not prepare the task scope: ${err instanceof Error ? err.message : String(err)}${RESET}`);
    writeStderr(`${YELLOW}The workflow was not started. Run without --task-scoped for an unscoped run.${RESET}`);
    process.exit(1);
  }
}

/** True when `baseDir` is this IronCurtain home's own run directory, `<home>/workflow-runs`. */
function isHomeWorkflowRunsDir(baseDir: string): boolean {
  return isSameDirectory(baseDir, resolve(getIronCurtainHome(), 'workflow-runs'));
}

/**
 * Resume options of `workflow resume-standalone <baseDir>`. A base directory
 * other than this home's own holds runs IronCurtain did not necessarily write
 * there (copied, restored, or left by an agent), whose checkpoints' container
 * snapshot references can name any image on the engine. They are ignored, as
 * a daemon import drops them: no scope starts from such an image, and no stop
 * removes one as superseded.
 */
export function resumeStandaloneOptions(baseDir: string): WorkflowResumeOptions | undefined {
  return isHomeWorkflowRunsDir(baseDir) ? undefined : { ignoreContainerSnapshots: true };
}

async function runResumeStandalone(args: string[]): Promise<void> {
  const { values, positionals } = parseArgsStrict({
    args,
    options: {
      state: { type: 'string' },
      model: { type: 'string' },
      trust: { type: 'boolean' },
      'no-lint': { type: 'boolean' },
      'strict-lint': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stderr.write(formatHelp(workflowSpec) + '\n');
    return;
  }

  const baseDirArg = positionals[0];
  if (!baseDirArg) {
    writeStderr(`${RED}Usage: ironcurtain workflow resume-standalone <baseDir> [--state <stateName>]${RESET}`);
    process.exit(1);
  }

  const baseDir = resolve(baseDirArg);
  if (!existsSync(baseDir)) {
    writeStderr(`${RED}Base directory does not exist: ${baseDir}${RESET}`);
    process.exit(1);
  }
  // A run directory passed where its parent belongs would make the run's own
  // (agent-writable) workspace look like a run to resume.
  try {
    assertWorkflowRunsBaseDir(baseDir);
  } catch (err) {
    writeStderr(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`);
    process.exit(1);
  }

  const modelOverride = checkedModelOverride(values.model, 1);
  const overrideState = values.state as string | undefined;

  const checkpointStore = new FileCheckpointStore(baseDir);
  const gateHandler = createGateHandler();
  const sessionFactory = createWorkflowSessionFactory(modelOverride);

  let selected: { workflowId: WorkflowId; checkpoint: WorkflowCheckpoint };

  const hasCheckpoints = discoverWorkflowRuns(baseDir).some((r) => r.hasCheckpoint);
  if (overrideState && !hasCheckpoints) {
    // Find a definition path from the workflow directory
    const definitionPath = findDefinitionPath(baseDir);
    selected = synthesizeCheckpoint(baseDir, overrideState, definitionPath, checkpointStore);
  } else {
    selected = selectResumableWorkflow(checkpointStore, baseDir);
  }

  // A base directory other than this home's own holds runs IronCurtain did
  // not necessarily write here (copied, restored, or left by an agent): its
  // host commands run only with --trust, as for a daemon import, and its
  // container snapshot references are not used (resumeStandaloneOptions).
  const resumeOptions = resumeStandaloneOptions(baseDir);
  if (values.trust !== true && !isHomeWorkflowRunsDir(baseDir)) {
    const hostStates = hostCommandStatesForResume(resolve(baseDir, selected.workflowId));
    if (hostStates.length > 0) {
      writeStderr(
        `${RED}Workflow ${selected.workflowId} in ${baseDir} runs commands on this host ` +
          `(state(s): ${hostStates.join(', ')}). Review its definition, then pass --trust to resume it.${RESET}`,
      );
      process.exit(1);
    }
  }

  // Pre-flight lint before orchestrator.resume(). The checkpoint carries
  // a definitionPath we can re-validate + lint.
  const defPath = selected.checkpoint.definitionPath;
  if (isHomeWorkflowRunsDir(baseDir) && defPath && existsSync(defPath)) {
    const lintMode = resolveLintMode(values['no-lint'], values['strict-lint']);
    runCliPreflightLint(defPath, lintMode);
  }

  printResumeInfo(baseDir, selected.workflowId, selected.checkpoint);
  if (resumeOptions?.ignoreContainerSnapshots === true && hasContainerSnapshots(selected.checkpoint)) {
    writeStderr(
      `${YELLOW}${displayLine(baseDir)} is not this IronCurtain home's workflow-runs directory: the container ` +
        `snapshots the checkpoint references are not used, so its scopes start from fresh containers ` +
        `(the workspace is unchanged).${RESET}`,
    );
  }

  const config = loadConfig();
  await sweepContainerSnapshots({ baseDir, checkpointStore, userConfig: config.userConfig }).catch((err: unknown) => {
    writeStderr(`[workflow] Container snapshot GC skipped: ${err instanceof Error ? err.message : String(err)}`);
  });
  const deps: WorkflowOrchestratorDeps = {
    createSession: sessionFactory,
    createWorkflowTab: (label: string): WorkflowTabHandle => createConsoleTab(label),
    raiseGate: gateHandler.raiseGate,
    dismissGate: gateHandler.dismissGate,
    baseDir,
    checkpointStore,
    userConfig: config.userConfig,
    protectedPaths: config.protectedPaths,
  };

  const orchestrator = new WorkflowOrchestrator(deps);
  orchestrator.onEvent(printLifecycleEvent);

  const controller = new AbortController();
  let caughtSignal: NodeJS.Signals | undefined;
  const uninstallShutdownSignals = installWorkflowShutdownSignals(controller, {
    onFirstSignal: (signal) => {
      caughtSignal = signal;
      writeStderr(`\n[workflow] Caught ${signal}, shutting down...`);
    },
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Exit only AFTER the finally so teardown (shutdownAll) fully drains first.
  // See runStart for why process.exit() inside the try leaks Docker networks.
  // Definitely assigned before the post-finally `process.exit`: the only way
  // to skip that assignment is a throw, which propagates past it.
  let exitCode: number;
  try {
    writeStdout(`${BOLD}${MAGENTA}Resuming...${RESET}`);
    writeStdout('');

    await orchestrator.resume(selected.workflowId, resumeOptions);

    const wsPath = resolve(baseDir, selected.workflowId, 'workspace');
    const artifactDir = resolve(wsPath, '.workflow');

    await runEventLoop(orchestrator, selected.workflowId, rl, controller.signal);

    printSummary(orchestrator, selected.workflowId, artifactDir);

    exitCode = computeExitCode(orchestrator, selected.workflowId, controller.signal);
  } finally {
    rl.close();
    await orchestrator.shutdownAll(workflowStopOptionsForSignal(caughtSignal)).catch(() => {});
    uninstallShutdownSignals();
    writeStdout(`${DIM}Artifacts preserved at: ${baseDir}${RESET}`);
  }
  process.exit(exitCode);
}

/**
 * `workflow inspect`: status, artifacts and recent messages of the runs in a
 * base directory. Much of what it prints is agent-written (the last error,
 * message-log text, artifact names in the workspace) or comes from files in
 * the run directory, so every value goes through {@link displayLine} or
 * {@link displayBlock} and reaches the terminal with control characters shown
 * as visible escapes.
 *
 * Each run is shown on its own: a run that cannot be read is reported where
 * it would appear, and the others are still shown (as is a run whose
 * workspace holds links the agent planted: they are never followed).
 */
function runInspect(args: string[]): void {
  const { values, positionals } = parseArgsStrict({
    args,
    options: {
      all: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stderr.write(formatHelp(workflowSpec) + '\n');
    return;
  }

  const baseDirArg = positionals[0];
  if (!baseDirArg) {
    writeStderr(`${RED}Usage: ironcurtain workflow inspect <baseDir> [--all]${RESET}`);
    process.exit(1);
  }

  const baseDir = resolve(baseDirArg);
  if (!existsSync(baseDir)) {
    writeStderr(`${RED}Base directory does not exist: ${baseDir}${RESET}`);
    process.exit(1);
  }

  const showAll = values.all === true;
  const runs = discoverWorkflowRuns(baseDir);

  if (runs.length === 0) {
    writeStdout(`${DIM}No workflows found in ${displayLine(baseDir)}${RESET}`);
    return;
  }

  // WorkflowManager owns the canonical "load a past run" logic. We point it at
  // the user-supplied baseDir via `baseDirOverride` so the same loader works
  // for both the daemon's home directory and arbitrary `inspect` targets.
  // The CLI never starts workflows through this manager, so the event bus is
  // a no-op sink and the orchestrator created lazily inside the manager is
  // never used to spawn sessions.
  const manager = new WorkflowManager({
    eventBus: new TypedEventBus<WebEventMap>(),
    baseDirOverride: baseDir,
  });

  for (const run of runs) {
    // One run that cannot be read (removed while we look, a message log that
    // is not a readable file) must not hide the runs after it.
    try {
      inspectRun(manager, run, showAll);
    } catch (err) {
      writeStdout(
        `  ${RED}Could not inspect ${displayLine(run.workflowId)}: ${displayBlock(errorMessage(err))}${RESET}`,
      );
      writeStdout('');
    }
  }
}

/** Prints one run for `workflow inspect`; throws when one of its files cannot be read. */
function inspectRun(manager: WorkflowManager, run: WorkflowRunSummary, showAll: boolean): void {
  const workflowId = run.workflowId;
  const workflowDir = run.directoryPath;

  const result = manager.loadPastRun(workflowId);

  let checkpoint: WorkflowCheckpoint | undefined;
  let loadedDef: WorkflowDefinition | undefined;

  if ('error' in result) {
    if (result.error !== 'not_found') {
      // Behavior change: a malformed checkpoint or definition used to either
      // throw (checkpoint) or be silently ignored (definition). We now print
      // a clear error line and continue with the next workflow.
      writeStdout(`${BOLD}${CYAN}Workflow: ${displayLine(workflowId)}${RESET}`);
      writeStdout(`  ${RED}Failed to load: ${displayBlock(result.message ?? 'unknown error')}${RESET}`);
      writeStdout('');
      return;
    }
    // not_found: no checkpoint on disk. Preserve current behavior -- render
    // the directory with `checkpoint = undefined` and silently parse the
    // definition (without strict schema validation) for state descriptions.
    checkpoint = undefined;
    loadedDef = tryParseDefinitionForStateDescriptions(workflowDir);
  } else {
    checkpoint = result.checkpoint;
    loadedDef = result.definition;
  }

  writeStdout(`${BOLD}${CYAN}Workflow: ${displayLine(workflowId)}${RESET}`);
  if (!('error' in result) && result.runningElsewhere) {
    writeStdout(`  ${YELLOW}Running in another IronCurtain process (its run lock is held)${RESET}`);
  }

  const stateDescriptions = loadedDef
    ? new Map(
        Object.entries(loadedDef.states)
          .filter(([, s]) => s.description)
          .map(([id, s]) => [id, s.description]),
      )
    : undefined;

  const defPath = resolve(workflowDir, 'definition.json');

  if (checkpoint) {
    const stateStr = String(checkpoint.machineState);
    writeStdout(`  State: ${stateLabelFor(stateStr, stateDescriptions)}`);
    if (checkpoint.finalStatus) {
      writeStdout(`  Final: ${BOLD}${displayLine(checkpoint.finalStatus.phase)}${RESET}`);
      const terminalState = checkpoint.transitionHistory.at(-1)?.to;
      if (terminalState && terminalState !== stateStr) {
        writeStdout(`  Terminal state: ${stateLabelFor(terminalState, stateDescriptions)}`);
      }
    }
    writeStdout(`  Timestamp: ${displayLine(checkpoint.timestamp)}`);
    if (checkpoint.context.lastError) {
      writeStdout(`  Error: ${RED}${displayBlock(checkpoint.context.lastError)}${RESET}`);
    }
    if (checkpoint.containerSnapshots && Object.keys(checkpoint.containerSnapshots).length > 0) {
      writeStdout(`  Container snapshots: ${Object.keys(checkpoint.containerSnapshots).length}`);
    }
    writeStdout(`  Task: ${displayLine(checkpoint.context.taskDescription, 100)}`);
  } else {
    writeStdout(`  ${DIM}No checkpoint${RESET}`);
  }

  // Artifact directories. Their names are chosen in the agent-writable
  // workspace, where the agent can also plant symlinks (dangling ones too) and
  // any number of entries: the listing never follows a link and is bounded.
  const artifacts = listArtifactOutputNames(resolve(workflowDir, 'workspace', WORKFLOW_ARTIFACT_DIR));
  if (artifacts.kind === 'not_directory') {
    writeStdout(`  Artifacts: ${DIM}(not listed: ${WORKFLOW_ARTIFACT_DIR} is not a directory)${RESET}`);
  } else if (artifacts.kind === 'ok') {
    const names = artifacts.names.map((name) => displayLine(name)).join(', ') || '(none)';
    writeStdout(`  Artifacts: ${names}${artifacts.truncated ? ` ${DIM}(listing truncated)${RESET}` : ''}`);
  }

  if (existsSync(defPath)) {
    writeStdout(`  Definition: ${displayLine(defPath)}`);
  }

  // Informational lint of the checkpointed definition. Read-only — never
  // affects exit code. Intentionally does NOT pass `workflowFilePath`:
  // inspect operates on a past-run's `definition.json` whose sibling
  // tree is the run directory, not the source workflow package, so
  // WF010 (skill-reference) would emit false positives by looking for
  // SKILL.md in a directory that never carried skills sidecars.
  if (loadedDef) {
    const diagnostics = lintWorkflow(loadedDef, defaultLintContext);
    if (diagnostics.length > 0) {
      const { errors, warnings } = countBySeverity(diagnostics);
      writeStdout(`  ${BOLD}Lint:${RESET} ${errors} error(s), ${warnings} warning(s)`);
      for (const d of diagnostics) {
        for (const line of formatDiagnostic(d)) writeStdout(`    ${line}`);
      }
    }
  }

  // Message log
  const logPath = resolve(workflowDir, 'messages.jsonl');
  const messageLog = new MessageLog(logPath);
  const entries = messageLog.readAll();

  if (entries.length > 0) {
    const displayEntries = showAll ? entries : entries.slice(-20);
    const label = showAll
      ? `All ${entries.length} messages`
      : `Last ${displayEntries.length} of ${entries.length} messages`;
    writeStdout(`  ${BOLD}${label}:${RESET}`);

    for (const entry of displayEntries) {
      const ts = displayLine(entry.ts.slice(11, 19)); // HH:MM:SS
      const prefix = `    ${DIM}${ts}${RESET}`;

      switch (entry.type) {
        case 'agent_sent':
          writeStdout(`${prefix} ${CYAN}[sent/${displayLine(entry.role)}]${RESET} ${oneLine(entry.message, 120)}`);
          break;
        case 'agent_received':
          writeStdout(
            `${prefix} ${CYAN}[recv/${displayLine(entry.role)}]${RESET} verdict=${displayLine(entry.verdict ?? '-')} ${oneLine(entry.message, 80)}`,
          );
          break;
        case 'agent_retry':
          writeStdout(`${prefix} ${MAGENTA}[retry/${displayLine(entry.role)}]${RESET} ${displayBlock(entry.reason)}`);
          break;
        case 'gate_raised':
          writeStdout(
            `${prefix} ${BOLD}[gate]${RESET} events: ${entry.acceptedEvents.map((e) => displayLine(e)).join(', ')}`,
          );
          break;
        case 'gate_resolved':
          writeStdout(
            `${prefix} ${BOLD}[gate resolved]${RESET} ${displayLine(entry.event)}${entry.resolvedBy ? ` via ${displayLine(entry.resolvedBy)}` : ''}`,
          );
          break;
        case 'tool_call_escalation':
          writeStdout(
            `${prefix} ${YELLOW}[escalation ${displayLine(entry.outcome)}]${RESET} ${toDisplayText(`${entry.serverName}/${entry.toolName}`)} ${DIM}${toDisplayText(entry.reason, { maxLength: 80 })}${RESET}`,
          );
          break;
        case 'error':
          writeStdout(`${prefix} ${RED}[error]${RESET} ${displayBlock(entry.error)}`);
          break;
        case 'quota_exhausted':
          writeStdout(
            `${prefix} ${YELLOW}[quota/${displayLine(entry.role)}]${RESET} resets=${displayLine(entry.resetAt ?? 'unknown')} — ${oneLine(entry.rawMessage, 80)}`,
          );
          break;
        case 'transient_failure':
          writeStdout(
            `${prefix} ${YELLOW}[transient/${displayLine(entry.role)}]${RESET} kind=${displayLine(entry.kind)} — ${oneLine(entry.rawMessage, 80)}`,
          );
          break;
        case 'state_transition':
          writeStdout(
            `${prefix} ${BLUE}[transition]${RESET} ${displayLine(entry.from)} -> ${stateLabelFor(entry.event, stateDescriptions, false)}`,
          );
          break;
      }
    }
  } else {
    writeStdout(`  ${DIM}No message log${RESET}`);
  }

  writeStdout('');
}

/**
 * Best-effort definition load used in the `not_found` branch of `loadPastRun`.
 * Mirrors the pre-refactor behavior: parse-only (no schema validation), errors
 * swallowed. The returned definition is used solely to populate state
 * descriptions in the rendered message log.
 */
function tryParseDefinitionForStateDescriptions(workflowDir: string): WorkflowDefinition | undefined {
  const defPath = resolve(workflowDir, 'definition.json');
  if (!existsSync(defPath)) return undefined;
  try {
    return parseDefinitionFile(defPath) as WorkflowDefinition;
  } catch {
    // Non-fatal -- definition may be from an older schema.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeExitCode(orchestrator: WorkflowOrchestrator, workflowId: WorkflowId, signal: AbortSignal): number {
  if (signal.aborted) return 130;
  const status = orchestrator.getStatus(workflowId);
  if (status?.phase === 'completed') return 0;
  return 1;
}

/** Finds the first definition.json path under a base directory's workflow runs. */
function findDefinitionPath(baseDir: string): string {
  const run = discoverWorkflowRuns(baseDir).find((r) => r.hasDefinition);
  if (run) return resolve(run.directoryPath, 'definition.json');
  writeStderr(`${RED}No definition.json found in ${baseDir}${RESET}`);
  process.exit(1);
}

/**
 * Agent text for a one-line log entry: line breaks become spaces, every other
 * control character a visible escape, and a longer text is cut with a marker.
 * (Replacing only newlines, as before, left ESC, OSC and bidi controls live.)
 */
function oneLine(text: string, maxLength: number): string {
  return displayLine(text.replace(/\r?\n/gu, ' ').trim(), maxLength);
}

/** A state name, bold unless `bold` is false, with its definition description; both escaped. */
function stateLabelFor(state: string, descriptions: Map<string, string | undefined> | undefined, bold = true): string {
  const name = bold ? `${BOLD}${displayLine(state)}${RESET}` : displayLine(state);
  const description = descriptions?.get(state);
  return description ? `${name} ${DIM}— "${displayLine(description)}"${RESET}` : name;
}

// ---------------------------------------------------------------------------
// Lint subcommand
// ---------------------------------------------------------------------------

function runLintCommand(args: string[]): void {
  const { values, positionals } = parseArgsStrict({
    args,
    options: {
      strict: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stderr.write(formatHelp(workflowSpec) + '\n');
    return;
  }

  const definitionRef = positionals[0];
  if (!definitionRef) {
    writeStderr(`${RED}Usage: ironcurtain workflow lint <name-or-path> [--strict]${RESET}`);
    process.exit(1);
  }

  const resolved = resolveWorkflowPath(definitionRef);
  if (!resolved) {
    writeStderr(`${RED}Workflow not found: ${definitionRef}${RESET}`);
    writeStderr(`${DIM}Looked in bundled and user workflow directories.${RESET}`);
    process.exit(1);
  }

  // Structural validation first — a malformed definition cannot be linted.
  const definition = loadAndValidateDefinition(resolved);

  const ctx = { ...defaultLintContext, workflowFilePath: resolved };
  const diagnostics = lintWorkflow(definition, ctx);

  if (diagnostics.length === 0) {
    writeStderr(`${DIM}No lint diagnostics for ${resolved}.${RESET}`);
    process.exit(0);
  }

  printDiagnostics(diagnostics);
  const { errors, warnings } = countBySeverity(diagnostics);
  writeStderr(`${DIM}Summary: ${errors} error(s), ${warnings} warning(s).${RESET}`);

  if (errors > 0) process.exit(1);
  if (values.strict === true && warnings > 0) process.exit(2);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// List subcommand
// ---------------------------------------------------------------------------

function runList(): void {
  const workflows = discoverWorkflows();
  if (workflows.length === 0) {
    writeStdout(`${DIM}No workflow definitions found.${RESET}`);
    return;
  }

  // Names and descriptions come from workflow definition files (user-installed
  // packages included): shown with control characters escaped.
  const rows = workflows.map((w) => ({
    name: displayLine(w.name),
    source: displayLine(w.source),
    description: displayLine(w.description),
    hidden: w.hidden,
  }));
  const nameWidth = Math.max(4, ...rows.map((w) => w.name.length));
  const sourceWidth = Math.max(6, ...rows.map((w) => w.source.length));

  const header = `${'NAME'.padEnd(nameWidth)}  ${'SOURCE'.padEnd(sourceWidth)}  DESCRIPTION`;
  writeStdout(`${BOLD}${header}${RESET}`);

  let anyHidden = false;
  for (const wf of rows) {
    // `hidden` workflows are runnable from the CLI but suppressed in the web
    // UI; flag them here so CLI users know which ones won't appear there.
    const marker = wf.hidden ? ` ${DIM}(hidden from web UI)${RESET}` : '';
    if (wf.hidden) anyHidden = true;
    const line = `${wf.name.padEnd(nameWidth)}  ${wf.source.padEnd(sourceWidth)}  ${wf.description}${marker}`;
    writeStdout(line);
  }

  if (anyHidden) {
    writeStdout('');
    writeStdout(
      `${DIM}Workflows marked "hidden from web UI" run from the CLI but are excluded from the daemon web UI.${RESET}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function main(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  // Top-level help
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    process.stderr.write(formatHelp(workflowSpec) + '\n');
    return;
  }

  switch (subcommand) {
    case 'list':
      runList();
      break;
    case 'start':
      await runStart(subArgs);
      break;
    case 'resume-standalone':
      await runResumeStandalone(subArgs);
      break;
    case 'inspect':
      runInspect(subArgs);
      break;
    case 'watch': {
      if (subArgs.includes('--help') || subArgs.includes('-h')) {
        process.stderr.write(formatHelp(workflowSpec) + '\n');
        return;
      }
      const code = await runWorkflowWatch(subArgs);
      // Let Node drain stdout/stderr naturally; synchronous process.exit()
      // can truncate the final replayed JSONL records on piped output.
      process.exitCode = code;
      return;
    }
    case 'lint':
      runLintCommand(subArgs);
      break;
    case 'run-state':
      await runRunState(subArgs);
      break;
    case 'run':
    case 'resume':
    case 'status':
    case 'await':
    case 'gate':
    case 'escalation':
    case 'show': {
      // Daemon-backed, non-interactive commands. They own all stdout/stderr and
      // return an exit code derived from the workflow phase (or a CLI error).
      if (subArgs.includes('--help') || subArgs.includes('-h')) {
        process.stderr.write(formatHelp(workflowSpec) + '\n');
        return;
      }
      // A reader that stops early (`| head -c N`) closes the pipe: the rest of
      // the output is unwanted, and the failed write (EPIPE) must not become an
      // unhandled 'error' event, a stack trace and exit code 1. These commands
      // run to completion, so ignoring it only drops what nobody reads.
      guardStdioStreamErrors(process.stdout);
      guardStdioStreamErrors(process.stderr);
      const code = await runDaemonGateCommand(subcommand, subArgs);
      // Set the exit code and let Node exit once stdout and stderr are
      // flushed. process.exit() here dropped every byte a pipe reader had not
      // consumed yet: `show --json` of a large artifact reached an agent cut
      // off (from 64 KiB) as unparseable JSON with exit code 0. The command
      // has closed everything it opened (the daemon socket, the await timer;
      // an --ensure-daemon child is detached and unref'd), so the process
      // ends as soon as the output is delivered.
      process.exitCode = code;
      return;
    }
    default:
      writeStderr(`${RED}Unknown workflow subcommand: ${subcommand}${RESET}`);
      process.stderr.write(formatHelp(workflowSpec) + '\n');
      process.exit(1);
  }
}
