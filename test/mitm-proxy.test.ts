import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as crypto from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLeafSecureContextCache, loadOrCreateCA, type CertificateAuthority } from '../src/docker/ca.js';
import { createMitmProxy, type MitmProxy, type MitmProxyOptions, type TunnelDialer } from '../src/docker/mitm-proxy.js';
import type { OAuthTokenManager } from '../src/docker/oauth-token-manager.js';
import { buildClientHelloRecord, encodeExtension } from './helpers/tls-client-hello-fixture.js';
import {
  anthropicProvider,
  anthropicRequestRewriter,
  codexChatGptProvider,
  googleProvider,
  isEndpointAllowed,
  stripScheduleSkillTools,
  stripScheduleSkillToolReferences,
  shouldRewriteBody,
  type AgentKind,
  type ProviderConfig,
} from '../src/docker/provider-config.js';
import type { RegistryConfig } from '../src/docker/package-types.js';
import { DENY_ALL_VALIDATOR, createPackageValidator } from '../src/docker/package-validator.js';
import { generateFakeKey } from '../src/docker/fake-keys.js';
import type { DestinationBoundRequest, OutboundTransport } from '../src/docker/outbound-transport.js';
import { createRegistryEgressGuard } from '../src/docker/registry-egress-proxy.js';
import { createTrajectoryCaptureWriter } from '../src/docker/trajectory-capture.js';
import type { SessionId } from '../src/session/types.js';
import * as logger from '../src/logger.js';

// Mock node:https so a single test can observe the upstream target of a
// registry forward. The default wraps the real implementation (call-through),
// so every other TLS test in this file behaves exactly as before; only the
// Debian-upstream-port test installs a one-shot override via mockImplementationOnce.
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: vi.fn(actual.request) };
});

// --- Test helpers ---

/**
 * Waits for a condition to become true by polling on the microtask queue.
 * Much faster than a fixed setTimeout when waiting for async events to propagate.
 */
function waitFor(
  condition: () => boolean,
  { timeoutMs = 500, intervalMs = 1 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (condition()) {
      resolve();
      return;
    }
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
      if (condition()) {
        resolve();
      } else if (Date.now() > deadline) {
        reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      } else {
        setTimeout(check, intervalMs);
      }
    };
    setTimeout(check, intervalMs);
  });
}

/** DNS lookup that resolves all hostnames to 127.0.0.1 for testing. */
const localhostDnsLookup: MitmProxyOptions['dnsLookup'] = (_hostname, opts, cb) => {
  if ((opts as { all?: boolean }).all) {
    cb(null, [{ address: '127.0.0.1', family: 4 }] as never);
  } else {
    cb(null, '127.0.0.1', 4);
  }
};

/**
 * Transport that delivers every destination-bound request to a local fixture
 * on 127.0.0.1:`port`. A passthrough approval can only name port 443 or 80,
 * so plain-HTTP passthrough tests approve `host:80` and let this transport
 * stand in for the real upstream. Records what the proxy asked for.
 */
function localUpstreamTransport(port: number, received: DestinationBoundRequest[] = []): OutboundTransport {
  return {
    kind: 'direct',
    addressGuard: 'local-resolver',
    request(request, onResponse) {
      received.push(request);
      return http.request(
        { hostname: '127.0.0.1', port, method: request.method, path: request.path, headers: request.headers },
        onResponse,
      );
    },
  };
}

/** Raw-tunnel dialer that reaches a local fixture instead of `host:port`, recording every dial. */
function localTunnelDialer(port: number, dials: net.TcpNetConnectOpts[] = []): TunnelDialer {
  return (options) => {
    dials.push(options);
    return net.connect({ host: '127.0.0.1', port });
  };
}

/** Dialer that must never be reached; records the attempt and returns a socket that never connects. */
function unreachableTunnelDialer(dials: net.TcpNetConnectOpts[]): TunnelDialer {
  return (options) => {
    dials.push(options);
    return new net.Socket();
  };
}

/**
 * Writes one raw CONNECT line, so malformed authorities reach the proxy
 * verbatim, and returns the status code of the first response line.
 */
function rawConnectStatus(socketPath: string, authority: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    let data = '';
    socket.setEncoding('latin1');
    socket.on('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: proxy.invalid\r\n\r\n`);
    });
    socket.on('data', (chunk: string) => {
      data += chunk;
      const lineEnd = data.indexOf('\r\n');
      if (lineEnd !== -1) {
        const status = Number(data.slice(0, lineEnd).split(' ')[1]);
        socket.destroy();
        resolve(status);
      }
    });
    socket.on('error', reject);
    socket.on('close', () => reject(new Error(`no status line for CONNECT ${authority}`)));
  });
}

/** Starts a TLS handshake over an acknowledged tunnel; resolves on success, rejects when the tunnel is refused. */
function tlsHandshake(socket: net.Socket, servername: string, caPem: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername, ca: caPem }, () => resolve(tlsSocket));
    tlsSocket.once('error', reject);
    tlsSocket.once('close', () => reject(new Error('tunnel closed before the TLS handshake completed')));
  });
}

/** Writes bytes into an acknowledged tunnel and resolves with whatever came back before the tunnel closed. */
function relayThroughTunnel(socket: net.Socket, bytes: Buffer | string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('tunnel neither relayed nor closed')), timeoutMs);
    let data = '';
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(timeout);
      resolve(data);
    });
    socket.write(bytes);
  });
}

/**
 * A local HTTPS origin presenting IronCurtain-CA-signed leaf certificates for
 * whatever SNI the client sends: the stand-in for an approved `host:443`
 * behind the SNI-pinned raw tunnel.
 */
async function createLocalTlsOrigin(ca: CertificateAuthority): Promise<{ port: number; close(): Promise<void> }> {
  const leafContext = createLeafSecureContextCache(ca);
  const server = https.createServer({ SNICallback: (name, cb) => cb(null, leafContext(name)) }, (req, res) => {
    // An explicit length keeps the body unchunked for the raw parsers below.
    const body = JSON.stringify({ sni: (req.socket as tls.TLSSocket).servername, path: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as import('node:net').AddressInfo).port);
    });
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Sends a CONNECT request to the proxy via UDS, returns client socket + status. */
function sendConnect(
  socketPath: string,
  host: string,
  port: number,
): Promise<{ socket: import('node:net').Socket | null; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      method: 'CONNECT',
      path: `${host}:${port}`,
    });

    req.on('connect', (res, socket) => {
      resolve({ socket, statusCode: res.statusCode ?? 0 });
    });

    req.on('error', reject);

    req.on('response', (res) => {
      resolve({ socket: null, statusCode: res.statusCode ?? 0 });
    });

    req.end();
  });
}

/**
 * Performs a TLS handshake on an already-CONNECT'd socket,
 * then sends an HTTP request over it.
 */
function makeHttpsRequest(
  socket: import('node:net').Socket,
  ca: CertificateAuthority,
  host: string,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect(
      {
        socket,
        servername: host,
        ca: ca.certPem,
      },
      () => {
        const method = options.method ?? 'GET';
        const path = options.path ?? '/';
        const headers: Record<string, string> = {
          host,
          connection: 'close',
          ...options.headers,
        };

        if (options.body) {
          headers['content-length'] = Buffer.byteLength(options.body).toString();
        }

        const headerLines = Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n');
        const reqStr = `${method} ${path} HTTP/1.1\r\n${headerLines}\r\n\r\n`;
        tlsSocket.write(reqStr);
        if (options.body) tlsSocket.write(options.body);

        // Parse response manually
        let data = '';
        tlsSocket.on('data', (chunk) => {
          data += chunk.toString();
        });
        tlsSocket.on('end', () => {
          const [headerSection, ...bodyParts] = data.split('\r\n\r\n');
          const statusLine = headerSection.split('\r\n')[0];
          const statusCode = parseInt(statusLine.split(' ')[1], 10);
          const responseHeaders: Record<string, string> = {};
          for (const line of headerSection.split('\r\n').slice(1)) {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
              responseHeaders[line.substring(0, colonIdx).toLowerCase().trim()] = line.substring(colonIdx + 1).trim();
            }
          }
          resolve({
            statusCode,
            headers: responseHeaders,
            body: bodyParts.join('\r\n\r\n'),
          });
        });
        tlsSocket.on('error', reject);
      },
    );
    tlsSocket.on('error', reject);
  });
}

/**
 * Performs a TLS handshake on an already-CONNECT'd socket, writes `raw`
 * verbatim (for requests the HTTP client would not send, such as a chunked body
 * with hand-written headers) and resolves with everything read until the
 * server closes.
 */
function rawHttpsExchange(
  socket: import('node:net').Socket,
  ca: CertificateAuthority,
  host: string,
  raw: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: host, ca: ca.certPem }, () => {
      tlsSocket.write(raw);
    });
    let data = '';
    tlsSocket.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    tlsSocket.on('end', () => resolve(data));
    tlsSocket.on('error', reject);
  });
}

// --- Tests ---

describe('isEndpointAllowed', () => {
  const config: ProviderConfig = {
    host: 'api.example.com',
    displayName: 'Example',
    allowedEndpoints: [
      { method: 'POST', path: '/v1/messages' },
      { method: 'GET', path: '/v1/models' },
      { method: 'POST', path: '/v1beta/models/*/generateContent' },
    ],
    keyInjection: { type: 'header', headerName: 'x-api-key' },
    fakeKeyPrefix: 'test-',
  };

  it('allows exact match', () => {
    expect(isEndpointAllowed(config, 'POST', '/v1/messages')).toBe(true);
  });

  it('allows exact match with query string stripped', () => {
    expect(isEndpointAllowed(config, 'POST', '/v1/messages?foo=bar')).toBe(true);
  });

  it('blocks wrong method', () => {
    expect(isEndpointAllowed(config, 'GET', '/v1/messages')).toBe(false);
  });

  it('blocks unlisted path', () => {
    expect(isEndpointAllowed(config, 'POST', '/v1/other')).toBe(false);
  });

  it('allows glob pattern match', () => {
    expect(isEndpointAllowed(config, 'POST', '/v1beta/models/gemini-pro/generateContent')).toBe(true);
  });

  it('blocks glob with extra segments', () => {
    expect(isEndpointAllowed(config, 'POST', '/v1beta/models/a/b/generateContent')).toBe(false);
  });

  it('returns false for undefined method or path', () => {
    expect(isEndpointAllowed(config, undefined, '/v1/messages')).toBe(false);
    expect(isEndpointAllowed(config, 'POST', undefined)).toBe(false);
  });

  // MITM-23: the path is forwarded verbatim, so a glob must not match anything
  // an upstream could normalize or decode into another route.
  it.each([
    '/api/eval/..',
    '/api/eval/.',
    '/api/eval/...',
    '/api/eval/%2e%2e',
    '/api/eval/%2E%2E',
    '/api/eval/..%2F..%2Fv1%2Ffiles',
    '/api/eval/sdk%2fx',
    '/api/eval/sdk%5c..',
    '/api/eval/sdk\\..',
    '/api/eval/sdk;x=..',
    '/api/eval/sdk#fragment',
    '/api/eval/sdk%252e%252e',
  ])('a glob segment never matches %s', (path) => {
    expect(isEndpointAllowed(anthropicProvider, 'POST', path)).toBe(false);
  });

  it.each([
    '/v1beta/models/..%2F..%2Fx:generateContent',
    '/v1beta/models/..:generateContent',
    '/v1beta/models/.:streamGenerateContent',
    '/v1beta/models/gemini%2D2.5-pro:generateContent',
    '/v1beta/models/gemini\\x:generateContent',
  ])('the Gemini wildcard never matches %s', (path) => {
    expect(isEndpointAllowed(googleProvider, 'POST', path)).toBe(false);
  });

  it('a glob segment still matches ids with dots, dashes, underscores and tildes', () => {
    expect(isEndpointAllowed(googleProvider, 'POST', '/v1beta/models/gemini-2.5-pro:generateContent')).toBe(true);
    expect(
      isEndpointAllowed(googleProvider, 'POST', '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'),
    ).toBe(true);
    expect(isEndpointAllowed(anthropicProvider, 'POST', '/api/eval/sdk-AbC123_x.y~z')).toBe(true);
  });

  it('exact patterns never match dot segments or encoded variants', () => {
    for (const path of ['/v1/./messages', '/v1/%2e/messages', '/v1/x/../messages', '/v1//messages', '/v1/messages/']) {
      expect(isEndpointAllowed(anthropicProvider, 'POST', path), path).toBe(false);
    }
  });
});

// Provider-defined (server-side) tool stripping moved from the request
// rewriter to the anthropic-messages request sanitizer; its tool-allowlist
// cases live in test/docker/request-sanitizer-anthropic.test.ts.

describe('stripScheduleSkillTools', () => {
  it('returns null when body has no tools field', () => {
    expect(stripScheduleSkillTools({ model: 'claude-3', messages: [] })).toBeNull();
  });

  it('returns null when tools array is empty', () => {
    expect(stripScheduleSkillTools({ tools: [] })).toBeNull();
  });

  it('returns null when no tool name matches the schedule skill set', () => {
    const body = {
      tools: [
        { name: 'read_file', input_schema: {} },
        { name: 'Bash', input_schema: {} },
        { name: 'Skill', input_schema: {} },
      ],
    };
    expect(stripScheduleSkillTools(body)).toBeNull();
  });

  it('strips ScheduleWakeup and the Cron tool family by name', () => {
    const body = {
      model: 'claude-3',
      tools: [
        { name: 'Read', input_schema: {} },
        { name: 'ScheduleWakeup', input_schema: {} },
        { name: 'CronCreate', input_schema: {} },
        { name: 'CronList', input_schema: {} },
        { name: 'CronDelete', input_schema: {} },
        { name: 'Bash', input_schema: {} },
      ],
    };
    const result = stripScheduleSkillTools(body);
    expect(result).not.toBeNull();
    expect(result!.modified.tools).toEqual([
      { name: 'Read', input_schema: {} },
      { name: 'Bash', input_schema: {} },
    ]);
    expect(result!.stripped).toEqual(['ScheduleWakeup', 'CronCreate', 'CronList', 'CronDelete']);
    expect(result!.modified.model).toBe('claude-3');
  });

  it('strips only schedule tools and leaves server-side tools alone', () => {
    // stripScheduleSkillTools is name-keyed; server-side tools (no `name`,
    // identified by `type`) are out of its remit and must pass through.
    const body = {
      tools: [{ name: 'ScheduleWakeup', input_schema: {} }, { type: 'web_search_20250305' }],
    };
    const result = stripScheduleSkillTools(body);
    expect(result).not.toBeNull();
    expect(result!.modified.tools).toEqual([{ type: 'web_search_20250305' }]);
    expect(result!.stripped).toEqual(['ScheduleWakeup']);
  });

  it('does not strip tools whose name happens to be similar but not exact', () => {
    const body = {
      tools: [
        { name: 'schedulewakeup', input_schema: {} }, // case-sensitive
        { name: 'ScheduleWakeupExtra', input_schema: {} },
        { name: 'Cron', input_schema: {} },
      ],
    };
    expect(stripScheduleSkillTools(body)).toBeNull();
  });
});

describe('stripScheduleSkillToolReferences', () => {
  /** Reach into a single-message, single-block fixture's tool_result.content. */
  function innerOf(result: { modified: Record<string, unknown> }): Array<Record<string, unknown>> {
    const msg = (result.modified.messages as Array<Record<string, unknown>>)[0];
    const block = (msg.content as Array<Record<string, unknown>>)[0];
    return block.content as Array<Record<string, unknown>>;
  }

  it('returns null when body has no messages field', () => {
    expect(stripScheduleSkillToolReferences({ model: 'claude-3' })).toBeNull();
  });

  it('returns null when messages array is empty', () => {
    expect(stripScheduleSkillToolReferences({ messages: [] })).toBeNull();
  });

  it('returns null when no tool_result references stripped tools', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_abc',
              content: [
                { type: 'tool_reference', tool_name: 'TodoWrite' },
                { type: 'tool_reference', tool_name: 'TaskOutput' },
              ],
            },
          ],
        },
      ],
    };
    expect(stripScheduleSkillToolReferences(body)).toBeNull();
  });

  it('drops tool_reference entries for schedule-skill tool names', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_abc',
              content: [
                { type: 'tool_reference', tool_name: 'TaskOutput' },
                { type: 'tool_reference', tool_name: 'CronCreate' },
                { type: 'tool_reference', tool_name: 'ScheduleWakeup' },
                { type: 'tool_reference', tool_name: 'TodoWrite' },
              ],
            },
          ],
        },
      ],
    };
    const result = stripScheduleSkillToolReferences(body);
    expect(result).not.toBeNull();
    expect(result!.stripped).toEqual(['tool_reference:CronCreate', 'tool_reference:ScheduleWakeup']);
    expect(innerOf(result!)).toEqual([
      { type: 'tool_reference', tool_name: 'TaskOutput' },
      { type: 'tool_reference', tool_name: 'TodoWrite' },
    ]);
  });

  it('substitutes a placeholder when every entry was stripped', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_abc',
              content: [
                { type: 'tool_reference', tool_name: 'CronCreate' },
                { type: 'tool_reference', tool_name: 'CronDelete' },
              ],
            },
          ],
        },
      ],
    };
    const result = stripScheduleSkillToolReferences(body);
    expect(result).not.toBeNull();
    expect(innerOf(result!)).toEqual([{ type: 'text', text: '(filtered)' }]);
  });

  it('removes <function> schema blocks naming stripped tools from text content', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_abc',
              content: [
                {
                  type: 'text',
                  text:
                    '<functions>\n' +
                    '<function>{"description":"Sched","name":"CronCreate","parameters":{}}</function>\n' +
                    '<function>{"description":"Todos","name":"TodoWrite","parameters":{}}</function>\n' +
                    '</functions>',
                },
              ],
            },
          ],
        },
      ],
    };
    const result = stripScheduleSkillToolReferences(body);
    expect(result).not.toBeNull();
    expect(result!.stripped).toEqual(['function_block:CronCreate']);
    const innerContent = innerOf(result!);
    expect(innerContent).toHaveLength(1);
    expect((innerContent[0] as { text: string }).text).not.toContain('CronCreate');
    expect((innerContent[0] as { text: string }).text).toContain('TodoWrite');
  });

  it('leaves non-tool_result content blocks untouched', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'CronCreate is a tool I read about.' }],
        },
      ],
    };
    expect(stripScheduleSkillToolReferences(body)).toBeNull();
  });

  it('leaves messages with string content untouched', () => {
    const body = { messages: [{ role: 'user', content: 'plain string content' }] };
    expect(stripScheduleSkillToolReferences(body)).toBeNull();
  });

  // ToolSearch keyword-match result that wedged a workflow: the CronCreate
  // tool_reference survives in history even though the tools array no
  // longer contains it, so Anthropic 400s the next request.
  it('strips CronCreate from a real-world ToolSearch tool_result fixture', () => {
    const body = {
      model: 'claude-opus-4-7',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01SxC1QRJq1rNG6vRLtQ1gVM',
              content: [
                { type: 'tool_reference', tool_name: 'TaskOutput' },
                { type: 'tool_reference', tool_name: 'TaskStop' },
                { type: 'tool_reference', tool_name: 'Monitor' },
                { type: 'tool_reference', tool_name: 'TodoWrite' },
                { type: 'tool_reference', tool_name: 'CronCreate' },
              ],
            },
          ],
        },
      ],
    };
    const result = stripScheduleSkillToolReferences(body);
    expect(result).not.toBeNull();
    expect(result!.stripped).toEqual(['tool_reference:CronCreate']);
    const serialized = JSON.stringify(result!.modified);
    expect(serialized).not.toContain('CronCreate');
    expect(serialized).toContain('TaskOutput');
    expect(serialized).toContain('TaskStop');
    expect(serialized).toContain('Monitor');
    expect(serialized).toContain('TodoWrite');
  });
});

describe('anthropicRequestRewriter', () => {
  const ctx = (agentKind?: AgentKind) => ({
    method: 'POST',
    path: '/v1/messages',
    agentKind,
  });

  it('leaves provider-defined tools to the request sanitizer regardless of agentKind', () => {
    const body = {
      tools: [{ name: 'Read', input_schema: {} }, { type: 'web_search_20250305' }],
    };
    for (const kind of ['batch', 'workflow', 'pty', undefined] as const) {
      expect(anthropicRequestRewriter(body, ctx(kind)), `agentKind=${String(kind)}`).toBeNull();
    }
  });

  it.each(['pty', undefined] as const)('does NOT strip schedule skill tools when agentKind is %s', (agentKind) => {
    const body = {
      tools: [
        { name: 'Read', input_schema: {} },
        { name: 'ScheduleWakeup', input_schema: {} },
      ],
    };
    expect(anthropicRequestRewriter(body, ctx(agentKind))).toBeNull();
  });

  it('strips schedule skill tools when agentKind is batch', () => {
    const body = {
      tools: [
        { name: 'Read', input_schema: {} },
        { name: 'ScheduleWakeup', input_schema: {} },
        { name: 'CronCreate', input_schema: {} },
      ],
    };
    const result = anthropicRequestRewriter(body, ctx('batch'));
    expect(result).not.toBeNull();
    expect(result!.modified.tools).toEqual([{ name: 'Read', input_schema: {} }]);
    expect(result!.stripped).toEqual(['ScheduleWakeup', 'CronCreate']);
  });

  it('strips schedule skill tools when agentKind is workflow', () => {
    const body = {
      tools: [
        { name: 'Read', input_schema: {} },
        { name: 'ScheduleWakeup', input_schema: {} },
        { name: 'CronCreate', input_schema: {} },
      ],
    };
    const result = anthropicRequestRewriter(body, ctx('workflow'));
    expect(result).not.toBeNull();
    expect(result!.modified.tools).toEqual([{ name: 'Read', input_schema: {} }]);
    expect(result!.stripped).toEqual(['ScheduleWakeup', 'CronCreate']);
  });

  it('strips only schedule tools in workflow mode, leaving provider-defined tools to the sanitizer', () => {
    const body = {
      tools: [
        { name: 'Read', input_schema: {} },
        { type: 'web_search_20250305' },
        { name: 'ScheduleWakeup', input_schema: {} },
      ],
    };
    const result = anthropicRequestRewriter(body, ctx('workflow'));
    expect(result).not.toBeNull();
    expect(result!.modified.tools).toEqual([{ name: 'Read', input_schema: {} }, { type: 'web_search_20250305' }]);
    expect(result!.stripped).toEqual(['ScheduleWakeup']);
  });

  it('returns null when nothing needs stripping in workflow mode', () => {
    const body = { tools: [{ name: 'Read', input_schema: {} }] };
    expect(anthropicRequestRewriter(body, ctx('workflow'))).toBeNull();
  });

  // Real-world regression: the actual broken request shape from the aborted
  // run. The tools array no longer contains CronCreate (Claude Code never
  // surfaced it as a custom tool), but the messages history carries a
  // tool_reference to it from a prior ToolSearch result. Without history
  // scrubbing, the rewriter would forward this unchanged and Anthropic
  // would 400 with "Tool reference 'CronCreate' not found in available
  // tools". Both the tools-array path and the history path must fire.
  it('scrubs both tools array and history references in workflow mode', () => {
    const body = {
      model: 'claude-opus-4-7',
      tools: [
        { name: 'Read', input_schema: {} },
        { name: 'ScheduleWakeup', input_schema: {} },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01SxC1QRJq1rNG6vRLtQ1gVM',
              content: [
                { type: 'tool_reference', tool_name: 'TaskOutput' },
                { type: 'tool_reference', tool_name: 'CronCreate' },
              ],
            },
          ],
        },
      ],
    };
    const result = anthropicRequestRewriter(body, ctx('workflow'));
    expect(result).not.toBeNull();
    expect(result!.stripped).toEqual(['ScheduleWakeup', 'tool_reference:CronCreate']);
    const serialized = JSON.stringify(result!.modified);
    expect(serialized).not.toContain('CronCreate');
    expect(serialized).not.toContain('ScheduleWakeup');
    expect(serialized).toContain('Read');
    expect(serialized).toContain('TaskOutput');
  });

  it.each(['pty', undefined] as const)('history scrub does NOT fire when agentKind is %s', (agentKind) => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_abc',
              content: [{ type: 'tool_reference', tool_name: 'CronCreate' }],
            },
          ],
        },
      ],
    };
    expect(anthropicRequestRewriter(body, ctx(agentKind))).toBeNull();
  });
});

describe('shouldRewriteBody', () => {
  const configWithRewriter: ProviderConfig = {
    host: 'api.anthropic.com',
    displayName: 'Anthropic',
    allowedEndpoints: [{ method: 'POST', path: '/v1/messages' }],
    keyInjection: { type: 'header', headerName: 'x-api-key' },
    fakeKeyPrefix: 'sk-ant-',
    requestRewriter: anthropicRequestRewriter,
    rewriteEndpoints: ['/v1/messages'],
  };

  const configWithoutRewriter: ProviderConfig = {
    host: 'api.openai.com',
    displayName: 'OpenAI',
    allowedEndpoints: [{ method: 'POST', path: '/v1/chat/completions' }],
    keyInjection: { type: 'bearer' },
    fakeKeyPrefix: 'sk-',
  };

  it('returns false when provider has no rewriter', () => {
    expect(shouldRewriteBody(configWithoutRewriter, 'POST', '/v1/chat/completions')).toBe(false);
  });

  it('returns false for GET requests', () => {
    expect(shouldRewriteBody(configWithRewriter, 'GET', '/v1/messages')).toBe(false);
  });

  it('returns false for non-rewrite paths', () => {
    expect(shouldRewriteBody(configWithRewriter, 'POST', '/v1/messages/count_tokens')).toBe(false);
  });

  it('returns true for POST /v1/messages with Anthropic config', () => {
    expect(shouldRewriteBody(configWithRewriter, 'POST', '/v1/messages')).toBe(true);
  });

  it('returns true with query string in path', () => {
    expect(shouldRewriteBody(configWithRewriter, 'POST', '/v1/messages?beta=true')).toBe(true);
  });

  it('returns false for undefined method or path', () => {
    expect(shouldRewriteBody(configWithRewriter, undefined, '/v1/messages')).toBe(false);
    expect(shouldRewriteBody(configWithRewriter, 'POST', undefined)).toBe(false);
  });
});

describe('generateFakeKey', () => {
  it('generates a key with the given prefix', () => {
    const key = generateFakeKey('sk-ant-api03-');
    expect(key.startsWith('sk-ant-api03-')).toBe(true);
    expect(key.length).toBeGreaterThan('sk-ant-api03-'.length);
  });

  it('generates unique keys each call', () => {
    const key1 = generateFakeKey('test-');
    const key2 = generateFakeKey('test-');
    expect(key1).not.toBe(key2);
  });
});

describe('MitmProxy', () => {
  let proxy: MitmProxy | undefined;
  let tempDir: string;
  let ca: CertificateAuthority;
  let socketPath: string;

  const testProvider: ProviderConfig = {
    host: 'api.test.com',
    displayName: 'Test',
    allowedEndpoints: [
      { method: 'POST', path: '/v1/messages' },
      { method: 'GET', path: '/v1/models' },
    ],
    keyInjection: { type: 'header', headerName: 'x-api-key' },
    fakeKeyPrefix: 'sk-test-',
  };

  const rewriteProvider: ProviderConfig = {
    host: 'api.rewrite-test.com',
    displayName: 'Rewrite Test',
    allowedEndpoints: [{ method: 'POST', path: '/v1/messages' }],
    keyInjection: { type: 'header', headerName: 'x-api-key' },
    fakeKeyPrefix: 'sk-rw-',
    requestRewriter: anthropicRequestRewriter,
    rewriteEndpoints: ['/v1/messages'],
  };

  const rewriteFakeKey = 'sk-rw-fake-key-for-testing';
  const rewriteRealKey = 'sk-rw-real-key-secret';

  const fakeKey = 'sk-test-fake-key-for-testing';
  const realKey = 'sk-real-api-key-secret';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mitm-proxy-test-'));
    ca = loadOrCreateCA(join(tempDir, 'ca'));
    socketPath = join(tempDir, 'mitm-proxy.sock');
  });

  afterEach(async () => {
    if (proxy) {
      await proxy.stop();
      proxy = undefined;
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('starts and listens on the specified socket path', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    const addr = await proxy.start();

    expect(addr.socketPath).toBe(socketPath);
    expect(existsSync(socketPath)).toBe(true);
  });

  it('answers the reserved sidecar health request without upstream access', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method: 'GET',
          path: 'http://ironcurtain.invalid/__ironcurtain/health',
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(response).toEqual({ status: 200, body: 'IRONCURTAIN_OK/1\n' });
  });

  it('returns 403 for CONNECT to denied host', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket, statusCode } = await sendConnect(socketPath, 'evil.com', 443);
    expect(statusCode).toBe(403);
    socket?.destroy();
  });

  it('returns 200 for CONNECT to allowed host', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket, statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(statusCode).toBe(200);
    expect(socket).not.toBeNull();
    socket?.destroy();
  });

  it('returns 405 for non-proxy, non-CONNECT methods', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    // A relative URL (not an absolute proxy URL) should still get 405
    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method: 'GET',
          path: '/',
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(405);
  });

  it('returns 403 for plain HTTP proxy requests to non-passthrough domains', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method: 'GET',
          path: 'http://unknown-domain.example.com/some/path',
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(403);
  });

  it('forwards plain HTTP proxy requests to passthrough domains', async () => {
    // Start a local HTTP server as the upstream target on 127.0.0.1
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url, method: req.method }));
    });
    const upstreamPort = await new Promise<number>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => {
        const addr = upstream.address() as import('node:net').AddressInfo;
        resolve(addr.port);
      });
    });

    try {
      // An approval names one host on one port; plain HTTP is port 80. The
      // transport seam delivers that destination to the local fixture.
      const received: DestinationBoundRequest[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        outboundTransport: localUpstreamTransport(upstreamPort, received),
      });
      await proxy.start();

      proxy.hosts.addHost('test-passthrough.example.com', 80);

      // Send a plain HTTP proxy request via the proxy UDS
      const { statusCode, body } = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            socketPath,
            method: 'GET',
            path: 'http://test-passthrough.example.com/test/path',
          },
          (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => (data += chunk.toString()));
            res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
          },
        );
        req.on('error', reject);
        req.end();
      });

      expect(statusCode).toBe(200);
      const parsed = JSON.parse(body);
      expect(parsed.ok).toBe(true);
      expect(parsed.path).toBe('/test/path');
      expect(parsed.method).toBe('GET');
      expect(received).toHaveLength(1);
      expect(received[0].destination).toEqual({
        protocol: 'http:',
        hostname: 'test-passthrough.example.com',
        port: 80,
      });
    } finally {
      upstream.close();
    }
  });

  it('contains missing upstream metadata at the response boundary and keeps serving', async () => {
    const upstream = http.createServer((_req, res) => res.end('ordinary fixture response'));
    const upstreamPort = await new Promise<number>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as net.AddressInfo).port));
    });
    let first = true;
    const transport: OutboundTransport = {
      kind: 'direct',
      addressGuard: 'local-resolver',
      request(request, onResponse) {
        return http.request(
          { hostname: '127.0.0.1', port: upstreamPort, method: request.method, path: request.path },
          (response) => {
            // Fault injection in memory only; the origin sends ordinary HTTP.
            if (first) {
              first = false;
              Reflect.deleteProperty(response, 'statusCode');
            }
            onResponse?.(response);
          },
        );
      },
    };
    try {
      proxy = createMitmProxy({ socketPath, ca, providers: [], outboundTransport: transport });
      await proxy.start();
      proxy.hosts.addHost('response-boundary.example.com', 80);
      const send = () =>
        new Promise<{ status: number | undefined; connection: string | undefined }>((resolve, reject) => {
          const req = http.get({ socketPath, path: 'http://response-boundary.example.com/fixture' }, (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection }));
          });
          req.on('error', reject);
        });
      expect(await send()).toEqual({ status: 502, connection: 'close' });
      expect((await send()).status).toBe(200);
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('refuses plain HTTP to an approved host on a port the approval does not cover', async () => {
    proxy = createMitmProxy({ socketPath, ca, providers: [] });
    await proxy.start();
    // Approved for HTTPS only: the plain-HTTP port is a separate approval.
    proxy.hosts.addHost('https-only.example.com');

    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request({ socketPath, method: 'GET', path: 'http://https-only.example.com/' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(statusCode).toBe(403);
  });

  it('still screens the resolved address when only the resolver seam is supplied', async () => {
    // The negative twin of the test above: substituting the resolver must not
    // silently disable the address policy, so the same loopback answer is now
    // refused rather than forwarded. The error text tells the policy refusal
    // apart from a connection failure to whatever listens on loopback :80.
    proxy = createMitmProxy({ socketPath, ca, providers: [], dnsLookup: localhostDnsLookup });
    await proxy.start();
    proxy.hosts.addHost('test-passthrough.example.com', 80);

    const { statusCode, body } = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method: 'GET',
          path: 'http://test-passthrough.example.com/test/path',
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(502);
    expect(body).toMatch(/non-public address/u);
  });

  it('contains a synchronous plain-HTTP transport rejection and keeps serving requests', async () => {
    const rejectingTransport: OutboundTransport = {
      kind: 'direct',
      addressGuard: 'local-resolver',
      request() {
        throw new Error('synchronous destination rejection');
      },
    };
    proxy = createMitmProxy({ socketPath, ca, providers: [], outboundTransport: rejectingTransport });
    await proxy.start();
    proxy.hosts.addHost('rejected.example.com', 80);

    const request = (path: string): Promise<{ statusCode: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = http.request({ socketPath, method: 'GET', path }, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString()));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });

    await expect(request('http://rejected.example.com/path')).resolves.toMatchObject({
      statusCode: 502,
      body: expect.stringContaining('synchronous destination rejection'),
    });
    await expect(request('http://not-approved.example.com/path')).resolves.toMatchObject({ statusCode: 403 });
  });

  it('routes plain HTTP proxy requests to Debian registry hosts through registry validation', async () => {
    const debianRegistry: RegistryConfig = {
      host: 'deb.debian.org',
      displayName: 'Debian',
      type: 'debian',
    };

    // Include a non-Debian registry to verify it is NOT routed through the Debian handler
    const npmRegistry: RegistryConfig = {
      host: 'registry.npmjs.org',
      displayName: 'npm',
      type: 'npm',
    };

    // DENY_ALL_VALIDATOR: every .deb request is denied. This proves the registry
    // validation handler is invoked (not forwardPlainHttpPassthrough) — a raw
    // passthrough would never produce a 403 with a package name in the body.
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [],
      registries: [debianRegistry, npmRegistry],
      packageValidation: { validator: DENY_ALL_VALIDATOR },
    });
    await proxy.start();

    const fetchStatus = async (url: string): Promise<{ statusCode: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = http.request({ socketPath, method: 'GET', path: url }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
        });
        req.on('error', reject);
        req.end();
      });

    // Debian .deb request is blocked by the registry validator (DENY_ALL_VALIDATOR),
    // and the body contains the package name — proving the registry handler ran.
    const deniedDeb = await fetchStatus(
      'http://deb.debian.org/debian/pool/main/l/libssl3/libssl3_3.0.11-1~deb12u2_arm64.deb',
    );
    expect(deniedDeb.statusCode).toBe(403);
    expect(deniedDeb.body).toContain('libssl3');

    // Non-Debian registry (npm) is NOT routed through the Debian handler —
    // plain HTTP to an npm host is still blocked at the allowlist level.
    const npm = await fetchStatus('http://registry.npmjs.org/express');
    expect(npm.statusCode).toBe(403);

    // Unknown host: still blocked at the allowlist level.
    const unknown = await fetchStatus('http://evil.example.com/malware');
    expect(unknown.statusCode).toBe(403);

    // Out-of-range port (>65535) is a malformed absolute-form target: refused
    // as a bad request before any routing, never treated as origin-form.
    const badPort = await fetchStatus('http://deb.debian.org:99999/debian/dists/bookworm/InRelease');
    expect(badPort.statusCode).toBe(400);
    const zeroPort = await fetchStatus('http://deb.debian.org:0/debian/dists/bookworm/InRelease');
    expect(zeroPort.statusCode).toBe(400);
  });

  it('forwards an allowed Debian .deb upstream over HTTPS:443, not the client plain-HTTP port', async () => {
    // Regression guard for #329: the registry proxy re-originates TLS to the
    // mirror (forwardReadOnly → https.request), so the plain-HTTP apt path
    // (client :80) must forward upstream on :443. Passing the client's :80 here
    // would point https.request at a non-TLS port and 502 every allowed package
    // and metadata fetch — silently breaking apt. Spy on https.request to assert
    // the upstream target without hitting the network.
    const https = await import('node:https');
    const { PassThrough } = await import('node:stream');
    const captured: { hostname?: unknown; port?: unknown } = {};
    // One-shot override: the single upstream forward this test triggers is
    // intercepted (no network); all other https.request calls fall back to the
    // call-through default installed by vi.mock above.
    vi.mocked(https.request).mockImplementationOnce((...args: unknown[]): http.ClientRequest => {
      const opts = (args[0] ?? {}) as { hostname?: unknown; port?: unknown };
      captured.hostname = opts.hostname;
      captured.port = opts.port;
      const fake = new PassThrough() as unknown as http.ClientRequest;
      (fake as unknown as { setTimeout: () => void }).setTimeout = () => {};
      // Complete deterministically without a real socket: emit 'error' so
      // forwardReadOnly resolves with a 502 and the client request ends.
      setImmediate(() => fake.emit('error', new Error('mock upstream')));
      return fake;
    });

    const debianRegistry: RegistryConfig = { host: 'deb.debian.org', displayName: 'Debian', type: 'debian' };
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [],
      registries: [debianRegistry],
      // quarantineDays: 0 + no denylist ⇒ the .deb is allowed and forwarded upstream.
      packageValidation: { validator: createPackageValidator({ quarantineDays: 0 }) },
    });
    await proxy.start();

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method: 'GET',
          path: 'http://deb.debian.org/debian/pool/main/l/libssl3/libssl3_3.0.11-1~deb12u2_arm64.deb',
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.end();
    });

    // The upstream fetch must target the mirror over HTTPS, not the client's :80.
    expect(captured.hostname).toBe('deb.debian.org');
    expect(captured.port).toBe(443);
  });

  /** Records every registry upstream request and fails it; a refused request never gets here. */
  function createRecordingRegistryTransport(): { transport: OutboundTransport; paths: string[] } {
    const paths: string[] = [];
    return {
      paths,
      transport: {
        kind: 'direct',
        addressGuard: 'local-resolver',
        request(request: DestinationBoundRequest): http.ClientRequest {
          paths.push(request.path);
          throw new Error('registry upstream must not be reached');
        },
      },
    };
  }

  it('refuses encoded Debian package names on the plain-HTTP apt route before forwarding (EGR-2)', async () => {
    const recording = createRecordingRegistryTransport();
    const debianRegistry: RegistryConfig = { host: 'deb.debian.org', displayName: 'Debian', type: 'debian' };
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [],
      registries: [debianRegistry],
      packageValidation: { validator: createPackageValidator({ deniedPackages: ['netcat-traditional', 'g++-12'] }) },
      outboundTransport: recording.transport,
    });
    await proxy.start();

    const fetchStatus = (url: string): Promise<{ statusCode: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = http.request({ socketPath, method: 'GET', path: url }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
        });
        req.on('error', reject);
        req.end();
      });

    const netcat = 'http://deb.debian.org/debian/pool/main/n/netcat';
    for (const url of [
      `${netcat}/%6Eetcat-traditional_1.10-47_amd64.deb`,
      `${netcat}/netcat-traditional_1.10-47_amd64%2Edeb`,
      `${netcat}/netcat-traditional_1.10-47_amd64.d%65b`,
      'http://deb.debian.org/debian/pool/main/g/gcc-12/g%2b%2b-12_12.2.0-14_amd64.deb',
      // WHATWG resolves this dot segment while parsing the proxy URL, so the
      // canonical .deb path is what gets validated (and denied).
      'http://deb.debian.org/debian/dists/../pool/main/n/netcat/netcat-traditional_1.10-47_amd64.deb',
    ]) {
      const res = await fetchStatus(url);
      expect(res.statusCode, url).toBe(403);
      expect(res.body, url).toContain('Forbidden');
    }
    expect(recording.paths).toEqual([]);
  });

  it('refuses npm dot-segment traversal on the HTTPS CONNECT route before forwarding (EGR-1)', async () => {
    const recording = createRecordingRegistryTransport();
    const npmRegistry: RegistryConfig = { host: 'registry.npmjs.org', displayName: 'npm', type: 'npm' };
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [],
      registries: [npmRegistry],
      packageValidation: { validator: createPackageValidator({ deniedPackages: ['express'] }) },
      outboundTransport: recording.transport,
    });
    await proxy.start();

    for (const path of [
      '/@x/../express/-/express-4.18.2.tgz',
      '/@x/../express',
      '/-/../express/-/express-4.18.2.tgz',
      '/-/../express',
      '/express/x/..',
    ]) {
      const { socket, statusCode } = await sendConnect(socketPath, 'registry.npmjs.org', 443);
      expect(statusCode).toBe(200);
      if (!socket) throw new Error('expected an established CONNECT tunnel');
      const res = await makeHttpsRequest(socket, ca, 'registry.npmjs.org', { path });
      expect(res.statusCode, path).toBe(403);
      expect(res.body, path).toContain('dot segment');
    }
    expect(recording.paths).toEqual([]);
  });

  /** Waits until the JSONL audit log holds `count` entries, then parses them. */
  async function readPackageAudit(auditLogPath: string, count: number): Promise<Record<string, unknown>[]> {
    const read = (): Record<string, unknown>[] =>
      existsSync(auditLogPath)
        ? readFileSync(auditLogPath, 'utf-8')
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        : [];
    await waitFor(() => read().length >= count, { timeoutMs: 2_000, intervalMs: 10 });
    return read();
  }

  it('refuses registry writes on the HTTPS CONNECT route before forwarding, and audits them (EGR-3)', async () => {
    const recording = createRecordingRegistryTransport();
    const auditLogPath = join(tempDir, 'package-audit.jsonl');
    const npmRegistry: RegistryConfig = { host: 'registry.npmjs.org', displayName: 'npm', type: 'npm' };
    const cargoRegistry: RegistryConfig = {
      host: 'index.crates.io',
      displayName: 'crates.io',
      type: 'cargo',
      mirrorHosts: ['crates.io', 'static.crates.io'],
    };
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [],
      registries: [npmRegistry, cargoRegistry],
      packageValidation: { validator: createPackageValidator({ quarantineDays: 0 }), auditLogPath },
      outboundTransport: recording.transport,
    });
    await proxy.start();

    const attempts: { host: string; method: string; path: string; headers?: Record<string, string>; body: string }[] = [
      // npm publish: once answered 200 from a GET of the packument.
      {
        host: 'registry.npmjs.org',
        method: 'PUT',
        path: '/express',
        headers: { authorization: 'Bearer npm_ATTACKER', 'content-type': 'application/json' },
        body: '{"name":"express","readme":"STOLEN-WORKSPACE-DATA"}',
      },
      { host: 'registry.npmjs.org', method: 'PUT', path: '/-/package/express/dist-tags/latest', body: '"9.9.9"' },
      { host: 'registry.npmjs.org', method: 'POST', path: '/-/npm/v1/user', body: '{"fullname":"STOLEN"}' },
      {
        host: 'crates.io',
        method: 'PUT',
        path: '/api/v1/crates/new',
        headers: { authorization: 'cio-ATTACKER-TOKEN' },
        body: 'STOLEN-WORKSPACE-DATA',
      },
    ];
    for (const attempt of attempts) {
      const { socket, statusCode } = await sendConnect(socketPath, attempt.host, 443);
      expect(statusCode).toBe(200);
      if (!socket) throw new Error('expected an established CONNECT tunnel');
      const res = await makeHttpsRequest(socket, ca, attempt.host, attempt);
      expect(res.statusCode, attempt.path).toBe(403);
      expect(res.body, attempt.path).toContain('read-only');
    }
    expect(recording.paths).toEqual([]);

    const entries = await readPackageAudit(auditLogPath, attempts.length);
    expect(
      entries.map((entry) => `${String(entry.method)} ${String(entry.host)}${String(entry.requestPath)}`).sort(),
    ).toEqual(attempts.map((attempt) => `${attempt.method} ${attempt.host}${attempt.path}`).sort());
    for (const entry of entries) {
      expect(entry).toMatchObject({ decision: 'deny', source: 'request-gate' });
    }
    expect(readFileSync(auditLogPath, 'utf-8')).not.toMatch(/ATTACKER|STOLEN/);
  });

  it('refuses a non-GET request on the plain-HTTP apt route before forwarding, and audits it (EGR-3)', async () => {
    const recording = createRecordingRegistryTransport();
    const auditLogPath = join(tempDir, 'package-audit.jsonl');
    const debianRegistry: RegistryConfig = { host: 'deb.debian.org', displayName: 'Debian', type: 'debian' };
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [],
      registries: [debianRegistry],
      packageValidation: { validator: createPackageValidator({ quarantineDays: 0 }), auditLogPath },
      outboundTransport: recording.transport,
    });
    await proxy.start();

    const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { socketPath, method: 'POST', path: 'http://deb.debian.org/debian/dists/bookworm/InRelease' },
        (response) => {
          let data = '';
          response.on('data', (chunk: Buffer) => (data += chunk.toString()));
          response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      req.end('STOLEN-WORKSPACE-DATA');
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('read-only');
    expect(recording.paths).toEqual([]);
    const entries = await readPackageAudit(auditLogPath, 1);
    expect(entries).toEqual([
      expect.objectContaining({
        registry: 'debian',
        method: 'POST',
        host: 'deb.debian.org',
        requestPath: '/debian/dists/bookworm/InRelease',
        decision: 'deny',
        source: 'request-gate',
      }),
    ]);
  });

  it('performs TLS handshake with CA-signed cert for allowed host', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    // TLS handshake should succeed with our CA
    const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const tls_ = tls.connect(
        {
          socket: socket!,
          servername: 'api.test.com',
          ca: ca.certPem,
        },
        () => resolve(tls_),
      );
      tls_.on('error', reject);
    });

    expect(tlsSocket.authorized).toBe(true);
    tlsSocket.destroy();
  });

  it('renews leaf cert when cached cert is near expiry', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    // First connection — generates and caches a leaf cert
    const { socket: s1 } = await sendConnect(socketPath, 'api.test.com', 443);
    const tls1 = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const t = tls.connect({ socket: s1!, servername: 'api.test.com', ca: ca.certPem }, () => resolve(t));
      t.on('error', reject);
    });
    const cert1 = tls1.getPeerCertificate();
    tls1.destroy();

    // Advance time past the renewal margin (23h+) so the cached cert is stale
    const realNow = Date.now;
    Date.now = () => realNow.call(Date) + 23.5 * 60 * 60 * 1000;

    let tls2: tls.TLSSocket | undefined;
    try {
      // Second connection — should get a freshly generated cert, not the expired cached one
      const { socket: s2 } = await sendConnect(socketPath, 'api.test.com', 443);
      tls2 = await new Promise<tls.TLSSocket>((resolve, reject) => {
        // Node's TLS verifier reads the operating-system clock rather than the
        // mocked Date.now used to age the cache. Certificate-chain validation
        // is covered by the preceding handshake test; this connection only
        // needs the renewed peer certificate so we can compare serials.
        const t = tls.connect(
          { socket: s2!, servername: 'api.test.com', ca: ca.certPem, rejectUnauthorized: false },
          () => resolve(t),
        );
        t.on('error', reject);
      });
      const cert2 = tls2.getPeerCertificate();
      // The serial numbers should differ — proves the cert was regenerated
      expect(cert2.serialNumber).not.toBe(cert1.serialNumber);
    } finally {
      tls2?.destroy();
      Date.now = realNow;
    }
  });

  it('blocks requests to disallowed endpoints', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    const response = await makeHttpsRequest(socket!, ca, 'api.test.com', {
      method: 'POST',
      path: '/v1/other-endpoint',
      headers: { 'x-api-key': fakeKey },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('not an allowed endpoint');
  });

  // --- Provider credential gate (MITM-2), response headers (MITM-20) ---
  //
  // Every request on a provider route either presents the session sentinel,
  // which the upstream sees only as the real key in the configured location,
  // or is answered locally. A fake upstream records what actually left the
  // proxy, so "never contacts the upstream" is asserted, not inferred.

  describe('provider credential gate', () => {
    interface RecordedRequest {
      readonly method: string;
      readonly url: string;
      readonly headers: http.IncomingHttpHeaders;
      readonly trailers: NodeJS.Dict<string>;
      readonly body: string;
    }
    type Respond = (res: http.ServerResponse, index: number) => void;

    const upstreams: http.Server[] = [];
    afterEach(async () => {
      await Promise.all(
        upstreams.splice(0).map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections();
            }),
        ),
      );
    });

    const okJson: Respond = (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    };

    const bearerProvider: ProviderConfig = {
      host: 'api.bearer-test.com',
      displayName: 'Bearer Test',
      allowedEndpoints: [
        { method: 'POST', path: '/v1/responses' },
        { method: 'GET', path: '/v1/models' },
      ],
      keyInjection: { type: 'bearer' },
      fakeKeyPrefix: 'sk-bearer-',
    };

    /** Starts a recording upstream and a proxy whose provider routes to it. */
    async function startGateProxy(
      config: ProviderConfig,
      mapping: { realKey?: string; tokenManager?: OAuthTokenManager } = {},
      respond: Respond = okJson,
      extraOptions: Pick<MitmProxyOptions, 'capture'> = {},
    ): Promise<{
      seen: RecordedRequest[];
      send: (options: Parameters<typeof makeHttpsRequest>[3]) => ReturnType<typeof makeHttpsRequest>;
    }> {
      const seen: RecordedRequest[] = [];
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          seen.push({
            method: req.method ?? '',
            url: req.url ?? '',
            headers: req.headers,
            trailers: req.trailers,
            body: Buffer.concat(chunks).toString(),
          });
          respond(res, seen.length - 1);
        });
      });
      upstreams.push(server);
      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as import('node:net').AddressInfo).port));
      });
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [
          {
            config: { ...config, upstreamTarget: { hostname: '127.0.0.1', port, pathPrefix: '', useTls: false } },
            fakeKey,
            realKey: mapping.realKey ?? realKey,
            tokenManager: mapping.tokenManager,
          },
        ],
        ...extraOptions,
      });
      await proxy.start();
      return {
        seen,
        send: async (options) => {
          const { socket } = await sendConnect(socketPath, config.host, 443);
          if (!socket) throw new Error('expected an established CONNECT tunnel');
          return makeHttpsRequest(socket, ca, config.host, options);
        },
      };
    }

    function expectLocal401(response: { statusCode: number; body: string }): void {
      expect(response.statusCode).toBe(401);
      const error = JSON.parse(response.body) as { type: string; error: { type: string; message: string } };
      expect(error).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
      expect(error.error.message).toMatch(/^IronCurtain proxy refused this request: /);
      expect(response.body).not.toContain('ATTACKER');
    }

    const foreignCredentialCases: ReadonlyArray<readonly [string, Record<string, string>, string]> = [
      ['an agent-owned x-api-key', { 'x-api-key': 'sk-ant-api03-ATTACKER' }, '/v1/messages'],
      ['an agent-owned bearer token and no key header', { authorization: 'Bearer sk-ATTACKER-OWNED' }, '/v1/messages'],
      [
        'the sentinel plus an agent-owned bearer token',
        { 'x-api-key': fakeKey, authorization: 'Bearer ATTACKER-BEARER' },
        '/v1/messages',
      ],
      [
        'an agent-owned key plus the sentinel bearer',
        { 'x-api-key': 'ATTACKER', authorization: `Bearer ${fakeKey}` },
        '/v1/messages',
      ],
      [
        'the sentinel plus an agent-owned x-goog-api-key',
        { 'x-api-key': fakeKey, 'x-goog-api-key': 'AIza-ATTACKER' },
        '/v1/messages',
      ],
      ['the sentinel plus an agent-owned api-key', { 'x-api-key': fakeKey, 'api-key': 'ATTACKER' }, '/v1/messages'],
      ['a Basic authorization', { authorization: 'Basic QVRUQUNLRVI6eA==' }, '/v1/messages'],
      ['an agent-owned key query parameter', {}, '/v1/messages?key=AIza-ATTACKER'],
      [
        'the sentinel plus an agent-owned api_key parameter',
        { 'x-api-key': fakeKey },
        '/v1/messages?beta=true&api_key=ATTACKER',
      ],
      ['the sentinel plus a percent-encoded key parameter', { 'x-api-key': fakeKey }, '/v1/messages?%6Bey=ATTACKER'],
      [
        'the sentinel plus a key parameter behind a `;`',
        { 'x-api-key': fakeKey },
        '/v1/messages?beta=true;key=ATTACKER',
      ],
    ];

    it.each(foreignCredentialCases)(
      'answers %s with a local 401 and never contacts the upstream',
      async (_label, headers, path) => {
        const { seen, send } = await startGateProxy(testProvider);
        const response = await send({
          method: 'POST',
          path,
          headers: { 'content-type': 'application/json', ...headers },
          body: '{"model":"m","messages":[]}',
        });
        expectLocal401(response);
        expect(seen).toHaveLength(0);
      },
    );

    it('answers an agent-owned bearer on an OpenAI-style route with a local 401', async () => {
      const { seen, send } = await startGateProxy(bearerProvider);
      const response = await send({
        method: 'POST',
        path: '/v1/responses',
        headers: { authorization: 'Bearer sk-ATTACKER-OWNED', 'content-type': 'application/json' },
        body: '{"model":"gpt","input":"workspace contents","store":true}',
      });
      expectLocal401(response);
      expect(seen).toHaveLength(0);
    });

    const sentinelCases: ReadonlyArray<readonly [string, Record<string, string>, string, string]> = [
      ['the configured header', { 'x-api-key': fakeKey }, '/v1/models', '/v1/models'],
      [
        'both auth headers (Claude Code API-key helper)',
        { 'x-api-key': fakeKey, authorization: `Bearer ${fakeKey}` },
        '/v1/models',
        '/v1/models',
      ],
      [
        'a Bearer authorization, moved to the configured header',
        { authorization: `bearer ${fakeKey}` },
        '/v1/models',
        '/v1/models',
      ],
      [
        'a key query parameter, removed from the path',
        {},
        `/v1/models?key=${fakeKey}&beta=true`,
        '/v1/models?beta=true',
      ],
    ];

    it.each(sentinelCases)(
      'accepts the sentinel in %s and forwards only the real key in the configured header',
      async (_label, headers, path, upstreamPath) => {
        const { seen, send } = await startGateProxy(testProvider);
        const response = await send({ method: 'GET', path, headers: { ...headers, cookie: 'session=AGENT-COOKIE' } });
        expect(response.statusCode).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe(upstreamPath);
        expect(seen[0].headers['x-api-key']).toBe(realKey);
        expect(seen[0].headers.authorization).toBeUndefined();
        expect(seen[0].headers.cookie).toBeUndefined();
      },
    );

    it('moves a sentinel presented in x-api-key to the Authorization header of a bearer provider', async () => {
      const { seen, send } = await startGateProxy(bearerProvider);
      expect((await send({ method: 'GET', path: '/v1/models', headers: { 'x-api-key': fakeKey } })).statusCode).toBe(
        200,
      );
      expect(
        (await send({ method: 'GET', path: '/v1/models', headers: { authorization: `Bearer ${fakeKey}` } })).statusCode,
      ).toBe(200);
      for (const request of seen) {
        expect(request.headers.authorization).toBe(`Bearer ${realKey}`);
        expect(request.headers['x-api-key']).toBeUndefined();
      }
    });

    it('answers a request with no credential with a local 401 unless its endpoint is unauthenticated', async () => {
      const { seen, send } = await startGateProxy({
        ...testProvider,
        unauthenticatedEndpoints: [{ method: 'GET', path: '/v1/models' }],
      });
      const refused = await send({ method: 'POST', path: '/v1/messages', headers: {}, body: '{}' });
      expectLocal401(refused);
      expect(seen).toHaveLength(0);

      // Empty carriers are no credential; cookies are always stripped.
      const anonymous = await send({
        method: 'GET',
        path: '/v1/models',
        headers: { authorization: '', cookie: 'session=AGENT-COOKIE' },
      });
      expect(anonymous.statusCode).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0].headers['x-api-key']).toBeUndefined();
      expect(seen[0].headers.authorization).toBeUndefined();
      expect(seen[0].headers.cookie).toBeUndefined();

      // A foreign credential is refused on an unauthenticated endpoint too.
      expectLocal401(await send({ method: 'GET', path: '/v1/models', headers: { 'x-api-key': 'ATTACKER' } }));
      expect(seen).toHaveLength(1);
    });

    it('refuses an unauthenticated endpoint that is not an allowed endpoint at startup', () => {
      expect(() =>
        createMitmProxy({
          socketPath,
          ca,
          providers: [
            {
              config: { ...testProvider, unauthenticatedEndpoints: [{ method: 'GET', path: '/v1/files' }] },
              fakeKey,
              realKey,
            },
          ],
        }),
      ).toThrow(/unauthenticated endpoint GET \/v1\/files is not an allowed endpoint/);
    });

    it('forwards no credential at all for a keyless gateway profile (empty real key)', async () => {
      const { seen, send } = await startGateProxy(bearerProvider, { realKey: '' });
      const response = await send({
        method: 'GET',
        path: '/v1/models',
        headers: { authorization: `Bearer ${fakeKey}` },
      });
      expect(response.statusCode).toBe(200);
      expect(seen[0].headers.authorization).toBeUndefined();
    });

    it('never injects a refreshed OAuth token into an anonymous request', async () => {
      const tokenManager = {
        getValidAccessToken: async () => 'fresh-real-token',
        handleAuthFailure: async () => 'newer-real-token',
      } as OAuthTokenManager;
      const { seen, send } = await startGateProxy(
        { ...bearerProvider, unauthenticatedEndpoints: [{ method: 'GET', path: '/v1/models' }] },
        { realKey: 'old-real-token', tokenManager },
      );
      expect((await send({ method: 'GET', path: '/v1/models' })).statusCode).toBe(200);
      expect(
        (await send({ method: 'GET', path: '/v1/models', headers: { authorization: `Bearer ${fakeKey}` } })).statusCode,
      ).toBe(200);
      expect(seen.map((request) => request.headers.authorization)).toEqual([undefined, 'Bearer fresh-real-token']);
    });

    it('relays no Set-Cookie or hop-by-hop response header, including after a 401 refresh retry', async () => {
      const providerHeaders = {
        'Set-Cookie': ['__Secure-session=PROVIDER-SESSION; Secure; HttpOnly', 'cf_bm=x'],
        Connection: 'keep-alive, X-Upstream-Hop',
        'X-Upstream-Hop': 'hop-only',
        'Keep-Alive': 'timeout=5',
        'X-End-To-End': 'kept',
      };
      const tokenManager = {
        getValidAccessToken: async () => 'old-real-token',
        handleAuthFailure: async () => 'new-real-token',
      } as OAuthTokenManager;
      const { seen, send } = await startGateProxy(
        testProvider,
        { realKey: 'old-real-token', tokenManager },
        (res, index) => {
          res.writeHead(index === 0 ? 401 : 200, { ...providerHeaders, 'Content-Type': 'application/json' });
          res.end(index === 0 ? '{"error":"expired"}' : '{"ok":true}');
        },
      );
      const response = await send({ method: 'GET', path: '/v1/models', headers: { 'x-api-key': fakeKey } });
      expect(response.statusCode).toBe(200);
      expect(seen.map((request) => request.headers['x-api-key'])).toEqual(['old-real-token', 'new-real-token']);
      expect(response.body).toContain('"ok":true');
      expect(response.headers['x-end-to-end']).toBe('kept');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['x-upstream-hop']).toBeUndefined();
      expect(response.headers['keep-alive']).toBeUndefined();
    });

    it('relays an upstream 401 without its Set-Cookie when no retry applies', async () => {
      const { send } = await startGateProxy(testProvider, {}, (res) => {
        res.writeHead(401, { 'Set-Cookie': 'session=PROVIDER-SESSION', 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
      });
      const response = await send({ method: 'GET', path: '/v1/models', headers: { 'x-api-key': fakeKey } });
      expect(response.statusCode).toBe(401);
      expect(response.body).toContain('unauthorized');
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it("strips the agent's hop-by-hop request headers but keeps a streamed body framed", async () => {
      const { seen } = await startGateProxy(testProvider);
      const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
      if (!socket) throw new Error('expected an established CONNECT tunnel');
      const head = [
        'POST /v1/messages HTTP/1.1',
        'host: api.test.com',
        `x-api-key: ${fakeKey}`,
        // Nominating the framing headers must not unframe the forwarded body.
        'connection: close, x-agent-hop, transfer-encoding, content-length',
        'x-agent-hop: must-not-cross',
        'keep-alive: timeout=1',
        'te: trailers',
        'upgrade: example/1',
        'transfer-encoding: chunked',
      ].join('\r\n');
      const raw = await rawHttpsExchange(
        socket,
        ca,
        'api.test.com',
        `${head}\r\n\r\n5\r\nhello\r\n6\r\n-world\r\n0\r\n\r\n`,
      );
      expect(raw).toMatch(/^HTTP\/1\.1 200 /);
      expect(seen).toHaveLength(1);
      expect(seen[0].body).toBe('hello-world');
      expect(seen[0].headers['x-api-key']).toBe(realKey);
      expect(seen[0].headers['transfer-encoding']).toBe('chunked');
      for (const name of ['x-agent-hop', 'keep-alive', 'te', 'upgrade']) {
        expect(seen[0].headers[name], name).toBeUndefined();
      }
      expect(seen[0].headers.connection ?? '').not.toMatch(/x-agent-hop|close/i);
    });

    it('refuses dot-segment and encoded-separator paths before any credential handling', async () => {
      const { seen, send } = await startGateProxy(anthropicProvider);
      for (const path of [
        '/v1/./messages',
        '/v1/%2e/messages',
        '/api/eval/..',
        '/api/eval/.',
        '/api/eval/%2e%2e',
        '/api/eval/..%2F..%2Fv1%2Ffiles',
        '/api/eval/sdk%5c..',
      ]) {
        const response = await send({ method: 'POST', path, headers: { 'x-api-key': fakeKey }, body: '{}' });
        expect(response.statusCode, path).toBe(403);
      }
      expect(seen).toHaveLength(0);
    });

    it("lets Claude Code's keyless housekeeping calls through anonymously, and nothing else", async () => {
      const { seen, send } = await startGateProxy(anthropicProvider);
      for (const [method, path] of [
        ['GET', '/api/hello'],
        ['GET', '/mcp-registry/v0/servers?version=latest&limit=100'],
        ['POST', '/api/event_logging/v2/batch'],
        ['POST', '/api/eval/sdk-AbC123'],
      ] as const) {
        const response = await send({ method, path, ...(method === 'POST' ? { body: '{}' } : {}) });
        expect(response.statusCode, path).toBe(200);
      }
      expect(seen.every((request) => request.headers['x-api-key'] === undefined)).toBe(true);
      for (const [method, path] of [
        ['POST', '/v1/messages'],
        ['POST', '/v1/messages/count_tokens'],
        ['GET', '/api/claude_code/settings'],
      ] as const) {
        expectLocal401(await send({ method, path, ...(method === 'POST' ? { body: '{}' } : {}) }));
      }
      expect(seen).toHaveLength(4);
    });

    it('allows Codex workspace routing discovery with the session token only', async () => {
      const { seen, send } = await startGateProxy(codexChatGptProvider);
      const path = '/backend-api/wham/accounts/check';
      const response = await send({ method: 'GET', path, headers: { authorization: `Bearer ${fakeKey}` } });
      expect(response.statusCode).toBe(200);
      expect(seen[0]).toMatchObject({ method: 'GET', url: path });
      expect(seen[0].headers.authorization).toBe(`Bearer ${realKey}`);

      expect(
        (await send({ method: 'POST', path, headers: { authorization: `Bearer ${fakeKey}` }, body: '{}' })).statusCode,
      ).toBe(403);
      expectLocal401(await send({ method: 'GET', path }));
      expectLocal401(await send({ method: 'GET', path, headers: { authorization: 'Bearer ATTACKER' } }));
      // The public key sets need no credential.
      expect((await send({ method: 'GET', path: '/wham/agent-identities/jwks' })).statusCode).toBe(200);
      expect(seen).toHaveLength(2);
      expect(seen[1].headers.authorization).toBeUndefined();
    });

    it('records a captured request path with its credential query parameter redacted (MITM-20)', async () => {
      const capturesDir = join(tempDir, 'captures');
      const writer = createTrajectoryCaptureWriter({ capturesDir });
      const sessionId = 'credential-query-capture' as SessionId;
      writer.beginSession({ sessionId });
      try {
        const { seen, send } = await startGateProxy(
          googleProvider,
          {},
          (res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"candidates":[]}');
          },
          { capture: writer },
        );
        proxy?.setCaptureSessionId(sessionId);
        const response = await send({
          method: 'POST',
          path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${fakeKey}`,
          headers: { 'content-type': 'application/json' },
          body: '{"contents":[]}',
        });
        expect(response.statusCode).toBe(200);
        expect(seen[0].url).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
        expect(seen[0].headers['x-goog-api-key']).toBe(realKey);
        await writer.endSession(sessionId);
        expect(writer.stats()).toMatchObject({ written: 1 });
      } finally {
        await writer.close();
      }
      const corpus = readdirSync(capturesDir)
        .map((file) => readFileSync(join(capturesDir, file), 'utf-8'))
        .join('\n');
      expect(corpus).toContain('generateContent?key=<redacted>');
      expect(corpus).not.toContain(fakeKey);
      expect(corpus).not.toContain(realKey);
    });

    it('never forwards a credential carried in request trailers or in a repeated Authorization line', async () => {
      const { seen } = await startGateProxy(testProvider);
      const exchange = async (raw: string): Promise<string> => {
        const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
        if (!socket) throw new Error('expected an established CONNECT tunnel');
        return rawHttpsExchange(socket, ca, 'api.test.com', raw);
      };
      // The gate runs on the request head; trailers arrive after it and must never be relayed.
      const head = [
        'POST /v1/messages HTTP/1.1',
        'host: api.test.com',
        'connection: close',
        `x-api-key: ${fakeKey}`,
        'transfer-encoding: chunked',
        'trailer: x-api-key, authorization',
      ].join('\r\n');
      const trailers = 'x-api-key: ATTACKER\r\nauthorization: Bearer ATTACKER\r\n';
      expect(await exchange(`${head}\r\n\r\n2\r\n{}\r\n0\r\n${trailers}\r\n`)).toMatch(/^HTTP\/1\.1 200 /);
      // A repeated Authorization line: whatever the parser keeps, the second value never travels.
      await exchange(
        'GET /v1/models HTTP/1.1\r\nhost: api.test.com\r\nconnection: close\r\n' +
          `authorization: Bearer ${fakeKey}\r\nauthorization: Bearer ATTACKER\r\n\r\n`,
      );
      expect(seen[0]).toMatchObject({ body: '{}', trailers: {} });
      expect(seen[0].headers['x-api-key']).toBe(realKey);
      expect(seen.every((request) => request.headers.authorization === undefined)).toBe(true);
      expect(JSON.stringify(seen)).not.toContain('ATTACKER');
    });

    it('never writes a credential query value to the session log, the WebSocket fast-reject included', async () => {
      const logFilePath = join(tempDir, 'session.log');
      logger.setup({ logFilePath });
      try {
        const { send } = await startGateProxy(testProvider);
        // Forwarded with the sentinel, refused by the gate, refused by the endpoint filter.
        expect((await send({ method: 'GET', path: `/v1/models?key=${fakeKey}` })).statusCode).toBe(200);
        expectLocal401(await send({ method: 'GET', path: '/v1/models?key=ATTACKER-QUERY' }));
        const blocked = await send({ method: 'GET', path: '/v1/other-endpoint?key=ATTACKER-QUERY' });
        expect(blocked.statusCode).toBe(403);
        expect(blocked.body).not.toContain('ATTACKER-QUERY');
        // A WebSocket upgrade on a provider host is torn down before any HTTP handling.
        const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
        if (!socket) throw new Error('expected an established CONNECT tunnel');
        await new Promise<void>((resolve) => {
          const tlsSocket = tls.connect({ socket, servername: 'api.test.com', ca: ca.certPem }, () => {
            tlsSocket.write(
              'GET /v1/models?alt=sse&key=ATTACKER-WS HTTP/1.1\r\nhost: api.test.com\r\n' +
                'upgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\n' +
                `sec-websocket-key: ${crypto.randomBytes(16).toString('base64')}\r\n\r\n`,
            );
          });
          tlsSocket.on('error', () => undefined);
          tlsSocket.on('close', () => resolve());
        });
      } finally {
        logger.teardown();
      }
      const log = readFileSync(logFilePath, 'utf-8');
      expect(log).toContain('REJECTED websocket api.test.com/v1/models?alt=sse&key=<redacted>');
      expect(log).toContain('BLOCKED GET api.test.com/v1/other-endpoint?key=<redacted>');
      for (const secret of [fakeKey, 'ATTACKER-QUERY', 'ATTACKER-WS']) expect(log).not.toContain(secret);
    });
  });

  // --- Keep-alive pools per address policy (MITM-4) ---

  describe('upstream keep-alive pools', () => {
    const servers: http.Server[] = [];
    const ALLOW_ALL_HOSTS = 'IRONCURTAIN_MITM_ALLOW_ALL_HOSTS';
    let savedAllowAllHosts: string | undefined;
    beforeEach(() => {
      savedAllowAllHosts = process.env[ALLOW_ALL_HOSTS];
      delete process.env[ALLOW_ALL_HOSTS];
    });
    afterEach(async () => {
      if (savedAllowAllHosts === undefined) delete process.env[ALLOW_ALL_HOSTS];
      else process.env[ALLOW_ALL_HOSTS] = savedAllowAllHosts;
      await Promise.all(
        servers.splice(0).map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections();
            }),
        ),
      );
    });

    /**
     * A private LLM gateway reachable by a multi-label name (the resolver maps
     * every name to loopback). The proxy reaches it for provider traffic under
     * the trusted-provider override, and the same name and port are a
     * passthrough destination, where only public addresses are allowed.
     */
    async function startPrivateGateway(): Promise<{ port: number; seenPaths: string[] }> {
      const seenPaths: string[] = [];
      const server = http.createServer((req, res) => {
        seenPaths.push(req.url ?? '');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`PRIVATE-GATEWAY saw ${req.method} ${req.url}`);
      });
      server.on('upgrade', (req, socket) => {
        seenPaths.push(`upgrade ${req.url ?? ''}`);
        socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      });
      servers.push(server);
      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as import('node:net').AddressInfo).port));
      });
      return { port, seenPaths };
    }

    /**
     * `passthroughAnyPort`: an approval names port 443 or 80 only, and the
     * gateway listens on an ephemeral port, so the passthrough tests reach it
     * under the wildcard escape hatch (any port of a host that is not a
     * provider). That is the route an approved `gw.mycorp.example:80` takes
     * too: the destination-bound transport, under the public-only policy.
     */
    async function startProxyWithPrivateGateway(port: number, passthroughAnyPort = false): Promise<void> {
      if (passthroughAnyPort) process.env[ALLOW_ALL_HOSTS] = '1';
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [
          {
            config: {
              ...testProvider,
              upstreamTarget: { hostname: 'gw.mycorp.example', port, pathPrefix: '', useTls: false },
            },
            fakeKey,
            realKey,
          },
        ],
        // The real address policy: no allowPrivateDestinationsForTests.
        dnsLookup: localhostDnsLookup,
      });
      await proxy.start();
    }

    function plainHttpThroughProxy(url: string): Promise<{ statusCode: number; body: string }> {
      return new Promise((resolve, reject) => {
        const req = http.request({ socketPath, method: 'GET', path: url }, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString()));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
    }

    async function sendProviderRequest(): Promise<void> {
      const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
      if (!socket) throw new Error('expected an established CONNECT tunnel');
      const response = await makeHttpsRequest(socket, ca, 'api.test.com', {
        method: 'GET',
        path: '/v1/models',
        headers: { 'x-api-key': fakeKey },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('PRIVATE-GATEWAY saw GET /v1/models');
      // Let the keep-alive socket return to its pool.
      await new Promise((resolve) => setImmediate(resolve));
    }

    it('never reuses a socket opened for a trusted private gateway for plain-HTTP passthrough', async () => {
      const gateway = await startPrivateGateway();
      await startProxyWithPrivateGateway(gateway.port, true);
      const passthroughUrl = `http://gw.mycorp.example:${gateway.port}/admin/secret`;

      const before = await plainHttpThroughProxy(passthroughUrl);
      expect(before.statusCode).toBe(502);

      await sendProviderRequest();

      const after = await plainHttpThroughProxy(passthroughUrl);
      expect(after.statusCode).toBe(502);
      expect(after.body).not.toContain('PRIVATE-GATEWAY');
      expect(gateway.seenPaths).toEqual(['/v1/models']);
    });

    it('never reuses a socket opened for a trusted private gateway for a ws:// passthrough upgrade', async () => {
      const gateway = await startPrivateGateway();
      await startProxyWithPrivateGateway(gateway.port, true);
      await sendProviderRequest();

      const raw = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(socketPath);
        let data = '';
        socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
        socket.on('close', () => resolve(data));
        socket.on('error', reject);
        socket.write(
          `GET http://gw.mycorp.example:${gateway.port}/admin/ws HTTP/1.1\r\n` +
            `Host: gw.mycorp.example:${gateway.port}\r\n` +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      expect(raw).toMatch(/^HTTP\/1\.1 502 /);
      expect(gateway.seenPaths).toEqual(['/v1/models']);
    });

    it('still reuses keep-alive sockets within one address policy, and stop() drops them', async () => {
      const gateway = await startPrivateGateway();
      const connections: import('node:net').Socket[] = [];
      servers[0]?.on('connection', (socket: import('node:net').Socket) => connections.push(socket));
      await startProxyWithPrivateGateway(gateway.port);
      await sendProviderRequest();
      await sendProviderRequest();
      expect(gateway.seenPaths).toEqual(['/v1/models', '/v1/models']);
      expect(connections).toHaveLength(1);

      // Nothing else closes the idle pooled socket: without the transport's
      // close() it would linger until the keep-alive timeout (about 4 s).
      const pooledClosed = new Promise<void>((resolve) => connections[0]?.once('close', () => resolve()));
      await proxy?.stop();
      proxy = undefined;
      let timer: NodeJS.Timeout | undefined;
      const closedInTime = await Promise.race([
        pooledClosed.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2_000);
        }),
      ]);
      clearTimeout(timer);
      expect(closedInTime).toBe(true);
    });
  });

  it('refreshes OAuth tokens and retries bodyless authenticated requests after upstream 401', async () => {
    const seenKeys: string[] = [];
    const upstream = http.createServer((req, res) => {
      seenKeys.push(String(req.headers['x-api-key'] ?? ''));
      if (seenKeys.length === 1) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('expired');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = await new Promise<number>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => {
        resolve((upstream.address() as import('node:net').AddressInfo).port);
      });
    });
    const oauthProvider: ProviderConfig = {
      ...testProvider,
      upstreamTarget: { hostname: '127.0.0.1', port: upstreamPort, pathPrefix: '', useTls: false },
    };
    const tokenManager = {
      getValidAccessToken: async () => 'old-real-token',
      handleAuthFailure: async () => 'new-real-token',
    } as OAuthTokenManager;

    try {
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: oauthProvider, fakeKey, realKey: 'old-real-token', tokenManager }],
        dnsLookup: localhostDnsLookup,
      });
      await proxy.start();

      const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
      expect(socket).not.toBeNull();

      const response = await makeHttpsRequest(socket!, ca, 'api.test.com', {
        method: 'GET',
        path: '/v1/models',
        headers: { 'x-api-key': fakeKey },
      });

      expect(response.statusCode).toBe(200);
      expect(seenKeys).toEqual(['old-real-token', 'new-real-token']);
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('refreshes OAuth tokens and retries bodyless bearer requests after upstream 401', async () => {
    // Codex's real providers use { type: 'bearer' } key injection, so the
    // bearer + bodyless GET + 401-retry path it actually traverses needs
    // its own coverage (the header-based sibling above does not exercise
    // injectRealKey's bearer branch).
    const seenAuth: string[] = [];
    const upstream = http.createServer((req, res) => {
      seenAuth.push(req.headers['authorization'] ?? '');
      if (seenAuth.length === 1) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('expired');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = await new Promise<number>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => {
        resolve((upstream.address() as import('node:net').AddressInfo).port);
      });
    });
    const bearerProvider: ProviderConfig = {
      ...testProvider,
      keyInjection: { type: 'bearer' },
      upstreamTarget: { hostname: '127.0.0.1', port: upstreamPort, pathPrefix: '', useTls: false },
    };
    const tokenManager = {
      getValidAccessToken: async () => 'old-real-token',
      handleAuthFailure: async () => 'new-real-token',
    } as OAuthTokenManager;

    try {
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: bearerProvider, fakeKey, realKey: 'old-real-token', tokenManager }],
        dnsLookup: localhostDnsLookup,
        allowPrivateDestinationsForTests: true,
      });
      await proxy.start();

      const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
      expect(socket).not.toBeNull();

      const response = await makeHttpsRequest(socket!, ca, 'api.test.com', {
        method: 'GET',
        path: '/v1/models',
        headers: { authorization: `Bearer ${fakeKey}` },
      });

      expect(response.statusCode).toBe(200);
      // First attempt carries the swapped real token; after the upstream
      // 401, the proxy refreshes and retries with the new real token — both
      // arrive in the Authorization: Bearer header.
      expect(seenAuth).toEqual(['Bearer old-real-token', 'Bearer new-real-token']);
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('stop() cleans up socket file', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    expect(existsSync(socketPath)).toBe(true);
    await proxy.stop();
    expect(existsSync(socketPath)).toBe(false);
    proxy = undefined; // Already stopped
  });

  // --- P0: Crash prevention ---

  it('survives client destroying socket during TLS handshake', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    // Immediately destroy the raw socket before TLS handshake completes.
    // Without the clientSocket error handler, this would crash the process.
    socket!.destroy();

    // Wait for the proxy to process the socket destruction event
    await waitFor(() => socket!.destroyed);

    // Proxy should still be alive and accepting new connections
    const { statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(statusCode).toBe(200);
  });

  it('handles upstream response error gracefully', async () => {
    // Verify the proxy survives when the upstream connection fails.
    // We make a request to the proxy which will attempt to connect
    // upstream to api.test.com (which won't resolve correctly), and
    // the proxy should return a 502 or handle the error gracefully.
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    // Make a request; the real upstream (api.test.com) won't respond
    // correctly, but what matters is the proxy doesn't crash
    try {
      await makeHttpsRequest(socket!, ca, 'api.test.com', {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'x-api-key': fakeKey, 'content-type': 'application/json' },
        body: '{"test": true}',
      });
    } catch {
      // Connection errors are expected since api.test.com may not resolve
    }

    // Proxy should still be functional -- no delay needed; the upstream error
    // is handled synchronously in the proxy's error callback.
    const { statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(statusCode).toBe(200);
  });

  // --- P1: Resource leak / cleanup ---

  it('stop() cleanly shuts down with active connections', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    // Open several connections to create active sockets
    const sockets: import('node:net').Socket[] = [];
    for (let i = 0; i < 3; i++) {
      const { socket, statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
      expect(statusCode).toBe(200);
      sockets.push(socket!);
    }

    // stop() should complete without hanging or throwing, even with active sockets
    await proxy.stop();
    proxy = undefined; // Already stopped

    // All client sockets should be destroyed
    await waitFor(() => sockets.every((sock) => sock.destroyed));
    for (const sock of sockets) {
      expect(sock.destroyed).toBe(true);
    }
  });

  it('returns 400 for malformed HTTP after TLS handshake', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    // Perform TLS handshake, then send garbage HTTP
    const response = await new Promise<string>((resolve) => {
      const tlsSocket = tls.connect(
        {
          socket: socket!,
          servername: 'api.test.com',
          ca: ca.certPem,
        },
        () => {
          // Send malformed HTTP that will trigger a clientError
          tlsSocket.write('NOT VALID HTTP\r\n\r\n');

          let data = '';
          tlsSocket.on('data', (chunk) => {
            data += chunk.toString();
          });
          tlsSocket.on('end', () => resolve(data));
          tlsSocket.on('error', () => resolve(data));

          // Timeout fallback in case we get no response
          setTimeout(() => resolve(data), 200);
        },
      );
      tlsSocket.on('error', () => resolve(''));
    });

    // The proxy should respond with 400 Bad Request
    expect(response).toContain('400');
  });

  it('tracks and cleans up raw client sockets on stop()', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    // Create a connection but don't do TLS handshake — this tests
    // the gap between CONNECT ack and TLS socket creation
    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();
    expect(socket!.destroyed).toBe(false);

    // stop() should destroy the raw client socket too
    await proxy.stop();
    proxy = undefined;

    await waitFor(() => socket!.destroyed);
    expect(socket!.destroyed).toBe(true);
  });

  // --- P2: Robustness ---

  it('handles ECONNRESET without crashing', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    // Open a CONNECT and do a TLS handshake
    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const tls_ = tls.connect({ socket: socket!, servername: 'api.test.com', ca: ca.certPem }, () => resolve(tls_));
      tls_.on('error', reject);
    });

    // Force-destroy the underlying socket to trigger ECONNRESET on the proxy side
    tlsSocket.destroy();

    // Wait for the socket destruction to propagate
    await waitFor(() => tlsSocket.destroyed);

    // Proxy should still accept new connections
    const { statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(statusCode).toBe(200);
  });

  it('removes stale error listener after successful start', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });

    await proxy.start();

    // After successful start, there should be no lingering 'error' listeners
    // from the start() promise. The server's error listeners should only be
    // the default Node.js ones, not the reject callback from the promise.
    // We verify this indirectly: if the stale listener were present and the
    // server emitted an error, it would reject a long-resolved promise
    // (which would be an unhandled rejection). Instead, we just verify that
    // start completed and the proxy is functional.
    const { statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(statusCode).toBe(200);
  });

  // --- End-to-end strip verification via MitmProxyOptions.agentKind ---
  //
  // Drives a real proxy with a local HTTP upstream, exercises the full
  // TLS-terminate / parse / rewrite / forward path, and asserts on what
  // the upstream actually received. The unit tests on
  // anthropicRequestRewriter cover the strip logic itself; these tests
  // cover the plumbing: that `agentKind` from MitmProxyOptions reaches
  // the rewriter context, and that the rewritten body — not the original —
  // is what flushes upstream.

  /**
   * Stands up a localhost HTTP server that captures the body of each request
   * it receives. Returns the port and a getter for captured bodies.
   */
  async function startCapturingUpstream(): Promise<{
    port: number;
    server: http.Server;
    bodies: () => Buffer[];
  }> {
    const captured: Buffer[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        captured.push(Buffer.concat(chunks));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as import('node:net').AddressInfo).port);
      });
    });
    return { port, server, bodies: () => captured };
  }

  /**
   * Body containing the schedule skill's tools alongside benign ones —
   * the standard fixture for these scenarios.
   */
  const requestBodyWithScheduleTools = JSON.stringify({
    model: 'claude-3',
    messages: [],
    tools: [
      { name: 'Read', input_schema: {} },
      { name: 'ScheduleWakeup', input_schema: {} },
      { name: 'CronCreate', input_schema: {} },
      { name: 'Bash', input_schema: {} },
    ],
  });

  /**
   * Builds a provider that mirrors `anthropicProvider`'s rewrite shape but
   * forwards to a localhost HTTP upstream so the test can capture the body
   * that left the proxy.
   */
  function makeLocalRewriteProvider(upstreamPort: number): ProviderConfig {
    return {
      host: 'api.rewrite-test.com',
      displayName: 'Rewrite Test (e2e)',
      allowedEndpoints: [{ method: 'POST', path: '/v1/messages' }],
      keyInjection: { type: 'header', headerName: 'x-api-key' },
      fakeKeyPrefix: 'sk-rw-',
      requestRewriter: anthropicRequestRewriter,
      rewriteEndpoints: ['/v1/messages'],
      upstreamTarget: { hostname: '127.0.0.1', port: upstreamPort, pathPrefix: '', useTls: false },
    };
  }

  /**
   * Runs the schedule-tool-strip scenario end-to-end. Returns the parsed
   * `tools` array that the upstream actually received.
   */
  async function runScheduleStripScenario(agentKind: AgentKind | undefined): Promise<unknown[]> {
    const { port, server, bodies } = await startCapturingUpstream();
    try {
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: makeLocalRewriteProvider(port), fakeKey: rewriteFakeKey, realKey: rewriteRealKey }],
        dnsLookup: localhostDnsLookup,
        allowPrivateDestinationsForTests: true,
        agentKind,
      });
      await proxy.start();

      const { socket, statusCode: connectStatus } = await sendConnect(socketPath, 'api.rewrite-test.com', 443);
      expect(connectStatus).toBe(200);
      expect(socket).not.toBeNull();

      const response = await makeHttpsRequest(socket!, ca, 'api.rewrite-test.com', {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'x-api-key': rewriteFakeKey, 'content-type': 'application/json' },
        body: requestBodyWithScheduleTools,
      });

      expect(response.statusCode).toBe(200);
      const captured = bodies();
      expect(captured.length).toBe(1);
      const forwarded = JSON.parse(captured[0].toString()) as Record<string, unknown>;
      return forwarded.tools as unknown[];
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  it('strips ScheduleWakeup + CronCreate from upstream body when agentKind=workflow', async () => {
    const forwardedTools = await runScheduleStripScenario('workflow');
    expect(forwardedTools).toEqual([
      { name: 'Read', input_schema: {} },
      { name: 'Bash', input_schema: {} },
    ]);
  });

  it('strips ScheduleWakeup + CronCreate from upstream body when agentKind=batch', async () => {
    const forwardedTools = await runScheduleStripScenario('batch');
    expect(forwardedTools).toEqual([
      { name: 'Read', input_schema: {} },
      { name: 'Bash', input_schema: {} },
    ]);
  });

  it('preserves schedule-skill tools when agentKind=pty', async () => {
    const forwardedTools = await runScheduleStripScenario('pty');
    expect(forwardedTools).toEqual([
      { name: 'Read', input_schema: {} },
      { name: 'ScheduleWakeup', input_schema: {} },
      { name: 'CronCreate', input_schema: {} },
      { name: 'Bash', input_schema: {} },
    ]);
  });

  it('preserves schedule-skill tools when agentKind is unset (default-conservative)', async () => {
    const forwardedTools = await runScheduleStripScenario(undefined);
    expect(forwardedTools).toEqual([
      { name: 'Read', input_schema: {} },
      { name: 'ScheduleWakeup', input_schema: {} },
      { name: 'CronCreate', input_schema: {} },
      { name: 'Bash', input_schema: {} },
    ]);
  });

  it('rejects request bodies on rewrite endpoints in a Content-Encoding it cannot decode', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: rewriteProvider, fakeKey: rewriteFakeKey, realKey: rewriteRealKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.rewrite-test.com', 443);
    expect(socket).not.toBeNull();

    // gzip, deflate, br and zstd are decoded and then rewritten
    // (test/docker/request-sanitizer-openai.test.ts); other codings are refused.
    const response = await makeHttpsRequest(socket!, ca, 'api.rewrite-test.com', {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'x-api-key': rewriteFakeKey,
        'content-type': 'application/json',
        'content-encoding': 'compress',
      },
      body: 'compressed-bytes-here',
    });

    expect(response.statusCode).toBe(415);
    expect(response.body).toContain('unsupported Content-Encoding: compress');
  });

  it('handles client request body errors', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    // Do TLS handshake then send a request with chunked encoding that
    // gets cut off mid-stream to trigger an error on clientReq
    await new Promise<void>((resolve) => {
      const tlsSocket = tls.connect({ socket: socket!, servername: 'api.test.com', ca: ca.certPem }, () => {
        // Send a request with Transfer-Encoding: chunked, then destroy mid-body
        const reqLines = [
          'POST /v1/messages HTTP/1.1',
          'host: api.test.com',
          `x-api-key: ${fakeKey}`,
          'transfer-encoding: chunked',
          '',
          'ff', // claim 255 bytes of chunk data
          '', // but don't send the data
        ].join('\r\n');
        tlsSocket.write(reqLines);

        // Destroy mid-chunk to trigger an error
        setTimeout(() => {
          tlsSocket.destroy();
          resolve();
        }, 5);
      });
      tlsSocket.on('error', () => {});
    });

    // Wait for the socket destruction to propagate before checking proxy health
    await waitFor(() => socket!.destroyed);

    // Proxy should still be alive
    const { statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(statusCode).toBe(200);
  });

  // --- WebSocket upgrade support ---

  /**
   * Creates a minimal WebSocket echo server using raw Node.js HTTP.
   * Performs the WebSocket handshake manually and echoes text frames back.
   * Returns the server and the port it's listening on.
   */
  async function createWsEchoServer(): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('not a websocket');
    });

    server.on('upgrade', (req, socket, head) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      // Compute the accept key per RFC 6455
      const MAGIC = '258EAFA5-E914-47DA-95CA-5AB5DA085CD6';
      const accept = crypto
        .createHash('sha1')
        .update(key + MAGIC)
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          '\r\n',
      );

      if (head.length > 0) {
        // Echo the head buffer as-is (for testing)
        socket.write(head);
      }

      // Simple echo: pipe back any data received
      socket.on('data', (data: Buffer) => {
        socket.write(data);
      });
      socket.on('error', () => {});
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as import('node:net').AddressInfo).port);
      });
    });

    return { server, port };
  }

  /**
   * Sends a WebSocket upgrade request through the proxy via absolute URL
   * (plain HTTP proxy mode), returning the raw socket and response status line.
   */
  function sendWsUpgrade(
    proxySocketPath: string,
    targetHost: string,
    targetPort: number,
    wsPath: string,
  ): Promise<{ socket: import('node:net').Socket; statusLine: string; headers: Record<string, string> }> {
    return new Promise((resolve, reject) => {
      const wsKey = crypto.randomBytes(16).toString('base64');

      const req = http.request({
        socketPath: proxySocketPath,
        method: 'GET',
        path: `http://${targetHost}:${targetPort}${wsPath}`,
        headers: {
          host: `${targetHost}:${targetPort}`,
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': wsKey,
          'sec-websocket-version': '13',
        },
      });

      req.on('upgrade', (res, socket) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers[k] = v;
        }
        resolve({
          socket,
          statusLine: `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`,
          headers,
        });
      });

      req.on('response', (res) => {
        reject(new Error(`Expected upgrade but got response: ${res.statusCode}`));
        res.resume();
      });

      req.on('error', reject);
      req.end();
    });
  }

  it('bridges plain HTTP WebSocket upgrade through proxy', async () => {
    const { server: wsServer, port: wsPort } = await createWsEchoServer();

    try {
      // ws:// is plain HTTP, so the approval is `host:80`; the transport seam
      // carries that destination to the local echo server.
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        outboundTransport: localUpstreamTransport(wsPort),
      });
      await proxy.start();
      proxy.hosts.addHost('ws-echo.example.com', 80);

      const { socket, headers } = await sendWsUpgrade(socketPath, 'ws-echo.example.com', 80, '/echo');

      // Verify we got a proper WebSocket handshake response
      expect(headers['upgrade'].toLowerCase()).toBe('websocket');
      expect(headers['connection'].toLowerCase()).toBe('upgrade');
      expect(headers['sec-websocket-accept']).toBeDefined();

      // Test bidirectional data flow by sending raw bytes and checking the echo
      const testPayload = Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello" WS text frame
      const echoed = await new Promise<Buffer>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Echo timeout')), 2000);
        socket.once('data', (data: Buffer) => {
          clearTimeout(timeout);
          resolve(data);
        });
        socket.write(testPayload);
      });

      expect(echoed).toEqual(testPayload);
      socket.destroy();
    } finally {
      wsServer.close();
    }
  });

  it('returns 403 for WebSocket upgrade to non-passthrough domain', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [],
    });
    await proxy.start();

    // Try WebSocket upgrade to a domain not in the passthrough list
    const result = await new Promise<{ destroyed: boolean; data: string }>((resolve) => {
      const wsKey = crypto.randomBytes(16).toString('base64');

      const req = http.request({
        socketPath,
        method: 'GET',
        path: 'http://evil.example.com:8080/ws',
        headers: {
          host: 'evil.example.com:8080',
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': wsKey,
          'sec-websocket-version': '13',
        },
      });

      req.on('upgrade', (_res, socket) => {
        let data = '';
        socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
        socket.on('close', () => resolve({ destroyed: true, data }));
      });

      req.on('response', (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => resolve({ destroyed: false, data }));
      });

      // The proxy writes a raw 403 response to the socket, which the HTTP
      // client receives as a normal response (not an upgrade).
      req.on('error', () => resolve({ destroyed: true, data: '' }));
      req.end();
    });

    // The proxy should reject with 403 - either as a response or by destroying the socket
    expect(result.destroyed || result.data.includes('Forbidden') || result.data === '').toBe(true);
  });

  it('contains a synchronous WebSocket transport rejection and keeps serving requests', async () => {
    const rejectingTransport: OutboundTransport = {
      kind: 'direct',
      addressGuard: 'local-resolver',
      request() {
        throw new Error('synchronous WebSocket destination rejection');
      },
    };
    proxy = createMitmProxy({ socketPath, ca, providers: [], outboundTransport: rejectingTransport });
    await proxy.start();
    proxy.hosts.addHost('rejected-ws.example.com', 80);

    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        socketPath,
        method: 'GET',
        path: 'http://rejected-ws.example.com/ws',
        headers: {
          host: 'rejected-ws.example.com',
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
          'sec-websocket-version': '13',
        },
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('upgrade', (_res, socket) => {
        socket.destroy();
        reject(new Error('unexpected WebSocket upgrade'));
      });
      req.on('error', reject);
      req.end();
    });
    expect(statusCode).toBe(502);

    const health = await new Promise<number>((resolve, reject) => {
      const req = http.request({ socketPath, method: 'GET', path: 'http://not-approved.example.com/path' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(health).toBe(403);
  });

  it('serves an approved port-80 CONNECT tunnel as HTTP with the Host header pinned to the approved host', async () => {
    // The upstream echoes the Host it received and the path it was asked for.
    const httpServer = http.createServer((req, res) => {
      const body = JSON.stringify({ status: 'ok', host: req.headers.host, path: req.url });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    });

    const httpPort = await new Promise<number>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        resolve((httpServer.address() as import('node:net').AddressInfo).port);
      });
    });

    try {
      // A plain-HTTP tunnel is an approval for port 80. Both seams reach the
      // local fixture: a raw tunnel would use the dialer and relay the
      // client's bytes (and Host header) verbatim; the HTTP-aware tunnel
      // re-originates each request through the transport instead.
      const dials: net.TcpNetConnectOpts[] = [];
      const received: DestinationBoundRequest[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        tunnelDialForTests: localTunnelDialer(httpPort, dials),
        outboundTransport: localUpstreamTransport(httpPort, received),
      });
      await proxy.start();
      proxy.hosts.addHost('passthrough-http.example.com', 80);

      // Establish CONNECT tunnel
      const { socket, statusCode } = await sendConnect(socketPath, 'passthrough-http.example.com', 80);
      expect(statusCode).toBe(200);
      expect(socket).not.toBeNull();

      // Send plain HTTP through the tunnel (no TLS), naming another site in
      // the Host header: on a shared edge that would reach another tenant.
      const response = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Tunnel timeout')), 3000);
        let data = '';
        socket!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          // Check if we've received the full response
          if (data.includes('\r\n\r\n') && data.includes('}')) {
            clearTimeout(timeout);
            resolve(data);
          }
        });
        socket!.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        socket!.write('GET /health HTTP/1.1\r\nHost: other-tenant.example.net\r\nConnection: close\r\n\r\n');
      });

      expect(response).toContain('200 OK');
      const body = JSON.parse(response.slice(response.indexOf('{'))) as { host: string; path: string };
      expect(body).toEqual({ status: 'ok', host: 'passthrough-http.example.com', path: '/health' });
      expect(dials).toHaveLength(0);
      expect(received).toHaveLength(1);
      expect(received[0].destination).toEqual({
        protocol: 'http:',
        hostname: 'passthrough-http.example.com',
        port: 80,
      });
      socket!.destroy();
    } finally {
      httpServer.close();
    }
  });

  it('refuses bytes that are not HTTP, and absolute-form targets, inside an approved port-80 tunnel', async () => {
    const dials: net.TcpNetConnectOpts[] = [];
    const received: DestinationBoundRequest[] = [];
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [],
      tunnelDialForTests: unreachableTunnelDialer(dials),
      outboundTransport: localUpstreamTransport(9, received),
    });
    await proxy.start();
    proxy.hosts.addHost('plain-only.example.com', 80);

    // An SSH banner (or any other non-HTTP protocol) is a parse error, not a relay.
    const ssh = await sendConnect(socketPath, 'plain-only.example.com', 80);
    expect(ssh.statusCode).toBe(200);
    expect(await relayThroughTunnel(ssh.socket!, 'SSH-2.0-OpenSSH_9.6\r\n')).toContain('400 Bad Request');

    // The tunnel already names its destination; a request inside it may not
    // name another one.
    const absolute = await sendConnect(socketPath, 'plain-only.example.com', 80);
    expect(absolute.statusCode).toBe(200);
    const relayed = await relayThroughTunnel(
      absolute.socket!,
      'GET http://other-tenant.example.net/ HTTP/1.1\r\nHost: other-tenant.example.net\r\nConnection: close\r\n\r\n',
    );
    expect(relayed).toContain('400 Bad Request');

    // A nested CONNECT inside the tunnel is not a proxy primitive either.
    const nested = await sendConnect(socketPath, 'plain-only.example.com', 80);
    expect(nested.statusCode).toBe(200);
    expect(
      await relayThroughTunnel(nested.socket!, 'CONNECT other-tenant.example.net:443 HTTP/1.1\r\nHost: x\r\n\r\n'),
    ).not.toContain('200');

    expect(dials).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  it('closes a live port-80 tunnel when its approval is removed', async () => {
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '2' });
      res.end('ok');
    });
    const httpPort = await new Promise<number>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        resolve((httpServer.address() as import('node:net').AddressInfo).port);
      });
    });
    try {
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        outboundTransport: localUpstreamTransport(httpPort),
      });
      await proxy.start();
      proxy.hosts.addHost('revoked-plain.example.com', 80);

      const { socket, statusCode } = await sendConnect(socketPath, 'revoked-plain.example.com', 80);
      expect(statusCode).toBe(200);
      // A keep-alive exchange leaves the tunnel open afterwards.
      const first = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('tunnel timeout')), 3000);
        let data = '';
        socket!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          if (data.endsWith('\r\n\r\nok')) {
            clearTimeout(timeout);
            resolve(data);
          }
        });
        socket!.write('GET / HTTP/1.1\r\nHost: revoked-plain.example.com\r\n\r\n');
      });
      expect(first).toContain('200 OK');
      expect(socket!.destroyed).toBe(false);

      expect(proxy.hosts.removeHost('revoked-plain.example.com', 80)).toBe(true);
      await waitFor(() => socket!.destroyed, { timeoutMs: 2000 });

      const after = await sendConnect(socketPath, 'revoked-plain.example.com', 80);
      expect(after.statusCode).toBe(403);
      after.socket?.destroy();
    } finally {
      httpServer.close();
    }
  });

  it('refuses a passthrough CONNECT whose host resolves to a private address instead of tunneling it', async () => {
    // Same shape as the SNI-pinned tunnel tests below, minus the address-policy
    // opt-in: a reachable loopback listener proves the refusal is the guarded
    // resolver's doing and not a dead upstream.
    let upstreamConnections = 0;
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    httpServer.on('connection', () => {
      upstreamConnections += 1;
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    let lookups = 0;
    const countingLookup: MitmProxyOptions['dnsLookup'] = (_hostname, opts, cb) => {
      lookups += 1;
      if ((opts as { all?: boolean }).all) cb(null, [{ address: '127.0.0.1', family: 4 }] as never);
      else cb(null, '127.0.0.1', 4);
    };

    try {
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        // A resolver seam without `allowPrivateDestinationsForTests`: the
        // answers it returns are still screened.
        dnsLookup: countingLookup,
      });
      await proxy.start();
      proxy.hosts.addHost('rebind-passthrough.example.com');

      const { socket, statusCode } = await sendConnect(socketPath, 'rebind-passthrough.example.com', 443);
      // The CONNECT is acknowledged before the upstream dial, per standard
      // proxy behavior; the refusal shows up as a tunnel that relays nothing.
      expect(statusCode).toBe(200);
      expect(socket).not.toBeNull();

      // The ClientHello names the approved host, so the SNI gate passes and
      // the dial is attempted; the guarded resolver then refuses the loopback
      // answer and the tunnel is torn down before any byte is relayed.
      await expect(tlsHandshake(socket!, 'rebind-passthrough.example.com', ca.certPem)).rejects.toThrow();
      expect(lookups).toBeGreaterThan(0);
      expect(upstreamConnections).toBe(0);
    } finally {
      httpServer.close();
    }
  });

  it('MITMs nested HTTPS passthrough and uses only the fixed parent transport', async () => {
    const received: DestinationBoundRequest[] = [];
    const upstream = http.createServer((req, res) => {
      expect(req.url).toBe('/health');
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ route: 'fixed-parent' }));
    });
    const upstreamPort = await new Promise<number>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => {
        resolve((upstream.address() as import('node:net').AddressInfo).port);
      });
    });
    const fixedParentTransport: OutboundTransport = {
      kind: 'fixed-parent-proxy',
      addressGuard: 'local-resolver',
      request(request, onResponse) {
        received.push(request);
        return http.request(
          {
            hostname: '127.0.0.1',
            port: upstreamPort,
            method: request.method,
            path: request.path,
            headers: { ...request.headers, host: 'fixed-parent.test' },
          },
          onResponse,
        );
      },
    };

    try {
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        outboundTransport: fixedParentTransport,
      });
      await proxy.start();
      proxy.hosts.addHost('nested-passthrough.example.com');

      const { socket, statusCode } = await sendConnect(socketPath, 'nested-passthrough.example.com', 443);
      expect(statusCode).toBe(200);
      expect(socket).not.toBeNull();

      // This TLS handshake could not succeed if the proxy had retained its
      // direct-mode raw TCP tunnel: the only local upstream speaks HTTP.
      const response = await makeHttpsRequest(socket!, ca, 'nested-passthrough.example.com', {
        path: '/health',
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('fixed-parent');
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        destination: { protocol: 'https:', hostname: 'nested-passthrough.example.com', port: 443 },
        method: 'GET',
        path: '/health',
      });
    } finally {
      upstream.close();
    }
  });

  it('forwards WebSocket upgrade through CONNECT tunnel to passthrough domain', async () => {
    const { server: wsServer, port: wsPort } = await createWsEchoServer();

    try {
      // Plain ws:// is the port-80 approval. The HTTP-aware tunnel bridges
      // the upgrade through the destination-bound transport, which the seam
      // delivers to the local echo server.
      const received: DestinationBoundRequest[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        outboundTransport: localUpstreamTransport(wsPort, received),
      });
      await proxy.start();
      proxy.hosts.addHost('ws-tunnel.example.com', 80);

      // Establish CONNECT tunnel
      const { socket, statusCode } = await sendConnect(socketPath, 'ws-tunnel.example.com', 80);
      expect(statusCode).toBe(200);
      expect(socket).not.toBeNull();

      // Send WebSocket upgrade through the tunnel
      const wsKey = crypto.randomBytes(16).toString('base64');
      const upgradeResponse = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Upgrade timeout')), 3000);
        let data = '';
        socket!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          if (data.includes('\r\n\r\n')) {
            clearTimeout(timeout);
            resolve(data);
          }
        });
        socket!.write(
          `GET /echo HTTP/1.1\r\nHost: ws-tunnel.example.com:${wsPort}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });

      expect(upgradeResponse).toContain('101 Switching Protocols');
      expect(upgradeResponse.toLowerCase()).toContain('upgrade: websocket');

      // Test bidirectional data flow through the tunnel
      const testPayload = Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello" WS frame
      const echoed = await new Promise<Buffer>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Echo timeout')), 2000);
        socket!.once('data', (chunk: Buffer) => {
          clearTimeout(timeout);
          resolve(chunk);
        });
        socket!.write(testPayload);
      });

      expect(echoed).toEqual(testPayload);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        destination: { protocol: 'http:', hostname: 'ws-tunnel.example.com', port: 80 },
        headers: { host: 'ws-tunnel.example.com' },
      });
      socket!.destroy();
    } finally {
      wsServer.close();
    }
  });

  it('cleans up active WebSocket connections on stop()', async () => {
    const { server: wsServer, port: wsPort } = await createWsEchoServer();

    try {
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        outboundTransport: localUpstreamTransport(wsPort),
      });
      await proxy.start();
      proxy.hosts.addHost('ws-echo.example.com', 80);

      const { socket } = await sendWsUpgrade(socketPath, 'ws-echo.example.com', 80, '/echo');

      expect(socket.destroyed).toBe(false);

      // Stop the proxy - should destroy the WebSocket connections
      await proxy.stop();
      proxy = undefined;

      await waitFor(() => socket.destroyed);
      expect(socket.destroyed).toBe(true);
    } finally {
      wsServer.close();
    }
  });

  describe('CONNECT authority parsing', () => {
    const MALFORMED_AUTHORITIES = [
      'approved.example.com:99999',
      'approved.example.com:65536',
      'approved.example.com:abc',
      'approved.example.com:-1',
      'approved.example.com:0',
      'approved.example.com:443junk',
      'approved.example.com:0443',
      'approved.example.com',
      'approved.example.com:443:443',
      '::1:443',
      '[approved.example.com]:443',
      '[::1:443',
      'approved.example.com:443/path',
      'user@approved.example.com:443',
    ];

    it.each(MALFORMED_AUTHORITIES)(
      'refuses the malformed CONNECT authority %s before any tunnel and keeps serving',
      async (authority) => {
        const dials: net.TcpNetConnectOpts[] = [];
        proxy = createMitmProxy({
          socketPath,
          ca,
          providers: [{ config: testProvider, fakeKey, realKey }],
          tunnelDialForTests: unreachableTunnelDialer(dials),
        });
        await proxy.start();
        proxy.hosts.addHost('approved.example.com');

        expect(await rawConnectStatus(socketPath, authority)).toBe(400);
        expect(dials).toHaveLength(0);

        // The process is still here and the proxy still serves: the former
        // parser let Node throw ERR_SOCKET_BAD_PORT out of the connect listener.
        const { socket, statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
        expect(statusCode).toBe(200);
        socket?.destroy();
      },
    );

    it('accepts a canonical authority for an approved host and refuses every other port on it', async () => {
      const dials: net.TcpNetConnectOpts[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        tunnelDialForTests: unreachableTunnelDialer(dials),
      });
      await proxy.start();
      proxy.hosts.addHost('approved.example.com');

      // The approval is host:443. SSH, SMTP, plain HTTP or anything else on
      // that host is a different scope and is refused before any tunnel.
      for (const port of [22, 25, 80, 6379, 8443]) {
        const { socket, statusCode } = await sendConnect(socketPath, 'approved.example.com', port);
        expect(statusCode, `port ${port}`).toBe(403);
        socket?.destroy();
      }
      expect(dials).toHaveLength(0);

      const { socket, statusCode } = await sendConnect(socketPath, 'approved.example.com', 443);
      expect(statusCode).toBe(200);
      socket?.destroy();
    });

    it('routes a trailing-dot or mixed-case approved host to the same approval', async () => {
      const dials: net.TcpNetConnectOpts[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        tunnelDialForTests: unreachableTunnelDialer(dials),
      });
      await proxy.start();
      proxy.hosts.addHost('Approved.Example.com');

      for (const spelling of ['approved.example.com.', 'APPROVED.EXAMPLE.COM', 'approved.example.com']) {
        const { socket, statusCode } = await sendConnect(socketPath, spelling, 443);
        expect(statusCode, spelling).toBe(200);
        socket?.destroy();
      }
    });

    it('keys an IP-literal provider host by the canonical address the CONNECT parser reports', async () => {
      // A host-configured gateway may be addressed by literal; however it is
      // spelled in the configuration or on the wire, it is the same provider.
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: { ...testProvider, host: '[2001:DB8:0::5]' }, fakeKey, realKey }],
      });
      await proxy.start();

      expect(await rawConnectStatus(socketPath, '[2001:db8::5]:443')).toBe(200);
      expect(await rawConnectStatus(socketPath, '[2001:db8::6]:443')).toBe(403);
    });
  });

  describe('SNI-pinned passthrough tunnels', () => {
    it('relays an approved 443 tunnel end to end when the ClientHello names the approved host', async () => {
      const origin = await createLocalTlsOrigin(ca);
      const dials: net.TcpNetConnectOpts[] = [];
      try {
        proxy = createMitmProxy({
          socketPath,
          ca,
          providers: [],
          tunnelDialForTests: localTunnelDialer(origin.port, dials),
        });
        await proxy.start();
        proxy.hosts.addHost('pinned.example.com');

        const { socket, statusCode } = await sendConnect(socketPath, 'pinned.example.com', 443);
        expect(statusCode).toBe(200);
        expect(socket).not.toBeNull();

        // The raw tunnel carries the client's own TLS session to the origin;
        // the origin presents its own leaf for the SNI it receives.
        const response = await makeHttpsRequest(socket!, ca, 'pinned.example.com', { path: '/health' });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ sni: 'pinned.example.com', path: '/health' });
        expect(dials).toHaveLength(1);
        expect(dials[0]).toMatchObject({ host: 'pinned.example.com', port: 443 });
      } finally {
        await origin.close();
      }
    });

    it('refuses an approved 443 tunnel whose ClientHello names another host', async () => {
      const dials: net.TcpNetConnectOpts[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        tunnelDialForTests: unreachableTunnelDialer(dials),
      });
      await proxy.start();
      proxy.hosts.addHost('pinned.example.com');

      const { socket, statusCode } = await sendConnect(socketPath, 'pinned.example.com', 443);
      expect(statusCode).toBe(200);

      // Domain fronting: the approved CONNECT host with a different SNI (and
      // Host) inside the tunnel would reach another tenant of a shared edge.
      await expect(tlsHandshake(socket!, 'other-tenant.example.com', ca.certPem)).rejects.toThrow();
      expect(dials).toHaveLength(0);

      // The proxy keeps serving.
      const next = await sendConnect(socketPath, 'pinned.example.com', 443);
      expect(next.statusCode).toBe(200);
      next.socket?.destroy();
    });

    it('refuses an approved 443 tunnel whose ClientHello carries no SNI', async () => {
      const dials: net.TcpNetConnectOpts[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        tunnelDialForTests: unreachableTunnelDialer(dials),
      });
      await proxy.start();
      proxy.hosts.addHost('pinned.example.com');

      const { socket, statusCode } = await sendConnect(socketPath, 'pinned.example.com', 443);
      expect(statusCode).toBe(200);

      // A minimal TLS 1.2 ClientHello with one cipher suite and no extensions.
      const body = Buffer.concat([
        Buffer.from([0x03, 0x03]),
        crypto.randomBytes(32),
        Buffer.from([0x00]),
        Buffer.from([0x00, 0x02, 0x00, 0x2f]),
        Buffer.from([0x01, 0x00]),
      ]);
      const handshake = Buffer.concat([Buffer.from([0x01, 0x00, (body.length >> 8) & 0xff, body.length & 0xff]), body]);
      const record = Buffer.concat([
        Buffer.from([0x16, 0x03, 0x01, (handshake.length >> 8) & 0xff, handshake.length & 0xff]),
        handshake,
      ]);
      expect(await relayThroughTunnel(socket!, record)).toBe('');
      expect(dials).toHaveLength(0);
    });

    it('refuses non-TLS bytes on an approved 443 tunnel', async () => {
      const dials: net.TcpNetConnectOpts[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        tunnelDialForTests: unreachableTunnelDialer(dials),
      });
      await proxy.start();
      proxy.hosts.addHost('pinned.example.com');

      const { socket, statusCode } = await sendConnect(socketPath, 'pinned.example.com', 443);
      expect(statusCode).toBe(200);

      const relayed = await relayThroughTunnel(
        socket!,
        'GET / HTTP/1.1\r\nHost: pinned.example.com\r\nConnection: close\r\n\r\n',
      );
      expect(relayed).toBe('');
      expect(dials).toHaveLength(0);
    });

    it('tears down live tunnels when the approval is removed', async () => {
      const origin = await createLocalTlsOrigin(ca);
      try {
        proxy = createMitmProxy({
          socketPath,
          ca,
          providers: [],
          tunnelDialForTests: localTunnelDialer(origin.port),
        });
        await proxy.start();
        proxy.hosts.addHost('revoked.example.com');

        const { socket, statusCode } = await sendConnect(socketPath, 'revoked.example.com', 443);
        expect(statusCode).toBe(200);
        // One keep-alive exchange through the SNI-pinned tunnel; the TLS
        // session stays open afterwards.
        const tlsSocket = await tlsHandshake(socket!, 'revoked.example.com', ca.certPem);
        const first = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('tunnel timeout')), 3000);
          let data = '';
          tlsSocket.on('data', (chunk: Buffer) => {
            data += chunk.toString();
            if (data.endsWith('}')) {
              clearTimeout(timeout);
              resolve(data);
            }
          });
          tlsSocket.write('GET /live HTTP/1.1\r\nHost: revoked.example.com\r\n\r\n');
        });
        expect(first).toContain('200 OK');
        expect(tlsSocket.destroyed).toBe(false);

        // Revocation closes the live tunnel, not just future CONNECTs.
        expect(proxy.hosts.removeHost('revoked.example.com')).toBe(true);
        await waitFor(() => socket!.destroyed, { timeoutMs: 2000 });

        const after = await sendConnect(socketPath, 'revoked.example.com', 443);
        expect(after.statusCode).toBe(403);
        after.socket?.destroy();
      } finally {
        await origin.close();
      }
    });

    it('refuses an approved 443 tunnel whose SNI is a trailing-dot spelling of the approved host', async () => {
      const dials: net.TcpNetConnectOpts[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        tunnelDialForTests: unreachableTunnelDialer(dials),
      });
      await proxy.start();
      proxy.hosts.addHost('pinned.example.com');

      // The SNI is relayed to the origin verbatim, so only the exact name
      // (ASCII case aside) counts as the approved host.
      const record = buildClientHelloRecord('pinned.example.com.');
      const { socket, statusCode } = await sendConnect(socketPath, 'pinned.example.com', 443);
      expect(statusCode).toBe(200);
      expect(await relayThroughTunnel(socket!, record)).toBe('');
      expect(dials).toHaveLength(0);
    });

    it('accepts an approved 443 ClientHello split across TLS records and TCP writes', async () => {
      const dials: net.TcpNetConnectOpts[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        tunnelDialForTests: unreachableTunnelDialer(dials),
      });
      await proxy.start();
      proxy.hosts.addHost('pinned.example.com');

      const { socket, statusCode } = await sendConnect(socketPath, 'pinned.example.com', 443);
      expect(statusCode).toBe(200);
      // Fragment the handshake message over two records, then dribble the
      // bytes in small writes: the pin must reassemble before judging.
      const record = buildClientHelloRecord('PINNED.example.com', { splitAt: 20 });
      for (let offset = 0; offset < record.length; offset += 7) {
        socket!.write(record.subarray(offset, offset + 7));
        await new Promise((resolve) => setImmediate(resolve));
      }
      await waitFor(() => dials.length === 1, { timeoutMs: 2000 });
      expect(dials[0]).toMatchObject({ host: 'pinned.example.com', port: 443 });
      socket!.destroy();
    });

    it('relays an ECH ClientHello whose outer SNI is the approved host, since GREASE ECH looks the same', async () => {
      const dials: net.TcpNetConnectOpts[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        tunnelDialForTests: unreachableTunnelDialer(dials),
      });
      await proxy.start();
      proxy.hosts.addHost('pinned.example.com');

      // An encrypted_client_hello extension (outer type, a config id, a
      // cipher suite, empty enc and payload). Chromium sends GREASE ECH like
      // this on every connection, so the pin judges the outer SNI only; the
      // tunnel logs that the inner name is not visible (see openPassthroughTunnel).
      const ech = encodeExtension(0xfe0d, Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x2a, 0x00, 0x00, 0x00, 0x00]));
      const { socket, statusCode } = await sendConnect(socketPath, 'pinned.example.com', 443);
      expect(statusCode).toBe(200);
      socket!.write(buildClientHelloRecord('pinned.example.com', { extraExtensions: ech }));
      await waitFor(() => dials.length === 1, { timeoutMs: 2000 });
      expect(dials[0]).toMatchObject({ host: 'pinned.example.com', port: 443 });
      socket!.destroy();
    });

    it('closes a TLS-terminated (nested) passthrough connection when its approval is removed', async () => {
      const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '2' });
        res.end('ok');
      });
      const upstreamPort = await new Promise<number>((resolve) => {
        upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as net.AddressInfo).port));
      });
      const nestedTransport: OutboundTransport = {
        kind: 'fixed-parent-proxy',
        addressGuard: 'local-resolver',
        request(request, onResponse) {
          return http.request(
            {
              hostname: '127.0.0.1',
              port: upstreamPort,
              method: request.method,
              path: request.path,
              headers: request.headers,
            },
            onResponse,
          );
        },
      };
      try {
        proxy = createMitmProxy({ socketPath, ca, providers: [], outboundTransport: nestedTransport });
        await proxy.start();
        proxy.hosts.addHost('nested-revoked.example.com');

        const { socket, statusCode } = await sendConnect(socketPath, 'nested-revoked.example.com', 443);
        expect(statusCode).toBe(200);
        const tlsSocket = await tlsHandshake(socket!, 'nested-revoked.example.com', ca.certPem);
        tlsSocket.on('error', () => undefined);
        // One keep-alive exchange; the decrypted connection stays open.
        const first = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('no response through the nested passthrough')), 3000);
          let data = '';
          tlsSocket.on('data', (chunk: Buffer) => {
            data += chunk.toString();
            if (data.endsWith('ok')) {
              clearTimeout(timeout);
              resolve(data);
            }
          });
          tlsSocket.write('GET /live HTTP/1.1\r\nHost: nested-revoked.example.com\r\n\r\n');
        });
        expect(first).toContain('200 OK');
        expect(tlsSocket.destroyed).toBe(false);

        // Revocation reaches the decrypted keep-alive connection too.
        expect(proxy.hosts.removeHost('nested-revoked.example.com')).toBe(true);
        await waitFor(() => tlsSocket.destroyed, { timeoutMs: 2000 });
      } finally {
        upstream.closeAllConnections();
        upstream.close();
      }
    });

    it('refuses to approve a package-registry host as passthrough', async () => {
      const npmRegistry: RegistryConfig = { host: 'registry.npmjs.org', displayName: 'npm', type: 'npm' };
      proxy = createMitmProxy({ socketPath, ca, providers: [], registries: [npmRegistry] });
      await proxy.start();

      expect(proxy.hosts.addHost('registry.npmjs.org')).toBe(false);
      expect(proxy.hosts.addHost('registry.npmjs.org', 80)).toBe(false);
      expect(proxy.hosts.listHosts().dynamic).toEqual([]);

      // The registry keeps its validated MITM path: the proxy presents a
      // CA-signed certificate rather than a raw tunnel.
      const { socket, statusCode } = await sendConnect(socketPath, 'registry.npmjs.org', 443);
      expect(statusCode).toBe(200);
      const tlsSocket = await tlsHandshake(socket!, 'registry.npmjs.org', ca.certPem);
      tlsSocket.destroy();
    });

    it('contains a synchronous transport rejection on the TLS-terminated passthrough path', async () => {
      const rejectingTransport: OutboundTransport = {
        kind: 'fixed-parent-proxy',
        addressGuard: 'local-resolver',
        request() {
          throw new Error('synchronous nested destination rejection');
        },
      };
      proxy = createMitmProxy({ socketPath, ca, providers: [], outboundTransport: rejectingTransport });
      await proxy.start();
      proxy.hosts.addHost('nested-rejected.example.com');

      const { socket, statusCode } = await sendConnect(socketPath, 'nested-rejected.example.com', 443);
      expect(statusCode).toBe(200);
      const response = await makeHttpsRequest(socket!, ca, 'nested-rejected.example.com', { path: '/health' });
      expect(response.statusCode).toBe(502);
      expect(response.body).toContain('synchronous nested destination rejection');

      // Still alive, still enforcing.
      const denied = await sendConnect(socketPath, 'not-approved.example.com', 443);
      expect(denied.statusCode).toBe(403);
      denied.socket?.destroy();
    });

    it('refuses a TLS-terminated passthrough handshake whose SNI names another host', async () => {
      const fixedParentTransport: OutboundTransport = {
        kind: 'fixed-parent-proxy',
        addressGuard: 'local-resolver',
        request() {
          throw new Error('must not be reached');
        },
      };
      proxy = createMitmProxy({ socketPath, ca, providers: [], outboundTransport: fixedParentTransport });
      await proxy.start();
      proxy.hosts.addHost('nested-pinned.example.com');

      const { socket, statusCode } = await sendConnect(socketPath, 'nested-pinned.example.com', 443);
      expect(statusCode).toBe(200);
      await expect(tlsHandshake(socket!, 'other-tenant.example.com', ca.certPem)).rejects.toThrow();
    });
  });

  describe('OAuth refresh and credential isolation', () => {
    it('does not inject a refreshed OAuth token into a request that carried a non-sentinel key', async () => {
      let seenKey: string | undefined;
      const upstream = http.createServer((req, res) => {
        seenKey = String(req.headers['x-api-key'] ?? '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      const upstreamPort = await new Promise<number>((resolve) => {
        upstream.listen(0, '127.0.0.1', () => {
          resolve((upstream.address() as import('node:net').AddressInfo).port);
        });
      });
      const oauthProvider: ProviderConfig = {
        ...testProvider,
        upstreamTarget: { hostname: '127.0.0.1', port: upstreamPort, pathPrefix: '', useTls: false },
      };
      // The proactive refresh yields a token different from the stored one,
      // which is exactly the moment the real token used to be injected into
      // any request that carried a key at all.
      const tokenManager = {
        getValidAccessToken: async () => 'rotated-real-token',
        handleAuthFailure: async () => 'rotated-real-token',
      } as OAuthTokenManager;

      try {
        proxy = createMitmProxy({
          socketPath,
          ca,
          providers: [{ config: oauthProvider, fakeKey, realKey: 'stale-real-token', tokenManager }],
          dnsLookup: localhostDnsLookup,
        });
        await proxy.start();

        // The credential gate refuses a non-sentinel key locally, so neither the
        // agent's key nor the rotated real token reaches the upstream.
        const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
        const response = await makeHttpsRequest(socket!, ca, 'api.test.com', {
          method: 'GET',
          path: '/v1/models',
          headers: { 'x-api-key': 'agent-own-key' },
        });
        expect(response.statusCode).toBe(401);
        expect(seenKey).toBeUndefined();

        // The same proxy does refresh and inject the real token for the sentinel.
        const { socket: sentinelSocket } = await sendConnect(socketPath, 'api.test.com', 443);
        const sentinelResponse = await makeHttpsRequest(sentinelSocket!, ca, 'api.test.com', {
          method: 'GET',
          path: '/v1/models',
          headers: { 'x-api-key': fakeKey },
        });
        expect(sentinelResponse.statusCode).toBe(200);
        expect(seenKey).toBe('rotated-real-token');
      } finally {
        await new Promise<void>((resolve, reject) => {
          upstream.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });
  });

  describe('TCP listener binding', () => {
    it('binds loopback by default, reports the bound address and serves the sidecar health probe', async () => {
      proxy = createMitmProxy({ listenPort: 0, ca, providers: [{ config: testProvider, fakeKey, realKey }] });
      const addr = await proxy.start();
      expect(addr.host).toBe('127.0.0.1');
      expect(addr.port).toBeGreaterThan(0);

      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: addr.port,
            method: 'GET',
            path: 'http://ironcurtain.invalid/__ironcurtain/health',
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              body += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(response).toEqual({ status: 200, body: 'IRONCURTAIN_OK/1\n' });
    });

    it('refuses a non-loopback bind that has no connection-source guard', () => {
      expect(() =>
        createMitmProxy({
          listenPort: 0,
          listenHost: '0.0.0.0',
          ca,
          providers: [{ config: testProvider, fakeKey, realKey }],
        }),
      ).toThrow(/allowRemoteAddress/u);
    });

    it('binds the requested wider address when a connection-source guard is supplied', async () => {
      proxy = createMitmProxy({
        listenPort: 0,
        listenHost: '0.0.0.0',
        allowRemoteAddress: (remote) => remote === '127.0.0.1' || remote === '::ffff:127.0.0.1',
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
      });
      const addr = await proxy.start();
      expect(addr.host).toBe('0.0.0.0');
    });

    it('rejects the tunnel dial seam outside NODE_ENV=test', () => {
      const saved = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect(() =>
          createMitmProxy({
            socketPath,
            ca,
            providers: [],
            tunnelDialForTests: unreachableTunnelDialer([]),
          }),
        ).toThrow(/NODE_ENV=test/u);
      } finally {
        if (saved === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = saved;
      }
    });
  });

  describe('IRONCURTAIN_MITM_ALLOW_ALL_HOSTS escape hatch', () => {
    const ENV_KEY = 'IRONCURTAIN_MITM_ALLOW_ALL_HOSTS';
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
    });

    afterEach(() => {
      if (savedEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = savedEnv;
    });

    it.each([
      '127.0.0.1:443',
      '[::1]:443',
      '0.0.0.0:443',
      '169.254.169.254:80',
      '[::ffff:127.0.0.1]:443',
      '127.1:443',
      '2130706433:443',
      '10.0.0.1:443',
      '[fe80::1]:443',
    ])('refuses CONNECT to the non-public IP literal %s even when set', async (authority) => {
      process.env[ENV_KEY] = '1';
      const dials: net.TcpNetConnectOpts[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
        tunnelDialForTests: unreachableTunnelDialer(dials),
      });
      await proxy.start();

      // IP literals never reach the guarded resolver, so the screen has to
      // happen at the CONNECT boundary; a name resolving to loopback is already
      // refused by the resolver, and a literal must not do better.
      expect(await rawConnectStatus(socketPath, authority)).toBe(403);
      expect(dials).toHaveLength(0);
    });

    it.each(['127.0.0.1..:443', '127.1..:443', '0x7f.1..:443', '2130706433..:443', '169.254.169.254..:80'])(
      'refuses CONNECT to %s, a name whose canonical form is a non-public literal, without dialing',
      async (authority) => {
        process.env[ENV_KEY] = '1';
        const dials: net.TcpNetConnectOpts[] = [];
        proxy = createMitmProxy({
          socketPath,
          ca,
          providers: [{ config: testProvider, fakeKey, realKey }],
          tunnelDialForTests: unreachableTunnelDialer(dials),
        });
        await proxy.start();

        // Every literal classifier reads these as names (the last label is
        // empty), yet stripping one trailing dot before the URL host parser
        // dropped the other made them `127.0.0.1`: a "name" the tunnel dialed
        // without the guarded resolver, reaching host loopback under the flag.
        expect(await rawConnectStatus(socketPath, authority)).toBe(400);
        expect(dials).toHaveLength(0);
      },
    );

    it('rejects an unbracketed IPv6 CONNECT authority instead of guessing at it', async () => {
      process.env[ENV_KEY] = '1';
      const dials: net.TcpNetConnectOpts[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
        tunnelDialForTests: unreachableTunnelDialer(dials),
      });
      await proxy.start();

      expect(await rawConnectStatus(socketPath, '::1:443')).toBe(400);
      expect(dials).toHaveLength(0);
    });

    it.each(['localhost:443', 'metadata.google.internal:80', 'printer.local:443', 'host.docker.internal:22'])(
      'refuses CONNECT to the local or metadata name %s without dialing, even when set',
      async (authority) => {
        process.env[ENV_KEY] = '1';
        const dials: net.TcpNetConnectOpts[] = [];
        proxy = createMitmProxy({
          socketPath,
          ca,
          providers: [{ config: testProvider, fakeKey, realKey }],
          tunnelDialForTests: unreachableTunnelDialer(dials),
        });
        await proxy.start();

        // Defense in depth for the raw tunnel, which otherwise relies on the
        // guarded resolver alone: these names are refused before the 200.
        expect(await rawConnectStatus(socketPath, authority)).toBe(403);
        expect(dials).toHaveLength(0);
      },
    );

    it('tunnels a public IP literal when set, under the canonical address', async () => {
      process.env[ENV_KEY] = '1';
      const dials: net.TcpNetConnectOpts[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
        tunnelDialForTests: unreachableTunnelDialer(dials),
      });
      await proxy.start();

      const { socket, statusCode } = await sendConnect(socketPath, '[2001:db8::1]', 443);
      // 2001:db8::/32 is documentation space, not public: refused.
      expect(statusCode).toBe(403);
      socket?.destroy();

      const publicLiteral = await sendConnect(socketPath, '93.184.216.34', 443);
      expect(publicLiteral.statusCode).toBe(200);
      expect(dials).toHaveLength(1);
      expect(dials[0]).toMatchObject({ host: '93.184.216.34', port: 443 });
      publicLiteral.socket?.destroy();
    });

    it('routes a trailing-dot provider CONNECT through MITM (not the wildcard tunnel) when set', async () => {
      // `api.test.com.` is the same name as `api.test.com`. Without
      // canonicalization it misses the provider map and becomes an "unknown"
      // host, which the wildcard would hand a raw tunnel: no key swap, no
      // endpoint filtering, no capture.
      process.env[ENV_KEY] = '1';
      const dials: net.TcpNetConnectOpts[] = [];
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
        tunnelDialForTests: unreachableTunnelDialer(dials),
      });
      await proxy.start();

      for (const spelling of ['api.test.com.', 'API.TEST.COM.']) {
        const { socket, statusCode } = await sendConnect(socketPath, spelling, 443);
        expect(statusCode, spelling).toBe(200);
        // The MITM path presents the proxy's CA-signed certificate; a raw
        // tunnel to nowhere could not complete this handshake.
        const tlsSocket = await tlsHandshake(socket!, 'api.test.com', ca.certPem);
        tlsSocket.destroy();
      }
      expect(dials).toHaveLength(0);
    });

    it('routes a trailing-dot registry name through registry validation (not the wildcard) when set', async () => {
      process.env[ENV_KEY] = '1';
      const debianRegistry: RegistryConfig = { host: 'deb.debian.org', displayName: 'Debian', type: 'debian' };
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        registries: [debianRegistry],
        packageValidation: { validator: DENY_ALL_VALIDATOR },
      });
      await proxy.start();

      const denied = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            socketPath,
            method: 'GET',
            path: 'http://DEB.DEBIAN.ORG./debian/pool/main/l/libssl3/libssl3_3.0.11-1~deb12u2_arm64.deb',
          },
          (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => (data += chunk.toString()));
            res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
          },
        );
        req.on('error', reject);
        req.end();
      });
      // DENY_ALL_VALIDATOR names the package: the registry handler ran, not a
      // wildcard passthrough that would have fetched the .deb unvalidated.
      expect(denied.statusCode).toBe(403);
      expect(denied.body).toContain('libssl3');
    });

    it('refuses plain HTTP and WebSocket proxy requests to non-public IP literals even when set', async () => {
      process.env[ENV_KEY] = '1';
      const upstreamCalls: DestinationBoundRequest[] = [];
      const recordingTransport: OutboundTransport = {
        kind: 'direct',
        addressGuard: 'local-resolver',
        request(request) {
          upstreamCalls.push(request);
          throw new Error('must not be reached');
        },
      };
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
        outboundTransport: recordingTransport,
      });
      await proxy.start();

      for (const target of ['http://127.0.0.1:8080/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/']) {
        const statusCode = await new Promise<number>((resolve, reject) => {
          const req = http.request({ socketPath, method: 'GET', path: target }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on('error', reject);
          req.end();
        });
        expect(statusCode, target).toBe(403);
      }

      const wsRejected = await new Promise<boolean>((resolve) => {
        const req = http.request({
          socketPath,
          method: 'GET',
          path: 'http://127.0.0.1:8080/ws',
          headers: {
            host: '127.0.0.1:8080',
            upgrade: 'websocket',
            connection: 'Upgrade',
            'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
            'sec-websocket-version': '13',
          },
        });
        req.on('upgrade', (_res, socket) => {
          socket.destroy();
          resolve(false);
        });
        req.on('response', (res) => {
          resolve(res.statusCode === 403);
          res.resume();
        });
        req.on('error', () => resolve(true));
        req.end();
      });
      expect(wsRejected).toBe(true);
      expect(upstreamCalls).toHaveLength(0);
    });

    it('allows CONNECT to an unknown host when set', async () => {
      process.env[ENV_KEY] = '1';
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
      });
      await proxy.start();

      const { socket, statusCode } = await sendConnect(socketPath, 'random.example.com', 443);
      expect(statusCode).toBe(200);
      socket?.destroy();
    });

    it('denies CONNECT to an unknown host when unset (default)', async () => {
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
      });
      await proxy.start();

      const { socket, statusCode } = await sendConnect(socketPath, 'random.example.com', 443);
      expect(statusCode).toBe(403);
      socket?.destroy();
    });

    it('still routes provider CONNECT through MITM (not wildcard tunnel) when set', async () => {
      process.env[ENV_KEY] = '1';
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
      });
      await proxy.start();

      const { socket, statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
      expect(statusCode).toBe(200);
      expect(socket).not.toBeNull();

      // If MITM is active (provider path), the proxy presents a CA-signed cert
      // for api.test.com. If the wildcard wrongly took over the provider host,
      // this would be a raw TCP tunnel to nowhere and the TLS handshake would fail.
      await new Promise<void>((resolve, reject) => {
        const tlsSocket = tls.connect(
          {
            socket: socket!,
            servername: 'api.test.com',
            ca: ca.certPem,
          },
          () => {
            tlsSocket.destroy();
            resolve();
          },
        );
        tlsSocket.on('error', reject);
      });
    });

    it('accepts "true" as well as "1"', async () => {
      process.env[ENV_KEY] = 'true';
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
      });
      await proxy.start();

      const { socket, statusCode } = await sendConnect(socketPath, 'random.example.com', 443);
      expect(statusCode).toBe(200);
      socket?.destroy();
    });

    it('never tunnels an unlisted host on a registry-egress listener, even when set', async () => {
      // An egress listener has no providers and no registries, so *every* host
      // would be wildcard-eligible. Passthrough must not exist in that mode:
      // the tunnel never consults the guard, so a wildcard tunnel here would be
      // an unmediated route around the frozen manifest.
      process.env[ENV_KEY] = '1';
      let upstreamCalls = 0;
      const unreachableTransport: OutboundTransport = {
        // `direct` is the kind that would have selected the raw tunnel branch.
        kind: 'direct',
        addressGuard: 'local-resolver',
        request() {
          upstreamCalls += 1;
          throw new Error('an egress listener must not reach upstream for an unlisted host');
        },
      };
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        registryEgress: { guard: createRegistryEgressGuard({ mode: 'disabled' }) },
        outboundTransport: unreachableTransport,
      });
      await proxy.start();

      const { socket, statusCode } = await sendConnect(socketPath, 'random.example.com', 443);
      // Registry mode rejects an unlisted CONNECT before acknowledging a
      // tunnel, creating a TLS context/certificate, or contacting upstream.
      expect(statusCode).toBe(403);
      // Node may surface the client Socket object even for a non-2xx CONNECT
      // response. That is not an acknowledged tunnel; require it to close.
      if (socket !== null) await waitFor(() => socket.destroyed);
      expect(upstreamCalls).toBe(0);
    });

    it('routes mixed-case provider CONNECT through MITM (case-insensitive allowlist)', async () => {
      // The provider is registered as `api.test.com`. A CONNECT request with
      // the host in mixed case must match the allowlist and go through MITM —
      // not fall through to the wildcard tunnel and bypass key/endpoint checks.
      process.env[ENV_KEY] = '1';
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
      });
      await proxy.start();

      const { socket, statusCode } = await sendConnect(socketPath, 'API.TEST.COM', 443);
      expect(statusCode).toBe(200);
      expect(socket).not.toBeNull();

      // Confirm the MITM path (not raw tunnel) by completing a TLS handshake
      // against the proxy's CA-signed cert for api.test.com.
      await new Promise<void>((resolve, reject) => {
        const tlsSocket = tls.connect(
          {
            socket: socket!,
            servername: 'api.test.com',
            ca: ca.certPem,
          },
          () => {
            tlsSocket.destroy();
            resolve();
          },
        );
        tlsSocket.on('error', reject);
      });
    });

    it('treats mixed-case provider host as allowed even with wildcard off', async () => {
      // Sanity check that case normalization works for the default allowlist
      // path too — not just under the wildcard. Without normalization, this
      // CONNECT would 403 because providersByHost is keyed by `api.test.com`.
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
      });
      await proxy.start();

      const { socket, statusCode } = await sendConnect(socketPath, 'API.TEST.COM', 443);
      expect(statusCode).toBe(200);
      socket?.destroy();
    });

    it('forwards plain HTTP proxy requests to unknown hosts when set', async () => {
      const httpServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello-from-unknown');
      });
      const httpPort = await new Promise<number>((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => {
          resolve((httpServer.address() as import('node:net').AddressInfo).port);
        });
      });

      try {
        process.env[ENV_KEY] = '1';
        proxy = createMitmProxy({
          socketPath,
          ca,
          providers: [{ config: testProvider, fakeKey, realKey }],
          dnsLookup: localhostDnsLookup,
          allowPrivateDestinationsForTests: true,
        });
        await proxy.start();

        const { statusCode, body } = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
          const req = http.request(
            {
              socketPath,
              method: 'GET',
              path: `http://unknown.example.com:${httpPort}/`,
              headers: { host: `unknown.example.com:${httpPort}` },
            },
            (res) => {
              let data = '';
              res.on('data', (chunk: Buffer) => (data += chunk.toString()));
              res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
            },
          );
          req.on('error', reject);
          req.end();
        });

        expect(statusCode).toBe(200);
        expect(body).toBe('hello-from-unknown');
      } finally {
        httpServer.close();
      }
    });

    it('returns 403 for plain HTTP proxy requests to provider hosts even when set', async () => {
      process.env[ENV_KEY] = '1';
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
        dnsLookup: localhostDnsLookup,
        allowPrivateDestinationsForTests: true,
      });
      await proxy.start();

      // Plain HTTP to a known provider host must NOT be widened by the
      // wildcard — providers only accept their MITM/HTTPS path.
      const statusCode = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            socketPath,
            method: 'GET',
            path: 'http://api.test.com/v1/messages',
            headers: { host: 'api.test.com' },
          },
          (res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(statusCode).toBe(403);
    });

    it('allows ws:// upgrade to an unknown host when set', async () => {
      const { server: wsServer, port: wsPort } = await createWsEchoServer();
      try {
        process.env[ENV_KEY] = '1';
        proxy = createMitmProxy({
          socketPath,
          ca,
          providers: [{ config: testProvider, fakeKey, realKey }],
          dnsLookup: localhostDnsLookup,
          allowPrivateDestinationsForTests: true,
        });
        await proxy.start();

        const { socket, headers } = await sendWsUpgrade(socketPath, 'ws-unknown.example.com', wsPort, '/echo');
        expect(headers['upgrade'].toLowerCase()).toBe('websocket');
        expect(headers['sec-websocket-accept']).toBeDefined();
        socket.destroy();
      } finally {
        wsServer.close();
      }
    });

    it('rejects ws:// upgrade to a provider host even when set', async () => {
      process.env[ENV_KEY] = '1';
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [{ config: testProvider, fakeKey, realKey }],
        dnsLookup: localhostDnsLookup,
        allowPrivateDestinationsForTests: true,
      });
      await proxy.start();

      // The proxy writes a raw 403 line and closes the socket, so the HTTP
      // client may surface this as either a response or an error/close.
      const rejected = await new Promise<boolean>((resolve) => {
        const wsKey = crypto.randomBytes(16).toString('base64');
        const req = http.request({
          socketPath,
          method: 'GET',
          path: 'http://api.test.com/ws',
          headers: {
            host: 'api.test.com',
            upgrade: 'websocket',
            connection: 'Upgrade',
            'sec-websocket-key': wsKey,
            'sec-websocket-version': '13',
          },
        });
        req.on('upgrade', (_res, socket) => {
          socket.destroy();
          resolve(false);
        });
        req.on('response', (res) => {
          resolve(res.statusCode === 403);
          res.resume();
        });
        req.on('error', () => resolve(true));
        req.end();
      });
      expect(rejected).toBe(true);
    });
  });
});
