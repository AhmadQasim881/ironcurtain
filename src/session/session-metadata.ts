/**
 * Persistence for session metadata (persona, workspace, policyDir).
 *
 * Written once when a session is created; read back on --resume so
 * the session continues with the same settings.
 */

import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, linkSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { getSessionMetadataPath } from '../config/paths.js';
import { readUntrustedRegularFile, writeStableJsonAtomic } from '../hardened-fs.js';
import { SessionError } from '../types/errors.js';
import { errorMessage } from '../utils/error-message.js';
import type { SessionMetadata, SessionMode } from './types.js';

/** The `agent` recorded for a builtin (Code Mode) session. */
const BUILTIN_AGENT_NAME = 'builtin';

/**
 * A recorded agent name (`builtin`, `claude-code`, ...): a plain slug, so a
 * damaged metadata file cannot put control sequences into a terminal message.
 */
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The agent name recorded in session metadata for a session `mode`. */
export function agentNameForMode(mode: SessionMode | undefined): string {
  return mode?.kind === 'docker' ? mode.agent : BUILTIN_AGENT_NAME;
}

/**
 * Writes session metadata to an explicit path. Primary API used by
 * borrow-mode callers (e.g., workflow per-state dirs) that don't live
 * under `{home}/sessions/{sessionId}/`.
 *
 * No-ops if the file already exists (idempotent for retried session
 * creation). The record appears complete or not at all: it is written and
 * flushed under a temporary name, then hard-linked to its name, which fails
 * on existence (keeping the record already there) rather than
 * stat-then-write (TOCTOU-safe). A crash mid-write therefore never leaves a
 * truncated record, which a resume would refuse
 * ({@link loadResumeSessionMetadata}).
 */
export function saveSessionMetadataTo(path: string, metadata: SessionMetadata): void {
  const directory = dirname(path);
  const temporary = resolve(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(temporary, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return;
    }
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Writes session metadata for a session ID. Thin wrapper around
 * `saveSessionMetadataTo` that derives the path from the session ID.
 */
export function saveSessionMetadata(sessionId: string, metadata: SessionMetadata): void {
  saveSessionMetadataTo(getSessionMetadataPath(sessionId), metadata);
}

/**
 * Merge fields learned after initial session creation, then atomically replace
 * the file while preserving {@link saveSessionMetadata}'s create-once API.
 * Session setup is the single writer; this is not a concurrent merge primitive.
 */
export function updateSessionMetadata(
  sessionId: string,
  update: Partial<Omit<SessionMetadata, 'createdAt'>>,
): SessionMetadata {
  const path = getSessionMetadataPath(sessionId);
  const existing = loadSessionMetadataFromPath(path);
  if (existing === undefined) throw new Error(`cannot update missing or invalid session metadata: ${path}`);
  const merged: SessionMetadata = { ...existing, ...update };
  writeStableJsonAtomic(path, merged);
  return merged;
}

/**
 * Reads session metadata from an explicit path. Used by callers (e.g. workflow
 * per-state metadata under workflow-runs) that don't live under the standard
 * sessions directory layout. Returns undefined for missing files or invalid JSON.
 * A resume reads through {@link loadResumeSessionMetadata} instead.
 */
export function loadSessionMetadataFromPath(path: string): SessionMetadata | undefined {
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as SessionMetadata;
  } catch {
    return undefined;
  }
}

/**
 * Reads session metadata for a session ID. Thin wrapper that derives the path
 * from the session ID. Graceful for old sessions created before metadata
 * persistence was added, and for a file it cannot use: for display and
 * defaults only, never for what a resumed session restores (see
 * {@link loadResumeSessionMetadata}).
 */
export function loadSessionMetadata(sessionId: string): SessionMetadata | undefined {
  return loadSessionMetadataFromPath(getSessionMetadataPath(sessionId));
}

/** The largest session-metadata.json a resume reads; a record is a few kilobytes. */
const MAX_RESUME_METADATA_BYTES = 1024 * 1024;

/**
 * Fields a resume restores, or decides on, that hold a name or a path when
 * present. `agent` is checked by {@link findResumeAgentConflict} and
 * `dockerWorkload` refuses the resume whatever it holds.
 */
const RESUME_STRING_FIELDS = [
  'persona',
  'workspacePath',
  'providerProfileName',
  'policyDir',
  'taskPolicyDir',
  'agentConversationId',
] as const;

/**
 * Reads the metadata of a session being resumed (`--resume`), failing closed.
 *
 * A missing file is a session created before metadata was recorded: the
 * result is `undefined`, and the session resumes as before. A file that is
 * there but cannot be used throws instead: one that is not a regular file
 * (a symbolic link is not followed), cannot be read, is too large, is not
 * valid JSON (a truncated or hand-damaged write), is not a JSON object, or
 * records a restored field with a value of the wrong type (an empty or
 * `null` persona, policy directory or task scope would read as "none").
 * Resuming without what it records would drop the session's persona,
 * workspace, policy directory, task scope and `disableAutoApprove`, and run
 * the session under the global policy, the default sandbox and the
 * auto-approver: wider than it ran.
 *
 * @throws {SessionError} with code SESSION_INIT_FAILED naming the file.
 * @throws {Error} for a session ID that is not a path-safe slug.
 */
export function loadResumeSessionMetadata(sessionId: string): SessionMetadata | undefined {
  const path = getSessionMetadataPath(sessionId);
  let bytes: Buffer;
  try {
    bytes = readUntrustedRegularFile(path, { maxBytes: MAX_RESUME_METADATA_BYTES }).bytes;
  } catch (error) {
    const problem = unreadableMetadataProblem(error);
    if (problem === undefined) return undefined;
    throw unusableResumeMetadata(sessionId, path, problem);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf-8')) as unknown;
  } catch {
    throw unusableResumeMetadata(sessionId, path, 'is not valid JSON');
  }
  const problem = resumeMetadataProblem(parsed);
  if (problem !== undefined) throw unusableResumeMetadata(sessionId, path, problem);
  return parsed as SessionMetadata;
}

/** Why the metadata file cannot be read, or `undefined` when there is none. */
function unreadableMetadataProblem(error: unknown): string | undefined {
  // The hardened reader's discriminant (UntrustedFileErrorCode).
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'NOT_FOUND':
      return undefined;
    case 'SYMLINK':
      return 'is a symbolic link';
    case 'NOT_REGULAR_FILE':
      return 'is not a regular file';
    case 'TOO_LARGE':
      return `is larger than ${MAX_RESUME_METADATA_BYTES} bytes`;
    default: {
      const cause = error instanceof Error ? error.cause : undefined;
      const errno =
        cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
      return `cannot be read (${errno ?? errorMessage(error)})`;
    }
  }
}

/** What makes a parsed record unusable for a resume, or `undefined` when nothing does. */
function resumeMetadataProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'is not a JSON object';
  const record = value as Record<string, unknown>;
  for (const field of RESUME_STRING_FIELDS) {
    const fieldValue = record[field];
    if (fieldValue !== undefined && (typeof fieldValue !== 'string' || fieldValue === '')) {
      return `is invalid: "${field}" is not a non-empty string`;
    }
  }
  if (record.disableAutoApprove !== undefined && typeof record.disableAutoApprove !== 'boolean') {
    return 'is invalid: "disableAutoApprove" is not true or false';
  }
  return undefined;
}

function unusableResumeMetadata(sessionId: string, path: string, problem: string): SessionError {
  return new SessionError(
    `Cannot resume session "${sessionId}": its session metadata (${path}) ${problem}. ` +
      "The session's persona, policy and task scope cannot be restored without it; fix the file, or move it " +
      'aside to resume without them.',
    'SESSION_INIT_FAILED',
  );
}

/**
 * The persona a session runs with. On resume that is the persona recorded
 * when the session was created (a `--persona` flag is ignored then, as the
 * session factory restores it from metadata); otherwise it is the requested
 * one. Code that must agree with the factory, such as the CLI's memory
 * auto-save decision, uses this so a resumed persona session keeps its scope.
 */
export function resolveSessionPersona(
  resumeSessionId: string | undefined,
  requestedPersona: string | undefined,
): string | undefined {
  if (!resumeSessionId) return requestedPersona;
  try {
    return loadSessionMetadata(resumeSessionId)?.persona;
  } catch {
    // An invalid session ID: creating the session reports it properly.
    return undefined;
  }
}

/**
 * The agent a session is resumed with: the `--agent` the user gave, or else
 * the agent recorded when the session was created, so that
 * `ironcurtain start --resume <id>` continues a builtin session as builtin
 * (restoring its conversation) even when the configured default is container
 * mode. `undefined` (choose the default mode) for a new session, or for a
 * resumed one that recorded no agent.
 */
export function resolveResumeAgent(
  resumeSessionId: string | undefined,
  requestedAgent: string | undefined,
): string | undefined {
  if (requestedAgent !== undefined || !resumeSessionId) return requestedAgent;
  let recorded: unknown;
  try {
    recorded = loadSessionMetadata(resumeSessionId)?.agent;
  } catch {
    // An invalid session ID: creating the session reports it properly.
    return undefined;
  }
  return typeof recorded === 'string' && AGENT_NAME_PATTERN.test(recorded) ? recorded : undefined;
}

/**
 * Why `metadata`'s session cannot be resumed in `mode`, or `undefined` when
 * it can. A session resumes on the side of the builtin/container boundary it
 * ran on: a builtin session's conversation (messages.jsonl) is restored only
 * on the builtin side, so a container resume of it would silently drop the
 * conversation; a builtin resume of a container session would run without
 * that session's conversation. (Both sides claim the session directory, see
 * session-lock.ts, so neither runs beside a live process of the other.)
 * Switching between container agents is not checked here. Sessions that
 * recorded no agent (created before it was recorded) resume as before.
 */
export function findResumeAgentConflict(metadata: SessionMetadata, mode: SessionMode | undefined): string | undefined {
  const recorded: unknown = metadata.agent;
  if (recorded === undefined) return undefined;
  if (typeof recorded !== 'string' || !AGENT_NAME_PATTERN.test(recorded)) {
    return 'its session metadata records an unrecognized agent';
  }
  const requested = agentNameForMode(mode);
  if ((recorded === BUILTIN_AGENT_NAME) === (requested === BUILTIN_AGENT_NAME)) return undefined;
  return `it ran with the ${recorded} agent, not ${requested}; resume it without --agent or with --agent ${recorded}`;
}
