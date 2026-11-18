/**
 * OpenAI Responses and Chat Completions request sanitizers.
 *
 * `openai-responses` is bound to api.openai.com `/v1/responses`, the ChatGPT
 * Codex backend (`chatgpt.com/backend-api/codex/responses`) and the Z.AI and
 * OpenRouter `/responses` routes. `openai-chat-completions` is bound to
 * api.openai.com `/v1/chat/completions` and the Z.AI (both plans) and
 * OpenRouter chat routes. Both remove every way a request can make the
 * provider reach the network or run code for the agent, outside IronCurtain's
 * policy engine.
 *
 * Responses:
 * - `tools` is an allowlist of the tool types a client executes itself, taken
 *   from recorded Codex 0.157.1 requests (test/docker/fixtures/codex-*.json):
 *   `function`, `custom` (Codex's apply_patch), `local_shell`, `namespace`
 *   (Codex groups each MCP server's tools, and its multi-agent tools, in one;
 *   only function and custom members are kept) and `tool_search` with
 *   `execution: "client"` (Codex defers MCP tools behind it). Every other entry
 *   is a provider-hosted tool (web_search*, file_search, code_interpreter,
 *   image_generation, mcp, computer_use*, hosted shell, a server-side
 *   tool_search, ...) and is dropped, including types that do not exist yet.
 * - `input` keeps only the item types a client produces or replays from its
 *   own tools. Replayed provider-side items (web_search_call, mcp_call,
 *   mcp_list_tools, mcp_approval_request/response, code_interpreter_call,
 *   image_generation_call, computer_call*, item_reference, ...) are dropped.
 *   A `tool_search_output` carries tool definitions that become callable, so
 *   its `tools` go through the same allowlist as `tools`.
 * - `tool_choice` naming anything but a function or custom tool (or the
 *   modes none/auto/required) is dropped, so the default applies.
 * - `prompt` (a stored prompt, whose variables can carry URL-sourced images
 *   and files) and `web_search_options` are dropped.
 *
 * Chat Completions: `tools` keeps only `function` and `custom` entries (Z.AI's
 * GLM `web_search`, `retrieval` and `mcp` tools are dropped), `tool_choice`
 * follows the same rule, and `web_search_options` is dropped.
 *
 * Content parts (message content and tool outputs, including a part list in
 * `local_shell_call_output`): text parts pass; an image, file or audio part
 * is kept only when its data travels in the request (a `data:` URL or
 * base64). A part that names an http(s) URL (in any field) or a stored
 * reference such as a file id, and a part of an unknown type, is replaced by
 * a text placeholder: the provider would fetch or read it. A reasoning item's
 * `summary` and `content` lists may hold only their text part types.
 *
 * `model` must be a string, and `tools`, `input`/`messages`, message content
 * and tool outputs must have the JSON kind their API defines, with every
 * entry an object; anything else is rejected rather than forwarded. So is an
 * object that spells a field this sanitizer reads in another form (`Tools`,
 * `TYPE`, `toolChoice`, `toolſ`): the sanitizer reads only the exact name,
 * while an upstream whose JSON decoder matches names case-insensitively (Go's
 * encoding/json does, the last spelling winning) would act on the other one.
 * Every other field passes through untouched, so Codex's and Goose's ordinary
 * requests are forwarded unchanged.
 *
 * The protocol sanitizers do not judge the model, because Z.AI and OpenRouter
 * reuse them for model namespaces of their own. On OpenAI's own routes
 * (api.openai.com and the ChatGPT Codex backend) the `openai-platform` layer
 * ({@link openaiPlatformSanitizer}) runs in front of them and refuses OpenAI's
 * web-search and deep-research models, which search the web just by being
 * named.
 */

import { isPlainObject } from '../../utils/is-plain-object.js';
import {
  NEUTRALIZED_CONTENT_TEXT,
  labelValue,
  rejectRequest,
  type RequestSanitizer,
  type SanitizeResult,
} from './core.js';
import { isWebSearchModel } from './web-search-models.js';

/** Marks an array entry the sanitizer removes. */
const DROPPED = Symbol('dropped');
/** Marks a top-level field the sanitizer removes. */
const REMOVE_FIELD = Symbol('remove-field');

/** Responses tool types a client executes itself. `namespace` and `tool_search` have rules of their own. */
const RESPONSES_CLIENT_TOOL_TYPES: ReadonlySet<string> = new Set(['function', 'custom', 'local_shell']);

/** Tool types a Responses `namespace` may group. */
const NAMESPACE_MEMBER_TYPES: ReadonlySet<string> = new Set(['function', 'custom']);

/** Chat Completions tool types a client executes itself. */
const CHAT_CLIENT_TOOL_TYPES: ReadonlySet<string> = new Set(['function', 'custom']);

/** `tool_choice` modes; they name no tool. */
const TOOL_CHOICE_MODES: ReadonlySet<string> = new Set(['none', 'auto', 'required']);

/** Tool types a `tool_choice` (or an `allowed_tools` entry) may name. */
const TOOL_CHOICE_TYPES: ReadonlySet<string> = new Set(['function', 'custom']);

/**
 * Responses input items a client produces or replays from its own tools.
 * `tool_search_call`/`tool_search_output` additionally need `execution: "client"`.
 * `compaction` carries only an opaque `encrypted_content` the provider issued.
 */
const RESPONSES_CLIENT_ITEM_TYPES: ReadonlySet<string> = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'local_shell_call',
  'local_shell_call_output',
  'tool_search_call',
  'tool_search_output',
  'compaction',
]);

const RESPONSES_DROPPED_FIELDS: readonly string[] = ['prompt', 'web_search_options'];
const CHAT_DROPPED_FIELDS: readonly string[] = ['web_search_options'];

/**
 * A field name as a lenient JSON decoder may match it: letter case folded
 * (`toUpperCase` first, so `ſ` becomes `s` and the Kelvin sign `k`, as in
 * Go's case folding) and `_`/`-` ignored (decoders with naming strategies map
 * `toolChoice` to `tool_choice`).
 */
function foldFieldName(name: string): string {
  return name.toUpperCase().toLowerCase().replace(/[_-]/g, '');
}

/** The fields one kind of object has that this sanitizer reads or removes. */
interface InspectedFields {
  readonly exact: ReadonlySet<string>;
  readonly folded: ReadonlySet<string>;
}

function inspectedFields(...names: readonly string[]): InspectedFields {
  return { exact: new Set(names), folded: new Set(names.map(foldFieldName)) };
}

const RESPONSES_BODY_FIELDS = inspectedFields(
  'model',
  'instructions',
  'input',
  'tools',
  'tool_choice',
  ...RESPONSES_DROPPED_FIELDS,
);
const CHAT_BODY_FIELDS = inspectedFields('model', 'messages', 'tools', 'tool_choice', ...CHAT_DROPPED_FIELDS);
/** A tool entry (Responses or Chat), a namespace member or a tool_search_output tool. */
const TOOL_FIELDS = inspectedFields('type', 'tools', 'execution');
/** A Responses input item. */
const ITEM_FIELDS = inspectedFields('type', 'role', 'content', 'output', 'summary', 'tools', 'execution');
/** A Chat Completions message. */
const MESSAGE_FIELDS = inspectedFields('content');
/** A content part (message content, tool output, reasoning summary/content). */
const PART_FIELDS = inspectedFields('type');

/**
 * Refuse an object that spells one of `fields` in another form (`Tools`,
 * `TYPE`, `toolChoice`, `toolſ`). The sanitizer reads only the exact name,
 * while an upstream whose JSON decoder matches names case-insensitively (Go's
 * encoding/json does, the last spelling winning) would act on the other one,
 * which was never inspected: `{"type":"function","TYPE":"web_search"}` is a
 * web search tool to such a decoder. No client sends these spellings.
 */
function requireExactFieldNames(object: Readonly<Record<string, unknown>>, fields: InspectedFields, where: string) {
  for (const name of Object.keys(object)) {
    if (!fields.exact.has(name) && fields.folded.has(foldFieldName(name))) {
      rejectRequest(
        `${where} has a field "${labelValue(name)}" that differs only in spelling from one the proxy inspects`,
      );
    }
  }
}

interface ContentRules {
  /** Part types that carry only text. */
  readonly textTypes: ReadonlySet<string>;
  /** Part types that carry media, kept only when the media is inline. */
  readonly mediaTypes: ReadonlySet<string>;
  /** Replacement for a neutralized part in a message of `role`. */
  placeholder(role: unknown): Record<string, unknown>;
}

const RESPONSES_CONTENT: ContentRules = {
  textTypes: new Set(['input_text', 'output_text', 'refusal']),
  mediaTypes: new Set(['input_image', 'input_file', 'input_audio']),
  placeholder: (role) => ({
    type: role === 'assistant' ? 'output_text' : 'input_text',
    text: NEUTRALIZED_CONTENT_TEXT,
  }),
};

const CHAT_CONTENT: ContentRules = {
  textTypes: new Set(['text', 'refusal']),
  mediaTypes: new Set(['image_url', 'input_audio', 'file']),
  placeholder: () => ({ type: 'text', text: NEUTRALIZED_CONTENT_TEXT }),
};

/** A reasoning item's `summary` and `content` lists carry text only. */
const REASONING_SUMMARY: ContentRules = {
  textTypes: new Set(['summary_text']),
  mediaTypes: new Set(),
  placeholder: () => ({ type: 'summary_text', text: NEUTRALIZED_CONTENT_TEXT }),
};

const REASONING_TEXT: ContentRules = {
  textTypes: new Set(['reasoning_text']),
  mediaTypes: new Set(),
  placeholder: () => ({ type: 'reasoning_text', text: NEUTRALIZED_CONTENT_TEXT }),
};

function jsonKind(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  return value === null ? 'null' : typeof value;
}

/** Log label for an entry: its `type` for an object, else its JSON kind. */
function describeType(value: unknown): string {
  return isPlainObject(value) ? labelValue(value.type) : `<${jsonKind(value)}>`;
}

/** Map `items`, leaving out entries mapped to {@link DROPPED}. Returns `items` itself when nothing changed. */
function mapEntries(items: readonly unknown[], map: (item: unknown) => unknown): readonly unknown[] {
  let changed = false;
  const kept: unknown[] = [];
  for (const item of items) {
    const next = map(item);
    if (next !== item) changed = true;
    if (next !== DROPPED) kept.push(next);
  }
  return changed ? kept : items;
}

/** `object` with `field` set to `value`; `object` itself when the value is unchanged. */
function withField(object: Record<string, unknown>, field: string, value: unknown): Record<string, unknown> {
  return value === object[field] ? object : { ...object, [field]: value };
}

/**
 * Whether `value` is a `data:` URL, whose bytes travel in the request. Any
 * other URL is fetched by the provider. Leading C0 controls and spaces are
 * skipped, as URL parsers skip them before the scheme.
 */
function isDataUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let start = 0;
  while (start < value.length && value.charCodeAt(start) <= 0x20) start++;
  return value.slice(start, start + 5).toLowerCase() === 'data:';
}

/** Keys of inline payloads (folded, see {@link foldFieldName}): a data URL or base64, which never contains a colon. */
const INLINE_DATA_KEYS: ReadonlySet<string> = new Set(['data', 'filedata']);

/**
 * The first field of a media part (or of the object it nests, such as Chat's
 * `image_url: {url}` or `file: {file_id}`) that makes the provider fetch or
 * read content from outside the request, as a log label (never the value).
 * Field names are compared folded ({@link foldFieldName}), so `fileId` or
 * `Image-URL` count as well. Each of these counts: a stored reference (a
 * field ending in `id`, such as `file_id`), a URL or URI field that is not a
 * `data:` URL, a `data` value that is not inline, any other string naming a
 * URL (`src`, `href`, ...), and nesting deeper than real parts use.
 */
function findRemoteReference(part: Readonly<Record<string, unknown>>, depth = 0): string | undefined {
  for (const [key, value] of Object.entries(part)) {
    if (value === undefined || value === null) continue;
    const name = foldFieldName(key);
    let remote: string | undefined;
    if (name.endsWith('id')) remote = '';
    else if (isPlainObject(value)) remote = depth === 0 ? findRemoteReference(value, depth + 1) : '';
    else if (name.endsWith('url') || name.endsWith('uri')) remote = isDataUrl(value) ? undefined : '';
    else if (INLINE_DATA_KEYS.has(name)) {
      remote = typeof value === 'string' && (isDataUrl(value) || !value.includes(':')) ? undefined : '';
    } else if (Array.isArray(value)) remote = '';
    else if (typeof value === 'string' && value.includes('://') && !isDataUrl(value)) remote = '';
    if (remote !== undefined) return remote === '' ? labelValue(key) : `${labelValue(key)}.${remote}`;
  }
  return undefined;
}

/**
 * Sanitize a list of content parts. Every entry must be an object: anything
 * else is nothing the sanitizer can inspect, so the request is refused.
 */
function sanitizeParts(parts: readonly unknown[], rules: ContentRules, role: unknown, removed: string[]): unknown {
  return mapEntries(parts, (part) => {
    if (!isPlainObject(part)) return rejectRequest('each content part must be an object');
    requireExactFieldNames(part, PART_FIELDS, 'a content part');
    const type = part.type;
    if (typeof type === 'string' && rules.textTypes.has(type)) return part;
    if (typeof type === 'string' && rules.mediaTypes.has(type)) {
      const remote = findRemoteReference(part);
      if (remote === undefined) return part;
      removed.push(`${labelValue(type)}:${remote}`);
      return rules.placeholder(role);
    }
    removed.push(`content:${labelValue(type)}`);
    return rules.placeholder(role);
  });
}

/** A content value: a string (or absent) passes, a part list is sanitized, anything else is refused. */
function sanitizeContent(content: unknown, role: unknown, rules: ContentRules, removed: string[]): unknown {
  if (content === undefined || content === null || typeof content === 'string') return content;
  if (!Array.isArray(content)) return rejectRequest('content must be a string or an array of parts');
  return sanitizeParts(content, rules, role, removed);
}

/** A tools array (or `null`): each entry is kept, rewritten or {@link DROPPED} by `sanitizeTool`. */
function sanitizeToolList(
  tools: unknown,
  field: string,
  sanitizeTool: (tool: unknown, removed: string[]) => unknown,
  removed: string[],
): unknown {
  if (tools === undefined || tools === null) return tools;
  if (!Array.isArray(tools)) return rejectRequest(`${field} must be an array`);
  return mapEntries(tools, (tool) => sanitizeTool(tool, removed));
}

/** A namespace keeps its function and custom members; one left empty is dropped. */
function sanitizeNamespace(tool: Record<string, unknown>, removed: string[]): unknown {
  const members = tool.tools;
  if (!Array.isArray(members)) {
    removed.push(`tool:namespace:<${jsonKind(members)}>`);
    return DROPPED;
  }
  const kept = mapEntries(members, (member) => {
    if (isPlainObject(member)) requireExactFieldNames(member, TOOL_FIELDS, 'a namespace member');
    if (isPlainObject(member) && typeof member.type === 'string' && NAMESPACE_MEMBER_TYPES.has(member.type)) {
      return member;
    }
    removed.push(`tool:${describeType(member)}`);
    return DROPPED;
  });
  if (kept === members) return tool;
  return kept.length > 0 ? { ...tool, tools: kept } : DROPPED;
}

function sanitizeResponsesTool(tool: unknown, removed: string[]): unknown {
  if (!isPlainObject(tool)) {
    removed.push(`tool:${describeType(tool)}`);
    return DROPPED;
  }
  requireExactFieldNames(tool, TOOL_FIELDS, 'a tool');
  const type = tool.type;
  if (typeof type === 'string' && RESPONSES_CLIENT_TOOL_TYPES.has(type)) return tool;
  if (type === 'namespace') return sanitizeNamespace(tool, removed);
  if (type === 'tool_search') {
    if (tool.execution === 'client') return tool;
    removed.push(`tool:tool_search:${labelValue(tool.execution)}`);
    return DROPPED;
  }
  removed.push(`tool:${labelValue(type)}`);
  return DROPPED;
}

function sanitizeChatTool(tool: unknown, removed: string[]): unknown {
  if (isPlainObject(tool)) requireExactFieldNames(tool, TOOL_FIELDS, 'a tool');
  if (isPlainObject(tool) && typeof tool.type === 'string' && CHAT_CLIENT_TOOL_TYPES.has(tool.type)) return tool;
  removed.push(`tool:${describeType(tool)}`);
  return DROPPED;
}

/**
 * Keep a `tool_choice` that is a mode or names a function or custom tool. An
 * `allowed_tools` choice keeps only such entries (Responses lists them in
 * `tools`, Chat Completions in `allowed_tools.tools`). Anything else is
 * removed, so the provider applies its default.
 */
function sanitizeToolChoice(choice: unknown, protocol: 'responses' | 'chat', removed: string[]): unknown {
  if (choice === undefined || choice === null) return choice;
  if (typeof choice === 'string' && TOOL_CHOICE_MODES.has(choice)) return choice;
  if (!isPlainObject(choice)) {
    removed.push(`tool_choice:${typeof choice === 'string' ? labelValue(choice) : `<${jsonKind(choice)}>`}`);
    return REMOVE_FIELD;
  }
  const type = choice.type;
  if (typeof type === 'string' && TOOL_CHOICE_TYPES.has(type)) return choice;
  if (type === 'allowed_tools') {
    const holder = protocol === 'chat' ? choice.allowed_tools : choice;
    if (isPlainObject(holder) && Array.isArray(holder.tools)) {
      const entries: readonly unknown[] = holder.tools;
      const kept = mapEntries(entries, (entry) => {
        if (isPlainObject(entry) && typeof entry.type === 'string' && TOOL_CHOICE_TYPES.has(entry.type)) return entry;
        removed.push(`tool_choice:allowed_tools:${describeType(entry)}`);
        return DROPPED;
      });
      if (kept === entries) return choice;
      if (kept.length > 0) {
        const narrowed = { ...holder, tools: kept };
        return protocol === 'chat' ? { ...choice, allowed_tools: narrowed } : narrowed;
      }
    }
    removed.push('tool_choice:allowed_tools');
    return REMOVE_FIELD;
  }
  removed.push(`tool_choice:${labelValue(type)}`);
  return REMOVE_FIELD;
}

function sanitizeResponsesItem(item: unknown, removed: string[]): unknown {
  if (!isPlainObject(item)) return rejectRequest('each input item must be an object');
  requireExactFieldNames(item, ITEM_FIELDS, 'an input item');
  // An item without `type` but with `role` is the shorthand form of a message.
  const type = item.type === undefined && Object.hasOwn(item, 'role') ? 'message' : item.type;
  if (typeof type !== 'string' || !RESPONSES_CLIENT_ITEM_TYPES.has(type)) {
    removed.push(`input:${labelValue(type)}`);
    return DROPPED;
  }
  if ((type === 'tool_search_call' || type === 'tool_search_output') && item.execution !== 'client') {
    removed.push(`input:${type}:${labelValue(item.execution)}`);
    return DROPPED;
  }
  switch (type) {
    case 'message':
      return withField(item, 'content', sanitizeContent(item.content, item.role, RESPONSES_CONTENT, removed));
    case 'reasoning': {
      const summary = sanitizeContent(item.summary, undefined, REASONING_SUMMARY, removed);
      return withField(
        withField(item, 'summary', summary),
        'content',
        sanitizeContent(item.content, undefined, REASONING_TEXT, removed),
      );
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output':
      // Tool output is a string or a list of input parts (Codex's view_image returns an input_image).
      // The API types local_shell_call_output as a string; a part list gets the same checks.
      return withField(item, 'output', sanitizeContent(item.output, 'tool', RESPONSES_CONTENT, removed));
    case 'tool_search_output':
      return withField(
        item,
        'tools',
        sanitizeToolList(item.tools, 'tool_search_output tools', sanitizeResponsesTool, removed),
      );
    default:
      return item;
  }
}

function sanitizeResponsesInput(input: unknown, removed: string[]): unknown {
  if (input === undefined || input === null || typeof input === 'string') return input;
  if (!Array.isArray(input)) return rejectRequest('input must be a string or an array of items');
  return mapEntries(input, (item) => sanitizeResponsesItem(item, removed));
}

function sanitizeChatMessages(messages: unknown, removed: string[]): unknown {
  if (messages === undefined || messages === null) return messages;
  if (!Array.isArray(messages)) return rejectRequest('messages must be an array');
  return mapEntries(messages, (message) => {
    if (!isPlainObject(message)) return rejectRequest('each message must be an object');
    requireExactFieldNames(message, MESSAGE_FIELDS, 'a message');
    return withField(message, 'content', sanitizeContent(message.content, message.role, CHAT_CONTENT, removed));
  });
}

function requireModel(body: Readonly<Record<string, unknown>>): void {
  if (typeof body.model !== 'string') rejectRequest('the request must name its model as a string');
}

/** The listed top-level fields present in `body`, each logged as removed. */
function droppedFields(body: Readonly<Record<string, unknown>>, fields: readonly string[], removed: string[]) {
  const present = fields.filter((field) => Object.hasOwn(body, field));
  removed.push(...present);
  return present;
}

/**
 * Apply field removals and replacements to `body`, returning `body` itself
 * when nothing changed. A replacement of {@link REMOVE_FIELD} removes the field.
 */
function rebuildBody(
  body: Readonly<Record<string, unknown>>,
  dropped: readonly string[],
  replacements: ReadonlyMap<string, unknown>,
  removed: string[],
): SanitizeResult {
  const removedFields = new Set(dropped);
  for (const [field, value] of replacements) if (value === REMOVE_FIELD) removedFields.add(field);
  const changed = removedFields.size > 0 || [...replacements].some(([field, value]) => value !== body[field]);
  if (!changed) return { body, removed };
  // Object.fromEntries defines own properties, so even a `__proto__` key in
  // the parsed body is carried over as data rather than invoking the setter.
  const sanitized = Object.fromEntries(
    Object.entries(body)
      .filter(([field]) => !removedFields.has(field))
      .map(([field, value]) => [field, replacements.has(field) ? replacements.get(field) : value]),
  );
  return { body: sanitized, removed };
}

function sanitizeResponsesBody(body: Readonly<Record<string, unknown>>): SanitizeResult {
  requireExactFieldNames(body, RESPONSES_BODY_FIELDS, 'the request');
  requireModel(body);
  const instructions = body.instructions;
  if (instructions !== undefined && instructions !== null && typeof instructions !== 'string') {
    return rejectRequest('instructions must be a string');
  }
  const removed: string[] = [];
  const dropped = droppedFields(body, RESPONSES_DROPPED_FIELDS, removed);
  const replacements = new Map<string, unknown>([
    ['tools', sanitizeToolList(body.tools, 'tools', sanitizeResponsesTool, removed)],
    ['tool_choice', sanitizeToolChoice(body.tool_choice, 'responses', removed)],
    ['input', sanitizeResponsesInput(body.input, removed)],
  ]);
  return rebuildBody(body, dropped, replacements, removed);
}

function sanitizeChatBody(body: Readonly<Record<string, unknown>>): SanitizeResult {
  requireExactFieldNames(body, CHAT_BODY_FIELDS, 'the request');
  requireModel(body);
  const removed: string[] = [];
  const dropped = droppedFields(body, CHAT_DROPPED_FIELDS, removed);
  const replacements = new Map<string, unknown>([
    ['tools', sanitizeToolList(body.tools, 'tools', sanitizeChatTool, removed)],
    ['tool_choice', sanitizeToolChoice(body.tool_choice, 'chat', removed)],
    ['messages', sanitizeChatMessages(body.messages, removed)],
  ]);
  return rebuildBody(body, dropped, replacements, removed);
}

/**
 * Neither protocol has a request header that enables provider-side egress
 * (hosted tools are body fields), so no header is removed.
 */
function sanitizeHeaders(): readonly string[] {
  return [];
}

export const openaiResponsesSanitizer: RequestSanitizer = Object.freeze({
  protocol: 'openai-responses',
  sanitizeHeaders,
  sanitizeBody: sanitizeResponsesBody,
});

export const openaiChatCompletionsSanitizer: RequestSanitizer = Object.freeze({
  protocol: 'openai-chat-completions',
  sanitizeHeaders,
  sanitizeBody: sanitizeChatBody,
});

/**
 * Refuse a request that names one of OpenAI's web-search models. They search
 * the web on every request just by being named: the Chat Completions search
 * models (`gpt-4o-search-preview`, `gpt-4o-mini-search-preview`,
 * `gpt-5-search-api` and their dated snapshots) and the deep-research models
 * (`o3-deep-research`, `o4-mini-deep-research`). No request field turns that
 * off, so the request gets a 400. The model is compared trimmed and with its
 * letter case folded as {@link foldFieldName} folds it (the shared list in
 * ./web-search-models.ts). There is no exception for a user-chosen model:
 * provider-hosted web search is removed unconditionally, and on OpenRouter
 * the gateway layer, not this one, decides.
 */
function sanitizePlatformBody(body: Readonly<Record<string, unknown>>): SanitizeResult {
  const model = body.model;
  if (typeof model !== 'string') return rejectRequest('the request must name its model as a string');
  if (isWebSearchModel(model.trim().toUpperCase().toLowerCase())) {
    return rejectRequest(
      `model "${labelValue(model)}" searches the web on every request, which the proxy does not forward; ` +
        'use a model without built-in web search',
    );
  }
  return { body, removed: [] };
}

/**
 * OpenAI's own layer, chained in front of the protocol sanitizers on OpenAI's
 * first-party routes only: api.openai.com's Responses and Chat Completions
 * (`openaiProvider`) and the ChatGPT Codex backend (`codexChatGptProvider`,
 * both in ../provider-config.ts). The log names both layers:
 * `openai-platform+openai-responses`, `openai-platform+openai-chat-completions`.
 */
export const openaiPlatformSanitizer: RequestSanitizer = Object.freeze({
  protocol: 'openai-platform',
  sanitizeHeaders,
  sanitizeBody: sanitizePlatformBody,
});
