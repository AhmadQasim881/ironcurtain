/**
 * CLI entry point for `ironcurtain daemon` and its subcommands.
 *
 * When no sub-subcommand is given, starts the unified daemon.
 * Subcommands: add-job, list-jobs, run-job, remove-job,
 *              disable-job, enable-job, recompile-job, logs
 *
 * Commands that act on jobs (list-jobs, run-job, remove-job, enable-job,
 * disable-job, recompile-job) are forwarded to the running daemon over the
 * control socket. They run locally only when no daemon is reachable at all,
 * and then only while holding the daemon lock (see daemon-lock.ts). A daemon
 * that took a request but failed or never answered ends the command with an
 * error: it may already be doing the work, so it is never repeated locally.
 * remove-job asks for confirmation before either (unless -f/--force).
 * add-job and edit-job write the job files themselves and then ask a running
 * daemon to reload the job, so it is scheduled without a restart.
 *
 * Text the daemon relays (its errors, a failed run's error) can quote agent-
 * or remote-influenced output, so it is printed through toDisplayText.
 *
 * Only the paths that run agent sessions in this process, starting the daemon
 * and a run-job no daemon took, check the V8 sandbox and resolve the session
 * mode (which probes the container runtime and credentials). Every other
 * subcommand works without either, so `list-jobs`, `status` or `logs` work
 * where isolated-vm cannot load or Docker is down.
 */

import { DAEMON_FORCE_EXIT_MS, IronCurtainDaemon } from './ironcurtain-daemon.js';
import {
  parseRecompileJobResult,
  parseRunJobAccepted,
  sendControlRequest,
  waitForDaemonJobRun,
  type ControlRequest,
  type ControlResponseOk,
  type DaemonStatusDto,
} from './control-socket.js';
import { acquireDaemonLock, isDaemonLockBusyError, type DaemonLock } from './daemon-lock.js';
import type { AgentId } from '../docker/agent-adapter.js';
import { formatDuration, formatFailureStreak } from '../cron/format-utils.js';
import { describeFailedServers, PARTIAL_COMPILE_EXIT_CODE } from '../cron/partial-compile.js';
import { formatCostUsd } from '../session/cost-display.js';
import { checkHelp, parseArgsStrict, type CommandSpec } from '../cli-help.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { installWorkflowShutdownSignals, type WorkflowShutdownSignal } from '../workflow/shutdown-signals.js';
import { ensureSandboxViable } from '../utils/preflight-checks.js';
import { formatSetupPendingNotice, readFirstStartSetupState } from '../config/setup-state.js';
import * as logger from '../logger.js';
import type { PreflightResult } from '../session/preflight.js';

/** The signals that always stop the daemon gracefully (see installDaemonShutdownSignals). */
const DAEMON_SHUTDOWN_SIGNALS: readonly WorkflowShutdownSignal[] = ['SIGINT', 'SIGTERM'];

/** An output stream as far as {@link installDaemonShutdownSignals} looks at it. */
interface DaemonOutputStream {
  readonly isTTY?: boolean;
}

/**
 * Wires SIGINT and SIGTERM to one graceful daemon shutdown, then exit 0 (1 if
 * the shutdown itself throws). The shutdown runs once: a second SIGINT or
 * SIGTERM forces the exit at once, and so does an overrun of
 * {@link DAEMON_FORCE_EXIT_MS}, both with 128 + the signal number.
 *
 * SIGHUP gets a listener too, because Node's default action for it ends the
 * daemon at once, with no drain, even under `nohup`: Node resets the ignored
 * disposition nohup sets to the default when it starts. Which listener depends
 * on whether the daemon runs in a terminal, that is whether its stdout or
 * stderr (`output`) is a TTY:
 * - in a terminal: a hangup means the terminal is gone, so SIGHUP drains the
 *   daemon like SIGTERM. A repeated SIGHUP (a closing terminal sends two)
 *   never forces the exit.
 * - not in a terminal (`nohup`, which moves stdout and stderr off it; a
 *   service manager; the detached `--ensure-daemon` child): SIGHUP is
 *   ignored, so the daemon keeps running after a logout. Standard input does
 *   not count, because BSD and macOS `nohup` leave it on the terminal.
 *
 * Returns the unregister thunk.
 */
export function installDaemonShutdownSignals(
  daemon: Pick<IronCurtainDaemon, 'shutdown'>,
  options: {
    readonly exit?: (code: number) => void;
    readonly forceExitAfterMs?: number;
    /** The streams checked for a terminal. Default: process.stdout and process.stderr. */
    readonly output?: readonly DaemonOutputStream[];
  } = {},
): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const output = options.output ?? [process.stdout, process.stderr];
  const drainOnHangup = output.some((stream) => stream.isTTY === true);
  const uninstallShutdown = installWorkflowShutdownSignals(new AbortController(), {
    signals: drainOnHangup ? [...DAEMON_SHUTDOWN_SIGNALS, 'SIGHUP'] : DAEMON_SHUTDOWN_SIGNALS,
    forceExitAfterMs: options.forceExitAfterMs ?? DAEMON_FORCE_EXIT_MS,
    forceExit: exit,
    onFirstSignal: (signal) => {
      const forceWith = signal === 'SIGHUP' ? 'SIGTERM' : `${signal} again`;
      process.stderr.write(`\nCaught ${signal}; shutting down the daemon (send ${forceWith} to force exit)...\n`);
      daemon.shutdown().then(
        () => exit(0),
        (err: unknown) => {
          process.stderr.write(`Daemon shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`);
          exit(1);
        },
      );
    },
  });
  if (drainOnHangup) return uninstallShutdown;

  // A hangup the daemon ignores can still have ended the reader of a piped
  // stdout or stderr (`ironcurtain daemon 2>&1 | tee daemon.out` in the
  // terminal that closed). From then on a failed write to them (EPIPE) is
  // expected and must not crash the daemon. Own functions, so the unregister
  // thunk removes exactly these listeners.
  const ignoreOutputError = (): void => {};
  let outputGuarded = false;
  const ignoreHangup = (): void => {
    logger.info('[Daemon] Ignored SIGHUP: the daemon does not run in a terminal (stop it with SIGTERM)');
    if (outputGuarded) return;
    outputGuarded = true;
    process.stdout.on('error', ignoreOutputError);
    process.stderr.on('error', ignoreOutputError);
  };
  process.on('SIGHUP', ignoreHangup);
  return () => {
    process.off('SIGHUP', ignoreHangup);
    if (outputGuarded) {
      process.stdout.off('error', ignoreOutputError);
      process.stderr.off('error', ignoreOutputError);
    }
    uninstallShutdown();
  };
}

const daemonSpec: CommandSpec = {
  name: 'ironcurtain daemon',
  description: 'Unified Signal + cron daemon',
  usage: [
    'ironcurtain daemon [options]              Start the daemon',
    'ironcurtain daemon <subcommand> [options]  Manage jobs',
  ],
  subcommands: [
    {
      name: 'add-job',
      description:
        'Add a new scheduled job (interactive). Exit status 2: its policy was written without some servers, ' +
        'which failed to compile, and the job was saved disabled',
    },
    {
      name: 'edit-job <id>',
      description: 'Edit an existing job (interactive). Exit status 2: recompiled, but some servers failed',
    },
    { name: 'list-jobs', description: 'List all jobs with schedule info' },
    { name: 'run-job <id>', description: 'Manually trigger a job run' },
    { name: 'status', description: 'Show daemon status' },
    { name: 'remove-job <id>', description: 'Delete a job and all artifacts' },
    { name: 'disable-job <id>', description: 'Stop scheduling a job' },
    { name: 'enable-job <id>', description: 'Resume scheduling a job' },
    {
      name: 'recompile-job <id>',
      description:
        'Re-run policy compilation. Exit status 2: written, but some servers failed and have no rules ' +
        '(their tools are denied)',
    },
    { name: 'logs <id>', description: 'Show recent run summaries' },
  ],
  options: [
    { flag: 'agent', short: 'a', description: 'Agent mode (same as start)', placeholder: '<name>' },
    { flag: 'force', short: 'f', description: 'Skip confirmation prompts' },
    { flag: 'no-signal', description: 'Skip Signal transport (cron-only mode)' },
    { flag: 'web-ui', description: 'Enable web UI server' },
    { flag: 'web-port', description: 'Web UI port (default: 7400)', placeholder: '<port>' },
    { flag: 'web-ui-dev', description: 'Also accept the Vite dev server origin (localhost:5173)' },
    { flag: 'capture-traces', description: 'Capture LLM API traces for every session this daemon launches' },
    {
      flag: 'allow-policy-mutation',
      description: 'Enable persona policy-mutation methods over the web UI (off by default)',
    },
    { flag: 'runs', description: 'Number of recent runs to show (for logs)', placeholder: '<N>' },
  ],
};

/** Extracts a required job-id positional, exiting with usage if missing. */
function requireJobIdArg(positionals: string[]): string {
  const jobId = positionals[1];
  if (!jobId) {
    console.error('Usage: ironcurtain daemon <subcommand> <job-id>');
    process.exit(1);
  }
  return jobId;
}

/** Prints the lines to stderr and exits with status 1. */
function exitWithError(...lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

/**
 * Sends `request` to the running daemon. Returns its successful response, or
 * `undefined` when no daemon is reachable: the only case in which the caller
 * may run the command locally, through {@link runLocally}. A daemon that took
 * the request but answered with an error, dropped the connection or timed
 * out ends the command with exit code 1.
 */
async function forwardToDaemon(request: ControlRequest): Promise<ControlResponseOk | undefined> {
  const result = await sendControlRequest(request);
  if (result.kind === 'unreachable') return undefined;
  if (result.kind === 'failed') {
    exitWithError(
      `Error: the daemon did not complete ${request.command}: ${result.reason}.`,
      'It may still be acting on the request, so it was not run locally.',
    );
  }
  if (!result.response.ok) exitWithError(daemonErrorLine(result.response.error));
  return result.response;
}

/**
 * "Error from daemon: ..." for an error the daemon answered with. It can quote
 * agent- or remote-influenced text (git and compile errors), so control
 * characters are shown as escapes.
 */
function daemonErrorLine(error: string): string {
  return `Error from daemon: ${toDisplayText(error, { multiline: true })}`;
}

/**
 * Runs a job command locally because no daemon answered, holding the daemon
 * lock meanwhile. A daemon whose socket did not answer still holds that lock,
 * so the command refuses instead of doing the work beside it, and no daemon
 * can start (and run the same job) until the local command finishes.
 */
async function runLocally(action: () => Promise<void> | void): Promise<void> {
  let lock: DaemonLock;
  try {
    lock = acquireDaemonLock();
  } catch (err) {
    if (!isDaemonLockBusyError(err)) throw err;
    exitWithError(
      `Error: ${err.message}`,
      'It did not answer on its control socket, so the command was not run locally either.',
    );
  }
  try {
    await action();
  } finally {
    try {
      lock.release();
    } catch (err) {
      console.error(`Warning: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * The preflight of a path that runs agent sessions in this process (starting
 * the daemon, a local run-job): the V8 sandbox check, then the session mode
 * for `--agent` (same resolution as `start`), whose line it prints. A
 * PreflightError (no container runtime for a Docker agent, missing
 * credentials) ends the command with its message. The other subcommands never
 * call this.
 */
async function resolveDaemonSessionMode(agent: string | undefined): Promise<PreflightResult> {
  await ensureSandboxViable();
  const { resolveSessionMode, formatModeLine } = await import('../session/preflight.js');
  const { loadConfig } = await import('../config/index.js');
  let preflight: PreflightResult;
  try {
    preflight = await resolveSessionMode({
      config: loadConfig(),
      requestedAgent: agent ? (agent as AgentId) : undefined,
    });
  } catch (err) {
    // PreflightError, matched by name: its message is the whole report.
    if (!(err instanceof Error) || err.name !== 'PreflightError') throw err;
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`${formatModeLine(preflight)}\n`);
  return preflight;
}

/**
 * Preflight's host-model warnings, printed once by the paths that run
 * sessions in this process: starting the daemon and a local `run-job`. The
 * other subcommands run no session here.
 */
function printPreflightWarnings(preflight: PreflightResult): void {
  for (const warning of preflight.warnings ?? []) process.stderr.write(`Warning: ${warning}\n`);
}

/**
 * Points out, when the daemon starts, a home where the first-start wizard
 * never completed (see config/setup-state.ts): the daemon usually runs
 * without a terminal and never runs the wizard itself.
 */
function printSetupPendingNotice(): void {
  if (readFirstStartSetupState() === 'pending') process.stderr.write(`${formatSetupPendingNotice()}\n`);
}

/**
 * Waits for a run the daemon accepted and reports it. Never runs the job
 * locally: once the daemon has the run, losing contact is reported as such.
 */
async function reportDaemonRun(jobId: string, data: unknown): Promise<void> {
  const accepted = parseRunJobAccepted(data);
  if (!accepted) {
    exitWithError(
      'Error: the daemon sent an unexpected reply to run-job.',
      `The job may be running there; it was not run locally. Check: ironcurtain daemon logs ${jobId}`,
    );
  }
  console.error(`Job "${jobId}" is running in the daemon (run ${accepted.runId}). Waiting for it to finish...`);
  console.error('Press Ctrl-C to stop waiting; the run continues in the daemon.');

  const result = await waitForDaemonJobRun(accepted.runId);
  if (result.kind === 'lost') {
    // The reason can be the daemon's error reply (agent-influenced text).
    exitWithError(
      `Error: lost track of job "${jobId}" in the daemon: ${toDisplayText(result.reason, { multiline: true })}.`,
      `The run may still be in progress there; it was not run locally. Check: ironcurtain daemon logs ${jobId}`,
    );
  }
  if (result.kind === 'failed') exitWithError(daemonErrorLine(`job "${jobId}" failed: ${result.error}`));

  const record = result.record;
  console.error(`Job "${jobId}" completed via daemon.`);
  console.error(`  Outcome: ${toDisplayText(record.outcome.kind)}`);
  console.error(`  Duration: ${record.budget.elapsedSeconds.toFixed(0)}s`);
  console.error(`  Cost: ${formatCostUsd(record.budget.estimatedCostUsd, record.budget.costSource)}`);
  for (const notice of record.notices ?? []) {
    console.error(toDisplayText(notice, { multiline: true }));
  }
  if (record.outcome.kind !== 'success') process.exitCode = 1;
}

export async function runDaemonCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgsStrict(
    {
      args: argv,
      options: {
        agent: { type: 'string', short: 'a' },
        'no-signal': { type: 'boolean' },
        'web-ui': { type: 'boolean' },
        'web-port': { type: 'string' },
        'web-ui-dev': { type: 'boolean' },
        'capture-traces': { type: 'boolean' },
        'allow-policy-mutation': { type: 'boolean' },
        force: { type: 'boolean', short: 'f' },
        runs: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    },
    daemonSpec.name,
  );

  if (checkHelp(values, daemonSpec)) {
    return;
  }

  const subcommand = positionals[0];
  const agent = values.agent as string | undefined;

  if (!subcommand) {
    const webUiEnabled = values['web-ui'] as boolean | undefined;
    const webPort = values['web-port'] ? parseInt(values['web-port'] as string, 10) : undefined;
    if (webPort !== undefined && (!Number.isFinite(webPort) || webPort < 1 || webPort > 65535)) {
      process.stderr.write('Error: --web-port must be a number between 1 and 65535\n');
      process.exit(1);
    }
    const webUiDev = values['web-ui-dev'] as boolean | undefined;

    // Start the daemon. Its sessions report the host-model warnings in the
    // web UI or Signal, if at all: say them once here.
    const preflight = await resolveDaemonSessionMode(agent);
    const mode = preflight.mode;
    printPreflightWarnings(preflight);
    printSetupPendingNotice();

    const captureTracesDefault = (values['capture-traces'] as boolean | undefined) ?? false;
    const allowPolicyMutation = (values['allow-policy-mutation'] as boolean | undefined) ?? false;
    const daemon = new IronCurtainDaemon({
      mode,
      noSignal: values['no-signal'] as boolean | undefined,
      webUi: webUiEnabled ? { port: webPort, devMode: webUiDev } : undefined,
      captureTracesDefault,
      allowPolicyMutation,
    });

    // One graceful shutdown (workflows drained within their deadline); a
    // second SIGINT or SIGTERM forces the exit. SIGHUP drains it too when it
    // runs in a terminal, and is ignored when it does not (nohup, services).
    installDaemonShutdownSignals(daemon);

    try {
      await daemon.start();
    } catch (err) {
      // stderr directly: a failed start has already handed console.* back.
      if (isDaemonLockBusyError(err)) {
        process.stderr.write(`Error: ${err.message}\nStop it first; only one daemon may run per IronCurtain home.\n`);
      } else {
        process.stderr.write(
          `Error: the daemon failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      process.exit(1);
    }
    return;
  }

  // Sub-subcommands that work without a running daemon
  switch (subcommand) {
    case 'add-job': {
      const { runAddJobWizard } = await import('../cron/job-commands.js');
      await runAddJobWizard();
      break;
    }
    case 'edit-job': {
      const jobId = requireJobIdArg(positionals);
      const { runEditJobWizard } = await import('../cron/job-commands.js');
      await runEditJobWizard(jobId);
      break;
    }
    case 'status': {
      const result = await sendControlRequest({ command: 'status' });
      if (result.kind === 'unreachable') {
        console.error('Daemon is not running.');
        break;
      }
      if (result.kind === 'failed') exitWithError(`Error: the daemon did not answer: ${result.reason}.`);
      if (!result.response.ok) exitWithError(daemonErrorLine(result.response.error));
      const status = result.response.data as DaemonStatusDto;
      const uptimeStr = formatDuration(status.uptimeSeconds);
      console.error('Daemon is running.');
      console.error(`  Uptime:             ${uptimeStr}`);
      const failing = status.jobs.failing === undefined ? '' : `, ${status.jobs.failing} failing`;
      console.error(
        `  Jobs:               ${status.jobs.total} total, ${status.jobs.enabled} enabled, ${status.jobs.running} running${failing}`,
      );
      // Job ids are validated slugs, safe to print as-is.
      for (const entry of status.failingJobs ?? []) {
        console.error(`  Failing job:        ${entry.jobId} (${formatFailureStreak(entry.consecutiveFailures)})`);
      }
      // Not connected also when an `ironcurtain bot` runs Signal for this home.
      console.error(`  Signal transport:   ${status.signalConnected ? 'connected' : 'not connected'}`);
      if (status.nextFireTime) {
        const { formatRelativeTime } = await import('../cron/format-utils.js');
        console.error(`  Next scheduled run: ${formatRelativeTime(new Date(status.nextFireTime))}`);
      } else {
        console.error('  Next scheduled run: none');
      }
      break;
    }
    case 'list-jobs': {
      const response = await forwardToDaemon({ command: 'list-jobs' });
      if (response) {
        const { formatDaemonJobList } = await import('../cron/job-commands.js');
        formatDaemonJobList(response.data as import('../cron/job-commands.js').DaemonJobListEntry[]);
        break;
      }
      // Read-only, so no daemon lock is needed.
      const { runListJobs } = await import('../cron/job-commands.js');
      runListJobs();
      break;
    }
    case 'run-job': {
      const jobId = requireJobIdArg(positionals);
      const response = await forwardToDaemon({ command: 'run-job', jobId });
      if (response) {
        await reportDaemonRun(jobId, response.data);
        break;
      }
      const { runJobCommand } = await import('../cron/job-commands.js');
      // No daemon took the run, so it runs here: only now check the sandbox
      // and resolve the mode (--agent included), once; runJobCommand gets
      // that mode instead of resolving it again. The job's headless session
      // shows the host-model warnings nowhere else, so a run in this process
      // prints them (a daemon that takes the run said them when it started).
      const preflight = await resolveDaemonSessionMode(agent);
      await runLocally(() => {
        printPreflightWarnings(preflight);
        return runJobCommand(jobId, preflight.mode);
      });
      break;
    }
    case 'remove-job': {
      const jobId = requireJobIdArg(positionals);
      const { confirmJobRemoval, runRemoveJob } = await import('../cron/job-commands.js');
      // Removal deletes the workspace and run history for good, so ask first
      // (unless -f/--force), whichever process deletes the job: a running
      // daemon, or this process when none is reachable.
      if (values.force !== true && !(await confirmJobRemoval(jobId))) break;
      if (await forwardToDaemon({ command: 'remove-job', jobId })) {
        console.error(`Job "${jobId}" removed (daemon notified).`);
        break;
      }
      // Already confirmed above.
      await runLocally(() => runRemoveJob(jobId, true));
      break;
    }
    case 'disable-job': {
      const jobId = requireJobIdArg(positionals);
      if (await forwardToDaemon({ command: 'disable-job', jobId })) {
        console.error(`Job "${jobId}" disabled (daemon notified).`);
        break;
      }
      const { runDisableJob } = await import('../cron/job-commands.js');
      await runLocally(() => runDisableJob(jobId));
      break;
    }
    case 'enable-job': {
      const jobId = requireJobIdArg(positionals);
      if (await forwardToDaemon({ command: 'enable-job', jobId })) {
        console.error(`Job "${jobId}" enabled (daemon notified).`);
        break;
      }
      const { runEnableJob } = await import('../cron/job-commands.js');
      await runLocally(() => runEnableJob(jobId));
      break;
    }
    case 'recompile-job': {
      const jobId = requireJobIdArg(positionals);
      const response = await forwardToDaemon({ command: 'recompile-job', jobId });
      if (response) {
        console.error(`Job "${jobId}" policy recompiled (daemon notified).`);
        // Servers that failed to compile and have no rules (the daemon's log has the reasons).
        const failed = parseRecompileJobResult(response.data)?.failedServers ?? [];
        if (failed.length > 0) {
          console.error(`${describeFailedServers(failed)} The daemon log has the reasons.`);
          process.exitCode = PARTIAL_COMPILE_EXIT_CODE;
        }
        break;
      }
      const { runRecompileJob } = await import('../cron/job-commands.js');
      await runLocally(() => runRecompileJob(jobId));
      break;
    }
    case 'logs': {
      const jobId = requireJobIdArg(positionals);
      const limit = values.runs ? parseInt(values.runs as string, 10) : 5;
      const { runShowLogs } = await import('../cron/job-commands.js');
      runShowLogs(jobId, limit);
      break;
    }
    default:
      console.error(`Unknown daemon subcommand: ${subcommand}\n`);
      checkHelp({ help: true }, daemonSpec);
      process.exit(1);
  }
}
