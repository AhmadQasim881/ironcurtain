/**
 * MCP server liveness probe used by `ironcurtain doctor`.
 *
 * Starts each configured server the way a session's relay does and asks it
 * for its tools. The launch is shared with the offline pipeline's tool
 * discovery (`trusted-process/tool-listing-launch.ts`): the same sandbox
 * plan, srt wrapping (confined launch for the filesystem server), docker ->
 * Apple `container` translation and backend environment (stored credentials
 * included) as the relay. A sandbox that cannot start a server shows up here
 * instead of only in a session log.
 *
 * Nothing is downloaded and nothing in the IronCurtain home is written. srt
 * settings and the sandboxed servers' working directories live in a fresh
 * directory under the per-user scratch root (outside the home), removed when
 * the run ends; unsandboxed servers run from IronCurtain's package root, as
 * the other one-shot tool listings do (spawn-cwd.ts). When the configured
 * allowed directory does not exist yet (a fresh install), the filesystem
 * server is pointed at a temporary empty directory instead of creating it.
 * A server whose container image is not pulled (or cannot be told from its
 * `run` arguments), or whose npx package is not in the npx cache, is skipped
 * rather than given time to download it (the first session does that). A
 * server backed by an IronCurtain OAuth provider (google-workspace) is not
 * started: a session hands it a freshly prepared access token and its own npm
 * cache, which doctor does not create.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { computeSandboxCredentialPaths } from '../config/credential-stores.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IronCurtainConfig, MCPServerConfig, SandboxAvailabilityPolicy } from '../config/types.js';
import { isImagePresent, type ResourceProbeBin } from '../docker/resource-limits.js';
import { getProviderForServer } from '../auth/oauth-registry.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { resolveContainerSpawnCommand } from '../trusted-process/container-command.js';
import { permissiveJsonSchemaValidator } from '../trusted-process/permissive-output-validator.js';
import type { OsSandboxAvailability } from '../trusted-process/sandbox-integration.js';
import type { LiveToolSchema } from '../trusted-process/schema-drift.js';
import {
  createToolListingEnvironment,
  prepareToolListingLaunch,
  type ToolListingEnvironment,
  type ToolListingSpawn,
} from '../trusted-process/tool-listing-launch.js';
import { VERSION } from '../version.js';

/** Deadline (connect + tools/list) for a server started from local files. */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Deadline for a server started through a container runtime or npx: even
 * with the image or package cached, a container start or npx's resolution
 * takes longer than a local process.
 */
export const COLD_START_PROBE_TIMEOUT_MS = 30_000;

/** Hard cap on close() — best-effort cleanup; the subprocess is reaped on doctor exit anyway. */
const CLOSE_TIMEOUT_MS = 1_000;

/** At most this much of a failed server's stderr is kept for the report. */
const MAX_STDERR_CHARS = 1_000;

export interface ProbeOk {
  readonly status: 'ok';
  readonly toolCount: number;
  readonly elapsedMs: number;
  /**
   * The tools the server listed (name and input schema), for the
   * annotation drift check. Absent only from probe doubles that predate
   * the check; the real probe always sets it.
   */
  readonly tools?: readonly LiveToolSchema[];
  /** The server's `initialize` identity, when it reported one. */
  readonly serverInfo?: { readonly name: string; readonly version: string };
  /** The server ran inside srt. */
  readonly sandboxed?: boolean;
}

export interface ProbeFail {
  readonly status: 'fail';
  readonly elapsedMs: number;
  readonly reason: string;
}

/** The server was deliberately not started; `message` says why. */
export interface ProbeSkipped {
  readonly status: 'skip';
  readonly message: string;
}

export type ProbeResult = ProbeOk | ProbeFail | ProbeSkipped;

/** A fully prepared server spawn: what the relay would run, and the deadline. */
export interface ProbeSpawn extends ToolListingSpawn {
  readonly timeoutMs: number;
}

/** Per-server inputs to a probe (see {@link ServerProbe}). */
export interface ProbeContext {
  /** The server's stored credentials from config.json. */
  readonly credentials: Readonly<Record<string, string>>;
  /** Lazily created shared environment of this doctor run (sandbox plan, scratch directories). */
  readonly environment: () => ProbeEnvironment;
}

/**
 * Probes one server. The default ({@link probeConfiguredServer}) prepares
 * the spawn as a relay would and runs {@link probeServer}; tests pass doubles.
 */
export type ServerProbe = (name: string, serverConfig: MCPServerConfig, context: ProbeContext) => Promise<ProbeResult>;

/**
 * Wraps a promise in a deadline. Resolves to the original value, or rejects
 * with a timeout error if the deadline elapses first. Does not cancel the
 * underlying promise — the caller is responsible for cleanup.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolveOk, rejectErr) => {
    const timer = setTimeout(() => {
      rejectErr(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveOk(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        rejectErr(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** `text` with every credential value of at least 6 characters replaced. */
function redactSecrets(text: string, secrets: readonly string[] | undefined): string {
  let redacted = text;
  for (const secret of secrets ?? []) {
    if (secret.length >= 6) redacted = redacted.split(secret).join('***');
  }
  return redacted;
}

/**
 * Probes a single MCP server: connect, list tools, close.
 *
 * Catches all errors and converts them to a ProbeFail result so callers
 * can run multiple probes in parallel without a single failure aborting
 * the whole batch (Promise.all would otherwise reject on the first error).
 * The failure reason carries the start of the server's stderr (srt reports
 * a sandbox it cannot create there), with credential values blanked.
 */
export async function probeServer(name: string, spawn: ProbeSpawn): Promise<ProbeOk | ProbeFail> {
  const start = Date.now();
  let client: Client | undefined;
  const startup = { stderr: '' };
  try {
    const transport = new StdioClientTransport({
      command: spawn.command,
      args: [...spawn.args],
      env: spawn.env,
      stderr: 'pipe',
      cwd: spawn.cwd,
    });
    if (transport.stderr) {
      // Drained so a chatty server cannot block on a full pipe; the start is kept for the report.
      transport.stderr.on('data', (chunk: Buffer) => {
        if (startup.stderr.length < MAX_STDERR_CHARS) startup.stderr += chunk.toString();
      });
    }

    const c = new Client(
      { name: `ironcurtain-doctor:${name}`, version: VERSION },
      { jsonSchemaValidator: permissiveJsonSchemaValidator },
    );
    client = c;

    const toolsResult = await withDeadline(
      (async () => {
        await c.connect(transport);
        return c.listTools();
      })(),
      spawn.timeoutMs,
      `probe(${name})`,
    );

    const serverInfo = c.getServerVersion();
    return {
      status: 'ok',
      toolCount: toolsResult.tools.length,
      elapsedMs: Date.now() - start,
      tools: toolsResult.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })),
      sandboxed: spawn.sandboxed,
      ...(serverInfo ? { serverInfo: { name: serverInfo.name, version: serverInfo.version } } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = redactSecrets(startup.stderr, spawn.secrets).replace(/\s+/g, ' ').trim();
    const where = spawn.sandboxed ? ' (inside the OS sandbox)' : '';
    return {
      status: 'fail',
      elapsedMs: Date.now() - start,
      reason: `${message}${where}${stderr ? `. Server stderr: ${stderr.slice(0, MAX_STDERR_CHARS)}` : ''}`,
    };
  } finally {
    if (client) {
      // close() can hang when the server is wedged; cap it so a stuck server
      // can't block the rest of the doctor run.
      await withDeadline(client.close(), CLOSE_TIMEOUT_MS, `close(${name})`).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// The shared probe environment
// ---------------------------------------------------------------------------

/** Inputs of {@link createProbeEnvironment}. */
export interface ProbeEnvironmentOptions {
  readonly config: IronCurtainConfig;
  readonly availability: OsSandboxAvailability;
  readonly policy: SandboxAvailabilityPolicy;
  /** Image presence check (default: `<bin> image inspect`, never a pull). */
  readonly isImageCached?: (image: string, bin: ResourceProbeBin) => Promise<boolean>;
  /** npx cache lookup (default: {@link isNpxPackageCached}). */
  readonly isNpxPackageCached?: (spec: NpxPackageSpec) => boolean;
}

/**
 * What every probe of one doctor run shares (the launch environment of
 * `tool-listing-launch.ts`, plus the download gates); dispose() removes what
 * it created.
 */
export interface ProbeEnvironment extends ToolListingEnvironment {
  readonly isImageCached: (image: string, bin: ResourceProbeBin) => Promise<boolean>;
  readonly isNpxPackageCached: (spec: NpxPackageSpec) => boolean;
}

/**
 * Plans the probes of one doctor run. Uses the configured allowed directory
 * when it exists and creates a temporary stand-in otherwise; the srt
 * settings directory is created on first use, below the per-user scratch
 * root. Nothing is created in the IronCurtain home.
 */
export function createProbeEnvironment(options: ProbeEnvironmentOptions): ProbeEnvironment {
  return {
    ...createToolListingEnvironment({
      servers: options.config.mcpServers,
      credentialPaths: computeSandboxCredentialPaths(options.config.userConfig.credentialProtection),
      allowedDirectory: options.config.allowedDirectory,
      availability: options.availability,
      policy: options.policy,
      label: 'doctor',
    }),
    isImageCached: options.isImageCached ?? ((image, bin) => isImagePresent(image, undefined, bin)),
    isNpxPackageCached: options.isNpxPackageCached ?? ((spec) => isNpxPackageCached(spec)),
  };
}

/**
 * The default {@link ServerProbe}: decides whether the server can be started
 * without downloading anything, prepares the spawn exactly as a relay would
 * ({@link prepareProbeSpawn}) and probes it.
 */
export async function probeConfiguredServer(
  name: string,
  configured: MCPServerConfig,
  context: ProbeContext,
): Promise<ProbeResult> {
  let environment: ProbeEnvironment;
  try {
    environment = context.environment();
  } catch (err) {
    // A per-server failure, not a crash of the whole doctor run.
    return {
      status: 'fail',
      elapsedMs: 0,
      reason: `cannot prepare the probes: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // The environment's copy carries the probe's allowed directory. A server
  // outside the planned set has no sandbox disposition and is skipped below.
  const serverConfig = Object.hasOwn(environment.servers, name) ? environment.servers[name] : configured;
  const gate = await checkProbeGates(name, serverConfig, environment);
  if (gate !== undefined) return gate;
  const prepared = prepareProbeSpawn(name, serverConfig, environment, context.credentials);
  if ('status' in prepared) return prepared;
  return probeServer(name, prepared);
}

/** Reasons a server is not started at all (nothing to download, no OAuth token to prepare). */
async function checkProbeGates(
  name: string,
  serverConfig: MCPServerConfig,
  environment: ProbeEnvironment,
): Promise<ProbeSkipped | undefined> {
  const provider = getProviderForServer(name);
  if (provider !== undefined) {
    return {
      status: 'skip',
      message:
        `not started: sessions give it a freshly prepared ${provider.displayName} OAuth token and its own ` +
        'npm cache, which doctor does not create (its authorization is under Credentials)',
    };
  }
  const spawnSpec = resolveContainerSpawnCommand(serverConfig.command, serverConfig.args);
  if ((spawnSpec.command === 'docker' || spawnSpec.command === 'container') && spawnSpec.args[0] === 'run') {
    const image = findContainerRunImage(spawnSpec.args);
    if (image === undefined) {
      // `run` pulls a missing image, so a run whose image cannot be told is
      // not started rather than allowed to download one.
      return {
        status: 'skip',
        message: `skipped — cannot tell which image \`${spawnSpec.command} run\` starts, so it may not be pulled yet (doctor never pulls images)`,
      };
    }
    if (!(await environment.isImageCached(image, spawnSpec.command))) {
      return {
        status: 'skip',
        message: `skipped — image ${toDisplayText(image, { maxLength: 120 })} is not pulled yet (the first session pulls it; doctor never pulls images)`,
      };
    }
    return undefined;
  }
  if (spawnSpec.command === 'npx') {
    const spec = parseNpxPackageSpec(spawnSpec.args);
    if (spec === undefined || spec.version === undefined) {
      return {
        status: 'skip',
        message:
          'skipped — npx resolves this unpinned package from the registry at every start (doctor never downloads packages)',
      };
    }
    if (!environment.isNpxPackageCached(spec)) {
      return {
        status: 'skip',
        message: `skipped — ${toDisplayText(`${spec.name}@${spec.version}`, { maxLength: 120 })} is not in the npx cache (the first session downloads it; doctor never downloads packages)`,
      };
    }
  }
  return undefined;
}

/**
 * Builds the spawn a relay would run for `name` (`prepareToolListingLaunch`:
 * sandbox disposition from the plan, srt settings in the run's private
 * settings directory, the relay's backend environment) with the probe's
 * deadline. A server sessions will not start becomes a skip; a
 * configuration that cannot be planned, or a spawn that cannot be prepared,
 * a failure.
 */
export function prepareProbeSpawn(
  name: string,
  serverConfig: MCPServerConfig,
  environment: ProbeEnvironment,
  credentials: Readonly<Record<string, string>>,
): ProbeSpawn | ProbeSkipped | ProbeFail {
  const launch = prepareToolListingLaunch(name, serverConfig, environment, credentials);
  if (launch.status === 'error') return { status: 'fail', elapsedMs: 0, reason: launch.message };
  if (launch.status === 'not-started') {
    return {
      status: 'skip',
      message:
        launch.reason === 'oauth'
          ? `not started: ${launch.message}`
          : 'skipped — sessions will not start it (OS sandbox unavailable)',
    };
  }
  const spawnCommand = resolveContainerSpawnCommand(serverConfig.command, serverConfig.args).command;
  const timeoutMs =
    spawnCommand === 'docker' || spawnCommand === 'container' || spawnCommand === 'npx'
      ? COLD_START_PROBE_TIMEOUT_MS
      : PROBE_TIMEOUT_MS;
  return { ...launch.spawn, timeoutMs };
}

// ---------------------------------------------------------------------------
// Cache gates
// ---------------------------------------------------------------------------

/** `docker run` / `container run` options that take a separate value. */
const RUN_VALUE_OPTIONS = new Set([
  '-a',
  '-c',
  '-e',
  '-h',
  '-l',
  '-m',
  '-p',
  '-u',
  '-v',
  '-w',
  '--add-host',
  '--attach',
  '--cap-add',
  '--cap-drop',
  '--cgroupns',
  '--cidfile',
  '--cpu-shares',
  '--cpus',
  '--cpuset-cpus',
  '--device',
  '--dns',
  '--entrypoint',
  '--env',
  '--env-file',
  '--expose',
  '--group-add',
  '--hostname',
  '--ipc',
  '--label',
  '--log-driver',
  '--log-opt',
  '--memory',
  '--mount',
  '--name',
  '--network',
  '--pid',
  '--platform',
  '--publish',
  '--pull',
  '--restart',
  '--runtime',
  '--security-opt',
  '--shm-size',
  '--stop-signal',
  '--stop-timeout',
  '--tmpfs',
  '--ulimit',
  '--user',
  '--userns',
  '--uts',
  '--volume',
  '--volumes-from',
  '--workdir',
]);

/** The letters of the single-dash `run` options in {@link RUN_VALUE_OPTIONS}. */
const SHORT_VALUE_OPTION_LETTERS = /[acehlmpuvw]/;

/**
 * The image of a `docker run ...` / `container run ...` argument list: the
 * first argument after `run` that is neither an option nor an option's
 * value. Undefined when it cannot be told (an option this parser does not
 * know might take the next argument); the caller then skips the server
 * rather than guess, since `run` pulls a missing image.
 */
export function findContainerRunImage(args: readonly string[]): string | undefined {
  if (args[0] !== 'run') return undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return args.at(i + 1);
    if (!arg.startsWith('-')) return arg;
    if (arg.includes('=')) continue;
    if (RUN_VALUE_OPTIONS.has(arg)) {
      i++;
      continue;
    }
    // A single-dash cluster (-i, -it, -ie VAR): boolean letters, then at
    // most one value option, whose value is the next argument when the
    // option ends the cluster and the rest of the cluster otherwise.
    if (/^-[a-zA-Z]+$/.test(arg)) {
      const valueAt = arg.slice(1).search(SHORT_VALUE_OPTION_LETTERS);
      if (valueAt === arg.length - 2) i++;
      continue;
    }
    if (
      ['--rm', '--init', '--interactive', '--tty', '--detach', '--privileged', '--read-only', '--publish-all'].includes(
        arg,
      )
    ) {
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** A package an `npx` command runs. `version` is set only for an exact `x.y.z` pin. */
export interface NpxPackageSpec {
  readonly name: string;
  readonly version?: string;
}

/**
 * The package `npx [-y] <spec> ...` runs, or undefined when the arguments
 * name none (e.g. `npx -p <pkg> <bin>`, which this parser does not follow).
 */
export function parseNpxPackageSpec(args: readonly string[]): NpxPackageSpec | undefined {
  for (const arg of args) {
    if (arg === '-y' || arg === '--yes' || arg === '--no-install' || arg === '--quiet' || arg === '-q') continue;
    if (arg.startsWith('-')) return undefined;
    const versionAt = arg.indexOf('@', arg.startsWith('@') ? 1 : 0);
    const name = versionAt === -1 ? arg : arg.slice(0, versionAt);
    const version = versionAt === -1 ? undefined : arg.slice(versionAt + 1);
    if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) return undefined;
    return { name, ...(version !== undefined && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) ? { version } : {}) };
  }
  return undefined;
}

/**
 * True when npm's npx cache (`<npm cache>/../_npx/<hash>/node_modules`, by
 * default `~/.npm/_npx`) holds `spec` at exactly its pinned version. The
 * cache location follows `npm_config_cache` when it is set; a cache moved
 * through `.npmrc` alone is not found, which makes the probe skip, never fail.
 */
export function isNpxPackageCached(
  spec: NpxPackageSpec,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (spec.version === undefined) return false;
  const cache = env.npm_config_cache || env.NPM_CONFIG_CACHE || join(homedir(), '.npm');
  const npxRoot = join(cache, '_npx');
  if (!existsSync(npxRoot)) return false;
  let entries: string[];
  try {
    entries = readdirSync(npxRoot);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    try {
      const manifest = JSON.parse(
        readFileSync(join(npxRoot, entry, 'node_modules', spec.name, 'package.json'), 'utf-8'),
      ) as { version?: unknown };
      return manifest.version === spec.version;
    } catch {
      return false;
    }
  });
}
