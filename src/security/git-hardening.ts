/**
 * Hardened execution of host `git` against repositories an agent can write.
 *
 * A repository inside a sandbox or a bind-mounted workspace carries
 * agent-controlled configuration that host git executes: `core.fsmonitor`,
 * hooks, `core.sshCommand`, credential helpers, `remote.<name>.uploadpack` over
 * a local transport, `ext::` URLs, gitfile redirects, and more. Every place
 * IronCurtain runs (or spawns something that runs) host git on such a
 * repository must use these helpers instead of a bare `execFile('git', ...)`.
 *
 * - {@link hardenedGitEnv} builds an environment whose command-scope config
 *   (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, which outranks
 *   repository, include and global config) pins every fixed-name key that runs
 *   a program, restricts transports, disables prompts, and re-adds the user's
 *   own trusted credential helpers. It works for third-party servers that
 *   build their own git argv, because it needs no `-c` flags.
 * - {@link runGit} runs git asynchronously in its own process group with a
 *   hard timeout, abort support and output caps; a timeout or abort kills the
 *   whole group (git, ssh, remote helpers, credential helpers).
 * - {@link inspectRepoConfig} statically parses a repository's git dir and
 *   config, without running git and without following includes, and reports
 *   what key overrides cannot neutralize.
 *
 * Residual risk that no environment override can remove, and that callers
 * must contain by other means (OS sandboxing, policy, a git dir the agent can
 * never write): driver-keyed configuration selected by repository content
 * (`filter.<driver>.clean/smudge/process`, `diff.<driver>.textconv/command`,
 * `merge.<driver>.driver` selected through `.gitattributes`), `diff.external`
 * (an empty override makes `git diff` fail rather than disabling it; pass
 * `--no-ext-diff`/`--no-textconv`), `remote.<name>.uploadpack`/`receivepack`
 * (they run locally only over the `file` transport, which is not allowed by
 * default), `tar.<format>.command` for a format other than the built-in
 * gzip ones (selected by `git archive --format` or the `-o` extension),
 * `trailer.<token>.cmd` (run by `--trailer` for a token the repository
 * defines), `core.worktree` and gitfile/`commondir` redirects, `include.path`
 * / `includeIf` content, `objects/info/alternates`, URL-scoped `http.<url>.*`
 * settings (git picks the most specific URL match, so a command-scope
 * `http.proxy` does not override them), `url.<base>.insteadOf` rewrites
 * to an allowed transport, and symbolic links inside the git dir (git
 * creates, rewrites and appends its files through them: refs, reflogs,
 * objects, `COMMIT_EDITMSG`). {@link inspectRepoConfig} flags each of these.
 *
 * Callers own `GIT_CEILING_DIRECTORIES`: pass `ceilingDirectories` so
 * discovery cannot climb out of the directory the agent was given.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  readdirSync,
  opendirSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Dir,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { readUntrustedRegularFile } from '../hardened-fs.js';
import { toDisplayText } from '../terminal/display-sanitize.js';

// ── Hardened environment ───────────────────────────────────────────────

/** Transports a hardened git may use. `ext` and `fd` are never allowed. */
export type GitTransportProtocol = 'https' | 'http' | 'ssh' | 'git' | 'file';

const KNOWN_PROTOCOLS: readonly GitTransportProtocol[] = ['https', 'http', 'ssh', 'git', 'file'];
const ALWAYS_DENIED_PROTOCOLS: readonly string[] = ['ext', 'fd'];

/** Default transport allowlist: authenticated, encrypted remotes only (no local paths or `file://`). */
export const DEFAULT_GIT_PROTOCOLS: readonly GitTransportProtocol[] = ['https', 'ssh'];

/** Disables every hook. Documented by git itself (`core.hooksPath=/dev/null`); nothing can be created under it. */
export const DISABLED_HOOKS_PATH = '/dev/null';

/** One config entry from the system or global scope. Keys are canonical (section and name lowercased). */
export interface TrustedGitConfigEntry {
  readonly scope: 'system' | 'global';
  readonly key: string;
  /** `null` for a value-less (boolean) entry. */
  readonly value: string | null;
}

/** The parts of the user's trusted (system and global) git config that the hardened env re-applies. */
export interface TrustedGitConfig {
  readonly entries: readonly TrustedGitConfigEntry[];
}

export interface HardenedGitEnvOptions {
  /** Environment to harden; treated as trusted host configuration. Default `process.env`. */
  readonly baseEnv?: NodeJS.ProcessEnv;
  /** Transports git may use (default {@link DEFAULT_GIT_PROTOCOLS}). */
  readonly allowedProtocols?: readonly GitTransportProtocol[];
  /** Absolute directories git must not search above (`GIT_CEILING_DIRECTORIES`), merged with any inherited ones. */
  readonly ceilingDirectories?: readonly string[];
  /** `core.hooksPath` (default {@link DISABLED_HOOKS_PATH}). Must be absolute and not agent-writable. */
  readonly hooksPath?: string;
  /**
   * SSH command for ssh transports; also exported as `GIT_SSH_COMMAND`, which
   * outranks every config value. Default: the trusted `core.sshCommand`, else
   * `ssh`; an inherited `GIT_SSH_COMMAND` is kept and still wins. An inherited
   * `GIT_SSH` is left in place but no longer takes effect, because git ranks
   * the pinned `core.sshCommand` above it: pass this option to keep such a
   * wrapper.
   */
  readonly sshCommand?: string;
  /**
   * Keep inherited `GIT_ASKPASS`/`SSH_ASKPASS` and the trusted `core.askPass`.
   * Default false: no askpass program and no Git Credential Manager GUI, so
   * nothing can block waiting for a human.
   */
  readonly allowAskPass?: boolean;
  /**
   * Extra command-scope entries appended last (they win), e.g.
   * `['http.lowSpeedLimit', '1000']`. Never pass agent-controlled keys or values.
   */
  readonly extraConfig?: readonly (readonly [key: string, value: string])[];
  /** Trusted config snapshot; default {@link readTrustedGitConfig} on `baseEnv`. */
  readonly trustedConfig?: TrustedGitConfig;
}

/** Variables that select a repository, index or object store, or inject config, from outside git. */
const REPOSITORY_SELECTION_VARIABLES: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_SHALLOW_FILE',
  'GIT_REPLACE_REF_BASE',
  'GIT_GRAFT_FILE',
  'GIT_CONFIG',
  // Applied after GIT_CONFIG_COUNT entries, so it would override the hardening.
  'GIT_CONFIG_PARAMETERS',
];

const ASKPASS_VARIABLES: readonly string[] = ['GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'];

/** Program keys pinned to the trusted value or git's own default. */
const PINNED_PROGRAM_DEFAULTS: readonly (readonly [key: string, fallback: string])[] = [
  ['gpg.program', 'gpg'],
  ['gpg.x509.program', 'gpgsm'],
  ['gpg.ssh.program', 'ssh-keygen'],
];

const TRUSTED_KEY_PATTERN =
  '^(credential\\..*helper|core\\.sshcommand|core\\.askpass|core\\.alternaterefscommand|gpg\\.program|gpg\\..*\\.program|gpg\\.ssh\\.defaultkeycommand)$';

function isCredentialHelperKey(key: string): boolean {
  return key === 'credential.helper' || (key.startsWith('credential.') && key.endsWith('.helper'));
}

/** Remove relative and empty PATH entries so no lookup can resolve inside the repository. */
function sanitizePath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value
    .split(delimiter)
    .filter((entry) => entry !== '' && isAbsolute(entry))
    .join(delimiter);
}

/**
 * Inherited command-scope config, validated the way git reads it. A malformed
 * set makes every git command fail ("unable to parse command-line config"),
 * so it is dropped rather than passed on.
 */
function takeInheritedCommandConfig(env: NodeJS.ProcessEnv): Array<readonly [string, string]> {
  const countText = env.GIT_CONFIG_COUNT;
  const entries: Array<readonly [string, string]> = [];
  let valid = countText !== undefined && /^[0-9]{1,4}$/u.test(countText);
  const count = valid ? Number(countText) : 0;
  for (let index = 0; index < count; index += 1) {
    const key = env[`GIT_CONFIG_KEY_${index}`];
    const value = env[`GIT_CONFIG_VALUE_${index}`];
    if (key === undefined || key === '' || value === undefined) valid = false;
    else entries.push([key, value]);
  }
  for (const name of Object.keys(env)) {
    if (name === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(?:KEY|VALUE)_[0-9]+$/u.test(name)) {
      Reflect.deleteProperty(env, name);
    }
  }
  return valid ? entries : [];
}

function scrubGitEnvironment(env: NodeJS.ProcessEnv): Array<readonly [string, string]> {
  const inherited = takeInheritedCommandConfig(env);
  for (const name of REPOSITORY_SELECTION_VARIABLES) Reflect.deleteProperty(env, name);
  const path = sanitizePath(env.PATH);
  if (path !== undefined) env.PATH = path;
  return inherited;
}

function assertNoNul(value: string, what: string): void {
  if (value.includes('\0')) throw new Error(`${what} must not contain NUL`);
}

function assertConfigKey(key: string): void {
  // section[.subsection].name, as git_config_parse_key accepts it.
  if (!/^[A-Za-z0-9-]+(?:\.[^\n\0]*)?\.[A-Za-z][A-Za-z0-9-]*$/u.test(key)) {
    throw new Error(`invalid git config key: ${JSON.stringify(key)}`);
  }
}

/**
 * Read the user's trusted (system and global, includes followed) git config
 * entries that the hardened env re-applies: credential helpers, ssh, askpass
 * and alternate-refs commands, signing programs and the ssh signing-key
 * command. Runs `git config` from `/` so no repository config is consulted,
 * with a scrubbed environment. Any failure (git missing, timeout, malformed
 * output) yields an empty snapshot, which fails closed: helpers are reset and
 * programs fall back to git's defaults.
 *
 * Conditional includes that depend on a repository (`includeIf "gitdir:..."`,
 * `onbranch:`, `hasconfig:`) do not match from `/`, so helpers configured only
 * inside them are not re-added.
 */
export function readTrustedGitConfig(options: { readonly baseEnv?: NodeJS.ProcessEnv } = {}): TrustedGitConfig {
  const result = readTrustedGitConfigEntries(TRUSTED_KEY_PATTERN, options);
  return { entries: result.ok ? result.entries : [] };
}

/**
 * {@link readTrustedGitConfig} without blocking the event loop, for
 * long-running processes (the daemon) that must stay responsive. Same
 * snapshot, same fail-closed behaviour: any failure (git missing, timeout,
 * abort, malformed output) yields an empty snapshot.
 */
export async function readTrustedGitConfigAsync(
  options: { readonly baseEnv?: NodeJS.ProcessEnv; readonly signal?: AbortSignal } = {},
): Promise<TrustedGitConfig> {
  try {
    const result = await runGit(trustedConfigArgs(TRUSTED_KEY_PATTERN), {
      cwd: '/',
      env: trustedConfigReaderEnv(options.baseEnv),
      timeoutMs: TRUSTED_CONFIG_TIMEOUT_MS,
      maxOutputBytes: TRUSTED_CONFIG_MAX_BYTES,
      signal: options.signal,
    });
    return { entries: parseTrustedConfigOutput(result.stdout) };
  } catch {
    return { entries: [] };
  }
}

/** Result of {@link readTrustedGitConfigEntries}: `ok: false` when git could not be run or failed. */
export type TrustedGitConfigRead =
  { readonly ok: true; readonly entries: readonly TrustedGitConfigEntry[] } | { readonly ok: false };

/**
 * Read the system and global git config entries (includes followed) whose
 * canonical key matches `keyPattern` (a POSIX extended regular expression, as
 * `git config --get-regexp` takes it), in the order git reads them. Runs
 * `git config` from `/` with a scrubbed environment, exactly like
 * {@link readTrustedGitConfig}, and has the same blind spot for conditional
 * includes. Unlike it, a failure (git missing, timeout, malformed output) is
 * reported as `ok: false` rather than as an empty snapshot, so a caller for
 * which "no entries" is not the safe reading can fail closed.
 */
export function readTrustedGitConfigEntries(
  keyPattern: string,
  options: { readonly baseEnv?: NodeJS.ProcessEnv } = {},
): TrustedGitConfigRead {
  const env = trustedConfigReaderEnv(options.baseEnv);
  let git: string;
  try {
    git = resolveGitExecutable(env.PATH);
  } catch {
    return { ok: false };
  }
  const result = spawnSync(git, trustedConfigArgs(keyPattern), {
    cwd: '/',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TRUSTED_CONFIG_TIMEOUT_MS,
    maxBuffer: TRUSTED_CONFIG_MAX_BYTES,
  });
  if (result.error !== undefined) return { ok: false };
  // `git config --get-regexp` exits 1, printing nothing, when no key matches.
  if (result.status === 1 && result.stdout.length === 0) return { ok: true, entries: [] };
  if (result.status !== 0) return { ok: false };
  return { ok: true, entries: parseTrustedConfigOutput(result.stdout.toString('utf8')) };
}

/** `git config` argv that lists the system and global entries whose key matches `keyPattern`, with their scopes. */
function trustedConfigArgs(keyPattern: string): readonly string[] {
  return ['config', '--show-scope', '--includes', '-z', '--get-regexp', keyPattern];
}
const TRUSTED_CONFIG_TIMEOUT_MS = 5_000;
const TRUSTED_CONFIG_MAX_BYTES = 1024 * 1024;

function trustedConfigReaderEnv(baseEnv: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(baseEnv ?? process.env) };
  scrubGitEnvironment(env);
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** Parse `git config --show-scope -z --get-regexp` output, keeping system and global entries only. */
function parseTrustedConfigOutput(stdout: string): TrustedGitConfigEntry[] {
  const tokens = stdout.split('\0');
  tokens.pop(); // trailing terminator
  const entries: TrustedGitConfigEntry[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const scope = tokens[index];
    if (scope !== 'system' && scope !== 'global') continue;
    const record = tokens[index + 1];
    const newline = record.indexOf('\n');
    const key = newline < 0 ? record : record.slice(0, newline);
    const value = newline < 0 ? null : record.slice(newline + 1);
    entries.push({ scope, key, value });
  }
  return entries;
}

function lastTrustedValue(config: TrustedGitConfig, key: string): string | undefined {
  let found: string | undefined;
  for (const entry of config.entries) {
    if (entry.key === key && entry.value !== null) found = entry.value;
  }
  return found;
}

/**
 * Build an environment for running host git on a repository an agent can
 * write. The returned object is a copy of `baseEnv` with:
 *
 * - command-scope overrides (outranking repository, include and global
 *   config): `core.fsmonitor=false`, `core.hooksPath` (default `/dev/null`),
 *   `core.pager=cat`, `core.editor=true`, `sequence.editor=true`,
 *   `safe.bareRepository=explicit`, `protocol.allow=never` with
 *   `protocol.<p>.allow=always` for each allowed transport and `never` for
 *   the rest, `credential.helper` reset to empty and then the trusted
 *   system/global helper entries re-added in their original order (including
 *   URL-scoped `credential.<url>.helper`), `core.sshCommand` and
 *   `core.askPass` from trusted config, `core.alternateRefsCommand` (run by
 *   fetch when the repository has `objects/info/alternates`) pinned to the
 *   trusted value or `true`, the built-in `git archive` gzip filters
 *   (`tar.tgz.command`, `tar.tar.gz.command`) pinned to `gzip -cn`,
 *   `commit/tag/push.gpgSign=false` and `tag.forceSignAnnotated=false`
 *   (otherwise `git tag <name> -m <msg>` signs),
 *   signing programs pinned to the trusted value or git's default,
 *   `gpg.ssh.defaultKeyCommand` pinned to the trusted value or `false`, and
 *   automatic maintenance disabled (`maintenance.auto=false`, `gc.auto=0`)
 *   and kept in the foreground if re-enabled (`maintenance.autoDetach=false`,
 *   `gc.autoDetach=false`), so it neither repacks an agent-controlled
 *   repository nor daemonizes out of the process group {@link runGit} kills;
 * - `GIT_ALLOW_PROTOCOL` (authoritative over all protocol config),
 *   `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `GIT_EDITOR=true`,
 *   `GIT_SEQUENCE_EDITOR=true`, an empty `GIT_PROXY_COMMAND` (unless
 *   inherited) so a repository's `core.gitProxy` never runs, and
 *   `GIT_CEILING_DIRECTORIES` when given;
 * - repository-selection variables (`GIT_DIR`, `GIT_WORK_TREE`,
 *   `GIT_INDEX_FILE`, ...) and `GIT_CONFIG_PARAMETERS` removed, askpass
 *   variables removed unless `allowAskPass`, and relative `PATH` entries
 *   dropped. Valid inherited `GIT_CONFIG_COUNT` entries are kept ahead of the
 *   overrides (so a sandbox wrapper may append its own after them).
 *
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` are deliberately left alone: the
 * attack lives in repository config, and nulling them would break identity and
 * credential helpers. The flip side: `HOME`, `XDG_CONFIG_HOME` and
 * `GIT_CONFIG_GLOBAL` in `baseEnv` must name the user's own configuration,
 * never a location the agent can write, because global config is both read by
 * git and replayed here as trusted.
 */
export function hardenedGitEnv(options: HardenedGitEnvOptions = {}): NodeJS.ProcessEnv {
  const baseEnv = options.baseEnv ?? process.env;
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const inherited = scrubGitEnvironment(env);
  const trusted = options.trustedConfig ?? readTrustedGitConfig({ baseEnv });
  const allowAskPass = options.allowAskPass === true;

  const protocols = [...new Set(options.allowedProtocols ?? DEFAULT_GIT_PROTOCOLS)];
  for (const protocol of protocols) {
    if (!KNOWN_PROTOCOLS.includes(protocol)) throw new Error(`unsupported git protocol: ${protocol}`);
  }
  const hooksPath = options.hooksPath ?? DISABLED_HOOKS_PATH;
  if (!isAbsolute(hooksPath)) throw new Error('hooksPath must be absolute');
  assertNoNul(hooksPath, 'hooksPath');
  if (options.sshCommand !== undefined) {
    if (options.sshCommand.trim() === '') throw new Error('sshCommand must not be empty');
    assertNoNul(options.sshCommand, 'sshCommand');
  }

  const overrides: Array<readonly [string, string]> = [
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', hooksPath],
    ['core.pager', 'cat'],
    ['core.editor', 'true'],
    ['sequence.editor', 'true'],
    ['safe.bareRepository', 'explicit'],
    // Only the selected repository is inspected. Never enter child
    // repositories implicitly; named submodule settings/layouts additionally
    // require per-call policy review because they can override these defaults.
    ['submodule.recurse', 'false'],
    ['fetch.recurseSubmodules', 'false'],
    ['push.recurseSubmodules', 'no'],
    ['diff.ignoreSubmodules', 'all'],
    ['status.submoduleSummary', 'false'],
    // Automatic maintenance after commit/fetch/merge would repack an
    // agent-controlled repository (the agent can force it with gc.auto=1) and
    // by default daemonizes (setsid), escaping runGit's process-group kill and
    // timeout. Host-side git never runs it; if a caller re-enables it through
    // extraConfig, it still stays in the foreground.
    ['maintenance.auto', 'false'],
    ['gc.auto', '0'],
    ['maintenance.autoDetach', 'false'],
    ['gc.autoDetach', 'false'],
    ['protocol.allow', 'never'],
  ];
  for (const protocol of KNOWN_PROTOCOLS) {
    overrides.push([`protocol.${protocol}.allow`, protocols.includes(protocol) ? 'always' : 'never']);
  }
  for (const protocol of ALWAYS_DENIED_PROTOCOLS) overrides.push([`protocol.${protocol}.allow`, 'never']);

  // An empty helper clears every helper collected so far, including
  // URL-scoped ones from repository config; the trusted entries are then
  // replayed in order, so their own resets and URL scoping keep working.
  overrides.push(['credential.helper', '']);
  for (const entry of trusted.entries) {
    if (isCredentialHelperKey(entry.key) && entry.value !== null) overrides.push([entry.key, entry.value]);
  }

  overrides.push(['core.sshCommand', options.sshCommand ?? lastTrustedValue(trusted, 'core.sshcommand') ?? 'ssh']);
  const askPass = allowAskPass ? (lastTrustedValue(trusted, 'core.askpass') ?? baseEnv.SSH_ASKPASS ?? '') : '';
  overrides.push(['core.askPass', askPass]);
  // `true` prints no refs, so alternates are simply not advertised as haves.
  overrides.push(['core.alternateRefsCommand', lastTrustedValue(trusted, 'core.alternaterefscommand') ?? 'true']);
  // `git archive --format=tgz` / `-o x.tar.gz` run these; `gzip -cn` was git's own default before 2.38.
  overrides.push(['tar.tgz.command', 'gzip -cn'], ['tar.tar.gz.command', 'gzip -cn']);

  overrides.push(
    ['commit.gpgSign', 'false'],
    ['tag.gpgSign', 'false'],
    ['tag.forceSignAnnotated', 'false'],
    ['push.gpgSign', 'false'],
  );
  const openpgp = lastTrustedValue(trusted, 'gpg.openpgp.program') ?? lastTrustedValue(trusted, 'gpg.program') ?? 'gpg';
  overrides.push(['gpg.openpgp.program', openpgp]);
  for (const [key, fallback] of PINNED_PROGRAM_DEFAULTS) {
    overrides.push([key, key === 'gpg.program' ? openpgp : (lastTrustedValue(trusted, key) ?? fallback)]);
  }
  // Runs when ssh signing has no user.signingKey; `false` fails the signature closed.
  overrides.push(['gpg.ssh.defaultKeyCommand', lastTrustedValue(trusted, 'gpg.ssh.defaultkeycommand') ?? 'false']);

  for (const [key, value] of options.extraConfig ?? []) {
    assertConfigKey(key);
    assertNoNul(value, `value of ${key}`);
    overrides.push([key, value]);
  }

  const entries = [...inherited, ...overrides];
  env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  env.GIT_ALLOW_PROTOCOL = protocols.join(':');
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  env.GIT_EDITOR = 'true';
  env.GIT_SEQUENCE_EDITOR = 'true';
  // An inherited (trusted) GIT_PROXY_COMMAND wins over config; an empty one
  // disables the repository's core.gitProxy for git:// remotes.
  env.GIT_PROXY_COMMAND ??= '';
  if (options.sshCommand !== undefined) env.GIT_SSH_COMMAND = options.sshCommand;
  if (!allowAskPass) {
    for (const name of ASKPASS_VARIABLES) Reflect.deleteProperty(env, name);
    env.GCM_INTERACTIVE = 'never';
  }

  if (options.ceilingDirectories !== undefined && options.ceilingDirectories.length > 0) {
    for (const directory of options.ceilingDirectories) {
      if (!isAbsolute(directory) || directory.includes(delimiter) || directory.includes('\0')) {
        throw new Error(`ceiling directory must be absolute and contain no '${delimiter}': ${directory}`);
      }
    }
    const inheritedCeilings = (env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter).filter((entry) => entry !== '');
    env.GIT_CEILING_DIRECTORIES = [...new Set([...inheritedCeilings, ...options.ceilingDirectories])].join(delimiter);
  }
  return env;
}

// ── runGit ─────────────────────────────────────────────────────────────

export type GitCommandErrorCode =
  'GIT_NOT_FOUND' | 'GIT_SPAWN_FAILED' | 'GIT_TIMEOUT' | 'GIT_ABORTED' | 'GIT_OUTPUT_TOO_LARGE' | 'GIT_FAILED';

/** Failure of {@link runGit}. Catch on `code`. `stderr` can carry remote, attacker-chosen text. */
export class GitCommandError extends Error {
  readonly code: GitCommandErrorCode;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    code: GitCommandErrorCode,
    message: string,
    details: {
      readonly exitCode?: number | null;
      readonly signal?: NodeJS.Signals | null;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'GitCommandError';
    this.code = code;
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stdout = details.stdout ?? '';
    this.stderr = details.stderr ?? '';
  }
}

export interface RunGitOptions {
  /** Working directory. Required: never inherit the daemon's cwd implicitly. */
  readonly cwd: string;
  /** Environment; default `hardenedGitEnv()`. Extend a hardened env for per-call variables such as `GIT_INDEX_FILE`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Wall-clock limit; on expiry the whole process group is killed (default 120 s). */
  readonly timeoutMs?: number;
  /** Aborting kills the whole process group. */
  readonly signal?: AbortSignal;
  /** Per-stream output cap in bytes; exceeding it kills the process group (default 16 MiB). */
  readonly maxOutputBytes?: number;
  /** Resolve with a non-zero `exitCode` instead of throwing `GIT_FAILED`. */
  readonly allowNonZeroExit?: boolean;
  /** Bytes written to git's stdin, which is then closed (e.g. for `update-ref --stdin`). Default: stdin closed. */
  readonly input?: string | Uint8Array;
}

export interface RunGitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Largest delay `setTimeout` honours. */
const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** How long to wait for stdio to close after git exits (a helper it spawned may hold the pipes). */
const CLOSE_GRACE_MS = 1_000;
/** Backstop after a kill, in case the exit event is never delivered. */
const KILL_GRACE_MS = 5_000;

const gitExecutableCache = new Map<string, string>();

/**
 * Resolve `git` to an absolute path using only absolute `PATH` entries, so a
 * relative entry (`.`) can never pick up a binary planted in the repository.
 */
function resolveGitExecutable(pathValue: string | undefined): string {
  const key = pathValue ?? '';
  const cached = gitExecutableCache.get(key);
  if (cached !== undefined) return cached;
  for (const entry of key.split(delimiter)) {
    if (entry === '' || !isAbsolute(entry)) continue;
    const candidate = join(entry, 'git');
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    gitExecutableCache.set(key, candidate);
    return candidate;
  }
  throw new GitCommandError('GIT_NOT_FOUND', 'git executable not found on an absolute PATH entry');
}

/** Global options that take their value as the next argument. */
const OPTIONS_WITH_SEPARATE_VALUE: ReadonlySet<string> = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--exec-path',
]);

/** The git subcommand, for messages: never the full argv, which can hold URLs with credentials. */
function describeSubcommand(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (OPTIONS_WITH_SEPARATE_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith('-')) return toDisplayText(arg, { maxLength: 40 });
  }
  return '(no subcommand)';
}

function stderrExcerpt(stderr: string): string {
  const last = stderr
    .split('\n')
    .filter((line) => line.trim() !== '')
    .at(-1);
  return last === undefined ? '' : `: ${toDisplayText(last.trim(), { maxLength: 300 })}`;
}

/**
 * Run host git asynchronously with argv (never a shell), `stdin` closed (or
 * fed `input` and then closed), in a new process group (detached; this also
 * drops the controlling terminal, so `/dev/tty` prompts fail instead of
 * hanging). A timeout, an abort or an output overflow SIGKILLs the whole
 * group, so ssh, remote helpers and credential helpers cannot outlive the
 * call. The default environment is {@link hardenedGitEnv}. Throws
 * {@link GitCommandError}; a non-zero exit is `GIT_FAILED` unless
 * `allowNonZeroExit`.
 */
export async function runGit(args: readonly string[], options: RunGitOptions): Promise<RunGitResult> {
  const env = options.env ?? hardenedGitEnv();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  // setTimeout turns a delay above 2^31-1 ms into 1 ms, which would time out at once.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new RangeError(`timeoutMs must be within 1-${MAX_TIMER_MS}`);
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
    throw new RangeError('maxOutputBytes must be a non-negative safe integer');
  }
  const subcommand = describeSubcommand(args);
  if (options.signal?.aborted === true) throw new GitCommandError('GIT_ABORTED', `git ${subcommand} aborted`);
  const git = resolveGitExecutable(env.PATH);
  const useProcessGroup = process.platform !== 'win32';

  return new Promise<RunGitResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(git, [...args], {
        cwd: options.cwd,
        env,
        detached: useProcessGroup,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      rejectPromise(new GitCommandError('GIT_SPAWN_FAILED', `cannot start git ${subcommand}`, { cause: error }));
      return;
    }
    if (options.input !== undefined && child.stdin !== null) {
      // git may exit before reading everything (EPIPE); its exit status reports the failure.
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let failure: { code: GitCommandErrorCode; message: string; cause?: unknown } | undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let graceTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const killGroup = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (useProcessGroup) process.kill(-pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // The group is already gone.
      }
    };

    const fail = (code: GitCommandErrorCode, message: string, cause?: unknown): void => {
      if (settled || failure !== undefined) return;
      failure = { code, message, cause };
      killGroup();
      killTimer = setTimeout(settle, KILL_GRACE_MS);
    };
    const onAbort = (): void => fail('GIT_ABORTED', `git ${subcommand} aborted`);
    const timeoutTimer = setTimeout(
      () => fail('GIT_TIMEOUT', `git ${subcommand} timed out after ${timeoutMs} ms`),
      timeoutMs,
    );

    function settle(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (failure !== undefined) {
        rejectPromise(
          new GitCommandError(failure.code, failure.message, {
            exitCode,
            signal: exitSignal,
            stdout,
            stderr,
            cause: failure.cause,
          }),
        );
        return;
      }
      if (exitCode === 0 || (options.allowNonZeroExit === true && exitCode !== null)) {
        resolvePromise({ exitCode, stdout, stderr });
        return;
      }
      const status = exitCode === null ? `was killed by ${exitSignal ?? 'a signal'}` : `exited with code ${exitCode}`;
      rejectPromise(
        new GitCommandError('GIT_FAILED', `git ${subcommand} ${status}${stderrExcerpt(stderr)}`, {
          exitCode,
          signal: exitSignal,
          stdout,
          stderr,
        }),
      );
    }

    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        fail('GIT_OUTPUT_TOO_LARGE', `git ${subcommand} wrote more than ${maxOutputBytes} bytes to stdout`);
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        fail('GIT_OUTPUT_TOO_LARGE', `git ${subcommand} wrote more than ${maxOutputBytes} bytes to stderr`);
        return;
      }
      stderrChunks.push(chunk);
    });
    child.once('error', (error) => {
      // Only a process that never started settles here; a running one is
      // settled by its exit/close (or the kill backstop).
      if (child.pid !== undefined) return;
      failure ??= { code: 'GIT_SPAWN_FAILED', message: `cannot start git ${subcommand}`, cause: error };
      settle();
    });
    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      graceTimer = setTimeout(settle, CLOSE_GRACE_MS);
    });
    child.once('close', settle);
  });
}

// ── inspectRepoConfig ──────────────────────────────────────────────────

export type RepoConfigFindingKind =
  /** Submodule metadata/configuration names child repositories not inspected here. */
  | 'submodule'
  /** `.git` is a symlink: git follows it to another directory. */
  | 'git-dir-symlink'
  /** `.git` is a gitfile (`gitdir: <path>`) redirecting to another git dir. */
  | 'gitfile'
  /** The git dir has a `commondir` file redirecting config, refs and objects. */
  | 'commondir'
  /** `objects/info/alternates` borrows objects from other repositories. */
  | 'alternates'
  /** `core.worktree` points the work tree somewhere else. */
  | 'worktree'
  /** `include.path` / `includeIf.<condition>.path` pulls in another config file. */
  | 'include'
  /** A filter/diff/merge driver or `diff.external` that runs a program. */
  | 'driver'
  /** Another key that names a program to run (hooks path, pager, editor, ssh, askpass, helpers, aliases, ...). */
  | 'command'
  /** A key that redirects or intercepts network traffic (`url.*.insteadOf`, proxies, TLS trust, extra headers). */
  | 'network'
  /** A non-sample entry in the hooks directory (or a symlinked hooks directory). */
  | 'hook'
  /**
   * A symbolic link inside the git dir or common dir (an entry such as
   * `logs`, `refs`, `objects`, `HEAD`, `index` or `COMMIT_EDITMSG`, one
   * anywhere below `refs/`, `logs/`, `objects/info`, `objects/pack` and the
   * other state directories git writes to, or one directly in `objects/`)
   * whose real path is not inside `followRedirectsWithin` (any link when that
   * is unset): git creates, rewrites and appends ref, object, commit-graph,
   * reflog and message files through it.
   */
  | 'internal-symlink'
  /**
   * A file git would read could not be read safely or parsed (symlink, FIFO,
   * too large, syntax error), or a git dir directory could not be listed or
   * walked to the end (detail {@link GIT_DIR_WALK_LIMIT_DETAIL}).
   */
  | 'unreadable';

export interface RepoConfigFinding {
  readonly kind: RepoConfigFindingKind;
  /** The file (or directory) the finding is about. */
  readonly file: string;
  /**
   * Config key as git names it (section and name lowercased, subsection as
   * written and possibly empty, so `[filter ""]` gives `filter..clean`), for
   * config findings.
   */
  readonly key?: string;
  /** The raw value. Agent-controlled: sanitize before display. */
  readonly value?: string;
  /** For path-valued findings, the path it resolves to (not canonicalized; may not exist). */
  readonly resolvedPath?: string;
  /** 1-based line in `file`, for config findings. */
  readonly line?: number;
  readonly detail?: string;
}

export interface RepoConfigInspection {
  /** Directory containing the `.git` entry that was found, if any. */
  readonly repoRoot?: string;
  /** The git dir that was inspected: `<repoRoot>/.git`, or the real path of a followed redirect. */
  readonly gitDir?: string;
  /** The common dir whose `config` was parsed: `gitDir`, or the real path of a followed `commondir`. */
  readonly commonDir?: string;
  readonly findings: readonly RepoConfigFinding[];
}

export interface InspectRepoConfigOptions {
  /** Stop the upward search for `.git` at this directory (inclusive). Default: the filesystem root. */
  readonly stopAt?: string;
  /**
   * Redirects (`.git` symlink, gitfile, `commondir`) are followed to inspect
   * their target only when its real path is inside this directory; otherwise
   * they are reported and the target is never read. Default: never follow.
   */
  readonly followRedirectsWithin?: string;
  /** Cap on each config file (default 1 MiB); larger files are reported `unreadable`. */
  readonly maxConfigBytes?: number;
  /**
   * List the hooks directory and report its entries as `hook` findings
   * (default true). A caller that disables hooks some other way (the
   * hardened environment's `core.hooksPath`) and runs this on every call can
   * pass false, so a hooks directory the agent filled with entries costs
   * nothing.
   */
  readonly inspectHooks?: boolean;
  /**
   * Cap on the directory entries examined for `internal-symlink` findings
   * (the git dir's and common dir's own entries, `objects/`, and everything
   * below `refs/`, `logs/`, `objects/info`, `objects/pack` and git's state
   * directories; default 50,000, which a repository with tens of thousands
   * of loose refs and reflogs stays within and which takes tens of
   * milliseconds to walk). Reaching it reports `unreadable` with
   * {@link GIT_DIR_WALK_LIMIT_DETAIL}, so a git dir the agent filled with
   * entries is escalated rather than walked at length.
   */
  readonly maxGitDirEntries?: number;
}

/** One variable of a parsed git config file, named the way git names it. */
export interface GitConfigEntry {
  /** Section, lowercased. */
  readonly section: string;
  /** Subsection as written (possibly empty, as in `[filter ""]`); undefined when the variable has none. */
  readonly subsection: string | undefined;
  /** Variable name, lowercased. */
  readonly name: string;
  /** Canonical key: `section.subsection.name`, or `section.name`. */
  readonly key: string;
  /** The value; `null` for a value-less (implicit boolean) entry. Agent-controlled in repository config. */
  readonly value: string | null;
  /** 1-based line in the file. */
  readonly line: number;
}

/** Result of {@link parseGitConfigBytes}. */
export interface ParsedGitConfigFile {
  /** Entries in file order, up to the first syntax error. Includes are never followed. */
  readonly entries: readonly GitConfigEntry[];
  /** 1-based line of the first syntax error (git refuses such a file); undefined when the whole file parsed. */
  readonly syntaxErrorLine?: number;
}

type ParsedConfig =
  | { readonly ok: true; readonly entries: readonly GitConfigEntry[] }
  | { readonly ok: false; readonly entries: readonly GitConfigEntry[]; readonly line: number };

const isGitSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isGitAlpha = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isGitKeyChar = (c: string): boolean => isGitAlpha(c) || (c >= '0' && c <= '9') || c === '-';

/**
 * Parse git config text the way git's own parser does (config.c:
 * `git_parse_source`), so a crafted file cannot hide a key from this check
 * while git still honours it. The input is the raw file decoded as latin1
 * (one char per byte, as git reads bytes); values are re-decoded as UTF-8.
 * Parsing stops at the first syntax error, where git itself refuses the file.
 */
function parseGitConfig(raw: string): ParsedConfig {
  let position = 0;
  let line = 1;
  let reachedEnd = false;
  /** True once `next` has run past the end (git's `cs->eof`). A function, so it is never narrowed. */
  const eof = (): boolean => reachedEnd;

  const next = (): string => {
    if (position >= raw.length) {
      reachedEnd = true;
      return '\n';
    }
    let c = raw[position++];
    if (c === '\r' && raw[position] === '\n') c = raw[position++];
    if (c === '\n') line += 1;
    return c;
  };

  const entries: GitConfigEntry[] = [];
  const fail = (): ParsedConfig => ({ ok: false, entries, line });

  // Skip a UTF-8 byte order mark; a partial one is a syntax error.
  const bom = 'ï»¿';
  if (raw.startsWith(bom)) position = bom.length;
  else if (raw.length > 0 && raw[0] === bom[0]) return fail();

  let sectionVar = '';
  let comment = false;
  for (;;) {
    const c = next();
    if (c === '\n') {
      if (eof()) return { ok: true, entries };
      comment = false;
      continue;
    }
    if (comment || isGitSpace(c)) continue;
    if (c === '#' || c === ';') {
      comment = true;
      continue;
    }
    if (c === '[') {
      const header = parseSectionHeader();
      if (header === undefined || header === '') return fail();
      sectionVar = header;
      continue;
    }
    if (!isGitAlpha(c)) return fail();
    const entryLine = line;
    let name = c.toLowerCase();
    let d = next();
    while (!eof() && isGitKeyChar(d)) {
      name += d.toLowerCase();
      d = next();
    }
    while (d === ' ' || d === '\t') d = next();
    let value: string | null = null;
    if (d !== '\n') {
      if (d !== '=') return fail();
      const parsed = parseValue();
      if (parsed === undefined) return fail();
      value = parsed;
    }
    entries.push(makeEntry(sectionVar, name, value, entryLine));
  }

  function parseSectionHeader(): string | undefined {
    let name = '';
    for (;;) {
      const c = next();
      if (eof()) return undefined;
      if (c === ']') return name;
      if (isGitSpace(c)) return parseExtendedHeader(name, c);
      if (!isGitKeyChar(c) && c !== '.') return undefined;
      name += c.toLowerCase();
    }
  }

  function parseExtendedHeader(base: string, first: string): string | undefined {
    let c = first;
    do {
      if (c === '\n') return undefined;
      c = next();
    } while (isGitSpace(c));
    if (c !== '"') return undefined;
    let subsection = '';
    for (;;) {
      let d = next();
      if (d === '\n') return undefined;
      if (d === '"') break;
      if (d === '\\') {
        d = next();
        if (d === '\n') return undefined;
      }
      subsection += d;
    }
    if (next() !== ']') return undefined;
    // A NUL marker (a base never contains one) separates base and subsection; see makeEntry.
    return `${base}\u0000${subsection}`;
  }

  function parseValue(): string | undefined {
    let quote = false;
    let inComment = false;
    let value = '';
    let trimLength = 0;
    for (;;) {
      let c = next();
      if (c === '\n') {
        if (quote) return undefined;
        return trimLength > 0 ? value.slice(0, trimLength) : value;
      }
      if (inComment) continue;
      if (isGitSpace(c) && !quote) {
        if (trimLength === 0) trimLength = value.length;
        if (value.length > 0) value += c;
        continue;
      }
      if (!quote && (c === ';' || c === '#')) {
        inComment = true;
        continue;
      }
      trimLength = 0;
      if (c === '\\') {
        c = next();
        if (c === '\n') continue;
        if (c === 't') c = '\t';
        else if (c === 'b') c = '\b';
        else if (c === 'n') c = '\n';
        else if (c !== '\\' && c !== '"') return undefined;
        value += c;
        continue;
      }
      if (c === '"') {
        quote = !quote;
        continue;
      }
      value += c;
    }
  }
}

function decodeLatin1(text: string): string {
  return Buffer.from(text, 'latin1').toString('utf8');
}

/**
 * Name an entry the way git does. Git keeps one variable string,
 * `<header>.<name>`, where an extended header `[base "sub"]` contributes
 * `base.sub` and the deprecated `[base.sub]` form is lowercased whole; every
 * consumer then splits that string at its first and its last dot (config.c
 * `parse_config_key`). So `[filter.a "b"]` defines filter driver `a.b`, just
 * like `[filter "a.b"]`, and `[filter ""]` defines the driver with the empty
 * name (selected by `filter=` in `.gitattributes`). `subsection` is undefined
 * only when the variable has no middle part at all; it can be empty.
 */
function makeEntry(sectionVar: string, name: string, rawValue: string | null, line: number): GitConfigEntry {
  const separator = sectionVar.indexOf('\u0000');
  const header = separator < 0 ? sectionVar : `${sectionVar.slice(0, separator)}.${sectionVar.slice(separator + 1)}`;
  const variable = `${header}.${name}`;
  const firstDot = variable.indexOf('.');
  const lastDot = variable.lastIndexOf('.');
  const section = variable.slice(0, firstDot);
  const subsection = lastDot > firstDot ? decodeLatin1(variable.slice(firstDot + 1, lastDot)) : undefined;
  const key = subsection === undefined ? `${section}.${name}` : `${section}.${subsection}.${name}`;
  return { section, subsection, name, key, value: rawValue === null ? null : decodeLatin1(rawValue), line };
}

function isGitBooleanValue(value: string | null): boolean {
  return value === null || ['true', 'yes', 'on', '1', 'false', 'no', 'off', '0', ''].includes(value.toLowerCase());
}

function isGitFalse(value: string | null): boolean {
  return value !== null && ['false', 'no', 'off', '0', ''].includes(value.toLowerCase());
}

interface KeyRule {
  readonly kind: RepoConfigFindingKind;
  readonly section: string;
  /** `none`: no subsection; `required`: a subsection, possibly empty (`[filter ""]`); `any`: either. */
  readonly subsection: 'none' | 'required' | 'any';
  /** Lowercased names, or `*` for every name. */
  readonly names: readonly string[] | '*';
  readonly when?: (value: string | null) => boolean;
}

const startsWithBang = (value: string | null): boolean => value?.startsWith('!') === true;

const KEY_RULES: readonly KeyRule[] = [
  { kind: 'submodule', section: 'submodule', subsection: 'required', names: '*' },
  { kind: 'worktree', section: 'core', subsection: 'none', names: ['worktree'] },
  { kind: 'include', section: 'include', subsection: 'none', names: ['path'] },
  { kind: 'include', section: 'includeif', subsection: 'required', names: ['path'] },
  { kind: 'driver', section: 'filter', subsection: 'required', names: ['clean', 'smudge', 'process'] },
  { kind: 'driver', section: 'diff', subsection: 'required', names: ['command', 'textconv'] },
  { kind: 'driver', section: 'diff', subsection: 'none', names: ['external'] },
  { kind: 'driver', section: 'merge', subsection: 'required', names: ['driver'] },
  {
    kind: 'command',
    section: 'core',
    subsection: 'none',
    names: ['fsmonitor'],
    when: (value) => !isGitBooleanValue(value),
  },
  {
    kind: 'command',
    section: 'core',
    subsection: 'none',
    names: ['hookspath', 'pager', 'editor', 'sshcommand', 'askpass', 'gitproxy', 'alternaterefscommand'],
  },
  { kind: 'command', section: 'sequence', subsection: 'none', names: ['editor'] },
  { kind: 'command', section: 'credential', subsection: 'any', names: ['helper'], when: (value) => value !== '' },
  { kind: 'command', section: 'gpg', subsection: 'any', names: ['program'] },
  { kind: 'command', section: 'gpg', subsection: 'required', names: ['defaultkeycommand'] },
  { kind: 'command', section: 'remote', subsection: 'required', names: ['uploadpack', 'receivepack', 'vcs'] },
  { kind: 'command', section: 'pager', subsection: 'none', names: '*', when: (value) => !isGitBooleanValue(value) },
  { kind: 'command', section: 'alias', subsection: 'any', names: '*', when: startsWithBang },
  { kind: 'command', section: 'submodule', subsection: 'required', names: ['update'], when: startsWithBang },
  { kind: 'command', section: 'difftool', subsection: 'required', names: ['cmd', 'path'] },
  { kind: 'command', section: 'mergetool', subsection: 'required', names: ['cmd', 'path'] },
  { kind: 'command', section: 'man', subsection: 'required', names: ['cmd', 'path'] },
  { kind: 'command', section: 'browser', subsection: 'required', names: ['cmd', 'path'] },
  {
    kind: 'command',
    section: 'sendemail',
    subsection: 'any',
    names: ['smtpserver', 'sendmailcmd', 'tocmd', 'cccmd', 'headercmd'],
  },
  { kind: 'command', section: 'uploadpack', subsection: 'none', names: ['packobjectshook'] },
  { kind: 'command', section: 'hook', subsection: 'required', names: '*' },
  { kind: 'command', section: 'tar', subsection: 'required', names: ['command'] },
  { kind: 'command', section: 'trailer', subsection: 'required', names: ['cmd', 'command'] },
  { kind: 'network', section: 'url', subsection: 'required', names: ['insteadof', 'pushinsteadof'] },
  {
    kind: 'network',
    section: 'http',
    subsection: 'any',
    names: [
      'proxy',
      'sslcainfo',
      'sslcapath',
      'sslcert',
      'sslkey',
      'extraheader',
      'cookiefile',
      'proxysslcert',
      'proxysslkey',
      'proxysslcainfo',
      'curloptresolve',
    ],
  },
  { kind: 'network', section: 'http', subsection: 'any', names: ['sslverify'], when: isGitFalse },
  { kind: 'network', section: 'remote', subsection: 'required', names: ['proxy'] },
];

function matchRule(entry: GitConfigEntry): KeyRule | undefined {
  return KEY_RULES.find((rule) => {
    if (rule.section !== entry.section) return false;
    const hasSubsection = entry.subsection !== undefined;
    if (rule.subsection === 'none' && hasSubsection) return false;
    if (rule.subsection === 'required' && !hasSubsection) return false;
    if (rule.names !== '*' && !rule.names.includes(entry.name)) return false;
    return rule.when === undefined || rule.when(entry.value);
  });
}

/**
 * Parse the raw bytes of a git config file with the same git-faithful parser
 * {@link inspectRepoConfig} uses. Pure: no file access, and `include.path` /
 * `includeIf.*.path` entries are returned as ordinary entries, never followed.
 */
export function parseGitConfigBytes(bytes: Uint8Array): ParsedGitConfigFile {
  const parsed = parseGitConfig(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1'));
  return parsed.ok ? { entries: parsed.entries } : { entries: parsed.entries, syntaxErrorLine: parsed.line };
}

/**
 * The {@link RepoConfigFindingKind} that {@link inspectRepoConfig} reports for
 * this entry (`include`, `network`, `command`, ...), or undefined when the
 * entry is not one it flags.
 */
export function classifyGitConfigEntry(entry: GitConfigEntry): RepoConfigFindingKind | undefined {
  return matchRule(entry)?.kind;
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

/**
 * Resolve a path-valued setting against `base`. Git expands `~` only where it
 * interpolates paths (`include.path`); a gitfile, `commondir` or
 * `core.worktree` value starting with `~` is a relative path to git.
 */
function resolveAgainst(base: string, value: string, expandTilde = false): string {
  const expanded = expandTilde ? expandHome(value) : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

/** The real path of `path` when it exists and lies inside `root`; otherwise undefined (never throws). */
function realPathWithin(path: string, root: string | undefined): string | undefined {
  return realPathInside(path, realRootOf(root));
}

/** The real path of `root`, or undefined when it is unset or cannot be resolved (never throws). */
function realRootOf(root: string | undefined): string | undefined {
  if (root === undefined) return undefined;
  try {
    return realpathSync(root);
  } catch {
    return undefined;
  }
}

/** The real path of `path` when it exists and lies inside the real path `realRoot`; otherwise undefined (never throws). */
function realPathInside(path: string, realRoot: string | undefined): string | undefined {
  if (realRoot === undefined) return undefined;
  try {
    const realPath = realpathSync(path);
    const rel = relative(realRoot, realPath);
    const inside = rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
    return inside ? realPath : undefined;
  } catch {
    return undefined;
  }
}

function tryLstat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function tryStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function tryReadlink(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'IO_ERROR';
}

/** Read a small git control file (gitfile, commondir) or report it unreadable. */
function readControlFile(path: string, findings: RepoConfigFinding[], maxBytes: number): string | undefined {
  try {
    return readUntrustedRegularFile(path, { maxBytes }).bytes.toString('utf8');
  } catch (error) {
    findings.push({ kind: 'unreadable', file: path, detail: `cannot read safely (${errorCode(error)})` });
    return undefined;
  }
}

/** Git strips only trailing CR/LF from gitfile and commondir contents (setup.c), never other whitespace. */
function stripTrailingNewlines(text: string): string {
  return text.replace(/[\r\n]+$/u, '');
}

function inspectConfigFile(path: string, gitDir: string, findings: RepoConfigFinding[], maxConfigBytes: number): void {
  if (tryLstat(path) === undefined) return;
  let text: string;
  try {
    text = readUntrustedRegularFile(path, { maxBytes: maxConfigBytes }).bytes.toString('latin1');
  } catch (error) {
    findings.push({ kind: 'unreadable', file: path, detail: `cannot read safely (${errorCode(error)})` });
    return;
  }
  const parsed = parseGitConfig(text);
  for (const entry of parsed.entries) {
    const rule = matchRule(entry);
    if (rule === undefined) continue;
    const finding: RepoConfigFinding = {
      kind: rule.kind,
      file: path,
      key: entry.key,
      value: entry.value ?? undefined,
      line: entry.line,
    };
    if (entry.value !== null && (rule.kind === 'worktree' || rule.kind === 'include')) {
      // core.worktree is relative to the git dir; include paths to the including file.
      const base = rule.kind === 'worktree' ? gitDir : dirname(path);
      findings.push({ ...finding, resolvedPath: resolveAgainst(base, entry.value, rule.kind === 'include') });
    } else {
      findings.push(finding);
    }
  }
  if (!parsed.ok) {
    findings.push({ kind: 'unreadable', file: path, line: parsed.line, detail: 'git config syntax error' });
  }
}

function inspectHooks(commonDir: string, findings: RepoConfigFinding[]): void {
  const hooksDir = join(commonDir, 'hooks');
  const stats = tryLstat(hooksDir);
  if (stats === undefined) return;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    findings.push({ kind: 'hook', file: hooksDir, detail: 'hooks directory is not a real directory' });
    return;
  }
  let names: string[];
  try {
    names = readdirSync(hooksDir);
  } catch {
    findings.push({ kind: 'unreadable', file: hooksDir, detail: 'cannot list hooks directory' });
    return;
  }
  const MAX_HOOK_FINDINGS = 256;
  let reported = 0;
  for (const name of names.sort()) {
    if (name.endsWith('.sample')) continue;
    if (reported === MAX_HOOK_FINDINGS) {
      findings.push({ kind: 'hook', file: hooksDir, detail: 'more hooks not listed' });
      break;
    }
    findings.push({ kind: 'hook', file: join(hooksDir, name) });
    reported += 1;
  }
}

/** `detail` of the `unreadable` finding for a git dir walk that reached its entry or depth cap. */
export const GIT_DIR_WALK_LIMIT_DETAIL = 'too many entries to inspect';

const DEFAULT_MAX_GIT_DIR_ENTRIES = 50_000;

/** Deepest directory below a git dir that is listed (a ref name may have many components). */
const MAX_GIT_DIR_DEPTH = 64;

/**
 * Git dir entries other checks cover: config files are read without
 * following a link (one is reported `unreadable`), `commondir` is a
 * redirect, and hooks are listed by {@link inspectHooks} (callers that skip
 * that disable hooks in the environment).
 */
const SEPARATELY_INSPECTED_GIT_DIR_ENTRIES: ReadonlySet<string> = new Set([
  'config',
  'config.worktree',
  'commondir',
  'hooks',
]);

/**
 * How a directory of the walk is listed: 'git-dir', a git dir's own entries;
 * 'objects', an object store's own entries; 'tree', every entry to any depth.
 * The first two queue only their named subdirectories
 * ({@link NAMED_GIT_DIR_SUBDIRECTORIES}).
 */
type GitDirListingScope = 'git-dir' | 'objects' | 'tree';

/**
 * The subdirectories walked below a git dir and below its `objects/`, and
 * how. Walked to any depth ('tree'): `refs/` (a file per ref) and `logs/` (a
 * reflog per ref, whose lines carry commit subjects), the small directories
 * git keeps state in and writes files to (`info`, `worktrees`, the rebase,
 * cherry-pick and `am` state of `rebase-merge`, `rebase-apply` and
 * `sequencer`, which hold commit messages and patches, and rerere's
 * `rr-cache`), and `objects/info` and `objects/pack`, where git rewrites the
 * commit-graph, its chain file and the multi-pack-index through a link at
 * their name (`fetch.writeCommitGraph`, which repository config can set).
 * `objects/` itself is listed one level ('objects'): git creates loose
 * objects in its fan-out directories, which are too many to walk on every
 * call. Every other entry of the git dir, `modules` (submodule git dirs) and
 * `lfs` (git-lfs objects) among them, is checked itself but not walked.
 *
 * Each is looked up by its path, as git opens it, never by matching the name
 * of a listed entry: on a case-insensitive filesystem (the macOS default)
 * git opens a `.git/LOGS` or `.git/Refs` directory as `logs` or `refs`.
 */
const NAMED_GIT_DIR_SUBDIRECTORIES: Readonly<
  Record<Exclude<GitDirListingScope, 'tree'>, ReadonlyMap<string, GitDirListingScope>>
> = {
  'git-dir': new Map<string, GitDirListingScope>([
    ['refs', 'tree'],
    ['logs', 'tree'],
    ['info', 'tree'],
    ['worktrees', 'tree'],
    ['rebase-merge', 'tree'],
    ['rebase-apply', 'tree'],
    ['sequencer', 'tree'],
    ['rr-cache', 'tree'],
    ['objects', 'objects'],
  ]),
  objects: new Map<string, GitDirListingScope>([
    ['info', 'tree'],
    ['pack', 'tree'],
  ]),
};

interface PendingGitDirListing {
  readonly path: string;
  readonly scope: GitDirListingScope;
  readonly depth: number;
}

/**
 * Report a symbolic link git would create, rewrite or append files through
 * (see the `internal-symlink` kind) in `gitDirs` (the git dir and, when it
 * differs, the common dir), unless its real path lies inside `followWithin`.
 * A link that resolves inside is followed: its target is listed in its
 * place, so a chain of links cannot lead out unseen. Only directory entries
 * are examined (no file is opened); a directory that cannot be listed, and a
 * walk that reaches `maxEntries` or {@link MAX_GIT_DIR_DEPTH}, are reported
 * `unreadable`.
 */
function inspectGitDirLinks(
  gitDirs: readonly string[],
  followWithin: string | undefined,
  maxEntries: number,
  findings: RepoConfigFinding[],
): void {
  const walk: GitDirWalk = {
    realRoot: realRootOf(followWithin),
    remaining: maxEntries,
    pending: [...gitDirs].reverse().map((path) => ({ path, scope: 'git-dir', depth: 0 })),
    findings,
  };
  for (let next = walk.pending.pop(); next !== undefined; next = walk.pending.pop()) {
    if (!inspectGitDirListing(next, walk)) return;
  }
}

interface GitDirWalk {
  /** Real path of `followRedirectsWithin`; undefined: no link may stay. */
  readonly realRoot: string | undefined;
  /** Entries left before the walk stops. */
  remaining: number;
  readonly pending: PendingGitDirListing[];
  readonly findings: RepoConfigFinding[];
}

/**
 * Lists one directory of {@link inspectGitDirLinks}, entry by entry (an
 * oversized directory is never read whole), queueing the directories to
 * list next. Returns false when the walk reached a cap and must stop.
 */
function inspectGitDirListing(listing: PendingGitDirListing, walk: GitDirWalk): boolean {
  let dir: Dir;
  try {
    dir = opendirSync(listing.path);
  } catch (error) {
    walk.findings.push({ kind: 'unreadable', file: listing.path, detail: `cannot list safely (${errorCode(error)})` });
    return true;
  }
  try {
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      if (listing.scope === 'git-dir' && SEPARATELY_INSPECTED_GIT_DIR_ENTRIES.has(entry.name)) continue;
      if (walk.remaining === 0) {
        walk.findings.push({ kind: 'unreadable', file: listing.path, detail: GIT_DIR_WALK_LIMIT_DETAIL });
        return false;
      }
      walk.remaining -= 1;
      const path = join(listing.path, entry.name);
      let listPath: string | undefined = entry.isDirectory() ? path : undefined;
      if (entry.isSymbolicLink()) {
        const target = realPathInside(path, walk.realRoot);
        if (target === undefined) {
          walk.findings.push({ kind: 'internal-symlink', file: path, value: tryReadlink(path) });
          continue;
        }
        // Listed in the link's place: the target was checked, the link may change.
        listPath = tryStat(target)?.isDirectory() === true ? target : undefined;
      }
      // Only a tree descends into the subdirectories it lists; those of a
      // git dir or object store are queued by path below.
      if (listPath === undefined || listing.scope !== 'tree') continue;
      if (listing.depth === MAX_GIT_DIR_DEPTH) {
        walk.findings.push({ kind: 'unreadable', file: path, detail: GIT_DIR_WALK_LIMIT_DETAIL });
        return false;
      }
      walk.pending.push({ path: listPath, scope: 'tree', depth: listing.depth + 1 });
    }
  } catch (error) {
    walk.findings.push({ kind: 'unreadable', file: listing.path, detail: `cannot list safely (${errorCode(error)})` });
    return true;
  } finally {
    dir.closeSync();
  }
  if (listing.scope !== 'tree') queueNamedGitDirSubdirectories(listing.path, listing.scope, listing.depth + 1, walk);
  return true;
}

/**
 * Queues the {@link NAMED_GIT_DIR_SUBDIRECTORIES} of a git dir or object
 * store, each by its path (the filesystem decides which entry that is, as it
 * does for git). A link at the name was checked with the listing, which
 * reported it when it leaves the root; one that stays inside is walked
 * through its target.
 */
function queueNamedGitDirSubdirectories(
  directory: string,
  scope: Exclude<GitDirListingScope, 'tree'>,
  depth: number,
  walk: GitDirWalk,
): void {
  for (const [name, childScope] of NAMED_GIT_DIR_SUBDIRECTORIES[scope]) {
    const path = join(directory, name);
    const stats = tryLstat(path);
    let listPath = stats?.isDirectory() === true ? path : undefined;
    if (stats?.isSymbolicLink() === true) {
      const target = realPathInside(path, walk.realRoot);
      listPath = target !== undefined && tryStat(target)?.isDirectory() === true ? target : undefined;
    }
    if (listPath !== undefined) walk.pending.push({ path: listPath, scope: childScope, depth });
  }
}

/**
 * The nearest directory at or above `startPath`, not above `stopAt` (an
 * absolute path), that has a `.git` entry of any kind, with that entry's
 * lstat; the repository discovery of {@link inspectRepoConfig}.
 */
function discoverDotGit(
  startPath: string,
  stopAt: string | undefined,
): { readonly repoRoot: string; readonly dotGit: Stats } | undefined {
  let directory = resolve(startPath);
  for (;;) {
    const dotGit = tryLstat(join(directory, '.git'));
    if (dotGit !== undefined) return { repoRoot: directory, dotGit };
    const parent = dirname(directory);
    if (directory === stopAt || parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * The `repoRoot` that {@link inspectRepoConfig} finds for `startPath` with the
 * same `stopAt`, or undefined when it finds none. Inspecting that directory
 * gives the same result as inspecting `startPath`, so a caller with many
 * paths can inspect each repository once.
 */
export function findRepoRoot(startPath: string, stopAt?: string): string | undefined {
  return discoverDotGit(startPath, stopAt === undefined ? undefined : resolve(stopAt))?.repoRoot;
}

/**
 * Statically inspect the repository containing `startPath` for configuration
 * that host git would honour and that environment overrides cannot
 * neutralize. No git process runs, include files are never read, and every
 * file is read through {@link readUntrustedRegularFile} (no-follow,
 * non-blocking, size-capped). A config file that is a symlink, FIFO, too large
 * or syntactically invalid is reported `unreadable` (git would follow or
 * reject it), so callers fail closed. Symbolic links among the git dir's
 * entries, below `refs/`, `logs/`, `objects/info`, `objects/pack` and git's
 * state directories, and directly in `objects/` are reported
 * `internal-symlink` unless they resolve inside `followRedirectsWithin`
 * (bounded by `maxGitDirEntries`). Those directories are found by path, as
 * git opens them, so a case variant of their name on a case-insensitive
 * filesystem is walked too.
 *
 * This is advisory and racy by nature (the agent can change the repository
 * right after the check); use it to escalate or warn, together with
 * {@link hardenedGitEnv} and OS containment, never as the only boundary.
 */
export function inspectRepoConfig(startPath: string, options: InspectRepoConfigOptions = {}): RepoConfigInspection {
  const findings: RepoConfigFinding[] = [];
  const maxConfigBytes = options.maxConfigBytes ?? 1024 * 1024;
  const stopAt = options.stopAt === undefined ? undefined : resolve(options.stopAt);
  const followWithin = options.followRedirectsWithin;
  const CONTROL_FILE_BYTES = 4096;

  const discovered = discoverDotGit(startPath, stopAt);
  if (discovered === undefined) return { findings };
  const { repoRoot, dotGit } = discovered;

  const dotGitPath = join(repoRoot, '.git');
  let gitDir: string | undefined;
  if (dotGit.isSymbolicLink()) {
    let linkText: string | undefined;
    try {
      linkText = readlinkSync(dotGitPath);
    } catch {
      linkText = undefined;
    }
    const target = linkText === undefined ? undefined : resolve(repoRoot, linkText);
    findings.push({ kind: 'git-dir-symlink', file: dotGitPath, value: linkText, resolvedPath: target });
    if (target !== undefined) gitDir = realPathWithin(target, followWithin);
  } else if (dotGit.isFile()) {
    const content = readControlFile(dotGitPath, findings, CONTROL_FILE_BYTES);
    if (content !== undefined) {
      const trimmed = stripTrailingNewlines(content);
      if (!trimmed.startsWith('gitdir: ') || trimmed.length <= 'gitdir: '.length) {
        findings.push({ kind: 'unreadable', file: dotGitPath, detail: 'invalid gitfile format' });
      } else {
        const value = trimmed.slice('gitdir: '.length);
        const target = resolveAgainst(repoRoot, value);
        findings.push({ kind: 'gitfile', file: dotGitPath, value, resolvedPath: target });
        gitDir = realPathWithin(target, followWithin);
      }
    }
  } else if (dotGit.isDirectory()) {
    gitDir = dotGitPath;
  } else {
    findings.push({ kind: 'unreadable', file: dotGitPath, detail: '.git is not a file, directory or symlink' });
  }
  if (gitDir === undefined) return { repoRoot, findings };

  let commonDir: string | undefined = gitDir;
  const commondirFile = join(gitDir, 'commondir');
  if (tryLstat(commondirFile) !== undefined) {
    const content = readControlFile(commondirFile, findings, CONTROL_FILE_BYTES);
    const value = content === undefined ? undefined : stripTrailingNewlines(content);
    if (value === '') {
      findings.push({ kind: 'unreadable', file: commondirFile, detail: 'empty commondir' });
    } else if (value !== undefined) {
      const target = resolveAgainst(gitDir, value);
      findings.push({ kind: 'commondir', file: commondirFile, value, resolvedPath: target });
      commonDir = realPathWithin(target, followWithin);
    }
  }

  if (commonDir !== undefined) inspectConfigFile(join(commonDir, 'config'), gitDir, findings, maxConfigBytes);
  inspectConfigFile(join(gitDir, 'config.worktree'), gitDir, findings, maxConfigBytes);
  // Metadata is enough to require review: recursively inspecting arbitrary
  // children on every call would be unbounded and still racy. Never open or
  // follow these entries here, even when they are links or missing targets.
  const submoduleMetadata = new Set([join(repoRoot, '.gitmodules'), join(gitDir, 'modules')]);
  if (commonDir !== undefined) submoduleMetadata.add(join(commonDir, 'modules'));
  for (const path of submoduleMetadata) {
    if (tryLstat(path) !== undefined) findings.push({ kind: 'submodule', file: path });
  }
  if (commonDir !== undefined) {
    const alternates = join(commonDir, 'objects', 'info', 'alternates');
    if (tryLstat(alternates) !== undefined) findings.push({ kind: 'alternates', file: alternates });
    if (options.inspectHooks !== false) inspectHooks(commonDir, findings);
  }
  const gitDirs = commonDir === undefined || commonDir === gitDir ? [gitDir] : [gitDir, commonDir];
  inspectGitDirLinks(gitDirs, followWithin, options.maxGitDirEntries ?? DEFAULT_MAX_GIT_DIR_ENTRIES, findings);
  return { repoRoot, gitDir, commonDir, findings };
}
