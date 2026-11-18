import { getGatewayDefinition } from '../config/provider-definitions.js';
import { createTcpTransportTlsOptions } from './tcp-transport-tls.js';
import { bindDockerEndpointExec } from './docker-endpoint.js';
import { DOCKER_AGENT_VOLUME_SHADOW } from './docker-agent-volume-shadow.js';
import { prepareDockerAgentStartup } from './agent-startup.js';
import {
  isAgentSudoEnabled,
  planAgentContainerPrivileges,
  planBundleAgentPrivileges,
  type AgentContainerPrivilegePlan,
} from './agent-privileges.js';
import {
  createBundlePrivilegedFileScanner,
  deliverHostPrivilegedFilesNotice,
  hostPrivilegedFilesNotice,
  includeHostPrivilegedFilesInFailure,
  type HostMountPrivilegeScanner,
} from './host-mount-privilege-scan.js';
import type { HostPrivilegedFilesDiagnostic } from '../session/startup-notices.js';
/**
 * Shared Docker session infrastructure setup.
 *
 * Extracts the common setup steps (session dirs, proxies, orientation,
 * CA, fake keys, image) used by both the standard DockerAgentSession
 * and the PTY session module.
 */

import { resolve, dirname, isAbsolute, relative } from 'node:path';
import {
  existsSync,
  readdirSync,
  readFileSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  chmodSync,
  lstatSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { validateToolchainExecutable } from './toolchain-executable.js';
import { readHardenedFile, readPackageAsset } from '../hardened-fs.js';
import { arch, tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { quote } from 'shell-quote';
import type { DockerAuthKind, IronCurtainConfig } from '../config/types.js';
import { getBundleRuntimeRoot, getWorkflowRunDir } from '../config/paths.js';
import {
  getBundleShortId,
  type BundleId,
  type SessionId,
  type SessionMetadata,
  type SessionMode,
} from '../session/types.js';
import { DEFAULT_CONTAINER_SCOPE, type WorkflowId } from '../workflow/types.js';
import { validatedWorkflowStagedDirectory } from '../workflow/staged-directories.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import {
  CONTAINER_SCRIPTS_DIR,
  type AgentAdapter,
  type AgentId,
  type ConversationStateConfig,
} from './agent-adapter.js';
import { buildContainerWorkspaceMount } from './container-workspace.js';
import { assertReadOnlyWorkspaceSupported } from '../config/read-only-workspace.js';
import type { ReadOnlyWorkspace } from '../types/read-only-workspace.js';
import type { ResolvedUserConfig } from '../config/user-config.js';
import { resolveActiveProfile, USER_CONFIG_DEFAULTS } from '../config/user-config.js';
import {
  checkDockerAvailable,
  classifyDockerUserNamespace,
  type DockerServerFacts,
  type DockerUserNamespaceMode,
} from './docker-probe.js';
import type { DockerProxy } from './code-mode-proxy.js';
import type { EscalationPromptFn } from '../trusted-process/tool-call-coordinator.js';
import type { WorkflowCommitHandler } from '../trusted-process/workflow-commit-tool.js';
import { defaultExecFile, IRONCURTAIN_LABEL_BUNDLE } from './docker-manager.js';
import type { MitmProxy } from './mitm-proxy.js';
import type { TrajectoryCaptureWriter } from './trajectory-capture.js';
import type { CertificateAuthority } from './ca.js';
import type {
  ContainerRuntime,
  DockerContainerConfig,
  DockerMount,
  DockerNamedVolumeMount,
  DockerTrustedCreateOptions,
  DockerUlimit,
  ImageBuildOptions,
} from './types.js';
import { checkAgentCliVersion, resolveAgentCliBuildArgs } from './agent-cli-version.js';
import {
  BASE_IMAGE_LOGICAL_NAME,
  IMAGE_BUILD_HASH_LABEL,
  imageBuildTag,
  isImageBuildTagOf,
  isImmutableImageId,
  shortBuildHash,
} from './image-identity.js';
import { createContainerRuntime, resolveRuntimeKind, type ContainerRuntimeKind } from './container-runtime.js';
import type { HostOnlyNetwork, NetworkTopology } from './network-topology.js';
import type { ProviderKeyMapping } from './mitm-proxy.js';
import { parseUpstreamBaseUrl, type AgentKind, type ProviderConfig, type UpstreamTarget } from './provider-config.js';
import { getInternalNetworkName } from './platform.js';
import { cleanupContainers, destroyBundleOuterResources } from './container-lifecycle.js';
import {
  createIronCurtainInternalNetwork,
  InternalNetworkConnectivityError,
  ironCurtainInternalSubnetHostAddress,
  finalizeManagedResourceLease,
  managedResourceLabels,
  reconcileIronCurtainDockerResourcesBestEffort,
  selectIronCurtainInternalSubnet,
  withInternalNetworkAllocationRetry,
  type AllocatedInternalNetwork,
  type SelectIronCurtainInternalSubnetOptions,
} from './docker-resource-lifecycle.js';
import { clampDockerResources } from './resource-limits.js';
import type { EffectiveDockerResources, HostResources } from './resource-limits.js';
import { ensureTransportSidecarImage, hardenTransportSidecarCreate } from './transport-sidecar-image.js';
import {
  tcpTransportSidecarAddress,
  tcpTransportListenEndpoint,
  tcpTransportUpstreamEndpoint,
  tcpTransportHostCaMount,
  startTcpTransportSidecar,
} from './tcp-transport-sidecar.js';
import { errorMessage } from '../utils/error-message.js';
import { createCachedStager } from '../skills/staging.js';
import type { ResolvedSkill } from '../skills/types.js';
import {
  assertWorkflowDependencyProvisioningAvailable,
  buildWorkflowDependencyProvisionScript,
  ensureWorkflowDependencyLayers,
  listWorkflowDependencyLayers,
  planWorkflowDependencyLayers,
  readWorkflowDependencyManifests,
  workflowRunDependencyRoot,
  WORKFLOW_DEPENDENCY_MANIFESTS_DIR,
  WORKFLOW_NODE_MODULES_DIR,
  WORKFLOW_PYTHON_VENV_DIR,
  type WorkflowDependencyLayers,
  type WorkflowDependencyProvisionRequest,
  type WorkflowNodeModulesLayer,
  type WorkflowPythonVenvLayer,
} from './workflow-dependency-cache.js';
import {
  buildRuntimeTrustEnv,
  CONTAINER_RUNTIME_CA_BUNDLE,
  renderAptProxyConfig,
  stageAptProxyConfig,
  stageRuntimeTrust,
} from './runtime-trust.js';
import { buildPackageClientEnv } from './package-client-env.js';
import {
  getFrozenClientToolchainManifestPath,
  getFrozenWatchdogPolicyTemplatePath,
  getIronCurtainPackageRoot,
} from './docker-workload-paths.js';
import { prepareSelectedAgentArtifact, type SelectedAgentArtifact } from './selected-agent-artifact.js';
import {
  assertAdmittedDockerWorkloadRuntimeAvailable,
  assertDockerWorkloadVariantAdmitted,
  formatDockerWorkloadStatus,
  resolvedDockerWorkloadConfigSchema,
  type DockerWorkloadNetworkAccess,
  type ResolvedDockerWorkloadConfig,
} from '../docker-workload/config.js';
import type {
  DockerWorkloadBundleHandle,
  LedgeredOuterCreateSpec,
  OuterResourceRole,
} from '../docker-workload/infrastructure.js';
import {
  assertNestedDaemonBackendImplemented,
  nestedDaemonAgentEnv,
  resolveNestedDaemonBundle,
  startAppleVmDockerWorkload,
} from '../docker-workload/session-daemon.js';
import {
  dockerBuildShimExecFor,
  preflightDockerBuildShimAgent,
  preflightDockerBuildTrust,
} from '../docker-workload/docker-build-shim-preflight.js';
import {
  APPLE_VM_PACKAGE_EGRESS_PROXY_URL,
  APPLE_VM_PACKAGE_EGRESS_SOCKET,
  APPLE_VM_REGISTRY_EGRESS_PROXY_URL,
  APPLE_VM_REGISTRY_EGRESS_SOCKET,
} from '../docker-workload/apple-vm-daemon.js';
import type { MetricsInvocationContext, MetricsInvocationLease } from '../llm-metrics/attribution-registry.js';
import { acquireLlmMetricsRuntime, type LlmMetricsRuntimeLease } from '../llm-metrics/runtime.js';
import { budgetGateOptionsFor, createBudgetGate, type BundleBudgetGate } from './budget-gate.js';
import { hasMetricsCapableCompletionEndpoint } from './llm-observation/completion-endpoint.js';
import {
  appleVmDockerWorkloadArtifactMount,
  stageAppleVmDockerWorkloadBootstrap,
  type AppleVmDockerWorkloadBootstrapConfig,
} from '../docker-workload/apple-private-docker.js';
import {
  PRIVATE_DOCKER_HOST,
  PRIVATE_DOCKER_WORKLOAD_NETWORK,
  PRIVATE_DOCKER_WORKLOAD_NETWORK_ENV,
} from '../docker-workload/private-docker.js';
import {
  assertDockerDesktopSidecarImage,
  DOCKER_DESKTOP_SIDECAR_DOCKER_HOST,
  type DockerDesktopSidecarHandle,
  type DockerDesktopSidecarImage,
  type DockerDesktopSidecarResources,
} from '../docker-workload/docker-desktop-sidecar.js';
import {
  createDesktopRelayExposure,
  DESKTOP_RELAY_HOST_GATEWAY_ALIAS,
  DESKTOP_RELAY_PROFILE,
  type FixedRelayUpstream,
  type CreateDesktopRelayExposureOptions,
  type DesktopRelayExposure,
} from '../docker-workload/desktop-relay.js';
import { loadClientToolchainManifest } from '../docker-workload/client-toolchain.js';
import {
  canonicalPathBelowHome,
  resolveCanonicalIronCurtainHome,
  type CanonicalIronCurtainHome,
} from '../docker-workload/canonical-home.js';
import { resolveDockerToolchainSource, type DockerToolchainSource } from '../docker-workload/toolchain-source.js';
import {
  dockerDesktopVmCapacity,
  dockerWorkloadRuntimeKind,
  type DockerWorkloadEnvironment,
} from '../docker-workload/environment.js';
import {
  assertAgentHostIdentityIsNotRoot,
  resolveContainerIdentity,
  type ContainerIdentity,
} from './container-identity.js';
import type { ExpandedOuterCreate } from '../docker-workload/lifecycle-evidence.js';
import {
  DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
  DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
  DOCKER_BUILD_TRUST_CA_CERT_PATH,
  DOCKER_BUILD_TRUST_CONTRACT_PATH,
  DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY,
  DOCKER_BUILD_TRUST_WRAPPER_PATH,
  DOCKER_BUILD_TRUST_REAL_RUNC_PATH,
  DOCKER_BUILD_TRUST_REAL_RUNC_MODE,
  DOCKER_BUILD_TRUST_REAL_RUNC_NLINK,
  DOCKER_BUILD_TRUST_REAL_RUNC_VERSION,
  getDockerBuildShimStagingContract,
  type DockerBuildShimStagingContract,
  type DockerBuildTrustCanaryContract,
} from './docker-build-shim.js';
import type { DockerWorkloadEgressSet } from './docker-workload-egress.js';
import { createProxyAuthorization, proxyAuthorizedUrl, type ProxyAuthorization } from './proxy-authorization.js';
import * as logger from '../logger.js';

export { InternalNetworkConnectivityError };
export { computeWorkflowDependencyHash } from './workflow-dependency-cache.js';

/**
 * Create a bundle-owned directory and enforce 0o700 permissions even if
 * it already exists. `mkdirSync`'s `mode` only applies on creation, so a
 * stale dir (crashed prior run, manual creation) could otherwise leave
 * the UDS endpoints reachable by other local users.
 *
 * Rejects symlinks at the bundle path itself: even though these dirs
 * now live under `~/.ironcurtain/run/` (not `/tmp/`), we don't want to
 * silently follow a pre-existing symlink in the user's own tree. The
 * `lstatSync` check runs BEFORE `mkdirSync` — `mkdirSync({recursive:
 * true})` follows symlinks, so checking after the create would let a
 * pre-existing symlink redirect the directory creation before we got a
 * chance to reject it.
 *
 * Ancestor components (`~/.ironcurtain/run/`, `~/.ironcurtain/`, `~/`)
 * are NOT walked — the user's home tree is our trust boundary, and an
 * attacker who can rewrite `~/.ironcurtain/` already controls the CA
 * and the OAuth credentials we store there. Defending against that
 * within this helper would be theater.
 */
export function ensureSecureBundleDir(path: string): void {
  // Validate any pre-existing entry at `path` before creating so a
  // planted symlink can't redirect our mkdir to an attacker target.
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to use symlink at bundle path ${path}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Bundle path ${path} exists but is not a directory`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // Path does not exist yet — fall through to mkdirSync.
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

const DOCKER_BUILD_SHIM_STAGING_SUBDIR = 'package-build-runtime';
const DOCKER_BUILD_SHIM_SOURCE_NAME = 'docker';
const DOCKER_BUILD_PROXY_CONFIG_SOURCE_SUBDIR = 'package-build-client';
const DOCKER_BUILD_TRUST_SOURCE_SUBDIR = 'trust';
const DOCKER_BUILD_TRUST_WRAPPER_SOURCE_NAME = 'trust/runc';
const DOCKER_BUILD_TRUST_CONTRACT_SOURCE_NAME = 'trust/build-trust-contract.json';
const DOCKER_BUILD_TRUST_CA_CERT_SOURCE_NAME = 'trust/ca-cert.pem';
const DOCKER_BUILD_TRUST_CA_BUNDLE_SOURCE_NAME = 'trust/ca-bundle.pem';
const DOCKER_BUILD_TRUST_APT_CONFIG_SOURCE_NAME = 'trust/apt.conf';
const CA_GENERATION_PATTERN = /^gen-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function writeExactStagedFile(path: string, content: string | Buffer, mode: number): void {
  writeFileSync(path, content, { mode, flag: 'wx' });
  chmodSync(path, mode);
  const stats = lstatSync(path);
  const observedMode = stats.mode & 0o777;
  const observed = readFileSync(path);
  const expected = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    observedMode !== mode ||
    !observed.equals(expected)
  ) {
    throw new Error(`nested-Docker build artifact ${path} failed its exact file, link, mode, or content check`);
  }
}

function readExactBuildTrustInput(path: string): Buffer {
  return readHardenedFile(path, { label: 'package build trust input', minBytes: 1, maxBytes: 2 << 20 });
}

/** Materialize the package-only build shim outside every agent-visible orientation share. */
export function stageDockerBuildShim(
  bundleId: BundleId,
  networkAccess: DockerWorkloadNetworkAccess,
  options: {
    readonly orientationDir: string;
    readonly caGeneration: string;
    readonly packageProxyUrl?: string;
    readonly registryProxyUrl?: string;
    readonly architecture: 'amd64' | 'arm64';
    readonly runtimeKind: ContainerRuntimeKind;
    readonly uid?: number;
    readonly gid?: number;
    /** Required for the same-VM placement; selected from the stopped image archive. */
    readonly protectedRealRunc?: Buffer;
  },
): DockerBuildShimStaging | undefined {
  const contract = getDockerBuildShimStagingContract(networkAccess, options.packageProxyUrl, options.registryProxyUrl, {
    architecture: options.architecture,
    dockerHost: options.runtimeKind === 'docker' ? DOCKER_DESKTOP_SIDECAR_DOCKER_HOST : PRIVATE_DOCKER_HOST,
    uid: options.uid,
    gid: options.gid,
  });
  if (contract === undefined) return undefined;
  if (!CA_GENERATION_PATTERN.test(options.caGeneration)) {
    throw new Error('nested-Docker package build staging requires an authenticated CA generation');
  }
  if (options.runtimeKind !== 'docker' && options.protectedRealRunc === undefined) {
    throw new Error('same-VM package builds require a host-staged read-only real-runc executable');
  }
  const stagingRoot = resolve(getBundleRuntimeRoot(bundleId), DOCKER_BUILD_SHIM_STAGING_SUBDIR);
  ensureSecureBundleDir(dirname(stagingRoot));
  const temporary = mkdtempSync(`${stagingRoot}.prepare-`);
  const artifacts: DockerBuildShimStagedArtifact[] = [];
  const stage = (
    kind: DockerBuildShimStagedArtifact['kind'],
    name: string,
    target: string,
    content: string | Buffer,
    mode: number,
  ): void => {
    writeExactStagedFile(resolve(temporary, name), content, mode);
    artifacts.push({ kind, source: resolve(stagingRoot, name), target, readonly: true });
  };
  try {
    // Apple Container drops a directory share when its host descendants are
    // also mounted elsewhere. Keep the protected directory disjoint from the
    // separately mounted CLI, client config, and real-runc sources on both backends.
    const trustDirectory = resolve(temporary, DOCKER_BUILD_TRUST_SOURCE_SUBDIR);
    mkdirSync(trustDirectory, { mode: 0o755 });
    chmodSync(trustDirectory, 0o755);
    stage(
      'docker-shim',
      DOCKER_BUILD_SHIM_SOURCE_NAME,
      contract.shimArtifact.targetPath,
      contract.shimArtifact.content,
      contract.shimArtifact.mode,
    );
    const clientDirectory = resolve(temporary, DOCKER_BUILD_PROXY_CONFIG_SOURCE_SUBDIR);
    mkdirSync(clientDirectory, { mode: 0o755 });
    chmodSync(clientDirectory, 0o755);
    writeExactStagedFile(
      resolve(clientDirectory, 'config.json'),
      contract.proxyConfigArtifact.content,
      contract.proxyConfigArtifact.mode,
    );
    artifacts.push({
      kind: 'proxy-config',
      source: resolve(stagingRoot, DOCKER_BUILD_PROXY_CONFIG_SOURCE_SUBDIR),
      target: dirname(contract.proxyConfigArtifact.targetPath),
      readonly: true,
    });
    // A packaged binary: an install made under umask 002 leaves it 0775, which
    // the package-asset rules accept only for the owner's private group.
    const packageRoot = getIronCurtainPackageRoot();
    const wrapper = readPackageAsset(resolve(packageRoot, contract.buildTrustWrapperArtifact.packagePath), {
      label: 'packaged build-trust wrapper',
      minBytes: 64,
      maxBytes: 32 << 20,
      packageRoot,
    });
    validateToolchainExecutable(wrapper, options.architecture, 'packaged build-trust wrapper');
    stage(
      'build-trust-wrapper',
      DOCKER_BUILD_TRUST_WRAPPER_SOURCE_NAME,
      contract.buildTrustWrapperArtifact.targetPath,
      wrapper,
      contract.buildTrustWrapperArtifact.guestMode,
    );
    if (options.protectedRealRunc !== undefined) {
      if (options.protectedRealRunc.length === 0 || options.protectedRealRunc.length > 128 << 20)
        throw new Error('selected real-runc executable is outside bounds');
      validateToolchainExecutable(options.protectedRealRunc, options.architecture, 'selected real-runc');
      stage(
        'build-trust-real-runc',
        'real-runc',
        DOCKER_BUILD_TRUST_REAL_RUNC_PATH,
        options.protectedRealRunc,
        DOCKER_BUILD_TRUST_REAL_RUNC_MODE,
      );
    }
    const caCertificate = readExactBuildTrustInput(resolve(options.orientationDir, 'ca-cert.pem')).toString('utf8');
    const caBundle = readExactBuildTrustInput(resolve(options.orientationDir, 'ca-bundle.pem')).toString('utf8');
    const aptConfig = renderAptProxyConfig(options.packageProxyUrl ?? APPLE_VM_PACKAGE_EGRESS_PROXY_URL);
    const sources = [
      {
        kind: 'build-trust-ca-cert' as const,
        name: DOCKER_BUILD_TRUST_CA_CERT_SOURCE_NAME,
        path: DOCKER_BUILD_TRUST_CA_CERT_PATH,
        destination: '/dev/ironcurtain/ca-cert.pem',
        content: caCertificate,
      },
      {
        kind: 'build-trust-ca-bundle' as const,
        name: DOCKER_BUILD_TRUST_CA_BUNDLE_SOURCE_NAME,
        path: DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
        destination: '/dev/ironcurtain/ca-bundle.pem',
        content: caBundle,
      },
      {
        kind: 'build-trust-apt-config' as const,
        name: DOCKER_BUILD_TRUST_APT_CONFIG_SOURCE_NAME,
        path: DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
        destination: '/dev/ironcurtain/apt.conf',
        content: aptConfig,
      },
    ];
    for (const source of sources) stage(source.kind, source.name, source.path, source.content, 0o444);
    const trustContract = `${JSON.stringify(
      {
        schemaVersion: 2,
        caGeneration: options.caGeneration,
        realRunc: {
          path: DOCKER_BUILD_TRUST_REAL_RUNC_PATH,
          nlink: DOCKER_BUILD_TRUST_REAL_RUNC_NLINK,
          mode: DOCKER_BUILD_TRUST_REAL_RUNC_MODE.toString(8).padStart(4, '0'),
          version: DOCKER_BUILD_TRUST_REAL_RUNC_VERSION,
          requiresEffectiveReadOnly: true,
        },
        publicSources: sources.map(({ path, destination, content }) => ({
          path,
          destination,
          size: Buffer.byteLength(content),
          mode: '0444',
        })),
      },
      null,
      2,
    )}\n`;
    stage(
      'build-trust-contract',
      DOCKER_BUILD_TRUST_CONTRACT_SOURCE_NAME,
      DOCKER_BUILD_TRUST_CONTRACT_PATH,
      trustContract,
      0o444,
    );
    if (existsSync(stagingRoot)) throw new Error('package build staging generation already exists');
    chmodSync(temporary, 0o755);
    renameSync(temporary, stagingRoot);
    return {
      contract,
      artifacts,
      buildTrustCanary: {
        caGeneration: options.caGeneration,
        buildTrustContract: trustContract,
        caCertificate,
        caBundle,
        aptConfig,
      },
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Shared infrastructure bundle produced by the pre-container setup phase.
 *
 * `prepareDockerInfrastructure()` returns this shape: proxies, CA, fake keys,
 * orientation, image — everything the container needs, but not the container
 * itself. PTY sessions use this because they build their own containers
 * with TTY-specific settings. Standalone Docker sessions go through
 * `createDockerInfrastructure()` instead, which extends this with a
 * running container.
 */
export type DockerDesktopAgentAccess = Pick<DockerDesktopSidecarHandle, 'dockerHost' | 'agentApiMount'> & {
  /** Private network name inside the nested daemon. */
  readonly networkName: string;
  /** Ledgered `--internal` outer network shared by the agent and fixed egress relays. */
  readonly outerEgressNetworkName?: string;
};

export interface DockerDesktopResourcePartition {
  readonly sidecar: DockerDesktopSidecarResources;
  readonly transport: DockerDesktopSidecarResources;
  readonly agent: EffectiveDockerResources & { readonly pidsLimit: number };
}

export interface TcpTransportCredentials {
  readonly mcpToken: string;
  readonly proxyAuthorization: ProxyAuthorization;
}

export interface PreContainerInfrastructure {
  /** Startup and provisioning findings, including those emitted before a session exists. */
  readonly onHostPrivilegedFiles?: (notice: HostPrivilegedFilesDiagnostic) => void;
  /**
   * Stable key for this bundle. Used by:
   *  - Docker container name: `ironcurtain-<bundleId[0:12]>`
   *  - `ironcurtain.bundle=<bundleId>` label
   *  - Per-bundle directory layout under `workflow-runs/<wfId>/containers/<bundleId>/`
   *  - Coordinator control socket path
   *
   * Minted by `createDockerInfrastructure()`; never changes for a bundle's
   * lifetime. In single-session CLI mode the underlying value equals the
   * `SessionId` (the session factory casts at the boundary); in workflow
   * mode the orchestrator mints a dedicated `BundleId`.
   *
   * See `docs/designs/workflow-session-identity.md` §2.1 / §2.3.
   */
  readonly bundleId: BundleId;
  /**
   * Workflow id this bundle belongs to, if any. Present only when the
   * bundle was created under a workflow run; drives the
   * `ironcurtain.workflow` and `ironcurtain.scope` Docker labels in
   * `createSessionContainers()`. Standalone CLI / PTY bundles leave
   * this undefined so no workflow/scope labels are emitted.
   *
   * See `docs/designs/workflow-session-identity.md` §7.
   */
  readonly workflowId?: WorkflowId;
  /** Actual run root supplied by the orchestrator, including external resumes. */
  readonly workflowRunDir?: string;
  /**
   * Scope this bundle was minted for, if any. Present only on
   * workflow-mode bundles (alongside `workflowId`). Emitted directly as
   * the `ironcurtain.scope=<scope>` Docker label so resume / orphan
   * reclamation can reconstruct `bundlesByScope` from the live container
   * set. Standalone CLI / PTY bundles leave this undefined.
   *
   * See `docs/designs/workflow-session-identity.md` §2.5 / §7.
   */
  readonly scope?: string;
  /**
   * Host directory holding bundle-scoped artifacts (sockets, escalations,
   * orientation, CA, fake keys, system-prompt). Outlives any single session
   * invocation.
   */
  readonly bundleDir: string;
  /**
   * Host directory bind-mounted as the agent's workspace. Under workflow
   * mode a single workspace is shared across bundles; single-session
   * callers pass a per-session sandbox here.
   */
  readonly workspaceDir: string;
  /**
   * The bundle's read-only workspace, copied from
   * `config.readOnlyWorkspace` when it was prepared: its container mounts
   * `workspaceDir` read-only and its coordinator denies every change outside
   * the writable directories. Absent for an ordinary read-write bundle. The
   * workflow orchestrator checks it before a read-only state borrows the
   * bundle.
   */
  readonly readOnlyWorkspace?: ReadOnlyWorkspace;
  readonly escalationDir: string;
  /**
   * Audit log path, populated by `prepareDockerInfrastructure()` from
   * `config.auditLogPath`. Kept on the bundle so consumers like
   * `AuditLogTailer` can read it without chasing the config reference;
   * the single source of truth remains `config.auditLogPath`.
   */
  readonly auditLogPath: string;
  readonly proxy: DockerProxy;
  readonly mitmProxy: MitmProxy;
  readonly docker: ContainerRuntime;
  /**
   * True for native Linux Docker bundles whose daemon runs neither rootless
   * nor with userns-remap (or whose security options could not be read):
   * container root is host root on the bind mounts, so the agent container's
   * read-write host mounts are scanned for setuid/setgid and root-owned
   * entries after each turn and at teardown (`privilegedFileScanner`, audit
   * finding DINF-3). Absent (false) everywhere else.
   */
  readonly containerRootIsHostRoot?: boolean;
  /**
   * `docker exec --user` for agent execs that name one explicitly, when it is
   * not `codespace`: the numeric agent UID of a sudo-off bundle
   * (`agentSudo: false`), so no exec trusts the image to map an account name
   * to a non-root UID. The bundle's runtime already defaults to it.
   */
  readonly agentExecUser?: string;
  /**
   * Whether the bundle's agent keeps passwordless sudo: the `agentSudo` of the
   * privilege plan it was prepared with (see `agent-privileges.ts`). Workflow
   * snapshots record it, so a resume under `agentSudo: false` can refuse one
   * taken while the agent had root. Absent on hand-built bundles (tests),
   * whose snapshots then count as taken with sudo.
   */
  readonly agentSudo?: boolean;
  readonly adapter: AgentAdapter;
  readonly ca: CertificateAuthority;
  readonly fakeKeys: Map<string, string>;
  readonly orientationDir: string;
  readonly systemPrompt: string;
  readonly image: string;
  /** Exact image-resolution tuple; admitted mode carries selected-artifact evidence. */
  readonly imageResolution?: AgentImageResolution;
  /** Container runtime backend this bundle was built for. */
  readonly runtimeKind: ContainerRuntimeKind;
  /**
   * Proxy-transport topology (see network-topology.ts). `useTcp` is the
   * legacy projection `topology !== 'uds'`, kept for existing consumers.
   */
  readonly topology: NetworkTopology;
  readonly useTcp: boolean;
  /** Per-bundle admission for the shared Desktop host-gateway TCP route. */
  readonly tcpTransport?: TcpTransportCredentials;
  /**
   * Per-bundle host-only network, present only on `tcp-hostonly`
   * bundles. Created during the prepare phase (the gateway address is
   * needed for orientation and container env before any container
   * exists); `createSessionContainers` attaches the agent container to
   * it and reports it as `internalNetwork` so the standard teardown
   * paths remove it.
   */
  readonly hostOnlyNetwork?: HostOnlyNetwork;
  readonly socketsDir: string;
  /** MITM proxy listen address (port for TCP mode, socketPath for UDS mode). */
  readonly mitmAddr: { socketPath?: string; port?: number };
  /** Container-facing base URL for the MITM proxy, without attribution credentials. */
  readonly metricsProxyUrl: string;
  /** Authentication method used for this session. */
  readonly authKind: DockerAuthKind;
  /** Resolved provider-profile name retained for attribution and grouping. */
  readonly providerProfileId: string;
  /** Host-side conversation state directory, if the adapter supports resume. */
  readonly conversationStateDir?: string;
  /** Conversation state config from the adapter, if resume is supported. */
  readonly conversationStateConfig?: ConversationStateConfig;
  /**
   * Host-side staging dir + container bind-mount target for skills.
   * Always emits a separate read-only bind mount — nested bind mounts
   * (staging inside another mount's source dir) are unreliable on
   * Docker Desktop / macOS, so we use a sibling path the adapter
   * advertised as unused inside the container.
   */
  readonly skillsMount?: {
    /** Host-side staging dir (also passed to `restageSkills` and the cached stager). */
    readonly hostDir: string;
    /** Container target path; copied verbatim from `adapter.skills.containerPath`. */
    readonly target: string;
  };
  /** Host-side workflow scripts dir mounted read-only into the container. */
  readonly scriptsMount?: {
    readonly hostDir: string;
    readonly target: string;
  };
  /**
   * This run's writable Python dependency layer (`hostDir`), mounted read-write
   * at /opt/workflow-venv. It is seeded from a host-verified, content-keyed
   * shared base (`baseDir`) that no agent container ever mounts; see
   * `workflow-dependency-cache.ts`.
   */
  readonly workflowPythonVenvMount?: WorkflowPythonVenvLayer;
  /** This run's writable node_modules layer, mounted read-write at /opt/workflow-node_modules. */
  readonly workflowNodeModulesMount?: WorkflowNodeModulesLayer;
  /**
   * Re-stages the bundle's skills with the given resolved set.
   * No-op when `skillsMount` is undefined or when the set is byte-identical
   * to the previous call. Workflow callers use this on every state
   * transition; the bind mount is live, so the container's view updates
   * in place.
   */
  restageSkills(skills: readonly ResolvedSkill[]): void;
  /**
   * Routes token-stream events from the MITM proxy's LLM API tap under the
   * given session ID, or disables routing when `undefined`.
   *
   * Required because a single long-lived infrastructure bundle (shared
   * across workflow agent states) must label extracted events with the
   * *active* per-state session ID rather than a static ID baked in at
   * construction time. Callers flip this around each agent run; thin
   * wrapper over `MitmProxy.setTokenSessionId()`.
   */
  setTokenSessionId(id: import('../session/types.js').SessionId | undefined): void;

  /** Register an exact invocation context and return its credentialed proxy URL. */
  beginMetricsInvocation?(context: MetricsInvocationContext): MetricsInvocationLease;

  /**
   * Host-enforced token and cost budget of this bundle, enforced by its MITM
   * proxy on every completion request (see `budget-gate.ts`). Batch and
   * workflow sessions open a turn on it around each agent exec (no
   * completion is forwarded outside a turn) and stop the turn when it
   * refuses a request for budget; PTY bundles have one session-long
   * allowance. Always set by `prepareDockerInfrastructure()`; optional so
   * hand-built bundles (tests) need not carry one.
   */
  readonly budgetGate?: BundleBudgetGate;

  /**
   * Begin trajectory capture for a session. Atomically:
   *   1. sets the proxy's captureSessionId (`MitmProxy.setCaptureSessionId`)
   *   2. sets the proxy's capturePersona (`MitmProxy.setCapturePersona`)
   *   3. opens the per-session trajectory file and appends a `session-start`
   *      manifest entry (`TrajectoryCaptureWriter.beginSession`)
   *
   * No-op when capture is disabled (writer is undefined). MUST be called
   * before the agent process is unblocked, so the first exchange the
   * agent emits is already tagged with the right session. See
   * docs/designs/mitm-token-trajectory-capture.md §11.
   *
   * Always present (never optional): the method is inert when the writer
   * is undefined, so "always present, sometimes a no-op" is correct.
   * Making it required turns "forgot to wire capture" into a compile
   * error instead of a silent no-op.
   */
  beginCaptureSession: (opts: {
    sessionId: import('../session/types.js').SessionId;
    persona?: string;
    fsmState?: string;
  }) => void;

  /**
   * End trajectory capture for a session. Drives the dispatcher's two-phase
   * endSession (§9: flip endRequested, drain in-flight reassembly, enqueue
   * `session-end` with counter snapshot). MUST be awaited BEFORE
   * `session.close()` so the manifest entry is durable even if `session.close()`
   * throws.
   *
   * No-op when capture is disabled. Always present (never optional): the
   * method is inert when the writer is undefined, so "always present,
   * sometimes a no-op" is correct, and a consumer that forgets to wire
   * capture now fails to compile rather than silently dropping it.
   */
  endCaptureSession: (sessionId: import('../session/types.js').SessionId) => Promise<void>;

  /**
   * Internal: trajectory-capture writer reference, exposed so
   * `destroyDockerInfrastructure` / `destroyWorkflowInfrastructure` can
   * call `writer.close()` as the infrastructure-teardown safety net
   * (§9). Undefined when capture is disabled. Not for orchestrator use.
   */
  readonly captureWriter?: TrajectoryCaptureWriter;

  /**
   * Present only for admitted secure nested Docker-workload bundles
   * (docs/designs/secure-nested-runtime-implementation-plan.md §8.2–8.3).
   * The host-owned lease handle: `createSessionContainers` / the PTY path
   * ledger every outer resource through it before create and observe it
   * after (§8.2 step 1); the selected backend activates it after private
   * Docker and the agent create are fully adjudicated;
   * `destroyDockerInfrastructure` tears it down first (§8.3). Undefined for
   * every ordinary session.
   */
  readonly dockerWorkload?: DockerWorkloadBundleHandle;
  /** Apple-only immutable selected-agent artifact consumed by the same-VM nested daemon. */
  readonly dockerWorkloadBootstrap?: AppleVmDockerWorkloadBootstrapConfig;
  /** Private Docker Desktop API capability exposed to the agent after sidecar adjudication. */
  readonly dockerDesktopAgentAccess?: DockerDesktopAgentAccess;
  /** One aggregate Docker Desktop envelope partitioned between sidecar and agent. */
  readonly dockerDesktopResources?: DockerDesktopResourcePartition;
  /** Exact per-bundle nested-Docker egress authorities, absent when offline. */
  readonly dockerWorkloadEgress?: DockerWorkloadEgressCollection;
  /** Package-only Docker shim, build-trust wrapper/contract, and credential-free client config. */
  readonly dockerBuildShim?: DockerBuildShimStaging;
  /** Process-scoped statistics runtime reference held for this infrastructure bundle. */
  readonly metricsRuntime?: LlmMetricsRuntimeLease;
}

export type DockerWorkloadEgressEndpoint<S> = {
  readonly listener: { stop(): Promise<void> };
  readonly snapshot: () => S;
} & ({ readonly socketPath: string; readonly port?: never } | { readonly socketPath?: never; readonly port: number });

function requireTcpEgressAddress(address: { readonly port?: number }, label: string): { readonly port: number } {
  const port = address.port;
  if (!Number.isSafeInteger(port) || port === undefined || port < 1 || port > 65_535) {
    throw new Error(`${label}-egress listener did not bind an exact TCP port`);
  }
  return { port };
}

function requireUdsEgressAddress(
  address: { readonly socketPath?: string },
  expectedPath: string,
  label: string,
): { readonly socketPath: string } {
  if (address.socketPath !== expectedPath) {
    throw new Error(`${label}-egress listener did not bind its exact per-bundle socket`);
  }
  return { socketPath: expectedPath };
}

/** Docker Desktop forwards host-gateway traffic as loopback on macOS. */
export function allowDockerDesktopRelaySource(remoteAddress: string | undefined): boolean {
  const normalized = remoteAddress?.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress;
  return normalized === '127.0.0.1' || normalized === '::1';
}

/** Bind address and connection-source guard of a TCP-mode MITM listener. */
export interface MitmTcpBind {
  readonly listenHost: string;
  readonly allowRemoteAddress: (remoteAddress: string | undefined) => boolean;
}

/**
 * Where the ordinary MITM proxy listens in a TCP topology, and who may
 * connect to it.
 *
 * - `tcp-sidecar` (Docker Desktop on macOS): the socat sidecar forwards to
 *   `host.docker.internal`, which Docker Desktop delivers to the host as
 *   loopback. The listener therefore binds `127.0.0.1`, exactly like the Code
 *   Mode proxy and the nested egress listeners on the same hop, and keeps
 *   the loopback-only source guard as defense in depth. Binding `0.0.0.0`
 *   here (the previous behavior) handed every LAN peer, and every other
 *   container on the host gateway, the session's proxy.
 * - `tcp-hostonly` (retained, not currently selected): the vmnet gateway
 *   interface does not exist until the first container attaches, so the
 *   listener binds `0.0.0.0` and admits only the bundle's host-only subnet.
 */
export function resolveMitmTcpBind(
  topology: NetworkTopology,
  hostOnlySubnetGuard: ((remoteAddress: string | undefined) => boolean) | undefined,
): MitmTcpBind {
  if (topology === 'tcp-hostonly') {
    if (hostOnlySubnetGuard === undefined) {
      throw new Error('tcp-hostonly MITM listener requires the host-only subnet connection-source guard');
    }
    return { listenHost: '0.0.0.0', allowRemoteAddress: hostOnlySubnetGuard };
  }
  return { listenHost: '127.0.0.1', allowRemoteAddress: allowDockerDesktopRelaySource };
}

const DESKTOP_REGISTRY_RELAY_PORT = 18_081;
const DESKTOP_PACKAGE_RELAY_PORT = 18_082;

function dockerDesktopRelayAddresses(
  generation: string,
  ipv4Subnet: string,
): {
  readonly ipv4Subnet: string;
  readonly ipv6Subnet: string;
  readonly registry: string;
  readonly packages: string;
} {
  const digest = createHash('sha256').update(generation).digest();
  const segment = (offset: number): string => digest.readUInt16BE(offset).toString(16);
  return {
    ipv4Subnet,
    ipv6Subnet: `fd00:1c:${segment(3)}:${segment(5)}::/64`,
    registry: ironCurtainInternalSubnetHostAddress(ipv4Subnet, 2),
    packages: ironCurtainInternalSubnetHostAddress(ipv4Subnet, 3),
  };
}

async function createDockerDesktopRelayExposureForBundle(options: {
  readonly bundleId: BundleId;
  readonly generation: string;
  readonly mode: 'images' | 'packages';
  readonly imageId: string;
  readonly egress: DockerWorkloadEgressCollection;
  readonly runtime: ContainerRuntime;
  readonly identity: ContainerIdentity;
  readonly createOuterResource: CreateDesktopRelayExposureOptions['createOuterResource'];
}): Promise<DesktopRelayExposure> {
  const authorization = options.egress.proxyAuthorization;
  if (authorization === undefined) throw new Error('Docker Desktop egress omitted its per-bundle proxy credential');
  const upstream = (endpoint: DockerWorkloadEgressEndpoint<unknown>): FixedRelayUpstream =>
    endpoint.socketPath !== undefined
      ? {
          kind: 'unix',
          socketPath: endpoint.socketPath,
          runtimeUid: options.identity.uid,
          runtimeGid: options.identity.gid,
        }
      : { kind: 'tcp', host: DESKTOP_RELAY_HOST_GATEWAY_ALIAS, port: endpoint.port };
  const shortId = getBundleShortId(options.bundleId);
  const isolatedNetworkName = `ic-dw-egress-${shortId}`;
  const ipv4Subnet = await selectIronCurtainInternalSubnet(options.runtime, isolatedNetworkName);
  const addresses = dockerDesktopRelayAddresses(options.generation, ipv4Subnet);
  if (options.runtime.dockerEndpoint === undefined)
    throw new Error('Nested Docker relay requires its captured endpoint');
  return createDesktopRelayExposure(bindDockerEndpointExec(options.runtime.dockerEndpoint, defaultExecFile), {
    bundleId: `ic-${shortId}`,
    mode: options.mode,
    imageId: options.imageId,
    isolatedNetworkName,
    ipv4Subnet: addresses.ipv4Subnet,
    ipv6Subnet: addresses.ipv6Subnet,
    requiredProxyAuthorization: authorization.header,
    registry: {
      containerName: `ic-dw-registry-${shortId}`,
      relayIpv4Address: addresses.registry,
      listenPort: DESKTOP_REGISTRY_RELAY_PORT,
      upstream: upstream(options.egress.registry),
    },
    ...(options.egress.networkAccess === 'packages'
      ? {
          package: {
            containerName: `ic-dw-package-${shortId}`,
            relayIpv4Address: addresses.packages,
            listenPort: DESKTOP_PACKAGE_RELAY_PORT,
            upstream: upstream(options.egress.packages),
          },
        }
      : {}),
    createOuterResource: options.createOuterResource,
  });
}

/** Registry and strict-package authorities are always distinct listeners/sockets. */
export type DockerWorkloadEgressCollection = DockerWorkloadEgressSet<
  DockerWorkloadEgressEndpoint<import('./docker-workload-egress.js').RegistryEgressLedgerSnapshot>,
  DockerWorkloadEgressEndpoint<import('./package-egress-ledger.js').PackageEgressLedgerSnapshot>
> & { readonly proxyAuthorization?: ProxyAuthorization };

export interface DockerBuildShimStaging {
  readonly contract: DockerBuildShimStagingContract;
  readonly artifacts: readonly DockerBuildShimStagedArtifact[];
  readonly buildTrustCanary: DockerBuildTrustCanaryContract;
}

export interface DockerBuildShimStagedArtifact {
  readonly kind:
    | 'docker-shim'
    | 'proxy-config'
    | 'build-trust-wrapper'
    | 'build-trust-real-runc'
    | 'build-trust-contract'
    | 'build-trust-ca-cert'
    | 'build-trust-ca-bundle'
    | 'build-trust-apt-config';
  readonly source: string;
  readonly target: string;
  readonly readonly: true;
}

type DockerBuildShimConsumer = 'agent' | 'private-daemon';

/**
 * Assign every staged package-mode artifact to its single consumer. Apple runs
 * daemon and agent in one VM, while Docker Desktop gives the agent only the
 * CLI shim/config and the private daemon only the runtime trust contract.
 */
function dockerBuildShimMountsForConsumer(options: {
  readonly staging: DockerBuildShimStaging;
  readonly runtimeKind: ContainerRuntimeKind;
  readonly consumer: DockerBuildShimConsumer;
  readonly privateDaemonRuncTarget?: string;
}): DockerMount[] {
  if (options.consumer === 'private-daemon' && options.runtimeKind !== 'docker') {
    throw new Error('a separate package build-trust consumer exists only on Docker Desktop');
  }
  const mounts: DockerMount[] = [];
  const needsTrust = options.consumer === 'private-daemon' || options.runtimeKind === 'apple-container';
  if (needsTrust) {
    const trust = options.staging.artifacts.find(({ kind }) => kind === 'build-trust-contract');
    if (trust === undefined) throw new Error('package build-trust staging lacks its public generation');
    if (
      options.privateDaemonRuncTarget !== undefined &&
      options.privateDaemonRuncTarget !== DOCKER_BUILD_TRUST_WRAPPER_PATH
    ) {
      throw new Error('private daemon must use the common protected runtime wrapper path');
    }
    // Mount the top-level directory itself. Individual leaves beneath a writable
    // ancestor can be bypassed by sudo renaming that ancestor without SYS_ADMIN.
    mounts.push({ source: dirname(trust.source), target: DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY, readonly: true });
  }
  for (const artifact of options.staging.artifacts) {
    const client = artifact.kind === 'docker-shim' || artifact.kind === 'proxy-config';
    if ((options.consumer === 'agent' && client) || (needsTrust && artifact.kind === 'build-trust-real-runc')) {
      mounts.push({ source: artifact.source, target: artifact.target, readonly: true });
    }
  }
  return mounts;
}

/**
 * Full Docker session infrastructure, including a running main container.
 *
 * Produced by `createDockerInfrastructure()` and consumed by
 * `DockerAgentSession`. The container is already created and started with
 * a `sleep infinity` entrypoint; the session drives it via `docker exec`.
 * In TCP mode (macOS), `sidecarContainerId` and `internalNetwork` point to
 * the socat sidecar and the per-session `--internal` bridge network.
 */
export interface DockerInfrastructure extends PreContainerInfrastructure {
  /** Main agent container ID (created + started with `sleep infinity` entrypoint). */
  readonly containerId: string;
  /** Deterministic main container name (e.g., `ironcurtain-<shortId>`). */
  readonly containerName: string;
  /** Socat sidecar container ID (TCP mode only, macOS). */
  readonly sidecarContainerId?: string;
  /** Per-session `--internal` Docker network name (TCP mode only, macOS). */
  readonly internalNetwork?: string;
  /**
   * Scanner for the agent container's read-write host mounts, present only
   * when `containerRootIsHostRoot` (see `ContainerResources`). Run after each
   * agent turn and by `destroyDockerInfrastructure`.
   */
  readonly privilegedFileScanner?: HostMountPrivilegeScanner;
  /** Why an offered workflow snapshot was not used (see `ContainerResources`). */
  readonly snapshotRefusal?: string;
}

/** Hosts that use Anthropic OAuth credentials when available. */
const ANTHROPIC_HOSTS = new Set(['api.anthropic.com', 'platform.claude.com']);
/** Hosts that use Codex ChatGPT OAuth credentials when available. */
const CODEX_CHATGPT_HOSTS = new Set(['chatgpt.com', 'auth.openai.com']);

/** Prefix for container/sidecar names. Keep in sync with `docker ps` filters. */
const CONTAINER_NAME_PREFIX = 'ironcurtain-';

const DOCKER_DESKTOP_SIDECAR_IMAGE = 'ironcurtain-nested-daemon:latest';
const DOCKER_DESKTOP_RELAY_IMAGE = 'ironcurtain-fixed-relay:latest';
/**
 * Floors of the Docker Desktop partition. CPU is counted in millicpus so every
 * share is an exact decimal that Docker's `--cpus` parser and the effective
 * `NanoCpus` comparison accept.
 */
const DOCKER_DESKTOP_MIN_SIDECAR_MEMORY_MB = 512;
const DOCKER_DESKTOP_MIN_SIDECAR_MILLICPUS = 250;
const DOCKER_DESKTOP_MIN_SIDECAR_PIDS = 256;
const DOCKER_DESKTOP_MIN_AGENT_MEMORY_MB = 512;
const DOCKER_DESKTOP_MIN_AGENT_MILLICPUS = 250;
const DOCKER_DESKTOP_MIN_AGENT_PIDS = 128;
const DOCKER_DESKTOP_RELAY_MEMORY_MB = DESKTOP_RELAY_PROFILE.memoryBytes / (1024 * 1024);
const DOCKER_DESKTOP_RELAY_MILLICPUS = DESKTOP_RELAY_PROFILE.nanoCpus / 1_000_000;

/**
 * Open-files ceiling (soft and hard) for every process in a Docker agent
 * container. Daemon defaults are typically ~1M; 64k leaves room for Node
 * toolchains and package installs while bounding descriptor exhaustion.
 * `nproc` is deliberately not set: see `DockerUlimit` in types.ts.
 */
export const AGENT_OPEN_FILES_LIMIT = 65_536;

/**
 * Fixed envelope for the macOS Docker Desktop TCP transport sidecar when no
 * nested-Docker partition applies. The sidecar runs `socat ... fork`, which
 * forks one child per agent connection; unbounded, a compromised agent could
 * open thousands of connections and exhaust the Docker Desktop VM that every
 * session shares (audit finding DINF-11).
 */
export const TRANSPORT_SIDECAR_LIMITS = Object.freeze({
  memoryMb: 64,
  cpus: 0.25,
  pidsLimit: 64,
  openFilesLimit: 256,
});

/**
 * Logged once per Linux Docker bundle when the daemon runs without rootless
 * mode or userns-remap, so container root is real host root on bind mounts.
 * Agents keep passwordless sudo inside the container by default (package
 * installs), so a compromised agent can leave root-owned setuid files in the
 * workspace and under the conversation-state mounts (audit finding DINF-3).
 * Neither rootless Docker nor userns-remap works with the Linux UID-remap
 * entrypoint yet, so this is a warning rather than a refusal; the bundle scans
 * its read-write host mounts after each turn and at teardown, and
 * `agentSudo: false` removes the agent's way to root.
 */
export const HOST_ROOT_EXPOSURE_WARNING =
  '[docker] Container root is host root on this daemon (no rootless Docker or userns-remap). Agent containers ' +
  'keep passwordless sudo, so a compromised agent can leave root-owned or setuid files in the workspace and ' +
  'conversation-state mounts. IronCurtain strips setuid/setgid bits from your files in those mounts and reports ' +
  'root-owned entries after each turn and at session end; set "agentSudo": false in ~/.ironcurtain/config.json ' +
  'to run agents without sudo (no-new-privileges). `ironcurtain doctor` reports this check.';

/** Host gateway alias used by Docker containers on macOS/Windows. */
const DOCKER_HOST_GATEWAY = 'host.docker.internal';

/** Bundle-relative subdir name for the skills staging dir. */
const BUNDLE_SKILLS_SUBDIR = 'skills';

/**
 * Prepares the shared (non-container) parts of Docker session infrastructure.
 *
 * Sets up proxies (Code Mode + MITM), CA, fake keys, orientation files, and
 * ensures the agent image. Does NOT create the agent container — that step is
 * specific to the session mode: standalone sessions go through
 * `createDockerInfrastructure()` (which wraps this with `sleep infinity`
 * container creation); PTY sessions call this directly and then create their
 * own TTY-enabled container.
 *
 * `workflowId` drives Docker labelling: when set, the main container (and
 * any sidecar created during `createSessionContainers`) carries
 * `ironcurtain.workflow=<workflowId>` + `ironcurtain.scope=<scope>`
 * alongside the always-present `ironcurtain.bundle=<bundleId>`. When
 * unset, only `ironcurtain.bundle` is emitted (standalone CLI / PTY).
 */
/**
 * Optional trajectory-capture inputs threaded through to the MITM
 * proxy. Carries the RAW CLI/RPC override — this function is the single
 * place that resolves enablement against config (`override ?? config >
 * false`), so consumers never duplicate the `?? userConfig.capture?.enabled`
 * precedence. When this object is absent, or resolution yields false, no
 * writer is constructed and no taps are installed — zero cost on the
 * forwarding path. See docs/designs/mitm-token-trajectory-capture.md.
 */
export interface CaptureSetupInput {
  /**
   * Raw CLI/RPC override (boolean | undefined); undefined falls through
   * to `config.userConfig.capture?.enabled`, then to false. The single
   * resolution point lives in `prepareDockerInfrastructure`.
   */
  readonly override?: boolean;
  /**
   * Absolute path where `{sessionId}.jsonl` and `manifest.jsonl` are
   * written. A real per-path difference (session dir vs bundle dir), so
   * the caller supplies it rather than the infra layer deriving it.
   */
  readonly capturesDir: string;
  /** Human-readable agent name (e.g. `'claude-code'`). */
  readonly recordedAgentName?: string;
  /** Workflow run ID, when this bundle belongs to a workflow run. */
  readonly workflowRunId?: WorkflowId;
}

export type AgentImageResolution = {
  readonly dockerWorkloadEnvironment?: DockerWorkloadEnvironment;
  readonly toolchainSource?: DockerToolchainSource;
  readonly mode: 'build-if-stale' | 'selected-agent-artifact';
  readonly logicalName: string;
  readonly imageRef: string;
  readonly buildHash: string;
  readonly immutableImageId?: string;
  readonly artifact?: SelectedAgentArtifact;
};

/** Revalidate immediately before every staged-script read or mount plan. */
function requireStagedWorkflowScripts(runDir: string | undefined, scriptsDir: string): string {
  const validated = runDir === undefined ? undefined : validatedWorkflowStagedDirectory(runDir, scriptsDir, 'scripts');
  if (validated === undefined) {
    throw new Error('Workflow scripts must name the run-owned workflow-scripts directory');
  }
  return validated;
}

export interface PrepareDockerInfrastructureOptions {
  readonly onHostPrivilegedFiles?: (notice: HostPrivilegedFilesDiagnostic) => void;
  /** Trusted runtime run root; never derived from a checkpoint's staged path. */
  readonly workflowRunDir?: string;
  readonly providerProfileName?: string;
  readonly preparedImageResolution?: AgentImageResolution;
  /** Explicit request-rewriter mode for this container lifecycle. */
  readonly proxyAgentKind?: AgentKind;
  /**
   * In-process escalation handler handed to the bundle's coordinator (via
   * `createCodeModeProxy`). Workflow bundles set it so escalated tool calls
   * reach the orchestrator's human route; standalone sessions leave it
   * unset and use the file-IPC escalation directory.
   */
  readonly onEscalation?: EscalationPromptFn;
  /**
   * Most agent lanes expected to share the bundle's coordinator at once
   * (handed to `createCodeModeProxy`). Workflow bundles whose scope runs a
   * fan-out set it to the widest fan-out; everything else leaves it unset.
   */
  readonly maxLanes?: number;
  /**
   * Target of the bundle coordinator's `workflow_commit` tool (via
   * `createCodeModeProxy`). Set by the workflow orchestrator only: a
   * workflow bundle's channel, or a per-state channel for a workflow state
   * that owns its container. Every other session leaves it unset.
   */
  readonly workflowCommit?: WorkflowCommitHandler;
}

export async function prepareDockerInfrastructure(
  config: IronCurtainConfig,
  mode: SessionMode & { kind: 'docker' },
  bundleDir: string,
  workspaceDir: string,
  escalationDir: string,
  bundleId: BundleId,
  workflowId?: WorkflowId,
  scope?: string,
  resolvedSkills?: readonly ResolvedSkill[],
  captureInput?: CaptureSetupInput,
  scriptsDir?: string,
  options: PrepareDockerInfrastructureOptions = {},
): Promise<PreContainerInfrastructure> {
  const { providerProfileName, preparedImageResolution, proxyAgentKind, onEscalation, maxLanes, workflowCommit } =
    options;
  const workflowRunDir =
    options.workflowRunDir ?? (workflowId === undefined ? undefined : getWorkflowRunDir(workflowId));
  const stagedScriptsDir =
    scriptsDir === undefined ? undefined : requireStagedWorkflowScripts(workflowRunDir, scriptsDir);
  // A read-only workspace never runs with nested Docker, whose daemon would
  // mount the workspace read-write (applyReadOnlyWorkspace switches it off).
  assertReadOnlyWorkspaceSupported(config);
  // Secure nested Docker resolves the effective runtime and rejects every
  // unsupported variant before feature-attributable runtime, image, artifact,
  // proxy, lease, or filesystem provisioning. Runtime resolution is a
  // read-only probe; ordinary CLI credential preflight is outside this seam.
  // Keep the feature-off path's historical profile/adapter/runtime ordering.
  const admitted = await resolveAdmittedDockerWorkload(
    config.userConfig,
    preparedImageResolution?.dockerWorkloadEnvironment,
  );
  // Workflow runtime dependencies are read once here: the content key hashes
  // these exact bytes and the provisioning container installs them. A
  // workflow whose dependencies cannot be provisioned fails before any proxy,
  // lease, or container work.
  const workflowDependencyManifests = readWorkflowDependencyManifests(stagedScriptsDir);
  if (workflowDependencyManifests !== undefined) {
    assertWorkflowDependencyProvisioningAvailable({
      packageInstallEnabled: config.userConfig.packageInstall.enabled,
      nestedDockerAdmitted: admitted !== undefined,
    });
  }
  const admittedEnvironment = admitted?.environment;
  const admittedRuntimeKind =
    admittedEnvironment === undefined ? undefined : dockerWorkloadRuntimeKind(admittedEnvironment);
  let dockerDesktopResources: DockerDesktopResourcePartition | undefined;
  if (admittedRuntimeKind !== undefined) {
    if (admittedRuntimeKind === 'docker') {
      dockerDesktopResources = selectDockerDesktopResourcePartition(
        config.userConfig,
        dockerDesktopVmCapacity(admittedEnvironment),
        admittedEnvironment?.egressTransport === 'tcp',
      );
    }
    const nestedDockerStatus = formatDockerWorkloadStatus(config.userConfig.dockerWorkload);
    if (nestedDockerStatus) logger.info(nestedDockerStatus);
  }

  // Resolve and STAMP the active provider profile before adapter registration
  // or auth detection (§9.7 F1). This ordering is load-bearing: Claude Code's
  // detectCredential(config) reads config.activeProviderProfile to return an
  // API-key AuthMethod for an OpenRouter-only user, so the stamp must already
  // be present when auth detection runs below. An unknown providerProfileName
  // throws a clear error listing the available profiles before any expensive
  // work or container launch. Safe to mutate: callers always pass a
  // session-specific config copy (the same invariant the config.dockerAuth
  // stamp below relies on).
  const activeProfile = resolveActiveProfile(config.userConfig.modelProviders, providerProfileName);
  const providerProfileId = providerProfileName ?? config.userConfig.modelProviders.default;
  config.activeProviderProfile = activeProfile;
  if (activeProfile.type !== 'native' && activeProfile.apiKey === '') {
    throw new Error(
      `Provider profile "${providerProfileId}" is ${getGatewayDefinition(activeProfile.type).label} but no API key is configured. ` +
        `Set ${getGatewayDefinition(activeProfile.type).editor.credentialEnv} or the profile's apiKey in ~/.ironcurtain/config.json.`,
    );
  }

  // The audit log path is read from config so the bundle is
  // self-describing: downstream consumers (AuditLogTailer, sandbox
  // coordinator) can take it from either `config.auditLogPath` or
  // `infra.auditLogPath` without chasing references.
  const auditLogPath = config.auditLogPath;
  // Dynamic imports to avoid loading Docker dependencies for built-in sessions
  const { registerBuiltinAdapters, getAgent } = await import('./agent-registry.js');
  const { createCodeModeProxy } = await import('./code-mode-proxy.js');
  const { createMitmProxy } = await import('./mitm-proxy.js');
  const { loadOrCreateCA } = await import('./ca.js');
  const { generateFakeKey } = await import('./fake-keys.js');
  const { createContainerRuntime, resolveRuntimeKind } = await import('./container-runtime.js');
  const { resolveNetworkTopology, createHostOnlyNetwork, makeSourceAddressGuard } =
    await import('./network-topology.js');
  const { getIronCurtainHome } = await import('../config/paths.js');
  const { prepareSession } = await import('./orientation.js');

  const {
    detectAuthMethod,
    writeToKeychain,
    getCodexAuthFilePath,
    loadCodexOAuthCredentials,
    refreshCodexOAuthToken,
    refreshResultToCreds,
    saveCodexOAuthCredentials,
  } = await import('./oauth-credentials.js');
  const { OAuthTokenManager } = await import('./oauth-token-manager.js');
  const {
    getBundleSocketsDir,
    getBundleHostOnlyDir,
    getBundleProxySocketPath,
    getBundleMitmProxySocketPath,
    getBundleMitmControlSocketPath,
    getBundleRegistryEgressSocketPath,
    getBundlePackageEgressSocketPath,
  } = await import('../config/paths.js');

  // Adapters read every session-specific value from `config` per call.
  await registerBuiltinAdapters();
  const adapter = getAgent(mode.agent);
  const runtimeKind = admittedRuntimeKind ?? (await resolveRuntimeKind(config.userConfig.containerRuntime));
  const topology = resolveNetworkTopology(
    runtimeKind,
    admittedEnvironment === undefined ? undefined : admittedEnvironment.egressTransport === 'tcp',
  );
  const useTcp = topology !== 'uds';
  // Fail fast on a root host identity before credentials, proxies, image
  // preparation, or any container work (see assertLinuxDockerHostIdentity).
  assertLinuxDockerHostIdentity(runtimeKind, useTcp);
  // Likewise refuse an `agentSudo: false` this runtime cannot enforce (see
  // agent-privileges.ts) before any credential, proxy, image or container
  // work. The same plan later sets the container's create flags.
  const agentPrivileges = planAgentContainerPrivileges({
    runtimeKind,
    useTcp,
    agentSudo: isAgentSudoEnabled(config.userConfig),
    nestedDocker: admitted !== undefined,
  });

  // Detect authentication method. Adapters with detectCredential() handle
  // their own credential detection (e.g., Goose checks provider-specific keys;
  // Claude Code returns an api-key AuthMethod for an OpenRouter-only profile).
  // A `detectCredential` that returns `undefined` DEFERS to detectAuthMethod()
  // (Anthropic OAuth + API key) — this is how Claude Code preserves today's
  // detection for a native profile (B2a). Adapters without the method also
  // fall back.
  const detected = adapter.detectCredential?.(config);
  const authMethod = detected ?? (await detectAuthMethod(config));
  if (authMethod.kind === 'none') {
    throw new Error(
      adapter.credentialHelpText?.(config) ??
        'No credentials available for Docker session. ' +
          'Log in with `claude login` (OAuth) or set ANTHROPIC_API_KEY.',
    );
  }
  const authKind = authMethod.kind;

  // Stamp auth kind onto the caller's session config so buildEnv() can read it.
  // Safe to mutate: callers always pass a session-specific copy.
  config.dockerAuth = { kind: authKind };

  // Host-side UDS endpoints must fit under `sockaddr_un.sun_path`
  // (macOS ~104 / Linux ~108 bytes). The historical layout
  // (`<bundleDir>/sockets/proxy.sock` etc.) overflows that budget on
  // Linux for any realistic `$HOME` because `<bundleDir>` itself is
  // `~/.ironcurtain/workflow-runs/<36-char wfId>/containers/<36-char
  // bundleId>/bundle/` — ~95 chars before any filename. Route through
  // `getBundleSocketsDir(bundleId)` / `getBundleHostOnlyDir(bundleId)`
  // (both under `~/.ironcurtain/run/<bid12>/`) so every assembled path
  // stays well under the cap even with a 20-char username.
  // Harden the runtime root FIRST: `ensureSecureBundleDir` rejects a
  // pre-existing symlink at that path. If we only checked the children
  // (`sockets/`, `host/`) an attacker who planted a symlink at the
  // runtime root would silently redirect them. The root's ancestors
  // (`~/.ironcurtain/run/`, `~/.ironcurtain/`) are the user's trust
  // boundary and intentionally not walked.
  ensureSecureBundleDir(getBundleRuntimeRoot(bundleId));
  const socketsDir = getBundleSocketsDir(bundleId);
  const hostOnlyDir = getBundleHostOnlyDir(bundleId);
  ensureSecureBundleDir(socketsDir);
  ensureSecureBundleDir(hostOnlyDir);

  const socketPath = getBundleProxySocketPath(bundleId);

  // A sudo-off agent is exec'd into by numeric UID, never by an image-mapped
  // account name (see AgentContainerPrivilegePlan.execUser).
  const docker = createContainerRuntime(runtimeKind, admittedEnvironment?.dockerEndpoint, {
    defaultExecUser: agentPrivileges.execUser,
  });
  // Disclose, once per bundle, when container root is real host root on this
  // daemon. Read-only probe; a nested-Docker admission already recorded the
  // outer daemon's facts. Such bundles scan their read-write host mounts for
  // setuid/setgid and root-owned entries after each turn and at teardown; an
  // unreadable classification is treated as host root.
  let containerRootIsHostRoot = false;
  if (runtimeKind === 'docker' && !useTcp) {
    const userNamespace = await warnWhenContainerRootIsHostRoot(
      admittedEnvironment?.server,
      undefined,
      agentPrivileges.agentSudo,
    );
    containerRootIsHostRoot = userNamespace === undefined || userNamespace === 'host-root';
  }

  // §8.2 step 1: admit the secure nested Docker-workload bundle — create its
  // host-owned lease before any proxy or outer resource is created. Placed
  // here (after the runtime is resolved, before proxy startup) so the §8.2
  // ordering "lease -> proxies -> watchdog attestation" holds. The
  // resolved-variant guard above limits this production path to an admitted
  // backend/mode. `attestWatchdog()` (§8.2 step 3) is driven after the proxies
  // start, below.
  const dockerWorkloadConfig = admitted?.configuration;
  const containerIdentity = resolveContainerIdentity(runtimeKind === 'docker' && !useTcp);
  let dockerWorkloadAgentImage: string | undefined;
  let dockerWorkloadImageResolution: AgentImageResolution | undefined;
  let dockerDesktopSidecarImage: DockerDesktopSidecarImage | undefined;
  let dockerDesktopRelayImageId: string | undefined;
  let admittedDockerWorkload:
    | { readonly handle: DockerWorkloadBundleHandle; readonly bootstrap?: AppleVmDockerWorkloadBootstrapConfig }
    | undefined;
  // Resolved once per admission: every nested staging path below the home is
  // canonicalized against this one real path (see canonical-home.ts).
  let nestedStagingHome: CanonicalIronCurtainHome | undefined;
  if (admitted !== undefined) {
    const { environment, configuration } = admitted;
    nestedStagingHome = resolveCanonicalIronCurtainHome();
    const toolchainSource =
      preparedImageResolution?.toolchainSource ??
      (await resolveDockerToolchainSource(docker, environment.architecture));
    if (toolchainSource.architecture !== environment.architecture)
      throw new Error('Prepared Docker toolchain platform changed');
    if (runtimeKind === 'docker') {
      dockerDesktopSidecarImage = await ensureDockerDesktopSidecarImage(docker, toolchainSource);
      if (configuration.networkAccess !== 'offline') {
        dockerDesktopRelayImageId = await ensureDockerDesktopRelayImage(docker);
      }
    }
    dockerWorkloadAgentImage = await adapter.getImage();
    dockerWorkloadImageResolution = preparedImageResolution;
    if (dockerWorkloadImageResolution === undefined) {
      const built = await resolveAgentImage(
        dockerWorkloadAgentImage,
        docker,
        toolchainSource,
        agentImageBuildOptions(adapter, config.userConfig),
      );
      dockerWorkloadImageResolution =
        runtimeKind === 'apple-container'
          ? selectedAgentImageResolution(
              built,
              await prepareSelectedAgentArtifact({
                runtime: docker,
                logicalName: dockerWorkloadAgentImage,
                buildHash: built.buildHash,
              }),
            )
          : await immutableAgentImageResolution(built, docker);
    }
    assertPreparedImageResolution(dockerWorkloadImageResolution, dockerWorkloadAgentImage, runtimeKind);
    const artifact = dockerWorkloadImageResolution.artifact;
    admittedDockerWorkload = await admitDockerWorkloadForSession({
      dockerWorkload: configuration,
      runtime: docker,
      runtimeKind,
      bundleId,
      workspaceRoot: workspaceDir,
      auditLogPath,
      home: nestedStagingHome,
      ...(artifact === undefined ? {} : { artifact }),
    });
  }
  const dockerWorkload = admittedDockerWorkload?.handle;
  const dockerWorkloadBootstrap = admittedDockerWorkload?.bootstrap;

  // From this point onward every failure must revoke the admitted lease and
  // its immutable staging view. Keep the cleanup boundary outside network,
  // credential, provider, and proxy setup so no pre-attestation error can
  // strand a fresh lease.
  let hostOnlyNetwork: HostOnlyNetwork | undefined;
  const tcpTransport =
    topology === 'tcp-sidecar'
      ? { mcpToken: randomBytes(32).toString('hex'), proxyAuthorization: createProxyAuthorization() }
      : undefined;
  let proxy: DockerProxy | undefined;
  let mitmProxy: MitmProxy | undefined;
  let metricsRuntime: LlmMetricsRuntimeLease | undefined;
  let dockerWorkloadEgress: DockerWorkloadEgressCollection | undefined;
  let dockerBuildShim: DockerBuildShimStaging | undefined;
  let dockerDesktopAgentAccess: DockerDesktopAgentAccess | undefined;
  let dockerDesktopRelayExposure: DesktopRelayExposure | undefined;
  try {
    // tcp-hostonly: create the per-bundle host-only network BEFORE the
    // proxies are constructed. The gateway address feeds the container env,
    // the orientation proxy address, and the connection-source guard both
    // proxies use while listening on 0.0.0.0 (the vmnet gateway interface
    // only materializes once the first container attaches, so binding the
    // gateway address directly is not possible at this point).
    let allowRemoteAddress: ((remoteAddress: string | undefined) => boolean) | undefined;
    if (topology === 'tcp-hostonly') {
      hostOnlyNetwork = await createHostOnlyNetwork(docker, getInternalNetworkName(getBundleShortId(bundleId)));
      allowRemoteAddress = makeSourceAddressGuard(hostOnlyNetwork.subnet);
      logger.info(
        `Host-only network ${hostOnlyNetwork.name} (${hostOnlyNetwork.subnet}, gateway ${hostOnlyNetwork.gateway})`,
      );
    }

    // Load or generate the IronCurtain CA for TLS termination
    const caDir = resolve(getIronCurtainHome(), 'ca');
    const ca = loadOrCreateCA(caDir);
    const transportTls = tcpTransport === undefined ? undefined : await createTcpTransportTlsOptions(ca);

    proxy = createCodeModeProxy({
      socketPath,
      config,
      listenMode: useTcp ? 'tcp' : 'uds',
      bindHost: topology === 'tcp-hostonly' ? '0.0.0.0' : undefined,
      allowRemoteAddress,
      requiredTcpToken: tcpTransport?.mcpToken,
      tls: transportTls,
      onEscalation,
      maxLanes,
      ...(workflowCommit ? { workflowCommit } : {}),
    });

    // Resolve package policy exactly once. The strict nested package listener
    // and ordinary package-install proxy, when enabled, share this immutable
    // validator instead of constructing policy twice with potentially drifting
    // clocks or settings.
    const pkgConfig = config.userConfig.packageInstall;
    const packageMode = dockerWorkloadConfig?.enabled === true && dockerWorkloadConfig.networkAccess === 'packages';
    let registries: import('./package-types.js').RegistryConfig[] | undefined;
    let packageValidation:
      { validator: import('./package-types.js').PackageValidator; auditLogPath: string } | undefined;
    let packagePolicy: import('./package-egress-proxy.js').PackageEgressPolicy | undefined;
    if (pkgConfig.enabled) {
      const { createPackageValidator } = await import('./package-validator.js');
      const validator = createPackageValidator({
        allowedPackages: pkgConfig.allowedPackages,
        deniedPackages: pkgConfig.deniedPackages,
        quarantineDays: pkgConfig.quarantineDays,
      });
      const packageAuditLogPath = resolve(bundleDir, 'package-audit.jsonl');
      const { npmRegistry, pypiRegistry, debianRegistry, cargoRegistry } = await import('./registry-proxy.js');
      registries = [npmRegistry, pypiRegistry, debianRegistry, cargoRegistry];
      packageValidation = { validator, auditLogPath: packageAuditLogPath };
      if (packageMode) packagePolicy = { validator };
    }

    if (dockerWorkloadConfig?.enabled === true) {
      if (dockerWorkload === undefined) throw new Error('nested-Docker egress requires an admitted lease');
      const provenanceLease = dockerWorkload;
      const { createDockerWorkloadEgressListeners } = await import('./docker-workload-egress.js');
      const { PACKAGE_EGRESS_AUDIT_FILENAME } = await import('./package-egress-proxy.js');
      const { createDirectOutboundTransport } = await import('./outbound-transport.js');
      const registrySocketPath =
        runtimeKind === 'docker'
          ? resolve(hostOnlyDir, 'registry-egress.sock')
          : getBundleRegistryEgressSocketPath(bundleId);
      const packageSocketPath =
        runtimeKind === 'docker'
          ? resolve(hostOnlyDir, 'package-egress.sock')
          : getBundlePackageEgressSocketPath(bundleId);
      const desktopTcp = runtimeKind === 'docker' && useTcp;
      const proxyAuthorization = runtimeKind === 'docker' ? createProxyAuthorization() : undefined;
      const registryListen = desktopTcp ? ({ listenPort: 0 } as const) : ({ socketPath: registrySocketPath } as const);
      const packageListen = desktopTcp ? ({ listenPort: 0 } as const) : ({ socketPath: packageSocketPath } as const);
      const listeners = createDockerWorkloadEgressListeners({
        workload: dockerWorkloadConfig,
        ca,
        outboundTransport: createDirectOutboundTransport(),
        registryListen,
        ...(packageMode ? { packageListen } : {}),
        ...(desktopTcp ? { allowRemoteAddress: allowDockerDesktopRelaySource } : {}),
        ...(proxyAuthorization === undefined ? {} : { requiredProxyAuthorization: proxyAuthorization.header }),
        packagePolicy,
        ...(packageMode ? { packageAuditLogPath: resolve(bundleDir, PACKAGE_EGRESS_AUDIT_FILENAME) } : {}),
        // Every completed pull lands in the lease's durable provenance log.
        recordRegistryPullProvenance: (record) => provenanceLease.recordRegistryPull(record),
      });
      if (listeners !== undefined) {
        try {
          const registryAddr = await listeners.registry.listener.start();
          const registryEndpoint = desktopTcp
            ? requireTcpEgressAddress(registryAddr, 'registry')
            : requireUdsEgressAddress(registryAddr, registrySocketPath, 'registry');
          if (listeners.networkAccess === 'images') {
            dockerWorkloadEgress = {
              networkAccess: 'images',
              registry: { ...listeners.registry, ...registryEndpoint },
              ...(proxyAuthorization === undefined ? {} : { proxyAuthorization }),
            };
          } else {
            const packageAddr = await listeners.packages.listener.start(listeners.packages.listenTarget);
            const packageEndpoint = desktopTcp
              ? requireTcpEgressAddress(packageAddr, 'package')
              : requireUdsEgressAddress(packageAddr, packageSocketPath, 'package');
            dockerWorkloadEgress = {
              networkAccess: 'packages',
              registry: { ...listeners.registry, ...registryEndpoint },
              packages: { ...listeners.packages, ...packageEndpoint },
              ...(proxyAuthorization === undefined ? {} : { proxyAuthorization }),
            };
          }
        } catch (error) {
          const failures: unknown[] = [error];
          try {
            await stopDockerWorkloadEgress(listeners);
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
          if (failures.length > 1) {
            throw new AggregateError(failures, 'nested-Docker egress startup and rollback failed', { cause: error });
          }
          throw error;
        }
        // The host parent is 0700. Apple presents root-owned guest sockets, so
        // the non-root runtime user needs each mounted socket's "other" write
        // bit. Apply modes only after every enabled listener has bound and its
        // returned path has been verified.
        if (runtimeKind === 'apple-container') {
          chmodSync(registrySocketPath, 0o666);
          if (listeners.networkAccess === 'packages') chmodSync(packageSocketPath, 0o666);
        } else if (!desktopTcp) {
          chmodSync(registrySocketPath, 0o600);
          if (listeners.networkAccess === 'packages') chmodSync(packageSocketPath, 0o600);
        }
      }
    }

    // Generate fake keys and build provider key mappings.
    // In OAuth mode, use bearer-based providers and the OAuth access token as the real key.
    // Providers sharing the same fakeKeyPrefix (and thus the same real credential)
    // reuse the same fake key so a single container token authenticates against all hosts.
    const oauthAccessToken = authMethod.kind === 'oauth' ? authMethod.credentials.accessToken : undefined;
    // Re-reads and refresh write-backs must target the file the credentials
    // were detected in — writing a rotated refresh token to the wrong file
    // would strand the host's Claude Code login with an invalidated token.
    const tokenManagerFileDeps =
      authMethod.kind === 'oauth' && authMethod.source === 'file' && authMethod.filePath
        ? { credentialsFilePath: authMethod.filePath }
        : undefined;
    const tokenManagerKeychainDeps =
      authMethod.kind === 'oauth' && authMethod.source === 'keychain'
        ? { writeToKeychain, keychainServiceName: authMethod.keychainServiceName }
        : undefined;
    const tokenManagerCodexDeps =
      authMethod.kind === 'oauth' && adapter.id === 'codex'
        ? {
            loadCredentials: loadCodexOAuthCredentials,
            refreshToken: async (rt: string) => refreshResultToCreds(await refreshCodexOAuthToken(rt)),
            saveCredentials: saveCodexOAuthCredentials,
            credentialsFilePath: getCodexAuthFilePath(),
          }
        : undefined;
    const tokenManager =
      authMethod.kind === 'oauth'
        ? new OAuthTokenManager(
            authMethod.credentials,
            { canRefresh: canRefreshOAuth(authMethod.credentials.refreshToken) },
            {
              ...tokenManagerFileDeps,
              ...tokenManagerKeychainDeps,
              ...tokenManagerCodexDeps,
            },
          )
        : undefined;
    const providers = adapter.getProviders(config, authKind);

    const resolvedProviders = applyUpstreamOverrides(providers, parseUpstreamBaseUrl, {
      'api.anthropic.com': config.userConfig.anthropicBaseUrl,
      'api.openai.com': config.userConfig.openaiBaseUrl,
      'generativelanguage.googleapis.com': config.userConfig.googleBaseUrl,
    });

    const fakeKeys = new Map<string, string>();
    const providerMappings: ProviderKeyMapping[] = [];
    const fakeKeysByPrefix = new Map<string, string>();
    for (const providerConfig of resolvedProviders) {
      let fakeKey = fakeKeysByPrefix.get(providerConfig.fakeKeyPrefix);
      if (!fakeKey) {
        fakeKey = generateFakeKey(providerConfig.fakeKeyPrefix);
        fakeKeysByPrefix.set(providerConfig.fakeKeyPrefix, fakeKey);
      }
      fakeKeys.set(providerConfig.host, fakeKey);

      const realKey = resolveRealKey(providerConfig.host, config, oauthAccessToken);
      const isManagedOAuthHost =
        ANTHROPIC_HOSTS.has(providerConfig.host) ||
        (adapter.id === 'codex' && CODEX_CHATGPT_HOSTS.has(providerConfig.host));
      const hostTokenManager = tokenManager && isManagedOAuthHost ? tokenManager : undefined;
      providerMappings.push({ config: providerConfig, fakeKey, realKey, tokenManager: hostTokenManager });
    }

    // Initial token-stream routing id. Single-session mode: bundleId is
    // the session id, so the bridge subscribes under the same key.
    // Workflow shared-container mode: the orchestrator overrides this
    // per-agent via setTokenSessionId() around each executeAgentState,
    // so the bundleId default is only an initial placeholder. Double-cast
    // bridges the BundleId → SessionId brand gap on MitmProxyOptions.
    const routingId = bundleId as unknown as SessionId;
    // The proxy execution mode is immutable over a bundle's lifetime. Legacy
    // direct callers that omit it still identify workflow bundles via their
    // workflow ID; otherwise they get the conservative undefined behavior.
    const agentKind: AgentKind | undefined = proxyAgentKind ?? (workflowId !== undefined ? 'workflow' : undefined);

    // Single resolution point for trajectory-capture enablement. The raw
    // CLI/RPC override wins; otherwise fall through to config; otherwise
    // off. Consumers pass the raw override only — they never re-resolve
    // against `userConfig.capture?.enabled`.
    const captureEnabled = captureInput
      ? (captureInput.override ?? config.userConfig.capture?.enabled ?? false)
      : false;
    const metricsCapable =
      config.userConfig.statistics.enabled &&
      providerMappings.some((mapping) => hasMetricsCapableCompletionEndpoint(mapping.config.completionEndpoints));

    // Construct the trajectory-capture writer when capture is enabled.
    // When disabled, no writer is created, no taps are installed, and the
    // forwarding path is byte-identical to today (per §10 "zero cost when
    // disabled").
    let captureWriter: TrajectoryCaptureWriter | undefined;
    if (captureEnabled && captureInput) {
      const { createTrajectoryCaptureWriter } = await import('./trajectory-capture.js');
      captureWriter = createTrajectoryCaptureWriter({ capturesDir: captureInput.capturesDir });
    }

    const proxyAttributionOptions = {
      recordedAgentName: captureInput?.recordedAgentName ?? adapter.id,
      workflowRunId: captureInput?.workflowRunId ?? workflowId,
      bundleId: String(bundleId),
      providerProfileId,
    };
    // One budget per bundle, enforced by its MITM proxy on every completion
    // request whatever proxy credential it carries, and independent of
    // statistics persistence. Its limits are this bundle's config: the
    // session's for standalone and PTY bundles, the workflow's effective
    // budget for a shared workflow bundle (all of its lanes together).
    const budgetGate = createBudgetGate(budgetGateOptionsFor(config.userConfig, agentKind, getBundleShortId(bundleId)));
    const captureProxyOptions = captureWriter ? { capture: captureWriter } : {};
    // Opt-in policy-evaluated egress (docs/designs/mitm-egress-policy.md):
    // destinations that are neither providers nor registries are decided by
    // the sandbox's coordinator, attached below once the Code Mode proxy is up.
    const policyEvaluatedEgress = config.userConfig.egressPolicy?.enabled === true;
    const egressProxyOptions = policyEvaluatedEgress ? { policyEvaluatedEgress: true } : {};

    const mitmTcpBind = useTcp ? resolveMitmTcpBind(topology, allowRemoteAddress) : undefined;
    const activeMitmProxy = mitmTcpBind
      ? createMitmProxy({
          listenPort: 0,
          listenHost: mitmTcpBind.listenHost,
          ca,
          providers: providerMappings,
          registries,
          packageValidation,
          controlPort: 0,
          initialTokenSessionId: routingId,
          agentKind,
          allowRemoteAddress: mitmTcpBind.allowRemoteAddress,
          requiredProxyAuthorization: tcpTransport?.proxyAuthorization.header,
          transportTls,
          statisticsEnabled: metricsCapable,
          budgetGate,
          ...proxyAttributionOptions,
          ...captureProxyOptions,
          ...egressProxyOptions,
        })
      : createMitmProxy({
          socketPath: getBundleMitmProxySocketPath(bundleId),
          ca,
          providers: providerMappings,
          registries,
          packageValidation,
          controlSocketPath: getBundleMitmControlSocketPath(bundleId),
          initialTokenSessionId: routingId,
          agentKind,
          statisticsEnabled: metricsCapable,
          budgetGate,
          ...proxyAttributionOptions,
          ...captureProxyOptions,
          ...egressProxyOptions,
        });
    mitmProxy = activeMitmProxy;

    // Start MITM proxy FIRST so config.mitmControlAddr is set before proxy.start().
    // proxy.start() initializes the UTCP sandbox, which checks config.mitmControlAddr
    // to decide whether to register the proxy virtual MCP server for domain management.
    const mitmAddr = await activeMitmProxy.start();
    if (mitmAddr.port !== undefined) {
      logger.info(
        hostOnlyNetwork
          ? `MITM proxy listening on ${hostOnlyNetwork.gateway}:${mitmAddr.port} (0.0.0.0, subnet-guarded)`
          : `MITM proxy listening on ${mitmAddr.host ?? mitmTcpBind?.listenHost ?? '127.0.0.1'}:${mitmAddr.port} ` +
              '(loopback, Docker Desktop host-gateway sources only)',
      );
    } else {
      logger.info(`MITM proxy listening on ${mitmAddr.socketPath}`);
    }
    const metricsProxyUrl =
      topology === 'tcp-hostonly'
        ? `http://${hostOnlyNetwork?.gateway ?? '127.0.0.1'}:${mitmAddr.port ?? 0}`
        : topology === 'tcp-sidecar'
          ? tcpSidecarProxyUrl({ topology, tcpTransport }, mitmAddr.port ?? 0)
          : 'http://127.0.0.1:18080';
    // apple-container's `-v <sock>` vsock relay propagates the host
    // socket's mode bits to the guest side (owner is always root there),
    // so the non-root `codespace` user can only connect() when "other"
    // has write. The parent `sockets/` dir is 0o700, so widening the
    // socket mode does not expose it to other host users.
    if (!useTcp && runtimeKind === 'apple-container' && mitmAddr.socketPath !== undefined) {
      chmodSync(mitmAddr.socketPath, 0o666);
    }

    // Compute control address for the proxy tools MCP server instance
    const controlAddr =
      mitmAddr.controlPort !== undefined
        ? `http://127.0.0.1:${mitmAddr.controlPort}`
        : mitmAddr.controlSocketPath
          ? `unix://${mitmAddr.controlSocketPath}`
          : undefined;
    if (controlAddr) {
      config.mitmControlAddr = controlAddr;
      // The control API answers only requests carrying this per-bundle token;
      // it reaches the in-process control client and the virtual proxy-tool
      // relay through the config, never the container.
      config.mitmControlToken = mitmAddr.controlToken;
      logger.info(`MITM control API at ${controlAddr}`);
    }

    // Start Code Mode proxy AFTER mitmControlAddr is set so the sandbox
    // registers the proxy virtual server for network domain management.
    await proxy.start();

    // Policy-evaluated egress: the sandbox's coordinator now exists, so the
    // MITM can ask it. Until this point the MITM refused every destination
    // that needs a decision (no container is running yet anyway); failing
    // here, rather than running without a decider, keeps that fail-closed.
    if (policyEvaluatedEgress) {
      const egressAuthorizer = proxy.getEgressAuthorizer?.() ?? null;
      if (egressAuthorizer === null) {
        throw new Error('egressPolicy is enabled but the session coordinator offers no egress authorizer');
      }
      activeMitmProxy.setEgressAuthorizer(egressAuthorizer);
      logger.info('MITM egress: destinations outside the provider and registry allowlists are policy-evaluated');
      if (config.userConfig.egressPolicy?.allowedHosts.includes('*') === true) {
        logger.warn(
          'MITM egress: egressPolicy.allowedHosts contains "*": every host name on ports 443 and 80 is ' +
            'reachable without approval (each decision is still audited)',
        );
      }
    }
    if (useTcp && proxy.port !== undefined) {
      logger.info(
        hostOnlyNetwork
          ? `Code Mode proxy listening on ${hostOnlyNetwork.gateway}:${proxy.port} (0.0.0.0, subnet-guarded)`
          : `Code Mode proxy listening on 127.0.0.1:${proxy.port}`,
      );
    } else {
      logger.info(`Code Mode proxy listening on ${proxy.socketPath}`);
    }
    if (!useTcp && runtimeKind === 'apple-container') {
      chmodSync(socketPath, 0o666);
    }

    if (metricsCapable) {
      try {
        metricsRuntime = await acquireLlmMetricsRuntime({
          retentionDays: config.userConfig.statistics.retentionDays,
        });
      } catch (error) {
        logger.warn(`LLM statistics persistence unavailable: ${errorMessage(error)}`);
      }
    }

    // §8.2 step 3: attest the host watchdog now that the outer proxies are up.
    // No-op unless a Docker-workload bundle was admitted above. Everything
    // from here on is covered by the catch below,
    // which tears the admitted lease down — see the note there for why crash
    // reconciliation cannot be relied on for a post-attestation failure.
    await dockerWorkload?.attestWatchdog();

    // Public trust is shared by the agent and, for Docker Desktop network
    // modes, the private daemon. Stage it once before either container is
    // created; prepareSession below adds the adapter files to the same
    // read-only orientation directory.
    const orientationDir = resolve(bundleDir, 'orientation');
    mkdirSync(orientationDir, { recursive: true });
    stageRuntimeTrust(orientationDir, ca.certPem);

    if (
      runtimeKind === 'docker' &&
      dockerWorkload !== undefined &&
      dockerWorkloadConfig?.enabled === true &&
      dockerWorkloadConfig.networkAccess !== 'offline'
    ) {
      if (dockerDesktopRelayImageId === undefined || dockerWorkloadEgress === undefined) {
        throw new Error('Docker Desktop network egress is missing its fixed relay image or host authorities');
      }
      dockerDesktopRelayExposure = await createDockerDesktopRelayExposureForBundle({
        bundleId,
        generation: dockerWorkload.generation,
        mode: dockerWorkloadConfig.networkAccess,
        imageId: dockerDesktopRelayImageId,
        egress: dockerWorkloadEgress,
        runtime: docker,
        identity: containerIdentity,
        createOuterResource: (spec, create) => ledgerOuterResourceCreate(dockerWorkload, spec, create),
      });
    }

    if (admitted !== undefined) {
      const { environment, configuration } = admitted;
      const packageProxyUrl =
        runtimeKind === 'docker' ? dockerDesktopRelayExposure?.package?.proxyUrl : APPLE_VM_PACKAGE_EGRESS_PROXY_URL;
      const registryProxyUrl =
        runtimeKind === 'docker' ? dockerDesktopRelayExposure?.registry.proxyUrl : APPLE_VM_REGISTRY_EGRESS_PROXY_URL;
      let protectedRealRunc: Buffer | undefined;
      if (runtimeKind === 'apple-container' && configuration.networkAccess === 'packages') {
        const artifact = dockerWorkloadImageResolution?.artifact;
        if (artifact === undefined) throw new Error('Apple package builds require the selected image artifact');
        const { readSelectedImageRealRunc } = await import('./selected-image-file.js');
        protectedRealRunc = await readSelectedImageRealRunc(artifact);
      }
      dockerBuildShim = stageDockerBuildShim(bundleId, configuration.networkAccess, {
        ...(protectedRealRunc === undefined ? {} : { protectedRealRunc }),
        orientationDir,
        caGeneration: ca.generation,
        runtimeKind,
        architecture: environment.architecture,
        ...containerIdentity,
        ...(packageProxyUrl === undefined ? {} : { packageProxyUrl }),
        ...(registryProxyUrl === undefined ? {} : { registryProxyUrl }),
      });
      if ((configuration.networkAccess === 'packages') !== (dockerBuildShim !== undefined)) {
        throw new Error('nested-Docker package build staging did not match the resolved network access');
      }
    }

    if (runtimeKind === 'docker' && dockerWorkload !== undefined && admitted !== undefined) {
      if (
        dockerDesktopSidecarImage === undefined ||
        dockerDesktopResources === undefined ||
        dockerWorkloadImageResolution?.immutableImageId === undefined ||
        nestedStagingHome === undefined
      ) {
        throw new Error(
          'Docker Desktop nested-Docker preparation is missing its daemon image, immutable agent image, resources, or staging home',
        );
      }
      const { requireDockerDesktopSidecarRuntime, startDockerDesktopSidecar } =
        await import('../docker-workload/docker-desktop-sidecar.js');
      const sidecarEgress =
        dockerDesktopRelayExposure === undefined
          ? undefined
          : {
              networkName: dockerDesktopRelayExposure.isolatedNetworkName,
              ipv4Address: ironCurtainInternalSubnetHostAddress(dockerDesktopRelayExposure.ipv4Subnet, 4),
              registryProxyUrl: dockerDesktopRelayExposure.registry.proxyUrl,
              caMount: {
                source: resolve(orientationDir, 'ca-bundle.pem'),
                target: CONTAINER_RUNTIME_CA_BUNDLE,
                readonly: true,
              },
              ...(dockerBuildShim === undefined
                ? {}
                : {
                    buildTrustMounts: dockerBuildShimMountsForConsumer({
                      staging: dockerBuildShim,
                      runtimeKind,
                      consumer: 'private-daemon',
                      privateDaemonRuncTarget: DOCKER_BUILD_TRUST_WRAPPER_PATH,
                    }),
                  }),
            };
      const sidecar = await startDockerDesktopSidecar({
        runtime: requireDockerDesktopSidecarRuntime(docker),
        sidecarImage: dockerDesktopSidecarImage,
        identity: containerIdentity,
        // Canonical: the identity files staged here are bind-mount sources.
        hostConfigDirectory: canonicalPathBelowHome(
          nestedStagingHome,
          resolve(hostOnlyDir, 'daemon'),
          'nested daemon host configuration directory',
        ),
        clientManifest: loadClientToolchainManifest(
          getFrozenClientToolchainManifestPath(),
          admitted.environment.architecture,
        ),
        outerAgentImageId: dockerWorkloadImageResolution.immutableImageId,
        workspaceRoot: workspaceDir,
        resources: dockerDesktopResources.sidecar,
        ...(sidecarEgress === undefined ? {} : { egress: sidecarEgress }),
        createOuterResource: (spec, create) => ledgerOuterResourceCreate(dockerWorkload, spec, create),
        activation: dockerWorkload,
      });
      if (dockerBuildShim !== undefined) {
        if (dockerBuildShim.contract.admittedDockerHost !== sidecar.dockerHost) {
          throw new Error('package build shim endpoint differs from the admitted private daemon');
        }
        await preflightDockerBuildTrust(
          dockerBuildShimExecFor(docker, sidecar.containerId),
          dockerBuildShim.contract,
          dockerBuildShim.buildTrustCanary,
          DOCKER_BUILD_TRUST_WRAPPER_PATH,
        );
      }
      dockerDesktopAgentAccess = {
        dockerHost: sidecar.dockerHost,
        networkName: sidecar.network.name,
        agentApiMount: sidecar.agentApiMount,
        ...(dockerDesktopRelayExposure === undefined
          ? {}
          : {
              outerEgressNetworkName: dockerDesktopRelayExposure.isolatedNetworkName,
            }),
      };
    }

    // Build orientation
    const helpData = proxy.getHelpData();
    const serverListings = Object.entries(helpData.serverDescriptions).map(([name, description]) => ({
      name,
      description,
    }));
    // The proxy virtual server won't have an entry in config.mcpServers, so its
    // description falls back to just "proxy". Add an explicit listing with a
    // proper description for the help/orientation system.
    if (config.mitmControlAddr && !serverListings.some((s) => s.name === 'proxy')) {
      serverListings.push({
        name: 'proxy',
        description: 'Network proxy domain management (add/remove/list allowed domains)',
      });
    }
    logger.info(`Available servers: ${serverListings.map((s) => s.name).join(', ')}`);

    // The address the agent uses to reach the Code Mode proxy: the vmnet
    // gateway on host-only networks, the Docker host alias otherwise.
    const proxyHost = hostOnlyNetwork ? hostOnlyNetwork.gateway : DOCKER_HOST_GATEWAY;
    const proxyAddress = useTcp && proxy.port !== undefined ? `${proxyHost}:${proxy.port}` : undefined;
    let nestedDocker: { networkName: string; networkAccess: DockerWorkloadNetworkAccess } | undefined;
    if (dockerWorkload !== undefined) {
      if (dockerWorkloadConfig?.enabled !== true) {
        throw new Error('admitted nested-Docker handle is missing its resolved enabled configuration');
      }
      nestedDocker = {
        networkName: dockerDesktopAgentAccess?.networkName ?? PRIVATE_DOCKER_WORKLOAD_NETWORK,
        networkAccess: dockerWorkloadConfig.networkAccess,
      };
    }
    const { systemPrompt } = prepareSession(adapter, serverListings, bundleDir, config, proxyAddress, nestedDocker);

    // Resolve the stock agent image once, before any container operation.
    // An admitted workload already carries its backend-specific immutable
    // resolution created before lease admission; ordinary sessions use the
    // normal build cache.
    const agentImage = dockerWorkloadAgentImage ?? (await adapter.getImage());
    const imageResolution =
      dockerWorkloadImageResolution ??
      preparedImageResolution ??
      (await resolveAgentImage(agentImage, docker, undefined, agentImageBuildOptions(adapter, config.userConfig)));
    assertPreparedImageResolution(
      imageResolution,
      agentImage,
      dockerWorkloadConfig?.enabled === true ? runtimeKind : undefined,
    );
    const agentBuildHash = imageResolution.buildHash;
    const image = imageResolution.imageRef;
    // Check the agent CLI version baked into the image against the range
    // qualified with this release, once per build and process; a version
    // outside it (an override, or drift) is logged as a warning (issue #367).
    await checkAgentCliVersion({
      runtime: docker,
      image,
      buildHash: agentBuildHash,
      versionProbe: adapter.versionProbe,
      support: adapter.cliVersion,
    });
    // Plan only: the shared base is verified or rebuilt, and this run's
    // writable layer seeded, in createSessionContainers before the agent
    // container exists. Run layers live with the workflow run (keyed by
    // workflowId) so resume re-mounts the same layer.
    const workflowDependencyLayers: WorkflowDependencyLayers =
      workflowDependencyManifests === undefined
        ? {}
        : planWorkflowDependencyLayers({
            agentBuildHash,
            manifests: workflowDependencyManifests,
            ironcurtainHome: getIronCurtainHome(),
            runDependencyRoot:
              workflowRunDir !== undefined
                ? workflowRunDependencyRoot(workflowRunDir)
                : resolve(bundleDir, 'workflow-deps'),
          });

    // Set up conversation state directory if the adapter supports resume
    const conversationStateConfig = adapter.getConversationStateConfig?.();
    const conversationStateDir = conversationStateConfig
      ? prepareConversationStateDir(bundleDir, conversationStateConfig)
      : undefined;

    // Workflow bundles always create the staging dir (even when empty)
    // because the bind mount can only be established at container start;
    // per-state persona transitions need a live mount to re-stage into.
    const isWorkflowBundle = workflowId !== undefined;
    const initialSkills = resolvedSkills ?? [];
    const skillsTarget = adapter.skills?.containerPath;
    let skillsMount: PreContainerInfrastructure['skillsMount'];
    let stage: ((skills: readonly ResolvedSkill[]) => boolean) | undefined;
    if (skillsTarget && (initialSkills.length > 0 || isWorkflowBundle)) {
      const hostDir = resolve(bundleDir, BUNDLE_SKILLS_SUBDIR);
      skillsMount = { hostDir, target: skillsTarget };
      stage = createCachedStager(hostDir);
      stage(initialSkills);
      if (initialSkills.length > 0) {
        logger.info(`Staged ${initialSkills.length} skill(s) to ${hostDir}`);
      }
    }
    const restageSkills = (skills: readonly ResolvedSkill[]): void => {
      if (!stage || !skillsMount) return;
      if (stage(skills)) {
        logger.info(`Re-staged ${skills.length} skill(s) to ${skillsMount.hostDir}`);
      }
    };

    let scriptsMount: PreContainerInfrastructure['scriptsMount'];
    if (stagedScriptsDir !== undefined) {
      const hostDir = requireStagedWorkflowScripts(workflowRunDir, stagedScriptsDir);
      scriptsMount = { hostDir, target: CONTAINER_SCRIPTS_DIR };
      logger.info(`Staged workflow scripts available at ${hostDir}`);
    }

    return {
      bundleId,
      ...(options.onHostPrivilegedFiles ? { onHostPrivilegedFiles: options.onHostPrivilegedFiles } : {}),
      workflowId,
      workflowRunDir,
      scope,
      bundleDir,
      workspaceDir,
      ...(config.readOnlyWorkspace === undefined ? {} : { readOnlyWorkspace: config.readOnlyWorkspace }),
      escalationDir,
      auditLogPath,
      proxy,
      mitmProxy: activeMitmProxy,
      docker,
      containerRootIsHostRoot,
      ...(agentPrivileges.execUser === undefined ? {} : { agentExecUser: agentPrivileges.execUser }),
      agentSudo: agentPrivileges.agentSudo,
      adapter,
      ca,
      fakeKeys,
      orientationDir,
      systemPrompt,
      image,
      imageResolution,
      runtimeKind,
      topology,
      useTcp,
      ...(tcpTransport === undefined ? {} : { tcpTransport }),
      hostOnlyNetwork,
      socketsDir,
      mitmAddr,
      metricsProxyUrl,
      authKind,
      providerProfileId,
      conversationStateDir,
      conversationStateConfig,
      skillsMount,
      scriptsMount,
      ...workflowDependencyLayers,
      dockerWorkload,
      dockerWorkloadBootstrap,
      dockerDesktopAgentAccess,
      dockerDesktopResources,
      dockerWorkloadEgress,
      dockerBuildShim,
      restageSkills,
      setTokenSessionId: (id) => {
        activeMitmProxy.setTokenSessionId(id);
      },
      ...(metricsCapable
        ? {
            beginMetricsInvocation: (context: MetricsInvocationContext) =>
              activeMitmProxy.beginMetricsInvocation(metricsProxyUrl, context),
          }
        : {}),
      // Trajectory-capture lifecycle. When captureWriter is undefined
      // (capture disabled, the common case), every method is a cheap
      // no-op — zero cost on the forwarding path. When set, the bundle
      // owns the three-step atomic begin (setCaptureSessionId →
      // setCapturePersona → writer.beginSession) and the two-phase end
      // (writer.endSession → null out proxy attribution).
      beginCaptureSession: (opts) => {
        if (!captureWriter) return;
        activeMitmProxy.setCaptureSessionId(opts.sessionId);
        activeMitmProxy.setCapturePersona(opts.persona);
        captureWriter.beginSession(opts);
      },
      endCaptureSession: async (sessionId) => {
        if (!captureWriter) return;
        try {
          await captureWriter.endSession(sessionId);
        } finally {
          // Clear proxy attribution AFTER the drain settles so any
          // late-arriving response chunks already in flight are still
          // attributed to the correct session.
          activeMitmProxy.setCaptureSessionId(undefined);
          activeMitmProxy.setCapturePersona(undefined);
        }
      },
      captureWriter,
      metricsRuntime,
      budgetGate,
    };
  } catch (error) {
    // §8.3: an admitted Docker-workload lease must not outlive the failed
    // preparation, and crash reconciliation only reclaims SOME of these
    // failures. Attestation failure itself is reclaimable — the supervisor
    // launcher kills the child it rejected, so the lease goes stale and
    // `reconcileDockerWorkloadLeases` collects it. A failure AFTER a successful
    // attestation is not: the detached supervisor survives coordinator exit by
    // design and never exits on its own, so its status stays fresh, the lease
    // stays "live", and reconciliation PRESERVES it forever (one leaked
    // supervisor + lease + state tree per failed attempt). So tear it down
    // here, before the proxies, mirroring the teardown-first ordering of
    // `destroyBundleOuterResources`. Safe on the attestation-failure path too:
    // teardown is idempotent and, with the supervisor already gone, closes the
    // lease as coordinator and audits the incident. Best-effort — a teardown
    // fault must not mask the original error.
    await stopDockerWorkloadEgressBestEffort(dockerWorkloadEgress, 'prepareDockerInfrastructure');
    await dockerWorkload
      ?.teardown()
      .catch((err: unknown) =>
        logger.warn(`prepareDockerInfrastructure: dockerWorkload.teardown() failed: ${errorMessage(err)}`),
      );
    // Best-effort cleanup of proxies started above
    await mitmProxy?.stop().catch(() => {});
    await proxy?.stop().catch(() => {});
    await metricsRuntime?.release().catch(() => {});
    // Host-only network was created before the proxies; remove it too.
    // (A leak through the narrow window before this catch is self-healing:
    // createHostOnlyNetwork removes the stale same-named network first.)
    if (hostOnlyNetwork) {
      await docker.removeNetwork(hostOnlyNetwork.name).catch(() => {});
    }
    removeBundleRuntimeRoot(bundleId, 'prepareDockerInfrastructure');
    throw error;
  }
}

/**
 * Creates the full Docker session infrastructure, including a running
 * `sleep infinity` agent container (and, on macOS TCP mode, the socat
 * sidecar and per-session `--internal` network).
 *
 * Wraps `prepareDockerInfrastructure()` with container creation. On any
 * failure after the proxies are started, all started resources are torn
 * down before the error propagates.
 */
export async function createDockerInfrastructure(
  config: IronCurtainConfig,
  mode: SessionMode & { kind: 'docker' },
  bundleDir: string,
  workspaceDir: string,
  escalationDir: string,
  bundleId: BundleId,
  workflowId?: WorkflowId,
  scope?: string,
  resolvedSkills?: readonly ResolvedSkill[],
  captureInput?: CaptureSetupInput,
  scriptsDir?: string,
  options?: CreateDockerInfrastructureOptions,
  providerProfileName?: string,
): Promise<DockerInfrastructure> {
  const core = await prepareDockerInfrastructure(
    config,
    mode,
    bundleDir,
    workspaceDir,
    escalationDir,
    bundleId,
    workflowId,
    scope,
    resolvedSkills,
    captureInput,
    scriptsDir,
    {
      providerProfileName,
      workflowRunDir: options?.workflowRunDir,
      preparedImageResolution: options?.preparedImageResolution,
      proxyAgentKind: workflowId !== undefined ? 'workflow' : 'batch',
      onEscalation: options?.onEscalation,
      onHostPrivilegedFiles: options?.onHostPrivilegedFiles,
      maxLanes: options?.maxLanes,
      ...(options?.workflowCommit ? { workflowCommit: options.workflowCommit } : {}),
    },
  );

  return assembleDockerInfrastructure(core, config, options);
}

/**
 * Finalizes a prepared bundle into a running `DockerInfrastructure`: creates
 * the session containers (which first readies any workflow dependency layers,
 * see `createSessionContainers`). The shared Apple Docker-workload bootstrap
 * activates an admitted lease immediately before returning from the
 * agent-blocking bootstrap.
 *
 * On any failure an admitted Docker-workload bundle is torn down FIRST (§8.3):
 * `teardown()` removes the ledgered outer resources with absence proofs, so it
 * supersedes the ordinary `cleanupContainers` fallback (which still runs for
 * non-workload bundles). The proxies are always stopped last.
 *
 * Split out from `createDockerInfrastructure` so the §8.2/§8.3
 * create -> bootstrap -> teardown wiring is exercisable with a scripted
 * `PreContainerInfrastructure` without standing up real proxies.
 */
export async function assembleDockerInfrastructure(
  core: PreContainerInfrastructure,
  config: IronCurtainConfig,
  options?: CreateDockerInfrastructureOptions,
): Promise<DockerInfrastructure> {
  let containerResources: ContainerResources | undefined;
  try {
    containerResources = await createSessionContainers(core, config, options);
    return { ...core, ...containerResources };
  } catch (error) {
    // A create-session failure already revoked these authorities before its
    // partial VM cleanup. Once container resources were returned, this layer
    // owns the later-failure revocation instead. The split avoids both an
    // authority-after-VM rollback window and duplicate stop attempts.
    if (containerResources !== undefined) {
      await stopDockerWorkloadEgressBestEffort(core.dockerWorkloadEgress, 'assembleDockerInfrastructure');
    }
    // §8.3: tear the ledgered workload resources down first, then the ordinary
    // transport/network, and release the managed-resource lease. A create that failed mid-flight already cleaned
    // up its own partial containers/sidecar/network inside
    // createSessionContainers (workflow dependency provisioning included); this
    // covers any step that fails after it returned.
    await destroyBundleOuterResources({
      docker: core.docker,
      dockerWorkload: core.dockerWorkload,
      containerId: containerResources?.containerId ?? null,
      sidecarContainerId: containerResources?.sidecarContainerId ?? null,
      networkName: containerResources?.internalNetwork ?? null,
      bundleId: core.bundleId,
      context: 'assembleDockerInfrastructure',
    });
    await core.mitmProxy.stop().catch(() => {});
    await core.proxy.stop().catch(() => {});
    await core.metricsRuntime?.release().catch(() => {});
    removeBundleRuntimeRoot(core.bundleId, 'assembleDockerInfrastructure');
    throw error;
  }
}

/** What `destroyDockerInfrastructure` found while it tore a bundle down. */
export interface DockerInfrastructureTeardown {
  /**
   * The findings of the final host-mount privilege scan (host-root Docker
   * daemons only), made after the container was gone, as the notice to show
   * the user: everything setuid/setgid or root-owned the agent left in its
   * read-write host mounts. Undefined when the bundle has no scanner or the
   * scan found nothing.
   */
  readonly privilegedFiles?: HostPrivilegedFilesDiagnostic;
}

/**
 * Tears down a fully-formed `DockerInfrastructure` bundle: main container,
 * TCP-mode sidecar and internal network (if present), MITM proxy, and Code
 * Mode proxy.
 *
 * Error-tolerant: each step is isolated in its own try/catch so a failure
 * in one step does not prevent subsequent steps from running. Errors are
 * logged via `logger.warn` and otherwise swallowed -- callers in
 * error-recovery paths depend on this function never throwing.
 *
 * The companion to `createDockerInfrastructure()`: anything the former
 * allocates, this function releases. Resolves with what the teardown found
 * for the user (see {@link DockerInfrastructureTeardown}): the session or
 * workflow that owned the bundle reports it.
 */
export async function destroyDockerInfrastructure(infra: DockerInfrastructure): Promise<DockerInfrastructureTeardown> {
  // Revoke optional nested-daemon egress authority before touching the VM so
  // no new package/registry request can begin during exact outer teardown.
  await stopDockerWorkloadEgressBestEffort(infra.dockerWorkloadEgress, 'destroyDockerInfrastructure');

  // Containers + sidecar + internal network + managed-resource lease. For an
  // admitted Docker-workload bundle this tears the ledgered resources down
  // through the lease first, then sweeps any non-ledgered sidecar/network; for
  // an ordinary bundle it is the plain cleanup. See destroyBundleOuterResources.
  await destroyBundleOuterResources({
    docker: infra.docker,
    dockerWorkload: infra.dockerWorkload,
    containerId: infra.containerId,
    sidecarContainerId: infra.sidecarContainerId ?? null,
    networkName: infra.internalNetwork ?? null,
    bundleId: infra.bundleId,
    context: 'destroyDockerInfrastructure',
  });

  // Ordinary agent proxies stop after their consumer container. Proxy
  // connections terminate cleanly when the container stops; inverting this
  // part of the order would leave in-flight connections resetting during
  // proxy shutdown. They are independent producers, so stop them in parallel.
  // Each per-promise catch logs so one failure doesn't mask the other, and
  // allSettled ensures both complete even if one throws synchronously.
  await Promise.allSettled([
    infra.mitmProxy
      .stop()
      .catch((err: unknown) =>
        logger.warn(`destroyDockerInfrastructure: mitmProxy.stop() failed: ${errorMessage(err)}`),
      ),
    infra.proxy
      .stop()
      .catch((err: unknown) => logger.warn(`destroyDockerInfrastructure: proxy.stop() failed: ${errorMessage(err)}`)),
  ]);

  // Trajectory-capture safety net (§9): close the writer AFTER the proxies
  // have stopped, so no more records arrive mid-close. The writer emits
  // synthetic `session-end` entries (with `closedReason:
  // 'infrastructure-teardown'`) for any session whose explicit
  // endCaptureSession was not called — covering Ctrl-C / abort / crash
  // paths where the orchestrator's `finally` did not run.
  if (infra.captureWriter) {
    await infra.captureWriter
      .close()
      .catch((err: unknown) =>
        logger.warn(`destroyDockerInfrastructure: captureWriter.close() failed: ${errorMessage(err)}`),
      );
  }

  await infra.metricsRuntime
    ?.release()
    .catch((err: unknown) => logger.warn(`destroyDockerInfrastructure: metrics flush failed: ${errorMessage(err)}`));

  // Final setuid/setgid sweep of the agent's read-write host mounts (host-root
  // daemons only): the container is gone, so nothing can re-plant behind it.
  // Runs before the runtime root (the sockets dir) is removed so root-owned
  // entries there are reported rather than just failing the removal. Its
  // findings, all of them (also those a turn's scan reported already: this
  // is what is left), go back to the caller for the user.
  const finalScan = await infra.privilegedFileScanner?.scan('session end').catch((err: unknown) => {
    logger.warn(`destroyDockerInfrastructure: host-mount privilege scan failed: ${errorMessage(err)}`);
    return undefined;
  });
  const privilegedFiles = hostPrivilegedFilesNotice(finalScan, 'all');

  // CA and fake keys are intentionally absent: neither owns any
  // process-level resources. CA material is persisted in ~/.ironcurtain/ca/
  // and reused across sessions; fake keys are just strings in a Map that
  // goes out of scope with the infrastructure bundle.

  // Remove the per-bundle `~/.ironcurtain/run/<bid12>/` tree. The
  // proxies already unlink their own socket files during `stop()`, and
  // the coordinator unlinks `ctrl.sock` from its control-server shutdown,
  // but the subdirectories (`sockets/` + `host/`) remain. Best-effort
  // only. Nothing else removes this tree: a crashed run's directory stays
  // until a bundle with the same 12-character id prefix starts again
  // (`ensureSecureBundleDir` reuses it, it does not empty it). The contents
  // (empty once sockets are unlinked) carry no sensitive data.
  removeBundleRuntimeRoot(infra.bundleId, 'destroyDockerInfrastructure');

  logger.info(`Destroyed Docker infrastructure (container=${infra.containerId.substring(0, 12)})`);
  return privilegedFiles === undefined ? {} : { privilegedFiles };
}

/** Best-effort removal of the host-only per-bundle socket directory tree. */
export function removeBundleRuntimeRoot(bundleId: BundleId, context: string): void {
  const runtimeRoot = getBundleRuntimeRoot(bundleId);
  try {
    rmSync(runtimeRoot, { recursive: true, force: true });
  } catch (err) {
    logger.warn(`${context}: rmSync(${runtimeRoot}) failed: ${errorMessage(err)}`);
  }
}

/**
 * Returns the Docker label fields
 * (`bundleLabel` / `workflowLabel` / `scopeLabel`) for containers owned by
 * the given bundle. Workflow-mode bundles emit all three; standalone
 * bundles emit only `bundleLabel`. Each field is left `undefined` when
 * absent so `buildCreateArgs` skips the corresponding `--label` flag.
 *
 * See `docs/designs/workflow-session-identity.md` §7.
 */
export function buildBundleLabels(
  core: Pick<PreContainerInfrastructure, 'bundleId' | 'workflowId' | 'scope' | 'runtimeKind' | 'dockerWorkload'>,
): {
  bundleLabel: string;
  workflowLabel?: string;
  scopeLabel?: string;
  labels?: Readonly<Record<string, string>>;
} {
  const ownership = buildDockerOwnershipLabels(core);
  if (core.workflowId !== undefined) {
    return {
      ...ownership,
      workflowLabel: core.workflowId,
      // Resolved scope is set by the orchestrator on every workflow
      // bundle; default-fall back to DEFAULT_CONTAINER_SCOPE so that a
      // workflow bundle always carries a scope label.
      scopeLabel: core.scope ?? DEFAULT_CONTAINER_SCOPE,
    };
  }
  return ownership;
}

/** Select exactly one Docker resource owner for both batch and PTY creates. */
export function buildDockerOwnershipLabels(options: {
  readonly bundleId: BundleId;
  readonly runtimeKind: ContainerRuntimeKind;
  readonly dockerWorkload?: DockerWorkloadBundleHandle;
}): { readonly bundleLabel: string; readonly labels?: Readonly<Record<string, string>> } {
  // A secure Docker-workload lease is already the durable, crash-recoverable
  // owner. Do not mint a second process-owner lease for the same resources:
  // after a coordinator SIGKILL the detached watchdog would remove the runtime
  // objects, leaving no generic object from which startup GC could discover
  // and retire that redundant owner token. Every other bundle, Docker or
  // Apple Container, carries the process-owner labels so an interrupted or
  // crashed session's container (on Apple, a whole VM) is reclaimed by the
  // next startup reconciliation or `ironcurtain gc --runtime ...`.
  const managedLabels =
    options.dockerWorkload === undefined ? managedResourceLabels(options.bundleId, options.runtimeKind) : undefined;
  const labels = managedLabels
    ? Object.fromEntries(Object.entries(managedLabels).filter(([key]) => key !== 'ironcurtain.bundle'))
    : undefined;
  return { bundleLabel: options.bundleId, labels };
}

// ---------------------------------------------------------------------------
// Secure nested Docker-workload wiring (§8.2–8.3)
//
// Everything in this section is inert for ordinary sessions: a handle exists
// only for an enabled variant accepted by the resolved-variant guard. The
// helpers keep the §8.2 startup and §8.3 teardown ordering explicit and
// testable end-to-end.
// ---------------------------------------------------------------------------

/**
 * Roles that are ALWAYS the nested daemon/VM component by definition, whatever
 * the topology: a dedicated daemon container exists for no other purpose.
 *
 * Role alone is not the criterion, though — see
 * {@link launchesNestedDaemonComponent}. In the same-VM topology (plan §4.4
 * variant 1, the one currently implemented beneath the fuse) the daemon lives inside the agent's own
 * VM, so the `agent`-role create IS the daemon-component create and the gate
 * must fire for it — while the identical `agent` create in an ordinary session
 * must stay ungated.
 */
const WATCHDOG_GATED_OUTER_ROLES: ReadonlySet<OuterResourceRole> = new Set<OuterResourceRole>(['nested-daemon']);

/**
 * Whether §8.2 step 4 applies to this create — i.e. whether the watchdog must
 * be proven fresh immediately before it runs. Either the role is intrinsically
 * the daemon component, or the caller declared that this particular create
 * launches it.
 */
function launchesNestedDaemonComponent(spec: LedgeredOuterCreateSpec): boolean {
  return spec.launchesNestedDaemon === true || WATCHDOG_GATED_OUTER_ROLES.has(spec.role);
}

/**
 * Precommit one outer resource to the Docker-workload lease, run the caller's
 * create with the caller-selected name + merged ownership labels, then record the
 * runtime-returned immutable ID (§8.2 step 1) and, where the watchdog measures
 * it, bind the container's runtime-owned storage file. Daemon/VM-role creates
 * first prove the watchdog is fresh (§8.2 step 4).
 *
 * `create` receives that precommitted name and the merged labels and returns the
 * immutable ID (for networks, read it back via `listNetworks` — `createNetwork`
 * returns void) plus optional expanded-create evidence for the audit trail.
 */
export async function ledgerOuterResourceCreate(
  handle: DockerWorkloadBundleHandle,
  spec: LedgeredOuterCreateSpec,
  create: (
    name: string,
    ownershipLabels: Readonly<Record<string, string>>,
  ) => Promise<{ readonly id: string; readonly expanded?: ExpandedOuterCreate }>,
): Promise<{ readonly id: string }> {
  return handle.withOuterCreateClaim(async () => {
    if (launchesNestedDaemonComponent(spec)) handle.assertWatchdogFresh();
    const registration = handle.precommitOuterResource(spec);
    const labels = spec.baseLabels ? { ...spec.baseLabels, ...registration.labels } : registration.labels;
    const { id, expanded } = await create(spec.requestedName, labels);
    registration.observed(id, expanded);
    // Still under the create claim, so the watchdog never samples a ledgered
    // container whose runtime storage it cannot locate.
    await registration.bindStorage();
    await spec.adjudicateObserved?.(id);
    return { id };
  });
}

/**
 * Allocate the ordinary isolated MCP/MITM transport network under the secure
 * Docker-workload lease when one exists. Ordinary Docker sessions retain the
 * historical process-owner-label path.
 */
export async function createDockerSessionTransportNetwork(options: {
  readonly runtime: ContainerRuntime;
  readonly dockerWorkload: DockerWorkloadBundleHandle | undefined;
  readonly bundleId: BundleId;
  readonly requestedName: string;
  readonly allocation?: SelectIronCurtainInternalSubnetOptions;
}): Promise<AllocatedInternalNetwork> {
  if (options.dockerWorkload === undefined) {
    return createIronCurtainInternalNetwork(
      options.runtime,
      options.requestedName,
      options.bundleId,
      options.allocation,
    );
  }

  let allocated: AllocatedInternalNetwork | undefined;
  await ledgerOuterResourceCreate(
    options.dockerWorkload,
    {
      kind: 'network',
      role: 'transport-network',
      requestedName: options.requestedName,
      baseLabels: { [IRONCURTAIN_LABEL_BUNDLE]: options.bundleId },
    },
    async (requestedName, labels) => {
      allocated = await createIronCurtainInternalNetwork(options.runtime, requestedName, options.bundleId, {
        ...options.allocation,
        labels,
      });
      const networks = await options.runtime.listNetworks?.();
      if (networks === undefined) {
        throw new Error('selected Docker runtime cannot observe the created transport network');
      }
      const matching = networks.filter((network) => network.name === requestedName);
      if (matching.length !== 1) {
        throw new Error(`created transport network ${requestedName} did not resolve to one immutable ID`);
      }
      const network = matching[0];
      if (Object.entries(labels).some(([key, value]) => network.labels[key] !== value)) {
        throw new Error(`created transport network ${requestedName} lost its ownership labels`);
      }
      return { id: network.id };
    },
  );
  if (allocated === undefined) throw new Error('transport network allocation completed without a result');
  return allocated;
}

/** Create the TCP transport proxy through the same lifecycle as its agent. */
export async function createDockerSessionTransportProxy(options: {
  readonly dockerWorkload: DockerWorkloadBundleHandle | undefined;
  readonly requestedName: string;
  readonly baseLabels?: Readonly<Record<string, string>>;
  readonly create: (requestedName: string, labels: Readonly<Record<string, string>> | undefined) => Promise<string>;
}): Promise<string> {
  if (options.dockerWorkload === undefined) {
    return options.create(options.requestedName, options.baseLabels);
  }
  const { id } = await ledgerOuterResourceCreate(
    options.dockerWorkload,
    {
      kind: 'container',
      role: 'proxy',
      requestedName: options.requestedName,
      baseLabels: options.baseLabels,
    },
    async (requestedName, labels) => ({ id: await options.create(requestedName, labels) }),
  );
  return id;
}

export interface CreateAgentContainerOptions {
  /** Present only for an admitted secure nested Docker-workload bundle. */
  readonly dockerWorkload: DockerWorkloadBundleHandle | undefined;
  /**
   * Backend this bundle runs on. Decides — via `resolveNestedDaemonBundle` —
   * whether this agent create is also the §8.2 step-4 daemon-component create,
   * so neither session mode can forget the watchdog gate or apply it to an
   * ordinary session.
   */
  readonly runtimeKind: ContainerRuntimeKind;
  /** Runtime used to inspect and, on failed adjudication, remove the stopped create. */
  readonly runtime: ContainerRuntime;
  /**
   * Prepared immutable image ID expected in an Apple stopped create.
   * Undefined for ordinary sessions.
   */
  readonly expectedImageId?: string;
  /** Runtime name used in both ordinary and admitted workload modes. */
  readonly requestedName: string;
  /**
   * Base resource labels the create carries anyway. The single place the
   * generation ownership label is merged on top (in the ledgered case).
   */
  readonly baseLabels: Readonly<Record<string, string>> | undefined;
  /** Bind mounts, recorded as expanded-create evidence for the audit trail. */
  readonly mounts: readonly { readonly source: string; readonly target: string; readonly readonly: boolean }[];
  /**
   * Create the agent container with the given name + final labels (base merged
   * with the ownership label in the ledgered case) and return its runtime ID.
   */
  readonly create: (name: string, labels: Readonly<Record<string, string>> | undefined) => Promise<string>;
}

/**
 * Ledger-or-create the agent container: the shared shape used by the batch
 * (`createSessionContainers`) and PTY (`runPtySession`) paths. When a
 * Docker-workload bundle is admitted the create is ledgered before it runs (the
 * caller-selected name is precommitted with ownership labels and the runtime ID is
 * observed after create, with the mounts recorded as expanded evidence);
 * otherwise the container is created directly with the same requested name. Label
 * merging lives entirely in `ledgerOuterResourceCreate` via `baseLabels`, so
 * neither call site re-merges the ownership label.
 *
 * In the same-VM topology this create also launches the nested daemon, so it is
 * declared as such and `ledgerOuterResourceCreate` proves the watchdog fresh
 * first (§8.2 step 4). The declaration is derived here, from the handle and the
 * backend, rather than passed in — a caller cannot forget it.
 */
export async function createLedgeredAgentContainer(options: CreateAgentContainerOptions): Promise<string> {
  if (
    options.dockerWorkload !== undefined &&
    options.runtimeKind === 'apple-container' &&
    options.expectedImageId === undefined
  ) {
    throw new Error('admitted Apple Docker workload is missing its prepared immutable image ID');
  }

  const adjudicateObserved = async (containerId: string): Promise<void> => {
    if (options.runtimeKind !== 'apple-container' || options.expectedImageId === undefined) return;
    try {
      await assertAppleStoppedCreateImage(options.runtime, containerId, options.expectedImageId);
    } catch (error) {
      try {
        // The VM has not been started. Remove the exact runtime-returned ID
        // while the lifecycle claim is still held, then let the normal lease
        // teardown prove durable absence.
        await options.runtime.remove(containerId);
      } catch (removeError) {
        throw new AggregateError(
          [error, removeError],
          `Apple stopped-create image adjudication failed and exact removal also failed for ${containerId}`,
          { cause: removeError },
        );
      }
      throw error;
    }
  };

  if (!options.dockerWorkload) {
    const id = await options.create(options.requestedName, options.baseLabels);
    await adjudicateObserved(id);
    return id;
  }
  const nestedDaemon = resolveNestedDaemonBundle(options.dockerWorkload, options.runtimeKind);
  const { id } = await ledgerOuterResourceCreate(
    options.dockerWorkload,
    {
      kind: 'container',
      role: 'agent',
      requestedName: options.requestedName,
      launchesNestedDaemon: nestedDaemon !== undefined,
      baseLabels: options.baseLabels,
      adjudicateObserved,
    },
    async (name, labels) => ({ id: await options.create(name, labels), expanded: { mounts: [...options.mounts] } }),
  );
  return id;
}

const SHA256_IMAGE_ID = /^(?:sha256:)?([a-f0-9]{64})$/u;

/**
 * Apple Container 1.1 creates a local image by logical tag, not by its
 * `sha256:` index ID. Close that tag lookup race by inspecting the exact
 * stopped VM and comparing its captured descriptor with the prepared identity
 * before start.
 */
async function assertAppleStoppedCreateImage(
  runtime: ContainerRuntime,
  containerId: string,
  expectedImageId: string,
): Promise<void> {
  const actualImageId = await runtime.getImageId(containerId);
  const expected = SHA256_IMAGE_ID.exec(expectedImageId)?.[1];
  const actual = actualImageId === undefined ? undefined : SHA256_IMAGE_ID.exec(actualImageId)?.[1];
  if (expected === undefined || actual === undefined || actual !== expected) {
    throw new Error(
      `Apple stopped-create image mismatch for ${containerId}: expected ${expectedImageId}, ` +
        `observed ${actualImageId ?? 'missing'}; refusing to start the VM`,
    );
  }
}

/**
 * Build the persisted `SessionMetadata.dockerWorkload` tuple for an admitted
 * bundle (§8.4 audit surface). Pure; the caller supplies the resolved
 * capability configuration and the effective backend so the persisted record is
 * self-describing for post-hoc inspection.
 */
export function dockerWorkloadSessionMetadata(
  handle: DockerWorkloadBundleHandle,
  configuration: ResolvedDockerWorkloadConfig,
  backend: ContainerRuntimeKind,
): NonNullable<SessionMetadata['dockerWorkload']> {
  return {
    leaseId: handle.leaseId,
    generation: handle.generation,
    configuration: resolvedDockerWorkloadConfigSchema.parse(configuration),
    watchdogPolicy: handle.loadedPolicy.policy,
    backend,
  };
}

/**
 * Select and clamp the aggregate outer-container envelope once for both batch
 * and PTY assembly. An admitted Docker workload owns its explicit VM envelope;
 * ordinary sessions retain the long-standing top-level dockerResources values.
 */
export function selectOuterContainerResources(
  userConfig: Pick<ResolvedUserConfig, 'dockerResources' | 'dockerWorkload'>,
  hostResources?: HostResources,
): ReturnType<typeof clampDockerResources>['effective'] {
  const configured =
    userConfig.dockerWorkload?.enabled === true
      ? {
          memoryMb: userConfig.dockerWorkload.resources.memoryMb,
          cpus: userConfig.dockerWorkload.resources.cpus,
        }
      : userConfig.dockerResources;
  return clampDockerResources(configured, hostResources).effective;
}

/**
 * Partition one aggregate Docker Desktop nested-workload envelope across the
 * nested daemon (the sidecar that runs dockerd, BuildKit and every inner
 * container), the session transport, every enabled fixed relay, and the
 * agent, so their sum never exceeds the operator-selected envelope.
 *
 * The transport and relay reserves are fixed and charged first. The daemon
 * then receives at least `dockerWorkload.resources.daemonShare` (default half)
 * of the session's memory, CPU and PID budget, rounded up to a whole MiB,
 * millicpu and PID, and never less than its own floor, but never so much that
 * the agent drops below its floor; the agent receives the exact remainder. `hostResources` is the capacity the aggregate is clamped
 * to: callers pass the Docker Desktop VM's (`docker info` NCPU and MemTotal)
 * when the daemon reported it, since that VM, not the host, runs every outer
 * container. Apple keeps its existing single-VM envelope and does not call
 * this helper.
 */
export function selectDockerDesktopResourcePartition(
  userConfig: Pick<ResolvedUserConfig, 'dockerResources' | 'dockerWorkload'>,
  hostResources: HostResources | undefined,
  tcpTransport: boolean,
): DockerDesktopResourcePartition {
  if (userConfig.dockerWorkload?.enabled !== true) {
    throw new Error('Docker Desktop resource partition requires an enabled nested-Docker workload');
  }
  const aggregate = selectOuterContainerResources(userConfig, hostResources);
  if (aggregate.memoryMb === undefined || aggregate.cpus === undefined) {
    throw new Error('Docker Desktop nested Docker requires finite aggregate memory and CPU limits');
  }
  const { daemonShare, pids } = userConfig.dockerWorkload.resources;
  const memoryMb = Math.floor(aggregate.memoryMb);
  // Tolerate binary rounding of a decimal setting (0.29 * 1000 = 289.99...).
  const millicpus = Math.floor(aggregate.cpus * 1000 + 1e-6);
  const totalPids = pids.desired;

  const networkAccess = userConfig.dockerWorkload.networkAccess;
  const relayCount = networkAccess === 'packages' ? 2 : networkAccess === 'images' ? 1 : 0;
  const transport = tcpTransport
    ? {
        memoryMb: DOCKER_DESKTOP_RELAY_MEMORY_MB,
        millicpus: DOCKER_DESKTOP_RELAY_MILLICPUS,
        pidsLimit: DESKTOP_RELAY_PROFILE.pidsLimit,
      }
    : { memoryMb: 0, millicpus: 0, pidsLimit: 0 };
  const reserve = {
    memoryMb: transport.memoryMb + relayCount * DOCKER_DESKTOP_RELAY_MEMORY_MB,
    millicpus: transport.millicpus + relayCount * DOCKER_DESKTOP_RELAY_MILLICPUS,
    pids: transport.pidsLimit + relayCount * DESKTOP_RELAY_PROFILE.pidsLimit,
  };

  const minimumMemoryMb = DOCKER_DESKTOP_MIN_SIDECAR_MEMORY_MB + reserve.memoryMb + DOCKER_DESKTOP_MIN_AGENT_MEMORY_MB;
  const minimumMillicpus =
    DOCKER_DESKTOP_MIN_SIDECAR_MILLICPUS + reserve.millicpus + DOCKER_DESKTOP_MIN_AGENT_MILLICPUS;
  if (totalPids - reserve.pids - DOCKER_DESKTOP_MIN_AGENT_PIDS < DOCKER_DESKTOP_MIN_SIDECAR_PIDS) {
    throw new Error('Docker Desktop nested Docker PID envelope cannot cover every outer container');
  }
  if (memoryMb < minimumMemoryMb || millicpus < minimumMillicpus) {
    throw new Error(
      `Docker Desktop nested Docker ${networkAccess} mode requires at least ${minimumMemoryMb} MiB and ` +
        `${minimumMillicpus / 1000} CPU in dockerResources (the nested-Docker session envelope)`,
    );
  }
  // At least the configured share, rounded up to a whole unit (the epsilon
  // absorbs binary noise in an exact product such as 10 * 0.7), unless the
  // agent's floor needs part of it.
  const daemonPortion = (total: number, floor: number, agentFloor: number, reserved: number): number =>
    Math.min(Math.max(Math.ceil(total * daemonShare - 1e-9), floor), total - reserved - agentFloor);
  const sidecar = {
    memoryMb: daemonPortion(
      memoryMb,
      DOCKER_DESKTOP_MIN_SIDECAR_MEMORY_MB,
      DOCKER_DESKTOP_MIN_AGENT_MEMORY_MB,
      reserve.memoryMb,
    ),
    millicpus: daemonPortion(
      millicpus,
      DOCKER_DESKTOP_MIN_SIDECAR_MILLICPUS,
      DOCKER_DESKTOP_MIN_AGENT_MILLICPUS,
      reserve.millicpus,
    ),
    pidsLimit: daemonPortion(totalPids, DOCKER_DESKTOP_MIN_SIDECAR_PIDS, DOCKER_DESKTOP_MIN_AGENT_PIDS, reserve.pids),
  };
  return {
    sidecar: { memoryMb: sidecar.memoryMb, cpus: sidecar.millicpus / 1000, pidsLimit: sidecar.pidsLimit },
    transport: {
      memoryMb: transport.memoryMb,
      cpus: transport.millicpus / 1000,
      pidsLimit: transport.pidsLimit,
    },
    agent: {
      memoryMb: memoryMb - reserve.memoryMb - sidecar.memoryMb,
      cpus: (millicpus - reserve.millicpus - sidecar.millicpus) / 1000,
      pidsLimit: totalPids - reserve.pids - sidecar.pidsLimit,
    },
  };
}

function openFilesUlimit(limit: number): DockerUlimit {
  return { name: 'nofile', soft: limit, hard: limit };
}

/**
 * Resource limits for the macOS TCP transport sidecar: the partitioned share
 * when a nested-Docker envelope applies, otherwise the fixed small
 * {@link TRANSPORT_SIDECAR_LIMITS}. The sidecar is never left unbounded.
 */
export function buildDockerDesktopTransportCreateLimits(partition: DockerDesktopResourcePartition | undefined): {
  readonly resources: EffectiveDockerResources;
  readonly trustedCreateOptions: DockerTrustedCreateOptions;
} {
  if (partition === undefined) {
    return {
      resources: { memoryMb: TRANSPORT_SIDECAR_LIMITS.memoryMb, cpus: TRANSPORT_SIDECAR_LIMITS.cpus },
      trustedCreateOptions: {
        pidsLimit: TRANSPORT_SIDECAR_LIMITS.pidsLimit,
        ulimits: [openFilesUlimit(TRANSPORT_SIDECAR_LIMITS.openFilesLimit)],
      },
    };
  }
  return {
    resources: { memoryMb: partition.transport.memoryMb, cpus: partition.transport.cpus },
    trustedCreateOptions: {
      pidsLimit: partition.transport.pidsLimit,
      ulimits: [openFilesUlimit(DESKTOP_RELAY_PROFILE.openFilesLimit)],
    },
  };
}

/** Operator-configured per-container bounds that are not part of the memory/CPU envelope. */
export interface AgentContainerBounds {
  /** `dockerResources.pidsLimit`; null means the operator explicitly disabled the cgroup pids ceiling. */
  readonly pidsLimit: number | null;
}

/**
 * Merge Docker-runtime volume suppression, any Desktop API capability, and the
 * agent's process and descriptor bounds. On Docker the pids ceiling is the
 * nested-Docker partition's agent share when one applies, otherwise the
 * configured `dockerResources.pidsLimit`; the open-files ulimit is always
 * applied. apple-container runs each agent in its own VM and rejects Docker
 * create options, so it receives neither.
 */
export function buildDockerAgentTrustedCreateOptions(
  runtimeKind: ContainerRuntimeKind,
  namedVolumeMounts: readonly DockerNamedVolumeMount[],
  partition: DockerDesktopResourcePartition | undefined,
  bounds: AgentContainerBounds,
  securityOptions: readonly string[] = [],
): DockerTrustedCreateOptions | undefined {
  const dockerRuntime = runtimeKind === 'docker';
  if (!dockerRuntime && securityOptions.length > 0) {
    // planAgentContainerPrivileges refuses sudo-off on other runtimes; never
    // drop a requested no-new-privileges silently.
    throw new Error(`agent security options are Docker-only (runtime: ${runtimeKind})`);
  }
  if (!dockerRuntime && namedVolumeMounts.length === 0 && partition === undefined) return undefined;
  const pidsLimit = partition?.agent.pidsLimit ?? (dockerRuntime ? (bounds.pidsLimit ?? undefined) : undefined);
  return {
    ...(namedVolumeMounts.length === 0 ? {} : { namedVolumeMounts }),
    ...(dockerRuntime ? { tmpfs: [DOCKER_AGENT_VOLUME_SHADOW.specification] } : {}),
    ...(pidsLimit === undefined ? {} : { pidsLimit }),
    ...(dockerRuntime ? { ulimits: [openFilesUlimit(AGENT_OPEN_FILES_LIMIT)] } : {}),
    ...(securityOptions.length === 0 ? {} : { securityOptions: [...securityOptions] }),
  };
}

/**
 * Reads the configured agent pids ceiling. The resolved config always carries
 * the field; a partially built config (hand-assembled by a caller or a test)
 * falls back to the shipped default rather than to "unbounded".
 */
function resolveAgentContainerBounds(userConfig: Pick<ResolvedUserConfig, 'dockerResources'>): AgentContainerBounds {
  const { pidsLimit } = userConfig.dockerResources as Partial<ResolvedUserConfig['dockerResources']>;
  return { pidsLimit: pidsLimit === undefined ? USER_CONFIG_DEFAULTS.dockerResources.pidsLimit : pidsLimit };
}

/**
 * Linux Docker agent containers inherit the host identity through the UID
 * remap; refuse a root host identity before any image build or container
 * work (audit finding DINF-23). macOS Docker Desktop (TCP transport) and
 * apple-container do not remap and are unaffected.
 */
export function assertLinuxDockerHostIdentity(runtimeKind: ContainerRuntimeKind, useTcp: boolean): void {
  if (runtimeKind !== 'docker' || useTcp) return;
  assertAgentHostIdentityIsNotRoot(resolveContainerIdentity(true));
}

/**
 * Logs {@link HOST_ROOT_EXPOSURE_WARNING} when the Linux Docker daemon maps
 * container root to host root and agents keep sudo (with `agentSudo: false`
 * nothing in the container can become root, so an info line suffices). Uses
 * the admitted workload's recorded server facts when present; otherwise probes
 * `docker info` once. Never throws: this is a disclosure, not an admission
 * check. Returns the classification it logged (undefined when the daemon's
 * security options were unreadable).
 */
export async function warnWhenContainerRootIsHostRoot(
  recordedFacts: DockerServerFacts | undefined,
  probe: () => Promise<DockerServerFacts | undefined> = probeDockerServerFacts,
  agentSudo = true,
): Promise<DockerUserNamespaceMode | undefined> {
  const facts = recordedFacts ?? (await probe());
  if (facts === undefined) {
    logger.warn('[docker] Could not read Docker security options; cannot tell whether container root is host root');
    return undefined;
  }
  const mode = classifyDockerUserNamespace(facts.securityOptions);
  if (mode === 'host-root' && agentSudo) {
    logger.warn(HOST_ROOT_EXPOSURE_WARNING);
  } else if (mode === 'host-root') {
    logger.info(
      '[docker] Container root is host root on this daemon, but agent sudo is disabled (agentSudo: false): agent ' +
        'containers run with no-new-privileges and without file-privilege capabilities.',
    );
  } else {
    logger.info(`[docker] Container root is isolated from host root (${mode})`);
  }
  return mode;
}

async function probeDockerServerFacts(): Promise<DockerServerFacts | undefined> {
  try {
    const availability = await checkDockerAvailable(undefined, true);
    return availability.available ? availability.server : undefined;
  } catch {
    return undefined;
  }
}

interface DockerWorkloadAdmissionForSessionOptions {
  readonly dockerWorkload: Extract<ResolvedDockerWorkloadConfig, { enabled: true }>;
  readonly runtime: ContainerRuntime;
  readonly runtimeKind: ContainerRuntimeKind;
  readonly bundleId: BundleId;
  readonly workspaceRoot: string;
  readonly auditLogPath: string;
  /** The home resolved once for this admission; staging paths below it are canonicalized against it. */
  readonly home: CanonicalIronCurtainHome;
  /** Required only for Apple's same-VM daemon; Docker Desktop has no archive bootstrap. */
  readonly artifact?: SelectedAgentArtifact;
}

/**
 * Assemble and drive the §8.2-step-1 admission for a secure nested
 * Docker-workload bundle.
 *
 * The backend gate runs before any lease exists. The already-resolved selected
 * artifact is then hard-linked into the lease without reopening global state.
 */
async function admitDockerWorkloadForSession(options: DockerWorkloadAdmissionForSessionOptions): Promise<{
  readonly handle: DockerWorkloadBundleHandle;
  readonly bootstrap?: AppleVmDockerWorkloadBootstrapConfig;
}> {
  const { admitDockerWorkloadBundle } = await import('../docker-workload/infrastructure.js');
  const { createJsonlDockerWorkloadAuditSink } = await import('../docker-workload/lifecycle-evidence.js');
  const { resolveResourceWatchdogSupervisorEntrypoint } =
    await import('../docker-workload/resource-watchdog-supervisor.js');
  assertNestedDaemonBackendImplemented(options.runtimeKind);
  if ((options.runtimeKind === 'apple-container') !== (options.artifact !== undefined)) {
    throw new Error('selected-agent archive staging is required only for the Apple same-VM nested daemon');
  }
  const handle = await admitDockerWorkloadBundle({
    runtime: options.runtime,
    runtimeKind: options.runtimeKind,
    runtimeForKind: (kind, endpoint) =>
      kind === options.runtimeKind && (endpoint === undefined || endpoint.host === options.runtime.dockerEndpoint?.host)
        ? options.runtime
        : createContainerRuntime(kind, endpoint),
    bundleId: String(options.bundleId),
    workspaceRoot: options.workspaceRoot,
    configuration: options.dockerWorkload,
    watchdogPolicyTemplatePath: getFrozenWatchdogPolicyTemplatePath(),
    // The entrypoint beside the running supervisor module: the source under
    // tsx, the build under dist. A source run never launches a stale build.
    watchdogSupervisorEntrypointPath: resolveResourceWatchdogSupervisorEntrypoint(),
    auditSink: createJsonlDockerWorkloadAuditSink(options.auditLogPath),
  });
  if (options.artifact === undefined) return { handle };
  try {
    const bootstrap = stageAppleVmDockerWorkloadBootstrap({
      // Canonical, so a symlinked home passes the private-directory checks and
      // the staged archive mount names its real location.
      leaseStagingRoot: canonicalPathBelowHome(options.home, handle.stagingRoot, 'Docker-workload lease staging root'),
      artifact: options.artifact,
    });
    return { handle, bootstrap };
  } catch (error) {
    await handle.teardown();
    throw error;
  }
}

// The Linux UID-remap decision lives with the rest of the agent identity and
// privilege plan; re-exported for existing callers.
export { buildAgentUidRemap } from './agent-privileges.js';

/** In-container mount root for the UDS proxies (both runtimes). */
export const CONTAINER_SOCKETS_DIR = '/run/ironcurtain';

/**
 * Returns the `uds`-topology socket mounts for a given runtime. Linux
 * Docker bind-mounts the whole `sockets/` directory (the sockets are
 * shared kernel objects). Apple `container` mounts each socket FILE via
 * `-v` so the runtime creates a per-socket vsock relay — a virtiofs
 * directory share does not carry sockets (verified: `connect()` on a
 * socket inside a shared dir fails ENOTSUP on 1.1.0). Shared by batch
 * (`createSessionContainers`) and PTY (`runPtySession`).
 */
export function buildUdsSocketMounts(
  runtimeKind: ContainerRuntimeKind,
  socketsDir: string,
): { source: string; target: string; readonly: boolean }[] {
  if (runtimeKind === 'apple-container') {
    return [
      { source: resolve(socketsDir, 'proxy.sock'), target: `${CONTAINER_SOCKETS_DIR}/proxy.sock`, readonly: false },
      {
        source: resolve(socketsDir, 'mitm-proxy.sock'),
        target: `${CONTAINER_SOCKETS_DIR}/mitm-proxy.sock`,
        readonly: false,
      },
    ];
  }
  return [{ source: socketsDir, target: CONTAINER_SOCKETS_DIR, readonly: false }];
}

export interface NestedDockerAgentWiring {
  readonly appleNestedDaemon: DockerWorkloadBundleHandle | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly namedVolumeMounts: readonly DockerNamedVolumeMount[];
}

/** Resolve the backend-specific private-Docker capability exposed to an agent. */
export function resolveNestedDockerAgentWiring(
  core: Pick<
    PreContainerInfrastructure,
    'runtimeKind' | 'dockerWorkload' | 'dockerWorkloadBootstrap' | 'dockerDesktopAgentAccess'
  >,
): NestedDockerAgentWiring {
  const appleNestedDaemon = resolveNestedDaemonBundle(core.dockerWorkload, core.runtimeKind);
  if (core.dockerWorkload === undefined) {
    if (core.dockerWorkloadBootstrap !== undefined || core.dockerDesktopAgentAccess !== undefined) {
      throw new Error('nested-Docker staging or API access exists without an admitted workload');
    }
    return { appleNestedDaemon, env: {}, namedVolumeMounts: [] };
  }
  if (core.runtimeKind === 'apple-container') {
    if (core.dockerWorkloadBootstrap === undefined) {
      throw new Error('Apple nested Docker is missing its staged selected-agent artifact');
    }
    if (core.dockerDesktopAgentAccess !== undefined) {
      throw new Error('Apple nested Docker received a Docker Desktop API capability');
    }
    return {
      appleNestedDaemon,
      env: nestedDaemonAgentEnv(appleNestedDaemon),
      namedVolumeMounts: [],
    };
  }

  if (core.dockerWorkloadBootstrap !== undefined) {
    throw new Error('Docker Desktop nested Docker received Apple selected-agent artifact staging');
  }
  const access = core.dockerDesktopAgentAccess;
  if (access === undefined) throw new Error('Docker Desktop nested Docker is missing its qualified sidecar API');
  if (access.agentApiMount.readonly !== true || access.agentApiMount.noCopy !== true) {
    throw new Error('Docker Desktop agent API volume must be an exact read-only no-copy capability');
  }
  return {
    appleNestedDaemon: undefined,
    env: {
      DOCKER_HOST: access.dockerHost,
      [PRIVATE_DOCKER_WORKLOAD_NETWORK_ENV]: access.networkName,
    },
    namedVolumeMounts: [access.agentApiMount],
  };
}

/** Pin Docker Desktop's outer agent create to the same captured immutable image. */
export function resolveNestedDockerOuterAgentImage(
  core: Pick<PreContainerInfrastructure, 'runtimeKind' | 'dockerWorkload' | 'imageResolution'>,
  fallbackImage: string,
): string {
  if (core.runtimeKind !== 'docker' || core.dockerWorkload === undefined) return fallbackImage;
  const selectedImageId = core.imageResolution?.immutableImageId;
  if (selectedImageId === undefined || SHA256_IMAGE_ID.exec(selectedImageId) === null) {
    throw new Error('Docker Desktop nested Docker is missing its selected immutable outer-agent image');
  }
  return selectedImageId;
}

/** Exact Apple-only mounts for the per-bundle nested-Docker egress capabilities. */
export function buildDockerWorkloadEgressMounts(
  core: Pick<PreContainerInfrastructure, 'runtimeKind' | 'dockerWorkloadEgress'>,
): { source: string; target: string; readonly: boolean }[] {
  if (core.dockerWorkloadEgress === undefined) return [];
  if (core.runtimeKind === 'docker') return [];
  const registrySocketPath = core.dockerWorkloadEgress.registry.socketPath;
  if (registrySocketPath === undefined) throw new Error('Apple registry egress is missing its UDS capability');
  const mounts: { source: string; target: string; readonly: boolean }[] = [
    {
      source: registrySocketPath,
      target: APPLE_VM_REGISTRY_EGRESS_SOCKET,
      readonly: false,
    },
  ];
  if (core.dockerWorkloadEgress.networkAccess === 'packages') {
    const packageSocketPath = core.dockerWorkloadEgress.packages.socketPath;
    if (packageSocketPath === undefined) throw new Error('Apple package egress is missing its UDS capability');
    mounts.push({
      source: packageSocketPath,
      target: APPLE_VM_PACKAGE_EGRESS_SOCKET,
      readonly: false,
    });
  }
  return mounts;
}

/** Package-only build/runtime-trust mounts, shared by batch/workflow and PTY containers. */
export function buildDockerBuildShimMounts(
  core: Pick<PreContainerInfrastructure, 'runtimeKind' | 'dockerBuildShim'>,
): { source: string; target: string; readonly: boolean }[] {
  const staging = core.dockerBuildShim;
  if (staging === undefined) return [];
  return dockerBuildShimMountsForConsumer({
    staging,
    runtimeKind: core.runtimeKind,
    consumer: 'agent',
  });
}

/** Resolve and validate the relay mode encoded by the constructed listeners. */
export function dockerWorkloadEgressNetworkAccess(
  egress: DockerWorkloadEgressCollection | undefined,
): DockerWorkloadNetworkAccess {
  return egress?.networkAccess ?? 'offline';
}

/**
 * Activate the same admitted nested-Docker contract for batch and PTY sessions.
 * Keeping this assembly here prevents the two container-creation paths from
 * drifting on network mode, trust artifacts, or egress-ledger witnesses.
 */
export async function activateNestedDockerWorkload(options: {
  readonly runtime: ContainerRuntime;
  readonly runtimeKind: ContainerRuntimeKind;
  readonly containerId: string;
  readonly dockerWorkload: DockerWorkloadBundleHandle | undefined;
  readonly dockerDesktopAgentAccess: DockerDesktopAgentAccess | undefined;
  readonly bootstrap: AppleVmDockerWorkloadBootstrapConfig | undefined;
  readonly dockerWorkloadEgress: DockerWorkloadEgressCollection | undefined;
  readonly dockerBuildShim: DockerBuildShimStaging | undefined;
}): Promise<void> {
  const { dockerWorkload, bootstrap, dockerWorkloadEgress, dockerBuildShim } = options;
  if (dockerWorkload === undefined) return;

  if (options.runtimeKind === 'docker') {
    if (bootstrap !== undefined) {
      throw new Error('Docker Desktop nested Docker received Apple selected-agent artifact staging');
    }
    if (options.dockerDesktopAgentAccess === undefined) {
      throw new Error('Docker Desktop nested Docker is missing its qualified sidecar API');
    }
    if (dockerBuildShim !== undefined) {
      await preflightDockerBuildShimAgent(
        dockerBuildShimExecFor(options.runtime, options.containerId),
        dockerBuildShim.contract,
      );
    }
    await dockerWorkload.activate();
    return;
  }

  if (options.dockerDesktopAgentAccess !== undefined) {
    throw new Error('Apple nested Docker received a Docker Desktop API capability');
  }
  if (bootstrap === undefined) throw new Error('Apple nested Docker is missing its staged selected-agent artifact');
  const nestedDaemon = resolveNestedDaemonBundle(dockerWorkload, options.runtimeKind);
  if (nestedDaemon === undefined) throw new Error('Apple nested Docker is missing its same-VM daemon handle');

  await startAppleVmDockerWorkload({
    runtime: options.runtime,
    containerId: options.containerId,
    nestedDaemon,
    bootstrap,
    networkAccess: dockerWorkloadEgressNetworkAccess(dockerWorkloadEgress),
    dockerBuildShim: dockerBuildShim?.contract,
    dockerBuildTrustCanary: dockerBuildShim?.buildTrustCanary,
    egressLedgers:
      dockerWorkloadEgress?.networkAccess === 'packages'
        ? {
            registry: dockerWorkloadEgress.registry.snapshot,
            packages: dockerWorkloadEgress.packages.snapshot,
          }
        : undefined,
  });
}

/** Stop every constructed authority even when one listener reports a failure. */
export async function stopDockerWorkloadEgress(
  egress:
    | DockerWorkloadEgressSet<
        { readonly listener: { stop(): Promise<void> } },
        { readonly listener: { stop(): Promise<void> } }
      >
    | undefined,
): Promise<void> {
  if (egress === undefined) return;
  const endpoints = egress.networkAccess === 'packages' ? [egress.packages, egress.registry] : [egress.registry];
  const results = await Promise.allSettled(
    endpoints.map((endpoint) => Promise.resolve().then(() => endpoint.listener.stop())),
  );
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason as unknown);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'nested-Docker egress listeners failed to stop');
}

async function stopDockerWorkloadEgressBestEffort(
  egress: DockerWorkloadEgressCollection | undefined,
  context: string,
): Promise<void> {
  await stopDockerWorkloadEgress(egress).catch((err: unknown) =>
    logger.warn(`${context}: nested-Docker egress stop failed: ${errorMessage(err)}`),
  );
}

/** Container-level resources layered on top of the pre-container bundle. */
export interface ContainerResources {
  readonly containerId: string;
  readonly containerName: string;
  readonly sidecarContainerId?: string;
  readonly internalNetwork?: string;
  /**
   * Why the workflow snapshot offered as `baseImageOverride` was not used
   * (the agent container started from the agent image instead). Absent when
   * none was offered or it was used.
   */
  readonly snapshotRefusal?: string;
  /**
   * Present when container root is host root (`containerRootIsHostRoot`):
   * scans the agent container's read-write host mounts for setuid/setgid and
   * root-owned entries. Sessions run it after each agent turn, and
   * `destroyDockerInfrastructure` once more after the container is gone.
   */
  readonly privilegedFileScanner?: HostMountPrivilegeScanner;
}

/** Shared agent identity, sudo capabilities, limits and nested-Docker wiring for batch and PTY. */
export function buildAgentContainerConfig(
  core: Pick<
    PreContainerInfrastructure,
    | 'runtimeKind'
    | 'useTcp'
    | 'tcpTransport'
    | 'dockerWorkload'
    | 'dockerWorkloadBootstrap'
    | 'dockerDesktopAgentAccess'
    | 'dockerDesktopResources'
  >,
  userConfig: Pick<ResolvedUserConfig, 'dockerResources' | 'dockerWorkload'> &
    Partial<Pick<ResolvedUserConfig, 'agentSudo'>>,
  config: DockerContainerConfig,
): DockerContainerConfig {
  const wiring = resolveNestedDockerAgentWiring(core);
  const privileges = planBundleAgentPrivileges(core, userConfig);
  const resources = core.dockerDesktopResources?.agent ?? selectOuterContainerResources(userConfig);
  // UDS sessions need no ordinary transport network. Online nested Docker
  // creates the agent directly on its isolated relay network; Docker cannot
  // attach another network to a container initially created on `none`.
  const egressNetwork = !core.useTcp ? core.dockerDesktopAgentAccess?.outerEgressNetworkName : undefined;
  const env = { ...config.env, ...wiring.env, ...privileges.env };
  const privateEnv = { ...config.privateEnv };
  if (core.tcpTransport !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(core.tcpTransport.mcpToken)) throw new Error('Invalid MCP TCP transport token');
    privateEnv.IRONCURTAIN_MCP_TCP_TOKEN = core.tcpTransport.mcpToken;
    if (Object.hasOwn(env, 'HTTP_PROXY')) privateEnv.HTTP_PROXY = env.HTTP_PROXY;
    if (Object.hasOwn(env, 'HTTPS_PROXY')) privateEnv.HTTPS_PROXY = env.HTTPS_PROXY;
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
  }
  return {
    ...config,
    network: egressNetwork ?? config.network,
    extraHosts: egressNetwork === undefined ? config.extraHosts : [],
    env,
    ...(Object.keys(privateEnv).length === 0 ? {} : { privateEnv }),
    user: privileges.user,
    resources: { memoryMb: resources.memoryMb, cpus: resources.cpus },
    capAdd: privileges.capAdd,
    fullyVisibleProc: wiring.appleNestedDaemon !== undefined,
    trustedCreateOptions: buildDockerAgentTrustedCreateOptions(
      core.runtimeKind,
      wiring.namedVolumeMounts,
      core.dockerDesktopResources,
      resolveAgentContainerBounds(userConfig),
      privileges.securityOptions,
    ),
  };
}

/** The agent may use this bundle's proxy; other local clients need its credential. */
export function tcpSidecarProxyUrl(
  core: Pick<PreContainerInfrastructure, 'topology' | 'tcpTransport'>,
  port: number,
): string {
  if (
    core.topology !== 'tcp-sidecar' ||
    core.tcpTransport === undefined ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('TCP sidecar requires its per-bundle transport credentials and proxy port');
  }
  return proxyAuthorizedUrl(`http://${DOCKER_HOST_GATEWAY}:${port}`, core.tcpTransport.proxyAuthorization);
}

/**
 * Give a networked Docker Desktop agent access to the fixed registry/package
 * relays before workload activation. The agent remains primarily attached to
 * the ordinary session network used by the MCP/MITM transport; only ledgered
 * workload resources join this second ledgered network, preserving exact crash
 * cleanup ownership.
 */
export async function attachDockerDesktopAgentEgressNetwork(
  core: Pick<PreContainerInfrastructure, 'runtimeKind' | 'useTcp' | 'docker' | 'dockerDesktopAgentAccess'>,
  containerId: string,
): Promise<void> {
  const egressNetworkName = core.dockerDesktopAgentAccess?.outerEgressNetworkName;
  if (egressNetworkName === undefined || !core.useTcp) return;
  if (core.runtimeKind !== 'docker') {
    throw new Error('Docker Desktop outer egress network was supplied to a non-Docker runtime');
  }
  await core.docker.connectNetwork(egressNetworkName, containerId);
}

export interface CreateDockerInfrastructureOptions {
  /** Deliver findings before a successful session or workflow bundle can own them. */
  readonly onHostPrivilegedFiles?: (notice: HostPrivilegedFilesDiagnostic) => void;
  /** Actual workflow run root used to validate scripts before reads and mounts. */
  readonly workflowRunDir?: string;
  /**
   * Optional immutable image ref (a workflow snapshot) used only for the main
   * container's `docker create`. The normal agent image is still ensured first
   * so workflow dependency caches keep their base-image hash, and a workflow
   * dependency base is only ever provisioned from that normal image: a
   * snapshot's writable layer came from an agent-controlled container.
   * Used only when {@link baseImageAgentBuildHash} names the agent build this
   * bundle resolved and the image carries that build's label, and, for a
   * bundle without agent sudo, when {@link baseImageAgentSudo} is `false`;
   * otherwise the agent container starts fresh and `snapshotRefusal` says why.
   */
  readonly baseImageOverride?: string;
  /**
   * Agent image build the {@link baseImageOverride} snapshot was committed
   * from (`ContainerSnapshotRef.agentBuildHash`). Required for the snapshot to
   * be used: the flattened snapshot carries that build's entrypoint scripts
   * and agent CLI, which must match what this host code expects.
   */
  readonly baseImageAgentBuildHash?: string;
  /**
   * Whether the agent of the {@link baseImageOverride} snapshot's container had
   * sudo (`ContainerSnapshotRef.agentSudo`); absent when the snapshot does not
   * record it. A bundle planned with `agentSudo: false` uses only a snapshot
   * recorded as `false`.
   */
  readonly baseImageAgentSudo?: boolean;
  /** Exact CLI preflight result, threaded into this one session without re-resolution. */
  readonly preparedImageResolution?: AgentImageResolution;
  /**
   * In-process escalation handler for the bundle's coordinator (see
   * `PrepareDockerInfrastructureOptions.onEscalation`). Workflow bundles
   * only.
   */
  readonly onEscalation?: EscalationPromptFn;
  /**
   * Aborts container setup (a Ctrl-C during startup): the readiness wait ends
   * early, no later setup step starts, and the partial resources are torn
   * down before the abort reason propagates.
   */
  readonly signal?: AbortSignal;
  /**
   * Most agent lanes expected to share the bundle's coordinator at once
   * (see `PrepareDockerInfrastructureOptions.maxLanes`). Workflow bundles
   * only.
   */
  readonly maxLanes?: number;
  /**
   * Target of the bundle coordinator's `workflow_commit` tool (see
   * `PrepareDockerInfrastructureOptions.workflowCommit`). Workflow runs only.
   */
  readonly workflowCommit?: WorkflowCommitHandler;
}

/**
 * Creates and starts the main agent container (plus TCP-mode sidecar and
 * internal network on macOS). A workflow bundle with runtime dependencies first
 * readies its per-run dependency layers, building a missing or changed shared
 * base in a short-lived provisioning container that is removed before the agent
 * container is created. Cleans up any partially-created resources
 * on failure so callers get all-or-nothing semantics.
 *
 * Exported for testability: tests exercise the mount/env configuration and
 * the rollback-on-failure path by passing a mock `PreContainerInfrastructure`
 * with a scripted `ContainerRuntime`.
 */
export async function createSessionContainers(
  core: PreContainerInfrastructure,
  config: IronCurtainConfig,
  options?: CreateDockerInfrastructureOptions,
): Promise<ContainerResources> {
  // Crash recovery for both runtimes: Apple VMs carry the same owner labels.
  await reconcileIronCurtainDockerResourcesBestEffort(core.docker, 'session startup', {
    runtimeKind: core.runtimeKind,
  });
  options?.signal?.throwIfAborted();

  // The ordinary TCP transport can safely retry with another network because
  // every attempt owns only its container, sidecar, and network. An admitted
  // nested-Docker bundle also owns shared egress listeners and a workload
  // lease that activation transitions out of admission. Reusing those
  // authorities for attempt two would fail ledger precommit and mask the
  // original connectivity error. PTY retries rebuild the full infrastructure;
  // keep this batch path single-attempt until it can do the same.
  const maxAttempts = core.topology === 'tcp-sidecar' && core.dockerWorkload === undefined ? 4 : 1;
  return withInternalNetworkAllocationRetry(
    {
      maxAttempts,
      description: 'Internal Docker network',
      reconcile: () =>
        reconcileIronCurtainDockerResourcesBestEffort(core.docker, 'internal network retry', {
          runtimeKind: core.runtimeKind,
        }),
    },
    (excludedSubnets, attempt) => createSessionContainersAttempt(core, config, options, excludedSubnets, attempt),
  );
}

/**
 * Decides whether the agent container is created from the offered workflow
 * snapshot. A flattened snapshot carries the entrypoint scripts and agent CLI
 * of the image build its container ran, so it is used only when that build is
 * the one this bundle resolved now: the build hash the checkpoint recorded
 * must equal the bundle's, and the image must still exist with that build's
 * label. A snapshot from another build (an IronCurtain upgrade or downgrade, a
 * pin bump, a CLI override), or one recorded before snapshots carried a build
 * hash, is refused: the scope starts from a fresh container, while its
 * workspace and dependency layers (on the host) carry over. The snapshot must
 * be named by the immutable image ID the checkpoint records, so the image
 * whose label is checked here is the one `docker create` uses.
 *
 * A bundle planned without agent sudo (`agentSudo: false`) also refuses a
 * snapshot that does not record its agent as sudo-off (an older snapshot
 * records nothing, which counts as sudo on). Such a container runs as UID 1000
 * alone and takes its groups from the image's /etc/passwd and /etc/group, and
 * an agent that had root in the snapshotted container may have added itself
 * to any group there (root, disk, ...), which it would keep.
 *
 * `doctor --upgrade` predicts this decision for resumable runs
 * (`checkWorkflowSnapshots` in src/doctor/upgrade-checks.ts); keep the two in
 * step.
 */
export async function selectResumableSnapshot(
  core: Pick<PreContainerInfrastructure, 'docker' | 'imageResolution'>,
  options:
    | Pick<CreateDockerInfrastructureOptions, 'baseImageOverride' | 'baseImageAgentBuildHash' | 'baseImageAgentSudo'>
    | undefined,
  privileges: Pick<AgentContainerPrivilegePlan, 'agentSudo'>,
): Promise<{ readonly image?: string; readonly refusal?: string }> {
  const image = options?.baseImageOverride;
  if (image === undefined || image === '') return {};
  // A tag could be re-pointed between this check and the create.
  if (!isImmutableImageId(image)) {
    return { refusal: 'the snapshot is not named by an immutable image ID' };
  }
  const recorded: unknown = options?.baseImageAgentBuildHash;
  const current = core.imageResolution?.buildHash;
  if (recorded === undefined) {
    return { refusal: 'the snapshot does not record the agent image build it was taken from' };
  }
  if (current === undefined) return { refusal: 'the agent image build of this bundle is unknown' };
  if (recorded !== current) {
    return {
      refusal:
        `the snapshot was taken from agent image build ${shortBuildHash(recorded)}, ` +
        `and this IronCurtain runs build ${shortBuildHash(current)}`,
    };
  }
  // Anything but an exact `false` (absent, or damaged on disk) counts as sudo on.
  const recordedSudo: unknown = options?.baseImageAgentSudo;
  if (!privileges.agentSudo && recordedSudo !== false) {
    return {
      refusal:
        recordedSudo === true
          ? 'the snapshot was taken while the agent had sudo, and agentSudo is now false'
          : 'the snapshot does not record that the agent ran without sudo, and agentSudo is now false',
    };
  }
  const inspected = await core.docker.inspectImage(image);
  if (inspected === undefined) return { refusal: 'the snapshot image no longer exists' };
  if (inspected.labels[IMAGE_BUILD_HASH_LABEL] !== current) {
    return { refusal: 'the snapshot image is not labeled with the agent image build it was recorded with' };
  }
  return { image };
}

async function createSessionContainersAttempt(
  core: PreContainerInfrastructure,
  config: IronCurtainConfig,
  options: CreateDockerInfrastructureOptions | undefined,
  excludedSubnets: ReadonlySet<string>,
  attempt: number,
): Promise<ContainerResources> {
  const shortId = getBundleShortId(core.bundleId);
  const mainContainerName = `${CONTAINER_NAME_PREFIX}${shortId}`;
  // Labels applied to every IronCurtain-owned container (main + sidecar).
  // Workflow-mode bundles carry workflow + scope labels alongside the
  // always-present bundle label; standalone bundles carry only bundle.
  // See `docs/designs/workflow-session-identity.md` §7.
  const bundleLabels = buildBundleLabels(core);

  let mainContainerId: string | undefined;
  let sidecarContainerId: string | undefined;
  let internalNetwork: string | undefined;
  let allocatedNetworkSubnet: string | undefined;
  // Set once the agent container's mounts are final, before it is created, so
  // a start that fails after the entrypoint ran (as root in the default mode,
  // possibly from a resumed snapshot image) is still swept below.
  let privilegedFileScanner: HostMountPrivilegeScanner | undefined;

  try {
    // Remove stale main container from a crashed previous session (same session
    // ID means the same deterministic name). Keep this inside the authority-
    // covered rollback region: even a pre-create rejection must revoke both
    // nested egress listeners before any outer cleanup can run.
    await core.docker.removeStaleContainer(mainContainerName);

    // The plan the agent container is created with (buildAgentContainerConfig).
    const snapshotSelection = await selectResumableSnapshot(
      core,
      options,
      planBundleAgentPrivileges(core, config.userConfig),
    );
    const resumableBaseImage = snapshotSelection.image;
    if (snapshotSelection.refusal !== undefined) {
      logger.warn(`[docker] Not resuming from workflow snapshot: ${snapshotSelection.refusal}; starting fresh`);
    }
    // Docker can create directly from the selected immutable ID, closing the
    // tag-replacement window between artifact capture and the ledgered create.
    // Apple cannot, so its stopped-create adjudication below remains the
    // equivalent backend-specific defense. An immutable workflow snapshot,
    // when present, continues to take precedence for resume.
    const mainImage = resumableBaseImage ?? resolveNestedDockerOuterAgentImage(core, core.image);

    // A read-only workspace session (a read-only workflow state or scope)
    // mounts the workspace read-only, and every other host directory it
    // shares with the run's read-write containers too; it writes its
    // declared outputs through the filesystem MCP server, which the policy
    // engine confines to them.
    const workspaceReadOnly = core.readOnlyWorkspace !== undefined || config.readOnlyWorkspace !== undefined;
    // Base mounts shared by TCP and UDS modes: the sandbox as the
    // workspace and the orientation dir. Mode-specific mounts (apt proxy
    // config, sockets dir, conversation state) are appended below.
    const mounts: { source: string; target: string; readonly: boolean }[] = [
      buildContainerWorkspaceMount(core.workspaceDir, { readonly: workspaceReadOnly }),
      { source: core.orientationDir, target: '/etc/ironcurtain', readonly: true },
    ];
    // Same-VM nested daemon (§4.4 variant 1): present only for an admitted
    // Docker-workload bundle, in which case this agent container both hosts the
    // daemon and reaches it at the VM-local socket. Resolved once here and
    // reused for the env, the ledgered create, and the post-start bootstrap.
    const nestedDockerWiring = resolveNestedDockerAgentWiring(core);
    const nestedDaemon = nestedDockerWiring.appleNestedDaemon;
    const dockerWorkloadBootstrap = core.dockerWorkloadBootstrap;
    if (nestedDaemon !== undefined && dockerWorkloadBootstrap !== undefined) {
      mounts.push(appleVmDockerWorkloadArtifactMount(dockerWorkloadBootstrap));
    }
    let env = {
      ...core.adapter.buildEnv(config, core.fakeKeys),
      ...core.adapter.buildBatchEnv?.(config, core.fakeKeys),
      ...buildRuntimeTrustEnv(),
      ...buildPackageClientEnv(),
      ...nestedDockerWiring.env,
    };
    let network: string | null;
    let extraHosts: string[] | undefined;
    // apple-container only (both `uds` and the retained `tcp-hostonly`):
    // the apt proxy config is written into the container via exec after
    // start instead of bind-mounted — see writeAptProxyConfigViaExec for
    // the virtiofs constraints that make the bind mount unworkable.
    let execAptProxyUrl: string | undefined;
    // The MITM endpoint this topology exposes in-container; the workflow
    // dependency provisioner reuses it so registry traffic stays on this
    // bundle's proxy.
    let transportProxyUrl: string;

    if (core.topology === 'tcp-hostonly') {
      // Apple container host-only mode: the agent VM reaches the host
      // proxies directly at the vmnet gateway address. No sidecar, no
      // extra host mappings — egress is blocked at the network layer
      // (`--internal`) and verified by the connectivity check below.
      if (core.hostOnlyNetwork === undefined || core.mitmAddr.port === undefined || core.proxy.port === undefined) {
        throw new Error('tcp-hostonly bundle is missing its host-only network or proxy ports');
      }
      const proxyUrl = `http://${core.hostOnlyNetwork.gateway}:${core.mitmAddr.port}`;

      env = {
        ...env,
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
      };
      execAptProxyUrl = proxyUrl;
      transportProxyUrl = proxyUrl;

      network = core.hostOnlyNetwork.name;
      // Report the host-only network as `internalNetwork` so the standard
      // teardown paths (destroyDockerInfrastructure, rollback below)
      // remove it with the containers.
      internalNetwork = core.hostOnlyNetwork.name;
    } else if (core.topology === 'tcp-sidecar' && core.mitmAddr.port !== undefined && core.proxy.port !== undefined) {
      // macOS TCP mode: an internal network blocks direct egress.
      // A socat sidecar bridges that network to the host
      // because Docker Desktop VMs don't forward gateway traffic.
      const mcpPort = core.proxy.port;
      const mitmPort = core.mitmAddr.port;
      const proxyUrl = tcpSidecarProxyUrl(core, mitmPort);

      env = {
        ...env,
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
      };
      transportProxyUrl = proxyUrl;

      // Write apt proxy config so sudo apt-get routes through the MITM proxy
      const aptProxyPath = resolve(core.orientationDir, 'apt-proxy.conf');
      stageAptProxyConfig(aptProxyPath, proxyUrl);
      mounts.push({ source: aptProxyPath, target: '/etc/apt/apt.conf.d/90-ironcurtain-proxy', readonly: true });

      const baseNetworkName = getInternalNetworkName(shortId);
      const networkName = attempt === 1 ? baseNetworkName : `${baseNetworkName}-a${attempt}`;
      const allocatedNetwork = await createDockerSessionTransportNetwork({
        runtime: core.docker,
        dockerWorkload: core.dockerWorkload,
        bundleId: core.bundleId,
        requestedName: networkName,
        allocation: { excludedSubnets },
      });
      allocatedNetworkSubnet = allocatedNetwork.subnet;
      internalNetwork = networkName;
      network = networkName;
      logger.info(`Allocated internal Docker network ${networkName} at ${allocatedNetwork.subnet}`);

      // The sidecar relays every tool call and the agent's CONNECT streams,
      // so it runs only from the locally built, build-hash-labelled image,
      // addressed by immutable ID (transport-sidecar-image.ts).
      const sidecarImageId = await ensureTransportSidecarImage(core.docker, (message) => {
        logger.info(message);
      });

      // The secondary bridge exists solely for the fixed host-facing forwards.
      const sidecarName = `${CONTAINER_NAME_PREFIX}sidecar-${shortId}`;
      const sidecarIp = tcpTransportSidecarAddress(allocatedNetwork.subnet);

      // Remove stale sidecar from a crashed previous session (TCP mode only).
      await core.docker.removeStaleContainer(sidecarName);

      sidecarContainerId = await createDockerSessionTransportProxy({
        dockerWorkload: core.dockerWorkload,
        requestedName: sidecarName,
        baseLabels: bundleLabels.labels,
        create: (requestedName, labels) =>
          core.docker.create({
            image: sidecarImageId,
            name: requestedName,
            network: networkName,
            ipv4Address: sidecarIp,
            mounts: [tcpTransportHostCaMount(core.orientationDir)],
            env: {},
            entrypoint: '/bin/sh',
            // Read-only, unprivileged, no new privileges, on the transport
            // share of the Docker Desktop resource partition.
            ...hardenTransportSidecarCreate(buildDockerDesktopTransportCreateLimits(core.dockerDesktopResources)),
            ...bundleLabels,
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
      await startTcpTransportSidecar(core.docker, sidecarContainerId, networkName, sidecarIp, allocatedNetwork.subnet);
      extraHosts = [`${DOCKER_HOST_GATEWAY}:${sidecarIp}`];
      logger.info(`Sidecar ${sidecarName} bridging ports ${mcpPort},${mitmPort} at ${sidecarIp}`);
    } else {
      // UDS mode (Linux Docker AND apple-container >= 1.1.0):
      // --network none, proxy sockets mounted at /run/ironcurtain.
      const udsProxyUrl = 'http://127.0.0.1:18080';
      env = {
        ...env,
        HTTPS_PROXY: udsProxyUrl,
        HTTP_PROXY: udsProxyUrl,
      };
      transportProxyUrl = udsProxyUrl;
      network = null;

      // Write apt proxy config so sudo apt-get routes through the MITM
      // proxy. On apple-container we CANNOT bind-mount this file: it
      // lives inside `orientationDir`, and 1.1.0's virtiofs silently
      // drops a directory share when a file inside that directory is
      // ALSO `-v`-mounted (verified — /etc/ironcurtain vanishes). The
      // exec-based writer runs after start instead. Linux Docker keeps
      // the single-file bind mount.
      if (core.runtimeKind === 'apple-container') {
        execAptProxyUrl = udsProxyUrl;
      } else {
        const aptProxyPathUds = resolve(core.orientationDir, 'apt-proxy.conf');
        stageAptProxyConfig(aptProxyPathUds, udsProxyUrl);
        mounts.push({
          source: aptProxyPathUds,
          target: '/etc/apt/apt.conf.d/90-ironcurtain-proxy',
          readonly: true,
        });
      }

      // Mount ONLY the per-bundle proxy sockets into the container. The
      // sockets dir lives under a short `~/.ironcurtain/run/<bid12>/`
      // path (see `getBundleSocketsDir`) so host paths stay under
      // `sockaddr_un.sun_path`. Linux mounts the directory; apple-
      // container mounts each socket file so the runtime creates a
      // vsock relay per socket (see buildUdsSocketMounts). The
      // host-only MITM control socket lives in a sibling `host/` dir
      // and is never mounted.
      mounts.push(...buildUdsSocketMounts(core.runtimeKind, core.socketsDir));
    }

    // This capability is independent of the outer provider-proxy topology:
    // Apple mounts registry only for `images`, registry + packages for `packages`,
    // and no nested-Docker egress socket for `offline`.
    mounts.push(...buildDockerWorkloadEgressMounts(core));
    mounts.push(...buildDockerBuildShimMounts(core));

    // Mount conversation state directory for session resume (e.g., claude --continue)
    if (core.conversationStateDir && core.conversationStateConfig) {
      mounts.push({
        source: core.conversationStateDir,
        target: core.conversationStateConfig.containerMountPath,
        readonly: false,
      });
    }

    // Skills bind mount — read-only so the agent cannot modify staged
    // skills mid-session (preserves the cached-stager assumption and
    // the per-state filter's correctness). The target path is a
    // sibling of any other mount target by adapter contract.
    if (core.skillsMount) {
      mounts.push({ source: core.skillsMount.hostDir, target: core.skillsMount.target, readonly: true });
    }

    if (core.scriptsMount) {
      const source = requireStagedWorkflowScripts(core.workflowRunDir, core.scriptsMount.hostDir);
      mounts.push({ source, target: core.scriptsMount.target, readonly: true });
    }

    // Workflow runtime dependencies (see workflow-dependency-cache.ts). The
    // content-keyed shared base is verified, or rebuilt in a dedicated
    // short-lived provisioning container, and this run's own writable layer is
    // seeded from it. All of that finishes before the agent container exists:
    // the bind-mount sources are then final, and no agent turn can observe the
    // base or a partially seeded layer. Only the run layer is mounted here; the
    // shared base never enters an agent container.
    const dependencyLayers = listWorkflowDependencyLayers(core);
    if (dependencyLayers.length > 0) {
      const provisionerTransport: WorkflowDependencyProvisionerTransport = {
        network: network ?? 'none',
        extraHosts,
        proxyUrl: transportProxyUrl,
        allocatedNetworkSubnet,
        bundleLabels,
      };
      await ensureWorkflowDependencyLayers(dependencyLayers, (request) =>
        runWorkflowDependencyProvisioner(core, config, provisionerTransport, request),
      );
      // The run layer is shared by every bundle of the run, and the
      // read-write scopes' deterministic states and agents execute what is
      // installed there: a read-only scope may use it but never change it.
      for (const layer of dependencyLayers) {
        mounts.push({ source: layer.hostDir, target: layer.target, readonly: workspaceReadOnly });
      }
    }

    // Host-root daemons only: the agent's read-write host mounts are swept for
    // setuid/setgid and root-owned entries after each turn, at teardown, and
    // after a failed start below. `mounts` is final from here on.
    privilegedFileScanner = createBundlePrivilegedFileScanner(core, mounts);

    // Build the agent container create args for a given name + resolved labels.
    // `labels` is the base bundle labels in the ordinary case and the base merged
    // with the generation ownership label when the create is ledgered — the merge
    // itself lives in createLedgeredAgentContainer, so this closure just forwards.
    const agentStartup = prepareDockerAgentStartup(
      ['sleep', 'infinity'],
      planBundleAgentPrivileges(core, config.userConfig).startupProbeUser,
    );
    const createMainContainer = (name: string, labels: Readonly<Record<string, string>> | undefined): Promise<string> =>
      core.docker.create(
        buildAgentContainerConfig(core, config.userConfig, {
          image: mainImage,
          name,
          network: network ?? 'none',
          mounts,
          // Do NOT override PATH here. Docker `-e PATH=...` REPLACES the image's
          // PATH (it does not append), which would discard the base image's real
          // PATH — including the NVM directory where `node`/`npm` live on the x86
          // devcontainer base. Bare-`node` workflow helpers would then fail to
          // resolve. The workflow venv bin is instead prepended to the live
          // `$PATH` at exec time (see buildWorkflowExecCommand), which is
          // base-image-agnostic and preserves the image's own PATH. NODE_PATH is
          // likewise set only on those deterministic helper execs, so the agent's
          // own Node processes never resolve modules from the workflow layer.
          env,
          command: [...agentStartup.command],
          ...bundleLabels,
          labels,
          extraHosts,
        }),
      );

    // §8.2 step 1: ledger the agent container before create when a
    // Docker-workload bundle is admitted; ordinary sessions keep the
    // deterministic name and create directly. Shared with the PTY path.
    mainContainerId = await createLedgeredAgentContainer({
      dockerWorkload: core.dockerWorkload,
      runtimeKind: core.runtimeKind,
      runtime: core.docker,
      expectedImageId: core.imageResolution?.immutableImageId,
      requestedName: mainContainerName,
      baseLabels: bundleLabels.labels,
      mounts: [
        ...mounts,
        ...nestedDockerWiring.namedVolumeMounts.map((mount) => ({
          source: mount.name,
          target: mount.target,
          readonly: mount.readonly === true,
        })),
      ],
      create: createMainContainer,
    });

    await attachDockerDesktopAgentEgressNetwork(core, mainContainerId);
    options?.signal?.throwIfAborted();
    await core.docker.start(mainContainerId);
    logger.info(`Container started: ${mainContainerId.substring(0, 12)}`);
    await agentStartup.waitUntilReady(core.docker, mainContainerId, { signal: options?.signal });
    options?.signal?.throwIfAborted();

    // The Desktop sidecar is already adjudicated. Initialize and verify
    // package-build state in the blocked agent, then finalize the lease. Apple
    // activation remains below because its daemon bootstrap runs here too.
    if (core.runtimeKind === 'docker') {
      await activateNestedDockerWorkload({
        runtime: core.docker,
        runtimeKind: core.runtimeKind,
        containerId: mainContainerId,
        dockerWorkload: core.dockerWorkload,
        dockerDesktopAgentAccess: core.dockerDesktopAgentAccess,
        bootstrap: dockerWorkloadBootstrap,
        dockerWorkloadEgress: core.dockerWorkloadEgress,
        dockerBuildShim: core.dockerBuildShim,
      });
    }

    if (core.runtimeKind === 'docker') {
      await checkDockerContainerWritableStorage(core.docker, mainContainerId);
    }

    // tcp-hostonly: write the apt proxy config inside the container (the
    // Docker topologies bind-mount it; see execAptProxyUrl above).
    if (execAptProxyUrl !== undefined) {
      await writeAptProxyConfigViaExec(core.docker, mainContainerId, execAptProxyUrl);
    }

    // Connectivity check: verify the container can reach host proxies
    // through the internal network. Abort if unreachable. Host-only
    // bundles additionally assert the inverse — internet egress must be
    // blocked — and never fall back to a weaker configuration.
    if (core.topology === 'tcp-hostonly' && core.hostOnlyNetwork !== undefined && core.proxy.port !== undefined) {
      await checkHostOnlyConnectivity(core.docker, mainContainerId, core.hostOnlyNetwork.gateway, core.proxy.port);
    } else if (core.useTcp && internalNetwork !== undefined && core.proxy.port !== undefined) {
      if (core.mitmAddr.port === undefined) {
        throw new Error('tcp-sidecar bundle is missing its MITM proxy port');
      }
      try {
        await checkInternalNetworkConnectivity(
          core.docker,
          mainContainerId,
          core.proxy.port,
          core.mitmAddr.port,
          core.tcpTransport,
        );
      } catch (error) {
        if (error instanceof InternalNetworkConnectivityError) {
          throw new InternalNetworkConnectivityError(error.message, allocatedNetworkSubnet);
        }
        throw error;
      }
    }
    // An interrupt during the checks ends setup here, as in the PTY path,
    // instead of after the (possibly long) Apple nested-Docker activation.
    options?.signal?.throwIfAborted();

    // Same-VM activation: the container that just started IS the daemon
    // component. Bootstrap/adjudicate dockerd, preflight the pinned client,
    // provision the selected prepared inner image, record observations, and
    // activate the lease before any agent process is exec'd into it.
    if (core.runtimeKind === 'apple-container') {
      await activateNestedDockerWorkload({
        runtime: core.docker,
        runtimeKind: core.runtimeKind,
        containerId: mainContainerId,
        dockerWorkload: core.dockerWorkload,
        dockerDesktopAgentAccess: core.dockerDesktopAgentAccess,
        bootstrap: dockerWorkloadBootstrap,
        dockerWorkloadEgress: core.dockerWorkloadEgress,
        dockerBuildShim: core.dockerBuildShim,
      });
    }

    return {
      containerId: mainContainerId,
      containerName: mainContainerName,
      sidecarContainerId,
      internalNetwork,
      ...(privilegedFileScanner === undefined ? {} : { privilegedFileScanner }),
      ...(snapshotSelection.refusal === undefined ? {} : { snapshotRefusal: snapshotSelection.refusal }),
    };
  } catch (err) {
    // Revoke nested egress before removing a partial outer VM. This ordering is
    // the same for daemon bootstrap, build-trust preflight/canary, and activate
    // failures: no new registry/package request can race exact VM teardown.
    await stopDockerWorkloadEgressBestEffort(core.dockerWorkloadEgress, 'createSessionContainers');
    // Best-effort cleanup of any resources created before the failure.
    // All three resources are assigned as soon as `docker.create()` returns
    // (before any subsequent start or connectivity check), so failures at
    // any point inside the try block clean up whatever was created.
    const cleanup = await cleanupContainers(core.docker, {
      containerId: mainContainerId ?? null,
      sidecarContainerId: sidecarContainerId ?? null,
      networkName: internalNetwork ?? null,
    });
    // Delete the owner lease only on proven absence; otherwise leave a
    // released tombstone so reconciliation (the retry's included) reclaims
    // the partial resources while this process is still alive. A retry mints
    // a fresh lease.
    await finalizeManagedResourceLease(core.bundleId, { runtime: core.docker, teardownVerified: cleanup.verified });
    // The agent container existed, so its entrypoint may have run against the
    // host mounts: sweep them now that it is gone, as at a session end. Never
    // throws (nor does the lease finalization above), so the original failure
    // still propagates.
    if (mainContainerId !== undefined) {
      const report = await privilegedFileScanner?.scan('failed session start');
      const notice = deliverHostPrivilegedFilesNotice(report, core.onHostPrivilegedFiles);
      throw includeHostPrivilegedFilesInFailure(err, notice);
    }
    throw err;
  }
}

/**
 * Probes whether the container can reach host-side proxies via the socat
 * sidecar on the internal Docker network. Throws a descriptive error if not.
 */
export async function checkInternalNetworkConnectivity(
  docker: ContainerRuntime,
  containerId: string,
  mcpPort: number,
  mitmPort: number,
  credentials: TcpTransportCredentials | undefined,
  verifyMcp = true,
): Promise<void> {
  if (credentials === undefined || !/^[a-f0-9]{64}$/.test(credentials.mcpToken)) {
    throw new Error('TCP sidecar readiness requires per-bundle transport credentials');
  }
  const environment = {
    ...(verifyMcp ? { IRONCURTAIN_MCP_TCP_TOKEN: credentials.mcpToken } : {}),
    IRONCURTAIN_HTTP_PROXY_AUTHORIZATION: credentials.proxyAuthorization.header,
  };
  if (verifyMcp) {
    const mcpResult = await docker.exec(
      containerId,
      ['node', '/usr/local/bin/ironcurtain-mcp-bridge.mjs', '--health', `${DOCKER_HOST_GATEWAY}:${mcpPort}`],
      // Allow a small buffer above socat's 5s connect-timeout for docker exec/process startup overhead.
      6_000,
      undefined,
      undefined,
      environment,
    );
    if (mcpResult.exitCode !== 0) {
      throw new InternalNetworkConnectivityError(
        `Internal network connectivity check failed: MCP round-trip exited ${mcpResult.exitCode}; ` +
          `the sidecar could not reach the host proxy.`,
      );
    }
  }

  const healthRequest =
    'GET http://ironcurtain.invalid/__ironcurtain/health HTTP/1.1\\r\\n' +
    'Host: ironcurtain.invalid\\r\\nProxy-Authorization: %s\\r\\nConnection: close\\r\\n\\r\\n';
  const mitmResult = await docker.exec(
    containerId,
    [
      '/bin/sh',
      '-c',
      `printf '${healthRequest}' "$IRONCURTAIN_HTTP_PROXY_AUTHORIZATION" | socat -T5 - TCP:${DOCKER_HOST_GATEWAY}:${mitmPort},connect-timeout=5 | grep -q 'IRONCURTAIN_OK/1'`,
    ],
    6_000,
    undefined,
    undefined,
    environment,
  );
  if (mitmResult.exitCode !== 0) {
    throw new InternalNetworkConnectivityError(
      `Internal network connectivity check failed: MITM round-trip exited ${mitmResult.exitCode}; ` +
        `the sidecar could not reach the host proxy.`,
    );
  }
}

/**
 * Verifies that Docker's writable layer has space before an agent starts.
 * Docker Desktop can keep creating/starting containers after its VM disk is
 * full, while writes inside the container fail with ENOSPC. Claude Code then
 * exits 0 with no output after its initialization timeout, which otherwise
 * looks like a networking failure.
 */
export async function checkDockerContainerWritableStorage(
  docker: ContainerRuntime,
  containerId: string,
): Promise<void> {
  const result = await docker.exec(
    containerId,
    ['/bin/sh', '-c', 'probe="${HOME:-/home/codespace}/.ironcurtain-write-probe-$$"; mkdir "$probe" && rmdir "$probe"'],
    5_000,
  );
  if (result.exitCode === 0) return;

  const detail = toDisplayText(result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`, {
    maxLength: 2048,
  });
  const guidance = /ENOSPC|no space left on device/i.test(detail)
    ? 'Docker storage may be full; inspect it with `docker system df` and reclaim unused data or increase the disk limit.'
    : 'Inspect the container state, Docker daemon logs, and filesystem permissions.';
  throw new Error(`Docker container writable storage check failed: ${detail}. ${guidance}`);
}

/**
 * Writes /etc/apt/apt.conf.d/90-ironcurtain-proxy inside a running
 * container via exec (as root). Used by apple-container in both batch
 * and PTY modes — the single-file bind mount the Docker topologies use
 * is unworkable there: on `tcp-hostonly` (pre-1.1.0) `--mount` rejected
 * non-directory sources, and on `uds` (1.1.0+) a `-v <dir>/file` mount
 * whose source nests under the already-shared orientation dir silently
 * drops that dir share. The URL is built from IronCurtain's own
 * gateway/loopback address and OS-assigned port — runtime-generated
 * values, not untrusted input — so embedding it in the sh script is
 * safe.
 */
export async function writeAptProxyConfigViaExec(
  docker: ContainerRuntime,
  containerId: string,
  proxyUrl: string,
): Promise<void> {
  const content = renderAptProxyConfig(proxyUrl);
  const aptWrite = await docker.exec(
    containerId,
    ['sh', '-c', 'printf %s "$IRONCURTAIN_APT_PROXY_CONFIG" > /etc/apt/apt.conf.d/90-ironcurtain-proxy'],
    10_000,
    'root',
    undefined,
    { IRONCURTAIN_APT_PROXY_CONFIG: content },
  );
  if (aptWrite.exitCode !== 0) {
    throw new Error(
      `Failed to write apt proxy config in container (exit=${aptWrite.exitCode}): ${toDisplayText(aptWrite.stderr, { maxLength: 2048 })}`,
    );
  }
}

/**
 * External address used to probe that internet egress is blocked. Any
 * globally-routable address works; the check asserts the connection
 * FAILS, so the probe never carries data off the machine on a healthy
 * setup.
 */
const EGRESS_PROBE_ADDRESS = '1.1.1.1:443';

/**
 * Fail-closed startup gate for the tcp-hostonly topology
 * (docs/designs/apple-container-runtime.md, design decision 4). Asserts
 * from inside the container that (a) the host-side proxies are reachable
 * at the vmnet gateway and (b) internet egress is blocked by the
 * host-only network. Either failure aborts session initialization —
 * never a silent fallback to a weaker network configuration. Shared by
 * batch (`createSessionContainers`) and PTY (`runPtySession`) modes.
 */
export async function checkHostOnlyConnectivity(
  docker: ContainerRuntime,
  containerId: string,
  gateway: string,
  mcpPort: number,
): Promise<void> {
  const reach = await docker.exec(
    containerId,
    ['socat', '-u', '/dev/null', `TCP:${gateway}:${mcpPort},connect-timeout=5`],
    6_000,
  );
  if (reach.exitCode !== 0) {
    throw new Error(
      `Host-only network connectivity check failed (exit=${reach.exitCode}). ` +
        `The container cannot reach host-side proxies at gateway ${gateway}:${mcpPort}. ` +
        `Check that the host-only network exists and the proxies are listening.`,
    );
  }

  const egress = await docker.exec(
    containerId,
    ['socat', '-u', '/dev/null', `TCP:${EGRESS_PROBE_ADDRESS},connect-timeout=3`],
    5_000,
  );
  if (egress.exitCode === 0) {
    throw new Error(
      `Host-only network egress check failed: the container reached ${EGRESS_PROBE_ADDRESS}. ` +
        `The network is not blocking internet egress as required; refusing to start the session.`,
    );
  }
}

/**
 * Whether an OAuth credential set can be refreshed: true only when a
 * non-empty refresh token is present. Externally-managed Codex tokens
 * (`auth_mode: 'chatgptAuthTokens'`) carry an empty refresh token and must
 * NOT be refreshed by IronCurtain. Pure helper, exported for testability.
 */
export function canRefreshOAuth(refreshToken: string): boolean {
  return refreshToken.length > 0;
}

/**
 * Resolves the real credential for a provider host.
 *
 * For Anthropic hosts in OAuth mode, uses the OAuth access token.
 * For all other cases, falls back to the API key from config.
 */
export function resolveRealKey(host: string, config: IronCurtainConfig, oauthAccessToken: string | undefined): string {
  const profile = config.activeProviderProfile;
  if (profile && profile.type !== 'native' && getGatewayDefinition(profile.type).host === host) {
    if (!profile.apiKey) logger.warn(`No API key configured for provider host: ${host}`);
    return profile.apiKey;
  }
  if (oauthAccessToken && ANTHROPIC_HOSTS.has(host)) {
    return oauthAccessToken;
  }
  if (oauthAccessToken && CODEX_CHATGPT_HOSTS.has(host)) {
    return oauthAccessToken;
  }

  let key: string;
  switch (host) {
    case 'api.anthropic.com':
    case 'platform.claude.com':
      key = config.userConfig.anthropicApiKey;
      break;
    case 'api.openai.com':
      key = config.userConfig.openaiApiKey;
      break;
    case 'chatgpt.com':
    case 'auth.openai.com':
      key = '';
      break;
    case 'generativelanguage.googleapis.com':
      key = config.userConfig.googleApiKey;
      break;
    default:
      logger.warn(`No API key mapping for unknown provider host: ${host}`);
      return '';
  }
  if (!key) {
    logger.warn(`No API key configured for provider host: ${host}`);
  }
  return key;
}

/**
 * Creates and seeds the conversation state directory for agents that
 * support session resume. Idempotent: skips seeding if the directory
 * already exists (resume case).
 *
 * As a defense-in-depth measure, always deletes stale credential files
 * (`.credentials.json` for Claude Code, `auth.json` for Codex) from the
 * state directory — the MITM proxy handles auth independently, and each
 * agent's entrypoint recreates its credential file from env on every
 * start, so any credential file lingering across resumes is stale. The
 * unlinks are no-ops for adapters whose state dir has neither file (e.g.
 * Goose), since a missing file is swallowed.
 */
export function prepareConversationStateDir(sessionDir: string, config: ConversationStateConfig): string {
  const stateDir = resolve(sessionDir, config.hostDirName);
  const isNew = !existsSync(stateDir);

  if (isNew) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    for (const entry of config.seed) {
      const content = typeof entry.content === 'function' ? entry.content() : entry.content;
      if (content === undefined) continue;

      const targetPath = resolve(stateDir, entry.path);
      // Reject paths that escape the state directory
      if (!targetPath.startsWith(stateDir + '/') && targetPath !== stateDir) {
        throw new Error(`Seed path escapes state directory: ${entry.path}`);
      }
      if (entry.path.endsWith('/') || content === '') {
        // Directory entry
        mkdirSync(targetPath, { recursive: true });
      } else {
        // File entry
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, content);
      }
    }
  }

  // Defense-in-depth: remove stale credential files on every start. The
  // entrypoint recreates them from env each start, so scrubbing host-side
  // is safe. Both unlinks are no-ops when the file is absent.
  for (const fileName of ['.credentials.json', 'auth.json']) {
    try {
      unlinkSync(resolve(stateDir, fileName));
    } catch {
      // File doesn't exist — expected on first run / other adapters
    }
  }

  return stateDir;
}

/**
 * Public pre-flight: resolves the adapter for `agentId`, makes sure the CA
 * and Docker manager are in place, and runs the same `ensureImage` work
 * that `prepareDockerInfrastructure` would do later.
 *
 * Why expose this: image pull/build streams progress to the parent
 * terminal (via the progress sink), and the CLI normally wraps session
 * init in an `ora` spinner. Running this BEFORE the spinner starts keeps
 * the two renderers from fighting for the same line. The inner
 * `ensureImage` call inside `prepareDockerInfrastructure` is content-hash
 * cached, so a second call from the session-init path is a cheap no-op.
 */
export async function ensureDockerImage(
  agentId: AgentId,
  userConfig: ResolvedUserConfig,
): Promise<AgentImageResolution> {
  const admitted = await resolveAdmittedDockerWorkload(userConfig);
  const admittedEnvironment = admitted?.environment;
  const admittedRuntimeKind =
    admittedEnvironment === undefined ? undefined : dockerWorkloadRuntimeKind(admittedEnvironment);
  const { registerBuiltinAdapters, getAgent } = await import('./agent-registry.js');
  const { createContainerRuntime, resolveRuntimeKind } = await import('./container-runtime.js');

  await registerBuiltinAdapters();
  const adapter = getAgent(agentId);
  const image = await adapter.getImage();
  const runtimeKind = admittedRuntimeKind ?? (await resolveRuntimeKind(userConfig.containerRuntime));
  // Same host-identity refusal as prepareDockerInfrastructure, placed before
  // the image build this preflight exists to run.
  const { resolveNetworkTopology } = await import('./network-topology.js');
  const topology = resolveNetworkTopology(
    runtimeKind,
    admittedEnvironment === undefined ? undefined : admittedEnvironment.egressTransport === 'tcp',
  );
  assertLinuxDockerHostIdentity(runtimeKind, topology !== 'uds');
  const docker = createContainerRuntime(runtimeKind, admittedEnvironment?.dockerEndpoint);
  let toolchainSource: DockerToolchainSource | undefined;
  if (admitted !== undefined) {
    toolchainSource = await resolveDockerToolchainSource(docker, admitted.environment.architecture);
    if (runtimeKind === 'docker') {
      selectDockerDesktopResourcePartition(
        userConfig,
        dockerDesktopVmCapacity(admitted.environment),
        admitted.environment.egressTransport === 'tcp',
      );
      await ensureDockerDesktopSidecarImage(docker, toolchainSource);
      if (admitted.configuration.networkAccess !== 'offline') {
        await ensureDockerDesktopRelayImage(docker);
      }
    }
  }
  const resolved: AgentImageResolution = {
    ...(await resolveAgentImage(image, docker, toolchainSource, agentImageBuildOptions(adapter, userConfig))),
    ...(admittedEnvironment === undefined ? {} : { dockerWorkloadEnvironment: admittedEnvironment }),
  };
  if (userConfig.dockerWorkload?.enabled === true && runtimeKind === 'apple-container') {
    const artifact = await prepareSelectedAgentArtifact({
      runtime: docker,
      logicalName: image,
      buildHash: resolved.buildHash,
    });
    return selectedAgentImageResolution(resolved, artifact);
  }
  if (userConfig.dockerWorkload?.enabled === true) return immutableAgentImageResolution(resolved, docker);
  return resolved;
}

async function resolveAdmittedDockerWorkload(
  userConfig: Pick<ResolvedUserConfig, 'containerRuntime' | 'dockerWorkload'>,
  preparedEnvironment?: AgentImageResolution['dockerWorkloadEnvironment'],
): Promise<
  | {
      readonly configuration: Extract<ResolvedDockerWorkloadConfig, { enabled: true }>;
      readonly environment: DockerWorkloadEnvironment;
    }
  | undefined
> {
  const workload = userConfig.dockerWorkload;
  if (workload?.enabled !== true) return undefined;

  const runtimeKind = await resolveRuntimeKind(userConfig.containerRuntime);
  assertDockerWorkloadVariantAdmitted(workload, runtimeKind);
  if (preparedEnvironment !== undefined) {
    if (dockerWorkloadRuntimeKind(preparedEnvironment) !== runtimeKind)
      throw new Error('Prepared nested-Docker runtime changed');
    return { configuration: workload, environment: preparedEnvironment };
  }
  const environment = await assertAdmittedDockerWorkloadRuntimeAvailable(runtimeKind, workload.networkAccess);
  return { configuration: workload, environment };
}

function selectedAgentImageResolution(
  built: AgentImageResolution,
  artifact: SelectedAgentArtifact,
): AgentImageResolution {
  return {
    mode: 'selected-agent-artifact',
    ...(built.dockerWorkloadEnvironment === undefined
      ? {}
      : { dockerWorkloadEnvironment: built.dockerWorkloadEnvironment }),
    ...(built.toolchainSource === undefined ? {} : { toolchainSource: built.toolchainSource }),
    logicalName: built.logicalName,
    imageRef: built.logicalName,
    buildHash: built.buildHash,
    immutableImageId: artifact.appleImageId,
    artifact,
  };
}

/**
 * Pin the outer agent by immutable image ID without manufacturing an
 * inner-daemon transport archive. Inspects the exact build (`imageRef`, its
 * build tag) rather than the moving alias; the pinned resolution names the
 * logical image, as the nested-Docker identity checks expect.
 */
async function immutableAgentImageResolution(
  built: AgentImageResolution,
  runtime: Pick<ContainerRuntime, 'inspectImage'>,
): Promise<AgentImageResolution> {
  const inspected = await runtime.inspectImage(built.imageRef);
  if (inspected === undefined) throw new Error(`prepared agent image is absent: ${built.imageRef}`);
  if (SHA256_IMAGE_ID.exec(inspected.id) === null) {
    throw new Error(`prepared agent image has an invalid immutable ID: ${inspected.id}`);
  }
  if (inspected.labels[IMAGE_BUILD_HASH_LABEL] !== built.buildHash) {
    throw new Error(`prepared agent image build hash changed after preparation: ${built.imageRef}`);
  }
  return { ...built, imageRef: built.logicalName, immutableImageId: inspected.id };
}

/**
 * Checks that an image resolution names the selected agent and, for a
 * nested-Docker runtime, is pinned the way that runtime requires. Exported for
 * tests.
 */
export function assertPreparedImageResolution(
  resolution: AgentImageResolution,
  expectedLogicalName: string,
  runtimeKind: ContainerRuntimeKind | undefined,
): void {
  if (resolution.logicalName !== expectedLogicalName) {
    throw new Error(`prepared agent image does not match selected agent: ${expectedLogicalName}`);
  }
  // Ordinary sessions create from the exact build tag of the resolved build
  // (or the logical name on a runtime without tagging); nested-Docker
  // resolutions name the logical image and pin an immutable ID below.
  const exactBuild = isImageBuildTagOf(resolution.imageRef, expectedLogicalName, resolution.buildHash);
  if (resolution.imageRef !== expectedLogicalName && (runtimeKind !== undefined || !exactBuild)) {
    throw new Error(`prepared agent image does not match selected agent: ${expectedLogicalName}`);
  }
  if (runtimeKind === undefined) return;
  if (runtimeKind === 'apple-container') {
    if (
      resolution.mode !== 'selected-agent-artifact' ||
      resolution.artifact === undefined ||
      resolution.immutableImageId !== resolution.artifact.appleImageId ||
      resolution.buildHash !== resolution.artifact.buildHash ||
      resolution.logicalName !== resolution.artifact.logicalName
    ) {
      throw new Error('prepared Apple nested-Docker agent image is incomplete or internally inconsistent');
    }
    return;
  }
  if (
    resolution.mode !== 'build-if-stale' ||
    resolution.artifact !== undefined ||
    resolution.immutableImageId === undefined ||
    SHA256_IMAGE_ID.exec(resolution.immutableImageId) === null
  ) {
    throw new Error('prepared Docker Desktop agent image is not pinned by an immutable image ID');
  }
}

/**
 * Builds `image` from a fresh temp directory populated with the contents of
 * `dockerDir`. Building from a clean
 * dir outside any git repo is REQUIRED for Apple `container build`, which
 * resolves an EMPTY context when handed a git-tracked source directory (the
 * repo's docker/ in a checkout/worktree) — making `COPY` fail with "not
 * found"; harmless on Docker. The Dockerfiles only COPY files that live in
 * `dockerDir` / `extraFiles`.
 */
async function buildImageFromCleanContext(
  docker: ContainerRuntime,
  image: string,
  dockerDir: string,
  dockerfile: string,
  labels: Record<string, string>,
  buildArgs?: Readonly<Record<string, string>>,
  buildOptions?: ImageBuildOptions,
): Promise<void> {
  const tmpContext = mkdtempSync(resolve(tmpdir(), 'ironcurtain-build-'));
  try {
    for (const entry of readdirSync(dockerDir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (!entry.isFile()) throw new Error(`unsupported Docker build-context entry: ${entry.name}`);
      copyFileSync(resolve(dockerDir, entry.name), resolve(tmpContext, entry.name));
    }
    await docker.buildImage(image, resolve(tmpContext, dockerfile), tmpContext, labels, buildArgs, buildOptions);
  } finally {
    rmSync(tmpContext, { recursive: true, force: true });
  }
}

interface AgentImageBuildSpec {
  readonly toolchainSource?: DockerToolchainSource;
  readonly dockerDir: string;
  readonly baseDockerfile: string;
  readonly baseImage: string;
  readonly baseBuildHash: string;
  readonly agentDockerfile: string;
  readonly agentBuildHash: string;
  /** Build args selecting an overridden agent CLI version (none for the pin). */
  readonly cliBuildArgs: Readonly<Record<string, string>>;
}

/** Inputs of an agent image build beyond the checked-in Dockerfiles. */
export interface AgentImageBuildOptions {
  /**
   * Build args selecting an overridden agent CLI version
   * (`resolveAgentCliBuildArgs`). Folded into the agent build hash; absent or
   * empty for the pinned version.
   */
  readonly cliBuildArgs?: Readonly<Record<string, string>>;
}

/** The CLI-version build args for `adapter` under `userConfig`'s `agentCliVersions`. */
export function agentImageBuildOptions(
  adapter: Pick<AgentAdapter, 'cliVersion'>,
  userConfig: Pick<ResolvedUserConfig, 'agentCliVersions'>,
): AgentImageBuildOptions {
  return { cliBuildArgs: resolveAgentCliBuildArgs(adapter.cliVersion, userConfig.agentCliVersions) };
}

/**
 * Resolve an agent image through exactly one trusted image mode. The image is
 * built (when absent) under its build tag, and `imageRef` is that tag when the
 * runtime can tag images: containers are created from the exact build this
 * resolution checked, never from the moving `:latest` alias.
 */
export async function resolveAgentImage(
  image: string,
  docker: ContainerRuntime,
  toolchainSource?: DockerToolchainSource,
  buildOptions?: AgentImageBuildOptions,
): Promise<AgentImageResolution> {
  const spec = computeAgentImageBuildSpec(image, toolchainSource, buildOptions);
  const imageRef = await ensureImageFromSpec(image, docker, spec);
  return {
    mode: 'build-if-stale',
    logicalName: image,
    imageRef,
    buildHash: spec.agentBuildHash,
    ...(toolchainSource === undefined ? {} : { toolchainSource }),
  };
}

/** Which images `ironcurtain images rebuild` rebuilds without the layer cache. */
export type AgentImageRebuildScope = 'agent' | 'agent-and-base';

/**
 * Rebuilds an agent image (and, for `agent-and-base`, its base) without the
 * build cache, so a `latest` CLI override or the base's packages are fetched
 * again, then points the build tag and the logical alias at the new image.
 * The build hash is unchanged: the inputs did not change. With
 * `toolchainSource`, the nested-Docker build of the image is rebuilt (its
 * base embeds that Docker toolchain).
 */
export async function rebuildAgentImage(
  image: string,
  docker: ContainerRuntime,
  scope: AgentImageRebuildScope,
  buildOptions?: AgentImageBuildOptions,
  toolchainSource?: DockerToolchainSource,
): Promise<AgentImageResolution> {
  const spec = computeAgentImageBuildSpec(image, toolchainSource, buildOptions);
  const imageRef = await ensureImageFromSpec(image, docker, spec, scope);
  return {
    mode: 'build-if-stale',
    logicalName: image,
    imageRef,
    buildHash: spec.agentBuildHash,
    ...(toolchainSource === undefined ? {} : { toolchainSource }),
  };
}

/** The base and agent image identities this checkout expects for `image` (no runtime access). */
export interface AgentImageBuildDescription {
  readonly logicalName: string;
  readonly buildHash: string;
  readonly buildTag: string;
  readonly dockerfile: string;
  readonly base: {
    readonly logicalName: string;
    readonly buildHash: string;
    readonly buildTag: string;
    readonly dockerfile: string;
  };
}

/**
 * Describes the build of `image` for status reporting: the ordinary build, or
 * with `toolchainSource` the nested-Docker build sessions resolve for that
 * Docker toolchain (its identity is part of the base build hash).
 */
export function describeAgentImageBuild(
  image: string,
  buildOptions?: AgentImageBuildOptions,
  toolchainSource?: DockerToolchainSource,
): AgentImageBuildDescription {
  const spec = computeAgentImageBuildSpec(image, toolchainSource, buildOptions);
  return {
    logicalName: image,
    buildHash: spec.agentBuildHash,
    buildTag: imageBuildTag(image, spec.agentBuildHash),
    dockerfile: spec.agentDockerfile,
    base: {
      logicalName: spec.baseImage,
      buildHash: spec.baseBuildHash,
      buildTag: imageBuildTag(spec.baseImage, spec.baseBuildHash),
      dockerfile: spec.baseDockerfile,
    },
  };
}

/**
 * Resolve the purpose-built Desktop daemon image through the normal hash-label
 * cache, then pin it: the result is the immutable ID the tag named at that
 * moment, verified to carry this recipe's build hash and the daemon role. The
 * sidecar is later created from that ID, so another install retagging the
 * shared tag cannot swap the daemon build mid-preparation.
 */
export async function ensureDockerDesktopSidecarImage(
  runtime: ContainerRuntime,
  toolchainSource: DockerToolchainSource,
): Promise<DockerDesktopSidecarImage> {
  const contextDirectory = resolve(getIronCurtainPackageRoot(), 'docker', 'nested-daemon');
  const dockerfilePath = resolve(contextDirectory, 'Dockerfile');
  const buildHash = computeDockerBuildHash(
    contextDirectory,
    ['Dockerfile', 'entrypoint.sh', 'runtime-shim/main.go'],
    JSON.stringify(toolchainSource),
  );
  if (await isImageStale(DOCKER_DESKTOP_SIDECAR_IMAGE, runtime, buildHash)) {
    logger.info('Building Docker Desktop nested-daemon image...');
    await runtime.buildImage(
      DOCKER_DESKTOP_SIDECAR_IMAGE,
      dockerfilePath,
      contextDirectory,
      {
        'ironcurtain.build-hash': buildHash,
      },
      { IRONCURTAIN_DOCKER_SOURCE: toolchainSource.reference },
    );
    logger.info('Docker Desktop nested-daemon image built successfully');
  }
  return assertDockerDesktopSidecarImage(
    await runtime.inspectImage(DOCKER_DESKTOP_SIDECAR_IMAGE),
    { buildHash },
    DOCKER_DESKTOP_SIDECAR_IMAGE,
  );
}

/**
 * Build and resolve the small fixed-target relay through the normal image cache.
 * The build hash covers the Dockerfile (whose Go builder names an exact
 * release), main.go and go.mod, so a Go toolchain bump, which edits the
 * Dockerfile and go.mod, rebuilds relay images already on users' machines.
 */
export async function ensureDockerDesktopRelayImage(runtime: ContainerRuntime): Promise<string> {
  const contextDirectory = resolve(getIronCurtainPackageRoot(), 'docker', 'nested-relay');
  const dockerfilePath = resolve(contextDirectory, 'Dockerfile');
  const buildHash = computeDockerBuildHash(contextDirectory, ['Dockerfile', 'main.go', 'go.mod']);
  if (await isImageStale(DOCKER_DESKTOP_RELAY_IMAGE, runtime, buildHash)) {
    logger.info('Building Docker Desktop fixed-target relay image...');
    await runtime.buildImage(DOCKER_DESKTOP_RELAY_IMAGE, dockerfilePath, contextDirectory, {
      'ironcurtain.build-hash': buildHash,
    });
    logger.info('Docker Desktop fixed-target relay image built successfully');
  }
  const inspected = await runtime.inspectImage(DOCKER_DESKTOP_RELAY_IMAGE);
  if (
    inspected === undefined ||
    SHA256_IMAGE_ID.exec(inspected.id) === null ||
    inspected.labels['ironcurtain.build-hash'] !== buildHash ||
    inspected.labels['com.ironcurtain.docker-workload.component'] !== 'fixed-relay'
  ) {
    throw new Error('Docker Desktop fixed-target relay image did not resolve to its expected immutable build');
  }
  return inspected.id;
}

function computeAgentImageBuildSpec(
  image: string,
  toolchainSource?: DockerToolchainSource,
  buildOptions?: AgentImageBuildOptions,
): AgentImageBuildSpec {
  const packageRoot = getIronCurtainPackageRoot();
  const dockerDir = resolve(packageRoot, 'docker');

  // On arm64 hosts (Apple Silicon), use the lightweight arm64-native Dockerfile
  const baseDockerfile =
    (toolchainSource?.architecture ?? arch()) === 'arm64' && existsSync(resolve(dockerDir, 'Dockerfile.base.arm64'))
      ? 'Dockerfile.base.arm64'
      : 'Dockerfile.base';

  // Agent images are CA-neutral. Session-specific public trust is staged in
  // the read-only orientation mount by stageRuntimeTrust(). `:latest` is the
  // moving alias; builds live under their build tags (imageBuildTag).
  const baseImage = BASE_IMAGE_LOGICAL_NAME;
  const baseBuildHash = computeDockerBuildHash(
    dockerDir,
    [baseDockerfile, 'mcp-bridge.mjs'],
    toolchainSource === undefined ? undefined : JSON.stringify(toolchainSource),
  );

  const agentName = image.replace(CONTAINER_NAME_PREFIX, '').replace(':latest', '');
  const agentDockerfile = `Dockerfile.${agentName}`;
  const agentDockerfilePath = resolve(dockerDir, agentDockerfile);
  if (!existsSync(agentDockerfilePath)) {
    throw new Error(`Dockerfile not found for agent "${agentName}": ${agentDockerfilePath}`);
  }
  // The CLI-version override is a build input the Dockerfile does not show,
  // so it is folded into the hash: changing it rebuilds the image, and
  // workflow snapshots of the other build are not resumed.
  const cliBuildArgs = buildOptions?.cliBuildArgs ?? {};
  const agentBuildHash = computeDockerBuildHash(dockerDir, [agentDockerfile], baseBuildHash, cliBuildArgs);
  return {
    dockerDir,
    baseDockerfile,
    baseImage,
    baseBuildHash,
    agentDockerfile,
    agentBuildHash,
    toolchainSource,
    cliBuildArgs,
  };
}

/** Exact build hash recorded on the current checked-in agent image. */
export function computeAgentImageBuildHash(image: string, buildOptions?: AgentImageBuildOptions): string {
  return computeAgentImageBuildSpec(image, undefined, buildOptions).agentBuildHash;
}

/**
 * Makes sure an agent image of `spec`'s build is present and returns the
 * reference to create containers from (its build tag when the runtime can
 * tag). `rebuild` forces a cache-less build of the agent, or of the base and
 * the agent.
 */
async function ensureImageFromSpec(
  image: string,
  docker: ContainerRuntime,
  spec: AgentImageBuildSpec,
  rebuild?: AgentImageRebuildScope,
): Promise<string> {
  // The agent hash incorporates the base hash. A current selected agent is
  // therefore self-sufficient even when the base tag was not staged (the
  // selected OCI archive already carries its base layers): the base is only
  // resolved when the agent must be built.
  return ensureImageBuild(
    docker,
    image,
    spec.agentBuildHash,
    async (agentTag) => {
      const baseRef = await ensureImageBuild(
        docker,
        spec.baseImage,
        spec.baseBuildHash,
        async (baseTag) => {
          logger.info('Building base Docker image (this may take a while on first run)...');
          await buildImageFromCleanContext(
            docker,
            baseTag,
            spec.dockerDir,
            spec.baseDockerfile,
            { [IMAGE_BUILD_HASH_LABEL]: spec.baseBuildHash },
            spec.toolchainSource === undefined
              ? undefined
              : { IRONCURTAIN_DOCKER_SOURCE: spec.toolchainSource.reference },
            rebuild === 'agent-and-base' ? { noCache: true } : undefined,
          );
          logger.info('Base Docker image built successfully');
        },
        rebuild === 'agent-and-base',
      );
      logger.info(`Building Docker image ${agentTag}...`);
      await buildImageFromCleanContext(
        docker,
        agentTag,
        spec.dockerDir,
        spec.agentDockerfile,
        { [IMAGE_BUILD_HASH_LABEL]: spec.agentBuildHash },
        // The exact base build just resolved, never the moving alias.
        { ...spec.cliBuildArgs, IRONCURTAIN_BASE_IMAGE: baseRef },
        rebuild === undefined ? undefined : { noCache: true },
      );
      logger.info(`Docker image ${agentTag} built successfully`);
    },
    rebuild !== undefined,
  );
}

/**
 * Returns the reference of an image of `buildHash` under `logicalName`'s
 * repository, calling `build(tag)` first when none is present or `rebuild` is
 * set. With a runtime that can tag images, the image lives under its build tag
 * ({@link imageBuildTag}) and the logical alias is pointed at it afterwards; an
 * image from before build tags existed is adopted when its label matches. A
 * runtime without tagging keeps the logical tag as the only reference.
 * Every reuse is decided by the full `ironcurtain.build-hash` label, never by
 * the tag alone.
 */
async function ensureImageBuild(
  docker: ContainerRuntime,
  logicalName: string,
  buildHash: string,
  build: (tag: string) => Promise<void>,
  rebuild: boolean,
): Promise<string> {
  if (docker.tagImage === undefined) {
    if (rebuild || (await isImageStale(logicalName, docker, buildHash))) await build(logicalName);
    return logicalName;
  }
  const buildTag = imageBuildTag(logicalName, buildHash);
  let current = !rebuild && !(await isImageStale(buildTag, docker, buildHash));
  if (!rebuild && !current && !(await isImageStale(logicalName, docker, buildHash))) {
    // Built before build tags existed: adopt it. Re-check the label through
    // the new tag, since the alias may have been re-pointed in between.
    await docker.tagImage(logicalName, buildTag);
    current = !(await isImageStale(buildTag, docker, buildHash));
  }
  if (!current) {
    await build(buildTag);
    if (await isImageStale(buildTag, docker, buildHash)) {
      throw new Error(`Docker image ${buildTag} does not carry the build hash it was just built from`);
    }
  }
  // Keep the moving alias on the build this checkout resolved last: manual
  // `docker run`, doctor's resource probe and the nested-Docker artifact
  // capture (which re-verifies the label) address it by name. A rebuild keeps
  // the hash, so the alias's label cannot tell the old image from the new.
  if (rebuild || (await isImageStale(logicalName, docker, buildHash))) await docker.tagImage(buildTag, logicalName);
  return buildTag;
}

/**
 * Wraps an in-container command so the workflow dependency bins are prepended
 * to the container's LIVE `$PATH` at exec time, rather than replacing the
 * image's PATH at container-creation time.
 *
 * Why a runtime shell instead of an `-e PATH=...` env: Docker `-e` REPLACES the
 * image PATH (it does not append), which would discard the base image's own
 * PATH — including the NVM directory where `node`/`npm` live on the x86
 * devcontainer base. Expanding `$PATH` inside the container at exec time is
 * base-image-agnostic: it preserves whatever PATH the image ships and merely
 * prepends the workflow venv bin (for bare `python`) and the installed Node
 * package bins (`node_modules/.bin`).
 *
 * `NODE_PATH` is exported here too, and only here: deterministic helpers
 * `require()` the workflow's Node packages from `/workflow-scripts`, but the
 * agent's own Node processes (the agent CLI itself) must not resolve modules
 * from the run's writable dependency layer, so the container env never sets it.
 *
 * Returns the original command unchanged when neither dependency layer is
 * present, so non-dependency workflows keep the plain exec path.
 *
 * The orchestrator runs the result under the in-container wall clock
 * (`runBoundedContainerCommand` in `turn-timeout.ts`), which goes outside
 * this wrapper: `/usr/bin/timeout` is named by absolute path, so the PATH
 * this shell sets cannot shadow it, and it bounds the shell and the command
 * alike.
 *
 * Shell-safety: the only interpolated values are the hardcoded container
 * constants `WORKFLOW_PYTHON_VENV_DIR` / `WORKFLOW_NODE_MODULES_DIR`. The
 * caller's command and its arguments are passed verbatim as positional
 * parameters consumed by `exec "$@"` — never string-interpolated — so no
 * word-splitting or injection is possible.
 */
export function buildWorkflowExecCommand(
  bundle: Pick<DockerInfrastructure, 'workflowPythonVenvMount' | 'workflowNodeModulesMount'>,
  command: readonly string[],
): readonly string[] {
  const prefixDirs: string[] = [];
  if (bundle.workflowPythonVenvMount) prefixDirs.push(`${WORKFLOW_PYTHON_VENV_DIR}/bin`);
  if (bundle.workflowNodeModulesMount) prefixDirs.push(`${WORKFLOW_NODE_MODULES_DIR}/.bin`);
  if (prefixDirs.length === 0 || command.length === 0) return command;

  const exports = [`export PATH=${prefixDirs.join(':')}:"$PATH"`];
  if (bundle.workflowNodeModulesMount) exports.push(`export NODE_PATH=${WORKFLOW_NODE_MODULES_DIR}`);
  // `exec "$@"` runs the original argv verbatim; the leading `sh` is $0.
  return ['/bin/sh', '-lc', `${exports.join('; ')}; exec "$@"`, 'sh', ...command];
}

/**
 * Transport facts the dependency provisioner reuses from the agent container's
 * plan, so its registry traffic flows only through this bundle's MITM proxy:
 * the same network (`none` for UDS), host aliases and in-container proxy URL.
 */
interface WorkflowDependencyProvisionerTransport {
  readonly network: string;
  readonly extraHosts: readonly string[] | undefined;
  readonly proxyUrl: string;
  readonly allocatedNetworkSubnet: string | undefined;
  readonly bundleLabels: ReturnType<typeof buildBundleLabels>;
}

/** Bound on each in-container dependency install. */
const WORKFLOW_DEPENDENCY_INSTALL_TIMEOUT_MS = 1_200_000;

/**
 * Builds the requested shared dependency bases in a dedicated, short-lived
 * provisioning container that no agent ever shares. Called by
 * `ensureWorkflowDependencyLayers` with the bundle's lock held, before the
 * agent container exists.
 *
 * Isolation of the provisioning container:
 * - started from the pristine agent image (`core.image`), never from a
 *   workflow snapshot (`baseImageOverride`), whose writable layer a previous
 *   run's agent controlled;
 * - no workspace, conversation state, skills, scripts, nested-Docker wiring or
 *   adapter environment (so no fake provider keys); the manifests arrive as the
 *   exact hashed bytes on a read-only mount, the trust store as the public CA
 *   certificate only;
 * - registry egress only through this bundle's MITM proxy: in UDS topologies
 *   only the MITM socket is mounted (not the Code Mode proxy socket), in TCP
 *   topologies it joins the bundle's internal network with the same host alias.
 *   That network's sidecar also forwards the Code Mode proxy port, which has no
 *   per-session credential, so on TCP topologies install scripts could reach
 *   the policy-mediated tool-call path; the agent container, where these
 *   installs used to run, has the same reach and more.
 *
 * The container is removed before this returns, and its absence is confirmed:
 * packages' install scripts run in it, and a process they left behind must not
 * be able to write a base after the host has recorded its manifest.
 */
async function runWorkflowDependencyProvisioner(
  core: PreContainerInfrastructure,
  config: IronCurtainConfig,
  transport: WorkflowDependencyProvisionerTransport,
  request: WorkflowDependencyProvisionRequest,
): Promise<void> {
  if (core.dockerWorkload !== undefined) {
    // prepareDockerInfrastructure rejects this combination; never create an
    // unledgered container inside an admitted nested-Docker lease.
    throw new Error('workflow dependency provisioning is not supported in an admitted nested-Docker bundle');
  }

  const trustDir = resolve(request.scratchDir, 'trust');
  mkdirSync(trustDir, { mode: 0o700 });
  stageRuntimeTrust(trustDir, core.ca.certPem);

  const mounts: { source: string; target: string; readonly: boolean }[] = [
    { source: trustDir, target: '/etc/ironcurtain', readonly: true },
    { source: request.manifestsDir, target: WORKFLOW_DEPENDENCY_MANIFESTS_DIR, readonly: true },
  ];
  if (!core.useTcp) {
    // The entrypoint bridges this socket to the in-container proxy URL.
    mounts.push({
      source: resolve(core.socketsDir, 'mitm-proxy.sock'),
      target: `${CONTAINER_SOCKETS_DIR}/mitm-proxy.sock`,
      readonly: false,
    });
  }
  for (const layer of request.layers) {
    mounts.push({ source: layer.baseDir, target: layer.target, readonly: false });
  }

  const name = `${CONTAINER_NAME_PREFIX}deps-${getBundleShortId(core.bundleId)}`;
  const privileges = planBundleAgentPrivileges({ ...core, dockerWorkload: undefined }, config.userConfig);
  const startup = prepareDockerAgentStartup(['sleep', 'infinity'], privileges.startupProbeUser);
  let containerId: string | undefined;
  let failure: Error | undefined;
  try {
    await core.docker.removeStaleContainer(name);
    containerId = await core.docker.create(
      buildAgentContainerConfig(
        {
          runtimeKind: core.runtimeKind,
          useTcp: core.useTcp,
          dockerWorkload: undefined,
          dockerWorkloadBootstrap: undefined,
          dockerDesktopAgentAccess: undefined,
          dockerDesktopResources: core.dockerDesktopResources,
        },
        config.userConfig,
        {
          image: core.image,
          name,
          network: transport.network,
          mounts,
          env: {
            ...buildRuntimeTrustEnv(),
            ...buildPackageClientEnv(),
            ...(core.tcpTransport === undefined
              ? {
                  HTTPS_PROXY: transport.proxyUrl,
                  HTTP_PROXY: transport.proxyUrl,
                }
              : {}),
          },
          ...(core.tcpTransport === undefined
            ? {}
            : {
                privateEnv: {
                  HTTPS_PROXY: transport.proxyUrl,
                  HTTP_PROXY: transport.proxyUrl,
                },
              }),
          command: [...startup.command],
          bundleLabel: transport.bundleLabels.bundleLabel,
          labels: transport.bundleLabels.labels,
          extraHosts: transport.extraHosts === undefined ? undefined : [...transport.extraHosts],
        },
      ),
    );
    await core.docker.start(containerId);
    await startup.waitUntilReady(core.docker, containerId);

    if (core.topology === 'tcp-hostonly' && core.hostOnlyNetwork !== undefined && core.proxy.port !== undefined) {
      await checkHostOnlyConnectivity(core.docker, containerId, core.hostOnlyNetwork.gateway, core.proxy.port);
    } else if (core.useTcp && core.proxy.port !== undefined && core.mitmAddr.port !== undefined) {
      try {
        await checkInternalNetworkConnectivity(
          core.docker,
          containerId,
          core.proxy.port,
          core.mitmAddr.port,
          core.tcpTransport,
          false,
        );
      } catch (error) {
        if (error instanceof InternalNetworkConnectivityError) {
          throw new InternalNetworkConnectivityError(error.message, transport.allocatedNetworkSubnet);
        }
        throw error;
      }
    }

    for (const layer of request.layers) {
      const label = layer.kind === 'python-venv' ? 'Python' : 'Node';
      logger.info(`Provisioning workflow ${label} dependency base into ${layer.target} (container ${name})`);
      const result = await core.docker.exec(
        containerId,
        ['/bin/sh', '-lc', buildWorkflowDependencyProvisionScript(layer)],
        WORKFLOW_DEPENDENCY_INSTALL_TIMEOUT_MS,
        // A sudo-off bundle (agentSudo: false) execs by numeric UID only.
        privileges.execUser ?? 'codespace',
        '/tmp',
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Workflow ${label} dependency provisioning failed: ${toDisplayText(result.stderr || result.stdout, { maxLength: 4096 })}`,
        );
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  if (containerId !== undefined) {
    await core.docker.remove(containerId);
    if (await core.docker.containerExists(containerId)) {
      failure ??= new Error(
        `Workflow dependency provisioning container ${name} could not be removed; refusing to trust the base it wrote`,
      );
    }
  }
  // Package install scripts ran here with the agent's privileges against the
  // host-backed base directories. Where container root is host root, sweep
  // them like an agent's mounts now that the container is gone, before the
  // caller records the base (so the record matches the stripped tree).
  const report = await createBundlePrivilegedFileScanner(core, mounts)?.scan('workflow dependency provisioning');
  const notice = deliverHostPrivilegedFilesNotice(report, core.onHostPrivilegedFiles);
  if (failure !== undefined) throw includeHostPrivilegedFilesInFailure(failure, notice);
}

async function isImageStale(image: string, docker: ContainerRuntime, expectedHash: string): Promise<boolean> {
  const storedHash = await docker.getImageLabel(image, IMAGE_BUILD_HASH_LABEL);
  return storedHash !== expectedHash;
}

/**
 * Content hash of one image recipe: the staleness key stamped as
 * `ironcurtain.build-hash`.
 *
 * `inputs` are paths relative to `dockerDir`. Every listed input must exist,
 * so a typo or a moved file fails loudly instead of silently dropping out of
 * the key. A listed directory is hashed recursively. Top-level entries keep the
 * established scan (listed files, every `*.sh`, and the Apple relay for the
 * arm64 base), so existing images keep their hashes; nested inputs such as
 * `runtime-shim/main.go`, which a Dockerfile COPYs from a subdirectory, are
 * hashed after it. The parent image's hash follows, then `buildArgs`: build
 * args that select inputs the Dockerfiles do not show (the agent CLI version
 * override). Pins written as ARG defaults are part of the Dockerfile text, so
 * bumping one changes the hash.
 */
export function computeDockerBuildHash(
  dockerDir: string,
  inputs: readonly string[],
  parentHash?: string,
  buildArgs?: Readonly<Record<string, string>>,
): string {
  const hash = createHash('sha256');
  const listed = new Set(inputs.map((input) => validateDockerBuildInput(dockerDir, input)));

  const files = readdirSync(dockerDir).sort();
  for (const file of files) {
    const isAppleVmRelayInput = file === 'apple-vm-egress-relay.mjs' && listed.has('Dockerfile.base.arm64');
    if (listed.has(file) || file.endsWith('.sh') || isAppleVmRelayInput) hashDockerBuildInput(hash, dockerDir, file);
  }
  for (const input of [...listed].filter((candidate) => candidate.includes('/')).sort()) {
    hashDockerBuildInput(hash, dockerDir, input);
  }

  if (parentHash) {
    hash.update(`parent:${parentHash}\n`);
  }

  // Sorted so the hash does not depend on object key order; absent when no
  // override applies, so the default build keeps its Dockerfile-only hash.
  for (const [name, value] of Object.entries(buildArgs ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(`build-arg:${name}=${value}\n`);
  }

  return hash.digest('hex');
}

/** Normalize one listed build input and prove it exists inside the build context. */
function validateDockerBuildInput(dockerDir: string, input: string): string {
  const normalized = input
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  if (
    normalized === '' ||
    isAbsolute(input) ||
    normalized.split('/').includes('..') ||
    normalized !== relative(dockerDir, resolve(dockerDir, normalized))
  ) {
    throw new Error(`Docker build input must be a relative path inside the build context: ${input}`);
  }
  let stats;
  try {
    stats = lstatSync(resolve(dockerDir, normalized));
  } catch (error) {
    throw new Error(`Docker build input is missing: ${resolve(dockerDir, normalized)}`, { cause: error });
  }
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new Error(`Docker build input must be a regular file or directory: ${resolve(dockerDir, normalized)}`);
  }
  return normalized;
}

/** Fold one input into the hash; directories contribute every regular file below them in sorted order. */
function hashDockerBuildInput(hash: ReturnType<typeof createHash>, dockerDir: string, relativePath: string): void {
  const path = resolve(dockerDir, relativePath);
  const stats = lstatSync(path);
  if (stats.isDirectory()) {
    for (const child of readdirSync(path).sort()) hashDockerBuildInput(hash, dockerDir, `${relativePath}/${child}`);
    return;
  }
  if (!stats.isFile()) throw new Error(`Docker build input must be a regular file or directory: ${path}`);
  hash.update(`file:${relativePath}\n`);
  hash.update(readFileSync(path));
}

/**
 * Map of provider canonical hostnames to environment variable names
 * that can override the upstream target URL. platform.claude.com is
 * intentionally excluded — platform endpoints should not be redirected.
 */
const UPSTREAM_ENV_VARS: ReadonlyMap<string, string> = new Map([
  ['api.anthropic.com', 'ANTHROPIC_BASE_URL'],
  ['api.openai.com', 'OPENAI_BASE_URL'],
  ['generativelanguage.googleapis.com', 'GOOGLE_API_BASE_URL'],
]);

/**
 * Strips credentials and query parameters from a URL string for safe logging.
 * Returns only scheme + hostname + port + pathname.
 */
function sanitizeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    // Reconstruct with only safe components
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch {
    return '<invalid URL>';
  }
}

/**
 * Applies upstream target overrides from environment variables to provider configs.
 *
 * For each provider whose host has a corresponding env var set, parses the URL
 * and returns a new ProviderConfig with the upstreamTarget field populated.
 * If the env var is set but invalid, falls back to configBaseUrls before
 * giving up. Providers without any valid override are returned unchanged.
 */
export function applyUpstreamOverrides(
  providers: readonly ProviderConfig[],
  parser: (baseUrl: string) => UpstreamTarget,
  configBaseUrls?: Readonly<Record<string, string>>,
): ProviderConfig[] {
  return providers.map((config) => {
    const envVar = UPSTREAM_ENV_VARS.get(config.host);
    if (!envVar) return config;

    // Try env var first, then configBaseUrls fallback
    const sources: Array<{ label: string; url: string }> = [];
    const envValue = process.env[envVar];
    if (envValue) sources.push({ label: envVar, url: envValue });
    const configUrl = configBaseUrls?.[config.host];
    if (configUrl) sources.push({ label: 'config', url: configUrl });

    for (const { label, url } of sources) {
      try {
        const upstreamTarget = parser(url);
        logger.info(`[docker] ${config.displayName}: upstream override via ${label} → ${sanitizeUrlForLog(url)}`);
        return { ...config, upstreamTarget };
      } catch (err) {
        logger.warn(
          `[docker] ${config.displayName}: ignoring invalid ${label}="${sanitizeUrlForLog(url)}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return config;
  });
}
