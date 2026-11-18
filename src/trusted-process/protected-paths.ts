/**
 * Protected-path matching for the policy engine's structural deny.
 *
 * A path is protected when a protected entry (the IronCurtain home, policy,
 * constitution and server config files, credential files, ...) is equal to
 * it or contains it. Three rules shape the match.
 *
 * Spelling-insensitive, on the deny side only. Both sides are compared after
 * {@link foldPathForComparison}: default-ignorable code points removed,
 * Unicode NFC, then full case folding. On a case- or normalization-
 * insensitive volume (macOS APFS and HFS+, WSL /mnt/c, Linux casefold
 * directories, exFAT), and through @modelcontextprotocol/server-filesystem's
 * own NFC matching of path components on any volume, `.ENV` or an NFD
 * spelling of an accented directory reaches the same file as the protected
 * entry. Folding unconditionally over-matches on case-sensitive volumes,
 * which only ever denies more, so no per-volume probe is needed. A leaf that
 * does not exist yet is compared as the realpath of its deepest existing
 * ancestor plus the remaining components, folded as a whole.
 *
 * Allow-side checks keep exact comparison of canonical paths: sandbox
 * containment, `paths.within` rules, whitelist directories and the sandbox
 * exemption below. Folding those would make `~/downloads` stand for
 * `~/Downloads`, or a sibling `.../SANDBOX` for the sandbox, on a
 * case-sensitive volume. On macOS, `resolveRealPath` returns the on-disk
 * spelling of existing components, so exact allow-side checks still accept
 * the user's spelling of directories that exist.
 *
 * Per-entry sandbox exemption. The sandbox (allowedDirectory) may live inside
 * a protected entry, as ~/.ironcurtain/sessions/<id>/sandbox lives inside
 * ~/.ironcurtain, and the agent must still be able to use it. The exemption
 * belongs to the entry it is carved out of: an entry that strictly contains
 * the sandbox does not cover paths exactly inside the sandbox. An entry equal
 * to or inside the sandbox (a `--workspace` that holds `.env`,
 * `mcp-servers.json` or a policy directory) stays protected, and so does the
 * rest of an ancestor entry.
 *
 * Dangling links, on the deny side only. A protected entry that is, or lies
 * below, a symbolic link whose target is missing also protects that target
 * and every other link on the way to it (see {@link resolveProtectedEntries}),
 * so a file created there, or a link replaced on the way, cannot be read
 * through the protected name later.
 */

import { resolvePathLinkChain, resolveRealPath, expandTilde } from '../types/argument-roles.js';
import { resolve as absolutePath } from 'node:path';

/**
 * Default-ignorable code points: zero-width (non-)joiners and spaces, bidi
 * controls, soft hyphen, variation selectors, BOM and the like. HFS+ and the
 * casefold support in older Linux kernels skip some of them when comparing
 * names, so `.e` + U+200D + `nv` can name `.env` there.
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * Comparison key for deny-side path matching. Over-approximates every
 * equivalence a filesystem or the filesystem MCP server may apply to names:
 *
 * - default-ignorable code points are removed;
 * - NFC normalization merges canonically equivalent spellings (NFD `e` +
 *   U+0301 and precomposed U+00E9, and singletons such as the Kelvin sign
 *   U+212A and `K`);
 * - lower, upper, then lower case mapping approximates full Unicode case
 *   folding: capital and small sharp s (U+1E9E, U+00DF) and `SS` all become
 *   `ss`, long s (U+017F) becomes `s`, ligatures expand (U+FB03 to `ffi`),
 *   final and medial sigma merge.
 *
 * It never produces or removes a `/`, so path structure is preserved. Use it
 * only to decide that something IS protected; never to grant access.
 */
export function foldPathForComparison(path: string): string {
  return path
    .replace(DEFAULT_IGNORABLE, '')
    .normalize('NFC')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize('NFC');
}

/** True when `child` equals `parent` or lies inside it (plain string comparison). */
function isEqualOrInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/** A protected entry canonicalized for matching: its canonical path and that path's folded comparison key. */
export interface ResolvedProtectedEntry {
  readonly path: string;
  readonly key: string;
}

/**
 * Canonicalizes protected entries for {@link isProtectedResolvedPath}, with
 * `resolve` (`resolveRealPath` unless the caller memoizes it). Resolve them
 * again for every decision rather than once per session: an entry is matched
 * by what it names now, so a protected name that becomes a symlink (a `.env`
 * created after start-up, a credential directory replaced by a link) protects
 * its new target.
 *
 * The original name, current target and each controlling symbolic link are
 * retained, even when the target exists. Walking the original name before
 * canonicalization keeps existing links visible; dangling targets use the
 * same bounded component walk. These additional entries are deny-side only.
 *
 * Throws `PathResolutionError` when an entry cannot be canonicalized at all.
 */
export function resolveProtectedEntries(
  protectedPaths: readonly string[],
  resolve: (path: string) => string = resolveRealPath,
): ResolvedProtectedEntry[] {
  return protectedPaths.flatMap((entry) => {
    const path = resolve(entry);
    const chain = resolvePathLinkChain(entry);
    return [...new Set([absolutePath(expandTilde(entry)), path, chain.target, ...chain.links])].map((resolved) => ({
      path: resolved,
      key: foldPathForComparison(resolved),
    }));
  });
}

/**
 * {@link isProtectedPath} for operands that are already canonical: `target`
 * and `sandbox` are `resolveRealPath` results and `entries` come from
 * {@link resolveProtectedEntries}. No filesystem access.
 */
export function isProtectedResolvedPath(
  target: string,
  entries: readonly ResolvedProtectedEntry[],
  sandbox: string | undefined,
): boolean {
  const targetKey = foldPathForComparison(target);
  return entries.some((entry) => {
    if (!isEqualOrInside(targetKey, entry.key)) return false;

    const exempt =
      sandbox !== undefined &&
      sandbox !== entry.path &&
      isEqualOrInside(sandbox, entry.path) &&
      isEqualOrInside(target, sandbox);
    return !exempt;
  });
}

/**
 * A delete operand also affects protected descendants. This reverse
 * containment is deny-side only: reading/listing a parent remains ordinary
 * policy work. An exempt sandbox inside a broad protected ancestor does not
 * contain that ancestor, while a specific protected entry inside it still wins.
 */
export function containsProtectedResolvedPath(target: string, entries: readonly ResolvedProtectedEntry[]): boolean {
  const targetKey = foldPathForComparison(target);
  return entries.some((entry) => isEqualOrInside(entry.key, targetKey));
}

/**
 * Decides whether `path` is protected by any of `protectedPaths`.
 *
 * `path`, every protected entry and `allowedDirectory` are canonicalized with
 * `resolveRealPath` at call time, so symlinks are followed and an entry that
 * appears after start-up (such as a newly created `.env`) is matched by its
 * current target; an entry that is a dangling link also protects where it
 * leads and the links on the way (see {@link resolveProtectedEntries}). A
 * path is protected iff some entry contains it (compared folded) and that
 * entry's sandbox exemption does not apply, which requires the sandbox to
 * lie strictly inside the entry and the path to lie inside the sandbox (both
 * compared exactly).
 *
 * The policy engine resolves the entries once per evaluation and the sandbox
 * once per engine, and calls {@link isProtectedResolvedPath} directly.
 *
 * Throws `PathResolutionError` (see `resolveRealPath`) when a path cannot be
 * canonicalized at all; the policy engine turns that into a deny.
 */
export function isProtectedPath(path: string, protectedPaths: readonly string[], allowedDirectory?: string): boolean {
  const target = resolveRealPath(path);
  const sandbox = allowedDirectory ? resolveRealPath(allowedDirectory) : undefined;
  return isProtectedResolvedPath(target, resolveProtectedEntries(protectedPaths), sandbox);
}
