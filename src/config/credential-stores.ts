/**
 * Host credential stores that agents may never read or write.
 *
 * Every path listed here becomes a PolicyEngine protected path
 * (`computeProtectedPaths` in ./index.ts): a tool-call path argument that
 * resolves to one, or inside one, is denied before any compiled rule runs, so
 * no constitution, persona, approval or broad "allow reads in ~" rule can
 * grant access. Paths are protected whether or not they exist, so an agent
 * cannot create one either.
 *
 * Two tiers:
 * - **Core** stores are the credential files IronCurtain itself reads: the
 *   Claude Code and Anthropic CLI OAuth stores and the Codex auth cache (the
 *   Docker MITM swaps their real tokens in on the host and keeps them out of
 *   containers), and IronCurtain's own `<home>/oauth` directory. They honour
 *   the same environment overrides as the readers (ANTHROPIC_CONFIG_DIR,
 *   XDG_CONFIG_HOME, CODEX_HOME) and also keep the default locations. Config
 *   cannot remove them.
 * - **Extended** stores are other well-known host credentials (SSH keys, cloud
 *   and registry CLIs, ...). They are protected by default; config.json can
 *   opt individual ones out by id (`credentialProtection.disabledStores`) and
 *   add more paths (`credentialProtection.extraPaths`).
 *
 * The readers in src/docker/oauth-credentials.ts call the path helpers below,
 * so the file IronCurtain reads and the file it protects cannot drift apart.
 * The OS sandbox's read-deny baseline for MCP servers
 * (`BASELINE_CREDENTIAL_DENY_READ` in src/trusted-process/sandbox-integration.ts)
 * is built from the extended stores' locations
 * ({@link extendedCredentialStoreHomePaths}) for the same reason.
 */

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { getOAuthDir } from './paths.js';
import { getTrustedEnvFilePaths } from './trusted-env.js';

/** Credential stores IronCurtain itself reads. Always protected. */
export const CORE_CREDENTIAL_STORE_IDS = ['claude-code', 'anthropic-cli', 'codex', 'ironcurtain-oauth'] as const;
export type CoreCredentialStoreId = (typeof CORE_CREDENTIAL_STORE_IDS)[number];

/**
 * Other host credential stores, protected by default. Each id can be listed in
 * `credentialProtection.disabledStores` to stop protecting it.
 */
export const EXTENDED_CREDENTIAL_STORE_IDS = [
  'ssh',
  'aws',
  'gnupg',
  'gcloud',
  'docker',
  'git-credentials',
  'netrc',
  'npmrc',
  'gh',
  'kube',
] as const;
export type ExtendedCredentialStoreId = (typeof EXTENDED_CREDENTIAL_STORE_IDS)[number];

/** The `credentialProtection` block of config.json. */
export interface CredentialProtectionSettings {
  /** More paths to protect: absolute, or `~` / `~/...` for the home directory. */
  readonly extraPaths?: readonly string[];
  /** Extended stores to stop protecting. Core store ids are never honoured here. */
  readonly disabledStores?: readonly string[];
}

export interface ProtectedCredentialStore {
  /** Store id (core or extended), or `user` for `extraPaths` entries. */
  readonly id: string;
  readonly tier: 'core' | 'extended' | 'user';
  /** Absolute file or directory paths, protected whether or not they exist. */
  readonly paths: readonly string[];
}

/** Extended stores and where they live under the home directory. */
const EXTENDED_STORE_PATHS: Readonly<Record<ExtendedCredentialStoreId, readonly (readonly string[])[]>> = {
  // The whole directory: private keys, config (ProxyCommand), known_hosts and
  // authorized_keys are all either secrets or persistence/MITM vectors.
  ssh: [['.ssh']],
  aws: [['.aws']],
  gnupg: [['.gnupg']],
  gcloud: [['.config', 'gcloud']],
  docker: [['.docker', 'config.json']],
  'git-credentials': [['.git-credentials']],
  netrc: [['.netrc']],
  npmrc: [['.npmrc']],
  gh: [['.config', 'gh']],
  kube: [['.kube', 'config']],
};

/**
 * Where an extended store lives, spelled from the home directory with a
 * leading `~/` (`['~/.config/gcloud']` for `gcloud`): the spelling srt
 * settings and a server's `allowRead` use. The OS sandbox's read-deny
 * baseline is built from these, so a store added here is hidden from
 * sandboxed MCP servers as well as protected from the agent.
 */
export function extendedCredentialStoreHomePaths(id: ExtendedCredentialStoreId): string[] {
  return EXTENDED_STORE_PATHS[id].map((parts) => `~/${parts.join('/')}`);
}

/** A non-empty environment value, or undefined (an empty value means "unset"). */
function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

/** Claude Code's OAuth credential file: `~/.claude/.credentials.json`. */
export function getClaudeCodeCredentialsPath(): string {
  return resolve(homedir(), '.claude', '.credentials.json');
}

/**
 * The Anthropic CLI config directory:
 * ANTHROPIC_CONFIG_DIR > $XDG_CONFIG_HOME/anthropic > ~/.config/anthropic.
 * Empty variables fall through to the next candidate.
 */
export function getAnthropicCliConfigDir(): string {
  const configDir = envValue('ANTHROPIC_CONFIG_DIR');
  if (configDir) return resolve(configDir);
  const xdg = envValue('XDG_CONFIG_HOME');
  return xdg ? resolve(xdg, 'anthropic') : resolve(homedir(), '.config', 'anthropic');
}

/** The Anthropic CLI default-profile credential file IronCurtain reads. */
export function getAnthropicCliCredentialsPath(): string {
  return resolve(getAnthropicCliConfigDir(), 'credentials', 'default.json');
}

/** The Codex CLI auth cache: `$CODEX_HOME/auth.json`, default `~/.codex/auth.json`. */
export function getCodexAuthPath(): string {
  return resolve(envValue('CODEX_HOME') ?? resolve(homedir(), '.codex'), 'auth.json');
}

/**
 * True when `path` is acceptable in `credentialProtection.extraPaths`: an
 * absolute path, `~`, or `~/...`. Relative paths are rejected because they
 * would protect a different file in every working directory.
 */
export function isAcceptedExtraProtectedPath(path: string): boolean {
  if (path.includes('\0')) return false;
  return path === '~' || path.startsWith('~/') || isAbsolute(path);
}

/** Expands a leading `~` and normalizes; throws for anything not accepted above. */
function expandExtraPath(path: string): string {
  if (!isAcceptedExtraProtectedPath(path)) {
    throw new Error(
      `credentialProtection.extraPaths entries must be absolute or start with ~/, got ${JSON.stringify(path)}`,
    );
  }
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function coreStores(): ProtectedCredentialStore[] {
  const home = homedir();
  const anthropicDirs = [getAnthropicCliConfigDir(), resolve(home, '.config', 'anthropic')];
  const xdg = envValue('XDG_CONFIG_HOME');
  if (xdg) anthropicDirs.push(resolve(xdg, 'anthropic'));
  return [
    { id: 'claude-code', tier: 'core', paths: [getClaudeCodeCredentialsPath()] },
    {
      // The whole credentials directory: the CLI keeps one file per profile.
      id: 'anthropic-cli',
      tier: 'core',
      paths: unique(anthropicDirs.map((dir) => resolve(dir, 'credentials'))),
    },
    { id: 'codex', tier: 'core', paths: unique([getCodexAuthPath(), resolve(home, '.codex', 'auth.json')]) },
    { id: 'ironcurtain-oauth', tier: 'core', paths: [getOAuthDir()] },
  ];
}

/**
 * Lists every protected credential store: all core stores, the extended
 * stores not opted out, and the user's extra paths. Unknown or core ids in
 * `disabledStores` are ignored, so core stores can never be removed.
 *
 * @throws Error when an `extraPaths` entry is relative (config validation
 *   rejects those first; a caller passing one is a bug, so fail closed).
 */
export function listProtectedCredentialStores(settings: CredentialProtectionSettings = {}): ProtectedCredentialStore[] {
  const home = homedir();
  const disabled = new Set(settings.disabledStores ?? []);
  const stores = coreStores();
  for (const id of EXTENDED_CREDENTIAL_STORE_IDS) {
    if (disabled.has(id)) continue;
    stores.push({ id, tier: 'extended', paths: EXTENDED_STORE_PATHS[id].map((parts) => resolve(home, ...parts)) });
  }
  const extra = (settings.extraPaths ?? []).map(expandExtraPath);
  if (extra.length > 0) stores.push({ id: 'user', tier: 'user', paths: unique(extra) });
  return stores;
}

/** The flattened, de-duplicated paths of {@link listProtectedCredentialStores}. */
export function computeCredentialStoreProtectedPaths(settings?: CredentialProtectionSettings): string[] {
  return unique(listProtectedCredentialStores(settings).flatMap((store) => store.paths));
}

/** Path-only additions to the fixed OS-sandbox baseline; never reads credential files. */
export function computeSandboxCredentialPaths(settings?: CredentialProtectionSettings): string[] {
  return unique([
    ...listProtectedCredentialStores(settings)
      .filter((store) => store.tier !== 'extended')
      .flatMap((store) => store.paths),
    ...getTrustedEnvFilePaths(),
  ]);
}
