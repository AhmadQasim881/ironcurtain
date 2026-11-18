/**
 * `ironcurtain doctor` checks of files and settings around the process:
 *
 *   - Home permissions: the IronCurtain home must be the user's and closed
 *     to other users (it holds session transcripts, audit logs, workspaces).
 *   - Secret files: config.json, the trusted .env, the OAuth tokens and
 *     client secrets, the web UI and statistics keys, and the host CLIs'
 *     OAuth stores IronCurtain reads must be owner-only.
 *   - Env files: what the trusted credential loader (config/trusted-env.ts)
 *     reads, ignores or warns about, including a `.env` in the working
 *     directory that is never read.
 *   - Environment: shell variables that change IronCurtain's own trust
 *     settings (code preloading, TLS verification, MITM debug switches,
 *     base-URL overrides that receive provider credentials).
 *   - Package assets: the reviewed records and binaries shipped with
 *     IronCurtain that nested Docker reads under the package-asset ownership
 *     and mode rules (hardened-fs.ts `readPackageAsset`), read with the
 *     same loaders, so what doctor reports is what admission enforces.
 *   - Nested Docker leases: fenced Docker-workload leases, which block every
 *     new nested-Docker admission until their cleanup is proven.
 *
 * Read-only: files are stat'ed and read, never created, changed or locked.
 */

import { lstatSync, readdirSync, statSync, type Stats } from 'node:fs';
import { arch } from 'node:os';
import { join, resolve } from 'node:path';
import {
  getIronCurtainHome,
  getDockerWorkloadLeasesRoot,
  getLlmStatisticsIdentityKeyPath,
  getOAuthDir,
  getUserConfigPath,
  getWebUiStatePath,
} from '../config/paths.js';
import {
  formatTrustedEnvReport,
  getCredentialEnvKeys,
  getExplicitEnvFilePath,
  getTrustedEnvFilePath,
  loadTrustedEnv,
  type TrustedEnvResult,
} from '../config/trusted-env.js';
import type { IronCurtainConfig } from '../config/types.js';
import { isUserPrivateGroup, readHostAccountDatabase, type AccountDatabase } from '../hardened-fs.js';
import {
  getAnthropicCredentialsFilePath,
  getCodexAuthFilePath,
  getCredentialsFilePath,
} from '../docker/oauth-credentials.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import type { CheckResult } from './checks.js';

/** At most this many offending entries are listed in one message. */
const MAX_LISTED = 4;

function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join('; ');
  return items.length > MAX_LISTED ? `${shown}; and ${items.length - MAX_LISTED} more` : shown;
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

/** Quotes a path for a copy-pasteable hint. Display only: nothing here is executed. */
function shellWord(path: string): string {
  const shown = toDisplayText(path);
  return /^[\w@%+=:,./-]+$/u.test(shown) ? shown : `'${shown.replaceAll("'", `'\\''`)}'`;
}

/** stat() following symlinks, undefined when the entry does not exist. */
function statIfExists(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The IronCurtain home must belong to the user and be closed to everyone
 * else: it holds config, credentials, session transcripts, audit logs and
 * workspaces. Releases before 0.14 created it with the umask's mode (often
 * 0755, or 0775 under the user-private-group umask 002).
 *
 * Another owner, write for others, or group write for a group other users
 * may be in fails: anyone who can write it can plant config, policies or
 * credentials. Group write for the owner's user-private group grants nobody
 * else anything (the rule hardened-fs.ts applies to package assets), so
 * like any other open mode it only warns. `accounts` reads the account
 * database for that rule (tests inject one).
 */
export function checkHomePermissions(
  home: string = getIronCurtainHome(),
  euid: number | undefined = process.geteuid?.(),
  accounts: () => AccountDatabase | undefined = readHostAccountDatabase,
): CheckResult {
  const name = 'Home permissions';
  const stats = statIfExists(home);
  if (stats === undefined) return { name, status: 'ok', message: `${toDisplayText(home)} does not exist yet` };
  if (!stats.isDirectory()) {
    return { name, status: 'fail', message: `${toDisplayText(home)} is not a directory` };
  }
  const foreignOwner = euid !== undefined && stats.uid !== euid;
  const groupWritable = (stats.mode & 0o020) !== 0;
  const privateGroup =
    groupWritable &&
    (() => {
      const database = accounts();
      return database !== undefined && isUserPrivateGroup(stats.uid, stats.gid, database);
    })();
  const writableByOthers = (stats.mode & 0o002) !== 0 || (groupWritable && !privateGroup);
  const problems: string[] = [];
  if (foreignOwner) problems.push(`owned by uid ${stats.uid}, not you (uid ${euid})`);
  if (writableByOthers) problems.push(`writable by other users (mode ${octal(stats.mode)})`);
  else if ((stats.mode & 0o077) !== 0) problems.push(`open to other users (mode ${octal(stats.mode)})`);
  if (problems.length === 0) {
    return { name, status: 'ok', message: `${toDisplayText(home)} (mode ${octal(stats.mode)})` };
  }
  return {
    name,
    status: writableByOthers || foreignOwner ? 'fail' : 'warn',
    message: `${toDisplayText(home)} is ${problems.join(' and ')}`,
    hint: `Run: chmod 700 ${shellWord(home)}`,
  };
}

/**
 * Every file IronCurtain keeps secrets in, plus the host CLIs' OAuth stores
 * it reads: they must be owner-only. Entries that do not exist are skipped;
 * a symlinked file is judged by the file it points to.
 */
export function secretFilePaths(): string[] {
  const home = getIronCurtainHome();
  const paths = [
    getUserConfigPath(),
    `${getUserConfigPath()}.bak`,
    getTrustedEnvFilePath(),
    getWebUiStatePath(),
    getLlmStatisticsIdentityKeyPath(),
    getCredentialsFilePath(),
    getAnthropicCredentialsFilePath(),
    getCodexAuthFilePath(),
  ];
  try {
    const explicit = getExplicitEnvFilePath();
    if (explicit !== undefined) paths.push(explicit);
  } catch {
    // An invalid IRONCURTAIN_ENV_FILE already stopped the CLI's bootstrap.
  }
  try {
    for (const entry of readdirSync(getOAuthDir())) {
      if (entry.endsWith('.json')) paths.push(join(getOAuthDir(), entry));
    }
  } catch {
    // No OAuth directory: nothing stored.
  }
  return [...new Set(paths.map((path) => resolve(home, path)))];
}

/** Checks the owner and mode of each existing secret file and of the OAuth directory. */
export function checkSecretFiles(
  paths: readonly string[] = secretFilePaths(),
  oauthDir: string = getOAuthDir(),
  euid: number | undefined = process.geteuid?.(),
): CheckResult {
  const name = 'Secret files';
  const problems: string[] = [];
  const fixable: string[] = [];
  let checked = 0;
  const dirStats = statIfExists(oauthDir);
  if (dirStats?.isDirectory() === true && (dirStats.mode & 0o077) !== 0) {
    problems.push(`${toDisplayText(oauthDir)} is open to other users (mode ${octal(dirStats.mode)})`);
    fixable.push(`chmod 700 ${shellWord(oauthDir)}`);
  }
  for (const path of paths) {
    const stats = statIfExists(path);
    if (stats === undefined || !stats.isFile()) continue;
    checked++;
    if (euid !== undefined && stats.uid !== euid) {
      problems.push(`${toDisplayText(path)} is owned by uid ${stats.uid}, not you`);
    }
    if ((stats.mode & 0o077) !== 0) {
      const what = (stats.mode & 0o022) !== 0 ? 'writable' : 'readable';
      problems.push(`${toDisplayText(path)} is ${what} by other users (mode ${octal(stats.mode)})`);
      fixable.push(`chmod 600 ${shellWord(path)}`);
    }
  }
  if (problems.length === 0) {
    return {
      name,
      status: 'ok',
      message: checked === 0 ? 'none stored yet' : `${checked} file${checked === 1 ? '' : 's'}, owner-only`,
    };
  }
  return {
    name,
    status: 'warn',
    message: listed(problems),
    ...(fixable.length > 0 ? { hint: `Run: ${fixable.slice(0, MAX_LISTED).join('; ')}` } : {}),
  };
}

/**
 * Reports what the trusted credential loader does with the env files, the
 * way the CLI's bootstrap does at start: files used despite loose modes,
 * keys it ignores, and a `.env` in the working directory it never reads (a
 * credential put there is silently missing). A file the loader refuses
 * (another user's, world-writable) fails: every command refuses to start.
 */
export function checkEnvFiles(env: NodeJS.ProcessEnv = process.env, cwd?: string): CheckResult {
  const name = 'Env files';
  let result: TrustedEnvResult;
  try {
    // A copy without the credential keys: the loader copies credential keys
    // into the env it is given and counts only those it sets, and the CLI's
    // bootstrap has already set the ones these files provide in process.env.
    const credentialKeys = getCredentialEnvKeys();
    const scratchEnv: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(env).filter(([key]) => !credentialKeys.has(key)),
    );
    result = loadTrustedEnv({ env: scratchEnv, ...(cwd === undefined ? {} : { cwd }) });
  } catch (err) {
    return {
      name,
      status: 'fail',
      message: toDisplayText(err instanceof Error ? err.message : String(err)),
      hint: 'IronCurtain refuses to start with an env file it cannot trust; fix or remove it.',
    };
  }
  const report = formatTrustedEnvReport(result);
  if (report.length > 0) {
    return { name, status: 'warn', message: report.join(' ') };
  }
  if (result.loadedFiles.length === 0) {
    return { name, status: 'ok', message: 'none (credentials come from the environment and config.json)' };
  }
  const keys = result.appliedKeys.length;
  return {
    name,
    status: 'ok',
    message: `${result.loadedFiles.map((file) => toDisplayText(file)).join(', ')}: ${keys} credential key${keys === 1 ? '' : 's'} (a value set in the shell takes precedence)`,
  };
}

/** Variables that make every Node.js process load code (IronCurtain's children never inherit them). */
const CODE_LOADING_VARIABLES = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
];

/** Base-URL overrides that receive the matching provider's credentials. */
const BASE_URL_VARIABLES = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'GOOGLE_API_BASE_URL'];

const MITM_DEBUG_VARIABLES = [
  'IRONCURTAIN_MITM_STREAM_DELAY_MS',
  'IRONCURTAIN_MITM_STREAM_DELAY_MODE',
  'IRONCURTAIN_MITM_STREAM_DRIP_BYTES',
];

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
}

/**
 * Reports environment variables that change IronCurtain's own trust
 * settings. Code-loading variables, disabled TLS verification, the MITM
 * debug switches and a plain-HTTP base URL to another host warn; base-URL
 * overrides and the forced API-key mode are noted.
 */
export function checkEnvironmentVariables(env: NodeJS.ProcessEnv = process.env): CheckResult {
  const name = 'Environment';
  const warnings: string[] = [];
  const notes: string[] = [];
  const set = (variable: string): boolean => (env[variable] ?? '') !== '';

  const loaders = CODE_LOADING_VARIABLES.filter(set);
  if (loaders.length > 0) {
    warnings.push(
      `${loaders.join(', ')} ${loaders.length === 1 ? 'is' : 'are'} set: code is loaded into IronCurtain itself ` +
        '(its MCP servers and agent containers do not inherit them)',
    );
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    warnings.push(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 turns off TLS certificate checks for IronCurtain's provider and OAuth requests",
    );
  }
  const allowAll = env.IRONCURTAIN_MITM_ALLOW_ALL_HOSTS;
  if (allowAll === '1' || allowAll === 'true') {
    warnings.push(
      'IRONCURTAIN_MITM_ALLOW_ALL_HOSTS (deprecated) makes the MITM proxy tunnel every unknown host without TLS ' +
        'inspection or egress filtering; use egressPolicy instead',
    );
  }
  const debug = MITM_DEBUG_VARIABLES.filter(set);
  if (debug.length > 0) warnings.push(`${debug.join(', ')}: the MITM stream-delay debug harness is active`);

  for (const variable of BASE_URL_VARIABLES) {
    const value = env[variable];
    if (value === undefined || value === '') continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      warnings.push(`${variable} is not a valid URL and is ignored`);
      continue;
    }
    const origin = toDisplayText(url.origin, { maxLength: 120 });
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      warnings.push(`${variable} sends provider credentials unencrypted to ${origin}`);
    } else {
      notes.push(`${variable} sends provider requests and credentials to ${origin}`);
    }
  }
  if (env.IRONCURTAIN_DOCKER_AUTH === 'apikey')
    notes.push('IRONCURTAIN_DOCKER_AUTH=apikey forces API-key auth for Docker agents');
  if (set('NODE_EXTRA_CA_CERTS')) notes.push('NODE_EXTRA_CA_CERTS adds trusted certificate authorities');

  if (warnings.length > 0) {
    return {
      name,
      status: 'warn',
      message: [...warnings, ...notes].join('; '),
      hint: 'Unset these variables unless you set them on purpose.',
    };
  }
  return {
    name,
    status: 'ok',
    message: notes.length > 0 ? notes.join('; ') : "nothing that changes IronCurtain's trust settings",
  };
}

/** The container architecture of this host, for the packaged per-architecture binaries. */
function hostContainerArchitecture(): 'amd64' | 'arm64' | undefined {
  const value = arch();
  if (value === 'x64') return 'amd64';
  if (value === 'arm64') return 'arm64';
  return undefined;
}

/**
 * Reads every package asset nested Docker loads, with the same loaders and
 * therefore the same ownership and mode rules (an asset another local user
 * could change is refused, a umask-002 install is accepted). Fails when
 * nested Docker is enabled (admission refuses), warns otherwise (enabling
 * it would fail).
 */
export async function checkPackageAssets(config: IronCurtainConfig): Promise<CheckResult> {
  const name = 'Package assets';
  const [paths, registry, toolchain, watchdog, hardened, contract] = await Promise.all([
    import('../docker/docker-workload-paths.js'),
    import('../docker/registry-egress-policy.js'),
    import('../docker-workload/client-toolchain.js'),
    import('../docker-workload/watchdog-policy.js'),
    import('../hardened-fs.js'),
    import('../docker/build-trust-runtime-contract.js'),
  ]);
  const packageRoot = paths.getIronCurtainPackageRoot();
  const architecture = hostContainerArchitecture();
  const assets: { readonly label: string; readonly load: () => unknown }[] = [
    {
      label: 'registry-egress manifest',
      load: () => registry.loadRegistryEgressManifest(paths.getFrozenRegistryEgressManifestPath()),
    },
    {
      label: 'watchdog policy template',
      load: () => watchdog.loadFrozenWatchdogPolicyTemplate(paths.getFrozenWatchdogPolicyTemplatePath()),
    },
    {
      label: 'profile ceiling',
      load: () =>
        hardened.readPackageAsset(paths.getFrozenProfileCeilingPath(), {
          label: 'profile ceiling',
          minBytes: 2,
          maxBytes: 1024 * 1024,
          packageRoot,
        }),
    },
  ];
  if (architecture !== undefined) {
    assets.push(
      {
        label: 'client toolchain manifest',
        load: () => toolchain.loadClientToolchainManifest(paths.getFrozenClientToolchainManifestPath(), architecture),
      },
      {
        label: 'build-trust wrapper',
        load: () =>
          hardened.readPackageAsset(
            resolve(packageRoot, contract.BUILD_TRUST_RUNTIME_CONTRACT.wrapper.packagePaths[architecture]),
            { label: 'packaged build-trust wrapper', minBytes: 64, maxBytes: 32 << 20, packageRoot },
          ),
      },
    );
  }

  const failures: string[] = [];
  for (const asset of assets) {
    try {
      asset.load();
    } catch (err) {
      failures.push(toDisplayText(err instanceof Error ? err.message : String(err), { maxLength: 400 }));
    }
  }
  if (failures.length === 0) {
    return {
      name,
      status: 'ok',
      message: `${assets.length} nested-Docker assets pass the ownership and mode checks (${toDisplayText(packageRoot)})`,
    };
  }
  const enabled = config.userConfig.dockerWorkload?.enabled === true;
  return {
    name,
    status: enabled ? 'fail' : 'warn',
    message: `${failures.length} of ${assets.length} refused: ${listed(failures)}`,
    hint: enabled
      ? 'Nested Docker sessions are refused until these files are fixed (the messages name the fix).'
      : 'Nested Docker (disabled now) would refuse to start until these files are fixed.',
  };
}

/**
 * Reports Docker-workload (nested Docker) leases that fence admission: a
 * lease with a recorded incident (cleanup that could not be proven) or a
 * lease record that cannot be read. Each new admission retries their
 * cleanup first and refuses while any remains fenced. Undefined when there
 * is nothing to report and nested Docker is off.
 */
export async function checkDockerWorkloadLeases(config: IronCurtainConfig): Promise<CheckResult | undefined> {
  const name = 'Nested Docker leases';
  const enabled = config.userConfig.dockerWorkload?.enabled === true;
  const root = getDockerWorkloadLeasesRoot();
  let leaseIds: string[];
  try {
    leaseIds = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    leaseIds = [];
  }
  if (leaseIds.length === 0) return enabled ? { name, status: 'ok', message: 'none' } : undefined;

  const { loadDockerWorkloadLease } = await import('../docker-workload/bundle-lease.js');
  const fenced: string[] = [];
  let open = 0;
  for (const leaseId of leaseIds) {
    const leasePath = join(root, leaseId, 'lease.json');
    let lease;
    try {
      lease = loadDockerWorkloadLease(leasePath);
    } catch (err) {
      if (entryExists(leasePath)) {
        fenced.push(
          `${toDisplayText(leaseId)} (lease record is unreadable: ${toDisplayText(err instanceof Error ? err.message : String(err), { maxLength: 160 })})`,
        );
      }
      continue;
    }
    if (lease.status === 'closed') continue;
    if (lease.incident !== null) {
      fenced.push(
        `${toDisplayText(leaseId)} (${toDisplayText(lease.incident.code)} at ${toDisplayText(lease.incident.recordedAt)}: ` +
          `${toDisplayText(lease.incident.detail, { maxLength: 160 })})`,
      );
    } else {
      open++;
    }
  }
  const openNote = open > 0 ? `${open} open (live, or reclaimed by the next admission)` : undefined;
  if (fenced.length === 0) {
    return { name, status: 'ok', message: openNote ?? 'all closed' };
  }
  return {
    name,
    status: enabled ? 'fail' : 'warn',
    message:
      `${fenced.length} fenced, blocking nested-Docker admission: ${listed(fenced)}` +
      (openNote === undefined ? '' : `; ${openNote}`),
    hint:
      'Each nested-Docker admission first retries their cleanup through the container runtime the lease ' +
      'recorded; start that runtime. `ironcurtain docker-workload status` shows each lease, ' +
      '`ironcurtain docker-workload reconcile` retries the recovery now, and ' +
      '`ironcurtain docker-workload clear <lease-id> --force` removes what a fenced lease still owns by its ' +
      `generation label and retires its record (records live under ${shellWord(root)}).`,
  };
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
