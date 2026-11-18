/**
 * Sandbox Integration -- Wraps MCP server processes in OS-level sandboxes.
 *
 * Each sandboxed server is spawned via a separate `srt` CLI process with
 * its own settings file, giving each server independent sandbox infrastructure
 * (filesystem restrictions, network proxy, and process isolation).
 *
 * The proxy process itself never calls SandboxManager.initialize() -- it
 * only uses the stateless isSupportedPlatform() and checkDependencies()
 * for the availability check.
 *
 * Availability. The dependency check (bubblewrap, socat and ripgrep present)
 * cannot tell whether srt can actually start a sandbox: AppArmor-restricted
 * user namespaces, or a seccomp helper the host will not run, break every
 * sandboxed server on a host that passes it. Session start, the list
 * resolver and the offline tool listings therefore confirm it with one srt
 * smoke run per process ({@link resolveOsSandboxAvailability}), and a failed
 * run makes the sandbox unavailable, so "enforce" refuses the servers that
 * need it with the actionable notice and "warn" runs them unconfined. The
 * session parent hands its verdict to every relay
 * ({@link OS_SANDBOX_AVAILABILITY_ENV}), so parent and relays plan alike.
 *
 * Read containment. srt reads by deny-list: everything is readable except
 * `denyRead` (Linux: tmpfs or /dev/null over each entry; macOS: Seatbelt
 * `deny file-read*`). Every sandboxed server therefore gets a baseline
 * `denyRead` that its own config is unioned with, never replaced by:
 *
 * - the IronCurtain home (`getIronCurtainHome()`, so `IRONCURTAIN_HOME` is
 *   honoured), which holds OAuth refresh tokens, client secrets and the user
 *   config with API keys and server credentials. No configuration can re-open
 *   it: an `allowRead`/`allowWrite` entry that would expose any part of it,
 *   other than the session's own sandbox directory, is refused.
 * - per-user credential stores and the shell startup files where keys are
 *   exported ({@link BASELINE_CREDENTIAL_DENY_READ}), plus the OAuth
 *   credential files IronCurtain itself reads wherever their environment
 *   overrides put them (`ANTHROPIC_CONFIG_DIR`, `XDG_CONFIG_HOME`,
 *   `CODEX_HOME`) and a `.env` left in IronCurtain's package root. A server
 *   opts out of one of these only by naming that exact entry in its own
 *   `allowRead` (for example `"~/.aws"` for an AWS server).
 * - the relays' per-user scratch root (`getPrivateScratchRoot()`,
 *   `<os.tmpdir()>/ironcurtain-<uid>`, see spawn-cwd.ts), which holds every
 *   relay's srt settings, its sandboxed backends' working directories and an
 *   OAuth server's access-token file. Each server gets back only its own
 *   working directory ({@link writeServerSettings}) and its own credential
 *   directory (added by the relay), never a sibling's or another session's;
 *   there is no opt-out: a configured `allowRead`/`allowWrite` entry that
 *   would re-open any part of it is refused like one inside the home.
 *
 * Because the session sandbox usually lives under the IronCurtain home, the
 * re-exposure must work on both platforms: Linux re-binds `allowWrite` paths
 * over a read-deny tmpfs, but macOS re-allows reads inside a denied region
 * only through `allowRead`. The session sandbox, the per-server cwd and the
 * discovered Node.js installation paths are therefore always in `allowRead`.
 *
 * Symlinks. Seatbelt matches the kernel's canonical path, and srt keeps a
 * symlinked spelling it judges to leave its own tree (a symlinked
 * IronCurtain home, `/home -> /var/home`, a dotfile manager's
 * `~/.npmrc -> ~/dotfiles/npmrc`) instead of resolving it. A rule naming only
 * that spelling matches nothing on macOS, and Linux srt will not bind it
 * writable. Every deny entry is therefore also passed in its canonical form,
 * and the session sandbox also under its canonical parent directory.
 *
 * Roots confinement. A server whose config sets
 * `sandbox.filesystem.confineToRoots` (the filesystem server) additionally
 * has the user's home directory, the temporary directories and the per-user
 * runtime directory denied ({@link confinementHiddenRegions}). What it may
 * use inside them, its MCP roots and its own program, is re-exposed by the
 * relay when it launches the server (see `roots-confinement.ts`).
 */

import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { quote } from 'shell-quote';
import type {
  IronCurtainConfig,
  MCPServerConfig,
  SandboxAvailabilityPolicy,
  SandboxNetworkConfig,
} from '../config/types.js';
import { getIronCurtainHome } from '../config/paths.js';
import {
  EXTENDED_CREDENTIAL_STORE_IDS,
  extendedCredentialStoreHomePaths,
  computeSandboxCredentialPaths,
  type ExtendedCredentialStoreId,
} from '../config/credential-stores.js';
import { effectiveSandboxPolicy } from '../config/sandbox-policy.js';
import {
  getAnthropicCredentialsFilePath,
  getCodexAuthFilePath,
  getCredentialsFilePath,
} from '../docker/oauth-credentials.js';
import { expandTilde, resolveRealPath } from '../types/argument-roles.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { inheritedEnv } from './child-env.js';
import { createServerCwd, getPrivateScratchRoot, getTrustedSpawnCwd } from './spawn-cwd.js';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Result of resolving a server's sandbox configuration.
 * Discriminated union: sandboxed servers carry the resolved config,
 * unsandboxed servers carry the reason they were exempted.
 */
export type ResolvedSandboxConfig =
  | { readonly sandboxed: true; readonly config: ResolvedSandboxParams }
  | { readonly sandboxed: false; readonly reason: 'opt-out' | 'platform-unavailable' };

/**
 * Fully resolved sandbox parameters ready for srt settings.
 * Tildes in denyRead and allowRead are expanded, and relative allowWrite
 * and allowRead entries are resolved against the session sandbox
 * directory. The session sandbox directory has been injected into
 * allowWrite and allowRead, and denyRead carries the read-containment
 * baseline (see the module comment).
 */
export interface ResolvedSandboxParams {
  readonly allowWrite: readonly string[];
  readonly allowRead: readonly string[];
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  readonly network:
    | false
    | {
        readonly allowedDomains: readonly string[];
        readonly deniedDomains: readonly string[];
      };
  /**
   * The server is confined to its MCP roots (`confineToRoots` in its
   * config). `denyRead` already hides the {@link confinementHiddenRegions};
   * the relay adds the server's current roots and launch paths before it
   * writes the srt settings, and restarts the server when the roots change
   * (see `roots-confinement.ts`).
   */
  readonly confineToRoots?: true;
}

/** Result of checking sandbox-runtime availability. */
export interface SandboxAvailabilityResult {
  readonly platformSupported: boolean;
  readonly errors: string[];
  readonly warnings: string[];
}

/**
 * Thrown when a server's sandbox configuration would undermine read
 * containment, e.g. an `allowRead` entry inside the IronCurtain home.
 * Callers across module boundaries should match on `code`.
 */
export class SandboxConfigError extends Error {
  readonly code = 'SANDBOX_CONFIG_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'SandboxConfigError';
  }
}

/**
 * Whether OS sandboxing can be applied right now, with the reasons when it
 * cannot. `available` is true only when the platform is supported AND
 * sandbox-runtime reports no dependency errors (bubblewrap, socat and
 * ripgrep on Linux) AND, where it was run ({@link resolveOsSandboxAvailability}),
 * the srt smoke run passed. A supported platform with missing tools is NOT
 * available: treating it as available is what made audit entries claim
 * `sandboxed: true` for servers that ran unconfined.
 */
export interface OsSandboxAvailability {
  readonly available: boolean;
  readonly platformSupported: boolean;
  /** Why sandboxing is unavailable (missing tools, unsupported platform). Empty when available. */
  readonly problems: readonly string[];
  /** Non-fatal sandbox-runtime warnings (e.g. seccomp unavailable). */
  readonly warnings: readonly string[];
}

/**
 * Per-server outcome of applying the availability policy to a set of MCP
 * server configs. Produced once per process by {@link planServerSandboxing}
 * and used for spawning, refusing, audit stamping and user notices, so all
 * of them agree.
 */
export interface OsSandboxPlan {
  readonly policy: SandboxAvailabilityPolicy;
  readonly availability: OsSandboxAvailability;
  /**
   * Disposition of every server that may start (all servers except
   * `refused`). Servers that asked for a sandbox they cannot get resolve to
   * `{ sandboxed: false, reason: 'platform-unavailable' }`.
   */
  readonly resolved: Map<string, ResolvedSandboxConfig>;
  /** Servers that need an OS sandbox that is unavailable, and must not start (`enforce`). */
  readonly refused: readonly string[];
  /** Servers that need an OS sandbox that is unavailable, and start without one (`warn`). */
  readonly unconfined: readonly string[];
}

/**
 * Thrown by {@link resolveSandboxConfig} when the policy forbids starting a
 * server without the OS sandbox it asks for. Callers match on `code`.
 */
export class SandboxUnavailableError extends Error {
  readonly code = 'SANDBOX_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

/** Outcome of {@link runOsSandboxSmokeTest}. */
export interface OsSandboxSmokeResult {
  readonly ok: boolean;
  readonly elapsedMs: number;
  /** Human-readable outcome; on failure, the error and srt's stderr. */
  readonly detail: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Where the baseline departs from the extended credential stores the policy
 * engine protects (`EXTENDED_CREDENTIAL_STORE_IDS` in
 * config/credential-stores.ts), each otherwise denied at the locations
 * listed there:
 *
 * - `ssh`: only the default-named private keys, not all of `~/.ssh`, so a
 *   server whose own `denyRead` leaves `~/.ssh` open (git) still reads
 *   `known_hosts` and `config`, and authenticates through ssh-agent rather
 *   than key files.
 * - `netrc`: left readable. git over HTTPS may take its credentials from
 *   `~/.netrc`, and the built-in git server's `allowRead` cannot be
 *   adjusted by the user, so denying it would break that setup with no way
 *   back. Whether to deny it anyway is open (docs/MISSING_FEATURES.md).
 */
const BASELINE_STORE_EXCEPTIONS: Readonly<Partial<Record<ExtendedCredentialStoreId, readonly string[]>>> = {
  ssh: ['~/.ssh/id_*'],
  netrc: [],
};

/**
 * Shell startup files, where provider API keys and other tokens are
 * commonly exported (`export ANTHROPIC_API_KEY=...`): without this a server
 * could read from disk what the environment allowlist (child-env.ts) keeps
 * out of its environment. For fish, the whole configuration directory:
 * universal variables (`set -Ux`) live in `fish_variables` beside
 * `config.fish`, and `conf.d/*.fish` runs at startup too. srt runs a
 * server's command with a non-login, non-interactive `bash -c`, which reads
 * none of these.
 */
const SHELL_STARTUP_FILES: readonly string[] = [
  '~/.bashrc',
  '~/.bash_profile',
  '~/.bash_login',
  '~/.profile',
  '~/.zshrc',
  '~/.zshenv',
  '~/.zprofile',
  '~/.config/fish',
];

/**
 * Per-user credential stores and credential carriers no sandboxed server
 * may read, whatever its own `denyRead` says:
 *
 * - every extended credential store the policy engine protects, at the
 *   locations config/credential-stores.ts gives it, except as
 *   {@link BASELINE_STORE_EXCEPTIONS} says (only the SSH private keys of
 *   `~/.ssh`; not `~/.netrc`), so a store added there is hidden here too;
 * - the default locations of the OAuth credential files IronCurtain itself
 *   reads (`~/.claude/.credentials.json`, `~/.codex/auth.json`);
 * - the shell startup files ({@link SHELL_STARTUP_FILES}).
 *
 * The baseline also denies the OAuth credential files IronCurtain itself
 * reads, at the locations their environment overrides give them (the
 * Anthropic CLI store under `ANTHROPIC_CONFIG_DIR` or `XDG_CONFIG_HOME`, the
 * Codex login under `CODEX_HOME`), and a `.env` in IronCurtain's package
 * root; see `credentialStorePaths`.
 *
 * A server opts out of an entry by naming it, spelled exactly as here (or
 * as the absolute path, for the IronCurtain-read files and the package-root
 * `.env`), in its own `allowRead`. The IronCurtain home is denied separately
 * and has no opt-out.
 */
export const BASELINE_CREDENTIAL_DENY_READ: readonly string[] = Object.freeze([
  ...EXTENDED_CREDENTIAL_STORE_IDS.flatMap(
    (id) => BASELINE_STORE_EXCEPTIONS[id] ?? extendedCredentialStoreHomePaths(id),
  ),
  '~/.claude/.credentials.json',
  '~/.codex/auth.json',
  ...SHELL_STARTUP_FILES,
]);

/**
 * A server's own `denyRead` when its config does not set one. Unioned with
 * the baseline like any explicit list.
 */
const DEFAULT_DENY_READ = ['~/.ssh', '~/.gnupg', '~/.aws'];

/** Glob metacharacters srt recognizes in a POSIX path spelling. */
const GLOB_CHARS = /[*?[\]]/;

/**
 * Resolve the absolute path to the `srt` binary in node_modules.
 * Walks up from the package root to handle npm's dependency hoisting,
 * where bins may be in a parent node_modules/.bin/ directory.
 */
const __sandboxDirname = dirname(fileURLToPath(import.meta.url));
const SRT_BIN = resolveNodeModulesBin('srt', resolve(__sandboxDirname, '..', '..'));

/**
 * sandbox-runtime's package directory, canonical: `srt` is
 * `<package>/dist/cli.js` behind the `node_modules/.bin` link. srt runs its
 * `apply-seccomp` helper from `<package>/vendor` inside the sandbox on
 * Linux, so a profile that hides the directory holding it must re-expose
 * it. `undefined` when the binary cannot be resolved.
 */
export function sandboxRuntimePackageDir(): string | undefined {
  try {
    return dirname(dirname(realpathSync(SRT_BIN)));
  } catch {
    return undefined;
  }
}

/** Pattern matching common OS-level permission errors from sandbox containment. */
const SANDBOX_BLOCK_PATTERN = /EACCES|EPERM|Operation not permitted|Permission denied|read-only file system/i;

/**
 * sandbox-runtime's wording for a missing or unusable Linux helper binary,
 * e.g. "ripgrep (rg) not found", "bubblewrap (bwrap) not installed",
 * "socat not executable at <path>". Names the tool so that other "not
 * found" problems (e.g. Windows' "srt-win.exe not found") do not get the
 * Linux install hint.
 */
const MISSING_TOOL_PATTERN = /\b(?:bubblewrap|bwrap|socat|ripgrep)\b.*\bnot (?:installed|found|executable)\b/i;

/** Install command for the Linux helpers sandbox-runtime needs. */
export const OS_SANDBOX_INSTALL_HINT =
  'install bubblewrap, socat and ripgrep (e.g. `sudo apt-get install -y bubblewrap socat ripgrep`)';

/** How to opt into running such servers without OS containment. */
const WARN_POLICY_HINT =
  'or set sandboxPolicy to "warn" (`ironcurtain config` > Security, or IRONCURTAIN_SANDBOX_POLICY=warn) ' +
  'to run them without OS containment';

/** Default deadline for {@link runOsSandboxSmokeTest}. */
const SMOKE_TEST_TIMEOUT_MS = 20_000;

/**
 * How long {@link runOsSandboxSmokeTestOnce} keeps a failed smoke run before
 * it runs srt again, so a long-running process (the daemon) notices a host
 * that has been fixed. A passed run is kept for the life of the process.
 */
const SMOKE_FAILURE_RECHECK_MS = 5 * 60_000;

/**
 * Relay-internal environment variable through which a relay's parent hands
 * it the OS-sandbox availability it planned with: the JSON of an
 * {@link OsSandboxAvailability} ({@link osSandboxAvailabilityEnv},
 * {@link parseOsSandboxAvailabilityEnv}). Listed in `RELAY_INTERNAL_ENV_NAMES`
 * (child-env.ts), so no other child inherits it and no `-e NAME` argument
 * forwards it, and never loaded from a credential file (trusted-env.ts).
 */
export const OS_SANDBOX_AVAILABILITY_ENV = 'OS_SANDBOX_AVAILABILITY';

/** The problem recorded when the dependencies are present but the srt smoke run fails. */
const SMOKE_FAILURE_PROBLEM = 'srt cannot start a sandbox on this host';

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Checks sandbox dependencies and returns a structured result.
 *
 * Wraps SandboxManager.isSupportedPlatform() and checkDependencies()
 * into a single call. Does NOT throw -- callers inspect the result and
 * decide based on sandboxPolicy. Most callers want
 * {@link getOsSandboxAvailability}, which folds both into one boolean.
 */
export function checkSandboxAvailability(): SandboxAvailabilityResult {
  const platformSupported = SandboxManager.isSupportedPlatform();

  if (!platformSupported) {
    return { platformSupported, errors: [], warnings: [] };
  }

  const { errors, warnings } = SandboxManager.checkDependencies();
  return { platformSupported, errors, warnings };
}

/**
 * Collapses {@link checkSandboxAvailability} into one decision: OS
 * sandboxing is available only when the platform is supported and no
 * dependency is missing. `check` is injectable for tests. This is the
 * dependency verdict alone; what servers are planned with is
 * {@link resolveOsSandboxAvailability}, which also runs srt once.
 */
export function getOsSandboxAvailability(
  check: () => SandboxAvailabilityResult = checkSandboxAvailability,
  platform: string = process.platform,
): OsSandboxAvailability {
  const { platformSupported, errors, warnings } = check();
  if (!platformSupported) {
    return {
      available: false,
      platformSupported,
      problems: [`platform "${platform}" is not supported by sandbox-runtime`],
      warnings,
    };
  }
  return { available: errors.length === 0, platformSupported, problems: errors, warnings };
}

/**
 * True when the server asks for OS-level sandboxing: its config omits
 * `sandbox` (restrictive defaults) or gives a `sandbox` object. Only
 * `"sandbox": false` opts out.
 */
export function requiresOsSandbox(serverConfig: MCPServerConfig): boolean {
  return serverConfig.sandbox !== false;
}

/**
 * A dependency verdict with the srt smoke run folded in: when the
 * dependencies are present but srt could not run a command in a sandbox,
 * the sandbox is unavailable and the run's detail is the problem. Otherwise
 * `dependencies` unchanged. Pure.
 */
export function withOsSandboxSmokeResult(
  dependencies: OsSandboxAvailability,
  smoke: OsSandboxSmokeResult,
): OsSandboxAvailability {
  if (!dependencies.available || smoke.ok) return dependencies;
  return {
    available: false,
    platformSupported: dependencies.platformSupported,
    problems: [`${SMOKE_FAILURE_PROBLEM}: ${smoke.detail}`],
    warnings: dependencies.warnings,
  };
}

/** Host checks {@link resolveOsSandboxAvailability} runs, injectable for tests. */
export interface OsSandboxAvailabilityProbe {
  /** The dependency verdict. Default: {@link getOsSandboxAvailability}. */
  readonly dependencies?: OsSandboxAvailability;
  /** The srt smoke run. Default: {@link runOsSandboxSmokeTestOnce}. */
  readonly smokeTest?: () => Promise<OsSandboxSmokeResult>;
}

/**
 * The OS-sandbox availability sessions, the list resolver, relays without a
 * parent verdict and the offline tool listings plan with: the dependency
 * check and, when it passes and one of `servers` asks for an OS sandbox, the
 * srt smoke run (once per process, {@link runOsSandboxSmokeTestOnce}). A host
 * with the helpers installed where srt still cannot start a sandbox
 * (AppArmor-restricted user namespaces, a seccomp helper the host will not
 * run) is unavailable: "enforce" refuses its sandboxed servers with the
 * actionable notice and "warn" runs them unconfined, instead of wrapping
 * them in an srt that fails to start. No smoke run when no server needs the
 * sandbox. Never throws.
 */
export async function resolveOsSandboxAvailability(
  servers: Readonly<Record<string, MCPServerConfig>>,
  probe: OsSandboxAvailabilityProbe = {},
): Promise<OsSandboxAvailability> {
  const dependencies = probe.dependencies ?? getOsSandboxAvailability();
  if (!dependencies.available || !Object.values(servers).some(requiresOsSandbox)) return dependencies;
  const smoke = await (probe.smokeTest ?? runOsSandboxSmokeTestOnce)();
  return withOsSandboxSmokeResult(dependencies, smoke);
}

/**
 * The availability a relay plans with when its parent handed it one
 * ({@link OS_SANDBOX_AVAILABILITY_ENV}): the parent's verdict, which
 * includes its srt smoke run, narrowed by the relay's own dependency check.
 * The relay never finds a sandbox its parent did not, and never runs the
 * smoke test again. Pure.
 */
export function narrowOsSandboxAvailability(
  fromParent: OsSandboxAvailability,
  own: OsSandboxAvailability,
): OsSandboxAvailability {
  return fromParent.available ? own : fromParent;
}

/** The environment entry that hands `availability` to a relay ({@link OS_SANDBOX_AVAILABILITY_ENV}). */
export function osSandboxAvailabilityEnv(availability: OsSandboxAvailability): Record<string, string> {
  const { available, platformSupported, problems, warnings } = availability;
  return { [OS_SANDBOX_AVAILABILITY_ENV]: JSON.stringify({ available, platformSupported, problems, warnings }) };
}

/**
 * Reads the availability a relay's parent handed it. `undefined` when the
 * variable is unset or empty (the relay then checks for itself). Throws for
 * any other value that is not a complete, consistent availability, so a
 * damaged value stops the relay instead of being guessed at.
 */
export function parseOsSandboxAvailabilityEnv(value: string | undefined): OsSandboxAvailability | undefined {
  if (value === undefined || value === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${OS_SANDBOX_AVAILABILITY_ENV} is not valid JSON`);
  }
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const { available, platformSupported, problems, warnings } = record;
  const isStrings = (items: unknown): items is string[] =>
    Array.isArray(items) && items.every((item) => typeof item === 'string');
  if (
    typeof available !== 'boolean' ||
    typeof platformSupported !== 'boolean' ||
    !isStrings(problems) ||
    !isStrings(warnings) ||
    (available && (!platformSupported || problems.length > 0))
  ) {
    throw new Error(
      `${OS_SANDBOX_AVAILABILITY_ENV} must be a JSON object with boolean "available" and "platformSupported" ` +
        'and string arrays "problems" and "warnings" (no problems when available)',
    );
  }
  return { available, platformSupported, problems, warnings };
}

/**
 * Applies the availability policy to every server, per server:
 *
 * - servers that opt out (`"sandbox": false`) always start, unsandboxed;
 * - servers that ask for a sandbox start sandboxed when it is available;
 * - when it is unavailable they are `refused` under "enforce" and start
 *   `unconfined` (stamped `platform-unavailable`) under "warn".
 *
 * Pure apart from {@link resolveSandboxConfig}'s path resolution; never
 * throws for an unavailable sandbox. One server's refusal does not affect
 * the others.
 *
 * Used by the session parent (audit stamping, relay spawning, the notice)
 * and by each relay (srt settings), so both resolve every server alike.
 *
 * @throws {SandboxConfigError} when a server that gets a sandbox has a
 *   config that would re-expose the IronCurtain home (see
 *   {@link resolveSandboxConfig}). This is a configuration error, not an
 *   availability decision, so it fails the whole session closed rather than
 *   refusing just that server.
 */
export function planServerSandboxing(
  servers: Readonly<Record<string, MCPServerConfig>>,
  allowedDirectory: string | undefined,
  availability: OsSandboxAvailability,
  policy: SandboxAvailabilityPolicy,
  credentialPaths: readonly string[] = [],
): OsSandboxPlan {
  const resolved = new Map<string, ResolvedSandboxConfig>();
  const refused: string[] = [];
  const unconfined: string[] = [];
  for (const [serverName, config] of Object.entries(servers)) {
    if (requiresOsSandbox(config) && !availability.available) {
      if (policy === 'enforce') {
        refused.push(serverName);
        continue;
      }
      unconfined.push(serverName);
    }
    resolved.set(
      serverName,
      resolveSandboxConfig(
        config,
        allowedDirectory ?? '/tmp',
        availability.available,
        policy,
        serverName,
        credentialPaths,
      ),
    );
  }
  return { policy, availability, resolved, refused, unconfined };
}

/** Short reason text for an unavailable sandbox, e.g. "ripgrep (rg) not found; socat not installed". */
export function describeOsSandboxProblems(availability: OsSandboxAvailability): string {
  return availability.problems.length > 0 ? availability.problems.join('; ') : 'unknown reason';
}

/**
 * True when installing packages can make the OS sandbox available: the
 * platform is supported and sandbox-runtime reports a missing or unusable
 * helper binary (bubblewrap, socat, ripgrep). Other problems, such as
 * bubblewrap refusing a user namespace when running as root without
 * CAP_SETFCAP, carry their own remedy in the problem text.
 */
export function isOsSandboxFixableByInstall(availability: OsSandboxAvailability): boolean {
  return availability.platformSupported && availability.problems.some((problem) => MISSING_TOOL_PATTERN.test(problem));
}

/** Remedy text: the install command when helper binaries are missing. */
function osSandboxRemedy(availability: OsSandboxAvailability): string {
  return isOsSandboxFixableByInstall(availability)
    ? `To fix, ${OS_SANDBOX_INSTALL_HINT}, `
    : 'To fix, see `ironcurtain doctor`, ';
}

/**
 * Message for one server refused under "enforce". Names the missing tools
 * and both ways out (install them, or switch to "warn").
 */
export function formatSandboxRefusal(serverName: string, availability: OsSandboxAvailability): string {
  return (
    `Not starting MCP server "${serverName}": it requires an OS sandbox, which is unavailable ` +
    `(${describeOsSandboxProblems(availability)}), and sandboxPolicy is "enforce". ` +
    `${osSandboxRemedy(availability)}${WARN_POLICY_HINT}.`
  );
}

/**
 * The single-line, user-facing notice for a plan, or `undefined` when every
 * server that asked for an OS sandbox gets one. Names the affected servers
 * and the missing tools.
 */
export function formatOsSandboxNotice(plan: OsSandboxPlan): string | undefined {
  const why = describeOsSandboxProblems(plan.availability);
  if (plan.refused.length > 0) {
    return (
      `IronCurtain: OS sandbox unavailable (${why}); not starting MCP server(s) that require it: ` +
      `${plan.refused.join(', ')} (sandboxPolicy "enforce"). ` +
      `${osSandboxRemedy(plan.availability)}${WARN_POLICY_HINT}.`
    );
  }
  if (plan.unconfined.length > 0) {
    const remedy = isOsSandboxFixableByInstall(plan.availability)
      ? `To fix, ${OS_SANDBOX_INSTALL_HINT}, or run \`ironcurtain doctor\`.`
      : 'Run `ironcurtain doctor` for details.';
    return (
      `IronCurtain: WARNING: OS sandbox unavailable (${why}); MCP server(s) running WITHOUT OS containment: ` +
      `${plan.unconfined.join(', ')} (sandboxPolicy "warn"). ${remedy}`
    );
  }
  return undefined;
}

/**
 * The notice for a whole configuration under its effective policy, for
 * callers that only hold a config (the daemon's web UI). Sessions use the
 * plan they already computed instead. The default availability is the
 * dependency verdict alone (this is synchronous and runs no srt), so on a
 * host where srt cannot start it stays silent; the session started for it
 * prints the notice its own smoke run decides.
 */
export function osSandboxNoticeForConfig(
  config: Pick<IronCurtainConfig, 'mcpServers' | 'allowedDirectory' | 'sandboxPolicy' | 'userConfig'>,
  availability: OsSandboxAvailability = getOsSandboxAvailability(),
): string | undefined {
  return formatOsSandboxNotice(
    planServerSandboxing(
      config.mcpServers,
      config.allowedDirectory,
      availability,
      effectiveSandboxPolicy(config),
      computeSandboxCredentialPaths(config.userConfig.credentialProtection),
    ),
  );
}

/**
 * Writes a notice line to a terminal stream. The session logger swallows
 * `console.*`, so notices go straight to the stream. On a TTY the line is
 * started at column 0 on a cleared line, so a spinner drawing on the same
 * stream does not swallow or garble it; the spinner redraws below.
 */
export function writeOsSandboxNotice(
  notice: string,
  stream: { write(chunk: string): unknown; readonly isTTY?: boolean } = process.stderr,
): void {
  const lead = stream.isTTY === true ? '\r\x1b[K' : '';
  stream.write(`${lead}${toDisplayText(notice)}\n`);
}

/**
 * Runs a trivial command (`true`) through srt with a restrictive settings
 * file, the same way MCP servers are wrapped, and with the allowlisted
 * environment relays give their backends (child-env.ts). Proves that
 * bubblewrap (or Seatbelt), the network proxy and seccomp actually start on
 * this host, which the dependency check alone cannot. On failure, `detail`
 * is srt's stderr (or the error when it wrote none). Never throws.
 *
 * Every call runs srt; sessions and the offline tool listings go through
 * {@link runOsSandboxSmokeTestOnce}. `ironcurtain doctor` calls this
 * directly, so a diagnostic run never reuses an earlier verdict.
 */
export async function runOsSandboxSmokeTest(timeoutMs: number = SMOKE_TEST_TIMEOUT_MS): Promise<OsSandboxSmokeResult> {
  const start = Date.now();
  let settingsDir: string | undefined;
  try {
    settingsDir = mkdtempSync(join(tmpdir(), 'ironcurtain-srt-smoke-'));
    const params: ResolvedSandboxParams = {
      allowWrite: [settingsDir],
      allowRead: [],
      denyRead: [],
      denyWrite: [],
      network: false,
    };
    const { cwdPath } = writeServerSettings('smoke', params, settingsDir);
    const wrapped = wrapServerCommand('smoke', 'true', [], { sandboxed: true, config: params }, settingsDir);
    await runSmokeCommand(wrapped.command, wrapped.args, { cwd: cwdPath, env: inheritedEnv(process.env), timeoutMs });
    return { ok: true, elapsedMs: Date.now() - start, detail: 'srt ran a test command inside the sandbox' };
  } catch (err) {
    return { ok: false, elapsedMs: Date.now() - start, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    if (settingsDir) cleanupSettingsFiles(settingsDir);
  }
}

/**
 * Runs the srt command line of {@link runOsSandboxSmokeTest}: resolves when
 * it exits 0 within `timeoutMs`, and otherwise rejects with srt's stderr
 * (Node's error when srt wrote none). A run cut off at the deadline fails
 * whatever its exit status: srt forwards the deadline's SIGTERM to its
 * command and then exits 0 (it treats a command ended by SIGTERM or SIGINT
 * as a clean stop), so the status alone would pass a sandbox that never
 * finished starting, and the once-per-process verdict would keep that pass.
 * Exported for tests.
 */
export function runSmokeCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number },
): Promise<void> {
  const { timeoutMs } = options;
  return new Promise<void>((resolveRun, rejectRun) => {
    const child = execFile(
      command,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        // `child.killed`: the deadline's signal was sent. Node marks the
        // error `killed` too, but there is no error when srt then exits 0.
        const timedOut = child.killed || error?.killed === true;
        if (error === null && !timedOut) {
          resolveRun();
          return;
        }
        // srt's own words when it wrote any; Node's message otherwise
        // ("Command failed: <command line>", plus the stderr).
        const output = stderr.trim();
        const detail = timedOut
          ? `srt did not finish within ${timeoutMs}ms`
          : (output || error?.message || 'srt failed').replace(/\s+/g, ' ').trim().slice(0, 500);
        rejectRun(new Error(detail));
      },
    );
  });
}

/**
 * Memoizes a smoke run: concurrent and later calls share one run. A passed
 * run is kept for good; a failed one for `recheckMs`, after which the next
 * call runs it again. A run that throws or rejects counts as a failed run,
 * so the memoized function never rejects. Exported for tests; production
 * uses {@link runOsSandboxSmokeTestOnce}.
 */
export function createSmokeTestMemo(
  run: () => Promise<OsSandboxSmokeResult>,
  recheckMs: number = SMOKE_FAILURE_RECHECK_MS,
  now: () => number = Date.now,
): () => Promise<OsSandboxSmokeResult> {
  let current: { readonly result: Promise<OsSandboxSmokeResult>; failedAt?: number } | undefined;
  return () => {
    if (current !== undefined && (current.failedAt === undefined || now() - current.failedAt < recheckMs)) {
      return current.result;
    }
    // A synchronous throw rejects the executor's promise, and a rejection
    // becomes a failed run.
    const outcome = new Promise<OsSandboxSmokeResult>((resolveOutcome) => {
      resolveOutcome(run());
    }).catch((err: unknown): OsSandboxSmokeResult => ({
      ok: false,
      elapsedMs: 0,
      detail: err instanceof Error ? err.message : String(err),
    }));
    const entry: { readonly result: Promise<OsSandboxSmokeResult>; failedAt?: number } = { result: outcome };
    current = entry;
    void entry.result.then((result) => {
      if (!result.ok) entry.failedAt = now();
    });
    return entry.result;
  };
}

/**
 * {@link runOsSandboxSmokeTest}, run at most once per process (a failure is
 * re-checked after {@link SMOKE_FAILURE_RECHECK_MS}). What
 * {@link resolveOsSandboxAvailability} uses by default, so session start
 * pays for one srt run per process, and only on a host whose dependencies
 * are present and when a server asks for the sandbox.
 */
export const runOsSandboxSmokeTestOnce: () => Promise<OsSandboxSmokeResult> = createSmokeTestMemo(() =>
  runOsSandboxSmokeTest(),
);

/**
 * Resolves the effective sandbox configuration for a single MCP server.
 *
 * Applies defaults when `sandbox` is omitted, injects the session sandbox
 * directory into allowWrite and allowRead, resolves relative paths, and
 * unions the server's denyRead with the read-containment baseline.
 *
 * Throws {@link SandboxUnavailableError} when the server asks for a sandbox
 * that is unavailable and the policy is "enforce". Session code goes
 * through {@link planServerSandboxing}, which refuses such servers
 * individually instead of reaching this throw.
 *
 * @param serverName - Used only to name the server in error messages.
 * @throws {SandboxConfigError} when the config would re-expose the
 *   IronCurtain home or the relays' per-user scratch root, when the session
 *   sandbox directory is the home, or when it lies in the scratch root.
 */
export function resolveSandboxConfig(
  serverConfig: MCPServerConfig,
  sessionSandboxDir: string,
  platformAvailable: boolean,
  policy: SandboxAvailabilityPolicy,
  serverName?: string,
  credentialPaths: readonly string[] = [],
): ResolvedSandboxConfig {
  if (serverConfig.sandbox === false) {
    return { sandboxed: false, reason: 'opt-out' };
  }

  if (!platformAvailable) {
    if (policy === 'enforce') {
      throw new SandboxUnavailableError(
        '[sandbox] Server requires sandboxing but OS sandboxing is unavailable and sandboxPolicy is "enforce".',
      );
    }
    return { sandboxed: false, reason: 'platform-unavailable' };
  }

  const sandboxConfig = serverConfig.sandbox ?? {};
  const fsConfig = sandboxConfig.filesystem ?? {};
  const networkConfig = sandboxConfig.network;
  const label = serverName === undefined ? 'Sandboxed server' : `Server "${serverName}"`;

  const homeSpellings = ironCurtainHomeSpellings();
  // A session sandbox inside the home is re-exposed on purpose, and one that
  // contains the home is safe (srt keeps the nested deny on both platforms);
  // the home itself would re-open everything in it.
  const homeForms = homeSpellings.flatMap(pathForms);
  if (pathForms(sessionSandboxDir).some((form) => homeForms.includes(form))) {
    throw new SandboxConfigError(
      `[sandbox] ${label}: the session sandbox directory ${sessionSandboxDir} is the IronCurtain home itself; ` +
        'refusing to expose it to a sandboxed server.',
    );
  }

  // Relative entries resolve against the session sandbox, like allowWrite
  // (srt would otherwise resolve them against the per-server temp cwd, where
  // the IronCurtain-home check below could not follow them).
  const configuredAllowWrite = resolveAllowWritePaths(sessionSandboxDir, fsConfig.allowWrite ?? []);
  const configuredAllowRead = (fsConfig.allowRead ?? []).map((p) => resolve(sessionSandboxDir, expandTilde(p)));
  assertOutsideIronCurtainHome(label, 'allowWrite', configuredAllowWrite, sessionSandboxDir, homeSpellings);
  assertOutsideIronCurtainHome(label, 'allowRead', configuredAllowRead, sessionSandboxDir, homeSpellings);
  assertOutsideScratchRoot(label, sessionSandboxDir, configuredAllowWrite, configuredAllowRead);

  const sandboxSpellings = sessionSandboxSpellings(sessionSandboxDir);
  const allowWrite = unique([...sandboxSpellings, ...configuredAllowWrite]);
  // macOS honours only allowRead inside a denied region, and the session
  // sandbox usually sits under the (denied) IronCurtain home.
  const allowRead = unique([...sandboxSpellings, ...configuredAllowRead]);
  // A roots-confined server also loses the home, temporary and runtime
  // directories; the relay re-exposes its roots and program inside them.
  const confineToRoots = fsConfig.confineToRoots === true;
  const ownDenyRead = [
    ...(fsConfig.denyRead ?? DEFAULT_DENY_READ),
    ...(confineToRoots ? confinementHiddenRegions() : []),
  ];
  const denyRead = buildDenyRead(ownDenyRead, configuredAllowRead, homeSpellings, credentialPaths);
  const denyWrite = fsConfig.denyWrite ?? [];

  const network = resolveNetworkConfig(networkConfig);

  return {
    sandboxed: true,
    config: {
      allowWrite,
      allowRead,
      denyRead,
      denyWrite,
      network,
      ...(confineToRoots ? { confineToRoots: true as const } : {}),
    },
  };
}

/**
 * The directories hidden from a server confined to its MCP roots, on top of
 * the read-containment baseline:
 *
 * - the user's home directory (`os.homedir()`): credentials and dotfiles the
 *   baseline does not name, browser profiles, password stores and every
 *   other project tree;
 * - the temporary directories (`os.tmpdir()`, `/tmp`, `/var/tmp`): other
 *   sessions' scratch files, including the relays' srt settings
 *   directories with their per-session OAuth credential files;
 * - the per-user runtime directory (`$XDG_RUNTIME_DIR`, usually only on
 *   Linux): agent and keyring sockets, container registry credentials.
 *
 * Absolute and normalized; `buildDenyRead` adds each entry's canonical
 * spelling. The filesystem root is never returned: hiding it would hide the
 * system the server runs on (a home directory of `/` is not hidden at all).
 * Directories elsewhere on the host (system files, other mounts) stay
 * readable; see docs/designs/filesystem-server-confinement.md.
 */
export function confinementHiddenRegions(env: NodeJS.ProcessEnv = process.env): string[] {
  const regions = [homedir(), tmpdir(), '/tmp', '/var/tmp'];
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (runtimeDir !== undefined && runtimeDir !== '') regions.push(runtimeDir);
  return unique(regions.filter((p) => isAbsolute(p)).map((p) => resolve(p))).filter((p) => p !== '/');
}

/**
 * The baseline `denyRead` every sandboxed server gets before its own
 * entries: the IronCurtain home and the credential stores, all
 * tilde-expanded, each as configured and as its canonical path when they
 * differ.
 */
export function baselineDenyRead(credentialPaths: readonly string[] = []): string[] {
  return buildDenyRead([], [], ironCurtainHomeSpellings(), credentialPaths);
}

/**
 * True when re-allowing `path` (through allowRead or allowWrite) would
 * expose any part of the IronCurtain home: its canonical form is the home
 * or inside it, or it is a glob that could match there. Paths that merely
 * contain the home are not re-exposures: srt keeps the nested deny on both
 * platforms. Paths computed at runtime for a server (Node.js installation
 * directories, root directories) must be filtered through this before they
 * are added to its settings.
 */
export function reexposesIronCurtainHome(path: string): boolean {
  return reexposesAnyOf(path, ironCurtainHomeSpellings());
}

/** Per-server choices {@link writeServerSettings} cannot derive from the resolved parameters. */
export interface ServerSettingsOptions {
  /**
   * Let the server reach the ssh agent. srt blocks Unix sockets inside the
   * sandbox; on macOS, Seatbelt re-allows those under the paths in srt's
   * `network.allowUnixSockets` (Linux srt ignores the list), so the
   * directory of the relay's `SSH_AUTH_SOCK` is put there, when the server
   * has network access and `SSH_AUTH_SOCK` is set. Callers pass
   * `isGitBackend(serverName)` (git-backend-env.ts): the rule that also
   * decides which backend gets `SSH_AUTH_SOCK` in its environment
   * (child-env.ts). The git backend is the one server that authenticates
   * with ssh; any other server that can reach the agent can sign in as the
   * user with their SSH keys. Default false.
   */
  readonly sshAgent?: boolean;
}

/**
 * Writes a per-server srt settings JSON file and creates the server's
 * private working directory.
 *
 * Each sandboxed server gets its own settings file at
 * `{settingsDir}/{serverName}.srt-settings.json` and a CWD directory at
 * `{settingsDir}/{serverName}.cwd/` (see `createServerCwd`; the relay
 * puts unsandboxed servers' directories under the IronCurtain home
 * instead, see spawn-cwd.ts). The CWD directory is added to
 * `allowWrite` so the sandboxed process can write logs there, and to
 * `allowRead` so it stays readable even though the settings directory
 * lives inside the denied per-user scratch root (and, on macOS, when a
 * denyRead entry covers the temp directory). This keeps bwrap ghost
 * dotfiles out of the user-visible sandbox directory, and it is the only
 * part of the scratch root this server gets back besides its own
 * credential directory. The ssh-agent socket is granted only on request
 * ({@link ServerSettingsOptions.sshAgent}).
 *
 * Returns `{ settingsPath, cwdPath }`.
 */
export function writeServerSettings(
  serverName: string,
  config: ResolvedSandboxParams,
  settingsDir: string,
  options: ServerSettingsOptions = {},
): { settingsPath: string; cwdPath: string } {
  const cwdPath = createServerCwd(settingsDir, serverName);
  const settingsPath = join(settingsDir, `${serverName}.srt-settings.json`);

  const network: {
    allowedDomains: readonly string[];
    deniedDomains: readonly string[];
    allowUnixSockets?: string[];
  } =
    config.network === false
      ? { allowedDomains: [], deniedDomains: [] }
      : { allowedDomains: config.network.allowedDomains, deniedDomains: config.network.deniedDomains };

  // The ssh agent's socket, for the server that authenticates with ssh
  // (git) only, so it does not fall back to passphrase prompts; see
  // ServerSettingsOptions.sshAgent.
  const sshAuthSock = process.env.SSH_AUTH_SOCK;
  if (options.sshAgent === true && sshAuthSock && config.network !== false) {
    network.allowUnixSockets = [resolveRealPath(sshAuthSock)];
  }

  const settings = {
    network,
    filesystem: {
      denyRead: config.denyRead,
      allowRead: unique([...config.allowRead, cwdPath]),
      allowWrite: [...config.allowWrite, cwdPath],
      denyWrite: config.denyWrite,
    },
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { settingsPath, cwdPath };
}

/**
 * Transforms a server's spawn parameters (command + args) into a
 * sandbox-wrapped command suitable for StdioClientTransport.
 *
 * For sandboxed servers: returns `{ command: 'srt', args: ['-s', settingsPath, '-c', escapedCmd] }`.
 * For unsandboxed servers: returns the original command/args unchanged.
 *
 * `options.argsBaseDir` is the directory relative path arguments resolve
 * against (default: this process's cwd, which for a relay is IronCurtain's
 * package root). A caller that does not run from the package root, such as
 * `ironcurtain doctor`, which runs wherever the user started it, passes
 * the package root so a server is started exactly as its relay starts it.
 */
export function wrapServerCommand(
  serverName: string,
  command: string,
  args: readonly string[],
  sandboxConfig: ResolvedSandboxConfig,
  settingsDir: string,
  options: { readonly argsBaseDir?: string } = {},
): { command: string; args: string[] } {
  if (!sandboxConfig.sandboxed) {
    return { command, args: [...args] };
  }

  const settingsPath = join(settingsDir, `${serverName}.srt-settings.json`);
  // Resolve relative paths in args to absolute so the command works when
  // the proxy sets cwd to the per-server temp directory. They resolve
  // against the relay's own cwd, which is IronCurtain's package root
  // (MCPClientManager spawns every relay there; see spawn-cwd.ts), never
  // the directory the user started IronCurtain from. Only arguments that
  // are clearly relative paths are touched; see isRelativePathArg.
  const baseDir = resolve(options.argsBaseDir ?? process.cwd());
  const resolvedArgs = args.map((a) => (isRelativePathArg(a, baseDir) ? resolve(baseDir, a) : a));
  const cmdString = quote([command, ...resolvedArgs]);

  return {
    command: SRT_BIN,
    args: ['-s', settingsPath, '-c', cmdString],
  };
}

/**
 * Cleans up per-server settings files created by writeServerSettings().
 * Called during proxy shutdown. Safe to call even if no files were written.
 */
export function cleanupSettingsFiles(settingsDir: string): void {
  try {
    rmSync(settingsDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; OS temp rotation handles leftovers
  }
}

/**
 * Annotates an MCP error response when it looks like a sandbox block.
 *
 * When a sandboxed server returns an error matching common sandbox-blocked
 * patterns (EPERM, EACCES, etc.) and the policy engine had allowed the call,
 * this prefixes the error with [SANDBOX BLOCKED] to signal OS containment.
 */
export function annotateSandboxViolation(errorMessage: string, serverSandboxed: boolean): string {
  if (!serverSandboxed) return errorMessage;
  if (!SANDBOX_BLOCK_PATTERN.test(errorMessage)) return errorMessage;

  return `[SANDBOX BLOCKED] ${errorMessage}`;
}

/**
 * Discovers filesystem paths required by the current Node.js installation.
 *
 * When a sandbox's denyRead covers them (e.g. `denyRead: ["~"]`), node/npm
 * installations under the home directory (nvm, volta, fnm, asdf) become
 * unreadable. This function inspects the running process to find the actual
 * installation paths and returns them for inclusion in `allowRead`, which
 * the relay does for every sandboxed server (macOS re-allows reads inside a
 * denied region only through `allowRead`).
 *
 * Returns deduplicated absolute real paths. Never returns a path inside the
 * IronCurtain home: re-exposing it would undo the read-containment
 * baseline, so a Node.js installation there stays unreadable (fail closed).
 * Safe to call on any platform.
 */
export function discoverNodePaths(): string[] {
  const paths = new Set<string>();
  // Resolve home through realpath so prefix comparisons work when
  // homedir() involves symlinks (e.g., macOS /var → /private/var)
  const home = safeRealPath(homedir()) ?? homedir();

  // 1. Node.js binary -- follow symlinks to the real location
  const execPath = safeRealPath(process.execPath);
  if (execPath) {
    // The binary is typically at <prefix>/bin/node; we want <prefix>
    const binDir = dirname(execPath);
    const prefix = dirname(binDir);
    addIfUnderHome(paths, prefix, home);
  }

  // 2. Version manager root directories -- these contain node versions,
  //    global packages, and shims that the server process needs to read
  const versionManagerRoots: Array<{ envVar: string; fallback: string }> = [
    { envVar: 'NVM_DIR', fallback: '.nvm' },
    { envVar: 'VOLTA_HOME', fallback: '.volta' },
    { envVar: 'ASDF_DATA_DIR', fallback: '.asdf' },
  ];

  for (const { envVar, fallback } of versionManagerRoots) {
    const dir = process.env[envVar] ?? (home ? join(home, fallback) : '');
    if (dir && existsSync(dir)) {
      const realDir = safeRealPath(dir);
      if (realDir) addIfUnderHome(paths, realDir, home);
    }
  }

  // 3. fnm uses a platform-specific default location
  const fnmDir =
    process.env.FNM_DIR ??
    (process.platform === 'darwin' && home
      ? join(home, 'Library', 'Application Support', 'fnm')
      : home
        ? join(home, '.local', 'share', 'fnm')
        : '');
  if (fnmDir && existsSync(fnmDir)) {
    const realDir = safeRealPath(fnmDir);
    if (realDir) addIfUnderHome(paths, realDir, home);
  }

  return [...paths].filter((p) => !reexposesIronCurtainHome(p));
}

/**
 * Rewrites an existing srt settings file to add additional allowRead
 * and/or allowWrite paths. Used after OAuth setup discovers credential
 * directories that weren't known when the settings were first written.
 *
 * Merges new paths with existing ones (deduplicating).
 */
export function rewriteServerSettings(
  settingsPath: string,
  additions: { allowRead?: string[]; allowWrite?: string[] },
): void {
  const content = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
    filesystem?: { allowRead?: string[]; allowWrite?: string[] };
  };
  const fs = content.filesystem ?? {};

  if (additions.allowRead?.length) {
    const existing = new Set<string>(fs.allowRead ?? []);
    for (const p of additions.allowRead) existing.add(p);
    fs.allowRead = [...existing];
  }

  if (additions.allowWrite?.length) {
    const existing = new Set<string>(fs.allowWrite ?? []);
    for (const p of additions.allowWrite) existing.add(p);
    fs.allowWrite = [...existing];
  }

  content.filesystem = fs;
  writeFileSync(settingsPath, JSON.stringify(content, null, 2));
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Resolves a path to its real (canonical) path, returning null on failure.
 * Silently handles paths that don't exist or can't be resolved.
 */
function safeRealPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Adds a path to the set only if it's under the home directory.
 * Paths outside home don't need to be in allowRead since they
 * aren't blocked by `denyRead: ["~"]`.
 */
function addIfUnderHome(paths: Set<string>, dir: string, home: string): void {
  if (home && dir.startsWith(home + '/')) {
    paths.add(dir);
  }
}

/**
 * Resolves configured allowWrite entries: relative paths against the session
 * sandbox directory, absolute ones normalized. Every entry is folded
 * lexically (`resolve`) so srt is handed exactly the spelling the
 * IronCurtain-home check examined: srt realpaths an unfolded `a/link/../b`
 * through the link, which could land somewhere the check never saw.
 */
function resolveAllowWritePaths(sessionSandboxDir: string, paths: readonly string[]): string[] {
  return paths.map((p) => resolve(sessionSandboxDir, p));
}

/** The IronCurtain home as configured and, when different, its canonical path. */
function ironCurtainHomeSpellings(): string[] {
  const home = resolve(getIronCurtainHome());
  return unique([home, resolveRealPath(home)]);
}

/** Expands a leading `~` and normalizes the result when it is absolute. */
function expandHomePath(p: string): string {
  const expanded = expandTilde(p);
  return isAbsolute(expanded) ? resolve(expanded) : expanded;
}

/**
 * Builds a server's denyRead: the IronCurtain home, the relays' per-user
 * scratch root, the credential stores it has not opted out of, then its own
 * entries, each followed by its canonical spelling when that differs (see
 * {@link denySpellings}). An allowRead entry that names a credential-store
 * entry exactly (after tilde expansion) is the opt-out and drops both
 * spellings; dropping the deny rather than relying on srt's
 * allow-within-deny keeps the opt-out identical on Linux and macOS, glob
 * entries included. The home and the scratch root have no opt-out.
 */
function buildDenyRead(
  ownDenyRead: readonly string[],
  configuredAllowRead: readonly string[],
  homeSpellings: readonly string[],
  credentialPaths: readonly string[] = [],
): string[] {
  const optedOut = new Set(configuredAllowRead);
  const credentialStores = credentialStorePaths(credentialPaths).filter((p) => !optedOut.has(p));
  return unique([
    ...homeSpellings,
    // Other relays' srt settings, working directories and OAuth access-token
    // files. srt re-exposes this server's own cwd and credential directory
    // inside it through allowRead/allowWrite (on Linux by re-binding them
    // over the deny tmpfs, on macOS through the Seatbelt allow rule).
    ...denySpellings(getPrivateScratchRoot()),
    ...credentialStores.flatMap(denySpellings),
    ...ownDenyRead.map((p) => expandTilde(p)).flatMap(denySpellings),
  ]);
}

/**
 * The credential stores in the baseline, absolute and normalized: the
 * per-user list, then the OAuth credential files IronCurtain itself reads
 * (Docker-mode Claude and Codex logins), located the way IronCurtain locates
 * them, so `ANTHROPIC_CONFIG_DIR`, `XDG_CONFIG_HOME` and `CODEX_HOME` are
 * honoured, then a `.env` in IronCurtain's package root. The Anthropic CLI
 * keeps one file per profile, so its whole credentials directory is denied.
 *
 * The package root is the relays' working directory (spawn-cwd.ts), and a
 * `.env` there is where a source checkout kept its provider API keys before
 * they moved to the IronCurtain home. IronCurtain no longer reads it, but
 * an old one can still hold live keys, and every sandboxed server could
 * read it: srt hides only what the deny list names.
 */
function credentialStorePaths(credentialPaths: readonly string[] = []): string[] {
  return unique([
    ...BASELINE_CREDENTIAL_DENY_READ.map(expandHomePath),
    ...computeSandboxCredentialPaths(),
    ...credentialPaths,
    resolve(getCredentialsFilePath()),
    dirname(resolve(getAnthropicCredentialsFilePath())),
    resolve(getCodexAuthFilePath()),
    join(getTrustedSpawnCwd(), '.env'),
  ]);
}

/**
 * A deny entry, followed by the path it really names when a symlink is on
 * its way (for a glob, the canonical form of its static base directory). A
 * deny only ever removes access, so resolving the last component too is
 * safe. Relative entries are passed through as they are.
 */
function denySpellings(entry: string): string[] {
  if (!isAbsolute(entry)) return [entry];
  if (!GLOB_CHARS.test(entry)) return unique([entry, resolveRealPath(entry)]);
  const base = globBaseDir(entry);
  const canonicalBase = resolveRealPath(base);
  if (canonicalBase === base) return [entry];
  return [entry, join(canonicalBase, entry.slice(base.length))];
}

/**
 * The session sandbox as configured and, when a symlink sits on the way to
 * it (a symlinked IronCurtain home, `/home -> /var/home`), as its canonical
 * parent directory joined with its own name. srt keeps such a spelling
 * unresolved, so on its own it re-allows nothing on macOS and is not bound
 * writable on Linux. The last component is deliberately not resolved: if
 * the directory itself were ever swapped for a symlink, srt's own check of
 * the link (which refuses links that widen access) still applies.
 */
function sessionSandboxSpellings(sessionSandboxDir: string): string[] {
  const absolute = resolve(sessionSandboxDir);
  const parent = dirname(absolute);
  if (parent === absolute) return [sessionSandboxDir];
  return unique([sessionSandboxDir, join(resolveRealPath(parent), basename(absolute))]);
}

/**
 * Refuses configured allowRead/allowWrite entries that would re-expose any
 * part of the IronCurtain home. The only exception is an entry inside the
 * session sandbox directory when that directory itself sits in the home:
 * the sandbox is re-exposed by design, so nothing further is opened.
 */
function assertOutsideIronCurtainHome(
  label: string,
  field: 'allowRead' | 'allowWrite',
  entries: readonly string[],
  sessionSandboxDir: string,
  homeSpellings: readonly string[],
): void {
  const sessionForms = pathForms(sessionSandboxDir);
  const homeForms = homeSpellings.flatMap(pathForms);
  // When the sandbox contains the home, an entry inside the sandbox may still
  // be inside the home, which the sandbox does not re-expose.
  const sandboxContainsHome = homeForms.some((home) => sessionForms.some((s) => isAtOrUnder(home, s)));
  for (const entry of entries) {
    if (!reexposesAnyOf(entry, homeSpellings)) continue;
    const reach = GLOB_CHARS.test(entry) ? globBaseDir(entry) : entry;
    const insideSandbox = pathForms(reach).every((r) => sessionForms.some((s) => isAtOrUnder(r, s)));
    if (insideSandbox && !sandboxContainsHome) continue;
    throw new SandboxConfigError(
      `[sandbox] ${label}: sandbox.filesystem.${field} entry "${entry}" would expose the IronCurtain home ` +
        `(${homeSpellings[0]}), which holds OAuth tokens and credentials. Sandboxed servers can never read it; ` +
        'remove the entry or keep the data outside the IronCurtain home.',
    );
  }
}

/**
 * Refuses a configuration that would re-expose the relays' per-user scratch
 * root ({@link getPrivateScratchRoot}): an allowRead/allowWrite entry at or
 * under it, or a glob that could match into it (srt honours an allow inside
 * a deny, so `"/tmp/*"` would re-open every relay's srt settings, working
 * directories and OAuth access tokens), and a session sandbox directory at
 * or under it. Unlike the credential stores, the root has no opt-out: the
 * relay itself re-exposes a server's own working directory and credential
 * directory, nothing else in the root.
 */
function assertOutsideScratchRoot(
  label: string,
  sessionSandboxDir: string,
  allowWrite: readonly string[],
  allowRead: readonly string[],
): void {
  const rootSpellings = denySpellings(getPrivateScratchRoot());
  const rootForms = rootSpellings.flatMap(pathForms);
  if (pathForms(sessionSandboxDir).some((form) => rootForms.some((root) => isAtOrUnder(form, root)))) {
    throw new SandboxConfigError(
      `[sandbox] ${label}: the session sandbox directory ${sessionSandboxDir} lies in ${rootSpellings[0]}, ` +
        "the per-user directory that holds every relay's srt settings and OAuth access tokens; " +
        'refusing to expose it to a sandboxed server.',
    );
  }
  const fields = [
    ['allowWrite', allowWrite],
    ['allowRead', allowRead],
  ] as const;
  for (const [field, entries] of fields) {
    for (const entry of entries) {
      if (!reexposesAnyOf(entry, rootSpellings)) continue;
      throw new SandboxConfigError(
        `[sandbox] ${label}: sandbox.filesystem.${field} entry "${entry}" would expose ${rootSpellings[0]}, ` +
          "the per-user directory that holds every relay's srt settings and OAuth access tokens. " +
          'Sandboxed servers can never read it; remove the entry.',
      );
    }
  }
}

/**
 * True when re-allowing `entry` would expose part of any of `homes`: a
 * literal entry at or under one, or a glob whose static base directory is at
 * or under one or contains one (the glob could match into it).
 */
function reexposesAnyOf(entry: string, homes: readonly string[]): boolean {
  const homeForms = homes.flatMap(pathForms);
  if (GLOB_CHARS.test(entry)) {
    const baseForms = pathForms(globBaseDir(entry));
    return baseForms.some((base) => homeForms.some((home) => isAtOrUnder(base, home) || isAtOrUnder(home, base)));
  }
  return pathForms(entry).some((form) => homeForms.some((home) => isAtOrUnder(form, home)));
}

/** A path's lexically normalized spelling and its canonical (symlink-resolved) form. */
function pathForms(p: string): string[] {
  const absolute = resolve(expandTilde(p));
  return unique([absolute, resolveRealPath(absolute)]);
}

/**
 * The directory a glob's matches all lie beneath: everything before the
 * segment holding the first glob character (srt splits the same way).
 */
function globBaseDir(pattern: string): string {
  const staticPrefix = pattern.slice(0, pattern.search(GLOB_CHARS));
  if (staticPrefix.endsWith('/')) return staticPrefix.slice(0, -1) || '/';
  return dirname(staticPrefix);
}

/** True when `child` is `parent` or lies beneath it (both absolute, normalized). */
function isAtOrUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}

/** Order-preserving de-duplication. */
function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/**
 * True for a server argument that is clearly a relative filesystem path and
 * so must be made absolute (a sandboxed server runs with a per-server temp
 * directory as its cwd): it starts with `./` or `../`, or it contains `/` or
 * `.` and names something that exists relative to `baseDir` (the relay's
 * cwd). Flags, absolute paths, npm specifiers (`@org/pkg`, `pkg@1.2.3`),
 * URLs (`://`) and assignments or version pins (`=`, `pkg==1.2.3`) are never
 * rewritten, and neither are dotted or slashed literals that are not on
 * disk: versions (`1.5`), hostnames, module names (`pkg.module`) and inline
 * code.
 */
function isRelativePathArg(arg: string, baseDir: string): boolean {
  if (arg === '' || isAbsolute(arg) || arg.startsWith('-')) return false;
  if (arg.includes('@') || arg.includes('://') || arg.includes('=')) return false;
  if (arg.startsWith('./') || arg.startsWith('../')) return true;
  if (!arg.includes('/') && !arg.includes('.')) return false;
  return existsSync(resolve(baseDir, arg));
}

/**
 * Resolves network config to the canonical form.
 * `undefined` and `false` both mean no network access.
 */
function resolveNetworkConfig(config: false | SandboxNetworkConfig | undefined): ResolvedSandboxParams['network'] {
  if (!config) return false;

  return {
    allowedDomains: config.allowedDomains,
    deniedDomains: config.deniedDomains ?? [],
  };
}

/**
 * Resolves a binary name in node_modules/.bin/ by walking up from startDir.
 * Handles npm's dependency hoisting where bins may live in a parent node_modules/.bin/.
 */
export function resolveNodeModulesBin(binName: string, startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', binName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume it's directly under the package root
  return join(startDir, 'node_modules', '.bin', binName);
}
