/**
 * Hardened reads of policy artifacts: compiled-policy.json,
 * dynamic-lists.json and tool-annotations.json. These files decide what an
 * agent may do (the annotations assign every argument's roles, so they decide
 * which rules match), so each is read without following a symlink at its
 * name and only when no other local user can have written it.
 *
 * A runtime leaf: the session loaders (`index.ts`) and the annotation
 * overlay (`tool-annotations-overlay.ts`) share it, so every artifact gets
 * the same checks and the same trusted owners.
 */

import { lstatSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOwnedRegularFile, type TrustedOwner } from '../hardened-fs.js';
import { getIronCurtainHome } from './paths.js';

/** The package root: `src/config/..` from source, `dist/config/..` when built. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Policy artifacts stay far below this (the bundled ones are at most a few hundred KB). */
const POLICY_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Reads a policy artifact without following a symlink at its name, refusing
 * anything but a regular file that root, the current user, the package owner
 * or the owner of the IronCurtain home owns and nobody else can write (group
 * write only for the owner's private group). A symlink or a file another
 * local user can rewrite would let someone else choose what an agent may do.
 * Errors name the file and, for a mode problem, the `chmod` that fixes it;
 * `label` starts each message. The directory itself is checked by
 * `validatePolicyDir()` where a session, the coordinator or a workflow picks
 * it.
 */
export function readPolicyArtifact(path: string, label = 'Policy artifact'): string {
  return readOwnedRegularFile(path, {
    label,
    minBytes: 0,
    maxBytes: POLICY_ARTIFACT_MAX_BYTES,
    trustedOwners: policyArtifactOwners(),
  }).toString('utf-8');
}

/** Owners trusted for policy artifacts besides root and the current user. */
export function policyArtifactOwners(): TrustedOwner[] {
  const owners: TrustedOwner[] = [];
  const packageRoot = lstatSync(PACKAGE_ROOT, { throwIfNoEntry: false });
  if (packageRoot !== undefined) owners.push({ uid: packageRoot.uid, description: 'the package owner' });
  const home = statSync(getIronCurtainHome(), { throwIfNoEntry: false });
  if (home !== undefined) owners.push({ uid: home.uid, description: 'the owner of the IronCurtain home' });
  return owners;
}

/**
 * True when something (even a dangling symlink) is at `path`. A loader that
 * treats a missing artifact as "use the fallback" must test with this, so a
 * planted symlink makes {@link readPolicyArtifact} fail rather than making
 * the loader fall back to the package's file as if the artifact were missing.
 * Throws what `lstat` throws for anything but a missing entry.
 */
export function policyArtifactEntryExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}
