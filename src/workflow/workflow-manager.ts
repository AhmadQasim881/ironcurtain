/**
 * WorkflowManager -- owns WorkflowOrchestrator instances for the web UI
 * and the CLI inspect path.
 *
 * Analogous to SessionManager: the daemon creates one WorkflowManager
 * at startup and passes it into the dispatch context. Lifecycle events
 * from the orchestrator are forwarded to the supplied event bus, which
 * the WebUiServer subscribes to.
 *
 * Layered under `src/workflow/` (rather than `src/web-ui/`) so that
 * non-web consumers (CLI, signal bot daemon) can reuse it without
 * pulling in the web UI module. The event bus parameter is typed
 * against the generic {@link TypedEventBus} fixed to {@link WebEventMap}
 * so existing callers can keep passing `WebEventBus` instances; the
 * `WebEventMap` is a type-only import and adds no runtime coupling.
 */

import { mkdirSync, existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  copyWorkflowStagedDirectory,
  isOwnWorkflowRunsDirectory,
  validatedWorkflowStagedDirectory,
} from './staged-directories.js';

import {
  WorkflowOrchestrator,
  type WorkflowOrchestratorDeps,
  type WorkflowTabHandle,
  type WorkflowLifecycleEvent,
  type WorkflowController,
  type WorkflowStopOptions,
} from './orchestrator.js';
import { FileCheckpointStore, isWorkflowRunFileTooNewError, rebaseRunLocalPaths } from './checkpoint.js';
import {
  claimWorkflowRunLock,
  isWorkflowLockBusyError,
  isWorkflowRunLockHeld,
  releaseWorkflowLock,
} from './run-lock.js';
import type { ProcessLockHandle } from '../docker-workload/process-lock.js';
import { createWorkflowSessionFactory } from './cli-support.js';
import { assertWorkflowRunsBaseDir, findLatestResumableCheckpoint, isSameDirectory } from './checkpoint-selection.js';
import { loadDefinition } from './definition-loader.js';
import {
  hostCommandStates,
  loadRunDefinition,
  RECORDED_DEFINITION_ALLOWANCES,
  runDefinitionPath,
  writeRunDefinition,
  type RunDefinitionLoadResult,
} from './run-definition.js';
import { isWorkspaceValidationError, validateWorkspacePath } from '../session/workspace-validation.js';
import type { TypedEventBus } from '../event-bus/typed-event-bus.js';
import type { WebEventMap } from '../web-ui/web-event-bus.js';
import type { Session, SessionOptions } from '../session/types.js';
import { getIronCurtainHome } from '../config/paths.js';
import { loadConfig } from '../config/index.js';
import {
  type HumanGateRequestDto,
  isSafeWorkflowId,
  toHumanGateRequestDto,
  type WorkflowId,
  type WorkflowCheckpoint,
  type WorkflowDefinition,
  type WorkflowToolCallEscalation,
  type WorkflowToolCallEscalationDecision,
} from './types.js';
import { sweepContainerSnapshots } from './container-snapshots.js';
import * as logger from '../logger.js';
import { WorkflowResumeError } from './errors.js';

// ---------------------------------------------------------------------------
// loadPastRun result types
// ---------------------------------------------------------------------------

/**
 * Successful past-run load: domain objects only, no DTO mapping.
 *
 * `checkpoint` is optional because a directory may hold a `definition.json`
 * (and optionally a `messages.jsonl`) without a `checkpoint.json` -- this
 * happens for runs that completed before checkpoint retention was introduced
 * and for runs where the checkpoint is missing for any other reason. The
 * dispatch layer synthesizes missing fields from the message log or the
 * definition when `checkpoint` is `undefined`.
 *
 * `messageLogPath` is always returned (never checked for existence here);
 * callers read it via `MessageLog.readAll()`, which returns `[]` when the
 * file does not yet exist.
 */
export interface PastRunLoadSuccess {
  readonly checkpoint: WorkflowCheckpoint | undefined;
  readonly definition: WorkflowDefinition;
  /** Absolute path to the per-run `messages.jsonl`. Not guaranteed to exist on disk. */
  readonly messageLogPath: string;
  /** True iff `workflowId` is present in `controller.listActive()` at call time. */
  readonly isLive: boolean;
  /**
   * True when the run is not live here but its run lock is held by a live
   * process: it is running in another IronCurtain process (a CLI
   * `workflow start`, another daemon), so it is neither interrupted nor
   * resumable from here. Always false when `isLive`.
   */
  readonly runningElsewhere: boolean;
}

/**
 * Failed past-run load.
 * - `not_found`: directory doesn't exist OR has no loadable definition (so
 *   there's nothing to render), or the id is not a safe path segment.
 * - `corrupted`: a present file (checkpoint or definition) failed to parse
 *   or validate.
 * - `too_new`: a present file was written by a newer IronCurtain in a format
 *   this one does not read (`WORKFLOW_CHECKPOINT_TOO_NEW`).
 */
export interface PastRunLoadError {
  readonly error: 'not_found' | 'corrupted' | 'too_new';
  readonly message?: string;
}

/** Options for {@link WorkflowManager.importExternalCheckpoint}. */
export interface ImportExternalCheckpointOptions {
  /**
   * The caller (a human, via `--trust` / RPC `trust: true`) has reviewed the
   * imported definition and accepts that its deterministic states run
   * commands on this host. Without it such a definition is refused.
   */
  readonly trust?: boolean;
}

export type PastRunLoadResult = PastRunLoadSuccess | PastRunLoadError;

/** Renders an unknown thrown value as a short human-readable string. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WorkflowManagerOptions {
  readonly eventBus: TypedEventBus<WebEventMap>;
  /**
   * Optional override for the base directory under which workflow runs are
   * stored. Defaults to `{getIronCurtainHome()}/workflow-runs`. The CLI
   * `workflow inspect` subcommand uses this to inspect arbitrary user-supplied
   * directories without mutating `IRONCURTAIN_HOME`.
   */
  readonly baseDirOverride?: string;
  /**
   * Raw `--capture-traces` opt-in forwarded from the daemon. Threaded into the
   * orchestrator's deps as `captureTracesOverride` so daemon/web-UI-launched
   * workflows honour the flag the same way the CLI `workflow start` path does.
   * The infrastructure factory resolves it against `userConfig` (single
   * resolution point); leaving it `undefined` falls back to config.
   */
  readonly captureTraces?: boolean;
  /**
   * Optional override for the session factory wired into the orchestrator's
   * `deps.createSession`. Defaults to {@link createWorkflowSessionFactory}.
   *
   * This is a narrow dependency-injection seam: it lets tests drive the full
   * daemon → dispatch → orchestrator path with a deterministic stub session
   * (no real LLM / Docker), while production callers leave it unset and get the
   * real session factory. The type matches `WorkflowOrchestratorDeps.createSession`.
   */
  readonly sessionFactoryOverride?: (options: SessionOptions) => Promise<Session>;
  /**
   * Optional overrides for the orchestrator's infrastructure / control-plane
   * seams (`createWorkflowInfrastructure`, `destroyWorkflowInfrastructure`,
   * `startWorkflowControlServer`, `loadPolicyRpc`). Like
   * `sessionFactoryOverride`, a test-only DI seam: it lets an integration
   * test run a shared-container workflow through the daemon with a real
   * coordinator but no Docker. Production callers leave it unset.
   */
  readonly orchestratorDepsOverride?: Partial<
    Pick<
      WorkflowOrchestratorDeps,
      'createWorkflowInfrastructure' | 'destroyWorkflowInfrastructure' | 'startWorkflowControlServer' | 'loadPolicyRpc'
    >
  >;
  /** Enable daemon-mode startup and periodic workflow container snapshot GC. */
  readonly enableSnapshotGc?: boolean;
}

// ---------------------------------------------------------------------------
// WorkflowManager
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link WorkflowManager.getOrchestrator} once the manager has been
 * shut down. `code` is the discriminant for callers in other modules.
 */
export class WorkflowManagerClosedError extends Error {
  readonly code = 'WORKFLOW_MANAGER_CLOSED' as const;

  constructor() {
    super('The workflow manager is shut down (the daemon is stopping); no workflow requests are accepted');
    this.name = 'WorkflowManagerClosedError';
  }
}

export class WorkflowManager {
  private orchestrator: WorkflowOrchestrator | null = null;
  private readonly eventBus: TypedEventBus<WebEventMap>;
  private readonly baseDirOverride: string | undefined;
  private readonly captureTraces: boolean | undefined;
  private readonly sessionFactoryOverride: ((options: SessionOptions) => Promise<Session>) | undefined;
  private readonly orchestratorDepsOverride: WorkflowManagerOptions['orchestratorDepsOverride'];
  private readonly enableSnapshotGc: boolean;
  private snapshotGcTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Set when {@link shutdown} begins. Afterwards {@link getOrchestrator}
   * throws instead of lazily creating a fresh orchestrator (which would
   * accept new runs and restart snapshot GC behind a stopping daemon).
   */
  private closed = false;
  /** The one {@link shutdown} drain; later calls join it. */
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: WorkflowManagerOptions) {
    this.eventBus = options.eventBus;
    this.baseDirOverride = options.baseDirOverride;
    this.captureTraces = options.captureTraces;
    this.sessionFactoryOverride = options.sessionFactoryOverride;
    this.orchestratorDepsOverride = options.orchestratorDepsOverride;
    this.enableSnapshotGc = options.enableSnapshotGc ?? false;
  }

  /**
   * Lazily creates the orchestrator on first use. Throws
   * {@link WorkflowManagerClosedError} once {@link shutdown} has begun.
   */
  getOrchestrator(): WorkflowController {
    if (this.closed) throw new WorkflowManagerClosedError();
    if (!this.orchestrator) {
      this.orchestrator = this.createOrchestrator();
    }
    return this.orchestrator;
  }

  /**
   * Eagerly starts background maintenance (snapshot GC startup sweep +
   * periodic timer) at daemon boot rather than lazily on the first workflow
   * request. Without this, a long-lived daemon that never receives a workflow
   * request would never reclaim aged or orphaned snapshot images. No-op unless
   * snapshot GC is enabled for this manager.
   */
  startBackgroundTasks(): void {
    if (this.enableSnapshotGc) {
      // Forcing orchestrator creation runs startSnapshotGc (sweep + timer).
      this.getOrchestrator();
    }
  }

  /**
   * Clean shutdown of all workflows: every run is aborted (with
   * `options.reason`, a snapshot when its workflow asks for one, a terminal
   * checkpoint and `run_terminal` marker) and every infrastructure teardown is
   * drained. Final: the manager refuses all further requests (see
   * {@link getOrchestrator}), and a start or resume racing the shutdown is
   * refused by the orchestrator. Idempotent: a later call joins the first
   * one's drain.
   */
  shutdown(options: WorkflowStopOptions = {}): Promise<void> {
    this.shutdownPromise ??= this.runShutdown(options);
    return this.shutdownPromise;
  }

  private async runShutdown(options: WorkflowStopOptions): Promise<void> {
    this.closed = true;
    if (this.snapshotGcTimer !== undefined) {
      clearInterval(this.snapshotGcTimer);
      this.snapshotGcTimer = undefined;
    }
    const orchestrator = this.orchestrator;
    if (orchestrator) {
      await orchestrator.shutdownAll(options);
      this.orchestrator = null;
    }
  }

  /**
   * Imports a checkpoint from an external directory into the daemon's own store.
   *
   * When `workflowId` is omitted, picks the most recent checkpoint in the external dir.
   * Writes the run's checkpoint and definition copy into this base directory
   * so that `resume()` can find them.
   *
   * Nothing in the external directory is trusted without a check, since an
   * agent may have written it:
   * - the directory must be a base directory of runs, not one run's
   *   directory (whose workspace an agent can write; see
   *   `assertWorkflowRunsBaseDir`), and an explicit id must be a safe path
   *   segment;
   * - the definition must load, and one that runs commands on the host needs
   *   `options.trust`; the checked definition is what gets imported, and the
   *   imported checkpoint names that local copy, so resume uses exactly it;
   * - the recorded workspace (rebased onto the external run directory when the
   *   run directory was moved) must pass `validateWorkspacePath`;
   * - staged skills and scripts are kept only when they are real directories
   *   canonically inside the external run directory (never a symlink out of
   *   it), and container snapshot references are dropped (resume starts the
   *   containers fresh), since resume would otherwise mount, restore from and
   *   later delete whatever images or directories they name.
   *
   * @returns The workflow ID that was imported.
   */
  importExternalCheckpoint(
    externalBaseDir: string,
    workflowId?: string,
    options: ImportExternalCheckpointOptions = {},
  ): WorkflowId {
    const externalDir = resolve(externalBaseDir);
    assertWorkflowRunsBaseDir(externalDir);
    const externalStore = new FileCheckpointStore(externalDir);
    let targetId: WorkflowId;
    let checkpoint: WorkflowCheckpoint | undefined;

    if (workflowId !== undefined) {
      if (!isSafeWorkflowId(workflowId)) {
        throw new WorkflowResumeError(
          'WORKFLOW_INVALID_ID',
          `Invalid workflow ID ${JSON.stringify(workflowId)}: use 1-128 letters, digits, "_" or "-"`,
        );
      }
      targetId = workflowId;
    } else {
      // `findLatestResumableCheckpoint` returns the most recent resumable
      // run by `checkpoint.timestamp`, skipping (and reporting) runs whose
      // checkpoint fails to load. The two error paths preserve the
      // pre-refactor wording so external callers (web UI, scripts) keep
      // their existing diagnostics.
      let latest;
      try {
        latest = findLatestResumableCheckpoint(externalDir, externalStore);
      } catch (err) {
        throw new WorkflowResumeError(
          'WORKFLOW_CHECKPOINT_CORRUPTED',
          `Failed to load checkpoint from ${externalDir}: ${describeError(err)}`,
        );
      }
      if (!latest) {
        // Distinguish "no checkpoint files at all" from "checkpoints exist
        // but none are resumable" using a single fast probe — the helper
        // already enumerated and filtered, so we re-derive the discriminator
        // by checking the store directly.
        let externalIds: WorkflowId[];
        try {
          externalIds = externalStore.listAll();
        } catch (err) {
          throw new WorkflowResumeError(
            'WORKFLOW_CHECKPOINT_CORRUPTED',
            `Failed to inspect checkpoints in ${externalDir}: ${describeError(err)}`,
          );
        }
        if (externalIds.length === 0) {
          throw new WorkflowResumeError('WORKFLOW_CHECKPOINT_NOT_FOUND', `No checkpoints found in ${externalDir}`);
        }
        throw new WorkflowResumeError(
          'WORKFLOW_NOT_RESUMABLE',
          `No valid checkpoints found in ${externalDir} (runs still running in another process are skipped)`,
        );
      }
      targetId = latest.workflowId;
      checkpoint = latest.checkpoint;
    }

    if (!checkpoint) {
      try {
        checkpoint = externalStore.load(targetId);
      } catch (err) {
        throw new WorkflowResumeError(
          isWorkflowRunFileTooNewError(err) ? 'WORKFLOW_CHECKPOINT_TOO_NEW' : 'WORKFLOW_CHECKPOINT_CORRUPTED',
          `Failed to load checkpoint for workflow ${targetId}: ${describeError(err)}`,
        );
      }
    }
    if (!checkpoint) {
      throw new WorkflowResumeError(
        'WORKFLOW_CHECKPOINT_NOT_FOUND',
        `No checkpoint found for workflow ${targetId} in ${externalDir}`,
      );
    }
    if (this.orchestrator?.listActive().includes(targetId)) {
      throw new WorkflowResumeError('WORKFLOW_ALREADY_ACTIVE', `Workflow ${targetId} is already active`);
    }
    // The source run may still be executing in another process (a CLI
    // `workflow start` or `resume-standalone` on that directory). Importing it
    // would let this daemon resume a second copy; its run lock lives in the
    // external directory, so it is checked here (the workspace lock catches
    // the shared workspace as well when both processes share a home).
    if (isWorkflowRunLockHeld(externalDir, targetId)) {
      throw new WorkflowResumeError(
        'WORKFLOW_ALREADY_ACTIVE',
        `Workflow ${targetId} in ${externalDir} is running in another IronCurtain process`,
      );
    }
    // The daemon already owns checkpoints under its own base directory, under
    // whatever spelling (a symlink, `..`) it was named: re-importing a run
    // over itself would drop its snapshot references and rewrite its files.
    if (isSameDirectory(externalDir, this.getBaseDir())) {
      return targetId;
    }

    const imported = this.prepareImport(externalDir, targetId, checkpoint, options.trust === true);

    // Reserve a fresh destination atomically. An inactive run is still its
    // owner's existing data: importing over it could replace definition.json
    // before a later staged-file copy fails. Never merge into that directory.
    const localRunDir = resolve(this.getBaseDir(), targetId);
    mkdirSync(this.getBaseDir(), { recursive: true, mode: 0o700 });
    try {
      mkdirSync(localRunDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let active = false;
      try {
        // A final symlink is never followed to inspect an existing run.
        active = lstatSync(localRunDir).isDirectory() && isWorkflowRunLockHeld(this.getBaseDir(), targetId);
      } catch {
        // The destination changed meanwhile; it is still not ours to replace.
      }
      throw new WorkflowResumeError(
        active ? 'WORKFLOW_ALREADY_ACTIVE' : 'WORKFLOW_NOT_RESUMABLE',
        `Cannot import workflow ${targetId}: destination run already exists; existing files were left unchanged`,
      );
    }

    // The copy lands in this base directory, which other processes share (a
    // CLI `workflow start` runs under the same workflow-runs directory): hold
    // the local run lock while copying, so the checkpoint and definition of a
    // run that is live in another process under the same id are never
    // overwritten.
    let localLock: ProcessLockHandle;
    try {
      localLock = claimWorkflowRunLock(this.getBaseDir(), targetId);
    } catch (err) {
      if (isWorkflowLockBusyError(err)) {
        throw new WorkflowResumeError('WORKFLOW_ALREADY_ACTIVE', `Cannot import: ${err.message}`);
      }
      throw err;
    }
    try {
      // Definition first: a checkpoint is what makes the run resumable, and
      // it must never name a definition copy that is not there yet.
      writeRunDefinition(localRunDir, imported.definition);
      const { workflowSkillsDir, workflowScriptsDir, ...checkpoint } = imported.checkpoint;
      this.getCheckpointStore().save(targetId, {
        ...checkpoint,
        ...(workflowSkillsDir === undefined
          ? {}
          : { workflowSkillsDir: copyWorkflowStagedDirectory(workflowSkillsDir, localRunDir, 'skills') }),
        ...(workflowScriptsDir === undefined
          ? {}
          : { workflowScriptsDir: copyWorkflowStagedDirectory(workflowScriptsDir, localRunDir, 'scripts') }),
      });
    } finally {
      releaseWorkflowLock(localLock, (message) => logger.warn(`[workflow] ${message}`));
    }

    return targetId;
  }

  /**
   * Checks an external run before import and builds the checkpoint and
   * definition to write locally (see {@link importExternalCheckpoint}).
   * Writes nothing.
   */
  private prepareImport(
    externalDir: string,
    workflowId: WorkflowId,
    external: WorkflowCheckpoint,
    trust: boolean,
  ): { checkpoint: WorkflowCheckpoint; definition: WorkflowDefinition } {
    const externalRunDir = resolve(externalDir, workflowId);
    // Run-local paths follow the external run directory (it may itself have
    // been moved or copied from another home).
    const rebased = rebaseRunLocalPaths(external, workflowId, externalRunDir);

    // The definition a resume would run: the run's own copy, else the file
    // the checkpoint names. Display-grade validation, so a definition that
    // predates `host: true` (or the one-persona rule for a shared scope) is
    // still imported and recognised as running host commands; resume
    // validates it fully.
    const copyPath = runDefinitionPath(externalRunDir);
    let loaded: RunDefinitionLoadResult;
    let sourcePath: string;
    if (existsSync(copyPath)) {
      sourcePath = copyPath;
      loaded = loadRunDefinition(copyPath, RECORDED_DEFINITION_ALLOWANCES);
    } else {
      throw new WorkflowResumeError(
        'WORKFLOW_CHECKPOINT_CORRUPTED',
        `Cannot import workflow ${workflowId}: a run-local ${copyPath} is required`,
      );
    }
    if (!loaded.ok) {
      throw new WorkflowResumeError(
        loaded.kind === 'too_new' ? 'WORKFLOW_CHECKPOINT_TOO_NEW' : 'WORKFLOW_CHECKPOINT_CORRUPTED',
        `Cannot import workflow ${workflowId}: ${loaded.message}`,
      );
    }
    const definition = loaded.definition;
    const hostStates = hostCommandStates(definition);
    if (hostStates.length > 0 && !trust) {
      throw new WorkflowResumeError(
        'WORKFLOW_IMPORT_UNTRUSTED',
        `Workflow ${workflowId} in ${externalDir} runs commands on this host (state(s): ${hostStates.join(', ')}), ` +
          `and nothing vouches for its definition ${sourcePath}. Review it, then import again with --trust ` +
          '(RPC: trust: true) to run it.',
      );
    }

    let workspacePath: string | undefined;
    if (rebased.workspacePath !== undefined) {
      try {
        workspacePath = validateWorkspacePath(rebased.workspacePath, loadConfig().protectedPaths);
      } catch (err) {
        if (isWorkspaceValidationError(err) && err.code === 'WORKSPACE_NOT_FOUND') {
          throw new WorkflowResumeError(
            'WORKFLOW_WORKSPACE_MISSING',
            `Cannot import workflow ${workflowId}: its workspace ${rebased.workspacePath} does not exist`,
          );
        }
        throw new WorkflowResumeError(
          'WORKFLOW_NOT_RESUMABLE',
          `Cannot import workflow ${workflowId}: workspace failed validation: ${describeError(err)}`,
        );
      }
    }

    // Staged skills are copied into the agent's sessions and staged scripts
    // are bind-mounted into its container, so only a real directory that
    // canonically lies inside the external run directory is kept. A symlink
    // there (the bind mount would follow it) or a missing entry (which could
    // be created as one later) is dropped, and the canonical path is kept.
    const stagedDirInsideExternalRun = (path: string | undefined, kind: 'skills' | 'scripts'): string | undefined => {
      if (path === undefined) return undefined;
      const canonical = validatedWorkflowStagedDirectory(externalRunDir, path, kind);
      if (canonical === undefined) {
        logger.warn(
          `[workflow] Import ${workflowId}: ignoring staged directory ${path}, which is not a directory inside ${externalRunDir}`,
        );
      }
      return canonical;
    };
    const workflowSkillsDir = stagedDirInsideExternalRun(rebased.workflowSkillsDir, 'skills');
    const workflowScriptsDir = stagedDirInsideExternalRun(rebased.workflowScriptsDir, 'scripts');

    const checkpoint: WorkflowCheckpoint = {
      machineState: rebased.machineState,
      context: rebased.context,
      timestamp: rebased.timestamp,
      transitionHistory: rebased.transitionHistory,
      // Resume reads the definition from the local copy written by this
      // import, never from a path the external checkpoint chose.
      definitionPath: runDefinitionPath(resolve(this.getBaseDir(), workflowId)),
      runDir: resolve(this.getBaseDir(), workflowId),
      ...(rebased.resourceBudget !== undefined ? { resourceBudget: rebased.resourceBudget } : {}),
      // The run-wide usage so far: resume continues the run's totals and its
      // `settings.workflowBudget` ceiling from it instead of starting over.
      ...(rebased.usage !== undefined ? { usage: rebased.usage } : {}),
      // A task-scoped run stays task-scoped: a task scope can only narrow the
      // policy, and resume re-validates it (refusing the run when it no longer
      // validates) instead of ever running the run unscoped.
      ...(rebased.taskPolicyDir !== undefined ? { taskPolicyDir: rebased.taskPolicyDir } : {}),
      ...(workspacePath !== undefined ? { workspacePath } : {}),
      ...(workflowSkillsDir !== undefined ? { workflowSkillsDir } : {}),
      ...(workflowScriptsDir !== undefined ? { workflowScriptsDir } : {}),
      ...(rebased.finalStatus !== undefined ? { finalStatus: rebased.finalStatus } : {}),
      ...(rebased.activeGateId !== undefined ? { activeGateId: rebased.activeGateId } : {}),
    };
    return { checkpoint, definition };
  }

  /**
   * Loads a past workflow run from disk. Returns domain objects only.
   *
   * - `not_found`: directory missing OR no loadable checkpoint + no loadable definition.
   * - `corrupted`: a present file failed to parse. Never throws.
   * - On success, `checkpoint` may be `undefined`; `definition` and `messageLogPath` are always set.
   *
   * Pass `activeIds` when calling in a loop (e.g. `buildResumableList`) to skip
   * the per-call `controller.listActive()` allocation.
   */
  loadPastRun(workflowId: WorkflowId, activeIds?: ReadonlySet<WorkflowId>): PastRunLoadResult {
    // Never join an id that is not one plain path segment into a path.
    if (!isSafeWorkflowId(workflowId)) {
      return { error: 'not_found', message: `Invalid workflow ID ${JSON.stringify(workflowId)}` };
    }
    const store = this.getCheckpointStore();
    const runDir = resolve(this.getBaseDir(), workflowId);
    const messageLogPath = resolve(runDir, 'messages.jsonl');

    let checkpoint: WorkflowCheckpoint | undefined;
    try {
      checkpoint = store.load(workflowId);
    } catch (err: unknown) {
      if (isWorkflowRunFileTooNewError(err)) return { error: 'too_new', message: describeError(err) };
      return {
        error: 'corrupted',
        message: `Failed to parse checkpoint for ${workflowId}: ${describeError(err)}`,
      };
    }
    // Show (and browse) the workspace where the run directory is now, not
    // where it was when the checkpoint was written.
    if (checkpoint) checkpoint = rebaseRunLocalPaths(checkpoint, workflowId, runDir);

    const definitionResult = this.loadDefinitionForCheckpoint(workflowId, checkpoint);
    if ('error' in definitionResult) {
      return definitionResult;
    }

    const isLive = activeIds ? activeIds.has(workflowId) : this.getOrchestrator().listActive().includes(workflowId);
    const runningElsewhere = !isLive && isWorkflowRunLockHeld(this.getBaseDir(), workflowId);
    return { checkpoint, definition: definitionResult.definition, messageLogPath, isLive, runningElsewhere };
  }

  /**
   * Finds the live workflow that owns a pending tool-call escalation.
   * Escalation ids are coordinator UUIDs, unique across workflows, so a
   * plain scan of the active runs is unambiguous.
   */
  findToolCallEscalation(
    escalationId: string,
  ): { readonly workflowId: WorkflowId; readonly escalation: WorkflowToolCallEscalation } | undefined {
    // No orchestrator yet means no live workflow; do not create one (and
    // start its background work) just to answer a session escalation lookup.
    const controller = this.orchestrator;
    if (!controller) return undefined;
    for (const workflowId of controller.listActive()) {
      const escalation = controller
        .listToolCallEscalations(workflowId)
        .find((candidate) => candidate.escalationId === escalationId);
      if (escalation) return { workflowId, escalation };
    }
    return undefined;
  }

  /**
   * Settles a pending tool-call escalation by id alone (the web UI's
   * `escalations.resolve` route). Returns false when no live workflow has
   * that escalation pending.
   */
  resolveToolCallEscalation(escalationId: string, decision: WorkflowToolCallEscalationDecision): boolean {
    const found = this.findToolCallEscalation(escalationId);
    if (!found || !this.orchestrator) return false;
    return this.orchestrator.resolveToolCallEscalation(found.workflowId, escalationId, decision);
  }

  /** Returns the stable base directory for workflow data. */
  getBaseDir(): string {
    const baseDir = this.baseDirOverride ?? resolve(getIronCurtainHome(), 'workflow-runs');
    mkdirSync(baseDir, { recursive: true });
    return baseDir;
  }

  /** Returns the checkpoint store for the current orchestrator (creates orchestrator if needed). */
  getCheckpointStore(): FileCheckpointStore {
    // Ensure orchestrator is created so checkpoint store exists
    this.getOrchestrator();
    if (!this._checkpointStore) {
      throw new Error('Checkpoint store not initialized -- orchestrator creation failed');
    }
    return this._checkpointStore;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private _checkpointStore: FileCheckpointStore | null = null;

  /**
   * Resolves and parses the WorkflowDefinition associated with a workflow run.
   *
   * Preference order:
   *  1. Local JSON copy at `{baseDir}/{workflowId}/definition.json` (written
   *     at workflow-start / import). Tried regardless of whether a checkpoint
   *     is available.
   *  2. The original `checkpoint.definitionPath`, iff `checkpoint` is defined.
   *
   * When `checkpoint` is `undefined` we have nothing beyond the local copy to
   * try — a directory with no checkpoint and no `definition.json` has no
   * content worth surfacing and is reported as `not_found` (distinct from
   * `corrupted`, which is reserved for present-but-malformed files).
   *
   * Any parse or schema-validation failure of a present file is surfaced as
   * `corrupted`.
   */
  private loadDefinitionForCheckpoint(
    workflowId: WorkflowId,
    checkpoint: WorkflowCheckpoint | undefined,
  ): { definition: WorkflowDefinition } | PastRunLoadError {
    const definitionCopyPath = runDefinitionPath(resolve(this.getBaseDir(), workflowId));
    const hasCopy = existsSync(definitionCopyPath);

    let definitionPath: string | undefined;
    if (hasCopy) {
      definitionPath = definitionCopyPath;
    } else if (checkpoint && isOwnWorkflowRunsDirectory(this.getBaseDir()) && existsSync(checkpoint.definitionPath)) {
      definitionPath = checkpoint.definitionPath;
    }

    if (!definitionPath) {
      // Nothing to load: no local copy, and either no checkpoint at all or
      // the checkpoint's original `definitionPath` is gone. The directory
      // has no renderable content — report `not_found` rather than
      // `corrupted` (corrupted is reserved for present-but-malformed files).
      const fallbackDetail = checkpoint ? ` and ${checkpoint.definitionPath}` : '';
      return {
        error: 'not_found',
        message: `Definition file missing for ${workflowId} (looked in ${definitionCopyPath}${fallbackDetail})`,
      };
    }

    // Both `parse` and `validate` failures map to `corrupted`: the file is
    // present on disk but unusable. Preserve the pre-refactor message
    // wording so existing UI consumers keep their diagnostic strings.
    //
    // This load only displays the run, so a run recorded before host
    // deterministic states needed `host: true`, or before a shared-container
    // scope needed one persona (or `allowMixedPersonas: true`), stays
    // visible. Resuming it goes through the orchestrator, which validates
    // without these allowances (and refuses an unacknowledged host state at
    // runtime anyway).
    const result = hasCopy
      ? loadRunDefinition(definitionPath, RECORDED_DEFINITION_ALLOWANCES)
      : loadDefinition(definitionPath, RECORDED_DEFINITION_ALLOWANCES);
    if (result.ok) return { definition: result.definition };

    if (result.kind === 'too_new') {
      return { error: 'too_new', message: result.message };
    }
    if (result.kind === 'parse') {
      return {
        error: 'corrupted',
        message: `Failed to parse definition at ${definitionPath}: ${result.message}`,
      };
    }

    // `validate`: prefer the structured issues list when present (parity
    // with the old `WorkflowValidationError.issues.join('; ')` path); fall
    // back to the loader's default message otherwise.
    const detail = result.issues ? result.issues.join('; ') : result.message;
    return {
      error: 'corrupted',
      message: `Invalid workflow definition at ${definitionPath}: ${detail}`,
    };
  }

  private createOrchestrator(): WorkflowOrchestrator {
    const baseDir = this.getBaseDir();
    const checkpointStore = new FileCheckpointStore(baseDir);
    this._checkpointStore = checkpointStore;
    const sessionFactory = this.sessionFactoryOverride ?? createWorkflowSessionFactory();
    const config = loadConfig();
    if (this.enableSnapshotGc) {
      this.startSnapshotGc(baseDir, checkpointStore, config.userConfig);
    }

    const deps: WorkflowOrchestratorDeps = {
      createSession: sessionFactory,
      createWorkflowTab: () => this.createNoOpTab(),
      raiseGate: (gate) => {
        const dto: HumanGateRequestDto = toHumanGateRequestDto(gate);
        this.eventBus.emit('workflow.gate_raised', {
          workflowId: gate.workflowId,
          gate: dto,
        });
      },
      dismissGate: (workflowId, gateId) => {
        this.eventBus.emit('workflow.gate_dismissed', { workflowId, gateId });
      },
      baseDir,
      checkpointStore,
      userConfig: config.userConfig,
      // Caller-supplied workspaces (workflows.start) and non-default
      // checkpoint workspaces (resume, import) are validated against these.
      protectedPaths: config.protectedPaths,
      // Forward the raw `--capture-traces` daemon flag; the infrastructure
      // factory resolves it against userConfig (single resolution point).
      captureTracesOverride: this.captureTraces,
      ...this.orchestratorDepsOverride,
    };

    const orchestrator = new WorkflowOrchestrator(deps);
    orchestrator.onEvent((event) => this.forwardLifecycleEvent(event));
    return orchestrator;
  }

  private startSnapshotGc(
    baseDir: string,
    checkpointStore: FileCheckpointStore,
    userConfig: ReturnType<typeof loadConfig>['userConfig'],
  ): void {
    if (this.snapshotGcTimer !== undefined) return;
    const runSweep = (): void => {
      // The sweep absorbs the expected "Docker absent" case internally; a
      // rejection here is genuinely unexpected, so surface it rather than
      // letting GC die silently.
      sweepContainerSnapshots({ baseDir, checkpointStore, userConfig }).catch((err: unknown) => {
        logger.warn(`[workflow] snapshot GC sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    runSweep();
    // Node stores a timer delay in a signed 32-bit int; a delay over ~24.8 days
    // (2^31-1 ms) overflows and fires every 1ms. Clamp to the max safe delay.
    const MAX_TIMER_DELAY_MS = 2_147_483_647;
    const intervalMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(1, userConfig.snapshot.sweepIntervalHours) * 60 * 60 * 1000,
    );
    this.snapshotGcTimer = setInterval(runSweep, intervalMs);
    this.snapshotGcTimer.unref();
  }

  private createNoOpTab(): WorkflowTabHandle {
    return {
      write() {},
      setLabel() {},
      close() {},
    };
  }

  /** Maps WorkflowLifecycleEvent to web event bus events. */
  private forwardLifecycleEvent(event: WorkflowLifecycleEvent): void {
    switch (event.kind) {
      case 'started':
        this.eventBus.emit('workflow.started', {
          workflowId: event.workflowId,
          name: event.name,
          taskDescription: event.taskDescription,
        });
        break;
      case 'state_entered':
        this.eventBus.emit('workflow.state_entered', {
          workflowId: event.workflowId,
          state: event.state,
        });
        break;
      case 'completed':
        this.eventBus.emit('workflow.completed', {
          workflowId: event.workflowId,
        });
        break;
      case 'failed':
        this.eventBus.emit('workflow.failed', {
          workflowId: event.workflowId,
          error: event.error,
          ...(event.phase ? { phase: event.phase } : {}),
        });
        break;
      case 'gate_raised':
        // Already emitted via raiseGate callback
        break;
      case 'gate_dismissed':
        // Already emitted via dismissGate callback
        break;
      case 'tool_call_escalation_raised':
        this.eventBus.emit('workflow.escalation_raised', {
          workflowId: event.workflowId,
          escalation: event.escalation,
        });
        break;
      case 'tool_call_escalation_resolved':
        this.eventBus.emit('workflow.escalation_resolved', {
          workflowId: event.workflowId,
          escalationId: event.escalationId,
          outcome: event.outcome,
        });
        break;
      case 'agent_started':
        this.eventBus.emit('workflow.agent_started', {
          workflowId: event.workflowId,
          stateId: event.state,
          persona: event.persona,
          sessionId: event.sessionId,
        });
        break;
      case 'agent_completed':
        this.eventBus.emit('workflow.agent_completed', {
          workflowId: event.workflowId,
          stateId: event.state,
          verdict: event.verdict,
        });
        break;
      case 'agent_session_ended':
        this.eventBus.emit('workflow.agent_session_ended', {
          workflowId: event.workflowId,
          stateId: event.state,
          sessionId: event.sessionId,
        });
        break;
    }
  }
}
