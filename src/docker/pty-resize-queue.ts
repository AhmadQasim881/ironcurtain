/**
 * Serialized container PTY resizing for the socat PTY transport.
 *
 * The host terminal size reaches the container PTY through
 * `resize-pty.sh <cols> <rows>` run with `exec` (an `stty` on the agent's
 * PTY plus SIGWINCH). Every host resize event used to start its own exec, so a
 * window drag (or a web UI fit loop) launched dozens of concurrent execs that
 * could finish in any order and leave the PTY at an intermediate size; the
 * initial-size verification ran its own uncancellable resize that could land
 * after a user resize and put the old size back.
 *
 * This queue keeps at most one resize exec in flight and always applies the
 * latest requested size: requests that arrive while an exec runs only update
 * the target, and one more exec runs if the target changed. A short trailing
 * debounce coalesces bursts. After a size settles it is verified with
 * `check-pty-size.sh` and re-applied a bounded number of times (the agent may
 * not be running yet right after attach), but only while it is still the
 * latest request, so a stale size is never re-applied.
 */

import type { ContainerRuntime } from './types.js';
import * as logger from '../logger.js';

export interface PtySize {
  readonly cols: number;
  readonly rows: number;
}

export interface PtyResizeQueueOptions {
  readonly runtime: Pick<ContainerRuntime, 'exec'>;
  readonly containerId: string;
  /** Trailing debounce for bursts of requests (ms). Default 50. */
  readonly debounceMs?: number;
  /** Delay before the first size check after a resize (ms). Default 500. */
  readonly verifyDelayMs?: number;
  /** Delay between verification retries (ms). Default 1000. */
  readonly verifyIntervalMs?: number;
  /** Re-apply attempts when the checked size does not match. Default 5. */
  readonly verifyAttempts?: number;
  /** Timeout for each resize/check exec (ms). Default 5000. */
  readonly execTimeoutMs?: number;
}

export interface PtyResizeQueue {
  /** Request a container PTY size. The latest request always wins. */
  request(cols: number, rows: number): void;
  /** Stop issuing execs. An exec already in flight is left to finish. */
  close(): void;
  /** Resolves once no exec is running and no request is pending. */
  whenIdle(): Promise<void>;
}

const RESIZE_SCRIPT = '/etc/ironcurtain/resize-pty.sh';
const CHECK_SCRIPT = '/etc/ironcurtain/check-pty-size.sh';

function sameSize(left: PtySize | undefined, right: PtySize | undefined): boolean {
  return left !== undefined && right !== undefined && left.cols === right.cols && left.rows === right.rows;
}

function validSize(cols: number, rows: number): boolean {
  return Number.isSafeInteger(cols) && Number.isSafeInteger(rows) && cols > 0 && rows > 0;
}

export function createPtyResizeQueue(options: PtyResizeQueueOptions): PtyResizeQueue {
  const debounceMs = options.debounceMs ?? 50;
  const verifyDelayMs = options.verifyDelayMs ?? 500;
  const verifyIntervalMs = options.verifyIntervalMs ?? 1_000;
  const verifyAttempts = options.verifyAttempts ?? 5;
  const execTimeoutMs = options.execTimeoutMs ?? 5_000;
  const { runtime, containerId } = options;

  let desired: PtySize | undefined;
  /** Size the resize script last ran with. */
  let applied: PtySize | undefined;
  /** Size last confirmed (or given up on) by verification. */
  let verified: PtySize | undefined;
  let closed = false;
  let running = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ends a verification sleep early when a newer size arrives or the queue closes. */
  let wake: (() => void) | undefined;
  const idleWaiters: (() => void)[] = [];

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });

  const isIdle = (): boolean => !running && debounceTimer === undefined;
  const notifyIdle = (): void => {
    if (!isIdle()) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };

  const runResize = async (size: PtySize): Promise<void> => {
    try {
      // `exec` defaults `--user` to codespace, which is correct whether the
      // container runs as root (Linux UID-remap path, issue #232) or as
      // codespace (macOS); re-asserting codespace there is a no-op.
      const result = await runtime.exec(
        containerId,
        [RESIZE_SCRIPT, String(size.cols), String(size.rows)],
        execTimeoutMs,
      );
      if (result.exitCode !== 0) {
        logger.warn(`resize-pty.sh failed (exit ${result.exitCode})`);
        if (result.stderr) logger.warn(`resize-pty.sh stderr: ${result.stderr.trim()}`);
      }
    } catch (error) {
      logger.warn(`resize-pty.sh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const checkSize = async (): Promise<PtySize | undefined> => {
    try {
      const result = await runtime.exec(containerId, [CHECK_SCRIPT], execTimeoutMs);
      if (result.exitCode !== 0) return undefined;
      const [rows, cols] = result.stdout
        .trim()
        .split(/\s+/u)
        .map((part) => Number.parseInt(part, 10));
      return validSize(cols, rows) ? { cols, rows } : undefined;
    } catch {
      return undefined;
    }
  };

  const superseded = (target: PtySize): boolean => closed || !sameSize(desired, target);

  /** Returns true when verification ended because a newer size (or close) superseded it. */
  const verify = async (target: PtySize): Promise<boolean> => {
    await sleep(verifyDelayMs);
    for (let attempt = 0; attempt < verifyAttempts; attempt += 1) {
      if (superseded(target)) return true;
      const size = await checkSize();
      if (superseded(target)) return true;
      if (sameSize(size, target)) {
        verified = target;
        return false;
      }
      // The agent may not have started yet; apply the (still latest) size again.
      await runResize(target);
      applied = target;
      await sleep(verifyIntervalMs);
    }
    if (superseded(target)) return true;
    const size = await checkSize();
    if (superseded(target)) return true;
    if (!sameSize(size, target)) {
      logger.warn(
        `PTY size verification failed after ${verifyAttempts} retries ` +
          `(expected ${target.cols}x${target.rows}, got ${size ? `${size.cols}x${size.rows}` : 'unknown'})`,
      );
    }
    // Settled either way; a later request verifies again.
    verified = target;
    return false;
  };

  const drain = async (): Promise<void> => {
    while (!closed && desired !== undefined) {
      const target = desired;
      if (!sameSize(target, applied)) {
        await runResize(target);
        applied = target;
        // A resize can move the PTY away from an earlier verified size.
        verified = undefined;
        continue;
      }
      if (sameSize(target, verified)) return;
      if (!(await verify(target))) return;
    }
  };

  const pending = (): boolean =>
    !closed && desired !== undefined && (!sameSize(desired, applied) || !sameSize(desired, verified));

  const schedule = (): void => {
    if (closed) return;
    if (running) {
      wake?.();
      return;
    }
    running = true;
    void drain()
      .catch((error: unknown) => {
        logger.warn(`PTY resize failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = false;
        // A request that arrived during the last await is picked up here.
        if (pending()) schedule();
        else notifyIdle();
      });
  };

  return {
    request(cols: number, rows: number): void {
      if (closed || !validSize(cols, rows)) return;
      desired = { cols, rows };
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        schedule();
      }, debounceMs);
    },
    close(): void {
      closed = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      wake?.();
      notifyIdle();
    },
    whenIdle(): Promise<void> {
      if (isIdle()) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
