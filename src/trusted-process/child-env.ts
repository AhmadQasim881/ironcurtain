/**
 * Allowlisted environments for the processes IronCurtain spawns.
 *
 * The host process holds the user's whole environment: provider API keys
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...), cloud credentials, other MCP
 * servers' tokens and whatever else the shell exported. Every MCP relay used
 * to be spawned with `{ ...process.env, ... }` and spawned its backend the
 * same way, so every backend MCP server -- third-party npm packages fetched
 * with npx, the git server that runs host git against an agent-writable
 * repository, the Docker CLI -- received all of it, along with the
 * relay-internal variables (every server's configuration in
 * MCP_SERVERS_CONFIG, the session log path, the MITM control address). A
 * compromised or supply-chain-poisoned server could read keys it had no
 * business seeing.
 *
 * Children now inherit an allowlist ({@link inheritedEnv}), never the host
 * environment:
 *
 * - the MCP SDK's default set (HOME, LOGNAME, PATH, SHELL, TERM, USER; the
 *   Windows equivalents), {@link DEFAULT_INHERITED_ENV_VARS};
 * - locale, time zone and the temporary directory (LANG, LANGUAGE, LC_*, TZ,
 *   TMPDIR, TMP, TEMP) and the XDG base directories (the relay derives the
 *   confinement regions and credential-store paths from them);
 * - outbound proxy and trust-anchor settings (HTTP(S)_PROXY, NO_PROXY,
 *   ALL_PROXY, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, SSL_CERT_DIR,
 *   REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE);
 * - npm's configuration variables (`npm_config_*`) for npx-launched servers,
 *   minus anything that names a registry credential, a secret or a TLS key,
 *   or injects node options;
 * - Docker CLI connection settings (DOCKER_HOST, DOCKER_CONFIG, DOCKER_CONTEXT,
 *   DOCKER_CERT_PATH, DOCKER_TLS_VERIFY) for container-based servers;
 * - which git configuration files are the user's (GIT_CONFIG_GLOBAL,
 *   GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM): the policy engine resolves where
 *   a git remote really connects from those files, so the git a backend runs
 *   must read the same ones (no other GIT_* variable is inherited);
 * - Node.js version-manager roots (NVM_DIR, VOLTA_HOME, ASDF_DIR, ASDF_DATA_DIR,
 *   FNM_DIR, FNM_MULTISHELL_PATH), which their `node` shims read and the relay
 *   re-exposes to sandboxed servers (`discoverNodePaths`);
 * - IRONCURTAIN_HOME and IRONCURTAIN_CONTAINER_RUNTIME, from which children
 *   resolve paths and the container runtime, and TSX_* (tsx's loader
 *   settings, source mode only);
 * - on request, the ssh-agent socket (SSH_AUTH_SOCK): only the git backend
 *   authenticates with ssh;
 * - on request, the variables a server's docker-style `-e NAME` arguments
 *   forward from the host (GITHUB_PERSONAL_ACCESS_TOKEN for the shipped github
 *   server): a token exported in the shell keeps reaching the one server that
 *   declares it, and no other.
 *
 * NODE_OPTIONS, NODE_PATH, LD_* and DYLD_* are never inherited, not even when
 * a `-e` argument names them: they run code in every Node.js child or load
 * libraries into every process. A `-e` argument cannot forward the relay's
 * own configuration ({@link RELAY_INTERNAL_ENV_NAMES}) either. Exported shell
 * functions (values starting with `()`) are dropped, as the SDK drops them.
 *
 * A server's own `env` block, its stored credentials (`serverCredentials` in
 * config.json, carried to its relay in SERVER_CREDENTIALS) and the OAuth
 * variables the relay prepares are layered on top by the callers
 * ({@link mcpServerSpawnEnv}, `buildBackendEnv` in mcp-proxy-server.ts): they
 * are trusted configuration, not inherited state.
 *
 * A relay additionally gets, in the explicit block its parent builds for it,
 * the host settings it reads for itself and never hands on
 * ({@link relayHostSettings}): where the credential stores it must hide from
 * sandboxed servers live when the user has moved them.
 *
 * IronCurtain's own interactive children (`ironcurtain start --pty` under the
 * mux and the web UI) run at the parent's trust level and need the user's
 * credentials and configuration; they get the host environment minus the
 * code-injection and relay-internal variables ({@link ironcurtainSubprocessEnv}).
 *
 * Leaf module: config types only (no runtime imports), so every spawn site
 * can use it, including under test doubles of the MCP SDK.
 */

import type { MCPServerConfig } from '../config/types.js';

/** An environment as `process.env` presents it. */
export type HostEnv = Readonly<Record<string, string | undefined>>;

/**
 * The MCP SDK's own default for a stdio child (`getDefaultEnvironment()` in
 * `@modelcontextprotocol/sdk/client/stdio.js`, 1.30.x): what a child needs
 * to find programs and its home. Copied rather than imported so this module
 * has no runtime dependency; test/child-env.test.ts checks it still matches
 * the SDK's `DEFAULT_INHERITED_ENV_VARS`.
 */
export const DEFAULT_INHERITED_ENV_VARS: readonly string[] =
  process.platform === 'win32'
    ? [
        'APPDATA',
        'HOMEDRIVE',
        'HOMEPATH',
        'LOCALAPPDATA',
        'PATH',
        'PROCESSOR_ARCHITECTURE',
        'SYSTEMDRIVE',
        'SYSTEMROOT',
        'TEMP',
        'USERNAME',
        'USERPROFILE',
        'PROGRAMFILES',
      ]
    : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

/** Exact names every child may inherit, beyond {@link DEFAULT_INHERITED_ENV_VARS}. */
const INHERITED_NAMES: readonly string[] = [
  // Locale, time zone and temporary directory.
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  // Outbound proxies and trust anchors (corporate CAs).
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // Docker CLI connection settings (container-based servers such as github).
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  // Which git configuration files are the user's (paths and a flag, no
  // secrets). The policy engine resolves where a git remote really connects
  // from these files (git-remote-resolution.ts), and the git backend's
  // hardened environment replays the trusted credential helpers and ssh
  // command it finds there (git-hardening.ts), so the git a child runs must
  // read the same files. They come only from the user's shell:
  // config/trusted-env.ts never loads a GIT_* name from a file.
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  // Node.js version managers: their shims read these, and the relay re-exposes
  // the installations they name to sandboxed servers.
  'NVM_DIR',
  'VOLTA_HOME',
  'ASDF_DIR',
  'ASDF_DATA_DIR',
  'FNM_DIR',
  'FNM_MULTISHELL_PATH',
  // IronCurtain settings children resolve paths and the container runtime from.
  'IRONCURTAIN_HOME',
  'IRONCURTAIN_CONTAINER_RUNTIME',
];

/** Name prefixes every child may inherit (case-sensitive). */
const INHERITED_PREFIXES: readonly string[] = ['LC_', 'XDG_', 'TSX_'];

/** npm reads its configuration from `npm_config_*` in any letter case. */
const NPM_CONFIG_PREFIX = 'npm_config_';

/**
 * npm configuration that must not be inherited: registry credentials
 * (`_auth`, `_authToken`, `_password`, one-time passwords, the
 * `//registry/:_authToken` scoped form, the client TLS `key`, anything
 * named a secret) and `node-options`, which injects NODE_OPTIONS into
 * everything npx runs. Matched against the part after `npm_config_`.
 */
const NPM_CONFIG_EXCLUDED = /auth|token|password|passwd|secret|otp|\/\/|node[-_]options|(?:^|[-_])key(?:$|[-_])/i;

/** The ssh-agent socket: forwarded only on request (the git backend). */
const SSH_AGENT_SOCKET = 'SSH_AUTH_SOCK';

/**
 * Variables no child ever inherits, whatever the allowlist or a `-e`
 * argument says: they run code in every Node.js child or load libraries
 * into every process.
 */
const NEVER_INHERITED_NAMES: ReadonlySet<string> = new Set(['NODE_OPTIONS', 'NODE_PATH']);
const NEVER_INHERITED_PREFIXES: readonly string[] = ['LD_', 'DYLD_'];

/**
 * Shell start-up files: bash sources `$BASH_ENV` (and POSIX `sh` `$ENV`) for
 * every non-interactive shell, such as the one srt runs commands with.
 */
const SHELL_STARTUP_NAMES: ReadonlySet<string> = new Set(['BASH_ENV', 'ENV']);

/**
 * The relay's own configuration and private coordinator-to-runtime channels
 * (see mcp-proxy-server.ts and `buildProxySubprocessEnv` in sandbox/index.ts).
 * They belong to an explicit trusted invocation and are never user-facing, so no other
 * child may inherit them; `src/config/trusted-env.ts` refuses to load them
 * from credential files for the same reason.
 */
export const RELAY_INTERNAL_ENV_NAMES: readonly string[] = [
  'MCP_SERVERS_CONFIG',
  'SERVER_CREDENTIALS',
  'SERVER_FILTER',
  'GENERATED_DIR',
  'TOOL_ANNOTATIONS_DIR',
  'PROTECTED_PATHS',
  'SANDBOX_CREDENTIAL_PATHS',
  'SESSION_LOG_PATH',
  'CONTAINER_WORKSPACE_DIR',
  'MITM_CONTROL_ADDR',
  // The MITM control API's per-bundle bearer token: whoever holds it can
  // add and remove passthrough hosts.
  'MITM_CONTROL_TOKEN',
  'PROXY_SOCKET_PATH',
  'PROXY_TCP_PORT',
  'IRONCURTAIN_MCP_TCP_TOKEN',
  'IRONCURTAIN_HTTP_PROXY_AUTHORIZATION',
  'IRONCURTAIN_APT_PROXY_CONFIG',
  'PROXY_PORT_FILE',
  // The relay's bound for one backend tool call (call-timeouts.ts). Only a
  // session parent sets it, from the session config; a list relay runs with
  // the default, and a malformed stray value would stop the relay.
  'BACKEND_CALL_TIMEOUT_MS',
  // The OS-sandbox availability the parent planned with, its srt smoke run
  // included (OS_SANDBOX_AVAILABILITY_ENV in sandbox-integration.ts). A
  // stray value could make a relay run a server unconfined under "warn".
  'OS_SANDBOX_AVAILABILITY',
];

const RELAY_INTERNAL: ReadonlySet<string> = new Set(RELAY_INTERNAL_ENV_NAMES);

/**
 * Host settings a relay reads for itself and never hands on: where the
 * credential stores IronCurtain protects live when the user has moved them
 * (`ANTHROPIC_CONFIG_DIR`, `CODEX_HOME`; see src/config/credential-stores.ts,
 * whose third override, XDG_CONFIG_HOME, every child inherits anyway). The
 * relay puts those stores in every sandboxed server's srt `denyRead`
 * baseline (`credentialStorePaths` in sandbox-integration.ts) and refuses
 * MCP roots inside them, so it must locate them exactly where its parent
 * does: without these it would hide the default locations while the real
 * stores stayed readable. No backend needs to know where they are, so
 * {@link inheritedEnv} does not pass them on.
 */
export const RELAY_HOST_SETTING_NAMES: readonly string[] = ['ANTHROPIC_CONFIG_DIR', 'CODEX_HOME'];

/** True for a variable no child may inherit under any option. */
export function isNeverInheritedEnvName(name: string): boolean {
  return NEVER_INHERITED_NAMES.has(name) || NEVER_INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * True for a name a `-e NAME` argument may not forward: the code-injection
 * variables ({@link isNeverInheritedEnvName}) and the relay's own
 * configuration ({@link RELAY_INTERNAL_ENV_NAMES}), which configures one
 * relay and must neither be overridden by a host value nor handed on to a
 * backend.
 */
function isRefusedPassthroughName(name: string): boolean {
  return isNeverInheritedEnvName(name) || RELAY_INTERNAL.has(name);
}

/** True for a value the SDK also refuses: an exported shell function. */
function isUsableValue(value: string | undefined): value is string {
  return value !== undefined && !value.startsWith('()');
}

function isInheritedPrefixName(name: string): boolean {
  if (INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  const lower = name.toLowerCase();
  return lower.startsWith(NPM_CONFIG_PREFIX) && !NPM_CONFIG_EXCLUDED.test(lower.slice(NPM_CONFIG_PREFIX.length));
}

export interface InheritedEnvOptions {
  /**
   * Variables the child's docker-style `-e NAME` arguments forward from the
   * host ({@link passthroughEnvNames}); each is inherited when present,
   * except the code-injection variables and the relay's own configuration.
   */
  readonly passthroughNames?: readonly string[];
  /** Forward the ssh-agent socket (SSH_AUTH_SOCK). Only the git backend uses ssh. */
  readonly sshAgent?: boolean;
}

/**
 * The variables a child may inherit from `hostEnv` (see the module comment).
 * Exact names are looked up by name, so a Windows environment that spells
 * `PATH` as `Path` still yields the SDK's default set.
 */
export function inheritedEnv(
  hostEnv: HostEnv = process.env,
  options: InheritedEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  const take = (name: string): void => {
    if (isNeverInheritedEnvName(name)) return;
    const value = hostEnv[name];
    if (isUsableValue(value)) env[name] = value;
  };

  for (const name of DEFAULT_INHERITED_ENV_VARS) take(name);
  for (const name of INHERITED_NAMES) take(name);
  for (const name of Object.keys(hostEnv)) {
    if (isInheritedPrefixName(name)) take(name);
  }
  if (options.sshAgent === true) take(SSH_AGENT_SOCKET);
  for (const name of options.passthroughNames ?? []) {
    if (!isRefusedPassthroughName(name)) take(name);
  }
  return env;
}

/**
 * The {@link RELAY_HOST_SETTING_NAMES} that `hostEnv` sets (non-empty), for
 * the explicit environment block of a relay: `buildProxySubprocessEnv` in
 * sandbox/index.ts (session relays) and `buildRelayEnv` in
 * pipeline/proxy-mcp-connections.ts (list resolution).
 */
export function relayHostSettings(hostEnv: HostEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of RELAY_HOST_SETTING_NAMES) {
    const value = hostEnv[name];
    if (isUsableValue(value) && value !== '') env[name] = value;
  }
  return env;
}

/**
 * The `-e NAME` (no `=`) arguments of a docker-style command line: variables
 * the host forwards into the container. `-e NAME=value` carries its own value
 * and is not a passthrough. The same convention is read by
 * `src/config/trusted-env.ts` and the doctor's credential check.
 */
export function passthroughEnvNames(args: readonly string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '-e') continue;
    const candidate = args[i + 1];
    if (!candidate.includes('=') && !names.includes(candidate)) names.push(candidate);
    i++;
  }
  return names;
}

/**
 * The values `hostEnv` holds for a server's `-e NAME` passthroughs (the
 * names that are set, minus the code-injection variables and the relay's
 * own configuration), for a parent that hands them to the server's relay by
 * name.
 */
export function pickPassthroughEnv(hostEnv: HostEnv, args: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of passthroughEnvNames(args)) {
    if (isRefusedPassthroughName(name)) continue;
    const value = hostEnv[name];
    if (isUsableValue(value)) env[name] = value;
  }
  return env;
}

/** True when a variable has a usable value: a non-empty string. */
export function hasEnvValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Where a server's `-e NAME` variables may come from, in the order they are layered. */
export interface EnvPresenceSources {
  /** The environment the server inherits from (the spawning process's). */
  readonly env: HostEnv;
  /** The server's own `env` block. */
  readonly configEnv?: Readonly<Record<string, string>>;
  /** Its stored credentials (`serverCredentials[<server>]`, or the relay's SERVER_CREDENTIALS). */
  readonly credentials?: Readonly<Record<string, string>>;
}

/**
 * The one presence rule for a variable a server declares: it has a
 * non-empty value in the spawning process's environment, the server's own
 * `env` block or its stored credentials. Shared by the relay's and the
 * in-process TrustedProcess's skip check ({@link missingPassthroughEnvVars})
 * and by `ironcurtain doctor` (checkServerCredentials), so what doctor
 * reports as set is what a session starts with.
 */
export function isEnvVarProvided(name: string, sources: EnvPresenceSources): boolean {
  return (
    hasEnvValue(sources.env[name]) || hasEnvValue(sources.configEnv?.[name]) || hasEnvValue(sources.credentials?.[name])
  );
}

/**
 * The `-e NAME` passthroughs of `args` that have a value in none of the
 * sources ({@link isEnvVarProvided}): the server would start without them
 * and fail, so callers skip it. A credential that exists only in
 * config.json counts as present.
 */
export function missingPassthroughEnvVars(args: readonly string[], sources: EnvPresenceSources): string[] {
  return passthroughEnvNames(args).filter((name) => !isEnvVarProvided(name, sources));
}

export interface McpServerSpawnEnvOptions {
  /** The server's stored credentials; they win over its `env` block. */
  readonly credentials?: Readonly<Record<string, string>>;
  /** Forward the ssh-agent socket (the git backend). */
  readonly sshAgent?: boolean;
}

/**
 * The environment for an MCP server spawned directly by a trusted process
 * (the doctor's liveness probe, `annotate-tools`, the in-process
 * `TrustedProcess`): the allowlist with the server's `-e` passthroughs, then
 * its `env` block, then its credentials. The relay builds its backends'
 * environments the same way, with its own additions (`buildBackendEnv`).
 */
export function mcpServerSpawnEnv(
  config: MCPServerConfig,
  hostEnv: HostEnv = process.env,
  options: McpServerSpawnEnvOptions = {},
): Record<string, string> {
  return {
    ...inheritedEnv(hostEnv, { passthroughNames: passthroughEnvNames(config.args), sshAgent: options.sshAgent }),
    ...(config.env ?? {}),
    ...(options.credentials ?? {}),
  };
}

/**
 * The environment for one of IronCurtain's own interactive children
 * (`ironcurtain start --pty` spawned by the mux or the web UI). It runs at
 * the parent's trust level and reads the same credentials and settings from
 * the environment, so it inherits everything except what must never cross a
 * process boundary: the code-injection variables (NODE_OPTIONS, NODE_PATH,
 * LD_*, DYLD_*, shell start-up files, exported functions) and the variables
 * that configure one specific MCP relay ({@link RELAY_INTERNAL_ENV_NAMES}).
 */
export function ironcurtainSubprocessEnv(hostEnv: HostEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    if (!isUsableValue(value)) continue;
    if (isNeverInheritedEnvName(name) || SHELL_STARTUP_NAMES.has(name) || RELAY_INTERNAL.has(name)) continue;
    env[name] = value;
  }
  return env;
}
