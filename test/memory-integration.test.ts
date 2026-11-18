/**
 * Integration tests for memory MCP server injection into sessions.
 *
 * Tests that buildSessionConfig() correctly injects (or skips) the
 * memory server based on configuration, and that memory DB paths
 * resolve correctly for persona and cron job sessions.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMemoryDbPath, resolveMemoryModelsDir } from '../src/memory/resolve-memory-path.js';
import {
  MEMORY_SERVER_NAME,
  buildMemoryServerConfig,
  buildMemoryServerCredentials,
  cronMemoryScope,
  verifyMemoryServerConfig,
  workflowMemoryScope,
} from '../src/memory/memory-annotations.js';
import { adaptMemoryToolNames } from '../src/memory/memory-prompt.js';
import { RESERVED_SERVER_NAMES, SESSION_INJECTED_SERVER_NAMES } from '../src/types/reserved-servers.js';
import { userServerNameProblem } from '../src/config/mcp-servers-overlay.js';
import { memoryLlmBaseUrlProblem } from '../src/memory/memory-llm.js';
import { loadUserConfig, userConfigSchema } from '../src/config/user-config.js';
import * as logger from '../src/logger.js';
import { applyServerAllowlist } from '../src/persona/resolve.js';
import type { MCPServerConfig } from '../src/config/types.js';

// A memory server with the review quarantine, whatever this checkout's
// workspace build is: an unattended writer refuses one without it (FU-05,
// test/memory-annotations.test.ts).
vi.mock('../src/memory/memory-server-exports.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/memory/memory-server-exports.js')>()),
  memoryServerHasReviewQuarantine: () => true,
}));

describe('resolveMemoryDbPath', () => {
  it('returns persona-specific path when persona is set', () => {
    const path = resolveMemoryDbPath({ persona: 'exec-assistant' });
    expect(path).toMatch(/personas\/exec-assistant\/memory\.db$/);
  });

  it('returns job-specific path when jobId is set', () => {
    const path = resolveMemoryDbPath({ jobId: 'job-123' });
    expect(path).toMatch(/jobs\/job-123\/memory\.db$/);
  });

  it('prefers persona over jobId when both are set', () => {
    const path = resolveMemoryDbPath({ persona: 'exec-assistant', jobId: 'job-123' });
    expect(path).toMatch(/personas\/exec-assistant\/memory\.db$/);
  });

  it('throws when neither persona nor jobId is set', () => {
    expect(() => resolveMemoryDbPath({})).toThrow('requires either persona or jobId');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildMemoryServerConfig', () => {
  it('builds a valid MCP server config', () => {
    const config = buildMemoryServerConfig({ dbPath: '/tmp/test.db' });
    expect(config.command).toBe('node');
    expect(config.args).toHaveLength(1);
    expect(config.args[0]).toMatch(/memory-mcp-server\/dist\/index\.js$/);
    expect(config.env?.MEMORY_DB_PATH).toBe('/tmp/test.db');
    expect(config.sandbox).toBe(false);
  });

  it('includes namespace in env when provided', () => {
    const config = buildMemoryServerConfig({ dbPath: '/tmp/test.db', namespace: 'my-persona' });
    expect(config.env?.MEMORY_NAMESPACE).toBe('my-persona');
  });

  it('omits namespace from env when not provided', () => {
    const config = buildMemoryServerConfig({ dbPath: '/tmp/test.db' });
    expect(config.env?.MEMORY_NAMESPACE).toBeUndefined();
  });

  it('uses explicit LLM config when provided, with the key as a per-server credential', () => {
    const opts = { dbPath: '/tmp/test.db', llmBaseUrl: 'https://custom.api/v1/', llmApiKey: 'custom-key' };
    const config = buildMemoryServerConfig(opts);
    expect(config.env?.MEMORY_LLM_BASE_URL).toBe('https://custom.api/v1/');
    expect(config.env?.MEMORY_LLM_API_KEY).toBeUndefined();
    expect(buildMemoryServerCredentials(opts)).toEqual({ MEMORY_LLM_API_KEY: 'custom-key' });
  });

  it('does not set LLM env vars or credentials when no keys are provided', () => {
    const config = buildMemoryServerConfig({ dbPath: '/tmp/test.db' });
    expect(config.env?.MEMORY_LLM_BASE_URL).toBeUndefined();
    expect(config.env?.MEMORY_LLM_API_KEY).toBeUndefined();
    expect(buildMemoryServerCredentials({ dbPath: '/tmp/test.db' })).toEqual({});
  });

  it('falls back to Anthropic API key with Anthropic base URL', () => {
    const opts = { dbPath: '/tmp/test.db', anthropicApiKey: 'sk-ant-test' };
    const config = buildMemoryServerConfig(opts);
    expect(buildMemoryServerCredentials(opts)).toEqual({ MEMORY_LLM_API_KEY: 'sk-ant-test' });
    expect(config.env?.MEMORY_LLM_BASE_URL).toBe('https://api.anthropic.com/v1/');
  });

  it('prefers explicit llmApiKey over anthropicApiKey, on the Anthropic endpoint when no URL is set', () => {
    // Without a base URL the OpenAI client would default to api.openai.com,
    // sending the key (meant for the documented Anthropic default) to OpenAI.
    const opts = { dbPath: '/tmp/test.db', llmApiKey: 'custom-key', anthropicApiKey: 'sk-ant-test' };
    expect(buildMemoryServerCredentials(opts)).toEqual({ MEMORY_LLM_API_KEY: 'custom-key' });
    expect(buildMemoryServerConfig(opts).env?.MEMORY_LLM_BASE_URL).toBe('https://api.anthropic.com/v1/');
  });

  it('sends no Anthropic key to a custom llmBaseUrl without llmApiKey', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const opts = { dbPath: '/tmp/test.db', llmBaseUrl: 'https://custom.api/v1/', anthropicApiKey: 'sk-ant-test' };
    expect(buildMemoryServerCredentials(opts)).toEqual({});
    expect(buildMemoryServerConfig(opts).env?.MEMORY_LLM_BASE_URL).toBe('https://custom.api/v1/');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Not sending the Anthropic API key'));
  });

  it('sends no Anthropic key to llmBaseUrl=http://ollama.local without llmApiKey', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const opts = { dbPath: '/tmp/test.db', llmBaseUrl: 'http://ollama.local/v1', anthropicApiKey: 'sk-ant-test' };
    expect(buildMemoryServerCredentials(opts)).toEqual({});
    expect(JSON.stringify(buildMemoryServerConfig(opts))).not.toContain('sk-ant-test');
  });

  it('sends no Anthropic key to a local Ollama either (it needs none)', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const opts = { dbPath: '/tmp/test.db', llmBaseUrl: 'http://localhost:11434/v1', anthropicApiKey: 'sk-ant-test' };
    expect(buildMemoryServerCredentials(opts)).toEqual({});
    expect(buildMemoryServerConfig(opts).env?.MEMORY_LLM_BASE_URL).toBe('http://localhost:11434/v1');
  });

  it('sends the Anthropic key to the explicit Anthropic endpoint', () => {
    const opts = {
      dbPath: '/tmp/test.db',
      llmBaseUrl: 'https://api.anthropic.com/v1/',
      anthropicApiKey: 'sk-ant-test',
    };
    expect(buildMemoryServerCredentials(opts)).toEqual({ MEMORY_LLM_API_KEY: 'sk-ant-test' });
  });

  it('derives the default endpoint from the Anthropic base URL (a LiteLLM gateway)', () => {
    const opts = {
      dbPath: '/tmp/test.db',
      anthropicApiKey: 'litellm-virtual-key',
      anthropicBaseUrl: 'http://127.0.0.1:4000',
    };
    expect(buildMemoryServerConfig(opts).env?.MEMORY_LLM_BASE_URL).toBe('http://127.0.0.1:4000/v1/');
    expect(buildMemoryServerCredentials(opts)).toEqual({ MEMORY_LLM_API_KEY: 'litellm-virtual-key' });
    // An explicit /v1 root is kept, as for the agent's own Anthropic client.
    expect(
      buildMemoryServerConfig({ ...opts, anthropicBaseUrl: 'https://gateway.example/anthropic/v1/' }).env
        ?.MEMORY_LLM_BASE_URL,
    ).toBe('https://gateway.example/anthropic/v1/');
  });

  it('sends the gateway key to a memory URL on the gateway origin, and nowhere else', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const gateway = {
      dbPath: '/tmp/test.db',
      anthropicApiKey: 'litellm-virtual-key',
      anthropicBaseUrl: 'http://127.0.0.1:4000',
    };
    expect(buildMemoryServerCredentials({ ...gateway, llmBaseUrl: 'http://127.0.0.1:4000/v1/' })).toEqual({
      MEMORY_LLM_API_KEY: 'litellm-virtual-key',
    });
    // The key belongs to the gateway: not even api.anthropic.com gets it.
    expect(buildMemoryServerCredentials({ ...gateway, llmBaseUrl: 'https://api.anthropic.com/v1/' })).toEqual({});
    expect(buildMemoryServerCredentials({ ...gateway, llmBaseUrl: 'http://127.0.0.1:4001/v1/' })).toEqual({});
  });

  it('refuses to send any key over plain http to another machine', () => {
    expect(() =>
      buildMemoryServerCredentials({
        dbPath: '/tmp/test.db',
        llmBaseUrl: 'http://ollama.lan:11434/v1',
        llmApiKey: 'k',
      }),
    ).toThrow('Refusing to send the memory LLM API key');
  });

  it('tells the memory server which kind of session writes, its id and its review scope', () => {
    const env = buildMemoryServerConfig({
      dbPath: '/tmp/test.db',
      writer: { kind: 'cron', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', scope: 'job:daily-report' },
    }).env;
    expect(env?.MEMORY_WRITER_KIND).toBe('cron');
    expect(env?.MEMORY_SESSION_ID).toBe('0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(env?.MEMORY_WRITER_SCOPE).toBe('job:daily-report');
    expect(buildMemoryServerConfig({ dbPath: '/tmp/test.db' }).env?.MEMORY_WRITER_KIND).toBeUndefined();
    const interactive = buildMemoryServerConfig({
      dbPath: '/tmp/test.db',
      writer: { kind: 'interactive', sessionId: 'session-1' },
    }).env;
    expect(interactive?.MEMORY_WRITER_SCOPE).toBeUndefined();
    expect(() =>
      buildMemoryServerConfig({ dbPath: '/tmp/test.db', writer: { kind: 'interactive', sessionId: 'has space' } }),
    ).toThrow('session id');
  });

  // What an unattended run writes waits for review under its scope (the memory
  // server's quarantine), so such a writer without a scope is a host bug, and an
  // interactive writer (whose writes need no review) never has one.
  it('refuses an unattended writer without a review scope, and an interactive one with a scope', () => {
    expect(() =>
      buildMemoryServerConfig({ dbPath: '/tmp/test.db', writer: { kind: 'cron', sessionId: 'run-1' } }),
    ).toThrow('review scope');
    expect(() =>
      buildMemoryServerConfig({
        dbPath: '/tmp/test.db',
        writer: { kind: 'workflow', sessionId: 'run-1', scope: 'workflow:has space' },
      }),
    ).toThrow('review scope');
    expect(() =>
      buildMemoryServerConfig({
        dbPath: '/tmp/test.db',
        writer: { kind: 'interactive', sessionId: 'run-1', scope: 'job:x' },
      }),
    ).toThrow('no review scope');
    expect(cronMemoryScope('daily-report')).toBe('job:daily-report');
    expect(workflowMemoryScope('wf_1')).toBe('workflow:wf_1');
  });

  it('never serializes an LLM key with the server config', () => {
    // The config is written into MCP_SERVERS_CONFIG and session metadata;
    // the key travels only through SERVER_CREDENTIALS to the memory relay.
    const serialized = JSON.stringify(
      buildMemoryServerConfig({
        dbPath: '/tmp/test.db',
        llmApiKey: 'custom-key-value',
        anthropicApiKey: 'sk-ant-test-value',
      }),
    );
    expect(serialized).not.toContain('custom-key-value');
    expect(serialized).not.toContain('sk-ant-test-value');
  });
});

// The memory server keeps its models in IronCurtain's home, never inside
// node_modules (where a root-owned global install cannot write and an upgrade
// wipes them), and downloads only pinned, hash-verified files (WP-95).
describe('memory server model store', () => {
  const savedHome = process.env.IRONCURTAIN_HOME;
  let home: string | undefined;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  it('caches the models under ~/.ironcurtain/models', () => {
    delete process.env.IRONCURTAIN_HOME;
    expect(resolveMemoryModelsDir()).toBe(join(homedir(), '.ironcurtain', 'models'));
    expect(buildMemoryServerConfig({ dbPath: '/tmp/test.db' }).env?.MEMORY_MODELS_DIR).toBe(
      join(homedir(), '.ironcurtain', 'models'),
    );
  });

  it('follows IRONCURTAIN_HOME, outside the installation', () => {
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-models-home-'));
    process.env.IRONCURTAIN_HOME = home;
    const modelsDir = buildMemoryServerConfig({ dbPath: '/tmp/test.db' }).env?.MEMORY_MODELS_DIR;
    expect(modelsDir).toBe(join(home, 'models'));
    expect(modelsDir).not.toContain('node_modules');
  });

  it('turns model downloads off only when memory.offlineModels is set', () => {
    expect(buildMemoryServerConfig({ dbPath: '/tmp/test.db' }).env?.MEMORY_MODELS_OFFLINE).toBeUndefined();
    expect(
      buildMemoryServerConfig({ dbPath: '/tmp/test.db', offlineModels: false }).env?.MEMORY_MODELS_OFFLINE,
    ).toBeUndefined();
    expect(buildMemoryServerConfig({ dbPath: '/tmp/test.db', offlineModels: true }).env?.MEMORY_MODELS_OFFLINE).toBe(
      'true',
    );
  });

  it('keeps the trusted-server shape (the store is configured through env only)', () => {
    const servers: Record<string, MCPServerConfig> = {
      memory: buildMemoryServerConfig({ dbPath: '/tmp/test.db', offlineModels: true }),
    };
    expect(verifyMemoryServerConfig(servers)).toBe(true);
  });

  it('reads memory.offlineModels from config.json (default off)', () => {
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-models-config-'));
    process.env.IRONCURTAIN_HOME = home;
    expect(loadUserConfig({ readOnly: true }).memory.offlineModels).toBe(false);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ memory: { offlineModels: true } }));
    expect(loadUserConfig({ readOnly: true }).memory.offlineModels).toBe(true);
    expect(userConfigSchema.safeParse({ memory: { offlineModels: 'yes' } }).success).toBe(false);
  });
});

describe('MEMORY_SERVER_NAME', () => {
  it('is the string "memory"', () => {
    expect(MEMORY_SERVER_NAME).toBe('memory');
  });
});

describe('verifyMemoryServerConfig', () => {
  it('returns true for config produced by buildMemoryServerConfig', () => {
    const servers: Record<string, MCPServerConfig> = {
      memory: buildMemoryServerConfig({ dbPath: '/tmp/test.db' }),
    };
    expect(verifyMemoryServerConfig(servers)).toBe(true);
  });

  it('returns false when no memory server is configured', () => {
    const servers: Record<string, MCPServerConfig> = {
      filesystem: { command: 'node', args: ['/tmp'] },
    };
    expect(verifyMemoryServerConfig(servers)).toBe(false);
  });

  it('throws when memory server has extra args (preload injection)', () => {
    const servers: Record<string, MCPServerConfig> = {
      memory: { command: 'node', args: ['-r', 'evil.js', buildMemoryServerConfig({ dbPath: '/tmp/test.db' }).args[0]] },
    };
    expect(() => verifyMemoryServerConfig(servers)).toThrow('unexpected config');
  });

  it('throws when memory server has wrong command', () => {
    const servers: Record<string, MCPServerConfig> = {
      memory: { command: 'npx', args: [buildMemoryServerConfig({ dbPath: '/tmp/test.db' }).args[0]] },
    };
    expect(() => verifyMemoryServerConfig(servers)).toThrow('unexpected config');
  });

  it('throws when memory server has wrong entry point', () => {
    const servers: Record<string, MCPServerConfig> = {
      memory: { command: 'node', args: ['/path/to/evil.js'] },
    };
    expect(() => verifyMemoryServerConfig(servers)).toThrow('unexpected config');
  });

  it('throws when memory server args contain entry but also other args', () => {
    const servers: Record<string, MCPServerConfig> = {
      memory: { command: 'node', args: ['--inspect', buildMemoryServerConfig({ dbPath: '/tmp/test.db' }).args[0]] },
    };
    expect(() => verifyMemoryServerConfig(servers)).toThrow('unexpected config');
  });
});

describe('applyServerAllowlist always includes filesystem', () => {
  const servers: Record<string, MCPServerConfig> = {
    filesystem: { command: 'node', args: ['/tmp'] },
    memory: { command: 'node', args: ['mem.js'] },
    github: { command: 'docker', args: ['run'] },
  };

  it('includes filesystem even when allowlist does not mention it', () => {
    const filtered = applyServerAllowlist(servers, ['github']);
    expect(filtered).toHaveProperty('filesystem');
    expect(filtered).toHaveProperty('github');
  });

  it('does NOT include memory when allowlist omits it (memory is opt-in via the bolt-on)', () => {
    const filtered = applyServerAllowlist(servers, ['github']);
    expect(filtered).not.toHaveProperty('memory');
  });

  it('includes memory only when explicitly listed in the allowlist', () => {
    const filtered = applyServerAllowlist(servers, ['memory']);
    expect(filtered).toHaveProperty('memory');
  });
});

describe('memory.llmBaseUrl transport', () => {
  it.each([
    'https://openrouter.ai/api/v1',
    'http://localhost:11434/v1',
    'http://127.0.0.1:4000',
    'http://[::1]:8080/v1',
  ])('accepts %s', (url) => {
    expect(memoryLlmBaseUrlProblem(url)).toBeUndefined();
    expect(userConfigSchema.safeParse({ memory: { llmBaseUrl: url } }).success).toBe(true);
  });

  it.each([
    'http://ollama.local/v1',
    'http://192.168.1.10:11434/v1',
    'http://lan-host:11434/v1',
    'ftp://example.com/v1',
  ])('rejects %s in the user config', (url) => {
    const result = userConfigSchema.safeParse({ memory: { llmBaseUrl: url } });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('memory.llmBaseUrl must');
  });
});

describe('memory tool names in prompts', () => {
  // Builtin and Docker agents alike call the memory tools through Code Mode.
  it('rewrites every memory tool, ingest and expand included, to its Code Mode name', () => {
    const prompt =
      'Call `memory_context`, then `memory_store` or `memory_ingest`; `memory_recall`, ' +
      '`memory_expand`, `memory_forget` and `memory_inspect` as needed.';
    expect(adaptMemoryToolNames(prompt)).toBe(
      'Call `memory.context`, then `memory.store` or `memory.ingest`; `memory.recall`, ' +
        '`memory.expand`, `memory.forget` and `memory.inspect` as needed.',
    );
  });
});

describe('the memory server name', () => {
  // IronCurtain adds its own memory server: a user server under that name would be
  // overwritten in memory sessions, or stop sessions as "tampered" once policy names it.
  // The mcp-servers.json loader (config/mcp-servers-overlay.ts) refuses it in either
  // file; see test/mcp-servers-overlay.test.ts for the files themselves.
  it('is rejected in mcp-servers.json with a clear message', () => {
    expect(userServerNameProblem(MEMORY_SERVER_NAME)).toMatch(/reserved for the memory server/);
    expect(userServerNameProblem('proxy')).toMatch(/reserved for IronCurtain's internal tools/);
    expect(userServerNameProblem('notes')).toBeUndefined();
  });

  // The virtual-server set means "no backend to spawn" (policy-roots strips it); the
  // memory server is a real one and must stay out of it.
  it('is a session-injected name, not a virtual (reserved) one', () => {
    expect(SESSION_INJECTED_SERVER_NAMES.has(MEMORY_SERVER_NAME)).toBe(true);
    expect(RESERVED_SERVER_NAMES.has(MEMORY_SERVER_NAME)).toBe(false);
  });
});
