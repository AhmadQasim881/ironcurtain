import { getGatewayDefinition } from '../config/provider-definitions.js';
/**
 * Diagnostic check functions for `ironcurtain doctor`.
 *
 * Each check is a thin wrapper around an existing helper. Functions in
 * this module MUST NOT call process.exit — the entry point alone is
 * responsible for translating results into an exit code so unit tests
 * can call check functions directly without short-circuits.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { checkSandboxViability, type PreflightCheckResult } from '../utils/preflight-checks.js';
import { isEnvVarProvided, passthroughEnvNames } from '../trusted-process/child-env.js';
import { collectDeclaredEnvVars, isMcpServersConfigError } from '../config/mcp-servers-overlay.js';
import { checkDockerAvailable, classifyDockerUserNamespace, type DockerAvailability } from '../docker/docker-probe.js';
import { checkAppleContainerAvailable } from '../docker/apple-container-manager.js';
import { resolveRuntimeKind, type ContainerRuntimeKind } from '../docker/container-runtime.js';
import { ROOT_HOST_IDENTITY_MESSAGE } from '../docker/container-identity.js';
import { detectAuthMethod, readOnlyCredentialSources } from '../docker/oauth-credentials.js';
import {
  clampDockerResources,
  isImagePresent,
  probeDockerResources,
  type ClampedDockerResources,
  type ExecFileFn,
  type HostResources,
  type ProbeResult as ResourceProbeResult,
  type ResourceProbeBin,
} from '../docker/resource-limits.js';
import { getAgent, registerBuiltinAdapters } from '../docker/agent-registry.js';
import type { AgentId } from '../docker/agent-adapter.js';
import {
  createLanguageModel,
  findHostModelRoutingWarnings,
  parseModelId,
  resolveHostModelApiKey,
  resolveHostModelId,
  type ProviderId,
} from '../config/model-provider.js';
import {
  NATIVE_PROFILE_NAME,
  findUnknownUserConfigFields,
  hostRoleModelId,
  resolveActiveProfile,
  type HostModelRole,
  type UnknownConfigField,
} from '../config/user-config.js';
import {
  loadGeneratedPolicy,
  getPackageGeneratedDir,
  findAnnotationServerDrift,
  findMissingDynamicLists,
  loadConfig,
} from '../config/index.js';
import { computeConstitutionHash, getUserConfigPath } from '../config/paths.js';
import {
  damagedToolAnnotationsFile,
  serverNameForCommand,
  SHIPPED_ANNOTATIONS_DAMAGED_HINT,
  type OverlayResolution,
  type ToolAnnotationsOverlayReport,
} from '../config/tool-annotations-overlay.js';
import type { IronCurtainConfig, MCPServerConfig, SandboxAvailabilityPolicy } from '../config/types.js';
import { invalidPolicyArtifact } from '../types/policy-schema.js';
import { isObjectWithProp } from '../utils/is-plain-object.js';
import {
  createProbeEnvironment,
  probeConfiguredServer,
  type ProbeEnvironment,
  type ProbeEnvironmentOptions,
  type ProbeOk,
  type ProbeResult,
  type ServerProbe,
} from './mcp-liveness.js';
import { hostModelKeyStatus } from './model-credential-checks.js';
import {
  diffServerSchemas,
  driftRemedy,
  hasServerDrift,
  serverDriftAffectsPolicy,
  summarizeServerDrift,
  type ServerSchemaDrift,
} from '../trusted-process/schema-drift.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import {
  NODE_PTY_SPAWN_HELPER_ISSUE_URL,
  nodePtyRemediation,
  probeNodePty,
  type NodePtyProbe,
} from '../pty/node-pty-loader.js';
import type { StoredToolAnnotationsFile } from '../pipeline/types.js';
import {
  OS_SANDBOX_INSTALL_HINT,
  describeOsSandboxProblems,
  getOsSandboxAvailability,
  isOsSandboxFixableByInstall,
  planServerSandboxing,
  requiresOsSandbox,
  runOsSandboxSmokeTest,
  withOsSandboxSmokeResult,
  type OsSandboxAvailability,
  type OsSandboxSmokeResult,
} from '../trusted-process/sandbox-integration.js';
import { effectiveSandboxPolicy, readSandboxPolicyEnv } from '../config/sandbox-policy.js';
import { runMemoryModelsTool, type MemoryModelEntry, type MemoryModelsRunner } from '../memory/memory-models.js';
import { UPDATE_MEMORY_SERVER_HINT, memoryServerHasReviewQuarantine } from '../memory/memory-server-exports.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly message: string;
  /** Optional remediation suggestion shown indented under the result. */
  readonly hint?: string;
}

/**
 * Fully supported (tested) major lines: the even-numbered Node.js releases
 * supported by isolated-vm 7.0.1.
 */
const SUPPORTED_MAJORS = [24, 26];

export function checkNodeVersion(versionString: string = process.versions.node): CheckResult {
  const match = /^(\d+)\.(\d+)/.exec(versionString);
  const major = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(major)) {
    return {
      name: 'Node.js',
      status: 'fail',
      message: `unrecognized version "${versionString}"`,
      hint: `Install Node.js 24 or 26 from https://nodejs.org/`,
    };
  }
  if (!SUPPORTED_MAJORS.includes(major)) {
    return {
      name: 'Node.js',
      status: 'fail',
      message: `${versionString} (unsupported)`,
      // isolated-vm 7.0.1 ships prebuilds for linux-x64, linux-arm64,
      // darwin-arm64 and win32-x64 only.
      hint:
        'IronCurtain supports Node.js 24 or 26. isolated-vm has prebuilt binaries for both on Linux, ' +
        'Apple silicon Macs and 64-bit Windows; elsewhere, Intel Macs included, npm compiles it, ' +
        'which needs a C++ toolchain (Xcode Command Line Tools on macOS).',
    };
  }
  return {
    name: 'Node.js',
    status: 'ok',
    message: versionString,
  };
}

/**
 * Runs the V8 sandbox (isolated-vm) viability check for real, bypassing the
 * start-up cache marker in the IronCurtain home: doctor neither trusts a
 * marker written by another Node.js or isolated-vm build nor writes one.
 */
export async function checkSandbox(
  check: () => Promise<PreflightCheckResult> = () => checkSandboxViability({ useCache: false }),
): Promise<CheckResult> {
  const result = await check();
  if (result.ok) {
    return { name: 'V8 sandbox', status: 'ok', message: 'OK' };
  }
  return {
    name: 'V8 sandbox',
    status: 'fail',
    message: result.message,
    hint: result.details,
  };
}

/**
 * Whether node-pty loads (its native addon included). The mux, the web UI
 * terminal and Apple Container interactive sessions need it; `start` does
 * not, so a missing node-pty is a warning. Read-only like the rest of
 * doctor: a macOS spawn-helper without its execute bit is reported, not
 * repaired (the mux repairs it at start when it can write the file).
 */
export async function checkNodePty(probe: () => Promise<NodePtyProbe> = () => probeNodePty()): Promise<CheckResult> {
  const name = 'node-pty';
  const result = await probe();
  switch (result.status) {
    case 'ok':
      return { name, status: 'ok', message: result.version === undefined ? 'loads' : `loads (${result.version})` };
    case 'unavailable':
      return {
        name,
        status: 'warn',
        message: `${result.installed ? 'cannot be loaded' : 'is not installed'}: ${toDisplayText(truncateForMessage(result.detail))}`,
        hint:
          'ironcurtain mux, the web UI terminal and Apple Container interactive sessions need it. ' +
          nodePtyRemediation(process.platform, result.installed),
      };
    case 'spawn-helper-not-executable':
      return {
        name,
        status: 'warn',
        message: `spawn-helper is not executable, so every terminal spawn fails: ${toDisplayText(result.helperPath)}`,
        hint:
          'ironcurtain mux adds the execute bit when it can write the file; otherwise run ' +
          `chmod +x "${toDisplayText(result.helperPath)}" (see ${NODE_PTY_SPAWN_HELPER_ISSUE_URL}).`,
      };
  }
}

/** Injectable probes for {@link checkOsSandbox}. */
export interface OsSandboxCheckDeps {
  /** Dependency check (default: sandbox-runtime's platform + bwrap/socat/rg check). */
  readonly availability?: () => OsSandboxAvailability;
  /** srt smoke run, only executed when the dependency check passes. */
  readonly smokeTest?: () => Promise<OsSandboxSmokeResult>;
}

export interface OsSandboxCheck {
  readonly result: CheckResult;
  /** Servers that will not start because their OS sandbox is unavailable ("enforce"). */
  readonly refused: ReadonlySet<string>;
  /**
   * The availability sessions plan with (the dependency check, with a failed
   * srt smoke run folded in); the liveness probes plan their srt wrapping
   * from it.
   */
  readonly availability: OsSandboxAvailability;
  /** The effective sandboxPolicy. */
  readonly policy: SandboxAvailabilityPolicy;
}

/**
 * Reports whether MCP servers that ask for an OS sandbox (filesystem, git
 * and google-workspace by default) will get one, separately from the V8
 * isolate check above:
 *
 *   - no configured server asks for one             -> ok (not needed)
 *   - available and the srt smoke run passes        -> ok
 *   - unavailable, sandboxPolicy "enforce"          -> fail (those servers are refused)
 *   - unavailable, sandboxPolicy "warn"             -> warn (those servers run unconfined)
 *
 * "Unavailable" lists what sandbox-runtime found missing (bubblewrap
 * (bwrap), socat and ripgrep (rg) on Linux, or an unsupported platform) or,
 * with the dependencies present, why the srt smoke run failed: sessions
 * treat a host where srt cannot start a sandbox as unavailable too
 * (`resolveOsSandboxAvailability`).
 */
export async function checkOsSandbox(
  config: IronCurtainConfig,
  deps: OsSandboxCheckDeps = {},
): Promise<OsSandboxCheck> {
  const name = 'OS sandbox';
  const policy = effectiveSandboxPolicy(config);
  const policyLabel = `sandboxPolicy "${policy}"${describePolicyOverride()}`;
  const needing = Object.entries(config.mcpServers)
    .filter(([, serverConfig]) => requiresOsSandbox(serverConfig))
    .map(([serverName]) => serverName);
  const dependencies = (deps.availability ?? getOsSandboxAvailability)();
  // As sessions decide it: the smoke run only when the dependencies are
  // present and a server needs the sandbox; a failed run makes it unavailable.
  const smoke =
    dependencies.available && needing.length > 0 ? await (deps.smokeTest ?? runOsSandboxSmokeTest)() : undefined;
  const availability = smoke === undefined ? dependencies : withOsSandboxSmokeResult(dependencies, smoke);
  const noRefusals: ReadonlySet<string> = new Set();

  if (!availability.available) {
    const why = describeOsSandboxProblems(availability);
    if (needing.length === 0) {
      return {
        result: { name, status: 'ok', message: `unavailable (${why}); not needed by any configured MCP server` },
        refused: noRefusals,
        availability,
        policy,
      };
    }
    const plan = planServerSandboxing(config.mcpServers, config.allowedDirectory, availability, policy);
    // Only missing helper binaries are fixed by installing packages; other
    // problems (e.g. root without CAP_SETFCAP) carry their own remedy.
    const fix = !availability.platformSupported
      ? 'OS sandboxing is not supported on this platform.'
      : isOsSandboxFixableByInstall(availability)
        ? `To fix, ${OS_SANDBOX_INSTALL_HINT}.`
        : 'To fix, resolve the problem above so sandbox-runtime can create a sandbox on this host.';
    if (policy === 'enforce') {
      return {
        result: {
          name,
          status: 'fail',
          message: `unavailable (${why}); ${plan.refused.join(', ')} will not start (${policyLabel})`,
          hint:
            `${fix} To run them without OS containment instead, set sandboxPolicy to "warn" ` +
            '(`ironcurtain config` > Security, or IRONCURTAIN_SANDBOX_POLICY=warn).',
        },
        refused: new Set(plan.refused),
        availability,
        policy,
      };
    }
    return {
      result: {
        name,
        status: 'warn',
        message: `unavailable (${why}); ${plan.unconfined.join(', ')} will run WITHOUT OS containment (${policyLabel})`,
        hint: `${fix} Set sandboxPolicy to "enforce" to refuse these servers instead.`,
      },
      refused: noRefusals,
      availability,
      policy,
    };
  }

  if (needing.length === 0 || smoke === undefined) {
    return {
      result: { name, status: 'ok', message: 'available; not needed by any configured MCP server' },
      refused: noRefusals,
      availability,
      policy,
    };
  }

  return {
    result: {
      name,
      status: 'ok',
      message: `available (srt smoke run ${formatElapsed(smoke.elapsedMs)}); sandboxed: ${needing.join(', ')}; ${policyLabel}`,
    },
    refused: noRefusals,
    availability,
    policy,
  };
}

/** " from IRONCURTAIN_SANDBOX_POLICY" when an environment variable sets the policy. */
function describePolicyOverride(): string {
  try {
    const fromEnv = readSandboxPolicyEnv();
    return fromEnv ? ` from ${fromEnv.source}` : '';
  } catch {
    // An invalid value already failed the config check.
    return '';
  }
}

/**
 * Reports Docker daemon status. Returns `warn` (not `fail`) on unavailability —
 * `checkPreferredMode` decides whether the warn is fatal based on the
 * user's `preferredMode`. Keeping this check semantically agnostic lets it
 * be reused in contexts that don't care about preferred mode.
 */
export async function checkDocker(
  probe: () => Promise<DockerAvailability> = checkDockerAvailable,
): Promise<CheckResult> {
  const status = await probe();
  if (status.available) {
    return { name: 'Docker', status: 'ok', message: 'running' };
  }
  return {
    name: 'Docker',
    status: 'warn',
    message: 'unavailable',
    hint: status.detailedMessage,
  };
}

/**
 * Reports Apple `container` runtime status. `skip` on platforms where the
 * backend is structurally unavailable (non-macOS, Intel, pre-macOS-26);
 * `warn` when the platform qualifies but the CLI/services are not ready —
 * `checkActiveRuntime` upgrades that to a fail when this backend is the
 * one sessions will actually use.
 */
export async function checkAppleContainer(
  probe: () => Promise<DockerAvailability> = checkAppleContainerAvailable,
  hostPlatform: string = platform(),
  hostArch: string = arch(),
): Promise<CheckResult> {
  if (hostPlatform !== 'darwin' || hostArch !== 'arm64') {
    return { name: 'Apple container', status: 'skip', message: 'not applicable (requires macOS on Apple silicon)' };
  }
  const status = await probe();
  if (status.available) {
    return { name: 'Apple container', status: 'ok', message: 'running' };
  }
  return {
    name: 'Apple container',
    status: status.reason.includes('macOS 26') ? 'skip' : 'warn',
    message: status.reason,
    hint: status.detailedMessage,
  };
}

/**
 * Reports whether Rosetta is installed. Only meaningful when the Apple
 * container backend is in play: its BuildKit builder VM requires Rosetta,
 * so agent-image builds fail without it. Probed by running an x86_64
 * binary under `arch` — exits 0 iff Rosetta can translate it.
 */
export function checkRosetta(
  runX86: () => boolean = () =>
    spawnSync('arch', ['-x86_64', '/usr/bin/true'], { stdio: 'ignore', timeout: 10_000 }).status === 0,
): CheckResult {
  if (runX86()) {
    return { name: 'Rosetta', status: 'ok', message: 'installed' };
  }
  return {
    name: 'Rosetta',
    status: 'warn',
    message: 'not installed — `container build` (agent images) will fail',
    hint: 'Install it with `softwareupdate --install-rosetta --agree-to-license`.',
  };
}

/** Output of checkActiveRuntime: the resolved backend plus its availability. */
export interface ActiveRuntime {
  readonly result: CheckResult;
  readonly kind: ContainerRuntimeKind;
  /** Human label for messages ("Docker" / "Apple container"). */
  readonly label: string;
  /** The availability CheckResult of the backend sessions will use. */
  readonly availability: CheckResult;
}

/**
 * Resolves which container runtime sessions will use (env override >
 * `containerRuntime` config > auto probe) and pairs it with the matching
 * availability result from the Environment section, so downstream checks
 * (preferred mode, resource limits) evaluate the backend that actually
 * runs — not unconditionally Docker.
 */
export async function checkActiveRuntime(
  config: IronCurtainConfig,
  dockerResult: CheckResult,
  appleResult: CheckResult,
): Promise<ActiveRuntime> {
  const configured = config.userConfig.containerRuntime;
  let kind: ContainerRuntimeKind;
  try {
    kind = await resolveRuntimeKind(configured);
  } catch (err) {
    // Invalid IRONCURTAIN_CONTAINER_RUNTIME value — sessions will throw too.
    return {
      result: {
        name: 'Container runtime',
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        hint: 'Unset IRONCURTAIN_CONTAINER_RUNTIME or set it to "docker" / "apple-container".',
      },
      kind: 'docker',
      label: 'Docker',
      availability: dockerResult,
    };
  }
  const label = kind === 'apple-container' ? 'Apple container' : 'Docker';
  const availability = kind === 'apple-container' ? appleResult : dockerResult;
  const source = process.env.IRONCURTAIN_CONTAINER_RUNTIME
    ? 'env override'
    : configured === 'auto'
      ? 'auto-detected'
      : 'config';
  return {
    result: { name: 'Container runtime', status: 'ok', message: `${kind} (${source})` },
    kind,
    label,
    availability,
  };
}

/**
 * Linux Docker agent containers inherit the host identity through the UID
 * remap, and the image cannot renumber the agent user to UID 0, so a root
 * coordinator fails at container start, after the image was built (audit
 * finding DINF-23). Reported here, and refused by the session preflight,
 * so the failure is visible before any session is attempted. Not applicable
 * to macOS Docker Desktop (VirtioFS maps identity) or apple-container (VM
 * identity), which skip the remap.
 */
export function checkHostIdentityForLinuxDocker(
  runtimeKind: ContainerRuntimeKind,
  hostPlatform: string = platform(),
  uid: number | undefined = process.getuid?.(),
): CheckResult {
  const name = 'Host identity';
  if (runtimeKind !== 'docker' || hostPlatform !== 'linux') {
    return { name, status: 'skip', message: 'not applicable (Linux Docker only)' };
  }
  if (uid === 0) {
    return {
      name,
      status: 'fail',
      message: 'running as root; Linux Docker agent sessions cannot start',
      hint: ROOT_HOST_IDENTITY_MESSAGE,
    };
  }
  return { name, status: 'ok', message: `uid ${uid === undefined ? 'unknown' : String(uid)} (non-root)` };
}

const HOST_ROOT_EXPOSURE_HINT =
  'Agent containers keep passwordless sudo by default, so a compromised agent can leave root-owned or setuid ' +
  'files in bind-mounted workspaces and conversation state. IronCurtain strips setuid/setgid bits from your ' +
  'files in those mounts and reports root-owned entries after each turn and at session end. Set ' +
  '"agentSudo": false in ~/.ironcurtain/config.json to run agents without sudo (no-new-privileges; needs ' +
  'IronCurtain to run as UID 1000). Rootless Docker and userns-remap do not yet work with ' +
  "IronCurtain's Linux UID remap.";

/**
 * Reports whether container root is real host root on the Linux Docker
 * daemon sessions will use (audit finding DINF-3). `ok` for rootless Docker
 * or userns-remap, `warn` otherwise; `skip` when the active runtime is not
 * Linux Docker or Docker is unavailable (the Environment section already
 * reports that). Reads `docker info` SecurityOptions through the shared
 * probe; never pulls or runs containers.
 */
export async function checkDockerUserNamespace(
  runtimeKind: ContainerRuntimeKind,
  dockerAvailable: boolean,
  hostPlatform: string = platform(),
  probe: () => Promise<DockerAvailability> = () => checkDockerAvailable(undefined, true),
): Promise<CheckResult> {
  const name = 'Docker user namespace';
  if (runtimeKind !== 'docker' || hostPlatform !== 'linux') {
    return { name, status: 'skip', message: 'not applicable (Linux Docker only)' };
  }
  if (!dockerAvailable) {
    return { name, status: 'skip', message: 'Docker unavailable' };
  }
  const status = await probe();
  if (!status.available || status.server === undefined) {
    return {
      name,
      status: 'warn',
      message: 'could not read Docker security options',
      hint: status.available ? 'docker info returned no SecurityOptions' : status.detailedMessage,
    };
  }
  switch (classifyDockerUserNamespace(status.server.securityOptions)) {
    case 'rootless':
      return { name, status: 'ok', message: 'rootless Docker (container root is not host root)' };
    case 'userns-remap':
      return { name, status: 'ok', message: 'userns-remap enabled (container root is not host root)' };
    case 'host-root':
      return {
        name,
        status: 'warn',
        message: 'container root is host root (no rootless Docker or userns-remap)',
        hint: HOST_ROOT_EXPOSURE_HINT,
      };
  }
}

/**
 * Reports whether the user's `preferredMode` is satisfiable on this host.
 *
 * Reuses the prior `dockerResult` from `checkDocker` so Docker is probed
 * exactly once per `doctor` run. Maps the (preferredMode × runtime availability ×
 * api-key-presence) tuple to a status:
 *
 *   - preferredMode: 'container' + active runtime ok          -> ok
 *   - preferredMode: 'container' + active runtime unavailable -> fail (sessions will refuse to start)
 *   - preferredMode: 'builtin' + API key present   -> ok
 *   - preferredMode: 'builtin' + no API key        -> warn (sessions will fail to start by default)
 */
export function checkPreferredMode(
  config: IronCurtainConfig,
  dockerResult: CheckResult,
  runtimeLabel = 'Docker',
): CheckResult {
  const preferredMode = config.userConfig.preferredMode;

  if (preferredMode === 'container') {
    if (dockerResult.status === 'ok') {
      return { name: 'Preferred mode', status: 'ok', message: 'container' };
    }
    return {
      name: 'Preferred mode',
      status: 'fail',
      message: `container, but ${runtimeLabel} is unavailable. Sessions will refuse to start.`,
      hint: `Start ${runtimeLabel}, or run \`ironcurtain config\` and set Session Mode > Preferred mode to "builtin".`,
    };
  }

  // preferredMode === 'builtin': the key the builtin agent's model needs,
  // resolved as session preflight resolves it (agentModelId and
  // hostModelProfiles.agent), not always Anthropic's.
  const key = hostModelKeyStatus(config.userConfig.agentModelId, config.userConfig, 'agent');
  if (key.present) {
    return { name: 'Preferred mode', status: 'ok', message: 'builtin' };
  }
  return {
    name: 'Preferred mode',
    status: 'warn',
    message: `builtin, but no ${key.needed} configured for ${toDisplayText(key.modelId, { maxLength: 80 })}. Sessions will fail.`,
    hint: key.hint,
  };
}

/**
 * Reports whether the user's Docker resource ceilings (after clamping)
 * are accepted by Docker. Two-step:
 *
 *   1. Clamp the configured `dockerResources` against host capacity. If
 *      clamping happened, mention it in the message so the user sees what
 *      they're actually getting.
 *   2. Resolve the preferred Docker agent's image. If it isn't present
 *      locally, skip the probe with status `ok` (we deliberately do NOT
 *      pull images from doctor). If it is present, run a tiny throwaway
 *      `docker run` to confirm Docker accepts the limits. Parse failures
 *      into actionable hints.
 *
 * Callers should only invoke this when `dockerResult.status === 'ok'`.
 *
 * Exported for testing; tests pass stubbed `execFile` and `resolveImage` deps.
 */
export interface CheckDockerResourcesDeps {
  readonly execFile?: ExecFileFn;
  readonly resolveImage?: (agentId: AgentId) => Promise<string>;
}

export async function checkDockerResources(
  config: IronCurtainConfig,
  deps: CheckDockerResourcesDeps = {},
  runtimeKind: ContainerRuntimeKind = 'docker',
): Promise<CheckResult> {
  const bin: ResourceProbeBin = runtimeKind === 'apple-container' ? 'container' : 'docker';
  const name = runtimeKind === 'apple-container' ? 'Container resource limits' : 'Docker resource limits';
  const clamp = clampDockerResources(config.userConfig.dockerResources);
  const summary = describeClamp(clamp);

  let image: string;
  try {
    image = await resolveAgentImage(config.userConfig.preferredDockerAgent, deps.resolveImage);
  } catch (err) {
    return {
      name,
      status: 'warn',
      message: `${summary}; could not resolve preferred-agent image`,
      hint: err instanceof Error ? err.message : String(err),
    };
  }

  // We deliberately do not pull images during a doctor run; if the image
  // isn't already on the host, the user hasn't started a session yet, so a
  // resource probe would just push work into the wrong command.
  if (!(await isImagePresent(image, deps.execFile, bin))) {
    return {
      name,
      status: 'ok',
      message: `${summary}; image ${image} not yet pulled — skipping probe`,
    };
  }

  const probe = await probeDockerResources(image, clamp.effective, deps.execFile, bin);
  const rejecter = runtimeKind === 'apple-container' ? 'Apple container' : 'Docker';
  return renderProbeResult(probe, summary, clamp.host, name, rejecter);
}

function describeClamp(clamp: ClampedDockerResources): string {
  const cpusLabel = clamp.effective.cpus === undefined ? 'unlimited' : `${clamp.effective.cpus} cpus`;
  const memLabel = clamp.effective.memoryMb === undefined ? 'unlimited' : `${clamp.effective.memoryMb} MB`;
  if (!clamp.clamped) {
    return `${cpusLabel}, ${memLabel}`;
  }
  // Report the pre-clamp values too so the user knows what they configured.
  const requestedCpus = clamp.requested.cpus === null ? 'unlimited' : `${clamp.requested.cpus} cpus`;
  const requestedMem = clamp.requested.memoryMb === null ? 'unlimited' : `${clamp.requested.memoryMb} MB`;
  return `${cpusLabel}, ${memLabel} (clamped from ${requestedCpus}, ${requestedMem} to fit host)`;
}

async function resolveAgentImage(
  agentId: AgentId | string,
  override?: (agentId: AgentId) => Promise<string>,
): Promise<string> {
  if (override) return override(agentId as AgentId);
  await registerBuiltinAdapters();
  return getAgent(agentId as AgentId).getImage();
}

function renderProbeResult(
  probe: ResourceProbeResult,
  summary: string,
  host: HostResources,
  name = 'Docker resource limits',
  rejecter = 'Docker',
): CheckResult {
  if (probe.ok) {
    return { name, status: 'ok', message: summary };
  }
  const suggested = probe.suggested ?? {};
  const hintParts: string[] = ['Run `ironcurtain config` and adjust Docker Agent > Container resources.'];
  if (suggested.cpus !== undefined) {
    hintParts.push(`Try cpus=${suggested.cpus}`);
  }
  if (suggested.memoryMb !== undefined) {
    hintParts.push(`Try memoryMb=${suggested.memoryMb}`);
  }
  // On macOS, the host snapshot can over-report what Docker Desktop's VM
  // will accept; surfacing it lets the user sanity-check against the VM's
  // allocation.
  hintParts.push(`(Host: ${host.cpus} cpus, ${host.memoryMb} MB.)`);
  return {
    name,
    status: 'fail',
    message: `${rejecter} rejected ${summary}: ${truncateForMessage(probe.stderr)}`,
    hint: hintParts.join(' '),
  };
}

function truncateForMessage(stderr: string): string {
  const cleaned = stderr.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 200) return cleaned;
  return `${cleaned.slice(0, 200)}…`;
}

export interface ConfigLoadOk {
  readonly result: CheckResult;
  readonly config: IronCurtainConfig;
}

export interface ConfigLoadFail {
  readonly result: CheckResult;
  readonly config: undefined;
}

/**
 * Loads ~/.ironcurtain/config.json read-only and reports the outcome.
 * Returns the resolved config alongside the CheckResult so subsequent checks
 * can reuse it without re-loading.
 *
 * The load never writes: a missing config.json is not created (the defaults
 * apply, as they would for a session), and no defaults are backfilled or
 * fields migrated. Running doctor first leaves the first-start wizard
 * pending (config/setup-state.ts), as running any other command first does.
 */
export function checkConfigLoad(
  load: () => IronCurtainConfig = () => loadConfig({ readOnly: true }),
): ConfigLoadOk | ConfigLoadFail {
  const exists = existsSync(getUserConfigPath());
  try {
    const config = load();
    const unknown = exists ? unknownConfigFieldsOnDisk() : [];
    if (unknown.length > 0) {
      const listed = unknown
        .map(({ field, suggestion }) => (suggestion ? `${field} (did you mean ${suggestion}?)` : field))
        .join(', ');
      return {
        result: {
          name: 'User config',
          status: 'warn',
          message: toDisplayText(`${unknown.length} unknown field(s) ignored: ${listed}`, { maxLength: 400 }),
          hint: `Fix or remove them in ${getUserConfigPath()}; their defaults apply meanwhile.`,
        },
        config,
      };
    }
    return {
      result: {
        name: 'User config',
        status: 'ok',
        message: exists
          ? 'parsed cleanly'
          : 'not created yet; the defaults apply (`ironcurtain setup` or the first `ironcurtain start` creates it)',
      },
      config,
    };
  } catch (err) {
    if (isMcpServersConfigError(err)) {
      return {
        result: {
          name: 'MCP servers',
          status: 'fail',
          message: err.message,
          hint: `Fix ${err.path} (\`ironcurtain mcp list\` shows the configured servers); see ADDING_MCP_SERVERS.md.`,
        },
        config: undefined,
      };
    }
    return {
      result: {
        name: 'User config',
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        hint: 'Run `ironcurtain config` to fix configuration issues.',
      },
      config: undefined,
    };
  }
}

/**
 * Fields of config.json the schema does not know (typos such as
 * `resourceBudget.maxStep`): the load ignores them and applies the defaults,
 * so `parsed cleanly` would be misleading. Empty when the file is absent.
 */
function unknownConfigFieldsOnDisk(): UnknownConfigField[] {
  try {
    return findUnknownUserConfigFields(JSON.parse(readFileSync(getUserConfigPath(), 'utf-8')) as unknown);
  } catch {
    return [];
  }
}

export interface PolicyLoadOk {
  readonly results: CheckResult[];
  readonly compiledPolicy: ReturnType<typeof loadGeneratedPolicy>['compiledPolicy'];
  /** The compiled-policy.json that was read (the user's or the shipped one). */
  readonly compiledPolicyPath: string;
  readonly toolAnnotations: ReturnType<typeof loadGeneratedPolicy>['toolAnnotations'];
  readonly toolAnnotationsOverlay: ToolAnnotationsOverlayReport;
  readonly dynamicLists: ReturnType<typeof loadGeneratedPolicy>['dynamicLists'];
}

export interface PolicyLoadFail {
  readonly results: CheckResult[];
  readonly compiledPolicy: undefined;
  readonly compiledPolicyPath: undefined;
  readonly toolAnnotations: undefined;
  readonly toolAnnotationsOverlay: undefined;
  readonly dynamicLists: undefined;
}

/**
 * Loads compiled-policy.json, dynamic-lists.json and tool-annotations.json
 * through the loader sessions use, which validates each against its schema
 * (src/types/policy-schema.ts). On success the caller can run drift checks
 * against the result; on failure one CheckResult names the file and every
 * offending field, with a hint for that file.
 */
export function checkPolicyArtifacts(config: IronCurtainConfig): PolicyLoadOk | PolicyLoadFail {
  try {
    const loaded = loadGeneratedPolicy({
      policyDir: config.generatedDir,
      toolAnnotationsDir: config.toolAnnotationsDir ?? config.generatedDir,
      fallbackDir: getPackageGeneratedDir(),
    });
    const results: CheckResult[] = [{ name: 'Policy artifacts', status: 'ok', message: 'present and valid' }];
    const missingLists = findMissingDynamicLists(loaded.compiledPolicy, loaded.dynamicLists);
    if (missingLists.length > 0) {
      results.push({
        name: 'Dynamic lists',
        status: 'warn',
        message: `no values for ${missingLists.map((name) => `@${name}`).join(', ')}; rules that use them match nothing`,
        hint: 'Run `ironcurtain refresh-lists` (or `ironcurtain compile-policy`).',
      });
    }
    return {
      results,
      compiledPolicy: loaded.compiledPolicy,
      compiledPolicyPath: loaded.compiledPolicyPath,
      toolAnnotations: loaded.toolAnnotations,
      toolAnnotationsOverlay: loaded.toolAnnotationsOverlay,
      dynamicLists: loaded.dynamicLists,
    };
  } catch (err) {
    return {
      results: [
        {
          name: 'Policy artifacts',
          status: 'fail',
          message: err instanceof Error ? err.message : String(err),
          hint: policyArtifactsHint(err),
        },
      ],
      compiledPolicy: undefined,
      compiledPolicyPath: undefined,
      toolAnnotations: undefined,
      toolAnnotationsOverlay: undefined,
      dynamicLists: undefined,
    };
  }
}

/**
 * Remediation for a policy-artifact load failure. compile-policy
 * regenerates compiled-policy.json only. Tool annotations ship with
 * IronCurtain; a damaged user overlay is removed with --reset, a damaged
 * shipped file needs a reinstall. A schema error in the lists file is a
 * hand edit to repair: its manual overrides live only there.
 */
function policyArtifactsHint(err: unknown): string {
  const damaged = damagedToolAnnotationsFile(err, getPackageGeneratedDir());
  if (damaged === 'shipped') return SHIPPED_ANNOTATIONS_DAMAGED_HINT;
  if (damaged === 'overlay') {
    return 'Run `ironcurtain annotate-tools --reset` to remove your tool annotations and use the shipped ones.';
  }
  switch (invalidPolicyArtifact(err)) {
    case 'compiled-policy':
      return 'Fix the listed fields, or run `ironcurtain compile-policy` to regenerate compiled-policy.json.';
    case 'dynamic-lists':
      return (
        'Fix the listed fields in dynamic-lists.json. Each list holds "values", "manualAdditions" and ' +
        '"manualRemovals" (arrays of strings), "resolvedAt" and "inputHash".'
      );
    case undefined:
      return (
        'Run `ironcurtain compile-policy` to regenerate compiled-policy.json. tool-annotations.json ships ' +
        'with IronCurtain; if it is missing, reinstall IronCurtain.'
      );
  }
}

/** Short reasons for the doctor's overlay report, keyed by resolution. */
const OVERLAY_REASONS: Record<OverlayResolution, string> = {
  'user-only': 'server not shipped',
  identical: 'same as shipped',
  pinned: 'pinned',
  superseded: 'stale copy of an earlier shipped revision',
  'same-input': 'differs for the same tools; ignored',
  user: 'annotated for different tools',
};

/**
 * Reports how the user's tool-annotations overlay relates to the reviewed
 * annotations shipped with IronCurtain. Warns when the user's annotations
 * replace the shipped ones for any server (divergent servers are listed), or
 * when a user entry is being ignored in favor of the shipped one.
 */
export function checkAnnotationOverlay(report: ToolAnnotationsOverlayReport): CheckResult {
  const name = 'Annotation overlay';
  if (report.overlayPath === undefined || report.decisions.length === 0) {
    return { name, status: 'ok', message: 'using the annotations shipped with IronCurtain' };
  }
  const describe = (resolution: OverlayResolution, legacy: boolean): string =>
    `${OVERLAY_REASONS[resolution]}${legacy && resolution === 'user' ? ', written by an older annotate-tools' : ''}`;
  const entries = (filter: (resolution: OverlayResolution) => boolean): string[] =>
    report.decisions
      .filter((d) => filter(d.resolution))
      .map((d) => `${serverNameForCommand(d.server)} (${describe(d.resolution, d.legacy)})`);

  // Servers whose effective annotations differ from the shipped, reviewed ones.
  const divergent = entries((r) => r === 'pinned' || r === 'user');
  const ignored = entries((r) => r === 'same-input');
  const custom = entries((r) => r === 'user-only');
  const stale = entries((r) => r === 'identical' || r === 'superseded');

  const parts: string[] = [];
  if (divergent.length > 0) parts.push(`overrides shipped annotations for: ${divergent.join(', ')}`);
  if (ignored.length > 0) parts.push(`ignored: ${ignored.join(', ')}`);
  if (custom.length > 0) parts.push(`custom servers: ${custom.join(', ')}`);
  if (stale.length > 0) parts.push(`stale copies (cleaned up by the next annotate-tools run): ${stale.join(', ')}`);

  if (divergent.length === 0 && ignored.length === 0) {
    return { name, status: 'ok', message: parts.join('; ') };
  }
  const firstServer = report.decisions.find(
    (d) => d.resolution === 'pinned' || d.resolution === 'user' || d.resolution === 'same-input',
  );
  return {
    name,
    status: 'warn',
    message: parts.join('; '),
    hint:
      `Review ${report.overlayPath}. ` +
      `\`ironcurtain annotate-tools --reset --server ${firstServer ? serverNameForCommand(firstServer.server) : '<name>'}\` ` +
      'restores the shipped annotations for a server.',
  };
}

/**
 * Compares the active constitution hash to the value baked into the
 * compiled policy. A mismatch means the constitution was edited without
 * recompiling. A match says nothing about how the policy was built:
 * compiler, engine and annotation changes leave the constitution hash
 * unchanged, so freshness is reported by the separate 'Policy provenance'
 * check (see policy-checks.ts).
 */
export function checkConstitutionDrift(
  config: IronCurtainConfig,
  compiledPolicy: { constitutionHash: string },
): CheckResult {
  let currentHash: string;
  try {
    currentHash = computeConstitutionHash(config.constitutionPath);
  } catch (err) {
    return {
      name: 'Compiled policy',
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Verify that constitution.md exists at the configured location.',
    };
  }
  if (currentHash === compiledPolicy.constitutionHash) {
    return { name: 'Compiled policy', status: 'ok', message: 'compiled from the current constitution' };
  }
  return {
    name: 'Compiled policy',
    status: 'warn',
    message: 'constitution has changed since last compile',
    hint: 'Run `ironcurtain compile-policy` to update compiled-policy.json.',
  };
}

/**
 * Reports drift between configured MCP servers and tool-annotations.json.
 * Uses the pure helper findAnnotationServerDrift so output goes through
 * the doctor renderer rather than stderr.
 */
export function checkAnnotationDrift(
  toolAnnotations: Parameters<typeof findAnnotationServerDrift>[0],
  mcpServers: Record<string, MCPServerConfig>,
): CheckResult {
  const { missing, orphaned } = findAnnotationServerDrift(toolAnnotations, mcpServers);
  if (missing.length === 0 && orphaned.length === 0) {
    return { name: 'Tool annotations', status: 'ok', message: 'in sync with mcp-servers.json' };
  }
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  if (orphaned.length > 0) parts.push(`orphaned: ${orphaned.join(', ')}`);
  const hint =
    missing.length > 0
      ? `Run \`ironcurtain annotate-tools --server ${missing[0]}\` for each missing server.`
      : 'Re-run `ironcurtain annotate-tools --all` to drop orphaned entries.';
  return {
    name: 'Tool annotations',
    status: 'warn',
    message: parts.join('; '),
    hint,
  };
}

/**
 * Reports per-MCP-server credential presence. Looks at
 * ({@link collectDeclaredEnvVars}):
 *   - `-e <VAR>` arguments (Docker convention used by mcp-servers.json)
 *   - keys of `config.env` that look like credentials or have an empty value
 * For each declared env var, the check passes if the value is set inline in
 * serverConfig.env or in serverCredentials[serverName], or -- for a `-e`
 * passthrough only -- in process.env: the same presence rule
 * (`isEnvVarProvided`, trusted-process/child-env.ts) the relay and the
 * in-process TrustedProcess apply before starting a server, so what doctor
 * reports OK is what sessions start. A host variable never reaches an `env`
 * key that is not forwarded with `-e` (children inherit an allowlist), so it
 * does not count for one.
 */
export function checkServerCredentials(
  serverName: string,
  serverConfig: MCPServerConfig,
  config: IronCurtainConfig,
): CheckResult {
  const required = collectDeclaredEnvVars(serverConfig);
  if (required.length === 0) {
    return { name: serverName, status: 'ok', message: 'no credentials required' };
  }
  const forwarded = new Set(passthroughEnvNames(serverConfig.args));
  const credentials = config.userConfig.serverCredentials[serverName];
  const missing = required.filter(
    (name) =>
      !isEnvVarProvided(name, {
        env: forwarded.has(name) ? process.env : {},
        configEnv: serverConfig.env,
        credentials,
      }),
  );
  if (missing.length === 0) {
    return {
      name: serverName,
      status: 'ok',
      message: `${required.length} credential${required.length === 1 ? '' : 's'} set`,
    };
  }
  return {
    name: serverName,
    status: 'warn',
    message: `missing: ${missing.join(', ')}`,
    hint: 'Set the env var(s) or run `ironcurtain config` to store the credentials.',
  };
}

/**
 * The env-var names a server declares (`-e <NAME>` argument pairs, and
 * credential-like or empty-valued keys of `config.env`). Lives with the
 * server configuration loader so the credential editor and `ironcurtain mcp
 * add` prompt for exactly what doctor checks; re-exported here for callers
 * of the doctor module.
 */
export { collectDeclaredEnvVars };

export interface ServerLivenessOptions {
  /**
   * Probe double for tests. The default ({@link probeConfiguredServer})
   * starts each server the way a session's relay does, srt included.
   */
  readonly probe?: ServerProbe;
  /** Servers sessions will not start (see {@link checkOsSandbox}); reported as skipped, not probed. */
  readonly refusedServers?: ReadonlySet<string>;
  /**
   * The effective tool annotations. When given, each probed server's live
   * tools are diffed against its entry (`schema-drift.ts`): drift that
   * changes what policy evaluates turns the server's line into a warning
   * naming the `annotate-tools` command; schema text that changed without
   * a policy effect is noted on the line.
   */
  readonly toolAnnotations?: StoredToolAnnotationsFile;
  /**
   * OS sandbox availability and effective sandboxPolicy, from
   * {@link checkOsSandbox}, for the probes' srt wrapping. Default: probed here.
   */
  readonly sandbox?: { readonly availability: OsSandboxAvailability; readonly policy: SandboxAvailabilityPolicy };
  /** Test seams for the probes' image and npx cache checks. */
  readonly environment?: Pick<ProbeEnvironmentOptions, 'isImageCached' | 'isNpxPackageCached'>;
}

/**
 * Probes every configured server, in parallel. Servers sessions will not
 * start (refused for an unavailable sandbox, or missing a declared
 * credential) are skipped without a spawn. The probes share one
 * environment (sandbox plan, scratch directories), created on first use and
 * removed before this returns.
 */
export async function checkMcpServerLiveness(
  config: IronCurtainConfig,
  options: ServerLivenessOptions = {},
): Promise<CheckResult[]> {
  const probe = options.probe ?? probeConfiguredServer;
  const entries = Object.entries(config.mcpServers);
  if (entries.length === 0) {
    return [
      {
        name: '(no servers configured)',
        status: 'skip',
        message: 'mcp-servers.json contains no entries',
      },
    ];
  }

  const shared: { environment?: ProbeEnvironment } = {};
  const environment = (): ProbeEnvironment => {
    shared.environment ??= createProbeEnvironment({
      config,
      availability: options.sandbox?.availability ?? getOsSandboxAvailability(),
      policy: options.sandbox?.policy ?? effectiveSandboxPolicy(config),
      ...options.environment,
    });
    return shared.environment;
  };

  try {
    const tasks = entries.map(async ([name, serverConfig]): Promise<CheckResult> => {
      if (options.refusedServers?.has(name)) {
        return { name, status: 'skip', message: 'skipped — sessions will not start it (OS sandbox unavailable)' };
      }
      if (checkServerCredentials(name, serverConfig, config).status === 'warn') {
        return { name, status: 'skip', message: 'skipped — missing creds' };
      }
      const result = await probe(name, serverConfig, {
        credentials: config.userConfig.serverCredentials[name] ?? {},
        environment,
      });
      return formatProbeResult(name, result, options.toolAnnotations);
    });
    return await Promise.all(tasks);
  } finally {
    shared.environment?.dispose();
  }
}

function formatProbeResult(name: string, result: ProbeResult, annotations?: StoredToolAnnotationsFile): CheckResult {
  if (result.status === 'skip') return { name, status: 'skip', message: result.message };
  if (result.status === 'ok') {
    const elapsed = formatElapsed(result.elapsedMs);
    const summary = `${result.toolCount} tool${result.toolCount === 1 ? '' : 's'}, ${elapsed}${result.sandboxed === true ? ', sandboxed' : ''}`;
    const drift = probeAnnotationDrift(name, result, annotations);
    if (drift === undefined) return { name, status: 'ok', message: summary };
    if (!serverDriftAffectsPolicy(drift)) {
      return { name, status: 'ok', message: `${summary}; annotation schemas differ in text only (no policy effect)` };
    }
    const release = describeReleases(result.serverInfo, annotations?.servers[name]?.serverInfo);
    return {
      name,
      status: 'warn',
      message: `${summary}; annotations drifted${release}: ${summarizeServerDrift(drift)}`,
      hint: driftRemedy(name),
    };
  }
  return {
    name,
    status: 'fail',
    message: `failed after ${formatElapsed(result.elapsedMs)}`,
    hint: toDisplayText(result.reason, { maxLength: 1500 }),
  };
}

/**
 * The drift between a probed server's live tools and its annotations entry,
 * or undefined when there is none to report (no annotations, no entry for
 * the server, a probe double without `tools`, or a match).
 */
function probeAnnotationDrift(
  name: string,
  result: ProbeOk,
  annotations: StoredToolAnnotationsFile | undefined,
): ServerSchemaDrift | undefined {
  if (!annotations || !result.tools || !Object.hasOwn(annotations.servers, name)) return undefined;
  const drift = diffServerSchemas(name, annotations.servers[name].tools, result.tools);
  return hasServerDrift(drift) ? drift : undefined;
}

/**
 * " (server reports X; annotated for Y)" when either identity is known, so
 * the warning names the release that drifted. Server-reported text is
 * rendered as display text.
 */
function describeReleases(
  live: { readonly name: string; readonly version: string } | undefined,
  annotated: { readonly name: string; readonly version: string } | undefined,
): string {
  const shown = (info: { readonly name: string; readonly version: string }): string =>
    toDisplayText(`${info.name} ${info.version}`, { maxLength: 80 });
  const parts = [
    ...(live ? [`server reports ${shown(live)}`] : []),
    ...(annotated ? [`annotated for ${shown(annotated)}`] : []),
  ];
  return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Runs a 1-token generateText call against the configured agent model,
 * checking the API key for that model's provider (which may not be
 * Anthropic — IronCurtain supports OpenAI and Google too).
 */
export async function checkAgentApiRoundtrip(config: IronCurtainConfig): Promise<CheckResult> {
  return hostModelRoundtrip(config, 'agent', config.agentModelId, (message) => message);
}

/**
 * Order of the `--check-api` host-model round-trips: the summary model first,
 * because once compaction is due a failing summary model fails every turn.
 */
const ROUNDTRIP_ROLE_ORDER: readonly HostModelRole[] = [
  'summary',
  'agent',
  'policy',
  'prefilter',
  'autoApprove',
  'contentAssessment',
];

/** The config field each host role's model ID comes from, for check messages and hints. */
const HOST_ROLE_MODEL_FIELD: Readonly<Record<HostModelRole, string>> = {
  agent: 'agentModelId',
  policy: 'policyModelId',
  prefilter: 'prefilterModelId',
  summary: 'autoCompact.summaryModelId',
  autoApprove: 'autoApprove.modelId',
  contentAssessment: 'contentAssessment.llmModelId',
};

/**
 * Whether the feature behind a host role is on, so it will call its model:
 * auto-compaction for `summary`, auto-approval for `autoApprove`, and the
 * outbound content checks with their LLM check for `contentAssessment`.
 */
function hostRoleInUse(config: IronCurtainConfig, role: HostModelRole): boolean {
  const { userConfig } = config;
  switch (role) {
    case 'agent':
    case 'policy':
    case 'prefilter':
      return true;
    case 'summary':
      return userConfig.autoCompact.enabled;
    case 'autoApprove':
      return userConfig.autoApprove.enabled;
    case 'contentAssessment':
      return userConfig.contentAssessment?.enabled === true && userConfig.contentAssessment.llmCheck;
  }
}

/**
 * `doctor --check-api`: one 1-token round-trip per configured host model
 * role (summary, agent, policy, pre-filter, auto-approver, outbound content
 * check), each with its own model ID and the provider profile bound to that
 * role, so a mistyped `policyModelId` or a summary model the gateway cannot
 * route is found before a session or compile spends budget on it. Roles that
 * request the same model through the same profile share one round-trip.
 * Roles whose feature is turned off (auto-compaction, auto-approval, the
 * outbound content LLM check) are not checked.
 */
export async function checkHostModelApiRoundtrips(config: IronCurtainConfig): Promise<CheckResult[]> {
  const groups = new Map<string, { roles: HostModelRole[]; modelId: string }>();
  for (const role of ROUNDTRIP_ROLE_ORDER) {
    if (!hostRoleInUse(config, role)) continue;
    const modelId = role === 'agent' ? config.agentModelId : hostRoleModelId(config.userConfig, role);
    const profileName = config.userConfig.hostModelProfiles?.[role] ?? NATIVE_PROFILE_NAME;
    const key = `${profileName}\0${resolveHostModelId(modelId, config.userConfig, role)}`;
    const group = groups.get(key);
    if (group) group.roles.push(role);
    else groups.set(key, { roles: [role], modelId });
  }
  const results: CheckResult[] = [];
  for (const { roles, modelId } of groups.values()) {
    const prefix = `${roles.join(', ')} (${toDisplayText(modelId, { maxLength: 80 })})`;
    results.push(await hostModelRoundtrip(config, roles[0], modelId, (message) => `${prefix}: ${message}`, roles));
  }
  return results;
}

/**
 * The round-trip for one host role: its model ID through the provider profile
 * bound to `role`. `describe` frames the message (the role list, for the
 * multi-role check).
 */
async function hostModelRoundtrip(
  config: IronCurtainConfig,
  role: HostModelRole,
  modelId: string,
  describe: (message: string) => string,
  roles: readonly HostModelRole[] = [role],
): Promise<CheckResult> {
  const { provider } = parseModelId(modelId);
  const profileName = config.userConfig.hostModelProfiles?.[role];
  const profile =
    profileName === undefined ? undefined : resolveActiveProfile(config.userConfig.modelProviders, profileName);
  const gateway = profile?.type === 'native' ? undefined : profile;
  const label = gateway ? getGatewayDefinition(gateway.type).label : formatProviderLabel(provider);
  const name = `${label} API round-trip`;
  const apiKey = resolveHostModelApiKey(modelId, config.userConfig, role);
  if (apiKey.length === 0) {
    if (
      !gateway &&
      provider === 'anthropic' &&
      (await detectAuthMethod(config, readOnlyCredentialSources)).kind === 'oauth'
    ) {
      return {
        name,
        status: 'skip',
        message: describe('OAuth-only setup — the OAuth access token is validated below (no refresh grant)'),
      };
    }
    return {
      name,
      status: 'skip',
      message: describe(
        gateway
          ? `no ${label} API key for host ${role} profile "${profileName}"`
          : `no ${label} API key — round-trip uses API key auth only`,
      ),
      ...(gateway
        ? { hint: `Set ${getGatewayDefinition(gateway.type).editor.credentialEnv} or the profile apiKey.` }
        : {}),
    };
  }
  const fields = roles.map((entry) => HOST_ROLE_MODEL_FIELD[entry]).join(' / ');
  try {
    const start = Date.now();
    // Lazy-import the AI SDK so the default doctor run doesn't pay the load cost.
    const { generateText } = await import('ai');
    const model = await createLanguageModel(modelId, config.userConfig, role);
    await generateText({
      model,
      prompt: 'Reply with the single word OK.',
      maxOutputTokens: 1,
      // Cap the round-trip so a network blackhole or DNS stall can't hang
      // doctor. maxRetries: 0 turns off the SDK's default 3-attempt retry —
      // for diagnostics we want fast failure, not eventual failure.
      abortSignal: AbortSignal.timeout(API_ROUNDTRIP_TIMEOUT_MS),
      maxRetries: 0,
    });
    const elapsed = formatElapsed(Date.now() - start);
    return { name, status: 'ok', message: describe(`responded in ${elapsed}`) };
  } catch (err) {
    return {
      name,
      status: 'fail',
      message: describe(describeApiError(err)),
      hint: gateway
        ? `Verify the ${label} profile "${profileName}" API key and mapped ${role} model.`
        : `Verify the ${label} API key is valid and the configured ${fields} exists.`,
    };
  }
}

/**
 * Offline: warns about every host role bound to a gateway profile whose model
 * ID the gateway cannot route (an unmapped bare ID on OpenRouter, which needs
 * `vendor/model`), so the mistake shows before a session fails on it.
 */
export function checkHostModelRouting(config: IronCurtainConfig): CheckResult {
  const name = 'Host model routing';
  let warnings: ReturnType<typeof findHostModelRoutingWarnings>;
  try {
    warnings = findHostModelRoutingWarnings(config.userConfig);
  } catch (err) {
    return { name, status: 'fail', message: err instanceof Error ? err.message : String(err) };
  }
  if (warnings.length === 0) {
    const bound = Object.values(config.userConfig.hostModelProfiles ?? {}).some(
      (profileName) => profileName !== NATIVE_PROFILE_NAME,
    );
    return bound
      ? { name, status: 'ok', message: 'every gateway-bound role maps to a routable model ID' }
      : { name, status: 'skip', message: 'no host role is bound to a gateway profile' };
  }
  return {
    name,
    status: 'warn',
    message: toDisplayText(warnings.map((warning) => warning.message).join(' ')),
    hint: 'Edit the profile model map or the role model under `ironcurtain config` > Model Providers.',
  };
}

/** Hard cap on the agent-model API round-trip; healthy calls are 1-3s. */
const API_ROUNDTRIP_TIMEOUT_MS = 15_000;

/**
 * Renders an AI SDK error with as much diagnostic info as we can extract.
 * The SDK's APICallError frequently has an empty .message but a useful
 * .url and .cause (the underlying fetch error). Surface all of them so
 * "Cannot connect to API:" doesn't lose the actual reason.
 */
function describeApiError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [];
  if (err.message) parts.push(err.message);
  // AI SDK APICallError surfaces the URL it tried to hit.
  if (isObjectWithProp(err, 'url') && typeof err.url === 'string' && err.url.length > 0) {
    parts.push(`url=${err.url}`);
  }
  // Status code from APICallError.
  if (isObjectWithProp(err, 'statusCode') && typeof err.statusCode === 'number') {
    parts.push(`status=${err.statusCode}`);
  }
  // Underlying cause (e.g., fetch's TypeError with the system error code).
  if (isObjectWithProp(err, 'cause')) {
    const cause = err.cause;
    if (cause instanceof Error && cause.message) {
      parts.push(`cause=${cause.message}`);
      if (isObjectWithProp(cause, 'code') && typeof cause.code === 'string') {
        parts.push(`code=${cause.code}`);
      }
    } else if (typeof cause === 'string') {
      parts.push(`cause=${cause}`);
    }
  }
  return parts.join(' | ');
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

function formatProviderLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider];
}

// ---------------------------------------------------------------------------
// Memory models
// ---------------------------------------------------------------------------

const MEMORY_MODELS_CHECK = 'Memory models';
const MEMORY_PREFETCH_COMMAND = '`ironcurtain memory prefetch`';

function memoryModelNames(entries: readonly MemoryModelEntry[]): string {
  return entries.map((entry) => toDisplayText(`${entry.repo} (${entry.dtype})`)).join(', ');
}

function memoryModelDetail(entry: MemoryModelEntry): string {
  return entry.detail === undefined ? '' : `: ${toDisplayText(entry.detail, { maxLength: 400 })}`;
}

/**
 * The memory server's model store (`~/.ironcurtain/models`): every pinned
 * model installed and matching its SHA-256 pins? Asks the bundled server to
 * verify it (no download; see src/memory/memory-models.ts). Skipped when
 * memory is off. A file that fails verification, a model this build has no
 * pin for, and a missing model with `memory.offlineModels` on all fail: memory
 * sessions cannot embed. A model merely not downloaded yet is a warning, since
 * the first memory session fetches it.
 */
export async function checkMemoryModels(
  config: IronCurtainConfig,
  run: MemoryModelsRunner = runMemoryModelsTool,
): Promise<CheckResult> {
  const memory = config.userConfig.memory;
  if (!memory.enabled) {
    return { name: MEMORY_MODELS_CHECK, status: 'skip', message: 'memory is disabled (memory.enabled is false)' };
  }

  const result = await run('verify');
  if (result.kind === 'failed') {
    return {
      name: MEMORY_MODELS_CHECK,
      status: 'warn',
      message: `could not check: ${toDisplayText(result.reason, { maxLength: 400 })}`,
    };
  }

  const { report } = result;
  const location = toDisplayText(report.modelsDir);
  const byStatus = (status: MemoryModelEntry['status']): MemoryModelEntry[] =>
    report.models.filter((entry) => entry.status === status);
  const invalid = byStatus('invalid');
  const unpinned = byStatus('unpinned');
  const errors = byStatus('error');
  const missing = byStatus('missing');

  if (invalid.length > 0) {
    return {
      name: MEMORY_MODELS_CHECK,
      status: 'fail',
      message: `${memoryModelNames(invalid)} failed verification${memoryModelDetail(invalid[0])}`,
      hint: `The file was modified or corrupted, and memory sessions refuse to load it. Run ${MEMORY_PREFETCH_COMMAND} to replace it with the pinned file.`,
    };
  }
  if (unpinned.length > 0) {
    return {
      name: MEMORY_MODELS_CHECK,
      status: 'fail',
      message: `${memoryModelNames(unpinned)} not pinned in this build: memory sessions cannot store or recall`,
      hint: 'The memory server loads only models whose commit and file hashes it pins (PINNED_MODELS in packages/memory-mcp-server/src/models/manifest.ts).',
    };
  }
  if (errors.length > 0) {
    return {
      name: MEMORY_MODELS_CHECK,
      status: 'warn',
      message: `could not check ${memoryModelNames(errors)}${memoryModelDetail(errors[0])}`,
    };
  }
  if (missing.length > 0) {
    return memory.offlineModels
      ? {
          name: MEMORY_MODELS_CHECK,
          status: 'fail',
          message: `${memoryModelNames(missing)} not in ${location}, and memory.offlineModels forbids downloading them`,
          hint: `Run ${MEMORY_PREFETCH_COMMAND} on a machine with network access (or copy a verified models directory here).`,
        }
      : {
          name: MEMORY_MODELS_CHECK,
          status: 'warn',
          message: `${memoryModelNames(missing)} not downloaded yet; the first memory session downloads and verifies them`,
          hint: `Run ${MEMORY_PREFETCH_COMMAND} to download them now.`,
        };
  }
  return {
    name: MEMORY_MODELS_CHECK,
    status: 'ok',
    message: `${report.models.length} pinned model${report.models.length === 1 ? '' : 's'} verified in ${location}`,
  };
}

const MEMORY_QUARANTINE_CHECK = 'Memory review quarantine';

/**
 * Does the installed memory server hold what cron jobs and workflow states
 * write for review (src/memory/memory-server-exports.ts)? One from before the
 * review quarantine would file those memories among the ones interactive
 * sessions read, so cron jobs and workflows with memory refuse to start
 * (buildMemoryServerConfig): a failure. Interactive sessions are not
 * affected. Skipped when memory is off.
 */
export function checkMemoryReviewQuarantine(
  config: IronCurtainConfig,
  hasReviewQuarantine: () => boolean = memoryServerHasReviewQuarantine,
): CheckResult {
  if (!config.userConfig.memory.enabled) {
    return { name: MEMORY_QUARANTINE_CHECK, status: 'skip', message: 'memory is disabled (memory.enabled is false)' };
  }
  if (hasReviewQuarantine()) {
    return {
      name: MEMORY_QUARANTINE_CHECK,
      status: 'ok',
      message: 'memories that cron jobs and workflows write wait for review',
    };
  }
  return {
    name: MEMORY_QUARANTINE_CHECK,
    status: 'fail',
    message:
      '@provos/memory-mcp-server/admin does not resolve, so the memory server predates the review quarantine (or is not built or installed): cron jobs and workflows with memory refuse to start',
    hint: UPDATE_MEMORY_SERVER_HINT,
  };
}
