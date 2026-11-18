/**
 * Memory MCP server name constant and server configuration builder.
 *
 * The memory server is registered as a "trusted server" in the PolicyEngine:
 * it needs no annotations or compiled rules, and its tools are judged per tool
 * by the hardcoded trusted-server policy (`src/trusted-process/
 * trusted-server-policy.ts`): reads and single-fact writes are allowed, bulk
 * forgets and large ingests escalate to a human.
 *
 * Every memory server IronCurtain spawns is told which kind of session it
 * serves (MEMORY_WRITER_KIND: interactive, cron or workflow) and that
 * session's id (MEMORY_SESSION_ID). The server stamps both into every memory
 * it stores (`metadata.writer`), so a note can be traced to the session that
 * wrote it. The agent cannot set or change either value.
 *
 * An unattended session (cron, workflow) is also given its review scope
 * (MEMORY_WRITER_SCOPE: `job:<id>` or `workflow:<run id>`). What it writes
 * waits for review: no session sees it but the same scope's later runs (a
 * cron job sees what its earlier runs wrote) until the user approves it with
 * `ironcurtain memory <persona|job> review`. The memory server does that, so
 * an unattended session refuses to start one that predates the quarantine
 * (memory-server-exports.ts).
 */

import { createRequire } from 'node:module';
import type { MCPServerConfig } from '../config/types.js';
import * as logger from '../logger.js';
import { resolveMemoryLlm, type MemoryLlmEndpoint } from './memory-llm.js';
import { MEMORY_SERVER_NAME } from './memory-server-name.js';
import { UPDATE_MEMORY_SERVER_HINT, memoryServerHasReviewQuarantine } from './memory-server-exports.js';
import { resolveMemoryModelsDir } from './resolve-memory-path.js';

export { MEMORY_SERVER_NAME };

/**
 * Resolved path to the memory-mcp-server entry point (computed once).
 *
 * Uses Node module resolution so the path works both in development
 * (workspace symlink) and production (installed from npm).
 */
export const MEMORY_SERVER_ENTRY = createRequire(import.meta.url).resolve('@provos/memory-mcp-server');

/**
 * Whether the installed memory server has the verified model store (pinned,
 * hash-checked models in MEMORY_MODELS_DIR, and the `--verify-models` /
 * `--prefetch-models` flags): it then exports `./models`. A release from
 * before it (0.2.x) ignores both the store's variables and the flags, and
 * downloads unpinned models into node_modules.
 */
export function memoryServerHasModelStore(): boolean {
  try {
    createRequire(import.meta.url).resolve('@provos/memory-mcp-server/models');
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies that a server config named 'memory' matches the exact shape
 * produced by buildMemoryServerConfig(). If the config exists but doesn't
 * match, the process cannot safely trust it — this is a fatal error.
 *
 * Returns true if the config is verified as our memory server,
 * false if no 'memory' server is configured.
 * Throws if a 'memory' server exists but has an unexpected shape.
 */
export function verifyMemoryServerConfig(mcpServers: Record<string, MCPServerConfig>): boolean {
  if (!(MEMORY_SERVER_NAME in mcpServers)) return false;

  const config = mcpServers[MEMORY_SERVER_NAME];
  if (config.command === 'node' && config.args.length === 1 && config.args[0] === MEMORY_SERVER_ENTRY) {
    return true;
  }

  throw new Error(
    `MCP server "${MEMORY_SERVER_NAME}" has unexpected config ` +
      `(command=${JSON.stringify(config.command)}, args=${JSON.stringify(config.args)}). ` +
      `Expected command="node" with args=[${JSON.stringify(MEMORY_SERVER_ENTRY)}]. ` +
      `The memory server config appears tampered or misconfigured.`,
  );
}

/**
 * Builds the set of trusted server names from the MCP server config.
 * Currently only the memory server can be trusted, verified by exact
 * command/args match. Throws if a 'memory' server exists with an
 * unexpected shape.
 */
export function buildTrustedServerSet(mcpServers: Record<string, MCPServerConfig>): ReadonlySet<string> {
  const trusted = new Set<string>();
  if (verifyMemoryServerConfig(mcpServers)) {
    trusted.add(MEMORY_SERVER_NAME);
  }
  return trusted;
}

/**
 * The kind of session a memory server serves: `interactive` (a person drives
 * it), `cron` (a scheduled job, unattended) or `workflow` (a workflow state).
 */
export type MemoryWriterKind = 'interactive' | 'cron' | 'workflow';

/** The session a memory server writes for, as the server will record it. */
export interface MemoryWriter {
  readonly kind: MemoryWriterKind;
  /** IronCurtain's session id (printable ASCII without spaces, at most 200 characters). */
  readonly sessionId: string;
  /**
   * The review scope of an unattended writer (`job:<id>`, `workflow:<id>`; same
   * character rules as the session id). Required for cron and workflow writers,
   * refused for interactive ones (their memories need no review).
   */
  readonly scope?: string;
}

/** The review scope of a cron job's memory writes: its later runs see them before review. */
export function cronMemoryScope(jobId: string): string {
  return `job:${jobId}`;
}

/** The review scope of a workflow run's memory writes: its later states see them before review. */
export function workflowMemoryScope(workflowRunId: string): string {
  return `workflow:${workflowRunId}`;
}

/** Inputs for the memory server's config and credentials. */
export interface MemoryServerOptions {
  dbPath: string;
  namespace?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  anthropicApiKey?: string;
  /** The resolved Anthropic API root (`userConfig.anthropicBaseUrl`); empty for Anthropic itself. */
  anthropicBaseUrl?: string;
  /** Who the server writes for (MEMORY_WRITER_KIND / MEMORY_SESSION_ID). */
  writer?: MemoryWriter;
  /** The model store (MEMORY_MODELS_DIR); default `~/.ironcurtain/models`. */
  modelsDir?: string;
  /**
   * Never download models (`memory.offlineModels`, MEMORY_MODELS_OFFLINE): a
   * model missing from the store is an error that says to run `ironcurtain
   * memory prefetch`.
   */
  offlineModels?: boolean;
}

/** What the memory server accepts as MEMORY_SESSION_ID (see its config.ts). */
const SESSION_ID_PATTERN = /^[\x21-\x7e]{1,200}$/;

/** The memory server's LLM endpoint and key (see `memory-llm.ts` for which key may go where). */
function memoryLlm(opts: MemoryServerOptions): MemoryLlmEndpoint {
  return resolveMemoryLlm({
    llmBaseUrl: opts.llmBaseUrl,
    llmApiKey: opts.llmApiKey,
    anthropicApiKey: opts.anthropicApiKey,
    anthropicBaseUrl: opts.anthropicBaseUrl,
  });
}

/**
 * Builds the MCP server config for the memory server.
 *
 * The server runs as a Node.js subprocess using the compiled
 * memory-mcp-server package entry point. Configuration is passed via
 * environment variables. The LLM API key is deliberately NOT part of this
 * config: it travels through the per-server credentials channel
 * ({@link buildMemoryServerCredentials}), so it is never serialized with the
 * server configuration (session metadata, MCP_SERVERS_CONFIG) and reaches
 * exactly one process, the memory server.
 *
 * The server's models live in `~/.ironcurtain/models` (MEMORY_MODELS_DIR), not
 * inside node_modules: it downloads only the pinned revision of each model,
 * only the pinned files, and checks every file's SHA-256 when it installs it
 * and again before each load. With `offlineModels` it never downloads.
 *
 * Throws for a cron or workflow writer when the installed memory server
 * predates the review quarantine (memoryServerHasReviewQuarantine): it would
 * ignore MEMORY_WRITER_SCOPE and file what the unattended run writes among the
 * memories interactive sessions see. Interactive writers are not affected.
 */
export function buildMemoryServerConfig(opts: MemoryServerOptions): MCPServerConfig {
  const env: Record<string, string> = {
    MEMORY_DB_PATH: opts.dbPath,
    MEMORY_MODELS_DIR: opts.modelsDir ?? resolveMemoryModelsDir(),
  };

  if (opts.offlineModels === true) {
    env.MEMORY_MODELS_OFFLINE = 'true';
  }

  if (opts.namespace) {
    env.MEMORY_NAMESPACE = opts.namespace;
  }

  if (opts.writer) {
    if (!SESSION_ID_PATTERN.test(opts.writer.sessionId)) {
      throw new Error('The memory server writer session id must be 1-200 printable ASCII characters without spaces');
    }
    env.MEMORY_WRITER_KIND = opts.writer.kind;
    env.MEMORY_SESSION_ID = opts.writer.sessionId;
    const scope = opts.writer.scope;
    if (opts.writer.kind === 'interactive') {
      if (scope !== undefined) throw new Error('An interactive memory writer has no review scope');
    } else {
      // Fail closed: an unattended writer without a scope would leave its
      // memories' audience to the server's session fallback.
      if (scope === undefined || !SESSION_ID_PATTERN.test(scope)) {
        throw new Error(
          'An unattended memory writer needs a review scope of 1-200 printable ASCII characters without spaces',
        );
      }
      // Fail closed, too, when the server would ignore the scope: a server from
      // before the review quarantine stores the run's memories as reviewed ones.
      if (!memoryServerHasReviewQuarantine()) {
        throw new Error(
          `Not starting the memory server for this ${opts.writer.kind === 'cron' ? 'cron job' : 'workflow'}: ` +
            'the installed @provos/memory-mcp-server predates the review quarantine, so what an unattended run ' +
            `writes would not wait for review and interactive sessions would see it. ${UPDATE_MEMORY_SERVER_HINT}`,
        );
      }
      env.MEMORY_WRITER_SCOPE = scope;
    }
  }

  const { baseUrl } = memoryLlm(opts);
  if (baseUrl) {
    env.MEMORY_LLM_BASE_URL = baseUrl;
  }

  return {
    command: 'node',
    args: [MEMORY_SERVER_ENTRY],
    env,
    description: 'Persistent memory with semantic search',
    sandbox: false,
  };
}

/**
 * The memory server's credentials (`MEMORY_LLM_API_KEY`), for
 * `userConfig.serverCredentials[MEMORY_SERVER_NAME]`: the session relay hands
 * them to the memory server's relay alone (SERVER_CREDENTIALS), which scrubs
 * the variable before spawning the server and injects the key into that
 * server's environment. Empty when no LLM key may be sent to the memory
 * endpoint (the server then runs without LLM-backed summarization, or calls
 * a keyless endpoint such as a local Ollama). The Anthropic key is included
 * only for the Anthropic route; for any other `memory.llmBaseUrl` it is
 * withheld, and the session log says so.
 */
export function buildMemoryServerCredentials(opts: MemoryServerOptions): Record<string, string> {
  const { apiKey, baseUrl, anthropicKeyWithheld } = memoryLlm(opts);
  if (anthropicKeyWithheld && baseUrl !== undefined) {
    logger.warn(
      `[memory] Not sending the Anthropic API key to memory.llmBaseUrl (${new URL(baseUrl).origin}): ` +
        'it is not the Anthropic endpoint IronCurtain uses. Set memory.llmApiKey if that endpoint needs a key.',
    );
  }
  return apiKey ? { MEMORY_LLM_API_KEY: apiKey } : {};
}
