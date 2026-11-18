/**
 * The rule every OAuth refresh write-back applies before it replaces a stored
 * token: never clobber a token that another process stored while our refresh
 * was in flight.
 *
 * Refresh grants are POSTs that take a while, and the same credential file is
 * shared: the host Claude Code / Anthropic CLI / Codex refresh
 * `~/.claude/.credentials.json` and friends, and every IronCurtain relay
 * refreshes `~/.ironcurtain/oauth/<provider>.json`. With refresh-token
 * rotation (each grant issues a new refresh token and invalidates the old one)
 * the last writer decides which login survives. So a write-back re-reads the
 * file after the token endpoint answered and keeps what is stored when
 *
 * - the file no longer holds the refresh token our refresh was made with
 *   (`refreshedFrom`): another process rotated it or the user signed in again,
 *   possibly with different scopes or another account. That stored token wins
 *   only while it is still usable, so a stale leftover never shadows a fresh
 *   refresh; or
 * - the stored access token expires later than the one just obtained, i.e. it
 *   was issued after ours. One exception: when our grant rotated the refresh
 *   token and the file still holds the one we spent, the stored entry can no
 *   longer be refreshed, so ours is written however long its access token
 *   lasts.
 *
 * Otherwise the refreshed token is written. Callers compare expiries in their
 * store's own precision (the Anthropic CLI store keeps whole seconds).
 *
 * A pure leaf: no I/O and no imports, so the IronCurtain token store
 * (`oauth-token-store.ts`) and the host credential write-back
 * (`docker/oauth-credentials.ts`) share one decision.
 */

/** The two fields a write-back compares. */
export interface RefreshableToken {
  readonly refreshToken: string;
  /** Access-token expiry, epoch milliseconds. */
  readonly expiresAt: number;
}

/**
 * Lifetime a stored token must still have to win over a fresh refresh on the
 * rotation rule; matches the 5-minute buffer after which tokens are refreshed.
 */
const USABLE_MARGIN_MS = 5 * 60 * 1000;

/**
 * True when a refresh write-back must leave `stored` in place instead of
 * writing `refreshed`. `refreshedFrom` is the refresh token the grant was
 * made with; without it only the expiry rule applies.
 */
export function keepsStoredToken(
  stored: RefreshableToken,
  refreshed: RefreshableToken,
  refreshedFrom: string | undefined,
  now: number = Date.now(),
): boolean {
  if (refreshedFrom !== undefined) {
    // Our grant rotated the refresh token and the file still holds the spent one.
    if (refreshed.refreshToken !== refreshedFrom && stored.refreshToken === refreshedFrom) return false;
    const replacedElsewhere = stored.refreshToken !== refreshedFrom && stored.refreshToken !== refreshed.refreshToken;
    if (replacedElsewhere && stored.expiresAt - now > USABLE_MARGIN_MS) return true;
  }
  return stored.expiresAt > refreshed.expiresAt;
}
