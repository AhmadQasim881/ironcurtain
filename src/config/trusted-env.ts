/**
 * Trusted credential loading for every IronCurtain entry point.
 *
 * IronCurtain used to start with `import 'dotenv/config'`, which silently
 * copied every key of `<cwd>/.env` into the trusted host process. The working
 * directory is often an agent-writable workspace (the Docker bind mount, a
 * Code Mode `-w .` session) or an untrusted checkout, so a planted `.env`
 * could set NODE_OPTIONS (code execution in every Node child the host spawns),
 * IRONCURTAIN_HOME (swap the config, compiled policy and protected-path
 * roots), `*_BASE_URL` (send the real API key or OAuth token to an attacker),
 * IRONCURTAIN_MITM_ALLOW_ALL_HOSTS, DOTENV_CONFIG_QUIET, and more.
 *
 * Credentials now come only from:
 *
 * 1. `$IRONCURTAIN_HOME/.env` (default `~/.ironcurtain/.env`). The home is
 *    resolved from the real process environment before any file is read, and
 *    no file can set it.
 * 2. One explicit file: a leading `--env-file <path>` option, or the
 *    `IRONCURTAIN_ENV_FILE` variable exported in the shell (absolute path).
 *    Its values win over the home file for the same key.
 *
 * A file is used only if it is a regular file (a symlink is followed, but the
 * link must also belong to the user), owned by the current user and not
 * writable by every user. A group-writable or other-readable file is used with
 * a warning. Only credential keys are copied: the provider API keys and the
 * `-e NAME` pass-through names of mcp-servers.json (the bundled file and the
 * user's own), minus a defensive denylist of loader, path, proxy, base-URL and
 * IronCurtain variables. Other keys are reported by name and ignored. A
 * non-empty value already in the environment wins over both files.
 *
 * A `.env` in the working directory is never read. When one exists, a one-line
 * notice says it was ignored and where credentials go now.
 *
 * This module is a dependency-light leaf of src/config: it must not import the
 * session, docker or pipeline layers, because every entry point loads it
 * before anything else.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import { PROVIDER_ENV_VARS } from './model-id.js';
import { getUserMcpServersPath, resolveIronCurtainHome } from './paths.js';
import { getProviderEditorDescriptors } from './provider-definitions.js';
import { isPlainObject } from '../utils/is-plain-object.js';
import { toDisplayText } from '../terminal/display-sanitize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Environment variable naming the explicit credential file (absolute path). */
export const ENV_FILE_ENV_VAR = 'IRONCURTAIN_ENV_FILE';

/** Leading CLI option naming the explicit credential file. */
export const ENV_FILE_OPTION = '--env-file';

/** Basename of the credential file inside the IronCurtain home. */
export const TRUSTED_ENV_FILE_NAME = '.env';

/** Credential files are tiny; anything larger is a mistake or an attack. */
const MAX_ENV_FILE_BYTES = 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;

/** Shape of an environment variable name that may be loaded. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names never loaded from a file, even if a provider definition or an
 * mcp-servers.json `-e` entry names them. Compared upper-cased. Defense in
 * depth: the allowlist above is the primary control.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'ENV',
  'BASH_ENV',
  'TMPDIR',
  'ALLOWED_DIRECTORY',
  'AUDIT_LOG_PATH',
  'SANDBOX_POLICY',
  // Relay-internal variables (src/trusted-process/mcp-proxy-server.ts).
  'PROTECTED_PATHS',
  'SANDBOX_CREDENTIAL_PATHS',
  'MCP_SERVERS_CONFIG',
  'SERVER_CREDENTIALS',
  'SERVER_FILTER',
  'GENERATED_DIR',
  'TOOL_ANNOTATIONS_DIR',
  'SESSION_LOG_PATH',
  'ESCALATION_TIMEOUT_SECONDS',
  'BACKEND_CALL_TIMEOUT_MS',
  'OS_SANDBOX_AVAILABILITY',
  'RESULT_SIZE_LIMIT',
  // Redirect where other credential stores are read.
  'GNUPGHOME',
  'KUBECONFIG',
]);

const FORBIDDEN_PREFIXES: readonly string[] = [
  'IRONCURTAIN_',
  'NODE_', // NODE_OPTIONS, NODE_PATH, NODE_TLS_REJECT_UNAUTHORIZED, NODE_EXTRA_CA_CERTS
  'LD_',
  'DYLD_',
  'GIT_',
  'DOCKER_',
  'DOTENV_',
  'NPM_CONFIG_',
  'BASH_FUNC_',
  'SSL_',
  'XDG_',
  'PROXY_',
  'MITM_',
];

const FORBIDDEN_SUFFIXES: readonly string[] = ['_BASE_URL', '_PROXY', '_HOME', '_CONFIG_DIR'];

export type TrustedEnvErrorCode =
  /** A malformed `--env-file` option. */
  | 'USAGE'
  /** IRONCURTAIN_ENV_FILE is not an absolute path. */
  | 'INVALID_PATH'
  /** The explicit env file does not exist. */
  | 'NOT_FOUND'
  /** The env file is a directory, FIFO, socket or device. */
  | 'NOT_REGULAR_FILE'
  /** The env file (or the symlink naming it) is owned by another user, or is world-writable. */
  | 'INSECURE'
  /** The env file is larger than the size cap. */
  | 'TOO_LARGE'
  /** Any other filesystem error; `cause` holds the original. */
  | 'IO_ERROR';

/** Error raised while loading credentials. Catch on `code`, not `instanceof`. */
export class TrustedEnvError extends Error {
  readonly code: TrustedEnvErrorCode;

  constructor(code: TrustedEnvErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TrustedEnvError';
    this.code = code;
  }
}

/** `$IRONCURTAIN_HOME/.env` (default `~/.ironcurtain/.env`) for the given environment. */
export function getTrustedEnvFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(resolveIronCurtainHome(env.IRONCURTAIN_HOME), TRUSTED_ENV_FILE_NAME);
}

/**
 * The explicit credential file named by IRONCURTAIN_ENV_FILE, or undefined
 * when it is unset or empty. The CLI's `--env-file` option is turned into this
 * variable (see {@link bootstrapTrustedEnv}).
 *
 * @throws TrustedEnvError (`INVALID_PATH`) for a relative value, which would
 *   name a different file in every working directory.
 */
export function getExplicitEnvFilePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[ENV_FILE_ENV_VAR];
  if (value === undefined || value === '') return undefined;
  if (!isAbsolute(value) || value.includes('\0')) {
    throw new TrustedEnvError(
      'INVALID_PATH',
      `${ENV_FILE_ENV_VAR} must be an absolute path, got ${JSON.stringify(value)}`,
    );
  }
  return resolve(value);
}

/**
 * Every file credentials may be loaded from. These are protected paths
 * (computeProtectedPaths): an agent must not read them, or create one that a
 * later run would load.
 */
export function getTrustedEnvFilePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = getTrustedEnvFilePath(env);
  const explicit = getExplicitEnvFilePath(env);
  return explicit === undefined || explicit === home ? [home] : [home, explicit];
}

/** True for names that must never be loaded from a file (case-insensitive). */
export function isForbiddenEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    FORBIDDEN_KEYS.has(upper) ||
    FORBIDDEN_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    FORBIDDEN_SUFFIXES.some((suffix) => upper.endsWith(suffix))
  );
}

/**
 * The text of a regular file, or undefined when it is missing, not a regular
 * file or too large. Opened non-blocking and checked through the same
 * descriptor, so a FIFO planted at the path cannot stall start-up.
 */
function readRegularFileText(path: string): string | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(descriptor).isFile()) return undefined;
    return readBounded(descriptor, path).toString('utf-8');
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

/** The `-e NAME` (no `=`) pass-through names of every server in an mcp-servers.json file. */
function readMcpPassthroughEnvNames(mcpServersPath: string): string[] {
  let parsed: unknown;
  try {
    // A missing or broken file only means fewer loadable keys; loadConfig()
    // reports the real problem with its own error.
    const text = readRegularFileText(mcpServersPath);
    if (text === undefined) return [];
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed)) return [];
  const names: string[] = [];
  for (const server of Object.values(parsed)) {
    if (!isPlainObject(server) || !Array.isArray(server.args)) continue;
    const args: unknown[] = server.args;
    for (let i = 0; i < args.length - 1; i++) {
      const candidate = args[i + 1];
      // `-e NAME` forwards a host variable; `-e NAME=value` carries its own value.
      if (args[i] === '-e' && typeof candidate === 'string' && !candidate.includes('=')) {
        names.push(candidate);
      }
    }
  }
  return names;
}

/**
 * The credential keys a trusted env file may set: each provider's API key
 * (PROVIDER_ENV_VARS and the gateway profiles' credentialEnv) and the `-e`
 * pass-through names of the bundled mcp-servers.json (e.g.
 * GITHUB_PERSONAL_ACCESS_TOKEN) and of the user's own
 * `$IRONCURTAIN_HOME/mcp-servers.json` (servers added with `ironcurtain mcp
 * add`). Derived, not hard-coded, so new providers and servers stay in sync.
 * Anything matching {@link isForbiddenEnvKey} is dropped.
 *
 * The user file is read leniently here, like the bundled one: a broken file
 * only means fewer loadable keys, and `loadConfig()` refuses it with the
 * field-level error before any server starts.
 */
export function getCredentialEnvKeys(
  mcpServersPath: string = resolve(__dirname, 'mcp-servers.json'),
  userMcpServersPath: string = getUserMcpServersPath(resolveIronCurtainHome(process.env.IRONCURTAIN_HOME)),
): ReadonlySet<string> {
  const candidates = [
    ...Object.values(PROVIDER_ENV_VARS),
    ...getProviderEditorDescriptors().map((descriptor) => descriptor.credentialEnv),
    ...readMcpPassthroughEnvNames(mcpServersPath),
    ...readMcpPassthroughEnvNames(userMcpServersPath),
  ];
  return new Set(candidates.filter((key) => ENV_NAME_PATTERN.test(key) && !isForbiddenEnvKey(key)));
}

export interface EnvFileOptionSplit {
  /** Absolute path given by a leading `--env-file`, if any. */
  readonly envFile?: string;
  /** The arguments with that option removed. */
  readonly rest: string[];
}

/**
 * Takes leading `--env-file <path>` / `--env-file=<path>` off `args` (global
 * options before the subcommand). Only the leading position is recognised, so
 * a subcommand argument or task text is never consumed. A relative path is
 * resolved against `cwd` (default: the working directory, read only when the
 * option is present) once, here, so child processes see an absolute path.
 *
 * @throws TrustedEnvError (`USAGE`) for a missing or empty value, or a repeat.
 */
export function splitEnvFileOption(args: readonly string[], cwd?: string): EnvFileOptionSplit {
  let envFile: string | undefined;
  let index = 0;
  for (;;) {
    const arg = args.at(index);
    let value: string | undefined;
    if (arg === ENV_FILE_OPTION) {
      value = args.at(index + 1);
      if (value === undefined) throw new TrustedEnvError('USAGE', `${ENV_FILE_OPTION} requires a path`);
      index += 2;
    } else if (arg?.startsWith(`${ENV_FILE_OPTION}=`)) {
      value = arg.slice(ENV_FILE_OPTION.length + 1);
      index += 1;
    } else {
      break;
    }
    if (value === '' || value.includes('\0')) {
      throw new TrustedEnvError('USAGE', `${ENV_FILE_OPTION} requires a non-empty path`);
    }
    if (envFile !== undefined) throw new TrustedEnvError('USAGE', `${ENV_FILE_OPTION} can be given only once`);
    envFile = resolve(cwd ?? process.cwd(), value);
  }
  return { envFile, rest: args.slice(index) };
}

export interface LoadTrustedEnvOptions {
  /** Environment to read settings from and copy credentials into (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Working directory checked for an ignored `.env` (default `process.cwd()`). */
  readonly cwd?: string;
  /** Keys that may be loaded (default {@link getCredentialEnvKeys}). */
  readonly allowedKeys?: ReadonlySet<string>;
  /** uid that must own each file (default: the current uid; skipped where uids do not exist). */
  readonly expectedUid?: number;
}

export interface IgnoredEnvKeys {
  readonly file: string;
  /** Key names (never values) found in the file but not loaded. */
  readonly keys: readonly string[];
}

export interface EnvFilePermissionWarning {
  readonly file: string;
  /** Permission bits (`mode & 0o777`). */
  readonly mode: number;
}

export interface TrustedEnvResult {
  /** `$IRONCURTAIN_HOME/.env`, whether or not it exists. */
  readonly homeEnvFile: string;
  /** Files actually read, explicit file first. */
  readonly loadedFiles: readonly string[];
  /** Credential keys copied into the environment (names only). */
  readonly appliedKeys: readonly string[];
  readonly ignoredKeys: readonly IgnoredEnvKeys[];
  /** Files used despite being group-writable or readable by other users. */
  readonly permissionWarnings: readonly EnvFilePermissionWarning[];
  /** `<cwd>/.env` when it exists and was not read. */
  readonly ignoredCwdEnvFile?: string;
}

interface EnvFileContents {
  readonly contents: Buffer;
  readonly mode: number;
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function isNotFound(error: unknown): boolean {
  const code = errnoCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function octal(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
}

function assertOwnedBy(stats: Stats, path: string, expectedUid: number | undefined, what: string): void {
  if (expectedUid === undefined || stats.uid === expectedUid) return;
  throw new TrustedEnvError(
    'INSECURE',
    `Refusing to load credentials from ${path}: the ${what} is owned by uid ${stats.uid}, ` +
      `not the current user (uid ${expectedUid})`,
  );
}

function readBounded(descriptor: number, path: string): Buffer {
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let total = 0;
  for (;;) {
    let count: number;
    try {
      count = readSync(descriptor, chunk, 0, chunk.length, null);
    } catch (error) {
      throw new TrustedEnvError('IO_ERROR', `Cannot read env file ${path}`, { cause: error });
    }
    if (count === 0) return Buffer.concat(chunks, total);
    total += count;
    if (total > MAX_ENV_FILE_BYTES) {
      throw new TrustedEnvError('TOO_LARGE', `Env file ${path} is larger than ${MAX_ENV_FILE_BYTES} bytes`);
    }
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
}

/**
 * Reads one env file through a single descriptor (the ownership, type and mode
 * checks and the read all use it, so a swap after the checks cannot change
 * the bytes). Returns undefined when an optional file does not exist.
 */
function readEnvFile(path: string, required: boolean, expectedUid: number | undefined): EnvFileContents | undefined {
  // An absent optional file (or a dangling symlink to one) is simply skipped.
  const assertOptional = (cause: unknown): void => {
    if (required) throw new TrustedEnvError('NOT_FOUND', `Env file not found: ${path}`, { cause });
  };

  let linkStats: Stats;
  try {
    linkStats = lstatSync(path);
  } catch (error) {
    if (!isNotFound(error)) throw new TrustedEnvError('IO_ERROR', `Cannot read env file ${path}`, { cause: error });
    assertOptional(error);
    return undefined;
  }
  // Dotfile managers symlink these files, so a link is followed; but a link
  // planted by someone else must not choose which file is trusted.
  if (linkStats.isSymbolicLink()) assertOwnedBy(linkStats, path, expectedUid, 'symlink');

  let descriptor: number;
  try {
    // O_NONBLOCK: opening a FIFO never blocks; fstat below then refuses it.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (error) {
    if (!isNotFound(error)) throw new TrustedEnvError('IO_ERROR', `Cannot open env file ${path}`, { cause: error });
    assertOptional(error);
    return undefined;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new TrustedEnvError('NOT_REGULAR_FILE', `Env file ${path} is not a regular file`);
    assertOwnedBy(stats, path, expectedUid, 'file');
    const mode = stats.mode & 0o777;
    if ((mode & 0o002) !== 0) {
      throw new TrustedEnvError(
        'INSECURE',
        `Refusing to load credentials from ${path}: it is writable by every user (mode ${octal(mode)}). ` +
          `Run: chmod 600 ${path}`,
      );
    }
    return { contents: readBounded(descriptor, path), mode };
  } finally {
    closeSync(descriptor);
  }
}

function canonicalOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `<cwd>/.env` when something exists at that name and it is not one of the files just loaded. */
function findIgnoredCwdEnvFile(cwd: string | undefined, loadedFiles: readonly string[]): string | undefined {
  let directory: string;
  try {
    directory = cwd ?? process.cwd();
  } catch {
    return undefined; // the working directory was removed
  }
  const candidate = resolve(directory, TRUSTED_ENV_FILE_NAME);
  try {
    lstatSync(candidate);
  } catch {
    return undefined;
  }
  const canonical = canonicalOrSelf(candidate);
  const loaded = loadedFiles.some((file) => file === candidate || canonicalOrSelf(file) === canonical);
  return loaded ? undefined : candidate;
}

/**
 * Loads credentials from the trusted env files into `options.env`.
 *
 * @throws TrustedEnvError when a file exists but cannot be trusted or read, an
 *   explicit file is missing, or IRONCURTAIN_ENV_FILE is relative; Error when
 *   IRONCURTAIN_HOME is relative. Nothing is copied when it throws.
 */
export function loadTrustedEnv(options: LoadTrustedEnvOptions = {}): TrustedEnvResult {
  const env = options.env ?? process.env;
  const homeEnvFile = getTrustedEnvFilePath(env);
  const explicitEnvFile = getExplicitEnvFilePath(env);
  const allowedKeys =
    options.allowedKeys ??
    getCredentialEnvKeys(undefined, getUserMcpServersPath(resolveIronCurtainHome(env.IRONCURTAIN_HOME)));
  const expectedUid = options.expectedUid ?? process.getuid?.();

  // The explicit file comes first so its values win for the same key.
  const sources: { readonly path: string; readonly required: boolean }[] = [];
  if (explicitEnvFile !== undefined) sources.push({ path: explicitEnvFile, required: true });
  if (explicitEnvFile !== homeEnvFile) sources.push({ path: homeEnvFile, required: false });

  const loadedFiles: string[] = [];
  const ignoredKeys: IgnoredEnvKeys[] = [];
  const permissionWarnings: EnvFilePermissionWarning[] = [];
  const values = new Map<string, string>();
  for (const source of sources) {
    const file = readEnvFile(source.path, source.required, expectedUid);
    if (file === undefined) continue;
    loadedFiles.push(source.path);
    if ((file.mode & 0o064) !== 0) permissionWarnings.push({ file: source.path, mode: file.mode });
    const ignored: string[] = [];
    for (const [key, value] of Object.entries(parseDotenv(file.contents))) {
      if (!allowedKeys.has(key)) {
        ignored.push(key);
      } else if (!values.has(key)) {
        values.set(key, value);
      }
    }
    if (ignored.length > 0) ignoredKeys.push({ file: source.path, keys: ignored.sort() });
  }

  const appliedKeys: string[] = [];
  for (const [key, value] of values) {
    // A non-empty value from the real environment wins; empty file values are skipped.
    if (env[key] || value === '') continue;
    env[key] = value;
    appliedKeys.push(key);
  }

  return {
    homeEnvFile,
    loadedFiles,
    appliedKeys: appliedKeys.sort(),
    ignoredKeys,
    permissionWarnings,
    ignoredCwdEnvFile: findIgnoredCwdEnvFile(options.cwd, loadedFiles),
  };
}

/** Human-readable stderr lines (one per finding) for a load result. Paths are display-sanitized. */
export function formatTrustedEnvReport(result: TrustedEnvResult): string[] {
  const lines: string[] = [];
  for (const { file, mode } of result.permissionWarnings) {
    const issues = [(mode & 0o020) !== 0 ? 'group-writable' : '', (mode & 0o044) !== 0 ? 'readable by others' : '']
      .filter(Boolean)
      .join(' and ');
    lines.push(
      `Warning: ${toDisplayText(file)} is ${issues} (mode ${octal(mode)}). Run: chmod 600 ${toDisplayText(file)}`,
    );
  }
  for (const { file, keys } of result.ignoredKeys) {
    lines.push(
      `Warning: ignored non-credential keys in ${toDisplayText(file)}: ${toDisplayText(keys.join(', '))}. ` +
        'Only provider API keys and MCP server credentials are loaded from env files; ' +
        'set base URLs and other settings in config.json or the shell environment.',
    );
  }
  if (result.ignoredCwdEnvFile !== undefined) {
    lines.push(
      `Note: ignoring ${toDisplayText(result.ignoredCwdEnvFile)}: IronCurtain does not read .env from the ` +
        `current directory. Put credentials in ${toDisplayText(result.homeEnvFile)} or pass ` +
        `${ENV_FILE_OPTION} <path> (or set ${ENV_FILE_ENV_VAR}).`,
    );
  }
  return lines;
}

/**
 * Entry-point bootstrap. Takes a leading `--env-file <path>` off `args`,
 * exports it as IRONCURTAIN_ENV_FILE (so child `ironcurtain` processes, such as
 * PTY sessions and an `--ensure-daemon` daemon, load the same file and treat it
 * as a protected path), loads the trusted credential files and prints the
 * report to stderr. On any error it prints one line and exits with status 1:
 * a credential file that cannot be trusted is never used, and the command does
 * not continue without the credentials the user expected. Returns the
 * remaining arguments.
 */
export function bootstrapTrustedEnv(args: readonly string[]): string[] {
  try {
    const { envFile, rest } = splitEnvFileOption(args);
    if (envFile !== undefined) process.env[ENV_FILE_ENV_VAR] = envFile;
    const result = loadTrustedEnv();
    for (const line of formatTrustedEnvReport(result)) process.stderr.write(`${line}\n`);
    return rest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${toDisplayText(message)}\n`);
    process.exit(1);
  }
}

/**
 * {@link bootstrapTrustedEnv} for `process.argv`, rewritten in place so the
 * many `process.argv.slice(...)` readers downstream never see `--env-file`.
 * Every entry point (src/cli.ts and the direct-run blocks of src/index.ts and
 * the pipeline commands) calls this before reading any credential.
 */
export function bootstrapTrustedEnvForProcess(): void {
  const rest = bootstrapTrustedEnv(process.argv.slice(2));
  process.argv.splice(2, process.argv.length - 2, ...rest);
}
