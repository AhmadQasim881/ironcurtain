/**
 * Canonical filesystem locations of the committed frozen Docker-workload
 * artifacts (`<package>/config/docker-workload/`).
 *
 * These files are *reviewed records*, not runtime state: manifests that pin
 * reviewed egress origins and host/runtime ceilings. Every
 * consumer must import a helper from here instead of re-deriving the package
 * root inline, so the frozen locations can never drift apart and no caller can
 * be pointed at an unreviewed manifest by passing a different path. Loaders read
 * them with `readPackageAsset` (src/hardened-fs.ts) below
 * {@link getIronCurtainPackageRoot}: an install made under umask 002 is accepted,
 * a file or directory another local user could change is not.
 *
 * Runtime *staging* copies (which live under `$IRONCURTAIN_HOME`) are a
 * separate from the per-session selected-agent artifact cache.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Root of this IronCurtain package. Resolves identically from `src/docker/`
 * under tsx and from `dist/docker/` in a build, since both are two levels
 * below the package root.
 */
export function getIronCurtainPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Committed frozen-record directory (`<package>/config/docker-workload`). */
export function getFrozenDockerWorkloadDir(): string {
  return resolve(getIronCurtainPackageRoot(), 'config', 'docker-workload');
}

/** Frozen anonymous workload-image registry-egress manifest. */
export function getFrozenRegistryEgressManifestPath(): string {
  return resolve(getFrozenDockerWorkloadDir(), 'registry-egress-manifest.json');
}

/**
 * Frozen reviewed ceiling for the nested-daemon sidecar's seccomp additions and
 * capabilities. Admission does not read it: test/docker-workload/profile-ceiling.test.ts
 * holds the in-code profile to it, and `ironcurtain doctor` checks the packaged asset.
 */
export function getFrozenProfileCeilingPath(): string {
  return resolve(getFrozenDockerWorkloadDir(), 'profile-ceiling.json');
}

/** Frozen host-authoritative resource-watchdog policy template. */
export function getFrozenWatchdogPolicyTemplatePath(): string {
  return resolve(getFrozenDockerWorkloadDir(), 'resource-watchdog-policy.json');
}

/** Shared Linux Docker client/daemon/plugin compatibility requirements. */
export function getFrozenClientToolchainManifestPath(): string {
  return resolve(getFrozenDockerWorkloadDir(), 'client-toolchain.json');
}
