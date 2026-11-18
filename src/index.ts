import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import ora from 'ora';
import {
  loadConfig,
  loadGeneratedPolicy,
  checkConstitutionFreshness,
  checkAnnotationFreshness,
  getPackageGeneratedDir,
} from './config/index.js';
import { warnOnAnnotationOverlay } from './config/tool-annotations-overlay.js';
import { shouldRunFirstStartWizard } from './config/setup-state.js';
import { modelFlagProblem } from './config/agent-model-guard.js';
import { checkHelp, parseArgsStrict, type CommandSpec } from './cli-help.js';
import * as logger from './logger.js';
import { CliTransport } from './session/cli-transport.js';
import { createStandaloneSession } from './session/index.js';
import { withAgentModelId } from './session/model-budget-precedence.js';
import { formatModeLine, isPreflightError, resolveSessionMode, type PreflightResult } from './session/preflight.js';
import { loadResumeSessionMetadata, resolveResumeAgent, resolveSessionPersona } from './session/session-metadata.js';
import { validateResumeSession } from './pty/session-scanner.js';
import { toDisplayText } from './terminal/display-sanitize.js';
import { validateWorkspacePath } from './session/workspace-validation.js';
import { shouldAutoSaveMemory } from './memory/auto-save.js';
import { resolvePersona } from './persona/resolve.js';
import { readPersonaOverrides } from './persona/persona-overrides.js';
import { isScopedPolicyError } from './config/constitution-hash.js';
import { checkJobPolicyDir } from './cron/job-policy.js';
import type { IronCurtainConfig } from './config/types.js';
import type { AgentId } from './docker/agent-adapter.js';
import type { AgentImageResolution } from './docker/docker-infrastructure.js';
import { formatDockerWorkloadStatus } from './docker-workload/config.js';
import { installShutdownSignals, shutdownSignalOf, signalExitCode } from './utils/shutdown-signals.js';

const startSpec: CommandSpec = {
  name: 'ironcurtain start',
  description: 'Run a one-shot or non-mux agent session',
  usage: ['ironcurtain start [options] [task]'],
  options: [
    { flag: 'resume', short: 'r', description: 'Resume a previous session', placeholder: '<id>' },
    {
      flag: 'agent',
      short: 'a',
      description: 'Agent mode: builtin, claude-code, goose, or codex',
      placeholder: '<name>',
    },
    { flag: 'workspace', short: 'w', description: 'Use an existing directory as the workspace', placeholder: '<path>' },
    { flag: 'persona', short: 'p', description: 'Use a named persona profile', placeholder: '<name>' },
    {
      flag: 'allow-stale-policy',
      description:
        'Run a persona, or resume a job session, whose compiled policy no longer matches its constitution ' +
        '(warns; default: refuse)',
    },
    {
      flag: 'task-scoped',
      description:
        'Narrow the policy to the task: compile the task text into a task scope (cached per task) and escalate ' +
        'every call outside it, on top of the session policy. Opt-in; a new task is first compiled with the LLM',
    },
    {
      flag: 'pty',
      description: 'Legacy raw PTY/debug mode; use ironcurtain mux for normal interactive container sessions',
    },
    { flag: 'model', short: 'm', description: 'Override the agent model ID', placeholder: '<model>' },
    {
      flag: 'provider-profile',
      description: 'Route the container agent through a named provider profile (OpenRouter)',
      placeholder: '<name>',
    },
    {
      flag: 'capture-traces',
      description: 'Capture LLM API traces for this run (overrides config; container mode only)',
    },
    { flag: 'list-agents', description: 'List registered agent adapters' },
  ],
  examples: [
    'ironcurtain start "Summarize files in ."       # Single-shot/non-mux task',
    'ironcurtain start --agent builtin              # Local builtin REPL',
    'ironcurtain start --resume <session-id>        # Resume a non-mux session',
    'ironcurtain start -w ./my-project "Fix bugs"   # Work in existing directory',
    'ironcurtain start --agent claude-code "task"   # Docker: Claude Code',
    'ironcurtain start --agent codex "task"         # Docker: Codex CLI',
    'ironcurtain start -p exec-assistant "Check mail" # Use a persona',
    'ironcurtain start --task-scoped "Summarize ./notes" # Escalate calls the task does not need',
    'ironcurtain start --provider-profile glm-5.2 "task" # Route via an OpenRouter profile',
    'ironcurtain start --pty                        # Legacy raw PTY/debug; prefer ironcurtain mux',
    'ironcurtain start --list-agents                # List available agents',
  ],
};

/**
 * The start-up line naming the session, so the user can resume it later
 * with `ironcurtain start --resume <id>`.
 */
export function formatSessionIdLine(sessionId: string, resumed: boolean): string {
  return resumed
    ? `Resumed session ${sessionId}`
    : `Session ${sessionId} (resume with: ironcurtain start --resume ${sessionId})`;
}

export async function main(args?: string[]): Promise<void> {
  const { values, positionals } = parseArgsStrict(
    {
      args: args ?? process.argv.slice(2),
      options: {
        help: { type: 'boolean', short: 'h' },
        resume: { type: 'string', short: 'r' },
        agent: { type: 'string', short: 'a' },
        workspace: { type: 'string', short: 'w' },
        persona: { type: 'string', short: 'p' },
        'allow-stale-policy': { type: 'boolean' },
        'task-scoped': { type: 'boolean' },
        pty: { type: 'boolean' },
        model: { type: 'string', short: 'm' },
        'provider-profile': { type: 'string' },
        'capture-traces': { type: 'boolean' },
        'list-agents': { type: 'boolean' },
      },
      allowPositionals: true,
    },
    startSpec.name,
  );

  if (checkHelp(values, startSpec)) return;

  // Handle --list-agents: print registered agents and exit
  if (values['list-agents']) {
    const { registerBuiltinAdapters, listAgents } = await import('./docker/agent-registry.js');
    await registerBuiltinAdapters();
    const agents = listAgents();
    for (const agent of agents) {
      process.stderr.write(`  ${agent.id}  ${agent.displayName}\n`);
    }
    return;
  }

  // First-start wizard: until it has completed in this home (config.json's
  // setupCompleted marker, not the file's existence: doctor, mux, the daemon
  // and other commands may have created it first), when stdin is a terminal,
  // and never in a `--pty` child of mux or the web UI. Declining it skips
  // the wizard, not the task (the preflight below still checks credentials);
  // it is offered again on the next start until it completes.
  if (shouldRunFirstStartWizard({ interactive: process.stdin.isTTY, ptyChild: values.pty === true })) {
    const { runFirstStart } = await import('./config/first-start.js');
    await runFirstStart({ mode: 'start' });
  }

  const task = positionals.join(' ');
  const resumeSessionId = values.resume as string | undefined;
  const agentName = values.agent as string | undefined;
  const rawWorkspace = values.workspace as string | undefined;
  const personaName = values.persona as string | undefined;
  const allowStalePolicy = (values['allow-stale-policy'] as boolean | undefined) === true;
  const taskScoped = (values['task-scoped'] as boolean | undefined) === true;
  const providerProfileName = values['provider-profile'] as string | undefined;
  const modelOverride = values.model as string | undefined;
  const modelMisuse = modelFlagProblem(modelOverride);
  if (modelMisuse) {
    process.stderr.write(chalk.red(`${modelMisuse}\n`));
    process.exit(1);
  }
  const captureTracesOverride = (values['capture-traces'] as boolean | undefined) ? true : undefined;
  let config = loadConfig();

  // Apply --model override to both Code Mode and Docker agent model IDs. It
  // is also handed to the session as its explicit model override, so it wins
  // over the persona's agentModelId (see session/model-budget-precedence.ts).
  if (modelOverride) {
    config = withAgentModelId(config, modelOverride);
  }

  // When resuming, CLI --workspace and --persona are ignored -- the original
  // values are restored from persisted session metadata.
  if (resumeSessionId && rawWorkspace) {
    process.stderr.write(chalk.yellow('Note: --workspace is ignored when resuming; original workspace is restored.\n'));
  }
  if (resumeSessionId && personaName) {
    process.stderr.write(chalk.yellow('Note: --persona is ignored when resuming; original persona is restored.\n'));
  }
  if (resumeSessionId && providerProfileName) {
    process.stderr.write(
      chalk.yellow('Note: --provider-profile is ignored when resuming; original profile is restored.\n'),
    );
  }
  if (resumeSessionId && taskScoped) {
    process.stderr.write(
      chalk.yellow('Note: --task-scoped is ignored when resuming; a task-scoped session keeps its original scope.\n'),
    );
  }
  if (taskScoped && !resumeSessionId && task.trim() === '') {
    process.stderr.write(
      chalk.red(
        '--task-scoped needs the task text to compile its scope from: ironcurtain start --task-scoped "<task>"\n',
      ),
    );
    process.exit(1);
  }

  // Validate --workspace before anything else that uses config
  let workspacePath: string | undefined;
  if (rawWorkspace && !resumeSessionId) {
    try {
      workspacePath = validateWorkspacePath(rawWorkspace, config.protectedPaths);
    } catch (error) {
      process.stderr.write(chalk.red(`Invalid workspace: ${error instanceof Error ? error.message : String(error)}\n`));
      process.exit(1);
    }
  }

  // A persona session enforces the persona's policy, so check that one (a
  // resumed session restores its persona, or a cron job's policy directory,
  // from metadata). Session creation refuses a missing or stale scoped policy,
  // or a malformed persona model or budget, anyway; checking here fails before
  // any Docker work and shows the override warning outside the spinner.
  const resumed = resumeSessionId
    ? resumedSessionScope(resumeSessionId, values.pty === true, config.protectedPaths)
    : undefined;
  const effectivePersona = resumeSessionId ? resumed?.persona : personaName;
  if (effectivePersona) {
    const personaModel = checkPersonaOrExit(effectivePersona, allowStalePolicy);
    // Without --model, the persona's agentModelId replaces the global one
    // before the preflight (which checks the builtin model's API key) and
    // the container image preparation (which registers the agent adapters).
    if (personaModel !== undefined && !modelOverride) {
      config = withAgentModelId(config, personaModel);
      process.stderr.write(chalk.dim(`Agent model: ${personaModel} (persona "${effectivePersona}")\n`));
    }
  } else if (resumed?.policyDir !== undefined) {
    checkResumedJobPolicyOrExit(resumed.policyDir, allowStalePolicy);
  }

  // On resume without --agent, the session continues with the agent it was
  // created with (recorded in its metadata), like its persona and workspace:
  // a builtin session must resume as builtin to get its conversation back,
  // even when the configured default is container mode.
  const sessionAgent = resolveResumeAgent(resumeSessionId, agentName);

  // Pre-flight: resolve session mode (auto-detect or validate explicit --agent).
  // Thread the per-session --provider-profile so credential detection reflects
  // the profile the session will actually route through (OpenRouter-only users
  // on a native-default config must not be spuriously blocked). On resume,
  // check the saved route that session creation will restore. A failed
  // preflight (no container runtime, no credentials) ends the command with
  // its message, as for `daemon` and `mux`, not with a stack trace.
  let preflight: PreflightResult;
  try {
    preflight = await resolveSessionMode({
      config,
      requestedAgent: sessionAgent ? (sessionAgent as AgentId) : undefined,
      providerProfileName: resumed ? resumed.providerProfileName : providerProfileName,
    });
  } catch (error) {
    if (!isPreflightError(error)) throw error;
    process.stderr.write(chalk.red(`${error.message}\n`));
    process.exit(1);
  }

  if (!agentName) {
    const shown = sessionAgent ? { ...preflight, reason: `${sessionAgent}, as the resumed session ran` } : preflight;
    process.stderr.write(chalk.dim(`${formatModeLine(shown)}\n`));
  }

  const mode = preflight.mode;

  if (mode.kind === 'docker') {
    const nestedDockerStatus = formatDockerWorkloadStatus(config.userConfig.dockerWorkload);
    if (nestedDockerStatus) process.stderr.write(chalk.dim(`${nestedDockerStatus}\n`));
  }

  // F4: --provider-profile only affects container agent mode; the builtin
  // (Code Mode) agent never reaches profile resolution. Warn on a harmless
  // no-op rather than silently ignoring the flag. Skip on resume (already
  // warned above that the flag is ignored).
  if (providerProfileName && !resumeSessionId && mode.kind !== 'docker') {
    process.stderr.write(
      chalk.yellow(
        'Note: --provider-profile applies only to container agent mode; ignored for the builtin (Code Mode) agent.\n',
      ),
    );
  }

  // Check constitution and annotation freshness once here, before any proxy processes are spawned.
  // The global constitution only governs sessions without their own (persona or job) policy.
  const { compiledPolicy, toolAnnotations, toolAnnotationsOverlay } = loadGeneratedPolicy({
    policyDir: config.generatedDir,
    toolAnnotationsDir: config.toolAnnotationsDir ?? config.generatedDir,
    fallbackDir: getPackageGeneratedDir(),
  });
  if (!effectivePersona && resumed?.policyDir === undefined) {
    checkConstitutionFreshness(compiledPolicy, config.constitutionPath);
  }
  checkAnnotationFreshness(toolAnnotations, config.mcpServers);
  warnOnAnnotationOverlay(toolAnnotationsOverlay);

  // Interrupts are handled from here on, before the image is prepared and
  // before any container, VM or network exists. Node's default action for
  // SIGINT/SIGTERM/SIGHUP ends the process without running teardown, so a
  // Ctrl-C during setup used to leave the half-started container behind. The
  // first signal aborts setup (whatever setup created is torn down before
  // the abort surfaces) or, once a session runs, closes it; a second SIGINT
  // or SIGTERM forces exit (a hangup's repeated SIGHUP does not).
  const interrupt = new AbortController();
  // Set once a session exists: what the first signal does from then on.
  const interruptHook: { onInterrupt?: () => void } = {};
  const uninstallInterruptHandlers = installShutdownSignals(interrupt, {
    onFirstSignal: () => {
      process.stderr.write(chalk.dim('\nShutting down...\n'));
      interruptHook.onInterrupt?.();
    },
  });
  const interruptExitCode = (): number => signalExitCode(shutdownSignalOf(interrupt.signal) ?? 'SIGINT');
  const exitIfInterrupted = (): void => {
    if (!interrupt.signal.aborted) return;
    process.stderr.write(chalk.dim('Interrupted before the session started.\n'));
    process.exit(interruptExitCode());
  };

  // --task-scoped (opt-in only): compile (or reuse) the task scope here, at
  // the CLI entry and before any session or Docker work, so the session
  // layer never reaches the policy pipeline. A resumed session restores
  // its own scope from its metadata instead. The compile is part of setup:
  // an interrupt cancels it (its LLM calls included, and its temporary
  // directory is removed) and nothing is started.
  const taskPolicyDir =
    taskScoped && !resumeSessionId
      ? await prepareTaskScopeOrExit(task, config, workspacePath, { signal: interrupt.signal, exitIfInterrupted })
      : undefined;
  exitIfInterrupted();

  // Pre-flight the Docker image before starting the init spinner: the
  // progress sink and the spinner both render to stderr, so they fight for
  // the same line if they run concurrently. Thread the exact resolution into
  // session setup so the selected nested-Docker artifact is not re-resolved
  // or re-exported behind the spinner.
  let preparedDockerImageResolution: AgentImageResolution | undefined;
  if (mode.kind === 'docker') {
    const { ensureDockerImage } = await import('./docker/docker-infrastructure.js');
    try {
      preparedDockerImageResolution = await ensureDockerImage(mode.agent, config.userConfig);
    } catch (error) {
      // A terminal Ctrl-C also reaches the build process, which then fails.
      exitIfInterrupted();
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`\n${chalk.red('Docker image setup failed:')} ${message}\n`);
      process.exit(1);
    }
    // An interrupt during the build never proceeds to create a container.
    exitIfInterrupted();
  }

  // PTY mode: attach terminal directly to Claude Code in an agent container.
  if (values.pty) {
    if (mode.kind !== 'docker') {
      process.stderr.write(
        chalk.red(
          'PTY mode requires container agent mode. Use --agent claude-code or ensure a container runtime is available.\n',
        ),
      );
      process.exit(1);
    }

    // With --task-scoped the task text only sets the scope; it is never
    // sent to the agent (there is no initial message in PTY mode).
    if (task && !taskScoped) {
      process.stderr.write(
        chalk.red('PTY mode is interactive -- do not provide a task message. Type your commands in the PTY.\n'),
      );
      process.exit(1);
    }

    const { runPtySession } = await import('./docker/pty-session.js');
    exitIfInterrupted();
    // runPtySession installs its own interrupt handling, before it allocates
    // anything, for the session's whole lifecycle. No event-loop turn passes
    // between this handover and that installation.
    uninstallInterruptHandlers();
    try {
      await runPtySession({
        config,
        mode,
        workspacePath,
        resumeSessionId,
        persona: resumeSessionId ? undefined : personaName,
        allowStalePolicy,
        ...(taskPolicyDir !== undefined ? { taskPolicyDir } : {}),
        providerProfileName: resumeSessionId ? undefined : providerProfileName,
        ...(modelOverride ? { agentModelOverride: modelOverride } : {}),
        captureTracesOverride,
        preparedImageResolution: preparedDockerImageResolution,
      });
    } catch (error) {
      const interrupted = ptyInterruption(error);
      if (interrupted === undefined) throw error;
      // Setup was interrupted; its teardown has already run.
      process.stderr.write(chalk.dim('PTY session interrupted.\n'));
      process.exit(signalExitCode(interrupted));
    }
    process.exit(0);
  }

  // Create the transport first so we can wire its callbacks into the session.
  // Memory auto-save follows the persona the session actually runs with: on
  // resume that is the one recorded in the session's metadata, not --persona.
  const transport = new CliTransport({
    initialMessage: task || undefined,
    autoSaveMemory: shouldAutoSaveMemory(config, { persona: resolveSessionPersona(resumeSessionId, personaName) }),
    dockerMode: mode.kind === 'docker',
  });

  const initSpinner = ora({
    text: mode.kind === 'docker' ? `Initializing Docker session (${mode.agent})...` : 'Initializing session...',
    stream: process.stderr,
    discardStdin: false,
  }).start();

  let session: Awaited<ReturnType<typeof createStandaloneSession>>;
  try {
    session = await createStandaloneSession({
      config,
      mode,
      resumeSessionId,
      // workspacePath is already undefined when resuming (validation skipped above)
      workspacePath,
      persona: resumeSessionId ? undefined : personaName,
      allowStalePolicy,
      ...(taskPolicyDir !== undefined ? { taskPolicyDir } : {}),
      providerProfileName: resumeSessionId ? undefined : providerProfileName,
      ...(modelOverride ? { agentModelOverride: modelOverride } : {}),
      captureTracesOverride,
      preparedDockerImageResolution,
      // An interrupt ends container readiness waits early; the factory tears
      // down what it created before rejecting.
      abortSignal: interrupt.signal,
      onEscalation: transport.createEscalationHandler(),
      onEscalationExpired: transport.createEscalationExpiredHandler(),
      onDiagnostic: transport.createDiagnosticHandler(),
    });
  } catch (error) {
    if (interrupt.signal.aborted) {
      initSpinner.fail(chalk.red('Session initialization interrupted'));
      process.exit(interruptExitCode());
    }
    initSpinner.fail(chalk.red('Session initialization failed'));
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n${chalk.red('Error:')} ${message}\n`);
    process.exit(1);
  }

  if (interrupt.signal.aborted) {
    // The interrupt arrived after the last abortable setup step.
    initSpinner.fail(chalk.red('Session initialization interrupted'));
    await session.close().catch(() => {});
    logger.teardown();
    process.exit(interruptExitCode());
  }

  initSpinner.succeed(chalk.dim('Session ready'));
  // The ID to pass to --resume later. A resumed session keeps its ID (a
  // Docker session's runtime ID differs, but its directory is the resumed one).
  process.stderr.write(
    chalk.dim(`${formatSessionIdLine(resumeSessionId ?? session.getInfo().id, !!resumeSessionId)}\n`),
  );
  process.stderr.write('\n');

  // The session is closed once, by whichever comes first: the end of the run
  // below or an interrupt. A second session.close() returns at once, so
  // without sharing this one the run's exit could cut the interrupt's
  // teardown short (and the other way round).
  let closing: Promise<void> | undefined;
  const closeSession = (): Promise<void> => (closing ??= session.close());

  // From here the first signal (Ctrl-C, SIGTERM, SIGHUP) initiates graceful
  // shutdown; the second still force-exits immediately. Once the session has
  // closed, an interrupted session exits with 128 plus the signal number, as
  // an interrupted setup does: its task did not complete.
  interruptHook.onInterrupt = (): void => {
    transport.close();
    // Force exit if cleanup takes too long
    // Docker allows each stop operation ten seconds, followed by container
    // removal and network removal. Keep the emergency deadline above that
    // cleanup budget so the fallback does not itself orphan the network.
    const forceExitTimeout = setTimeout(() => process.exit(1), 30_000);
    forceExitTimeout.unref();
    closeSession()
      .catch(() => {})
      .finally(() => {
        clearTimeout(forceExitTimeout);
        logger.teardown();
        process.exit(interruptExitCode());
      });
  };

  // The exit status tells scripts whether the task completed: 1 when the run
  // failed or a budget stopped it. The transport has already printed the
  // error (and, after a budget stop, what the session spent).
  let exitCode = 0;
  try {
    await transport.run(session);
  } catch {
    exitCode = 1;
  } finally {
    // Signal handlers stay active during cleanup so a second Ctrl-C can
    // force-exit.
    await closeSession();
    uninstallInterruptHandlers();
    logger.teardown();
    // An interrupt that ended the run sets the status, as it does in the
    // interrupt handler, whichever of the two exits first.
    const interruptedBy = shutdownSignalOf(interrupt.signal);
    process.exit(interruptedBy ? signalExitCode(interruptedBy) : exitCode);
  }
}

/**
 * Compiles (or reuses from the cache) the task scope for `--task-scoped`
 * and returns its directory. Exits with an error when no scope can be
 * prepared: the user asked for a narrowed session, so it never silently
 * starts unscoped. The pipeline is reached only through this dynamic
 * import (the sanctioned seam).
 *
 * `interruption.signal` (the start command's setup interrupt) cancels the
 * compile; a compile that failed because of it exits through
 * `interruption.exitIfInterrupted` (the signal's exit code), not as an error.
 */
async function prepareTaskScopeOrExit(
  task: string,
  config: IronCurtainConfig,
  workspacePath: string | undefined,
  interruption: { readonly signal: AbortSignal; readonly exitIfInterrupted: () => void },
): Promise<string> {
  process.stderr.write(chalk.dim('Preparing the task scope (--task-scoped)...\n'));
  try {
    const { compileTaskScopePolicy, formatTaskScopeSummary } = await import('./cron/compile-task-policy.js');
    const scope = await compileTaskScopePolicy(task, {
      config,
      signal: interruption.signal,
      ...(workspacePath ? { workspacePath } : {}),
    });
    for (const line of formatTaskScopeSummary(scope)) process.stderr.write(chalk.dim(`${line}\n`));
    return scope.policyDir;
  } catch (error) {
    interruption.exitIfInterrupted();
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(chalk.red(`Could not prepare the task scope: ${message}\n`));
    process.stderr.write(
      chalk.yellow('The session was not started. Run without --task-scoped for an unscoped session.\n'),
    );
    process.exit(1);
  }
}

/**
 * Use the same inputs as session creation before checking credentials. PTY
 * sessions restore their provider from the snapshot and revalidate it under
 * their resume lock. Older sessions may have no recorded provider.
 */
function resumedSessionScope(
  resumeSessionId: string,
  pty: boolean,
  protectedPaths: readonly string[],
): { persona?: string; policyDir?: string; providerProfileName?: string } {
  try {
    const metadata = loadResumeSessionMetadata(resumeSessionId);
    const snapshot = pty ? validateResumeSession(resumeSessionId, protectedPaths) : undefined;
    return {
      persona: metadata?.persona,
      policyDir: metadata?.policyDir,
      providerProfileName: snapshot ? snapshot.providerProfileName : metadata?.providerProfileName,
    };
  } catch (error) {
    process.stderr.write(chalk.red(toDisplayText(error instanceof Error ? error.message : String(error))) + '\n');
    process.exit(1);
  }
}

/**
 * For a resumed cron job session (its metadata restores the job's policy
 * directory): exits with an error when the job's compiled policy is missing,
 * or no longer matches the job's current constitution and
 * `--allow-stale-policy` was not given. With the override, prints a warning
 * and returns. Any other policy directory is left to session creation.
 */
function checkResumedJobPolicyOrExit(policyDir: string, allowStalePolicy: boolean): void {
  const check = checkJobPolicyDir(policyDir);
  if (check === undefined || check.ok) return;
  if (check.problem === 'stale' && allowStalePolicy) {
    process.stderr.write(
      chalk.yellow(`Warning: ${check.message}. Resuming with it because --allow-stale-policy was given.\n`),
    );
    return;
  }
  process.stderr.write(chalk.red(`${check.message}\n`));
  if (check.problem === 'stale') {
    process.stderr.write(chalk.yellow('To resume with the stale policy anyway, pass --allow-stale-policy.\n'));
  }
  process.exit(1);
}

/**
 * Exits with an error when the persona cannot run: its compiled policy is
 * missing, or stale without `--allow-stale-policy`, or its `agentModelId` or
 * `resourceBudget` is malformed. With the stale-policy override, prints a
 * warning and returns: the user explicitly chose to run the old policy.
 * Returns the persona's agentModelId, when it sets one.
 */
function checkPersonaOrExit(persona: string, allowStalePolicy: boolean): string | undefined {
  try {
    const resolved = resolvePersona(persona, { allowStalePolicy });
    const overrides = readPersonaOverrides(persona, resolved.persona);
    if (resolved.stalePolicy) {
      process.stderr.write(
        chalk.yellow(
          `Warning: persona "${persona}" has a stale compiled policy (${resolved.stalePolicy.detail}). ` +
            'Running with it because --allow-stale-policy was given. ' +
            `Recompile with: ironcurtain persona compile ${persona}\n`,
        ),
      );
    }
    return overrides.agentModelId;
  } catch (error) {
    process.stderr.write(chalk.red(`${error instanceof Error ? error.message : String(error)}\n`));
    if (isScopedPolicyError(error, 'POLICY_STALE')) {
      process.stderr.write(chalk.yellow('To run with the stale policy anyway, pass --allow-stale-policy.\n'));
    }
    process.exit(1);
  }
}

/**
 * The interrupting signal when `error` is runPtySession's setup interruption
 * (matched by its `PTY_INTERRUPTED` code, not by class).
 */
function ptyInterruption(error: unknown): NodeJS.Signals | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, signal } = error as { code?: unknown; signal?: unknown };
  if (code !== 'PTY_INTERRUPTED') return undefined;
  return signal === 'SIGTERM' || signal === 'SIGHUP' ? signal : 'SIGINT';
}

// Only run when executed directly (not when imported by cli.ts, which loads
// credentials itself). Never from a .env in the working directory.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { bootstrapTrustedEnvForProcess } = await import('./config/trusted-env.js');
  bootstrapTrustedEnvForProcess();
  main().catch((err: unknown) => {
    process.stderr.write(chalk.red(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  });
}
