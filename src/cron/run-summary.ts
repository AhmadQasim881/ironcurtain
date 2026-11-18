/**
 * The run summary an unattended job's agent leaves in its workspace.
 *
 * The cron prompt tells the agent to write `last-run.md` at the workspace
 * root before it finishes, and the daemon copies a bounded excerpt into the
 * run record and the completion notification. The workspace is agent-writable
 * (bind-mounted read-write in Docker Agent Mode, the allowedDirectory in Code
 * Mode), so that file is untrusted: it can be a symlink to a host secret, a
 * FIFO that blocks a reader forever, a device, an enormous sparse file, or a
 * leftover from an earlier run. This module is the one place the daemon
 * touches it:
 *
 * - {@link retireRunSummary} runs before the session starts. It moves the
 *   previous run's `last-run.md` to `previous-run.md` (a rename acts on the
 *   directory entry, so nothing is opened or followed), so a run that writes
 *   no summary is never credited with the previous one, while the agent can
 *   still read what the previous run recommended.
 * - {@link readRunSummary} runs after the session has ended (in Docker mode
 *   the container is gone, so nothing races the read). It reads at most
 *   {@link MAX_SUMMARY_BYTES} through `readUntrustedRegularFile`, which never
 *   follows a symlink and never opens a FIFO or device, then removes terminal
 *   escape sequences and control characters, shows bidi controls as escapes
 *   and keeps at most {@link MAX_SUMMARY_CHARS} characters.
 * - {@link formatRunNotification} builds the Signal completion notice from a
 *   run record, with every agent- or user-derived part sanitized and the
 *   summary quoted line by line (sent as plain text), and
 *   {@link formatRunRefusal} the notice for a run its policy check refused.
 * - {@link RunNoticeCollector} keeps the notices the run's session reported
 *   (a stale policy, host-mount findings, ...) for the run record.
 *
 * The workspace argument is the canonical absolute workspace the run used.
 * Its own directory entry is not agent-replaceable (it is the mount source,
 * or outside the agent's allowedDirectory); only the names below it are.
 */

import { lstatSync, renameSync, unlinkSync, type Stats } from 'node:fs';
import { join } from 'node:path';

import { readUntrustedRegularFile, type UntrustedFileContents } from '../hardened-fs.js';
import { formatCostUsd } from '../session/cost-display.js';
import { formatSessionNotice, isSessionNotice } from '../session/startup-notices.js';
import type { DiagnosticEvent } from '../session/types.js';
import { escapeBidiControls, stripTerminalSequences, toDisplayText } from '../terminal/display-sanitize.js';
import type { RunRecord } from './types.js';

/** The summary file the agent writes at the workspace root. */
export const RUN_SUMMARY_FILE = 'last-run.md';

/** Where the previous run's summary is moved before a run starts (agent-readable). */
export const PREVIOUS_RUN_SUMMARY_FILE = 'previous-run.md';

/** Bytes of last-run.md the daemon reads at most; a summary is a few paragraphs. */
export const MAX_SUMMARY_BYTES = 8 * 1024;

/** Characters of the summary kept in the run record. */
export const MAX_SUMMARY_CHARS = 2000;

/** Characters of the summary included in a completion notification. */
const MAX_NOTIFICATION_SUMMARY_CHARS = 500;

/** Characters of an error message included in a completion notification. */
const MAX_NOTIFICATION_ERROR_CHARS = 500;

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Moves the previous run's `last-run.md` aside to `previous-run.md`,
 * replacing an older one. Called before the session starts, while no agent
 * of the job runs. Nothing is opened or followed: a symlink, FIFO or other
 * entry is moved as itself. A directory at `last-run.md` is left in place,
 * since it can never be read as a summary. When `previous-run.md` cannot be
 * replaced (it is a directory), the stale summary is deleted instead.
 *
 * @throws the filesystem error when the stale summary can be neither moved
 *   nor deleted; the caller must then not capture a summary for this run.
 */
export function retireRunSummary(workspace: string): void {
  const current = join(workspace, RUN_SUMMARY_FILE);
  let stats: Stats;
  try {
    stats = lstatSync(current);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return;
    throw error;
  }
  if (stats.isDirectory()) return;
  try {
    renameSync(current, join(workspace, PREVIOUS_RUN_SUMMARY_FILE));
    return;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return;
    // previous-run.md is a directory or otherwise not replaceable: fall through.
  }
  try {
    unlinkSync(current);
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error;
  }
}

/** Result of {@link readRunSummary}. */
export interface RunSummaryRead {
  /** The sanitized, bounded summary; null when the run left none that could be read. */
  readonly summary: string | null;
  /** Why an existing last-run.md was not used (display-safe), for the daemon log. */
  readonly problem?: string;
}

/** Up to `max` code points of `text`, never splitting a surrogate pair. */
function truncateCodePoints(text: string, max: number): { readonly text: string; readonly cut: boolean } {
  const codePoints = Array.from(text);
  if (codePoints.length <= max) return { text, cut: false };
  return { text: codePoints.slice(0, max).join(''), cut: true };
}

/**
 * Agent prose made safe to store and forward: escape sequences and control
 * characters except tab and line feed removed (CRLF becomes LF), bidi
 * embedding/override/isolate controls shown as `\u202e`-style escapes, and
 * the Unicode line and paragraph separators turned into line feeds.
 */
function sanitizeSummaryText(text: string): string {
  return escapeBidiControls(stripTerminalSequences(text)).replace(/[\u2028\u2029]/gu, '\n');
}

/**
 * Reads the summary the run that just ended wrote to `last-run.md` (see the
 * module comment). Call it after the session has been torn down. Never
 * throws: a missing file is `summary: null`, and a symlink, FIFO, device,
 * directory or unreadable file is `summary: null` with a `problem`.
 */
export function readRunSummary(workspace: string): RunSummaryRead {
  let contents: UntrustedFileContents;
  try {
    contents = readUntrustedRegularFile(join(workspace, RUN_SUMMARY_FILE), {
      maxBytes: MAX_SUMMARY_BYTES,
      oversize: 'truncate',
    });
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'NOT_FOUND') return { summary: null };
    return { summary: null, problem: `${RUN_SUMMARY_FILE} was not read (${code ?? 'error'})` };
  }
  const { text, cut } = truncateCodePoints(sanitizeSummaryText(contents.bytes.toString('utf8')), MAX_SUMMARY_CHARS);
  return { summary: cut || contents.truncated ? `${text}...` : text };
}

/** Notices a run record keeps at most; the ones after them are counted in a last entry. */
export const MAX_RUN_NOTICES = 20;

/** Characters of one notice a run record keeps. */
export const MAX_RUN_NOTICE_CHARS = 3000;

/** Characters of the notices included in a completion notification. */
const MAX_NOTIFICATION_NOTICES_CHARS = 1500;

/**
 * Collects the notices a run's session reports for the user (pass
 * {@link RunNoticeCollector.onDiagnostic} as the session's `onDiagnostic`):
 * the start-up notices (a stale policy, an MCP server that did not start,
 * ...) and setuid/setgid or root-owned files the agent left in its host
 * mounts. Nobody watches an unattended run, so its record keeps them (see
 * `RunRecord.notices`) and the completion notification repeats them. Each is
 * its terminal rendering (display text) with the first line flush left.
 */
export class RunNoticeCollector {
  private readonly notices: string[] = [];
  private dropped = 0;

  readonly onDiagnostic = (event: DiagnosticEvent): void => {
    if (!isSessionNotice(event)) return;
    if (this.notices.length >= MAX_RUN_NOTICES) {
      this.dropped++;
      return;
    }
    const text = formatSessionNotice(event).replace(/^ {2}/gmu, '');
    this.notices.push(toDisplayText(text, { multiline: true, maxLength: MAX_RUN_NOTICE_CHARS }));
  };

  /** The notices collected so far, for `RunRecord.notices`; undefined when there were none. */
  collected(): readonly string[] | undefined {
    if (this.notices.length === 0) return undefined;
    return this.dropped === 0 ? [...this.notices] : [...this.notices, `${this.dropped} further notice(s) not kept`];
  }
}

/** The notices of a run record for its completion notification, bounded and display-safe. */
function formatNotificationNotices(notices: readonly string[]): string {
  const text = toDisplayText(notices.join('\n'), { multiline: true, maxLength: MAX_NOTIFICATION_NOTICES_CHARS });
  return `Notices:\n${text}`;
}

/** Prefix of every summary line in a completion notice (U+2502 and a space). */
const SUMMARY_LINE_QUOTE = '│ ';

/**
 * The Signal completion notice for a run: every outcome, including runs that
 * failed before their session started. The job name and error message are
 * rendered with visible escapes on one line.
 *
 * The summary is the agent's own text, so it is fenced: introduced as written
 * by the job's agent, with control characters removed, invisible and format
 * characters (bidi, zero-width, ...) shown as escapes, cut to
 * {@link MAX_NOTIFICATION_SUMMARY_CHARS} with the omitted count, and every
 * line quoted with a vertical bar. No line of it can start like an escalation
 * banner (`[#`) or pass for IronCurtain's own text. Meant for Signal's plain
 * text mode (`text_mode: "normal"`), so markup in the summary is shown as typed.
 */
export function formatRunNotification(jobName: string, record: RunRecord): string {
  const { outcome, budget } = record;
  let status: string;
  if (outcome.kind === 'success') {
    status = 'Completed';
  } else if (outcome.kind === 'budget_exhausted') {
    status = `Budget exhausted: ${toDisplayText(outcome.dimension)}`;
  } else {
    const phase = outcome.phase === undefined ? '' : ` (${outcome.phase})`;
    status = `Error${phase}: ${toDisplayText(outcome.message, { maxLength: MAX_NOTIFICATION_ERROR_CHARS })}`;
  }
  // A run whose cost nothing reported says "unknown", never a free $0.00.
  const header =
    `[cron: ${toDisplayText(jobName)}] ${status} ` +
    `(${budget.elapsedSeconds.toFixed(0)}s, ${formatCostUsd(budget.estimatedCostUsd, budget.costSource)})`;
  // IronCurtain's own notices about the run come before the agent's text.
  const notices = record.notices !== undefined && record.notices.length > 0 ? record.notices : undefined;
  const head = notices === undefined ? header : `${header}\n${formatNotificationNotices(notices)}`;
  if (!record.summary) return head;
  const summary = toDisplayText(sanitizeSummaryText(record.summary), {
    multiline: true,
    maxLength: MAX_NOTIFICATION_SUMMARY_CHARS,
  });
  const quoted = summary
    .split('\n')
    .map((line) => `${SUMMARY_LINE_QUOTE}${line}`)
    .join('\n');
  return `${head}\nSummary written by the job's agent:\n${quoted}`;
}

/**
 * The Signal notice for a run the daemon refused before anything ran (its
 * policy is missing or stale), rendered on one line with visible escapes.
 */
export function formatRunRefusal(jobName: string, reason: string): string {
  return `[cron: ${toDisplayText(jobName)}] Not run: ${toDisplayText(reason, { maxLength: MAX_NOTIFICATION_ERROR_CHARS })}`;
}
