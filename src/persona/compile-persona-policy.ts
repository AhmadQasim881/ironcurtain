/**
 * Persona policy compiler -- compiles a persona's constitution into
 * enforceable policy rules.
 *
 * Thin wrapper over PipelineRunner, following the same pattern as
 * compileTaskPolicy() in src/cron/compile-task-policy.ts. The key
 * difference is constitutionKind: 'constitution' (broad principles)
 * vs 'task-policy' (task-specific whitelist).
 *
 * This is the SANCTIONED pipeline value-import seam (see
 * test/pipeline-import-boundary.test.ts + the ESLint no-restricted-imports
 * rule). It is reached ONLY via `await import(...)` from
 * persona-compile-service.ts (`runPersonaCompile`), the one path CLI and
 * web-UI compiles share, which holds the compile lock, passes the
 * broad-policy validator as `validateCompiled` and writes the audit record.
 * Calling it directly would skip all three; test/persona-compile-paths.test.ts
 * keeps it the only importer, and the boundary test fails when another
 * persona module, the web UI or a live-runtime module reaches it (or any
 * pipeline module) statically.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PipelineRunner, createPipelineModels, type PipelineModels } from '../pipeline/pipeline-runner.js';
import { loadConfig, getPackageGeneratedDir } from '../config/index.js';
import { getUserGeneratedDir } from '../config/paths.js';
import {
  getPersonaConstitutionPath,
  getPersonaGeneratedDir,
  getPersonaWorkspaceDir,
  loadPersona,
  applyServerAllowlist,
} from './resolve.js';
import type { PersonaName } from './types.js';
import type { CompiledPolicyFile, CompiledPolicyValidator } from '../pipeline/types.js';
import type { ServerProgressReporter } from '../pipeline/pipeline-shared.js';

/**
 * Options for a persona compile. Threads the long-running concerns through to
 * `PipelineRunner.run`. All fields are optional; absent => no reporter factory
 * (console output), no signal, not quiet, MCP lists allowed,
 * workspace-bound allowedDirectory. `runPersonaCompile` always passes a
 * signal (its wall-clock cap), an operationId and `validateCompiled`.
 */
export interface CompilePersonaOptions {
  /** Per-server progress reporter factory (the EventBusProgressReporter). */
  readonly reporterFactory?: (serverName: string) => ServerProgressReporter;
  /** Cooperative cancellation (wall-clock cap / shutdown). */
  readonly signal?: AbortSignal;
  /** Suppress narrative stderr; requires a reporterFactory. */
  readonly quiet?: boolean;
  /**
   * Operation id used to scope the per-op LLM interaction log to
   * `generated/llm-interactions/<operationId>.jsonl`.
   */
  readonly operationId?: string;
  /**
   * Whether the list resolver may connect to live MCP servers. The WS path
   * passes false (no live MCP) so MCP-backed lists fail fast; the CLI passes
   * true.
   */
  readonly allowMcpLists?: boolean;
  /**
   * Sandbox boundary for structural invariant checks. Defaults to the
   * persona's workspace dir (stable, persona-bound). Per spike A9 this is for
   * cache/log stability only — it is NOT the runtime containment authority.
   */
  readonly allowedDirectory?: string;
  /**
   * Optional validation hook invoked on the in-memory compiled policy BEFORE any
   * artifact is written (threads through to `PipelineRunner.run`), with the
   * resolved dynamic lists and the stored tool annotations the compile used.
   * Throwing rejects the compile and leaves prior artifacts intact.
   * `runPersonaCompile` uses this to enforce the broad-policy invariant on
   * every compile (reject broad wildcard domains/lists, out-of-workspace
   * `paths.within` and allow rules that leave a resource argument
   * unconstrained, unless the persona is opted in).
   */
  readonly validateCompiled?: CompiledPolicyValidator;
  /**
   * TEST-ONLY injection seam: pre-built PipelineModels (fake LLM). When absent,
   * `createPipelineModels` is called (real provider). Production callers never
   * pass this.
   */
  readonly models?: PipelineModels;
}

/**
 * Compiles a persona's constitution.md into policy rules, writing
 * output to the persona's generated/ directory.
 *
 * Reads tool annotations from the global generated dir (annotations
 * are server-level, not persona-level). When the persona has a server
 * allowlist, only filtered servers are passed to the pipeline so the
 * compiled policy only references relevant tools.
 */
export async function compilePersonaPolicy(
  name: PersonaName,
  opts: CompilePersonaOptions = {},
): Promise<CompiledPolicyFile> {
  const config = loadConfig();
  const outputDir = getPersonaGeneratedDir(name);
  const constitutionPath = getPersonaConstitutionPath(name);
  const constitutionText = readFileSync(constitutionPath, 'utf-8');
  const annotationsDir = getUserGeneratedDir();

  // Per-operation LLM log path when an operationId is supplied:
  // `generated/llm-interactions/<operationId>.jsonl`. The pipeline truncates the
  // file when it initializes the log (createLlmLoggingMiddleware -> preparePrivateLogFile)
  // and appends thereafter; because the operationId is interpolated into the
  // FILENAME (not just used as a presence check), each compile writes to its own
  // fresh file, so concurrent/successive compiles of the same persona never
  // co-mingle or clobber one another. Without an operationId, the pipeline
  // default (`<outputDir>/llm-interactions.jsonl`) applies.
  const logDir = opts.operationId ? resolve(outputDir, 'llm-interactions') : outputDir;
  const logFileName = opts.operationId ? `${opts.operationId}.jsonl` : undefined;
  const models = opts.models ?? (await createPipelineModels(logDir, logFileName));
  const runner = new PipelineRunner(models);

  // Apply server allowlist if the persona specifies one
  let mcpServers = config.mcpServers;
  const persona = loadPersona(name);
  if (persona.servers) {
    mcpServers = applyServerAllowlist(mcpServers, persona.servers);
  }

  // allowedDirectory defaults to the persona workspace dir (stable, persona-
  // bound) rather than the daemon's process.env.ALLOWED_DIRECTORY fallback.
  const allowedDirectory = opts.allowedDirectory ?? getPersonaWorkspaceDir(name);

  // The policy lint (pipeline/policy-lint.ts) rejects broad domain access
  // unless the persona carries the gated broad-policy opt-in. A directive in
  // the persona constitution does not count: it can be drafted by an LLM
  // from untrusted content.
  const allowBroadDomains = persona.allowBroadPolicy === true;

  return runner.run({
    constitutionInput: constitutionText,
    constitutionKind: 'constitution',
    outputDir,
    toolAnnotationsDir: annotationsDir,
    toolAnnotationsFallbackDir: getPackageGeneratedDir(),
    allowedDirectory,
    protectedPaths: config.protectedPaths,
    mcpServers,
    // The universal invariants (writes and moves under /etc must not be
    // allowed) hold for every persona; they are the only scenarios the
    // persona constitution and the policy under test cannot shape.
    includeHandwrittenScenarios: true,
    prefilterText: constitutionText,
    allowBroadDomains,
    ...(opts.reporterFactory ? { reporterFactory: opts.reporterFactory } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.quiet !== undefined ? { quiet: opts.quiet } : {}),
    ...(opts.allowMcpLists !== undefined ? { allowMcpLists: opts.allowMcpLists } : {}),
    ...(opts.validateCompiled ? { validateCompiled: opts.validateCompiled } : {}),
  });
}
