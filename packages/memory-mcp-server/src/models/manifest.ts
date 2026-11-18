/**
 * Pins for the models the memory server loads.
 *
 * The embedding and re-ranking models come from Hugging Face. transformers.js
 * is never allowed to fetch them: the server's model store (model-store.ts)
 * downloads exactly the files pinned here, at the pinned commit, checks every
 * file's size and SHA-256 before installing it and again before each load,
 * and refuses anything else. A model, or a dtype of a model, without a
 * complete pin is neither downloaded nor loaded.
 *
 * The built-in pins can be extended or replaced per model with a manifest
 * file (MEMORY_MODEL_MANIFEST, {@link parseModelManifest}); that is how a
 * standalone user pins a different model, and how the test suite pins the
 * model files it already has on disk.
 */

/**
 * Placeholder for a pin that has not been recorded from the Hub yet. A pin
 * that still contains it is unusable ({@link pinProblem}): the server refuses
 * to download or load that model rather than trust whatever the Hub serves.
 */
export const UNVERIFIED_PIN = 'UNVERIFIED';

/** The size that goes with {@link UNVERIFIED_PIN} (never a valid size). */
export const UNVERIFIED_SIZE = -1;

/** One file of a pinned model. */
export interface PinnedModelFile {
  /** Path inside the repository, e.g. `onnx/model_quantized.onnx`. */
  readonly path: string;
  /** Lowercase hex SHA-256 of the file's bytes. */
  readonly sha256: string;
  /** Size in bytes. */
  readonly size: number;
}

/**
 * A Hugging Face model repository pinned to one commit, with every file the
 * memory server reads from it when it loads the model with `dtype`.
 */
export interface PinnedModel {
  /** Repository id, `<owner>/<name>`. */
  readonly repo: string;
  /** ONNX dtype the server loads (it decides which weights file is read). */
  readonly dtype: string;
  /** Full 40-character commit SHA. */
  readonly revision: string;
  readonly files: readonly PinnedModelFile[];
}

export type ModelManifest = readonly PinnedModel[];

/**
 * The files transformers.js reads for these BERT-family models with
 * `dtype: 'q8'`: the config, the tokenizer and the quantized ONNX weights.
 * (Checked with transformers.js 4.3 by loading both models offline from a
 * directory holding exactly these four files. A transformers.js upgrade that
 * needs another file fails the real-model suites with a missing-file error.)
 */
const Q8_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'] as const;

function unverifiedFiles(paths: readonly string[]): PinnedModelFile[] {
  return paths.map((path) => ({ path, sha256: UNVERIFIED_PIN, size: UNVERIFIED_SIZE }));
}

/**
 * The default models, pinned.
 *
 * FILL IN BEFORE RELEASE: the revisions, hashes and sizes below are
 * placeholders ({@link UNVERIFIED_PIN}); they have not been recorded from the
 * Hub yet. Run `npm run pin-models -w packages/memory-mcp-server` (needs
 * network access; scripts/pin-models.ts) on a trusted machine, review the
 * commits it resolves, and replace each entry with its output. Until then the
 * server refuses these models (fail safe): memory_store and memory_recall
 * report MODEL_UNPINNED, re-ranking is skipped, and `ironcurtain doctor`
 * fails its memory models check.
 */
export const PINNED_MODELS: ModelManifest = [
  {
    repo: 'Xenova/bge-base-en-v1.5',
    dtype: 'q8',
    revision: UNVERIFIED_PIN,
    files: unverifiedFiles(Q8_FILES),
  },
  {
    repo: 'Xenova/ms-marco-MiniLM-L-6-v2',
    dtype: 'q8',
    revision: UNVERIFIED_PIN,
    files: unverifiedFiles(Q8_FILES),
  },
];

/** `<owner>/<name>`, each part starting with a letter or digit, no `..`. */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const DTYPE_PATTERN = /^[a-z0-9]{1,16}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** Relative path of segments that start with a letter or digit: no `.`/`..`, no absolute paths, no backslashes. */
const FILE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MAX_FILE_PATH_LENGTH = 200;
const MAX_FILES_PER_MODEL = 64;

/** True when the pin still carries a placeholder for a value nobody has recorded. */
export function isUnverifiedPin(pin: PinnedModel): boolean {
  return (
    pin.revision === UNVERIFIED_PIN ||
    pin.files.some((file) => file.sha256 === UNVERIFIED_PIN || file.size === UNVERIFIED_SIZE)
  );
}

/**
 * Why `pin` cannot be used, or undefined when it is a complete pin. The model
 * store refuses any pin with a problem; a placeholder is reported as such.
 */
export function pinProblem(pin: PinnedModel): string | undefined {
  if (isUnverifiedPin(pin)) {
    return 'has not been pinned yet (this build carries placeholder values for its revision and file hashes)';
  }
  if (!REPO_PATTERN.test(pin.repo) || pin.repo.includes('..')) {
    return `has an invalid repository id ${JSON.stringify(pin.repo)}`;
  }
  if (!DTYPE_PATTERN.test(pin.dtype)) {
    return `has an invalid dtype ${JSON.stringify(pin.dtype)}`;
  }
  if (!REVISION_PATTERN.test(pin.revision)) {
    return 'has a revision that is not a full 40-character commit SHA';
  }
  if (pin.files.length === 0 || pin.files.length > MAX_FILES_PER_MODEL) {
    return `must pin between 1 and ${MAX_FILES_PER_MODEL} files`;
  }
  const seen = new Set<string>();
  for (const file of pin.files) {
    if (file.path.length > MAX_FILE_PATH_LENGTH || !FILE_PATH_PATTERN.test(file.path)) {
      return `has an unsafe file path ${JSON.stringify(file.path)}`;
    }
    if (seen.has(file.path)) {
      return `pins ${file.path} twice`;
    }
    seen.add(file.path);
    if (!SHA256_PATTERN.test(file.sha256)) {
      return `has an invalid SHA-256 for ${file.path} (expected 64 lowercase hex digits)`;
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      return `has an invalid size for ${file.path}`;
    }
  }
  return undefined;
}

/** The pin for `repo` loaded as `dtype`, if the manifest has one (complete or not). */
export function findPin(manifest: ModelManifest, repo: string, dtype: string): PinnedModel | undefined {
  return manifest.find((pin) => pin.repo === repo && pin.dtype === dtype);
}

/** `base` with every entry for a model `overrides` also pins replaced by the override. */
export function mergeManifests(base: ModelManifest, overrides: ModelManifest): ModelManifest {
  const replaced = (pin: PinnedModel): boolean => findPin(overrides, pin.repo, pin.dtype) !== undefined;
  return [...base.filter((pin) => !replaced(pin)), ...overrides];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFile(value: unknown, where: string): PinnedModelFile {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  const { path, sha256, size } = value;
  if (typeof path !== 'string' || typeof sha256 !== 'string' || typeof size !== 'number') {
    throw new Error(`${where} needs "path" and "sha256" strings and a numeric "size"`);
  }
  return { path, sha256, size };
}

function parsePin(value: unknown, where: string): PinnedModel {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  const { repo, dtype, revision, files } = value;
  if (typeof repo !== 'string' || typeof dtype !== 'string' || typeof revision !== 'string') {
    throw new Error(`${where} needs "repo", "dtype" and "revision" strings`);
  }
  if (!Array.isArray(files)) throw new Error(`${where}.files must be an array`);
  const pin: PinnedModel = {
    repo,
    dtype,
    revision,
    files: files.map((file: unknown, i) => parseFile(file, `${where}.files[${i}]`)),
  };
  const problem = pinProblem(pin);
  if (problem !== undefined) throw new Error(`${where} (${repo}) ${problem}`);
  return pin;
}

/**
 * Parses a model manifest file's JSON: `{ "models": [ { "repo", "dtype",
 * "revision", "files": [ { "path", "sha256", "size" } ] } ] }`. Every entry
 * must be a complete pin; anything else throws, naming `source`.
 */
export function parseModelManifest(json: unknown, source: string): ModelManifest {
  try {
    if (!isRecord(json) || !Array.isArray(json.models)) {
      throw new Error('expected an object with a "models" array');
    }
    const pins = json.models.map((entry: unknown, i) => parsePin(entry, `models[${i}]`));
    for (const [i, pin] of pins.entries()) {
      if (pins.findIndex((other) => other.repo === pin.repo && other.dtype === pin.dtype) !== i) {
        throw new Error(`models[${i}] pins ${pin.repo} (${pin.dtype}) a second time`);
      }
    }
    return pins;
  } catch (err) {
    throw new Error(`Invalid model manifest ${source}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}
