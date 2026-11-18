/**
 * Anthropic Messages request sanitizer.
 *
 * Bound to every Anthropic-shaped route the MITM serves: api.anthropic.com
 * (API key and OAuth), the Z.AI Anthropic endpoint and OpenRouter's
 * `/api/v1/messages`, each with its `count_tokens` sibling. It removes every
 * way a request can make the provider reach the network or run code for the
 * agent, outside IronCurtain's policy engine:
 *
 * - `tools`: only client-executed tools survive, i.e. entries with no `type`
 *   or with `type: "custom"`. Every typed entry is a provider-defined tool
 *   (web_search_*, web_fetch_*, code_execution_*, mcp_toolset, computer_*,
 *   bash_*, text_editor_*, ...) and is dropped, including types that do not
 *   exist yet. Non-object entries are dropped too.
 * - `mcp_servers` (the MCP connector) and `container` (code-execution
 *   containers and Agent Skills) are dropped.
 * - Content blocks whose `source` is not inline data (an object whose
 *   `source.type` is base64/text/content) are replaced by a text placeholder,
 *   in messages, nested `tool_result` content, document content sources and
 *   `system`: a `url` or `file` source, a missing or unknown type, or a bare
 *   string or array. The provider would otherwise fetch the URL. The one
 *   exception is the string `source` of a `search_result` block, a citation
 *   label that is never fetched.
 * - Replayed provider-side tool activity (server_tool_use, mcp_tool_use,
 *   every `*_tool_result` other than the client `tool_result`, and
 *   container_upload) is dropped from history.
 * - `anthropic-beta` values that enable those features are removed by prefix.
 *   This is a denylist on purpose: Claude Code is pinned by default, but
 *   `agentCliVersions` can select another release or `latest`
 *   (`../agent-cli-version.ts`), and releases add betas often, so an allowlist
 *   would break sessions. The body rules above are the real control.
 *
 * `model` must be a string, `tools`/`messages` must be arrays when present,
 * and every message and every entry of a content block list must be an
 * object; anything else is rejected rather than forwarded. Every other field
 * passes through untouched, so Claude Code's ordinary requests (custom tools,
 * base64 images and PDFs, thinking, tool_reference results, context
 * management, cache control) are forwarded unchanged.
 */

import type { OutgoingHttpHeaders } from 'node:http';
import { isPlainObject } from '../../utils/is-plain-object.js';
import {
  NEUTRALIZED_CONTENT_TEXT,
  labelValue,
  rejectRequest,
  type RequestSanitizer,
  type SanitizeResult,
} from './core.js';

/**
 * `anthropic-beta` prefixes of features that make the provider reach the
 * network or run code for the request: the MCP connector, web fetch and web
 * search, code execution (and the Files API and Agent Skills that feed it)
 * and computer use.
 */
export const ANTHROPIC_EGRESS_BETA_PREFIXES: readonly string[] = [
  'mcp-client-',
  'web-fetch-',
  'web-search-',
  'code-execution-',
  'computer-use-',
  'skills-',
  'files-api-',
];

/** Top-level fields that attach provider-side connectors or execution environments. */
const DROPPED_FIELDS: readonly string[] = ['mcp_servers', 'container'];

/** `source.type` values whose data travels inside the request; anything else is fetched by the provider. */
const INLINE_SOURCE_TYPES: ReadonlySet<string> = new Set(['base64', 'text', 'content']);

/** Content nested deeper than this is refused instead of walked. Real requests nest at most three levels. */
const MAX_BLOCK_DEPTH = 8;

const DROPPED = Symbol('dropped');

function placeholderBlock(cacheControl?: unknown): Record<string, unknown> {
  return cacheControl === undefined
    ? { type: 'text', text: NEUTRALIZED_CONTENT_TEXT }
    : { type: 'text', text: NEUTRALIZED_CONTENT_TEXT, cache_control: cacheControl };
}

function isEgressBeta(beta: string): boolean {
  const normalized = beta.toLowerCase();
  return ANTHROPIC_EGRESS_BETA_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function sanitizeHeaders(headers: OutgoingHttpHeaders): readonly string[] {
  const removed: string[] = [];
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== 'anthropic-beta') continue;
    const value = headers[name];
    if (value === undefined) continue;
    const betas = (Array.isArray(value) ? value : [String(value)])
      .flatMap((entry) => entry.split(','))
      .map((beta) => beta.trim())
      .filter((beta) => beta !== '');
    const kept = betas.filter((beta) => !isEgressBeta(beta));
    if (kept.length === betas.length) continue;
    for (const beta of betas) {
      if (isEgressBeta(beta)) removed.push(`anthropic-beta:${labelValue(beta)}`);
    }
    if (kept.length > 0) headers[name] = kept.join(',');
    else Reflect.deleteProperty(headers, name);
  }
  return removed;
}

/** Client-executed tools carry no `type`, or `type: "custom"`; every other entry is provider-defined. */
function isClientTool(tool: unknown): boolean {
  return isPlainObject(tool) && (!Object.hasOwn(tool, 'type') || tool.type === 'custom');
}

function sanitizeTools(tools: unknown, removed: string[]): unknown {
  if (tools === undefined) return tools;
  if (!Array.isArray(tools)) return rejectRequest('tools must be an array');
  const entries: readonly unknown[] = tools;
  if (entries.every(isClientTool)) return tools;
  for (const tool of entries) {
    if (!isClientTool(tool)) removed.push(`tool:${labelValue(isPlainObject(tool) ? tool.type : tool)}`);
  }
  return entries.filter(isClientTool);
}

/**
 * Provider-side tool activity replayed from history: server_tool_use,
 * mcp_tool_use, every `*_tool_result` except the client `tool_result`, and
 * container_upload (a file handed to a code-execution container).
 */
function isReplayedProviderToolBlock(type: string): boolean {
  return (
    type === 'server_tool_use' ||
    type === 'mcp_tool_use' ||
    type === 'container_upload' ||
    (type.endsWith('_tool_result') && type !== 'tool_result')
  );
}

/**
 * Sanitize a `content` value: a string, a block array, or a single block
 * object (accepted by lenient gateways). Returns the input itself when
 * nothing changed. A block list emptied by the sanitizer gets a placeholder
 * so the surrounding message or tool result stays valid.
 */
function sanitizeContent(content: unknown, removed: string[], depth: number): unknown {
  if (Array.isArray(content)) {
    const blocks: readonly unknown[] = content;
    const sanitized = sanitizeBlocks(blocks, removed, depth);
    if (sanitized === blocks) return content;
    return sanitized.length > 0 ? sanitized : [placeholderBlock()];
  }
  if (isPlainObject(content)) {
    const sanitized = sanitizeBlock(content, removed, depth);
    return sanitized === DROPPED ? placeholderBlock() : sanitized;
  }
  return content;
}

/**
 * Every entry of a block list must be an object: anything else (a nested
 * array, a string, null) is not a content block the sanitizer can inspect, so
 * a lenient upstream that flattened or coerced it could receive blocks that
 * were never checked. No Anthropic client sends one; the request is refused.
 */
function sanitizeBlocks(blocks: readonly unknown[], removed: string[], depth: number): readonly unknown[] {
  let changed = false;
  const kept: unknown[] = [];
  for (const block of blocks) {
    if (!isPlainObject(block)) return rejectRequest('each content block must be an object');
    const sanitized = sanitizeBlock(block, removed, depth);
    if (sanitized !== block) changed = true;
    if (sanitized !== DROPPED) kept.push(sanitized);
  }
  return changed ? kept : blocks;
}

/** `search_result` blocks carry a string `source`: a citation label the provider shows, never fetches. */
function isCitationLabel(type: unknown, source: unknown): boolean {
  return type === 'search_result' && typeof source === 'string';
}

/** Log label for a `source` value: its `type` for an object, else the JSON kind (never the value, e.g. a URL). */
function describeSource(source: unknown): string {
  if (isPlainObject(source)) return labelValue(source.type);
  if (Array.isArray(source)) return '<array>';
  return source === null ? '<null>' : `<${typeof source}>`;
}

function sanitizeBlock(
  block: Record<string, unknown>,
  removed: string[],
  depth: number,
): Record<string, unknown> | typeof DROPPED {
  if (depth > MAX_BLOCK_DEPTH) return rejectRequest('content blocks are nested too deeply');
  const type = block.type;
  if (typeof type === 'string' && isReplayedProviderToolBlock(type)) {
    removed.push(`block:${labelValue(type)}`);
    return DROPPED;
  }
  let current = block;
  const source = block.source;
  if (Object.hasOwn(block, 'source') && !isCitationLabel(type, source)) {
    // Only an object naming an inline source type is data that travels in the
    // request. A URL, file id, bare string or anything unrecognized would be
    // resolved by the provider (or a lenient gateway), so the block goes.
    if (!isPlainObject(source) || typeof source.type !== 'string' || !INLINE_SOURCE_TYPES.has(source.type)) {
      removed.push(`${labelValue(type)}:source:${describeSource(source)}`);
      return placeholderBlock(block.cache_control);
    }
    // A `content` document source carries nested blocks of its own.
    const inner = sanitizeContent(source.content, removed, depth + 1);
    if (inner !== source.content) current = { ...current, source: { ...source, content: inner } };
  }
  // tool_result, search_result and similar blocks nest a content list.
  const content = sanitizeContent(current.content, removed, depth + 1);
  if (content !== current.content) current = { ...current, content };
  return current;
}

function sanitizeMessages(messages: unknown, removed: string[]): unknown {
  if (messages === undefined) return messages;
  if (!Array.isArray(messages)) return rejectRequest('messages must be an array');
  const entries: readonly unknown[] = messages;
  const sanitized = entries.map((message) => {
    if (!isPlainObject(message)) return rejectRequest('each message must be an object');
    const content = sanitizeContent(message.content, removed, 0);
    return content === message.content ? message : { ...message, content };
  });
  return sanitized.some((message, index) => message !== entries[index]) ? sanitized : messages;
}

function sanitizeBody(body: Readonly<Record<string, unknown>>): SanitizeResult {
  if (typeof body.model !== 'string') return rejectRequest('the request must name its model as a string');
  const removed: string[] = [];
  const dropped = DROPPED_FIELDS.filter((field) => Object.hasOwn(body, field));
  removed.push(...dropped);
  const replacements = new Map<string, unknown>([
    ['tools', sanitizeTools(body.tools, removed)],
    ['messages', sanitizeMessages(body.messages, removed)],
    ['system', sanitizeContent(body.system, removed, 0)],
  ]);
  const changed = dropped.length > 0 || [...replacements].some(([field, value]) => value !== body[field]);
  if (!changed) return { body, removed };
  // Object.fromEntries defines own properties, so even a `__proto__` key in
  // the parsed body is carried over as data rather than invoking the setter.
  const sanitized = Object.fromEntries(
    Object.entries(body)
      .filter(([field]) => !dropped.includes(field))
      .map(([field, value]) => [field, replacements.has(field) ? replacements.get(field) : value]),
  );
  return { body: sanitized, removed };
}

export const anthropicMessagesSanitizer: RequestSanitizer = Object.freeze({
  protocol: 'anthropic-messages',
  sanitizeHeaders,
  sanitizeBody,
});
