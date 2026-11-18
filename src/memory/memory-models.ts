/**
 * The memory server's model store, from IronCurtain's side.
 *
 * Every memory server keeps its embedding and re-ranking models in
 * `~/.ironcurtain/models` ({@link resolveMemoryModelsDir}). It downloads only
 * the pinned commit of each model and only the pinned files, checks every
 * file's size and SHA-256 when it installs it and again before each load,
 * and refuses anything else (packages/memory-mcp-server/src/models/). With
 * `memory.offlineModels` it never downloads at all.
 *
 * This module asks the bundled server to check that store (`ironcurtain
 * doctor`) or to fill it ahead of time (`ironcurtain memory prefetch`, for
 * example before taking a machine offline). It runs the server's entry point
 * with `--verify-models` or `--prefetch-models` and reads the JSON report the
 * server prints, so the pins and the verification stay in one place: the
 * memory server package.
 *
 * The server's entry point comes from memory-annotations.ts, which resolves it
 * when that module loads and throws if the package is missing or unbuilt. It is
 * therefore imported only when the tool runs: `ironcurtain doctor` (which
 * imports this module) must still start and report a broken memory server
 * instead of crashing before its first check.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import { inheritedEnv, type HostEnv } from '../trusted-process/child-env.js';
import { getTrustedSpawnCwd } from '../trusted-process/spawn-cwd.js';
import { resolveMemoryModelsDir } from './resolve-memory-path.js';

export type MemoryModelsAction = 'verify' | 'prefetch';

/** What `memory-mcp-server --verify-models | --prefetch-models` prints (its models/cli.ts). */
const memoryModelsReportSchema = z.object({
  action: z.enum(['verify', 'prefetch']),
  modelsDir: z.string(),
  offline: z.boolean(),
  models: z.array(
    z.object({
      role: z.enum(['embedding', 'reranker']),
      repo: z.string(),
      dtype: z.string(),
      status: z.enum(['ok', 'downloaded', 'missing', 'invalid', 'unpinned', 'error']),
      revision: z.string().optional(),
      detail: z.string().optional(),
    }),
  ),
});

export type MemoryModelsReport = z.infer<typeof memoryModelsReportSchema>;
export type MemoryModelEntry = MemoryModelsReport['models'][number];

/** The server's report and exit status, or why there is no report. */
export type MemoryModelsResult =
  | { readonly kind: 'report'; readonly report: MemoryModelsReport; readonly exitCode: number }
  | { readonly kind: 'failed'; readonly reason: string };

export interface MemoryModelsRunOptions {
  /** Default: {@link resolveMemoryModelsDir}. */
  readonly modelsDir?: string;
  /** Pass the server's progress lines through to this process's stderr (prefetch). */
  readonly showProgress?: boolean;
  readonly timeoutMs?: number;
}

export type MemoryModelsRunner = (
  action: MemoryModelsAction,
  options?: MemoryModelsRunOptions,
) => Promise<MemoryModelsResult>;

/** Verifying hashes about 135 MB of models; generous for slow disks. */
const VERIFY_TIMEOUT_MS = 120_000;
/** Downloads have their own stall timeout in the server; this only bounds a wedged process. */
const PREFETCH_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_CHARS = 1_000_000;

/**
 * The environment the models tool runs with: the allowlist every child
 * IronCurtain spawns inherits (home, locale, proxies and trust anchors for the
 * download; never credentials), plus the model store's location.
 */
export function memoryModelsEnv(modelsDir: string, hostEnv: HostEnv = process.env): Record<string, string> {
  return { ...inheritedEnv(hostEnv), MEMORY_MODELS_DIR: modelsDir };
}

/** The report in the last line of `stdout` that parses as one, if any. */
export function parseMemoryModelsReport(stdout: string): MemoryModelsReport | undefined {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  for (const line of lines.reverse()) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = memoryModelsReportSchema.safeParse(json);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function lastLine(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines.at(-1) ?? '';
}

/** Why there is no report from a memory server that predates the model store. */
export const OUTDATED_MEMORY_SERVER_REASON =
  'the installed @provos/memory-mcp-server predates pinned, verified models (it has no --verify-models); ' +
  'update it to the version this IronCurtain release depends on';

/**
 * The bundled memory server's entry point, if it has the model store; else
 * why it cannot be used. Loads memory-annotations.ts, which throws when the
 * package cannot be resolved (missing, or not built in a checkout).
 */
async function modelsToolEntry(): Promise<{ readonly entry: string } | { readonly reason: string }> {
  let annotations;
  try {
    annotations = await import('./memory-annotations.js');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Node's resolution errors append the require stack on further lines.
    return { reason: `the memory server package could not be loaded: ${message.split('\n')[0]}` };
  }
  if (!annotations.memoryServerHasModelStore()) {
    return { reason: OUTDATED_MEMORY_SERVER_REASON };
  }
  return { entry: annotations.MEMORY_SERVER_ENTRY };
}

/**
 * Runs the bundled memory server's models tool (`node <entry>
 * --verify-models | --prefetch-models`, argv only, from IronCurtain's own
 * directory) and returns its report. A memory server that predates the model
 * store is not started at all: it would ignore the flag and run as an MCP
 * server instead.
 */
export const runMemoryModelsTool: MemoryModelsRunner = async (action, options = {}) => {
  const tool = await modelsToolEntry();
  if ('reason' in tool) {
    return { kind: 'failed', reason: tool.reason };
  }
  const modelsDir = options.modelsDir ?? resolveMemoryModelsDir();
  const flag = action === 'verify' ? '--verify-models' : '--prefetch-models';
  const timeoutMs = options.timeoutMs ?? (action === 'verify' ? VERIFY_TIMEOUT_MS : PREFETCH_TIMEOUT_MS);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tool.entry, flag], {
      cwd: getTrustedSpawnCwd(),
      env: memoryModelsEnv(modelsDir),
      stdio: ['ignore', 'pipe', options.showProgress === true ? 'inherit' : 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf-8').on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr?.setEncoding('utf-8').on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ kind: 'failed', reason: `could not run the memory server: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          kind: 'failed',
          reason: `the memory server did not finish within ${Math.round(timeoutMs / 1000)} s`,
        });
        return;
      }
      const report = parseMemoryModelsReport(stdout);
      if (report !== undefined) {
        resolve({ kind: 'report', report, exitCode: code ?? 1 });
        return;
      }
      const why = lastLine(stderr);
      resolve({
        kind: 'failed',
        reason: `the memory server printed no model report (exit status ${code ?? 'none'})${why === '' ? '' : `: ${why}`}`,
      });
    });
  });
};
