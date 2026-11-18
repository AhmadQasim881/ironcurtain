/**
 * Package-manager settings for every Docker container that installs packages
 * through the standard registry proxy (`registry-proxy.ts`).
 *
 * The registry proxy is read-only: it refuses every request that is not a GET
 * or HEAD. That includes the audit npm runs after each install (a POST to
 * `/-/npm/v1/security/advisories/bulk`, then to
 * `/-/npm/v1/security/audits/quick`). npm treats a failed audit as non-fatal,
 * but every install would print a 403 warning and add a refusal to
 * `package-audit.jsonl`. `NPM_CONFIG_AUDIT=false` stops npm from trying.
 * `NPM_CONFIG_FUND=false` drops the funding notice npm prints after an
 * install. An explicit `npm audit` is still refused by the proxy.
 */
export function buildPackageClientEnv(): Readonly<Record<string, string>> {
  return {
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
  };
}
