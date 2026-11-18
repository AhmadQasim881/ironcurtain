/**
 * transformers.js settings for the memory server: models are read only from
 * the verified model store, never fetched or cached by transformers.js.
 *
 * Out of the box transformers.js downloads any model it is asked for from
 * huggingface.co at the `main` revision, unverified, and caches it inside its
 * own package directory (node_modules/@huggingface/transformers/.cache). The
 * loaders instead pass the absolute path of a model directory the store has
 * just verified (model-store.ts), and these settings make sure nothing else
 * can happen: remote loading off, the file-system cache off (no lookups or
 * writes besides the verified directory), the cache and local-model paths
 * pointed at the models directory rather than node_modules, and a fetch that
 * refuses every request.
 */

import type { env as transformersEnv } from '@huggingface/transformers';

type TransformersEnv = typeof transformersEnv;

/** transformers.js's fetch while the memory server runs: it must never need one. */
async function refuseNetwork(input: string | URL): Promise<never> {
  return Promise.reject(
    new Error(
      `transformers.js tried to fetch ${String(input)}; the memory server loads models only from its verified ` +
        'model store',
    ),
  );
}

/** Applies the memory server's settings to transformers.js's global `env`. Idempotent. */
export function lockDownTransformers(env: TransformersEnv, modelsDir: string): void {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useFSCache = false;
  env.useBrowserCache = false;
  env.useCustomCache = false;
  env.cacheDir = modelsDir;
  env.localModelPath = modelsDir;
  env.fetch = refuseNetwork;
}
