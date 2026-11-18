/**
 * First-start wizard for IronCurtain.
 *
 * `ironcurtain start` runs it until it has completed once in this
 * IronCurtain home (config.json's `setupCompleted` marker, see
 * setup-state.ts), educating the user about the security model, checking
 * the credentials the configured models need, and pointing to
 * customization options. `ironcurtain setup` ({@link runSetupCommand}) runs
 * it on demand.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { checkHelp, parseArgsStrict, type CommandSpec } from '../cli-help.js';
import {
  HOST_MODEL_ROLES,
  USER_CONFIG_DEFAULTS,
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_PROVIDER_LABELS,
  WEB_SEARCH_PROVIDER_URLS,
  hostRoleModelId,
  loadUserConfig,
  resolveActiveProfile,
  saveUserConfig,
  type DockerAgent,
  type HostModelRole,
  type ResolvedDockerResourcesConfig,
  type ResolvedUserConfig,
  type UserConfig,
  type WebSearchProvider,
} from './user-config.js';
import type { MCPServerConfig } from './types.js';
import { loadMcpServers } from './mcp-servers-overlay.js';
import {
  parseModelId,
  PROVIDER_ENV_VARS,
  resolveApiKeyForProvider,
  resolveHostModelApiKey,
  type ProviderId,
} from './model-provider.js';
import { getGatewayDefinition } from './provider-definitions.js';
import { getTrustedEnvFilePath } from './trusted-env.js';
import { detectAuthMethod, isApiKeyAuthForced, readOnlyCredentialSources } from '../docker/oauth-credentials.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import {
  clampDockerResources,
  isImagePresent,
  probeDockerResources,
  DOCKER_MIN_CPUS,
  DOCKER_MIN_MEMORY_MB,
} from '../docker/resource-limits.js';
import { getAgent, registerBuiltinAdapters } from '../docker/agent-registry.js';
import type { AgentId } from '../docker/agent-adapter.js';
import { checkDockerAvailable } from '../docker/docker-probe.js';
import {
  OS_SANDBOX_INSTALL_HINT,
  describeOsSandboxProblems,
  isOsSandboxFixableByInstall,
  requiresOsSandbox,
  resolveOsSandboxAvailability,
} from '../trusted-process/sandbox-integration.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Where the wizard runs: `setup` for `ironcurtain setup` (the default), or
 * `start` before the session of an `ironcurtain start` (see setup-state.ts).
 */
export type FirstStartMode = 'setup' | 'start';

/** How {@link runFirstStart} ended when it returns. */
export type FirstStartOutcome = 'completed' | 'declined';

export interface FirstStartOptions {
  readonly mode?: FirstStartMode;
}

/**
 * Exit status of a wizard cancelled at a prompt (Ctrl-C or Escape): 0 for
 * `ironcurtain setup`; before `ironcurtain start`, 130 as for a Ctrl-C (128
 * plus SIGINT), since the task it was started for does not run.
 */
function cancelExitCode(mode: FirstStartMode): number {
  return mode === 'start' ? 130 : 0;
}

/** Checks if a prompt result was cancelled and exits with `exitCode`. */
function handleCancel(value: unknown, exitCode: number): void {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(exitCode);
  }
}

/** One feature that needs a credential. */
export interface CredentialUse {
  /** The feature, as the wizard names it ("auto-approve"). */
  readonly label: string;
  /** A Claude login (OAuth, from `claude login`) works here instead of an API key. */
  readonly claudeLogin?: boolean;
}

/** Whose API key a {@link CredentialNeed} is. */
export type CredentialTarget =
  | { readonly kind: 'provider'; readonly provider: ProviderId }
  | { readonly kind: 'profile'; readonly name: string; readonly type: string };

/** One credential the configuration needs, whether it is there, and what uses it. */
export interface CredentialNeed {
  readonly target: CredentialTarget;
  /** The key is configured, in the environment or in config.json. */
  readonly configured: boolean;
  readonly uses: readonly CredentialUse[];
}

/** What the wizard calls the Docker agents. */
const DOCKER_AGENT_LABELS: Readonly<Record<DockerAgent, string>> = {
  'claude-code': 'Claude Code',
  goose: 'Goose',
  codex: 'Codex',
};

const POLICY_COMPILATION_USE = 'policy compilation (compile-policy, persona compile, customize-policy)';

/**
 * The feature behind a host model role, as the wizard names it, or undefined
 * while that feature cannot call its model. Auto-approve counts although it
 * is off by default: the wizard offers to turn it on.
 */
function hostRoleUse(config: ResolvedUserConfig, role: HostModelRole): string | undefined {
  switch (role) {
    case 'agent':
      return 'builtin sessions';
    case 'policy':
    case 'prefilter':
      return POLICY_COMPILATION_USE;
    case 'summary':
      return config.autoCompact.enabled ? 'auto-compaction in builtin sessions' : undefined;
    case 'autoApprove':
      return 'auto-approve';
    case 'contentAssessment':
      return config.contentAssessment?.enabled === true && config.contentAssessment.llmCheck
        ? 'the outbound content LLM check'
        : undefined;
  }
}

/**
 * The credentials the configured models need, derived from the configuration
 * itself (its model IDs, host model profiles, preferred mode and agent), not
 * from the defaults: the container agent's credential first (container mode),
 * then one entry per provider or gateway profile the host-side models use.
 * A provider key counts as configured whether it comes from the environment
 * or from config.json.
 *
 * Claude Code in container mode can run on a Claude login (OAuth) instead of
 * an Anthropic API key; that use is marked so the caller can check for one,
 * unless `IRONCURTAIN_DOCKER_AUTH=apikey` forces the API key (a login is then
 * never used, so suggesting one would mislead). Codex signs in with its own
 * ChatGPT login (`codex login`), which the session preflight checks, so it
 * adds nothing here.
 */
export function collectCredentialNeeds(config: ResolvedUserConfig): CredentialNeed[] {
  const needs = new Map<string, { target: CredentialTarget; configured: boolean; uses: CredentialUse[] }>();
  const add = (target: CredentialTarget, configured: boolean, use: CredentialUse): void => {
    const key = target.kind === 'provider' ? `provider:${target.provider}` : `profile:${target.name}`;
    let need = needs.get(key);
    if (need === undefined) {
      need = { target, configured, uses: [] };
      needs.set(key, need);
    }
    if (!need.uses.some((existing) => existing.label === use.label)) need.uses.push(use);
  };
  const provider = (id: ProviderId): CredentialTarget => ({ kind: 'provider', provider: id });
  const hasProviderKey = (id: ProviderId): boolean => resolveApiKeyForProvider(id, config).length > 0;

  if (config.preferredMode === 'container') {
    const agent = config.preferredDockerAgent;
    const label = `container sessions (${DOCKER_AGENT_LABELS[agent]})`;
    try {
      const profileName = config.modelProviders.default;
      const profile = resolveActiveProfile(config.modelProviders);
      if (profile.type !== 'native') {
        add({ kind: 'profile', name: profileName, type: profile.type }, profile.apiKey.length > 0, { label });
      } else if (agent === 'claude-code') {
        add(
          provider('anthropic'),
          hasProviderKey('anthropic'),
          isApiKeyAuthForced() ? { label } : { label, claudeLogin: true },
        );
      } else if (agent === 'goose') {
        add(provider(config.gooseProvider), hasProviderKey(config.gooseProvider), { label });
      }
    } catch {
      // An unknown default profile: the session preflight reports it.
    }
  }

  for (const role of HOST_MODEL_ROLES) {
    const label = hostRoleUse(config, role);
    if (label === undefined) continue;
    try {
      const modelId = hostRoleModelId(config, role);
      const configured = resolveHostModelApiKey(modelId, config, role).length > 0;
      const profileName = config.hostModelProfiles?.[role];
      const profile = profileName === undefined ? undefined : resolveActiveProfile(config.modelProviders, profileName);
      if (profileName !== undefined && profile !== undefined && profile.type !== 'native') {
        add({ kind: 'profile', name: profileName, type: profile.type }, configured, { label });
      } else {
        add(provider(parseModelId(modelId).provider), configured, { label });
      }
    } catch {
      // An unparsable model ID or an unknown profile: `ironcurtain doctor` reports it.
    }
  }
  return [...needs.values()];
}

/** The text with its first letter in upper case. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "a, b and c". */
function joinLabels(labels: readonly string[]): string {
  return labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** Where a configured provider key comes from: its environment variable wins over config.json. */
function providerKeySource(provider: ProviderId): string {
  const envVar = PROVIDER_ENV_VARS[provider];
  return process.env[envVar] ? ` (${envVar})` : ' (config.json)';
}

/** How to set a provider's key. Never a .env in the project directory: that is often the agent's workspace. */
function providerKeyInstructions(envVar: string): string {
  return (
    `  Set it via: export ${envVar}=<your-key>\n` +
    `  Or add ${envVar}=<your-key> to ${getTrustedEnvFilePath()} (chmod 600).\n` +
    `  A .env file in your project directory is not read.`
  );
}

/**
 * Whether a Claude login (OAuth) is usable for container sessions. A
 * read-only probe, as `ironcurtain doctor` does: it reads the Claude Code
 * and Anthropic CLI credential stores (and the macOS Keychain) but never
 * refreshes a token or writes anything; an expired access token does not
 * count, as in the session preflight.
 */
async function hasClaudeLogin(config: ResolvedUserConfig): Promise<boolean> {
  try {
    return (await detectAuthMethod({ userConfig: config }, readOnlyCredentialSources)).kind === 'oauth';
  } catch {
    return false;
  }
}

/**
 * Step 3 of the wizard: reports each credential {@link collectCredentialNeeds}
 * finds. A missing Anthropic key whose only container use can run on a
 * Claude login is reported with that qualification instead of a plain
 * "missing" warning: container sessions with Claude Code work, but the
 * host-side features listed still need an API key.
 */
async function reportCredentials(config: ResolvedUserConfig): Promise<void> {
  let allPresent = true;
  for (const need of collectCredentialNeeds(config)) {
    const { target } = need;
    const name =
      target.kind === 'provider'
        ? target.provider
        : `provider profile "${toDisplayText(target.name)}" (${getGatewayDefinition(target.type).label})`;
    if (need.configured) {
      p.log.success(
        `API key configured for ${name}${target.kind === 'provider' ? providerKeySource(target.provider) : ''}`,
      );
      continue;
    }

    const instructions =
      target.kind === 'provider'
        ? providerKeyInstructions(PROVIDER_ENV_VARS[target.provider])
        : `  Set ${getGatewayDefinition(target.type).editor.credentialEnv} or the profile's apiKey ` +
          '(`ironcurtain config` > Model Providers).';
    const loginUses = need.uses.filter((use) => use.claudeLogin === true).map((use) => use.label);
    const otherUses = need.uses.filter((use) => use.claudeLogin !== true).map((use) => use.label);

    if (loginUses.length > 0 && (await hasClaudeLogin(config))) {
      p.log.success(`Claude login (OAuth) found: ${joinLabels(loginUses)} can use it instead of an API key.`);
      if (otherUses.length === 0) continue;
      allPresent = false;
      p.log.warn(
        `No API key for ${name}. Your Claude login covers ${joinLabels(loginUses)}, ` +
          `but these still need an API key: ${joinLabels(otherUses)}.\n` +
          instructions,
      );
      continue;
    }

    allPresent = false;
    const loginHint =
      loginUses.length > 0
        ? `  ${capitalize(joinLabels(loginUses))} can use a Claude login instead: run \`claude login\`.\n`
        : '';
    p.log.warn(
      `Missing API key for ${name}, used by ${joinLabels(need.uses.map((use) => use.label))}.\n` +
        loginHint +
        instructions,
    );
  }
  if (allPresent) {
    p.log.info('All required credentials are configured.');
  }
}

export const setupSpec: CommandSpec = {
  name: 'ironcurtain setup',
  description: 'Run the first-start wizard, even when a configuration already exists (interactive)',
  usage: ['ironcurtain setup'],
  options: [{ flag: 'help', short: 'h', description: 'Show this help message' }],
  examples: [
    'ironcurtain setup   # Credential check (API keys, Claude login), web search, GitHub token, auto-approve, OS sandbox and Docker checks',
  ],
};

/**
 * `ironcurtain setup`: the first-start wizard on demand. `--help` is answered
 * before anything else, and without a terminal the command refuses instead
 * of starting prompts that can never be answered.
 */
export async function runSetupCommand(args: readonly string[]): Promise<void> {
  const { values } = parseArgsStrict(
    { args: [...args], options: { help: { type: 'boolean', short: 'h' } } },
    setupSpec.name,
  );
  if (checkHelp(values, setupSpec)) return;
  if (!process.stdin.isTTY) {
    console.error('Error: ironcurtain setup requires an interactive terminal (TTY).');
    process.exit(1);
  }
  await runFirstStart();
}

/**
 * The first-start wizard. Returns 'completed' once it has saved its choices
 * and the completion marker. Answering no to "Continue with setup?" exits 0
 * in `setup` mode; in `start` mode it returns 'declined' with setup still
 * pending, so the requested task runs (its preflight still checks the
 * credentials) and the next interactive start offers the wizard again. A
 * cancelled prompt exits (see {@link cancelExitCode}).
 */
export async function runFirstStart(options: FirstStartOptions = {}): Promise<FirstStartOutcome> {
  const mode = options.mode ?? 'setup';
  const onCancel = (value: unknown): void => handleCancel(value, cancelExitCode(mode));

  // Step 1: Welcome & security philosophy
  p.intro('Welcome to IronCurtain');
  p.note(
    'In theater, an iron curtain is a fireproof barrier between the stage and\n' +
      'the audience. If something goes wrong on stage, the curtain drops to\n' +
      'contain the disaster. That is the metaphor.\n\n' +
      'AI agents today operate under your full authority. They hold your\n' +
      'credentials, process untrusted input, and execute code — all in the\n' +
      'same trust domain. A single prompt injection can cause an agent to\n' +
      'exfiltrate your data, and the agent has every capability to do so.',
    'The problem',
  );
  p.note(
    'IronCurtain mediates every tool call between the AI agent and MCP servers.\n' +
      'A policy engine evaluates each call against a constitution you control.\n' +
      'The agent can only produce typed function calls from a V8 isolate.\n' +
      'MCP servers that request it (e.g. git) also run in an OS-level sandbox.\n\n' +
      'We assume the LLM will be compromised or confused and constrain the\n' +
      'consequences through architecture — not prevention.\n\n' +
      'A word of caution: when you read "secure," mistrust it. There is a\n' +
      'strong tension between security and utility. IronCurtain limits major\n' +
      'unintended consequences but cannot guarantee nothing unintended will\n' +
      'happen. The policy and sandbox constraints are there to limit the damage.',
    'How IronCurtain helps',
  );

  const cont = await p.confirm({ message: 'Continue with setup?', initialValue: true });
  onCancel(cont);
  if (!cont) {
    if (mode === 'start') {
      // An interactive start has no task: say what happens in both cases.
      p.outro('Setup skipped; starting your session. Run `ironcurtain setup` at any time to complete it.');
      return 'declined';
    }
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // Load existing config without creating or modifying config.json
  let existingConfig;
  try {
    existingConfig = loadUserConfig({ readOnly: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(`Error loading config: ${message}`);
    p.log.info('Fix the config file or delete it and re-run setup.');
    process.exit(1);
  }

  // Accumulate all wizard choices, saved once at the end
  const pending: UserConfig = {};

  // Step 2: Show the default constitution
  const constitutionPath = resolve(__dirname, 'constitution.md');
  let constitutionText: string;
  try {
    constitutionText = readFileSync(constitutionPath, 'utf-8');
  } catch {
    constitutionText = '(Could not read default constitution)';
  }
  p.note(constitutionText, 'Default Constitution');

  // Step 3: credentials the configured models need (API keys from the
  // environment or config.json; a Claude login for container sessions)
  await reportCredentials(existingConfig);

  // Step 4: Optional web search provider
  p.log.info(
    'Web search lets the agent look up documentation, error messages, and current\n' +
      'information. This is optional but makes the agent significantly more helpful.',
  );
  const existingProvider = existingConfig.webSearch.provider;
  const providerOptions = WEB_SEARCH_PROVIDERS.map((prov) => ({
    value: prov,
    label: WEB_SEARCH_PROVIDER_LABELS[prov],
    hint: prov === existingProvider ? `${WEB_SEARCH_PROVIDER_URLS[prov]} (configured)` : WEB_SEARCH_PROVIDER_URLS[prov],
  }));
  const setupSearch = await p.select({
    message: 'Set up a web search provider?',
    options: [
      ...providerOptions,
      { value: 'skip' as const, label: 'Skip for now', hint: 'configure later via ironcurtain config' },
    ],
    initialValue: existingProvider || undefined,
  });
  onCancel(setupSearch);

  if (setupSearch !== 'skip') {
    const provider = setupSearch as WebSearchProvider;
    const existingKey = existingConfig.webSearch[provider]?.apiKey;
    if (existingKey) {
      // Re-selected a provider that already has an API key — preserve it
      p.log.success(`Existing ${provider} API key preserved.`);
      pending.webSearch = { provider };
    } else {
      // Masked, so the key does not stay readable in the terminal's scrollback.
      const apiKey = await p.password({
        message: `Enter your ${provider} API key:`,
        validate: (val) => (!val ? 'API key is required' : undefined),
      });
      onCancel(apiKey);
      pending.webSearch = { provider, [provider]: { apiKey: apiKey as string } };
      p.log.success(`Web search configured with ${provider}.`);
    }
  }

  // Step 5: Optional GitHub personal access token
  p.log.info(
    'The GitHub MCP server lets the agent interact with GitHub (issues, PRs, code search).\n' +
      'This requires a personal access token. You can skip this and configure it later\n' +
      'via `ironcurtain config` or by editing config.json directly.',
  );
  const githubCreds = existingConfig.serverCredentials.github as Record<string, string> | undefined;
  const existingGhToken = githubCreds?.GITHUB_PERSONAL_ACCESS_TOKEN;
  const setupGithub = await p.confirm({
    message: existingGhToken ? 'Update GitHub personal access token?' : 'Configure GitHub personal access token?',
    initialValue: false,
  });
  onCancel(setupGithub);

  if (setupGithub) {
    p.note(
      'Create a classic token at https://github.com/settings/tokens/new\n' + 'Required scopes: repo, read:org',
      'GitHub Token',
    );
    const ghToken = await p.password({
      message: existingGhToken
        ? 'GitHub personal access token (leave blank to keep the current token):'
        : 'GitHub personal access token (ghp_...):',
      validate: (val) => {
        if (!val && !existingGhToken) return 'Token is required';
        return undefined;
      },
    });
    onCancel(ghToken);
    const tokenValue = (ghToken as string) || existingGhToken;
    if (tokenValue) {
      pending.serverCredentials = {
        ...pending.serverCredentials,
        github: { ...(githubCreds ?? {}), GITHUB_PERSONAL_ACCESS_TOKEN: tokenValue },
      };
    }
  }

  // Step 6: Auto-approve for escalations
  p.log.info(
    'When the policy engine escalates a tool call, you are asked to approve or deny it.\n' +
      'Auto-approve uses a small LLM to approve calls that clearly match your explicit request.\n' +
      'It is conservative: any ambiguity is escalated to you for manual review.\n' +
      'The conservative choice is to leave it off and approve all escalations manually.',
  );
  const enableAutoApprove = await p.confirm({
    message: 'Enable auto-approve for escalations?',
    initialValue: existingConfig.autoApprove.enabled,
  });
  onCancel(enableAutoApprove);
  pending.autoApprove = { enabled: enableAutoApprove as boolean };

  // Step 6b: OS sandbox dependencies (bubblewrap, socat, ripgrep on Linux)
  await checkOsSandboxSetup(pending, existingConfig, onCancel);

  await maybeOfferDockerResourceFix(pending, onCancel);

  // Persist all wizard choices in a single write, with the marker that the
  // wizard has completed in this home (see setup-state.ts)
  saveUserConfig({ ...pending, setupCompleted: true });

  // Step 7: Suggest customization
  p.note(
    'You can customize IronCurtain to fit your workflow:\n\n' +
      '  ironcurtain config             — change models, resource limits, and other settings\n' +
      '  ironcurtain customize-policy   — LLM-assisted interactive policy customization\n' +
      '  ironcurtain compile-policy     — recompile after constitution changes\n' +
      '  ironcurtain annotate-tools     — reclassify tool arguments after server changes\n\n' +
      'Personas give your agent a named identity with its own workspace, policy,\n' +
      'and persistent memory. Create one with:\n\n' +
      '  ironcurtain persona create <name>',
    'Customization',
  );

  // Step 8: Outro
  p.outro(mode === 'start' ? 'Setup complete; starting your session.' : 'Run `ironcurtain start` to begin.');
  return 'completed';
}

/**
 * The configured MCP servers (the package's with the user's
 * mcp-servers.json layered over them); empty when they cannot be loaded,
 * which sessions report with the field-level error.
 */
function loadMcpServerConfigs(): Record<string, MCPServerConfig> {
  try {
    return loadMcpServers().servers;
  } catch {
    return {};
  }
}

/**
 * Checks whether MCP servers that ask for an OS sandbox will get one, as a
 * session decides it (`resolveOsSandboxAvailability`: the dependency check
 * and one srt smoke run). When sandbox-runtime is unavailable (bubblewrap,
 * socat or ripgrep missing, an unsupported platform, or srt unable to start
 * a sandbox on this host) and the policy is "enforce", lists the servers
 * that will not start and offers to switch to "warn". The default answer
 * keeps "enforce" (fail closed). Never blocks setup.
 */
async function checkOsSandboxSetup(
  pending: UserConfig,
  existingConfig: ResolvedUserConfig,
  onCancel: (value: unknown) => void,
): Promise<void> {
  const servers = loadMcpServerConfigs();
  const needing = Object.entries(servers)
    .filter(([, serverConfig]) => requiresOsSandbox(serverConfig))
    .map(([name]) => name);
  if (needing.length === 0) return;

  const availability = await resolveOsSandboxAvailability(servers);
  if (availability.available) {
    p.log.success(`OS sandbox available for MCP servers: ${needing.join(', ')}.`);
    return;
  }

  const why = describeOsSandboxProblems(availability);
  // Only missing helper binaries are fixed by installing packages; other
  // problems (e.g. root without CAP_SETFCAP) carry their own remedy.
  const fix = isOsSandboxFixableByInstall(availability)
    ? `\n  To fix, ${OS_SANDBOX_INSTALL_HINT}.`
    : availability.platformSupported
      ? '\n  Run `ironcurtain doctor` for details.'
      : '';
  if (existingConfig.sandboxPolicy === 'warn') {
    p.log.warn(
      `OS sandbox unavailable (${why}).\n` +
        `  ${needing.join(', ')} will run WITHOUT OS containment (sandboxPolicy "warn").${fix}`,
    );
    return;
  }

  p.note(
    `The OS sandbox for MCP servers is unavailable on this machine:\n  ${why}\n\n` +
      `With sandboxPolicy "enforce" (the default), these servers will not start:\n  ${needing.join(', ')}\n` +
      `${fix}\n\n` +
      'You can instead let them run WITHOUT OS containment (sandboxPolicy "warn").\n' +
      'Change this later with `ironcurtain config` > Security.',
    'OS sandbox',
  );
  const allowUnsandboxed = await p.confirm({
    message: 'Run these servers without OS containment (sandboxPolicy "warn")?',
    initialValue: false,
  });
  onCancel(allowUnsandboxed);
  if (allowUnsandboxed === true) {
    pending.sandboxPolicy = 'warn';
    p.log.warn('sandboxPolicy set to "warn": those servers will run without OS containment.');
  }
}

/**
 * If Docker is up and the preferred-agent image is already cached locally,
 * runs a tiny `docker run` against the configured (default) resource
 * ceilings. On parsed failure (e.g. "Range of CPUs is from 0.01 to 2.00"),
 * surfaces the suggested values and offers to write them into `pending`.
 *
 * Silently skipped in all other cases: no Docker, no image, no parsed
 * suggestion, or user declines. Never blocks setup completion.
 */
async function maybeOfferDockerResourceFix(pending: UserConfig, onCancel: (value: unknown) => void): Promise<void> {
  const dockerStatus = await checkDockerAvailable();
  if (!dockerStatus.available) return;

  // First-start runs before the user picks an agent, so resolve the same
  // default as `resolveUserConfig`.
  await registerBuiltinAdapters();
  let image: string;
  try {
    image = await getAgent('claude-code' as AgentId).getImage();
  } catch {
    return;
  }
  if (!(await isImagePresent(image))) return;

  const configured: ResolvedDockerResourcesConfig = {
    memoryMb: USER_CONFIG_DEFAULTS.dockerResources.memoryMb,
    cpus: USER_CONFIG_DEFAULTS.dockerResources.cpus,
    pidsLimit: USER_CONFIG_DEFAULTS.dockerResources.pidsLimit,
  };
  const { effective, host, clamped } = clampDockerResources(configured);
  const probe = await probeDockerResources(image, effective);
  if (probe.ok) return;

  const suggested = probe.suggested ?? {};
  const cpuTarget = suggested.cpus ?? Math.max(DOCKER_MIN_CPUS, host.cpus > 1 ? host.cpus - 1 : DOCKER_MIN_CPUS);
  const memoryTarget = suggested.memoryMb ?? Math.max(DOCKER_MIN_MEMORY_MB, Math.floor(host.memoryMb * 0.75));

  const clampNote = clamped ? '(Auto-clamp already lowered the defaults but Docker still rejected them.)\n' : '';
  const summary =
    `Docker rejected the default container resource limits.\n\n` +
    `  Detected host: ${host.cpus} cpus, ${host.memoryMb} MB total\n` +
    `  Probe error:   ${probe.stderr.replace(/\s+/g, ' ').trim().slice(0, 200)}\n\n` +
    `Suggested settings: cpus=${cpuTarget}, memoryMb=${memoryTarget}\n` +
    clampNote;

  p.note(summary, 'Docker resources');

  const apply = await p.confirm({
    message: 'Save the suggested Docker resource settings to your config?',
    initialValue: true,
  });
  onCancel(apply);
  if (apply !== true) return;

  pending.dockerResources = {
    ...(pending.dockerResources ?? {}),
    cpus: cpuTarget,
    memoryMb: memoryTarget,
  };
  p.log.success(`Docker resources updated: cpus=${cpuTarget}, memoryMb=${memoryTarget}`);
}
