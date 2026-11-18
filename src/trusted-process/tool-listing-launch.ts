/**
 * Launches of MCP servers outside a session, to list their tools:
 * `ironcurtain doctor`'s liveness probe (`doctor/mcp-liveness.ts`) and the
 * offline pipeline's tool discovery (`pipeline/live-tools.ts`: annotate-tools,
 * compile-policy's drift check, `ironcurtain mcp add`).
 *
 * Each server is prepared exactly as its relay (`mcp-proxy-server.ts`)
 * prepares it for a session, so third-party server code never runs with more
 * than a session would give it:
 *
 *   - the same OS-sandbox decision: `planServerSandboxing` under the
 *     effective sandboxPolicy, with the availability the caller resolved the
 *     way sessions do (`resolveOsSandboxAvailability`: the dependency check
 *     and the srt smoke run). A server the plan refuses ("enforce", sandbox
 *     unavailable) is not started, with the session's refusal message; one
 *     it leaves unconfined ("warn") runs without srt;
 *   - the same srt wrapping for a sandboxed server: settings from
 *     `writeServerSettings` (the ssh-agent socket for the git backend only)
 *     plus the Node.js read paths, `wrapServerCommand` with relative
 *     arguments resolved against the package root (the relay's cwd, never
 *     the directory the command was started from), and for a server confined
 *     to its roots (the filesystem server) the confined launch
 *     (`resolveConfinedLaunch` / `confinedSandboxParams`);
 *   - the same docker -> Apple `container` translation;
 *   - the same environment (`buildBackendEnv`: the child-env allowlist, the
 *     server's `env` block and its stored credentials, the git hardening).
 *
 * Where it differs from a relay, it starts less:
 *
 *   - a server backed by an IronCurtain OAuth provider (google-workspace) is
 *     never started: a session hands it a freshly prepared access token and
 *     its own npm cache, which a launch outside a session does not create;
 *   - srt settings and the sandboxed servers' working directories live in a
 *     fresh directory below the per-user scratch root (outside the
 *     IronCurtain home), removed by `dispose()`; unsandboxed servers run from
 *     IronCurtain's package root, as other one-shot tool listings do
 *     (spawn-cwd.ts). Nothing in the IronCurtain home is written;
 *   - the filesystem server is pointed at the allowed directory the caller
 *     names when it exists, and otherwise at a fresh, empty temporary
 *     directory (also removed by `dispose()`), never one created for it.
 */

import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProviderForServer } from '../auth/oauth-registry.js';
import { applyAllowedDirectoryToMcpArgs } from '../config/index.js';
import type { MCPServerConfig, SandboxAvailabilityPolicy } from '../config/types.js';
import { passthroughEnvNames } from './child-env.js';
import { resolveContainerSpawnCommand } from './container-command.js';
import { isGitBackend } from './git-backend-env.js';
import { buildBackendEnv } from './mcp-proxy-server.js';
import { confinedSandboxParams, resolveConfinedLaunch } from './roots-confinement.js';
import {
  cleanupSettingsFiles,
  discoverNodePaths,
  formatOsSandboxNotice,
  formatSandboxRefusal,
  planServerSandboxing,
  rewriteServerSettings,
  wrapServerCommand,
  writeServerSettings,
  type OsSandboxAvailability,
  type OsSandboxPlan,
} from './sandbox-integration.js';
import { ensurePrivateScratchRoot, getTrustedSpawnCwd } from './spawn-cwd.js';

/** Inputs of {@link createToolListingEnvironment}. */
export interface ToolListingEnvironmentOptions {
  /** Resolved path-only credential containment metadata from the caller's config. */
  readonly credentialPaths?: readonly string[];
  /** The servers that may be launched (each is planned; the plan is per server). */
  readonly servers: Readonly<Record<string, MCPServerConfig>>;
  /**
   * The directory to point the filesystem server at when it is an existing
   * directory. Absent or missing: a fresh, empty temporary directory.
   */
  readonly allowedDirectory?: string;
  /** OS-sandbox availability, resolved as sessions resolve it. */
  readonly availability: OsSandboxAvailability;
  /** The effective sandboxPolicy. */
  readonly policy: SandboxAvailabilityPolicy;
  /** Names the scratch directories (`ironcurtain-<label>-sandbox-*`, `<label>-*`). Default `tool-listing`. */
  readonly label?: string;
}

/** What every launch of one run shares; `dispose()` removes what it created. */
export interface ToolListingEnvironment {
  /** The allowed directory the launches use (the caller's, or a temporary stand-in). */
  readonly allowedDirectory: string;
  /** The servers, with the filesystem server pointed at `allowedDirectory`. */
  readonly servers: Readonly<Record<string, MCPServerConfig>>;
  /** The sandbox plan, or why the configuration cannot be planned (sessions fail closed then). */
  readonly plan: { readonly ok: true; readonly plan: OsSandboxPlan } | { readonly ok: false; readonly error: string };
  /** A private directory for srt settings and working directories, created on first use. */
  settingsDir(): string;
  /** Removes the scratch directories. Safe to call more than once. */
  dispose(): void;
}

/**
 * Plans the launches of one run. Creates a temporary stand-in for the
 * allowed directory only when the caller's does not exist (or none is
 * given); the srt settings directory is created on first use, below the
 * per-user scratch root. Nothing is created in the IronCurtain home.
 */
export function createToolListingEnvironment(options: ToolListingEnvironmentOptions): ToolListingEnvironment {
  const label = options.label ?? 'tool-listing';
  const created: string[] = [];
  let allowedDirectory = options.allowedDirectory;
  if (allowedDirectory === undefined || !isDirectory(allowedDirectory)) {
    allowedDirectory = mkdtempSync(join(tmpdir(), `ironcurtain-${label}-sandbox-`));
    created.push(allowedDirectory);
  }
  const servers: Record<string, MCPServerConfig> = structuredClone(options.servers);
  applyAllowedDirectoryToMcpArgs(servers, allowedDirectory);

  let plan: ToolListingEnvironment['plan'];
  try {
    plan = {
      ok: true,
      plan: planServerSandboxing(
        servers,
        allowedDirectory,
        options.availability,
        options.policy,
        options.credentialPaths,
      ),
    };
  } catch (err) {
    plan = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let settingsDir: string | undefined;
  return {
    allowedDirectory,
    servers,
    plan,
    settingsDir: () => {
      if (settingsDir === undefined) {
        settingsDir = mkdtempSync(join(ensurePrivateScratchRoot(), `${label}-`));
        created.push(settingsDir);
      }
      return settingsDir;
    },
    dispose: () => {
      for (const dir of created.splice(0)) cleanupSettingsFiles(dir);
    },
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The one-line warning naming the servers a tool listing over `plan` starts
 * without the OS sandbox they ask for (sandboxPolicy "warn"), or undefined.
 * A server backed by an IronCurtain OAuth provider is planned like any other
 * but never started ({@link prepareToolListingLaunch}), so it is not named.
 */
export function formatToolListingSandboxWarning(plan: OsSandboxPlan): string | undefined {
  const unconfined = plan.unconfined.filter((name) => getProviderForServer(name) === undefined);
  return unconfined.length > 0 ? formatOsSandboxNotice({ ...plan, refused: [], unconfined }) : undefined;
}

/** A fully prepared server spawn: what the relay would run. */
export interface ToolListingSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  /** srt wraps the command. */
  readonly sandboxed: boolean;
  /** Credential values to blank out of anything the server prints. */
  readonly secrets: readonly string[];
}

/**
 * Why {@link prepareToolListingLaunch} does not start a server:
 *
 * - `oauth`: it is backed by an IronCurtain OAuth provider;
 * - `sandbox-refused`: it asks for an OS sandbox that is unavailable, and
 *   sandboxPolicy is "enforce" (`message` is the session's refusal);
 * - `not-planned`: it is not among the environment's servers.
 */
export type ToolListingSkipReason = 'oauth' | 'sandbox-refused' | 'not-planned';

/** Outcome of {@link prepareToolListingLaunch}. */
export type ToolListingLaunch =
  | { readonly status: 'ready'; readonly spawn: ToolListingSpawn }
  | { readonly status: 'not-started'; readonly reason: ToolListingSkipReason; readonly message: string }
  | { readonly status: 'error'; readonly message: string };

/**
 * Prepares the spawn a relay would run for `name` (see the module comment):
 * the sandbox disposition from the environment's plan, srt settings in its
 * private settings directory, the relay's backend environment with the
 * server's stored `credentials`. A server sessions would not start becomes
 * `not-started`; a configuration sessions refuse, or a spawn that cannot be
 * prepared, becomes `error`. Never throws.
 */
export function prepareToolListingLaunch(
  name: string,
  serverConfig: MCPServerConfig,
  environment: ToolListingEnvironment,
  credentials: Readonly<Record<string, string>>,
): ToolListingLaunch {
  if (!environment.plan.ok) {
    return { status: 'error', message: `sessions refuse this sandbox configuration: ${environment.plan.error}` };
  }
  const provider = getProviderForServer(name);
  if (provider !== undefined) {
    return {
      status: 'not-started',
      reason: 'oauth',
      message:
        `sessions give it a freshly prepared ${provider.displayName} OAuth token and its own npm cache, ` +
        'which a tool listing outside a session does not create',
    };
  }
  const { plan } = environment.plan;
  const resolved = plan.resolved.get(name);
  if (resolved === undefined) {
    return plan.refused.includes(name)
      ? { status: 'not-started', reason: 'sandbox-refused', message: formatSandboxRefusal(name, plan.availability) }
      : { status: 'not-started', reason: 'not-planned', message: 'it is not among the servers this run planned' };
  }

  const spawnSpec = resolveContainerSpawnCommand(serverConfig.command, serverConfig.args);
  // Relay: relative arguments of a sandboxed server resolve against the
  // relay's cwd, IronCurtain's package root. A one-shot launch runs wherever
  // the user started the command (possibly an untrusted checkout), so it
  // names that root.
  const wrapOptions = { argsBaseDir: getTrustedSpawnCwd() };
  // The stored credentials and the host values the server's `-e NAME`
  // arguments forward (a token from the shell).
  const secretsIn = (env: Readonly<Record<string, string>>): string[] => [
    ...Object.values(credentials),
    ...passthroughEnvNames(serverConfig.args).flatMap((envName) => (Object.hasOwn(env, envName) ? [env[envName]] : [])),
  ];

  try {
    if (!resolved.sandboxed) {
      const env = buildBackendEnv(name, serverConfig, {
        sandboxed: false,
        serverCredentials: credentials,
        oauthEnv: {},
        allowedDirectory: environment.allowedDirectory,
        serverCwd: getTrustedSpawnCwd(),
      });
      return {
        status: 'ready',
        spawn: {
          command: spawnSpec.command,
          args: spawnSpec.args,
          env,
          cwd: getTrustedSpawnCwd(),
          sandboxed: false,
          secrets: secretsIn(env),
        },
      };
    }

    const settingsDir = environment.settingsDir();
    // As the relay: the ssh-agent socket for the git backend only.
    const settingsOptions = { sshAgent: isGitBackend(name) };
    const { settingsPath, cwdPath } = writeServerSettings(name, resolved.config, settingsDir, settingsOptions);
    const env = buildBackendEnv(name, serverConfig, {
      sandboxed: true,
      serverCredentials: credentials,
      oauthEnv: {},
      allowedDirectory: environment.allowedDirectory,
      serverCwd: cwdPath,
    });
    const secrets = secretsIn(env);
    const nodePaths = discoverNodePaths();

    if (resolved.config.confineToRoots === true) {
      // As launchConfinedBackend: the program resolved here, every path
      // canonical, a profile written whole for this launch. Listing tools
      // needs no roots beyond the allowed directory the profile already
      // exposes.
      const launch = resolveConfinedLaunch(spawnSpec.command, spawnSpec.args, env);
      const params = confinedSandboxParams(resolved.config, [], [...launch.readPaths, ...nodePaths]);
      writeServerSettings(name, params, settingsDir, settingsOptions);
      const wrapped = wrapServerCommand(
        name,
        launch.command,
        launch.args,
        { sandboxed: true, config: params },
        settingsDir,
        wrapOptions,
      );
      return {
        status: 'ready',
        spawn: {
          ...wrapped,
          env: launch.pathEnv === undefined ? env : { ...env, PATH: launch.pathEnv },
          cwd: cwdPath,
          sandboxed: true,
          secrets,
        },
      };
    }

    if (nodePaths.length > 0) rewriteServerSettings(settingsPath, { allowRead: nodePaths });
    const wrapped = wrapServerCommand(name, spawnSpec.command, spawnSpec.args, resolved, settingsDir, wrapOptions);
    return { status: 'ready', spawn: { ...wrapped, env, cwd: cwdPath, sandboxed: true, secrets } };
  } catch (err) {
    return {
      status: 'error',
      message: `cannot prepare it the way a session would: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
