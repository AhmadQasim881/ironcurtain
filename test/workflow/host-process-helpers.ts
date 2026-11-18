/**
 * Process helpers for the host deterministic-command tests: a script that
 * builds a process tree and records its pids, and a liveness check that
 * treats a not-yet-reaped zombie as dead.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Pids written by {@link writeTreeScript}'s script. */
export interface TreePids {
  readonly child: number;
  readonly grandchild: number;
}

/**
 * Writes a CommonJS script that starts a grandchild in its own process group
 * (no `detached`), writes `{ child, grandchild }` pids to the file named by
 * its first argument, and then both processes run until killed.
 */
export function writeTreeScript(dir: string): string {
  const script = join(dir, 'tree.cjs');
  writeFileSync(
    script,
    [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'writeFileSync(process.argv[2], JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
  return script;
}

/** Polls for the pid file the tree script writes. */
export async function waitForTreePids(pidFile: string, timeoutMs = 15_000): Promise<TreePids> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(pidFile)) {
      const text = readFileSync(pidFile, 'utf8');
      if (text.length > 0) return JSON.parse(text) as TreePids;
    }
    if (Date.now() > deadline) throw new Error(`pid file ${pidFile} never appeared`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** True while `pid` is a live (non-zombie) process. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  // A killed process its parent has not reaped yet is a zombie: it is dead.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.charAt(stat.lastIndexOf(')') + 2);
    return state !== 'Z' && state !== 'X';
  } catch {
    // No /proc (macOS): kill(0) succeeding is the best signal available.
    return true;
  }
}

/** Waits until none of `pids` is alive; returns those still alive at the deadline. */
export async function waitUntilDead(pids: readonly number[], timeoutMs = 5_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = pids.filter((pid) => isProcessAlive(pid));
    if (alive.length === 0 || Date.now() > deadline) return alive;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Best-effort cleanup so a failing test never leaves the tree running. */
export function killPids(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}
