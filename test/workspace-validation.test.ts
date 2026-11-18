import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  isWorkspaceValidationError,
  validateWorkspacePath,
  WorkspaceValidationError,
} from '../src/session/workspace-validation.js';
import {
  computeProtectedPaths,
  getConfiguredAuditLogPath,
  getCwdDerivedProtectedPaths,
  getPackageGeneratedDir,
} from '../src/config/index.js';
import { getPackageConfigDir } from '../src/config/paths.js';
import { getPrivateScratchRoot } from '../src/trusted-process/spawn-cwd.js';

/** Runs `fn` with IRONCURTAIN_HOME temporarily set to `fakePath`, then restores it. */
function withIronCurtainHome(fakePath: string, fn: () => void): void {
  withEnv({ IRONCURTAIN_HOME: fakePath }, fn);
}

/** Runs `fn` with the given environment overrides (`undefined` unsets), then restores them. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Runs `fn` with the process working directory set to `dir`, then restores it. */
function withCwd(dir: string, fn: () => void): void {
  const original = process.cwd();
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(original);
  }
}

/** Captures the error `fn` throws (fails the test if it does not throw). */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected function to throw');
}

describe('validateWorkspacePath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'ic-workspace-test-')));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts a valid existing directory', () => {
    const workspace = join(tempDir, 'project');
    mkdirSync(workspace);
    const result = validateWorkspacePath(workspace, []);
    expect(result).toBe(realpathSync(workspace));
  });

  it('rejects a non-existent path', () => {
    const workspace = join(tempDir, 'does-not-exist');
    expect(() => validateWorkspacePath(workspace, [])).toThrow('does not exist');
  });

  it('rejects a file (not a directory)', () => {
    const filePath = join(tempDir, 'file.txt');
    writeFileSync(filePath, 'hello');
    expect(() => validateWorkspacePath(filePath, [])).toThrow('not a directory');
  });

  it('rejects the root directory', () => {
    expect(() => validateWorkspacePath('/', [])).toThrow('root directory');
  });

  it('rejects the home directory', () => {
    expect(() => validateWorkspacePath(homedir(), [])).toThrow('home directory');
  });

  it('rejects a path inside the IronCurtain home directory', () => {
    const fakeHome = join(tempDir, 'ic-home');
    mkdirSync(fakeHome, { recursive: true });
    const inside = join(fakeHome, 'sessions');
    mkdirSync(inside, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      expect(() => validateWorkspacePath(inside, [])).toThrow('IronCurtain home');
    });
  });

  it('rejects the IronCurtain home directory itself', () => {
    const fakeHome = join(tempDir, 'ic-home-self');
    mkdirSync(fakeHome, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      expect(() => validateWorkspacePath(fakeHome, [])).toThrow('IronCurtain home');
    });
  });

  it('rejects workspace inside a protected path', () => {
    const protectedDir = join(tempDir, 'protected');
    mkdirSync(protectedDir, { recursive: true });
    const workspace = join(protectedDir, 'sub');
    mkdirSync(workspace, { recursive: true });

    expect(() => validateWorkspacePath(workspace, [protectedDir])).toThrow('overlaps with protected path');
  });

  it('rejects a workspace that contains a protected path (the PolicyEngine exempts the whole workspace)', () => {
    const workspace = join(tempDir, 'broad');
    mkdirSync(workspace, { recursive: true });
    const protectedDir = join(workspace, 'secrets');
    mkdirSync(protectedDir, { recursive: true });

    expect(() => validateWorkspacePath(workspace, [protectedDir])).toThrow(
      `contains protected path: ${realpathSync(protectedDir)}`,
    );
  });

  it('rejects a workspace that contains a protected path that does not exist yet', () => {
    const workspace = join(tempDir, 'broad-missing');
    mkdirSync(workspace, { recursive: true });

    expect(() => validateWorkspacePath(workspace, [join(workspace, 'not-yet', 'credentials.json')])).toThrow(
      'contains protected path',
    );
  });

  it('resolves symlinks before validation', () => {
    const realDir = join(tempDir, 'real');
    mkdirSync(realDir, { recursive: true });
    const symlink = join(tempDir, 'link');
    symlinkSync(realDir, symlink);

    const result = validateWorkspacePath(symlink, []);
    // Should resolve to the real path
    expect(result).toBe(realpathSync(realDir));
  });

  it('accepts workspace that does not overlap with protected paths', () => {
    const workspace = join(tempDir, 'safe-project');
    mkdirSync(workspace, { recursive: true });
    const protectedDir = join(tempDir, 'protected-other');

    const result = validateWorkspacePath(workspace, [protectedDir]);
    expect(result).toBe(realpathSync(workspace));
  });

  it('allows persona workspace inside IronCurtain home', () => {
    const fakeHome = join(tempDir, 'ic-home');
    const personaWorkspace = join(fakeHome, 'personas', 'test-persona', 'workspace');
    mkdirSync(personaWorkspace, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      const result = validateWorkspacePath(personaWorkspace, []);
      expect(result).toBe(realpathSync(personaWorkspace));
    });
  });

  it('allows persona workspace when IronCurtain home is in protected paths', () => {
    const fakeHome = join(tempDir, 'ic-home');
    const personaWorkspace = join(fakeHome, 'personas', 'test-persona', 'workspace');
    mkdirSync(personaWorkspace, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      const result = validateWorkspacePath(personaWorkspace, [fakeHome]);
      expect(result).toBe(realpathSync(personaWorkspace));
    });
  });

  it('allows subdirectories within persona workspace', () => {
    const fakeHome = join(tempDir, 'ic-home');
    const subdir = join(fakeHome, 'personas', 'test-persona', 'workspace', 'project');
    mkdirSync(subdir, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      const result = validateWorkspacePath(subdir, [fakeHome]);
      expect(result).toBe(realpathSync(subdir));
    });
  });

  it('rejects non-workspace paths inside IronCurtain home', () => {
    const fakeHome = join(tempDir, 'ic-home');
    const sessions = join(fakeHome, 'sessions');
    mkdirSync(sessions, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      expect(() => validateWorkspacePath(sessions, [])).toThrow('IronCurtain home');
    });
  });

  it('rejects nested persona paths with extra directory segments', () => {
    const fakeHome = join(tempDir, 'ic-home');
    const nestedWorkspace = join(fakeHome, 'personas', 'evil', 'deep', 'workspace');
    mkdirSync(nestedWorkspace, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      expect(() => validateWorkspacePath(nestedWorkspace, [])).toThrow('IronCurtain home');
    });
  });

  it('rejects persona generated dir', () => {
    const fakeHome = join(tempDir, 'ic-home');
    const generated = join(fakeHome, 'personas', 'test-persona', 'generated');
    mkdirSync(generated, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      expect(() => validateWorkspacePath(generated, [])).toThrow('IronCurtain home');
    });
  });

  it('allows session sandbox', () => {
    const fakeHome = join(tempDir, 'ic-home');
    const sandbox = join(fakeHome, 'sessions', 'abc123', 'sandbox');
    mkdirSync(sandbox, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      const result = validateWorkspacePath(sandbox, [fakeHome]);
      expect(result).toBe(realpathSync(sandbox));
    });
  });

  it('rejects non-sandbox session paths', () => {
    const fakeHome = join(tempDir, 'ic-home');
    const escalations = join(fakeHome, 'sessions', 'abc123', 'escalations');
    mkdirSync(escalations, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      expect(() => validateWorkspacePath(escalations, [fakeHome])).toThrow('IronCurtain home');
    });
  });

  // -------------------------------------------------------------------------
  // The user's home directory and its ancestors
  // -------------------------------------------------------------------------

  describe('with a fake $HOME', () => {
    let fakeUserHome: string;

    beforeEach(() => {
      fakeUserHome = join(tempDir, 'home', 'alice');
      mkdirSync(join(fakeUserHome, '.ironcurtain'), { recursive: true });
      mkdirSync(join(fakeUserHome, 'project'), { recursive: true });
    });

    /** Runs `fn` with HOME=fakeUserHome and the default IronCurtain home (~/.ironcurtain). */
    function asAlice(fn: () => void): void {
      withEnv({ HOME: fakeUserHome, IRONCURTAIN_HOME: undefined }, fn);
    }

    it('rejects a parent of $HOME (like /home or /Users)', () => {
      asAlice(() => {
        expect(() => validateWorkspacePath(join(tempDir, 'home'), [])).toThrow('contains the home directory');
      });
    });

    it('rejects every further ancestor of $HOME', () => {
      asAlice(() => {
        expect(() => validateWorkspacePath(tempDir, [])).toThrow('contains the home directory');
      });
    });

    it('rejects -w ~', () => {
      asAlice(() => {
        expect(() => validateWorkspacePath('~', [])).toThrow('Cannot use home directory as workspace');
      });
    });

    it('rejects -w ~/.ironcurtain (the default IronCurtain home)', () => {
      asAlice(() => {
        expect(() => validateWorkspacePath('~/.ironcurtain', [])).toThrow('IronCurtain home');
      });
    });

    it('rejects a symlink to $HOME', () => {
      const link = join(tempDir, 'looks-harmless');
      symlinkSync(fakeUserHome, link);
      asAlice(() => {
        expect(() => validateWorkspacePath(link, [])).toThrow('Cannot use home directory as workspace');
      });
    });

    it('rejects a symlink to the IronCurtain home', () => {
      const link = join(fakeUserHome, 'project', 'frontend');
      symlinkSync(join(fakeUserHome, '.ironcurtain'), link);
      asAlice(() => {
        expect(() => validateWorkspacePath(link, [])).toThrow('IronCurtain home');
      });
    });

    it('rejects a case variant of a missing IronCurtain home by folded spelling', () => {
      // No ~/.ironcurtain yet, so there is no identity to compare: the
      // deny-side check falls back to the folded spelling. (On a
      // case-insensitive volume the variant IS the home and the identity
      // check rejects it instead.)
      rmSync(join(fakeUserHome, '.ironcurtain'), { recursive: true, force: true });
      mkdirSync(join(fakeUserHome, '.IronCurtain'), { recursive: true });
      asAlice(() => {
        expect(() => validateWorkspacePath('~/.IronCurtain', [])).toThrow('IronCurtain home');
      });
    });

    it('still accepts an ordinary project inside $HOME', () => {
      asAlice(() => {
        expect(validateWorkspacePath('~/project', [])).toBe(realpathSync(join(fakeUserHome, 'project')));
      });
    });
  });

  // -------------------------------------------------------------------------
  // The IronCurtain home and the user config file
  // -------------------------------------------------------------------------

  it('rejects a workspace that contains a custom IRONCURTAIN_HOME', () => {
    const workspace = join(tempDir, 'ci-checkout');
    const customHome = join(workspace, '.ironcurtain');
    mkdirSync(customHome, { recursive: true });

    withIronCurtainHome(customHome, () => {
      expect(() => validateWorkspacePath(workspace, [])).toThrow('contains the IronCurtain home directory');
    });
  });

  it('rejects every ancestor of the IronCurtain home', () => {
    const customHome = join(tempDir, 'a', 'b', 'ic-home');
    mkdirSync(customHome, { recursive: true });

    withIronCurtainHome(customHome, () => {
      expect(() => validateWorkspacePath(join(tempDir, 'a', 'b'), [])).toThrow('IronCurtain home');
      expect(() => validateWorkspacePath(join(tempDir, 'a'), [])).toThrow('IronCurtain home');
    });
  });

  it('rejects a workspace that contains the IronCurtain home through a symlinked parent', () => {
    const realParent = join(tempDir, 'real-parent');
    mkdirSync(join(realParent, 'ic-home'), { recursive: true });
    const linkedParent = join(tempDir, 'linked-parent');
    symlinkSync(realParent, linkedParent);

    // IRONCURTAIN_HOME is spelled through the symlink; the workspace is the real directory.
    withIronCurtainHome(join(linkedParent, 'ic-home'), () => {
      expect(() => validateWorkspacePath(realParent, [])).toThrow('contains the IronCurtain home directory');
    });
  });

  it('allows the default workflow workspace inside the IronCurtain home', () => {
    const fakeHome = join(tempDir, 'ic-home');
    const workspace = join(fakeHome, 'workflow-runs', 'wf-123', 'workspace');
    mkdirSync(join(workspace, 'src'), { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      expect(validateWorkspacePath(workspace, [fakeHome])).toBe(realpathSync(workspace));
      expect(validateWorkspacePath(join(workspace, 'src'), [fakeHome])).toBe(realpathSync(join(workspace, 'src')));
    });
  });

  it('rejects the rest of a workflow run directory', () => {
    const fakeHome = join(tempDir, 'ic-home');
    const runDir = join(fakeHome, 'workflow-runs', 'wf-123');
    mkdirSync(join(runDir, 'containers', 'bundle', 'escalations'), { recursive: true });
    mkdirSync(join(runDir, 'workspace'), { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      expect(() => validateWorkspacePath(join(fakeHome, 'workflow-runs'), [])).toThrow('IronCurtain home');
      expect(() => validateWorkspacePath(runDir, [])).toThrow('IronCurtain home');
      expect(() => validateWorkspacePath(join(runDir, 'containers', 'bundle', 'escalations'), [])).toThrow(
        'IronCurtain home',
      );
    });
  });

  it("allows a cron job's default workspace but not the rest of the job directory", () => {
    // Cron sessions record jobs/<id>/workspace in their metadata, and resume
    // re-validates it.
    const fakeHome = join(tempDir, 'ic-home');
    const jobDir = join(fakeHome, 'jobs', 'nightly');
    mkdirSync(join(jobDir, 'workspace', 'repo'), { recursive: true });
    mkdirSync(join(jobDir, 'generated'), { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      expect(validateWorkspacePath(join(jobDir, 'workspace'), [fakeHome])).toBe(
        realpathSync(join(jobDir, 'workspace')),
      );
      expect(validateWorkspacePath(join(jobDir, 'workspace', 'repo'), [fakeHome])).toBe(
        realpathSync(join(jobDir, 'workspace', 'repo')),
      );
      expect(() => validateWorkspacePath(jobDir, [])).toThrow('IronCurtain home');
      expect(() => validateWorkspacePath(join(jobDir, 'generated'), [])).toThrow('IronCurtain home');
      expect(() => validateWorkspacePath(join(fakeHome, 'jobs'), [])).toThrow('IronCurtain home');
    });
  });

  it('matches managed workspaces by exact spelling only', () => {
    const fakeHome = join(tempDir, 'ic-home');
    const variant = join(fakeHome, 'Sessions', 'abc123', 'sandbox');
    mkdirSync(variant, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      expect(() => validateWorkspacePath(variant, [])).toThrow('IronCurtain home');
    });
  });

  it('keeps protected entries nested inside the IronCurtain home in force for managed workspaces', () => {
    const fakeHome = join(tempDir, 'ic-home');
    const sandbox = join(fakeHome, 'sessions', 'abc123', 'sandbox');
    mkdirSync(sandbox, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      // The home-wide entry is waived for a managed workspace...
      expect(validateWorkspacePath(sandbox, [fakeHome])).toBe(realpathSync(sandbox));
      // ...but an entry inside the home that encloses the workspace is not.
      expect(() => validateWorkspacePath(sandbox, [fakeHome, join(fakeHome, 'sessions')])).toThrow(
        'overlaps with protected path',
      );
    });
  });

  // -------------------------------------------------------------------------
  // The package configuration directory
  // -------------------------------------------------------------------------

  /** Isolates the home checks so only the package rules can match. */
  function withIsolatedHomes(fn: () => void): void {
    const fakeUserHome = join(tempDir, 'home', 'bob');
    mkdirSync(fakeUserHome, { recursive: true });
    withEnv({ HOME: fakeUserHome, IRONCURTAIN_HOME: join(fakeUserHome, '.ironcurtain') }, fn);
  }

  it('rejects a workspace that contains the package configuration directory', () => {
    // e.g. `-w .` from a source checkout of the running IronCurtain.
    const packageRoot = dirname(dirname(getPackageConfigDir()));
    withIsolatedHomes(() => {
      expect(() => validateWorkspacePath(packageRoot, [])).toThrow(
        'contains the IronCurtain package configuration directory',
      );
      expect(() => validateWorkspacePath(getPackageConfigDir(), [])).toThrow(
        'IronCurtain package configuration directory',
      );
    });
  });

  it('rejects a workspace inside the package configuration directory', () => {
    withIsolatedHomes(() => {
      expect(() => validateWorkspacePath(getPackageGeneratedDir(), [])).toThrow(
        'inside the IronCurtain package configuration directory',
      );
    });
  });

  // -------------------------------------------------------------------------
  // The real protected-path list
  // -------------------------------------------------------------------------

  /** Exactly the protected-path list loadConfig() computes for the current cwd, without loading user config. */
  function loadConfigProtectedPaths(): string[] {
    return computeProtectedPaths({
      constitutionPath: resolve(getPackageConfigDir(), 'constitution.md'),
      generatedDir: getPackageGeneratedDir(),
      packageGeneratedDir: getPackageGeneratedDir(),
      mcpServersPath: resolve(getPackageConfigDir(), 'mcp-servers.json'),
      auditLogPath: './audit.jsonl',
    });
  }

  /**
   * Runs `fn` with a fresh IronCurtain home and `explicitEnvFile` as the
   * explicit credential file (IRONCURTAIN_ENV_FILE, which `--env-file` sets;
   * `undefined` means none), the trusted env files computeProtectedPaths() lists.
   */
  function withTrustedEnvFiles(explicitEnvFile: string | undefined, fn: () => void): void {
    const fakeHome = join(tempDir, 'ic-home');
    mkdirSync(fakeHome, { recursive: true });
    withEnv({ IRONCURTAIN_HOME: fakeHome, IRONCURTAIN_ENV_FILE: explicitEnvFile }, fn);
  }

  it('accepts -w . in a project that contains .env and audit.jsonl', () => {
    const project = join(tempDir, 'projects', 'app');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, '.env'), 'ANTHROPIC_API_KEY=placeholder\n');
    writeFileSync(join(project, 'audit.jsonl'), '');

    withTrustedEnvFiles(undefined, () => {
      withCwd(project, () => {
        const protectedPaths = loadConfigProtectedPaths();
        expect(protectedPaths).toContain(realpathSync(join(project, 'audit.jsonl')));
        // A .env in the launch directory is never loaded (trusted-env.ts), so
        // it is not protected and cannot stand in the way of `-w .`.
        expect(protectedPaths).not.toContain(realpathSync(join(project, '.env')));

        expect(validateWorkspacePath('.', protectedPaths)).toBe(realpathSync(project));
        // A parent of the launch directory contains the same cwd entries.
        expect(validateWorkspacePath('..', protectedPaths)).toBe(realpathSync(join(tempDir, 'projects')));
      });
    });
  });

  it('exempts only the cwd-relative entries computeProtectedPaths() adds', () => {
    const project = join(tempDir, 'projects', 'app');
    mkdirSync(project, { recursive: true });

    withTrustedEnvFiles(undefined, () => {
      withCwd(project, () => {
        const protectedPaths = loadConfigProtectedPaths();
        // The default audit log is the only entry derived from the cwd.
        expect(getCwdDerivedProtectedPaths()).toEqual([join(realpathSync(project), 'audit.jsonl')]);
        for (const entry of getCwdDerivedProtectedPaths()) {
          expect(protectedPaths).toContain(entry);
        }

        // Any other protected entry that happens to live in the launch
        // directory (e.g. an explicitly configured credentials file) is
        // still checked in both directions.
        const trustedFile = join(project, 'trusted.env');
        expect(() => validateWorkspacePath('.', [...protectedPaths, trustedFile])).toThrow(
          `contains protected path: ${realpathSync(project)}/trusted.env`,
        );
      });
    });
  });

  it('rejects -w . when the explicit --env-file is the .env in the launch directory', () => {
    // `ironcurtain --env-file .env start -w .`: the CLI exports the absolute
    // path as IRONCURTAIN_ENV_FILE and loads the real credentials from it, so
    // the file is trusted state rather than a cwd-derived entry. The workspace
    // (bind-mounted read-write in Docker Agent Mode) must not contain it.
    const project = join(tempDir, 'projects', 'app');
    mkdirSync(project, { recursive: true });
    const envFile = join(project, '.env');
    writeFileSync(envFile, 'ANTHROPIC_API_KEY=placeholder\n');

    withTrustedEnvFiles(envFile, () => {
      withCwd(project, () => {
        const protectedPaths = loadConfigProtectedPaths();
        expect(protectedPaths).toContain(realpathSync(envFile));

        expect(() => validateWorkspacePath('.', protectedPaths)).toThrow(
          `contains protected path: ${realpathSync(envFile)}`,
        );
        expect(() => validateWorkspacePath('..', protectedPaths)).toThrow(
          `contains protected path: ${realpathSync(envFile)}`,
        );
      });
    });
  });

  it('still rejects a workspace inside a cwd-derived protected entry', () => {
    const project = join(tempDir, 'project');
    const auditDir = join(project, 'audit.jsonl');
    mkdirSync(auditDir, { recursive: true });

    withCwd(project, () => {
      expect(getCwdDerivedProtectedPaths()).toContain(realpathSync(auditDir));
      expect(() => validateWorkspacePath(auditDir, [resolve('audit.jsonl')])).toThrow('overlaps with protected path');
    });
  });

  describe('with a relative AUDIT_LOG_PATH', () => {
    /** The protected-path list loadConfig() computes for the current cwd and AUDIT_LOG_PATH. */
    function protectedPathsWithAuditLog(): string[] {
      return computeProtectedPaths({
        constitutionPath: resolve(getPackageConfigDir(), 'constitution.md'),
        generatedDir: getPackageGeneratedDir(),
        packageGeneratedDir: getPackageGeneratedDir(),
        mcpServersPath: resolve(getPackageConfigDir(), 'mcp-servers.json'),
        auditLogPath: getConfiguredAuditLogPath(),
      });
    }

    it('accepts -w . when the configured audit log lies in the launch directory', () => {
      // loadConfig() protects AUDIT_LOG_PATH, but sessions never write it (each
      // has its own audit log), so it is a cwd-derived entry like the default.
      const project = join(tempDir, 'projects', 'app');
      mkdirSync(project, { recursive: true });

      withTrustedEnvFiles(undefined, () => {
        withEnv({ AUDIT_LOG_PATH: './logs/audit.jsonl' }, () => {
          withCwd(project, () => {
            const protectedPaths = protectedPathsWithAuditLog();
            const auditLog = join(realpathSync(project), 'logs', 'audit.jsonl');
            expect(protectedPaths).toContain(auditLog);
            expect(getCwdDerivedProtectedPaths()).toEqual([auditLog]);

            expect(validateWorkspacePath('.', protectedPaths)).toBe(realpathSync(project));
            expect(validateWorkspacePath('..', protectedPaths)).toBe(realpathSync(join(tempDir, 'projects')));
          });
        });
      });
    });

    it('keeps -w . working when the audit log is a dangling link through another link in the launch directory', () => {
      // audit.jsonl -> logs/current/audit.jsonl, logs/current -> missing: the
      // target and the second link lie in the workspace too, and are exempt
      // like the audit log itself, which sessions never use.
      const project = join(tempDir, 'projects', 'app');
      mkdirSync(join(project, 'logs'), { recursive: true });
      symlinkSync('missing', join(project, 'logs', 'current'));
      symlinkSync('logs/current/audit.jsonl', join(project, 'audit.jsonl'));

      withTrustedEnvFiles(undefined, () => {
        withEnv({ AUDIT_LOG_PATH: undefined }, () => {
          withCwd(project, () => {
            expect(validateWorkspacePath('.', protectedPathsWithAuditLog())).toBe(realpathSync(project));
          });
        });
      });
    });

    it('still rejects a workspace inside the configured audit log path', () => {
      const project = join(tempDir, 'project');
      const auditDir = join(project, 'logs', 'audit.jsonl');
      mkdirSync(auditDir, { recursive: true });

      withTrustedEnvFiles(undefined, () => {
        withEnv({ AUDIT_LOG_PATH: 'logs/audit.jsonl' }, () => {
          withCwd(project, () => {
            expect(() => validateWorkspacePath(auditDir, protectedPathsWithAuditLog())).toThrow(
              'overlaps with protected path',
            );
          });
        });
      });
    });

    it('exempts nothing for an absolute AUDIT_LOG_PATH, even one in the launch directory', () => {
      const project = join(tempDir, 'projects', 'app');
      mkdirSync(project, { recursive: true });
      const auditLog = join(realpathSync(project), 'audit.jsonl');

      withTrustedEnvFiles(undefined, () => {
        withEnv({ AUDIT_LOG_PATH: auditLog }, () => {
          withCwd(project, () => {
            expect(getCwdDerivedProtectedPaths()).toEqual([]);
            expect(() => validateWorkspacePath('.', protectedPathsWithAuditLog())).toThrow(
              `contains protected path: ${auditLog}`,
            );
          });
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // The relays' private scratch root
  // -------------------------------------------------------------------------

  describe('the private scratch root of the MCP relays', () => {
    // The relays keep srt settings, the sandboxed servers' working
    // directories and an OAuth server's credential files under
    // <os.tmpdir()>/ironcurtain-<uid>. A workspace of /tmp would hand all of
    // that to a Docker agent through the read-write bind mount.
    let scratchRoot: string;

    /** Runs `fn` with os.tmpdir() returning `tempDir`. */
    function withTempDirAsTmpdir(fn: () => void): void {
      withEnv({ TMPDIR: tempDir, TMP: undefined, TEMP: undefined }, fn);
    }

    beforeEach(() => {
      withTempDirAsTmpdir(() => {
        scratchRoot = getPrivateScratchRoot();
      });
      expect(dirname(scratchRoot)).toBe(tempDir);
    });

    it('rejects a workspace that contains the scratch root (such as /tmp)', () => {
      mkdirSync(scratchRoot, { mode: 0o700 });
      withTempDirAsTmpdir(() => {
        expect(captureError(() => validateWorkspacePath(tempDir, []))).toMatchObject({
          code: 'WORKSPACE_UNSAFE',
          message: expect.stringContaining('contains the private scratch directory') as unknown,
        });
      });
    });

    it('rejects a workspace that contains the scratch root before it exists', () => {
      withTempDirAsTmpdir(() => {
        expect(captureError(() => validateWorkspacePath(tempDir, []))).toMatchObject({
          code: 'WORKSPACE_UNSAFE',
          message: expect.stringContaining('contains the private scratch directory') as unknown,
        });
      });
    });

    it('rejects the scratch root itself, a directory inside it, and a symlink to one', () => {
      const relayDir = join(scratchRoot, 'srt-abc123');
      mkdirSync(join(relayDir, 'filesystem.cwd'), { recursive: true, mode: 0o700 });
      const link = join(tempDir, 'looks-harmless');
      symlinkSync(relayDir, link);

      withTempDirAsTmpdir(() => {
        for (const path of [scratchRoot, relayDir, join(relayDir, 'filesystem.cwd'), link]) {
          expect(captureError(() => validateWorkspacePath(path, []))).toMatchObject({
            code: 'WORKSPACE_UNSAFE',
            message: expect.stringContaining('private scratch directory') as unknown,
          });
        }
      });
    });

    it('still accepts a sibling of the scratch root', () => {
      mkdirSync(scratchRoot, { mode: 0o700 });
      const project = join(tempDir, 'project');
      mkdirSync(project);
      withTempDirAsTmpdir(() => {
        expect(validateWorkspacePath(project, [])).toBe(project);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Error shape
  // -------------------------------------------------------------------------

  it('reports a stable code and the canonical path on each failure', () => {
    const file = join(tempDir, 'file.txt');
    writeFileSync(file, 'x');

    const missing = captureError(() => validateWorkspacePath(join(tempDir, 'missing'), []));
    expect(missing).toBeInstanceOf(WorkspaceValidationError);
    expect(missing).toMatchObject({ code: 'WORKSPACE_NOT_FOUND', path: join(tempDir, 'missing') });

    expect(captureError(() => validateWorkspacePath(file, []))).toMatchObject({
      code: 'WORKSPACE_NOT_DIRECTORY',
      path: file,
    });
    expect(captureError(() => validateWorkspacePath('/', []))).toMatchObject({ code: 'WORKSPACE_UNSAFE', path: '/' });
    expect(captureError(() => validateWorkspacePath('', []))).toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
  });

  it('recognizes validation errors by their code discriminant', () => {
    expect(isWorkspaceValidationError(new WorkspaceValidationError('WORKSPACE_UNSAFE', 'x', '/'))).toBe(true);
    expect(isWorkspaceValidationError({ code: 'WORKSPACE_NOT_FOUND', message: 'x' })).toBe(true);
    expect(isWorkspaceValidationError({ code: 'WORKFLOW_NOT_RESUMABLE' })).toBe(false);
    expect(isWorkspaceValidationError(new Error('plain'))).toBe(false);
    expect(isWorkspaceValidationError(null)).toBe(false);
  });
});
