/**
 * CLI entry point for `ironcurtain auth` subcommands.
 *
 * Manages third-party OAuth providers: credential import, authorization,
 * status checking, and token revocation.
 *
 * Subcommands:
 *   ironcurtain auth                           - show status of all providers
 *   ironcurtain auth import <provider> <file>  - import OAuth client credentials
 *   ironcurtain auth <provider>                - authorize a provider (opens browser)
 *   ironcurtain auth <provider> --scopes x,y   - authorize with additional scopes
 *   ironcurtain auth <provider> --no-browser   - authorize from a headless host (paste the redirect URL)
 *   ironcurtain auth status                    - same as no args
 *   ironcurtain auth revoke <provider>         - revoke and delete stored token
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import { printHelp, type CommandSpec } from '../cli-help.js';
import { getOAuthDir, getOAuthTokenPath } from '../config/paths.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { writePrivateFileAtomicSync } from '../util/atomic-write.js';
import type { OAuthClientCredentials, OAuthProviderConfig, StoredOAuthToken } from './oauth-provider.js';
import { loadClientCredentials, parseClientCredentials } from './oauth-provider.js';
import { getAllOAuthProviders, printAvailableProviders, resolveProviderOrExit } from './oauth-registry.js';
import { runOAuthFlow, fetchWithTimeout, type OAuthFlowOptions, type PasteRedirectRequest } from './oauth-flow.js';
import { deleteOAuthToken, loadOAuthToken, saveOAuthToken } from './oauth-token-store.js';

// ---------------------------------------------------------------------------
// Help specs
// ---------------------------------------------------------------------------

const authSpec: CommandSpec = {
  name: 'ironcurtain auth',
  description: 'Manage third-party OAuth providers for MCP servers',
  usage: [
    'ironcurtain auth                              # Show provider status',
    'ironcurtain auth import <provider> <file>      # Import client credentials',
    'ironcurtain auth <provider>                    # Authorize (opens browser)',
    'ironcurtain auth <provider> --scopes <scopes>  # Authorize with extra scopes',
    'ironcurtain auth <provider> --no-browser       # Authorize on a headless host',
    'ironcurtain auth revoke <provider>             # Revoke stored token',
    'ironcurtain auth status                        # Show provider status',
  ],
  subcommands: [
    { name: 'import <provider> <file>', description: 'Import OAuth client credentials from provider' },
    { name: '<provider>', description: 'Authorize a provider (opens browser for OAuth flow)' },
    { name: 'revoke <provider>', description: 'Revoke and delete stored OAuth token' },
    { name: 'status', description: 'Show authorization status for all providers' },
  ],
  options: [
    { flag: 'scopes', description: 'Comma-separated scopes for incremental consent', placeholder: '<scopes>' },
    {
      flag: 'no-browser',
      description: 'Print the authorization URL instead of opening a browser, then paste the redirected URL back',
    },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: [
    'ironcurtain auth import google ~/Downloads/credentials.json',
    'ironcurtain auth google',
    'ironcurtain auth google --scopes gmail.send,calendar.events',
    'ironcurtain auth google --no-browser',
    'ironcurtain auth revoke google',
    'ironcurtain auth status',
  ],
};

// ---------------------------------------------------------------------------
// Google Cloud setup guide (shown when credentials are missing)
// ---------------------------------------------------------------------------

const GOOGLE_SETUP_GUIDE = `
  Google Cloud Project Setup
  ==========================

  IronCurtain requires you to create your own Google Cloud OAuth credentials.
  This is a one-time setup.

  Step 1: Create a Google Cloud Project
    Go to https://console.cloud.google.com/projectcreate
    Enter a project name (e.g., "IronCurtain") and click Create.

  Step 2: Enable Google Workspace APIs
    Navigate to APIs & Services > Library and enable:
      - Gmail API
      - Google Calendar API
      - Google Drive API

  Step 3: Configure the OAuth Consent Screen
    Navigate to APIs & Services > OAuth consent screen
    Set User type to "External" (or "Internal" for Google Workspace orgs)
    Fill in App name, support email, and developer contact email.
    Add scopes based on what you need:
      Read-only (default):  gmail.readonly, calendar.readonly, drive.readonly
      Write access:         gmail.send, calendar.events, drive.file
    You choose which scopes to enable — write scopes are optional.
    Under Test users, add your Google account email.

    Note: In "Testing" mode, refresh tokens expire after 7 days.
    You will need to re-authorize weekly.

    To add write scopes after initial authorization:
      ironcurtain auth google --scopes gmail.send,calendar.events

  Step 4: Create OAuth Client Credentials
    Navigate to APIs & Services > Credentials
    Click "Create Credentials" > "OAuth client ID"
    Select Application type: "Desktop app"
    Enter a name (e.g., "IronCurtain CLI")
    Click Create, then "Download JSON"

  Step 5: Import into IronCurtain
    ironcurtain auth import google /path/to/downloaded-credentials.json

  For more details, see: docs/designs/third-party-oauth.md
`;

/** Provider-specific setup guides, keyed by provider ID. */
const SETUP_GUIDES: Readonly<Record<string, string>> = {
  google: GOOGLE_SETUP_GUIDE,
};

function showSetupGuide(providerId: string): void {
  const guide = SETUP_GUIDES[providerId];
  if (guide) {
    process.stdout.write(guide);
  }
}

function truncate(value: string, maxLen: number): string {
  return value.length > maxLen ? value.slice(0, maxLen) + '...' : value;
}

// ---------------------------------------------------------------------------
// Import credentials
// ---------------------------------------------------------------------------

/** A downloaded client credentials file is a few hundred bytes; anything this large is not one. */
const MAX_CREDENTIALS_FILE_BYTES = 1024 * 1024;

/**
 * Reads the file to import: a regular file (symlinks to one are fine, this is
 * the user's own path) of plausible size. Throws with a message for the user.
 */
function readCredentialsSource(path: string): Buffer {
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error(`${path} is not a regular file`);
  if (stats.size > MAX_CREDENTIALS_FILE_BYTES) {
    throw new Error(`${path} is ${stats.size} bytes, too large for an OAuth client credentials file`);
  }
  return readFileSync(path);
}

/**
 * Handles `ironcurtain auth import <provider> <credentials-file>`.
 * Shows provider-specific setup guidance when credentials file is not provided.
 *
 * The file is validated before anything is written, then replaces the stored
 * credentials atomically and owner-only (0600, via a temporary file renamed
 * into place), so a wrong or broken file never destroys working credentials.
 */
function importCredentials(args: string[]): void {
  const providerId = args[0];
  const credentialsPath = args[1];

  if (!providerId) {
    process.stdout.write('Usage: ironcurtain auth import <provider> <credentials-file>\n\n');
    printAvailableProviders();
    process.exit(1);
  }

  const provider = resolveProviderOrExit(providerId);

  if (!credentialsPath) {
    process.stdout.write(`Usage: ironcurtain auth import ${providerId} <credentials-file>\n`);
    process.stdout.write('\nProvide the path to the credentials JSON file downloaded from your provider.\n');
    showSetupGuide(provider.id);
    process.exit(1);
    return;
  }

  const resolvedPath = resolve(credentialsPath);

  // Validate first: the stored credentials are replaced only by a file that
  // holds a client_id and client_secret.
  let bytes: Buffer;
  let credentials: OAuthClientCredentials;
  try {
    bytes = readCredentialsSource(resolvedPath);
    credentials = parseClientCredentials(bytes.toString('utf-8'), resolvedPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Invalid credentials file: ${toDisplayText(message)}\n`);
    process.stdout.write('Nothing was imported; any previously imported credentials are unchanged.\n');
    process.exit(1);
    return;
  }

  // Ensure the oauth directory exists and store the file
  const oauthDir = getOAuthDir();
  mkdirSync(oauthDir, { recursive: true, mode: 0o700 });

  const destPath = resolve(oauthDir, provider.credentialsFilename);
  try {
    // Atomic and owner-only from the first byte: the bytes go to a 0600
    // temporary file that is renamed over the old one, so a crash or a full
    // disk leaves either the old or the new credentials, never a partial or
    // world-readable file.
    writePrivateFileAtomicSync(destPath, bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Failed to import credentials: ${toDisplayText(message)}\n`);
    process.exit(1);
    return;
  }

  process.stdout.write(`\n  ${provider.displayName} -- Import OAuth Credentials\n\n`);
  process.stdout.write(`  Found client_id: ${toDisplayText(truncate(credentials.clientId, 20))}\n`);
  process.stdout.write(`  Credentials saved to ${destPath}\n\n`);
  process.stdout.write(`  Next step: run 'ironcurtain auth ${provider.id}' to authorize.\n\n`);
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

function showStatus(): void {
  const providers = getAllOAuthProviders();

  if (providers.length === 0) {
    process.stdout.write('No OAuth providers registered.\n');
    return;
  }

  process.stdout.write('\nOAuth Provider Status:\n\n');

  for (const provider of providers) {
    let credStatus: string;
    try {
      credStatus = loadClientCredentials(provider) !== null ? 'configured' : 'not configured';
    } catch {
      credStatus = 'invalid';
    }
    const tokenPath = getOAuthTokenPath(provider.id);
    const hasToken = existsSync(tokenPath);

    const tokenStatus = hasToken ? 'authorized' : 'not authorized';

    process.stdout.write(`  ${provider.displayName} (${provider.id})\n`);
    process.stdout.write(`    Credentials: ${credStatus}\n`);
    process.stdout.write(`    Token:       ${tokenStatus}\n`);
    process.stdout.write('\n');
  }
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/**
 * What the provider's revocation endpoint said:
 *   - `revoked`: it confirmed the revocation (2xx).
 *   - `already-invalid`: it rejected the token as not valid (`400
 *     invalid_token`: already revoked or expired), so nothing is left to revoke.
 *   - `no-endpoint`: the provider has no revocation endpoint.
 *   - `failed`: anything else (network error, timeout, 5xx, another 4xx); the
 *     token may well still be valid at the provider.
 */
type RevocationOutcome = 'revoked' | 'already-invalid' | 'no-endpoint' | 'failed';

/**
 * Revokes the stored token at the provider, then deletes the local copy, but
 * only when the provider confirmed that the token is revoked (or was no
 * longer valid). Otherwise the token is kept, so it can still be revoked
 * later, and the command says how; deleting it would leave a live grant with
 * no local copy to revoke it with, while reporting success.
 */
async function revokeToken(providerId: string): Promise<void> {
  const provider = resolveProviderOrExit(providerId);

  const token = loadOAuthToken(provider.id);
  if (!token) {
    process.stdout.write(`No stored token found for ${provider.displayName}.\n`);
    return;
  }

  const outcome = await revokeTokenRemotely(provider, token);
  const tokenPath = getOAuthTokenPath(provider.id);
  if (outcome === 'failed') {
    process.stdout.write(
      `The token was NOT revoked: ${provider.displayName} did not confirm the revocation. ` +
        `The stored token was kept at ${tokenPath}.\n` +
        `Run 'ironcurtain auth revoke ${provider.id}' again later` +
        (provider.manualRevocationUrl ? `, or revoke IronCurtain's access at ${provider.manualRevocationUrl}` : '') +
        '.\n',
    );
    process.exitCode = 1;
    return;
  }

  deleteOAuthToken(provider.id);
  if (outcome === 'revoked') {
    process.stdout.write(`Token revoked for ${provider.displayName}.\n`);
  } else if (outcome === 'already-invalid') {
    process.stdout.write(
      `${provider.displayName} reports the token is no longer valid (already revoked or expired); nothing left to revoke.\n`,
    );
  } else {
    process.stdout.write(
      `${provider.displayName} has no revocation endpoint, so only the local token was deleted` +
        (provider.manualRevocationUrl ? `; revoke IronCurtain's access at ${provider.manualRevocationUrl}` : '') +
        '.\n',
    );
  }
  process.stdout.write(`Deleted: ${tokenPath}\n`);
}

/** Most of a revocation error body that is worth showing. */
const REVOCATION_ERROR_DISPLAY_CHARS = 300;

/**
 * Calls the provider's token revocation endpoint to invalidate the token
 * server-side, and reports what it said. Never throws: a failure is printed
 * as a warning and returned as `failed`.
 */
async function revokeTokenRemotely(provider: OAuthProviderConfig, token: StoredOAuthToken): Promise<RevocationOutcome> {
  if (!provider.revocationUrl) {
    return 'no-endpoint';
  }

  // Prefer revoking the refresh token (invalidates both access and refresh)
  const tokenToRevoke = token.refreshToken || token.accessToken;

  const REVOCATION_TIMEOUT_MS = 10_000;
  try {
    const response = await fetchWithTimeout(
      provider.revocationUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokenToRevoke }).toString(),
      },
      REVOCATION_TIMEOUT_MS,
    );

    if (response.ok) return 'revoked';
    const text = await response.text();
    if (response.status === 400 && isInvalidTokenError(text)) return 'already-invalid';
    process.stdout.write(
      `Warning: Server-side revocation returned ${response.status}: ` +
        `${toDisplayText(text, { maxLength: REVOCATION_ERROR_DISPLAY_CHARS })}\n`,
    );
    return 'failed';
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      process.stdout.write(`Warning: Revocation request timed out after ${REVOCATION_TIMEOUT_MS}ms\n`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`Warning: Could not reach revocation endpoint: ${toDisplayText(message)}\n`);
    }
    return 'failed';
  }
}

/** True for an RFC 7009 `{"error": "invalid_token"}` body (how Google rejects a dead token). */
function isInvalidTokenError(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && (parsed as { error?: unknown }).error === 'invalid_token';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Authorize
// ---------------------------------------------------------------------------

/**
 * Parses optional --scopes flag from remaining args after the provider name.
 * Returns the scopes array, or undefined if not specified.
 */
function parseScopesArg(args: string[]): readonly string[] | undefined {
  // args is everything after the provider name
  if (args.length === 0) {
    return undefined;
  }

  const scopesFlagPresent = args.includes('--scopes');

  try {
    const { values } = parseArgs({
      args,
      options: {
        scopes: { type: 'string' },
      },
      strict: false,
    });

    if (typeof values.scopes === 'string' && values.scopes.length > 0) {
      return values.scopes
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  } catch (err) {
    if (scopesFlagPresent) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse --scopes: ${message}`, { cause: err });
    }
    // --scopes not present: ignore unrelated parse errors
  }

  return undefined;
}

/** True when the args after the provider name include `--no-browser`. */
function hasNoBrowserFlag(args: readonly string[]): boolean {
  return args.includes('--no-browser');
}

/**
 * Headless authorization: prints the authorization URL and asks for the URL
 * the browser was redirected to after consent. On another machine that
 * redirect (to 127.0.0.1 on this host) fails to load, but its address is
 * what the flow needs.
 */
async function promptForRedirectUrl(request: PasteRedirectRequest): Promise<string | undefined> {
  if (request.problem === undefined) {
    process.stdout.write(
      '\n  Open this URL in a browser on any machine and approve access:\n\n' +
        `  ${request.authUrl}\n\n` +
        '  The browser is then sent to a http://127.0.0.1 address. If that page does not load\n' +
        '  (the browser runs on another machine), copy the full URL from the address bar and paste it below.\n\n',
    );
  } else {
    p.log.warn(request.problem);
  }
  const pasted = await p.text({
    message: 'Redirected URL (starts with http://127.0.0.1):',
    signal: request.signal,
    validate: (value) => (!value?.trim() ? 'Paste the full URL from the address bar' : undefined),
  });
  return p.isCancel(pasted) ? undefined : pasted;
}

/**
 * Checks whether any of the selected scopes are non-default for this provider.
 * Used to decide whether to show a consent-screen warning.
 */
function hasNonDefaultScopes(provider: OAuthProviderConfig, scopes: readonly string[]): boolean {
  const defaults = new Set(provider.defaultScopes);
  return scopes.some((s) => !defaults.has(s));
}

/**
 * Shows a warning note about non-default scopes, with optional
 * provider-specific guidance, then prompts for confirmation.
 * Returns false if the user cancels.
 */
async function confirmNonDefaultScopes(provider: OAuthProviderConfig, scopes: readonly string[]): Promise<boolean> {
  if (!hasNonDefaultScopes(provider, scopes)) {
    return true;
  }

  const defaults = new Set(provider.defaultScopes);
  const nonDefault = scopes.filter((s) => !defaults.has(s));

  const scopeList = nonDefault.map((s) => `  ${s}`).join('\n');
  const guidance =
    provider.nonDefaultScopeWarning ??
    'Ensure these scopes are configured with your OAuth provider\nbefore proceeding.';

  p.note(
    `The following non-default scopes were selected:\n\n${scopeList}\n\n${guidance}`,
    'Non-default scopes selected',
  );

  const confirmed = await p.confirm({
    message: 'Continue with authorization?',
    initialValue: true,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    return false;
  }

  return true;
}

async function authorize(providerId: string, extraArgs: string[]): Promise<void> {
  const provider = resolveProviderOrExit(providerId);

  let credentials;
  try {
    credentials = loadClientCredentials(provider);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Invalid credentials for ${provider.displayName}: ${message}\n`);
    process.stdout.write(`Re-import with: ironcurtain auth import ${provider.id} <credentials-file>\n`);
    process.exit(1);
  }
  if (!credentials) {
    process.stdout.write(
      `No credentials configured for ${provider.displayName}.\n` +
        `Run 'ironcurtain auth import ${provider.id} <credentials-file>' first.\n`,
    );
    showSetupGuide(provider.id);
    process.exit(1);
  }

  const requestedScopes = parseScopesArg(extraArgs);

  // Determine effective scopes (merge default + existing + requested for incremental consent)
  let effectiveScopes: readonly string[] | undefined;
  let needsConfirmation = false;

  if (requestedScopes) {
    // --scopes flag: resolve short names and merge with existing
    const resolved = provider.resolveShortScopes ? provider.resolveShortScopes(requestedScopes) : requestedScopes;

    const existingToken = loadOAuthToken(provider.id);
    const existingScopes = existingToken?.scopes ?? [];
    // Always include provider defaults as baseline so --scopes only adds, never drops
    const merged = [...new Set([...provider.defaultScopes, ...existingScopes, ...resolved])];
    effectiveScopes = merged;

    process.stdout.write(`\n  ${provider.displayName} OAuth -- Incremental Consent\n\n`);
    if (existingScopes.length > 0) {
      process.stdout.write('  Existing scopes:\n');
      for (const scope of existingScopes) {
        process.stdout.write(`    - ${scope}\n`);
      }
      process.stdout.write('\n  Requesting additional scopes:\n');
      for (const scope of resolved) {
        if (!existingScopes.includes(scope)) {
          process.stdout.write(`    + ${scope}\n`);
        }
      }
      process.stdout.write('\n');
    }
  } else if (process.stdin.isTTY && provider.scopePicker) {
    // Interactive TTY: show the scope picker
    const existingToken = loadOAuthToken(provider.id);
    const existingScopes = existingToken?.scopes ?? [];

    const selected = await provider.scopePicker(existingScopes);
    if (p.isCancel(selected)) {
      p.cancel('Authorization cancelled.');
      return;
    }

    effectiveScopes = selected;
    needsConfirmation = true;
  } else {
    // Non-interactive: use defaults
    process.stdout.write(`\n  ${provider.displayName} OAuth\n\n`);
    process.stdout.write(`  Using credentials: ${truncate(credentials.clientId, 30)}\n`);
    process.stdout.write(`  Requesting scopes: ${provider.defaultScopes.join(', ')}\n\n`);
  }

  // Warn about non-default scopes and confirm (for interactive picker only)
  if (effectiveScopes && needsConfirmation) {
    const confirmed = await confirmNonDefaultScopes(provider, effectiveScopes);
    if (!confirmed) {
      p.cancel('Authorization cancelled.');
      return;
    }
  }

  const noBrowser = hasNoBrowserFlag(extraArgs);
  const flowOptions: OAuthFlowOptions = noBrowser ? { pasteRedirectUrl: promptForRedirectUrl } : {};
  if (!noBrowser) process.stdout.write('  Opening browser for authorization...\n');

  const result = await runOAuthFlow(provider, credentials, effectiveScopes, undefined, flowOptions);
  saveOAuthToken(provider.id, result.token);

  const tokenPath = getOAuthTokenPath(provider.id);
  process.stdout.write(`\n  Authorization successful!\n`);
  process.stdout.write(`  Token stored at ${tokenPath}\n`);
  process.stdout.write(`  Granted scopes: ${result.grantedScopes.join(', ')}\n\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAuthCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  // Show help when --help/-h is the first arg or no subcommand is given.
  // Don't intercept --help after a subcommand — let subcommands handle their own help.
  if (subcommand === '--help' || subcommand === '-h') {
    printHelp(authSpec);
    return;
  }

  if (!subcommand || subcommand === 'status') {
    showStatus();
    return;
  }

  if (subcommand === 'import') {
    importCredentials(args.slice(1));
    return;
  }

  if (subcommand === 'revoke') {
    const providerId = args[1];
    if (!providerId) {
      process.stdout.write('Usage: ironcurtain auth revoke <provider>\n');
      process.exit(1);
    }
    await revokeToken(providerId);
    return;
  }

  // Remaining args after the provider name go to authorize for --scopes parsing
  await authorize(subcommand, args.slice(1));
}
