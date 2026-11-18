import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBundlePrivilegedFileScanner,
  createHostMountPrivilegeScanner,
  describeHostMountPrivilegeScan,
  deliverHostPrivilegedFilesDiagnostic,
  hostPrivilegedFilesNotice,
  hostWritableMountRoots,
  scanHostMountPrivileges,
  stripSetuidSetgidNoFollow,
  type HostMountPrivilegeScanReport,
  type PrivilegedEntry,
} from '../../src/docker/host-mount-privilege-scan.js';
import * as logger from '../../src/logger.js';

const ownUid = process.getuid?.() ?? 1000;
/** A UID no file has: keeps root-owned reporting out of tests that run as root. */
const NO_SUCH_UID = 0xfffffff0;

function mode(path: string): number {
  return statSync(path).mode & 0o7777;
}

function plantFile(path: string, fileMode: number): void {
  writeFileSync(path, '#!/bin/sh\necho planted\n');
  chmodSync(path, fileMode);
}

describe.skipIf(process.platform !== 'linux')('host-mount privilege scan (DINF-3)', () => {
  let base: string;
  let workspace: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ic-privilege-scan-'));
    workspace = join(base, 'workspace');
    mkdirSync(workspace);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  const roots = () => [{ hostPath: workspace, containerPath: '/workspace' }];

  it("strips setuid and setgid bits from the host user's files, keeping every other mode bit", async () => {
    mkdirSync(join(workspace, '.git', 'hooks'), { recursive: true });
    plantFile(join(workspace, 'planted'), 0o4755);
    plantFile(join(workspace, '.git', 'hooks', 'pre-commit'), 0o6750);
    plantFile(join(workspace, 'group-only'), 0o2711);
    plantFile(join(workspace, 'ordinary'), 0o755);

    const result = await scanHostMountPrivileges(roots(), { rootUid: NO_SUCH_UID });

    expect(mode(join(workspace, 'planted'))).toBe(0o755);
    expect(mode(join(workspace, '.git', 'hooks', 'pre-commit'))).toBe(0o750);
    expect(mode(join(workspace, 'group-only'))).toBe(0o711);
    expect(mode(join(workspace, 'ordinary'))).toBe(0o755);
    expect(result.stripped.map((entry) => [entry.path, entry.mode]).sort()).toEqual(
      [
        [join(workspace, '.git', 'hooks', 'pre-commit'), 0o6750],
        [join(workspace, 'group-only'), 0o2711],
        [join(workspace, 'planted'), 0o4755],
      ].sort(),
    );
    expect(result.unstripped).toEqual([]);
    expect(result.rootOwned).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.scannedEntries).toBe(6); // .git, hooks, pre-commit, planted, group-only, ordinary
  });

  it('reports setuid files and entries it cannot change (root-owned) and leaves them untouched', async () => {
    // Simulate files root planted: they belong to "root" and not to the host user.
    mkdirSync(join(workspace, 'bin'));
    plantFile(join(workspace, 'bin', 'shell'), 0o4755);
    writeFileSync(join(workspace, 'owned-by-root'), 'x');

    const result = await scanHostMountPrivileges(roots(), { rootUid: ownUid, hostUid: NO_SUCH_UID });

    expect(mode(join(workspace, 'bin', 'shell'))).toBe(0o4755);
    expect(result.stripped).toEqual([]);
    expect(result.unstripped).toEqual([
      expect.objectContaining({ path: join(workspace, 'bin', 'shell'), mode: 0o4755, reason: 'owned by root' }),
    ]);
    // The simulated "root" also owns the mount root itself, which is reported too.
    expect(result.rootOwned.map((entry) => entry.path).sort()).toEqual(
      [realpathSync(workspace), join(workspace, 'bin'), join(workspace, 'owned-by-root')].sort(),
    );
    expect(result.rootOwned.find((entry) => entry.path === join(workspace, 'bin'))?.kind).toBe('directory');
  });

  it('reports a mount root that container root chowned, once even when two mounts name it', async () => {
    // Container root can chown the workspace directory itself (the user then
    // cannot write their own workspace) although it can never replace it.
    // The root is never one of the listed entries, so it is checked on its own.
    const symlinkedRoot = join(base, 'workspace-link');
    symlinkSync(workspace, symlinkedRoot);

    const result = await scanHostMountPrivileges(
      [...roots(), { hostPath: symlinkedRoot, containerPath: '/workspace-again' }],
      { rootUid: ownUid, hostUid: NO_SUCH_UID },
    );

    expect(result.rootOwned).toHaveLength(1);
    expect(result.rootOwned[0]).toMatchObject({ path: realpathSync(workspace), kind: 'directory', uid: ownUid });
    expect(result.scannedEntries).toBe(0);
    expect(result.complete).toBe(true);
    expect(describeHostMountPrivilegeScan(result, 'session end')).toEqual([
      expect.stringContaining('1 root-owned entry in agent-writable mounts'),
    ]);

    // A root the host user owns is not a finding.
    const owned = await scanHostMountPrivileges(roots(), { rootUid: NO_SUCH_UID });
    expect(owned.rootOwned).toEqual([]);
  });

  it('never follows a symlink, for files or directories, so host files outside the mount keep their mode', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    plantFile(join(outside, 'victim'), 0o4755);
    mkdirSync(join(outside, 'tree'));
    plantFile(join(outside, 'tree', 'deep-victim'), 0o2755);
    symlinkSync(join(outside, 'victim'), join(workspace, 'file-link'));
    symlinkSync(outside, join(workspace, 'dir-link'));

    const result = await scanHostMountPrivileges(roots(), { rootUid: NO_SUCH_UID });

    expect(mode(join(outside, 'victim'))).toBe(0o4755);
    expect(mode(join(outside, 'tree', 'deep-victim'))).toBe(0o2755);
    expect(result.stripped).toEqual([]);
    expect(result.unstripped).toEqual([]);
    expect(result.scannedEntries).toBe(2);
    expect(result.complete).toBe(true);
  });

  it('leaves a planted file alone when it is swapped for a symlink or another file before the chmod', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    plantFile(join(outside, 'host-file'), 0o4755);
    const planted = join(workspace, 'planted');
    plantFile(planted, 0o4755);
    const seen = lstatSync(planted);

    // Swapped for a symlink to a host file: the no-follow open pins the link.
    rmSync(planted);
    symlinkSync(join(outside, 'host-file'), planted);
    expect(await stripSetuidSetgidNoFollow(planted, seen)).toBe('it changed during the scan');
    expect(mode(join(outside, 'host-file'))).toBe(0o4755);

    // Swapped for another regular file: a different inode is not touched either.
    rmSync(planted);
    plantFile(join(workspace, 'replacement'), 0o4755);
    renameSync(join(workspace, 'replacement'), planted);
    expect(await stripSetuidSetgidNoFollow(planted, seen)).toBe('it changed during the scan');
    expect(mode(planted)).toBe(0o4755);

    // The inode that was seen is stripped through its own descriptor.
    expect(await stripSetuidSetgidNoFollow(planted, lstatSync(planted))).toBeUndefined();
    expect(mode(planted)).toBe(0o755);
  });

  it('does not open a FIFO or block on it', async () => {
    execFileSync('mkfifo', [join(workspace, 'pipe')]);
    plantFile(join(workspace, 'after-pipe'), 0o4700);

    const result = await scanHostMountPrivileges(roots(), { rootUid: NO_SUCH_UID });

    expect(result.complete).toBe(true);
    expect(result.stripped.map((entry) => entry.path)).toEqual([join(workspace, 'after-pipe')]);
    expect(mode(join(workspace, 'after-pipe'))).toBe(0o700);
  });

  it('stops at the entry bound and reports the scan as incomplete', async () => {
    for (let index = 0; index < 30; index++) writeFileSync(join(workspace, `file-${index}`), '');

    const result = await scanHostMountPrivileges(roots(), { rootUid: NO_SUCH_UID, maxEntries: 10, concurrency: 4 });

    expect(result.scannedEntries).toBe(10);
    expect(result.complete).toBe(false);
    expect(describeHostMountPrivilegeScan(result, 'test')).toEqual([
      expect.stringContaining('incomplete after 10 entries (entry limit reached)'),
    ]);
  });

  it('caps each listed category and counts the rest', async () => {
    for (let index = 0; index < 5; index++) plantFile(join(workspace, `planted-${index}`), 0o4755);

    const result = await scanHostMountPrivileges(roots(), { rootUid: NO_SUCH_UID, maxListed: 2 });

    expect(result.stripped).toHaveLength(2);
    expect(result.omitted).toBe(3);
    // Every file was still neutralized; only the report is bounded.
    for (let index = 0; index < 5; index++) expect(mode(join(workspace, `planted-${index}`))).toBe(0o755);
  });

  it('ignores a mount source that teardown already removed', async () => {
    const result = await scanHostMountPrivileges([{ hostPath: join(base, 'gone'), containerPath: '/gone' }]);
    expect(result).toMatchObject({ scannedEntries: 0, complete: true, unreadable: [] });
  });

  it.skipIf(ownUid === 0)('reports a directory it cannot list instead of failing', async () => {
    mkdirSync(join(workspace, 'locked'));
    chmodSync(join(workspace, 'locked'), 0);
    try {
      const result = await scanHostMountPrivileges(roots(), { rootUid: NO_SUCH_UID });
      expect(result.complete).toBe(false);
      expect(result.unreadable).toEqual([
        { path: join(workspace, 'locked'), reason: expect.stringContaining('EACCES') as unknown },
      ]);
    } finally {
      chmodSync(join(workspace, 'locked'), 0o700);
    }
  });

  it('escapes control characters in reported names and reports a lasting finding once per scanner', async () => {
    plantFile(join(workspace, 'evil\nname'), 0o4755);
    const result = await scanHostMountPrivileges(roots(), { rootUid: ownUid, hostUid: NO_SUCH_UID });
    const reported = new Set<string>();

    const first = describeHostMountPrivilegeScan(result, 'after agent turn', reported);
    // One line for the unstripped file, one for the (simulated) root-owned mount root.
    expect(first).toHaveLength(2);
    expect(first[0]).toContain('could not be neutralized');
    expect(first[0]).toContain('evil\\nname');
    expect(first.join('\n')).not.toContain('evil\nname');
    expect(first[1]).toContain('1 root-owned entry');
    expect(describeHostMountPrivilegeScan(result, 'after agent turn', reported)).toEqual([]);
  });

  it('tells the caller which findings are new to the scanner, and the user is told about those after a turn', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    plantFile(join(workspace, 'shell'), 0o4755);
    // The simulated "root" owns the setuid shell and the mount root.
    const scanner = createHostMountPrivilegeScanner(roots(), { rootUid: ownUid, hostUid: NO_SUCH_UID });

    const first = await scanner.scan('after agent turn');
    const second = await scanner.scan('after agent turn');

    expect(first.when).toBe('after agent turn');
    expect(first.newFindings.unstripped.map((entry) => entry.path)).toEqual([join(workspace, 'shell')]);
    expect(first.newFindings.rootOwned.map((entry) => entry.path)).toEqual([realpathSync(workspace)]);
    // Still there, but reported already.
    expect(second.unstripped).toHaveLength(1);
    expect(second.newFindings).toEqual({ unstripped: [], rootOwned: [] });

    expect(hostPrivilegedFilesNotice(first, 'new')).toEqual({
      kind: 'host_privileged_files',
      when: 'after agent turn',
      stripped: 0,
      unstripped: 1,
      rootOwned: 1,
      unlisted: 0,
      paths: [join(workspace, 'shell'), realpathSync(workspace)],
      incomplete: false,
      hint: expect.stringContaining('remove them as root (for example with sudo rm)') as unknown,
    });
    expect(hostPrivilegedFilesNotice(second, 'new')).toBeUndefined();
    // At session end, everything left is reported again.
    expect(hostPrivilegedFilesNotice({ ...second, when: 'session end' }, 'all')).toMatchObject({
      when: 'session end',
      unstripped: 1,
      rootOwned: 1,
    });
  });

  it('reports a finding again after a turn when it was removed and planted again', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const shell = join(workspace, 'shell');
    plantFile(shell, 0o4755);
    const scanner = createHostMountPrivilegeScanner(roots(), { rootUid: ownUid, hostUid: NO_SUCH_UID });

    expect((await scanner.scan('after agent turn')).newFindings.unstripped.map((entry) => entry.path)).toEqual([shell]);
    // The user removed it as root after the notice ...
    rmSync(shell);
    expect((await scanner.scan('after agent turn')).unstripped).toEqual([]);
    // ... and a later turn planted the same file again: the user must hear of it now, not only at session end.
    plantFile(shell, 0o4755);
    const replanted = await scanner.scan('after agent turn');

    expect(replanted.newFindings.unstripped.map((entry) => entry.path)).toEqual([shell]);
    // The mount root never went away: still reported only once.
    expect(replanted.newFindings.rootOwned).toEqual([]);
    expect(hostPrivilegedFilesNotice(replanted, 'new')).toMatchObject({ unstripped: 1, rootOwned: 0, paths: [shell] });
  });

  it('keeps a finding reported while an incomplete scan cannot tell whether it is gone', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const shell = join(workspace, 'shell');
    plantFile(shell, 0o4755);
    // The entry bound stops the second scan before it reaches the file.
    let maxEntries = 1_000;
    const scanner = createHostMountPrivilegeScanner(roots(), {
      rootUid: ownUid,
      hostUid: NO_SUCH_UID,
      get maxEntries() {
        return maxEntries;
      },
    });

    expect((await scanner.scan('after agent turn')).newFindings.unstripped).toHaveLength(1);
    maxEntries = 0;
    expect((await scanner.scan('after agent turn')).complete).toBe(false);
    maxEntries = 1_000;

    // Not taken for a new finding: no scan ever saw it gone.
    expect((await scanner.scan('after agent turn')).newFindings.unstripped).toEqual([]);
  });

  it('logs what each serialized scan changed', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    plantFile(join(workspace, 'planted'), 0o4755);
    const scanner = createHostMountPrivilegeScanner(roots(), { rootUid: NO_SUCH_UID });

    const [first, second] = await Promise.all([scanner.scan('after agent turn'), scanner.scan('session end')]);

    expect(first.stripped).toHaveLength(1);
    expect(second.stripped).toHaveLength(0);
    expect(mode(join(workspace, 'planted'))).toBe(0o755);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /^\[docker\] Host-mount privilege scan \(after agent turn\): removed setuid\/setgid bits from 1 file/u,
    );
  });
});

describe('host-writable mount roots', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ic-privilege-roots-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('keeps read-write directories only', () => {
    mkdirSync(join(base, 'workspace'));
    mkdirSync(join(base, 'orientation'));
    writeFileSync(join(base, 'apt.conf'), '');
    const roots = hostWritableMountRoots([
      { source: join(base, 'workspace'), target: '/workspace', readonly: false },
      { source: join(base, 'orientation'), target: '/etc/ironcurtain', readonly: true },
      { source: join(base, 'apt.conf'), target: '/etc/apt/apt.conf.d/90-ironcurtain-proxy', readonly: false },
      { source: join(base, 'missing'), target: '/missing', readonly: false },
    ]);
    expect(roots).toEqual([{ hostPath: join(base, 'workspace'), containerPath: '/workspace' }]);
  });

  it('keeps a read-write directory named through a symlink, which Docker binds by its target', () => {
    mkdirSync(join(base, 'real-workspace'));
    symlinkSync(join(base, 'real-workspace'), join(base, 'workspace'));
    writeFileSync(join(base, 'file'), '');
    symlinkSync(join(base, 'file'), join(base, 'file-link'));
    const roots = hostWritableMountRoots([
      { source: join(base, 'workspace'), target: '/workspace', readonly: false },
      { source: join(base, 'file-link'), target: '/file', readonly: false },
    ]);
    expect(roots).toEqual([{ hostPath: join(base, 'workspace'), containerPath: '/workspace' }]);
  });

  it('creates a scanner only where container root is host root and something is writable', () => {
    mkdirSync(join(base, 'workspace'));
    const mounts = [{ source: join(base, 'workspace'), target: '/workspace', readonly: false }];
    expect(createBundlePrivilegedFileScanner({}, mounts)).toBeUndefined();
    expect(createBundlePrivilegedFileScanner({ containerRootIsHostRoot: false }, mounts)).toBeUndefined();
    expect(
      createBundlePrivilegedFileScanner({ containerRootIsHostRoot: true }, [{ ...mounts[0], readonly: true }]),
    ).toBeUndefined();
    expect(createBundlePrivilegedFileScanner({ containerRootIsHostRoot: true }, mounts)?.roots).toEqual([
      { hostPath: join(base, 'workspace'), containerPath: '/workspace' },
    ]);
  });
});

describe('the host-mount notice for the user', () => {
  it('keeps a finding visible when its diagnostic callback throws', () => {
    const output: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const notice = {
      kind: 'host_privileged_files' as const,
      when: 'example',
      rootOwned: 1,
      stripped: 0,
      unstripped: 0,
      unlisted: 0,
      paths: ['/workspace/example'],
      incomplete: false,
      hint: 'Inspect the example file.',
    };
    expect(() =>
      deliverHostPrivilegedFilesDiagnostic(notice, () => {
        throw new Error('Example callback failure');
      }),
    ).not.toThrow();
    expect(output.join('')).toContain('Inspect the example file.');
  });
  function report(overrides: Partial<HostMountPrivilegeScanReport> = {}): HostMountPrivilegeScanReport {
    return {
      scannedEntries: 10,
      complete: true,
      stripped: [],
      unstripped: [],
      rootOwned: [],
      unreadable: [],
      omitted: 0,
      when: 'after agent turn',
      newFindings: { unstripped: [], rootOwned: [] },
      ...overrides,
    };
  }
  const file = (path: string): PrivilegedEntry => ({ path, uid: 0, mode: 0o755, kind: 'file' });

  it('is absent for a scan that found nothing, or no scanner', () => {
    expect(hostPrivilegedFilesNotice(undefined, 'all')).toBeUndefined();
    expect(hostPrivilegedFilesNotice(report(), 'new')).toBeUndefined();
    expect(hostPrivilegedFilesNotice(report({ complete: false }), 'all')).toBeUndefined();
  });

  it('reports a strip after every turn: each is an action the scan took', () => {
    const stripped = [{ ...file('/w/planted'), uid: ownUid, mode: 0o4755 }];
    expect(hostPrivilegedFilesNotice(report({ stripped }), 'new')).toMatchObject({
      stripped: 1,
      unstripped: 0,
      rootOwned: 0,
      paths: ['/w/planted'],
      hint: expect.stringContaining('setuid/setgid bits are removed') as unknown,
    });
  });

  it('names at most five paths, unneutralized files first, and counts what the scan did not list', () => {
    const rootOwned = ['/w/a', '/w/b', '/w/c', '/w/d', '/w/e'].map(file);
    const unstripped = [{ ...file('/w/setuid'), mode: 0o4755, reason: 'owned by root' }];
    const notice = hostPrivilegedFilesNotice(
      report({ when: 'session end', unstripped, rootOwned, omitted: 7, complete: false }),
      'all',
    );
    expect(notice).toMatchObject({
      when: 'session end',
      unstripped: 1,
      rootOwned: 5,
      unlisted: 7,
      incomplete: true,
      paths: ['/w/setuid', '/w/a', '/w/b', '/w/c', '/w/d'],
    });
    // Root-owned entries only: they can be changed with sudo.
    expect(hostPrivilegedFilesNotice(report({ rootOwned }), 'all')?.hint).toContain('only sudo can change or remove');
  });

  it('escapes the control characters of agent-chosen names', () => {
    const esc = String.fromCharCode(0x1b);
    const notice = hostPrivilegedFilesNotice(report({ rootOwned: [file(`/w/x\n${esc}[2J`)] }), 'all');
    expect(notice?.paths).toEqual(['/w/x\\n\\u001b[2J']);
  });
});
