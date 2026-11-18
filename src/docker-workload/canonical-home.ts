/**
 * Canonical IronCurtain-home paths for nested-Docker host staging.
 *
 * The configured home (`IRONCURTAIN_HOME`, or `~/.ironcurtain`) and its
 * ancestors are the user's trust boundary, exactly as `ensureSecureBundleDir`
 * treats them: they may legitimately be reached through a symlink (a relocated
 * `/home`, an automounted home, `IRONCURTAIN_HOME` under `/tmp` on macOS).
 * Everything below the home is IronCurtain's own and must be a real directory.
 *
 * Staging helpers require canonical paths (`realpath(path) === path`) for the
 * private directories they create and bind-mount. Rather than weaken those
 * checks, nested admission resolves the home once with
 * {@link resolveCanonicalIronCurtainHome} and maps each staging path with
 * {@link canonicalPathBelowHome}: every existing component below the home is
 * checked with `lstat` (never followed), and the canonical result is what the
 * helpers verify and what the runtime receives as a bind-mount source, so
 * Docker Desktop file sharing sees the same path (`/tmp` vs `/private/tmp`).
 */

import { lstatSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';
import { assertCanonicalHostPath } from '../hardened-fs.js';

export interface CanonicalIronCurtainHome {
  /** The home as the path helpers derive it (lexically resolved, possibly through a symlink). */
  readonly configured: string;
  /** Its real path, resolved once. */
  readonly canonical: string;
}

/** Resolve the configured IronCurtain home to its real path once, for one admission. */
export function resolveCanonicalIronCurtainHome(configured: string = getIronCurtainHome()): CanonicalIronCurtainHome {
  assertCanonicalHostPath(configured, 'IronCurtain home');
  let canonical: string;
  try {
    canonical = realpathSync(configured);
  } catch (error) {
    throw new Error(`IronCurtain home is not accessible: ${configured}`, { cause: error });
  }
  if (!lstatSync(canonical).isDirectory()) throw new Error(`IronCurtain home is not a directory: ${configured}`);
  return { configured, canonical };
}

/**
 * The canonical form of `path`, which IronCurtain derived below the home.
 *
 * Each component below the home that already exists must be a real directory
 * (not a symlink) owned by this user; components that do not exist yet are
 * appended as given, for the caller to create. The final real path is checked
 * against the result, so nothing below the home can redirect it.
 */
export function canonicalPathBelowHome(home: CanonicalIronCurtainHome, path: string, label: string): string {
  assertCanonicalHostPath(path, label);
  const base = isAtOrBelow(path, home.configured)
    ? home.configured
    : isAtOrBelow(path, home.canonical)
      ? home.canonical
      : undefined;
  if (base === undefined) throw new Error(`${label} must be below the IronCurtain home: ${path}`);
  const below = relative(base, path);
  const components = below === '' ? [] : below.split(sep);
  const uid = process.getuid?.();
  let current = home.canonical;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return join(current, ...components.slice(index + 1));
    }
    if (stats.isSymbolicLink() || !stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      throw new Error(`${label} must be reached through owner-owned real directories below the IronCurtain home`);
    }
  }
  if (realpathSync(current) !== current) {
    throw new Error(`${label} changed while its canonical location was being resolved`);
  }
  return current;
}

function isAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
