/**
 * MITM request sanitizer framework.
 *
 * Provider-hosted tools and connectors (web search and fetch, remote MCP
 * servers, code execution, URL-sourced content) make the provider reach the
 * network for the agent, outside IronCurtain's network isolation and policy
 * engine, using the user's real credential. The MITM closes that channel at
 * the one place every completion request passes:
 *
 * - Each wire protocol has one allowlist sanitizer ({@link RequestSanitizer}),
 *   registered here under its completion protocol id: `anthropic-messages`
 *   (`./anthropic.ts`), `google-generate-content` (`./gemini.ts`), and
 *   `openai-responses` and `openai-chat-completions` (`./openai.ts`).
 * - A gateway or provider with egress features of its own adds a layer that
 *   runs in front of the protocol's ({@link chainSanitizers}): OpenRouter's
 *   web plugin, `:online` variants and search models (`./openrouter.ts`), and
 *   on OpenAI's own routes (api.openai.com, the ChatGPT Codex backend)
 *   OpenAI's web-search and deep-research models (`openaiPlatformSanitizer`
 *   in `./openai.ts`). Both judge the model with the shared list in
 *   `./web-search-models.ts`.
 * - Providers bind sanitizers to endpoints through
 *   `ProviderConfig.sanitizedEndpoints`, built with {@link sanitizedEndpointsFor}.
 *   Built-in providers and gateways bind every completion endpoint whose
 *   protocol has a sanitizer, plus same-format siblings such as count_tokens;
 *   a gateway sanitizer is bound on every POST route of its gateway.
 * - The proxy buffers and sanitizes every request on those endpoints that
 *   passes its credential gate; a request presenting any credential other
 *   than the session sentinel, or none, is refused before it is buffered
 *   (`../provider-credentials.ts`). {@link processRequestBody}
 *   parses strictly, runs the provider's compatibility rewriter, then the
 *   sanitizer on the rewriter's output, and returns the canonical
 *   serialization of the sanitized body. {@link sanitizeRequestHeaders}
 *   declares that body as plain `application/json` and applies the protocol's
 *   header rules. The upstream therefore parses exactly what was inspected:
 *   duplicate keys, encoding tricks or an agent-chosen media type or charset
 *   cannot hide content.
 * - A compressed body (gzip, deflate, br or zstd; Codex enables zstd request
 *   compression by default) is decoded first, bounded by the buffering limit
 *   (`./content-encoding.ts`), and the decoded canonical JSON is forwarded
 *   without a Content-Encoding.
 * - A request that cannot be sanitized is answered locally and never
 *   forwarded: invalid UTF-8 or JSON, a non-object body, a non-string model,
 *   a malformed core field or corrupt compressed data is a 400
 *   ({@link RequestRejectedError}); a body that exceeds the limit once
 *   decoded is a 413; an unknown or stacked Content-Encoding is a 415,
 *   checked by the proxy before it buffers the body.
 * - The proxy logs every removal and rejection to the session log.
 *
 * See docs/designs/mitm-request-filtering.md.
 */

import type { OutgoingHttpHeaders } from 'node:http';
import type { BuiltInLlmProtocol, LlmProtocolId } from '../llm-observation/completion-endpoint.js';
import type { AgentKind, RequestBodyRewriter } from '../provider-config.js';
import { isPlainObject } from '../../utils/is-plain-object.js';
import { anthropicMessagesSanitizer } from './anthropic.js';
import { geminiGenerateContentSanitizer } from './gemini.js';
import {
  labelValue,
  rejectRequest,
  type RequestRejectedError,
  type RequestSanitizer,
  type SanitizeContext,
  type SanitizeResult,
  type SanitizedEndpoint,
} from './core.js';
import { openaiChatCompletionsSanitizer, openaiResponsesSanitizer } from './openai.js';

export {
  NEUTRALIZED_CONTENT_TEXT,
  REQUEST_REJECTED,
  RequestRejectedError,
  isRequestRejectedError,
  labelValue,
  rejectRequest,
  type RequestRejectionStatus,
  type RequestSanitizer,
  type SanitizeContext,
  type SanitizeResult,
  type SanitizedEndpoint,
} from './core.js';
export { ANTHROPIC_EGRESS_BETA_PREFIXES, anthropicMessagesSanitizer } from './anthropic.js';
export { geminiGenerateContentSanitizer } from './gemini.js';
export {
  createOpenRouterRequestSanitizer,
  isOpenRouterSearchModel,
  namesOpenRouterPreset,
  openRouterModelBase,
  stripOnlineVariant,
  type OpenRouterSanitizerOptions,
} from './openrouter.js';
export { openaiChatCompletionsSanitizer, openaiPlatformSanitizer, openaiResponsesSanitizer } from './openai.js';
export {
  clearContentEncoding,
  decodeRequestBody,
  isDecodeBudgetExhaustedError,
  parseRequestContentCoding,
  type RequestContentCoding,
} from './content-encoding.js';

/**
 * The sanitizer of each built-in wire protocol. A protocol missing here has no
 * request sanitizer yet, and its endpoints are forwarded without one.
 */
const SANITIZERS: ReadonlyMap<LlmProtocolId, RequestSanitizer> = new Map<BuiltInLlmProtocol, RequestSanitizer>([
  ['anthropic-messages', anthropicMessagesSanitizer],
  ['google-generate-content', geminiGenerateContentSanitizer],
  ['openai-responses', openaiResponsesSanitizer],
  ['openai-chat-completions', openaiChatCompletionsSanitizer],
]);

export function requestSanitizerFor(protocol: LlmProtocolId): RequestSanitizer | undefined {
  return SANITIZERS.get(protocol);
}

/**
 * One sanitizer that runs `first`, then `second` on its output, and reports
 * both sets of removals (its `protocol` names both, e.g.
 * `openrouter+anthropic-messages`). It keeps the {@link RequestSanitizer}
 * contract: the input is never mutated and comes back as-is when neither
 * removed anything. Used to put a gateway's or provider's own rules in front
 * of the wire protocol's.
 */
export function chainSanitizers(first: RequestSanitizer, second: RequestSanitizer): RequestSanitizer {
  return Object.freeze({
    protocol: `${first.protocol}+${second.protocol}`,
    sanitizeHeaders(headers: OutgoingHttpHeaders): readonly string[] {
      return [...first.sanitizeHeaders(headers), ...second.sanitizeHeaders(headers)];
    },
    sanitizeBody(body: Readonly<Record<string, unknown>>, context: SanitizeContext): SanitizeResult {
      const head = first.sanitizeBody(body, context);
      const tail = second.sanitizeBody(head.body, context);
      return { body: tail.body, removed: [...head.removed, ...tail.removed] };
    },
  });
}

/**
 * Bind `protocol`'s sanitizer to each POST path, with `layerSanitizer`
 * chained in front of it when the route belongs to a gateway or provider that
 * adds egress features of its own (see {@link chainSanitizers}): a gateway's
 * `GatewayDefinition.gatewaySanitizer`, or the `openaiPlatformSanitizer` of
 * OpenAI's own routes.
 *
 * Without a layer this returns `[]` while the protocol has no sanitizer, so a
 * provider can declare its bindings now and picks the sanitizer up as soon as
 * one is registered. A layer is bound even then: its rules apply from the
 * start, and the protocol's join them on registration.
 */
export function sanitizedEndpointsFor(
  protocol: BuiltInLlmProtocol,
  paths: readonly string[],
  layerSanitizer?: RequestSanitizer,
): readonly SanitizedEndpoint[] {
  const protocolSanitizer = requestSanitizerFor(protocol);
  const sanitizer =
    layerSanitizer && protocolSanitizer
      ? chainSanitizers(layerSanitizer, protocolSanitizer)
      : (layerSanitizer ?? protocolSanitizer);
  if (!sanitizer) return [];
  return paths.map((path): SanitizedEndpoint => ({ method: 'POST', path, sanitizer }));
}

/** Request facts passed to the rewriter and the sanitizer (the rewriter context). */
export interface RequestBodyContext {
  readonly method: string;
  readonly path: string;
  readonly agentKind?: AgentKind;
  readonly cacheKey?: string;
}

export interface RequestBodyStages {
  /** Compatibility rewriter (model mapping, schedule-tool strips, ...). Runs first. */
  readonly rewriter?: RequestBodyRewriter;
  /** Protocol sanitizer. Runs last, on the rewriter's output, so it sees what leaves the proxy. */
  readonly sanitizer?: RequestSanitizer;
}

export interface ProcessedRequestBody {
  /** Bytes to forward: the raw body when it is already canonical and unchanged, else the re-serialized body. */
  readonly body: Buffer;
  /**
   * The object `body` serializes: the request as forwarded, after the
   * rewriter and the sanitizer. Read-only facts (the MITM budget gate's model
   * and output cap) come from here instead of a second parse of `body`.
   */
  readonly forwardedJson: Readonly<Record<string, unknown>>;
  /** Labels reported by the rewriter. */
  readonly rewritten: readonly string[];
  /** Labels for everything the pipeline or the sanitizer removed or neutralized. */
  readonly removed: readonly string[];
}

/**
 * Delete every own `__proto__` key from a freshly parsed body, in place, and
 * return how many were deleted. `JSON.parse` stores `"__proto__"` as an
 * ordinary own key, so a sanitizer never sees the fields nested under it, but
 * a JavaScript gateway that copies the body with assignment semantics
 * (`Object.assign`, schema passthrough) turns them into real fields:
 * `{"__proto__":{"tools":[...]}}` would smuggle a hosted tool past the
 * sanitizer. No legitimate request uses the key. Iterative, so nesting depth
 * cannot overflow the stack.
 */
function stripProtoKeys(root: Record<string, unknown>): number {
  let deleted = 0;
  const pending: object[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (!Array.isArray(node) && Object.hasOwn(node, '__proto__')) {
      Reflect.deleteProperty(node, '__proto__');
      deleted++;
    }
    const children: unknown[] = Object.values(node);
    for (const child of children) {
      if (typeof child === 'object' && child !== null) pending.push(child);
    }
  }
  return deleted;
}

/** Strict UTF-8: malformed bytes are rejected instead of silently replaced. A leading BOM is dropped. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(rawBody: Buffer): string {
  try {
    return STRICT_UTF8.decode(rawBody);
  } catch {
    return rejectRequest('request body is not valid UTF-8');
  }
}

/** Parse a body that must be one JSON object; throws {@link RequestRejectedError} otherwise. */
export function parseJsonObjectBody(rawBody: Buffer): Record<string, unknown> {
  const text = decodeUtf8(rawBody);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return rejectRequest('request body is not valid JSON');
  }
  if (!isPlainObject(value)) return rejectRequest('request body must be a JSON object');
  return value;
}

function serialize(body: Readonly<Record<string, unknown>>): Buffer {
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    // JSON.parse accepts nesting that JSON.stringify cannot walk.
    return rejectRequest('request body is nested too deeply to forward');
  }
  return Buffer.from(text, 'utf8');
}

/**
 * The buffered-body pipeline: strict parse (dropping `__proto__` keys), then
 * the rewriter, then the sanitizer, then serialization. Throws
 * {@link RequestRejectedError} for a body that must not be forwarded; the
 * caller answers it locally.
 *
 * With a sanitizer the result is always the canonical serialization of what
 * the sanitizer returned (the raw bytes are reused only when identical).
 * Without one, the raw bytes are kept unless the body changed.
 */
export function processRequestBody(
  rawBody: Buffer,
  stages: RequestBodyStages,
  context: RequestBodyContext,
): ProcessedRequestBody {
  return processParsedRequestBody(parseJsonObjectBody(rawBody), rawBody, stages, context);
}

/**
 * The buffered-body pipeline for a body that has already been parsed into one
 * JSON object (`parseJsonObjectBody`). Splitting the parse out lets a caller
 * that also needs the parsed object — the MITM proxy's token-stream
 * `extractToolResults` — share a single `JSON.parse` of a large request body
 * with the sanitizer rather than parsing it twice (MITM-10). `rawBody` is the
 * exact bytes `parsed` came from, reused unchanged when the canonical
 * serialization is byte-identical. Semantics are otherwise identical to
 * {@link processRequestBody}: `__proto__` keys are stripped, then the rewriter,
 * then the sanitizer, then serialization; it throws {@link RequestRejectedError}
 * for a body that must not be forwarded.
 */
export function processParsedRequestBody(
  parsed: Record<string, unknown>,
  rawBody: Buffer,
  stages: RequestBodyStages,
  context: RequestBodyContext,
): ProcessedRequestBody {
  const protoKeys = stripProtoKeys(parsed);
  const parseRemovals = Array.from({ length: protoKeys }, () => 'key:__proto__');
  const rewrite = stages.rewriter ? stages.rewriter(parsed, context) : null;
  const rewritten = rewrite?.stripped ?? [];
  const current = rewrite?.modified ?? parsed;
  if (!stages.sanitizer) {
    const changed = rewrite !== null || protoKeys > 0;
    return {
      body: changed ? serialize(current) : rawBody,
      forwardedJson: current,
      rewritten,
      removed: parseRemovals,
    };
  }
  const sanitized = stages.sanitizer.sanitizeBody(current, { method: context.method, path: context.path });
  const canonical = serialize(sanitized.body);
  return {
    body: canonical.equals(rawBody) ? rawBody : canonical,
    forwardedJson: sanitized.body,
    rewritten,
    removed: [...parseRemovals, ...sanitized.removed],
  };
}

/** Media type of the body a sanitized request forwards: canonical JSON, which is UTF-8 (RFC 8259 §8.1). */
export const SANITIZED_BODY_CONTENT_TYPE = 'application/json';

/** Declared media types that already mean exactly {@link SANITIZED_BODY_CONTENT_TYPE}; replacing them is not logged. */
const EQUIVALENT_CONTENT_TYPES: ReadonlySet<string> = new Set(['application/json', 'application/json;charset=utf-8']);

/**
 * Header half of the pipeline for a request whose body went through
 * {@link processRequestBody} with `sanitizer`. Edits the forwarded `headers`
 * in place (the proxy reuses them for the 401 retry) and returns one label
 * per removed or replaced value.
 *
 * First, the body is declared as plain `application/json`, whatever the agent
 * sent. The forwarded bytes are the canonical UTF-8 JSON the sanitizer
 * inspected, but an upstream that honors the declared media type would decode
 * them differently: `charset=utf-7` turns `+ACI-` into a quote that ends a
 * string early, and a form-encoded type turns `&mcp_servers[0][url]=...`
 * inside a string into a real field. Either way a hosted tool or connector
 * would reach the provider without being inspected. Then the protocol's own
 * header rules run.
 */
export function sanitizeRequestHeaders(sanitizer: RequestSanitizer, headers: OutgoingHttpHeaders): readonly string[] {
  const removed: string[] = [];
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== 'content-type') continue;
    const value = headers[name];
    Reflect.deleteProperty(headers, name);
    if (value === undefined) continue;
    const declared = (Array.isArray(value) ? value.join(',') : String(value)).trim();
    if (!EQUIVALENT_CONTENT_TYPES.has(declared.toLowerCase().replace(/\s+/g, ''))) {
      removed.push(`content-type:${labelValue(declared)}`);
    }
  }
  headers['content-type'] = SANITIZED_BODY_CONTENT_TYPE;
  return [...removed, ...sanitizer.sanitizeHeaders(headers)];
}

const MAX_LOGGED_LABELS = 24;

/** One log-line summary of rewrite or removal labels: escaped, duplicates counted, list capped. */
export function describeLabels(labels: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const label of labels) {
    const safe = labelValue(label);
    counts.set(safe, (counts.get(safe) ?? 0) + 1);
  }
  const parts = [...counts]
    .slice(0, MAX_LOGGED_LABELS)
    .map(([label, count]) => (count > 1 ? `${label} (x${count})` : label));
  const omitted = counts.size - parts.length;
  return omitted > 0 ? `${parts.join(', ')}, +${omitted} more` : parts.join(', ');
}

/**
 * JSON error body for a locally rejected request. The shape satisfies both the
 * Anthropic SDK (`type: "error"`, `error.type`, `error.message`) and the OpenAI
 * SDK (`error.message`, `error.type`), so agents surface the reason.
 */
export function rejectionResponseBody(error: RequestRejectedError): string {
  return JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: `IronCurtain proxy refused this request: ${error.message}` },
  });
}
