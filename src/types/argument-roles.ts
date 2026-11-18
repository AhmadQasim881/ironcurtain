/**
 * ArgumentRole Registry -- Central definition of argument role semantics.
 *
 * Each role is paired with metadata describing its security semantics
 * and a normalizer function for canonicalizing argument values. This
 * eliminates scattered hardcoded role strings and enables annotation-driven
 * normalization instead of fragile heuristics.
 *
 * Roles are organized into categories that determine which structural
 * invariant applies in the policy engine:
 *   - path: filesystem path containment checks
 *   - url: domain allowlist checks
 *   - identifier: case-insensitive allowlist checks (e.g., GitHub owner)
 *   - opaque: no structural invariant (semantic meaning only)
 *
 * `isResourceIdentifier` is independent of the category: an opaque role can
 * still be a resource identifier (`github-resource-id`), which makes the
 * engine evaluate it like any other role while the approval whitelist, which
 * can only generalize paths, URLs and identifiers, offers no pattern for it.
 *
 * `outboundContent` is independent of both: it marks the roles whose values
 * leave the machine as content other people or systems can read (message
 * bodies, commit messages, URLs), which the opt-in outbound content
 * assessment checks for encoded or hidden data (see
 * src/trusted-process/assessment.ts).
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { normalizeUrl, normalizeGitUrl } from './url-normalize.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoleCategory = 'path' | 'url' | 'identifier' | 'opaque';

export type ArgumentRole =
  // Path roles -- sandbox-safe (filesystem sandbox containment auto-resolves these)
  | 'read-path'
  | 'write-path'
  | 'delete-path'
  // Path roles -- not sandbox-safe (require compiled rule evaluation even in sandbox)
  | 'write-history'
  | 'delete-history'
  // URL roles
  | 'fetch-url'
  | 'git-remote-url'
  // Destination host of MITM egress (the virtual `network` server)
  | 'egress-host'
  // Identifier roles (case-insensitive allowlist-checked identifiers)
  | 'github-owner'
  | 'github-repo'
  // Opaque resource identifier: names a GitHub resource in any repository,
  // so owner/repo constraints cannot scope it (escalate-only, never whitelisted)
  | 'github-resource-id'
  // Opaque roles (semantic meaning but not resource identifiers)
  | 'branch-name'
  | 'commit-message'
  // Google Workspace opaque roles
  | 'email-address'
  | 'email-body'
  | 'share-permission'
  // Free text published to, or sent through, an external service
  | 'outbound-text'
  // Proxy roles
  | 'proxy-domain'
  // Catch-all
  | 'none';

/**
 * How the outbound content assessment reads a role's values: `text` checks
 * the whole value, `url` the parts of a URL that carry data to its
 * destination (host labels, path segments, query and fragment).
 */
export type OutboundContentKind = 'text' | 'url';

export interface RoleDefinition {
  readonly description: string;
  readonly isResourceIdentifier: boolean;
  readonly category: RoleCategory;
  /**
   * Set on roles whose values leave the machine as content that other
   * people or systems can read: message and comment bodies, commit messages,
   * fetched URLs. The outbound content assessment checks these values (see
   * src/trusted-process/assessment.ts); other arguments are never assessed.
   */
  readonly outboundContent?: OutboundContentKind;
  /** Produce canonical form (symlink resolution, URL normalization). Security-critical. */
  readonly canonicalize: (value: string) => string;
  /**
   * Guidance for the LLM annotation prompt. Built into the prompt
   * dynamically from the registry -- no manual prompt maintenance.
   */
  readonly annotationGuidance: string;
  /**
   * When set, this role is only relevant for the named MCP servers.
   * Roles without serverNames are universal (included for all servers).
   */
  readonly serverNames?: readonly string[];
}

// ---------------------------------------------------------------------------
// Normalizer functions
// ---------------------------------------------------------------------------

/** Expands a leading `~` or `~/` to the current user's home directory. */
export function expandTilde(filePath: string): string {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return homedir() + filePath.slice(1);
  return filePath;
}

/** Discriminant carried by {@link PathResolutionError}. */
export const PATH_UNRESOLVABLE = 'PATH_UNRESOLVABLE';

/**
 * Thrown by {@link resolveRealPath} when no ancestor of a path, not even the
 * filesystem root, can be canonicalized. The policy path treats it as a deny
 * (fail closed) instead of evaluating the caller's unresolved spelling.
 * Catch it with {@link isPathResolutionError}, which checks the `code`
 * discriminant rather than `instanceof`.
 */
export class PathResolutionError extends Error {
  readonly code = PATH_UNRESOLVABLE;

  constructor(message: string) {
    super(message);
    this.name = 'PathResolutionError';
  }
}

/** True when `err` is a {@link PathResolutionError} (matched by its `code`). */
export function isPathResolutionError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === PATH_UNRESOLVABLE;
}

/**
 * Canonicalizes an existing path, throwing when it cannot be resolved.
 *
 * On macOS this is the native realpath(3), which returns the on-disk
 * spelling (letter case and Unicode form) of every component. Node's JS
 * realpath keeps the caller's spelling, so on a case- or
 * normalization-insensitive volume `~/DOWNLOADS/x` and `~/Downloads/x` would
 * otherwise reach the policy engine (and, through `canonicalize`, the MCP
 * server) as different strings. Elsewhere the JS implementation is kept: on
 * Linux glibc's realpath(3) also preserves the caller's spelling, and the
 * native binding needs /proc when Node is built against musl.
 *
 * `process.platform` is read per call so tests can exercise both branches.
 */
function realpathCanonical(path: string): string {
  return process.platform === 'darwin' ? realpathSync.native(path) : realpathSync(path);
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathCanonical(path);
  } catch {
    return undefined;
  }
}

/**
 * Resolves a filesystem path to its canonical real path, following symlinks.
 *
 * 1. The whole path is canonicalized when it resolves (macOS: native
 *    realpath, so existing components come back in their on-disk spelling).
 * 2. Otherwise (typically a file or directories that do not exist yet) the
 *    deepest ancestor that does resolve is canonicalized and the remaining
 *    components are re-attached verbatim. A symlinked ancestor is therefore
 *    still followed however many missing components follow it.
 * 3. If not even the filesystem root resolves, a {@link PathResolutionError}
 *    is thrown. The caller's unresolved spelling is never returned, so a
 *    containment check can never pass on a path whose ancestors were not
 *    canonicalized.
 *
 * This is security-critical: without symlink resolution, a symlinked
 * directory inside the sandbox could escape containment checks.
 */
export function resolveRealPath(filePath: string): string {
  const absolute = resolve(expandTilde(filePath));
  return tryRealpath(absolute) ?? resolveViaDeepestAncestor(absolute);
}

/**
 * Canonicalizes the deepest resolvable ancestor of `absolute` (which did not
 * resolve as a whole) and re-attaches the remaining components.
 *
 * The ancestors that resolve form a prefix-closed set: every lexical prefix
 * of a resolvable path is resolved on the way to it. So the deepest one can
 * be found by binary search, which keeps the cost at O(log depth) realpath
 * calls however many components an agent appends. (The previous walk was
 * capped at 64 levels and then returned the unresolved path, which skipped
 * symlink resolution of the ancestors.)
 */
function resolveViaDeepestAncestor(absolute: string): string {
  // `absolute` comes from path.resolve(): it starts with '/', and has no '.',
  // '..', empty or trailing components, so splitting on '/' is lossless.
  const components = absolute === '/' ? [] : absolute.slice(1).split('/');
  const prefix = (count: number): string => '/' + components.slice(0, count).join('/');

  let resolvedCount = 0;
  let resolvedPrefix = tryRealpath('/');
  if (resolvedPrefix === undefined) {
    throw new PathResolutionError('Cannot resolve the path: no ancestor could be canonicalized');
  }
  if (components.length === 0) return resolvedPrefix;

  // Invariant: prefix(resolvedCount) resolves; prefix(failedCount) does not.
  let failedCount = components.length;
  while (failedCount - resolvedCount > 1) {
    const mid = resolvedCount + Math.floor((failedCount - resolvedCount) / 2);
    const real = tryRealpath(prefix(mid));
    if (real === undefined) {
      failedCount = mid;
    } else {
      resolvedCount = mid;
      resolvedPrefix = real;
    }
  }

  const rest = components.slice(resolvedCount).join('/');
  return resolvedPrefix === '/' ? `/${rest}` : `${resolvedPrefix}/${rest}`;
}

/**
 * How many symbolic links one resolution follows at most: Linux's limit for
 * a single path lookup (MAXSYMLINKS).
 */
const MAX_SYMLINK_HOPS = 40;

/** Where a path that does not resolve leads through its links ({@link resolveDanglingLink}). */
export interface DanglingLinkResolution {
  /**
   * The path that following every link leads to, or undefined when that is
   * the path itself (a loop that leads back to it).
   */
  readonly target: string | undefined;
  /**
   * The other symbolic links followed on the way, each once, in order.
   * Whoever can replace one of them decides where the path leads.
   */
  readonly links: readonly string[];
}

/**
 * Deny-side view of a protected name, including existing symbolic links.
 * Start from the original name: canonicalizing first discards the links that
 * control it. The walk follows at most MAX_SYMLINK_HOPS links.
 */
export function resolvePathLinkChain(path: string): {
  readonly target: string;
  readonly links: readonly string[];
  /** Every traversed component, including ones removed by a later `..`. Workspace validation only. */
  readonly components: readonly string[];
} {
  return resolveFollowingEveryLink(resolve(expandTilde(path)));
}

/**
 * Where `path` leads when every symbolic link on it is followed, including a
 * link whose target does not exist, and which links it passes through; or
 * undefined when no link leads it anywhere else. Pass a
 * {@link resolveRealPath} result, as the deny-side callers do.
 *
 * resolveRealPath cannot follow a dangling link: realpath fails on it, so it
 * returns the link's own name, or the name of a missing file below a link to
 * a missing directory. A protected entry such as `~/.npmrc` or
 * `~/.ironcurtain/mcp-servers.json` that is such a link (a dotfile manager's
 * link whose file is gone, a link onto an unmounted volume) would then
 * protect only its name, while whoever creates the target (an agent writing
 * into its workspace) decides what the next host run reads through it. This
 * resolution names that target, and every further link on the way: a link
 * in a directory the agent controls (`~/.npmrc -> <workspace>/rc` where
 * `<workspace>/rc` is itself a link) can be replaced to lead anywhere.
 *
 * `realpath -m` semantics, resolved from `/` one component at a time: a
 * component that is a symbolic link is replaced by its target (relative to
 * the link's directory), at most {@link MAX_SYMLINK_HOPS} times; a link that
 * cannot be read, or one beyond that limit (a loop), stays a plain name; a
 * component that does not exist, and everything below it, is kept verbatim;
 * `..` in a link target removes the last resolved component.
 *
 * Use it ONLY to decide that something IS protected (deny side): the
 * protected-path check and workspace validation add these paths next to the
 * entry's resolveRealPath result. Allow-side checks (sandbox containment,
 * `paths.within`, whitelists) keep resolveRealPath.
 *
 * An existing path needs no link walk (resolveRealPath already resolved it),
 * so that case costs one lstat.
 */
export function resolveDanglingLink(path: string): DanglingLinkResolution | undefined {
  const absolute = resolve(expandTilde(path));
  try {
    if (!lstatSync(absolute).isSymbolicLink()) return undefined;
  } catch {
    // Some component is missing: it may be, or lie below, a dangling link.
  }
  const walk = resolveFollowingEveryLink(absolute);
  const target = walk.target === absolute ? undefined : walk.target;
  const links = [...new Set(walk.links)].filter((link) => link !== absolute && link !== target);
  return target === undefined && links.length === 0 ? undefined : { target, links };
}

/**
 * The target of {@link resolveDanglingLink}: where `path` leads when every
 * symbolic link on it is followed, or undefined when that is `path` itself.
 */
export function resolveDanglingLinkTarget(path: string): string | undefined {
  return resolveDanglingLink(path)?.target;
}

/**
 * What the walk finds at one path: a link to follow (with its target), or a
 * component to keep as a plain name. `existing` is false for a missing or
 * unreadable entry and for a link that is not followed, since nothing below
 * those can be looked up through them.
 */
type WalkStep = { readonly link: string } | { readonly existing: boolean };

/**
 * The `realpath -m` walk of {@link resolveDanglingLink}; `absolute` comes from
 * path.resolve(). Returns where it ends and every link it followed (the path
 * of the link itself, in a directory that exists), in order.
 */
function resolveFollowingEveryLink(absolute: string): {
  readonly target: string;
  readonly links: readonly string[];
  readonly components: readonly string[];
} {
  // Components still to resolve, the next one last.
  const pending = absolute.split('/').reverse();
  let current = '/';
  let depth = 0;
  // How many leading components of `current` exist and are not links. Below
  // a component that does not, nothing is looked up until `..` climbs back.
  let existingDepth = 0;
  let hops = 0;
  const links: string[] = [];
  const components = new Set<string>();
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (name === '' || name === '.') continue;
    if (name === '..') {
      if (depth > 0) {
        current = dirname(current);
        depth -= 1;
        existingDepth = Math.min(existingDepth, depth);
      }
      continue;
    }
    const next = current === '/' ? `/${name}` : `${current}/${name}`;
    components.add(next);
    const step: WalkStep = existingDepth === depth ? lookUp(next, hops) : { existing: false };
    if ('link' in step) {
      hops += 1;
      links.push(next);
      if (step.link.startsWith('/')) {
        current = '/';
        depth = 0;
        existingDepth = 0;
      }
      pending.push(...step.link.split('/').reverse());
      continue;
    }
    current = next;
    depth += 1;
    if (step.existing) existingDepth = depth;
  }
  return { target: current, links, components: [...components] };
}

/** One step of the walk at `path`, whose parent directory exists; `hops` links were followed so far. */
function lookUp(path: string, hops: number): WalkStep {
  let isLink: boolean;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return { existing: false };
  }
  if (!isLink) return { existing: true };
  // A link past the hop limit (a loop) or one that cannot be read stays a
  // plain name, as `realpath -m` keeps a looping link.
  if (hops >= MAX_SYMLINK_HOPS) return { existing: false };
  try {
    return { link: readlinkSync(path) };
  } catch {
    return { existing: false };
  }
}

/**
 * Checks whether a target path is contained within a directory.
 * Both paths are resolved to their real canonical form (following symlinks)
 * before comparison, which neutralizes both path traversal and symlink attacks.
 */
export function isWithinDirectory(targetPath: string, directory: string): boolean {
  const resolved = resolveRealPath(targetPath);
  const resolvedDir = resolveRealPath(directory);
  return isWithinResolvedDirectory(resolved, resolvedDir);
}

/**
 * {@link isWithinDirectory} for two paths that are already canonical
 * ({@link resolveRealPath} results): exact comparison, no filesystem access.
 * For callers that canonicalize each operand once and compare it many times
 * (the policy engine resolves its trusted directories once per engine and
 * each argument path once per evaluation). Never pass an unresolved path:
 * the comparison would then skip symlink resolution.
 */
export function isWithinResolvedDirectory(resolvedTarget: string, resolvedDirectory: string): boolean {
  return resolvedTarget === resolvedDirectory || resolvedTarget.startsWith(resolvedDirectory + '/');
}

/** Identity function -- returns the value unchanged. */
function identity(value: string): string {
  return value;
}

/** Lowercases the value for case-insensitive matching. */
function lowercase(value: string): string {
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registryEntries: [ArgumentRole, RoleDefinition][] = [
  [
    'read-path',
    {
      description: 'Filesystem path that will be read',
      isResourceIdentifier: true,
      category: 'path',
      canonicalize: resolveRealPath,
      annotationGuidance:
        'Assign to arguments that are filesystem paths the tool will read from. ' +
        'Includes file and directory paths used for input.',
      serverNames: ['filesystem', 'git'],
    },
  ],
  [
    'write-path',
    {
      description: 'Filesystem path that will be written to',
      isResourceIdentifier: true,
      category: 'path',
      canonicalize: resolveRealPath,
      annotationGuidance:
        'Assign to arguments that are filesystem paths the tool will write or create. ' +
        'Includes destination paths for file creation and modification.',
      serverNames: ['filesystem', 'git'],
    },
  ],
  [
    'delete-path',
    {
      description: 'Filesystem path that will be deleted',
      isResourceIdentifier: true,
      category: 'path',
      canonicalize: resolveRealPath,
      annotationGuidance:
        'Assign to arguments that are filesystem paths the tool will delete or remove. ' +
        'Also assign to the source argument of move operations (source is deleted after copy).',
      serverNames: ['filesystem', 'git'],
    },
  ],
  [
    'write-history',
    {
      description: 'Filesystem path where git history will be rewritten',
      isResourceIdentifier: true,
      category: 'path',
      canonicalize: resolveRealPath,
      annotationGuidance:
        'Assign to the repository path argument of git operations that rewrite history or modify refs. ' +
        'Includes git_reset, git_rebase, git_merge, git_cherry_pick, and similar operations. ' +
        'These operations are dangerous even within the sandbox and require human oversight.',
      serverNames: ['git'],
    },
  ],
  [
    'delete-history',
    {
      description: 'Filesystem path where git refs or history will be deleted',
      isResourceIdentifier: true,
      category: 'path',
      canonicalize: resolveRealPath,
      annotationGuidance:
        'Assign to the repository path argument of git operations that delete refs (branches, tags). ' +
        'Includes git_branch (delete mode), git_tag (delete mode), and similar operations. ' +
        'These operations are dangerous even within the sandbox and require human oversight.',
      serverNames: ['git'],
    },
  ],
  [
    'fetch-url',
    {
      description: 'URL that will be fetched via HTTP(S)',
      isResourceIdentifier: true,
      category: 'url',
      // The destination server reads every part of the URL: its path, query
      // and fragment (and the host labels a wildcard allowlist leaves open).
      outboundContent: 'url',
      canonicalize: normalizeUrl,
      annotationGuidance:
        'Assign to arguments that are HTTP(S) URLs the tool will fetch. ' +
        'Typically applies to web-fetch server tools.',
      serverNames: ['fetch'],
    },
  ],
  [
    'git-remote-url',
    {
      description: 'Git remote URL or named remote for network operations',
      isResourceIdentifier: true,
      category: 'url',
      canonicalize: normalizeGitUrl,
      annotationGuidance:
        'Assign to arguments that identify a git remote (URL or named remote like "origin"). ' +
        'Typically applies to git server tools like git_clone, git_push, git_pull, git_fetch, git_remote.',
      serverNames: ['git'],
    },
  ],
  [
    'egress-host',
    {
      description: 'Destination host the agent container reaches through the MITM proxy',
      isResourceIdentifier: true,
      // A URL-category role, so compiled `domains` conditions (wildcards
      // included) and the structural domain gate judge it. The value is the
      // canonical host the proxy parsed, never a URL.
      category: 'url',
      canonicalize: lowercase,
      annotationGuidance:
        'Assigned only to the host argument of the virtual network server (MITM egress); ' +
        'never assign it to the arguments of a real MCP server.',
      serverNames: ['network'],
    },
  ],
  [
    'github-owner',
    {
      description: 'GitHub user or organization name that owns the target resource',
      isResourceIdentifier: true,
      category: 'identifier',
      canonicalize: lowercase,
      annotationGuidance:
        'Assign to arguments that identify a GitHub user or organization that owns the target resource. ' +
        'Typically the "owner" or "org" parameter on GitHub API tools. ' +
        'Also assign it to every other argument naming the owner of a repository the call reads or writes, ' +
        'such as issue_write.parent_owner (the parent issue may live in another repository), so policy ' +
        'checks both repositories.',
      serverNames: ['github'],
    },
  ],
  [
    'github-repo',
    {
      description: 'GitHub repository name (without owner prefix)',
      isResourceIdentifier: true,
      category: 'identifier',
      canonicalize: lowercase,
      annotationGuidance:
        'Assign to arguments that identify a GitHub repository name (without the owner prefix). ' +
        'Typically the "repo" parameter on GitHub API tools. ' +
        'Also assign it to every other argument naming a repository the call reads or writes, such as ' +
        'issue_write.parent_repo. Always pair with the corresponding github-owner argument.',
      serverNames: ['github'],
    },
  ],
  [
    'github-resource-id',
    {
      description:
        'Global GitHub resource ID (review-thread node ID, sub-issue database ID) that names a resource in ' +
        'any repository, outside the scope of the owner and repo of the call',
      isResourceIdentifier: true,
      // Opaque on purpose: no structural invariant can check a global ID, and
      // the approval whitelist cannot generalize an opaque resource role, so
      // every call carrying one is approved on its own. An owner/repo pattern
      // never covers it: the engine escalates the role, and a pattern must
      // constrain every escalated role to discharge a call.
      category: 'opaque',
      canonicalize: identity,
      annotationGuidance:
        'Assign to arguments that identify a GitHub resource by a global ID rather than by owner/repo/number, ' +
        'such as pull_request_review_write.threadId (resolve_thread/unresolve_thread) and ' +
        'sub_issue_write.sub_issue_id. The resource may live in a repository other than the owner/repo of the call, ' +
        'so owner/repo-scoped approvals must not cover it.',
      serverNames: ['github'],
    },
  ],
  [
    'branch-name',
    {
      description: 'Git branch name',
      isResourceIdentifier: false,
      category: 'opaque',
      canonicalize: identity,
      annotationGuidance:
        'Assign to arguments that are git branch names. ' +
        'Typically applies to git server tools like git_branch, git_checkout, git_merge, git_push, ' +
        'and GitHub tools like create_pull_request (head/base branch arguments).',
      serverNames: ['git', 'github'],
    },
  ],
  [
    'commit-message',
    {
      description: 'Git commit message text',
      isResourceIdentifier: false,
      category: 'opaque',
      // Commit messages travel with the history when it is pushed or merged.
      outboundContent: 'text',
      canonicalize: identity,
      annotationGuidance:
        'Assign to arguments that are git commit messages or commit titles. ' +
        'Typically applies to git_commit and git_merge, and to the commit message arguments of GitHub tools ' +
        'that commit to a repository (create_or_update_file, delete_file, push_files, merge_pull_request).',
      serverNames: ['git', 'github'],
    },
  ],
  // ── Google Workspace roles ──────────────────────────────────────
  [
    'email-address',
    {
      description: 'Email address (recipient, attendee, share target)',
      isResourceIdentifier: false,
      category: 'opaque',
      canonicalize: identity,
      annotationGuidance:
        'Assign to arguments that are email addresses (recipients, attendees, share targets). ' +
        'Includes the "to" field on send/draft, "attendees" on calendar events, "email" on file sharing.',
      serverNames: ['google-workspace'],
    },
  ],
  [
    'email-body',
    {
      description: 'Email message body content',
      isResourceIdentifier: false,
      category: 'opaque',
      outboundContent: 'text',
      canonicalize: identity,
      annotationGuidance:
        'Assign to arguments that contain email body text or rich content. ' +
        'Includes the "body" field on send/draft message tools.',
      serverNames: ['google-workspace'],
    },
  ],
  [
    'share-permission',
    {
      description: 'Sharing permission level (viewer, commenter, editor, organizer)',
      isResourceIdentifier: false,
      category: 'opaque',
      canonicalize: lowercase,
      annotationGuidance:
        'Assign to arguments that specify a sharing or permission level on shared resources ' +
        '(e.g., the role parameter on Drive file sharing).',
      serverNames: ['google-workspace'],
    },
  ],
  [
    'outbound-text',
    {
      description: 'Free text the tool publishes on, or sends through, a service outside the machine',
      isResourceIdentifier: false,
      category: 'opaque',
      outboundContent: 'text',
      canonicalize: identity,
      annotationGuidance:
        'Assign to arguments holding free text that the tool publishes on, or sends through, a service outside ' +
        'the machine, where other people or systems can read it: comment, review, issue and pull request bodies ' +
        'and titles, repository descriptions, the subject and text of messages, invitations and notifications ' +
        'sent to other people, and event titles and descriptions shared with attendees. Do not assign it to ' +
        'identifiers, enum values, numbers, SHAs, file paths, file contents or search queries, nor to an ' +
        'argument that holds an object or a list of objects: policy escalates every call that passes such a ' +
        'value to a role-bearing argument. Email bodies use email-body and commit messages use commit-message ' +
        'instead.',
      // Not fetch: its only free-text candidate, `http_fetch.headers`, is an
      // object, and a role on it would send every fetch that passes headers
      // to a human (structural-nested-argument-escalate) even with the
      // outbound content assessment off.
      serverNames: ['github', 'google-workspace'],
    },
  ],
  [
    'proxy-domain',
    {
      description: 'Domain name for proxy allowlist management',
      isResourceIdentifier: true,
      category: 'identifier',
      canonicalize: lowercase,
      annotationGuidance:
        'Assign to arguments that are domain names used for proxy allowlist management. ' +
        'Typically the "domain" parameter on proxy domain management tools.',
      serverNames: ['proxy'],
    },
  ],
  [
    'none',
    {
      description: 'Argument carries no resource-identifier semantics',
      isResourceIdentifier: false,
      category: 'opaque',
      canonicalize: identity,
      annotationGuidance:
        'Assign to arguments that have no resource-identifier semantics. ' +
        'Use for flags, counts, patterns, messages, and other non-path, non-URL values.',
    },
  ],
];

export const ARGUMENT_ROLE_REGISTRY: ReadonlyMap<ArgumentRole, RoleDefinition> = new Map(registryEntries);

// ---------------------------------------------------------------------------
// Compile-time completeness check
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ROLE_COMPLETENESS_CHECK: Record<ArgumentRole, true> = {
  'read-path': true,
  'write-path': true,
  'delete-path': true,
  'write-history': true,
  'delete-history': true,
  'fetch-url': true,
  'git-remote-url': true,
  'egress-host': true,
  'github-owner': true,
  'github-repo': true,
  'github-resource-id': true,
  'branch-name': true,
  'commit-message': true,
  'email-address': true,
  'email-body': true,
  'share-permission': true,
  'outbound-text': true,
  'proxy-domain': true,
  none: true,
};

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

/** Returns the RoleDefinition for a role. Throws if not registered. */
export function getRoleDefinition(role: ArgumentRole): RoleDefinition {
  const def = ARGUMENT_ROLE_REGISTRY.get(role);
  if (!def) {
    throw new Error(`No registry entry for role: ${role}`);
  }
  return def;
}

/** Returns all roles where isResourceIdentifier is true. */
export function getResourceRoles(): ArgumentRole[] {
  return Array.from(ARGUMENT_ROLE_REGISTRY)
    .filter(([, def]) => def.isResourceIdentifier)
    .map(([role]) => role);
}

/** Type guard: returns true if the value is a valid ArgumentRole string. */
export function isArgumentRole(value: string): value is ArgumentRole {
  return ARGUMENT_ROLE_REGISTRY.has(value as ArgumentRole);
}

/** All role values as a tuple for z.enum() compatibility. */
export function getArgumentRoleValues(): [ArgumentRole, ...ArgumentRole[]] {
  const roles = [...ARGUMENT_ROLE_REGISTRY.keys()];
  return roles as [ArgumentRole, ...ArgumentRole[]];
}

/**
 * Returns roles relevant to a specific MCP server.
 * Universal roles (no serverNames) are always included.
 * Server-specific roles are included only when the server matches.
 */
export function getRolesForServer(serverName: string): [ArgumentRole, RoleDefinition][] {
  return Array.from(ARGUMENT_ROLE_REGISTRY).filter(
    ([, def]) => !def.serverNames || def.serverNames.includes(serverName),
  );
}

/** Returns all roles with the given category. */
export function getRolesByCategory(category: RoleCategory): ArgumentRole[] {
  return Array.from(ARGUMENT_ROLE_REGISTRY)
    .filter(([, def]) => def.category === category)
    .map(([role]) => role);
}

/** Returns path-category roles only. Used by protected path check / filesystem sandbox containment. */
export function getPathRoles(): ArgumentRole[] {
  return getRolesByCategory('path');
}

/** Returns url-category roles only. Used by untrusted domain gate. */
export function getUrlRoles(): ArgumentRole[] {
  return getRolesByCategory('url');
}

/** Returns identifier-category roles only. Used by owner allowlist check. */
export function getIdentifierRoles(): ArgumentRole[] {
  return getRolesByCategory('identifier');
}

/** Roles whose values the outbound content assessment checks (`outboundContent` is set). */
export function getOutboundContentRoles(): ArgumentRole[] {
  return Array.from(ARGUMENT_ROLE_REGISTRY)
    .filter(([, def]) => def.outboundContent !== undefined)
    .map(([role]) => role);
}

/**
 * How the outbound content assessment reads an argument with these roles:
 * `url` when any role is a URL whose parts carry data, otherwise `text` when
 * any role is outbound text, and undefined when none is outbound content.
 */
export function outboundContentKindOf(roles: readonly ArgumentRole[]): OutboundContentKind | undefined {
  let kind: OutboundContentKind | undefined;
  for (const role of roles) {
    const roleKind = ARGUMENT_ROLE_REGISTRY.get(role)?.outboundContent;
    if (roleKind === 'url') return 'url';
    if (roleKind === 'text') kind = 'text';
  }
  return kind;
}

/**
 * Path roles that filesystem sandbox containment is allowed to auto-resolve.
 *
 * Basic filesystem operations (read, write, delete) are safe within the
 * sandbox boundary, and by design so are the history roles `write-history`
 * and `delete-history`: inside the sandbox they act on the agent's working
 * repository, whose files the agent can already rewrite or delete.
 * What containment does not cover is configuration that host git executes:
 * the policy engine escalates writes and deletes inside `.git` and git calls
 * on repositories whose layout or config redirects outside the sandbox or
 * runs programs (src/trusted-process/git-structural-rules.ts), whatever the
 * roles resolve to here.
 *
 * NOTE: The policy engine's filesystem sandbox fast path
 * (structural-sandbox-allow in policy-engine.ts) assumes that the
 * filesystem server only has sandbox-safe path roles and no other roles.
 * If a non-sandbox-safe path role is ever added with
 * serverNames including 'filesystem', the fast path must be updated
 * to check for those roles before auto-allowing.
 */
export const SANDBOX_SAFE_PATH_ROLES: ReadonlySet<ArgumentRole> = new Set([
  'read-path',
  'write-path',
  'delete-path',
  'write-history',
  'delete-history',
]);

// ---------------------------------------------------------------------------
// Conditional Role Resolution
// ---------------------------------------------------------------------------

import type {
  ArgumentRoleSpec,
  ConditionalRoles,
  RoleCondition,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
  ToolAnnotation,
  ToolAnnotationsFile,
} from '../pipeline/types.js';

/** Type guard: returns true if an ArgumentRoleSpec is a conditional block. */
export function isConditionalRoles(spec: ArgumentRoleSpec): spec is ConditionalRoles {
  return !Array.isArray(spec) && 'default' in spec;
}

/**
 * Extracts the static/default roles from an ArgumentRoleSpec.
 * For static arrays, returns them directly.
 * For conditional specs, returns the default (most-restrictive) roles.
 *
 * Used by pipeline stages that inspect annotations without a tool call context.
 */
export function extractDefaultRoles(spec: ArgumentRoleSpec): ArgumentRole[] {
  if (Array.isArray(spec)) return spec;
  return spec.default;
}

/**
 * Resolves a StoredToolAnnotation (which may contain conditional role specs)
 * into a plain ToolAnnotation (where all args are ArgumentRole[]).
 *
 * This is the sole boundary where conditionals are evaluated. Every consumer
 * downstream receives a ToolAnnotation with static role arrays.
 *
 * @param stored - The stored annotation (from JSON file / annotation map)
 * @param callArgs - The actual tool call arguments
 * @returns A ToolAnnotation with all conditional specs resolved
 */
export function resolveStoredAnnotation(
  stored: StoredToolAnnotation,
  callArgs: Record<string, unknown>,
): ToolAnnotation {
  // Fast path: if no args have conditional specs, avoid allocation
  const hasConditionals = Object.values(stored.args).some((spec) => !Array.isArray(spec));
  if (!hasConditionals) {
    return stored as unknown as ToolAnnotation;
  }

  const resolvedArgs: Record<string, ArgumentRole[]> = {};
  for (const [argName, spec] of Object.entries(stored.args)) {
    resolvedArgs[argName] = Array.isArray(spec) ? spec : evaluateConditionalRoles(spec, callArgs);
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { args: _rawArgs, ...rest } = stored;
  return { ...rest, args: resolvedArgs };
}

/**
 * Resolves an entire StoredToolAnnotationsFile to a plain ToolAnnotationsFile
 * by flattening all conditional role specs to their default roles.
 *
 * This is the correct entry point for the policy compilation pipeline, which
 * never has actual call arguments and should only see the flat ToolAnnotation
 * shape. The policy engine resolves conditionals at evaluation time instead.
 */
export function resolveStoredAnnotationsFile(stored: StoredToolAnnotationsFile): ToolAnnotationsFile {
  return {
    ...stored,
    servers: Object.fromEntries(
      Object.entries(stored.servers).map(([serverName, server]) => [
        serverName,
        {
          ...server,
          tools: server.tools.map((tool) => {
            const resolvedArgs: Record<string, ArgumentRole[]> = {};
            for (const [argName, spec] of Object.entries(tool.args)) {
              resolvedArgs[argName] = extractDefaultRoles(spec);
            }
            const { args: _rawArgs, ...rest } = tool; // eslint-disable-line @typescript-eslint/no-unused-vars
            return { ...rest, args: resolvedArgs };
          }),
        },
      ]),
    ),
  };
}

/**
 * Evaluates a conditional roles block against tool call arguments.
 * First-match-wins: iterates through `when` clauses in order and
 * returns the first matching entry's roles, or the default roles.
 */
function evaluateConditionalRoles(spec: ConditionalRoles, callArgs: Record<string, unknown>): ArgumentRole[] {
  for (const entry of spec.when) {
    if (evaluateCondition(entry.condition, callArgs)) {
      return entry.roles;
    }
  }
  return spec.default;
}

/**
 * Evaluates a single RoleCondition against tool call arguments.
 * Exactly one of equals/in/is should be set (enforced by Zod at parse time).
 */
function evaluateCondition(cond: RoleCondition, callArgs: Record<string, unknown>): boolean {
  const value = callArgs[cond.arg];

  if (cond.equals !== undefined) {
    return value === cond.equals;
  }

  if (cond.in !== undefined) {
    return cond.in.includes(value as string | number | boolean);
  }

  if (cond.is !== undefined) {
    switch (cond.is) {
      case 'present':
        return cond.arg in callArgs && value !== null && value !== undefined;
      case 'absent':
        return !(cond.arg in callArgs) || value === null || value === undefined;
      case 'truthy':
        return cond.arg in callArgs && !!value;
      case 'falsy':
        return !(cond.arg in callArgs) || !value;
    }
  }

  // No condition operator set -- should be caught by Zod validation
  return false;
}

// ---------------------------------------------------------------------------
// Outbound content
// ---------------------------------------------------------------------------

/**
 * True when any argument of a resolved annotation carries an outbound
 * content role, i.e. the call can send content that other people or systems
 * read (see `RoleDefinition.outboundContent`).
 */
export function annotationCarriesOutboundContent(annotation: ToolAnnotation): boolean {
  return Object.values(annotation.args).some((roles) => outboundContentKindOf(roles) !== undefined);
}

/**
 * {@link annotationCarriesOutboundContent} for a stored annotation, judged
 * on every argument's default (most inclusive) roles: true when some mode of
 * the tool can send outbound content. Used by offline policy tooling, which
 * has no call arguments to resolve conditional roles against.
 */
export function storedAnnotationCarriesOutboundContent(stored: StoredToolAnnotation): boolean {
  return Object.values(stored.args).some((spec) => outboundContentKindOf(extractDefaultRoles(spec)) !== undefined);
}
