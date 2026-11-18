/**
 * HTTP fetch and web search MCP server.
 *
 * Exposes two tools:
 * - `http_fetch` (GET-only) retrieves web content, converting HTML to markdown by default.
 * - `web_search` queries a configured search provider (Brave, Tavily, or SerpAPI).
 *
 * Security (this process runs on the host without an OS sandbox, see
 * `mcp-servers.json`):
 * - The policy engine evaluates only the requested URL; it does not resolve
 *   names, and an IP-literal URL is matched by compiled rules like any other.
 *   The SSRF defence is therefore here, in `guarded-fetch.ts`: every
 *   connection is screened at connect time (names must resolve to public
 *   addresses only, IP literals are screened before the request, local and
 *   metadata names are refused), so loopback, private, link-local and
 *   metadata destinations are unreachable, DNS rebinding included. The host
 *   can admit private destinations named literally in the URL with the
 *   `fetch.allowPrivateNetworks` config flag (see `fetch-env.ts`); metadata
 *   destinations and private DNS answers stay blocked even then.
 * - Redirects are handled manually: same-origin redirects are followed (at
 *   most 5, each re-validated); a cross-origin redirect is returned to the
 *   agent unfollowed, so the next hop is a new policy-evaluated, audited
 *   `http_fetch` call and agent-supplied headers never leave the evaluated
 *   origin. Results report the final URL and the redirects followed.
 * - User-Agent header is always injected and cannot be overridden by the agent
 * - Bodies are decoded by their declared or embedded charset; binary content
 *   is reported as metadata, never returned as text
 * - Responses are capped at 10 MB; a call times out after 30 seconds by
 *   default (the agent may choose 1-60), covering every hop and the body
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import type { Headers } from 'undici';
import { VERSION } from '../version.js';
import { createSearchProvider, formatSearchResults } from './search-providers.js';
import { guardStdioStreamErrors } from '../utils/stdio-guard.js';
import { classifyContentType, decodeTextBody, looksBinary, parseContentType } from './fetch-content.js';
import { isPrivateNetworkFetchEnabled } from './fetch-env.js';
import {
  GuardedFetchError,
  MAX_SAME_ORIGIN_REDIRECTS,
  guardedFetch,
  type GuardedFetchResult,
} from './guarded-fetch.js';

const USER_AGENT = `IronCurtain/${VERSION} (AI Agent Runtime)`;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const REQUEST_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_LENGTH = 5000;
/** Response headers copied into the result. */
const RESULT_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag', 'location'] as const;

/**
 * Host opt-in for private destinations named literally in a URL. Read once
 * from the environment the host spawned this process with; no tool argument
 * can change it.
 */
const ALLOW_PRIVATE_NETWORKS = isPrivateNetworkFetchEnabled(process.env);

const MAX_READABILITY_BYTES = 1_000_000; // 1 MB — skip DOM parsing above this
const MAX_READABILITY_ELEMS = 10_000; // bail if document has too many elements

type OutputFormat = 'markdown' | 'text' | 'html';
const VALID_FORMATS: readonly OutputFormat[] = ['markdown', 'text', 'html'];

function isValidFormat(value: unknown): value is OutputFormat {
  return typeof value === 'string' && VALID_FORMATS.includes(value as OutputFormat);
}

/** Tags that carry boilerplate or non-visible content, stripped before conversion. */
const BOILERPLATE_TAGS = ['script', 'style', 'nav', 'footer', 'aside', 'noscript', 'iframe'] as const;

/** Regex for stripping boilerplate tags and their content (used in regex fallback path). */
const BOILERPLATE_TAG_RE = new RegExp(`<(${BOILERPLATE_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi');

const turndown = new TurndownService({ headingStyle: 'atx' });
turndown.remove([...BOILERPLATE_TAGS]);

const searchProvider = createSearchProvider(process.env);

/** Copies the response headers the result reports. */
function selectResponseHeaders(headers: Headers): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of RESULT_HEADERS) {
    const value = headers.get(key);
    if (value) selected[key] = value;
  }
  return selected;
}

/** The declared `Content-Length`, when it is a plain non-negative integer. */
function declaredContentLength(headers: Headers): number | null {
  const value = headers.get('content-length')?.trim();
  if (value === undefined || !/^\d{1,15}$/u.test(value)) return null;
  return Number(value);
}

/**
 * Validates the agent's `headers` argument: absent, or an object whose values
 * are all strings. Returns undefined when it is anything else.
 */
function parseRequestHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) return undefined;
  return Object.fromEntries(entries);
}

/**
 * Converts HTML to markdown using turndown.
 * Falls back to raw HTML if turndown throws.
 */
function htmlToMarkdown(html: string): string {
  try {
    return turndown.turndown(html);
  } catch {
    return html;
  }
}

/**
 * Regex-based HTML-to-text fallback. Loops boilerplate tag removal until
 * stable to prevent nested-tag bypasses (e.g. "<scri<script>...</script>pt>"
 * reconstructing after a single pass), then strips all remaining tags.
 */
export function stripHtmlFallback(html: string): string {
  let stripped = html;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(BOILERPLATE_TAG_RE, '');
  } while (stripped !== prev);
  return stripped
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strips boilerplate elements and returns plain text using JSDOM for
 * reliable entity decoding and element removal.
 */
function htmlToText(html: string): string {
  let dom: JSDOM | undefined;
  try {
    dom = new JSDOM(html);
    const doc = dom.window.document;
    for (const el of doc.querySelectorAll(BOILERPLATE_TAGS.join(','))) {
      el.remove();
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: DOM body may be null at runtime
    return (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    return stripHtmlFallback(html);
  } finally {
    dom?.window.close();
  }
}

interface ReadabilityArticle {
  title: string;
  byline: string | null;
  content: string;
  textContent: string;
}

/**
 * Extracts main article content using Mozilla Readability.
 * Returns null if the page is not article-like or extraction fails.
 *
 * Guards against DoS: skips documents over MAX_READABILITY_BYTES and
 * uses Readability's maxElemsToParse to bail on high-element-count pages.
 */
function extractWithReadability(html: string, url: string): ReadabilityArticle | null {
  let dom: JSDOM | undefined;
  try {
    if (html.length > MAX_READABILITY_BYTES) return null;

    dom = new JSDOM(html, { url });

    const doc = dom.window.document;
    if (!isProbablyReaderable(doc)) return null;

    const result = new Readability(doc, { maxElemsToParse: MAX_READABILITY_ELEMS }).parse();
    if (!result) return null;

    return {
      title: result.title ?? '',
      byline: result.byline ?? null,
      content: result.content ?? '',
      textContent: result.textContent ?? '',
    };
  } catch {
    return null;
  } finally {
    dom?.window.close();
  }
}

/**
 * Builds a metadata header from Readability results.
 * Only includes non-empty fields.
 */
function readabilityMetadataHeader(article: ReadabilityArticle): string {
  const lines: string[] = [];
  if (article.title) lines.push(`Title: ${article.title}`);
  if (article.byline) lines.push(`Byline: ${article.byline}`);
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n\n';
}

/**
 * Converts a response body to the requested output format.
 * For HTML responses, attempts Readability extraction first, falling back
 * to turndown (markdown) or regex-based tag stripping (text).
 */
function formatResponseBody(body: string, isHtml: boolean, format: OutputFormat, url: string): string {
  if (format === 'html' || !isHtml) return body;

  const article = extractWithReadability(body, url);
  const header = article ? readabilityMetadataHeader(article) : '';

  if (format === 'text') {
    const content = article ? article.textContent : htmlToText(body);
    return header + content;
  }

  // markdown (default)
  const content = article ? htmlToMarkdown(article.content) : htmlToMarkdown(body);
  return header + content;
}

// eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional use of low-level Server for raw JSON schema passthrough
const server = new Server({ name: 'ironcurtain-fetch', version: VERSION }, { capabilities: { tools: {} } });

// eslint-disable-next-line @typescript-eslint/require-await -- handler interface requires async
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'http_fetch',
      description:
        'Fetch content from a URL via HTTP GET. Returns JSON: { status, url, redirects, headers, body, truncated }. ' +
        `Same-origin redirects are followed (at most ${MAX_SAME_ORIGIN_REDIRECTS}) and listed in redirects; ` +
        'url is the URL whose response is returned. A redirect to a different origin is not followed: the result ' +
        'has the 3xx status, an empty body and redirect: { location }; call http_fetch with that location to ' +
        'continue. Non-text responses (images, PDFs, archives) return binary: { contentType, size } and no body. ' +
        'Link-local and cloud-metadata destinations are always refused; private and loopback destinations are ' +
        'refused unless the operator has allowed private networks. On error, returns JSON: { error, code }.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          headers: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'HTTP headers',
          },
          max_length: {
            type: 'number',
            default: DEFAULT_MAX_LENGTH,
            description: 'Maximum response body length in characters',
          },
          format: {
            type: 'string',
            enum: ['markdown', 'text', 'html'],
            default: 'markdown',
            description: 'Output format: markdown (default), text (stripped tags), or html (raw)',
          },
          timeout: {
            type: 'number',
            default: 30,
            description: 'Request timeout in seconds (1–60)',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'web_search',
      description: 'Search the web for information using a configured search provider',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'The search query' },
          max_results: {
            type: 'number',
            default: 5,
            description: 'Maximum number of results to return (1–20)',
          },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  switch (req.params.name) {
    case 'http_fetch':
      return handleHttpFetch(req.params.arguments);
    case 'web_search':
      return handleWebSearch(req.params.arguments);
    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
  }
});

/**
 * Shapes a guarded fetch into the tool's JSON result: status, final URL,
 * followed redirects and selected headers always; then either the
 * unfollowed cross-origin redirect, binary metadata, or the decoded and
 * formatted body.
 */
function buildFetchResult(
  result: GuardedFetchResult,
  format: OutputFormat,
  maxLength: number,
): Record<string, unknown> {
  const base = {
    status: result.status,
    url: result.url,
    redirects: result.redirects,
    headers: selectResponseHeaders(result.headers),
  };
  if (result.kind === 'cross-origin-redirect') {
    return {
      ...base,
      body: '',
      truncated: false,
      redirect: { location: result.location, followed: false, reason: 'cross-origin' },
    };
  }

  const contentType = parseContentType(result.headers.get('content-type'));
  const kind = classifyContentType(contentType.essence);
  const body = result.body;
  if (body === undefined || kind === 'binary' || (kind === 'unknown' && looksBinary(body))) {
    return {
      ...base,
      body: '',
      truncated: false,
      binary: {
        contentType: contentType.essence === '' ? null : contentType.essence,
        size: body === undefined ? declaredContentLength(result.headers) : body.byteLength,
      },
    };
  }

  const text = decodeTextBody(body, contentType);
  const processedBody = formatResponseBody(text, kind === 'html', format, result.url);
  const truncated = processedBody.length > maxLength;
  const finalBody = truncated ? processedBody.slice(0, maxLength) + '\n\n[Truncated]' : processedBody;
  return { ...base, body: finalBody, truncated };
}

/** The tool's JSON error: message and code, plus where the call was when it failed. */
function buildFetchError(err: unknown): Record<string, unknown> {
  if (!(err instanceof GuardedFetchError)) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  return {
    error: err.message,
    code: err.code,
    ...(err.url !== undefined ? { url: err.url } : {}),
    ...(err.redirects.length > 0 ? { redirects: err.redirects } : {}),
    ...(err.location !== undefined ? { location: err.location } : {}),
  };
}

function fetchError(error: Record<string, unknown>): { content: { type: string; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify(error) }], isError: true };
}

async function handleHttpFetch(
  args: Record<string, unknown> | undefined,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const url = args?.url;
  if (typeof url !== 'string' || url === '') {
    return fetchError({ error: 'Missing required parameter: url' });
  }

  const requestHeaders = parseRequestHeaders(args?.headers);
  if (requestHeaders === undefined) {
    return fetchError({ error: 'Invalid headers: expected an object whose values are strings' });
  }
  const rawMaxLength = args?.max_length;
  const maxLength =
    typeof rawMaxLength === 'number' && Number.isFinite(rawMaxLength)
      ? Math.max(0, Math.trunc(rawMaxLength))
      : DEFAULT_MAX_LENGTH;
  const rawFormat = args?.format;
  if (rawFormat !== undefined && !isValidFormat(rawFormat)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Invalid format: ${typeof rawFormat === 'string' ? rawFormat : JSON.stringify(rawFormat)}. Supported formats are: ${VALID_FORMATS.join(', ')}.`,
          }),
        },
      ],
      isError: true,
    };
  }
  const format: OutputFormat = rawFormat ?? 'markdown';
  const timeoutSec =
    typeof args?.timeout === 'number' && Number.isFinite(args.timeout)
      ? Math.min(60, Math.max(1, args.timeout))
      : REQUEST_TIMEOUT_SECONDS;

  try {
    const result = await guardedFetch(url, {
      headers: requestHeaders,
      userAgent: USER_AGENT,
      timeoutMs: timeoutSec * 1000,
      maxBodyBytes: MAX_RESPONSE_BYTES,
      allowPrivateLiterals: ALLOW_PRIVATE_NETWORKS,
      // Binary bodies are reported as metadata, so do not download them.
      readBody: (contentType) => classifyContentType(parseContentType(contentType).essence) !== 'binary',
    });

    // Return structured JSON so agents can access status, headers, and body
    // as parsed fields. MCP requires text content, so we JSON.stringify the
    // result — UTCP extracts the text and the agent can JSON.parse() it.
    return { content: [{ type: 'text', text: JSON.stringify(buildFetchResult(result, format, maxLength)) }] };
  } catch (err) {
    return fetchError(buildFetchError(err));
  }
}

async function handleWebSearch(
  args: Record<string, unknown> | undefined,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const query = args?.query as string | undefined;
  if (!query || typeof query !== 'string') {
    return {
      content: [{ type: 'text', text: 'Missing required parameter: query' }],
      isError: true,
    };
  }

  if (!searchProvider) {
    return {
      content: [
        {
          type: 'text',
          text:
            'Web search is not configured. Set a search provider in ~/.ironcurtain/config.json ' +
            'using "ironcurtain config" or by adding a webSearch section with provider and API key.',
        },
      ],
      isError: true,
    };
  }

  const rawMaxResults = args?.max_results;
  const maxResults =
    typeof rawMaxResults === 'number' && Number.isFinite(rawMaxResults)
      ? Math.min(20, Math.max(1, Math.trunc(rawMaxResults)))
      : 5;

  try {
    const results = await searchProvider.search(query, maxResults);
    const formatted = formatSearchResults(query, results);
    return { content: [{ type: 'text', text: formatted }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Search error: ${message}` }],
      isError: true,
    };
  }
}

guardStdioStreamErrors();
if (ALLOW_PRIVATE_NETWORKS) {
  // stderr reaches the session log through the proxy.
  process.stderr.write(
    '[fetch] fetch.allowPrivateNetworks is enabled: http_fetch may reach private and loopback ' +
      'addresses named literally in a requested URL\n',
  );
}
const transport = new StdioServerTransport();
await server.connect(transport);
