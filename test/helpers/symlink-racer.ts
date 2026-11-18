/**
 * A symlink racer for "check a path, then use it" regression tests.
 *
 * {@link startSymlinkRacer} starts a helper process that retargets one symlink
 * as fast as it can, alternating between two targets. Each swap creates a
 * fresh symlink and renames it over the link, so the link always exists and
 * always points at one target or the other: what an agent running a
 * background loop in its container can do to a workspace entry. Code that
 * validates the path and then opens it again is redirected a few percent of
 * the time; code that checks what it actually opened never is.
 *
 * The helper exits on its own after `maxSeconds`, so an orphan (a test run
 * killed before `stop()`) does not spin forever.
 */

import { readlinkSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';

const RACER_SCRIPT = `
const { renameSync, symlinkSync, unlinkSync } = require('node:fs');
const [link, first, second, maxSeconds] = process.argv.slice(1);
const end = Date.now() + Number(maxSeconds) * 1000;
for (let i = 0; Date.now() < end; i++) {
  const temporary = link + '.racer-' + (i % 2);
  try {
    try { unlinkSync(temporary); } catch {}
    symlinkSync(i % 2 === 0 ? second : first, temporary);
    renameSync(temporary, link);
  } catch {}
}
`;

export interface SymlinkRacer {
  /** Kill the helper (idempotent). */
  stop(): void;
}

/**
 * Starts retargeting the existing symlink `link` between `first` and `second`
 * and resolves once the helper has demonstrably swapped it at least once.
 */
export async function startSymlinkRacer(
  link: string,
  first: string,
  second: string,
  maxSeconds = 60,
): Promise<SymlinkRacer> {
  const child: ChildProcess = spawn(process.execPath, ['-e', RACER_SCRIPT, link, first, second, String(maxSeconds)], {
    stdio: 'ignore',
  });
  child.on('error', () => {});
  const racer: SymlinkRacer = {
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
  // Wait (bounded) until both targets have been observed, so the caller's
  // loop really runs against a moving link.
  const seen = new Set<string>();
  const deadline = Date.now() + 10_000;
  while (seen.size < 2 && Date.now() < deadline) {
    try {
      seen.add(readlinkSync(link));
    } catch {
      // Between unlink and rename of a temporary: the link itself never vanishes.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
  if (seen.size < 2) {
    racer.stop();
    throw new Error(`symlink racer never retargeted ${link}`);
  }
  return racer;
}
