/**
 * OAuth credential checks for `ironcurtain doctor`.
 *
 * Every run (offline, read-only):
 *   - the Anthropic credentials Docker sessions use (OAuth and its expiry,
 *     or an API key);
 *   - Codex's ChatGPT login (`~/.codex/auth.json`), when there is one;
 *   - every IronCurtain OAuth provider (Google Workspace) whose MCP server
 *     is configured: its client credentials, the stored token, the access
 *     token's expiry and, for an access token that already expired, whether
 *     the refresh token may have expired too (Google expires the refresh
 *     tokens of Testing-mode apps seven days after authorization).
 *
 * `--check-api`: a cheap authenticated request with the current access
 * token, never a refresh grant: Anthropic `GET /api/oauth/usage`, the
 * provider's token-introspection endpoint for IronCurtain's providers. It
 * shows the token is accepted and reports when it expires. An expired access
 * token is not refreshed to test it.
 *
 * `--check-refresh`: the refresh grant itself, only on that explicit
 * request. Anthropic rotates the refresh token on every grant, so the copy a
 * running Claude Code, Anthropic CLI or other IronCurtain process holds in
 * memory stops working; the rotated credentials are written back to the file
 * they came from, as a session would. Credentials in the macOS Keychain are
 * not refreshed here: doctor never writes the Keychain. Each IronCurtain
 * OAuth provider's refresh token is tested the way a session's relay uses it,
 * and the new access token saved to its token file.
 *
 * Split from checks.ts so the code that can touch the credentials file lives
 * next to oauth-credentials.ts and out of the general-purpose check surface.
 */

import { statSync } from 'node:fs';
import { loadClientCredentials, type OAuthProviderConfig } from '../auth/oauth-provider.js';
import { getAllOAuthProviders } from '../auth/oauth-registry.js';
import { OAuthTokenExpiredError, OAuthTokenProvider } from '../auth/oauth-token-provider.js';
import { loadOAuthToken } from '../auth/oauth-token-store.js';
import { getOAuthTokenPath } from '../config/paths.js';
import {
  detectAuthMethod,
  getCodexAuthFilePath,
  isTokenExpired,
  loadCodexOAuthCredentials,
  refreshOAuthToken,
  saveOAuthCredentials,
  readOnlyCredentialSources,
  type AuthMethod,
  type OAuthClientKind,
  type RefreshResult,
} from '../docker/oauth-credentials.js';
import type { IronCurtainConfig } from '../config/types.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import type { CheckResult, CheckStatus } from './checks.js';

/** Hard cap on each validation request; healthy ones take well under a second. */
const VALIDATION_TIMEOUT_MS = 15_000;

/** Anthropic's OAuth-session usage endpoint: authenticated, and it runs no model. */
const ANTHROPIC_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** Beta flag Anthropic requires on requests authenticated with an OAuth access token. */
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';

/** Google expires the refresh tokens of OAuth apps in "Testing" status this long after authorization. */
const TESTING_MODE_REFRESH_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Injectable network for the `--check-api` / `--check-refresh` checks. */
export interface OAuthCheckDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

/** The re-authentication command for the CLI that issued a credential. */
function loginCommand(clientKind: OAuthClientKind | undefined): string {
  return clientKind === 'anthropic-cli' ? '`ant auth login`' : '`claude login`';
}

/** "3 days", "5h", "12m" until (or since) `ms`. */
function describeDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs >= DAY_MS) {
    const days = Math.floor(abs / DAY_MS);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (abs >= HOUR_MS) return `${Math.floor(abs / HOUR_MS)}h`;
  return `${Math.max(1, Math.floor(abs / 60_000))}m`;
}

/**
 * Computes a human-readable description for an OAuth-typed AuthMethod,
 * including expiry information.
 */
function describeOAuthExpiry(auth: Extract<AuthMethod, { kind: 'oauth' }>): {
  message: string;
  status: CheckStatus;
  hint?: string;
} {
  const remainingMs = auth.credentials.expiresAt - Date.now();
  if (remainingMs <= 0) {
    return {
      message: 'OAuth (expired)',
      status: 'warn',
      hint: `Token will be refreshed automatically on next use, or run ${loginCommand(auth.credentials.clientKind)} to re-authenticate.`,
    };
  }
  const remainingDays = Math.floor(remainingMs / DAY_MS);
  if (remainingDays >= 1) {
    return {
      message: `OAuth (expires in ${remainingDays} day${remainingDays === 1 ? '' : 's'})`,
      status: 'ok',
    };
  }
  const remainingHours = Math.max(1, Math.floor(remainingMs / HOUR_MS));
  if (isTokenExpired(auth.credentials)) {
    return {
      message: `OAuth (expires in ${remainingHours}h, will auto-refresh)`,
      status: 'ok',
    };
  }
  return {
    message: `OAuth (expires in ${remainingHours}h)`,
    status: 'ok',
  };
}

/**
 * Checks Anthropic credential availability. Uses detectAuthMethod with
 * no-refresh sources so doctor never rewrites the credentials file just
 * by being run.
 */
export async function checkAnthropicCredentials(config: IronCurtainConfig): Promise<CheckResult> {
  const auth = await detectAuthMethod(config, readOnlyCredentialSources);

  if (auth.kind === 'oauth') {
    const desc = describeOAuthExpiry(auth);
    return { name: 'Anthropic', status: desc.status, message: desc.message, hint: desc.hint };
  }
  if (auth.kind === 'apikey') {
    return { name: 'Anthropic', status: 'ok', message: 'API key set' };
  }
  return {
    name: 'Anthropic',
    status: 'warn',
    message: 'no credentials detected',
    hint: 'Set ANTHROPIC_API_KEY or run `claude login` to obtain OAuth credentials.',
  };
}

/**
 * Reports Codex's ChatGPT login (`$CODEX_HOME/auth.json`) and its access
 * token's expiry. Undefined when there is no ChatGPT login to report, which
 * is the normal state for anyone not using the Codex agent with it.
 */
export function checkCodexCredentials(now: () => number = Date.now): CheckResult | undefined {
  const credentials = loadCodexOAuthCredentials();
  if (credentials === null) return undefined;
  const name = 'Codex (ChatGPT)';
  const remainingMs = credentials.expiresAt - now();
  const where = toDisplayText(getCodexAuthFilePath());
  if (remainingMs > 0) {
    return {
      name,
      status: 'ok',
      message: `OAuth (access token expires in ${describeDuration(remainingMs)}; ${where})`,
    };
  }
  if (credentials.refreshToken === '') {
    return {
      name,
      status: 'warn',
      message: `OAuth access token expired ${describeDuration(remainingMs)} ago and there is no refresh token (${where})`,
      hint: 'Run `codex login` to sign in again.',
    };
  }
  return {
    name,
    status: 'ok',
    message: `OAuth (access token expired ${describeDuration(remainingMs)} ago; refreshed on next use; ${where})`,
  };
}

/** The IronCurtain OAuth providers whose MCP servers are configured. */
function configuredProviders(config: IronCurtainConfig): OAuthProviderConfig[] {
  return getAllOAuthProviders().filter((provider) =>
    provider.serverNames.some((server) => Object.hasOwn(config.mcpServers, server)),
  );
}

/**
 * Reports each configured IronCurtain OAuth provider (Google Workspace):
 *
 *   - no client credentials        -> skip (its servers are skipped by sessions)
 *   - unreadable client credentials -> fail
 *   - not authorized               -> warn (its servers are skipped by sessions)
 *   - unreadable token             -> warn
 *   - authorized                   -> ok, with the access token's expiry; warn
 *     when the access token expired and the token file was last written more
 *     than seven days ago (a Testing-mode refresh token is dead by then)
 */
export function checkOAuthProviders(config: IronCurtainConfig, now: () => number = Date.now): CheckResult[] {
  return configuredProviders(config).map((provider) => checkOAuthProvider(provider, now()));
}

function checkOAuthProvider(provider: OAuthProviderConfig, nowMs: number): CheckResult {
  const name = provider.displayName;
  const servers = provider.serverNames.join(', ');
  let clientConfigured: boolean;
  try {
    clientConfigured = loadClientCredentials(provider) !== null;
  } catch (err) {
    return {
      name,
      status: 'fail',
      message: `client credentials are unreadable: ${toDisplayText(err instanceof Error ? err.message : String(err))}`,
      hint: `Re-import them with \`ironcurtain auth import ${provider.id} <credentials-file>\`.`,
    };
  }
  if (!clientConfigured) {
    return {
      name,
      status: 'skip',
      message: `not configured; sessions skip ${servers}`,
      hint: `To use it: \`ironcurtain auth import ${provider.id} <credentials-file>\`, then \`ironcurtain auth ${provider.id}\`.`,
    };
  }
  let token;
  try {
    token = loadOAuthToken(provider.id);
  } catch (err) {
    return {
      name,
      status: 'warn',
      message: `the stored token is unreadable, so sessions skip ${servers}: ${toDisplayText(err instanceof Error ? err.message : String(err))}`,
      hint: `Run \`ironcurtain auth ${provider.id}\` to authorize again.`,
    };
  }
  if (token === null) {
    return {
      name,
      status: 'warn',
      message: `client credentials imported but not authorized; sessions skip ${servers}`,
      hint: `Run \`ironcurtain auth ${provider.id}\`.`,
    };
  }
  const scopes = `${token.scopes.length} scope${token.scopes.length === 1 ? '' : 's'}`;
  const remainingMs = token.expiresAt - nowMs;
  if (remainingMs > 0) {
    return {
      name,
      status: 'ok',
      message: `authorized (${scopes}; access token expires in ${describeDuration(remainingMs)}, refreshed automatically)`,
    };
  }
  const writtenAgoMs = tokenFileAgeMs(provider, nowMs);
  if (writtenAgoMs !== undefined && writtenAgoMs > TESTING_MODE_REFRESH_TOKEN_LIFETIME_MS) {
    return {
      name,
      status: 'warn',
      message:
        `authorized (${scopes}), but the access token expired ${describeDuration(remainingMs)} ago and the token was ` +
        `last refreshed ${describeDuration(writtenAgoMs)} ago`,
      hint:
        'If your Google Cloud OAuth app is in "Testing" status, its refresh tokens expire 7 days after ' +
        `authorization and sessions will skip ${servers}: run \`ironcurtain auth ${provider.id}\`. ` +
        '`ironcurtain doctor --check-refresh` tests the refresh token.',
    };
  }
  return {
    name,
    status: 'ok',
    message: `authorized (${scopes}; access token expired ${describeDuration(remainingMs)} ago, refreshed at the next session start)`,
  };
}

/** How long ago the provider's token file was last written (authorization or refresh). */
function tokenFileAgeMs(provider: OAuthProviderConfig, nowMs: number): number | undefined {
  try {
    return nowMs - statSync(getOAuthTokenPath(provider.id)).mtimeMs;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// --check-api: validate without a refresh grant
// ---------------------------------------------------------------------------

/**
 * Sends the current Anthropic OAuth access token to an authenticated
 * endpoint that runs no model (`GET /api/oauth/usage`) and reports whether
 * it is accepted and when it expires. Never runs a refresh grant: an expired
 * access token is reported as not validated (sessions refresh it at start;
 * `--check-refresh` tests the refresh token).
 */
export async function checkAnthropicOAuthToken(
  config: IronCurtainConfig,
  deps: OAuthCheckDeps = {},
): Promise<CheckResult> {
  const name = 'Anthropic OAuth';
  const now = deps.now ?? Date.now;
  const auth = await detectAuthMethod(config, readOnlyCredentialSources);
  if (auth.kind !== 'oauth') {
    return { name, status: 'skip', message: 'no OAuth credentials in file or Keychain' };
  }
  const remainingMs = auth.credentials.expiresAt - now();
  if (remainingMs <= 0) {
    return {
      name,
      status: 'skip',
      message: `access token expired ${describeDuration(remainingMs)} ago, so it was not validated (sessions refresh it at start)`,
      // --check-refresh never refreshes Keychain-stored credentials.
      ...(auth.source === 'keychain'
        ? {}
        : { hint: '`ironcurtain doctor --check-refresh` tests the refresh token (it rotates the token).' }),
    };
  }
  const start = now();
  let response: Response;
  try {
    response = await (deps.fetch ?? globalThis.fetch)(ANTHROPIC_OAUTH_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.credentials.accessToken}`,
        'anthropic-beta': ANTHROPIC_OAUTH_BETA,
      },
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
  } catch (err) {
    return { name, status: 'fail', message: `network error: ${describeFetchError(err)}` };
  }
  await response.body?.cancel().catch(() => undefined);
  const elapsed = formatElapsed(now() - start);
  if (response.ok) {
    return {
      name,
      status: 'ok',
      message: `access token accepted by api.anthropic.com (${elapsed}); expires in ${describeDuration(remainingMs)}`,
    };
  }
  if (response.status === 401) {
    return {
      name,
      status: 'fail',
      message: `access token rejected (HTTP 401, ${elapsed})`,
      hint: `Run ${loginCommand(auth.credentials.clientKind)} to sign in again.`,
    };
  }
  return {
    name,
    status: 'warn',
    message: `access token could not be validated (HTTP ${response.status}, ${elapsed})`,
  };
}

/**
 * For each configured IronCurtain OAuth provider with a token-introspection
 * endpoint, sends the stored access token there (form POST, never a URL
 * query) and reports whether it is accepted and its remaining lifetime.
 * An expired access token is not refreshed to test it.
 */
export async function checkOAuthProviderTokens(
  config: IronCurtainConfig,
  deps: OAuthCheckDeps = {},
): Promise<CheckResult[]> {
  const now = deps.now ?? Date.now;
  const results: CheckResult[] = [];
  for (const provider of configuredProviders(config)) {
    if (provider.tokenInfoUrl === undefined) continue;
    const name = `${provider.displayName} token`;
    let token;
    try {
      token = loadOAuthToken(provider.id);
    } catch {
      token = null;
    }
    // Not authorized (or unreadable): the Credentials section says so.
    if (token === null) continue;
    const remainingMs = token.expiresAt - now();
    if (remainingMs <= 0) {
      results.push({
        name,
        status: 'skip',
        message: 'access token expired, so it was not validated (sessions refresh it at start)',
        hint: '`ironcurtain doctor --check-refresh` tests the refresh token.',
      });
      continue;
    }
    results.push(await validateProviderToken(name, provider, provider.tokenInfoUrl, token.accessToken, deps, now));
  }
  return results;
}

async function validateProviderToken(
  name: string,
  provider: OAuthProviderConfig,
  url: string,
  accessToken: string,
  deps: OAuthCheckDeps,
  now: () => number,
): Promise<CheckResult> {
  const start = now();
  let response: Response;
  try {
    response = await (deps.fetch ?? globalThis.fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: accessToken }).toString(),
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
  } catch (err) {
    return { name, status: 'fail', message: `network error: ${describeFetchError(err)}` };
  }
  const elapsed = formatElapsed(now() - start);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return response.status === 400 || response.status === 401
      ? {
          name,
          status: 'fail',
          message: `access token rejected (HTTP ${response.status}, ${elapsed})`,
          hint: `Run \`ironcurtain auth ${provider.id}\` to authorize again.`,
        }
      : { name, status: 'warn', message: `access token could not be validated (HTTP ${response.status}, ${elapsed})` };
  }
  let expiresIn: number | undefined;
  try {
    const body = (await response.json()) as { expires_in?: unknown };
    const raw = typeof body.expires_in === 'string' ? Number(body.expires_in) : body.expires_in;
    expiresIn = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  } catch {
    expiresIn = undefined;
  }
  return {
    name,
    status: 'ok',
    message:
      `access token accepted (${elapsed})` +
      (expiresIn === undefined ? '' : `; expires in ${describeDuration(expiresIn * 1000)}`),
  };
}

// ---------------------------------------------------------------------------
// --check-refresh: the refresh grant, only on explicit request
// ---------------------------------------------------------------------------

/**
 * Exchanges the stored Anthropic refresh token for new credentials. Runs
 * only under `doctor --check-refresh`. Anthropic rotates refresh tokens, so
 * the new credentials MUST be persisted: they are written back to the file
 * they came from (keeping what the host CLI stored meanwhile, like a
 * session's write-back). Keychain-stored credentials are skipped, because
 * doctor never writes the Keychain.
 */
export async function checkOAuthRefresh(config: IronCurtainConfig, deps: OAuthCheckDeps = {}): Promise<CheckResult> {
  const name = 'OAuth refresh';
  const now = deps.now ?? Date.now;
  const auth = await detectAuthMethod(config, readOnlyCredentialSources);
  if (auth.kind !== 'oauth') {
    return { name, status: 'skip', message: 'no OAuth credentials in file or Keychain' };
  }
  if (auth.source === 'keychain') {
    return {
      name,
      status: 'skip',
      message:
        'the credentials are in the macOS Keychain; doctor never writes the Keychain, so it does not run a refresh ' +
        'grant for them (sessions refresh and store them)',
    };
  }

  let result: RefreshResult;
  let elapsed: string;
  try {
    const start = now();
    result = await refreshOAuthToken(auth.credentials.refreshToken, auth.credentials.clientKind);
    elapsed = formatElapsed(now() - start);
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return {
      name,
      status: 'fail',
      message: (err instanceof Error ? err.message : String(err)) + cause,
    };
  }

  if (result.kind !== 'ok') {
    return formatRefreshFailure(result, elapsed, auth.credentials.clientKind);
  }

  // Refresh succeeded server-side; the old refresh token is now consumed.
  // If we can't persist the rotated credentials, the host is effectively
  // logged out — surface that clearly rather than swallowing the write error.
  try {
    saveOAuthCredentials(result.credentials, auth.filePath, { refreshedFrom: auth.credentials.refreshToken });
  } catch (err) {
    return {
      name,
      status: 'fail',
      message: `refresh succeeded but persistence failed: ${err instanceof Error ? err.message : String(err)}`,
      hint: `The server-side refresh token has rotated; your stored credentials are now invalid. Run ${loginCommand(auth.credentials.clientKind)} to recover.`,
    };
  }

  return { name, status: 'ok', message: `valid (${elapsed}, file); the rotated token was saved` };
}

/**
 * Tests the refresh token of each configured IronCurtain OAuth provider
 * (Google Workspace) with a refresh grant, the way a session's relay
 * refreshes it (`OAuthTokenProvider.forceRefresh`), and saves the new access
 * token as the relay does (under the token file's lock). Runs only under
 * `doctor --check-refresh`. Google keeps the refresh token on a refresh
 * grant, so the copy a running session holds stays valid. This is the only
 * reliable test of a Testing-mode app's refresh token, which expires seven
 * days after authorization however often it is used.
 */
export async function checkOAuthProviderRefresh(config: IronCurtainConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const provider of configuredProviders(config)) {
    let clientCredentials;
    let token;
    try {
      clientCredentials = loadClientCredentials(provider);
      token = loadOAuthToken(provider.id);
    } catch {
      continue; // Unreadable files: the Credentials section reports them.
    }
    // Not configured or not authorized: nothing to test (reported above).
    if (clientCredentials === null || token === null) continue;
    const name = `${provider.displayName} refresh`;
    const start = Date.now();
    try {
      await new OAuthTokenProvider(provider, clientCredentials).forceRefresh();
      results.push({
        name,
        status: 'ok',
        message: `refresh token accepted (${formatElapsed(Date.now() - start)}); the new access token was saved`,
      });
    } catch (err) {
      const message = toDisplayText(err instanceof Error ? err.message : String(err), { maxLength: 300 });
      results.push(
        err instanceof OAuthTokenExpiredError
          ? {
              name,
              status: 'fail',
              message: `refresh rejected: ${message}`,
              hint: `Sessions skip ${provider.serverNames.join(', ')} until you run \`ironcurtain auth ${provider.id}\`.`,
            }
          : // A network error, or the new token could not be saved.
            {
              name,
              status: 'fail',
              message: `the refresh could not be completed: ${toDisplayText(describeFetchError(err), { maxLength: 300 })}`,
            },
      );
    }
  }
  return results;
}

function formatRefreshFailure(
  result: Exclude<RefreshResult, { kind: 'ok' }>,
  elapsed: string,
  clientKind: OAuthClientKind | undefined,
): CheckResult {
  if (result.kind === 'http-error') {
    return {
      name: 'OAuth refresh',
      status: 'fail',
      message: `refresh rejected (HTTP ${result.status}, ${elapsed})`,
      hint:
        result.status === 400 || result.status === 401
          ? `Refresh token has been invalidated (likely consumed by an earlier refresh). Run ${loginCommand(clientKind)} to issue a new one.`
          : `Run ${loginCommand(clientKind)} to obtain a new refresh token.`,
    };
  }
  if (result.kind === 'parse-error') {
    return {
      name: 'OAuth refresh',
      status: 'fail',
      message: `refresh response unparseable (${elapsed})`,
      hint: result.detail,
    };
  }
  return {
    name: 'OAuth refresh',
    status: 'fail',
    message: `network error (${elapsed})`,
    hint: result.message,
  };
}

function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
  return `${err.message}${cause}`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
