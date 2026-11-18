import { isAbsolute } from 'node:path';

/** Relay-only path metadata; never forwarded to an MCP backend. */
export const SANDBOX_CREDENTIAL_PATHS_ENV = 'SANDBOX_CREDENTIAL_PATHS';
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_PATHS = 256;
const MAX_PATH_BYTES = 4096;

export function parseSandboxCredentialPaths(value: string | undefined): string[] {
  if (value === undefined) return [];
  if (Buffer.byteLength(value) > MAX_METADATA_BYTES) throw new Error('Sandbox credential path metadata is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Sandbox credential path metadata must be valid JSON');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > MAX_PATHS ||
    parsed.some(
      (path: unknown) =>
        typeof path !== 'string' ||
        !isAbsolute(path) ||
        path.includes('\0') ||
        Buffer.byteLength(path) > MAX_PATH_BYTES,
    )
  )
    throw new Error('Sandbox credential path metadata must be a bounded array of absolute paths');
  return [...new Set(parsed as string[])];
}

export function sandboxCredentialPathsEnv(paths: readonly string[]): Record<string, string> {
  const value = JSON.stringify(paths);
  parseSandboxCredentialPaths(value);
  return { [SANDBOX_CREDENTIAL_PATHS_ENV]: value };
}
