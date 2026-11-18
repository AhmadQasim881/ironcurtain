/**
 * LLM API provider configuration for the MITM proxy.
 *
 * Each provider defines its host, allowed endpoints (and the few of them a
 * client calls without a credential), key injection method, fake key prefix
 * and the request sanitizers bound to its completion endpoints. The proxy uses
 * these to filter requests, strip provider-hosted tools and swap sentinel keys
 * for real ones (`provider-credentials.ts`).
 */

import { isPlainObject } from '../utils/is-plain-object.js';
import type { ProviderKeyHeaderName } from './credential-carriers.js';
import { matchesEndpointPattern, resolveCompletionEndpoint } from './llm-observation/completion-endpoint.js';
import {
  openaiPlatformSanitizer,
  sanitizedEndpointsFor,
  type RequestSanitizer,
  type SanitizedEndpoint,
} from './request-sanitizers/index.js';

/**
 * Discriminator for the execution mode invoking the proxy. Set at proxy
 * construction time via `MitmProxyOptions.agentKind`. Batch and workflow
 * agents invoke their CLI as one-shot subprocesses; PTY agents retain the
 * interactive CLI runtime. `undefined` means unknown, so no mode-conditional
 * rewrites apply.
 */
export type AgentKind = 'batch' | 'workflow' | 'pty';

/**
 * Result from a RequestBodyRewriter when modifications were made.
 */
export interface RewriteResult {
  /** The modified request body object. */
  readonly modified: Record<string, unknown>;
  /** Human-readable descriptions of what was stripped (for logging). */
  readonly stripped: string[];
}

/**
 * A function that inspects and optionally modifies a parsed JSON request body.
 * Returns a RewriteResult if the body was modified, or null if no changes needed.
 *
 * `context.agentKind` is the kind of agent that originated the request, when
 * known. Rewriters that condition on agent kind should treat `undefined` as
 * "no agent-kind context available" and fall back to the most conservative
 * (i.e. non-stripping) behavior.
 */
export type RequestBodyRewriter = (
  body: Record<string, unknown>,
  context: {
    method: string;
    path: string;
    agentKind?: AgentKind;
    /**
     * Stable per-conversation id used for OpenRouter `session_id` injection
     * (GLM cache affinity, D4). Set from the proxy's `tokenSessionId` snapshot.
     * All existing rewriters ignore it (backward-compatible).
     */
    cacheKey?: string;
  },
) => RewriteResult | null;

/**
 * Upstream target for provider requests when the default API host
 * is overridden via environment variables (e.g., ANTHROPIC_BASE_URL).
 * The MITM proxy uses this to route upstream connections to a custom
 * API gateway (e.g., LiteLLM) instead of the provider's canonical host.
 */
export interface UpstreamTarget {
  /** Hostname of the upstream server. */
  readonly hostname: string;
  /** Port number of the upstream server. */
  readonly port: number;
  /** Path prefix to prepend to all request paths ('' for none). */
  readonly pathPrefix: string;
  /** Whether to use TLS for the upstream connection. */
  readonly useTls: boolean;
}

/**
 * Parses a base URL string into an UpstreamTarget.
 *
 * Supports http:// and https:// URLs. The path component becomes the
 * pathPrefix (trailing slashes stripped). Defaults to port 443 for
 * https and port 80 for http when no port is specified.
 *
 * @throws {Error} If the URL uses an unsupported protocol.
 */
export function parseUpstreamBaseUrl(baseUrl: string): UpstreamTarget {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported protocol in upstream base URL: ${parsed.protocol}`);
  }
  const useTls = parsed.protocol === 'https:';
  const defaultPort = useTls ? 443 : 80;
  const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
  const pathPrefix = parsed.pathname.replace(/\/+$/, '');

  return { hostname: parsed.hostname, port, pathPrefix, useTls };
}

export interface ProviderConfig {
  /** Stable logical route/service identifier used by content-free statistics. */
  readonly id?: string;

  /** Hostname of the API endpoint (e.g., 'api.anthropic.com'). */
  readonly host: string;

  /** Human-readable provider name for logging. */
  readonly displayName: string;

  /**
   * Allowed HTTP endpoints. Requests not matching any pattern get 403.
   * Patterns use exact method match and path matching (see EndpointPattern).
   */
  readonly allowedEndpoints: readonly EndpointPattern[];

  /**
   * Allowed endpoints a client calls without any credential (connectivity
   * checks, public catalogs and key sets). A request that presents no
   * credential is forwarded, with none, only to these; anywhere else it gets a
   * local 401. Each entry must also appear in `allowedEndpoints` (checked when
   * the proxy starts): this list never grants network access. A request that
   * presents the session sentinel here still gets the real key, and any other
   * credential still gets a 401 (see `provider-credentials.ts`).
   */
  readonly unauthenticatedEndpoints?: readonly EndpointPattern[];

  /**
   * Endpoints whose exchanges are training-relevant and may be recorded by
   * the trajectory-capture pipeline. Same matcher shape as
   * `allowedEndpoints` (method + path glob, query string stripped before
   * matching). This is an ALLOWLIST: only completion endpoints belong here
   * (e.g. Anthropic `/v1/messages`, OpenAI Responses `/v1/responses`). The
   * large volume of host-shared housekeeping traffic (MCP-registry
   * pagination, telemetry batches, settings/eval pings) is deliberately
   * excluded so it never pollutes the captured corpus.
   *
   * Absent or empty means "capture nothing" — custom/unlisted providers do
   * not accidentally capture. See `isCapturableEndpoint` and §3 integration
   * point 4 of docs/designs/mitm-token-trajectory-capture.md.
   */
  readonly captureEndpoints?: readonly EndpointPattern[];

  /** Explicit completion protocol descriptors; never expands allowedEndpoints. */
  readonly completionEndpoints?: readonly import('./llm-observation/completion-endpoint.js').CompletionEndpoint[];

  /** Gateway metadata adapter. Base-URL overrides downgrade direct routes to opaque. */
  readonly gatewayAdapterId?: string;

  /**
   * How the API key is transmitted in requests: where the proxy injects the
   * real key once the session sentinel was presented. The sentinel itself is
   * accepted in any credential carrier and moved here.
   */
  readonly keyInjection: KeyInjection;

  /**
   * Prefix for generating fake sentinel keys that pass client-side validation.
   * Example: 'sk-ant-api03-' for Anthropic.
   */
  readonly fakeKeyPrefix: string;

  /**
   * Optional compatibility rewriter (model mapping, schedule-tool strips,
   * gateway fields). Only called for endpoints listed in rewriteEndpoints.
   * It is not a security control: hosted-tool removal is the job of
   * `sanitizedEndpoints`, which runs after it.
   */
  readonly requestRewriter?: RequestBodyRewriter;

  /**
   * Paths for which the proxy should buffer and rewrite request bodies.
   * Only applies to POST requests. Requires requestRewriter to be set.
   */
  readonly rewriteEndpoints?: readonly string[];

  /**
   * Endpoints whose request bodies pass through a protocol sanitizer that
   * removes provider-hosted tools, connectors and URL-sourced content (see
   * `./request-sanitizers/index.ts`). The proxy buffers, sanitizes and
   * re-serializes every such request that passes its credential gate
   * (decoding a compressed body first), and answers a body it cannot sanitize
   * with a local 400, 413 or 415 instead of forwarding it.
   * Built-in providers declare a binding for every completion endpoint, plus
   * same-format siblings such as count_tokens; `sanitizedEndpointsFor` keeps a
   * declaration inert (`[]`) until its protocol registers a sanitizer.
   */
  readonly sanitizedEndpoints?: readonly SanitizedEndpoint[];

  /**
   * Optional upstream target override. When set, the MITM proxy routes
   * requests to this target instead of the provider's canonical host.
   * Populated from environment variables (e.g., ANTHROPIC_BASE_URL).
   */
  readonly upstreamTarget?: UpstreamTarget;

  /**
   * Largest request body the proxy buffers on this provider's sanitized,
   * rewritten or 401-retry routes, checked on the raw bytes and again once a
   * compressed body is decoded; a larger body gets a 413. The same ceiling
   * bounds the trajectory-capture tee of a streamed request. Set it to the
   * provider's documented request limit; it defaults to
   * `DEFAULT_MAX_REQUEST_BODY_BYTES` (32 MiB, Anthropic's limit; see
   * `mitm-resource-limits.ts`). Agents resend the whole conversation every
   * turn, so a session with inline images or PDFs grows toward this limit.
   * Streamed routes are not buffered and are not limited by it.
   */
  readonly maxRequestBodyBytes?: number;
}

/**
 * OpenAI's documented ceiling on one request's payload (50 MB, the image-input
 * limit of the Responses and Chat Completions APIs). The Codex backend on
 * chatgpt.com takes the same Responses wire format and is given the same
 * ceiling.
 */
const OPENAI_MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;

export interface EndpointPattern {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /**
   * Path pattern. Supports two forms:
   * - Exact match: '/v1/messages' (compared after stripping query string)
   * - Glob within a segment: '/v1beta/models/STAR:generateContent'
   *   (each '*' matches one or more RFC 3986 unreserved characters
   *   `[A-Za-z0-9._~-]`, never only dots, so it cannot match a dot segment,
   *   a percent-encoded separator, a backslash or a path parameter)
   *
   * Non-glob characters are regex-escaped before matching to prevent
   * metacharacters in paths (e.g., '.') from being interpreted as regex.
   */
  readonly path: string;
}

/**
 * How the API key is transmitted in requests. A header provider's key header
 * is one of the credential carriers (`credential-carriers.ts`), so the proxy
 * strips it from agent requests and the trajectory capture redacts it.
 */
export type KeyInjection =
  { readonly type: 'header'; readonly headerName: ProviderKeyHeaderName } | { readonly type: 'bearer' };

/**
 * Returns true if `method`+`path` matches any pattern in `patterns`.
 * Path is normalized by stripping the query string; glob patterns ('*')
 * match exactly one path segment. Shared by `isEndpointAllowed` (forwarding
 * allowlist) and `isCapturableEndpoint` (capture allowlist).
 */
function matchesEndpoint(
  patterns: readonly EndpointPattern[],
  method: string | undefined,
  path: string | undefined,
): boolean {
  return patterns.some((endpoint) => matchesEndpointPattern(endpoint, method, path));
}

/**
 * Checks whether a request method+path is in the provider's forwarding
 * allowlist. Requests not matching any pattern get a 403.
 */
export function isEndpointAllowed(
  config: ProviderConfig,
  method: string | undefined,
  path: string | undefined,
): boolean {
  return matchesEndpoint(config.allowedEndpoints, method, path);
}

/**
 * Checks whether a request that presents no credential may be forwarded
 * without one (see `ProviderConfig.unauthenticatedEndpoints`).
 */
export function isUnauthenticatedEndpoint(
  config: Pick<ProviderConfig, 'unauthenticatedEndpoints'>,
  method: string | undefined,
  path: string | undefined,
): boolean {
  return matchesEndpoint(config.unauthenticatedEndpoints ?? [], method, path);
}

/**
 * Startup check: every unauthenticated endpoint must be one of the provider's
 * allowed endpoints, so the list can never widen what is forwarded.
 *
 * @throws {Error} naming the first endpoint that is not allowed.
 */
export function validateUnauthenticatedEndpoints(config: ProviderConfig): void {
  for (const endpoint of config.unauthenticatedEndpoints ?? []) {
    const allowed = config.allowedEndpoints.some(
      (candidate) => candidate.method === endpoint.method && candidate.path === endpoint.path,
    );
    if (!allowed) {
      throw new Error(
        `${config.displayName}: unauthenticated endpoint ${endpoint.method} ${endpoint.path} is not an allowed endpoint`,
      );
    }
  }
}

/**
 * Checks whether a request method+path is training-relevant and therefore
 * eligible for trajectory capture. Gated on the provider's `captureEndpoints`
 * allowlist (completion paths only). Returns false when `captureEndpoints` is
 * absent or empty, so capture is opt-in per provider and unlisted/custom
 * providers never record. Strictly subtractive — a false result skips the
 * capture branch and leaves the forwarding path untouched. See §3 integration
 * point 4 of docs/designs/mitm-token-trajectory-capture.md.
 */
export function isCapturableEndpoint(
  config: ProviderConfig,
  method: string | undefined,
  path: string | undefined,
): boolean {
  if (!config.captureEndpoints || config.captureEndpoints.length === 0) return false;
  return matchesEndpoint(config.captureEndpoints, method, path);
}

/** Resolve the explicit completion descriptor for an already-authorized request. */
export function resolveProviderCompletionEndpoint(
  config: ProviderConfig,
  method: string | undefined,
  path: string | undefined,
): import('./llm-observation/completion-endpoint.js').CompletionEndpoint | undefined {
  if (!config.completionEndpoints) return undefined;
  return resolveCompletionEndpoint(config.completionEndpoints, method, path);
}

// --- Request body rewriters ---

/**
 * Walks the Anthropic Messages API `tools` array, asking `classify` to
 * label each entry. Entries with a non-null label are removed and their
 * labels collected into `stripped`; entries returning `null` are kept.
 * Returns `null` when nothing matched, so the caller can skip serialization.
 */
function stripToolsBy(body: Record<string, unknown>, classify: (tool: unknown) => string | null): RewriteResult | null {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const stripped: string[] = [];
  const kept: unknown[] = [];

  for (const tool of tools) {
    const label = classify(tool);
    if (label !== null) {
      stripped.push(label);
    } else {
      kept.push(tool);
    }
  }

  if (stripped.length === 0) return null;
  return { modified: { ...body, tools: kept }, stripped };
}

/**
 * Claude Code's built-in `schedule` skill exposes `ScheduleWakeup`,
 * `CronCreate`, `CronList`, and `CronDelete`. These tools end the current
 * assistant turn expecting an external Claude Code runtime to re-fire the
 * session at the scheduled time. IronCurtain invokes `claude` as a one-shot
 * subprocess and does NOT honor those wakeups: a workflow agent that calls
 * `ScheduleWakeup` will silently end its turn (often with an empty thinking
 * block and no text), which produces no parseable `agent_status` block and
 * trips the workflow harness's missing-status guard.
 *
 * Upstream tracking: https://github.com/anthropics/claude-code/issues/53746
 * (open enhancement, no committed fix).
 */
const SCHEDULE_SKILL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ScheduleWakeup',
  'CronCreate',
  'CronList',
  'CronDelete',
]);

/**
 * Strips the schedule built-in skill's tools from the Anthropic Messages API
 * `tools` array. Filters by tool `name` (these tools arrive as custom-shaped
 * entries declared by the Claude Code CLI client, not as server-side tools).
 */
export function stripScheduleSkillTools(body: Record<string, unknown>): RewriteResult | null {
  return stripToolsBy(body, (tool) => {
    if (typeof tool !== 'object' || tool === null || !('name' in tool)) return null;
    const { name } = tool as Record<string, unknown>;
    return typeof name === 'string' && SCHEDULE_SKILL_TOOL_NAMES.has(name) ? name : null;
  });
}

const FUNCTION_BLOCK_PATTERN = /<function>([\s\S]*?)<\/function>\s*/g;
const FUNCTION_BLOCK_NAME_PATTERN = /"name"\s*:\s*"([^"]+)"/;

/**
 * Walks `body.messages[].content[].tool_result.content[]` and removes
 * references to schedule-skill tools that `stripScheduleSkillTools` strips
 * from the outgoing `tools` array. Two leakage paths are scrubbed:
 * `{type:"tool_reference", tool_name:"<stripped>"}` entries from ToolSearch
 * keyword/`select:` results, and `<function>{"name":"<stripped>",...}</function>`
 * schema blocks from `select:` results that load a full tool schema.
 *
 * Necessary because removing a tool from `tools` does NOT remove dangling
 * references already recorded in conversation history. Anthropic 400s the
 * next request with "Tool reference 'X' not found in available tools" if
 * any such reference survives, and Claude Code records that 400 as a
 * synthetic assistant turn it cannot recover from — wedging the session.
 */
export function stripScheduleSkillToolReferences(body: Record<string, unknown>): RewriteResult | null {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const stripped: string[] = [];
  const newMessages: unknown[] = [];

  for (const rawMsg of messages as unknown[]) {
    const result = rewriteMessageContent(rawMsg);
    if (result === null) {
      newMessages.push(rawMsg);
      continue;
    }
    newMessages.push(result.value);
    stripped.push(...result.labels);
  }

  if (stripped.length === 0) return null;
  return { modified: { ...body, messages: newMessages }, stripped };
}

interface Rewrite {
  readonly value: Record<string, unknown>;
  readonly labels: readonly string[];
}

function rewriteMessageContent(rawMsg: unknown): Rewrite | null {
  if (!isPlainObject(rawMsg)) return null;
  const content = rawMsg.content;
  if (!Array.isArray(content)) return null;

  const labels: string[] = [];
  const newContent: unknown[] = [];
  let changed = false;

  for (const rawBlock of content as unknown[]) {
    const result = rewriteToolResultBlock(rawBlock);
    if (result === null) {
      newContent.push(rawBlock);
      continue;
    }
    newContent.push(result.value);
    labels.push(...result.labels);
    changed = true;
  }

  if (!changed) return null;
  return { value: { ...rawMsg, content: newContent }, labels };
}

function rewriteToolResultBlock(rawBlock: unknown): Rewrite | null {
  if (!isPlainObject(rawBlock)) return null;
  if (rawBlock.type !== 'tool_result') return null;
  const innerContent = rawBlock.content;
  if (!Array.isArray(innerContent)) return null;

  const labels: string[] = [];
  const keptInner: unknown[] = [];
  let changed = false;

  for (const rawEntry of innerContent as unknown[]) {
    const result = scrubToolResultEntry(rawEntry);
    if (result === null) {
      keptInner.push(rawEntry);
      continue;
    }
    if (result.kind !== 'drop') {
      keptInner.push(result.value);
    }
    labels.push(...result.labels);
    changed = true;
  }

  if (!changed) return null;
  // Empty tool_result.content arrays are accepted by the Anthropic API,
  // but a deterministic placeholder makes the scrub visible to the agent
  // and avoids depending on that acceptance.
  const finalInner = keptInner.length > 0 ? keptInner : [{ type: 'text', text: '(filtered)' }];
  return { value: { ...rawBlock, content: finalInner }, labels };
}

type EntryResult =
  | { readonly kind: 'drop'; readonly labels: readonly string[] }
  | { readonly kind: 'replace'; readonly value: Record<string, unknown>; readonly labels: readonly string[] };

function scrubToolResultEntry(rawEntry: unknown): EntryResult | null {
  if (!isPlainObject(rawEntry)) return null;

  if (rawEntry.type === 'tool_reference' && typeof rawEntry.tool_name === 'string') {
    if (!SCHEDULE_SKILL_TOOL_NAMES.has(rawEntry.tool_name)) return null;
    return { kind: 'drop', labels: [`tool_reference:${rawEntry.tool_name}`] };
  }

  if (rawEntry.type === 'text' && typeof rawEntry.text === 'string') {
    // Fast-path: most tool_result text is tool output, not ToolSearch results.
    if (!rawEntry.text.includes('<function>')) return null;
    const labels: string[] = [];
    const scrubbed = rawEntry.text.replace(FUNCTION_BLOCK_PATTERN, (match, blockBody: string) => {
      const nameMatch = FUNCTION_BLOCK_NAME_PATTERN.exec(blockBody);
      if (nameMatch && SCHEDULE_SKILL_TOOL_NAMES.has(nameMatch[1])) {
        labels.push(`function_block:${nameMatch[1]}`);
        return '';
      }
      return match;
    });
    if (labels.length === 0) return null;
    return { kind: 'replace', value: { ...rawEntry, text: scrubbed }, labels };
  }

  return null;
}

/**
 * Claude Code compatibility rewriter for Anthropic /v1/messages requests.
 * Strips the schedule built-in skill's tools and any dangling history
 * references to them for one-shot batch and workflow agents. PTY agents
 * retain those tools because their interactive Claude Code runtime can
 * dispatch scheduled work. Unknown callers also retain them as a
 * conservative fallback.
 *
 * Provider-hosted tools are not this rewriter's concern: the
 * `anthropic-messages` request sanitizer removes them (and `mcp_servers`,
 * `container`, URL-sourced content and egress betas) on every Anthropic-shaped
 * route, after this rewriter runs.
 */
export function anthropicRequestRewriter(
  body: Record<string, unknown>,
  context: { method: string; path: string; agentKind?: AgentKind },
): RewriteResult | null {
  if (context.agentKind !== 'batch' && context.agentKind !== 'workflow') return null;

  let current = body;
  const stripped: string[] = [];
  const toolsStrip = stripScheduleSkillTools(current);
  if (toolsStrip) {
    current = toolsStrip.modified;
    stripped.push(...toolsStrip.stripped);
  }
  const historyStrip = stripScheduleSkillToolReferences(current);
  if (historyStrip) {
    current = historyStrip.modified;
    stripped.push(...historyStrip.stripped);
  }

  if (stripped.length === 0) return null;
  return { modified: current, stripped };
}

/**
 * Returns true if this request should have its body buffered and rewritten.
 * Only matches POST requests to paths listed in the provider's rewriteEndpoints.
 */
export function shouldRewriteBody(
  config: ProviderConfig,
  method: string | undefined,
  path: string | undefined,
): boolean {
  if (!config.requestRewriter || !config.rewriteEndpoints) return false;
  if (!method || method.toUpperCase() !== 'POST') return false;
  if (!path) return false;
  const cleanPath = path.split('?')[0];
  return config.rewriteEndpoints.includes(cleanPath);
}

/**
 * The request sanitizer bound to this method+path, if any (first match).
 * Paths are matched like `allowedEndpoints` (query string stripped, `*`
 * matches one segment).
 */
export function resolveRequestSanitizer(
  config: ProviderConfig,
  method: string | undefined,
  path: string | undefined,
): RequestSanitizer | undefined {
  return config.sanitizedEndpoints?.find((endpoint) => matchesEndpointPattern(endpoint, method, path))?.sanitizer;
}

/** Anthropic Messages paths on api.anthropic.com; both carry the same request body. */
const ANTHROPIC_MESSAGES_PATHS: readonly string[] = ['/v1/messages', '/v1/messages/count_tokens'];

// --- Built-in providers ---

export const anthropicProvider: ProviderConfig = {
  id: 'anthropic',
  host: 'api.anthropic.com',
  displayName: 'Anthropic',
  allowedEndpoints: [
    // Core API
    { method: 'POST', path: '/v1/messages' },
    { method: 'POST', path: '/v1/messages/count_tokens' },
    // Claude Code internal endpoints
    { method: 'GET', path: '/api/hello' },
    { method: 'GET', path: '/api/claude_code/settings' },
    { method: 'GET', path: '/api/claude_code/policy_limits' },
    { method: 'GET', path: '/api/claude_code/organizations/metrics_enabled' },
    { method: 'GET', path: '/api/claude_code_penguin_mode' },
    // Telemetry
    { method: 'POST', path: '/api/event_logging/batch' },
    { method: 'POST', path: '/api/event_logging/v2/batch' },
    { method: 'POST', path: '/api/eval/*' },
    // MCP marketplace
    { method: 'GET', path: '/mcp-registry/v0/servers' },
  ],
  // Calls Claude Code makes without a credential: the connectivity preflight
  // (only a User-Agent), the MCP registry catalog (fetched with auth "none"),
  // telemetry batches (its exporters can skip auth) and GrowthBook remote
  // evaluation (keyless until workspace trust). Every other route needs the
  // session credential; the completion and account routes never run keyless.
  unauthenticatedEndpoints: [
    { method: 'GET', path: '/api/hello' },
    { method: 'GET', path: '/mcp-registry/v0/servers' },
    { method: 'POST', path: '/api/event_logging/batch' },
    { method: 'POST', path: '/api/event_logging/v2/batch' },
    { method: 'POST', path: '/api/eval/*' },
  ],
  // Capture only the completion endpoint; the housekeeping paths above
  // (settings, telemetry, eval, registry) carry no model-emitted content.
  captureEndpoints: [{ method: 'POST', path: '/v1/messages' }],
  completionEndpoints: [
    {
      method: 'POST',
      path: '/v1/messages',
      protocol: 'anthropic-messages',
      capabilities: { metricsSupport: 'full', trajectoryCapture: true },
    },
  ],
  gatewayAdapterId: 'direct',
  keyInjection: { type: 'header', headerName: 'x-api-key' },
  fakeKeyPrefix: 'sk-ant-api03-ironcurtain-',
  requestRewriter: anthropicRequestRewriter,
  rewriteEndpoints: ['/v1/messages'],
  sanitizedEndpoints: sanitizedEndpointsFor('anthropic-messages', ANTHROPIC_MESSAGES_PATHS),
};

export const claudePlatformProvider: ProviderConfig = {
  id: 'claude-platform',
  host: 'platform.claude.com',
  displayName: 'Claude Platform',
  allowedEndpoints: [{ method: 'GET', path: '/v1/oauth/hello' }],
  // Claude Code's connectivity preflight sends no credential.
  unauthenticatedEndpoints: [{ method: 'GET', path: '/v1/oauth/hello' }],
  keyInjection: { type: 'header', headerName: 'x-api-key' },
  fakeKeyPrefix: 'sk-ant-api03-ironcurtain-',
};

export const openaiProvider: ProviderConfig = {
  id: 'openai',
  host: 'api.openai.com',
  displayName: 'OpenAI',
  allowedEndpoints: [
    // The Responses API is the path modern OpenAI agents (incl. Codex with an
    // API key) use; /v1/chat/completions is kept for goose's OpenAI provider.
    { method: 'POST', path: '/v1/responses' },
    { method: 'POST', path: '/v1/chat/completions' },
    { method: 'GET', path: '/v1/models' },
  ],
  // Capture only the Responses API: it shares the chatgpt.com wire format and
  // is reassembled by ResponsesReassembler (createReassembler routes
  // api.openai.com → ResponsesReassembler). /v1/chat/completions is NOT
  // captured — no harness uses it and there is no chat-completions reassembler.
  captureEndpoints: [{ method: 'POST', path: '/v1/responses' }],
  completionEndpoints: [
    {
      method: 'POST',
      path: '/v1/responses',
      protocol: 'openai-responses',
      capabilities: { metricsSupport: 'full', trajectoryCapture: true },
    },
    {
      method: 'POST',
      path: '/v1/chat/completions',
      protocol: 'openai-chat-completions',
      capabilities: {
        metricsSupport: 'partial',
        streamingUsageNegotiation: 'client_or_agent_adapter',
        trajectoryCapture: false,
      },
    },
  ],
  gatewayAdapterId: 'direct',
  keyInjection: { type: 'bearer' },
  fakeKeyPrefix: 'sk-ironcurtain-',
  // Hosted tools, replayed hosted items and URL-sourced content are removed
  // by the OpenAI sanitizers (./request-sanitizers/openai.ts). The
  // openai-platform layer in front of them refuses OpenAI's web-search and
  // deep-research models, which search the web just by being named.
  sanitizedEndpoints: [
    ...sanitizedEndpointsFor('openai-responses', ['/v1/responses'], openaiPlatformSanitizer),
    ...sanitizedEndpointsFor('openai-chat-completions', ['/v1/chat/completions'], openaiPlatformSanitizer),
  ],
  maxRequestBodyBytes: OPENAI_MAX_REQUEST_BODY_BYTES,
};

export const codexChatGptProvider: ProviderConfig = {
  id: 'chatgpt-codex',
  host: 'chatgpt.com',
  displayName: 'ChatGPT Codex',
  allowedEndpoints: [
    { method: 'GET', path: '/agent-identities/jwks' },
    { method: 'GET', path: '/wham/agent-identities/jwks' },
    { method: 'GET', path: '/codex-backend/agent-identity' },
    { method: 'POST', path: '/codex-backend/agent-identity' },
    // backend-api allowlist — least-privilege, enumerated from live Codex CLI
    // 0.139.0 runs (a simple completion and a file-edit-plus-shell task) through
    // this proxy. Exact paths only (no wildcard) so the real ChatGPT OAuth token
    // is forwarded to exactly the endpoints Codex needs and nothing else.
    //
    // (a) The only functionally required backend-api calls observed are
    //     GET /backend-api/codex/models and POST /backend-api/codex/responses
    //     (the completion stream); sessions complete with these alone. The GETs
    //     those runs also showed on /backend-api/codex/responses are Codex's
    //     WebSocket handshake (about seven per turn: its connect retries). The
    //     proxy refuses every upgrade before this allowlist is consulted (inner
    //     `upgrade` listener in mitm-proxy.ts) and the Codex adapter turns
    //     WebSockets off, so no GET is allowed on that path.
    // (b) REPLACES a prior `/backend-api/codex/*` single-segment wildcard, which
    //     would also have forwarded the token to unrelated future sub-surfaces.
    // (c) Intentionally still blocked (Codex attempts them; runs are unaffected):
    //     POST /backend-api/codex/analytics-events/events (telemetry),
    //     GET /backend-api/plugins/*, GET /backend-api/ps/plugins/installed,
    //     POST /backend-api/wham/apps (plugin/app marketplace). None are needed
    //     for headless exec; blocking them keeps egress minimal.
    // (d) If a future Codex version 403s on a path it genuinely needs, add that
    //     specific exact path here — do NOT re-introduce a wildcard.
    { method: 'GET', path: '/backend-api/codex/models' },
    { method: 'POST', path: '/backend-api/codex/responses' },
    // (e) Workspace routing discovery: Codex 0.157.1 (the pinned
    //     docker/Dockerfile.codex version) reads its account list here before
    //     the first turn in ChatGPT mode and fails the turn ("workspace routing
    //     discovery failed") when the call does not succeed. Read-only GET.
    { method: 'GET', path: '/backend-api/wham/accounts/check' },
  ],
  // The agent-identity key sets are public; Codex may fetch them without a
  // credential. Every backend-api route needs the session credential.
  unauthenticatedEndpoints: [
    { method: 'GET', path: '/agent-identities/jwks' },
    { method: 'GET', path: '/wham/agent-identities/jwks' },
  ],
  // The completion call Codex streams is POST /backend-api/codex/responses
  // (verified against a live codex exec run). chatgpt.com classifies as the
  // 'openai' capture provider and is reassembled by ResponsesReassembler
  // against the named-event Responses stream (response.* events; terminal
  // response.completed). It is the only completion transport: the ~7 GETs on
  // the same path that older captures showed were WebSocket handshakes, which
  // the proxy refuses and the generated Codex config no longer attempts.
  captureEndpoints: [{ method: 'POST', path: '/backend-api/codex/responses' }],
  completionEndpoints: [
    {
      method: 'POST',
      path: '/backend-api/codex/responses',
      protocol: 'openai-responses',
      capabilities: { metricsSupport: 'full', trajectoryCapture: true },
    },
  ],
  gatewayAdapterId: 'direct',
  keyInjection: { type: 'bearer' },
  // Codex expects ChatGPT access tokens to be JWT-shaped in auth.json.
  // Keep the fake credential structurally valid so local parsing passes,
  // then swap it host-side before forwarding upstream.
  fakeKeyPrefix:
    'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjQxMDI0NDQ4MDAsImlzcyI6Imlyb25jdXJ0YWluIiwic3ViIjoiY29kZXgtZmFrZSJ9.',
  // Codex's completion POST goes through the openai-responses sanitizer,
  // behind the same openai-platform layer as api.openai.com: this is the
  // route every Codex session reaches OpenAI by, and a process in the
  // container can name any model on it, so OpenAI's web-search and
  // deep-research models are refused here too, whether or not this backend
  // would serve one.
  // Codex enables zstd request compression by default; the proxy decodes a
  // compressed body before sanitizing and forwards the decoded JSON.
  sanitizedEndpoints: sanitizedEndpointsFor(
    'openai-responses',
    ['/backend-api/codex/responses'],
    openaiPlatformSanitizer,
  ),
  // Codex resends the whole conversation, inline images included, every turn;
  // the ceiling applies to the zstd body and again to the decoded JSON.
  maxRequestBodyBytes: OPENAI_MAX_REQUEST_BODY_BYTES,
};

export const codexAuthProvider: ProviderConfig = {
  id: 'openai-auth',
  host: 'auth.openai.com',
  displayName: 'OpenAI Auth',
  allowedEndpoints: [{ method: 'GET', path: '/api/accounts/v1/user-auth-credential/whoami' }],
  keyInjection: { type: 'bearer' },
  fakeKeyPrefix: codexChatGptProvider.fakeKeyPrefix,
};

export const anthropicOAuthProvider: ProviderConfig = {
  id: 'anthropic',
  host: 'api.anthropic.com',
  displayName: 'Anthropic (OAuth)',
  allowedEndpoints: [
    ...anthropicProvider.allowedEndpoints,
    // OAuth-only: usage data requires an OAuth session
    { method: 'GET' as const, path: '/api/oauth/usage' },
  ],
  unauthenticatedEndpoints: anthropicProvider.unauthenticatedEndpoints,
  captureEndpoints: anthropicProvider.captureEndpoints,
  completionEndpoints: anthropicProvider.completionEndpoints,
  gatewayAdapterId: 'direct',
  keyInjection: { type: 'bearer' },
  fakeKeyPrefix: 'sk-ant-oat01-ironcurtain-',
  requestRewriter: anthropicRequestRewriter,
  rewriteEndpoints: ['/v1/messages'],
  sanitizedEndpoints: anthropicProvider.sanitizedEndpoints,
};

export const claudePlatformOAuthProvider: ProviderConfig = {
  id: 'claude-platform',
  host: 'platform.claude.com',
  displayName: 'Claude Platform (OAuth)',
  allowedEndpoints: claudePlatformProvider.allowedEndpoints,
  unauthenticatedEndpoints: claudePlatformProvider.unauthenticatedEndpoints,
  keyInjection: { type: 'bearer' },
  fakeKeyPrefix: 'sk-ant-oat01-ironcurtain-',
};

export const googleProvider: ProviderConfig = {
  id: 'google',
  host: 'generativelanguage.googleapis.com',
  displayName: 'Google',
  allowedEndpoints: [
    { method: 'POST', path: '/v1beta/models/*:generateContent' },
    { method: 'POST', path: '/v1beta/models/*:streamGenerateContent' },
  ],
  captureEndpoints: [
    { method: 'POST', path: '/v1beta/models/*:generateContent' },
    { method: 'POST', path: '/v1beta/models/*:streamGenerateContent' },
  ],
  completionEndpoints: [
    {
      method: 'POST',
      path: '/v1beta/models/*:generateContent',
      protocol: 'google-generate-content',
      capabilities: { metricsSupport: 'full', trajectoryCapture: true },
    },
    {
      method: 'POST',
      path: '/v1beta/models/*:streamGenerateContent',
      protocol: 'google-generate-content',
      capabilities: { metricsSupport: 'full', trajectoryCapture: true },
    },
  ],
  gatewayAdapterId: 'direct',
  keyInjection: { type: 'header', headerName: 'x-goog-api-key' },
  fakeKeyPrefix: 'AIzaSy-ironcurtain-',
  // The google-generate-content sanitizer keeps only function declarations in
  // `tools` and neutralizes URI-referencing (`fileData`) parts.
  sanitizedEndpoints: sanitizedEndpointsFor('google-generate-content', [
    '/v1beta/models/*:generateContent',
    '/v1beta/models/*:streamGenerateContent',
  ]),
};
