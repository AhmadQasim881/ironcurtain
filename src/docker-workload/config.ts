import { bindDockerEndpointExec, resolveDockerEndpoint } from '../docker/docker-endpoint.js';
/** Operator-requested and trusted-resolved secure nested Docker capability. */

import { z } from 'zod';
import { release } from 'node:os';
import { isWsl2Host, resolveDockerWorkloadEnvironment, type DockerWorkloadEnvironment } from './environment.js';
import { resolveContainerIdentity } from '../docker/container-identity.js';
import { assertNestedDaemonIdentity } from './nested-daemon-identity.js';

const LEGACY_DOCKER_WORKLOAD_BACKENDS = ['auto', 'docker', 'apple-container'] as const;

export const DOCKER_WORKLOAD_NETWORK_ACCESS = ['offline', 'images', 'packages'] as const;
export type DockerWorkloadNetworkAccess = (typeof DOCKER_WORKLOAD_NETWORK_ACCESS)[number];
export const DOCKER_WORKLOAD_PACKAGE_NETWORK_WARNING =
  'Packages permits any process in this nested-Docker session to send bounded workspace or build data through allowed package paths, permitted request metadata, and timing to fixed public repositories, and to download untrusted content. IronCurtain does not inject credentials and rejects recognized credential fields and request bodies. It screens the immediate peer, but a public repository may relay or hairpin elsewhere; use Images only or Offline to remove this route.';

const STORED_DOCKER_WORKLOAD_NETWORK_ACCESS = [...DOCKER_WORKLOAD_NETWORK_ACCESS, 'public'] as const;

const DOCKER_WORKLOAD_MEMORY_MIN_MB = 512;
const DOCKER_WORKLOAD_MEMORY_MAX_MB = 1024 * 1024;
const DOCKER_WORKLOAD_CPU_MIN = 0.25;
const DOCKER_WORKLOAD_CPU_MAX = 1024;
/**
 * Bounds and default of the bundle's aggregate PID budget. Nested Docker uses
 * the numeric `dockerResources.pidsLimit` (default 4096) as that budget, the
 * same way it uses `dockerResources.memoryMb` and `cpus`; the minimum is the
 * old fixed total, which still covers every reserve the partition charges.
 */
export const DOCKER_WORKLOAD_PIDS_MIN = 512;
export const DOCKER_WORKLOAD_PIDS_MAX = 1_048_576;
export const DOCKER_WORKLOAD_DEFAULT_PIDS = 4096;
/**
 * Share of the session's CPU, memory and PIDs the nested daemon receives on
 * Docker Desktop (`dockerWorkload.resources.daemonShare`). The default gives
 * it half: it runs dockerd, BuildKit and every inner container, while the
 * agent mostly waits on model I/O. The agent always keeps its minimum floor.
 */
export const DOCKER_WORKLOAD_DAEMON_SHARE_MIN = 0.1;
export const DOCKER_WORKLOAD_DAEMON_SHARE_MAX = 0.9;
export const DOCKER_WORKLOAD_DEFAULT_DAEMON_SHARE = 0.5;

const daemonShareSchema = z.number().min(DOCKER_WORKLOAD_DAEMON_SHARE_MIN).max(DOCKER_WORKLOAD_DAEMON_SHARE_MAX);

const legacyRequestedResourcesSchema = z
  .object({
    memoryMb: z.number().int().min(DOCKER_WORKLOAD_MEMORY_MIN_MB).max(DOCKER_WORKLOAD_MEMORY_MAX_MB).optional(),
    cpus: z.number().min(DOCKER_WORKLOAD_CPU_MIN).max(DOCKER_WORKLOAD_CPU_MAX).optional(),
    pids: z
      .object({
        desired: z.number().int().min(16).max(1_048_576).optional(),
        required: z.boolean().optional(),
      })
      .strict()
      .optional(),
    diskMb: z
      .number()
      .int()
      .min(512)
      .max(16 * 1024 * 1024)
      .nullable()
      .optional(),
    /** The one supported resource choice; the other fields are legacy and transformed away. */
    daemonShare: daemonShareSchema.optional(),
  })
  .strict()
  .optional();

/**
 * Existing configs may contain the old implementation-policy fields. Accept
 * only values equivalent to today's admitted developer slice, then transform
 * them away so every caller sees the canonical network-access request. Legacy
 * values that expressed unsupported intent fail with an actionable message
 * instead of being silently weakened.
 */
export const dockerWorkloadRequestedSchema = z
  .object({
    enabled: z.boolean().optional(),
    tier: z.literal('developer-only').optional(),
    backend: z.enum(LEGACY_DOCKER_WORKLOAD_BACKENDS).optional(),
    imageMode: z.literal('preloaded-catalog').optional(),
    imageIngress: z.enum(['preloaded-only', 'public-registry']).optional(),
    networkAccess: z.enum(STORED_DOCKER_WORKLOAD_NETWORK_ACCESS).optional(),
    daemonState: z.literal('ephemeral').optional(),
    hostPortPublishing: z.literal(false).optional(),
    buildEgress: z.enum(['disabled', 'ironcurtain-dockerfiles']).optional(),
    acceptObservedDiskRisk: z.boolean().optional(),
    resources: legacyRequestedResourcesSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.imageIngress !== undefined && request.networkAccess !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['networkAccess'],
        message:
          'dockerWorkload.imageIngress and dockerWorkload.networkAccess cannot be combined; remove imageIngress and keep the explicit networkAccess choice',
      });
    }
    if (request.backend === 'docker') {
      context.addIssue({
        code: 'custom',
        path: ['backend'],
        message:
          'legacy dockerWorkload.backend is no longer supported; remove it and set containerRuntime to "docker" to select Docker Desktop',
      });
    }
    if (request.buildEgress === 'ironcurtain-dockerfiles') {
      context.addIssue({
        code: 'custom',
        path: ['buildEgress'],
        message:
          'legacy nested-Docker build egress is not supported; remove dockerWorkload.buildEgress or disable nested Docker',
      });
    }
    if (request.acceptObservedDiskRisk === false) {
      context.addIssue({
        code: 'custom',
        path: ['acceptObservedDiskRisk'],
        message:
          'the current nested-Docker developer slice requires the fixed observed-disk policy; remove acceptObservedDiskRisk or disable nested Docker',
      });
    }
    if (request.resources?.memoryMb !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['resources', 'memoryMb'],
        message: 'legacy nested-Docker memory overrides are no longer supported; use dockerResources.memoryMb',
      });
    }
    if (request.resources?.cpus !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['resources', 'cpus'],
        message: 'legacy nested-Docker CPU overrides are no longer supported; use dockerResources.cpus',
      });
    }
    if (request.resources?.pids?.desired !== undefined && request.resources.pids.desired !== 512) {
      context.addIssue({
        code: 'custom',
        path: ['resources', 'pids', 'desired'],
        message:
          'custom nested-Docker PID targets are no longer set here; nested Docker uses dockerResources.pidsLimit as its aggregate PID budget',
      });
    }
    if (request.resources?.pids?.required === true) {
      context.addIssue({
        code: 'custom',
        path: ['resources', 'pids', 'required'],
        message: 'required nested-Docker PID enforcement is not supported by the current developer slice',
      });
    }
    if (request.resources?.diskMb !== undefined && request.resources.diskMb !== null) {
      context.addIssue({
        code: 'custom',
        path: ['resources', 'diskMb'],
        message: 'numeric nested-Docker disk limits are not supported by the current developer slice',
      });
    }
  })
  .transform((request) => {
    const networkAccess =
      (request.networkAccess === 'public' ? 'packages' : request.networkAccess) ??
      (request.imageIngress === 'public-registry'
        ? 'images'
        : request.imageIngress === 'preloaded-only'
          ? 'offline'
          : request.enabled === true
            ? 'images'
            : undefined);
    const daemonShare = request.resources?.daemonShare;
    return {
      ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
      ...(networkAccess === undefined ? {} : { networkAccess }),
      ...(daemonShare === undefined ? {} : { resources: { daemonShare } }),
    };
  });

export type DockerWorkloadRequestedConfig = z.infer<typeof dockerWorkloadRequestedSchema>;

/**
 * A `dockerWorkload` request as written, legacy fields included: what
 * {@link dockerWorkloadRequestedSchema} accepts before normalizing it to
 * {@link DockerWorkloadRequestedConfig}.
 */
export type DockerWorkloadRequestedInput = z.input<typeof dockerWorkloadRequestedSchema>;

/** Complete bounded configuration recorded directly in admission and session evidence. */
export const resolvedDockerWorkloadConfigSchema = z.discriminatedUnion('enabled', [
  z
    .object({ enabled: z.literal(false) })
    .strict()
    .readonly(),
  z
    .object({
      enabled: z.literal(true),
      networkAccess: z.enum(DOCKER_WORKLOAD_NETWORK_ACCESS),
      acceptObservedDiskRisk: z.boolean(),
      resources: z
        .object({
          memoryMb: z.number().int().min(DOCKER_WORKLOAD_MEMORY_MIN_MB).max(DOCKER_WORKLOAD_MEMORY_MAX_MB),
          cpus: z.number().min(DOCKER_WORKLOAD_CPU_MIN).max(DOCKER_WORKLOAD_CPU_MAX),
          daemonShare: daemonShareSchema,
          pids: z
            .object({ desired: z.number().int().min(16).max(1_048_576), required: z.boolean() })
            .strict()
            .readonly(),
          diskMb: z
            .number()
            .int()
            .min(512)
            .max(16 * 1024 * 1024)
            .nullable(),
        })
        .strict()
        .readonly(),
    })
    .strict()
    .readonly(),
]);

export type ResolvedDockerWorkloadConfig = z.infer<typeof resolvedDockerWorkloadConfigSchema>;

/**
 * Validates a request (legacy fields included) and resolves it. Feature-off is
 * a one-field value carrying no per-session provisioned authority.
 *
 * `resourceDefaults` are the numeric ordinary `dockerResources` values: they
 * become the bundle's aggregate envelope (memory, CPU and PID budget), clamped
 * into the nested bounds. Unlimited (`null`, passed as undefined) values fall
 * back to safe nested defaults.
 */
export function resolveDockerWorkloadConfig(
  request: DockerWorkloadRequestedInput | undefined,
  resourceDefaults?: { readonly memoryMb?: number; readonly cpus?: number; readonly pidsLimit?: number },
): ResolvedDockerWorkloadConfig {
  const validated = dockerWorkloadRequestedSchema.parse(request ?? {});
  if (validated.enabled !== true) return { enabled: false };
  const inheritedMemoryMb = clampInheritedResourceDefault(
    resourceDefaults?.memoryMb,
    DOCKER_WORKLOAD_MEMORY_MIN_MB,
    DOCKER_WORKLOAD_MEMORY_MAX_MB,
    4096,
  );
  const inheritedCpus = clampInheritedResourceDefault(
    resourceDefaults?.cpus,
    DOCKER_WORKLOAD_CPU_MIN,
    DOCKER_WORKLOAD_CPU_MAX,
    2,
  );
  const inheritedPids = Math.floor(
    clampInheritedResourceDefault(
      resourceDefaults?.pidsLimit,
      DOCKER_WORKLOAD_PIDS_MIN,
      DOCKER_WORKLOAD_PIDS_MAX,
      DOCKER_WORKLOAD_DEFAULT_PIDS,
    ),
  );
  return {
    enabled: true,
    networkAccess: validated.networkAccess ?? 'images',
    // The admitted developer slice has no hard disk quota. Its disk ceiling
    // is observed: the detached host watchdog measures the storage the bundle
    // actually grows (an Apple VM's rootfs image blocks; on Docker Desktop the
    // daemon volume's Engine-reported size plus a free-space floor on the VM
    // disk) and revokes the bundle past the frozen thresholds. Admission
    // refuses a runtime the frozen policy gives no such coverage, so this flag
    // never stands for an unmeasured preview. Keep that implementation detail
    // out of the ordinary opt-in: `{ enabled: true }` must resolve without
    // requiring hidden risk-policy fields.
    acceptObservedDiskRisk: true,
    resources: {
      memoryMb: inheritedMemoryMb,
      cpus: inheritedCpus,
      daemonShare: validated.resources?.daemonShare ?? DOCKER_WORKLOAD_DEFAULT_DAEMON_SHARE,
      // The aggregate PID budget partitioned across the bundle's outer
      // containers. Not required: Apple guest PIDs stay advisory.
      pids: {
        desired: inheritedPids,
        required: false,
      },
      diskMb: null,
    },
  };
}

function clampInheritedResourceDefault(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Concise user-visible status for Docker-agent entrypoints and session logs. */
export function formatDockerWorkloadStatus(config: ResolvedDockerWorkloadConfig | undefined): string | undefined {
  if (config?.enabled !== true) return undefined;
  switch (config.networkAccess) {
    case 'packages':
      return 'Nested Docker: enabled · network: public packages + Docker Hub/GHCR (strict proxy)';
    case 'images':
      return 'Nested Docker: enabled · network: Docker Hub/GHCR images only';
    case 'offline':
      return 'Nested Docker: enabled · network: offline';
  }
}

/**
 * How to get ordinary sessions back, appended to every admission refusal.
 * `dockerWorkload.enabled` is global: while it is true every Docker agent
 * session (batch, PTY, workflow, cron) goes through admission, so one refusal
 * stops all of them until the feature is turned off.
 */
export const DOCKER_WORKLOAD_DISABLE_HINT =
  'To run ordinary Docker sessions without nested Docker, set dockerWorkload.enabled to false (ironcurtain config > Docker Agent > Nested Docker, or Settings in the web UI).';

/** An admission refusal carrying {@link DOCKER_WORKLOAD_DISABLE_HINT}. */
function admissionRefusal(message: string, cause?: unknown): Error {
  return new Error(
    `${message.replace(/\.$/u, '')}. ${DOCKER_WORKLOAD_DISABLE_HINT}`,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Admit only a supported developer slice. The caller resolves `auto` first,
 * then invokes this guard before any feature-attributable runtime, image,
 * proxy, lease, or filesystem provisioning. Docker Desktop is admitted on macOS
 * and WSL2; its server facts select the implemented profile in the availability
 * preflight. Apple Container performs its platform/version checks there too.
 * Operational artifacts are verified
 * later by their owning seams; this guard deliberately contains no
 * release/commit bookkeeping. Every refusal ends with
 * {@link DOCKER_WORKLOAD_DISABLE_HINT}.
 */
export function assertDockerWorkloadVariantAdmitted(
  config: ResolvedDockerWorkloadConfig | undefined,
  resolvedRuntimeKind: 'docker' | 'apple-container',
  hostPlatform: NodeJS.Platform = process.platform,
  hostRelease: string = release(),
): void {
  if (config?.enabled !== true) return;
  if (config.resources.pids.required || config.resources.diskMb !== null || !config.acceptObservedDiskRisk) {
    throw admissionRefusal(
      'secure nested Docker does not admit the requested resource policy; no image, relay, daemon, or lease action was performed',
    );
  }
  if (resolvedRuntimeKind === 'docker' && hostPlatform !== 'darwin' && !isWsl2Host(hostPlatform, hostRelease)) {
    throw admissionRefusal(
      `secure nested Docker with the Docker runtime is supported on macOS and WSL2 with Docker Desktop, not this ${hostPlatform} host; no image, relay, daemon, or lease action was performed`,
    );
  }
  if (resolvedRuntimeKind === 'docker' && hostPlatform === 'linux') {
    try {
      assertNestedDaemonIdentity(resolveContainerIdentity(true));
    } catch (error) {
      throw admissionRefusal(
        'Nested Docker on WSL requires a non-root coordinator UID and GID. Run IronCurtain as your regular WSL user; sudo remains available inside agent containers.',
        error,
      );
    }
  }
}

/**
 * Read-only runtime preflight required after the supported variant is selected.
 * `networkAccess` selects the engine requirement: online modes need an engine
 * that enforces isolated relay networks; omitted means the stricter online check.
 */
export async function assertAdmittedDockerWorkloadRuntimeAvailable(
  resolvedRuntimeKind: 'docker' | 'apple-container',
  networkAccess?: DockerWorkloadNetworkAccess,
): Promise<DockerWorkloadEnvironment> {
  const { defaultExecFile } = await import('../docker/docker-manager.js');
  const dockerEndpoint = resolvedRuntimeKind === 'docker' ? await resolveDockerEndpoint(defaultExecFile) : undefined;
  const availability =
    dockerEndpoint !== undefined
      ? await (
          await import('../docker/docker-probe.js')
        ).checkDockerAvailable(bindDockerEndpointExec(dockerEndpoint, defaultExecFile), true)
      : await (await import('../docker/apple-container-manager.js')).checkAppleContainerAvailable();
  if (!availability.available) {
    const runtimeName = resolvedRuntimeKind === 'docker' ? 'Docker' : 'Apple';
    throw admissionRefusal(
      `secure nested Docker ${runtimeName} runtime is unavailable: ${availability.reason}` +
        (availability.detailedMessage ? ` (${availability.detailedMessage})` : ''),
    );
  }
  let environment: DockerWorkloadEnvironment;
  try {
    environment = resolveDockerWorkloadEnvironment(resolvedRuntimeKind, availability.server, undefined, networkAccess);
  } catch (error) {
    throw admissionRefusal(error instanceof Error ? error.message : String(error), error);
  }
  return {
    ...environment,
    ...(dockerEndpoint === undefined ? {} : { dockerEndpoint }),
  };
}
