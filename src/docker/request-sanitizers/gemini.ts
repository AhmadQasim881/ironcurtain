/**
 * Gemini `generateContent` request sanitizer.
 *
 * Bound to generativelanguage.googleapis.com `/v1beta/models/*:generateContent`
 * and `:streamGenerateContent` (Goose's Google provider). It removes every way
 * a request can make Google reach the network or run code for the agent,
 * outside IronCurtain's policy engine:
 *
 * - `tools`: inside each Tool object only `functionDeclarations`
 *   (client-executed functions) survives. One Tool object can mix several
 *   keys, so every key is checked, not just whole entries: `googleSearch`,
 *   `googleSearchRetrieval`, `urlContext`, `codeExecution`, `computerUse`,
 *   `fileSearch`, `googleMaps` and keys that do not exist yet are dropped. A
 *   Tool left without keys is dropped, as is an entry that is not an object.
 * - Parts are allowlisted by field. A part of `contents` or
 *   `systemInstruction` may carry inline data (`text`, `inlineData`,
 *   `functionCall`, `functionResponse`) and metadata (`thought`,
 *   `thoughtSignature`, `videoMetadata`, `partMetadata`, `mediaResolution`).
 *   A part with any other field is replaced by a text placeholder: `fileData`
 *   (Google fetches its `fileUri`, whether an http(s), `gs://` or Files API
 *   URI), replayed `executableCode` / `codeExecutionResult`, or a field that
 *   does not exist yet. A function response's own `parts` may carry
 *   `inlineData` only; any other part is dropped from it.
 * - `cachedContent` is dropped: a cached-content resource brings its own
 *   tools and contents, which never pass through this sanitizer. The agent
 *   cannot create one through the proxy, so no session needs it.
 * - The query string may carry only `alt=sse` or `alt=json` (the response
 *   format; Goose streams with `alt=sse`) and `key` (an API key: a
 *   credential, not request content). Google's front end reads more than the
 *   body: system parameters in the query string can override the request's
 *   Content-Type or headers (`$ct`, `$httpHeaders`), and other parameters are
 *   bound to request fields (`cachedContent=...`). Either would change what
 *   Google acts on without passing through this sanitizer, so any other
 *   parameter or value is refused.
 *
 * Google parses JSON with the proto3 mapping, which accepts both the
 * lowerCamelCase and the snake_case name of every field, so both spellings are
 * handled everywhere (`function_declarations`, `url_context`, `file_data`,
 * `system_instruction`, ...). A single object where a list is expected
 * (`"tools": {...}`, `"parts": {...}`) is sanitized as a one-entry list and
 * keeps its shape, in case a lenient parser reads it as one; any other shape
 * of `tools`, `contents`, `parts` or `systemInstruction`, and a content, part
 * or function response that is not an object, is rejected rather than
 * forwarded.
 *
 * Everything else (`generationConfig`, `toolConfig`, `safetySettings`, ...)
 * passes through untouched, so Goose's ordinary requests are forwarded
 * unchanged. Gemini names the model in the URL path, so no body field is
 * required.
 */

import { isPlainObject } from '../../utils/is-plain-object.js';
import {
  NEUTRALIZED_CONTENT_TEXT,
  labelValue,
  rejectRequest,
  type RequestSanitizer,
  type SanitizeContext,
  type SanitizeResult,
} from './core.js';

/** Query parameters a request may carry, each with the values it may take (see the module comment). */
const QUERY_PARAMETERS: ReadonlyMap<string, RegExp> = new Map([
  ['alt', /^(?:sse|json)$/],
  ['key', /^[\w-]+$/],
]);

/**
 * Refuse a query string with any parameter or value outside
 * {@link QUERY_PARAMETERS}. Names and values are compared percent-decoded, as
 * Google reads them; a `;` or other separator ends up inside a value and fails
 * its pattern.
 */
function checkQuery(path: string): void {
  const start = path.indexOf('?');
  if (start === -1) return;
  for (const [name, value] of new URLSearchParams(path.slice(start + 1))) {
    const allowed = QUERY_PARAMETERS.get(name);
    if (!allowed) return rejectRequest(`query parameter "${labelValue(name)}" is not allowed on this endpoint`);
    if (!allowed.test(value)) return rejectRequest(`query parameter "${name}" has a value the proxy does not forward`);
  }
}

/** Tool fields the client executes itself; every other Tool field is a Google-hosted tool. */
const CLIENT_TOOL_FIELDS: ReadonlySet<string> = new Set(['functionDeclarations', 'function_declarations']);

/** Part fields whose data travels inside the request, plus part metadata. */
const INLINE_PART_FIELDS: ReadonlySet<string> = new Set([
  'text',
  'inlineData',
  'inline_data',
  'functionCall',
  'function_call',
  'functionResponse',
  'function_response',
  'thought',
  'thoughtSignature',
  'thought_signature',
  'videoMetadata',
  'video_metadata',
  'partMetadata',
  'part_metadata',
  'mediaResolution',
  'media_resolution',
]);

/** Fields a part of a function response's own `parts` may carry: inline data only. */
const INLINE_FUNCTION_RESPONSE_PART_FIELDS: ReadonlySet<string> = new Set(['inlineData', 'inline_data']);

/** Spellings of the URI-referencing part field; its removal label names the URI scheme. */
const FILE_DATA_FIELDS: ReadonlySet<string> = new Set(['fileData', 'file_data']);

/** Top-level fields that pull in server-side state the sanitizer never sees. */
const DROPPED_FIELDS: readonly string[] = ['cachedContent', 'cached_content'];

const SYSTEM_INSTRUCTION_FIELDS: readonly string[] = ['systemInstruction', 'system_instruction'];
const FUNCTION_RESPONSE_FIELDS: readonly string[] = ['functionResponse', 'function_response'];

const DROPPED = Symbol('dropped');

function placeholderPart(): Record<string, unknown> {
  return { text: NEUTRALIZED_CONTENT_TEXT };
}

/** Log label for a value that is not an object: its JSON kind, never the value. */
function kindLabel(value: unknown): string {
  if (Array.isArray(value)) return '<array>';
  return value === null ? '<null>' : `<${typeof value}>`;
}

/**
 * Log label for a removed part field: its name, plus the URI scheme for
 * `fileData`. Never the URI itself, which may carry exfiltrated data.
 */
function describePartField(part: Record<string, unknown>, field: string): string {
  if (!FILE_DATA_FIELDS.has(field)) return labelValue(field);
  const fileData = part[field];
  const uri = isPlainObject(fileData) ? (fileData.fileUri ?? fileData.file_uri) : undefined;
  if (typeof uri !== 'string') return `${field}:${kindLabel(uri)}`;
  const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(uri);
  return `${field}:${scheme ? labelValue(scheme[1].toLowerCase()) : '<no-scheme>'}`;
}

/** The entries of a repeated message field. */
interface RepeatedField {
  readonly entries: readonly unknown[];
  /** The field held one object instead of a list; the sanitized value keeps that shape. */
  readonly single: boolean;
}

/**
 * Read a repeated message field: a list, or a single object taken as a
 * one-entry list. Absent (`undefined` or `null`) yields `undefined`; any other
 * value is rejected, since it is nothing the sanitizer can inspect.
 */
function repeatedField(value: unknown, name: string): RepeatedField | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return { entries: value, single: false };
  if (isPlainObject(value)) return { entries: [value], single: true };
  return rejectRequest(`${name} must be a list`);
}

/** The sanitized value of a repeated field, in its original shape. A dropped single object becomes `[]`. */
function rebuild(field: RepeatedField, kept: readonly unknown[]): unknown {
  if (!field.single) return kept;
  return kept.length > 0 ? kept[0] : [];
}

function sanitizeTool(tool: unknown, removed: string[]): unknown {
  if (!isPlainObject(tool)) {
    removed.push(`tool:${kindLabel(tool)}`);
    return DROPPED;
  }
  const hosted = Object.keys(tool).filter((field) => !CLIENT_TOOL_FIELDS.has(field));
  if (hosted.length === 0) return tool;
  for (const field of hosted) removed.push(`tool:${labelValue(field)}`);
  const kept = Object.entries(tool).filter(([field]) => CLIENT_TOOL_FIELDS.has(field));
  // Object.fromEntries defines own properties, so no key can reach a setter.
  return kept.length > 0 ? Object.fromEntries(kept) : DROPPED;
}

function sanitizeTools(tools: unknown, removed: string[]): unknown {
  const field = repeatedField(tools, 'tools');
  if (!field) return tools;
  const sanitized = field.entries.map((tool) => sanitizeTool(tool, removed));
  if (sanitized.every((tool, index) => tool === field.entries[index])) return tools;
  return rebuild(
    field,
    sanitized.filter((tool) => tool !== DROPPED),
  );
}

/**
 * A function response's own `parts` (multimodal function results) may carry
 * inline data only. A function response that is not an object (a list of
 * responses, say) is nothing the sanitizer can inspect, so it is rejected.
 */
function sanitizeFunctionResponse(response: unknown, removed: string[]): unknown {
  if (response === undefined || response === null) return response;
  if (!isPlainObject(response)) return rejectRequest('functionResponse must be an object');
  const field = repeatedField(response.parts, 'functionResponse.parts');
  if (!field) return response;
  const kept: unknown[] = [];
  for (const part of field.entries) {
    if (!isPlainObject(part)) return rejectRequest('each part must be an object');
    const foreign = Object.keys(part).filter((name) => !INLINE_FUNCTION_RESPONSE_PART_FIELDS.has(name));
    for (const name of foreign) removed.push(`functionResponse.part:${describePartField(part, name)}`);
    if (foreign.length === 0) kept.push(part);
  }
  if (kept.length === field.entries.length) return response;
  return { ...response, parts: rebuild(field, kept) };
}

function sanitizePart(part: Record<string, unknown>, removed: string[]): Record<string, unknown> {
  const foreign = Object.keys(part).filter((field) => !INLINE_PART_FIELDS.has(field));
  if (foreign.length > 0) {
    for (const field of foreign) removed.push(`part:${describePartField(part, field)}`);
    return placeholderPart();
  }
  let current = part;
  for (const field of FUNCTION_RESPONSE_FIELDS) {
    if (!Object.hasOwn(current, field)) continue;
    const response = sanitizeFunctionResponse(current[field], removed);
    if (response !== current[field]) current = { ...current, [field]: response };
  }
  return current;
}

function sanitizeParts(parts: unknown, removed: string[]): unknown {
  const field = repeatedField(parts, 'parts');
  if (!field) return parts;
  const sanitized = field.entries.map((part) => {
    if (!isPlainObject(part)) return rejectRequest('each part must be an object');
    return sanitizePart(part, removed);
  });
  if (sanitized.every((part, index) => part === field.entries[index])) return parts;
  return rebuild(field, sanitized);
}

function sanitizeContent(content: Record<string, unknown>, removed: string[]): Record<string, unknown> {
  const parts = sanitizeParts(content.parts, removed);
  return parts === content.parts ? content : { ...content, parts };
}

function sanitizeContents(contents: unknown, removed: string[]): unknown {
  const field = repeatedField(contents, 'contents');
  if (!field) return contents;
  const sanitized = field.entries.map((content) => {
    if (!isPlainObject(content)) return rejectRequest('each content must be an object');
    return sanitizeContent(content, removed);
  });
  if (sanitized.every((content, index) => content === field.entries[index])) return contents;
  return rebuild(field, sanitized);
}

function sanitizeSystemInstruction(instruction: unknown, removed: string[]): unknown {
  if (instruction === undefined || instruction === null) return instruction;
  if (!isPlainObject(instruction)) return rejectRequest('systemInstruction must be an object');
  return sanitizeContent(instruction, removed);
}

function sanitizeBody(body: Readonly<Record<string, unknown>>, context: SanitizeContext): SanitizeResult {
  checkQuery(context.path);
  const removed: string[] = [];
  const dropped = DROPPED_FIELDS.filter((field) => Object.hasOwn(body, field));
  removed.push(...dropped);
  const replacements = new Map<string, unknown>([
    ['tools', sanitizeTools(body.tools, removed)],
    ['contents', sanitizeContents(body.contents, removed)],
    ...SYSTEM_INSTRUCTION_FIELDS.map((field): [string, unknown] => [
      field,
      sanitizeSystemInstruction(body[field], removed),
    ]),
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

export const geminiGenerateContentSanitizer: RequestSanitizer = Object.freeze({
  protocol: 'google-generate-content',
  // No Gemini request header enables a hosted feature; the body rules are the control.
  sanitizeHeaders: (): readonly string[] => [],
  sanitizeBody,
});
