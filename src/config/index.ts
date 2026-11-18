import { existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IronCurtainConfig, MCPServerConfig } from './types.js';
import type {
  CompiledPolicyFile,
  DynamicListsFile,
  ResolvedList,
  StoredToolAnnotationsFile,
} from '../pipeline/types.js';
import { DYNAMIC_LISTS_FILENAME, UNRESOLVED_LIST_HASH } from './dynamic-lists-file.js';
import {
  computeConstitutionHash,
  getIronCurtainHome,
  getUserConfigPath,
  getUserConstitutionBasePath,
  getUserConstitutionPath,
  getUserGeneratedDir,
  getUserMcpServersPath,
} from './paths.js';
import { expandTilde, resolveRealPath } from '../types/argument-roles.js';
import { loadUserConfig, type ResolvedWebSearchConfig } from './user-config.js';
import { FETCH_ALLOW_PRIVATE_NETWORKS_ENV } from '../servers/fetch-env.js';
import { loadMcpServers, warnOnMcpServerAdjustments, type LoadedMcpServers } from './mcp-servers-overlay.js';
import {
  loadToolAnnotations,
  TOOL_ANNOTATIONS_FILENAME,
  type ToolAnnotationsOverlayReport,
} from './tool-annotations-overlay.js';
import { computeCredentialStoreProtectedPaths, type CredentialProtectionSettings } from './credential-stores.js';
import { getTrustedEnvFilePaths } from './trusted-env.js';
import { parseArtifactJson, parseCompiledPolicyFile, parseDynamicListsFile } from '../types/policy-schema.js';
import { checkPolicyProvenance, type PolicyProvenanceCheckOptions } from './policy-provenance-check.js';
import { policyArtifactEntryExists, readPolicyArtifact } from './policy-artifact-read.js';
import * as logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isCompiled = __filename.endsWith('.js');

/**
 * Returns the user-local generated dir if it contains the given artifact,
 * otherwise falls back to the package-bundled dir. Used independently for
 * `compiled-policy.json` and `tool-annotations.json` so a user annotations
 * overlay in `~/.ironcurtain/generated/` is picked up even without a
 * corresponding compiled policy there (tool annotations are globally scoped
 * — see sandbox/index.ts comment on `toolAnnotationsDir`).
 *
 * A compiled policy in the user dir replaces the package's. The user's
 * `tool-annotations.json` does not: `loadGeneratedPolicy` layers it over the
 * package annotations per server (see `tool-annotations-overlay.ts`).
 *
 * Anything at the name counts, a dangling symlink included: the hardened
 * read then refuses it, instead of the session silently using the package's
 * artifact as if the user's were missing.
 */
function resolveArtifactDir(filename: string, packageGeneratedDir: string): string {
  const userDir = getUserGeneratedDir();
  if (policyArtifactEntryExists(resolve(userDir, filename))) {
    return userDir;
  }
  return packageGeneratedDir;
}

/**
 * Returns the package-bundled generated directory.
 * Used as a fallback when user-local generated artifacts are incomplete.
 */
export function getPackageGeneratedDir(): string {
  return resolve(__dirname, 'generated');
}

/**
 * Computes the list of protected paths that the policy engine should
 * prevent agents from reading or modifying. When the active generated dir
 * differs from the package-bundled dir, both are protected. Host credential
 * stores are included (see credential-stores.ts): the core stores always, the
 * extended ones unless `credentialProtection` opts them out. Duplicates are
 * removed, first occurrence kept.
 */
export function computeProtectedPaths(opts: {
  constitutionPath: string;
  generatedDir: string;
  packageGeneratedDir: string;
  mcpServersPath: string;
  auditLogPath: string;
  /** config.json `credentialProtection`; omitted means every default store is protected. */
  credentialProtection?: CredentialProtectionSettings;
}): string[] {
  const paths = [
    // Protect the entire IronCurtain home directory (~/.ironcurtain/).
    // Individual subpaths (config, constitution files, user generated dir) are
    // covered by this directory-level protection. The PolicyEngine exempts the
    // allowedDirectory (session sandbox) only from entries that strictly
    // contain it, such as this one, so agent sandboxes remain writable while an
    // entry inside the sandbox (e.g. an --env-file kept in the workspace, or
    // ~/.claude/.credentials.json under a ~/.claude workspace) stays protected.
    // See src/trusted-process/protected-paths.ts.
    getIronCurtainHome(),
    opts.constitutionPath,
    opts.generatedDir,
    opts.mcpServersPath,
    opts.auditLogPath,
  ];
  if (opts.generatedDir !== opts.packageGeneratedDir) {
    paths.push(opts.packageGeneratedDir);
  }
  // Protect user-local constitution files when they exist
  const userConstitutionBase = getUserConstitutionBasePath();
  if (existsSync(userConstitutionBase)) {
    paths.push(userConstitutionBase);
  }
  const userConstitutionExt = getUserConstitutionPath();
  if (existsSync(userConstitutionExt)) {
    paths.push(userConstitutionExt);
  }
  // Protect the credential files IronCurtain loads ($IRONCURTAIN_HOME/.env and
  // an explicit IRONCURTAIN_ENV_FILE) even when absent: an agent must neither
  // read them nor create one that a later run would load. A .env in the
  // working directory is never loaded (trusted-env.ts), so it is not listed.
  for (const envFile of getTrustedEnvFilePaths()) {
    paths.push(envFile);
  }
  // Host credential stores (Claude/Codex/IronCurtain OAuth always; SSH, cloud
  // and registry credentials unless the user opted a store out).
  for (const storePath of computeCredentialStoreProtectedPaths(opts.credentialProtection)) {
    paths.push(storePath);
  }
  // Protect user config (may contain serverCredentials)
  paths.push(getUserConfigPath());
  // The user's MCP server configuration names programs IronCurtain runs, so
  // an agent must neither read nor write it, nor create one a later run would
  // load. The home-wide entry covers it today; like config.json it is listed
  // on its own (even when absent) so that its protection never depends on how
  // home-wide entries are exempted for workspaces inside the home.
  paths.push(getUserMcpServersPath());
  // Retain the original name as well as today's target: a later decision must
  // follow the current link chain, including user-supplied extraPaths.
  return [...new Set(paths.flatMap((path) => [resolve(expandTilde(path)), resolveRealPath(path)]))];
}

/**
 * The audit log path loadConfig() configures (`IronCurtainConfig.auditLogPath`):
 * `AUDIT_LOG_PATH`, by default `./audit.jsonl`. Sessions and workflows
 * replace it with their own audit logs; it remains the fallback for
 * non-session use. computeProtectedPaths() protects it, and
 * getCwdDerivedProtectedPaths() reads the same value, so the protected entry
 * and its workspace exemption cannot drift apart.
 */
export function getConfiguredAuditLogPath(): string {
  return process.env.AUDIT_LOG_PATH ?? './audit.jsonl';
}

/**
 * Returns the protected entries computeProtectedPaths() places relative to
 * the process working directory: the configured audit log path
 * (getConfiguredAuditLogPath()) when it is relative, which by default is
 * `<cwd>/audit.jsonl`. It lies inside every workspace that contains the
 * launch directory (`ironcurtain start -w .`), so validateWorkspacePath()
 * exempts it from its workspace-contains-entry check; it still rejects a
 * workspace inside it. An absolute (or `~`) AUDIT_LOG_PATH is not derived
 * from the cwd and is not exempt.
 *
 * Keep this list in sync with computeProtectedPaths(): it must name only the
 * cwd-relative entries added there, because an entry listed here may sit
 * inside an agent's workspace. A trusted file that merely happens to resolve
 * into the cwd must not be listed. In particular `<cwd>/.env` is not: it is
 * never loaded (trusted-env.ts), and it is protected only when the user names
 * it as the explicit credential file (`--env-file` / IRONCURTAIN_ENV_FILE),
 * which no workspace may contain.
 */
export function getCwdDerivedProtectedPaths(): string[] {
  // Expanded as computeProtectedPaths() resolves it (resolveRealPath expands `~`).
  const auditLogPath = expandTilde(getConfiguredAuditLogPath());
  return isAbsolute(auditLogPath) ? [] : [resolveRealPath(auditLogPath)];
}

/**
 * Resolves internal source file paths (./src/*.ts) in MCP server configs
 * to absolute paths. In compiled mode, rewrites to dist/*.js with node.
 */
/**
 * Resolves all relative paths in MCP server configs to absolute paths.
 *
 * Handles two kinds of relative paths:
 * - `node_modules/...` — walks up from packageRoot to find hoisted packages
 * - `./src/...ts` — resolves to absolute; in compiled mode, rewrites to dist/*.js
 *
 * Must be called before spawning any MCP server process. Both `loadConfig()`
 * (runtime) and `loadPipelineConfig()` (pipeline) use this.
 */
export function resolveMcpServerPaths(mcpServers: Record<string, MCPServerConfig>): void {
  // packageRoot is two levels up from this file (src/config/ → project root)
  const packageRoot = resolve(__dirname, '..', '..');

  for (const config of Object.values(mcpServers)) {
    if (config.command.startsWith('node_modules/')) {
      config.command = resolveNodeModulesPath(config.command, packageRoot);
    }
    for (let i = 0; i < config.args.length; i++) {
      if (config.args[i].startsWith('node_modules/')) {
        config.args[i] = resolveNodeModulesPath(config.args[i], packageRoot);
      }
    }
    resolveInternalServerPaths(config, packageRoot, isCompiled);
  }
}

/**
 * The built-in servers of a loaded configuration, as a record of the same
 * objects (so resolving their paths updates `loaded.servers`). The user's
 * servers are left out: their paths are used as written, never resolved
 * against the package.
 */
export function builtinServerConfigs(loaded: LoadedMcpServers): Record<string, MCPServerConfig> {
  const builtins: Record<string, MCPServerConfig> = {};
  for (const name of loaded.builtinServers) {
    if (Object.hasOwn(loaded.servers, name)) builtins[name] = loaded.servers[name];
  }
  return builtins;
}

function resolveInternalServerPaths(config: MCPServerConfig, packageRoot: string, compiled: boolean): void {
  for (let i = 0; i < config.args.length; i++) {
    const arg = config.args[i];
    if (!arg.startsWith('./src/') || !arg.endsWith('.ts')) continue;

    if (compiled) {
      // Rewrite ./src/X.ts → <abs>/dist/X.js and use node
      const distRelative = arg.replace(/^\.\/src\//, 'dist/').replace(/\.ts$/, '.js');
      config.args[i] = resolve(packageRoot, distRelative);
      if (config.command === 'npx') {
        config.command = 'node';
        const tsxIdx = config.args.indexOf('tsx');
        if (tsxIdx !== -1) config.args.splice(tsxIdx, 1);
      } else if (config.command === 'tsx') {
        config.command = 'node';
      }
    } else {
      // Source mode — resolve to absolute path
      config.args[i] = resolve(packageRoot, arg);
    }
  }
}

/**
 * Rewrites the filesystem MCP server's allowed-directory arg to match
 * `allowedDirectory`. Must be called whenever `allowedDirectory` changes
 * (e.g. during session/workflow setup), otherwise the filesystem server
 * spawns with a stale path and fails with ENOENT.
 *
 * The filesystem server runs as `node <server-filesystem>/dist/index.js
 * <path>` (the exact-pinned dependency, never npx), so the path is always
 * the last argument. We replace it unconditionally to cover both the
 * initial load (args contain the sentinel) and subsequent re-patches
 * (args already contain a previous allowed directory).
 *
 * The path is written absolute, resolved against this process's cwd --
 * the base the policy engine uses for the same `allowedDirectory`. The
 * server runs in a private working directory, not the caller's, so a
 * relative path (from a caller that did not go through loadConfig() or
 * the workspace validators) would otherwise name a different directory
 * there.
 */
export function applyAllowedDirectoryToMcpArgs(
  mcpServers: Record<string, { args: string[] }>,
  allowedDirectory: string,
): void {
  const fsServer = mcpServers['filesystem'];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: key may not exist in external JSON
  if (!fsServer) return;
  if (fsServer.args.length === 0) return;
  fsServer.args[fsServer.args.length - 1] = resolve(allowedDirectory);
}

/**
 * Writes the user's `fetch.allowPrivateNetworks` decision into the fetch
 * server's env (`mcpServers.fetch.env`). The value is always set, to `1` or
 * `0`, because the backend env is layered over the inherited host env: an
 * explicit `0` keeps a stray host variable from enabling private
 * destinations, so the config file alone decides. Fail-closed: a fetch
 * server spawned without the variable blocks every non-public destination.
 */
export function applyFetchServerOptions(
  mcpServers: Record<string, MCPServerConfig>,
  options: { readonly allowPrivateNetworks: boolean },
): void {
  // The key may be absent: mcp-servers.json is external input.
  const fetchServer = mcpServers['fetch'] as MCPServerConfig | undefined;
  if (!fetchServer) return;
  fetchServer.env = {
    ...(fetchServer.env ?? {}),
    [FETCH_ALLOW_PRIVATE_NETWORKS_ENV]: options.allowPrivateNetworks ? '1' : '0',
  };
}

/**
 * Translates the typed webSearch config into flat env vars for the fetch server.
 */
function computeWebSearchCredentials(webSearch: ResolvedWebSearchConfig): Record<string, string> {
  const creds: Record<string, string> = {};
  if (!webSearch.provider) return creds;

  creds.WEB_SEARCH_PROVIDER = webSearch.provider;

  switch (webSearch.provider) {
    case 'brave':
      if (webSearch.brave) creds.BRAVE_API_KEY = webSearch.brave.apiKey;
      break;
    case 'tavily':
      if (webSearch.tavily) creds.TAVILY_API_KEY = webSearch.tavily.apiKey;
      break;
    case 'serpapi':
      if (webSearch.serpapi) creds.SERPAPI_API_KEY = webSearch.serpapi.apiKey;
      break;
  }

  return creds;
}

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /**
   * Never write config.json: no creation, no backfilled defaults, no
   * migration (`loadUserConfig({ readOnly: true })`). A missing file resolves
   * to the defaults. Diagnostics (`ironcurtain doctor`) load this way, so
   * running them changes nothing on disk. (A load that creates config.json
   * marks the first-start wizard as not run, see setup-state.ts, so a fresh
   * install gets the wizard either way.)
   */
  readonly readOnly?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): IronCurtainConfig {
  const userConfig = loadUserConfig(options.readOnly === true ? { readOnly: true } : undefined);

  const auditLogPath = getConfiguredAuditLogPath();
  // Default to a path under the IronCurtain home directory.
  // In practice, the session factory overrides this per-session,
  // so this default is a fallback for non-session usage (e.g., pipeline).
  const defaultAllowedDir = resolve(getIronCurtainHome(), 'sandbox');
  // Absolute, resolved against this process's cwd once: MCP relays and
  // backends run in their own trusted working directories (see
  // trusted-process/spawn-cwd.ts), where a relative path would name a
  // different directory than the one the policy engine checks.
  const allowedDirectory = resolve(process.env.ALLOWED_DIRECTORY ?? defaultAllowedDir);

  // The package's servers with the user's ~/.ironcurtain/mcp-servers.json
  // layered over them, schema-validated (reserved names included); throws
  // McpServersConfigError (code MCP_SERVERS_INVALID) naming the file and field.
  const loadedServers = loadMcpServers();
  warnOnMcpServerAdjustments(loadedServers);
  const mcpServersPath = loadedServers.packagePath;
  const mcpServers = loadedServers.servers;

  // Sync the filesystem server's allowed directory with the configured value.
  // The mcp-servers.json ships with a default path that may differ from
  // the ALLOWED_DIRECTORY environment variable.
  applyAllowedDirectoryToMcpArgs(mcpServers, allowedDirectory);

  // Resolve the package-relative paths (node_modules/ and ./src/) of the
  // built-in servers to absolute paths; the user's servers run as written.
  resolveMcpServerPaths(builtinServerConfigs(loadedServers));

  // Host-side fetch server settings travel in its env, never in tool arguments.
  applyFetchServerOptions(mcpServers, { allowPrivateNetworks: userConfig.fetch?.allowPrivateNetworks === true });

  const constitutionPath = resolve(__dirname, 'constitution.md');
  const packageGeneratedDir = resolve(__dirname, 'generated');
  const generatedDir = resolveArtifactDir('compiled-policy.json', packageGeneratedDir);
  const toolAnnotationsDir = resolveArtifactDir('tool-annotations.json', packageGeneratedDir);

  const protectedPaths = computeProtectedPaths({
    constitutionPath,
    generatedDir,
    packageGeneratedDir,
    mcpServersPath,
    auditLogPath,
    credentialProtection: userConfig.credentialProtection,
  });

  // Warn if serverCredentials keys don't match any configured server.
  // This check requires both configs, so it must happen here rather than in loadUserConfig().
  const serverNames = new Set(Object.keys(mcpServers));
  for (const credKey of Object.keys(userConfig.serverCredentials)) {
    if (!serverNames.has(credKey)) {
      process.stderr.write(
        `Warning: serverCredentials["${credKey}"] does not match any configured MCP server ` +
          `(mcp-servers.json). Available servers: ${[...serverNames].join(', ')}\n`,
      );
    }
  }

  // Inject web search credentials into the fetch server's credential block.
  const webSearchCreds = computeWebSearchCredentials(userConfig.webSearch);
  let finalUserConfig = userConfig;
  if (Object.keys(webSearchCreds).length > 0) {
    const existingFetch =
      (userConfig.serverCredentials as Record<string, Record<string, string> | undefined>).fetch ?? {};
    const mergedCredentials: Record<string, Record<string, string>> = {};
    for (const [k, v] of Object.entries(userConfig.serverCredentials)) {
      mergedCredentials[k] = { ...v };
    }
    mergedCredentials.fetch = { ...existingFetch, ...webSearchCreds };
    finalUserConfig = { ...userConfig, serverCredentials: mergedCredentials };
  }

  return {
    auditLogPath,
    allowedDirectory,
    mcpServers,
    protectedPaths,
    generatedDir,
    toolAnnotationsDir,
    constitutionPath,
    agentModelId: finalUserConfig.agentModelId,
    escalationTimeoutSeconds: finalUserConfig.escalationTimeoutSeconds,
    userConfig: finalUserConfig,
    // Already resolved by loadUserConfig(): env override > config > default.
    sandboxPolicy: finalUserConfig.sandboxPolicy,
  };
}

/**
 * Extracts domain allowlists from MCP server sandbox network configurations.
 * Returns a map from server name to its list of allowed domains.
 *
 * The `*` wildcard is preserved (not filtered) so that the untrusted domain gate fires
 * for servers with `["*"]`. The SSRF structural invariant in
 * `domainMatchesAllowlist()` prevents `*` from matching an IP address in any
 * spelling (`isIpAddress()` recognizes the inet_aton forms such as `2130706433`
 * and `127.1`, and IPv6 literals). It does not stop names that resolve to
 * private addresses, such as `localhost`.
 *
 * SECURITY NOTE: These allowlists drive the PolicyEngine's structural domain gate,
 * which escalates any URL-role argument whose destination is off the list or cannot
 * be verified. For git, the gate sees where the remote really connects (named
 * remotes, push URLs and URL rewrites resolved from the repository config inside
 * the sandbox, and an omitted remote evaluated as `origin`); a remote argument
 * that names a local repository is evaluated as a read of that path instead. In
 * the shipped mcp-servers.json, git and google-workspace have allowlists, so the
 * gate uses them. A server without an allowedDomains entry (fetch runs with
 * `sandbox: false`; custom servers) is gated by the engine's default `['*']`:
 * names pass to the compiled rules and IP literals escalate, so a compiled
 * "allow" rule without a `domains` condition never admits an address literal.
 * Local, private-network and cloud-metadata fetch destinations are denied
 * structurally whatever any list says. See the domain gate comment in
 * policy-engine.ts.
 */
export function extractServerDomainAllowlists(mcpServers: Record<string, MCPServerConfig>): Map<string, string[]> {
  const allowlists = new Map<string, string[]>();
  for (const [serverName, config] of Object.entries(mcpServers)) {
    const sandbox = config.sandbox;
    if (!sandbox || typeof sandbox !== 'object') continue;
    const network = sandbox.network;
    if (!network || typeof network !== 'object') continue;
    if (network.allowedDomains.length > 0) {
      allowlists.set(serverName, [...network.allowedDomains]);
    }
  }
  return allowlists;
}

/**
 * Checks whether the compiled policy matches the current constitution.
 * Emits a warning to stderr when the constitution has changed since the
 * last `ironcurtain compile-policy` run.
 */
export function checkConstitutionFreshness(compiledPolicy: CompiledPolicyFile, constitutionPath: string): void {
  const currentHash = computeConstitutionHash(constitutionPath);
  if (currentHash !== compiledPolicy.constitutionHash) {
    process.stderr.write(
      'Warning: constitution has changed since the last policy compilation. ' +
        'Run `ironcurtain compile-policy` to update the compiled policy.\n',
    );
  }
}

/**
 * Pure diff between the configured MCP servers and the servers covered by
 * `tool-annotations.json`. Used by both the runtime freshness check and
 * the compile-time preventive check, which format the same drift data
 * differently.
 *
 *   - `missing`: configured servers with no annotations entry (these will
 *     silently default-deny every call via the policy engine's
 *     structural-unknown-tool fallback).
 *   - `orphaned`: annotated servers no longer configured (informational).
 */
export function findAnnotationServerDrift(
  toolAnnotations: StoredToolAnnotationsFile,
  mcpServers: Record<string, MCPServerConfig>,
): { missing: string[]; orphaned: string[] } {
  const configuredNames = new Set(Object.keys(mcpServers));
  const annotatedNames = new Set(Object.keys(toolAnnotations.servers));
  return {
    missing: [...configuredNames].filter((name) => !annotatedNames.has(name)).sort(),
    orphaned: [...annotatedNames].filter((name) => !configuredNames.has(name)).sort(),
  };
}

/**
 * Runtime freshness check: emits stderr warnings when the on-disk
 * tool-annotations.json no longer matches the configured MCP servers.
 *
 * The warning suggests re-running annotations for each specific server,
 * not `--all`, so the user only re-classifies what actually changed.
 */
export function checkAnnotationFreshness(
  toolAnnotations: StoredToolAnnotationsFile,
  mcpServers: Record<string, MCPServerConfig>,
): void {
  const { missing, orphaned } = findAnnotationServerDrift(toolAnnotations, mcpServers);

  if (missing.length > 0) {
    process.stderr.write(
      `Warning: ${missing.length} configured MCP server(s) have no tool annotations: ${missing.map(safeForDisplay).join(', ')}. ` +
        `Tools from these servers will be denied by the policy engine until annotated.\n`,
    );
    for (const name of missing) {
      process.stderr.write(
        `  Run \`ironcurtain annotate-tools --server ${safeForDisplay(name)}\` to annotate this server.\n`,
      );
    }
  }

  if (orphaned.length > 0) {
    process.stderr.write(
      `Note: tool-annotations.json contains server(s) no longer in mcp-servers.json: ${orphaned.map(safeForDisplay).join(', ')}.\n`,
    );
  }
}

/**
 * Quotes a user-supplied identifier for inclusion in a stderr message or a
 * copy-paste shell command. Escapes control characters, quotes, and
 * backslashes via JSON string semantics, and wraps the result in double
 * quotes. The output is both safe to print (no terminal injection) and
 * safe to paste into bash (`--server "name"`).
 */
export function safeForDisplay(identifier: string): string {
  return JSON.stringify(identifier);
}

const COMPILED_POLICY_FILENAME = 'compiled-policy.json';

/**
 * The `@list` names a compiled policy defines that `dynamicLists` does not
 * provide. Allows match no values; restrictive conditions remain restrictive.
 */
export function findMissingDynamicLists(
  compiledPolicy: CompiledPolicyFile,
  dynamicLists: DynamicListsFile | undefined,
): string[] {
  return (compiledPolicy.listDefinitions ?? [])
    .map((definition) => definition.name)
    .filter((name) => dynamicLists === undefined || !Object.hasOwn(dynamicLists.lists, name));
}

/**
 * Layers the user's dynamic-lists.json (`~/.ironcurtain/generated/`, written
 * by `ironcurtain refresh-lists` and edited by the user) over the lists
 * shipped with the package, for the package's compiled policy.
 *
 * Per list name:
 *   - the user's overrides (`manualAdditions` / `manualRemovals`) always apply;
 *   - the user's values replace the shipped ones only when they were resolved
 *     from the same definition (equal `inputHash`) and no earlier than the
 *     shipped ones (`resolvedAt`). Otherwise the shipped values are used: in
 *     `stale` when an upgrade changed the list's definition since the user
 *     refreshed it, in `superseded` when an upgrade shipped a newer resolution
 *     of it (which may drop values the older one had);
 *   - a list only one of the files has is taken from that file.
 */
export function layerUserDynamicLists(
  packageLists: DynamicListsFile | undefined,
  userLists: DynamicListsFile,
): { lists: DynamicListsFile; stale: string[]; superseded: string[] } {
  const layered = new Map(Object.entries(packageLists?.lists ?? {}));
  const stale: string[] = [];
  const superseded: string[] = [];
  for (const [name, user] of Object.entries(userLists.lists)) {
    const shipped = layered.get(name);
    if (!shipped) {
      layered.set(name, user);
      continue;
    }
    // An unresolved entry (UNRESOLVED_LIST_HASH) never matches a shipped resolution.
    const sameDefinition = user.inputHash !== UNRESOLVED_LIST_HASH && user.inputHash === shipped.inputHash;
    if (sameDefinition && !resolvedBefore(user, shipped)) {
      layered.set(name, user);
      continue;
    }
    layered.set(name, { ...shipped, manualAdditions: user.manualAdditions, manualRemovals: user.manualRemovals });
    (sameDefinition ? superseded : stale).push(name);
  }
  return { lists: { generatedAt: userLists.generatedAt, lists: Object.fromEntries(layered) }, stale, superseded };
}

/**
 * Whether `user` was resolved before `shipped`. A shipped list without a
 * readable `resolvedAt` never supersedes the user's; a user list without one
 * is older than any shipped resolution that has one.
 */
function resolvedBefore(user: ResolvedList, shipped: ResolvedList): boolean {
  const shippedAt = Date.parse(shipped.resolvedAt);
  if (Number.isNaN(shippedAt)) return false;
  const userAt = Date.parse(user.resolvedAt);
  return Number.isNaN(userAt) || userAt < shippedAt;
}

/**
 * Loads the dynamic lists that belong to the compiled policy read from
 * `policySourceDir`. A policy and its lists are one unit: the lists come from
 * the same directory, never from another policy's directory.
 *
 * The one exception is the package's own policy, which a user who never
 * compiled locally runs with: `ironcurtain refresh-lists` cannot write next
 * to it, so it writes `~/.ironcurtain/generated/dynamic-lists.json`, which is
 * layered over the shipped lists (`layerUserDynamicLists`).
 *
 * Both files are schema-validated (`loadDynamicListsArtifact`): one that is
 * not a valid lists file fails the load, naming the file and each offending
 * field, rather than being skipped (it may hold the user's manual removals).
 *
 * Warns (session log) when the policy defines lists but no lists file exists:
 * allow rules using them match no values; escalation/deny conditions stay restrictive.
 */
function loadDynamicListsFor(
  compiledPolicy: CompiledPolicyFile,
  policySourceDir: string,
): DynamicListsFile | undefined {
  let lists = loadDynamicListsArtifact(policySourceDir);

  const userDir = getUserGeneratedDir();
  const sourceReal = resolveRealPath(policySourceDir);
  if (sourceReal === resolveRealPath(getPackageGeneratedDir()) && sourceReal !== resolveRealPath(userDir)) {
    const userLists = loadDynamicListsArtifact(userDir);
    if (userLists) {
      const userFile = resolve(userDir, DYNAMIC_LISTS_FILENAME);
      const layered = layerUserDynamicLists(lists, userLists);
      for (const name of layered.stale) {
        logger.warn(
          `[policy] Dynamic list "@${name}" in ${userFile} was resolved for a ` +
            'different definition than the shipped policy uses; using the shipped values (your manual ' +
            'overrides still apply). Run "ironcurtain refresh-lists" to refresh it.',
        );
      }
      for (const name of layered.superseded) {
        logger.info(
          `[policy] Dynamic list "@${name}" in ${userFile} is older than the one shipped with this ` +
            'version of IronCurtain; using the shipped values (your manual overrides still apply).',
        );
      }
      lists = layered.lists;
    }
  }

  if (lists === undefined) {
    const missing = findMissingDynamicLists(compiledPolicy, undefined);
    if (missing.length > 0) {
      logger.warn(
        `[policy] The compiled policy in ${policySourceDir} defines dynamic list(s) ` +
          `${missing.map((name) => `@${name}`).join(', ')} but has no ${DYNAMIC_LISTS_FILENAME}; rules that use ` +
          'them cannot narrow escalation/deny conditions. Run "ironcurtain refresh-lists" (or "ironcurtain compile-policy").',
      );
    }
  }
  return lists;
}

/**
 * Options for loading generated policy artifacts with split directories.
 * Allows policy files and tool annotations to come from different dirs.
 */
export interface PolicyLoadOptions {
  /**
   * Directory for compiled-policy.json and dynamic-lists.json. The lists are
   * always read from the directory the compiled policy came from.
   */
  readonly policyDir: string;
  /**
   * Directory for tool-annotations.json (always global). When it differs from
   * `fallbackDir`, its file is an overlay layered per server over the
   * `fallbackDir` (package) annotations.
   */
  readonly toolAnnotationsDir: string;
  /** Fallback directory for missing artifacts (package-bundled defaults). */
  readonly fallbackDir?: string;
  /**
   * Compare the policy's provenance with this IronCurtain and the loaded
   * annotations, reporting (or, with `onStale: 'refuse'`, rejecting) a stale
   * policy; see `checkPolicyProvenance`. Omitted: no check.
   */
  readonly provenanceCheck?: PolicyProvenanceCheckOptions;
}

/**
 * Loads the policy artifacts a session evaluates with: compiled-policy.json
 * from `policyDir` (or `fallbackDir`), the optional dynamic-lists.json that
 * belongs to it (`loadDynamicListsFor`), and the effective tool annotations.
 *
 * Every artifact is read with `readPolicyArtifact` (no symlink at its name,
 * a regular file no other local user can write) and schema-validated before
 * it is returned (`src/types/policy-schema.ts`); nothing here casts parsed
 * JSON. A malformed compiled policy or lists file throws
 * `PolicyArtifactError` (`code: 'POLICY_ARTIFACT_INVALID'`) naming the file
 * and each offending field; annotations that are malformed or refused by the
 * read throw `TOOL_ANNOTATIONS_INVALID`. Callers must not start a session
 * (or swap a policy) when this throws.
 */
export function loadGeneratedPolicy(options: PolicyLoadOptions): {
  compiledPolicy: CompiledPolicyFile;
  /** The compiled-policy.json that was read (in `policyDir` or the fallback). */
  compiledPolicyPath: string;
  toolAnnotations: StoredToolAnnotationsFile;
  /** How the user overlay (if any) was resolved; pass to `warnOnAnnotationOverlay`. */
  toolAnnotationsOverlay: ToolAnnotationsOverlayReport;
  dynamicLists: DynamicListsFile | undefined;
} {
  const { compiledPolicy, path: compiledPolicyPath } = readCompiledPolicyArtifact(
    options.policyDir,
    options.fallbackDir,
  );
  const loaded = loadToolAnnotations(options.toolAnnotationsDir, options.fallbackDir);
  if (!loaded) {
    const missingPath = resolve(options.toolAnnotationsDir, TOOL_ANNOTATIONS_FILENAME);
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${missingPath}'`), {
      code: 'ENOENT',
      path: missingPath,
    });
  }
  // The lists come from the directory the compiled policy was read from.
  const dynamicLists = loadDynamicListsFor(compiledPolicy, dirname(compiledPolicyPath));
  // Provenance is assessed only once every artifact has passed its schema.
  if (options.provenanceCheck) {
    checkPolicyProvenance(compiledPolicy, compiledPolicyPath, loaded.annotations, options.provenanceCheck);
  }

  return {
    compiledPolicy,
    compiledPolicyPath,
    toolAnnotations: loaded.annotations,
    toolAnnotationsOverlay: loaded.overlay,
    dynamicLists,
  };
}

/** Options for {@link loadPersonaPolicyArtifacts}. */
export interface PersonaPolicyLoadOptions {
  /**
   * Compare the policy's provenance with this IronCurtain (and with
   * `annotations`, when given), reporting or refusing a stale policy; see
   * `checkPolicyProvenance`. Omitted: no check.
   */
  readonly provenanceCheck?: PolicyProvenanceCheckOptions & {
    /** The annotations the policy will be evaluated with. */
    readonly annotations?: StoredToolAnnotationsFile;
  };
}

/**
 * Loads only the per-persona / per-policy artifacts (compiled-policy.json
 * and optional dynamic-lists.json). Tool annotations are deliberately not
 * read here because they are globally-scoped: a persona directory only
 * ships policy + lists, not annotations. The lists are loaded as for
 * `loadGeneratedPolicy` (`loadDynamicListsFor`), so a workflow state that
 * swaps to the package's global policy also sees the user's refreshed lists.
 *
 * Used by `ToolCallCoordinator.loadPolicy` during a hot-swap to pick up
 * the new policy without touching the retained annotations. Both files are
 * schema-validated as in {@link loadGeneratedPolicy}; a malformed one
 * throws and the coordinator keeps its current engine. The coordinator also
 * passes `provenanceCheck` with the retained annotations, so a stale persona
 * or job policy is reported (or refused) before it is installed.
 */
export function loadPersonaPolicyArtifacts(
  policyDir: string,
  options: PersonaPolicyLoadOptions = {},
): {
  compiledPolicy: CompiledPolicyFile;
  dynamicLists: DynamicListsFile | undefined;
} {
  const { compiledPolicy, path: compiledPolicyPath } = readCompiledPolicyArtifact(policyDir);
  const dynamicLists = loadDynamicListsFor(compiledPolicy, policyDir);
  if (options.provenanceCheck) {
    const { annotations, ...checkOptions } = options.provenanceCheck;
    checkPolicyProvenance(compiledPolicy, compiledPolicyPath, annotations, checkOptions);
  }
  return { compiledPolicy, dynamicLists };
}

/**
 * Reads `<policyDir>/compiled-policy.json` the way the session loaders do
 * (`readPolicyArtifact`: no symlink at its name, a regular file of a trusted
 * owner that no other user can write) and schema-validates it, without its
 * lists or a provenance check. For offline tools that rewrite a policy in
 * place (`ironcurtain mcp` narrowing a policy to drop a server), so they
 * never act on a policy sessions refuse, nor turn one into a trusted file by
 * writing it back. Throws `PolicyArtifactError` (`POLICY_ARTIFACT_INVALID`)
 * for an invalid policy, and the read error for one that cannot be read so.
 */
export function readCompiledPolicyFile(policyDir: string): CompiledPolicyFile {
  return readCompiledPolicyArtifact(policyDir).compiledPolicy;
}

/**
 * Reads and validates compiled-policy.json from the primary dir, else the
 * fallback. Returns the policy and the path it was read from.
 */
function readCompiledPolicyArtifact(
  generatedDir: string,
  fallbackDir?: string,
): { compiledPolicy: CompiledPolicyFile; path: string } {
  const path = resolveGeneratedFile(generatedDir, COMPILED_POLICY_FILENAME, fallbackDir);
  // A missing file throws ENOENT here (`code: 'ENOENT'`), naming the primary path.
  const text = readPolicyArtifact(path);
  return { compiledPolicy: parseCompiledPolicyFile(parseArtifactJson(text, 'compiled-policy', path), path), path };
}

/**
 * Reads and validates dynamic-lists.json from `generatedDir`, else
 * `fallbackDir`. Returns undefined when neither has one. A file that exists
 * but is not JSON or does not match the runtime schema throws
 * `PolicyArtifactError` naming the file and each offending field; it is
 * never skipped in favour of the fallback. Like the compiled policy, it is
 * read with `readPolicyArtifact`: a symlink at its name, or a file another
 * user can write, is refused rather than read or skipped.
 *
 * The session loaders above use it (without a fallback: a policy's lists
 * come from its own directory), and so must anything else that reads the
 * file, list resolution in particular (`refresh-lists`, the compile
 * pipeline's per-server lists and the merged file whose manual overrides it
 * carries over): resolution carries each list's manual overrides into the
 * values it writes, so a string where an array belongs would be spread into
 * single characters there (a bare `*` in a domain allowlist) and outlive the
 * user's fix of the field.
 */
export function loadDynamicListsArtifact(generatedDir: string, fallbackDir?: string): DynamicListsFile | undefined {
  const path = resolveGeneratedFile(generatedDir, DYNAMIC_LISTS_FILENAME, fallbackDir);
  if (!policyArtifactEntryExists(path)) return undefined;
  const text = readPolicyArtifact(path);
  return parseDynamicListsFile(parseArtifactJson(text, 'dynamic-lists', path), path);
}

/**
 * The path of a generated artifact: in the primary dir when it exists there,
 * else in the fallback dir when it exists there, else the primary path (so
 * a read of a missing file reports the primary location).
 */
function resolveGeneratedFile(generatedDir: string, filename: string, fallbackDir?: string): string {
  const primaryPath = resolve(generatedDir, filename);
  // A planted symlink (even a dangling one) is an entry: the hardened read
  // then refuses it rather than the loader falling back to the package's file.
  if (policyArtifactEntryExists(primaryPath)) return primaryPath;
  if (fallbackDir) {
    const fallbackPath = resolve(fallbackDir, filename);
    if (policyArtifactEntryExists(fallbackPath)) return fallbackPath;
  }
  return primaryPath;
}

/**
 * Resolves a node_modules/ relative path by walking up from startDir.
 * Handles npm's dependency hoisting where packages may live in a parent node_modules/.
 */
function resolveNodeModulesPath(relativePath: string, startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = resolve(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume it's directly under the package root
  return resolve(startDir, relativePath);
}
