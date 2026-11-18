/**
 * Task policy compiler -- compiles policy rules from an English task
 * description. Two convenience wrappers over PipelineRunner in 'task-policy'
 * mode:
 *
 * - `compileTaskPolicy()`: a cron job's own policy, compiled, verified and
 *   repaired into the job's `generated/` directory. It REPLACES the global
 *   policy for the job's runs.
 * - `compileTaskScopePolicy()`: the task scope of a `--task-scoped` session
 *   (`ironcurtain start`, a mux `/new`, a workflow run). It NARROWS the
 *   session policy (the engine intersects the two; see
 *   `src/config/task-scope-policy.ts`), is compiled once per task and cached.
 *
 * Both load MCP server configs via loadConfig() to preserve the structural
 * domain-gate protection for URL-role arguments.
 *
 * This is a SANCTIONED pipeline value-import seam (see
 * test/pipeline-import-boundary.test.ts): CLI entry points reach it through
 * `await import(...)`, and nothing on the live runtime path (session,
 * sandbox, trusted process, workflow orchestrator) imports it.
 */

import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { PipelineRunner, createPipelineModels, type PipelineModels } from '../pipeline/pipeline-runner.js';
import { loadStoredToolAnnotationsFile, type ServerProgressReporter } from '../pipeline/pipeline-shared.js';
import { getPackageGeneratedDir, loadConfig, loadPersonaPolicyArtifacts } from '../config/index.js';
import {
  getJobDir,
  getJobWorkspaceDir,
  getTaskPoliciesDir,
  getTaskPolicyDir,
  getUserGeneratedDir,
} from '../config/paths.js';
import { hashConstitutionText } from '../config/constitution-hash.js';
import {
  TASK_SCOPE_FORMAT_VERSION,
  TASK_SCOPE_RECORD_FILENAME,
  checkTaskScopeDir,
  type TaskScopeRecord,
} from '../config/task-scope-policy.js';
import { writeStableJsonAtomic } from '../hardened-fs.js';
import { POLICY_COMPILER_EPOCH } from '../policy-artifacts/provenance.js';
import type { IronCurtainConfig } from '../config/types.js';
import type { CompiledPolicyFile, StoredToolAnnotationsFile } from '../pipeline/types.js';
import { expandTilde } from '../types/argument-roles.js';
import type { JobDefinition } from './types.js';

/** The fields of a job that its policy compile reads. */
export type TaskPolicyJob = Pick<JobDefinition, 'id' | 'taskConstitution' | 'workspace'>;

/**
 * The directory a job's sessions run in: its custom `workspace`, or the
 * default `~/.ironcurtain/jobs/<id>/workspace/`. The policy is compiled and
 * linted against this directory, so it must be the one the daemon uses. A
 * leading `~` is expanded as validateWorkspacePath and the engine expand it
 * (a hand-edited job.json may say `~/repos/x`); plain resolve() would put it
 * under the working directory.
 */
export function getJobRunWorkspace(job: Pick<JobDefinition, 'id' | 'workspace'>): string {
  return resolve(job.workspace !== undefined ? expandTilde(job.workspace) : getJobWorkspaceDir(job.id));
}

/**
 * Compiles a job's task-scoped policy from its task constitution into
 * `<jobDir>/generated/`.
 *
 * The sandbox for the compile (the structural workspace containment the
 * prompt describes, the verifier's engine and the policy lint) is the job's
 * real workspace (see getJobRunWorkspace). The task text is drafted from
 * untrusted input, so it cannot opt the policy in to broad domain access.
 *
 * @param job The job whose policy to compile.
 * @param globalAnnotationsDir Directory containing tool-annotations.json (defaults to user generated dir).
 */
export async function compileTaskPolicy(
  job: TaskPolicyJob,
  globalAnnotationsDir?: string,
): Promise<CompiledPolicyFile> {
  const config = loadConfig();
  const outputDir = resolve(getJobDir(job.id), 'generated');
  const annotationsDir = globalAnnotationsDir ?? getUserGeneratedDir();
  const models = await createPipelineModels(outputDir);
  const runner = new PipelineRunner(models);

  return runner.run({
    constitutionInput: job.taskConstitution,
    constitutionKind: 'task-policy',
    outputDir,
    toolAnnotationsDir: annotationsDir,
    toolAnnotationsFallbackDir: getPackageGeneratedDir(),
    allowedDirectory: getJobRunWorkspace(job),
    protectedPaths: config.protectedPaths,
    mcpServers: config.mcpServers,
    // The universal invariants (writes and moves under /etc must not be
    // allowed) hold for every task policy too: the task text is drafted from
    // untrusted input and cannot waive them.
    includeHandwrittenScenarios: true,
    prefilterText: job.taskConstitution,
    allowBroadDomains: false,
  });
}

// ---------------------------------------------------------------------------
// Task scopes (`--task-scoped`)
// ---------------------------------------------------------------------------

/**
 * The directory a task-scope compile is told is structurally allowed when
 * the session has no `--workspace`: a fresh session's sandbox path is not
 * known before the session exists. Fixed, so the cache key stays stable;
 * the compiler never emits rules for it, and at run time sandbox
 * containment uses the session's real directory. Never created.
 */
const SANDBOX_PLACEHOLDER = 'session-sandbox';

/** Options for {@link compileTaskScopePolicy}. */
export interface CompileTaskScopeOptions {
  /**
   * The validated workspace the session will run in (`--workspace`). The
   * compile is told it is structurally allowed, and it is part of the cache
   * key. Absent for a fresh sandbox.
   */
  readonly workspacePath?: string;
  /** Loaded config (servers, protected paths, annotations). Defaults to `loadConfig()`. */
  readonly config?: IronCurtainConfig;
  /** Narrative progress lines (only used when `quiet`). */
  readonly onProgress?: (message: string) => void;
  /** Suppress the pipeline's stderr output; requires `reporterFactory`. */
  readonly quiet?: boolean;
  /** Per-server progress reporter factory. */
  readonly reporterFactory?: (serverName: string) => ServerProgressReporter;
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
  /**
   * TEST-ONLY injection seam: pre-built PipelineModels (fake LLM). When
   * absent, `createPipelineModels` is called (real provider). Production
   * callers never pass this.
   */
  readonly models?: PipelineModels;
}

/** Result of {@link compileTaskScopePolicy}. */
export interface TaskScopeCompileResult {
  /** The published task-scope directory, to pass as `taskPolicyDir`. */
  readonly policyDir: string;
  readonly record: TaskScopeRecord;
  /** The task scope's compiled policy (as published). */
  readonly policy: CompiledPolicyFile;
  /** True when a complete scope compiled earlier for the same inputs was reused (no LLM call). */
  readonly cached: boolean;
}

/** Inputs of the task-scope cache key. */
export interface TaskScopeKeyInput {
  readonly task: string;
  readonly allowedDirectory: string;
  readonly protectedPaths: readonly string[];
  readonly annotations: StoredToolAnnotationsFile;
  /** Generation of the policy compiler. Defaults to this IronCurtain's `POLICY_COMPILER_EPOCH`. */
  readonly compilerEpoch?: number;
}

/**
 * The cache key of a task scope: a SHA-256 over everything its compile
 * depends on (the trimmed task text, the directory the compile treats as
 * the workspace, the protected paths and the tool annotations of every
 * configured server) plus the format version and the policy compiler epoch.
 * The same task in another workspace, after `annotate-tools` changed a
 * server, or after an upgrade that bumped the compiler epoch (a compiler fix
 * worth rebuilding for, which recompiles every per-server compile cache too)
 * compiles anew.
 */
export function computeTaskScopeKey(input: TaskScopeKeyInput): string {
  const servers = Object.keys(input.annotations.servers)
    .sort()
    .map((name) => [name, input.annotations.servers[name].tools]);
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: TASK_SCOPE_FORMAT_VERSION,
        compilerEpoch: input.compilerEpoch ?? POLICY_COMPILER_EPOCH,
        task: input.task,
        allowedDirectory: input.allowedDirectory,
        protectedPaths: [...input.protectedPaths].sort(),
        servers,
      }),
    )
    .digest('hex');
}

/**
 * Compiles (or reuses) the task scope of a `--task-scoped` session from its
 * task text. Called by the CLI entry points before the session is created;
 * the returned `policyDir` goes into the session as `taskPolicyDir`.
 *
 * Kept light so the first start stays acceptable: the cheap pre-filter
 * model first selects the servers the task needs (the others get no rules,
 * so every call to them escalates as out of scope), and only those servers
 * are compiled, with the strict task-policy prompt (the minimum tools,
 * paths and domains the task needs) and WITHOUT scenario generation,
 * verification or repair (`skipVerification`). That is safe because the
 * engine intersects the scope with the session policy: a wrong or missing
 * task rule can only escalate a call the session policy allows, never
 * allow one it does not.
 *
 * Cached by {@link computeTaskScopeKey} under `{home}/task-policies/{key}/`:
 * a later session with the same task and inputs reuses the published scope
 * without any LLM call. A compile runs in a private temporary directory
 * that is renamed into place only when complete, so a crash or a
 * concurrent compile never leaves a half-written scope where a session
 * could load it. A scope with a server that failed to compile is published
 * for this session but marked incomplete, so the next session compiles
 * again instead of reusing it.
 *
 * @throws Error when the task text is empty, the tool annotations are
 *   missing, or the compile fails (no LLM, every server failed, aborted).
 */
export async function compileTaskScopePolicy(
  taskDescription: string,
  options: CompileTaskScopeOptions = {},
): Promise<TaskScopeCompileResult> {
  const task = taskDescription.trim();
  if (task === '') {
    throw new Error('A task-scoped session needs a task description to compile its scope from');
  }
  const config = options.config ?? loadConfig();
  const annotations = loadConfiguredServerAnnotations(config);
  const root = getTaskPoliciesDir();
  const allowedDirectory = options.workspacePath ?? resolve(root, SANDBOX_PLACEHOLDER);
  const key = computeTaskScopeKey({ task, allowedDirectory, protectedPaths: config.protectedPaths, annotations });
  const policyDir = getTaskPolicyDir(key);

  const reusable = readReusableTaskScope(policyDir);
  if (reusable) return { policyDir, ...reusable, cached: true };

  mkdirSync(root, { recursive: true, mode: 0o700 });
  const workDir = mkdtempSync(resolve(root, `.compile-${key.slice(0, 12)}-`));
  try {
    const models = options.models ?? (await createPipelineModels(workDir));
    const compiled = await new PipelineRunner(models).run({
      constitutionInput: task,
      constitutionKind: 'task-policy',
      outputDir: workDir,
      toolAnnotationsDir: config.toolAnnotationsDir ?? config.generatedDir,
      toolAnnotationsFallbackDir: getPackageGeneratedDir(),
      preloadedStoredAnnotations: annotations,
      allowedDirectory,
      protectedPaths: config.protectedPaths,
      mcpServers: config.mcpServers,
      includeHandwrittenScenarios: false,
      prefilterText: task,
      skipVerification: true,
      // The policy lint still runs. The task text cannot opt the scope in to
      // broad domain access, as for a cron job's task policy.
      allowBroadDomains: false,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.quiet !== undefined ? { quiet: options.quiet } : {}),
      ...(options.reporterFactory ? { reporterFactory: options.reporterFactory } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const record: TaskScopeRecord = {
      version: TASK_SCOPE_FORMAT_VERSION,
      key,
      task,
      taskHash: hashConstitutionText(task),
      allowedDirectory,
      createdAt: new Date().toISOString(),
      complete: (compiled.failedServers?.length ?? 0) === 0,
    };
    writeStableJsonAtomic(resolve(workDir, TASK_SCOPE_RECORD_FILENAME), record);
    publishTaskScopeDir(workDir, policyDir);
  } finally {
    // Gone after a successful publish; otherwise the half-done compile.
    rmSync(workDir, { recursive: true, force: true });
  }

  // Report what is published now (normally this compile; a concurrent
  // compile of the same task may have published first).
  const check = checkTaskScopeDir(policyDir);
  if (!check.ok) throw new Error(`Task scope could not be published: ${check.message}`);
  const { compiledPolicy } = loadPersonaPolicyArtifacts(policyDir);
  return { policyDir, record: check.record, policy: compiledPolicy, cached: false };
}

/**
 * The stored tool annotations (user overlay over the package's, as the
 * session loads them) restricted to the servers this installation
 * configures: a task scope is compiled only for servers a session can run.
 */
function loadConfiguredServerAnnotations(config: IronCurtainConfig): StoredToolAnnotationsFile {
  const loaded = loadStoredToolAnnotationsFile(
    config.toolAnnotationsDir ?? config.generatedDir,
    getPackageGeneratedDir(),
  );
  if (!loaded) {
    throw new Error("tool-annotations.json not found. Run 'ironcurtain annotate-tools' first.");
  }
  const servers = Object.fromEntries(
    Object.entries(loaded.servers).filter(([name]) => Object.hasOwn(config.mcpServers, name)),
  );
  return { ...loaded, servers };
}

/**
 * The published scope at `policyDir` when it may be reused: a real
 * directory (not a link) whose record and compiled policy check out and
 * that was compiled completely.
 */
function readReusableTaskScope(
  policyDir: string,
): { readonly record: TaskScopeRecord; readonly policy: CompiledPolicyFile } | undefined {
  if (lstatSync(policyDir, { throwIfNoEntry: false })?.isDirectory() !== true) return undefined;
  const check = checkTaskScopeDir(policyDir);
  if (!check.ok || !check.record.complete) return undefined;
  try {
    return { record: check.record, policy: loadPersonaPolicyArtifacts(policyDir).compiledPolicy };
  } catch {
    return undefined;
  }
}

/**
 * Moves a finished compile into place. An entry that may be reused (a
 * concurrent compile of the same task published first) is kept; any other
 * entry under the key (incomplete, broken, not a directory) is moved aside
 * and removed first. Both renames stay inside the cache directory, so each
 * is atomic: a session never sees a partly written scope.
 */
function publishTaskScopeDir(workDir: string, policyDir: string): void {
  if (readReusableTaskScope(policyDir)) return;
  if (lstatSync(policyDir, { throwIfNoEntry: false }) !== undefined) {
    const aside = `${policyDir}.old-${randomBytes(6).toString('hex')}`;
    renameSync(policyDir, aside);
    rmSync(aside, { recursive: true, force: true });
  }
  try {
    renameSync(workDir, policyDir);
  } catch (err) {
    // Lost a race with a concurrent compile: keep its scope when usable.
    const code = (err as NodeJS.ErrnoException).code;
    if ((code === 'EEXIST' || code === 'ENOTEMPTY') && checkTaskScopeDir(policyDir).ok) return;
    throw err;
  }
}

/**
 * Terminal lines describing a prepared task scope, for the CLI entry
 * points: what was compiled or reused, which servers it has rules for,
 * and, for an incomplete compile, which servers will escalate every call.
 */
export function formatTaskScopeSummary(result: TaskScopeCompileResult): string[] {
  const servers = [...new Set(result.policy.rules.flatMap((rule) => rule.if.server ?? []))].sort();
  const count = result.policy.rules.length;
  const verb = result.cached ? 'reused' : 'compiled';
  const lines = [
    count > 0
      ? `Task scope ${verb}: ${count} rule${count === 1 ? '' : 's'} for ${servers.join(', ')}. ` +
        'Calls outside the task scope will be escalated.'
      : `Task scope ${verb}: no rules, so only the session's own directory is in scope. ` +
        'Every other call will be escalated.',
    `  ${result.policyDir}`,
  ];
  const failed = result.policy.failedServers ?? [];
  if (failed.length > 0) {
    lines.push(
      `  Warning: ${failed.map((f) => f.serverName).join(', ')} failed to compile; every call to ` +
        `${failed.length === 1 ? 'it' : 'them'} will be escalated. The next task-scoped start compiles the scope again.`,
    );
  }
  return lines;
}
