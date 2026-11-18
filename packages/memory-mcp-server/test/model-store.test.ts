/**
 * The verified model store (src/models/): pins, downloads, verification, and
 * the transformers.js settings that keep it the only way models get loaded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PINNED_MODELS,
  UNVERIFIED_PIN,
  UNVERIFIED_SIZE,
  isUnverifiedPin,
  mergeManifests,
  parseModelManifest,
  pinProblem,
  type PinnedModel,
} from '../src/models/manifest.js';
import {
  ensureModel,
  inspectModel,
  prefetchModel,
  requirePin,
  type ModelStoreOptions,
} from '../src/models/model-store.js';
import { lockDownTransformers } from '../src/models/transformers-env.js';
import { loadConfig } from '../src/config.js';
import { RERANKER_DTYPE } from '../src/retrieval/reranker.js';
import { FAKE_REVISION, fakeHub, fakeModel, fakeModelDir, installFakeModel, sha256Hex } from './helpers/fake-models.js';

/** Every file below `dir`, relative, sorted. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

const refOf = (pin: PinnedModel) => ({ repo: pin.repo, dtype: pin.dtype });

describe('model pins', () => {
  it('pins the models the server loads by default', () => {
    const config = loadConfig({});
    expect(PINNED_MODELS.map((pin) => `${pin.repo} ${pin.dtype}`)).toEqual(
      expect.arrayContaining([
        `${config.embeddingModel} ${config.embeddingDtype}`,
        `${config.rerankerModel} ${RERANKER_DTYPE}`,
      ]),
    );
  });

  it('refuses a built-in pin that is still a placeholder, and accepts only complete ones', () => {
    for (const pin of PINNED_MODELS) {
      if (isUnverifiedPin(pin)) {
        expect(() => requirePin(refOf(pin), PINNED_MODELS)).toThrow(/has not been pinned yet/);
      } else {
        expect(pinProblem(pin)).toBeUndefined();
      }
    }
  });

  it('treats any placeholder value as unpinned', () => {
    const { pin } = fakeModel();
    expect(pinProblem(pin)).toBeUndefined();
    expect(pinProblem({ ...pin, revision: UNVERIFIED_PIN })).toMatch(/has not been pinned yet/);
    expect(pinProblem({ ...pin, files: [{ ...pin.files[0], sha256: UNVERIFIED_PIN }] })).toMatch(/not been pinned/);
    expect(pinProblem({ ...pin, files: [{ ...pin.files[0], size: UNVERIFIED_SIZE }] })).toMatch(/not been pinned/);
  });

  it('requires a full commit SHA, not a branch', () => {
    const { pin } = fakeModel();
    expect(pinProblem({ ...pin, revision: 'main' })).toMatch(/40-character commit SHA/);
  });

  it('parses a manifest file of complete pins', () => {
    const model = fakeModel();
    expect(parseModelManifest(JSON.parse(JSON.stringify({ models: [model.pin] })), 'm.json')).toEqual([model.pin]);
  });

  it.each([
    ['../escape', /unsafe file path/],
    ['/etc/passwd', /unsafe file path/],
    ['onnx\\model.onnx', /unsafe file path/],
    ['onnx/../../x', /unsafe file path/],
    ['.hidden', /unsafe file path/],
  ])('rejects the manifest file path %s', (path, error) => {
    const { pin } = fakeModel();
    const bad = { ...pin, files: [{ ...pin.files[0], path }] };
    expect(() => parseModelManifest({ models: [bad] }, 'm.json')).toThrow(error);
  });

  it('rejects malformed manifests', () => {
    const { pin } = fakeModel();
    const file = pin.files[0];
    expect(() => parseModelManifest([], 'm.json')).toThrow(/Invalid model manifest m\.json/);
    expect(() => parseModelManifest({ models: [{ ...pin, repo: '../x' }] }, 'm.json')).toThrow(/repository id/);
    expect(() => parseModelManifest({ models: [{ ...pin, files: [{ ...file, sha256: 'ABC' }] }] }, 'm')).toThrow(
      /SHA-256/,
    );
    expect(() => parseModelManifest({ models: [{ ...pin, files: [file, file] }] }, 'm')).toThrow(/twice/);
    expect(() => parseModelManifest({ models: [pin, pin] }, 'm')).toThrow(/a second time/);
    expect(() => parseModelManifest({ models: [{ ...pin, revision: UNVERIFIED_PIN }] }, 'm')).toThrow(
      /not been pinned/,
    );
  });

  it('lets a manifest file replace the pin of a model and keeps the others', () => {
    const replacement = { ...fakeModel(PINNED_MODELS[0].repo).pin, dtype: PINNED_MODELS[0].dtype };
    const merged = mergeManifests(PINNED_MODELS, [replacement]);
    expect(merged).toContain(replacement);
    expect(merged).not.toContain(PINNED_MODELS[0]);
    expect(merged).toEqual(expect.arrayContaining(PINNED_MODELS.slice(1)));
  });
});

describe('model store', () => {
  let root: string;
  let modelsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-model-store-'));
    modelsDir = join(root, 'models');
    mkdirSync(modelsDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function options(manifest: readonly PinnedModel[], overrides: Partial<ModelStoreOptions> = {}): ModelStoreOptions {
    return {
      modelsDir,
      manifest,
      offline: false,
      fetchImpl: fakeHub([]).fetch,
      ...overrides,
    };
  }

  it('downloads the pinned files from the pinned commit into <models>/<owner>/<name>/<revision>', async () => {
    const model = fakeModel();
    const hub = fakeHub([model]);

    const dir = await ensureModel(refOf(model.pin), options([model.pin], { fetchImpl: hub.fetch }));

    expect(dir).toBe(join(modelsDir, 'Test', 'tiny-model', FAKE_REVISION));
    expect(hub.requests.sort()).toEqual([
      `https://huggingface.co/Test/tiny-model/resolve/${FAKE_REVISION}/config.json`,
      `https://huggingface.co/Test/tiny-model/resolve/${FAKE_REVISION}/onnx/model_quantized.onnx`,
    ]);
    // Exactly the pinned files, read-only, no temporary leftovers.
    expect(listFiles(modelsDir)).toEqual([
      `Test/tiny-model/${FAKE_REVISION}/config.json`,
      `Test/tiny-model/${FAKE_REVISION}/onnx/model_quantized.onnx`,
    ]);
    for (const [path, bytes] of model.contents) {
      expect(readFileSync(join(dir, path))).toEqual(bytes);
      expect(statSync(join(dir, path)).mode & 0o777).toBe(0o444);
    }
  });

  it('loads an installed model without touching the network', async () => {
    const model = fakeModel();
    installFakeModel(modelsDir, model);
    const hub = fakeHub([model]);

    await expect(ensureModel(refOf(model.pin), options([model.pin], { fetchImpl: hub.fetch }))).resolves.toBe(
      fakeModelDir(modelsDir, model),
    );
    expect(hub.requests).toEqual([]);
  });

  it('rejects a tampered model file and neither loads nor re-downloads it', async () => {
    const model = fakeModel();
    const dir = installFakeModel(modelsDir, model);
    const weights = join(dir, 'onnx', 'model_quantized.onnx');
    const tampered = Buffer.from(readFileSync(weights));
    tampered[0] ^= 0xff; // same size, different bytes
    writeFileSync(weights, tampered);
    const hub = fakeHub([model]);

    await expect(ensureModel(refOf(model.pin), options([model.pin], { fetchImpl: hub.fetch }))).rejects.toMatchObject({
      code: 'MODEL_INTEGRITY',
      message: expect.stringMatching(
        /Test\/tiny-model \(q8\) failed verification: onnx\/model_quantized\.onnx .* has SHA-256 [0-9a-f]{64}, the pin says/,
      ),
    });
    expect(hub.requests).toEqual([]);
    expect(readFileSync(weights)).toEqual(tampered);
  });

  it('rejects a model file of the wrong size', async () => {
    const model = fakeModel();
    const dir = installFakeModel(modelsDir, model);
    writeFileSync(join(dir, 'config.json'), '{"model_type":"bert","extra":1}');

    await expect(ensureModel(refOf(model.pin), options([model.pin]))).rejects.toMatchObject({
      code: 'MODEL_INTEGRITY',
      message: expect.stringContaining('config.json'),
    });
  });

  it('rejects a symbolic link in place of a model file', async () => {
    const model = fakeModel();
    const dir = installFakeModel(modelsDir, model);
    const elsewhere = join(root, 'config.json');
    writeFileSync(elsewhere, model.contents.get('config.json') ?? '');
    rmSync(join(dir, 'config.json'));
    symlinkSync(elsewhere, join(dir, 'config.json'));

    await expect(inspectModel(model.pin, modelsDir)).resolves.toMatchObject({
      status: 'invalid',
      file: 'config.json',
      reason: 'is a symbolic link',
    });
    await expect(ensureModel(refOf(model.pin), options([model.pin]))).rejects.toMatchObject({
      code: 'MODEL_INTEGRITY',
    });
  });

  it('rejects a model file reached through a symlinked subdirectory outside the store', async () => {
    // onnx/ -> a directory elsewhere that holds the pinned bytes: the file
    // itself is a regular file with the right hash, but it lives where the
    // store does not control who can replace it after it is checked.
    const model = fakeModel();
    const dir = installFakeModel(modelsDir, model);
    const outside = join(root, 'elsewhere');
    mkdirSync(outside);
    const weights = model.contents.get('onnx/model_quantized.onnx') ?? Buffer.alloc(0);
    writeFileSync(join(outside, 'model_quantized.onnx'), weights);
    rmSync(join(dir, 'onnx'), { recursive: true });
    symlinkSync(outside, join(dir, 'onnx'));
    const hub = fakeHub([model]);

    await expect(inspectModel(model.pin, modelsDir)).resolves.toMatchObject({
      status: 'invalid',
      file: 'onnx/model_quantized.onnx',
      reason: expect.stringContaining('outside the models directory'),
    });
    await expect(ensureModel(refOf(model.pin), options([model.pin], { fetchImpl: hub.fetch }))).rejects.toMatchObject({
      code: 'MODEL_INTEGRITY',
      message: expect.stringContaining('outside the models directory'),
    });
    // The explicit repair refuses it too, and writes nothing through the link.
    await expect(prefetchModel(refOf(model.pin), options([model.pin], { fetchImpl: hub.fetch }))).rejects.toMatchObject(
      { code: 'MODEL_INTEGRITY' },
    );
    expect(hub.requests).toEqual([]);
    expect(readdirSync(outside)).toEqual(['model_quantized.onnx']);
  });

  it('rejects a model directory that resolves outside the store', async () => {
    const model = fakeModel();
    const outside = join(root, 'outside');
    installFakeModel(outside, model);
    symlinkSync(join(outside, 'Test'), join(modelsDir, 'Test'));

    await expect(ensureModel(refOf(model.pin), options([model.pin]))).rejects.toMatchObject({
      code: 'MODEL_INTEGRITY',
      message: expect.stringContaining('outside the models directory'),
    });
  });

  it('with downloads off and nothing cached, reports a clear error and fetches nothing', async () => {
    const model = fakeModel();
    const hub = fakeHub([model]);

    const error: unknown = await ensureModel(
      refOf(model.pin),
      options([model.pin], { offline: true, fetchImpl: hub.fetch }),
    ).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: 'MODEL_NOT_CACHED' });
    const message = (error as Error).message;
    expect(message).toContain('Test/tiny-model (q8) is not in the model cache');
    expect(message).toContain('model downloads are disabled (offline mode)');
    expect(message).toContain('ironcurtain memory prefetch');
    expect(hub.requests).toEqual([]);
    expect(listFiles(modelsDir)).toEqual([]);
  });

  it('refuses a model without a complete pin', async () => {
    const model = fakeModel();
    const hub = fakeHub([model]);
    const placeholder = { ...model.pin, revision: UNVERIFIED_PIN };

    await expect(ensureModel(refOf(model.pin), options([], { fetchImpl: hub.fetch }))).rejects.toMatchObject({
      code: 'MODEL_UNPINNED',
      message: expect.stringContaining('is not pinned'),
    });
    await expect(ensureModel(refOf(model.pin), options([placeholder], { fetchImpl: hub.fetch }))).rejects.toMatchObject(
      { code: 'MODEL_UNPINNED', message: expect.stringContaining('has not been pinned yet') },
    );
    expect(hub.requests).toEqual([]);
  });

  it('discards a download whose SHA-256 does not match the pin', async () => {
    const model = fakeModel();
    const original = model.contents.get('config.json') ?? Buffer.alloc(0);
    const swapped = Buffer.from(original.toString().replace('bert', 'BERT'));
    expect(swapped.length).toBe(original.length);
    const hub = fakeHub([model], { override: { 'config.json': swapped } });

    await expect(ensureModel(refOf(model.pin), options([model.pin], { fetchImpl: hub.fetch }))).rejects.toMatchObject({
      code: 'MODEL_DOWNLOAD_FAILED',
      message: expect.stringContaining(`SHA-256 ${sha256Hex(swapped)} does not match the pinned`),
    });
    expect(listFiles(modelsDir).some((file) => file.endsWith('config.json'))).toBe(false);
    expect(listFiles(modelsDir).some((file) => file.includes('.download-'))).toBe(false);
  });

  it('stops a download that grows past the pinned size', async () => {
    const model = fakeModel();
    const hub = fakeHub([model], { override: { 'config.json': Buffer.alloc(10_000, 0x41) } });

    await expect(ensureModel(refOf(model.pin), options([model.pin], { fetchImpl: hub.fetch }))).rejects.toMatchObject({
      code: 'MODEL_DOWNLOAD_FAILED',
      message: expect.stringContaining('more than the pinned'),
    });
    expect(listFiles(modelsDir).some((file) => file.includes('.download-'))).toBe(false);
  });

  it('reports a failed request', async () => {
    const model = fakeModel();
    const hub = fakeHub([model], { status: { 'config.json': 404 } });

    await expect(ensureModel(refOf(model.pin), options([model.pin], { fetchImpl: hub.fetch }))).rejects.toMatchObject({
      code: 'MODEL_DOWNLOAD_FAILED',
      message: expect.stringContaining('HTTP 404'),
    });
  });

  it('aborts a download that stalls', async () => {
    const model = fakeModel();
    const hub = fakeHub([model], { stall: ['config.json'] });

    await expect(
      ensureModel(refOf(model.pin), options([model.pin], { fetchImpl: hub.fetch, stallTimeoutMs: 50 })),
    ).rejects.toMatchObject({
      code: 'MODEL_DOWNLOAD_FAILED',
      message: expect.stringContaining('no data for 50 ms'),
    });
    expect(listFiles(modelsDir).some((file) => file.includes('.download-'))).toBe(false);
  });

  it('prefetch replaces a tampered file with the pinned one, also in offline mode', async () => {
    const model = fakeModel();
    const dir = installFakeModel(modelsDir, model);
    writeFileSync(join(dir, 'config.json'), '{"model_type":"evil"}');
    const hub = fakeHub([model]);
    const logs: string[] = [];

    await expect(
      prefetchModel(
        refOf(model.pin),
        options([model.pin], { offline: true, fetchImpl: hub.fetch, log: (line) => logs.push(line) }),
      ),
    ).resolves.toBe('downloaded');

    expect(readFileSync(join(dir, 'config.json'))).toEqual(model.contents.get('config.json'));
    expect(hub.requests).toEqual([`https://huggingface.co/Test/tiny-model/resolve/${FAKE_REVISION}/config.json`]);
    expect(logs.join('\n')).toContain('replacing config.json');
    await expect(inspectModel(model.pin, modelsDir)).resolves.toMatchObject({ status: 'ok' });
  });

  it('downloads with the real fetch, following the Hub redirect to its CDN', async () => {
    const model = fakeModel();
    const served: string[] = [];
    const server: Server = createServer((req, res) => {
      served.push(req.url ?? '');
      const prefix = `/Test/tiny-model/resolve/${FAKE_REVISION}/`;
      if (req.url?.startsWith(prefix) === true) {
        res.writeHead(302, { location: `/cdn/${req.url.slice(prefix.length)}` }).end();
        return;
      }
      const bytes = model.contents.get((req.url ?? '').replace(/^\/cdn\//, ''));
      if (bytes === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-length': String(bytes.length) }).end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const dir = await ensureModel(refOf(model.pin), {
        modelsDir,
        manifest: [model.pin],
        offline: false,
        remoteHost: `http://127.0.0.1:${port}`,
      });
      for (const [path, bytes] of model.contents) {
        expect(readFileSync(join(dir, path))).toEqual(bytes);
      }
      expect(served).toContain(`/Test/tiny-model/resolve/${FAKE_REVISION}/onnx/model_quantized.onnx`);
      expect(served).toContain('/cdn/onnx/model_quantized.onnx');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('prefetch fetches nothing when the store already verifies', async () => {
    const model = fakeModel();
    installFakeModel(modelsDir, model);
    const hub = fakeHub([model]);

    await expect(prefetchModel(refOf(model.pin), options([model.pin], { fetchImpl: hub.fetch }))).resolves.toBe(
      'cached',
    );
    expect(hub.requests).toEqual([]);
  });
});

describe('lockDownTransformers', () => {
  it('turns off remote loading and the package cache, and refuses any fetch', async () => {
    const env = {
      allowRemoteModels: true,
      useFSCache: true,
      cacheDir: '/node_modules/.cache',
    } as unknown as Parameters<typeof lockDownTransformers>[0];

    lockDownTransformers(env, '/home/u/.ironcurtain/models');

    expect(env).toMatchObject({
      allowRemoteModels: false,
      allowLocalModels: true,
      useFSCache: false,
      useBrowserCache: false,
      useCustomCache: false,
      cacheDir: '/home/u/.ironcurtain/models',
      localModelPath: '/home/u/.ironcurtain/models',
    });
    await expect(env.fetch('https://huggingface.co/x/resolve/main/config.json')).rejects.toThrow(
      /only from its verified model store/,
    );
  });
});
