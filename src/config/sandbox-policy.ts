/**
 * OS-sandbox availability policy (`sandboxPolicy`).
 *
 * Decides what happens to an MCP server that asks for an OS-level sandbox
 * (its `mcp-servers.json` entry omits `sandbox` or gives a `sandbox` object)
 * when sandbox-runtime cannot provide one: the platform is unsupported, or
 * bubblewrap, socat or ripgrep is missing.
 *
 * - `"enforce"`: the server does not start. Other servers keep running.
 * - `"warn"`: the server starts without OS containment, and the session
 *   prints a warning.
 *
 * Resolution order (applied once, by `loadUserConfig`):
 *   1. `IRONCURTAIN_SANDBOX_POLICY`, then `SANDBOX_POLICY` from the
 *      environment (validated; an invalid value is an error, never a
 *      silent fallback)
 *   2. `sandboxPolicy` in `~/.ironcurtain/config.json`
 *   3. the platform default: `"enforce"` on Linux and macOS, where
 *      sandbox-runtime is supported, `"warn"` elsewhere.
 *
 * This module is a dependency-free leaf so the config schema, the session
 * parent, the MCP relay subprocess and the offline pipeline share one
 * definition.
 */

/** Accepted `sandboxPolicy` values. */
export const SANDBOX_POLICIES = ['enforce', 'warn'] as const;

/** See the module comment. */
export type SandboxAvailabilityPolicy = (typeof SANDBOX_POLICIES)[number];

/**
 * Environment variables that override the configured policy, highest
 * precedence first. The session parent exports its resolved policy to MCP
 * relay subprocesses through both (see {@link sandboxPolicyEnv}).
 */
export const SANDBOX_POLICY_ENV_VARS = ['IRONCURTAIN_SANDBOX_POLICY', 'SANDBOX_POLICY'] as const;

/** Where the effective policy came from, for diagnostics. */
export type SandboxPolicySource = (typeof SANDBOX_POLICY_ENV_VARS)[number] | 'config' | 'default';

/** Thrown for an environment value that is not a valid policy. */
export class SandboxPolicyError extends Error {
  readonly code = 'INVALID_SANDBOX_POLICY';

  constructor(message: string) {
    super(message);
    this.name = 'SandboxPolicyError';
  }
}

export function isSandboxPolicy(value: unknown): value is SandboxAvailabilityPolicy {
  return typeof value === 'string' && (SANDBOX_POLICIES as readonly string[]).includes(value);
}

/**
 * Platforms where sandbox-runtime's OS sandbox is supported and the
 * fail-closed default applies.
 */
const ENFORCE_BY_DEFAULT_PLATFORMS: ReadonlySet<string> = new Set(['linux', 'darwin']);

/**
 * The policy used when neither the environment nor the config file sets
 * one: `"enforce"` on Linux and macOS, `"warn"` elsewhere.
 */
export function defaultSandboxPolicy(platform: string = process.platform): SandboxAvailabilityPolicy {
  return ENFORCE_BY_DEFAULT_PLATFORMS.has(platform) ? 'enforce' : 'warn';
}

/**
 * Reads the explicit environment override, if any. An unset or empty
 * variable is ignored; surrounding whitespace and letter case are not
 * significant. Any other value throws {@link SandboxPolicyError} so a typo
 * such as `SANDBOX_POLICY=enfroce` cannot silently select a weaker mode.
 */
export function readSandboxPolicyEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly policy: SandboxAvailabilityPolicy; readonly source: SandboxPolicySource } | undefined {
  for (const name of SANDBOX_POLICY_ENV_VARS) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') continue;
    const normalized = raw.trim().toLowerCase();
    if (!isSandboxPolicy(normalized)) {
      throw new SandboxPolicyError(
        `Invalid ${name}: expected "enforce" or "warn" (got: ${JSON.stringify(raw)}). ` +
          'Unset it to use the sandboxPolicy from ~/.ironcurtain/config.json.',
      );
    }
    return { policy: normalized, source: name };
  }
  return undefined;
}

/**
 * Applies the full precedence: environment override, then the configured
 * value, then the platform default. Returns the policy and its source.
 */
export function resolveSandboxPolicyWithSource(
  configured: SandboxAvailabilityPolicy | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): { readonly policy: SandboxAvailabilityPolicy; readonly source: SandboxPolicySource } {
  const fromEnv = readSandboxPolicyEnv(env);
  if (fromEnv) return fromEnv;
  if (configured !== undefined) return { policy: configured, source: 'config' };
  return { policy: defaultSandboxPolicy(platform), source: 'default' };
}

/** {@link resolveSandboxPolicyWithSource} without the source. */
export function resolveSandboxPolicy(
  configured: SandboxAvailabilityPolicy | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): SandboxAvailabilityPolicy {
  return resolveSandboxPolicyWithSource(configured, env, platform).policy;
}

/**
 * The policy a session should apply, given a (possibly programmatically
 * built) config. `loadConfig()` always sets `sandboxPolicy` to the resolved
 * value; configs assembled by hand may omit it, in which case the user
 * config's resolved value and finally the environment and platform default
 * apply. Never returns a weaker mode than an explicit setting.
 */
export function effectiveSandboxPolicy(config: {
  readonly sandboxPolicy?: SandboxAvailabilityPolicy;
  readonly userConfig?: { readonly sandboxPolicy?: SandboxAvailabilityPolicy };
}): SandboxAvailabilityPolicy {
  return config.sandboxPolicy ?? config.userConfig?.sandboxPolicy ?? resolveSandboxPolicy(undefined);
}

/**
 * Environment entries that hand a resolved policy to an MCP relay
 * subprocess. Both names are set so the relay's own resolution (which
 * reads them in precedence order) cannot pick up a different value
 * inherited from the parent environment.
 */
export function sandboxPolicyEnv(policy: SandboxAvailabilityPolicy): Record<string, string> {
  return { IRONCURTAIN_SANDBOX_POLICY: policy, SANDBOX_POLICY: policy };
}
