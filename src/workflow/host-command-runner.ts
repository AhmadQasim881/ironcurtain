/**
 * Host execution of one deterministic workflow command (`host: true` states).
 *
 * Such a command runs as the user running IronCurtain, with that user's
 * network access and environment, outside the container and the policy
 * engine, and its working directory is the run workspace, which agents can
 * write. Toolchains (npm, pytest, make, cargo, git, ...) therefore execute
 * agent-controlled code and configuration. That is why validation demands the
 * explicit per-state `host: true` acknowledgement (see validate.ts); this
 * module only bounds the process it is asked to run:
 *
 * - argv only, never a shell (`spawn` without the `shell` option);
 * - stdin is closed, so a command that prompts reads EOF instead of hanging;
 * - the command leads its own process group (and session, so it has no
 *   controlling terminal and `/dev/tty` prompts fail). A timeout or an abort
 *   SIGKILLs the whole group, so grandchildren (npm -> sh -> node,
 *   make -> cc) cannot outlive the command; whatever the command leaves
 *   behind in its group when it exits is killed too;
 * - each output stream is captured up to a bound (its first and last
 *   {@link HOST_COMMAND_CAPTURE_BYTES} bytes), so verbose output can neither
 *   exhaust memory nor fail the command;
 * - groups still running when the IronCurtain process exits (a forced exit
 *   after a second Ctrl-C, say) are killed by a process `exit` hook.
 *
 * A process that leaves the group (`setsid`, a daemonizing double fork)
 * escapes the group kill. Containing that, and everything else such a command
 * can do as the host user, needs an OS sandbox: `container: true`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { errorMessage } from '../utils/error-message.js';

/** Bytes kept from the start, and again from the end, of each output stream. */
export const HOST_COMMAND_CAPTURE_BYTES = 1024 * 1024;

/** Largest delay `setTimeout` honours; longer ones fire after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** After the command exits, how long to wait for its pipes to close. */
const CLOSE_GRACE_MS = 1_000;
/** After a kill, how long to wait for the pipes to close before settling anyway. */
const KILL_GRACE_MS = 5_000;

export interface HostCommandOptions {
  /** Working directory of the command. */
  readonly cwd: string;
  /** Kill the command's process group after this many milliseconds. */
  readonly timeoutMs: number;
  /** Aborting kills the command's process group (or keeps it from starting). */
  readonly signal?: AbortSignal;
  /** Overrides {@link HOST_COMMAND_CAPTURE_BYTES}. */
  readonly captureBytes?: number;
}

/** Why the runner ended the command itself, or could not start it. */
export type HostCommandFailureKind = 'timeout' | 'aborted' | 'spawn';

export interface HostCommandResult {
  /** Exit code, or null when a signal ended the process or it never started. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the runner killed the command or could not start it. */
  readonly failure?: { readonly kind: HostCommandFailureKind; readonly message: string };
}

/** True when the command ran to completion and exited 0. */
export function hostCommandSucceeded(result: HostCommandResult): boolean {
  return result.failure === undefined && result.exitCode === 0;
}

/**
 * The error text for a command that did not succeed: the runner's own reason
 * (timeout, abort, spawn failure) first when there is one, then the
 * command's stderr, falling back to its stdout (a test runner that reports
 * failures only on stdout), falling back to the exit status.
 */
export function describeHostCommandFailure(argv: readonly string[], result: HostCommandResult): string {
  const output = result.stderr || result.stdout;
  if (result.failure !== undefined) {
    return output ? `${result.failure.message}\n${output}` : result.failure.message;
  }
  if (output) return output;
  const label = describeProgram(argv);
  return result.exitCode !== null
    ? `${label} exited with code ${result.exitCode}`
    : `${label} was killed by ${result.signal ?? 'a signal'}`;
}

/**
 * `command "<argv0>"`, display-safe: how failure messages name a deterministic
 * command, on the host and in the container.
 */
export function describeProgram(argv: readonly string[]): string {
  return `command "${toDisplayText(argv[0] ?? '', { maxLength: 80 })}"`;
}

/**
 * Keeps the first and the last `limit` bytes of a stream and counts what lies
 * between. The bytes are copied into one head buffer (grown geometrically up
 * to `limit`) and one `limit`-byte ring for the tail, so the capture holds at
 * most `2 * limit` bytes however finely the stream is chunked. Keeping the
 * chunks themselves would not be bounded: a command writing one byte at a
 * time is read as one tiny chunk per write, and each chunk object costs
 * hundreds of bytes.
 *
 * Exported for testing.
 */
export class BoundedCapture {
  private head = Buffer.alloc(0);
  private headBytes = 0;
  /** The latest `limit` bytes past the head; allocated once output outgrows the head. */
  private ring: Buffer | undefined;
  /** Bytes ever written past the head; byte `i` of them lives at `ring[i % limit]`. */
  private tailWritten = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.headBytes < this.limit) {
      const take = Math.min(this.limit - this.headBytes, rest.length);
      this.appendHead(rest.subarray(0, take));
      rest = rest.subarray(take);
    }
    if (rest.length > 0) this.appendTail(rest);
  }

  text(): string {
    const head = this.head.subarray(0, this.headBytes);
    const kept = Math.min(this.tailWritten, this.limit);
    const omitted = this.tailWritten - kept;
    let tail: Buffer = Buffer.alloc(0);
    if (this.ring !== undefined && kept > 0) {
      // Oldest kept byte first. Until the ring wraps it is at position 0;
      // once it has wrapped the ring is full and the oldest byte sits where
      // the next write would go.
      const start = omitted > 0 ? this.tailWritten % this.limit : 0;
      tail =
        start === 0
          ? this.ring.subarray(0, kept)
          : Buffer.concat([this.ring.subarray(start), this.ring.subarray(0, start)]);
    }
    if (omitted === 0) return Buffer.concat([head, tail]).toString('utf8');
    return `${head.toString('utf8')}\n[... ${omitted} bytes of output omitted ...]\n${tail.toString('utf8')}`;
  }

  private appendHead(data: Buffer): void {
    const needed = this.headBytes + data.length;
    if (needed > this.head.length) {
      const grown = Buffer.alloc(Math.min(this.limit, Math.max(needed, 2 * this.head.length, 4096)));
      this.head.copy(grown, 0, 0, this.headBytes);
      this.head = grown;
    }
    data.copy(this.head, this.headBytes);
    this.headBytes = needed;
  }

  private appendTail(data: Buffer): void {
    if (this.limit > 0) {
      this.ring ??= Buffer.alloc(this.limit);
      // Only the last `limit` bytes of `data` can survive in the ring.
      const skipped = Math.max(0, data.length - this.limit);
      let position = (this.tailWritten + skipped) % this.limit;
      for (let offset = skipped; offset < data.length;) {
        const count = Math.min(this.limit - position, data.length - offset);
        data.copy(this.ring, position, offset, offset + count);
        offset += count;
        position = (position + count) % this.limit;
      }
    }
    this.tailWritten += data.length;
  }
}

// ---------------------------------------------------------------------------
// Process groups still running when this process exits
// ---------------------------------------------------------------------------

const liveGroups = new Set<number>();
let exitHookInstalled = false;

/**
 * SIGKILLs a process group. Refuses ids that are not a real group leader's pid:
 * `kill(-1)` would signal every process this user (or root) may signal, and
 * `kill(-0)` the caller's own group.
 */
function killProcessGroup(groupId: number): void {
  if (!Number.isSafeInteger(groupId) || groupId <= 1) return;
  try {
    process.kill(-groupId, 'SIGKILL');
  } catch {
    // ESRCH: the group is already empty.
  }
}

function trackGroup(groupId: number): void {
  liveGroups.add(groupId);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const id of liveGroups) killProcessGroup(id);
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Runs `argv` on the host under the bounds described in the module comment.
 * Never rejects for anything the command does: a non-zero exit, a timeout,
 * an abort and a spawn failure are all reported in the result. Throws
 * `RangeError` only for invalid options or an empty argv.
 */
export function runHostCommand(argv: readonly string[], options: HostCommandOptions): Promise<HostCommandResult> {
  if (argv.length === 0 || argv[0].length === 0) {
    throw new RangeError('runHostCommand needs a non-empty argv');
  }
  const [binary, ...args] = argv;
  const { timeoutMs } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MS) {
    throw new RangeError(`timeoutMs must be an integer within 1-${MAX_TIMER_MS}`);
  }
  const captureBytes = options.captureBytes ?? HOST_COMMAND_CAPTURE_BYTES;
  if (!Number.isSafeInteger(captureBytes) || captureBytes < 0) {
    throw new RangeError('captureBytes must be a non-negative safe integer');
  }

  const label = describeProgram(argv);
  if (options.signal?.aborted === true) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      failure: { kind: 'aborted', message: `${label} was not started: the workflow is stopping` },
    });
  }

  const useProcessGroup = process.platform !== 'win32';

  return new Promise<HostCommandResult>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        cwd: options.cwd,
        detached: useProcessGroup,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      // Synchronous spawn failures: invalid arguments such as a NUL byte.
      resolvePromise({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        failure: { kind: 'spawn', message: `cannot start ${label}: ${errorMessage(error)}` },
      });
      return;
    }

    const stdout = new BoundedCapture(captureBytes);
    const stderr = new BoundedCapture(captureBytes);
    const pid = child.pid;
    const groupId = useProcessGroup && pid !== undefined && pid > 1 ? pid : undefined;
    if (groupId !== undefined) trackGroup(groupId);

    let settled = false;
    let exited = false;
    let failure: { kind: HostCommandFailureKind; message: string } | undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let closeTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const killTree = (): void => {
      if (groupId !== undefined) {
        killProcessGroup(groupId);
      } else if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    };

    const stop = (kind: HostCommandFailureKind, message: string): void => {
      // Once the command has exited its result stands: a timeout or an abort
      // landing while its pipes drain changes nothing.
      if (settled || exited || failure !== undefined) return;
      failure = { kind, message };
      killTree();
      killTimer = setTimeout(settle, KILL_GRACE_MS);
    };

    const onAbort = (): void => stop('aborted', `${label} was killed: the workflow is stopping`);
    const timeoutTimer = setTimeout(
      () => stop('timeout', `${label} timed out after ${timeoutMs} ms; its process group was killed`),
      timeoutMs,
    );

    function settle(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(closeTimer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (groupId !== undefined) liveGroups.delete(groupId);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise({
        exitCode,
        signal: exitSignal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        ...(failure !== undefined ? { failure } : {}),
      });
    }

    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      // Only a process that never started settles here; a running one is
      // settled by its exit/close (or the kill backstop). `on`, not `once`:
      // a later error (a failed kill) must not go unhandled.
      if (child.pid !== undefined) return;
      failure ??= { kind: 'spawn', message: `cannot start ${label}: ${errorMessage(error)}` };
      settle();
    });
    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      clearTimeout(timeoutTimer);
      // The leader has just been reaped. Its pid still names the group while
      // anything is left in it, so kill that now: a background grandchild
      // would otherwise keep running and, holding the pipes open, keep
      // 'close' from firing. Nothing of the command survives this kill, so
      // the group needs no killing later (when its id could be reused).
      killTree();
      if (groupId !== undefined) liveGroups.delete(groupId);
      closeTimer = setTimeout(settle, CLOSE_GRACE_MS);
    });
    child.once('close', settle);
  });
}
