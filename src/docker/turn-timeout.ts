/**
 * Per-turn wall-clock enforcement for container agent turns (Docker and
 * Apple `container`), and the same bound for the commands of a workflow's
 * `container: true` deterministic states ({@link runBoundedContainerCommand}).
 *
 * The host-side `exec` deadline alone cannot stop a runaway agent: Node only
 * signals the host `docker exec` / `container exec` client, `docker exec`
 * does not forward signals, and `--init` does not cover exec'd processes
 * (audit finding DINF-8). This module makes the limit real by wrapping each
 * turn in coreutils `timeout`, which runs the command in its own process
 * group and signals the whole group: SIGTERM at the deadline, SIGKILL
 * `--kill-after` seconds later. The host deadline becomes a backstop that is
 * only reached when the in-container wrapper could not end the exec, for
 * example when a stray child keeps the exec's stdout pipe open.
 *
 * Every process of a turn carries an `IRONCURTAIN_TURN_ID` environment marker.
 * After any detected timeout, {@link killTimedOutTurn} runs a best-effort
 * sweep inside the container that SIGKILLs every process whose environment
 * still carries the marker. That reaches children that left the turn's
 * process group (a tool subprocess spawned detached, or one that called
 * `setsid`), which the group kill misses. The sweep runs as the agent user:
 * container root holds neither CAP_KILL nor CAP_SYS_PTRACE in these
 * containers, so only the same-UID path can read `/proc/<pid>/environ` and
 * signal the agent's processes. A process that scrubbed its environment, or
 * one started through `sudo` (which resets the environment), is outside what
 * any per-turn mechanism can reach; container teardown remains the final
 * bound.
 *
 * Limits of the mechanism: it bounds a runaway or looping agent. It is not a
 * boundary against a deliberately hostile one, which keeps passwordless sudo
 * inside the container and can replace `/usr/bin/timeout` or the sweep's
 * tools before a later turn. The binaries are named by absolute path so that
 * at least a non-sudo process cannot shadow them through PATH. Neither
 * mechanism ever runs with more privilege than the agent already has (the
 * sweep is not a root or privileged exec), so a replaced binary gains the
 * agent nothing.
 *
 * The agent images ship GNU coreutils (Ubuntu and Debian bases), whose
 * `timeout` supports `--kill-after`; the sweep uses only POSIX `tr`/`grep`.
 *
 * Nothing here is interpolated into a shell string: the wrapper is argv, the
 * sweep script is a constant, and the marker reaches it as `$1`.
 */

import { randomUUID } from 'node:crypto';
import * as logger from '../logger.js';
import type { ContainerRuntime, DockerExecResult } from './types.js';
import { EXEC_TIMED_OUT_EXIT_CODE } from './types.js';

/**
 * coreutils `timeout`, by absolute path: the agent images put user-writable
 * tool directories ahead of `/usr/bin` on PATH, so a bare `timeout` could be
 * shadowed by the agent without even using sudo.
 */
export const TIMEOUT_BINARY = '/usr/bin/timeout';

/** Grace between coreutils `timeout`'s SIGTERM and its SIGKILL. */
export const TURN_TIMEOUT_KILL_AFTER_SECONDS = 10;

/**
 * Extra host-side slack on top of the in-container deadline and the kill
 * grace, so the in-container wrapper normally wins the race and the host
 * deadline fires only when the exec is genuinely wedged.
 */
export const TURN_TIMEOUT_HOST_SLACK_MS = 15_000;

/**
 * Largest delay Node timers accept. `execFile` arms its `timeout` with
 * `setTimeout`, which fires after 1 ms (with a TimeoutOverflowWarning) for
 * any larger value, so a very long configured limit must not overflow into
 * an immediate kill.
 */
export const MAX_HOST_TIMEOUT_MS = 2_147_483_647;

/**
 * Tolerance when matching a wrapper exit code to the deadline. The host
 * measures from before the exec client starts, so its elapsed time is
 * normally longer than the wrapper's; the tolerance only absorbs clock skew
 * between the host and an Apple `container` VM.
 */
export const TURN_TIMEOUT_CLOCK_TOLERANCE_MS = 1_000;

/** Environment variable marking every process of one turn. */
export const TURN_MARKER_ENV = 'IRONCURTAIN_TURN_ID';

/** Host-side deadline for the best-effort sweep itself. */
export const TURN_KILL_SWEEP_TIMEOUT_MS = 20_000;

/** coreutils `timeout` exit when the command was killed by `--kill-after`'s SIGKILL. */
const TIMEOUT_KILLED_EXIT_CODE = 137;

const TURN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Upper bound on sweep passes. A pass expands `/proc/[0-9]*` once, so a
 * surviving process that forks while the pass runs (a detached watcher or a
 * retry loop) leaves children the pass never sees; the next pass catches
 * them because their parent is already dead. The bound keeps an unkillable
 * (uninterruptible) process from looping the sweep forever.
 */
export const TURN_KILL_SWEEP_MAX_PASSES = 5;

/**
 * Constant sweep script; prints how many kills it made. `$1` is the exact
 * `NAME=value` marker. Each `/proc/<pid>/environ` is split into one variable
 * per line and `grep -x -F` matches a whole line literally, so a process
 * whose environment merely contains the id as a substring is never touched.
 * (A value with an embedded newline could forge a line; only a same-UID agent
 * process can set such a value, and the sweep may kill those anyway.) Passes
 * repeat until one finds no marked process, at most
 * {@link TURN_KILL_SWEEP_MAX_PASSES} times. A killed process is a zombie with
 * an empty `environ` until it is reaped (the container init reaps orphans),
 * so it never matches a later pass. Only POSIX `sh`/`tr`/`grep` features are
 * used. The sweep's own shell, `tr` and `grep` do not carry the marker (it is
 * applied to the turn's exec environment, not to the sweep's), so the script
 * cannot kill itself.
 */
export const TURN_KILL_SWEEP_SCRIPT =
  'PATH=/usr/bin:/bin; export PATH; total=0; pass=0; ' +
  `while [ "$pass" -lt ${TURN_KILL_SWEEP_MAX_PASSES} ]; do pass=$((pass + 1)); n=0; ` +
  'for p in /proc/[0-9]*; do ' +
  'if tr "\\000" "\\n" 2>/dev/null < "$p/environ" | grep -qxF -- "$1" && kill -KILL "${p#/proc/}" 2>/dev/null; ' +
  'then n=$((n + 1)); fi; done; ' +
  'total=$((total + n)); if [ "$n" -eq 0 ]; then break; fi; done; echo "$total"';

export interface BoundedTurn {
  /** The command to exec: wrapped in `timeout` when a limit applies, otherwise the original. */
  readonly command: readonly string[];
  /** Host-side backstop deadline in ms; 0 when no limit applies. */
  readonly hostTimeoutMs: number;
  /** The configured per-turn limit (`resourceBudget.maxSessionSeconds`), or null when disabled. */
  readonly maxSeconds: number | null;
  /** Exec environment carrying the turn marker; empty when no limit applies. */
  readonly environment: Readonly<Record<string, string>>;
  /** Exact `NAME=value` marker the sweep matches against `/proc/<pid>/environ`. */
  readonly marker: string;
}

/**
 * Wraps an agent turn command with the in-container deadline and derives the
 * matching host backstop. `maxSeconds` must be a finite positive number or
 * null (disabled); `turnId` must be a UUID minted by the host.
 */
export function buildBoundedTurn(command: readonly string[], turnId: string, maxSeconds: number | null): BoundedTurn {
  if (!TURN_ID_PATTERN.test(turnId)) {
    throw new Error('turn id must be a host-minted UUID');
  }
  const marker = `${TURN_MARKER_ENV}=${turnId}`;
  if (maxSeconds === null) {
    return { command, hostTimeoutMs: 0, maxSeconds: null, environment: {}, marker };
  }
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    throw new Error(`per-turn wall-clock limit must be a positive number of seconds, got ${String(maxSeconds)}`);
  }
  const hostTimeoutMs =
    Math.ceil(maxSeconds * 1000) + TURN_TIMEOUT_KILL_AFTER_SECONDS * 1000 + TURN_TIMEOUT_HOST_SLACK_MS;
  return {
    command: [TIMEOUT_BINARY, `--kill-after=${TURN_TIMEOUT_KILL_AFTER_SECONDS}`, String(maxSeconds), ...command],
    hostTimeoutMs: Math.min(hostTimeoutMs, MAX_HOST_TIMEOUT_MS),
    maxSeconds,
    environment: { [TURN_MARKER_ENV]: turnId },
    marker,
  };
}

/**
 * Whether an exec result means the turn ran past its wall-clock limit.
 *
 *   - `timedOut` set by the runtime manager: the host backstop fired.
 *   - exit 124 at or after the deadline: coreutils `timeout` ended the
 *     command with SIGTERM.
 *   - exit 137 at or after the deadline: the `--kill-after` SIGKILL ended it.
 *
 * Before the deadline both codes belong to the agent itself (124 is whatever
 * the command exited with; 137 is an ordinary kill, for example by the OOM
 * killer) and are left to the adapter's normal exit handling.
 */
export function turnTimedOut(result: DockerExecResult, bounded: BoundedTurn, elapsedMs: number): boolean {
  if (result.timedOut === true) return true;
  if (bounded.maxSeconds === null) return false;
  if (result.exitCode !== EXEC_TIMED_OUT_EXIT_CODE && result.exitCode !== TIMEOUT_KILLED_EXIT_CODE) return false;
  return elapsedMs + TURN_TIMEOUT_CLOCK_TOLERANCE_MS >= bounded.maxSeconds * 1000;
}

/** argv for the in-container sweep; the marker travels as `$1`, never inside the script. */
export function buildTurnKillCommand(marker: string): readonly string[] {
  return ['/bin/sh', '-c', TURN_KILL_SWEEP_SCRIPT, 'ironcurtain-turn-kill', marker];
}

/**
 * Best-effort sweep of a timed-out turn's surviving processes. Runs as the
 * default agent exec user (see module doc). Never throws: the turn is already
 * being reported as exhausted, and container teardown is the final bound.
 */
export async function killTimedOutTurn(
  docker: Pick<ContainerRuntime, 'exec'>,
  containerId: string,
  bounded: BoundedTurn,
): Promise<void> {
  await killTurnProcesses(docker, containerId, bounded, 'timed-out');
}

/**
 * Best-effort sweep of every process carrying a turn's marker, for any host
 * decision to stop the turn (`reason` labels the log line: `timed-out`,
 * `budget-stopped` when the bundle's budget gate refused a request, or
 * `stopped` when a workflow stopped a deterministic command). The marker must
 * be in the turn's exec environment: `bounded.environment` carries it
 * whenever a time limit applies, and a caller that may stop an unlimited turn
 * adds it itself. `execUser` must be the user the turn was exec'd as (see the
 * module doc: only the same UID can read and signal its processes); undefined
 * is the runtime's default exec user, the one agent turns run as. Never
 * throws.
 */
export async function killTurnProcesses(
  docker: Pick<ContainerRuntime, 'exec'>,
  containerId: string,
  bounded: BoundedTurn,
  reason: string,
  execUser?: string | null,
): Promise<void> {
  try {
    const command = buildTurnKillCommand(bounded.marker);
    const result =
      execUser === undefined
        ? await docker.exec(containerId, command, TURN_KILL_SWEEP_TIMEOUT_MS)
        : await docker.exec(containerId, command, TURN_KILL_SWEEP_TIMEOUT_MS, execUser);
    if (result.timedOut === true || result.exitCode !== 0) {
      logger.warn(
        `[turn-timeout] sweep of ${reason} turn ${bounded.marker} exited ${result.exitCode}` +
          `${result.timedOut === true ? ' (timed out)' : ''}: ${result.stderr.trim().slice(0, 200)}`,
      );
      return;
    }
    // The count comes from binaries inside the agent's container; log it only
    // when it looks like one.
    const killed = result.stdout.trim();
    logger.info(
      `[turn-timeout] sweep of ${reason} turn ${bounded.marker} killed ` +
        `${/^\d{1,6}$/u.test(killed) ? killed : 'an unreported number of'} surviving process(es)`,
    );
  } catch (err: unknown) {
    logger.warn(
      `[turn-timeout] sweep of ${reason} turn ${bounded.marker} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Upper bound on the sweeps one stop of a {@link runBoundedContainerCommand}
 * command makes, the first included.
 */
export const STOP_SWEEP_MAX_ATTEMPTS = 5;

/**
 * How long a stop waits after a sweep for the stopped command's exec to end
 * before it sweeps again.
 */
export const STOP_SWEEP_RETRY_MS = 1_000;

/** How a {@link runBoundedContainerCommand} command ended. */
export type BoundedCommandEnding =
  /** It exited on its own, with any exit code. */
  | 'exited'
  /** It ran past its wall-clock limit; its surviving processes were swept. */
  | 'timed-out'
  /** The caller's signal aborted while it ran; its processes were swept. */
  | 'stopped';

export interface BoundedCommandOptions {
  /** In-container wall-clock limit in seconds: finite and positive. */
  readonly maxSeconds: number;
  /** User the command (and its sweep) runs as; undefined is the runtime's default exec user. */
  readonly execUser?: string | null;
  /** Working directory inside the container. */
  readonly workdir?: string;
  /**
   * Stop request. Aborting it while the command runs sweeps the command's
   * processes at once, which ends the exec. It must not be aborted already.
   */
  readonly signal?: AbortSignal;
}

export interface BoundedCommandOutcome {
  readonly ending: BoundedCommandEnding;
  /** The exec's result: after a timeout or a stop, what the command printed before it was ended. */
  readonly result: DockerExecResult;
  /** Host-measured duration of the exec in ms. */
  readonly elapsedMs: number;
}

/**
 * Runs one command that is not an agent turn (a command of a workflow's
 * `container: true` deterministic state) under the same bound as a turn:
 * coreutils `timeout` with `maxSeconds` and `--kill-after`, a fresh marker in
 * the exec environment, and the longer host deadline only as a backstop
 * ({@link buildBoundedTurn}). After a timeout ({@link turnTimedOut}) the
 * command's surviving processes are swept by the marker before this returns,
 * so a hung test runner and its children do not go on running in a shared
 * container once the caller has moved on. An abort of `signal` while the
 * command runs (a stopping workflow, a drained fan-out lane) sweeps them at
 * once rather than at the deadline.
 *
 * The sweep runs as `execUser`, the command's own user. A stop can land
 * between the exec request and the start of the command's process, when a
 * sweep finds nothing to kill yet; so while the exec is still running
 * {@link STOP_SWEEP_RETRY_MS} after a stop's sweep, the stop sweeps again, at
 * most {@link STOP_SWEEP_MAX_ATTEMPTS} times in all. The in-container
 * deadline still bounds a command that no sweep reached.
 *
 * Rejects only when `signal` is already aborted (nothing is started) or the
 * exec itself rejects (the runtime CLI could not run).
 */
export async function runBoundedContainerCommand(
  docker: Pick<ContainerRuntime, 'exec'>,
  containerId: string,
  command: readonly string[],
  options: BoundedCommandOptions,
): Promise<BoundedCommandOutcome> {
  const { signal, execUser } = options;
  signal?.throwIfAborted();
  const bounded = buildBoundedTurn(command, randomUUID(), options.maxSeconds);
  let markExecEnded: () => void = () => {};
  const execEnded = new Promise<void>((resolve) => {
    markExecEnded = resolve;
  });
  let stopSweep: Promise<void> | undefined;
  const onAbort = (): void => {
    stopSweep ??= sweepStoppedCommand(docker, containerId, bounded, execUser, execEnded);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  // Monotonic, like the exec deadline (exec-deadline.ts): a wall-clock step
  // must not turn a deadline hit into an ordinary exit 124, or back.
  const startedAt = performance.now();
  let result: DockerExecResult;
  try {
    result = await docker.exec(
      containerId,
      bounded.command,
      bounded.hostTimeoutMs,
      execUser,
      options.workdir,
      bounded.environment,
    );
  } finally {
    markExecEnded();
    signal?.removeEventListener('abort', onAbort);
  }
  const elapsedMs = performance.now() - startedAt;
  if (stopSweep !== undefined) {
    await stopSweep;
    return { ending: 'stopped', result, elapsedMs };
  }
  if (turnTimedOut(result, bounded, elapsedMs)) {
    await killTurnProcesses(docker, containerId, bounded, 'timed-out', execUser);
    return { ending: 'timed-out', result, elapsedMs };
  }
  return { ending: 'exited', result, elapsedMs };
}

/**
 * The sweeps of one stop: one at once, then another each time the command's
 * exec is still running {@link STOP_SWEEP_RETRY_MS} after the last, up to
 * {@link STOP_SWEEP_MAX_ATTEMPTS}. A sweep that ran before the command's
 * process existed found nothing; the next one reaches it. Never rejects.
 */
async function sweepStoppedCommand(
  docker: Pick<ContainerRuntime, 'exec'>,
  containerId: string,
  bounded: BoundedTurn,
  execUser: string | null | undefined,
  execEnded: Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    await killTurnProcesses(docker, containerId, bounded, 'stopped', execUser);
    if (attempt >= STOP_SWEEP_MAX_ATTEMPTS) return;
    if (await settlesWithin(execEnded, STOP_SWEEP_RETRY_MS)) return;
  }
}

/** True once `promise` settles within `ms`, false when `ms` passes first. */
function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
