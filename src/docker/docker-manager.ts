import {
  DOCKER_ENDPOINT_ENVIRONMENT_KEYS,
  bindDockerEndpointExec,
  dockerEndpointEnvironment,
  dockerEndpointSchema,
  type DockerEndpoint,
} from './docker-endpoint.js';
/**
 * Docker CLI wrapper implementing the ContainerRuntime interface.
 *
 * Uses child_process.execFile for all Docker CLI commands.
 * This keeps the implementation simple and avoids a dependency
 * on the Docker Engine API or dockerode.
 */

import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { isIPv4 } from 'node:net';
import { isAbsolute, join } from 'node:path';
import type {
  ContainerRuntime,
  DockerContainerConfig,
  DockerContainerInfo,
  DockerExecResult,
  DockerImageInfo,
  DockerNetworkCreateOptions,
  DockerNetworkInfo,
  DockerUlimit,
  DockerVolumeCreateOptions,
  DockerVolumeInfo,
  ImageBuildOptions,
} from './types.js';
import { parseDockerImageInfo } from './docker-image-inspect.js';
import * as logger from '../logger.js';
import { checkDockerAvailable, type DockerAvailability } from './docker-probe.js';
import { isExecError } from '../utils/exec-error.js';
import { spawnWithIdleTimeout, type SpawnFn, type SpawnWithIdleTimeoutOptions } from './spawn-with-idle-timeout.js';
import {
  createDockerProgressSink,
  type CreateDockerProgressSinkOptions,
  type DockerProgressSink,
  type DockerProgressOperation,
} from './docker-progress-sink.js';
import { buildContainerExecEnvironmentArgs } from './container-exec-environment.js';
import { inheritedEnv } from '../trusted-process/child-env.js';
import { boundedLogTail } from './bounded-log-tail.js';
import { rejectedExecResult, resolvedExecResult, type ExecFileOutcome } from './exec-deadline.js';
import { relayHostPty, type HostPtySpawn, type HostTerminalStreams } from './pty-host-terminal.js';
import { clampPtySize } from '../pty/pty-size.js';
import { loadNodePty } from '../pty/node-pty-loader.js';

/**
 * Async exec function signature matching promisified execFile, plus an
 * optional `killed` flag on the resolved value. Node's own promisified
 * `execFile` resolves a SIGTERM-ed child that exited 0 as a plain success
 * (the Docker CLI does exactly that on a timeout), so `defaultExecFile`
 * reports the child's `killed` state and the runtime managers treat it as a
 * deadline hit. Implementations that cannot observe it may omit the flag;
 * the managers then fall back to elapsed-time detection.
 */
export type ExecFileFn = (
  cmd: string,
  args: readonly string[],
  opts: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
) => Promise<ExecFileOutcome>;

export const defaultExecFile: ExecFileFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFileCb(cmd, [...args], { ...opts, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        // Mirror util.promisify(execFile): the rejection carries the captured
        // output so `isExecError` consumers keep working unchanged.
        const failure: Error = error;
        reject(Object.assign(failure, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr, killed: child.killed });
    });
  });

/** Default timeout for docker exec commands (10 minutes). */
export const DEFAULT_EXEC_TIMEOUT_MS = 600_000;

/** Default bound on `containerSize` (`container inspect --size` walks the writable layer). */
const CONTAINER_SIZE_TIMEOUT_MS = 60_000;
/** Upper bound on `localDataRoot` (`docker info` answers quickly from a healthy engine). */
const DATA_ROOT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Default timeout for docker commit. Large writable layers can legitimately
 * take minutes. It bounds the whole commit: a flattened commit's inspect,
 * export and import share it (see `commit()`).
 */
export const DEFAULT_COMMIT_TIMEOUT_MS = 600_000;

/** Upper bound for the `docker container inspect` that precedes a flattened commit. */
const COMMIT_CONFIG_INSPECT_TIMEOUT_MS = 10_000;

/**
 * Idle (no-stdout/stderr) timeout for `docker pull`. The Docker daemon
 * heartbeats layer progress every few hundred ms during a healthy pull, so
 * 2 minutes of silence reliably indicates a hung daemon or dead registry
 * connection. The total wall-clock can still legitimately be hours for a
 * slow connection on a large base image like `devcontainers/universal`.
 */
export const PULL_IDLE_TIMEOUT_MS = 120_000;

/**
 * Idle timeout for `docker build`. Builds can have legitimately quiet RUN
 * steps (e.g. compilers running without output), so we allow longer silence
 * than for pulls before declaring the build hung. Combined with
 * `--progress=plain`, BuildKit will still emit per-step progress.
 */
export const BUILD_IDLE_TIMEOUT_MS = 300_000;

/**
 * Idle timeout for a streamed log read (`streamContainerLogs`). Without
 * `--follow` the runtime prints the stored log and exits, so this much
 * silence means a hung daemon rather than a quiet container.
 */
export const LOGS_IDLE_TIMEOUT_MS = 60_000;

/** Grace period for docker stop before SIGKILL. */
const STOP_TIMEOUT_SECONDS = 10;

/** Docker label keys emitted on every IronCurtain-owned container. */
export const IRONCURTAIN_LABEL_BUNDLE = 'ironcurtain.bundle';
export const IRONCURTAIN_LABEL_WORKFLOW = 'ironcurtain.workflow';
export const IRONCURTAIN_LABEL_SCOPE = 'ironcurtain.scope';

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Most objects one `docker <kind> inspect` names. Chunking bounds each argv,
 * and with it the size of an exec error message, which repeats the argv.
 */
export const DOCKER_INSPECT_CHUNK_SIZE = 100;

async function inspectDockerObjects(
  exec: ExecFileFn,
  kind: 'network' | 'container' | 'volume',
  ids: readonly string[],
): Promise<readonly Record<string, unknown>[]> {
  const inspected: Record<string, unknown>[] = [];
  for (let start = 0; start < ids.length; start += DOCKER_INSPECT_CHUNK_SIZE) {
    inspected.push(
      ...(await inspectDockerObjectChunk(exec, kind, ids.slice(start, start + DOCKER_INSPECT_CHUNK_SIZE))),
    );
  }
  return inspected;
}

async function inspectDockerObjectChunk(
  exec: ExecFileFn,
  kind: 'network' | 'container' | 'volume',
  ids: readonly string[],
): Promise<readonly Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  try {
    const { stdout } = await exec('docker', [kind, 'inspect', ...ids], {
      timeout: 30_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`Unexpected docker ${kind} inspect result: expected array`);
    return parsed.filter(isRecord);
  } catch (error) {
    const disappeared =
      isExecError(error) && /not found|no such (?:network|container|volume|object)/i.test(error.stderr);
    if (!disappeared) throw error;
    if (ids.length === 1) return [];

    // A resource disappeared between `docker ... ls` and inspect. Split the
    // failed batch to retain every object that still exists without masking
    // unrelated daemon/permission failures.
    const middle = Math.ceil(ids.length / 2);
    const left = await inspectDockerObjectChunk(exec, kind, ids.slice(0, middle));
    const right = await inspectDockerObjectChunk(exec, kind, ids.slice(middle));
    return [...left, ...right];
  }
}

function parseDockerContainerInfo(entry: Record<string, unknown>): DockerContainerInfo {
  const config = isRecord(entry.Config) ? entry.Config : {};
  const state = isRecord(entry.State) ? entry.State : {};
  const rawName = typeof entry.Name === 'string' ? entry.Name : '';
  return {
    id: typeof entry.Id === 'string' ? entry.Id : '',
    name: rawName.startsWith('/') ? rawName.slice(1) : rawName,
    created: typeof entry.Created === 'string' ? entry.Created : '',
    running: state.Running === true,
    labels: stringRecord(config.Labels),
  };
}

function parseDockerNetworkInfo(entry: Record<string, unknown>): DockerNetworkInfo {
  const ipam = isRecord(entry.IPAM) && Array.isArray(entry.IPAM.Config) ? entry.IPAM.Config : [];
  const subnets = ipam
    .filter(isRecord)
    .map((config) => config.Subnet)
    .filter((subnet): subnet is string => typeof subnet === 'string');
  const containers = isRecord(entry.Containers) ? entry.Containers : {};
  return {
    id: typeof entry.Id === 'string' ? entry.Id : '',
    name: typeof entry.Name === 'string' ? entry.Name : '',
    created: typeof entry.Created === 'string' ? entry.Created : '',
    labels: stringRecord(entry.Labels),
    subnets,
    containerIds: Object.keys(containers),
  };
}

function parseDockerImageId(stdout: string): string {
  const matches = stdout.match(/sha256:[a-f0-9]{64}/gi);
  const imageId = matches?.at(-1);
  if (!imageId) {
    throw new Error(`docker image creation returned unexpected image id: ${stdout.trim() || '(empty)'}`);
  }
  return imageId;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Decimal units the Docker CLI's `units.HumanSize` emits, in order. */
const HUMAN_SIZE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB'] as const;
const HUMAN_SIZE = /^(\d{1,4}(?:\.\d{1,4})?)(B|kB|MB|GB|TB|PB|EB)$/u;
const MAX_MEASURED_VOLUMES = 16_384;

/**
 * Parse `docker system df --verbose --format '{{json .Volumes}}'`: one JSON
 * array whose `Size` strings come from `units.HumanSize` (four significant
 * digits, decimal units) or read `N/A` when the Engine could not size the
 * volume. Anything else fails closed instead of guessing a size.
 */
export function parseDockerVolumeUsage(stdout: string): ReadonlyMap<string, number | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() === '' ? 'null' : stdout) as unknown;
  } catch (error) {
    throw new Error('docker volume usage is not valid JSON', { cause: error });
  }
  // A Desktop VM with no volumes renders the nil slice as `null`.
  if (parsed === null) return new Map();
  if (!Array.isArray(parsed) || parsed.length > MAX_MEASURED_VOLUMES) {
    throw new Error('docker volume usage must be a bounded JSON array');
  }
  const sizes = new Map<string, number | null>();
  for (const entry of parsed as readonly unknown[]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('docker volume usage entry must be an object');
    }
    const { Name: name, Size: size } = entry as Readonly<Record<string, unknown>>;
    if (typeof name !== 'string' || name === '' || typeof size !== 'string') {
      throw new Error('docker volume usage entry is missing its name or size');
    }
    if (sizes.has(name)) throw new Error(`docker volume usage lists ${name} twice`);
    sizes.set(name, size === 'N/A' ? null : parseHumanSize(size));
  }
  return sizes;
}

function parseHumanSize(text: string): number {
  const match = HUMAN_SIZE.exec(text);
  if (match === null) throw new Error(`docker volume usage has an unrecognized size: ${text.slice(0, 32)}`);
  const exponent = HUMAN_SIZE_UNITS.indexOf(match[2] as (typeof HUMAN_SIZE_UNITS)[number]);
  const bytes = Math.round(Number(match[1]) * 1000 ** exponent);
  if (!Number.isSafeInteger(bytes)) throw new Error(`docker volume usage size is out of range: ${text}`);
  return bytes;
}

function parseDockerVolumeInfo(entry: Record<string, unknown>): DockerVolumeInfo {
  const name = typeof entry.Name === 'string' ? entry.Name : '';
  return {
    id: name,
    name,
    created: typeof entry.CreatedAt === 'string' ? entry.CreatedAt : '',
    labels: stringRecord(entry.Labels),
    driver: typeof entry.Driver === 'string' ? entry.Driver : '',
    mountpoint: typeof entry.Mountpoint === 'string' ? entry.Mountpoint : '',
  };
}

/**
 * Renders a value for a Dockerfile `ENV key=value` directive. Values made of
 * safe characters pass through bare; anything else is double-quoted with `\`
 * and `"` escaped so `docker import --change` parses it intact.
 */
function quoteDockerfileValue(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Bundle/turn admission is restaged at create or exec, never baked into an image. */
const SNAPSHOT_TRANSIENT_ENV_NAMES: ReadonlySet<string> = new Set([
  'IRONCURTAIN_MCP_TCP_TOKEN',
  'IRONCURTAIN_HTTP_PROXY_AUTHORIZATION',
  'IRONCURTAIN_FIXED_RELAY_PROXY_AUTHORIZATION',
  'HTTP_PROXY',
  'HTTPS_PROXY',
]);

/**
 * Reads a container's effective Config (ENTRYPOINT/CMD/WORKDIR/USER/ENV) and
 * renders it as Dockerfile `--change` directives. `docker export | docker
 * import` flattens a container to a single-layer image but DROPS the image
 * Config; re-baking it keeps a flattened snapshot behaving like its source on
 * resume (the baked ENTRYPOINT runs the UID-remap + proxy bridge, and ENV
 * carries the base-image PATH that container creation intentionally never
 * re-supplies). Transient transport/proxy credentials are excluded before
 * rendering argv; each new bundle or invocation restages its own admission.
 * **Throws** when the config cannot be read or parsed, so the
 * flattened commit fails rather than shipping a config-less image that would
 * resume broken; callers treat a snapshot failure as fall-back-to-fresh. (A
 * successful read that genuinely yields no directives is fine and proceeds.)
 */
async function readContainerConfigChanges(exec: ExecFileFn, containerId: string, timeoutMs: number): Promise<string[]> {
  // Let an inspect failure propagate (do NOT swallow): a flattened snapshot with
  // no re-baked ENTRYPOINT/PATH resumes broken, so failing the snapshot is safer
  // than producing a config-less image.
  const { stdout } = await exec('docker', ['container', 'inspect', '--format', '{{json .Config}}', containerId], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`docker container inspect returned unparseable Config for ${containerId}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`docker container inspect returned a non-object Config for ${containerId}`);
  }

  const changes: string[] = [];
  const entrypoint = asStringArray(parsed.Entrypoint);
  if (entrypoint.length > 0) changes.push(`ENTRYPOINT ${JSON.stringify(entrypoint)}`);
  const cmd = asStringArray(parsed.Cmd);
  if (cmd.length > 0) changes.push(`CMD ${JSON.stringify(cmd)}`);
  if (typeof parsed.WorkingDir === 'string' && parsed.WorkingDir.length > 0) {
    changes.push(`WORKDIR ${parsed.WorkingDir}`);
  }
  if (typeof parsed.User === 'string' && parsed.User.length > 0) {
    changes.push(`USER ${parsed.User}`);
  }
  for (const entry of asStringArray(parsed.Env)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (SNAPSHOT_TRANSIENT_ENV_NAMES.has(key.toUpperCase())) continue;
    const value = entry.slice(eq + 1);
    // A single ENV directive can't carry a newline; such values are dynamic
    // (re-supplied at create) so dropping them from the snapshot is safe.
    if (/[\r\n]/.test(value)) continue;
    changes.push(`ENV ${key}=${quoteDockerfileValue(value)}`);
  }
  return changes;
}

/**
 * Builds the `docker create` argument list from a container config.
 * Exported for testing.
 */
export function buildCreateArgs(config: DockerContainerConfig): string[] {
  if (config.publishSockets && config.publishSockets.length > 0) {
    throw new Error('publishSockets is apple-container-only (--publish-socket has no Docker equivalent)');
  }

  const args = ['create'];

  args.push('--name', config.name);
  args.push('--network', config.network);
  if (config.ipv4Address !== undefined) {
    if (config.network === 'none' || !isIPv4(config.ipv4Address)) {
      throw new Error('container ipv4Address requires a named network and an IPv4 literal');
    }
    args.push('--ip', config.ipv4Address);
  }

  // Run an init process (docker-init / tini) as PID 1 so zombie children are
  // reaped. Without this, processes orphaned inside the container linger as
  // zombies under `sleep infinity`, and `kill -0 <pid>` returns success for
  // them — which silently breaks watcher loops in agent-generated scripts
  // (see workflow-scratch.md entry #22). The flag is harmless for short-
  // lived sidecar/service containers.
  args.push('--init');

  // Custom host mappings override the default host-gateway mapping
  if (config.extraHosts !== undefined) {
    for (const entry of config.extraHosts) {
      args.push(`--add-host=${entry}`);
    }
  } else if (config.network !== 'none') {
    // Linux needs explicit host.docker.internal mapping (useless with --network=none)
    args.push('--add-host=host.docker.internal:host-gateway');
  }

  // Security: drop all capabilities, then selectively re-add
  args.push('--cap-drop=ALL');
  for (const cap of config.capAdd ?? []) {
    args.push('--cap-add', cap);
  }

  // Port bindings (service containers only)
  for (const port of config.ports ?? []) {
    args.push('-p', port);
  }

  // Restart policy (service containers only)
  if (config.restartPolicy) {
    args.push('--restart', config.restartPolicy);
  }

  // Emit IronCurtain label scheme. See docs/designs/workflow-session-identity.md §7:
  //   - `ironcurtain.bundle` is always present on IronCurtain-owned containers.
  //   - `ironcurtain.workflow` + `ironcurtain.scope` are only set in workflow mode.
  // Each label is emitted only when its value is defined (present-or-absent contract)
  // so we never produce `--label ironcurtain.workflow=undefined` for standalone
  // sessions. An explicitly set empty string still emits, matching the type contract.
  if (config.bundleLabel !== undefined) {
    args.push('--label', `${IRONCURTAIN_LABEL_BUNDLE}=${config.bundleLabel}`);
  }
  if (config.workflowLabel !== undefined) {
    args.push('--label', `${IRONCURTAIN_LABEL_WORKFLOW}=${config.workflowLabel}`);
  }
  if (config.scopeLabel !== undefined) {
    args.push('--label', `${IRONCURTAIN_LABEL_SCOPE}=${config.scopeLabel}`);
  }
  for (const [key, value] of Object.entries(config.labels ?? {})) {
    args.push('--label', `${key}=${value}`);
  }

  if (config.resources?.memoryMb) {
    args.push('--memory', `${config.resources.memoryMb}m`);
    // `--memory-swap` equal to `--memory` means "no swap": a bounded container
    // must not be able to push the host into swap by exceeding its memory
    // ceiling (audit finding DINF-11).
    args.push('--memory-swap', `${config.resources.memoryMb}m`);
  }
  if (config.resources?.cpus) {
    args.push('--cpus', String(config.resources.cpus));
  }

  for (const mount of config.mounts) {
    const opts = mount.readonly ? ':ro' : '';
    args.push('-v', `${mount.source}:${mount.target}${opts}`);
  }

  const trusted = config.trustedCreateOptions;
  for (const mount of trusted?.namedVolumeMounts ?? []) {
    const options = [
      `type=volume`,
      `src=${mount.name}`,
      `dst=${mount.target}`,
      ...(mount.readonly === true ? ['readonly'] : []),
      ...(mount.noCopy === true ? ['volume-nocopy'] : []),
    ];
    args.push('--mount', options.join(','));
  }
  for (const device of trusted?.devices ?? []) {
    if (
      !device.source.startsWith('/') ||
      !device.target.startsWith('/') ||
      device.source.includes(':') ||
      device.target.includes(':')
    ) {
      throw new Error('trusted device mappings require colon-free absolute source and target paths');
    }
    args.push('--device', `${device.source}:${device.target}:${device.permissions}`);
  }
  for (const tmpfs of trusted?.tmpfs ?? []) {
    args.push('--tmpfs', tmpfs);
  }
  if (trusted?.readOnlyRootfs === true) {
    args.push('--read-only');
  }
  for (const securityOption of trusted?.securityOptions ?? []) {
    if (/^seccomp=/u.test(securityOption)) {
      throw new Error('trusted securityOptions must use the dedicated seccompProfile field for seccomp');
    }
    args.push('--security-opt', securityOption);
  }
  if (trusted?.seccompProfile !== undefined) {
    args.push('--security-opt', `seccomp=${trusted.seccompProfile}`);
  }
  if (trusted?.pidsLimit !== undefined) {
    if (!Number.isSafeInteger(trusted.pidsLimit) || trusted.pidsLimit <= 0) {
      throw new Error('trusted pidsLimit must be a positive safe integer');
    }
    args.push('--pids-limit', String(trusted.pidsLimit));
  }
  for (const ulimit of trusted?.ulimits ?? []) {
    args.push('--ulimit', formatUlimit(ulimit));
  }

  for (const [key, value] of Object.entries(config.env)) {
    args.push('-e', `${key}=${value}`);
  }
  for (const [key, value] of Object.entries(config.privateEnv ?? {})) {
    if (key in config.env || typeof value !== 'string') {
      throw new Error('Private container environment must contain distinct string-valued keys');
    }
  }
  args.push(...buildContainerExecEnvironmentArgs(config.privateEnv));

  if (config.entrypoint !== undefined) {
    args.push('--entrypoint', config.entrypoint);
  }

  if (config.tty) {
    args.push('-t');
  }

  // Linux-only: when set (typically to '0:0'), runs the entrypoint as
  // root so it can renumber the codespace user before dropping
  // privileges. macOS skips this (VirtioFS handles UID translation).
  // See `DockerContainerConfig.user` JSDoc.
  if (config.user !== undefined) {
    args.push('--user', config.user);
  }

  args.push(config.image);
  args.push(...config.command);

  return args;
}

/** `--ulimit` names the trusted create options may set (see `DockerUlimit`). */
const SUPPORTED_ULIMIT_NAMES: ReadonlySet<string> = new Set(['nofile']);

/**
 * Renders one `--ulimit` value. Soft and hard are positive safe integers with
 * soft <= hard; `-1` (unlimited) is deliberately rejected because these flags
 * exist to bound the container, never to lift a daemon default.
 */
function formatUlimit(ulimit: DockerUlimit): string {
  if (!SUPPORTED_ULIMIT_NAMES.has(ulimit.name)) {
    throw new Error(`unsupported ulimit name: ${ulimit.name}`);
  }
  for (const value of [ulimit.soft, ulimit.hard]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`ulimit ${ulimit.name} requires positive safe integers`);
    }
  }
  if (ulimit.soft > ulimit.hard) {
    throw new Error(`ulimit ${ulimit.name} soft limit exceeds its hard limit`);
  }
  return `${ulimit.name}=${ulimit.soft}:${ulimit.hard}`;
}

/** Test seams for the streaming spawn path used by pull/build. */
export interface CreateDockerManagerOptions {
  endpoint?: DockerEndpoint;
  /**
   * `docker exec --user` for calls that pass no `execUser` (default
   * `codespace`). A sudo-off agent bundle sets its numeric agent UID here, so
   * no exec depends on the image mapping an account name to a non-root UID
   * (see `agent-privileges.ts`).
   */
  defaultExecUser?: string;
  /** Interactive exec uses the same filtered host terminal relay as Apple. */
  readonly spawnPty?: HostPtySpawn;
  readonly terminal?: HostTerminalStreams;
  spawn?: SpawnFn;
  stdoutSink?: NodeJS.WritableStream;
  stderrSink?: NodeJS.WritableStream;
  /**
   * Override the progress-sink factory (tests). When `stdoutSink` /
   * `stderrSink` are provided explicitly the progress sink is bypassed
   * regardless of this option.
   */
  progressSinkFactory?: (opts: CreateDockerProgressSinkOptions) => DockerProgressSink;
}

/** Streaming-sink options shared by the runtime managers' build/pull runner. */
export interface StreamOpts {
  spawn?: SpawnFn;
  stdoutSink?: NodeJS.WritableStream;
  stderrSink?: NodeJS.WritableStream;
}

/**
 * Builds the streaming `pull`/`build` runner shared by the Docker and Apple
 * `container` managers: it drives `spawnWithIdleTimeout` for `bin` and wraps the
 * raw output flood in a progress sink (collapsed status line on a TTY, verbatim
 * otherwise), bypassing the sink when the caller injected explicit sinks (tests).
 */
export function makeRunStreamed(
  bin: string,
  streamOpts: StreamOpts,
  progressSinkFactory: (opts: CreateDockerProgressSinkOptions) => DockerProgressSink,
): (params: {
  operation: DockerProgressOperation;
  args: readonly string[];
  idleTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
  envMode?: SpawnWithIdleTimeoutOptions['envMode'];
}) => Promise<void> {
  return async (params) => {
    const hasInjectedSinks = streamOpts.stdoutSink !== undefined && streamOpts.stderrSink !== undefined;
    const progress: DockerProgressSink | undefined = hasInjectedSinks
      ? undefined
      : progressSinkFactory({ operation: params.operation });
    try {
      await spawnWithIdleTimeout(bin, params.args, {
        idleTimeoutMs: params.idleTimeoutMs,
        operation: params.operation,
        env: params.env,
        envMode: params.envMode,
        spawn: streamOpts.spawn,
        stdoutSink: streamOpts.stdoutSink ?? progress?.stdout,
        stderrSink: streamOpts.stderrSink ?? progress?.stderr,
      });
      progress?.finish(true);
    } catch (err) {
      progress?.finish(false);
      progress?.dumpRecent();
      throw err;
    }
  };
}

export function createDockerManager(
  execFileFn?: ExecFileFn,
  dockerAvailabilityProbe?: () => Promise<DockerAvailability>,
  spawnOpts?: CreateDockerManagerOptions,
): ContainerRuntime {
  const endpoint =
    spawnOpts?.endpoint === undefined ? undefined : Object.freeze(dockerEndpointSchema.parse(spawnOpts.endpoint));
  const defaultExecUser = spawnOpts?.defaultExecUser ?? 'codespace';
  const exec =
    endpoint === undefined
      ? (execFileFn ?? defaultExecFile)
      : bindDockerEndpointExec(endpoint, execFileFn ?? defaultExecFile);
  const availabilityProbe =
    dockerAvailabilityProbe ?? (endpoint === undefined ? checkDockerAvailable : () => checkDockerAvailable(exec));
  const streamOpts = {
    spawn: spawnOpts?.spawn,
    stdoutSink: spawnOpts?.stdoutSink,
    stderrSink: spawnOpts?.stderrSink,
  };
  const progressSinkFactory = spawnOpts?.progressSinkFactory ?? createDockerProgressSink;
  const stream = makeRunStreamed('docker', streamOpts, progressSinkFactory);
  const runStreamed: typeof stream = (params) =>
    stream(
      endpoint === undefined
        ? params
        : {
            ...params,
            args: ['--host', endpoint.host, ...params.args],
            env: dockerEndpointEnvironment(endpoint, { ...process.env, ...params.env }),
            envMode: 'replace',
          },
    );

  return {
    supportsImageSnapshots: true,
    ...(endpoint === undefined ? {} : { dockerEndpoint: endpoint }),

    async preflight(image: string): Promise<void> {
      const status = await availabilityProbe();
      if (!status.available) {
        throw new Error(`Docker is not available. ${status.detailedMessage}`);
      }

      try {
        await exec('docker', ['image', 'inspect', image], { timeout: 10_000 });
      } catch {
        throw new Error(`Docker image not found: ${image}. Build it first.`);
      }
    },

    async create(config: DockerContainerConfig): Promise<string> {
      const args = buildCreateArgs(config);
      const { stdout } = await exec('docker', args, {
        timeout: 30_000,
        ...(config.privateEnv ? { env: { ...inheritedEnv(), ...config.privateEnv } } : {}),
      });
      return stdout.trim();
    },

    async start(nameOrId: string): Promise<void> {
      await exec('docker', ['start', nameOrId], { timeout: 30_000 });
    },

    async readContainerLogTail(nameOrId: string): Promise<string> {
      try {
        const { stdout, stderr } = await exec('docker', ['logs', '--tail', '100', nameOrId], {
          timeout: 10_000,
          maxBuffer: 256 * 1024,
        });
        return boundedLogTail([stdout, stderr].filter(Boolean).join('\n'), 16 * 1024);
      } catch (error) {
        if (!isExecError(error) || error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
        return boundedLogTail(
          [error.stdout, error.stderr, '(docker logs output truncated)'].filter(Boolean).join('\n'),
          16 * 1024,
        );
      }
    },

    streamContainerLogs(nameOrId: string, sink: NodeJS.WritableStream): Promise<void> {
      // Bound to the captured endpoint like every other docker call: an
      // explicit --host and no inherited routing overrides.
      const args = ['logs', nameOrId];
      return spawnWithIdleTimeout('docker', endpoint === undefined ? args : ['--host', endpoint.host, ...args], {
        idleTimeoutMs: LOGS_IDLE_TIMEOUT_MS,
        operation: 'docker logs',
        ...(endpoint === undefined
          ? {}
          : { env: dockerEndpointEnvironment(endpoint, process.env), envMode: 'replace' as const }),
        spawn: streamOpts.spawn,
        stdoutSink: sink,
        stderrSink: sink,
      });
    },

    async probeImageVersion(image: string, command: readonly string[]): Promise<string | undefined> {
      const [entrypoint, ...rest] = command;
      if (!entrypoint) return undefined;
      try {
        // `--network none`: the probe executes the agent binary (e.g.
        // `claude --version`), which may attempt update-check/telemetry egress.
        // Agent containers run with no network; keep this diagnostic isolated too
        // (a version string is baked in and needs no network).
        const { stdout } = await exec(
          'docker',
          ['run', '--rm', '--network', 'none', '--entrypoint', entrypoint, image, ...rest],
          { timeout: 20_000 },
        );
        const version = stdout.trim();
        return version.length > 0 ? version : undefined;
      } catch {
        // Best-effort diagnostic — never fail over a version probe.
        return undefined;
      }
    },

    async execPty(
      nameOrId: string,
      command: readonly string[],
      signal?: AbortSignal,
      execUser?: string | null,
    ): Promise<number> {
      if (signal?.aborted) return 0;
      const user = execUser === undefined ? defaultExecUser : execUser;
      const args = [
        ...(endpoint === undefined ? [] : ['--host', endpoint.host]),
        'exec',
        '--interactive',
        '--tty',
        ...(user === null ? [] : ['--user', user]),
        nameOrId,
        ...command,
      ];
      const terminal = spawnOpts?.terminal;
      const output = terminal?.output ?? process.stdout;
      const size = clampPtySize(output.columns ?? 80, output.rows ?? 24);
      const spawnPty = spawnOpts?.spawnPty ?? (await loadNodePty({ purpose: 'Docker interactive sessions' })).spawn;
      if (signal?.aborted) return 0;
      const child = spawnPty('docker', args, {
        name: process.env.TERM ?? 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd: process.cwd(),
        env: endpoint === undefined ? inheritedEnv() : dockerEndpointEnvironment(endpoint, inheritedEnv()),
      });
      return relayHostPty(child, { signal, terminal });
    },

    async exec(
      nameOrId: string,
      command: readonly string[],
      timeoutMs?: number,
      execUser?: string | null,
      workdir?: string,
      environment?: Readonly<Record<string, string>>,
    ): Promise<DockerExecResult> {
      const timeout = timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
      // Resolve the `--user` flag (see ContainerRuntime.exec JSDoc):
      //   undefined → the manager's default exec user: 'codespace' for
      //               agent containers, the numeric agent UID for a
      //               sudo-off bundle (`defaultExecUser`)
      //   string    → override
      //   null      → skip the flag entirely (non-agent containers
      //               without a codespace account, e.g. signal-cli)
      // On Linux, agent containers are created with `--user 0:0` (see
      // issue #232) so the entrypoint can renumber the codespace user;
      // without an explicit `--user codespace` here, every exec would
      // land as root and bypass the sudoers / $HOME setup the agent
      // expects. On macOS, `--user 0:0` is not passed and the
      // Dockerfile `USER codespace` directive already takes effect,
      // but re-asserting `codespace` is a harmless no-op.
      const resolvedUser = execUser === undefined ? defaultExecUser : execUser;
      const userArgs = resolvedUser === null ? [] : (['--user', resolvedUser] as const);
      const workdirArgs = workdir === undefined ? [] : (['--workdir', workdir] as const);
      const environmentArgs = buildContainerExecEnvironmentArgs(environment);
      // Routing and platform settings belong to the inner exec too. The host CLI
      // uses its captured endpoint; pass these non-secret settings as
      // explicit container values so endpoint sanitization cannot alter them.
      if (endpoint !== undefined && environment !== undefined) {
        for (const key of DOCKER_ENDPOINT_ENVIRONMENT_KEYS) {
          if (!Object.hasOwn(environment, key)) continue;
          const index = environmentArgs.indexOf(key);
          if (index !== -1) environmentArgs[index] = `${key}=${environment[key]}`;
        }
      }
      // The deadline is classified from the killed child, never from the
      // CLI's exit code: `docker exec` exits 0 when Node SIGTERMs it, which
      // used to make a timed-out turn look like a completed one. Elapsed
      // time is a fallback only, and monotonic so a host suspend is never
      // counted as exec time (see exec-deadline.ts).
      const startedAt = performance.now();
      let result: DockerExecResult;
      try {
        const outcome = await exec(
          'docker',
          ['exec', ...userArgs, ...workdirArgs, ...environmentArgs, nameOrId, ...command],
          {
            timeout,
            maxBuffer: 50 * 1024 * 1024,
            ...(environment ? { env: { ...inheritedEnv(), ...environment } } : {}),
          },
        );
        result = resolvedExecResult(outcome, timeout, performance.now() - startedAt);
      } catch (err: unknown) {
        if (!isExecError(err)) throw err;
        result = rejectedExecResult(err, timeout, performance.now() - startedAt);
      }
      if (result.timedOut === true) {
        logger.warn(
          `[docker-manager] exec timed out after ${timeout}ms (elapsed ${Math.round(performance.now() - startedAt)}ms): ` +
            `docker exec ${nameOrId} ${command[0] ?? ''}; the in-container process may still be running`,
        );
      }
      return result;
    },

    async stop(nameOrId: string): Promise<void> {
      try {
        await exec('docker', ['stop', '-t', String(STOP_TIMEOUT_SECONDS), nameOrId], {
          timeout: (STOP_TIMEOUT_SECONDS + 5) * 1000,
        });
      } catch {
        // Container may already be stopped
      }
    },

    async remove(nameOrId: string): Promise<void> {
      try {
        await exec('docker', ['rm', '-f', nameOrId], { timeout: 10_000 });
      } catch {
        // Container may already be removed
      }
    },

    async isRunning(nameOrId: string, options = {}): Promise<boolean> {
      try {
        const { stdout } = await exec('docker', ['inspect', '-f', '{{.State.Running}}', nameOrId], {
          timeout: 5_000,
        });
        const value = stdout.trim();
        if (options.throwOnError && value !== 'true' && value !== 'false') {
          throw new Error('Docker inspect returned an invalid running state');
        }
        return value === 'true';
      } catch (error) {
        if (options.throwOnError) throw error;
        return false;
      }
    },

    async imageExists(image: string): Promise<boolean> {
      try {
        await exec('docker', ['image', 'inspect', image], { timeout: 10_000 });
        return true;
      } catch {
        return false;
      }
    },

    async commit(containerId: string, options = {}): Promise<string> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS;
      if (options.flatten === true) {
        // `timeoutMs` bounds the whole flattened commit, not each docker call:
        // the inspect, the export and the import share one deadline, so a
        // caller that must be done by a deadline (a shutdown's snapshot budget)
        // can rely on it. Zero keeps its "no timeout" meaning.
        const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
        const stepTimeoutMs = (cap = Number.POSITIVE_INFINITY): number => {
          if (deadline === undefined) return Number.isFinite(cap) ? cap : 0;
          const left = deadline - Date.now();
          if (left <= 0) {
            throw new Error(`docker commit of ${containerId} did not finish within its ${timeoutMs} ms timeout`);
          }
          return Math.min(cap, left);
        };
        // Re-bake the image Config that export/import drops. Read it BEFORE
        // export so a still-running container reports its live ENTRYPOINT/ENV.
        const configChanges = await readContainerConfigChanges(
          exec,
          containerId,
          stepTimeoutMs(COMMIT_CONFIG_INSPECT_TIMEOUT_MS),
        );
        const dir = mkdtempSync(join(tmpdir(), 'ironcurtain-snapshot-'));
        const tarPath = join(dir, 'container.tar');
        try {
          await exec('docker', ['export', '--output', tarPath, containerId], {
            timeout: stepTimeoutMs(),
            maxBuffer: 1024 * 1024,
          });
          const args = ['import'];
          // Config first, then caller changes (labels) so a caller can override.
          for (const change of [...configChanges, ...(options.changes ?? [])]) {
            args.push('--change', change);
          }
          args.push(tarPath);
          if (options.tag !== undefined) {
            args.push(options.tag);
          }
          const { stdout } = await exec('docker', args, {
            timeout: stepTimeoutMs(),
            maxBuffer: 1024 * 1024,
          });
          return parseDockerImageId(stdout);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }

      const args = ['commit'];
      if (options.pause === false) {
        args.push('--no-pause');
      }
      for (const change of options.changes ?? []) {
        args.push('--change', change);
      }
      args.push(containerId);
      if (options.tag !== undefined) {
        args.push(options.tag);
      }
      const { stdout } = await exec('docker', args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      return parseDockerImageId(stdout);
    },

    async removeImage(ref: string): Promise<boolean> {
      try {
        await exec('docker', ['image', 'rm', '--force', ref], { timeout: 60_000, maxBuffer: 1024 * 1024 });
        return true;
      } catch (err: unknown) {
        if (isExecError(err) && /no such image|not found|does not exist/i.test(err.stderr)) {
          // Already gone -- nothing to reclaim.
          return false;
        }
        if (isExecError(err) && /image is being used|in use by|dependent child|conflict/i.test(err.stderr)) {
          // Still pinned by a running container or a derived image. Not a hard
          // failure: a later GC sweep reclaims it once the holder is gone.
          // Logged distinctly so it isn't conflated with an unexpected error.
          logger.warn(`[docker-manager] image ${ref} still in use; deferring removal to a later sweep`);
          return false;
        }
        const detail = isExecError(err) ? err.stderr.trim() || err.message : String(err);
        logger.warn(`[docker-manager] failed to remove image ${ref}: ${detail}`);
        return false;
      }
    },

    async listImages(options?: { readonly labelFilter?: string }): Promise<readonly DockerImageInfo[]> {
      const args = ['image', 'ls', '--no-trunc', '--quiet'];
      if (options?.labelFilter !== undefined) {
        args.push('--filter', `label=${options.labelFilter}`);
      }
      const { stdout } = await exec('docker', args, { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
      const ids = [
        ...new Set(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ];
      if (ids.length === 0) return [];
      const { stdout: inspectStdout } = await exec('docker', ['image', 'inspect', ...ids], {
        timeout: 30_000,
        maxBuffer: 50 * 1024 * 1024,
      });
      const parsed = JSON.parse(inspectStdout) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Unexpected docker image inspect result: expected array');
      }
      return parsed.map(parseDockerImageInfo);
    },

    async inspectImage(ref: string): Promise<DockerImageInfo | undefined> {
      try {
        const { stdout } = await exec('docker', ['image', 'inspect', ref], {
          timeout: 10_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const parsed = JSON.parse(stdout) as unknown;
        if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
        return parseDockerImageInfo(parsed[0]);
      } catch {
        return undefined;
      }
    },

    async containerSize(nameOrId: string, timeoutMs = CONTAINER_SIZE_TIMEOUT_MS): Promise<number | undefined> {
      try {
        // `--size` makes the engine total the writable layer, which can take
        // a while on a large container: always bounded.
        const { stdout } = await exec(
          'docker',
          ['container', 'inspect', '--size', '--format', '{{json .SizeRootFs}}', nameOrId],
          { timeout: Math.max(1, timeoutMs), maxBuffer: 64 * 1024 },
        );
        const size = JSON.parse(stdout.trim()) as unknown;
        return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : undefined;
      } catch {
        return undefined;
      }
    },

    async localDataRoot(timeoutMs = DATA_ROOT_PROBE_TIMEOUT_MS): Promise<string | undefined> {
      try {
        const { stdout } = await exec('docker', ['info', '--format', '{{json .}}'], {
          timeout: Math.max(1, Math.min(DATA_ROOT_PROBE_TIMEOUT_MS, timeoutMs)),
          maxBuffer: 4 * 1024 * 1024,
        });
        const info = JSON.parse(stdout) as { DockerRootDir?: unknown; Name?: unknown };
        const root = info.DockerRootDir;
        // An engine in a VM (Docker Desktop, colima) or on another host reports
        // its own hostname and a path that is not on this filesystem.
        if (typeof root !== 'string' || !isAbsolute(root) || info.Name !== hostname()) return undefined;
        return existsSync(root) ? root : undefined;
      } catch {
        return undefined;
      }
    },

    async tagImage(sourceRef: string, targetRef: string): Promise<void> {
      await exec('docker', ['image', 'tag', sourceRef, targetRef], { timeout: 30_000 });
    },

    async saveImageArchive(ref: string, archivePath: string, platform?: 'linux/amd64' | 'linux/arm64'): Promise<void> {
      const args = ['image', 'save', '--output', archivePath];
      if (platform !== undefined) args.push('--platform', platform);
      args.push(ref);
      await exec('docker', args, { timeout: DEFAULT_COMMIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    },

    async loadImageArchive(archivePath: string): Promise<void> {
      await runStreamed({
        operation: 'docker image load',
        args: ['image', 'load', '--input', archivePath],
        idleTimeoutMs: BUILD_IDLE_TIMEOUT_MS,
      });
    },

    async buildImage(
      tag: string,
      dockerfilePath: string,
      contextDir: string,
      labels?: Record<string, string>,
      buildArgs?: Readonly<Record<string, string>>,
      options?: ImageBuildOptions,
    ): Promise<void> {
      // `--progress=plain` plus BuildKit gives line-oriented streamed output,
      // which (a) makes the user-visible "what's happening" question
      // answerable and (b) provides the per-step heartbeat the idle-timeout
      // watchdog needs to distinguish a quiet RUN from a hung builder.
      // The default builder uses the captured Docker endpoint. A caller's
      // BUILDX_BUILDER must not send these images to a different builder.
      const args = [
        'build',
        ...(endpoint === undefined ? [] : ['--builder', 'default']),
        '--progress=plain',
        '-t',
        tag,
        '-f',
        dockerfilePath,
      ];
      if (options?.noCache === true) args.push('--no-cache');
      if (labels) {
        for (const [key, value] of Object.entries(labels)) {
          args.push('--label', `${key}=${value}`);
        }
      }
      for (const [key, value] of Object.entries(buildArgs ?? {})) args.push('--build-arg', `${key}=${value}`);
      args.push(contextDir);
      await runStreamed({
        operation: 'docker build',
        args,
        idleTimeoutMs: BUILD_IDLE_TIMEOUT_MS,
        env: { DOCKER_BUILDKIT: '1' },
      });
    },

    async getImageLabel(image: string, label: string): Promise<string | undefined> {
      try {
        const { stdout } = await exec('docker', ['inspect', '-f', `{{index .Config.Labels "${label}"}}`, image], {
          timeout: 10_000,
        });
        const value = stdout.trim();
        // docker inspect returns '<no value>' when the label doesn't exist
        return value && value !== '<no value>' ? value : undefined;
      } catch {
        return undefined;
      }
    },

    async getContainerLabel(container: string, label: string): Promise<string | undefined> {
      try {
        const { stdout } = await exec('docker', ['inspect', '-f', `{{index .Config.Labels "${label}"}}`, container], {
          timeout: 5_000,
        });
        const value = stdout.trim();
        return value && value !== '<no value>' ? value : undefined;
      } catch {
        return undefined;
      }
    },

    async createNetwork(name: string, options?: DockerNetworkCreateOptions): Promise<void> {
      try {
        const args = ['network', 'create'];
        if (options?.internal) args.push('--internal');
        if (options?.subnet) args.push('--subnet', options.subnet);
        if (options?.ipv6Subnet) args.push('--subnet', options.ipv6Subnet);
        if (options?.gateway) args.push('--gateway', options.gateway);
        if (options?.enableIPv6) args.push('--ipv6');
        for (const [key, value] of Object.entries(options?.driverOptions ?? {})) {
          args.push('--opt', `${key}=${value}`);
        }
        for (const [key, value] of Object.entries(options?.labels ?? {})) {
          args.push('--label', `${key}=${value}`);
        }
        args.push(name);
        await exec('docker', args, { timeout: 10_000 });
      } catch (err: unknown) {
        if (isExecError(err) && err.stderr.includes('already exists')) return;
        throw err;
      }
    },

    async listNetworks(options?: { readonly labelFilter?: string }): Promise<readonly DockerNetworkInfo[]> {
      const args = ['network', 'ls', '--no-trunc', '--quiet'];
      if (options?.labelFilter) args.push('--filter', `label=${options.labelFilter}`);
      const { stdout: idsOut } = await exec('docker', args, {
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const ids = idsOut
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (ids.length === 0) return [];
      const inspected = await inspectDockerObjects(exec, 'network', ids);
      return inspected.map(parseDockerNetworkInfo);
    },

    async listContainers(options?: { readonly labelFilter?: string }): Promise<readonly DockerContainerInfo[]> {
      const args = ['container', 'ls', '--all', '--no-trunc', '--quiet'];
      if (options?.labelFilter) args.push('--filter', `label=${options.labelFilter}`);
      const { stdout: idsOut } = await exec('docker', args, {
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const ids = idsOut
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (ids.length === 0) return [];
      const inspected = await inspectDockerObjects(exec, 'container', ids);
      return inspected.map(parseDockerContainerInfo);
    },

    async inspectContainer(nameOrId: string): Promise<DockerContainerInfo | undefined> {
      const entry = (await inspectDockerObjects(exec, 'container', [nameOrId])).at(0);
      return entry === undefined ? undefined : parseDockerContainerInfo(entry);
    },

    async inspectNetwork(nameOrId: string): Promise<DockerNetworkInfo | undefined> {
      const entry = (await inspectDockerObjects(exec, 'network', [nameOrId])).at(0);
      return entry === undefined ? undefined : parseDockerNetworkInfo(entry);
    },

    async inspectContainerRaw(nameOrId: string): Promise<Readonly<Record<string, unknown>> | undefined> {
      return (await inspectDockerObjects(exec, 'container', [nameOrId])).at(0);
    },

    async removeNetwork(name: string): Promise<void> {
      try {
        await exec('docker', ['network', 'rm', name], { timeout: 10_000 });
      } catch (err: unknown) {
        // Non-fatal: callers invoke this in best-effort teardown paths and
        // depend on it never throwing. But a genuine failure here orphans the
        // network (there is no stale-network reaper, unlike removeStaleContainer),
        // so surface it rather than swallowing silently. "not found" is benign
        // (already removed) and stays quiet.
        if (isExecError(err) && /not found|no such network/i.test(err.stderr)) return;
        const detail = isExecError(err) ? err.stderr.trim() || err.message : String(err);
        logger.warn(`removeNetwork: failed to remove "${name}": ${detail}`);
      }
    },

    async networkExists(name: string): Promise<boolean> {
      try {
        await exec('docker', ['network', 'inspect', name], { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    },

    async createVolume(name: string, options?: DockerVolumeCreateOptions): Promise<string> {
      const args = ['volume', 'create'];
      if (options?.driver !== undefined) args.push('--driver', options.driver);
      for (const [key, value] of Object.entries(options?.driverOptions ?? {})) {
        args.push('--opt', `${key}=${value}`);
      }
      for (const [key, value] of Object.entries(options?.labels ?? {})) {
        args.push('--label', `${key}=${value}`);
      }
      args.push(name);
      const { stdout } = await exec('docker', args, { timeout: 10_000, maxBuffer: 1024 * 1024 });
      const createdName = stdout.trim();
      if (createdName !== name) {
        throw new Error(`Docker returned an unexpected volume identity for ${name}: ${createdName || '(empty)'}`);
      }
      const inspected = await inspectDockerObjects(exec, 'volume', [createdName]);
      const created = inspected.at(0);
      if (created === undefined) throw new Error(`Docker-created volume disappeared before ownership check: ${name}`);
      const info = parseDockerVolumeInfo(created);
      if (info.name !== name) {
        throw new Error(`Docker returned mismatched volume inspect identity for ${name}: ${info.name || '(empty)'}`);
      }
      for (const [key, value] of Object.entries(options?.labels ?? {})) {
        if (info.labels[key] !== value) {
          throw new Error(`Docker volume ${name} does not carry requested ownership label ${key}`);
        }
      }
      return info.id;
    },

    async inspectVolume(name: string): Promise<DockerVolumeInfo | undefined> {
      const inspected = await inspectDockerObjects(exec, 'volume', [name]);
      const entry = inspected.at(0);
      return entry === undefined ? undefined : parseDockerVolumeInfo(entry);
    },

    async listVolumes(options?: { readonly labelFilter?: string }): Promise<readonly DockerVolumeInfo[]> {
      const args = ['volume', 'ls', '--quiet'];
      if (options?.labelFilter !== undefined) args.push('--filter', `label=${options.labelFilter}`);
      const { stdout } = await exec('docker', args, { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
      const names = [
        ...new Set(
          stdout
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ];
      const inspected = await inspectDockerObjects(exec, 'volume', names);
      return inspected.map(parseDockerVolumeInfo);
    },

    async measureVolumeUsage(timeoutMs: number): Promise<ReadonlyMap<string, number | null>> {
      const { stdout } = await exec('docker', ['system', 'df', '--verbose', '--format', '{{json .Volumes}}'], {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      return parseDockerVolumeUsage(stdout);
    },

    async removeVolume(name: string): Promise<void> {
      try {
        await exec('docker', ['volume', 'rm', name], { timeout: 10_000 });
      } catch (err: unknown) {
        if (isExecError(err) && /not found|no such volume/i.test(err.stderr)) return;
        throw err;
      }
    },

    async pullImage(image: string): Promise<void> {
      // Streamed via spawn (not execFile) so the watchdog can reset on
      // every heartbeat. Large images like devcontainers/universal
      // (~5 GB) on slow links legitimately take an hour or more; only
      // true silence kills. The progress sink collapses the per-layer
      // chatter into a single updating status line.
      await runStreamed({
        operation: 'docker pull',
        args: ['pull', image],
        idleTimeoutMs: PULL_IDLE_TIMEOUT_MS,
      });
    },

    async getImageId(nameOrId: string): Promise<string | undefined> {
      // Try as image first (returns the image's own ID)
      try {
        const { stdout } = await exec('docker', ['image', 'inspect', '-f', '{{.Id}}', nameOrId], {
          timeout: 5_000,
        });
        const id = stdout.trim();
        if (id) return id;
      } catch {
        // Not an image - fall through to container inspection
      }

      // Try as container (returns the image ID the container was created from)
      try {
        const { stdout } = await exec('docker', ['inspect', '-f', '{{.Image}}', nameOrId], {
          timeout: 5_000,
        });
        const id = stdout.trim();
        return id || undefined;
      } catch {
        return undefined;
      }
    },

    async connectNetwork(networkName: string, containerId: string): Promise<void> {
      await exec('docker', ['network', 'connect', networkName, containerId], { timeout: 10_000 });
    },

    async getNetworkGateway(name: string): Promise<string | undefined> {
      try {
        const { stdout } = await exec(
          'docker',
          ['network', 'inspect', '-f', '{{(index .IPAM.Config 0).Gateway}}', name],
          {
            timeout: 10_000,
          },
        );
        const value = stdout.trim();
        return value && value !== '<no value>' ? value : undefined;
      } catch {
        return undefined;
      }
    },

    async getContainerIp(containerId: string, network: string): Promise<string> {
      // Docker may not assign the IP immediately after `network connect`.
      // Retry a few times with a short delay.
      const maxAttempts = 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { stdout } = await exec('docker', ['inspect', '-f', '{{json .NetworkSettings.Networks}}', containerId], {
          timeout: 10_000,
        });
        const networks = JSON.parse(stdout.trim()) as Partial<Record<string, { IPAddress?: string }>>;
        const ip = networks[network]?.IPAddress;
        if (ip) return ip;

        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      throw new Error(`No IP address found for container ${containerId} on network ${network}`);
    },

    async containerExists(nameOrId: string): Promise<boolean> {
      try {
        // docker inspect succeeds for both running and stopped containers,
        // fails only when the container does not exist.
        await exec('docker', ['inspect', nameOrId], { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Remove a stale container left behind by a crashed session.
     * Only removes containers labeled with `ironcurtain.bundle` to avoid
     * accidentally removing unrelated containers that share the name.
     * Returns true if a stale container was found and removed.
     */
    async removeStaleContainer(name: string): Promise<boolean> {
      const exists = await this.containerExists(name);
      if (!exists) return false;

      // Verify the container belongs to IronCurtain before removing it.
      // We query by `ironcurtain.bundle`. Containers from before this refactor
      // carry `ironcurtain.session` and will NOT be matched -- upgrade-in-place
      // is not supported; operators wipe `~/.ironcurtain/workflow-runs/` per the
      // migration notes in docs/designs/workflow-container-lifecycle.md §10 and
      // docs/designs/workflow-session-identity.md.
      const label = await this.getContainerLabel(name, IRONCURTAIN_LABEL_BUNDLE);
      if (!label) {
        logger.warn(`Container "${name}" exists but lacks ${IRONCURTAIN_LABEL_BUNDLE} label; skipping removal`);
        return false;
      }

      logger.warn(`Removing stale container "${name}" from a previous session`);
      await this.stop(name);
      await this.remove(name);

      // Verify removal succeeded (remove() swallows errors)
      if (await this.containerExists(name)) {
        throw new Error(`Failed to remove stale container "${name}"`);
      }
      return true;
    },
  };
}
