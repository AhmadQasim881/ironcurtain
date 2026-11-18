import { buildCodexModelCatalog } from './codex-model-catalog.js';
import { mcpClientCommand, MCP_TCP_TOKEN_ENV } from '../mcp-client-command.js';
import { gatewayProfile, resolveResponsesClient, resolveGatewayCommandModel } from '../../config/gateway-client.js';
import { gatewayProviders, gatewayCredential, gatewaySentinel } from '../gateway-runtime.js';
/**
 * Codex CLI adapter for Docker Agent Mode.
 *
 * Runs OpenAI Codex CLI non-interactively through the same container,
 * MCP proxy, and MITM fake-token path as other Docker agents. The adapter
 * uses Codex's ChatGPT OAuth/access-token flow, not OPENAI_API_KEY.
 *
 * Conversation continuity: Codex mints its own thread id (reported by the
 * `thread.started` event of `exec --json`) rather than accepting ours. The
 * first turn of a conversation runs `codex exec <prompt>`; `extractResponse`
 * reports the thread as `agentThreadId`, the session records it against its
 * agent conversation id, and later turns run `codex exec resume <thread>
 * <message>`. Never `--last`: workflow states that share a container share
 * `~/.codex`. A PTY resume runs `codex resume <thread>` for the most recently
 * active rollout of that session's own state directory.
 */

import type {
  AgentAdapter,
  AgentCommandOptions,
  AgentConfigFile,
  AgentId,
  AgentResponse,
  ConversationStateConfig,
  OrientationContext,
  TransientFailureKind,
} from '../agent-adapter.js';
import type { DockerAuthKind, IronCurtainConfig } from '../../config/types.js';
import type { ProviderConfig } from '../provider-config.js';
import type { AuthMethod } from '../oauth-credentials.js';
import { normalizeCodexThreadId, PTY_RESUME_ID_ENV } from '../conversation-state.js';
import { buildSystemPrompt } from '../../session/prompts.js';
import { codexAuthProvider, codexChatGptProvider } from '../provider-config.js';
import { CONTAINER_RUNTIME_CA_BUNDLE, CONTAINER_RUNTIME_CA_CERT } from '../runtime-trust.js';
import { CODEX_CLI_VERSION } from '../agent-cli-version.js';
import { loadCodexOAuthCredentials } from '../oauth-credentials.js';
import { parseModelId } from '../../config/model-id.js';
import {
  buildAttributionSection,
  buildCheckPtySizeScript,
  buildWorkspaceAccessSection,
  buildNestedDockerSection,
  buildPolicySection,
  buildResizePtyScript,
} from './shared-scripts.js';

const CODEX_IMAGE = 'ironcurtain-codex:latest';

/**
 * Codex CLI version installed by `docker/Dockerfile.codex` (`ARG CODEX_VERSION`,
 * recorded as {@link CODEX_CLI_VERSION}). The native provider binding sends it
 * as the built-in provider's `version` header; a test ties the two together,
 * so bump them together.
 */
export const CODEX_CLIENT_VERSION = CODEX_CLI_VERSION.pinned;

/**
 * Provider id of the native ChatGPT binding. Codex refuses a config that
 * redefines one of its built-in providers ("model_providers contains reserved
 * built-in provider IDs: `lmstudio`, `ollama`, `openai`"), so the binding that
 * stands in for the built-in `openai` provider needs an id of its own.
 */
export const CODEX_NATIVE_PROVIDER_ID = 'ironcurtain-chatgpt';

const CODEX_FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  'eyJlbWFpbCI6Imlyb25jdXJ0YWluQGV4YW1wbGUuaW52YWxpZCIsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X3BsYW5fdHlwZSI6InBybyIsImNoYXRncHRfdXNlcl9pZCI6Imlyb25jdXJ0YWluLXVzZXIiLCJjaGF0Z3B0X2FjY291bnRfaWQiOiJpcm9uY3VydGFpbi1hY2NvdW50IiwiY2hhdGdwdF9hY2NvdW50X2lzX2ZlZHJhbXAiOmZhbHNlfX0.' +
  'c2ln';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildCodexDockerEnvironmentPrompt(context: OrientationContext): string {
  return `## Docker Environment

${buildWorkspaceAccessSection(context, 'built-in shell tools', 'IronCurtain MCP tools')}
${buildNestedDockerSection(context)}
${buildPolicySection('MCP tool call')}
${buildAttributionSection()}`;
}

function buildStartScript(): string {
  return `#!/bin/bash
# Runtime-native PTY exec does not inherit variables exported by PID 1.
# Read the mounted prompt here as well as in the image entrypoint.
if [ -f /etc/ironcurtain/system-prompt.txt ]; then
  export IRONCURTAIN_SYSTEM_PROMPT
  IRONCURTAIN_SYSTEM_PROMPT=$(cat /etc/ironcurtain/system-prompt.txt)
fi

if [ -n "$IRONCURTAIN_INITIAL_COLS" ] && [ -n "$IRONCURTAIN_INITIAL_ROWS" ]; then
  stty cols "$IRONCURTAIN_INITIAL_COLS" rows "$IRONCURTAIN_INITIAL_ROWS" 2>/dev/null
fi
cd /workspace

MODEL_ARGS=()
if [ -n "$IRONCURTAIN_MODEL" ]; then
  MODEL_ARGS=(--model "$IRONCURTAIN_MODEL")
fi

# Codex accepts additional session-wide developer instructions through its
# config layer. JSON string encoding is valid TOML and keeps the mounted prompt
# in one argv element even when it contains quotes or newlines.
DEVELOPER_INSTRUCTIONS=$(node -e 'process.stdout.write(JSON.stringify(process.env.IRONCURTAIN_SYSTEM_PROMPT || ""))')

# On resume the host names the thread to continue (the session's most recently
# active rollout, a validated UUID). If Codex cannot resume it, start fresh.
if [ -n "$${PTY_RESUME_ID_ENV}" ]; then
  codex --ask-for-approval never --sandbox danger-full-access -c "developer_instructions=$DEVELOPER_INSTRUCTIONS" "\${MODEL_ARGS[@]}" --cd /workspace resume "$${PTY_RESUME_ID_ENV}"
  STATUS=$?
  if [ $STATUS -eq 0 ]; then
    exit 0
  fi
fi

exec codex --ask-for-approval never --sandbox danger-full-access -c "developer_instructions=$DEVELOPER_INSTRUCTIONS" "\${MODEL_ARGS[@]}" --cd /workspace
`;
}

type ResponsesClient = ReturnType<typeof resolveResponsesClient>;

/** A `[model_providers.<id>]` table and the root keys that select it. */
interface CodexProviderBinding {
  readonly id: string;
  readonly rootKeys: readonly string[];
  readonly fields: readonly string[];
}

/**
 * Native ChatGPT route. Codex's built-in `openai` provider talks Responses over
 * a WebSocket (`wss://chatgpt.com/backend-api/codex/responses`) and falls back
 * to POST + SSE only after its handshake retries fail. The MITM never bridges
 * WebSockets on provider hosts (see the inner `upgrade` listener in
 * mitm-proxy.ts), so every `codex exec` turn spent about 7 s on failed
 * handshakes before its first request. This binding reproduces the built-in
 * provider as Codex 0.157.1 defines it, with WebSockets off: the same name,
 * Responses wire API, ChatGPT login (`requires_openai_auth`) and `version`
 * header, and no `base_url`, so Codex still derives the ChatGPT backend URL
 * from the login mode. Left out: the `OPENAI_ORGANIZATION`/`OPENAI_PROJECT`
 * header variables, which the container never sets, and
 * `supports_standalone_web_search`, which IronCurtain does not need because
 * web search is disabled (see `buildCodexToml`).
 *
 * Codex lists resumable sessions per provider id, so its own resume picker
 * does not offer sessions recorded under the built-in id. IronCurtain never
 * resumes Codex sessions.
 */
function nativeProviderBinding(): CodexProviderBinding {
  return {
    id: CODEX_NATIVE_PROVIDER_ID,
    rootKeys: [`model_provider = ${tomlString(CODEX_NATIVE_PROVIDER_ID)}`],
    fields: [
      'name = "OpenAI"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      `http_headers = { version = ${tomlString(CODEX_CLIENT_VERSION)} }`,
    ],
  };
}

/** Built-in gateway route: provider and capability data arrive through the client binding. */
function gatewayProviderBinding(client: ResponsesClient): CodexProviderBinding {
  return {
    id: client.route.id,
    rootKeys: [
      `model = ${tomlString(client.model)}`,
      `model_provider = ${tomlString(client.route.id)}`,
      ...(client.catalogModels
        ? [`model_catalog_json = ${tomlString(`/etc/ironcurtain/${client.route.id}-models.json`)}`]
        : []),
    ],
    fields: [
      `name = ${tomlString(client.route.label)}`,
      `base_url = ${tomlString(client.route.baseUrl)}`,
      `env_key = ${tomlString(client.credentialEnv)}`,
      'wire_api = "responses"',
    ],
  };
}

/**
 * Root keys precede TOML tables: a key after a table header belongs to that table.
 *
 * `web_search = "disabled"`: Codex enables the provider-hosted `web_search`
 * tool by default (live search under `danger-full-access`), which would let
 * the provider browse for the agent outside the MCP policy engine. The MITM's
 * openai-responses sanitizer strips the tool on every route regardless (the
 * agent can edit this file); disabling it here keeps Codex from offering the
 * model a tool that would only be removed in flight.
 *
 * `supports_websockets = false` on every route: the MITM refuses WebSocket
 * upgrades on provider hosts instead of bridging them, because the request
 * sanitizers, credential gate, trajectory capture, token stream and LLM metrics
 * all work on HTTP requests and SSE responses. With the key off, Codex sends
 * each turn as POST + SSE at once instead of first failing handshakes. Codex
 * 0.157.1 already defaults a custom provider to `false`; the explicit key keeps
 * the binding from depending on that default. The agent can edit this file;
 * the proxy still refuses any upgrade it then attempts.
 */
function buildCodexToml(connectTarget: string, client: ResponsesClient | undefined): string {
  const transport = mcpClientCommand(connectTarget);
  const rootKeys = [
    'cli_auth_credentials_store = "file"',
    'project_doc_fallback_filenames = ["CLAUDE.md"]',
    'web_search = "disabled"',
  ];
  const provider = client ? gatewayProviderBinding(client) : nativeProviderBinding();
  return [
    ...provider.rootKeys,
    ...rootKeys,
    '',
    '[projects."/workspace"]',
    'trust_level = "trusted"',
    '',
    `[model_providers.${provider.id}]`,
    ...provider.fields,
    'supports_websockets = false',
    '',
    '[mcp_servers.ironcurtain]',
    `command = ${tomlString(transport.command)}`,
    `args = [${transport.args.map(tomlString).join(', ')}]`,
    ...(transport.tcp ? [`env_vars = [${tomlString(MCP_TCP_TOKEN_ENV)}]`] : []),
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 600',
    'default_tools_approval_mode = "auto"',
    '',
  ].join('\n');
}

/**
 * Creates the Codex adapter. It takes no configuration: everything
 * session-specific (the active provider profile, the agent model) is read
 * from the per-session `config` or the `buildCommand` options at call time,
 * never captured here. The registry keeps one adapter instance per process,
 * and a daemon serves many sessions, each with freshly loaded config (§9 F1).
 */
export function createCodexAdapter(): AgentAdapter {
  return {
    id: 'codex' as AgentId,
    displayName: 'Codex CLI',
    credentialHelpText: () =>
      'No Codex OAuth credentials found. Run `codex login` on the host; OPENAI_API_KEY is not required.',

    // eslint-disable-next-line @typescript-eslint/require-await -- interface requires Promise return
    async getImage(): Promise<string> {
      return CODEX_IMAGE;
    },

    // `codex --version` prints `codex-cli <version>`; infra prep checks it
    // against the qualified range once per image build.
    versionProbe: ['codex', '--version'],
    cliVersion: CODEX_CLI_VERSION,

    generateMcpConfig(socketPath: string, config: IronCurtainConfig): AgentConfigFile[] {
      const profile = gatewayProfile(config.activeProviderProfile);
      const client = profile ? resolveResponsesClient(profile, config.agentModelId) : undefined;
      return [
        { path: 'codex-config.toml', content: buildCodexToml(socketPath, client) },
        ...(client?.catalogModels
          ? [
              {
                path: `${client.route.id}-models.json`,
                content: buildCodexModelCatalog(client.catalogModels, client.route.label),
              },
            ]
          : []),
      ];
    },

    generateOrientationFiles(): AgentConfigFile[] {
      return [
        { path: 'start-codex.sh', content: buildStartScript(), mode: 0o755 },
        { path: 'resize-pty.sh', content: buildResizePtyScript('codex'), mode: 0o755 },
        { path: 'check-pty-size.sh', content: buildCheckPtySizeScript('codex'), mode: 0o755 },
      ];
    },

    /**
     * First turn: `codex ... exec --json ... <system prompt + message>`.
     * Later turns, once a thread was recorded for this conversation:
     * `codex ... exec --json ... resume -- <thread> <message>`. The exec
     * options precede `resume` (they belong to `exec`), and the resumed thread
     * already holds the orientation from its first turn, so only the message
     * is sent. `--` keeps a message that starts with `-` from being parsed as
     * an option (the first-turn prompt always starts with the system prompt).
     * Without a recorded thread a later turn starts a new thread with the
     * full prompt; it never resumes `--last`.
     */
    buildCommand(message: string, systemPrompt: string, options: AgentCommandOptions): readonly string[] {
      const resumeThread = options.firstTurn ? undefined : normalizeCodexThreadId(options.agentThreadId);
      const cmd = ['codex', '--ask-for-approval', 'never', '--sandbox', 'danger-full-access'];
      if (options.modelOverride) {
        const selected = parseModelId(options.modelOverride).modelId;
        cmd.push('--model', resolveGatewayCommandModel(options.providerProfile, selected, 'codex') ?? selected);
      }
      cmd.push('exec', '--json', '--skip-git-repo-check', '--cd', '/workspace');
      if (resumeThread !== undefined) {
        cmd.push('resume', '--', resumeThread, message);
      } else {
        cmd.push(`${systemPrompt}\n\n---\n\nUser request:\n${message}`);
      }
      return cmd;
    },

    buildSystemPrompt(context: OrientationContext): string {
      const codeModePrompt = buildSystemPrompt(context.serverListings);
      const dockerPrompt = buildCodexDockerEnvironmentPrompt(context);
      return `${codeModePrompt}\n${dockerPrompt}`;
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- authKind kept for adapter interface symmetry
    getProviders(config: IronCurtainConfig, _authKind?: DockerAuthKind): readonly ProviderConfig[] {
      const gateway = gatewayProviders(config, 'responses', 'codex');
      if (gateway) return gateway;
      return [codexChatGptProvider, codexAuthProvider];
    },

    buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Record<string, string> {
      const profile = gatewayProfile(config.activeProviderProfile);
      if (profile) {
        const client = resolveResponsesClient(profile, config.agentModelId);
        return {
          CODEX_HOME: '/home/codespace/.codex',
          [client.credentialEnv]: gatewaySentinel(fakeKeys, client.route.host),
          CODEX_CA_CERTIFICATE: CONTAINER_RUNTIME_CA_CERT,
          SSL_CERT_FILE: CONTAINER_RUNTIME_CA_BUNDLE,
          ...(client.environmentModel ? { IRONCURTAIN_MODEL: client.environmentModel } : {}),
          RUST_LOG: 'error',
        };
      }

      const fakeToken = fakeKeys.get('chatgpt.com');
      if (!fakeToken) {
        throw new Error('No fake token generated for chatgpt.com — cannot configure Codex authentication');
      }

      return {
        CODEX_HOME: '/home/codespace/.codex',
        IRONCURTAIN_CODEX_ACCESS_TOKEN: fakeToken,
        IRONCURTAIN_CODEX_ID_TOKEN: CODEX_FAKE_ID_TOKEN,
        IRONCURTAIN_CODEX_ACCOUNT_ID: 'ironcurtain-account',
        CODEX_CA_CERTIFICATE: CONTAINER_RUNTIME_CA_CERT,
        SSL_CERT_FILE: CONTAINER_RUNTIME_CA_BUNDLE,
        RUST_LOG: 'error',
      };
    },

    /**
     * Parses the `exec --json` JSONL stream (see `scanCodexEvents`): the last
     * `agent_message` is the response, and `thread.started` names the thread
     * (reported as `agentThreadId` on every outcome, so a later turn can
     * resume a thread whose turn failed).
     *
     * Failure classification (quota / transient, see `AgentResponse`) reads
     * only the structured failure events and stderr, never the transcript:
     * agent messages and command output can say anything, including "429" or
     * "quota". The turn's own `turn.failed` events decide when present; other
     * failure-shaped events (top-level `error` events, which include Codex's
     * retry notices, and `error` items) only when the turn did not report one.
     * Each signal needs an explicit marker (`classifyCodexFailure`): quota
     * needs HTTP 429 or a provider quota code, `upstream_5xx` an explicit 5xx
     * status, `upstream_api_error` a recognized stream or connection failure
     * after Codex's own retries. Anything else is left unclassified, and a
     * run that wrote nothing to stdout is a `hardFailure` (the orchestrator
     * retries it on a fresh conversation), matching the Claude Code adapter.
     * `degenerate_response` keeps its documented meaning and is not used here.
     */
    extractResponse(exitCode: number, stdout: string, stderr = ''): AgentResponse {
      const clean = stdout.trim();
      const scan = scanCodexEvents(clean);
      const thread: Pick<AgentResponse, 'agentThreadId'> =
        scan.threadId === undefined ? {} : { agentThreadId: scan.threadId };

      if (exitCode === 0 && scan.finalMessage !== null) {
        return { text: scan.finalMessage, ...thread };
      }

      const signal = classifyCodexFailure(scan, stderr);
      const classified = signal.quotaExhausted !== undefined || signal.transientFailure !== undefined;
      const hardFailure = clean.length === 0 && !classified;

      let text: string;
      if (exitCode !== 0) {
        const errorOutput = [clean, stderr.trim()].filter((part) => part.length > 0).join('\n\n');
        text = `Codex exited with code ${exitCode}.\n\nOutput:\n${errorOutput}`;
      } else if (scan.failureMessage !== null) {
        // Exit 0 without a final message: describe the failure instead of
        // dumping a raw JSONL line.
        text = `Codex reported an error:\n\n${scan.failureMessage}`;
      } else if (clean.length === 0) {
        text =
          'Codex exited without producing output. Check the session log for startup failures ' +
          '(for example, exhausted Docker storage).';
      } else {
        text = clean;
      }
      return { text, ...thread, ...signal, ...(hardFailure ? { hardFailure: true } : {}) };
    },

    buildPtyCommand(
      _systemPrompt: string,
      ptySockPath: string | undefined,
      ptyPort: number | undefined,
    ): readonly string[] {
      const listenArg = ptySockPath ? `UNIX-LISTEN:${ptySockPath},fork` : `TCP-LISTEN:${ptyPort},reuseaddr`;
      return ['socat', listenArg, 'EXEC:/etc/ironcurtain/start-codex.sh,pty,setsid,ctty,stderr,rawer'];
    },

    buildPtyExecCommand(): readonly string[] {
      return ['/etc/ironcurtain/start-codex.sh'];
    },

    detectCredential(config: IronCurtainConfig): AuthMethod {
      // Gateway profiles: credential presence is the profile's non-empty apiKey
      // (no `codex login` needed); empty ⇒ 'none' (feeds m5). Native ⇒ undefined,
      // so fall through to Codex ChatGPT OAuth detection.
      const openRouter = gatewayCredential(config);
      if (openRouter) return openRouter;
      const credentials = loadCodexOAuthCredentials();
      if (!credentials) return { kind: 'none' };
      return {
        kind: 'oauth',
        credentials: {
          accessToken: credentials.accessToken,
          refreshToken: credentials.refreshToken,
          expiresAt: credentials.expiresAt,
        },
        source: 'file',
      };
    },

    getConversationStateConfig(): ConversationStateConfig {
      return {
        hostDirName: 'codex-state',
        containerMountPath: '/home/codespace/.codex/',
        seed: [
          { path: 'sessions/', content: '' },
          { path: 'logs/', content: '' },
        ],
        // PTY resume goes by thread id (IRONCURTAIN_RESUME_ID), not by flag.
        resumeFlags: [],
        transcriptLayout: 'codex-rollouts',
      };
    },
  };
}

/** One structured failure event of the Codex JSONL stream. */
interface CodexFailure {
  /** Human-readable message, for the response text and diagnostics. */
  readonly message: string;
  /** The message plus any explicit status / code fields, for classification only. */
  readonly probe: string;
}

/**
 * Result of a single pass over the Codex JSONL event stream.
 */
interface CodexScanResult {
  /** The last `agent_message` text (the happy path). */
  readonly finalMessage: string | null;
  /** The validated `thread_id` of the first `thread.started` event. */
  readonly threadId: string | undefined;
  /** `turn.failed` (any `*.failed`) events: the turn's own terminal failure. */
  readonly turnFailures: readonly CodexFailure[];
  /** Top-level `error` events (fatal errors and retry notices) and `error` items. */
  readonly otherFailures: readonly CodexFailure[];
  /** The message to show: the last turn failure, else the last other failure. */
  readonly failureMessage: string | null;
}

/**
 * Single-pass scan over the Codex `exec --json` JSONL stream.
 *
 * Collects the last `agent_message` text, the thread id, and the structured
 * failure events. Malformed/truncated lines are skipped (the JSONL stream can
 * be truncated when a process is killed), so a valid `agent_message` on a
 * later line is still recovered. Only top-level event fields are read as
 * failure signals; model text and command output live inside items and are
 * never classified.
 */
function scanCodexEvents(stdout: string): CodexScanResult {
  let lastAgentMessage: string | null = null;
  let threadId: string | undefined;
  const turnFailures: CodexFailure[] = [];
  const otherFailures: CodexFailure[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const event = parsed;
    const eventType = typeof event.type === 'string' ? event.type : undefined;
    const item = isRecord(event.item) ? event.item : undefined;

    if (item && item.type === 'agent_message' && typeof item.text === 'string') {
      lastAgentMessage = item.text;
    }

    if (eventType === 'thread.started' && threadId === undefined) {
      threadId = normalizeCodexThreadId(event.thread_id);
    }

    if (eventType !== undefined && eventType.endsWith('.failed')) {
      turnFailures.push(describeCodexFailure(event, eventType));
    } else if (eventType === 'error') {
      otherFailures.push(describeCodexFailure(event, eventType));
    } else if (item !== undefined && item.type === 'error') {
      otherFailures.push(describeCodexFailure(item, 'error item'));
    }
  }

  const failureMessage = (turnFailures.at(-1) ?? otherFailures.at(-1))?.message ?? null;
  return { finalMessage: lastAgentMessage?.trim() || null, threadId, turnFailures, otherFailures, failureMessage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Message and classification probe of one failure-shaped object (event or item). */
function describeCodexFailure(obj: Record<string, unknown>, fallback: string): CodexFailure {
  const message = pickErrorMessage(obj) ?? fallback;
  const structured = describeStructuredFailureFields(obj, 0);
  return { message, probe: [message, ...structured].join('\n') };
}

/** Pulls a message string from an `error.message` / `message` / `text` field. */
function pickErrorMessage(obj: Record<string, unknown>): string | undefined {
  const nested = obj.error;
  if (isRecord(nested)) {
    const msg = nested.message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  if (typeof obj.message === 'string' && obj.message.length > 0) return obj.message;
  if (typeof obj.text === 'string' && obj.text.length > 0) return obj.text;
  return undefined;
}

/** Fields that carry an HTTP status on a failure object. */
const STATUS_FIELDS = ['status', 'status_code', 'statusCode', 'http_status_code', 'httpStatusCode'] as const;
/** Fields that carry a provider or Codex error code (a string, or an enum object keyed by variant). */
const CODE_FIELDS = ['code', 'error_code', 'codex_error_info', 'codexErrorInfo'] as const;

/**
 * Renders the explicit status and code fields of a failure object, if the
 * Codex release emits any, as `HTTP status <n>` / `error code <code>` lines
 * so the same explicit patterns classify them as the message text. Looks two
 * levels deep at most (the nested `error` object, an enum object's payload).
 */
function describeStructuredFailureFields(obj: Record<string, unknown>, depth: number): string[] {
  const lines: string[] = [];
  for (const field of STATUS_FIELDS) {
    const value = obj[field];
    if (typeof value === 'number' && Number.isInteger(value)) lines.push(`HTTP status ${value}`);
  }
  for (const field of CODE_FIELDS) {
    const value = obj[field];
    if (typeof value === 'string') {
      lines.push(`error code ${value}`);
    } else if (isRecord(value) && depth < 2) {
      for (const [variant, payload] of Object.entries(value)) {
        lines.push(`error code ${variant}`);
        if (isRecord(payload)) lines.push(...describeStructuredFailureFields(payload, depth + 1));
      }
    }
  }
  const nested = obj.error;
  if (isRecord(nested) && depth < 2) {
    if (typeof nested.type === 'string') lines.push(`error code ${nested.type}`);
    lines.push(...describeStructuredFailureFields(nested, depth + 1));
  }
  return lines;
}

/**
 * Quota exhaustion needs an explicit marker: HTTP 429 as a status (Codex
 * renders `unexpected status 429 Too Many Requests: ...` and `exceeded retry
 * limit, last status: 429 ...`; explicit status fields render as `HTTP status
 * 429`), its reason phrase, a provider quota code, or the text Codex itself
 * renders for a `usage_limit_reached` / `insufficient_quota` response. A bare
 * 429 is not a status: a 400 response naming `input[429]`, a file name or a
 * token count in an error or log line must not pause a workflow as if its
 * quota were spent. The words "quota", "rate limit" or "usage limit" alone are
 * not enough either.
 */
const QUOTA_PATTERNS: readonly RegExp[] = [
  /(?:status(?:[ _]?code)?|\bhttp|\bcode)["']?\s?[:=]?\s?429\b/iu,
  /\btoo many requests\b/iu,
  /\b(?:rate_limit_exceeded|rate_limit_error|insufficient_quota|usage_limit_reached|usage_limit_exceeded|resource_exhausted)\b/iu,
  /\byou['’]ve hit your usage limit\b/iu,
  /\bquota exceeded\. check your plan and billing details\b/iu,
];

/** An explicit HTTP 5xx status ("last status: 503", "unexpected status 500 ...", "502 Bad Gateway"). */
const UPSTREAM_5XX_PATTERNS: readonly RegExp[] = [
  /\bstatus:? 5\d\d\b/iu,
  /\b5\d\d (?:internal server error|bad gateway|service unavailable|gateway timeout)\b/iu,
];

/** Codex's renderings of a provider stream or connection that failed after its own retries. */
const UPSTREAM_API_ERROR_PATTERNS: readonly RegExp[] = [
  /\bstream disconnected before completion\b/iu,
  /\bexceeded retry limit\b/iu,
  /\berror sending request for url\b/iu,
  /\bconnection failed:/iu,
];

/**
 * Classify a failed Codex run from its structured failure events and stderr
 * only. `turn.failed` decides when the turn reported one; otherwise the other
 * failure events do. Precedence follows the Claude Code adapter: quota, then
 * an explicit 5xx, then a recognized stream / connection failure. Returns no
 * signal for anything unrecognized.
 */
function classifyCodexFailure(
  scan: CodexScanResult,
  stderr: string,
): Pick<AgentResponse, 'quotaExhausted' | 'transientFailure'> {
  const failures = scan.turnFailures.length > 0 ? scan.turnFailures : scan.otherFailures;
  const stderrText = stderr.trim();
  const probe = [...failures.map((failure) => failure.probe), stderrText].filter((part) => part.length > 0).join('\n');
  if (probe.length === 0) return {};
  const described = [...failures.map((failure) => failure.message), stderrText]
    .filter((part) => part.length > 0)
    .join('\n');
  const rawMessage = described.length > 0 ? described : probe;

  if (QUOTA_PATTERNS.some((pattern) => pattern.test(probe))) {
    return { quotaExhausted: { rawMessage } };
  }
  const transient = (kind: TransientFailureKind): Pick<AgentResponse, 'transientFailure'> => ({
    transientFailure: { kind, rawMessage },
  });
  if (UPSTREAM_5XX_PATTERNS.some((pattern) => pattern.test(probe))) return transient('upstream_5xx');
  if (UPSTREAM_API_ERROR_PATTERNS.some((pattern) => pattern.test(probe))) return transient('upstream_api_error');
  return {};
}
