/**
 * Debug-capture helpers for `ironcurtain workflow run-state`.
 *
 * Two artifacts are extracted into the run's `--output` dir so each test
 * run owns a self-contained record of what the in-container agent saw and
 * what the container reported.
 *
 * Lifecycle notes that aren't obvious from the code:
 *   - `captureContainerLogs` MUST run BEFORE `session.close()`: the
 *     container is force-removed on close, after which the runtime's
 *     `logs` reports "no such container".
 *   - `captureConversationLogs` runs AFTER `session.close()`: the
 *     bundle teardown only removes the runtime sockets dir, not the
 *     bind-mounted `claude-state/` tree under the session dir.
 *
 * Both are best-effort: missing/empty inputs and runtime-side failures are
 * logged to stderr but never propagated. The agent run's success/failure
 * is reported through the existing `agent-output.md` + verdict path.
 *
 * This module is run-state-only by design. Production workflow runs go
 * through the orchestrator, which has its own diagnostics; bind-mounting
 * agent state into long-lived workflow runs would cross privacy/state
 * boundaries.
 */

import { createWriteStream, existsSync, readdirSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSessionDir } from '../config/paths.js';
import type { BundleId, Session } from '../session/types.js';
import { toDisplayText } from '../terminal/display-sanitize.js';

export interface RunStateCapturePaths {
  readonly containerLogsPath: string;
  readonly claudeLogsDir: string;
  readonly claudeProjectsSrc: string;
}

export function resolveCapturePaths(bundleId: BundleId, outputDir: string): RunStateCapturePaths {
  return {
    containerLogsPath: resolve(outputDir, 'container-logs.txt'),
    claudeLogsDir: resolve(outputDir, 'claude-session-logs'),
    claudeProjectsSrc: resolve(getSessionDir(bundleId), 'claude-state', 'projects'),
  };
}

/**
 * Writes the agent container's complete log (combined stdout/stderr) to the
 * capture path. The session streams it through the runtime its
 * infrastructure was built with and the container's real id
 * (`Session.streamContainerLogs`), so the Apple `container` runtime and a
 * captured Docker endpoint work like plain Docker. Streaming avoids the
 * 10 MB `maxBuffer` data-loss failure mode of `execFile` -- crashlooping/OOM
 * containers, the very ones we want to diagnose, are exactly the ones
 * likely to overflow.
 */
export async function captureContainerLogs(
  session: Pick<Session, 'streamContainerLogs'>,
  paths: RunStateCapturePaths,
): Promise<void> {
  if (session.streamContainerLogs === undefined) {
    process.stderr.write('[run-state] this session has no container to capture logs from\n');
    return;
  }
  const out = createWriteStream(paths.containerLogsPath);
  // 'close' follows both a flushed end() and a failed open or write.
  const closed = new Promise<void>((resolveClosed) => out.once('close', resolveClosed));
  out.on('error', (err) => {
    process.stderr.write(`[run-state] container-log write failed: ${err.message}\n`);
  });
  try {
    await session.streamContainerLogs(out);
  } catch (err) {
    // The runtime's error quotes its stderr tail, which carries the
    // container's own stderr output: escape it for the terminal.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[run-state] container log capture failed: ${toDisplayText(message, { multiline: true })}\n`);
  } finally {
    out.end();
    await closed;
  }
}

export function captureConversationLogs(paths: RunStateCapturePaths): void {
  if (!existsSync(paths.claudeProjectsSrc)) return;
  try {
    // Skip empty source dir: an empty `claude-session-logs/` would
    // misleadingly suggest the agent ran silently when in reality it
    // crashed before writing the first JSONL frame.
    if (readdirSync(paths.claudeProjectsSrc).length === 0) {
      process.stderr.write(
        '[run-state] no conversation log captured (claude-state/projects empty -- agent likely crashed before first message)\n',
      );
      return;
    }
    cpSync(paths.claudeProjectsSrc, paths.claudeLogsDir, { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[run-state] conversation-log capture failed: ${message}\n`);
  }
}
