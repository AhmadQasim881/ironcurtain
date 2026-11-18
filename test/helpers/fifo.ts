/**
 * FIFO fixtures for "never block on an agent-planted FIFO" regression tests.
 *
 * Opening a FIFO without O_NONBLOCK blocks the calling thread until a peer
 * opens the other end, and a synchronous read then blocks until data or EOF.
 * In a test that freezes the whole vitest worker, so its own timeout can never
 * fire. {@link startFifoUnblocker} starts a helper process that, after a delay,
 * repeatedly opens the FIFO read-write for a second and closes it again (a
 * bounded number of times): a regressed implementation, even one that opens the
 * FIFO more than once, is released after a few seconds and fails the test's
 * elapsed-time assertion instead of hanging the run forever. A correct
 * implementation never opens the FIFO, finishes long before the helper acts,
 * and the helper is killed.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';

/** True where `mkfifo` and `sh` exist (every POSIX platform the project supports). */
export const fifoSupported = process.platform !== 'win32';

export function makeFifo(path: string): void {
  execFileSync('mkfifo', [path]);
}

export interface FifoUnblocker {
  /** Kill the helper (idempotent). Call right after the code under test returns. */
  stop(): void;
}

/**
 * Each round opens the FIFO read-write (a peer for a blocked reader or writer),
 * holds it for a second, then closes it (EOF for a blocked read). Bounded so an
 * orphaned helper exits on its own.
 */
const UNBLOCK_SCRIPT =
  'sleep "$2"; i=0; while [ "$i" -lt 30 ]; do exec 3<>"$1"; sleep 1; exec 3>&-; i=$((i + 1)); done';

/** See the module comment. `delaySeconds` should exceed the test's timing bound. */
export function startFifoUnblocker(fifoPath: string, delaySeconds = 3): FifoUnblocker {
  const child: ChildProcess = spawn('sh', ['-c', UNBLOCK_SCRIPT, 'sh', fifoPath, String(delaySeconds)], {
    stdio: 'ignore',
  });
  // The helper may fail to open a path the code under test already replaced;
  // that is expected and must not surface as an unhandled error.
  child.on('error', () => {});
  return {
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}
