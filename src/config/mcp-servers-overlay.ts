/**
 * The MCP servers IronCurtain runs: the package's `mcp-servers.json` (the
 * built-in servers) with the user's `$IRONCURTAIN_HOME/mcp-servers.json`
 * layered over it.
 *
 * The package file lives inside the installed package (`dist/config/` for an
 * npm install), so editing it needs write access to node_modules and the
 * edit is lost on upgrade. Users configure servers in their own file:
 *
 * - An entry whose name is not a built-in ADDS a server. It is a complete
 *   definition (`command`, `args`, `env`, `description`, `sandbox`) and is
 *   used exactly as written: relative `node_modules/` and `./src/` paths are
 *   resolved for built-ins only. The command must be an absolute path or a
 *   program name looked up on PATH (servers run in a private working
 *   directory, so a relative path would name nothing). Names are 1-63
 *   lowercase letters, digits and single hyphens, starting with a letter: a
 *   server name becomes a directory name (`generated/servers/<name>/`), a
 *   tool-name prefix (`<name>__<tool>`) and a sandbox namespace.
 * - An entry named after a built-in server ADJUSTS it, through the
 *   documented fields only: `env` (merged over the built-in's own env, key
 *   by key) and `sandbox.network.allowedDomains` / `deniedDomains` (each
 *   replacing the built-in's list) for a built-in that already has a network
 *   allowlist. Its command, args, description and the rest of its sandbox
 *   cannot be replaced: IronCurtain special-cases its built-ins by name (the
 *   filesystem server's root confinement and allowed-directory argument, the
 *   git backend's hardened environment, the fetch server's SSRF guard and
 *   settings channel), and a replaced definition would run another program
 *   under those assumptions. An env variable that reconfigures the process
 *   rather than the server is refused as well: the names the credential
 *   loader never loads (`isForbiddenEnvKey`: loader, path, proxy, git, docker,
 *   TLS and IronCurtain variables). Every adjustment is reported with a
 *   warning whenever a session or the pipeline loads the configuration
 *   ({@link warnOnMcpServerAdjustments}).
 * - Names reserved for IronCurtain's internal servers are refused in either
 *   file: the in-process virtual servers of `RESERVED_SERVER_NAMES` (`proxy`,
 *   the `network` egress-policy namespace and the coordinator's `workflow`
 *   tool) and the session-injected `memory`.
 *
 * Both files are validated (zod for the structure, plus the rules above)
 * before anything uses them. A problem throws {@link McpServersConfigError}
 * (`code: 'MCP_SERVERS_INVALID'`) naming the file and every offending field,
 * so a hand-edit typo stops the command instead of crashing deep inside a
 * spawn. The user file must be a regular file owned by the current user (or
 * root) that other users cannot write: it names programs IronCurtain runs.
 * It is a protected path (`computeProtectedPaths`), so no agent can read or
 * write it.
 *
 * `ironcurtain mcp add|remove` edit the user file through
 * {@link updateUserMcpServers} (validated as a whole before the write) and
 * {@link removeUserMcpServerEntry}: under a cross-process lock, written
 * atomically with mode 0600.
 *
 * Keys starting with `_` are comments: allowed at the top level and inside
 * an entry, and ignored.
 */

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { getUserMcpServersPath } from './paths.js';
import { isForbiddenEnvKey } from './trusted-env.js';
import type { MCPServerConfig, SandboxNetworkConfig, ServerSandboxConfig } from './types.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { passthroughEnvNames } from '../trusted-process/child-env.js';
import { describeSchemaIssues, formatArtifactProblems, formatSchemaFieldPath } from '../types/policy-schema.js';
import { RESERVED_SERVER_NAMES, SESSION_INJECTED_SERVER_NAMES } from '../types/reserved-servers.js';
import { writePrivateFileAtomicSync } from '../util/atomic-write.js';
import { withFileLockSync } from '../util/file-lock.js';
import { isObjectWithProp, isPlainObject } from '../utils/is-plain-object.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Basename of both server configuration files. */
export const MCP_SERVERS_FILENAME = 'mcp-servers.json';

/** The package-bundled server definitions (the built-in servers). */
export function getPackageMcpServersPath(): string {
  return resolve(__dirname, MCP_SERVERS_FILENAME);
}

/** Error code of {@link McpServersConfigError}; catch on it, not on the class. */
export const MCP_SERVERS_INVALID = 'MCP_SERVERS_INVALID';

/** Server names a user may add: lowercase letters, digits and single hyphens, starting with a letter. */
export const USER_SERVER_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const MAX_SERVER_NAME_LENGTH = 63;

/** The user file is a short list of commands; anything larger is a mistake. */
const MAX_USER_FILE_BYTES = 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Container CLIs whose `-e NAME` arguments forward a host variable into the container. */
const CONTAINER_CLIS: ReadonlySet<string> = new Set(['docker', 'podman']);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A server configuration file (the package's or the user's) is unreadable,
 * not JSON, or has invalid entries. `problems` holds one line per problem,
 * each naming the server and field (`git.command: ...`).
 */
export class McpServersConfigError extends Error {
  readonly code = MCP_SERVERS_INVALID;
  /** The file that failed to load. */
  readonly path: string;
  readonly problems: readonly string[];

  constructor(path: string, problems: readonly string[], options?: ErrorOptions) {
    super(formatArtifactProblems(`${path} is not a valid MCP server configuration`, problems), options);
    this.name = 'McpServersConfigError';
    this.path = path;
    this.problems = problems;
  }
}

/** True for a {@link McpServersConfigError} (tested by code, not class). */
export function isMcpServersConfigError(err: unknown): err is McpServersConfigError {
  return isObjectWithProp(err, 'code') && err.code === MCP_SERVERS_INVALID;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const NUL_MESSAGE = 'must not contain a NUL character';
const textSchema = z.string().refine((value) => !value.includes('\0'), NUL_MESSAGE);
const nonEmptyTextSchema = z
  .string()
  .min(1, 'must not be empty')
  .refine((value) => !value.includes('\0'), NUL_MESSAGE);

/**
 * A network allowlist entry: `*`, a host name or `*.` suffix pattern, and an
 * optional path (`github.com/owner/repo`, matched exactly by the git domain
 * gate). Catches the common mistakes (a URL with a scheme, a space, a `*` in
 * the middle) before the sandbox or the policy engine sees them.
 */
const DOMAIN_LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?';
const DOMAIN_PATTERN = new RegExp(`^(?:\\*|(?:\\*\\.)?${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*(?:/[^\\s*]+)?)$`);
const domainPatternSchema = z
  .string()
  .regex(DOMAIN_PATTERN, 'is not a domain pattern (expected example.com, *.example.com or *)');

const pathListSchema = z.array(nonEmptyTextSchema);

const sandboxNetworkSchema = z
  .object({
    allowedDomains: z.array(domainPatternSchema),
    deniedDomains: z.array(domainPatternSchema).optional(),
  })
  .strict();

const sandboxFilesystemSchema = z
  .object({
    allowWrite: pathListSchema.optional(),
    allowRead: pathListSchema.optional(),
    denyRead: pathListSchema.optional(),
    denyWrite: pathListSchema.optional(),
    confineToRoots: z.boolean().optional(),
  })
  .strict();

const serverSandboxSchema = z.union([
  z.literal(false),
  z
    .object({
      filesystem: sandboxFilesystemSchema.optional(),
      network: z.union([z.literal(false), sandboxNetworkSchema]).optional(),
    })
    .strict(),
]);

/** One complete server definition (`MCPServerConfig`), every field checked, unknown fields refused. */
const mcpServerConfigSchema = z
  .object({
    command: nonEmptyTextSchema,
    args: z.array(textSchema),
    env: z.record(z.string(), textSchema).optional(),
    description: z.string().optional(),
    sandbox: serverSandboxSchema.optional(),
  })
  .strict();

/** The adjustable network fields of a built-in server (each replaces the built-in's list). */
const networkAdjustmentSchema = z
  .object({
    allowedDomains: z.array(domainPatternSchema).optional(),
    deniedDomains: z.array(domainPatternSchema).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** What the user file changed in one built-in server. */
export interface McpServerAdjustment {
  readonly server: string;
  /** Env variables the user file sets for the server (names only). */
  readonly env: readonly string[];
  /** Replacement network allowlist, when the user file sets one. */
  readonly allowedDomains?: readonly string[];
  /** Replacement network denylist, when the user file sets one. */
  readonly deniedDomains?: readonly string[];
}

/** The merged, validated server configuration. */
export interface LoadedMcpServers {
  /**
   * Every server to run: the built-ins (in package order, with the user's
   * adjustments applied) followed by the user's servers (in file order).
   * Fresh objects on every load; callers may modify them.
   */
  readonly servers: Record<string, MCPServerConfig>;
  readonly packagePath: string;
  readonly userPath: string;
  /** Whether the user file exists. */
  readonly userFileExists: boolean;
  /** Names of the package's servers. */
  readonly builtinServers: readonly string[];
  /** Names of the servers the user file adds. */
  readonly userServers: readonly string[];
  /** Built-in servers the user file adjusts, in package order. */
  readonly adjustments: readonly McpServerAdjustment[];
}

export interface LoadMcpServersOptions {
  /** Package file (default {@link getPackageMcpServersPath}). */
  readonly packagePath?: string;
  /** User file (default `$IRONCURTAIN_HOME/mcp-servers.json`). */
  readonly userPath?: string;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Loads the package's servers, layers the user's file over them and
 * validates the result (see the module comment). Throws
 * {@link McpServersConfigError} for any problem in either file; never
 * returns a partial configuration.
 */
export function loadMcpServers(options: LoadMcpServersOptions = {}): LoadedMcpServers {
  const packagePath = options.packagePath ?? getPackageMcpServersPath();
  const userPath = options.userPath ?? getUserMcpServersPath();
  const builtins = loadPackageServers(packagePath);
  const userValue = readUserMcpServersFile(userPath);
  return mergeMcpServers(builtins, userValue, { packagePath, userPath });
}

/**
 * The package's (built-in) servers alone, validated, as fresh objects;
 * for callers that must keep working while the user file is broken.
 */
export function loadBuiltinMcpServers(
  packagePath: string = getPackageMcpServersPath(),
): Record<string, MCPServerConfig> {
  return Object.fromEntries(loadPackageServers(packagePath));
}

/** Parses and validates the package file. */
function loadPackageServers(packagePath: string): Map<string, MCPServerConfig> {
  let text: string;
  try {
    text = readFileSync(packagePath, 'utf-8');
  } catch (err) {
    throw new McpServersConfigError(packagePath, [`cannot be read (${errorText(err)}); reinstall IronCurtain`], {
      cause: err,
    });
  }
  const value = parseJson(text, packagePath);
  if (!isPlainObject(value)) {
    throw new McpServersConfigError(packagePath, [`(top level): expected an object, got ${describeType(value)}`]);
  }
  const servers = new Map<string, MCPServerConfig>();
  const problems: string[] = [];
  for (const [name, raw] of Object.entries(value)) {
    if (isCommentKey(name)) continue;
    const reserved = reservedNameProblem(name);
    if (reserved) {
      problems.push(reserved);
      continue;
    }
    const parsed = parseServerDefinition(name, raw);
    problems.push(...parsed.problems);
    if (parsed.config) servers.set(name, parsed.config);
  }
  if (problems.length > 0) throw new McpServersConfigError(packagePath, problems);
  return servers;
}

/**
 * Merges the validated package servers with the user file's parsed JSON
 * (undefined when there is none). Throws {@link McpServersConfigError}
 * naming the user file when any entry is invalid.
 */
function mergeMcpServers(
  builtins: ReadonlyMap<string, MCPServerConfig>,
  userValue: unknown,
  paths: { readonly packagePath: string; readonly userPath: string },
): LoadedMcpServers {
  const servers: Record<string, MCPServerConfig> = {};
  for (const [name, config] of builtins) servers[name] = config;
  const userServers: string[] = [];
  const adjustments = new Map<string, McpServerAdjustment>();

  if (userValue !== undefined) {
    if (!isPlainObject(userValue)) {
      throw new McpServersConfigError(paths.userPath, [
        `(top level): expected an object mapping server names to definitions, got ${describeType(userValue)}`,
      ]);
    }
    const problems: string[] = [];
    for (const [name, raw] of Object.entries(userValue)) {
      if (isCommentKey(name)) continue;
      const builtin = builtins.get(name);
      if (builtin) {
        const adjusted = adjustBuiltinServer(name, raw, builtin);
        problems.push(...adjusted.problems);
        if (adjusted.problems.length === 0) {
          servers[name] = adjusted.config;
          if (adjusted.adjustment) adjustments.set(name, adjusted.adjustment);
        }
        continue;
      }
      const added = validateUserServerDefinition(name, raw);
      problems.push(...added.problems);
      if (added.config) {
        servers[name] = added.config;
        userServers.push(name);
      }
    }
    if (problems.length > 0) throw new McpServersConfigError(paths.userPath, problems);
  }

  const builtinServers = [...builtins.keys()];
  return {
    servers,
    packagePath: paths.packagePath,
    userPath: paths.userPath,
    userFileExists: userValue !== undefined,
    builtinServers,
    userServers,
    adjustments: builtinServers.flatMap((name) => {
      const adjustment = adjustments.get(name);
      return adjustment ? [adjustment] : [];
    }),
  };
}

/**
 * Validates one server the user adds: its name (not reserved, the
 * {@link USER_SERVER_NAME_PATTERN} shape), its definition (the full schema)
 * and its command (absolute or a bare program name). The name must not be a
 * built-in; callers check that first. Returns the definition when there are
 * no problems.
 */
export function validateUserServerDefinition(
  name: string,
  raw: unknown,
): { readonly config?: MCPServerConfig; readonly problems: readonly string[] } {
  const nameProblem = userServerNameProblem(name);
  if (nameProblem) return { problems: [nameProblem] };
  const parsed = parseServerDefinition(name, raw);
  const problems = [...parsed.problems];
  // Checked on the raw value too, so every problem is reported at once.
  const command = isPlainObject(raw) ? raw.command : undefined;
  if (typeof command === 'string' && command !== '' && !isAbsolute(command) && /[/\\]/.test(command)) {
    problems.push(
      `${field(name, 'command')}: ${quoted(command)} is a relative path; use an absolute path or a program ` +
        'name found on PATH (servers run in a private working directory)',
    );
  }
  return problems.length > 0 ? { problems } : parsed;
}

/**
 * The problem with `name` as the name of a server the user adds, or
 * undefined when it may be used. Built-in names are not checked here.
 */
export function userServerNameProblem(name: string): string | undefined {
  const reserved = reservedNameProblem(name);
  if (reserved) return reserved;
  if (name.length > MAX_SERVER_NAME_LENGTH || !USER_SERVER_NAME_PATTERN.test(name)) {
    return (
      `${formatSchemaFieldPath([name])}: invalid server name ${quoted(name)}: use 1-${MAX_SERVER_NAME_LENGTH} ` +
      'lowercase letters, digits and single hyphens, starting with a letter'
    );
  }
  return undefined;
}

function reservedNameProblem(name: string): string | undefined {
  if (RESERVED_SERVER_NAMES.has(name)) {
    return `${formatSchemaFieldPath([name])}: the server name ${quoted(name)} is reserved for IronCurtain's internal tools`;
  }
  if (SESSION_INJECTED_SERVER_NAMES.has(name)) {
    return (
      `${formatSchemaFieldPath([name])}: the server name ${quoted(name)} is reserved for the memory server ` +
      'that sessions add themselves (enable memory per persona or job instead)'
    );
  }
  return undefined;
}

/** Parses one complete definition against the schema (comment keys dropped). */
function parseServerDefinition(
  name: string,
  raw: unknown,
): { readonly config?: MCPServerConfig; readonly problems: readonly string[] } {
  const result = mcpServerConfigSchema.safeParse(withoutCommentKeys(raw), { reportInput: true });
  if (!result.success) return { problems: describeSchemaIssues(result.error.issues, [name]) };
  const envProblems = envNameProblems(name, result.data.env);
  if (envProblems.length > 0) return { problems: envProblems };
  return { config: toServerConfig(result.data), problems: [] };
}

/** Copies the schema output into a fresh `MCPServerConfig`. */
function toServerConfig(data: z.infer<typeof mcpServerConfigSchema>): MCPServerConfig {
  return {
    command: data.command,
    args: [...data.args],
    ...(data.env !== undefined ? { env: { ...data.env } } : {}),
    ...(data.description !== undefined ? { description: data.description } : {}),
    ...(data.sandbox !== undefined ? { sandbox: copySandbox(data.sandbox) } : {}),
  };
}

function copySandbox(sandbox: ServerSandboxConfig): ServerSandboxConfig {
  if (sandbox === false) return false;
  const fs = sandbox.filesystem;
  return {
    ...(fs
      ? {
          filesystem: {
            ...(fs.allowWrite ? { allowWrite: [...fs.allowWrite] } : {}),
            ...(fs.allowRead ? { allowRead: [...fs.allowRead] } : {}),
            ...(fs.denyRead ? { denyRead: [...fs.denyRead] } : {}),
            ...(fs.denyWrite ? { denyWrite: [...fs.denyWrite] } : {}),
            ...(fs.confineToRoots !== undefined ? { confineToRoots: fs.confineToRoots } : {}),
          },
        }
      : {}),
    ...(sandbox.network !== undefined ? { network: copyNetwork(sandbox.network) } : {}),
  };
}

function copyNetwork(network: false | SandboxNetworkConfig): false | SandboxNetworkConfig {
  if (network === false) return false;
  return {
    allowedDomains: [...network.allowedDomains],
    ...(network.deniedDomains ? { deniedDomains: [...network.deniedDomains] } : {}),
  };
}

function envNameProblems(server: string, env: Readonly<Record<string, string>> | undefined): string[] {
  if (!env) return [];
  return Object.keys(env)
    .filter((name) => !ENV_NAME_PATTERN.test(name))
    .map((name) => `${formatSchemaFieldPath([server, 'env', name])}: not an environment variable name`);
}

// ---------------------------------------------------------------------------
// Built-in adjustments
// ---------------------------------------------------------------------------

/** Fields of a built-in server that the user file may never set. */
const REPLACEMENT_FIELDS: Readonly<Record<string, string>> = {
  command: 'command',
  args: 'arguments',
  description: 'description',
};

const ADJUSTABLE_FIELDS_HINT =
  'only env and sandbox.network.allowedDomains / deniedDomains may be adjusted; ' +
  'to run another program, add it as a new server under its own name';

/**
 * Applies the user file's entry for built-in server `name`. Returns the
 * adjusted definition, the adjustment (undefined when the entry changes
 * nothing) and the problems; the definition is only meaningful without
 * problems.
 */
function adjustBuiltinServer(
  name: string,
  raw: unknown,
  builtin: MCPServerConfig,
): { readonly config: MCPServerConfig; readonly adjustment?: McpServerAdjustment; readonly problems: string[] } {
  const problems: string[] = [];
  if (!isPlainObject(raw)) {
    problems.push(`${formatSchemaFieldPath([name])}: expected an object, got ${describeType(raw)}`);
    return { config: builtin, problems };
  }
  const entry = withoutCommentKeys(raw) as Record<string, unknown>;
  let env: Record<string, string> | undefined;
  let network: z.infer<typeof networkAdjustmentSchema> | undefined;

  for (const [key, value] of Object.entries(entry)) {
    if (Object.hasOwn(REPLACEMENT_FIELDS, key)) {
      problems.push(
        `${field(name, key)}: the ${REPLACEMENT_FIELDS[key]} of the built-in server ${quoted(name)} cannot be ` +
          `replaced (${ADJUSTABLE_FIELDS_HINT})`,
      );
    } else if (key === 'env') {
      const parsed = parseEnvAdjustment(name, value);
      problems.push(...parsed.problems);
      env = parsed.env;
    } else if (key === 'sandbox') {
      const parsed = parseSandboxAdjustment(name, value, builtin);
      problems.push(...parsed.problems);
      network = parsed.network;
    } else {
      problems.push(`${field(name, key)}: unknown field (${ADJUSTABLE_FIELDS_HINT})`);
    }
  }
  if (problems.length > 0) return { config: builtin, problems };

  const envNames = env ? Object.keys(env) : [];
  const changesNetwork = network !== undefined && (network.allowedDomains ?? network.deniedDomains) !== undefined;
  if (envNames.length === 0 && !changesNetwork) return { config: builtin, problems };

  const config: MCPServerConfig = { ...builtin };
  if (env && envNames.length > 0) config.env = { ...(builtin.env ?? {}), ...env };
  const sandbox = builtin.sandbox;
  // parseSandboxAdjustment refused a network change for a built-in without a network allowlist.
  if (network && changesNetwork && sandbox && sandbox.network) {
    const deniedDomains = network.deniedDomains ?? sandbox.network.deniedDomains;
    config.sandbox = {
      ...sandbox,
      network: {
        allowedDomains: [...(network.allowedDomains ?? sandbox.network.allowedDomains)],
        ...(deniedDomains ? { deniedDomains: [...deniedDomains] } : {}),
      },
    };
  }
  return {
    config,
    adjustment: {
      server: name,
      env: envNames,
      ...(network?.allowedDomains ? { allowedDomains: network.allowedDomains } : {}),
      ...(network?.deniedDomains ? { deniedDomains: network.deniedDomains } : {}),
    },
    problems,
  };
}

function parseEnvAdjustment(
  server: string,
  value: unknown,
): { readonly env?: Record<string, string>; readonly problems: string[] } {
  const result = z.record(z.string(), textSchema).safeParse(value, { reportInput: true });
  if (!result.success) return { problems: describeSchemaIssues(result.error.issues, [server, 'env']) };
  const problems = envNameProblems(server, result.data);
  for (const name of Object.keys(result.data)) {
    if (ENV_NAME_PATTERN.test(name) && isForbiddenEnvKey(name)) {
      problems.push(
        `${formatSchemaFieldPath([server, 'env', name])}: cannot be set for a built-in server: it changes how ` +
          'the process runs (loader, path, proxy, TLS, git, docker and IronCurtain variables are refused)',
      );
    }
  }
  return problems.length > 0 ? { problems } : { env: result.data, problems };
}

function parseSandboxAdjustment(
  server: string,
  value: unknown,
  builtin: MCPServerConfig,
): { readonly network?: z.infer<typeof networkAdjustmentSchema>; readonly problems: string[] } {
  const replaced = `the sandbox of the built-in server ${quoted(server)} cannot be replaced (${ADJUSTABLE_FIELDS_HINT})`;
  if (!isPlainObject(value)) return { problems: [`${field(server, 'sandbox')}: ${replaced}`] };
  const problems: string[] = [];
  for (const key of Object.keys(value)) {
    if (key !== 'network') problems.push(`${formatSchemaFieldPath([server, 'sandbox', key])}: ${replaced}`);
  }
  if (!Object.hasOwn(value, 'network')) return { problems };
  const network = value.network;
  if (!isPlainObject(network)) {
    problems.push(`${formatSchemaFieldPath([server, 'sandbox', 'network'])}: ${replaced}`);
    return { problems };
  }
  const result = networkAdjustmentSchema.safeParse(network, { reportInput: true });
  if (!result.success) {
    problems.push(...describeSchemaIssues(result.error.issues, [server, 'sandbox', 'network']));
    return { problems };
  }
  const builtinNetwork = builtin.sandbox === false ? undefined : builtin.sandbox?.network;
  if (!builtinNetwork) {
    problems.push(
      `${formatSchemaFieldPath([server, 'sandbox', 'network'])}: the built-in server ${quoted(server)} has no ` +
        'network allowlist to adjust (giving it network access would replace its sandbox)',
    );
  }
  return problems.length > 0 ? { problems } : { network: result.data, problems };
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/** One display-safe line per adjusted built-in server. */
export function describeMcpServerAdjustments(loaded: LoadedMcpServers): string[] {
  return loaded.adjustments.map((adjustment) => {
    const parts: string[] = [];
    if (adjustment.env.length > 0) parts.push(`env ${adjustment.env.join(', ')}`);
    if (adjustment.allowedDomains) {
      parts.push(`sandbox.network.allowedDomains = [${adjustment.allowedDomains.join(', ')}]`);
    }
    if (adjustment.deniedDomains) {
      parts.push(`sandbox.network.deniedDomains = [${adjustment.deniedDomains.join(', ')}]`);
    }
    return toDisplayText(
      `Warning: ${loaded.userPath} adjusts the built-in MCP server "${adjustment.server}": ${parts.join('; ')}.`,
    );
  });
}

/** Warnings already printed by this process (each once, however often the configuration is loaded). */
const printedWarnings = new Set<string>();

/**
 * Writes {@link describeMcpServerAdjustments} to stderr. Every command that
 * loads the configuration for a session or a compile warns, but a
 * long-running process (the daemon loads it for every job) prints each
 * distinct warning once.
 */
export function warnOnMcpServerAdjustments(
  loaded: LoadedMcpServers,
  write: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): void {
  for (const line of describeMcpServerAdjustments(loaded)) {
    if (printedWarnings.has(line)) continue;
    printedWarnings.add(line);
    write(`${line}\n`);
  }
}

// ---------------------------------------------------------------------------
// Declared credentials
// ---------------------------------------------------------------------------

/** True for a docker or podman command line, whose `-e NAME` arguments forward host variables. */
export function isContainerCommand(command: string): boolean {
  return CONTAINER_CLIS.has(basename(command));
}

const CREDENTIAL_KEYWORDS = ['TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'API'];

function looksLikeCredentialEnv(name: string): boolean {
  const upper = name.toUpperCase();
  return CREDENTIAL_KEYWORDS.some((keyword) => upper.includes(keyword));
}

/**
 * The environment variables a server declares it needs, sorted: its
 * `-e NAME` arguments (the docker convention: a host variable forwarded
 * into the container; `-e NAME=value` carries its own value), the keys of
 * its `env` block that look like credentials, and the keys of its `env`
 * block whose value is empty (a slot filled from `serverCredentials`).
 * `ironcurtain doctor` checks them, and the credential editor and
 * `ironcurtain mcp add` prompt for them.
 */
export function collectDeclaredEnvVars(serverConfig: MCPServerConfig): string[] {
  const names = new Set<string>(passthroughEnvNames(serverConfig.args));
  for (const [key, value] of Object.entries(serverConfig.env ?? {})) {
    // Transport-style variables carry hard-coded values, not secrets.
    if (value === '' || looksLikeCredentialEnv(key)) names.add(key);
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Reading and writing the user file
// ---------------------------------------------------------------------------

/**
 * Reads and parses the user file, or returns undefined when it does not
 * exist. Throws {@link McpServersConfigError} when it exists but is not a
 * regular file, belongs to another user, is writable by other users, is
 * too large or is not JSON. The checks and the read use one descriptor, so
 * a file swapped in between cannot change what is read.
 */
export function readUserMcpServersFile(userPath: string = getUserMcpServersPath()): unknown {
  let linkStats: Stats;
  try {
    linkStats = lstatSync(userPath);
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw new McpServersConfigError(userPath, [`cannot be read (${errorText(err)})`], { cause: err });
  }
  if (linkStats.isSymbolicLink()) assertTrustedOwner(linkStats, userPath, 'the symlink');

  let descriptor: number;
  try {
    // O_NONBLOCK: opening a FIFO never blocks; fstat below then refuses it.
    descriptor = openSync(userPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw new McpServersConfigError(userPath, [`cannot be read (${errorText(err)})`], { cause: err });
  }
  let text: string;
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new McpServersConfigError(userPath, ['(top level): not a regular file']);
    assertTrustedOwner(stats, userPath, 'the file');
    // Group-writable is the norm under a user-private-group umask (002), as
    // for the credential files (trusted-env.ts); world-writable never is.
    if ((stats.mode & 0o002) !== 0) {
      throw new McpServersConfigError(userPath, [
        `(top level): every user can write it (mode 0${(stats.mode & 0o777).toString(8)}), and it names ` +
          `programs IronCurtain runs. Run: chmod 600 ${userPath}`,
      ]);
    }
    text = readBounded(descriptor, userPath);
  } finally {
    closeSync(descriptor);
  }
  return parseJson(text, userPath);
}

/**
 * Edits the user file. Under the file's cross-process lock: reads and
 * validates the file, lets `edit` change its JSON object in place (comment
 * keys and other entries are kept as they are; `builtins` names the
 * package's servers), validates the result merged with the package's
 * servers, and writes it atomically with mode 0600. Throws
 * {@link McpServersConfigError}, and writes nothing, when the current file
 * or the edited result is invalid, so a broken file is never rewritten
 * around its problems; an error thrown by `edit` also writes nothing.
 * Returns what `edit` returned and the new configuration. To take an entry
 * out of a broken file, use {@link removeUserMcpServerEntry}.
 */
export function updateUserMcpServers<T>(
  edit: (entries: Record<string, unknown>, builtins: ReadonlySet<string>) => T,
  options: LoadMcpServersOptions = {},
): { readonly result: T; readonly loaded: LoadedMcpServers } {
  const packagePath = options.packagePath ?? getPackageMcpServersPath();
  const userPath = options.userPath ?? getUserMcpServersPath();
  // The lock file lives beside the user file, in the IronCurtain home.
  mkdirSync(dirname(userPath), { recursive: true, mode: 0o700 });
  return withFileLockSync(userPath, () => {
    const builtins = loadPackageServers(packagePath);
    const value = readUserMcpServersObject(userPath);
    mergeMcpServers(builtins, value, { packagePath, userPath });
    // Merging copies what it keeps, so the parsed object can be edited freely.
    const entries: Record<string, unknown> = value ?? {};
    const result = edit(entries, new Set(builtins.keys()));
    const loaded = mergeMcpServers(builtins, entries, { packagePath, userPath });
    writePrivateFileAtomicSync(userPath, `${JSON.stringify(entries, null, 2)}\n`);
    return { result, loaded };
  });
}

/** What {@link removeUserMcpServerEntry} did. */
export interface RemoveUserMcpServerResult {
  /** Whether the file had an entry of that name; nothing is written when it had none. */
  readonly removed: boolean;
  /** What is still wrong with the file after the removal, one line per problem (empty when it is valid). */
  readonly remainingProblems: readonly string[];
}

/**
 * Removes the entry `name` (a server, an adjustment of a built-in, or an
 * entry whose name is not valid at all) from the user file: under the
 * file's lock, written back atomically with mode 0600, comment keys and the
 * other entries kept as they are. Unlike {@link updateUserMcpServers}, the
 * other entries need not be valid. Taking an entry out never adds a
 * problem, and a file that is still invalid afterwards stays refused by
 * every loader, so this is how `mcp remove` repairs a hand-edited file one
 * entry at a time; the problems left are returned. The file must still be
 * a readable JSON object owned by the user (the checks of
 * {@link readUserMcpServersFile}).
 */
export function removeUserMcpServerEntry(name: string, options: LoadMcpServersOptions = {}): RemoveUserMcpServerResult {
  const packagePath = options.packagePath ?? getPackageMcpServersPath();
  const userPath = options.userPath ?? getUserMcpServersPath();
  mkdirSync(dirname(userPath), { recursive: true, mode: 0o700 });
  return withFileLockSync(userPath, () => {
    const builtins = loadPackageServers(packagePath);
    const entries = readUserMcpServersObject(userPath);
    if (entries === undefined || !Object.hasOwn(entries, name)) return { removed: false, remainingProblems: [] };
    Reflect.deleteProperty(entries, name);
    writePrivateFileAtomicSync(userPath, `${JSON.stringify(entries, null, 2)}\n`);
    try {
      mergeMcpServers(builtins, entries, { packagePath, userPath });
      return { removed: true, remainingProblems: [] };
    } catch (err) {
      if (!isMcpServersConfigError(err)) throw err;
      return { removed: true, remainingProblems: err.problems };
    }
  });
}

/** {@link readUserMcpServersFile}, which must hold a JSON object when it exists. */
function readUserMcpServersObject(userPath: string): Record<string, unknown> | undefined {
  const value = readUserMcpServersFile(userPath);
  if (value !== undefined && !isPlainObject(value)) {
    throw new McpServersConfigError(userPath, [`(top level): expected an object, got ${describeType(value)}`]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCommentKey(key: string): boolean {
  return key.startsWith('_');
}

/** A shallow copy of `value` without its comment keys; non-objects unchanged. */
function withoutCommentKeys(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !isCommentKey(key)));
}

function parseJson(text: string, path: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (err) {
    throw new McpServersConfigError(path, [`not valid JSON (${errorText(err)})`], { cause: err });
  }
}

function field(server: string, key: string): string {
  return formatSchemaFieldPath([server, key]);
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return isObjectWithProp(err, 'code') && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

/** The file (or the symlink naming it) must belong to the current user or root. */
function assertTrustedOwner(stats: Stats, path: string, what: string): void {
  const uid = process.getuid?.();
  if (uid === undefined || stats.uid === uid || stats.uid === 0) return;
  throw new McpServersConfigError(path, [
    `(top level): ${what} is owned by uid ${stats.uid}, not the current user (uid ${uid}), and it names ` +
      'programs IronCurtain runs',
  ]);
}

function readBounded(descriptor: number, path: string): string {
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let total = 0;
  for (;;) {
    const count = readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) return Buffer.concat(chunks, total).toString('utf-8');
    total += count;
    if (total > MAX_USER_FILE_BYTES) {
      throw new McpServersConfigError(path, [`(top level): larger than ${MAX_USER_FILE_BYTES} bytes`]);
    }
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
}
