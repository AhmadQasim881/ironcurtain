/**
 * Notices a session emits for the user to see.
 *
 * Start-up notices are emitted while the session initializes, before the
 * first turn: annotation drift (`annotation-drift-diagnostics.ts`), MCP
 * servers that could not be started, host-model features running differently
 * for lack of credentials (`host-model-roles.ts`), and a compiled policy that
 * may be stale (`config/policy-provenance-check.ts`). Host-mount findings
 * (`host_privileged_files`, from `docker/host-mount-privilege-scan.ts`) come
 * after agent turns and at session end. Shared by the builtin and Docker
 * agent sessions, the CLI, web and Signal transports, cron runs, workflows
 * and the PTY session, so every surface reports them the same way.
 */

import type { UnavailableMcpServer } from '../sandbox/index.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { formatAnnotationDriftNotice, type AnnotationDriftDiagnostic } from './annotation-drift-diagnostics.js';
import type { HostModelNotice } from './host-model-roles.js';
import type { DiagnosticEvent } from './types.js';

export type McpServerUnavailableDiagnostic = Extract<DiagnosticEvent, { kind: 'mcp_server_unavailable' }>;
export type HostModelFallbackDiagnostic = Extract<DiagnosticEvent, { kind: 'host_model_fallback' }>;
export type StalePolicyDiagnostic = Extract<DiagnosticEvent, { kind: 'policy_stale' }>;
export type HostPrivilegedFilesDiagnostic = Extract<DiagnosticEvent, { kind: 'host_privileged_files' }>;

/** The diagnostics a session emits while it initializes. */
export type StartupNotice =
  AnnotationDriftDiagnostic | McpServerUnavailableDiagnostic | HostModelFallbackDiagnostic | StalePolicyDiagnostic;

/** Every diagnostic a transport shows the user as a notice: the start-up notices and host-mount findings. */
export type SessionNotice = StartupNotice | HostPrivilegedFilesDiagnostic;

/** Longest error text a notice repeats (one line of a relay's error). */
const MAX_REASON_CHARS = 300;

/** Longest stale-policy warning a notice carries (a few reasons and the rebuild command). */
export const MAX_POLICY_WARNING_CHARS = 2000;

/** Longest path a host-mount notice repeats. */
const MAX_NOTICE_PATH_CHARS = 512;

export function isStartupNotice(event: DiagnosticEvent): event is StartupNotice {
  return (
    event.kind === 'annotation_drift' ||
    event.kind === 'mcp_server_unavailable' ||
    event.kind === 'host_model_fallback' ||
    event.kind === 'policy_stale'
  );
}

export function isSessionNotice(event: DiagnosticEvent): event is SessionNotice {
  return isStartupNotice(event) || event.kind === 'host_privileged_files';
}

export function unavailableServerDiagnostics(
  servers: readonly UnavailableMcpServer[],
): McpServerUnavailableDiagnostic[] {
  return servers.map(({ serverName, reason }) => ({ kind: 'mcp_server_unavailable', serverName, reason }));
}

export function hostModelDiagnostics(notices: readonly HostModelNotice[]): HostModelFallbackDiagnostic[] {
  return notices.map(({ role, action, message }) => ({ kind: 'host_model_fallback', role, action, message }));
}

/**
 * The stale-policy warnings `buildSessionConfig` collected while it loaded
 * the session's policy (each the multi-line text the provenance check
 * reports), as notices. The text names paths and server names, so it is
 * rendered as display text with its line feeds kept, and bounded.
 */
export function policyWarningDiagnostics(warnings: readonly string[]): StalePolicyDiagnostic[] {
  return warnings.map((warning) => ({
    kind: 'policy_stale',
    message: toDisplayText(warning.trimEnd(), { multiline: true, maxLength: MAX_POLICY_WARNING_CHARS }),
  }));
}

/** Continuation lines of a multi-line notice line up under its first line's text. */
function indentContinuation(text: string, indent: string): string {
  return text.split('\n').join(`\n${indent}`);
}

/** "1 thing" / "2 things". */
function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * The host-mount findings as terminal lines: the counts, the first paths
 * (agent-chosen names, so display text) and what to do.
 */
function formatHostPrivilegedFilesNotice(event: HostPrivilegedFilesDiagnostic): string {
  const found: string[] = [];
  if (event.unstripped > 0) {
    found.push(
      count(
        event.unstripped,
        'setuid/setgid file it could not neutralize',
        'setuid/setgid files it could not neutralize',
      ),
    );
  }
  if (event.rootOwned > 0) found.push(count(event.rootOwned, 'root-owned entry', 'root-owned entries'));
  if (event.stripped > 0) {
    found.push(
      count(event.stripped, 'file whose setuid/setgid bits it removed', 'files whose setuid/setgid bits it removed'),
    );
  }
  if (event.unlisted > 0) found.push(`${event.unlisted} more not listed`);
  const lines = [
    `  [host-files] Warning (${toDisplayText(event.when)}): IronCurtain found setuid/setgid or root-owned files in ` +
      `the agent container's host mounts: ${found.join(', ')}${event.incomplete ? ' (the scan was incomplete)' : ''}.`,
    ...event.paths.map((path) => `    ${toDisplayText(path, { maxLength: MAX_NOTICE_PATH_CHARS })}`),
    `    ${toDisplayText(event.hint)}`,
  ];
  return lines.join('\n');
}

/**
 * A start-up notice as terminal lines (no trailing newline, no color).
 * Server names and error text can come from an MCP server, and a host-model
 * message names model IDs that a workflow definition or `--model` can
 * supply (a loose model ID may be any text), so all of them are rendered as
 * display text. A stale-policy warning keeps its line feeds (one per reason).
 */
export function formatStartupNotice(event: StartupNotice): string {
  switch (event.kind) {
    case 'annotation_drift':
      return formatAnnotationDriftNotice(event);
    case 'mcp_server_unavailable':
      return (
        `  [mcp] Warning: MCP server "${toDisplayText(event.serverName)}" is unavailable in this session; ` +
        `its tools cannot be used: ${toDisplayText(event.reason, { maxLength: MAX_REASON_CHARS })}`
      );
    case 'host_model_fallback':
      return `  [models] Warning: ${toDisplayText(event.message)}`;
    case 'policy_stale':
      return indentContinuation(
        `  [policy] ${toDisplayText(event.message, { multiline: true, maxLength: MAX_POLICY_WARNING_CHARS })}`,
        '  ',
      );
  }
}

/** Any session notice as terminal lines (no trailing newline, no color). */
export function formatSessionNotice(event: SessionNotice): string {
  return event.kind === 'host_privileged_files' ? formatHostPrivilegedFilesNotice(event) : formatStartupNotice(event);
}
