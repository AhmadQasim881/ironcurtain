/**
 * The session's own writes of user-context.json, the file the coordinator's
 * auto-approver matches an escalation against (`readUserContext` and
 * `isUserContextTrusted` in trusted-process). The trusted host front-ends of
 * PTY sessions write theirs through trusted-input.ts instead.
 *
 * A session records each human turn with its source and the time it was
 * sent, and clears the file for a turn IronCurtain generated itself (the
 * memory auto-save prompt, workflow state prompts), so text an agent wrote
 * can never pass for the human's authorization.
 */

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteJsonSync } from './escalation-watcher.js';

const USER_CONTEXT_FILE = 'user-context.json';

/**
 * Records the human's message for the auto-approver, stamped with its source
 * (`session-direct`) and the time it was sent, so the approver trusts it only
 * while it is fresh. Write failures are ignored: the escalation directory may
 * not exist yet, and a missing file reads as "no context", which sends every
 * escalation to a human.
 */
export function recordSessionUserContext(escalationDir: string, userMessage: string): void {
  try {
    atomicWriteJsonSync(resolve(escalationDir, USER_CONTEXT_FILE), {
      userMessage,
      source: 'session-direct',
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Ignore: no context means no auto-approval.
  }
}

/**
 * Clears the context for a system-generated turn. Skipping the write would
 * leave the previous human message in place to authorize whatever the
 * system prompt provokes, so the clear fails closed: the previous message is
 * removed first, and only then is the marker written (an empty message from
 * `system-generated`, which reads as "no context"). If the marker cannot be
 * written, the file is simply absent, which reads the same way.
 */
export function clearSessionUserContext(escalationDir: string): void {
  const contextPath = resolve(escalationDir, USER_CONTEXT_FILE);
  try {
    rmSync(contextPath, { force: true });
  } catch {
    // Not a removable file (a directory, say); the reader rejects anything but a JSON message.
  }
  try {
    atomicWriteJsonSync(contextPath, {
      userMessage: '',
      source: 'system-generated',
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Ignore: the previous message is already gone.
  }
}
