/**
 * Google Workspace credential file management.
 *
 * Writes credential files in the format expected by
 * @alanse/mcp-server-google-workspace's auth.ts.
 *
 * SECURITY: The refresh_token field is intentionally omitted.
 * This prevents the MCP server from independently refreshing tokens,
 * which would cause refresh token rotation races in multi-session
 * environments. IronCurtain's OAuthTokenProvider is the sole token
 * authority.
 *
 * The file is replaced atomically (a fresh temporary file, then a rename)
 * so the MCP server never reads a partial file during a refresh cycle.
 *
 * SECURITY: the directory is writable by the srt-sandboxed server, while
 * the writer is the unsandboxed relay. The server can plant a symlink (or
 * any other entry) at any name there between two refreshes, so the write
 * never opens an existing entry: see {@link writeGWorkspaceCredentialFile}.
 */

import { mkdirSync } from 'node:fs';
import { writeFileNoFollowAtomic } from '../hardened-fs.js';

/** The filename the MCP server expects in its GWORKSPACE_CREDS_DIR. */
export const GWORKSPACE_CREDENTIAL_FILENAME = '.gworkspace-credentials.json';

/**
 * Shape of the credential file read by the MCP server's auth.ts.
 * Mirrors the subset of Google OAuth2 token response that the server needs.
 */
export interface GWorkspaceCredentialFile {
  readonly access_token: string;
  readonly expiry_date: number;
  readonly token_type: 'Bearer';
  readonly scope: string;
  // NOTE: refresh_token intentionally omitted.
  // See design doc: docs/designs/google-workspace-integration.md
}

/**
 * Writes a Google Workspace credential file for the MCP server.
 *
 * Creates the directory (mode 0o700, owner-only) if it does not exist.
 * The relay places it inside its srt scratch directory under the per-user
 * scratch root (trusted-process/spawn-cwd.ts), which other sandboxed
 * servers cannot read, and grants the google-workspace server write
 * access to it.
 *
 * Because that server can write the directory, the file is written with
 * `writeFileNoFollowAtomic` (hardened-fs.ts): the bytes go to a randomly
 * named temporary file created exclusively without following links
 * (`O_CREAT | O_EXCL | O_NOFOLLOW`), given mode 0o600 and fsynced, which
 * is then renamed over the credential file. A symlink planted at the
 * credential name is replaced, never followed, so a refresh cannot
 * truncate or create a file outside the directory, nor leave the
 * credential file pointing at one. `credsDir` must be an absolute path to
 * a real directory: a symlink there is refused (`NOT_DIRECTORY`), as is a
 * directory planted at the credential name (`NOT_REGULAR_FILE`). A failed
 * write throws an `UntrustedFileError`; callers match on its `code`.
 *
 * @param credsDir - Absolute directory to write the credential file into
 * @param accessToken - OAuth2 access token (short-lived)
 * @param expiresAt - Token expiry timestamp in milliseconds since epoch
 * @param scopes - OAuth2 scopes granted to this token
 */
export function writeGWorkspaceCredentialFile(
  credsDir: string,
  accessToken: string,
  expiresAt: number,
  scopes: readonly string[],
): void {
  mkdirSync(credsDir, { recursive: true, mode: 0o700 });

  const credential: GWorkspaceCredentialFile = {
    access_token: accessToken,
    expiry_date: expiresAt,
    token_type: 'Bearer',
    scope: scopes.join(' '),
  };

  writeFileNoFollowAtomic(credsDir, GWORKSPACE_CREDENTIAL_FILENAME, JSON.stringify(credential, null, 2), 0o600);
}
