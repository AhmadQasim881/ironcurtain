/**
 * Identity-based containment in validateWorkspacePath() on volumes where
 * differently spelled paths reach the same directory (macOS APFS, DrvFs under
 * WSL, casefold ext4/tmpfs directories). A plain string comparison accepted
 * `~/.IronCurtain` there although it IS the IronCurtain home.
 *
 * CI volumes are case-sensitive, so most tests here simulate such a volume:
 * each alias spelling exists as a real directory (so realpath and isDirectory
 * behave), while `statSync` reports the (st_dev, st_ino) of the directory the
 * alias reaches on a case-insensitive volume. The last test uses a real
 * case-insensitive temp volume when one is available.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { validateWorkspacePath } from '../src/session/workspace-validation.js';

const fsAliases = vi.hoisted(() => ({
  /** alias directory -> the directory it denotes on the simulated volume */
  map: new Map<string, string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const resolveAlias = (path: string): string => {
    for (const [alias, target] of fsAliases.map) {
      if (path === alias) return target;
      if (path.startsWith(`${alias}/`)) return target + path.slice(alias.length);
    }
    return path;
  };
  const statSync = ((path: import('node:fs').PathLike, options?: import('node:fs').StatSyncOptions) =>
    actual.statSync(resolveAlias(String(path)), options)) as typeof actual.statSync;
  return { ...actual, statSync };
});

/**
 * Creates `aliasPath` as a real directory and makes stat report `target`'s
 * identity for it (and `target/x` for `aliasPath/x`). Callers create any
 * subdirectory they use on both sides, as it would exist once on a real
 * case-insensitive volume.
 */
function alias(aliasPath: string, target: string): void {
  mkdirSync(aliasPath, { recursive: true });
  fsAliases.map.set(aliasPath, target);
}

describe('validateWorkspacePath on a simulated case-insensitive volume', () => {
  let root: string;
  let userHome: string;
  let icHome: string;
  const savedEnv = { HOME: process.env.HOME, IRONCURTAIN_HOME: process.env.IRONCURTAIN_HOME };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-ws-identity-')));
    userHome = join(root, 'Users', 'me');
    icHome = join(userHome, '.ironcurtain');
    mkdirSync(join(icHome, 'generated'), { recursive: true });
    mkdirSync(join(icHome, 'sessions', 'abc', 'sandbox'), { recursive: true });
    mkdirSync(join(userHome, 'project'), { recursive: true });
    process.env.HOME = userHome;
    delete process.env.IRONCURTAIN_HOME;
  });

  afterEach(() => {
    fsAliases.map.clear();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a case variant of the IronCurtain home', () => {
    alias(join(userHome, '.IronCurtain'), icHome);
    expect(() => validateWorkspacePath('~/.IronCurtain', [])).toThrow('inside the IronCurtain home directory');
  });

  it('rejects a directory inside a case variant of the IronCurtain home', () => {
    alias(join(userHome, '.IRONCURTAIN'), icHome);
    mkdirSync(join(userHome, '.IRONCURTAIN', 'generated'), { recursive: true });
    expect(() => validateWorkspacePath('~/.IRONCURTAIN/generated', [])).toThrow(
      'inside the IronCurtain home directory',
    );
  });

  it('rejects a case variant of $HOME and of its parent', () => {
    alias(join(root, 'Users', 'ME'), userHome);
    expect(() => validateWorkspacePath(join(root, 'Users', 'ME'), [])).toThrow(
      'Cannot use home directory as workspace',
    );

    alias(join(root, 'USERS'), join(root, 'Users'));
    expect(() => validateWorkspacePath(join(root, 'USERS'), [])).toThrow('contains the home directory');
  });

  it('rejects case variants of protected paths in both directions', () => {
    const secrets = join(root, 'secrets');
    mkdirSync(join(secrets, 'sub'), { recursive: true });
    alias(join(root, 'SECRETS'), secrets);
    mkdirSync(join(root, 'SECRETS', 'sub'));
    expect(() => validateWorkspacePath(join(root, 'SECRETS', 'sub'), [secrets])).toThrow(
      'overlaps with protected path',
    );

    const keys = join(root, 'data', 'keys');
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(keys, 'id'), 'k');
    alias(join(root, 'Data'), join(root, 'data'));
    expect(() => validateWorkspacePath(join(root, 'Data'), [join(keys, 'id')])).toThrow('contains protected path');
  });

  it('computes the managed-workspace exemption from the entry point that matched by identity', () => {
    alias(join(userHome, '.IronCurtain'), icHome);
    mkdirSync(join(userHome, '.IronCurtain', 'sessions', 'abc', 'sandbox'), { recursive: true });
    const variantSandbox = join(userHome, '.IronCurtain', 'sessions', 'abc', 'sandbox');
    // The variant spelling denotes the real session sandbox, so it is allowed...
    expect(validateWorkspacePath(variantSandbox, [icHome])).toBe(variantSandbox);
    // ...but the exemption itself is matched by exact spelling (allowlist).
    mkdirSync(join(icHome, 'Sessions', 'abc', 'sandbox'), { recursive: true });
    mkdirSync(join(userHome, '.IronCurtain', 'Sessions', 'abc', 'sandbox'), { recursive: true });
    expect(() => validateWorkspacePath(join(userHome, '.IronCurtain', 'Sessions', 'abc', 'sandbox'), [])).toThrow(
      'IronCurtain home',
    );
  });

  it('uses the innermost identity match, so a re-exposed home cannot borrow an outer exemption', () => {
    // Simulates the IronCurtain home bind-mounted again inside a session sandbox.
    const mountPoint = join(icHome, 'sessions', 'abc', 'sandbox', 'mnt');
    alias(mountPoint, icHome);
    mkdirSync(join(mountPoint, 'generated'), { recursive: true });
    expect(() => validateWorkspacePath(join(mountPoint, 'generated'), [])).toThrow(
      'inside the IronCurtain home directory',
    );
  });

  it('still accepts an unrelated project', () => {
    expect(validateWorkspacePath('~/project', [icHome])).toBe(join(userHome, 'project'));
  });

  describe('with the macOS Data volume also reachable at /System/Volumes/Data', () => {
    // On macOS the Data volume is mounted at /System/Volumes/Data and
    // firmlinked into /Users, /private, ... so /System/Volumes/Data<home> IS
    // the home directory, while /System/Volumes/Data, /System/Volumes and
    // /System are not on the home's canonical path at all. The simulated
    // layout maps those directories to distinct stand-ins (nothing is created
    // outside the temp dir), most specific alias first.
    function mapSystemVolumes(options: { firmlinked: boolean }): void {
      if (options.firmlinked) fsAliases.map.set(`/System/Volumes/Data${root}`, root);
      for (const [systemPath, standIn] of [
        ['/System/Volumes/Data', 'data-volume-root'],
        ['/System/Volumes', 'system-volumes'],
        ['/System', 'system'],
      ]) {
        mkdirSync(join(root, standIn));
        fsAliases.map.set(systemPath, join(root, standIn));
      }
    }

    it.each(['/System/Volumes/Data', '/System/Volumes', '/System'])(
      'rejects %s, which contains the home directory through the firmlink',
      (candidate) => {
        mapSystemVolumes({ firmlinked: true });
        expect(() => validateWorkspacePath(candidate, [])).toThrow('contains the home directory');
      },
    );

    it('rejects an alias-only ancestor of the IronCurtain home and of protected paths', () => {
      mapSystemVolumes({ firmlinked: true });
      // HOME lives outside the firmlinked tree, so only the IronCurtain home
      // and the protected entry are reachable through the alias.
      const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ic-ws-identity-elsewhere-')));
      try {
        process.env.HOME = elsewhere;
        process.env.IRONCURTAIN_HOME = icHome;
        expect(() => validateWorkspacePath('/System/Volumes/Data', [])).toThrow(
          'contains the IronCurtain home directory',
        );

        delete process.env.IRONCURTAIN_HOME;
        const secrets = join(root, 'secrets');
        mkdirSync(secrets);
        expect(() => validateWorkspacePath('/System/Volumes', [secrets])).toThrow('contains protected path');
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('still accepts a project spelled through the alias', () => {
      mapSystemVolumes({ firmlinked: true });
      const aliasProject = `/System/Volumes/Data${join(userHome, 'project')}`;
      expect(validateWorkspacePath(aliasProject, [icHome])).toBe(aliasProject);
    });

    it('ignores the alias prefix when it does not reach the same directory', () => {
      // e.g. any Linux host, or a root outside the Data volume.
      mapSystemVolumes({ firmlinked: false });
      expect(validateWorkspacePath('/System/Volumes/Data', [])).toBe('/System/Volumes/Data');
    });
  });
});

/** True when `dir` lives on a case-insensitive volume. */
function isCaseInsensitive(dir: string): boolean {
  let probe: string | undefined;
  try {
    probe = mkdtempSync(join(dir, 'CaseProbe-'));
    return existsSync(join(dirname(probe), basename(probe).toLowerCase()));
  } catch {
    return false;
  } finally {
    if (probe !== undefined) rmSync(probe, { recursive: true, force: true });
  }
}

describe.runIf(isCaseInsensitive(tmpdir()))('validateWorkspacePath on a real case-insensitive volume', () => {
  it('rejects a case variant of the IronCurtain home', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-ws-ci-')));
    const savedHome = process.env.HOME;
    const savedIcHome = process.env.IRONCURTAIN_HOME;
    try {
      const userHome = join(root, 'me');
      mkdirSync(join(userHome, '.ironcurtain'), { recursive: true });
      process.env.HOME = userHome;
      delete process.env.IRONCURTAIN_HOME;
      expect(() => validateWorkspacePath(join(userHome, '.IronCurtain'), [])).toThrow('IronCurtain home');
      expect(() => validateWorkspacePath(join(root, 'ME'), [])).toThrow('home directory');
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedIcHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = savedIcHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
