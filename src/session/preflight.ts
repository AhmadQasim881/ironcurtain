import { getGatewayDefinition } from '../config/provider-definitions.js';
import { resolveHostModelApiKey } from '../config/model-provider.js';
/**
 * Pre-flight checks and explicit session mode selection.
 *
 * When `--agent` is explicit, validates prerequisites and fails fast.
 * When no `--agent` is given, dispatches on the user's `preferredMode`
 * (`'container'` or `'builtin'`) — there is no silent fallback. If the
 * preferred mode's prerequisites are unmet, a `PreflightError` is raised
 * with remediation hints and the session refuses to start.
 *
 * Builtin mode, explicit or preferred, needs credentials for the agent
 * model. The other host-side models (auto-compaction's summary model,
 * auto-approve's model) only produce warnings: sessions fall back or turn
 * the feature off (see host-model-roles.ts).
 */

import type { DockerAuthKind, IronCurtainConfig } from '../config/types.js';
import type { AgentId } from '../docker/agent-adapter.js';
import type { SessionMode } from './types.js';
import {
  detectAuthMethod,
  preflightCredentialSources,
  readOnlyCredentialSources,
  type CredentialSources,
} from '../docker/oauth-credentials.js';
import {
  resolveApiKeyForProvider,
  parseModelId,
  PROVIDER_ENV_VARS,
  type ProviderId,
} from '../config/model-provider.js';
import { resolveActiveProfile, type ResolvedProviderProfile } from '../config/user-config.js';
// The Docker availability probe lives in `docker/docker-probe.js` (a
// dependency-free leaf) so runtime modules can use it without importing this
// file. Import callers reference `docker-probe.js` directly.
import { checkDockerAvailable, type DockerAvailability } from '../docker/docker-probe.js';
import { planHostModelRoles } from './host-model-roles.js';

/**
 * Thrown when explicit `--agent` prerequisites are not met, or when the
 * user's `preferredMode` cannot be honored (the selected container runtime is
 * unavailable while preferring container, missing API key while preferring
 * builtin, etc.).
 */
export class PreflightError extends Error {
  constructor(message: string) {
    super(`${message}\n\nRun \`ironcurtain doctor\` for a full diagnostic.`);
    this.name = 'PreflightError';
  }
}

/**
 * Whether `error` is a {@link PreflightError}, matched by name so it also
 * holds across module copies. Its message is the whole report: commands
 * print it and exit 1 rather than letting it reach the CLI as a stack trace.
 */
export function isPreflightError(error: unknown): error is PreflightError {
  return error instanceof Error && error.name === 'PreflightError';
}

export interface PreflightResult {
  readonly mode: SessionMode;
  /** Human-readable explanation of why this mode was selected. */
  readonly reason: string;
  /**
   * Host-side features that sessions in this mode will run differently
   * because their model has no credentials, one line each (see
   * host-model-roles.ts; memory depends on the persona or job and is
   * checked per session). Sessions apply the same fallbacks and report
   * them as `host_model_fallback` diagnostics; a caller that runs sessions
   * without showing their diagnostics, such as the daemon, prints these.
   * Absent when nothing is missing.
   */
  readonly warnings?: readonly string[];
}

export interface PreflightOptions {
  config: IronCurtainConfig;
  /** The --agent flag value. undefined = use preferredMode from config. */
  requestedAgent?: AgentId;
  /**
   * The per-session `--provider-profile` selection (fresh Docker sessions only).
   * When it names an OpenRouter profile, preflight authenticates against that
   * profile's OpenRouter key instead of the agent-native credential, so the
   * credential banner/block matches the routing the session will actually use.
   * Undefined resolves the config default — the unchanged behavior for mux,
   * daemon, cron, and resumes (which restore the original profile later). An
   * unknown name propagates `resolveActiveProfile`'s authoritative
   * available-profiles error early (before credential detection), so a
   * `--provider-profile` typo surfaces as "unknown profile" rather than being
   * masked by a generic "no credentials" error when the default lacks creds.
   */
  providerProfileName?: string;
  /** Dependency injection for tests. Defaults to real Docker check. */
  isDockerAvailable?: () => Promise<DockerAvailability>;
  /** Dependency injection for tests. Defaults to real credential detection. */
  credentialSources?: CredentialSources;
}

/** `anthropicOAuthOnly` is only meaningful for goose: it lets the goose
 *  error message tell a tester that present OAuth credentials are unusable. */
interface CredentialState {
  credKind: DockerAuthKind | null;
  anthropicOAuthOnly: boolean;
}

/** Human-readable label for a resolved auth kind, used in the preflight banner. */
function authKindLabel(kind: DockerAuthKind): string {
  return kind === 'oauth' ? 'OAuth' : 'API key';
}

async function detectCredentialState(
  agentId: AgentId,
  config: IronCurtainConfig,
  sources: CredentialSources | undefined,
  activeProfile: ResolvedProviderProfile,
): Promise<CredentialState> {
  if (activeProfile.type !== 'native') {
    return { credKind: activeProfile.apiKey ? 'apikey' : null, anthropicOAuthOnly: false };
  }

  if (agentId === 'goose') {
    const provider = config.userConfig.gooseProvider;
    const key = resolveApiKeyForProvider(provider, config.userConfig);
    if (key) return { credKind: 'apikey', anthropicOAuthOnly: false };

    // Only native Anthropic users benefit from an explanation about a Claude
    // login. Goose cannot use that login, so the production check is read-only.
    const anthropicOAuthOnly =
      provider === 'anthropic' &&
      (await detectAuthMethod(config, sources ?? readOnlyCredentialSources)).kind === 'oauth';
    return { credKind: null, anthropicOAuthOnly };
  }

  if (agentId === 'codex') {
    const { loadCodexOAuthCredentials } = await import('../docker/oauth-credentials.js');
    if (loadCodexOAuthCredentials()) return { credKind: 'oauth', anthropicOAuthOnly: false };
    return { credKind: null, anthropicOAuthOnly: false };
  }

  const auth = await detectAuthMethod(config, sources ?? preflightCredentialSources);
  if (auth.kind === 'none') return { credKind: null, anthropicOAuthOnly: false };
  return { credKind: auth.kind, anthropicOAuthOnly: false };
}

/**
 * Renders the "switch to <other mode>" remediation footer shared by every
 * preflight error message. Centralized so the wording can't drift between
 * the docker-unavailable, builtin-needs-key, and credential-missing paths.
 */
function formatModeRemediation(targetMode: 'container' | 'builtin'): string[] {
  if (targetMode === 'builtin') {
    return [
      'To run this session in builtin mode, pass:',
      '  --agent builtin',
      '',
      'To make builtin the default permanently, run:',
      '  ironcurtain config',
      'and set Session Mode > Preferred mode to "builtin".',
    ];
  }
  return [
    'To run this session in container mode, pass:',
    '  --agent claude-code',
    '',
    'To make container mode the default permanently, run:',
    '  ironcurtain config',
    'and set Session Mode > Preferred mode to "container".',
  ];
}

function gooseCredentialError(subject: string, provider: ProviderId, oauthOnly: boolean): string {
  const parts = [
    `${subject} requires an API key for provider "${provider}". ` +
      `Set ${PROVIDER_ENV_VARS[provider]} or configure it via \`ironcurtain config\`.`,
  ];
  if (provider === 'anthropic' && oauthOnly) {
    parts.push('OAuth credentials are not usable with goose; provider "anthropic" requires an API key.');
  }
  if (provider === 'anthropic' && process.env.ANTHROPIC_AUTH_TOKEN) {
    parts.push(
      'Note: IronCurtain does not honor `ANTHROPIC_AUTH_TOKEN` (Bearer/gateway auth). ' +
        'To route Anthropic traffic through a gateway, run LiteLLM as a sidecar and ' +
        'point `ANTHROPIC_BASE_URL` at it with `ANTHROPIC_API_KEY` set to the LiteLLM key.',
    );
  }
  return parts.join('\n\n');
}

function credentialErrorMessageForExplicit(agentId: AgentId, config: IronCurtainConfig, oauthOnly: boolean): string {
  if (agentId === 'goose') {
    return gooseCredentialError('--agent goose', config.userConfig.gooseProvider, oauthOnly);
  }
  if (agentId === 'codex') {
    return (
      '--agent codex requires Codex ChatGPT authentication. Run `codex login` on the host, ' +
      'or provide a Codex access token with `codex login --with-access-token`. OPENAI_API_KEY is not required.'
    );
  }
  return `--agent ${agentId} requires authentication. Log in with \`claude login\` (OAuth) or set ANTHROPIC_API_KEY.`;
}

function credentialErrorMessageForPreferredMode(
  agentId: AgentId,
  config: IronCurtainConfig,
  oauthOnly: boolean,
): string {
  const lines: string[] = [
    'Cannot start IronCurtain.',
    `preferredMode is "container" but no credentials are configured for "${agentId}".`,
    '',
  ];
  if (agentId === 'goose') {
    lines.push(gooseCredentialError('Goose', config.userConfig.gooseProvider, oauthOnly));
  } else {
    lines.push(
      agentId === 'codex'
        ? 'Codex ChatGPT authentication is required. Run `codex login` on the host; OPENAI_API_KEY is not required.'
        : `Authentication is required for "${agentId}". Log in with \`claude login\` (OAuth) or set ANTHROPIC_API_KEY.`,
    );
  }
  lines.push('');
  lines.push(...formatModeRemediation('builtin'));
  return lines.join('\n');
}

function dockerUnavailableMessage(detailedMessage: string): string {
  return [
    'Cannot start IronCurtain.',
    'preferredMode is "container" but the selected container runtime is not available:',
    '',
    detailedMessage,
    '',
    ...formatModeRemediation('builtin'),
  ].join('\n');
}

/** What selected builtin mode: the user's preferredMode, or an explicit `--agent builtin`. */
type BuiltinSelection = 'preferredMode' | 'flag';

function builtinNeedsApiKeyMessage(
  provider: ProviderId,
  qualifiedModelId: string,
  selection: BuiltinSelection,
): string {
  const envVar = PROVIDER_ENV_VARS[provider];
  const lines = [
    'Cannot start IronCurtain.',
    selection === 'flag'
      ? `--agent builtin requires an API key, but no ${envVar} is configured.`
      : `preferredMode is "builtin" but no ${envVar} is configured.`,
    `Builtin mode talks to the "${provider}" provider directly using an API key` +
      ` (selected by your configured model "${qualifiedModelId}").`,
  ];
  // Anthropic users commonly have Claude OAuth credentials from `claude login`;
  // call out that those do not work in builtin mode to avoid confusion.
  if (provider === 'anthropic') {
    lines.push('Claude OAuth credentials are not usable in builtin mode — an API key is required.');
  }
  lines.push(
    '',
    ...formatModeRemediation('container'),
    '',
    `Set ${envVar} in your environment, or run \`ironcurtain config\`.`,
  );
  return lines.join('\n');
}

/**
 * Renders the user-facing `Mode: ...` banner shown at session startup.
 * Single source of truth so `ironcurtain start`, the daemon, and cron
 * jobs all print identically. Container mode includes the agent + auth
 * kind via `reason`; builtin has no parenthetical.
 */
export function formatModeLine(preflight: PreflightResult): string {
  if (preflight.mode.kind === 'builtin') return 'Mode: builtin';
  return `Mode: container / ${preflight.reason}`;
}

/** Per-call-site message strategy for `resolveDockerAgent`. */
interface DockerAgentMessages {
  dockerUnavailable: (detailedMessage: string) => string;
  credentialsMissing: (anthropicOAuthOnly: boolean) => string;
  successReason: (authKind: DockerAuthKind) => string;
}

async function resolveDockerAgent(
  agent: AgentId,
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<DockerAvailability>,
  credentialSources: CredentialSources | undefined,
  providerProfileName: string | undefined,
  messages: DockerAgentMessages,
): Promise<PreflightResult> {
  // Resolve the selected profile before inspecting any credentials. Only
  // Claude Code on a native profile may refresh a Claude login, and only
  // after the runtime can actually start the session.
  const profile = resolveActiveProfile(config.userConfig.modelProviders, providerProfileName);
  const dockerStatus = await isDockerAvailable();
  if (!dockerStatus.available) {
    throw new PreflightError(messages.dockerUnavailable(dockerStatus.detailedMessage));
  }

  const credState = await detectCredentialState(agent, config, credentialSources, profile);
  if (credState.credKind === null) {
    if (profile.type !== 'native') {
      const definition = getGatewayDefinition(profile.type);
      throw new PreflightError(
        `${definition.label} profile requires an API key. Set ${definition.editor.credentialEnv} or the profile apiKey.`,
      );
    }
    throw new PreflightError(messages.credentialsMissing(credState.anthropicOAuthOnly));
  }

  return {
    mode: { kind: 'docker', agent, authKind: credState.credKind },
    reason: messages.successReason(credState.credKind),
  };
}

/**
 * Resolves the session mode based on the explicit `--agent` flag or the
 * user's `preferredMode`.
 *
 * - Explicit agent: validates prerequisites; throws PreflightError on failure.
 * - Default path: dispatches on `preferredMode`. There is no silent
 *   fallback — container-runtime unavailability or missing credentials throw.
 */
export async function resolveSessionMode(options: PreflightOptions): Promise<PreflightResult> {
  const { config, requestedAgent, credentialSources } = options;
  const isDockerAvailable = options.isDockerAvailable ?? (await resolveDefaultAvailabilityProbe(config));

  if (requestedAgent !== undefined) {
    return resolveExplicit(requestedAgent, config, isDockerAvailable, credentialSources, options.providerProfileName);
  }

  return resolveDefaultMode(config, isDockerAvailable, credentialSources, options.providerProfileName);
}

/**
 * Picks the container-runtime availability probe matching the selected
 * backend: apple-container sessions must probe the Apple `container`
 * services, not Docker (the machine may not have Docker at all).
 * The runtime backends are imported lazily so preflight does not eagerly
 * pull in docker-manager / apple-container-manager on every load.
 */
async function resolveDefaultAvailabilityProbe(config: IronCurtainConfig): Promise<() => Promise<DockerAvailability>> {
  const { resolveRuntimeKind } = await import('../docker/container-runtime.js');
  if ((await resolveRuntimeKind(config.userConfig.containerRuntime)) === 'apple-container') {
    const { checkAppleContainerAvailable } = await import('../docker/apple-container-manager.js');
    return () => checkAppleContainerAvailable();
  }
  return checkDockerAvailable;
}

async function resolveExplicit(
  agent: AgentId,
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<DockerAvailability>,
  credentialSources: CredentialSources | undefined,
  providerProfileName: string | undefined,
): Promise<PreflightResult> {
  if (agent === 'builtin') {
    // Same check as a builtin preferredMode: without a key for the agent
    // model the very first turn would fail.
    requireBuiltinAgentKey(config, 'flag');
    return withHostModelWarnings({ mode: { kind: 'builtin' }, reason: 'Explicit --agent builtin' }, config);
  }

  const result = await resolveDockerAgent(agent, config, isDockerAvailable, credentialSources, providerProfileName, {
    dockerUnavailable: (detailedMessage) =>
      `--agent ${agent} requires container mode, but the selected container runtime is not available:\n\n${detailedMessage}\n\n` +
      'Please fix your container runtime installation or use the builtin agent.',
    credentialsMissing: (oauthOnly) => credentialErrorMessageForExplicit(agent, config, oauthOnly),
    successReason: (authKind) => `Explicit --agent selection (${authKindLabel(authKind)})`,
  });
  return withHostModelWarnings(result, config);
}

/**
 * Fails when the builtin agent model has no credentials: no key for its
 * provider, or its host profile has none. Checked before any Docker or
 * OAuth probe, for fast feedback.
 */
function requireBuiltinAgentKey(config: IronCurtainConfig, selection: BuiltinSelection): void {
  const agentModelId = config.userConfig.agentModelId;
  const { provider } = parseModelId(agentModelId);
  const apiKey = resolveHostModelApiKey(agentModelId, config.userConfig, 'agent');
  if (apiKey.length === 0) {
    const profileName = config.userConfig.hostModelProfiles?.agent;
    if (profileName && profileName !== 'native')
      throw new PreflightError(`Host agent profile "${profileName}" requires an API key.`);
    throw new PreflightError(builtinNeedsApiKeyMessage(provider, agentModelId, selection));
  }
}

/**
 * Adds the host-model warnings for sessions in `result.mode` (see
 * host-model-roles.ts): auto-compaction's summary model for builtin
 * sessions, auto-approve's model for every session.
 */
function withHostModelWarnings(result: PreflightResult, config: IronCurtainConfig): PreflightResult {
  const { notices } = planHostModelRoles(config.userConfig, {
    mode: result.mode.kind === 'docker' ? 'docker' : 'builtin',
    agentModelId: config.userConfig.agentModelId,
    memoryEnabled: false,
  });
  return notices.length === 0 ? result : { ...result, warnings: notices.map((notice) => notice.message) };
}

async function resolveDefaultMode(
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<DockerAvailability>,
  credentialSources: CredentialSources | undefined,
  providerProfileName: string | undefined,
): Promise<PreflightResult> {
  const { preferredMode, preferredDockerAgent } = config.userConfig;

  if (preferredMode === 'builtin') {
    // Fail before the Docker probe — fast feedback for missing keys.
    requireBuiltinAgentKey(config, 'preferredMode');
    return withHostModelWarnings({ mode: { kind: 'builtin' }, reason: 'preferredMode = builtin' }, config);
  }

  const agent = preferredDockerAgent as AgentId;

  const result = await resolveDockerAgent(agent, config, isDockerAvailable, credentialSources, providerProfileName, {
    dockerUnavailable: dockerUnavailableMessage,
    credentialsMissing: (oauthOnly) => credentialErrorMessageForPreferredMode(agent, config, oauthOnly),
    successReason: (authKind) => `${preferredDockerAgent} (${authKindLabel(authKind)})`,
  });
  return withHostModelWarnings(result, config);
}
