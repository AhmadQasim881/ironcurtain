/**
 * Escalation listener CLI command.
 *
 * Polls the PTY session registry directory for active sessions, watches
 * each session's escalation directory for new requests, and presents
 * a terminal dashboard where the user can approve or deny escalations.
 *
 * Usage: ironcurtain escalation-listener
 *
 * It needs an interactive terminal: without one (stdin or stderr not a TTY)
 * it refuses before taking the single-instance lock or creating any
 * directory, and `--help` is answered before anything else.
 *
 * Untrusted text. Tool arguments, reasons, whitelist descriptions, server and
 * tool names, context values and session labels are agent-influenced and are
 * written to the user's real terminal, where raw control characters could
 * move the cursor and overwrite the dashboard, set the clipboard or make the
 * terminal type replies. Every such field goes through `toDisplayText`, which
 * renders controls, C1, bidi and invisible characters as visible `\u...`
 * escapes; argument values are rendered as JSON so a string's boundaries are
 * unambiguous. chalk does not interpret markup, so no further escaping is
 * needed here.
 *
 * Reviewer context. An escalation can carry the human's last trusted message
 * (written by the human, through the trusted-input bar of the mux or web UI)
 * and the agent's justification (UNTRUSTED, written by the agent). The
 * dashboard and the bulk listings label each for what it is and escape both.
 *
 * Groups. Escalations sharing one whitelist pattern (escalation-groups.ts)
 * are marked on the dashboard; `/approve group N` lists the members of #N's
 * group and approves exactly that set only with the code shown for it, like
 * `/approve all`.
 */

import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { checkHelp, parseArgsStrict, type CommandSpec } from '../cli-help.js';
import { toDisplayText } from '../terminal/display-sanitize.js';

import { getPtyRegistryDir, getListenerLockPath } from '../config/paths.js';
import { isOwnedByLiveMux, readActiveRegistrations } from './session-registry.js';
import { createEscalationWatcher } from './escalation-watcher.js';
import type { EscalationWatcher } from './escalation-watcher.js';
import type { PtySessionRegistration } from '../docker/pty-types.js';
import { acquireListenerLock, type ListenerLock } from './listener-lock.js';
import {
  createInitialState,
  addSession,
  removeSession,
  addEscalation,
  resolveEscalation,
  expireEscalation,
  type ListenerState,
} from './listener-state.js';
import {
  DEFAULT_WHITELIST_OPTIONS,
  directoryCandidateIndex,
  type WhitelistScope,
} from '../trusted-process/approval-whitelist.js';
import { escalationGroupKey, escalationGroupPattern, groupMembers } from './escalation-groups.js';
import { displayedUserMessage } from './escalation-review.js';
import type { PendingEscalation } from './listener-state.js';

/** Poll interval for the session registry directory (ms). */
const REGISTRY_POLL_INTERVAL_MS = 1000;

/**
 * Longest rendering of one argument value on the dashboard, in code points.
 * The dashboard is redrawn from the top of a fixed screen, so an unbounded
 * value would push the prompt off it; the cut is marked (`...[+N chars]`) so
 * the approver can see that content was omitted and deny if in doubt.
 */
const MAX_ARGUMENT_DISPLAY_LENGTH = 240;

/** Longest session label shown on the dashboard, in code points. */
const MAX_LABEL_DISPLAY_LENGTH = 40;

/**
 * Longest rendering of the human's last message on the dashboard, in code
 * points (the request carries up to MAX_REVIEWER_CONTEXT_CHARS). The cut is
 * marked; the message is the user's own text.
 */
const MAX_USER_MESSAGE_DISPLAY_LENGTH = 300;

/** Signals that end the listener (closing its terminal sends SIGHUP). */
const LISTENER_EXIT_SIGNALS = { SIGHUP: 1, SIGTERM: 15 } as const;

/**
 * Releases the listener's lock when the process ends: on SIGHUP (its
 * terminal was closed) and SIGTERM, which then exit with 128 + the signal
 * number, and on any other exit. Without this a closed terminal left the
 * lock behind, and a later process that reused the pid kept every new
 * listener out and made the mux stop watching unowned sessions. Returns the
 * thunk that removes the handlers (for a normal shutdown). Exported for
 * tests; `exit` is a seam.
 */
export function installListenerExitHandlers(
  lock: ListenerLock,
  cleanup: () => void,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  const onExit = (): void => lock.release();
  const handlers = Object.entries(LISTENER_EXIT_SIGNALS).map(([signal, number]) => {
    const handler = (): void => {
      try {
        cleanup();
      } finally {
        lock.release();
        exit(128 + number);
      }
    };
    process.once(signal as NodeJS.Signals, handler);
    return { signal: signal as NodeJS.Signals, handler };
  });
  process.once('exit', onExit);
  return () => {
    for (const { signal, handler } of handlers) process.removeListener(signal, handler);
    process.removeListener('exit', onExit);
  };
}

/**
 * Whether the standalone listener shows a registered session's escalations:
 * not when a live mux (or the web UI daemon) owns the session, which shows
 * them itself, so no escalation is prompted for in two places at once. An
 * orphaned session (its owner died) and an unowned one are shown. Exported
 * for tests.
 */
export function shouldListenerWatch(registration: PtySessionRegistration): boolean {
  return !isOwnedByLiveMux(registration);
}

export const escalationListenerSpec: CommandSpec = {
  name: 'ironcurtain escalation-listener',
  description: 'Approve or deny the escalations of PTY sessions that no mux owns, in one terminal dashboard',
  usage: ['ironcurtain escalation-listener'],
  options: [{ flag: 'help', short: 'h', description: 'Show this help message' }],
  examples: [
    'ironcurtain escalation-listener   # In a second terminal, beside `ironcurtain start --pty` sessions',
    '',
    'Dashboard commands: /approve <N>, /approve+ <N>, /approve+dir <N>, /deny <N>, /deny all,',
    '/approve all, /approve group <N>, /sessions, /quit',
  ],
};

/**
 * Whether the listener can run here: it reads decisions from stdin and draws
 * its dashboard on stderr, so both must be a terminal. Exported for tests.
 */
export function listenerHasTerminal(
  stdin: { readonly isTTY?: boolean } = process.stdin,
  stderr: { readonly isTTY?: boolean } = process.stderr,
): boolean {
  return stdin.isTTY === true && stderr.isTTY === true;
}

export async function main(args: readonly string[] = []): Promise<void> {
  const { values } = parseArgsStrict(
    { args: [...args], options: { help: { type: 'boolean', short: 'h' } } },
    escalationListenerSpec.name,
  );
  if (checkHelp(values, escalationListenerSpec)) return;

  // Before the lock and any mkdir: without a terminal the dashboard cannot be
  // shown nor a decision typed, so the listener must not claim the lock (and
  // with it the unowned sessions' escalations) either.
  if (!listenerHasTerminal()) {
    process.stderr.write('Error: ironcurtain escalation-listener requires an interactive terminal (TTY).\n');
    process.exitCode = 1;
    return;
  }

  // Single-instance enforcement
  const lockPath = getListenerLockPath();
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock = acquireListenerLock(lockPath);
  if (!lock) {
    process.stderr.write(chalk.red('Another escalation listener is already running.\n'));
    process.exit(1);
  }

  const registryDir = getPtyRegistryDir();
  mkdirSync(registryDir, { recursive: true, mode: 0o700 });

  let state = createInitialState();
  let lastRenderedContent = '';

  // Set up readline for command input
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  // Settles when readline closes: on /quit, stdin EOF or a signal. Resolved
  // from the 'close' event itself, so the wait below ends in the same tick;
  // a polling timer (unref'd so it would not keep the process alive) let the
  // event loop drain first, and Node ended with an unsettled top-level await
  // (exit code 13) without the cleanup below.
  const closed = new Promise<void>((resolve) => {
    rl.once('close', () => resolve());
  });

  /**
   * Renders the dashboard only if the content has actually changed.
   * Uses cursor repositioning (move to home) instead of screen clear
   * to avoid destroying readline's input buffer.
   */
  const render = (): void => {
    const content = buildDashboard(state);
    if (content === lastRenderedContent) return;
    lastRenderedContent = content;

    // Move cursor to home position, write content with per-line clearing,
    // then clear any remaining lines below. The per-line \x1b[K (clear to
    // end of line) is needed because shorter new lines would otherwise leave
    // leftover characters from the previous (longer) dashboard render.
    process.stderr.write('\x1b[H\x1b[K' + content.replace(/\n/g, '\x1b[K\n') + '\x1b[J');

    // Force readline to redisplay its prompt + current input buffer
    rl.prompt(true);
  };

  // Poll for new/removed sessions. The readline 'close' event
  // drives shutdown, so these timers must not keep the process alive.
  const registryPollInterval = setInterval(() => {
    const registrations = readActiveRegistrations(registryDir);
    const currentIds = new Set(registrations.map((r) => r.sessionId));
    const stateIds = new Set(state.sessions.keys());

    let changed = false;

    // Add new sessions, except those a live mux (or the web UI) owns and
    // shows; an orphaned one is picked up once its owner is gone.
    for (const reg of registrations) {
      if (!stateIds.has(reg.sessionId) && shouldListenerWatch(reg)) {
        const watcher = createWatcherForSession(
          reg,
          (newState) => {
            state = newState;
            render();
          },
          () => state,
        );
        state = addSession(state, reg, watcher);
        watcher.start();
        changed = true;
      }
    }

    // Remove gone sessions
    for (const id of stateIds) {
      if (!currentIds.has(id)) {
        const session = state.sessions.get(id);
        session?.watcher.stop();
        state = removeSession(state, id);
        changed = true;
      }
    }

    if (changed) render();
  }, REGISTRY_POLL_INTERVAL_MS);
  registryPollInterval.unref();

  const stopWatching = (): void => {
    clearInterval(registryPollInterval);
    for (const session of state.sessions.values()) {
      session.watcher.stop();
    }
  };
  // SIGHUP (terminal closed) and SIGTERM release the lock and exit.
  const removeExitHandlers = installListenerExitHandlers(lock, () => {
    stopWatching();
    rl.close();
  });

  // Initial render: clear screen once, then use repositioning from now on
  rl.setPrompt('  > ');
  process.stderr.write('\x1b[2J');
  render();

  // Handle commands
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      render();
      return;
    }

    const result = handleCommand(trimmed, state);
    state = result.state;

    if (result.quit) {
      if (result.message) {
        process.stderr.write(result.message + '\n');
      }
      rl.close();
      return;
    }

    // Force a re-render by invalidating the cache
    lastRenderedContent = '';

    if (result.message) {
      // Render first so the message appears below the dashboard
      render();
      process.stderr.write(result.message + '\n');
      rl.prompt(true);
    } else {
      render();
    }
  });

  // Wait until quit (readline closed).
  await closed;

  // Cleanup
  stopWatching();
  removeExitHandlers();
  lock.release();
}

// --- Watcher creation ---

/**
 * Watches one registered session's escalation directory and folds what it
 * sees into the listener state (`addEscalation` / `expireEscalation`, keyed
 * by that session). Exported for tests.
 */
export function createWatcherForSession(
  registration: PtySessionRegistration,
  onStateChange: (state: ListenerState) => void,
  getState: () => ListenerState,
): EscalationWatcher {
  return createEscalationWatcher(
    registration.escalationDir,
    {
      onEscalation: (request) => {
        const newState = addEscalation(getState(), registration.sessionId, request);
        onStateChange(newState);
        // BEL character alerts the user
        process.stderr.write('\x07');
      },
      onEscalationExpired: (escalationId) => {
        const newState = expireEscalation(getState(), registration.sessionId, escalationId);
        onStateChange(newState);
      },
    },
    { pollIntervalMs: 300 },
  );
}

// --- Command handling ---

export interface CommandResult {
  state: ListenerState;
  message?: string;
  quit?: boolean;
}

/** Applies one typed listener command to the state. Exported for tests. */
export function handleCommand(input: string, state: ListenerState): CommandResult {
  const parts = input.split(/\s+/);
  const command = parts[0].toLowerCase();

  // Strip + suffix for whitelist variant (e.g., /approve+ -> /approve with whitelist flag)
  // Only /approve+ is valid; /deny+ is ignored (whitelisting a deny makes no sense).
  const baseCommand = command.endsWith('+') ? command.slice(0, -1) : command;
  const withWhitelist = command.endsWith('+') && baseCommand === '/approve';

  switch (baseCommand) {
    // Approve and whitelist the directory-wide pattern: an explicit choice,
    // one escalation at a time (never in bulk).
    case '/approve+dir': {
      const arg = parts[1];
      if (!arg) return { state, message: chalk.yellow('Usage: /approve+dir <number>') };
      if (arg === 'all' || arg === 'group') {
        return {
          state,
          message: chalk.yellow(
            'Directory-wide whitelisting is chosen one escalation at a time: /approve+dir <number>',
          ),
        };
      }
      const num = parseInt(arg, 10);
      if (isNaN(num)) return { state, message: chalk.yellow('Invalid escalation number') };
      return approveOrDeny(state, num, 'approved', 'directory');
    }

    case '/approve': {
      const arg = parts[1];
      if (!arg) {
        return { state, message: chalk.yellow('Usage: /approve <number>, /approve all or /approve group <number>') };
      }

      if (arg === 'all') {
        return approveAllCommand(state, withWhitelist, parts[2]);
      }
      if (arg === 'group') {
        const groupNumber = parts.length > 2 ? parseInt(parts[2], 10) : NaN;
        if (isNaN(groupNumber)) return { state, message: chalk.yellow('Usage: /approve group <number>') };
        return approveGroupCommand(state, groupNumber, withWhitelist, parts[3]);
      }
      const num = parseInt(arg, 10);
      if (isNaN(num)) return { state, message: chalk.yellow('Invalid escalation number') };
      return approveOrDeny(state, num, 'approved', withWhitelist ? 'exact' : false);
    }

    case '/deny': {
      const arg = parts[1];
      if (!arg) return { state, message: chalk.yellow('Usage: /deny <number> or /deny all') };

      if (arg === 'all') {
        return approveOrDenyAll(state, 'denied');
      }
      const num = parseInt(arg, 10);
      if (isNaN(num)) return { state, message: chalk.yellow('Invalid escalation number') };
      return approveOrDeny(state, num, 'denied');
    }

    case '/sessions':
      return { state, message: formatSessionDetails(state) };

    case '/quit':
    case '/q':
      return { state, quit: true };

    default:
      return {
        state,
        message: chalk.yellow(
          'Unknown command. Available: /approve <N>, /approve+ <N>, /approve+dir <N>, /deny <N>, /deny all, /approve all (lists them and asks to confirm), /approve group <N> (lists the group and asks to confirm), /sessions, /quit',
        ),
      };
  }
}

/**
 * Resolves one pending escalation. `whitelist` adds a pattern with an
 * approval: `exact` the first candidate (`/approve+ N`; a human-only
 * escalation is approved once instead), `directory` the directory-wide one
 * (`/approve+dir N`; nothing is resolved when the escalation offers none).
 */
function approveOrDeny(
  state: ListenerState,
  displayNumber: number,
  decision: 'approved' | 'denied',
  whitelist: false | WhitelistScope = false,
): CommandResult {
  const escalation = state.pendingEscalations.get(displayNumber);
  if (!escalation) {
    return { state, message: chalk.yellow(`No pending escalation #${displayNumber}`) };
  }

  const session = state.sessions.get(escalation.sessionId);
  if (!session) {
    return { state, message: chalk.yellow(`Session for escalation #${displayNumber} no longer active`) };
  }

  // A human-only escalation is never whitelisted: /approve+ approves this
  // one call and says so. /approve+dir needs a directory-wide candidate (a
  // human-only escalation has none); without one nothing is resolved.
  const humanOnly = escalation.request.humanOnly === true;
  const scope = decision === 'approved' ? whitelist : false;
  let selection: { readonly whitelistSelection: number } | undefined;
  let whitelistSuffix = '';
  if (scope === 'directory') {
    const index = humanOnly ? undefined : directoryCandidateIndex(escalation.request.whitelistCandidates);
    if (index === undefined) {
      return {
        state,
        message: chalk.yellow(
          humanOnly
            ? `Escalation #${displayNumber} was not resolved: a human-only escalation is never whitelisted (/approve ${displayNumber} approves it once)`
            : `Escalation #${displayNumber} was not resolved: it offers no directory-wide whitelist pattern (/approve+ ${displayNumber} whitelists this path only)`,
        ),
      };
    }
    selection = { whitelistSelection: index };
    whitelistSuffix = chalk.cyan(' (whitelisted: directory-wide)');
  } else if (scope === 'exact') {
    selection = humanOnly ? undefined : DEFAULT_WHITELIST_OPTIONS;
    whitelistSuffix = humanOnly
      ? chalk.yellow(' (human-only: approved once, not whitelisted)')
      : chalk.cyan(' (whitelisted)');
  }

  try {
    const accepted = session.watcher.resolve(escalation.request.escalationId, decision, selection);
    const newState = resolveEscalation(state, displayNumber, decision);

    if (!accepted) {
      return {
        state: newState,
        message: chalk.yellow(`Escalation #${displayNumber} expired (response was too late)`),
      };
    }

    const label = decision === 'approved' ? chalk.green('APPROVED') : chalk.red('DENIED');
    return {
      state: newState,
      message: `Escalation #${displayNumber} ${label}${whitelistSuffix}`,
    };
  } catch (err) {
    return { state, message: chalk.red(`Error: ${toDisplayText(err instanceof Error ? err.message : String(err))}`) };
  }
}

/**
 * A short code naming exactly the escalations pending now (display number,
 * session and escalation id) and whether they would be whitelisted. Typed
 * back after `/approve all`, it binds the approval to the list the user
 * was shown: any arrival, expiry or resolution changes the code.
 */
export function bulkApprovalCode(state: ListenerState, whitelist: boolean): string {
  const entries = [...state.pendingEscalations.values()]
    .sort((a, b) => a.displayNumber - b.displayNumber)
    .map((esc) => [esc.displayNumber, esc.sessionId, esc.request.escalationId]);
  return createHash('sha256')
    .update(JSON.stringify([whitelist, entries]))
    .digest('hex')
    .slice(0, 6);
}

/**
 * `/approve all` and `/approve+ all`. Without a code it approves nothing:
 * it lists every pending escalation (tool, every argument, reason, and for
 * `/approve+ all` the pattern each would whitelist) and the command, with
 * the code for exactly that set, that approves them. With the right code it
 * approves them; with a stale or wrong code it refuses and lists the
 * current set again. Human-only escalations stay pending either way.
 */
function approveAllCommand(state: ListenerState, whitelist: boolean, code: string | undefined): CommandResult {
  if (state.pendingEscalations.size === 0) {
    return { state, message: chalk.yellow('No pending escalations') };
  }
  const expected = bulkApprovalCode(state, whitelist);
  if (code?.toLowerCase() === expected) {
    return approveOrDenyAll(state, 'approved', whitelist);
  }
  const listing = formatBulkApprovalListing(state, whitelist, expected);
  if (code === undefined) return { state, message: listing };
  return {
    state,
    message: `${chalk.yellow('Nothing was approved: the pending escalations changed since they were listed, or the code is wrong.')}\n${listing}`,
  };
}

/** The confirmation listing for `/approve all`: every pending escalation and how to approve exactly these. */
function formatBulkApprovalListing(state: ListenerState, whitelist: boolean, code: string): string {
  const command = whitelist ? '/approve+ all' : '/approve all';
  const sorted = [...state.pendingEscalations.values()].sort((a, b) => a.displayNumber - b.displayNumber);
  const approvable = sorted.filter((esc) => esc.request.humanOnly !== true);
  const lines: string[] = [
    chalk.bold(
      `  ${command} would approve ${approvable.length} of ${sorted.length} pending escalation${sorted.length === 1 ? '' : 's'}:`,
    ),
  ];
  for (const esc of sorted) {
    lines.push(...formatListingEntry(esc, whitelist));
    if (esc.request.humanOnly === true) {
      lines.push(
        chalk.yellow(`        human-only: stays pending; approve it on its own with /approve ${esc.displayNumber}`),
      );
    }
  }
  if (approvable.length === 0) {
    lines.push(chalk.yellow('  Nothing can be approved in bulk; use /approve N for each.'));
  } else {
    lines.push(
      `  To approve exactly these, type: ${chalk.bold(`${command} ${code}`)}  (any change to the list voids the code)`,
    );
  }
  return lines.join('\n');
}

/**
 * A short code naming exactly the members of one whitelist-pattern group
 * (display number, session and escalation id, plus the group's key) and
 * whether they would be whitelisted. Typed back after `/approve group N`, it
 * binds the approval to the group the user was shown: any arrival, expiry
 * or resolution in the group changes the code.
 */
export function groupApprovalCode(members: readonly PendingEscalation[], groupKey: string, whitelist: boolean): string {
  const entries = [...members]
    .sort((a, b) => a.displayNumber - b.displayNumber)
    .map((esc) => [esc.displayNumber, esc.sessionId, esc.request.escalationId]);
  return createHash('sha256')
    .update(JSON.stringify(['group', groupKey, whitelist, entries]))
    .digest('hex')
    .slice(0, 6);
}

/**
 * `/approve group N` and `/approve+ group N`. Without a code it approves
 * nothing: it lists every pending escalation sharing #N's whitelist pattern
 * (tool, every argument, reason, the human's last message and the agent's
 * justification) and the command, with the code for exactly that group,
 * that approves them. With the right code it approves each member once
 * (with `+`, whitelisting each one's pattern in its session); with a stale
 * or wrong code it refuses and lists the current group again.
 */
function approveGroupCommand(
  state: ListenerState,
  displayNumber: number,
  whitelist: boolean,
  code: string | undefined,
): CommandResult {
  const anchor = state.pendingEscalations.get(displayNumber);
  if (!anchor) return { state, message: chalk.yellow(`No pending escalation #${displayNumber}`) };
  const command = whitelist ? '/approve+' : '/approve';
  const pattern = escalationGroupPattern(anchor.request);
  if (pattern === undefined) {
    return {
      state,
      message: chalk.yellow(
        `Escalation #${displayNumber} is not in a group (no whitelist pattern, or human-only): use ${command} ${displayNumber}`,
      ),
    };
  }
  const members = groupMembers(state.pendingEscalations.values(), (esc) => esc.request, pattern.patternKey).sort(
    (a, b) => a.displayNumber - b.displayNumber,
  );
  if (members.length < 2) {
    return {
      state,
      message: chalk.yellow(
        `No other pending escalation shares the pattern of #${displayNumber}: use ${command} ${displayNumber}`,
      ),
    };
  }
  const expected = groupApprovalCode(members, pattern.patternKey, whitelist);
  if (code?.toLowerCase() === expected) {
    let currentState = state;
    const messages: string[] = [];
    for (const esc of members) {
      // `/approve+ group` whitelists each member's exact pattern (the one
      // they share); directory-wide patterns are chosen one at a time only.
      const result = approveOrDeny(currentState, esc.displayNumber, 'approved', whitelist ? 'exact' : false);
      currentState = result.state;
      if (result.message) messages.push(result.message);
    }
    return { state: currentState, message: messages.join('\n') };
  }
  const listing = formatGroupApprovalListing(members, pattern.description, displayNumber, whitelist, expected);
  if (code === undefined) return { state, message: listing };
  return {
    state,
    message: `${chalk.yellow("Nothing was approved: the group's escalations changed since they were listed, or the code is wrong.")}\n${listing}`,
  };
}

/** The confirmation listing for `/approve group N`: every member and how to approve exactly these. */
function formatGroupApprovalListing(
  members: readonly PendingEscalation[],
  description: string,
  displayNumber: number,
  whitelist: boolean,
  code: string,
): string {
  const command = `${whitelist ? '/approve+' : '/approve'} group ${displayNumber}`;
  const lines: string[] = [
    chalk.bold(`  ${command} would approve these ${members.length} escalations, each once:`),
    chalk.cyan(`    Every call matches: ${toDisplayText(description)}`),
  ];
  for (const esc of members) lines.push(...formatListingEntry(esc, whitelist));
  lines.push(
    `  To approve exactly these, type: ${chalk.bold(`${command} ${code}`)}  (any change to the group voids the code)`,
  );
  return lines.join('\n');
}

/** One escalation in a bulk listing: header, every argument, reason and reviewer context. */
function formatListingEntry(esc: PendingEscalation, whitelist: boolean): string[] {
  const lines = [
    `    [${chalk.bold.yellow(String(esc.displayNumber))}] Session #${esc.sessionDisplayNumber}  ${chalk.cyan(toolLabel(esc.request.serverName, esc.request.toolName))}`,
  ];
  for (const line of formatArgumentLines(esc.request.arguments)) lines.push(`        ${line}`);
  lines.push(`        Reason: ${toDisplayText(esc.request.reason)}`);
  lines.push(...formatReviewContextLines(esc, '        '));
  if (whitelist && esc.request.humanOnly !== true) {
    const candidate = esc.request.whitelistCandidates?.[0];
    lines.push(
      candidate
        ? chalk.cyan(`        Whitelist: ${toDisplayText(candidate.description)}`)
        : chalk.dim('        no whitelist pattern: approved this once'),
    );
  }
  return lines;
}

/**
 * The reviewer context of an escalation, labelled: the session's task and
 * the human's last message (trusted, the human's own text) and the agent's
 * justification (untrusted, written by the agent). Every value is escaped.
 */
export function formatReviewContextLines(esc: PendingEscalation, indent: string): string[] {
  const { request } = esc;
  const lines: string[] = [];
  const userMessage = displayedUserMessage(request);
  if (request.taskSummary !== undefined) {
    lines.push(
      `${indent}${chalk.green('Task:')}     ${toDisplayText(request.taskSummary, { maxLength: MAX_USER_MESSAGE_DISPLAY_LENGTH })}`,
    );
  }
  if (userMessage !== undefined) {
    const when = userMessage.sentAt !== undefined ? chalk.dim(` (${formatTimeAgo(new Date(userMessage.sentAt))})`) : '';
    lines.push(
      `${indent}${chalk.green('You said:')} ${toDisplayText(userMessage.text, { maxLength: MAX_USER_MESSAGE_DISPLAY_LENGTH })}${when}`,
    );
  }
  if (request.agentJustification !== undefined) {
    lines.push(`${indent}${chalk.yellow('Agent says (untrusted, written by the agent):')}`);
    lines.push(`${indent}  ${chalk.dim(toDisplayText(request.agentJustification))}`);
  }
  return lines;
}

/**
 * Resolves every pending escalation. A human-only escalation
 * (`EscalationRequest.humanOnly`, e.g. opening a passthrough domain) is left
 * pending by "approve all" so an operator approves it knowingly with
 * `/approve N`; "deny all" denies it like any other. Approving reaches this
 * only through {@link approveAllCommand}, with the code for the listed set.
 */
function approveOrDenyAll(state: ListenerState, decision: 'approved' | 'denied', whitelist?: boolean): CommandResult {
  if (state.pendingEscalations.size === 0) {
    return { state, message: chalk.yellow('No pending escalations') };
  }

  let currentState = state;
  const messages: string[] = [];
  const nums = [...state.pendingEscalations.keys()].sort((a, b) => a - b);

  for (const num of nums) {
    if (decision === 'approved' && state.pendingEscalations.get(num)?.request.humanOnly === true) {
      messages.push(chalk.yellow(`Escalation #${num} requires individual approval (/approve ${num})`));
      continue;
    }
    const result = approveOrDeny(currentState, num, decision, whitelist === true ? 'exact' : false);
    currentState = result.state;
    if (result.message) messages.push(result.message);
  }

  return { state: currentState, message: messages.join('\n') };
}

function formatSessionDetails(state: ListenerState): string {
  if (state.sessions.size === 0) {
    return chalk.dim('No active sessions');
  }

  const lines: string[] = [];
  for (const session of state.sessions.values()) {
    const reg = session.registration;
    const ago = formatTimeAgo(new Date(reg.startedAt));
    lines.push(
      `  [${session.displayNumber}] ${shortId(reg.sessionId)}  ${toDisplayText(reg.label, { maxLength: MAX_LABEL_DISPLAY_LENGTH })}  ${chalk.dim(ago)}`,
    );
  }
  return lines.join('\n');
}

// --- Rendering ---

/**
 * Builds the dashboard content as a string.
 * Pure function — no side effects. The caller handles writing to the terminal
 * and coordinating with readline's prompt. Exported for tests: the output
 * must never carry a control byte that came from an escalation.
 */
export function buildDashboard(state: ListenerState): string {
  const lines: string[] = [];
  const sessionCount = state.sessions.size;
  const pendingCount = state.pendingEscalations.size;

  // Header
  lines.push(
    chalk.bold.cyan('  IronCurtain Escalation Listener') +
      chalk.dim(`              ${sessionCount} session${sessionCount !== 1 ? 's' : ''} active`),
  );
  lines.push(chalk.dim('  ' + '\u2500'.repeat(60)));

  // Active Sessions
  lines.push('');
  lines.push(chalk.bold('  Active Sessions:'));
  if (sessionCount === 0) {
    lines.push(chalk.dim('    Waiting for PTY sessions...'));
  } else {
    for (const session of state.sessions.values()) {
      const reg = session.registration;
      const ago = formatTimeAgo(new Date(reg.startedAt));
      const sessionPending = countPendingForSession(state, reg.sessionId);
      const pendingLabel = sessionPending > 0 ? chalk.yellow(` ${sessionPending} pending`) : chalk.dim(' 0 pending');
      lines.push(
        `    [${chalk.bold(String(session.displayNumber))}] ` +
          `${shortId(reg.sessionId)}  ` +
          `${toDisplayText(reg.label, { maxLength: MAX_LABEL_DISPLAY_LENGTH })}  ` +
          chalk.dim(ago) +
          pendingLabel,
      );
    }
  }

  // Pending Escalations
  lines.push('');
  lines.push(chalk.dim('  ' + '\u2500'.repeat(60)));
  lines.push('');
  lines.push(chalk.bold('  Pending Escalations:') + (pendingCount === 0 ? chalk.dim(' (none)') : ''));

  if (pendingCount > 0) {
    const sorted = [...state.pendingEscalations.values()].sort((a, b) => a.displayNumber - b.displayNumber);
    for (const esc of sorted) {
      lines.push('');
      lines.push(
        `    [${chalk.bold.yellow(String(esc.displayNumber))}] ` +
          `Session #${esc.sessionDisplayNumber} (${shortId(esc.sessionId)})`,
      );
      lines.push(`        Tool:    ${chalk.cyan(toolLabel(esc.request.serverName, esc.request.toolName))}`);

      // Every argument, one per line, so the decisive one cannot hide past a cut.
      const argLines = formatArgumentLines(esc.request.arguments);
      argLines.forEach((line, index) => {
        lines.push(index === 0 ? `        Args:    ${line}` : `                 ${line}`);
      });
      lines.push(`        Reason:  ${toDisplayText(esc.request.reason)}`);

      if (esc.request.context) {
        for (const [k, v] of Object.entries(esc.request.context)) {
          lines.push(`        ${toDisplayText(k)}: ${chalk.yellow(toDisplayText(JSON.stringify(v)))}`);
        }
      }

      // What each whitelisting command adds, behind the trusted command
      // prefix: /approve+ the exact pattern, /approve+dir the directory-wide one.
      const candidates = esc.request.whitelistCandidates;
      if (candidates && candidates.length > 0) {
        lines.push(
          `        ${chalk.cyan(`/approve+ ${esc.displayNumber}: ${toDisplayText(candidates[0].description)}`)}`,
        );
        const directoryIndex = directoryCandidateIndex(candidates);
        if (directoryIndex !== undefined) {
          lines.push(
            `        ${chalk.cyan(`/approve+dir ${esc.displayNumber}: ${toDisplayText(candidates[directoryIndex].description)}`)}`,
          );
        }
      }

      lines.push(...formatReviewContextLines(esc, '        '));

      const groupKey = escalationGroupKey(esc.request);
      const groupSize = groupKey === undefined ? 0 : groupMembers(sorted, (other) => other.request, groupKey).length;
      if (groupSize >= 2) {
        lines.push(
          chalk.dim(
            `        ${groupSize} pending share this pattern: /approve group ${esc.displayNumber} lists them to approve together`,
          ),
        );
      }
    }
  }

  // History
  if (state.history.length > 0) {
    lines.push('');
    lines.push(chalk.dim('  ' + '\u2500'.repeat(60)));
    lines.push('');
    lines.push(chalk.bold('  History (last 10):'));
    const recent = state.history.slice(0, 10);
    for (const entry of recent) {
      const time = entry.resolvedAt.toLocaleTimeString();
      const decisionLabel = entry.decision === 'approved' ? chalk.green('APPROVED') : chalk.red('DENIED');
      lines.push(`    [${chalk.dim(time)}] ` + `${toolLabel(entry.serverName, entry.toolName)}  ` + decisionLabel);
    }
  }

  // Command hint (prompt itself is handled by readline)
  lines.push('');
  lines.push(chalk.dim('  ' + '\u2500'.repeat(60)));
  lines.push(
    chalk.dim(
      '  /approve N | /approve+ N | /approve+dir N | /deny N | /deny all | /approve all, /approve group N (ask to confirm) | /quit',
    ),
  );

  return lines.join('\n') + '\n';
}

// --- Helpers ---

function countPendingForSession(state: ListenerState, sessionId: string): number {
  let count = 0;
  for (const esc of state.pendingEscalations.values()) {
    if (esc.sessionId === sessionId) count++;
  }
  return count;
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/** First eight characters of a session id, display-sanitized. */
function shortId(sessionId: string): string {
  return toDisplayText(sessionId.substring(0, 8));
}

/** `server/tool`, display-sanitized. */
function toolLabel(serverName: string, toolName: string): string {
  return `${toDisplayText(serverName)}/${toDisplayText(toolName)}`;
}

const PLAIN_KEY = /^[A-Za-z_$][\w$-]*$/u;

/**
 * One line per argument, `key: value`, every value as JSON (strings quoted,
 * objects and arrays serialized) and display-escaped, so non-string and
 * fourth-and-later arguments appear and hidden characters show as `\u001b`.
 * Values longer than MAX_ARGUMENT_DISPLAY_LENGTH are cut with an explicit
 * marker.
 */
function formatArgumentLines(args: unknown): string[] {
  // The request file is parsed without a schema; never let a malformed one
  // crash the dashboard.
  if (typeof args !== 'object' || args === null) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    // JSON.stringify is typed as returning string but yields undefined for
    // functions and symbols; arguments come from JSON, so render the type
    // name in that impossible case rather than crash the dashboard.
    const json = JSON.stringify(value) as string | undefined;
    const shownKey = toDisplayText(PLAIN_KEY.test(key) ? key : JSON.stringify(key), {
      maxLength: MAX_ARGUMENT_DISPLAY_LENGTH,
    });
    const shownValue = toDisplayText(json ?? typeof value, { maxLength: MAX_ARGUMENT_DISPLAY_LENGTH });
    lines.push(`${shownKey}: ${shownValue}`);
  }
  return lines;
}
