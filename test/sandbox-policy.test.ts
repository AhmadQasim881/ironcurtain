/**
 * sandboxPolicy: user-configurable, fail closed per server, visible
 * warnings, truthful audit stamps.
 *
 * Covers the policy resolution (env > config > platform default, invalid
 * values rejected), per-server enforcement against the shipped
 * mcp-servers.json, what the session parent hands its relays, the
 * session-start notice, the audit `sandboxed` stamp, and the offline
 * pipeline relay. Host sandbox availability is always injected, so these
 * tests behave the same with or without bubblewrap/socat/ripgrep.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SandboxPolicyError,
  defaultSandboxPolicy,
  effectiveSandboxPolicy,
  readSandboxPolicyEnv,
  resolveSandboxPolicy,
  resolveSandboxPolicyWithSource,
  sandboxPolicyEnv,
} from '../src/config/sandbox-policy.js';
import { loadUserConfig, saveUserConfig, userConfigSchema } from '../src/config/user-config.js';
import { loadConfig } from '../src/config/index.js';
import type { IronCurtainConfig, MCPServerConfig } from '../src/config/types.js';
import {
  formatOsSandboxNotice,
  formatSandboxRefusal,
  getOsSandboxAvailability,
  isOsSandboxFixableByInstall,
  osSandboxNoticeForConfig,
  parseOsSandboxAvailabilityEnv,
  planServerSandboxing,
  writeOsSandboxNotice,
  type OsSandboxAvailability,
  type OsSandboxSmokeResult,
} from '../src/trusted-process/sandbox-integration.js';
import {
  buildProxySubprocessEnv,
  planSessionOsSandbox,
  relayServerNames,
  reportOsSandboxPlan,
  resolveSessionOsSandboxPlan,
} from '../src/sandbox/index.js';
import { auditSandboxStamp, buildAuditEntry } from '../src/trusted-process/tool-call-pipeline.js';
import { applyOsSandboxPolicy } from '../src/pipeline/proxy-mcp-connections.js';

// ── Fixtures ───────────────────────────────────────────────────────────

const SHIPPED_SERVERS_PATH = resolve(__dirname, '..', 'src', 'config', 'mcp-servers.json');

/** A fresh copy of the shipped server definitions (filesystem, git, fetch, github, google-workspace). */
function shippedServers(): Record<string, MCPServerConfig> {
  return JSON.parse(readFileSync(SHIPPED_SERVERS_PATH, 'utf-8')) as Record<string, MCPServerConfig>;
}

/** What sandbox-runtime reports on a stock Linux host without the helpers. */
const MISSING_DEPS: OsSandboxAvailability = {
  available: false,
  platformSupported: true,
  problems: ['ripgrep (rg) not found', 'bubblewrap (bwrap) not installed', 'socat not installed'],
  warnings: [],
};

const AVAILABLE: OsSandboxAvailability = { available: true, platformSupported: true, problems: [], warnings: [] };

function sessionConfig(overrides: Partial<IronCurtainConfig> = {}): IronCurtainConfig {
  return {
    auditLogPath: '/tmp/audit.jsonl',
    allowedDirectory: '/tmp/ironcurtain-sandbox-policy-test',
    mcpServers: shippedServers(),
    protectedPaths: [],
    generatedDir: '/tmp/generated',
    constitutionPath: '/tmp/constitution.md',
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {} as IronCurtainConfig['userConfig'],
    ...overrides,
  };
}

const POLICY_ENV = ['IRONCURTAIN_SANDBOX_POLICY', 'SANDBOX_POLICY'] as const;

/** Saves and clears the policy env vars (and IRONCURTAIN_HOME) around each test. */
function isolatePolicyEnv(): void {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of [...POLICY_ENV, 'IRONCURTAIN_HOME', 'ALLOWED_DIRECTORY']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// ── Resolution ─────────────────────────────────────────────────────────

describe('sandboxPolicy resolution', () => {
  it('defaults to enforce on Linux and macOS and to warn elsewhere', () => {
    expect(defaultSandboxPolicy('linux')).toBe('enforce');
    expect(defaultSandboxPolicy('darwin')).toBe('enforce');
    expect(defaultSandboxPolicy('win32')).toBe('warn');
    expect(defaultSandboxPolicy('freebsd')).toBe('warn');
  });

  it('applies env > config > default, with IRONCURTAIN_SANDBOX_POLICY before SANDBOX_POLICY', () => {
    expect(resolveSandboxPolicyWithSource(undefined, {}, 'linux')).toEqual({ policy: 'enforce', source: 'default' });
    expect(resolveSandboxPolicyWithSource('warn', {}, 'linux')).toEqual({ policy: 'warn', source: 'config' });
    expect(resolveSandboxPolicyWithSource('warn', { SANDBOX_POLICY: 'enforce' }, 'linux')).toEqual({
      policy: 'enforce',
      source: 'SANDBOX_POLICY',
    });
    expect(
      resolveSandboxPolicyWithSource('enforce', { SANDBOX_POLICY: 'enforce', IRONCURTAIN_SANDBOX_POLICY: 'warn' }),
    ).toEqual({ policy: 'warn', source: 'IRONCURTAIN_SANDBOX_POLICY' });
  });

  it('ignores empty values and normalizes case and whitespace', () => {
    expect(resolveSandboxPolicy('warn', { IRONCURTAIN_SANDBOX_POLICY: '', SANDBOX_POLICY: '  ' })).toBe('warn');
    expect(resolveSandboxPolicy('warn', { SANDBOX_POLICY: ' Enforce\n' })).toBe('enforce');
  });

  it.each([
    ['IRONCURTAIN_SANDBOX_POLICY', 'enfroce'],
    ['SANDBOX_POLICY', 'off'],
    ['SANDBOX_POLICY', 'true'],
  ])('rejects %s=%s instead of falling back to a weaker mode', (name, value) => {
    expect(() => readSandboxPolicyEnv({ [name]: value })).toThrow(SandboxPolicyError);
    try {
      readSandboxPolicyEnv({ [name]: value });
    } catch (err) {
      expect((err as SandboxPolicyError).code).toBe('INVALID_SANDBOX_POLICY');
      expect((err as Error).message).toContain(`Invalid ${name}`);
      expect((err as Error).message).toContain('"enforce" or "warn"');
    }
  });

  it('effectiveSandboxPolicy prefers the resolved config value, then the user config, then resolution', () => {
    expect(effectiveSandboxPolicy({ sandboxPolicy: 'warn', userConfig: { sandboxPolicy: 'enforce' } })).toBe('warn');
    expect(effectiveSandboxPolicy({ userConfig: { sandboxPolicy: 'warn' } })).toBe('warn');
    expect(effectiveSandboxPolicy({})).toBe(resolveSandboxPolicy(undefined));
  });

  it('hands relays the policy under both variable names', () => {
    expect(sandboxPolicyEnv('warn')).toEqual({ IRONCURTAIN_SANDBOX_POLICY: 'warn', SANDBOX_POLICY: 'warn' });
  });
});

// ── User config ────────────────────────────────────────────────────────

describe('sandboxPolicy in ~/.ironcurtain/config.json', () => {
  isolatePolicyEnv();
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-sandbox-policy-'));
    process.env.IRONCURTAIN_HOME = home;
    process.env.ALLOWED_DIRECTORY = resolve(home, 'sandbox');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  function writeConfig(content: Record<string, unknown>): void {
    writeFileSync(resolve(home, 'config.json'), JSON.stringify(content), { mode: 0o600 });
  }

  it('is a known, validated field', () => {
    expect(userConfigSchema.safeParse({ sandboxPolicy: 'enforce' }).success).toBe(true);
    expect(userConfigSchema.safeParse({ sandboxPolicy: 'warn' }).success).toBe(true);
    expect(userConfigSchema.safeParse({ sandboxPolicy: 'off' }).success).toBe(false);
  });

  it('reads the configured value without an unknown-field warning', () => {
    writeConfig({ sandboxPolicy: 'warn' });

    expect(loadUserConfig().sandboxPolicy).toBe('warn');
    const stderr = vi
      .mocked(process.stderr.write)
      .mock.calls.map((c) => String(c[0]))
      .join('');
    expect(stderr).not.toContain('unknown field "sandboxPolicy"');
  });

  it('rejects an invalid configured value', () => {
    writeConfig({ sandboxPolicy: 'sometimes' });
    expect(() => loadUserConfig()).toThrow(/sandboxPolicy/);
  });

  it('uses the platform default when unset and does not backfill it into the file', () => {
    writeConfig({});

    expect(loadUserConfig().sandboxPolicy).toBe(defaultSandboxPolicy());
    const onDisk = JSON.parse(readFileSync(resolve(home, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty('sandboxPolicy');
  });

  it('lets an explicit env value win over the config file', () => {
    writeConfig({ sandboxPolicy: 'warn' });
    process.env.SANDBOX_POLICY = 'enforce';
    expect(loadUserConfig().sandboxPolicy).toBe('enforce');

    writeConfig({ sandboxPolicy: 'enforce' });
    process.env.IRONCURTAIN_SANDBOX_POLICY = 'warn';
    expect(loadUserConfig().sandboxPolicy).toBe('warn');
  });

  it('rejects an invalid env value at config load', () => {
    writeConfig({ sandboxPolicy: 'enforce' });
    process.env.SANDBOX_POLICY = 'bogus';
    expect(() => loadUserConfig()).toThrow(/Invalid SANDBOX_POLICY/);
  });

  it('loadConfig() carries the resolved policy into the session config', () => {
    writeConfig({ sandboxPolicy: 'warn' });
    expect(loadConfig().sandboxPolicy).toBe('warn');

    process.env.IRONCURTAIN_SANDBOX_POLICY = 'enforce';
    expect(loadConfig().sandboxPolicy).toBe('enforce');
  });

  it('saveUserConfig persists the setting', () => {
    writeConfig({});
    saveUserConfig({ sandboxPolicy: 'warn' });
    const onDisk = JSON.parse(readFileSync(resolve(home, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(onDisk.sandboxPolicy).toBe('warn');
    expect(() => saveUserConfig({ sandboxPolicy: 'never' as 'warn' })).toThrow(/sandboxPolicy/);
  });
});

// ── Per-server enforcement ─────────────────────────────────────────────

describe('per-server enforcement with the shipped mcp-servers.json', () => {
  // The filesystem server is confined to its roots (WP-11): it needs the OS
  // sandbox like git and google-workspace, so "enforce" refuses it when the
  // sandbox is unavailable and "warn" runs it unconfined, as before WP-11.
  it('enforce with missing deps refuses filesystem, git and google-workspace but not fetch or github', () => {
    const plan = planServerSandboxing(shippedServers(), '/tmp/sbx', MISSING_DEPS, 'enforce');

    expect([...plan.refused].sort()).toEqual(['filesystem', 'git', 'google-workspace']);
    expect(plan.unconfined).toEqual([]);
    expect([...plan.resolved.keys()].sort()).toEqual(['fetch', 'github']);
    for (const name of ['fetch', 'github']) {
      expect(plan.resolved.get(name)).toEqual({ sandboxed: false, reason: 'opt-out' });
    }
  });

  it('warn with missing deps starts everything and lists the unconfined servers', () => {
    const plan = planServerSandboxing(shippedServers(), '/tmp/sbx', MISSING_DEPS, 'warn');

    expect(plan.refused).toEqual([]);
    expect([...plan.unconfined].sort()).toEqual(['filesystem', 'git', 'google-workspace']);
    expect(plan.resolved.get('filesystem')).toEqual({ sandboxed: false, reason: 'platform-unavailable' });
    expect(plan.resolved.get('git')).toEqual({ sandboxed: false, reason: 'platform-unavailable' });
    expect(plan.resolved.get('google-workspace')).toEqual({ sandboxed: false, reason: 'platform-unavailable' });
  });

  it('sandboxes filesystem (confined to its roots), git and google-workspace when the OS sandbox is available', () => {
    const plan = planServerSandboxing(shippedServers(), '/tmp/sbx', AVAILABLE, 'enforce');

    expect(plan.refused).toEqual([]);
    expect(plan.unconfined).toEqual([]);
    const filesystem = plan.resolved.get('filesystem');
    expect(filesystem?.sandboxed).toBe(true);
    expect(filesystem?.sandboxed === true && filesystem.config.confineToRoots).toBe(true);
    expect(plan.resolved.get('git')?.sandboxed).toBe(true);
    expect(plan.resolved.get('google-workspace')?.sandboxed).toBe(true);
    expect(formatOsSandboxNotice(plan)).toBeUndefined();
  });

  it('treats an unsupported platform as unavailable', () => {
    const availability = getOsSandboxAvailability(
      () => ({ platformSupported: false, errors: [], warnings: [] }),
      'win32',
    );
    expect(availability.available).toBe(false);
    expect(availability.problems[0]).toContain('"win32" is not supported');

    const plan = planServerSandboxing(shippedServers(), '/tmp/sbx', availability, 'enforce');
    expect([...plan.refused].sort()).toEqual(['filesystem', 'git', 'google-workspace']);
  });

  it('does not suggest installing packages when the problem is not a missing tool', () => {
    // bubblewrap is installed but cannot map uid 0 (root without CAP_SETFCAP):
    // sandbox-runtime's own message carries the remedy.
    const rootWithoutSetfcap: OsSandboxAvailability = {
      available: false,
      platformSupported: true,
      problems: ["running as uid 0 without CAP_SETFCAP in this process's capability bounding set"],
      warnings: [],
    };

    const refusal = formatSandboxRefusal('git', rootWithoutSetfcap);
    expect(refusal).not.toContain('apt-get');
    expect(refusal).toContain('`ironcurtain doctor`');
    expect(refusal).toContain('IRONCURTAIN_SANDBOX_POLICY=warn');

    const warnNotice = formatOsSandboxNotice(
      planServerSandboxing(shippedServers(), '/tmp/sbx', rootWithoutSetfcap, 'warn'),
    );
    expect(warnNotice).toContain('CAP_SETFCAP');
    expect(warnNotice).not.toContain('apt-get');
    // One pointer at doctor, not "see `ironcurtain doctor`, or run `ironcurtain doctor`".
    expect(warnNotice?.split('ironcurtain doctor')).toHaveLength(2);
  });

  it('offers the Linux install command only for missing bubblewrap, socat or ripgrep', () => {
    const unavailable = (problems: string[], platformSupported = true): OsSandboxAvailability => ({
      available: false,
      platformSupported,
      problems,
      warnings: [],
    });

    expect(isOsSandboxFixableByInstall(MISSING_DEPS)).toBe(true);
    expect(isOsSandboxFixableByInstall(unavailable(['socat not executable at /opt/socat']))).toBe(true);
    // Windows' sandbox helper is not an apt package.
    expect(isOsSandboxFixableByInstall(unavailable(['srt-win.exe not found. Set windows.srtWin.path']))).toBe(false);
    expect(isOsSandboxFixableByInstall(unavailable(['platform "win32" is not supported'], false))).toBe(false);
  });

  it('refusal messages name the missing tools and both ways out', () => {
    const message = formatSandboxRefusal('git', MISSING_DEPS);
    expect(message).toContain('Not starting MCP server "git"');
    expect(message).toContain('ripgrep (rg) not found; bubblewrap (bwrap) not installed; socat not installed');
    expect(message).toContain('sudo apt-get install -y bubblewrap socat ripgrep');
    expect(message).toContain('IRONCURTAIN_SANDBOX_POLICY=warn');
    expect(message).toContain('`ironcurtain config` > Security');
  });
});

// ── Session parent ─────────────────────────────────────────────────────

describe('session parent: relays, child env and the session-start notice', () => {
  isolatePolicyEnv();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stderrWrites(): string[] {
    return vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
  }

  it('does not spawn relays for refused servers under enforce', () => {
    const config = sessionConfig({ sandboxPolicy: 'enforce' });
    const plan = planSessionOsSandbox(config, MISSING_DEPS);

    expect(relayServerNames(config, plan).sort()).toEqual(['fetch', 'github']);
  });

  it('spawns every relay under warn', () => {
    const config = sessionConfig({ sandboxPolicy: 'warn' });
    const plan = planSessionOsSandbox(config, MISSING_DEPS);

    expect(relayServerNames(config, plan).sort()).toEqual(['fetch', 'filesystem', 'git', 'github', 'google-workspace']);
  });

  it('hands relays the session policy instead of a hard-coded "warn"', () => {
    const config = sessionConfig({ sandboxPolicy: 'warn' });
    const env = buildProxySubprocessEnv(config, planSessionOsSandbox(config, MISSING_DEPS));
    expect(env.SANDBOX_POLICY).toBe('warn');
    expect(env.IRONCURTAIN_SANDBOX_POLICY).toBe('warn');

    const enforcing = sessionConfig({ sandboxPolicy: 'enforce' });
    const enforcingEnv = buildProxySubprocessEnv(enforcing, planSessionOsSandbox(enforcing, MISSING_DEPS));
    expect(enforcingEnv.SANDBOX_POLICY).toBe('enforce');
    expect(enforcingEnv.IRONCURTAIN_SANDBOX_POLICY).toBe('enforce');
  });

  it('carries configured credential paths consistently in the parent plan and relay metadata', () => {
    const config = sessionConfig();
    config.userConfig = {
      ...config.userConfig,
      credentialProtection: { extraPaths: ['/configured/extra-store'], disabledStores: [] },
    };
    const plan = planSessionOsSandbox(config, AVAILABLE);
    const env = buildProxySubprocessEnv(config, plan);
    expect(JSON.parse(env.SANDBOX_CREDENTIAL_PATHS)).toContain('/configured/extra-store');
    for (const resolved of plan.resolved.values()) {
      if (resolved.sandboxed) expect(resolved.config.denyRead).toContain('/configured/extra-store');
    }
  });

  it('makes relays refuse rather than run unconfined when the parent stamped servers as sandboxed', () => {
    const config = sessionConfig({ sandboxPolicy: 'warn' });
    const env = buildProxySubprocessEnv(config, planSessionOsSandbox(config, AVAILABLE));
    expect(env.SANDBOX_POLICY).toBe('enforce');
  });

  // The plan replaced the parent's resolveSandboxConfigsForAudit, which
  // stopped the session when a server's sandbox config would re-expose the
  // IronCurtain home (read containment). The plan must keep doing so, before
  // any relay is spawned, and name the server.
  it.each(['enforce', 'warn'] as const)(
    'fails the session closed when a sandboxed server would re-expose the IronCurtain home (%s)',
    (policy) => {
      const home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-sandbox-policy-home-'));
      try {
        process.env.IRONCURTAIN_HOME = home;
        const config = sessionConfig({
          sandboxPolicy: policy,
          mcpServers: {
            ...shippedServers(),
            custom: { command: 'node', args: [], sandbox: { filesystem: { allowRead: [resolve(home, 'oauth')] } } },
          },
        });

        let caught: unknown;
        try {
          planSessionOsSandbox(config, AVAILABLE);
        } catch (err) {
          caught = err;
        }
        expect((caught as { code?: unknown } | undefined)?.code).toBe('SANDBOX_CONFIG_INVALID');
        expect((caught as Error).message).toContain('Server "custom"');
        expect((caught as Error).message).toContain('would expose the IronCurtain home');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it('lets an explicit env value win over config all the way to the relay', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-sandbox-policy-session-'));
    try {
      process.env.IRONCURTAIN_HOME = home;
      process.env.ALLOWED_DIRECTORY = resolve(home, 'sandbox');
      writeFileSync(resolve(home, 'config.json'), JSON.stringify({ sandboxPolicy: 'warn' }), { mode: 0o600 });
      process.env.SANDBOX_POLICY = 'enforce';
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      const config = loadConfig();
      const plan = planSessionOsSandbox(config, MISSING_DEPS);

      expect(plan.policy).toBe('enforce');
      expect([...plan.refused].sort()).toEqual(['filesystem', 'git', 'google-workspace']);
      expect(buildProxySubprocessEnv(config, plan).SANDBOX_POLICY).toBe('enforce');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('warn prints a one-line stderr notice naming the unconfined servers', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const plan = planSessionOsSandbox(sessionConfig({ sandboxPolicy: 'warn' }), MISSING_DEPS);

    reportOsSandboxPlan(plan);

    const writes = stderrWrites();
    expect(writes).toHaveLength(1);
    const line = writes[0];
    expect(line.trimEnd().split('\n')).toHaveLength(1);
    expect(line).toContain('WITHOUT OS containment');
    expect(line).toContain('filesystem, git, google-workspace');
    expect(line).toContain('ripgrep (rg) not found');
    expect(line).toContain('sandboxPolicy "warn"');
  });

  it('enforce prints a one-line stderr notice naming the refused servers and how to switch', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const plan = planSessionOsSandbox(sessionConfig({ sandboxPolicy: 'enforce' }), MISSING_DEPS);

    reportOsSandboxPlan(plan);

    const writes = stderrWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('not starting MCP server(s) that require it: filesystem, git, google-workspace');
    expect(writes[0]).toContain('IRONCURTAIN_SANDBOX_POLICY=warn');
    expect(writes[0]).toContain('sudo apt-get install -y bubblewrap socat ripgrep');
  });

  it('prints nothing when every server that asks for a sandbox gets one', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    reportOsSandboxPlan(planSessionOsSandbox(sessionConfig({ sandboxPolicy: 'warn' }), AVAILABLE));
    expect(stderrWrites()).toEqual([]);
  });

  it('writes notices on a clean line on a TTY and escapes control characters', () => {
    const chunks: string[] = [];
    const tty = { isTTY: true, write: (chunk: string) => chunks.push(chunk) };
    writeOsSandboxNotice('IronCurtain: server "evil\u001b]52;c;x\u0007"', tty);
    expect(chunks[0].startsWith('\r\u001b[K')).toBe(true);
    expect(chunks[0]).not.toContain('\u001b]52');
    expect(chunks[0]).toContain('\\u001b]52');

    const pipe = { write: (chunk: string) => chunks.push(chunk) };
    writeOsSandboxNotice('plain', pipe);
    expect(chunks[1]).toBe('plain\n');
  });

  it('osSandboxNoticeForConfig gives the daemon the same notice for a config', () => {
    const config = sessionConfig({ sandboxPolicy: 'warn' });
    expect(osSandboxNoticeForConfig(config, MISSING_DEPS)).toContain('git, google-workspace');
    expect(osSandboxNoticeForConfig(config, AVAILABLE)).toBeUndefined();
  });

  it('hands every relay the availability it planned with', () => {
    const config = sessionConfig({ sandboxPolicy: 'warn' });
    for (const availability of [AVAILABLE, MISSING_DEPS]) {
      const env = buildProxySubprocessEnv(config, planSessionOsSandbox(config, availability));
      expect(parseOsSandboxAvailabilityEnv(env.OS_SANDBOX_AVAILABILITY)).toEqual(availability);
    }
  });
});

// ── Session start where srt cannot start a sandbox (FU-02, 01-08) ──────

describe('session start: the srt smoke run decides availability', () => {
  isolatePolicyEnv();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** bubblewrap, socat and ripgrep are installed, but srt cannot start a sandbox here. */
  const smokeFails = vi.fn(async (): Promise<OsSandboxSmokeResult> => ({
    ok: false,
    elapsedMs: 7,
    detail: '/usr/bin/bash: line 4: .../apply-seccomp: Permission denied',
  }));
  const smokePasses = vi.fn(async (): Promise<OsSandboxSmokeResult> => ({ ok: true, elapsedMs: 7, detail: 'ok' }));

  beforeEach(() => {
    smokeFails.mockClear();
    smokePasses.mockClear();
  });

  // Before: availability came from the dependency check alone, so the plan
  // said "available" and the servers were wrapped in an srt that failed.
  it('refuses the sandboxed servers under enforce, with a notice that names the srt failure', async () => {
    const config = sessionConfig({ sandboxPolicy: 'enforce' });
    const plan = await resolveSessionOsSandboxPlan(config, { dependencies: AVAILABLE, smokeTest: smokeFails });

    expect(smokeFails).toHaveBeenCalledOnce();
    expect(plan.availability.available).toBe(false);
    expect([...plan.refused].sort()).toEqual(['filesystem', 'git', 'google-workspace']);
    expect(relayServerNames(config, plan).sort()).toEqual(['fetch', 'github']);
    const notice = formatOsSandboxNotice(plan);
    expect(notice).toContain('srt cannot start a sandbox on this host: /usr/bin/bash: line 4: .../apply-seccomp');
    expect(notice).toContain('not starting MCP server(s) that require it: filesystem, git, google-workspace');
    expect(notice).toContain('IRONCURTAIN_SANDBOX_POLICY=warn');
    // Installing packages would not help; doctor would.
    expect(notice).not.toContain('apt-get');
    expect(formatSandboxRefusal('git', plan.availability)).toContain('srt cannot start a sandbox on this host');
  });

  it('runs them unconfined under warn, stamps them unsandboxed and tells every relay so', async () => {
    const config = sessionConfig({ sandboxPolicy: 'warn' });
    const plan = await resolveSessionOsSandboxPlan(config, { dependencies: AVAILABLE, smokeTest: smokeFails });

    expect(plan.refused).toEqual([]);
    expect([...plan.unconfined].sort()).toEqual(['filesystem', 'git', 'google-workspace']);
    expect(plan.resolved.get('git')).toEqual({ sandboxed: false, reason: 'platform-unavailable' });
    expect(auditSandboxStamp(plan.resolved.get('git'))).toBe(false);
    expect(formatOsSandboxNotice(plan)).toContain('WITHOUT OS containment: filesystem, git, google-workspace');

    // The relay gets the session policy (not the "enforce" of an available
    // sandbox) and the parent's verdict, so it runs them unconfined too.
    const env = buildProxySubprocessEnv(config, plan);
    expect(env.SANDBOX_POLICY).toBe('warn');
    expect(parseOsSandboxAvailabilityEnv(env.OS_SANDBOX_AVAILABILITY)).toEqual(plan.availability);
  });

  it('sandboxes them when the smoke run passes', async () => {
    const config = sessionConfig({ sandboxPolicy: 'enforce' });
    const plan = await resolveSessionOsSandboxPlan(config, { dependencies: AVAILABLE, smokeTest: smokePasses });

    expect(plan.availability).toEqual(AVAILABLE);
    expect(plan.refused).toEqual([]);
    expect(plan.resolved.get('git')?.sandboxed).toBe(true);
    expect(buildProxySubprocessEnv(config, plan).SANDBOX_POLICY).toBe('enforce');
  });

  it('runs no smoke test when a dependency is missing or no server asks for the sandbox', async () => {
    const missing = await resolveSessionOsSandboxPlan(sessionConfig({ sandboxPolicy: 'enforce' }), {
      dependencies: MISSING_DEPS,
      smokeTest: smokeFails,
    });
    expect(missing.availability).toEqual(MISSING_DEPS);

    const optedOut = sessionConfig({
      sandboxPolicy: 'enforce',
      mcpServers: { fetch: { command: 'node', args: [], sandbox: false } },
    });
    const plan = await resolveSessionOsSandboxPlan(optedOut, { dependencies: AVAILABLE, smokeTest: smokeFails });
    expect(plan.availability).toEqual(AVAILABLE);
    expect(smokeFails).not.toHaveBeenCalled();
  });
});

// ── Audit stamps ───────────────────────────────────────────────────────

describe('audit sandboxed stamp', () => {
  it('treats a supported platform with missing dependencies as unavailable', () => {
    // The old parent check used platformSupported alone and stamped
    // git/google-workspace sandboxed=true while their relays ran unconfined.
    const availability = getOsSandboxAvailability(() => ({
      platformSupported: true,
      errors: ['ripgrep (rg) not found'],
      warnings: [],
    }));
    expect(availability.available).toBe(false);
  });

  it('maps dispositions to true / false / omitted', () => {
    const plan = planServerSandboxing(shippedServers(), '/tmp/sbx', AVAILABLE, 'warn');
    expect(auditSandboxStamp(plan.resolved.get('git'))).toBe(true);
    expect(auditSandboxStamp({ sandboxed: false, reason: 'platform-unavailable' })).toBe(false);
    expect(auditSandboxStamp({ sandboxed: false, reason: 'opt-out' })).toBeUndefined();
    expect(auditSandboxStamp(undefined)).toBeUndefined();
  });

  it('audit entries show sandboxed=false when deps are missing', () => {
    const plan = planServerSandboxing(shippedServers(), '/tmp/sbx', MISSING_DEPS, 'warn');
    const stamp = auditSandboxStamp(plan.resolved.get('git'));

    const entry = buildAuditEntry(
      {
        requestId: 'r1',
        serverName: 'git',
        toolName: 'git_status',
        arguments: {},
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {},
      { status: 'allow', rule: 'structural-sandbox-allow', reason: 'allowed' },
      { status: 'success' },
      1,
      { sandboxed: stamp },
    );

    expect(entry.sandboxed).toBe(false);
    expect(JSON.stringify(entry)).toContain('"sandboxed":false');
  });
});

// ── Offline pipeline relay ─────────────────────────────────────────────

describe('list-resolver relay (pipeline)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops servers that need an unavailable sandbox under enforce and says so', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const kept = applyOsSandboxPolicy(shippedServers(), 'enforce', MISSING_DEPS);

    expect(Object.keys(kept).sort()).toEqual(['fetch', 'github']);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('filesystem, git, google-workspace');
  });

  it('keeps every server under warn and warns about the unconfined ones', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const kept = applyOsSandboxPolicy(shippedServers(), 'warn', MISSING_DEPS);

    expect(Object.keys(kept)).toHaveLength(5);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('WITHOUT OS containment');
  });

  it('stays quiet when the sandbox is available', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(Object.keys(applyOsSandboxPolicy(shippedServers(), 'enforce', AVAILABLE))).toHaveLength(5);
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe('shipped server definitions', () => {
  it('declare an OS sandbox for filesystem, git and google-workspace', () => {
    expect(existsSync(SHIPPED_SERVERS_PATH)).toBe(true);
    const needing = Object.entries(shippedServers())
      .filter(([, c]) => c.sandbox !== false)
      .map(([n]) => n)
      .sort();
    expect(needing).toEqual(['filesystem', 'git', 'google-workspace']);
  });

  // WP-11: the filesystem server reopens validated paths by name, so it must
  // never run without OS confinement to its roots when srt is available.
  it('confine the filesystem server to its MCP roots, with no network', () => {
    const { filesystem } = shippedServers();
    expect(filesystem.sandbox).not.toBe(false);
    const sandbox = filesystem.sandbox === false ? undefined : filesystem.sandbox;
    expect(sandbox?.filesystem?.confineToRoots).toBe(true);
    expect(sandbox?.network ?? false).toBe(false);
  });
});
