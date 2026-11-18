import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync,
  lstatSync,
  unlinkSync,
  type Dirent,
} from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';
import { isWithinDirectory } from '../types/argument-roles.js';
import { errorMessage } from '../utils/error-message.js';
import { sha256Hex } from '../hash.js';
import { hashUntrustedRegularFileBelow, readUntrustedRegularFileBelow, UntrustedFileError } from '../hardened-fs.js';
import {
  CHECKPOINT_SAVE_ERROR_CONTEXT,
  HOST_MOUNT_SCAN_ERROR_CONTEXT,
  MessageLog,
  type AgentRetryReason,
} from './message-log.js';
import {
  persistedWorkflowBudget,
  resolveWorkflowResourceBudget,
  workflowBudgetUsage,
  workflowSessionBudgetOptions,
  type WorkflowBudget,
} from './resource-budget.js';
import {
  WorkflowUsageMeter,
  findWorkflowBudgetBreach,
  workflowUsageFromCheckpoint,
  type WorkflowBudgetBreach,
  type WorkflowUsage,
} from './workflow-usage.js';
import { describeCumulativeBudgetExhaustion, findCumulativeBudgetExhaustion } from '../session/budget-admission.js';
import { isTerminalWorkflowPhase, terminalPhaseFromStateName } from './terminal-phase.js';
import { createHash, type Hash } from 'node:crypto';
import * as http from 'node:http';
import { createActor, fromPromise, type AnyActorRef, type AnyStateMachine, type Snapshot } from 'xstate';
import type {
  WorkflowId,
  WorkflowDefinition,
  WorkflowContext,
  WorkflowStatus,
  WorkflowResult,
  WorkflowCheckpoint,
  ContainerSnapshotRef,
  TransitionRecord,
  HumanGateRequest,
  HumanGateEvent,
  HumanGateStateDefinition,
  AgentStateDefinition,
  DeterministicStateDefinition,
  WorkflowStateDefinition,
  AgentOutput,
  WorkflowToolCallEscalation,
  WorkflowToolCallEscalationDecision,
  WorkflowToolCallEscalationOutcome,
  WorkflowSettings,
} from './types.js';
import type { ToolCallRequest } from '../types/mcp.js';
import type { WhitelistCandidateIpc } from '../trusted-process/approval-whitelist.js';
import type {
  EscalationPromptDetails,
  EscalationPromptFn,
  EscalationResult,
} from '../trusted-process/tool-call-coordinator.js';
import type { WorkflowCommitHandler } from '../trusted-process/workflow-commit-tool.js';
import { WorkflowCommitChannel, type WorkflowCommitInvocation } from './workflow-commit.js';
import {
  createWorkflowId,
  isSafeWorkflowId,
  WORKFLOW_ARTIFACT_DIR,
  GLOBAL_PERSONA,
  DEFAULT_CONTAINER_SCOPE,
  DEFAULT_GATE_IDLE_TIMEOUT_MINUTES,
  DETERMINISTIC_RESULT_ERROR_VERDICT,
  MAX_DETERMINISTIC_TIMEOUT_MS,
  resolveWorkflowSkillsOptions,
} from './types.js';
import {
  getBundleAuditLogPath,
  getBundleBundleDir,
  getBundleControlSocketPath,
  getBundleRuntimeRoot,
  getBundleStatesDir,
  getInvocationDir,
  getWorkflowContainersDir,
  getWorkflowWorkspaceLocksDir,
  nextStateSlug,
} from '../config/paths.js';
import { POLICY_LOAD_PATH } from '../trusted-process/control-server.js';
import { EscalationWithdrawnError } from '../trusted-process/escalation-wait.js';
import { boundReviewerText, MAX_REVIEWER_CONTEXT_CHARS } from '../trusted-process/escalation-context.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { loadConfig, loadPersonaPolicyArtifacts } from '../config/index.js';
import { applyReadOnlyWorkspace, READ_ONLY_OUTPUT_SERVER } from '../config/read-only-workspace.js';
import type { ReadOnlyWorkspace } from '../types/read-only-workspace.js';
import { readOnlyWorkspaceForScope, readOnlyWorkspaceForState } from './workspace-access.js';
import { getBundleCapturesDir } from '../config/paths.js';
import { validatePolicyDir } from '../config/validate-policy-dir.js';
import { requireTaskScopeDir } from '../config/task-scope-policy.js';
import {
  USER_CONFIG_DEFAULTS,
  type ResolvedResourceBudgetConfig,
  type ResolvedUserConfig,
} from '../config/user-config.js';
import type { IronCurtainConfig } from '../config/types.js';
import { isWorkspaceValidationError, validateWorkspacePath } from '../session/workspace-validation.js';
import { getLlmMetricsEventBus } from '../llm-metrics/event-bus.js';
import { getPersonaDefinitionPath, resolvePersona } from '../persona/resolve.js';
import { findPersonaOverridesProblem } from '../persona/persona-overrides.js';
import { isMemoryEnabledForPersonaName } from '../persona/memory-gate.js';
import { extractRequiredServers } from '../trusted-process/policy-roots.js';
import { createPersonaName } from '../persona/types.js';
import { MEMORY_SERVER_NAME } from '../memory/memory-annotations.js';
import { GLOBAL_APPROVAL_SCOPE } from '../audit/approval-history.js';
import type {
  AgentConversationId,
  AgentTurnResult,
  BundleId,
  DiagnosticEvent,
  EscalationRequest,
  SendMessageOptions,
  Session,
  SessionId,
  SessionOptions,
  SessionMode,
} from '../session/types.js';
import { createAgentConversationId, createBundleId } from '../session/types.js';
import {
  CONTAINER_WORKSPACE_DIR,
  describeTransientFailureKind,
  type AgentId,
  type TransientFailureKind,
} from '../docker/agent-adapter.js';
import { resolveScopeDockerAgent, resolveStateDockerAgent, toAgentId } from './agent-harness.js';
import {
  buildWorkflowExecCommand,
  ensureSecureBundleDir,
  type DockerInfrastructure,
  type DockerInfrastructureTeardown,
} from '../docker/docker-infrastructure.js';
import { formatSessionNotice, type HostPrivilegedFilesDiagnostic } from '../session/startup-notices.js';
import type { ContainerRuntime } from '../docker/types.js';
import { runBoundedContainerCommand } from '../docker/turn-timeout.js';
import {
  buildAgentInvokeInput,
  buildDeterministicInvokeInput,
  buildFanOutInvokeInput,
  buildWorkflowMachine,
  truncateAgentOutput,
  type AgentInvokeInput,
  type AgentInvokeResult,
  type DeterministicInvokeInput,
  type DeterministicInvokeResult,
  type FanOutInvokeInput,
  type FanOutInvokeResult,
  type RoundChildOutcome,
  type RoundChildStatus,
  type RoundChildSummary,
} from './machine-builder.js';
import type { CheckpointStore } from './checkpoint.js';
import {
  parseAgentStatus,
  AgentStatusParseError,
  buildMissingCommitReprompt,
  buildStatusBlockReprompt,
  getValidVerdicts,
  buildInvalidVerdictReprompt,
  stripAgentStatusFences,
  type WorkflowCommitPrompt,
} from './status-parser.js';
import {
  buildAgentCommand,
  buildAgentReplacementCommand,
  artifactRepromptReadOnly,
  buildArtifactReprompt,
  buildStatusInstructions,
  type AgentPromptOptions,
} from './prompt-builder.js';
import {
  DEFAULT_EVOLVE_LANE_DIR,
  DEFAULT_EVOLVE_LANE_RELATIVE_DIR,
  MAX_FAN_OUT_LANES,
  evolveResultScriptIndex,
  evolveStepName,
  resolveFanOutWorkers,
} from './lane-template.js';
import { AgentSlotPool, AgentSlotRequestError, type AgentSlotLease, type AgentSlotUsage } from './agent-slot-pool.js';
import {
  ARTIFACT_WALK_LIMITS,
  ensureWorkflowGitignored,
  hasAnyFiles,
  prepareWorkflowArtifactDir,
  prepareWritableOutputDirs,
  resolveArtifactOutputDir,
  snapshotArtifacts,
  walkTreeNoFollow,
  type ArtifactDirCheck,
  type WalkLimits,
} from './artifacts.js';
import {
  isExecutableState,
  isSafeWorkspaceRelativePath,
  parseArtifactRef,
  usesSharedContainer,
  validateDefinition,
  validateWorkflowSkillReferences,
} from './validate.js';
import { parseDefinitionFile, getWorkflowPackageDir } from './discovery.js';
import {
  copyWorkflowStagedDirectory,
  isOwnWorkflowRunsDirectory,
  validatedWorkflowStagedDirectory,
} from './staged-directories.js';
import { resolveSkillsForSession } from '../skills/discovery.js';
import type { ResolvedSkill } from '../skills/types.js';
import { discoverWorkflowRuns } from './workflow-discovery.js';
import {
  isCheckpointResumable,
  isWorkflowRunFileTooNewError,
  rebaseRunLocalPaths,
  RUN_SCRIPTS_DIRNAME,
  RUN_SKILLS_DIRNAME,
  RUN_WORKSPACE_DIRNAME,
} from './checkpoint.js';
import { readRunDefinitionRaw, runDefinitionPath, writeRunDefinition } from './run-definition.js';
import {
  AgentInvocationError,
  GateResolutionError,
  WorkflowBudgetExhaustedError,
  WorkflowQuotaExhaustedError,
  WorkflowTransientFailureError,
  WorkflowResumeError,
  isWorkflowQuotaExhaustedError,
  isWorkflowTransientFailureError,
} from './errors.js';
import { acceptedGateEvents, assertGateResolutionAllowed, isGateIdFor, mintGateId } from './gate-binding.js';
import {
  commitContainerSnapshot,
  isContainerSnapshotSkippedError,
  removeContainerSnapshotImages,
} from './container-snapshots.js';
import { commandExists } from '../trusted-process/container-command.js';
import { DEFAULT_EXEC_TIMEOUT_MS } from '../docker/docker-manager.js';
import {
  describeHostCommandFailure,
  describeProgram,
  hostCommandSucceeded,
  runHostCommand,
} from './host-command-runner.js';
import {
  claimWorkflowRunLock,
  claimWorkflowWorkspaceLock,
  isWorkflowLockBusyError,
  isWorkflowRunLockHeld,
  releaseWorkflowLock,
} from './run-lock.js';
import type { ProcessLockHandle } from '../docker-workload/process-lock.js';

/**
 * How every agent turn of a workflow state is sent. The prompt is built by
 * the orchestrator (prompt-builder.ts) from the workflow definition, the
 * task, gate feedback and the previous states' output, so text an upstream
 * agent wrote is part of it. A `'system'` turn is never recorded as the
 * trusted user context the auto-approver matches escalations against (see
 * `Session.sendMessage`): the session clears that context instead, so no
 * agent's words can authorize an escalation in a later state.
 */
export const WORKFLOW_AGENT_TURN: SendMessageOptions = Object.freeze({ origin: 'system' });

// ---------------------------------------------------------------------------
// Transition message truncation
// ---------------------------------------------------------------------------

const MAX_TRANSITION_MESSAGE_BYTES = 4096;
const TRANSITION_TRUNCATION_NOTICE = '\n\n[... truncated]';

/**
 * Default timeout for a `loadPolicy` RPC to the workflow coordinator.
 * Generous because the coordinator's mutex may be held briefly by an
 * in-flight tool call; tight because "control socket unreachable" must
 * surface fast rather than wedge the workflow.
 */
const LOAD_POLICY_RPC_TIMEOUT_MS = 10_000;

/**
 * Below this much remaining snapshot budget a stop skips the commit instead of
 * starting one that would be killed almost at once.
 */
const MIN_SNAPSHOT_COMMIT_MS = 1_000;

/**
 * Entries into `state` so far, as the machine counts them (agent states
 * only; other states count none). Read defensively: the context can come
 * from a checkpoint written by an older build.
 */
function visitCountOf(snapshot: { readonly context: unknown }, state: string): number {
  const visitCounts = (snapshot.context as { readonly visitCounts?: unknown } | undefined)?.visitCounts;
  if (typeof visitCounts !== 'object' || visitCounts === null || !Object.hasOwn(visitCounts, state)) return 0;
  const count: unknown = (visitCounts as Readonly<Record<string, unknown>>)[state];
  return typeof count === 'number' ? count : 0;
}

function truncateForTransition(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  if (Buffer.byteLength(text, 'utf-8') <= MAX_TRANSITION_MESSAGE_BYTES) {
    return text;
  }
  const noticeBudget = MAX_TRANSITION_MESSAGE_BYTES - Buffer.byteLength(TRANSITION_TRUNCATION_NOTICE, 'utf-8');
  let truncated = text;
  while (Buffer.byteLength(truncated, 'utf-8') > noticeBudget) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
  }
  return truncated + TRANSITION_TRUNCATION_NOTICE;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Narrows a finished child round actor's `snapshot.value` to the closed
 * {@link RoundChildStatus} union. The child machine always terminates in one
 * of its three synthetic terminals (`recorded`/`blocked`/`errored`), so this
 * normally just confirms the name. An unrecognized terminal — which should be
 * unreachable in a validated definition — is treated as `errored`, the
 * conservative fail verdict, rather than silently passing as `recorded`.
 */
function toRoundChildStatus(value: unknown, index: number): RoundChildStatus {
  if (value === 'recorded' || value === 'blocked' || value === 'errored') {
    return value;
  }
  writeStderr(`[workflow] fan-out child ${index} ended in unexpected terminal "${String(value)}"; treating as errored`);
  return 'errored';
}

/**
 * The settled outcome of the first lane to reach `blocked`/`errored`, passed to
 * every un-settled peer so they can be drained (stopped) on its behalf. Carries
 * the trigger's `index`/`status`/`context` plus the `reason` computed ONCE at
 * the trigger source ({@link roundChildReason}) and threaded through, so neither
 * the drain log nor each drained peer's `drainedBy` recomputes it.
 */
type RoundChildDrainTrigger = Pick<RoundChildOutcome, 'index' | 'status' | 'context'> & {
  readonly status: 'blocked' | 'errored';
  readonly reason: string;
};

/**
 * The two-phase join handle for one lane. `promise` resolves either by the
 * child's own snapshot reaching a terminal (natural settle) or by an external
 * {@link drain} call (a peer blocked/errored). `isSettled` is the first-wins
 * guard the drain loop checks so a lane that already settled is never drained;
 * `drain` is the external resolver that natural-settle alone cannot express
 * (see {@link waitForRoundChild} for why `xstate.waitFor` does not fit).
 * `stop` is the abort-time resolver: it stops the lane like `drain` but
 * without a peer trigger, because the whole run is stopping (see `abort()`).
 */
interface RoundChildWaiter {
  readonly index: number;
  readonly actor: AnyActorRef;
  readonly promise: Promise<RoundChildOutcome>;
  readonly isSettled: () => boolean;
  readonly drain: (trigger: RoundChildDrainTrigger) => void;
  readonly stop: () => void;
}

/**
 * One blocked/errored lane as it appears in the aggregated gate's `issues`
 * payload — the wire shape the human reviewer sees per offending lane. The
 * `reason` is the lane's surfaced cause (see {@link roundChildReason}).
 */
interface FanOutIssue {
  readonly index: number;
  readonly status: 'blocked' | 'errored';
  readonly reason: string;
}

interface EvolveRecordedLane {
  readonly index: number;
  readonly batchIndex: number;
  readonly stepName: string;
  readonly nodeId?: number;
  readonly parent?: readonly number[];
  readonly stepDir?: string;
}

interface FanOutDbReconstruction {
  readonly batchIndex: number;
  readonly recordedByLane: ReadonlyMap<number, EvolveRecordedLane>;
  readonly missingLanes: readonly number[];
  readonly runDir: string;
}

type FanOutDbReconstructionResult =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly reconstruction: FanOutDbReconstruction }
  | { readonly kind: 'error'; readonly error: string };

/**
 * The step of a fan-out batch that failed, as named in the message log
 * (`fan-out "<state>" <stage>`). `configuration` and `preflight` refuse the
 * batch before any lane starts.
 */
type FanOutFailureStage =
  | 'configuration'
  | 'preflight'
  | 'batch reconstruction'
  | 'lane preparation'
  | 'join'
  | 'cognition promotion'
  | 'stop signals';

/**
 * Crash-resume overrides threaded into the barrier `sample_batch`: `batchIndex`
 * pins the in-flight `step_<batch>_lane_<k>` number (so re-run lanes reuse their
 * pre-crash step names) and `lanes` restricts the draw to the lanes that did not
 * record before the crash. Both default to "fresh batch" when omitted (bridge
 * derives the index, draws all `workers` lanes). See {@link reconstructFanOutBatchFromDb}.
 */
interface FanOutBatchOptions {
  readonly batchIndex?: number;
  readonly lanes?: readonly number[];
}

// Parses the fan-out step name `step_<batch>(_lane_<k>)?`: group 1 = batch index,
// group 2 = lane id (undefined for legacy non-lane `step_<batch>` nodes). The
// TS twin of Python STEP_NAME_RE in scripts/evolve_result.py; the writer is
// {@link evolveStepName} in lane-template.ts. All three move together.
const EVOLVE_LANE_STEP_RE = /^step_(\d+)(?:_lane_(\d+))?$/;

/**
 * Parses an agent_status block into one of three explicit states: `ok` with the
 * parsed output, `missing` when no block was present, or `malformed` when a
 * block was present but failed YAML or schema validation. Callers branch on the
 * `kind` discriminator to decide whether to retry, abort, or proceed.
 */
type ParseResult =
  { kind: 'ok'; output: AgentOutput } | { kind: 'missing' } | { kind: 'malformed'; error: AgentStatusParseError };

function tryParseAgentStatus(responseText: string): ParseResult {
  try {
    const output = parseAgentStatus(responseText);
    return output ? { kind: 'ok', output } : { kind: 'missing' };
  } catch (err) {
    if (err instanceof AgentStatusParseError) {
      return { kind: 'malformed', error: err };
    }
    throw err;
  }
}

/**
 * Conservative between-turn admission check, applied before a state's primary
 * turn and before every recovery, replacement and artifact-retry turn. Session
 * limits remain per-turn; a completed turn may take cumulative usage past the
 * same threshold, but no later turn is launched once that is visible.
 * Host-derived numbers only (an agent's self-reported cost never counts); see
 * `session/budget-admission.ts` for the rationale and for why
 * `maxSessionSeconds` is excluded.
 */
function cumulativeBudgetExhaustionReason(session: Session): string | undefined {
  const exhaustion = findCumulativeBudgetExhaustion(session.getBudgetStatus());
  return exhaustion === undefined ? undefined : describeCumulativeBudgetExhaustion(exhaustion);
}

/**
 * True for a turn the session stopped while it ran: at its per-turn
 * wall-clock limit, or because the bundle's MITM budget gate refused a
 * completion (`turnStopped`). Matched by the error-code discriminant (not
 * `instanceof`) so the workflow layer does not depend on the session module
 * that threw it.
 */
function isStoppedTurnBudgetExhaustion(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, dimension, turnStopped } = err as { code?: unknown; dimension?: unknown; turnStopped?: unknown };
  return code === 'BUDGET_EXHAUSTED' && (dimension === 'wall_clock' || turnStopped === true);
}

/**
 * Gate idle timeout of a raise, in minutes, or undefined when the run waits
 * for its decision indefinitely: the workflow's `gateIdleTimeoutMinutes`
 * when set (`null` disables the timeout), otherwise
 * `DEFAULT_GATE_IDLE_TIMEOUT_MINUTES` for a run that holds a shared
 * container at the gate. A run that holds nothing keeps waiting by default:
 * stopping it would release nothing. Exported for tests.
 */
export function resolveGateIdleTimeoutMinutes(
  settings: WorkflowSettings | undefined,
  holdsContainer: boolean,
): number | undefined {
  const configured = settings?.gateIdleTimeoutMinutes;
  if (configured === null) return undefined;
  if (configured !== undefined) return configured;
  return holdsContainer ? DEFAULT_GATE_IDLE_TIMEOUT_MINUTES : undefined;
}

/**
 * Writes directly to process.stderr, bypassing any console hijacking
 * (e.g., logger.setup() redirecting console.error to a file).
 * Used for critical error messages that MUST reach the terminal.
 */
function writeStderr(message: string): void {
  process.stderr.write(`${toDisplayText(message, { maxLength: 4096 })}\n`);
}

/**
 * The host-mount findings a bundle teardown resolved with
 * (`DockerInfrastructureTeardown.privilegedFiles`); a stub teardown resolves
 * with none.
 */
function teardownPrivilegedFiles(teardown: unknown): HostPrivilegedFilesDiagnostic | undefined {
  if (typeof teardown !== 'object' || teardown === null) return undefined;
  return (teardown as DockerInfrastructureTeardown).privilegedFiles;
}

/** True when `path` names an existing directory (following symlinks). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `path` itself is a directory, not a symlink to one. */
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Per-run subdirectory name for the staged copy of the workflow's bundled `skills/` tree. */
const STAGED_WORKFLOW_SKILLS_SUBDIR = RUN_SKILLS_DIRNAME;
/** Per-run subdirectory name for the staged copy of workflow helper scripts. */
const STAGED_WORKFLOW_SCRIPTS_SUBDIR = RUN_SCRIPTS_DIRNAME;

/**
 * Workspace-relative segments of the evolve engine's per-step code directory:
 * `<workspace>/.evolve_runs/main/steps/<step_name>/code`.
 *
 * This layout is OWNED by the Python bridge (`evolve_result.py` — the engine
 * writes each candidate's source under `steps/<step_name>/code`, and
 * `evolve-eval` reads it from there). The TS side only READS it host-side to
 * content-hash fan-out candidates ({@link computeFanOutCandidateDuplicateStats}),
 * so this const duplicates a path the Python defines. Keep the two in sync: if
 * the engine's on-disk step layout changes, update both here and in the bridge.
 */
const EVOLVE_STEP_CODE_PATH_SEGMENTS = ['.evolve_runs', 'main', 'steps'] as const;
const EVOLVE_STEP_CODE_FILENAME = 'code';

// Caps for host-side reads of agent-writable workspace files. Every such read
// goes through the no-follow, non-blocking, bounded helpers in hardened-fs: a
// container can replace any of these paths with a FIFO, a symlink to
// /dev/zero or a symlinked directory, and a blocking or unbounded read here
// would hang or crash the daemon hosting every other workflow and session.
/** A deterministic state's `resultFile` (a small JSON verdict envelope). */
const MAX_RESULT_FILE_BYTES = 1024 * 1024;
/** The evolve engine's `database_data/nodes.json` node map. */
const MAX_EVOLVE_NODES_BYTES = 64 * 1024 * 1024;
/** One fan-out candidate source (`steps/<step>/code`), hashed for duplicate stats. */
const MAX_EVOLVE_CANDIDATE_BYTES = 16 * 1024 * 1024;

/**
 * Bounds for the workspace-root listing behind stall detection. Larger than
 * {@link ARTIFACT_WALK_LIMITS} because a code workspace is legitimately bigger
 * than one artifact directory; past it the listing is partial (and the hash
 * says so), which can only make a stall go undetected.
 */
const WORKSPACE_HASH_LIMITS: WalkLimits = { maxEntries: 200_000, maxDepth: 64 };

/** The only guard that reads `AgentInvokeResult.outputHash` (machine-builder). */
const STALL_GUARD = 'isStalled';
/** `outputHash` for a state with no `isStalled` transition: nothing reads it, so nothing is walked. */
const OUTPUT_HASH_NOT_COMPUTED = '';

/**
 * Stages the workflow package's `skills/` tree into the run directory
 * so the workflow becomes self-contained at start time. After this call
 * the per-run path (`<runMetaDir>/workflow-skills/`) is the canonical
 * source of workflow-bundled skills for both initial-set staging and
 * per-state restage; the original package path under
 * `getWorkflowPackageDir(definitionPath)` is no longer consulted at
 * runtime.
 *
 * Returns the absolute path to the staged copy when source `skills/`
 * exists and was copied, `undefined` when the source has no `skills/`
 * directory (the workflow simply ships none — not an error). Throws
 * only on copy I/O failure, since a half-copied tree would be worse
 * than a missing one.
 *
 * Why copy at start (not symlink): the package directory may be
 * deleted, moved, or rebuilt between start and resume — symlink chases
 * lead to "skills silently empty on resume" without diagnostic. A
 * shallow-recursive copy decouples the run from its source-of-record
 * location.
 */
export function stageWorkflowSkillsAtStart(packageDir: string, runMetaDir: string): string | undefined {
  return stageWorkflowSubdir(packageDir, runMetaDir, 'skills', STAGED_WORKFLOW_SKILLS_SUBDIR);
}

export function stageWorkflowScriptsAtStart(packageDir: string, runMetaDir: string): string | undefined {
  return stageWorkflowSubdir(packageDir, runMetaDir, 'scripts', STAGED_WORKFLOW_SCRIPTS_SUBDIR);
}

/**
 * Shallow-recursive copy of a workflow package subdir (`skills` / `scripts`) into
 * the run dir. Returns the staged path, or `undefined` when the source subdir is
 * absent (the workflow ships none — not an error). Throws only on copy I/O
 * failure (a half-copied tree is worse than a missing one). See
 * `stageWorkflowSkillsAtStart` above for why we copy rather than symlink.
 */
function stageWorkflowSubdir(
  packageDir: string,
  runMetaDir: string,
  sourceSubdir: string,
  stagedSubdir: string,
): string | undefined {
  const source = resolve(packageDir, sourceSubdir);
  if (!existsSync(source)) return undefined;

  return copyWorkflowStagedDirectory(source, runMetaDir, stagedSubdir === RUN_SKILLS_DIRNAME ? 'skills' : 'scripts');
}

/**
 * Resolves the workflow-skills directory to use for a resumed workflow.
 *
 * Priority order, from most-trusted to most-degraded:
 *   1. The checkpointed staged path, if it still exists. The orchestrator
 *      writes this at start under the run dir; we own the lifecycle so
 *      it should normally still be there.
 *   2. A fresh stage from the original package dir, when the staged
 *      copy is gone but the source is reachable. Recovers from manual
 *      pruning of the run dir without losing skills on resume.
 *   3. `undefined`, with a stderr warning. Both the staged copy and
 *      the source are gone; degrade gracefully but make the loss
 *      visible (the original bug — silent empty discovery — is what
 *      this whole resolver exists to prevent).
 *
 * Pre-feature checkpoints have no `workflowSkillsDir` field; they
 * trigger the case-(2) fresh stage transparently.
 */
function resolveWorkflowSkillsDirOnResume(opts: {
  workflowId: WorkflowId;
  checkpointedStagedDir: string | undefined;
  packageDir: string;
  runMetaDir: string;
  allowPackageRecovery: boolean;
}): string | undefined {
  const { workflowId, checkpointedStagedDir, packageDir, runMetaDir, allowPackageRecovery } = opts;

  if (checkpointedStagedDir !== undefined && existsSync(checkpointedStagedDir)) {
    const staged = validatedWorkflowStagedDirectory(runMetaDir, checkpointedStagedDir, 'skills');
    if (staged === undefined)
      throw new WorkflowResumeError('WORKFLOW_NOT_RESUMABLE', 'Invalid workflow-skills staging directory');
    return staged;
  }

  if (!allowPackageRecovery) return undefined;

  try {
    const restaged = stageWorkflowSkillsAtStart(packageDir, runMetaDir);
    if (restaged !== undefined) {
      writeStderr(
        `[workflow] Resume ${workflowId}: workflow-skills staged copy missing, re-staged from ${packageDir}.`,
      );
      return restaged;
    }
  } catch (err) {
    writeStderr(
      `[workflow] Resume ${workflowId}: failed to re-stage workflow skills from ${packageDir}: ${toErrorMessage(err)}`,
    );
    return undefined;
  }

  // Both paths gone. Without this warning the resumed run silently
  // loses every workflow-bundled skill — the exact failure mode this
  // function was added to prevent.
  writeStderr(
    `[workflow] Resume ${workflowId}: no workflow-skills available (staged copy and ${packageDir}/skills both missing). Workflow-bundled skills will not be available in this run.`,
  );
  return undefined;
}

function resolveWorkflowScriptsDirOnResume(opts: {
  workflowId: WorkflowId;
  checkpointedStagedDir: string | undefined;
  packageDir: string;
  runMetaDir: string;
  allowPackageRecovery: boolean;
}): string | undefined {
  const { workflowId, checkpointedStagedDir, packageDir, runMetaDir, allowPackageRecovery } = opts;

  if (checkpointedStagedDir !== undefined && existsSync(checkpointedStagedDir)) {
    const staged = validatedWorkflowStagedDirectory(runMetaDir, checkpointedStagedDir, 'scripts');
    if (staged === undefined)
      throw new WorkflowResumeError('WORKFLOW_NOT_RESUMABLE', 'Invalid workflow-scripts staging directory');
    return staged;
  }

  if (!allowPackageRecovery) return undefined;

  try {
    const restaged = stageWorkflowScriptsAtStart(packageDir, runMetaDir);
    if (restaged !== undefined) {
      writeStderr(
        `[workflow] Resume ${workflowId}: workflow-scripts staged copy missing, re-staged from ${packageDir}.`,
      );
      return restaged;
    }
  } catch (err) {
    writeStderr(
      `[workflow] Resume ${workflowId}: failed to re-stage workflow scripts from ${packageDir}: ${toErrorMessage(err)}`,
    );
    return undefined;
  }

  // Both paths gone. Only warn if scripts were previously staged
  // (`checkpointedStagedDir` set): a workflow that never shipped scripts must not
  // warn about "missing" scripts on every resume. `stageWorkflowScriptsAtStart`
  // already proved `scripts/` is absent here, so no source re-stat is needed.
  if (checkpointedStagedDir === undefined) {
    return undefined;
  }

  writeStderr(
    `[workflow] Resume ${workflowId}: no workflow-scripts available (staged copy and ${packageDir}/scripts both missing). Container deterministic helpers will not be available in this run.`,
  );
  return undefined;
}

/**
 * The audit log path of every bundle the run's earlier legs minted
 * (`containers/<bundleId>/audit.jsonl`; a file need not exist). Listed at
 * resume, before the resumed leg mints any bundle, so it names exactly the
 * earlier legs' bundles (see `WorkflowInstance.priorBundleAuditLogPaths`).
 *
 * Only a coordinator with taint escalation enabled reads these files. A
 * containers directory that cannot be listed is returned itself, so that
 * replay fails closed (a directory or an unreadable path taints the
 * session) instead of silently restoring nothing.
 */
function listPriorBundleAuditLogPaths(workflowId: WorkflowId): readonly string[] {
  let containersDir: string;
  try {
    containersDir = getWorkflowContainersDir(workflowId);
  } catch {
    // An id that is not a path-safe slug cannot mint a bundle either (every
    // bundle path asserts the same), so there is nothing to replay.
    return [];
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(containersDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [containersDir];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(containersDir, entry.name, 'audit.jsonl'))
    .sort();
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Handle for writing to a workflow tab in the mux. */
export interface WorkflowTabHandle {
  write(text: string): void;
  setLabel(label: string): void;
  close(): void;
}

/**
 * Inputs for creating a workflow-scoped Docker infrastructure bundle.
 * Supplied by the orchestrator when `settings.sharedContainer === true`
 * and the workflow uses a Docker agent. One input produces one bundle;
 * bifurcated workflows invoke the factory once per distinct
 * `containerScope` their agent states declare.
 */
export interface CreateWorkflowInfrastructureInput {
  readonly workflowId: WorkflowId;
  /** Actual run root from the orchestrator, independent of checkpoint paths. */
  readonly workflowRunDir?: string;
  /**
   * Stable key for this bundle. Minted by the orchestrator via
   * `createBundleId()` before the factory is invoked so both the
   * coordinator's control-socket path and the bundle's on-disk
   * directory share the same identifier. Each unique `scope` under a
   * workflow gets its own fresh `BundleId`.
   */
  readonly bundleId: BundleId;
  readonly agentId: AgentId;
  /**
   * Path to the bundle's coordinator control socket. The orchestrator
   * starts the coordinator's HTTP control server at this path after the
   * bundle is created (see `startWorkflowControlServer` dep). The path
   * is included here so the factory may optionally pre-create the
   * containing directory or use it for labelling.
   */
  readonly controlSocketPath: string;
  /**
   * Workspace directory for this workflow run. Used as the allowed
   * directory for the filesystem MCP server and all sessions that run
   * in the shared container. Either a user-supplied `--workspace <path>`
   * or the default `<baseDir>/<workflowId>/workspace/`.
   *
   * All sessions in a workflow mount the workflow's workspace directory;
   * no session-scoped sandbox is ever used under shared-container mode.
   * Scoped bundles share this workspace — isolation happens at the
   * coordinator/policy level, not the filesystem.
   */
  readonly workspacePath: string;
  /**
   * Scope label this bundle was minted for. Emitted directly as the
   * `ironcurtain.scope=<scope>` Docker label on the container and its
   * sidecar. The orchestrator resolves
   * `stateConfig.containerScope ?? DEFAULT_CONTAINER_SCOPE` before calling
   * the factory, so this is always a concrete string.
   *
   * See `docs/designs/workflow-session-identity.md` §2.5.
   */
  readonly scope: string;
  /**
   * Union of MCP server names required across every agent state in this
   * scope. The orchestrator never adds the memory server to it, and the
   * default factory refuses to start one even if a compiled policy names
   * it: see `getRequiredServersForScope`.
   */
  readonly requiredServers: ReadonlySet<string>;
  /**
   * Widest fan-out (lane count) of any segment that runs in this scope, or
   * 1 when none does. The default factory hands it to the bundle's
   * coordinator (`ToolCallCoordinatorOptions.maxLanes`): each lane's agent
   * connection gets its own circuit-breaker window, and this bounds the
   * all-lanes total. Stub factories may ignore it.
   */
  readonly maxLanes: number;
  /**
   * The run's task scope (`--task-scoped`), canonical and validated. The
   * bundle's coordinator intersects it with every persona policy it loads;
   * absent for an unscoped run.
   */
  readonly taskPolicyDir?: string;
  /**
   * Initial skills staged at bundle creation (user + workflow only).
   * Persona skills are layered in per-state via `bundle.restageSkills`.
   */
  readonly resolvedSkills?: readonly ResolvedSkill[];
  /** Per-run staged workflow scripts directory to mount read-only in the bundle. */
  readonly workflowScriptsDir?: string;
  /**
   * Optional immutable snapshot image digest to use for the main container,
   * with the agent image build it was committed from. The bundle uses it only
   * when it resolves that same build (see `selectResumableSnapshot`).
   */
  readonly baseImageOverride?: string;
  /** `ContainerSnapshotRef.agentBuildHash` of {@link baseImageOverride}. */
  readonly baseImageAgentBuildHash?: string;
  /**
   * `ContainerSnapshotRef.agentSudo` of {@link baseImageOverride}, when the
   * snapshot recorded it. A bundle planned with `agentSudo: false` uses only a
   * snapshot recorded as taken without sudo.
   */
  readonly baseImageAgentSudo?: boolean;
  /**
   * In-process escalation handler for the bundle's coordinator. The
   * orchestrator binds it to the workflow instance so a tool call that
   * policy escalates inside the shared container surfaces as a
   * {@link WorkflowToolCallEscalation} (lifecycle event, `getStatus`
   * consumers, `resolveToolCallEscalation`) instead of being denied for
   * lack of a handler. The default factory hands it to
   * `createDockerInfrastructure`; stub factories may ignore it.
   */
  readonly onEscalation?: EscalationPromptFn;
  /**
   * The run's effective resource limits (`WorkflowBudget.limits`). The
   * bundle's MITM budget gate enforces their token and cost caps on every
   * lane of the scope together. Absent: the loaded config's limits apply.
   */
  readonly resourceBudget?: ResolvedResourceBudgetConfig;
  /**
   * Audit logs of the bundles a resumed run's earlier legs minted (empty
   * for a run that was not resumed). The default factory sets them as
   * `IronCurtainConfig.taintReplayAuditLogPaths`, so with taint escalation
   * enabled the bundle's coordinator starts tainted when the run had read
   * untrusted content before it was resumed.
   */
  readonly taintReplayAuditLogPaths?: readonly string[];
  /**
   * The bundle's commit channel: the target of its coordinator's
   * `workflow_commit` tool. Every agent state that borrows the bundle
   * commits its result through it. The default factory hands it to
   * `createDockerInfrastructure`; the coordinator then registers the tool
   * and calls `attach()`. A factory that ignores it leaves the channel
   * unattached, and the bundle's states fall back to the YAML status block.
   */
  readonly workflowCommit?: WorkflowCommitHandler;
  /**
   * Present when the scope's agent states are read-only
   * (`workspaceAccess: read-only`, see `readOnlyWorkspaceForScope`): the
   * bundle mounts `/workspace` read-only, runs without nested Docker, and its
   * coordinator denies every change outside these writable directories (the
   * scope's `.workflow/<output>` directories) under every persona it loads.
   * The default factory applies it with `applyReadOnlyWorkspace` and the
   * bundle records it (`DockerInfrastructure.readOnlyWorkspace`); a read-only
   * state refuses a bundle from a factory that ignored it.
   */
  readonly readOnlyWorkspace?: ReadOnlyWorkspace;
}

/** Inputs for starting the coordinator's HTTP control server on a workflow bundle. */
export interface StartWorkflowControlServerInput {
  readonly infra: DockerInfrastructure;
  readonly socketPath: string;
}

/** Inputs for the `loadPolicy` RPC dispatched at each agent state entry. */
export interface LoadPolicyRpcInput {
  readonly socketPath: string;
  readonly persona: string;
  readonly policyDir: string;
  /** Hard timeout in milliseconds; the call aborts if the coordinator does not ack in time. */
  readonly timeoutMs?: number;
}

/** Dependencies injected into the orchestrator. */
export interface WorkflowOrchestratorDeps {
  /** Factory for creating agent sessions. */
  readonly createSession: (options: SessionOptions) => Promise<Session>;

  /** Factory for creating read-only workflow tabs in the mux. */
  readonly createWorkflowTab: (label: string, workflowId: WorkflowId) => WorkflowTabHandle;

  /** Callback to raise a human gate in the mux UI. */
  readonly raiseGate: (gate: HumanGateRequest) => void;

  /** Callback to dismiss a human gate from the mux UI. */
  readonly dismissGate: (workflowId: WorkflowId, gateId: string) => void;

  /** Base directory for workflow artifacts and checkpoints. */
  readonly baseDir: string;

  /** Persistent checkpoint store for workflow resume. */
  readonly checkpointStore: CheckpointStore;

  /**
   * Resolved user config. Consulted for container snapshots and, when a
   * shared-container bundle is minted, to report the personas in its
   * scope that have memory enabled but run without it: shared-container
   * bundles start no memory server (see `reportUnavailableMemory` and
   * docs/designs/per-persona-memory-optin.md §1.2).
   */
  readonly userConfig: ResolvedUserConfig;

  /**
   * Protected paths (`IronCurtainConfig.protectedPaths`) that
   * `validateWorkspacePath()` checks a caller-supplied workspace against,
   * in `start()` and when `resume()` meets a checkpoint whose workspace is
   * not the run's derived default. When omitted, the orchestrator loads
   * them from `loadConfig()` at validation time.
   */
  readonly protectedPaths?: readonly string[];

  /**
   * Directory of the cross-process workspace locks (see
   * `src/workflow/run-lock.ts`). Every orchestrator that may share a
   * workspace must use the same directory; defaults to
   * `{home}/workflow-workspace-locks`. The run lock always lives in the run's
   * own directory under `baseDir`.
   */
  readonly workspaceLockDir?: string;

  /**
   * Factory for creating a workflow-scoped Docker infrastructure bundle.
   * Called at workflow start when `settings.sharedContainer === true`
   * and the workflow uses a Docker agent. When omitted, the orchestrator
   * loads the default implementation lazily from `src/docker/docker-infrastructure.ts`.
   * Tests override this to avoid spinning up real Docker resources.
   */
  readonly createWorkflowInfrastructure?: (input: CreateWorkflowInfrastructureInput) => Promise<DockerInfrastructure>;

  /**
   * Teardown counterpart for `createWorkflowInfrastructure`. Called on
   * workflow terminal states, abort, and shutdownAll. When omitted, the
   * orchestrator loads the default implementation lazily from
   * `src/docker/docker-infrastructure.ts`. Tests override this to avoid
   * touching real Docker resources. Resolves with what the teardown found
   * for the user (`DockerInfrastructureTeardown`, as
   * `destroyDockerInfrastructure` does: the run records it in its message
   * log); a stub may resolve with nothing.
   */
  readonly destroyWorkflowInfrastructure?: (infra: DockerInfrastructure) => Promise<unknown>;

  /**
   * Attaches the coordinator's HTTP control server to the workflow
   * bundle. Called once at workflow start (after the bundle is created)
   * whenever `settings.sharedContainer === true`. The default
   * implementation reaches through `infra.proxy.getPolicySwapTarget()` and
   * calls `startControlServer({ socketPath })`. Tests override this to
   * intercept the control-server wiring entirely.
   */
  readonly startWorkflowControlServer?: (input: StartWorkflowControlServerInput) => Promise<void>;

  /**
   * Dispatches a `POST /__ironcurtain/policy/load` request to the
   * workflow's coordinator control socket. Called before each agent
   * state invocation to rotate the audit stream and swap the active
   * policy. The default implementation speaks HTTP/1.1 over a Unix
   * domain socket (no extra dependency). Tests inject a fake handler
   * to assert on the RPC shape without standing up a real socket.
   */
  readonly loadPolicyRpc?: (input: LoadPolicyRpcInput) => Promise<void>;

  /**
   * Raw trajectory-capture override for this workflow run (CLI
   * `--capture-traces` flag). Passed UNRESOLVED to the infrastructure
   * factory, which is the single place that resolves it against
   * `userConfig.capture?.enabled`. When resolution yields true, the
   * factory constructs a writer for each bundle and `executeAgentState`
   * brackets each agent's session with `bundle.beginCaptureSession` /
   * `bundle.endCaptureSession`. Undefined falls through to config.
   * See docs/designs/mitm-token-trajectory-capture.md §10.
   */
  readonly captureTracesOverride?: boolean;

  /**
   * Cap on concurrent workflow agent environments (see
   * `agent-slot-pool.ts`): every shared-container run reserves slots for
   * its bundles before the first mint, every other agent session takes one
   * for its lifetime, and both wait while the cap is reached. When omitted
   * the orchestrator builds its own pool from
   * `userConfig.maxConcurrentAgentSessions`; the daemon runs all workflows
   * through one orchestrator, so that pool is daemon-wide. Tests inject a
   * small pool to observe queueing.
   */
  readonly agentSlots?: AgentSlotPool;
}

/** Lifecycle events emitted by the orchestrator. */
export type WorkflowLifecycleEvent =
  | {
      readonly kind: 'started';
      readonly workflowId: WorkflowId;
      readonly name: string;
      readonly taskDescription: string;
    }
  | { readonly kind: 'state_entered'; readonly workflowId: WorkflowId; readonly state: string }
  | { readonly kind: 'completed'; readonly workflowId: WorkflowId }
  | {
      readonly kind: 'failed';
      readonly workflowId: WorkflowId;
      readonly error: string;
      /** Present only after the terminal checkpoint and log marker are durable. */
      readonly phase?: 'failed' | 'aborted';
    }
  | { readonly kind: 'gate_raised'; readonly workflowId: WorkflowId; readonly gate: HumanGateRequest }
  | { readonly kind: 'gate_dismissed'; readonly workflowId: WorkflowId; readonly gateId: string }
  /**
   * A tool call escalated by policy during an agent state now waits for a
   * human. The agent is blocked inside the call until it is resolved via
   * `resolveToolCallEscalation` or expires at the escalation timeout.
   */
  | {
      readonly kind: 'tool_call_escalation_raised';
      readonly workflowId: WorkflowId;
      readonly escalation: WorkflowToolCallEscalation;
    }
  /** Pairs 1:1 with `tool_call_escalation_raised`; `expired` means nobody decided. */
  | {
      readonly kind: 'tool_call_escalation_resolved';
      readonly workflowId: WorkflowId;
      readonly escalationId: string;
      readonly outcome: WorkflowToolCallEscalationOutcome;
    }
  | {
      readonly kind: 'agent_started';
      readonly workflowId: WorkflowId;
      readonly state: string;
      readonly persona: string;
      /**
       * Session ID of the agent session. Consumers (e.g. the daemon's
       * token-stream bridge wiring) use this to register the session
       * so token events produced by this agent are routable to
       * `observe --all` subscribers.
       */
      readonly sessionId: SessionId;
    }
  | {
      readonly kind: 'agent_completed';
      readonly workflowId: WorkflowId;
      readonly state: string;
      readonly persona: string;
      readonly verdict: string;
    }
  /**
   * Emitted unconditionally in the `executeAgentState` finally block --
   * both on success (after `agent_completed`) and on failure (when the
   * agent state threw or the verdict retry failed). Pairs 1:1 with
   * `agent_started` and signals that the session has been closed.
   *
   * Consumers that registered per-agent resources (e.g. token-stream
   * bridge entries) must clean up in response to this event so no
   * state leaks across rapid state transitions.
   */
  | {
      readonly kind: 'agent_session_ended';
      readonly workflowId: WorkflowId;
      readonly state: string;
      readonly sessionId: SessionId;
    };

/** Extended workflow detail for the web UI. */
export interface WorkflowDetail {
  readonly budget?: WorkflowBudget;
  /** Run-wide usage: tokens by kind, cost, active time and tracking status. */
  readonly usage?: WorkflowUsage;
  readonly definition: WorkflowDefinition;
  readonly transitionHistory: readonly TransitionRecord[];
  readonly workspacePath: string;
  readonly context: {
    readonly taskDescription: string;
    readonly round: number;
    readonly maxRounds: number;
    /** Run-wide total tokens (`usage.totalTokens`). */
    readonly totalTokens: number;
    readonly visitCounts: Record<string, number>;
  };
}

/** Terminal reason recorded by `abort()` when the caller names none. */
export const DEFAULT_WORKFLOW_ABORT_REASON = 'Workflow aborted by user';

/** Options for stopping runs (`abort`, `shutdownAll`). */
export interface WorkflowStopOptions {
  /**
   * Recorded as the terminal `reason` in the checkpoint, the `failed`
   * lifecycle event and the tab, so a daemon shutdown or an interrupt is not
   * mislabeled as a user abort. Defaults to {@link DEFAULT_WORKFLOW_ABORT_REASON}.
   */
  readonly reason?: string;
  /**
   * Upper bound, in milliseconds, on the time one run spends committing its
   * `snapshotOnStop` container snapshots. Each scope's commit gets what is
   * left of the budget as its timeout, and scopes the budget no longer covers
   * stop without a snapshot (resume then starts them fresh). Callers that
   * must exit by a deadline (a signal handler's force exit, systemd's stop
   * timeout) pass one; without it every commit gets the default 10-minute
   * timeout.
   */
  readonly snapshotBudgetMs?: number;
}

/** Optional settings for {@link WorkflowController.start}. */
export interface WorkflowStartOptions {
  /**
   * Task scope of the run (`--task-scoped`): a published task-scope
   * directory. Opt-in only; absent means the run is not task-scoped.
   */
  readonly taskPolicyDir?: string;
}

/** Options of {@link WorkflowController.resume}. */
export interface WorkflowResumeOptions {
  /**
   * Apply the definition's current resource budget instead of the one the
   * checkpoint recorded.
   */
  readonly useCurrentBudget?: boolean;
  /**
   * Ignore the container snapshots the checkpoint references: no scope starts
   * from one, and the resume checkpoint no longer lists them, so no later
   * stop removes them as superseded. For a checkpoint whose references
   * nothing vouches for (`workflow resume-standalone` of a base directory
   * other than this home's own); a daemon import drops them the same way.
   */
  readonly ignoreContainerSnapshots?: boolean;
}

/** The narrow controller interface exposed to the mux. */
export interface WorkflowController {
  /**
   * Starts a workflow. A caller-supplied `workspacePath` must be an existing
   * directory that passes `validateWorkspacePath()`; the run then uses its
   * canonical form. A rejected path throws a `WorkspaceValidationError`
   * (`code` discriminant) before anything is created. Without one, the run
   * gets a fresh default workspace under the base directory.
   *
   * `options.taskPolicyDir` (`--task-scoped`) is a task scope compiled from
   * the task by the caller's CLI entry point: every agent state's policy is
   * intersected with it. A directory that does not validate throws before
   * anything is created.
   */
  start(
    definitionPath: string,
    taskDescription: string,
    workspacePath?: string,
    options?: WorkflowStartOptions,
  ): Promise<WorkflowId>;
  resume(workflowId: WorkflowId, options?: WorkflowResumeOptions): Promise<void>;
  listResumable(): WorkflowId[];
  getStatus(id: WorkflowId): WorkflowStatus | undefined;
  getBudget(id: WorkflowId): WorkflowBudget | undefined;
  getDetail(id: WorkflowId): WorkflowDetail | undefined;
  listActive(): readonly WorkflowId[];
  /**
   * Applies a decision bound to one raise of a gate (`event.gateId`). Throws
   * `GateResolutionError` (see its `code`) when the workflow is unknown, not
   * waiting, the id is not the active raise, the event is not one the gate
   * accepts, or feedback is missing; a refused decision changes nothing.
   */
  resolveGate(id: WorkflowId, event: HumanGateEvent): void;
  /** Tool-call escalations currently waiting for a human decision in this workflow. */
  listToolCallEscalations(id: WorkflowId): readonly WorkflowToolCallEscalation[];
  /**
   * Settles a pending tool-call escalation. Returns false when the workflow
   * or the escalation is unknown (already resolved, expired, or never raised).
   */
  resolveToolCallEscalation(
    id: WorkflowId,
    escalationId: string,
    decision: WorkflowToolCallEscalationDecision,
  ): boolean;
  /**
   * Stops a run: every in-flight session, fan-out lane and deterministic
   * command is told to stop before the terminal checkpoint is written, and
   * the run stays resumable. On a run that is already stopping (another
   * abort, a terminal transition) it resolves once that stop has finished.
   */
  abort(id: WorkflowId, options?: WorkflowStopOptions): Promise<void>;
  onEvent(callback: (event: WorkflowLifecycleEvent) => void): void;
  /**
   * Aborts every run and drains every teardown. Final: afterwards `start()`
   * and `resume()` refuse, so a request racing the shutdown cannot leave a
   * run behind.
   */
  shutdownAll(options?: WorkflowStopOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** One entry of {@link WorkflowInstance.liveAgentTurnsByBundle}. */
interface LiveAgentTurn {
  /** Persona whose policy the invocation's tool calls must be evaluated under. */
  readonly persona: string;
  /** Settles once the invocation has finished and its session is closed. */
  readonly ended: Promise<void>;
}

/**
 * A tool-call escalation waiting on the workflow's human route. Two kinds
 * share this shape: coordinator escalations from a shared-container bundle
 * (`settle` resolves the coordinator's in-process promise) and session
 * escalations surfaced by a session's file-IPC watcher (`settle` writes the
 * response file through `session.resolveEscalation`).
 */
interface PendingToolCallEscalation {
  readonly escalation: WorkflowToolCallEscalation;
  /**
   * Identity of the session whose watcher surfaced a file-IPC escalation;
   * absent for coordinator escalations. Used to expire the entries of a
   * session when its watcher reports expiry or the session ends.
   */
  readonly owner?: object;
  /**
   * Bundle whose coordinator raised a shared-container escalation; absent
   * for session escalations. Used to withdraw the bundle's escalations once
   * no agent turn is live on it any more.
   */
  readonly bundleId?: string;
  /** Delivers the human decision to whoever is waiting. */
  readonly settle: (decision: WorkflowToolCallEscalationDecision) => void;
  /**
   * Ends the coordinator's wait without a decision (it is denied as
   * cancelled, never as a human denial). Absent for session escalations:
   * their session's coordinator times them out or cancels them on close.
   */
  readonly withdraw?: (detail: string) => void;
}

interface WorkflowInstance {
  resourceBudget: WorkflowBudget;
  readonly id: WorkflowId;
  readonly definition: WorkflowDefinition;
  readonly definitionPath: string;
  /**
   * Per-run staged copy of the workflow package's `skills/` tree. Set
   * by `start()` (when the package ships skills) and by `resume()`
   * (which trusts the checkpointed path or re-stages on miss). All
   * runtime call sites that previously recomputed
   * `getWorkflowPackageDir(definitionPath) + '/skills'` read this
   * cached path instead — guarantees a stable directory across the
   * lifetime of the run even if the original package moves.
   *
   * `undefined` means the workflow has no bundled skills (either the
   * package shipped none, or both the staged copy and the source were
   * lost on resume — see `resolveWorkflowSkillsDirOnResume`).
   */
  readonly workflowSkillsDir: string | undefined;
  readonly workflowScriptsDir: string | undefined;
  /**
   * Canonical task-scope directory of a `--task-scoped` run, validated at
   * start and again on resume. Every agent state's session (or the bundle
   * coordinator in shared-container mode) intersects its persona policy
   * with it. Undefined for an unscoped run.
   */
  readonly taskPolicyDir: string | undefined;
  /**
   * The snapshot each scope restores from: those of the checkpoint resumed
   * from, replaced by the ones a stop commits once its terminal checkpoint is
   * saved. Every checkpoint save records them, so a crash between two stops
   * still resumes each scope from its snapshot, and the next stop finds them
   * on disk to remove as superseded.
   */
  containerSnapshots: Readonly<Record<string, ContainerSnapshotRef>> | undefined;
  readonly actor: AnyActorRef;
  readonly roundMachinesByState: ReadonlyMap<string, AnyStateMachine>;
  readonly gateStateNames: ReadonlySet<string>;
  readonly terminalStateNames: ReadonlySet<string>;
  readonly activeSessions: Set<Session>;
  /** A close remains active until teardown and its final usage sample finish. */
  readonly sessionClosures: WeakMap<Session, Promise<void>>;
  readonly artifactDir: string;
  /**
   * Root directory where the agent session operates. Either the run's
   * default `<baseDir>/<workflowId>/workspace`, derived and created by the
   * orchestrator, or the canonical path that `validateWorkspacePath()`
   * returned for a user-provided `--workspace`.
   */
  readonly workspacePath: string;
  readonly tab: WorkflowTabHandle;
  /** Accumulated transition records for checkpointing. */
  readonly transitionHistory: TransitionRecord[];
  /** Tracks the most recently detected state for status queries. */
  currentState: string;
  /** Set when the workflow reaches a terminal state. */
  finalStatus?: WorkflowStatus;
  /** True only after terminal persistence and infrastructure teardown finish. */
  terminalReady: boolean;
  /**
   * Per-raise id of the gate the machine is waiting at (see
   * `HumanGateRequest.gateId`). Minted when the machine enters a gate state
   * (before that transition's checkpoint, so resume restores it), cleared by
   * `resolveGate` once a decision bound to it passes validation.
   */
  activeGateId?: string;
  /**
   * The gate id most recently handed to `deps.raiseGate`. XState notifies
   * the actor subscription on every processed event, including ones the
   * gate state has no handler for, so this distinguishes a fresh raise from
   * a no-op snapshot while already waiting.
   */
  raisedGateId?: string;
  /**
   * Tool-call escalations waiting for a human, keyed by escalation id.
   * Populated by the bundle coordinator's in-process handler and by the
   * per-session escalation watchers; drained by `resolveToolCallEscalation`,
   * expiry (timeout / cancellation) and session end.
   */
  readonly pendingEscalations: Map<string, PendingToolCallEscalation>;
  /** Tracks the last error surfaced to avoid emitting duplicate lifecycle events. */
  lastSurfacedError?: string;
  /**
   * Unsafe artifact outputs already reported as security events (keyed by
   * reason and path), so a symlink planted once is logged once per run rather
   * than at every artifact check. Created on first use.
   */
  reportedArtifactRejections?: Set<string>;
  /** Timestamp when the current state was entered, for transition duration tracking. */
  stateEnteredAt?: number;
  /** Checkpoint saves that failed in a row; reset by the next successful save. */
  checkpointSaveFailures?: number;
  /** Append-only JSONL message log for debugging. */
  readonly messageLog: MessageLog;
  /**
   * Docker infrastructure bundles, keyed on the `containerScope` string
   * that minted them. Populated lazily: on the first `executeAgentState`
   * for a scope not yet present, the orchestrator mints a fresh
   * `BundleId`, builds the `DockerInfrastructure`, and inserts the
   * result under the scope key. Subsequent states with the same scope
   * borrow the existing entry.
   *
   * Empty for builtin workflows and for Docker workflows running
   * without `sharedContainer: true` (each state owns its own bundle in
   * that mode). Under `sharedContainer: true`, the default-scope entry
   * (`DEFAULT_CONTAINER_SCOPE` / `"primary"`) is what older code called
   * "the primary bundle" — now it is simply one entry among the rest.
   *
   * Lifecycle: entries are created on first use, destroyed only at
   * workflow terminal via `destroyWorkflowInfrastructure`.
   *
   * See `docs/designs/workflow-session-identity.md` §2.4.
   */
  readonly bundlesByScope: Map<string, DockerInfrastructure>;
  /**
   * Audit logs of the bundles the run's earlier legs minted, listed by
   * `resume` before this leg mints any (absent for a run that was not
   * resumed). Every bundle this leg mints replays them when taint
   * escalation is enabled: a resumed run mints new bundles with new audit
   * logs, and without the replay the taint an earlier leg recorded would
   * be lost. All scopes' logs are replayed (the checkpoint does not record
   * which scope a bundle served), which can only add taint.
   */
  readonly priorBundleAuditLogPaths?: readonly string[];
  /**
   * Memoized compiled-policy directory per persona. Populated on first
   * use by `cyclePolicy` to avoid re-reading `persona.json` / running
   * `loadConfig()` on every state transition.
   */
  readonly policyDirByPersona: Map<string, string>;
  /**
   * Last persona loaded into each bundle's coordinator, keyed by
   * `BundleId`. `cyclePolicy` consults this and skips the `loadPolicy`
   * RPC when a re-entry would install the same persona that is already
   * active — the coordinator's audit stream is already tagged with the
   * right persona and the policy engine is already correct.
   */
  readonly currentPersonaByBundle: Map<string, string>;
  /**
   * Agent invocations live on each shared-container bundle, keyed by
   * `BundleId`, each with the persona whose policy its tool calls need.
   * `cyclePolicy` waits for every live invocation of ANOTHER persona to end
   * before it swaps the bundle's single coordinator policy, so a swap never
   * changes the rules under a running turn. Serial states never overlap; the
   * case this exists for is a drained fan-out lane, whose in-flight turn keeps
   * running in the container after the batch returned (borrow-mode
   * `session.close()` does not stop it) while the run moves on to a state of
   * a different persona. See {@link registerLiveAgentTurn}.
   */
  readonly liveAgentTurnsByBundle: Map<string, Set<LiveAgentTurn>>;
  /**
   * Required-server snapshot taken at bundle mint, keyed by `BundleId`.
   * `cyclePolicy` checks each newly loaded persona's required servers
   * against this set so a mid-workflow persona recompile that adds a
   * server fails fast with a clear error instead of producing cryptic
   * "tool unavailable" runtime failures (no relay was spawned for the
   * new server).
   */
  readonly mintedServersByBundle: Map<string, ReadonlySet<string>>;
  /**
   * Agent slots reserved for this run's shared-container bundles: one per
   * scope the run can mint, taken in a single request before its first
   * mint (see {@link WorkflowOrchestrator.reserveBundleSlots}). Undefined
   * while the run holds no bundle and no mint is under way; returned once
   * its last bundle is gone.
   */
  bundleSlots?: Promise<AgentSlotLease>;
  /**
   * Bundle mints of this run currently in progress (waiting for slots,
   * building, or cleaning up an orphan). The slot reservation outlives a
   * teardown that races a mint until the mint has finished.
   */
  bundleMintsInFlight: number;
  /**
   * The agent slot held by each live session that brings its own
   * environment (no shared bundle). Released when the session's invocation
   * ends, or by `abort()` once it has closed the session, whichever comes
   * first (release is idempotent).
   */
  readonly sessionSlots: Map<Session, AgentSlotLease>;
  /**
   * Commit channel of each live shared-container bundle, keyed by
   * `BundleId`: the target of that bundle's `workflow_commit` tool (see
   * `workflow-commit.ts`). Created with the bundle in `ensureBundleForScope`
   * and dropped at teardown. States without a borrowed bundle get a
   * per-invocation channel instead.
   */
  readonly commitChannelsByBundle: Map<string, WorkflowCommitChannel>;
  /**
   * The gate idle timer of the raise the run is waiting at (see
   * `armGateIdleTimer`), if one is armed. Cleared when the gate is
   * resolved and when the run stops.
   */
  gateIdleTimer?: { readonly gateId: string; readonly timer: ReturnType<typeof setTimeout> };
  /**
   * The run's stop signal. Aborted at the very top of `abort()` (before its
   * first await) and by `destroyWorkflowInfrastructure`, which every stop
   * path (abort, shutdownAll, a terminal state) runs, so it means "this run
   * is stopping". Every executor re-checks it after each await
   * (`runAgentState`, `executeDeterministicState`, `runFanOutSegment`,
   * `ensureBundleForScope`): a session created after the abort is closed at
   * once and no further turn, lane, command or bundle mint starts. It kills
   * the process group of any host deterministic command still running,
   * including commands started by the resume replay, which has no XState
   * invoke signal of its own.
   * In particular an `ensureBundleForScope` call that suspended at
   * `await factory(...)` must observe it before publishing into
   * `bundlesByScope`; otherwise a container minted mid-abort would leak past
   * the post-teardown leak assertion.
   */
  readonly stopController: AbortController;
  /**
   * Waiters of the fan-out lanes currently running, so `abort()` can stop
   * them: a lane is a free-standing root actor that stopping the parent actor
   * does not reach. Registered by `runFanOutSegment` before the lanes start
   * and removed once the batch settles.
   */
  readonly fanOutChildren: Set<RoundChildWaiter>;
  /**
   * Cross-process run and workspace locks (see `run-lock.ts`), held from
   * `start()` / `resume()` until `terminalReady` and released by
   * {@link WorkflowOrchestrator.markTerminalReady}.
   */
  locks: { run?: ProcessLockHandle; workspace?: ProcessLockHandle };
  /**
   * Tracks the fire-and-forget Docker teardown started by
   * `handleWorkflowComplete` on a normal terminal. The terminal handler runs
   * inside the synchronous actor subscription and so cannot await teardown;
   * it stores the promise here instead. `shutdownAll` drains it so the CLI's
   * `process.exit()` does not race the in-flight teardown and orphan the
   * per-run `--internal` Docker network. Note that `destroyWorkflowInfrastructure`
   * snapshot-and-clears `bundlesByScope` synchronously, so a redundant destroy
   * pass no-ops while the real work stays captured in this promise — awaiting
   * it is the only way to observe teardown completion. The apple-container
   * backend loses this race every time (its VM shutdown is slow), so draining
   * the promise matters there in particular.
   */
  teardownPromise?: Promise<void>;
  /**
   * The run's terminal handling once it has begun: the rest of `abort()`
   * after it claimed `finalStatus`, or of `handleWorkflowComplete`. Settles
   * once the run is `terminalReady` (snapshot, terminal checkpoint, teardown
   * and lock release all done). A later stop (a second abort, `shutdownAll()`
   * during a user abort or a terminal snapshot) joins it rather than returning
   * while the first is still committing a snapshot, which would let the
   * caller tear the container down under the commit and exit before the
   * terminal checkpoint is written.
   */
  terminalHandling?: Promise<void>;
  /**
   * Stamped by `throwIfQuotaExhausted` when an agent turn reports
   * upstream quota exhaustion. `handleWorkflowComplete` consults this
   * to force an abort-like terminal phase and preserve the checkpoint,
   * regardless of which state the error target resolved to — so resume
   * still works for workflow definitions whose error target happens to
   * be a normal terminal (e.g. `done`) rather than `aborted`/`failed`.
   * Survives only in-process; the checkpoint itself does not record it.
   */
  quotaExhausted?: { readonly resetAt?: Date; readonly rawMessage: string };
  /**
   * Run-wide usage: tokens from the metrics bus (Docker sessions) and the
   * AI SDK (builtin sessions), session costs, at least what each bundle's
   * MITM budget gate charged, and active time, continued from the checkpoint
   * on resume. Read by the display, every checkpoint and the
   * `settings.workflowBudget` check. See workflow-usage.ts.
   */
  readonly usage: WorkflowUsageMeter;
  /** Metrics-bus subscription feeding `usage`; set while the run is live. */
  unsubscribeUsage?: () => void;
  /**
   * Sibling of `quotaExhausted`: drives the same checkpoint-preserving
   * abort path. Survives only in-process; the checkpoint does not
   * record it.
   */
  transientFailure?: { readonly kind: TransientFailureKind; readonly rawMessage: string };
  /**
   * Stamped when a state or lane step was refused because the run reached
   * its `settings.workflowBudget`. Drives the same checkpoint-preserving
   * abort path as `quotaExhausted`, even when a fan-out batch folded the
   * refused lane into a verdict. In-process only: a resumed run checks the
   * ceiling afresh before its first state.
   */
  workflowBudgetExhausted?: { readonly reason: string; readonly breach: WorkflowBudgetBreach };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class WorkflowOrchestrator implements WorkflowController {
  private readonly workflows = new Map<WorkflowId, WorkflowInstance>();
  private readonly lifecycleCallbacks: Array<(e: WorkflowLifecycleEvent) => void> = [];
  /** Set by `shutdownAll()`; from then on `start()` and `resume()` refuse. */
  private shuttingDown = false;
  /** Cap on concurrent agent environments across every workflow this orchestrator runs. */
  private readonly agentSlots: AgentSlotPool;

  constructor(private readonly deps: WorkflowOrchestratorDeps) {
    this.agentSlots =
      deps.agentSlots ??
      new AgentSlotPool(deps.userConfig.maxConcurrentAgentSessions ?? USER_CONFIG_DEFAULTS.maxConcurrentAgentSessions);
  }

  // -----------------------------------------------------------------------
  // Run lifecycle: stop signal, locks, terminal readiness
  // -----------------------------------------------------------------------

  /** True once the run has begun stopping (abort, shutdown or terminal teardown). */
  private isStopping(instance: WorkflowInstance): boolean {
    return instance.stopController.signal.aborted;
  }

  /** Throws when the run is stopping, naming what was not started. */
  private throwIfStopping(instance: WorkflowInstance, what: string): void {
    if (this.isStopping(instance)) {
      throw new Error(`Workflow ${instance.id} is stopping; not starting ${what}`);
    }
  }

  /** Refuses new runs once `shutdownAll()` has begun. */
  private assertAcceptingRuns(action: string): void {
    if (this.shuttingDown) {
      throw new Error(`Cannot ${action}: the workflow orchestrator is shutting down`);
    }
  }

  /**
   * Claims the cross-process locks of a run that is about to start: the
   * workspace lock (an existing directory) first, so a start refused on a busy
   * workspace leaves no run directory behind (claiming the run lock creates
   * it), then the run lock of its fresh id. On a failure nothing stays held.
   * A busy lock surfaces as `WorkflowLockBusyError` (see `run-lock.ts`).
   * Both claims are non-blocking, so the order cannot deadlock against
   * `resume()`, which needs the run lock first to read the workspace.
   */
  private claimRunLocks(workflowId: WorkflowId, workspacePath: string): WorkflowInstance['locks'] {
    const workspace = claimWorkflowWorkspaceLock(
      this.deps.workspaceLockDir ?? getWorkflowWorkspaceLocksDir(),
      workspacePath,
    );
    try {
      const run = claimWorkflowRunLock(this.deps.baseDir, workflowId);
      return { run, workspace };
    } catch (err) {
      this.releaseRunLocks({ workspace });
      throw err;
    }
  }

  private releaseRunLocks(locks: WorkflowInstance['locks']): void {
    const report = (message: string): void => writeStderr(`[workflow] ${message}`);
    releaseWorkflowLock(locks.workspace, report);
    releaseWorkflowLock(locks.run, report);
  }

  /**
   * The single place a run becomes `terminalReady`: its terminal checkpoint is
   * durable and its teardown has finished, so the run and workspace locks are
   * released in the same step and another process may resume it at once.
   */
  private markTerminalReady(instance: WorkflowInstance): void {
    this.clearGateIdleTimer(instance);
    const locks = instance.locks;
    instance.locks = {};
    this.releaseRunLocks(locks);
    instance.terminalReady = true;
  }

  /** Build a partial log entry with shared fields for the given workflow instance. */
  private logBase(instance: WorkflowInstance): { ts: string; workflowId: string; state: string } {
    return {
      ts: new Date().toISOString(),
      workflowId: instance.id,
      state: instance.currentState,
    };
  }

  /** Best-effort durable phase barrier for log consumers such as `workflow watch`. */
  private appendTerminalControl(instance: WorkflowInstance): void {
    const phase = instance.finalStatus?.phase;
    if (!isTerminalWorkflowPhase(phase)) return;
    try {
      instance.messageLog.appendRunTerminal({ ...this.logBase(instance), phase });
    } catch (err) {
      writeStderr(`[workflow] Failed to append terminal log marker for ${instance.id}: ${toErrorMessage(err)}`);
    }
  }

  // -----------------------------------------------------------------------
  // Pre-flight validation
  // -----------------------------------------------------------------------

  /**
   * Validates, before the run starts, every non-"global" persona the
   * definition's agent states use: its persona.json must exist, and its
   * `agentModelId` and `resourceBudget` overrides must be well-formed
   * (`findPersonaOverridesProblem`, the check cron runs make). A malformed
   * override would otherwise be refused only when the state that uses it
   * creates its session (PERSONA_OVERRIDES_INVALID), after the states before
   * it had run and spent budget. Fails fast with one error listing every
   * problem.
   *
   * Does NOT verify the compiled policy (that happens at session creation
   * time via resolvePersona).
   */
  private validatePersonas(definition: WorkflowDefinition): void {
    const missing: string[] = [];
    const statesByPersona = new Map<string, string[]>();
    for (const [stateId, state] of Object.entries(definition.states)) {
      if (state.type !== 'agent') continue;
      const persona = state.persona;
      if (persona === GLOBAL_PERSONA) continue;

      const defPath = getPersonaDefinitionPath(createPersonaName(persona));
      if (!existsSync(defPath)) {
        missing.push(`"${persona}" (used by state "${stateId}")`);
        continue;
      }
      statesByPersona.set(persona, [...(statesByPersona.get(persona) ?? []), stateId]);
    }

    const invalid: string[] = [];
    for (const [persona, stateIds] of statesByPersona) {
      const problem = findPersonaOverridesProblem(persona);
      if (problem !== undefined) {
        invalid.push(`${problem} (used by ${stateIds.map((stateId) => `state "${stateId}"`).join(', ')})`);
      }
    }

    const problems: string[] = [];
    if (missing.length > 0) {
      problems.push(
        `Workflow references personas that do not exist:\n` +
          `  ${missing.join('\n  ')}\n` +
          `Create them with: ironcurtain persona create <name>`,
      );
    }
    if (invalid.length > 0) {
      problems.push(`Workflow references personas with invalid settings:\n  ${invalid.join('\n  ')}`);
    }
    if (problems.length > 0) {
      throw new Error(problems.join('\n'));
    }
  }

  // -----------------------------------------------------------------------
  // Workflow-scoped Docker infrastructure lifecycle
  // -----------------------------------------------------------------------

  /**
   * Determines whether a workflow should run in shared-container mode.
   * Requires both an explicit opt-in via `settings.sharedContainer` and
   * a Docker-backed agent. Builtin workflows ignore the flag entirely.
   * Delegates to the validator's `usesSharedContainer` so the static
   * rules that mirror this decision (fan-out persona homogeneity) can
   * never disagree with the runtime.
   */
  private shouldUseSharedContainer(definition: WorkflowDefinition): boolean {
    return usesSharedContainer(definition.settings);
  }

  /**
   * Returns the bundle for `scope`, minting a new one on first use.
   *
   * Each unique `containerScope` used across the workflow's states gets
   * exactly one bundle: the first agent or containerized deterministic state
   * under a given scope creates the bundle, attaches its coordinator control server,
   * and inserts the result into `instance.bundlesByScope`. Later states
   * with the same scope borrow the existing entry (no factory call).
   *
   * Replaces the pre-Step-6 eager workflow-start mint. Only invoked when
   * `shouldUseSharedContainer(definition)` returns true; callers must
   * gate on that check.
   *
   * On control-server attach failure, the just-created bundle is torn
   * down before the error propagates so we do not leak Docker resources
   * on partial initialization. The map is **not** populated in that case
   * — the scope entry remains absent so a later state can retry.
   *
   * Concurrency: this is an unguarded check-then-act across `await`s, so
   * it is only safe while callers for one scope run serially. Serial
   * XState invocations satisfy that for ordinary states; parallel
   * agent-state fan-out (`runFanOutSegment`, N child actors running
   * concurrently) does NOT, which is why {@link preMintFanOutScopeBundle}
   * mints the segment's bundle once, before any lane starts, so every lane
   * finds the entry already present and borrows it here. The MCP
   * transport supports N lanes sharing one bundle: the Code Mode proxy
   * serves each agent connection with its own MCP server over the shared
   * coordinator (`src/docker/code-mode-proxy.ts`). The lanes still share
   * that coordinator's single active policy, so concurrent lanes with
   * different personas are refused (statically by the validator's
   * `validateFanOutLaneConcurrency`, at runtime by
   * `preMintFanOutScopeBundle`; see
   * docs/designs/workflow-container-lifecycle.md). Any new concurrent
   * caller must follow the pre-mint pattern or add an in-flight-promise
   * guard here.
   *
   * Abort race: if `destroyWorkflowInfrastructure` begins while a mint
   * is suspended at either `await factory(...)` or `await startServer(...)`,
   * the mint completes but must not publish into `bundlesByScope` —
   * destroy already snapshot-cleared the map and would miss the late
   * insertion. The run's stop signal (`instance.stopController`, aborted
   * at the top of `abort()` and when teardown begins) is the barrier,
   * consulted at both `await` points; on observed abort we tear down the
   * just-built bundle and throw without updating the map.
   *
   * Agent slots: before its first mint the run reserves one slot per scope
   * it can mint ({@link reserveBundleSlots}), waiting while the
   * daemon-wide cap is reached; an abort ends the wait. The reservation is
   * returned once the run holds no bundle and no mint is in flight (after
   * teardown, after a failed first mint, after an orphan's cleanup).
   */
  private async ensureBundleForScope(instance: WorkflowInstance, scope: string): Promise<DockerInfrastructure> {
    if (this.isStopping(instance)) {
      throw new Error(`Workflow ${instance.id} is aborting; cannot mint bundle for scope "${scope}"`);
    }
    const existing = instance.bundlesByScope.get(scope);
    if (existing) return existing;

    instance.bundleMintsInFlight += 1;
    try {
      return await this.mintBundleForScope(instance, scope);
    } finally {
      instance.bundleMintsInFlight -= 1;
      this.releaseBundleSlotsIfIdle(instance);
    }
  }

  /**
   * The snapshot a scope's bundle may start from on resume. One that records
   * no agent image build (committed before snapshots carried one) is never
   * offered: its in-container entrypoint scripts and agent CLI could be from
   * any build. The bundle refuses the rest unless its own resolved build
   * matches (`selectResumableSnapshot` in docker-infrastructure.ts).
   */
  private snapshotToResume(instance: WorkflowInstance, scope: string): ContainerSnapshotRef | undefined {
    const snapshot = instance.containerSnapshots?.[scope];
    if (snapshot === undefined) return undefined;
    if (typeof snapshot.agentBuildHash !== 'string') {
      this.reportSnapshotNotResumed(
        instance,
        scope,
        snapshot,
        'the snapshot does not record the agent image build it was taken from',
      );
      return undefined;
    }
    return snapshot;
  }

  private reportSnapshotNotResumed(
    instance: WorkflowInstance,
    scope: string,
    snapshot: ContainerSnapshotRef,
    reason: string,
  ): void {
    const takenBy =
      typeof snapshot.ironcurtainVersion === 'string'
        ? ` (snapshot taken by IronCurtain ${toDisplayText(snapshot.ironcurtainVersion, { maxLength: 64 })})`
        : '';
    writeStderr(
      `[workflow] ${instance.id} scope "${scope}" starts from a fresh container instead of its snapshot: ` +
        `${toDisplayText(reason, { maxLength: 300 })}${takenBy}. Its workspace is unchanged; ` +
        'anything else installed in the old container must be set up again.',
    );
  }

  /** The body of {@link ensureBundleForScope} once it knows it must mint. */
  private async mintBundleForScope(instance: WorkflowInstance, scope: string): Promise<DockerInfrastructure> {
    // The scope's one container is built from one harness image: the harness
    // its agent states share, or the workflow default for a scope that only
    // runs deterministic states. Validation rejects a scope that mixes
    // harnesses; `resolveScopeDockerAgent` throws for one that bypassed it,
    // before an agent slot is reserved or anything is minted, rather than
    // build a container some of the scope's states would run in on the wrong
    // agent. Every agent state, container deterministic state and fan-out
    // pre-mint reaches a scope's bundle through here, so this is the one
    // runtime check.
    const agentId = toAgentId(resolveScopeDockerAgent(instance.definition, scope));

    await this.reserveBundleSlots(instance);
    // Abort may have landed while the reservation waited for a slot.
    if (this.isStopping(instance)) {
      throw new Error(`Workflow ${instance.id} was aborted while waiting for an agent slot for scope "${scope}"`);
    }

    // Mint a fresh UUID per scope: each bundle needs its own on-disk
    // directory tree, coordinator control socket, and Docker container
    // name. Unlike single-session CLI (`bundleId === sessionId`),
    // workflow scopes produce genuine standalone `BundleId`s.
    const bundleId = createBundleId();
    // Exchanges this bundle's MITM cannot tie to an invocation lease carry
    // only the bundle id; register it before the bundle can carry traffic.
    instance.usage.addBundle(bundleId);
    const controlSocketPath = getBundleControlSocketPath(bundleId);
    // Ensure the per-bundle runtime root exists BEFORE the coordinator
    // tries to bind its UDS there. Routes through `ensureSecureBundleDir`
    // so the same symlink-rejection + 0o700-enforcement hardening that
    // guards `sockets/` and `host/` (in `prepareDockerInfrastructure`)
    // also guards the root the coordinator's `ctrl.sock` binds into.
    ensureSecureBundleDir(getBundleRuntimeRoot(bundleId));

    const requiredServers = this.getRequiredServersForScope(instance, scope);
    this.reportUnavailableMemory(instance, scope);
    // A read-only scope's writable output directories must be real
    // directories below the workspace before its coordinator exists.
    const readOnlyWorkspace = readOnlyWorkspaceForScope(instance.definition, scope);
    if (readOnlyWorkspace) this.prepareReadOnlyOutputs(instance, readOnlyWorkspace);
    // Persona-less initial set; per-state restaging fills in persona skills later.
    // Reads the cached per-run staged path (set at start / resume) so
    // the bundle never depends on the original package directory still
    // being on disk.
    for (const kind of ['skills', 'scripts'] as const) {
      const path = kind === 'skills' ? instance.workflowSkillsDir : instance.workflowScriptsDir;
      if (
        path !== undefined &&
        validatedWorkflowStagedDirectory(this.runDirOf(instance.id), path, kind) === undefined
      ) {
        throw new WorkflowResumeError('WORKFLOW_NOT_RESUMABLE', `Invalid workflow-${kind} staging directory`);
      }
    }
    const resolvedSkills = resolveSkillsForSession({ workflowSkillsDir: instance.workflowSkillsDir });
    const factory = this.deps.createWorkflowInfrastructure ?? (await this.loadDefaultInfrastructureFactory());
    const snapshot = this.snapshotToResume(instance, scope);
    // The bundle's coordinator offers workflow_commit to every state that
    // borrows the bundle; this channel receives those commits.
    const commitChannel = new WorkflowCommitChannel();
    const infra = await factory({
      workflowId: instance.id,
      workflowRunDir: this.runDirOf(instance.id),
      bundleId,
      agentId,
      controlSocketPath,
      workspacePath: instance.workspacePath,
      scope,
      requiredServers,
      maxLanes: maxLanesForScope(instance.definition, scope),
      ...(instance.taskPolicyDir !== undefined ? { taskPolicyDir: instance.taskPolicyDir } : {}),
      resolvedSkills,
      workflowScriptsDir: instance.workflowScriptsDir,
      ...(snapshot === undefined
        ? {}
        : {
            baseImageOverride: snapshot.image,
            baseImageAgentBuildHash: snapshot.agentBuildHash,
            ...(snapshot.agentSudo === undefined ? {} : { baseImageAgentSudo: snapshot.agentSudo }),
          }),
      // Escalated tool calls inside this bundle wait on the workflow's
      // human route instead of being denied for lack of a handler.
      onEscalation: (request, reason, context, whitelistCandidates, details) =>
        this.handleCoordinatorEscalation(instance, bundleId, request, reason, context, whitelistCandidates, details),
      resourceBudget: instance.resourceBudget.limits,
      // A resumed run's taint (taint escalation enabled) lives in the audit
      // logs of the bundles its earlier legs minted.
      taintReplayAuditLogPaths: instance.priorBundleAuditLogPaths ?? [],
      workflowCommit: commitChannel,
      ...(readOnlyWorkspace ? { readOnlyWorkspace } : {}),
    });

    // Abort may have landed while `factory()` was suspended. Publishing
    // into `bundlesByScope` now would leak past the destroy's leak
    // assertion; destroy the orphan inline and throw.
    if (this.isStopping(instance)) {
      const destroy = this.deps.destroyWorkflowInfrastructure ?? (await this.loadDefaultInfrastructureTeardown());
      await destroy(infra)
        .then((result) => {
          const notice = teardownPrivilegedFiles(result);
          if (notice) this.recordHostPrivilegedFiles(instance, notice);
        })
        .catch((teardownErr: unknown) => {
          writeStderr(
            `[workflow] destroyDockerInfrastructure during abort recovery for ${instance.id} (bundle ${bundleId}): ${toErrorMessage(teardownErr)}`,
          );
        });
      throw new Error(`Workflow ${instance.id} was aborted during bundle mint for scope "${scope}"`);
    }

    // Attach the control server. On failure, tear down the bundle so
    // we don't leak containers/proxies; the error propagates so the
    // caller (executeAgentState) can fail the state invoke.
    try {
      const startServer = this.deps.startWorkflowControlServer ?? defaultStartWorkflowControlServer;
      await startServer({ infra, socketPath: controlSocketPath });
    } catch (err) {
      const destroy = this.deps.destroyWorkflowInfrastructure ?? (await this.loadDefaultInfrastructureTeardown());
      await destroy(infra)
        .then((result) => {
          const notice = teardownPrivilegedFiles(result);
          if (notice) this.recordHostPrivilegedFiles(instance, notice);
        })
        .catch((teardownErr: unknown) => {
          writeStderr(
            `[workflow] destroyDockerInfrastructure during control-server recovery for ${instance.id}: ${toErrorMessage(teardownErr)}`,
          );
        });
      throw err;
    }

    // Abort check #2: abort may have landed while `startServer()` was
    // suspended. Publishing into `bundlesByScope` now would leak past
    // the destroy's leak assertion; tear down the just-built bundle
    // and throw.
    if (this.isStopping(instance)) {
      const destroy = this.deps.destroyWorkflowInfrastructure ?? (await this.loadDefaultInfrastructureTeardown());
      await destroy(infra)
        .then((result) => {
          const notice = teardownPrivilegedFiles(result);
          if (notice) this.recordHostPrivilegedFiles(instance, notice);
        })
        .catch((teardownErr: unknown) => {
          writeStderr(
            `[workflow] destroyDockerInfrastructure during abort recovery (post-startServer) for ${instance.id} (bundle ${bundleId}): ${toErrorMessage(teardownErr)}`,
          );
        });
      throw new Error(`Workflow ${instance.id} was aborted during control-server attach for scope "${scope}"`);
    }

    instance.bundlesByScope.set(scope, infra);
    // The run's usage counts at least what the bundle's budget gate charges
    // for every completion its MITM forwards, attributed or not, priced or
    // not, statistics on or off (see workflow-usage.ts); the meter keeps
    // reading the gate after the bundle is gone.
    if (infra.budgetGate !== undefined) instance.usage.trackBundleGate(bundleId, infra.budgetGate);
    instance.mintedServersByBundle.set(bundleId, requiredServers);
    instance.commitChannelsByBundle.set(bundleId, commitChannel);
    if (snapshot !== undefined && infra.snapshotRefusal !== undefined) {
      this.reportSnapshotNotResumed(instance, scope, snapshot, infra.snapshotRefusal);
    }
    return infra;
  }

  /**
   * Resolves once this run holds its agent slots for shared-container
   * bundles, waiting in the daemon-wide queue while the cap is reached.
   *
   * The run asks for one slot per scope it can mint, all in ONE request,
   * before its first mint, and keeps them until its last bundle is gone. It
   * never waits for slots while holding some, so runs queued behind each
   * other cannot deadlock (two runs each holding one scope and waiting for
   * a second could). A run that needs more slots than the whole cap is
   * refused at once with `AgentSlotRequestError` (`start()` and `resume()`
   * refuse it up front). Concurrent mints of one run share the one request. An aborted
   * or refused request holds nothing and is forgotten, so a later mint asks
   * again.
   */
  private reserveBundleSlots(instance: WorkflowInstance): Promise<AgentSlotLease> {
    if (instance.bundleSlots !== undefined) return instance.bundleSlots;
    this.assertAgentSlotDemandFits(instance.definition);
    const slots = workflowBundleScopes(instance.definition).size;
    const reservation = this.agentSlots.acquire(slots, {
      signal: instance.stopController.signal,
      onWait: (usage) =>
        this.reportAgentSlotWait(instance, `Shared container (${slots} slot${slots === 1 ? '' : 's'})`, usage),
    });
    instance.bundleSlots = reservation;
    void reservation.catch(() => {
      if (instance.bundleSlots === reservation) instance.bundleSlots = undefined;
    });
    return reservation;
  }

  /**
   * Returns the run's bundle slots once it holds no bundle and no mint is
   * in flight: after teardown, after a first mint that failed, and after an
   * in-flight mint that raced a teardown has destroyed its orphan.
   */
  private releaseBundleSlotsIfIdle(instance: WorkflowInstance): void {
    if (instance.bundleMintsInFlight > 0 || instance.bundlesByScope.size > 0) return;
    const reservation = instance.bundleSlots;
    if (reservation === undefined) return;
    instance.bundleSlots = undefined;
    void reservation.then(
      (lease) => lease.release(),
      () => undefined,
    );
  }

  /**
   * Takes the agent slot for one agent session that brings its own
   * environment (no shared bundle), waiting while the cap is reached. The
   * wait ends when the run stops or, for a fan-out lane, when the batch
   * drains the lane.
   */
  private async acquireSessionSlot(
    instance: WorkflowInstance,
    stateId: string,
    signal: AbortSignal | undefined,
  ): Promise<AgentSlotLease> {
    try {
      return await this.agentSlots.acquire(1, {
        signal: signal ? AbortSignal.any([instance.stopController.signal, signal]) : instance.stopController.signal,
        onWait: (usage) => this.reportAgentSlotWait(instance, `Agent "${stateId}"`, usage),
      });
    } catch (err) {
      throw new Error(`Agent state "${stateId}" stopped while waiting for an agent slot: ${toErrorMessage(err)}`, {
        cause: err,
      });
    }
  }

  /** Tells the run's tab and stderr that it is queued on the agent concurrency cap. */
  private reportAgentSlotWait(instance: WorkflowInstance, what: string, usage: AgentSlotUsage): void {
    const message =
      `${what} is waiting for a free agent slot: ${usage.inUse} of ${usage.capacity} in use, ` +
      `${usage.waiting} waiting (maxConcurrentAgentSessions)`;
    writeStderr(`[workflow] ${instance.id}: ${message}`);
    instance.tab.write(`[agent] ${message}`);
  }

  /**
   * Refuses, before anything is created, a shared-container definition that
   * needs more agent slots than the cap allows: its slot reservation could
   * never be served. Other definitions take one slot per session and always
   * fit.
   */
  private assertAgentSlotDemandFits(definition: WorkflowDefinition): void {
    if (!this.shouldUseSharedContainer(definition)) return;
    const slots = workflowBundleScopes(definition).size;
    if (slots > this.agentSlots.capacity) {
      throw new AgentSlotRequestError(
        slots,
        this.agentSlots.capacity,
        `Workflow "${definition.name}" (one per shared container scope)`,
      );
    }
  }

  /**
   * Returns the cached policyDir for `persona`, canonicalizing on first
   * lookup so required-server derivation and the coordinator's
   * `loadPolicy` RPC operate on the same realpath-resolved file (any
   * symlink under the persona dir is collapsed once, here, instead of
   * re-resolved by every reader).
   */
  private getPolicyDir(instance: WorkflowInstance, persona: string): string {
    const cached = instance.policyDirByPersona.get(persona);
    if (cached !== undefined) return cached;
    const dir = validatePolicyDir(resolvePersonaPolicyDir(persona));
    instance.policyDirByPersona.set(persona, dir);
    return dir;
  }

  /** The distinct personas of the agent states that run in `scope`, in definition order. */
  private getPersonasForScope(instance: WorkflowInstance, scope: string): string[] {
    const personas = new Set<string>();
    for (const stateConfig of Object.values(instance.definition.states)) {
      if (stateConfig.type !== 'agent') continue;
      if ((stateConfig.containerScope ?? DEFAULT_CONTAINER_SCOPE) !== scope) continue;
      personas.add(stateConfig.persona);
    }
    return [...personas];
  }

  /**
   * Computes the union of MCP server names required by every agent state
   * sharing `scope`. Threaded into the workflow infrastructure factory so
   * the bundle only spawns proxies the policies actually reference.
   *
   * Never adds the memory server, even for personas with memory
   * enabled. Memory is not in compiled policies; a standalone session adds
   * it to its own config, with that persona's database. A shared-container
   * bundle has one coordinator for every persona in the scope, and the
   * memory server is trusted (it bypasses policy), so one bundle-wide memory
   * server would let every persona read and write a single persona's
   * database. Until bundles can run one isolated backend per persona, they
   * run none: the default factory refuses it (`withoutMemoryServer`), and
   * borrowing sessions keep the memory gate closed so no prompt advertises
   * it. See docs/designs/per-persona-memory-optin.md §1.2.
   */
  private getRequiredServersForScope(instance: WorkflowInstance, scope: string): ReadonlySet<string> {
    const union = new Set<string>();
    for (const persona of this.getPersonasForScope(instance, scope)) {
      const { compiledPolicy } = loadPersonaPolicyArtifacts(this.getPolicyDir(instance, persona));
      for (const server of extractRequiredServers(compiledPolicy)) {
        union.add(server);
      }
    }
    // A read-only scope's agents write their outputs through the filesystem
    // server: their own tools cannot write the read-only workspace mount.
    if (readOnlyWorkspaceForScope(instance.definition, scope)) union.add(READ_ONLY_OUTPUT_SERVER);
    return union;
  }

  /**
   * Makes the writable output directories of a read-only state or scope real
   * directories below the workspace (see `prepareWritableOutputDirs`) and
   * reports every agent-planted entry it had to move aside.
   */
  private prepareReadOnlyOutputs(instance: WorkflowInstance, readOnlyWorkspace: ReadOnlyWorkspace): void {
    for (const warning of prepareWritableOutputDirs(instance.workspacePath, readOnlyWorkspace.writablePaths)) {
      writeStderr(`[workflow] Warning: ${warning}`);
      instance.tab.write(`[warning] ${warning}`);
    }
  }

  /**
   * The notices of an agent state's session the run shows (its sessions'
   * `onDiagnostic`): a stale compiled policy on stderr, where session start
   * wrote it before sessions reported it as a notice, and host-mount findings
   * (see {@link recordHostPrivilegedFiles}). Other diagnostics are not shown.
   */
  private reportSessionNotice(instance: WorkflowInstance, event: DiagnosticEvent): void {
    if (event.kind === 'policy_stale') {
      writeStderr(`[workflow] ${formatSessionNotice(event).trimStart()}`);
    } else if (event.kind === 'host_privileged_files') {
      this.recordHostPrivilegedFiles(instance, event);
    }
  }

  /**
   * Setuid/setgid or root-owned files an agent left in its container's host
   * mounts (after a turn, or what a bundle's teardown found left behind):
   * on stderr, in the workflow tab and in the message log, where they stay
   * with the run (a warning entry; it does not mark the run failed).
   */
  private recordHostPrivilegedFiles(instance: WorkflowInstance, event: HostPrivilegedFilesDiagnostic): void {
    const notice = formatSessionNotice(event).trimStart();
    writeStderr(`[workflow] ${notice}`);
    instance.tab.write(notice);
    try {
      instance.messageLog.append({
        ...this.logBase(instance),
        type: 'error',
        error: notice,
        context: HOST_MOUNT_SCAN_ERROR_CONTEXT,
      });
    } catch (err) {
      writeStderr(`[workflow] Failed to record a host-mount finding for ${instance.id}: ${toErrorMessage(err)}`);
    }
  }

  /**
   * Tells the user, once per minted bundle, which personas in `scope` have
   * memory enabled but will run without it, because shared-container
   * bundles start no memory server (see {@link getRequiredServersForScope}).
   * The sessions themselves stay consistent on their own: borrowing a
   * bundle closes their memory gate, so neither the persona prompt nor
   * CLAUDE.md mentions the missing tool. This notice only explains why.
   *
   * `GLOBAL_PERSONA` is skipped: it is the no-persona sentinel (the session
   * factory runs those states without a persona), so they never have memory
   * in any mode, even if a persona directory of that name exists.
   */
  private reportUnavailableMemory(instance: WorkflowInstance, scope: string): void {
    const personas = this.getPersonasForScope(instance, scope).filter(
      (persona) => persona !== GLOBAL_PERSONA && isMemoryEnabledForPersonaName(persona, this.deps.userConfig),
    );
    if (personas.length === 0) return;
    const message =
      `memory is enabled for persona(s) ${personas.join(', ')}, but shared-container workflows do not run ` +
      `the memory server: their states in scope "${scope}" run without memory`;
    writeStderr(`[workflow] ${message}`);
    instance.tab.write(`[memory] ${message}`);
  }

  /**
   * Reloads the coordinator's policy for the given persona on the given
   * bundle. Called once per agent state invocation (including re-entries)
   * in shared-container mode. The coordinator stamps `persona` onto every
   * subsequent audit entry, so consumers can reconstruct per-persona /
   * per-re-entry slices from the bundle's `audit.jsonl` file.
   *
   * Each scope owns its own bundle, coordinator, and control socket, so
   * the bundle is passed explicitly — cycle the scope the state is
   * about to enter, not some other scope's bundle.
   *
   * The swap is bundle-wide: the coordinator holds ONE active policy for
   * every session borrowing the bundle. That is only correct while
   * states run one at a time. Concurrent fan-out lanes therefore must
   * share a persona, and `preMintFanOutScopeBundle` installs it here
   * once before the lanes start so each lane's own call hits the
   * short-circuit below instead of racing a `loadPolicy` RPC. A swap
   * also waits for every live agent invocation of another persona on
   * the bundle to end ({@link waitForOtherPersonaTurns}): a drained
   * lane's in-flight turn outlives its batch and would otherwise run
   * the rest of its turn under the next state's policy.
   *
   * On failure (control socket unreachable, coordinator reports a load
   * error) this throws — the workflow must not proceed under the
   * previous persona's policy.
   */
  private async cyclePolicy(instance: WorkflowInstance, persona: string, bundle: DockerInfrastructure): Promise<void> {
    // Skip the RPC when the bundle's coordinator already has this
    // persona loaded. Consecutive states on the same scope+persona
    // would otherwise re-send an identical `loadPolicy` — a no-op on
    // the coordinator that still costs a UDS round-trip and a policy
    // engine rebuild.
    if (instance.currentPersonaByBundle.get(bundle.bundleId) === persona) return;

    await this.waitForOtherPersonaTurns(instance, bundle, persona);
    if (instance.currentPersonaByBundle.get(bundle.bundleId) === persona) return;

    const policyDir = this.getPolicyDir(instance, persona);

    // Guard against mid-workflow recompiles that add a server: the bundle
    // was minted with a fixed required-server set, so a new policy that
    // expands the set would have the coordinator allow tools no relay was
    // spawned for. Fail fast with a clear error instead.
    const minted = instance.mintedServersByBundle.get(bundle.bundleId);
    if (minted) {
      const { compiledPolicy } = loadPersonaPolicyArtifacts(policyDir);
      const newServers = extractRequiredServers(compiledPolicy);
      const added: string[] = [];
      for (const s of newServers) if (!minted.has(s)) added.push(s);
      if (added.length > 0) {
        throw new Error(
          `Persona "${persona}" requires server(s) [${added.join(', ')}] that were not spawned for this scope ` +
            `(bundle minted with [${[...minted].sort().join(', ')}]). ` +
            `A persona recompile that expands the server set requires restarting the workflow.`,
        );
      }
    }
    // Target this bundle's coordinator. Under bifurcated workflows every
    // bundle has its own socket, so the bundle argument fully determines
    // the route.
    const socketPath = getBundleControlSocketPath(bundle.bundleId);

    // Invalidate the cache entry BEFORE the RPC. If `loadPolicy` fails
    // after the coordinator already applied the new policy (e.g., the
    // RPC times out during the response), leaving the cache pointed at
    // the previous persona would silently skip the next cycle and run
    // a subsequent state under the wrong policy. Clear-then-rewrite
    // ensures the cache is never stale relative to the coordinator's
    // actual state — at worst we re-send an identical `loadPolicy`.
    instance.currentPersonaByBundle.delete(bundle.bundleId);

    const loadPolicy = this.deps.loadPolicyRpc ?? defaultLoadPolicyRpc;
    await loadPolicy({
      socketPath,
      persona,
      policyDir,
      timeoutMs: LOAD_POLICY_RPC_TIMEOUT_MS,
    });
    instance.currentPersonaByBundle.set(bundle.bundleId, persona);
  }

  /**
   * Marks an agent invocation as live on `bundleId` under `persona` (see
   * {@link WorkflowInstance.liveAgentTurnsByBundle}). Returns the release
   * function, which is idempotent; the caller runs it once the invocation
   * has finished and its session is closed.
   */
  private registerLiveAgentTurn(instance: WorkflowInstance, bundleId: string, persona: string): () => void {
    let settle: () => void = () => {};
    const turn: LiveAgentTurn = {
      persona,
      ended: new Promise<void>((resolveEnded) => {
        settle = resolveEnded;
      }),
    };
    const turns = instance.liveAgentTurnsByBundle.get(bundleId) ?? new Set<LiveAgentTurn>();
    instance.liveAgentTurnsByBundle.set(bundleId, turns);
    turns.add(turn);
    return () => {
      if (!turns.delete(turn)) return;
      if (turns.size === 0 && instance.liveAgentTurnsByBundle.get(bundleId) === turns) {
        instance.liveAgentTurnsByBundle.delete(bundleId);
      }
      settle();
    };
  }

  /**
   * Waits until no agent invocation of a persona other than `persona` is live
   * on `bundle`, so swapping the coordinator's single policy never changes
   * the rules under a turn that is still calling tools. Serial states never
   * overlap, so in practice this only waits for a drained fan-out lane whose
   * in-flight turn is still running when the run reaches a state of another
   * persona. The wait is unbounded by design (failing open would evaluate
   * that turn's calls under the wrong policy); aborting the workflow ends it
   * (the run's stop signal releases the wait, which then throws, and the
   * container teardown ends the turn).
   */
  private async waitForOtherPersonaTurns(
    instance: WorkflowInstance,
    bundle: DockerInfrastructure,
    persona: string,
  ): Promise<void> {
    let reported = false;
    for (;;) {
      this.throwIfStopping(instance, `a policy swap to persona "${persona}"`);
      const others = [...(instance.liveAgentTurnsByBundle.get(bundle.bundleId) ?? [])].filter(
        (turn) => turn.persona !== persona,
      );
      if (others.length === 0) return;
      if (!reported) {
        reported = true;
        const personas = [...new Set(others.map((turn) => turn.persona))].sort().join(', ');
        const message =
          `waiting for ${others.length} in-flight agent turn(s) of persona ${personas} to finish before loading ` +
          `persona "${persona}" onto the shared coordinator`;
        writeStderr(`[workflow] ${message}`);
        instance.tab.write(`[policy] ${message}`);
      }
      await this.untilSettledOrStopping(
        instance,
        others.map((turn) => turn.ended),
      );
    }
  }

  /**
   * Waits for `promises` to settle, or for the run to begin stopping,
   * whichever comes first. The abort listener is removed again, so a long run
   * that waits often does not accumulate listeners on its signal.
   */
  private async untilSettledOrStopping(
    instance: WorkflowInstance,
    promises: readonly Promise<unknown>[],
  ): Promise<void> {
    const signal = instance.stopController.signal;
    if (signal.aborted) return;
    let onAbort: () => void = () => {};
    const stopping = new Promise<void>((resolveStopping) => {
      onAbort = resolveStopping;
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([Promise.allSettled(promises), stopping]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Tears down every bundle this workflow owns. Walks
   * `instance.bundlesByScope.values()` in parallel via `Promise.allSettled`
   * so failures in one bundle's teardown do not block the others. The
   * map is drained before the awaits so a second concurrent caller (e.g.
   * `shutdownAll` racing the fire-and-forget destroy in
   * `handleWorkflowComplete`) sees an empty map and returns without
   * re-entering `destroy`.
   *
   * Callers in recovery paths rely on **expected** failure modes being
   * swallowed so abort/shutdown flows can complete:
   *   - Failures in `destroy(infra)` are logged to stderr and swallowed.
   *   - Failures in socket unlinks are logged and swallowed.
   *
   * **One exception — intentional throw on internal invariant violation.**
   * After teardown the helper asserts `bundlesByScope.size === 0`. A
   * non-empty map at that point is a bug: something added an entry back
   * while teardown was in flight. The invariant is enforced by the
   * abort-guard in `ensureBundleForScope` (post-`factory` flag check);
   * reaching this throw means the guard has a hole and we want it to
   * surface loudly rather than silently strand a bundle. Callers are
   * `abort()`, `shutdownAll()`, and the fire-and-forget `.catch()` in
   * `handleWorkflowComplete` — in the expected invariant-holds case
   * none of them see an exception. A thrown leak assertion in
   * `abort()` / `shutdownAll()` will propagate to their own caller (the
   * test or CLI layer), which is the intended signal.
   */
  private destroyWorkflowInfrastructure(instance: WorkflowInstance): Promise<void> {
    // Signal BEFORE any short-circuit: an in-flight `ensureBundleForScope`
    // that resumes from its `await factory(...)` must observe the stop and
    // tear down its own orphan rather than publishing into the map. Every
    // stop path passes here, so any leftover work stops as well: a host
    // deterministic command still running (a drained lane's, a replayed
    // state's) is killed and no new one starts, and a drained lane's
    // in-flight turn stops at its next check.
    instance.stopController.abort();

    // Join semantics: the first caller starts the teardown; concurrent
    // and later callers await the SAME promise. This is what lets the
    // CLI's shutdownAll() block until the fire-and-forget destroy from
    // handleWorkflowComplete has actually finished, instead of bailing
    // on the already-cleared map and letting process.exit() kill the
    // teardown mid-flight (leaking the container, its network, and the
    // MCP relay subprocesses).
    instance.teardownPromise ??= this.runBundleTeardown(instance);
    return instance.teardownPromise;
  }

  /** Body of the bundle teardown; only ever started once per instance. */
  private async runBundleTeardown(instance: WorkflowInstance): Promise<void> {
    try {
      await this.destroyAllBundles(instance);
    } finally {
      // The run's agent slots go back once its containers are gone. A mint
      // still in flight keeps them until it has cleaned up its orphan (it
      // releases them itself when it finishes).
      this.releaseBundleSlotsIfIdle(instance);
    }
  }

  /** Destroys every bundle in `instance.bundlesByScope` (see {@link destroyWorkflowInfrastructure}). */
  private async destroyAllBundles(instance: WorkflowInstance): Promise<void> {
    if (instance.bundlesByScope.size === 0) return;

    // Snapshot and clear BEFORE the awaits so a concurrent caller sees
    // an empty map and bails out. See JSDoc for the rationale.
    const bundles = [...instance.bundlesByScope.values()];
    instance.bundlesByScope.clear();
    // No state can commit through a bundle that is going away.
    instance.commitChannelsByBundle.clear();

    const destroy = this.deps.destroyWorkflowInfrastructure ?? (await this.loadDefaultInfrastructureTeardown());

    await Promise.allSettled(
      bundles.map(async (infra) => {
        try {
          // What the final host-mount scan found left behind in the bundle's
          // agent-writable mounts, after its container was removed.
          const privilegedFiles = teardownPrivilegedFiles(await destroy(infra));
          if (privilegedFiles !== undefined) this.recordHostPrivilegedFiles(instance, privilegedFiles);
        } catch (err) {
          writeStderr(
            `[workflow] destroyDockerInfrastructure failed for ${instance.id} (bundle ${infra.bundleId}): ${toErrorMessage(err)}`,
          );
        }

        // Best-effort: unlink the coordinator control socket. Swallow
        // ENOENT because the socket may never have been bound (e.g.,
        // when destroy runs after a failure before control-server attach).
        try {
          unlinkSync(getBundleControlSocketPath(infra.bundleId));
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            writeStderr(
              `[workflow] Failed to unlink control socket for ${instance.id} (bundle ${infra.bundleId}): ${toErrorMessage(err)}`,
            );
          }
        }
      }),
    );

    // Leak assertion: after snapshot-and-clear + parallel destroy, the
    // map MUST be empty. A non-empty map means a destroy path silently
    // added an entry back after teardown began — a real bug we surface
    // as a synchronous error so it cannot be swallowed.
    if (instance.bundlesByScope.size !== 0) {
      const leaked = [...instance.bundlesByScope.keys()];
      throw new Error(`Leaked workflow bundle scopes after teardown: ${JSON.stringify(leaked)}`);
    }
  }

  private shouldSnapshotOnStop(instance: WorkflowInstance): boolean {
    if (!this.shouldUseSharedContainer(instance.definition)) return false;
    if (instance.definition.settings?.snapshotOnStop !== true) return false;
    return this.deps.userConfig.snapshot.enabled;
  }

  /**
   * Commits the `snapshotOnStop` snapshot of every live scope, one at a time.
   * With `budgetMs` (a caller that must exit by a deadline), each commit's
   * timeout is what is left of the budget and the scopes it no longer covers
   * stop without a snapshot, so a signal-driven shutdown is never force-exited
   * in the middle of a commit. Commits of all workflows in this process are
   * also serialized, and each is skipped (logged, resume starts fresh) when the
   * container exceeds `snapshot.maxBytes` or the disk lacks room for it; see
   * `commitContainerSnapshot`.
   *
   * A scope with no live bundle at this stop (not reached since the run was
   * resumed, or a mint that the abort undid) still holds exactly the state of
   * the snapshot it was resumed from, so that snapshot is carried forward
   * instead of being dropped (and then removed as superseded).
   */
  private async snapshotResumableScopes(
    instance: WorkflowInstance,
    budgetMs?: number,
  ): Promise<Readonly<Record<string, ContainerSnapshotRef>> | undefined> {
    if (!this.shouldSnapshotOnStop(instance)) return undefined;
    const entries = [...instance.bundlesByScope.entries()];
    const snapshots: Record<string, ContainerSnapshotRef> = {};
    for (const [scope, snapshot] of Object.entries(instance.containerSnapshots ?? {})) {
      if (!instance.bundlesByScope.has(scope)) snapshots[scope] = snapshot;
    }

    const deadline = budgetMs === undefined ? undefined : Date.now() + Math.max(0, budgetMs);
    for (const [scope, infra] of entries) {
      // Container snapshots require image commit/management APIs. Key off the
      // runtime capability so new runtimes do not need orchestrator changes.
      if (!infra.docker.supportsImageSnapshots) {
        writeStderr(
          `[workflow] Container snapshots are not supported on the "${infra.runtimeKind}" runtime; ` +
            `stopping ${instance.id} scope "${scope}" without a snapshot.`,
        );
        continue;
      }
      const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
      if (remainingMs !== undefined && remainingMs < MIN_SNAPSHOT_COMMIT_MS) {
        writeStderr(
          `[workflow] The shutdown deadline leaves no time to snapshot ${instance.id} scope "${scope}"; ` +
            'stopping it without a snapshot (resume starts it fresh).',
        );
        continue;
      }
      // Resume uses a snapshot only under the agent image build it was taken
      // from, so one whose build is unknown could never be used.
      const agentBuildHash = infra.imageResolution?.buildHash;
      if (agentBuildHash === undefined) {
        writeStderr(
          `[workflow] The agent image build of ${instance.id} scope "${scope}" is unknown; ` +
            'stopping it without a snapshot (resume starts it fresh).',
        );
        continue;
      }
      try {
        snapshots[scope] = await commitContainerSnapshot({
          docker: infra.docker,
          workflowId: instance.id,
          scope,
          containerId: infra.containerId,
          baseDir: this.deps.baseDir,
          agentBuildHash,
          // Resume under agentSudo: false uses only a snapshot recorded as sudo-off.
          ...(infra.agentSudo === undefined ? {} : { agentSudo: infra.agentSudo }),
          maxBytes: this.deps.userConfig.snapshot.maxBytes,
          ...(remainingMs !== undefined ? { timeoutMs: remainingMs } : {}),
        });
      } catch (err) {
        if (isContainerSnapshotSkippedError(err)) {
          writeStderr(
            `[workflow] Skipping the container snapshot of ${instance.id} scope "${scope}": ${err.message}; ` +
              'resume starts it fresh.',
          );
        } else {
          writeStderr(
            `[workflow] Failed to snapshot container for ${instance.id} scope "${scope}": ${toErrorMessage(err)}`,
          );
        }
      }
    }
    return Object.keys(snapshots).length > 0 ? snapshots : undefined;
  }

  private async dockerForSnapshotCleanup(instance: WorkflowInstance): Promise<ContainerRuntime | undefined> {
    for (const infra of instance.bundlesByScope.values()) {
      if (infra.docker.supportsImageSnapshots) {
        return infra.docker;
      }
    }
    if (!commandExists('docker')) return undefined;
    const { createDockerManager } = await import('../docker/docker-manager.js');
    return createDockerManager();
  }

  /**
   * Removes snapshot images the run's checkpoint no longer references. Only
   * images labeled as this run's own snapshots are touched (see
   * `removeContainerSnapshotImages`): a reference can name any image.
   */
  private async removeSnapshotImagesAfterTeardown(
    instance: WorkflowInstance,
    docker: ContainerRuntime,
    snapshots: Readonly<Record<string, ContainerSnapshotRef>> | undefined,
  ): Promise<void> {
    if (!snapshots || Object.keys(snapshots).length === 0) return;
    await removeContainerSnapshotImages(docker, snapshots, {
      workflowId: instance.id,
      baseDir: this.deps.baseDir,
    }).catch((err: unknown) => {
      writeStderr(`[workflow] Failed to remove container snapshot image(s): ${toErrorMessage(err)}`);
    });
  }

  /**
   * Builds and persists the terminal checkpoint, preserving the prior on-disk
   * machineState/context (which point at the last non-terminal save point) so
   * resume re-enters that state instead of the terminal snapshot. Shared by the
   * abort() and handleWorkflowComplete() stop paths.
   *
   * Returns whether the checkpoint was saved. Only then do `containerSnapshots`
   * become the run's restore snapshots and may the ones they replace be
   * removed: after a failed save the checkpoint on disk still references the
   * old images (the new ones are left to the orphan sweep).
   */
  private saveTerminalCheckpoint(
    instance: WorkflowInstance,
    finalStatus: WorkflowStatus,
    containerSnapshots: Readonly<Record<string, ContainerSnapshotRef>> | undefined,
    existing: WorkflowCheckpoint | undefined,
    usageSettlementPending = false,
  ): boolean {
    try {
      const terminalCheckpoint = this.buildCheckpoint(
        instance,
        instance.actor.getSnapshot() as { value: unknown; context: unknown },
        finalStatus,
        containerSnapshots,
      );
      const checkpoint = existing
        ? { ...terminalCheckpoint, machineState: existing.machineState, context: existing.context }
        : terminalCheckpoint;
      this.deps.checkpointStore.save(
        instance.id,
        usageSettlementPending ? { ...checkpoint, usageSettlementPending: true } : checkpoint,
      );
    } catch (err) {
      this.reportCheckpointSaveFailure(instance, 'terminal checkpoint', err);
      return false;
    }
    instance.containerSnapshots = containerSnapshots;
    this.reportCheckpointSaveRecovered(instance);
    return true;
  }

  /**
   * The snapshots a stop supersedes: those that both the checkpoint on disk
   * (`previous`) and this leg's restore set (`restored`, the instance's
   * snapshots before the stop) reference and the stop's new snapshots
   * (`next`) do not. Normally the two agree, since every save records the
   * restore set. Requiring both keeps a reference this leg never used (one a
   * resume ignored, see `WorkflowResumeOptions.ignoreContainerSnapshots`) out
   * of the removal, even when the resume checkpoint that dropped it was not
   * saved.
   */
  private snapshotsSupersededBy(
    previous: Readonly<Record<string, ContainerSnapshotRef>> | undefined,
    restored: Readonly<Record<string, ContainerSnapshotRef>> | undefined,
    next: Readonly<Record<string, ContainerSnapshotRef>> | undefined,
  ): Readonly<Record<string, ContainerSnapshotRef>> | undefined {
    if (!previous || !restored) return undefined;
    const restoredImages = new Set(Object.values(restored).map((snapshot) => snapshot.image));
    const nextImages = new Set(Object.values(next ?? {}).map((snapshot) => snapshot.image));
    const superseded: Record<string, ContainerSnapshotRef> = {};
    for (const [scope, snapshot] of Object.entries(previous)) {
      if (restoredImages.has(snapshot.image) && !nextImages.has(snapshot.image)) {
        superseded[scope] = snapshot;
      }
    }
    return Object.keys(superseded).length > 0 ? superseded : undefined;
  }

  /**
   * Lazy-loads the default `createDockerInfrastructure` wrapper. The real
   * helper requires Docker dependencies and the session config, so we
   * construct them here rather than eagerly at orchestrator construction
   * time (which would pay the import cost for every workflow run,
   * including builtin ones that don't need Docker).
   */
  private async loadDefaultInfrastructureFactory(): Promise<
    (input: CreateWorkflowInfrastructureInput) => Promise<DockerInfrastructure>
  > {
    const { createDockerInfrastructure } = await import('../docker/docker-infrastructure.js');
    const { loadConfig, applyAllowedDirectoryToMcpArgs } = await import('../config/index.js');
    const { filterMcpServersByPolicy } = await import('../persona/resolve.js');

    // The raw `--capture-traces` override is threaded through unresolved;
    // the infrastructure factory is the single place that resolves it
    // against `userConfig.capture?.enabled`. The same raw override is
    // applied to every scope's bundle.
    const captureTracesOverride = this.deps.captureTracesOverride;

    return async (input) => {
      const config = loadConfig();
      // Bundle dir holds the bundle's shared Docker artifacts
      // (orientation, sockets, claude-state, escalations, system
      // prompt). It lives under the bundle's per-bundleId subtree so
      // bifurcated workflows can host multiple bundles side by side
      // without key collisions.
      // Audit entries go to the per-bundle audit file (one file per
      // bundle, with per-entry persona tagging).
      const bundleDir = getBundleBundleDir(input.workflowId, input.bundleId);
      const bundleEscalationDir = resolve(bundleDir, 'escalations');
      // All sessions in a workflow share the workflow's workspace dir
      // as their allowed directory. Do NOT use a session-scoped sandbox
      // here: the orchestrator's artifact checks look inside the
      // workspace, so artifacts the agent writes must land in the same
      // tree.
      mkdirSync(bundleDir, { recursive: true });
      mkdirSync(bundleEscalationDir, { recursive: true });
      mkdirSync(input.workspacePath, { recursive: true });
      // Rewrite the allowed directory and audit path onto the loaded
      // config. `config.allowedDirectory` drives the filesystem MCP
      // server's --allowed-directory; `config.auditLogPath` is what the
      // ToolCallCoordinator (via Sandbox) reads when creating the
      // AuditLog. Without the audit rewrite, audit entries fall through
      // to the default `./audit.jsonl` against process.cwd().
      config.allowedDirectory = input.workspacePath;
      config.auditLogPath = getBundleAuditLogPath(input.workflowId, input.bundleId);
      // With taint escalation enabled, the coordinator also replays the
      // audit logs of the bundles a resumed run's earlier legs minted.
      config.taintReplayAuditLogPaths = input.taintReplayAuditLogPaths ?? [];
      // The bundle's budget gate takes its limits from this config: apply
      // the run's effective budget, as each state's session config does.
      if (input.resourceBudget !== undefined) {
        config.userConfig = { ...config.userConfig, resourceBudget: input.resourceBudget };
      }
      // Human approvals feed the approval history under the policy in
      // effect: the bundle starts on the global policy, and the
      // coordinator's loadPolicy moves the scope to each persona it loads.
      config.approvalHistoryScope = GLOBAL_APPROVAL_SCOPE;
      const servers = filterMcpServersByPolicy(config.mcpServers, input.requiredServers);
      // The orchestrator never asks for memory (getRequiredServersForScope),
      // but the bundle must not get it even if the required set or the
      // server configuration names it: see withoutMemoryServer.
      if (Object.hasOwn(servers, MEMORY_SERVER_NAME)) {
        writeStderr(
          `[workflow] not starting the "${MEMORY_SERVER_NAME}" server in shared-container scope "${input.scope}": ` +
            `one bundle-wide memory server would give every persona in the scope the same database`,
        );
      }
      config.mcpServers = withoutMemoryServer(servers);
      applyAllowedDirectoryToMcpArgs(config.mcpServers, input.workspacePath);
      // The bundle coordinator narrows every persona policy it loads with
      // the run's task scope (validated by the orchestrator; the sandbox
      // loads it again and refuses the bundle if it no longer validates).
      if (input.taskPolicyDir !== undefined) config.taskPolicyDir = input.taskPolicyDir;
      // A read-only scope: read-only workspace mount, no nested Docker, and a
      // coordinator that confines changes to the scope's output directories.
      const bundleConfig = input.readOnlyWorkspace ? applyReadOnlyWorkspace(config, input.readOnlyWorkspace) : config;
      return createDockerInfrastructure(
        // Escalated tool calls reach the workflow's human route (the
        // in-process handler below); see withWorkflowEscalationRouting.
        withWorkflowEscalationRouting(bundleConfig, bundleEscalationDir),
        { kind: 'docker', agent: input.agentId },
        bundleDir,
        input.workspacePath,
        bundleEscalationDir,
        input.bundleId,
        // Threading the workflowId + scope here drives the
        // `ironcurtain.workflow` and `ironcurtain.scope` Docker labels
        // emitted by `createSessionContainers()` via `buildBundleLabels`.
        input.workflowId,
        input.scope,
        input.resolvedSkills,
        {
          override: captureTracesOverride,
          capturesDir: getBundleCapturesDir(input.workflowId, input.bundleId),
          recordedAgentName: input.agentId,
          workflowRunId: input.workflowId,
        },
        input.workflowScriptsDir,
        {
          workflowRunDir: input.workflowRunDir,
          ...(input.baseImageOverride
            ? {
                baseImageOverride: input.baseImageOverride,
                baseImageAgentBuildHash: input.baseImageAgentBuildHash,
                ...(input.baseImageAgentSudo === undefined ? {} : { baseImageAgentSudo: input.baseImageAgentSudo }),
              }
            : {}),
          onEscalation: input.onEscalation,
          onHostPrivilegedFiles: (notice) => {
            const instance = this.workflows.get(input.workflowId);
            if (instance) this.recordHostPrivilegedFiles(instance, notice);
            else writeStderr(formatSessionNotice(notice));
          },
          // Fan-out lanes in this scope each get their own circuit-breaker
          // window on the bundle's coordinator; this bounds their total.
          maxLanes: input.maxLanes,
          ...(input.workflowCommit ? { workflowCommit: input.workflowCommit } : {}),
        },
      );
    };
  }

  /** Lazy-loads the default `destroyDockerInfrastructure` helper. */
  private async loadDefaultInfrastructureTeardown(): Promise<(infra: DockerInfrastructure) => Promise<unknown>> {
    const { destroyDockerInfrastructure } = await import('../docker/docker-infrastructure.js');
    return destroyDockerInfrastructure;
  }

  // -----------------------------------------------------------------------
  // Run-wide usage (metrics bus) and the workflow spend ceiling
  // -----------------------------------------------------------------------
  //
  // The metrics bus is global (`getLlmMetricsEventBus()`): the MITM of every
  // bundle publishes each completed LLM exchange on it once. Each run keeps
  // one subscription for its lifetime and its meter keeps only the exchanges
  // that belong to the run (attributed to the run id, or to one of its
  // bundles). This replaces the earlier token-stream counter, which added up
  // only `message_end.outputTokens`: no input or cache tokens, and nothing at
  // all for OpenAI-format streams.

  /**
   * Subscribes the run's usage meter to the metrics bus. Installed
   * synchronously before any state runs, so no exchange goes unobserved.
   */
  private setupUsageSubscription(instance: WorkflowInstance): void {
    // Defensive: re-entry by resume-after-crash should not double-subscribe.
    if (instance.unsubscribeUsage) return;
    instance.unsubscribeUsage = getLlmMetricsEventBus().subscribe((exchange) => {
      instance.usage.observeExchange(exchange);
    });
  }

  /**
   * Tears down the metrics-bus subscription. Idempotent: safe to call from
   * both normal completion and abort paths.
   */
  private teardownUsageSubscription(instance: WorkflowInstance): void {
    if (instance.unsubscribeUsage) {
      try {
        instance.unsubscribeUsage();
      } catch {
        // Unsubscribe is best-effort; errors here should never prevent
        // workflow teardown from completing.
      }
      instance.unsubscribeUsage = undefined;
    }
  }

  /**
   * Refuses to start `stateId` once the run has reached its
   * `settings.workflowBudget` (see `findWorkflowBudgetBreach`). Runs before
   * every agent state, deterministic state and fan-out batch, including each
   * step of a fan-out lane, so the ceiling is checked again at every state
   * boundary rather than only between top-level states.
   *
   * On a breach the instance is stamped (once) and a
   * `WorkflowBudgetExhaustedError` is thrown. The machine routes that error
   * to the abort-preserving terminal (`isResumableWorkflowStop`); inside a
   * fan-out lane it lands on the lane's `errored` terminal, drains the
   * other lanes, and `upstreamFailureAfterFanOut` re-raises it at the
   * barrier. Either way `handleWorkflowComplete` reports `aborted` and keeps
   * the checkpoint, so the run resumes once the limit is raised.
   */
  private assertWithinWorkflowBudget(workflowId: WorkflowId, stateId: string): void {
    const instance = this.workflows.get(workflowId);
    const limits = instance?.definition.settings?.workflowBudget;
    if (!instance || limits === undefined) return;
    const breach = findWorkflowBudgetBreach(limits, instance.usage.snapshot());
    if (!breach) return;
    const error = new WorkflowBudgetExhaustedError({
      stateId,
      limitField: breach.limitField,
      used: breach.used,
      limit: breach.limit,
      detail: breach.message,
    });
    if (!instance.workflowBudgetExhausted) {
      const definitionCopy = resolve(this.deps.baseDir, workflowId, 'definition.json');
      instance.workflowBudgetExhausted = {
        breach,
        reason:
          `${error.message}. Resumable: raise or remove settings.workflowBudget.${breach.limitField} in ${definitionCopy}, ` +
          `then run "ironcurtain workflow resume ${workflowId}".`,
      };
      writeStderr(`[workflow] ${error.message}`);
      instance.tab.write(`[budget] ${error.message}`);
      instance.messageLog.append({
        ...this.logBase(instance),
        type: 'error',
        error: error.message,
        context: `workflow budget check before "${stateId}"`,
      });
    }
    throw error;
  }

  /** Runs a state's service once the workflow budget check has passed. */
  private async invokeWithinWorkflowBudget<T>(
    workflowId: WorkflowId,
    stateId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    this.assertWithinWorkflowBudget(workflowId, stateId);
    return run();
  }

  // -----------------------------------------------------------------------
  // Workspace selection
  // -----------------------------------------------------------------------

  /** The run's directory under this orchestrator's base directory. */
  private runDirOf(workflowId: WorkflowId): string {
    return resolve(this.deps.baseDir, workflowId);
  }

  /** The workspace a run gets when the caller supplies none. */
  private defaultWorkspacePath(workflowId: WorkflowId): string {
    return resolve(this.runDirOf(workflowId), RUN_WORKSPACE_DIRNAME);
  }

  private protectedPathsForWorkspaceValidation(): readonly string[] {
    return this.deps.protectedPaths ?? loadConfig().protectedPaths;
  }

  /**
   * Resolves the workspace a resumed run uses. `recorded` is the checkpoint's
   * path after {@link rebaseRunLocalPaths}, so a run-local workspace already
   * points into this run directory even when the IronCurtain home moved.
   *
   * - No recorded path (checkpoints from before workspaces were recorded):
   *   the default workspace, created if needed.
   * - The derived default: must exist, and needs no validation as long as it
   *   is what `start()` created, a real directory inside a real run
   *   directory. One that is a symlink, or lies below a symlinked run
   *   directory, points wherever its author chose (a copied or foreign base
   *   directory can hold one), so it is validated like any other path.
   * - Any other path was supplied by a user at start (or arrived in an
   *   imported checkpoint), and the directory may have changed since, so it is
   *   validated again exactly like a fresh `--workspace` and its canonical form
   *   is used.
   *
   * A recorded workspace that no longer exists fails with
   * `WORKFLOW_WORKSPACE_MISSING`; it is never recreated empty, which would let
   * a long run continue silently without any of its earlier work (and, for a
   * stale path, outside the active home). Any other rejected path makes the
   * run not resumable.
   */
  private resolveResumeWorkspace(
    workflowId: WorkflowId,
    recorded: string | undefined,
    recordedOnDisk: string | undefined,
  ): string {
    const defaultWorkspace = this.defaultWorkspacePath(workflowId);
    if (recorded === undefined) mkdirSync(defaultWorkspace, { recursive: true });
    const missing = (path: string): WorkflowResumeError => {
      const moved = recordedOnDisk !== undefined && recordedOnDisk !== path ? ` (recorded as ${recordedOnDisk})` : '';
      return new WorkflowResumeError(
        'WORKFLOW_WORKSPACE_MISSING',
        `Cannot resume workflow ${workflowId}: its workspace ${path}${moved} does not exist. ` +
          'Restore the directory, or create it empty to resume without the earlier workspace contents.',
      );
    };
    const isDefault = recorded === undefined || recorded === defaultWorkspace;
    if (isDefault) {
      if (!isDirectory(defaultWorkspace)) throw missing(defaultWorkspace);
      if (isRealDirectory(this.runDirOf(workflowId)) && isRealDirectory(defaultWorkspace)) return defaultWorkspace;
    }
    const candidate = isDefault ? defaultWorkspace : recorded;
    try {
      return validateWorkspacePath(candidate, this.protectedPathsForWorkspaceValidation());
    } catch (err) {
      if (isWorkspaceValidationError(err) && err.code === 'WORKSPACE_NOT_FOUND') throw missing(candidate);
      throw new WorkflowResumeError(
        'WORKFLOW_NOT_RESUMABLE',
        `Cannot resume workflow ${workflowId}: workspace failed validation: ${toErrorMessage(err)}`,
      );
    }
  }

  /**
   * The task scope a resumed `--task-scoped` run keeps. Validated again: a
   * scope that no longer validates refuses the resume instead of letting
   * the run continue unscoped.
   */
  private resolveResumeTaskScope(workflowId: WorkflowId, recorded: string | undefined): string | undefined {
    if (recorded === undefined) return undefined;
    try {
      return validateTaskScopeDir(recorded);
    } catch (err) {
      throw new WorkflowResumeError(
        'WORKFLOW_NOT_RESUMABLE',
        `Cannot resume workflow ${workflowId}: its task scope failed validation: ${toErrorMessage(err)}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // WorkflowController implementation
  // -----------------------------------------------------------------------

  // Keeps the `async` signature even though the body no longer awaits:
  // (a) preserves the `WorkflowController.start()` contract (Promise<WorkflowId>),
  // (b) leaves a hook for future async bootstrap work without another
  // interface change.
  // eslint-disable-next-line @typescript-eslint/require-await
  async start(
    definitionPath: string,
    taskDescription: string,
    workspacePath?: string,
    options?: WorkflowStartOptions,
  ): Promise<WorkflowId> {
    this.assertAcceptingRuns('start a workflow');
    const raw = parseDefinitionFile(definitionPath);
    const definition = validateDefinition(raw);
    this.validatePersonas(definition);
    validateWorkflowSkillReferences(definition, getWorkflowPackageDir(definitionPath));
    this.assertAgentSlotDemandFits(definition);
    // A task scope must validate before anything is created; the run keeps
    // its canonical path from here on.
    const taskPolicyDir =
      options?.taskPolicyDir === undefined ? undefined : validateTaskScopeDir(options.taskPolicyDir);
    const workflowId = createWorkflowId();

    // A caller-supplied workspace (CLI --workspace, the workflows.start RPC)
    // goes through the same validator as `start -w` before anything is
    // created, and the run keeps its canonical form from here on. The
    // default workspace is derived by the orchestrator under its own base
    // directory, so it needs no validation.
    const resolvedWorkspace =
      workspacePath === undefined
        ? this.defaultWorkspacePath(workflowId)
        : validateWorkspacePath(workspacePath, this.protectedPathsForWorkspaceValidation());

    // Reject if any active workflow already uses this workspace path
    for (const instance of this.workflows.values()) {
      if (instance.workspacePath === resolvedWorkspace && !instance.finalStatus) {
        throw new Error(`Workspace ${resolvedWorkspace} is already in use by workflow ${instance.id}`);
      }
    }

    mkdirSync(resolvedWorkspace, { recursive: true });

    // Cross-process ownership, before anything is written into the workspace:
    // a run in another process (or another orchestrator) on the same
    // workspace realpath refuses this start. Held until terminalReady.
    const locks = this.claimRunLocks(workflowId, resolvedWorkspace);
    try {
      return this.startClaimedRun(
        workflowId,
        definitionPath,
        definition,
        taskDescription,
        resolvedWorkspace,
        taskPolicyDir,
        locks,
      );
    } catch (err) {
      this.releaseRunLocks(locks);
      throw err;
    }
  }

  /**
   * Body of {@link start} once the run and workspace locks are held.
   * `taskPolicyDir` is the run's validated, canonical task scope, or
   * undefined for an unscoped run.
   */
  private startClaimedRun(
    workflowId: WorkflowId,
    definitionPath: string,
    definition: WorkflowDefinition,
    taskDescription: string,
    resolvedWorkspace: string,
    taskPolicyDir: string | undefined,
    locks: WorkflowInstance['locks'],
  ): WorkflowId {
    // A reused --workspace may hold entries an earlier run's agent planted
    // (in Docker mode it is a read-write bind mount): `.workflow` or the task
    // description as a symlink to a host file, `.gitignore` as a FIFO or a link
    // to /dev/zero. Build the workflow-owned tree and touch `.gitignore` only
    // through the no-follow helpers, which move such entries aside or skip them.
    const artifactDir = resolve(resolvedWorkspace, WORKFLOW_ARTIFACT_DIR);
    const workspaceWarnings = [...prepareWorkflowArtifactDir(resolvedWorkspace, taskDescription).warnings];
    const gitignore = ensureWorkflowGitignored(resolvedWorkspace);
    if (gitignore.status === 'skipped') {
      workspaceWarnings.push(
        `left ${resolve(resolvedWorkspace, '.gitignore')} unchanged (${gitignore.reason}); ` +
          `add "${WORKFLOW_ARTIFACT_DIR}/" to it yourself if the workspace is a git repository`,
      );
    }
    for (const warning of workspaceWarnings) writeStderr(`[workflow] Warning: ${warning}`);

    // Copy the validated definition into the run directory so resume does
    // not depend on the original file (durable, atomic, format-stamped).
    const metaDir = this.runDirOf(workflowId);
    mkdirSync(metaDir, { recursive: true });
    writeRunDefinition(metaDir, definition);

    // Stage the workflow package's `skills/` tree into the run dir so
    // resume is independent of whether the original package path still
    // exists. Cached on the instance and persisted in every checkpoint
    // so all subsequent reads point at this stable per-run copy.
    const workflowSkillsDir = stageWorkflowSkillsAtStart(getWorkflowPackageDir(definitionPath), metaDir);
    const workflowScriptsDir = stageWorkflowScriptsAtStart(getWorkflowPackageDir(definitionPath), metaDir);

    const { machine, roundMachinesByState, gateStateNames, terminalStateNames } = buildWorkflowMachine(
      definition,
      taskDescription,
    );

    const providedMachine = this.provideActors(machine, workflowId, definition, roundMachinesByState);
    const actor = createActor(providedMachine);
    const tab = this.deps.createWorkflowTab(definition.name, workflowId);
    for (const warning of workspaceWarnings) tab.write(`[warning] ${warning}`);
    const messageLog = new MessageLog(resolve(this.deps.baseDir, workflowId, 'messages.jsonl'));

    const instance: WorkflowInstance = {
      id: workflowId,
      resourceBudget: resolveWorkflowResourceBudget(definition.settings),
      definition,
      definitionPath,
      workflowSkillsDir,
      workflowScriptsDir,
      taskPolicyDir,
      containerSnapshots: undefined,
      actor,
      roundMachinesByState,
      gateStateNames,
      terminalStateNames,
      activeSessions: new Set(),
      sessionClosures: new WeakMap(),
      artifactDir,
      workspacePath: resolvedWorkspace,
      tab,
      transitionHistory: [],
      currentState: definition.initial,
      terminalReady: false,
      stateEnteredAt: Date.now(),
      messageLog,
      bundlesByScope: new Map(),
      policyDirByPersona: new Map(),
      currentPersonaByBundle: new Map(),
      liveAgentTurnsByBundle: new Map(),
      mintedServersByBundle: new Map(),
      bundleMintsInFlight: 0,
      sessionSlots: new Map(),
      commitChannelsByBundle: new Map(),
      pendingEscalations: new Map(),
      stopController: new AbortController(),
      fanOutChildren: new Set(),
      locks,
      usage: new WorkflowUsageMeter(workflowId),
    };

    // Under `sharedContainer: true`, bundles are minted lazily by
    // `ensureBundleForScope` on the first agent or containerized deterministic
    // state for each scope. There is no eager workflow-start mint — the first
    // state pays the cost of spinning up the bundle it needs. This also
    // removes a latent "Docker not available" failure mode at workflow
    // registration time: the workflow enters the actor's first state
    // before any Docker resource is touched.

    this.workflows.set(workflowId, instance);
    this.setupUsageSubscription(instance);
    instance.usage.setRunning(isExecutableState(definition.states[definition.initial]));
    this.emitLifecycleEvent({ kind: 'started', workflowId, name: definition.name, taskDescription });
    this.subscribeToActor(instance);
    // Persist the initial executable state before it can transition directly
    // to a terminal. Terminal saves preserve this non-terminal resume point.
    this.saveCheckpoint(instance, actor.getSnapshot() as { value: unknown; context: unknown });
    messageLog.appendRunStarted({ ...this.logBase(instance), resourceBudget: instance.resourceBudget });
    actor.start();
    return workflowId;
  }

  /** Loads a checkpoint `resume()` can use, or throws the matching `WorkflowResumeError`. */
  private loadResumableCheckpoint(workflowId: WorkflowId): WorkflowCheckpoint {
    if (!isSafeWorkflowId(workflowId)) {
      throw new WorkflowResumeError(
        'WORKFLOW_INVALID_ID',
        `Invalid workflow ID ${JSON.stringify(workflowId)}: use 1-128 letters, digits, "_" or "-"`,
      );
    }
    let checkpoint: WorkflowCheckpoint | undefined;
    try {
      checkpoint = this.deps.checkpointStore.load(workflowId);
    } catch (err) {
      // A newer format is refused as such: reporting it as corruption would
      // send the user looking for damage that is not there.
      throw new WorkflowResumeError(
        isWorkflowRunFileTooNewError(err) ? 'WORKFLOW_CHECKPOINT_TOO_NEW' : 'WORKFLOW_CHECKPOINT_CORRUPTED',
        `Failed to load checkpoint for workflow ${workflowId}: ${toErrorMessage(err)}`,
      );
    }
    if (!checkpoint) {
      throw new WorkflowResumeError('WORKFLOW_CHECKPOINT_NOT_FOUND', `No checkpoint found for workflow ${workflowId}`);
    }
    if (!isCheckpointResumable(checkpoint)) {
      throw new WorkflowResumeError('WORKFLOW_NOT_RESUMABLE', `Workflow ${workflowId} has already completed`);
    }
    return checkpoint;
  }

  // Intentionally has no await: the instance must be installed before a
  // second resume call can observe an opening in the active-workflow guard.
  // eslint-disable-next-line @typescript-eslint/require-await
  async resume(workflowId: WorkflowId, options?: WorkflowResumeOptions): Promise<void> {
    this.assertAcceptingRuns('resume a workflow');
    const existing = this.workflows.get(workflowId);
    if (existing && (!existing.finalStatus || !existing.terminalReady)) {
      throw new WorkflowResumeError('WORKFLOW_ALREADY_ACTIVE', `Workflow ${workflowId} is already active`);
    }

    // Side-effect-free pre-check: a missing, corrupt or completed run is
    // refused before anything (the run lock included) touches the disk.
    this.loadResumableCheckpoint(workflowId);

    // Cross-process ownership: a run that is live in another process (or in
    // another orchestrator of this one) is refused instead of executed twice.
    // A crashed holder's lock is reclaimed. Held until terminalReady.
    const locks: WorkflowInstance['locks'] = {};
    try {
      locks.run = claimWorkflowRunLock(this.deps.baseDir, workflowId);
    } catch (err) {
      if (isWorkflowLockBusyError(err)) {
        throw new WorkflowResumeError('WORKFLOW_ALREADY_ACTIVE', `Cannot resume: ${err.message}`);
      }
      throw err;
    }
    try {
      this.resumeClaimedRun(workflowId, locks, options);
    } catch (err) {
      this.releaseRunLocks(locks);
      throw err;
    }
  }

  /**
   * Body of {@link resume} once the run lock is held. Claims the workspace lock
   * itself (adding it to `locks`) before the first workspace write.
   */
  private resumeClaimedRun(
    workflowId: WorkflowId,
    locks: WorkflowInstance['locks'],
    options: WorkflowResumeOptions | undefined,
  ): void {
    // The authoritative read, under the run lock: another process may have
    // advanced or finished the run between the pre-check and the claim.
    // Run-local paths follow the run directory: after a move of the
    // IronCurtain home they point here, not at the old location.
    const loadedCheckpoint = this.loadResumableCheckpoint(workflowId);
    const checkpoint = rebaseRunLocalPaths(loadedCheckpoint, workflowId, this.runDirOf(workflowId));

    const definitionCopyPath = runDefinitionPath(this.runDirOf(workflowId));
    const hasDefinitionCopy = existsSync(definitionCopyPath);
    const allowPackageRecovery = isOwnWorkflowRunsDirectory(this.deps.baseDir);
    if (!hasDefinitionCopy && !allowPackageRecovery) {
      throw new WorkflowResumeError(
        'WORKFLOW_CHECKPOINT_CORRUPTED',
        'An external workflow run requires its own definition.json copy',
      );
    }
    const definitionPath = hasDefinitionCopy ? definitionCopyPath : checkpoint.definitionPath;
    let definition: WorkflowDefinition;
    try {
      // The run copy carries a format stamp (checked and removed here);
      // original user files may be YAML.
      definition = validateDefinition(
        hasDefinitionCopy ? readRunDefinitionRaw(definitionPath) : parseDefinitionFile(definitionPath),
      );
    } catch (err) {
      // Name the file: a run recorded before a validation rule existed (a
      // host deterministic state without host: true, say) resumes only after
      // this copy is fixed, and editing the workflow's source changes nothing.
      throw new WorkflowResumeError(
        isWorkflowRunFileTooNewError(err) ? 'WORKFLOW_CHECKPOINT_TOO_NEW' : 'WORKFLOW_CHECKPOINT_CORRUPTED',
        `Failed to load workflow definition ${definitionPath} for ${workflowId}: ${toErrorMessage(err)}`,
      );
    }
    // As in start(): refuse, before anything is created, a shared-container
    // run that needs more agent slots than the cap now allows (the cap may
    // have been lowered since the run started); its first mint could never
    // be served.
    this.assertAgentSlotDemandFits(definition);

    const restored = (() => {
      try {
        const taskDescription = checkpoint.context.taskDescription;
        const totalTokens = checkpoint.context.totalTokens;
        if (typeof taskDescription !== 'string' || !Number.isFinite(totalTokens)) {
          throw new Error('Checkpoint context is missing taskDescription or totalTokens');
        }
        const transitionHistory = [...checkpoint.transitionHistory];
        const { machine, roundMachinesByState, gateStateNames, terminalStateNames } = buildWorkflowMachine(
          definition,
          taskDescription,
        );
        const providedMachine = this.provideActors(machine, workflowId, definition, roundMachinesByState);
        const restoredSnapshot = providedMachine.resolveState({
          value: checkpoint.machineState as string,
          context: checkpoint.context,
        });
        const restoredState = String(checkpoint.machineState);
        if (!Object.hasOwn(definition.states, restoredState)) {
          throw new Error(`Checkpoint references unknown state ${restoredState}`);
        }
        const stateDefinition = definition.states[restoredState];
        return {
          actor: createActor(providedMachine, { snapshot: restoredSnapshot as Snapshot<unknown> }),
          roundMachinesByState,
          gateStateNames,
          terminalStateNames,
          taskDescription,
          totalTokens,
          transitionHistory,
          restoredState,
          stateDefinition,
        };
      } catch (err) {
        throw new WorkflowResumeError(
          'WORKFLOW_CHECKPOINT_CORRUPTED',
          `Failed to restore checkpoint for workflow ${workflowId}: ${toErrorMessage(err)}`,
        );
      }
    })();

    const workspacePath = this.resolveResumeWorkspace(
      workflowId,
      checkpoint.workspacePath,
      loadedCheckpoint.workspacePath,
    );
    const taskPolicyDir = this.resolveResumeTaskScope(workflowId, checkpoint.taskPolicyDir);
    const artifactDir = resolve(workspacePath, WORKFLOW_ARTIFACT_DIR);
    // The workspace may be held by another run (an imported checkpoint points
    // at its source run's workspace, and `--workspace` can name any
    // directory). Claimed before the first write into it.
    try {
      locks.workspace = claimWorkflowWorkspaceLock(
        this.deps.workspaceLockDir ?? getWorkflowWorkspaceLocksDir(),
        workspacePath,
      );
    } catch (err) {
      if (isWorkflowLockBusyError(err)) {
        throw new WorkflowResumeError(
          'WORKFLOW_ALREADY_ACTIVE',
          `Cannot resume workflow ${workflowId}: ${err.message}`,
        );
      }
      throw err;
    }
    // Re-validate the workflow-owned tree before any host-side artifact work:
    // while the run was paused an agent (or a process it left behind) may have
    // replaced `.workflow` or `.workflow/task` with a symlink into a host
    // directory. Such entries are moved aside and recreated, and the task
    // description is rewritten from the checkpoint. This also creates the tree
    // for pre-workspace checkpoints.
    const workspaceWarnings = prepareWorkflowArtifactDir(workspacePath, restored.taskDescription).warnings;
    for (const warning of workspaceWarnings) writeStderr(`[workflow] Warning: ${warning}`);

    const tab = this.deps.createWorkflowTab(definition.name, workflowId);
    for (const warning of workspaceWarnings) tab.write(`[warning] ${warning}`);
    // Append to existing log file (resume must not overwrite)
    const messageLog = new MessageLog(resolve(this.deps.baseDir, workflowId, 'messages.jsonl'));

    // Resolve workflow-skills with the run-dir staged copy as primary,
    // a fresh re-stage from the original package dir as recovery, and
    // a logged `undefined` as the last-resort degradation. See
    // `resolveWorkflowSkillsDirOnResume` for the full priority order.
    //
    // Recovery uses `checkpoint.definitionPath` (the user's original
    // package), not `definitionPath` — the latter resolves to the
    // run-dir copy of `definition.json` whose `getWorkflowPackageDir`
    // is the run dir itself, which never contains a sibling `skills/`.
    const runMetaDir = resolve(this.deps.baseDir, workflowId);
    const workflowSkillsDir = resolveWorkflowSkillsDirOnResume({
      workflowId,
      checkpointedStagedDir: checkpoint.workflowSkillsDir,
      packageDir: getWorkflowPackageDir(checkpoint.definitionPath),
      runMetaDir,
      allowPackageRecovery,
    });
    const workflowScriptsDir = resolveWorkflowScriptsDirOnResume({
      workflowId,
      checkpointedStagedDir: checkpoint.workflowScriptsDir,
      packageDir: getWorkflowPackageDir(checkpoint.definitionPath),
      runMetaDir,
      allowPackageRecovery,
    });
    // The scopes' restore snapshots, unless the caller cannot vouch for the
    // checkpoint's references (see WorkflowResumeOptions): then they are
    // neither restored nor, since the resume checkpoint drops them, removed.
    const restoreSnapshots = options?.ignoreContainerSnapshots ? undefined : checkpoint.containerSnapshots;

    const instance: WorkflowInstance = {
      id: workflowId,
      // A legacy resume establishes limits for the resumed sessions; it does
      // not reconstruct the settings used before this checkpoint.
      resourceBudget:
        options?.useCurrentBudget || !checkpoint.resourceBudget?.recorded
          ? resolveWorkflowResourceBudget(definition.settings)
          : checkpoint.resourceBudget,
      definition,
      definitionPath: allowPackageRecovery ? checkpoint.definitionPath : definitionCopyPath,
      workflowSkillsDir,
      workflowScriptsDir,
      taskPolicyDir,
      containerSnapshots: restoreSnapshots,
      actor: restored.actor,
      roundMachinesByState: restored.roundMachinesByState,
      gateStateNames: restored.gateStateNames,
      terminalStateNames: restored.terminalStateNames,
      activeSessions: new Set(),
      sessionClosures: new WeakMap(),
      artifactDir,
      workspacePath,
      tab,
      transitionHistory: restored.transitionHistory,
      currentState: String(checkpoint.machineState),
      terminalReady: false,
      stateEnteredAt: Date.now(),
      messageLog,
      bundlesByScope: new Map(),
      // Listed before this leg mints any bundle (taint escalation replays
      // them). Only shared-container runs mint bundles.
      ...(this.shouldUseSharedContainer(definition)
        ? { priorBundleAuditLogPaths: listPriorBundleAuditLogPaths(workflowId) }
        : {}),
      policyDirByPersona: new Map(),
      currentPersonaByBundle: new Map(),
      liveAgentTurnsByBundle: new Map(),
      mintedServersByBundle: new Map(),
      bundleMintsInFlight: 0,
      sessionSlots: new Map(),
      commitChannelsByBundle: new Map(),
      pendingEscalations: new Map(),
      stopController: new AbortController(),
      fanOutChildren: new Set(),
      locks,
      // Resume continues from the checkpointed usage, so totals and the
      // workflow budget span every leg of the run instead of resetting.
      usage: new WorkflowUsageMeter(workflowId, workflowUsageFromCheckpoint(checkpoint)),
    };

    if (restored.stateDefinition.type === 'human_gate') {
      // A checkpoint taken at a gate carries that raise's id; restoring it
      // keeps a decision made before the restart valid. A legacy checkpoint
      // without one, or an id that was not minted for this gate of this run,
      // gets a fresh raise id instead. Either way the id is settled here, so
      // the resume checkpoint below persists it and a second restart before
      // the decision keeps it too. An id left beside a non-gate state is
      // ignored: the run is not waiting at a gate.
      instance.activeGateId = isGateIdFor(checkpoint.activeGateId, workflowId, restored.restoredState)
        ? checkpoint.activeGateId
        : this.mintGateIdFor(instance, restored.restoredState);
    }

    // Under the lazy-mint model there is nothing to create at resume
    // time: `bundlesByScope` starts empty and the first state to execute
    // mints its bundle. When the checkpoint carries snapshot digests,
    // the per-scope mint path uses them as immutable image overrides
    // when they were taken under the agent image build the bundle
    // resolves now; other builds and missing images degrade to fresh.
    if (this.shouldUseSharedContainer(definition)) {
      const restoredScopes = Object.keys(restoreSnapshots ?? {});
      const ignoredSnapshots =
        restoreSnapshots === undefined && Object.keys(checkpoint.containerSnapshots ?? {}).length > 0;
      const snapshotNote =
        restoredScopes.length > 0
          ? ` Snapshot restore available for scope(s): ${restoredScopes.join(', ')}.`
          : ignoredSnapshots
            ? ' The container snapshots this checkpoint records are not used; scopes will start fresh.'
            : ' No container snapshots recorded; scopes will start fresh.';
      writeStderr(
        `[workflow] Resuming ${workflowId} in shared-container mode: bundles will be re-created lazily per scope.${snapshotNote}`,
      );
    }

    this.workflows.set(workflowId, instance);
    this.setupUsageSubscription(instance);
    instance.usage.setRunning(isExecutableState(restored.stateDefinition));
    this.emitLifecycleEvent({
      kind: 'started',
      workflowId,
      name: definition.name,
      taskDescription: restored.taskDescription,
    });
    this.subscribeToActor(instance);
    let checkpointMtimeMs: number | undefined;
    let checkpointFingerprint: string | undefined;
    try {
      const checkpointPath = resolve(this.deps.baseDir, workflowId, 'checkpoint.json');
      checkpointMtimeMs = statSync(checkpointPath).mtimeMs;
      checkpointFingerprint = sha256Hex(readFileSync(checkpointPath));
    } catch {
      // Custom checkpoint stores need not use the default on-disk layout.
    }
    messageLog.appendRunResumed({
      ...this.logBase(instance),
      resourceBudget: instance.resourceBudget,
      ...(!checkpoint.resourceBudget?.recorded ? { originalBudgetUnknown: true } : {}),
      ...(options?.useCurrentBudget ? { useCurrentBudget: true } : {}),
      ...(checkpointMtimeMs !== undefined ? { checkpointMtimeMs } : {}),
      ...(checkpointFingerprint !== undefined ? { checkpointFingerprint } : {}),
    });
    // Every save of this leg keeps the restore-image references (the
    // instance's) until the next stop can replace and remove them. The resumed
    // checkpoint clears the previous finalStatus; the marker's fingerprint
    // above still identifies that stale terminal save.
    this.saveCheckpoint(instance, restored.actor.getSnapshot() as { value: unknown; context: unknown });
    restored.actor.start();

    // XState v5's resolveState() restores *to* a state but does not *enter* it.
    // Invoke services (agent/deterministic) only start on state entry via transition.
    // For invoke states, we must manually execute the service and feed the result
    // back to the actor as an xstate.done.actor / xstate.error.actor event.
    if (restored.stateDefinition.type === 'agent' || restored.stateDefinition.type === 'deterministic') {
      this.replayInvokeForRestoredState(workflowId, restored.restoredState, restored.stateDefinition, definition);
    }
  }

  /**
   * Manually executes the invoke service for a state that was restored from
   * a checkpoint. XState does not re-trigger invocations when an actor is
   * started from a persisted snapshot, so we run the service ourselves and
   * send the result event to the actor.
   *
   * Resume is at-least-once: the checkpoint is written when a state is
   * entered, so the restored state runs again from its start even if the
   * stopped run had already done part of it. The inputs come from the same
   * builders the machine's invokes use (lane-templated deterministic argv
   * and result path included), and a replayed agent state is flagged
   * `resumeReplay` so its prompt tells the agent to inspect the workspace and
   * not repeat external actions. A fan-out batch is re-run through
   * `runFanOutSegment`, which reconstructs already-recorded lanes from the
   * durable run store instead of re-running them. A lane that had not
   * recorded is re-spawned from its first member with the machine's ordinary
   * inputs and deliberately no resume notice: the re-run regenerates the
   * lane's inputs (evolve's `sample` writes a new round context), so telling
   * a lane agent to keep an earlier attempt's files could mix that work into
   * a round it no longer matches.
   */
  private replayInvokeForRestoredState(
    workflowId: WorkflowId,
    stateId: string,
    stateDef: AgentStateDefinition | DeterministicStateDefinition,
    definition: WorkflowDefinition,
  ): void {
    const instance = this.workflows.get(workflowId);
    if (!instance) return;

    const snapshot = instance.actor.getSnapshot() as { context: WorkflowContext };
    const context = snapshot.context;

    // Build the service promise based on state type, from the same invoke
    // inputs the machine builds. Like every invoke, the replayed state first
    // checks the run-wide budget (provideActors), so the re-run notice below
    // is written only once the state really runs again.
    const runService = (): Promise<unknown> => {
      if (stateDef.fanOut !== undefined) {
        return this.runFanOutSegment(
          workflowId,
          buildFanOutInvokeInput(stateId, stateDef, context),
          definition,
          instance.roundMachinesByState,
        );
      }
      if (stateDef.type === 'agent') {
        instance.tab.write(`[agent] Re-running "${stateId}" from its start after resume`);
        return this.executeAgentState(
          workflowId,
          { ...buildAgentInvokeInput(stateId, stateDef, context), resumeReplay: true },
          definition,
        );
      }
      // No invoke signal here: the instance's stopController is what kills
      // a replayed host command when the run stops. The builder carries the
      // state's `host: true` acknowledgement, which the host runner requires.
      return this.executeDeterministicState(workflowId, buildDeterministicInvokeInput(stateId, stateDef, context));
    };
    const servicePromise = this.invokeWithinWorkflowBudget(workflowId, stateId, runService);

    // Feed the result back to the actor as an XState internal invoke event.
    // These event types don't exist in our WorkflowEvent union, so we cast
    // through unknown to satisfy TypeScript while matching XState's internal
    // event format that onDone/onError handlers expect.
    servicePromise
      .then((output) => {
        instance.actor.send({ type: `xstate.done.actor.${stateId}`, output });
      })
      .catch((err: unknown) => {
        instance.actor.send({ type: `xstate.error.actor.${stateId}`, error: err });
      });
  }

  /**
   * Runs under the base directory that `resume()` would accept now: a
   * resumable checkpoint, not active here, and not running in another
   * process (its run lock held by a live owner).
   */
  listResumable(): WorkflowId[] {
    const runs = discoverWorkflowRuns(this.deps.baseDir);
    const activeIds = new Set(this.listActive());
    const resumable: WorkflowId[] = [];
    for (const run of runs) {
      if (!run.hasCheckpoint || activeIds.has(run.workflowId)) continue;
      if (isWorkflowRunLockHeld(this.deps.baseDir, run.workflowId)) continue;
      // FileCheckpointStore.load() re-throws on JSON.parse failure (it only
      // swallows ENOENT). A single corrupt checkpoint.json would otherwise
      // poison the whole list and break `workflow inspect` discovery + the
      // web UI past-runs panel. Skip and log instead.
      let cp;
      try {
        cp = this.deps.checkpointStore.load(run.workflowId);
      } catch (err) {
        writeStderr(
          `[workflow] Failed to load checkpoint for ${run.workflowId}: ${toErrorMessage(err)}; skipping in resumable list`,
        );
        continue;
      }
      if (cp !== undefined && isCheckpointResumable(cp)) {
        resumable.push(run.workflowId);
      }
    }
    return resumable;
  }

  getStatus(id: WorkflowId): WorkflowStatus | undefined {
    const instance = this.workflows.get(id);
    if (!instance) return undefined;

    if (instance.finalStatus) return instance.finalStatus;

    if (instance.activeGateId !== undefined) {
      const gateName = instance.currentState;
      const stateDef = instance.definition.states[gateName];
      if (stateDef.type === 'human_gate') {
        return {
          phase: 'waiting_human',
          gate: this.buildGateRequest(id, gateName, stateDef, instance.activeGateId),
        };
      }
    }

    return {
      phase: 'running',
      currentState: instance.currentState,
      activeAgents: [],
    };
  }

  getDetail(id: WorkflowId): WorkflowDetail | undefined {
    const instance = this.workflows.get(id);
    if (!instance) return undefined;

    const snapshot = instance.actor.getSnapshot() as { context: WorkflowContext };
    const ctx = snapshot.context;
    const usage = instance.usage.snapshot();

    return {
      budget: this.getInstanceBudget(instance, usage),
      usage,
      definition: instance.definition,
      transitionHistory: [...instance.transitionHistory],
      workspacePath: instance.workspacePath,
      context: {
        taskDescription: ctx.taskDescription,
        round: ctx.round,
        maxRounds: ctx.maxRounds,
        // Live run-wide total; the machine context only catches up when an
        // agent state or fan-out batch finishes.
        totalTokens: usage.totalTokens,
        visitCounts: { ...ctx.visitCounts },
      },
    };
  }

  getBudget(id: WorkflowId): WorkflowBudget | undefined {
    const instance = this.workflows.get(id);
    return instance ? this.getInstanceBudget(instance) : undefined;
  }

  /**
   * The budget view: the saved per-session limits, one active (or the last)
   * session's usage, and the run-wide ceiling and usage. The ceiling always
   * comes from the run's definition, never from a saved budget.
   */
  private getInstanceBudget(
    instance: WorkflowInstance,
    workflowUsage: WorkflowUsage = instance.usage.snapshot(),
  ): WorkflowBudget {
    const session = instance.activeSessions.values().next().value;
    const workflowLimits = instance.definition.settings?.workflowBudget;
    return {
      ...persistedWorkflowBudget(instance.resourceBudget),
      activeSessionCount: instance.activeSessions.size,
      ...(session ? { usage: workflowBudgetUsage(session.getBudgetStatus()) } : {}),
      ...(workflowLimits !== undefined ? { workflowLimits } : {}),
      workflowUsage,
    };
  }

  listActive(): readonly WorkflowId[] {
    return [...this.workflows.keys()].filter((id) => {
      const instance = this.workflows.get(id);
      return instance && !instance.terminalReady;
    });
  }

  /**
   * Applies a human decision to the gate the workflow is waiting at.
   *
   * Validation runs before anything is mutated (see
   * `assertGateResolutionAllowed`): the decision must quote the id of the
   * raise currently up, the event must be one the gate's definition
   * transitions on, and feedback events must carry feedback. A refused
   * decision throws `GateResolutionError`, leaves the gate up with the same
   * id and logs nothing, so a stale approval from an earlier visit, a second
   * decider racing the first, or an event the gate cannot route never
   * dismisses the gate or forges a `gate_resolved` record.
   */
  resolveGate(id: WorkflowId, event: HumanGateEvent): void {
    const instance = this.workflows.get(id);
    if (!instance) {
      throw new GateResolutionError('WORKFLOW_NOT_FOUND', `Workflow ${id} not found`);
    }

    const gateName = instance.currentState;
    const stateDef = instance.definition.states[gateName];
    assertGateResolutionAllowed(
      {
        workflowId: instance.id,
        // A run aborted while waiting keeps its gate id (the terminal
        // checkpoint carries it so a resume re-raises the same gate), but a
        // terminal run has nothing left to decide.
        activeGateId: instance.finalStatus === undefined ? instance.activeGateId : undefined,
        gate: stateDef.type === 'human_gate' ? stateDef : undefined,
      },
      event,
    );
    // Equal to `instance.activeGateId` once the assertion above has passed.
    const gateId = event.gateId;

    // Clear before sending so a concurrent second decision for the same raise
    // fails the active-gate check instead of being applied twice.
    instance.activeGateId = undefined;
    this.clearGateIdleTimer(instance);
    this.deps.dismissGate(instance.id, gateId);

    instance.messageLog.append({
      ...this.logBase(instance),
      type: 'gate_resolved',
      gateId,
      event: event.type,
      prompt: event.prompt ?? null,
      resolvedBy: event.resolvedBy,
    });

    const xstateEventName = `HUMAN_${event.type}` as const;
    instance.actor.send({
      type: xstateEventName,
      prompt: event.prompt,
    });
  }

  // -----------------------------------------------------------------------
  // Tool-call escalations (policy `escalate` decisions during agent states)
  // -----------------------------------------------------------------------

  listToolCallEscalations(id: WorkflowId): readonly WorkflowToolCallEscalation[] {
    const instance = this.workflows.get(id);
    if (!instance) return [];
    return [...instance.pendingEscalations.values()].map((pending) => pending.escalation);
  }

  resolveToolCallEscalation(
    id: WorkflowId,
    escalationId: string,
    decision: WorkflowToolCallEscalationDecision,
  ): boolean {
    const instance = this.workflows.get(id);
    if (!instance) return false;
    // A run that has reached a terminal status is being torn down: its
    // pending escalations are about to be withdrawn, and an approval landing
    // in that window must not run the call.
    if (instance.finalStatus) return false;
    const pending = instance.pendingEscalations.get(escalationId);
    if (!pending) return false;
    // Remove before settling so a concurrent second resolution, or the
    // session's own resolved callback, finds nothing left to act on.
    instance.pendingEscalations.delete(escalationId);
    // A human-only escalation is approved once: the pipeline offers it no
    // whitelist candidate, so a selection is dropped rather than passed on.
    pending.settle(pending.escalation.humanOnly === true ? { decision: decision.decision } : decision);
    this.recordToolCallEscalationOutcome(instance, pending.escalation, decision.decision);
    return true;
  }

  /**
   * In-process escalation handler bound to a shared-container bundle's
   * coordinator. The coordinator parks the tool call until the returned
   * promise settles:
   *   - a human decision (`resolveToolCallEscalation`) resolves it;
   *   - `details.signal` aborts when the coordinator stops waiting
   *     (escalation timeout, bundle teardown or a policy swap); the
   *     escalation is then reported as expired and the promise is ignored;
   *   - the orchestrator withdraws it (the agent turn that raised it ended,
   *     or the run is over) by rejecting with `EscalationWithdrawnError`,
   *     which the pipeline denies as cancelled, not as a human denial.
   *
   * An escalation raised while no agent turn is live on the bundle is
   * withdrawn at once and never offered to a human. Such a call does not
   * come from an agent turn (a process left running in the shared
   * container, or a command a deterministic state runs there), nothing
   * waits on its result, and an approval would run its side effect under
   * whatever state comes next. The same reasoning withdraws a bundle's
   * pending escalations when its last live turn ends
   * (`withdrawIdleBundleEscalations`).
   */
  private handleCoordinatorEscalation(
    instance: WorkflowInstance,
    bundleId: string,
    request: ToolCallRequest,
    reason: string,
    context: Readonly<Record<string, string>> | undefined,
    whitelistCandidates: readonly WhitelistCandidateIpc[] | undefined,
    details: EscalationPromptDetails,
  ): Promise<EscalationResult> {
    if (details.signal.aborted || instance.finalStatus) {
      return Promise.reject(new EscalationWithdrawnError('the workflow run is over'));
    }
    if (!instance.liveAgentTurnsByBundle.has(bundleId)) {
      return Promise.reject(new EscalationWithdrawnError('no agent turn is live on this container'));
    }
    return new Promise<EscalationResult>((settleDecision, rejectDecision) => {
      const escalation: WorkflowToolCallEscalation = {
        escalationId: details.escalationId,
        workflowId: instance.id,
        stateId: instance.currentState,
        ...(details.persona !== undefined ? { persona: details.persona } : {}),
        serverName: request.serverName,
        toolName: request.toolName,
        arguments: request.arguments,
        reason,
        ...(context ? { context } : {}),
        ...(whitelistCandidates ? { whitelistCandidates } : {}),
        ...(details.humanOnly ? { humanOnly: true as const } : {}),
        ...this.escalationReviewContext(instance, details),
        receivedAt: new Date().toISOString(),
      };
      const onAbort = (): void => this.expireToolCallEscalation(instance, escalation.escalationId, 'wait ended');
      details.signal.addEventListener('abort', onAbort, { once: true });
      this.registerToolCallEscalation(instance, {
        escalation,
        bundleId,
        settle: (decision) => {
          details.signal.removeEventListener('abort', onAbort);
          settleDecision(decision);
        },
        withdraw: (detail) => {
          details.signal.removeEventListener('abort', onAbort);
          rejectDecision(new EscalationWithdrawnError(detail));
        },
      });
    });
  }

  /**
   * Escalation surfaced by a session's file-IPC watcher (builtin and
   * per-state-container workflows, or a bundle whose coordinator has no
   * in-process hook). Decisions go back through `session.resolveEscalation`,
   * which writes the response file the coordinator polls for.
   */
  private handleSessionEscalation(
    instance: WorkflowInstance,
    stateId: string,
    persona: string,
    sessionRef: { current?: Session },
    request: EscalationRequest,
  ): void {
    if (instance.pendingEscalations.has(request.escalationId)) return;
    const escalation: WorkflowToolCallEscalation = {
      escalationId: request.escalationId,
      workflowId: instance.id,
      stateId,
      persona,
      serverName: request.serverName,
      toolName: request.toolName,
      arguments: request.arguments,
      reason: request.reason,
      ...(request.context ? { context: request.context } : {}),
      ...(request.whitelistCandidates ? { whitelistCandidates: request.whitelistCandidates } : {}),
      ...(request.humanOnly === true ? { humanOnly: true as const } : {}),
      ...this.escalationReviewContext(instance, request),
      receivedAt: new Date().toISOString(),
    };
    this.registerToolCallEscalation(instance, {
      escalation,
      owner: sessionRef,
      settle: (decision) => {
        const session = sessionRef.current;
        if (!session) return;
        const options =
          decision.whitelistSelection !== undefined ? { whitelistSelection: decision.whitelistSelection } : {};
        session.resolveEscalation(escalation.escalationId, decision.decision, options).catch((err: unknown) => {
          // The coordinator may already have expired the request file;
          // the session reports that as an expiry, nothing else to do.
          writeStderr(`[workflow] resolveEscalation(${escalation.escalationId}) failed: ${toErrorMessage(err)}`);
        });
      },
    });
  }

  /**
   * The reviewer context of a workflow tool-call escalation: the human's
   * last message and the agent's justification as the pipeline attached
   * them, and the workflow's task (the human's own text) as the task
   * summary. A state's prompt is system-generated, so a session's own task
   * summary never stands in for the workflow's.
   */
  private escalationReviewContext(
    instance: WorkflowInstance,
    source: Pick<EscalationRequest, 'lastTrustedUserMessage' | 'agentJustification'>,
  ): Pick<WorkflowToolCallEscalation, 'lastTrustedUserMessage' | 'taskSummary' | 'agentJustification'> {
    const { context } = instance.actor.getSnapshot() as { context: WorkflowContext };
    const task = typeof context.taskDescription === 'string' ? context.taskDescription.trim() : '';
    return {
      ...(source.lastTrustedUserMessage !== undefined ? { lastTrustedUserMessage: source.lastTrustedUserMessage } : {}),
      ...(task !== '' ? { taskSummary: boundReviewerText(task, MAX_REVIEWER_CONTEXT_CHARS) } : {}),
      ...(source.agentJustification !== undefined ? { agentJustification: source.agentJustification } : {}),
    };
  }

  private registerToolCallEscalation(instance: WorkflowInstance, pending: PendingToolCallEscalation): void {
    const { escalation } = pending;
    instance.pendingEscalations.set(escalation.escalationId, pending);
    // The reason can quote agent-chosen values (a git remote); the tab is a
    // terminal in CLI runs.
    instance.tab.write(
      `[escalation] ${toDisplayText(`${escalation.serverName}/${escalation.toolName}`)}: ${toDisplayText(escalation.reason, { maxLength: 300 })} (id ${escalation.escalationId})`,
    );
    instance.messageLog.append({
      ...this.logBase(instance),
      type: 'tool_call_escalation',
      escalationId: escalation.escalationId,
      serverName: escalation.serverName,
      toolName: escalation.toolName,
      reason: escalation.reason,
      outcome: 'raised',
    });
    this.emitLifecycleEvent({ kind: 'tool_call_escalation_raised', workflowId: instance.id, escalation });
  }

  private recordToolCallEscalationOutcome(
    instance: WorkflowInstance,
    escalation: WorkflowToolCallEscalation,
    outcome: WorkflowToolCallEscalationOutcome,
  ): void {
    instance.tab.write(`[escalation ${outcome}] ${toDisplayText(`${escalation.serverName}/${escalation.toolName}`)}`);
    instance.messageLog.append({
      ...this.logBase(instance),
      type: 'tool_call_escalation',
      escalationId: escalation.escalationId,
      serverName: escalation.serverName,
      toolName: escalation.toolName,
      reason: escalation.reason,
      outcome,
    });
    this.emitLifecycleEvent({
      kind: 'tool_call_escalation_resolved',
      workflowId: instance.id,
      escalationId: escalation.escalationId,
      outcome,
    });
  }

  /**
   * Ends one pending escalation without a decision (escalation timeout,
   * coordinator cancellation, end of the turn or session that raised it,
   * workflow abort). A coordinator escalation that is still being waited
   * for is withdrawn with `detail`. No-op when it is no longer pending.
   */
  private expireToolCallEscalation(instance: WorkflowInstance, escalationId: string, detail: string): void {
    const pending = instance.pendingEscalations.get(escalationId);
    if (!pending) return;
    instance.pendingEscalations.delete(escalationId);
    pending.withdraw?.(detail);
    this.recordToolCallEscalationOutcome(instance, pending.escalation, 'expired');
  }

  private expireToolCallEscalationsWhere(
    instance: WorkflowInstance,
    detail: string,
    predicate: (pending: PendingToolCallEscalation) => boolean,
  ): void {
    for (const pending of [...instance.pendingEscalations.values()]) {
      if (predicate(pending)) this.expireToolCallEscalation(instance, pending.escalation.escalationId, detail);
    }
  }

  /**
   * Withdraws the escalations a bundle's coordinator raised once no agent
   * turn is live on that bundle: the turn that raised them ended (finished,
   * timed out, crashed or was drained) and its call can no longer be
   * answered to anyone. Leaving them pending would let a late approval run
   * the side effect during a later state, possibly under the same persona
   * (no policy swap, so nothing else would cancel it).
   */
  private withdrawIdleBundleEscalations(instance: WorkflowInstance, bundleId: string): void {
    if (instance.liveAgentTurnsByBundle.has(bundleId)) return;
    this.expireToolCallEscalationsWhere(
      instance,
      'the agent turn that raised it has ended',
      (pending) => pending.bundleId === bundleId,
    );
  }

  /**
   * The session reports a decision made through another route (its own
   * transport, Signal). Our `resolveToolCallEscalation` path removes the
   * entry first, so this only records decisions we did not make.
   */
  private noteSessionEscalationResolved(
    instance: WorkflowInstance,
    escalationId: string,
    decision: 'approved' | 'denied',
  ): void {
    const pending = instance.pendingEscalations.get(escalationId);
    if (!pending) return;
    instance.pendingEscalations.delete(escalationId);
    this.recordToolCallEscalationOutcome(instance, pending.escalation, decision);
  }

  async abort(id: WorkflowId, options: WorkflowStopOptions = {}): Promise<void> {
    const instance = this.workflows.get(id);
    if (!instance) return;

    if (
      instance.finalStatus?.phase === 'completed' ||
      instance.finalStatus?.phase === 'aborted' ||
      instance.finalStatus?.phase === 'failed'
    ) {
      // A terminal transition is already in flight: a natural completion, or
      // another abort (a user abort that a shutdown overtakes). Join it rather
      // than starting a second one or returning while it is still committing
      // its snapshot: a caller that then tears the run down or exits (as
      // `shutdownAll()` and the daemon do) would cut it short.
      // `teardownPromise` covers a terminal claimed outside both paths. The
      // first stop reports its own failure; joining only waits for it.
      await (instance.terminalHandling ?? instance.teardownPromise)?.catch(() => {});
      return;
    }

    const reason = options.reason ?? DEFAULT_WORKFLOW_ABORT_REASON;

    // Claim the terminal synchronously, BEFORE the first await below, so a
    // natural completion firing during session close sees `finalStatus` set
    // and bails at its own guard. This is the single-flight gate that
    // guarantees exactly-once snapshot + teardown across abort/complete.
    const finalStatus: Extract<WorkflowStatus, { phase: 'aborted' }> = { phase: 'aborted', reason };
    instance.finalStatus = finalStatus;
    this.clearGateIdleTimer(instance);

    // Stop everything in flight, still before the first await: work that is
    // suspended in an await (a session being created, a bundle being minted,
    // a turn, a fan-out lane) observes the signal when it resumes, closes
    // what it just created and starts nothing new, and a running host
    // deterministic command is killed now rather than after the sessions
    // close below (its result would be discarded anyway). Fan-out lanes are
    // free-standing root actors, so they are stopped explicitly; stopping the
    // run's own actor aborts its in-flight invoke and means no transition (a
    // gate raise, a next state) can follow the abort.
    instance.stopController.abort();
    for (const lane of [...instance.fanOutChildren]) lane.stop();
    instance.actor.stop();
    // Stop the active-time clock (after the actor, whose last snapshot must
    // not restart it): the time from here to a resume is not running time.
    // The meter keeps counting a still-pending session's spend live, so the
    // terminal checkpoint written by finishAbort includes it.
    instance.usage.setRunning(false);

    // Nobody can answer an escalation of an aborted run: withdraw every
    // pending one (each call is denied as cancelled) in the same tick that
    // claimed the terminal status, before any await below lets a decision
    // in. `resolveToolCallEscalation` refuses from here on, and the sweep
    // after the session closes (finishAbort) catches anything surfaced
    // meanwhile.
    this.expireToolCallEscalationsWhere(instance, 'the workflow was aborted', () => true);

    instance.terminalHandling = this.finishAbort(instance, finalStatus, options);
    await instance.terminalHandling;
  }

  /**
   * The rest of {@link abort} once the run's terminal is claimed and its work
   * told to stop: close the sessions, withdraw what they surfaced meanwhile,
   * snapshot, write the terminal checkpoint, tear down and release the locks.
   */
  private async finishAbort(
    instance: WorkflowInstance,
    finalStatus: Extract<WorkflowStatus, { phase: 'aborted' }>,
    options: WorkflowStopOptions,
  ): Promise<void> {
    const { id } = instance;
    const { reason } = finalStatus;
    let previousCheckpoint: WorkflowCheckpoint | undefined;
    try {
      previousCheckpoint = this.deps.checkpointStore.load(id);
    } catch (err) {
      writeStderr(`[workflow] Failed to load existing checkpoint during abort for ${id}: ${toErrorMessage(err)}`);
    }
    // A forced shutdown may interrupt an owned session close or snapshot
    // commit. Keep the earlier restore images, and mark its usage incomplete
    // before either await so resume cannot mistake that subtotal for final.
    this.saveTerminalCheckpoint(instance, finalStatus, instance.containerSnapshots, previousCheckpoint, true);
    // A cancelled invocation may never reach its own finally. Retain the
    // selected session's last display sample before joined closes remove it.
    const budgetSession = instance.activeSessions.values().next().value;
    instance.resourceBudget = persistedWorkflowBudget(this.getInstanceBudget(instance));
    await Promise.allSettled(
      [...instance.activeSessions].map((session) => this.closeWorkflowSession(instance, session)),
    );
    // The closed sessions' environments are gone: return their agent slots
    // now rather than when their (possibly stuck) invocations unwind.
    for (const lease of instance.sessionSlots.values()) lease.release();
    instance.sessionSlots.clear();
    this.expireToolCallEscalationsWhere(instance, 'the workflow was aborted', () => true);
    // Prefer its settled reading, retaining the last good sample if the
    // closed session no longer exposes status. Run-wide accounting is sampled
    // independently by closeWorkflowSession and the bundle teardown below.
    if (budgetSession !== undefined) {
      try {
        instance.resourceBudget = {
          ...instance.resourceBudget,
          usage: workflowBudgetUsage(budgetSession.getBudgetStatus()),
        };
      } catch {
        // The pre-close display sample remains available.
      }
    }
    instance.activeSessions.clear();

    // This leg's restore snapshots, before a saved terminal checkpoint replaces them.
    const restoredSnapshots = instance.containerSnapshots;
    const containerSnapshots = await this.snapshotResumableScopes(instance, options.snapshotBudgetMs);
    const saved = this.saveTerminalCheckpoint(instance, finalStatus, containerSnapshots, previousCheckpoint, true);
    // Tear down workflow-scoped Docker infrastructure after all sessions
    // are closed. Error-tolerant (see destroyWorkflowInfrastructure).
    // Superseded snapshots go only once the checkpoint replacing them is on
    // disk: after a failed save, the one there still references them.
    const snapshotsToRemove = saved
      ? this.snapshotsSupersededBy(previousCheckpoint?.containerSnapshots, restoredSnapshots, containerSnapshots)
      : undefined;
    const cleanupDocker = snapshotsToRemove ? await this.dockerForSnapshotCleanup(instance) : undefined;
    await this.destroyWorkflowInfrastructure(instance);
    // Proxy teardown settles exchanges that were still in flight. Persist
    // those final charges before releasing the run's subscription and locks.
    this.saveTerminalCheckpoint(instance, finalStatus, containerSnapshots, previousCheckpoint);
    this.appendTerminalControl(instance);
    this.teardownUsageSubscription(instance);
    if (cleanupDocker) {
      await this.removeSnapshotImagesAfterTeardown(instance, cleanupDocker, snapshotsToRemove);
    }

    // Intentionally leave the checkpoint in place: a user-triggered abort
    // should remain resumable via `workflow resume`. The checkpoint is only
    // removed on successful completion (see handleWorkflowComplete).

    instance.tab.write(`[aborted] ${reason}`);
    instance.tab.close();
    this.markTerminalReady(instance);

    this.emitLifecycleEvent({
      kind: 'failed',
      workflowId: id,
      error: reason,
      phase: 'aborted',
    });
  }

  onEvent(callback: (event: WorkflowLifecycleEvent) => void): void {
    this.lifecycleCallbacks.push(callback);
  }

  /** Joins session teardown, keeping it visible to abort until its last usage sample. */
  private closeWorkflowSession(instance: WorkflowInstance, session: Session): Promise<void> {
    const existing = instance.sessionClosures.get(session);
    if (existing !== undefined) return existing;
    instance.usage.sessionEnded(session);
    const closing = (async () => {
      try {
        await session.close();
      } catch (err) {
        writeStderr(`[workflow] session.close() failed for ${instance.id}: ${toErrorMessage(err)}`);
      } finally {
        instance.usage.sessionClosed(session);
        instance.activeSessions.delete(session);
        const slot = instance.sessionSlots.get(session);
        instance.sessionSlots.delete(session);
        slot?.release();
      }
    })();
    instance.sessionClosures.set(session, closing);
    return closing;
  }

  async shutdownAll(options: WorkflowStopOptions = {}): Promise<void> {
    // Final: a start or resume that races the shutdown (a web request in
    // flight, a CLI command) is refused rather than left running after the
    // id list below was taken.
    this.shuttingDown = true;
    const ids = [...this.workflows.keys()];
    // Abort runs full teardown (including destroyWorkflowInfrastructure) for
    // workflows not yet in a terminal state. For a workflow whose terminal
    // handling is already in flight (a user abort, a completion still
    // snapshotting), abort() joins it, so the destroy pass below never runs
    // under its snapshot commit. For other already-terminal workflows abort()
    // early-returns, so we follow up with an explicit destroy pass to defend
    // against any case where a terminal transition skipped infra teardown
    // (e.g., tests forcing finalStatus directly). The destroy call is
    // idempotent when instance.bundlesByScope is empty.
    await Promise.allSettled(ids.map((id) => this.abort(id, options)));
    await Promise.allSettled(
      ids.map((id) => {
        const instance = this.workflows.get(id);
        return instance ? this.destroyWorkflowInfrastructure(instance) : Promise.resolve();
      }),
    );
    // Drain any fire-and-forget teardown started by `handleWorkflowComplete`
    // on a normal terminal. Because `destroyWorkflowInfrastructure`
    // snapshot-and-clears `bundlesByScope` up front, the explicit pass above
    // no-ops for an already-completed workflow whose teardown is still in
    // flight — so we must await the stored promise to guarantee the Docker
    // network/container removal has actually finished before the caller (the
    // CLI) calls process.exit().
    await Promise.allSettled(ids.map((id) => this.workflows.get(id)?.teardownPromise ?? Promise.resolve()));
  }

  // -----------------------------------------------------------------------
  // Actor setup helpers
  // -----------------------------------------------------------------------

  /**
   * Injects concrete service implementations into the machine: `agentService`
   * and `deterministicService` for executable states, plus `fanOutService` —
   * the invoke body of a `workers` fan-out state, which runs
   * {@link runFanOutSegment} and is re-provided onto each child round machine
   * (the children reuse the same agent/deterministic actors, lane-scoped via
   * input).
   */
  private provideActors(
    machine: AnyStateMachine,
    workflowId: WorkflowId,
    definition: WorkflowDefinition,
    roundMachinesByState: ReadonlyMap<string, AnyStateMachine>,
  ): AnyStateMachine {
    // Every service checks the run-wide `settings.workflowBudget` before it
    // starts (assertWithinWorkflowBudget). Child round machines are provided
    // through here too, so each step of a fan-out lane is checked as well.
    // Barrier-internal deterministic work (sample_batch, cognition promotion,
    // stop signals) calls executeDeterministicState directly and is not
    // checked: it finishes a batch whose lanes already ran.
    return machine.provide({
      actors: {
        // `signal` aborts when the invoking actor is stopped — for a fan-out
        // lane, when the batch drains it; for any state, when abort() stops
        // the root actor. It detaches an agent invocation (see
        // executeAgentState) and kills a running deterministic command: a
        // host command's process group (see runDeterministicHost), a
        // container command's processes (see runDeterministicInContainer).
        // The run's own stop signal is consulted inside each executor as well.
        agentService: fromPromise<AgentInvokeResult, AgentInvokeInput>(async ({ input, signal }) => {
          try {
            return await this.invokeWithinWorkflowBudget(workflowId, input.stateId, () =>
              this.executeAgentState(workflowId, input, definition, signal),
            );
          } catch (err) {
            this.reportInvokeRejection(workflowId, 'agentService', input.stateId, err);
            throw err;
          }
        }),
        deterministicService: fromPromise<DeterministicInvokeResult, DeterministicInvokeInput>(
          async ({ input, signal }) => {
            try {
              return await this.invokeWithinWorkflowBudget(workflowId, input.stateId, () =>
                this.executeDeterministicState(workflowId, input, signal),
              );
            } catch (err) {
              this.reportInvokeRejection(workflowId, 'deterministicService', input.stateId, err);
              throw err;
            }
          },
        ),
        fanOutService: fromPromise<FanOutInvokeResult, FanOutInvokeInput>(async ({ input }) => {
          try {
            return await this.invokeWithinWorkflowBudget(workflowId, input.stateId, () =>
              this.runFanOutSegment(workflowId, input, definition, roundMachinesByState),
            );
          } catch (err) {
            this.reportInvokeRejection(workflowId, 'fanOutService', input.stateId, err);
            throw err;
          }
        }),
      },
    }) as AnyStateMachine;
  }

  /**
   * Logs a rejected invocation, except one rejected because its run is
   * stopping: an abort stops every executor on purpose, and its stopped actor
   * ignores the rejection.
   */
  private reportInvokeRejection(workflowId: WorkflowId, service: string, stateId: string, err: unknown): void {
    const instance = this.workflows.get(workflowId);
    if (instance && this.isStopping(instance)) return;
    writeStderr(`[workflow] ${service} invoke rejected for "${stateId}": ${toErrorMessage(err)}`);
  }

  /** Subscribes to actor snapshot changes for lifecycle events, gates, and checkpointing. */
  private subscribeToActor(instance: WorkflowInstance): void {
    const { actor, gateStateNames, definition, id: workflowId } = instance;
    // The current state's visit count as last seen. A transition back onto the
    // same state re-enters it (`reenter: true`, see machine-builder.ts) without
    // changing the state value; for an agent state the entry's visit count
    // (`incrementVisitCount`) is what shows the new visit.
    let lastVisits = visitCountOf(actor.getSnapshot() as { context: unknown }, instance.currentState);

    actor.subscribe((rawSnapshot: unknown) => {
      const snapshot = rawSnapshot as {
        value: unknown;
        context: WorkflowContext;
        status: string;
        matches: (state: string) => boolean;
      };
      const stateValue = String(snapshot.value);
      const previousState = instance.currentState;
      const now = Date.now();
      // Active time runs while the run is in an agent, deterministic or
      // fan-out state; a gate, a terminal or a stopped actor stops the clock.
      // Updated before the checkpoint below so it records the time up to
      // this transition.
      const enteredState = definition.states[stateValue] as WorkflowDefinition['states'][string] | undefined;
      instance.usage.setRunning(
        snapshot.status === 'active' && enteredState !== undefined && isExecutableState(enteredState),
        now,
      );
      const visits = visitCountOf(snapshot, stateValue);
      const reentered = stateValue === previousState && visits !== lastVisits;
      lastVisits = visits;

      // Record transition and checkpoint only on actual state changes, a
      // state re-entering itself included (each loop iteration is resumable).
      if (stateValue !== previousState || reentered) {
        this.recordTransition(instance, snapshot, previousState, stateValue, now);
      } else if (definition.states[stateValue].type === 'human_gate' && instance.activeGateId === undefined) {
        // At a gate with no raise in effect and no state change: the workflow
        // starts at a gate, or a decision's transition targets the gate it was
        // made at. Either way this is a new raise. Mint its id and persist it,
        // so a restart re-raises under this id and never under the one just
        // resolved (still in the last checkpoint).
        instance.activeGateId = this.mintGateIdFor(instance, stateValue);
        this.saveCheckpoint(instance, snapshot);
      }

      instance.currentState = stateValue;
      instance.tab.write(`[state] ${stateValue}`);

      // Surface errors from invoke failures (storeError action sets lastError)
      const ctx = snapshot.context;
      if (ctx.lastError && ctx.lastError !== instance.lastSurfacedError) {
        instance.lastSurfacedError = ctx.lastError;
        writeStderr(`[workflow] Error in context after state "${stateValue}": ${ctx.lastError}`);
        instance.tab.write(`[error] Agent invoke failed: ${ctx.lastError}`);
        this.emitLifecycleEvent({
          kind: 'failed',
          workflowId,
          error: `Agent "${previousState}" failed: ${ctx.lastError}`,
        });
      } else if (!ctx.lastError && instance.lastSurfacedError) {
        instance.lastSurfacedError = undefined;
      }

      for (const gateName of gateStateNames) {
        if (snapshot.matches(gateName)) {
          const stateDef = definition.states[gateName];
          if (stateDef.type === 'human_gate') {
            this.handleGateEntry(workflowId, gateName, stateDef);
          }
          break;
        }
      }

      this.emitLifecycleEvent({
        kind: 'state_entered',
        workflowId,
        state: stateValue,
      });

      // Check for terminal states
      if (snapshot.status === 'done') {
        this.handleWorkflowComplete(workflowId, snapshot.context).catch((err: unknown) => {
          writeStderr(`[workflow] terminal handling failed for ${workflowId}: ${toErrorMessage(err)}`);
        });
      }
    });
  }

  /**
   * Records one transition (`from` may equal `to`: a state re-entering
   * itself) in the transition history and the message log, and checkpoints
   * it unless it entered a terminal state.
   */
  private recordTransition(
    instance: WorkflowInstance,
    snapshot: { value: unknown; context: WorkflowContext },
    from: string,
    to: string,
    now: number,
  ): void {
    const { definition } = instance;
    const duration = instance.stateEnteredAt ? now - instance.stateEnteredAt : 0;

    const stateType = definition.states[from].type;
    let agentMessage: string | undefined;
    if (stateType === 'human_gate') {
      agentMessage = truncateForTransition(snapshot.context.humanPrompt ?? snapshot.context.previousAgentOutput);
    } else if (stateType === 'agent') {
      agentMessage = truncateForTransition(snapshot.context.previousAgentOutput);
    }
    // deterministic and terminal: no agentMessage (leave undefined)

    instance.transitionHistory.push({
      from,
      to,
      event: 'transition',
      timestamp: new Date(now).toISOString(),
      duration_ms: duration,
      agentMessage,
    });
    instance.stateEnteredAt = now;

    // Every entry into a gate state is a new raise with its own id. Mint
    // it here, ahead of the checkpoint below, so a resume from that
    // checkpoint re-raises the gate under the id deciders already saw.
    // Only a real transition mints: no-op snapshots and status polls
    // must not rotate the id out from under a pending decision.
    if (definition.states[to].type === 'human_gate') {
      instance.activeGateId = this.mintGateIdFor(instance, to);
    }

    // Skip checkpointing transitions into terminal states. On successful
    // completion `handleWorkflowComplete` removes the checkpoint anyway;
    // on abort we want the surviving checkpoint to point at the last
    // non-terminal state so `resume()` can restart the run meaningfully.
    if (!this.isTerminalStateValue(definition, to)) {
      this.saveCheckpoint(instance, snapshot);
    }

    instance.messageLog.append({
      ...this.logBase(instance),
      type: 'state_transition',
      from,
      event: to,
    });
  }

  // -----------------------------------------------------------------------
  // Checkpointing
  // -----------------------------------------------------------------------

  /**
   * Returns true if `stateValue` names a terminal state in the workflow
   * definition. Used to skip checkpointing on the final transition so the
   * last on-disk checkpoint points at the last non-terminal state (important
   * for resume-after-abort, which would otherwise reload an `aborted`
   * snapshot and immediately re-terminate).
   */
  private isTerminalStateValue(definition: WorkflowDefinition, stateValue: string): boolean {
    return definition.states[stateValue].type === 'terminal';
  }

  // `waiting_human` would smuggle a ReadonlyMap (gate.presentedArtifacts) into
  // JSON.stringify, which silently emits `{}`. handleWorkflowComplete only
  // assigns terminal completed/aborted/failed statuses, so the cycle is safe.
  private buildCheckpoint(
    instance: WorkflowInstance,
    snapshot: { value: unknown; context: unknown },
    finalStatus?: WorkflowStatus,
    containerSnapshots?: Readonly<Record<string, ContainerSnapshotRef>>,
  ): WorkflowCheckpoint {
    const usage = instance.usage.snapshot();
    return {
      // Paths below this directory (the default workspace, the staged
      // skills and scripts) are rebased onto wherever the run directory is
      // found on resume (see `rebaseRunLocalPaths`).
      runDir: this.runDirOf(instance.id),
      machineState: snapshot.value,
      // Saved once each: the per-session budget record, and the run-wide
      // usage resume continues from (also the source of past-run displays).
      resourceBudget: persistedWorkflowBudget(this.getInstanceBudget(instance, usage)),
      usage,
      context: snapshot.context as WorkflowContext,
      timestamp: new Date().toISOString(),
      transitionHistory: [...instance.transitionHistory],
      definitionPath: instance.definitionPath,
      workspacePath: instance.workspacePath,
      // Persisted so resume can read the run-dir staged copy directly
      // instead of recomputing from the (possibly moved/deleted)
      // package path. Skipped when the workflow shipped no skills, to
      // keep the checkpoint shape tight for the common case.
      ...(instance.workflowSkillsDir !== undefined ? { workflowSkillsDir: instance.workflowSkillsDir } : {}),
      ...(instance.workflowScriptsDir !== undefined ? { workflowScriptsDir: instance.workflowScriptsDir } : {}),
      // A resumed task-scoped run keeps its task scope.
      ...(instance.taskPolicyDir !== undefined ? { taskPolicyDir: instance.taskPolicyDir } : {}),
      ...(containerSnapshots !== undefined && Object.keys(containerSnapshots).length > 0 ? { containerSnapshots } : {}),
      ...(finalStatus !== undefined ? { finalStatus } : {}),
      // Persisted so a resume at a gate keeps the per-raise id a decider may
      // already hold (see `WorkflowCheckpoint.activeGateId`).
      ...(instance.activeGateId !== undefined ? { activeGateId: instance.activeGateId } : {}),
    };
  }

  /**
   * Saves a non-terminal checkpoint. It records the scopes' restore snapshots
   * (`instance.containerSnapshots`): a transition must not drop them, or a
   * crash after it would resume the scopes from fresh containers and the next
   * stop would not find them on disk to remove as superseded.
   */
  private saveCheckpoint(instance: WorkflowInstance, snapshot: { value: unknown; context: unknown }): void {
    const checkpoint = this.buildCheckpoint(instance, snapshot, undefined, instance.containerSnapshots);
    try {
      this.deps.checkpointStore.save(instance.id, checkpoint);
    } catch (err) {
      this.reportCheckpointSaveFailure(instance, 'checkpoint', err);
      return;
    }
    this.reportCheckpointSaveRecovered(instance);
  }

  /**
   * Makes a failed checkpoint save visible beyond stderr. The run continues
   * (the previous checkpoint is still on disk, and stopping a healthy run
   * over a full disk would lose more), but a later resume restarts from that
   * older point, so the failure goes to the workflow tab and the message log
   * too: on the first failure of a streak and then whenever the streak
   * doubles (2, 4, 8, ...), which keeps a persistent failure loud without
   * flooding the log on every transition.
   */
  private reportCheckpointSaveFailure(instance: WorkflowInstance, what: string, err: unknown): void {
    const failures = (instance.checkpointSaveFailures ?? 0) + 1;
    instance.checkpointSaveFailures = failures;
    const message = `Failed to save ${what} for ${instance.id}: ${toErrorMessage(err)}`;
    writeStderr(`[workflow] ${message}`);
    if ((failures & (failures - 1)) !== 0) return;
    const streak =
      failures === 1
        ? 'a resume would restart from the last saved checkpoint'
        : `${failures} saves in a row have failed; a resume would restart from the last saved checkpoint`;
    instance.tab.write(`[warning] ${message} (${streak})`);
    try {
      instance.messageLog.append({
        ...this.logBase(instance),
        type: 'error',
        error: `${message} (${streak})`,
        context: CHECKPOINT_SAVE_ERROR_CONTEXT,
      });
    } catch {
      // The log lives on the same filesystem; when it is full or gone too,
      // stderr and the tab above are all that is left.
    }
  }

  /** Clears a failure streak once a save succeeds again, and says so. */
  private reportCheckpointSaveRecovered(instance: WorkflowInstance): void {
    const failures = instance.checkpointSaveFailures ?? 0;
    if (failures === 0) return;
    instance.checkpointSaveFailures = 0;
    const message = `Checkpoint saves for ${instance.id} succeed again after ${failures} failure(s)`;
    writeStderr(`[workflow] ${message}`);
    instance.tab.write(`[info] ${message}`);
  }

  // -----------------------------------------------------------------------
  // Agent state execution
  // -----------------------------------------------------------------------

  /**
   * Runs one agent-state invocation ({@link runAgentState}) and, in
   * shared-container mode, keeps it registered as a live turn on its bundle
   * until it has fully finished — session closed included — so a policy swap
   * to another persona waits for it (see {@link waitForOtherPersonaTurns}).
   *
   * `signal` is the invoking actor's abort signal. It aborts when that actor
   * is stopped, which for a fan-out lane means the batch drained it: the
   * lane already settled as `drained` and nothing will read this
   * invocation's result. A detached invocation therefore starts no session
   * and no further turn, and does not stamp the run as quota-exhausted or
   * transiently failed. Absent on the resume replay path.
   *
   * The run's own stop signal (`instance.stopController`, see `abort()`)
   * detaches the invocation the same way, on every path including the
   * replay one, and is re-checked after every await: a session that
   * `createSession` hands back after the abort is closed at once, and a turn
   * that returns after it is not processed.
   */
  private async executeAgentState(
    workflowId: WorkflowId,
    input: AgentInvokeInput,
    definition: WorkflowDefinition,
    signal?: AbortSignal,
  ): Promise<AgentInvokeResult> {
    const liveTurn: { release?: () => void; bundleId?: string } = {};
    try {
      return await this.runAgentState(workflowId, input, definition, signal, liveTurn);
    } finally {
      liveTurn.release?.();
      // Escalations raised by this turn's tool calls cannot be answered to
      // anyone once the last live turn on the bundle is gone.
      const instance = this.workflows.get(workflowId);
      if (instance && liveTurn.bundleId !== undefined) {
        this.withdrawIdleBundleEscalations(instance, liveTurn.bundleId);
      }
    }
  }

  // TODO(refactor): this method is ~230 lines and carries three
  // invocation-scoped closures (`logReceived`, `logAgentRetry`,
  // `sendAgentTurn`) that all capture the same bundle of state —
  // `session`, `instance`, `stateConfig`, `stateId`, `messageLog`, and
  // `this`. The closure pattern is idiomatic here only because every
  // alternative (methods, helpers) would propagate that bundle through
  // 5–6 parameters per site.
  //
  // The right fix is to extract the whole turn-handling pipeline
  // (send/parse/retry/reprompt + the three log helpers) into a
  // dedicated class — e.g. `AgentTurnRunner` — constructed once per
  // invocation with the shared state injected. That shrinks this
  // method from ~230 lines to ~80, and makes turn handling
  // unit-testable in isolation (today it is reachable only through
  // end-to-end workflow tests). Pair the extraction with a review of
  // `AgentInvocationError` wrapping so the conversation-id recovery
  // semantics survive the move. Worth doing as its own PR; do NOT
  // fold it into a feature change.
  private async runAgentState(
    workflowId: WorkflowId,
    input: AgentInvokeInput,
    definition: WorkflowDefinition,
    signal: AbortSignal | undefined,
    liveTurn: { release?: () => void; bundleId?: string },
  ): Promise<AgentInvokeResult> {
    const { stateId, stateConfig, context } = input;
    const instance = this.workflows.get(workflowId);
    if (!instance) throw new Error(`Workflow ${workflowId} not found`);

    // See executeAgentState: a drained fan-out lane's invocation is detached,
    // and so is every invocation of a run that is stopping.
    const runStopping = (): boolean => this.isStopping(instance);
    const detached = (): boolean => runStopping() || signal?.aborted === true;
    const throwIfDetached = (): void => {
      this.throwIfStopping(instance, `agent state "${stateId}"`);
      if (signal?.aborted === true) {
        throw new Error(`Agent state "${stateId}" was drained with its fan-out batch; not starting another turn`);
      }
    };

    // Nothing, not even the artifact versioning below, touches the workspace
    // once the run is stopping.
    throwIfDetached();

    const settings = definition.settings ?? {};

    // Version artifact directories before re-entering a state
    const visitCount = context.visitCounts[stateId] ?? 0;
    if (visitCount > 1) {
      const unversioned = new Set(settings.unversionedArtifacts ?? []);
      snapshotArtifacts(instance.artifactDir, stateConfig.outputs, visitCount, unversioned, instance.workspacePath);
    }

    // A read-only state (`workspaceAccess: read-only`) may write only its
    // output directories, through the filesystem MCP tool: make them real
    // directories now. Its own session gets the read-only workspace below; in
    // shared-container mode the scope's bundle was (or will be) minted with it.
    const readOnlyWorkspace = readOnlyWorkspaceForState(stateConfig);
    if (readOnlyWorkspace) this.prepareReadOnlyOutputs(instance, readOnlyWorkspace);

    instance.tab.write(`[agent] Starting "${stateId}" (persona: ${stateConfig.persona})`);

    // The state's own harness (`dockerAgent`), else the workflow's. In
    // shared-container mode this is also the harness its scope's bundle is
    // minted for: every agent state of a scope resolves to the same one
    // (validation; `ensureBundleForScope` refuses to mint a mixed scope).
    const mode: SessionMode =
      settings.mode === 'builtin'
        ? { kind: 'builtin' }
        : { kind: 'docker', agent: toAgentId(resolveStateDockerAgent(stateConfig, settings)) };

    const effectiveModel = stateConfig.model ?? settings.model;

    // Shared-container mode only: resolve (or lazily mint) the bundle
    // for this state's scope, rotate the coordinator's audit stream, and
    // swap policy before constructing the borrowing session. In
    // per-state-container mode the new session builds its own
    // coordinator, so there is nothing to cycle.
    //
    // Scope lookup algorithm (docs/designs/workflow-session-identity.md §3):
    //   1. scope := stateConfig.containerScope ?? "primary"
    //   2. bundle := instance.bundlesByScope.get(scope)
    //   3. if absent: lazy-mint via ensureBundleForScope(instance, scope)
    //   4. borrow bundle via SessionOptions.workflow.infrastructure
    let bundle: DockerInfrastructure | undefined;
    if (this.shouldUseSharedContainer(definition)) {
      const scope = stateConfig.containerScope ?? DEFAULT_CONTAINER_SCOPE;
      try {
        bundle = await this.ensureBundleForScope(instance, scope);
      } catch (err) {
        // A mint refused or undone by an abort is not an infrastructure
        // failure; the stopped run must not log one after its terminal marker.
        if (!runStopping()) {
          const errMsg = toErrorMessage(err);
          writeStderr(`[workflow] ensureBundleForScope failed for "${stateId}" (scope=${scope}): ${errMsg}`);
          instance.tab.write(`[error] Infrastructure setup failed for "${stateId}": ${errMsg}`);
          instance.messageLog.append({
            ...this.logBase(instance),
            type: 'error',
            error: errMsg,
            context: `ensureBundleForScope "${stateId}" (scope: ${scope})`,
          });
        }
        throw err;
      }

      // Fail closed: a read-only state never runs in a bundle that was not
      // built read-only (a factory that ignored the scope's access).
      if (readOnlyWorkspace && bundle.readOnlyWorkspace === undefined) {
        throw new Error(
          `Agent state "${stateId}" is read-only but the bundle for scope "${scope}" was not built with a read-only workspace`,
        );
      }

      // Register as live BEFORE the detach check and the policy cycle, in
      // the same synchronous run: either this lane was already drained (it
      // bails out below without touching the coordinator), or any later swap
      // to another persona sees this invocation and waits for it to finish.
      // executeAgentState releases the registration once the session closed.
      liveTurn.release = this.registerLiveAgentTurn(instance, bundle.bundleId, stateConfig.persona);
      liveTurn.bundleId = bundle.bundleId;
      throwIfDetached();

      try {
        await this.cyclePolicy(instance, stateConfig.persona, bundle);
      } catch (err) {
        if (!runStopping()) {
          const errMsg = toErrorMessage(err);
          writeStderr(`[workflow] cyclePolicy failed for "${stateId}": ${errMsg}`);
          instance.tab.write(`[error] Policy cycle failed for "${stateId}": ${errMsg}`);
          instance.messageLog.append({
            ...this.logBase(instance),
            type: 'error',
            error: errMsg,
            context: `cyclePolicy for "${stateId}" (persona: ${stateConfig.persona})`,
          });
        }
        throw err;
      }
      throwIfDetached();
    }

    // Agent-CLI conversation identity for this invocation. Decision table
    // (docs/designs/workflow-session-identity.md §3):
    //   - freshSession:false AND prior entry in agentConversationsByState -> reuse
    //   - otherwise -> mint fresh via createAgentConversationId()
    // The Docker session decides between starting and resuming the
    // conversation by probing for it (`findStoredConversation`: Claude Code's
    // `<agentConversationId>.jsonl`, or the host record of the Codex thread /
    // Goose session); a minted-fresh id has none, a reused one does.
    const priorConversationId =
      stateConfig.freshSession === false ? context.agentConversationsByState[stateId] : undefined;
    const agentConversationId: AgentConversationId = priorConversationId ?? createAgentConversationId();
    // Mutable tracker updated by the hard-failure retry loop when the
    // session rotates its conversation id. The final value is what lands
    // in the invocation result / error and hence in the checkpoint's
    // `agentConversationsByState`, so a later `freshSession: false` visit
    // resumes the id whose transcript actually exists on disk.
    let currentConversationId: AgentConversationId = agentConversationId;

    // In borrow mode, route this invocation's per-state artifacts
    // (session.log, session-metadata.json) under a slug-keyed directory
    // inside the workflow run. The slug is the next available `.N` in
    // the bundle's states dir, so true logical re-visits AND resume legs
    // both get their own dir — never appending into a prior leg's logs.
    let stateSlug: string | undefined;
    let workflowStateDir: string | undefined;
    if (bundle) {
      // Thread lane.id into the slug so N same-state fan-out lanes each get a
      // distinct `{stateId}_lane_{id}.{N}` diagnostics dir. nextStateSlug is
      // check-then-act, so N concurrent lanes sharing one `stateId` would
      // otherwise compute the same slug and clobber each other's session.log /
      // session-metadata.json (§5.4 — the one diagnostics-dir collision).
      stateSlug = nextStateSlug(getBundleStatesDir(instance.id, bundle.bundleId), stateId, context.lane?.id);
      workflowStateDir = getInvocationDir(instance.id, bundle.bundleId, stateSlug);
      mkdirSync(workflowStateDir, { recursive: true });
    }

    // Read the cached per-run staged path; never recompute from
    // `instance.definitionPath` here. Computing it per-state would
    // re-introduce the resume-fragility bug fixed by staging at start.
    const workflowSkillsDir = instance.workflowSkillsDir;
    if (
      workflowSkillsDir !== undefined &&
      validatedWorkflowStagedDirectory(this.runDirOf(workflowId), workflowSkillsDir, 'skills') === undefined
    ) {
      throw new WorkflowResumeError('WORKFLOW_NOT_RESUMABLE', 'Invalid workflow-skills staging directory');
    }

    // The commit channel this invocation's agent reaches through its
    // coordinator's workflow_commit tool: the borrowed bundle's, or a
    // channel of its own that the session hands to the coordinator it
    // builds. Whether the coordinator really offers the tool is known once
    // the session exists (the channel is then attached).
    const sessionCommitChannel = bundle ? undefined : new WorkflowCommitChannel();
    const commitChannel = bundle ? instance.commitChannelsByBundle.get(bundle.bundleId) : sessionCommitChannel;

    // Workflow context for the session. Always emitted for workflow
    // runs (so the orchestrator's identity isn't ambiguous), even when
    // there's no bundle to borrow — `infrastructure` / `stateDir` /
    // `stateSlug` opt in only when shared-container mode applies.
    const workflowOptions = {
      workflowRunId: instance.id,
      stateId,
      personaId: stateConfig.persona,
      ...(bundle ? { infrastructure: bundle } : {}),
      ...(workflowStateDir ? { stateDir: workflowStateDir, stateSlug } : {}),
      ...(sessionCommitChannel ? { workflowCommit: sessionCommitChannel } : {}),
      ...resolveWorkflowSkillsOptions(stateConfig.skills, workflowSkillsDir),
      // A session that builds its own environment applies the state's
      // read-only workspace itself; a borrowed bundle already carries it.
      ...(readOnlyWorkspace && !bundle ? { readOnlyWorkspace } : {}),
    };

    throwIfDetached();
    // A session that brings its own environment (no shared bundle: a
    // per-state container, or a builtin sandbox) takes an agent slot for its
    // lifetime and waits here while the daemon-wide cap is reached. A
    // borrowed session runs in its bundle, whose slots the run already holds.
    let sessionSlot: AgentSlotLease | undefined;
    if (!bundle) {
      sessionSlot = await this.acquireSessionSlot(instance, stateId, signal);
      if (detached()) sessionSlot.release();
      throwIfDetached();
    }
    // Escalations this session surfaces through its file-IPC watcher
    // (builtin and per-state-container workflows, or a bundle without the
    // in-process hook) join the workflow's human route. The holder is
    // filled once the session exists; decisions reach the session lazily
    // through it.
    const sessionRef: { current?: Session } = {};
    let session: Session;
    try {
      session = await this.deps.createSession({
        persona: stateConfig.persona,
        mode,
        agentConversationId,
        workspacePath: instance.workspacePath,
        // Narrows this state's persona policy (a borrowed bundle's
        // coordinator already carries the same scope).
        ...(instance.taskPolicyDir !== undefined ? { taskPolicyDir: instance.taskPolicyDir } : {}),
        systemPromptAugmentation: definition.settings?.systemPrompt,
        // State model over workflow model; the factory puts `--model` above
        // both and buildSessionConfig the state persona's agentModelId below.
        ...(effectiveModel != null ? { agentModelOverride: effectiveModel } : {}),
        // The workflow's own limits override the state persona's
        // resourceBudget; the limits the run inherited sit below it.
        ...workflowSessionBudgetOptions(instance.resourceBudget),
        onEscalation: (request) =>
          this.handleSessionEscalation(instance, stateId, stateConfig.persona, sessionRef, request),
        onEscalationResolved: (escalationId, decision) =>
          this.noteSessionEscalationResolved(instance, escalationId, decision),
        // Only the escalation that expired: the session's others stay pending.
        onEscalationExpired: (escalationId) =>
          this.expireToolCallEscalationsWhere(
            instance,
            'the escalation expired',
            (p) => p.owner === sessionRef && p.escalation.escalationId === escalationId,
          ),
        // A stale policy, and setuid or root-owned files the agent left in
        // its host mounts (after turns; at the end for a state that owns its
        // container).
        onDiagnostic: (event) => this.reportSessionNotice(instance, event),
        // The nested record colocates the borrowed bundle, per-state
        // artifact dir, and workflow-bundled skills. `buildSessionConfig`
        // enforces the borrow-mode invariant (stateDir requires
        // infrastructure) at runtime.
        ...(Object.keys(workflowOptions).length > 0 ? { workflow: workflowOptions } : {}),
      });
      sessionRef.current = session;
    } catch (err) {
      sessionSlot?.release();
      if (!runStopping()) {
        const errMsg = toErrorMessage(err);
        writeStderr(`[workflow] Session creation failed for "${stateId}": ${errMsg}`);
        instance.tab.write(`[error] Session creation failed for "${stateId}": ${errMsg}`);
        instance.messageLog.append({
          ...this.logBase(instance),
          type: 'error',
          error: errMsg,
          context: `session creation for "${stateId}"`,
        });
      }
      throw new AgentInvocationError({ stateId, agentConversationId: currentConversationId, cause: err });
    }

    // The run may have been aborted (or this lane drained) while the session
    // was being created: abort() closed only the sessions that existed when it
    // ran, so this one is closed here, before it is registered or sent a turn.
    // Like the `finally` below, anything its watcher surfaced meanwhile can no
    // longer be answered.
    if (detached()) {
      await session.close().catch((closeErr: unknown) => {
        writeStderr(`[workflow] session.close() failed for "${stateId}": ${toErrorMessage(closeErr)}`);
      });
      // Its own environment is gone with it: return its agent slot.
      sessionSlot?.release();
      this.expireToolCallEscalationsWhere(instance, 'the agent session ended', (p) => p.owner === sessionRef);
      throwIfDetached();
    }

    instance.activeSessions.add(session);
    if (sessionSlot) instance.sessionSlots.set(session, sessionSlot);
    // Counted live from here (tokens from the metrics bus or the session,
    // cost from the session, and at least what its bundle's budget gate
    // charged) and settled in the finally block below. A borrowed session's
    // cost is part of the shared bundle's; any other Docker session owns its
    // bundle.
    instance.usage.sessionStarted(session, mode.kind, bundle?.bundleId);

    // The commit-tool protocol applies when the agent's coordinator offers
    // workflow_commit (its channel is attached): the invocation is opened
    // here and closed in the `finally` below, so a commit is accepted only
    // while this invocation runs. Otherwise the agent ends its final message
    // with the YAML status block, which is parsed instead. (`when` clauses
    // route on `verdict` only, see validate.ts, which a commit carries.)
    const validVerdicts = getValidVerdicts(stateConfig.transitions);
    const invocation: WorkflowCommitInvocation | undefined = commitChannel?.isAttached
      ? commitChannel.open({ stateId, ...(validVerdicts ? { validVerdicts } : {}) })
      : undefined;
    const commitPrompt: WorkflowCommitPrompt | undefined = invocation ? { invocationId: invocation.id } : undefined;
    // A resume replay re-runs the state from its start; every prompt that
    // opens a conversation for it (the first turn and a fresh replacement
    // after recovery exhaustion) carries the resume notice. Every prompt of
    // the invocation carries its commit protocol.
    const promptOptions: AgentPromptOptions = {
      resumeReplay: input.resumeReplay === true,
      ...(commitPrompt ? { commit: commitPrompt } : {}),
    };

    try {
      instance.tab.write(`[agent] Sending command to "${stateId}"...`);

      const { messageLog } = instance;
      const command = buildAgentCommand(stateId, stateConfig, context, definition, promptOptions);
      const statusInstructions = buildStatusInstructions(stateConfig.transitions, commitPrompt);

      const logReceived = (text: string, output: AgentOutput | undefined) => {
        messageLog.append({
          ...this.logBase(instance),
          type: 'agent_received',
          role: stateConfig.persona,
          message: text,
          verdict: output?.verdict ?? null,
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- logged for diagnostics
          confidence: output?.confidence ?? null,
        });
      };

      const logAgentRetry = (reason: AgentRetryReason, details: string, retryMessage: string) => {
        messageLog.append({
          ...this.logBase(instance),
          type: 'agent_retry',
          role: stateConfig.persona,
          reason,
          details,
          retryMessage,
        });
      };

      const rotateConversation = (): boolean => {
        const rotated = session.rotateAgentConversationId?.();
        if (!rotated) return false;
        currentConversationId = rotated;
        return true;
      };

      // Uniform agent-turn entrypoint: every prompt and reprompt must flow
      // through here so the quota-exhaustion / transient-failure
      // short-circuits apply to ALL of them. Retrying or reprompting a turn
      // whose adapter reported either signal would only burn more of the
      // already-exhausted budget (quota) or hammer a stalled upstream
      // (transient) — instead we log the structured event once and throw
      // a dedicated error so higher layers can distinguish "paused by
      // provider" / "stalled upstream" from "aborted by bug" (today all
      // three abort; M4 turns these into a `paused` terminal phase without
      // touching here).
      //
      // Sessions without `sendMessageDetailed` (e.g., built-in in-process
      // sessions) degrade cleanly to `sendMessage`, which cannot produce
      // either signal — the short-circuits simply never fire for them.
      //
      // A detached invocation (a drained fan-out lane) sends no further turn,
      // and a turn that was already in flight when it was drained does not
      // stamp the run: its lane already settled as `drained`, so the error
      // reaches no onError edge, and a stamp left behind would make a run
      // that later completes report `aborted` (handleWorkflowComplete).
      // A turn that returns after the run began stopping is not processed at
      // all: its terminal checkpoint is (being) written already.
      //
      // Every turn goes out as system-generated (WORKFLOW_AGENT_TURN): the
      // session then clears the auto-approver's trusted user context instead
      // of recording this prompt, which carries upstream agents' output.
      //
      // Commit-tool protocol: an upstream failure (quota or transient) that
      // ends a turn after the state committed through workflow_commit, with
      // every required output in place, lost only the end of that turn. The
      // commit stands, exactly as through a hard failure: the turn is
      // returned as one, which every caller below handles by keeping the
      // commit, rotating the conversation and never handing the failed
      // turn's text on. The structured log entry is still written; the run
      // is not stamped, since the state did not fail. Without a commit, or
      // with an output still missing (the turn that would produce it could
      // not run either), the run stops resumably as before.
      const commitSurvivesUpstreamFailure = (): boolean =>
        invocation?.committed() !== undefined && this.findMissingArtifacts(instance, stateConfig).length === 0;
      const sendAgentTurn = async (msg: string): Promise<AgentTurnResult> => {
        throwIfDetached();
        let result: AgentTurnResult;
        try {
          result = session.sendMessageDetailed
            ? await session.sendMessageDetailed(msg, WORKFLOW_AGENT_TURN)
            : { text: await session.sendMessage(msg, WORKFLOW_AGENT_TURN), hardFailure: false };
        } catch (err) {
          // A turn stopped at its per-turn wall-clock limit, or by the
          // bundle's budget gate, is never retried (the session already
          // killed the agent's processes). Its CLI may have left a partial
          // transcript, so persist a fresh conversation id: a later
          // `freshSession: false` visit must not resume it.
          if (isStoppedTurnBudgetExhaustion(err)) rotateConversation();
          throw err;
        }
        this.throwIfStopping(instance, `another step of agent state "${stateId}"`);
        if (result.quotaExhausted) {
          const { resetAt, rawMessage } = result.quotaExhausted;
          const commitStands = commitSurvivesUpstreamFailure();
          // A turn whose commit stands is logged once by its caller, with
          // the committed verdict.
          if (!commitStands) logReceived(result.text, undefined);
          messageLog.append({
            ...this.logBase(instance),
            type: 'quota_exhausted',
            role: stateConfig.persona,
            resetAt: resetAt?.toISOString(),
            rawMessage,
          });
          if (commitStands) return { text: result.text, hardFailure: true };
          // Stamp the instance before throwing so `handleWorkflowComplete`
          // can force an abort-preserving terminal regardless of which
          // state the onError target resolves to — protects checkpoint
          // retention for workflow definitions whose error target happens
          // to be a normal terminal (e.g. `done`).
          if (!detached()) instance.quotaExhausted = { resetAt, rawMessage };
          throw new WorkflowQuotaExhaustedError({ stateId, resetAt, rawMessage });
        }
        if (result.transientFailure) {
          const { kind, rawMessage } = result.transientFailure;
          // Same shape as the quota branch — append a structured log
          // entry, stamp the instance, throw a dedicated error — but
          // deliberately skip `logReceived`. Quota envelopes carry the
          // provider's actual rate-limit message in `result.text`, which
          // is worth recording as the agent's turn. Transient envelopes
          // carry only the agent's preamble with no real assistant
          // content, so logging it as `agent_received` would falsely
          // imply the agent produced a turn.
          messageLog.append({
            ...this.logBase(instance),
            type: 'transient_failure',
            role: stateConfig.persona,
            kind,
            rawMessage,
          });
          if (commitSurvivesUpstreamFailure()) return { text: result.text, hardFailure: true };
          if (!detached()) instance.transientFailure = { kind, rawMessage };
          throw new WorkflowTransientFailureError({ stateId, kind, rawMessage });
        }
        return result;
      };

      messageLog.append({
        ...this.logBase(instance),
        type: 'agent_sent',
        role: stateConfig.persona,
        message: command,
      });

      // Shared-container mode: the MITM is long-lived across agents. Flip
      // its token-stream routing id so this agent's live events land under
      // its own session id (matching what the observe bridge registers on
      // `agent_started`). Optional-chain because builtin/per-state-container
      // workflows have no shared `infra`.
      const agentSessionId = session.getInfo().id;
      // Token-stream routing is best-effort under fan-out: N lanes share one
      // long-lived MITM, so setTokenSessionId is racy across concurrent lanes
      // and a live event may be routed to whichever lane flipped last. It only
      // feeds live displays. Accounting does not use it: the run's usage meter
      // counts the metrics-bus exchanges attributed to this run or its bundles
      // (each exchange carries the invocation it belongs to), which is what
      // `settings.workflowBudget` and the fan-out merge read.
      bundle?.setTokenSessionId(agentSessionId);
      // Trajectory-capture lifecycle: brackets the agent's run with a
      // begin/end pair on the bundle. The matching `endCaptureSession`
      // is in the finally block, awaited BEFORE session.close() per §11
      // so the manifest entry is durable even if close() throws.
      // `bundle` is genuinely optional (builtin / per-state-container
      // workflows have no shared bundle); the method is always present.
      if (bundle) {
        bundle.beginCaptureSession({
          sessionId: agentSessionId,
          persona: stateConfig.persona,
          fsmState: stateId,
        });
      }

      this.emitLifecycleEvent({
        kind: 'agent_started',
        workflowId,
        state: stateId,
        persona: stateConfig.persona,
        sessionId: agentSessionId,
      });

      // Hard failures re-send the original command with a rotated conversation
      // id. Status failures stay in the live conversation for a bounded commit
      // loop; status-routed states get one fresh replacement execution after
      // that loop is exhausted.
      const MAX_HARD_RETRIES = 2;
      const MAX_COMMIT_RECOVERY_TURNS = 2;
      const MAX_RECOVERY_EXCERPTS = 3;
      const MAX_RECOVERY_EXCERPT_CHARS = 4_000;
      let responseText = '';
      let latestResponseText = '';
      const incompleteOutputExcerpts: string[] = [];

      const rememberResponse = (text: string) => {
        latestResponseText = text;
        const body = stripAgentStatusFences(text).trim();
        if (!body) return;
        responseText = body;
        const safeExcerpt = truncateAgentOutput(body);
        incompleteOutputExcerpts.push(
          safeExcerpt.length > MAX_RECOVERY_EXCERPT_CHARS
            ? `${safeExcerpt.slice(0, MAX_RECOVERY_EXCERPT_CHARS)}\n[excerpt truncated]`
            : safeExcerpt,
        );
        if (incompleteOutputExcerpts.length > MAX_RECOVERY_EXCERPTS) incompleteOutputExcerpts.shift();
      };

      // Admit the state's primary turn with the same host-derived check the
      // recovery turns use, so no turn is launched against a session whose
      // budget is already visibly exhausted (interim host-side enforcement
      // for container mode; see session/budget-admission.ts).
      const admissionReason = cumulativeBudgetExhaustionReason(session);
      if (admissionReason) throw new Error(`Cannot start agent turn for "${stateId}": ${admissionReason}`);

      for (let attempt = 0; attempt <= MAX_HARD_RETRIES; attempt++) {
        const result = await sendAgentTurn(command);
        if (!result.hardFailure) {
          rememberResponse(result.text);
          break;
        }
        if (invocation?.committed()) {
          // The agent committed through workflow_commit before its CLI
          // failed: the recorded commit is the state's result, and nothing
          // is re-run. The failed turn's text is logged, never handed on, and
          // the broken conversation is not resumed later.
          latestResponseText = result.text;
          rotateConversation();
          break;
        }

        logReceived(result.text, undefined);
        logAgentRetry(
          'upstream_stall',
          `Agent exited without producing output (attempt ${attempt + 1}/${MAX_HARD_RETRIES + 1})`,
          command,
        );

        if (attempt === MAX_HARD_RETRIES) {
          throw new Error(`Agent failed to produce output after ${MAX_HARD_RETRIES + 1} attempts (upstream stall)`);
        }
        const budgetReason = cumulativeBudgetExhaustionReason(session);
        if (budgetReason) throw new Error(`Cannot retry upstream stall: ${budgetReason}`);
        rotateConversation();
      }

      const routesOnStatus = stateConfig.transitions.some((transition) => transition.when !== undefined);
      type CommitResult =
        | ParseResult
        | { readonly kind: 'invalid'; readonly output: AgentOutput }
        /** Commit-tool protocol: the invocation has no accepted workflow_commit yet. */
        | { readonly kind: 'uncommitted' };
      /** Set when the state committed through workflow_commit with a handoff for the next state. */
      let committedHandoff: string | undefined;

      // Commit-tool protocol: the recorded commit is the state's result and
      // the turn's text is never parsed (a YAML block in it means nothing);
      // the channel already refused verdicts the state does not route on.
      // YAML protocol: the final status block of the turn's text.
      const evaluateCommit = (text: string): CommitResult => {
        if (invocation) {
          const committed = invocation.committed();
          if (!committed) return { kind: 'uncommitted' };
          committedHandoff = committed.handoff ?? undefined;
          return {
            kind: 'ok',
            output: {
              completed: true,
              verdict: committed.verdict,
              confidence: 'high',
              escalation: null,
              testCount: null,
              notes: committed.notes,
            },
          };
        }
        const parsed = tryParseAgentStatus(text);
        if (parsed.kind !== 'ok') return parsed;
        if (validVerdicts && !validVerdicts.has(parsed.output.verdict)) {
          return { kind: 'invalid', output: parsed.output };
        }
        return parsed;
      };

      const commitRetry = (result: Exclude<CommitResult, { readonly kind: 'ok' }>) => {
        if (result.kind === 'uncommitted' && commitPrompt) {
          return {
            reason: 'missing_commit' as const,
            details: 'Turn ended without an accepted workflow_commit call for this invocation',
            message: buildMissingCommitReprompt(commitPrompt, statusInstructions),
          };
        }
        if (result.kind === 'invalid') {
          return {
            reason: 'invalid_verdict' as const,
            details: `Verdict "${result.output.verdict}" not in valid set: ${[...(validVerdicts ?? [])].join(', ')}`,
            message: buildInvalidVerdictReprompt(result.output.verdict, stateConfig.transitions),
          };
        }
        const malformed = result.kind === 'malformed' ? result.error : undefined;
        return {
          reason: malformed ? ('malformed_status_block' as const) : ('missing_status_block' as const),
          details: malformed
            ? `Malformed agent_status block: ${malformed.message}`
            : 'Response did not contain a final agent_status block',
          message: buildStatusBlockReprompt(statusInstructions, malformed),
        };
      };

      const commitFailureDescription = (result: Exclude<CommitResult, { readonly kind: 'ok' }>): string => {
        if (result.kind === 'uncommitted') return 'no accepted workflow_commit call';
        if (result.kind === 'invalid') {
          return `invalid verdict "${result.output.verdict}" (expected one of: ${[...(validVerdicts ?? [])].join(', ')})`;
        }
        return result.kind === 'malformed'
          ? `malformed agent_status block: ${result.error.message}`
          : 'missing final agent_status block';
      };

      let commit = evaluateCommit(latestResponseText);
      logReceived(latestResponseText, commit.kind === 'ok' ? commit.output : undefined);
      let recoveryFailure: string | undefined;
      let recoveryConversationRotated = false;

      for (let recoveryTurn = 0; commit.kind !== 'ok' && recoveryTurn < MAX_COMMIT_RECOVERY_TURNS; recoveryTurn++) {
        const budgetReason = cumulativeBudgetExhaustionReason(session);
        if (budgetReason) {
          recoveryFailure = `Status recovery stopped: ${budgetReason}`;
          break;
        }

        const retry = commitRetry(commit);
        logAgentRetry(retry.reason, retry.details, retry.message);
        const result = await sendAgentTurn(retry.message);
        if (result.hardFailure && !invocation?.committed()) {
          logReceived(result.text, undefined);
          logAgentRetry('upstream_stall', 'Status recovery turn exited without producing output', retry.message);
          recoveryConversationRotated = rotateConversation();
          recoveryFailure = 'Status recovery failed because the agent conversation hard-failed';
          break;
        }
        // A hard failure after an accepted commit: the commit stands, and the
        // failed turn's text is logged but never handed on.
        if (result.hardFailure) {
          recoveryConversationRotated = rotateConversation();
          latestResponseText = result.text;
        } else {
          rememberResponse(result.text);
        }
        commit = evaluateCommit(result.text);
        logReceived(result.text, commit.kind === 'ok' ? commit.output : undefined);
      }

      if (commit.kind !== 'ok' && routesOnStatus) {
        const budgetReason = cumulativeBudgetExhaustionReason(session);
        if (budgetReason) {
          recoveryFailure = `Replacement execution skipped: ${budgetReason}`;
        } else if (recoveryConversationRotated || rotateConversation()) {
          // The replacement runs the same invocation: same id, same channel.
          const replacementPrompt = buildAgentReplacementCommand(
            stateId,
            stateConfig,
            context,
            definition,
            { incompleteOutputExcerpts },
            promptOptions,
          );
          const retry = commitRetry(commit);
          logAgentRetry(
            retry.reason,
            `Fresh replacement after recovery exhaustion: ${retry.details}`,
            replacementPrompt,
          );
          const replacement = await sendAgentTurn(replacementPrompt);
          if (replacement.hardFailure && !invocation?.committed()) {
            logReceived(replacement.text, undefined);
            rotateConversation();
            recoveryFailure = 'Fresh replacement execution hard-failed';
          } else {
            // A hard failure after an accepted commit: the commit stands, and
            // the failed turn's text is logged but never handed on.
            if (replacement.hardFailure) rotateConversation();
            else rememberResponse(replacement.text);
            commit = evaluateCommit(replacement.text);
            logReceived(replacement.text, commit.kind === 'ok' ? commit.output : undefined);
            if (commit.kind !== 'ok') {
              recoveryFailure = `Fresh replacement returned ${commitFailureDescription(commit)}`;
            }
          }
        } else {
          recoveryFailure = 'Cannot start fresh replacement because this session cannot rotate conversations';
        }
      }

      let agentOutput: AgentOutput;
      if (commit.kind === 'ok') {
        agentOutput = commit.output;
      } else if (stateConfig.artifactHandoff && this.artifactHandoffSatisfied(stateConfig, instance.artifactDir)) {
        const handoff =
          'Required artifacts are present; handing them to the configured validator for independent validation.';
        responseText = handoff;
        agentOutput = {
          completed: true,
          verdict: 'artifact_handoff',
          confidence: 'high',
          escalation: null,
          testCount: null,
          notes: handoff,
        };
      } else {
        throw new Error(
          recoveryFailure ??
            `Agent did not commit a routable status after ${MAX_COMMIT_RECOVERY_TURNS} recovery turns: ${commitFailureDescription(commit)}`,
        );
      }

      const missingArtifacts = this.findMissingArtifacts(instance, stateConfig);
      if (missingArtifacts.length > 0) {
        const artifactRetryMsg = buildArtifactReprompt(
          missingArtifacts,
          stateConfig.transitions,
          commitPrompt ? { ...commitPrompt, committed: invocation?.committed() !== undefined } : undefined,
          artifactRepromptReadOnly(stateConfig, definition),
        );
        logAgentRetry('missing_artifacts', `Missing: ${missingArtifacts.join(', ')}`, artifactRetryMsg);

        const budgetReason = cumulativeBudgetExhaustionReason(session);
        if (budgetReason) throw new Error(`Cannot retry missing artifacts: ${budgetReason}`);
        const artifactResult = await sendAgentTurn(artifactRetryMsg);
        if (artifactResult.hardFailure) {
          rotateConversation();
          // An accepted workflow_commit stands through a hard failure; the
          // artifacts this turn was for are re-checked below either way.
          if (!invocation?.committed()) {
            logReceived(artifactResult.text, undefined);
            throw new Error('Missing-artifact recovery turn hard-failed');
          }
        }
        const retryResponse = artifactResult.text;
        // Like every other hard failure that a commit survives, the failed
        // turn's text is logged below but never handed on: without a
        // committed handoff the next state keeps the earlier response.
        if (!artifactResult.hardFailure) rememberResponse(retryResponse);
        // Commit-tool protocol: the invocation's commit (made earlier, or
        // in this turn when the state had none) is read again.
        const retryCommit = evaluateCommit(retryResponse);
        if (retryCommit.kind === 'ok') {
          logReceived(retryResponse, retryCommit.output);
          agentOutput = retryCommit.output;
        } else {
          logReceived(retryResponse, undefined);
        }
        const stillMissing = this.findMissingArtifacts(instance, stateConfig);
        if (stillMissing.length > 0) {
          throw new Error(`Missing artifacts after retry: ${stillMissing.join(', ')}`);
        }
      }

      // The hash only feeds the `isStalled` guard. For every other state the
      // walk (the whole workspace when `outputs` is empty) would be pure cost
      // on the daemon's event loop, so it is skipped.
      const outputHash = usesStallGuard(stateConfig)
        ? computeOutputHash(stateConfig.outputs, instance.artifactDir, instance.workspacePath)
        : OUTPUT_HASH_NOT_COMPUTED;
      const artifacts = collectArtifactPaths(stateConfig.outputs, instance.artifactDir, instance.workspacePath);

      instance.tab.write(
        `[agent] "${stateId}" completed: verdict=${agentOutput.verdict}, artifacts=${Object.keys(artifacts).join(',') || 'none'}`,
      );

      this.emitLifecycleEvent({
        kind: 'agent_completed',
        workflowId,
        state: stateId,
        persona: stateConfig.persona,
        verdict: agentOutput.verdict,
      });

      return {
        output: agentOutput,
        agentConversationId: currentConversationId,
        artifacts,
        outputHash,
        // A committed handoff is what the state chose to pass on; without
        // one, the latest substantive response is.
        responseText: committedHandoff ?? responseText,
        // Snapshot the run-wide total tokens AT THE END of this agent's
        // turn. The XState assign action uses this value to update
        // ctx.totalTokens; it covers every session of the run so far,
        // including all earlier agents and concurrent lanes.
        totalTokens: instance.usage.snapshot().totalTokens,
      };
    } catch (err) {
      // Quota exhaustion / transient upstream failure already produced
      // their own structured log entries inside `sendAgentTurn`;
      // appending a generic `error` entry here would double-log the same
      // event and make `workflow inspect` surface a duplicate red error
      // line alongside the structured signal. Suppress the generic entry
      // when the cause is a `WorkflowQuotaExhaustedError` or
      // `WorkflowTransientFailureError`, and for a detached (drained)
      // invocation, whose failure nothing consumes.
      if (!detached() && !isWorkflowQuotaExhaustedError(err) && !isWorkflowTransientFailureError(err)) {
        instance.messageLog.append({
          ...this.logBase(instance),
          type: 'error',
          error: toErrorMessage(err),
          context: `agent "${stateId}" (persona: ${stateConfig.persona})`,
        });
      }
      throw new AgentInvocationError({ stateId, agentConversationId: currentConversationId, cause: err });
    } finally {
      // No commit is accepted for this invocation once it is over.
      invocation?.close();
      instance.resourceBudget = { ...instance.resourceBudget, usage: workflowBudgetUsage(session.getBudgetStatus()) };
      // The session's watcher stops with the session; anything it still
      // had pending can no longer be answered.
      this.expireToolCallEscalationsWhere(instance, 'the agent session ended', (p) => p.owner === sessionRef);
      const endedSessionId = session.getInfo().id;
      // Trajectory-capture lifecycle: end the capture session FIRST so
      // the `session-end` manifest entry is durable even if
      // session.close() throws. The two-phase drain inside
      // endCaptureSession waits for in-flight reassembly to settle
      // before enqueuing the manifest end-marker (§9 / §11).
      // `bundle` is genuinely optional (builtin / per-state-container
      // workflows); the method is always present when the bundle is.
      if (bundle) {
        await bundle.endCaptureSession(endedSessionId).catch((err: unknown) => {
          writeStderr(`[workflow] endCaptureSession failed for "${stateId}": ${toErrorMessage(err)}`);
        });
      }
      await this.closeWorkflowSession(instance, session);
      // session.close() drains in-flight streams that captured the
      // agent's session id at attach time; they keep posting under it
      // until they finish, regardless of setTokenSessionId(undefined).
      // The clear here only governs future attachments.
      bundle?.setTokenSessionId(undefined);
      // Pairs 1:1 with agent_started; emitted unconditionally in finally
      // so success, failure, and abort paths all clean up the bridge.
      this.emitLifecycleEvent({
        kind: 'agent_session_ended',
        workflowId,
        state: stateId,
        sessionId: endedSessionId,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Fan-out state execution
  // -----------------------------------------------------------------------

  /**
   * Runs one fan-out batch: the invoke body of the real `workers` state,
   * registered as the `fanOutService` actor (see {@link provideActors}). For
   * each worker it creates a free-standing child round actor, starts it, and
   * barrier-joins on every child reaching a `final` state, then folds the lane
   * verdicts into a single parent-edge result (§6.2).
   *
   * WHY free-standing `createActor` + `.start()` and NOT in-context `spawn`:
   * this is a `fromPromise` invoke body (plain async TS), not an XState entry
   * action — `spawn` is only callable from inside an action. A free-standing
   * actor is its OWN root, so the parent's `snapshot.value` stays the string
   * `"workers"` (single-active-state spine preserved, §6.4); the children's
   * snapshots are their own, read here via {@link waitForRoundChild}. A
   * `type:'parallel'` region would instead fold into the parent's `value` and
   * make it an object — fatal to checkpoint/terminal/gate serialization (§6.4).
   *
   * WHY mint the scope bundle BEFORE fan-out: {@link preMintFanOutScopeBundle}
   * runs `ensureBundleForScope` serially up front so the single shared
   * container exists before any child's first `container:true` step. N children
   * racing their first container step would each see an empty `bundlesByScope`
   * and mint a SEPARATE container, defeating `sharedContainer` (§6.2 / §8.1;
   * cross-ref the `ensureBundleForScope` check-then-act race comment). The same
   * preflight installs the segment's single persona policy once and refuses a
   * multi-lane segment whose agent members use different personas (§8.2:
   * homogeneity is load-bearing — one coordinator, one active policy).
   *
   * Never throws for configuration failures: workflow gone, misconfigured
   * segment, mixed personas, unsupported worker count, missing child machine —
   * all funnel through {@link fanOutErrorResult}, which yields a
   * `result_file_error` verdict that the parent `workers` state routes to its
   * `failed` edge, and reports the reason (so do a failed reconstruction,
   * lane preparation or barrier step, and a rejected lane). (The
   * `fanOutService` wrapper in {@link provideActors} would
   * also catch a thrown error, but the uniform result keeps the parent
   * transition table verdict-driven.) The one deliberate exception is a lane's
   * resumable upstream failure (quota exhaustion / transient stall), re-thrown
   * by {@link upstreamFailureAfterFanOut} so the parent's `onError` lands on
   * the abort-preserving terminal instead of a verdict edge that may lead to a
   * human gate. Infrastructure failures (bundle mint, control-server attach)
   * also propagate, exactly as they do for a serial agent state.
   */
  private async runFanOutSegment(
    workflowId: WorkflowId,
    input: FanOutInvokeInput,
    definition: WorkflowDefinition,
    roundMachinesByState: ReadonlyMap<string, AnyStateMachine>,
  ): Promise<FanOutInvokeResult> {
    const instance = this.workflows.get(workflowId);
    if (!instance) {
      return this.fanOutErrorResult(undefined, input, 'configuration', `workflow ${workflowId} not found`);
    }
    // An aborted run starts no batch, and every await below re-checks: abort()
    // stops the lanes it finds registered, so none may start after it ran.
    const batchName = `fan-out "${input.stateId}"`;
    this.throwIfStopping(instance, batchName);

    const fanOut = input.stateConfig.fanOut;
    const segment = input.stateConfig.segment ?? [];
    if (fanOut === undefined || segment.length === 0) {
      return this.fanOutErrorResult(
        instance,
        input,
        'configuration',
        `State "${input.stateId}" is not a configured fan-out segment.`,
      );
    }

    const workers = resolveFanOutWorkers(fanOut, definition.settings);
    if (!Number.isInteger(workers) || workers < 1) {
      return this.fanOutErrorResult(
        instance,
        input,
        'configuration',
        `State "${input.stateId}" resolved to invalid worker count ${workers}.`,
      );
    }
    // Validation enforces the same bound; this is the runtime guard for a
    // definition that bypassed it.
    if (workers > MAX_FAN_OUT_LANES) {
      return this.fanOutErrorResult(
        instance,
        input,
        'configuration',
        `State "${input.stateId}" resolved to ${workers} lanes; at most ${MAX_FAN_OUT_LANES} are supported.`,
      );
    }

    const roundMachine = roundMachinesByState.get(input.stateId);
    if (!roundMachine) {
      return this.fanOutErrorResult(
        instance,
        input,
        'configuration',
        `No child round machine is registered for fan-out state "${input.stateId}".`,
      );
    }

    // PRECONDITION: mint the shared-container bundle and install the segment's
    // single persona once, before any child; refuse a segment that cannot
    // safely share one coordinator.
    const preflightError = await this.preMintFanOutScopeBundle(instance, input.stateId, segment, workers);
    this.throwIfStopping(instance, batchName);
    if (preflightError !== undefined) {
      return this.fanOutErrorResult(instance, input, 'preflight', preflightError);
    }

    const reconstruction = this.reconstructFanOutBatchFromDb(instance, definition, segment, workers);
    if (reconstruction.kind === 'error') {
      return this.fanOutErrorResult(instance, input, 'batch reconstruction', reconstruction.error);
    }
    const missingLanes =
      reconstruction.kind === 'ready'
        ? reconstruction.reconstruction.missingLanes
        : Array.from({ length: workers }, (_, index) => index);

    const preparedLaneResults = await this.prepareFanOutLaneResults(workflowId, input, definition, segment, workers, {
      batchIndex:
        reconstruction.kind === 'ready' && reconstruction.reconstruction.recordedByLane.size > 0
          ? reconstruction.reconstruction.batchIndex
          : undefined,
      lanes: missingLanes,
    });
    this.throwIfStopping(instance, batchName);
    if (preparedLaneResults.error !== undefined) {
      return this.fanOutErrorResult(instance, input, 'lane preparation', preparedLaneResults.error);
    }

    instance.tab.write(`[fanout] Starting "${input.stateId}" with ${workers} worker${workers === 1 ? '' : 's'}`);
    const providedRoundMachine = this.provideActors(roundMachine, workflowId, definition, roundMachinesByState);
    let drainTrigger: RoundChildDrainTrigger | undefined;
    const childActors: RoundChildWaiter[] = [];
    const lanePromises: Array<Promise<RoundChildOutcome>> = [];
    // Drain-on-escalation trigger. WHAT: the FIRST lane to reach `blocked`/
    // `errored` latches `drainTrigger`; the `!== undefined` guard makes this
    // fire-once, so a later co-blocker never re-triggers. Every un-settled peer
    // is then drained (stopped) on the trigger's behalf.
    //
    // WHY drain-first / discard healthy peers: a batch escalation re-decides the
    // WHOLE round (the parent routes the whole batch to one human gate), so an
    // in-flight peer's eventual `recorded` would be thrown away anyway — draining
    // stops that wasted LLM spend instead of letting peers run to completion.
    //
    // WHY stop-at-boundary: a drained lane is stopped at a state boundary via
    // `actor.stop()`. That aborts the in-flight invoke's signal, which detaches
    // an agent invocation (no further turn, no stamp; see executeAgentState)
    // and kills a running deterministic command (a host command's process
    // group, a container command's processes by marker; see
    // executeDeterministicState), but an already-dispatched agent turn still
    // finishes out-of-band (FSM-M3), which is why {@link waitForRoundChild}'s
    // drain resolves the lane's outcome the moment it stops rather than
    // awaiting the in-flight call.
    //
    // Skip edges: the trigger lane itself is skipped (it already settled with its
    // own blocked/errored outcome), and any `isSettled()` peer is skipped — a peer
    // that RECORDED before the drain reached it keeps its real outcome (it is not
    // rewritten to `drained`). The SINGLE aggregated gate over all
    // blocked/errored lanes is produced later, at {@link joinFanOutBatch}.
    const requestDrain = (trigger: RoundChildDrainTrigger): void => {
      if (drainTrigger !== undefined) return;
      drainTrigger = trigger;
      instance.tab.write(
        `[fanout] "${input.stateId}" draining peers after lane ${trigger.index} ${trigger.status}: ${trigger.reason}`,
      );
      for (const child of childActors) {
        if (child.index === trigger.index || child.isSettled()) continue;
        child.drain(trigger);
      }
    };

    // Two loops on purpose: construct ALL waiters before starting ANY actor, so
    // an early-settling child's drain reaches peers that already have waiters
    // (a child started in loop 1 could settle synchronously and call
    // `requestDrain` before loop 2's later peers existed).
    for (let index = 0; index < workers; index += 1) {
      // Synthesize-vs-respawn fork. A lane whose node already recorded before the
      // crash is DB-authoritative: synthesize its outcome from the durable node
      // (no re-run, no fresh budget). A missing lane is RE-SPAWNED — and a
      // re-spawned lane restarts with a fresh visit/token budget (its per-lane
      // `maxVisits` resets, §6.1 / FSM-M1) and may drift to a different verdict
      // than its pre-crash run would have produced (§11.2). Synthesized lanes are
      // intentionally NOT pushed to `childActors`: they have no actor to drain, so
      // the drain-on-escalation loop must never touch them.
      const recordedLane =
        reconstruction.kind === 'ready' ? reconstruction.reconstruction.recordedByLane.get(index) : undefined;
      if (recordedLane !== undefined) {
        lanePromises[index] = Promise.resolve(
          this.synthesizeRecordedFanOutOutcome(input, segment, workers, recordedLane),
        );
        continue;
      }
      const childContext = this.buildFanOutLaneContext(
        input.context,
        index,
        workers,
        preparedLaneResults.byLane[index],
      );
      const child = createActor(providedRoundMachine, { input: { context: childContext } });
      const waiter = this.waitForRoundChild(child, index, requestDrain);
      childActors.push(waiter);
      lanePromises[index] = waiter.promise;
    }

    // Registered on the instance (in the same synchronous run that starts
    // them) so abort() can stop every lane: they are root actors of their
    // own, which stopping the run's actor does not reach.
    for (const child of childActors) instance.fanOutChildren.add(child);
    let settled: PromiseSettledResult<RoundChildOutcome>[];
    try {
      for (const child of childActors) {
        child.actor.start();
      }
      settled = await Promise.allSettled(lanePromises);
    } finally {
      for (const child of childActors) instance.fanOutChildren.delete(child);
    }
    // Lanes stopped by an abort settle as drained; their batch is not joined
    // and no barrier step runs for it.
    this.throwIfStopping(instance, `the barrier of ${batchName}`);
    let result = this.joinFanOutBatch(instance, input, settled);
    const upstreamFailure = this.upstreamFailureAfterFanOut(instance, input.stateId);
    if (upstreamFailure !== undefined) {
      this.logFanOutJoin(instance, input.stateId, workers, result, settled);
      instance.tab.write(`[fanout] "${input.stateId}" halted: ${upstreamFailure.message}`);
      throw upstreamFailure;
    }
    if (workers > 1 && result.verdict === 'recorded') {
      const promotion = await this.promoteBarrierCognition(workflowId, definition, segment, result.context, settled);
      if (promotion.error !== undefined) {
        return this.fanOutErrorResult(instance, input, 'cognition promotion', promotion.error);
      }
      if (promotion.result?.payload !== undefined) {
        result = {
          ...result,
          payload: {
            ...(result.payload ?? {}),
            cognition_promotion: promotion.result.payload,
          },
        };
      }
      // Barrier-owned canonical stop_signals: with N lanes, each lane wrote only
      // its lane-scoped stop_signals copy, so the single file the orchestrator
      // routes on is computed ONCE here, post-barrier, over the N-grown nodes.json
      // (SHOULD-FIX-1). At workers:1 the lone lane's attach_analysis already wrote
      // the canonical bare file inline (byte-identical backward compat), so we skip.
      const stopSignalsError = await this.computeBarrierStopSignals(workflowId, definition, segment, input.context);
      if (stopSignalsError !== undefined) {
        return this.fanOutErrorResult(instance, input, 'stop signals', stopSignalsError);
      }
    }
    this.logFanOutJoin(instance, input.stateId, workers, result, settled);
    instance.tab.write(`[fanout] "${input.stateId}" joined: verdict=${result.verdict ?? 'none'}`);
    return result;
  }

  /**
   * Promotes recorded lane lessons once, serially, at the fan-out barrier. This
   * is the workers>1 cognition single-writer point (§9): lane `attach_analysis`
   * calls only record durable nodes; the parent invokes `promote_cognition`
   * after every child has recorded and before re-entering `orchestrator`.
   *
   * Only `recorded` lanes are promoted — blocked/errored children are filtered
   * out because they contributed no durable node to seed a lesson from.
   *
   * Returns one of three shapes:
   * - `{ error }` — the promotion ran but did not pass (the bridge returned a
   *   non-`cognition_promoted` verdict / `needs_repair`), OR — a hard error —
   *   `lanes.length === 0` for a workers>1 recorded batch (every recorded child
   *   should carry a lane id, so an empty set means the join is inconsistent).
   * - `{ result }` — the promotion passed; the caller folds the payload into the
   *   batch result under `cognition_promotion`.
   * - `{}` — a no-op, when {@link buildEvolvePromoteCognitionInput} returns
   *   undefined (non-evolve segment, or a segment with nothing to promote).
   *
   * Mixed-verdict deferral (within §9, intended): this only runs when the batch
   * verdict is `recorded`. When a batch instead escalates/fails, recorded lanes'
   * lessons are NOT promoted that turn — on APPROVE→resume the recorded lanes
   * idempotent-skip then barrier-promote (the ledger dedups), but an
   * ABORT/FORCE_REVISION never promotes them, by design: an aborted batch must
   * not seed cognition.
   */
  private async promoteBarrierCognition(
    workflowId: WorkflowId,
    definition: WorkflowDefinition,
    segment: readonly string[],
    context: WorkflowContext,
    settled: readonly PromiseSettledResult<RoundChildOutcome>[],
  ): Promise<{ result?: DeterministicInvokeResult; error?: string }> {
    const lanes = settled
      .filter((entry): entry is PromiseFulfilledResult<RoundChildOutcome> => entry.status === 'fulfilled')
      .map((entry) => entry.value)
      .filter((child) => child.status === 'recorded')
      .map((child) => child.context.lane?.id)
      .filter((lane): lane is number => typeof lane === 'number' && Number.isInteger(lane) && lane >= 0)
      .sort((a, b) => a - b);

    if (lanes.length === 0) {
      return { error: 'fan-out cognition promotion had no recorded lanes to promote' };
    }

    const attach = this.findEvolveAttachAnalysisState(definition, segment);
    if (!attach) return {};

    const input = this.buildEvolvePromoteCognitionInput(attach.stateId, attach.state, attach.command, context, lanes);
    if (!input) return {};

    const result = await this.executeDeterministicState(workflowId, input);
    if (!result.passed || result.verdict !== 'cognition_promoted') {
      return {
        error: result.errors ?? `barrier cognition promotion failed with verdict ${result.verdict ?? 'unknown'}`,
      };
    }
    return { result };
  }

  /**
   * Locates the segment's `attach_analysis` deterministic state and its evolve
   * command (the segment member that carries the `evolve_result.py` path and
   * `--run-dir`). Returns `undefined` when the segment has no such state — a
   * non-evolve fan-out has no cognition to promote.
   */
  private findEvolveAttachAnalysisState(
    definition: WorkflowDefinition,
    segment: readonly string[],
  ): { stateId: string; state: DeterministicStateDefinition; command: readonly string[] } | undefined {
    for (const stateId of segment) {
      const state = definition.states[stateId];
      if (state.type !== 'deterministic') continue;
      const command = state.run.find((entry) => this.isEvolveAttachAnalysisCommand(entry));
      if (command) return { stateId, state, command };
    }
    return undefined;
  }

  /**
   * Derives the `promote_cognition` invoke input from the segment's already-
   * resolved `attach_analysis` command: reuses the bridge path, `--run-dir`,
   * container scope, and timeout; rewrites the subcommand; passes the recorded
   * lane ids; and writes one barrier-owned result at
   * `current/cognition_promotion.json`. Returns `undefined` when the command
   * lacks the bridge path, a `--run-dir`, or a resolvable workspace-relative
   * result path (the caller then treats promotion as a no-op).
   */
  private buildEvolvePromoteCognitionInput(
    stateId: string,
    state: DeterministicStateDefinition,
    attachCommand: readonly string[],
    context: WorkflowContext,
    lanes: readonly number[],
  ): DeterministicInvokeInput | undefined {
    return this.buildEvolveBarrierInput(stateId, state, attachCommand, context, {
      stateIdSuffix: '_promote_cognition',
      subcommand: 'promote_cognition',
      resultBasename: 'cognition_promotion.json',
      extraArgs: lanes.flatMap((lane) => ['--lane', String(lane)]),
    });
  }

  /**
   * Computes the single canonical `current/stop_signals.json` ONCE at the
   * barrier join by running the bridge's `compute_stop_signals` subcommand over
   * the batch-grown `nodes.json`. The bridge writes the bare canonical file
   * atomically (temp+rename); per-lane `attach_analysis` only ever wrote
   * lane-scoped copies, so this is the sole writer of the routing input the
   * orchestrator reads each batch (SHOULD-FIX-1).
   *
   * Derived from the segment head's declared `sample` command (the only segment
   * member guaranteed to carry the `evolve_result.py` path and `--run-dir`), so
   * it inherits the same container scope / timeout. Returns an error string on
   * failure (the caller folds it into a `result_file_error`), or `undefined` on
   * success — including the benign case where the segment has no recognizable
   * evolve sample command (a non-evolve fan-out has no stop signals to compute).
   */
  private async computeBarrierStopSignals(
    workflowId: WorkflowId,
    definition: WorkflowDefinition,
    segment: readonly string[],
    context: WorkflowContext,
  ): Promise<string | undefined> {
    const sampleStateId = segment[0];
    const sampleState = definition.states[sampleStateId];
    if (sampleState.type !== 'deterministic') return undefined;

    const input = this.buildEvolveStopSignalsInput(sampleStateId, sampleState, context);
    if (!input) return undefined;

    const result = await this.executeDeterministicState(workflowId, input);
    if (!result.passed || result.verdict !== 'stop_signals_computed') {
      return result.errors ?? `barrier stop_signals computation failed with verdict ${result.verdict ?? 'unknown'}`;
    }
    return undefined;
  }

  /**
   * Derives the `compute_stop_signals` invoke input from the segment head's
   * `sample` command: reuses its `evolve_result.py` path and `--run-dir`,
   * rewrites the subcommand to `compute_stop_signals`, and points
   * `--result-file` at the shared `current/stop_signals_compute.json` barrier
   * artifact. Returns `undefined` when the command lacks the bridge path, a
   * `--run-dir`, or a resolvable workspace-relative result path.
   */
  private buildEvolveStopSignalsInput(
    stateId: string,
    state: DeterministicStateDefinition,
    context: WorkflowContext,
  ): DeterministicInvokeInput | undefined {
    const sampleCommand = state.run.find((command) => this.isEvolveSampleCommand(command));
    if (!sampleCommand) return undefined;
    return this.buildEvolveBarrierInput(stateId, state, sampleCommand, context, {
      stateIdSuffix: '_stop_signals',
      subcommand: 'compute_stop_signals',
      resultBasename: 'stop_signals_compute.json',
    });
  }

  /**
   * Shared-container preflight for a fan-out segment: mints the segment's ONE
   * scope bundle and installs its ONE persona policy before any child actor
   * starts (the load-bearing precondition of {@link runFanOutSegment}).
   *
   * Returns `undefined` when the segment may start, or an error message for a
   * segment that must not run — the caller turns it into
   * {@link fanOutErrorResult} so misconfiguration surfaces as a
   * `result_file_error` verdict, never as N half-started lanes.
   * Infrastructure failures (bundle mint, control-server attach) still throw,
   * as they do for a serial agent state.
   *
   * Skipped entirely outside shared-container mode: there each lane's session
   * builds its own coordinator, so there is nothing to share and nothing to
   * guard. A segment with no container members needs no bundle either.
   *
   * WHY mint here, serially: `ensureBundleForScope` is an unguarded
   * check-then-act across awaits (its own doc flags the lazy-mint race). N
   * children each hitting their first `container:true` step would each see
   * `bundlesByScope.get(scope)` undefined and mint a SEPARATE container.
   * Calling it once here closes that window — every child then borrows the
   * already-minted bundle.
   *
   * WHY one scope: this slice keeps the whole segment under one
   * `containerScope` (§8.2). A segment spanning >1 scope is refused here (and
   * statically by `validateFanOutLaneConcurrency`) rather than minting the
   * wrong bundle.
   *
   * WHY one persona, cycled once, BEFORE the lanes: every lane borrows this
   * bundle's single coordinator, and `cyclePolicy` hot-swaps that
   * coordinator's one active policy. With `workers > 1` and agent members of
   * different personas, lane 0 entering its second member would swap the
   * policy out from under lane 1's still-running first member — tool calls
   * evaluated and audited under the wrong persona (a silent policy bypass one
   * way, spurious denials the other). Heterogeneous multi-lane segments are
   * therefore refused; the validator rejects them statically too, this is the
   * runtime guard for definitions that bypass validation. For the homogeneous
   * case the one persona is installed here, once, so every lane's own
   * `cyclePolicy` call hits the `currentPersonaByBundle` short-circuit instead
   * of N concurrent `loadPolicy` RPCs racing the cache's read-then-set window.
   */
  private async preMintFanOutScopeBundle(
    instance: WorkflowInstance,
    fanOutStateId: string,
    segment: readonly string[],
    workers: number,
  ): Promise<string | undefined> {
    if (!this.shouldUseSharedContainer(instance.definition)) return undefined;

    const scopes = new Set<string>();
    const agentPersonas: Array<{ readonly memberId: string; readonly persona: string }> = [];
    for (const memberId of segment) {
      const member = instance.definition.states[memberId];
      if (member.type === 'agent') {
        scopes.add(member.containerScope ?? DEFAULT_CONTAINER_SCOPE);
        agentPersonas.push({ memberId, persona: member.persona });
      } else if (member.type === 'deterministic' && member.container === true) {
        scopes.add(member.containerScope ?? DEFAULT_CONTAINER_SCOPE);
      }
    }

    if (scopes.size === 0) return undefined;
    if (scopes.size > 1) {
      return (
        `fan-out state "${fanOutStateId}" spans multiple container scopes (${[...scopes].sort().join(', ')}); ` +
        'a fan-out segment must run entirely within one containerScope.'
      );
    }

    const personas = new Set(agentPersonas.map((entry) => entry.persona));
    if (workers > 1 && personas.size > 1) {
      const described = agentPersonas.map((entry) => `${entry.memberId}: ${entry.persona}`).join(', ');
      return (
        `fan-out state "${fanOutStateId}" runs ${workers} concurrent lanes on one shared coordinator, but its agent ` +
        `members use different personas (${described}); concurrent lanes would evaluate tool calls under each ` +
        `other's policies. Use one persona for every agent member of the segment, or run it with a single lane.`
      );
    }

    // size is exactly 1 here (the 0 and >1 cases returned above), so the
    // single-element destructure yields the one scope.
    const [scope] = [...scopes];
    const bundle = await this.ensureBundleForScope(instance, scope);

    // Exactly one persona across the segment's agent members (a
    // deterministic-only segment has none to install; a serial workers:1
    // segment with several personas cycles per state as usual).
    if (personas.size !== 1) return undefined;
    const [persona] = [...personas];
    try {
      await this.cyclePolicy(instance, persona, bundle);
    } catch (err) {
      return (
        `fan-out state "${fanOutStateId}": policy cycle for persona "${persona}" failed before any lane started: ` +
        toErrorMessage(err)
      );
    }
    return undefined;
  }

  /**
   * Surfaces why a fan-out batch failed on stderr, on the tab and in the
   * message log, whose entry's context names the fan-out state and the
   * failed stage. {@link fanOutErrorResult} carries the reason only in
   * `errors`, which the parent's verdict routing never reads (it keeps only
   * the result's context), so without this the reason would be invisible to
   * `workflow inspect`.
   *
   * A reason can carry container output (a failed barrier step's stderr), so
   * it is bounded, and the stderr line is made display-safe (the tab escapes
   * what it shows). A stopping run reports nothing: its stopped actor ignores
   * the result, and no entry may follow its terminal marker. Without an
   * instance (the run is gone) only stderr is left.
   */
  private reportFanOutFailure(
    instance: WorkflowInstance | undefined,
    fanOutStateId: string,
    stage: FanOutFailureStage,
    message: string,
  ): void {
    if (instance !== undefined && this.isStopping(instance)) return;
    const reason = truncateForTransition(message) ?? 'no reason given';
    const outcome = `${stage === 'configuration' || stage === 'preflight' ? 'refused' : 'failed'} (${stage})`;
    writeStderr(`[workflow] fan-out "${fanOutStateId}" ${outcome}: ${toDisplayText(reason)}`);
    if (instance === undefined) return;
    instance.tab.write(`[error] Fan-out "${fanOutStateId}" ${outcome}: ${reason}`);
    instance.messageLog.append({
      ...this.logBase(instance),
      type: 'error',
      error: reason,
      context: `fan-out "${fanOutStateId}" ${stage}`,
    });
  }

  /**
   * Re-raises a lane's resumable stop at the fan-out barrier: an upstream
   * failure (quota / transient) or a lane step the workflow budget refused.
   *
   * Inside a lane the failure lands on the child's `errored` terminal and the
   * join folds it into a `result_file_error` verdict, which the parent routes
   * like any failed batch — possibly to a human gate or `failed`. That would
   * strand the stamp on the instance (`handleWorkflowComplete` would later
   * misreport a successful run as `aborted`) and let a human APPROVE past a
   * turn that never ran. Throwing the dedicated error instead makes the
   * parent's `onError` take its `__isResumableStop` branch straight to the
   * abort-preserving terminal, with the checkpoint still pointing at the
   * fan-out state so `workflow resume` re-enters the batch (recorded lanes
   * are reconstructed from the DB, missing lanes re-run).
   *
   * The stamps can only have been set by THIS batch: any earlier stamp would
   * already have ended the run, and they are in-process only (a resumed run
   * starts clean, and checks the workflow budget again before its first
   * state).
   */
  private upstreamFailureAfterFanOut(instance: WorkflowInstance, fanOutStateId: string): Error | undefined {
    if (instance.quotaExhausted) {
      return new WorkflowQuotaExhaustedError({ stateId: fanOutStateId, ...instance.quotaExhausted });
    }
    if (instance.transientFailure) {
      return new WorkflowTransientFailureError({ stateId: fanOutStateId, ...instance.transientFailure });
    }
    if (instance.workflowBudgetExhausted) {
      const { breach } = instance.workflowBudgetExhausted;
      return new WorkflowBudgetExhaustedError({
        stateId: fanOutStateId,
        limitField: breach.limitField,
        used: breach.used,
        limit: breach.limit,
        detail: breach.message,
      });
    }
    return undefined;
  }

  private buildFanOutLaneContext(
    context: WorkflowContext,
    index: number,
    workers: number,
    preparedResults: Readonly<Record<string, DeterministicInvokeResult>> | undefined,
  ): WorkflowContext {
    if (workers === 1) return context;
    return {
      ...context,
      lane: {
        id: index,
        dir: `${DEFAULT_EVOLVE_LANE_DIR}/lane_${index}`,
        relativeDir: `${DEFAULT_EVOLVE_LANE_RELATIVE_DIR}/lane_${index}`,
        ...(preparedResults !== undefined ? { preparedResults } : {}),
      },
    };
  }

  /**
   * Reconstructs an in-flight evolve fan-out batch from the durable engine DB.
   *
   * This intentionally does NOT use XState child persistence. The checkpoint
   * stores `{ machineState, context }` and `resolveState()` re-enters `workers`
   * without live child ActorRefs; free-standing child actors created in the old
   * process are gone. First-cut crash-resume therefore treats `nodes.json` as the
   * source of truth: a recorded `step_<batch>_lane_<k>` means lane k is already
   * done and must be synthesized, while every missing lane is re-spawned fresh
   * from `sample`. That fresh re-run can produce a different verdict (§11.2
   * verdict drift), which is acceptable for node-integrity but not a promise of
   * batch-outcome reproducibility.
   *
   * Cross-language seam (deliberate, NOT accidental duplication). The batch-index
   * reuse rule below re-implements Python `_next_batch_index(run_dir, workers)`.
   * We re-derive it here rather than consume the bridge's `sample_batch_prepared`
   * echo because the index is needed BEFORE `sample_batch` runs: TS must know it
   * to decide synthesize-vs-respawn per lane AND to pin `--batch-index` into the
   * very `sample_batch` call whose output would otherwise echo it. Having the
   * bridge be authoritative would invert that ordering. So the two derivations
   * MUST move together — TS pins `--batch-index` whenever any lane is recorded (so
   * the bridge cannot diverge), and recomputes the identical number when none is.
   * Both sides cite the shared `step_<batch>_lane_<k>` format (`evolveStepName` /
   * the Python f-string) as the contract.
   */
  private reconstructFanOutBatchFromDb(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    segment: readonly string[],
    workers: number,
  ): FanOutDbReconstructionResult {
    if (workers === 1) return { kind: 'unavailable' };

    const runDir = this.evolveRunDirForFanOutSegment(definition, segment);
    if (!runDir) return { kind: 'unavailable' };

    const runDirRelative = this.containerPathToWorkspaceRelative(runDir);
    if (!runDirRelative) return { kind: 'unavailable' };

    const nodes = this.readEvolveNodes(
      instance.workspacePath,
      posix.join(runDirRelative, 'database_data', 'nodes.json'),
    );
    if (nodes.error !== undefined) return { kind: 'error', error: nodes.error };

    const expectedLanes = Array.from({ length: workers }, (_, index) => index);
    const lanesByBatch = new Map<number, Set<number>>();
    const recordedByStep = new Map<string, EvolveRecordedLane>();
    let highestBatch = 0;

    for (const [nodeKey, rawNode] of nodes.entries) {
      const node = this.asRecord(rawNode);
      if (!node) continue;
      const meta = this.asRecord(node.meta_info);
      const stepName = typeof meta?.step_name === 'string' ? meta.step_name : undefined;
      if (!stepName) continue;
      const match = EVOLVE_LANE_STEP_RE.exec(stepName);
      if (!match) continue;

      const batchIndex = Number.parseInt(match[1], 10);
      highestBatch = Math.max(highestBatch, batchIndex);
      // Group 2 (the lane id) is undefined for a legacy non-lane `step_<batch>`
      // node; only lane-tagged nodes participate in fan-out reconstruction.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- an unmatched optional regex group is `undefined` at runtime, but the type is `string`
      if (match[2] === undefined) continue;

      const lane = Number.parseInt(match[2], 10);
      lanesByBatch.set(batchIndex, (lanesByBatch.get(batchIndex) ?? new Set<number>()).add(lane));
      recordedByStep.set(stepName, {
        index: lane,
        batchIndex,
        stepName,
        nodeId: this.nodeIdFromRecord(node, nodeKey),
        parent: this.nodeParentFromRecord(node),
        stepDir: `${runDir}/steps/${stepName}`,
      });
    }

    // Reuse-vs-advance heuristic — the crux of crash-resume, and the TS twin of
    // Python `_next_batch_index(run_dir, workers)` (scripts/evolve_result.py).
    // The highest lane-tagged batch whose CURRENT-worker lanes are only
    // PARTIALLY present (some expected lane is missing) is the batch that was
    // in flight when we crashed → REUSE its index, so the re-run lanes write the
    // SAME `step_<batch>_lane_<k>` names and stay idempotent against the records
    // that already landed. A fully-recorded highest batch (every expected lane
    // present) or a fully-drained one (no lane-tagged nodes, so highestLanes is
    // empty) is finished → advance to `highestBatch + 1`. This must match the
    // Python reuse rule exactly: when recordedByLane is non-empty we PIN
    // `--batch-index` to this value (so the bridge cannot diverge); when it is
    // empty we pass no `--batch-index` and the bridge recomputes the same number.
    // The shared `step_<batch>_lane_<k>` format (evolveStepName / the Python
    // f-string) is the contract both sides cite; keep this block and
    // `_next_batch_index` in lockstep — same seam as STEP_NAME_RE ↔ EVOLVE_LANE_STEP_RE.
    const highestLanes = lanesByBatch.get(highestBatch) ?? new Set<number>();
    const batchIndex =
      highestBatch > 0 && highestLanes.size > 0 && expectedLanes.some((lane) => !highestLanes.has(lane))
        ? highestBatch
        : highestBatch + 1;
    const recordedByLane = new Map<number, EvolveRecordedLane>();
    for (const lane of expectedLanes) {
      const recorded = recordedByStep.get(evolveStepName(batchIndex, lane));
      if (recorded !== undefined) recordedByLane.set(lane, recorded);
    }
    const missingLanes = expectedLanes.filter((lane) => !recordedByLane.has(lane));

    if (recordedByLane.size > 0) {
      instance.tab.write(
        `[fanout] Reconstructed "${segment[0]}" batch ${batchIndex}: ` +
          `${recordedByLane.size} recorded, ${missingLanes.length} to re-run`,
      );
    }

    return {
      kind: 'ready',
      reconstruction: {
        batchIndex,
        recordedByLane,
        missingLanes,
        runDir,
      },
    };
  }

  /**
   * The evolve `--run-dir` for this fan-out segment's `sample` head, or
   * `undefined` when the segment head is not a deterministic evolve sample
   * command. `undefined` makes {@link reconstructFanOutBatchFromDb} return
   * `unavailable`, so resume falls back to re-spawning all lanes fresh.
   */
  private evolveRunDirForFanOutSegment(definition: WorkflowDefinition, segment: readonly string[]): string | undefined {
    const sampleStateId = segment[0];
    const sampleState = definition.states[sampleStateId];
    if (sampleState.type !== 'deterministic') return undefined;
    const sampleCommand = sampleState.run.find((command) => this.isEvolveSampleCommand(command));
    return sampleCommand ? this.commandFlagValue(sampleCommand, '--run-dir') : undefined;
  }

  /**
   * Reads the engine `nodes.json` node map. Missing file ⇒ `{ entries: [] }`
   * with NO error — a fresh batch (or a run that has not recorded any node yet)
   * is a normal pre-crash state and must reconstruct as "nothing recorded". A
   * read or JSON-parse failure ⇒ an `error`, which aborts the fan-out: a corrupt
   * DB is NOT safe to treat as empty (we would re-run lanes that may already be
   * recorded), so the missing-vs-corrupt distinction is load-bearing.
   *
   * The file lives in the agent-writable workspace, so it is read through
   * {@link readUntrustedRegularFileBelow}: a FIFO, a symlink (to /dev/zero or
   * anywhere else), a symlinked directory leading out of the workspace, or a
   * file over {@link MAX_EVOLVE_NODES_BYTES} is a read error (fail closed),
   * never a blocking or unbounded read in the daemon.
   */
  private readEvolveNodes(
    workspacePath: string,
    nodesRelativePath: string,
  ): { entries: ReadonlyArray<readonly [string, unknown]>; error?: string } {
    const nodesPath = resolve(workspacePath, nodesRelativePath);
    let raw: string;
    try {
      raw = readUntrustedRegularFileBelow(workspacePath, nodesRelativePath, {
        maxBytes: MAX_EVOLVE_NODES_BYTES,
      }).bytes.toString('utf-8');
    } catch (err) {
      if (err instanceof UntrustedFileError && err.code === 'NOT_FOUND') return { entries: [] };
      return { entries: [], error: `could not read evolve nodes DB ${nodesPath}: ${errorMessage(err)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { entries: [], error: `could not parse evolve nodes DB ${nodesPath}: ${errorMessage(err)}` };
    }

    const root = this.asRecord(parsed);
    const nodes = this.asRecord(root?.nodes);
    return { entries: nodes ? Object.entries(nodes) : [] };
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private nodeIdFromRecord(node: Record<string, unknown>, fallback: string): number | undefined {
    const raw = node.id;
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    const parsed = Number.parseInt(fallback, 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  }

  /**
   * The node's parent lineage as a tri-state: `undefined` when the record has no
   * `parent` array at all (omit the field from the synthesized payload — lineage
   * unknown), `[]` for a root node (an explicit empty array — root, not omitted),
   * and `[...ids]` for a child's parent ids. The empty-vs-undefined distinction
   * is preserved deliberately so {@link synthesizeRecordedFanOutOutcome} can omit
   * an unknown parent while still echoing an explicit root.
   */
  private nodeParentFromRecord(node: Record<string, unknown>): readonly number[] | undefined {
    if (!Array.isArray(node.parent)) return undefined;
    const parent = node.parent.filter((item): item is number => typeof item === 'number' && Number.isInteger(item));
    return parent.length > 0 ? parent : [];
  }

  /**
   * Builds the barrier outcome for a lane that already recorded before a crash.
   * The durable node proves the lane advanced; the volatile child actor context
   * (visit counts, token spend, in-flight state) is not recoverable without the
   * deferred `getPersistedSnapshot()` + in-context spawn migration, so this is a
   * minimal recorded context sufficient for join, promotion, and duplicate stats.
   *
   * Edge cases (the contract callers rely on):
   * - Called ONLY for a lane the engine DB already recorded — i.e. the
   *   just-before-crash case where the node landed but the process died before
   *   the join. Every NOT-recorded lane is re-spawned instead (see the fork in
   *   {@link runFanOutSegment}).
   * - Does NOT rebuild on-disk artifacts. The lane's `analysis.md` /
   *   `analysis_record.json` may be absent post-crash, but the durable node is
   *   authoritative, so a fabricated `lastDeterministicResult` with
   *   `{ verdict: 'recorded', idempotent_skip: true }` is sufficient — nothing
   *   downstream re-reads those files for a recorded lane.
   * - `idempotent_skip: true` is the marker that this outcome was synthesized
   *   (vs produced by a live re-run); the returned `recorded` outcome is
   *   otherwise indistinguishable to {@link joinFanOutBatch} from a live-recorded
   *   lane, so the join, promotion, and duplicate-rate paths need no special case.
   */
  private synthesizeRecordedFanOutOutcome(
    input: FanOutInvokeInput,
    segment: readonly string[],
    workers: number,
    recorded: EvolveRecordedLane,
  ): RoundChildOutcome {
    const base = this.buildFanOutLaneContext(input.context, recorded.index, workers, undefined);
    const payload: Record<string, unknown> = {
      step_name: recorded.stepName,
      idempotent_skip: true,
      ...(recorded.nodeId !== undefined ? { node_id: recorded.nodeId } : {}),
      ...(recorded.parent !== undefined ? { parent: [...recorded.parent] } : {}),
      ...(recorded.stepDir !== undefined ? { step_dir: recorded.stepDir } : {}),
    };
    return {
      index: recorded.index,
      status: 'recorded',
      context: {
        ...base,
        round: base.round + 1,
        previousStateName: segment[segment.length - 1] ?? input.stateId,
        lastDeterministicResult: {
          verdict: 'recorded',
          payload,
        },
      },
    };
  }

  /**
   * Runs the ONE barrier-side `sample_batch(n=workers)` before fan-out and
   * partitions its result into per-lane pre-computed `sample` results (keyed by
   * lane id) that {@link executeDeterministicState} replays as each child's
   * `sample` step.
   *
   * WHY one barrier-side `sample_batch(n=N)` and NOT N independent `sample()`
   * calls: the divergence between lanes is INJECTED at sampling (§7.4). N
   * independent `sample()` calls each reload the same `nodes.json` and, with a
   * diversity-maintaining sampler, could draw the SAME parent into multiple
   * lanes — collapsing the N-wide frontier into "N samples of one distribution"
   * and producing near-duplicate candidates. A single `sample_batch` over the
   * whole DB partitions N DISTINCT parents (one per lane) in one serialized,
   * read-only DB touch, guaranteeing disjoint parent sets up front. The bridge
   * uses a per-lane seed offset (`base_seed + laneId`) to decorrelate the lanes
   * while keeping the partition reproducible, with a deterministic hash tiebreak
   * so the assignment is stable across resume (§7.4).
   *
   * `workers === 1` short-circuits: the single lane uses the legacy inline
   * `sample` step (byte-identical backward compat, gate item 1), so there is no
   * batch to prepare. A non-deterministic or unrecognized sample state likewise
   * returns an empty map (the child runs its own `sample`).
   */
  private async prepareFanOutLaneResults(
    workflowId: WorkflowId,
    input: FanOutInvokeInput,
    definition: WorkflowDefinition,
    segment: readonly string[],
    workers: number,
    options: FanOutBatchOptions = {},
  ): Promise<{ byLane: Record<number, Readonly<Record<string, DeterministicInvokeResult>>>; error?: string }> {
    if (workers === 1) return { byLane: {} };
    const expectedLanes = options.lanes ?? Array.from({ length: workers }, (_, index) => index);
    if (expectedLanes.length === 0) return { byLane: {} };

    const sampleStateId = segment[0];
    const sampleState = definition.states[sampleStateId];
    if (sampleState.type !== 'deterministic') return { byLane: {} };

    const batchInput = this.buildEvolveSampleBatchInput(sampleStateId, sampleState, input.context, workers, options);
    if (!batchInput) return { byLane: {} };

    const result = await this.executeDeterministicState(workflowId, batchInput);
    if (!result.passed || result.verdict !== 'sample_batch_prepared') {
      return {
        byLane: {},
        error: result.errors ?? `fan-out sample batch failed with verdict ${result.verdict ?? 'unknown'}`,
      };
    }

    const lanes = Array.isArray(result.payload?.lanes) ? result.payload.lanes : undefined;
    if (!lanes) {
      return { byLane: {}, error: 'fan-out sample batch did not return a lanes array' };
    }

    const byLane: Record<number, Readonly<Record<string, DeterministicInvokeResult>>> = {};
    for (const lanePayload of lanes) {
      if (!lanePayload || typeof lanePayload !== 'object' || Array.isArray(lanePayload)) continue;
      const laneId = (lanePayload as { lane?: unknown }).lane;
      if (typeof laneId !== 'number' || !Number.isInteger(laneId) || laneId < 0 || laneId >= workers) continue;
      if (!expectedLanes.includes(laneId)) continue;
      byLane[laneId] = {
        [sampleStateId]: {
          passed: true,
          verdict: 'sampled',
          payload: lanePayload as Record<string, unknown>,
        },
      };
    }

    const missing = expectedLanes.filter((index) => !(index in byLane));
    if (missing.length > 0) {
      return { byLane: {}, error: `fan-out sample batch omitted lane(s): ${missing.join(', ')}` };
    }

    return { byLane };
  }

  /**
   * Derives the deterministic invoke input for the barrier-side `sample_batch`
   * from the segment head's declared `sample` command: rewrites the `sample`
   * subcommand to `sample_batch`, adds `--workers <N>`, carries over the
   * query/top-k flags, and points `--result-file` at the shared
   * `current/sample_batch.json` (the batch artifact is barrier-owned, not
   * lane-scoped). Returns `undefined` (the caller then lets each child sample on
   * its own) when the segment head is not a recognizable evolve `sample`
   * command, has no `evolve_result.py` entry, or lacks a `--run-dir` / resolvable
   * workspace-relative result path.
   */
  private buildEvolveSampleBatchInput(
    stateId: string,
    state: DeterministicStateDefinition,
    context: WorkflowContext,
    workers: number,
    options: FanOutBatchOptions = {},
  ): DeterministicInvokeInput | undefined {
    const sampleCommand = state.run.find((command) => this.isEvolveSampleCommand(command));
    if (!sampleCommand) return undefined;
    return this.buildEvolveBarrierInput(stateId, state, sampleCommand, context, {
      stateIdSuffix: '_batch',
      subcommand: 'sample_batch',
      resultBasename: 'sample_batch.json',
      extraArgs: [
        '--workers',
        String(workers),
        ...(options.lanes !== undefined ? options.lanes.flatMap((lane) => ['--lane', String(lane)]) : []),
        ...(options.batchIndex !== undefined ? ['--batch-index', String(options.batchIndex)] : []),
        ...this.sampleQueryArgs(sampleCommand),
        ...this.sampleTopKArgs(sampleCommand),
      ],
    });
  }

  /**
   * Shared skeleton for the three barrier-side `evolve_result.py` invocations
   * (`sample_batch`, `promote_cognition`, `compute_stop_signals`). Given an
   * already-resolved `sourceCommand` (the caller does the `state.run.find`), it
   * locates the bridge path, carries over `--run-dir`, rewrites the subcommand,
   * splices in the per-caller `extraArgs`, and points `--result-file` at the
   * shared barrier artifact `current/<resultBasename>`. Returns `undefined` when
   * the source command lacks the bridge path, a `--run-dir`, or a resolvable
   * workspace-relative result path — the caller's documented no-op signal.
   */
  private buildEvolveBarrierInput(
    stateId: string,
    state: DeterministicStateDefinition,
    sourceCommand: readonly string[],
    context: WorkflowContext,
    options: { stateIdSuffix: string; subcommand: string; resultBasename: string; extraArgs?: readonly string[] },
  ): DeterministicInvokeInput | undefined {
    const scriptIndex = evolveResultScriptIndex(sourceCommand);
    if (scriptIndex < 0) return undefined;
    const runDir = this.commandFlagValue(sourceCommand, '--run-dir');
    if (!runDir) return undefined;

    const resultFile = `${runDir}/current/${options.resultBasename}`;
    const workspaceRelativeResultFile = this.containerPathToWorkspaceRelative(resultFile);
    if (!workspaceRelativeResultFile) return undefined;

    const command = [
      ...sourceCommand.slice(0, scriptIndex + 1),
      options.subcommand,
      '--run-dir',
      runDir,
      ...(options.extraArgs ?? []),
      '--result-file',
      resultFile,
    ];

    return {
      stateId: `${stateId}${options.stateIdSuffix}`,
      commands: [command],
      context,
      container: state.container ?? false,
      host: state.host,
      containerScope: state.containerScope,
      timeoutMs: state.timeoutMs,
      resultFile: workspaceRelativeResultFile,
    };
  }

  private isEvolveSampleCommand(command: readonly string[]): boolean {
    const scriptIndex = evolveResultScriptIndex(command);
    return scriptIndex >= 0 && command[scriptIndex + 1] === 'sample';
  }

  private isEvolveAttachAnalysisCommand(command: readonly string[]): boolean {
    const scriptIndex = evolveResultScriptIndex(command);
    return scriptIndex >= 0 && command[scriptIndex + 1] === 'attach_analysis';
  }

  private commandFlagValue(command: readonly string[], flag: string): string | undefined {
    const index = command.indexOf(flag);
    if (index < 0) return undefined;
    return command[index + 1];
  }

  private sampleQueryArgs(command: readonly string[]): string[] {
    if (command.includes('--query-from-spec')) return ['--query-from-spec'];
    const query = this.commandFlagValue(command, '--query');
    return query !== undefined ? ['--query', query] : [];
  }

  private sampleTopKArgs(command: readonly string[]): string[] {
    const topK = this.commandFlagValue(command, '--top-k');
    return topK !== undefined ? ['--top-k', topK] : [];
  }

  private containerPathToWorkspaceRelative(path: string): string | undefined {
    const prefix = `${CONTAINER_WORKSPACE_DIR}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
  }

  /**
   * Barrier primitive for one lane. Returns a {@link RoundChildWaiter} (NOT a
   * bare Promise): a two-phase handle whose `promise` resolves by EITHER of two
   * routes, and whose `drain`/`isSettled` members let the fan-out pump stop and
   * inspect the lane externally.
   *
   * The two resolution routes and the discriminator {@link joinFanOutBatch} reads:
   * - NATURAL SETTLE — the child's own snapshot reaches a `final` state
   *   (`status === 'done'`), resolving with `recorded`/`blocked`/`errored` and
   *   `drainedBy: undefined`. A free-standing child fires no parent-visible
   *   `onDone`, so the parent watches the child's OWN snapshot (§6.2) via
   *   subscribe-until-done rather than an `xstate.done.actor` event.
   * - DRAIN — an external `drain(trigger)` call (a peer blocked/errored) stops
   *   the actor and resolves with status `drained` and a populated `drainedBy`.
   *   `drainedBy` being set vs `undefined` is exactly how the join distinguishes
   *   a drained peer from a naturally-settled lane.
   *
   * `isSettled` is first-wins: whichever route fires first latches `settled`, so
   * a lane that RECORDED before the drain reached it keeps its real `recorded`
   * outcome (the drain is a no-op on an already-settled lane).
   *
   * After the child `onError` -> `errored` fix, a segment-member service
   * rejection becomes a normal `errored` TERMINAL (status `done`, value
   * `errored`) and resolves here; the `status === 'error'` branch is the
   * residual safety net for an actor-level throw the `errored` terminal did not
   * catch (e.g. an entry-action throw), which resolves as an `errored` lane so
   * drain-on-escalation can still stop peers and the join can report the full
   * batch.
   *
   * WHY a hand-rolled subscribe loop and NOT `xstate`'s `waitFor`: `waitFor`
   * resolves only when the actor's OWN snapshot stream matches a predicate. The
   * drain route resolves the SAME promise from OUTSIDE that stream (the pump
   * synthesizes a `drained` outcome the instant it stops the actor, without
   * waiting for any in-flight external service call to settle, FSM-M3). `waitFor`
   * cannot express that external resolver, so the two-phase waiter is kept.
   *
   * The trailing `observe(actor.getSnapshot())` after `subscribe` guards the
   * synchronous-settle-before-subscribe race: a child whose first state
   * settles synchronously (e.g. a sync entry-action throw) can already be
   * `done`/`error` by the time `.subscribe` returns, so the subscription would
   * never deliver that final snapshot. Observing the current snapshot once,
   * immediately, closes the lane in that case.
   */
  private waitForRoundChild(
    actor: AnyActorRef,
    index: number,
    onDrainTrigger: (trigger: RoundChildDrainTrigger) => void,
  ): RoundChildWaiter {
    let settled = false;
    let subscription: { unsubscribe: () => void } | undefined;
    let finishOutcome: (outcome: RoundChildOutcome) => void = () => {};

    const promise = new Promise<RoundChildOutcome>((resolvePromise) => {
      const finish = (outcome: RoundChildOutcome): void => {
        if (settled) return;
        settled = true;
        subscription?.unsubscribe();
        resolvePromise(outcome);
        if (outcome.status === 'blocked' || outcome.status === 'errored') {
          // Compute the surfaced reason ONCE here, at the trigger source, and
          // thread it on the trigger so the drain log and every drained peer's
          // `drainedBy` reuse it rather than re-deriving (§ dedup).
          onDrainTrigger({
            index: outcome.index,
            status: outcome.status,
            context: outcome.context,
            reason: this.roundChildReason(outcome),
          });
        }
      };
      finishOutcome = finish;

      const observe = (snapshot: unknown): void => {
        const snap = snapshot as {
          readonly status?: string;
          readonly value?: unknown;
          readonly context?: WorkflowContext;
          readonly error?: unknown;
        };
        if (snap.status === 'done') {
          finish({
            index,
            status: toRoundChildStatus(snap.value, index),
            context: snap.context as WorkflowContext,
          });
        } else if (snap.status === 'error') {
          const reason = snap.error ?? `fan-out child ${index} errored`;
          finish({
            index,
            status: 'errored',
            context: snap.context as WorkflowContext,
            drainedBy: undefined,
          });
          writeStderr(`[workflow] fan-out child ${index} actor error: ${toErrorMessage(reason)}`);
        }
      };
      subscription = actor.subscribe(observe);
      observe(actor.getSnapshot());
    });

    return {
      index,
      actor,
      promise,
      isSettled: () => settled,
      drain: (trigger) => {
        if (settled) return;
        const snapshot = actor.getSnapshot() as { context?: WorkflowContext };
        const context = snapshot.context ?? trigger.context;
        actor.stop();
        // Resolve directly after stop(): the stopped actor will not enter its
        // next state, while any already-started external promise may still finish
        // out-of-band (nothing interrupts an in-flight agent turn, FSM-M3; a
        // deterministic command is killed, but its promise settles later).
        // stop() aborts the in-flight invoke's signal, so a drained
        // agent invocation starts no further turn and stamps nothing, and
        // cyclePolicy waits for its in-flight turn before swapping the shared
        // coordinator to another persona (executeAgentState).
        finishOutcome({
          index,
          status: 'drained',
          context,
          drainedBy: { index: trigger.index, status: trigger.status, reason: trigger.reason },
        });
      },
      stop: () => {
        if (settled) return;
        const { context } = actor.getSnapshot() as { context: WorkflowContext };
        // Same mechanics as a drain, for an abort: the stopped lane enters no
        // further state and its in-flight invoke is detached; with no peer
        // trigger the outcome is a bare `drained`, which an aborted run never
        // joins (runFanOutSegment bails once the batch settles).
        actor.stop();
        finishOutcome({ index, status: 'drained', context });
      },
    };
  }

  /**
   * Folds the settled lane outcomes into a single parent-edge result, applying
   * a fixed verdict precedence (worst lane wins):
   *   1. any rejected settle -> `result_file_error` (a residual actor-level
   *      throw that did not resolve as an `errored` lane);
   *   2. else any `blocked` lane -> `escalate` (route once to human review,
   *      with every blocked/errored lane reason aggregated);
   *   3. else any `errored` lane -> `result_file_error` (explicit fail mapping);
   *   4. else any `drained` lane without an issue trigger -> `result_file_error`;
   *   5. else all `recorded` -> `recorded` (the batch advanced).
   *
   * WHY `Promise.allSettled` (not `Promise.all`) upstream: one lane's rejection
   * must not abandon its N-1 in-flight peers (FSM-S5). `all` would reject on the
   * first throw and lose the other lanes' outcomes; `allSettled` lets the join
   * see the full batch, including parent-synthesized `drained` peer outcomes.
   *
   * For `workers: 1`, the recorded path still promotes the single child context
   * exactly. For N>1, the recorded path folds lane contexts into a parent batch
   * context: child artifacts/conversations merge, parent visit counts remain
   * authoritative for the single-active-state spine, and total tokens come
   * from the run's usage meter (every lane's exchanges).
   */
  private joinFanOutBatch(
    instance: WorkflowInstance,
    input: FanOutInvokeInput,
    settled: readonly PromiseSettledResult<RoundChildOutcome>[],
  ): FanOutInvokeResult {
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      return this.fanOutErrorResult(instance, input, 'join', toErrorMessage(rejected.reason));
    }

    const children = settled.map((result) => {
      if (result.status !== 'fulfilled') {
        throw new Error('unreachable rejected fan-out result after rejection check');
      }
      return result.value;
    });
    const first = children[0];
    const childSummaries: RoundChildSummary[] = children.map((child) => ({
      index: child.index,
      status: child.status,
      // Carry `drainedBy` through to the join log so observability records which
      // lane's escalation stopped each drained peer (the bare `drained` status
      // alone does not say). NOTE (drain-first, § consider): `issues` below is the
      // blocked/errored-AT-DRAIN set only — a peer that WOULD have blocked but was
      // drained first is reported here as `drained`, NOT as an issue in the gate.
      ...(child.drainedBy !== undefined ? { drainedBy: child.drainedBy } : {}),
    }));
    const issues = this.fanOutIssues(children);

    if (issues.some((issue) => issue.status === 'blocked')) {
      const source = children.find((child) => child.status === 'blocked') ?? first;
      const summary = this.formatFanOutIssues('Fan-out batch escalated after blocked lane(s):', issues);
      return {
        passed: false,
        verdict: 'escalate',
        errors: summary,
        payload: { issues },
        context: this.promoteFanOutIssueContext(instance, input.context, input.stateId, source, 'escalate', issues),
        children: childSummaries,
      };
    }

    if (issues.some((issue) => issue.status === 'errored')) {
      const source = children.find((child) => child.status === 'errored') ?? first;
      const summary = this.formatFanOutIssues('Fan-out batch failed after errored lane(s):', issues);
      return {
        passed: false,
        verdict: DETERMINISTIC_RESULT_ERROR_VERDICT,
        errors: summary,
        payload: { issues },
        context: this.promoteFanOutIssueContext(
          instance,
          input.context,
          input.stateId,
          source,
          DETERMINISTIC_RESULT_ERROR_VERDICT,
          issues,
        ),
        children: childSummaries,
      };
    }

    const drained = children.find((child) => child.status === 'drained');
    if (drained) {
      const errors = `fan-out child ${drained.index} was drained without a blocked or errored trigger`;
      this.reportFanOutFailure(instance, input.stateId, 'join', errors);
      return {
        passed: false,
        verdict: DETERMINISTIC_RESULT_ERROR_VERDICT,
        errors,
        context: this.promoteFanOutContext(instance, input.context, drained.context),
        children: childSummaries,
      };
    }

    return {
      passed: true,
      verdict: 'recorded',
      context:
        children.length === 1 ? first.context : this.mergeRecordedFanOutContext(instance, input.context, children),
      children: childSummaries,
    };
  }

  /**
   * Projects the blocked/errored lanes (the offenders) into the {@link FanOutIssue}
   * payload that lands in the aggregated gate. Drained peers are intentionally
   * excluded — they are the drain-first collateral, not independent issues (§ the
   * reason list is the blocked-at-drain set, not all-would-have-blocked).
   */
  private fanOutIssues(children: readonly RoundChildOutcome[]): FanOutIssue[] {
    return children
      .filter((child) => child.status === 'blocked' || child.status === 'errored')
      .map((child) => ({
        index: child.index,
        status: child.status as 'blocked' | 'errored',
        reason: this.roundChildReason(child),
      }));
  }

  /**
   * Surfaces a one-line human-readable cause for a blocked/errored lane, with an
   * ASYMMETRIC fallback order per status — THE footgun this method guards:
   *
   * - `errored` prefers `lastError` then `previousAgentOutput`: an errored lane
   *   DID trip `storeError`, so `lastError` is the populated, authoritative cause.
   * - `blocked` prefers `previousAgentOutput` then `lastError`: a blocked lane
   *   (evaluator_blocked) never trips `storeError`, so its `lastError` is null and
   *   the real reason lives on `previousAgentOutput` (the evaluator's message).
   *
   * Do NOT collapse the two branches into one fallback chain: a unified order
   * would surface a stale/null field for one of the two statuses. This rationale
   * was deleted from the old call sites and is re-homed here on purpose.
   */
  private roundChildReason(child: Pick<RoundChildOutcome, 'index' | 'status' | 'context'>): string {
    if (child.status === 'errored') {
      return (
        child.context.lastError ??
        child.context.previousAgentOutput ??
        `fan-out child ${child.index} ended in "${child.status}"`
      );
    }
    return (
      child.context.previousAgentOutput ??
      child.context.lastError ??
      `fan-out child ${child.index} ended in "${child.status}"`
    );
  }

  /** Renders an issue list as a header line plus one `- lane <i> <status>: <reason>` bullet per offending lane. */
  private formatFanOutIssues(header: string, issues: readonly FanOutIssue[]): string {
    if (issues.length === 0) return header;
    return [header, ...issues.map((issue) => `- lane ${issue.index} ${issue.status}: ${issue.reason}`)].join('\n');
  }

  /**
   * Builds the parent-spine context for a blocked/errored BATCH (the escalate and
   * errored-only join branches). WHAT it folds:
   * - the worst lane's context (`source`) promoted back onto the spine via
   *   {@link promoteFanOutContext} (lane marker stripped, parent visit counts
   *   restored, tokens from the run's usage meter);
   * - an AGGREGATED multi-lane summary of every blocked/errored lane written to
   *   `previousAgentOutput` (this is what the orchestrator reads on APPROVE→resume
   *   and the human reads in the gate banner);
   * - the same lanes as the structured `issues` payload on
   *   `lastDeterministicResult` for the gate.
   *
   * WHY ONE gate, not one per offending lane: all blocked/errored reasons fold
   * into a single payload so the human reviews the batch ONCE. The two verdict
   * shapes differ only in `lastError`: `escalate` leaves `lastError` null (a
   * blocked lane is recoverable, not an error), while the errored-only verdict
   * mirrors the summary into `lastError` (the batch failed).
   *
   * SCRATCH-SHAPE TAG (workers:1 vs workers>1 disambiguator): the orchestrator's
   * recovery prompt has two mutually-exclusive recoveries — legacy `evaluate`-
   * resume of the one written-but-unscored candidate (bare `current/`) vs discard
   * the lane scratch and start a fresh `design` batch (lane-scoped
   * `current/lane_<k>/`). At `workers:1` the lane carries NO `lane` marker and the
   * scratch is the BARE `current/`, so the legacy resume is the correct recovery;
   * at `workers>1` the lane scratch is under `current/lane_<k>/` and must be
   * discarded. The summary message alone ("Fan-out batch escalated…") would push
   * the LLM toward discard in BOTH cases, so we append an explicit scratch-shape
   * sentence derived from `source.context.lane` to steer the prompt's branch.
   */
  private promoteFanOutIssueContext(
    instance: WorkflowInstance,
    parentContext: WorkflowContext,
    fanOutStateId: string,
    source: RoundChildOutcome,
    verdict: string,
    issues: readonly FanOutIssue[],
  ): WorkflowContext {
    const summary = this.formatFanOutIssues(
      verdict === DETERMINISTIC_RESULT_ERROR_VERDICT
        ? 'Fan-out batch failed after errored lane(s):'
        : 'Fan-out batch escalated after blocked lane(s):',
      issues,
    );
    const scratchNote =
      source.context.lane === undefined
        ? '\nScratch is the bare current/ (a single candidate is written; result.json may be absent) — ' +
          'resume the round in place; do NOT discard and start a fresh batch.'
        : '\nScratch is lane-scoped under current/lane_<k>/ — discard the lane scratch and re-decide normally.';
    return {
      ...this.promoteFanOutContext(instance, parentContext, source.context),
      previousAgentOutput: `${summary}${scratchNote}`,
      previousAgentNotes: null,
      previousStateName: fanOutStateId,
      lastDeterministicResult: {
        verdict,
        payload: { issues: issues.map((issue) => ({ ...issue })) },
      },
      ...(verdict === DETERMINISTIC_RESULT_ERROR_VERDICT ? { lastError: summary } : { lastError: null }),
    };
  }

  /**
   * Promotes a SINGLE lane's context back onto the parent spine (the
   * blocked/errored drain paths, and the `workers: 1` recorded path where there
   * is exactly one lane). Strips the per-lane `lane` marker so the parent never
   * carries a lane identity, restores the parent's authoritative `visitCounts`
   * (the single-active-state spine owns visit accounting; a lane's own counts
   * are a within-batch detail, §7.5), and reads `totalTokens` from the run's
   * usage meter (every exchange of every lane and earlier state, the figure
   * `settings.workflowBudget` is checked against, NOT the lane's local copy).
   * The `lane === undefined` branch is the no-fan-out / `workers: 1` case:
   * there is no lane marker to strip, so only the token figure is refreshed.
   */
  private promoteFanOutContext(
    instance: WorkflowInstance,
    parentContext: WorkflowContext,
    laneContext: WorkflowContext,
  ): WorkflowContext {
    const totalTokens = instance.usage.snapshot().totalTokens;
    if (laneContext.lane === undefined) {
      return {
        ...laneContext,
        totalTokens,
      };
    }
    const withoutLane = this.withoutLaneContext(laneContext);
    return {
      ...withoutLane,
      visitCounts: parentContext.visitCounts,
      totalTokens,
    };
  }

  /**
   * Folds the N recorded lane contexts back into ONE parent-spine context at the
   * barrier join (the recorded happy path for `workers > 1`). This is the
   * highest-stakes merge in the fan-out: the parent FSM is single-active-state,
   * so after the batch it must hold a single coherent context even though N
   * child actors each evolved their own copy in parallel. Each field is merged
   * by a rule chosen for WHY it is correct on the spine, NOT by a uniform
   * strategy:
   *
   * - `visitCounts`: the PARENT's counts are authoritative and copied verbatim.
   *   The spine has a single active state (`workers`), entered once per batch;
   *   the children's per-lane visit counts are a within-batch bookkeeping detail
   *   (§7.5) that must not leak onto the parent, or the global round-limit
   *   backstop would see N× inflated counts.
   * - `round`: SUM of each lane's POSITIVE delta over the parent baseline
   *   (`max(0, child.round - parent.round)`). A batch advanced the search by as
   *   many rounds as lanes that progressed; summing positive deltas counts each
   *   advancing lane once and ignores any lane that did not move forward.
   * - `reviewHistory`: SUFFIX-append only — each lane's entries BEYOND the shared
   *   parent baseline are appended. Lanes start from the same parent
   *   reviewHistory, so a naive concat would replay the baseline N times; taking
   *   only the suffix past `parentContext.reviewHistory.length` avoids that N×
   *   duplication while still capturing every lane's new review notes.
   * - `humanPrompt`: NULLED. A human prompt is a single-turn directive consumed
   *   by one state entry; it has no meaning fanned across N lanes and must not
   *   survive the batch (a stale prompt would mis-route the next orchestrator
   *   turn).
   * - `totalTokens`: read from the run's usage meter (every exchange attributed
   *   to the run or its bundles), NOT summed from the children here — the meter
   *   already includes every lane's spend, and summing lane copies would count
   *   the shared pre-batch total N times.
   * - `artifacts` / `previousOutputHashes` / `agentConversationsByState`: shallow
   *   last-writer-wins merge over the parent baseline (lanes write disjoint,
   *   lane-scoped keys, so collisions are not expected; the parent baseline is
   *   the floor). The remaining scalar fields come from `last` (the
   *   highest-index lane), an arbitrary-but-deterministic representative.
   */
  private mergeRecordedFanOutContext(
    instance: WorkflowInstance,
    parentContext: WorkflowContext,
    children: readonly RoundChildOutcome[],
  ): WorkflowContext {
    const ordered = [...children].sort((a, b) => a.index - b.index);
    const last = ordered[ordered.length - 1]?.context ?? parentContext;
    const lastWithoutLane = this.withoutLaneContext(last);

    const artifacts = ordered.reduce<Record<string, string>>((acc, child) => ({ ...acc, ...child.context.artifacts }), {
      ...parentContext.artifacts,
    });
    const previousOutputHashes = ordered.reduce<Record<string, string>>(
      (acc, child) => ({ ...acc, ...child.context.previousOutputHashes }),
      { ...parentContext.previousOutputHashes },
    );
    const agentConversationsByState = ordered.reduce<Record<string, AgentConversationId>>(
      (acc, child) => ({ ...acc, ...child.context.agentConversationsByState }),
      { ...parentContext.agentConversationsByState },
    );
    const roundDelta = ordered.reduce((sum, child) => sum + Math.max(0, child.context.round - parentContext.round), 0);

    return {
      ...lastWithoutLane,
      artifacts,
      previousOutputHashes,
      agentConversationsByState,
      visitCounts: parentContext.visitCounts,
      reviewHistory: ordered.reduce<readonly string[]>(
        (acc, child) =>
          child.context.reviewHistory.length > parentContext.reviewHistory.length
            ? [...acc, ...child.context.reviewHistory.slice(parentContext.reviewHistory.length)]
            : acc,
        parentContext.reviewHistory,
      ),
      round: parentContext.round + roundDelta,
      totalTokens: instance.usage.snapshot().totalTokens,
      humanPrompt: null,
    };
  }

  private withoutLaneContext(context: WorkflowContext): WorkflowContext {
    const copy: WorkflowContext = { ...context };
    delete (copy as { lane?: unknown }).lane;
    return copy;
  }

  private logFanOutJoin(
    instance: WorkflowInstance,
    fanOutState: string,
    workers: number,
    result: FanOutInvokeResult,
    settled: readonly PromiseSettledResult<RoundChildOutcome>[],
  ): void {
    const fulfilled = settled
      .filter((entry): entry is PromiseFulfilledResult<RoundChildOutcome> => entry.status === 'fulfilled')
      .map((entry) => entry.value);
    const duplicateStats =
      result.verdict === 'recorded' ? this.computeFanOutCandidateDuplicateStats(instance, fulfilled) : undefined;

    instance.messageLog.append({
      ...this.logBase(instance),
      type: 'fanout_join',
      fanOutState,
      workers,
      verdict: result.verdict ?? null,
      ...(duplicateStats !== undefined ? duplicateStats : {}),
      children:
        result.children ??
        fulfilled.map((child) => ({
          index: child.index,
          status: child.status,
        })),
    });

    if (duplicateStats !== undefined) {
      instance.tab.write(
        `[fanout] "${fanOutState}" duplicate_rate=${duplicateStats.duplicateRate.toFixed(3)} ` +
          `(${duplicateStats.duplicateCount}/${duplicateStats.candidateCount})`,
      );
    }
  }

  /**
   * Measures effective lane diversity for one recorded batch by content-hashing
   * each lane's candidate source and counting byte-identical collisions.
   *
   * WHY content-hash at fan-in (not assume effective-N = N): distinct sampled
   * parents do NOT guarantee distinct candidates (§7.4). Convergent lanes — the
   * researcher LLM collapsing two different parents into the same edit, or a
   * degenerate sampler handing out overlapping parents — can produce
   * byte-identical candidates, so "N lanes" can have an effective diversity
   * below N. Hashing the recorded `steps/<step>/code` files surfaces that as an
   * observable duplicate rate instead of pretending every lane added a distinct
   * candidate; the operator reads it as a signal to tune the diversity knobs.
   * It is a diagnostic, NOT a gate — duplicates are still recorded as distinct
   * nodes (the engine assigns each its own id, §7.6).
   *
   * Every skip is best-effort, NOT an error: a missing step_name, a candidate
   * file that does not exist yet, or a non-recorded lane is simply omitted from
   * the sample rather than failing the join — a diagnostic must never block a
   * batch that otherwise recorded cleanly. The `undefined` return is the
   * "nothing measurable" contract: when no lane yielded a hashable candidate
   * (every lane skipped), there is no diversity to report and the caller logs no
   * duplicate stats at all (distinct from a measured `duplicateRate: 0`).
   *
   * `step_name` comes from a result file the lane's container wrote, so only
   * the bridge's own `step_<batch>(_lane_<k>)?` spelling is joined into a host
   * path, and each candidate is streamed through the hash by
   * {@link hashUntrustedRegularFileBelow} (no-follow, non-blocking, capped at
   * {@link MAX_EVOLVE_CANDIDATE_BYTES}). A candidate that is a symlink, FIFO,
   * oversized or outside the workspace is skipped and noted on the tab.
   */
  private computeFanOutCandidateDuplicateStats(
    instance: WorkflowInstance,
    children: readonly RoundChildOutcome[],
  ):
    | {
        duplicateRate: number;
        duplicateCount: number;
        uniqueCandidates: number;
        candidateCount: number;
      }
    | undefined {
    const hashes: string[] = [];
    for (const child of children) {
      if (child.status !== 'recorded') continue;
      const stepName = child.context.lastDeterministicResult?.payload?.step_name;
      if (typeof stepName !== 'string' || !EVOLVE_LANE_STEP_RE.test(stepName)) continue;
      // Path layout owned by the Python bridge — see EVOLVE_STEP_CODE_PATH_SEGMENTS.
      const candidateRelativePath = [...EVOLVE_STEP_CODE_PATH_SEGMENTS, stepName, EVOLVE_STEP_CODE_FILENAME].join('/');
      try {
        hashes.push(
          hashUntrustedRegularFileBelow(instance.workspacePath, candidateRelativePath, {
            maxBytes: MAX_EVOLVE_CANDIDATE_BYTES,
          }),
        );
      } catch (err) {
        if (!(err instanceof UntrustedFileError && err.code === 'NOT_FOUND')) {
          instance.tab.write(
            `[fanout] duplicate stats skipped candidate ${candidateRelativePath}: ${err instanceof UntrustedFileError ? err.code : errorMessage(err)}`,
          );
        }
      }
    }

    if (hashes.length === 0) return undefined;
    const uniqueCandidates = new Set(hashes).size;
    const duplicateCount = hashes.length - uniqueCandidates;
    return {
      duplicateRate: duplicateCount / hashes.length,
      duplicateCount,
      uniqueCandidates,
      candidateCount: hashes.length,
    };
  }

  /**
   * The single terminal error channel from {@link runFanOutSegment} to the
   * parent: a `result_file_error` verdict carrying `message`, which the parent
   * `workers` state routes to its `failed` edge. The reason is reported here
   * too ({@link reportFanOutFailure}), since nothing downstream reads
   * `errors`; `instance` is undefined only when the run is gone.
   */
  private fanOutErrorResult(
    instance: WorkflowInstance | undefined,
    input: FanOutInvokeInput,
    stage: FanOutFailureStage,
    message: string,
  ): FanOutInvokeResult {
    this.reportFanOutFailure(instance, input.stateId, stage, message);
    return {
      passed: false,
      verdict: DETERMINISTIC_RESULT_ERROR_VERDICT,
      errors: message,
      context: input.context,
    };
  }

  // -----------------------------------------------------------------------
  // Deterministic state execution
  // -----------------------------------------------------------------------

  /**
   * Runs a deterministic state's commands: in the scope's shared container
   * when `container` is set, otherwise on the host (which requires the
   * state's `host: true`). `signal` is the XState invoke signal when there is
   * one; it and the run's stop signal (the instance's `stopController`) both
   * kill a running host command's process group, and the host runner starts
   * no further command once either has fired (the state then resolves as
   * failed, which a stopped run's actor ignores). Both signals reach the
   * container path too: a running container command is stopped inside the
   * container when either fires (see {@link runDeterministicInContainer}), a
   * stopping run starts no command, the run's signal is re-checked before
   * every container command and after the last one (a stopped run's result
   * file is not read), and a stopped invoke starts no further command.
   */
  private async executeDeterministicState(
    workflowId: WorkflowId,
    input: DeterministicInvokeInput,
    signal?: AbortSignal,
  ): Promise<DeterministicInvokeResult> {
    const preparedResult = input.context.lane?.preparedResults?.[input.stateId];
    if (preparedResult !== undefined) {
      return preparedResult;
    }

    const instance = this.workflows.get(workflowId);
    if (!instance) {
      return { passed: false, errors: `workflow ${workflowId} not found` };
    }
    const what = `deterministic state "${input.stateId}"`;
    this.throwIfStopping(instance, what);

    if (!input.container) {
      return this.runDeterministicHost(instance, input, signal);
    }

    if (!this.shouldUseSharedContainer(instance.definition)) {
      return { passed: false, errors: `State "${input.stateId}" requires shared-container Docker execution.` };
    }

    const scope = input.containerScope ?? DEFAULT_CONTAINER_SCOPE;
    const bundle = await this.ensureBundleForScope(instance, scope);
    const base = await this.runDeterministicInContainer(instance, bundle, input, signal);
    this.throwIfStopping(instance, `the rest of ${what}`);
    return this.applyResultFile(instance, input, base);
  }

  private applyResultFile(
    instance: WorkflowInstance,
    input: DeterministicInvokeInput,
    base: DeterministicInvokeResult,
  ): DeterministicInvokeResult {
    if (input.resultFile === undefined) return base;
    if (!base.passed) return base;

    const appendError = (message: string): DeterministicInvokeResult => ({
      ...base,
      passed: false,
      verdict: DETERMINISTIC_RESULT_ERROR_VERDICT,
      errors: base.errors ? `${base.errors}\n${message}` : message,
    });

    if (!isSafeWorkspaceRelativePath(input.resultFile)) {
      return appendError(`result file ${input.resultFile} is not a safe workspace-relative path`);
    }

    const resultPath = resolve(instance.workspacePath, input.resultFile);
    // Diagnostic pre-check: name a symlink that points off-workspace as an
    // escape. realpath only resolves the link; nothing is opened here.
    if (!isWithinDirectory(resultPath, instance.workspacePath)) {
      return appendError(`result file ${input.resultFile} escapes the workspace`);
    }

    // The authoritative read. The container can swap the file (or a directory
    // above it) at any moment, so the read goes through one no-follow,
    // non-blocking, size-capped descriptor whose location is re-checked against
    // the workspace: a FIFO, a symlink (to /dev/zero or anywhere), a directory
    // swapped for a symlink after the check above, or an oversized file is a
    // routable result-file error, never a hang or an off-workspace read in the
    // daemon. Read and parse failures stay distinct so a read failure is not
    // mislabeled as a JSON syntax error.
    let raw: string;
    try {
      raw = readUntrustedRegularFileBelow(instance.workspacePath, input.resultFile, {
        maxBytes: MAX_RESULT_FILE_BYTES,
      }).bytes.toString('utf8');
    } catch (err) {
      return appendError(describeResultFileReadError(input.resultFile, err));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return appendError(`result file ${input.resultFile} is not valid JSON`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return appendError(`result file ${input.resultFile} is not a JSON object`);
    }

    const resultObject = parsed as Record<string, unknown>;
    if (typeof resultObject.verdict !== 'string' || resultObject.verdict.length === 0) {
      return appendError(`result file ${input.resultFile} missing verdict`);
    }

    const payload =
      typeof resultObject.payload === 'object' && resultObject.payload !== null && !Array.isArray(resultObject.payload)
        ? (resultObject.payload as Record<string, unknown>)
        : undefined;

    return {
      ...base,
      verdict: resultObject.verdict,
      passed: typeof resultObject.passed === 'boolean' ? resultObject.passed : base.passed,
      ...(payload !== undefined ? { payload } : {}),
    };
  }

  /**
   * Shared reduction for both deterministic execution paths: skip empty command
   * arrays, mine the `N tests pass` heuristic from stdout, accumulate per-command
   * failures, and shape the `{ passed, testCount, errors }` result. Host vs.
   * container execution differ only in `runCommand` — keep that the only fork so
   * the pass/fail and test-count semantics cannot drift between the two paths.
   * Once `signal` (the run's stop signal, passed by the container path) aborts,
   * no further command starts. The host path passes none: its runner refuses
   * to start a command once the run stops and reports that as the command's
   * failure.
   */
  private async reduceDeterministicCommands(
    commands: readonly (readonly string[])[],
    runCommand: (cmd: readonly string[]) => Promise<{ stdout: string; error?: string }>,
    signal?: AbortSignal,
  ): Promise<DeterministicInvokeResult> {
    let totalTestCount = 0;
    const allErrors: string[] = [];

    for (const cmdArray of commands) {
      if (cmdArray.length === 0) continue;
      if (signal?.aborted) {
        throw new Error('Workflow is stopping; not starting the next deterministic command');
      }
      const { stdout, error } = await runCommand(cmdArray);
      if (error !== undefined) {
        allErrors.push(error);
        continue;
      }
      // Try to extract test count from stdout (simple heuristic)
      const testMatch = /(\d+)\s+(?:tests?|specs?)\s+pass/i.exec(stdout);
      if (testMatch) {
        totalTestCount += parseInt(testMatch[1], 10);
      }
    }

    return {
      passed: allErrors.length === 0,
      testCount: totalTestCount > 0 ? totalTestCount : undefined,
      errors: allErrors.length > 0 ? allErrors.join('\n') : undefined,
    };
  }

  /**
   * Host execution of a `host: true` deterministic state (see
   * host-command-runner.ts for the process bounds). Each command runs with
   * the run workspace as its working directory, stdin closed, its own process
   * group, and `timeoutMs` (default: the container path's 10 minutes). The
   * group is killed on timeout and when the run stops or the invoke is
   * stopped (a drained fan-out lane).
   *
   * Validation refuses an unacknowledged host state; this re-checks it so a
   * definition that bypassed validation cannot run workspace code on the host
   * either. The refusal throws, routing to the state's error target: it is a
   * configuration error, not a failed check.
   */
  private async runDeterministicHost(
    instance: WorkflowInstance,
    input: DeterministicInvokeInput,
    invokeSignal: AbortSignal | undefined,
  ): Promise<DeterministicInvokeResult> {
    if (input.host !== true && input.commands.some((command) => command.length > 0)) {
      throw new Error(
        `State "${input.stateId}" would run its commands on the host but does not set host: true; refusing to run them. ` +
          'Host deterministic commands need the explicit host: true acknowledgement (or run them with container: true).',
      );
    }
    const stopSignal = instance.stopController.signal;
    const signal = invokeSignal ? AbortSignal.any([stopSignal, invokeSignal]) : stopSignal;
    const timeoutMs = input.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

    return this.reduceDeterministicCommands(input.commands, async (cmdArray) => {
      const result = await runHostCommand(cmdArray, { cwd: instance.workspacePath, timeoutMs, signal });
      if (hostCommandSucceeded(result)) return { stdout: result.stdout };
      return { stdout: '', error: describeHostCommandFailure(cmdArray, result) };
    });
  }

  /**
   * Container execution of a `container: true` deterministic state. Each
   * command runs in the scope's shared container as the agent user, in the
   * workspace, with the workflow dependency bins on PATH, under coreutils
   * `timeout` with `timeoutMs` (default: the 10 minutes of the host path)
   * and a marker of its own (`runBoundedContainerCommand`, see
   * docker/turn-timeout.ts). The `docker exec` deadline alone would not do:
   * it only kills the host CLI client, and `docker exec` forwards no signal,
   * so a hung command (a test runner and its children) would go on running
   * in the shared container while the state was routed as failed and the
   * states after it ran.
   *
   * A command that times out, and the command running when the run stops or
   * the invoke is stopped (a drained fan-out lane), has its processes swept
   * inside the container before the state goes on, and is reported as that
   * command's failure. Afterwards no further command starts: the run's stop
   * makes the reducer throw, and a stopped invoke reports every later
   * command as not started (its stopped actor ignores the result).
   */
  private async runDeterministicInContainer(
    instance: WorkflowInstance,
    bundle: DockerInfrastructure,
    input: DeterministicInvokeInput,
    invokeSignal: AbortSignal | undefined,
  ): Promise<DeterministicInvokeResult> {
    const runStop = instance.stopController.signal;
    const signal = invokeSignal ? AbortSignal.any([runStop, invokeSignal]) : runStop;
    const timeoutMs = input.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    // Validation enforces the same bound; this guards a definition that
    // bypassed it (a zero would otherwise disable the host deadline).
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_DETERMINISTIC_TIMEOUT_MS) {
      throw new Error(
        `State "${input.stateId}" has timeoutMs ${String(timeoutMs)}; it must be an integer within 1-${MAX_DETERMINISTIC_TIMEOUT_MS}.`,
      );
    }
    // A sudo-off bundle (agentSudo: false) execs by numeric UID only.
    const execUser = bundle.agentExecUser ?? 'codespace';
    const stopReason = (): string => (runStop.aborted ? 'the workflow is stopping' : 'its state was stopped');

    return this.reduceDeterministicCommands(
      input.commands,
      async (cmdArray) => {
        const label = describeProgram(cmdArray);
        if (signal.aborted) return { stdout: '', error: `${label} was not started: ${stopReason()}` };
        // Prepend the workflow venv / node bins to the container's live $PATH so
        // bare `node` / `python` helpers resolve regardless of base-image arch
        // (the image's own PATH is preserved — see buildWorkflowExecCommand).
        // The wall clock wraps that shell, so it bounds the whole command.
        const { ending, result } = await runBoundedContainerCommand(
          bundle.docker,
          bundle.containerId,
          buildWorkflowExecCommand(bundle, cmdArray),
          { maxSeconds: timeoutMs / 1000, execUser, workdir: CONTAINER_WORKSPACE_DIR, signal },
        );
        const output = result.stderr || result.stdout;
        if (ending === 'timed-out') {
          const message = `${label} timed out after ${timeoutMs} ms; it was stopped inside the container`;
          return { stdout: '', error: output ? `${message}\n${output}` : message };
        }
        if (ending === 'stopped') {
          return { stdout: '', error: `${label} was stopped inside the container: ${stopReason()}` };
        }
        if (result.exitCode !== 0) {
          return { stdout: '', error: output || `exit ${result.exitCode}` };
        }
        return { stdout: result.stdout };
      },
      runStop,
    );
  }

  // -----------------------------------------------------------------------
  // Gate handling
  // -----------------------------------------------------------------------

  /**
   * Per-raise gate id for the entry into `gateName` that was just recorded
   * in the transition history (or is being restored from a legacy
   * checkpoint). The visit ordinal counts transitions into the gate so far.
   */
  private mintGateIdFor(instance: WorkflowInstance, gateName: string): string {
    const visit = instance.transitionHistory.filter((t) => t.to === gateName).length;
    return mintGateId(instance.id, gateName, visit);
  }

  /**
   * Raises the gate the machine is sitting at, once per raise.
   *
   * Called from the actor subscription for every snapshot that matches a
   * gate state. The id is always settled before this runs: minted by the
   * subscription on a transition into the gate (or on a gate snapshot with
   * no raise in effect), or restored / minted by `resume()`. The first
   * snapshot for a raise hands it to `deps.raiseGate`; any later snapshot
   * while still waiting (XState notifies observers for events it drops)
   * finds the id already raised and does nothing: re-raising would duplicate
   * the log entry and lifecycle event, and minting again would invalidate a
   * decision in flight.
   */
  private handleGateEntry(workflowId: WorkflowId, gateName: string, stateDef: HumanGateStateDefinition): void {
    const instance = this.workflows.get(workflowId);
    if (!instance) return;

    if (instance.activeGateId === undefined) {
      // Defensive only (see above). Without an id the gate could never be
      // resolved, so mint one rather than leave the run stranded.
      instance.activeGateId = this.mintGateIdFor(instance, gateName);
    }
    const gateId = instance.activeGateId;
    if (instance.raisedGateId === gateId) return;
    instance.raisedGateId = gateId;

    const gateRequest = this.buildGateRequest(workflowId, gateName, stateDef, gateId);

    instance.messageLog.append({
      ...this.logBase(instance),
      type: 'gate_raised',
      gateId,
      acceptedEvents: gateRequest.acceptedEvents,
    });

    this.deps.raiseGate(gateRequest);
    this.emitLifecycleEvent({
      kind: 'gate_raised',
      workflowId,
      gate: gateRequest,
    });
    this.armGateIdleTimer(instance, gateName, gateId);
  }

  /**
   * Arms the idle timer of the raise just handed to the deciders (see
   * {@link resolveGateIdleTimeoutMinutes}). A run waiting at a gate keeps
   * its shared containers, their proxies and relays, and its run and
   * workspace locks; one whose decider is gone (a closed browser, an
   * agent-driven `workflow run` caller that died) would hold them for the
   * daemon's lifetime. When the timer fires while the run still waits at
   * this raise, {@link releaseIdleGate} stops it.
   */
  private armGateIdleTimer(instance: WorkflowInstance, gateName: string, gateId: string): void {
    this.clearGateIdleTimer(instance);
    // A decider may already have answered from inside `raiseGate`, and a
    // stopping run decides nothing.
    if (instance.activeGateId !== gateId || instance.finalStatus !== undefined) return;
    const minutes = resolveGateIdleTimeoutMinutes(instance.definition.settings, instance.bundlesByScope.size > 0);
    if (minutes === undefined) return;
    const timer = setTimeout(
      () => {
        if (instance.gateIdleTimer?.timer === timer) instance.gateIdleTimer = undefined;
        this.releaseIdleGate(instance, gateName, gateId, minutes).catch((err: unknown) => {
          writeStderr(`[workflow] Gate idle release failed for ${instance.id}: ${toErrorMessage(err)}`);
        });
      },
      Math.max(1, Math.ceil(minutes * 60_000)),
    );
    // The timer alone must not keep a process alive.
    timer.unref();
    instance.gateIdleTimer = { gateId, timer };
  }

  private clearGateIdleTimer(instance: WorkflowInstance): void {
    if (!instance.gateIdleTimer) return;
    clearTimeout(instance.gateIdleTimer.timer);
    instance.gateIdleTimer = undefined;
  }

  /**
   * Stops a run whose gate went undecided for its idle timeout, through the
   * ordinary abort path: the abort snapshots `snapshotOnStop` scopes, writes
   * a terminal checkpoint that keeps the gate state and its raise id (so
   * `workflow resume` re-raises the same gate, and a decision made against
   * that id stays valid), destroys every bundle and releases the locks. The
   * gate is dismissed for the deciders. Nothing happens when the run has
   * moved on from this raise or is already stopping.
   */
  private async releaseIdleGate(
    instance: WorkflowInstance,
    gateName: string,
    gateId: string,
    minutes: number,
  ): Promise<void> {
    if (this.workflows.get(instance.id) !== instance) return;
    if (instance.finalStatus !== undefined || instance.activeGateId !== gateId) return;
    const releasesContainer = instance.bundlesByScope.size > 0;
    const reason =
      `Gate "${gateName}" waited ${minutes} minute${minutes === 1 ? '' : 's'} without a decision, ` +
      `so the run was stopped${releasesContainer ? ' and its containers released' : ''}. ` +
      `Resume it with "ironcurtain workflow resume ${instance.id}" to decide the gate.`;
    writeStderr(`[workflow] ${reason}`);
    // abort() claims the terminal before its first await, so no decision can
    // land between it and the dismissal (resolveGate refuses a terminal run).
    const stopping = this.abort(instance.id, { reason });
    this.deps.dismissGate(instance.id, gateId);
    await stopping;
  }

  private buildGateRequest(
    workflowId: WorkflowId,
    gateName: string,
    stateDef: HumanGateStateDefinition,
    gateId: string,
  ): HumanGateRequest {
    const instance = this.workflows.get(workflowId);
    const presentedArtifacts = new Map<string, string>();
    for (const artifactRef of stateDef.present ?? []) {
      if (instance) {
        const { name } = parseArtifactRef(artifactRef);
        const dir = this.resolveOutputDir(instance, name);
        if (dir !== undefined) {
          presentedArtifacts.set(name, dir);
        }
      }
    }

    // Surface error context in the gate summary so callers know whether this
    // gate was reached normally, via an invoke error, or via a deterministic
    // verdict such as evaluator_blocked.
    const snapshot = instance?.actor.getSnapshot() as { context?: WorkflowContext } | undefined;
    const context = snapshot?.context;
    const previousState =
      context?.previousStateName && instance ? instance.definition.states[context.previousStateName] : undefined;
    const previousDeterministicVerdict =
      previousState?.type === 'deterministic' ? context?.lastDeterministicResult?.verdict : undefined;
    const previousOutputSummary =
      context?.previousAgentOutput !== undefined && context.previousAgentOutput !== null
        ? // Collapse the multi-line aggregated fan-out reason to a single line so it
          // surfaces inline in the one-line gate banner instead of wrapping mid-summary.
          (truncateForTransition(context.previousAgentOutput) ?? '').replace(/\s+/g, ' ').trim()
        : undefined;
    const errorContext = context?.lastError
      ? ` (error: ${context.lastError})`
      : previousDeterministicVerdict
        ? ` (verdict: ${previousDeterministicVerdict}${previousOutputSummary ? `; ${previousOutputSummary}` : ''})`
        : '';

    return {
      gateId,
      workflowId,
      stateName: gateName,
      // Only events `resolveGate` will accept (declared AND routed), so no
      // decider is offered a choice that is refused with EVENT_NOT_ACCEPTED.
      acceptedEvents: acceptedGateEvents(stateDef),
      presentedArtifacts,
      summary: `Waiting for human review at ${gateName}${errorContext}`,
    };
  }

  // -----------------------------------------------------------------------
  // Completion handling
  // -----------------------------------------------------------------------

  private async handleWorkflowComplete(workflowId: WorkflowId, context: WorkflowContext): Promise<void> {
    const instance = this.workflows.get(workflowId);
    if (!instance) return;

    // Guard against XState emitting a terminal transition multiple times.
    // `finalStatus` being set is the canonical "already completed" signal;
    // if it's set, skip re-entering terminal handling so we don't call
    // destroyWorkflowInfrastructure twice (the teardown itself is idempotent,
    // but duplicate tab.close() / checkpoint.remove() / lifecycle events
    // are noisy).
    if (instance.finalStatus) return;

    // Check if this is a normal completion or a resumable failed/aborted terminal.
    // Quota exhaustion takes precedence: the error target may have
    // resolved to any terminal (including `done`-like ones), but a run
    // that died on upstream quota MUST be treated as aborted so the
    // checkpoint is preserved and the user can resume once the provider
    // window reopens. (M4 will upgrade this to a dedicated `paused`
    // phase; for now `aborted` gives us the same checkpoint retention.)
    const stateValue = instance.currentState;
    const lastState = instance.transitionHistory.at(-1)?.from ?? stateValue;
    const lastStateDefinition = instance.definition.states[lastState];
    const failedDirectlyFromExecutable = context.lastError !== null && isExecutableState(lastStateDefinition);
    if (instance.quotaExhausted) {
      const resetHint = instance.quotaExhausted.resetAt
        ? ` (resets at ${instance.quotaExhausted.resetAt.toISOString()})`
        : '';
      instance.finalStatus = {
        phase: 'aborted',
        reason: `Upstream quota exhausted${resetHint}`,
      };
    } else if (instance.transientFailure) {
      // Mirror the quota branch: a transient upstream failure must force
      // an abort-preserving terminal regardless of which state
      // `findErrorTarget` resolved to. Without this, a workflow whose
      // only terminal is `done` would land on `done` and
      // `handleWorkflowComplete` would mark the run `completed`, breaking
      // resume.
      const excerpt = instance.transientFailure.rawMessage.slice(0, 200);
      instance.finalStatus = {
        phase: 'aborted',
        reason:
          `Transient upstream failure: ${describeTransientFailureKind(instance.transientFailure.kind)} ` +
          `(resumable — run "ironcurtain workflow resume ${workflowId}" once upstream is healthy)\n${excerpt}`,
      };
    } else if (instance.workflowBudgetExhausted) {
      // Same checkpoint-preserving abort: the run stopped at its spend
      // ceiling before a state, whichever terminal the error routed to (a
      // fan-out batch may even have folded the refused lane into a verdict).
      instance.finalStatus = {
        phase: 'aborted',
        reason: instance.workflowBudgetExhausted.reason,
      };
    } else if (failedDirectlyFromExecutable) {
      instance.finalStatus = {
        phase: 'failed',
        error: context.lastError,
        lastState,
      };
    } else if (terminalPhaseFromStateName(stateValue) === 'aborted') {
      instance.finalStatus = {
        phase: 'aborted',
        reason: context.lastError ?? 'Workflow reached aborted state',
      };
    } else if (terminalPhaseFromStateName(stateValue) === 'failed' || context.lastError) {
      instance.finalStatus = {
        phase: 'failed',
        error: context.lastError ?? `Workflow reached failed state "${stateValue}"`,
        lastState,
      };
    } else {
      const result: WorkflowResult = { finalArtifacts: { ...context.artifacts } };
      instance.finalStatus = {
        phase: 'completed',
        result,
      };
    }

    this.clearGateIdleTimer(instance);
    // Recorded so a stop that lands during the snapshot or teardown below
    // (an abort, `shutdownAll()`) joins it instead of cutting it short.
    instance.terminalHandling = this.finishWorkflowComplete(instance, instance.finalStatus);
    await instance.terminalHandling;
  }

  /**
   * The rest of {@link handleWorkflowComplete} once its terminal is claimed:
   * snapshot (resumable terminals only), terminal checkpoint, teardown, lock
   * release and the lifecycle event.
   */
  private async finishWorkflowComplete(
    instance: WorkflowInstance,
    finalStatus: Extract<WorkflowStatus, { phase: 'completed' | 'failed' | 'aborted' }>,
  ): Promise<void> {
    const workflowId = instance.id;
    let existing: WorkflowCheckpoint | undefined;
    try {
      existing = this.deps.checkpointStore.load(workflowId);
    } catch (err) {
      writeStderr(`[workflow] Failed to load existing checkpoint for ${workflowId}: ${toErrorMessage(err)}`);
    }
    this.saveTerminalCheckpoint(instance, finalStatus, instance.containerSnapshots, existing, true);

    // This leg's restore snapshots, before a saved terminal checkpoint replaces them.
    const restoredSnapshots = instance.containerSnapshots;
    const containerSnapshots =
      finalStatus.phase === 'completed' ? undefined : await this.snapshotResumableScopes(instance);

    // Persist finalStatus so isCheckpointResumable can later distinguish
    // completed (excluded) from aborted/failed (still resumable). Preserve
    // the existing on-disk machineState/context (which points at the last
    // non-terminal state) so resume after abort/failure can re-enter that state
    // instead of immediately re-completing on a terminal snapshot. The
    // fallback path covers legacy runs or an earlier checkpoint write failure.
    const saved = this.saveTerminalCheckpoint(instance, finalStatus, containerSnapshots, existing, true);
    instance.tab.write(`[done] ${finalStatus.phase}`);
    instance.tab.close();

    // Snapshots go only once the terminal checkpoint is on disk. After a
    // failed save the checkpoint there is the last non-terminal one, which is
    // still resumable from the snapshots it references, even for a run that
    // has completed. A completed run supersedes all of them (it records none).
    const snapshotsToRemove = saved
      ? this.snapshotsSupersededBy(existing?.containerSnapshots, restoredSnapshots, containerSnapshots)
      : undefined;
    const cleanupDocker = snapshotsToRemove ? await this.dockerForSnapshotCleanup(instance) : undefined;

    // Tear down workflow-scoped Docker infrastructure. Runs asynchronously
    // because the actor subscription is sync; destroyWorkflowInfrastructure
    // is error-tolerant so unhandled rejections should not occur, but we
    // still catch defensively for a belt-and-suspenders guarantee. The
    // promise is retained on the instance so `shutdownAll` can await it
    // before the CLI exits (see `teardownPromise`).
    instance.teardownPromise = (async () => {
      await this.destroyWorkflowInfrastructure(instance);
      if (cleanupDocker) {
        await this.removeSnapshotImagesAfterTeardown(instance, cleanupDocker, snapshotsToRemove);
      }
    })().catch((err: unknown) => {
      writeStderr(
        `[workflow] destroyWorkflowInfrastructure unexpectedly threw for ${workflowId}: ${toErrorMessage(err)}`,
      );
    });

    await instance.teardownPromise;
    this.saveTerminalCheckpoint(instance, finalStatus, containerSnapshots, existing);
    this.appendTerminalControl(instance);
    this.teardownUsageSubscription(instance);
    this.markTerminalReady(instance);

    if (finalStatus.phase === 'completed') {
      this.emitLifecycleEvent({
        kind: 'completed',
        workflowId,
      });
    } else {
      this.emitLifecycleEvent({
        kind: 'failed',
        workflowId,
        error: finalStatus.phase === 'aborted' ? finalStatus.reason : finalStatus.error,
        phase: finalStatus.phase,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Artifact helpers
  // -----------------------------------------------------------------------

  private findMissingArtifacts(instance: WorkflowInstance, stateConfig: AgentStateDefinition): string[] {
    const missing: string[] = [];
    for (const output of stateConfig.outputs) {
      const dir = this.resolveOutputDir(instance, output);
      if (dir === undefined || !hasAnyFiles(dir)) {
        missing.push(output);
      }
    }
    return missing;
  }

  /**
   * The verified `.workflow/<name>` directory of an artifact output, or
   * `undefined` when it is missing or unsafe to walk (see
   * {@link resolveArtifactOutputDir}). An unsafe output (a symlinked output or
   * `.workflow` root, or one resolving outside the workspace) only ever comes
   * from a misbehaving agent: it counts as missing, so it can neither satisfy a
   * required-artifact check nor send the host walking a host directory, and it
   * is reported as a security event.
   */
  private resolveOutputDir(instance: WorkflowInstance, name: string): string | undefined {
    const check = resolveArtifactOutputDir(instance.workspacePath, instance.artifactDir, name);
    if (check.kind === 'ok') return check.dir;
    if (check.kind === 'rejected') this.reportRejectedArtifactDir(instance, name, check);
    return undefined;
  }

  /**
   * Logs an unsafe artifact output once per run (keyed by reason and path) to
   * stderr, the workflow tab and the message log. The path is host-derived
   * (the artifact dir joined with a definition-declared output name), so it is
   * safe to print.
   */
  private reportRejectedArtifactDir(
    instance: WorkflowInstance,
    name: string,
    check: Extract<ArtifactDirCheck, { kind: 'rejected' }>,
  ): void {
    instance.reportedArtifactRejections ??= new Set<string>();
    const key = `${check.reason}:${check.path}`;
    if (instance.reportedArtifactRejections.has(key)) return;
    instance.reportedArtifactRejections.add(key);

    const why =
      check.reason === 'symlink'
        ? 'is a symbolic link'
        : check.reason === 'outside_workspace'
          ? 'resolves outside the workspace'
          : 'is not a plain relative name';
    const message = `artifact output "${name}" treated as missing: ${check.path} ${why}`;
    writeStderr(`[workflow] SECURITY: workflow ${instance.id}: ${message}`);
    instance.tab.write(`[security] ${message}`);
    instance.messageLog.append({
      ...this.logBase(instance),
      type: 'error',
      error: message,
      context: 'security: unsafe artifact output',
    });
  }

  private artifactHandoffSatisfied(stateConfig: AgentStateDefinition, artifactDir: string): boolean {
    const policy = stateConfig.artifactHandoff;
    if (!policy) return false;
    return policy.requiredFiles.every((requiredFile) => {
      try {
        const rootStat = lstatSync(artifactDir);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;

        let current = artifactDir;
        const segments = requiredFile.split('/');
        for (const segment of segments.slice(0, -1)) {
          current = resolve(current, segment);
          const ancestor = lstatSync(current);
          if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) return false;
        }

        const requiredPath = resolve(artifactDir, requiredFile);
        const stat = lstatSync(requiredPath);
        return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && isWithinDirectory(requiredPath, artifactDir);
      } catch {
        return false;
      }
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle event emission
  // -----------------------------------------------------------------------

  private emitLifecycleEvent(event: WorkflowLifecycleEvent): void {
    for (const cb of this.lifecycleCallbacks) {
      try {
        cb(event);
      } catch (cbErr) {
        // Lifecycle callbacks should not crash the orchestrator, but log the failure
        console.error(`[workflow] Lifecycle callback threw for "${event.kind}":`, cbErr);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers (exported for testing)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bundle sizing helpers (workflow shared-container mode)
// ---------------------------------------------------------------------------

/**
 * The container scopes `ensureBundleForScope` can mint for `definition`:
 * those of its agent states and of its `container: true` deterministic
 * states (fan-out segments only ever use these). Never empty, so a run
 * always reserves at least one agent slot for its bundles.
 */
function workflowBundleScopes(definition: WorkflowDefinition): ReadonlySet<string> {
  const scopes = new Set<string>();
  for (const state of Object.values(definition.states)) {
    if (state.type === 'agent' || (state.type === 'deterministic' && state.container === true)) {
      scopes.add(state.containerScope ?? DEFAULT_CONTAINER_SCOPE);
    }
  }
  if (scopes.size === 0) scopes.add(DEFAULT_CONTAINER_SCOPE);
  return scopes;
}

/**
 * The widest fan-out (in lanes) whose segment runs in `scope`, or 1 when no
 * multi-lane segment does: how many agent lanes the scope's bundle
 * coordinator should expect at once. A segment's scope is that of its agent
 * and `container: true` members (exactly one, enforced by validation and
 * `preMintFanOutScopeBundle`).
 */
function maxLanesForScope(definition: WorkflowDefinition, scope: string): number {
  let maxLanes = 1;
  for (const state of Object.values(definition.states)) {
    if (!isExecutableState(state) || state.fanOut === undefined) continue;
    const runsInScope = (state.segment ?? []).some((memberId) => {
      const member = definition.states[memberId] as WorkflowStateDefinition | undefined;
      if (member?.type === 'agent' || (member?.type === 'deterministic' && member.container === true)) {
        return (member.containerScope ?? DEFAULT_CONTAINER_SCOPE) === scope;
      }
      return false;
    });
    if (runsInScope) maxLanes = Math.max(maxLanes, resolveFanOutWorkers(state.fanOut, definition.settings));
  }
  return maxLanes;
}

// ---------------------------------------------------------------------------
// Policy cycling helpers (workflow shared-container mode)
// ---------------------------------------------------------------------------

/**
 * Resolves the compiled-policy directory for the given persona name.
 *
 * The reserved sentinel `GLOBAL_PERSONA` maps to the package-bundled
 * generated dir (same one `loadConfig().generatedDir` resolves to for
 * CLI runs). All other values go through `resolvePersona()`, which
 * validates the persona exists and has a compiled policy.
 */
function resolvePersonaPolicyDir(persona: string): string {
  if (persona === GLOBAL_PERSONA) {
    return loadConfig().generatedDir;
  }
  return resolvePersona(persona).policyDir;
}

/**
 * `servers` without the memory server, for a workflow shared-container
 * bundle. The bundle serves every persona in its scope through one
 * coordinator, and the memory server is trusted (it bypasses policy), so a
 * bundle-wide memory server would let every persona read and write one
 * persona's database. The default infrastructure factory therefore never
 * starts one, whatever the required set or the server configuration names.
 */
function withoutMemoryServer<T>(servers: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(servers).filter(([name]) => name !== MEMORY_SERVER_NAME));
}

/**
 * Validates a run's task-scope directory (`--task-scoped`): confined to the
 * trusted roots and canonicalized like a persona policy dir, then checked
 * against its record. Returns the canonical path.
 *
 * @throws when the directory cannot be enforced.
 */
function validateTaskScopeDir(taskPolicyDir: string): string {
  const canonical = validatePolicyDir(taskPolicyDir);
  requireTaskScopeDir(canonical);
  return canonical;
}

/**
 * Default `startWorkflowControlServer`: reaches through the infra
 * bundle's proxy for its policy-swap target and binds a control server
 * at the workflow-scoped UDS path.
 */
async function defaultStartWorkflowControlServer(input: StartWorkflowControlServerInput): Promise<void> {
  const target = input.infra.proxy.getPolicySwapTarget();
  if (!target) {
    throw new Error(
      'Cannot attach workflow control server: the proxy is not yet started. ' +
        'Call proxy.start() before attaching a control server.',
    );
  }
  await target.startControlServer({ socketPath: input.socketPath });
}

/**
 * Shapes a workflow bundle's config for tool-call escalations. The bundle's
 * coordinator gets the orchestrator's in-process handler
 * (`CreateWorkflowInfrastructureInput.onEscalation`), which takes precedence
 * over file IPC; the bundle escalation dir is set as well, so a coordinator
 * built without the handler still writes its requests where the borrowing
 * session's watcher picks them up and hands them to the same human route.
 * Without either, every escalated call would be denied on the spot.
 *
 * The auto-approver is switched off: in a workflow its "user message" would
 * be the orchestrator's prompt, which carries prior agents' output rather
 * than a human's intent. Exported for tests.
 */
export function withWorkflowEscalationRouting(
  config: IronCurtainConfig,
  bundleEscalationDir: string,
): IronCurtainConfig {
  return {
    ...config,
    escalationDir: bundleEscalationDir,
    userConfig: { ...config.userConfig, autoApprove: { ...config.userConfig.autoApprove, enabled: false } },
  };
}

/**
 * Default `loadPolicyRpc`: speaks HTTP/1.1 over the supplied UDS using
 * Node's built-in client. Resolves on a 2xx response; rejects on any
 * non-2xx status, request timeout, or socket error. The coordinator's
 * reply body is read only on the error path (to surface the error
 * text) — 2xx bodies are discarded with `res.resume()`.
 *
 * Exported so integration tests can drive the wire format without
 * standing up a full `WorkflowOrchestrator`. Keeping the HTTP request
 * construction in one place guarantees tests exercise the same bytes
 * production emits.
 */
export async function defaultLoadPolicyRpc(input: LoadPolicyRpcInput): Promise<void> {
  const body = JSON.stringify({
    persona: input.persona,
    policyDir: input.policyDir,
  });
  const timeoutMs = input.timeoutMs ?? LOAD_POLICY_RPC_TIMEOUT_MS;

  return new Promise((resolveFn, rejectFn) => {
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) rejectFn(err);
      else resolveFn();
    };

    const req = http.request(
      {
        socketPath: input.socketPath,
        method: 'POST',
        path: POLICY_LOAD_PATH,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf-8'),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          res.resume();
          res.on('end', () => settle());
          res.on('error', settle);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          settle(new Error(`loadPolicy RPC failed (status ${status}): ${text.slice(0, 200)}`));
        });
        res.on('error', settle);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`loadPolicy RPC timed out after ${timeoutMs}ms`));
    });
    req.on('error', settle);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// Workspace root hashing (file listing + mtime, no content reads)
// ---------------------------------------------------------------------------

const WORKSPACE_HASH_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  WORKFLOW_ARTIFACT_DIR,
  'node_modules',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.cache',
  '.venv',
  'venv',
]);

/** Hashes the workspace root file listing (paths + mtimes) into the given hash. */
function hashWorkspaceRoot(hash: Hash, workspacePath: string): void {
  // `relativePath:mtime` for every regular file, excluding directories in
  // WORKSPACE_HASH_EXCLUDED_DIRS at any depth. The walk never follows
  // symlinks, skips entries that vanish or turn unreadable mid-walk (an agent
  // renaming a temp file must not fail its own state), and is bounded by
  // WORKSPACE_HASH_LIMITS.
  const entries: string[] = [];
  const { truncated } = walkTreeNoFollow(workspacePath, WORKSPACE_HASH_LIMITS, {
    enterDirectory: (_fullPath, name) => !WORKSPACE_HASH_EXCLUDED_DIRS.has(name),
    file: (fullPath, stats) => {
      entries.push(`${relative(workspacePath, fullPath).split(sep).join('/')}:${stats.mtimeMs}`);
      return false;
    },
  });
  entries.sort();
  for (const entry of entries) {
    hash.update(entry);
  }
  if (truncated) hash.update('\0truncated');
}

/** True when a transition of this state routes on the `isStalled` guard, the only reader of `outputHash`. */
function usesStallGuard(stateConfig: AgentStateDefinition): boolean {
  return stateConfig.transitions.some((transition) => transition.guard === STALL_GUARD);
}

/**
 * Computes a SHA-256 hash of output artifacts or workspace root file metadata.
 *
 * Hashes file metadata (path + size + mtime) — never contents. This bounds cost
 * regardless of artifact size (fuzz logs, captured stderr, etc. can be many GiB
 * and would otherwise trip Node's 2 GiB `readFile` ceiling). Any agent rewrite
 * via fs ops bumps mtime, and same-mtime-same-size collisions in a single ms
 * window are not a concern for workflow change detection.
 *
 * Only outputs that pass {@link resolveArtifactOutputDir} are walked (a
 * symlinked output or `.workflow` root contributes nothing), every walk is
 * bounded and never follows symlinks, and the sizes and mtimes come from the
 * walk's own lstat, so a file deleted mid-walk is simply absent from the hash.
 * The orchestrator calls this only for states with an `isStalled` transition.
 */
export function computeOutputHash(outputNames: readonly string[], artifactDir: string, workspacePath: string): string {
  const hash = createHash('sha256');

  if (outputNames.length > 0) {
    for (const output of outputNames) {
      const check = resolveArtifactOutputDir(workspacePath, artifactDir, output);
      if (check.kind !== 'ok') continue;
      const dir = check.dir;
      const files: { relativePath: string; size: number; mtimeMs: number }[] = [];
      const { truncated } = walkTreeNoFollow(dir, ARTIFACT_WALK_LIMITS, {
        file: (fullPath, stats) => {
          const relativePath = relative(dir, fullPath).split(sep).join('/');
          files.push({ relativePath, size: stats.size, mtimeMs: stats.mtimeMs });
          return false;
        },
      });
      files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      for (const file of files) {
        hash.update(`${file.relativePath}:${file.size}:${file.mtimeMs}`);
      }
      if (truncated) hash.update(`\0truncated:${output}`);
    }
  } else {
    hashWorkspaceRoot(hash, workspacePath);
  }

  return hash.digest('hex');
}

/**
 * Collects artifact paths: maps output name -> directory path, for outputs
 * whose directory passes {@link resolveArtifactOutputDir} (a symlinked or
 * escaping output is never handed on as an artifact).
 */
export function collectArtifactPaths(
  outputNames: readonly string[],
  artifactDir: string,
  workspacePath: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const output of outputNames) {
    const check = resolveArtifactOutputDir(workspacePath, artifactDir, output);
    if (check.kind === 'ok') {
      result[output] = check.dir;
    }
  }
  return result;
}

/** The `errors` text for a result file that could not be read (see `applyResultFile`). */
function describeResultFileReadError(resultFile: string, err: unknown): string {
  switch (err instanceof UntrustedFileError ? err.code : undefined) {
    case 'NOT_FOUND':
      return `result file ${resultFile} not found`;
    case 'OUTSIDE_ROOT':
      return `result file ${resultFile} escapes the workspace`;
    case 'SYMLINK':
      return `result file ${resultFile} could not be read: it is a symbolic link`;
    case 'NOT_REGULAR_FILE':
      return `result file ${resultFile} could not be read: it is not a regular file`;
    case 'TOO_LARGE':
      return `result file ${resultFile} could not be read: it is larger than ${MAX_RESULT_FILE_BYTES} bytes`;
    default:
      return `result file ${resultFile} could not be read: ${errorMessage(err)}`;
  }
}
