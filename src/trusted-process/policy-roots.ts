import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CompiledPolicyFile } from '../pipeline/types.js';
import { RESERVED_SERVER_NAMES } from '../types/reserved-servers.js';
import { expandTilde, resolveRealPath } from '../types/argument-roles.js';

/**
 * Root entry for the MCP Roots protocol.
 * Mirrors the MCP SDK's Root type without importing it directly,
 * keeping this module free of SDK dependencies.
 */
export interface PolicyRoot {
  /** Absolute directory path (not a file:// URI yet -- callers convert). */
  readonly path: string;
  /** Human-readable label for debugging and audit logs. */
  readonly name: string;
}

/**
 * Extracts the set of directories that the compiled policy references
 * in `allow` or `escalate` rules with `paths.within` conditions.
 * These directories, plus the sandbox, form the initial roots that
 * MCP servers should accept.
 *
 * `deny` rules are excluded -- they never grant access, so exposing
 * denied directories as roots would widen the server-side boundary
 * without purpose.
 *
 * Catch-all rules without `paths.within` (like
 * `escalate-read-outside-permitted-areas`) are also excluded from
 * initial roots. Those are handled dynamically: when an escalation is
 * approved, the directory each escalated path needs is added as a root
 * at that time (see `roots-expansion.ts`).
 *
 * @param compiledPolicy - The loaded compiled policy artifact.
 * @param allowedDirectory - The sandbox directory (always included).
 * @returns Deduplicated array of PolicyRoot entries, sandbox first.
 */
export function extractPolicyRoots(compiledPolicy: CompiledPolicyFile, allowedDirectory: string): PolicyRoot[] {
  const seen = new Set<string>();
  const roots: PolicyRoot[] = [];

  // Sandbox is always the first root.
  const resolvedSandbox = resolveRealPath(allowedDirectory);
  seen.add(resolvedSandbox);
  roots.push({ path: resolvedSandbox, name: 'sandbox' });

  for (const rule of compiledPolicy.rules) {
    if (rule.then === 'deny') continue;
    if (!rule.if.paths?.within) continue;

    const dir = resolveRealPath(rule.if.paths.within);
    if (seen.has(dir)) continue;

    seen.add(dir);
    roots.push({ path: dir, name: rule.name });
  }

  return roots;
}

/**
 * Extracts the set of MCP server names referenced by the compiled
 * policy. Reserved virtual servers (registered in-process, not spawned
 * from `mcp-servers.json`) are excluded.
 */
export function extractRequiredServers(policy: Pick<CompiledPolicyFile, 'rules'>): Set<string> {
  const servers = new Set<string>();
  for (const rule of policy.rules) {
    if (!rule.if.server) continue;
    for (const serverName of rule.if.server) {
      servers.add(serverName);
    }
  }
  for (const reserved of RESERVED_SERVER_NAMES) {
    servers.delete(reserved);
  }
  return servers;
}

/**
 * Converts PolicyRoot entries to MCP Root objects with `file://` URIs.
 */
export function toMcpRoots(policyRoots: PolicyRoot[]): Array<{ uri: string; name: string }> {
  return policyRoots.map((r) => ({
    uri: rootUriForPath(r.path),
    name: r.name,
  }));
}

/**
 * Converts an absolute directory path to the `file://` URI advertised as
 * an MCP root.
 *
 * Uses `pathToFileURL` so characters with URL syntax (`#`, `?`, `%`,
 * spaces, control characters) are percent-encoded. A plain
 * `file://${path}` would make a directory named `/home/u/x#y` reach the
 * server as `/home/u/x` (the rest parses as a URL fragment): a different
 * directory from the one that was approved.
 */
export function rootUriForPath(directory: string): string {
  return pathToFileURL(directory).href;
}

/**
 * Inverse of {@link rootUriForPath}: the absolute path a root URI names,
 * or `undefined` when the URI is not a well-formed local `file:` URI.
 */
export function pathForRootUri(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/**
 * Resolves an approved path argument to an absolute canonical path
 * (symlinks resolved). A relative path resolves against `baseDirectory`
 * (the session sandbox), the base the policy engine uses for relative
 * paths, never against the process working directory. Returns
 * `undefined` for a relative path when no base directory is known.
 */
export function resolveApprovedPath(filePath: string, baseDirectory?: string): string | undefined {
  const expanded = expandTilde(filePath);
  if (isAbsolute(expanded)) return resolveRealPath(expanded);
  if (baseDirectory === undefined) return undefined;
  return resolveRealPath(resolve(baseDirectory, expanded));
}

/**
 * Returns the directory a canonical approved path needs as an MCP root:
 * the path itself when it names an existing directory, otherwise its
 * parent (a file, or a path the call is about to create).
 *
 * The final component is inspected with `lstat`, so a path that has
 * become a symlink since it was canonicalized is not treated as a
 * directory. Callers re-canonicalize the path to detect such a swap.
 */
export function rootDirectoryForCanonicalPath(canonicalPath: string): string {
  let isDirectory = false;
  try {
    isDirectory = lstatSync(canonicalPath).isDirectory();
  } catch {
    // Missing or unreadable: the call creates or reads an entry in the parent.
  }
  return isDirectory ? canonicalPath : dirname(canonicalPath);
}

/**
 * Returns the directory to use as an MCP root for an approved path: the
 * canonical path itself when it is an existing directory, otherwise its
 * canonical parent directory. Approving `list_directory ~/Downloads`
 * therefore yields `~/Downloads`, not the whole home directory.
 *
 * Relative paths resolve against `baseDirectory` (the sandbox). Without
 * a base directory a relative path has no approved location, so the
 * result is `undefined` and no root may be derived from it.
 */
export function directoryForPath(filePath: string, baseDirectory?: string): string | undefined {
  const canonical = resolveApprovedPath(filePath, baseDirectory);
  return canonical === undefined ? undefined : rootDirectoryForCanonicalPath(canonical);
}
