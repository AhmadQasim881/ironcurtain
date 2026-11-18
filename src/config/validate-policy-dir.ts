/**
 * Shared policyDir validator.
 *
 * Every entry point that loads a compiled policy from a directory it was
 * handed (persona and job sessions, resumed sessions that restore `policyDir`
 * from their metadata, the coordinator's loadPolicy RPC, workflow policy
 * cycling) funnels its candidate `policyDir` through `validatePolicyDir()`
 * before trusting the files on disk. A directory that an agent or another
 * local user can write would otherwise let them install arbitrary rules.
 *
 * The check canonicalizes via `realpathSync` (so a symlink cannot redirect it)
 * and accepts only the exact directories IronCurtain compiles policies into:
 *   - `<home>/generated` (the global policy)
 *   - `<home>/personas/<name>/generated` (a persona's policy)
 *   - `<home>/jobs/<id>/generated` (a cron job's policy)
 *   - `<home>/task-policies/<key>` (a published task scope, `--task-scoped`)
 *   - the package's bundled `generated/` and `generated-readonly/`
 * where `<home>` is the IronCurtain home (`~/.ironcurtain` or
 * `$IRONCURTAIN_HOME`), `<name>`/`<id>` are slugs and `<key>` is a task
 * scope's SHA-256 cache key. Everything else in the home is refused, in
 * particular the agent-writable trees: session sandboxes
 * (`sessions/<id>/sandbox`), persona and job workspaces, workflow runs,
 * soft-deleted personas in `.persona-trash/`, and the `.compile-*` staging
 * directories of task scopes that are still being compiled.
 *
 * An existing directory must also be one that no other local user can change:
 * it and each directory above it, up to the home (or the package root), must
 * be owned by root, the current user or the owner of that root, never
 * world-writable, and group-writable only for the owner's private group (the
 * StrictModes-like rules of `readPackageAsset`, so a umask 002 setup passes).
 * A directory that does not exist yet holds no policy, and the caller's own
 * "no compiled policy" check reports it; but the deepest directory above it
 * that does exist must pass the same rules (whoever can create it could fill
 * it between this check and the caller's reads), and nothing may sit where
 * the first missing component would be: the canonical form of a path through
 * a dangling symlink keeps the link, which would lead the caller's reads
 * wherever it points once its target appears (an agent's sandbox, say).
 * The artifacts in it are then read without following symlinks, with the same
 * owner checks (`readPolicyArtifact` in ./policy-artifact-read.ts).
 *
 * This trusts the IronCurtain home as configured; it cannot help when the home
 * path itself is chosen by an attacker.
 *
 * The function throws a {@link PolicyDirValidationError} so callers can
 * rethrow as domain-specific errors (e.g., `SessionError`) without this
 * module having to know about each.
 */
import { existsSync, lstatSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { assertTrustedDirectoryChain } from '../hardened-fs.js';
import { isWithinDirectory, resolveRealPath } from '../types/argument-roles.js';
import { SLUG_PATTERN } from '../types/slug.js';
import { getIronCurtainHome, getPackageConfigDir, isTaskScopeKey, TASK_POLICIES_DIRNAME } from './paths.js';

export class PolicyDirValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyDirValidationError';
  }
}

/** The directory every compiled policy lives in, below its owner's directory. */
const GENERATED_DIR = 'generated';

/** The bundled policy directories in the package config dir. */
const PACKAGE_POLICY_DIRS: readonly string[] = [GENERATED_DIR, 'generated-readonly'];

/** Home subtrees holding one `<slug>/generated` policy directory per persona or job. */
const SCOPED_POLICY_PARENTS: readonly string[] = ['personas', 'jobs'];

/** Where an accepted policy directory lives: the root its ownership chain is checked up to. */
interface PolicyDirRoot {
  readonly root: string;
  readonly rootDescription: string;
}

/**
 * Validates that `policyDir` resolves (via `realpathSync`) to one of the
 * compiled-policy directories listed above and that no other local user can
 * change it or, when it does not exist yet, create it. Returns the
 * canonicalized path on success; callers must use it for every later read.
 *
 * @throws {PolicyDirValidationError} if the path is not such a directory, it
 *   leads through a dangling symlink, or its ownership or mode (or that of the
 *   directory it would be created in) lets someone else write it.
 */
export function validatePolicyDir(policyDir: string): string {
  const resolvedPolicy = resolveRealPath(policyDir);
  const home = resolveRealPath(getIronCurtainHome());
  const packageConfig = resolveRealPath(getPackageConfigDir());

  const accepted = acceptedPolicyDirRoot(resolvedPolicy, home, packageConfig);
  if (accepted === undefined) {
    throw new PolicyDirValidationError(
      "policyDir must be one of IronCurtain's compiled-policy directories: " +
        `${join(home, GENERATED_DIR)}, ${join(home, 'personas', '<name>', GENERATED_DIR)}, ` +
        `${join(home, 'jobs', '<id>', GENERATED_DIR)}, ${join(home, TASK_POLICIES_DIRNAME, '<key>')}, ` +
        PACKAGE_POLICY_DIRS.map((name) => join(packageConfig, name)).join(' or ') +
        `. Received: ${resolvedPolicy}`,
    );
  }

  if (existsSync(resolvedPolicy)) {
    assertTrustedChain(resolvedPolicy, accepted);
  } else {
    assertMissingPolicyDirCreatableOnlyByTrusted(resolvedPolicy, accepted);
  }
  return resolvedPolicy;
}

/** {@link assertTrustedDirectoryChain} from `directory` up to the accepted root, as a validation error. */
function assertTrustedChain(directory: string, accepted: PolicyDirRoot): void {
  try {
    assertTrustedDirectoryChain(directory, {
      label: 'policyDir',
      root: accepted.root,
      rootDescription: accepted.rootDescription,
    });
  } catch (err) {
    throw new PolicyDirValidationError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * A policy directory that does not exist holds no policy; the caller's own
 * "no compiled policy" check reports that. It must still not be one that
 * someone else can create (and fill) between this check and the caller's
 * reads, so the deepest directory above it that exists must pass the chain
 * check, and the first missing component must really be missing: `missing`
 * is canonical only up to that directory, and if something is there all the
 * same (a dangling symlink, or an entry that cannot be looked through) the
 * path would lead wherever it points once its target appears.
 */
function assertMissingPolicyDirCreatableOnlyByTrusted(missing: string, accepted: PolicyDirRoot): void {
  let firstMissing = missing;
  let existing = dirname(missing);
  // Terminates: the filesystem root always exists.
  while (!existsSync(existing)) {
    firstMissing = existing;
    existing = dirname(existing);
  }
  let entry: Stats | undefined;
  try {
    entry = lstatSync(firstMissing, { throwIfNoEntry: false });
  } catch (err) {
    throw new PolicyDirValidationError(
      `policyDir cannot be checked: ${firstMissing}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (entry !== undefined) {
    throw new PolicyDirValidationError(
      `policyDir leads through a dangling symlink or an entry that cannot be followed: ${firstMissing}`,
    );
  }
  // Above the root (the IronCurtain home does not exist yet), nothing below
  // the root exists that someone could have prepared.
  if (isWithinDirectory(existing, accepted.root)) assertTrustedChain(existing, accepted);
}

/** The root `candidate` is an accepted policy directory under, or undefined. All inputs are canonical. */
function acceptedPolicyDirRoot(candidate: string, home: string, packageConfig: string): PolicyDirRoot | undefined {
  if (PACKAGE_POLICY_DIRS.some((name) => candidate === join(packageConfig, name))) {
    // `<package>/src/config` under tsx, `<package>/dist/config` in a build.
    return { root: dirname(dirname(packageConfig)), rootDescription: 'the IronCurtain package' };
  }
  const inHome: PolicyDirRoot = { root: home, rootDescription: 'the IronCurtain home' };
  if (candidate === join(home, GENERATED_DIR)) return inHome;
  if (dirname(candidate) === join(home, TASK_POLICIES_DIRNAME) && isTaskScopeKey(basename(candidate))) return inHome;
  if (basename(candidate) !== GENERATED_DIR) return undefined;
  const owner = dirname(candidate);
  const scope = dirname(owner);
  if (SLUG_PATTERN.test(basename(owner)) && SCOPED_POLICY_PARENTS.some((parent) => scope === join(home, parent))) {
    return inHome;
  }
  return undefined;
}
