/**
 * The verified model store: where the memory server keeps its embedding and
 * re-ranking models, and the only code that downloads them.
 *
 * Layout: `<modelsDir>/<owner>/<name>/<revision>/<file>`, one directory per
 * pinned commit (the same layout transformers.js uses for a pinned revision).
 * IronCurtain sets the models directory to `~/.ironcurtain/models`; standalone
 * the default is `$XDG_CACHE_HOME/memory-mcp/models` (see config.ts). Either
 * way it is outside node_modules, so a global install needs no write access
 * to its own tree and an upgrade keeps the models.
 *
 * Every model comes from its pin (manifest.ts): the files the pin lists, from
 * the commit it names. A download is streamed to a temporary file next to its
 * destination, capped at the pinned size, hashed while it streams and renamed
 * into place only when size and SHA-256 both match. Before every load the
 * files are checked again (regular files, not symlinks, resolving inside the
 * store, pinned size and SHA-256), so a modified or corrupted file is
 * refused, never parsed. When downloads are off (MEMORY_MODELS_OFFLINE) a
 * missing model is an error that says how to fetch it.
 *
 * transformers.js itself only ever reads the verified directory, with remote
 * loading and its own cache turned off (transformers-env.ts).
 *
 * What this protects against: a changed or compromised upstream repository
 * or CDN, a corrupted or tampered file in the store, and a model silently
 * swapped for one whose embeddings no longer match the stored vectors. The
 * check and the load that follows it are separate reads, so someone able to
 * rewrite the store in between could still swap a file; that is the user
 * account the server runs as, which can change the server's own code as well.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { MemoryConfig } from '../config.js';
import { findPin, pinProblem, type ModelManifest, type PinnedModel, type PinnedModelFile } from './manifest.js';

/** Where pinned files are downloaded from. */
export const HUGGING_FACE_HOST = 'https://huggingface.co';

/** A download that receives no data for this long is aborted. */
const DEFAULT_STALL_TIMEOUT_MS = 60_000;

/**
 * Why a model is unavailable. Callers branch on `code` (it survives module
 * boundaries, `instanceof` does not):
 *
 * - `MODEL_UNPINNED`: no complete pin for this model and dtype.
 * - `MODEL_NOT_CACHED`: files are missing and downloads are off.
 * - `MODEL_INTEGRITY`: a file in the store is not what the pin says.
 * - `MODEL_DOWNLOAD_FAILED`: the download failed or did not match the pin.
 */
export type ModelStoreErrorCode = 'MODEL_UNPINNED' | 'MODEL_NOT_CACHED' | 'MODEL_INTEGRITY' | 'MODEL_DOWNLOAD_FAILED';

export class ModelStoreError extends Error {
  readonly code: ModelStoreErrorCode;

  constructor(code: ModelStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelStoreError';
    this.code = code;
  }
}

/** A model the server loads: a repository and the dtype it is loaded with. */
export interface ModelRef {
  readonly repo: string;
  readonly dtype: string;
}

export interface ModelStoreOptions {
  /** Absolute path of the models directory. */
  readonly modelsDir: string;
  readonly manifest: ModelManifest;
  /** Never download: a missing model is MODEL_NOT_CACHED. */
  readonly offline: boolean;
  /** Progress and warnings (the server writes them to stderr). */
  readonly log?: (line: string) => void;
  /** Injected in tests. */
  readonly fetchImpl?: typeof fetch;
  /** Injected in tests; production always downloads from {@link HUGGING_FACE_HOST}. */
  readonly remoteHost?: string;
  /** Injected in tests. */
  readonly stallTimeoutMs?: number;
}

/** Store options for a server running with `config`. */
export function modelStoreOptions(config: MemoryConfig): ModelStoreOptions {
  return {
    modelsDir: config.modelsDir,
    manifest: config.modelManifest,
    offline: config.modelsOffline,
    log: (line) => {
      console.error(`[memory-server] ${line}`);
    },
  };
}

function describe(ref: ModelRef): string {
  return `${ref.repo} (${ref.dtype})`;
}

const PREFETCH_HINT =
  'Run `ironcurtain memory prefetch` (standalone: `memory-mcp-server --prefetch-models`) on a machine with network access';

/** The complete pin for `ref`, or MODEL_UNPINNED. */
export function requirePin(ref: ModelRef, manifest: ModelManifest): PinnedModel {
  const pin = findPin(manifest, ref.repo, ref.dtype);
  if (pin === undefined) {
    throw new ModelStoreError(
      'MODEL_UNPINNED',
      `Memory model ${describe(ref)} is not pinned: the memory server only loads models whose revision and file ` +
        'hashes it knows. Pin it in a manifest file (MEMORY_MODEL_MANIFEST) or use a model this build pins.',
    );
  }
  const problem = pinProblem(pin);
  if (problem !== undefined) {
    throw new ModelStoreError(
      'MODEL_UNPINNED',
      `Memory model ${describe(ref)} ${problem}, so the memory server will not download or load it.`,
    );
  }
  return pin;
}

/** The directory that holds `pin`'s files. */
export function modelDirectory(modelsDir: string, pin: PinnedModel): string {
  return join(modelsDir, ...pin.repo.split('/'), pin.revision);
}

function fileLocation(dir: string, file: PinnedModelFile): string {
  return join(dir, ...file.path.split('/'));
}

function assertAbsoluteModelsDir(modelsDir: string): void {
  if (!isAbsolute(modelsDir)) {
    throw new Error(`The models directory must be an absolute path, got ${JSON.stringify(modelsDir)}`);
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Refuses a directory under the models directory that resolves outside it (a
 * symlinked `<owner>`, `<name>` or subdirectory component). The models
 * directory itself may be a symlink: containment is checked against its real
 * path, which is returned.
 */
async function assertContained(modelsDir: string, dir: string): Promise<string> {
  const [realRoot, realDir] = await Promise.all([realpath(modelsDir), realpath(dir)]);
  if (!isInside(realRoot, realDir)) {
    throw new ModelStoreError(
      'MODEL_INTEGRITY',
      `Model directory ${dir} resolves to ${realDir}, outside the models directory ${realRoot}; refusing it.`,
    );
  }
  return realRoot;
}

/** Lowercase hex SHA-256 of a file's contents. */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * 'missing', what is wrong with the installed file, or undefined when it
 * matches its pin. `realRoot` is the real path of the models directory: the
 * file must resolve inside it.
 */
async function fileProblem(location: string, file: PinnedModelFile, realRoot: string): Promise<string | undefined> {
  let stats;
  try {
    stats = await lstat(location);
  } catch (err) {
    if (isEnoent(err)) return 'missing';
    throw err;
  }
  if (!stats.isFile()) {
    return stats.isSymbolicLink() ? 'is a symbolic link' : 'is not a regular file';
  }
  // lstat only refuses a symlink as the last component; one on the way (an
  // `onnx/` directory linked to somewhere else) would put the file outside
  // the store, where others may be able to replace it after it is checked.
  const real = await realpath(location);
  if (!isInside(realRoot, real)) {
    return `resolves to ${real}, outside the models directory ${realRoot}`;
  }
  if (stats.size !== file.size) {
    return `is ${stats.size} bytes, the pin says ${file.size}`;
  }
  const digest = await sha256OfFile(location);
  if (digest !== file.sha256) {
    return `has SHA-256 ${digest}, the pin says ${file.sha256}`;
  }
  return undefined;
}

export type ModelInspection =
  | { readonly status: 'ok'; readonly dir: string }
  | { readonly status: 'missing'; readonly dir: string; readonly files: readonly string[] }
  | { readonly status: 'invalid'; readonly dir: string; readonly file: string; readonly reason: string };

/**
 * Checks the installed copy of `pin` without downloading anything: `ok` when
 * every pinned file is present and matches, `invalid` when one is present but
 * does not match (reported before anything merely missing), `missing`
 * otherwise. Reads every present file in full.
 */
export async function inspectModel(pin: PinnedModel, modelsDir: string): Promise<ModelInspection> {
  assertAbsoluteModelsDir(modelsDir);
  const dir = modelDirectory(modelsDir, pin);
  try {
    await lstat(dir);
  } catch (err) {
    if (isEnoent(err)) return { status: 'missing', dir, files: pin.files.map((file) => file.path) };
    throw err;
  }
  const realRoot = await assertContained(modelsDir, dir);

  const missing: string[] = [];
  for (const file of pin.files) {
    const problem = await fileProblem(fileLocation(dir, file), file, realRoot);
    if (problem === 'missing') {
      missing.push(file.path);
    } else if (problem !== undefined) {
      return { status: 'invalid', dir, file: file.path, reason: problem };
    }
  }
  return missing.length === 0 ? { status: 'ok', dir } : { status: 'missing', dir, files: missing };
}

function integrityError(ref: ModelRef, inspection: { dir: string; file: string; reason: string }): ModelStoreError {
  return new ModelStoreError(
    'MODEL_INTEGRITY',
    `Memory model ${describe(ref)} failed verification: ${inspection.file} in ${inspection.dir} ${inspection.reason}. ` +
      `It was modified or corrupted and was not loaded. ${PREFETCH_HINT} to replace it with the pinned file.`,
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${err.message}${cause}`;
  }
  return String(err);
}

/** Streams `url` into `destination`, accepting exactly the pinned bytes. */
async function downloadFile(
  url: string,
  destination: string,
  file: PinnedModelFile,
  options: ModelStoreOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const controller = new AbortController();
  const stalled = (): void => {
    controller.abort(new Error(`no data for ${stallTimeoutMs} ms`));
  };
  let timer = setTimeout(stalled, stallTimeoutMs);

  const temporary = `${destination}.download-${randomBytes(8).toString('hex')}`;
  let handle: FileHandle | undefined;
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (response.body === null) {
      throw new Error('empty response');
    }

    // 'wx': create only, so nothing already at this path is written through.
    handle = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256');
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > file.size) {
        throw new Error(`the server sent more than the pinned ${file.size} bytes`);
      }
      hash.update(value);
      await handle.write(value);
      clearTimeout(timer);
      timer = setTimeout(stalled, stallTimeoutMs);
    }
    if (received !== file.size) {
      throw new Error(`received ${received} bytes, the pin says ${file.size}`);
    }
    const digest = hash.digest('hex');
    if (digest !== file.sha256) {
      throw new Error(`SHA-256 ${digest} does not match the pinned ${file.sha256}`);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o444);
    await rename(temporary, destination);
  } catch (err) {
    const reason = controller.signal.aborted ? errorMessage(controller.signal.reason) : errorMessage(err);
    // Release the connection of a response we stopped reading.
    controller.abort();
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw new ModelStoreError(
      'MODEL_DOWNLOAD_FAILED',
      `Could not download ${file.path} from ${url}: ${reason}. Nothing was installed.`,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/**
 * Downloads every file of `pin` that is missing or does not match, from the
 * pinned commit, verifying each before it replaces anything, then checks the
 * whole model again.
 */
async function downloadAndVerify(ref: ModelRef, pin: PinnedModel, options: ModelStoreOptions): Promise<string> {
  const dir = modelDirectory(options.modelsDir, pin);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const realRoot = await assertContained(options.modelsDir, dir);
  const host = (options.remoteHost ?? HUGGING_FACE_HOST).replace(/\/+$/, '');

  for (const file of pin.files) {
    const location = fileLocation(dir, file);
    await mkdir(dirname(location), { recursive: true, mode: 0o700 });
    await assertContained(options.modelsDir, dirname(location));
    const problem = await fileProblem(location, file, realRoot);
    if (problem === undefined) continue;
    if (problem !== 'missing') {
      options.log?.(`${pin.repo}: replacing ${file.path}, which ${problem}`);
    }
    options.log?.(`Downloading ${pin.repo} ${file.path} (${formatSize(file.size)}) ...`);
    await downloadFile(`${host}/${pin.repo}/resolve/${pin.revision}/${file.path}`, location, file, options);
  }

  const after = await inspectModel(pin, options.modelsDir);
  if (after.status === 'invalid') throw integrityError(ref, after);
  if (after.status === 'missing') {
    throw new ModelStoreError(
      'MODEL_DOWNLOAD_FAILED',
      `Memory model ${describe(ref)} is still incomplete after downloading (missing: ${after.files.join(', ')}).`,
    );
  }
  options.log?.(`${pin.repo}@${pin.revision.slice(0, 12)}: ${pin.files.length} files verified in ${dir}`);
  return after.dir;
}

/**
 * The verified directory for `ref`, downloading the pinned files first when
 * they are missing and downloads are allowed. A file that is present but does
 * not match its pin is refused (MODEL_INTEGRITY), not silently replaced:
 * {@link prefetchModel} is the explicit repair.
 */
export async function ensureModel(ref: ModelRef, options: ModelStoreOptions): Promise<string> {
  const pin = requirePin(ref, options.manifest);
  const inspection = await inspectModel(pin, options.modelsDir);
  if (inspection.status === 'ok') return inspection.dir;
  if (inspection.status === 'invalid') throw integrityError(ref, inspection);

  if (options.offline) {
    throw new ModelStoreError(
      'MODEL_NOT_CACHED',
      `Memory model ${describe(ref)} is not in the model cache (${inspection.dir}; missing: ` +
        `${inspection.files.join(', ')}) and model downloads are disabled (offline mode). ` +
        `${PREFETCH_HINT}, or copy a verified models directory here.`,
    );
  }
  return downloadAndVerify(ref, pin, options);
}

/**
 * Makes sure `ref` is installed and verified, downloading what is missing and
 * replacing what does not match. Ignores the offline setting: prefetching is
 * how the store of an offline server gets filled. Says whether anything had
 * to be fetched.
 */
export async function prefetchModel(ref: ModelRef, options: ModelStoreOptions): Promise<'cached' | 'downloaded'> {
  const pin = requirePin(ref, options.manifest);
  const inspection = await inspectModel(pin, options.modelsDir);
  if (inspection.status === 'ok') return 'cached';
  await downloadAndVerify(ref, pin, options);
  return 'downloaded';
}
