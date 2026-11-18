/**
 * Structural policy rules for repositories host git acts on.
 *
 * The git MCP server runs host `git` in the directory the agent names, and
 * git executes configuration it finds there: a `.git` gitfile or `commondir`
 * that redirects to another repository, `core.worktree` pointing elsewhere,
 * `include`/`includeIf`, filter/diff/merge drivers, hooks, `core.fsmonitor`,
 * credential helpers. Sandbox containment of the `path` argument says nothing
 * about any of that, and in Code Mode the filesystem server lets the agent
 * write those files. The git backend's hardened environment
 * (`git-backend-env.ts`) pins every fixed-name key that runs a program and
 * disables hooks; this module supplies the PolicyEngine with the rules that
 * cover what an environment cannot:
 *
 * - {@link hasGitInternalsSegment}: a write or delete whose path has a `.git`
 *   component (the directory, a gitfile, `.git/config`, `.git/hooks/*`,
 *   `.git/info/*`, `commondir`, nested repositories included) is configuration
 *   for host git, not data, and escalates even inside the sandbox
 *   ({@link STRUCTURAL_GIT_INTERNALS_ESCALATE}). Reads are not affected.
 * - {@link inspectRepositoryForPolicy}: before host git runs in a repository,
 *   its layout and config are inspected statically (`inspectRepoConfig`, no
 *   git process, includes never followed). A redirect that leaves the sandbox,
 *   `core.worktree` outside it, an include, a driver, a configuration-defined
 *   hook (`hook.<name>.*`), an alternates file, a symbolic link inside the git
 *   directory that leaves the sandbox (git writes refs, reflogs, objects and
 *   `COMMIT_EDITMSG` through it) or an uninspectable file escalates
 *   ({@link STRUCTURAL_GIT_REPOSITORY_ESCALATE}) with a fixed-vocabulary
 *   reason. Fixed-name command keys and hook scripts are left to the hardened
 *   environment, network keys to the remote resolution.
 * - {@link withLocalGitSourceReads}: a git remote argument that names a local
 *   repository (an absolute path, a `~` path or a `file://` URL, whatever its
 *   host) is a filesystem read of that path. The evaluation view gains a
 *   synthetic read-path argument holding the path git opens, so the protected-
 *   path check, sandbox containment and compiled read-path rules judge it,
 *   while the original argument keeps its URL role for the compiled rules and
 *   the domain gate (git looks a configured remote up by the argument's exact
 *   spelling before treating it as a path). A remote that a configured remote
 *   or a URL rewrite turns into a local path is checked against the protected
 *   paths by the engine and otherwise escalates as unverifiable.
 *
 * Both escalations name repository state the agent can change after the
 * decision, so {@link requiresPerCallApproval} keeps them out of the approval
 * whitelist: each such call is approved on its own.
 *
 * The inspection is advisory and racy by nature (in Docker Agent Mode the
 * agent writes the bind-mounted repository directly). It is defense in depth
 * next to the hardened environment and OS containment, never the only
 * boundary.
 */

import type { ToolAnnotation } from '../pipeline/types.js';
import {
  GIT_DIR_WALK_LIMIT_DETAIL,
  findRepoRoot,
  inspectRepoConfig,
  type InspectRepoConfigOptions,
  type RepoConfigFinding,
  type RepoConfigInspection,
} from '../security/git-hardening.js';
import {
  PathResolutionError,
  getRoleDefinition,
  isWithinDirectory,
  type ArgumentRole,
} from '../types/argument-roles.js';
import { argumentValues, ownArgument } from './argument-values.js';
import { parseLocalGitSource } from './git-remote-resolution.js';
import type { EvaluationResult } from './policy-types.js';
import { foldPathForComparison } from './protected-paths.js';

// ---------------------------------------------------------------------------
// Rule names
// ---------------------------------------------------------------------------

/** Structural escalation: a write or delete inside a `.git` directory (or of a gitfile). */
export const STRUCTURAL_GIT_INTERNALS_ESCALATE = 'structural-git-internals-escalate';

/** Structural escalation: host git would run in a repository whose layout or config cannot be trusted. */
export const STRUCTURAL_GIT_REPOSITORY_ESCALATE = 'structural-git-repository-escalate';

export const GIT_INTERNALS_ESCALATE_REASON =
  'Writing or deleting inside a .git directory changes configuration that host git executes ' +
  'and requires human approval';

/**
 * True for an escalation that must be approved call by call: it names
 * repository state (a `.git` entry, a repository's config or layout) that the
 * agent can change after an approval, so no whitelist pattern may discharge
 * a later call on its strength.
 */
export function requiresPerCallApproval(result: Pick<EvaluationResult, 'decision' | 'rule'>): boolean {
  return (
    result.decision === 'escalate' &&
    (result.rule === STRUCTURAL_GIT_INTERNALS_ESCALATE || result.rule === STRUCTURAL_GIT_REPOSITORY_ESCALATE)
  );
}

// ---------------------------------------------------------------------------
// .git internals
// ---------------------------------------------------------------------------

/** Path roles whose use on a `.git` path escalates. Reads of `.git` contents are ordinary reads. */
export const GIT_INTERNALS_ROLES: ReadonlySet<ArgumentRole> = new Set(['write-path', 'delete-path']);

/**
 * True when a canonical path has a `.git` component: the git directory
 * itself, a gitfile named `.git`, or anything below a `.git` directory at any
 * depth (nested repositories included). Components are compared after
 * {@link foldPathForComparison}, so `.GIT` on a case-insensitive volume and
 * spellings with default-ignorable code points count too; over-matching only
 * escalates more. `.gitignore`, `.gitattributes` and `.github` do not match.
 */
export function hasGitInternalsSegment(canonicalPath: string): boolean {
  return foldPathForComparison(canonicalPath).split('/').includes('.git');
}

// ---------------------------------------------------------------------------
// Local git sources as reads
// ---------------------------------------------------------------------------

/**
 * Suffix of the synthetic argument {@link withLocalGitSourceReads} adds for a
 * local git source. It contains a NUL, so it is never the name of an
 * annotated argument, and the pipeline denies any argument the annotation
 * does not list before evaluation; an agent cannot supply or shadow it.
 */
export const LOCAL_GIT_SOURCE_ARG_SUFFIX = '\u0000local-git-source';

export interface EvaluationView {
  readonly args: Record<string, unknown>;
  readonly annotation: ToolAnnotation;
}

/**
 * The filesystem paths of the local git sources among the values of `value`
 * (see `argumentValues`: a string, the strings of an array, or every string
 * inside a structured value, which the engine also escalates), recognized in
 * the spelling the transport receives: the `git-remote-url` canonicalization
 * runs first, as it does in `prepareToolArgs` and in
 * `resolveUrlForDomainCheck`, so a `FILE:///srv/repo` that reaches git as
 * `file:///srv/repo` is a local source here too. The domain gate reads the
 * same values and leaves local sources to this view, so the two cannot
 * disagree about a value.
 */
function localSourcePaths(value: unknown): string[] {
  const canonicalize = getRoleDefinition('git-remote-url').canonicalize;
  const paths: string[] = [];
  for (const item of argumentValues(value).values) {
    const source = parseLocalGitSource(canonicalize(item));
    if (source === undefined) continue;
    if (source.kind === 'unresolvable') {
      throw new PathResolutionError(`Cannot resolve the local git source: ${source.reason}`);
    }
    paths.push(source.path);
  }
  return paths;
}

/**
 * The evaluation view of a call whose git remote arguments may name local
 * repositories: for every `git-remote-url` argument whose value (or array
 * element, or a string inside a structured value) {@link parseLocalGitSource}
 * recognizes, a synthetic `read-path` argument holding the filesystem path
 * git would open is added (a string for a string argument, an array
 * otherwise). The original argument is left untouched, URL role included.
 * Returns the inputs themselves when nothing was added.
 *
 * Throws `PathResolutionError` when a local source's path cannot be
 * established safely (a `file://` URL without a path, or one with an encoded
 * NUL or a control character in its decoded path); the engine denies the call.
 */
export function withLocalGitSourceReads(args: Record<string, unknown>, annotation: ToolAnnotation): EvaluationView {
  let viewArgs: Record<string, unknown> | undefined;
  let viewRoles: Record<string, ArgumentRole[]> | undefined;
  for (const [argName, roles] of Object.entries(annotation.args)) {
    if (!roles.includes('git-remote-url')) continue;
    const value = ownArgument(args, argName);
    const paths = localSourcePaths(value);
    if (paths.length === 0) continue;
    viewArgs ??= { ...args };
    viewRoles ??= { ...annotation.args };
    const syntheticName = `${argName}${LOCAL_GIT_SOURCE_ARG_SUFFIX}`;
    viewArgs[syntheticName] = typeof value === 'string' ? paths[0] : paths;
    viewRoles[syntheticName] = ['read-path'];
  }
  if (viewArgs === undefined || viewRoles === undefined) return { args, annotation };
  return { args: viewArgs, annotation: { ...annotation, args: viewRoles } };
}

// ---------------------------------------------------------------------------
// Repository inspection
// ---------------------------------------------------------------------------

/**
 * Outcomes of {@link inspectRepositoryForPolicy} already computed during one
 * evaluation, keyed by repository and by whether the path was inside the
 * sandbox. Create one per evaluation: the repository can change between calls.
 */
export type RepositoryInspections = Map<string, string | undefined>;

/** At most this many distinct problems are named in one reason; the rest are counted. */
const MAX_PROBLEMS_IN_REASON = 3;

function isEqualOrInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/** `section.*.name` for a key with a subsection (agent-chosen, so never shown), `section.name` otherwise. */
function describeFindingKey(finding: RepoConfigFinding): string {
  const key = finding.key ?? '';
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first < 0) return key;
  return last > first ? `${key.slice(0, first)}.*.${key.slice(last + 1)}` : key;
}

/** A configuration-defined hook: `hook.<name>.command`, `hook.<name>.event`, ... */
function isConfiguredHook(finding: RepoConfigFinding): boolean {
  return finding.key?.startsWith('hook.') === true;
}

/** True when a path-valued finding resolves inside `sandboxRoot` (canonicalized; false when it cannot be resolved). */
function resolvesInside(target: string | undefined, sandboxRoot: string): boolean {
  if (target === undefined) return false;
  try {
    return isWithinDirectory(target, sandboxRoot);
  } catch {
    return false;
  }
}

/**
 * Inspects the repository git would use for a command run at `canonicalPath`
 * and returns why host git must not run there without a human, or undefined
 * when nothing was found.
 *
 * `sandboxRoot` is the canonical sandbox directory, if any. For a path inside
 * it, repository discovery stops at the sandbox root (as the git backend's
 * `GIT_CEILING_DIRECTORIES` makes git itself stop) and redirects are followed
 * only to a target inside the sandbox; a redirect, `core.worktree` or a
 * symbolic link inside the git directory that leaves the sandbox escalates.
 * For a path outside the sandbox (judged by compiled rules), any redirect,
 * `core.worktree` or symbolic link inside the git directory escalates, since
 * nothing outside the repository's own directory was approved.
 *
 * Reported problems are fixed phrases plus a config key with its agent-chosen
 * subsection elided, so nothing from the repository is echoed to the agent or
 * the approver.
 *
 * `inspected` memoizes the outcome per repository for one evaluation: a call
 * that names many paths in one repository has its git directory walked once,
 * not once per path (the walk examines up to 50,000 entries).
 */
export function inspectRepositoryForPolicy(
  canonicalPath: string,
  sandboxRoot: string | undefined,
  inspected?: RepositoryInspections,
): string | undefined {
  const inside = sandboxRoot !== undefined && isEqualOrInside(canonicalPath, sandboxRoot);
  // Hook scripts are disabled by the hardened environment (core.hooksPath),
  // so the hooks directory is not listed: this runs on every git call, and
  // an agent could fill that directory with entries.
  const options: InspectRepoConfigOptions = inside
    ? { stopAt: sandboxRoot, followRedirectsWithin: sandboxRoot, inspectHooks: false }
    : { inspectHooks: false };
  let key: string | undefined;
  let inspection: RepoConfigInspection;
  try {
    const repoRoot = findRepoRoot(canonicalPath, options.stopAt);
    if (repoRoot !== undefined) {
      // The outcome depends only on the repository and on the options, which
      // depend only on whether the path is inside the sandbox.
      key = `${inside ? 'inside' : 'outside'}\u0000${repoRoot}`;
      if (inspected?.has(key) === true) return inspected.get(key);
    }
    inspection = inspectRepoConfig(repoRoot ?? canonicalPath, options);
  } catch {
    // inspectRepoConfig reports what it cannot read as findings; anything it
    // throws is unexpected, and the call fails closed to a human.
    const reason = untrustedRepositoryReason(['the repository could not be inspected']);
    if (key !== undefined) inspected?.set(key, reason);
    return reason;
  }

  const problems = new Set<string>();
  for (const finding of inspection.findings) {
    switch (finding.kind) {
      case 'submodule':
        problems.add('it has submodule metadata or configuration whose child repositories are not inspected');
        break;
      case 'git-dir-symlink':
      case 'gitfile':
        if (inspection.gitDir === undefined) {
          problems.add(
            inside
              ? 'its .git redirects to a git directory outside the sandbox, or to one that cannot be read'
              : 'its .git is a redirect (a gitfile or a symbolic link) rather than a git directory',
          );
        }
        break;
      case 'commondir':
        if (inspection.commonDir === undefined) {
          problems.add(
            inside
              ? 'its commondir redirects outside the sandbox, or to a directory that cannot be read'
              : 'its git directory redirects to another through a commondir file',
          );
        }
        break;
      case 'worktree':
        if (!inside || !resolvesInside(finding.resolvedPath, sandboxRoot)) {
          problems.add(
            inside ? 'core.worktree points outside the sandbox' : 'core.worktree points the work tree elsewhere',
          );
        }
        break;
      case 'include':
        problems.add('its config uses include or includeIf, which this policy cannot inspect');
        break;
      case 'driver':
        problems.add(`its config defines ${describeFindingKey(finding)}, a driver that runs a program`);
        break;
      case 'alternates':
        problems.add('it borrows objects from another repository (objects/info/alternates)');
        break;
      case 'internal-symlink':
        // Git creates, rewrites and appends files through the link (refs,
        // reflog lines carrying commit subjects, objects, COMMIT_EDITMSG).
        problems.add(
          inside
            ? 'its git directory has a symbolic link that leads outside the sandbox, or that cannot be resolved'
            : 'its git directory has a symbolic link, through which git would write elsewhere',
        );
        break;
      case 'unreadable':
        problems.add(
          finding.detail === GIT_DIR_WALK_LIMIT_DETAIL
            ? 'its git directory has too many entries to inspect'
            : 'a configuration file could not be inspected safely',
        );
        break;
      case 'command':
        // Configuration-defined hooks (`hook.<name>.command`, in git versions
        // that run them) are named by the repository, so no fixed-name
        // override pins them, and core.hooksPath is not documented to cover
        // them.
        if (isConfiguredHook(finding)) problems.add('its config defines a hook (hook.*), which runs a program');
        // Fixed-name command keys are pinned by the hardened git environment
        // (git-backend-env.ts); the other agent-named ones (remote helpers and
        // upload/receive-pack, archive and trailer commands, aliases, tools)
        // are not run by any operation the git server performs, or need a
        // transport the environment refuses.
        break;
      case 'hook':
      case 'network':
        // Hook scripts are disabled by the hardened environment; network keys
        // are handled by the remote resolution (git-remote-resolution.ts).
        break;
    }
  }
  const reason = problems.size === 0 ? undefined : untrustedRepositoryReason([...problems]);
  if (key !== undefined) inspected?.set(key, reason);
  return reason;
}

/** The escalation reason for an untrusted repository, naming a bounded number of fixed-phrase problems. */
function untrustedRepositoryReason(problems: readonly string[]): string {
  const named = problems.slice(0, MAX_PROBLEMS_IN_REASON);
  const rest = problems.length - named.length;
  const detail = rest > 0 ? `${named.join('; ')}; and ${rest} more` : named.join('; ');
  return `Host git would run in a repository whose configuration cannot be trusted (${detail}); human approval is required`;
}
