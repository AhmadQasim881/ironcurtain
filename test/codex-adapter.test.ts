import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { createCodexAdapter } from '../src/docker/adapters/codex.js';
import { CONTAINER_WORKSPACE_DIR, type OrientationContext } from '../src/docker/agent-adapter.js';
import { generateFakeKey } from '../src/docker/fake-keys.js';
import type { IronCurtainConfig } from '../src/config/types.js';

const sampleContext: OrientationContext = {
  workspaceDir: CONTAINER_WORKSPACE_DIR,
  serverListings: [{ name: 'filesystem', description: 'Read, write, and manage files' }],
  allowedDomains: ['example.com'],
  networkMode: 'none',
};

describe('CodexAdapter', () => {
  const adapter = createCodexAdapter();

  it('returns the expected image name', async () => {
    await expect(adapter.getImage()).resolves.toBe('ironcurtain-codex:latest');
  });

  it('generates Codex TOML config with MCP stdio bridge and CLAUDE.md fallback', () => {
    const files = adapter.generateMcpConfig('/run/ironcurtain/proxy.sock', {} as IronCurtainConfig);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('codex-config.toml');
    expect(files[0].content).toContain('project_doc_fallback_filenames = ["CLAUDE.md"]');
    expect(files[0].content).toContain('[mcp_servers.ironcurtain]');
    expect(files[0].content).toContain('command = "socat"');
    expect(files[0].content).toContain('"UNIX-CONNECT:/run/ironcurtain/proxy.sock"');
    expect(files[0].content).toContain('default_tools_approval_mode = "auto"');
  });

  it('disables provider-hosted web search at the root of every generated config', () => {
    const zaiProfile = {
      type: 'zai',
      apiKey: '',
      model: 'glm-5.3',
      plan: 'api',
      modelMap: [{ match: '*', model: 'glm-5.3' }],
      usesDefaultMap: false,
      perAgent: { 'claude-code': undefined, codex: undefined, goose: undefined },
    };
    const configs = [{} as IronCurtainConfig, { activeProviderProfile: zaiProfile } as unknown as IronCurtainConfig];
    for (const config of configs) {
      const toml = adapter.generateMcpConfig('/run/ironcurtain/proxy.sock', config)[0].content;
      // A root key: Codex would read it as a table field if it followed a table header.
      expect(parseToml(toml).web_search).toBe('disabled');
    }
  });

  it('generates TCP MCP config for macOS bridge mode', () => {
    const files = adapter.generateMcpConfig('host.docker.internal:12345', {} as IronCurtainConfig);
    expect(files[0].content).toContain('command = "node"');
    expect(files[0].content).toContain('"/usr/local/bin/ironcurtain-mcp-bridge.mjs", "host.docker.internal:12345"');
    expect(files[0].content).toContain('env_vars = ["IRONCURTAIN_MCP_TCP_TOKEN"]');
  });

  it('passes the mounted PTY orientation as one inert Codex developer-instructions argument', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'codex-pty-wrapper-'));
    try {
      const startScript = adapter
        .generateOrientationFiles(sampleContext)
        .find((file) => file.path === 'start-codex.sh');
      expect(startScript).toBeDefined();

      const scriptPath = join(tempDir, 'start-codex.sh');
      const fakeCodexPath = join(tempDir, 'codex');
      const capturedArgsPath = join(tempDir, 'captured-args');
      const substitutionSentinel = join(tempDir, 'substitution-ran');
      const backtickSentinel = join(tempDir, 'backtick-ran');
      const workspaceDir = join(tempDir, 'workspace');
      mkdirSync(workspaceDir);
      const executableScript = startScript!.content.replace(
        '\ncd /workspace\n',
        '\ncd "$IRONCURTAIN_TEST_WORKSPACE"\n',
      );
      expect(executableScript).not.toBe(startScript!.content);
      // The container-only working-directory step is the sole test-local
      // substitution. The Codex argv remains the exact generated production
      // argv, including its `--cd /workspace` argument.
      writeFileSync(scriptPath, executableScript, { mode: 0o755 });
      writeFileSync(
        fakeCodexPath,
        `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.CAPTURE_FILE, JSON.stringify(process.argv.slice(2)));
`,
        { mode: 0o755 },
      );
      const packagePrompt = adapter.buildSystemPrompt({
        ...sampleContext,
        nestedDocker: { networkName: 'ironcurtain', networkAccess: 'packages' },
      });
      const prompt = [
        packagePrompt,
        'Nested Docker says "quoted".',
        `Do not run: $(touch "${substitutionSentinel}")`,
        `Nor this: \`touch "${backtickSentinel}"\``,
        'Keep literal variables: $HOME and ${PATH}',
      ].join('\n');
      const result = spawnSync('/bin/bash', [scriptPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CAPTURE_FILE: capturedArgsPath,
          IRONCURTAIN_MODEL: '',
          IRONCURTAIN_SYSTEM_PROMPT: prompt,
          IRONCURTAIN_TEST_WORKSPACE: workspaceDir,
          PATH: `${tempDir}:${process.env.PATH ?? ''}`,
        },
        // The full suite intentionally runs several CPU-heavy integration
        // workers in parallel. Give the two short Node launches enough room
        // to be scheduled while still bounding a genuinely stuck wrapper.
        timeout: 20_000,
      });

      expect(
        result.status,
        `${result.stderr}\ncaptured=${existsSync(capturedArgsPath)} error=${result.error?.message ?? 'none'}`,
      ).toBe(0);
      const capturedArgs = JSON.parse(readFileSync(capturedArgsPath, 'utf8')) as string[];
      const configIndex = capturedArgs.indexOf('-c');
      expect(configIndex).toBeGreaterThanOrEqual(0);
      expect(capturedArgs.filter((arg) => arg === '-c')).toHaveLength(1);
      expect(capturedArgs[configIndex + 1]).toBe(`developer_instructions=${JSON.stringify(prompt)}`);
      expect(prompt).toContain('Dockerfile `RUN` steps');
      expect(prompt).toContain('bundle-wide authority');
      expect(existsSync(substitutionSentinel)).toBe(false);
      expect(existsSync(backtickSentinel)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('builds a non-interactive codex exec command with approvals disabled', () => {
    const cmd = adapter.buildCommand('say hi', 'system prompt', {
      sessionId: 'test-session',
      firstTurn: true,
    });

    expect(cmd.slice(0, 6)).toEqual([
      'codex',
      '--ask-for-approval',
      'never',
      '--sandbox',
      'danger-full-access',
      'exec',
    ]);
    expect(cmd).toContain('--json');
    expect(cmd).toContain('--skip-git-repo-check');
    expect(cmd).toContain('--cd');
    expect(cmd).toContain('/workspace');
    expect(cmd.at(-1)).toContain('system prompt');
    expect(cmd.at(-1)).toContain('say hi');
  });

  it('passes modelOverride to Codex without leaking the provider prefix', () => {
    const cmd = adapter.buildCommand('say hi', 'system prompt', {
      sessionId: 'test-session',
      firstTurn: true,
      modelOverride: 'openai:gpt-5.5',
    });

    const idx = cmd.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(cmd[idx + 1]).toBe('gpt-5.5');
  });

  it('builds system prompt with Docker and policy guidance', () => {
    const prompt = adapter.buildSystemPrompt(sampleContext);
    expect(prompt).toContain('help.help');
    expect(prompt).toContain('Your workspace is `/workspace`');
    expect(prompt).toContain('It is backed by the host workspace');
    expect(prompt).not.toContain('Your sandbox directory is:');
    expect(prompt).toContain('no direct internet access');
    expect(prompt).toContain('### Policy');
    expect(prompt).not.toContain('IRONCURTAIN_DOCKER_NETWORK');
  });

  it('includes managed-network guidance only for admitted nested Docker', () => {
    const prompt = adapter.buildSystemPrompt({
      ...sampleContext,
      nestedDocker: { networkName: 'ironcurtain', networkAccess: 'packages' },
    });

    expect(prompt).toContain('### Nested Docker');
    expect(prompt).toContain('--network "$IRONCURTAIN_DOCKER_NETWORK"');
    expect(prompt).toContain('name: ${IRONCURTAIN_DOCKER_NETWORK}');
    expect(prompt).toContain('`docker run --network host`');
    expect(prompt).toContain('supported service topology');
    expect(prompt).toContain('security boundary');
    expect(prompt).toContain('`docker build ...`');
    expect(prompt).toContain('Compose can build implicitly');
    expect(prompt).toContain('`docker compose up --no-build`');
    expect(prompt).toContain('--network=none');
    expect(prompt).toContain('npm, PyPI/pip, Debian apt, and Cargo');
    expect(prompt).toContain('public repository may relay or hairpin');
  });

  it('returns Codex ChatGPT OAuth providers', () => {
    const providers = adapter.getProviders({} as IronCurtainConfig, 'oauth');
    expect(providers.map((p) => p.host)).toEqual(['chatgpt.com', 'auth.openai.com']);
    expect(providers.every((p) => p.keyInjection.type === 'bearer')).toBe(true);
    expect(providers[1].fakeKeyPrefix).toBe(providers[0].fakeKeyPrefix);
    expect(generateFakeKey(providers[0].fakeKeyPrefix)).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
    expect(providers[0].allowedEndpoints).toContainEqual({ method: 'POST', path: '/codex-backend/agent-identity' });
    expect(providers[0].allowedEndpoints).toContainEqual({ method: 'GET', path: '/agent-identities/jwks' });
    // Codex 0.157.1 runs workspace routing discovery before its first ChatGPT-mode turn.
    expect(providers[0].allowedEndpoints).toContainEqual({ method: 'GET', path: '/backend-api/wham/accounts/check' });
  });

  it('builds env with fake Codex auth seeds and no raw provider credential env vars', () => {
    const env = adapter.buildEnv({} as IronCurtainConfig, new Map([['chatgpt.com', 'codex-fake-token']]));

    expect(env.CODEX_HOME).toBe('/home/codespace/.codex');
    expect(env.IRONCURTAIN_CODEX_ACCESS_TOKEN).toBe('codex-fake-token');
    expect(env.IRONCURTAIN_CODEX_ID_TOKEN).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
    expect(env.CODEX_CA_CERTIFICATE).toBe('/etc/ironcurtain/ca-cert.pem');
    expect(env.SSL_CERT_FILE).toBe('/etc/ironcurtain/ca-bundle.pem');
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('extracts the final agent_message from Codex JSONL output', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      JSON.stringify({ type: 'turn.completed' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
    ].join('\n');

    expect(adapter.extractResponse(0, stdout).text).toBe('final answer');
  });

  it('falls back to raw stdout when JSONL has no agent message', () => {
    const stdout = JSON.stringify({ type: 'turn.completed' });
    expect(adapter.extractResponse(0, stdout).text).toBe(stdout);
  });

  it('reports non-zero exits with Codex label', () => {
    const response = adapter.extractResponse(2, 'auth failed', 'stderr details');
    expect(response.text).toContain('Codex exited with code 2');
    expect(response.text).toContain('auth failed');
    expect(response.text).toContain('stderr details');
  });

  it('flags quotaExhausted when a rate-limit error event appears on exit 0', () => {
    // Codex renders an HTTP error as `unexpected status <code> <reason>: <body>`.
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'unexpected status 429 Too Many Requests: Rate limit reached for requests, retry later' },
      }),
    ].join('\n');

    const response = adapter.extractResponse(0, stdout);
    expect(response.quotaExhausted).toBeDefined();
    expect(response.quotaExhausted?.rawMessage).toContain('429');
    expect(response.transientFailure).toBeUndefined();
    // No agent_message present, so the text describes the failure rather
    // than dumping a raw JSONL line.
    expect(response.text).toContain('Codex reported an error');
    expect(response.text).toContain('Rate limit reached');
  });

  it('flags quotaExhausted when stderr reports a 429 on a non-zero exit', () => {
    const response = adapter.extractResponse(1, '', 'HTTP 429 Too Many Requests');
    expect(response.quotaExhausted).toBeDefined();
    expect(response.quotaExhausted?.rawMessage).toContain('429');
    expect(response.text).toContain('Codex exited with code 1');
  });

  it('leaves an unrecognized error item unclassified on exit 0 (degenerate_response keeps its meaning)', () => {
    // Formerly every error-shaped event became a transient degenerate_response,
    // whose documented meaning is an empty completion (exit 0, no output
    // tokens). An unrecognized error is now reported as text, with no signal.
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'upstream connection reset' } }),
    ].join('\n');

    const response = adapter.extractResponse(0, stdout);
    expect(response.quotaExhausted).toBeUndefined();
    expect(response.transientFailure).toBeUndefined();
    expect(response.hardFailure).toBeUndefined();
    expect(response.text).toContain('upstream connection reset');
  });

  it('extracts a valid agent_message even when a malformed JSON line precedes it', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      '{ this is not valid json',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'recovered answer' } }),
    ].join('\n');

    let response: ReturnType<typeof adapter.extractResponse> | undefined;
    expect(() => {
      response = adapter.extractResponse(0, stdout);
    }).not.toThrow();
    expect(response?.text).toBe('recovered answer');
    expect(response?.quotaExhausted).toBeUndefined();
    expect(response?.transientFailure).toBeUndefined();
  });

  it('detects Codex OAuth credentials from CODEX_HOME auth.json', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'codex-adapter-auth-'));
    const oldCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tmp;
      writeFileSync(
        join(tmp, 'auth.json'),
        JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'real-codex-token' } }),
      );

      const result = adapter.detectCredential?.({} as IronCurtainConfig);
      expect(result?.kind).toBe('oauth');
      if (result?.kind !== 'oauth') throw new Error('expected oauth');
      expect(result.credentials.accessToken).toBe('real-codex-token');
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns none when Codex auth.json is absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'codex-adapter-no-auth-'));
    const oldCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tmp;
      expect(adapter.detectCredential?.({} as IronCurtainConfig)?.kind).toBe('none');
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns conversation state config for CODEX_HOME', () => {
    const config = adapter.getConversationStateConfig!();
    expect(config.hostDirName).toBe('codex-state');
    expect(config.containerMountPath).toBe('/home/codespace/.codex/');
    expect(config.seed.map((s) => s.path)).toContain('sessions/');
    // Resumability is decided from rollouts, and a PTY resume goes by thread id.
    expect(config.transcriptLayout).toBe('codex-rollouts');
    expect(config.resumeFlags).toEqual([]);
  });
});

const THREAD_ID = '01a1b67b-5e92-7fb0-aa3e-ebe122186d0b';

/** One `exec --json` JSONL stream. */
function jsonl(...events: readonly unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

describe('CodexAdapter conversation continuity', () => {
  const adapter = createCodexAdapter();

  it('reports the thread from thread.started on success and on failure', () => {
    const success = adapter.extractResponse(
      0,
      jsonl(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
        { type: 'turn.completed' },
      ),
    );
    expect(success).toEqual({ text: 'done', agentThreadId: THREAD_ID });

    const failed = adapter.extractResponse(
      1,
      jsonl({ type: 'thread.started', thread_id: THREAD_ID }, { type: 'turn.failed', error: { message: 'boom' } }),
    );
    expect(failed.agentThreadId).toBe(THREAD_ID);
  });

  it('normalizes the thread id and drops anything that is not a UUID', () => {
    const upper = adapter.extractResponse(
      0,
      jsonl(
        { type: 'thread.started', thread_id: THREAD_ID.toUpperCase() },
        { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
      ),
    );
    expect(upper.agentThreadId).toBe(THREAD_ID);

    for (const bogus of ['--last', '../../etc/passwd', '', 'abc', 42, `${THREAD_ID} --last`]) {
      const response = adapter.extractResponse(
        0,
        jsonl(
          { type: 'thread.started', thread_id: bogus },
          { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
        ),
      );
      expect(response.agentThreadId).toBeUndefined();
    }
  });

  it('starts a new thread on the first turn, with the system prompt', () => {
    // A thread id offered on a first turn is ignored: only a continuing turn resumes.
    const cmd = adapter.buildCommand('say hi', 'system prompt', {
      sessionId: 'conversation-1',
      firstTurn: true,
      agentThreadId: THREAD_ID,
    });
    expect(cmd).not.toContain('resume');
    expect(cmd).not.toContain(THREAD_ID);
    expect(cmd.at(-1)).toContain('system prompt');
    expect(cmd.at(-1)).toContain('say hi');
  });

  it('resumes the recorded thread on a later turn with exec resume <thread> and the message alone', () => {
    const cmd = adapter.buildCommand('-next step', 'system prompt', {
      sessionId: 'conversation-1',
      firstTurn: false,
      agentThreadId: THREAD_ID,
      modelOverride: 'openai:gpt-5.5',
    });
    // Global and exec options precede the subcommand; `--` keeps a message
    // that starts with `-` from being parsed as an option.
    expect(cmd.slice(cmd.indexOf('exec'))).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--cd',
      '/workspace',
      'resume',
      '--',
      THREAD_ID,
      '-next step',
    ]);
    expect(cmd.indexOf('--model')).toBeLessThan(cmd.indexOf('exec'));
    expect(cmd).not.toContain('--last');
    expect(cmd.join('\n')).not.toContain('system prompt');
  });

  it('starts a new thread when a later turn has no valid recorded thread (never --last)', () => {
    for (const agentThreadId of [undefined, '--last', 'not-a-thread']) {
      const cmd = adapter.buildCommand('next step', 'system prompt', {
        sessionId: 'conversation-1',
        firstTurn: false,
        ...(agentThreadId === undefined ? {} : { agentThreadId }),
      });
      expect(cmd).not.toContain('resume');
      expect(cmd).not.toContain('--last');
      expect(cmd.at(-1)).toContain('system prompt');
    }
  });
});

describe('CodexAdapter failure classification', () => {
  const adapter = createCodexAdapter();

  it('does not treat "429", "quota" or "rate limit" in the transcript as quota exhaustion', () => {
    // The agent's own messages and command output are not failure events.
    const stdout = jsonl(
      { type: 'thread.started', thread_id: THREAD_ID },
      {
        type: 'item.completed',
        item: { type: 'command_execution', command: 'ls', aggregated_output: '429 src/x.ts\nquota.ts\n' },
      },
      {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'Fixed the rate limit and quota handling for HTTP 429 Too Many Requests.',
        },
      },
    );
    const response = adapter.extractResponse(137, stdout, '');
    expect(response.quotaExhausted).toBeUndefined();
    expect(response.transientFailure).toBeUndefined();
    expect(response.hardFailure).toBeUndefined();
    expect(response.text).toContain('Codex exited with code 137');
  });

  it('leaves an unrelated crash unclassified', () => {
    const response = adapter.extractResponse(
      101,
      jsonl({ type: 'thread.started', thread_id: THREAD_ID }),
      "thread 'main' panicked at core/src/codex.rs:12:5: index out of bounds",
    );
    expect(response.quotaExhausted).toBeUndefined();
    expect(response.transientFailure).toBeUndefined();
    expect(response.hardFailure).toBeUndefined();
  });

  it('sets hardFailure when Codex wrote nothing to stdout, whatever the exit code', () => {
    const nonZero = adapter.extractResponse(1, '', 'Error: failed to start');
    expect(nonZero.hardFailure).toBe(true);
    expect(nonZero.quotaExhausted).toBeUndefined();
    expect(nonZero.text).toContain('Codex exited with code 1');

    const zero = adapter.extractResponse(0, '  \n', '');
    expect(zero.hardFailure).toBe(true);
    expect(zero.text).toContain('without producing output');
  });

  it('requires an explicit status or code: quota words alone in a failure event are not quota', () => {
    const response = adapter.extractResponse(
      1,
      jsonl(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'turn.failed', error: { message: 'tool call failed: quota.json is not a rate limit config' } },
      ),
    );
    expect(response.quotaExhausted).toBeUndefined();
    expect(response.transientFailure).toBeUndefined();
  });

  it.each([
    [
      'a 400 response naming input[429]',
      `unexpected status 400 Bad Request: {"error":{"message":"Invalid 'input[429].output': string too long.",` +
        `"type":"invalid_request_error","param":"input[429].output","code":"string_above_max_length"}}`,
      '',
    ],
    ['a token count', 'context window exceeded by 429 tokens: please start a new thread', ''],
    [
      'a file named in a stderr log line',
      'tool call failed',
      'ERROR codex_core::mcp: read_file failed: ENOENT 429.txt',
    ],
  ])('does not treat a bare 429 as an HTTP status (%s)', (_label, message, stderr) => {
    // A failure event, and stderr, are classified, but a number is a status
    // only where one is rendered as such ("status 429", "HTTP 429", ...).
    const response = adapter.extractResponse(
      1,
      jsonl({ type: 'thread.started', thread_id: THREAD_ID }, { type: 'turn.failed', error: { message } }),
      stderr,
    );
    expect(response.quotaExhausted).toBeUndefined();
    expect(response.transientFailure).toBeUndefined();
  });

  it.each([
    ['an HTTP 429 status', 'exceeded retry limit, last status: 429 Too Many Requests'],
    ['an unexpected-status 429', 'unexpected status 429: slow down'],
    ['an HTTP 429 from a gateway', 'upstream gateway returned HTTP 429'],
    ['an error code 429', 'Error code: 429 - rate limited'],
    ['a provider quota code', 'error code: insufficient_quota'],
    ["Codex's usage-limit message", "You've hit your usage limit. Try again in 2 hours 13 minutes."],
  ])('flags quotaExhausted from %s in turn.failed', (_label, message) => {
    const response = adapter.extractResponse(
      1,
      jsonl({ type: 'thread.started', thread_id: THREAD_ID }, { type: 'turn.failed', error: { message } }),
    );
    expect(response.quotaExhausted?.rawMessage).toContain(message);
    expect(response.transientFailure).toBeUndefined();
    expect(response.hardFailure).toBeUndefined();
  });

  it('reads explicit status and code fields of a failure event', () => {
    const byStatus = adapter.extractResponse(
      1,
      jsonl({ type: 'turn.failed', error: { message: 'request rejected', http_status_code: 429 } }),
    );
    expect(byStatus.quotaExhausted?.rawMessage).toBe('request rejected');

    const byCode = adapter.extractResponse(
      1,
      jsonl({ type: 'error', message: 'stopped', codex_error_info: 'usage_limit_exceeded' }),
    );
    expect(byCode.quotaExhausted).toBeDefined();

    const by5xx = adapter.extractResponse(
      1,
      jsonl({
        type: 'turn.failed',
        error: {
          message: 'stopped',
          codex_error_info: { response_too_many_failed_attempts: { http_status_code: 503 } },
        },
      }),
    );
    expect(by5xx.transientFailure?.kind).toBe('upstream_5xx');
  });

  it('classifies an explicit 5xx as upstream_5xx and a failed stream as upstream_api_error', () => {
    const fiveXx = adapter.extractResponse(
      1,
      jsonl({ type: 'turn.failed', error: { message: 'unexpected status 500 Internal Server Error: oops' } }),
    );
    expect(fiveXx.transientFailure?.kind).toBe('upstream_5xx');
    expect(fiveXx.quotaExhausted).toBeUndefined();

    const stream = adapter.extractResponse(
      1,
      jsonl({
        type: 'turn.failed',
        error: { message: 'stream disconnected before completion: error decoding response body' },
      }),
    );
    expect(stream.transientFailure?.kind).toBe('upstream_api_error');
  });

  it("decides from the turn's own failure, not from an earlier retry notice", () => {
    const stdout = jsonl(
      { type: 'thread.started', thread_id: THREAD_ID },
      { type: 'error', message: 'Reconnecting... 1/5 (unexpected status 429 Too Many Requests)' },
      { type: 'turn.failed', error: { message: 'context window exceeded: please start a new thread' } },
    );
    const response = adapter.extractResponse(1, stdout);
    expect(response.quotaExhausted).toBeUndefined();
    expect(response.transientFailure).toBeUndefined();
  });

  it('classifies retry notices and stderr when the turn reported no failure of its own', () => {
    const response = adapter.extractResponse(
      1,
      jsonl(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'error', message: 'Reconnecting... 5/5 (stream disconnected before completion: timeout)' },
      ),
    );
    expect(response.transientFailure?.kind).toBe('upstream_api_error');
  });

  it('ignores earlier failure notices once the turn produced its final message', () => {
    const response = adapter.extractResponse(
      0,
      jsonl(
        { type: 'error', message: 'Reconnecting... 1/5 (unexpected status 429 Too Many Requests)' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'all good' } },
      ),
    );
    expect(response).toEqual({ text: 'all good' });
  });
});

/** Runs start-codex.sh against a fake `codex` that records every invocation. */
function runCodexStartScript(
  env: Readonly<Record<string, string>>,
  resumeExitCode = 0,
): { readonly status: number | null; readonly invocations: string[][]; readonly stderr: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-pty-resume-'));
  try {
    const startScript = createCodexAdapter()
      .generateOrientationFiles(sampleContext)
      .find((file) => file.path === 'start-codex.sh');
    if (!startScript) throw new Error('start-codex.sh missing');
    const workspaceDir = join(tempDir, 'workspace');
    mkdirSync(workspaceDir);
    const scriptPath = join(tempDir, 'start-codex.sh');
    writeFileSync(
      scriptPath,
      startScript.content.replace('\ncd /workspace\n', '\ncd "$IRONCURTAIN_TEST_WORKSPACE"\n'),
      { mode: 0o755 },
    );
    const logPath = join(tempDir, 'invocations.jsonl');
    writeFileSync(
      join(tempDir, 'codex'),
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.CAPTURE_FILE, JSON.stringify(args) + '\\n');
process.exit(args.includes('resume') ? Number(process.env.RESUME_EXIT_CODE) : 0);
`,
      { mode: 0o755 },
    );
    const result = spawnSync('/bin/bash', [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAPTURE_FILE: logPath,
        RESUME_EXIT_CODE: String(resumeExitCode),
        IRONCURTAIN_MODEL: '',
        IRONCURTAIN_SYSTEM_PROMPT: 'prompt',
        IRONCURTAIN_TEST_WORKSPACE: workspaceDir,
        PATH: `${tempDir}:${process.env.PATH ?? ''}`,
        ...env,
      },
      timeout: 20_000,
    });
    const invocations = existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as string[])
      : [];
    return { status: result.status, invocations, stderr: result.stderr };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('start-codex.sh resume', () => {
  it('starts a new conversation without a resume id', () => {
    const run = runCodexStartScript({});
    expect(run.status, run.stderr).toBe(0);
    expect(run.invocations).toHaveLength(1);
    expect(run.invocations[0]).not.toContain('resume');
  }, 30_000);

  it('continues the named thread with codex resume <id>', () => {
    const run = runCodexStartScript({ IRONCURTAIN_RESUME_ID: THREAD_ID });
    expect(run.status, run.stderr).toBe(0);
    expect(run.invocations).toHaveLength(1);
    expect(run.invocations[0].slice(-2)).toEqual(['resume', THREAD_ID]);
    expect(run.invocations[0]).not.toContain('--last');
  }, 30_000);

  it('starts fresh when the thread cannot be resumed', () => {
    const run = runCodexStartScript({ IRONCURTAIN_RESUME_ID: THREAD_ID }, 1);
    expect(run.status, run.stderr).toBe(0);
    expect(run.invocations).toHaveLength(2);
    expect(run.invocations[0]).toContain('resume');
    expect(run.invocations[1]).not.toContain('resume');
  }, 30_000);
});
