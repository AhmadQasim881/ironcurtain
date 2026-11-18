/**
 * Tracks per-server context (e.g. working directory) accumulated
 * from successful tool calls. Used to enrich escalation requests
 * with information the human reviewer needs, and by the pipeline to
 * fill in the repository path of git calls that leave it to the git
 * server's session working directory.
 */

export interface ServerContext {
  workingDirectory?: string;
}

export type ServerContextMap = Map<string, ServerContext>;

/**
 * Maps tools that set the git server's session working directory to the
 * argument that holds it. Only `git_set_working_dir` does: `git_clone`
 * (whose destination is `path` since git-mcp-server 2.15) never changes
 * the session directory, so tracking it would make IronCurtain fill in a
 * directory the server itself would not use.
 */
const WORKING_DIR_ARGS: Record<string, string> = {
  git_set_working_dir: 'path',
};

/** Tools that clear the git server's session working directory. */
const WORKING_DIR_CLEARING_TOOLS: ReadonlySet<string> = new Set(['git_clear_working_dir']);

/**
 * Updates the context map after a successful tool call.
 * Tracks the git server working directory:
 * - `git_set_working_dir` sets it (args.path, the canonical absolute path
 *   the pipeline sent to the server)
 * - `git_clear_working_dir` clears it, so later calls without a path are
 *   denied until a new directory is set, as the server itself requires
 */
export function updateServerContext(
  map: ServerContextMap,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): void {
  if (WORKING_DIR_CLEARING_TOOLS.has(toolName)) {
    const ctx = map.get(serverName);
    if (ctx) delete ctx.workingDirectory;
    return;
  }

  const argKey = Object.hasOwn(WORKING_DIR_ARGS, toolName) ? WORKING_DIR_ARGS[toolName] : undefined;
  if (!argKey) return;

  const value = args[argKey];
  if (typeof value !== 'string') return;

  const ctx = map.get(serverName) ?? {};
  ctx.workingDirectory = value;
  map.set(serverName, ctx);
}

/**
 * Formats accumulated server context as key-value pairs for display.
 * Returns undefined if no context is available for the server.
 */
export function formatServerContext(map: ServerContextMap, serverName: string): Record<string, string> | undefined {
  const ctx = map.get(serverName);
  if (!ctx) return undefined;

  const result: Record<string, string> = {};
  if (ctx.workingDirectory) {
    result['Working directory'] = ctx.workingDirectory;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
