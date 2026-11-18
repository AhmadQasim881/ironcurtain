import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync as fsWriteFileSync,
  existsSync,
  rmSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseShell } from 'shell-quote';
import {
  checkSandboxAvailability,
  resolveSandboxConfig,
  planServerSandboxing,
  writeServerSettings,
  wrapServerCommand,
  cleanupSettingsFiles,
  annotateSandboxViolation,
  resolveNodeModulesBin,
  discoverNodePaths,
  rewriteServerSettings,
  baselineDenyRead,
  reexposesIronCurtainHome,
  BASELINE_CREDENTIAL_DENY_READ,
  SandboxConfigError,
  OS_SANDBOX_AVAILABILITY_ENV,
  createSmokeTestMemo,
  narrowOsSandboxAvailability,
  osSandboxAvailabilityEnv,
  parseOsSandboxAvailabilityEnv,
  resolveOsSandboxAvailability,
  runSmokeCommand,
  withOsSandboxSmokeResult,
  type OsSandboxAvailability,
  type OsSandboxSmokeResult,
  type ResolvedSandboxConfig,
  type ResolvedSandboxParams,
} from '../src/trusted-process/sandbox-integration.js';
import { RELAY_INTERNAL_ENV_NAMES } from '../src/trusted-process/child-env.js';
import type { MCPServerConfig } from '../src/config/types.js';
import { listProtectedCredentialStores } from '../src/config/credential-stores.js';
import { getPrivateScratchRoot, getTrustedSpawnCwd } from '../src/trusted-process/spawn-cwd.js';
import { packagedFilesystemServerEntry } from './helpers/filesystem-server.js';
import { macosProfileFor, seatbeltReadDecision } from './helpers/seatbelt-profile.js';

// ── Test helpers ─────────────────────────────────────────────────────────

const OS_SANDBOX_AVAILABLE: OsSandboxAvailability = {
  available: true,
  platformSupported: true,
  problems: [],
  warnings: [],
};

const OS_SANDBOX_MISSING_DEPS: OsSandboxAvailability = {
  available: false,
  platformSupported: true,
  problems: ['bubblewrap (bwrap) not installed'],
  warnings: [],
};

function makeServerConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    command: 'node',
    args: ['server.js'],
    ...overrides,
  };
}

/** Runs `fn` with environment overrides (undefined deletes), restoring the previous values afterwards. */
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The MCP server definitions IronCurtain ships. */
function loadShippedMcpServers(): Record<string, MCPServerConfig> {
  const path = fileURLToPath(new URL('../src/config/mcp-servers.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, MCPServerConfig>;
}

/** Resolves a config that must be sandboxed and returns its params. */
function resolveSandboxed(config: MCPServerConfig, sessionSandboxDir: string, serverName?: string) {
  const result = resolveSandboxConfig(config, sessionSandboxDir, true, 'warn', serverName);
  if (!result.sandboxed) throw new Error('expected a sandboxed config');
  return result.config;
}

/**
 * The denyRead entries that cover `path`: a literal entry covers itself and
 * everything beneath it, and `*` in a glob matches within one path segment.
 */
function denyEntriesCovering(denyRead: readonly string[], path: string): string[] {
  return denyRead.filter((entry) => {
    if (entry.includes('*')) {
      const source = entry
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*');
      return new RegExp(`^${source}(/.*)?$`).test(path);
    }
    return path === entry || path.startsWith(entry + '/');
  });
}

/**
 * Builds a throwaway user home (credential stores, an IronCurtain home with a
 * session sandbox) under a fresh temp directory. Callers remove `root`.
 */
function makeFakeUserHome(): { root: string; home: string; icHome: string; sandbox: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-srt-home-')));
  const home = join(root, 'home');
  const icHome = join(home, '.ironcurtain');
  const sandbox = join(icHome, 'sessions', 'abc', 'sandbox');
  const files: Record<string, string> = {
    [join(icHome, 'config.json')]: 'IC-CONFIG-SECRET\n',
    [join(icHome, 'oauth', 'google.json')]: 'REFRESH-TOKEN\n',
    [join(sandbox, 'hello.txt')]: 'HELLO-SANDBOX\n',
    [join(home, '.ssh', 'id_ed25519')]: 'PRIVATE-KEY\n',
    [join(home, '.ssh', 'known_hosts')]: 'KNOWN-HOSTS\n',
    [join(home, '.aws', 'credentials')]: 'AWS-SECRET\n',
    [join(home, '.config', 'anthropic', 'credentials', 'default.json')]: 'ANTHROPIC-CLI-OAUTH\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(path), { recursive: true });
    fsWriteFileSync(path, content);
  }
  return { root, home, icHome, sandbox };
}

function makeSandboxedConfig(overrides: Partial<ResolvedSandboxParams> = {}): ResolvedSandboxConfig {
  return {
    sandboxed: true,
    config: {
      allowWrite: ['/sandbox'],
      allowRead: [],
      denyRead: ['~/.ssh'],
      denyWrite: [],
      network: false,
      ...overrides,
    },
  };
}

function hasReachableSshAgentKey(): boolean {
  if (process.platform !== 'darwin' || !process.env.SSH_AUTH_SOCK) return false;
  try {
    return execFileSync('ssh-add', ['-l'], { encoding: 'utf-8', timeout: 5_000 }).includes('SHA256:');
  } catch {
    return false;
  }
}

const canExerciseSshAgentSocket = hasReachableSshAgentKey();

// ── checkSandboxAvailability ─────────────────────────────────────────────

describe('checkSandboxAvailability', () => {
  it('returns a structured result with platformSupported', () => {
    const result = checkSandboxAvailability();
    expect(result).toHaveProperty('platformSupported');
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('warnings');
    expect(typeof result.platformSupported).toBe('boolean');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

// ── Availability: the dependency check confirmed by an srt smoke run ─────

describe('resolveOsSandboxAvailability', () => {
  const smokeFailed: OsSandboxSmokeResult = { ok: false, elapsedMs: 9, detail: 'apply-seccomp: Permission denied' };
  const smokeOk: OsSandboxSmokeResult = { ok: true, elapsedMs: 9, detail: 'ok' };
  const sandboxed: Record<string, MCPServerConfig> = { git: makeServerConfig({ sandbox: { network: false } }) };

  // 01-08: on a host with bubblewrap, socat and ripgrep where srt cannot
  // start a sandbox, the dependency check alone said "available".
  it('is unavailable, naming the srt failure, when the dependencies pass but the smoke run fails', async () => {
    const smokeTest = vi.fn(async () => smokeFailed);
    const availability = await resolveOsSandboxAvailability(sandboxed, {
      dependencies: { ...OS_SANDBOX_AVAILABLE, warnings: ['seccomp helper missing for arm64'] },
      smokeTest,
    });
    expect(smokeTest).toHaveBeenCalledOnce();
    expect(availability).toEqual({
      available: false,
      platformSupported: true,
      problems: ['srt cannot start a sandbox on this host: apply-seccomp: Permission denied'],
      warnings: ['seccomp helper missing for arm64'],
    });
    // The plan follows: refused under enforce, unconfined under warn.
    expect(planServerSandboxing(sandboxed, '/tmp/sbx', availability, 'enforce').refused).toEqual(['git']);
    expect(planServerSandboxing(sandboxed, '/tmp/sbx', availability, 'warn').unconfined).toEqual(['git']);
  });

  it('is available when the smoke run passes', async () => {
    const availability = await resolveOsSandboxAvailability(sandboxed, {
      dependencies: OS_SANDBOX_AVAILABLE,
      smokeTest: async () => smokeOk,
    });
    expect(availability).toEqual(OS_SANDBOX_AVAILABLE);
  });

  it('runs srt only when the dependencies pass and a server asks for the sandbox', async () => {
    const smokeTest = vi.fn(async () => smokeFailed);
    expect(await resolveOsSandboxAvailability(sandboxed, { dependencies: OS_SANDBOX_MISSING_DEPS, smokeTest })).toEqual(
      OS_SANDBOX_MISSING_DEPS,
    );
    const optedOut = { fetch: makeServerConfig({ sandbox: false }) };
    expect(await resolveOsSandboxAvailability(optedOut, { dependencies: OS_SANDBOX_AVAILABLE, smokeTest })).toEqual(
      OS_SANDBOX_AVAILABLE,
    );
    expect(smokeTest).not.toHaveBeenCalled();
  });

  it('folds a smoke result into an available verdict only', () => {
    expect(withOsSandboxSmokeResult(OS_SANDBOX_MISSING_DEPS, smokeFailed)).toBe(OS_SANDBOX_MISSING_DEPS);
    expect(withOsSandboxSmokeResult(OS_SANDBOX_AVAILABLE, smokeOk)).toBe(OS_SANDBOX_AVAILABLE);
    expect(withOsSandboxSmokeResult(OS_SANDBOX_AVAILABLE, smokeFailed).available).toBe(false);
  });

  it("narrows a relay's parent verdict with the relay's own dependency check", () => {
    const parentFailed = withOsSandboxSmokeResult(OS_SANDBOX_AVAILABLE, smokeFailed);
    expect(narrowOsSandboxAvailability(parentFailed, OS_SANDBOX_AVAILABLE)).toBe(parentFailed);
    expect(narrowOsSandboxAvailability(OS_SANDBOX_AVAILABLE, OS_SANDBOX_MISSING_DEPS)).toBe(OS_SANDBOX_MISSING_DEPS);
    expect(narrowOsSandboxAvailability(OS_SANDBOX_AVAILABLE, OS_SANDBOX_AVAILABLE)).toBe(OS_SANDBOX_AVAILABLE);
  });

  it('hands the verdict to a relay through OS_SANDBOX_AVAILABILITY and reads only a complete one back', () => {
    const verdict = withOsSandboxSmokeResult(OS_SANDBOX_AVAILABLE, smokeFailed);
    const env = osSandboxAvailabilityEnv(verdict);
    expect(Object.keys(env)).toEqual([OS_SANDBOX_AVAILABILITY_ENV]);
    expect(parseOsSandboxAvailabilityEnv(env[OS_SANDBOX_AVAILABILITY_ENV])).toEqual(verdict);
    expect(parseOsSandboxAvailabilityEnv(undefined)).toBeUndefined();
    expect(parseOsSandboxAvailabilityEnv('')).toBeUndefined();
    for (const bad of [
      '{',
      'null',
      '[]',
      '{"available":false}',
      '{"available":false,"platformSupported":true,"problems":[1],"warnings":[]}',
      // "available" with problems, or on an unsupported platform, is inconsistent.
      '{"available":true,"platformSupported":true,"problems":["x"],"warnings":[]}',
      '{"available":true,"platformSupported":false,"problems":[],"warnings":[]}',
    ]) {
      expect(() => parseOsSandboxAvailabilityEnv(bad), bad).toThrow(OS_SANDBOX_AVAILABILITY_ENV);
    }
    // A relay-internal name: no other child inherits it, no `-e` forwards it.
    expect(RELAY_INTERNAL_ENV_NAMES).toContain(OS_SANDBOX_AVAILABILITY_ENV);
  });
});

describe('createSmokeTestMemo', () => {
  /** A smoke run that returns `results` in turn (the last one from then on). */
  function counted(results: OsSandboxSmokeResult[]) {
    let runs = 0;
    return vi.fn(async () => results[Math.min(runs++, results.length - 1)]);
  }

  it('runs srt once for concurrent and later callers when it passes', async () => {
    const run = counted([{ ok: true, elapsedMs: 1, detail: 'ok' }]);
    let clock = 0;
    const once = createSmokeTestMemo(run, 1_000, () => clock);
    const [first, second] = await Promise.all([once(), once()]);
    clock = 1_000_000;
    const later = await once();
    expect(run).toHaveBeenCalledOnce();
    expect([first.ok, second.ok, later.ok]).toEqual([true, true, true]);
  });

  it('keeps a failure only until the re-check interval has passed', async () => {
    const run = counted([
      { ok: false, elapsedMs: 1, detail: 'apply-seccomp: Permission denied' },
      { ok: true, elapsedMs: 1, detail: 'ok' },
    ]);
    let clock = 0;
    const once = createSmokeTestMemo(run, 1_000, () => clock);
    expect((await once()).ok).toBe(false);
    clock = 999;
    expect((await once()).ok).toBe(false);
    expect(run).toHaveBeenCalledOnce();
    clock = 1_000;
    expect((await once()).ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  // The memo is shared by every session of a process (the daemon): a run
  // that rejected used to stay the cached answer for good, and its
  // `.then()` bookkeeping left an unhandled rejection behind.
  it('counts a run that rejects or throws as a failed run, re-checked like any other', async () => {
    let calls = 0;
    const run = vi.fn((): Promise<OsSandboxSmokeResult> => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('srt crashed'));
      if (calls === 2) throw new Error('srt is missing');
      return Promise.resolve({ ok: true, elapsedMs: 1, detail: 'ok' });
    });
    let clock = 0;
    const once = createSmokeTestMemo(run, 1_000, () => clock);
    expect(await once()).toEqual({ ok: false, elapsedMs: 0, detail: 'srt crashed' });
    expect(await once()).toEqual({ ok: false, elapsedMs: 0, detail: 'srt crashed' });
    clock = 1_000;
    expect(await once()).toEqual({ ok: false, elapsedMs: 0, detail: 'srt is missing' });
    clock = 2_000;
    expect((await once()).ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe('runSmokeCommand', () => {
  const fakeSrt = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/srt-sigterm-exit0.mjs');
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ic-smoke-command-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const options = (timeoutMs: number) => ({ cwd: dir, env: { PATH: process.env.PATH ?? '' }, timeoutMs });

  // srt forwards the deadline's SIGTERM to its command and exits 0 when the
  // command ends by it. The exit status alone made a smoke run that never
  // finished a pass, kept for the life of the process.
  it('fails a run cut off at the deadline even when srt then exits 0', async () => {
    const ready = join(dir, 'ready');
    await expect(runSmokeCommand(process.execPath, [fakeSrt, ready], options(3_000))).rejects.toThrow(
      'srt did not finish within 3000ms',
    );
    // The stand-in was running its command when the deadline came, so it
    // took srt's path: forward the SIGTERM, then exit 0.
    expect(readFileSync(ready, 'utf-8')).toBe('ready');
  }, 20_000);

  it("passes a run that exits 0 and reports srt's stderr for one that fails", async () => {
    await expect(runSmokeCommand(process.execPath, ['-e', ''], options(15_000))).resolves.toBeUndefined();
    const failing = ['-e', 'process.stderr.write("apply-seccomp:\\n  Permission denied\\n"); process.exit(1)'];
    await expect(runSmokeCommand(process.execPath, failing, options(15_000))).rejects.toThrow(
      /^apply-seccomp: Permission denied$/,
    );
  }, 20_000);
});

// ── resolveSandboxConfig ─────────────────────────────────────────────────

describe('resolveSandboxConfig', () => {
  const sessionSandboxDir = '/sessions/abc/sandbox';

  it('returns opt-out for sandbox: false', () => {
    const result = resolveSandboxConfig(makeServerConfig({ sandbox: false }), sessionSandboxDir, true, 'warn');
    expect(result).toEqual({ sandboxed: false, reason: 'opt-out' });
  });

  it('applies restrictive defaults when sandbox is omitted', () => {
    const result = resolveSandboxConfig(makeServerConfig(), sessionSandboxDir, true, 'warn');
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowWrite).toContain(sessionSandboxDir);
      expect(result.config.network).toBe(false);
      // Default own denyRead (all of ~/.ssh), tilde-expanded, plus the baseline
      expect(result.config.denyRead).toContain(join(homedir(), '.ssh'));
      expect(result.config.denyRead).toContain(join(homedir(), '.gnupg'));
      expect(result.config.denyRead).toContain(join(homedir(), '.aws'));
      expect(result.config.denyRead).toEqual(expect.arrayContaining(baselineDenyRead()));
    }
  });

  it('applies restrictive defaults when sandbox is empty object', () => {
    const result = resolveSandboxConfig(makeServerConfig({ sandbox: {} }), sessionSandboxDir, true, 'warn');
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowWrite).toContain(sessionSandboxDir);
      expect(result.config.network).toBe(false);
    }
  });

  it('resolves relative allowWrite paths against session sandbox dir', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({ sandbox: { filesystem: { allowWrite: ['.git'] } } }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowWrite).toContain(sessionSandboxDir);
      expect(result.config.allowWrite).toContain(resolve(sessionSandboxDir, '.git'));
    }
  });

  it('preserves absolute allowWrite paths as-is', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({ sandbox: { filesystem: { allowWrite: ['/tmp/extra'] } } }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowWrite).toContain('/tmp/extra');
    }
  });

  it('unions a custom denyRead with the baseline instead of replacing it', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({
        sandbox: {
          filesystem: {
            denyRead: ['/etc/secrets'],
            denyWrite: ['/var/log'],
          },
        },
      }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.denyRead).toContain('/etc/secrets');
      expect(result.config.denyRead).toEqual(expect.arrayContaining(baselineDenyRead()));
      // The custom list replaced only the default own entries: all of ~/.ssh
      // is no longer denied, just the private keys from the baseline.
      expect(result.config.denyRead).not.toContain(join(homedir(), '.ssh'));
      expect(result.config.denyRead).toContain(join(homedir(), '.ssh', 'id_*'));
      expect(result.config.denyWrite).toEqual(['/var/log']);
    }
  });

  it('resolves network config with allowed/denied domains', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({
        sandbox: {
          network: {
            allowedDomains: ['github.com', '*.github.com'],
            deniedDomains: ['evil.com'],
          },
        },
      }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.network).not.toBe(false);
      if (result.config.network !== false) {
        expect(result.config.network.allowedDomains).toEqual(['github.com', '*.github.com']);
        expect(result.config.network.deniedDomains).toEqual(['evil.com']);
      }
    }
  });

  it('defaults deniedDomains to empty array when not specified', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({
        sandbox: {
          network: { allowedDomains: ['example.com'] },
        },
      }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed && result.config.network !== false) {
      expect(result.config.network.deniedDomains).toEqual([]);
    }
  });

  it('degrades gracefully when platform unavailable and policy is warn', () => {
    const result = resolveSandboxConfig(makeServerConfig(), sessionSandboxDir, false, 'warn');
    expect(result).toEqual({ sandboxed: false, reason: 'platform-unavailable' });
  });

  it('throws when platform unavailable and policy is enforce', () => {
    expect(() => resolveSandboxConfig(makeServerConfig(), sessionSandboxDir, false, 'enforce')).toThrow(
      /sandboxPolicy is "enforce"/,
    );
  });

  it('still returns opt-out even when platform unavailable', () => {
    const result = resolveSandboxConfig(makeServerConfig({ sandbox: false }), sessionSandboxDir, false, 'enforce');
    expect(result).toEqual({ sandboxed: false, reason: 'opt-out' });
  });
});

// ── Read-containment baseline ────────────────────────────────────────────

describe('read-containment baseline', () => {
  let root: string;
  let home: string;
  let icHome: string;
  let sandbox: string;

  beforeEach(() => {
    ({ root, home, icHome, sandbox } = makeFakeUserHome());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Runs `fn` with HOME pointing at the fake home and the default IronCurtain home. */
  function inFakeHome<T>(fn: () => T): T {
    return withEnv({ HOME: home, IRONCURTAIN_HOME: undefined }, fn);
  }

  it('contains the absolute IronCurtain home and every credential store', () => {
    inFakeHome(() => {
      const baseline = baselineDenyRead();
      expect(baseline).toContain(icHome);
      for (const entry of BASELINE_CREDENTIAL_DENY_READ) {
        expect(baseline).toContain(join(home, entry.slice(2)));
      }
      // No unexpanded spelling reaches srt
      expect(baseline.some((p) => p.startsWith('~'))).toBe(false);
    });
  });

  it('keeps default Anthropic stores and explicit trusted env paths in the sandbox baseline', () => {
    inFakeHome(() =>
      withEnv(
        {
          ANTHROPIC_CONFIG_DIR: join(root, 'relocated-anthropic'),
          IRONCURTAIN_ENV_FILE: join(root, 'explicit-credentials.env'),
        },
        () => {
          expect(baselineDenyRead()).toEqual(
            expect.arrayContaining([
              join(home, '.config', 'anthropic', 'credentials'),
              join(root, 'explicit-credentials.env'),
            ]),
          );
        },
      ),
    );
  });

  it("contains the relays' per-user scratch root, so one server cannot read another's srt files or OAuth tokens", () => {
    inFakeHome(() => {
      const scratchRoot = getPrivateScratchRoot();
      expect(baselineDenyRead()).toContain(scratchRoot);
      // Every sandboxed shipped server gets it.
      const google = resolveSandboxed(loadShippedMcpServers()['google-workspace'], sandbox, 'google-workspace');
      expect(google.denyRead).toContain(scratchRoot);
      // Its own working directory, written into the settings, is re-exposed.
      const settingsDir = mkdtempSync(join(tmpdir(), 'ironcurtain-scratch-root-test-'));
      try {
        const { settingsPath, cwdPath } = writeServerSettings('google-workspace', google, settingsDir);
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
          filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[] };
        };
        expect(settings.filesystem.denyRead).toContain(scratchRoot);
        expect(settings.filesystem.allowRead).toContain(cwdPath);
        expect(settings.filesystem.allowWrite).toContain(cwdPath);
      } finally {
        rmSync(settingsDir, { recursive: true, force: true });
      }
    });
  });

  it('refuses any configuration that would re-open the scratch root: it has no opt-out', () => {
    // A temporary directory that does not hold the (fake) IronCurtain home, so
    // a glob over it is refused for the scratch root, not for the home.
    const tmp = join(root, 'tmp');
    mkdirSync(tmp);
    withEnv({ HOME: home, IRONCURTAIN_HOME: undefined, TMPDIR: tmp }, () => {
      const scratchRoot = getPrivateScratchRoot();
      expect(dirname(scratchRoot)).toBe(tmp);
      const withFs = (filesystem: Record<string, unknown>): MCPServerConfig => ({
        command: 'node',
        args: ['server.js'],
        sandbox: { filesystem },
      });
      // srt honours an allow inside a deny, so each of these would hand the
      // server every relay's srt settings and OAuth access tokens.
      for (const filesystem of [
        { allowRead: [scratchRoot] },
        { allowRead: [join(scratchRoot, 'srt-abc123', 'google-workspace-creds')] },
        { allowWrite: [scratchRoot] },
        { allowRead: [join(dirname(scratchRoot), '*')] },
        { allowWrite: [join(scratchRoot, '**')] },
      ]) {
        expect(
          () => resolveSandboxConfig(withFs(filesystem), sandbox, true, 'warn', 'custom'),
          JSON.stringify(filesystem),
        ).toThrow(/per-user directory/);
      }
      // Nor may the session sandbox itself lie inside it.
      expect(() => resolveSandboxConfig(withFs({}), join(scratchRoot, 'session'), true, 'warn')).toThrow(
        SandboxConfigError,
      );
      // A directory that merely contains the root is no re-exposure: srt keeps
      // the nested deny on both platforms.
      const contains = resolveSandboxed(withFs({ allowWrite: [dirname(scratchRoot)] }), sandbox);
      expect(contains.allowWrite).toContain(dirname(scratchRoot));
      expect(contains.denyRead).toContain(scratchRoot);
    });
  });

  it('follows IRONCURTAIN_HOME rather than the literal ~/.ironcurtain', () => {
    const elsewhere = join(root, 'ic-elsewhere');
    mkdirSync(elsewhere);
    withEnv({ HOME: home, IRONCURTAIN_HOME: elsewhere }, () => {
      const config = resolveSandboxed(makeServerConfig(), join(elsewhere, 'sessions', 'x', 'sandbox'));
      expect(config.denyRead).toContain(elsewhere);
      expect(baselineDenyRead()).not.toContain(icHome);
    });
  });

  it('denies both spellings of an IronCurtain home reached through a symlink', () => {
    const real = join(root, 'ic-real');
    const link = join(root, 'ic-link');
    mkdirSync(real);
    symlinkSync(real, link);
    withEnv({ HOME: home, IRONCURTAIN_HOME: link }, () => {
      const config = resolveSandboxed(makeServerConfig(), sandbox);
      expect(config.denyRead).toContain(link);
      expect(config.denyRead).toContain(real);
    });
  });

  it('gives every sandboxed server in the shipped mcp-servers.json the full baseline', () => {
    inFakeHome(() => {
      const servers = loadShippedMcpServers();
      const sandboxed = Object.entries(servers).filter(([, config]) => config.sandbox !== false);
      expect(sandboxed.map(([name]) => name)).toEqual(expect.arrayContaining(['git', 'google-workspace']));
      for (const [name, config] of sandboxed) {
        const resolved = resolveSandboxed(config, sandbox, name);
        expect(resolved.denyRead).toEqual(expect.arrayContaining(baselineDenyRead()));
        for (const secret of ['config.json', join('oauth', 'google.json'), join('oauth', 'google-credentials.json')]) {
          expect(denyEntriesCovering(resolved.denyRead, join(icHome, secret))).not.toEqual([]);
        }
        // The session sandbox is re-exposed for macOS, where only allowRead
        // re-allows reads inside the denied IronCurtain home.
        expect(resolved.allowRead).toContain(sandbox);
      }
    });
  });

  it('denies git the SSH private keys but leaves known_hosts and config readable', () => {
    inFakeHome(() => {
      const git = resolveSandboxed(loadShippedMcpServers().git, sandbox, 'git');
      expect(git.denyRead).toContain(join(home, '.ssh', 'id_*'));
      expect(git.denyRead).not.toContain(join(home, '.ssh'));
      expect(denyEntriesCovering(git.denyRead, join(home, '.ssh', 'id_ed25519'))).not.toEqual([]);
      expect(denyEntriesCovering(git.denyRead, join(home, '.ssh', 'id_rsa'))).not.toEqual([]);
      expect(denyEntriesCovering(git.denyRead, join(home, '.ssh', 'known_hosts'))).toEqual([]);
      expect(denyEntriesCovering(git.denyRead, join(home, '.ssh', 'config'))).toEqual([]);
    });
  });

  it('keeps the explicit OAuth deny in the shipped google-workspace config', () => {
    inFakeHome(() => {
      const gws = resolveSandboxed(loadShippedMcpServers()['google-workspace'], sandbox, 'google-workspace');
      expect(gws.denyRead).toContain(join(home, '.ironcurtain', 'oauth'));
    });
  });

  it('lets a server opt out of a credential store by naming it exactly in allowRead', () => {
    inFakeHome(() => {
      // An explicit own denyRead, since the default one lists ~/.aws itself
      const aws = resolveSandboxed(
        makeServerConfig({ sandbox: { filesystem: { denyRead: [], allowRead: ['~/.aws'] } } }),
        sandbox,
      );
      expect(aws.allowRead).toContain(join(home, '.aws'));
      expect(aws.denyRead).not.toContain(join(home, '.aws'));
      expect(aws.denyRead).toContain(icHome);
      expect(aws.denyRead).toContain(join(home, '.gnupg'));

      const keys = resolveSandboxed(
        makeServerConfig({ sandbox: { filesystem: { denyRead: [], allowRead: ['~/.ssh/id_*'] } } }),
        sandbox,
      );
      expect(keys.denyRead).not.toContain(join(home, '.ssh', 'id_*'));
      expect(keys.denyRead).toContain(join(home, '.config', 'gh'));
    });
  });

  it('keeps the baseline entry when allowRead only carves out part of it', () => {
    inFakeHome(() => {
      const config = resolveSandboxed(
        makeServerConfig({ sandbox: { filesystem: { denyRead: [], allowRead: ['~/.aws/config'] } } }),
        sandbox,
      );
      expect(config.denyRead).toContain(join(home, '.aws'));
    });
  });

  /** What the baseline hides beyond the original credential-store list (gcloud, kube, shell startup files, a legacy .env). */
  function credentialCarriers(): string[] {
    return [
      join(home, '.config', 'gcloud'),
      join(home, '.kube', 'config'),
      join(home, '.bashrc'),
      join(home, '.bash_profile'),
      join(home, '.bash_login'),
      join(home, '.profile'),
      join(home, '.zshrc'),
      join(home, '.zshenv'),
      join(home, '.zprofile'),
      join(home, '.config', 'fish'),
      join(getTrustedSpawnCwd(), '.env'),
    ];
  }

  it('denies every extended credential store the policy engine protects, except all of ~/.ssh and ~/.netrc', () => {
    inFakeHome(() => {
      const baseline = baselineDenyRead();
      const extended = listProtectedCredentialStores().filter((store) => store.tier === 'extended');
      expect(extended.map((store) => store.id)).toEqual(expect.arrayContaining(['ssh', 'netrc', 'gcloud', 'kube']));
      for (const store of extended) {
        if (store.id === 'ssh') {
          // The private keys only: git's ssh needs ~/.ssh/config and known_hosts.
          expect(baseline).toContain(join(home, '.ssh', 'id_*'));
          expect(baseline).not.toContain(join(home, '.ssh'));
        } else if (store.id === 'netrc') {
          // Left readable: git over HTTPS may authenticate with it, and a
          // built-in server's allowRead cannot be adjusted by the user.
          for (const path of store.paths) expect(baseline).not.toContain(path);
        } else {
          for (const path of store.paths) expect(baseline, store.id).toContain(path);
        }
      }
      // The stores IronCurtain itself reads are covered too.
      for (const store of listProtectedCredentialStores().filter((s) => s.tier === 'core')) {
        for (const path of store.paths) expect(denyEntriesCovering(baseline, path), store.id).not.toEqual([]);
      }
    });
  });

  it('denies every shipped sandboxed server the gcloud and kube stores, shell startup files and the package-root .env', () => {
    inFakeHome(() => {
      const settingsDir = mkdtempSync(join(tmpdir(), 'ironcurtain-baseline-settings-'));
      try {
        for (const name of ['git', 'google-workspace', 'filesystem']) {
          const resolved = resolveSandboxed(loadShippedMcpServers()[name], sandbox, name);
          expect(resolved.denyRead, name).toEqual(expect.arrayContaining(credentialCarriers()));
          // What the relay hands srt.
          const { settingsPath } = writeServerSettings(name, resolved, settingsDir);
          const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { filesystem: { denyRead: string[] } };
          expect(settings.filesystem.denyRead, name).toEqual(expect.arrayContaining(credentialCarriers()));
          // fish keeps exported universal variables beside its config file.
          for (const file of ['config.fish', 'fish_variables', join('conf.d', 'keys.fish')]) {
            expect(denyEntriesCovering(resolved.denyRead, join(home, '.config', 'fish', file)), file).not.toEqual([]);
          }
        }
      } finally {
        rmSync(settingsDir, { recursive: true, force: true });
      }
    });
  });

  it('lets a server opt back in to a shell startup file, a cloud store or the package-root .env by naming it exactly', () => {
    inFakeHome(() => {
      const packageEnv = join(getTrustedSpawnCwd(), '.env');
      const config = resolveSandboxed(
        makeServerConfig({ sandbox: { filesystem: { allowRead: ['~/.bashrc', '~/.config/gcloud', packageEnv] } } }),
        sandbox,
      );
      expect(config.denyRead).not.toContain(join(home, '.bashrc'));
      expect(config.denyRead).not.toContain(join(home, '.config', 'gcloud'));
      expect(config.denyRead).not.toContain(packageEnv);
      // Only the named entries: the rest of the baseline stays.
      expect(config.denyRead).toContain(join(home, '.zshrc'));
      expect(config.denyRead).toContain(join(home, '.profile'));
      expect(config.denyRead).toContain(join(home, '.kube', 'config'));
      expect(config.denyRead).toContain(icHome);
    });
  });

  it('denies the OAuth credential files IronCurtain reads, wherever their env overrides put them', () => {
    const unset = { ANTHROPIC_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined, CODEX_HOME: undefined };
    withEnv({ HOME: home, IRONCURTAIN_HOME: undefined, ...unset }, () => {
      // The Anthropic CLI store keeps one file per profile, so its directory is denied
      expect(baselineDenyRead()).toContain(join(home, '.config', 'anthropic', 'credentials'));
      expect(baselineDenyRead()).toContain(join(home, '.codex', 'auth.json'));
    });
    const xdg = join(root, 'xdg');
    withEnv({ HOME: home, IRONCURTAIN_HOME: undefined, ...unset, XDG_CONFIG_HOME: xdg }, () => {
      expect(baselineDenyRead()).toContain(join(xdg, 'anthropic', 'credentials'));
    });
    const anthropicDir = join(root, 'anthropic-config');
    const codexHome = join(root, 'codex-home');
    withEnv(
      { HOME: home, IRONCURTAIN_HOME: undefined, ...unset, ANTHROPIC_CONFIG_DIR: anthropicDir, CODEX_HOME: codexHome },
      () => {
        const git = resolveSandboxed(loadShippedMcpServers().git, sandbox, 'git');
        expect(git.denyRead).toContain(join(anthropicDir, 'credentials'));
        expect(git.denyRead).toContain(join(codexHome, 'auth.json'));
      },
    );
  });

  /** Replaces credential stores in the fake home with symlinks into a dotfiles checkout, as stow or yadm do. */
  function symlinkStoresIntoDotfiles(): string {
    const dotfiles = join(root, 'dotfiles');
    mkdirSync(join(dotfiles, 'aws'), { recursive: true });
    mkdirSync(join(dotfiles, 'ssh'), { recursive: true });
    fsWriteFileSync(join(dotfiles, 'npmrc'), 'NPM-TOKEN\n');
    fsWriteFileSync(join(dotfiles, 'aws', 'credentials'), 'AWS-SECRET\n');
    fsWriteFileSync(join(dotfiles, 'ssh', 'id_rsa'), 'PRIVATE-KEY\n');
    fsWriteFileSync(join(dotfiles, 'ssh', 'known_hosts'), 'KNOWN-HOSTS\n');
    rmSync(join(home, '.aws'), { recursive: true });
    rmSync(join(home, '.ssh'), { recursive: true });
    symlinkSync(join(dotfiles, 'npmrc'), join(home, '.npmrc'));
    symlinkSync(join(dotfiles, 'aws'), join(home, '.aws'));
    symlinkSync(join(dotfiles, 'ssh'), join(home, '.ssh'));
    return dotfiles;
  }

  it('also denies the path a symlinked credential store really names', () => {
    // macOS Seatbelt matches canonical paths, and srt leaves these links unresolved
    const dotfiles = symlinkStoresIntoDotfiles();
    inFakeHome(() => {
      const git = resolveSandboxed(loadShippedMcpServers().git, sandbox, 'git');
      expect(git.denyRead).toContain(join(home, '.npmrc'));
      expect(git.denyRead).toContain(join(dotfiles, 'npmrc'));
      expect(git.denyRead).toContain(join(dotfiles, 'aws'));
      expect(git.denyRead).toContain(join(dotfiles, 'ssh', 'id_*'));
      expect(denyEntriesCovering(git.denyRead, join(dotfiles, 'ssh', 'known_hosts'))).toEqual([]);
    });
  });

  it('drops both spellings of a symlinked credential store the server opts out of', () => {
    const dotfiles = symlinkStoresIntoDotfiles();
    inFakeHome(() => {
      const config = resolveSandboxed(
        makeServerConfig({ sandbox: { filesystem: { denyRead: [], allowRead: ['~/.aws'] } } }),
        sandbox,
      );
      expect(config.denyRead).not.toContain(join(home, '.aws'));
      expect(config.denyRead).not.toContain(join(dotfiles, 'aws'));
      expect(config.denyRead).toContain(join(dotfiles, 'npmrc'));
    });
  });

  it('also passes a session sandbox behind a symlinked IronCurtain home under its canonical parent', () => {
    const real = join(root, 'ic-real');
    const link = join(root, 'ic-link');
    mkdirSync(join(real, 'sessions', 'abc', 'sandbox'), { recursive: true });
    symlinkSync(real, link);
    withEnv({ HOME: home, IRONCURTAIN_HOME: link }, () => {
      const linked = join(link, 'sessions', 'abc', 'sandbox');
      const canonical = join(real, 'sessions', 'abc', 'sandbox');
      const config = resolveSandboxed(makeServerConfig(), linked);
      // srt neither binds the linked spelling writable (Linux) nor matches it (macOS)
      expect(config.allowWrite).toEqual([linked, canonical]);
      expect(config.allowRead).toEqual([linked, canonical]);
      expect(config.denyRead).toContain(real);
    });
  });

  it('does not resolve a session sandbox directory that is itself a symlink', () => {
    // A link to somewhere broader must stay subject to srt's own link check
    const linkedSandbox = join(root, 'sandbox-link');
    symlinkSync(home, linkedSandbox);
    inFakeHome(() => {
      const config = resolveSandboxed(makeServerConfig(), linkedSandbox);
      expect(config.allowWrite).toEqual([linkedSandbox]);
      expect(config.allowRead).toEqual([linkedSandbox]);
    });
  });

  it.each([
    ['the IronCurtain home itself', (h: string) => h],
    ['the OAuth store', (h: string) => join(h, 'oauth')],
    ['the user config file', (h: string) => join(h, 'config.json')],
    ['a glob inside the home', (h: string) => join(h, '*')],
    ['a glob rooted above the home that can match into it', (h: string) => join(dirname(h), '*', 'oauth')],
  ])('refuses an allowRead entry naming %s', (_label, entryFor) => {
    inFakeHome(() => {
      const config = makeServerConfig({ sandbox: { filesystem: { allowRead: [entryFor(icHome)] } } });
      expect(() => resolveSandboxConfig(config, sandbox, true, 'warn', 'custom')).toThrow(SandboxConfigError);
    });
  });

  it('refuses an allowWrite entry inside the IronCurtain home', () => {
    inFakeHome(() => {
      const config = makeServerConfig({ sandbox: { filesystem: { allowWrite: [join(icHome, 'data')] } } });
      expect(() => resolveSandboxConfig(config, join(root, 'workspace'), true, 'warn')).toThrow(SandboxConfigError);
    });
  });

  it('refuses a tilde allowRead entry inside the IronCurtain home', () => {
    inFakeHome(() => {
      const config = makeServerConfig({ sandbox: { filesystem: { allowRead: ['~/.ironcurtain/oauth'] } } });
      expect(() => resolveSandboxConfig(config, sandbox, true, 'warn')).toThrow(/would expose the IronCurtain home/);
    });
  });

  it('refuses a relative allowRead entry that climbs out of the session sandbox into the home', () => {
    inFakeHome(() => {
      const config = makeServerConfig({ sandbox: { filesystem: { allowRead: ['../../../oauth'] } } });
      expect(() => resolveSandboxConfig(config, sandbox, true, 'warn')).toThrow(SandboxConfigError);
    });
  });

  it('refuses an allowRead entry inside the session sandbox that is a symlink into the home', () => {
    symlinkSync(join(icHome, 'oauth'), join(sandbox, 'planted'));
    inFakeHome(() => {
      const config = makeServerConfig({ sandbox: { filesystem: { allowRead: ['planted'] } } });
      expect(() => resolveSandboxConfig(config, sandbox, true, 'warn')).toThrow(SandboxConfigError);
    });
  });

  it('allows entries inside a session sandbox that itself lives in the IronCurtain home', () => {
    inFakeHome(() => {
      const config = resolveSandboxed(
        makeServerConfig({ sandbox: { filesystem: { allowWrite: ['.git'], allowRead: ['docs'] } } }),
        sandbox,
      );
      expect(config.allowWrite).toContain(join(sandbox, '.git'));
      expect(config.allowRead).toContain(join(sandbox, 'docs'));
    });
  });

  it('does not exempt home paths just because the session sandbox contains the home', () => {
    inFakeHome(() => {
      // A workspace that contains the IronCurtain home does not re-expose it
      const config = makeServerConfig({ sandbox: { filesystem: { allowRead: [join(icHome, 'oauth')] } } });
      expect(() => resolveSandboxConfig(config, home, true, 'warn')).toThrow(SandboxConfigError);
    });
  });

  it('accepts an allowRead entry that merely contains the home (the nested deny still wins)', () => {
    inFakeHome(() => {
      const config = resolveSandboxed(
        makeServerConfig({ sandbox: { filesystem: { allowRead: [home] } } }),
        join(root, 'workspace'),
      );
      expect(config.allowRead).toContain(home);
      expect(config.denyRead).toContain(icHome);
    });
  });

  it('refuses a session sandbox directory that is the IronCurtain home itself', () => {
    inFakeHome(() => {
      expect(() => resolveSandboxConfig(makeServerConfig(), icHome, true, 'warn')).toThrow(SandboxConfigError);
    });
  });

  // planServerSandboxing is what the session parent and every relay resolve
  // servers through (it replaced resolveSandboxConfigsForAudit), so the
  // refusal must name the server there too.
  it.each(['enforce', 'warn'] as const)(
    'names the offending server and carries a code discriminant (sandbox available, %s)',
    (policy) => {
      inFakeHome(() => {
        const servers = {
          'good-server': makeServerConfig(),
          'bad-server': makeServerConfig({ sandbox: { filesystem: { allowRead: [icHome] } } }),
        };
        let caught: unknown;
        try {
          planServerSandboxing(servers, sandbox, OS_SANDBOX_AVAILABLE, policy);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(SandboxConfigError);
        expect((caught as SandboxConfigError).code).toBe('SANDBOX_CONFIG_INVALID');
        expect((caught as Error).message).toContain('Server "bad-server"');
      });
    },
  );

  // `ironcurtain doctor` plans only when the OS sandbox is unavailable, and
  // must report rather than crash; such a server never gets srt settings.
  it('plans a server whose sandbox is unavailable without validating its sandbox paths', () => {
    inFakeHome(() => {
      const servers = { 'bad-server': makeServerConfig({ sandbox: { filesystem: { allowRead: [icHome] } } }) };
      // enforce: refused outright, no srt settings are ever written for it
      const enforced = planServerSandboxing(servers, sandbox, OS_SANDBOX_MISSING_DEPS, 'enforce');
      expect(enforced.refused).toEqual(['bad-server']);
      expect(enforced.resolved.has('bad-server')).toBe(false);
      // warn: runs unconfined, stamped platform-unavailable, never sandboxed
      const warned = planServerSandboxing(servers, sandbox, OS_SANDBOX_MISSING_DEPS, 'warn');
      expect(warned.unconfined).toEqual(['bad-server']);
      expect(warned.resolved.get('bad-server')).toEqual({ sandboxed: false, reason: 'platform-unavailable' });
    });
  });

  it('resolves relative allowRead entries against the session sandbox', () => {
    inFakeHome(() => {
      const config = resolveSandboxed(makeServerConfig({ sandbox: { filesystem: { allowRead: ['docs'] } } }), sandbox);
      expect(config.allowRead).toContain(join(sandbox, 'docs'));
      expect(config.allowRead).not.toContain('docs');
    });
  });
});

// ── reexposesIronCurtainHome ─────────────────────────────────────────────

describe('reexposesIronCurtainHome', () => {
  let root: string;
  let home: string;
  let icHome: string;

  beforeEach(() => {
    ({ root, home, icHome } = makeFakeUserHome());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('flags the home, paths inside it, and symlinks into it', () => {
    symlinkSync(join(icHome, 'oauth'), join(root, 'link-to-oauth'));
    withEnv({ HOME: home, IRONCURTAIN_HOME: undefined }, () => {
      expect(reexposesIronCurtainHome(icHome)).toBe(true);
      expect(reexposesIronCurtainHome(join(icHome, 'oauth', 'google.json'))).toBe(true);
      expect(reexposesIronCurtainHome(join(root, 'link-to-oauth'))).toBe(true);
      expect(reexposesIronCurtainHome(join(icHome, 'sessions', '*'))).toBe(true);
      expect(reexposesIronCurtainHome(join(home, '.iron*', 'oauth'))).toBe(true);
    });
  });

  it('does not flag parents, siblings or unrelated globs', () => {
    withEnv({ HOME: home, IRONCURTAIN_HOME: undefined }, () => {
      expect(reexposesIronCurtainHome(home)).toBe(false);
      expect(reexposesIronCurtainHome(join(home, '.ironcurtain-other'))).toBe(false);
      expect(reexposesIronCurtainHome(join(home, '.nvm'))).toBe(false);
      expect(reexposesIronCurtainHome(join(home, '.nvm', '*'))).toBe(false);
    });
  });
});

// ── writeServerSettings ──────────────────────────────────────────────────

describe('writeServerSettings', () => {
  let settingsDir: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(join(tmpdir(), 'test-srt-settings-'));
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it('writes valid JSON at the expected path', () => {
    const { settingsPath, cwdPath } = writeServerSettings(
      'exec',
      {
        allowWrite: ['/sandbox'],
        allowRead: [],
        denyRead: ['~/.ssh'],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    expect(settingsPath).toBe(join(settingsDir, 'exec.srt-settings.json'));
    expect(existsSync(settingsPath)).toBe(true);
    expect(cwdPath).toBe(join(settingsDir, 'exec.cwd'));
    expect(existsSync(cwdPath)).toBe(true);

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content).toHaveProperty('network');
    expect(content).toHaveProperty('filesystem');
  });

  it('maps network: false to empty allowedDomains', () => {
    const { settingsPath } = writeServerSettings(
      'exec',
      {
        allowWrite: ['/sandbox'],
        allowRead: [],
        denyRead: [],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.network).toEqual({
      allowedDomains: [],
      deniedDomains: [],
    });
  });

  it('passes through allowedDomains and deniedDomains', () => {
    const { settingsPath } = writeServerSettings(
      'git',
      {
        allowWrite: ['/sandbox'],
        allowRead: [],
        denyRead: [],
        denyWrite: [],
        network: {
          allowedDomains: ['github.com', '*.github.com'],
          deniedDomains: ['evil.com'],
        },
      },
      settingsDir,
    );

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.network.allowedDomains).toEqual(['github.com', '*.github.com']);
    expect(content.network.deniedDomains).toEqual(['evil.com']);
  });

  it('writes correct filesystem config including cwd path', () => {
    const { settingsPath, cwdPath } = writeServerSettings(
      'test',
      {
        allowWrite: ['/sandbox', '/sandbox/.git'],
        allowRead: [],
        denyRead: ['~/.ssh', '~/.gnupg'],
        denyWrite: ['/var/log'],
        network: false,
      },
      settingsDir,
    );

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.filesystem.allowWrite).toEqual(['/sandbox', '/sandbox/.git', cwdPath]);
    expect(content.filesystem.denyRead).toEqual(['~/.ssh', '~/.gnupg']);
    expect(content.filesystem.denyWrite).toEqual(['/var/log']);
  });

  it('writes allowRead to settings file', () => {
    const { settingsPath } = writeServerSettings(
      'gws',
      {
        allowWrite: ['/sandbox'],
        allowRead: ['/usr', '/etc', '/home/user/.nvm'],
        denyRead: ['~'],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.filesystem.allowRead).toEqual(['/usr', '/etc', '/home/user/.nvm', join(settingsDir, 'gws.cwd')]);
    expect(content.filesystem.denyRead).toEqual(['~']);
  });

  it('adds the per-server cwd to allowRead as well as allowWrite', () => {
    // macOS re-allows reads inside a denied region only through allowRead
    const { settingsPath, cwdPath } = writeServerSettings(
      'git',
      {
        allowWrite: ['/sandbox'],
        allowRead: ['/sandbox'],
        denyRead: ['/home/user/.ironcurtain'],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.filesystem.allowRead).toEqual(['/sandbox', cwdPath]);
    expect(content.filesystem.allowWrite).toEqual(['/sandbox', cwdPath]);
  });

  it('includes only SSH_AUTH_SOCK in allowUnixSockets for a server granted the ssh agent', () => {
    const originalSock = process.env.SSH_AUTH_SOCK;
    try {
      process.env.SSH_AUTH_SOCK = '/private/tmp/com.apple.launchd.abc123/Listeners';
      const { settingsPath } = writeServerSettings(
        'git',
        {
          allowWrite: ['/sandbox'],
          allowRead: [],
          denyRead: [],
          denyWrite: [],
          network: {
            allowedDomains: ['github.com'],
            deniedDomains: [],
          },
        },
        settingsDir,
        { sshAgent: true },
      );

      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(content.network.allowUnixSockets).toEqual(['/private/tmp/com.apple.launchd.abc123/Listeners']);
    } finally {
      if (originalSock !== undefined) {
        process.env.SSH_AUTH_SOCK = originalSock;
      } else {
        delete process.env.SSH_AUTH_SOCK;
      }
    }
  });

  // On macOS, Seatbelt lets a process reach a Unix socket only under
  // allowUnixSockets: the ssh agent there would let any compromised
  // networked server authenticate with the user's SSH keys.
  it('grants the ssh-agent socket to no networked server unless asked to (git only)', () => {
    withEnv({ SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.abc123/Listeners' }, () => {
      const networked: ResolvedSandboxParams = {
        allowWrite: ['/sandbox'],
        allowRead: [],
        denyRead: [],
        denyWrite: [],
        network: { allowedDomains: ['googleapis.com', '*.googleapis.com'], deniedDomains: [] },
      };
      const socketsOf = (settingsPath: string): unknown =>
        (JSON.parse(readFileSync(settingsPath, 'utf-8')) as { network: { allowUnixSockets?: unknown } }).network
          .allowUnixSockets;

      const google = writeServerSettings('google-workspace', networked, settingsDir);
      expect(socketsOf(google.settingsPath)).toBeUndefined();
      const declined = writeServerSettings('custom', networked, settingsDir, { sshAgent: false });
      expect(socketsOf(declined.settingsPath)).toBeUndefined();
      const git = writeServerSettings('git', networked, settingsDir, { sshAgent: true });
      expect(socketsOf(git.settingsPath)).toEqual(['/private/tmp/com.apple.launchd.abc123/Listeners']);
    });
  });

  it('does not include allowUnixSockets when SSH_AUTH_SOCK is unset', () => {
    const originalSock = process.env.SSH_AUTH_SOCK;
    try {
      delete process.env.SSH_AUTH_SOCK;
      const { settingsPath } = writeServerSettings(
        'git',
        {
          allowWrite: ['/sandbox'],
          allowRead: [],
          denyRead: [],
          denyWrite: [],
          network: {
            allowedDomains: ['github.com'],
            deniedDomains: [],
          },
        },
        settingsDir,
        { sshAgent: true },
      );

      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(content.network.allowUnixSockets).toBeUndefined();
    } finally {
      if (originalSock !== undefined) {
        process.env.SSH_AUTH_SOCK = originalSock;
      } else {
        delete process.env.SSH_AUTH_SOCK;
      }
    }
  });

  it('does not include allowUnixSockets when network is disabled', () => {
    const originalSock = process.env.SSH_AUTH_SOCK;
    try {
      process.env.SSH_AUTH_SOCK = '/private/tmp/com.apple.launchd.abc123/Listeners';
      const { settingsPath } = writeServerSettings(
        'exec',
        {
          allowWrite: ['/sandbox'],
          allowRead: [],
          denyRead: [],
          denyWrite: [],
          network: false,
        },
        settingsDir,
        { sshAgent: true },
      );

      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(content.network.allowUnixSockets).toBeUndefined();
    } finally {
      if (originalSock !== undefined) {
        process.env.SSH_AUTH_SOCK = originalSock;
      } else {
        delete process.env.SSH_AUTH_SOCK;
      }
    }
  });
});

// ── rewriteServerSettings ─────────────────────────────────────────────────

describe('rewriteServerSettings', () => {
  let settingsDir: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(join(tmpdir(), 'test-srt-rewrite-'));
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it('adds allowRead paths to existing settings', () => {
    const { settingsPath } = writeServerSettings(
      'test',
      {
        allowWrite: ['/sandbox'],
        allowRead: ['/usr'],
        denyRead: ['~'],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    rewriteServerSettings(settingsPath, { allowRead: ['/home/user/.nvm'] });

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.filesystem.allowRead).toContain('/usr');
    expect(content.filesystem.allowRead).toContain('/home/user/.nvm');
  });

  it('adds allowWrite paths to existing settings', () => {
    const { settingsPath } = writeServerSettings(
      'test',
      {
        allowWrite: ['/sandbox'],
        allowRead: [],
        denyRead: [],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    rewriteServerSettings(settingsPath, { allowWrite: ['/tmp/creds'] });

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.filesystem.allowWrite).toContain('/tmp/creds');
    expect(content.filesystem.allowWrite).toContain('/sandbox');
  });

  it('deduplicates paths', () => {
    const { settingsPath } = writeServerSettings(
      'test',
      {
        allowWrite: ['/sandbox'],
        allowRead: ['/usr'],
        denyRead: [],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    rewriteServerSettings(settingsPath, { allowRead: ['/usr', '/etc'] });

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      filesystem: { allowRead: string[] };
    };
    const usrCount = content.filesystem.allowRead.filter((p) => p === '/usr').length;
    expect(usrCount).toBe(1);
    expect(content.filesystem.allowRead).toContain('/etc');
  });

  it('handles both allowRead and allowWrite in one call', () => {
    const { settingsPath } = writeServerSettings(
      'test',
      {
        allowWrite: ['/sandbox'],
        allowRead: [],
        denyRead: ['~'],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    rewriteServerSettings(settingsPath, {
      allowRead: ['/tmp/creds'],
      allowWrite: ['/tmp/creds'],
    });

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.filesystem.allowRead).toContain('/tmp/creds');
    expect(content.filesystem.allowWrite).toContain('/tmp/creds');
  });
});

// ── discoverNodePaths ─────────────────────────────────────────────────────

describe('discoverNodePaths', () => {
  it('returns an array of strings', () => {
    const paths = discoverNodePaths();
    expect(Array.isArray(paths)).toBe(true);
    for (const p of paths) {
      expect(typeof p).toBe('string');
      expect(p).toMatch(/^\//); // absolute paths
    }
  });

  it('returns paths under home directory only', () => {
    // Use realpath-resolved home to match the implementation (discoverNodePaths
    // resolves homedir() through realpath for symlink-safe prefix comparison)
    let home: string;
    try {
      home = realpathSync(homedir());
    } catch {
      return; // skip if home can't be resolved
    }
    const paths = discoverNodePaths();
    for (const p of paths) {
      expect(p.startsWith(home + '/')).toBe(true);
    }
  });

  it('includes node installation prefix when node is under home', () => {
    let home: string;
    try {
      home = realpathSync(homedir());
    } catch {
      return;
    }
    if (!process.execPath.startsWith(home + '/')) return;
    const paths = discoverNodePaths();
    // Should include at least one path that contains the node binary
    expect(paths.length).toBeGreaterThan(0);
  });

  it('never returns a path inside the IronCurtain home', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-node-paths-')));
    try {
      const fakeHome = join(root, 'home');
      const nvmInsideIcHome = join(fakeHome, '.ironcurtain', 'nvm');
      const voltaElsewhere = join(fakeHome, '.volta');
      mkdirSync(nvmInsideIcHome, { recursive: true });
      mkdirSync(voltaElsewhere, { recursive: true });
      const paths = withEnv(
        {
          HOME: fakeHome,
          IRONCURTAIN_HOME: undefined,
          NVM_DIR: nvmInsideIcHome,
          VOLTA_HOME: voltaElsewhere,
          ASDF_DATA_DIR: undefined,
          FNM_DIR: undefined,
        },
        () => discoverNodePaths(),
      );
      expect(paths).toContain(voltaElsewhere);
      expect(paths).not.toContain(nvmInsideIcHome);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── resolveSandboxConfig with allowRead ───────────────────────────────────

describe('resolveSandboxConfig allowRead', () => {
  const sessionSandboxDir = '/sessions/abc/sandbox';

  it('defaults allowRead to the session sandbox directory', () => {
    // macOS re-allows reads inside a denied region (the IronCurtain home the
    // sandbox usually lives in) only through allowRead.
    const result = resolveSandboxConfig(makeServerConfig(), sessionSandboxDir, true, 'warn');
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowRead).toEqual([sessionSandboxDir]);
    }
  });

  it('passes through allowRead from config', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({
        sandbox: {
          filesystem: {
            denyRead: ['~'],
            allowRead: ['/usr', '/etc', '/opt/homebrew'],
          },
        },
      }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowRead).toEqual([sessionSandboxDir, '/usr', '/etc', '/opt/homebrew']);
      expect(result.config.denyRead).toContain(homedir());
      expect(result.config.denyRead).toEqual(expect.arrayContaining(baselineDenyRead()));
    }
  });

  it('expands tildes in allowRead paths', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({
        sandbox: {
          filesystem: {
            denyRead: ['~'],
            allowRead: ['~/.nvm', '/usr'],
          },
        },
      }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowRead).toContain(homedir() + '/.nvm');
      expect(result.config.allowRead).toContain('/usr');
      // Should not contain the unexpanded tilde
      expect(result.config.allowRead).not.toContain('~/.nvm');
    }
  });
});

// ── macOS Seatbelt read rules ────────────────────────────────────────────

// Evaluates the profile srt would hand to sandbox-exec, so the macOS read
// path is checked on every platform: Seatbelt re-allows reads inside a
// denied region only through allowRead (Linux re-binds allowWrite instead).
describe('macOS Seatbelt read rules for the shipped servers', () => {
  let root: string;
  let home: string;
  let icHome: string;
  let sandbox: string;
  let settingsDir: string;

  beforeEach(() => {
    ({ root, home, icHome, sandbox } = makeFakeUserHome());
    settingsDir = join(root, 'srt');
    mkdirSync(settingsDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['git', 'google-workspace'])('%s keeps its session sandbox readable but not the IronCurtain home', (name) => {
    withEnv({ HOME: home, IRONCURTAIN_HOME: undefined }, () => {
      const config = resolveSandboxed(loadShippedMcpServers()[name], sandbox, name);
      const { settingsPath, cwdPath } = writeServerSettings(name, config, settingsDir);
      const profile = macosProfileFor(settingsPath);

      expect(seatbeltReadDecision(profile, join(sandbox, 'hello.txt'))).toBe('allow');
      expect(seatbeltReadDecision(profile, join(cwdPath, 'server.log'))).toBe('allow');
      expect(seatbeltReadDecision(profile, join(icHome, 'config.json'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(icHome, 'oauth', 'google.json'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(icHome, 'sessions', 'other', 'sandbox', 'x'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(home, '.ssh', 'id_ed25519'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(home, '.aws', 'credentials'))).toBe('deny');
      expect(
        seatbeltReadDecision(profile, join(home, '.config', 'gcloud', 'application_default_credentials.json')),
      ).toBe('deny');
      expect(seatbeltReadDecision(profile, join(home, '.kube', 'config'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(home, '.bashrc'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(home, '.zshenv'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(home, '.config', 'fish', 'fish_variables'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(getTrustedSpawnCwd(), '.env'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(home, 'notes.txt'))).toBe('allow');
    });
  });

  it('git reads known_hosts on macOS while its private keys stay denied', () => {
    withEnv({ HOME: home, IRONCURTAIN_HOME: undefined }, () => {
      const config = resolveSandboxed(loadShippedMcpServers().git, sandbox, 'git');
      const { settingsPath } = writeServerSettings('git', config, settingsDir);
      const profile = macosProfileFor(settingsPath);
      expect(seatbeltReadDecision(profile, join(home, '.ssh', 'known_hosts'))).toBe('allow');
      expect(seatbeltReadDecision(profile, join(home, '.ssh', 'id_rsa'))).toBe('deny');
    });
  });

  it('would lose the session sandbox without the allowRead re-exposure (control)', () => {
    withEnv({ HOME: home, IRONCURTAIN_HOME: undefined }, () => {
      const config = resolveSandboxed(loadShippedMcpServers().git, sandbox, 'git');
      const { settingsPath } = writeServerSettings('git', config, settingsDir);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { filesystem: { allowRead: string[] } };
      settings.filesystem.allowRead = [];
      fsWriteFileSync(settingsPath, JSON.stringify(settings));
      // allowWrite alone does not re-allow reads under Seatbelt
      expect(seatbeltReadDecision(macosProfileFor(settingsPath), join(sandbox, 'hello.txt'))).toBe('deny');
    });
  });

  // Seatbelt matches the kernel's canonical path, so these decisions are
  // taken for the path a symlink really names.
  it('keeps the session sandbox readable when the IronCurtain home is a symlink', () => {
    const real = join(root, 'ic-real');
    renameSync(icHome, real);
    symlinkSync(real, icHome);
    withEnv({ HOME: home, IRONCURTAIN_HOME: undefined }, () => {
      // IronCurtain spells the sandbox under the configured (linked) home
      const config = resolveSandboxed(loadShippedMcpServers().git, sandbox, 'git');
      const { settingsPath } = writeServerSettings('git', config, settingsDir);
      const profile = macosProfileFor(settingsPath);
      expect(seatbeltReadDecision(profile, join(real, 'sessions', 'abc', 'sandbox', 'hello.txt'))).toBe('allow');
      expect(seatbeltReadDecision(profile, join(real, 'config.json'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(real, 'oauth', 'google.json'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(real, 'sessions', 'other', 'sandbox', 'x'))).toBe('deny');
    });
  });

  it('denies credential stores that a dotfile manager symlinked elsewhere', () => {
    const dotfiles = join(root, 'dotfiles');
    mkdirSync(join(dotfiles, 'ssh'), { recursive: true });
    fsWriteFileSync(join(dotfiles, 'npmrc'), 'NPM-TOKEN\n');
    fsWriteFileSync(join(dotfiles, 'ssh', 'id_rsa'), 'PRIVATE-KEY\n');
    fsWriteFileSync(join(dotfiles, 'ssh', 'known_hosts'), 'KNOWN-HOSTS\n');
    renameSync(join(home, '.aws'), join(dotfiles, 'aws'));
    rmSync(join(home, '.ssh'), { recursive: true });
    symlinkSync(join(dotfiles, 'npmrc'), join(home, '.npmrc'));
    symlinkSync(join(dotfiles, 'aws'), join(home, '.aws'));
    symlinkSync(join(dotfiles, 'ssh'), join(home, '.ssh'));
    withEnv({ HOME: home, IRONCURTAIN_HOME: undefined }, () => {
      const config = resolveSandboxed(loadShippedMcpServers().git, sandbox, 'git');
      const { settingsPath } = writeServerSettings('git', config, settingsDir);
      const profile = macosProfileFor(settingsPath);
      expect(seatbeltReadDecision(profile, join(dotfiles, 'npmrc'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(dotfiles, 'aws', 'credentials'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(dotfiles, 'ssh', 'id_rsa'))).toBe('deny');
      expect(seatbeltReadDecision(profile, join(dotfiles, 'ssh', 'known_hosts'))).toBe('allow');
    });
  });
});

// ── wrapServerCommand ────────────────────────────────────────────────────

describe('wrapServerCommand', () => {
  const settingsDir = '/tmp/test-settings';
  const srtBin = resolveNodeModulesBin('srt', resolve('.'));

  it('passes through unsandboxed servers (opt-out)', () => {
    const result = wrapServerCommand(
      'filesystem',
      'npx',
      ['server'],
      { sandboxed: false, reason: 'opt-out' },
      settingsDir,
    );
    expect(result).toEqual({ command: 'npx', args: ['server'] });
  });

  it('passes through unsandboxed servers (platform-unavailable)', () => {
    const result = wrapServerCommand(
      'exec',
      'node',
      ['server.js'],
      { sandboxed: false, reason: 'platform-unavailable' },
      settingsDir,
    );
    expect(result).toEqual({ command: 'node', args: ['server.js'] });
  });

  it('wraps sandboxed servers with srt -s -c', () => {
    const result = wrapServerCommand('exec', 'node', ['server.js'], makeSandboxedConfig(), settingsDir);
    expect(result.command).toBe(srtBin);
    expect(result.args[0]).toBe('-s');
    expect(result.args[1]).toBe(join(settingsDir, 'exec.srt-settings.json'));
    expect(result.args[2]).toBe('-c');
    expect(result.args[3]).toContain('node');
    expect(result.args[3]).toContain('server.js');
  });

  it('shell-escapes args with spaces', () => {
    const result = wrapServerCommand(
      'exec',
      'node',
      ['./servers/exec server.js', '--flag=value with spaces'],
      makeSandboxedConfig(),
      settingsDir,
    );
    const cmdString = result.args[3];
    // Relative paths are resolved to absolute; shell-quote wraps spaces in quotes
    expect(cmdString).toContain('exec server.js');
    expect(cmdString).not.toContain("'./servers/exec server.js'"); // resolved to absolute
    expect(cmdString).toContain("'--flag=value with spaces'");
  });

  it('shell-escapes args with shell metacharacters', () => {
    const result = wrapServerCommand('exec', 'node', ['--pattern=$HOME/*.txt'], makeSandboxedConfig(), settingsDir);
    const cmdString = result.args[3];
    // shell-quote should escape $ and * with backslashes to prevent shell expansion
    expect(cmdString).toContain('\\$');
    expect(cmdString).toContain('\\*');
  });

  it('preserves npm package specifiers instead of resolving them as paths', () => {
    const result = wrapServerCommand(
      'google-workspace',
      'npx',
      ['-y', '@alanse/mcp-server-google-workspace@1.0.2'],
      makeSandboxedConfig(),
      settingsDir,
    );
    const cmdString = result.args[3];
    // Scoped package specifiers must not be resolved to absolute paths.
    // shell-quote escapes @ to \@, so check the unescaped form isn't an absolute path.
    expect(cmdString).not.toContain(process.cwd());
    expect(cmdString).toContain('mcp-server-google-workspace');
  });

  it('preserves unscoped npm package specifiers with pinned versions', () => {
    const result = wrapServerCommand('some-tool', 'npx', ['-y', 'somepkg@1.2.3'], makeSandboxedConfig(), settingsDir);
    const cmdString = result.args[3];
    expect(cmdString).not.toContain(process.cwd());
    expect(cmdString).toContain('somepkg');
  });

  it('still resolves relative file paths to absolute', () => {
    const result = wrapServerCommand(
      'git',
      'node',
      ['node_modules/.bin/git-mcp-server'],
      makeSandboxedConfig(),
      settingsDir,
    );
    const cmdString = result.args[3];
    // Relative file paths should be resolved to absolute
    expect(cmdString).toContain(resolve('node_modules/.bin/git-mcp-server'));
    expect(cmdString).not.toContain(' node_modules/');
  });

  /** The argv srt will run, recovered from the shell string it is given. */
  function wrappedArgv(command: string, args: string[]): unknown[] {
    return parseShell(wrapServerCommand('custom', command, args, makeSandboxedConfig(), settingsDir).args[3]);
  }

  it('does not rewrite URLs, version pins, dotted module names, hostnames, numbers or code', () => {
    const args = [
      '--timeout',
      '1.5',
      'api.example.com',
      'https://api.example.com/v1',
      'pkg==1.2.3',
      '-m',
      'pkg.module',
      '-e',
      'require("./x.js").main()',
      'KEY=./relative/value',
      'mcp-remote',
      'file:///etc/hosts',
    ];
    expect(wrappedArgv('uvx', args)).toEqual(['uvx', ...args]);
  });

  it('rewrites ./ and ../ arguments even when they do not exist yet', () => {
    expect(wrappedArgv('node', ['./not-yet-built/server.js', '../sibling/server.js'])).toEqual([
      'node',
      resolve('./not-yet-built/server.js'),
      resolve('../sibling/server.js'),
    ]);
  });

  it('rewrites other relative paths only when they exist on disk', () => {
    expect(wrappedArgv('node', ['node_modules/.bin/git-mcp-server', 'missing/dir/server.js', 'server.js'])).toEqual([
      'node',
      resolve('node_modules/.bin/git-mcp-server'),
      'missing/dir/server.js',
      'server.js',
    ]);
  });

  it('uses correct settings file path per server name', () => {
    const resultA = wrapServerCommand('server-a', 'node', ['a.js'], makeSandboxedConfig(), settingsDir);
    const resultB = wrapServerCommand('server-b', 'node', ['b.js'], makeSandboxedConfig(), settingsDir);
    expect(resultA.args[1]).toBe(join(settingsDir, 'server-a.srt-settings.json'));
    expect(resultB.args[1]).toBe(join(settingsDir, 'server-b.srt-settings.json'));
  });
});

// ── cleanupSettingsFiles ─────────────────────────────────────────────────

describe('cleanupSettingsFiles', () => {
  it('removes the settings directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-cleanup-'));
    expect(existsSync(dir)).toBe(true);
    cleanupSettingsFiles(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('does not throw for non-existent directory', () => {
    expect(() => cleanupSettingsFiles('/tmp/does-not-exist-abc123')).not.toThrow();
  });
});

// ── annotateSandboxViolation ─────────────────────────────────────────────

describe('annotateSandboxViolation', () => {
  it('annotates EPERM errors for sandboxed servers', () => {
    const result = annotateSandboxViolation('EPERM: operation not permitted', true);
    expect(result).toBe('[SANDBOX BLOCKED] EPERM: operation not permitted');
  });

  it('annotates EACCES errors for sandboxed servers', () => {
    const result = annotateSandboxViolation('EACCES: permission denied, open /etc/shadow', true);
    expect(result).toMatch(/^\[SANDBOX BLOCKED\]/);
  });

  it('annotates "Permission denied" errors for sandboxed servers', () => {
    const result = annotateSandboxViolation('Permission denied', true);
    expect(result).toMatch(/^\[SANDBOX BLOCKED\]/);
  });

  it('annotates "Operation not permitted" errors for sandboxed servers', () => {
    const result = annotateSandboxViolation('Operation not permitted', true);
    expect(result).toMatch(/^\[SANDBOX BLOCKED\]/);
  });

  it('annotates "read-only file system" errors for sandboxed servers', () => {
    const result = annotateSandboxViolation('EROFS: read-only file system, open /usr/bin/foo', true);
    expect(result).toMatch(/^\[SANDBOX BLOCKED\]/);
  });

  it('passes through non-sandbox errors unchanged for sandboxed servers', () => {
    const result = annotateSandboxViolation('ENOENT: file not found', true);
    expect(result).toBe('ENOENT: file not found');
  });

  it('passes through errors for unsandboxed servers', () => {
    const result = annotateSandboxViolation('EPERM: operation not permitted', false);
    expect(result).toBe('EPERM: operation not permitted');
  });

  it('passes through non-permission errors for unsandboxed servers', () => {
    const result = annotateSandboxViolation('ECONNREFUSED: connection refused', false);
    expect(result).toBe('ECONNREFUSED: connection refused');
  });
});

// ── Integration tests (gated behind platform check) ─────────────────────

/**
 * The exact-pinned filesystem server IronCurtain ships (never a copy from
 * the npx cache, which may hold any upstream version).
 */
function findServerFilesystem(): string | null {
  const entry = packagedFilesystemServerEntry();
  return existsSync(entry) ? entry : null;
}

// Only run integration tests if sandbox-runtime is available
const { platformSupported, errors: depErrors } = checkSandboxAvailability();
const sandboxAvailable = platformSupported && depErrors.length === 0;

describe.skipIf(!sandboxAvailable)('sandbox integration (requires bubblewrap+socat)', () => {
  let settingsDir: string;
  let sandboxDir: string;

  beforeEach(() => {
    settingsDir = realpathSync(mkdtempSync(join(tmpdir(), 'test-srt-int-settings-')));
    sandboxDir = realpathSync(mkdtempSync(join(tmpdir(), 'test-srt-int-sandbox-')));
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  /** Creates a sandboxed MCP client connected via srt. Caller must close the client. */
  async function connectSandboxedClient(serverName: string, config: ResolvedSandboxParams, serverArgs: string[]) {
    writeServerSettings(serverName, config, settingsDir);
    const wrapped = wrapServerCommand(serverName, 'node', serverArgs, { sandboxed: true, config }, settingsDir);

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const transport = new StdioClientTransport({
      command: wrapped.command,
      args: wrapped.args,
      env: { ...(process.env as Record<string, string>) },
      stderr: 'pipe',
    });

    const client = new Client({ name: `test-${serverName}`, version: '0.1.0' }, { capabilities: {} });

    await client.connect(transport);
    return client;
  }

  /** Default sandbox params: write to sandboxDir only, no network. */
  function defaultSandboxParams(overrides: Partial<ResolvedSandboxParams> = {}): ResolvedSandboxParams {
    return {
      allowWrite: [sandboxDir],
      allowRead: [],
      denyRead: [],
      denyWrite: [],
      network: false,
      ...overrides,
    };
  }

  it('full roundtrip: spawn MCP server via srt, list tools, call tool', async () => {
    const serverPath = findServerFilesystem();
    if (!serverPath) {
      console.warn('Skipping: @modelcontextprotocol/server-filesystem not found');
      return;
    }

    const config = defaultSandboxParams();
    const client = await connectSandboxedClient('filesystem', config, [serverPath, sandboxDir]);

    try {
      const toolsResult = await client.listTools();
      const toolNames = toolsResult.tools.map((t) => t.name);
      expect(toolNames.length).toBeGreaterThan(0);
      expect(toolNames).toContain('list_directory');

      const listResult = await client.callTool({
        name: 'list_directory',
        arguments: { path: sandboxDir },
      });
      expect(listResult.isError).toBeFalsy();
    } finally {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
  }, 30000);

  // macOS sandbox-exec auto-whitelists the TMPDIR parent (/var/folders/XX/YYY) for writes,
  // so temp-dir-based "outside sandbox" paths are unrestricted. Linux bubblewrap enforces this.
  it.skipIf(process.platform !== 'linux')(
    'sandbox blocks writes outside allowWrite',
    async () => {
      const serverPath = findServerFilesystem();
      if (!serverPath) {
        console.warn('Skipping: @modelcontextprotocol/server-filesystem not found');
        return;
      }

      const config = defaultSandboxParams();
      // Serve the parent of sandboxDir so server can see both inside and outside paths
      const serveDir = resolve(sandboxDir, '..');
      const client = await connectSandboxedClient('filesystem', config, [serverPath, serveDir]);

      try {
        // Write outside sandbox (but inside serveDir) should be blocked by srt
        const outsidePath = join(serveDir, `srt-test-outside-${Date.now()}.txt`);
        const writeResult = await client.callTool({
          name: 'write_file',
          arguments: { path: outsidePath, content: 'should not work' },
        });
        expect(writeResult.isError).toBe(true);
        const errorText = JSON.stringify(writeResult.content);
        expect(errorText).toMatch(/EACCES|EPERM|Permission denied|Read-only|Access denied/i);

        // Write inside sandbox should work
        const insidePath = join(sandboxDir, 'test-inside.txt');
        const insideResult = await client.callTool({
          name: 'write_file',
          arguments: { path: insidePath, content: 'inside sandbox' },
        });
        expect(insideResult.isError).toBeFalsy();
      } finally {
        try {
          await client.close();
        } catch {
          /* ignore */
        }
      }
    },
    30000,
  );

  it('two srt processes with different settings coexist', async () => {
    const serverPath = findServerFilesystem();
    if (!serverPath) {
      console.warn('Skipping: @modelcontextprotocol/server-filesystem not found');
      return;
    }

    const configA = defaultSandboxParams();
    const configB = defaultSandboxParams({
      network: { allowedDomains: ['example.com'], deniedDomains: [] },
    });

    const clientA = await connectSandboxedClient('server-a', configA, [serverPath, sandboxDir]);
    const clientB = await connectSandboxedClient('server-b', configB, [serverPath, sandboxDir]);

    try {
      const toolsA = await clientA.listTools();
      const toolsB = await clientB.listTools();
      expect(toolsA.tools.length).toBeGreaterThan(0);
      expect(toolsB.tools.length).toBeGreaterThan(0);

      // Both should list the sandbox directory
      const listA = await clientA.callTool({ name: 'list_directory', arguments: { path: sandboxDir } });
      const listB = await clientB.callTool({ name: 'list_directory', arguments: { path: sandboxDir } });
      expect(listA.isError).toBeFalsy();
      expect(listB.isError).toBeFalsy();
    } finally {
      try {
        await clientA.close();
      } catch {
        /* ignore */
      }
      try {
        await clientB.close();
      } catch {
        /* ignore */
      }
    }
  }, 30000);

  // Verify that SSH agent socket is accessible from within the sandbox
  // when allowUnixSockets includes the socket's parent directory.
  it.skipIf(!canExerciseSshAgentSocket)(
    'sandboxed process can reach SSH agent socket via allowUnixSockets',
    () => {
      const sshAuthSock = process.env.SSH_AUTH_SOCK!;

      // Write settings WITH allowUnixSockets (what the git backend gets)
      const config: ResolvedSandboxParams = {
        allowWrite: [sandboxDir],
        allowRead: [],
        denyRead: [],
        denyWrite: [],
        network: {
          allowedDomains: ['github.com', '*.github.com'],
          deniedDomains: [],
        },
      };
      writeServerSettings('git-ssh-test', config, settingsDir, { sshAgent: true });

      // The settings file should have allowUnixSockets from our fix
      const settingsPath = join(settingsDir, 'git-ssh-test.srt-settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.network.allowUnixSockets).toEqual([resolve(sshAuthSock)]);

      const wrapped = wrapServerCommand('git-ssh-test', 'node', [], { sandboxed: true, config }, settingsDir);

      // Run ssh-add -l inside the sandbox — if the socket is reachable this exits 0
      // and prints the key fingerprint. If blocked, ssh-add fails with exit code 2.
      const result = execFileSync(
        wrapped.command,
        [
          ...wrapped.args.slice(0, -1), // drop the original "-c node" command
          'ssh-add -l',
        ],
        {
          env: { ...process.env },
          timeout: 10000,
          encoding: 'utf-8',
        },
      );

      // ssh-add -l should list at least one key (the user has keys loaded)
      expect(result).toContain('SHA256:');
    },
    15000,
  );

  // Verify that WITHOUT allowUnixSockets, the SSH agent socket is NOT accessible.
  it.skipIf(!canExerciseSshAgentSocket)(
    'sandboxed process cannot reach SSH agent socket without allowUnixSockets',
    () => {
      // A networked server not granted the ssh agent (every server but git)
      const config: ResolvedSandboxParams = {
        allowWrite: [sandboxDir],
        allowRead: [],
        denyRead: [],
        denyWrite: [],
        network: {
          allowedDomains: ['github.com', '*.github.com'],
          deniedDomains: [],
        },
      };
      writeServerSettings('git-no-ssh', config, settingsDir);
      const settingsPath = join(settingsDir, 'git-no-ssh.srt-settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.network.allowUnixSockets).toBeUndefined();

      const wrapped = wrapServerCommand('git-no-ssh', 'node', [], { sandboxed: true, config }, settingsDir);

      // ssh-add -l should fail because the Unix socket is blocked
      try {
        execFileSync(wrapped.command, [...wrapped.args.slice(0, -1), 'ssh-add -l'], {
          env: { ...process.env },
          timeout: 10000,
          encoding: 'utf-8',
        });
        // If we get here, the socket was unexpectedly reachable
        expect.unreachable('ssh-add should have failed without allowUnixSockets');
      } catch (err: unknown) {
        // ssh-add exits with code 2 when it can't contact the agent
        const error = err as { status: number; stderr: string; stdout: string };
        expect(error.status).not.toBe(0);
      }
    },
    15000,
  );
});

// ── Read containment under bubblewrap (Linux integration) ───────────────

/**
 * Whether srt can run any command here. Having bwrap and socat installed is
 * not enough: some containers forbid the user namespaces bwrap or srt's
 * seccomp helper need, and then nothing sandboxed runs at all (the
 * roundtrip tests above fail loudly in that case).
 */
function srtRunsCommands(settingsDir: string, workDir: string): { ok: boolean; detail: string } {
  const config: ResolvedSandboxParams = {
    allowWrite: [workDir],
    allowRead: [],
    denyRead: [],
    denyWrite: [],
    network: false,
  };
  writeServerSettings('probe', config, settingsDir);
  const wrapped = wrapServerCommand('probe', 'true', [], { sandboxed: true, config }, settingsDir);
  try {
    execFileSync(wrapped.command, wrapped.args, { cwd: workDir, timeout: 30_000, stdio: 'pipe' });
    return { ok: true, detail: '' };
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    return { ok: false, detail: stderr || String(err) };
  }
}

describe.skipIf(!sandboxAvailable || process.platform !== 'linux')(
  'read containment under bubblewrap (requires a working srt)',
  () => {
    let root: string;
    let home: string;
    let icHome: string;
    let sandbox: string;

    beforeEach(() => {
      ({ root, home, icHome, sandbox } = makeFakeUserHome());
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    /** Runs a shell command under a server's srt settings, as the relay would spawn it. */
    function runSandboxed(
      serverName: string,
      config: ResolvedSandboxParams,
      settingsDir: string,
      cwd: string,
      shellCommand: string,
    ): { status: number; stdout: string } {
      const wrapped = wrapServerCommand(
        serverName,
        'sh',
        ['-c', shellCommand],
        { sandboxed: true, config },
        settingsDir,
      );
      try {
        const stdout = execFileSync(wrapped.command, wrapped.args, {
          cwd,
          env: { ...process.env, HOME: home },
          timeout: 30_000,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { status: 0, stdout };
      } catch (err) {
        const e = err as { status?: number | null; stdout?: string };
        return { status: e.status ?? -1, stdout: e.stdout ?? '' };
      }
    }

    it('the shipped git server cannot read ~/.ironcurtain/config.json but keeps its session sandbox', (ctx) => {
      const probeDir = join(root, 'probe');
      mkdirSync(join(probeDir, 'work'), { recursive: true });
      const probe = srtRunsCommands(probeDir, join(probeDir, 'work'));
      if (!probe.ok) {
        console.warn(`Skipping: srt cannot run sandboxed commands here: ${probe.detail}`);
        ctx.skip();
      }

      const credentialDirs = { ANTHROPIC_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined, CODEX_HOME: undefined };
      withEnv({ HOME: home, IRONCURTAIN_HOME: undefined, ...credentialDirs }, () => {
        const settingsDir = join(root, 'srt');
        mkdirSync(settingsDir);
        const config = resolveSandboxed(loadShippedMcpServers().git, sandbox, 'git');
        const { cwdPath } = writeServerSettings('git', config, settingsDir);
        const run = (cmd: string) => runSandboxed('git', config, settingsDir, cwdPath, cmd);

        const configRead = run(`cat '${join(icHome, 'config.json')}'`);
        expect(configRead.status).not.toBe(0);
        expect(configRead.stdout).not.toContain('IC-CONFIG-SECRET');
        const tokenRead = run(`cat '${join(icHome, 'oauth', 'google.json')}'`);
        expect(tokenRead.stdout).not.toContain('REFRESH-TOKEN');

        expect(run(`cat '${join(sandbox, 'hello.txt')}'`)).toEqual({ status: 0, stdout: 'HELLO-SANDBOX\n' });
        expect(run(`echo WRITTEN > '${join(sandbox, 'new.txt')}'`).status).toBe(0);
        expect(readFileSync(join(sandbox, 'new.txt'), 'utf-8')).toBe('WRITTEN\n');

        expect(run(`cat '${join(home, '.ssh', 'known_hosts')}'`)).toEqual({ status: 0, stdout: 'KNOWN-HOSTS\n' });
        expect(run(`cat '${join(home, '.ssh', 'id_ed25519')}'`).stdout).not.toContain('PRIVATE-KEY');
        expect(run(`cat '${join(home, '.aws', 'credentials')}'`).stdout).not.toContain('AWS-SECRET');
        const anthropicStore = join(home, '.config', 'anthropic', 'credentials', 'default.json');
        expect(run(`cat '${anthropicStore}'`).stdout).not.toContain('ANTHROPIC-CLI-OAUTH');
      });
    }, 90_000);
  },
);
