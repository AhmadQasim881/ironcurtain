/**
 * Helpers for exercising container-turn process handling without Docker.
 *
 * `localDockerExec` is an `ExecFileFn` for `createDockerManager()` that runs
 * what `docker exec [--user u] [--workdir d] [--env K]... <id> cmd...` would
 * run inside the container directly on this host, through the real
 * `defaultExecFile`. The manager's argument construction, environment
 * passing and deadline classification all stay real; only the container
 * boundary is removed. Use it only with commands that are safe to run on the
 * host (the tests run `sleep`, `sh` and the turn-kill sweep).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { defaultExecFile, type ExecFileFn } from '../../src/docker/docker-manager.js';
import { TIMEOUT_BINARY } from '../../src/docker/turn-timeout.js';

/** Linux host with the binaries the real turn wrapper and sweep need. */
export const LOCAL_TURN_PROCESS_TESTS_SUPPORTED =
  process.platform === 'linux' &&
  existsSync('/proc/self/environ') &&
  existsSync(TIMEOUT_BINARY) &&
  existsSync('/usr/bin/setsid') &&
  existsSync('/bin/sh');

export const localDockerExec: ExecFileFn = (cmd, args, opts) => {
  if (cmd !== 'docker' || args[0] !== 'exec') throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  let index = 1;
  while (args[index] === '--user' || args[index] === '--workdir' || args[index] === '--env') index += 2;
  const command = args.slice(index + 1);
  return defaultExecFile(command[0], command.slice(1), opts);
};

/** True while `pid` exists and is not a zombie awaiting its reaper. */
export function isProcessAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.lastIndexOf(')');
    return stat.slice(afterComm + 2, afterComm + 3) !== 'Z';
  } catch {
    return false;
  }
}

/**
 * Live processes whose environment holds exactly the `NAME=value` marker (the
 * same match the turn-kill sweep makes). Unreadable entries are skipped.
 */
export function markedProcessIds(marker: string): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    try {
      const variables = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0');
      if (variables.includes(marker) && isProcessAlive(pid)) pids.push(pid);
    } catch {
      // Exited, or another user's process.
    }
  }
  return pids;
}

/** Polls until `pid` is gone; resolves false if it is still alive after `timeoutMs`. */
export async function waitUntilProcessGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessAlive(pid);
}
