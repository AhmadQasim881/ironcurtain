import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { MEMORY_WRITER_KINDS, type MemoryWriter, type MemoryWriterKind } from './types.js';
import { PINNED_MODELS, mergeManifests, parseModelManifest, type ModelManifest } from './models/manifest.js';
import { embeddingDimensionsFor } from './embedding/models.js';

export interface MemoryConfig {
  // Storage
  dbPath: string;
  namespace: string;

  /**
   * Who writes through this server (MEMORY_WRITER_KIND, MEMORY_SESSION_ID), stamped
   * into `metadata.writer` of every memory it stores. Null when the host sets no
   * writer kind (rows then carry no writer).
   */
  writer: MemoryWriter | null;

  // Embeddings
  embeddingModel: string;
  embeddingDtype: string;
  /**
   * Size of the vectors the embedding model produces (MEMORY_EMBEDDING_DIMENSIONS, or
   * the size embedding/models.ts lists for the model). The database's vector index is
   * built for it, and every embedding is checked against it.
   */
  embeddingDimensions: number;

  // Model store (see models/model-store.ts)
  /** Absolute directory of the verified model files (MEMORY_MODELS_DIR). */
  modelsDir: string;
  /** Never download models (MEMORY_MODELS_OFFLINE): a model missing from modelsDir is an error. */
  modelsOffline: boolean;
  /** Pinned revisions and file hashes: the built-in pins, replaced per model by MEMORY_MODEL_MANIFEST. */
  modelManifest: ModelManifest;

  // LLM
  llmBaseUrl: string | null;
  llmApiKey: string | null;
  llmModel: string;
  /**
   * Deadline (ms) for one LLM call, retries included, when the caller names none:
   * fact extraction (one call per ingest chunk) and maintenance (MEMORY_LLM_TIMEOUT_MS,
   * default 60 s).
   */
  llmTimeoutMs: number;
  /**
   * Deadline (ms) for the LLM call that writes a recall or briefing in the 'summary' or
   * 'answer' format; on timeout the result falls back to extractive or list output
   * (MEMORY_LLM_FORMAT_TIMEOUT_MS, default 20 s).
   */
  llmFormatTimeoutMs: number;
  /**
   * Most LLM calls one server process makes (MEMORY_LLM_MAX_CALLS). Past it every LLM
   * feature falls back as if no LLM were configured, until the server restarts.
   */
  llmMaxCalls: number;
  /**
   * Most LLM tokens (prompt plus completion) one server process spends
   * (MEMORY_LLM_MAX_TOKENS). A call that could take the total past it is not made.
   */
  llmMaxTokens: number;

  // Maintenance
  decayThreshold: number;
  maintenanceInterval: number;
  compactionMinGroup: number;

  // Consolidation
  consolidationBatchSize: number;

  // Retrieval
  defaultTokenBudget: number;

  // Re-ranker
  rerankerModel: string;
  rerankerEnabled: boolean;
}

type EnvSource = Record<string, string | undefined>;

function envFloat(env: EnvSource, key: string, fallback: number): number {
  const val = env[key];
  if (val === undefined) return fallback;
  const parsed = parseFloat(val);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envInt(env: EnvSource, key: string, fallback: number): number {
  const val = env[key];
  if (val === undefined) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A boolean setting, strictly: `true`/`1` or `false`/`0` (unset or empty means
 * `fallback`). Anything else is a configuration error, not a silent default.
 */
function envBoolean(env: EnvSource, key: string, fallback: boolean): boolean {
  const val = env[key];
  if (val === undefined || val === '') return fallback;
  if (val === 'true' || val === '1') return true;
  if (val === 'false' || val === '0') return false;
  throw new Error(`${key} must be true or false`);
}

/**
 * Where verified model files live: MEMORY_MODELS_DIR (IronCurtain passes
 * ~/.ironcurtain/models), else `$XDG_CACHE_HOME/memory-mcp/models` (default
 * `~/.cache`). Never inside node_modules.
 */
function loadModelsDir(env: EnvSource): string {
  const configured = env.MEMORY_MODELS_DIR;
  if (configured !== undefined && configured !== '') {
    if (!isAbsolute(configured)) throw new Error('MEMORY_MODELS_DIR must be an absolute path');
    return resolve(configured);
  }
  const xdgCache = env.XDG_CACHE_HOME;
  const cacheRoot = xdgCache !== undefined && isAbsolute(xdgCache) ? xdgCache : join(homedir(), '.cache');
  return join(cacheRoot, 'memory-mcp', 'models');
}

/**
 * The built-in pins, with the models a manifest file (MEMORY_MODEL_MANIFEST,
 * an absolute path) pins replacing theirs. A manifest that cannot be read or
 * is not a list of complete pins stops the server.
 */
function loadModelManifest(env: EnvSource): ModelManifest {
  const path = env.MEMORY_MODEL_MANIFEST;
  if (path === undefined || path === '') return PINNED_MODELS;
  if (!isAbsolute(path)) throw new Error('MEMORY_MODEL_MANIFEST must be an absolute path');
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`Cannot read the model manifest ${path}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  return mergeManifests(PINNED_MODELS, parseModelManifest(json, path));
}

/**
 * A positive whole number from the environment, at most `max`, or `fallback` when the
 * variable is unset. Anything else (zero, negative, fractional, too large, not a number)
 * is a configuration error: these values bound time and spend, so a typo must not quietly
 * disable a bound.
 */
function envPositiveInt(env: EnvSource, key: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const val = env[key];
  if (val === undefined || val === '') return fallback;
  const parsed = Number(val);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(
      `${key} must be a positive whole number` + (max < Number.MAX_SAFE_INTEGER ? ` of at most ${max}` : ''),
    );
  }
  return parsed;
}

/**
 * Longest LLM deadline accepted (ms): one day, as for IronCurtain's own call timeouts.
 * A Node.js timer cannot wait longer than about 24.8 days; a longer delay fires at once,
 * so it would end every LLM call before it was answered.
 */
export const MAX_LLM_TIMEOUT_MS = 86_400_000;

/** Default deadline for an extraction or maintenance LLM call. */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
/** Default deadline for the LLM call behind a 'summary' or 'answer' recall. */
export const DEFAULT_LLM_FORMAT_TIMEOUT_MS = 20_000;
/** Default per-process LLM call budget. */
export const DEFAULT_LLM_MAX_CALLS = 500;
/** Default per-process LLM token budget (prompt plus completion tokens). */
export const DEFAULT_LLM_MAX_TOKENS = 1_000_000;

/** The database path when MEMORY_DB_PATH is not set. */
export function defaultDbPath(): string {
  return resolve(homedir(), '.local', 'share', 'memory-mcp', 'default.db');
}

/** Longest MEMORY_SESSION_ID / MEMORY_WRITER_SCOPE accepted (host ids, not free text). */
const MAX_SESSION_ID_LENGTH = 200;

/** Printable ASCII without spaces only: these ids are shown in inspect output. */
function isHostId(value: string): boolean {
  return value.length <= MAX_SESSION_ID_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

/**
 * The writer the host declared for this server. An unknown kind or a malformed
 * session id or scope is a host configuration error: the server refuses to start
 * rather than store rows under a provenance it cannot vouch for.
 *
 * An unattended writer (cron, workflow) always has a scope: the one the host gave
 * (MEMORY_WRITER_SCOPE, for example `job:<id>`), else its session (`session:<id>`),
 * else its kind. Its memories wait for review under that scope (utils/review.ts).
 */
function loadWriter(env: EnvSource): MemoryWriter | null {
  const kind = env.MEMORY_WRITER_KIND;
  const sessionId = env.MEMORY_SESSION_ID;
  const scope = env.MEMORY_WRITER_SCOPE;
  if (kind === undefined || kind === '') {
    if ((sessionId !== undefined && sessionId !== '') || (scope !== undefined && scope !== '')) {
      throw new Error('MEMORY_SESSION_ID or MEMORY_WRITER_SCOPE is set without MEMORY_WRITER_KIND');
    }
    return null;
  }
  if (!(MEMORY_WRITER_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`MEMORY_WRITER_KIND must be one of: ${MEMORY_WRITER_KINDS.join(', ')}`);
  }
  const writer: MemoryWriter = { kind: kind as MemoryWriterKind };
  if (sessionId !== undefined && sessionId !== '') {
    if (!isHostId(sessionId)) {
      throw new Error(`MEMORY_SESSION_ID must be 1-${MAX_SESSION_ID_LENGTH} printable ASCII characters without spaces`);
    }
    writer.session_id = sessionId;
  }
  if (scope !== undefined && scope !== '') {
    if (!isHostId(scope)) {
      throw new Error(
        `MEMORY_WRITER_SCOPE must be 1-${MAX_SESSION_ID_LENGTH} printable ASCII characters without spaces`,
      );
    }
    if (kind === 'interactive') {
      throw new Error('MEMORY_WRITER_SCOPE is only for unattended writers (cron, workflow)');
    }
    writer.scope = scope;
  } else if (kind !== 'interactive') {
    writer.scope = writer.session_id === undefined ? kind : `session:${writer.session_id}`;
  }
  return writer;
}

export function loadConfig(env: EnvSource = process.env): MemoryConfig {
  const embeddingModel = env.MEMORY_EMBEDDING_MODEL ?? 'Xenova/bge-base-en-v1.5';

  return {
    dbPath: env.MEMORY_DB_PATH ?? defaultDbPath(),
    namespace: env.MEMORY_NAMESPACE ?? 'default',
    writer: loadWriter(env),

    embeddingModel,
    embeddingDtype: env.MEMORY_EMBEDDING_DTYPE ?? 'q8',
    embeddingDimensions: envPositiveInt(env, 'MEMORY_EMBEDDING_DIMENSIONS', embeddingDimensionsFor(embeddingModel)),

    modelsDir: loadModelsDir(env),
    modelsOffline: envBoolean(env, 'MEMORY_MODELS_OFFLINE', false),
    modelManifest: loadModelManifest(env),

    llmBaseUrl: env.MEMORY_LLM_BASE_URL ?? null,
    llmApiKey: env.MEMORY_LLM_API_KEY ?? null,
    llmModel: env.MEMORY_LLM_MODEL ?? 'claude-haiku-4-5-20251001',
    llmTimeoutMs: envPositiveInt(env, 'MEMORY_LLM_TIMEOUT_MS', DEFAULT_LLM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS),
    llmFormatTimeoutMs: envPositiveInt(
      env,
      'MEMORY_LLM_FORMAT_TIMEOUT_MS',
      DEFAULT_LLM_FORMAT_TIMEOUT_MS,
      MAX_LLM_TIMEOUT_MS,
    ),
    llmMaxCalls: envPositiveInt(env, 'MEMORY_LLM_MAX_CALLS', DEFAULT_LLM_MAX_CALLS),
    llmMaxTokens: envPositiveInt(env, 'MEMORY_LLM_MAX_TOKENS', DEFAULT_LLM_MAX_TOKENS),

    decayThreshold: envFloat(env, 'MEMORY_DECAY_THRESHOLD', 0.05),
    maintenanceInterval: envInt(env, 'MEMORY_MAINTENANCE_INTERVAL', 50),
    compactionMinGroup: envInt(env, 'MEMORY_COMPACTION_MIN_GROUP', 10),

    consolidationBatchSize: envInt(env, 'MEMORY_CONSOLIDATION_BATCH_SIZE', 50),

    defaultTokenBudget: envInt(env, 'MEMORY_DEFAULT_TOKEN_BUDGET', 800),

    rerankerModel: env.MEMORY_RERANKER_MODEL ?? 'Xenova/ms-marco-MiniLM-L-6-v2',
    rerankerEnabled: env.MEMORY_RERANKER_ENABLED !== 'false',
  };
}
