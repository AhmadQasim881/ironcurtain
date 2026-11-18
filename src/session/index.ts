/**
 * Session module public API.
 *
 * createSession() is the only entry point for session creation.
 * The concrete implementations (AgentSession, DockerAgentSession)
 * are not exported -- callers depend on the Session interface only.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  loadConfig,
  applyAllowedDirectoryToMcpArgs,
  loadGeneratedPolicy,
  loadPersonaPolicyArtifacts,
  getPackageGeneratedDir,
} from '../config/index.js';
import { COMPILED_POLICY_FILENAME, ScopedPolicyError } from '../config/constitution-hash.js';
import { checkTaskScopeDir, type TaskScopeRecord } from '../config/task-scope-policy.js';
import { extractRequiredServers } from '../trusted-process/policy-roots.js';
import { isStalePolicyRefusal, type PolicyProvenanceCheckOptions } from '../config/policy-provenance-check.js';
import { loadToolAnnotations } from '../config/tool-annotations-overlay.js';
import type { CompiledPolicyFile } from '../pipeline/types.js';
import {
  getSessionDir,
  getSessionSandboxDir,
  getSessionEscalationDir,
  getSessionAuditLogPath,
  getSessionLogPath,
  getSessionLlmLogPath,
  getSessionAutoApproveLlmLogPath,
  SESSION_LOG_FILENAME,
  SESSION_METADATA_FILENAME,
} from '../config/paths.js';
import { validatePolicyDir as sharedValidatePolicyDir } from '../config/validate-policy-dir.js';
import { getSessionCapturesDir } from '../config/paths.js';
import type { IronCurtainConfig } from '../config/types.js';
import { applyReadOnlyWorkspace, READ_ONLY_OUTPUT_SERVER } from '../config/read-only-workspace.js';
import type { ReadOnlyWorkspace } from '../types/read-only-workspace.js';
import * as logger from '../logger.js';
import { ensurePrivateDirectory } from '../observability/private-log-file.js';
import {
  resolvePersona,
  applyServerAllowlist,
  filterMcpServersByPolicy,
  type ResolvedPersona,
} from '../persona/resolve.js';
import { resolveSkillsForSession } from '../skills/discovery.js';
import type { ResolvedSkill } from '../skills/types.js';
import { buildPersonaSystemPromptAugmentation } from '../persona/persona-prompt.js';
import { readPersonaOverrides, type PersonaOverrides } from '../persona/persona-overrides.js';
import { layerResourceBudget, resolveSessionAgentModel, withAgentModelId } from './model-budget-precedence.js';
import { resolveMemoryDbPath } from '../memory/resolve-memory-path.js';
import {
  buildMemoryServerConfig,
  buildMemoryServerCredentials,
  cronMemoryScope,
  workflowMemoryScope,
  MEMORY_SERVER_NAME,
  type MemoryServerOptions,
  type MemoryWriterKind,
} from '../memory/memory-annotations.js';
import { buildMemorySystemPrompt, adaptMemoryToolNames } from '../memory/memory-prompt.js';
import { isMemoryEnabledFor } from '../memory/memory-policy.js';
import type { PersonaDefinition } from '../persona/types.js';
import { createJobId } from '../cron/types.js';
import { loadJob } from '../cron/job-store.js';
import { checkJobPolicyDir } from '../cron/job-policy.js';
import type { ProcessLockHandle } from '../docker-workload/process-lock.js';
import { errorMessage } from '../utils/error-message.js';
import { GLOBAL_APPROVAL_SCOPE, jobApprovalScope, personaApprovalScope } from '../audit/approval-history.js';
import { AgentSession } from './agent-session.js';
import { planHostModelRoles, type HostModelNotice } from './host-model-roles.js';
import { loadConversation, type StoredConversation } from './conversation-store.js';
import { claimSessionDirectory, releaseSessionDirectory } from './session-lock.js';
import { validateWorkspacePath } from './workspace-validation.js';
import { SessionError } from '../types/errors.js';
import {
  agentNameForMode,
  findResumeAgentConflict,
  saveSessionMetadata,
  saveSessionMetadataTo,
  loadResumeSessionMetadata,
  loadSessionMetadata,
  updateSessionMetadata,
} from './session-metadata.js';
import { bundleIdFromSessionId, createAgentConversationId, createSessionId } from './types.js';
import type {
  AgentConversationId,
  BuiltinSessionOptions,
  DockerSessionOptions,
  Session,
  SessionId,
  SessionOptions,
  SessionMode,
} from './types.js';

/**
 * Creates and initializes a new session.
 *
 * This is the only public entry point for session creation.
 * The concrete implementations are not exported -- callers
 * depend on the Session interface only.
 *
 * When mode is 'docker', spawns an external agent in a Docker
 * container with MCP proxy mediation. Otherwise (default), creates
 * the built-in AgentSession using UTCP Code Mode + AI SDK.
 *
 * @throws {SessionError} with code SESSION_INIT_FAILED if
 *   sandbox or MCP connection setup fails.
 */
export async function createSession(options: DockerSessionOptions): Promise<Session>;
export async function createSession(options?: BuiltinSessionOptions): Promise<Session>;
export async function createSession(options: SessionOptions = {}): Promise<Session> {
  // When resuming, restore persisted session settings (persona, workspace, etc.)
  const effectiveOptions = applyResumeMetadata(options);
  const mode: SessionMode = effectiveOptions.mode ?? { kind: 'builtin' };

  if (mode.kind === 'docker') {
    return createDockerSession(mode.agent, effectiveOptions);
  }

  return createBuiltinSession(effectiveOptions);
}

/**
 * Entry point for callers outside the workflow orchestrator — CLI,
 * daemon, signal bot, web UI. For Docker mode: resumes the persisted
 * `AgentConversationId` when `resumeSessionId` is set (so
 * `ironcurtain --resume <id>` continues the prior Claude conversation
 * via `--resume <conv-id>` on the adapter), otherwise mints fresh.
 * Builtin mode ignores the field.
 *
 * Legacy-session fallback: sessions created before
 * `agentConversationId` was persisted in metadata will have no stored
 * id. Those resumes mint fresh, and the agent CLI starts a new
 * conversation — the prior transcript is unreachable but nothing is
 * corrupted. New sessions created post-refactor always persist the id,
 * so subsequent resumes recover the conversation.
 *
 * Workflow callers must not use this: they must thread
 * `agentConversationId` from `context.agentConversationsByState` via
 * `createSession()` directly so `freshSession: false` states resume
 * the prior conversation.
 */
export async function createStandaloneSession(options: Omit<SessionOptions, 'agentConversationId'>): Promise<Session> {
  if (options.mode?.kind === 'docker') {
    const persistedId = options.resumeSessionId
      ? loadSessionMetadata(options.resumeSessionId)?.agentConversationId
      : undefined;
    return createSession({
      ...options,
      mode: options.mode,
      agentConversationId: persistedId ?? createAgentConversationId(),
    });
  }
  return createSession({ ...options, mode: options.mode });
}

/**
 * Merges persisted session metadata into options when resuming.
 * Returns options unchanged for new sessions or when no metadata file exists
 * (graceful for sessions created before metadata persistence was added). A
 * metadata file that exists but cannot be used refuses the resume
 * (loadResumeSessionMetadata): without it the session would resume without
 * its persona, policy directory, task scope and disableAutoApprove.
 */
function applyResumeMetadata(options: SessionOptions): SessionOptions {
  if (!options.resumeSessionId) return options;
  const metadata = loadResumeSessionMetadata(options.resumeSessionId);
  if (!metadata) return options;
  if (metadata.dockerWorkload !== undefined) {
    throw new SessionError(
      `Cannot resume session "${options.resumeSessionId}": secure nested Docker-workload sessions have ephemeral ` +
        `daemon state and are not resumable`,
      'SESSION_INIT_FAILED',
    );
  }
  // Before anything is claimed or created, refuse a resume across the
  // builtin/container boundary (say `--agent claude-code --resume <builtin
  // session>`): it would skip the builtin session's saved conversation.
  const agentConflict = findResumeAgentConflict(metadata, options.mode);
  if (agentConflict !== undefined) {
    throw new SessionError(
      `Cannot resume session "${options.resumeSessionId}": ${agentConflict}`,
      'SESSION_INIT_FAILED',
    );
  }
  const workspacePath =
    metadata.workspacePath !== undefined
      ? revalidateResumeWorkspace(options.resumeSessionId, metadata.workspacePath, options.config)
      : undefined;
  return {
    ...options,
    // Only spread defined metadata fields so undefined doesn't overwrite
    // caller-provided values (important for non-CLI callers like the daemon).
    ...(metadata.persona !== undefined ? { persona: metadata.persona } : {}),
    ...(workspacePath !== undefined ? { workspacePath } : {}),
    ...(metadata.providerProfileName !== undefined ? { providerProfileName: metadata.providerProfileName } : {}),
    ...(metadata.policyDir !== undefined ? { policyDir: metadata.policyDir } : {}),
    // A task-scoped session resumes under the same task scope (validated
    // again by buildSessionConfig); the caller's value never replaces it.
    ...(metadata.taskPolicyDir !== undefined ? { taskPolicyDir: metadata.taskPolicyDir } : {}),
    ...(metadata.disableAutoApprove !== undefined ? { disableAutoApprove: metadata.disableAutoApprove } : {}),
    // Caller-supplied `agentConversationId` wins over the persisted
    // one (workflow orchestrator always passes its own explicitly).
    // Only the CLI / daemon `createStandaloneSession` path leaves the
    // field unset, and that's exactly the path we want to restore from
    // metadata so `--resume` continues the prior Claude conversation.
    ...(options.agentConversationId === undefined && metadata.agentConversationId !== undefined
      ? { agentConversationId: metadata.agentConversationId }
      : {}),
  };
}

/**
 * Re-validates the workspace a resumed session recorded at creation. That
 * path passed validateWorkspacePath() back then, but the directory may have
 * changed since: a path component swapped for a symlink to the home
 * directory or the IronCurtain home, or trusted state now inside it. The
 * stored path is therefore checked again exactly like a fresh `--workspace`,
 * and the session resumes in the canonical path the validator approved (PTY
 * resume does the same through validateResumeSession()).
 */
function revalidateResumeWorkspace(
  resumeSessionId: string,
  storedPath: string,
  config: IronCurtainConfig | undefined,
): string {
  try {
    return validateWorkspacePath(storedPath, (config ?? loadConfig()).protectedPaths);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SessionError(
      `Cannot resume session "${resumeSessionId}": workspace path is unsafe: ${detail}`,
      'SESSION_INIT_FAILED',
    );
  }
}

/**
 * Creates the built-in AgentSession.
 *
 * A builtin session keeps one identity across `--resume`: the directory
 * tree, the saved conversation (messages.jsonl), the interaction log and the
 * session lock all use the original session ID, so a resumed session can be
 * resumed again. The resumed session continues the saved conversation, and
 * the process holds the session lock (see session-lock.ts) until close(), so
 * no second process can run the same session meanwhile.
 */
async function createBuiltinSession(options: SessionOptions): Promise<Session> {
  const config = options.config ?? loadConfig();
  const resumeSessionId = options.resumeSessionId;
  const sessionId = resumeSessionId ? asResumedSessionId(resumeSessionId) : createSessionId();

  // Resume: claim the existing directory before reading or touching anything
  // in it, so a refused second resumer changes nothing; then load the saved
  // conversation under the claim.
  let sessionLock: ProcessLockHandle | undefined;
  let restoredConversation: StoredConversation | undefined;
  if (resumeSessionId) {
    sessionLock = claimResumedSessionDirectory(resumeSessionId);
    try {
      restoredConversation = loadConversation(getSessionDir(resumeSessionId));
    } catch (error) {
      releaseSessionDirectory(sessionLock);
      throw new SessionError(
        `Cannot resume session "${resumeSessionId}": ${errorMessage(error)}. ` +
          'Move the file aside to resume with the workspace only.',
        'SESSION_INIT_FAILED',
      );
    }
  }

  // Every session log is opened for appending (the LLM interaction logs
  // included, see session-llm-log.ts), so a resumed session simply extends
  // them. buildSessionConfig() claims the logger for the session log and
  // gives the claim back itself if it fails.
  let sessionConfig: SessionDirConfig;
  try {
    sessionConfig = buildSessionConfig(config, sessionId, sessionId, options);
  } catch (error) {
    if (sessionLock) releaseSessionDirectory(sessionLock);
    throw error;
  }

  // The rest of the start-up writes to the session's own log, whichever
  // context creates the session (the daemon's, another session's).
  return logger.runWithClaim(sessionConfig.logClaim, () =>
    startBuiltinSession(sessionId, sessionConfig, options, { restoredConversation, sessionLock }),
  );
}

/**
 * Constructs and initializes the AgentSession once its configuration (and
 * logger claim) exist. On failure nothing of the session is left behind:
 * a constructed session is closed, and the session lock and the logger
 * claim are released.
 */
async function startBuiltinSession(
  sessionId: SessionId,
  sessionConfig: SessionDirConfig,
  options: SessionOptions,
  resume: { readonly restoredConversation?: StoredConversation; readonly sessionLock?: ProcessLockHandle },
): Promise<Session> {
  const { restoredConversation } = resume;
  let sessionLock = resume.sessionLock;
  let session: AgentSession;
  try {
    // A fresh session's directory exists only now that buildSessionConfig()
    // has created it.
    sessionLock ??= claimSessionDirectory(sessionConfig.sessionDir, sessionId, 'start');
    if (restoredConversation) {
      logger.info(`Restored ${restoredConversation.messages.length} messages of saved conversation`);
    }

    // Merge resolved systemPromptAugmentation (may include persona augmentation)
    // and the resolved agent model override (the caller's, else the persona's)
    // back into options so AgentSession sees them.
    const effectiveOptions: SessionOptions = {
      ...options,
      ...(sessionConfig.systemPromptAugmentation
        ? { systemPromptAugmentation: sessionConfig.systemPromptAugmentation }
        : {}),
      ...(sessionConfig.agentModelOverride !== undefined
        ? { agentModelOverride: sessionConfig.agentModelOverride }
        : {}),
    };

    // From here on the session owns the lock and the logger claim and
    // releases both in close().
    session = new AgentSession(
      sessionConfig.config,
      sessionId,
      sessionConfig.escalationDir,
      sessionConfig.sessionDir,
      effectiveOptions,
      {
        restoredConversation,
        sessionLock,
        logClaim: sessionConfig.logClaim,
        hostModelNotices: sessionConfig.hostModelNotices,
        policyWarnings: sessionConfig.policyWarnings,
      },
    );
  } catch (error) {
    if (sessionLock) releaseSessionDirectory(sessionLock);
    logger.release(sessionConfig.logClaim);
    throw error;
  }

  try {
    await session.initialize();
  } catch (error) {
    // Clean up on init failure. close() gives the logger claim back, so
    // error messages from callers (orchestrator, XState) no longer go to
    // this session's log.
    await session.close().catch(() => {});
    logger.release(sessionConfig.logClaim);
    throw new SessionError(
      `Session initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      'SESSION_INIT_FAILED',
    );
  }

  return session;
}

/**
 * The ID a resumed builtin session keeps. The value comes from the user
 * (`--resume <id>`); getSessionDir() has already rejected anything that is
 * not a path-safe slug by the time it is used.
 */
function asResumedSessionId(resumeSessionId: string): SessionId {
  return resumeSessionId as SessionId;
}

/**
 * Claims the existing directory of a standalone session being resumed (see
 * session-lock.ts) before the session's state is loaded from it or its
 * configuration built in it, so a refused second resumer leaves it as it
 * was. (Only its metadata has been read by then, see applyResumeMetadata.)
 * A fresh session claims its directory once buildSessionConfig() has
 * created it.
 *
 * @throws {SessionError} with code SESSION_INIT_FAILED when the directory
 *   does not exist or another live process holds it.
 */
function claimResumedSessionDirectory(resumeSessionId: string): ProcessLockHandle {
  const sessionDir = getSessionDir(resumeSessionId);
  if (!existsSync(sessionDir)) {
    throw new SessionError(
      `Cannot resume session "${resumeSessionId}": session directory not found at ${sessionDir}`,
      'SESSION_INIT_FAILED',
    );
  }
  return claimSessionDirectory(sessionDir, resumeSessionId, 'resume');
}

/**
 * Creates a DockerAgentSession that runs an external agent in a container.
 *
 * Two paths:
 * - Standalone (default): calls `createDockerInfrastructure()` to stand up
 *   the full infrastructure bundle (proxies, orientation, image, running
 *   agent container, sidecar and internal network for TCP mode). The
 *   session is constructed with `ownsInfra=true`, so `close()` tears down
 *   the bundle.
 * - Borrow (`options.workflow.infrastructure` set): uses the caller-supplied
 *   bundle as-is and constructs the session with `ownsInfra=false`. The
 *   caller retains full responsibility for the bundle's lifetime; the
 *   session's `close()` only tears down session-local state.
 *
 * In both paths the session wires up escalation watcher and audit tailer
 * and writes any per-session files (CLAUDE.md, effective system prompt)
 * using fields on the bundle.
 *
 * A standalone session, fresh or resumed, holds the claim on its session
 * directory (session-lock.ts) until close() has torn its bundle down, as a
 * builtin session does: a resume of a session that another process is still
 * running is refused, and prune sees the session as live. (A resume keeps
 * the original directory but runs under a new runtime ID, which names its
 * container, bundle and token stream.) A session on a borrowed bundle works
 * in directories the orchestrator owns and takes no claim.
 */
async function createDockerSession(
  agentId: import('../docker/agent-adapter.js').AgentId,
  options: SessionOptions,
): Promise<Session> {
  const config = options.config ?? loadConfig();
  const sessionId = createSessionId();
  const effectiveSessionId = options.resumeSessionId ?? sessionId;

  // Agent-CLI conversation id must be minted by the caller. Docker-mode
  // callers pass `DockerSessionOptions`, which makes this field required
  // at the type level. The runtime guard catches callers that widen to
  // the base `SessionOptions` type and forget to supply it — the factory
  // will not mint on their behalf because the single-conversation model
  // makes the minting site load-bearing (workflow orchestrator reuses
  // per state; each CLI run mints fresh). See §11 step 4 and §3
  // "Identity flow" in docs/designs/workflow-session-identity.md.
  if (!options.agentConversationId) {
    throw new SessionError(
      'agentConversationId is required for Docker sessions: mint via createAgentConversationId() at the call site',
      'SESSION_INIT_FAILED',
    );
  }
  const agentConversationId: AgentConversationId = options.agentConversationId;

  // A standalone resume claims the existing directory before
  // buildSessionConfig() touches it, so a refused second resumer changes
  // nothing (a fresh session claims its directory in startDockerSession(),
  // once it exists).
  const resumeLock =
    options.workflow?.infrastructure === undefined && options.resumeSessionId !== undefined
      ? claimResumedSessionDirectory(options.resumeSessionId)
      : undefined;

  // buildSessionConfig() claims the logger for the session log and gives the
  // claim back itself if it fails.
  let sessionConfig: SessionDirConfig;
  try {
    sessionConfig = buildSessionConfig(config, effectiveSessionId, sessionId, options);
  } catch (error) {
    if (resumeLock) releaseSessionDirectory(resumeLock);
    throw error;
  }

  // The infrastructure and the session start bound to the session's logger
  // claim, so the proxies, watchers and tailers created here write to the
  // session's own log, whichever context creates the session. The entire
  // infrastructure + init sequence is wrapped so that the claim is given
  // back on ANY failure, not just session.initialize() failures: a claim
  // left behind would keep receiving other code's console output (error
  // messages from the orchestrator and XState included) instead of the
  // terminal or the daemon log.
  return logger.runWithClaim(sessionConfig.logClaim, () =>
    startDockerSession(agentId, sessionId, agentConversationId, sessionConfig, options, resumeLock),
  );
}

/**
 * The infrastructure + init sequence of createDockerSession, bound to the
 * session's logger claim. On failure the session (or the bundle this
 * factory built) is torn down, then the claim on the session directory and
 * the logger claim are released.
 */
async function startDockerSession(
  agentId: import('../docker/agent-adapter.js').AgentId,
  sessionId: SessionId,
  agentConversationId: AgentConversationId,
  sessionConfig: SessionDirConfig,
  options: SessionOptions,
  resumeLock: ProcessLockHandle | undefined,
): Promise<Session> {
  // A standalone session's claim on its directory. The session owns it once
  // constructed and releases it in close(), after its bundle is torn down;
  // until then the catch below releases it.
  let sessionLock = resumeLock;
  let session: InstanceType<typeof import('../docker/docker-agent-session.js').DockerAgentSession> | undefined;
  // Track the infra bundle in outer scope so the catch path can clean
  // up containers/proxies even if failure happens BEFORE the session
  // instance exists (e.g., seeding CLAUDE.md throws, or the
  // DockerAgentSession constructor throws). Without this, the session
  // is undefined and `session?.close()` is a no-op — the container,
  // sidecar, network, and proxies all leak.
  let infra:
    Awaited<ReturnType<typeof import('../docker/docker-infrastructure.js').createDockerInfrastructure>> | undefined;
  // Tracks whether THIS factory allocated the infra bundle. When true and
  // the session never reaches a constructed state, the catch path tears
  // down the bundle directly. When false (borrow path), the caller owns
  // the bundle and the factory must NEVER destroy it, even on error.
  let builtInfra = false;
  try {
    const { DockerAgentSession } = await import('../docker/docker-agent-session.js');
    const { buildDockerClaudeMd } = await import('../docker/claude-md-seed.js');
    const { syncConversationStateClaudeMd } = await import('../docker/conversation-state.js');

    if (options.workflow?.infrastructure) {
      // Borrow path: the orchestrator owns the bundle's lifetime. We do
      // not call createDockerInfrastructure(); we do not destroy on close.
      // The orchestrator is also responsible for `setTokenSessionId`: it
      // flips the MITM proxy's routing target to the active agent's session
      // ID before each run and clears it on session end.
      infra = options.workflow.infrastructure;
    } else {
      // Standalone path: factory creates and owns the bundle. A fresh
      // session's directory exists only now that buildSessionConfig() has
      // created it; claim it before any container is built.
      sessionLock ??= claimSessionDirectory(sessionConfig.sessionDir, sessionId, 'start');
      // Single-session invariant (§2.1 of workflow-session-identity): the
      // SessionId value doubles as the BundleId. The helper preserves
      // the deterministic `ironcurtain-<sessionId[0:12]>` container
      // name for prior-crash recovery.
      const bundleId = bundleIdFromSessionId(sessionId);
      const { createDockerInfrastructure, dockerWorkloadSessionMetadata } =
        await import('../docker/docker-infrastructure.js');
      // Trajectory-capture: pass the RAW override; the infra layer is the
      // single place that resolves it against userConfig. Writer is only
      // constructed when enabled — zero cost when disabled. See
      // docs/designs/mitm-token-trajectory-capture.md §10.
      infra = await createDockerInfrastructure(
        sessionConfig.config,
        { kind: 'docker', agent: agentId },
        sessionConfig.sessionDir,
        sessionConfig.sandboxDir,
        sessionConfig.escalationDir,
        bundleId,
        options.workflow?.workflowRunId,
        undefined,
        sessionConfig.resolvedSkills,
        {
          override: options.captureTracesOverride,
          capturesDir: getSessionCapturesDir(sessionId),
          recordedAgentName: agentId,
        },
        undefined, // scriptsDir
        {
          preparedImageResolution: options.preparedDockerImageResolution,
          onHostPrivilegedFiles: options.onDiagnostic,
          signal: options.abortSignal,
          // A workflow state that owns its container: its coordinator
          // offers workflow_commit (the borrow path above keeps the
          // bundle's own handler).
          ...(options.workflow?.workflowCommit ? { workflowCommit: options.workflow.workflowCommit } : {}),
        },
        options.providerProfileName,
      );
      // Standalone sessions use their bundle for the session's entire
      // lifetime; pin the token-stream routing ID to this session's ID.
      // Clearing on close is unnecessary because the bundle itself is
      // destroyed by `session.close()` (ownsInfra=true).
      infra.setTokenSessionId(sessionId);
      builtInfra = true;

      // §8.4: persist the Docker-workload lease identity + watchdog-policy binding
      // for audit/inspection. Merged into the metadata `buildSessionConfig`
      // already wrote — the lease tuple is only known after admission, which
      // runs inside `createDockerInfrastructure`. Inert for ordinary sessions
      // (handle present only for an admitted variant); a Docker-workload
      // bundle is ephemeral and never resumed, so overwriting here is safe.
      const resolvedDockerWorkload = sessionConfig.config.userConfig.dockerWorkload;
      if (infra.dockerWorkload && !options.resumeSessionId && resolvedDockerWorkload?.enabled === true) {
        updateSessionMetadata(sessionId, {
          dockerWorkload: dockerWorkloadSessionMetadata(
            infra.dockerWorkload,
            resolvedDockerWorkload,
            infra.runtimeKind,
          ),
        });
      }
    }

    const metricsWorkflowRunId = options.workflow?.workflowRunId ?? infra.workflowId;
    if (
      options.workflow?.workflowRunId !== undefined &&
      infra.workflowId !== undefined &&
      options.workflow.workflowRunId !== infra.workflowId
    ) {
      throw new SessionError(
        'workflow run ID does not match the borrowed Docker infrastructure',
        'SESSION_INIT_FAILED',
      );
    }

    const claudeMdContent = buildDockerClaudeMd({
      personaName: options.persona,
      memoryEnabled: sessionConfig.memoryEnabled,
    });

    // Seed CLAUDE.md into the conversation state dir on every start (even on
    // resume, since persona/memory config may change between sessions), or
    // remove a stale one when memory is off or the adapter is not Claude Code.
    // Memory is always off on a borrowed workflow bundle (it runs no memory
    // server), so every workflow state there removes whatever an earlier
    // state left. The dir is the agent's read-write state mount (~/.claude/
    // for Claude Code), so the helper replaces or unlinks the entry and never
    // writes through a link or FIFO the agent planted there.
    if (infra.conversationStateDir) {
      syncConversationStateClaudeMd({
        conversationStateDir: infra.conversationStateDir,
        adapterId: infra.adapter.id,
        content: claudeMdContent,
      });
    }

    const systemPromptOverride = sessionConfig.systemPromptAugmentation
      ? `${infra.systemPrompt}\n\n${sessionConfig.systemPromptAugmentation}`
      : undefined;

    session = new DockerAgentSession({
      config: sessionConfig.config,
      sessionId,
      agentConversationId,
      infra,
      // Ownership mirrors who allocated the bundle: standalone path owns
      // and tears down on close; borrow path leaves the bundle alive for
      // the external orchestrator.
      ownsInfra: builtInfra,
      // The caller's override, else the persona's agentModelId, passed on
      // every turn. A session on the global model has none; the session
      // then hands the adapter its config's own agentModelId each turn, so
      // an adapter registered for an earlier session (the registry is
      // process-wide) or a shared bundle never decides the model.
      agentModelOverride: sessionConfig.agentModelOverride,
      metricsStateId: options.workflow?.stateId,
      metricsPersonaId: options.workflow?.personaId ?? options.persona,
      metricsWorkflowRunId,
      onEscalation: options.onEscalation,
      onEscalationExpired: options.onEscalationExpired,
      onEscalationResolved: options.onEscalationResolved,
      onDiagnostic: options.onDiagnostic,
      systemPromptOverride,
      logClaim: sessionConfig.logClaim,
      sessionLock,
      hostModelNotices: sessionConfig.hostModelNotices,
      policyWarnings: sessionConfig.policyWarnings,
    });

    await session.initialize();
    return session;
  } catch (error) {
    // If the session was constructed, its close() respects the ownsInfra
    // flag we passed in: standalone sessions (ownsInfra=true) destroy the
    // bundle they own; borrow-mode sessions (ownsInfra=false) leave the
    // caller's bundle intact. close() then releases the claim on the
    // session directory, if the session holds one. We need only invoke
    // close() -- no conditional cleanup here.
    //
    // Otherwise, if we allocated the bundle ourselves but failed before
    // the session was constructed (e.g., the DockerAgentSession
    // constructor threw, or seeding CLAUDE.md threw), destroy it
    // directly. NEVER destroy a caller-supplied bundle on this branch --
    // `builtInfra` is false in borrow mode, so the guard below skips it.
    // The directory is handed back only after that teardown.
    let failure = error;
    const { deliverHostPrivilegedFilesDiagnostic, includeHostPrivilegedFilesInFailure } =
      await import('../docker/host-mount-privilege-scan.js');
    if (session) {
      await session.close().catch(() => {});
      const notice = session
        .getDiagnosticLog()
        .filter((event) => event.kind === 'host_privileged_files')
        .at(-1);
      if (notice) failure = includeHostPrivilegedFilesInFailure(failure, notice);
    } else {
      if (builtInfra && infra) {
        const { destroyDockerInfrastructure } = await import('../docker/docker-infrastructure.js');
        const teardown = await destroyDockerInfrastructure(infra).catch(() => undefined);
        const notice = deliverHostPrivilegedFilesDiagnostic(teardown?.privilegedFiles, options.onDiagnostic);
        failure = includeHostPrivilegedFilesInFailure(failure, notice);
      }
      if (sessionLock) releaseSessionDirectory(sessionLock);
    }
    logger.release(sessionConfig.logClaim);
    throw failure instanceof SessionError
      ? failure
      : new SessionError(
          `Docker session failed: ${failure instanceof Error ? failure.message : String(failure)}`,
          'SESSION_INIT_FAILED',
        );
  }
}

/** Paths and patched config produced by buildSessionConfig. */
export interface SessionDirConfig {
  config: IronCurtainConfig;
  sessionDir: string;
  sandboxDir: string;
  escalationDir: string;
  auditLogPath: string;
  /** Resolved system prompt augmentation (may include persona augmentation). */
  systemPromptAugmentation?: string;
  /** Memory MCP gate decision derived from persona/job/userConfig. */
  memoryEnabled: boolean;
  /**
   * Skills resolved via user → persona → workflow last-wins. Always
   * `[]` in borrow mode — staging happened in-place via
   * `borrowInfra.restageSkills`, so callers shouldn't re-stage.
   */
  resolvedSkills?: readonly ResolvedSkill[];
  /**
   * The session's claim on the logger: its lines (and, while it is the
   * newest claim, everything no other claim is bound to) go to the session
   * log. Whoever owns the session releases it (`logger.release`) when the
   * session ends; the sessions do so in close().
   */
  logClaim: logger.LoggerClaim;
  /**
   * Host-model roles that run differently in this session for lack of
   * credentials (see host-model-roles.ts). Already logged and applied to
   * `config.userConfig`; sessions report them as diagnostics.
   */
  hostModelNotices: readonly HostModelNotice[];
  /**
   * Warnings about the session's compiled policy (stale provenance, rules
   * without a server condition), each the text the provenance check
   * reported. Already in the session log (and on stderr for a caller
   * without onDiagnostic); sessions report them as `policy_stale` notices.
   */
  policyWarnings: readonly string[];
  /**
   * The agent model this session runs with when something other than the
   * global `agentModelId` chose it: the caller's `agentModelOverride`, else
   * the persona's `agentModelId`. `config` already carries it as its agent
   * model; session classes pass it to every agent turn as well. Undefined
   * when the global model applies.
   */
  agentModelOverride?: string;
}

/**
 * Validates that a policyDir path resolves to one of the exact directories
 * IronCurtain compiles policies into (the global, persona, job and published
 * task-scope ones under the IronCurtain home, or the package's bundled ones)
 * and that no other user can write it. Prevents loading attacker-controlled
 * policy files, such as one an agent wrote into its session sandbox.
 *
 * Thin wrapper around the shared validator in `config/validate-policy-dir.ts`
 * so failures surface as `SessionError` with our standard code — the
 * shared helper throws `PolicyDirValidationError`, which other callers
 * (e.g., the coordinator's `loadPolicy` RPC) surface in their own way.
 *
 * Returns the realpath-canonicalized path. Callers must use the return
 * value for all subsequent reads: feeding the original (possibly-symlinked)
 * path to downstream artifact loaders would reopen the symlink-swap TOCTOU
 * window the validator was introduced to close.
 *
 * @throws {SessionError} if the path is not such a directory or another user can write it.
 */
function validatePolicyDir(policyDir: string): string {
  try {
    return sharedValidatePolicyDir(policyDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SessionError(message, 'SESSION_INIT_FAILED');
  }
}

/**
 * Fails closed when a scoped (per-job, per-persona or resumed) policy
 * directory holds no compiled policy. The policy loaders fall back to the
 * package-bundled default policy for any artifact missing from the primary
 * directory, so without this check a job whose compile failed, was
 * interrupted or never ran would silently run unattended under the broad
 * default policy instead of its narrow task policy. This one check covers
 * every scoped entry point: the cron scheduler, `run-job`, web `jobs.run`
 * and resumed sessions that restore `policyDir` from metadata.
 *
 * @throws {SessionError} when `<policyDir>/compiled-policy.json` is not a file.
 */
function requireScopedCompiledPolicy(policyDir: string): void {
  const policyPath = resolve(policyDir, COMPILED_POLICY_FILENAME);
  if (statSync(policyPath, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new SessionError(
      `No compiled policy at ${policyPath}. A per-job or per-persona policy directory must hold its own ` +
        `${COMPILED_POLICY_FILENAME}; refusing to fall back to the default policy. ` +
        'Compile the policy first (ironcurtain daemon recompile-job <id> or ironcurtain persona compile <name>).',
      'SESSION_INIT_FAILED',
    );
  }
}

/**
 * Loads the compiled policy a session will enforce and checks its provenance
 * against this IronCurtain and the tool annotations in effect (the global
 * annotations, layered over the package's, whichever policy dir is in use).
 *
 * A scoped policy (`policyDir`, already validated and known to hold a
 * compiled-policy.json) is read from its own directory only, never falling
 * back to the package policy, so the server set always matches the policy
 * enforced. Without one, the global policy is read, falling back to the
 * package's. A policy refused under `policy.onStale: "refuse"` surfaces as a
 * `SessionError`.
 */
function loadSessionPolicy(
  config: IronCurtainConfig,
  policyDir: string | undefined,
  provenanceCheck: PolicyProvenanceCheckOptions,
): CompiledPolicyFile {
  // Tool annotations are global, whichever policy dir is in use.
  const toolAnnotationsDir = config.toolAnnotationsDir ?? config.generatedDir;
  try {
    if (policyDir) {
      const annotations = loadToolAnnotations(toolAnnotationsDir, getPackageGeneratedDir())?.annotations;
      return loadPersonaPolicyArtifacts(policyDir, { provenanceCheck: { ...provenanceCheck, annotations } })
        .compiledPolicy;
    }
    return loadGeneratedPolicy({
      policyDir: config.generatedDir,
      toolAnnotationsDir,
      fallbackDir: getPackageGeneratedDir(),
      provenanceCheck,
    }).compiledPolicy;
  } catch (err) {
    // A provenance refusal becomes a SessionError, so it is never mistaken
    // for a ScopedPolicyError (constitution staleness, `--allow-stale-policy`).
    if (isStalePolicyRefusal(err)) {
      throw new SessionError(err instanceof Error ? err.message : String(err), 'SESSION_INIT_FAILED');
    }
    throw err;
  }
}

/**
 * Validates a task-scope directory (`--task-scoped`) for a session: it must
 * be a `{home}/task-policies/{key}` directory that `validatePolicyDir`
 * accepts (like any scoped policyDir) and a published task scope whose
 * compiled policy matches its recorded task.
 * Returns the canonical directory and its record; every later read uses
 * that canonical path.
 *
 * @throws {SessionError} when the directory cannot be enforced.
 */
function validateTaskPolicyDir(taskPolicyDir: string): { dir: string; record: TaskScopeRecord } {
  const dir = validatePolicyDir(taskPolicyDir);
  const check = checkTaskScopeDir(dir);
  if (!check.ok) {
    throw new SessionError(
      `${check.message}. Refusing to run the session without its task scope; ` +
        'start a new task-scoped session to compile the scope again.',
      'SESSION_INIT_FAILED',
    );
  }
  return { dir, record: check.record };
}

/**
 * A resumed session restores policyDir from its metadata, so it never passes
 * the daemon's run-time job gate (executeJob). When that directory is a cron
 * job's own policy, it must still match the job's CURRENT taskConstitution:
 * a missing policy is always refused, and a stale one unless the user
 * explicitly overrode (`--allow-stale-policy`). Returns the problem to log
 * when the override let a stale policy through.
 *
 * Only resumed sessions are checked here: a scheduled or manual job run is
 * checked by executeJob against the exact definition it runs.
 *
 * @throws {ScopedPolicyError} `POLICY_MISSING` or `POLICY_STALE`.
 */
function checkResumedJobPolicy(policyDir: string, allowStalePolicy: boolean): string | undefined {
  const check = checkJobPolicyDir(policyDir);
  if (check === undefined || check.ok) return undefined;
  if (check.problem === 'missing') throw new ScopedPolicyError(check.message, 'POLICY_MISSING');
  if (!allowStalePolicy) throw new ScopedPolicyError(check.message, 'POLICY_STALE');
  return check.message;
}

/** The session options buildSessionConfig reads. */
type SessionConfigOptions = Pick<
  SessionOptions,
  | 'resumeSessionId'
  | 'workspacePath'
  | 'providerProfileName'
  | 'policyDir'
  | 'taskPolicyDir'
  | 'disableAutoApprove'
  | 'persona'
  | 'allowStalePolicy'
  | 'systemPromptAugmentation'
  | 'jobId'
  | 'resourceBudgetOverrides'
  | 'resourceBudgetBaseline'
  | 'workflow'
  | 'agentConversationId'
  | 'mode'
  | 'agentModelOverride'
  | 'onDiagnostic'
>;

/**
 * The constitution scope this session's human approvals are recorded under
 * in the approval history (policy learning): the persona's, a cron job's own
 * policy, or the global policy. Undefined for any other explicit policy
 * directory (the read-only policy constitution generation uses, a directory
 * picked by hand), whose constitution no customize flow edits.
 */
function approvalScopeForSession(persona: string | undefined, policyDir: string | undefined): string | undefined {
  if (persona !== undefined) return personaApprovalScope(persona);
  if (policyDir === undefined) return GLOBAL_APPROVAL_SCOPE;
  try {
    const job = checkJobPolicyDir(policyDir);
    return job !== undefined ? jobApprovalScope(job.jobId) : undefined;
  } catch {
    // Advisory only: a policy directory that cannot be attributed is not recorded.
    return undefined;
  }
}

/**
 * Shared session directory setup and config patching used by both session modes.
 *
 * When workspacePath is provided, it replaces the session sandbox as the
 * agent's working directory. The workspace already exists so we skip
 * creating it, but all other session infrastructure (logs, escalations)
 * still lives under the session directory.
 *
 * When persona is set, resolves the persona to a policyDir, workspace,
 * server allowlist, and system prompt augmentation. Persona takes
 * precedence over explicit policyDir if both are provided.
 *
 * The session's agent model and resource limits are layered here, once for
 * every entry point: the caller's `agentModelOverride` over the persona's
 * `agentModelId` over the global one, and, field by field, the caller's
 * `resourceBudgetOverrides` over the persona's `resourceBudget` over the
 * caller's `resourceBudgetBaseline` over the config's `resourceBudget` (see
 * model-budget-precedence.ts). A persona whose `agentModelId` or
 * `resourceBudget` is malformed is refused before anything is created.
 *
 * Scoped policies fail closed: a persona whose compiled policy is missing,
 * or stale without `allowStalePolicy`, and an explicit policyDir without a
 * compiled-policy.json both throw instead of falling back to the default
 * policy. A resumed cron job session whose job policy no longer matches the
 * job's constitution is refused the same way.
 *
 * A task scope (`taskPolicyDir`, from `--task-scoped`) does not replace the
 * session policy: it is validated, recorded as `config.taskPolicyDir` for
 * the coordinator to intersect with the session policy, and persisted in
 * the session metadata so a resume keeps it. A task scope that does not
 * validate refuses the session.
 */
export function buildSessionConfig(
  config: IronCurtainConfig,
  effectiveSessionId: string,
  sessionId: SessionId,
  opts: SessionConfigOptions = {},
): SessionDirConfig {
  let { workspacePath, policyDir, systemPromptAugmentation } = opts;
  const { resumeSessionId, disableAutoApprove } = opts;
  let serverAllowlist: readonly string[] | undefined;
  let personaDef: PersonaDefinition | undefined = undefined;
  let personaOverrides: PersonaOverrides | undefined;
  let stalePersonaPolicy: ResolvedPersona['stalePolicy'];
  let staleResumedJobPolicy: string | undefined;

  // Borrow-mode invariant: per-state artifact dir / slug only make sense
  // alongside an infrastructure bundle. The nested record keeps these
  // fields colocated; the runtime guard catches the all-or-nothing
  // mismatch (the union of the two-bit input domain isn't expressible
  // at the type level without a discriminator on the workflow record).
  if (opts.workflow?.stateDir && !opts.workflow.infrastructure) {
    throw new SessionError(
      'workflow.stateDir requires workflow.infrastructure; borrow-mode artifacts have no owner without a bundle',
      'SESSION_INIT_FAILED',
    );
  }
  // A borrowed bundle's container and coordinator were built when it was
  // minted, with its scope's workspace access; a session cannot change that.
  const readOnlyWorkspace = opts.workflow?.readOnlyWorkspace;
  if (readOnlyWorkspace && opts.workflow.infrastructure) {
    throw new SessionError(
      'workflow.readOnlyWorkspace applies to a session that builds its own environment; a borrowed bundle ' +
        "carries its scope's workspace access",
      'SESSION_INIT_FAILED',
    );
  }

  // Resolve persona early -- derives policyDir, workspace, and server
  // filter from the persona definition. The persona system prompt
  // augmentation is deferred until after the memory gate is computed
  // with the full (persona + job) scope, so the augmentation and the
  // server bolt-on cannot disagree when both opts.persona and opts.jobId
  // are set.
  if (opts.persona) {
    // Refuses a missing or stale persona policy unless the caller passed the
    // explicit interactive override (allowStalePolicy).
    const resolved = resolvePersona(opts.persona, { allowStalePolicy: opts.allowStalePolicy === true });
    personaDef = resolved.persona;
    // Refuses a malformed agentModelId / resourceBudget (PersonaOverridesError)
    // before any directory or log file exists for the session.
    personaOverrides = readPersonaOverrides(opts.persona, resolved.persona);
    stalePersonaPolicy = resolved.stalePolicy;
    if (policyDir) {
      logger.warn('Both persona and policyDir specified; using persona.');
    }
    policyDir = resolved.policyDir;
    serverAllowlist = resolved.persona.servers;

    // Use persona workspace unless an explicit workspacePath was provided
    if (!workspacePath) {
      workspacePath = resolved.workspacePath;
    }

    logger.info(`Persona "${opts.persona}" resolved: policyDir=${policyDir}`);
  }

  // A borrowed workflow bundle (shared-container mode) brings its own
  // workspace, escalation dir, audit log and MCP servers; see the path
  // selection below.
  const borrowInfra = opts.workflow?.infrastructure;

  // Single gate computation with the full scope. Reused for the persona
  // augmentation, the cron-job memory prompt, and the server bolt-on so
  // the prompt cannot mention memory while the relay is gated off (or
  // vice versa); `createDockerSession` and the PTY session seed CLAUDE.md
  // from the same result. A borrowed bundle runs no memory server (its
  // servers were fixed by the workflow's infrastructure factory, not by
  // this config), so the gate is closed there. Skip the loadJob disk read
  // when the global kill switch would short-circuit anyway.
  const memoryConfig = config.userConfig.memory;
  const jobDef = memoryConfig.enabled && opts.jobId ? loadJob(createJobId(opts.jobId)) : undefined;
  const memoryEnabled = isMemoryEnabledFor({
    persona: personaDef,
    job: jobDef,
    userConfig: config.userConfig,
    borrowedBundle: borrowInfra !== undefined,
  });

  if (personaDef) {
    const personaAugmentation = buildPersonaSystemPromptAugmentation(personaDef, memoryEnabled);
    systemPromptAugmentation = systemPromptAugmentation
      ? `${personaAugmentation}\n\n${systemPromptAugmentation}`
      : personaAugmentation;
  }

  if (policyDir) {
    // Use the validator's realpath-canonicalized return value. Passing
    // the original (possibly-symlinked) path through to `generatedDir`
    // would reopen the symlink-swap TOCTOU window the validator was
    // introduced to close: downstream artifact reads (compiled policy,
    // dynamic lists) must happen against the same canonical path the
    // containment check approved.
    policyDir = validatePolicyDir(policyDir);
    requireScopedCompiledPolicy(policyDir);
    if (resumeSessionId) {
      staleResumedJobPolicy = checkResumedJobPolicy(policyDir, opts.allowStalePolicy === true);
    }
  }

  // Load the session's policy before anything is created for the session.
  // Its provenance is compared with this IronCurtain and the tool annotations
  // in effect: a stale policy (another compiler epoch or engine semantics,
  // other annotations, or no provenance at all) is reported loudly, or
  // refused under `policy.onStale: "refuse"`. A refused session leaves no
  // directories or console redirection behind. Every warning goes to the
  // session log and to the session, which emits it as a `policy_stale`
  // start-up notice for the caller to show: the CLI prints it after its
  // initialization spinner, the web UI and Signal show it, a cron run keeps
  // it in its run record, a workflow prints it. Only a caller without
  // onDiagnostic (the PTY session, before its spinner starts; the
  // constitution generator) still gets it on stderr here.
  const policyWarnings: string[] = [];
  const policyForFilter = loadSessionPolicy(config, policyDir, {
    onStale: config.userConfig.policy?.onStale,
    owner: {
      persona: opts.persona,
      // A cron job without a persona runs on its own policy dir.
      jobId: !opts.persona && opts.policyDir ? opts.jobId : undefined,
    },
    report: (text) => {
      policyWarnings.push(text);
      if (opts.onDiagnostic === undefined) process.stderr.write(text);
    },
  });

  // `--task-scoped`: the task scope narrows whichever policy the session
  // runs under. Validated the same way as a scoped policyDir and read from
  // its canonical path only, also before anything is created; a directory
  // that does not validate refuses the session (there is no stale-policy
  // override for a task scope). A scope already on the caller's config is
  // kept, never dropped.
  const requestedTaskPolicyDir = opts.taskPolicyDir ?? config.taskPolicyDir;
  const taskScope = requestedTaskPolicyDir === undefined ? undefined : validateTaskPolicyDir(requestedTaskPolicyDir);

  // Paths differ by mode:
  // - Borrow mode: per-state artifacts go under `workflow.stateDir` when
  //   the orchestrator supplied one; otherwise fall back to the bundle's
  //   bundleDir (legacy path, still used by factory-level tests). The
  //   bundle owns workspace/escalation/audit on `workflow.infrastructure`.
  // - Standalone/CLI: everything lives under `{home}/sessions/{id}/`.
  const artifactDir = borrowInfra ? (opts.workflow.stateDir ?? borrowInfra.bundleDir) : undefined;
  const sessionDir = artifactDir ?? getSessionDir(effectiveSessionId);
  const sandboxDir = workspacePath ?? getSessionSandboxDir(effectiveSessionId);
  const escalationDir = borrowInfra ? borrowInfra.escalationDir : getSessionEscalationDir(effectiveSessionId);
  const auditLogPath = borrowInfra ? borrowInfra.auditLogPath : getSessionAuditLogPath(effectiveSessionId);

  // Standalone mode creates its own session tree. Borrow mode relies on
  // directories the orchestrator and bundle already own.
  if (!borrowInfra) {
    // The session directory holds the session's logs and transcripts
    // (audit.jsonl, session.log, LLM interaction logs, interactions.jsonl,
    // escalations): owner-only, created before anything is written into it.
    // A resumed session's directory from an older release is tightened too.
    ensurePrivateDirectory(sessionDir);
    if (!opts.workspacePath) {
      mkdirSync(sandboxDir, { recursive: true });
    }
    mkdirSync(escalationDir, { recursive: true });
  }

  const sessionLogPath = artifactDir
    ? resolve(artifactDir, SESSION_LOG_FILENAME)
    : getSessionLogPath(effectiveSessionId);
  // llm-interactions / auto-approve-llm still live under the standalone
  // session dir even in borrow mode (per-turn LLM logs are not scoped to
  // the workflow state artifact dir; config.llmLogPath is only read when
  // the builtin agent is active, and borrow-mode sessions are Docker).
  // What they record follows observability.llmInteractionLog
  // (src/observability/session-llm-log.ts).
  const llmLogPath = getSessionLlmLogPath(effectiveSessionId);
  const autoApproveLlmLogPath = getSessionAutoApproveLlmLogPath(effectiveSessionId);

  // Set up session logging -- captures all console output to file. The
  // session binds its own work to this claim (logger.runWithClaim), so its
  // lines land here even while the daemon or other sessions in this
  // process log too, and close() releases only this claim. Everything
  // below already runs bound to it.
  const logClaim = logger.setup({ logFilePath: sessionLogPath });
  try {
    return logger.runWithClaim(logClaim, () =>
      completeSessionConfig({
        config,
        opts,
        effectiveSessionId,
        sessionId,
        logClaim,
        workspacePath,
        policyDir,
        systemPromptAugmentation,
        resumeSessionId,
        disableAutoApprove,
        serverAllowlist,
        personaOverrides,
        personaMemoryNamespace: personaDef?.memoryNamespace,
        stalePersonaPolicy,
        staleResumedJobPolicy,
        policyWarnings,
        policyForFilter,
        taskScope,
        memoryConfig,
        memoryEnabled,
        borrowInfra,
        readOnlyWorkspace,
        artifactDir,
        sessionDir,
        sandboxDir,
        escalationDir,
        auditLogPath,
        sessionLogPath,
        llmLogPath,
        autoApproveLlmLogPath,
      }),
    );
  } catch (error) {
    // A config that was never handed out leaves no claim behind.
    logger.release(logClaim);
    throw error;
  }
}

/** What buildSessionConfig has resolved by the time it claims the session log. */
interface PendingSessionConfig {
  readonly config: IronCurtainConfig;
  readonly opts: SessionConfigOptions;
  readonly effectiveSessionId: string;
  readonly sessionId: SessionId;
  readonly logClaim: logger.LoggerClaim;
  readonly workspacePath: string | undefined;
  readonly policyDir: string | undefined;
  readonly systemPromptAugmentation: string | undefined;
  readonly resumeSessionId: string | undefined;
  readonly disableAutoApprove: boolean | undefined;
  readonly serverAllowlist: readonly string[] | undefined;
  /** The persona's validated agent model and resource limits, if any. */
  readonly personaOverrides: PersonaOverrides | undefined;
  /**
   * The namespace a renamed persona's memories were stored under
   * (persona.json `memoryNamespace`), if it sets one.
   */
  readonly personaMemoryNamespace: string | undefined;
  readonly stalePersonaPolicy: ResolvedPersona['stalePolicy'];
  readonly staleResumedJobPolicy: string | undefined;
  readonly policyWarnings: readonly string[];
  readonly policyForFilter: CompiledPolicyFile;
  /** The validated `--task-scoped` scope, if any. */
  readonly taskScope: ReturnType<typeof validateTaskPolicyDir> | undefined;
  readonly memoryConfig: IronCurtainConfig['userConfig']['memory'];
  readonly memoryEnabled: boolean;
  readonly borrowInfra: NonNullable<SessionConfigOptions['workflow']>['infrastructure'];
  /**
   * The read-only workspace of a `workspaceAccess: read-only` workflow state
   * that builds its own environment (`workflow.readOnlyWorkspace`), if any.
   * Never set together with `borrowInfra` (refused before the log claim).
   */
  readonly readOnlyWorkspace: ReadOnlyWorkspace | undefined;
  readonly artifactDir: string | undefined;
  readonly sessionDir: string;
  readonly sandboxDir: string;
  readonly escalationDir: string;
  readonly auditLogPath: string;
  readonly sessionLogPath: string;
  readonly llmLogPath: string;
  readonly autoApproveLlmLogPath: string;
}

/**
 * The rest of buildSessionConfig once the session log is claimed. It runs
 * bound to the session's claim, so everything it (and what it calls)
 * logs lands in the session log, whichever context builds the session.
 */
function completeSessionConfig(pending: PendingSessionConfig): SessionDirConfig {
  const {
    config,
    opts,
    effectiveSessionId,
    sessionId,
    logClaim,
    workspacePath,
    policyDir,
    resumeSessionId,
    disableAutoApprove,
    serverAllowlist,
    personaOverrides,
    personaMemoryNamespace,
    stalePersonaPolicy,
    staleResumedJobPolicy,
    policyWarnings,
    policyForFilter,
    taskScope,
    memoryConfig,
    memoryEnabled,
    borrowInfra,
    readOnlyWorkspace,
    artifactDir,
    sessionDir,
    sandboxDir,
    escalationDir,
    auditLogPath,
    sessionLogPath,
    llmLogPath,
    autoApproveLlmLogPath,
  } = pending;
  let { systemPromptAugmentation } = pending;
  logger.info(`Session ${sessionId} created${opts.workflow?.stateSlug ? ` (state=${opts.workflow.stateSlug})` : ''}`);
  logger.info(`${workspacePath ? 'Workspace' : 'Sandbox'}: ${sandboxDir}`);
  logger.info(`Escalation dir: ${escalationDir}`);
  logger.info(`Audit log: ${auditLogPath}`);
  logger.info(`LLM log: ${llmLogPath}`);
  if (resumeSessionId) {
    logger.info(`Resumed from session: ${resumeSessionId}`);
  }
  if (stalePersonaPolicy) {
    logger.warn(
      `Persona "${opts.persona}" has a stale compiled policy (${stalePersonaPolicy.detail}); ` +
        'running with it anyway because the stale-policy override was given.',
    );
  }
  if (staleResumedJobPolicy) {
    logger.warn(`${staleResumedJobPolicy}. Resuming with it anyway because the stale-policy override was given.`);
  }
  for (const warning of policyWarnings) {
    logger.warn(warning.trimEnd());
  }
  if (taskScope) {
    logger.info(
      `Task scope: ${taskScope.dir} (task ${taskScope.record.taskHash.slice(0, 12)}): ${taskScope.record.task}`,
    );
  }

  // Agent model: the caller's override (`--model`, a workflow state's or
  // workflow's model) over the persona's agentModelId over the global one.
  // It goes into both config fields the session layers read.
  const agentModel = resolveSessionAgentModel({
    override: opts.agentModelOverride,
    persona: personaOverrides?.agentModelId,
    global: config.agentModelId,
  });
  const modelConfig = agentModel.source === 'global' ? config : withAgentModelId(config, agentModel.modelId);
  logger.info(
    `Agent model: ${agentModel.modelId} (${
      agentModel.source === 'persona' ? `persona "${opts.persona}"` : agentModel.source
    })`,
  );

  // Build userConfig overrides (auto-approver disable, resource budget).
  // Composed incrementally so multiple overrides don't clobber each other.
  let patchedUserConfig = modelConfig.userConfig;
  if (disableAutoApprove) {
    patchedUserConfig = { ...patchedUserConfig, autoApprove: { ...patchedUserConfig.autoApprove, enabled: false } };
  }
  // Resource limits, field by field: the caller's explicit limits over the
  // persona's over the caller's defaults over the config's.
  const personaBudget = personaOverrides?.resourceBudget;
  if (opts.resourceBudgetBaseline || personaBudget || opts.resourceBudgetOverrides) {
    patchedUserConfig = {
      ...patchedUserConfig,
      resourceBudget: layerResourceBudget(
        patchedUserConfig.resourceBudget,
        opts.resourceBudgetBaseline,
        personaBudget,
        opts.resourceBudgetOverrides,
      ),
    };
  }
  if (personaBudget && Object.keys(personaBudget).length > 0) {
    logger.info(`Persona "${opts.persona}" resource limits: ${JSON.stringify(personaBudget)}`);
  }

  // Host-side models without credentials: auto-compaction falls back to
  // the agent's model, auto-approve is turned off, memory runs without
  // its LLM (see host-model-roles.ts). The session reports each notice
  // as a `host_model_fallback` diagnostic while it initializes.
  const hostModelPlan = planHostModelRoles(patchedUserConfig, {
    mode: opts.mode?.kind === 'docker' ? 'docker' : 'builtin',
    // The model the session's agent runs: the caller's override, else the
    // persona's agentModelId, else the global one.
    agentModelId: agentModel.modelId,
    memoryEnabled,
  });
  patchedUserConfig = hostModelPlan.userConfig;
  for (const notice of hostModelPlan.notices) {
    logger.warn(`[host-model] ${notice.message}`);
  }

  // Override config paths for this session's isolated directories.
  // Deep-clone mcpServers so patching doesn't mutate the caller's config.
  const baseSessionConfig = {
    ...modelConfig,
    allowedDirectory: sandboxDir,
    auditLogPath,
    escalationDir,
    sessionLogPath,
    llmLogPath,
    autoApproveLlmLogPath,
    // When per-job/persona policy is provided, split generated dir:
    // generatedDir -> per-job/persona dir (compiled policy + dynamic lists)
    // toolAnnotationsDir -> global dir (tool annotations)
    ...(policyDir
      ? {
          generatedDir: policyDir,
          toolAnnotationsDir: config.toolAnnotationsDir ?? config.generatedDir,
        }
      : {}),
    // The validated, canonical task-scope directory (if any).
    taskPolicyDir: taskScope?.dir,
    mcpServers: JSON.parse(JSON.stringify(config.mcpServers)) as typeof config.mcpServers,
    userConfig: patchedUserConfig,
    approvalHistoryScope: approvalScopeForSession(opts.persona, policyDir),
  };
  // A read-only workflow state: read-only workspace mount, no nested Docker,
  // and a policy engine that denies every change outside its outputs.
  const sessionConfig: IronCurtainConfig = readOnlyWorkspace
    ? applyReadOnlyWorkspace(baseSessionConfig, readOnlyWorkspace)
    : baseSessionConfig;

  // Apply server allowlist if persona specifies one
  if (serverAllowlist) {
    sessionConfig.mcpServers = applyServerAllowlist(sessionConfig.mcpServers, serverAllowlist);
  }

  // A read-only session writes its outputs through the filesystem server
  // (its own tools cannot write the read-only workspace), so it is kept even
  // when no compiled rule names it. A persona allowlist above never removes
  // it: applyServerAllowlist always keeps the filesystem server.
  const requiredServers = extractRequiredServers(policyForFilter);
  if (readOnlyWorkspace) requiredServers.add(READ_ONLY_OUTPUT_SERVER);
  sessionConfig.mcpServers = filterMcpServersByPolicy(sessionConfig.mcpServers, requiredServers);

  // Inject the memory MCP server for persona and cron job sessions only.
  // Default (ad-hoc) sessions are stateless and don't benefit from memory.
  // The gate decision was made once above; reuse it here so the prompt
  // and the relay cannot diverge. Never reached in borrow mode, where the
  // gate is closed: the borrowed bundle's servers are already running.
  if (memoryEnabled) {
    const dbPath = resolveMemoryDbPath({
      persona: opts.persona,
      jobId: opts.jobId,
    });
    mkdirSync(dirname(dbPath), { recursive: true });
    // Every memory this server stores records who wrote it: the kind of session
    // (an unattended cron job or workflow state, or one a person drives) and its
    // id. Both come from here, never from the agent. What an unattended session
    // writes waits for review under its scope: the job (its later runs see it)
    // or the workflow run (its later states do); interactive sessions see it
    // only once the user approved it (`ironcurtain memory ... review`).
    const writerKind: MemoryWriterKind = opts.workflow ? 'workflow' : opts.jobId ? 'cron' : 'interactive';
    const writerScope =
      writerKind === 'workflow'
        ? workflowMemoryScope(opts.workflow?.workflowRunId ?? effectiveSessionId)
        : writerKind === 'cron' && opts.jobId !== undefined
          ? cronMemoryScope(opts.jobId)
          : undefined;
    const memoryServerOptions: MemoryServerOptions = {
      dbPath,
      // A renamed persona keeps the namespace its memories were stored under
      // (persona.json `memoryNamespace`); the database is always its own.
      namespace: personaMemoryNamespace ?? opts.persona ?? opts.jobId,
      llmBaseUrl: memoryConfig.llmBaseUrl,
      llmApiKey: memoryConfig.llmApiKey,
      anthropicApiKey: config.userConfig.anthropicApiKey,
      anthropicBaseUrl: config.userConfig.anthropicBaseUrl,
      writer: {
        kind: writerKind,
        sessionId: effectiveSessionId,
        ...(writerScope === undefined ? {} : { scope: writerScope }),
      },
      offlineModels: memoryConfig.offlineModels,
    };
    sessionConfig.mcpServers[MEMORY_SERVER_NAME] = buildMemoryServerConfig(memoryServerOptions);
    // The LLM key goes through the per-server credentials channel, not the
    // server config: only the memory server's relay receives it, and it is
    // never written out with the server configuration. A fresh object, so
    // the caller's userConfig is never mutated.
    const memoryCredentials = buildMemoryServerCredentials(memoryServerOptions);
    if (Object.keys(memoryCredentials).length > 0) {
      const serverCredentials = sessionConfig.userConfig.serverCredentials as
        IronCurtainConfig['userConfig']['serverCredentials'] | undefined;
      sessionConfig.userConfig = {
        ...sessionConfig.userConfig,
        serverCredentials: {
          ...serverCredentials,
          [MEMORY_SERVER_NAME]: { ...serverCredentials?.[MEMORY_SERVER_NAME], ...memoryCredentials },
        },
      };
    }

    // For non-persona cron jobs, inject memory usage instructions since
    // persona sessions get this via buildPersonaSystemPromptAugmentation.
    if (!opts.persona) {
      const memoryPrompt = adaptMemoryToolNames(buildMemorySystemPrompt());
      systemPromptAugmentation = systemPromptAugmentation
        ? `${memoryPrompt}\n\n${systemPromptAugmentation}`
        : memoryPrompt;
    }
  }

  // Patch MCP server args to use the session-specific sandbox directory
  applyAllowedDirectoryToMcpArgs(sessionConfig.mcpServers, sandboxDir);

  // Persist session settings so --resume can restore them.
  // Only write on initial creation (not when resuming).
  if (!resumeSessionId) {
    // Persist the RESOLVED active-profile name (not the raw flag) so a
    // resumed Docker session keeps its original profile even if
    // `modelProviders.default` later changes. Docker mode only: builtin
    // sessions never route through a provider profile (§9.7 F3/F4).
    const resolvedProfileName =
      opts.mode?.kind === 'docker' ? (opts.providerProfileName ?? config.userConfig.modelProviders.default) : undefined;
    const metadata = {
      createdAt: new Date().toISOString(),
      // `--resume` continues the session with this agent; see SessionMetadata.agent.
      agent: agentNameForMode(opts.mode),
      ...(opts.persona ? { persona: opts.persona } : {}),
      ...(opts.workspacePath ? { workspacePath: opts.workspacePath } : {}),
      ...(resolvedProfileName ? { providerProfileName: resolvedProfileName } : {}),
      // Only store policyDir when no persona is set (persona derives its own)
      ...(!opts.persona && policyDir ? { policyDir } : {}),
      // A task-scoped session resumes under the same task scope.
      ...(taskScope ? { taskPolicyDir: taskScope.dir } : {}),
      ...(opts.disableAutoApprove ? { disableAutoApprove: true } : {}),
      // Persist the agent-CLI conversation id so `ironcurtain --resume`
      // can continue the same Claude conversation rather than starting
      // fresh. Docker-mode sessions only; builtin has no agent CLI.
      ...(opts.agentConversationId ? { agentConversationId: opts.agentConversationId } : {}),
      // Ties a workflow state's own session (and its audit log) to the run,
      // for `ironcurtain audit report --workflow`.
      ...(opts.workflow?.workflowRunId ? { workflowRunId: opts.workflow.workflowRunId } : {}),
    };
    if (artifactDir) {
      saveSessionMetadataTo(resolve(artifactDir, SESSION_METADATA_FILENAME), metadata);
    } else {
      saveSessionMetadata(effectiveSessionId, metadata);
    }
  }

  // Borrow-mode: re-stage the bundle in-place so per-state persona skills
  // become visible without remounting. Standalone mode returns the set
  // through SessionDirConfig for the docker factory to stage at bundle
  // creation. Builtin (non-Docker) sessions never mount skills, so we
  // skip the discovery walk entirely to avoid spurious filesystem reads
  // and `[skills] Ignoring …` warnings.
  const dockerMode = opts.mode?.kind === 'docker';
  let resolvedSkills: readonly ResolvedSkill[] | undefined;
  if (borrowInfra || dockerMode) {
    resolvedSkills = resolveSkillsForSession({
      ...(opts.persona ? { personaName: opts.persona } : {}),
      ...(opts.workflow?.skillsDir ? { workflowSkillsDir: opts.workflow.skillsDir } : {}),
      ...(opts.workflow?.skillFilter ? { workflowSkillFilter: opts.workflow.skillFilter } : {}),
      ...(opts.workflow?.disableAllSkills ? { disableAllSkills: true } : {}),
    });
    if (borrowInfra) {
      borrowInfra.restageSkills(resolvedSkills);
    }
  }

  return {
    config: sessionConfig,
    sessionDir,
    sandboxDir,
    escalationDir,
    auditLogPath,
    systemPromptAugmentation,
    memoryEnabled,
    resolvedSkills: borrowInfra ? [] : resolvedSkills,
    logClaim,
    hostModelNotices: hostModelPlan.notices,
    policyWarnings,
    ...(agentModel.source !== 'global' ? { agentModelOverride: agentModel.modelId } : {}),
  };
}

// Re-export types needed by callers
export type {
  Session,
  SessionMode,
  SessionOptions,
  SessionInfo,
  SessionId,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
  SandboxFactory,
  BudgetStatus,
} from './types.js';
export type { Transport } from './transport.js';
export { SessionError, SessionNotReadyError, SessionClosedError, BudgetExhaustedError } from '../types/errors.js';
export { resolveSessionMode, PreflightError } from './preflight.js';
export type { PreflightResult, PreflightOptions } from './preflight.js';
