import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildGitConfigEnv } from '@anthropic-ai/sandbox-runtime';
import { ROOTS_REFRESH_TIMEOUT_MS } from '../src/trusted-process/mcp-client-manager.js';
import {
  parseProxyEnvConfig,
  validateSandboxAvailability,
  resolveServerSandboxConfigs,
  selectTransportConfig,
  proxyCanServe,
  buildBackendEnv,
  backendCallRequestOptions,
  backendStderrRedactor,
  lineBufferedText,
} from '../src/trusted-process/mcp-proxy-server.js';
import { defaultSandboxPolicy } from '../src/config/sandbox-policy.js';
import {
  DEFAULT_BACKEND_CALL_TIMEOUT_MS,
  maxTotalBackendCallMs,
  relayCallTimeoutMs,
} from '../src/trusted-process/call-timeouts.js';
import type { MCPServerConfig } from '../src/config/types.js';
import {
  buildToolMap,
  buildAuditEntry,
  handleCallTool,
  validateToolArguments,
  isUserContextTrusted,
  type ProxiedTool,
  type CallToolDeps,
  type ClientState,
} from '../src/trusted-process/tool-call-pipeline.js';
import {
  getOsSandboxAvailability,
  writeServerSettings,
  type OsSandboxAvailability,
  type OsSandboxSmokeResult,
  type ResolvedSandboxConfig,
} from '../src/trusted-process/sandbox-integration.js';
import { createApprovalWhitelist } from '../src/trusted-process/approval-whitelist.js';
import type { ToolAnnotation } from '../src/pipeline/types.js';
import { addRootsToClient } from '../src/trusted-process/roots-expansion.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ── Mock modules ───────────────────────────────────────────────────────

// Pure planning helpers stay real (planServerSandboxing, formatSandboxRefusal,
// ...); anything that probes the host or touches srt is stubbed.
vi.mock('../src/trusted-process/sandbox-integration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/trusted-process/sandbox-integration.js')>();
  return {
    ...actual,
    checkSandboxAvailability: vi.fn(() => ({
      platformSupported: true,
      errors: [],
      warnings: [],
    })),
    getOsSandboxAvailability: vi.fn((): OsSandboxAvailability => ({
      available: true,
      platformSupported: true,
      problems: [],
      warnings: [],
    })),
    resolveSandboxConfig: vi.fn(),
    writeServerSettings: vi.fn((serverName: string) => ({
      settingsPath: `/settings/${serverName}.srt-settings.json`,
      cwdPath: `/settings/${serverName}.cwd`,
    })),
    wrapServerCommand: vi.fn(),
    cleanupSettingsFiles: vi.fn(),
    annotateSandboxViolation: vi.fn((text: string) => text),
  };
});

vi.mock('../src/trusted-process/auto-approver.js', () => ({
  autoApprove: vi.fn(),
  extractArgsForAutoApprove: vi.fn(() => ({})),
  readUserContext: vi.fn(),
}));

vi.mock('../src/trusted-process/path-utils.js', () => ({
  prepareToolArgs: vi.fn((args: Record<string, unknown>) => ({
    argsForTransport: { ...args },
    argsForPolicy: { ...args },
  })),
  rewriteResultContent: vi.fn((content: unknown) => content),
}));

vi.mock('../src/trusted-process/policy-engine.js', () => ({
  PolicyEngine: vi.fn(),
  // The pipeline hands the whitelist the arguments the engine evaluated;
  // nothing in these tests omits a git remote, so they are the call's own.
  evaluatedArguments: vi.fn((_serverName: string, _toolName: string, args: Record<string, unknown>) => args),
  extractAnnotatedPaths: vi.fn(() => []),
  // The approver sees a compiled reason unchanged; the auto-approver itself
  // is mocked below, so the exact text never matters here.
  reasonForAutoApprover: vi.fn((result: { reason: string }) => result.reason),
  // Whether a named remote may anchor the approver's check; the escalations
  // here are compiled path escalations, and the auto-approver is mocked.
  destinationGateMayHaveEscalated: vi.fn(() => false),
  // Reached via the escalation whitelist-candidate path
  // (tool-call-pipeline -> extractWhitelistCandidates -> collectDistinctRoles)
  // after the Phase 0 mutex/escalation refactor; the roots-race tests don't
  // exercise whitelist extraction, so an empty-roles stub is sufficient.
  collectDistinctRoles: vi.fn(() => []),
}));

// ── addRootsToClient tests ─────────────────────────────────────────────

/**
 * Tests for the roots-refresh acknowledgment and timeout safety net in
 * `addRootsToClient` (src/trusted-process/roots-expansion.ts), used by
 * the pipeline after an approved escalation.
 */

interface RootsTestState extends ClientState {
  sendRootsListChanged: ReturnType<typeof vi.fn>;
}

function makeRootsState(roots: { uri: string; name: string }[] = []): RootsTestState {
  const sendRootsListChanged = vi.fn().mockResolvedValue(undefined);
  return {
    client: { sendRootsListChanged } as unknown as ClientState['client'],
    roots,
    sendRootsListChanged,
  };
}

describe('addRootsToClient timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves as added when the server acknowledges roots/list', async () => {
    const state = makeRootsState();
    const promise = addRootsToClient(state, ['/tmp/test']);

    // Simulate the server fetching the updated list
    await vi.advanceTimersByTimeAsync(0);
    state.rootsRefreshed?.();

    await expect(promise).resolves.toBe('added');
    expect(state.roots).toContainEqual({ uri: 'file:///tmp/test', name: 'escalation-approved' });
    expect(state.sendRootsListChanged).toHaveBeenCalledTimes(1);
  });

  it('resolves as timeout when the server never acknowledges roots/list', async () => {
    const state = makeRootsState();
    const promise = addRootsToClient(state, ['/tmp/test']);

    // Server never calls back — advance past the timeout
    await vi.advanceTimersByTimeAsync(ROOTS_REFRESH_TIMEOUT_MS);

    await expect(promise).resolves.toBe('timeout');
    expect(state.roots).toContainEqual({ uri: 'file:///tmp/test', name: 'escalation-approved' });
    // Stale callback is cleared on timeout
    expect(state.rootsRefreshed).toBeUndefined();
  });

  it('clears the timeout timer when the server responds quickly', async () => {
    const state = makeRootsState();
    const promise = addRootsToClient(state, ['/tmp/test']);
    await vi.advanceTimersByTimeAsync(0);
    state.rootsRefreshed?.();
    await promise;

    // No pending timers should remain
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays pending until exactly the timeout elapses', async () => {
    const state = makeRootsState();
    let resolved = false;
    const promise = addRootsToClient(state, ['/tmp/test']).then(() => {
      resolved = true;
    });

    // Before timeout: still pending
    await vi.advanceTimersByTimeAsync(ROOTS_REFRESH_TIMEOUT_MS - 1);
    expect(resolved).toBe(false);

    // At timeout: resolves
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(resolved).toBe(true);
  });

  it('is a no-op when the root URI already exists', async () => {
    const state = makeRootsState([{ uri: 'file:///tmp/test', name: 'existing' }]);

    await expect(addRootsToClient(state, ['/tmp/test'])).resolves.toBe('unchanged');

    // Should not have sent notification or added duplicate
    expect(state.roots).toHaveLength(1);
    expect(state.sendRootsListChanged).not.toHaveBeenCalled();
  });

  it('adds several roots with a single notification', async () => {
    const state = makeRootsState();
    const promise = addRootsToClient(state, ['/tmp/a', '/tmp/b', '/tmp/a']);
    await vi.advanceTimersByTimeAsync(0);
    state.rootsRefreshed?.();

    await expect(promise).resolves.toBe('added');
    expect(state.roots.map((r) => r.uri)).toEqual(['file:///tmp/a', 'file:///tmp/b']);
    expect(state.sendRootsListChanged).toHaveBeenCalledTimes(1);
  });

  it('reports failed when the notification cannot be sent', async () => {
    const state = makeRootsState();
    state.sendRootsListChanged.mockRejectedValueOnce(new Error('Not connected'));

    await expect(addRootsToClient(state, ['/tmp/test'])).resolves.toBe('failed');
    expect(state.rootsRefreshed).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── parseProxyEnvConfig tests ──────────────────────────────────────────

describe('backendCallRequestOptions', () => {
  it('bounds the backend call explicitly instead of inheriting the SDK 60 s default', () => {
    const options = backendCallRequestOptions(120_000, undefined);
    expect(options.timeout).toBe(120_000);
    expect(options.resetTimeoutOnProgress).toBe(true);
    expect(options.maxTotalTimeout).toBe(maxTotalBackendCallMs(120_000));
    expect(options.signal).toBeUndefined();
  });

  it('always asks the backend for progress, forwarding it only when the caller asked too', () => {
    // Without `onprogress` the SDK sends no progress token, so the backend
    // could never reset the timer: it must be set even with nothing to forward.
    const silent = backendCallRequestOptions(DEFAULT_BACKEND_CALL_TIMEOUT_MS, undefined);
    expect(typeof silent.onprogress).toBe('function');
    expect(() => silent.onprogress?.({ progress: 1 })).not.toThrow();

    const forwarded: unknown[] = [];
    const forwarding = backendCallRequestOptions(DEFAULT_BACKEND_CALL_TIMEOUT_MS, (p) => forwarded.push(p));
    forwarding.onprogress?.({ progress: 2, total: 10 });
    expect(forwarded).toEqual([{ progress: 2, total: 10 }]);
  });

  it("cancels the backend call with the caller's request", () => {
    const controller = new AbortController();
    expect(backendCallRequestOptions(1_000, undefined, controller.signal).signal).toBe(controller.signal);
  });
});

describe('parseProxyEnvConfig', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Reset env to a clean state before each test
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith('MCP_') ||
        key.startsWith('GENERATED_') ||
        key.startsWith('AUDIT_') ||
        key.startsWith('PROTECTED_') ||
        key.startsWith('SESSION_LOG') ||
        key.startsWith('ALLOWED_') ||
        key.startsWith('CONTAINER_') ||
        key.startsWith('ESCALATION_') ||
        key.startsWith('SERVER_') ||
        key.startsWith('SANDBOX_') ||
        key === 'IRONCURTAIN_SANDBOX_POLICY'
      ) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it('accepts path-only sandbox metadata and refuses malformed values before starting a backend', () => {
    process.env.MCP_SERVERS_CONFIG = '{}';
    process.env.GENERATED_DIR = '/tmp/generated';
    process.env.SANDBOX_CREDENTIAL_PATHS = '["/configured/store"]';
    expect(parseProxyEnvConfig().credentialPaths).toEqual(['/configured/store']);
    process.env.SANDBOX_CREDENTIAL_PATHS = '["relative"]';
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => parseProxyEnvConfig()).toThrow('process.exit');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });

  it('parses all environment variables into a typed config object', () => {
    const servers = { filesystem: { command: 'node', args: ['server.js'] } };
    process.env.MCP_SERVERS_CONFIG = JSON.stringify(servers);
    process.env.GENERATED_DIR = '/tmp/generated';
    process.env.PROTECTED_PATHS = JSON.stringify(['/etc/passwd']);
    process.env.SESSION_LOG_PATH = '/tmp/session.log';
    process.env.ALLOWED_DIRECTORY = '/tmp/sandbox';
    process.env.SANDBOX_POLICY = 'enforce';

    const config = parseProxyEnvConfig();

    expect(config.generatedDir).toBe('/tmp/generated');
    expect(config.protectedPaths).toEqual(['/etc/passwd']);
    expect(config.sessionLogPath).toBe('/tmp/session.log');
    expect(config.allowedDirectory).toBe('/tmp/sandbox');
    expect(config.sandboxPolicy).toBe('enforce');
    expect(config.serversConfig).toEqual(servers);
  });

  it('uses default values when optional env vars are not set', () => {
    const servers = { fs: { command: 'node', args: [] } };
    process.env.MCP_SERVERS_CONFIG = JSON.stringify(servers);
    process.env.GENERATED_DIR = '/tmp/gen';

    const config = parseProxyEnvConfig();

    expect(config.protectedPaths).toEqual([]);
    expect(config.sessionLogPath).toBeUndefined();
    expect(config.allowedDirectory).toBeUndefined();
    // Fail-closed platform default ("enforce" on Linux/macOS), no longer "warn".
    expect(config.sandboxPolicy).toBe(defaultSandboxPolicy());
    expect(config.serverCredentials).toEqual({});
    expect(config.serverFilter).toBeUndefined();
  });

  it('gives IRONCURTAIN_SANDBOX_POLICY precedence over SANDBOX_POLICY', () => {
    process.env.MCP_SERVERS_CONFIG = JSON.stringify({ fs: { command: 'node', args: [] } });
    process.env.GENERATED_DIR = '/tmp/gen';
    process.env.SANDBOX_POLICY = 'enforce';
    process.env.IRONCURTAIN_SANDBOX_POLICY = 'warn';

    expect(parseProxyEnvConfig().sandboxPolicy).toBe('warn');
  });

  it('reads the backend call bound from BACKEND_CALL_TIMEOUT_MS, defaulting to 300 s', () => {
    process.env.MCP_SERVERS_CONFIG = JSON.stringify({ fs: { command: 'node', args: [] } });
    process.env.GENERATED_DIR = '/tmp/gen';
    delete process.env.BACKEND_CALL_TIMEOUT_MS;
    expect(parseProxyEnvConfig().backendCallTimeoutMs).toBe(DEFAULT_BACKEND_CALL_TIMEOUT_MS);

    process.env.BACKEND_CALL_TIMEOUT_MS = '120000';
    expect(parseProxyEnvConfig().backendCallTimeoutMs).toBe(120_000);
  });

  it('exits on a malformed BACKEND_CALL_TIMEOUT_MS instead of running with a different deadline', () => {
    process.env.MCP_SERVERS_CONFIG = JSON.stringify({ fs: { command: 'node', args: [] } });
    process.env.GENERATED_DIR = '/tmp/gen';
    process.env.BACKEND_CALL_TIMEOUT_MS = '60s';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => parseProxyEnvConfig()).toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('BACKEND_CALL_TIMEOUT_MS');
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("reads the parent's OS-sandbox availability from OS_SANDBOX_AVAILABILITY", () => {
    process.env.MCP_SERVERS_CONFIG = JSON.stringify({ fs: { command: 'node', args: [] } });
    process.env.GENERATED_DIR = '/tmp/gen';
    delete process.env.OS_SANDBOX_AVAILABILITY;
    expect(parseProxyEnvConfig().osSandboxAvailability).toBeUndefined();

    const verdict: OsSandboxAvailability = {
      available: false,
      platformSupported: true,
      problems: ['srt cannot start a sandbox on this host: apply-seccomp: Permission denied'],
      warnings: [],
    };
    process.env.OS_SANDBOX_AVAILABILITY = JSON.stringify(verdict);
    try {
      expect(parseProxyEnvConfig().osSandboxAvailability).toEqual(verdict);
    } finally {
      delete process.env.OS_SANDBOX_AVAILABILITY;
    }
  });

  it.each([
    'not json',
    '{"available":"yes","platformSupported":true,"problems":[],"warnings":[]}',
    '{"available":true,"platformSupported":true,"problems":["socat not installed"],"warnings":[]}',
  ])('exits on a malformed OS_SANDBOX_AVAILABILITY (%s) instead of guessing', (value) => {
    process.env.MCP_SERVERS_CONFIG = JSON.stringify({ fs: { command: 'node', args: [] } });
    process.env.GENERATED_DIR = '/tmp/gen';
    process.env.OS_SANDBOX_AVAILABILITY = value;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => parseProxyEnvConfig()).toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('OS_SANDBOX_AVAILABILITY');
    } finally {
      delete process.env.OS_SANDBOX_AVAILABILITY;
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('accepts SANDBOX_POLICY regardless of case and surrounding whitespace', () => {
    process.env.MCP_SERVERS_CONFIG = JSON.stringify({ fs: { command: 'node', args: [] } });
    process.env.GENERATED_DIR = '/tmp/gen';
    process.env.SANDBOX_POLICY = ' ENFORCE ';

    expect(parseProxyEnvConfig().sandboxPolicy).toBe('enforce');
  });

  it('exits non-zero on an invalid SANDBOX_POLICY instead of weakening to "warn"', () => {
    process.env.MCP_SERVERS_CONFIG = JSON.stringify({ fs: { command: 'node', args: [] } });
    process.env.GENERATED_DIR = '/tmp/gen';
    process.env.SANDBOX_POLICY = 'enfroce';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(() => parseProxyEnvConfig()).toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid SANDBOX_POLICY'));
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('parses SERVER_CREDENTIALS and scrubs from process.env', () => {
    const servers = { fs: { command: 'node', args: [] } };
    process.env.MCP_SERVERS_CONFIG = JSON.stringify(servers);
    process.env.GENERATED_DIR = '/tmp/gen';
    process.env.SERVER_CREDENTIALS = JSON.stringify({ GITHUB_TOKEN: 'secret123' });

    const config = parseProxyEnvConfig();

    expect(config.serverCredentials).toEqual({ GITHUB_TOKEN: 'secret123' });
    expect(process.env.SERVER_CREDENTIALS).toBeUndefined();
  });

  it('filters servers when SERVER_FILTER is set', () => {
    const servers = {
      fs: { command: 'node', args: ['fs.js'] },
      git: { command: 'node', args: ['git.js'] },
    };
    process.env.MCP_SERVERS_CONFIG = JSON.stringify(servers);
    process.env.GENERATED_DIR = '/tmp/gen';
    process.env.SERVER_FILTER = 'git';

    const config = parseProxyEnvConfig();

    expect(Object.keys(config.serversConfig)).toEqual(['git']);
    expect(config.serversConfig.git).toEqual(servers.git);
    expect(config.serverFilter).toBe('git');
  });

  it('calls process.exit(1) when MCP_SERVERS_CONFIG is missing', () => {
    process.env.GENERATED_DIR = '/tmp/gen';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(() => parseProxyEnvConfig()).toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith('MCP_SERVERS_CONFIG environment variable is required\n');

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('calls process.exit(1) when GENERATED_DIR is missing', () => {
    process.env.MCP_SERVERS_CONFIG = JSON.stringify({ fs: { command: 'node', args: [] } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(() => parseProxyEnvConfig()).toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith('GENERATED_DIR environment variable is required\n');

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it.each(['relative/sandbox', '.', ''])(
    'calls process.exit(1) when ALLOWED_DIRECTORY is not absolute (%j)',
    (allowedDirectory) => {
      // The relay runs from the package root, so a relative path would name a
      // different directory than the parent's policy engine checks.
      process.env.MCP_SERVERS_CONFIG = JSON.stringify({ fs: { command: 'node', args: [] } });
      process.env.GENERATED_DIR = '/tmp/gen';
      process.env.ALLOWED_DIRECTORY = allowedDirectory;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      expect(() => parseProxyEnvConfig()).toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith('ALLOWED_DIRECTORY must be an absolute path\n');

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  );

  it.each(['relative-home', '.', ''])(
    'calls process.exit(1) when IRONCURTAIN_HOME is not absolute (%j)',
    (ironCurtainHome) => {
      // OAuth tokens are read from the home and the backends' private
      // working directories are created under it; resolving a relative
      // value against the relay's cwd (the package root) would write there.
      process.env.MCP_SERVERS_CONFIG = JSON.stringify({ fs: { command: 'node', args: [] } });
      process.env.GENERATED_DIR = '/tmp/gen';
      process.env.ALLOWED_DIRECTORY = '/tmp/sandbox';
      process.env.IRONCURTAIN_HOME = ironCurtainHome;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      expect(() => parseProxyEnvConfig()).toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith('IRONCURTAIN_HOME must be an absolute path\n');

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  );

  it('calls process.exit(1) when SERVER_FILTER references unknown server', () => {
    process.env.MCP_SERVERS_CONFIG = JSON.stringify({ fs: { command: 'node', args: [] } });
    process.env.GENERATED_DIR = '/tmp/gen';
    process.env.SERVER_FILTER = 'nonexistent';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(() => parseProxyEnvConfig()).toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith('SERVER_FILTER: unknown server "nonexistent"\n');

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

// ── proxyCanServe tests ────────────────────────────────────────────────

describe('proxyCanServe', () => {
  const stubConfig: MCPServerConfig = { command: 'node', args: [] };

  it('returns true when no backends are configured (virtual-only proxy mode)', () => {
    expect(proxyCanServe({}, 0)).toBe(true);
  });

  it('returns true when at least one configured backend connected', () => {
    expect(proxyCanServe({ github: stubConfig, git: stubConfig }, 1)).toBe(true);
  });

  it('returns false when backends were configured but none connected', () => {
    expect(proxyCanServe({ github: stubConfig }, 0)).toBe(false);
  });
});

// ── validateSandboxAvailability tests ──────────────────────────────────

describe('validateSandboxAvailability', () => {
  const unavailable = (problems: string[], platformSupported = true): OsSandboxAvailability => ({
    available: false,
    platformSupported,
    problems,
    warnings: [],
  });

  const availableDeps: OsSandboxAvailability = { available: true, platformSupported: true, problems: [], warnings: [] };
  const sandboxed: Record<string, MCPServerConfig> = {
    git: { command: 'node', args: [], sandbox: { network: false } },
  };
  const optedOut: Record<string, MCPServerConfig> = { fetch: { command: 'node', args: [], sandbox: false } };
  const smokeFailed = async (): Promise<OsSandboxSmokeResult> => ({
    ok: false,
    elapsedMs: 5,
    detail: 'bwrap: setting up uid map: Permission denied',
  });
  const smokeOk = async (): Promise<OsSandboxSmokeResult> => ({ ok: true, elapsedMs: 5, detail: 'ok' });

  it('returns sandboxAvailable=true when platform is supported and no errors', async () => {
    vi.mocked(getOsSandboxAvailability).mockReturnValue(availableDeps);

    const result = await validateSandboxAvailability('warn', undefined, 'linux');
    expect(result.sandboxAvailable).toBe(true);
  });

  it('returns sandboxAvailable=false when platform is not supported in warn mode', async () => {
    vi.mocked(getOsSandboxAvailability).mockReturnValue(unavailable(['platform "win32" is not supported'], false));

    const result = await validateSandboxAvailability('warn', undefined, 'win32');
    expect(result.sandboxAvailable).toBe(false);
  });

  it('returns sandboxAvailable=false when dependency errors exist in warn mode', async () => {
    vi.mocked(getOsSandboxAvailability).mockReturnValue(unavailable(['bubblewrap (bwrap) not installed']));

    const result = await validateSandboxAvailability('warn', undefined, 'linux');
    expect(result.sandboxAvailable).toBe(false);
    expect(result.availability.problems).toEqual(['bubblewrap (bwrap) not installed']);
  });

  // Previously "enforce" threw here and killed the whole relay, including
  // relays for servers that never asked for a sandbox. Enforcement is now
  // per server (resolveServerSandboxConfigs).
  it('does not throw in enforce mode when the platform is not supported', async () => {
    vi.mocked(getOsSandboxAvailability).mockReturnValue(unavailable(['platform "darwin" is not supported'], false));

    expect((await validateSandboxAvailability('enforce', undefined, 'darwin')).sandboxAvailable).toBe(false);
  });

  it('does not throw in enforce mode when dependency errors exist', async () => {
    vi.mocked(getOsSandboxAvailability).mockReturnValue(unavailable(['socat not installed']));

    expect((await validateSandboxAvailability('enforce', undefined, 'linux')).sandboxAvailable).toBe(false);
  });

  // 01-08: the dependency check alone said "available" on hosts where srt
  // cannot start a sandbox, so the relay wrapped the server in an srt that
  // failed instead of refusing it ("enforce") or running it unconfined ("warn").
  it("plans with the parent's verdict: unavailable when the parent's srt smoke run failed", async () => {
    vi.mocked(getOsSandboxAvailability).mockReturnValue(availableDeps);
    const fromParent = unavailable(['srt cannot start a sandbox on this host: apply-seccomp: Permission denied']);
    const smokeTest = vi.fn(smokeOk);

    const result = await validateSandboxAvailability('warn', undefined, 'linux', {
      fromParent,
      servers: sandboxed,
      smokeTest,
    });
    expect(result.sandboxAvailable).toBe(false);
    expect(result.availability).toEqual(fromParent);
    // The parent already ran srt; the relay does not run it again.
    expect(smokeTest).not.toHaveBeenCalled();

    // The relay's per-server plan follows: refused under enforce (naming the
    // srt failure), unconfined under warn.
    const home = mkdtempSync(join(tmpdir(), 'ironcurtain-relay-home-'));
    try {
      const enforce = resolveServerSandboxConfigs(sandboxed, '/tmp/sandbox', result.availability, 'enforce', home);
      expect(enforce.refusedServers.get('git')).toContain('srt cannot start a sandbox on this host');
      for (const dir of enforce.scratchDirs) rmSync(dir, { recursive: true, force: true });
      const warn = resolveServerSandboxConfigs(sandboxed, '/tmp/sandbox', result.availability, 'warn', home);
      expect(warn.resolvedSandboxConfigs.get('git')).toEqual({ sandboxed: false, reason: 'platform-unavailable' });
      for (const dir of warn.scratchDirs) rmSync(dir, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("narrows an available parent verdict with the relay's own dependency check", async () => {
    vi.mocked(getOsSandboxAvailability).mockReturnValue(unavailable(['socat not installed']));

    const result = await validateSandboxAvailability('enforce', undefined, 'linux', {
      fromParent: availableDeps,
      servers: sandboxed,
    });
    expect(result.sandboxAvailable).toBe(false);
    expect(result.availability.problems).toEqual(['socat not installed']);
  });

  it('runs the srt smoke test itself without a parent verdict, only when a server needs the sandbox', async () => {
    vi.mocked(getOsSandboxAvailability).mockReturnValue(availableDeps);

    const failing = vi.fn(smokeFailed);
    const result = await validateSandboxAvailability('enforce', undefined, 'linux', {
      servers: sandboxed,
      smokeTest: failing,
    });
    expect(failing).toHaveBeenCalledOnce();
    expect(result.sandboxAvailable).toBe(false);
    expect(result.availability.problems).toEqual([
      'srt cannot start a sandbox on this host: bwrap: setting up uid map: Permission denied',
    ]);

    const unused = vi.fn(smokeFailed);
    const optOut = await validateSandboxAvailability('enforce', undefined, 'linux', {
      servers: optedOut,
      smokeTest: unused,
    });
    expect(unused).not.toHaveBeenCalled();
    expect(optOut.sandboxAvailable).toBe(true);
  });
});

// ── resolveServerSandboxConfigs tests (per-server enforcement) ─────────

describe('resolveServerSandboxConfigs', () => {
  const missingDeps: OsSandboxAvailability = {
    available: false,
    platformSupported: true,
    problems: ['ripgrep (rg) not found', 'bubblewrap (bwrap) not installed', 'socat not installed'],
    warnings: [],
  };
  const servers: Record<string, MCPServerConfig> = {
    filesystem: { command: 'npx', args: [], sandbox: false },
    git: { command: 'node', args: [], sandbox: { network: { allowedDomains: ['github.com'] } } },
    fetch: { command: 'tsx', args: [], sandbox: false },
    'google-workspace': { command: 'npx', args: [] },
  };
  const settingsDirs: string[] = [];

  afterEach(() => {
    for (const dir of settingsDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function resolveConfigs(availability: OsSandboxAvailability, policy: 'enforce' | 'warn') {
    // Unsandboxed servers get their private cwd under the IronCurtain home
    // (spawn-cwd.ts); give them a throwaway one.
    const home = mkdtempSync(join(tmpdir(), 'ironcurtain-relay-home-'));
    settingsDirs.push(home);
    const result = resolveServerSandboxConfigs(servers, '/tmp/sandbox', availability, policy, home);
    settingsDirs.push(...result.scratchDirs);
    return result;
  }

  it('refuses only servers that need an OS sandbox under enforce, without throwing', () => {
    const result = resolveConfigs(missingDeps, 'enforce');

    expect([...result.refusedServers.keys()].sort()).toEqual(['git', 'google-workspace']);
    expect(result.refusedServers.get('git')).toMatch(/ripgrep \(rg\) not found/);
    expect(result.refusedServers.get('git')).toMatch(/sandboxPolicy is "enforce"/);
    expect(result.refusedServers.get('git')).toMatch(/IRONCURTAIN_SANDBOX_POLICY=warn/);
    expect([...result.resolvedSandboxConfigs.keys()].sort()).toEqual(['fetch', 'filesystem']);
  });

  it('starts every server under warn, marking sandbox-requesting ones platform-unavailable', () => {
    const result = resolveConfigs(missingDeps, 'warn');

    expect(result.refusedServers.size).toBe(0);
    expect(result.resolvedSandboxConfigs.get('git')).toEqual({ sandboxed: false, reason: 'platform-unavailable' });
    expect(result.resolvedSandboxConfigs.get('filesystem')).toEqual({ sandboxed: false, reason: 'opt-out' });
  });

  it('sandboxes sandbox-requesting servers when the OS sandbox is available', () => {
    const available: OsSandboxAvailability = { available: true, platformSupported: true, problems: [], warnings: [] };
    const result = resolveConfigs(available, 'enforce');

    expect(result.refusedServers.size).toBe(0);
    expect(result.resolvedSandboxConfigs.get('git')?.sandboxed).toBe(true);
    expect(result.serverCwdPaths.get('git')).toBe('/settings/git.cwd');
  });

  it('grants the ssh-agent socket in the srt settings of the git backend only', () => {
    const available: OsSandboxAvailability = { available: true, platformSupported: true, problems: [], warnings: [] };
    const writeSettings = vi.mocked(writeServerSettings);
    writeSettings.mockClear();
    resolveConfigs(available, 'enforce');

    // Both are sandboxed and networked-capable; only git authenticates with ssh.
    const optionsFor = new Map(writeSettings.mock.calls.map((call) => [call[0], call[3]]));
    expect([...optionsFor.keys()].sort()).toEqual(['git', 'google-workspace']);
    expect(optionsFor.get('git')).toEqual({ sshAgent: true });
    expect(optionsFor.get('google-workspace')).toEqual({ sshAgent: false });
  });

  // Read containment: per-server availability refusals must not turn a
  // config that would re-expose the IronCurtain home into a skipped server;
  // the relay still refuses to start at all and names the server.
  it('throws, naming the server, when a sandboxed server would re-expose the IronCurtain home', () => {
    const icHome = mkdtempSync(join(tmpdir(), 'ironcurtain-relay-home-'));
    const savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = icHome;
    try {
      const available: OsSandboxAvailability = { available: true, platformSupported: true, problems: [], warnings: [] };
      const withBadServer: Record<string, MCPServerConfig> = {
        ...servers,
        custom: { command: 'node', args: [], sandbox: { filesystem: { allowRead: [join(icHome, 'oauth')] } } },
      };

      let caught: unknown;
      try {
        resolveServerSandboxConfigs(withBadServer, '/tmp/sandbox', available, 'enforce');
      } catch (err) {
        caught = err;
      }
      expect((caught as { code?: unknown } | undefined)?.code).toBe('SANDBOX_CONFIG_INVALID');
      expect((caught as Error).message).toContain('Server "custom"');
    } finally {
      if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = savedHome;
      rmSync(icHome, { recursive: true, force: true });
    }
  });
});

// ── buildBackendEnv tests ──────────────────────────────────────────────

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

type EnvLookup = Readonly<Record<string, string | undefined>>;

/** The command-scope git config entries an environment carries, in order. */
function gitConfigEntries(env: EnvLookup): Array<[string, string]> {
  const count = Number(env.GIT_CONFIG_COUNT ?? '0');
  return Array.from({ length: count }, (_, index) => [
    env[`GIT_CONFIG_KEY_${index}`] ?? '<missing>',
    env[`GIT_CONFIG_VALUE_${index}`] ?? '<missing>',
  ]);
}

/** The value git uses for a single-valued key: the last command-scope entry. */
function effectiveGitConfig(env: EnvLookup, key: string): string | undefined {
  return gitConfigEntries(env)
    .filter(([entryKey]) => entryKey.toLowerCase() === key.toLowerCase())
    .at(-1)?.[1];
}

describe('buildBackendEnv', () => {
  const shippedServers = JSON.parse(
    readFileSync(fileURLToPath(new URL('../src/config/mcp-servers.json', import.meta.url)), 'utf-8'),
  ) as Record<string, MCPServerConfig>;
  // Of the host's GIT_* variables only git's config-file selection reaches a
  // backend (child-env.ts); the tests below keep the system gitconfig out of
  // the way through the server's own env block, which works either way.
  const gitServer: MCPServerConfig = {
    ...shippedServers.git,
    env: { ...shippedServers.git.env, GIT_CONFIG_NOSYSTEM: '1' },
  };

  it('gives other backends only the allowlisted relay environment, plus the private-cwd git ceiling', () => {
    const env = buildBackendEnv(
      'filesystem',
      { command: 'node', args: [], env: { SHARED: 'config' } },
      {
        baseEnv: {
          PATH: `/usr/bin${delimiter}.`,
          HOME: '/home/relay',
          LANG: 'C.UTF-8',
          SHARED: 'relay',
          // None of these may reach a backend: the relay's own configuration,
          // the host's secrets, code-injection variables, git state, the
          // ssh-agent socket (git backend only).
          ONLY_RELAY: 'relay',
          GIT_DIR: '/elsewhere',
          GIT_CEILING_DIRECTORIES: '/inherited',
          NODE_OPTIONS: '--require /tmp/evil.js',
          ANTHROPIC_API_KEY: 'sk-ant-host',
          MCP_SERVERS_CONFIG: '{"other":{"env":{"SECRET":"x"}}}',
          SESSION_LOG_PATH: '/session.log',
          SSH_AUTH_SOCK: '/run/agent.sock',
        },
        sandboxed: true,
        serverCredentials: { API_TOKEN: 'token' },
        oauthEnv: { CLIENT_ID: 'client' },
        allowedDirectory: '/sandbox',
        serverCwd: '/relay-run/filesystem.cwd',
      },
    );
    expect(env).toEqual({
      PATH: `/usr/bin${delimiter}.`,
      HOME: '/home/relay',
      LANG: 'C.UTF-8',
      SHARED: 'config',
      // Every backend: git never climbs out of the private cwd (spawn-cwd.ts).
      GIT_CEILING_DIRECTORIES: '/relay-run',
      API_TOKEN: 'token',
      CLIENT_ID: 'client',
    });
  });

  it("forwards a backend's `-e NAME` host variables, and the ssh-agent socket to the git backend only", () => {
    const baseEnv = {
      PATH: '/usr/bin',
      SSH_AUTH_SOCK: '/run/agent.sock',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_host',
      OTHER_TOKEN: 'other',
    };
    const inputs = {
      baseEnv,
      sandboxed: false,
      serverCredentials: {},
      oauthEnv: {},
      allowedDirectory: '/sandbox',
      serverCwd: '/relay-run/x.cwd',
    };
    const github = buildBackendEnv(
      'github',
      { command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'img'] },
      inputs,
    );
    expect(github.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_host');
    expect(github).not.toHaveProperty('OTHER_TOKEN');
    expect(github).not.toHaveProperty('SSH_AUTH_SOCK');

    const fetch = buildBackendEnv('fetch', { command: 'tsx', args: ['./src/servers/fetch-server.ts'] }, inputs);
    expect(fetch).not.toHaveProperty('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(fetch).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  it('redacts a host token the server forwards with -e from its stderr, as well as stored and OAuth credentials', () => {
    const hostToken = 'ghp_hostTokenExportedInTheShell0123456789';
    const github = shippedServers.github;
    expect(github.args).toEqual(expect.arrayContaining(['-e', 'GITHUB_PERSONAL_ACCESS_TOKEN']));
    const env = buildBackendEnv('github', github, {
      baseEnv: { PATH: '/usr/bin', HOME: '/home/relay', GITHUB_PERSONAL_ACCESS_TOKEN: hostToken },
      sandboxed: false,
      serverCredentials: { STORED_TOKEN: 'stored-credential-value' },
      oauthEnv: { CLIENT_SECRET: 'oauth-client-secret' },
      allowedDirectory: '/sandbox',
      serverCwd: '/relay-run/github.cwd',
    });
    // The backend gets the host token, so its stderr can carry it.
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(hostToken);

    const redact = backendStderrRedactor(
      github,
      env,
      { STORED_TOKEN: 'stored-credential-value' },
      { CLIENT_SECRET: 'oauth-client-secret' },
    );
    expect(redact(`401 Bad credentials for token ${hostToken}`)).toBe('401 Bad credentials for token ***REDACTED***');
    expect(redact('stored-credential-value / oauth-client-secret')).toBe('***REDACTED*** / ***REDACTED***');
    // A value that merely shares a prefix with a secret is left alone.
    expect(redact('ghp_hostToken')).toBe('ghp_hostToken');
  });

  it('leaves forwarded values shorter than a credential, and variables the server does not forward, unmasked', () => {
    const config: MCPServerConfig = { command: 'docker', args: ['run', '-i', '-e', 'REGION', '-e', 'TOKEN', 'img'] };
    const env = {
      PATH: '/usr/bin',
      // Too short to be a credential: masking "eu" would mangle every log line.
      REGION: 'eu',
      TOKEN: 'abcdefgh',
      // In the environment, but not forwarded by this server's arguments.
      UNRELATED: 'unrelated-long-value',
    };
    const redact = backendStderrRedactor(config, env, {}, {});
    expect(redact('region=eu token=abcdefgh unrelated-long-value')).toBe(
      'region=eu token=***REDACTED*** unrelated-long-value',
    );
  });

  it('masks a secret that contains another one whole', () => {
    const config: MCPServerConfig = { command: 'docker', args: ['run', '-e', 'LONG_TOKEN', 'img'] };
    const redact = backendStderrRedactor(
      config,
      { LONG_TOKEN: 'prefix-secret-1234-suffix' },
      { SHORT: 'secret-1234' },
      {},
    );
    expect(redact('token=prefix-secret-1234-suffix')).toBe('token=***REDACTED***');
  });

  // A pipe can deliver one stderr write in several chunks; redacting each
  // chunk alone would log both halves of a token split between two of them.
  it('hands stderr on in whole lines, so a token split across chunks is redacted whole', () => {
    const config: MCPServerConfig = { command: 'docker', args: ['run', '-e', 'TOKEN', 'img'] };
    const token = 'ghp_splitAcrossTwoChunks0123456789';
    const redact = backendStderrRedactor(config, { TOKEN: token }, {}, {});
    const logged: string[] = [];
    const lines = lineBufferedText((text) => logged.push(redact(text)));

    lines.push('first line\nauth failed for ');
    lines.push(token.slice(0, 10));
    expect(logged).toEqual(['first line\n']);
    lines.push(`${token.slice(10)} (401)\nnext`);
    expect(logged).toEqual(['first line\n', 'auth failed for ***REDACTED*** (401)\n']);
    // What is left when the stream ends is handed on too.
    lines.flush();
    expect(logged).toEqual(['first line\n', 'auth failed for ***REDACTED*** (401)\n', 'next']);
    lines.flush();
    expect(logged).toHaveLength(3);
    expect(logged.join('')).not.toContain(token.slice(0, 10));
  });

  it('hands on a line that outgrows the pending limit without waiting for its newline', () => {
    const logged: string[] = [];
    const lines = lineBufferedText((text) => logged.push(text), 8);
    lines.push('12345678');
    expect(logged).toEqual([]);
    lines.push('9');
    expect(logged).toEqual(['123456789']);
    lines.push('a\nb');
    expect(logged).toEqual(['123456789', 'a\n']);
  });

  it('sets the private-cwd ceiling alone (host git settings never reach a backend) and refuses a cwd git cannot bound', () => {
    const inputs = (serverCwd: string) => ({
      baseEnv: { PATH: '/usr/bin', GIT_CEILING_DIRECTORIES: `/net${delimiter}/mnt` },
      sandboxed: false,
      serverCredentials: {},
      oauthEnv: {},
      allowedDirectory: '/sandbox',
      serverCwd,
    });
    const env = buildBackendEnv('fetch', { command: 'node', args: [] }, inputs('/relay-run/fetch.cwd'));
    expect(env.GIT_CEILING_DIRECTORIES).toBe('/relay-run');
    // The relay skips a backend whose environment cannot be built.
    expect(() =>
      buildBackendEnv('fetch', { command: 'node', args: [] }, inputs(`/relay${delimiter}run/fetch.cwd`)),
    ).toThrow(/must be absolute/);
  });

  describe.skipIf(!gitAvailable)('git backend', () => {
    const globalHelper = '!f() { echo username=global-user; echo password=global-secret; }; f';
    let root: string;
    let home: string;
    let sandbox: string;
    let baseEnv: Record<string, string>;
    const inputs = (allowedDirectory: string | undefined, env: Record<string, string> = baseEnv) => ({
      baseEnv: env,
      sandboxed: false,
      serverCredentials: {},
      oauthEnv: {},
      allowedDirectory,
      serverCwd: join(root, 'relay-run', 'git.cwd'),
    });
    /** The ceiling every backend gets: the directory holding its private cwd. */
    const cwdCeiling = () => join(root, 'relay-run');

    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-git-backend-env-')));
      expect(root).toMatch(/^[\w/.-]+$/u); // embedded unquoted in a shell snippet below
      home = join(root, 'home');
      sandbox = join(root, 'session', 'sandbox');
      mkdirSync(home);
      mkdirSync(sandbox, { recursive: true });
      writeFileSync(
        join(home, '.gitconfig'),
        [
          '[user]',
          '\tname = IronCurtain Test',
          '\temail = test@localhost',
          '[core]',
          '\tsshCommand = ssh -o BatchMode=yes',
          '[credential]',
          `\thelper = "${globalHelper}"`,
          '',
        ].join('\n'),
      );
      baseEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
    });

    it('forwards the ssh-agent socket to the git backend', () => {
      const env = buildBackendEnv('git', gitServer, inputs(sandbox, { ...baseEnv, SSH_AUTH_SOCK: '/run/agent.sock' }));
      expect(env.SSH_AUTH_SOCK).toBe('/run/agent.sock');
    });

    it("reads the user's git configuration from the file GIT_CONFIG_GLOBAL names, as the policy engine does", () => {
      // The policy engine resolves remotes from the trusted config git would
      // read (git-remote-resolution.ts, in the host process); the backend's
      // git and its replayed credential helper and ssh command must come
      // from the same file, not fall back to ~/.gitconfig.
      const dotfiles = join(root, 'dotfiles-gitconfig');
      const dotfilesHelper = '!f() { echo username=dotfiles-user; echo password=dotfiles-secret; }; f';
      writeFileSync(
        dotfiles,
        [
          '[core]',
          '\tsshCommand = ssh -o BatchMode=yes -i /keys/dotfiles',
          '[credential]',
          `\thelper = "${dotfilesHelper}"`,
          '',
        ].join('\n'),
      );
      const env = buildBackendEnv('git', gitServer, inputs(sandbox, { ...baseEnv, GIT_CONFIG_GLOBAL: dotfiles }));
      expect(env.GIT_CONFIG_GLOBAL).toBe(dotfiles);
      expect(effectiveGitConfig(env, 'core.sshCommand')).toBe('ssh -o BatchMode=yes -i /keys/dotfiles');
      expect(gitConfigEntries(env).filter(([key]) => key.startsWith('credential.'))).toEqual([
        ['credential.helper', ''],
        ['credential.helper', dotfilesHelper],
      ]);
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('carries command-scope overrides, the protocol allowlist and a ceiling above the allowed directory', () => {
      const env = buildBackendEnv('git', gitServer, inputs(sandbox));

      expect(env.MCP_TRANSPORT_TYPE).toBe('stdio');
      expect(effectiveGitConfig(env, 'core.fsmonitor')).toBe('false');
      expect(effectiveGitConfig(env, 'core.hooksPath')).toBe('/dev/null');
      expect(effectiveGitConfig(env, 'core.pager')).toBe('cat');
      expect(effectiveGitConfig(env, 'core.editor')).toBe('true');
      expect(effectiveGitConfig(env, 'sequence.editor')).toBe('true');
      expect(effectiveGitConfig(env, 'core.askPass')).toBe('');
      expect(effectiveGitConfig(env, 'safe.bareRepository')).toBe('explicit');
      // The user's own ssh command from global config, not the repository's.
      expect(effectiveGitConfig(env, 'core.sshCommand')).toBe('ssh -o BatchMode=yes');
      expect(effectiveGitConfig(env, 'protocol.allow')).toBe('never');
      expect(effectiveGitConfig(env, 'protocol.https.allow')).toBe('always');
      expect(effectiveGitConfig(env, 'protocol.ssh.allow')).toBe('always');
      for (const protocol of ['file', 'git', 'http', 'ext', 'fd']) {
        expect(effectiveGitConfig(env, `protocol.${protocol}.allow`)).toBe('never');
      }
      expect(env.GIT_ALLOW_PROTOCOL).toBe('https:ssh');
      // The allowed-directory ceiling is added to the private-cwd one, never in place of it.
      expect(env.GIT_CEILING_DIRECTORIES).toBe([cwdCeiling(), join(root, 'session')].join(delimiter));
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      // Identity and credential configuration are not nulled out.
      expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
      expect(env.GIT_CONFIG_SYSTEM).toBeUndefined();
      expect(env.HOME).toBe(home);
    });

    it('falls back to plain ssh when the user configured no ssh command', () => {
      writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = IronCurtain Test\n');
      const env = buildBackendEnv('git', gitServer, inputs(sandbox));
      expect(effectiveGitConfig(env, 'core.sshCommand')).toBe('ssh');
    });

    it('keeps a configured global credential helper and drops repository helpers', () => {
      const env = buildBackendEnv('git', gitServer, inputs(sandbox));
      expect(gitConfigEntries(env).filter(([key]) => key.startsWith('credential.'))).toEqual([
        ['credential.helper', ''],
        ['credential.helper', globalHelper],
      ]);

      // And git honours it: the global helper answers, an agent-planted one never runs.
      const repo = join(sandbox, 'repo');
      const marker = join(root, 'repo-helper-ran');
      execFileSync('git', ['init', '-q', repo], { env: baseEnv });
      execFileSync('git', ['config', 'credential.helper', `!touch ${marker}; false`], { cwd: repo, env: baseEnv });
      const request = 'protocol=https\nhost=example.com\n\n';
      const filled = execFileSync('git', ['credential', 'fill'], { cwd: repo, env, input: request, encoding: 'utf8' });
      expect(filled).toContain('username=global-user\n');
      expect(filled).toContain('password=global-secret\n');
      execFileSync('git', ['credential', 'reject'], { cwd: repo, env, input: filled });
      expect(existsSync(marker)).toBe(false);

      // Control: without the hardened environment the planted helper runs.
      execFileSync('git', ['credential', 'reject'], { cwd: repo, env: baseEnv, input: filled });
      expect(existsSync(marker)).toBe(true);
    });

    it('applies the hardening after the configured env and credentials', () => {
      const env = buildBackendEnv(
        'git',
        {
          ...gitServer,
          env: {
            ...gitServer.env,
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'core.hooksPath',
            GIT_CONFIG_VALUE_0: '/tmp/hooks',
            GIT_ALLOW_PROTOCOL: 'ext:file',
            GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='touch /tmp/x'",
          },
        },
        {
          ...inputs(sandbox, { ...baseEnv, GIT_DIR: '/elsewhere/.git', GIT_CEILING_DIRECTORIES: '/inherited' }),
          serverCredentials: { GIT_ASKPASS: '/tmp/askpass' },
        },
      );
      expect(gitConfigEntries(env)[0]).toEqual(['core.hooksPath', '/tmp/hooks']);
      expect(effectiveGitConfig(env, 'core.hooksPath')).toBe('/dev/null');
      expect(env.GIT_ALLOW_PROTOCOL).toBe('https:ssh');
      expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(env.GIT_DIR).toBeUndefined();
      expect(env.GIT_ASKPASS).toBeUndefined();
      // The relay's inherited GIT_CEILING_DIRECTORIES is not allowlisted, so
      // only the private-cwd and allowed-directory ceilings remain.
      expect(env.GIT_CEILING_DIRECTORIES).toBe([cwdCeiling(), join(root, 'session')].join(delimiter));
    });

    it('bounds discovery at the parent of the real allowed directory', () => {
      const workspace = join(root, 'real', 'workspace');
      mkdirSync(workspace, { recursive: true });
      const link = join(root, 'workspace-link');
      symlinkSync(workspace, link);
      expect(buildBackendEnv('git', gitServer, inputs(link)).GIT_CEILING_DIRECTORIES).toBe(
        [cwdCeiling(), join(root, 'real')].join(delimiter),
      );
    });

    it('sets only the private-cwd ceiling without an allowed directory but still hardens', () => {
      for (const allowedDirectory of [undefined, '']) {
        const env = buildBackendEnv('git', gitServer, inputs(allowedDirectory));
        expect(env.GIT_CEILING_DIRECTORIES).toBe(cwdCeiling());
        expect(env.GIT_ALLOW_PROTOCOL).toBe('https:ssh');
        expect(effectiveGitConfig(env, 'core.fsmonitor')).toBe('false');
      }
    });

    it('throws when the ceiling cannot be expressed, so the relay skips the backend', () => {
      const unexpressible = join(root, `parent${delimiter}name`, 'sandbox');
      mkdirSync(unexpressible, { recursive: true });
      expect(() => buildBackendEnv('git', gitServer, inputs(unexpressible))).toThrow(/ceiling directory/u);
    });

    it('keeps every override when srt appends its safe.directory entries', () => {
      // The integration test runs git unsandboxed; this covers the srt path.
      const env = buildBackendEnv('git', gitServer, { ...inputs(sandbox), sandboxed: true });
      expect(env).not.toHaveProperty('NODE_OPTIONS');
      const ours = gitConfigEntries(env);

      // What srt's POSIX wrapper (buildPosixGitSafeDirEnv) sets for the child:
      // its numbering continues from the GIT_CONFIG_COUNT the child inherits.
      const srtAdditions = buildGitConfigEnv({
        safeDirs: [sandbox],
        baseEnv: { GIT_CONFIG_COUNT: env.GIT_CONFIG_COUNT },
      });
      const child: Record<string, string> = { ...env, ...srtAdditions };
      const composed = gitConfigEntries(child);

      expect(composed.slice(0, ours.length)).toEqual(ours);
      expect(composed.slice(ours.length).map(([key]) => key)).toEqual(['safe.directory', 'safe.directory']);
      for (const key of ['core.fsmonitor', 'core.hooksPath', 'protocol.allow', 'core.sshCommand']) {
        expect(effectiveGitConfig(child, key)).toBe(effectiveGitConfig(env, key));
      }

      // git parses the composed set and applies the pinned values.
      const repo = join(sandbox, 'repo');
      execFileSync('git', ['init', '-q', repo], { env: baseEnv });
      const read = (key: string): string =>
        execFileSync('git', ['config', '--get', key], { cwd: repo, env: child, encoding: 'utf8' }).trim();
      expect(read('core.fsmonitor')).toBe('false');
      expect(read('core.hooksPath')).toBe('/dev/null');
    });
  });
});

// ── buildToolMap tests ─────────────────────────────────────────────────

describe('buildToolMap', () => {
  it('creates a map keyed by tool name', () => {
    const tools: ProxiedTool[] = [
      { serverName: 'fs', name: 'read_file', inputSchema: { type: 'object' } },
      { serverName: 'fs', name: 'write_file', inputSchema: { type: 'object' } },
      { serverName: 'git', name: 'git_status', inputSchema: { type: 'object' } },
    ];

    const map = buildToolMap(tools);

    expect(map.size).toBe(3);
    expect(map.get('read_file')?.serverName).toBe('fs');
    expect(map.get('write_file')?.serverName).toBe('fs');
    expect(map.get('git_status')?.serverName).toBe('git');
  });

  it('returns an empty map for empty input', () => {
    const map = buildToolMap([]);
    expect(map.size).toBe(0);
  });

  it('last tool wins when names collide', () => {
    const tools: ProxiedTool[] = [
      { serverName: 'a', name: 'dup', inputSchema: {} },
      { serverName: 'b', name: 'dup', inputSchema: {} },
    ];

    const map = buildToolMap(tools);
    expect(map.size).toBe(1);
    expect(map.get('dup')?.serverName).toBe('b');
  });
});

// ── buildAuditEntry tests ──────────────────────────────────────────────

describe('buildAuditEntry', () => {
  it('creates a complete audit entry with all fields', () => {
    const request = {
      requestId: 'req-1',
      serverName: 'fs',
      toolName: 'read_file',
      arguments: { path: '/tmp/foo' },
      timestamp: '2025-01-01T00:00:00.000Z',
    };
    const policyDecision = { status: 'allow' as const, rule: 'allow-reads', reason: 'allowed' };

    const entry = buildAuditEntry(request, { path: '/tmp/foo' }, policyDecision, { status: 'success' }, 42, {
      escalationResult: 'approved',
      sandboxed: true,
      autoApproved: true,
    });

    expect(entry.requestId).toBe('req-1');
    expect(entry.serverName).toBe('fs');
    expect(entry.toolName).toBe('read_file');
    expect(entry.arguments).toEqual({ path: '/tmp/foo' });
    expect(entry.policyDecision).toEqual(policyDecision);
    expect(entry.result).toEqual({ status: 'success' });
    expect(entry.durationMs).toBe(42);
    expect(entry.escalationResult).toBe('approved');
    expect(entry.sandboxed).toBe(true);
    expect(entry.autoApproved).toBe(true);
  });

  it('omits optional fields when not provided', () => {
    const request = {
      requestId: 'req-2',
      serverName: 'git',
      toolName: 'git_add',
      arguments: {},
      timestamp: '2025-01-01T00:00:00.000Z',
    };
    const policyDecision = { status: 'deny' as const, rule: 'deny-all', reason: 'denied' };

    const entry = buildAuditEntry(request, {}, policyDecision, { status: 'denied', error: 'denied' }, 0, {});

    expect(entry.escalationResult).toBeUndefined();
    expect(entry.sandboxed).toBeUndefined();
    expect(entry.autoApproved).toBeUndefined();
  });

  it('uses argsForTransport (not request.arguments) in the entry', () => {
    const request = {
      requestId: 'req-3',
      serverName: 'fs',
      toolName: 'read_file',
      arguments: { path: '/policy/resolved/path' },
      timestamp: '2025-01-01T00:00:00.000Z',
    };

    const entry = buildAuditEntry(
      request,
      { path: '/transport/original/path' },
      { status: 'allow' as const, rule: 'r', reason: 'r' },
      { status: 'success' },
      10,
      {},
    );

    expect(entry.arguments).toEqual({ path: '/transport/original/path' });
  });
});

// ── validateToolArguments tests ──────────────────────────────────────────

describe('validateToolArguments', () => {
  it('returns null when all args match schema properties', () => {
    const result = validateToolArguments(
      { path: '/tmp/foo', encoding: 'utf-8' },
      { type: 'object', properties: { path: { type: 'string' }, encoding: { type: 'string' } } },
    );
    expect(result).toBeNull();
  });

  it('returns error listing unknown keys and valid keys', () => {
    const result = validateToolArguments(
      { calendar_id: '123', summary: 'test' },
      { type: 'object', properties: { calendarId: { type: 'string' }, summary: { type: 'string' } } },
    );
    expect(result).toContain('Unknown argument(s): "calendar_id"');
    expect(result).toContain('"calendarId"');
    expect(result).toContain('"summary"');
  });

  it('skips validation when schema has no properties', () => {
    expect(validateToolArguments({ anything: 'goes' }, { type: 'object' })).toBeNull();
  });

  it('skips validation when additionalProperties is true', () => {
    const result = validateToolArguments(
      { unknown_key: 'value' },
      { type: 'object', properties: { known: { type: 'string' } }, additionalProperties: true },
    );
    expect(result).toBeNull();
  });

  it('skips validation when additionalProperties is a schema object', () => {
    const result = validateToolArguments(
      { unknown_key: 'value' },
      { type: 'object', properties: { known: { type: 'string' } }, additionalProperties: { type: 'string' } },
    );
    expect(result).toBeNull();
  });

  it('returns null for empty args', () => {
    expect(validateToolArguments({}, { type: 'object', properties: { path: { type: 'string' } } })).toBeNull();
  });
});

// ── handleCallTool tests ───────────────────────────────────────────────

describe('handleCallTool', () => {
  function createMockDeps(overrides: Partial<CallToolDeps> = {}): CallToolDeps {
    const tool: ProxiedTool = {
      serverName: 'fs',
      name: 'read_file',
      inputSchema: { type: 'object' },
    };
    const toolMap = new Map<string, ProxiedTool>();
    toolMap.set('read_file', tool);

    const annotation = {
      toolName: 'read_file',
      serverName: 'fs',
      comment: 'Reads a file',
      args: { path: ['read-path'] },
    };

    const getAnnotation = vi.fn().mockReturnValue(annotation);
    const policyEngine = {
      getAnnotation,
      // The stored annotation has the same argument keys as the resolved one;
      // follow getAnnotation so tests that override it stay consistent.
      getStoredAnnotation: vi.fn((server: string, tool: string): unknown => getAnnotation(server, tool, {})),
      evaluate: vi.fn().mockReturnValue({
        decision: 'allow',
        rule: 'allow-reads',
        reason: 'allowed',
      }),
      isTrustedServer: vi.fn().mockReturnValue(false),
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'file content' }],
        isError: false,
      }),
    };

    const clientStates = new Map<string, ClientState>();
    clientStates.set('fs', {
      client: mockClient as unknown as ClientState['client'],
      roots: [],
    });

    const resolvedSandboxConfigs = new Map();
    resolvedSandboxConfigs.set('fs', { sandboxed: false, reason: 'opt-out' });

    return {
      toolMap,
      policyEngine: policyEngine as unknown as CallToolDeps['policyEngine'],
      auditLog: { log: vi.fn(), assertWritable: vi.fn() } as unknown as CallToolDeps['auditLog'],
      circuitBreaker: {
        check: vi.fn().mockReturnValue({ allowed: true }),
      } as unknown as CallToolDeps['circuitBreaker'],
      clientStates,
      resolvedSandboxConfigs,
      allowedDirectory: '/tmp/sandbox',
      escalationDir: undefined,
      autoApproveModel: null,
      serverContextMap: new Map(),
      whitelist: createApprovalWhitelist(),
      ...overrides,
    };
  }

  it('returns error for unknown tool', async () => {
    const deps = createMockDeps();

    const result = await handleCallTool('nonexistent_tool', {}, deps);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Unknown tool: nonexistent_tool' }]);
  });

  it.each(['annotated', 'trusted', 'unknown'])(
    'bounds every %s call before policy, audit serialization and backend dispatch',
    async (kind) => {
      const deps = createMockDeps();
      vi.mocked(deps.policyEngine.isTrustedServer).mockReturnValue(kind === 'trusted');
      vi.mocked(deps.policyEngine.getAnnotation).mockReturnValue(
        kind === 'trusted'
          ? undefined
          : { serverName: 'fs', toolName: 'read_file', comment: '', args: { entries: ['none'] } },
      );
      const response = await handleCallTool(
        kind === 'unknown' ? 'fs__missing' : 'read_file',
        {
          entries: Array.from({ length: 4096 }, () => null),
        },
        deps,
      );
      expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'structural-argument-budget-deny' });
      expect(deps.auditLog.log).toHaveBeenCalledOnce();
      expect(deps.auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'fs',
          toolName: kind === 'unknown' ? 'missing' : 'read_file',
          arguments: {},
          policyDecision: response._policyDecision,
        }),
      );
      expect(deps.policyEngine.getAnnotation).not.toHaveBeenCalled();
      expect(deps.clientStates.get('fs')?.client.callTool).not.toHaveBeenCalled();
    },
  );

  it('bounds the relay call with the backend timeout plus grace and asks for progress', async () => {
    const deps = createMockDeps({ backendCallTimeoutMs: 20_000 });

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);
    expect(result.isError).toBeUndefined();

    const client = deps.clientStates.get('fs')?.client;
    const callTool = vi.mocked(client?.callTool as unknown as (...args: unknown[]) => unknown);
    expect(callTool).toHaveBeenCalledTimes(1);
    const options = callTool.mock.calls[0][2] as {
      timeout: number;
      resetTimeoutOnProgress: boolean;
      maxTotalTimeout: number;
      onprogress?: unknown;
    };
    // The relay's own deadline (20 s) fires first; the parent allows the grace.
    expect(options.timeout).toBe(relayCallTimeoutMs(20_000));
    expect(options.resetTimeoutOnProgress).toBe(true);
    // Progress cannot extend the parent's wait past the relay's own ceiling.
    expect(options.maxTotalTimeout).toBe(relayCallTimeoutMs(maxTotalBackendCallMs(20_000)));
    // Asking for progress makes the SDK attach a token the relay forwards back.
    expect(typeof options.onprogress).toBe('function');
  });

  it('falls back to the default backend bound when none is configured', async () => {
    const deps = createMockDeps();
    await handleCallTool('read_file', { path: '/tmp/foo' }, deps);
    const client = deps.clientStates.get('fs')?.client;
    const callTool = vi.mocked(client?.callTool as unknown as (...args: unknown[]) => unknown);
    const options = callTool.mock.calls[0][2] as { timeout: number };
    expect(options.timeout).toBe(relayCallTimeoutMs(DEFAULT_BACKEND_CALL_TIMEOUT_MS));
  });

  it('returns error when annotation is missing', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.policyEngine.getAnnotation).mockReturnValue(undefined);

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('Missing annotation for tool');
    expect(content[0].text).toContain("Re-run 'ironcurtain annotate-tools'");
  });

  it('returns error for unknown argument keys', async () => {
    const tool: ProxiedTool = {
      serverName: 'fs',
      name: 'read_file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    };
    const toolMap = new Map<string, ProxiedTool>();
    toolMap.set('read_file', tool);
    const deps = createMockDeps({ toolMap });

    const result = await handleCallTool('read_file', { file_path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('Unknown argument(s): "file_path"');
    expect(content[0].text).toContain('"path"');
    // Validation failures must be audit-logged
    expect(deps.auditLog.log).toHaveBeenCalledTimes(1);
    const logged = vi.mocked(deps.auditLog.log).mock.calls[0][0];
    expect(logged.result.status).toBe('denied');
    expect(logged.result.error).toContain('file_path');
  });

  it('skips argument validation for trusted servers', async () => {
    const tool: ProxiedTool = {
      serverName: 'memory',
      name: 'store',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
    };
    const toolMap = new Map<string, ProxiedTool>();
    toolMap.set('store', tool);

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'stored' }],
        isError: false,
      }),
    };
    const clientStates = new Map<string, ClientState>();
    clientStates.set('memory', {
      client: mockClient as unknown as ClientState['client'],
      roots: [],
    });

    const resolvedSandboxConfigs = new Map();
    resolvedSandboxConfigs.set('memory', { sandboxed: false, reason: 'opt-out' });

    const deps = createMockDeps({ toolMap, clientStates, resolvedSandboxConfigs });
    vi.mocked(deps.policyEngine.getAnnotation).mockReturnValue(undefined);
    vi.mocked(deps.policyEngine.isTrustedServer).mockReturnValue(true);

    const result = await handleCallTool('store', { unknown_arg: 'value' }, deps);

    // Trusted servers bypass validation — call should reach the MCP server
    expect(result.isError).toBeFalsy();
    expect(mockClient.callTool).toHaveBeenCalled();
  });

  it('forwards allowed calls to the real MCP server', async () => {
    const deps = createMockDeps();

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: 'file content' }]);
    // A dispatched call is audited twice: the write-ahead `dispatching`
    // record before the backend sees it, then its outcome.
    expect(deps.auditLog.log).toHaveBeenCalledTimes(2);
    const [writeAhead, outcome] = vi.mocked(deps.auditLog.log).mock.calls.map((call) => call[0]);
    expect(writeAhead.result.status).toBe('dispatching');
    expect(writeAhead.requestId).toBe(outcome.requestId);
    expect(outcome.result.status).toBe('success');
  });

  it('denies calls when policy evaluates to deny', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.policyEngine.evaluate).mockReturnValue({
      decision: 'deny',
      rule: 'protected-path',
      reason: 'Path is protected',
    });

    const result = await handleCallTool('read_file', { path: '/etc/shadow' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('DENIED: Path is protected');
    expect(deps.auditLog.log).toHaveBeenCalledTimes(1);
    const loggedEntry = vi.mocked(deps.auditLog.log).mock.calls[0][0];
    expect(loggedEntry.result.status).toBe('denied');
  });

  it('auto-denies escalation when no escalation directory is configured', async () => {
    const deps = createMockDeps({ escalationDir: undefined });
    vi.mocked(deps.policyEngine.evaluate).mockReturnValue({
      decision: 'escalate',
      rule: 'escalate-writes',
      reason: 'Write requires approval',
    });

    const result = await handleCallTool('read_file', { path: '/opt/data' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('ESCALATION REQUIRED');
    expect(content[0].text).toContain('no escalation handler');
    expect(deps.auditLog.log).toHaveBeenCalledTimes(1);
    const loggedEntry = vi.mocked(deps.auditLog.log).mock.calls[0][0];
    expect(loggedEntry.escalationResult).toBe('denied');
  });

  it('denies calls when circuit breaker trips', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.circuitBreaker.check).mockReturnValue({
      allowed: false,
      reason: 'Circuit breaker: too many identical calls',
    });

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('Circuit breaker: too many identical calls');
    expect(deps.auditLog.log).toHaveBeenCalledTimes(1);
  });

  it('uses a server-qualified circuit breaker key (no bare-tool-name bucket sharing)', async () => {
    // Pre-fix this passed only `toolInfo.name` to `circuitBreaker.check`,
    // which silently shared a rate-limit bucket across two servers that
    // expose the same bare tool name. Post-fix the key is
    // `${serverName}__${toolName}`.
    const deps = createMockDeps();
    await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(deps.circuitBreaker.check).toHaveBeenCalledTimes(1);
    const [keyArg] = vi.mocked(deps.circuitBreaker.check).mock.calls[0];
    expect(keyArg).toBe('fs__read_file');
  });

  it('returns error when no client connection exists for the server', async () => {
    const deps = createMockDeps();
    deps.clientStates.clear();

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('Internal error: no client connection');
  });

  it('handles MCP server returning isError=true', async () => {
    const deps = createMockDeps();
    const clientState = deps.clientStates.get('fs')!;
    vi.mocked((clientState.client as unknown as { callTool: ReturnType<typeof vi.fn> }).callTool).mockResolvedValue({
      content: [{ type: 'text', text: 'Permission denied' }],
      isError: true,
    });

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    expect(deps.auditLog.log).toHaveBeenCalledTimes(2);
    const loggedEntry = vi.mocked(deps.auditLog.log).mock.calls[1][0];
    expect(loggedEntry.result.status).toBe('error');
  });

  it('handles MCP server throwing an exception', async () => {
    const deps = createMockDeps();
    const clientState = deps.clientStates.get('fs')!;
    vi.mocked((clientState.client as unknown as { callTool: ReturnType<typeof vi.fn> }).callTool).mockRejectedValue(
      new Error('Connection lost'),
    );

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('Error: Connection lost');
    expect(deps.auditLog.log).toHaveBeenCalledTimes(2);
    const loggedEntry = vi.mocked(deps.auditLog.log).mock.calls[1][0];
    expect(loggedEntry.result.status).toBe('error');
  });

  it('handles non-Error exceptions from MCP server', async () => {
    const deps = createMockDeps();
    const clientState = deps.clientStates.get('fs')!;
    vi.mocked((clientState.client as unknown as { callTool: ReturnType<typeof vi.fn> }).callTool).mockRejectedValue(
      'string error',
    );

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('Error: string error');
  });

  it('records sandboxed=true in audit when server is sandboxed', async () => {
    const deps = createMockDeps();
    deps.resolvedSandboxConfigs.set('fs', { sandboxed: true, config: {} } as unknown as ResolvedSandboxConfig);

    await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    const loggedEntry = vi.mocked(deps.auditLog.log).mock.calls[0][0];
    expect(loggedEntry.sandboxed).toBe(true);
  });

  it('records sandboxed=false when the server asked for an OS sandbox it did not get', async () => {
    const deps = createMockDeps();
    deps.resolvedSandboxConfigs.set('fs', { sandboxed: false, reason: 'platform-unavailable' });

    await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    const loggedEntry = vi.mocked(deps.auditLog.log).mock.calls[0][0];
    expect(loggedEntry.sandboxed).toBe(false);
  });

  it('omits sandboxed for servers that opted out of OS sandboxing', async () => {
    const deps = createMockDeps();

    await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    const loggedEntry = vi.mocked(deps.auditLog.log).mock.calls[0][0];
    expect(loggedEntry.sandboxed).toBeUndefined();
  });

  it('extracts meaningful message from McpError with data', async () => {
    const deps = createMockDeps();
    const clientState = deps.clientStates.get('fs')!;
    vi.mocked((clientState.client as unknown as { callTool: ReturnType<typeof vi.fn> }).callTool).mockRejectedValue(
      new McpError(ErrorCode.InvalidParams, 'Structured content does not match', 'No session working directory set'),
    );

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('Error: No session working directory set');
  });

  it('tracks server context after successful tool call', async () => {
    const deps = createMockDeps();
    // Add git server with git_set_working_dir tool
    const gitTool: ProxiedTool = { serverName: 'git', name: 'git_set_working_dir', inputSchema: { type: 'object' } };
    deps.toolMap.set('git_set_working_dir', gitTool);
    const gitAnnotation: ToolAnnotation = {
      toolName: 'git_set_working_dir',
      serverName: 'git',
      comment: 'Sets working dir',
      args: { path: ['none'] },
    };
    vi.mocked(deps.policyEngine.getAnnotation).mockReturnValue(gitAnnotation);

    const mockGitClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Working directory set' }],
        isError: false,
      }),
    };
    deps.clientStates.set('git', {
      client: mockGitClient as unknown as ClientState['client'],
      roots: [],
    });
    deps.resolvedSandboxConfigs.set('git', { sandboxed: false, reason: 'opt-out' });

    await handleCallTool('git_set_working_dir', { path: '/home/user/repo' }, deps);

    expect(deps.serverContextMap.get('git')?.workingDirectory).toBe('/home/user/repo');
  });

  describe('git path enrichment', () => {
    function createGitDeps(overrides: Partial<CallToolDeps> = {}): CallToolDeps {
      const gitTool: ProxiedTool = { serverName: 'git', name: 'git_push', inputSchema: { type: 'object' } };
      const toolMap = new Map<string, ProxiedTool>();
      toolMap.set('git_push', gitTool);

      const annotation = {
        toolName: 'git_push',
        serverName: 'git',
        comment: 'Pushes commits',
        args: { path: ['read-path'], remote: ['git-remote-url'], branch: ['branch-name'] },
      };

      const policyEngine = {
        getAnnotation: vi.fn().mockReturnValue(annotation),
        getStoredAnnotation: vi.fn().mockReturnValue(annotation),
        evaluate: vi.fn().mockReturnValue({ decision: 'allow', rule: 'test-allow', reason: 'test' }),
        isTrustedServer: vi.fn().mockReturnValue(false),
      };

      const mockGitClient = {
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'pushed' }],
          isError: false,
        }),
      };

      const clientStates = new Map<string, ClientState>();
      clientStates.set('git', { client: mockGitClient as unknown as ClientState['client'], roots: [] });

      const resolvedSandboxConfigs = new Map();
      resolvedSandboxConfigs.set('git', { sandboxed: false, reason: 'opt-out' });

      // Pre-populate serverContextMap with a git working directory
      const serverContextMap = new Map();
      serverContextMap.set('git', { workingDirectory: '/home/user/repo' });

      return {
        toolMap,
        policyEngine: policyEngine as unknown as CallToolDeps['policyEngine'],
        auditLog: { log: vi.fn(), assertWritable: vi.fn() } as unknown as CallToolDeps['auditLog'],
        circuitBreaker: {
          check: vi.fn().mockReturnValue({ allowed: true }),
        } as unknown as CallToolDeps['circuitBreaker'],
        clientStates,
        resolvedSandboxConfigs,
        allowedDirectory: '/tmp/sandbox',
        escalationDir: undefined,
        autoApproveModel: null,
        whitelist: createApprovalWhitelist(),
        serverContextMap,
        ...overrides,
      };
    }

    it('injects path from serverContextMap when path is absent', async () => {
      const deps = createGitDeps();
      const mockPrepareToolArgs = vi.mocked(await import('../src/trusted-process/path-utils.js')).prepareToolArgs;

      await handleCallTool('git_push', { remote: 'origin' }, deps);

      expect(mockPrepareToolArgs).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/home/user/repo', remote: 'origin' }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('does not inject path when path is already provided', async () => {
      const deps = createGitDeps();
      const mockPrepareToolArgs = vi.mocked(await import('../src/trusted-process/path-utils.js')).prepareToolArgs;

      await handleCallTool('git_push', { path: '/explicit/path' }, deps);

      expect(mockPrepareToolArgs).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/explicit/path' }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('returns error when git working directory is not set', async () => {
      const deps = createGitDeps();
      deps.serverContextMap.set('git', {}); // no workingDirectory

      const result = await handleCallTool('git_push', {}, deps);

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('git_set_working_dir');
      expect(deps.auditLog.log).toHaveBeenCalled();
    });

    it('returns error when no git context exists at all', async () => {
      const deps = createGitDeps();
      deps.serverContextMap.clear();

      const result = await handleCallTool('git_push', {}, deps);

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('git_set_working_dir');
      expect(deps.auditLog.log).toHaveBeenCalled();
    });
  });

  describe('roots-race retry', () => {
    // Roots are only ever added for existing canonical directories, so the
    // "outside" directory must really exist.
    let outsideDir: string;
    let outsideFile: string;

    beforeEach(() => {
      outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'roots-race-outside-')));
      outsideFile = join(outsideDir, 'file.txt');
      writeFileSync(outsideFile, 'file content');
    });

    afterEach(() => {
      rmSync(outsideDir, { recursive: true, force: true });
    });

    it('retries once when callTool returns access-denied after roots expansion', async () => {
      const { autoApprove, readUserContext } = await import('../src/trusted-process/auto-approver.js');

      // Configure auto-approve to approve the escalation
      vi.mocked(readUserContext).mockReturnValue({ userMessage: `read ${outsideFile}` });
      vi.mocked(autoApprove).mockResolvedValue({ decision: 'approve', reasoning: 'user requested' });

      const mockCallTool = vi
        .fn()
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Access denied - path outside allowed directories' }],
          isError: true,
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'file content' }],
          isError: false,
        });

      const clientState: ClientState = {
        client: null as unknown as ClientState['client'],
        roots: [{ uri: 'file:///tmp/sandbox', name: 'sandbox' }],
      };

      // sendRootsListChanged triggers the rootsRefreshed callback (simulating
      // the server calling roots/list), so addRootsToClient returns 'added'.
      const mockClient = {
        callTool: mockCallTool,
        sendRootsListChanged: vi.fn().mockImplementation(async () => {
          clientState.rootsRefreshed?.();
          clientState.rootsRefreshed = undefined;
        }),
      };
      clientState.client = mockClient as unknown as ClientState['client'];

      const clientStates = new Map<string, ClientState>();
      clientStates.set('fs', clientState);

      const deps = createMockDeps({
        clientStates,
        escalationDir: '/tmp/esc',
        autoApproveModel: 'test-model' as unknown as CallToolDeps['autoApproveModel'],
      });

      // Policy escalates the read-path role
      vi.mocked(deps.policyEngine.evaluate).mockReturnValue({
        decision: 'escalate',
        rule: 'escalate-reads',
        reason: 'Read outside sandbox',
        escalatedRoles: ['read-path'],
      });

      const result = await handleCallTool('read_file', { path: outsideFile }, deps);

      // The approved file's directory became a root
      expect(clientState.roots).toContainEqual({
        uri: pathToFileURL(outsideDir).href,
        name: 'escalation-approved',
      });

      // Should have retried and succeeded
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([{ type: 'text', text: 'file content' }]);
      expect(mockCallTool).toHaveBeenCalledTimes(2);

      // Audit log should have 3 entries: the write-ahead `dispatching`
      // record, the initial race error (written before the retry, so it
      // doubles as the retry's write-ahead record) and the successful retry
      expect(deps.auditLog.log).toHaveBeenCalledTimes(3);
      const [writeAhead, raceLog, retryLog] = vi.mocked(deps.auditLog.log).mock.calls.map((call) => call[0]);
      expect(writeAhead.result.status).toBe('dispatching');
      expect(raceLog.result.status).toBe('error');
      expect((raceLog.result as { error: string }).error).toContain('Roots race detected');
      expect(retryLog.result.status).toBe('success');
    });

    it('does not retry when roots expansion timed out (server did not acknowledge)', async () => {
      const { autoApprove, readUserContext } = await import('../src/trusted-process/auto-approver.js');

      vi.mocked(readUserContext).mockReturnValue({ userMessage: `read ${outsideFile}` });
      vi.mocked(autoApprove).mockResolvedValue({ decision: 'approve', reasoning: 'user requested' });

      const mockCallTool = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Access denied - path outside allowed directories' }],
        isError: true,
      });

      // sendRootsListChanged resolves but rootsRefreshed callback is never called,
      // so addRootsToClient times out and returns 'timeout' → no race retry
      const mockClient = {
        callTool: mockCallTool,
        sendRootsListChanged: vi.fn().mockResolvedValue(undefined),
      };

      const clientStates = new Map<string, ClientState>();
      clientStates.set('fs', {
        client: mockClient as unknown as ClientState['client'],
        roots: [{ uri: 'file:///tmp/sandbox', name: 'sandbox' }],
      });

      const deps = createMockDeps({
        clientStates,
        escalationDir: '/tmp/esc',
        autoApproveModel: 'test-model' as unknown as CallToolDeps['autoApproveModel'],
      });

      vi.mocked(deps.policyEngine.evaluate).mockReturnValue({
        decision: 'escalate',
        rule: 'escalate-reads',
        reason: 'Read outside sandbox',
        escalatedRoles: ['read-path'],
      });

      // Use fake timers so addRootsToClient's timeout fires immediately
      vi.useFakeTimers();
      const resultPromise = handleCallTool('read_file', { path: outsideFile }, deps);
      // Advance past the ROOTS_REFRESH_TIMEOUT_MS so addRootsToClient resolves via timeout
      await vi.advanceTimersByTimeAsync(ROOTS_REFRESH_TIMEOUT_MS + 100);
      vi.useRealTimers();

      const result = await resultPromise;

      // callTool should have been called only once — no retry since server didn't acknowledge
      expect(mockCallTool).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
    });
  });
});

// ── selectTransportConfig tests ────────────────────────────────────────

describe('selectTransportConfig', () => {
  const savedEnv = { ...process.env };
  const tcpToken = 'a1'.repeat(32);

  beforeEach(() => {
    process.env.IRONCURTAIN_MCP_TCP_TOKEN = tcpToken;
  });

  afterEach(() => {
    delete process.env.PROXY_TCP_PORT;
    delete process.env.PROXY_SOCKET_PATH;
    delete process.env.PROXY_PORT_FILE;
    delete process.env.IRONCURTAIN_MCP_TCP_TOKEN;
    Object.assign(process.env, savedEnv);
  });

  it('returns stdio when no transport env vars are set', () => {
    delete process.env.PROXY_TCP_PORT;
    delete process.env.PROXY_SOCKET_PATH;

    const config = selectTransportConfig();
    expect(config.kind).toBe('stdio');
  });

  it('returns tcp with parsed port', () => {
    process.env.PROXY_TCP_PORT = '8080';

    const config = selectTransportConfig();
    expect(config.kind).toBe('tcp');
    if (config.kind === 'tcp') {
      expect(config.port).toBe(8080);
      expect(config).toMatchObject({ host: '127.0.0.1', requiredToken: tcpToken });
    }
  });

  it.each([undefined, '', 'invalid', 'AA'.repeat(32)])('refuses a missing or noncanonical TCP credential', (token) => {
    process.env.PROXY_TCP_PORT = '8080';
    if (token === undefined) delete process.env.IRONCURTAIN_MCP_TCP_TOKEN;
    else process.env.IRONCURTAIN_MCP_TCP_TOKEN = token;
    expect(() => selectTransportConfig()).toThrow('PROXY_TCP_PORT requires IRONCURTAIN_MCP_TCP_TOKEN');
  });

  it('returns tcp with port 0 for ephemeral allocation', () => {
    process.env.PROXY_TCP_PORT = '0';

    const config = selectTransportConfig();
    expect(config.kind).toBe('tcp');
    if (config.kind === 'tcp') {
      expect(config.port).toBe(0);
    }
  });

  it('includes portFilePath when PROXY_PORT_FILE is set', () => {
    process.env.PROXY_TCP_PORT = '8080';
    process.env.PROXY_PORT_FILE = '/tmp/port';

    const config = selectTransportConfig();
    expect(config.kind).toBe('tcp');
    if (config.kind === 'tcp') {
      expect(config.portFilePath).toBe('/tmp/port');
    }
  });

  it('returns uds with socket path', () => {
    delete process.env.PROXY_TCP_PORT;
    process.env.PROXY_SOCKET_PATH = '/tmp/proxy.sock';

    const config = selectTransportConfig();
    expect(config.kind).toBe('uds');
    if (config.kind === 'uds') {
      expect(config.socketPath).toBe('/tmp/proxy.sock');
    }
  });

  it('prefers tcp over uds when both are set', () => {
    process.env.PROXY_TCP_PORT = '9090';
    process.env.PROXY_SOCKET_PATH = '/tmp/proxy.sock';

    const config = selectTransportConfig();
    expect(config.kind).toBe('tcp');
  });

  it('throws for invalid TCP port (negative)', () => {
    process.env.PROXY_TCP_PORT = '-1';

    expect(() => selectTransportConfig()).toThrow(/Invalid PROXY_TCP_PORT/);
  });

  it('throws for invalid TCP port (too large)', () => {
    process.env.PROXY_TCP_PORT = '99999';

    expect(() => selectTransportConfig()).toThrow(/Invalid PROXY_TCP_PORT/);
  });

  it('throws for non-numeric TCP port', () => {
    process.env.PROXY_TCP_PORT = 'abc';

    expect(() => selectTransportConfig()).toThrow(/Invalid PROXY_TCP_PORT/);
  });

  it('throws for TCP port 65536 (just above max)', () => {
    process.env.PROXY_TCP_PORT = '65536';

    expect(() => selectTransportConfig()).toThrow(/Invalid PROXY_TCP_PORT/);
  });

  it('accepts TCP port 65535 (max valid)', () => {
    process.env.PROXY_TCP_PORT = '65535';

    const config = selectTransportConfig();
    expect(config.kind).toBe('tcp');
    if (config.kind === 'tcp') {
      expect(config.port).toBe(65535);
    }
  });
});

// ── isUserContextTrusted tests ─────────────────────────────────────────

describe('isUserContextTrusted', () => {
  const NOW = 1_000_000; // fixed "now" for deterministic staleness tests
  const FRESH = new Date(NOW - 1000).toISOString(); // 1 second old (fresh)
  const STALE = new Date(NOW - 200_000).toISOString(); // 200 seconds old (stale, limit is 120s)
  const FUTURE = new Date(NOW + 5000).toISOString(); // 5 seconds in the future

  describe('non-PTY sessions', () => {
    it('trusts a context with no timestamp', () => {
      expect(isUserContextTrusted({ userMessage: 'hello' }, false, NOW)).toBe(true);
    });

    it('trusts a context with a fresh timestamp', () => {
      expect(isUserContextTrusted({ userMessage: 'hello', timestamp: FRESH }, false, NOW)).toBe(true);
    });

    it('does not trust a context with a stale timestamp', () => {
      expect(isUserContextTrusted({ userMessage: 'hello', timestamp: STALE }, false, NOW)).toBe(false);
    });

    it('does not trust a context with a future timestamp', () => {
      expect(isUserContextTrusted({ userMessage: 'hello', timestamp: FUTURE }, false, NOW)).toBe(false);
    });

    it('trusts a context with an invalid (NaN) timestamp', () => {
      expect(isUserContextTrusted({ userMessage: 'hello', timestamp: 'not-a-date' }, false, NOW)).toBe(true);
    });

    it('ignores source for non-PTY sessions', () => {
      expect(isUserContextTrusted({ userMessage: 'hello', source: 'untrusted-source' }, false, NOW)).toBe(true);
    });
  });

  describe('PTY sessions', () => {
    it('trusts a context with the correct source and a fresh timestamp', () => {
      expect(
        isUserContextTrusted({ userMessage: 'hello', source: 'mux-trusted-input', timestamp: FRESH }, true, NOW),
      ).toBe(true);
    });

    it('does not trust a context with wrong source', () => {
      expect(isUserContextTrusted({ userMessage: 'hello', source: 'other-source', timestamp: FRESH }, true, NOW)).toBe(
        false,
      );
    });

    it('does not trust a context with missing source', () => {
      expect(isUserContextTrusted({ userMessage: 'hello', timestamp: FRESH }, true, NOW)).toBe(false);
    });

    it('does not trust a context with no timestamp (PTY requires it)', () => {
      expect(isUserContextTrusted({ userMessage: 'hello', source: 'mux-trusted-input' }, true, NOW)).toBe(false);
    });

    it('does not trust a context with an invalid (NaN) timestamp', () => {
      expect(
        isUserContextTrusted({ userMessage: 'hello', source: 'mux-trusted-input', timestamp: 'not-a-date' }, true, NOW),
      ).toBe(false);
    });

    it('does not trust a context with a stale timestamp', () => {
      expect(
        isUserContextTrusted({ userMessage: 'hello', source: 'mux-trusted-input', timestamp: STALE }, true, NOW),
      ).toBe(false);
    });

    it('does not trust a context with a future timestamp', () => {
      expect(
        isUserContextTrusted({ userMessage: 'hello', source: 'mux-trusted-input', timestamp: FUTURE }, true, NOW),
      ).toBe(false);
    });
  });
});
