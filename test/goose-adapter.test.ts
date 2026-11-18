import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createGooseAdapter,
  escapeHeredoc,
  extractAssistantText,
  stripAnsi,
  getProviderConfig,
} from '../src/docker/adapters/goose.js';
import { CONTAINER_WORKSPACE_DIR, type OrientationContext } from '../src/docker/agent-adapter.js';
import type { ServerListing } from '../src/types/server-listing.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { USER_CONFIG_DEFAULTS, type ResolvedUserConfig } from '../src/config/user-config.js';
import { testUserConfig } from './helpers/user-config.js';

// ─── Test Fixtures ───────────────────────────────────────────

const sampleServerListings: ServerListing[] = [{ name: 'filesystem', description: 'Read, write, and manage files' }];

const sampleContext: OrientationContext = {
  workspaceDir: CONTAINER_WORKSPACE_DIR,
  serverListings: sampleServerListings,
  allowedDomains: ['example.com'],
  networkMode: 'none',
};

function makeUserConfig(overrides: Partial<ResolvedUserConfig> = {}): ResolvedUserConfig {
  return testUserConfig({
    anthropicApiKey: 'sk-test-anthropic',
    googleApiKey: 'AIzaSy-test-google',
    openaiApiKey: 'sk-test-openai',
    autoCompact: {
      enabled: true,
      thresholdTokens: 160_000,
      keepRecentMessages: 10,
      summaryModelId: 'anthropic:claude-haiku-4-5',
    },
    ...overrides,
  });
}

/** A per-session config carrying `userConfig` (adapters read Goose settings from it on every call). */
function sessionConfig(overrides: Partial<ResolvedUserConfig> = {}): IronCurtainConfig {
  return { userConfig: makeUserConfig(overrides) } as unknown as IronCurtainConfig;
}

// ─── Adapter Creation ────────────────────────────────────────

describe('createGooseAdapter', () => {
  it('creates adapter with default config when no userConfig provided', () => {
    const adapter = createGooseAdapter();
    expect(adapter.id).toBe('goose');
    expect(adapter.displayName).toBe('Goose');
  });

  it('takes no configuration: provider and model are read per session', () => {
    expect(createGooseAdapter.length).toBe(0);
  });
});

// ─── getImage ────────────────────────────────────────────────

describe('GooseAdapter.getImage', () => {
  it('returns the expected image name', async () => {
    const adapter = createGooseAdapter();
    const image = await adapter.getImage();
    expect(image).toBe('ironcurtain-goose:latest');
  });
});

// ─── generateMcpConfig ──────────────────────────────────────

describe('GooseAdapter.generateMcpConfig', () => {
  const adapter = createGooseAdapter();

  it('generates YAML config with UNIX-CONNECT for UDS path', () => {
    const files = adapter.generateMcpConfig('/run/ironcurtain/proxy.sock', {} as IronCurtainConfig);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('goose-config.yaml');
    expect(files[0].content).toContain('UNIX-CONNECT:/run/ironcurtain/proxy.sock');
    expect(files[0].content).toContain('extensions:');
    expect(files[0].content).toContain('ironcurtain:');
    expect(files[0].content).toContain('type: stdio');
    expect(files[0].content).toContain('cmd: socat');
    expect(files[0].content).toContain('timeout: 600');
  });

  it('generates YAML config with TCP for host:port address', () => {
    const files = adapter.generateMcpConfig('host.docker.internal:12345', {} as IronCurtainConfig);

    expect(files).toHaveLength(1);
    expect(files[0].content).toContain('cmd: node');
    expect(files[0].content).toContain('"/usr/local/bin/ironcurtain-mcp-bridge.mjs"');
    expect(files[0].content).toContain('"host.docker.internal:12345"');
    expect(files[0].content).not.toContain('env_keys:');
    expect(files[0].content).not.toContain('UNIX-CONNECT');
  });

  it('produces valid YAML structure with telemetry disabled', () => {
    const files = adapter.generateMcpConfig('/run/ironcurtain/proxy.sock', {} as IronCurtainConfig);
    const content = files[0].content;

    // Verify the YAML contains the required keys
    expect(content).toContain('name: IronCurtain Sandbox');
    expect(content).toContain('enabled: true');
    expect(content).toContain('- STDIO');
    expect(content).toContain('GOOSE_TELEMETRY_ENABLED: false');
  });
});

// ─── generateOrientationFiles ────────────────────────────────

describe('GooseAdapter.generateOrientationFiles', () => {
  const adapter = createGooseAdapter();

  it('returns 3 executable scripts', () => {
    const files = adapter.generateOrientationFiles(sampleContext);

    expect(files).toHaveLength(3);
    expect(files.map((f) => f.path)).toEqual(['start-goose.sh', 'resize-pty.sh', 'check-pty-size.sh']);
  });

  it('all scripts have executable mode', () => {
    const files = adapter.generateOrientationFiles(sampleContext);

    for (const file of files) {
      expect(file.mode).toBe(0o755);
    }
  });

  it('scripts reference goose process, not claude', () => {
    const files = adapter.generateOrientationFiles(sampleContext);

    for (const file of files) {
      expect(file.content).toContain('goose');
      expect(file.content).not.toContain('claude');
    }
  });

  it('start script uses goose run -s with instructions file', () => {
    const files = adapter.generateOrientationFiles(sampleContext);
    const startScript = files.find((f) => f.path === 'start-goose.sh')!;
    expect(startScript.content).toContain('goose run -s');
    expect(startScript.content).toContain('-i "$PROMPT_FILE"');
    expect(startScript.content).toContain('IRONCURTAIN_SYSTEM_PROMPT');
    expect(startScript.content).toContain('IRONCURTAIN_SESSION_NAME');
  });

  it('resize script targets goose process', () => {
    const files = adapter.generateOrientationFiles(sampleContext);
    const resizeScript = files.find((f) => f.path === 'resize-pty.sh')!;
    expect(resizeScript.content).toContain('pgrep -x goose');
    expect(resizeScript.content).toContain('WINCH');
  });
});

// ─── buildCommand ────────────────────────────────────────────

describe('GooseAdapter.buildCommand', () => {
  const adapter = createGooseAdapter();

  it('returns a shell command with goose run --quiet --output-format json in a named session', () => {
    const cmd = adapter.buildCommand('Fix the bug', 'You are sandboxed', {
      sessionId: 'test-session',
      firstTurn: true,
    });

    expect(cmd[0]).toBe('/bin/sh');
    expect(cmd[1]).toBe('-c');
    expect(cmd[2]).toContain('goose run --quiet --output-format json -i "$PROMPT_FILE" "$@"');
    // Sessions are kept now: the conversation continues across turns.
    expect(cmd[2]).not.toContain('--no-session');
    // The session arguments are positional parameters, never script text.
    expect(cmd.slice(3)).toEqual(['ironcurtain-goose', '--name', 'test-session']);
    expect(cmd[2]).not.toContain('test-session');
  });

  it('creates the named session on the first turn with the system prompt', () => {
    const cmd = adapter.buildCommand('Fix the bug', 'You are sandboxed', {
      sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      firstTurn: true,
    });
    expect(cmd.slice(3)).toEqual(['ironcurtain-goose', '--name', '0f8fad5b-d9cb-469f-a165-70867728950e']);
    expect(cmd[2]).toContain('You are sandboxed');
    expect(cmd[2]).toContain('User request:\nFix the bug');
  });

  it('resumes the named session on later turns and sends the message alone', () => {
    const cmd = adapter.buildCommand('Now add tests', 'You are sandboxed', {
      sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      firstTurn: false,
    });
    expect(cmd.slice(3)).toEqual(['ironcurtain-goose', '--name', '0f8fad5b-d9cb-469f-a165-70867728950e', '--resume']);
    expect(cmd[2]).toContain('Now add tests');
    expect(cmd[2]).not.toContain('You are sandboxed');
  });

  it('refuses a session name that could be read as an option or a path', () => {
    for (const sessionId of ['--resume', '-x', '../escape', 'a/b', '', '.hidden']) {
      expect(() => adapter.buildCommand('m', 'p', { sessionId, firstTurn: true })).toThrow(
        /Invalid Goose session name/,
      );
    }
  });

  it('includes -i flag for instructions file', () => {
    const cmd = adapter.buildCommand('Fix the bug', 'You are sandboxed', {
      sessionId: 'test-session',
      firstTurn: true,
    });
    expect(cmd[2]).toContain('-i "$PROMPT_FILE"');
  });

  it('includes system prompt in instructions', () => {
    const cmd = adapter.buildCommand('Fix the bug', 'You are sandboxed', {
      sessionId: 'test-session',
      firstTurn: true,
    });
    expect(cmd[2]).toContain('You are sandboxed');
    expect(cmd[2]).toContain('Fix the bug');
  });

  it('uses IRONCURTAIN_EOF delimiter for heredoc', () => {
    const cmd = adapter.buildCommand('hello', 'prompt', { sessionId: 'test-session', firstTurn: true });
    expect(cmd[2]).toContain('IRONCURTAIN_EOF');
  });

  it('escapes heredoc delimiter when input contains IRONCURTAIN_EOF', () => {
    const cmd = adapter.buildCommand('IRONCURTAIN_EOF', 'system prompt', {
      sessionId: 'test-session',
      firstTurn: true,
    });
    // The delimiter should have a suffix to avoid collision
    const shellCmd = cmd[2];
    // The default delimiter should not appear without a suffix
    // because the input contains it
    const matches = shellCmd.match(/IRONCURTAIN_EOF_[a-f0-9]{8}/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThan(0);
  });
});

// ─── buildSystemPrompt ───────────────────────────────────────

describe('GooseAdapter.buildSystemPrompt', () => {
  const adapter = createGooseAdapter();

  it('contains only the container-visible workspace path', () => {
    const prompt = adapter.buildSystemPrompt(sampleContext);
    expect(prompt).toContain('Your workspace is `/workspace`');
    expect(prompt).toContain('It is backed by the host workspace');
    expect(prompt).not.toContain('Your sandbox directory is:');
  });

  it('contains MCP tool guidance', () => {
    const prompt = adapter.buildSystemPrompt(sampleContext);
    expect(prompt).toContain('IronCurtain MCP');
  });

  it('does NOT mention execute_code', () => {
    const prompt = adapter.buildSystemPrompt(sampleContext);
    // The Docker environment section should not reference execute_code
    // (Code Mode prompt may contain it, but the Docker section should not)
    const dockerSection = prompt.split('## Docker Environment')[1] ?? '';
    expect(dockerSection).not.toContain('execute_code');
  });

  it('contains policy enforcement explanation', () => {
    const prompt = adapter.buildSystemPrompt(sampleContext);
    expect(prompt).toContain('### Policy');
    expect(prompt).toContain('denied');
    expect(prompt).toContain('escalated');
  });

  it('contains direct internet access warning', () => {
    const prompt = adapter.buildSystemPrompt(sampleContext);
    expect(prompt).toContain('no direct internet access');
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
    expect(prompt).toContain('Dockerfile `FROM` and image pulls');
    expect(prompt).toContain('Dockerfile `RUN` steps');
    expect(prompt).toContain('`docker compose build`');
    expect(prompt).toContain('cooperative per-build offline opt-out');
    expect(prompt).toContain('bundle-wide authority');
  });
});

// ─── getProviders ────────────────────────────────────────────

describe('GooseAdapter.getProviders', () => {
  const adapter = createGooseAdapter();

  it('returns anthropicProvider when gooseProvider is anthropic', () => {
    const providers = adapter.getProviders(sessionConfig({ gooseProvider: 'anthropic' }));
    expect(providers).toHaveLength(1);
    expect(providers[0].host).toBe('api.anthropic.com');
  });

  it('returns openaiProvider when gooseProvider is openai', () => {
    const providers = adapter.getProviders(sessionConfig({ gooseProvider: 'openai' }));
    expect(providers).toHaveLength(1);
    expect(providers[0].host).toBe('api.openai.com');
  });

  it('returns googleProvider when gooseProvider is google', () => {
    const providers = adapter.getProviders(sessionConfig({ gooseProvider: 'google' }));
    expect(providers).toHaveLength(1);
    expect(providers[0].host).toBe('generativelanguage.googleapis.com');
  });

  it('falls back to the anthropic provider for a config without Goose settings', () => {
    expect(adapter.getProviders({} as IronCurtainConfig)[0].host).toBe('api.anthropic.com');
  });

  it('returns exactly one provider', () => {
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      const providers = adapter.getProviders(sessionConfig({ gooseProvider: provider }));
      expect(providers).toHaveLength(1);
    }
  });

  it('ignores authKind parameter', () => {
    const config = sessionConfig({ gooseProvider: 'openai' });
    const providersApiKey = adapter.getProviders(config, 'apikey');
    const providersOAuth = adapter.getProviders(config, 'oauth');
    expect(providersApiKey).toEqual(providersOAuth);
  });
});

// ─── buildEnv ────────────────────────────────────────────────

describe('GooseAdapter.buildEnv', () => {
  const config = { userConfig: { anthropicApiKey: 'sk-test' } } as IronCurtainConfig;

  it('sets GOOSE_PROVIDER matching config', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.openai.com', 'sk-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(sessionConfig({ gooseProvider: 'openai' }), fakeKeys);
    expect(env.GOOSE_PROVIDER).toBe('openai');
  });

  it('sets GOOSE_MODEL matching config', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(sessionConfig({ gooseModel: 'gpt-4o' }), fakeKeys);
    expect(env.GOOSE_MODEL).toBe('gpt-4o');
  });

  it('follows each session config, not the one seen first', () => {
    // One adapter instance serves every session of a daemon process.
    const adapter = createGooseAdapter();
    const first = adapter.buildEnv(
      sessionConfig({ gooseProvider: 'anthropic', gooseModel: 'claude-sonnet-4-20250514' }),
      new Map([['api.anthropic.com', 'sk-ant-FAKE']]),
    );
    const edited = adapter.buildEnv(
      sessionConfig({ gooseProvider: 'openai', gooseModel: 'gpt-4o' }),
      new Map([['api.openai.com', 'sk-FAKE']]),
    );
    expect(first).toMatchObject({ GOOSE_PROVIDER: 'anthropic', GOOSE_MODEL: 'claude-sonnet-4-20250514' });
    expect(edited).toMatchObject({ GOOSE_PROVIDER: 'openai', GOOSE_MODEL: 'gpt-4o', OPENAI_API_KEY: 'sk-FAKE' });
    expect(edited).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('sets GOOSE_MODE=auto', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(config, fakeKeys);
    expect(env.GOOSE_MODE).toBe('auto');
  });

  it('sets GOOSE_MAX_TURNS to the shipped step budget when the config carries none', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(config, fakeKeys);
    expect(env.GOOSE_MAX_TURNS).toBe('200');
  });

  it('derives GOOSE_MAX_TURNS from resourceBudget.maxSteps and omits it when steps are unlimited', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const withSteps = (maxSteps: number | null) =>
      ({
        userConfig: { ...config.userConfig, resourceBudget: { ...USER_CONFIG_DEFAULTS.resourceBudget, maxSteps } },
      }) as IronCurtainConfig;

    expect(adapter.buildEnv(withSteps(25), fakeKeys).GOOSE_MAX_TURNS).toBe('25');
    expect(adapter.buildEnv(withSteps(null), fakeKeys)).not.toHaveProperty('GOOSE_MAX_TURNS');
  });

  it('sets SSL_CERT_FILE and SSL_CERT_DIR', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(config, fakeKeys);
    expect(env.SSL_CERT_FILE).toBe('/etc/ironcurtain/ca-bundle.pem');
    expect(env.SSL_CERT_DIR).toBe('/etc/ssl/certs');
  });

  it('does NOT set NODE_EXTRA_CA_CERTS', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(config, fakeKeys);
    expect(env).not.toHaveProperty('NODE_EXTRA_CA_CERTS');
  });

  it('sets ANTHROPIC_API_KEY for anthropic provider', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(sessionConfig({ gooseProvider: 'anthropic' }), fakeKeys);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-ironcurtain-FAKE');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('GOOGLE_API_KEY');
  });

  it('sets OPENAI_API_KEY for openai provider', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.openai.com', 'sk-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(sessionConfig({ gooseProvider: 'openai' }), fakeKeys);
    expect(env.OPENAI_API_KEY).toBe('sk-ironcurtain-FAKE');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('sets GOOGLE_API_KEY for google provider', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['generativelanguage.googleapis.com', 'AIzaSy-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(sessionConfig({ gooseProvider: 'google' }), fakeKeys);
    expect(env.GOOGLE_API_KEY).toBe('AIzaSy-ironcurtain-FAKE');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('throws when fake key is missing for the provider', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.anthropic.com', 'wrong-host-key']]);
    expect(() => adapter.buildEnv(sessionConfig({ gooseProvider: 'openai' }), fakeKeys)).toThrow(
      'No fake key generated for api.openai.com',
    );
  });
});

// ─── detectCredential ────────────────────────────────────────

describe('GooseAdapter.detectCredential', () => {
  const adapter = createGooseAdapter();

  it('returns apikey when anthropicApiKey is present for anthropic provider', () => {
    const config = sessionConfig({ gooseProvider: 'anthropic', anthropicApiKey: 'sk-test' });
    const result = adapter.detectCredential!(config);
    expect(result?.kind).toBe('apikey');
  });

  it('returns none when anthropicApiKey is absent for anthropic provider', () => {
    const config = sessionConfig({ gooseProvider: 'anthropic', anthropicApiKey: '' });
    const result = adapter.detectCredential!(config);
    expect(result?.kind).toBe('none');
  });

  it('checks openaiApiKey when gooseProvider is openai', () => {
    const configWithKey = sessionConfig({ gooseProvider: 'openai', openaiApiKey: 'sk-test', anthropicApiKey: '' });
    expect(adapter.detectCredential!(configWithKey)?.kind).toBe('apikey');

    const configWithout = sessionConfig({ gooseProvider: 'openai', openaiApiKey: '' });
    expect(adapter.detectCredential!(configWithout)?.kind).toBe('none');
  });

  it('checks googleApiKey when gooseProvider is google', () => {
    const configWithKey = sessionConfig({ gooseProvider: 'google', googleApiKey: 'AIzaSy-test', anthropicApiKey: '' });
    expect(adapter.detectCredential!(configWithKey)?.kind).toBe('apikey');

    const configWithout = sessionConfig({ gooseProvider: 'google', googleApiKey: '' });
    expect(adapter.detectCredential!(configWithout)?.kind).toBe('none');
  });
});

// ─── extractResponse ─────────────────────────────────────────

describe('GooseAdapter.extractResponse', () => {
  it('refuses oversized ordinary output rather than returning a partial response', () => {
    expect(() => createGooseAdapter().extractResponse(0, 'x'.repeat(4 * 1024 * 1024 + 1))).toThrow(
      'Agent response output exceeds',
    );
  });

  const adapter = createGooseAdapter();

  it('returns error message with output on non-zero exit code', () => {
    const response = adapter.extractResponse(1, 'error output');
    expect(response.text).toContain('Goose exited with code 1');
    expect(response.text).toContain('error output');
    expect(response.costUsd).toBeUndefined();
  });

  it('returns clean text for simple output', () => {
    const response = adapter.extractResponse(0, 'The answer is 4.\n');
    expect(response.text).toBe('The answer is 4.');
  });

  it('strips ANSI codes', () => {
    const response = adapter.extractResponse(0, '\x1b[32mGreen text\x1b[0m\n');
    expect(response.text).toBe('Green text');
    expect(response.text).not.toContain('\x1b');
  });

  it('returns empty string for empty stdout', () => {
    const response = adapter.extractResponse(0, '');
    expect(response.text).toBe('');
  });

  it('costUsd is always undefined (Goose does not report cost)', () => {
    const response = adapter.extractResponse(0, 'output');
    expect(response.costUsd).toBeUndefined();
  });

  it('falls back to raw stripped output when stdout is not the JSON envelope', () => {
    // Defensive path: if Goose ever changes its envelope shape, we degrade
    // to "noisy but functional" rather than dropping content.
    const response = adapter.extractResponse(0, 'just plain text\n');
    expect(response.text).toBe('just plain text');
  });
});

// ─── Helper: extractAssistantText (Goose JSON envelope parser) ───────

describe('extractAssistantText', () => {
  /** Builds a minimally-shaped Goose JSON envelope. */
  function envelope(messages: unknown[]): string {
    return JSON.stringify({ messages });
  }

  it('returns the assistant text from a single assistant message', () => {
    const stdout = envelope([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there.' }] },
    ]);
    expect(extractAssistantText(stdout)).toBe('Hi there.');
  });

  it('preserves a multi-paragraph response (memory-dump regression)', () => {
    // The user-reported bug: a memory dump with headers, bullets, and a
    // trailing question used to collapse to just the question. With JSON
    // mode every paragraph survives because we read structured text, not
    // line-block heuristics.
    const body = [
      'I have several things stored about you:',
      '',
      'Upcoming & Important:',
      '    * GitHub Documentary filming — April 22, 2026',
      '    * Ryan Lowther (FBM) — follow up to close out the engagement',
      '',
      'People & Projects:',
      '    * George Ogawa — 7th-dan Kendo teacher',
      '',
      'Is there anything you would like to update?',
    ].join('\n');
    const stdout = envelope([{ role: 'assistant', content: [{ type: 'text', text: body }] }]);

    const out = extractAssistantText(stdout);
    expect(out).toContain('I have several things stored about you:');
    expect(out).toContain('Upcoming & Important:');
    expect(out).toContain('George Ogawa');
    expect(out).toContain('Is there anything you would like to update?');
  });

  it('concatenates assistant text across multiple turns separated by tool calls', () => {
    // Real shape when the model narrates, calls a tool, then narrates more.
    // Tool-use entries and tool-result messages must drop out cleanly.
    const stdout = envelope([
      { role: 'user', content: [{ type: 'text', text: 'what do you remember?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll check my persistent memory first." },
          { type: 'tool_use', name: 'memory_context', arguments: {} },
        ],
      },
      { role: 'tool', content: [{ type: 'tool_result', text: '<memory data>' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: "Here's a summary of what I remember." }],
      },
    ]);

    const out = extractAssistantText(stdout);
    expect(out).toBe("I'll check my persistent memory first.\n\nHere's a summary of what I remember.");
    expect(out).not.toContain('memory_context');
    expect(out).not.toContain('tool_result');
  });

  it('returns null on malformed JSON so caller can fall back to raw text', () => {
    expect(extractAssistantText('not json')).toBeNull();
    expect(extractAssistantText('')).toBeNull();
    expect(extractAssistantText('{')).toBeNull();
  });

  it('returns null when the envelope is missing a messages array', () => {
    expect(extractAssistantText(JSON.stringify({}))).toBeNull();
    expect(extractAssistantText(JSON.stringify({ messages: 'not-an-array' }))).toBeNull();
  });

  it('returns null when there is no assistant text (e.g. only tool_use entries)', () => {
    const stdout = envelope([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'memory_context', arguments: {} }] },
    ]);
    expect(extractAssistantText(stdout)).toBeNull();
  });

  it('skips assistant messages that are missing or have non-array content', () => {
    const stdout = envelope([
      { role: 'assistant' }, // no content key at all
      { role: 'assistant', content: 'string-not-array' },
      { role: 'assistant', content: [{ type: 'text', text: 'survivor' }] },
    ]);
    expect(extractAssistantText(stdout)).toBe('survivor');
  });

  it("returns only this turn's reply when a resumed session lists the whole conversation", () => {
    const stdout = envelope([
      { role: 'user', content: [{ type: 'text', text: 'first request' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'second request' }] },
      { role: 'assistant', content: [{ type: 'toolRequest', id: 't1' }] },
      // Tool results come back in a user-role message without a text item.
      { role: 'user', content: [{ type: 'toolResponse', id: 't1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'second reply' }] },
    ]);
    expect(extractAssistantText(stdout)).toBe('second reply');
  });

  it('parses an envelope that follows a line of CLI output', () => {
    const stdout = `resuming session 0f8fad5b\n${JSON.stringify(
      { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'after chrome' }] }] },
      null,
      2,
    )}`;
    expect(extractAssistantText(stdout)).toBe('after chrome');
  });
});

// ─── Conversation state (named sessions) ─────────────────────

describe('GooseAdapter.getConversationStateConfig', () => {
  it("mounts Goose's session store and resumes through it", () => {
    const config = createGooseAdapter().getConversationStateConfig!();
    expect(config.hostDirName).toBe('goose-state');
    expect(config.containerMountPath).toBe('/home/codespace/.local/share/goose/sessions/');
    expect(config.transcriptLayout).toBe('goose-sessions');
    expect(config.resumeFlags).toEqual(['--resume']);
    expect(config.seed).toEqual([]);
  });

  it('does not nest the state mount and the skills mount', () => {
    const adapter = createGooseAdapter();
    const statePath = adapter.getConversationStateConfig!().containerMountPath;
    const skillsPath = adapter.skills!.containerPath;
    expect(skillsPath.startsWith(statePath)).toBe(false);
    expect(statePath.startsWith(skillsPath)).toBe(false);
  });
});

/**
 * Runs start-goose.sh against a fake `goose` that records every invocation.
 *
 * The script writes its prompt file with `mktemp /tmp/goose-prompt-XXXXXX.md`
 * and then execs goose, so its EXIT trap never removes the file: in the
 * container, /tmp goes away with the container. Run on the host, it would stay
 * in the host's /tmp, so the fake goose removes the `-i` file it is handed.
 */
function runGooseStartScript(
  env: Readonly<Record<string, string>>,
  resumeExitCode = 0,
): { readonly status: number | null; readonly invocations: string[][]; readonly stderr: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'goose-pty-resume-'));
  try {
    const startScript = createGooseAdapter()
      .generateOrientationFiles(sampleContext)
      .find((file) => file.path === 'start-goose.sh');
    if (!startScript) throw new Error('start-goose.sh missing');
    const scriptPath = join(tempDir, 'start-goose.sh');
    writeFileSync(scriptPath, startScript.content, { mode: 0o755 });
    const logPath = join(tempDir, 'invocations.jsonl');
    writeFileSync(
      join(tempDir, 'goose'),
      `#!/usr/bin/env node
const { appendFileSync, rmSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.CAPTURE_FILE, JSON.stringify(args) + '\\n');
const instructions = args.indexOf('-i');
if (instructions !== -1 && instructions + 1 < args.length) rmSync(args[instructions + 1], { force: true });
process.exit(args[0] === 'session' ? Number(process.env.RESUME_EXIT_CODE) : 0);
`,
      { mode: 0o755 },
    );
    const result = spawnSync('/bin/bash', [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAPTURE_FILE: logPath,
        RESUME_EXIT_CODE: String(resumeExitCode),
        IRONCURTAIN_SYSTEM_PROMPT: 'prompt',
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

const SESSION_NAME = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('start-goose.sh named sessions', () => {
  it('creates the session named by the host on a fresh start', () => {
    const run = runGooseStartScript({ IRONCURTAIN_SESSION_NAME: SESSION_NAME });
    expect(run.status, run.stderr).toBe(0);
    expect(run.invocations).toHaveLength(1);
    expect(run.invocations[0].slice(0, 4)).toEqual(['run', '-s', '--name', SESSION_NAME]);
    expect(run.invocations[0]).toContain('-i');
    // The run leaves no prompt file behind in the host's /tmp.
    const promptFile = run.invocations[0][run.invocations[0].indexOf('-i') + 1];
    expect(promptFile).toBeTruthy();
    expect(existsSync(promptFile)).toBe(false);
  }, 30_000);

  it('resumes the named session interactively on resume', () => {
    const run = runGooseStartScript({ IRONCURTAIN_SESSION_NAME: SESSION_NAME, IRONCURTAIN_RESUME_FLAGS: '--resume' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.invocations).toEqual([['session', '--name', SESSION_NAME, '--resume']]);
  }, 30_000);

  it('starts the named session fresh when it cannot be resumed', () => {
    const run = runGooseStartScript(
      { IRONCURTAIN_SESSION_NAME: SESSION_NAME, IRONCURTAIN_RESUME_FLAGS: '--resume' },
      1,
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.invocations).toHaveLength(2);
    expect(run.invocations[0][0]).toBe('session');
    expect(run.invocations[1].slice(0, 4)).toEqual(['run', '-s', '--name', SESSION_NAME]);
  }, 30_000);

  it('runs an unnamed session when the host supplies no name', () => {
    const run = runGooseStartScript({ IRONCURTAIN_RESUME_FLAGS: '--resume' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.invocations).toHaveLength(1);
    expect(run.invocations[0].slice(0, 2)).toEqual(['run', '-s']);
    expect(run.invocations[0]).not.toContain('--name');
  }, 30_000);
});

// ─── buildPtyCommand ─────────────────────────────────────────

describe('GooseAdapter.buildPtyCommand', () => {
  const adapter = createGooseAdapter();

  it('builds UDS PTY command', () => {
    const cmd = adapter.buildPtyCommand!('system prompt', '/tmp/pty.sock', undefined);
    expect(cmd).toContain('socat');
    expect(cmd.join(' ')).toContain('UNIX-LISTEN:/tmp/pty.sock,fork');
    expect(cmd.join(' ')).toContain('start-goose.sh');
  });

  it('builds TCP PTY command', () => {
    const cmd = adapter.buildPtyCommand!('system prompt', undefined, 54321);
    expect(cmd.join(' ')).toContain('TCP-LISTEN:54321,reuseaddr');
    expect(cmd.join(' ')).toContain('start-goose.sh');
  });

  it('does NOT reference start-claude.sh', () => {
    const cmd = adapter.buildPtyCommand!('prompt', '/tmp/pty.sock', undefined);
    expect(cmd.join(' ')).not.toContain('start-claude.sh');
  });
});

// ─── credentialHelpText ──────────────────────────────────────

describe('GooseAdapter.credentialHelpText', () => {
  it("mentions the session's configured provider", () => {
    const adapter = createGooseAdapter();
    expect(adapter.credentialHelpText!(sessionConfig({ gooseProvider: 'openai' }))).toContain('"openai"');
    expect(adapter.credentialHelpText!(sessionConfig({ gooseProvider: 'google' }))).toContain('"google"');
  });

  it.each([
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['google', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  ] as const)('names the host credential for %s', (gooseProvider, envName) => {
    const adapter = createGooseAdapter();
    const text = adapter.credentialHelpText!(sessionConfig({ gooseProvider }));
    expect(text).toContain(`Set ${envName}`);
  });
});

// ─── Helper: getProviderConfig ───────────────────────────────

describe('getProviderConfig', () => {
  it('maps anthropic to api.anthropic.com', () => {
    expect(getProviderConfig('anthropic').host).toBe('api.anthropic.com');
  });

  it('maps openai to api.openai.com', () => {
    expect(getProviderConfig('openai').host).toBe('api.openai.com');
  });

  it('maps google to generativelanguage.googleapis.com', () => {
    expect(getProviderConfig('google').host).toBe('generativelanguage.googleapis.com');
  });
});

// ─── Helper: stripAnsi ──────────────────────────────────────

describe('stripAnsi', () => {
  it('handles tiny incomplete control strings and ST-terminated formatting', () => {
    expect(stripAnsi('before \x1b]unfinished')).toBe('before unfinished');
    expect(stripAnsi('\x1b]title\x1b\\text')).toBe('text');
  });

  it('strips CSI escape sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text');
  });

  it('handles text without ANSI codes', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('strips multiple escape sequences', () => {
    expect(stripAnsi('\x1b[1m\x1b[32mbold green\x1b[0m normal')).toBe('bold green normal');
  });
});

// ─── Helper: escapeHeredoc ──────────────────────────────────

describe('escapeHeredoc', () => {
  it('returns default delimiter when no collision', () => {
    const { delimiter } = escapeHeredoc('hello world');
    expect(delimiter).toBe('IRONCURTAIN_EOF');
  });

  it('returns unique delimiter when input contains IRONCURTAIN_EOF', () => {
    const { delimiter } = escapeHeredoc('some text IRONCURTAIN_EOF more text');
    expect(delimiter).not.toBe('IRONCURTAIN_EOF');
    expect(delimiter).toMatch(/^IRONCURTAIN_EOF_[a-f0-9]{8}$/);
  });

  it('returns delimiter not found in input', () => {
    const input = 'IRONCURTAIN_EOF is in here';
    const { delimiter } = escapeHeredoc(input);
    expect(input).not.toContain(delimiter);
  });

  it('handles input that is exactly the delimiter', () => {
    const { delimiter } = escapeHeredoc('IRONCURTAIN_EOF');
    expect(delimiter).not.toBe('IRONCURTAIN_EOF');
  });

  it('handles empty input', () => {
    const { delimiter } = escapeHeredoc('');
    expect(delimiter).toBe('IRONCURTAIN_EOF');
  });
});
