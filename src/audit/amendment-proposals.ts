/**
 * Constitution amendments proposed from repeated human approvals.
 *
 * Reads the approval history (`approval-history.ts`) and, for every pattern
 * a human approved at least `threshold` times under one constitution scope,
 * proposes one English policy statement that would let the agent make that
 * call without asking. The proposal is only a suggestion: the
 * customize-policy flows show it as a diff and apply it only when the user
 * explicitly accepts it, and it takes effect only after the constitution is
 * recompiled.
 *
 * Deterministic and LLM-free. The statement is built from a fixed template
 * and the pattern's constraint values, and a value is used only when it can
 * be quoted unambiguously: a directory without control, format or quote
 * characters, a destination that `displayableDomain` shows as is, an
 * identifier of plain characters. A pattern whose values fail that check, or
 * whose directory is the filesystem root, contains the user's home directory
 * or lies in or around a credential or startup directory (the directories
 * the approval whitelist never widens a grant to), is withheld rather than
 * proposed. Those values reached the history through calls the agent chose,
 * so no LLM phrases a statement around them and they are never shown
 * unescaped. A statement the user accepts is an ordinary constitution line
 * from then on, compiled like any other.
 */

import { homedir } from 'node:os';
import { isAbsolute, parse, relative, resolve } from 'node:path';
import { displayableDomain } from '../trusted-process/domain-utils.js';
import { resolveRealPath, type ArgumentRole } from '../types/argument-roles.js';
import { isDirectoryWideGrantRefused } from '../trusted-process/approval-whitelist.js';
import {
  readApprovalHistory,
  type ApprovalConstraint,
  type ApprovalHistoryLocation,
  type ApprovalHistoryRecord,
  type ApprovalRecord,
  type ApprovalScope,
} from './approval-history.js';

/** Human approvals of one pattern needed before an amendment is proposed. */
export const DEFAULT_PROPOSAL_THRESHOLD = 3;

/** A proposed constitution amendment. */
export interface AmendmentProposal {
  readonly scope: ApprovalScope;
  /** Pattern key (see `approvalPatternKey`). */
  readonly key: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly constraints: readonly ApprovalConstraint[];
  /** Rules that escalated the approved calls. */
  readonly rules: readonly string[];
  /** The whitelist description of the pattern (agent-influenced: escape before display). */
  readonly description: string;
  /** Human approvals counted for this proposal (since its last dismissal). */
  readonly approvals: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** The policy statement to add to the constitution (no bullet). */
  readonly amendment: string;
}

/** Why a pattern that reached the threshold is not proposed. */
export type WithheldReason =
  /** A value cannot be quoted unambiguously in a policy statement. */
  | 'unsafe-value'
  /**
   * A directory is the filesystem root, contains the home directory, or lies
   * in or around a credential or startup directory (`~/.ssh`, `~/.config`,
   * a credential store, ...; see `isDirectoryWideGrantRefused`).
   */
  | 'too-broad';

/** A pattern that reached the threshold but is not proposed. */
export interface WithheldPattern {
  readonly scope: ApprovalScope;
  readonly key: string;
  readonly description: string;
  readonly approvals: number;
  readonly reason: WithheldReason;
}

export interface DeriveProposalsOptions {
  /** Approvals needed for a proposal (default {@link DEFAULT_PROPOSAL_THRESHOLD}). */
  readonly threshold?: number;
  /** Only patterns approved under this scope (default: every scope). */
  readonly scope?: ApprovalScope;
  /** Home directory for the breadth check (default `os.homedir()`). */
  readonly homeDir?: string;
}

export interface DerivedProposals {
  readonly proposals: readonly AmendmentProposal[];
  readonly withheld: readonly WithheldPattern[];
}

interface PatternTally {
  /** The newest counted approval; undefined until one counts. */
  latest: ApprovalRecord | undefined;
  approvals: number;
  firstSeen: string;
  lastSeen: string;
  rules: Set<string>;
  /** Time of the last dismissal; approvals at or before it do not count. */
  dismissedAt: number;
}

/**
 * Derives the pending proposals from history records (oldest first). Each
 * (scope, pattern) pair counts the approvals made after its last dismissal;
 * a pair at or above the threshold yields one proposal, or one withheld
 * entry when its statement cannot be built safely. Proposals are ordered by
 * approvals (most first), then by most recent approval.
 */
export function deriveAmendmentProposals(
  records: readonly ApprovalHistoryRecord[],
  options: DeriveProposalsOptions = {},
): DerivedProposals {
  const threshold = options.threshold ?? DEFAULT_PROPOSAL_THRESHOLD;
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new RangeError(`proposal threshold must be a positive integer: ${threshold}`);
  }
  const tallies = new Map<string, PatternTally>();
  for (const record of records) {
    if (options.scope !== undefined && record.scope !== options.scope) continue;
    const id = `${record.scope}\u0000${record.key}`;
    const at = Date.parse(record.ts);
    let tally = tallies.get(id);
    if (record.type === 'decision') {
      if (tally === undefined) {
        // A dismissal whose approvals were rotated out of the history:
        // remember when it happened, so only approvals after it count.
        tallies.set(id, { ...emptyTally(), dismissedAt: at });
      } else {
        tally.approvals = 0;
        tally.rules = new Set();
        tally.dismissedAt = Math.max(tally.dismissedAt, at);
      }
      continue;
    }
    if (tally === undefined) {
      tally = emptyTally();
      tallies.set(id, tally);
    }
    if (at <= tally.dismissedAt) continue;
    tally.latest = record;
    if (tally.approvals === 0) tally.firstSeen = record.ts;
    tally.approvals += 1;
    tally.lastSeen = record.ts;
    tally.rules.add(record.rule);
  }

  const proposals: AmendmentProposal[] = [];
  const withheld: WithheldPattern[] = [];
  const home = resolve(options.homeDir ?? homedir());
  for (const tally of tallies.values()) {
    const record = tally.latest;
    if (record === undefined || tally.approvals < threshold) continue;
    const built = buildAmendment(record, home);
    if (typeof built !== 'string') {
      withheld.push({
        scope: record.scope,
        key: record.key,
        description: record.description,
        approvals: tally.approvals,
        reason: built.reason,
      });
      continue;
    }
    proposals.push({
      scope: record.scope,
      key: record.key,
      serverName: record.serverName,
      toolName: record.toolName,
      constraints: record.constraints,
      rules: [...tally.rules].sort(),
      description: record.description,
      approvals: tally.approvals,
      firstSeen: tally.firstSeen,
      lastSeen: tally.lastSeen,
      amendment: built,
    });
  }
  proposals.sort(
    (a, b) =>
      b.approvals - a.approvals ||
      Date.parse(b.lastSeen) - Date.parse(a.lastSeen) ||
      a.scope.localeCompare(b.scope) ||
      a.key.localeCompare(b.key),
  );
  return { proposals, withheld };
}

/** A tally with nothing counted yet. */
function emptyTally(): PatternTally {
  return {
    latest: undefined,
    approvals: 0,
    firstSeen: '',
    lastSeen: '',
    rules: new Set(),
    dismissedAt: Number.NEGATIVE_INFINITY,
  };
}

/** Reads the approval history and derives the pending proposals for it. */
export function loadAmendmentProposals(
  options: DeriveProposalsOptions & ApprovalHistoryLocation = {},
): DerivedProposals {
  return deriveAmendmentProposals(readApprovalHistory(options), options);
}

// ---------------------------------------------------------------------------
// Statement construction
// ---------------------------------------------------------------------------

/** Controls, invisible code points and quote characters cannot enter a policy statement. */
const UNQUOTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}`\\"]/u;
const MAX_QUOTED_LENGTH = 1024;
const PLAIN_IDENTIFIER = /^[A-Za-z0-9._-]{1,100}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

function quote(value: string): string {
  return `\`${value}\``;
}

/** Plain-language clause per role; other roles get a generic clause by constraint kind. */
const ROLE_CLAUSES: Partial<Record<ArgumentRole, (quoted: string) => string>> = {
  'read-path': (q) => `it reads files within ${q}`,
  'write-path': (q) => `it writes files within ${q}`,
  'delete-path': (q) => `it deletes files within ${q}`,
  'fetch-url': (q) => `it fetches URLs on ${q}`,
  'git-remote-url': (q) => `it uses the git remote ${q}`,
  'github-owner': (q) => `the GitHub owner is ${q}`,
  'github-repo': (q) => `the GitHub repository is ${q}`,
};

/** True when `inner` is `outer` or below it (plain path comparison of resolved paths). */
function isWithin(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The spellings of a path to compare for breadth: as given (resolved) and, when
 * it differs, its canonical real path. Recorded directories are real paths
 * (the whitelist canonicalizes them) while `$HOME` may go through a symlink
 * (`/home -> /data/home`), and a directory may have been replaced by a link
 * since it was approved, so both spellings are checked.
 */
function pathForms(path: string): string[] {
  const resolved = resolve(path);
  let real: string;
  try {
    real = resolveRealPath(resolved);
  } catch {
    return [resolved];
  }
  return real === resolved ? [resolved] : [resolved, real];
}

/**
 * True when a directory, in any spelling, is the filesystem root or contains
 * the home directory, or is one the approval whitelist refuses a recursive
 * grant over (`isDirectoryWideGrantRefused`: the real home's ancestors, and
 * in or around ~/.ssh, ~/.aws, ~/.gnupg, ~/.config, ~/.local, their macOS
 * counterparts and the credential stores). An accepted amendment grants the
 * directory recursively and for good, so it is held to the same limits; a
 * directory that was offered when the approvals were recorded may have been
 * replaced by a link to one of them since.
 */
function isTooBroad(directory: string, homes: readonly string[]): boolean {
  return pathForms(directory).some(
    (dir) => dir === parse(dir).root || homes.some((home) => isWithin(home, dir)) || isDirectoryWideGrantRefused(dir),
  );
}

function clauseFor(constraint: ApprovalConstraint, homes: readonly string[]): string | { reason: WithheldReason } {
  let value: string;
  switch (constraint.kind) {
    case 'directory': {
      const dir = constraint.directory;
      if (!isAbsolute(dir) || dir.length > MAX_QUOTED_LENGTH || UNQUOTABLE.test(dir)) {
        return { reason: 'unsafe-value' };
      }
      if (isTooBroad(dir, homes)) return { reason: 'too-broad' };
      value = dir;
      break;
    }
    case 'domain':
      if (constraint.domain.includes('*') || displayableDomain(constraint.domain) !== constraint.domain) {
        return { reason: 'unsafe-value' };
      }
      value = constraint.domain;
      break;
    case 'exact':
      if (!PLAIN_IDENTIFIER.test(constraint.value)) return { reason: 'unsafe-value' };
      value = constraint.value;
      break;
  }
  const phrase = ROLE_CLAUSES[constraint.role];
  if (phrase !== undefined) return phrase(quote(value));
  switch (constraint.kind) {
    case 'directory':
      return `its ${constraint.role} arguments are within ${quote(value)}`;
    case 'domain':
      return `its ${constraint.role} arguments reach ${quote(value)}`;
    case 'exact':
      return `its ${constraint.role} argument is ${quote(value)}`;
  }
}

/**
 * The policy statement for an approved pattern, or why none can be built.
 * Exported for tests.
 */
export function buildAmendment(
  pattern: Pick<ApprovalRecord, 'serverName' | 'toolName' | 'constraints'>,
  home: string = homedir(),
): string | { reason: WithheldReason } {
  if (!TOOL_NAME.test(pattern.serverName) || !TOOL_NAME.test(pattern.toolName)) return { reason: 'unsafe-value' };
  if (pattern.constraints.length === 0) return { reason: 'too-broad' };
  const homes = pathForms(home);
  const clauses: string[] = [];
  for (const constraint of pattern.constraints) {
    const clause = clauseFor(constraint, homes);
    if (typeof clause !== 'string') return clause;
    clauses.push(clause);
  }
  return (
    `The agent may use the ${quote(`${pattern.serverName}/${pattern.toolName}`)} tool without asking ` +
    `for human approval when ${clauses.join(' and ')}.`
  );
}

/** Normalizes a constitution line for comparison: no bullet, no surrounding space. */
function normalizeStatement(line: string): string {
  return line.trim().replace(/^[-*]\s*/, '');
}

/** True when the constitution already holds `amendment` as one of its lines. */
export function constitutionContainsAmendment(constitution: string, amendment: string): boolean {
  const wanted = normalizeStatement(amendment);
  return constitution.split('\n').some((line) => normalizeStatement(line) === wanted);
}
