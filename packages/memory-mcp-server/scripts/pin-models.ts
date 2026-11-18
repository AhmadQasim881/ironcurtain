#!/usr/bin/env node
/**
 * Records the pins for the memory server's default models (PINNED_MODELS in
 * src/models/manifest.ts): resolves each model's commit on the Hub, downloads
 * every file the server loads at that commit, and prints the revision and
 * each file's SHA-256 and size, ready to replace the entry in
 * PINNED_MODELS. With --json it prints a manifest file instead
 * (MEMORY_MODEL_MANIFEST).
 *
 * Needs network access, and is a maintainer tool: a pin is only as
 * trustworthy as what the Hub served when it was recorded, so review the
 * commits (and, for a model update, the diff) before pasting the output.
 *
 *   npx tsx scripts/pin-models.ts                                  # each model's current main
 *   npx tsx scripts/pin-models.ts Xenova/bge-base-en-v1.5=<sha>    # a specific commit
 *   npx tsx scripts/pin-models.ts --json > manifest.json
 */

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { HUGGING_FACE_HOST } from '../src/models/model-store.js';
import { PINNED_MODELS, pinProblem, type PinnedModel } from '../src/models/manifest.js';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

async function resolveCommit(repo: string, ref: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(`${HUGGING_FACE_HOST}/api/models/${repo}/revision/${encodeURIComponent(ref)}`);
  if (response.status !== 200) throw new Error(`${repo}: the Hub answered HTTP ${response.status} for ${ref}`);
  const body = (await response.json()) as { sha?: unknown };
  if (typeof body.sha !== 'string' || !COMMIT_PATTERN.test(body.sha)) {
    throw new Error(`${repo}: the Hub returned no commit SHA for ${ref}`);
  }
  return body.sha;
}

async function hashRemoteFile(url: string, fetchImpl: typeof fetch): Promise<{ sha256: string; size: number }> {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (response.status !== 200 || response.body === null) throw new Error(`HTTP ${response.status} for ${url}`);
  const hash = createHash('sha256');
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    hash.update(value);
  }
  return { sha256: hash.digest('hex'), size };
}

/**
 * The complete pin for `template` (repository, dtype and file list from
 * PINNED_MODELS) at `revision`: a commit SHA, or a branch to resolve.
 */
export async function recordPin(
  template: PinnedModel,
  revision: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PinnedModel> {
  const commit = COMMIT_PATTERN.test(revision) ? revision : await resolveCommit(template.repo, revision, fetchImpl);
  const files = [];
  for (const file of template.files) {
    const url = `${HUGGING_FACE_HOST}/${template.repo}/resolve/${commit}/${file.path}`;
    files.push({ path: file.path, ...(await hashRemoteFile(url, fetchImpl)) });
  }
  const pin: PinnedModel = { repo: template.repo, dtype: template.dtype, revision: commit, files };
  const problem = pinProblem(pin);
  if (problem !== undefined) throw new Error(`${template.repo} ${problem}`);
  return pin;
}

/** A PINNED_MODELS entry as TypeScript source. */
export function formatPin(pin: PinnedModel): string {
  const files = pin.files.map(
    (file) => `      { path: '${file.path}', sha256: '${file.sha256}', size: ${file.size} },`,
  );
  return [
    '  {',
    `    repo: '${pin.repo}',`,
    `    dtype: '${pin.dtype}',`,
    `    revision: '${pin.revision}',`,
    '    files: [',
    ...files,
    '    ],',
    '  },',
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<void> {
  const json = argv.includes('--json');
  const revisions = new Map<string, string>();
  for (const arg of argv.filter((a) => a !== '--json')) {
    const match = /^([^=]+)=([^=]+)$/.exec(arg);
    if (match === null) {
      throw new Error(`expected <repo>=<commit>, got ${JSON.stringify(arg)}`);
    }
    revisions.set(match[1], match[2]);
  }

  const pins: PinnedModel[] = [];
  for (const template of PINNED_MODELS) {
    const revision = revisions.get(template.repo) ?? 'main';
    process.stderr.write(`Pinning ${template.repo} (${template.dtype}) at ${revision} ...\n`);
    pins.push(await recordPin(template, revision));
  }
  process.stdout.write(json ? `${JSON.stringify({ models: pins }, null, 2)}\n` : `${pins.map(formatPin).join('\n')}\n`);
}

const entryScript = process.argv.at(1);
if (entryScript !== undefined && import.meta.url === pathToFileURL(entryScript).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`pin-models: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
