import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { stripHtmlFallback } from '../src/servers/fetch-server.js';
import { FETCH_ALLOW_PRIVATE_NETWORKS_ENV } from '../src/servers/fetch-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const fetchServerPath = resolve(projectRoot, 'src/servers/fetch-server.ts');
const tsxBin = resolve(projectRoot, 'node_modules/.bin/tsx');

/** "Café crème brûlée" is not valid UTF-8 once encoded as ISO-8859-1. */
const LATIN1_TEXT = 'Café crème brûlée';

const XHTML_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>XHTML Page</title></head>
<body><script>var leaked = 1;</script><main><h1>XHTML Heading</h1><p>Served as application/xhtml+xml.</p></main></body></html>`;

/** A PNG signature followed by an IHDR chunk header: binary by any measure. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01,
]);

const TEST_HTML = `<!DOCTYPE html>
<html><head><title>Test Page</title></head>
<body>
<script>var x = 1;</script>
<style>.hidden { display: none; }</style>
<nav><a href="/">Home</a></nav>
<main>
<h1>Hello World</h1>
<p>This is a <strong>test</strong> page with &amp; entities.</p>
</main>
<footer>Copyright 2026</footer>
<aside>Sidebar content</aside>
</body></html>`;

// A realistic article page with enough content for Readability's charThreshold (~500 chars).
// Includes boilerplate (nav, sidebar, cookie banner, ads) that Readability should strip.
const ARTICLE_HTML = `<!DOCTYPE html>
<html><head><title>Breaking Discovery in Solar Energy</title></head>
<body>
<nav class="site-nav"><a href="/">Home</a> | <a href="/news">News</a> | <a href="/about">About</a></nav>
<div class="cookie-banner">We use cookies to improve your experience. <button>Accept</button></div>
<div class="ad-placeholder">ADVERTISEMENT: Buy our product today!</div>
<div class="sidebar">
  <h3>Related Articles</h3>
  <ul>
    <li><a href="/article/1">First related article link</a></li>
    <li><a href="/article/2">Second related article link</a></li>
    <li><a href="/article/3">Third related article link</a></li>
  </ul>
  <h3>Newsletter</h3>
  <p>Subscribe to our newsletter for daily updates.</p>
</div>
<article>
  <h1>Breaking Discovery in Solar Energy</h1>
  <p class="byline">By Jane Smith, Science Correspondent</p>
  <p>Scientists at the National Renewable Energy Laboratory have announced a groundbreaking
  advancement in solar cell technology that could dramatically reduce the cost of solar energy
  production worldwide. The new perovskite-silicon tandem cells achieved a record efficiency
  of 33.7 percent in laboratory conditions, surpassing all previous records.</p>
  <p>The research team, led by Dr. Maria Chen, spent three years developing the novel tandem
  architecture that combines perovskite with traditional silicon cells. "This is a watershed
  moment for renewable energy," Dr. Chen said in a press conference. "We've shown that it's
  possible to break through the theoretical efficiency limits of single-junction cells."</p>
  <p>Industry analysts predict that this breakthrough could reduce the cost of solar panels
  by up to 40 percent within the next five years. Major manufacturers including SunPower,
  First Solar, and JinkoSolar have already expressed interest in licensing the technology
  for commercial production.</p>
  <p>The implications extend beyond just electricity generation. The improved efficiency means
  that solar installations can produce more power per square meter, making rooftop solar
  viable in regions that were previously considered too cloudy or too far north for effective
  solar energy harvesting. This could accelerate the global transition away from fossil fuels.</p>
  <p>Environmental groups have praised the development. "Every percentage point of efficiency
  gain translates to millions of tons of carbon emissions avoided," said Michael Torres,
  director of the Clean Energy Alliance. "This kind of innovation is exactly what we need
  to meet our climate goals."</p>
</article>
<footer class="site-footer">
  <p>Copyright 2026 Science Daily News. All rights reserved.</p>
  <nav><a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms of Service</a></nav>
</footer>
</body></html>`;

let httpServer: HttpServer;
let port: number;
let baseUrl: string;
/**
 * Fetch server spawned with the host-set private-network opt-in, so the
 * tests can reach the loopback fixture server. The agent cannot set this:
 * it lives in the server's environment, not in any tool argument.
 */
let client: Client;
let clientStderr = '';
/** Fetch server spawned without the opt-in, as shipped by default. */
let strictClient: Client;
let strictStderr = '';

/** Stand-in for an internal service (metadata, admin API) on another loopback port. */
let internalServer: HttpServer;
let internalUrl: string;
let internalHits = 0;

beforeAll(async () => {
  // Start a local HTTP server with controlled responses
  httpServer = createServer((req, res) => {
    const chain = /^\/chain\/(\d+)$/u.exec(req.url ?? '');
    if (chain) {
      const remaining = Number(chain[1]);
      if (remaining === 0) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('end of chain');
      } else {
        res.writeHead(302, { Location: `/chain/${remaining - 1}` });
        res.end();
      }
    } else if (req.url === '/redirect-internal') {
      // Cross-origin (different port) redirect to an internal service.
      res.writeHead(302, { Location: `${internalUrl}/latest/meta-data/iam/security-credentials/` });
      res.end();
    } else if (req.url === '/redirect-metadata') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    } else if (req.url === '/echo-headers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.headers));
    } else if (req.url === '/latin1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=ISO-8859-1' });
      res.end(Buffer.from(`<html><body><main><p>${LATIN1_TEXT}</p></main></body></html>`, 'latin1'));
    } else if (req.url === '/latin1-meta') {
      // No charset on the header; the document declares it.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        Buffer.from(
          `<html><head><meta charset="iso-8859-1"><title>t</title></head><body><p>${LATIN1_TEXT}</p></body></html>`,
          'latin1',
        ),
      );
    } else if (req.url === '/latin1-plain') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset="windows-1252"' });
      res.end(Buffer.from(LATIN1_TEXT, 'latin1'));
    } else if (req.url === '/xhtml') {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml' });
      res.end(XHTML_DOC);
    } else if (req.url === '/png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG_BYTES.length) });
      res.end(PNG_BYTES);
    } else if (req.url === '/octet-binary') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]));
    } else if (req.url === '/octet-text') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('plain words served as octet-stream');
    } else if (req.url === '/html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(TEST_HTML);
    } else if (req.url === '/article') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ARTICLE_HTML);
    } else if (req.url === '/plain') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Plain text response');
    } else if (req.url === '/large-html') {
      // HTML over 1MB — should skip Readability and fall back to Turndown
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const filler = '<p>' + 'x'.repeat(1000) + '</p>\n';
      const count = Math.ceil(1_100_000 / filler.length);
      res.end(
        `<!DOCTYPE html><html><head><title>Large Page</title></head><body>` +
          `<article><h1>Large Article</h1>${filler.repeat(count)}</article></body></html>`,
      );
    } else if (req.url === '/many-elements') {
      // HTML with >10,000 elements — should trip maxElemsToParse
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const spans = Array.from({ length: 11_000 }, (_, i) => `<span>${i}</span>`).join('');
      res.end(
        `<!DOCTYPE html><html><head><title>Many Elements</title></head><body>` +
          `<article><h1>Element Heavy</h1><p>${spans}</p></article></body></html>`,
      );
    } else if (req.url === '/slow') {
      // Never respond — used to test timeout
      // (request will hang until timeout fires)
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  port = (httpServer.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;

  internalServer = createServer((_req, res) => {
    internalHits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"access_token":"ya29.SECRET"}');
  });
  await new Promise<void>((resolve) => {
    internalServer.listen(0, '127.0.0.1', resolve);
  });
  internalUrl = `http://127.0.0.1:${(internalServer.address() as AddressInfo).port}`;

  // Spawn fetch servers via MCP SDK: one with the host-set opt-in, one without.
  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [fetchServerPath],
    env: { ...getDefaultEnvironment(), [FETCH_ALLOW_PRIVATE_NETWORKS_ENV]: '1' },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    clientStderr += chunk.toString();
  });
  client = new Client({ name: 'test-client', version: '1.0.0' });

  const strictTransport = new StdioClientTransport({
    command: tsxBin,
    args: [fetchServerPath],
    env: { ...getDefaultEnvironment(), [FETCH_ALLOW_PRIVATE_NETWORKS_ENV]: '0' },
    stderr: 'pipe',
  });
  strictTransport.stderr?.on('data', (chunk: Buffer) => {
    strictStderr += chunk.toString();
  });
  strictClient = new Client({ name: 'test-client-strict', version: '1.0.0' });

  await Promise.all([client.connect(transport), strictClient.connect(strictTransport)]);
}, 30_000);

afterAll(async () => {
  await Promise.all([client.close(), strictClient.close()]);
  // Force-close any lingering connections (e.g. the never-responding /slow
  // request) so the server socket actually releases and doesn't keep the event
  // loop alive past teardown.
  httpServer.closeAllConnections();
  internalServer.closeAllConnections();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await new Promise<void>((resolve) => internalServer.close(() => resolve()));
});

/** Extracts the text content from an MCP tool call result. */
function resultText(result: Awaited<ReturnType<typeof client.callTool>>): string {
  return (result.content as { text: string }[])[0].text;
}

interface FetchResult {
  status: number;
  url: string;
  redirects: { status: number; url: string; location: string }[];
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  redirect?: { location: string; followed: boolean; reason: string };
  binary?: { contentType: string | null; size: number | null };
}

interface FetchErrorResult {
  error: string;
  code?: string;
  url?: string;
  redirects?: { status: number; url: string; location: string }[];
  location?: string;
}

function resultJson(result: Awaited<ReturnType<typeof client.callTool>>): FetchResult {
  if (result.isError) {
    throw new Error(`Expected success but got error: ${resultText(result)}`);
  }
  return JSON.parse(resultText(result)) as FetchResult;
}

function errorJson(result: Awaited<ReturnType<typeof client.callTool>>): FetchErrorResult {
  if (!result.isError) {
    throw new Error(`Expected an error but got: ${resultText(result)}`);
  }
  return JSON.parse(resultText(result)) as FetchErrorResult;
}

describe('fetch-server', () => {
  describe('tool schema', () => {
    it('lists both http_fetch and web_search tools', async () => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toContain('http_fetch');
      expect(tools.map((t) => t.name)).toContain('web_search');
    });

    it('web_search has query and max_results parameters', async () => {
      const { tools } = await client.listTools();
      const webSearch = tools.find((t) => t.name === 'web_search')!;
      const schema = webSearch.inputSchema as { properties: Record<string, unknown>; required: string[] };
      expect(schema.properties).toHaveProperty('query');
      expect(schema.properties).toHaveProperty('max_results');
      expect(schema.required).toContain('query');
    });

    it('exposes format enum and timeout parameter', async () => {
      const { tools } = await client.listTools();
      const httpFetch = tools.find((t) => t.name === 'http_fetch')!;
      const schema = httpFetch.inputSchema as { properties: Record<string, unknown> };

      expect(schema.properties).toHaveProperty('format');
      const format = schema.properties.format as Record<string, unknown>;
      expect(format.enum).toEqual(['markdown', 'text', 'html']);
      expect(format.default).toBe('markdown');

      expect(schema.properties).toHaveProperty('timeout');
      const timeout = schema.properties.timeout as Record<string, unknown>;
      expect(timeout.type).toBe('number');
      expect(timeout.default).toBe(30);

      // raw_html should be gone
      expect(schema.properties).not.toHaveProperty('raw_html');
    });
  });

  describe('format parameter', () => {
    it('converts HTML to markdown by default', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html` },
      });
      const json = resultJson(result);
      expect(json.status).toBe(200);
      expect(json.body).toContain('# Hello World');
      expect(json.body).toContain('**test**');
      // Boilerplate should be stripped by turndown.remove()
      expect(json.body).not.toContain('var x = 1');
      expect(json.body).not.toContain('Copyright 2026');
      expect(json.body).not.toContain('Sidebar content');
    });

    it('returns raw HTML with format=html', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html`, format: 'html' },
      });
      const json = resultJson(result);
      expect(json.body).toContain('<!DOCTYPE html>');
      expect(json.body).toContain('<h1>Hello World</h1>');
      expect(json.body).toContain('<script>var x = 1;</script>');
    });

    it('returns plain text with format=text, stripping tags and boilerplate', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html`, format: 'text' },
      });
      const json = resultJson(result);
      // Should contain visible text
      expect(json.body).toContain('Hello World');
      expect(json.body).toContain('test');
      // Script/style/nav/footer/aside content should be stripped
      expect(json.body).not.toContain('var x = 1');
      expect(json.body).not.toContain('.hidden');
      expect(json.body).not.toContain('Copyright 2026');
      expect(json.body).not.toContain('Sidebar content');
      // Should not contain HTML tags
      expect(json.body).not.toContain('<h1>');
      expect(json.body).not.toContain('<p>');
    });

    it('decodes HTML entities in text mode', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html`, format: 'text' },
      });
      const json = resultJson(result);
      expect(json.body).toContain('&');
      expect(json.body).not.toContain('&amp;');
    });

    it('passes non-HTML through unchanged in markdown mode', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/plain` },
      });
      const json = resultJson(result);
      expect(json.body).toContain('Plain text response');
    });
  });

  describe('timeout parameter', () => {
    it('times out with short timeout on slow endpoint', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/slow`, timeout: 1 },
      });
      expect(result.isError).toBe(true);
      const errorJson = JSON.parse(resultText(result)) as { error: string };
      expect(errorJson.error).toMatch(/abort/i);
    }, 10_000);
  });

  describe('boilerplate stripping', () => {
    it('removes nav, footer, aside, script, style in markdown mode', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html` },
      });
      const json = resultJson(result);
      // nav link should be gone
      expect(json.body).not.toContain('Home');
      // script content should be gone
      expect(json.body).not.toContain('var x');
      // style content should be gone
      expect(json.body).not.toContain('.hidden');
    });
  });

  describe('max_length truncation', () => {
    it('truncates output and appends marker', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html`, max_length: 50 },
      });
      const json = resultJson(result);
      expect(json.body).toContain('[Truncated]');
      expect(json.truncated).toBe(true);
    });
  });

  describe('readability extraction', () => {
    it('extracts article content and strips boilerplate in markdown mode', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/article`, max_length: 50000 },
      });
      const json = resultJson(result);
      // Article content should be present
      expect(json.body).toContain('perovskite-silicon tandem cells');
      expect(json.body).toContain('Dr. Maria Chen');
      // Boilerplate should be stripped
      expect(json.body).not.toContain('ADVERTISEMENT');
      expect(json.body).not.toContain('cookie');
      expect(json.body).not.toContain('Related Articles');
      expect(json.body).not.toContain('Privacy Policy');
    });

    it('includes metadata header when readability succeeds', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/article`, max_length: 50000 },
      });
      const json = resultJson(result);
      expect(json.body).toContain('Title: Breaking Discovery in Solar Energy');
    });

    it('uses readability textContent for text format', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/article`, format: 'text', max_length: 50000 },
      });
      const json = resultJson(result);
      // Should have article content as plain text
      expect(json.body).toContain('perovskite-silicon tandem cells');
      expect(json.body).toContain('Title: Breaking Discovery in Solar Energy');
      // Should not have HTML tags
      expect(json.body).not.toContain('<p>');
      expect(json.body).not.toContain('<h1>');
      // Boilerplate should be stripped
      expect(json.body).not.toContain('ADVERTISEMENT');
      expect(json.body).not.toContain('cookie');
    });

    it('falls back to turndown for non-article pages', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html` },
      });
      const json = resultJson(result);
      // Should still work via turndown fallback
      expect(json.body).toContain('Hello World');
    });

    it('skips readability for HTML over 1MB and falls back to turndown', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/large-html`, max_length: 50000 },
      });
      const json = resultJson(result);
      // Content should still be present via turndown fallback
      expect(json.body).toContain('Large Article');
      // No readability metadata header since extraction was skipped
      expect(json.body).not.toContain('Title:');
    });

    it('skips readability when element count exceeds limit', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/many-elements`, max_length: 50000 },
      });
      const json = resultJson(result);
      // Content should still be present via turndown fallback
      expect(json.body).toContain('Element Heavy');
      // No readability metadata header since maxElemsToParse was exceeded
      expect(json.body).not.toContain('Title:');
    });
  });

  describe('result metadata and request headers', () => {
    it('reports the final URL and an empty redirect chain for a direct response', async () => {
      const json = resultJson(await client.callTool({ name: 'http_fetch', arguments: { url: `${baseUrl}/plain` } }));
      expect(json.url).toBe(`${baseUrl}/plain`);
      expect(json.redirects).toEqual([]);
      expect(json.redirect).toBeUndefined();
    });

    it('sends agent headers but always its own User-Agent, whatever spelling the agent uses', async () => {
      const json = resultJson(
        await client.callTool({
          name: 'http_fetch',
          arguments: { url: `${baseUrl}/echo-headers`, headers: { 'user-agent': 'spoofed', 'X-Custom': 'kept' } },
        }),
      );
      const echoed = JSON.parse(json.body) as Record<string, string>;
      expect(echoed['user-agent']).toMatch(/^IronCurtain\//u);
      expect(echoed['x-custom']).toBe('kept');
    });

    it('rejects a headers argument that is not an object of strings', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/plain`, headers: { 'X-Count': 3 } },
      });
      expect(errorJson(result).error).toMatch(/Invalid headers/u);
    });

    it('refuses non-HTTP schemes', async () => {
      const result = await client.callTool({ name: 'http_fetch', arguments: { url: 'file:///etc/passwd' } });
      expect(errorJson(result).code).toBe('INVALID_URL');
    });
  });

  describe('redirects', () => {
    it('returns a cross-origin redirect to an internal service instead of following it', async () => {
      const json = resultJson(
        await client.callTool({
          name: 'http_fetch',
          arguments: { url: `${baseUrl}/redirect-internal`, headers: { 'Metadata-Flavor': 'Google' } },
        }),
      );
      const target = `${internalUrl}/latest/meta-data/iam/security-credentials/`;
      expect(json.status).toBe(302);
      expect(json.url).toBe(`${baseUrl}/redirect-internal`);
      expect(json.body).toBe('');
      expect(json.redirect).toEqual({ location: target, followed: false, reason: 'cross-origin' });
      expect(json.headers.location).toBe(target);
      expect(internalHits).toBe(0);
    });

    it('does not follow a redirect to 169.254.169.254, and refuses it when requested directly', async () => {
      const json = resultJson(
        await client.callTool({ name: 'http_fetch', arguments: { url: `${baseUrl}/redirect-metadata` } }),
      );
      expect(json.status).toBe(302);
      expect(json.redirect?.location).toBe('http://169.254.169.254/latest/meta-data/');

      // Following it is a new, policy-evaluated call, and the address guard
      // refuses the metadata address even with the private-network opt-in.
      const direct = errorJson(
        await client.callTool({ name: 'http_fetch', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } }),
      );
      expect(direct.code).toBe('DESTINATION_NOT_ALLOWED');
    });

    it('refuses metadata endpoints inside the private ranges the opt-in admits', async () => {
      for (const url of ['http://[fd20:ce::254]/computeMetadata/v1/', 'http://[fd00:ec2::23]/']) {
        const error = errorJson(await client.callTool({ name: 'http_fetch', arguments: { url, timeout: 2 } }));
        expect(error.code).toBe('DESTINATION_NOT_ALLOWED');
      }
    });

    it('follows five same-origin redirects and reports the chain', async () => {
      const json = resultJson(await client.callTool({ name: 'http_fetch', arguments: { url: `${baseUrl}/chain/5` } }));
      expect(json.status).toBe(200);
      expect(json.body).toContain('end of chain');
      expect(json.url).toBe(`${baseUrl}/chain/0`);
      expect(json.redirects.map((hop) => hop.location)).toEqual(
        [4, 3, 2, 1, 0].map((remaining) => `${baseUrl}/chain/${remaining}`),
      );
    });

    it('refuses a sixth same-origin redirect', async () => {
      const error = errorJson(await client.callTool({ name: 'http_fetch', arguments: { url: `${baseUrl}/chain/6` } }));
      expect(error.code).toBe('REDIRECT_LIMIT');
      expect(error.redirects).toHaveLength(5);
      expect(error.location).toBe(`${baseUrl}/chain/0`);
    });
  });

  describe('private destinations without the opt-in (default)', () => {
    it('refuses a loopback IP literal', async () => {
      const error = errorJson(
        await strictClient.callTool({ name: 'http_fetch', arguments: { url: `${baseUrl}/html` } }),
      );
      expect(error.code).toBe('DESTINATION_NOT_ALLOWED');
    });

    it('refuses a hostname that resolves to loopback', async () => {
      const error = errorJson(
        await strictClient.callTool({ name: 'http_fetch', arguments: { url: `http://localhost:${port}/html` } }),
      );
      expect(error.code).toBe('DESTINATION_NOT_ALLOWED');
    });

    it('refuses the internal service even when asked for it directly', async () => {
      const error = errorJson(
        await strictClient.callTool({ name: 'http_fetch', arguments: { url: `${internalUrl}/latest/meta-data/` } }),
      );
      expect(error.code).toBe('DESTINATION_NOT_ALLOWED');
      expect(internalHits).toBe(0);
    });

    it('announces the opt-in on stderr only when it is enabled', () => {
      expect(clientStderr).toContain('allowPrivateNetworks is enabled');
      expect(strictStderr).not.toContain('allowPrivateNetworks is enabled');
    });
  });

  describe('charset-aware decoding', () => {
    it('decodes an ISO-8859-1 page by its Content-Type charset', async () => {
      const json = resultJson(await client.callTool({ name: 'http_fetch', arguments: { url: `${baseUrl}/latin1` } }));
      expect(json.body).toContain(LATIN1_TEXT);
      expect(json.body).not.toContain('�');
    });

    it('decodes by the <meta charset> declaration when the header has no charset', async () => {
      const json = resultJson(
        await client.callTool({ name: 'http_fetch', arguments: { url: `${baseUrl}/latin1-meta`, format: 'text' } }),
      );
      expect(json.body).toContain(LATIN1_TEXT);
    });

    it('decodes plain text by a quoted charset parameter', async () => {
      const json = resultJson(
        await client.callTool({ name: 'http_fetch', arguments: { url: `${baseUrl}/latin1-plain` } }),
      );
      expect(json.body).toBe(LATIN1_TEXT);
    });

    it('treats application/xhtml+xml as HTML', async () => {
      const json = resultJson(await client.callTool({ name: 'http_fetch', arguments: { url: `${baseUrl}/xhtml` } }));
      expect(json.body).toContain('# XHTML Heading');
      expect(json.body).not.toContain('var leaked');
      expect(json.body).not.toContain('<h1>');
    });
  });

  describe('binary responses', () => {
    it('returns metadata instead of a decoded body for an image', async () => {
      const json = resultJson(await client.callTool({ name: 'http_fetch', arguments: { url: `${baseUrl}/png` } }));
      expect(json.status).toBe(200);
      expect(json.body).toBe('');
      expect(json.truncated).toBe(false);
      expect(json.binary).toEqual({ contentType: 'image/png', size: PNG_BYTES.length });
    });

    it('sniffs application/octet-stream: binary bytes give metadata', async () => {
      const json = resultJson(
        await client.callTool({ name: 'http_fetch', arguments: { url: `${baseUrl}/octet-binary` } }),
      );
      expect(json.body).toBe('');
      expect(json.binary).toEqual({ contentType: 'application/octet-stream', size: 6 });
    });

    it('sniffs application/octet-stream: text bytes come back as text', async () => {
      const json = resultJson(
        await client.callTool({ name: 'http_fetch', arguments: { url: `${baseUrl}/octet-text` } }),
      );
      expect(json.binary).toBeUndefined();
      expect(json.body).toBe('plain words served as octet-stream');
    });
  });

  describe('web_search tool', () => {
    it('returns helpful error when no provider configured', async () => {
      // The test fetch server is spawned without WEB_SEARCH_PROVIDER env var
      const result = await client.callTool({
        name: 'web_search',
        arguments: { query: 'test query' },
      });
      expect(result.isError).toBe(true);
      const text = resultText(result);
      expect(text).toContain('not configured');
    });

    it('returns error when query is missing', async () => {
      const result = await client.callTool({
        name: 'web_search',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Missing required parameter: query');
    });
  });
});

describe('stripHtmlFallback', () => {
  it('strips simple boilerplate tags and their content', () => {
    const html = '<p>Hello</p><script>alert(1)</script><p>World</p>';
    expect(stripHtmlFallback(html)).toBe('HelloWorld');
  });

  it('handles nested script tag bypass attempt', () => {
    // After one pass: "<script>alert(1)</script>" — the loop catches this
    const html = '<scri<script>inner</script>pt>alert(1)</script>';
    const result = stripHtmlFallback(html);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert(1)');
  });

  it('handles nested style tag bypass attempt', () => {
    const html = '<sty<style>.x{}</style>le>body{display:none}</style><p>visible</p>';
    const result = stripHtmlFallback(html);
    expect(result).not.toContain('<style');
    expect(result).not.toContain('display:none');
    expect(result).toContain('visible');
  });

  it('handles nested iframe tag bypass attempt', () => {
    const html = '<ifra<iframe src="x"></iframe>me src="evil"></iframe><p>safe</p>';
    const result = stripHtmlFallback(html);
    expect(result).not.toContain('<iframe');
    expect(result).not.toContain('evil');
    expect(result).toContain('safe');
  });

  it('decodes HTML entities', () => {
    const html = '<p>A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39;</p>';
    expect(stripHtmlFallback(html)).toBe('A & B < C > D "E" \'F\'');
  });

  it('collapses whitespace', () => {
    const html = '<p>  lots   of   space  </p>';
    expect(stripHtmlFallback(html)).toBe('lots of space');
  });
});
