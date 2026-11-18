/**
 * Ephemeral approval whitelist -- session-scoped in-memory store
 * of approval patterns extracted from user-approved escalations.
 *
 * Security invariants:
 * - Only converts escalate -> allow, never overrides deny.
 * - A pattern discharges a later escalation only when it has a constraint
 *   for every role that escalated that call (`escalatedRoles`), the call has
 *   a value for every role the pattern constrains, and each of those values
 *   satisfies one of the pattern's constraints for its role. A role the
 *   pattern does not mention was never shown to the approver: approving a
 *   move from the sandbox into ~/Documents does not approve moving a file
 *   there from anywhere else.
 * - Candidates come narrowest first. The first one, which `/approve+`
 *   selects (`DEFAULT_WHITELIST_OPTIONS`), binds every path to the approved
 *   path exactly: approving a read of ~/notes/a.txt approves that file and
 *   nothing beside it. The directory-wide candidate, which widens every path
 *   to its parent directory and everything below it, is an explicit second
 *   choice (`scope: 'directory'`), and is not offered at all when that
 *   directory is the filesystem root, the home directory or one of its
 *   ancestors, or holds or lies inside a credential or startup directory
 *   (~/.ssh, ~/.aws, ~/.gnupg, ~/.config, ~/.local, their macOS
 *   counterparts under ~/Library, relocated XDG base directories, the host
 *   credential stores), compared in every spelling that can name them.
 * - A candidate is offered only when it discharges the call it came from.
 * - Path constraints store the canonical path the approver was shown and
 *   compare a later call's canonical path with it; the stored path is never
 *   resolved again, so swapping an approved path for a symlink afterwards
 *   ends the match instead of following it.
 * - URL constraints compare destinations, resolved by the resolver the
 *   policy engine uses (`resolveUrlForDomainCheck`) when the pattern is
 *   built and again at every match. A named git remote is bound to where it
 *   connects (`origin -> github.com/owner/repo`), never to its name, so
 *   re-pointing the remote ends the match, and a remote that cannot be
 *   resolved yields no pattern.
 * - Entries are never persisted to disk.
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { ArgumentRole } from '../types/argument-roles.js';
import { resolveRealPath, getRoleDefinition } from '../types/argument-roles.js';
import { computeCredentialStoreProtectedPaths } from '../config/credential-stores.js';
import { foldPathForComparison } from './protected-paths.js';
import {
  describeGitRemoteDestination,
  displayableDomain,
  isPlainGitRemoteName,
  resolveUrlForDomainCheck,
  type DomainCheckContext,
  type DomainCheckTarget,
} from './domain-utils.js';
import { extractAnnotatedPaths, collectDistinctRoles } from './policy-engine.js';
import type { ToolAnnotation } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Unique identifier for a whitelist entry, for audit trail linkage. */
export type WhitelistEntryId = string & { readonly __brand: 'WhitelistEntryId' };

/**
 * A constraint on a single argument role's value.
 * Discriminated union by `kind`.
 */
export type WhitelistConstraint =
  | {
      readonly kind: 'path';
      readonly role: ArgumentRole;
      /** Canonical (resolved real) path of the approved value; only this path matches. */
      readonly path: string;
    }
  | {
      readonly kind: 'directory';
      readonly role: ArgumentRole;
      /**
       * Canonical (resolved real) path of the approved value's parent
       * directory; it and everything below it match, recursively.
       */
      readonly directory: string;
    }
  | {
      readonly kind: 'domain';
      readonly role: ArgumentRole;
      /**
       * The one destination the approved value reached, as
       * `resolveUrlForDomainCheck` reports it: a host (`api.example.com`)
       * or, for git remotes, `host/owner/repo` (`github.com/owner/repo`).
       */
      readonly domain: string;
    }
  | {
      readonly kind: 'exact';
      readonly role: ArgumentRole;
      /** Exact value to match (case-insensitive for identifier roles). */
      readonly value: string;
    };

/**
 * A whitelist pattern extracted from an approved escalation.
 * Matches future calls to the same server/tool with arguments
 * satisfying all constraints.
 */
export interface WhitelistPattern {
  readonly id: WhitelistEntryId;
  readonly serverName: string;
  readonly toolName: string;
  readonly constraints: readonly WhitelistConstraint[];
  /** ISO 8601 timestamp when the pattern was created. */
  readonly createdAt: string;
  /** The escalation ID that produced this pattern (for audit linkage). */
  readonly sourceEscalationId: string;
  /** The original escalation reason (preserved for audit). */
  readonly originalReason: string;
  /** Human-readable description of the pattern. */
  readonly description: string;
}

/**
 * How far a candidate reaches. `exact` binds every path to the approved path
 * (identifiers to the approved values, URLs to the one approved
 * destination); `directory` widens every path to its parent directory and
 * everything below it.
 */
export type WhitelistScope = 'exact' | 'directory';

/**
 * JSON-serializable candidate description for IPC.
 * Included in the escalation request file so the user sees
 * exactly what will be whitelisted.
 */
export interface WhitelistCandidateIpc {
  /** Human-readable summary, e.g. "Allow filesystem/write_file write-path /home/user/Documents/report.md" */
  readonly description: string;
  /**
   * `exact` on the first candidate, the one `/approve+` selects;
   * `directory` on the directory-wide one (`/approve+dir`, the mux picker's
   * `W`), which is never first. Absent on a candidate built elsewhere: it
   * then counts as not directory-wide.
   */
  readonly scope?: WhitelistScope;
  /**
   * Unambiguous identity of the pattern (server, tool and every constraint,
   * JSON-encoded; see {@link whitelistPatternKey}). Two candidates with the
   * same key describe the same pattern, which the description alone cannot
   * promise: a directory name can contain the label separator. The approval
   * front-ends group pending escalations by the key of their first candidate
   * (see `escalation-groups.ts`).
   */
  readonly patternKey?: string;
}

/**
 * The identity of a whitelist pattern: its server, tool and constraints as
 * one JSON value, constraints in a fixed order. Equal keys mean equal
 * patterns; agent-chosen text inside a value cannot make two different
 * patterns collide, because each value is a separate JSON string.
 */
export function whitelistPatternKey(
  serverName: string,
  toolName: string,
  constraints: readonly WhitelistConstraint[],
): string {
  const encoded = constraints
    .map((c): [string, string, string] => {
      switch (c.kind) {
        case 'path':
          return [c.kind, c.role, c.path];
        case 'directory':
          return [c.kind, c.role, c.directory];
        case 'domain':
          return [c.kind, c.role, c.domain];
        case 'exact':
          return [c.kind, c.role, c.value];
      }
    })
    .sort((a, b) => compareTuples(a, b));
  return JSON.stringify([serverName, toolName, encoded]);
}

function compareTuples(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/**
 * What the policy engine reported about an escalated call, plus what the
 * shared URL resolver needs. Passed to both `extractWhitelistCandidates`
 * and `ApprovalWhitelist.match`.
 */
export interface WhitelistContext extends DomainCheckContext {
  /**
   * The roles that escalated the call (`EvaluationResult.escalatedRoles`).
   * Undefined or empty means unknown: every resource role of the tool then
   * counts as escalated.
   */
  readonly escalatedRoles: readonly ArgumentRole[] | undefined;
}

/**
 * Result of a whitelist match check.
 */
export type WhitelistMatchResult =
  | { readonly matched: false }
  | { readonly matched: true; readonly patternId: WhitelistEntryId; readonly pattern: WhitelistPattern };

/**
 * Whitelist options for `/approve+`: the first candidate, which binds every
 * path exactly (`scope: 'exact'`). The directory-wide candidate is selected
 * only explicitly, by its index ({@link directoryCandidateIndex}).
 */
export const DEFAULT_WHITELIST_OPTIONS = { whitelistSelection: 0 } as const;

/**
 * Index of the directory-wide candidate (`scope: 'directory'`) among an
 * escalation's candidates, which is what `/approve+dir` selects, or
 * undefined when the escalation offers none: the call has no path, or the
 * widened directory was refused. Index 0 never counts: it is what
 * `/approve+` selects.
 */
export function directoryCandidateIndex(candidates: readonly WhitelistCandidateIpc[] | undefined): number | undefined {
  const index = candidates?.findIndex((candidate) => candidate.scope === 'directory') ?? -1;
  return index > 0 ? index : undefined;
}

/**
 * The ephemeral whitelist store. Session-scoped, in-memory only.
 */
export interface ApprovalWhitelist {
  /**
   * Adds a pattern to the whitelist.
   * Returns the pattern ID for audit linkage.
   */
  add(pattern: Omit<WhitelistPattern, 'id'>): WhitelistEntryId;

  /**
   * Checks whether an escalated tool call matches any whitelist pattern.
   * Returns the matching pattern if found.
   *
   * `args` are the arguments the policy engine evaluated (see
   * `evaluatedArguments` in policy-engine.ts) and `context.escalatedRoles`
   * the roles that escalated the call. A pattern matches only when it has a
   * constraint for every escalated role and, for every role it constrains,
   * each of the call's values satisfies one of those constraints.
   */
  match(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    annotation: ToolAnnotation,
    context: WhitelistContext,
  ): WhitelistMatchResult;

  /** Returns all active patterns (for diagnostics/testing). */
  entries(): readonly WhitelistPattern[];

  /** Number of active patterns. */
  readonly size: number;
}

// ---------------------------------------------------------------------------
// History-rewriting roles excluded from path generalization
// ---------------------------------------------------------------------------

const HISTORY_REWRITING_ROLES: ReadonlySet<ArgumentRole> = new Set(['write-history', 'delete-history']);

// ---------------------------------------------------------------------------
// Directories a directory-wide candidate may never reach
// ---------------------------------------------------------------------------

/**
 * Home-directory entries a directory-wide candidate may neither contain nor
 * lie inside: keys and cloud credentials (.ssh, .aws, .gnupg), application
 * tokens and code that runs at login (.config: gh, gcloud, autostart,
 * systemd user units), and programs on the user's PATH and further login
 * hooks (.local: bin, share/systemd, share/keyrings). macOS keeps the same
 * things under ~/Library: per-user launchd jobs that run at login
 * (LaunchAgents), keychains, and application data, settings and tokens
 * (Application Support, Preferences, Containers, Group Containers,
 * Cookies). The rest of ~/Library (iCloud Drive's Mobile Documents,
 * CloudStorage) holds the user's documents and is not refused. Every entry
 * is refused on every platform: where one does not exist, refusing it only
 * refuses more. The relocated XDG base directories
 * ({@link RELOCATABLE_XDG_DIRECTORIES}) and the host credential stores
 * (`computeCredentialStoreProtectedPaths`, every store whatever the user
 * opted out of) are added to these.
 */
const SENSITIVE_HOME_ENTRIES: readonly (readonly string[])[] = [
  ['.ssh'],
  ['.aws'],
  ['.gnupg'],
  ['.config'],
  ['.local'],
  ['Library', 'LaunchAgents'],
  ['Library', 'Keychains'],
  ['Library', 'Application Support'],
  ['Library', 'Preferences'],
  ['Library', 'Containers'],
  ['Library', 'Group Containers'],
  ['Library', 'Cookies'],
];

/**
 * XDG base directories that hold what ~/.config and ~/.local hold by
 * default, and that the environment may move anywhere. Only absolute values
 * count: the XDG specification says to ignore relative ones.
 */
const RELOCATABLE_XDG_DIRECTORIES = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'] as const;

/**
 * Whether `path` is `directory` or lies below it, compared as plain strings
 * on whole components: neither is resolved again.
 */
function isCanonicalWithin(path: string, directory: string): boolean {
  if (path === directory) return true;
  return path.startsWith(directory.endsWith('/') ? directory : `${directory}/`);
}

/**
 * The keys a refused location is compared by: its spelled (normalized) and
 * its canonical form, each folded (`foldPathForComparison`).
 */
function refusalKeys(path: string): string[] {
  return [...new Set([resolve(path), resolveRealPath(path)].map(foldPathForComparison))];
}

/** The locations a directory-wide candidate must not reach, as {@link refusalKeys}. */
interface RefusedLocations {
  /** The home directory: it and its ancestors are refused. */
  readonly home: readonly string[];
  /** Refused, with everything that contains them and everything inside them. */
  readonly sensitive: readonly string[];
}

function refusedLocations(): RefusedLocations {
  const home = homedir();
  const sensitive = [
    ...SENSITIVE_HOME_ENTRIES.map((parts) => join(home, ...parts)),
    ...RELOCATABLE_XDG_DIRECTORIES.map((name) => process.env[name]).filter(
      (value): value is string => value !== undefined && isAbsolute(value),
    ),
    ...computeCredentialStoreProtectedPaths(),
  ];
  return { home: refusalKeys(home), sensitive: sensitive.flatMap(refusalKeys) };
}

/**
 * The refusal check of one directory-wide (recursive) candidate: whether
 * the widened canonical `directory` must not be offered. It is refused when
 * it is the filesystem root, the home directory or one of its ancestors (a
 * grant there covers ~/.bashrc and every dotfile), or contains or lies
 * inside a sensitive home entry, a relocated XDG base directory or a
 * credential store. The refused locations are computed once, on first use;
 * when they cannot be computed, every directory is refused.
 *
 * A deny-side check, so both sides are folded (`foldPathForComparison`, as
 * protected paths are): on a case- or normalization-insensitive volume
 * (macOS) `~/.CONFIG`, or `.config` with a zero-width character in it, can
 * name ~/.config. A directory that does not exist yet keeps the caller's
 * spelling in its canonical form, so without folding a recursive grant over
 * ~/.config could be offered under another spelling before ~/.config is
 * first created. Folding over-matches on case-sensitive volumes, which only
 * refuses more.
 */
function directoryWideRefusal(): (directory: string) => boolean {
  let refused: RefusedLocations | 'unknown' | undefined;
  return (directory) => {
    if (directory === '/') return true;
    if (refused === undefined) {
      try {
        refused = refusedLocations();
      } catch {
        refused = 'unknown';
      }
    }
    if (refused === 'unknown') return true;
    const key = foldPathForComparison(directory);
    return (
      refused.home.some((home) => isCanonicalWithin(home, key)) ||
      refused.sensitive.some((path) => isCanonicalWithin(path, key) || isCanonicalWithin(key, path))
    );
  };
}

/**
 * Whether a directory-wide (recursive) grant over canonical `directory`
 * would be refused here (see {@link directoryWideRefusal}). For the other
 * place a recursive grant over a directory can come from: the constitution
 * amendments proposed from the approval history
 * (`src/audit/amendment-proposals.ts`), which withhold such a directory.
 */
export function isDirectoryWideGrantRefused(directory: string): boolean {
  return directoryWideRefusal()(directory);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The roles a pattern must constrain to discharge an escalation with this context. */
function rolesToCover(context: WhitelistContext, annotation: ToolAnnotation): readonly ArgumentRole[] {
  const escalated = context.escalatedRoles;
  return escalated !== undefined && escalated.length > 0 ? escalated : collectDistinctRoles(annotation);
}

type UrlTargetResolver = (value: string, role: ArgumentRole) => DomainCheckTarget;

/**
 * Resolves the URL-role values of one call (`args` supplies the git
 * repository path) with the policy engine's resolver, once per value for
 * the life of the returned function: one extraction or one match.
 */
function createUrlTargetResolver(args: Record<string, unknown>, context: DomainCheckContext): UrlTargetResolver {
  const cache = new Map<string, DomainCheckTarget>();
  return (value, role) => {
    const key = `${role}\u0000${value}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let target: DomainCheckTarget;
    try {
      target = resolveUrlForDomainCheck(value, role, args, {
        allowedDirectory: context.allowedDirectory,
        loadTrustedGitConfig: context.loadTrustedGitConfig,
      });
    } catch {
      target = { status: 'unverifiable', reason: 'the destination could not be resolved', domains: [] };
    }
    cache.set(key, target);
    return target;
  };
}

/** The canonical form of a path value, or undefined when it cannot be resolved (it then matches nothing). */
function canonicalPath(value: string): string | undefined {
  try {
    return resolveRealPath(value);
  } catch {
    return undefined;
  }
}

/**
 * `canonicalPath(value)`, computed on first use and then kept: a value is
 * canonicalized once however many constraints it is compared with (an exact
 * pattern for a multi-file call holds one constraint per file), and every
 * comparison sees the same canonical form.
 */
function lazyCanonicalPath(value: string): () => string | undefined {
  let computed = false;
  let canonical: string | undefined;
  return () => {
    if (!computed) {
      canonical = canonicalPath(value);
      computed = true;
    }
    return canonical;
  };
}

// ---------------------------------------------------------------------------
// Constraint matching
// ---------------------------------------------------------------------------

/**
 * Whether one value of the constraint's role satisfies the constraint.
 * `canonical` yields the value's canonical path (see {@link lazyCanonicalPath}).
 */
function valueSatisfies(
  constraint: WhitelistConstraint,
  value: string,
  canonical: () => string | undefined,
  resolveTarget: UrlTargetResolver,
): boolean {
  switch (constraint.kind) {
    case 'path': {
      const path = canonical();
      return path !== undefined && path === constraint.path;
    }
    case 'directory': {
      const path = canonical();
      return path !== undefined && isCanonicalWithin(path, constraint.directory);
    }
    case 'domain': {
      // Every destination of the value must be the approved one. An
      // unverifiable target (a remote name that cannot be resolved, a
      // repository outside the sandbox, a config that redirects the remote)
      // never matches.
      const target = resolveTarget(value, constraint.role);
      return (
        target.status === 'resolved' &&
        target.domains.length > 0 &&
        target.domains.every((domain) => domain === constraint.domain)
      );
    }
    case 'exact':
      return value.toLowerCase() === constraint.value.toLowerCase();
  }
}

/**
 * Whether the constraints discharge an escalation that `required` names:
 * each required role is constrained, and for every constrained role the call
 * has a value and each of its values satisfies one of that role's
 * constraints. Constraints of one role are alternatives (the approved call's
 * values for that role: `read_multiple_files` across two directories gives
 * its read-path one constraint per file); constraints of different roles all
 * apply. An empty constraint list discharges nothing.
 */
function constraintsDischarge(
  required: readonly ArgumentRole[],
  constraints: readonly WhitelistConstraint[],
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  resolveTarget: UrlTargetResolver,
): boolean {
  if (constraints.length === 0) return false;
  // Coverage: every role that escalated this call needs a constraint of its
  // own. The policy allowed every other role of the call; a role that
  // escalated and that the pattern does not mention was never approved.
  if (!required.every((role) => constraints.some((c) => c.role === role))) return false;

  const byRole = new Map<ArgumentRole, WhitelistConstraint[]>();
  for (const constraint of constraints) {
    const forRole = byRole.get(constraint.role);
    if (forRole) forRole.push(constraint);
    else byRole.set(constraint.role, [constraint]);
  }
  for (const [role, forRole] of byRole) {
    // A constrained role still applies when it did not escalate this time.
    const values = extractAnnotatedPaths(args, annotation, [role]);
    if (values.length === 0) return false;
    for (const value of values) {
      const canonical = lazyCanonicalPath(value);
      if (!forRole.some((constraint) => valueSatisfies(constraint, value, canonical, resolveTarget))) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pattern extraction
// ---------------------------------------------------------------------------

/**
 * Extracts whitelist candidate patterns from an escalated tool call.
 *
 * Generates constraints for the role(s) that caused the escalation
 * (`context.escalatedRoles`), or for every resource-identifier role when
 * those are unknown. Every value of every such role must yield a
 * constraint; otherwise no candidate is offered and each such call has to
 * be approved on its own. That covers history-rewriting roles, a role that
 * escalated without a value, a URL whose destination cannot be verified (an
 * unresolvable remote name) or is more than one destination, a destination
 * that cannot be shown in full, and an identifier role with more than one
 * value (an issue in one repository with a parent in another: the roles are
 * matched independently, so a pattern naming both would also approve the
 * owner of one with the repository of the other). `args` are the arguments
 * the policy engine evaluated (see `evaluatedArguments`).
 *
 * Candidates, narrowest first:
 * 1. `exact` (always, when any candidate is offered): every path bound to
 *    its canonical form. `/approve+` selects it.
 * 2. `directory` (only when the call has a path): every path widened to its
 *    parent directory, recursively, and labelled so. Not offered when a
 *    widened directory is refused (see `directoryWideRefusal`).
 * A candidate that would not discharge the call it came from is dropped; if
 * that is the exact one, nothing is offered, so the first candidate is
 * always the exact one.
 *
 * Returns both:
 * - WhitelistPattern[] (full patterns, stored in proxy memory -- without id, added on whitelist.add())
 * - WhitelistCandidateIpc[] (descriptions, serialized into IPC file), index for index
 */
export function extractWhitelistCandidates(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  context: WhitelistContext,
  escalationId: string,
  escalationReason: string,
): { patterns: Array<Omit<WhitelistPattern, 'id'>>; ipcs: WhitelistCandidateIpc[] } {
  const none = { patterns: [], ipcs: [] };
  const required = rolesToCover(context, annotation);
  const resolveTarget = createUrlTargetResolver(args, context);

  // Zero-constraint patterns would blanket-approve ALL future calls to the tool.
  // This happens when a tool's arguments only have 'none' roles (no resource
  // identifiers). Refuse to offer whitelisting in this case — each invocation
  // must be individually approved. The same holds when an escalated value
  // cannot be generalized (buildConstraints returns undefined).
  const exact = buildConstraints(required, args, annotation, resolveTarget, { scope: 'exact' });
  if (exact === undefined || exact.length === 0) return none;

  const scoped: Array<{ readonly scope: WhitelistScope; readonly built: readonly BuiltConstraint[] }> = [
    { scope: 'exact', built: exact },
  ];
  if (exact.some((b) => b.constraint.kind === 'path')) {
    const directory = buildConstraints(required, args, annotation, resolveTarget, {
      scope: 'directory',
      refuses: directoryWideRefusal(),
    });
    if (directory !== undefined) scoped.push({ scope: 'directory', built: directory });
  }

  const createdAt = new Date().toISOString();
  const patterns: Array<Omit<WhitelistPattern, 'id'>> = [];
  const ipcs: WhitelistCandidateIpc[] = [];
  for (const { scope, built } of scoped) {
    const constraints = built.map((b) => b.constraint);
    // A candidate that cannot discharge the very call it came from would
    // only mislead the approver. Without the exact one, offer none: the
    // first candidate must be the exact one, since that is what /approve+ selects.
    if (!constraintsDischarge(required, constraints, args, annotation, resolveTarget)) {
      if (scope === 'exact') return none;
      continue;
    }
    const description = `Allow ${serverName}/${toolName} ${built.map((b) => b.label).join(', ')}`;
    patterns.push({
      serverName,
      toolName,
      constraints,
      createdAt,
      sourceEscalationId: escalationId,
      originalReason: escalationReason,
      description,
    });
    ipcs.push({ description, scope, patternKey: whitelistPatternKey(serverName, toolName, constraints) });
  }
  return { patterns, ipcs };
}

/** A constraint and how it reads in the candidate's description. */
interface BuiltConstraint {
  readonly constraint: WhitelistConstraint;
  readonly label: string;
}

/**
 * How one candidate generalizes path values: `exact` binds each to its
 * canonical path; `directory` widens each to its parent directory, unless
 * `refuses` (the candidate's {@link directoryWideRefusal}) refuses that
 * directory.
 */
type PathGeneralization =
  { readonly scope: 'exact' } | { readonly scope: 'directory'; readonly refuses: (directory: string) => boolean };

/**
 * Builds the constraints of one candidate for every value of each role, or
 * returns undefined when a role has no value or a value cannot be
 * generalized at this scope. match() requires a constraint for every
 * escalated role, so a candidate that left one out could never discharge
 * the call it came from, and offering it would only mislead the approver.
 */
function buildConstraints(
  roles: readonly ArgumentRole[],
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  resolveTarget: UrlTargetResolver,
  paths: PathGeneralization,
): BuiltConstraint[] | undefined {
  const built: BuiltConstraint[] = [];
  const seen = new Set<string>();

  for (const role of roles) {
    const values = extractAnnotatedPaths(args, annotation, [role]);
    if (values.length === 0) return undefined;

    let distinct = 0;
    for (const value of values) {
      const next = buildConstraintForRole(role, value, resolveTarget, paths);
      if (next === undefined) return undefined;

      // Deduplicate constraints with identical kind/role/value
      const key = constraintKey(next.constraint);
      if (seen.has(key)) continue;
      seen.add(key);
      built.push(next);
      distinct++;
    }
    // Identifier roles are matched independently of each other: a pattern
    // with two owners and two repositories would also approve the owner of
    // one with the repository of the other. Such a call is approved on its own.
    if (distinct > 1 && getRoleDefinition(role).category === 'identifier') return undefined;
  }

  return built;
}

/** Returns a stable string key for deduplication. */
function constraintKey(c: WhitelistConstraint): string {
  switch (c.kind) {
    case 'path':
      return `path:${c.role}:${c.path}`;
    case 'directory':
      return `dir:${c.role}:${c.directory}`;
    case 'domain':
      return `dom:${c.role}:${c.domain}`;
    case 'exact':
      return `exact:${c.role}:${c.value}`;
  }
}

/**
 * Builds a single constraint for a role and value, applying the
 * generalization of the role's category (`paths` for path roles). Returns
 * undefined when the value cannot be generalized.
 */
function buildConstraintForRole(
  role: ArgumentRole,
  value: string,
  resolveTarget: UrlTargetResolver,
  paths: PathGeneralization,
): BuiltConstraint | undefined {
  switch (getRoleDefinition(role).category) {
    case 'path': {
      // History-rewriting roles are never whitelisted: each reset, rebase
      // or ref deletion is approved on its own.
      if (HISTORY_REWRITING_ROLES.has(role)) return undefined;
      // The canonical path the policy engine evaluated (resolveRealPath
      // follows symlinks of every existing component). A path created after
      // approval through a new symlink resolves elsewhere and stops matching.
      const canonical = canonicalPath(value);
      if (canonical === undefined) return undefined;
      if (paths.scope === 'exact') {
        return { constraint: { kind: 'path', role, path: canonical }, label: `${role} ${canonical}` };
      }
      const directory = dirname(canonical);
      if (paths.refuses(directory)) return undefined;
      return {
        constraint: { kind: 'directory', role, directory },
        label: `${role} within ${directory} (recursive)`,
      };
    }
    case 'url': {
      // The destination, resolved the way the policy engine resolves it. Only
      // one verified destination, shown in full, can be approved: the approver
      // must see exactly what later calls will be allowed to reach.
      const target = resolveTarget(value, role);
      if (target.status !== 'resolved' || target.domains.length !== 1) return undefined;
      const domain = target.domains[0];
      if (displayableDomain(domain) !== domain) return undefined;
      const label =
        role === 'git-remote-url' && isPlainGitRemoteName(value)
          ? `${role} ${describeGitRemoteDestination(value, target)}`
          : `${role} domain ${domain}`;
      return { constraint: { kind: 'domain', role, domain }, label };
    }
    case 'identifier': {
      const exact = value.toLowerCase();
      return { constraint: { kind: 'exact', role, value: exact }, label: `${role}=${exact}` };
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory approval whitelist.
 */
export function createApprovalWhitelist(): ApprovalWhitelist {
  const patterns: WhitelistPattern[] = [];

  return {
    add(patternData: Omit<WhitelistPattern, 'id'>): WhitelistEntryId {
      // Defense-in-depth: reject zero-constraint patterns that would blanket-approve
      // all calls to a tool. extractWhitelistCandidates() already prevents this, but
      // guard here too so a future caller can't reintroduce the vulnerability.
      if (patternData.constraints.length === 0) {
        throw new Error(
          `Refusing to add zero-constraint whitelist pattern for ${patternData.serverName}/${patternData.toolName}`,
        );
      }
      const id = uuidv4() as WhitelistEntryId;
      const pattern: WhitelistPattern = { ...patternData, id };
      patterns.push(pattern);
      return id;
    },

    match(
      serverName: string,
      toolName: string,
      args: Record<string, unknown>,
      annotation: ToolAnnotation,
      context: WhitelistContext,
    ): WhitelistMatchResult {
      const required = rolesToCover(context, annotation);
      const resolveTarget = createUrlTargetResolver(args, context);

      for (const pattern of patterns) {
        if (pattern.serverName !== serverName) continue;
        if (pattern.toolName !== toolName) continue;
        if (constraintsDischarge(required, pattern.constraints, args, annotation, resolveTarget)) {
          return { matched: true, patternId: pattern.id, pattern };
        }
      }
      return { matched: false };
    },

    entries(): readonly WhitelistPattern[] {
      return patterns;
    },

    get size(): number {
      return patterns.length;
    },
  };
}
