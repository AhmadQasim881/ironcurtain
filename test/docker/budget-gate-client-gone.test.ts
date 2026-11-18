/**
 * MITM budget gate (WP-42): a completion request whose client goes away
 * while the proxy is still preparing it is never admitted or forwarded.
 *
 * The exchange's response observer settles as soon as the client leaves; a
 * request admitted after that would keep a ticket nothing ever settles, and
 * the upstream request (which nothing would stop) would be billed without
 * being charged. The body decode is the one wait between reading a body and
 * admitting it, so the test holds it open while the client disconnects.
 */

import * as tls from 'node:tls';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { getLlmMetricsEventBus, resetLlmMetricsEventBus } from '../../src/llm-metrics/event-bus.js';
import type { LlmExchangeCompleted } from '../../src/llm-metrics/types.js';
import * as logger from '../../src/logger.js';
import { CLIENT_HOST, FAKE_KEY, startBudgetHarness, type BudgetHarness } from '../helpers/budget-gate-harness.js';
import { sendConnect } from '../helpers/mitm-tls-harness.js';

const decodeHold = vi.hoisted(() => {
  const state: { reached?: () => void; release?: Promise<void> } = {};
  return state;
});

vi.mock('../../src/docker/request-sanitizers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/docker/request-sanitizers/index.js')>();
  return {
    ...actual,
    decodeRequestBody: async (...args: Parameters<typeof actual.decodeRequestBody>): Promise<Buffer> => {
      const decoded = await actual.decodeRequestBody(...args);
      decodeHold.reached?.();
      await decodeHold.release;
      return decoded;
    },
  };
});

describe('budget gate when the client leaves before its request is forwarded', () => {
  let harness: BudgetHarness | undefined;
  let unsubscribe: (() => void) | undefined;
  let info: MockInstance<typeof logger.info>;

  beforeEach(() => {
    resetLlmMetricsEventBus();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(async () => {
    unsubscribe?.();
    unsubscribe = undefined;
    await harness?.close();
    harness = undefined;
    vi.restoreAllMocks();
  });

  it('neither admits nor forwards it, and leaves no reservation behind', async () => {
    const published: LlmExchangeCompleted[] = [];
    unsubscribe = getLlmMetricsEventBus().subscribe((exchange) => published.push(exchange));
    harness = await startBudgetHarness({
      gate: { mode: 'session', limits: { maxTotalTokens: null, maxEstimatedCostUsd: null } },
      statisticsEnabled: true,
    });
    const reached = new Promise<void>((resolve) => {
      decodeHold.reached = resolve;
    });
    let release: () => void = () => {};
    decodeHold.release = new Promise<void>((resolve) => {
      release = resolve;
    });

    const body = gzipSync(
      JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1,
        stream: true,
        messages: [{ role: 'user', content: 'z'.repeat(50_000) }],
      }),
    );
    const connected = await sendConnect(harness.socketPath, CLIENT_HOST, 443);
    if (connected.socket === null) throw new Error(`CONNECT refused with ${connected.statusCode}`);
    const socket = connected.socket;
    const ca = harness.ca;
    const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const connection = tls.connect({ socket, servername: CLIENT_HOST, ca: ca.certPem }, () => resolve(connection));
      connection.once('error', reject);
    });
    tlsSocket.on('error', () => {});
    // The sentinel also rides in a query carrier, which logs must never show.
    tlsSocket.write(
      [
        `POST /v1/messages?beta=true&key=${FAKE_KEY} HTTP/1.1`,
        `Host: ${CLIENT_HOST}`,
        'Content-Type: application/json',
        'Content-Encoding: gzip',
        `Content-Length: ${body.length}`,
        `x-api-key: ${FAKE_KEY}`,
        '',
        '',
      ].join('\r\n'),
    );
    tlsSocket.write(body);

    // The body is read and decoded; the client leaves before it is admitted.
    // Its exchange record is published once the proxy has seen it go.
    await reached;
    tlsSocket.destroy();
    await expect.poll(() => published.length).toBe(1);
    release();
    // Either the proxy gives the request up, or it admits and forwards it
    // (which would reach the fake upstream within moments).
    const gaveUp = (): boolean =>
      info.mock.calls.some(([message]) => message.includes('not forwarded: the client closed'));
    await expect.poll(() => gaveUp() || harness?.gate.snapshot().admittedRequests === 1).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(harness.upstreamRequests).toHaveLength(0);
    expect(harness.gate.snapshot()).toMatchObject({
      admittedRequests: 0,
      reservedTokens: 0,
      settledExchanges: 0,
    });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(
        `POST ${CLIENT_HOST}/v1/messages?beta=true&key=<redacted> not forwarded: the client closed the connection`,
      ),
    );
    expect(info.mock.calls.map(([message]) => message).join('\n')).not.toContain(FAKE_KEY);
  });
});
