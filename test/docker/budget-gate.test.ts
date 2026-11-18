/**
 * MITM budget gate (WP-42): host-enforced token and cost limits per bundle.
 *
 * Unit tests pin the gate's admission and settlement rules; the fake-upstream
 * tests drive real requests through a MITM proxy with a gate; the session
 * tests run DockerAgentSession turns whose "agent" sends requests through
 * that proxy.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  BUDGET_EXHAUSTED_ERROR_TYPE,
  BUDGET_REFUSAL_HEADER,
  BUDGET_REFUSAL_STATUS,
  DEFAULT_OUTPUT_TOKEN_ESTIMATE,
  ESTIMATED_REQUEST_BYTES_PER_INPUT_TOKEN,
  NO_ACTIVE_TURN_ERROR_TYPE,
  UNATTRIBUTED_STATE_KEY,
  budgetGateOptionsFor,
  budgetRefusalResponse,
  createBudgetGate,
  requestedChoiceCount,
  requestedOutputCap,
  requestedSpeed,
  type BudgetGate,
  type BudgetTicket,
} from '../../src/docker/budget-gate.js';
import { DockerAgentSession } from '../../src/docker/docker-agent-session.js';
import { openaiProvider, type ProviderConfig } from '../../src/docker/provider-config.js';
import { buildTurnKillCommand, TURN_MARKER_ENV } from '../../src/docker/turn-timeout.js';
import type { ContainerRuntime, DockerExecResult } from '../../src/docker/types.js';
import { getLlmMetricsEventBus, resetLlmMetricsEventBus } from '../../src/llm-metrics/event-bus.js';
import { makeNormalizedUsage, type NormalizedUsageInput } from '../../src/llm-metrics/normalization.js';
import { GoogleGenerateContentAdapter } from '../../src/llm-metrics/protocols/google-generate-content.js';
import type { LlmExchangeCompleted, NormalizedStopReason } from '../../src/llm-metrics/types.js';
import * as logger from '../../src/logger.js';
import type { AgentConversationId, DiagnosticEvent, SessionId } from '../../src/session/types.js';
import {
  CLIENT_HOST,
  FAKE_KEY,
  SSE_INPUT_TOKENS,
  SSE_TOTAL_TOKENS,
  anthropicSse,
  anthropicSseStart,
  budgetSessionConfig,
  gatedBatchInfra,
  isTurnSweep,
  loopbackAnthropicProvider,
  respondWithSse,
  startBudgetHarness,
  type BudgetHarness,
} from '../helpers/budget-gate-harness.js';
import { makeHttpsRequest, sendConnect } from '../helpers/mitm-tls-harness.js';

// Sonnet 4.5 list prices (USD per million tokens): input, output, cache read, 5-minute cache write.
const SONNET_45 = { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75 };
/** List price of the harness SSE (100 uncached, 20 cache read, 10 cache write, 50 output) on Sonnet 4.5. */
const SSE_COST_USD =
  (100 * SONNET_45.input + 20 * SONNET_45.cacheRead + 10 * SONNET_45.cacheWrite5m + 50 * SONNET_45.output) / 1e6;
// Claude Opus 5.5 standard list prices; its fast mode (`speed: "fast"`) bills every rate at twice these.
const OPUS_55 = { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5 };
const OPUS_55_FAST_MULTIPLIER = 2;
/** Standard list price of the harness SSE's usage on Opus 5.5. */
const OPUS_55_SSE_COST_USD =
  (100 * OPUS_55.input + 20 * OPUS_55.cacheRead + 10 * OPUS_55.cacheWrite5m + 50 * OPUS_55.output) / 1e6;

const NO_LIMITS = { maxTotalTokens: null, maxEstimatedCostUsd: null } as const;

function completionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-sonnet-4-5',
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

interface RecordOptions {
  readonly model?: string | null;
  /** The protocol's terminal event was observed. */
  readonly terminal?: boolean;
  readonly stopReason?: NormalizedStopReason;
  readonly stateId?: string | null;
  /** The request's speed as the exchange observer read it. */
  readonly speedMode?: string | null;
  /** Quality flags of the request facts (for example `unknown_speed_mode`). */
  readonly requestFlags?: readonly string[];
}

/** An observed exchange record with the given usage. */
function exchangeRecord(usage: NormalizedUsageInput, options: RecordOptions = {}): LlmExchangeCompleted {
  const model = options.model === undefined ? 'claude-sonnet-4-5' : options.model;
  const terminal = options.terminal ?? true;
  return {
    schemaVersion: 1,
    exchangeId: `exchange-${Math.random()}`,
    attribution: {
      sessionId: null,
      agentConversationId: null,
      turnId: null,
      bundleId: 'bundle',
      workflowRunId: null,
      stateId: options.stateId ?? null,
      personaId: null,
      agentId: null,
      quality: 'bundle_only',
    },
    route: {
      logicalProvider: 'anthropic',
      providerProfileId: null,
      protocol: 'anthropic-messages',
      gatewayKind: 'direct',
      clientRouteId: null,
      upstreamRouteId: null,
    },
    identity: {
      requestedModel: { value: model, source: model === null ? 'not_exposed' : 'request' },
      forwardedModel: { value: model, source: model === null ? 'not_exposed' : 'forwarded_request' },
      responseModel: { value: model, source: model === null ? 'not_exposed' : 'protocol_response' },
      servedModel: { value: null, source: 'not_exposed' },
      servedProvider: { value: null, source: 'not_exposed' },
    },
    responseMetadata: {
      providerRequestId: null,
      providerResponseId: null,
      gatewayGenerationId: null,
      actualServiceTier: null,
    },
    request: {
      requestedModel: model,
      streaming: true,
      requestedServiceTier: null,
      reasoningMode: 'unknown',
      reasoningEffort: null,
      thinkingBudgetTokens: null,
      speedMode: options.speedMode ?? null,
      qualityFlags: options.requestFlags ?? [],
    },
    outcome: {
      termination: terminal ? 'stop' : 'aborted',
      providerStopReason: options.stopReason ?? (terminal ? 'end_turn' : 'not_reported'),
      responseStatus: 200,
      refusal: null,
      refusalCategory: null,
      refusalSource: 'not_reported',
    },
    usage: makeNormalizedUsage(usage),
    timing: {
      requestReceivedAt: new Date().toISOString(),
      requestBodyCompleteOffsetMs: 1,
      responseHeadersOffsetMs: 2,
      firstUpstreamBodyByteOffsetMs: 3,
      firstProtocolEventOffsetMs: 3,
      firstReasoningEventOffsetMs: null,
      lastReasoningEventOffsetMs: null,
      firstOutputEventOffsetMs: null,
      lastOutputEventOffsetMs: null,
      protocolTerminalOffsetMs: terminal ? 4 : null,
      upstreamResponseEndOffsetMs: 5,
      clientDeliveryEndOffsetMs: 5,
      clientAborted: !terminal,
    },
    transportAttempts: [],
    gatewayRouteAttempts: [],
    qualityFlags: [],
  };
}

/** Final Anthropic usage: 100 uncached + 20 cache read + 10 cache write input, 50 output. */
const FINAL_USAGE: NormalizedUsageInput = {
  inputTokensReported: 100,
  inputTokensTotal: 130,
  inputTokensUncached: 100,
  cacheReadInputTokens: 20,
  cacheWriteInputTokens: 10,
  outputTokensReported: 50,
  outputTokensTotal: 50,
  canonicalTotalTokens: 180,
  usageCompleteness: 'complete',
};

/**
 * Final usage of a 250K-token prompt with 1,000 output tokens: past Sonnet
 * 4.5's 200K-token threshold, above which it bills at its 1M-context price
 * (not in the table).
 */
const LONG_PROMPT_USAGE: NormalizedUsageInput = {
  inputTokensReported: 250_000,
  inputTokensTotal: 250_000,
  inputTokensUncached: 250_000,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokensReported: 1_000,
  outputTokensTotal: 1_000,
  canonicalTotalTokens: 251_000,
  usageCompleteness: 'complete',
};
/** LONG_PROMPT_USAGE at Sonnet 4.5's listed (base) rates: $0.765. */
const LONG_PROMPT_LISTED_USD = (250_000 * SONNET_45.input + 1_000 * SONNET_45.output) / 1e6;

/**
 * Complete-looking counters before the final report: what a stream with
 * cumulative per-chunk usage (Gemini, some Chat Completions gateways) shows
 * mid-stream, here with one output token delivered so far.
 */
const MID_STREAM_USAGE: NormalizedUsageInput = {
  ...FINAL_USAGE,
  outputTokensReported: 1,
  outputTokensTotal: 1,
  canonicalTotalTokens: 131,
};

function admit(
  gate: BudgetGate,
  outputCapTokens: number | null,
  model: string | null = 'claude-sonnet-4-5',
): BudgetTicket {
  const admission = gate.admit({ protocol: 'anthropic-messages', model, outputCapTokens });
  if (!admission.admitted) throw new Error(`unexpected refusal: ${admission.refusal.message}`);
  return admission.ticket;
}

/** A Sonnet 4.5 Messages request of `requestBytes` bytes as forwarded. */
function admitSized(gate: BudgetGate, outputCapTokens: number | null, requestBytes: number): BudgetTicket {
  const admission = gate.admit({
    protocol: 'anthropic-messages',
    model: 'claude-sonnet-4-5',
    outputCapTokens,
    requestBytes,
  });
  if (!admission.admitted) throw new Error(`unexpected refusal: ${admission.refusal.message}`);
  return admission.ticket;
}

/** A ticket whose upstream attempt was answered with `status`. */
function answered(ticket: BudgetTicket, status = 200): BudgetTicket {
  ticket.markDelivered();
  ticket.markUpstreamStatus(status);
  return ticket;
}

describe('budget gate', () => {
  let warn: MockInstance<typeof logger.warn>;

  beforeEach(() => {
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('admission', () => {
    it('pre-charges the output cap and refuses a request that would take the totals past the token limit', () => {
      const gate = createBudgetGate({ mode: 'session', limits: { maxTotalTokens: 1_000, maxEstimatedCostUsd: null } });
      const exhausted = vi.fn();
      gate.onExhausted(exhausted);

      admit(gate, 600);
      expect(gate.snapshot()).toMatchObject({ reservedTokens: 600, admittedRequests: 1, totalTokens: 0 });

      // 0 charged + 600 in flight + 500 for this request > 1,000.
      const refused = gate.admit({ protocol: 'anthropic-messages', model: 'claude-sonnet-4-5', outputCapTokens: 500 });
      expect(refused.admitted).toBe(false);
      if (refused.admitted) return;
      expect(refused.refusal).toMatchObject({
        reason: 'budget_exhausted',
        exhaustion: { dimension: 'tokens', used: 0, reserved: 1_100, limit: 1_000 },
      });
      expect(refused.refusal.message).toMatch(/^Token budget exhausted: 0 of 1,000 tokens/);
      expect(exhausted).toHaveBeenCalledOnce();

      // The first refusal latches: even a one-token request is refused now,
      // and the listeners are not called again.
      expect(gate.admit({ protocol: 'anthropic-messages', model: null, outputCapTokens: 1 }).admitted).toBe(false);
      expect(gate.precheck()?.reason).toBe('budget_exhausted');
      expect(exhausted).toHaveBeenCalledOnce();
      expect(gate.exhaustion()?.dimension).toBe('tokens');
      expect(gate.snapshot().refusedRequests).toBe(3);
    });

    it('refuses on the cost limit, pricing the reservation at the requested model output rate', () => {
      // Claude Opus 4.6 output lists at $25 per million tokens: 1,000 tokens reserve $0.025.
      const gate = createBudgetGate({ mode: 'session', limits: { maxTotalTokens: null, maxEstimatedCostUsd: 0.02 } });
      const refused = gate.admit({ protocol: 'anthropic-messages', model: 'claude-opus-4-6', outputCapTokens: 1_000 });
      expect(refused.admitted).toBe(false);
      if (refused.admitted) return;
      expect(refused.refusal.exhaustion).toMatchObject({ dimension: 'cost', limit: 0.02 });
      expect(refused.refusal.exhaustion?.reserved).toBeCloseTo(0.025, 12);
      expect(refused.refusal.message).toMatch(/^Cost budget exhausted: \$0\.00 of \$0\.02/);
    });

    it('reserves a fast-mode request at the fast-mode output price', () => {
      // 1,000 Opus 5.5 output tokens reserve $0.02 at the standard price and $0.04 in fast mode.
      const limits = { maxTotalTokens: null, maxEstimatedCostUsd: 0.03 };
      const standard = createBudgetGate({ mode: 'session', limits });
      expect(
        standard.admit({ protocol: 'anthropic-messages', model: 'claude-opus-5-5', outputCapTokens: 1_000 }).admitted,
      ).toBe(true);
      expect(standard.snapshot().reservedCostUsd).toBeCloseTo((1_000 * OPUS_55.output) / 1e6, 12);

      const fast = createBudgetGate({ mode: 'session', limits });
      const refused = fast.admit({
        protocol: 'anthropic-messages',
        model: 'claude-opus-5-5',
        outputCapTokens: 1_000,
        speed: 'fast',
      });
      expect(refused.admitted).toBe(false);
      if (refused.admitted) return;
      expect(refused.refusal.exhaustion?.dimension).toBe('cost');
      expect(refused.refusal.exhaustion?.reserved).toBeCloseTo(
        (1_000 * OPUS_55.output * OPUS_55_FAST_MULTIPLIER) / 1e6,
        12,
      );
    });

    it('reserves the documented default for a request without an output cap, and prices an unnamed model fail-closed', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      admit(gate, null, null);
      // No model: the highest Claude tier, $50 per million output tokens.
      expect(gate.snapshot().reservedTokens).toBe(DEFAULT_OUTPUT_TOKEN_ESTIMATE);
      expect(gate.snapshot().reservedCostUsd).toBeCloseTo((DEFAULT_OUTPUT_TOKEN_ESTIMATE * 50) / 1e6, 12);
    });

    it('reserves the output cap once for every choice the request asks for', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      const capped = gate.admit({
        protocol: 'openai-chat-completions',
        model: 'gpt-4.1',
        outputCapTokens: 100,
        choices: 4,
      });
      expect(capped.admitted).toBe(true);
      expect(gate.snapshot().reservedTokens).toBe(400);
      // No cap named: the default stands in for each choice.
      gate.admit({ protocol: 'openai-chat-completions', model: 'gpt-4.1', outputCapTokens: null, choices: 2 });
      expect(gate.snapshot().reservedTokens).toBe(400 + 2 * DEFAULT_OUTPUT_TOKEN_ESTIMATE);

      // n choices of a 1,000-token cap do not fit a 2,000-token budget.
      const tight = createBudgetGate({ mode: 'session', limits: { maxTotalTokens: 2_000, maxEstimatedCostUsd: null } });
      const refused = tight.admit({
        protocol: 'openai-chat-completions',
        model: 'gpt-4.1',
        outputCapTokens: 1_000,
        choices: 3,
      });
      expect(refused.admitted).toBe(false);
    });

    it('forwards completions in turn mode only while a host turn is open, without latching the budget', () => {
      const gate = createBudgetGate({ mode: 'turn', limits: NO_LIMITS });
      const exhausted = vi.fn();
      gate.onExhausted(exhausted);

      expect(gate.precheck()).toMatchObject({ reason: 'no_active_turn' });
      expect(gate.admit({ protocol: 'anthropic-messages', model: null, outputCapTokens: 1 }).admitted).toBe(false);

      const first = gate.beginTurn();
      const second = gate.beginTurn();
      expect(gate.precheck()).toBeUndefined();
      first.end();
      first.end(); // idempotent: one end per turn
      expect(gate.snapshot().activeTurns).toBe(1);
      expect(gate.precheck()).toBeUndefined();
      second.end();
      expect(gate.precheck()?.reason).toBe('no_active_turn');

      expect(gate.exhaustion()).toBeUndefined();
      expect(exhausted).not.toHaveBeenCalled();
    });

    it('needs no turn in session mode', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      expect(gate.precheck()).toBeUndefined();
      expect(gate.admit({ protocol: 'anthropic-messages', model: null, outputCapTokens: 10 }).admitted).toBe(true);
    });

    it('reports a limit the charged totals reached between turns, and latches it on the next request', () => {
      const gate = createBudgetGate({ mode: 'session', limits: { maxTotalTokens: 150, maxEstimatedCostUsd: null } });
      const exhausted = vi.fn();
      gate.onExhausted(exhausted);

      // Admitted within the limit (64 <= 150); its input takes the total past it.
      answered(admit(gate, 64)).settle(exchangeRecord(FINAL_USAGE));
      expect(gate.snapshot().totalTokens).toBe(180);
      expect(gate.exhaustion()).toMatchObject({ dimension: 'tokens', used: 180, limit: 150 });
      expect(exhausted).not.toHaveBeenCalled();

      expect(gate.precheck()?.reason).toBe('budget_exhausted');
      expect(exhausted).toHaveBeenCalledOnce();
    });

    it('rejects limits that are neither positive numbers nor null', () => {
      expect(() =>
        createBudgetGate({ mode: 'turn', limits: { maxTotalTokens: 0, maxEstimatedCostUsd: null } }),
      ).toThrow(/maxTotalTokens/);
      expect(() =>
        createBudgetGate({ mode: 'turn', limits: { maxTotalTokens: null, maxEstimatedCostUsd: Number.NaN } }),
      ).toThrow(/maxEstimatedCostUsd/);
    });
  });

  describe('settlement', () => {
    it('charges final usage at its measured tokens and list price, releasing the reservation', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      answered(admit(gate, 64)).settle(exchangeRecord(FINAL_USAGE));

      const snapshot = gate.snapshot();
      expect(snapshot).toMatchObject({
        totalTokens: 180,
        reservedTokens: 0,
        reservedCostUsd: 0,
        settledExchanges: 1,
        estimatedExchanges: 0,
      });
      expect(snapshot.costUsd).toBeCloseTo(SSE_COST_USD, 12);
      expect(warn).not.toHaveBeenCalled();
    });

    it('charges fast mode at the fast-mode list price, whether the request or the exchange record names it', () => {
      const charged = (speed: 'fast' | undefined, record: RecordOptions): number => {
        const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
        const admission = gate.admit({
          protocol: 'anthropic-messages',
          model: 'claude-opus-5-5',
          outputCapTokens: 64,
          ...(speed !== undefined ? { speed } : {}),
        });
        if (!admission.admitted) throw new Error(`unexpected refusal: ${admission.refusal.message}`);
        answered(admission.ticket).settle(exchangeRecord(FINAL_USAGE, { model: 'claude-opus-5-5', ...record }));
        return gate.snapshot().costUsd;
      };
      const fastCost = OPUS_55_SSE_COST_USD * OPUS_55_FAST_MULTIPLIER;

      expect(charged(undefined, {})).toBeCloseTo(OPUS_55_SSE_COST_USD, 12);
      // The request as the proxy forwarded it asked for fast mode.
      expect(charged('fast', {})).toBeCloseTo(fastCost, 12);
      // A body the proxy did not inspect: the observed request names fast mode,
      // or a speed the protocol adapter did not recognize (priced fail-closed).
      expect(charged(undefined, { speedMode: 'fast' })).toBeCloseTo(fastCost, 12);
      expect(charged(undefined, { requestFlags: ['unknown_speed_mode'] })).toBeCloseTo(fastCost, 12);
    });

    it('estimates an unmeasured fast-mode exchange at the fast-mode price, and lists rates where none exists', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      const admission = gate.admit({
        protocol: 'anthropic-messages',
        model: 'claude-opus-5-5',
        outputCapTokens: 1_000,
        speed: 'fast',
      });
      if (!admission.admitted) throw new Error(`unexpected refusal: ${admission.refusal.message}`);
      answered(admission.ticket).settle();
      expect(gate.snapshot().costUsd).toBeCloseTo((1_000 * OPUS_55.output * OPUS_55_FAST_MULTIPLIER) / 1e6, 12);

      // Sonnet 4.5 has no fast-mode price: a fast request is charged its listed rates.
      const sonnet = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      const sonnetAdmission = sonnet.admit({
        protocol: 'anthropic-messages',
        model: 'claude-sonnet-4-5',
        outputCapTokens: 64,
        speed: 'fast',
      });
      if (!sonnetAdmission.admitted) throw new Error(`unexpected refusal: ${sonnetAdmission.refusal.message}`);
      answered(sonnetAdmission.ticket).settle(exchangeRecord(FINAL_USAGE));
      expect(sonnet.snapshot().costUsd).toBeCloseTo(SSE_COST_USD, 12);
    });

    it('charges a prompt past the unmodeled long-context threshold twice the listed rates, warning once per model', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      answered(admit(gate, 64)).settle(exchangeRecord(LONG_PROMPT_USAGE));
      expect(gate.snapshot().costUsd).toBeCloseTo(2 * LONG_PROMPT_LISTED_USD, 12);
      answered(admit(gate, 64)).settle(exchangeRecord(LONG_PROMPT_USAGE, { model: 'claude-sonnet-4-5-20250929' }));
      expect(gate.snapshot()).toMatchObject({ totalTokens: 502_000, estimatedExchanges: 0 });
      expect(gate.snapshot().costUsd).toBeCloseTo(4 * LONG_PROMPT_LISTED_USD, 12);
      const notices = warn.mock.calls.filter(([message]) => message.includes('long-context prices'));
      expect(notices).toHaveLength(1);
      expect(notices[0]?.[0]).toContain('"claude-sonnet-4-5"');

      // A prompt at the threshold is charged the listed rates.
      const atThreshold = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      answered(admit(atThreshold, 64)).settle(
        exchangeRecord({
          ...LONG_PROMPT_USAGE,
          inputTokensReported: 200_000,
          inputTokensTotal: 200_000,
          inputTokensUncached: 200_000,
          canonicalTotalTokens: 201_000,
        }),
      );
      expect(atThreshold.snapshot().costUsd).toBeCloseTo(
        (200_000 * SONNET_45.input + 1_000 * SONNET_45.output) / 1e6,
        12,
      );
    });

    it("refuses the next request once a long prompt's charge crosses maxEstimatedCostUsd", () => {
      // $0.765 at the listed rates would leave room under $1; the $1.53 charged does not.
      const gate = createBudgetGate({ mode: 'session', limits: { maxTotalTokens: null, maxEstimatedCostUsd: 1 } });
      const exhausted = vi.fn();
      gate.onExhausted(exhausted);
      answered(admit(gate, 64)).settle(exchangeRecord(LONG_PROMPT_USAGE));

      expect(gate.exhaustion()).toMatchObject({ dimension: 'cost', limit: 1 });
      const next = gate.admit({ protocol: 'anthropic-messages', model: 'claude-sonnet-4-5', outputCapTokens: 64 });
      expect(next.admitted).toBe(false);
      expect(next.admitted ? undefined : next.refusal.reason).toBe('budget_exhausted');
      expect(exhausted).toHaveBeenCalledTimes(1);
    });

    it('decides the long-context charge per billing attempt', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      const attempt = (inputTokensUncached: number) => ({
        kind: 'message' as const,
        model: 'claude-sonnet-4-5',
        inputTokensUncached,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1_000,
      });
      answered(admit(gate, 2_000)).settle(
        exchangeRecord({
          inputTokensTotal: 260_000,
          inputTokensUncached: 260_000,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokensTotal: 2_000,
          canonicalTotalTokens: 262_000,
          usageCompleteness: 'complete',
          iterations: [attempt(250_000), attempt(10_000)],
        }),
      );
      // Only the 250K-token attempt is past the threshold.
      const listed = (input: number) => (input * SONNET_45.input + 1_000 * SONNET_45.output) / 1e6;
      expect(gate.snapshot().costUsd).toBeCloseTo(2 * listed(250_000) + listed(10_000), 12);
    });

    it("charges the gateway's own cost when it reports one", () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      answered(admit(gate, 64)).settle(exchangeRecord({ ...FINAL_USAGE, costUsd: 0.42 }));
      expect(gate.snapshot().costUsd).toBe(0.42);
    });

    it('prices each billing attempt at its own model', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      const usage: NormalizedUsageInput = {
        inputTokensTotal: 3_000,
        inputTokensUncached: 3_000,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokensTotal: 300,
        canonicalTotalTokens: 3_300,
        usageCompleteness: 'complete',
        iterations: [
          {
            kind: 'fallback_message',
            model: 'claude-opus-4-6',
            inputTokensUncached: 1_000,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 100,
          },
          {
            kind: 'message',
            model: 'claude-sonnet-4-5',
            inputTokensUncached: 2_000,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 200,
          },
        ],
      };
      answered(admit(gate, 1_000)).settle(exchangeRecord(usage));
      // Opus 4.6 ($5/$25) for the first attempt, Sonnet 4.5 ($3/$15) for the second.
      expect(gate.snapshot().totalTokens).toBe(3_300);
      expect(gate.snapshot().costUsd).toBeCloseTo((1_000 * 5 + 100 * 25 + 2_000 * 3 + 200 * 15) / 1e6, 12);
    });

    it('charges an exchange whose usage was not observed the output cap, and warns', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      answered(admit(gate, 4_096)).settle();
      answered(admit(gate, null)).settle();

      const snapshot = gate.snapshot();
      expect(snapshot.totalTokens).toBe(4_096 + DEFAULT_OUTPUT_TOKEN_ESTIMATE);
      expect(snapshot.costUsd).toBeCloseTo(((4_096 + DEFAULT_OUTPUT_TOKEN_ESTIMATE) * SONNET_45.output) / 1e6, 12);
      expect(snapshot.estimatedExchanges).toBe(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be measured'));
    });

    it('charges a response that reported no usage the output cap', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      answered(admit(gate, 2_000)).settle(exchangeRecord({ usageCompleteness: 'missing' }, { terminal: false }));
      expect(gate.snapshot()).toMatchObject({ totalTokens: 2_000, estimatedExchanges: 1 });
    });

    it('charges input that was never reported an estimate from the request size, at the plain input rate', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      const requestBytes = 30_000;
      const estimate = Math.ceil(requestBytes / ESTIMATED_REQUEST_BYTES_PER_INPUT_TOKEN);
      // A response without usage (a Chat Completions stream without
      // include_usage, a stream dropped before its usage event), and a route
      // the proxy does not parse: neither makes the request's input free.
      const noUsage = admitSized(gate, 1, requestBytes);
      answered(noUsage).settle(exchangeRecord({ usageCompleteness: 'missing' }, { terminal: false }));
      answered(admitSized(gate, 1, requestBytes)).settle();
      const snapshot = gate.snapshot();
      expect(snapshot).toMatchObject({ totalTokens: 2 * (estimate + 1), estimatedExchanges: 2 });
      expect(snapshot.costUsd).toBeCloseTo((2 * (estimate * SONNET_45.input + SONNET_45.output)) / 1e6, 12);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('input estimated from the request size'));
    });

    it('keeps a measured input total, and raises measured input parts to the estimate', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      // The input total was reported (message_start): it is what is charged.
      answered(admitSized(gate, 4_096, 30_000)).settle(exchangeRecord(MID_STREAM_USAGE, { terminal: false }));
      expect(gate.snapshot().totalTokens).toBe(SSE_INPUT_TOKENS + 4_096);

      // Only a part of the input is known: the larger of the part and the estimate.
      const partial = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      answered(admitSized(partial, 10, 3_000)).settle(
        exchangeRecord({ inputTokensUncached: 200, usageCompleteness: 'partial' }, { terminal: false }),
      );
      expect(partial.snapshot().totalTokens).toBe(1_000 + 10);
    });

    it('counts the bytes of a body that streamed through for the estimate', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      const ticket = admit(gate, 1);
      ticket.addRequestBytes(1_500);
      ticket.addRequestBytes(1_500);
      ticket.addRequestBytes(-5); // ignored
      answered(ticket).settle();
      ticket.addRequestBytes(9_000); // after settlement: ignored
      expect(gate.snapshot().totalTokens).toBe(1_000 + 1);
    });

    it('charges a stream cut before its final usage report its measured input plus the output cap', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      // The counters are "complete", but the final report never arrived.
      answered(admit(gate, 4_096)).settle(exchangeRecord(MID_STREAM_USAGE, { terminal: false }));
      const snapshot = gate.snapshot();
      expect(snapshot.totalTokens).toBe(SSE_INPUT_TOKENS + 4_096);
      expect(snapshot.costUsd).toBeCloseTo(
        (100 * SONNET_45.input + 20 * SONNET_45.cacheRead + 10 * SONNET_45.cacheWrite5m + 4_096 * SONNET_45.output) /
          1e6,
        12,
      );
      expect(snapshot.estimatedExchanges).toBe(1);
    });

    it('treats a Gemini stream abandoned mid-way as unmeasured although its counters are complete', () => {
      // The real Gemini accumulator after one chunk with cumulative usage and no finishReason.
      const accumulator = new GoogleGenerateContentAdapter().createAccumulator();
      accumulator.observeStreamEvent({
        data: {
          candidates: [{ content: { parts: [{ text: 'partial' }] } }],
          usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 5, totalTokenCount: 1_005 },
        },
      });
      const observed = accumulator.snapshot();
      expect(observed.usage.usageCompleteness).toBe('complete');
      expect(observed.protocolTerminal).toBe(false);

      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      answered(admit(gate, 8_192, 'gemini-2.5-pro')).settle(
        exchangeRecord(observed.usage, { terminal: false, model: 'gemini-2.5-pro' }),
      );
      expect(gate.snapshot()).toMatchObject({ totalTokens: 1_000 + 8_192, estimatedExchanges: 1 });
    });

    it('counts a final usage report even when the client left before the terminal event', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      // message_delta (with its stop reason and final usage) arrived; message_stop did not.
      answered(admit(gate, 4_096)).settle(exchangeRecord(FINAL_USAGE, { terminal: false, stopReason: 'end_turn' }));
      expect(gate.snapshot()).toMatchObject({ totalTokens: 180, estimatedExchanges: 0 });
    });

    it('charges nothing for an error response or for a request that never reached the provider', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      answered(admitSized(gate, 4_096, 30_000), 529).settle();
      // The upstream connection never came up.
      admitSized(gate, 4_096, 30_000).settle();
      expect(gate.snapshot()).toMatchObject({ totalTokens: 0, costUsd: 0, settledExchanges: 2, estimatedExchanges: 0 });

      // Delivered but never answered (a reset or a deadline after the
      // request went out): the provider may have billed it.
      const delivered = admit(gate, 4_096);
      delivered.markDelivered();
      delivered.settle();
      expect(gate.snapshot()).toMatchObject({ totalTokens: 4_096, estimatedExchanges: 1 });
    });

    it("judges the OAuth retry's outcome, not the first attempt's 401", () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      const retried = answered(admit(gate, 64), 401);
      retried.beginAttempt();
      answered(retried, 200).settle(exchangeRecord(FINAL_USAGE));
      expect(gate.snapshot().totalTokens).toBe(180);

      // A retry that never connected leaves only the unbilled 401.
      const failedRetry = answered(admit(gate, 64), 401);
      failedRetry.beginAttempt();
      failedRetry.settle();
      expect(gate.snapshot()).toMatchObject({ totalTokens: 180, estimatedExchanges: 0 });
    });

    it('settles a ticket once', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      const ticket = answered(admit(gate, 64));
      ticket.settle(exchangeRecord(FINAL_USAGE));
      ticket.settle(exchangeRecord(FINAL_USAGE));
      ticket.settle();
      expect(gate.snapshot()).toMatchObject({ totalTokens: 180, settledExchanges: 1 });
    });

    it('reports charged usage per workflow state from the exchange attribution', () => {
      const gate = createBudgetGate({ mode: 'session', limits: NO_LIMITS });
      answered(admit(gate, 64)).settle(exchangeRecord(FINAL_USAGE, { stateId: 'plan' }));
      answered(admit(gate, 64)).settle(exchangeRecord(FINAL_USAGE, { stateId: 'build' }));
      answered(admit(gate, 64)).settle(exchangeRecord(FINAL_USAGE, { stateId: 'build' }));
      answered(admit(gate, 500)).settle();
      expect(gate.snapshot().byState).toEqual({
        plan: { totalTokens: 180, costUsd: expect.closeTo(SSE_COST_USD, 12), exchanges: 1 },
        build: { totalTokens: 360, costUsd: expect.closeTo(2 * SSE_COST_USD, 12), exchanges: 2 },
        [UNATTRIBUTED_STATE_KEY]: { totalTokens: 500, costUsd: expect.closeTo((500 * 15) / 1e6, 12), exchanges: 1 },
      });
      expect(gate.snapshot().totalTokens).toBe(180 * 3 + 500);
    });
  });

  describe('request facts and responses', () => {
    it("reads each protocol's output cap spelling", () => {
      expect(requestedOutputCap('anthropic-messages', { max_tokens: 4_096 })).toBe(4_096);
      expect(requestedOutputCap('openai-responses', { max_output_tokens: 2_000, max_tokens: 9_000 })).toBe(2_000);
      expect(requestedOutputCap('openai-chat-completions', { max_completion_tokens: 300, max_tokens: 500 })).toBe(500);
      expect(requestedOutputCap('google-generate-content', { generationConfig: { maxOutputTokens: 8_192 } })).toBe(
        8_192,
      );
      // An unknown protocol: any known spelling counts, the largest wins.
      expect(requestedOutputCap('vendor-protocol', { max_output_tokens: 10, max_tokens: 20 })).toBe(20);
      expect(requestedOutputCap(null, { generationConfig: { maxOutputTokens: 7 } })).toBe(7);
    });

    it('reads every spelling a lenient upstream decoder accepts, and the largest counts', () => {
      // Google's JSON mapping also accepts the proto field names.
      expect(requestedOutputCap('google-generate-content', { generation_config: { max_output_tokens: 65_536 } })).toBe(
        65_536,
      );
      expect(
        requestedOutputCap('google-generate-content', {
          generationConfig: { maxOutputTokens: 1 },
          generation_config: { max_output_tokens: 65_536 },
        }),
      ).toBe(65_536);
      // A case variant a case-insensitive gateway would act on.
      expect(requestedOutputCap('anthropic-messages', { max_tokens: 1, MAX_TOKENS: 64_000 })).toBe(64_000);
      expect(requestedOutputCap('openai-responses', { max_output_tokens: 16, maxOutputTokens: 128_000 })).toBe(128_000);
    });

    it('reads the number of choices a request asks for', () => {
      expect(requestedChoiceCount('openai-chat-completions', { n: 64 })).toBe(64);
      expect(requestedChoiceCount('google-generate-content', { generationConfig: { candidateCount: 4 } })).toBe(4);
      expect(requestedChoiceCount('google-generate-content', { generation_config: { candidate_count: 8 } })).toBe(8);
      expect(requestedChoiceCount('openai-chat-completions', { n: 2, N: 9 })).toBe(9);
      // A protocol without choices, and values that are not positive safe integers.
      expect(requestedChoiceCount('anthropic-messages', { n: 64 })).toBe(1);
      expect(requestedChoiceCount('openai-responses', { n: 64 })).toBe(1);
      for (const value of [0, -3, 2.5, '8', null]) {
        expect(requestedChoiceCount('openai-chat-completions', { n: value })).toBe(1);
      }
      expect(requestedChoiceCount('openai-chat-completions', undefined)).toBe(1);
      // A protocol the tables do not list: every known spelling.
      expect(requestedChoiceCount('vendor-protocol', { generationConfig: { candidateCount: 3 } })).toBe(3);
      expect(requestedChoiceCount(null, { n: 5 })).toBe(5);
    });

    it('reads the speed a request asks for, any value but standard counting as fast', () => {
      expect(requestedSpeed({ speed: 'fast' })).toBe('fast');
      expect(requestedSpeed({ speed: 'standard' })).toBe('standard');
      expect(requestedSpeed({ model: 'claude-opus-5-5' })).toBe('standard');
      expect(requestedSpeed({ speed: null })).toBe('standard');
      for (const body of [undefined, null, 'fast', ['fast']]) expect(requestedSpeed(body)).toBe('standard');
      // A value the price table does not know, and spellings a lenient decoder accepts, price fail-closed.
      expect(requestedSpeed({ speed: 'turbo' })).toBe('fast');
      expect(requestedSpeed({ speed: 'FAST' })).toBe('fast');
      expect(requestedSpeed({ speed: 1 })).toBe('fast');
      expect(requestedSpeed({ speed_mode: 'fast' })).toBe('fast');
      expect(requestedSpeed({ speed: 'standard', Speed: 'fast' })).toBe('fast');
      // Inherited keys are not the body's.
      expect(requestedSpeed(Object.create({ speed: 'fast' }) as object)).toBe('standard');
    });

    it('ignores output caps that are not positive safe integers, and inherited keys', () => {
      for (const value of [0, -1, 1.5, '100', 2 ** 60, null]) {
        expect(requestedOutputCap('anthropic-messages', { max_tokens: value })).toBeNull();
      }
      expect(requestedOutputCap('anthropic-messages', Object.create({ max_tokens: 50 }) as object)).toBeNull();
      expect(requestedOutputCap('anthropic-messages', undefined)).toBeNull();
      expect(requestedOutputCap('anthropic-messages', [1, 2])).toBeNull();
    });

    it('answers a refusal with a non-retryable 400 carrying the marker', () => {
      const exhausted = budgetRefusalResponse({ reason: 'budget_exhausted', message: 'Token budget exhausted: x' });
      expect(exhausted.status).toBe(400);
      expect(BUDGET_REFUSAL_STATUS).not.toBe(429);
      expect(exhausted.headers).toMatchObject({
        'x-should-retry': 'false',
        [BUDGET_REFUSAL_HEADER]: 'budget-exhausted',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(exhausted.body)).toEqual({
        type: 'error',
        error: {
          type: BUDGET_EXHAUSTED_ERROR_TYPE,
          code: BUDGET_EXHAUSTED_ERROR_TYPE,
          message: 'IronCurtain refused this request: Token budget exhausted: x.',
        },
      });

      const idle = budgetRefusalResponse({ reason: 'no_active_turn', message: 'no agent turn' });
      expect(idle.headers[BUDGET_REFUSAL_HEADER]).toBe('no-active-turn');
      expect(JSON.parse(idle.body)).toMatchObject({ error: { type: NO_ACTIVE_TURN_ERROR_TYPE } });
    });

    it('derives the gate mode from the bundle kind and its limits from the resource budget', () => {
      const userConfig = {
        resourceBudget: {
          maxTotalTokens: 500_000,
          maxSteps: 10,
          maxSessionSeconds: null,
          maxEstimatedCostUsd: null,
          warnThresholdPercent: 80,
        },
        modelPricingOverrides: { 'claude-x': { inputPerMillion: 1, outputPerMillion: 2 } },
      };
      expect(budgetGateOptionsFor(userConfig, 'pty')).toMatchObject({
        mode: 'session',
        limits: { maxTotalTokens: 500_000, maxEstimatedCostUsd: null },
        pricingOverrides: userConfig.modelPricingOverrides,
      });
      expect(budgetGateOptionsFor(userConfig, 'batch').mode).toBe('turn');
      expect(budgetGateOptionsFor(userConfig, 'workflow').mode).toBe('turn');
      expect(budgetGateOptionsFor(userConfig, undefined).mode).toBe('turn');

      // A hand-built config without a budget gets the defaults, never "unlimited".
      const bare = budgetGateOptionsFor({} as typeof userConfig, 'batch');
      expect(bare.limits.maxTotalTokens).toBeGreaterThan(0);
      expect(bare.limits.maxEstimatedCostUsd).toBeGreaterThan(0);
    });
  });
});

describe('budget gate at the MITM proxy (fake upstream)', () => {
  let harness: BudgetHarness | undefined;
  let warn: MockInstance<typeof logger.warn>;

  beforeEach(() => {
    resetLlmMetricsEventBus();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    warn.mockRestore();
  });

  it('answers every request after the cap with the marker response and forwards none of them', async () => {
    harness = await startBudgetHarness({
      gate: { mode: 'session', limits: { maxTotalTokens: 200, maxEstimatedCostUsd: null } },
    });
    const exhausted = vi.fn();
    harness.gate.onExhausted(exhausted);

    // No proxy credential (lease) on the CONNECT: counted all the same.
    const first = await harness.send(completionBody());
    expect(first.statusCode).toBe(200);
    await expect.poll(() => harness?.gate.snapshot().settledExchanges).toBe(1);
    expect(harness.gate.snapshot().totalTokens).toBe(SSE_TOTAL_TOKENS);
    expect(harness.gate.snapshot().costUsd).toBeCloseTo(SSE_COST_USD, 12);

    // 180 charged + 64 reserved > 200.
    const second = await harness.send(completionBody());
    expect(second.statusCode).toBe(400);
    expect(second.headers[BUDGET_REFUSAL_HEADER]).toBe('budget-exhausted');
    expect(second.headers['x-should-retry']).toBe('false');
    expect(JSON.parse(second.body)).toMatchObject({
      type: 'error',
      error: { type: BUDGET_EXHAUSTED_ERROR_TYPE, message: expect.stringContaining('Token budget exhausted') },
    });

    const third = await harness.send(completionBody({ max_tokens: 1 }));
    expect(third.statusCode).toBe(400);
    expect(third.headers[BUDGET_REFUSAL_HEADER]).toBe('budget-exhausted');

    expect(harness.upstreamRequests).toHaveLength(1);
    expect(exhausted).toHaveBeenCalledOnce();
    expect(exhausted).toHaveBeenCalledWith(expect.objectContaining({ dimension: 'tokens', used: 180, limit: 200 }));
  });

  it('refuses an idle completion request in turn mode, with or without a lease, and forwards it during a turn', async () => {
    harness = await startBudgetHarness({ gate: { mode: 'turn', limits: NO_LIMITS } });

    const idle = await harness.send(completionBody());
    expect(idle.statusCode).toBe(400);
    expect(idle.headers[BUDGET_REFUSAL_HEADER]).toBe('no-active-turn');
    expect(JSON.parse(idle.body)).toMatchObject({ error: { type: NO_ACTIVE_TURN_ERROR_TYPE } });

    // A live metrics lease is a correlation hint, not an authority.
    const lease = harness.proxy.beginMetricsInvocation('http://127.0.0.1:18080', { sessionId: 'session-1' });
    const leaseUrl = new URL(lease.proxyUrl);
    const credentials = Buffer.from(`${leaseUrl.username}:${leaseUrl.password}`).toString('base64');
    const withLease = await harness.send(completionBody(), { proxyAuthorization: `Basic ${credentials}` });
    expect(withLease.statusCode).toBe(400);
    expect(withLease.headers[BUDGET_REFUSAL_HEADER]).toBe('no-active-turn');
    expect(harness.upstreamRequests).toHaveLength(0);

    const turn = harness.gate.beginTurn();
    const during = await harness.send(completionBody());
    expect(during.statusCode).toBe(200);
    expect(harness.upstreamRequests).toHaveLength(1);
    turn.end();

    const after = await harness.send(completionBody());
    expect(after.statusCode).toBe(400);
    expect(harness.upstreamRequests).toHaveLength(1);
    await lease.end();

    // Turn refusals never spend or latch the budget.
    expect(harness.gate.exhaustion()).toBeUndefined();
  });

  it('never logs the value of a credential query parameter when it refuses a request', async () => {
    harness = await startBudgetHarness({ gate: { mode: 'turn', limits: NO_LIMITS } });

    // The sentinel is accepted in a query carrier too; no turn is open, so the gate refuses.
    const refused = await sendRaw(harness, `/v1/messages?beta=true&key=${FAKE_KEY}`, completionBody());
    expect(refused.statusCode).toBe(400);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { type: NO_ACTIVE_TURN_ERROR_TYPE } });
    const logged = warn.mock.calls.map(([message]) => message).join('\n');
    expect(logged).toContain(`REFUSED POST ${CLIENT_HOST}/v1/messages?beta=true&key=<redacted> - budget gate`);
    expect(logged).not.toContain(FAKE_KEY);
  });

  it('leaves non-completion endpoints alone', async () => {
    harness = await startBudgetHarness({
      gate: { mode: 'turn', limits: { maxTotalTokens: 1, maxEstimatedCostUsd: null } },
    });
    harness.respondWith((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end('{"input_tokens":3}');
    });
    // count_tokens is an allowed Anthropic endpoint but not a completion.
    const counted = await sendRaw(harness, '/v1/messages/count_tokens', completionBody());
    expect(counted.statusCode).toBe(200);
    expect(harness.gate.snapshot().admittedRequests).toBe(0);
  });

  it.each([
    ['a protocol the proxy has no parser for', 'vendor-messages', 'full', 777, 777],
    ['a route whose usage is declared unsupported', 'anthropic-messages', 'unsupported', 900, 900],
    ['a request naming no output cap', 'vendor-messages', 'full', undefined, DEFAULT_OUTPUT_TOKEN_ESTIMATE],
  ] as const)('charges %s the configured fallback', async (_label, protocol, metricsSupport, maxTokens, charged) => {
    harness = await startBudgetHarness({
      gate: { mode: 'session', limits: NO_LIMITS },
      provider: (port) => ({
        ...loopbackAnthropicProvider(port),
        completionEndpoints: [{ method: 'POST', path: '/v1/messages', protocol, capabilities: { metricsSupport } }],
      }),
    });
    const body = completionBody(maxTokens === undefined ? {} : { max_tokens: maxTokens });
    if (maxTokens === undefined) delete body['max_tokens'];

    const response = await harness.send(body);
    expect(response.statusCode).toBe(200);
    await expect.poll(() => harness?.gate.snapshot().settledExchanges).toBe(1);
    const snapshot = harness.gate.snapshot();
    // The unreported input is estimated from the body the provider received.
    const input = forwardedInputEstimate(harness);
    expect(snapshot).toMatchObject({ totalTokens: input + charged, estimatedExchanges: 1, reservedTokens: 0 });
    expect(snapshot.costUsd).toBeCloseTo((input * SONNET_45.input + charged * SONNET_45.output) / 1e6, 12);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be measured'));
  });

  it('charges a Chat Completions stream without usage its input and every choice, not one token', async () => {
    // The agent decides whether a Chat Completions stream reports usage
    // (stream_options.include_usage); without it, the gate measures nothing.
    harness = await startBudgetHarness({
      gate: { mode: 'session', limits: NO_LIMITS },
      provider: loopbackOpenAiProvider,
    });
    harness.respondWith((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      response.end(chatCompletionSseWithoutUsage());
    });
    const body = {
      model: 'gpt-4.1',
      stream: true,
      max_completion_tokens: 1,
      n: 64,
      messages: [{ role: 'user', content: 'x'.repeat(300_000) }],
    };

    const response = await sendRaw(harness, '/v1/chat/completions', body, OPENAI_CLIENT);
    expect(response.statusCode).toBe(200);
    await expect.poll(() => harness?.gate.snapshot().settledExchanges).toBe(1);
    const input = forwardedInputEstimate(harness);
    expect(input).toBeGreaterThanOrEqual(100_000);
    // gpt-4.1 lists at $3 input / $12 output per million tokens.
    const snapshot = harness.gate.snapshot();
    expect(snapshot).toMatchObject({ totalTokens: input + 64, estimatedExchanges: 1, reservedTokens: 0 });
    expect(snapshot.costUsd).toBeCloseTo((input * 3 + 64 * 12) / 1e6, 12);
  });

  it('sizes a body that streams through unread for the input estimate', async () => {
    // No sanitizer or rewriter on the route: the body is never buffered, so
    // its output cap is unknown (the default applies) and its bytes are
    // counted as they pass.
    harness = await startBudgetHarness({
      gate: { mode: 'session', limits: NO_LIMITS },
      provider: (port) => ({
        ...loopbackAnthropicProvider(port),
        completionEndpoints: [
          {
            method: 'POST',
            path: '/v1/messages',
            protocol: 'vendor-messages',
            capabilities: { metricsSupport: 'full' },
          },
        ],
        requestRewriter: undefined,
        rewriteEndpoints: [],
        sanitizedEndpoints: [],
      }),
    });
    const body = completionBody({ messages: [{ role: 'user', content: 'w'.repeat(90_000) }] });

    expect((await harness.send(body)).statusCode).toBe(200);
    await expect.poll(() => harness?.gate.snapshot().settledExchanges).toBe(1);
    // Forwarded byte for byte.
    expect(harness.upstreamRequests[0]?.body.toString('utf8')).toBe(JSON.stringify(body));
    const input = forwardedInputEstimate(harness);
    expect(input).toBeGreaterThanOrEqual(30_000);
    expect(harness.gate.snapshot()).toMatchObject({
      totalTokens: input + DEFAULT_OUTPUT_TOKEN_ESTIMATE,
      estimatedExchanges: 1,
    });
  });

  it('charges a stream the client dropped before any usage arrived its estimated input plus the output cap', async () => {
    harness = await startBudgetHarness({ gate: { mode: 'session', limits: NO_LIMITS } });
    harness.respondWith((_request, response) => {
      // Headers only: the prompt is still being processed upstream.
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
    });

    await harness.sendAndAbortOnFirstData(
      completionBody({ max_tokens: 4_096, messages: [{ role: 'user', content: 'y'.repeat(60_000) }] }),
    );
    await expect.poll(() => harness?.gate.snapshot().settledExchanges).toBe(1);
    const input = forwardedInputEstimate(harness);
    expect(input).toBeGreaterThanOrEqual(20_000);
    expect(harness.gate.snapshot()).toMatchObject({ totalTokens: input + 4_096, estimatedExchanges: 1 });
  });

  it.each([false, true])(
    'charges measured usage whether or not statistics are enabled (statisticsEnabled: %s)',
    async (statisticsEnabled) => {
      const published: LlmExchangeCompleted[] = [];
      const unsubscribe = getLlmMetricsEventBus().subscribe((exchange) => published.push(exchange));
      try {
        harness = await startBudgetHarness({ gate: { mode: 'session', limits: NO_LIMITS }, statisticsEnabled });
        expect((await harness.send(completionBody())).statusCode).toBe(200);
        await expect.poll(() => harness?.gate.snapshot().settledExchanges).toBe(1);
        expect(harness.gate.snapshot()).toMatchObject({ totalTokens: SSE_TOTAL_TOKENS, estimatedExchanges: 0 });
        expect(published).toHaveLength(statisticsEnabled ? 1 : 0);
      } finally {
        unsubscribe();
      }
    },
  );

  it('charges a stream the client abandoned before its final usage its measured input plus the output cap', async () => {
    harness = await startBudgetHarness({ gate: { mode: 'session', limits: NO_LIMITS } });
    harness.respondWith((_request, response) => {
      // message_start only, then the stream stays open.
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(anthropicSseStart());
    });

    await harness.sendAndAbortOnFirstData(completionBody({ max_tokens: 4_096 }));
    await expect.poll(() => harness?.gate.snapshot().settledExchanges).toBe(1);
    expect(harness.gate.snapshot()).toMatchObject({ totalTokens: SSE_INPUT_TOKENS + 4_096, estimatedExchanges: 1 });
  });

  it('charges nothing for a provider error response', async () => {
    harness = await startBudgetHarness({ gate: { mode: 'session', limits: NO_LIMITS } });
    harness.respondWith((_request, response) => {
      response.writeHead(529, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
    });
    expect((await harness.send(completionBody())).statusCode).toBe(529);
    await expect.poll(() => harness?.gate.snapshot().settledExchanges).toBe(1);
    expect(harness.gate.snapshot()).toMatchObject({ totalTokens: 0, costUsd: 0, estimatedExchanges: 0 });
  });

  it('charges a fast-mode request at the fast-mode list price', async () => {
    harness = await startBudgetHarness({ gate: { mode: 'session', limits: NO_LIMITS } });
    harness.respondWith(respondWithSse(anthropicSse('claude-opus-5-5')));

    const response = await harness.send(completionBody({ model: 'claude-opus-5-5', speed: 'fast' }));
    expect(response.statusCode).toBe(200);
    await expect.poll(() => harness?.gate.snapshot().settledExchanges).toBe(1);
    expect(harness.gate.snapshot().totalTokens).toBe(SSE_TOTAL_TOKENS);
    expect(harness.gate.snapshot().costUsd).toBeCloseTo(OPUS_55_SSE_COST_USD * OPUS_55_FAST_MULTIPLIER, 12);
  });

  it('refuses a fast-mode request whose fast-mode reservation would pass the cost limit', async () => {
    // 64 Opus 5.5 output tokens reserve $0.00128 at the standard price, $0.00256 in fast mode.
    harness = await startBudgetHarness({
      gate: { mode: 'session', limits: { maxTotalTokens: null, maxEstimatedCostUsd: 0.002 } },
    });

    const refused = await harness.send(completionBody({ model: 'claude-opus-5-5', speed: 'fast' }));
    expect(refused.statusCode).toBe(400);
    expect(refused.headers[BUDGET_REFUSAL_HEADER]).toBe('budget-exhausted');
    expect(harness.upstreamRequests).toHaveLength(0);
    expect(harness.gate.exhaustion()).toMatchObject({ dimension: 'cost', limit: 0.002 });
  });

  it('charges nothing for a request whose upstream connection never came up', async () => {
    const closed = http.createServer();
    const closedPort = await new Promise<number>((resolve) => {
      closed.listen(0, '127.0.0.1', () => resolve((closed.address() as AddressInfo).port));
    });
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    harness = await startBudgetHarness({
      gate: { mode: 'session', limits: NO_LIMITS },
      provider: () => loopbackAnthropicProvider(closedPort),
    });

    expect((await harness.send(completionBody())).statusCode).toBe(502);
    await expect.poll(() => harness?.gate.snapshot().settledExchanges).toBe(1);
    expect(harness.gate.snapshot()).toMatchObject({ totalTokens: 0, estimatedExchanges: 0 });
  });
});

interface RawClient {
  readonly host: string;
  readonly headers: Readonly<Record<string, string>>;
}

const ANTHROPIC_CLIENT: RawClient = { host: CLIENT_HOST, headers: { 'x-api-key': FAKE_KEY } };
const OPENAI_CLIENT: RawClient = { host: 'api.openai.com', headers: { authorization: `Bearer ${FAKE_KEY}` } };

/** OpenAI's provider config with its upstream replaced by the loopback fake. */
function loopbackOpenAiProvider(upstreamPort: number): ProviderConfig {
  return {
    ...openaiProvider,
    upstreamTarget: { hostname: '127.0.0.1', port: upstreamPort, pathPrefix: '', useTls: false },
  };
}

/** A complete Chat Completions stream that reports no usage (no `include_usage`). */
function chatCompletionSseWithoutUsage(): string {
  return [
    'data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-4.1","choices":[{"index":0,"delta":{"role":"assistant","content":"x"},"finish_reason":null}]}',
    '',
    'data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-4.1","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

/** The input estimate for the one request body the fake upstream received. */
function forwardedInputEstimate(harness: BudgetHarness): number {
  expect(harness.upstreamRequests).toHaveLength(1);
  const forwarded = harness.upstreamRequests[0]?.body.length ?? 0;
  return Math.ceil(forwarded / ESTIMATED_REQUEST_BYTES_PER_INPUT_TOKEN);
}

/** A request to an arbitrary path through the harness proxy. */
async function sendRaw(
  harness: BudgetHarness,
  path: string,
  body: Record<string, unknown>,
  client: RawClient = ANTHROPIC_CLIENT,
): Promise<{ statusCode: number; body: string }> {
  const connected = await sendConnect(harness.socketPath, client.host, 443);
  if (connected.socket === null) throw new Error(`CONNECT refused with ${connected.statusCode}`);
  const response = await makeHttpsRequest(connected.socket, harness.ca, client.host, {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json', ...client.headers },
    body: JSON.stringify(body),
  });
  return { statusCode: response.statusCode, body: response.body };
}

// --- DockerAgentSession with a gated bundle ---

type ExecArgs = Parameters<ContainerRuntime['exec']>;

describe('DockerAgentSession with the budget gate', () => {
  let tempDir: string;
  let harness: BudgetHarness | undefined;
  let session: DockerAgentSession | undefined;
  let warn: MockInstance<typeof logger.warn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'budget-session-'));
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await session?.close().catch(() => {});
    session = undefined;
    await harness?.close();
    harness = undefined;
    warn.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stops a turn whose completion the gate refuses after the cap and ends it budget_exhausted', async () => {
    const gatedHarness = await startBudgetHarness({
      gate: { mode: 'turn', limits: { maxTotalTokens: 200, maxEstimatedCostUsd: null } },
    });
    harness = gatedHarness;
    const agentResponses: { statusCode: number; refusal?: string }[] = [];
    let turnEnvironment: Readonly<Record<string, string>> | undefined;
    let releaseAgent: (() => void) | undefined;
    const killed = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    const sweeps: string[] = [];

    const exec = vi.fn(async (...args: ExecArgs): Promise<DockerExecResult> => {
      const [, command, , , , environment] = args;
      if (isTurnSweep(command)) {
        sweeps.push(command[command.length - 1] ?? '');
        releaseAgent?.();
        return { exitCode: 0, stdout: '3\n', stderr: '' };
      }
      // The agent: one completion within budget, one after the cap, then it
      // keeps running until the host kills it.
      turnEnvironment = environment;
      const first = await gatedHarness.send(completionBody());
      agentResponses.push({ statusCode: first.statusCode, refusal: first.headers[BUDGET_REFUSAL_HEADER] });
      await expect.poll(() => gatedHarness.gate.snapshot().settledExchanges).toBe(1);
      const second = await gatedHarness.send(completionBody());
      agentResponses.push({ statusCode: second.statusCode, refusal: second.headers[BUDGET_REFUSAL_HEADER] });
      await killed;
      return { exitCode: 137, stdout: '', stderr: 'Killed' };
    });
    const diagnostics: DiagnosticEvent[] = [];
    session = new DockerAgentSession({
      config: budgetSessionConfig(),
      sessionId: 'budget-session' as SessionId,
      agentConversationId: 'conversation-1' as AgentConversationId,
      infra: gatedBatchInfra(tempDir, gatedHarness.gate, exec),
      ownsInfra: false,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await session.initialize();

    await expect(session.sendMessage('do the task')).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
      dimension: 'tokens',
      turnStopped: true,
      message: expect.stringContaining('Token budget exhausted'),
    });

    expect(agentResponses).toEqual([{ statusCode: 200 }, { statusCode: 400, refusal: 'budget-exhausted' }]);
    expect(gatedHarness.upstreamRequests).toHaveLength(1);
    // The sweep matched the marker the turn ran with, although no time limit applied.
    const turnId = turnEnvironment?.[TURN_MARKER_ENV];
    expect(turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sweeps).toEqual([`${TURN_MARKER_ENV}=${turnId}`]);
    expect(exec).toHaveBeenCalledWith(
      'container-budget',
      buildTurnKillCommand(`${TURN_MARKER_ENV}=${turnId}`),
      expect.any(Number),
    );
    expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'budget_exhausted', dimension: 'tokens' }));

    // No further turn runs on the exhausted bundle.
    const agentExecs = exec.mock.calls.filter(([, command]) => !isTurnSweep(command)).length;
    await expect(session.sendMessage('one more')).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
      dimension: 'tokens',
    });
    expect(exec.mock.calls.filter(([, command]) => !isTurnSweep(command))).toHaveLength(agentExecs);
  });

  it('forwards completions only while the turn exec runs', async () => {
    const gatedHarness = await startBudgetHarness({ gate: { mode: 'turn', limits: NO_LIMITS } });
    harness = gatedHarness;
    const exec = vi.fn(async (...args: ExecArgs): Promise<DockerExecResult> => {
      if (isTurnSweep(args[1])) return { exitCode: 0, stdout: '0\n', stderr: '' };
      const response = await gatedHarness.send(completionBody());
      return { exitCode: 0, stdout: `status ${response.statusCode}`, stderr: '' };
    });
    session = new DockerAgentSession({
      config: budgetSessionConfig(),
      sessionId: 'budget-session' as SessionId,
      agentConversationId: 'conversation-2' as AgentConversationId,
      infra: gatedBatchInfra(tempDir, gatedHarness.gate, exec),
      ownsInfra: false,
    });
    await session.initialize();

    expect(await session.sendMessage('work')).toBe('status 200');
    // A process the agent left behind, after the turn returned.
    const leftover = await gatedHarness.send(completionBody());
    expect(leftover.statusCode).toBe(400);
    expect(leftover.headers[BUDGET_REFUSAL_HEADER]).toBe('no-active-turn');
    expect(gatedHarness.upstreamRequests).toHaveLength(1);
    expect(gatedHarness.gate.snapshot().activeTurns).toBe(0);

    // The session's budget status carries what its bundle's gate charged,
    // which a workflow's run-wide ceiling counts (statistics on or off).
    await expect.poll(() => gatedHarness.gate.snapshot().settledExchanges).toBe(1);
    const charged = gatedHarness.gate.snapshot();
    expect(charged.totalTokens).toBeGreaterThan(0);
    expect(session.getBudgetStatus().budgetGate).toEqual({
      bundleId: 'budget-session',
      totalTokens: charged.totalTokens,
      costUsd: charged.costUsd,
    });
  });

  it('refuses to start a turn on a bundle whose gate is already exhausted', async () => {
    const gate = createBudgetGate({ mode: 'turn', limits: { maxTotalTokens: 100, maxEstimatedCostUsd: null } });
    const turn = gate.beginTurn();
    answered(admit(gate, 64)).settle(exchangeRecord(FINAL_USAGE));
    turn.end();
    const exec = vi.fn(async (): Promise<DockerExecResult> => ({ exitCode: 0, stdout: 'done', stderr: '' }));
    session = new DockerAgentSession({
      config: budgetSessionConfig(),
      sessionId: 'budget-session' as SessionId,
      agentConversationId: 'conversation-3' as AgentConversationId,
      infra: gatedBatchInfra(tempDir, gate, exec),
      ownsInfra: false,
    });
    await session.initialize();

    await expect(session.sendMessage('work')).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
      dimension: 'tokens',
      turnStopped: false,
    });
    expect(exec).not.toHaveBeenCalled();
  });
});
