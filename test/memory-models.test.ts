/**
 * IronCurtain's side of the memory server's model store (WP-95):
 * - src/memory/memory-models.ts runs the bundled server's models tool and
 *   reads its report (here against a stand-in script);
 * - `ironcurtain memory prefetch` (src/memory/memory-command.ts);
 * - development installs never run onnxruntime-node's install script.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  memoryModelsEnv,
  parseMemoryModelsReport,
  runMemoryModelsTool,
  type MemoryModelsReport,
  type MemoryModelsResult,
  type MemoryModelsRunner,
} from '../src/memory/memory-models.js';
import { runMemoryCommand } from '../src/memory/memory-command.js';
import { memoryServerHasModelStore } from '../src/memory/memory-annotations.js';
import { getTrustedSpawnCwd } from '../src/trusted-process/spawn-cwd.js';

// The models tool is the bundled memory server's entry point; a stand-in
// script takes its place, and is a memory server with the model store unless
// a test says otherwise.
vi.mock('../src/memory/memory-annotations.js', async (importOriginal) => {
  const { fileURLToPath } = await import('node:url');
  return {
    ...(await importOriginal<typeof import('../src/memory/memory-annotations.js')>()),
    MEMORY_SERVER_ENTRY: fileURLToPath(new URL('./fixtures/fake-memory-models-tool.mjs', import.meta.url)),
    memoryServerHasModelStore: vi.fn(() => true),
  };
});

interface Probe {
  argv: string[];
  cwd: string;
  anthropicKey: string | null;
  httpsProxy: string | null;
}

function probeOf(result: MemoryModelsResult): Probe {
  if (result.kind !== 'report') throw new Error(`expected a report, got: ${result.reason}`);
  return JSON.parse(result.report.models[0].detail ?? '{}') as Probe;
}

describe('runMemoryModelsTool', () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, proxy: process.env.HTTPS_PROXY };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-reach-the-models-tool';
    process.env.HTTPS_PROXY = 'http://proxy.example:3128';
  });

  afterEach(() => {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.proxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = saved.proxy;
  });

  it('runs --verify-models from the package directory with the allowlisted environment', async () => {
    const result = await runMemoryModelsTool('verify', { modelsDir: '/home/u/.ironcurtain/models' });

    expect(result).toMatchObject({
      kind: 'report',
      exitCode: 0,
      report: { action: 'verify', modelsDir: '/home/u/.ironcurtain/models', models: [{ status: 'ok' }] },
    });
    const probe = probeOf(result);
    expect(probe.argv).toEqual(['--verify-models']);
    expect(probe.cwd).toBe(getTrustedSpawnCwd());
    // Proxies reach the download; credentials never do.
    expect(probe.httpsProxy).toBe('http://proxy.example:3128');
    expect(probe.anthropicKey).toBeNull();
  });

  it('runs --prefetch-models for a prefetch', async () => {
    const result = await runMemoryModelsTool('prefetch', { modelsDir: '/tmp/store/models' });
    expect(probeOf(result).argv).toEqual(['--prefetch-models']);
    expect(result).toMatchObject({ report: { action: 'prefetch' } });
  });

  it('returns the report and the exit status of a failed check', async () => {
    await expect(runMemoryModelsTool('verify', { modelsDir: '/tmp/store/missing' })).resolves.toMatchObject({
      kind: 'report',
      exitCode: 1,
      report: { models: [{ status: 'missing' }] },
    });
  });

  it('says why when the server prints no report', async () => {
    await expect(runMemoryModelsTool('verify', { modelsDir: '/tmp/store/no-report' })).resolves.toEqual({
      kind: 'failed',
      reason: 'the memory server printed no model report (exit status 3): fatal: something broke',
    });
  });

  it('does not start a memory server that predates the model store', async () => {
    vi.mocked(memoryServerHasModelStore).mockReturnValueOnce(false);
    await expect(runMemoryModelsTool('verify', { modelsDir: '/tmp/store/hang' })).resolves.toEqual({
      kind: 'failed',
      reason: expect.stringContaining('predates pinned, verified models'),
    });
  });

  it('stops a server that does not finish', async () => {
    await expect(
      runMemoryModelsTool('verify', { modelsDir: '/tmp/store/hang', timeoutMs: 300 }),
    ).resolves.toMatchObject({ kind: 'failed', reason: expect.stringContaining('did not finish within') });
  });
});

describe('memoryModelsEnv / parseMemoryModelsReport', () => {
  it('passes the allowlist and the store location, nothing else', () => {
    const env = memoryModelsEnv('/models', {
      HOME: '/home/u',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      MEMORY_MODELS_OFFLINE: 'true',
      MEMORY_MODEL_MANIFEST: '/tmp/evil.json',
    });
    expect(env).toEqual({ HOME: '/home/u', PATH: '/usr/bin', MEMORY_MODELS_DIR: '/models' });
  });

  it('takes the last line that is a report and ignores everything else', () => {
    const report: MemoryModelsReport = { action: 'verify', modelsDir: '/m', offline: false, models: [] };
    expect(parseMemoryModelsReport(`progress\n{"not":"a report"}\n${JSON.stringify(report)}\n\n`)).toEqual(report);
    expect(parseMemoryModelsReport('{"action":"verify","modelsDir":"/m","offline":false,"models":[{}]}')).toBe(
      undefined,
    );
    expect(parseMemoryModelsReport('')).toBeUndefined();
  });
});

describe('ironcurtain memory prefetch', () => {
  function capture(run: MemoryModelsRunner): {
    exec: (argv: string[]) => Promise<number>;
    out: string[];
    err: string[];
  } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      exec: (argv) => runMemoryCommand(argv, { run, write: (t) => out.push(t), writeError: (t) => err.push(t) }),
      out,
      err,
    };
  }

  const report = (models: MemoryModelsReport['models']): MemoryModelsResult => ({
    kind: 'report',
    report: { action: 'prefetch', modelsDir: '/home/u/.ironcurtain/models', offline: false, models },
    exitCode: models.every((m) => m.status === 'ok' || m.status === 'downloaded') ? 0 : 1,
  });

  it('downloads through the bundled server and lists what it verified', async () => {
    const run = vi.fn<MemoryModelsRunner>(async () =>
      report([
        { role: 'embedding', repo: 'Xenova/bge-base-en-v1.5', dtype: 'q8', status: 'downloaded' },
        { role: 'reranker', repo: 'Xenova/ms-marco-MiniLM-L-6-v2', dtype: 'q8', status: 'ok' },
      ]),
    );
    const { exec, out } = capture(run);

    await expect(exec(['prefetch'])).resolves.toBe(0);

    expect(run).toHaveBeenCalledWith('prefetch', { showProgress: true });
    expect(out.join('')).toBe(
      'Memory models in /home/u/.ironcurtain/models:\n' +
        '  ok      embedding model Xenova/bge-base-en-v1.5 (q8): downloaded and verified\n' +
        '  ok      reranker model Xenova/ms-marco-MiniLM-L-6-v2 (q8): already installed and verified\n',
    );
  });

  it('fails when a model could not be installed, and shows why without terminal escapes', async () => {
    const run: MemoryModelsRunner = async () =>
      report([
        {
          role: 'embedding',
          repo: 'Xenova/bge-base-en-v1.5',
          dtype: 'q8',
          status: 'error',
          detail: 'Could not download config.json: HTTP 503\u001b[2J',
        },
      ]);
    const { exec, out } = capture(run);

    await expect(exec(['prefetch'])).resolves.toBe(1);
    const text = out.join('');
    expect(text).toContain('FAILED  embedding model Xenova/bge-base-en-v1.5 (q8) (error): Could not download');
    expect(text).not.toContain('\u001b');
  });

  it('fails when the server could not run', async () => {
    const { exec, err } = capture(async () => ({ kind: 'failed', reason: 'could not run the memory server: ENOENT' }));
    await expect(exec(['prefetch'])).resolves.toBe(1);
    expect(err.join('')).toContain('Could not prefetch the memory models: could not run the memory server: ENOENT');
  });

  it.each([[[]], [['prefetch', 'extra']], [['download']], [['--bogus']]])(
    'rejects the usage %j with exit status 2',
    async (argv) => {
      const run = vi.fn<MemoryModelsRunner>();
      const { exec, err } = capture(run);
      await expect(exec(argv)).resolves.toBe(2);
      expect(err.join('')).toContain('ironcurtain memory prefetch');
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('prints help', async () => {
    const { exec, out } = capture(vi.fn<MemoryModelsRunner>());
    await expect(exec(['--help'])).resolves.toBe(0);
    expect(out.join('')).toContain('Download the pinned memory models into ~/.ironcurtain/models');
  });
});

describe('development installs', () => {
  // onnxruntime-node's postinstall downloads the CUDA execution providers
  // (about 270 MB on linux-x64) from NuGet; the memory server runs on the CPU
  // binaries the package already bundles. npm >= 11.19 skips the scripts of a
  // dependency denied in the root allowScripts.
  it('deny onnxruntime-node its install script', () => {
    const manifest = JSON.parse(readFileSync(resolve(join(import.meta.dirname, '..', 'package.json')), 'utf8')) as {
      allowScripts?: Record<string, boolean>;
    };
    expect(manifest.allowScripts?.['onnxruntime-node']).toBe(false);
  });
});
