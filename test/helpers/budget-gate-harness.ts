/**
 * Fake-upstream harness for the MITM budget gate: a real MITM proxy (UDS) with
 * a budget gate, an Anthropic-shaped fake upstream on loopback, and a client
 * that sends completion requests the way an agent in the container does
 * (CONNECT, TLS to the proxy's leaf, HTTP/1.1 with the sentinel key).
 */

import * as http from 'node:http';
import * as tls from 'node:tls';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IronCurtainConfig } from '../../src/config/types.js';
import { createBudgetGate, type BudgetGate, type BudgetGateOptions } from '../../src/docker/budget-gate.js';
import { loadOrCreateCA, type CertificateAuthority } from '../../src/docker/ca.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import { anthropicProvider, type ProviderConfig } from '../../src/docker/provider-config.js';
import { TURN_KILL_SWEEP_SCRIPT } from '../../src/docker/turn-timeout.js';
import type { ContainerRuntime, DockerExecResult } from '../../src/docker/types.js';
import type { BundleId } from '../../src/session/types.js';
import { createMockAdapter, createMockCA, createMockDocker, createMockProxy } from './docker-mocks.js';
import { sendConnect } from './mitm-tls-harness.js';

export const CLIENT_HOST = 'api.anthropic.com';
export const FAKE_KEY = 'sk-ant-api03-ironcurtain-budget-test';
const REAL_KEY = 'sk-ant-api03-real-budget-test';

/** Tokens of {@link anthropicSse}: 100 uncached + 20 cache-read + 10 cache-write input, 50 output. */
export const SSE_TOTAL_TOKENS = 180;
export const SSE_INPUT_TOKENS = 130;

/** One complete Anthropic Messages stream with final usage. */
export function anthropicSse(model = 'claude-sonnet-4-5'): string {
  return [
    'event: message_start',
    `data: {"type":"message_start","message":{"id":"msg_budget","type":"message","role":"assistant","model":"${model}","content":[],"usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":10,"output_tokens":1}}}`,
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":50}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n');
}

/** The opening event of {@link anthropicSse} alone: input is reported, output is not yet. */
export function anthropicSseStart(model = 'claude-sonnet-4-5'): string {
  return anthropicSse(model).split('\n').slice(0, 3).join('\n') + '\n';
}

export interface UpstreamRequest {
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

export type UpstreamResponder = (request: UpstreamRequest, response: http.ServerResponse) => void;

export interface HarnessResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface SendOptions {
  /** `Proxy-Authorization` on the CONNECT (a metrics lease); omitted by default, as by an agent that drops it. */
  readonly proxyAuthorization?: string;
}

export interface BudgetHarness {
  readonly gate: BudgetGate;
  readonly proxy: MitmProxy;
  readonly socketPath: string;
  readonly ca: CertificateAuthority;
  /** Every request the fake upstream received. */
  readonly upstreamRequests: readonly UpstreamRequest[];
  respondWith(responder: UpstreamResponder): void;
  /** Sends one completion request through the proxy and reads the whole response. */
  send(body: Readonly<Record<string, unknown>>, options?: SendOptions): Promise<HarnessResponse>;
  /** Sends one completion request and drops the connection as soon as response bytes arrive. */
  sendAndAbortOnFirstData(body: Readonly<Record<string, unknown>>): Promise<void>;
  close(): Promise<void>;
}

export interface BudgetHarnessOptions {
  readonly gate: BudgetGateOptions;
  readonly statisticsEnabled?: boolean;
  /** Provider served by the proxy; defaults to Anthropic routed to the fake upstream. */
  readonly provider?: (upstreamPort: number) => ProviderConfig;
}

/** Anthropic's provider config with its upstream replaced by the loopback fake. */
export function loopbackAnthropicProvider(upstreamPort: number): ProviderConfig {
  return {
    ...anthropicProvider,
    upstreamTarget: { hostname: '127.0.0.1', port: upstreamPort, pathPrefix: '', useTls: false },
  };
}

/** Fake upstream answer: one complete SSE completion. */
export const respondWithSse =
  (payload = anthropicSse()): UpstreamResponder =>
  (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    response.end(payload);
  };

function readResponse(tlsSocket: tls.TLSSocket): Promise<HarnessResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    tlsSocket.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    tlsSocket.on('error', reject);
    tlsSocket.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const boundary = bytes.indexOf('\r\n\r\n');
      if (boundary < 0) {
        reject(new Error('missing HTTP response header boundary'));
        return;
      }
      const lines = bytes.subarray(0, boundary).toString('latin1').split('\r\n');
      const statusCode = Number.parseInt(lines[0]?.split(' ')[1] ?? '', 10);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const separator = line.indexOf(':');
        if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
      }
      resolve({ statusCode, headers, body: bytes.subarray(boundary + 4).toString('utf8') });
    });
  });
}

function writeRequest(tlsSocket: tls.TLSSocket, body: Buffer): void {
  tlsSocket.write(
    [
      'POST /v1/messages HTTP/1.1',
      `Host: ${CLIENT_HOST}`,
      'Connection: close',
      'Content-Type: application/json',
      `Content-Length: ${body.length}`,
      `x-api-key: ${FAKE_KEY}`,
      '',
      '',
    ].join('\r\n'),
  );
  tlsSocket.write(body);
}

export async function startBudgetHarness(options: BudgetHarnessOptions): Promise<BudgetHarness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'budget-gate-'));
  const socketPath = join(tempDir, 'proxy.sock');
  const ca = loadOrCreateCA(join(tempDir, 'ca'));
  const upstreamRequests: UpstreamRequest[] = [];
  let responder: UpstreamResponder = respondWithSse();

  const upstream = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const captured = { headers: request.headers, body: Buffer.concat(chunks) };
      upstreamRequests.push(captured);
      responder(captured, response);
    });
  });
  const upstreamPort = await new Promise<number>((resolve) => {
    upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as AddressInfo).port));
  });

  const gate = createBudgetGate(options.gate);
  const provider = (options.provider ?? loopbackAnthropicProvider)(upstreamPort);
  const proxy = createMitmProxy({
    socketPath,
    ca,
    statisticsEnabled: options.statisticsEnabled ?? false,
    budgetGate: gate,
    providers: [{ config: provider, fakeKey: FAKE_KEY, realKey: REAL_KEY }],
  });
  await proxy.start();

  async function connect(sendOptions: SendOptions = {}): Promise<tls.TLSSocket> {
    const headers: Record<string, string> =
      sendOptions.proxyAuthorization !== undefined ? { 'Proxy-Authorization': sendOptions.proxyAuthorization } : {};
    const connected = await sendConnect(socketPath, CLIENT_HOST, 443, headers);
    if (connected.statusCode !== 200 || connected.socket === null) {
      throw new Error(`CONNECT refused with ${connected.statusCode}`);
    }
    const socket: Socket = connected.socket;
    return new Promise((resolve, reject) => {
      const tlsSocket = tls.connect({ socket, servername: CLIENT_HOST, ca: ca.certPem }, () => resolve(tlsSocket));
      tlsSocket.once('error', reject);
    });
  }

  return {
    gate,
    proxy,
    socketPath,
    ca,
    upstreamRequests,
    respondWith(next) {
      responder = next;
    },
    async send(body, sendOptions) {
      const tlsSocket = await connect(sendOptions);
      const response = readResponse(tlsSocket);
      writeRequest(tlsSocket, Buffer.from(JSON.stringify(body)));
      return response;
    },
    async sendAndAbortOnFirstData(body) {
      const tlsSocket = await connect();
      await new Promise<void>((resolve, reject) => {
        tlsSocket.once('data', () => {
          tlsSocket.destroy();
          resolve();
        });
        tlsSocket.once('error', reject);
        writeRequest(tlsSocket, Buffer.from(JSON.stringify(body)));
      });
    },
    async close() {
      await proxy.stop();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

// --- Sessions over a gated bundle ---

/**
 * A session config whose own between-turn limits are all off, so a test
 * exercises the bundle's budget gate alone.
 */
export function budgetSessionConfig(): IronCurtainConfig {
  return {
    mcpServers: {},
    userConfig: {
      resourceBudget: { maxTotalTokens: null, maxSteps: null, maxSessionSeconds: null, maxEstimatedCostUsd: null },
      escalationTimeoutSeconds: 120,
      auditRedaction: { enabled: true },
    },
  } as unknown as IronCurtainConfig;
}

/** A batch bundle whose budget gate is `gate` and whose container exec runs `exec`. */
export function gatedBatchInfra(
  tempDir: string,
  gate: BudgetGate,
  exec: ContainerRuntime['exec'],
): DockerInfrastructure {
  const sessionDir = join(tempDir, 'session');
  const sandboxDir = join(tempDir, 'sandbox');
  const escalationDir = join(tempDir, 'escalations');
  for (const dir of [sessionDir, sandboxDir, escalationDir]) mkdirSync(dir, { recursive: true });
  return {
    bundleId: 'budget-session' as BundleId,
    bundleDir: sessionDir,
    workspaceDir: sandboxDir,
    escalationDir,
    auditLogPath: join(tempDir, 'audit.jsonl'),
    proxy: createMockProxy(join(sessionDir, 'proxy.sock')),
    docker: { ...createMockDocker(), exec },
    adapter: createMockAdapter(),
    ca: createMockCA(tempDir),
    fakeKeys: new Map(),
    orientationDir: join(sessionDir, 'orientation'),
    systemPrompt: 'You are a test agent.',
    image: 'ironcurtain-claude-code:latest',
    runtimeKind: 'docker',
    topology: 'uds',
    useTcp: false,
    socketsDir: join(sessionDir, 'sockets'),
    mitmAddr: { socketPath: join(sessionDir, 'mitm.sock') },
    containerId: 'container-budget',
    containerName: 'ironcurtain-budget',
    authKind: 'apikey',
    budgetGate: gate,
    setTokenSessionId: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
  } as unknown as DockerInfrastructure;
}

/** Whether an exec is the turn-kill sweep (`buildTurnKillCommand`). */
export function isTurnSweep(command: readonly string[]): boolean {
  return command[0] === '/bin/sh' && command[2] === TURN_KILL_SWEEP_SCRIPT;
}

/**
 * Container exec for a turn whose agent sends one completion, waits until
 * the gate has charged it, sends a second one, and then keeps running until
 * the host's turn sweep kills it. The responses the agent saw are recorded.
 */
export function overspendingAgentExec(harness: BudgetHarness): {
  readonly exec: ContainerRuntime['exec'];
  readonly responses: readonly HarnessResponse[];
  readonly sweeps: readonly string[];
} {
  const responses: HarnessResponse[] = [];
  const sweeps: string[] = [];
  let release: (() => void) | undefined;
  const killed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const exec: ContainerRuntime['exec'] = async (_containerId, command): Promise<DockerExecResult> => {
    if (isTurnSweep(command)) {
      sweeps.push(command[command.length - 1] ?? '');
      release?.();
      return { exitCode: 0, stdout: '1\n', stderr: '' };
    }
    const body = { model: 'claude-sonnet-4-5', max_tokens: 64, stream: true, messages: [] };
    responses.push(await harness.send(body));
    // The gate charges the first exchange once the proxy has finished it.
    const deadline = Date.now() + 5_000;
    while (harness.gate.snapshot().settledExchanges < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    responses.push(await harness.send(body));
    // Keeps running until the host's sweep kills it (bounded, so a test whose
    // session never sweeps fails instead of hanging).
    await Promise.race([killed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    return { exitCode: 137, stdout: '', stderr: 'Killed' };
  };
  return { exec, responses, sweeps };
}
