/**
 * `memory-mcp-server --verify-models` / `--prefetch-models` (src/models/cli.ts):
 * the JSON report IronCurtain's doctor and `memory prefetch` read, and the
 * exit status.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runModelsCli, type ModelsReport } from '../src/models/cli.js';
import { PINNED_MODELS, isUnverifiedPin } from '../src/models/manifest.js';
import { fakeHub, fakeModel, installFakeModel, writeManifest, type FakeModel } from './helpers/fake-models.js';

// Stand-ins pinned under the default model names, so the CLI's configured models resolve to them.
const embedding = fakeModel('Xenova/bge-base-en-v1.5');
const reranker = fakeModel('Xenova/ms-marco-MiniLM-L-6-v2');

interface Run {
  code: number;
  report: ModelsReport | undefined;
  stdout: string;
  stderr: string[];
}

describe('memory-mcp-server models CLI', () => {
  let root: string;
  let modelsDir: string;
  let manifestPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-models-cli-'));
    modelsDir = join(root, 'models');
    manifestPath = join(root, 'manifest.json');
    writeManifest(manifestPath, [embedding, reranker]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function run(
    argv: string[],
    env: Record<string, string> = {},
    models: readonly FakeModel[] = [embedding, reranker],
  ): Promise<Run & { requests: string[] }> {
    const hub = fakeHub(models);
    let stdout = '';
    const stderr: string[] = [];
    const code = await runModelsCli(argv, {
      env: { MEMORY_MODELS_DIR: modelsDir, MEMORY_MODEL_MANIFEST: manifestPath, ...env },
      stdout: async (text) => {
        stdout += text;
      },
      stderr: (line) => stderr.push(line),
      fetchImpl: hub.fetch,
    });
    let report: ModelsReport | undefined;
    try {
      report = JSON.parse(stdout) as ModelsReport;
    } catch {
      report = undefined;
    }
    return { code, report, stdout, stderr, requests: hub.requests };
  }

  it('--verify-models reports every configured model verified and exits 0', async () => {
    installFakeModel(modelsDir, embedding);
    installFakeModel(modelsDir, reranker);

    const { code, report, requests } = await run(['--verify-models']);

    expect(code).toBe(0);
    expect(report).toMatchObject({
      action: 'verify',
      modelsDir,
      offline: false,
      models: [
        {
          role: 'embedding',
          repo: 'Xenova/bge-base-en-v1.5',
          dtype: 'q8',
          status: 'ok',
          revision: embedding.pin.revision,
        },
        { role: 'reranker', repo: 'Xenova/ms-marco-MiniLM-L-6-v2', dtype: 'q8', status: 'ok' },
      ],
    });
    expect(requests).toEqual([]);
  });

  it('--verify-models reports a tampered file as invalid and exits 1', async () => {
    const dir = installFakeModel(modelsDir, embedding);
    installFakeModel(modelsDir, reranker);
    writeFileSync(join(dir, 'config.json'), '{"model_type":"tampered!"}');

    const { code, report, stderr } = await run(['--verify-models']);

    expect(code).toBe(1);
    expect(report?.models[0]).toMatchObject({
      role: 'embedding',
      status: 'invalid',
      detail: expect.stringContaining('config.json'),
    });
    expect(report?.models[1]).toMatchObject({ role: 'reranker', status: 'ok' });
    expect(stderr.join('\n')).toContain('INVALID: embedding model Xenova/bge-base-en-v1.5 (q8)');
  });

  it('--verify-models reports missing models without downloading them', async () => {
    const { code, report, requests } = await run(['--verify-models']);

    expect(code).toBe(1);
    expect(report?.models.map((model) => model.status)).toEqual(['missing', 'missing']);
    expect(report?.models[0].detail).toContain('missing: config.json, onnx/model_quantized.onnx');
    expect(requests).toEqual([]);
    // Verifying writes nothing, not even the models directory: `ironcurtain
    // doctor` runs it against ~/.ironcurtain/models and must leave the home
    // untouched.
    expect(existsSync(modelsDir)).toBe(false);
  });

  it('--prefetch-models downloads and verifies the pinned files, also in offline mode', async () => {
    const { code, report, requests } = await run(['--prefetch-models'], { MEMORY_MODELS_OFFLINE: 'true' });

    expect(code).toBe(0);
    expect(report).toMatchObject({ action: 'prefetch', offline: true });
    expect(report?.models.map((model) => model.status)).toEqual(['downloaded', 'downloaded']);
    expect(requests).toHaveLength(4);
    expect(
      readFileSync(join(modelsDir, 'Xenova/bge-base-en-v1.5', embedding.pin.revision, 'config.json'), 'utf-8'),
    ).toBe(embedding.contents.get('config.json')?.toString());

    // A second run finds everything in place.
    const again = await run(['--prefetch-models']);
    expect(again.report?.models.map((model) => model.status)).toEqual(['ok', 'ok']);
    expect(again.requests).toEqual([]);
  });

  it('checks only the embedding model when re-ranking is off', async () => {
    installFakeModel(modelsDir, embedding);

    const { code, report } = await run(['--verify-models'], { MEMORY_RERANKER_ENABLED: 'false' });

    expect(code).toBe(0);
    expect(report?.models.map((model) => model.role)).toEqual(['embedding']);
  });

  it('reports the built-in pins as unpinned while they are placeholders', async () => {
    const { code, report, requests } = await run(['--prefetch-models'], { MEMORY_MODEL_MANIFEST: '' });

    const expected = PINNED_MODELS.map((pin) => (isUnverifiedPin(pin) ? 'unpinned' : expect.any(String)));
    expect(report?.models.map((model) => model.status)).toEqual(expected);
    if (PINNED_MODELS.every(isUnverifiedPin)) {
      expect(code).toBe(1);
      expect(report?.models[0].detail).toContain('has not been pinned yet');
      expect(requests).toEqual([]);
    }
  });

  it('refuses unknown arguments with usage and exit status 2', async () => {
    const { code, stdout, stderr } = await run(['--prefetch-model']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr.join('\n')).toContain('unknown arguments: --prefetch-model');
    expect(stderr.join('\n')).toContain('--prefetch-models');
  });

  it('prints usage for --help', async () => {
    const { code, stdout } = await run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('--verify-models');
    // The database commands the same binary runs (cli.ts, WP-94).
    expect(stdout).toContain('memory-mcp-server restore <copy>');
  });

  it('reports a configuration error instead of a report', async () => {
    const { code, stdout, stderr } = await run(['--verify-models'], { MEMORY_MODELS_DIR: 'relative/models' });
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr.join('\n')).toContain('MEMORY_MODELS_DIR must be an absolute path');
  });
});

describe('package contract', () => {
  // IronCurtain tells a memory server with the model store from an older one
  // (which would ignore --verify-models and start serving MCP instead) by
  // whether `@provos/memory-mcp-server/models` resolves.
  it('exports the models CLI module as ./models', () => {
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports['./models']).toBe('./dist/models/cli.js');
    expect(existsSync(join(packageRoot, 'src', 'models', 'cli.ts'))).toBe(true);
  });
});
