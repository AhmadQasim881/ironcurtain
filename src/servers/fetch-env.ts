/**
 * Host-to-fetch-server settings channel.
 *
 * The fetch MCP server runs as its own process and reads its host-side
 * settings from its environment. Only the host writes that environment:
 * `loadConfig()` puts it in `mcpServers.fetch.env` from the user config, and
 * tests set it when they spawn the server. No tool argument can reach it.
 *
 * This is a leaf module (no imports) so `src/config/` can name the variable
 * without loading the fetch server's network stack.
 */

/**
 * `1` when the user config sets `fetch.allowPrivateNetworks: true`: `http_fetch`
 * may then reach a private or loopback destination that the requested URL
 * names literally (see `src/servers/guarded-fetch.ts`). Any other value, or no
 * value, keeps every non-public destination blocked.
 */
export const FETCH_ALLOW_PRIVATE_NETWORKS_ENV = 'IRONCURTAIN_FETCH_ALLOW_PRIVATE_NETWORKS';

/** True only when {@link FETCH_ALLOW_PRIVATE_NETWORKS_ENV} is `1` or `true`. */
export function isPrivateNetworkFetchEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[FETCH_ALLOW_PRIVATE_NETWORKS_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}
