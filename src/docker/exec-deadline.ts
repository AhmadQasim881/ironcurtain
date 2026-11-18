/**
 * Host-side exec deadline classification shared by the Docker and Apple
 * `container` runtime managers.
 *
 * Node's `execFile({ timeout })` only signals the host CLI client. The Docker
 * CLI exits 0 when it receives SIGTERM, so a promisified `execFile` RESOLVES
 * after a timeout with `exitCode 0` and partial output, and the process inside
 * the container keeps running (audit finding DINF-8). Other clients may exit
 * non-zero instead, which Node reports with `killed: true` but no signal.
 * Both managers therefore classify every exec through this module, from the
 * killed child and never from the client's exit code:
 *
 *   - `killed: true` on the resolved value (our own `defaultExecFile` exposes
 *     the child's `killed` flag) or on the rejection                -> timed out
 *   - `killed: false`: Node's deadline timer never signalled the client, so
 *     the exec finished on its own, however long it took by the wall clock
 *                                                                   -> ordinary
 *   - `killed` not reported (exec implementations that cannot observe it,
 *     and rejections Node raises without the flag, such as a spawn failure
 *     or a `maxBuffer` overflow) and at least `timeoutMs` of MONOTONIC time
 *     elapsed                                                       -> timed out
 *   - anything else                                                -> ordinary
 *
 * Elapsed time is only a fallback, and it must come from a monotonic clock
 * (`performance.now()`, the clock Node's own `timeout` timer runs on). A
 * wall-clock measurement counts a host suspend (a laptop lid closed during a
 * long agent turn) or an NTP step as exec time, which would turn an exec that
 * completed normally into a "timeout": its output discarded, and for an agent
 * turn the conversation abandoned and the session reported as exhausted.
 *
 * Node sets `killed` only when it signalled the child itself, which for these
 * calls means the `timeout` fired: a `maxBuffer` overflow rejects with
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and no `killed` flag.
 *
 * A timed-out result reports exit code 124 (coreutils `timeout` convention)
 * and `timedOut: true` so no caller can mistake it for success. Killing the
 * process inside the container is the caller's job (see `turn-timeout.ts`).
 */

import type { ExecError } from '../utils/exec-error.js';
import { EXEC_TIMED_OUT_EXIT_CODE, type DockerExecResult } from './types.js';

/** What an `ExecFileFn` resolves with. `killed` is set only by implementations that can observe it. */
export interface ExecFileOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly killed?: boolean;
}

/**
 * Whether the host deadline ended the exec. A reported `killed` flag is
 * authoritative; the monotonic elapsed time decides only when the exec
 * implementation could not report it.
 */
function deadlineHit(killed: boolean | undefined, timeoutMs: number, elapsedMs: number): boolean {
  if (killed !== undefined) return killed;
  return timeoutMs > 0 && elapsedMs >= timeoutMs;
}

function timedOutResult(stdout: string, stderr: string): DockerExecResult {
  return { exitCode: EXEC_TIMED_OUT_EXIT_CODE, stdout, stderr, timedOut: true };
}

/**
 * Classifies a RESOLVED exec. `elapsedMs` is monotonic time measured by the
 * caller around the await (`performance.now()`); `timeoutMs` is the host
 * deadline that was passed to the exec implementation (0 = none).
 */
export function resolvedExecResult(outcome: ExecFileOutcome, timeoutMs: number, elapsedMs: number): DockerExecResult {
  if (deadlineHit(outcome.killed, timeoutMs, elapsedMs)) {
    return timedOutResult(outcome.stdout, outcome.stderr);
  }
  return { exitCode: 0, stdout: outcome.stdout, stderr: outcome.stderr };
}

/** Classifies a REJECTED exec whose error carries stdout/stderr (see `isExecError`). */
export function rejectedExecResult(err: ExecError, timeoutMs: number, elapsedMs: number): DockerExecResult {
  if (deadlineHit(err.killed, timeoutMs, elapsedMs)) {
    return timedOutResult(err.stdout, err.stderr);
  }
  return {
    exitCode: typeof err.code === 'number' ? err.code : 1,
    stdout: err.stdout,
    stderr: err.stderr,
  };
}
