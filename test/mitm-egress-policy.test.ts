/**
 * Policy-evaluated MITM egress (WP-118, docs/designs/mitm-egress-policy.md).
 *
 * The opt-in egress gate models every destination that is neither a
 * provider nor a registry as a call to the virtual `network/request` tool:
 * the coordinator evaluates it (CONNECT at host:port, readable requests at
 * path granularity), routes escalations through its normal channel, audits
 * every decision, and the proxy remembers human decisions per host:port
 * (escalate-once). IRONCURTAIN_MITM_ALLOW_ALL_HOSTS is deprecated: it still
 * works without the opt-in, prints a deprecation warning, and is ignored
 * with it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createLeafSecureContextCache, loadOrCreateCA, type CertificateAuthority } from '../src/docker/ca.js';
import { createMitmProxy, type MitmProxy, type MitmProxyOptions, type TunnelDialer } from '../src/docker/mitm-proxy.js';
import type { DestinationBoundRequest, OutboundTransport } from '../src/docker/outbound-transport.js';
import type { ProviderConfig } from '../src/docker/provider-config.js';
import type { RegistryConfig } from '../src/docker/package-types.js';
import { DENY_ALL_VALIDATOR } from '../src/docker/package-validator.js';
import { createRegistryEgressGuard } from '../src/docker/registry-egress-proxy.js';
import {
  ToolCallCoordinator,
  type EscalationPromptDetails,
  type EscalationPromptFn,
} from '../src/trusted-process/tool-call-coordinator.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { isAuditLogUnavailableError } from '../src/trusted-process/audit-log.js';
import type { ClientState, ProxiedTool } from '../src/trusted-process/tool-call-pipeline.js';
import {
  EGRESS_ALLOWED_HOSTS_RULE,
  EGRESS_DESTINATION_RULE,
  EGRESS_ESCALATE_RULE,
  EGRESS_ESCALATION_LIMIT_RULE,
  EGRESS_MALFORMED_RULE,
  EGRESS_PORT_RULE,
  MAX_PENDING_EGRESS_ESCALATIONS,
  buildEgressPolicyRules,
  mergeEgressAnnotations,
  screenEgressDestination,
  type EgressAuthorizer,
  type EgressDecision,
  type EgressRequest,
} from '../src/trusted-process/egress-policy.js';
import { canonicalEgressHostPattern } from '../src/net/egress-host-pattern.js';
import { egressPolicyOptionsFor } from '../src/sandbox/index.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { CompiledRule } from '../src/pipeline/types.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_PROTECTED_PATHS,
  TEST_SANDBOX_DIR,
} from './fixtures/test-policy.js';
import * as logger from '../src/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOW_ALL_HOSTS = 'IRONCURTAIN_MITM_ALLOW_ALL_HOSTS';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
      if (condition()) resolve();
      else if (Date.now() > deadline) reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      else setTimeout(check, 5);
    };
    check();
  });
}

interface AuditRecord {
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  policyDecision: { status: string; rule: string; reason: string };
  escalationResult?: string;
  result: { status: string; error?: string };
  persona?: string;
}

function readAudit(path: string): AuditRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

/** Sends a CONNECT over the proxy's UDS and returns the status (and the socket when established). */
function sendConnect(
  socketPath: string,
  host: string,
  port: number,
): Promise<{ socket: net.Socket | null; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'CONNECT', path: `${host}:${port}` });
    req.on('connect', (res, socket) => resolve({ socket, statusCode: res.statusCode ?? 0 }));
    req.on('response', (res) => resolve({ socket: null, statusCode: res.statusCode ?? 0 }));
    req.on('error', reject);
    req.end();
  });
}

/** One HTTPS request through an acknowledged tunnel; resolves with the response body. */
function httpsThroughTunnel(socket: net.Socket, ca: CertificateAuthority, host: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: host, ca: ca.certPem }, () => {
      tlsSocket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    tlsSocket.on('data', (chunk: Buffer) => (data += chunk.toString()));
    tlsSocket.on('end', () => resolve(data.split('\r\n\r\n').slice(1).join('\r\n\r\n')));
    tlsSocket.on('error', reject);
  });
}

/** Starts a TLS handshake over an acknowledged tunnel; rejects when the tunnel is refused instead. */
function tlsHandshake(socket: net.Socket, servername: string, caPem: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername, ca: caPem }, () => resolve(tlsSocket));
    tlsSocket.once('error', reject);
    tlsSocket.once('close', () => reject(new Error('tunnel closed before the TLS handshake completed')));
  });
}

/** A local HTTPS origin presenting CA-signed leaves for whatever SNI it receives. */
async function createLocalTlsOrigin(ca: CertificateAuthority): Promise<{ port: number; close(): Promise<void> }> {
  const leafContext = createLeafSecureContextCache(ca);
  const server = https.createServer({ SNICallback: (name, cb) => cb(null, leafContext(name)) }, (req, res) => {
    const body = JSON.stringify({ sni: (req.socket as tls.TLSSocket).servername, path: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
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

/** A local plain-HTTP origin (with WebSocket upgrades) recording what it saw. */
async function createLocalHttpOrigin(): Promise<{ port: number; seen: string[]; close(): Promise<void> }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method ?? ''} ${req.url ?? ''} host=${req.headers.host ?? ''}`);
    res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end(`ORIGIN ${req.url ?? ''}`);
  });
  server.on('upgrade', (req, socket) => {
    seen.push(`upgrade ${req.url ?? ''}`);
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
  return {
    port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Delivers every destination-bound request to 127.0.0.1:`port`, recording what was asked for. */
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

/** Raw-tunnel dialer reaching a local fixture instead of `host:port`, recording every dial. */
function localTunnelDialer(port: number, dials: net.TcpNetConnectOpts[] = []): TunnelDialer {
  return (options) => {
    dials.push(options);
    return net.connect({ host: '127.0.0.1', port });
  };
}

/** Dialer that must never be reached. */
function unreachableTunnelDialer(dials: net.TcpNetConnectOpts[]): TunnelDialer {
  return (options) => {
    dials.push(options);
    return new net.Socket();
  };
}

/** A plain-HTTP request through the proxy (absolute-form). */
function plainHttpThroughProxy(socketPath: string, url: string): Promise<{ statusCode: number; body: string }> {
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

/** An authorizer double that records every request and answers with `decide`. */
function recordingAuthorizer(
  decide: (request: EgressRequest) => EgressDecision | Promise<EgressDecision>,
): EgressAuthorizer & { requests: EgressRequest[] } {
  const requests: EgressRequest[] = [];
  return {
    requests,
    async authorizeEgress(request) {
      requests.push(request);
      return decide(request);
    },
  };
}

const ALLOWED_BY_RULE: EgressDecision = { allowed: true, settledBy: 'policy', rule: 'test-allow', reason: 'test' };
const DENIED_BY_RULE: EgressDecision = { allowed: false, settledBy: 'policy', rule: 'test-deny', reason: 'test' };
const HUMAN_APPROVED: EgressDecision = { allowed: true, settledBy: 'human', rule: EGRESS_ESCALATE_RULE, reason: 'ok' };
const HUMAN_DENIED: EgressDecision = { allowed: false, settledBy: 'human', rule: EGRESS_ESCALATE_RULE, reason: 'no' };

/** Answers as the coordinator would for a destination that escalates: prior decisions settle it, otherwise `fresh`. */
function escalatingDestination(fresh: EgressDecision): (request: EgressRequest) => EgressDecision {
  return (request) => {
    if (request.prior === 'approved')
      return { allowed: true, settledBy: 'prior', rule: EGRESS_ESCALATE_RULE, reason: '' };
    if (request.prior === 'denied')
      return { allowed: false, settledBy: 'prior', rule: EGRESS_ESCALATE_RULE, reason: '' };
    return fresh;
  };
}

const testProvider: ProviderConfig = {
  host: 'api.test.com',
  displayName: 'Test',
  allowedEndpoints: [{ method: 'POST', path: '/v1/messages' }],
  keyInjection: { type: 'header', headerName: 'x-api-key' },
  fakeKeyPrefix: 'sk-test-',
};

/** Coordinator fixture with policy-evaluated egress on. */
function makeEgressCoordinator(
  root: string,
  suffix: string,
  options: {
    allowedHosts?: string[];
    onEscalation?: EscalationPromptFn;
    escalationDir?: string;
    escalationTimeoutMs?: number;
    egress?: boolean;
  } = {},
): { coordinator: ToolCallCoordinator; auditPath: string } {
  const auditPath = join(root, `audit-${suffix}.jsonl`);
  const coordinator = new ToolCallCoordinator({
    compiledPolicy: testCompiledPolicy,
    toolAnnotations: testToolAnnotations,
    protectedPaths: TEST_PROTECTED_PATHS,
    allowedDirectory: TEST_SANDBOX_DIR,
    auditLogPath: auditPath,
    onEscalation: options.onEscalation,
    escalationDir: options.escalationDir,
    escalationTimeoutMs: options.escalationTimeoutMs,
    ...(options.egress === false ? {} : { egressPolicy: { allowedHosts: options.allowedHosts ?? [] } }),
  });
  return { coordinator, auditPath };
}

/** An escalation handler that records each request and answers `decision` (or holds until released). */
function recordingEscalations(decision?: 'approved' | 'denied'): {
  onEscalation: EscalationPromptFn;
  calls: Array<{ request: ToolCallRequest; reason: string; details: EscalationPromptDetails }>;
  release: (d: 'approved' | 'denied') => void;
} {
  const calls: Array<{ request: ToolCallRequest; reason: string; details: EscalationPromptDetails }> = [];
  const held = deferred<'approved' | 'denied'>();
  return {
    calls,
    release: (d) => held.resolve(d),
    onEscalation: async (request, reason, _context, _candidates, details) => {
      calls.push({ request, reason, details });
      return { decision: decision ?? (await held.promise) };
    },
  };
}

// ---------------------------------------------------------------------------
// IRONCURTAIN_MITM_ALLOW_ALL_HOSTS deprecation (first: the terminal notice is once per process)
// ---------------------------------------------------------------------------

describe('IRONCURTAIN_MITM_ALLOW_ALL_HOSTS deprecation', () => {
  let tempDir: string;
  let ca: CertificateAuthority;
  let saved: string | undefined;
  const proxies: MitmProxy[] = [];

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'egress-deprecation-'));
    ca = loadOrCreateCA(join(tempDir, 'ca'));
  });
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));
  beforeEach(() => {
    saved = process.env[ALLOW_ALL_HOSTS];
  });
  afterEach(async () => {
    await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()));
    if (saved === undefined) delete process.env[ALLOW_ALL_HOSTS];
    else process.env[ALLOW_ALL_HOSTS] = saved;
    vi.restoreAllMocks();
  });

  it('still works without the opt-in, warns in the session log at every start and on the terminal once', async () => {
    process.env[ALLOW_ALL_HOSTS] = '1';
    const logFilePath = join(tempDir, 'deprecation.log');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logger.setup({ logFilePath });
    try {
      for (const name of ['first', 'second']) {
        const dials: net.TcpNetConnectOpts[] = [];
        const proxy = createMitmProxy({
          socketPath: join(tempDir, `${name}.sock`),
          ca,
          providers: [],
          tunnelDialForTests: unreachableTunnelDialer(dials),
        });
        proxies.push(proxy);
        await proxy.start();
        // Kept: an unknown host is still tunneled without the opt-in.
        const { socket, statusCode } = await sendConnect(join(tempDir, `${name}.sock`), 'random.example.com', 443);
        expect(statusCode).toBe(200);
        socket?.destroy();
      }
    } finally {
      logger.teardown();
    }
    const log = readFileSync(logFilePath, 'utf-8');
    expect(log.match(/IRONCURTAIN_MITM_ALLOW_ALL_HOSTS is deprecated and will be removed/gu)).toHaveLength(2);
    const notices = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((text) => text.includes('deprecated'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('egressPolicy');
  });

  it('is ignored, with a warning, when policy-evaluated egress is on', async () => {
    process.env[ALLOW_ALL_HOSTS] = '1';
    const logFilePath = join(tempDir, 'ignored.log');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const socketPath = join(tempDir, 'ignored.sock');
    const dials: net.TcpNetConnectOpts[] = [];
    logger.setup({ logFilePath });
    try {
      const proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [],
        policyEvaluatedEgress: true,
        tunnelDialForTests: unreachableTunnelDialer(dials),
      });
      proxies.push(proxy);
      await proxy.start();
      // No decider attached: the wildcard no longer admits anything.
      expect((await sendConnect(socketPath, 'random.example.com', 443)).statusCode).toBe(403);
      const authorizer = recordingAuthorizer(() => DENIED_BY_RULE);
      proxy.setEgressAuthorizer(authorizer);
      expect((await sendConnect(socketPath, 'random.example.com', 443)).statusCode).toBe(403);
      expect(authorizer.requests).toEqual([{ method: 'CONNECT', host: 'random.example.com', port: 443 }]);
    } finally {
      logger.teardown();
    }
    expect(dials).toHaveLength(0);
    expect(readFileSync(logFilePath, 'utf-8')).toContain(
      'IRONCURTAIN_MITM_ALLOW_ALL_HOSTS is deprecated and ignored: policy-evaluated egress',
    );
  });

  it('stays silent on an egress listener, which the variable never affects', async () => {
    // A Docker-workload bundle starts its registry-egress listener before the
    // agent MITM. Its notice used to be the "filtering DISABLED" variant, and
    // being first in the process it was the one the terminal showed, even
    // when policy-evaluated egress made the bundle ignore the variable.
    process.env[ALLOW_ALL_HOSTS] = '1';
    const logFilePath = join(tempDir, 'egress-listener.log');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logger.setup({ logFilePath });
    try {
      const proxy = createMitmProxy({
        socketPath: join(tempDir, 'egress-listener.sock'),
        ca,
        providers: [],
        registryEgress: { guard: createRegistryEgressGuard({ mode: 'disabled' }) },
      });
      proxies.push(proxy);
      await proxy.start();
    } finally {
      logger.teardown();
    }
    const log = existsSync(logFilePath) ? readFileSync(logFilePath, 'utf-8') : '';
    expect(log).not.toContain('IRONCURTAIN_MITM_ALLOW_ALL_HOSTS');
  });
});

// ---------------------------------------------------------------------------
// Rules, patterns and the structural screen
// ---------------------------------------------------------------------------

describe('egress host patterns', () => {
  it.each([
    ['*', '*'],
    ['*.Example.com', '*.example.com'],
    ['Registry.NPMJS.org.', 'registry.npmjs.org'],
    ['  bazel.build ', 'bazel.build'],
  ])('accepts %j as %j', (value, canonical) => {
    expect(canonicalEgressHostPattern(value)).toBe(canonical);
  });

  it.each([
    '',
    'com',
    '*.com',
    '1.2.3.4',
    '127.1',
    '[::1]',
    'localhost',
    'printer.local',
    'metadata.google.internal',
    'host.docker.internal',
    '*.internal',
    'example.com/path',
    'example.com:443',
    'exa_mple.com',
    '**.example.com',
    '*.*.example.com',
  ])('rejects %j', (value) => {
    expect(canonicalEgressHostPattern(value)).toBeUndefined();
  });
});

describe('buildEgressPolicyRules', () => {
  it('allows the configured patterns, then escalates everything else to a human', () => {
    const rules = buildEgressPolicyRules({ allowedHosts: ['*.NPMJS.org', 'bazel.build', 'bazel.build.'] });
    expect(rules.map((rule) => rule.name)).toEqual([EGRESS_ALLOWED_HOSTS_RULE, EGRESS_ESCALATE_RULE]);
    expect(rules[0]).toMatchObject({
      then: 'allow',
      if: {
        server: ['network'],
        tool: ['request'],
        domains: { roles: ['egress-host'], allowed: ['*.npmjs.org', 'bazel.build'] },
      },
    });
    expect(rules[1]).toMatchObject({ then: 'escalate', humanOnly: true, if: { server: ['network'] } });
  });

  it('has only the escalation when nothing is allowed', () => {
    expect(buildEgressPolicyRules({ allowedHosts: [] }).map((rule) => rule.name)).toEqual([EGRESS_ESCALATE_RULE]);
  });

  it('refuses a pattern the config schema would refuse', () => {
    expect(() => buildEgressPolicyRules({ allowedHosts: ['10.0.0.1'] })).toThrow(/allowedHosts/u);
  });
});

describe('screenEgressDestination', () => {
  it.each([
    [{ method: 'CONNECT', host: 'example.com', port: 443 }],
    [{ method: 'GET', host: 'example.com', port: 80, path: '/x?y=1' }],
  ])('passes %j', (request) => {
    expect(screenEgressDestination(request)).toBeUndefined();
  });

  it.each([
    [{ method: 'CONNECT', host: 'example.com', port: 22 }, EGRESS_PORT_RULE],
    [{ method: 'CONNECT', host: 'example.com', port: 8443 }, EGRESS_PORT_RULE],
    [{ method: 'CONNECT', host: '93.184.216.34', port: 443 }, EGRESS_DESTINATION_RULE],
    [{ method: 'CONNECT', host: 'localhost', port: 443 }, EGRESS_DESTINATION_RULE],
    [{ method: 'CONNECT', host: 'metadata.google.internal', port: 80 }, EGRESS_DESTINATION_RULE],
    [{ method: 'CONNECT', host: 'Example.com', port: 443 }, EGRESS_DESTINATION_RULE],
    [{ method: 'GET /', host: 'example.com', port: 80 }, EGRESS_MALFORMED_RULE],
    [{ method: 'GET', host: 'example.com', port: 80, path: 'http://other/' }, EGRESS_MALFORMED_RULE],
  ])('refuses %j under %s', (request, rule) => {
    expect(screenEgressDestination(request)?.rule).toBe(rule);
  });
});

describe('network/request policy evaluation', () => {
  function engine(allowedHosts: string[], extraRules: CompiledRule[] = []): PolicyEngine {
    return new PolicyEngine(
      {
        ...testCompiledPolicy,
        rules: [...testCompiledPolicy.rules, ...extraRules, ...buildEgressPolicyRules({ allowedHosts })],
      },
      mergeEgressAnnotations(testToolAnnotations),
      TEST_PROTECTED_PATHS,
      TEST_SANDBOX_DIR,
    );
  }

  function request(host: string, port = 443): ToolCallRequest {
    return {
      requestId: 'r',
      serverName: 'network',
      toolName: 'request',
      arguments: { method: 'CONNECT', host, port },
      timestamp: '',
    };
  }

  it('allows wildcard and exact allowedHosts and escalates (human only) the rest', () => {
    const policy = engine(['*.npmjs.org', 'bazel.build']);
    expect(policy.evaluate(request('registry.npmjs.org'))).toMatchObject({
      decision: 'allow',
      rule: EGRESS_ALLOWED_HOSTS_RULE,
    });
    expect(policy.evaluate(request('npmjs.org')).decision).toBe('allow');
    expect(policy.evaluate(request('bazel.build')).decision).toBe('allow');
    expect(policy.evaluate(request('mirror.bazel.build'))).toMatchObject({
      decision: 'escalate',
      rule: EGRESS_ESCALATE_RULE,
      humanOnly: true,
    });
  });

  it('lets "*" admit every host name', () => {
    expect(engine(['*']).evaluate(request('anything.example.org')).decision).toBe('allow');
  });

  it('lets a compiled rule for the network server decide before the configured allowlist', () => {
    const deny: CompiledRule = {
      name: 'deny-exfil-host',
      description: 'test',
      principle: 'test',
      if: {
        server: ['network'],
        tool: ['request'],
        domains: { roles: ['egress-host'], allowed: ['exfil.example.org'] },
      },
      then: 'deny',
      reason: 'Known exfiltration endpoint',
    };
    expect(engine(['*'], [deny]).evaluate(request('exfil.example.org'))).toMatchObject({
      decision: 'deny',
      rule: 'deny-exfil-host',
    });
  });

  it('never applies a rule written for another URL role to network requests', () => {
    const fetchAllowAll: CompiledRule = {
      name: 'allow-every-fetch',
      description: 'test',
      principle: 'test',
      if: { domains: { roles: ['fetch-url'], allowed: ['*'] } },
      then: 'allow',
      reason: 'test',
    };
    expect(engine([], [fetchAllowAll]).evaluate(request('example.org')).decision).toBe('escalate');
  });
});

describe('egressPolicyOptionsFor (sandbox wiring)', () => {
  function config(egressPolicy: unknown, mitmControlAddr?: string): IronCurtainConfig {
    return { userConfig: { egressPolicy }, mitmControlAddr } as unknown as IronCurtainConfig;
  }

  it('hands the coordinator the allowlist only when the user opted in and a MITM proxy asks', () => {
    const enabled = { enabled: true, allowedHosts: ['*.npmjs.org'] };
    expect(egressPolicyOptionsFor(config(enabled, 'unix:///run/ctl.sock'))).toEqual({ allowedHosts: ['*.npmjs.org'] });
    // Builtin Code Mode sessions have no MITM proxy.
    expect(egressPolicyOptionsFor(config(enabled))).toBeUndefined();
    // Opt-in: off by default, and when absent from a hand-built config.
    expect(egressPolicyOptionsFor(config({ enabled: false, allowedHosts: ['*'] }, 'unix:///x'))).toBeUndefined();
    expect(egressPolicyOptionsFor(config(undefined, 'unix:///x'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ToolCallCoordinator.authorizeEgress
// ---------------------------------------------------------------------------

describe('ToolCallCoordinator.authorizeEgress', () => {
  let root: string;
  const coordinators: ToolCallCoordinator[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'egress-coordinator-'));
    mkdirSync(TEST_SANDBOX_DIR, { recursive: true });
    // Persona policy dirs written under `root` pass validatePolicyDir.
    process.env.IRONCURTAIN_HOME = root;
  });
  afterEach(async () => {
    await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.close().catch(() => undefined)));
    delete process.env.IRONCURTAIN_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  function make(suffix: string, options: Parameters<typeof makeEgressCoordinator>[2] = {}) {
    const made = makeEgressCoordinator(root, suffix, options);
    coordinators.push(made.coordinator);
    return made;
  }

  const connect = (host: string, extra: Partial<EgressRequest> = {}): EgressRequest => ({
    method: 'CONNECT',
    host,
    port: 443,
    ...extra,
  });

  it('escalates a CONNECT to an unapproved host through the in-process handler and audits the decision', async () => {
    const escalations = recordingEscalations('approved');
    const { coordinator, auditPath } = make('escalate', { onEscalation: escalations.onEscalation });

    const decision = await coordinator.authorizeEgress(connect('unapproved.example.com'));

    expect(decision).toMatchObject({ allowed: true, settledBy: 'human', rule: EGRESS_ESCALATE_RULE });
    expect(escalations.calls).toHaveLength(1);
    const [call] = escalations.calls;
    expect(call.request).toMatchObject({
      serverName: 'network',
      toolName: 'request',
      arguments: { method: 'CONNECT', host: 'unapproved.example.com', port: 443 },
    });
    expect(call.details.humanOnly).toBe(true);
    expect(call.reason).toContain('approving admits unapproved.example.com:443 for the rest of this session');

    const audit = readAudit(auditPath);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      serverName: 'network',
      toolName: 'request',
      arguments: { method: 'CONNECT', host: 'unapproved.example.com', port: 443 },
      policyDecision: { status: 'allow', rule: EGRESS_ESCALATE_RULE },
      escalationResult: 'approved',
      result: { status: 'success' },
    });
  });

  it('audits a human denial', async () => {
    const escalations = recordingEscalations('denied');
    const { coordinator, auditPath } = make('denied', { onEscalation: escalations.onEscalation });
    const decision = await coordinator.authorizeEgress(connect('unapproved.example.com'));
    expect(decision).toMatchObject({ allowed: false, settledBy: 'human' });
    expect(readAudit(auditPath)[0]).toMatchObject({
      policyDecision: { status: 'deny', reason: 'Denied by human during escalation' },
      escalationResult: 'denied',
      result: { status: 'denied' },
    });
  });

  it('settles an escalation with the prior decision for the same host and port, without asking', async () => {
    const escalations = recordingEscalations('approved');
    const { coordinator, auditPath } = make('prior', { onEscalation: escalations.onEscalation });

    expect(await coordinator.authorizeEgress(connect('seen.example.com', { prior: 'approved' }))).toMatchObject({
      allowed: true,
      settledBy: 'prior',
    });
    expect(await coordinator.authorizeEgress(connect('refused.example.com', { prior: 'denied' }))).toMatchObject({
      allowed: false,
      settledBy: 'prior',
    });
    expect(escalations.calls).toHaveLength(0);
    const audit = readAudit(auditPath);
    expect(audit.map((entry) => [entry.escalationResult, entry.policyDecision.reason])).toEqual([
      ['approved', 'Approved earlier in this session for seen.example.com:443'],
      ['denied', 'Denied earlier in this session for refused.example.com:443'],
    ]);
  });

  it('admits allowedHosts without escalating, and a prior denial never overrides a policy allow', async () => {
    const escalations = recordingEscalations('denied');
    const { coordinator, auditPath } = make('allowed', {
      allowedHosts: ['*.npmjs.org'],
      onEscalation: escalations.onEscalation,
    });
    const decision = await coordinator.authorizeEgress(connect('registry.npmjs.org', { prior: 'denied' }));
    expect(decision).toMatchObject({ allowed: true, settledBy: 'policy', rule: EGRESS_ALLOWED_HOSTS_RULE });
    expect(escalations.calls).toHaveLength(0);
    expect(readAudit(auditPath)[0]).toMatchObject({
      policyDecision: { status: 'allow', rule: EGRESS_ALLOWED_HOSTS_RULE },
      result: { status: 'success' },
    });
    expect(readAudit(auditPath)[0].escalationResult).toBeUndefined();
  });

  it('evaluates a readable request with its method and path, and audits the path', async () => {
    const { coordinator, auditPath } = make('path', { allowedHosts: ['downloads.example.com'] });
    const decision = await coordinator.authorizeEgress({
      method: 'GET',
      host: 'downloads.example.com',
      port: 80,
      path: '/pool/main/pkg.tar.gz?mirror=1',
    });
    expect(decision.allowed).toBe(true);
    expect(readAudit(auditPath)[0].arguments).toEqual({
      method: 'GET',
      host: 'downloads.example.com',
      port: 80,
      path: '/pool/main/pkg.tar.gz?mirror=1',
    });
  });

  it.each([
    [connect('example.com', { port: 22 }), EGRESS_PORT_RULE],
    [connect('93.184.216.34'), EGRESS_DESTINATION_RULE],
    [connect('metadata.google.internal', { port: 80 }), EGRESS_DESTINATION_RULE],
  ])('refuses %j structurally, audited, without asking anyone', async (request, rule) => {
    const escalations = recordingEscalations('approved');
    const { coordinator, auditPath } = make('structural', {
      allowedHosts: ['*'],
      onEscalation: escalations.onEscalation,
    });
    const decision = await coordinator.authorizeEgress({ ...request, prior: 'approved' });
    expect(decision).toMatchObject({ allowed: false, settledBy: 'policy', rule });
    expect(escalations.calls).toHaveLength(0);
    expect(readAudit(auditPath)[0]).toMatchObject({ policyDecision: { status: 'deny', rule } });
  });

  it('asks through the file-IPC escalation directory when there is no in-process handler', async () => {
    const escalationDir = join(root, 'escalations');
    mkdirSync(escalationDir, { recursive: true });
    const { coordinator, auditPath } = make('file-ipc', { escalationDir });

    const pending = coordinator.authorizeEgress(connect('files.example.com'));
    await waitFor(() => readdirSync(escalationDir).some((name) => name.startsWith('request-')), 5_000);
    const requestFile = readdirSync(escalationDir).find((name) => name.startsWith('request-'));
    if (requestFile === undefined) throw new Error('no escalation request file');
    const written = JSON.parse(readFileSync(join(escalationDir, requestFile), 'utf-8')) as Record<string, unknown>;
    expect(written).toMatchObject({
      serverName: 'network',
      toolName: 'request',
      arguments: { method: 'CONNECT', host: 'files.example.com', port: 443 },
      humanOnly: true,
    });
    writeFileSync(
      join(escalationDir, requestFile.replace(/^request-/u, 'response-')),
      JSON.stringify({ decision: 'approved' }),
    );

    expect(await pending).toMatchObject({ allowed: true, settledBy: 'human' });
    expect(readAudit(auditPath)[0].escalationResult).toBe('approved');
    expect(readdirSync(escalationDir)).toEqual([]);
  });

  it('denies an escalation nobody can answer', async () => {
    const { coordinator, auditPath } = make('no-channel');
    expect(await coordinator.authorizeEgress(connect('lonely.example.com'))).toMatchObject({
      allowed: false,
      settledBy: 'unanswered',
    });
    expect(readAudit(auditPath)[0].policyDecision.reason).toContain('no escalation handler');
  });

  it('denies an escalation that times out, audited as timed out and not remembered as a human denial', async () => {
    const escalations = recordingEscalations();
    const { coordinator, auditPath } = make('timeout', {
      onEscalation: escalations.onEscalation,
      escalationTimeoutMs: 50,
    });
    expect(await coordinator.authorizeEgress(connect('slow.example.com'))).toMatchObject({
      allowed: false,
      settledBy: 'unanswered',
    });
    expect(readAudit(auditPath)[0]).toMatchObject({ escalationResult: 'timed-out', result: { status: 'denied' } });
  });

  it('is cancelled by close() instead of waiting out the escalation timeout', async () => {
    const escalations = recordingEscalations();
    const { coordinator, auditPath } = make('close', { onEscalation: escalations.onEscalation });
    const pending = coordinator.authorizeEgress(connect('pending.example.com'));
    await waitFor(() => escalations.calls.length === 1);
    const started = Date.now();
    await coordinator.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await pending).toMatchObject({ allowed: false, settledBy: 'unanswered' });
    expect(readAudit(auditPath)[0].escalationResult).toBe('cancelled');
    // Refused once closed.
    await expect(coordinator.authorizeEgress(connect('after.example.com'))).rejects.toThrow(/closed/u);
  });

  it('bounds the escalations waiting for a human at once', async () => {
    const escalations = recordingEscalations();
    const { coordinator } = make('limit', { onEscalation: escalations.onEscalation });
    const pending = Array.from({ length: MAX_PENDING_EGRESS_ESCALATIONS }, (_, i) =>
      coordinator.authorizeEgress(connect(`host${i}.example.com`)),
    );
    await waitFor(() => escalations.calls.length === MAX_PENDING_EGRESS_ESCALATIONS);
    expect(await coordinator.authorizeEgress(connect('one-too-many.example.com'))).toMatchObject({
      allowed: false,
      settledBy: 'unanswered',
      rule: EGRESS_ESCALATION_LIMIT_RULE,
    });
    escalations.release('approved');
    expect((await Promise.all(pending)).every((decision) => decision.allowed)).toBe(true);
    // The slots are free again.
    expect(await coordinator.authorizeEgress(connect('next.example.com'))).toMatchObject({ settledBy: 'human' });
  });

  it('never takes the call mutex: a decision completes while a tool call is blocked in its backend', async () => {
    const { coordinator } = make('mutex', { allowedHosts: ['fast.example.com'] });
    const entered = deferred<undefined>();
    const unblock = deferred<undefined>();
    const client = {
      callTool: async () => {
        entered.resolve(undefined);
        await unblock.promise;
        return { content: [{ type: 'text', text: 'done' }], isError: false };
      },
      sendRootsListChanged: async () => undefined,
    } as unknown as Client;
    const tools: ProxiedTool[] = testToolAnnotations.servers.filesystem.tools.map((annotation) => ({
      serverName: annotation.serverName,
      name: annotation.toolName,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    }));
    const state: ClientState = { client, roots: [] };
    coordinator.registerTools('filesystem', tools, state);

    let toolCallSettled = false;
    const toolCall = coordinator
      .handleToolCall('filesystem', 'read_file', { path: `${TEST_SANDBOX_DIR}/blocked.txt` })
      .then((result) => {
        toolCallSettled = true;
        return result;
      });
    await entered.promise;

    const decision = await coordinator.authorizeEgress(connect('fast.example.com'));
    expect(decision.allowed).toBe(true);
    expect(toolCallSettled).toBe(false);

    unblock.resolve(undefined);
    expect((await toolCall).isError).toBeFalsy();
  });

  it('keeps the egress rules across a policy swap, after the persona policy’s own network rules', async () => {
    // A persona policy dir must be <home>/personas/<name>/generated (validatePolicyDir).
    const policyDir = join(root, 'personas', 'reviewer', 'generated');
    mkdirSync(policyDir, { recursive: true });
    const personaDeny: CompiledRule = {
      name: 'persona-deny-tracker',
      description: 'test',
      principle: 'test',
      if: {
        server: ['network'],
        tool: ['request'],
        domains: { roles: ['egress-host'], allowed: ['tracker.example.com'] },
      },
      then: 'deny',
      reason: 'The reviewer persona never reaches trackers',
    };
    writeFileSync(
      join(policyDir, 'compiled-policy.json'),
      JSON.stringify({ ...testCompiledPolicy, rules: [personaDeny] }),
    );
    const escalations = recordingEscalations('approved');
    const { coordinator, auditPath } = make('swap', {
      allowedHosts: ['*.example.com'],
      onEscalation: escalations.onEscalation,
    });
    await coordinator.loadPolicy({ persona: 'reviewer', policyDir });

    expect(await coordinator.authorizeEgress(connect('tracker.example.com'))).toMatchObject({
      allowed: false,
      rule: 'persona-deny-tracker',
    });
    expect(await coordinator.authorizeEgress(connect('docs.example.com'))).toMatchObject({
      allowed: true,
      rule: EGRESS_ALLOWED_HOSTS_RULE,
    });
    expect(await coordinator.authorizeEgress(connect('elsewhere.org'))).toMatchObject({
      allowed: true,
      settledBy: 'human',
      rule: EGRESS_ESCALATE_RULE,
    });
    expect(readAudit(auditPath).map((entry) => entry.persona)).toEqual(['reviewer', 'reviewer', 'reviewer']);
  });

  it('fails closed when the audit log cannot be written, and refuses everything after', async () => {
    const { coordinator, auditPath } = make('audit-failure', { allowedHosts: ['*'] });
    expect((await coordinator.authorizeEgress(connect('first.example.com'))).allowed).toBe(true);
    rmSync(auditPath, { force: true });
    mkdirSync(auditPath);

    const failure = await coordinator.authorizeEgress(connect('second.example.com')).catch((err: unknown) => err);
    expect(isAuditLogUnavailableError(failure)).toBe(true);
    expect(coordinator.getAuditFailure()).not.toBeNull();
    const refused = await coordinator.authorizeEgress(connect('third.example.com')).catch((err: unknown) => err);
    expect(isAuditLogUnavailableError(refused)).toBe(true);
  });

  it('refuses every request when policy-evaluated egress is not configured', async () => {
    const { coordinator, auditPath } = make('disabled', { egress: false });
    expect(await coordinator.authorizeEgress(connect('example.com'))).toMatchObject({
      allowed: false,
      rule: 'egress-policy-disabled',
    });
    expect(readAudit(auditPath)).toEqual([]);
    // The network server is not part of the policy at all.
    expect(coordinator.getPolicyEngine().getStoredAnnotation('network', 'request')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MitmProxy with policy-evaluated egress
// ---------------------------------------------------------------------------

describe('MitmProxy policy-evaluated egress', () => {
  let tempDir: string;
  let ca: CertificateAuthority;
  let socketPath: string;
  let proxy: MitmProxy | undefined;
  let savedAllowAll: string | undefined;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'egress-mitm-'));
    ca = loadOrCreateCA(join(tempDir, 'ca'));
  });
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));
  beforeEach(() => {
    socketPath = join(mkdtempSync(join(tempDir, 's-')), 'mitm.sock');
    savedAllowAll = process.env[ALLOW_ALL_HOSTS];
    delete process.env[ALLOW_ALL_HOSTS];
  });
  afterEach(async () => {
    await proxy?.stop();
    proxy = undefined;
    for (const cleanup of cleanups.splice(0)) await cleanup();
    if (savedAllowAll === undefined) delete process.env[ALLOW_ALL_HOSTS];
    else process.env[ALLOW_ALL_HOSTS] = savedAllowAll;
  });

  async function startProxy(
    authorizer: EgressAuthorizer | undefined,
    extra: Partial<MitmProxyOptions> = {},
  ): Promise<MitmProxy> {
    const started = createMitmProxy({ socketPath, ca, providers: [], policyEvaluatedEgress: true, ...extra });
    started.setEgressAuthorizer(authorizer);
    await started.start();
    proxy = started;
    return started;
  }

  it('asks the policy about a CONNECT to an unknown host and opens an SNI-pinned tunnel when allowed', async () => {
    const origin = await createLocalTlsOrigin(ca);
    cleanups.push(() => origin.close());
    const dials: net.TcpNetConnectOpts[] = [];
    const authorizer = recordingAuthorizer(() => ALLOWED_BY_RULE);
    await startProxy(authorizer, { tunnelDialForTests: localTunnelDialer(origin.port, dials) });

    const { socket, statusCode } = await sendConnect(socketPath, 'allowed.example.com', 443);
    expect(statusCode).toBe(200);
    expect(authorizer.requests).toEqual([{ method: 'CONNECT', host: 'allowed.example.com', port: 443 }]);
    const body = await httpsThroughTunnel(socket!, ca, 'allowed.example.com', '/health');
    expect(JSON.parse(body)).toEqual({ sni: 'allowed.example.com', path: '/health' });
    expect(dials).toHaveLength(1);
    // A rule admitted it: nothing is recorded as an approval.
    expect(proxy?.hosts.listHosts().dynamic).toEqual([]);
  });

  it('keeps the SNI pin on a policy-admitted tunnel', async () => {
    const dials: net.TcpNetConnectOpts[] = [];
    await startProxy(
      recordingAuthorizer(() => ALLOWED_BY_RULE),
      { tunnelDialForTests: unreachableTunnelDialer(dials) },
    );
    const { socket, statusCode } = await sendConnect(socketPath, 'allowed.example.com', 443);
    expect(statusCode).toBe(200);
    await expect(tlsHandshake(socket!, 'other-tenant.example.com', ca.certPem)).rejects.toThrow();
    expect(dials).toHaveLength(0);
  });

  it('refuses a CONNECT the policy denies, without dialing', async () => {
    const dials: net.TcpNetConnectOpts[] = [];
    await startProxy(
      recordingAuthorizer(() => DENIED_BY_RULE),
      { tunnelDialForTests: unreachableTunnelDialer(dials) },
    );
    expect((await sendConnect(socketPath, 'denied.example.com', 443)).statusCode).toBe(403);
    expect(dials).toHaveLength(0);
  });

  it('fails closed with no decider attached, or one that cannot decide', async () => {
    const dials: net.TcpNetConnectOpts[] = [];
    const started = await startProxy(undefined, { tunnelDialForTests: unreachableTunnelDialer(dials) });
    expect((await sendConnect(socketPath, 'unknown.example.com', 443)).statusCode).toBe(403);
    started.setEgressAuthorizer({
      authorizeEgress: () => Promise.reject(new Error('ToolCallCoordinator is closed')),
    });
    expect((await sendConnect(socketPath, 'unknown.example.com', 443)).statusCode).toBe(403);
    expect(dials).toHaveLength(0);
  });

  it('never asks about providers or package registries', async () => {
    const authorizer = recordingAuthorizer(() => DENIED_BY_RULE);
    const debian: RegistryConfig = { host: 'deb.debian.org', displayName: 'Debian', type: 'debian' };
    await startProxy(authorizer, {
      providers: [{ config: testProvider, fakeKey: 'sk-test-fake', realKey: 'sk-real' }],
      registries: [debian],
      packageValidation: { validator: DENY_ALL_VALIDATOR },
    });
    const providerConnect = await sendConnect(socketPath, 'api.test.com', 443);
    expect(providerConnect.statusCode).toBe(200);
    providerConnect.socket?.destroy();
    const registryRequest = await plainHttpThroughProxy(
      socketPath,
      'http://deb.debian.org/debian/pool/main/l/libssl3/libssl3_3.0.11-1~deb12u2_arm64.deb',
    );
    // The registry handler refused it (DENY_ALL names the package), not the egress policy.
    expect(registryRequest.statusCode).toBe(403);
    expect(registryRequest.body).toContain('libssl3');
    expect(authorizer.requests).toEqual([]);
  });

  it('remembers a human approval: it becomes a passthrough approval passed back as prior, and revocation closes its tunnels', async () => {
    const origin = await createLocalTlsOrigin(ca);
    cleanups.push(() => origin.close());
    const authorizer = recordingAuthorizer(escalatingDestination(HUMAN_APPROVED));
    const started = await startProxy(authorizer, { tunnelDialForTests: localTunnelDialer(origin.port) });

    const first = await sendConnect(socketPath, 'approved.example.com', 443);
    expect(first.statusCode).toBe(200);
    expect(started.hosts.listHosts().dynamic).toEqual(['approved.example.com:443']);

    const second = await sendConnect(socketPath, 'approved.example.com', 443);
    expect(second.statusCode).toBe(200);
    expect(authorizer.requests.map((request) => request.prior)).toEqual([undefined, 'approved']);
    // The tunnel runs under the approval: revoking it tears the tunnel down.
    const tlsSocket = await tlsHandshake(second.socket!, 'approved.example.com', ca.certPem);
    tlsSocket.on('error', () => undefined);
    expect(started.hosts.removeHost('approved.example.com')).toBe(true);
    await waitFor(() => second.socket!.destroyed);
    first.socket?.destroy();

    expect((await sendConnect(socketPath, 'approved.example.com', 443)).statusCode).toBe(200);
    expect(authorizer.requests.map((request) => request.prior)).toEqual([undefined, 'approved', undefined]);
  });

  it('remembers a human denial until an explicit approval for the same target', async () => {
    const dials: net.TcpNetConnectOpts[] = [];
    const authorizer = recordingAuthorizer(escalatingDestination(HUMAN_DENIED));
    const started = await startProxy(authorizer, { tunnelDialForTests: unreachableTunnelDialer(dials) });

    expect((await sendConnect(socketPath, 'refused.example.com', 443)).statusCode).toBe(403);
    expect((await sendConnect(socketPath, 'refused.example.com', 443)).statusCode).toBe(403);
    expect(authorizer.requests.map((request) => request.prior)).toEqual([undefined, 'denied']);
    // Another port is another target.
    expect((await sendConnect(socketPath, 'refused.example.com', 80)).statusCode).toBe(403);
    expect(authorizer.requests[2]).toEqual({ method: 'CONNECT', host: 'refused.example.com', port: 80 });

    // add_proxy_domain approved by a human overrides the remembered denial.
    expect(started.hosts.addHost('refused.example.com')).toBe(true);
    const after = await sendConnect(socketPath, 'refused.example.com', 443);
    expect(after.statusCode).toBe(200);
    after.socket?.destroy();
    expect(authorizer.requests[3]?.prior).toBe('approved');
  });

  it('decides concurrent CONNECTs to one target one at a time, so one escalation answers them all', async () => {
    const human = deferred<EgressDecision>();
    let inFlight = 0;
    let maxInFlight = 0;
    const authorizer = recordingAuthorizer(async (request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (request.prior === 'approved') {
          return { allowed: true, settledBy: 'prior', rule: EGRESS_ESCALATE_RULE, reason: '' };
        }
        return await human.promise;
      } finally {
        inFlight -= 1;
      }
    });
    await startProxy(authorizer, { tunnelDialForTests: unreachableTunnelDialer([]) });

    const connects = [1, 2, 3].map(() => sendConnect(socketPath, 'busy.example.com', 443));
    await waitFor(() => authorizer.requests.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(authorizer.requests).toHaveLength(1);
    human.resolve(HUMAN_APPROVED);

    const results = await Promise.all(connects);
    expect(results.map((result) => result.statusCode)).toEqual([200, 200, 200]);
    for (const result of results) result.socket?.destroy();
    expect(authorizer.requests.map((request) => request.prior)).toEqual([undefined, 'approved', 'approved']);
    expect(maxInFlight).toBe(1);
  });

  it('decides plain-HTTP proxy requests per path and forwards only what the policy allows', async () => {
    const origin = await createLocalHttpOrigin();
    cleanups.push(() => origin.close());
    const received: DestinationBoundRequest[] = [];
    const authorizer = recordingAuthorizer((request) =>
      request.path?.startsWith('/allowed') === true ? ALLOWED_BY_RULE : DENIED_BY_RULE,
    );
    await startProxy(authorizer, { outboundTransport: localUpstreamTransport(origin.port, received) });

    const allowed = await plainHttpThroughProxy(socketPath, 'http://plain.example.com/allowed/file?x=1');
    expect(allowed).toMatchObject({ statusCode: 200, body: 'ORIGIN /allowed/file?x=1' });
    const denied = await plainHttpThroughProxy(socketPath, 'http://plain.example.com/secret');
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toContain('Forbidden by egress policy');
    expect(authorizer.requests).toEqual([
      { method: 'GET', host: 'plain.example.com', port: 80, path: '/allowed/file?x=1' },
      { method: 'GET', host: 'plain.example.com', port: 80, path: '/secret' },
    ]);
    expect(origin.seen).toEqual(['GET /allowed/file?x=1 host=plain.example.com']);
    expect(received).toHaveLength(1);
  });

  it('decides each request inside a port-80 CONNECT tunnel at path granularity', async () => {
    const origin = await createLocalHttpOrigin();
    cleanups.push(() => origin.close());
    const authorizer = recordingAuthorizer((request) =>
      request.method === 'CONNECT' || request.path === '/ok' ? ALLOWED_BY_RULE : DENIED_BY_RULE,
    );
    await startProxy(authorizer, { outboundTransport: localUpstreamTransport(origin.port) });

    const exchange = async (path: string): Promise<string> => {
      const { socket, statusCode } = await sendConnect(socketPath, 'tunnel.example.com', 80);
      expect(statusCode).toBe(200);
      return new Promise((resolve, reject) => {
        let data = '';
        socket!.on('data', (chunk: Buffer) => (data += chunk.toString()));
        socket!.on('close', () => resolve(data));
        socket!.on('error', reject);
        socket!.write(`GET ${path} HTTP/1.1\r\nHost: tunnel.example.com\r\nConnection: close\r\n\r\n`);
      });
    };
    expect(await exchange('/ok')).toMatch(/^HTTP\/1\.1 200 /u);
    expect(await exchange('/nope')).toMatch(/^HTTP\/1\.1 403 /u);
    expect(authorizer.requests).toEqual([
      { method: 'CONNECT', host: 'tunnel.example.com', port: 80 },
      { method: 'GET', host: 'tunnel.example.com', port: 80, path: '/ok' },
      { method: 'CONNECT', host: 'tunnel.example.com', port: 80 },
      { method: 'GET', host: 'tunnel.example.com', port: 80, path: '/nope' },
    ]);
    expect(origin.seen).toEqual(['GET /ok host=tunnel.example.com']);
  });

  it('decides ws:// upgrades through the proxy like any readable request', async () => {
    const origin = await createLocalHttpOrigin();
    cleanups.push(() => origin.close());
    const authorizer = recordingAuthorizer((request) => (request.path === '/ws' ? ALLOWED_BY_RULE : DENIED_BY_RULE));
    await startProxy(authorizer, { outboundTransport: localUpstreamTransport(origin.port) });

    const upgrade = (path: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const socket = net.connect(socketPath);
        let data = '';
        socket.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          if (data.includes('\r\n\r\n')) socket.destroy();
        });
        socket.on('close', () => resolve(data));
        socket.on('error', reject);
        socket.write(
          `GET http://ws.example.com${path} HTTP/1.1\r\nHost: ws.example.com\r\n` +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
    expect(await upgrade('/ws')).toMatch(/^HTTP\/1\.1 101 /u);
    expect(await upgrade('/other')).toMatch(/^HTTP\/1\.1 403 /u);
    expect(authorizer.requests).toEqual([
      { method: 'GET', host: 'ws.example.com', port: 80, path: '/ws' },
      { method: 'GET', host: 'ws.example.com', port: 80, path: '/other' },
    ]);
  });

  it('stops without waiting for a ws:// upgrade whose decision is pending, and a late admit bridges nothing', async () => {
    const origin = await createLocalHttpOrigin();
    cleanups.push(() => origin.close());
    const received: DestinationBoundRequest[] = [];
    const human = deferred<EgressDecision>();
    const authorizer = recordingAuthorizer(() => human.promise);
    const started = await startProxy(authorizer, { outboundTransport: localUpstreamTransport(origin.port, received) });

    const client = net.connect(socketPath);
    client.on('error', () => undefined);
    const clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    // Whatever happens below, nothing is left waiting once the test ends.
    cleanups.push(async () => {
      human.resolve(DENIED_BY_RULE);
      client.destroy();
    });
    client.write(
      'GET http://ws.example.com/live HTTP/1.1\r\nHost: ws.example.com\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    await waitFor(() => authorizer.requests.length === 1);

    // A human can take minutes; stopping the proxy must not wait for one.
    proxy = undefined;
    const outcome = await Promise.race([
      started.stop().then(() => 'stopped'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still stopping'), 2_000)),
    ]);
    expect(outcome).toBe('stopped');
    await clientClosed;

    // The decision lands after the proxy stopped: nothing is bridged.
    human.resolve(ALLOWED_BY_RULE);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual([]);
    expect(origin.seen).toEqual([]);
  });

  it('decides a WebSocket upgrade inside a policy-admitted port-80 tunnel', async () => {
    const origin = await createLocalHttpOrigin();
    cleanups.push(() => origin.close());
    const authorizer = recordingAuthorizer((request) =>
      request.method === 'CONNECT' || request.path === '/live' ? ALLOWED_BY_RULE : DENIED_BY_RULE,
    );
    await startProxy(authorizer, { outboundTransport: localUpstreamTransport(origin.port) });

    const upgradeInTunnel = async (path: string): Promise<string> => {
      const { socket, statusCode } = await sendConnect(socketPath, 'tunnel-ws.example.com', 80);
      expect(statusCode).toBe(200);
      return new Promise((resolve, reject) => {
        let data = '';
        socket!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          if (data.includes('\r\n\r\n')) socket!.destroy();
        });
        socket!.on('close', () => resolve(data));
        socket!.on('error', reject);
        socket!.write(
          `GET ${path} HTTP/1.1\r\nHost: tunnel-ws.example.com\r\n` +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
    };
    expect(await upgradeInTunnel('/live')).toMatch(/^HTTP\/1\.1 101 /u);
    expect(await upgradeInTunnel('/blocked')).toMatch(/^HTTP\/1\.1 403 /u);
    expect(authorizer.requests.filter((request) => request.method !== 'CONNECT')).toEqual([
      { method: 'GET', host: 'tunnel-ws.example.com', port: 80, path: '/live' },
      { method: 'GET', host: 'tunnel-ws.example.com', port: 80, path: '/blocked' },
    ]);
    expect(origin.seen).toEqual(['upgrade /live']);
  });
});

// ---------------------------------------------------------------------------
// End to end: MITM proxy + coordinator (acceptance)
// ---------------------------------------------------------------------------

describe('policy-evaluated egress end to end', () => {
  let root: string;
  let ca: CertificateAuthority;
  let proxy: MitmProxy | undefined;
  let coordinator: ToolCallCoordinator | undefined;
  let closeOrigin: (() => Promise<void>) | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'egress-e2e-'));
    ca = loadOrCreateCA(join(root, 'ca'));
    mkdirSync(TEST_SANDBOX_DIR, { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(async () => {
    await proxy?.stop();
    proxy = undefined;
    await coordinator?.close();
    coordinator = undefined;
    await closeOrigin?.();
    closeOrigin = undefined;
  });

  async function setUp(suffix: string, decision: 'approved' | 'denied') {
    const origin = await createLocalTlsOrigin(ca);
    closeOrigin = () => origin.close();
    const escalations = recordingEscalations(decision);
    const made = makeEgressCoordinator(root, suffix, { onEscalation: escalations.onEscalation });
    coordinator = made.coordinator;
    const socketPath = join(mkdtempSync(join(root, 's-')), 'mitm.sock');
    const dials: net.TcpNetConnectOpts[] = [];
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [],
      policyEvaluatedEgress: true,
      tunnelDialForTests: localTunnelDialer(origin.port, dials),
    });
    proxy.setEgressAuthorizer(made.coordinator);
    await proxy.start();
    return { socketPath, escalations, auditPath: made.auditPath, dials, proxy };
  }

  it('escalates a CONNECT to an unapproved host through the normal channel, audits it, and asks only once', async () => {
    const { socketPath, escalations, auditPath, dials, proxy: started } = await setUp('approve', 'approved');

    const first = await sendConnect(socketPath, 'unapproved.example.com', 443);
    expect(first.statusCode).toBe(200);
    expect(escalations.calls).toHaveLength(1);
    expect(escalations.calls[0].request).toMatchObject({
      serverName: 'network',
      toolName: 'request',
      arguments: { method: 'CONNECT', host: 'unapproved.example.com', port: 443 },
    });
    expect(escalations.calls[0].details.humanOnly).toBe(true);
    const body = await httpsThroughTunnel(first.socket!, ca, 'unapproved.example.com', '/data');
    expect(JSON.parse(body)).toEqual({ sni: 'unapproved.example.com', path: '/data' });

    // Escalate-once: the approval is a passthrough approval now.
    expect(started.hosts.listHosts().dynamic).toEqual(['unapproved.example.com:443']);
    const second = await sendConnect(socketPath, 'unapproved.example.com', 443);
    expect(second.statusCode).toBe(200);
    second.socket?.destroy();
    expect(escalations.calls).toHaveLength(1);
    expect(dials).toHaveLength(1);

    const audit = readAudit(auditPath);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      serverName: 'network',
      toolName: 'request',
      arguments: { method: 'CONNECT', host: 'unapproved.example.com', port: 443 },
      policyDecision: { status: 'allow', rule: EGRESS_ESCALATE_RULE, reason: 'Approved by human during escalation' },
      escalationResult: 'approved',
      result: { status: 'success' },
    });
    expect(audit[1]).toMatchObject({
      policyDecision: { status: 'allow', reason: 'Approved earlier in this session for unapproved.example.com:443' },
      escalationResult: 'approved',
    });
  });

  it('refuses a CONNECT a human denies, audits it, and does not ask again', async () => {
    const { socketPath, escalations, auditPath, dials } = await setUp('deny', 'denied');

    expect((await sendConnect(socketPath, 'unwanted.example.com', 443)).statusCode).toBe(403);
    expect((await sendConnect(socketPath, 'unwanted.example.com', 443)).statusCode).toBe(403);
    expect(escalations.calls).toHaveLength(1);
    expect(dials).toHaveLength(0);
    expect(readAudit(auditPath).map((entry) => [entry.escalationResult, entry.result.status])).toEqual([
      ['denied', 'denied'],
      ['denied', 'denied'],
    ]);
  });

  it('audits a structurally refused destination without asking anyone', async () => {
    const { socketPath, escalations, auditPath } = await setUp('structural', 'approved');
    expect((await sendConnect(socketPath, 'example.com', 22)).statusCode).toBe(403);
    expect(escalations.calls).toHaveLength(0);
    expect(readAudit(auditPath)[0]).toMatchObject({
      arguments: { method: 'CONNECT', host: 'example.com', port: 22 },
      policyDecision: { status: 'deny', rule: EGRESS_PORT_RULE },
    });
  });
});
