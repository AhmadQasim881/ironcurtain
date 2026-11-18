/**
 * Read-only workspace confinement: the agent of a session (or of a workflow
 * container scope) may read its whole workspace but change only a few of its
 * subdirectories, the declared output directories of a read-only workflow
 * state (`workspaceAccess: read-only`, e.g. a reviewer or critic).
 *
 * Two layers enforce it, and each covers what the other cannot:
 *
 * - Docker Agent Mode mounts `/workspace` read-only, so the agent's own tools
 *   (shell, editors, build tools) cannot change it (`createSessionContainers`),
 *   and so are the run's shared workflow dependency layers. The session runs
 *   without nested Docker, whose daemon would mount the workspace read-write
 *   for the agent's containers.
 * - The policy engine denies, structurally and whatever the persona's compiled
 *   policy says, every MCP call that would write, delete or rewrite git
 *   history anywhere outside {@link ReadOnlyWorkspace.writablePaths}, and
 *   every call that would change a git repository wherever its path points
 *   (host git acts on the repository that contains the path it is given, the
 *   workspace's own from inside an output directory) (`PolicyEngine`, rule
 *   `structural-read-only-workspace`). The agent writes its outputs through
 *   the filesystem MCP tool, which this leaves open for those directories
 *   only. Builtin (Code Mode) sessions have no other way to touch files, so
 *   this layer alone confines them.
 *
 * Leaf module: no imports, so the config, session, Docker, trusted-process and
 * workflow layers can all share the type.
 */

/** A read-only workspace and the subdirectories its agent may still change. */
export interface ReadOnlyWorkspace {
  /**
   * Workspace-relative directories the agent may still create, change and
   * delete files in, each a `/`-separated path of plain components (see
   * {@link isPlainRelativePath}). Everything else in the workspace, and
   * everything outside it, is read-only for the agent's tool calls.
   */
  readonly writablePaths: readonly string[];
}

/**
 * True for a non-empty `/`-separated relative path whose every component is a
 * plain name: not empty, not `.` or `..`, and free of `\` and NUL. Such a path
 * can only name a location strictly below the directory it is joined to.
 */
export function isPlainRelativePath(path: string): boolean {
  if (path.length === 0) return false;
  return path
    .split('/')
    .every(
      (component) =>
        component !== '' &&
        component !== '.' &&
        component !== '..' &&
        !component.includes('\\') &&
        !component.includes('\0'),
    );
}

/**
 * Builds a {@link ReadOnlyWorkspace}, deduplicating `writablePaths` in order.
 * Throws on a path that is not a plain relative path: confinement settings come
 * from trusted code (a validated workflow definition), so a bad one is a bug to
 * surface, not a value to drop.
 */
export function createReadOnlyWorkspace(writablePaths: Iterable<string>): ReadOnlyWorkspace {
  const paths: string[] = [];
  for (const path of writablePaths) {
    if (!isPlainRelativePath(path)) {
      throw new Error(`Invalid read-only workspace writable path ${JSON.stringify(path)}: not a plain relative path`);
    }
    if (!paths.includes(path)) paths.push(path);
  }
  return Object.freeze({ writablePaths: Object.freeze(paths) });
}
