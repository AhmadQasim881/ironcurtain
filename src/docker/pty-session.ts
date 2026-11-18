/**
 * PTY session module -- orchestrates a Docker session where the user's
 * terminal is attached directly to Claude Code's PTY inside the container.
 *
 * Instead of the batch-oriented DockerAgentSession (docker exec per turn),
 * this module provides a native interactive experience by bridging the
 * terminal via a Node.js PTY proxy to a socat-managed PTY inside the container.
 *
 * Architecture:
 *   User terminal -> Node.js PTY proxy -> UDS/TCP -> socat (container)
 *     -> Claude Code (interactive, with PTY)
 *     -> Code Mode Proxy (MCP)
 *     -> mcp-proxy-server (PolicyEngine + Audit)
 */

import { createConnection } from 'node:net';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';

import type { IronCurtainConfig } from '../config/types.js';
import { createSessionId, getBundleShortId, type BundleId, type SessionMode } from '../session/types.js';
import { buildSessionConfig } from '../session/index.js';
import { loadResumeSessionMetadata, updateSessionMetadata } from '../session/session-metadata.js';
import { claimSessionDirectory } from '../session/session-lock.js';
import { annotationDriftDiagnostics } from '../session/annotation-drift-diagnostics.js';
import {
  formatSessionNotice,
  formatStartupNotice,
  hostModelDiagnostics,
  unavailableServerDiagnostics,
  type StartupNotice,
} from '../session/startup-notices.js';
import { buildContainerWorkspaceMount } from './container-workspace.js';
import { PTY_SOCK_NAME, DEFAULT_PTY_PORT, APPLE_PTY_GUEST_SOCK } from './pty-types.js';
import type { PtySessionRegistration, SessionSnapshot } from './pty-types.js';
import { validateResumeSession } from '../pty/session-scanner.js';
import type { ContainerRuntime } from './types.js';
import type { ContainerRuntimeKind } from './container-runtime.js';
import { prepareDockerAgentStartup } from './agent-startup.js';
import { planBundleAgentPrivileges } from './agent-privileges.js';
import {
  createBundlePrivilegedFileScanner,
  hostPrivilegedFilesNotice,
  type HostMountPrivilegeScanner,
} from './host-mount-privilege-scan.js';
import { createEscalationWatcher, atomicWriteJsonSync } from '../escalation/escalation-watcher.js';
import type { EscalationWatcher } from '../escalation/escalation-watcher.js';
import { getSessionDir, getSessionCapturesDir, getPtyRegistryDir, SESSION_STATE_FILENAME } from '../config/paths.js';
import * as logger from '../logger.js';
import type { ProcessLockHandle } from '../docker-workload/process-lock.js';
import { buildDockerClaudeMd } from './claude-md-seed.js';
import type { ConversationTranscriptLayout } from './agent-adapter.js';
import { buildPtyConversationEnv, hasStoredTranscript, syncConversationStateClaudeMd } from './conversation-state.js';
import { getInternalNetworkName } from './platform.js';
import { destroyBundleOuterResources } from './container-lifecycle.js';
import { ensureTransportSidecarImage, hardenTransportSidecarCreate } from './transport-sidecar-image.js';
import {
  tcpTransportSidecarAddress,
  tcpTransportListenEndpoint,
  tcpTransportUpstreamEndpoint,
  tcpTransportHostCaMount,
  startTcpTransportSidecar,
} from './tcp-transport-sidecar.js';
import {
  buildAgentContainerConfig,
  buildAgentUidRemap,
  buildDockerDesktopTransportCreateLimits,
  buildDockerBuildShimMounts,
  buildDockerWorkloadEgressMounts,
  buildUdsSocketMounts,
  activateNestedDockerWorkload,
  buildDockerOwnershipLabels,
  createLedgeredAgentContainer,
  createDockerSessionTransportNetwork,
  createDockerSessionTransportProxy,
  dockerWorkloadSessionMetadata,
  removeBundleRuntimeRoot,
  resolveNestedDockerAgentWiring,
  resolveNestedDockerOuterAgentImage,
  stopDockerWorkloadEgress,
  tcpSidecarProxyUrl,
  type AgentImageResolution,
} from './docker-infrastructure.js';
import { appleVmDockerWorkloadArtifactMount } from '../docker-workload/apple-private-docker.js';
import type { DockerWorkloadBundleHandle } from '../docker-workload/infrastructure.js';
import { buildRuntimeTrustEnv, stageAptProxyConfig } from './runtime-trust.js';
import { buildPackageClientEnv } from './package-client-env.js';
import { errorMessage } from '../utils/error-message.js';
import {
  finalizeManagedResourceLease,
  InternalNetworkConnectivityError,
  reconcileIronCurtainDockerResourcesBestEffort,
  withInternalNetworkAllocationRetry,
} from './docker-resource-lifecycle.js';
import type { MetricsInvocationLease } from '../llm-metrics/attribution-registry.js';
import type { LlmMetricsRuntimeLease } from '../llm-metrics/runtime.js';
import { createPtyResizeQueue, type PtyResizeQueue } from './pty-resize-queue.js';
import { createHostTerminalOutput, drainPendingTerminalInput, type HostTerminalOutput } from './pty-host-terminal.js';
import { installShutdownSignals, shutdownSignalOf, type ShutdownSignal } from '../utils/shutdown-signals.js';

export interface PtySessionOptions {
  readonly config: IronCurtainConfig;
  readonly mode: SessionMode & { kind: 'docker' };
  /** Exact Docker image prepared by the CLI before the spinner/PTY handoff. */
  readonly preparedImageResolution?: AgentImageResolution;
  /** Validated workspace path. When provided, replaces the session sandbox. */
  readonly workspacePath?: string;
  /** Session ID to resume. When set, reuses the existing session directory. */
  readonly resumeSessionId?: string;
  /** Persona name. Used to build CLAUDE.md and system prompt augmentation. */
  readonly persona?: string;
  /**
   * Explicit user override (`--allow-stale-policy`): run a persona whose
   * compiled policy no longer matches its constitution. Without it a stale
   * persona is refused. Applies to resumed sessions too.
   */
  readonly allowStalePolicy?: boolean;
  /**
   * Task scope (`--task-scoped`) compiled by the CLI entry point for a new
   * session. Ignored on resume: the session's own task scope is restored
   * from its metadata (see `buildSessionConfig`).
   */
  readonly taskPolicyDir?: string;
  /**
   * Per-session provider-profile selection (OpenRouter integration §9.7).
   * Resolved to the active profile in infra prep. On resume, the persisted
   * snapshot name wins over this field (a conflicting flag is warn-ignored
   * upstream in src/index.ts).
   */
  readonly providerProfileName?: string;
  /**
   * `--model` from the command line. It takes precedence over the persona's
   * `agentModelId`, which takes precedence over the global `agentModelId`;
   * `buildSessionConfig` resolves the three into the session config, whose
   * agent model the adapter's container environment carries.
   */
  readonly agentModelOverride?: string;
  /**
   * Trajectory-capture override: CLI flag wins over `userConfig.capture.enabled`.
   * `true` forces capture on for this run, `undefined` falls through to config.
   * See docs/designs/mitm-token-trajectory-capture.md §10.
   */
  readonly captureTracesOverride?: boolean;
  /**
   * Override for the PTY attach step. Defaults to the production `attachPty`
   * which proxies the user's terminal into the container PTY socket.
   * Tests inject a stub that performs assertions against the live container
   * (via `docker exec`) and returns an exit code without taking over stdio.
   */
  readonly attach?: PtyAttachFn;
}

export type PtyAttachFn = (options: PtyProxyOptions) => Promise<number>;

/** UDS path (Linux) or { host, port } (macOS). */
export type PtyTarget = string | { readonly host: string; readonly port: number };

export interface PtyProxyOptions {
  readonly target: PtyTarget;
  /** Outer container ID used for SIGWINCH forwarding and bounded startup-close diagnostics. */
  readonly containerId: string;
  /**
   * Active container runtime used for in-container PTY resize/verify execs and
   * host-authoritative startup-close diagnostics.
   * Routing through the runtime (rather than a hardcoded `docker exec`) keeps
   * size management working on non-Docker backends (e.g. Apple `container`).
   * Optional so error-path tests can drive `attachPty` without a runtime;
   * when absent, PTY size management and container-state diagnostics are skipped.
   */
  readonly runtime?: ContainerRuntime;
  /** Abort signal for graceful shutdown (e.g., SIGTERM). */
  readonly signal?: AbortSignal;
}

/** Maximum time to wait for the PTY socket to appear (ms). */
const PTY_READINESS_TIMEOUT_MS = 30_000;

/**
 * Extended PTY readiness timeout for the Linux UID-remap path. The
 * universal-image entrypoint does `usermod -u`, `groupmod -g`, and a
 * recursive `chown` of `/home/codespace` (Conda, NVM, Hugo, etc.) and
 * `/workspace` before exec'ing the agent, which is what eventually
 * runs socat and creates the UDS. On slower disks the chown alone can
 * take 25–30s; budget 90s so non-1000 hosts don't flap during startup.
 */
const PTY_READINESS_TIMEOUT_REMAP_MS = 90_000;

/** Poll interval when waiting for PTY socket (ms). */
const PTY_READINESS_POLL_MS = 200;

/**
 * Loads a session snapshot from disk.
 * Returns undefined if the snapshot file does not exist or is invalid.
 */
export function loadSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
  const snapshotPath = resolve(getSessionDir(sessionId), SESSION_STATE_FILENAME);
  if (!existsSync(snapshotPath)) return undefined;
  try {
    return JSON.parse(readFileSync(snapshotPath, 'utf-8')) as SessionSnapshot;
  } catch {
    return undefined;
  }
}

/**
 * Classifies the PTY session exit reason from the container exit code.
 */
function classifyExitStatus(exitCode: number | null): SessionSnapshot['status'] {
  if (exitCode === null) return 'crashed';
  if (exitCode === 0) return 'completed';
  // Exit code 2 is commonly used by agents for auth failures
  if (exitCode === 2) return 'auth-failure';
  return 'crashed';
}

/** The resume verdict for an ended PTY session, with the reason when it is refused. */
export interface SnapshotResumability {
  readonly resumable: boolean;
  /** Why resume is refused; `undefined` when `resumable` is true. */
  readonly reason: string | undefined;
}

/**
 * Single decision point for whether an ended PTY session may be resumed.
 *
 * A session that ran with an admitted secure nested Docker-workload bundle is
 * never resumable: the nested daemon, its state root, and its lease are torn
 * down with the bundle, so a resumed conversation would reference daemon state
 * that no longer exists. Forcing `resumable: false` here is what keeps PTY mode
 * in sync with the batch path, which rejects a resume whose session metadata
 * records a Docker workload (`applyResumeMetadata` in `src/session/index.ts`).
 *
 * Otherwise a session is resumable only when the state directory holds a real
 * transcript of the adapter's layout (`hasStoredTranscript`). The directory
 * is never empty (seeds such as `projects/`, `sessions/` and `logs/`, settings
 * and CLAUDE.md), so its mere contents say nothing about a conversation.
 */
export function resolveSnapshotResumability(input: {
  readonly conversationStateDir: string | undefined;
  readonly transcriptLayout: ConversationTranscriptLayout | undefined;
  readonly dockerWorkloadAdmitted: boolean;
}): SnapshotResumability {
  if (input.dockerWorkloadAdmitted) {
    return { resumable: false, reason: 'nested Docker-workload daemon state is ephemeral' };
  }
  if (input.conversationStateDir === undefined || input.transcriptLayout === undefined) {
    return { resumable: false, reason: 'no conversation state was recorded' };
  }
  if (!hasStoredTranscript(input.conversationStateDir, input.transcriptLayout)) {
    return { resumable: false, reason: 'no conversation transcript was recorded' };
  }
  return { resumable: true, reason: undefined };
}

/**
 * Writes a session state snapshot to the session directory.
 */
function writeSessionSnapshot(sessionDir: string, snapshot: SessionSnapshot): void {
  atomicWriteJsonSync(resolve(sessionDir, SESSION_STATE_FILENAME), snapshot);
}

/**
 * Runs a PTY session: starts proxies, launches container with PTY-enabled
 * Claude Code, attaches the terminal, and blocks until the session ends.
 */
export async function runPtySession(options: PtySessionOptions): Promise<void> {
  // Interrupts are handled before anything is allocated and for every network
  // allocation attempt: Node's default SIGINT/SIGTERM/SIGHUP action would end
  // the process without the teardown in runPtySessionAttempt's finally,
  // leaking the container, sidecar, network and owner lease. The first signal
  // aborts setup (or ends the attached session); a second SIGINT or SIGTERM
  // forces exit. A closed terminal or multiplexer PTY delivers SIGHUP twice
  // and then fails every write with EIO, so a repeated SIGHUP is ignored and
  // stdio errors are swallowed while the teardown runs.
  // Once the terminal is attached in raw mode, Ctrl-C is forwarded to the
  // agent as a byte and raises no SIGINT here.
  const shutdownController = new AbortController();
  const uninstallShutdownSignals = installShutdownSignals(shutdownController);
  const { signal } = shutdownController;
  let resumeClaim: ResumeSessionClaim | undefined;
  // A fresh session claims the directory its attempt created (a retried
  // network allocation starts the session again under a new ID); like a
  // resume's claim, each is held until the session has ended.
  const freshSessionClaims: ProcessLockHandle[] = [];
  let retryDocker: { readonly docker: ContainerRuntime; readonly runtimeKind: ContainerRuntimeKind } | undefined;
  try {
    resumeClaim = options.resumeSessionId
      ? acquireResumeSessionClaim(options.resumeSessionId, options.config.protectedPaths)
      : undefined;
    const resumeSnapshot = resumeClaim?.snapshot;
    await withInternalNetworkAllocationRetry(
      {
        maxAttempts: 4,
        description: 'PTY internal Docker network',
        reconcile: async () => {
          if (retryDocker && !signal.aborted) {
            await reconcileIronCurtainDockerResourcesBestEffort(retryDocker.docker, 'PTY internal network retry', {
              runtimeKind: retryDocker.runtimeKind,
            });
          }
        },
      },
      (excludedSubnets, attempt) => {
        throwIfPtyInterrupted(signal);
        return runPtySessionAttempt(
          options,
          resumeSnapshot,
          excludedSubnets,
          attempt,
          signal,
          (docker, runtimeKind) => {
            retryDocker = { docker, runtimeKind };
          },
          (claim) => freshSessionClaims.push(claim),
        );
      },
    );
  } finally {
    for (const claim of freshSessionClaims) releaseResumeSessionLock(claim);
    releaseResumeSessionLock(resumeClaim?.lock);
    uninstallShutdownSignals();
  }
}

/**
 * Raised when a shutdown signal interrupts PTY setup. Callers match the
 * `PTY_INTERRUPTED` code (not `instanceof`) and exit with the signal's status.
 */
export class PtySessionInterruptedError extends Error {
  readonly code = 'PTY_INTERRUPTED';

  constructor(readonly signal: ShutdownSignal | undefined) {
    super(`PTY session interrupted${signal ? ` by ${signal}` : ''}`);
    this.name = 'PtySessionInterruptedError';
  }
}

function throwIfPtyInterrupted(signal: AbortSignal): void {
  if (signal.aborted) throw new PtySessionInterruptedError(shutdownSignalOf(signal));
}

interface ResumeSessionClaim {
  readonly lock: ProcessLockHandle;
  readonly snapshot: SessionSnapshot;
}

function acquireResumeSessionClaim(sessionId: string, protectedPaths: string[]): ResumeSessionClaim {
  const sessionDir = getSessionDir(sessionId);
  if (!existsSync(sessionDir)) {
    throw new Error(`Cannot resume session "${sessionId}": session directory not found`);
  }
  // The claim every standalone session holds on its directory, builtin and
  // batch container sessions included (src/session/session-lock.ts): a
  // session still running anywhere refuses the resume.
  const lock = claimSessionDirectory(sessionDir, sessionId, 'resume');

  try {
    return { lock, snapshot: validateResumeSession(sessionId, protectedPaths) };
  } catch (error) {
    releaseResumeSessionLock(lock);
    throw error;
  }
}

/** Holds a session-global lock for the full resumed PTY lifecycle. */
export function acquireResumeSessionLock(sessionId: string, protectedPaths: string[] = []): ProcessLockHandle {
  return acquireResumeSessionClaim(sessionId, protectedPaths).lock;
}

/**
 * Releases a claim on a session directory (a resume's, or a fresh session's)
 * without allowing cleanup damage to replace the session's real outcome. The
 * process-lock implementation deliberately throws when the published inode
 * vanished or was replaced; at PTY teardown we log that integrity signal but
 * never erase the primary Docker error or turn an otherwise completed
 * interactive session into a fatal CLI failure.
 */
export function releaseResumeSessionLock(lock: ProcessLockHandle | undefined): void {
  if (!lock) return;
  try {
    lock.release();
  } catch (error) {
    logger.error(
      `[PTY] Failed to release session lock ${lock.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runPtySessionAttempt(
  options: PtySessionOptions,
  resumeSnapshot: SessionSnapshot | undefined,
  excludedSubnets: ReadonlySet<string>,
  attempt: number,
  signal: AbortSignal,
  onDockerReady: (docker: ContainerRuntime, runtimeKind: ContainerRuntimeKind) => void,
  onSessionClaimed: (claim: ProcessLockHandle) => void,
): Promise<void> {
  const {
    prepareDockerInfrastructure,
    writeAptProxyConfigViaExec,
    checkDockerContainerWritableStorage,
    checkHostOnlyConnectivity,
    checkInternalNetworkConnectivity,
    attachDockerDesktopAgentEgressNetwork,
  } = await import('./docker-infrastructure.js');

  // A resumed session uses the snapshot validated under its process lock.
  // Reuse it across network-allocation retries even if a failed attempt writes
  // updated session state during teardown.
  const isResume = !!resumeSnapshot;

  // Use the original session ID when resuming, otherwise create a new one
  const sessionId = createSessionId();
  const effectiveSessionId = options.resumeSessionId ?? sessionId;
  const sessionDir = getSessionDir(effectiveSessionId);

  // On resume, restore the profile the same way workspacePath is restored:
  // the persisted snapshot name wins over any passed flag (which is
  // warn-ignored upstream). Fresh sessions use the passed flag.
  const providerProfileName = isResume ? resumeSnapshot.providerProfileName : options.providerProfileName;
  // What a resume restores from the session metadata. A metadata file that
  // is there but cannot be used refuses the resume rather than dropping the
  // persona and task scope it records (loadResumeSessionMetadata); a
  // session created before metadata was recorded has none.
  const resumeMetadata = isResume ? loadResumeSessionMetadata(effectiveSessionId) : undefined;
  // New snapshots carry persona directly. Session metadata is the backwards-
  // compatible source for resumable PTYs created before that field existed.
  const persona = isResume ? (resumeSnapshot.persona ?? resumeMetadata?.persona) : options.persona;
  // A resumed task-scoped session keeps the task scope it was created with
  // (written to its metadata by buildSessionConfig at creation).
  const taskPolicyDir = isResume ? resumeMetadata?.taskPolicyDir : options.taskPolicyDir;

  // Delegate to shared buildSessionConfig() so PTY sessions get the same
  // config patching as standard Docker sessions (persona, memory MCP server
  // injection, server allowlist, policy dir, etc.).
  const dirConfig = buildSessionConfig(options.config, effectiveSessionId, sessionId, {
    resumeSessionId: options.resumeSessionId,
    // On resume this is the canonical path validateResumeSession() approved
    // under the resume lock, not the raw string stored in the snapshot.
    workspacePath: isResume ? resumeSnapshot.workspacePath : options.workspacePath,
    persona,
    ...(options.allowStalePolicy === true ? { allowStalePolicy: true } : {}),
    ...(taskPolicyDir !== undefined ? { taskPolicyDir } : {}),
    ...(options.agentModelOverride !== undefined ? { agentModelOverride: options.agentModelOverride } : {}),
    providerProfileName,
    mode: options.mode,
  });

  // A fresh session claims the directory buildSessionConfig() just created,
  // as builtin and batch container sessions do (src/session/session-lock.ts),
  // so a --resume of it while it runs is refused and prune sees it as live.
  // A resume runs under the claim runPtySession() took. runPtySession()
  // releases either once the session has ended (after this attempt's
  // teardown and snapshot write).
  if (!isResume) {
    try {
      onSessionClaimed(claimSessionDirectory(sessionDir, effectiveSessionId, 'start'));
    } catch (error) {
      logger.release(dirConfig.logClaim);
      throw error;
    }
  }

  // Resolve the active-profile name to persist in the snapshot for resume.
  // Docker mode always: PTY sessions are Docker-only. Mirrors the batch
  // path's metadata write (§9.7 F3).
  const resolvedProviderProfileName = providerProfileName ?? options.config.userConfig.modelProviders.default;

  // Layer PTY-specific fields on top of the shared config.
  const sessionConfig = { ...dirConfig.config, isPtySession: true };
  const { sandboxDir, escalationDir, systemPromptAugmentation } = dirConfig;

  logger.info(`PTY session ${effectiveSessionId} ${isResume ? 'resuming' : 'starting'}`);

  const initSpinner = ora({
    text: `Initializing PTY session (${options.mode.agent})...`,
    stream: process.stderr,
    discardStdin: false,
  }).start();

  let containerId: string | null = null;
  let sidecarContainerId: string | null = null;
  let privilegedFileScanner: HostMountPrivilegeScanner | undefined;
  let escalationFileWatcher: EscalationWatcher | null = null;
  let registrationPath: string | null = null;
  let shutdownSpinner: ReturnType<typeof ora> | null = null;

  // Terminal safety: ensure raw mode is restored on any exit
  const restoreTerminal = (): void => {
    try {
      if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    } catch {
      /* best effort */
    }
  };

  process.on('exit', restoreTerminal);

  // `signal` is aborted by the SIGINT/SIGTERM/SIGHUP handlers runPtySession
  // installed before this attempt allocated anything (SIGHUP because
  // node-pty's kill() sends it). During setup each step below checks it and
  // the waits end early, so the finally block tears down whatever exists;
  // while attached it makes attachPty()/execPty() resolve, which falls
  // through to the same finally block.
  const checkInterrupted = (): void => throwIfPtyInterrupted(signal);

  // Infra variables set inside try, used in finally for cleanup and snapshot
  let proxy: Awaited<ReturnType<typeof prepareDockerInfrastructure>>['proxy'] | null = null;
  let mitmProxy: Awaited<ReturnType<typeof prepareDockerInfrastructure>>['mitmProxy'] | null = null;
  let docker: Awaited<ReturnType<typeof prepareDockerInfrastructure>>['docker'] | null = null;
  // Secure nested Docker-workload lease handle, captured in outer scope so the
  // finally block can tear it down first (§8.3). Undefined for ordinary PTY
  // sessions — the capability is gated by the resolved-variant predicate.
  let dockerWorkload: DockerWorkloadBundleHandle | undefined;
  let dockerWorkloadEgress: Awaited<ReturnType<typeof prepareDockerInfrastructure>>['dockerWorkloadEgress'] | undefined;
  let useTcp: boolean;
  let networkName: string | null = null;
  let retryableNetworkSubnet: string | undefined;
  // Flushes the trajectory-capture session (clean, non-poisoned session-end)
  // before infra teardown. Assigned inside the try once the bundle exists;
  // invoked in finally. Undefined when capture is disabled. PTY mode tears
  // down proxies manually (it does not call destroyDockerInfrastructure), so
  // this explicit flush is required for a clean capture — the destroy-time
  // safety net does not run here.
  let flushCapture: (() => Promise<void>) | undefined;
  let metricsLease: MetricsInvocationLease | undefined;
  let metricsRuntime: LlmMetricsRuntimeLease | undefined;
  let invocationProxyUrl: string | undefined;
  let ptyExitCode: number | null = null;
  let adapterIdForSnapshot: string | null = null;
  let adapterDisplayNameForSnapshot: string | null = null;
  let conversationStateDirForSnapshot: string | undefined;
  let transcriptLayoutForSnapshot: ConversationTranscriptLayout | undefined;
  let userExited = false;
  let primaryError: Error | undefined;
  let flushError: Error | undefined;
  let resourceCleanupError: Error | undefined;

  const claudeMdContent = buildDockerClaudeMd({
    personaName: persona,
    memoryEnabled: dirConfig.memoryEnabled,
  });

  try {
    // Single-session CLI invariant: bundleId === sessionId (§2.1 of the
    // workflow-session-identity design). The PTY mode mints one UUID via
    // createSessionId() and reuses the same string as the BundleId here;
    // this keeps the deterministic `ironcurtain-pty-<id[0:12]>` container
    // name that prior-crash recovery depends on.
    const bundleId = effectiveSessionId as BundleId;
    // Trajectory-capture: pass the RAW override; the infra layer is the
    // single place that resolves it against userConfig. The writer is
    // constructed only when enabled — zero cost when disabled.
    const infra = await prepareDockerInfrastructure(
      sessionConfig,
      options.mode,
      sessionDir,
      sandboxDir,
      escalationDir,
      bundleId,
      undefined,
      undefined,
      dirConfig.resolvedSkills,
      {
        override: options.captureTracesOverride,
        capturesDir: getSessionCapturesDir(effectiveSessionId),
        recordedAgentName: options.mode.agent,
      },
      undefined, // scriptsDir
      {
        providerProfileName,
        preparedImageResolution: options.preparedImageResolution,
        proxyAgentKind: 'pty',
      },
    );
    // Publish every cleanup-owned resource before any subsequent callback can
    // throw. In particular, capture hooks are extension points; a failure in
    // either must still revoke the workload lease and stop both proxies.
    ({ docker, proxy, mitmProxy, useTcp } = infra);
    dockerWorkload = infra.dockerWorkload;
    dockerWorkloadEgress = infra.dockerWorkloadEgress;

    // Match standalone batch metadata: persist the admitted lease tuple as
    // soon as preparation returns, before any PTY-specific callback can fail
    // (the interrupt checkpoint below included).
    const resolvedDockerWorkload = sessionConfig.userConfig.dockerWorkload;
    if (dockerWorkload && !isResume && resolvedDockerWorkload?.enabled === true) {
      updateSessionMetadata(effectiveSessionId, {
        dockerWorkload: dockerWorkloadSessionMetadata(dockerWorkload, resolvedDockerWorkload, infra.runtimeKind),
      });
    }
    checkInterrupted();

    // PTY sessions are standalone: pin the MITM proxy's token-stream
    // routing ID to this session's ID for the session's lifetime.
    const captureSessionId = effectiveSessionId as import('../session/types.js').SessionId;
    infra.setTokenSessionId(captureSessionId);
    metricsLease = infra.beginMetricsInvocation?.({
      sessionId: captureSessionId,
      bundleId: infra.bundleId,
      personaId: persona,
      agentId: infra.adapter.id,
    });
    invocationProxyUrl = metricsLease?.proxyUrl;
    metricsRuntime = infra.metricsRuntime;

    // The bundle's budget gate gives a PTY session one session-long
    // allowance: once the session's cumulative tokens or list-priced cost
    // reach `resourceBudget.maxTotalTokens` / `maxEstimatedCostUsd`, the MITM
    // proxy refuses every further completion request with a non-retryable
    // error the agent shows in the terminal (budget-gate.ts). The session is
    // left open so the user can still read and save work.
    infra.budgetGate?.onExhausted((exhaustion) => {
      logger.warn(
        `PTY session ${effectiveSessionId}: ${exhaustion.message}; the proxy now refuses every completion ` +
          'request in this session',
      );
    });

    // Begin trajectory capture (no-op when disabled). Standalone PTY runs
    // exactly one session through the bundle. The matching flush is in the
    // finally block, awaited BEFORE proxy teardown (§11 ordering) so the
    // session-end manifest entry is durable. PTY mode does not call
    // destroyDockerInfrastructure, so we both end the session (clean,
    // non-poisoned end) and close the writer here.
    infra.beginCaptureSession({ sessionId: captureSessionId });
    if (infra.captureWriter) {
      flushCapture = async () => {
        await infra
          .endCaptureSession(captureSessionId)
          .catch((err: unknown) =>
            logger.warn(`PTY capture endSession failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        await infra.captureWriter
          ?.close()
          .catch((err: unknown) =>
            logger.warn(`PTY capture writer close failed: ${err instanceof Error ? err.message : String(err)}`),
          );
      };
    }

    onDockerReady(docker, infra.runtimeKind);
    const {
      adapter,
      fakeKeys,
      orientationDir,
      socketsDir,
      systemPrompt: baseSystemPrompt,
      image,
      mitmAddr,
      conversationStateDir,
      conversationStateConfig,
      skillsMount,
    } = infra;

    // Seed CLAUDE.md into the conversation state dir on every start (even on
    // resume, since persona/memory config may change between sessions), or
    // remove a stale one when memory is off or the adapter is not Claude
    // Code. The dir is the agent's read-write state mount (~/.claude/ for
    // Claude Code), so the helper (shared with the batch factory) replaces
    // the entry and never writes through a link or FIFO the agent planted
    // there in an earlier run.
    if (conversationStateDir) {
      syncConversationStateClaudeMd({ conversationStateDir, adapterId: adapter.id, content: claudeMdContent });
    }

    // Compose final system prompt with persona/memory augmentation
    const systemPrompt = systemPromptAugmentation
      ? `${baseSystemPrompt}\n\n${systemPromptAugmentation}`
      : baseSystemPrompt;

    adapterIdForSnapshot = adapter.id;
    adapterDisplayNameForSnapshot = adapter.displayName;
    conversationStateDirForSnapshot = conversationStateDir;
    transcriptLayoutForSnapshot = conversationStateConfig?.transcriptLayout;

    // TCP sidecars expose no terminal listener. Native exec also avoids
    // Apple's unreliable host-published socket relay.
    const socketPtyCommand = adapter.buildPtyCommand?.bind(adapter);
    const requireNativePty = infra.runtimeKind === 'docker' && infra.topology === 'tcp-sidecar';
    const nativePtyExec =
      infra.runtimeKind === 'apple-container' || requireNativePty ? docker.execPty?.bind(docker) : undefined;
    const nativePtyCommand = nativePtyExec ? adapter.buildPtyExecCommand?.() : undefined;
    if (requireNativePty && (nativePtyExec === undefined || nativePtyCommand === undefined)) {
      throw new Error(`Docker TCP-sidecar PTY requires native interactive exec support for ${adapter.id}`);
    }
    if (!socketPtyCommand && nativePtyCommand === undefined) {
      throw new Error(`Agent ${adapter.id} does not support PTY mode.`);
    }

    // Write system prompt to file for shell-injection-safe PTY command
    writeFileSync(resolve(orientationDir, 'system-prompt.txt'), systemPrompt);

    // Write the effective system prompt to the session directory for debugging
    writeFileSync(resolve(sessionDir, 'system-prompt.txt'), systemPrompt);

    // Determine PTY connection target. Apple Container uses runtime-native
    // interactive exec; the retained socket branch is a compatibility path
    // for injected runtimes that do not implement execPty.
    const ptySockPath = nativePtyCommand
      ? undefined
      : useTcp
        ? undefined
        : infra.runtimeKind === 'apple-container'
          ? APPLE_PTY_GUEST_SOCK
          : `/run/ironcurtain/${PTY_SOCK_NAME}`;
    const ptyPort = nativePtyCommand ? undefined : useTcp ? DEFAULT_PTY_PORT : undefined;

    // Native interactive exec needs a stable outer process to attach to.
    // Linux UDS sessions retain their socat listener.
    let ptyCommand: readonly string[];
    if (nativePtyCommand !== undefined) {
      ptyCommand = ['sleep', 'infinity'];
    } else if (socketPtyCommand !== undefined) {
      ptyCommand = socketPtyCommand(systemPrompt, ptySockPath, ptyPort);
    } else {
      throw new Error(`Agent ${adapter.id} does not support PTY mode.`);
    }
    const nestedDockerWiring = resolveNestedDockerAgentWiring(infra);
    const nestedDaemon = nestedDockerWiring.appleNestedDaemon;
    const dockerWorkloadBootstrap = infra.dockerWorkloadBootstrap;
    const outerAgentImage = resolveNestedDockerOuterAgentImage(infra, image);

    // Build container configuration
    const shortId = getBundleShortId(bundleId);
    const { quote } = await import('shell-quote');
    const baseInternalNetworkName = getInternalNetworkName(shortId);
    const internalNetworkName = attempt === 1 ? baseInternalNetworkName : `${baseInternalNetworkName}-a${attempt}`;
    const { labels: resourceLabels } = buildDockerOwnershipLabels({
      runtimeKind: infra.runtimeKind,
      bundleId,
      dockerWorkload,
    });
    let env: Record<string, string>;
    let network: string | null;
    // Kept in sync with the batch path (createSessionContainers): a
    // read-only workspace config mounts /workspace read-only here too.
    const workspaceReadOnly = sessionConfig.readOnlyWorkspace !== undefined;
    let mounts: { source: string; target: string; readonly: boolean }[];
    let extraHosts: string[] | undefined;
    let publishSockets: { hostPath: string; containerPath: string }[] | undefined;
    // apple-container only (both `uds` and the retained `tcp-hostonly`):
    // apt proxy config written into the container via exec after start
    // instead of bind-mounted — see writeAptProxyConfigViaExec.
    let execAptProxyUrl: string | undefined;
    const mainContainerName = `ironcurtain-pty-${shortId}`;

    // Crash recovery for both runtimes: Apple VMs carry the same owner labels.
    await reconcileIronCurtainDockerResourcesBestEffort(docker, 'PTY session startup', {
      runtimeKind: infra.runtimeKind,
    });

    // Remove stale main container from a crashed previous session (same session
    // ID means same deterministic name, which would conflict on docker create).
    // Done before the TCP/UDS branch since the main container name is
    // deterministic in both modes.
    await docker.removeStaleContainer(mainContainerName);
    checkInterrupted();

    // A crashed socat process leaves its UDS inode behind. Resumed sessions
    // reuse the bundle ID (and therefore this pathname), and socat refuses to
    // bind while the old entry exists. Clear it only after the old container
    // has been removed and before the replacement container can start.
    if (ptySockPath !== undefined) {
      removeStalePtySocket(resolve(socketsDir, PTY_SOCK_NAME));
    }

    if (infra.topology === 'tcp-hostonly') {
      // Apple container host-only mode: the agent VM reaches the host
      // proxies directly at the vmnet gateway, and the host connects
      // straight to the container's IP for the PTY — no sidecar, no
      // port publishing. Mirrors the batch branch in
      // docker-infrastructure.ts::createSessionContainers.
      if (infra.hostOnlyNetwork === undefined || proxy.port === undefined || mitmAddr.port === undefined) {
        throw new Error('tcp-hostonly bundle is missing its host-only network or proxy ports');
      }
      const proxyUrl = `http://${infra.hostOnlyNetwork.gateway}:${mitmAddr.port}`;
      env = {
        ...adapter.buildEnv(sessionConfig, fakeKeys),
        ...buildRuntimeTrustEnv(),
        ...buildPackageClientEnv(),
        HTTPS_PROXY: invocationProxyUrl ?? proxyUrl,
        HTTP_PROXY: invocationProxyUrl ?? proxyUrl,
      };
      execAptProxyUrl = proxyUrl;

      network = infra.hostOnlyNetwork.name;
      // Report the prepare-phase network as networkName so the finally
      // block's cleanupContainers removes it with the container.
      networkName = infra.hostOnlyNetwork.name;

      mounts = [
        buildContainerWorkspaceMount(sandboxDir, { readonly: workspaceReadOnly }),
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
      ];
    } else if (useTcp && proxy.port !== undefined && mitmAddr.port !== undefined) {
      // macOS TCP mode
      const mcpPort = proxy.port;
      const mitmPort = mitmAddr.port;

      const proxyUrl = tcpSidecarProxyUrl(infra, mitmPort);
      env = {
        ...adapter.buildEnv(sessionConfig, fakeKeys),
        ...buildRuntimeTrustEnv(),
        ...buildPackageClientEnv(),
        HTTPS_PROXY: invocationProxyUrl ?? proxyUrl,
        HTTP_PROXY: invocationProxyUrl ?? proxyUrl,
      };

      // Write apt proxy config so sudo apt-get routes through the MITM proxy
      const aptProxyPath = resolve(orientationDir, 'apt-proxy.conf');
      stageAptProxyConfig(aptProxyPath, proxyUrl);

      const allocatedNetwork = await createDockerSessionTransportNetwork({
        runtime: docker,
        dockerWorkload,
        bundleId,
        requestedName: internalNetworkName,
        allocation: { excludedSubnets },
      });
      retryableNetworkSubnet = allocatedNetwork.subnet;
      network = internalNetworkName;
      networkName = internalNetworkName;
      logger.info(`Allocated internal Docker network ${internalNetworkName} at ${allocatedNetwork.subnet}`);

      // Built locally, build-hash-labelled, addressed by immutable ID
      // (transport-sidecar-image.ts): the sidecar relays every tool call,
      // the agent's CONNECT streams and the user's terminal.
      const sidecarImageId = await ensureTransportSidecarImage(docker, (message) => {
        logger.info(message);
      });

      // Only MCP/MITM need TCP forwards. The user's terminal uses filtered
      // runtime-native exec, so there is no published PTY listener.
      const sidecarName = `ironcurtain-sidecar-${shortId}`;
      const sidecarIp = tcpTransportSidecarAddress(allocatedNetwork.subnet);

      // Remove stale sidecar from a crashed previous session (TCP mode only).
      await docker.removeStaleContainer(sidecarName);

      sidecarContainerId = await createDockerSessionTransportProxy({
        dockerWorkload,
        requestedName: sidecarName,
        baseLabels: resourceLabels,
        create: (requestedName, labels) =>
          infra.docker.create({
            image: sidecarImageId,
            name: requestedName,
            network: internalNetworkName,
            ipv4Address: sidecarIp,
            mounts: [tcpTransportHostCaMount(orientationDir)],
            env: {},
            entrypoint: '/bin/sh',
            // Read-only, unprivileged, no new privileges, on the transport
            // share of the Docker Desktop resource partition.
            ...hardenTransportSidecarCreate(buildDockerDesktopTransportCreateLimits(infra.dockerDesktopResources)),
            // PTY sessions are standalone (no workflow/scope), so only the
            // bundle label is emitted. See docs/designs/workflow-session-identity.md §7.
            bundleLabel: bundleId,
            labels,
            command: [
              '-c',
              quote([
                'socat',
                tcpTransportListenEndpoint(sidecarIp, mcpPort, allocatedNetwork.subnet),
                tcpTransportUpstreamEndpoint(mcpPort),
              ]) +
                ' & ' +
                quote([
                  'socat',
                  tcpTransportListenEndpoint(sidecarIp, mitmPort, allocatedNetwork.subnet),
                  tcpTransportUpstreamEndpoint(mitmPort),
                ]) +
                ' & wait',
            ],
          }),
      });
      await startTcpTransportSidecar(
        docker,
        sidecarContainerId,
        internalNetworkName,
        sidecarIp,
        allocatedNetwork.subnet,
      );
      extraHosts = [`host.docker.internal:${sidecarIp}`];
      checkInterrupted();

      mounts = [
        buildContainerWorkspaceMount(sandboxDir, { readonly: workspaceReadOnly }),
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
        { source: aptProxyPath, target: '/etc/apt/apt.conf.d/90-ironcurtain-proxy', readonly: true },
      ];
    } else {
      // UDS mode (Linux Docker AND apple-container >= 1.1.0)
      const udsProxyUrl = 'http://127.0.0.1:18080';
      env = {
        ...adapter.buildEnv(sessionConfig, fakeKeys),
        ...buildRuntimeTrustEnv(),
        ...buildPackageClientEnv(),
        HTTPS_PROXY: invocationProxyUrl ?? udsProxyUrl,
        HTTP_PROXY: invocationProxyUrl ?? udsProxyUrl,
      };
      network = null;

      mounts = [
        buildContainerWorkspaceMount(sandboxDir, { readonly: workspaceReadOnly }),
        ...buildUdsSocketMounts(infra.runtimeKind, socketsDir),
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
      ];

      if (infra.runtimeKind === 'apple-container') {
        // apple-container: 1.1.0's virtiofs silently drops a directory
        // share when a file inside that directory is ALSO -v-mounted, so
        // the apt config (which lives under orientationDir) is written
        // via exec after start instead of bind-mounted. Bridge the
        // compatibility PTY path publishes the guest listener back to the
        // host only when runtime-native exec is unavailable.
        execAptProxyUrl = udsProxyUrl;
        if (nativePtyCommand === undefined && ptySockPath !== undefined) {
          publishSockets = [{ hostPath: resolve(socketsDir, PTY_SOCK_NAME), containerPath: ptySockPath }];
        }
      } else {
        // Linux Docker: single-file bind mount for the apt proxy config.
        const aptProxyPathUds = resolve(orientationDir, 'apt-proxy.conf');
        stageAptProxyConfig(aptProxyPathUds, udsProxyUrl);
        mounts.push({ source: aptProxyPathUds, target: '/etc/apt/apt.conf.d/90-ironcurtain-proxy', readonly: true });
      }
    }

    mounts.push(...buildDockerWorkloadEgressMounts(infra));
    mounts.push(...buildDockerBuildShimMounts(infra));

    if (nestedDaemon !== undefined && dockerWorkloadBootstrap !== undefined) {
      mounts.push(appleVmDockerWorkloadArtifactMount(dockerWorkloadBootstrap));
    }

    // Mount conversation state directory if the adapter supports resume
    if (conversationStateDir && conversationStateConfig) {
      mounts.push({
        source: conversationStateDir,
        target: conversationStateConfig.containerMountPath,
        readonly: false,
      });
    }

    // Read-only so the agent cannot mutate skills mid-session — keeps
    // the cached-stager assumption sound and prevents per-state filter
    // contamination.
    if (skillsMount) {
      mounts.push({ source: skillsMount.hostDir, target: skillsMount.target, readonly: true });
    }

    // Same-VM nested daemon (§4.4 variant 1) — mirrors the batch branch in
    // docker-infrastructure.ts::createSessionContainersAttempt. Present only
    // for an admitted Docker-workload bundle; §8.2 step 6 gives the agent the
    // VM-local `DOCKER_HOST`, and the bootstrap runs after `docker.start`.
    Object.assign(env, nestedDockerWiring.env);

    // Pass initial terminal size so start-claude.sh can set PTY dimensions
    // before Claude starts, eliminating the resize race condition.
    const { columns, rows } = process.stdout;
    if (columns) env.IRONCURTAIN_INITIAL_COLS = String(columns);
    if (rows) env.IRONCURTAIN_INITIAL_ROWS = String(rows);

    if (skillsMount && adapter.skills?.ptyEnv) {
      Object.assign(env, adapter.skills.ptyEnv);
    }

    // Tell the start script which conversation to start or continue: the
    // Goose session name, and on resume the validated resume flags and the
    // Codex thread of the most recently active rollout. The batch path keeps
    // the same conversations through `findStoredConversation`
    // (docker-agent-session.ts); both decide from real transcripts.
    if (conversationStateDir && conversationStateConfig) {
      Object.assign(
        env,
        buildPtyConversationEnv({
          stateDir: conversationStateDir,
          stateConfig: conversationStateConfig,
          sessionId: effectiveSessionId,
          resume: isResume,
        }),
      );
    }

    // Build the PTY agent container create args for a given name + resolved
    // labels. `labels` is the base resource labels in the ordinary case and the
    // base merged with the generation ownership label when the create is
    // ledgered — the merge lives in createLedgeredAgentContainer.
    const agentStartup = prepareDockerAgentStartup(
      ptyCommand,
      planBundleAgentPrivileges(infra, sessionConfig.userConfig).startupProbeUser,
    );
    const createPtyContainer = (name: string, labels: Readonly<Record<string, string>> | undefined): Promise<string> =>
      infra.docker.create(
        buildAgentContainerConfig(infra, sessionConfig.userConfig, {
          image: outerAgentImage,
          name,
          network: network ?? 'none',
          mounts,
          env,
          command: [...agentStartup.command],
          // PTY sessions are standalone (no workflow/scope), so only the
          // bundle label is emitted. See docs/designs/workflow-session-identity.md §7.
          bundleLabel: bundleId,
          labels,
          extraHosts,
          publishSockets,
          // Apple Container allocates the agent TTY on `container exec -it`;
          // the outer `sleep infinity` process does not need a second TTY.
          tty: nativePtyCommand === undefined,
        }),
      );

    // §8.2 step 1: ledger the agent container before create when a
    // Docker-workload bundle is admitted; ordinary sessions create directly.
    // Shared with createSessionContainers in the batch path.
    containerId = await createLedgeredAgentContainer({
      dockerWorkload,
      runtimeKind: infra.runtimeKind,
      runtime: docker,
      expectedImageId: infra.imageResolution?.immutableImageId,
      requestedName: mainContainerName,
      baseLabels: resourceLabels,
      mounts: [
        ...mounts,
        ...nestedDockerWiring.namedVolumeMounts.map((mount) => ({
          source: mount.name,
          target: mount.target,
          readonly: mount.readonly === true,
        })),
      ],
      create: createPtyContainer,
    });
    // Host-root daemons only: the agent's read-write host mounts are swept
    // for setuid/setgid and root-owned entries once the container is gone.
    privilegedFileScanner = createBundlePrivilegedFileScanner(infra, mounts);
    await attachDockerDesktopAgentEgressNetwork(infra, containerId);
    checkInterrupted();
    await docker.start(containerId);
    logger.info(`PTY container started: ${containerId.substring(0, 12)}`);
    await agentStartup.waitUntilReady(docker, containerId, { signal });
    checkInterrupted();

    // Docker Desktop's daemon sidecar is already adjudicated. Initialize and
    // verify package-build state in the blocked agent, then activate the bundle.
    // Apple activation stays after its in-agent daemon bootstrap below.
    if (infra.runtimeKind === 'docker') {
      await activateNestedDockerWorkload({
        runtime: docker,
        runtimeKind: infra.runtimeKind,
        containerId,
        dockerWorkload,
        dockerDesktopAgentAccess: infra.dockerDesktopAgentAccess,
        bootstrap: dockerWorkloadBootstrap,
        dockerWorkloadEgress,
        dockerBuildShim: infra.dockerBuildShim,
      });
    }

    if (infra.runtimeKind === 'docker') {
      await checkDockerContainerWritableStorage(docker, containerId);
    }

    // apple-container (uds and the retained tcp-hostonly): write the apt
    // proxy config inside the container via exec instead of a bind mount.
    if (execAptProxyUrl !== undefined) {
      await writeAptProxyConfigViaExec(docker, containerId, execAptProxyUrl);
    }
    // tcp-hostonly only: fail-closed connectivity gate (gateway proxies
    // reachable, internet egress blocked) before attaching.
    if (infra.topology === 'tcp-hostonly' && infra.hostOnlyNetwork !== undefined && proxy.port !== undefined) {
      await checkHostOnlyConnectivity(docker, containerId, infra.hostOnlyNetwork.gateway, proxy.port);
    } else if (infra.topology === 'tcp-sidecar' && proxy.port !== undefined && mitmAddr.port !== undefined) {
      try {
        await checkInternalNetworkConnectivity(docker, containerId, proxy.port, mitmAddr.port, infra.tcpTransport);
      } catch (error) {
        if (error instanceof InternalNetworkConnectivityError && retryableNetworkSubnet !== undefined) {
          throw new InternalNetworkConnectivityError(error.message, retryableNetworkSubnet);
        }
        throw error;
      }
    }

    checkInterrupted();

    // Same-VM activation: socat may bind the PTY listener while the shared
    // bootstrap adjudicates dockerd, preflights the pinned client, provisions
    // the trusted selected inner image, records observations, and activates the
    // lease. The untrusted agent is not launched until the host attaches below,
    // so completing activation before attach preserves the release boundary
    // without delaying Apple Container's published-socket listener.
    if (infra.runtimeKind === 'apple-container') {
      await activateNestedDockerWorkload({
        runtime: docker,
        runtimeKind: infra.runtimeKind,
        containerId,
        dockerWorkload,
        dockerDesktopAgentAccess: infra.dockerDesktopAgentAccess,
        bootstrap: dockerWorkloadBootstrap,
        dockerWorkloadEgress,
        dockerBuildShim: infra.dockerBuildShim,
      });
    }

    checkInterrupted();

    // Write session registration for the escalation listener
    registrationPath = writeRegistration(effectiveSessionId, escalationDir, adapter.displayName);

    // Start escalation file watcher (emits BEL to alert user)
    escalationFileWatcher = createEscalationWatcher(escalationDir, {
      onEscalation: () => {
        process.stderr.write('\x07'); // BEL character
      },
      onEscalationExpired: () => {},
    });
    escalationFileWatcher.start();

    // Wait for PTY socket readiness.
    // On macOS TCP mode, skip the readiness probe — the main container's socat
    // does NOT use `fork`, so it only accepts one connection. A readiness probe
    // would consume that slot and cause the real attachPty connection to fail.
    // Instead, attachPty retries internally for TCP targets.
    let ptyTarget: PtyTarget | undefined;
    if (nativePtyCommand !== undefined) {
      // Runtime-native exec does not expose a host socket or TCP port.
      ptyTarget = undefined;
    } else if (infra.topology === 'tcp-hostonly') {
      // The host-only network routes host→container traffic natively:
      // connect straight to the container's IP at the fixed PTY port.
      // attachPty retries TCP targets, covering the window before the
      // container-side socat is listening.
      if (infra.hostOnlyNetwork === undefined) {
        throw new Error('PTY session misconfiguration: tcp-hostonly without a host-only network');
      }
      const containerIp = await docker.getContainerIp(containerId, infra.hostOnlyNetwork.name);
      ptyTarget = { host: containerIp, port: DEFAULT_PTY_PORT };
    } else if (useTcp) {
      throw new Error('TCP-sidecar PTY requires runtime-native interactive exec');
    } else {
      ptyTarget = resolve(socketsDir, PTY_SOCK_NAME);
    }

    if (!useTcp && ptyTarget !== undefined) {
      // When `uidRemap.user` is set (Linux non-1000 host, issue #232) the
      // entrypoint runs usermod/groupmod and a recursive chown before
      // exec'ing the agent, so socat — and therefore the UDS — appears
      // 25–30s later than the no-remap case. Stretch the readiness
      // budget so PTY sessions on non-1000 hosts don't flap.
      const readinessTimeoutMs = buildAgentUidRemap(infra.runtimeKind === 'apple-container' || useTcp).user
        ? PTY_READINESS_TIMEOUT_REMAP_MS
        : PTY_READINESS_TIMEOUT_MS;
      await waitForPtyReady(ptyTarget, readinessTimeoutMs, signal);
      logger.info('PTY readiness check passed');
    }
    checkInterrupted();

    initSpinner.succeed(chalk.dim(useTcp ? 'PTY relay initialized; connecting to agent' : 'PTY session ready'));
    process.stderr.write('\n');

    // Start-up notices, all already in the session log: host-model features
    // running differently, MCP servers the proxy's sandbox could not start,
    // and annotation drift its coordinator found while registering the
    // backend servers' tools. Printed here, after the spinner and before the
    // agent's terminal takes over, so they show in the mux pane and the web
    // UI terminal as well.
    const startupNotices: StartupNotice[] = [
      ...hostModelDiagnostics(dirConfig.hostModelNotices),
      ...unavailableServerDiagnostics(proxy.getUnavailableServers?.() ?? []),
      ...annotationDriftDiagnostics(proxy.getSchemaDrift?.() ?? []),
    ];
    for (const notice of startupNotices) {
      process.stderr.write(chalk.yellow(`${formatStartupNotice(notice)}\n`));
    }
    if (startupNotices.length > 0) process.stderr.write('\n');

    // Attach terminal via Node.js PTY proxy. Tests inject a stub via
    // `options.attach` to drive assertions against the live container.
    let exitCode: number;
    if (nativePtyCommand !== undefined && nativePtyExec !== undefined) {
      // The runtime interposes a host PTY and relays its output through the
      // same terminal filter as attachPty.
      exitCode = await nativePtyExec(containerId, nativePtyCommand, signal);
    } else {
      if (ptyTarget === undefined) throw new Error('PTY session misconfiguration: no attach target was assigned');
      exitCode = await (options.attach ?? attachPty)({
        target: ptyTarget,
        containerId,
        runtime: docker,
        signal,
      });
    }
    ptyExitCode = exitCode;
    userExited = exitCode === 0;
    logger.info(`PTY attach returned with exit code ${exitCode}`);

    // PTY disconnected -- restore terminal and show shutdown progress
    restoreTerminal();
    process.stderr.write('\n');

    shutdownSpinner = ora({
      text: 'Shutting down PTY session...',
      stream: process.stderr,
      discardStdin: false,
    }).start();

    if (exitCode !== 0) {
      process.stderr.write(chalk.yellow(`PTY session exited with code ${exitCode}\n`));
    }
  } catch (error) {
    if (signal.aborted) {
      // Whatever step observed the interrupt, report it as one.
      primaryError =
        error instanceof PtySessionInterruptedError ? error : new PtySessionInterruptedError(shutdownSignalOf(signal));
      logger.warn(`PTY setup interrupted: ${errorMessage(error)}`);
    } else {
      primaryError = normalizePtyError(error);
      logger.error(`PTY setup failed: ${primaryError.message}`);
    }
  } finally {
    // Stop spinner if still running (e.g. error during setup)
    if (initSpinner.isSpinning) {
      initSpinner.fail(chalk.red(signal.aborted ? 'PTY session interrupted' : 'PTY session failed'));
    }

    restoreTerminal();
    process.off('exit', restoreTerminal);

    // Stop escalation watcher
    escalationFileWatcher?.stop();

    // Delete registration file
    if (registrationPath) {
      try {
        unlinkSync(registrationPath);
      } catch {
        /* best effort */
      }
    }

    // Revoke the session-long attribution lease only after the agent exits,
    // then drain already-attributed exchanges before proxy teardown.
    await metricsLease?.end();

    // Flush trajectory capture before proxy teardown so the session-end
    // manifest entry is durable (§11). No-op when capture is disabled.
    if (flushCapture) {
      try {
        await flushCapture();
      } catch (error) {
        flushError = normalizePtyError(error);
      }
    }

    try {
      await stopDockerWorkloadEgress(dockerWorkloadEgress);
    } catch (error) {
      resourceCleanupError = normalizePtyError(error);
    }
    try {
      if (docker) {
        // §8.3: tear the ledgered workload resources down first, then sweep the
        // ordinary transport/network and release the managed-resource lease.
        // See destroyBundleOuterResources.
        await destroyBundleOuterResources({
          docker,
          dockerWorkload,
          containerId,
          sidecarContainerId,
          networkName,
          bundleId: effectiveSessionId,
          context: 'PTY session',
        });
      } else {
        // Infrastructure never came up, so no runtime resource can carry the
        // bundle's owner token: discard a lease minted before the failure
        // (no-op if none was).
        await finalizeManagedResourceLease(effectiveSessionId, { teardownVerified: true });
      }
    } catch (error) {
      const runtimeCleanupError = normalizePtyError(error);
      if (resourceCleanupError === undefined) resourceCleanupError = runtimeCleanupError;
      else resourceCleanupError.cause ??= runtimeCleanupError;
    } finally {
      // These host-only authority surfaces must retire even when runtime
      // cleanup verification fails. Keep their best-effort failures from
      // masking the authoritative resource-cleanup error.
      await mitmProxy?.stop().catch(() => {});
      await proxy?.stop().catch(() => {});
      // The container is gone, so nothing re-plants behind this final sweep.
      // Before the runtime root (sockets dir) is removed, so root-owned entries
      // there are reported rather than only failing the removal. The notice
      // (counts, first paths, what to do) is the one batch sessions show.
      const notice = hostPrivilegedFilesNotice(await privilegedFileScanner?.scan('session end'), 'all');
      if (notice !== undefined) process.stderr.write(chalk.yellow(`${formatSessionNotice(notice)}\n`));
      removeBundleRuntimeRoot(effectiveSessionId as BundleId, 'PTY session');
    }
    await metricsRuntime?.release().catch((err: unknown) => {
      logger.warn(`PTY metrics flush failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Write session snapshot for resume support
    if (adapterIdForSnapshot) {
      try {
        // A shutdown signal (Ctrl-C during setup, SIGTERM/SIGHUP from a
        // multiplexer) is a deliberate stop, like a clean agent exit.
        const status: SessionSnapshot['status'] =
          userExited || signal.aborted ? 'user-exit' : classifyExitStatus(ptyExitCode);

        const resumability = resolveSnapshotResumability({
          conversationStateDir: conversationStateDirForSnapshot,
          transcriptLayout: transcriptLayoutForSnapshot,
          dockerWorkloadAdmitted: dockerWorkload !== undefined,
        });

        const snapshot: SessionSnapshot = {
          sessionId: effectiveSessionId,
          status,
          exitCode: ptyExitCode,
          lastActivity: new Date().toISOString(),
          workspacePath: sandboxDir,
          ...(persona !== undefined ? { persona } : {}),
          providerProfileName: resolvedProviderProfileName,
          agent: adapterIdForSnapshot,
          label: `${adapterDisplayNameForSnapshot ?? adapterIdForSnapshot} (interactive)`,
          resumable: resumability.resumable,
        };

        writeSessionSnapshot(sessionDir, snapshot);
        const why = resumability.reason === undefined ? '' : ` (${resumability.reason})`;
        logger.info(`Session snapshot written (status: ${status}, resumable: ${resumability.resumable})${why}`);
      } catch (snapshotErr) {
        logger.warn(
          `Failed to write session snapshot: ${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}`,
        );
      }
    }

    logger.info(`PTY session ${effectiveSessionId} ended`);
    logger.release(dirConfig.logClaim);

    // shutdownSpinner is declared inside try but accessible here via closure
    shutdownSpinner?.succeed(chalk.dim('PTY session ended'));
  }

  // Authoritative resource-cleanup failure wins, then capture flush failure,
  // then the body failure. Lower-priority failures remain attached as causes
  // rather than being silently discarded.
  if (resourceCleanupError !== undefined) {
    resourceCleanupError.cause ??= flushError ?? primaryError;
    throw resourceCleanupError;
  }
  if (flushError !== undefined) {
    flushError.cause ??= primaryError;
    throw flushError;
  }
  if (primaryError !== undefined) throw primaryError;
}

function normalizePtyError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

// --- PTY proxy ---

/** Creates a net.Socket connection to the PTY target (UDS or TCP). */
function connectToTarget(target: PtyTarget): ReturnType<typeof createConnection> {
  if (typeof target === 'string') {
    return createConnection({ path: target });
  }
  return createConnection({ host: target.host, port: target.port });
}

/**
 * `attachPtyOnce` return codes that signal a non-attached outcome.
 * Distinguishing the two lets the caller decide whether to retry, exit
 * silently, or surface a hard failure.
 */
/** Connected, but the remote closed before sending any data. */
const ATTACH_INSTANT_CLOSE = -1;
/** The socket connect itself failed (e.g. ECONNREFUSED, ENOENT). */
const ATTACH_PRE_CONNECT_ERROR = -2;

/**
 * Attaches the user's terminal to the container PTY via a Node.js socket.
 * Returns a promise that resolves with 0 on normal close, 1 on error.
 *
 * For TCP targets (macOS), retries the connection with polling since
 * the container's socat may not be listening yet when this is called.
 * The socat inside the container does NOT use `fork`, so only one
 * connection is accepted — no separate readiness probe is used.
 */
export async function attachPty(options: PtyProxyOptions): Promise<number> {
  // A shutdown that arrived before attach must not connect: for PTY sessions
  // the host connection is the capability that launches the agent behind the
  // socat listener.
  if (options.signal?.aborted) return 0;
  // One filtered output for the whole attach, so the terminal modes it saw
  // are restored once even across TCP retries (only the attempt that
  // receives data forwards anything).
  const output = createHostTerminalOutput(process.stdout);
  try {
    return await attachPtyWithOutput(options, output);
  } finally {
    output.restore();
    // Still in raw mode here: discard terminal replies that arrive late.
    await drainPendingTerminalInput(process.stdin);
  }
}

async function attachPtyWithOutput(options: PtyProxyOptions, output: HostTerminalOutput): Promise<number> {
  const isTcp = typeof options.target !== 'string';
  if (isTcp) {
    // TCP: poll until the connection succeeds and stays open, then attach.
    // Both pre-connect errors and instant-close indicate "not ready yet".
    const deadline = Date.now() + PTY_READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const code = await attachPtyOnce(options, output, deadline - Date.now());
      if (options.signal?.aborted) return 0;
      if (code !== ATTACH_INSTANT_CLOSE && code !== ATTACH_PRE_CONNECT_ERROR) return code;
      logger.info('PTY TCP connection not ready, retrying...');
      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(PTY_READINESS_POLL_MS, remainingMs)));
      }
    }
    throw new Error(`PTY TCP connection did not stabilize within ${PTY_READINESS_TIMEOUT_MS / 1000}s`);
  }
  // UDS (Linux): readiness was already verified by waitForPtyReady. A
  // pre-connect failure here means the socket file existed but nothing
  // was actually listening — typically a stale file or a socat that
  // crashed between probe and attach. Surface either outcome instead of
  // silently mapping a startup failure to a successful user exit.
  const code = await attachPtyOnce(options, output);
  if (options.signal?.aborted) return 0;
  if (code === ATTACH_PRE_CONNECT_ERROR) {
    throw new Error(
      'PTY socket exists but no listener accepted the connection. ' +
        'The container may have crashed between readiness check and attach.',
    );
  }
  if (code === ATTACH_INSTANT_CLOSE) {
    const diagnostic = await diagnosePtyStartupClose(options);
    const message = `PTY listener closed the connection before sending any output. ${diagnostic}`;
    // Persist the diagnosis while the session logger still owns its file;
    // runPtySession tears the container down before the error reaches the CLI.
    logger.error(`PTY startup failure: ${message}`);
    throw new Error(message);
  }
  return code;
}

/**
 * Capture the smallest host-authoritative diagnostic available before PTY
 * teardown. This intentionally uses existing lifecycle probes rather than
 * exposing a general container-log surface or reflecting untrusted output in
 * an error message.
 */
async function diagnosePtyStartupClose(options: PtyProxyOptions): Promise<string> {
  if (options.runtime === undefined) {
    return 'Container state diagnostics were unavailable; the PTY relay or agent launcher may have failed.';
  }
  try {
    if (await options.runtime.isRunning(options.containerId)) {
      return 'The outer container is still running, so its PTY relay or agent launcher child failed before producing output.';
    }
    if (await options.runtime.containerExists(options.containerId)) {
      return 'The outer container stopped before the agent produced output; its entrypoint or socat listener exited during startup.';
    }
    return 'The outer container disappeared or could not be inspected before teardown.';
  } catch {
    return 'The outer container state could not be inspected before teardown.';
  }
}

/**
 * Single attempt to attach to the PTY. Returns one of:
 *   ≥0                       — terminal exit code from a real session
 *   ATTACH_INSTANT_CLOSE     — connected, remote closed before data
 *   ATTACH_PRE_CONNECT_ERROR — socket connect itself failed
 */
function attachPtyOnce(
  options: PtyProxyOptions,
  output: HostTerminalOutput,
  connectTimeoutMs = PTY_READINESS_TIMEOUT_MS,
): Promise<number> {
  const conn = connectToTarget(options.target);

  const { stdin, stdout } = process;

  return new Promise((resolvePromise) => {
    let resolved = false;
    let cleanupConnected = (): void => {};
    const settle = (code: number): void => {
      if (resolved) return;
      resolved = true;
      resolvePromise(code);
    };

    function cleanupPreConnect(): void {
      clearTimeout(connectTimer);
      conn.removeListener('error', onPreConnectError);
    }
    function onAbort(): void {
      cleanupConnected();
      cleanupPreConnect();
      options.signal?.removeEventListener('abort', onAbort);
      conn.destroy();
      settle(0);
    }

    function onPreConnectError(): void {
      // Pre-connect failure (no `connect` event ever fired). Distinct from
      // a post-connect close so the UDS caller can surface a hard failure
      // instead of treating a stale-socket false positive as success.
      cleanupPreConnect();
      options.signal?.removeEventListener('abort', onAbort);
      settle(ATTACH_PRE_CONNECT_ERROR);
    }
    conn.once('error', onPreConnectError);
    const connectTimer = setTimeout(
      () => {
        cleanupPreConnect();
        options.signal?.removeEventListener('abort', onAbort);
        conn.destroy();
        settle(ATTACH_PRE_CONNECT_ERROR);
      },
      Math.max(1, connectTimeoutMs),
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    conn.once('connect', () => {
      // Once connected, the pre-connect classifier no longer applies; remove
      // it so a post-connect 'error' (e.g. ECONNRESET mid-session) is handled
      // only by the post-connect handler below — otherwise both fire and the
      // earlier-registered pre-connect listener wins, mis-reporting the
      // outcome as ATTACH_PRE_CONNECT_ERROR.
      cleanupPreConnect();

      // Defer raw mode, stdin forwarding, and resize handling until the first
      // data arrives from the remote. For TCP retries, an instant close (no
      // data) returns -1 without touching the terminal, so the user is never
      // left stuck in raw mode between retry attempts.
      let receivedData = false;

      // Host resize events become serialized, latest-wins resize execs (see
      // pty-resize-queue.ts), which also verify the size once it settles.
      const runtime = options.runtime;
      let resizeQueue: PtyResizeQueue | undefined;
      const onResize = (): void => {
        const { columns, rows } = stdout;
        if (columns && rows) resizeQueue?.request(columns, rows);
      };

      // Host -> Container
      // Ctrl-\ (0x1c) is intercepted as an emergency exit since raw mode
      // disables normal signal generation for SIGQUIT.
      const CTRL_BACKSLASH = 0x1c;
      const onData = (data: Buffer): void => {
        if (data.length === 1 && data[0] === CTRL_BACKSLASH) {
          cleanup();
          conn.destroy();
          settle(0);
          return;
        }
        conn.write(data);
      };

      // Container -> Host. The output is untrusted and reaches the user's
      // real terminal, so it is filtered (terminal-output-filter.ts) before it
      // is written. Registered before the first-data handler below so no data
      // is lost; raw mode and stdin forwarding are deferred until we confirm
      // the connection is real (first data).
      const onDrain = (): void => {
        conn.resume();
      };
      const onOutput = (chunk: Buffer): void => {
        if (!output.write(chunk)) {
          conn.pause();
          stdout.once('drain', onDrain);
        }
      };
      conn.on('data', onOutput);

      conn.once('data', () => {
        receivedData = true;
        // Now that the connection is confirmed, enter raw mode and start
        // forwarding user input to the container.
        if (stdin.isTTY) {
          stdin.setRawMode(true);
        }
        stdin.resume();
        stdin.on('data', onData);

        // Start resize forwarding and send the initial size.
        if (runtime) resizeQueue = createPtyResizeQueue({ runtime, containerId: options.containerId });
        stdout.on('resize', onResize);
        onResize();
      });

      // Use function declarations (hoisted) so cleanup and onAbort can
      // reference each other without temporal dead zone issues.
      function cleanup(): void {
        stdout.removeListener('resize', onResize);
        stdout.removeListener('drain', onDrain);
        stdin.removeListener('data', onData);
        conn.removeListener('data', onOutput);
        if (receivedData) {
          stdin.pause();
        }
        resizeQueue?.close();
        options.signal?.removeEventListener('abort', onAbort);
      }
      cleanupConnected = cleanup;
      if (options.signal?.aborted) {
        onAbort();
        return;
      }

      conn.once('close', () => {
        cleanup();
        settle(receivedData ? 0 : ATTACH_INSTANT_CLOSE);
      });
      conn.once('error', () => {
        cleanup();
        settle(receivedData ? 1 : ATTACH_INSTANT_CLOSE);
      });
    });
  });
}

// --- Readiness polling ---

/**
 * Removes the UDS inode left by an unclean PTY listener shutdown.
 *
 * The caller must establish exclusive ownership and stop the prior listener
 * before invoking this helper. Unexpected path types fail closed rather than
 * being deleted from the host-owned runtime directory.
 */
export function removeStalePtySocket(path: string): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stats.isSocket()) {
    throw new Error(`Refusing to replace non-socket PTY path ${path}`);
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  logger.info(`Removed stale PTY socket ${path}`);
}

/**
 * Waits for the PTY socket file to appear (Linux UDS only). macOS TCP
 * skips this probe because the container's socat does not use `fork`.
 *
 * We poll for a UDS *inode* rather than opening a connection. socat's
 * `UNIX-LISTEN` creates the socket file at `bind()`, so file existence
 * is a sufficient readiness signal — and avoids the connect-and-close
 * that would trigger socat's `,fork` semantics, spawning a doomed child
 * before the real `attachPty` connection arrives. That doomed child can
 * race the real one for shared per-agent state (e.g. Goose's SQLite
 * session DB at `~/.local/share/goose/sessions/sessions.db`), producing
 * "table schema_version already exists" migration errors.
 *
 * We require the inode to be a socket — a stale regular file or
 * directory at the path is not "ready", since the Linux/UDS attach path
 * does not retry on connect failure.
 */
export async function waitForPtyReady(
  target: PtyTarget,
  timeoutMs: number = PTY_READINESS_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof target !== 'string') {
    // macOS TCP path is guarded out at the call site (pty-session.ts ~534);
    // this branch exists only as a defensive no-op so the helper stays total.
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // An interrupted setup stops waiting at once (rejecting with the
    // signal's reason) so the session teardown can run.
    signal?.throwIfAborted();
    if (isSocketPath(target)) return;
    await abortableDelay(PTY_READINESS_POLL_MS, signal);
  }

  throw new Error(`PTY socket did not become ready within ${timeoutMs / 1000}s`);
}

/** `setTimeout` as a promise that rejects with the signal's reason on abort. */
function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectPromise(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Returns true when `path` exists and is a UNIX domain socket. ENOENT is
 * treated as "not ready yet"; other lstat errors propagate, since they
 * indicate a setup problem (permissions, missing parent directory) that
 * silent polling would only mask.
 */
function isSocketPath(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

// --- Registration ---

/**
 * Writes a PTY session registration file to the registry directory.
 * Returns the absolute path of the registration file.
 */
interface MuxContext {
  readonly muxId: string;
  readonly muxPid: number;
}

/** Reads mux ownership context from environment variables, if set. */
function getMuxContext(): MuxContext | undefined {
  const muxId = process.env.IRONCURTAIN_MUX_ID;
  const muxPidStr = process.env.IRONCURTAIN_MUX_PID;
  if (!muxId) return undefined;
  const muxPid = muxPidStr ? parseInt(muxPidStr, 10) : undefined;
  if (muxPid === undefined || isNaN(muxPid)) return undefined;
  return { muxId, muxPid };
}

function writeRegistration(sessionId: string, escalationDir: string, adapterDisplayName: string): string {
  const registryDir = getPtyRegistryDir();
  mkdirSync(registryDir, { recursive: true, mode: 0o700 });

  const mux = getMuxContext();

  const registration: PtySessionRegistration = {
    sessionId,
    escalationDir,
    label: `${adapterDisplayName} (interactive)`,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    ...(mux && { muxId: mux.muxId, muxPid: mux.muxPid }),
  };

  const registrationPath = resolve(registryDir, `session-${sessionId}.json`);
  atomicWriteJsonSync(registrationPath, registration);
  return registrationPath;
}
