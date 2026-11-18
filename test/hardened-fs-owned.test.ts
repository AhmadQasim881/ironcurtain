/**
 * Owner-checked reads for inputs that decide what an agent may do
 * (`readOwnedRegularFile`, `assertTrustedDirectoryChain` in
 * src/hardened-fs.ts): no symlink at the final component, regular files only,
 * and the StrictModes-like owner and mode rules of `readPackageAsset`.
 *
 * The account database is injected where group-writability matters, so no
 * outcome depends on the runner's /etc/group. Tests that need an entry owned
 * by another user run only as root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertTrustedDirectoryChain, readOwnedRegularFile, type AccountDatabase } from '../src/hardened-fs.js';
import { fifoSupported, makeFifo, startFifoUnblocker } from './helpers/fifo.js';

const EUID = process.geteuid?.() ?? -1;
const EGID = process.getegid?.() ?? -1;
const RUNS_AS_ROOT = EUID === 0;
const OTHER_UID = 65534;

/** The runner's own account, whose private group is its gid. */
const PRIVATE_GROUP: AccountDatabase = {
  passwd: `owner:x:${EUID}:${EGID}::/home/owner:/bin/sh\n`,
  group: `owner:x:${EGID}:\n`,
};
/** The runner's group is shared with a second account. */
const SHARED_GROUP: AccountDatabase = {
  passwd: `owner:x:${EUID}:${EGID}::/home/owner:/bin/sh\nother:x:${EUID + 1}:${EGID + 1}::/home/other:/bin/sh\n`,
  group: `owner:x:${EGID}:other\nother:x:${EGID + 1}:\n`,
};

describe('readOwnedRegularFile', () => {
  let dir: string;
  const options = { label: 'Policy artifact', minBytes: 0, maxBytes: 1024 };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-owned-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, content = '{"rules":[]}', mode = 0o644): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
  }

  it('reads a regular file the current user owns', () => {
    expect(readOwnedRegularFile(file('policy.json'), options).toString('utf8')).toBe('{"rules":[]}');
  });

  it('refuses a symlink, even to a file that would pass', () => {
    const target = file('real.json');
    const link = join(dir, 'policy.json');
    symlinkSync(target, link);

    expect(() => readOwnedRegularFile(link, options)).toThrow(
      `Policy artifact must be a readable regular non-symlink file: ${link}`,
    );
  });

  it('marks a missing file with its errno code', () => {
    expect(() => readOwnedRegularFile(join(dir, 'missing.json'), options)).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });

  it('refuses a directory', () => {
    mkdirSync(join(dir, 'sub'));
    expect(() => readOwnedRegularFile(join(dir, 'sub'), options)).toThrow(/must be a regular file/);
  });

  it.runIf(fifoSupported)('refuses a FIFO without blocking on it', () => {
    const fifo = join(dir, 'policy.json');
    makeFifo(fifo);
    const unblocker = startFifoUnblocker(fifo);
    const started = Date.now();
    try {
      expect(() => readOwnedRegularFile(fifo, options)).toThrow(/must be a regular file/);
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses a world-writable file and a file group-writable by a shared group', () => {
    expect(() => readOwnedRegularFile(file('world.json', '{}', 0o666), options)).toThrow(
      /Policy artifact must not be world-writable: .*Fix it with: chmod o-w/,
    );
    const groupWritable = file('group.json', '{}', 0o664);
    expect(() => readOwnedRegularFile(groupWritable, { ...options, accounts: SHARED_GROUP })).toThrow(
      /Policy artifact is group-writable and its group .* is not the private group of its owner/,
    );
    // A umask 002 file whose group is its owner's private group is fine.
    expect(readOwnedRegularFile(groupWritable, { ...options, accounts: PRIVATE_GROUP }).toString('utf8')).toBe('{}');
  });

  it('refuses a file larger than the limit', () => {
    expect(() => readOwnedRegularFile(file('big.json', 'x'.repeat(2048)), options)).toThrow(
      /size is outside the allowed range/,
    );
  });

  it.runIf(RUNS_AS_ROOT)('refuses a file another user owns unless that owner is trusted', () => {
    const path = file('other.json');
    chownSync(path, OTHER_UID, EGID);

    expect(() => readOwnedRegularFile(path, options)).toThrow(
      `Policy artifact is owned by uid ${OTHER_UID}, not by root or the current user (uid 0): ${path}`,
    );
    expect(
      readOwnedRegularFile(path, {
        ...options,
        trustedOwners: [{ uid: OTHER_UID, description: 'the package owner' }],
      }).toString('utf8'),
    ).toBe('{"rules":[]}');
  });
});

describe('assertTrustedDirectoryChain', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-chain-')));
    chmodSync(root, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const options = (): { label: string; root: string; rootDescription: string } => ({
    label: 'policyDir',
    root,
    rootDescription: 'the IronCurtain home',
  });

  it('accepts a chain the current user owns', () => {
    const leaf = join(root, 'personas', 'coder', 'generated');
    mkdirSync(leaf, { recursive: true, mode: 0o755 });
    expect(() => assertTrustedDirectoryChain(leaf, options())).not.toThrow();
  });

  it('refuses a world-writable directory anywhere up to the root', () => {
    const leaf = join(root, 'personas', 'coder', 'generated');
    mkdirSync(leaf, { recursive: true, mode: 0o755 });
    chmodSync(join(root, 'personas'), 0o777);
    expect(() => assertTrustedDirectoryChain(leaf, options())).toThrow(
      `policyDir is in a world-writable directory: ${join(root, 'personas')}`,
    );
    chmodSync(join(root, 'personas'), 0o755);
    chmodSync(root, 0o777);
    expect(() => assertTrustedDirectoryChain(leaf, options())).toThrow(/world-writable directory/);
  });

  it('refuses a directory outside the root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ironcurtain-chain-outside-'));
    try {
      expect(() => assertTrustedDirectoryChain(outside, options())).toThrow(/policyDir is not below/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.runIf(RUNS_AS_ROOT)("trusts the root's owner, and no other user", () => {
    const leaf = join(root, 'generated');
    mkdirSync(leaf, { mode: 0o755 });
    chownSync(leaf, OTHER_UID, EGID);
    expect(() => assertTrustedDirectoryChain(leaf, options())).toThrow(
      `policyDir is in a directory owned by uid ${OTHER_UID}, not by root, the current user (uid 0) or the owner of the IronCurtain home (uid 0): ${leaf}`,
    );
    chownSync(root, OTHER_UID, EGID);
    expect(() => assertTrustedDirectoryChain(leaf, options())).not.toThrow();
  });
});
