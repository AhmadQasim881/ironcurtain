/**
 * `memory-mcp-server --prefetch-models` and `--verify-models`: fill or check
 * the verified model store without starting the MCP server.
 *
 * Both act on the models the server is configured to load (the embedding
 * model and, when re-ranking is on, the cross-encoder), in the models
 * directory the environment selects (MEMORY_MODELS_DIR). `--verify-models`
 * reads and hashes what is installed and never touches the network.
 * `--prefetch-models` downloads whatever is missing or does not match its pin,
 * even in offline mode (that is how an offline store is filled).
 *
 * Both print exactly one JSON report ({@link ModelsReport}) on stdout, which
 * IronCurtain's `doctor` and `memory prefetch` read, and progress on stderr.
 * Exit status: 0 when every configured model is installed and verified, 1
 * otherwise, 2 for a usage error.
 */

import { loadConfig, type MemoryConfig } from '../config.js';
import { RERANKER_DTYPE } from '../retrieval/reranker.js';
import {
  inspectModel,
  prefetchModel,
  requirePin,
  type ModelRef,
  type ModelStoreErrorCode,
  type ModelStoreOptions,
} from './model-store.js';

export type ModelRole = 'embedding' | 'reranker';

export interface ConfiguredModel extends ModelRef {
  readonly role: ModelRole;
}

/** The models a server with `config` loads. */
export function configuredModels(config: MemoryConfig): ConfiguredModel[] {
  const models: ConfiguredModel[] = [{ role: 'embedding', repo: config.embeddingModel, dtype: config.embeddingDtype }];
  if (config.rerankerEnabled) {
    models.push({ role: 'reranker', repo: config.rerankerModel, dtype: RERANKER_DTYPE });
  }
  return models;
}

/**
 * - `ok`: installed and verified; `downloaded`: fetched now and verified.
 * - `missing`: (verify only) some pinned files are not installed.
 * - `invalid`: an installed file does not match its pin.
 * - `unpinned`: no complete pin, so the model is never loaded.
 * - `error`: the download or the check failed (detail says why).
 */
export type ModelReportStatus = 'ok' | 'downloaded' | 'missing' | 'invalid' | 'unpinned' | 'error';

export interface ModelReportEntry {
  readonly role: ModelRole;
  readonly repo: string;
  readonly dtype: string;
  readonly status: ModelReportStatus;
  /** The pinned commit, when there is a complete pin. */
  readonly revision?: string;
  readonly detail?: string;
}

export interface ModelsReport {
  readonly action: 'verify' | 'prefetch';
  readonly modelsDir: string;
  readonly offline: boolean;
  readonly models: readonly ModelReportEntry[];
}

export const MODELS_CLI_USAGE = `Usage:
  memory-mcp-server                     Start the MCP server on stdio
  memory-mcp-server --prefetch-models   Download the pinned models (if missing) and verify them
  memory-mcp-server --verify-models     Check the installed models against their pins (no network)
  memory-mcp-server backups [--db <path>]          List the copies kept next to the database
  memory-mcp-server restore <copy> [--db <path>]   Restore the database from one of them

The models directory is MEMORY_MODELS_DIR (default: $XDG_CACHE_HOME/memory-mcp/models).
Prints a JSON report on stdout; exit status 0 when every model is installed and verified.
`;

function codeOf(err: unknown): ModelStoreErrorCode | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('MODEL_') ? (code as ModelStoreErrorCode) : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusForError(err: unknown): ModelReportStatus {
  switch (codeOf(err)) {
    case 'MODEL_UNPINNED':
      return 'unpinned';
    case 'MODEL_INTEGRITY':
      return 'invalid';
    default:
      return 'error';
  }
}

async function verifyOne(model: ConfiguredModel, options: ModelStoreOptions): Promise<ModelReportEntry> {
  const base = { role: model.role, repo: model.repo, dtype: model.dtype };
  try {
    const pin = requirePin(model, options.manifest);
    const inspection = await inspectModel(pin, options.modelsDir);
    switch (inspection.status) {
      case 'ok':
        return { ...base, revision: pin.revision, status: 'ok', detail: inspection.dir };
      case 'missing':
        return {
          ...base,
          revision: pin.revision,
          status: 'missing',
          detail: `not installed in ${inspection.dir} (missing: ${inspection.files.join(', ')})`,
        };
      case 'invalid':
        return {
          ...base,
          revision: pin.revision,
          status: 'invalid',
          detail: `${inspection.file} in ${inspection.dir} ${inspection.reason}`,
        };
    }
  } catch (err) {
    return { ...base, status: statusForError(err), detail: messageOf(err) };
  }
}

async function prefetchOne(model: ConfiguredModel, options: ModelStoreOptions): Promise<ModelReportEntry> {
  const base = { role: model.role, repo: model.repo, dtype: model.dtype };
  try {
    const pin = requirePin(model, options.manifest);
    const result = await prefetchModel(model, options);
    return { ...base, revision: pin.revision, status: result === 'cached' ? 'ok' : 'downloaded' };
  } catch (err) {
    return { ...base, status: statusForError(err), detail: messageOf(err) };
  }
}

/** Runs the models checks of `report.action` for `config`. */
export async function buildModelsReport(
  action: ModelsReport['action'],
  config: MemoryConfig,
  options: ModelStoreOptions,
): Promise<ModelsReport> {
  const models: ModelReportEntry[] = [];
  for (const model of configuredModels(config)) {
    models.push(action === 'verify' ? await verifyOne(model, options) : await prefetchOne(model, options));
  }
  return { action, modelsDir: options.modelsDir, offline: config.modelsOffline, models };
}

function reportOk(report: ModelsReport): boolean {
  return report.models.every((model) => model.status === 'ok' || model.status === 'downloaded');
}

function describeEntry(entry: ModelReportEntry): string {
  const name = `${entry.role} model ${entry.repo} (${entry.dtype})`;
  switch (entry.status) {
    case 'ok':
      return `ok: ${name} is installed and verified`;
    case 'downloaded':
      return `ok: ${name} was downloaded and verified`;
    case 'unpinned':
    case 'error':
      // The detail is the store's error message, which names the model.
      return `${entry.status.toUpperCase()} (${entry.role}): ${entry.detail ?? name}`;
    default:
      return `${entry.status.toUpperCase()}: ${name}${entry.detail === undefined ? '' : `: ${entry.detail}`}`;
  }
}

export interface ModelsCliIo {
  readonly env: Record<string, string | undefined>;
  /** Writes the JSON report; resolves once it is flushed. */
  readonly stdout: (text: string) => Promise<void>;
  readonly stderr: (line: string) => void;
  /** Injected in tests. */
  readonly fetchImpl?: typeof fetch;
}

const ACTIONS: ReadonlyMap<string, ModelsReport['action']> = new Map([
  ['--prefetch-models', 'prefetch'],
  ['--verify-models', 'verify'],
]);

/**
 * Runs the command line `argv` (the arguments after the script) asks for:
 * `--prefetch-models`, `--verify-models` or `--help`. Returns the exit status.
 */
export async function runModelsCli(argv: readonly string[], io: ModelsCliIo): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    await io.stdout(MODELS_CLI_USAGE);
    return 0;
  }
  const action = argv.length === 1 ? ACTIONS.get(argv[0]) : undefined;
  if (action === undefined) {
    io.stderr(`memory-mcp-server: unknown arguments: ${argv.join(' ')}`);
    io.stderr(MODELS_CLI_USAGE);
    return 2;
  }

  let config: MemoryConfig;
  try {
    config = loadConfig(io.env);
  } catch (err) {
    io.stderr(`memory-mcp-server: ${messageOf(err)}`);
    return 1;
  }
  const options: ModelStoreOptions = {
    modelsDir: config.modelsDir,
    manifest: config.modelManifest,
    offline: config.modelsOffline,
    log: io.stderr,
    fetchImpl: io.fetchImpl,
  };

  const report = await buildModelsReport(action, config, options);
  for (const entry of report.models) {
    io.stderr(describeEntry(entry));
  }
  await io.stdout(`${JSON.stringify(report)}\n`);
  return reportOk(report) ? 0 : 1;
}
