/**
 * OAuth token persistence for third-party providers.
 *
 * Stores tokens as JSON files in ~/.ironcurtain/oauth/{providerId}.json.
 * Every write is an atomic, owner-only (0o600) replacement made under the
 * file's cross-process lock (`<file>.lock`): a crash or a full disk never
 * leaves an empty or partial token file (which would force re-authorization),
 * and an `ironcurtain auth` run and the relays that refresh the token apply
 * their writes one after another.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { getOAuthDir, getOAuthTokenPath } from '../config/paths.js';
import { writePrivateFileAtomicSync } from '../util/atomic-write.js';
import { withFileLockSync } from '../util/file-lock.js';
import type { StoredOAuthToken } from './oauth-provider.js';
import { keepsStoredToken } from './refresh-write-back.js';

/** 5-minute buffer before expiry, matching OAuthTokenManager convention. */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Loads a stored OAuth token for a provider.
 * Returns null if no token file exists.
 * Throws if the file exists but contains invalid JSON or is missing required fields.
 */
export function loadOAuthToken(providerId: string): StoredOAuthToken | null {
  const tokenPath = getOAuthTokenPath(providerId);
  if (!existsSync(tokenPath)) {
    return null;
  }

  const raw = readFileSync(tokenPath, 'utf-8');
  const parsed = parseTokenJson(raw, tokenPath);
  return validateTokenShape(parsed, tokenPath);
}

/**
 * Saves an OAuth token for a provider, replacing whatever is stored. Used
 * when the user authorizes (`ironcurtain auth`): a new grant, possibly with
 * new scopes, always wins. Refresh write-backs use
 * {@link saveRefreshedOAuthToken} instead.
 *
 * Creates the oauth directory (0o700) if it does not exist; the file is
 * written atomically with owner-only (0o600) permissions.
 */
export function saveOAuthToken(providerId: string, token: StoredOAuthToken): void {
  const tokenPath = prepareTokenPath(providerId);
  withFileLockSync(tokenPath, () => {
    writeTokenFile(tokenPath, token);
  });
}

/**
 * Persists a token obtained by refreshing `refreshedFrom`, unless the store
 * changed while the refresh was in flight, and returns the token now in
 * effect.
 *
 * Under the token file's lock it re-reads the stored token and keeps it when
 * it no longer holds `refreshedFrom` (another process refreshed with
 * rotation, or the user re-authorized) and is still usable, or when it expires
 * later than `refreshed` without holding the refresh token our grant just
 * rotated away; see `refresh-write-back.ts`. A missing or unreadable file is
 * replaced by `refreshed`.
 */
export function saveRefreshedOAuthToken(
  providerId: string,
  refreshed: StoredOAuthToken,
  refreshedFrom: string,
): StoredOAuthToken {
  const tokenPath = prepareTokenPath(providerId);
  return withFileLockSync(tokenPath, () => {
    const stored = readStoredTokenIfValid(tokenPath);
    if (stored !== null && keepsStoredToken(stored, refreshed, refreshedFrom)) return stored;
    writeTokenFile(tokenPath, refreshed);
    return refreshed;
  });
}

/**
 * Deletes a stored OAuth token for a provider.
 * No-op if the file does not exist.
 */
export function deleteOAuthToken(providerId: string): void {
  const tokenPath = getOAuthTokenPath(providerId);
  if (existsSync(tokenPath)) {
    unlinkSync(tokenPath);
  }
}

/**
 * Checks whether a stored token is expired or near expiry.
 * Returns true if fewer than 5 minutes of validity remain.
 */
export function isTokenExpired(token: StoredOAuthToken): boolean {
  return Date.now() + TOKEN_EXPIRY_BUFFER_MS >= token.expiresAt;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Validates the provider id, creates the oauth directory (0o700) and returns the token path. */
function prepareTokenPath(providerId: string): string {
  const tokenPath = getOAuthTokenPath(providerId);
  mkdirSync(getOAuthDir(), { recursive: true, mode: 0o700 });
  return tokenPath;
}

function writeTokenFile(tokenPath: string, token: StoredOAuthToken): void {
  writePrivateFileAtomicSync(tokenPath, JSON.stringify(token, null, 2) + '\n');
}

/** The stored token, or null when the file is missing or does not hold a valid token. */
function readStoredTokenIfValid(tokenPath: string): StoredOAuthToken | null {
  let raw: string;
  try {
    raw = readFileSync(tokenPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return validateTokenShape(parseTokenJson(raw, tokenPath), tokenPath);
  } catch {
    return null;
  }
}

function parseTokenJson(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`, { cause: err });
  }
}

function validateTokenShape(parsed: unknown, filePath: string): StoredOAuthToken {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid token format in ${filePath}: expected a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.accessToken !== 'string' || obj.accessToken.length === 0) {
    throw new Error(`Missing or empty accessToken in ${filePath}`);
  }
  if (typeof obj.refreshToken !== 'string' || obj.refreshToken.length === 0) {
    throw new Error(`Missing or empty refreshToken in ${filePath}`);
  }
  if (typeof obj.expiresAt !== 'number' || !Number.isFinite(obj.expiresAt)) {
    throw new Error(`Missing or invalid expiresAt in ${filePath}`);
  }
  if (!Array.isArray(obj.scopes) || !obj.scopes.every((s: unknown) => typeof s === 'string')) {
    throw new Error(`Missing or invalid scopes in ${filePath}`);
  }

  return {
    accessToken: obj.accessToken,
    refreshToken: obj.refreshToken,
    expiresAt: obj.expiresAt,
    scopes: obj.scopes,
  };
}
