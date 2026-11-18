/**
 * Host-side approval history: the memory behind policy learning.
 *
 * The approval whitelist forgets every pattern when its session ends, so a
 * user who approves the same benign call every session keeps being asked.
 * This module keeps, across sessions, one line per escalation a HUMAN
 * approved, so that a pattern approved often enough can be offered back as
 * a constitution amendment (`amendment-proposals.ts`) for the user to accept
 * or dismiss in the customize-policy flow. Nothing here ever changes a
 * policy: a proposal becomes policy only after a human accepts the diff and
 * the constitution is recompiled.
 *
 * What is recorded, and what is not:
 *  - Only human approvals. Auto-approver decisions and whitelist matches are
 *    never reported here (see `CallToolDeps.onHumanApproval`), so neither a
 *    trickable LLM approver nor one broad whitelist entry can ratchet the
 *    constitution.
 *  - Only escalations a constitution amendment could address: the pattern
 *    must have at least one constraint, the escalating rule must be a
 *    compiled rule (not a `structural-*` invariant, which no constitution
 *    changes) and the server must not be the virtual `proxy` server
 *    (passthrough approvals stay human-only). The coordinator also leaves
 *    out escalations a session's task scope raised (`--task-scoped`).
 *  - The generalized pattern only: server, tool, the escalating rule and the
 *    whitelist candidate's constraints (a directory, a destination, an
 *    identifier) with its description. Raw argument values are never stored:
 *    for a call with paths the pipeline reports the directory-wide candidate,
 *    and an exact-path constraint (the whitelist's narrowest candidate, see
 *    {@link ApprovalConstraint}) is refused.
 *  - The constitution it applies to: the scope in effect when the human
 *    approved (`global`, `persona:<name>` or `job:<id>`).
 *
 * Storage: `$IRONCURTAIN_HOME/approval-history.jsonl` (mode 0600), outside
 * every sandbox, workspace and escalation directory. Lines are appended
 * without following links, and the file is rotated once to `.1` when it
 * reaches {@link MAX_APPROVAL_HISTORY_BYTES}, so it stays bounded. Count and
 * last-seen are derived when the file is read. Writes are best effort: a
 * failure is reported to the caller and never affects a tool call.
 */

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { getApprovalHistoryPath } from '../config/paths.js';
import { appendRegularFileNoFollow, readUntrustedRegularFile } from '../hardened-fs.js';
import { SLUG_PATTERN } from '../types/slug.js';
import { isArgumentRole } from '../types/argument-roles.js';
import type { WhitelistConstraint } from '../trusted-process/approval-whitelist.js';

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * The constitution an approval is attributed to: `global` (the user
 * constitution compiled by `compile-policy`), `persona:<name>` or
 * `job:<id>`. Names follow the persona / job slug rules.
 */
export type ApprovalScope = string & { readonly __brand: 'ApprovalScope' };

/** The global (user constitution) scope. */
export const GLOBAL_APPROVAL_SCOPE = 'global' as ApprovalScope;

/**
 * The persona name the workflow orchestrator uses for the global policy
 * (`GLOBAL_PERSONA` in `src/workflow/types.ts`, which a test pins to this
 * value). Duplicated here so the trusted process does not depend on the
 * workflow layer.
 */
const WORKFLOW_GLOBAL_PERSONA = 'global';

const SCOPE_PATTERN = /^(?:global|persona:[a-z0-9][a-z0-9_-]{0,62}|job:[a-z0-9][a-z0-9_-]{0,62})$/;

/** True for a well-formed {@link ApprovalScope}. */
export function isApprovalScope(value: unknown): value is ApprovalScope {
  return typeof value === 'string' && SCOPE_PATTERN.test(value);
}

/** The scope of a persona's constitution, or undefined for an invalid name. */
export function personaApprovalScope(name: string): ApprovalScope | undefined {
  return SLUG_PATTERN.test(name) ? (`persona:${name}` as ApprovalScope) : undefined;
}

/** The scope of a cron job's task constitution, or undefined for an invalid id. */
export function jobApprovalScope(jobId: string): ApprovalScope | undefined {
  return SLUG_PATTERN.test(jobId) ? (`job:${jobId}` as ApprovalScope) : undefined;
}

/**
 * The scope of the policy a coordinator loads for `persona` in a workflow:
 * the reserved `global` name is the global policy, anything else a persona.
 */
export function approvalScopeForPolicyPersona(persona: string): ApprovalScope | undefined {
  return persona === WORKFLOW_GLOBAL_PERSONA ? GLOBAL_APPROVAL_SCOPE : personaApprovalScope(persona);
}

/** Human-readable name of a scope, for prompts and reports. */
export function describeApprovalScope(scope: ApprovalScope): string {
  if (scope === GLOBAL_APPROVAL_SCOPE) return 'the global policy';
  const colon = scope.indexOf(':');
  const kind = scope.slice(0, colon);
  const name = scope.slice(colon + 1);
  return kind === 'persona' ? `persona "${name}"` : `job "${name}"`;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Record format version written by this module. */
export const APPROVAL_HISTORY_VERSION = 1;

/** The current file is rotated to `.1` once appending would grow it past this size. */
export const MAX_APPROVAL_HISTORY_BYTES = 4 * 1024 * 1024;

/** A single line larger than this is never written (or read back). */
const MAX_RECORD_BYTES = 16 * 1024;

/** Shape of {@link approvalPatternKey}. */
const PATTERN_KEY = /^[0-9a-f]{32}$/;

/** Descriptions are display text; longer ones are cut. */
const MAX_DESCRIPTION_CHARS = 2048;

/**
 * A constraint as the history stores it: a directory (recursive), a
 * destination or an identifier. Never an exact path (`kind: 'path'`, the
 * approval whitelist's narrowest candidate): that is the approved argument
 * value itself, which the history does not keep.
 */
export type ApprovalConstraint = Exclude<WhitelistConstraint, { readonly kind: 'path' }>;

/** The pattern a human approved: what a later identical approval must match. */
export interface ApprovalPattern {
  readonly serverName: string;
  readonly toolName: string;
  readonly constraints: readonly ApprovalConstraint[];
}

/** One escalation a human approved. */
export interface ApprovalRecord extends ApprovalPattern {
  readonly v: typeof APPROVAL_HISTORY_VERSION;
  readonly type: 'approval';
  readonly ts: string;
  readonly scope: ApprovalScope;
  /** {@link approvalPatternKey} of the pattern. */
  readonly key: string;
  /** Rule that escalated the call. */
  readonly rule: string;
  /** The whitelist candidate's description, e.g. `Allow filesystem/write_file write-path within /x`. */
  readonly description: string;
}

/**
 * What the user did with the amendment proposed for a pattern. Only a
 * dismissal is recorded: an accepted amendment is in the constitution, and
 * a proposal whose text the constitution already holds is never shown.
 */
export type ProposalDecision = 'dismissed';

/** A decision on the amendment proposed for a pattern; approvals before it no longer count. */
export interface ProposalDecisionRecord {
  readonly v: typeof APPROVAL_HISTORY_VERSION;
  readonly type: 'decision';
  readonly ts: string;
  readonly scope: ApprovalScope;
  readonly key: string;
  readonly decision: ProposalDecision;
}

export type ApprovalHistoryRecord = ApprovalRecord | ProposalDecisionRecord;

/**
 * A human approval as the pipeline reports it (see `HumanApprovalEvent`):
 * any whitelist candidate, an exact-path one included, which
 * {@link isLearnableApproval} then refuses.
 */
export interface HumanApproval {
  readonly serverName: string;
  readonly toolName: string;
  readonly constraints: readonly WhitelistConstraint[];
  readonly rule: string;
  readonly description: string;
}

/** True for a constraint the history may store (see {@link ApprovalConstraint}). */
function isApprovalConstraint(c: WhitelistConstraint): c is ApprovalConstraint {
  return c.kind !== 'path';
}

/** Stable key of a constraint, independent of the order constraints were built in. */
function constraintSortKey(c: WhitelistConstraint): string {
  switch (c.kind) {
    case 'path':
      return `path\u0000${c.role}\u0000${c.path}`;
    case 'directory':
      return `directory\u0000${c.role}\u0000${c.directory}`;
    case 'domain':
      return `domain\u0000${c.role}\u0000${c.domain}`;
    case 'exact':
      return `exact\u0000${c.role}\u0000${c.value}`;
  }
}

/**
 * Identity of an approval pattern: a SHA-256 over the server, tool and the
 * sorted constraints. Two approvals with the same key would be discharged
 * by the same whitelist pattern. Any whitelist candidate has a key, though
 * only an {@link ApprovalPattern} is ever stored.
 */
export function approvalPatternKey(pattern: Pick<HumanApproval, 'serverName' | 'toolName' | 'constraints'>): string {
  const constraints = pattern.constraints.map(constraintSortKey).sort();
  const canonical = JSON.stringify({ serverName: pattern.serverName, toolName: pattern.toolName, constraints });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Rule-name prefix of the policy engine's structural invariants, which no constitution changes. */
const STRUCTURAL_RULE_PREFIX = 'structural-';

/**
 * True when a constitution amendment could make this approval unnecessary:
 * the pattern constrains at least one argument, none of them to one exact
 * path (a raw argument value, never stored), the escalating rule is a
 * compiled rule, and the call is not a virtual proxy tool.
 */
export function isLearnableApproval(approval: HumanApproval): boolean {
  if (approval.constraints.length === 0) return false;
  if (!approval.constraints.every(isApprovalConstraint)) return false;
  if (approval.serverName === 'proxy') return false;
  if (approval.rule === '' || approval.rule.startsWith(STRUCTURAL_RULE_PREFIX)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Where to read or write the history; the default is {@link getApprovalHistoryPath}. */
export interface ApprovalHistoryLocation {
  readonly path?: string;
}

export interface RecordApprovalOptions extends ApprovalHistoryLocation {
  /** Clock seam for tests. */
  readonly now?: () => Date;
}

function isUntrustedFileCode(err: unknown, code: string): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === code;
}

/**
 * True when the file at `path` still cannot take `lineBytes` more. Another
 * process may have rotated it since our append found it full, and its own
 * append then started a fresh file: rotating that one would replace the full
 * history just moved to `.1` with a file of a line or two.
 */
function isStillFull(path: string, lineBytes: number): boolean {
  try {
    return lstatSync(path).size + lineBytes > MAX_APPROVAL_HISTORY_BYTES;
  } catch {
    return false; // Gone (rotated by someone else): the append creates a new file.
  }
}

/**
 * Appends one record without following links. Rotates the file to `.1` once
 * when it is full, then retries. Returns false (never throws) when the
 * record could not be written.
 */
function appendRecord(record: ApprovalHistoryRecord, location: ApprovalHistoryLocation): boolean {
  const path = location.path ?? getApprovalHistoryPath();
  const line = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) return false;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }
  const options = { maxBytes: MAX_APPROVAL_HISTORY_BYTES, create: true, mode: 0o600 };
  try {
    appendRegularFileNoFollow(path, line, options);
    return true;
  } catch (err) {
    if (!isUntrustedFileCode(err, 'TOO_LARGE')) return false;
  }
  if (isStillFull(path, Buffer.byteLength(line, 'utf8'))) {
    try {
      // Rotation is a rename of the directory entry, so a symlink planted at
      // the path would be moved, never followed.
      renameSync(path, `${path}.1`);
    } catch {
      // Already rotated by someone else, or not renameable: try the append anyway.
    }
  }
  try {
    appendRegularFileNoFollow(path, line, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Records one human approval under `scope` when it is learnable (see
 * {@link isLearnableApproval}). Returns whether a record was written.
 * Never throws.
 */
export function recordHumanApproval(
  scope: ApprovalScope,
  approval: HumanApproval,
  options: RecordApprovalOptions = {},
): boolean {
  if (!isApprovalScope(scope) || !isLearnableApproval(approval)) return false;
  const constraints = approval.constraints.filter(isApprovalConstraint).map(copyConstraint);
  const pattern: ApprovalPattern = { serverName: approval.serverName, toolName: approval.toolName, constraints };
  const record: ApprovalRecord = {
    v: APPROVAL_HISTORY_VERSION,
    type: 'approval',
    ts: (options.now?.() ?? new Date()).toISOString(),
    scope,
    key: approvalPatternKey(pattern),
    serverName: approval.serverName,
    toolName: approval.toolName,
    rule: approval.rule,
    constraints,
    description: approval.description.slice(0, MAX_DESCRIPTION_CHARS),
  };
  // Write only what the reader will accept back.
  if (parseApprovalHistoryRecord(JSON.parse(JSON.stringify(record))) === undefined) return false;
  return appendRecord(record, options);
}

/**
 * Records that the user dismissed the amendment proposed for `key`: only
 * approvals made after it count towards a new proposal. Returns whether it
 * was written. Never throws.
 */
export function recordProposalDismissal(
  scope: ApprovalScope,
  key: string,
  options: RecordApprovalOptions = {},
): boolean {
  if (!isApprovalScope(scope) || !PATTERN_KEY.test(key)) return false;
  const record: ProposalDecisionRecord = {
    v: APPROVAL_HISTORY_VERSION,
    type: 'decision',
    ts: (options.now?.() ?? new Date()).toISOString(),
    scope,
    key,
    decision: 'dismissed',
  };
  return appendRecord(record, options);
}

/** Copies only the fields a constraint defines, so nothing else reaches the file. */
function copyConstraint(c: ApprovalConstraint): ApprovalConstraint {
  switch (c.kind) {
    case 'directory':
      return { kind: 'directory', role: c.role, directory: c.directory };
    case 'domain':
      return { kind: 'domain', role: c.role, domain: c.domain };
    case 'exact':
      return { kind: 'exact', role: c.role, value: c.value };
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function isString(value: unknown, maxLength = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/** The form `Date.prototype.toISOString` writes (four-digit years). */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Only the ISO form this module writes. `Date.parse` alone also accepts legacy
 * forms with parenthesized comments, which could carry terminal escapes into
 * the dates the review and `audit proposals` print.
 */
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

/** One stored constraint; an exact path (`kind: 'path'`) or any other kind is malformed. */
function parseConstraint(value: unknown): ApprovalConstraint | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const c = value as Record<string, unknown>;
  if (typeof c.role !== 'string' || !isArgumentRole(c.role)) return undefined;
  const role = c.role;
  switch (c.kind) {
    case 'directory':
      return isString(c.directory) ? { kind: 'directory', role, directory: c.directory } : undefined;
    case 'domain':
      return isString(c.domain, 512) ? { kind: 'domain', role, domain: c.domain } : undefined;
    case 'exact':
      return isString(c.value, 512) ? { kind: 'exact', role, value: c.value } : undefined;
    default:
      return undefined;
  }
}

/** Validates one parsed line; anything malformed is dropped. */
export function parseApprovalHistoryRecord(value: unknown): ApprovalHistoryRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if (r.v !== APPROVAL_HISTORY_VERSION || !isTimestamp(r.ts) || !isApprovalScope(r.scope)) return undefined;
  if (typeof r.key !== 'string' || !PATTERN_KEY.test(r.key)) return undefined;
  if (r.type === 'decision') {
    if (r.decision !== 'dismissed') return undefined;
    return {
      v: APPROVAL_HISTORY_VERSION,
      type: 'decision',
      ts: r.ts,
      scope: r.scope,
      key: r.key,
      decision: r.decision,
    };
  }
  if (r.type !== 'approval') return undefined;
  if (!isString(r.serverName, 128) || !isString(r.toolName, 256) || !isString(r.rule, 512)) return undefined;
  if (typeof r.description !== 'string' || r.description.length > MAX_DESCRIPTION_CHARS) return undefined;
  if (!Array.isArray(r.constraints) || r.constraints.length === 0 || r.constraints.length > 32) return undefined;
  const constraints: ApprovalConstraint[] = [];
  for (const raw of r.constraints as unknown[]) {
    const constraint = parseConstraint(raw);
    if (constraint === undefined) return undefined;
    constraints.push(constraint);
  }
  const pattern = { serverName: r.serverName, toolName: r.toolName, constraints };
  // A line whose key does not match its own pattern was not written by us.
  if (approvalPatternKey(pattern) !== r.key) return undefined;
  return {
    v: APPROVAL_HISTORY_VERSION,
    type: 'approval',
    ts: r.ts,
    scope: r.scope,
    key: r.key,
    ...pattern,
    rule: r.rule,
    description: r.description,
  };
}

/** Reads one history file; a missing or unreadable file contributes nothing. */
function readHistoryFile(path: string): ApprovalHistoryRecord[] {
  let text: string;
  try {
    const { bytes } = readUntrustedRegularFile(path, {
      maxBytes: MAX_APPROVAL_HISTORY_BYTES + MAX_RECORD_BYTES,
      oversize: 'truncate',
    });
    text = bytes.toString('utf8');
  } catch {
    return [];
  }
  const records: ApprovalHistoryRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.length > MAX_RECORD_BYTES) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parseApprovalHistoryRecord(parsed);
    if (record !== undefined) records.push(record);
  }
  return records;
}

/**
 * Reads the whole history, oldest first (the rotated `.1` file, then the
 * current one). Malformed lines are skipped. Never throws.
 */
export function readApprovalHistory(location: ApprovalHistoryLocation = {}): ApprovalHistoryRecord[] {
  const path = location.path ?? getApprovalHistoryPath();
  return [...readHistoryFile(`${path}.1`), ...readHistoryFile(path)];
}
