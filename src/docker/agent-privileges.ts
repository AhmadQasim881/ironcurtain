/**
 * Agent container identity and privileges: the single decision of which user
 * an agent container starts as, which capabilities it keeps, whether it runs
 * with no-new-privileges, and as whom the host probes and execs into it.
 * Batch, PTY and workflow dependency-provisioning containers all take it from
 * {@link planAgentContainerPrivileges}, so the create flags, the startup probe
 * and the default exec user cannot disagree.
 *
 * Two modes, selected by the `agentSudo` user config (default on):
 *
 * - **Sudo on** (default, unchanged behavior). The image grants `codespace`
 *   passwordless sudo and the container keeps SETUID, SETGID, CHOWN, FOWNER,
 *   DAC_OVERRIDE and AUDIT_WRITE so `sudo apt-get install` works (installs go
 *   through the registry proxy). On Linux Docker the container starts as
 *   `0:0` so the entrypoint can renumber `codespace` to the host UID/GID
 *   before dropping to it (issue #232). Without rootless Docker or
 *   userns-remap, container root is real host root on every bind mount, so a
 *   compromised agent can leave root-owned or setuid files in the workspace
 *   (audit finding DINF-3); `host-mount-privilege-scan.ts` strips and reports
 *   them after each turn and at session end.
 * - **Sudo off** (`agentSudo: false`). No root step at all: the container
 *   starts as the image's agent UID (numeric, so a tampered `/etc/passwd` in
 *   a workflow snapshot image cannot map it to root), every host exec uses
 *   that numeric UID too, `--security-opt no-new-privileges` makes the setuid
 *   bit of `sudo` (and of any binary an agent plants) inert, and the
 *   container keeps none of the capabilities above. The agent can no longer
 *   create root-owned files, chown host files, or write host files it does not
 *   own. Package installs that need root (apt) stop working; user-level
 *   installs (pip, npm, cargo through the proxy) keep working. The entrypoint
 *   skips the system trust store (no root to write it) and tools rely on the
 *   runtime trust environment (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, ...).
 *
 * Sudo-off limits, each refused before any image or container work rather
 * than silently weakened ({@link AgentSudoUnsupportedError}):
 *
 * - Linux Docker needs IronCurtain to run as the image's agent UID (1000).
 *   Renumbering `codespace` to another host UID needs root and CHOWN, SETUID
 *   and SETGID at container start, which is exactly what this mode removes.
 * - Apple `container` has no no-new-privileges control here, and its
 *   same-VM nested daemon needs SETUID/SETGID.
 * - Nested Docker (`dockerWorkload`) initializes build state through root
 *   execs that need CHOWN.
 */
import type { ContainerRuntimeKind } from './container-runtime.js';
import { resolveContainerIdentity, type ContainerIdentity } from './container-identity.js';

/** Capabilities agent containers keep for passwordless sudo (`--cap-drop=ALL` first). */
export const AGENT_SUDO_CAPABILITIES: readonly string[] = Object.freeze([
  'SETUID',
  'SETGID',
  'CHOWN',
  'FOWNER',
  'DAC_OVERRIDE',
  'AUDIT_WRITE',
]);

/** `--security-opt` value that disables setuid/file-capability elevation for every process. */
export const NO_NEW_PRIVILEGES_SECURITY_OPTION = 'no-new-privileges:true';

/** Entrypoint marker for sudo-off containers (see `docker/entrypoint-uid-remap.sh`). */
export const AGENT_SUDO_ENV_NAME = 'IRONCURTAIN_AGENT_SUDO';
export const AGENT_SUDO_DISABLED_ENV_VALUE = 'disabled';

/** The `codespace` account's UID baked into every agent image. */
export const IMAGE_AGENT_UID = resolveContainerIdentity(false).uid;

/** Discriminant for {@link AgentSudoUnsupportedError} (match on `code`, not `instanceof`). */
export const AGENT_SUDO_UNSUPPORTED = 'AGENT_SUDO_UNSUPPORTED';

/** `agentSudo: false` was requested where it cannot be enforced. */
export class AgentSudoUnsupportedError extends Error {
  readonly code = AGENT_SUDO_UNSUPPORTED;
  constructor(message: string) {
    super(message);
    this.name = 'AgentSudoUnsupportedError';
  }
}

export interface AgentContainerPrivilegePlan {
  /** Whether the agent keeps passwordless sudo. */
  readonly agentSudo: boolean;
  /** `docker create --user`; undefined keeps the image's `USER`. */
  readonly user: string | undefined;
  /** Entrypoint environment: the Linux UID-remap variables or the sudo-off marker. */
  readonly env: Readonly<Record<string, string>>;
  /** Capabilities re-added after `--cap-drop=ALL`. */
  readonly capAdd: readonly string[];
  /** Docker `--security-opt` values (Docker runtime only). */
  readonly securityOptions: readonly string[];
  /**
   * User for the startup readiness probe (see `agent-startup.ts`), or
   * undefined when the runtime starts the agent without a probe. Sudo-on
   * Linux probes as numeric root because the account is being renumbered;
   * sudo-off probes as the agent's own numeric UID (no root exists).
   */
  readonly startupProbeUser: string | undefined;
  /**
   * Default `docker exec --user` for this bundle's runtime, or undefined for
   * the runtime default (`codespace`).
   */
  readonly execUser: string | undefined;
}

export interface PlanAgentContainerPrivilegesInput {
  readonly runtimeKind: ContainerRuntimeKind;
  /** Docker Desktop / host-only TCP transport (no Linux UID remap). */
  readonly useTcp: boolean;
  readonly agentSudo: boolean;
  /** An admitted nested-Docker workload shares this agent container. */
  readonly nestedDocker: boolean;
  /** Host identity Linux Docker agents inherit; defaults to this process's. */
  readonly hostIdentity?: ContainerIdentity;
}

/**
 * Returns the `user` override and env vars needed for runtime UID
 * remapping on Linux (issue #232). When the host UID is not 1000, the
 * baked codespace user (UID 1000) cannot write to bind-mounted
 * directories owned by the host UID. To fix this without committing to
 * a hardcoded UID in the image, the host launches the container as
 * `0:0` and passes `IRONCURTAIN_AGENT_UID` / `IRONCURTAIN_AGENT_GID`
 * so the entrypoint (running as root) can renumber the codespace
 * account before dropping privileges via `runuser`.
 *
 * When `skipRemap` is true this returns an empty mapping so the
 * container runs as the baked `codespace` user from the Dockerfile.
 * Skipped on macOS Docker Desktop (VirtioFS handles UID translation
 * transparently and `--user 0:0` would defeat it) AND on apple-container
 * (virtiofs presents host files as root; the existing sessions work
 * without the Linux renumber-and-drop dance) — i.e., remap is Linux
 * Docker only. Callers pass `runtimeKind === 'apple-container' || useTcp`
 * so apple-container's `uds` topology does not accidentally trip the
 * Linux-only remap.
 *
 * Used only by sudo-on plans: a sudo-off container never starts as root.
 */
export function buildAgentUidRemap(skipRemap: boolean): {
  readonly user: string | undefined;
  readonly env: Record<string, string>;
} {
  if (skipRemap) return { user: undefined, env: {} };
  return uidRemapFor(resolveContainerIdentity(true));
}

function uidRemapFor(host: ContainerIdentity): { readonly user: string; readonly env: Record<string, string> } {
  return {
    user: '0:0',
    env: {
      IRONCURTAIN_AGENT_UID: String(host.uid),
      IRONCURTAIN_AGENT_GID: String(host.gid),
    },
  };
}

/**
 * Plans the agent container's identity and privileges. Pure apart from the
 * default host identity lookup; throws {@link AgentSudoUnsupportedError} when
 * `agentSudo: false` cannot be enforced, so no caller can build a sudo-off
 * container that quietly keeps root.
 */
export function planAgentContainerPrivileges(input: PlanAgentContainerPrivilegesInput): AgentContainerPrivilegePlan {
  const linuxDocker = input.runtimeKind === 'docker' && !input.useTcp;
  if (input.agentSudo) {
    const uidRemap = linuxDocker
      ? uidRemapFor(input.hostIdentity ?? resolveContainerIdentity(true))
      : { user: undefined, env: {} };
    return {
      agentSudo: true,
      user: uidRemap.user,
      env: uidRemap.env,
      capAdd: AGENT_SUDO_CAPABILITIES,
      securityOptions: [],
      startupProbeUser: linuxDocker ? '0:0' : undefined,
      execUser: undefined,
    };
  }

  assertAgentSudoCanBeDisabled(input);
  const agentUser = String(IMAGE_AGENT_UID);
  return {
    agentSudo: false,
    // UID only, no group: Docker then takes the primary group and the
    // supplementary groups (npm/nvm/python group access on the universal
    // image) from the image's account, exactly as `--user codespace` would,
    // without trusting the image to map the name to a non-root UID. On a host
    // whose primary group is not 1000, files the agent creates therefore carry
    // group 1000 rather than the host group (the host user still owns them).
    user: agentUser,
    env: { [AGENT_SUDO_ENV_NAME]: AGENT_SUDO_DISABLED_ENV_VALUE },
    capAdd: [],
    securityOptions: [NO_NEW_PRIVILEGES_SECURITY_OPTION],
    startupProbeUser: linuxDocker ? agentUser : undefined,
    execUser: agentUser,
  };
}

/**
 * Agent sudo is on unless the user config says `false`. A partially built
 * config (hand-assembled by a caller or a test) keeps the shipped default.
 */
export function isAgentSudoEnabled(userConfig: { readonly agentSudo?: boolean }): boolean {
  return userConfig.agentSudo !== false;
}

/**
 * {@link planAgentContainerPrivileges} for a session bundle and the user
 * config it was prepared with. Batch, PTY and dependency-provisioning
 * containers all derive their create flags and startup probe from this, and
 * `prepareDockerInfrastructure` the runtime's default exec user, so the
 * three cannot disagree.
 */
export function planBundleAgentPrivileges(
  core: {
    readonly runtimeKind: ContainerRuntimeKind;
    readonly useTcp: boolean;
    /** Present for an admitted nested-Docker bundle. */
    readonly dockerWorkload?: unknown;
  },
  userConfig: { readonly agentSudo?: boolean },
): AgentContainerPrivilegePlan {
  return planAgentContainerPrivileges({
    runtimeKind: core.runtimeKind,
    useTcp: core.useTcp,
    agentSudo: isAgentSudoEnabled(userConfig),
    nestedDocker: core.dockerWorkload !== undefined,
  });
}

function assertAgentSudoCanBeDisabled(input: PlanAgentContainerPrivilegesInput): void {
  if (input.runtimeKind !== 'docker') {
    throw new AgentSudoUnsupportedError(
      `agentSudo: false is not supported on the ${input.runtimeKind} runtime: it cannot set no-new-privileges ` +
        'for agent containers. Use the Docker runtime (containerRuntime: "docker") or set agentSudo back to true.',
    );
  }
  if (input.nestedDocker) {
    throw new AgentSudoUnsupportedError(
      'agentSudo: false is not supported together with nested Docker (dockerWorkload): its build-state ' +
        'initialization runs as root inside the agent container. Disable dockerWorkload or set agentSudo back to true.',
    );
  }
  if (input.useTcp) return;
  const host = input.hostIdentity ?? resolveContainerIdentity(true);
  if (host.uid !== IMAGE_AGENT_UID) {
    throw new AgentSudoUnsupportedError(
      `agentSudo: false on Linux Docker needs IronCurtain to run as UID ${IMAGE_AGENT_UID}, the agent account baked ` +
        `into the image; this process runs as UID ${host.uid}. Renumbering the agent account to another UID needs ` +
        'root and the CHOWN, SETUID and SETGID capabilities at container start, which agentSudo: false removes. ' +
        'Run IronCurtain as UID 1000, or keep agentSudo: true (setuid and setgid bits are still stripped from ' +
        'host-backed mounts after each turn).',
    );
  }
}
