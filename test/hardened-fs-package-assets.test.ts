/**
 * Package-shipped assets (`readPackageAsset`): the frozen manifests and the
 * build-trust wrapper are read under OpenSSH StrictModes-like rules instead of
 * the strict host-state mode test, so a checkout or npm install made under the
 * common umask 002 works while an asset another local user can change is still
 * refused.
 *
 * Every fixture is a copy whose owner, group and mode are set explicitly, and
 * the account database is injected, so no outcome depends on the runner's
 * umask, its temp directory or its /etc/group. Tests that need a file owned by
 * another user run only as root.
 */

import {
  chmodSync,
  chownSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pass-through mock with one seam: a hook that runs right after `openSync`, so a
// test can rename the asset between the open and the descriptor re-location.
const fsHooks = vi.hoisted(() => ({ afterOpen: undefined as ((path: string) => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const openSync = (path: unknown, ...rest: unknown[]): number => {
    const descriptor = (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
    fsHooks.afterOpen?.(String(path));
    return descriptor;
  };
  return { ...actual, openSync };
});

import { isUserPrivateGroup, readPackageAsset, type AccountDatabase } from '../src/hardened-fs.js';
import { loadClientToolchainManifest } from '../src/docker-workload/client-toolchain.js';
import { loadFrozenWatchdogPolicyTemplate } from '../src/docker-workload/watchdog-policy.js';
import { loadRegistryEgressManifest } from '../src/docker/registry-egress-policy.js';
import {
  getFrozenClientToolchainManifestPath,
  getFrozenDockerWorkloadDir,
  getFrozenRegistryEgressManifestPath,
  getFrozenWatchdogPolicyTemplatePath,
  getIronCurtainPackageRoot,
} from '../src/docker/docker-workload-paths.js';
import { fifoSupported, makeFifo, startFifoUnblocker } from './helpers/fifo.js';

const EUID = process.geteuid?.() ?? -1;
const EGID = process.getegid?.() ?? -1;
const RUNS_AS_ROOT = EUID === 0;
const OTHER_UID = 65534;

const FROZEN_ASSETS = ['client-toolchain.json', 'registry-egress-manifest.json', 'resource-watchdog-policy.json'];
const WRAPPER_PACKAGE_PATH = 'docker/build-trust-runtime/bin/linux-amd64/ironcurtain-build-trust-runc';

/** The runner's own account, whose private group is `gid`. */
function privateGroupAccounts(uid = EUID, gid = EGID): AccountDatabase {
  return {
    passwd: `owner:x:${uid}:${gid}:Package owner:/home/owner:/bin/sh\n`,
    group: `owner:x:${gid}:\n`,
  };
}

/** The same group, but a second account is a member of it. */
function sharedGroupAccounts(): AccountDatabase {
  return {
    passwd: `owner:x:${EUID}:${EGID}::/home/owner:/bin/sh\nother:x:${EUID + 1}:${EGID + 1}::/home/other:/bin/sh\n`,
    group: `owner:x:${EGID}:other\nother:x:${EGID + 1}:\n`,
  };
}

/** True when the host's own account files make the runner's primary group private. */
function runnerHasPrivateGroupOnHost(): boolean {
  try {
    return isUserPrivateGroup(EUID, EGID, {
      passwd: readFileSync('/etc/passwd', 'utf8'),
      group: readFileSync('/etc/group', 'utf8'),
    });
  } catch {
    return false;
  }
}

/** Fails the test if the account database is consulted at all. */
const UNCONSULTED_ACCOUNTS: AccountDatabase = {
  get passwd(): string {
    throw new Error('the account database was consulted');
  },
  get group(): string {
    throw new Error('the account database was consulted');
  },
};

let base: string;
let root: string;
let assetDir: string;

/** Owner, group and mode set explicitly: independent of the umask and of a setgid temp directory. */
function setEntry(path: string, mode: number, uid = EUID, gid = EGID): void {
  chownSync(path, uid, gid);
  chmodSync(path, mode);
}

function assetPath(name = 'client-toolchain.json'): string {
  return join(assetDir, name);
}

function read(path: string, accounts: AccountDatabase = privateGroupAccounts()): Buffer {
  return readPackageAsset(path, { label: 'test asset', minBytes: 2, maxBytes: 1 << 20, packageRoot: root, accounts });
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

beforeEach(() => {
  // A space in the path also exercises the quoting of the chmod hint.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain package-asset-')));
  root = join(base, 'package');
  assetDir = join(root, 'config', 'docker-workload');
  mkdirSync(assetDir, { recursive: true });
  for (const name of FROZEN_ASSETS) copyFileSync(join(getFrozenDockerWorkloadDir(), name), join(assetDir, name));
  for (const directory of [root, join(root, 'config'), assetDir]) setEntry(directory, 0o755);
  for (const name of FROZEN_ASSETS) setEntry(join(assetDir, name), 0o644);
});

afterEach(() => {
  fsHooks.afterOpen = undefined;
  chmodSync(base, 0o700);
  rmSync(base, { recursive: true, force: true });
});

describe('readPackageAsset: umask 002 installs', () => {
  it('accepts 0664 copies and 0775 directories whose group is the owner private group', () => {
    for (const directory of [root, join(root, 'config'), assetDir]) setEntry(directory, 0o775);
    for (const name of FROZEN_ASSETS) {
      setEntry(assetPath(name), 0o664);
      expect(read(assetPath(name)).equals(readFileSync(join(getFrozenDockerWorkloadDir(), name)))).toBe(true);
    }
  });

  it('accepts a 0775 copy of the packaged build-trust wrapper', () => {
    const wrapperDirectory = join(root, 'docker', 'build-trust-runtime', 'bin', 'linux-amd64');
    mkdirSync(wrapperDirectory, { recursive: true });
    const wrapper = join(root, WRAPPER_PACKAGE_PATH);
    copyFileSync(resolve(getIronCurtainPackageRoot(), WRAPPER_PACKAGE_PATH), wrapper);
    for (let directory = wrapperDirectory; directory !== root; directory = resolve(directory, '..')) {
      setEntry(directory, 0o775);
    }
    setEntry(wrapper, 0o775);
    const bytes = readPackageAsset(wrapper, {
      label: 'packaged build-trust wrapper',
      minBytes: 64,
      maxBytes: 32 << 20,
      packageRoot: root,
      accounts: privateGroupAccounts(),
    });
    expect(sha256(bytes)).toBe(sha256(readFileSync(resolve(getIronCurtainPackageRoot(), WRAPPER_PACKAGE_PATH))));
  });

  it('never consults the account database when nothing is group-writable', () => {
    expect(read(assetPath(), UNCONSULTED_ACCOUNTS).length).toBeGreaterThan(2);
  });
});

describe('readPackageAsset: assets other users can change are refused', () => {
  it('rejects a world-writable copy with the chmod that fixes it', () => {
    setEntry(assetPath(), 0o666);
    const expected = `test asset must not be world-writable: ${assetPath()}. Fix it with: chmod o-w '${assetPath()}'`;
    expect(() => read(assetPath())).toThrow(expected);
  });

  it('rejects a group-writable copy unless the group is the owner private group', () => {
    setEntry(assetPath(), 0o664);
    expect(() => read(assetPath(), sharedGroupAccounts())).toThrow(
      `test asset is group-writable and its group (gid ${EGID}) is not the private group of its owner (uid ${EUID}): ${assetPath()}. Fix it with: chmod g-w '${assetPath()}'`,
    );
    // Membership the account files cannot settle counts as shared.
    for (const accounts of [
      { passwd: '', group: '' },
      { passwd: `+::::::\n`, group: `owner:x:${EGID}:\n` },
      { passwd: `owner:x:${EUID}:${EGID + 1}::/:/bin/sh\n`, group: `owner:x:${EGID}:\n` },
    ]) {
      expect(() => read(assetPath(), accounts)).toThrow(/chmod g-w/u);
    }
    expect(read(assetPath(), privateGroupAccounts()).length).toBeGreaterThan(2);
  });

  it('checks every directory up to and including the package root', () => {
    setEntry(assetDir, 0o777);
    expect(() => read(assetPath())).toThrow(
      `test asset is in a world-writable directory: ${assetDir}. Fix it with: chmod o-w '${assetDir}'`,
    );
    setEntry(assetDir, 0o755);

    setEntry(root, 0o777);
    expect(() => read(assetPath())).toThrow(`test asset is in a world-writable directory: ${root}.`);
    setEntry(root, 0o755);

    setEntry(join(root, 'config'), 0o775);
    expect(() => read(assetPath(), sharedGroupAccounts())).toThrow(
      `test asset is in a group-writable directory and its group (gid ${EGID}) is not the private group of its owner (uid ${EUID}): ${join(root, 'config')}. Fix it with: chmod g-w`,
    );
    expect(read(assetPath(), privateGroupAccounts()).length).toBeGreaterThan(2);
  });

  it('does not walk above the package root', () => {
    chmodSync(base, 0o777);
    expect(read(assetPath(), UNCONSULTED_ACCOUNTS).length).toBeGreaterThan(2);
  });

  it('refuses an asset outside the root, a symlinked asset and a directory link that leaves the root', () => {
    const outside = join(base, 'outside.json');
    writeFileSync(outside, '{}\n', { mode: 0o644 });
    expect(() => read(outside)).toThrow(`test asset must ship inside the package root ${root}: ${outside}`);

    const link = join(assetDir, 'link.json');
    symlinkSync(assetPath(), link);
    expect(() => read(link)).toThrow(`test asset must be a readable regular non-symlink file: ${link}`);

    const elsewhere = join(base, 'elsewhere', 'docker-workload');
    mkdirSync(elsewhere, { recursive: true });
    copyFileSync(join(getFrozenDockerWorkloadDir(), 'client-toolchain.json'), join(elsewhere, 'client-toolchain.json'));
    rmSync(join(root, 'config'), { recursive: true });
    symlinkSync(join(base, 'elsewhere'), join(root, 'config'));
    expect(() => read(assetPath())).toThrow(/must ship inside the package root/u);
  });

  it.runIf(fifoSupported)('refuses a FIFO without blocking', () => {
    const fifo = join(assetDir, 'fifo.json');
    makeFifo(fifo);
    const unblocker = startFifoUnblocker(fifo);
    const started = Date.now();
    try {
      expect(() => read(fifo)).toThrow(`test asset must be a regular file: ${fifo}`);
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('enforces the size bounds', () => {
    expect(() =>
      readPackageAsset(assetPath(), {
        label: 'test asset',
        minBytes: 1 << 20,
        maxBytes: 2 << 20,
        packageRoot: root,
        accounts: privateGroupAccounts(),
      }),
    ).toThrow(/test asset size is outside the allowed range/u);
    expect(() =>
      readPackageAsset(assetPath(), {
        label: 'test asset',
        minBytes: 1,
        maxBytes: 8,
        packageRoot: root,
        accounts: privateGroupAccounts(),
      }),
    ).toThrow(/test asset size is outside the allowed range/u);
  });

  it.runIf(process.platform === 'linux')('detects the asset being renamed after it was opened', () => {
    const path = assetPath();
    fsHooks.afterOpen = (opened) => {
      if (opened.endsWith('/client-toolchain.json')) {
        fsHooks.afterOpen = undefined;
        renameSync(path, `${path}.moved`);
      }
    };
    expect(() => read(path)).toThrow(`test asset was moved while it was being read: ${path}`);
  });

  it.runIf(RUNS_AS_ROOT)('refuses an asset or a directory owned by another user', () => {
    setEntry(assetPath(), 0o644, OTHER_UID, EGID);
    expect(() => read(assetPath())).toThrow(
      `test asset is owned by uid ${OTHER_UID}, not by root, the current user (uid 0) or the package owner (uid 0): ${assetPath()}`,
    );
    setEntry(assetPath(), 0o644);

    setEntry(assetDir, 0o755, OTHER_UID, EGID);
    expect(() => read(assetPath())).toThrow(`test asset is in a directory owned by uid ${OTHER_UID}`);
  });

  it.runIf(RUNS_AS_ROOT)('trusts the package owner, as when root runs a user checkout made under umask 002', () => {
    const userGid = OTHER_UID;
    for (const directory of [root, join(root, 'config'), assetDir]) setEntry(directory, 0o775, OTHER_UID, userGid);
    setEntry(assetPath(), 0o664, OTHER_UID, userGid);
    const accounts = {
      passwd: `root:x:0:0:root:/root:/bin/sh\nsam:x:${OTHER_UID}:${userGid}::/home/sam:/bin/sh\n`,
      group: `root:x:0:\nsam:x:${userGid}:\n`,
    };
    expect(read(assetPath(), accounts).length).toBeGreaterThan(2);
    // A package root owned by root does not extend that trust to the user's files.
    setEntry(root, 0o755);
    expect(() => read(assetPath(), accounts)).toThrow(`test asset is owned by uid ${OTHER_UID}`);
  });
});

describe('frozen asset loaders read package copies under the package-asset rules', () => {
  it('load 0644 copies with their exact bytes and refuse world-writable ones', () => {
    const registry = loadRegistryEgressManifest(assetPath('registry-egress-manifest.json'), root);
    expect(registry.sha256).toBe(sha256(readFileSync(getFrozenRegistryEgressManifestPath())));
    expect(loadClientToolchainManifest(assetPath(), 'amd64', root).manifest.architecture).toBe('amd64');
    expect(loadFrozenWatchdogPolicyTemplate(assetPath('resource-watchdog-policy.json'), root)).toEqual(
      loadFrozenWatchdogPolicyTemplate(getFrozenWatchdogPolicyTemplatePath()),
    );

    for (const name of FROZEN_ASSETS) setEntry(assetPath(name), 0o666);
    expect(() => loadRegistryEgressManifest(assetPath('registry-egress-manifest.json'), root)).toThrow(
      /registry-egress manifest must not be world-writable: .* Fix it with: chmod o-w /u,
    );
    expect(() => loadClientToolchainManifest(assetPath(), 'amd64', root)).toThrow(
      /client toolchain manifest must not be world-writable/u,
    );
    expect(() => loadFrozenWatchdogPolicyTemplate(assetPath('resource-watchdog-policy.json'), root)).toThrow(
      /watchdog policy template must not be world-writable/u,
    );
  });

  // End to end through the host's own /etc/passwd and /etc/group. Only where the
  // runner's primary group is private there (Debian/Ubuntu user-private groups,
  // and root on most distributions); the outcome above never depends on it.
  it.runIf(runnerHasPrivateGroupOnHost())(
    'load 0664 copies on a host whose account files make the group private',
    () => {
      for (const directory of [root, join(root, 'config'), assetDir]) setEntry(directory, 0o775);
      for (const name of FROZEN_ASSETS) setEntry(assetPath(name), 0o664);
      expect(loadRegistryEgressManifest(assetPath('registry-egress-manifest.json'), root).sha256).toBe(
        sha256(readFileSync(getFrozenRegistryEgressManifestPath())),
      );
      expect(loadClientToolchainManifest(assetPath(), 'arm64', root).manifest.architecture).toBe('arm64');
      expect(loadFrozenWatchdogPolicyTemplate(assetPath('resource-watchdog-policy.json'), root).policyId).toBe(
        loadFrozenWatchdogPolicyTemplate(getFrozenWatchdogPolicyTemplatePath()).policyId,
      );
    },
  );

  it('read the checked-in assets from the IronCurtain package root by default', () => {
    expect(loadClientToolchainManifest(getFrozenClientToolchainManifestPath(), 'arm64').manifest.platform).toBe(
      'linux',
    );
    expect(loadRegistryEgressManifest(getFrozenRegistryEgressManifestPath()).manifest.status).toBe('frozen');
    // A copy outside the package is not a package asset.
    expect(() => loadFrozenWatchdogPolicyTemplate(assetPath('resource-watchdog-policy.json'))).toThrow(
      /must ship inside the package root/u,
    );
  });
});

describe('isUserPrivateGroup', () => {
  const debianPasswd = [
    'root:x:0:0:root:/root:/bin/bash',
    'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
    'sam:x:1000:1000:Sam,,,:/home/sam:/bin/bash',
    'alice:x:1001:1001::/home/alice:/bin/bash',
    '',
  ].join('\n');
  const debianGroup = ['root:x:0:', 'daemon:x:1:', 'sudo:x:27:sam', 'sam:x:1000:', 'alice:x:1001:', ''].join('\n');

  it('recognizes user-private groups, including the owner listed as a member', () => {
    expect(isUserPrivateGroup(1000, 1000, { passwd: debianPasswd, group: debianGroup })).toBe(true);
    expect(isUserPrivateGroup(0, 0, { passwd: debianPasswd, group: debianGroup })).toBe(true);
    const selfListed = debianGroup.replace('sam:x:1000:', 'sam:x:1000:sam');
    expect(isUserPrivateGroup(1000, 1000, { passwd: debianPasswd, group: selfListed })).toBe(true);
    const crlf = { passwd: debianPasswd.replaceAll('\n', '\r\n'), group: debianGroup.replaceAll('\n', '\r\n') };
    expect(isUserPrivateGroup(1000, 1000, crlf)).toBe(true);
  });

  it('refuses shared, foreign, ambiguous and unknown groups', () => {
    const accounts = { passwd: debianPasswd, group: debianGroup };
    // Another account's private group, or a group the owner merely belongs to.
    expect(isUserPrivateGroup(1000, 1001, accounts)).toBe(false);
    expect(isUserPrivateGroup(1000, 27, accounts)).toBe(false);
    // Another member, or another account with it as its primary group (RHEL's sync/halt share gid 0).
    expect(
      isUserPrivateGroup(1000, 1000, {
        ...accounts,
        group: debianGroup.replace('sam:x:1000:', 'sam:x:1000:alice'),
      }),
    ).toBe(false);
    expect(isUserPrivateGroup(0, 0, { ...accounts, passwd: `${debianPasswd}sync:x:5:0:sync:/sbin:/bin/sync\n` })).toBe(
      false,
    );
    // Duplicate entries for the gid, an unknown member, no entry, an unknown owner.
    expect(isUserPrivateGroup(1000, 1000, { ...accounts, group: `${debianGroup}staff:x:1000:\n` })).toBe(false);
    expect(
      isUserPrivateGroup(1000, 1000, {
        ...accounts,
        group: debianGroup.replace('sam:x:1000:', 'sam:x:1000:ldapuser'),
      }),
    ).toBe(false);
    expect(isUserPrivateGroup(1000, 1000, { ...accounts, group: debianGroup.replace('sam:x:1000:\n', '') })).toBe(
      false,
    );
    expect(isUserPrivateGroup(4242, 4242, accounts)).toBe(false);
    // NIS compat entries and malformed lines leave membership unknown.
    expect(isUserPrivateGroup(1000, 1000, { ...accounts, group: `${debianGroup}+:::\n` })).toBe(false);
    expect(isUserPrivateGroup(1000, 1000, { ...accounts, passwd: `${debianPasswd}-@netgroup::::::\n` })).toBe(false);
    expect(isUserPrivateGroup(1000, 1000, { ...accounts, passwd: `${debianPasswd}broken:x:abc:1000\n` })).toBe(false);
  });
});
