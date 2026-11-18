/**
 * Session notices: the diagnostics a session reports for the user to see
 * (a stale compiled policy, an MCP server that could not start, host-model
 * fallbacks, annotation drift, setuid or root-owned files the agent left in
 * its host mounts). They reach the browser two ways: in a session's
 * `diagnosticLog` (`sessions.get`, read when the session is selected) and as
 * `session.diagnostic` events. One list per session holds both, each notice
 * once, until the user dismisses it. The lists are keyed by session label,
 * which names one session only for the daemon's lifetime: a restarted daemon
 * numbers its sessions from 1 again, so a list is dropped once its label
 * names another session ({@link isSameSession}, {@link retainSessionNotices}).
 *
 * Pure: no Svelte, DOM or WebSocket dependency (used by event-handler.ts and
 * the store).
 */

import type { SessionDto, SessionNoticeEntry, SessionNoticeEvent } from './types.js';

/** Notices kept per session; the oldest are dropped beyond this. */
export const MAX_SESSION_NOTICES = 20;

/** Host-file warnings remain available outside a session after it ends. */
export interface RetainedHostNotice {
  readonly key: string;
  readonly label: number;
  readonly notice: Extract<SessionNoticeEvent, { kind: 'host_privileged_files' }>;
}

export function retainHostNotice(
  existing: readonly RetainedHostNotice[],
  label: number,
  notice: RetainedHostNotice['notice'],
): readonly RetainedHostNotice[] {
  const key = JSON.stringify([label, sessionNoticeKey(notice)]);
  if (existing.some((entry) => entry.key === key)) return existing;
  return [...existing, { key, label, notice }].slice(-MAX_SESSION_NOTICES);
}

/** Paths of a host-mount finding shown at most (the daemon sends a few). */
const MAX_NOTICE_PATHS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function strings(record: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.every((key) => typeof record[key] === 'string');
}

/**
 * The notice in a diagnostic event, or undefined when it is not one (tool
 * calls, budget events, ...) or is malformed. Only the fields of the notice
 * are kept.
 */
export function toSessionNotice(event: unknown): SessionNoticeEvent | undefined {
  if (!isRecord(event)) return undefined;
  switch (event.kind) {
    case 'annotation_drift':
      return strings(event, 'serverName', 'message', 'hint')
        ? {
            kind: 'annotation_drift',
            serverName: event.serverName as string,
            message: event.message as string,
            hint: event.hint as string,
          }
        : undefined;
    case 'mcp_server_unavailable':
      return strings(event, 'serverName', 'reason')
        ? { kind: 'mcp_server_unavailable', serverName: event.serverName as string, reason: event.reason as string }
        : undefined;
    case 'host_model_fallback':
      return strings(event, 'role', 'action', 'message')
        ? {
            kind: 'host_model_fallback',
            role: event.role as string,
            action: event.action as string,
            message: event.message as string,
          }
        : undefined;
    case 'policy_stale':
      return strings(event, 'message') ? { kind: 'policy_stale', message: event.message as string } : undefined;
    case 'host_privileged_files': {
      const { stripped, unstripped, rootOwned, unlisted, paths, incomplete } = event;
      if (
        !strings(event, 'when', 'hint') ||
        !isCount(stripped) ||
        !isCount(unstripped) ||
        !isCount(rootOwned) ||
        !isCount(unlisted) ||
        typeof incomplete !== 'boolean' ||
        !Array.isArray(paths) ||
        !paths.every((path) => typeof path === 'string')
      ) {
        return undefined;
      }
      return {
        kind: 'host_privileged_files',
        when: event.when as string,
        stripped,
        unstripped,
        rootOwned,
        unlisted,
        paths: (paths as string[]).slice(0, MAX_NOTICE_PATHS),
        incomplete,
        hint: event.hint as string,
      };
    }
    default:
      return undefined;
  }
}

/** A stable identity for a notice: its fields, in a fixed order. */
export function sessionNoticeKey(notice: SessionNoticeEvent): string {
  return JSON.stringify(Object.entries(notice).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function newEntry(notice: SessionNoticeEvent): SessionNoticeEntry {
  return { key: sessionNoticeKey(notice), notice, dismissed: false };
}

function capped(entries: readonly SessionNoticeEntry[]): readonly SessionNoticeEntry[] {
  return entries.length > MAX_SESSION_NOTICES ? entries.slice(entries.length - MAX_SESSION_NOTICES) : entries;
}

/** `existing` with the notices it does not hold yet appended (a pushed `session.diagnostic`). */
export function addSessionNotices(
  existing: readonly SessionNoticeEntry[] | undefined,
  incoming: readonly SessionNoticeEvent[],
): readonly SessionNoticeEntry[] {
  const entries = [...(existing ?? [])];
  const keys = new Set(entries.map((entry) => entry.key));
  for (const notice of incoming) {
    const entry = newEntry(notice);
    if (keys.has(entry.key)) continue;
    keys.add(entry.key);
    entries.push(entry);
  }
  return capped(entries);
}

/**
 * The notices of a session's diagnostic log (oldest first) merged with the
 * ones already held: log order first, then notices the log did not have
 * (pushed meanwhile). A notice the user dismissed stays dismissed.
 */
export function seedSessionNotices(
  existing: readonly SessionNoticeEntry[] | undefined,
  logged: readonly SessionNoticeEvent[],
): readonly SessionNoticeEntry[] {
  const held = new Map((existing ?? []).map((entry) => [entry.key, entry]));
  const entries: SessionNoticeEntry[] = [];
  const keys = new Set<string>();
  for (const notice of logged) {
    const entry = newEntry(notice);
    if (keys.has(entry.key)) continue;
    keys.add(entry.key);
    entries.push(held.get(entry.key) ?? entry);
  }
  for (const entry of existing ?? []) {
    if (!keys.has(entry.key)) entries.push(entry);
  }
  return capped(entries);
}

/** `entries` with the notice `key` marked dismissed. */
export function dismissSessionNoticeEntry(
  entries: readonly SessionNoticeEntry[],
  key: string,
): readonly SessionNoticeEntry[] {
  return entries.map((entry) => (entry.key === key ? { ...entry, dismissed: true } : entry));
}

/** What tells two sessions under one label apart: when each was created, and what kind it is. */
type SessionIdentity = Pick<SessionDto, 'createdAt' | 'source'>;

/** Whether `a` and `b` describe the same session (a label alone does not say it across daemon restarts). */
export function isSameSession(a: SessionIdentity, b: SessionIdentity): boolean {
  return a.createdAt === b.createdAt && a.source.kind === b.source.kind;
}

/**
 * The notices still to show after a fresh session list (`sessions.list`, read
 * after every reconnect) replaced `previous` with `current`: the lists of
 * sessions that are gone (their `session.ended` was missed while the client
 * was disconnected) and of labels that now name another session (the daemon
 * restarted) are dropped, so no session shows notices another one reported.
 * Undefined when every list is kept.
 */
export function retainSessionNotices(
  notices: ReadonlyMap<number, readonly SessionNoticeEntry[]>,
  previous: ReadonlyMap<number, SessionIdentity>,
  current: ReadonlyMap<number, SessionIdentity>,
): Map<number, readonly SessionNoticeEntry[]> | undefined {
  let kept: Map<number, readonly SessionNoticeEntry[]> | undefined;
  for (const label of notices.keys()) {
    const before = previous.get(label);
    const now = current.get(label);
    if (before !== undefined && now !== undefined && isSameSession(before, now)) continue;
    kept ??= new Map(notices);
    kept.delete(label);
  }
  return kept;
}

/** "1 thing" / "2 things". */
function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * How the session view shows a notice: a one-line title and a detail text
 * (line feeds kept). Both hold server- or agent-chosen text; render them
 * with SafeText.
 */
export function describeSessionNotice(notice: SessionNoticeEvent): { title: string; detail: string } {
  switch (notice.kind) {
    case 'annotation_drift':
      return {
        title: `Tool annotations of "${notice.serverName}" are out of date`,
        detail: `${notice.message}\n${notice.hint}`,
      };
    case 'mcp_server_unavailable':
      return {
        title: `MCP server "${notice.serverName}" is unavailable`,
        detail: `Its tools cannot be used in this session: ${notice.reason}`,
      };
    case 'host_model_fallback':
      return { title: 'A host model has no credentials', detail: notice.message };
    case 'policy_stale':
      return { title: 'The compiled policy may be stale', detail: notice.message };
    case 'host_privileged_files': {
      const found: string[] = [];
      if (notice.unstripped > 0) {
        found.push(
          count(
            notice.unstripped,
            'setuid/setgid file IronCurtain could not neutralize',
            'setuid/setgid files IronCurtain could not neutralize',
          ),
        );
      }
      if (notice.rootOwned > 0) found.push(count(notice.rootOwned, 'root-owned entry', 'root-owned entries'));
      if (notice.stripped > 0) {
        found.push(
          count(
            notice.stripped,
            'file whose setuid/setgid bits were removed',
            'files whose setuid/setgid bits were removed',
          ),
        );
      }
      if (notice.unlisted > 0) found.push(`${notice.unlisted} more not listed`);
      return {
        title: `Setuid/setgid or root-owned files in the agent's host mounts (${notice.when})`,
        detail: [
          `${found.join(', ')}${notice.incomplete ? ' (the scan was incomplete)' : ''}.`,
          ...notice.paths,
          notice.hint,
        ].join('\n'),
      };
    }
  }
}
