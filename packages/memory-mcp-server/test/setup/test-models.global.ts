/**
 * Global setup: a verified model store for the suites that load the real
 * embedding and re-ranking models.
 *
 * The memory server loads only pinned, hash-verified models (src/models/).
 * The built-in pins are placeholders until they are recorded from the Hub,
 * and the suite must also run offline, so this fixture pins the model files
 * that are already on this machine instead: the copies transformers.js cached
 * inside its own package directory (node_modules/@huggingface/transformers/
 * .cache) before the store existed. They are copied into a temporary store
 * and hashed into a test manifest, and the real-model suites run with that
 * store, that manifest and downloads off (test/helpers/test-models.ts). The
 * production verification path is the one exercised; only where the pins come
 * from differs.
 *
 * Without such a copy the suites run with the built-in pins and download the
 * models, which works once the pins are recorded.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { PINNED_MODELS, type PinnedModel } from '../../src/models/manifest.js';

/** The commit the test store files its copies under; offline, any full SHA works. */
const TEST_REVISION = '0'.repeat(40);

/** Where transformers.js cached downloads by default (inside its package directory). */
function legacyTransformersCache(): string | undefined {
  try {
    const entry = createRequire(import.meta.url).resolve('@huggingface/transformers');
    // <package>/dist/transformers.node.cjs -> <package>/.cache
    return join(dirname(dirname(entry)), '.cache');
  } catch {
    return undefined;
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function copyIntoStore(cache: string, modelsDir: string, pin: PinnedModel): PinnedModel {
  const files = pin.files.map((file) => {
    const target = join(modelsDir, pin.repo, TEST_REVISION, file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(cache, pin.repo, file.path), target);
    return { path: file.path, sha256: sha256(target), size: statSync(target).size };
  });
  return { repo: pin.repo, dtype: pin.dtype, revision: TEST_REVISION, files };
}

export default function setup(project: TestProject): () => void {
  const cache = legacyTransformersCache();
  const available =
    cache !== undefined &&
    PINNED_MODELS.every((pin) => pin.files.every((file) => existsSync(join(cache, pin.repo, file.path))));
  if (!available) {
    project.provide('memoryTestModelEnv', {});
    return () => undefined;
  }

  const root = mkdtempSync(join(tmpdir(), 'memory-test-models-'));
  const modelsDir = join(root, 'models');
  const models = PINNED_MODELS.map((pin) => copyIntoStore(cache, modelsDir, pin));
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ models }, null, 2));

  project.provide('memoryTestModelEnv', {
    MEMORY_MODELS_DIR: modelsDir,
    MEMORY_MODEL_MANIFEST: manifestPath,
    MEMORY_MODELS_OFFLINE: 'true',
  });
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
