/**
 * Tool-call timeouts shared by the coordinator (parent process), the relay
 * subprocess (`mcp-proxy-server.ts`) and the sandbox that spawns it.
 *
 * Three waits are bounded here:
 *
 *   - The **escalation wait**: how long the security pipeline waits for a
 *     human (or an in-process handler) to decide an escalated call. It runs
 *     in the parent process, before any backend dispatch, and comes from
 *     `escalationTimeoutSeconds` in the user config (30-600 s).
 *   - The **backend call**: how long one tool call may run inside the real
 *     MCP server. The relay bounds its own `callTool` with this value and
 *     resets the timer on progress notifications (up to an absolute
 *     ceiling); the parent waits a little longer (`relayCallTimeoutMs`) so
 *     the relay, not the parent, is the one that times out and reports a
 *     clean error.
 *   - The **Code Mode chain**: how long one `execute_code` script may run.
 *     It must outlive the longest single wait inside it, or a chain could
 *     time out while one of its calls still waits for an approval or a
 *     backend (`codeModeChainTimeoutMs`).
 *
 * The parent's MCP `initialize` handshake with each relay has its own
 * bound as well (`MCP_CONNECT_TIMEOUT_MS`); every other parent-to-relay
 * request keeps the MCP SDK's 60 s default.
 *
 * Leaf module: no imports, so the relay's import closure stays small.
 */

/** Default human-approval wait, matching `USER_CONFIG_DEFAULTS.escalationTimeoutSeconds`. */
export const DEFAULT_ESCALATION_TIMEOUT_SECONDS = 300;

/** Default bound for one backend tool call (the parent used to wait this long for the relay). */
export const DEFAULT_BACKEND_CALL_TIMEOUT_MS = 300_000;

/**
 * Extra time the parent allows the relay beyond the relay's own backend
 * timeout, so the relay's deadline always fires first.
 */
export const RELAY_CALL_GRACE_MS = 15_000;

/**
 * Absolute ceiling for one backend call whose deadline keeps being pushed
 * back by progress notifications. A backend that reports progress forever
 * is still cut off here (or at the backend bound, if that is larger).
 */
export const MAX_PROGRESS_EXTENDED_CALL_MS = 3_600_000;

/**
 * Time a Code Mode chain gets beyond the longest single wait inside it, for
 * the script's own work before and after that wait.
 */
export const CODE_MODE_CHAIN_GRACE_MS = 30_000;

/**
 * How long the parent waits for the MCP `initialize` handshake with a relay
 * (or a backend it spawns directly). A relay answers only after it has
 * started its backend and listed its tools, each bounded by the SDK's 60 s
 * inside the relay, and a backend's first start may download a package or
 * pull an image; the SDK's own 60 s default would give up on a relay that
 * its own bounds still let start. 300 s is what the removed global
 * `Protocol.prototype.request` patch applied to this handshake by default.
 */
export const MCP_CONNECT_TIMEOUT_MS = 300_000;

/** Environment variable the sandbox sets for every relay subprocess. */
export const BACKEND_CALL_TIMEOUT_ENV = 'BACKEND_CALL_TIMEOUT_MS';

/** Upper bound accepted from configuration or the environment (one day). */
const MAX_TIMEOUT_MS = 86_400_000;

/** The escalation wait in milliseconds for a session config. */
export function escalationTimeoutMsFromConfig(config: { readonly escalationTimeoutSeconds?: number }): number {
  const seconds = config.escalationTimeoutSeconds;
  if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_TIMEOUT_MS);
  }
  return DEFAULT_ESCALATION_TIMEOUT_SECONDS * 1000;
}

/** The backend call bound in milliseconds for a session config. */
export function backendCallTimeoutMsFromConfig(config: { readonly backendCallTimeoutSeconds?: number }): number {
  const seconds = config.backendCallTimeoutSeconds;
  if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_TIMEOUT_MS);
  }
  return DEFAULT_BACKEND_CALL_TIMEOUT_MS;
}

/** The parent's wait for a relay `callTool`: the relay's bound plus grace. */
export function relayCallTimeoutMs(backendCallTimeoutMs: number): number {
  return backendCallTimeoutMs + RELAY_CALL_GRACE_MS;
}

/** Ceiling for a backend call extended by progress notifications (see {@link MAX_PROGRESS_EXTENDED_CALL_MS}). */
export function maxTotalBackendCallMs(backendCallTimeoutMs: number): number {
  return Math.max(backendCallTimeoutMs, MAX_PROGRESS_EXTENDED_CALL_MS);
}

/**
 * The default `execute_code` chain timeout: the longer of one full
 * escalation wait and one full relay call, plus {@link CODE_MODE_CHAIN_GRACE_MS}.
 * A chain that timed out first would abandon a call that is still waiting
 * for its approval, and the approval would then run a side effect the agent
 * was already told had failed.
 */
export function codeModeChainTimeoutMs(waits: {
  readonly escalationTimeoutMs: number;
  readonly backendCallTimeoutMs: number;
}): number {
  return Math.max(waits.escalationTimeoutMs, relayCallTimeoutMs(waits.backendCallTimeoutMs)) + CODE_MODE_CHAIN_GRACE_MS;
}

/**
 * Parses the relay's `BACKEND_CALL_TIMEOUT_MS` environment value. An unset
 * value yields the default; anything that is not a positive integer number
 * of milliseconds within the accepted range throws, so a malformed value
 * stops the relay instead of silently changing its deadline.
 */
export function parseBackendCallTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_BACKEND_CALL_TIMEOUT_MS;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${BACKEND_CALL_TIMEOUT_ENV} must be a positive integer number of milliseconds (got "${raw}")`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Error(`${BACKEND_CALL_TIMEOUT_ENV} must be between 1 and ${MAX_TIMEOUT_MS} milliseconds (got "${raw}")`);
  }
  return value;
}
