import { gatewayProfile, resolveChatClient, resolveGatewayCommandModel } from '../../config/gateway-client.js';
import { gatewayProviders, gatewayCredential, gatewaySentinel } from '../gateway-runtime.js';
import { mcpClientCommand } from '../mcp-client-command.js';
import { assertAgentResponseOutputBound } from '../agent-response-output.js';
import { stripTerminalSequences } from '../../terminal/display-sanitize.js';
/**
 * Goose agent adapter for Docker Agent Mode.
 *
 * Configures a Docker container running Goose (by Block) with:
 * - MCP server discovery via config.yaml (YAML, Goose extensions format)
 * - System prompt injection via --instructions file
 * - Multi-provider support (Anthropic, OpenAI, Google)
 * - GOOSE_MODE=auto to skip all permission prompts
 *
 * Key differences from Claude Code adapter:
 * - Config format is YAML (not JSON)
 * - System prompt is file-based (not inline CLI flag)
 * - Batch mode invokes `goose run --output-format json` so `extractResponse`
 *   can parse a structured envelope (incl. provider error surfacing); PTY
 *   mode still streams plain text to the user's terminal.
 * - Provider-specific credential detection (not Anthropic-only)
 *
 * Conversation continuity: both modes use named Goose sessions stored in the
 * mounted session store (`goose-state` on the host, Goose's
 * `~/.local/share/goose/sessions/` in the container). A batch turn names the
 * session after the agent conversation id (`--name <id>`, plus `--resume`
 * after the first turn); a PTY session names it after the IronCurtain session
 * id (`IRONCURTAIN_SESSION_NAME`) and resumes it with `goose session --name
 * <id> --resume`.
 */

import { randomBytes } from 'node:crypto';
import type {
  AgentAdapter,
  AgentCommandOptions,
  AgentConfigFile,
  AgentId,
  AgentResponse,
  ConversationStateConfig,
  OrientationContext,
} from '../agent-adapter.js';
import { resolveMaxAgentTurns } from '../agent-adapter.js';
import type { DockerAuthKind, IronCurtainConfig } from '../../config/types.js';
import type { ProviderConfig } from '../provider-config.js';
import type { AuthMethod } from '../oauth-credentials.js';
import type { ResolvedUserConfig, GooseProvider } from '../../config/user-config.js';
import { isConversationName, PTY_RESUME_FLAGS_ENV, PTY_SESSION_NAME_ENV } from '../conversation-state.js';
import { anthropicProvider, openaiProvider, googleProvider } from '../provider-config.js';
import { buildSystemPrompt } from '../../session/prompts.js';
import { CONTAINER_RUNTIME_CA_BUNDLE } from '../runtime-trust.js';
import { GOOSE_CLI_VERSION } from '../agent-cli-version.js';
import { PROVIDER_ENV_VARS, resolveApiKeyForProvider } from '../../config/model-provider.js';
import {
  buildResizePtyScript,
  buildCheckPtySizeScript,
  buildWorkspaceAccessSection,
  buildNestedDockerSection,
  buildPolicySection,
  buildAttributionSection,
} from './shared-scripts.js';

const GOOSE_IMAGE = 'ironcurtain-goose:latest';

/** Default heredoc delimiter for shell commands. */
const DEFAULT_HEREDOC_DELIMITER = 'IRONCURTAIN_EOF';

/**
 * Goose's session store inside the container (its XDG data dir). The image
 * pre-creates it as `codespace` so the bind mount does not leave a
 * root-owned `~/.local/share/goose` behind (docker/Dockerfile.goose).
 */
export const GOOSE_SESSIONS_CONTAINER_DIR = '/home/codespace/.local/share/goose/sessions/';

/** Fallbacks matching `resolveUserConfig` for a partial session config. */
const DEFAULT_GOOSE_PROVIDER: GooseProvider = 'anthropic';
const DEFAULT_GOOSE_MODEL = 'claude-sonnet-4-20250514';

// ─── Provider Helpers ────────────────────────────────────────

/**
 * Returns the provider config for the selected Goose provider.
 */
export function getProviderConfig(provider: GooseProvider): ProviderConfig {
  switch (provider) {
    case 'anthropic':
      return anthropicProvider;
    case 'openai':
      return openaiProvider;
    case 'google':
      return googleProvider;
  }
}

/**
 * The session's Goose provider and model, read from the per-session config
 * on every call. The registry keeps one adapter per process (a daemon serves
 * many sessions, each loading config afresh), so capturing them when the
 * adapter is created would apply the first session's choice to every later
 * one. A partial config (tests, `--list-agents`) falls back to the defaults.
 */
export function resolveGooseSelection(config: {
  readonly userConfig?: Partial<Pick<ResolvedUserConfig, 'gooseProvider' | 'gooseModel'>>;
}): { readonly provider: GooseProvider; readonly model: string } {
  return {
    provider: config.userConfig?.gooseProvider ?? DEFAULT_GOOSE_PROVIDER,
    model: config.userConfig?.gooseModel ?? DEFAULT_GOOSE_MODEL,
  };
}

// ─── Response Parsing ────────────────────────────────────────

/**
 * Strips ANSI escape codes from a string.
 */
export function stripAnsi(text: string): string {
  return stripTerminalSequences(text);
}

/**
 * Parses the envelope, tolerating a line of CLI chrome before it: when the
 * whole output is not JSON, parse from the first line that opens an object.
 */
function parseGooseEnvelope(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    // Fall through to the preamble-tolerant parse.
  }
  const start = stdout.search(/^\{/mu);
  if (start <= 0) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

/** Text of a message's `text` content items. */
function messageTexts(message: { readonly content?: unknown }): string[] {
  if (!Array.isArray(message.content)) return [];
  const texts: string[] = [];
  for (const c of message.content) {
    if (!c || typeof c !== 'object') continue;
    const item = c as { type?: unknown; text?: unknown };
    if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text);
  }
  return texts;
}

/**
 * Parses Goose's `--output-format json` envelope and returns the
 * concatenated text of this turn's assistant messages. Returns null if the
 * envelope is missing, malformed, or has no assistant text — the caller
 * falls back to the raw stripped output in that case.
 *
 * Goose emits one assistant message per agent invocation, so a turn
 * with intermediate tool calls produces multiple assistant messages
 * separated by tool-call/tool-result entries. Concatenating their text
 * preserves the model's narrative without surfacing the tool chrome.
 *
 * A resumed named session lists the whole conversation, so only the
 * messages after the last user message with text (this turn's prompt; tool
 * results carry no text item) belong to this turn.
 */
export function extractAssistantText(stdout: string): string | null {
  assertAgentResponseOutputBound(stdout);
  const parsed = parseGooseEnvelope(stdout);
  if (!parsed || typeof parsed !== 'object') return null;
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;

  const typed = messages.filter(
    (m): m is { readonly role?: unknown; readonly content?: unknown } => m !== null && typeof m === 'object',
  );
  let turnStart = 0;
  typed.forEach((message, index) => {
    if (message.role === 'user' && messageTexts(message).length > 0) turnStart = index + 1;
  });

  const segments = typed
    .slice(turnStart)
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => messageTexts(message));

  if (segments.length === 0) return null;
  return segments.join('\n\n').trim();
}

// ─── Heredoc Escaping ────────────────────────────────────────

/**
 * Ensures a heredoc delimiter does not collide with the input content.
 *
 * If the default delimiter appears in the content, appends random hex
 * suffixes until a unique delimiter is found. The content itself is
 * never modified -- only the delimiter changes.
 */
export function escapeHeredoc(content: string): { delimiter: string } {
  let delimiter = DEFAULT_HEREDOC_DELIMITER;

  while (content.includes(delimiter)) {
    const suffix = randomBytes(4).toString('hex');
    delimiter = `${DEFAULT_HEREDOC_DELIMITER}_${suffix}`;
  }

  return { delimiter };
}

// ─── System Prompt ───────────────────────────────────────────

function buildGooseDockerEnvironmentPrompt(context: OrientationContext): string {
  return `## Docker Environment

${buildWorkspaceAccessSection(context, 'built-in tools', 'IronCurtain MCP tools')}
${buildNestedDockerSection(context)}
${buildPolicySection('MCP tool call')}
${buildAttributionSection()}`;
}

// ─── Orientation Scripts ─────────────────────────────────────

function buildStartScript(): string {
  return `#!/bin/bash
# Runtime-native PTY exec does not inherit variables exported by PID 1.
# Read the mounted prompt here as well as in the image entrypoint.
if [ -f /etc/ironcurtain/system-prompt.txt ]; then
  export IRONCURTAIN_SYSTEM_PROMPT
  IRONCURTAIN_SYSTEM_PROMPT=$(cat /etc/ironcurtain/system-prompt.txt)
fi

# Set initial terminal size from host env vars
if [ -n "$IRONCURTAIN_INITIAL_COLS" ] && [ -n "$IRONCURTAIN_INITIAL_ROWS" ]; then
  stty cols "$IRONCURTAIN_INITIAL_COLS" rows "$IRONCURTAIN_INITIAL_ROWS" 2>/dev/null
fi

# The host names the session after the IronCurtain session id, so a resumed
# PTY session finds it in the mounted session store.
SESSION_ARGS=()
if [ -n "$${PTY_SESSION_NAME_ENV}" ]; then
  SESSION_ARGS=(--name "$${PTY_SESSION_NAME_ENV}")
fi

# shellcheck disable=SC2086
if [ -n "$${PTY_RESUME_FLAGS_ENV}" ] && [ \${#SESSION_ARGS[@]} -gt 0 ]; then
  # Continue the named session; if it cannot be resumed, start it fresh.
  goose session "\${SESSION_ARGS[@]}" $${PTY_RESUME_FLAGS_ENV}
  STATUS=$?
  if [ $STATUS -eq 0 ]; then
    exit 0
  fi
fi

# Write system prompt to temp file for --instructions
PROMPT_FILE=$(mktemp /tmp/goose-prompt-XXXXXX.md)
trap 'rm -f "$PROMPT_FILE"' EXIT
printf '%s' "$IRONCURTAIN_SYSTEM_PROMPT" > "$PROMPT_FILE"
exec goose run -s "\${SESSION_ARGS[@]}" -i "$PROMPT_FILE"
`;
}

// ─── Adapter Factory ─────────────────────────────────────────

/**
 * The Goose session name for a batch conversation: the agent conversation id
 * itself, validated so it can only ever be a single `--name` value.
 */
function gooseSessionName(conversationId: string): string {
  if (!isConversationName(conversationId)) {
    throw new Error(`Invalid Goose session name: ${JSON.stringify(conversationId)}`);
  }
  return conversationId;
}

/**
 * Creates the Goose agent adapter. It takes no configuration: the provider
 * and model come from the per-session config on every call
 * ({@link resolveGooseSelection}), so `--list-agents` and the first-start
 * wizard can register it before any config exists, and a daemon applies
 * config edits to its next session without a restart.
 */
export function createGooseAdapter(): AgentAdapter {
  const adapter: AgentAdapter = {
    id: 'goose' as AgentId,
    displayName: 'Goose',
    credentialHelpText(config: IronCurtainConfig): string {
      const { provider } = resolveGooseSelection(config);
      return (
        `No API key found for Goose provider "${provider}". ` +
        `Set ${PROVIDER_ENV_VARS[provider]} in your environment or configure it via \`ironcurtain config\`.`
      );
    },
    // Path Goose's native skill discovery scans. No batch args or PTY env —
    // Goose auto-discovers from this fixed path.
    skills: { containerPath: '/home/codespace/.config/goose/skills' },

    // eslint-disable-next-line @typescript-eslint/require-await -- interface requires Promise return
    async getImage(): Promise<string> {
      return GOOSE_IMAGE;
    },

    // Checked against the qualified range once per image build (best-effort:
    // output without a version is only logged).
    versionProbe: ['goose', '--version'],
    cliVersion: GOOSE_CLI_VERSION,

    generateMcpConfig(socketPath: string): AgentConfigFile[] {
      const transport = mcpClientCommand(socketPath);

      const yaml = [
        'GOOSE_TELEMETRY_ENABLED: false',
        'extensions:',
        '  ironcurtain:',
        '    name: IronCurtain Sandbox',
        '    type: stdio',
        '    enabled: true',
        `    cmd: ${transport.command}`,
        '    args:',
        ...transport.args.map((arg) => `      - ${transport.tcp ? JSON.stringify(arg) : arg}`),
        // Goose inherits the process environment for local stdio children.
        // env_keys performs a secret lookup and rejects an absent token,
        // which would break the retained tokenless host-only transport.
        '    timeout: 600',
        '',
      ].join('\n');

      return [{ path: 'goose-config.yaml', content: yaml }];
    },

    generateOrientationFiles(): AgentConfigFile[] {
      return [
        { path: 'start-goose.sh', content: buildStartScript(), mode: 0o755 },
        { path: 'resize-pty.sh', content: buildResizePtyScript('goose'), mode: 0o755 },
        { path: 'check-pty-size.sh', content: buildCheckPtySizeScript('goose'), mode: 0o755 },
      ];
    },

    // Each conversation is a named Goose session in the mounted session
    // store: the first turn creates it (`--name <conversation id>`, system
    // prompt plus message), later turns continue it (`--resume`, the message
    // alone; the session already holds the orientation). Session arguments
    // travel as positional parameters ("$@"), never inside the script text.
    // Client-owned model selection passes batch overrides via --model. Other
    // routes retain the GOOSE_MODEL startup selection.
    buildCommand(message: string, systemPrompt: string, options: AgentCommandOptions): readonly string[] {
      const resume = !options.firstTurn;
      const instructions = resume ? message : `${systemPrompt}\n\n---\n\nUser request:\n${message}`;
      const { delimiter } = escapeHeredoc(instructions);
      const modelOverride = options.modelOverride
        ? resolveGatewayCommandModel(options.providerProfile, options.modelOverride, 'goose')
        : undefined;

      return [
        '/bin/sh',
        '-c',
        `PROMPT_FILE=$(mktemp /tmp/goose-prompt-XXXXXX.md) && ` +
          `trap 'rm -f "$PROMPT_FILE"' EXIT && ` +
          `cat > "$PROMPT_FILE" << '${delimiter}'\n${instructions}\n${delimiter}\n` +
          `goose run --quiet --output-format json -i "$PROMPT_FILE" "$@"`,
        'ironcurtain-goose',
        '--name',
        gooseSessionName(options.sessionId),
        ...(resume ? ['--resume'] : []),
        ...(modelOverride ? ['--model', modelOverride] : []),
      ];
    },

    buildSystemPrompt(context: OrientationContext): string {
      const codeModePrompt = buildSystemPrompt(context.serverListings);
      const dockerPrompt = buildGooseDockerEnvironmentPrompt(context);
      return `${codeModePrompt}\n${dockerPrompt}`;
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface requires authKind parameter
    getProviders(config: IronCurtainConfig, _authKind?: DockerAuthKind): readonly ProviderConfig[] {
      const gateway = gatewayProviders(config, 'chat', 'goose', ['gpt-4o-mini']);
      if (gateway) return gateway;
      // Goose uses exactly one provider, the session's configured one.
      // The authKind parameter is ignored because Goose does not support OAuth.
      return [getProviderConfig(resolveGooseSelection(config).provider)];
    },

    buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Record<string, string> {
      const { provider: gooseProvider, model: gooseModel } = resolveGooseSelection(config);
      // Goose reads its agentic-turn cap from the environment at container
      // start, so the per-turn step budget is applied here rather than per
      // `buildCommand` (defence in depth; see AgentAdapter.buildCommand).
      // Omitted when the operator disabled the step limit.
      const maxTurns = resolveMaxAgentTurns(config);
      const maxTurnsEnv: Record<string, string> = maxTurns === undefined ? {} : { GOOSE_MAX_TURNS: String(maxTurns) };
      const profile = gatewayProfile(config.activeProviderProfile);
      if (profile) {
        const client = resolveChatClient(profile, gooseModel);
        const env: Record<string, string> = {
          GOOSE_PROVIDER: client.provider,
          GOOSE_MODEL: client.model,
          [client.credentialEnv]: gatewaySentinel(fakeKeys, client.route.host),
          GOOSE_MODE: 'auto',
          ...maxTurnsEnv,
          SSL_CERT_FILE: CONTAINER_RUNTIME_CA_BUNDLE,
          SSL_CERT_DIR: '/etc/ssl/certs',
        };
        if (client.endpointOverride) {
          const base = new URL(client.route.baseUrl);
          env.OPENAI_HOST = base.origin;
          env.OPENAI_BASE_PATH = `${base.pathname.slice(1)}/chat/completions`;
        }
        return env;
      }

      const env: Record<string, string> = {
        GOOSE_PROVIDER: gooseProvider,
        GOOSE_MODEL: gooseModel,
        GOOSE_MODE: 'auto',
        ...maxTurnsEnv,
        // Defensive TLS cert env vars for Rust-based Goose.
        // Covers native-tls and rustls-native-certs backends.
        SSL_CERT_FILE: CONTAINER_RUNTIME_CA_BUNDLE,
        SSL_CERT_DIR: '/etc/ssl/certs',
      };

      const providerHost = getProviderConfig(gooseProvider).host;
      const fakeKey = fakeKeys.get(providerHost);
      if (!fakeKey) {
        throw new Error(`No fake key generated for ${providerHost}`);
      }

      switch (gooseProvider) {
        case 'anthropic':
          env.ANTHROPIC_API_KEY = fakeKey;
          break;
        case 'openai':
          env.OPENAI_API_KEY = fakeKey;
          break;
        case 'google':
          env.GOOGLE_API_KEY = fakeKey;
          break;
      }

      return env;
    },

    /**
     * NOTE: this adapter does NOT currently populate
     * `AgentResponse.quotaExhausted` or `AgentResponse.transientFailure`.
     * Goose's `--output-format json` envelope wraps provider errors as
     * plain assistant text (e.g. "Ran into this error: Authentication
     * error: ... 401 ...") with no structured `api_error_status` field
     * or `usage.output_tokens` / `stop_reason` to key off of. A workflow
     * run that hits a 429 or a sustained upstream stall under Goose
     * therefore takes the generic abort path instead of pausing cleanly
     * or marking the run as transient-resumable.
     *
     * Closing these gaps requires either (a) Goose surfacing structured
     * error envelopes upstream, or (b) a fragile regex against known
     * provider messages ("Usage limit reached", "429",
     * "rate_limit_exceeded"); (b) is deliberately not attempted without
     * broader testing across providers. See the Claude Code adapter
     * (`adapters/claude-code.ts`) for the target contract and
     * `AgentResponse.quotaExhausted` / `AgentResponse.transientFailure`
     * in `../agent-adapter.ts` for the interface-level requirement on
     * adapters.
     */
    extractResponse(exitCode: number, stdout: string, stderr = ''): AgentResponse {
      assertAgentResponseOutputBound(stdout, stderr);
      const clean = stripAnsi(stdout);

      if (exitCode !== 0) {
        return { text: `Goose exited with code ${exitCode}.\n\nOutput:\n${clean.trim()}` };
      }

      // `goose run --output-format json` returns a structured envelope
      // listing every turn message with typed content. We pick the
      // assistant text — tool_use entries, user echoes, and the CLI
      // chrome are dropped without heuristic guesswork. Fall back to the
      // raw stripped output if the schema ever drifts so we degrade to
      // "noisy but functional" rather than dropping content.
      return { text: extractAssistantText(clean) ?? clean.trim() };
    },

    buildPtyCommand(
      _systemPrompt: string,
      ptySockPath: string | undefined,
      ptyPort: number | undefined,
    ): readonly string[] {
      const listenArg = ptySockPath ? `UNIX-LISTEN:${ptySockPath},fork` : `TCP-LISTEN:${ptyPort},reuseaddr`;

      return ['socat', listenArg, 'EXEC:/etc/ironcurtain/start-goose.sh,pty,setsid,ctty,stderr,rawer'];
    },

    buildPtyExecCommand(): readonly string[] {
      return ['/etc/ironcurtain/start-goose.sh'];
    },

    detectCredential(config: IronCurtainConfig): AuthMethod {
      // Gateway profiles: credential presence is the profile's non-empty apiKey;
      // empty ⇒ 'none' (feeds m5). Native ⇒ undefined, so fall through to the
      // goose provider's API-key detection.
      const openRouter = gatewayCredential(config);
      if (openRouter) return openRouter;
      const key = resolveApiKeyForProvider(resolveGooseSelection(config).provider, config.userConfig);
      if (key) return { kind: 'apikey', key };
      return { kind: 'none' };
    },

    getConversationStateConfig(): ConversationStateConfig {
      return {
        hostDirName: 'goose-state',
        containerMountPath: GOOSE_SESSIONS_CONTAINER_DIR,
        // Goose creates its store on first use; nothing to seed.
        seed: [],
        // `goose session --name <IRONCURTAIN_SESSION_NAME> --resume` (start-goose.sh).
        resumeFlags: ['--resume'],
        transcriptLayout: 'goose-sessions',
      };
    },
  };

  return adapter;
}
