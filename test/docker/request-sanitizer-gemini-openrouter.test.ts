/**
 * MITM request sanitizers for Gemini (`google-generate-content`) and the
 * OpenRouter gateway layer.
 *
 * Covers the Gemini per-key Tool allowlist and part allowlist (`fileData`
 * URIs, replayed code execution, function-response parts, `cachedContent`),
 * the OpenRouter layer (`plugins`, `web_search_options`, fallback `models`,
 * the `:online` variant, web-search models), its chaining in front of the
 * protocol sanitizer on every OpenRouter POST route, the gateway pipeline
 * (compatibility rewriter with model mapping, then the sanitizer), and
 * end-to-end behaviour through the real MITM for
 * generativelanguage.googleapis.com and openrouter.ai.
 *
 * No provider is contacted. Gemini bodies are hand-written in Goose's wire
 * shape (camelCase and snake_case, as Google's proto3 JSON parser accepts
 * both). The MITM forwards to a local fake upstream.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as http from 'node:http';
import type { Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrCreateCA, type CertificateAuthority } from '../../src/docker/ca.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import type { BuiltInLlmProtocol } from '../../src/docker/llm-observation/completion-endpoint.js';
import { googleProvider, resolveRequestSanitizer, type ProviderConfig } from '../../src/docker/provider-config.js';
import {
  NEUTRALIZED_CONTENT_TEXT,
  anthropicMessagesSanitizer,
  chainSanitizers,
  createOpenRouterRequestSanitizer,
  geminiGenerateContentSanitizer,
  isOpenRouterSearchModel,
  isRequestRejectedError,
  namesOpenRouterPreset,
  openRouterModelBase,
  processRequestBody,
  requestSanitizerFor,
  sanitizedEndpointsFor,
  stripOnlineVariant,
  type RequestRejectedError,
} from '../../src/docker/request-sanitizers/index.js';
import { makeGatewayProvider } from '../../src/docker/gateway-runtime.js';
import { makeZaiProvider } from '../../src/docker/zai.js';
import {
  getGatewayDefinition,
  type GatewayProfile,
  type GatewayProtocol,
} from '../../src/config/provider-definitions.js';
import type { DockerAgent, ResolvedZaiProfile } from '../../src/config/user-config.js';
import * as logger from '../../src/logger.js';
import {
  createFakeUpstream,
  localhostDnsLookup,
  makeHttpsRequest,
  sendConnect,
  type FakeUpstream,
  type HttpsResponse,
} from '../helpers/mitm-tls-harness.js';

function rejection(fn: () => unknown): RequestRejectedError {
  try {
    fn();
  } catch (error) {
    if (isRequestRejectedError(error)) return error;
    throw error;
  }
  throw new Error('expected the request to be rejected');
}

const ATTACKER_URL = 'https://attacker.example/report.pdf?d=c2VjcmV0';
const PLACEHOLDER_PART = { text: NEUTRALIZED_CONTENT_TEXT };

// ─── Gemini ─────────────────────────────────────────────────────────────

const GEMINI_PATH = '/v1beta/models/gemini-2.5-flash:generateContent';
const GEMINI_CTX = { method: 'POST', path: GEMINI_PATH };

function sanitizeGemini(body: Record<string, unknown>) {
  return geminiGenerateContentSanitizer.sanitizeBody(body, GEMINI_CTX);
}

const FUNCTION_DECLARATIONS = [
  {
    name: 'developer__shell',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
];

const INLINE_IMAGE = { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } };

/**
 * A Goose-shaped Gemini request: snake_case system instruction, text, an
 * inline image, a function call with its thought signature, a function
 * response with an inline image part, a thought, function declarations, tool
 * and generation config.
 */
const GOOSE_GEMINI_REQUEST = {
  system_instruction: { parts: [{ text: 'You are a general-purpose AI agent called goose.' }] },
  contents: [
    { role: 'user', parts: [{ text: 'List the files.' }, INLINE_IMAGE] },
    {
      role: 'model',
      parts: [
        { text: 'Listing.', thought: true },
        { functionCall: { name: 'developer__shell', args: { command: 'ls' } }, thoughtSignature: 'c2lnbmF0dXJl' },
      ],
    },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'developer__shell',
            response: { content: 'a.txt\nb.txt' },
            parts: [{ inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } }],
          },
        },
      ],
    },
  ],
  tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
  toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
  generationConfig: { temperature: 0.2, maxOutputTokens: 1024, thinkingConfig: { includeThoughts: true } },
  safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
};

describe('google-generate-content sanitizer: tools', () => {
  it('keeps only functionDeclarations in a Tool that mixes them with googleSearch', () => {
    const result = sanitizeGemini({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: [{ functionDeclarations: FUNCTION_DECLARATIONS, googleSearch: {} }],
    });
    expect(result.body.tools).toEqual([{ functionDeclarations: FUNCTION_DECLARATIONS }]);
    expect(result.removed).toEqual(['tool:googleSearch']);
  });

  it('removes urlContext, leaving tools empty when nothing else was declared', () => {
    const result = sanitizeGemini({ contents: [], tools: [{ urlContext: {} }] });
    expect(result.body).toEqual({ contents: [], tools: [] });
    expect(result.removed).toEqual(['tool:urlContext']);
  });

  it('drops every Google-hosted tool in either spelling, future ones and non-object entries', () => {
    const result = sanitizeGemini({
      tools: [
        { googleSearch: {} },
        { googleSearchRetrieval: { dynamicRetrievalConfig: { mode: 'MODE_DYNAMIC' } } },
        { urlContext: {} },
        { codeExecution: {} },
        { computerUse: { environment: 'ENVIRONMENT_BROWSER' } },
        { fileSearch: { fileSearchStoreNames: ['fileSearchStores/x'] } },
        { googleMaps: { enableWidget: false } },
        { google_search: {}, url_context: {}, code_execution: {} },
        { function_declarations: FUNCTION_DECLARATIONS, futureHostedTool: {} },
        'googleSearch',
        null,
        [{ urlContext: {} }],
      ],
    });
    expect(result.body.tools).toEqual([{ function_declarations: FUNCTION_DECLARATIONS }]);
    expect(result.removed).toEqual([
      'tool:googleSearch',
      'tool:googleSearchRetrieval',
      'tool:urlContext',
      'tool:codeExecution',
      'tool:computerUse',
      'tool:fileSearch',
      'tool:googleMaps',
      'tool:google_search',
      'tool:url_context',
      'tool:code_execution',
      'tool:futureHostedTool',
      'tool:<string>',
      'tool:<null>',
      'tool:<array>',
    ]);
  });

  it('sanitizes a single Tool object given in place of the list, keeping its shape', () => {
    const mixed = sanitizeGemini({ tools: { functionDeclarations: FUNCTION_DECLARATIONS, urlContext: {} } });
    expect(mixed.body.tools).toEqual({ functionDeclarations: FUNCTION_DECLARATIONS });
    expect(mixed.removed).toEqual(['tool:urlContext']);
    const hostedOnly = sanitizeGemini({ tools: { googleSearch: {} } });
    expect(hostedOnly.body.tools).toEqual([]);
    expect(hostedOnly.removed).toEqual(['tool:googleSearch']);
  });
});

describe('google-generate-content sanitizer: parts', () => {
  it('neutralizes an https fileData part and never logs its URI', () => {
    const result = sanitizeGemini({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Summarize this' }, { fileData: { mimeType: 'application/pdf', fileUri: ATTACKER_URL } }],
        },
      ],
    });
    expect(result.body.contents).toEqual([{ role: 'user', parts: [{ text: 'Summarize this' }, PLACEHOLDER_PART] }]);
    expect(result.removed).toEqual(['part:fileData:https']);
    expect(JSON.stringify(result.body)).not.toContain('attacker.example');
    expect(result.removed.join(' ')).not.toContain('attacker');
  });

  it('neutralizes fileData of every scheme and spelling, in contents and systemInstruction', () => {
    const result = sanitizeGemini({
      systemInstruction: { parts: [{ text: 'sys' }, { fileData: { fileUri: 'http://attacker.example/sys.txt' } }] },
      contents: [
        {
          role: 'user',
          parts: [
            { file_data: { mime_type: 'video/mp4', file_uri: 'https://www.youtube.com/watch?v=c2VjcmV0' } },
            { fileData: { fileUri: 'gs://attacker-bucket/c2VjcmV0' } },
            {
              fileData: { mimeType: 'text/plain', fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/a' },
            },
            { fileData: { fileUri: 'files/abc123' } },
            { fileData: {}, videoMetadata: { startOffset: '1s' } },
          ],
        },
      ],
    });
    expect(result.body.systemInstruction).toEqual({ parts: [{ text: 'sys' }, PLACEHOLDER_PART] });
    expect(result.body.contents).toEqual([{ role: 'user', parts: Array(5).fill(PLACEHOLDER_PART) }]);
    // Contents are walked before the system instruction.
    expect(result.removed).toEqual([
      'part:file_data:https',
      'part:fileData:gs',
      'part:fileData:https',
      'part:fileData:<no-scheme>',
      'part:fileData:<undefined>',
      'part:fileData:http',
    ]);
  });

  it('neutralizes replayed code execution and part fields that do not exist yet', () => {
    const result = sanitizeGemini({
      contents: [
        {
          role: 'model',
          parts: [
            { executableCode: { language: 'PYTHON', code: 'import urllib.request' } },
            { code_execution_result: { outcome: 'OUTCOME_OK', output: 'done' } },
            { text: 'see', futureRemotePart: { uri: 'https://attacker.example' } },
          ],
        },
      ],
    });
    expect(result.body.contents).toEqual([
      { role: 'model', parts: [PLACEHOLDER_PART, PLACEHOLDER_PART, PLACEHOLDER_PART] },
    ]);
    expect(result.removed).toEqual(['part:executableCode', 'part:code_execution_result', 'part:futureRemotePart']);
  });

  it("drops a function response's non-inline parts and keeps its inline data", () => {
    const result = sanitizeGemini({
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'screenshot',
                response: { ok: true },
                parts: [INLINE_IMAGE, { fileData: { mimeType: 'image/png', fileUri: ATTACKER_URL } }],
              },
            },
            { function_response: { name: 'fetch', response: {}, parts: { file_data: { file_uri: 'gs://b/o' } } } },
          ],
        },
      ],
    });
    expect(result.body.contents).toEqual([
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'screenshot', response: { ok: true }, parts: [INLINE_IMAGE] } },
          { function_response: { name: 'fetch', response: {}, parts: [] } },
        ],
      },
    ]);
    expect(result.removed).toEqual(['functionResponse.part:fileData:https', 'functionResponse.part:file_data:gs']);
  });

  it('sanitizes a single content or part object given in place of a list, keeping its shape', () => {
    const result = sanitizeGemini({ contents: { role: 'user', parts: { fileData: { fileUri: ATTACKER_URL } } } });
    expect(result.body.contents).toEqual({ role: 'user', parts: PLACEHOLDER_PART });
    expect(result.removed).toEqual(['part:fileData:https']);
  });

  it('drops cachedContent: a cached resource brings tools and contents the sanitizer never sees', () => {
    for (const field of ['cachedContent', 'cached_content']) {
      const result = sanitizeGemini({ [field]: 'cachedContents/abc123', contents: [] });
      expect(result.body).toEqual({ contents: [] });
      expect(result.removed).toEqual([field]);
    }
  });
});

describe('google-generate-content sanitizer: shape', () => {
  it("leaves Goose's ordinary request untouched (same object, nothing removed)", () => {
    const body = structuredClone(GOOSE_GEMINI_REQUEST);
    const result = sanitizeGemini(body);
    expect(result.body).toBe(body);
    expect(result.removed).toEqual([]);
  });

  it('needs no model field and treats null fields as absent', () => {
    const body = { contents: null, tools: null, systemInstruction: null };
    expect(sanitizeGemini(body).body).toBe(body);
    const nullResponse = { contents: [{ role: 'user', parts: [{ functionResponse: null }] }] };
    expect(sanitizeGemini(nullResponse).body).toBe(nullResponse);
  });

  it('never mutates the input body', () => {
    const body = {
      cachedContent: 'cachedContents/x',
      tools: [{ functionDeclarations: FUNCTION_DECLARATIONS, googleSearch: {} }],
      contents: [{ role: 'user', parts: [{ fileData: { fileUri: ATTACKER_URL } }] }],
      systemInstruction: {
        parts: [{ functionResponse: { name: 'x', parts: [{ fileData: { fileUri: 'gs://b/o' } }] } }],
      },
    };
    const before = structuredClone(body);
    sanitizeGemini(body);
    expect(body).toEqual(before);
  });

  it.each([
    ['tools is a string', { tools: 'googleSearch' }],
    ['contents is a string', { contents: 'hi' }],
    ['a content is not an object', { contents: ['hi'] }],
    ['parts is a number', { contents: [{ role: 'user', parts: 5 }] }],
    ['a part is a string', { contents: [{ role: 'user', parts: ['hi'] }] }],
    ['a part is a nested list', { contents: [{ role: 'user', parts: [[{ fileData: { fileUri: ATTACKER_URL } }]] }] }],
    ['systemInstruction is a string', { systemInstruction: 'be brief' }],
    ['system_instruction is a list', { system_instruction: [{ parts: [{ fileData: { fileUri: ATTACKER_URL } }] }] }],
    [
      'a function-response part is not an object',
      { contents: [{ role: 'user', parts: [{ functionResponse: { name: 'x', parts: [null] } }] }] },
    ],
    [
      'a functionResponse is a list',
      {
        contents: [
          {
            role: 'user',
            parts: [{ functionResponse: [{ name: 'x', parts: [{ fileData: { fileUri: ATTACKER_URL } }] }] }],
          },
        ],
      },
    ],
    ['a function_response is a string', { contents: [{ role: 'user', parts: [{ function_response: 'x' }] }] }],
  ])('rejects a body it cannot inspect: %s', (_label, body) => {
    const error = rejection(() => sanitizeGemini(body));
    expect(error.status).toBe(400);
  });
});

describe('google-generate-content sanitizer: query string', () => {
  const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

  it.each(['', '?alt=sse', '?alt=json', '?key=AIzaSy-agent_key-1', '?alt=sse&key=AIzaSy-agent_key-1', '?&alt=sse'])(
    'accepts the response format and an API key: %j',
    (query) => {
      const result = geminiGenerateContentSanitizer.sanitizeBody(body, {
        method: 'POST',
        path: `${GEMINI_PATH}${query}`,
      });
      expect(result.body).toBe(body);
    },
  );

  it.each([
    // System parameters that would make Google read the body, or headers, differently.
    '?$ct=application%2Fx-protobuf',
    '?%24ct=application%2Fjson%2Bprotobuf',
    '?alt=sse&$httpHeaders=Content-Type%3Aapplication%2Fx-protobuf',
    '?alt=proto',
    '?$alt=json',
    // A separator Google might honor ends up inside the value.
    '?alt=sse;$ct=application%2Fx-protobuf',
    // Request fields bound from the query string.
    '?cachedContent=cachedContents%2Fabc123',
    '?alt',
    '?ALT=sse',
    '?key=AIza%20x',
  ])('refuses any other parameter or value: %j', (query) => {
    const error = rejection(() =>
      geminiGenerateContentSanitizer.sanitizeBody(body, { method: 'POST', path: `${GEMINI_PATH}${query}` }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain('query parameter');
  });
});

describe('Gemini bindings', () => {
  it('binds the sanitizer on both generateContent routes of the Google provider', () => {
    expect(requestSanitizerFor('google-generate-content')).toBe(geminiGenerateContentSanitizer);
    for (const path of [
      '/v1beta/models/gemini-2.5-flash:generateContent',
      '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    ]) {
      expect(resolveRequestSanitizer(googleProvider, 'POST', path)).toBe(geminiGenerateContentSanitizer);
    }
    expect(resolveRequestSanitizer(googleProvider, 'GET', GEMINI_PATH)).toBeUndefined();
    expect(resolveRequestSanitizer(googleProvider, 'POST', '/v1beta/models/a/b:generateContent')).toBeUndefined();
  });
});

// ─── OpenRouter layer ───────────────────────────────────────────────────

const OPENROUTER_CTX = { method: 'POST', path: '/api/v1/chat/completions' };

/** A layer whose profile names one web-search model itself. */
const openRouterLayer = createOpenRouterRequestSanitizer({
  configuredModels: ['z-ai/glm-5.3', 'perplexity/sonar-pro'],
});

function sanitizeOpenRouter(body: Record<string, unknown>) {
  return openRouterLayer.sanitizeBody(body, OPENROUTER_CTX);
}

const CHAT_MESSAGES = [{ role: 'user', content: 'hi' }];

describe('openrouter sanitizer', () => {
  it('drops plugins, web_search_options and fallback models', () => {
    const result = sanitizeOpenRouter({
      model: 'z-ai/glm-5.3',
      messages: CHAT_MESSAGES,
      plugins: [{ id: 'web', max_results: 5, search_prompt: 'Results:' }],
      web_search_options: { search_context_size: 'high' },
      models: ['openai/gpt-4o:online', 'perplexity/sonar'],
    });
    expect(result.body).toEqual({ model: 'z-ai/glm-5.3', messages: CHAT_MESSAGES });
    expect(result.removed).toEqual(['plugins', 'web_search_options', 'models']);
  });

  it('drops those fields under any case or separator spelling, and stray spellings of model', () => {
    const result = sanitizeOpenRouter({
      model: 'z-ai/glm-5.3',
      Plugins: [{ id: 'web' }],
      webSearchOptions: {},
      'web-search-options': {},
      MODELS: ['perplexity/sonar'],
      Model: 'perplexity/sonar',
    });
    expect(result.body).toEqual({ model: 'z-ai/glm-5.3' });
    expect(result.removed).toEqual(['Plugins', 'webSearchOptions', 'web-search-options', 'MODELS', 'Model']);
  });

  it('strips the :online variant from an unmapped openai/gpt-4o:online', () => {
    const result = sanitizeOpenRouter({ model: 'openai/gpt-4o:online', messages: CHAT_MESSAGES });
    expect(result.body).toEqual({ model: 'openai/gpt-4o', messages: CHAT_MESSAGES });
    expect(result.removed).toEqual(['model:online']);
  });

  it.each([
    ['openai/gpt-4o:ONLINE', 'openai/gpt-4o'],
    ['openai/gpt-4o: online ', 'openai/gpt-4o'],
    ['openai/gpt-4o:nitro:online', 'openai/gpt-4o:nitro'],
    ['openai/gpt-4o:online:floor', 'openai/gpt-4o:floor'],
    ['perplexity/sonar-pro:online', 'perplexity/sonar-pro'],
  ])('strips the :online variant from %s', (model, expected) => {
    expect(stripOnlineVariant(model)).toBe(expected);
    const result = sanitizeOpenRouter({ model });
    expect(result.body).toEqual({ model: expected });
    expect(result.removed).toEqual(['model:online']);
  });

  it('refuses :online in a form it cannot strip', () => {
    const error = rejection(() => sanitizeOpenRouter({ model: 'openai/gpt-4o:online@preset/web' }));
    expect(error.status).toBe(400);
    expect(error.message).toContain(':online');
  });

  it.each([
    'perplexity/sonar',
    'perplexity/sonar-reasoning-pro',
    'perplexity/sonar-deep-research',
    'perplexity/r1-1776',
    'perplexity/llama-3.1-sonar-large-128k-online',
    'openai/gpt-4o-search-preview',
    'openai/gpt-4o-mini-search-preview-2025-03-11',
    'openai/gpt-5-search-api',
    'example/some-model-search',
    'openai/o3-deep-research',
    'openai/o4-mini-deep-research',
    'PERPLEXITY/Sonar',
    ' ~perplexity/sonar',
    'perplexity/sonar:online',
    'perplexity/sonar:nitro',
  ])('refuses the web-search model %j unless the profile names it', (model) => {
    const error = rejection(() => sanitizeOpenRouter({ model, messages: CHAT_MESSAGES }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('searches the web');
  });

  it('forwards a web-search model the profile names itself, in any variant', () => {
    const body = { model: 'perplexity/sonar-pro', messages: CHAT_MESSAGES };
    const result = sanitizeOpenRouter(body);
    expect(result.body).toBe(body);
    expect(result.removed).toEqual([]);
    expect(sanitizeOpenRouter({ model: 'Perplexity/Sonar-Pro:nitro' }).removed).toEqual([]);
  });

  it('drops the preset field under any spelling', () => {
    const result = sanitizeOpenRouter({ model: 'z-ai/glm-5.3', preset: 'web-research', Preset: 'x', PRE_SET: 'y' });
    expect(result.body).toEqual({ model: 'z-ai/glm-5.3' });
    expect(result.removed).toEqual(['preset', 'Preset', 'PRE_SET']);
  });

  it.each([
    '@preset/web-research',
    'openai/gpt-4o@preset/web-research',
    'openai/gpt-4o:nitro@preset/web-research',
    'z-ai/glm-5.3@preset/x',
    ' @PRESET/Web ',
    'openai/gpt-4o@ preset/x',
    // The profile names perplexity/sonar-pro, but not this preset on top of it.
    'perplexity/sonar-pro:nitro@preset/web-research',
  ])('refuses the preset-applying model %j unless the profile names it', (model) => {
    expect(namesOpenRouterPreset(model)).toBe(true);
    const error = rejection(() => sanitizeOpenRouter({ model, messages: CHAT_MESSAGES }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('preset');
  });

  it('forwards a preset-applying model the profile names itself', () => {
    const layer = createOpenRouterRequestSanitizer({ configuredModels: ['z-ai/glm-5.3', '@preset/Team-Default'] });
    const body = { model: '@preset/team-default', messages: CHAT_MESSAGES };
    expect(layer.sanitizeBody(body, OPENROUTER_CTX).body).toBe(body);
    // Only that exact model: another preset, or the same preset on another model, is refused.
    for (const model of ['@preset/other', 'openai/gpt-4o@preset/team-default']) {
      expect(rejection(() => layer.sanitizeBody({ model }, OPENROUTER_CTX)).status, model).toBe(400);
    }
  });

  it('does not mistake ordinary models for web-search models', () => {
    for (const model of [
      'z-ai/glm-5.3',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'anthropic/claude-sonnet-4.5',
      'google/gemini-2.5-flash',
      'x-ai/grok-4',
      'moonshotai/kimi-k2',
      'nousresearch/hermes-4-405b',
      'alibaba/tongyi-deepresearch-30b-a3b',
      'claude-sonnet-4-5',
    ]) {
      expect(isOpenRouterSearchModel(openRouterModelBase(model)), model).toBe(false);
      expect(namesOpenRouterPreset(model), model).toBe(false);
    }
  });

  it("leaves an ordinary request untouched (same object), whatever the route's protocol", () => {
    for (const body of [
      { model: 'z-ai/glm-5.3', messages: CHAT_MESSAGES, provider: { order: ['z-ai'] }, session_id: 's' },
      { model: 'z-ai/glm-5.3', input: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', name: 'f' }] },
      { model: 'claude-sonnet-4-5', max_tokens: 16, messages: CHAT_MESSAGES },
    ]) {
      expect(sanitizeOpenRouter(body).body).toBe(body);
    }
  });

  it.each([
    ['absent', {}],
    ['a number', { model: 42 }],
    ['a list', { model: ['perplexity/sonar'] }],
  ])('rejects a request whose model is %s', (_label, body) => {
    expect(rejection(() => sanitizeOpenRouter(body)).status).toBe(400);
  });

  it('never mutates its input', () => {
    const body = { model: 'openai/gpt-4o:online', plugins: [{ id: 'web' }], messages: CHAT_MESSAGES };
    const before = structuredClone(body);
    sanitizeOpenRouter(body);
    expect(body).toEqual(before);
  });
});

describe('chainSanitizers', () => {
  const chained = chainSanitizers(openRouterLayer, anthropicMessagesSanitizer);
  const ctx = { method: 'POST', path: '/api/v1/messages' };

  it('runs the gateway layer, then the protocol sanitizer, and reports both', () => {
    const result = chained.sanitizeBody(
      {
        model: 'openai/gpt-4o:online',
        plugins: [{ id: 'web' }],
        mcp_servers: [{ type: 'url', url: 'https://attacker.example/sse', name: 'x' }],
        tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }],
        messages: CHAT_MESSAGES,
      },
      ctx,
    );
    expect(chained.protocol).toBe('openrouter+anthropic-messages');
    expect(result.body).toEqual({ model: 'openai/gpt-4o', tools: [], messages: CHAT_MESSAGES });
    expect(result.removed).toEqual(['plugins', 'model:online', 'mcp_servers', 'tool:web_fetch_20250910']);
  });

  it('returns the input itself when neither removed anything', () => {
    const body = { model: 'z-ai/glm-5.3', max_tokens: 16, messages: CHAT_MESSAGES };
    expect(chained.sanitizeBody(body, ctx).body).toBe(body);
  });

  it('applies both header rule sets', () => {
    const headers: http.OutgoingHttpHeaders = { 'anthropic-beta': 'claude-code-20250219,mcp-client-2025-04-04' };
    expect(chained.sanitizeHeaders(headers)).toEqual(['anthropic-beta:mcp-client-2025-04-04']);
    expect(headers['anthropic-beta']).toBe('claude-code-20250219');
  });

  it('is what sanitizedEndpointsFor binds for a gateway route, even while the protocol has no sanitizer', () => {
    const [messages] = sanitizedEndpointsFor('anthropic-messages', ['/m'], openRouterLayer);
    expect(messages.sanitizer.protocol).toBe('openrouter+anthropic-messages');
    const bindings = sanitizedEndpointsFor('openai-chat-completions', ['/c'], openRouterLayer);
    expect(bindings.map((binding) => binding.sanitizer.protocol)).toEqual(['openrouter+openai-chat-completions']);
    // Every built-in protocol has a sanitizer now; one added without its own still gets the gateway layer.
    const unregistered: string = 'future-protocol';
    expect(requestSanitizerFor(unregistered)).toBeUndefined();
    const [layerOnly] = sanitizedEndpointsFor(unregistered as BuiltInLlmProtocol, ['/f'], openRouterLayer);
    expect(layerOnly).toEqual({ method: 'POST', path: '/f', sanitizer: openRouterLayer });
    expect(sanitizedEndpointsFor(unregistered as BuiltInLlmProtocol, ['/f'])).toEqual([]);
  });
});

// ─── OpenRouter gateway path (rewriter, then sanitizer) ─────────────────

/** A profile whose map produces `:online` for opus and names one search model explicitly. */
const openRouterProfile: GatewayProfile = {
  type: 'openrouter',
  apiKey: '',
  modelMap: [
    { match: '*sonnet*', model: 'z-ai/glm-5.2' },
    { match: '*opus*', model: 'openai/gpt-4o:online' },
    { match: 'research', model: 'perplexity/sonar-pro' },
  ],
  usesDefaultMap: false,
  perAgent: { 'claude-code': undefined, codex: undefined, goose: undefined },
  sessionAffinity: false,
};

const zaiProfile: ResolvedZaiProfile = {
  type: 'zai',
  apiKey: '',
  model: 'glm-5.3',
  plan: 'api',
  modelMap: [{ match: '*', model: 'glm-5.3' }],
  usesDefaultMap: false,
  perAgent: { 'claude-code': undefined, codex: undefined, goose: undefined },
};

/** Each OpenRouter route with a request body in its own wire shape. */
const OPENROUTER_ROUTES: readonly (readonly [GatewayProtocol, DockerAgent, string, Record<string, unknown>])[] = [
  ['messages', 'claude-code', '/api/v1/messages', { max_tokens: 64, messages: CHAT_MESSAGES }],
  ['responses', 'codex', '/api/v1/responses', { input: [{ role: 'user', content: 'hi' }] }],
  ['chat', 'goose', '/api/v1/chat/completions', { messages: CHAT_MESSAGES }],
];

interface GatewayResult {
  readonly body: Record<string, unknown>;
  readonly rewritten: readonly string[];
  readonly removed: readonly string[];
}

/** Runs a body through a gateway provider's full pipeline, as the MITM does: rewriter (completion route only), then sanitizer. */
function throughGateway(config: ProviderConfig, path: string, body: Record<string, unknown>): GatewayResult {
  const processed = processRequestBody(
    Buffer.from(JSON.stringify(body)),
    {
      rewriter: config.rewriteEndpoints?.includes(path) ? config.requestRewriter : undefined,
      sanitizer: resolveRequestSanitizer(config, 'POST', path),
    },
    { method: 'POST', path },
  );
  return {
    body: JSON.parse(processed.body.toString()) as Record<string, unknown>,
    rewritten: processed.rewritten,
    removed: processed.removed,
  };
}

describe('OpenRouter gateway path', () => {
  it('declares the OpenRouter layer in the gateway definition', () => {
    expect(getGatewayDefinition('openrouter').gatewaySanitizer).toBe('openrouter');
    expect(getGatewayDefinition('zai').gatewaySanitizer).toBeUndefined();
  });

  it.each(OPENROUTER_ROUTES)('%s binds the OpenRouter layer on every POST route', (protocol, agent, completion) => {
    const config = makeGatewayProvider(openRouterProfile, protocol, agent);
    const wire = config.completionEndpoints?.[0]?.protocol ?? '';
    const protocolSanitizer = requestSanitizerFor(wire);
    const expected = protocolSanitizer ? `openrouter+${protocolSanitizer.protocol}` : 'openrouter';
    const postPaths = config.allowedEndpoints.filter((endpoint) => endpoint.method === 'POST').map((e) => e.path);
    expect(postPaths).toContain(completion);
    for (const path of postPaths) expect(resolveRequestSanitizer(config, 'POST', path)?.protocol, path).toBe(expected);
  });

  it('Z.AI routes get no OpenRouter layer', () => {
    for (const agent of ['claude-code', 'codex', 'goose'] as const) {
      const config = makeZaiProvider(zaiProfile, agent);
      for (const endpoint of config.allowedEndpoints.filter((e) => e.method === 'POST')) {
        expect(resolveRequestSanitizer(config, 'POST', endpoint.path)?.protocol ?? '').not.toMatch(/openrouter/);
      }
    }
  });

  it.each(OPENROUTER_ROUTES)(
    '%s: neutralizes plugins, web_search_options and an unmapped openai/gpt-4o:online',
    (protocol, agent, path, wireBody) => {
      const config = makeGatewayProvider(openRouterProfile, protocol, agent);
      const result = throughGateway(config, path, {
        ...wireBody,
        model: 'openai/gpt-4o:online',
        plugins: [{ id: 'web', max_results: 3 }],
        web_search_options: { search_context_size: 'high' },
      });
      expect(result.body).toEqual({ ...wireBody, model: 'openai/gpt-4o' });
      expect(result.removed).toEqual(['plugins', 'web_search_options', 'model:online']);
    },
  );

  it('strips :online that the profile model map produced, after mapping', () => {
    const config = makeGatewayProvider(openRouterProfile, 'messages', 'claude-code');
    const result = throughGateway(config, '/api/v1/messages', { model: 'claude-opus-4-6', messages: CHAT_MESSAGES });
    expect(result.rewritten).toContain('model:openai/gpt-4o:online');
    expect(result.body.model).toBe('openai/gpt-4o');
    expect(result.removed).toEqual(['model:online']);
  });

  it('keeps mapping ordinary models as before', () => {
    const config = makeGatewayProvider(openRouterProfile, 'messages', 'claude-code');
    const result = throughGateway(config, '/api/v1/messages', { model: 'claude-sonnet-4-6', messages: CHAT_MESSAGES });
    expect(result.body).toEqual({ model: 'z-ai/glm-5.2', messages: CHAT_MESSAGES, provider: { order: ['z-ai'] } });
    expect(result.removed).toEqual([]);
  });

  it.each(OPENROUTER_ROUTES)(
    '%s: refuses a web-search model the agent picked itself',
    (protocol, agent, path, body) => {
      const config = makeGatewayProvider(openRouterProfile, protocol, agent);
      for (const model of ['perplexity/sonar', 'openai/gpt-4o-search-preview', 'perplexity/sonar-pro-search']) {
        const error = rejection(() => throughGateway(config, path, { ...body, model }));
        expect(error.status, model).toBe(400);
      }
    },
  );

  it('forwards a web-search model the profile maps to', () => {
    const config = makeGatewayProvider(openRouterProfile, 'chat', 'goose');
    const result = throughGateway(config, '/api/v1/chat/completions', { model: 'research', messages: CHAT_MESSAGES });
    expect(result.body.model).toBe('perplexity/sonar-pro');
    // Once named by the profile, the agent may also ask for it directly.
    expect(throughGateway(config, '/api/v1/chat/completions', { model: 'perplexity/sonar-pro' }).body.model).toBe(
      'perplexity/sonar-pro',
    );
  });

  it('forwards a web-search model set as a per-agent model', () => {
    const profile: GatewayProfile = {
      ...openRouterProfile,
      modelMap: [],
      perAgent: { 'claude-code': undefined, codex: undefined, goose: 'perplexity/sonar' },
    };
    const config = makeGatewayProvider(profile, 'chat', 'goose');
    expect(throughGateway(config, '/api/v1/chat/completions', { model: 'anything' }).body.model).toBe(
      'perplexity/sonar',
    );
  });

  it.each(OPENROUTER_ROUTES)(
    '%s: refuses a preset the agent picked itself and forwards one the profile maps to',
    (protocol, agent, path, body) => {
      const profile: GatewayProfile = {
        ...openRouterProfile,
        modelMap: [...openRouterProfile.modelMap, { match: 'team', model: '@preset/team-default' }],
      };
      const config = makeGatewayProvider(profile, protocol, agent);
      // A preset's saved model list can name a web-search model or an :online variant.
      for (const model of ['@preset/web-research', 'openai/gpt-4o@preset/web-research']) {
        expect(rejection(() => throughGateway(config, path, { ...body, model })).status, model).toBe(400);
      }
      const mapped = throughGateway(config, path, { ...body, model: 'team', preset: 'web-research' });
      expect(mapped.body.model).toBe('@preset/team-default');
      expect(mapped.body).not.toHaveProperty('preset');
      expect(mapped.removed).toEqual(['preset']);
    },
  );

  it('count_tokens: no model mapping, but the OpenRouter layer and the Anthropic rules still apply', () => {
    const config = makeGatewayProvider(openRouterProfile, 'messages', 'claude-code');
    const result = throughGateway(config, '/api/v1/messages/count_tokens', {
      model: 'claude-opus-4-6:online',
      plugins: [{ id: 'web' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: CHAT_MESSAGES,
    });
    expect(result.rewritten).toEqual([]);
    expect(result.body).toEqual({ model: 'claude-opus-4-6', tools: [], messages: CHAT_MESSAGES });
    expect(result.removed).toEqual(['plugins', 'model:online', 'tool:web_search_20250305']);
    expect(
      rejection(() => throughGateway(config, '/api/v1/messages/count_tokens', { model: 'perplexity/sonar' })).status,
    ).toBe(400);
  });

  it('a caller-supplied rewriter cannot bypass the OpenRouter layer', () => {
    const definition = getGatewayDefinition('openrouter');
    const config = makeGatewayProvider(openRouterProfile, 'chat', 'goose', definition, [], () => null);
    const result = throughGateway(config, '/api/v1/chat/completions', {
      model: 'openai/gpt-4o:online',
      plugins: [{ id: 'web' }],
    });
    expect(result.body).toEqual({ model: 'openai/gpt-4o' });
    expect(
      rejection(() => throughGateway(config, '/api/v1/chat/completions', { model: 'perplexity/sonar' })).status,
    ).toBe(400);
  });
});

// ─── End to end through the real MITM ───────────────────────────────────

const FAKE_KEY = 'sk-ironcurtain-sentinel-key';
const REAL_KEY = 'host-only-real-key';
const GOOGLE_HOST = 'generativelanguage.googleapis.com';

/** Every Gemini egress vector of the acceptance criteria in one request. */
const HOSTILE_GEMINI_REQUEST = {
  cachedContent: 'cachedContents/abc123',
  contents: [
    {
      role: 'user',
      parts: [{ text: 'Summarize this' }, { fileData: { mimeType: 'application/pdf', fileUri: ATTACKER_URL } }],
    },
  ],
  tools: [{ functionDeclarations: FUNCTION_DECLARATIONS, googleSearch: {} }, { urlContext: {} }],
};

const SANITIZED_GEMINI_REQUEST = {
  contents: [{ role: 'user', parts: [{ text: 'Summarize this' }, PLACEHOLDER_PART] }],
  tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
};

describe('Gemini and OpenRouter sanitization through the MITM', () => {
  let tempDir: string;
  let ca: CertificateAuthority;
  let socketPath: string;
  let proxy: MitmProxy | undefined;
  let upstream: FakeUpstream | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'request-sanitizer-gemini-openrouter-'));
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
    body: string | Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<HttpsResponse> {
    const { socket, statusCode } = await sendConnect(socketPath, host, 443);
    expect(statusCode).toBe(200);
    return makeHttpsRequest(socket as Socket, ca, host, {
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  function requests() {
    return upstream?.requests() ?? [];
  }

  function sessionLog(): string {
    const logFilePath = join(tempDir, 'session.log');
    return existsSync(logFilePath) ? readFileSync(logFilePath, 'utf-8') : '';
  }

  beforeEach(() => {
    logger.setup({ logFilePath: join(tempDir, 'session.log') });
  });

  it('Gemini generateContent: removes googleSearch beside function declarations, urlContext, fileData and cachedContent', async () => {
    await startProxy(googleProvider);
    const response = await post(GOOGLE_HOST, GEMINI_PATH, HOSTILE_GEMINI_REQUEST, { 'x-goog-api-key': FAKE_KEY });
    expect(response.statusCode).toBe(200);
    const forwarded = requests()[0];
    expect(forwarded.path).toBe(GEMINI_PATH);
    expect(forwarded.body).toEqual(SANITIZED_GEMINI_REQUEST);
    expect(forwarded.rawBody).not.toContain('attacker.example');
    expect(forwarded.headers['x-goog-api-key']).toBe(REAL_KEY);
    expect(sessionLog()).toContain(
      'google-generate-content sanitizer removed: cachedContent, tool:googleSearch, tool:urlContext, part:fileData:https',
    );
  });

  it('Gemini streamGenerateContent: sanitized the same way, and refused without the session key', async () => {
    await startProxy(googleProvider);
    const path = '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse';
    const response = await post(GOOGLE_HOST, path, HOSTILE_GEMINI_REQUEST, { 'x-goog-api-key': FAKE_KEY });
    expect(response.statusCode).toBe(200);
    const forwarded = requests().at(-1);
    expect(forwarded?.path).toBe(path);
    expect(forwarded?.body).toEqual(SANITIZED_GEMINI_REQUEST);
    expect(forwarded?.headers['x-goog-api-key']).toBe(REAL_KEY);

    // An agent-supplied key (header or query) or none at all never reaches Google.
    for (const [credential, requestPath] of [
      [{ 'x-goog-api-key': 'AIzaSy-agent-owned-key' }, path],
      [{}, `${path}&key=AIzaSy-agent-owned-key`],
      [{}, path],
    ] as const) {
      const refused = await post(GOOGLE_HOST, requestPath, HOSTILE_GEMINI_REQUEST, credential);
      expect(refused.statusCode).toBe(401);
    }
    expect(requests()).toHaveLength(1);
  });

  it('Gemini: a `key` query parameter carrying the session key is moved to the header, never forwarded', async () => {
    await startProxy(googleProvider);
    const response = await post(
      GOOGLE_HOST,
      `/v1beta/models/gemini-2.5-pro:streamGenerateContent?key=${FAKE_KEY}&alt=sse`,
      HOSTILE_GEMINI_REQUEST,
      {},
    );
    expect(response.statusCode).toBe(200);
    const forwarded = requests()[0];
    expect(forwarded.path).toBe('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    expect(forwarded.headers['x-goog-api-key']).toBe(REAL_KEY);
    expect(forwarded.body).toEqual(SANITIZED_GEMINI_REQUEST);
  });

  it("Gemini: forwards Goose's ordinary request byte-for-byte", async () => {
    await startProxy(googleProvider);
    const raw = JSON.stringify(GOOSE_GEMINI_REQUEST);
    const response = await post(GOOGLE_HOST, GEMINI_PATH, raw, { 'x-goog-api-key': FAKE_KEY });
    expect(response.statusCode).toBe(200);
    expect(requests()[0].rawBody).toBe(raw);
    expect(sessionLog()).not.toContain('sanitizer removed');
  });

  it.each([
    ['malformed JSON', '{"contents":[{"parts":[{"fileData":{"fileUri":"https://attacker.example"}}]}]'],
    ['a part that is not an object', JSON.stringify({ contents: [{ parts: ['https://attacker.example'] }] })],
  ])('Gemini: answers %s with a local 400 and never contacts the upstream', async (_label, raw) => {
    await startProxy(googleProvider);
    const response = await post(GOOGLE_HOST, GEMINI_PATH, raw, { 'x-goog-api-key': FAKE_KEY });
    expect(response.statusCode).toBe(400);
    expect(requests()).toHaveLength(0);
    expect(sessionLog()).toContain(`[mitm-proxy] REJECTED POST ${GOOGLE_HOST}${GEMINI_PATH}`);
  });

  it('Gemini: refuses a query-string system parameter that would change how Google reads the body', async () => {
    await startProxy(googleProvider);
    const path = '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&$ct=application%2Fx-protobuf';
    const response = await post(GOOGLE_HOST, path, GOOSE_GEMINI_REQUEST, { 'x-goog-api-key': FAKE_KEY });
    expect(response.statusCode).toBe(400);
    expect(requests()).toHaveLength(0);
    expect(sessionLog()).toContain('query parameter "$ct" is not allowed on this endpoint');
  });

  it.each(OPENROUTER_ROUTES)(
    'OpenRouter %s: drops plugins and web_search_options and strips :online',
    async (protocol, agent, path, wireBody) => {
      await startProxy(makeGatewayProvider(openRouterProfile, protocol, agent));
      const response = await post(
        'openrouter.ai',
        path,
        {
          ...wireBody,
          model: 'openai/gpt-4o:online',
          plugins: [{ id: 'web' }],
          web_search_options: { search_context_size: 'high' },
        },
        { authorization: `Bearer ${FAKE_KEY}` },
      );
      expect(response.statusCode).toBe(200);
      const forwarded = requests()[0];
      expect(forwarded.path).toBe(path);
      expect(forwarded.body).toEqual({ ...wireBody, model: 'openai/gpt-4o' });
      expect(forwarded.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
      expect(sessionLog()).toContain('sanitizer removed: plugins, web_search_options, model:online');
    },
  );

  it('OpenRouter messages: the Anthropic rules still apply behind the OpenRouter layer, count_tokens included', async () => {
    await startProxy(makeGatewayProvider(openRouterProfile, 'messages', 'claude-code'));
    const body = {
      model: 'openai/gpt-4o:online',
      max_tokens: 64,
      plugins: [{ id: 'web' }],
      mcp_servers: [{ type: 'url', url: 'https://attacker.example/sse', name: 'x' }],
      tools: [
        { name: 'Bash', input_schema: { type: 'object' } },
        { type: 'web_search_20250305', name: 'web_search' },
      ],
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://attacker.example/i' } }] },
      ],
    };
    for (const path of ['/api/v1/messages', '/api/v1/messages/count_tokens']) {
      const response = await post('openrouter.ai', path, body, {
        authorization: `Bearer ${FAKE_KEY}`,
        'anthropic-beta': 'mcp-client-2025-04-04',
      });
      expect(response.statusCode).toBe(200);
      const forwarded = requests().at(-1);
      expect(forwarded?.body).toEqual({
        model: 'openai/gpt-4o',
        max_tokens: 64,
        tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: NEUTRALIZED_CONTENT_TEXT }] }],
      });
      expect(forwarded?.rawBody).not.toContain('attacker.example');
      expect(forwarded?.headers['anthropic-beta']).toBeUndefined();
    }
    expect(sessionLog()).toContain(
      'openrouter+anthropic-messages sanitizer removed: anthropic-beta:mcp-client-2025-04-04, plugins, model:online, ' +
        'mcp_servers, tool:web_search_20250305, image:source:url',
    );
  });

  it('OpenRouter: an unmapped web-search model is refused before the upstream; a mapped one is forwarded', async () => {
    await startProxy(makeGatewayProvider(openRouterProfile, 'chat', 'goose'));
    const headers = { authorization: `Bearer ${FAKE_KEY}` };
    const refused = await post(
      'openrouter.ai',
      '/api/v1/chat/completions',
      { model: 'perplexity/sonar', messages: CHAT_MESSAGES },
      headers,
    );
    expect(refused.statusCode).toBe(400);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { type: 'invalid_request_error' } });
    expect(requests()).toHaveLength(0);
    expect(sessionLog()).toContain(
      '[mitm-proxy] REJECTED POST openrouter.ai/api/v1/chat/completions - model "perplexity/sonar"',
    );

    const mapped = await post(
      'openrouter.ai',
      '/api/v1/chat/completions',
      { model: 'research', messages: CHAT_MESSAGES },
      headers,
    );
    expect(mapped.statusCode).toBe(200);
    expect(requests()[0].body.model).toBe('perplexity/sonar-pro');
  });

  it('OpenRouter: a preset the agent picked is refused before the upstream; a preset field is dropped', async () => {
    await startProxy(makeGatewayProvider(openRouterProfile, 'chat', 'goose'));
    const headers = { authorization: `Bearer ${FAKE_KEY}` };
    const refused = await post(
      'openrouter.ai',
      '/api/v1/chat/completions',
      { model: 'openai/gpt-4o@preset/web-research', messages: CHAT_MESSAGES },
      headers,
    );
    expect(refused.statusCode).toBe(400);
    expect(requests()).toHaveLength(0);

    const dropped = await post(
      'openrouter.ai',
      '/api/v1/chat/completions',
      { model: 'openai/gpt-4o', preset: 'web-research', messages: CHAT_MESSAGES },
      headers,
    );
    expect(dropped.statusCode).toBe(200);
    expect(requests()[0].body).toEqual({ model: 'openai/gpt-4o', messages: CHAT_MESSAGES });
    expect(sessionLog()).toContain('sanitizer removed: preset');
  });
});
