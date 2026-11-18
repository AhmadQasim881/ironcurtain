import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { PINNED_MODELS } from '../src/models/manifest.js';
import { fakeModel } from './helpers/fake-models.js';

describe('loadConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = loadConfig({});
    expect(config.namespace).toBe('default');
    expect(config.embeddingModel).toBe('Xenova/bge-base-en-v1.5');
    expect(config.embeddingDtype).toBe('q8');
    expect(config.llmBaseUrl).toBeNull();
    expect(config.llmApiKey).toBeNull();
    expect(config.llmModel).toBe('claude-haiku-4-5-20251001');
    expect(config.decayThreshold).toBe(0.05);
    expect(config.maintenanceInterval).toBe(50);
    expect(config.compactionMinGroup).toBe(10);
    expect(config.defaultTokenBudget).toBe(800);
    expect(config.dbPath).toContain('memory-mcp');
  });

  it('reads env vars', () => {
    const config = loadConfig({
      MEMORY_DB_PATH: '/tmp/test.db',
      MEMORY_NAMESPACE: 'project-x',
      MEMORY_LLM_API_KEY: 'sk-test',
      MEMORY_LLM_BASE_URL: 'http://localhost:11434/v1',
      MEMORY_LLM_MODEL: 'llama3',
      MEMORY_DECAY_THRESHOLD: '0.1',
      MEMORY_MAINTENANCE_INTERVAL: '100',
      MEMORY_DEFAULT_TOKEN_BUDGET: '1000',
    });

    expect(config.dbPath).toBe('/tmp/test.db');
    expect(config.namespace).toBe('project-x');
    expect(config.llmApiKey).toBe('sk-test');
    expect(config.llmBaseUrl).toBe('http://localhost:11434/v1');
    expect(config.llmModel).toBe('llama3');
    expect(config.decayThreshold).toBe(0.1);
    expect(config.maintenanceInterval).toBe(100);
    expect(config.defaultTokenBudget).toBe(1000);
  });

  it('bounds LLM time and spend by default, and reads the bounds from the environment', () => {
    const defaults = loadConfig({});
    expect(defaults.llmTimeoutMs).toBe(60_000);
    expect(defaults.llmFormatTimeoutMs).toBe(20_000);
    expect(defaults.llmMaxCalls).toBe(500);
    expect(defaults.llmMaxTokens).toBe(1_000_000);

    const configured = loadConfig({
      MEMORY_LLM_TIMEOUT_MS: '5000',
      MEMORY_LLM_FORMAT_TIMEOUT_MS: '2000',
      MEMORY_LLM_MAX_CALLS: '10',
      MEMORY_LLM_MAX_TOKENS: '20000',
    });
    expect(configured.llmTimeoutMs).toBe(5000);
    expect(configured.llmFormatTimeoutMs).toBe(2000);
    expect(configured.llmMaxCalls).toBe(10);
    expect(configured.llmMaxTokens).toBe(20000);
  });

  it('refuses a bound that is not a positive whole number instead of dropping it', () => {
    for (const value of ['0', '-1', '1.5', 'many', 'Infinity']) {
      expect(() => loadConfig({ MEMORY_LLM_MAX_CALLS: value })).toThrow(/MEMORY_LLM_MAX_CALLS must be a positive/);
    }
    expect(() => loadConfig({ MEMORY_LLM_TIMEOUT_MS: '0' })).toThrow(/MEMORY_LLM_TIMEOUT_MS/);
  });

  it('refuses an LLM deadline too long for a timer, which would fire at once and end every call', () => {
    // Past ~24.8 days Node.js fires a timer immediately (TimeoutOverflowWarning).
    expect(() => loadConfig({ MEMORY_LLM_TIMEOUT_MS: '3000000000' })).toThrow(
      'MEMORY_LLM_TIMEOUT_MS must be a positive whole number of at most 86400000',
    );
    expect(() => loadConfig({ MEMORY_LLM_FORMAT_TIMEOUT_MS: '86400001' })).toThrow(/MEMORY_LLM_FORMAT_TIMEOUT_MS/);
    expect(loadConfig({ MEMORY_LLM_TIMEOUT_MS: '86400000' }).llmTimeoutMs).toBe(86_400_000);
  });

  it('derives the vector size from the embedding model, unless MEMORY_EMBEDDING_DIMENSIONS sets it', () => {
    expect(loadConfig({}).embeddingDimensions).toBe(768);
    expect(loadConfig({ MEMORY_EMBEDDING_MODEL: 'Xenova/bge-small-en-v1.5' }).embeddingDimensions).toBe(384);
    expect(loadConfig({ MEMORY_EMBEDDING_MODEL: 'someone/unknown-model' }).embeddingDimensions).toBe(768);
    expect(
      loadConfig({ MEMORY_EMBEDDING_MODEL: 'someone/unknown-model', MEMORY_EMBEDDING_DIMENSIONS: '1024' })
        .embeddingDimensions,
    ).toBe(1024);
  });
});

describe('loadConfig model store settings', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('keeps models outside node_modules, online, with the built-in pins by default', () => {
    const config = loadConfig({});
    expect(config.modelsDir).toBe(join(homedir(), '.cache', 'memory-mcp', 'models'));
    expect(config.modelsOffline).toBe(false);
    expect(config.modelManifest).toBe(PINNED_MODELS);
    expect(loadConfig({ XDG_CACHE_HOME: '/var/cache/u' }).modelsDir).toBe('/var/cache/u/memory-mcp/models');
  });

  it('takes the models directory and offline mode from the environment', () => {
    const config = loadConfig({ MEMORY_MODELS_DIR: '/home/u/.ironcurtain/models', MEMORY_MODELS_OFFLINE: 'true' });
    expect(config.modelsDir).toBe('/home/u/.ironcurtain/models');
    expect(config.modelsOffline).toBe(true);
    expect(loadConfig({ MEMORY_MODELS_OFFLINE: '0' }).modelsOffline).toBe(false);
  });

  it('refuses ambiguous settings rather than guessing', () => {
    expect(() => loadConfig({ MEMORY_MODELS_DIR: 'models' })).toThrow('MEMORY_MODELS_DIR must be an absolute path');
    expect(() => loadConfig({ MEMORY_MODELS_OFFLINE: 'yes' })).toThrow('MEMORY_MODELS_OFFLINE must be true or false');
    expect(() => loadConfig({ MEMORY_MODEL_MANIFEST: 'manifest.json' })).toThrow(/must be an absolute path/);
    expect(() => loadConfig({ MEMORY_MODEL_MANIFEST: '/nonexistent/manifest.json' })).toThrow(
      /Cannot read the model manifest/,
    );
  });

  it('merges a manifest file over the built-in pins', () => {
    dir = mkdtempSync(join(tmpdir(), 'memory-config-manifest-'));
    const custom = fakeModel('Test/custom-model');
    const path = join(dir, 'manifest.json');
    writeFileSync(path, JSON.stringify({ models: [custom.pin] }));

    const config = loadConfig({ MEMORY_MODEL_MANIFEST: path });

    expect(config.modelManifest).toEqual([...PINNED_MODELS, custom.pin]);
  });

  it('stops on a manifest that is not a list of complete pins', () => {
    dir = mkdtempSync(join(tmpdir(), 'memory-config-manifest-'));
    const path = join(dir, 'manifest.json');
    writeFileSync(path, JSON.stringify({ models: [{ ...fakeModel().pin, revision: 'main' }] }));

    expect(() => loadConfig({ MEMORY_MODEL_MANIFEST: path })).toThrow(
      /Invalid model manifest .*40-character commit SHA/,
    );
  });
});
