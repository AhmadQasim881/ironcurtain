/**
 * Small stand-in models for the model-store tests: a pin whose files are a
 * few bytes of text, a way to install them into a store, and a fake Hub that
 * serves them.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PinnedModel } from '../../src/models/manifest.js';

export interface FakeModel {
  readonly pin: PinnedModel;
  readonly contents: ReadonlyMap<string, Buffer>;
}

export const FAKE_REVISION = '0123456789abcdef0123456789abcdef01234567';

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A complete pin for `repo` whose files hold the given text. */
export function fakeModel(
  repo = 'Test/tiny-model',
  files: Record<string, string> = {
    'config.json': '{"model_type":"bert"}',
    'onnx/model_quantized.onnx': 'not really an onnx model, but pinned all the same',
  },
  dtype = 'q8',
): FakeModel {
  const contents = new Map(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)]));
  return {
    pin: {
      repo,
      dtype,
      revision: FAKE_REVISION,
      files: [...contents].map(([path, bytes]) => ({ path, sha256: sha256Hex(bytes), size: bytes.length })),
    },
    contents,
  };
}

/** Where the store keeps `model`'s files. */
export function fakeModelDir(modelsDir: string, model: FakeModel): string {
  return join(modelsDir, model.pin.repo, model.pin.revision);
}

/** Writes `model`'s files where the store expects them; returns the model directory. */
export function installFakeModel(modelsDir: string, model: FakeModel): string {
  const dir = fakeModelDir(modelsDir, model);
  for (const [path, bytes] of model.contents) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  return dir;
}

/** Writes a MEMORY_MODEL_MANIFEST file pinning `models`. */
export function writeManifest(path: string, models: readonly FakeModel[]): void {
  writeFileSync(path, JSON.stringify({ models: models.map((model) => model.pin) }));
}

export interface FakeHub {
  readonly fetch: typeof fetch;
  /** Every URL requested, in order. */
  readonly requests: string[];
}

export interface FakeHubOptions {
  /** Serve these bytes instead of the pinned ones (a tampered or updated upstream file). */
  readonly override?: Readonly<Record<string, Buffer>>;
  /** Paths answered with this HTTP status. */
  readonly status?: Readonly<Record<string, number>>;
  /** Paths whose body never delivers a byte. */
  readonly stall?: readonly string[];
}

/** A Hub that serves `models` at `https://huggingface.co/<repo>/resolve/<revision>/<path>`. */
export function fakeHub(models: readonly FakeModel[], options: FakeHubOptions = {}): FakeHub {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    for (const model of models) {
      const prefix = `https://huggingface.co/${model.pin.repo}/resolve/${model.pin.revision}/`;
      if (!url.startsWith(prefix)) continue;
      const path = url.slice(prefix.length);
      const status = options.status?.[path];
      if (status !== undefined) return new Response('error', { status });
      if (options.stall?.includes(path)) {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener('abort', () => {
              controller.error(signal.reason);
            });
          },
        });
        return new Response(body, { status: 200 });
      }
      const bytes = options.override?.[path] ?? model.contents.get(path);
      if (bytes !== undefined) return new Response(new Uint8Array(bytes), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}
